import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithOwnedSessionTranscriptWrite } from "../../../config/sessions/transcript-write-context.js";
import {
  createNestedToolActivity,
  readNestedToolActivity,
  type NestedToolActivity,
} from "../../../sessions/nested-tool-activity.js";
import { raceWithAbortSignal } from "../../agent-tools.abort.js";
import { recordStructuredReplayTrustForToolCall } from "../../agent-tools.before-tool-call.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { sanitizeToolResult } from "../../embedded-agent-tool-results.js";
import {
  copyInternalToolResultState,
  getInternalToolExecutionPreparer,
} from "../../runtime/internal-hooks.js";
import type { AgentSession } from "../../sessions/index.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { retainToolSearchImplementation } from "../../tool-search-scheduling.js";
import type { ToolSearchCatalogToolExecutor } from "../../tool-search.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { redactTranscriptMessage } from "../../transcript-redact.js";
import { recordEmbeddedToolReceipt } from "../tool-send-receipts.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import { notifyToolActivity } from "./tool-activity-heartbeat.js";

/** One owner for nested execution, acceptance, and durable display activity. */
export function createSubscribedToolSearchExecutor(params: {
  attempt: Pick<EmbeddedRunAttemptInternalParams, "config" | "runId" | "sessionId" | "sessionKey">;
  runSignal: AbortSignal;
  sessionManager: AgentSession["sessionManager"];
  subscription: Pick<ReturnType<typeof subscribeEmbeddedAgentSession>, "runToolLifecycle">;
  isCurrent: () => boolean;
  isReplaySafeTool: (tool: Parameters<ToolSearchCatalogToolExecutor>[0]["tool"]) => boolean;
  nestedToolActivities: NestedToolActivity[];
}): ToolSearchCatalogToolExecutor {
  const { attempt, subscription } = params;
  const activityScope = randomUUID();
  let nestedStartOrder = 0;
  return async (toolParams) => {
    const runSignal = params.runSignal;
    const signal = AbortSignal.any([toolParams.signal ?? runSignal, runSignal]);
    const yieldRunSignal = toolParams.toolName === "sessions_yield" ? runSignal : undefined;
    const startedAt = Date.now();
    const startOrder = nestedStartOrder++;
    const manager = params.sessionManager;
    const afterEntryId = manager.getAppendParentId();
    if (toolParams.source === "openclaw" && toolParams.sourceName === "core") {
      recordStructuredReplayTrustForToolCall(
        toolParams.toolCallId,
        // SAFETY: The catalog owner classified this registered instance as a native core tool.
        toolParams.tool as AnyAgentTool,
        attempt.runId,
      );
    }
    return await raceWithAbortSignal(
      subscription.runToolLifecycle({
        toolName: toolParams.toolName,
        toolCallId: toolParams.toolCallId,
        parentToolCallId: toolParams.parentToolCallId,
        args: toolParams.input,
        replaySafe: toolParams.replaySafe ?? params.isReplaySafeTool(toolParams.tool),
        hideFromChannelProgress:
          "hideFromChannelProgress" in toolParams.tool &&
          toolParams.tool.hideFromChannelProgress === true,
        onTerminal: async (terminal) => {
          const message = {
            ...createNestedToolActivity({
              runId: attempt.runId,
              scopeId: activityScope,
              afterEntryId,
              startOrder,
              parentToolCallId: toolParams.parentToolCallId,
              toolCallId: toolParams.toolCallId,
              toolName: toolParams.toolName,
              input: terminal.executedArguments,
              result: sanitizeToolResult(terminal.result),
              isError: terminal.isError,
              startedAt,
              timestamp: Date.now(),
            }),
            idempotencyKey: `${activityScope}:${toolParams.toolCallId}`,
          };
          await runWithOwnedSessionTranscriptWrite(
            { sessionTarget: manager.getSessionTarget(), sessionKey: attempt.sessionKey },
            () =>
              withSessionManagerWrite(manager, () => {
                // Revalidate the exact attempt after awaited acceptance and writer admission.
                if (!params.isCurrent()) {
                  return;
                }
                if (isRecord(terminal.result)) {
                  copyInternalToolResultState(terminal.result, message);
                }
                manager.appendMessage(message);
                const recorded = readNestedToolActivity(
                  redactTranscriptMessage(message, attempt.config),
                );
                if (!recorded) {
                  throw new Error("Nested activity became invalid during transcript redaction");
                }
                params.nestedToolActivities.push(recorded);
              }),
          );
          notifyToolActivity(attempt.runId);
        },
        // Acceptance belongs inside execution: observers must never see a rejected success.
        execute: async (onImplementationStart) =>
          await raceWithAbortSignal(
            retainToolSearchImplementation(
              (async () => {
                signal.throwIfAborted();
                const preparer = getInternalToolExecutionPreparer(toolParams.tool);
                if (!preparer) {
                  onImplementationStart();
                  // SAFETY: toClientToolDefinitions pre-binds client dispatch to the native execution contract.
                  return await (toolParams.tool as AnyAgentTool).execute(
                    toolParams.toolCallId,
                    toolParams.input,
                    signal,
                    toolParams.onUpdate,
                  );
                }
                const prepared = await preparer({
                  toolCallId: toolParams.toolCallId,
                  args: toolParams.input,
                  signal,
                  onUpdate: toolParams.onUpdate,
                });
                try {
                  if (prepared.kind === "immediate") {
                    if (prepared.outcome.kind === "error") {
                      throw prepared.outcome.error;
                    }
                    return prepared.outcome.result;
                  }
                  return await prepared.execute(onImplementationStart);
                } finally {
                  prepared.dispose();
                }
              })().then((result) => {
                signal.throwIfAborted();
                // Nested tools bypass the session's tool_result middleware hook.
                // Preserve committed delivery before output acceptance can reject it.
                recordEmbeddedToolReceipt(
                  manager,
                  toolParams.toolCallId,
                  result.details,
                  toolParams.source === "openclaw" &&
                    toolParams.sourceName === "core" &&
                    toolParams.toolName === "message",
                );
                return toolParams.acceptResultBeforeProjection(result);
              }),
            ),
            signal,
            yieldRunSignal,
          ),
      }),
      signal,
      yieldRunSignal,
    );
  };
}
