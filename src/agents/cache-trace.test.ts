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
const secret = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"; // pragma: allowlist secret

describe("createCacheTrace", () => {
  beforeEach(() => {
    writerMocks.getQueuedFileWriter.mockReset();
    for (const key of ["", "_FILE", "_MESSAGES", "_PROMPT", "_SYSTEM"]) {
      vi.stubEnv("OPENCLAW_CACHE_TRACE" + key, undefined);
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
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
    });
    const trace = createCacheTrace({
      cfg: { diagnostics: { cacheTrace: { enabled: true } } },
      ...options,
    });
    return {
      lines,
      trace,
      event: (index = 0): Record<string, unknown> => JSON.parse(lines[index]?.trim() ?? "{}"),
    };
  }
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
  it("records stream context from systemPrompt", () => {
    const { event, trace } = memoryTrace();
    const wrapped = trace?.wrapStreamFn((() => undefined) as never);
    void wrapped?.(
      { id: "test", provider: "openai", api: "openai-responses" } as never,
      { systemPrompt: "system prompt text", messages: [] } as never,
      {},
    );
    expect(event()).toMatchObject({
      stage: "stream:context",
      system: "system prompt text",
      systemDigest: expect.any(String),
    });
  });
  // Credential formats and media shapes are covered by logging/redact.test.ts and payload-redaction.test.ts.
  it.each(["prompt", "note", "error"] as const)("redacts %s before writing", (field) => {
    const { lines, event, trace } = memoryTrace();
    trace?.recordStage("stream:context", { [field]: "safe " + secret });
    expect(event()[field]).toContain("safe");
    expect(lines.join("")).not.toContain(secret);
  });
  it.each(["system", "model", "options"] as const)("sanitizes structured %s", (field) => {
    const { lines, event, trace } = memoryTrace();
    trace?.recordStage("stream:context", {
      [field]: {
        apiKey: "synthetic-secret",
        diagnosticText: secret,
        nested: { password: "nested-secret", safe: "keep-me", tokenCount: 42 },
        images: [{ type: "image", data: "QUJDRA==" }],
      },
    });
    expect(event()[field]).toEqual({
      diagnosticText: expect.any(String),
      nested: { safe: "keep-me", tokenCount: 42 },
      images: "<redacted>",
    });
    expect(lines.join("")).not.toContain(secret);
  });
  it("redacts message credentials, media, and provider replay", () => {
    const { lines, event, trace } = memoryTrace();
    trace?.recordStage("stream:context", {
      messages: [
        {
          role: "user",
          token: "message-secret-token",
          metadata: { secretKey: "message-secret-key", label: "preserve-me" },
          content: [
            { type: "text", text: secret },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "U0VDUkVU" },
            },
          ],
        },
        { role: "assistant", providerReplay: { data: "opaque-cache-trace-compaction" } },
      ] as unknown as [],
    });
    expect(event()).toHaveProperty("messages", [
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
    ]);
    expect(event()).not.toHaveProperty("messages.0.token");
    for (const value of [secret, "providerReplay", "opaque-cache-trace-compaction"]) {
      expect(lines.join("")).not.toContain(value);
    }
  });
  it("fingerprints circular messages without stack overflow", () => {
    const { lines, event, trace } = memoryTrace();
    const parent: Record<string, unknown> = { role: "user", content: "hello" };
    parent.child = { ref: parent };
    trace?.recordStage("prompt:images", { messages: [parent] as unknown as [] });
    const fingerprint = sha256('{"child":{"ref":"[Circular]"},"content":"hello","role":"user"}');
    expect(lines).toHaveLength(1);
    expect(event()).toMatchObject({
      messageCount: 1,
      messageRoles: ["user"],
      messageFingerprints: [fingerprint],
      messagesDigest: sha256(JSON.stringify(fingerprint)),
      messages: [{ role: "user", content: "hello", child: { ref: "[Circular]" } }],
    });
  });
  it("fingerprints malformed and transport-normalized text identically", () => {
    const { event, trace } = memoryTrace();
    for (const content of ["left" + String.fromCharCode(0xd83d) + "right", "leftright"]) {
      trace?.recordStage("prompt:before", { messages: [{ role: "user", content, timestamp: 1 }] });
    }
    expect(event().messageFingerprints).toEqual(event(1).messageFingerprints);
  });
});
