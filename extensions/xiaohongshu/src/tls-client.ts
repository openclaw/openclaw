import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

const BRIDGE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "tls-bridge.py");

interface BridgeRequest {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  cookies?: string;
  body?: string;
}

interface BridgeResponse {
  id: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  ok?: boolean;
}

/**
 * Manages a Python subprocess running curl_cffi for Chrome TLS impersonation.
 * Falls back to native fetch if Python/curl_cffi is not available.
 */
export class TlsClient {
  private proc: ChildProcess | undefined;
  private rl: Interface | undefined;
  private pending = new Map<
    string,
    { resolve: (r: BridgeResponse) => void; reject: (e: Error) => void }
  >();
  private counter = 0;
  private ready: Promise<boolean>;
  private useBridge = false;

  constructor() {
    this.ready = this.initBridge();
  }

  private initBridge(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const proc = spawn("python3", [BRIDGE_SCRIPT], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        proc.on("error", () => {
          this.useBridge = false;
          resolve(false);
        });

        proc.on("exit", () => {
          this.proc = undefined;
          this.rl = undefined;
          this.useBridge = false;
        });

        const rl = createInterface({ input: proc.stdout! });
        rl.on("line", (line) => {
          try {
            const msg = JSON.parse(line) as BridgeResponse;
            if (msg.id === "_init") {
              if (msg.ok) {
                this.proc = proc;
                this.rl = rl;
                this.useBridge = true;
                resolve(true);
              } else {
                proc.kill();
                resolve(false);
              }
              return;
            }
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              p.resolve(msg);
            }
          } catch {
            // ignore malformed lines
          }
        });

        // Timeout: if bridge doesn't start in 5s, fall back
        setTimeout(() => {
          if (!this.useBridge) {
            proc.kill();
            resolve(false);
          }
        }, 5000);
      } catch {
        resolve(false);
      }
    });
  }

  async fetch(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      cookies?: string;
      body?: string;
    } = {},
  ): Promise<{ status: number; body: string }> {
    await this.ready;

    if (this.useBridge && this.proc?.stdin?.writable) {
      return this.bridgeFetch(url, options);
    }
    return this.nativeFetch(url, options);
  }

  private bridgeFetch(
    url: string,
    options: { method?: string; headers?: Record<string, string>; cookies?: string; body?: string },
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const id = String(++this.counter);
      const req: BridgeRequest = {
        id,
        method: options.method ?? "GET",
        url,
        headers: options.headers,
        cookies: options.cookies,
        body: options.body,
      };

      this.pending.set(id, {
        resolve: (r) => {
          if (r.error) reject(new Error(r.error));
          else resolve({ status: r.status ?? 0, body: r.body ?? "" });
        },
        reject,
      });

      this.proc!.stdin!.write(JSON.stringify(req) + "\n");

      // Timeout per request: 15s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("TLS bridge request timeout"));
        }
      }, 15000);
    });
  }

  private async nativeFetch(
    url: string,
    options: { method?: string; headers?: Record<string, string>; cookies?: string; body?: string },
  ): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.cookies) {
      headers.cookie = options.cookies;
    }
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
    });
    return { status: res.status, body: await res.text() };
  }

  async close(): Promise<void> {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(JSON.stringify({ id: "_quit" }) + "\n");
      this.proc.stdin.end();
    }
    this.rl?.close();
    this.proc?.kill();
    this.proc = undefined;
    this.useBridge = false;
  }

  /** Whether the TLS bridge (Chrome impersonation) is active. */
  get hasTlsBridge(): boolean {
    return this.useBridge;
  }
}
