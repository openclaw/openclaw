// Regression for #133922 (commentary identity): distinct tool responses in one
// run must not share a commentary id, or the Control UI overwrites an earlier
// segment when it reconciles by run id + item id.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { createOllamaStreamFn } from "./stream-api.js";

const STREAM_MODEL = {
  api: "ollama",
  provider: "ollama",
  id: "qwen3.5",
  input: ["text"],
  contextWindow: 65536,
} as const;

const TOOL_CONTEXT = {
  messages: [{ role: "user", content: "test" }],
  tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
};

function makeNdjsonBody(chunks: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map((chunk) => JSON.stringify(chunk) + "\n").join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

function makeToolResponse(content: string, path: string) {
  return {
    model: "qwen3.5",
    created_at: new Date().toISOString(),
    message: {
      role: "assistant" as const,
      content,
      tool_calls: [{ function: { name: "read", arguments: { path } } }],
    },
    done: true,
    prompt_eval_count: 100,
    eval_count: 50,
  };
}

async function streamOllamaEvents(chunks: Array<Record<string, unknown>>) {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(makeNdjsonBody(chunks), { status: 200 }),
    release: vi.fn(async () => undefined),
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of createOllamaStreamFn("http://localhost:11434")(
    STREAM_MODEL as never,
    TOOL_CONTEXT as never,
    {},
  ) as AsyncIterable<{ type: string; [key: string]: unknown }>) {
    events.push(event);
  }
  return events;
}

describe("createOllamaStreamFn pre-tool commentary identity (#133922)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.useRealTimers();
  });

  async function readCommentarySignature(path: string): Promise<{ id?: unknown; phase?: unknown }> {
    const events = await streamOllamaEvents([makeToolResponse(`Reading ${path}`, path)]);
    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<Record<string, unknown>> };
    };
    const textBlock = done.message?.content?.find((block) => block.type === "text");
    return JSON.parse(String(textBlock?.textSignature)) as { id?: unknown; phase?: unknown };
  }

  it("gives each tool response a distinct commentary identity in one run", async () => {
    const first = await readCommentarySignature("a.md");
    const second = await readCommentarySignature("b.md");

    expect(first.phase).toBe("commentary");
    expect(second.phase).toBe("commentary");
    expect(typeof first.id).toBe("string");
    expect(typeof second.id).toBe("string");
    // A response-local index alone (`commentary-0`) would alias both segments.
    expect(first.id).not.toBe(second.id);
  });
});
