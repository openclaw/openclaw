import path from "node:path";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import type { createCodexRemoteWorkspaceFileReader } from "./remote-workspace-media.js";
import { mapCodexAppServerRemoteWorkspacePath } from "./remote-workspace-path.js";
import type { CodexAttemptConnection } from "./run-attempt-connection.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

export function createCodexAttemptReplyMediaPreparer(
  connection: CodexAttemptConnection,
  readRemoteWorkspaceFile: ReturnType<typeof createCodexRemoteWorkspaceFileReader>,
) {
  const { params, runAbortController } = connection;
  const hostPrepareReplyMedia = params.hostCapabilities.prepareReplyMedia;
  const remoteWorkspaceRoot = connection.appServer.remoteWorkspaceRoot;
  return hostPrepareReplyMedia && remoteWorkspaceRoot
    ? async (
        content:
          | { kind: "attempt"; attempt: EmbeddedRunAttemptResult }
          | { kind: "payload"; payload: ReplyPayload },
        transferSignal?: AbortSignal,
      ) =>
        hostPrepareReplyMedia({
          ...content,
          workspaceRoot: remoteWorkspaceRoot,
          signal: runAbortController.signal,
          readWorkspaceFile: (relativePath, { maxBytes, signal }) =>
            readRemoteWorkspaceFile({
              path: mapCodexAppServerRemoteWorkspacePath({
                value: path.resolve(params.workspaceDir, relativePath),
                localWorkspaceRoot: params.workspaceDir,
                remoteWorkspaceRoot,
              }),
              workspaceRoot: remoteWorkspaceRoot,
              maxBytes,
              signal: transferSignal ? AbortSignal.any([signal, transferSignal]) : signal,
              timeoutMs: connection.appServer.requestTimeoutMs,
            }),
        })
    : undefined;
}

export async function settleReplyMedia(
  activeTurn: { prepareReplyMedia: ReturnType<typeof createCodexAttemptReplyMediaPreparer> },
  result: EmbeddedRunAttemptResult,
  { state, settlementExpired }: CodexAttemptTurnState,
  signal: AbortSignal,
): Promise<void> {
  if (activeTurn.prepareReplyMedia && !signal.aborted) {
    state.pendingSettlementStage = "reply/media";
    const transferAbort = new AbortController();
    void settlementExpired.then(() =>
      transferAbort.abort(new Error("Reply media settlement expired")),
    );
    try {
      const prepared = await activeTurn.prepareReplyMedia(
        { kind: "attempt", attempt: result },
        transferAbort.signal,
      );
      if (prepared.kind !== "attempt") {
        throw new Error("Reply media preparation returned the wrong result kind");
      }
      result.preparedReplyMedia = prepared.preparedMedia;
    } catch (error) {
      // Cancellation still returns this attempt's terminal outcome and completed
      // effects. Media preparation must not turn it into a retryable exception.
      if (!signal.aborted) {
        throw error;
      }
    } finally {
      transferAbort.abort();
    }
  }
  if (signal.aborted) {
    await state.abortCleanup;
  }
}
