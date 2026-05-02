import type { ChatCompletionRequest } from "@lobstah/protocol";

export type ChatResult = {
  payload: unknown;
  inputTokens: number;
  outputTokens: number;
};

export type ChatStreamResult = {
  body: ReadableStream<Uint8Array>;
};

export type WorkerEngine = {
  name: string;
  listModels(): Promise<string[]>;
  chat(req: ChatCompletionRequest): Promise<ChatResult>;
  chatStream(req: ChatCompletionRequest): Promise<ChatStreamResult>;
};

export type OllamaConfig = {
  baseUrl?: string;
};

const DEFAULT_BASE = "http://127.0.0.1:11434";

export class OllamaEngine implements WorkerEngine {
  readonly name = "ollama";
  readonly baseUrl: string;

  constructor({ baseUrl }: OllamaConfig = {}) {
    this.baseUrl = baseUrl ?? process.env.OLLAMA_HOST ?? DEFAULT_BASE;
  }

  async listModels(): Promise<string[]> {
    const r = await fetch(`${this.baseUrl}/api/tags`);
    if (!r.ok) return [];
    const data = (await r.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  }

  async chat(req: ChatCompletionRequest): Promise<ChatResult> {
    const r = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...req, stream: false }),
    });
    if (!r.ok) {
      throw new Error(`ollama ${r.status}: ${await r.text()}`);
    }
    const payload = (await r.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      payload,
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
    };
  }

  async chatStream(req: ChatCompletionRequest): Promise<ChatStreamResult> {
    const r = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...req,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!r.ok) {
      throw new Error(`ollama ${r.status}: ${await r.text()}`);
    }
    if (!r.body) throw new Error("ollama returned no body");
    return { body: r.body };
  }
}
