import type { A2aAgentCard, A2aTask, A2aTaskSendRequest } from "./types.js";

export type A2aClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
};

export class A2aClient {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(opts: A2aClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.headers = opts.headers ?? {};
  }

  async fetchAgentCard(): Promise<A2aAgentCard> {
    const res = await this.fetchFn(`${this.baseUrl}/.well-known/agent.json`, {
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`A2A agent card failed: ${res.status}`);
    }
    return (await res.json()) as A2aAgentCard;
  }

  async sendTask(req: A2aTaskSendRequest): Promise<A2aTask> {
    const res = await this.fetchFn(`${this.baseUrl}/a2a/tasks/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`A2A send failed: ${res.status} ${body}`);
    }
    return (await res.json()) as A2aTask;
  }

  async getTask(taskId: string): Promise<A2aTask> {
    const res = await this.fetchFn(`${this.baseUrl}/a2a/tasks/${taskId}`, {
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`A2A get task failed: ${res.status}`);
    }
    return (await res.json()) as A2aTask;
  }

  async sendAndWait(
    req: A2aTaskSendRequest,
    opts?: { pollMs?: number; timeoutMs?: number },
  ): Promise<A2aTask> {
    const pollMs = opts?.pollMs ?? 200;
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const task = await this.sendTask(req);
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
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`A2A task timed out: ${task.id}`);
  }
}
