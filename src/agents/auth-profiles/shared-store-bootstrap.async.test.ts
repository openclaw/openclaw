import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { aroundEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as paths from "./path-resolve.js";
import * as snapshots from "./runtime-snapshots.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { writeAuthProfileJsonCell } from "./sqlite-json-write.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "./sqlite-json.js";
import * as sqlite from "./sqlite.js";
import { updateAuthProfileStoreWithLock } from "./store-runtime.js";

const committedOwner = { location: "state-db" } as const;

let env: NodeJS.ProcessEnv;
let stateDir: string;
let sourceDir: string;
let sourcePath: string;
aroundEach(async (runTest) => {
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      ({ env, stateDir } = state);
      sourceDir = resolveSharedMainAuthAgentDir(env);
      sourcePath = sqlite.resolveAuthProfileDatabasePath(sourceDir);
      await runTest();
    });
  } finally {
    vi.restoreAllMocks();
    snapshots.clearRuntimeAuthProfileStoreSnapshots();
  }
});
const prepare = (assertCurrent?: () => void) =>
  sqlite.prepareAuthProfileWriteTransactionAsync(undefined, { env }, assertCurrent);
const ownership = () => readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { env });

async function prepareActor() {
  openOpenClawStateDatabase({ env });
  await workerStore.runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext({ env }),
    async () => undefined,
  );
}

function interceptBootstrap(intercept: <T>(execute: () => Promise<T>) => Promise<T>) {
  probe.command(workerStore, (command, executeOptions, scope) =>
    command.type === "authProfiles.bootstrap"
      ? intercept(() => scope.execute(command, executeOptions))
      : scope.execute(command, executeOptions),
  );
}

it.each(["missing", "credentials"] as const)(
  "prepares the %s legacy auth source without caller-thread SQL",
  async (source) => {
    if (source === "credentials") {
      const database = openOpenClawAgentDatabase({ agentId: "main", path: sourcePath, env });
      writeAuthProfileJsonCell(database.db, "store", "agent", { version: 1, profiles: {} });
    }
    await prepareActor();
    const sql = observeHostDataSql();
    try {
      expect(
        await updateAuthProfileStoreWithLock({ stateDir, updater: () => false }),
      ).not.toBeNull();
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    const expected = source === "credentials" ? "legacy-main" : "state-db";
    expect(paths.resolveSharedAuthStoreOwnership(env).location).toBe(expected);
    expect(ownership()).toEqual(source === "credentials" ? undefined : { location: "state-db" });
  },
);

it("holds an empty legacy source against a foreign writer through shared commit admission", async () => {
  openOpenClawAgentDatabase({ agentId: "main", path: sourcePath, env });
  await prepareActor();
  const foreign = new DatabaseSync(sourcePath);
  let blocked = 0;
  probe.admission(admission, (request, grant, admit) => {
    if (request.stage === "transaction" || request.stage === "commit") {
      expect(() => foreign.exec("BEGIN IMMEDIATE")).toThrow(/locked/i);
      blocked++;
    }
    admit(request, grant);
  });
  try {
    await prepare();
    expect(blocked).toBe(2);
    expect(ownership()).toEqual(committedOwner);
    foreign.exec("BEGIN IMMEDIATE; ROLLBACK");
  } finally {
    foreign.close();
  }
});

it("fences replacement of the selected legacy source", async () => {
  await prepareActor();
  interceptBootstrap((execute) => {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, "replacement source");
    return execute();
  });
  const prepared = prepare();
  await expect(prepared).rejects.toThrow(/identity changed/);
  expect(ownership()).toBeUndefined();
  expect(fs.readFileSync(sourcePath, "utf8")).toBe("replacement source");
});

it.each(["reply", "caller", "source"] as const)(
  "publishes committed ownership despite a lost %s after the worker reply",
  async (lost) => {
    await prepareActor();
    if (lost !== "reply") {
      await paths.resolveSharedAuthStoreOwnershipAsync(captureOpenClawStateWorkerContext({ env }));
      snapshots.setRuntimeAuthProfileStoreSnapshot({ version: 1, profiles: {} }, sourceDir);
    }
    let revoked = false;
    let attempts = 0;
    interceptBootstrap(async (execute) => {
      const result = await execute();
      attempts++;
      if (lost === "reply") {
        throw new SqliteWorkerError("Synthetic bootstrap reply loss", "outcome-unknown");
      }
      if (lost === "caller") {
        revoked = true;
      } else {
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(sourcePath, "replacement after committed relocation");
      }
      return result;
    });
    const prepared = prepare(() => {
      if (revoked) {
        throw new Error("Synthetic caller retired after commit");
      }
    });
    if (lost === "reply") {
      expect((await prepared).sharedOwner.location).toBe("state-db");
      expect(attempts).toBe(1);
    } else {
      await expect(prepared).rejects.toThrow(
        lost === "caller" ? /caller retired/ : /identity changed/,
      );
      expect(paths.resolveSharedAuthStoreOwnership(env).location).toBe("state-db");
      const snapshot = snapshots.getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(sourcePath);
      if (lost === "caller") {
        expect(snapshot?.owner).toMatchObject({ location: "state-db" });
      } else {
        expect(snapshot).toBeUndefined();
        expect(fs.readFileSync(sourcePath, "utf8")).toBe("replacement after committed relocation");
      }
    }
    expect(ownership()).toEqual(committedOwner);
  },
);
