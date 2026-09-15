import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { captureAsyncWorkTracker, trackAsyncWork } from "../../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
/** Completed catalogs are bound to execution owners; cancellation alone is not release. */
import type { PublishedWorkspaceSkills } from "../../skills/loading/workspace-skill-sync.runtime.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { recordAgentCleanupFailure } from "../run-cleanup-timeout.js";

// Lazy runtime chunks share the handoff; the execution owner still owns each lifetime.
const { publications, pending, catalogs, preparedWork } = resolveGlobalSingleton(
  Symbol.for("openclaw.sandboxPublishedSkills"),
  () => ({
    publications: new WeakMap<object, Set<PublishedWorkspaceSkills>>(),
    pending: new WeakMap<object, Set<Promise<unknown>>>(),
    catalogs: new WeakMap<object, SkillSnapshot>(),
    preparedWork: new WeakMap<object, typeof trackAsyncWork>(),
  }),
);

export function attachPublishedSandboxSkills(
  executionOwner: object,
  context: object,
  publication: PublishedWorkspaceSkills,
): void {
  let owned = publications.get(executionOwner);
  if (!owned) {
    owned = new Set();
    publications.set(executionOwner, owned);
  }
  owned.add(publication);
  catalogs.set(context, publication.skillsSnapshot);
}

export function readPublishedSandboxSkills(
  owner: object | null | undefined,
): SkillSnapshot | undefined {
  return owner ? catalogs.get(owner) : undefined;
}

export async function releasePublishedSandboxSkills(executionOwner: object): Promise<void> {
  const holds = pending.get(executionOwner);
  if (holds?.size) {
    // Reporting timeout is not resource settlement. The async-work owner retains this drain.
    void trackAsyncWork(async () => {
      await Promise.allSettled(holds);
      await releasePublishedSandboxSkills(executionOwner);
    }).catch(() => recordAgentCleanupFailure());
    return;
  }
  const owned = publications.get(executionOwner);
  if (!owned) {
    return;
  }
  const results = await Promise.allSettled(
    [...owned].map(async (publication) => {
      await publication.release();
      owned.delete(publication);
    }),
  );
  if (owned.size === 0) {
    publications.delete(executionOwner);
  }
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    // Keep failed publications retryable without replacing the execution outcome.
    recordAgentCleanupFailure();
    createSubsystemLogger("agent/sandbox").warn(
      `Sandbox catalog release failed: ${String(failure.reason)}`,
    );
  }
}

export function retainPublishedSandboxSkillsUntil<T>(owner: object, work: Promise<T>): Promise<T> {
  let holds = pending.get(owner);
  if (!holds) {
    holds = new Set();
    pending.set(owner, holds);
  }
  holds.add(work);
  void work.finally(() => holds.delete(work)).catch(() => {});
  return work;
}

/** Keep an execution's publications through the backend's actual async-work drain. */
export async function withPublishedSandboxSkills<T>(
  run: (owner: object) => Promise<T>,
): Promise<T> {
  return await runWithAsyncWorkResources(async (onAcquired) => {
    const owner = {};
    onAcquired({ release: () => releasePublishedSandboxSkills(owner) });
    return run(owner);
  });
}

/** Carry a prepared CLI owner's work scope across the preparation/execution handoff. */
export function bindPublishedSandboxSkillsWork(context: object): void {
  preparedWork.set(context, captureAsyncWorkTracker());
}

/** Execution descendants belong to the same owner as preparation and cleanup. */
export async function runWithPublishedSandboxSkillsWork<T>(
  context: object,
  run: () => Promise<T>,
): Promise<T> {
  return await (preparedWork.get(context) ?? trackAsyncWork)(run);
}
