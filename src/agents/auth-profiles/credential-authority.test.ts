import fs from "node:fs";
import path from "node:path";
import { constants, type DatabaseSync } from "node:sqlite";
import { MessageChannel } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createSqlPublicationTestConnection } from "../../../test/helpers/sql-publication-connection.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import {
  GatewayStateOwnerContentionError,
  getStateDatabaseSchemaLease,
  resolveGatewayStateOwnerPath,
  tryAcquireGatewayStateOwner,
} from "../../infra/gateway-state-owner.js";
import { createSqliteCommitReceipt } from "../../infra/sqlite-commit-receipt.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  currentSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationContext,
} from "../../infra/sqlite-worker-operation-settlement.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { saveAuthProfileStore as saveSdkAuthProfileStore } from "../../plugin-sdk/agent-runtime.js";
import { upsertAuthProfile as upsertSdkAuthProfile } from "../../plugin-sdk/provider-auth.js";
import { runSqliteImmediateTransactionSync } from "../../plugin-sdk/sqlite-runtime.js";
import * as machineStateWrites from "../../state/config-machine-state-write.js";
import { machineStateOperations } from "../../state/config-machine-state.worker.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  authProfileCredentialPublication,
  beginAuthProfileCredentialBatch,
  captureAuthProfileCredentialAuthority,
  withAuthProfileCredentialWrite,
} from "../../state/user-model-account-authority.js";
import type { WorkerWriteOperationContext } from "../../state/worker-operation-registry.js";
import { withEnv } from "../../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { createExternalAuthRuntime } from "./external-auth.js";
import { noteCommittedSharedAuthStoreOwnership } from "./path-resolve.js";
import { coercePersistedAuthProfileStore } from "./persisted-store.js";
import { deleteAuthProfileJsonCell, writeAuthProfileJsonCell } from "./sqlite-json-write.js";
import { readAuthProfileJsonCellText } from "./sqlite-json.js";
import { inspectAuthProfileJsonCellReadOnly, runAuthProfileWriteTransaction } from "./sqlite.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  createAuthProfileStoreRuntime,
  restoreAuthProfileStorePersistenceSnapshot,
  withAuthProfileStoreAgentDir,
} from "./store.js";
import type { AuthProfileCredential } from "./types.js";

const dirs = createTempDirTracker();
const sharedPaths: string[] = [];
const agentPaths: string[] = [];
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  for (const pathname of agentPaths) {
    await closeOpenClawAgentDatabaseByPathAsync(pathname);
  }
  for (const pathname of sharedPaths) {
    await closeOpenClawStateDatabaseByPathAsync(pathname);
  }
  dirs.cleanup();
});

const profileId = "fixture:credential";
const credential = (key: string): AuthProfileCredential => ({
  type: "api_key",
  provider: "fixture",
  key,
});
const store = (key: string) => ({ version: 1, profiles: { [profileId]: credential(key) } });
const nativeRuntime = createAuthProfileStoreRuntime(
  createExternalAuthRuntime(
    () => [],
    async (_params, run) => run(),
  ),
);
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
const sdkWriters = ["saveAuthProfileStore", "upsertAuthProfile"] as const;
const metadata = () => ({
  order: { fixture: [profileId] },
  usageStats: { [profileId]: { lastUsed: 100, cooldownUntil: 200 } },
});
type Fixture = ReturnType<typeof fixture>;

function authorityReader(authority: ReturnType<typeof captureAuthProfileCredentialAuthority>) {
  const read = () => authority.readCurrentCredential();
  return { read, denied: () => expect(read).toThrow("authority is unavailable") };
}

function persistedCredential(
  db: Parameters<typeof readAuthProfileJsonCellText>[0],
  kind: "shared-state" | "agent",
  required = false,
) {
  const raw = readAuthProfileJsonCellText(db, "store", kind);
  return raw === undefined && !required
    ? undefined
    : coercePersistedAuthProfileStore(JSON.parse(raw!))?.profiles[profileId];
}

function expectCredential(current: Fixture, key: string) {
  expect([current.readPersisted(), current.read()]).toEqual([credential(key), credential(key)]);
}

function expectDenied(authority: Fixture["authority"], message = "authority is unavailable") {
  expect(() => authority.readCurrentCredential()).toThrow(message);
}

