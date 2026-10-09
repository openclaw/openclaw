import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveDatabasePathKey } from "../../infra/sqlite-worker-identity.js";
import type { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { AuthProfileStore } from "./types.js";

type AuthProfileRuntimeMode =
  | { kind: "env-only" }
  | { kind: "agent-dir"; agentDir: string; sharedStore?: AuthProfileStore; env: NodeJS.ProcessEnv };

export const authProfileRuntimeMode = new AsyncLocalStorage<AuthProfileRuntimeMode>();

type WorkerAuthProfileWrites = {
  env: NodeJS.ProcessEnv;
  assertOwner: (env: NodeJS.ProcessEnv) => void;
  run: <T>(operation: () => T | Promise<T>) => Promise<T>;
  runSync: <T>(databasePath: string, operation: () => T) => T;
};

const workerAuthProfileWrites = resolveGlobalSingleton(
  Symbol.for("openclaw.workerAuthProfileWrites"),
  () => new AsyncLocalStorage<WorkerAuthProfileWrites>(),
);

/** The request's work owner admits writes and closes this adapter after settlement. */
export function withWorkerAuthProfileWrites<T>(
  env: NodeJS.ProcessEnv,
  work: AsyncWorkScope,
  run: () => T,
): T {
  if (isMainThread) {
    throw new Error("Native auth writes require a worker-owned request");
  }
  const ownedEnv = cloneEnvWithPlatformSemantics(env);
  const stateDir = path.resolve(resolveStateDir(ownedEnv));
  const databasePath = resolveOpenClawStateSqlitePath(ownedEnv);
  const canonicalPath = resolveDatabasePathKey(databasePath);
  return workerAuthProfileWrites.run(
    {
      env: ownedEnv,
      assertOwner: (currentEnv) => {
        if (path.resolve(resolveStateDir(currentEnv)) !== stateDir) {
          throw new Error("Native auth write differs from its worker state owner");
        }
      },
      // Closing still admits an OAuth claim's settlement; closed work rejects retained callers.
      // The refresh owner separately retains its native section before publishing the claim.
      run: (operation) => work.track(operation),
      runSync: (currentPath, operation) => {
        if (currentPath !== databasePath && currentPath !== canonicalPath) {
          throw new Error("Native auth write differs from its worker state owner");
        }
        return work.run(operation);
      },
    },
    run,
  );
}

export function getWorkerAuthProfileWrites(): WorkerAuthProfileWrites | undefined {
  return workerAuthProfileWrites.getStore();
}

export function assertPersonalAuthProfileRuntime(): void {
  if (authProfileRuntimeMode.getStore()) {
    throw new Error("Personal model accounts are unavailable in an isolated auth-store scope.");
  }
}
