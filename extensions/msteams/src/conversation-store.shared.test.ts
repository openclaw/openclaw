import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

function createStore() {
  const stateDir = tempDirs.make("openclaw-msteams-store-");
  return createMSTeamsConversationStoreState({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    ttlMs: 60_000,
  });
}

describe("msteams conversation store ('state')", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("normalizes conversation ids consistently", async () => {
    const store = createStore();

    await store.upsert("conv-norm;messageid=123", {
      conversation: { id: "conv-norm" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
    });

    const normalized = await store.get("conv-norm");
    expect(normalized).toEqual({
      conversation: { id: "conv-norm" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
      lastSeenAt: normalized?.lastSeenAt,
    });
    expect(typeof normalized?.lastSeenAt).toBe("string");
    await expect(store.remove("conv-norm")).resolves.toBe(true);
    await expect(store.get("conv-norm;messageid=123")).resolves.toBeNull();
  });

  it("upserts, lists, removes, and resolves users by both AAD and Bot Framework ids", async () => {
    const store = createStore();
    const first = {
      conversation: { id: "conv-a" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
    };
    const second = {
      ...first,
      conversation: { id: "conv-b" },
      user: { id: "user-b", aadObjectId: "aad-b", name: "Bob" },
    };
    const firstTime = "2026-03-25T20:00:00.000Z";
    const secondTime = "2026-03-25T20:00:30.000Z";
    const firstEntry = {
      conversationId: "conv-a",
      reference: { ...first, lastSeenAt: firstTime },
    };
    const secondEntry = {
      conversationId: "conv-b",
      reference: { ...second, lastSeenAt: secondTime },
    };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(firstTime));
      await store.upsert("conv-a", first);
      vi.setSystemTime(new Date(secondTime));
      await store.upsert("conv-b", second);

      await expect(store.get("conv-a")).resolves.toEqual(firstEntry.reference);
      await expect(store.list()).resolves.toEqual([firstEntry, secondEntry]);
      await expect(store.findPreferredDmByUserId("  aad-b  ")).resolves.toEqual(secondEntry);
      await expect(store.findPreferredDmByUserId("user-a")).resolves.toEqual(firstEntry);
      await expect(store.findPreferredDmByUserId("   ")).resolves.toBeNull();
      await expect(store.remove("conv-a")).resolves.toBe(true);
      await expect(store.get("conv-a")).resolves.toBeNull();
      await expect(store.remove("missing")).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the freshest personal conversation for repeated upserts of the same user", async () => {
    const store = createStore();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-25T20:00:00.000Z"));
      await store.upsert("dm-old", {
        conversation: { id: "dm-old", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "user-shared-old", aadObjectId: "aad-shared", name: "Old DM" },
      });

      vi.setSystemTime(new Date("2026-03-25T20:00:10.000Z"));
      await store.upsert("group-shared", {
        conversation: { id: "group-shared", conversationType: "groupChat" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "user-shared-group", aadObjectId: "aad-shared", name: "Group" },
      });

      vi.setSystemTime(new Date("2026-03-25T20:00:20.000Z"));
      await store.upsert("dm-new", {
        conversation: { id: "dm-new", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "user-shared-new", aadObjectId: "aad-shared", name: "New DM" },
      });

      await expect(store.findPreferredDmByUserId("aad-shared")).resolves.toEqual({
        conversationId: "dm-new",
        reference: {
          conversation: { id: "dm-new", conversationType: "personal" },
          channelId: "msteams",
          serviceUrl: "https://service.example.com",
          user: { id: "user-shared-new", aadObjectId: "aad-shared", name: "New DM" },
          lastSeenAt: "2026-03-25T20:00:20.000Z",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