function withCommit(current: Fixture, observe: () => void, operation: () => void) {
  const spy = observePhysicalCommit(current.database.db, observe);
  try {
    operation();
  } finally {
    spy.mockRestore();
  }
}

function withWorker<T>(
  context: Fixture["context"],
  operation: (owner: SqliteWorkerOperationContext) => T,
) {
  const { port1, port2 } = new MessageChannel();
  const owner: SqliteWorkerOperationContext = { port: port1 };
  try {
    return currentSqliteWorkerOperationAdmission.run({ active: true, port: port1, owner }, () =>
      runWithSqliteWorkerStateContext(context, () => operation(owner)),
    );
  } finally {
    port1.close();
    port2.close();
  }
}

function runOutcome(operation: () => void, outcome: string, error: string) {
  if (outcome === "rollback") {
    expect(operation).toThrow(error);
  } else {
    operation();
  }
}

function fixture(
  kind: "shared-state" | "agent",
  stateDir = dirs.make("auth-credential-authority-"),
) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
  const shared = openOpenClawStateDatabase({ env });
  sharedPaths.push(shared.path);
  const agentDir = kind === "agent" ? path.join(stateDir, "agents", "fixture", "agent") : undefined;
  const database = runAuthProfileWriteTransaction(
    agentDir,
    (owner) => {
      writeAuthProfileJsonCell(owner.db, "store", kind, store("original"));
      return { ...owner, db: requireNativeSqliteDatabase(owner.db) };
    },
    { env },
  );
  if (kind === "agent") {
    agentPaths.push(database.path);
  }
  const context = captureOpenClawStateWorkerContext({ env, path: shared.path });
  const physical = kind === "agent" ? readOpenClawAgentDatabaseIdentity(database) : undefined;
  const identity = physical
    ? `file:${physical.identity}:${physical.birthtime ?? ""}`
    : `${context.admission.identity.key}:${context.admission.identity.birthtime ?? ""}`;
  const capture = () =>
    captureAuthProfileCredentialAuthority(
      context,
      { identity, databasePath: database.path },
      profileId,
    );
  const authority = capture();
  const readPersisted = () => persistedCredential(database.db, kind);
  authority.observe(readPersisted());
  const transact = <T>(operation: Parameters<typeof runAuthProfileWriteTransaction<T>>[1]) =>
    runAuthProfileWriteTransaction(agentDir, operation, { env });
  const write = (key: string) =>
    transact(({ db }) => writeAuthProfileJsonCell(db, "store", kind, store(key)));
  const snapshot = () => captureAuthProfileStorePersistenceSnapshot(agentDir, { env });
  const save = (key: string, supplied = false) =>
    saveSdkAuthProfileStore(store(key), agentDir, saveOptions, supplied ? database : undefined);
  const inSdk = <T>(operation: () => T) =>
    withEnv({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined }, operation);
  const sdk = (writer: (typeof sdkWriters)[number], key: string) =>
    inSdk(() => {
      if (writer === "saveAuthProfileStore") {
        save(key);
      } else {
        upsertSdkAuthProfile({ profileId, credential: credential(key), agentDir });
      }
    });
  const remove = () => transact(({ db }) => deleteAuthProfileJsonCell(db, "store", kind));
  const prepareRead = (dir = agentDir, value = store("snapshot")) =>
    nativeRuntime.prepareAuthProfileCredentialRead({ agentDir: dir, profileId, store: value });
  return {
    kind,
    env,
    agentDir,
    database,
    context,
    capture,
    authority,
    ...authorityReader(authority),
    readPersisted,
    transact,
    write,
    snapshot,
    save,
    inSdk,
    sdk,
    remove,
    prepareRead,
  };
}

function absentAgentFixture() {
  const shared = fixture("shared-state");
  const agentDir = path.join(shared.env.OPENCLAW_STATE_DIR, "agents", "fixture", "agent");
  const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
  agentPaths.push(databasePath);
  const captured = readDatabasePathIdentitySync(databasePath);
  const authority = captureAuthProfileCredentialAuthority(
    shared.context,
    { identity: `${captured.key}:`, databasePath },
    profileId,
  );
  authority.observe(undefined);
  const transact = <T>(operation: Parameters<typeof runAuthProfileWriteTransaction<T>>[1]) =>
    runAuthProfileWriteTransaction(agentDir, operation, { env: shared.env });
  return {
    ...shared,
    authority,
    ...authorityReader(authority),
    transact,
    canonicalPath: captured.canonicalPath,
  };
}

