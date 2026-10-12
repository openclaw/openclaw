/**
 * Source-reply decisions for Codex dynamic tool results: whether the `message` tool
 * confirmed a current-source reply, whether a `canDeliverSourceReply` tool authored
 * one, and whether either ends the Codex turn.
 */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  captureToolAuthoredSourceReply,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import { CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE } from "./protocol.js";

export type CodexToolResultSourceReply = {
  /** The message tool itself marked its current-source reply terminal. */
  toolConfirmed: boolean;
  /** Final (`true`) or progress (`false`) for a confirmed message-tool reply. */
  final: boolean | undefined;
  /** Whether this tool result ends the Codex turn. */
  terminate: true | undefined;
};

/**
 * Resolves the source-reply facts of one Codex dynamic tool result and records whether
 * it ends the Codex turn on `response`. A final reply
 * authored by a `canDeliverSourceReply` tool, read from the result after middleware and
 * extensions, stays on the response until batch settlement. The host delivers it
 * and writes its transcript row after the send. Only calls in the model-only
 * namespace qualify: Codex never exposes that namespace to Code Mode programs,
 * so a program's intermediate call
 * cannot end the turn or reach the conversation.
 */
export function resolveCodexToolResultSourceReply(params: {
  sourceReplyDeliveryMode: EmbeddedRunAttemptParams["sourceReplyDeliveryMode"];
  canDeliverSourceReply: boolean | undefined;
  toolName: string;
  call: { callId: string; turnId: string; namespace?: string | null };
  resultIsError: boolean;
  rawResult: AgentToolResult<unknown>;
  result: AgentToolResult<unknown>;
  deliveredSourceReply: boolean;
  executedArgs: Record<string, unknown>;
  runId: string | undefined;
  response: CodexDynamicToolRuntimeResponse;
}): CodexToolResultSourceReply {
  const messageToolOnly =
    params.sourceReplyDeliveryMode === "message_tool_only" && params.toolName === "message";
  const toolConfirmed =
    messageToolOnly &&
    !params.resultIsError &&
    (params.rawResult.terminate === true || params.result.terminate === true);
  const confirmed = messageToolOnly && (toolConfirmed || params.deliveredSourceReply);
  const final = confirmed ? params.executedArgs.final !== false : undefined;
  // Middleware and extensions may withdraw or rewrite the reply, so read the
  // effective result, never the raw tool output.
  const payload =
    params.canDeliverSourceReply === true &&
    !params.resultIsError &&
    params.call.namespace === CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE
      ? captureToolAuthoredSourceReply({
          result: params.result,
          toolCallId: params.call.callId,
          idempotencyScope: params.runId ?? params.call.turnId,
        })
      : undefined;
  const toolAuthoredFinal = Boolean(payload);
  const continuesSourceReplyProgress = confirmed && final === false;
  const terminate =
    toolAuthoredFinal ||
    ((params.rawResult.terminate === true || params.result.terminate === true) &&
      !continuesSourceReplyProgress) ||
    // Yield is an explicit owner-level turn handoff, not termination
    // inferred from source-reply delivery, so finality does not mask it.
    [params.rawResult, params.result].some(
      ({ details }) =>
        isRecord(details) &&
        typeof details.status === "string" &&
        details.status.trim().toLowerCase() === "yielded",
    ) ||
    (confirmed && final === true) ||
    undefined;
  params.response.terminate = terminate;
  if (payload) {
    params.response.toolAuthoredSourceReply = {
      ...payload,
      toolAuthoredForTurnId: params.call.turnId,
    };
  }
  return { toolConfirmed, final, terminate };
}
