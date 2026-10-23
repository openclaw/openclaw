import { AsyncLocalStorage } from "node:async_hooks";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PublishedWorkspaceSkills } from "../../skills/loading/workspace-skill-sync.runtime.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { recordAgentCleanupFailure } from "../run-cleanup-timeout.js";
import type { SandboxContext } from "./types.js";

const state = resolveGlobalSingleton(Symbol.for("openclaw.sandboxSkillCatalogs"), () => ({
  executions: new AsyncLocalStorage<Set<PublishedWorkspaceSkills>>(),
  catalogs: new WeakMap<object, SkillSnapshot>(),
}));

export function readSandboxSkillCatalog(sandbox: object): SkillSnapshot | undefined {
  return state.catalogs.get(sandbox);
}

function releaseCatalog(catalog: PublishedWorkspaceSkills): Promise<void> {
  return catalog.release().catch((error: unknown) => {
    recordAgentCleanupFailure();
    createSubsystemLogger("agent/sandbox").warn(
      `Sandbox skill catalog cleanup failed: ${String(error)}`,
    );
  });
}

/** The existing disposable SDK result owns standalone preparation; core executions retain it longer. */
export function bindSandboxSkillCatalog(
  sandbox: SandboxContext,
  catalog: PublishedWorkspaceSkills,
): void {
  state.catalogs.set(sandbox, catalog.skillsSnapshot);
  const execution = state.executions.getStore();
  execution?.add(catalog);
  const disposeWorkspace = sandbox[Symbol.dispose];
  sandbox[Symbol.dispose] = () => {
    try {
      disposeWorkspace?.();
    } finally {
      if (!execution) {
        void trackAsyncWork(() => releaseCatalog(catalog));
      }
    }
  };
}

/** A cleanup timeout reports an outcome; cooperating asynchronous work still owns its files. */
export function withSandboxSkillCatalogs<T>(run: () => Promise<T>): Promise<T> {
  if (state.executions.getStore()) {
    return run();
  }
  return runWithAsyncWorkResources(async (onAcquired) => {
    const catalogs = new Set<PublishedWorkspaceSkills>();
    onAcquired({
      release: async () => {
        await Promise.all([...catalogs].map(releaseCatalog));
        catalogs.clear();
      },
      releaseBeforeResultWhenIdle: true,
    });
    return state.executions.run(catalogs, run);
  });
}
