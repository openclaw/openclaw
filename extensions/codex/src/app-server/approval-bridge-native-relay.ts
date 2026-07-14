import {
  type BeforeToolCallFailureDisposition,
  hasNativeHookRelayInvocation,
  invokeNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
  type NativeHookRelayProcessResponse,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatCodexDisplayText } from "../command-formatters.js";
import { type JsonObject } from "./protocol.js";

const UNAVAILABLE_NATIVE_RELAY_ERRORS = new Set([
  "native hook relay not found",
  "native hook relay expired",
  "native hook relay bridge stale registration",
]);

type ApprovalContext = {
  approvalId?: string;
};

export type NativeRelayPolicyDecision =
  | {
      blocked: true;
      reason: string;
      failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">;
    }
  | { blocked: false };

type NativeRelayToolPolicyOutcome =
  | {
      handled: true;
      blocked: true;
      reason: string;
      failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">;
    }
  | {
      handled: true;
      blocked?: false;
      outcome?: "approved-once" | "approved-session";
    };

export async function runNativeRelayToolPolicyForApprovalRequest(params: {
  method: string;
  requestParams: JsonObject | undefined;
  context: ApprovalContext;
  policyRequest: { toolName: string; params: JsonObject };
  nativeHookRelay?: Pick<
    NativeHookRelayRegistrationHandle,
    "allowedEvents" | "generation" | "relayId"
  >;
  ignoreUnavailable?: boolean;
  cwd?: string;
  signal?: AbortSignal;
  readDecision: (response: NativeHookRelayProcessResponse | undefined) => NativeRelayPolicyDecision;
}): Promise<NativeRelayToolPolicyOutcome | undefined> {
  if (
    params.method !== "item/commandExecution/requestApproval" ||
    !params.nativeHookRelay?.allowedEvents.includes("pre_tool_use")
  ) {
    return undefined;
  }
  const payload = buildNativeRelayPreToolUsePayload({
    requestParams: params.requestParams,
    policyRequest: params.policyRequest,
    context: params.context,
    cwd: params.cwd,
  });
  if (!payload) {
    return undefined;
  }
  if (
    hasNativeHookRelayInvocation({
      relayId: params.nativeHookRelay.relayId,
      event: "pre_tool_use",
      toolUseId: params.context.approvalId,
    })
  ) {
    try {
      const approvalOutcome = await resolveNativeHookRelayDeferredToolApproval({
        relayId: params.nativeHookRelay.relayId,
        toolUseId: params.context.approvalId,
        signal: params.signal,
      });
      return mapNativeRelayApprovalOutcome(approvalOutcome);
    } catch (error) {
      return nativeRelayUnavailableOutcome(params.ignoreUnavailable, error);
    }
  }
  try {
    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: params.nativeHookRelay.relayId,
      generation: params.nativeHookRelay.generation,
      event: "pre_tool_use",
      rawPayload: payload,
      requireGeneration: true,
    });
    const decision = params.readDecision(response);
    if (decision.blocked) {
      return {
        handled: true,
        blocked: true,
        reason: decision.reason,
        ...(decision.failureDisposition ? { failureDisposition: decision.failureDisposition } : {}),
      };
    }
    const approvalOutcome = await resolveNativeHookRelayDeferredToolApproval({
      relayId: params.nativeHookRelay.relayId,
      toolUseId: params.context.approvalId,
      signal: params.signal,
    });
    return mapNativeRelayApprovalOutcome(approvalOutcome);
  } catch (error) {
    return nativeRelayUnavailableOutcome(params.ignoreUnavailable, error);
  }
}

function mapNativeRelayApprovalOutcome(
  approvalOutcome: Awaited<ReturnType<typeof resolveNativeHookRelayDeferredToolApproval>>,
): NativeRelayToolPolicyOutcome {
  if (approvalOutcome?.outcome === "denied") {
    return {
      handled: true,
      blocked: true,
      reason: approvalOutcome.reason,
      ...(approvalOutcome.failureDisposition
        ? { failureDisposition: approvalOutcome.failureDisposition }
        : {}),
    };
  }
  return {
    handled: true,
    ...(approvalOutcome?.outcome === "approved-once" ? { outcome: approvalOutcome.outcome } : {}),
  };
}

function nativeRelayUnavailableOutcome(
  ignoreUnavailable: boolean | undefined,
  error: unknown,
): NativeRelayToolPolicyOutcome | undefined {
  const message = formatErrorMessage(error);
  if (ignoreUnavailable && UNAVAILABLE_NATIVE_RELAY_ERRORS.has(message)) {
    return undefined;
  }
  return {
    handled: true,
    blocked: true,
    reason: `OpenClaw native hook relay unavailable for Codex app-server approval: ${formatCodexDisplayText(
      message,
    )}`,
    failureDisposition: "failed",
  };
}

function buildNativeRelayPreToolUsePayload(params: {
  requestParams: JsonObject | undefined;
  policyRequest: { toolName: string; params: JsonObject };
  context: ApprovalContext;
  cwd?: string;
}): JsonObject | undefined {
  const command = readString(params.policyRequest.params, "command");
  if (!command) {
    return undefined;
  }
  const turnId = readString(params.requestParams, "turnId");
  return {
    hook_event_name: "PreToolUse",
    openclaw_approval_mode: "report",
    tool_name: "exec_command",
    ...(params.context.approvalId ? { tool_use_id: params.context.approvalId } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(turnId ? { turn_id: turnId } : {}),
    tool_input: {
      ...params.policyRequest.params,
      command,
      cmd: command,
    },
  };
}

function readString(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
