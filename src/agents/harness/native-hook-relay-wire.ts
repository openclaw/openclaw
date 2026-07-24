import type { BeforeToolCallFailureDisposition } from "../agent-tools.before-tool-call.js";

export const NATIVE_HOOK_RELAY_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

export const NATIVE_HOOK_RELAY_PROVIDERS = ["codex"] as const;

export type NativeHookRelayEvent = (typeof NATIVE_HOOK_RELAY_EVENTS)[number];
export type NativeHookRelayProvider = (typeof NATIVE_HOOK_RELAY_PROVIDERS)[number];

export type NativeHookRelayProcessResponse = {
  stdout: string;
  stderr: string;
  exitCode: number;
  failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">;
};

export function readNativeHookRelayProvider(value: unknown): NativeHookRelayProvider {
  if (typeof value === "string" && NATIVE_HOOK_RELAY_PROVIDERS.includes(value as never)) {
    return value as NativeHookRelayProvider;
  }
  throw new Error("unsupported native hook relay provider");
}

export function readNativeHookRelayEvent(value: unknown): NativeHookRelayEvent {
  if (typeof value === "string" && NATIVE_HOOK_RELAY_EVENTS.includes(value as never)) {
    return value as NativeHookRelayEvent;
  }
  throw new Error("unsupported native hook relay event");
}

export function renderNativeHookRelayUnavailableResponse(params: {
  provider: unknown;
  event: unknown;
  preToolUseUnavailable?: unknown;
  message?: string;
}): NativeHookRelayProcessResponse {
  readNativeHookRelayProvider(params.provider);
  const event = readNativeHookRelayEvent(params.event);
  const message = params.message?.trim() || "Native hook relay unavailable";
  if (event === "pre_tool_use") {
    if (params.preToolUseUnavailable === "noop") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return {
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    };
  }
  if (event === "permission_request") {
    return {
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message,
          },
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}
