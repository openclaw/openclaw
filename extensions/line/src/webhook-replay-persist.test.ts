// Line tests cover webhook replay dedupe persistence across restart.
import { installIsolatedPluginStateDirForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLineWebhookReplayCache } from "./bot-handlers.js";

// Per-test state dir: a second cache instance reading the same on-disk
// namespace == a process restart with an empty in-memory cache, and the
// committed keys cannot leak into other suites sharing the worker.
let stateDir: ReturnType<typeof installIsolatedPluginStateDirForTests>;

beforeEach(() => {
  stateDir = installIsolatedPluginStateDirForTests();
});

afterEach(() => {
  stateDir.restore();
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
