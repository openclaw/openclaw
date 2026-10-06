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
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolCallParams,
} from "./protocol.js";

type ToolAuthoredSourceReplyPayload = NonNullable<
  ReturnType<typeof captureToolAuthoredSourceReply>
>;

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
 * extensions, is appended to `payloads`; the host delivers it and writes its transcript
 * row after the send. Only calls in the model-only namespace qualify: Codex never
 * exposes that namespace to Code Mode programs, so a program's intermediate call
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
  payloads: ToolAuthoredSourceReplyPayload[];
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
  const toolAuthoredFinal = captureCodexToolAuthoredSourceReply(params);
  const continuesSourceReplyProgress = confirmed && final === false;
  const terminate =
    toolAuthoredFinal === true ||
    ((params.rawResult.terminate === true || params.result.terminate === true) &&
      !continuesSourceReplyProgress) ||
    // Yield is an explicit owner-level turn handoff, not termination
    // inferred from source-reply delivery, so finality does not mask it.
    isToolResultYield(params.rawResult) ||
    isToolResultYield(params.result) ||
    (confirmed && final === true) ||
    undefined;
  params.response.terminate = terminate;
  if (toolAuthoredFinal === true) {
    params.response.toolAuthoredFinalReply = true;
  }
  return { toolConfirmed, final, terminate };
}

function captureCodexToolAuthoredSourceReply(
  params: Parameters<typeof resolveCodexToolResultSourceReply>[0],
): boolean | undefined {
  if (
    params.canDeliverSourceReply !== true ||
    params.resultIsError ||
    params.call.namespace !== CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE
  ) {
    return undefined;
  }
  // Middleware and extensions may withdraw or rewrite the reply, so read the
  // effective result, never the raw tool output.
  const payload = captureToolAuthoredSourceReply({
    result: params.result,
    toolCallId: params.call.callId,
    idempotencyScope: params.runId ?? params.call.turnId,
  });
  if (!payload) {
    return undefined;
  }
  params.payloads.push(payload);
  return true;
}

function isToolResultYield(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  if (!isRecord(details) || typeof details.status !== "string") {
    return false;
  }
  return details.status.trim().toLowerCase() === "yielded";
}

export function canProduceFinalSourceReplyDelivery(call: CodexDynamicToolCallParams): boolean {
  // before_tool_call may rewrite finality, so the original arguments cannot
  // safely narrow which message calls can produce an authoritative receipt.
  return call.tool === "message";
}

export function applyCurrentMessageProvider(
  toolName: string,
  args: Record<string, unknown>,
  currentProvider: string | undefined,
): Record<string, unknown> {
  const hasProvider =
    typeof args.provider === "string" && args.provider.trim().length > 0
      ? true
      : typeof args.channel === "string" && args.channel.trim().length > 0;
  const provider = currentProvider?.trim();
  if (toolName !== "message" || hasProvider || !provider) {
    return args;
  }
  return { ...args, provider };
}