function observePhysicalCommit(db: DatabaseSync, assert: () => void) {
  const exec = db.exec.bind(db);
  return vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT") {
      assert();
    }
    return exec(sql);
  });
}

function failAfterNativeWrite(db: DatabaseSync, assertDenied: () => void) {
  const prepare = db.prepare.bind(db);
  // Discard cached statements before simulating a write that loses its acknowledgement.
  db.setAuthorizer(() => constants.SQLITE_OK);
  const fault = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.startsWith("insert into")) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, "run").mockImplementation((...values) => {
        assertDenied();
        run(...values);
        throw new Error("lost native acknowledgement");
      });
    }
    return statement;
  });
  return () => {
    fault.mockRestore();
    db.setAuthorizer(null);
  };
}

describe.each(["shared-state", "agent"] as const)("%s credential authority", (kind) => {
  it("releases a known rollback with its original credential and rejects an overtaken cold result", () => {
    const current = fixture(kind);
    expect(() =>
      current.transact(({ db }) => {
        writeAuthProfileJsonCell(db, "store", kind, store("rolled-back"));
        expect(current.read).toThrow();
        throw new Error("cancelled native update");
      }),
    ).toThrow("cancelled native update");
    expectCredential(current, "original");

    const cold = current.capture();
    const capturedCredential = current.readPersisted();
    current.write("newer");
    cold.observe(capturedCredential);
    expect(cold.readCurrentCredential()).toEqual(credential("newer"));
    expect(cold.readCurrentCredential()).toEqual(current.readPersisted());
  });

  it("preserves credential authority during usage, cooldown, and order-only writes", () => {
    const current = fixture(kind);
    current.transact(({ db }) => {
      writeAuthProfileJsonCell(db, "state", kind, { version: 1, ...metadata() });
      expect(current.read()).toEqual(credential("original"));
      deleteAuthProfileJsonCell(db, "state", kind);
      expect(current.read()).toEqual(credential("original"));
    });
    expect(current.read()).toEqual(credential("original"));
  });

  it("publishes native prepared saves and exact-owned secret rollback through the same authority", () => {
    const current = fixture(kind);
    const baseline = current.snapshot();
    withCommit(
      current,
      () => current.denied(),
      () =>
        current.transact((database, owner) =>
          nativeRuntime.saveAuthProfileStoreWithPreparedOwner(
            store("applied"),
            current.agentDir,
            saveOptions,
            database,
            owner,
          ),
        ),
    );
    expect(current.read()).toEqual(credential("applied"));
    const applied = current.snapshot();
    withCommit(
      current,
      () => current.denied(),
      () => restoreAuthProfileStorePersistenceSnapshot(baseline, applied, current.agentDir),
    );
    expectCredential(current, "original");
  });
});

describe("credential authority captured before local database creation", () => {
  it("preserves absence through metadata creation and publishes a native credential before release", () => {
    const current = absentAgentFixture();
    const database = current.transact((owner) => {
      writeAuthProfileJsonCell(owner.db, "state", "agent", { version: 1, order: {} });
      return owner;
    });
    expect(current.read()).toBeUndefined();
    const commit = observePhysicalCommit(requireNativeSqliteDatabase(database.db), () => {
      expect(current.read).toThrow("authority is unavailable");
    });
    let observed: AuthProfileCredential | undefined;
    try {
      current.transact(({ db }) => {
        writeAuthProfileJsonCell(db, "store", "agent", store("local"));
        expect(current.read).toThrow();
        deferSqlitePostCommitPublication(db, () => {
          observed = current.read();
        });
      });
    } finally {
      commit.mockRestore();
    }
    expect(observed).toEqual(credential("local"));
    expect(current.read()).toEqual(persistedCredential(database.db, "agent", true));
  });

  it.each(["ordinary", "catalog"] as const)(
    "installs %s worker facts on the absent source before releasing denial",
    (writer) => {
      const current = absentAgentFixture();
      const receipt = {
        ...createSqliteCommitReceipt({
          source: { identity: `file:${current.canonicalPath}`, incarnation: "fixture" },
          domain: "auth-profile-credentials",
          keys: ["store"],
          readFact: () => ({ kind: "postimage" as const, value: store("worker") }),
        }),
        canonicalPath: current.canonicalPath,
      };
      const ordinary =
        writer === "ordinary"
          ? authProfileCredentialPublication.begin({
              identity: receipt.source.identity,
              canonicalPath: receipt.canonicalPath,
              assertCurrent() {},
            })
          : undefined;
      const catalog = ordinary ? undefined : beginAuthProfileCredentialBatch(current.context);
      expect(current.read).toThrow();
      ordinary?.committed(structuredClone(receipt));
      catalog?.committed([structuredClone(receipt)]);
      expect(current.read).toThrow();
      ordinary?.finish(true);
      catalog?.finish(true);
      expect(current.read()).toEqual(credential("worker"));
    },
  );

  it("refuses a catalog receipt overtaken by a native writer on its newly created source", () => {
    const current = absentAgentFixture();
    const batch = beginAuthProfileCredentialBatch(current.context);
    const database = current.transact((owner) => {
      writeAuthProfileJsonCell(owner.db, "store", "agent", store("newer-native"));
      return owner;
    });
    const delayed = authProfileCredentialPublication.bound(
      authProfileCredentialPublication.receipt(
        database.db,
        new Map([["store", { kind: "postimage", value: store("older-catalog") }]]),
      ),
    );
    try {
      batch.committed([structuredClone(delayed)]);
    } finally {
      batch.finish(true);
    }
    current.denied();
    expect(persistedCredential(database.db, "agent", true)).toEqual(credential("newer-native"));
  });
});

