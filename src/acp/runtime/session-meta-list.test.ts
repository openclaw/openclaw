import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resetConfigRuntimeState } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  listAcpSessionEntries,
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "./session-meta.js";
import { withAcpSessionTestDir as withTestDir } from "./session-meta.test-support.js";

async function seedAcpSessionEntry(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}) {
  await replaceSessionEntry({ agentId: "codex", ...params }, params.entry);
}

describe("ACP session listing", () => {
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  });

  it("lists SQLite ACP rows while joining current session-store entries", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:s1";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "sess-acp",
          updatedAt: 100,
          model: "gpt-5.5",
          skillsSnapshot: { prompt: "Saved prompt", skills: [{ name: "fixture-skill" }] },
        },
      });
      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-s1",
          mode: "oneshot",
          state: "running",
          lastActivityAt: 321,
        }),
      });

      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      const sql = observeMainThreadSql();
      let entries;
      try {
        entries = await listAcpSessionEntries({ cfg, databasePath, clone: false });
        sql.expectIdle();
      } finally {
        sql.restore();
      }

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        cfg,
        storePath,
        sessionKey,
        storeSessionKey: sessionKey,
        entry: {
          sessionId: "sess-acp",
          model: "gpt-5.5",
          skillsSnapshot: { prompt: "Saved prompt", skills: [{ name: "fixture-skill" }] },
        },
        acp: {
          backend: "acpx",
          runtimeSessionName: "codex-s1",
          mode: "oneshot",
          state: "running",
        },
      });
      const returned = entries[0]?.entry;
      if (!returned?.skillsSnapshot) {
        throw new Error("Expected complete session metadata");
      }
      returned.skillsSnapshot.skills[0]!.name = "changed-return-value";
      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: (current) => current && { ...current, runtimeSessionName: "updated-runtime" },
      });
      const fresh = await listAcpSessionEntries({ cfg, databasePath });
      expect(fresh[0]?.entry?.skillsSnapshot?.skills[0]?.name).toBe("fixture-skill");
      expect(fresh[0]?.acp?.runtimeSessionName).toBe("updated-runtime");
    });
  });

  it("loads cold runtime config and joins entries without main-thread SQL", async () => {
    await withOpenClawTestState({ label: "acp-list-cold-config" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { codex: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const sessionKey = "agent:codex:acp:cold-config";
      await replaceSessionEntry(
        { agentId: "codex", sessionKey, env: state.env },
        { sessionId: "cold-config", updatedAt: 100 },
      );
      await upsertAcpSessionMeta({
        cfg,
        env: state.env,
        sessionKey,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "cold-config",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        }),
      });
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      resetConfigRuntimeState();
      const sql = observeMainThreadSql();
      try {
        const entries = await listAcpSessionEntries({});
        sql.expectIdle();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          sessionKey,
          entry: { sessionId: "cold-config" },
          acp: { runtimeSessionName: "cold-config" },
        });
      } finally {
        sql.restore();
      }
    });
  });

  it.each(["state", "agent"] as const)("does not create a missing %s store", async (missing) => {
    await withTestDir({ prefix: "openclaw-acp-list-missing-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(dir, "missing") };
      if (missing === "agent") {
        writeAcpSessionMetaForMigration({
          env,
          sessionKey: "agent:codex:acp:missing",
          sessionId: "missing",
          meta: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "missing",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 100,
          },
        });
        await closeOpenClawStateDatabaseAsync();
      }
      const sql = observeMainThreadSql();
      try {
        expect(await listAcpSessionEntries({ cfg: {}, env })).toEqual([]);
        sql.expectIdle();
      } finally {
        sql.restore();
      }
      expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "agents"))).toBe(false);
      if (missing === "state") {
        expect(fs.existsSync(env.OPENCLAW_STATE_DIR)).toBe(false);
      }
    });
  });

  it("honors OPENCLAW_STATE_DIR when joining listed SQLite rows to session stores", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir } as NodeJS.ProcessEnv;
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:codex:acp:s1";
      const storePath = path.join(dir, "agents", "codex", "sessions", "sessions.json");
      try {
        await seedAcpSessionEntry({
          storePath,
          sessionKey,
          entry: {
            sessionId: "sess-acp",
            updatedAt: 100,
          },
        });
        await upsertAcpSessionMeta({
          cfg,
          env,
          sessionKey,
          mutate: () => ({
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "codex-s1",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 321,
          }),
        });

        const entries = await listAcpSessionEntries({ cfg, env });

        expect(entries).toHaveLength(1);
        expect(entries[0]?.storePath).toBe(storePath);
        expect(entries[0]?.entry?.sessionId).toBe("sess-acp");
      } finally {
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
      }
    });
  });
});
