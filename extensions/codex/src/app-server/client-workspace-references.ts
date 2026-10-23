import { createHash } from "node:crypto";

type WorkspaceReference = { digest?: string; needsReintroduction: boolean };

export type CodexWorkspaceReferenceState = {
  closed: boolean;
  workspaceReferences: Map<string, WorkspaceReference>;
};

/** Record accepted input without clearing a compaction observed during turn/start. */
export function prepareCodexWorkspaceReference(
  runtime: CodexWorkspaceReferenceState | undefined,
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
