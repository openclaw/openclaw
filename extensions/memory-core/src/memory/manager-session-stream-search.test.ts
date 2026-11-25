import { sessionPathForSessionIdentity } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const fixture = createManagerIndexFixture({ getMemorySearchManager, closeAllMemorySearchManagers });

it.each([false, true])(
  "publishes both ends of paged session chunks for search (vectors: %s)",
  async (vectors) => {
    await fixture.seedSessionTranscript({
      sessionId: "stream-search",
      messages: Array.from({ length: 40 }, (_, index) => ({
        role: "user" as const,
        senderIsOwner: true,
        timestamp: index + 1,
        content:
          (index === 0 ? "Headstreammarker Alpha. " : "") +
          "synthetic detail ".repeat(200) +
          (index === 39 ? "Tailstreammarker Beta." : ""),
      })),
    });
    const cfg = fixture.createConfig({
      provider: vectors ? "openai" : "none",
      sources: ["sessions"],
      sessionMemory: true,
      vectorEnabled: vectors,
    });
    const manager = await fixture.getFreshManager(cfg, "cli");
    await manager.sync({ reason: "cli", force: true });
    for (const marker of ["Headstreammarker", "Tailstreammarker"]) {
      const hits = await manager.search(marker, {
        lexicalOnly: true,
        minScore: 0,
        sources: ["sessions"],
      });
      // Snippets are prefix-capped; a tail match need not appear in its excerpt.
      expect(hits, marker).toContainEqual(
        expect.objectContaining({
          source: "sessions",
          path: sessionPathForSessionIdentity("main", "stream-search"),
        }),
      );
    }
    await expect(
      manager.search("Absentstreammarker", {
        lexicalOnly: true,
        minScore: 0,
        sources: ["sessions"],
      }),
    ).resolves.toEqual([]);
    expect(manager.status()).toMatchObject({ dirty: false, lastSyncError: undefined });
  },
);
