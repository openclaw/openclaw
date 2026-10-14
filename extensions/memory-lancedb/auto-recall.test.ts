import { describe, expect, test, vi } from "vitest";
import { createAutoRecallHook } from "./auto-recall.js";
import { MemoryDB } from "./lancedb-store.js";

describe("automatic memory recall privacy", () => {
  test.each([
    { sessionKey: "agent:main:dashboard:incognito-recall", expectedCalls: 0 },
    { sessionKey: "agent:main:dashboard:ordinary-recall", expectedCalls: 1 },
  ])("limits embedding and search for $sessionKey", async ({ sessionKey, expectedCalls }) => {
    const db = new MemoryDB("unused-auto-recall-test-db", 3);
    const search = vi.spyOn(db, "search").mockResolvedValue([]);
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const hook = createAutoRecallHook({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      db,
      embeddings: { embed },
      resolveCurrentConfig: () => ({
        embedding: { provider: "openai", model: "synthetic-test-embedding" },
        autoRecall: true,
        captureMaxChars: 500,
        recallMaxChars: 1000,
      }),
      resolveEnabledAgentId: (agentId) => agentId,
      readCooldown: () => undefined,
      recordCooldown: vi.fn(),
    });

    await expect(
      hook(
        { prompt: "SYNTHETIC_INCOGNITO_EMBEDDING_SENTINEL", messages: [] },
        {
          agentId: "main",
          sessionKey,
          toolAuthority: {
            allows: (toolName) => toolName === "memory_recall",
            assertActive: () => undefined,
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(embed).toHaveBeenCalledTimes(expectedCalls);
    expect(search).toHaveBeenCalledTimes(expectedCalls);
  });
});
