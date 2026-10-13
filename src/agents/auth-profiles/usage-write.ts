import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { Result } from "@openclaw/normalization-core/result";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { resolveProviderAuthAliasMap } from "../provider-auth-aliases.js";
import { AUTH_STORE_VERSION, reportCommittedInlineAuthFailure } from "./constants.js";
import type { InlineAuthFailureOperations } from "./inline-usage-kernel.js";
import { publishInlineAuthFailure } from "./inline-usage-publication.js";
import {
  assertAuthProfileMigrationCandidates,
  assertAuthProfileMigrationStateAtDatabasePath,
} from "./legacy-source-diagnostic.js";
import { resolveLegacyAuthProfileSourceCandidates } from "./legacy-source-files.js";
import { getRuntimeAuthProfileStoreCredentialMutationToken } from "./mutation-lineage.js";
import { withAuthProfileCleanup } from "./operation-cleanup.js";
import { shouldUseMainOwnerForLocalOAuthCredential } from "./ownership.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnershipAsync,
} from "./path-resolve.js";
import { mergeAuthProfileStores } from "./persisted.js";
import { authProfileRuntimeMode } from "./runtime-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  listRuntimeAuthProfileStoreSnapshotsForSharedOwner,
} from "./runtime-snapshots.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
  readSharedAuthProfileRows,
} from "./sqlite-read.js";
import { resolveAuthProfileDatabaseOwnerId, resolveAuthProfileDatabasePath } from "./sqlite.js";
import { getScopedAuthProfileEnv, resolveRuntimeAuthProfileAgentDir } from "./store.js";
import {
  createAuthProfileUsageReceipt,
  type AuthProfileUsageInput,
  type AuthProfileUsageReceipt,
  type AuthProfileUsageResult,
} from "./store.worker-contract.js";
import type { AuthProfileRowRead, AuthProfileStore } from "./types.js";
import {
  reserveAuthProfileUsagePreparation,
  reserveAuthProfileUsageWrite,
} from "./usage-lifecycle.js";
import type { PersonalAuthProfileUsageReduction } from "./usage-reduction.js";

