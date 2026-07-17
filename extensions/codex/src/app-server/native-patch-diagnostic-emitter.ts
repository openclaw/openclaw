import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import {
  readBoundedCodexNativePatchFailureDiagnostic,
  sanitizeNativePatchDiagnosticForEmission,
  sanitizeNativePatchDiagnosticIdentifier,
  type CodexNativePatchFailureDiagnostic,
} from "./notification-correlation.js";
import type { CodexThreadItem } from "./protocol.js";

export type CodexNativePatchFailureDiagnosticReader = (params: {
  threadId: string;
  turnId: string;
  callId: string;
}) => Promise<CodexNativePatchFailureDiagnostic>;

/** Creates the failed-fileChange-only diagnostic boundary for one active turn. */
export function createCodexNativePatchFailureDiagnosticEmitter(params: {
  attempt: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  trajectoryRecorder?: {
    recordEvent: (type: string, data?: Record<string, unknown>) => void;
  } | null;
  emitAgentEvent: (
    event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
  ) => void;
  readDiagnostic?: CodexNativePatchFailureDiagnosticReader;
}): { handle: (item: CodexThreadItem | undefined) => Promise<void> } {
  const completedItemIds = new Set<string>();
  return {
    async handle(item) {
      if (
        item?.type !== "fileChange" ||
        (item.status !== "failed" && item.status !== "error") ||
        completedItemIds.has(item.id)
      ) {
        return;
      }
      completedItemIds.add(item.id);
      let diagnostic: CodexNativePatchFailureDiagnostic;
      try {
        diagnostic = params.readDiagnostic
          ? await params.readDiagnostic({
              threadId: params.threadId,
              turnId: params.turnId,
              callId: item.id,
            })
          : await readBoundedCodexNativePatchFailureDiagnostic({
              agentDir: resolveAgentDir(
                params.attempt.config ?? {},
                params.attempt.agentId ?? resolveDefaultAgentId(params.attempt.config ?? {}),
              ),
              threadId: params.threadId,
              turnId: params.turnId,
              callId: item.id,
            });
      } catch {
        diagnostic = {
          schema: "openclaw.sandbox.write_diagnostic.v1",
          operation: "apply_patch",
          boundary: "codex_native_patch_apply_end_rollout",
          phase: "native_patch_apply_end_observation",
          fileChangeItemId: item.id,
          turnId: params.turnId,
          nativePatchApplyEndObserved: false,
          nativePatchApplyEndDiagnosticFallback: "diagnostic_scan_failed",
          nativePatchApplyEndScanBounded: true,
        };
      }
      diagnostic = sanitizeNativePatchDiagnosticForEmission(diagnostic);
      const emittedThreadId = sanitizeNativePatchDiagnosticIdentifier(
        params.threadId,
        "<redacted-thread-id>",
      );
      params.trajectoryRecorder?.recordEvent("diagnostic.native_patch_apply_end", {
        threadId: emittedThreadId,
        turnId: diagnostic.turnId,
        fileChangeItemId: diagnostic.fileChangeItemId,
        diagnostic,
      });
      embeddedAgentLog.warn("codex native apply_patch failure diagnostic", {
        threadId: emittedThreadId,
        turnId: diagnostic.turnId,
        fileChangeItemId: diagnostic.fileChangeItemId,
        diagnostic,
      });
      params.emitAgentEvent({
        stream: "codex_app_server.native_patch_apply_end",
        data: diagnostic,
      });
    },
  };
}
