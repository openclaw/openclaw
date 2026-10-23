import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeDiscordThreadSessions } from "./thread-session-close.js";

type ResolveStorePath = typeof import("openclaw/plugin-sdk/session-store-runtime").resolveStorePath;

const hoisted = vi.hoisted(() => ({
  deleteSessionEntry: vi.fn(),
  listSessionEntriesAsync: vi.fn(),
  resolveStorePath: vi.fn<ResolveStorePath>(() => "/tmp/openclaw-sessions.json"),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return { ...actual, ...hoisted };
});

function setupStore(store: Record<string, { sessionId?: string; updatedAt: number }>) {
  hoisted.listSessionEntriesAsync.mockImplementation(async () =>
    Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry })),
  );
  hoisted.deleteSessionEntry.mockImplementation(
    async (params: {
      expectedSessionId?: string | null;
      expectedUpdatedAt?: number;
      sessionKey: string;
    }) => {
      const entry = store[params.sessionKey];
      if (
        !entry ||
        (params.expectedSessionId === null
          ? entry.sessionId !== undefined
          : entry.sessionId !== params.expectedSessionId) ||
        entry.updatedAt !== params.expectedUpdatedAt
      ) {
        return false;
      }
      delete store[params.sessionKey];
      return true;
    },
  );
}

const THREAD_ID = "999";
const OTHER_ID = "111";
const MATCHED_KEY = `agent:main:discord:channel:${THREAD_ID}`;
const UNMATCHED_KEY = `agent:main:discord:channel:${OTHER_ID}`;
const close = (threadId = THREAD_ID, cfg: OpenClawConfig = {}) =>
  closeDiscordThreadSessions({ cfg, threadId });

describe("closeDiscordThreadSessions", () => {
  beforeEach(() => {
    hoisted.deleteSessionEntry.mockReset();
    hoisted.listSessionEntriesAsync.mockReset();
    hoisted.resolveStorePath.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
  });

  it("does not match a key that contains the threadId as a substring of a longer snowflake", async () => {
    const noMatchKey = `${MATCHED_KEY}00`;
    const store = { [noMatchKey]: { updatedAt: 9_999 } };
    setupStore(store);

    expect(await close()).toBe(0);
    expect(store[noMatchKey].updatedAt).toBe(9_999);
  });

  it("returns 0 immediately when threadId is empty without touching the store", async () => {
    expect(await close("   ")).toBe(0);
    expect(hoisted.listSessionEntriesAsync).not.toHaveBeenCalled();
    expect(hoisted.deleteSessionEntry).not.toHaveBeenCalled();
  });

  it("does not recount sessions that were already deleted", async () => {
    const store = {
      [MATCHED_KEY]: { updatedAt: 1_700_000_000_000 },
      [UNMATCHED_KEY]: { updatedAt: 1_700_000_000_001 },
    };
    setupStore(store);

    expect(await close()).toBe(1);
    expect(await close()).toBe(0);
    expect(store[MATCHED_KEY]).toBeUndefined();
    expect(store[UNMATCHED_KEY].updatedAt).toBe(1_700_000_000_001);
  });

  it("does not delete a matching session that changed after the list snapshot", async () => {
    const store = {
      [MATCHED_KEY]: { sessionId: "fresh-session", updatedAt: 2_000 },
    };
    setupStore(store);
    hoisted.listSessionEntriesAsync.mockResolvedValue([
      {
        sessionKey: MATCHED_KEY,
        entry: { sessionId: "old-session", updatedAt: 1_000 },
      },
    ]);

    expect(await close()).toBe(0);
    expect(store[MATCHED_KEY]).toEqual({ updatedAt: 2_000, sessionId: "fresh-session" });
  });

  it("scopes each read by agent id and never opens agent databases writably", async () => {
    // A fixed store path still needs each agent's owner DB, not repeated reads of main.
    const fixedStorePath = "/custom/path/sessions.json";
    const entriesByAgent: Record<string, Record<string, { updatedAt: number }>> = {
      main: { [`agent:main:discord:channel:${THREAD_ID}`]: { updatedAt: 1_000 } },
      work: { [`agent:work:discord:channel:${THREAD_ID}`]: { updatedAt: 2_000 } },
    };
    hoisted.resolveStorePath.mockReturnValue(fixedStorePath);
    hoisted.listSessionEntriesAsync.mockImplementation(async ({ agentId }: { agentId?: string }) =>
      Object.entries(agentId ? (entriesByAgent[agentId] ?? {}) : {}).map(([sessionKey, entry]) => ({
        sessionKey,
        entry,
      })),
    );
    hoisted.deleteSessionEntry.mockResolvedValue(true);

    const count = await close(THREAD_ID, {
      session: { store: fixedStorePath },
      agents: { entries: { main: {}, work: {} } },
    });

    expect(count).toBe(2);
    for (const agentId of ["main", "work"]) {
      expect(hoisted.listSessionEntriesAsync).toHaveBeenCalledWith(
        expect.objectContaining({ agentId, storePath: fixedStorePath }),
      );
    }
  });
});
