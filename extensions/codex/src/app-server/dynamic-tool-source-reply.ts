/**
 * Source-reply decisions for Codex dynamic tool results: whether the `message` tool
 * confirmed a current-source reply, whether a `canDeliverSourceReply` tool authored
 * one, and whether either ends the Codex turn.
 */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  captureToolAuthoredSourceReply,
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type ToolAuthoredSourceReplyPayload = NonNullable<
  ReturnType<typeof captureToolAuthoredSourceReply>
>["payload"];

export type CodexToolResultSourceReply = {
  /** The message tool itself marked its current-source reply terminal. */
  toolConfirmed: boolean;
  /** Final (`true`) or progress (`false`) for a confirmed message-tool reply. */
  final: boolean | undefined;
  /** Whether this tool result ends the Codex turn. */
  terminate: true | undefined;
};

/**
 * Resolves the source-reply facts of one Codex dynamic tool result. A reply authored by
 * a `canDeliverSourceReply` tool is appended to `payloads` for host delivery; result
 * handling is synchronous here, so its transcript write is best effort and never
 * delays delivery.
 */
export function resolveCodexToolResultSourceReply(params: {
  sourceReplyDeliveryMode: EmbeddedRunAttemptParams["sourceReplyDeliveryMode"];
  canDeliverSourceReply: boolean | undefined;
  toolName: string;
  call: { callId: string; turnId: string };
  resultIsError: boolean;
  rawResult: AgentToolResult<unknown>;
  result: AgentToolResult<unknown>;
  deliveredSourceReply: boolean;
  executedArgs: Record<string, unknown>;
  config: Parameters<typeof captureToolAuthoredSourceReply>[0]["cfg"];
  hookContext: { agentId?: string; sessionId?: string; sessionKey?: string; runId?: string };
  payloads: ToolAuthoredSourceReplyPayload[];
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
  return { toolConfirmed, final, terminate };
}

function captureCodexToolAuthoredSourceReply(
  params: Parameters<typeof resolveCodexToolResultSourceReply>[0],
): boolean | undefined {
  if (params.canDeliverSourceReply !== true || params.resultIsError) {
    return undefined;
  }
  const captured = captureToolAuthoredSourceReply({
    result: params.rawResult,
    toolName: params.toolName,
    toolCallId: params.call.callId,
    idempotencyScope: params.hookContext.runId ?? params.call.turnId,
    cfg: params.config,
    sessionKey: params.hookContext.sessionKey,
    sessionId: params.hookContext.sessionId,
    agentId: params.hookContext.agentId,
    runId: params.hookContext.runId,
    log: embeddedAgentLog,
  });
  if (!captured) {
    return undefined;
  }
  params.payloads.push(captured.payload);
  void captured.persistence;
  return captured.payload.sourceReplyFinal;
}

function isToolResultYield(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  if (!isRecord(details) || typeof details.status !== "string") {
    return false;
  }
  return details.status.trim().toLowerCase() === "yielded";
}
