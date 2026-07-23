import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { ExecAsk, ExecSecurity } from "../../infra/exec-approvals.js";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
} from "../../infra/plugin-approvals.js";
import { sliceUtf16Safe, truncateUtf16Safe } from "../../utils.js";
import { callGatewayTool } from "../tools/gateway.js";

export type ClaudeNativeToolApprovalPlan = "allow" | "deny" | "prompt";
export type ClaudeNativeToolApprovalDecision = "allow-once" | "allow-always" | "deny";
export type ClaudeNativeToolApprovalOutcome =
  | { kind: "allow"; grantAlways: boolean }
  | { kind: "deny"; reason: "policy-oversized" | "user" | "unavailable" };

const CLAUDE_NATIVE_TOOL_DESCRIPTION_HEAD_CHARS = 300;
const CLAUDE_NATIVE_TOOL_DESCRIPTION_TAIL_CHARS = 80;
const CLAUDE_NATIVE_TOOL_DESCRIPTION_MAX_CHARS =
  CLAUDE_NATIVE_TOOL_DESCRIPTION_HEAD_CHARS + CLAUDE_NATIVE_TOOL_DESCRIPTION_TAIL_CHARS;
const CLAUDE_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS = 10_000;
const CLAUDE_NATIVE_TOOL_ALLOWED_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ClaudeNativeToolApprovalDecision[];
// A standing grant must never be minted from a partially displayed input, so
// oversized inputs offer one-shot decisions only.
const CLAUDE_NATIVE_TOOL_TRUNCATED_DECISIONS = [
  "allow-once",
  "deny",
] as const satisfies readonly ClaudeNativeToolApprovalDecision[];
// Claude Code's Bash tool is arbitrary shell execution, so a name-wide grant is unrestricted.
// A truncated command can hide a destructive middle, so oversized Bash requests fail closed.
const CLAUDE_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL = "Bash";

export function resolveClaudeNativeToolApprovalPlan(execPermission: {
  security: ExecSecurity;
  ask: ExecAsk;
}): ClaudeNativeToolApprovalPlan {
  if (execPermission.security === "deny") {
    return "deny";
  }
  // ask "off" means never prompt (exec mode "allowlist" relies on this): full
  // security auto-allows, anything stricter denies without an approval request.
  if (execPermission.ask === "off") {
    return execPermission.security === "full" ? "allow" : "deny";
  }
  return "prompt";
}

type ClaudeNativeToolDescription = { text: string; truncated: boolean };

/**
 * The gateway caps approval descriptions (PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH),
 * so full inputs cannot ride this channel. Head+tail display defeats padded
 * prefixes hiding an executable tail, and the quantified marker makes a partial
 * view an explicit operator decision. Accepted tradeoff: the middle stays
 * unreviewable; oversized inputs therefore never earn allow-always.
 */
function formatClaudeNativeToolDescription(
  toolInput: Record<string, unknown>,
): ClaudeNativeToolDescription {
  const compact = JSON.stringify(toolInput) ?? "{}";
  if (compact.length <= CLAUDE_NATIVE_TOOL_DESCRIPTION_MAX_CHARS) {
    return { text: compact, truncated: false };
  }
  const head = truncateUtf16Safe(compact, CLAUDE_NATIVE_TOOL_DESCRIPTION_HEAD_CHARS);
  const tail = sliceUtf16Safe(compact, compact.length - CLAUDE_NATIVE_TOOL_DESCRIPTION_TAIL_CHARS);
  const hiddenChars = compact.length - head.length - tail.length;
  return {
    text: `${head} …[+${hiddenChars} chars hidden]… ${tail}`,
    truncated: true,
  };
}

function formatClaudeNativeToolTitle(toolName: string): string {
  return truncateUtf16Safe(`Claude native tool: ${toolName}`, PLUGIN_APPROVAL_TITLE_MAX_LENGTH);
}

