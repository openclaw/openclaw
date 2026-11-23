import assert from "node:assert/strict";
import { once } from "node:events";
import { realpathSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";

export async function runPerfSqliteWorker(entryUrl: URL, argv: string[]): Promise<void> {
  const worker = new Worker(entryUrl, { argv });
  let relay:
    | ReturnType<
        typeof import("../../src/infra/sqlite-worker-operation-admission.js").createSqliteDatabaseAdmissionRelay
      >
    | undefined;
  try {
    const exited = new Promise<number>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", resolve);
    });
    const admitted = (async () => {
      const [storePath] = await once(worker, "message");
      const {
        prepareOwnedSqliteDatabaseAdmission,
        captureSqliteDatabaseAdmissions,
        trackSqliteDatabaseAdmissionWorker,
      } = await import("../../src/infra/sqlite-database-admission.js");
      const { createSqliteDatabaseAdmissionRelay } =
        await import("../../src/infra/sqlite-worker-operation-admission.js");
      const { readDatabaseIdentityBirthtime } =
        await import("../../src/infra/sqlite-worker-identity.js");
      const location = realpathSync.native(storePath);
      const file = statSync(location, { bigint: true });
      await prepareOwnedSqliteDatabaseAdmission({
        location,
        expectedIdentity: {
          key: `file:${file.dev}:${file.ino}`,
          birthtime: readDatabaseIdentityBirthtime(file),
        },
        assertCurrent() {},
      });
      const record = captureSqliteDatabaseAdmissions().find((entry) => entry.location === location);
      assert(record);
      relay = createSqliteDatabaseAdmissionRelay(() => {});
      relay.bindDatabaseAuthority({
        databasePath: record.location,
        databaseIdentity: { ...record.physicalIdentity, databasePath: record.location },
        assertAccess() {},
        acquireSchema() {
          throw new Error("Synthetic reader must not acquire schema custody");
        },
      });
      trackSqliteDatabaseAdmissionWorker(worker);
      worker.postMessage(relay.port, [relay.port]);
    })();
    const [code] = await Promise.all([exited, admitted]);
    process.exitCode = code;
  } finally {
    await relay?.finish();
  }
}
