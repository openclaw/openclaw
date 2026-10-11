import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { materializePersonalAuthProfile } from "./personal-profiles.js";
import type { LoadAuthProfileStoreOptions, PreparedAuthProfileStoreReads } from "./runtime-read.js";
import type { getWorkerAuthProfileWrites } from "./runtime-scope.js";
import type { AuthProfileStore } from "./types.js";

type NativeReadHost = {
  worker: NonNullable<ReturnType<typeof getWorkerAuthProfileWrites>>;
  env: NodeJS.ProcessEnv;
  effectiveAgentDir: string | undefined;
  options: LoadAuthProfileStoreOptions;
  scope: {
    isolated: boolean;
    run: <T>(agentDir: string | undefined, env: NodeJS.ProcessEnv, run: () => T) => T;
  };
  loadAuthProfileStoreForAgent: (
    agentDir?: string,
    options?: LoadAuthProfileStoreOptions,
    env?: NodeJS.ProcessEnv,
  ) => AuthProfileStore;
  loadRuntimeAuthProfileStore: NativeReadHost["loadAuthProfileStoreForAgent"];
};

/** Catalog requests already own native reads and writes; only the host opens broker actors. */
export function readAuthProfileStoreInWorker<T>(
  host: NativeReadHost,
  consume?: (reads: PreparedAuthProfileStoreReads) => Promise<T>,
): Promise<T | AuthProfileStore> {
  const { worker, env, effectiveAgentDir, options, scope } = host;
  worker.assertOwner(env);
  return worker.run(async () => {
    const profileId = options.profileId;
    const runInCapturedScope = <Value>(run: () => Value): Value =>
      scope.run(effectiveAgentDir, env, run);
    if (!consume) {
      return runInCapturedScope(() =>
        host.loadRuntimeAuthProfileStore(effectiveAgentDir, options, env),
      );
    }
    return consume({
      effectiveAgentDir,
      env,
      options,
      runInCapturedScope,
      sharedPath: async () => runInCapturedScope(() => resolveSharedAuthStorePath(env)),
      readStore: async (agentDir, readOptions) =>
        runInCapturedScope(() => host.loadAuthProfileStoreForAgent(agentDir, readOptions, env)),
      assertCurrent: () => worker.assertOwner(env),
      materializePersonalProfile: async (store) =>
        !scope.isolated && profileId && isUserModelAuthProfileId(profileId)
          ? runInCapturedScope(() => materializePersonalAuthProfile(store, profileId))
          : store,
    });
  });
}
