import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readSqliteReaderDiagnosticsForPath } from "../../infra/sqlite-reader-lifecycle.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import {
  listCandidateAuthProfileStores,
  loadCandidateAuthProfileStore,
  updateCandidateAuthProfileStore,
} from "./candidate-stores.js";
import { closeAuthProfileReadPool } from "./sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("candidate auth profile stores", () => {
  it("fails closed when the state-root agent inventory cannot be read", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fsPromises, "readdir").mockRejectedValueOnce(error);

    await expect(
      listCandidateAuthProfileStores({
        cfg: {},
        env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-auth-candidates-denied-") },
      }),
    ).rejects.toBe(error);
  });

  it("dedupes configured, state-root, and registered custom database paths", async () => {
    const tempRoot = tempDirs.make("openclaw-auth-candidates-");
    const stateDir = path.join(tempRoot, "state");
    const configuredAgentDir = path.join(tempRoot, "configured-agent");
    const stateAgentDir = path.join(stateDir, "agents", "state-agent", "agent");
    const customDatabasePath = path.join(tempRoot, "custom", "credentials.sqlite");
    const configuredDatabasePath = path.join(configuredAgentDir, "openclaw-agent.sqlite");
    const env = { OPENCLAW_STATE_DIR: stateDir };

    fs.mkdirSync(configuredAgentDir, { recursive: true });
    fs.mkdirSync(stateAgentDir, { recursive: true });
    fs.mkdirSync(path.dirname(customDatabasePath), { recursive: true });
    try {
      registerOpenClawAgentDatabase({
        agentId: "configured",
        path: configuredDatabasePath,
        env,
      });
      registerOpenClawAgentDatabase({
        agentId: "custom",
        path: customDatabasePath,
        env,
      });

      openOpenClawAgentDatabase({ agentId: "custom", path: customDatabasePath, env });
      const candidates = await listCandidateAuthProfileStores({
        cfg: {
          agents: {
            entries: {
              configured: { agentDir: configuredAgentDir },
              custom: { agentDir: path.join(tempRoot, "active-custom-agent") },
            },
          },
        },
        env,
      });
      expect(candidates).toHaveLength(4);
      expect(candidates.map((candidate) => candidate.agentId)).toEqual([
        "custom",
        "configured",
        "custom",
        "state-agent",
      ]);

      const custom = candidates.find((candidate) => candidate.databasePath === customDatabasePath);
      expect(custom).toBeDefined();
      const sql = observeHostDataSql();
      try {
        await updateCandidateAuthProfileStore({
          candidate: custom!,
          profileId: "openai:default",
          updater: (store) => {
            store.profiles["openai:default"] = {
              type: "oauth",
              provider: "openai",
              access: "custom-access",
              refresh: "custom-refresh",
              expires: 1,
            };
            return true;
          },
        });
        expect(sql.queries.filter((query) => /auth_profile_(?:store|state)/i.test(query))).toEqual(
          [],
        );
      } finally {
        sql.restore();
      }
      closeOpenClawAgentDatabaseByPath(customDatabasePath, "custom");
      expect(loadCandidateAuthProfileStore(custom!)?.profiles["openai:default"]).toMatchObject({
        access: "custom-access",
        refresh: "custom-refresh",
      });
      expect(readSqliteReaderDiagnosticsForPath(customDatabasePath).connections).toEqual([]);
    } finally {
      closeAuthProfileReadPool({ kind: "root", rootPath: tempRoot });
      unregisterOpenClawAgentDatabase({
        agentId: "configured",
        path: configuredDatabasePath,
        env,
      });
      unregisterOpenClawAgentDatabase({ agentId: "custom", path: customDatabasePath, env });
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
    }
  });
});
