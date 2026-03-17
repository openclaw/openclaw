import { beforeEach, describe, expect, it, vi } from "vitest";
const hoisted = vi.hoisted(() => {
  const updateSessionStore = vi.fn();
  const resolveStorePath = vi.fn(() => "/tmp/openclaw-sessions.json");
  return { updateSessionStore, resolveStorePath };
});
vi.mock("../../../../src/config/sessions.js", () => ({
  updateSessionStore: hoisted.updateSessionStore,
  resolveStorePath: hoisted.resolveStorePath
}));
const { closeDiscordThreadSessions } = await import("./thread-session-close.js");
function setupStore(store) {
  hoisted.updateSessionStore.mockImplementation(
    async (_storePath, mutator) => mutator(store)
  );
}
const THREAD_ID = "999";
const OTHER_ID = "111";
const MATCHED_KEY = `agent:main:discord:channel:${THREAD_ID}`;
const UNMATCHED_KEY = `agent:main:discord:channel:${OTHER_ID}`;
describe("closeDiscordThreadSessions", () => {
  beforeEach(() => {
    hoisted.updateSessionStore.mockClear();
    hoisted.resolveStorePath.mockClear();
    hoisted.resolveStorePath.mockReturnValue("/tmp/openclaw-sessions.json");
  });
  it("resets updatedAt to 0 for sessions whose key contains the threadId", async () => {
    const store = {
      [MATCHED_KEY]: { updatedAt: 17e11 },
      [UNMATCHED_KEY]: { updatedAt: 1700000000001 }
    };
    setupStore(store);
    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID
    });
    expect(count).toBe(1);
    expect(store[MATCHED_KEY].updatedAt).toBe(0);
    expect(store[UNMATCHED_KEY].updatedAt).toBe(1700000000001);
  });
  it("returns 0 and leaves store unchanged when no session matches", async () => {
    const store = {
      [UNMATCHED_KEY]: { updatedAt: 1700000000001 }
    };
    setupStore(store);
    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID
    });
    expect(count).toBe(0);
    expect(store[UNMATCHED_KEY].updatedAt).toBe(1700000000001);
  });
  it("resets all matching sessions when multiple keys contain the threadId", async () => {
    const keyA = `agent:main:discord:channel:${THREAD_ID}`;
    const keyB = `agent:work:discord:channel:${THREAD_ID}`;
    const keyC = `agent:main:discord:channel:${OTHER_ID}`;
    const store = {
      [keyA]: { updatedAt: 1e3 },
      [keyB]: { updatedAt: 2e3 },
      [keyC]: { updatedAt: 3e3 }
    };
    setupStore(store);
    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID
    });
    expect(count).toBe(2);
    expect(store[keyA].updatedAt).toBe(0);
    expect(store[keyB].updatedAt).toBe(0);
    expect(store[keyC].updatedAt).toBe(3e3);
  });
  it("does not match a key that contains the threadId as a substring of a longer snowflake", async () => {
    const longerSnowflake = `${THREAD_ID}00`;
    const noMatchKey = `agent:main:discord:channel:${longerSnowflake}`;
    const store = {
      [noMatchKey]: { updatedAt: 9999 }
    };
    setupStore(store);
    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID
    });
    expect(count).toBe(0);
    expect(store[noMatchKey].updatedAt).toBe(9999);
  });
  it("matching is case-insensitive for the session key", async () => {
    const uppercaseKey = `agent:main:discord:channel:${THREAD_ID.toUpperCase()}`;
    const store = {
      [uppercaseKey]: { updatedAt: 5e3 }
    };
    setupStore(store);
    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID.toLowerCase()
    });
    expect(count).toBe(1);
    expect(store[uppercaseKey].updatedAt).toBe(0);
  });
  it("returns 0 immediately when threadId is empty without touching the store", async () => {
    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: "   "
    });
    expect(count).toBe(0);
    expect(hoisted.updateSessionStore).not.toHaveBeenCalled();
  });
  it("resolves the store path using cfg.session.store and accountId", async () => {
    const store = {};
    setupStore(store);
    await closeDiscordThreadSessions({
      cfg: { session: { store: "/custom/path/sessions.json" } },
      accountId: "my-bot",
      threadId: THREAD_ID
    });
    expect(hoisted.resolveStorePath).toHaveBeenCalledWith("/custom/path/sessions.json", {
      agentId: "my-bot"
    });
  });
});
