/** Reference history is prepared from client-owned state; runtime owns its lifetime. */
import { createHash } from "node:crypto";

export type CodexClientWorkspaceReferenceState = {
  closed: boolean;
  workspaceReferences: Map<string, { digest?: string; needsReintroduction: boolean }>;
};

/** A compaction replaces the observation, so an older pending acceptance cannot clear it. */
export function invalidateCodexClientWorkspaceReferences(
  runtime: CodexClientWorkspaceReferenceState,
  threadId: string,
): void {
  const previous = runtime.workspaceReferences.get(threadId);
  if (previous) {
    runtime.workspaceReferences.set(threadId, { ...previous, needsReintroduction: true });
  }
}

/** Accepted input must not clear a compaction observed during turn/start. */
export function prepareCodexClientWorkspaceReferences(
  runtime: CodexClientWorkspaceReferenceState | undefined,
  threadId: string,
  reference: string | undefined,
) {
  const digest = createHash("sha256")
    .update(reference ?? "")
    .digest("hex");
  const previous = runtime?.workspaceReferences.get(threadId) ?? { needsReintroduction: true };
  if (runtime && !runtime.closed) {
    runtime.workspaceReferences.set(threadId, previous);
  }
  return {
    include: previous.needsReintroduction || previous.digest !== digest,
    accepted: () => {
      if (!runtime || runtime.closed || runtime.workspaceReferences.get(threadId) !== previous) {
        return;
      }
      runtime.workspaceReferences.set(threadId, { digest, needsReintroduction: false });
    },
  };
}