function resolveClaudeNativeToolAllowedDecisions(params: {
  ask: ExecAsk;
  toolName: string;
  descriptionTruncated: boolean;
}): readonly ClaudeNativeToolApprovalDecision[] {
  return params.ask === "always" ||
    params.toolName === CLAUDE_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL ||
    params.descriptionTruncated
    ? CLAUDE_NATIVE_TOOL_TRUNCATED_DECISIONS
    : CLAUDE_NATIVE_TOOL_ALLOWED_DECISIONS;
}

function toAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("Claude native tool approval aborted");
}

async function raceClaudeNativeToolApprovalAbort<T>(
  promise: Promise<T>,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  if (!abortSignal) {
    return promise;
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (abortSignal.aborted) {
      reject(toAbortError(abortSignal.reason));
      return;
    }
    onAbort = () => reject(toAbortError(abortSignal.reason));
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) {
      abortSignal.removeEventListener("abort", onAbort);
    }
  }
}

function waitForClaudeNativeToolApproval(params: {
  id: string;
  gatewayTimeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<{ id?: string; decision?: unknown }> {
  return raceClaudeNativeToolApprovalAbort(
    callGatewayTool(
      "plugin.approval.waitDecision",
      { timeoutMs: params.gatewayTimeoutMs },
      { id: params.id },
      // Abort must reach the RPC too, or the gateway keeps the approval prompt
      // live for its full timeout after the Claude run already ended.
      { signal: params.abortSignal },
    ),
    params.abortSignal,
  );
}

export async function requestClaudeNativeToolApproval(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  pluginId: string;
  sessionKey?: string;
  agentId?: string;
  toolCallId?: string;
  abortSignal?: AbortSignal;
  ask: ExecAsk;
}): Promise<ClaudeNativeToolApprovalOutcome> {
  try {
    const timeoutMs = DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
    const gatewayTimeoutMs =
      addTimerTimeoutGraceMs(timeoutMs, CLAUDE_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS) ??
      timeoutMs + CLAUDE_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS;
    const description = formatClaudeNativeToolDescription(params.toolInput);
    if (params.toolName === CLAUDE_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL && description.truncated) {
      return { kind: "deny", reason: "policy-oversized" };
    }
    const allowedDecisions = resolveClaudeNativeToolAllowedDecisions({
      ask: params.ask,
      toolName: params.toolName,
      descriptionTruncated: description.truncated,
    });
    const requestResult: {
      id?: string;
      decision?: unknown;
    } = await raceClaudeNativeToolApprovalAbort(
      callGatewayTool(
        "plugin.approval.request",
        { timeoutMs: gatewayTimeoutMs },
        {
          pluginId: params.pluginId,
          toolName: params.toolName,
          toolCallId: params.toolCallId,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          title: formatClaudeNativeToolTitle(params.toolName),
          description: description.text,
          severity: "warning",
          allowedDecisions,
          timeoutMs,
          twoPhase: true,
        },
        { expectFinal: false, signal: params.abortSignal },
      ),
      params.abortSignal,
    );
    const id = typeof requestResult?.id === "string" ? requestResult.id : "";
    if (!id) {
      return { kind: "deny", reason: "unavailable" };
    }
    let decision: unknown;
    if (Object.hasOwn(requestResult ?? {}, "decision")) {
      decision = requestResult.decision;
    } else {
      const waitResult = await waitForClaudeNativeToolApproval({
        id,
        gatewayTimeoutMs,
        abortSignal: params.abortSignal,
      });
      decision = waitResult?.id === id ? waitResult.decision : undefined;
    }
    if (params.abortSignal?.aborted) {
      return { kind: "deny", reason: "unavailable" };
    }
    if (decision === "allow-once") {
      return { kind: "allow", grantAlways: false };
    }
    if (decision === "allow-always" && allowedDecisions.includes(decision)) {
      return { kind: "allow", grantAlways: true };
    }
    if (decision === "deny") {
      return { kind: "deny", reason: "user" };
    }
    return { kind: "deny", reason: "unavailable" };
  } catch {
    return { kind: "deny", reason: "unavailable" };
  }
}
