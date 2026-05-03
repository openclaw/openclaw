import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { createCacheTrace } from "./cache-trace.js";

describe("createCacheTrace", () => {
  function createMemoryTraceForTest() {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });
    return { lines, trace };
  }

  it("returns null when diagnostics cache tracing is disabled", () => {
    const trace = createCacheTrace({
      cfg: {} as OpenClawConfig,
      env: {},
    });

    expect(trace).toBeNull();
  });

  it("honors diagnostics cache trace config and expands file paths", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            filePath: "~/.openclaw/logs/cache-trace.jsonl",
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    expect(trace).not.toBeNull();
    expect(trace?.filePath).toBe(resolveUserPath("~/.openclaw/logs/cache-trace.jsonl"));

    trace?.recordStage("session:loaded", {
      messages: [],
      system: "sys",
    });

    expect(lines.length).toBe(1);
  });

  it("records empty prompt/system values when enabled", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includePrompt: true,
            includeSystem: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    trace?.recordStage("prompt:before", { prompt: "", system: "" });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.prompt).toBe("");
    expect(event.system).toBe("");
  });

  it("records raw model run session stages", () => {
    const { lines, trace } = createMemoryTraceForTest();

    trace?.recordStage("session:raw-model-run", {
      messages: [],
      system: "",
    });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("session:raw-model-run");
    expect(event.system).toBe("");
  });

  it("records stream context from systemPrompt when wrapping stream functions", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includeSystem: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    const wrapped = trace?.wrapStreamFn(((model: unknown, context: unknown, options: unknown) => ({
      model,
      context,
      options,
    })) as never);

    void wrapped?.(
      {
        id: "gpt-5.4",
        provider: "openai",
        api: "openai-responses",
      } as never,
      {
        systemPrompt: "system prompt text",
        messages: [],
      } as never,
      {},
    );

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("stream:context");
    expect(event.system).toBe("system prompt text");
    expect(event.systemDigest).toBeTypeOf("string");
  });

  it("falls back to no stage filtering when stages regex is invalid", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            stages: "[",
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    expect(() =>
      trace?.recordStage("session:loaded", {
        system: "sys",
        messages: [],
      }),
    ).not.toThrow();

    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("session:loaded");
  });

  it("respects env overrides for enablement", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {
        OPENCLAW_CACHE_TRACE: "0",
      },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    expect(trace).toBeNull();
  });

  it("sanitizes cache-trace payloads before writing", () => {
    const { lines, trace } = createMemoryTraceForTest();

    trace?.recordStage("stream:context", {
      system: {
        provider: { apiKey: "sk-system-secret", baseUrl: "https://api.example.com" },
      },
      model: {
        id: "test-model",
        apiKey: "sk-model-secret",
        tokenCount: 8192,
      },
      options: {
        apiKey: "sk-options-secret",
        nested: {
          password: "super-secret-password",
          safe: "keep-me",
          tokenCount: 42,
        },
        images: [{ type: "image", mimeType: "image/png", data: "QUJDRA==" }],
      },
      messages: [
        {
          role: "user",
          token: "message-secret-token",
          metadata: {
            secretKey: "message-secret-key",
            label: "preserve-me",
          },
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "U0VDUkVU" },
            },
          ],
        },
      ] as unknown as [],
    });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.system).toEqual({
      provider: {
        baseUrl: "https://api.example.com",
      },
    });
    expect(event.model).toEqual({
      id: "test-model",
      tokenCount: 8192,
    });
    expect(event.options).toEqual({
      nested: {
        safe: "keep-me",
        tokenCount: 42,
      },
      images: [
        {
          type: "image",
          mimeType: "image/png",
          data: "<redacted>",
          bytes: 4,
          sha256: crypto.createHash("sha256").update("QUJDRA==").digest("hex"),
        },
      ],
    });

    const optionsImages = (
      ((event.options as { images?: unknown[] } | undefined)?.images ?? []) as Array<
        Record<string, unknown>
      >
    )[0];
    expect(optionsImages?.data).toBe("<redacted>");
    expect(optionsImages?.bytes).toBe(4);
    expect(optionsImages?.sha256).toBe(
      crypto.createHash("sha256").update("QUJDRA==").digest("hex"),
    );

    const firstMessage = ((event.messages as Array<Record<string, unknown>> | undefined) ?? [])[0];
    expect(firstMessage).not.toHaveProperty("token");
    expect(firstMessage).not.toHaveProperty("metadata.secretKey");
    expect(firstMessage).toMatchObject({
      role: "user",
      metadata: {
        label: "preserve-me",
      },
    });
    const source = (((firstMessage?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(6);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("U0VDUkVU").digest("hex"));
  });

  it("handles circular references in messages without stack overflow", () => {
    const { lines, trace } = createMemoryTraceForTest();

    const parent: Record<string, unknown> = { role: "user", content: "hello" };
    const child: Record<string, unknown> = { ref: parent };
    parent.child = child; // circular reference

    trace?.recordStage("prompt:images", {
      messages: [parent] as unknown as [],
    });

    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.messageCount).toBe(1);
    expect(event.messageFingerprints).toHaveLength(1);
  });

  it("records tools when includeTools is enabled", async () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includeTools: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    const mockTools = [
      { name: "bash", description: "Run bash commands", inputSchema: { type: "object" } },
      {
        name: "read",
        description: "Read file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    trace?.recordStage("stream:context", {
      tools: mockTools,
    });

    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.tools).toEqual(mockTools);
  });

  it("does not record tools when includeTools is disabled (default)", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    trace?.recordStage("stream:context", {
      tools: [{ name: "secret-tool" }],
    });

    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.tools).toBeUndefined();
  });

  it("records tools via env override OPENCLAW_CACHE_TRACE_TOOLS=true", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {
        OPENCLAW_CACHE_TRACE_TOOLS: "true",
      },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    trace?.recordStage("stream:context", {
      tools: [{ name: "env-override-tool" }],
    });

    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.tools).toEqual([{ name: "env-override-tool" }]);
  });

  it("wrapStreamFn records tools in stream:context when includeTools is enabled", async () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includeTools: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    const mockTools = [
      { name: "bash", description: "Run bash", inputSchema: { type: "object" } },
      {
        name: "read",
        description: "Read file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    const mockContext = {
      system: "You are a helpful assistant.",
      messages: [{ role: "user" as const, content: "Hello" }],
      tools: mockTools,
    };

    const innerStreamFn = vi.fn();
    const wrapped = trace!.wrapStreamFn(innerStreamFn);
    await wrapped(
      { id: "test-model", provider: "openai" } as unknown as Parameters<typeof wrapped>[0],
      mockContext as unknown as Parameters<typeof wrapped>[1],
      {},
    );

    expect(innerStreamFn).toHaveBeenCalledOnce();
    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("stream:context");
    expect(event.tools).toEqual(mockTools);
    expect(event.system).toBe("You are a helpful assistant."); // includeSystem defaults true
  });

  it("wrapStreamFn does not record tools when includeTools is false (default)", async () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            // includeTools not set -> defaults to false
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    const mockTools = [{ name: "secret-tool" }];
    const mockContext = { tools: mockTools };

    const innerStreamFn = vi.fn();
    const wrapped = trace!.wrapStreamFn(innerStreamFn);
    await wrapped(
      { id: "test" } as unknown as Parameters<typeof wrapped>[0],
      mockContext as unknown as Parameters<typeof wrapped>[1],
      {},
    );

    expect(innerStreamFn).toHaveBeenCalledOnce();
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.tools).toBeUndefined();
  });
});
