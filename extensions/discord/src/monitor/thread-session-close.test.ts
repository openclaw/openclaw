// Discord tests cover thread session close plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const listSessionEntries = vi.fn();
  const patchSessionEntry = vi.fn();
  const resolveStorePath = vi.fn(() => "/tmp/openclaw-sessions.json");
  return { listSessionEntries, patchSessionEntry, resolveStorePath };
});

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    listSessionEntries: hoisted.listSessionEntries,
    patchSessionEntry: hoisted.patchSessionEntry,
    resolveStorePath: hoisted.resolveStorePath,
  };
});

let closeDiscordThreadSessions: typeof import("./thread-session-close.js").closeDiscordThreadSessions;

type TestSessionEntry = {
  sessionId: string;
  updatedAt: number;
  lastInteractionAt?: number;
  sessionClosedAt?: number;
};

function entry(sessionId: string, updatedAt: number, extra: Partial<TestSessionEntry> = {}) {
  return { sessionId, updatedAt, ...extra };
}

function setupStore(store: Record<string, TestSessionEntry>) {
  hoisted.listSessionEntries.mockImplementation(() =>
    Object.entries(store).map(([sessionKey, sessionEntry]) => ({
      sessionKey,
      entry: { ...sessionEntry },
    })),
  );
  hoisted.patchSessionEntry.mockImplementation(
    async (params: {
      sessionKey: string;
      update: (entry: TestSessionEntry) => Partial<TestSessionEntry> | null;
    }) => {
      const current = store[params.sessionKey];
      if (!current) {
        return null;
      }
      const patch = params.update(current);
      if (!patch) {
        return current;
      }
      store[params.sessionKey] = patch as TestSessionEntry;
      return store[params.sessionKey];
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
    hoisted.listSessionEntries.mockReset();
    hoisted.patchSessionEntry.mockReset();
    hoisted.resolveStorePath.mockClear();
    hoisted.resolveStorePath.mockReturnValue("/tmp/openclaw-sessions.json");
  });

  it("marks sessions whose key contains the threadId as closed", async () => {
    const store = {
      [MATCHED_KEY]: entry("matched-session", 1_700_000_000_000),
      [UNMATCHED_KEY]: entry("unmatched-session", 1_700_000_000_001),
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(1);
    expect(store[MATCHED_KEY].updatedAt).toBe(0);
    expect(store[MATCHED_KEY].lastInteractionAt).toBeUndefined();
    expect(store[MATCHED_KEY].sessionClosedAt).toBeGreaterThan(0);
    expect(store[UNMATCHED_KEY].updatedAt).toBe(1_700_000_000_001);
  });

  it("returns 0 and leaves store unchanged when no session matches", async () => {
    const store = {
      [UNMATCHED_KEY]: entry("unmatched-session", 1_700_000_000_001),
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

  it("marks all matching sessions when multiple keys contain the threadId", async () => {
    const keyA = `agent:main:discord:channel:${THREAD_ID}`;
    const keyB = `agent:work:discord:channel:${THREAD_ID}`;
    const keyC = `agent:main:discord:channel:${OTHER_ID}`;
    const store = {
      [keyA]: entry("session-a", 1_000),
      [keyB]: entry("session-b", 2_000),
      [keyC]: entry("session-c", 3_000),
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(2);
    expect(store[keyA].sessionClosedAt).toBeGreaterThan(0);
    expect(store[keyB].sessionClosedAt).toBeGreaterThan(0);
    expect(store[keyC].updatedAt).toBe(3_000);
  });

  it("does not match a key that contains the threadId as a substring of a longer snowflake", async () => {
    const longerSnowflake = `${THREAD_ID}00`;
    const noMatchKey = `agent:main:discord:channel:${longerSnowflake}`;
    const store = {
      [noMatchKey]: entry("no-match-session", 9_999),
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
      [uppercaseKey]: entry("uppercase-session", 5_000),
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID.toLowerCase(),
    });

    expect(count).toBe(1);
    expect(store[uppercaseKey].sessionClosedAt).toBeGreaterThan(0);
  });

  it("returns 0 immediately when threadId is empty without touching the store", async () => {
    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: "   ",
    });

    expect(count).toBe(0);
    expect(hoisted.listSessionEntries).not.toHaveBeenCalled();
    expect(hoisted.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("marks idle/no-expiry thread sessions instead of relying on timestamp freshness", async () => {
    const store = {
      [MATCHED_KEY]: entry("matched-session", 1_700_000_000_000, {
        lastInteractionAt: 1_700_000_000_000,
      }),
      [UNMATCHED_KEY]: entry("unmatched-session", 1_700_000_000_001),
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(1);
    expect(store[MATCHED_KEY].sessionClosedAt).toBeGreaterThan(0);
    expect(store[MATCHED_KEY].lastInteractionAt).toBeUndefined();
    expect(store[UNMATCHED_KEY].updatedAt).toBe(1_700_000_000_001);
  });

  it("does not mark a matching session that changed after the list snapshot", async () => {
    const store: Record<string, TestSessionEntry> = {
      [MATCHED_KEY]: {
        sessionId: "fresh-session",
        updatedAt: 2_000,
      },
    };
    setupStore(store);
    hoisted.listSessionEntries.mockReturnValue([
      {
        sessionKey: MATCHED_KEY,
        entry: {
          sessionId: "old-session",
          updatedAt: 1_000,
        },
      },
    ]);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(0);
    expect(store[MATCHED_KEY].updatedAt).toBe(2_000);
    expect(store[MATCHED_KEY].sessionId).toBe("fresh-session");
    expect(store[MATCHED_KEY].sessionClosedAt).toBeUndefined();
  });

  it("does not count a session that is already marked closed", async () => {
    const store = {
      [MATCHED_KEY]: entry("matched-session", 0, { sessionClosedAt: 1_700_000_000_000 }),
    };
    setupStore(store);

    const count = await closeDiscordThreadSessions({
      cfg: {},
      accountId: "default",
      threadId: THREAD_ID,
    });

    expect(count).toBe(0);
    expect(hoisted.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("resolves the store path using cfg.session.store and accountId", async () => {
    const store = {};
    setupStore(store);

    await closeDiscordThreadSessions({
      cfg: { session: { store: "/custom/path/sessions.json" } },
      accountId: "my-bot",
      threadId: THREAD_ID,
    });

    expect(hoisted.resolveStorePath).toHaveBeenCalledWith("/custom/path/sessions.json", {
      agentId: "my-bot",
    });
  });
});
