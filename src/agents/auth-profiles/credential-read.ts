import { AuthProfileCredentialPublicationPendingError } from "../../state/user-model-account-authority.js";
import type { AuthProfileReadOwner, createAuthProfileStoreRuntimeReader } from "./runtime-read.js";
import {
  getScopedSharedAuthStore,
  getWorkerAuthProfileWrites,
  isEnvOnlyAuthProfileRuntime,
} from "./runtime-scope.js";
import { prepareScopedSharedAuthProfileCredentialRead } from "./shared-store-scope.js";
import { resolveAuthProfileDatabasePath as resolveAgentAuthPath } from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

type WithPreparedStoreReads = ReturnType<
  typeof createAuthProfileStoreRuntimeReader
>["withPreparedAuthProfileStoreReads"];

export function bindAuthProfileCredentialRead(
  withPreparedAuthProfileStoreReads: WithPreparedStoreReads,
) {
  /** Retain credential ownership after the temporary worker-read scope is disposed. */
  async function prepareAuthProfileCredentialRead(
    params: {
      agentDir?: string;
      profileId: string;
      store: AuthProfileStore;
    },
    waitForPublication?: { signal?: AbortSignal },
  ): Promise<(() => AuthProfileStore["profiles"][string] | undefined) | null> {
    // Catalog workers return published facts; only the host retains authority for effects.
    if (isEnvOnlyAuthProfileRuntime() || getWorkerAuthProfileWrites()) {
      return null;
    }
    const readCurrentCredential = await withPreparedAuthProfileStoreReads(
      params.agentDir,
      { readOnly: true, profileId: params.profileId },
      async (reads) => {
        let requestedPath: string | undefined;
        const prepare = async (agentDir: string | undefined) => {
          let readCurrent: AuthProfileReadOwner["readCurrentCredential"];
          await reads.readStore(agentDir, {
            ...reads.options,
            onReadOwner: (owner) => {
              requestedPath ??= owner.databasePath;
              readCurrent = owner.readCurrentCredential;
            },
          });
          if (!readCurrent) {
            throw new Error("Auth profile credential authority was not prepared");
          }
          return readCurrent;
        };
        const requested = await prepare(reads.effectiveAgentDir);
        const scopedSharedStore = reads.runInCapturedScope(getScopedSharedAuthStore);
        let inherited: typeof requested | undefined;
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
            inherited = await prepare(inheritedAgentDir);
          }
        }
        // Keep the absent local dependency: a later local insert shadows shared credentials.
        return () => requested() ?? inherited?.();
      },
    );
    // Join a known publication after releasing the temporary worker readers.
    for (;;) {
      try {
        return readCurrentCredential() ||
          params.store.runtimePersistedProfileIds?.includes(params.profileId)
          ? readCurrentCredential
          : null;
      } catch (error) {
        if (
          !waitForPublication ||
          !(error instanceof AuthProfileCredentialPublicationPendingError)
        ) {
          throw error;
        }
        await error.waitUntilCurrent(waitForPublication.signal);
      }
    }
  }
  return prepareAuthProfileCredentialRead;
}
