/**
 * Manages the docling-serve subprocess lifecycle.
 *
 * Lazy-starts on first use — zero resources if RAG is never invoked.
 * Stops cleanly when the gateway shuts down.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_DOCLING_SERVE_URL } from "./types.js";

export class DoclingServerManager {
  private child: ChildProcess | null = null;
  private started = false;
  private readonly url: string;
  private readonly port: number;

  constructor(url?: string) {
    this.url = url ?? DEFAULT_DOCLING_SERVE_URL;
    try {
      this.port = new URL(this.url).port ? Number.parseInt(new URL(this.url).port, 10) : 5001;
    } catch {
      this.port = 5001;
    }
  }

  getUrl(): string {
    return this.url;
  }

  isStarted(): boolean {
    return this.started;
  }

  async ensureRunning(): Promise<void> {
    if (this.started) {
      return;
    }

    if (await this.isAlreadyRunning()) {
      this.started = true;
      return;
    }

    await this.startProcess();
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

  private async startProcess(): Promise<void> {
    const commands = [
      { cmd: "docling-serve", args: ["run", "--port", String(this.port), "--host", "127.0.0.1"] },
      {
        cmd: "docker",
        args: [
          "run",
          "--rm",
          "-p",
          `${this.port}:5001`,
          "quay.io/docling-project/docling-serve-cpu",
        ],
      },
    ];

    for (const { cmd, args } of commands) {
      try {
        this.child = spawn(cmd, args, {
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });

        this.child.on("error", () => {
          this.child = null;
        });

        await this.waitForHealthy(60_000);
        return;
      } catch {
        if (this.child) {
          this.child.kill("SIGTERM");
          this.child = null;
        }
      }
    }

    throw new Error(
      "Could not start docling-serve. Install it with: pip install docling-serve[ui]\n" +
        "Or use Docker: docker pull quay.io/docling-project/docling-serve-cpu",
    );
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
