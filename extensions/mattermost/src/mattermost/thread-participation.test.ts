// Mattermost tests cover thread participation cache plugin behavior.
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import {
  clearMattermostThreadParticipationCache,
  hasMattermostThreadParticipationWithPersistence,
  recordMattermostThreadParticipation,
} from "./thread-participation.js";

// Drain microtasks + the immediate queue so the fire-and-forget persistent write
// in recordMattermostThreadParticipation has settled before we assert on it.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
  beforeEach(() => {
    resetPluginStateStoreForTests();
    clearMattermostThreadParticipationCache();
    setPersistentRuntime();
  });

  afterEach(() => {
    clearMattermostThreadParticipationCache();
    resetPluginStateStoreForTests();
  });

  it("remembers a thread the bot replied in", async () => {
    recordMattermostThreadParticipation("acct", "chan", "root-1");
    await expect(
      hasMattermostThreadParticipationWithPersistence({
        accountId: "acct",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(true);
  });

  it("isolates participation by account, channel, and thread", async () => {
    recordMattermostThreadParticipation("acct", "chan", "root-1");
    await flush();
    for (const probe of [
      { accountId: "other", channelId: "chan", threadRootId: "root-1" },
      { accountId: "acct", channelId: "other", threadRootId: "root-1" },
      { accountId: "acct", channelId: "chan", threadRootId: "root-2" },
    ]) {
      await expect(hasMattermostThreadParticipationWithPersistence(probe)).resolves.toBe(false);
    }
  });

  it("ignores empty identifiers", async () => {
    recordMattermostThreadParticipation("", "chan", "root-1");
    await expect(
      hasMattermostThreadParticipationWithPersistence({
        accountId: "",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(false);
  });

  it("recovers participation from the persistent store after the in-memory cache is lost", async () => {
    recordMattermostThreadParticipation("acct", "chan", "root-1");
    await flush();
    // Simulate a restart: in-memory cache cleared, persistent SQLite store intact.
    clearMattermostThreadParticipationCache();
    await expect(
      hasMattermostThreadParticipationWithPersistence({
        accountId: "acct",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(true);
  });

  it("degrades to in-memory only when the persistent store fails", async () => {
    setRuntime(() => {
      throw new Error("sqlite unavailable");
    });
    // record + read must not throw; the in-memory cache still answers.
    recordMattermostThreadParticipation("acct", "chan", "root-1");
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
