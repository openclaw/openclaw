/** Tests diagnostic cache-trace event writing, redaction, and stream wrapping. */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCacheTrace } from "./cache-trace.js";

const writerMocks = vi.hoisted(() => ({
  getQueuedFileWriter: vi.fn<typeof import("./queued-file-writer.js").getQueuedFileWriter>(),
}));

vi.mock("./queued-file-writer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queued-file-writer.js")>()),
  getQueuedFileWriter: writerMocks.getQueuedFileWriter,
}));

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

describe("createCacheTrace", () => {
  beforeEach(() => {
    writerMocks.getQueuedFileWriter.mockReset();
    for (const key of [
      "OPENCLAW_CACHE_TRACE",
      "OPENCLAW_CACHE_TRACE_FILE",
      "OPENCLAW_CACHE_TRACE_MESSAGES",
      "OPENCLAW_CACHE_TRACE_PROMPT",
      "OPENCLAW_CACHE_TRACE_SYSTEM",
    ]) {
      vi.stubEnv(key, undefined);
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const bareAnthropicKey = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"; // pragma: allowlist secret
  const bareAwsKey = "AKIAIOSFODNN7EXAMPLE"; // pragma: allowlist secret
  const bareGithubKey = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"; // pragma: allowlist secret
  const bareGoogleKey = "AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQrStUvW"; // pragma: allowlist secret
  const barePerplexityKey = "pplx-AbCdEfGhIjKlMnOpQrStUvWx"; // pragma: allowlist secret

  function memoryTrace(
    overrides: Partial<Parameters<typeof createCacheTrace>[0]> & { env?: NodeJS.ProcessEnv } = {},
  ) {
    const lines: string[] = [];
    const { env, ...options } = overrides;
    for (const [key, value] of Object.entries(env ?? {})) {
      vi.stubEnv(key, value);
    }
    writerMocks.getQueuedFileWriter.mockReturnValue({
      filePath: "memory",
      write: (line) => lines.push(line),
      flush: async () => undefined,
    });
    const trace = createCacheTrace({
      cfg: { diagnostics: { cacheTrace: { enabled: true } } },
      ...options,
    });
    return { lines, trace };
  }

  function readEvent(lines: string[], index = 0): Record<string, unknown> {
    return JSON.parse(lines[index]?.trim() ?? "{}");
  }

  const diagnostic = (diagnosticText: string, fields: Record<string, unknown>) => ({
    apiKey: "synthetic-secret",
    diagnosticText,
    ...fields,
  });
  it.each([
    { label: "disabled diagnostics", cfg: {} },
    {
      label: "Incognito prompts",
      env: { OPENCLAW_CACHE_TRACE: "1" },
      sessionKey: "agent:main:dashboard:incognito-private",
    },
  ])("does not record $label", ({ label: _label, ...options }) => {
    const { lines, trace } = memoryTrace(options);
    trace?.recordStage("prompt:before", { prompt: "synthetic private prompt" });
    expect(lines).toEqual([]);
    expect(trace).toBeNull();
  });

  it("records stream context from systemPrompt when wrapping stream functions", () => {
    const { lines, trace } = memoryTrace();

    const wrapped = trace?.wrapStreamFn((() => undefined) as never);
    void wrapped?.(
      { id: "test", provider: "openai", api: "openai-responses" } as never,
      { systemPrompt: "system prompt text", messages: [] } as never,
      {},
    );

    expect(readEvent(lines)).toMatchObject({
      stage: "stream:context",
      system: "system prompt text",
      systemDigest: expect.any(String),
    });
  });

  it("sanitizes cache-trace payloads before writing", () => {
    const { lines, trace } = memoryTrace();

    trace?.recordStage("stream:context", {
      prompt: `prompt ${bareAnthropicKey}`,
      note: `note ${bareGithubKey}`,
      error: `error ${bareGoogleKey}`,
      system: {
        provider: diagnostic(bareAwsKey, { baseUrl: "https://api.example.com" }),
      },
      model: diagnostic(bareGoogleKey, { id: "test-model", tokenCount: 8192 }),
      options: diagnostic(bareGithubKey, {
        nested: {
          password: "super-secret-password",
          safe: "keep-me",
          tokenCount: 42,
        },
        images: [{ type: "image", mimeType: "image/png", data: "QUJDRA==" }],
      }),
      messages: [
        {
          role: "user",
          token: "message-secret-token",
          metadata: { secretKey: "message-secret-key", label: "preserve-me" },
          content: [
            { type: "text", text: barePerplexityKey },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "U0VDUkVU" },
            },
          ],
        },
        {
          role: "assistant",
          providerReplay: { data: "opaque-cache-trace-compaction" },
        },
      ] as unknown as [],
    });

    const event = readEvent(lines);
    expect(event).toEqual(
      expect.objectContaining({
        prompt: expect.any(String),
        note: expect.any(String),
        error: expect.any(String),
        system: {
          provider: { baseUrl: "https://api.example.com", diagnosticText: expect.any(String) },
        },
        model: { id: "test-model", tokenCount: 8192, diagnosticText: expect.any(String) },
        options: {
          diagnosticText: expect.any(String),
          nested: { safe: "keep-me", tokenCount: 42 },
          images: "<redacted>",
        },
        messages: [
          expect.objectContaining({
            role: "user",
            metadata: { label: "preserve-me" },
            content: [
              { type: "text", text: expect.any(String) },
              expect.objectContaining({
                source: expect.objectContaining({
                  data: "<redacted>",
                  bytes: 6,
                  sha256: sha256("U0VDUkVU"),
                }),
              }),
            ],
          }),
          expect.anything(),
        ],
      }),
    );
    expect(event).not.toHaveProperty("messages.0.token");
    expect(event).not.toHaveProperty("messages.0.metadata.secretKey");
    const serialized = JSON.stringify(event);
    for (const secret of [
      "providerReplay",
      "opaque-cache-trace-compaction",
      bareAnthropicKey,
      bareAwsKey,
      bareGoogleKey,
      bareGithubKey,
      barePerplexityKey,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("handles circular references in messages without stack overflow", () => {
    const { lines, trace } = memoryTrace();

    const parent: Record<string, unknown> = { role: "user", content: "hello" };
    const child: Record<string, unknown> = { ref: parent };
    parent.child = child;

    trace?.recordStage("prompt:images", { messages: [parent] as unknown as [] });

    expect(lines.length).toBe(1);
    const fingerprint = sha256('{"child":{"ref":"[Circular]"},"content":"hello","role":"user"}');
    const event = readEvent(lines);
    expect(event).toStrictEqual({
      ts: expect.any(String),
      seq: 1,
      stage: "prompt:images",
      messageCount: 1,
      messageRoles: ["user"],
      messageFingerprints: [fingerprint],
      messagesDigest: sha256(JSON.stringify(fingerprint)),
      messages: [{ role: "user", content: "hello", child: { ref: "[Circular]" } }],
    });
  });

  it("fingerprints malformed and transport-normalized text identically", () => {
    const { lines, trace } = memoryTrace();
    const high = String.fromCharCode(0xd83d);

    trace?.recordStage("prompt:before", {
      messages: [{ role: "user", content: `left${high}right`, timestamp: 1 }],
    });
    trace?.recordStage("prompt:images", {
      messages: [{ role: "user", content: "leftright", timestamp: 1 }],
    });

    expect(readEvent(lines).messageFingerprints).toEqual(readEvent(lines, 1).messageFingerprints);
  });
});
