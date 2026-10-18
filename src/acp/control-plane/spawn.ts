/** Cleanup helpers for failed ACP spawn flows. */
import {
  callInProcessGatewayTool,
  getInProcessGatewayToolContext,
  runWithGatewayToolCleanupContext,
} from "../../agents/tools/in-process-gateway.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../../config/sessions/session-entry-current-check.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { isAcpOwnerRepairRequired } from "./manager.runtime-owner.js";

/** Roll back only the provisional session owned by this failed spawn. */
export async function cleanupFailedAcpSpawn(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  sessionEntry?: SessionEntry;
  deleteTranscript: boolean;
  closeRuntimeOnFailure?: () => Promise<void>;
}): Promise<void> {
  if (!params.sessionEntry) {
    return;
  }
  const { sessionId, lifecycleRevision } = params.sessionEntry;
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  let source: Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsyncInternal>> | undefined;
  const assertCurrent = async () => {
    if (!source) {
      throw new Error(`ACP provisional session ${params.sessionKey} changed before cleanup.`);
    }
    await source.assertCurrent();
  };
  let deletionStarted = false;
  let deletionExecution: Promise<void> | undefined;
  const cancellation = new AbortController();
  try {
    source = await captureSessionEntryCurrentCheckAsyncInternal({
      storePath,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      fields: ["sessionId", "lifecycleRevision"],
      expected: { sessionId, lifecycleRevision },
      errorMessage: `ACP provisional session ${params.sessionKey} changed before cleanup.`,
    });
    await runWithGatewayToolCleanupContext(async () => {
      const context = getInProcessGatewayToolContext();
      if (!context) {
        throw new Error("ACP provisional cleanup Gateway is unavailable.");
      }
      const assertCleanupCurrent = (assertSource: () => void) => {
        cancellation.signal.throwIfAborted();
        context.requestEntryLifetime?.signal.throwIfAborted();
        assertSource();
      };
      await callInProcessGatewayTool(
        "sessions.delete",
        {
          key: params.sessionKey,
          agentId: params.agentId,
          expectedSessionId: sessionId,
          ...(lifecycleRevision ? { expectedLifecycleRevision: lifecycleRevision } : {}),
          deleteTranscript: params.deleteTranscript,
          emitLifecycleHooks: false,
        },
        // New /acp rows can have no revision yet. The private guard preserves
        // exact absence as well as recorded revisions throughout deletion.
        {
          onExecution: (execution) => {
            deletionExecution = execution;
          },
          sessionMutationCommitGuard: composeSessionSourceAssertion(
            [source!.source],
            (assertSource) => {
              assertCleanupCurrent(assertSource);
              // The router calls this after lazy preparation, before handler entry.
              deletionStarted = true;
            },
            { preparedCheck: assertCleanupCurrent },
          ),
          signal: cancellation.signal,
          timeoutMs: 10_000,
        },
      );
    });
  } catch (error) {
    // A retired owner cannot dispatch cleanup. Retain its existing local handle
    // release, but never repeat a close after canonical deletion has started.
    if (!deletionStarted) {
      // A timed-out preparation may still settle; fence its late handler entry.
      cancellation.abort(error);
    }
    if (!deletionStarted && params.closeRuntimeOnFailure) {
      await runSessionMutation({
        diagnosticLabel: "acp-spawn-cleanup",
        scope: storePath,
        identities: [params.sessionKey, sessionId],
        run: async () => {
          await assertCurrent();
          await params.closeRuntimeOnFailure!();
        },
      }).catch((releaseError: unknown) => {
        if (isAcpOwnerRepairRequired(releaseError)) {
          throw releaseError;
        }
        logVerbose(`acp-spawn: provisional runtime cleanup failed: ${String(releaseError)}`);
      });
    }
    logVerbose(`acp-spawn: provisional session cleanup failed: ${String(error)}`);
  } finally {
    try {
      if (deletionStarted) {
        // The response deadline does not cancel an admitted session mutation.
        await deletionExecution;
      }
    } finally {
      source?.release();
    }
  }
}
