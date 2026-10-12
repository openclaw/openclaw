import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  assertDatabasePathIdentity,
  inspectDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
} from "../../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { reportCommittedInlineAuthFailure } from "./constants.js";
import { resolveLegacyAuthProfileSourceCandidates } from "./legacy-source-files.js";
import {
  getPreparedSharedAuthStoreOwnership,
  noteCommittedSharedAuthStoreOwnership,
  parseSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnershipAsync,
} from "./path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import {
  hasInspectedLegacySharedAuthOwnership,
  isSharedAuthProfileWrite,
  noteInspectedLegacySharedAuthOwnership,
  publishFreshSharedAuthStoreHandoff,
} from "./shared-store-bootstrap.js";
import { watchAuthProfileNativeCommits } from "./store-update-commit.js";
import type { AuthProfileBootstrapResult } from "./store.worker-contract.js";

/** Prepare ownership on the existing actor while the caller retains its accepted write. */
export async function prepareFreshSharedAuthStoreWriteAsync(params: {
  agentDir: string | undefined;
  allowExplicitMain: boolean;
  env: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<boolean> {
  const sharedWrite = isSharedAuthProfileWrite(params);
  const previous = getPreparedSharedAuthStoreOwnership(params.env);
  let retainedOwnership = previous;
  if (
    previous &&
    (!sharedWrite ||
      previous.location === "state-db" ||
      hasInspectedLegacySharedAuthOwnership(previous))
  ) {
    params.assertCurrent?.();
    return sharedWrite;
  }
  const context = captureOpenClawStateWorkerContext({ env: params.env });
  if (!sharedWrite) {
    await resolveSharedAuthStoreOwnershipAsync(context);
    params.assertCurrent?.();
    return false;
  }
  const sourcePath = path.join(resolveSharedMainAuthAgentDir(params.env), "openclaw-agent.sqlite");
  let sourceIdentity: ReturnType<typeof inspectDatabasePathIdentitySync>;
  try {
    sourceIdentity = inspectDatabasePathIdentitySync(sourcePath);
  } catch {
    // Preserve Doctor ownership when the source cannot even be inspected.
  }
  const legacySourcePaths = resolveLegacyAuthProfileSourceCandidates({ env: params.env }).map(
    ({ path: source }) => source,
  );
  const legacySourcesPresent = legacySourcePaths.map((source) => fs.existsSync(source));
  const commits = watchAuthProfileNativeCommits(sourcePath);
  const unchanged = commits.capture();
  const assertBinding = () => {
    const currentOwnership = getPreparedSharedAuthStoreOwnership(params.env);
    // A concurrent first read can install this root's initial binding while we wait.
    retainedOwnership ??= currentOwnership;
    if (currentOwnership !== retainedOwnership) {
      throw new Error("Shared auth source changed during bootstrap");
    }
  };
  const assertSource = () => {
    if (!unchanged()) {
      throw new Error("Shared auth source changed during bootstrap");
    }
    if (sourceIdentity) {
      assertDatabasePathIdentity(sourcePath, sourceIdentity);
    }
    if (
      legacySourcePaths.some(
        (source, index) => fs.existsSync(source) !== legacySourcesPresent[index],
      )
    ) {
      throw new Error("Legacy auth source changed during bootstrap");
    }
  };
  const assertCurrent = () => {
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
    params.assertCurrent?.();
    assertBinding();
  };
  try {
    let acknowledged: AuthProfileBootstrapResult | undefined;
    const result = await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "authProfiles.bootstrap",
          input: { sourcePath, sourceIdentity, legacySourcePaths },
        }),
      {
        assertCurrent,
        createAdmission: () => {
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            assertCurrent();
            if (request.stage === "transaction" || request.stage === "commit") {
              assertSource();
            }
            if (!grant()) {
              throw new Error("Shared auth bootstrap authority expired");
            }
          });
          observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
            if (!isRecord(facts) || typeof facts.relocated !== "boolean") {
              throw new Error("Shared auth bootstrap returned an invalid commit receipt");
            }
            acknowledged = {
              ownership: parseSharedAuthStoreOwnership(facts.ownership),
              relocated: facts.relocated,
            };
          });
          return { nativeLocations: [context.admission.databasePath, sourcePath], admission };
        },
      },
    ).catch((error: unknown) => {
      if (!acknowledged) {
        throw error;
      }
      reportCommittedInlineAuthFailure(
        "Shared auth bootstrap committed before settlement failed",
        error,
      );
      return acknowledged;
    });
    if (result.relocated) {
      (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
      assertBinding();
      let sourceFailure: { error: unknown } | undefined;
      try {
        assertSource();
      } catch (error) {
        sourceFailure = { error };
      }
      // The marker is durable even if the original caller or source has since retired.
      publishFreshSharedAuthStoreHandoff(sourcePath, params.env, !sourceFailure);
      if (sourceFailure) {
        throw sourceFailure.error;
      }
      params.assertCurrent?.();
    } else {
      assertCurrent();
      if (result.ownership.location === "legacy-main") {
        assertSource();
      }
      const ownership =
        retainedOwnership?.location === result.ownership.location
          ? retainedOwnership
          : result.ownership;
      noteCommittedSharedAuthStoreOwnership(ownership, params.env);
      noteInspectedLegacySharedAuthOwnership(ownership);
    }
    return true;
  } finally {
    commits.dispose();
  }
}
