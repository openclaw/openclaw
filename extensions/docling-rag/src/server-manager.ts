/**
 * Manages the docling-serve subprocess lifecycle.
 *
 * Lazy-starts on first use — zero resources if RAG is never invoked.
 * Stops cleanly when the gateway shuts down.
 *
 * Installation: docling-serve is a Python package installed natively
 * on all platforms (macOS, Linux, Windows) via `pip install docling-serve[ui]`.
 * No Docker/containers needed. If the user already has a running instance
 * (including one running in a container they manage), they can point
 * doclingServeUrl to it and set autoManage=false.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_DOCLING_SERVE_URL } from "./types.js";

const INSTALL_INSTRUCTIONS = [
  "docling-serve is not installed or not running.",
  "",
  "Install natively (macOS, Linux, Windows):",
  '  pip install "docling-serve[ui]"',
  "",
  "Or if you prefer containers (self-managed):",
  "  # Docker:",
  "  docker run -p 5001:5001 quay.io/docling-project/docling-serve-cpu",
  "  # Podman:",
  "  podman run -p 5001:5001 quay.io/docling-project/docling-serve-cpu",
  "",
  "Then set in your openclaw config:",
  '  plugins.docling-rag.config.doclingServeUrl = "http://127.0.0.1:5001"',
  "  plugins.docling-rag.config.autoManage = false",
  "",
  "Docs: https://github.com/docling-project/docling-serve",
].join("\n");

function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0";
}

export class DoclingServerManager {
  private child: ChildProcess | null = null;
  private started = false;
  private readonly url: string;
  private readonly host: string;
  private readonly port: number;

  constructor(url?: string) {
    this.url = url ?? DEFAULT_DOCLING_SERVE_URL;
    try {
      const parsed = new URL(this.url);
      this.host = parsed.hostname || "127.0.0.1";
      this.port = parsed.port ? Number.parseInt(parsed.port, 10) : 5001;

      if (!isLoopback(this.host) && parsed.protocol === "http:") {
        console.warn(
          `[docling-rag] WARNING: doclingServeUrl uses HTTP to a non-loopback address (${this.host}). ` +
            "Documents will be sent over the network in plain text. " +
            "Use HTTPS or a loopback address (127.0.0.1 / localhost) for secure operation.",
        );
      }
    } catch {
      this.host = "127.0.0.1";
      this.port = 5001;
    }
  }

  getUrl(): string {
    return this.url;
  }

  isStarted(): boolean {
    return this.started;
  }

  isRemote(): boolean {
    return !isLoopback(this.host);
  }

  async ensureRunning(): Promise<void> {
    if (this.started) {
      return;
    }

    if (await this.isAlreadyRunning()) {
      this.started = true;
      return;
    }

    await this.startNativeProcess();
    this.started = true;
  }

  private async isAlreadyRunning(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.url}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Start docling-serve as a native Python process.
   * No Docker/container fallback — if not installed, show clear instructions
   * for native install or self-managed container options.
   */
  private async startNativeProcess(): Promise<void> {
    try {
      this.child = spawn(
        "docling-serve",
        ["run", "--port", String(this.port), "--host", this.host],
        {
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        },
      );

      this.child.on("error", () => {
        this.child = null;
      });

      await this.waitForHealthy(60_000);
    } catch {
      if (this.child) {
        this.child.kill("SIGTERM");
        this.child = null;
      }
      throw new Error(INSTALL_INSTRUCTIONS);
    }
  }

  private async waitForHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const interval = 2_000;

    while (Date.now() < deadline) {
      if (await this.isAlreadyRunning()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(`docling-serve did not become healthy within ${timeoutMs / 1000}s`);
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.started = false;
      return;
    }

    this.child.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill("SIGKILL");
        }
        resolve();
      }, 5_000);

      if (this.child) {
        this.child.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    this.child = null;
    this.started = false;
  }
}
