import path from "node:path";
import { constants, type DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSqliteCommitReceipt } from "../../infra/sqlite-commit-receipt.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  authProfileCredentialPublication,
  beginAuthProfileCredentialBatch,
  captureAuthProfileCredentialAuthority,
} from "../../state/user-model-account-authority.js";
import { createExternalAuthRuntime } from "./external-auth.js";
import { coercePersistedAuthProfileStore } from "./persisted-store.js";
import { deleteAuthProfileJsonCell, writeAuthProfileJsonCell } from "./sqlite-json-write.js";
import { readAuthProfileJsonCellText } from "./sqlite-json.js";
import { runAuthProfileWriteTransaction } from "./sqlite.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  createAuthProfileStoreRuntime,
  restoreAuthProfileStorePersistenceSnapshot,
} from "./store.js";
import type { AuthProfileCredential } from "./types.js";

const dirs = createTempDirTracker();
const sharedPaths: string[] = [];
const agentPaths: string[] = [];
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
const nativeRuntime = createAuthProfileStoreRuntime(createExternalAuthRuntime(() => []));
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };

function fixture(kind: "shared-state" | "agent") {
  const stateDir = dirs.make("auth-credential-authority-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
  const shared = openOpenClawStateDatabase({ env });
  sharedPaths.push(shared.path);
  const agentDir = kind === "agent" ? path.join(stateDir, "agents", "fixture", "agent") : undefined;
  const database = runAuthProfileWriteTransaction(
    agentDir,
    (owner) => {
      writeAuthProfileJsonCell(owner.db, "store", kind, store("original"));
      return owner;
    },
    { env },
  );
  if (kind === "agent") {
    agentPaths.push(database.path);
  }
  const context = captureOpenClawStateWorkerContext({ env, path: shared.path });
  const physical = kind === "agent" ? readOpenClawAgentDatabaseIdentity(database) : undefined;
  const identity = physical
    ? `file:${String(physical.identity)}:${physical.birthtime ?? ""}`
    : `${context.admission.identity.key}:${context.admission.identity.birthtime ?? ""}`;
  const capture = () =>
    captureAuthProfileCredentialAuthority(
      context,
      { identity, databasePath: database.path },
      profileId,
    );
  const authority = capture();
  const readPersisted = () => {
    const raw = readAuthProfileJsonCellText(database.db, "store", kind);
    return raw === undefined
      ? undefined
      : coercePersistedAuthProfileStore(JSON.parse(raw))?.profiles[profileId];
  };
  authority.observe(readPersisted());
  const transact = <T>(operation: Parameters<typeof runAuthProfileWriteTransaction<T>>[1]) =>
    runAuthProfileWriteTransaction(agentDir, operation, { env });
  const write = (key: string) =>
    transact(({ db }) => writeAuthProfileJsonCell(db, "store", kind, store(key)));
  return {
    kind,
    env,
    agentDir,
    database,
    context,
    capture,
    authority,
    readPersisted,
    transact,
    write,
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
  return { ...shared, authority, transact, canonicalPath: captured.canonicalPath };
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
  it("denies before native commit and publishes the postimage before commit observers run", () => {
    const current = fixture(kind);
    const commit = observePhysicalCommit(current.database.db, () => {
      expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
    });
    let observed: AuthProfileCredential | undefined;
    try {
      current.transact(({ db }) => {
        writeAuthProfileJsonCell(db, "store", kind, store("committed"));
        expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
        deferSqlitePostCommitPublication(db, () => {
          observed = current.authority.readCurrentCredential();
        });
      });
    } finally {
      commit.mockRestore();
    }
    expect(observed).toEqual(credential("committed"));
    expect(current.readPersisted()).toEqual(credential("committed"));
  });

  it("releases a known rollback with its original credential and rejects an overtaken cold result", () => {
    const current = fixture(kind);
    expect(() =>
      current.transact(({ db }) => {
        writeAuthProfileJsonCell(db, "store", kind, store("rolled-back"));
        expect(() => current.authority.readCurrentCredential()).toThrow();
        throw new Error("cancelled native update");
      }),
    ).toThrow("cancelled native update");
    expect(current.authority.readCurrentCredential()).toEqual(credential("original"));
    expect(current.readPersisted()).toEqual(credential("original"));

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
      writeAuthProfileJsonCell(db, "state", kind, {
        version: 1,
        order: { fixture: [profileId] },
        usageStats: { [profileId]: { lastUsed: 100, cooldownUntil: 200 } },
      });
      expect(current.authority.readCurrentCredential()).toEqual(credential("original"));
      deleteAuthProfileJsonCell(db, "state", kind);
      expect(current.authority.readCurrentCredential()).toEqual(credential("original"));
    });
    expect(current.authority.readCurrentCredential()).toEqual(credential("original"));
  });

  it("publishes deletion and restoration with the same credential semantics as a cold read", () => {
    const current = fixture(kind);
    current.transact(({ db }) => deleteAuthProfileJsonCell(db, "store", kind));
    expect(current.authority.readCurrentCredential()).toBeUndefined();
    expect(current.readPersisted()).toBeUndefined();
    current.write("original");
    expect(current.authority.readCurrentCredential()).toEqual(credential("original"));
    expect(current.authority.readCurrentCredential()).toEqual(current.readPersisted());
  });

  it("keeps an unacknowledged native write denied after a later successful commit", () => {
    const current = fixture(kind);
    const db = current.database.db;
    const restore = failAfterNativeWrite(db, () => {
      expect(() => current.authority.readCurrentCredential()).toThrow();
    });
    try {
      expect(() => writeAuthProfileJsonCell(db, "store", kind, store("uncertain"))).toThrow(
        "lost native acknowledgement",
      );
    } finally {
      restore();
    }
    expect(current.readPersisted()).toEqual(credential("uncertain"));
    expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
    current.write("later");
    expect(current.readPersisted()).toEqual(credential("later"));
    expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
    const cold = current.capture();
    cold.observe(current.readPersisted());
    expect(() => cold.readCurrentCredential()).toThrow("authority is unavailable");
  });

  it("publishes native prepared saves and exact-owned secret rollback through the same authority", () => {
    const current = fixture(kind);
    const baseline = captureAuthProfileStorePersistenceSnapshot(current.agentDir, {
      env: current.env,
    });
    const commit = observePhysicalCommit(current.database.db, () => {
      expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
    });
    try {
      current.transact((database, owner) =>
        nativeRuntime.saveAuthProfileStoreWithPreparedOwner(
          store("applied"),
          current.agentDir,
          saveOptions,
          database,
          owner,
        ),
      );
    } finally {
      commit.mockRestore();
    }
    expect(current.authority.readCurrentCredential()).toEqual(credential("applied"));
    const applied = captureAuthProfileStorePersistenceSnapshot(current.agentDir, {
      env: current.env,
    });
    const rollbackCommit = observePhysicalCommit(current.database.db, () => {
      expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
    });
    try {
      restoreAuthProfileStorePersistenceSnapshot(baseline, applied, current.agentDir);
    } finally {
      rollbackCommit.mockRestore();
    }
    expect(current.authority.readCurrentCredential()).toEqual(credential("original"));
    expect(current.readPersisted()).toEqual(credential("original"));
  });
});

