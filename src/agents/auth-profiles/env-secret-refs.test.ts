import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { clearMissingManagedServiceEnvKeys } from "../../daemon/service-managed-env.js";
import * as nativeSqlite from "../../infra/node-sqlite.js";
import { cleanupSnapshotOperations } from "../../infra/sqlite-readonly-location-cleanup.js";
import * as snapshotSource from "../../infra/sqlite-snapshot-source.js";
import { withArtifactPreservingStateReads } from "../../state/artifact-preserving-state-reads.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { collectAuthProfileEnvSecretRefIds } from "./env-secret-refs.js";
import { resolveSharedAuthStoreOwnership } from "./path-resolve.js";
import { closeAuthProfileReadPool } from "./sqlite-read-pool.js";
import { resolveAuthProfileDatabasePath, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";

function artifactHashes(root: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filename = path.join(entry.parentPath, entry.name);
        return [
          path.relative(root, filename),
          createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
        ];
      }),
  );
}

describe("auth-profile references before managed service environment cleanup", () => {
  it.each(["legacy-main", "state-db"] as const)(
    "reads %s and agent-local references without changing source artifacts",
    async (location) => {
      await withOpenClawTestState({ prefix: "auth-env-ref-owner-" }, async (state) => {
        writeConfigMachineState("auth.sharedStore", { location }, { env: state.env });
        const sharedStore = {
          version: 1,
          profiles: {
            api: {
              type: "api_key",
              provider: "fixture",
              key: "$IGNORED_API_FALLBACK",
              keyRef: { source: "env", provider: "default", id: "SHARED_API_KEY" },
            },
            token: {
              type: "token",
              provider: "fixture",
              token: "$IGNORED_TOKEN_FALLBACK",
              tokenRef: { source: "env", provider: "default", id: "SHARED_TOKEN" },
            },
            file: {
              type: "api_key",
              provider: "fixture",
              key: "$IGNORED_FILE_FALLBACK",
              keyRef: { source: "file", provider: "fixture", id: "key" },
            },
            inline: { type: "api_key", provider: "fixture", key: "synthetic-inline-value" },
          },
        };
        const mainDir = state.agentDir("main");
        if (location === "legacy-main") {
          const database = openOpenClawAgentDatabase({
            agentId: "main",
            path: resolveAuthProfileDatabasePath(mainDir),
            env: state.env,
          });
          writePersistedAuthProfileStoreRaw(sharedStore, mainDir, database);
        } else {
          writePersistedAuthProfileStoreRaw(sharedStore);
        }
        const helperDir = state.agentDir("helper");
        writePersistedAuthProfileStoreRaw(
          {
            version: 1,
            profiles: {
              local: {
                type: "api_key",
                provider: "fixture",
                keyRef: { source: "env", provider: "default", id: "AGENT_API_KEY" },
              },
            },
          },
          helperDir,
        );
        await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
        const before = artifactHashes(state.root);

        expect(
          collectAuthProfileEnvSecretRefIds({
            agentDirs: [mainDir, helperDir],
            env: state.env,
          }),
        ).toEqual(new Set(["AGENT_API_KEY", "SHARED_API_KEY", "SHARED_TOKEN"]));
        expect(artifactHashes(state.root)).toEqual(before);
      });
    },
  );

  it.each([
    { kind: "readable", inspection: false },
    { kind: "schema-refused", inspection: false },
    { kind: "readable", inspection: true },
    { kind: "schema-refused", inspection: true },
  ] as const)(
    "retains the $kind snapshot through failed native close (inspection=$inspection)",
    async ({ kind, inspection }) => {
      await withOpenClawTestState({ prefix: "auth-env-ref-native-close-" }, async (state) => {
        const agentDir = state.agentDir("helper");
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
        await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
        if (kind === "schema-refused") {
          const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
          try {
            database.exec("PRAGMA user_version = 2147483647");
          } finally {
            database.close();
          }
        }
        const before = artifactHashes(state.root);
        let snapshot:
          | ReturnType<typeof snapshotSource.prepareSqliteReadOnlyLocationSync>
          | undefined;
        const snapshots: Array<NonNullable<typeof snapshot>> = [];
        const prepare = snapshotSource.prepareSqliteReadOnlyLocationSync;
        const preparation = vi
          .spyOn(snapshotSource, "prepareSqliteReadOnlyLocationSync")
          .mockImplementation((filename) => {
            const prepared = prepare(filename);
            if (
              filename === resolveAuthProfileDatabasePath(agentDir) ||
              filename === snapshot?.location
            ) {
              snapshot = prepared;
              snapshots.push(prepared);
            }
            return prepared;
          });
        const nativeOpen = nativeSqlite.openNodeSqliteDatabase;
        const failure = new Error("synthetic native reader close failure");
        let failedReader: DatabaseSync | undefined;
        let readerPath: string | undefined;
        let close: MockInstance<DatabaseSync["close"]> | undefined;
        let closeAllowed = false;
        const open = vi
          .spyOn(nativeSqlite, "openNodeSqliteDatabase")
          .mockImplementation((filename, options) => {
            const database = nativeOpen(filename, options);
            if (snapshot && options?.readOnly && (filename === snapshot.location || inspection)) {
              failedReader = database;
              readerPath = filename;
              const nativeClose = database.close.bind(database);
              close = vi.spyOn(database, "close").mockImplementation(() => {
                if (!closeAllowed) {
                  throw failure;
                }
                nativeClose();
              });
            }
            return database;
          });
        try {
          expect(() =>
            withArtifactPreservingStateReads(
              () => collectAuthProfileEnvSecretRefIds({ agentDirs: [agentDir], env: state.env }),
              inspection ? { agentDatabases: true } : {},
            ),
          ).toThrow();
          expect(failedReader?.isOpen).toBe(true);
          expect(snapshot).toBeDefined();
          expect(fs.existsSync(readerPath!)).toBe(true);
          if (!inspection) {
            expect(snapshot!.cleanup()).toBe(false);
          }
          await cleanupSnapshotOperations();
          expect(fs.existsSync(readerPath!)).toBe(true);
          expect(artifactHashes(state.root)).toEqual(before);
          closeAllowed = true;
          if (inspection) {
            failedReader!.close();
          } else {
            closeAuthProfileReadPool({ kind: "database", databasePath: snapshot!.location });
          }
          expect(failedReader!.isOpen).toBe(false);
          for (const prepared of snapshots) {
            expect(prepared.cleanup()).toBe(true);
          }
          expect(fs.existsSync(snapshot!.cleanupRoot ?? path.dirname(snapshot!.location))).toBe(
            false,
          );
        } finally {
          closeAllowed = true;
          if (failedReader?.isOpen && inspection) {
            failedReader.close();
          }
          if (!inspection && snapshot) {
            closeAuthProfileReadPool({ kind: "database", databasePath: snapshot.location });
          }
          // Inspection installs a lifecycle wrapper over the original native close spy.
          if (!inspection) {
            close?.mockRestore();
          }
          preparation.mockRestore();
          open.mockRestore();
          for (const prepared of snapshots) {
            prepared.cleanup();
          }
        }
      });
    },
  );

  it("does not create missing stores or pin the runtime shared-store owner", async () => {
    await withOpenClawTestState({ prefix: "auth-env-ref-missing-" }, async (state) => {
      const before = artifactHashes(state.root);
      expect(
        collectAuthProfileEnvSecretRefIds({
          agentDirs: [state.agentDir("main"), state.agentDir("helper")],
          env: state.env,
        }),
      ).toEqual(new Set());
      expect(artifactHashes(state.root)).toEqual(before);

      writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: state.env });
      expect(resolveSharedAuthStoreOwnership(state.env)).toEqual({ location: "state-db" });
    });
  });

  it.each(["malformed", "unreadable"] as const)(
    "refuses %s stores before clearing inherited credential values",
    async (kind) => {
      await withOpenClawTestState({ prefix: "auth-env-ref-refusal-" }, async (state) => {
        const agentDir = state.agentDir("helper");
        const databasePath = resolveAuthProfileDatabasePath(agentDir);
        if (kind === "malformed") {
          writePersistedAuthProfileStoreRaw({ version: 1, profiles: [] }, agentDir);
          await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
        } else {
          fs.mkdirSync(agentDir, { recursive: true });
          fs.writeFileSync(databasePath, "synthetic invalid SQLite source");
        }
        const before = artifactHashes(state.root);
        const environment = { RETAINED_AUTH_KEY: "synthetic-inherited-value" };
        const cleanup = () => {
          const preserveKeys = collectAuthProfileEnvSecretRefIds({
            agentDirs: [agentDir],
            env: state.env,
          });
          clearMissingManagedServiceEnvKeys({
            environment,
            managedKeys: ["RETAINED_AUTH_KEY"],
            presentKeys: [],
            preserveKeys,
          });
        };
        if (kind === "malformed") {
          expect(cleanup).toThrow(AuthProfileStoreUnreadableError);
        } else {
          expect(cleanup).toThrow();
        }
        expect(environment).toEqual({ RETAINED_AUTH_KEY: "synthetic-inherited-value" });
        expect(artifactHashes(state.root)).toEqual(before);
      });
    },
  );
});