it.each(["shared-state", "agent", "absent"] as const)(
  "keeps an unacknowledged native write denied after later commits (%s source)",
  (source) => {
    const current = source === "absent" ? absentAgentFixture() : fixture(source);
    const kind = source === "shared-state" ? source : "agent";
    const database = source === "absent" ? current.transact((owner) => owner) : current.database;
    const nativeDb = requireNativeSqliteDatabase(database.db);
    const restore = failAfterNativeWrite(nativeDb, () => expect(current.read).toThrow());
    try {
      expect(() => writeAuthProfileJsonCell(nativeDb, "store", kind, store("uncertain"))).toThrow(
        "lost native acknowledgement",
      );
    } finally {
      restore();
    }
    if (source !== "absent") {
      expect(current.readPersisted()).toEqual(credential("uncertain"));
    }
    current.denied();
    current.transact(({ db }) => writeAuthProfileJsonCell(db, "store", kind, store("later")));
    if (source !== "absent") {
      expect(current.readPersisted()).toEqual(credential("later"));
    }
    current.denied();
    if (source !== "absent") {
      const cold = current.capture();
      cold.observe(current.readPersisted());
      expectDenied(cold);
    }
  },
);

function useReaderEnvironment(current: Fixture) {
  vi.stubEnv("OPENCLAW_STATE_DIR", current.env.OPENCLAW_STATE_DIR);
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
}

function expectRetainedCustody(databasePath: string, retained = true) {
  const competing = tryAcquireGatewayStateOwner(databasePath);
  try {
    if (retained) {
      expect(competing).toBeNull();
    } else {
      expect(competing).not.toBeNull();
    }
  } finally {
    competing?.release();
  }
}

