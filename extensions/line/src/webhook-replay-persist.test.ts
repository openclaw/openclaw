// Line tests cover webhook replay dedupe persistence across restart.
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createLineWebhookReplayCache } from "./bot-handlers.js";

// Persistence is backed by the extensions Vitest setup, which isolates HOME /
// OPENCLAW_STATE_DIR per worker (test/setup.extensions.ts). A second cache
// instance reading the same on-disk namespace == a process restart with an
// empty in-memory cache. resetPluginStateStoreForTests() closes the shared DB
// handle between tests (it does not clear rows).
afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("line webhook replay cache persistence", () => {
  it("a committed key still dedupes on a fresh cache instance (survives restart)", async () => {
    const replayKey = "default|message:msg-1";

    const cacheA = createLineWebhookReplayCache();
    expect((await cacheA.claim(replayKey)).kind).toBe("claimed");
    await cacheA.commit(replayKey);

    // Fresh instance == restart: LINE redelivers the webhook (stable event id);
    // it must be recognized as a duplicate, not re-processed.
    const cacheB = createLineWebhookReplayCache();
    expect((await cacheB.claim(replayKey)).kind).toBe("duplicate");
  });
});
