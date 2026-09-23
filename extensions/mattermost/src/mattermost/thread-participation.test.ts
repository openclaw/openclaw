import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
// Mattermost tests cover thread participation cache plugin behavior.
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const threadParticipationMemory = resolveGlobalDedupeCache(
  Symbol.for("openclaw.mattermostThreadParticipation"),
  { ttlMs: 7 * 24 * 60 * 60 * 1000, maxSize: 5000 },
);

let setMattermostRuntime: typeof import("../runtime.js").setMattermostRuntime;
let hasMattermostThreadParticipationWithPersistence: typeof import("./thread-participation.js").hasMattermostThreadParticipationWithPersistence;
let recordMattermostThreadParticipation: typeof import("./thread-participation.js").recordMattermostThreadParticipation;

function setRuntime(openKeyedStore: (options: OpenKeyedStoreOptions) => unknown): void {
  setMattermostRuntime({
    state: { openKeyedStore },
    logging: { getChildLogger: () => ({ warn() {} }) },
  } as unknown as PluginRuntime);
}

function setPersistentRuntime(): void {
  setRuntime((options) => createPluginStateKeyedStoreForTests("mattermost", options));
}

describe("mattermost thread participation", () => {
  beforeEach(async () => {
    resetPluginStateStoreForTests();
    threadParticipationMemory.clear();
    vi.resetModules();
    ({ setMattermostRuntime } = await import("../runtime.js"));
    ({ hasMattermostThreadParticipationWithPersistence, recordMattermostThreadParticipation } =
      await import("./thread-participation.js"));
    setPersistentRuntime();
  });

  afterEach(() => {
    threadParticipationMemory.clear();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
  });

  it("remembers a thread the bot replied in", async () => {
    await recordMattermostThreadParticipation("acct", "chan", "root-1");
    await expect(
      hasMattermostThreadParticipationWithPersistence({
        accountId: "acct",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(true);
  });

  it("isolates participation by account, channel, and thread", async () => {
    await recordMattermostThreadParticipation("acct", "chan", "root-1");
    for (const probe of [
      { accountId: "other", channelId: "chan", threadRootId: "root-1" },
      { accountId: "acct", channelId: "other", threadRootId: "root-1" },
      { accountId: "acct", channelId: "chan", threadRootId: "root-2" },
    ]) {
      await expect(hasMattermostThreadParticipationWithPersistence(probe)).resolves.toBe(false);
    }
  });

  it("ignores empty identifiers", async () => {
    await recordMattermostThreadParticipation("", "chan", "root-1");
    await expect(
      hasMattermostThreadParticipationWithPersistence({
        accountId: "",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(false);
  });

  it("restores participation after a restart without extending its original expiry", async () => {
    const repliedAt = 1_711_406_400_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(repliedAt);
    await recordMattermostThreadParticipation("acct", "chan", "root-1");
    now.mockReturnValue(repliedAt + 7 * 24 * 60 * 60 * 1000 - 1000);
    // Simulate a restart near expiry: memory is lost, but the SQLite row is still valid.
    threadParticipationMemory.clear();
    await expect(
      hasMattermostThreadParticipationWithPersistence({
        accountId: "acct",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(true);

    now.mockReturnValue(repliedAt + 7 * 24 * 60 * 60 * 1000 + 1000);
    await expect(
      hasMattermostThreadParticipationWithPersistence({
        accountId: "acct",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(false);
  });

  it("degrades to in-memory only when the persistent store fails", async () => {
    setRuntime(() => {
      throw new Error("sqlite unavailable");
    });
    // record + read must not throw; the in-memory cache still answers.
    await recordMattermostThreadParticipation("acct", "chan", "root-1");
    await expect(
      hasMattermostThreadParticipationWithPersistence({
        accountId: "acct",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(true);
    await expect(
      hasMattermostThreadParticipationWithPersistence({
        accountId: "acct",
        channelId: "chan",
        threadRootId: "missing",
      }),
    ).resolves.toBe(false);
  });
});
