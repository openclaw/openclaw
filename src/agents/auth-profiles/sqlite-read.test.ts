import fs from "node:fs";
import path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { toErrorObject } from "../../infra/errors.js";
import { inspectDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as resources from "../../state/openclaw-agent-db-resources.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { openTrackedStateDatabase } from "../../state/openclaw-state-db-handle.js";
import * as rootContext from "../../state/openclaw-state-worker-context.js";
import * as sharedWorker from "../../state/openclaw-state-worker-store.js";
import { authProfileFileChanges } from "./file-state.js";
import { runtimeAuthProfileRowsCache } from "./runtime-persisted-rows.js";
import { noteRuntimeAuthProfileStorePersistedMutation } from "./runtime-snapshots.js";
import { writeAuthProfileJsonCell } from "./sqlite-json-write.js";
import { prepareAgentAuthProfileRowsRead, readSharedAuthProfileRows } from "./sqlite-read.js";
import { sendAuthProfileUpdateValue } from "./store-update-transfer.js";
import type { AuthProfileRowRead, AuthProfileStore } from "./types.js";

const child = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../infra/sqlite-readonly-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/sqlite-readonly-worker.js")>()),
  runSqliteReadOnlyWorker: child.read,
}));

const rows: AuthProfileRowRead = {
  store: { status: "readable", raw: { version: 1, profiles: {} } },
  state: { status: "missing", reason: "row" },
  cacheable: true,
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let databasePath: string;
let rootCurrent: boolean;
const readers = new Set<ReturnType<typeof prepareAgentAuthProfileRowsRead>>();
const publishFileChange = authProfileFileChanges.onChange;
function prepare(env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/fixture" }) {
  const reader = prepareAgentAuthProfileRowsRead({ databasePath, agentId: "main", env });
  readers.add(reader);
  return reader;
}

async function changeDatabase(write: () => void) {
  const changed = new Promise<void>((resolve) => {
    authProfileFileChanges.onChange = async (change) => {
      await publishFileChange?.(change);
      if (change.directory === path.dirname(databasePath)) {
        authProfileFileChanges.onChange = publishFileChange;
        resolve();
      }
    };
  });
  write();
  await vi.advanceTimersByTimeAsync(30_000);
  await changed;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  rootCurrent = true;
  databasePath = path.join(tempDirs.make("auth-row-identity-"), "auth.sqlite");
  fs.writeFileSync(databasePath, "synthetic auth database");
  vi.spyOn(rootContext, "captureOpenClawStateWorkerContext").mockReturnValue({
    environment: { OPENCLAW_STATE_DIR: "/fixture" },
    admission: {
      coordinationKey: "file:root",
      databasePath: "/fixture/state.sqlite",
      identity: { key: "file:root", canonicalPath: "/fixture/state.sqlite" },
      assertCurrent: () => {
        if (!rootCurrent) {
          throw new Error("Shared auth owner was revoked");
        }
      },
    },
  });
  child.read.mockReset().mockResolvedValue(rows);
});

