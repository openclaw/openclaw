import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { openTrackedStateDatabase } from "../../state/openclaw-state-db-handle.js";
import { writeAuthProfileJsonCell } from "./sqlite-json-write.js";
import { readAuthProfileJsonCellText } from "./sqlite-json.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import type { AuthProfileUsageInput } from "./store.worker-contract.js";
import { recordAuthProfileUsageInDatabase } from "./usage-kernel.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const profileId = "example:synthetic";
const credential = { type: "api_key", provider: "example", key: "synthetic-key" } as const;
const input: AuthProfileUsageInput = {
  profileId,
  expectedCredential: credential,
  inherited: false,
  reduction: {
    kind: "failure",
    expectedProfile: credential,
    observedAt: 1,
    reason: "timeout",
    whamResult: null,
    probeEligible: false,
  },
};

it.each(["agent", "shared-state"] as const)(
  "reads both %s usage cells once and reduces the latest committed health",
  (kind) => {
    const databasePath = path.join(tempDirs.make("usage-cells-"), "auth.sqlite");
    using database = openTrackedStateDatabase(databasePath);
    database.exec(`
      CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER);
      CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT, updated_at INTEGER);
      CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
    `);
    admitSqliteSchema(database);
    const transact = <T>(run: () => T) => runSqliteImmediateTransactionSync(database, run);
    const credentialTable = kind === "agent" ? "auth_profile_store" : "config_machine_state";
    const credentialKeyColumn = kind === "agent" ? "store_key" : "state_key";
    const credentialColumn = kind === "agent" ? "store_json" : "value_json";
    const credentialKey = kind === "agent" ? "primary" : "authProfiles.store";
    database
      .prepare(
        `INSERT INTO ${credentialTable} (${credentialKeyColumn}, ${credentialColumn}) VALUES (?, ?)`,
      )
      .run(credentialKey, JSON.stringify({ version: 1, profiles: { [profileId]: credential } }));
    const credentials = readAuthProfileJsonCellText(database, "store", kind);
    const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    using _ = { [Symbol.dispose]: observation.restore };
    for (const failures of [2, 7]) {
      transact(() =>
        writeAuthProfileJsonCell(database, "state", kind, {
          usageStats: {
            [profileId]: {
              errorCount: failures,
              failureCounts: { timeout: failures },
              lastFailureAt: Date.now(),
            },
          },
        }),
      );
      observation.queries.length = 0;
      transact(() => recordAuthProfileUsageInDatabase(database, databasePath, kind, input));
      expect(observation.queries).toHaveLength(1);
      expect(JSON.parse(readAuthProfileJsonCellText(database, "state", kind)!)).toMatchObject({
        usageStats: {
          [profileId]: {
            errorCount: failures + 1,
            failureCounts: { timeout: failures + 1 },
          },
        },
      });
      expect(readAuthProfileJsonCellText(database, "store", kind)).toBe(credentials);
    }
    const table = kind === "agent" ? "auth_profile_state" : "config_machine_state";
    const column = kind === "agent" ? "state_json" : "value_json";
    const key = kind === "agent" ? "primary" : "authProfiles.state";
    database.prepare(`UPDATE ${table} SET ${column} = ? WHERE state_key = ?`).run("{", key);
    for (const absent of [false, true]) {
      if (absent) {
        database
          .prepare(`DELETE FROM ${credentialTable} WHERE ${credentialKeyColumn} = ?`)
          .run(credentialKey);
      }
      expect(() =>
        transact(() => recordAuthProfileUsageInDatabase(database, databasePath, kind, input)),
      ).toThrow(AuthProfileStoreUnreadableError);
      expect(readAuthProfileJsonCellText(database, "state", kind)).toBe("{");
    }
  },
);
