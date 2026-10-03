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
import { shouldUseMainOwnerForLocalOAuthCredential } from "./ownership.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnershipAsync,
  resolveSharedAuthStorePath,
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
import type {
  AuthProfileUsageInput,
  AuthProfileUsageReceipt,
  AuthProfileUsageResult,
} from "./store.worker-contract.js";
import type { AuthProfileRowRead, AuthProfileStore } from "./types.js";
import { reserveAuthProfileUsagePreparation } from "./usage-lifecycle.js";
import type { PersonalAuthProfileUsageReduction } from "./usage-reduction.js";

/** Capture every possible physical owner before choosing inherited ownership asynchronously. */
export async function withAuthProfileUsage<T>(
  store: AuthProfileStore,
  profileId: string,
  agentDir: string | undefined,
  consume: (usage: {
    observed: AuthProfileStore;
    inherited: boolean;
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
      inherited: false,
      record: async () => ({
        store: observed,
        result: undefined,
        publication: {
          credentialsChanged: false,
          profileSetChanged: false,
          stateChanged: false,
          selectionChanged: false,
          profileIds: [],
        },
      }),
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
  let failure: { error: unknown } | undefined;
  try {
    for (const databasePath of new Set([
      ...(mode ? [] : [legacyPath]),
      ...(localPath ? [localPath] : []),
    ])) {
      readers.set(
        databasePath,
        prepareAgentAuthProfileRowsRead({
          databasePath,
          agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(databasePath)),
          env,
        }),
      );
      try {
        executions.set(databasePath, {
          ok: true,
          value: captureOpenClawAgentDatabaseExecution({
            path: databasePath,
            agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(databasePath)),
            env,
          }),
        });
      } catch (error) {
        executions.set(databasePath, { ok: false, error });
      }
    }
    preparation = reserveAuthProfileUsagePreparation([
      context.admission.identity.canonicalPath,
      ...[...readers.keys()].map(
        (pathname) => readDatabasePathIdentitySync(pathname).canonicalPath,
      ),
    ]);
    await preparation.ready;
    const ownership = await resolveSharedAuthStoreOwnershipAsync(context);
    const sharedPath = resolveSharedAuthStorePath(env);
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
    const selected = (useShared ? shared : local) ?? { version: AUTH_STORE_VERSION, profiles: {} };
    const observed = scopedSharedStore
      ? mergeAuthProfileStores(scopedSharedStore, selected)
      : selected;
    const rows = useShared ? sharedRows! : localRows!;
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
    const assertCurrent = () => {
      context.admission.assertCurrent();
      context.maintenanceScope?.assertAdmission();
      for (const sourcePath of new Set([
        ...(mode ? [] : [sharedPath]),
        ...(localPath ? [localPath] : []),
      ])) {
        readers.get(sourcePath)?.assertCurrent();
        const previous = credentialTokens.get(sourcePath)!;
        const current = credentialToken(sourcePath);
        if (current.revision !== previous.revision || current.known !== previous.known) {
          throw new Error("Auth profile credential owner changed during usage preparation");
        }
      }
      const execution = executions.get(databasePath);
      if (execution) {
        if (!execution.ok) {
          throw execution.error;
        }
        execution.value.assertCurrent();
      }
      if (resolveSharedAuthStoreOwnership(env) !== ownership) {
        throw new Error("Auth profile shared owner changed before usage admission");
      }
      assertAuthProfileMigrationStateAtDatabasePath(databasePath);
      assertAuthProfileMigrationCandidates({
        databasePath,
        candidates,
        hasCredentials: () => Object.keys(selected.profiles).length > 0,
      });
    };
    assertCurrent();
    const providerAliases = resolveProviderAuthAliasMap({ env });
    let recordingStarted = false;
    const operation = consume({
      observed,
      inherited,
      async record(reduction, providerKey) {
        recordingStarted = true;
        const input: AuthProfileUsageInput = structuredClone({
          profileId,
          reduction,
          inherited,
          providerKey,
          providerAliases,
          scopedSharedStore,
          expectedCredentials: rows.store.status === "readable" ? rows.store.raw : null,
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
            return await runOpenClawStateWorkerOperation(
              context,
              async (scope) =>
                publish(await scope.execute({ type: "authProfiles.usage", input }), () =>
                  scope.execute({
                    type: "authProfiles.read",
                    input: { artifactPreserving: false },
                  }),
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
          {
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
            let operationFailure: { error: unknown } | undefined;
            try {
              return await client.run(
                async (scope) =>
                  publish(await scope.execute({ type: "authProfiles.usage", input }), () =>
                    scope.execute({ type: "authProfiles.inlineSnapshot", input: undefined }),
                  ),
                assertCurrent,
              );
            } catch (error) {
              operationFailure = { error };
              throw error;
            } finally {
              try {
                await client.close();
              } catch (error) {
                throw operationFailure
                  ? new AggregateError(
                      [operationFailure.error, error],
                      "Auth usage and client cleanup failed",
                      { cause: operationFailure.error },
                    )
                  : error;
              }
            }
          }
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
    }
    return await operation;
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      const released = await Promise.allSettled([
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
            [...(failure ? [failure.error] : []), ...failures],
            "Auth usage read owner cleanup failed",
            { cause: failure?.error ?? failures[0] },
          );
        }
      }
    } finally {
      preparation?.release();
    }
  }
}
