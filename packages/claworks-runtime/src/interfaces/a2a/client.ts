import { randomUUID } from "node:crypto";
import type { A2aAgentCard, A2aTask, A2aTaskSendRequest } from "./types.js";

export type A2aClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** 请求超时（ms，默认 10_000） */
  requestTimeoutMs?: number;
  /** 强制 HTTPS（生产模式设为 true，拒绝非 HTTPS peer） */
  requireHttps?: boolean;
};

export class A2aClient {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly requireHttps: boolean;

  constructor(opts: A2aClientOptions) {
    const url = opts.baseUrl.replace(/\/$/, "");
    if (opts.requireHttps && !url.startsWith("https://")) {
      throw new Error(`A2A peer URL must use HTTPS in production (requireHttps=true): ${url}`);
    }
    this.baseUrl = url;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.headers = opts.headers ?? {};
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.requireHttps = opts.requireHttps ?? false;
  }

  /** AbortSignal-backed timeout wrapper */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`A2A request timed out after ${this.requestTimeoutMs}ms: ${url}`, {
          cause: err,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchAgentCard(): Promise<A2aAgentCard> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/.well-known/agent.json`, {
      headers: this.headers,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`A2A agent card failed: ${res.status} ${body}`);
    }
    return (await res.json()) as A2aAgentCard;
  }

  async sendTask(req: A2aTaskSendRequest, opts?: { idempotencyKey?: string }): Promise<A2aTask> {
    const idempotencyKey = opts?.idempotencyKey ?? randomUUID();
    const res = await this.fetchWithTimeout(`${this.baseUrl}/a2a/tasks/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
        ...this.headers,
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`A2A send failed: ${res.status} ${body}`);
    }
    return (await res.json()) as A2aTask;
  }

  async getTask(taskId: string): Promise<A2aTask> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/a2a/tasks/${taskId}`, {
      headers: this.headers,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`A2A get task failed: ${res.status} ${body}`);
    }
    return (await res.json()) as A2aTask;
  }

  async sendAndWait(
    req: A2aTaskSendRequest,
    opts?: { pollMs?: number; timeoutMs?: number; idempotencyKey?: string },
  ): Promise<A2aTask> {
    const pollMs = opts?.pollMs ?? 500;
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const idempotencyKey = opts?.idempotencyKey ?? randomUUID();
    const task = await this.sendTask(req, { idempotencyKey });
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const current = await this.getTask(task.id);
      if (
        current.status === "completed" ||
        current.status === "failed" ||
        current.status === "canceled"
      ) {
        return current;
      }
      const elapsed = Date.now() - (deadline - timeoutMs);
      const nextPoll = Math.min(pollMs * Math.ceil(elapsed / 5000 + 1), 2000);
      await new Promise((r) => setTimeout(r, nextPoll));
    }
    throw new Error(`A2A task timed out after ${timeoutMs}ms: ${task.id}`);
  }
}