/** Capture every possible physical owner before choosing inherited ownership asynchronously. */
export async function withAuthProfileUsage<T>(
  store: AuthProfileStore,
  profileId: string,
  agentDir: string | undefined,
  consume: (usage: {
    observed: AuthProfileStore;
    record: (
      reduction: PersonalAuthProfileUsageReduction,
      providerKey?: string,
    ) => Promise<AuthProfileUsageReceipt | null>;
  }) => Promise<T>,
): Promise<T> {
  const mode = authProfileRuntimeMode.getStore();
  if (mode?.kind === "env-only") {
    const observed: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
    return consume({
      observed,
      record: async () => createAuthProfileUsageReceipt(observed),
    });
  }
  const scopedSharedStore = mode && structuredClone(mode.sharedStore);
  const env = cloneEnvWithPlatformSemantics(getScopedAuthProfileEnv() ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const selectedDir = resolveRuntimeAuthProfileAgentDir(agentDir);
  const context = captureOpenClawStateWorkerContext({ env });
  const localPath = selectedDir ? resolveAuthProfileDatabasePath(selectedDir) : undefined;
  const legacyPath = resolveAuthProfileDatabasePath(resolveSharedMainAuthAgentDir(env));
  const readers = new Map<string, ReturnType<typeof prepareAgentAuthProfileRowsRead>>();
  const executions = new Map<
    string,
    Result<ReturnType<typeof captureOpenClawAgentDatabaseExecution>, unknown>
  >();
  const writers = new Map<
    string,
    ReturnType<typeof reserveAuthProfileUsageWrite<AuthProfileUsageReceipt | null>>
  >();
  const credentialToken = (databasePath: string) =>
    getRuntimeAuthProfileStoreCredentialMutationToken(undefined, profileId, {
      owner: { kind: "resolved", databasePath, sharedDatabasePath: databasePath },
    });
  const credentialTokens = new Map(
    [
      ...new Set([context.admission.databasePath, legacyPath, ...(localPath ? [localPath] : [])]),
    ].map((databasePath) => [databasePath, credentialToken(databasePath)]),
  );
  let preparation: ReturnType<typeof reserveAuthProfileUsagePreparation> | undefined;
  let committed: AuthProfileUsageReceipt | undefined;
  const executeUsage = async (): Promise<T> => {
    for (const databasePath of new Set([
      ...(mode ? [] : [legacyPath]),
      ...(localPath ? [localPath] : []),
    ])) {
      const target = {
        path: databasePath,
        agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(databasePath)),
        env,
      };
      readers.set(
        databasePath,
        prepareAgentAuthProfileRowsRead({
          databasePath,
          agentId: target.agentId,
          env,
        }),
      );
      try {
        executions.set(databasePath, {
          ok: true,
          value: captureOpenClawAgentDatabaseExecution(target),
        });
      } catch (error) {
        executions.set(databasePath, { ok: false, error });
      }
      writers.set(databasePath, reserveAuthProfileUsageWrite(target));
    }
    preparation = reserveAuthProfileUsagePreparation(
      [
        context.admission.identity,
        ...[...readers.keys()].map((pathname) => readDatabasePathIdentitySync(pathname)),
      ].flatMap((identity) => [identity.key, `path:${identity.canonicalPath}`]),
    );
    const capturedOwnership = resolveSharedAuthStoreOwnershipAsync(context).then(
      (value) => ({ ok: true, value }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    await preparation.ready;
    const ownershipResult = await capturedOwnership;
    if (!ownershipResult.ok) {
      throw ownershipResult.error;
    }
    const ownership = ownershipResult.value;
    const sharedPath =
      ownership.location === "state-db" ? context.admission.databasePath : legacyPath;
    const main = Boolean(mode) || !selectedDir || localPath === sharedPath;
    const read = (databasePath: string) =>
      databasePath === context.admission.databasePath
        ? readSharedAuthProfileRows(context)
        : readers.get(databasePath)!.read();
    const localRows = localPath ? await read(localPath) : undefined;
    const sharedRows = mode
      ? undefined
      : localPath === sharedPath
        ? localRows!
        : await read(sharedPath);
    const local = localRows ? loadPersistedAuthProfileStoreFromRows(localRows, localPath!) : null;
    const shared = sharedRows
      ? loadPersistedAuthProfileStoreFromRows(sharedRows, sharedPath)
      : null;
    const localProfile = local?.profiles[profileId];
    const sharedProfile = shared?.profiles[profileId];
    const useShared =
      !mode &&
      (main ||
        !selectedDir ||
        (localProfile
          ? shouldUseMainOwnerForLocalOAuthCredential({
              profileId,
              local: localProfile,
              main: sharedProfile,
            })
          : Boolean(sharedProfile)));
    const databasePath = useShared ? sharedPath : localPath!;
    for (const [candidate, writer] of writers) {
      if (candidate !== databasePath) {
        writer.release();
      }
    }
    const selected = (useShared ? shared : local) ?? { version: AUTH_STORE_VERSION, profiles: {} };
    const observed = scopedSharedStore
      ? mergeAuthProfileStores(scopedSharedStore, selected)
      : selected;
    const inherited = useShared && !main;
    const owner = {
      databasePath,
      sharedDatabasePath: sharedPath,
      location: ownership.location,
      env,
    };
    const candidates = resolveLegacyAuthProfileSourceCandidates({
      agentDir: useShared ? undefined : selectedDir,
      env,
    });
    const sourcePaths = [
      ...new Set([...(mode ? [] : [sharedPath]), ...(localPath ? [localPath] : [])]),
    ];
    const credentialOwnerChanged = () =>
      sourcePaths.some((sourcePath) => {
        const previous = credentialTokens.get(sourcePath)!;
        const current = credentialToken(sourcePath);
        return current.revision !== previous.revision || current.known !== previous.known;
      });
    const assertOwnerCurrent = () => {
      context.admission.assertCurrent();
      context.maintenanceScope?.assertAdmission();
      for (const sourcePath of sourcePaths) {
        readers.get(sourcePath)?.assertCurrent();
      }
      const execution = executions.get(databasePath);
      if (execution) {
        if (!execution.ok) {
          throw execution.error;
        }
        execution.value.assertCurrent();
      }
      if (resolveSharedAuthStoreOwnership(env) !== ownership) {
        throw new Error("Auth profile shared owner changed before write admission");
      }
      assertAuthProfileMigrationStateAtDatabasePath(databasePath);
      assertAuthProfileMigrationCandidates({
        databasePath,
        candidates,
        hasCredentials: () => Object.keys(selected.profiles).length > 0,
      });
    };
    const assertCurrent = () => {
      assertOwnerCurrent();
      if (credentialOwnerChanged()) {
        throw new Error("Auth profile credential owner changed during usage preparation");
      }
    };
    assertOwnerCurrent();
    const providerAliases = resolveProviderAuthAliasMap({ env });
    let recordingStarted = false;
    const operation = consume({
      observed,
      async record(reduction, providerKey) {
        recordingStarted = true;
        const reconcileRemovedProfile = async (): Promise<AuthProfileUsageReceipt | undefined> => {
          assertOwnerCurrent();
          if (!credentialOwnerChanged()) {
            return undefined;
          }
          const currentRows = await read(databasePath);
          assertOwnerCurrent();
          const current = loadPersistedAuthProfileStoreFromRows(currentRows, databasePath) ?? {
            version: AUTH_STORE_VERSION,
            profiles: {},
          };
          const fresh = scopedSharedStore
            ? mergeAuthProfileStores(scopedSharedStore, current)
            : current;
          if (fresh.profiles[profileId]) {
            throw new Error("Auth profile credential owner changed during usage preparation");
          }
          // A preceding removal settles without dispatching a write or publishing stale rows.
          return createAuthProfileUsageReceipt(fresh);
        };
        const input: AuthProfileUsageInput = structuredClone({
          profileId,
          reduction,
          inherited,
          providerKey,
          providerAliases,
          scopedSharedStore,
          expectedCredential: selected.profiles[profileId],
        });
        let receipt: AuthProfileUsageReceipt | undefined;
        const publish = async (
          result: AuthProfileUsageResult,
          readTarget: () => Promise<AuthProfileRowRead>,
        ) => {
          if (!result.ok) {
            const error = new Error("Auth usage transaction failed");
            retainOpenClawStateWorkerErrorPayload(error, result.error);
            throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
          }
          receipt = result.receipt;
          committed = receipt;
          if (receipt.result) {
            await publishInlineAuthFailure(owner, receipt, readTarget, assertCurrent);
            store.usageStats = { ...store.usageStats, [profileId]: receipt.result.next };
            if (reduction.kind === "success" && !inherited) {
              store.lastGood = {
                ...Object.fromEntries(
                  Object.entries(store.lastGood ?? {}).filter(([key]) => {
                    const normalized = normalizeProviderId(key);
                    return (providerAliases[normalized] ?? normalized) !== providerKey;
                  }),
                ),
                ...(providerKey ? { [providerKey]: profileId } : {}),
              };
            }
          }
          return receipt;
        };
        try {
          if (databasePath === context.admission.databasePath) {
            const removed = await reconcileRemovedProfile();
            if (removed) {
              return removed;
            }
            return await runOpenClawStateWorkerOperation(
              context,
              async (scope) =>
                publish(await scope.execute({ type: "authProfiles.usage", input }), () =>
                  readSharedAuthProfileRows(context, false),
                ),
              {
                assertCurrent,
                createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [databasePath]),
              },
            );
          }
          const target = {
            path: databasePath,
            agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(databasePath)),
            env,
          };
          const captured = executions.get(databasePath)!;
          if (!captured.ok) {
            throw captured.error;
          }
          const execution = captured.value;
          return await writers.get(databasePath)!.run(async () => {
            const removed = await reconcileRemovedProfile();
            if (removed) {
              return removed;
            }
            const client = await openOpenClawAgentSqliteWorkerStore<InlineAuthFailureOperations>(
              target,
              { execution },
              {
                moduleUrl: resolveRuntimeWorkerUrl(
                  runtimeProcessEntrypoints.authProfileInlineUsage,
                ),
                input: {},
              },
            );
            return withAuthProfileCleanup(
              () =>
                client.run(
                  async (scope) =>
                    publish(await scope.execute({ type: "authProfiles.usage", input }), () =>
                      scope.execute({ type: "authProfiles.inlineSnapshot", input: undefined }),
                    ),
                  assertCurrent,
                ),
              async (outcome) => {
                try {
                  await client.close();
                } catch (error) {
                  throw !outcome.ok
                    ? new AggregateError(
                        [outcome.error, error],
                        "Auth usage and client cleanup failed",
                        { cause: outcome.error },
                      )
                    : error;
                }
              },
            );
          });
        } catch (error) {
          const outcomeUnknown = hasSqliteWorkerOutcomeUnknown(error);
          if (receipt || outcomeUnknown) {
            try {
              context.admission.assertCurrent();
              readers.get(databasePath)?.assertCurrent();
              const derived = useShared
                ? listRuntimeAuthProfileStoreSnapshotsForSharedOwner(owner)
                : [];
              clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(
                databasePath,
                useShared ? undefined : selectedDir,
              );
              for (const entry of derived) {
                clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(
                  entry.databasePath,
                  entry.agentDir,
                );
              }
            } catch (invalidationError) {
              reportCommittedInlineAuthFailure(
                "auth usage snapshot invalidation failed",
                invalidationError,
              );
            }
          }
          if (receipt) {
            reportCommittedInlineAuthFailure(
              "auth usage committed before publication or cleanup failed",
              error,
            );
            return receipt;
          }
          if (outcomeUnknown) {
            throw error;
          }
          if (isSqliteLockError(error)) {
            return null;
          }
          throw error;
        }
      },
    });
    // Provider probes plan outside the preparation FIFO; ready writes retain their position.
    if (!recordingStarted) {
      preparation.release();
      for (const writer of writers.values()) {
        writer.release();
      }
    }
    return await operation;
  };
  return withAuthProfileCleanup(executeUsage, async (outcome) => {
    try {
      const released = await Promise.allSettled([
        ...[...writers.values()].map((writer) => writer.dispose()),
        ...[...readers.values()].map((reader) => reader.dispose()),
        ...[...executions.values()].flatMap((execution) =>
          execution.ok ? [execution.value.release()] : [],
        ),
      ]);
      const failures = released.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        if (committed) {
          reportCommittedInlineAuthFailure(
            "auth usage committed before owner cleanup failed",
            failures,
          );
        } else {
          throw new AggregateError(
            [...(!outcome.ok ? [outcome.error] : []), ...failures],
            "Auth usage read owner cleanup failed",
            { cause: (!outcome.ok ? outcome.error : undefined) ?? failures[0] },
          );
        }
      }
    } finally {
      preparation?.release();
    }
  });
}
