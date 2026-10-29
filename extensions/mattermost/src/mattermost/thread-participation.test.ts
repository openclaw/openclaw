import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import * as initialStateRuntime from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const threadParticipationMemory = resolveGlobalDedupeCache(
  Symbol.for("openclaw.mattermostThreadParticipation"),
  { ttlMs: 7 * 24 * 60 * 60 * 1000, maxSize: 5000 },
);

let stateRuntime = initialStateRuntime;
let setMattermostRuntime: typeof import("../runtime.js").setMattermostRuntime;
let hasMattermostThreadParticipationWithPersistence: typeof import("./thread-participation.js").hasMattermostThreadParticipationWithPersistence;
let recordMattermostThreadParticipation: typeof import("./thread-participation.js").recordMattermostThreadParticipation;

function setRuntime(openKeyedStoreV2: (options: OpenKeyedStoreOptions) => unknown): void {
  setMattermostRuntime({
    state: { openKeyedStoreV2 },
    logging: { getChildLogger: () => ({ warn() {} }) },
  } as unknown as PluginRuntime);
}

function hasParticipation(accountId = "acct", threadRootId = "root-1", channelId = "chan") {
  return hasMattermostThreadParticipationWithPersistence({
    accountId,
    channelId,
    threadRootId,
  });
}

describe("mattermost thread participation", () => {
  beforeEach(async () => {
    stateRuntime.resetPluginStateStoreForTests();
    threadParticipationMemory.clear();
    vi.resetModules();
    // Store factories and their lazy worker admissions must share one module generation.
    stateRuntime = await import("openclaw/plugin-sdk/plugin-state-test-runtime");
    ({ setMattermostRuntime } = await import("../runtime.js"));
    ({ hasMattermostThreadParticipationWithPersistence, recordMattermostThreadParticipation } =
      await import("./thread-participation.js"));
    setRuntime((options) =>
      stateRuntime.createPluginStateKeyedStoreV2ForTests("mattermost", options, {
        assertCurrent() {},
      }),
    );
  });

  afterEach(() => {
    threadParticipationMemory.clear();
    stateRuntime.resetPluginStateStoreForTests();
    vi.restoreAllMocks();
  });

  it("isolates participation by account, channel, and thread", async () => {
    await recordMattermostThreadParticipation("acct", "chan", "root-1");
    for (const [account, thread, channel] of [
      ["other", "root-1", "chan"],
      ["acct", "root-1", "other"],
      ["acct", "root-2", "chan"],
    ]) {
      await expect(hasParticipation(account, thread, channel)).resolves.toBe(false);
    }
  });

  it("ignores empty identifiers", async () => {
    await recordMattermostThreadParticipation("", "chan", "root-1");
    await expect(hasParticipation("")).resolves.toBe(false);
  });

  it("restores participation after a restart without extending its original expiry", async () => {
    const repliedAt = 1_711_406_400_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(repliedAt);
    await recordMattermostThreadParticipation("acct", "chan", "root-1");
    now.mockReturnValue(repliedAt + 7 * 24 * 60 * 60 * 1000 - 1000);
    // Simulate a restart near expiry: memory is lost, but the SQLite row is still valid.
    threadParticipationMemory.clear();
    await expect(hasParticipation()).resolves.toBe(true);

    now.mockReturnValue(repliedAt + 7 * 24 * 60 * 60 * 1000 + 1000);
    await expect(hasParticipation()).resolves.toBe(false);
  });

  it("degrades to in-memory only when the persistent store fails", async () => {
    setRuntime(() => {
      throw new Error("sqlite unavailable");
    });
    await recordMattermostThreadParticipation("acct", "chan", "root-1");
    await expect(hasParticipation()).resolves.toBe(true);
    await expect(hasParticipation("acct", "missing")).resolves.toBe(false);
  });

  it("restores historical participation carrying an optional agent identity", async () => {
    const store = stateRuntime.createPluginStateKeyedStoreV2ForTests(
      "mattermost",
      {
        namespace: "mattermost.thread-participation",
        maxEntries: 1000,
        defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
      },
      { assertCurrent() {} },
    );
    await store.register("acct:chan:historic-root", {
      agentId: "historic-agent",
      repliedAt: Date.now(),
    });
    await expect(hasParticipation("acct", "historic-root")).resolves.toBe(true);
  });
});
