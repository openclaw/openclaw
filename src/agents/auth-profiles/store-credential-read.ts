import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AuthProfileStoreUnreadableError } from "./legacy-source-diagnostic.js";
import type { AuthProfileReadOwner, createAuthProfileStoreRuntimeReader } from "./runtime-read.js";
import {
  getScopedSharedAuthStore,
  getWorkerAuthProfileWrites,
  isEnvOnlyAuthProfileRuntime,
} from "./runtime-scope.js";
import { retainPublishedInheritedCredential } from "./runtime-snapshots.js";
import { prepareScopedSharedAuthProfileCredentialRead } from "./shared-store-scope.js";
import { resolveAuthProfileDatabasePath as resolveAgentAuthPath } from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

type PreparedReader = ReturnType<
  typeof createAuthProfileStoreRuntimeReader
>["withPreparedAuthProfileStoreReads"];

export function createAuthProfileCredentialReader(
  withPreparedAuthProfileStoreReads: PreparedReader,
) {
  /** Retain credential ownership after the temporary worker-read scope is disposed. */
  return async function prepareAuthProfileCredentialRead(params: {
    agentDir?: string;
    profileId: string;
    store: AuthProfileStore;
    cfg?: OpenClawConfig;
  }): Promise<(() => AuthProfileStore["profiles"][string] | undefined) | null> {
    // Catalog workers return published facts; only the host retains authority for effects.
    if (isEnvOnlyAuthProfileRuntime() || getWorkerAuthProfileWrites()) {
      return null;
    }
    return withPreparedAuthProfileStoreReads(
      params.agentDir,
      {
        readOnly: true,
        profileId: params.profileId,
        migrationProvider: params.store.profiles[params.profileId]?.provider,
        config: params.cfg,
      },
      async (reads) => {
        let requestedPath: string | undefined;
        const prepare = async (agentDir: string | undefined) => {
          let owner: AuthProfileReadOwner | undefined;
          await reads.readStore(agentDir, {
            ...reads.options,
            onReadOwner: (value) => {
              requestedPath ??= value.databasePath;
              owner = value;
            },
          });
          if (!owner?.readCurrentCredential) {
            throw new Error("Auth profile credential authority was not prepared");
          }
          return {
            read: owner.readCurrentCredential,
            credential: owner.readStore()?.profiles[params.profileId],
          };
        };
        let requested: Awaited<ReturnType<typeof prepare>> | undefined;
        let unreadable: AuthProfileStoreUnreadableError | undefined;
        const scopedSharedStore = reads.runInCapturedScope(getScopedSharedAuthStore);
        try {
          requested = await prepare(reads.effectiveAgentDir);
        } catch (error) {
          if (!(error instanceof AuthProfileStoreUnreadableError)) {
            throw error;
          }
          unreadable = error;
        }
        // Current publication can recover local absence, never override a readable local row.
        const published =
          !requested?.credential &&
          reads.effectiveAgentDir &&
          !reads.options.inheritedAuthDir &&
          !scopedSharedStore
            ? retainPublishedInheritedCredential({
                agentDir: reads.effectiveAgentDir,
                sharedPath: await reads.sharedPath(),
                profileId: params.profileId,
                provider: reads.options.migrationProvider,
                config: reads.options.config,
              })
            : undefined;
        if (published && reads.retainPublishedLocalAbsence) {
          const assertLocalAbsent = reads.retainPublishedLocalAbsence();
          const shared = await prepare(undefined);
          const readCurrent = () => {
            assertLocalAbsent();
            const credential = shared.read();
            published(credential);
            return credential;
          };
          readCurrent();
          return readCurrent;
        }
        if (!requested) {
          throw unreadable ?? new Error("Auth profile local read was unavailable");
        }
        let inherited: typeof requested.read | undefined;
        if (scopedSharedStore) {
          inherited = await prepareScopedSharedAuthProfileCredentialRead(
            reads.env,
            params.profileId,
          );
        } else if (reads.effectiveAgentDir) {
          const inheritedAgentDir = reads.options.inheritedAuthDir;
          const inheritedPath = inheritedAgentDir
            ? resolveAgentAuthPath(inheritedAgentDir)
            : await reads.sharedPath();
          if (requestedPath !== inheritedPath) {
            inherited = (await prepare(inheritedAgentDir)).read;
          }
        }
        // Keep the absent local dependency: a later local insert shadows shared credentials.
        const readCurrent = () => requested.read() ?? inherited?.();
        return readCurrent() || params.store.runtimePersistedProfileIds?.includes(params.profileId)
          ? readCurrent
          : null;
      },
    );
  };
}
