import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnershipAsync,
} from "./path-resolve.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { SHARED_AUTH_STORE_STATE_KEY, writeAuthProfileJsonCell } from "./sqlite-json.js";
import {
  prepareAuthProfileWriteTransactionAsync,
  resolveAuthProfileDatabasePath,
} from "./sqlite.js";
import { updateAuthProfileStoreWithLock } from "./store-runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

async function prepareActor(env: NodeJS.ProcessEnv) {
  openOpenClawStateDatabase({ env });
  await workerStore.runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext({ env }),
    (scope) =>
      scope.execute({ type: "authProfiles.sharedOwnership", input: { artifactPreserving: false } }),
  );
}

function interceptBootstrap(intercept: <T>(execute: () => Promise<T>) => Promise<T>) {
  probe.command(workerStore, (command, executeOptions, scope) =>
    command.type === "authProfiles.bootstrap"
      ? intercept(() => scope.execute(command, executeOptions))
      : scope.execute(command, executeOptions),
  );
}

it.each(["missing", "empty", "credentials", "owned"] as const)(
  "prepares the %s legacy auth source without caller-thread SQL",
  async (source) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env, stateDir }) => {
      const sourcePath = resolveAuthProfileDatabasePath(resolveSharedMainAuthAgentDir(env));
      if (source === "empty" || source === "credentials") {
        const database = openOpenClawAgentDatabase({ agentId: "main", path: sourcePath, env });
        if (source === "credentials") {
          writeAuthProfileJsonCell(database.db, "store", "agent", { version: 1, profiles: {} });
        }
      }
      await prepareActor(env);
      if (source === "owned") {
        writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" }, { env });
      }
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
      expect(resolveSharedAuthStoreOwnership(env).location).toBe(expected);
      expect(readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { env })).toEqual(
        source === "credentials" ? undefined : { location: "state-db" },
      );
    });
  },
);

it("holds an empty legacy source against a foreign writer through shared commit admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const sourcePath = resolveAuthProfileDatabasePath(resolveSharedMainAuthAgentDir(env));
    openOpenClawAgentDatabase({ agentId: "main", path: sourcePath, env });
    await prepareActor(env);
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
      await prepareAuthProfileWriteTransactionAsync(undefined, { env });
      expect(blocked).toBe(2);
      expect(readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { env })).toEqual({
        location: "state-db",
      });
      foreign.exec("BEGIN IMMEDIATE; ROLLBACK");
    } finally {
      foreign.close();
    }
  });
});

it("accepts the initial owner binding installed by a concurrent first reader", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    await prepareActor(env);
    const reading = resolveSharedAuthStoreOwnershipAsync(
      captureOpenClawStateWorkerContext({ env }),
    );
    const writing = prepareAuthProfileWriteTransactionAsync(undefined, { env });
    const [observed, prepared] = await Promise.all([reading, writing]);
    expect(observed.location).toBe("legacy-main");
    expect(prepared.sharedOwner.location).toBe("state-db");
    expect(readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { env })).toEqual({
      location: "state-db",
    });
  });
});

it.each([false, true])(
  "fences replacement only for the selected legacy source (sharedOwned=%s)",
  async (sharedOwned) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const sourceDir = resolveSharedMainAuthAgentDir(env);
      const sourcePath = resolveAuthProfileDatabasePath(sourceDir);
      await prepareActor(env);
      if (sharedOwned) {
        writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" }, { env });
      }
      interceptBootstrap((execute) => {
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(sourcePath, "replacement source");
        return execute();
      });
      const prepared = prepareAuthProfileWriteTransactionAsync(undefined, { env });
      if (sharedOwned) {
        expect((await prepared).sharedOwner.location).toBe("state-db");
        expect(readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { env })).toEqual({
          location: "state-db",
        });
      } else {
        await expect(prepared).rejects.toThrow(/identity changed/);
        expect(readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { env })).toBeUndefined();
      }
      expect(fs.readFileSync(sourcePath, "utf8")).toBe("replacement source");
    });
  },
);

it("publishes acknowledged relocation without replay when its result is lost", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    await prepareActor(env);
    let attempts = 0;
    interceptBootstrap(async (execute) => {
      await execute();
      attempts++;
      throw new SqliteWorkerError("Synthetic bootstrap reply loss", "outcome-unknown");
    });
    const prepared = await prepareAuthProfileWriteTransactionAsync(undefined, { env });
    expect(prepared.sharedOwner.location).toBe("state-db");
    expect(attempts).toBe(1);
    expect(readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { env })).toEqual({
      location: "state-db",
    });
  });
});

it.each(["caller", "source"] as const)(
  "publishes committed ownership before refusing a retired %s after the worker reply",
  async (retired) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      await prepareActor(env);
      const sourceDir = resolveSharedMainAuthAgentDir(env);
      const sourcePath = resolveAuthProfileDatabasePath(sourceDir);
      resolveSharedAuthStoreOwnership(env);
      setRuntimeAuthProfileStoreSnapshot({ version: 1, profiles: {} }, sourceDir);
      let revoked = false;
      interceptBootstrap(async (execute) => {
        const result = await execute();
        if (retired === "caller") {
          revoked = true;
        } else {
          fs.mkdirSync(sourceDir, { recursive: true });
          fs.writeFileSync(sourcePath, "replacement after committed relocation");
        }
        return result;
      });
      await expect(
        prepareAuthProfileWriteTransactionAsync(undefined, { env }, () => {
          if (revoked) {
            throw new Error("Synthetic caller retired after commit");
          }
        }),
      ).rejects.toThrow(retired === "caller" ? /caller retired/ : /identity changed/);
      expect(readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { env })).toEqual({
        location: "state-db",
      });
      expect(resolveSharedAuthStoreOwnership(env).location).toBe("state-db");
      const snapshot = getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(sourcePath);
      if (retired === "caller") {
        expect(snapshot?.owner).toMatchObject({ location: "state-db" });
      } else {
        expect(snapshot).toBeUndefined();
        expect(fs.readFileSync(sourcePath, "utf8")).toBe("replacement after committed relocation");
      }
    });
  },
);
