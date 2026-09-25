import { stableStringify } from "@openclaw/normalization-core";
import { normalizeToolPolicyName } from "../tool-policy.js";
import { codexNativeHookRelayResponseCodec } from "./native-hook-relay-response-codec.js";
import type {
  JsonValue,
  NativeHookRelayInvocation,
  NativeHookRelayInvocationMetadata,
  NativeHookRelayProviderAdapter,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";
import {
  isJsonObject,
  readOptionalBoolean,
  readOptionalNonEmptyString,
  shellQuoteArgs,
} from "./native-hook-relay-utils.js";

const CODEX_NATIVE_HOOK_TOOL_NAME_ALIASES: Record<string, string> = {
  exec_command: "exec",
  write: "apply_patch",
  edit: "apply_patch",
  agent: "spawn_agent",
};

export const codexNativeHookRelayProviderAdapter: NativeHookRelayProviderAdapter = {
  readToolInput: readCodexToolInput,
  readToolResponse: readCodexToolResponse,
  ...codexNativeHookRelayResponseCodec,
  renderBeforeAgentFinalizeReviseResponse: (reason) => ({
    stdout: `${JSON.stringify({
      decision: "block",
      reason,
    })}\n`,
    stderr: "",
    exitCode: 0,
  }),
  renderBeforeAgentFinalizeStopResponse: (reason) => ({
    stdout: `${JSON.stringify({
      continue: false,
      ...(reason?.trim() ? { stopReason: reason.trim() } : {}),
    })}\n`,
    stderr: "",
    exitCode: 0,
  }),
};

export function normalizeNativeHookInvocation(params: {
  registration: NativeHookRelayRegistration;
  event: NativeHookRelayInvocation["event"];
  rawPayload: JsonValue;
}): NativeHookRelayInvocation {
  const metadata = normalizeCodexHookMetadata(params.rawPayload);
  return {
    provider: params.registration.provider,
    relayId: params.registration.relayId,
    event: params.event,
    ...metadata,
    ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
    sessionId: params.registration.sessionId,
    ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
    runId: params.registration.runId,
    rawPayload: params.rawPayload,
    receivedAt: new Date().toISOString(),
  };
}

function normalizeCodexHookMetadata(rawPayload: JsonValue): NativeHookRelayInvocationMetadata {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  const metadata: NativeHookRelayInvocationMetadata = {};
  for (const [key, source] of [
    ["nativeEventName", "hook_event_name"],
    ["cwd", "cwd"],
    ["model", "model"],
    ["turnId", "turn_id"],
    ["transcriptPath", "transcript_path"],
    ["permissionMode", "permission_mode"],
    ["stopHookActive", "stop_hook_active"],
    ["lastAssistantMessage", "last_assistant_message"],
    ["toolName", "tool_name"],
    ["toolUseId", "tool_use_id"],
  ] as const) {
    if (key === "stopHookActive") {
      const value = readOptionalBoolean(payload[source]);
      if (value !== undefined) {
        metadata[key] = value;
      }
    } else {
      const value = readOptionalNonEmptyString(payload[source]);
      if (value) {
        metadata[key] = value;
      }
    }
  }
  return metadata;
}

function readCodexToolInput(rawPayload: JsonValue): Record<string, JsonValue> {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  const toolInput = payload.tool_input;
  if (isJsonObject(toolInput)) {
    const toolName = readOptionalNonEmptyString(payload.tool_name);
    return normalizeCodexToolInput(
      normalizeNativeHookToolName(toolName),
      toolInput as Record<string, JsonValue>,
    );
  }
  if (toolInput === undefined) {
    return {};
  }
  return { value: toolInput as JsonValue };
}

function normalizeCodexToolInput(
  toolName: string,
  toolInput: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const command = normalizeCodexCommand(toolInput.cmd);
  if (toolName !== "exec" || command === undefined) {
    return toolInput;
  }
  return {
    ...toolInput,
    command,
  };
}

function normalizeCodexCommand(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((part): part is string => typeof part === "string")) {
    return shellQuoteArgs(value);
  }
  return undefined;
}

export function nativeHookRelayParamsWereRewritten(
  originalFingerprint: string,
  candidate: unknown,
): boolean {
  if (candidate === undefined) {
    return false;
  }
  return stableStringify(candidate) !== originalFingerprint;
}

function readCodexToolResponse(rawPayload: JsonValue): unknown {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  return payload.tool_response;
}

export function readNativeHookRelayApprovalMode(rawPayload: JsonValue): "report" | undefined {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  return payload.openclaw_approval_mode === "report" ? "report" : undefined;
}

export function normalizeNativeHookToolName(toolName: string | undefined): string {
  const normalized = normalizeToolPolicyName(toolName ?? "tool");
  return CODEX_NATIVE_HOOK_TOOL_NAME_ALIASES[normalized] ?? normalized;
}
