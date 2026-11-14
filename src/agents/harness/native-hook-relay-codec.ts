import { stableStringify } from "@openclaw/normalization-core";
import { isPluginJsonValue } from "../../plugins/host-hook-json.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import { NATIVE_HOOK_INEXACT_NUMBER_PATHS_FIELD } from "./native-hook-relay-constants.js";
import type {
  JsonValue,
  NativeHookRelayInvocation,
  NativeHookRelayInvocationMetadata,
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

// Exact hook-facing names, not policy aliases: Codex reads only `command` here.
const CODEX_COMMAND_INPUT_HOOK_TOOLS = new Set(["Bash", "apply_patch"]);

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

export function readCodexToolInput(rawPayload: JsonValue): Record<string, JsonValue> {
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

/**
 * Inverts a policy rewrite into the `updatedInput` the pinned Codex handler reads.
 * Returns undefined when Codex would drop or misread it, so callers fail closed:
 * Bash and apply_patch keep only `command` (other hook-visible fields must match),
 * MCP replaces its whole argument object, so the rewrite must not carry a number
 * the CLI found altered by parsing, and other tools have no reviewed inverse.
 */
export function resolveCodexUpdatedToolInput(params: {
  rawPayload: JsonValue;
  originalToolInputFingerprint: string;
  candidate: unknown;
}): Record<string, JsonValue> | undefined {
  const payload = isJsonObject(params.rawPayload) ? params.rawPayload : {};
  const toolName = readOptionalNonEmptyString(payload.tool_name) ?? "";
  if (!isJsonObject(payload.tool_input) || !isJsonObject(params.candidate)) {
    return undefined;
  }
  if (toolName.startsWith("mcp__")) {
    const outgoing = isPluginJsonValue(params.candidate)
      ? snapshotJsonObject(params.candidate)
      : undefined;
    return outgoing &&
      keepsOnlyExactNumbers({
        inexactNumberPaths: payload[NATIVE_HOOK_INEXACT_NUMBER_PATHS_FIELD],
        originalToolInputFingerprint: params.originalToolInputFingerprint,
        outgoing,
      })
      ? outgoing
      : undefined;
  }
  if (!CODEX_COMMAND_INPUT_HOOK_TOOLS.has(toolName)) {
    return undefined;
  }
  const { command } = params.candidate;
  // Hooks may mutate the raw input in place; only the fingerprint is the original.
  const original: unknown = JSON.parse(params.originalToolInputFingerprint);
  return typeof command === "string" &&
    command.trim() &&
    isJsonObject(original) &&
    typeof original.command === "string" &&
    stableStringify({ ...params.candidate, command: original.command }) ===
      params.originalToolInputFingerprint
    ? { command }
    : undefined;
}

/**
 * Checks and sends the serialized form, so a plugin object's non-enumerable slots,
 * getters, or toJSON cannot make the checked value differ from the sent one.
 */
function snapshotJsonObject(value: unknown): Record<string, JsonValue> | undefined {
  try {
    const serialized = JSON.stringify(value);
    const snapshot: unknown = JSON.parse(serialized);
    return isPluginJsonValue(snapshot) && isJsonObject(snapshot) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Matches by value, not path: a hook only ever holds the altered number, so a kept
 * copy equals it wherever an array or object edit moved it. An unrelated number
 * with the same value also denies; a copy the hook reformats is not detectable.
 */
function keepsOnlyExactNumbers(params: {
  inexactNumberPaths: unknown;
  originalToolInputFingerprint: string;
  outgoing: Record<string, JsonValue>;
}): boolean {
  if (typeof params.inexactNumberPaths !== "string") {
    return false;
  }
  const paths: unknown = JSON.parse(params.inexactNumberPaths);
  if (!isJsonKeyPathList(paths)) {
    return false;
  }
  if (paths.length === 0) {
    return true;
  }
  const original: unknown = JSON.parse(params.originalToolInputFingerprint);
  const inexactValues = new Set(paths.map((path) => readJsonPath(original, path)));
  return !containsAnyValue(params.outgoing, inexactValues);
}

function isJsonKeyPathList(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every(
      (path: unknown) =>
        Array.isArray(path) && path.every((key: unknown) => typeof key === "string"),
    )
  );
}

function containsAnyValue(value: unknown, targets: ReadonlySet<unknown>): boolean {
  return (
    targets.has(value) ||
    (typeof value === "object" &&
      value !== null &&
      Object.values(value).some((child) => containsAnyValue(child, targets)))
  );
}

function readJsonPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = Reflect.get(current, key);
  }
  return current;
}

export function readCodexToolResponse(rawPayload: JsonValue): unknown {
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
