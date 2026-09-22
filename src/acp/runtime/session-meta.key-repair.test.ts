import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withDoctorSqliteMaintenanceLock } from "../../commands/doctor-sqlite-maintenance-lock.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { repairAcpSessionMetaKeysForDoctor } from "./session-meta-doctor.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { writeAcpSessionMetaForMigration } from "./session-meta.js";

const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
const key = "agent:harness:acp:key-repair";
const alias = "agent:HARNESS:acp:key-repair";
const entry = {
  sessionId: "key-repair-session",
  lifecycleRevision: "key-repair-revision",
  sessionStartedAt: 50,
  updatedAt: 100,
};
const meta = {
  backend: "fixture",
  agent: "harness",
  runtimeSessionName: "original-runtime",
  mode: "persistent" as const,
  state: "idle" as const,
  lastActivityAt: 100,
};

it("Doctor retains conflicting aliases while moving the exact raw winner without changing its binding", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async ({ env }) => {
    replaceSessionEntrySync({ agentId: "harness", sessionKey: key, env }, entry);
    writeAcpSessionMetaForMigration({
      env,
      sessionKey: key,
      lifecycleRevision: entry.lifecycleRevision,
      meta,
      now: () => 100,
    });
    writeAcpSessionMetaForMigration({
      env,
      sessionKey: alias,
      lifecycleRevision: entry.lifecycleRevision,
      meta: { ...meta, runtimeSessionName: "conflicting-alias", lastActivityAt: 200 },
      now: () => 200,
    });
    const { db } = stateDatabase.openOpenClawStateDatabase({ env });
    const before = db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all();
    const result = await repairAcpSessionMetaKeysForDoctor({
      cfg,
      env,
      apply: true,
      authority: { assertCurrent() {} },
    });
    expect(result).toEqual({
      found: 1,
      repaired: 1,
      scannedRows: 2,
      warnings: [expect.stringContaining("conflicting payloads retained")],
    });
    expect(db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all()).toEqual([
      {
        ...before.find((row) => row.session_key === key),
        session_key: buildAcpDatabaseSessionKey(key, "harness"),
      },
      before.find((row) => row.session_key === alias),
    ]);
  });
});

it.each([undefined, entry.lifecycleRevision, entry.sessionId])(
  "Doctor preserves an ACP alias payload and %s binding through repair and rerun",
  async (binding) => {
    await withOpenClawTestState({ scenario: "empty" }, async ({ env, stateDir }) => {
      expect(await repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: false })).toEqual({
        found: 0,
        repaired: 0,
        scannedRows: 0,
        warnings: [],
      });
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
      replaceSessionEntrySync({ agentId: "harness", sessionKey: key, env }, entry);
      writeAcpSessionMetaForMigration({
        env,
        sessionKey: alias,
        lifecycleRevision: binding,
        meta,
        now: () => 100,
      });
      const { db } = stateDatabase.openOpenClawStateDatabase({ env });
      const readRows = () => db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all();
      const before = readRows();
      expect(await repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: false })).toEqual({
        found: 1,
        repaired: 0,
        scannedRows: 1,
        warnings: [],
      });
      expect(readRows()).toEqual(before);
      await expect(repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: true })).rejects.toThrow(
        "maintenance authority",
      );
      const changes: unknown[] = [];
      const unsubscribe = sessionChanges.subscribe((change) => changes.push(change));
      try {
        await withDoctorSqliteMaintenanceLock({
          env,
          operation: "ACP test repair",
          run: async (authority) => {
            expect(
              await repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: true, authority }),
            ).toEqual({
              found: 1,
              repaired: 1,
              scannedRows: 1,
              warnings: [],
            });
            expect(
              await repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: true, authority }),
            ).toEqual({
              found: 0,
              repaired: 0,
              scannedRows: 1,
              warnings: [],
            });
          },
        });
      } finally {
        unsubscribe();
      }
      expect(readRows()).toEqual([
        { ...before[0], session_key: buildAcpDatabaseSessionKey(key, "harness") },
      ]);
      expect(changes).toEqual([{ agentId: "harness", sessionKey: key }]);
    });
  },
);