describe.each(["shared-state", "agent"] as const)("%s released SDK credential writes", (kind) => {
  it.each(
    sdkWriters.flatMap((writer) =>
      (["commit", "rollback"] as const).map((outcome) => ({ writer, outcome })),
    ),
  )("$writer retains offline custody through a confirmed $outcome", ({ writer, outcome }) => {
    const current = fixture(kind);
    const rootPath = current.context.admission.databasePath;
    const marker = resolveGatewayStateOwnerPath(rootPath);
    expect(fs.existsSync(marker)).toBe(false);
    let observed: AuthProfileCredential | undefined;
    withCommit(
      current,
      () => {
        expectRetainedCustody(rootPath);
        current.denied();
        deferSqlitePostCommitPublication(current.database.db, () => {
          observed = current.read();
        });
        if (outcome === "rollback") {
          throw new Error("cancelled SDK commit");
        }
      },
      () => runOutcome(() => current.sdk(writer, "sdk-committed"), outcome, "cancelled SDK commit"),
    );
    expect(observed).toEqual(outcome === "commit" ? credential("sdk-committed") : undefined);
    expect(current.readPersisted()).toEqual(
      credential(outcome === "commit" ? "sdk-committed" : "original"),
    );
    expect(current.read()).toEqual(current.readPersisted());
    expect(fs.existsSync(marker)).toBe(false);
    expectRetainedCustody(rootPath, false);
  });

  it("preserves credential authority throughout an SDK metadata-only save", () => {
    const current = fixture(kind);
    let commits = 0;
    withCommit(
      current,
      () => {
        commits += 1;
        expect(current.read()).toEqual(credential("original"));
      },
      () =>
        current.inSdk(() =>
          saveSdkAuthProfileStore(
            { ...store("original"), ...metadata() },
            current.agentDir,
            saveOptions,
          ),
        ),
    );
    expect(commits).toBe(1);
    expect(current.read()).toEqual(credential("original"));
  });

  it.each(sdkWriters)("%s rejects a live foreign Gateway before mutating credentials", (writer) => {
    const current = fixture(kind);
    const marker = resolveGatewayStateOwnerPath(current.context.admission.databasePath);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(
      marker,
      JSON.stringify({
        pid: process.ppid,
        ownerId: "foreign-sdk-fixture",
        createdAt: new Date().toISOString(),
        configPath: path.join(current.env.OPENCLAW_STATE_DIR, "openclaw.json"),
        role: "gateway",
        processNamespace: readGatewayLockProcessNamespace(),
      }),
      { flag: "wx" },
    );
    try {
      expect(() => current.sdk(writer, "rejected")).toThrow(GatewayStateOwnerContentionError);
    } finally {
      fs.rmSync(marker, { force: true });
    }
    expectCredential(current, "original");
  });

  it.each(sdkWriters)("%s accepts an admitted state-directory alias", (writer) => {
    const stateDir = dirs.make("auth-credential-alias-target-");
    const alias = path.join(dirs.make("auth-credential-alias-"), "state-root");
    fs.symlinkSync(stateDir, alias, process.platform === "win32" ? "junction" : "dir");
    const current = fixture(kind, alias);
    const rootPath = path.join(alias, "state", "openclaw.sqlite");
    expect(current.context.stateIntegrity).toBeDefined();
    expect(rootPath).not.toBe(current.context.stateIntegrity?.identity.canonicalPath);
    withWorker(current.context, () => current.sdk(writer, "sdk-alias"));
    expectCredential(current, "sdk-alias");
  });

  it.each(["missing", "wrong"] as const)(
    "rejects a supplied SDK write with an active worker admission and %s root facts",
    (rootFacts) => {
      const current = fixture(kind);
      const captured = rootFacts === "wrong" ? fixture("shared-state").context : current.context;
      const stateIntegrity = rootFacts === "wrong" ? captured.stateIntegrity : undefined;
      if (rootFacts === "wrong") {
        expect(stateIntegrity).toBeDefined();
      }
      expect(() =>
        withWorker({ ...current.context, stateIntegrity }, () =>
          current.inSdk(() =>
            runSqliteImmediateTransactionSync(current.database.db, () =>
              current.save("unowned", true),
            ),
          ),
        ),
      ).toThrow("credential writes require an admitted worker");
      expectCredential(current, "original");
    },
  );

  it.each(["commit", "rollback"] as const)(
    "retains a supplied SDK connection's custody until the outer managed %s",
    (outcome) => {
      const current = fixture(kind);
      const rootPath = current.context.admission.databasePath;
      let observed: AuthProfileCredential | undefined;
      const runOuterTransaction = (operation: () => void) =>
        kind === "shared-state"
          ? runOpenClawStateWriteTransaction(operation, { env: current.env })
          : runSqliteImmediateTransactionSync(current.database.db, operation);
      const save = () =>
        current.inSdk(() =>
          runOuterTransaction(() => {
            // This observer predates the save; committed facts must still precede every observer.
            deferSqlitePostCommitPublication(current.database.db, () => {
              observed = current.read();
            });
            runSqliteImmediateTransactionSync(current.database.db, () => {
              current.save("supplied", true);
            });
            current.save("latest");
            expectRetainedCustody(rootPath);
            current.denied();
            if (outcome === "rollback") {
              throw new Error("cancelled SDK update");
            }
          }),
        );
      runOutcome(save, outcome, "cancelled SDK update");
      expect(observed).toEqual(outcome === "commit" ? credential("latest") : undefined);
      expectCredential(current, outcome === "commit" ? "latest" : "original");
      expectRetainedCustody(rootPath, false);
    },
  );

  it.each(sdkWriters)(
    "%s retains offline custody after a lost commit acknowledgement",
    (writer) => {
      const current = fixture(kind);
      const rootPath = current.context.admission.databasePath;
      let lease: ReturnType<typeof getStateDatabaseSchemaLease>;
      const exec = current.database.db.exec.bind(current.database.db);
      const commit = vi.spyOn(current.database.db, "exec").mockImplementation((sql) => {
        if (sql === "COMMIT") {
          lease = getStateDatabaseSchemaLease(rootPath);
          expect(lease).toBeDefined();
          expectRetainedCustody(rootPath);
          current.denied();
          exec(sql);
          throw new Error("lost SDK commit acknowledgement");
        }
        return exec(sql);
      });
      try {
        expect(() => current.sdk(writer, "unknown")).toThrow();
        expectRetainedCustody(rootPath);
        expect(lease).toBeDefined();
        expect(() => current.sdk(writer, "must-stay-denied")).toThrow();
        const persisted = lease?.run(() =>
          inspectAuthProfileJsonCellReadOnly(
            { kind, path: current.database.path, env: current.env },
            "store",
          ),
        );
        expect(persisted).toMatchObject({ status: "readable", raw: store("unknown") });
        current.denied();
        const cold = current.capture();
        cold.observe(credential("unknown"));
        expectDenied(cold);
      } finally {
        commit.mockRestore();
        lease?.release();
      }
    },
  );

  it("matches the canonical worker's cold read after both released SDK writers", async () => {
    const current = fixture(kind);
    current.sdk("saveAuthProfileStore", "saved");
    current.sdk("upsertAuthProfile", "upserted");
    const cold = await nativeRuntime.loadAuthProfileStoreForRuntimeAsync(
      current.agentDir,
      { externalCli: { mode: "none" }, inheritedAuthDir: current.agentDir },
      current.env,
    );
    expect(cold.profiles[profileId]).toEqual(credential("upserted"));
    expect(current.read()).toEqual(cold.profiles[profileId]);
  });
});

