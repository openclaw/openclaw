import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { persistAgentSession } from "./attempt-execution.shared.js";

afterEach(clearSessionStoreCacheForTest);
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-store-");
const sessionKey = "agent:main:main";

function fixture(initialEntry: SessionEntry = { sessionId: "session-1", updatedAt: 1 }) {
  const scope = {
    agentId: "main",
    sessionKey,
    storePath: path.join(sessionDirs.make(), "sessions.json"),
  };
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: initialEntry };
  return {
    sessionStore,
    seed: (entry: SessionEntry) => replaceSessionEntry(scope, entry),
    read: () => loadSessionEntry({ ...scope, readConsistency: "latest" }),
    write: (overrides: Partial<Parameters<typeof persistAgentSession>[0]> = {}) =>
      persistAgentSession({
        ...scope,
        sessionStore,
        initialEntry,
        entry: initialEntry,
        ...overrides,
      }),
  };
}

describe("persistAgentSession", () => {
  it.each([false, true])(
    "stamps required creation only for a new authoritative row (existing=%s)",
    async (existing) => {
      const entry = { sessionId: "session-1", updatedAt: 1 };
      const { sessionStore, seed, read, write } = fixture(entry);
      delete sessionStore[sessionKey];
      if (existing) {
        await seed(entry);
      }
      const sql = observeHostDataSql();
      const persisted = await write({
        shouldPersist: () => true,
        creation: {
          via: "run",
          actor: { type: "human", source: "profile", id: "sandbox-creator" },
          sandbox: "required",
        },
      }).finally(sql.restore);
      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      const stored = read();
      expect(stored).toEqual(persisted);
      expect(sessionStore[sessionKey]).toEqual(stored);
      if (existing) {
        expect(stored?.sandbox).toBeUndefined();
        expect(stored?.createdActor).toBeUndefined();
      } else {
        expect(stored).toMatchObject({
          sandbox: "required",
          createdVia: "run",
          createdActor: { type: "human", source: "profile", id: "sandbox-creator" },
        });
      }
    },
  );

  it("does not create a session after authority is revoked during preparation", async () => {
    const { sessionStore, read, write } = fixture();
    delete sessionStore[sessionKey];
    let authorized = true;
    await expect(
      write({
        shouldPersist: () => {
          authorized = false;
          return true;
        },
        assertCommitAllowed: () => {
          if (!authorized) {
            throw new Error("operator authority revoked");
          }
        },
        creation: { via: "run", sandbox: "required" },
      }),
    ).rejects.toThrow("operator authority revoked");
    expect(read()).toBeUndefined();
  });

  it("does not restore policy fields revoked during an active turn", async () => {
    const initialEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 100,
      model: "gpt-5.4",
      elevatedLevel: "full",
      inheritedToolAllow: ["exec"],
      sendPolicy: "allow",
    };
    const { seed, read, write } = fixture(initialEntry);
    await seed({ sessionId: "session-1", updatedAt: 400, model: "gpt-5.4", sendPolicy: "deny" });
    const persisted = await write({ entry: { ...initialEntry, model: "gpt-5.5", updatedAt: 250 } });
    expect(persisted).toMatchObject({
      sessionId: "session-1",
      model: "gpt-5.5",
      sendPolicy: "deny",
      updatedAt: 400,
    });
    expect(persisted?.elevatedLevel).toBeUndefined();
    expect(persisted?.inheritedToolAllow).toBeUndefined();
    expect(read()).toEqual(persisted);
  });

  it("keeps rejecting repeated stale writes after clearing local memory", async () => {
    const entry = { sessionId: "deleted-session", updatedAt: 1 };
    const { sessionStore, read, write } = fixture(entry);
    expect(await write()).toBeUndefined();
    expect(await write({ entry: { ...entry, updatedAt: 2 } })).toBeUndefined();
    expect(sessionStore[sessionKey]).toBeUndefined();
    expect(read()).toBeUndefined();
  });
});