describe("credential authority captured before local database creation", () => {
  it("preserves absence through metadata creation and publishes a native credential before release", () => {
    const current = absentAgentFixture();
    const database = current.transact((owner) => {
      writeAuthProfileJsonCell(owner.db, "state", "agent", { version: 1, order: {} });
      return owner;
    });
    expect(current.authority.readCurrentCredential()).toBeUndefined();
    const commit = observePhysicalCommit(database.db, () => {
      expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
    });
    let observed: AuthProfileCredential | undefined;
    try {
      current.transact(({ db }) => {
        writeAuthProfileJsonCell(db, "store", "agent", store("local"));
        expect(() => current.authority.readCurrentCredential()).toThrow();
        deferSqlitePostCommitPublication(db, () => {
          observed = current.authority.readCurrentCredential();
        });
      });
    } finally {
      commit.mockRestore();
    }
    expect(observed).toEqual(credential("local"));
    const raw = readAuthProfileJsonCellText(database.db, "store", "agent");
    expect(current.authority.readCurrentCredential()).toEqual(
      coercePersistedAuthProfileStore(JSON.parse(raw!))?.profiles[profileId],
    );
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
      expect(() => current.authority.readCurrentCredential()).toThrow();
      ordinary?.committed(structuredClone(receipt));
      catalog?.committed([structuredClone(receipt)]);
      expect(() => current.authority.readCurrentCredential()).toThrow();
      ordinary?.finish(true);
      catalog?.finish(true);
      expect(current.authority.readCurrentCredential()).toEqual(credential("worker"));
    },
  );

  it("keeps an unknown native outcome denied on the captured absent source", () => {
    const current = absentAgentFixture();
    const database = current.transact((owner) => owner);
    const restore = failAfterNativeWrite(database.db, () => {
      expect(() => current.authority.readCurrentCredential()).toThrow();
    });
    try {
      expect(() =>
        writeAuthProfileJsonCell(database.db, "store", "agent", store("unknown")),
      ).toThrow("lost native acknowledgement");
    } finally {
      restore();
    }
    expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
    current.transact(({ db }) => writeAuthProfileJsonCell(db, "store", "agent", store("later")));
    expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
  });

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
    expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
    const raw = readAuthProfileJsonCellText(database.db, "store", "agent");
    expect(coercePersistedAuthProfileStore(JSON.parse(raw!))?.profiles[profileId]).toEqual(
      credential("newer-native"),
    );
  });
});
