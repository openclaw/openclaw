import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const listSessionEntries = vi.fn();
  const upsertSessionEntry = vi.fn();
  return { listSessionEntries, upsertSessionEntry };
});

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    listSessionEntries: hoisted.listSessionEntries,
    upsertSessionEntry: hoisted.upsertSessionEntry,
  };
});

let closeDiscordThreadSessions: typeof import("./thread-session-close.js").closeDiscordThreadSessions;

function setupStore(store: Record<string, { updatedAt: number }>) {
  hoisted.listSessionEntries.mockImplementation(() =>
    Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry })),
  );
  hoisted.upsertSessionEntry.mockImplementation(
    ({ sessionKey, entry }: { sessionKey: string; entry: { updatedAt: number } }) => {
      store[sessionKey] = entry;
    },
  );
}

const THREAD_ID = "999";
const OTHER_ID = "111";

const MATCHED_KEY = `agent:main:discord:channel:${THREAD_ID}`;
const UNMATCHED_KEY = `agent:main:discord:channel:${OTHER_ID}`;

describe("closeDiscordThreadSessions", () => {
  beforeAll(async () => {
    ({ closeDiscordThreadSessions } = await import("./thread-session-close.js"));
  });

  beforeEach(() => {
    hoisted.listSessionEntries.mockClear();
    hoisted.listSessionEntries.mockReturnValue([]);
    hoisted.upsertSessionEntry.mockClear();
  });

  it("resets updatedAt to 0 for sessions whose key contains the threadId", async () => {
    const store = {
      [MATCHED_KEY]: { updatedAt: 1_700_000_000_000 },
      [UNMATCHED_KEY]: { updatedAt: 1_700_000_000_001 },
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(1);
    expect(store[MATCHED_KEY].updatedAt).toBe(0);
    expect(store[UNMATCHED_KEY].updatedAt).toBe(1_700_000_000_001);
  });

  it("returns 0 and leaves store unchanged when no session matches", async () => {
    const store = {
      [UNMATCHED_KEY]: { updatedAt: 1_700_000_000_001 },
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(0);
    expect(store[UNMATCHED_KEY].updatedAt).toBe(1_700_000_000_001);
  });

  it("resets all matching sessions when multiple keys contain the threadId", async () => {
    const keyA = `agent:main:discord:channel:${THREAD_ID}`;
    const keyB = `agent:work:discord:channel:${THREAD_ID}`;
    const keyC = `agent:main:discord:channel:${OTHER_ID}`;
    const store = {
      [keyA]: { updatedAt: 1_000 },
      [keyB]: { updatedAt: 2_000 },
      [keyC]: { updatedAt: 3_000 },
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(2);
    expect(store[keyA].updatedAt).toBe(0);
    expect(store[keyB].updatedAt).toBe(0);
    expect(store[keyC].updatedAt).toBe(3_000);
  });

  it("does not match a key that contains the threadId as a substring of a longer snowflake", async () => {
    const longerSnowflake = `${THREAD_ID}00`;
    const noMatchKey = `agent:main:discord:channel:${longerSnowflake}`;
    const store = {
      [noMatchKey]: { updatedAt: 9_999 },
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(0);
    expect(store[noMatchKey].updatedAt).toBe(9_999);
  });

  it("matching is case-insensitive for the session key", async () => {
    const uppercaseKey = `agent:main:discord:channel:${THREAD_ID.toUpperCase()}`;
    const store = {
      [uppercaseKey]: { updatedAt: 5_000 },
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID.toLowerCase(),
    });

    expect(count).toBe(1);
    expect(store[uppercaseKey].updatedAt).toBe(0);
  });

  it("returns 0 immediately when threadId is empty without touching the store", async () => {
    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: "   ",
    });

    expect(count).toBe(0);
    expect(hoisted.listSessionEntries).not.toHaveBeenCalled();
  });

  it("does not recount sessions that were already reset", async () => {
    const store = {
      [MATCHED_KEY]: { updatedAt: 0 },
      [UNMATCHED_KEY]: { updatedAt: 1_700_000_000_001 },
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(0);
    expect(store[MATCHED_KEY].updatedAt).toBe(0);
    expect(store[UNMATCHED_KEY].updatedAt).toBe(1_700_000_000_001);
  });

  it("lists rows using the account id as the agent id", async () => {
    const store = {};
    setupStore(store);

    await closeDiscordThreadSessions({
      cfg: { session: {} },
      accountId: "my-bot",
      threadId: THREAD_ID,
    });

    expect(hoisted.listSessionEntries).toHaveBeenCalledWith({ agentId: "my-bot" });
  });
});
