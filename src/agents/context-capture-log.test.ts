import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createContextCaptureLogger, type ContextCaptureLogger } from "./context-capture-log.js";
import type { QueuedFileWriter } from "./queued-file-writer.js";

const MODEL = {
  id: "test-model",
  provider: "test",
  api: "openai-responses",
} as unknown as Model<Api>;

function makeWriter(lines: string[]): QueuedFileWriter {
  return {
    filePath: "<memory>",
    write: (line: string) => {
      lines.push(line);
    },
  };
}

/**
 * Fake transport: fires onPayload with the literal wire request (including a
 * secret + tool defs), then returns a stream whose result() yields an assistant
 * message containing a thinking block (chain-of-thought) + text + usage.
 */
function makeFakeStreamFn(opts?: { skipPayload?: boolean }): StreamFn {
  const fn = ((model, context, options) => {
    if (!opts?.skipPayload) {
      options?.onPayload?.(
        {
          model: model.id,
          system: "SYSTEM PROMPT TEXT",
          messages: (context as { messages?: unknown }).messages,
          tools: [{ name: "read", description: "read a file" }],
          apiKey: "sk-super-secret",
        },
        model,
      );
    }
    const assistant: AgentMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "step 1: think about it" },
        { type: "text", text: "final answer" },
      ],
      usage: { input: 10, output: 5 },
      stopReason: "stop",
    } as unknown as AgentMessage;
    const stream = {
      result: async () => assistant,
      [Symbol.asyncIterator]: async function* () {
        /* not consumed in these tests */
      },
    };
    return stream as unknown as ReturnType<StreamFn>;
  }) as StreamFn;
  return fn;
}

function makeContext() {
  return {
    systemPrompt: "SYSTEM PROMPT TEXT",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  } as unknown as Parameters<StreamFn>[1];
}

async function driveOnce(logger: ContextCaptureLogger, streamFn: StreamFn): Promise<void> {
  const wrapped = logger.wrapStreamFn(streamFn);
  const stream = (await wrapped(MODEL, makeContext(), {})) as unknown as {
    result: () => Promise<AgentMessage>;
  };
  await stream.result();
}

describe("createContextCaptureLogger", () => {
  it("returns null when not enabled", () => {
    const logger = createContextCaptureLogger({
      env: {} as NodeJS.ProcessEnv,
      workspaceDir: "/ws",
      writer: makeWriter([]),
    });
    expect(logger).toBeNull();
  });

  it("writes one line per call with full request, response, and thinking; redacts secrets", async () => {
    const lines: string[] = [];
    const logger = createContextCaptureLogger({
      env: { OPENCLAW_CONTEXT_CAPTURE: "1" } as unknown as NodeJS.ProcessEnv,
      runId: "run-1",
      sessionId: "sess-1",
      provider: "test",
      modelId: "test-model",
      workspaceDir: "/ws",
      writer: makeWriter(lines),
    });
    expect(logger).not.toBeNull();
    await driveOnce(logger as ContextCaptureLogger, makeFakeStreamFn());

    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] as string);

    expect(rec.stage).toBe("turn");
    expect(rec.requestSource).toBe("wire-payload");
    expect(rec.runId).toBe("run-1");
    expect(rec.sessionId).toBe("sess-1");

    // Request: system prompt + tools captured, secret stripped.
    expect(rec.request.system).toBe("SYSTEM PROMPT TEXT");
    expect(rec.request.tools[0].name).toBe("read");
    expect(rec.request.apiKey).toBeUndefined();

    // Response: chain-of-thought (thinking block) preserved.
    const thinkingBlock = rec.response.content.find(
      (b: { type?: string }) => b.type === "thinking",
    );
    expect(thinkingBlock.thinking).toBe("step 1: think about it");
    expect(rec.usage.input).toBe(10);
    expect(rec.stopReason).toBe("stop");
  });

  it("keeps secrets verbatim in RAW mode", async () => {
    const lines: string[] = [];
    const logger = createContextCaptureLogger({
      env: {
        OPENCLAW_CONTEXT_CAPTURE: "1",
        OPENCLAW_CONTEXT_CAPTURE_RAW: "1",
      } as unknown as NodeJS.ProcessEnv,
      workspaceDir: "/ws",
      writer: makeWriter(lines),
    });
    await driveOnce(logger as ContextCaptureLogger, makeFakeStreamFn());
    const rec = JSON.parse(lines[0] as string);
    expect(rec.request.apiKey).toBe("sk-super-secret");
  });

  it("falls back to context when transport does not surface onPayload", async () => {
    const lines: string[] = [];
    const logger = createContextCaptureLogger({
      env: { OPENCLAW_CONTEXT_CAPTURE: "1" } as unknown as NodeJS.ProcessEnv,
      workspaceDir: "/ws",
      writer: makeWriter(lines),
    });
    await driveOnce(logger as ContextCaptureLogger, makeFakeStreamFn({ skipPayload: true }));
    const rec = JSON.parse(lines[0] as string);
    expect(rec.requestSource).toBe("context-fallback");
    expect(rec.request.systemPrompt).toBe("SYSTEM PROMPT TEXT");
    expect(rec.response.content.some((b: { type?: string }) => b.type === "thinking")).toBe(true);
  });

  it("records an error line when the model call rejects", async () => {
    const lines: string[] = [];
    const logger = createContextCaptureLogger({
      env: { OPENCLAW_CONTEXT_CAPTURE: "1" } as unknown as NodeJS.ProcessEnv,
      workspaceDir: "/ws",
      writer: makeWriter(lines),
    });
    const failing = ((_model, _context, _options) => {
      const stream = {
        result: async () => {
          throw new Error("boom");
        },
        [Symbol.asyncIterator]: async function* () {},
      };
      return stream as unknown as ReturnType<StreamFn>;
    }) as StreamFn;

    const wrapped = (logger as ContextCaptureLogger).wrapStreamFn(failing);
    const stream = (await wrapped(MODEL, makeContext(), {})) as unknown as {
      result: () => Promise<AgentMessage>;
    };
    await expect(stream.result()).rejects.toThrow("boom");
    const rec = JSON.parse(lines[0] as string);
    expect(rec.error).toBe("boom");
    expect(rec.response).toBeUndefined();
  });
});
