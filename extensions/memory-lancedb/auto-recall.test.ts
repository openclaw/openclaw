import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, test, vi } from "vitest";
import memoryPlugin from "./index.js";
import { MemoryDB } from "./lancedb-store.js";

const embed = vi.hoisted(() => vi.fn(async () => [0.1, 0.2, 0.3]));
vi.mock("./embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embeddings.js")>()),
  createEmbeddings: () => ({ embed, start() {} }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  embed.mockClear();
});

describe("automatic memory recall privacy", () => {
  test.each([
    { sessionKey: "agent:main:dashboard:incognito-recall", expectedCalls: 0 },
    { sessionKey: "agent:main:dashboard:ordinary-recall", expectedCalls: 1 },
  ])("limits embedding and search for $sessionKey", async ({ sessionKey, expectedCalls }) => {
    const search = vi.spyOn(MemoryDB.prototype, "search").mockResolvedValue([]);
    const pluginConfig = {
      embedding: { provider: "openai", model: "synthetic-test-embedding", dimensions: 3 },
      autoRecall: true,
      autoCapture: false,
      captureMaxChars: 500,
      recallMaxChars: 1000,
    };
    const config = { plugins: { entries: { "memory-lancedb": { config: pluginConfig } } } };
    const on = vi.fn();
    const runtime = createPluginRuntimeMock();
    runtime.config.current = () => config;
    memoryPlugin.register(createTestPluginApi({ pluginConfig, config, runtime, on }));
    const hook = on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1];
    expect(hook).toBeTypeOf("function");

    await expect(
      hook(
        { prompt: "SYNTHETIC_INCOGNITO_EMBEDDING_SENTINEL", messages: [] },
        {
          agentId: "main",
          sessionKey,
          toolAuthority: {
            fingerprint: "synthetic-memory-authority",
            allows: (toolName: string) => toolName === "memory_recall",
            assertActive: () => undefined,
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(embed).toHaveBeenCalledTimes(expectedCalls);
    expect(search).toHaveBeenCalledTimes(expectedCalls);
  });
});
