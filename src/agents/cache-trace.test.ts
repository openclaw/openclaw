import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

    expect(typeof trace?.recordStage).toBe("function");
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
    const { lines, trace } = createMemoryTraceForTest();

    const parent: Record<string, unknown> = { role: "user", content: "hello" };
    const child: Record<string, unknown> = { ref: parent };
    parent.child = child; // circular reference

    trace?.recordStage("prompt:images", {
      messages: [parent] as unknown as [],
    });

    expect(lines.length).toBe(1);
    const fingerprint = crypto
      .createHash("sha256")
      .update('{"child":{"ref":"[Circular]"},"content":"hello","role":"user"}')
      .digest("hex");
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event).toStrictEqual({
      ts: expect.any(String),
      seq: 1,
      stage: "prompt:images",
      messageCount: 1,
      messageRoles: ["user"],
      messageFingerprints: [fingerprint],
      messagesDigest: crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
      messages: [{ role: "user", content: "hello", child: { ref: "[Circular]" } }],
    });
  });

  describe("size caps", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
      for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    function makeTempDir(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cache-trace-"));
      tempDirs.push(dir);
      return dir;
    }

    it("stops appending once maxFileBytes is reached when rotation is disabled", async () => {
      const tmpDir = makeTempDir();
      const filePath = path.join(tmpDir, "cache-trace.jsonl");
      const trace = createCacheTrace({
        cfg: {
          diagnostics: {
            cacheTrace: {
              enabled: true,
              filePath,
              // Generous enough for a single small event but not two.
              maxFileBytes: 200,
              // Opt out of rotation so the cap drops appends instead.
              maxFiles: 0,
              includeMessages: false,
              includePrompt: false,
              includeSystem: false,
            },
          },
        },
        env: {},
      });

      expect(trace?.filePath).toBe(filePath);
      trace?.recordStage("session:loaded", { note: "first" });
      trace?.recordStage("session:loaded", {
        note: "second-event-with-padding-to-blow-the-cap-".repeat(8),
      });

      // Allow the queued writer to flush both attempts.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const written = fs.readFileSync(filePath, "utf8");
      const eventLines = written.split("\n").filter((line) => line.length > 0);
      expect(eventLines.length).toBe(1);
      const event = JSON.parse(eventLines[0] ?? "{}") as Record<string, unknown>;
      expect(event.note).toBe("first");
      expect(fs.existsSync(`${filePath}.1`)).toBe(false);
    });

    it("honors OPENCLAW_CACHE_TRACE_MAX_BYTES env override", async () => {
      const tmpDir = makeTempDir();
      const filePath = path.join(tmpDir, "cache-trace.jsonl");
      const trace = createCacheTrace({
        cfg: {
          diagnostics: {
            cacheTrace: {
              enabled: true,
              filePath,
              // Config would allow plenty of room...
              maxFileBytes: 10_000_000,
              maxFiles: 0,
              includeMessages: false,
              includePrompt: false,
              includeSystem: false,
            },
          },
        },
        // ...but env override clamps it.
        env: { OPENCLAW_CACHE_TRACE_MAX_BYTES: "200" },
      });

      trace?.recordStage("session:loaded", { note: "first" });
      trace?.recordStage("session:loaded", {
        note: "second-event-with-padding-to-blow-the-cap-".repeat(8),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const eventLines = fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(eventLines.length).toBe(1);
    });

    it("rotates to .1 once maxFileBytes is reached when maxFiles >= 2", async () => {
      const tmpDir = makeTempDir();
      const filePath = path.join(tmpDir, "cache-trace.jsonl");
      const trace = createCacheTrace({
        cfg: {
          diagnostics: {
            cacheTrace: {
              enabled: true,
              filePath,
              maxFileBytes: 200,
              maxFiles: 3,
              includeMessages: false,
              includePrompt: false,
              includeSystem: false,
            },
          },
        },
        env: {},
      });

      trace?.recordStage("session:loaded", { note: "first" });
      trace?.recordStage("session:loaded", {
        note: "second-event-padding-to-blow-cap-".repeat(8),
      });
      trace?.recordStage("session:loaded", { note: "third" });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // First event lives alone in the rotated archive; the second event
      // triggered the rotation and lands in the new active file along with
      // the third.
      expect(fs.existsSync(`${filePath}.1`)).toBe(true);
      const archiveLines = fs
        .readFileSync(`${filePath}.1`, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(archiveLines.length).toBe(1);
      expect(JSON.parse(archiveLines[0] ?? "{}").note).toBe("first");

      const activeLines = fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(activeLines.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(activeLines.at(-1) ?? "{}").note).toBe("third");

      // No older archive should appear yet.
      expect(fs.existsSync(`${filePath}.2`)).toBe(false);
    });
  });
});