it.each(["stale-revision", "stale-session-id", "missing-owner", "conflicting-canonical"])(
  "Doctor retains the complete ACP source when repair sees %s",
  async (condition) => {
    await withOpenClawTestState({ scenario: "empty" }, async ({ env }) => {
      if (condition !== "missing-owner") {
        replaceSessionEntrySync({ agentId: "harness", sessionKey: key, env }, entry);
      }
      writeAcpSessionMetaForMigration({
        env,
        sessionKey: alias,
        meta,
        lifecycleRevision:
          condition === "stale-revision"
            ? "old-revision"
            : condition === "stale-session-id"
              ? entry.sessionId
              : entry.lifecycleRevision,
        now: () => (condition === "stale-session-id" ? 25 : 100),
      });
      if (condition === "conflicting-canonical") {
        writeAcpSessionMetaForMigration({
          env,
          sessionKey: buildAcpDatabaseSessionKey(key, "harness"),
          lifecycleRevision: entry.lifecycleRevision,
          meta: { ...meta, runtimeSessionName: "canonical-runtime" },
        });
      }
      const { db } = stateDatabase.openOpenClawStateDatabase({ env });
      const before = db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all();
      const result = await repairAcpSessionMetaKeysForDoctor({
        cfg,
        env,
        apply: true,
        authority: { assertCurrent() {} },
      });
      expect(result.repaired).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all()).toEqual(before);
    });
  },
);

it.each(["revoked-authority", "changed-source", "changed-binding"])(
  "Doctor rereads exact ownership before committing after %s",
  async (condition) => {
    await withOpenClawTestState({ scenario: "empty" }, async ({ env }) => {
      replaceSessionEntrySync({ agentId: "harness", sessionKey: key, env }, entry);
      writeAcpSessionMetaForMigration({
        env,
        sessionKey: alias,
        lifecycleRevision: entry.lifecycleRevision,
        meta,
      });
      const { db } = stateDatabase.openOpenClawStateDatabase({ env });
      const before = db.prepare("SELECT * FROM acp_sessions").all();
      let active = true;
      let injected = false;
      const originalWrite = stateDatabase.runOpenClawStateWriteTransaction;
      const write = vi
        .spyOn(stateDatabase, "runOpenClawStateWriteTransaction")
        .mockImplementation((operation, options) => {
          if (!injected) {
            injected = true;
            if (condition === "changed-source") {
              db.prepare(
                "UPDATE acp_sessions SET runtime_session_name = ? WHERE session_key = ?",
              ).run("changed-runtime", alias);
            } else if (condition === "changed-binding") {
              replaceSessionEntrySync(
                { agentId: "harness", sessionKey: key, env },
                { ...entry, lifecycleRevision: "replacement-revision" },
              );
            } else {
              active = false;
            }
          }
          return originalWrite(operation, options);
        });
      try {
        const repair = repairAcpSessionMetaKeysForDoctor({
          cfg,
          env,
          apply: true,
          authority: {
            assertCurrent() {
              if (!active) {
                throw new Error("maintenance authority revoked");
              }
            },
          },
        });
        if (condition === "revoked-authority") {
          await expect(repair).rejects.toThrow("maintenance authority revoked");
        } else {
          const result = await repair;
          expect(result.repaired).toBe(0);
          expect(result.warnings).toEqual([expect.stringContaining("changed")]);
        }
      } finally {
        write.mockRestore();
      }
      expect(db.prepare("SELECT * FROM acp_sessions").all()).toEqual(
        condition === "changed-source"
          ? [{ ...before[0], runtime_session_name: "changed-runtime" }]
          : before,
      );
    });
  },
);