describe("prepared persisted credential readers", () => {
  it.each(["main-agent", "empty-child", "populated-child", "scoped-child"] as const)(
    "retains scoped credential dependencies through the %s lifecycle",
    async (source) => {
      const isMain = source === "main-agent";
      const shared = fixture(isMain ? "agent" : "shared-state");
      const agentDir =
        shared.agentDir ?? path.join(shared.env.OPENCLAW_STATE_DIR, "agents", "child", "agent");
      const localPath = path.join(agentDir, "openclaw-agent.sqlite");
      if (isMain) {
        noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" }, shared.env);
      } else {
        agentPaths.push(localPath);
      }
      const writeLocal = (key?: string) =>
        runAuthProfileWriteTransaction(
          agentDir,
          ({ db }) =>
            key
              ? writeAuthProfileJsonCell(db, "store", "agent", store(key))
              : deleteAuthProfileJsonCell(db, "store", "agent"),
          { env: shared.env },
        );
      if (source === "populated-child") {
        writeLocal("local-original");
      }
      const scoped = isMain || source === "scoped-child";
      const environment = scoped ? fixture("shared-state") : shared;
      if (scoped) {
        environment.write("ambient");
      }
      useReaderEnvironment(environment);
      const prepare = async () => {
        const retained = await shared.prepareRead(agentDir, store("snapshot-must-not-win"));
        expect(retained?.()).toEqual(
          await nativeRuntime.findPersistedAuthProfileCredentialAsync({ agentDir, profileId }),
        );
        return retained;
      };
      const read = await (scoped
        ? withAuthProfileStoreAgentDir(agentDir, shared.env.OPENCLAW_STATE_DIR, prepare)
        : prepare());
      expect(read?.()).toEqual(
        credential(source === "populated-child" ? "local-original" : "original"),
      );
      writeLocal("local-new");
      expect(read?.()).toEqual(credential("local-new"));
      writeLocal();
      expect(read?.()).toEqual(isMain ? undefined : credential("original"));
      shared.write("shared-new");
      expect(read?.()).toEqual(credential("shared-new"));
      shared.remove();
      expect(read?.()).toBeUndefined();
      if (source === "scoped-child") {
        for (const excluded of [
          { ...credential("private"), copyToAgents: false },
          {
            type: "oauth",
            provider: "fixture",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 3_600_000,
            copyToAgents: true,
          },
        ]) {
          shared.transact(({ db }) =>
            writeAuthProfileJsonCell(db, "store", "shared-state", {
              version: 1,
              profiles: { [profileId]: excluded },
            }),
          );
          expect(read?.()).toBeUndefined();
        }
        shared.write("original");
        writeLocal("scoped-local");
        expect(read?.()).toEqual(credential("scoped-local"));
        shared.remove();
        useReaderEnvironment(shared);
        expect(
          await nativeRuntime.prepareAuthProfileCredentialRead({
            profileId,
            store: store("ephemeral"),
          }),
        ).toBeNull();
        const persisted = await nativeRuntime.prepareAuthProfileCredentialRead({
          profileId,
          store: { ...store("deleted"), runtimePersistedProfileIds: [profileId] },
        });
        expect(persisted).toBeTypeOf("function");
        expect(persisted?.()).toBeUndefined();
      }
      await closeOpenClawAgentDatabaseByPathAsync(localPath);
      expect(() => read?.()).toThrow("authority is unavailable");
    },
  );
});

