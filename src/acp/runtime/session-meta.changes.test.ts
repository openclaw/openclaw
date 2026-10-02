import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAcpDatabaseSessionKey, selectAcpSessionRow } from "./session-meta-keys.js";
import {
  readAcpSessionMeta,
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "./session-meta.js";
import { withAcpSessionTestDir as withTestDir } from "./session-meta.test-support.js";

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

it.each([
  {
    databaseKey: buildAcpDatabaseSessionKey("global", "ops"),
    targets: [
      { agentId: "ops", sessionKey: "global" },
      { sessionKey: buildAcpDatabaseSessionKey("global", "ops") },
    ],
  },
  {
    databaseKey: "@agent:ops:global",
    targets: [{ agentId: "ops", sessionKey: "global" }, { sessionKey: "@agent:ops:global" }],
  },
  {
    databaseKey: "agent:main:acp:project",
    targets: [{ sessionKey: "agent:main:acp:project" }],
  },
  {
    databaseKey: "agent:MAIN:acp:PROJECT",
    targets: [{ sessionKey: "agent:MAIN:acp:PROJECT" }, { sessionKey: "agent:main:acp:project" }],
  },
])("publishes only ACP migration candidates after commit for $databaseKey", async (fixture) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { db } = openOpenClawStateDatabase({ env });
    const observed: Array<{ change: SessionRowChange; transaction: boolean; row: unknown }> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      observed.push({
        change,
        transaction: db.isTransaction,
        row: selectAcpSessionRow(db, fixture.databaseKey)?.runtime_session_name,
      });
    });
    const write = () =>
      writeAcpSessionMetaForMigration({
        env,
        sessionKey: fixture.databaseKey,
        meta: {
          backend: "fixture",
          agent: "fixture",
          runtimeSessionName: "committed",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        },
      });
    try {
      expect(() =>
        runOpenClawStateWriteTransaction(
          () => {
            write();
            expect(observed).toEqual([]);
            throw new Error("rollback");
          },
          { env },
        ),
      ).toThrow("rollback");
      expect(observed).toEqual([]);
      write();
      expect(observed).toEqual(
        fixture.targets.map((change) => ({
          change,
          transaction: false,
          row: "committed",
        })),
      );
    } finally {
      unsubscribe();
    }
  });
});

it("persists bare global metadata under a configured fixed-store owner", async () => {
  await withTestDir({ prefix: "openclaw-acp-global-owner-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const cfg = {
      session: { scope: "global", store: storePath },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;
    const databasePath = path.join(dir, "state", "openclaw.sqlite");
    await replaceSessionEntry(
      {
        agentId: "ops",
        storePath,
        sessionKey: "global",
      },
      { sessionId: "ops-global", updatedAt: 100, sessionStartedAt: 100 },
    );
    const mutate = () => ({
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "global",
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 123,
    });

    const observed: Array<string | undefined> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === "global" && change.agentId === "ops") {
        observed.push(
          readAcpSessionMeta({ cfg, databasePath, sessionKey: "global" })?.runtimeSessionName,
        );
      }
    });
    try {
      const persisted = await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: "global",
        mutate,
      });

      expect(persisted?.acp?.runtimeSessionName).toBe("global");
      expect(
        readAcpSessionMeta({
          cfg,
          databasePath,
          sessionKey: "global",
        })?.runtimeSessionName,
      ).toBe("global");
      const conflictingMutate = vi.fn(mutate);
      await expect(
        upsertAcpSessionMeta({
          cfg,
          databasePath,
          sessionKey: "global",
          agentId: "research",
          mutate: conflictingMutate,
        }),
      ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
      expect(conflictingMutate).not.toHaveBeenCalled();
      const ownerlessCfg = {
        ...cfg,
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } satisfies OpenClawConfig;
      const ownerlessMutate = vi.fn(mutate);
      await expect(
        upsertAcpSessionMeta({
          cfg: ownerlessCfg,
          databasePath,
          sessionKey: "ownerless-global",
          mutate: ownerlessMutate,
        }),
      ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
      expect(ownerlessMutate).not.toHaveBeenCalled();
      expect(observed.at(-1)).toBe("global");
      const beforeDelete = observed.length;
      await upsertAcpSessionMeta({ cfg, databasePath, sessionKey: "global", mutate: () => null });
      expect(observed.length).toBeGreaterThan(beforeDelete);
      expect(observed.at(-1)).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});
