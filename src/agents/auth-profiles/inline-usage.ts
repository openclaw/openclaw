import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecutionAsync } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
  type OpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import { authProfilesLog, reportCommittedInlineAuthFailure } from "./constants.js";
import type {
  InlineAuthFailureInput,
  InlineAuthFailureOperations,
  InlineAuthFailureReceipt,
} from "./inline-usage-kernel.js";
import { publishInlineAuthFailure } from "./inline-usage-publication.js";
import {
  assertAuthProfileMigrationCandidates,
  assertAuthProfileMigrationStateAtDatabasePath,
} from "./legacy-source-diagnostic.js";
import { resolveLegacyAuthProfileSourceCandidates } from "./legacy-source-files.js";
import { withAuthProfileCleanup } from "./operation-cleanup.js";
import { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } from "./path-resolve.js";
import { invalidateRuntimeAuthProfileStoreSnapshotsForOwner } from "./runtime-snapshots.js";
import { loadPersistedAuthProfileStoreFromRows } from "./sqlite-read.js";
import {
  prepareAuthProfileWriteTransactionAsync,
  prepareAuthProfileWriteEnvironment,
  resolveAuthProfileDatabasePath,
  resolveAuthProfileDatabaseOwnerId,
} from "./sqlite.js";
import {
  getScopedAuthProfileEnv,
  getScopedSharedAuthStore,
  resolveRuntimeAuthProfileAgentDir,
} from "./store.js";
import { reserveAuthProfileUsagePreparation, runAuthProfileUsage } from "./usage-lifecycle.js";

function inlineAuthFailureError(payload: OpenClawStateWorkerErrorPayload): Error {
  const error = new Error("Auth usage transaction failed");
  retainOpenClawStateWorkerErrorPayload(error, payload);
  return hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
}