afterEach(async () => {
  authProfileFileChanges.onChange = publishFileChange;
  await Promise.all([...readers].map((reader) => reader.dispose()));
  readers.clear();
  await closeOpenClawStateDatabaseAsync();
  runtimeAuthProfileRowsCache.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("prepared auth profile row reads", () => {
  it.each(["agent", "shared"] as const)(
    "reuses %s rows and installs an owner write without another worker request",
    async (source) => {
      const isAgent = source === "agent";
      const kind = isAgent ? "agent" : "shared-state";
      fs.unlinkSync(databasePath);
      using database = openTrackedStateDatabase(databasePath);
      database.exec(
        "CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER);" +
          "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)",
      );
      const identity = expectDefined(inspectDatabasePathIdentitySync(databasePath), "identity");
      const context = rootContext.captureOpenClawStateWorkerContext();
      context.admission = { ...context.admission, databasePath, identity };
      const sharedRead = vi
        .spyOn(sharedWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation(async (_context, operation, options) => {
          const { admission } = expectDefined(
            options?.createAdmission?.({ settled: Promise.resolve({ kind: "completed" }) }),
            "shared auth read admission",
          );
          const { port1: sender, port2: receiver } = new MessageChannel();
          try {
            return await operation({
              execute: async () => {
                sendAuthProfileUpdateValue(sender, { [databasePath]: rows });
                admission.port.postMessage(
                  {
                    stage: "prepare",
                    facts: { kind: "auth-sources-read", port: receiver },
                    decision: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
                  },
                  [receiver],
                );
                admission.service();
                if (admission.failure) {
                  throw toErrorObject(admission.failure, "Auth read admission failed");
                }
              },
            });
          } finally {
            admission.finish();
            sender.close();
            receiver.close();
          }
        });
      const agentReader = isAgent ? prepare() : undefined;
      const read = () => (agentReader ? agentReader.read() : readSharedAuthProfileRows(context));
      const workerRead = isAgent ? child.read : sharedRead;
      await expect(read()).resolves.toEqual(rows);
      await expect(read()).resolves.toEqual(rows);
      expect(workerRead).toHaveBeenCalledOnce();

      const committed: AuthProfileStore = {
        version: 1,
        profiles: { fixture: { type: "api_key", provider: "fixture", key: "updated-fixture" } },
      };
      writeAuthProfileJsonCell(database, "store", kind, committed);
      noteRuntimeAuthProfileStorePersistedMutation(
        isAgent ? path.dirname(databasePath) : undefined,
        {
          credentialsChanged: true,
          profileSetChanged: true,
          stateChanged: false,
          profileIds: ["fixture"],
        },
        {
          databasePath,
          sharedDatabasePath: databasePath,
          location: isAgent ? "legacy-main" : "state-db",
        },
        undefined,
        { store: committed, env: context.environment },
      );
      await expect(read()).resolves.toMatchObject({
        store: { status: "readable", raw: committed },
      });
      expect(workerRead).toHaveBeenCalledOnce();
      rootCurrent = false;
      await expect(read()).rejects.toThrow("Shared auth owner was revoked");
      expect(workerRead).toHaveBeenCalledOnce();
    },
  );

  it("retains revocable read authority even when persisted rows come from a cache", async () => {
    const reader = prepare();
    reader.assertCurrent();
    expect(resources.hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
    await Promise.all(resources.revokeAgentDatabaseResources({ path: databasePath }));
    expect(() => reader.assertCurrent()).toThrow("Auth profile read owner was revoked");
    expect(child.read).not.toHaveBeenCalled();
  });
  it("rejects rows whose source identity changed before the child settled", async () => {
    const reader = prepare();
    child.read.mockImplementation(async () => {
      await changeDatabase(() => {
        const replacement = `${databasePath}.replacement`;
        fs.writeFileSync(replacement, "replacement auth database");
        fs.renameSync(replacement, databasePath);
      });
      return rows;
    });
    await expect(reader.read()).rejects.toThrow("database file identity changed");
  });

  it("rejects rows when shared owner authority changes while the child reads", async () => {
    const reader = prepare();
    child.read.mockImplementation(async () => {
      rootCurrent = false;
      return rows;
    });
    await expect(reader.read()).rejects.toThrow("Shared auth owner was revoked");
  });

  it("retains captured absence when the first session creates its database", async () => {
    fs.unlinkSync(databasePath);
    const reader = prepare();
    await changeDatabase(() => fs.writeFileSync(databasePath, "created auth database"));
    await expect(reader.read()).resolves.toEqual({
      store: { status: "missing", reason: "database" },
      state: { status: "missing", reason: "database" },
      cacheable: false,
    });
    await reader.dispose();
    expect(() => reader.assertCurrent()).not.toThrow();
    expect(child.read).not.toHaveBeenCalled();
    await expect(prepare().read()).resolves.toEqual(rows);
    expect(child.read).toHaveBeenCalledWith(
      databasePath,
      expect.objectContaining({ expectedIdentity: expect.stringMatching(/^file:/) }),
    );
  });

  it("captures environment and retains the agent owner through child settlement", async () => {
    const registration = vi.spyOn(resources, "registerOpenClawAgentDatabaseAsyncResource");
    const env = { OPENCLAW_STATE_DIR: "/fixture/original" };
    const reader = prepare(env);
    env.OPENCLAW_STATE_DIR = "/fixture/replaced";
    const entered = createDeferredCore();
    const release = createDeferredCore<AuthProfileRowRead>();
    child.read.mockImplementation(async () => {
      entered.resolve();
      return release.promise;
    });
    const reading = reader.read();
    let disposed = false;
    let closing: Promise<void> | undefined;
    try {
      await Promise.race([
        entered.promise,
        reading.then(() => {
          throw new Error("Child was not entered");
        }),
      ]);
      expect(registration).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", path: databasePath }),
      );
      expect(child.read).toHaveBeenCalledWith(
        databasePath,
        expect.objectContaining({
          mode: "auth-profile-rows",
          source: "canonical",
          expectedIdentity: expect.stringMatching(/^file:/),
          env: { OPENCLAW_STATE_DIR: "/fixture/original" },
        }),
      );
      closing = reader.dispose().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);
      release.resolve(rows);
      await expect(reading).rejects.toThrow("Auth profile read owner closed");
      await closing;
      expect(disposed).toBe(true);
    } finally {
      release.resolve(rows);
      await Promise.allSettled([reading, closing ?? reader.dispose()]);
    }
  });

  it("keeps captured authority checkable after ordinary disposal but rejects new reads", async () => {
    const reader = prepare();
    await expect(reader.read()).resolves.toEqual(rows);
    await reader.dispose();
    expect(() => reader.assertCurrent()).not.toThrow();
    await expect(reader.read()).rejects.toThrow("Auth profile read owner closed");
  });
});
