import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import type { StoredConversationReference as Reference } from "./conversation-store.js";
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
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return createMSTeamsConversationStoreState();
}

function reference(id: string, user: Reference["user"], conversationType?: string): Reference {
  return {
    conversation: { id, ...(conversationType ? { conversationType } : {}) },
    channelId: "msteams",
    serviceUrl: "https://service.example.com",
    user,
  };
}

describe("msteams conversation store ('state')", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("normalizes conversation ids consistently", async () => {
    const store = createStore();

    const ref = reference("conv-norm", { id: "u1" });
    await store.upsert("conv-norm;messageid=123", ref);

    const normalized = await store.get("conv-norm");
    expect(normalized).toEqual({ ...ref, lastSeenAt: expect.any(String) });
    await expect(store.remove("conv-norm")).resolves.toBe(true);
    await expect(store.get("conv-norm;messageid=123")).resolves.toBeNull();
  });

  it("upserts, lists, removes, and resolves users by both AAD and Bot Framework ids", async () => {
    const store = createStore();
    const first = reference("conv-a", { id: "user-a", aadObjectId: "aad-a", name: "Alice" });
    const second = reference("conv-b", { id: "user-b", aadObjectId: "aad-b", name: "Bob" });
    const firstTime = "2026-03-25T20:00:00.000Z";
    const secondTime = "2026-03-25T20:00:30.000Z";
    const stamped = (conversationId: string, ref: Reference, lastSeenAt: string) => ({
      conversationId,
      reference: { ...ref, lastSeenAt },
    });
    const firstEntry = stamped("conv-a", first, firstTime);
    const secondEntry = stamped("conv-b", second, secondTime);

    vi.useFakeTimers();
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
  });

  it("prefers the freshest personal conversation for repeated upserts of the same user", async () => {
    const store = createStore();
    const shared = (id: string, suffix: string, name: string, type = "personal") =>
      reference(id, { id: `user-shared-${suffix}`, aadObjectId: "aad-shared", name }, type);
    const newest = shared("dm-new", "new", "New DM");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T20:00:00.000Z"));
    await store.upsert("dm-old", shared("dm-old", "old", "Old DM"));
    vi.setSystemTime(new Date("2026-03-25T20:00:10.000Z"));
    await store.upsert("group-shared", shared("group-shared", "group", "Group", "groupChat"));
    vi.setSystemTime(new Date("2026-03-25T20:00:20.000Z"));
    await store.upsert("dm-new", newest);

    await expect(store.findPreferredDmByUserId("aad-shared")).resolves.toEqual({
      conversationId: "dm-new",
      reference: { ...newest, lastSeenAt: "2026-03-25T20:00:20.000Z" },
    });
  });
});
