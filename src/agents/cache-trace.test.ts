import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { listDiagnosticEvents } from "../infra/diagnostic-events-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createCacheTrace } from "./cache-trace.js";

describe("createCacheTrace", () => {
  function createMemoryTraceForTest() {
    const events: unknown[] = [];
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
        destination: "memory",
        write: (event) => events.push(event),
      },
    });
    return { events, trace };
  }

  it("returns null when diagnostics cache tracing is disabled", () => {
    const trace = createCacheTrace({
      cfg: {} as OpenClawConfig,
      env: {},
    });

    expect(trace).toBeNull();
  });

  it("stores diagnostics cache trace output in SQLite state", () => {
    const events: unknown[] = [];
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
        destination: "memory",
        write: (event) => events.push(event),
      },
    });

    expect(typeof trace?.recordStage).toBe("function");
    expect(trace?.destination).toBe("sqlite://state/diagnostics/cache-trace");

    trace?.recordStage("session:loaded", {
      messages: [],
      system: "sys",
    });

    expect(events.length).toBe(1);
  });

  it("stores default cache trace events in SQLite state", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cache-trace-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      const trace = createCacheTrace({
        cfg: {
          diagnostics: {
            cacheTrace: {
              enabled: true,
            },
          },
        },
        env,
      });

      expect(trace?.destination).toBe("sqlite://state/diagnostics/cache-trace");
      trace?.recordStage("session:loaded", { messages: [] });

      const entries = listDiagnosticEvents<Record<string, unknown>>("diagnostics.cache_trace", {
        env,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.value).toMatchObject({ stage: "session:loaded" });
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("records empty prompt/system values when enabled", () => {
    const events: unknown[] = [];
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
        destination: "memory",
        write: (event) => events.push(event),
      },
    });

    trace?.recordStage("prompt:before", { prompt: "", system: "" });

    const event = (events[0] ?? {}) as Record<string, unknown>;
    expect(event.prompt).toBe("");
    expect(event.system).toBe("");
  });

  it("records raw model run session stages", () => {
    const { events, trace } = createMemoryTraceForTest();

    trace?.recordStage("session:raw-model-run", {
      messages: [],
      system: "",
    });

    const event = (events[0] ?? {}) as Record<string, unknown>;
    expect(event.stage).toBe("session:raw-model-run");
    expect(event.system).toBe("");
  });

  it("records stream context from systemPrompt when wrapping stream functions", () => {
    const events: unknown[] = [];
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
        destination: "memory",
        write: (event) => events.push(event),
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

    const event = (events[0] ?? {}) as Record<string, unknown>;
    expect(event.stage).toBe("stream:context");
    expect(event.system).toBe("system prompt text");
    expect(event.systemDigest).toBeTypeOf("string");
  });

  it("respects env overrides for enablement", () => {
    const events: unknown[] = [];
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
        destination: "memory",
        write: (event) => events.push(event),
      },
    });

    expect(trace).toBeNull();
  });

  it("sanitizes cache-trace payloads before writing", () => {
    const { events, trace } = createMemoryTraceForTest();

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

    const event = (events[0] ?? {}) as Record<string, unknown>;
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
    expect(firstMessage?.role).toBe("user");
    expect(firstMessage?.metadata).toEqual({
      label: "preserve-me",
    });
    const source = (((firstMessage?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(6);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("U0VDUkVU").digest("hex"));
  });

  it("handles circular references in messages without stack overflow", () => {
    const { events, trace } = createMemoryTraceForTest();

    const parent: Record<string, unknown> = { role: "user", content: "hello" };
    const child: Record<string, unknown> = { ref: parent };
    parent.child = child; // circular reference

    trace?.recordStage("prompt:images", {
      messages: [parent] as unknown as [],
    });

    expect(events.length).toBe(1);
    const fingerprint = crypto
      .createHash("sha256")
      .update('{"child":{"ref":"[Circular]"},"content":"hello","role":"user"}')
      .digest("hex");
    const event = (events[0] ?? {}) as Record<string, unknown>;
    expect(event).toStrictEqual({
      ts: expect.any(String),
      seq: 1,
      stage: "prompt:images",
      messageCount: 1,
      messageRoles: ["user"],
      messageFingerprints: [fingerprint],
      messagesDigest: crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
      messages: [{ role: "user", content: "hello", child: { ref: "[Circular]" } }],
      modelApi: undefined,
      modelId: undefined,
      provider: undefined,
      runId: undefined,
      sessionId: undefined,
      sessionKey: undefined,
      workspaceDir: undefined,
    });
  });
});