it.each(["commit", "rollback"])(
  "settles credential facts on a distinct connection anchor after %s",
  (outcome) => {
    const current = fixture("shared-state");
    const connection = createSqlPublicationTestConnection(current.database.db);
    const next = store("anchored");
    const transact = () =>
      current.transact(({ db }) => {
        const captured = authProfileCredentialPublication.capture(db, () => {
          withAuthProfileCredentialWrite(connection, next, () => {
            db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?").run(
              JSON.stringify(next),
              "authProfiles.store",
            );
          });
        });
        expect(captured.receipt.facts.get("store")).toEqual({ kind: "postimage", value: next });
        current.denied();
        if (outcome === "rollback") {
          throw new Error("synthetic rollback");
        }
      });
    runOutcome(transact, outcome, "synthetic rollback");
    expect(current.read()).toEqual(credential(outcome === "commit" ? "anchored" : "original"));
    if (outcome === "commit") {
      expect(current.readPersisted()).toEqual(credential("anchored"));
    }
  },
);

it.each(["commit", "rollback"])(
  "settles machine-state worker credential receipts on the anchor after %s",
  (outcome) => {
    const current = fixture("shared-state");
    const database = openOpenClawStateDatabase({ env: current.env });
    const db = requireNativeSqliteDatabase(database.db);
    const connection = createSqlPublicationTestConnection(db);
    const next = store("worker-anchored");
    const writeInDatabase = machineStateWrites.writeConfigMachineStateInDatabase;
    // Exercise the real writer on SQLite while the worker receives a distinct engine handle.
    const writer = vi
      .spyOn(machineStateWrites, "writeConfigMachineStateInDatabase")
      .mockImplementation((_db, key, value) => writeInDatabase(database.db, key, value));
    const write: WorkerWriteOperationContext["write"] = (operation) =>
      runSqliteImmediateTransactionSync(db, () => {
        const result = operation({ ...database, db: connection });
        if (outcome === "rollback") {
          throw new Error("synthetic rollback");
        }
        return result;
      });
    const { port1, port2 } = new MessageChannel();
    const owner: SqliteWorkerOperationContext = { port: port1 };
    try {
      const transact = () =>
        currentSqliteWorkerOperationAdmission.run({ active: true, port: port1, owner }, () =>
          runWithSqliteWorkerStateContext(current.context, () =>
            machineStateOperations["machineState.write"](
              { key: "authProfiles.store", value: next },
              {
                open: () => database,
                stateOptions: () => ({ path: database.path, env: current.env }),
                write,
                writeAdmitted: write,
              },
            ),
          ),
        );
      if (outcome === "rollback") {
        expect(transact).toThrow("synthetic rollback");
        expect(owner.committed).toBeUndefined();
        expect(current.read()).toEqual(credential("original"));
      } else {
        transact();
        expect(owner.committed).toMatchObject({
          facts: {
            authCredentials: { facts: new Map([["store", { kind: "postimage", value: next }]]) },
          },
        });
        expect(current.read()).toEqual(credential("worker-anchored"));
      }
    } finally {
      writer.mockRestore();
      port1.close();
      port2.close();
    }
  },
);