/** The retry controller's inline failure belongs to its explicit agent database. */
export async function persistInlineAuthFailure(
  agentDir: string,
  input: Omit<InlineAuthFailureInput, "expectedCredentials" | "inheritedUsageStats">,
): Promise<InlineAuthFailureReceipt | null> {
  const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
  const env = prepareAuthProfileWriteEnvironment({ env: getScopedAuthProfileEnv() });
  if (!effectiveAgentDir) {
    throw new Error("Inline auth failure requires its selected agent directory");
  }
  const databasePath = resolveAuthProfileDatabasePath(effectiveAgentDir);
  return runAuthProfileUsage(async () => {
    const captured = captureOpenClawAgentDatabaseExecutionAsync({
      path: databasePath,
      agentId: resolveAuthProfileDatabaseOwnerId(effectiveAgentDir),
      env,
    }).then(
      (value) => ({ ok: true, value }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    const inheritedUsageStats = structuredClone(getScopedSharedAuthStore()?.usageStats);
    let transferred = false;
    const reservation = reserveAuthProfileUsagePreparation([
      resolveOpenClawStateSqlitePath(env),
      databasePath,
    ]);
    try {
      await reservation.ready;
      const result = await captured;
      if (!result.ok) {
        throw result.error;
      }
      const execution = result.value;
      const prepared = await prepareAuthProfileWriteTransactionAsync(
        effectiveAgentDir,
        { env },
        () => execution.assertCurrent(),
      );
      transferred = true;
      return await persistPreparedInlineAuthFailure(
        effectiveAgentDir,
        input,
        prepared,
        execution,
        inheritedUsageStats,
      );
    } finally {
      try {
        const result = await captured;
        if (!transferred && result.ok) {
          await result.value.release();
        }
      } finally {
        reservation.release();
      }
    }
  });
}

async function persistPreparedInlineAuthFailure(
  effectiveAgentDir: string | undefined,
  input: Omit<InlineAuthFailureInput, "expectedCredentials" | "inheritedUsageStats">,
  prepared: Awaited<ReturnType<typeof prepareAuthProfileWriteTransactionAsync>>,
  execution: OpenClawAgentDatabaseExecution,
  inheritedUsageStats: InlineAuthFailureInput["inheritedUsageStats"],
): Promise<InlineAuthFailureReceipt | null> {
  const { databaseTarget, sharedOwner } = prepared;
  if (databaseTarget.kind !== "agent") {
    throw new Error("Inline auth failure requires its selected agent database");
  }
  const owner = {
    ...sharedOwner,
    databasePath: databaseTarget.path,
    get databaseIdentity() {
      return execution.fileIdentity;
    },
  };
  const candidates = resolveLegacyAuthProfileSourceCandidates({
    agentDir: effectiveAgentDir,
    env: owner.env,
  });
  let durableReceipt: InlineAuthFailureReceipt | undefined;
  let failure: { error: unknown } | undefined;
  let hasCredentials: boolean | undefined;
  const assertCurrent = () => {
    execution.assertCurrent();
    if (
      resolveSharedAuthStorePath(owner.env) !== owner.sharedDatabasePath ||
      resolveSharedAuthStoreOwnership(owner.env).location !== owner.location
    ) {
      throw new Error("Auth profile shared owner changed before write admission");
    }
    assertAuthProfileMigrationStateAtDatabasePath(owner.databasePath);
    if (hasCredentials !== undefined) {
      assertAuthProfileMigrationCandidates({
        databasePath: owner.databasePath,
        candidates,
        hasCredentials: () => hasCredentials === true,
      });
    }
  };
  const runWithAdmission = async (): Promise<InlineAuthFailureReceipt | null> => {
    try {
      return await runOpenClawAgentWriteAdmission(
        databaseTarget,
        async () => {
          const client = await openOpenClawAgentSqliteWorkerStore<InlineAuthFailureOperations>(
            databaseTarget,
            { execution },
            {
              moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.authProfileInlineUsage),
              input: {},
            },
          );
          const executionResult = await withAuthProfileCleanup(
            () =>
              client.run(async (scope) => {
                const readTarget = () =>
                  scope.execute({ type: "authProfiles.inlineSnapshot", input: undefined });
                const rows = await readTarget();
                const store = loadPersistedAuthProfileStoreFromRows(rows, owner.databasePath);
                hasCredentials = Object.keys(store?.profiles ?? {}).length > 0;
                assertCurrent();
                const result = await scope.execute({
                  type: "authProfiles.inlineFailure",
                  input: {
                    ...input,
                    inheritedUsageStats,
                    expectedCredentials: rows.store.status === "readable" ? rows.store.raw : null,
                  },
                });
                if (!result.ok) {
                  return result;
                }
                const { receipt } = result;
                durableReceipt = receipt;
                // Publication failure cannot turn a known commit into a retryable failed write.
                try {
                  await publishInlineAuthFailure(owner, receipt, readTarget, assertCurrent);
                } catch (error) {
                  invalidateRuntimeAuthProfileStoreSnapshotsForOwner(owner);
                  reportCommittedInlineAuthFailure(
                    "auth usage committed but publication failed",
                    error,
                  );
                }
                return result;
              }, assertCurrent),
            async (outcome) => {
              try {
                await client.close();
              } catch (cleanupError) {
                if (!outcome.ok) {
                  throw new AggregateError(
                    [outcome.error, cleanupError],
                    "Auth usage and owner cleanup failed",
                    { cause: cleanupError },
                  );
                }
                if (!outcome.value.ok) {
                  throw new AggregateError(
                    [inlineAuthFailureError(outcome.value.error), cleanupError],
                    "Auth usage refusal and owner cleanup failed",
                    { cause: cleanupError },
                  );
                }
                reportCommittedInlineAuthFailure(
                  "auth usage committed before owner cleanup failed",
                  cleanupError,
                );
              }
            },
          );
          if (!executionResult.ok) {
            throw inlineAuthFailureError(executionResult.error);
          }
          return executionResult.receipt;
        },
        true,
      );
    } catch (error) {
      if (durableReceipt) {
        // Retirement cannot prevent invalidation of a completed write's derived views.
        invalidateRuntimeAuthProfileStoreSnapshotsForOwner(owner);
        reportCommittedInlineAuthFailure(
          "auth usage committed before publication or cleanup failed",
          error,
        );
        return durableReceipt;
      }
      failure = { error };
      const message = error instanceof Error ? error.message : String(error);
      authProfilesLog.warn(`auth profile store update failed: ${message}`, {
        agentDir: effectiveAgentDir,
        error: message,
      });
      if (!isSqliteLockError(error)) {
        throw error;
      }
      return null;
    }
  };
  return withAuthProfileCleanup(runWithAdmission, async () => {
    try {
      await execution.release();
    } catch (error) {
      if (durableReceipt) {
        reportCommittedInlineAuthFailure(
          "auth usage committed before captured owner release failed",
          error,
        );
      } else if (failure) {
        throw createSqliteLifecycleAggregateError(
          [failure.error, error],
          "Auth usage and captured owner release failed",
          failure.error,
        );
      } else {
        throw error;
      }
    }
  });
}
