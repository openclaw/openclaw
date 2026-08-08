import { createHash } from "node:crypto";
import type {
  NativeHookRelayEvent,
  NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { finiteSecondsToTimerSafeMilliseconds } from "openclaw/plugin-sdk/number-runtime";
import type { JsonObject, JsonValue } from "./protocol.js";

/** Codex hook events that can be registered through OpenClaw's native relay. */
export const CODEX_NATIVE_HOOK_RELAY_EVENTS: readonly NativeHookRelayEvent[] = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

const CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS = 250;
const CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS = 1_000;
// The relay starts a niced Node subprocess, so busy hosts can exceed the former
// five-second relay timeout before policy and task-mirroring work completes.
const CODEX_NATIVE_HOOK_RELAY_DEFAULT_TIMEOUT_SEC = 10;

const CODEX_HOOK_MATCHER_NAMES_BY_TOOL_ID: Readonly<Record<string, readonly string[]>> = {
  exec: ["Bash", "exec", "exec_command"],
  apply_patch: ["apply_patch", "Write", "Edit"],
  spawn_agent: ["spawn_agent", "Agent"],
};

type CodexHookEventName = "PreToolUse" | "PostToolUse" | "PermissionRequest" | "Stop";

const CODEX_HOOK_EVENT_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, CodexHookEventName> = {
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  permission_request: "PermissionRequest",
  before_agent_finalize: "Stop",
};

const CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, string> = {
  pre_tool_use: "pre_tool_use",
  post_tool_use: "post_tool_use",
  permission_request: "permission_request",
  before_agent_finalize: "stop",
};

const CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS = [
  "/<session-flags>/config.toml",
  "<session-flags>/config.toml",
] as const;

/** Builds the Codex config overlay that installs trusted command hooks for relay events. */
export function buildCodexNativeHookRelayConfig(params: {
  relay: Pick<
    NativeHookRelayRegistrationHandle,
    "shouldRelayEvent" | "toolMatcherForEvent" | "commandForEvent"
  >;
  events: readonly NativeHookRelayEvent[];
  hookTimeoutSec?: number;
  clearOmittedEvents?: boolean;
  loopDetectionPreToolUseRelay: boolean;
}): JsonObject {
  if (params.events.length === 0) {
    return buildCodexNativeHookRelayDisabledConfig();
  }
  const selectedEvents = new Set<NativeHookRelayEvent>(params.events);
  const config: JsonObject = {
    "features.hooks": true,
  };
  const hookState: JsonObject = {};
  for (const event of CODEX_NATIVE_HOOK_RELAY_EVENTS) {
    const codexEvent = CODEX_HOOK_EVENT_BY_NATIVE_EVENT[event];
    const selected = selectedEvents.has(event);
    const shouldRelay = params.relay.shouldRelayEvent(event);
    // The no-policy marker is part of the shipped Codex fallback contract.
    // Only the Codex-owned loop relay opt-out may omit it.
    const selectedNoopPreToolUse =
      selected && event === "pre_tool_use" && !shouldRelay && params.loopDetectionPreToolUseRelay;
    if (!selected || (!shouldRelay && !selectedNoopPreToolUse)) {
      if (selected || params.clearOmittedEvents) {
        config[`hooks.${codexEvent}`] = [] satisfies JsonValue;
      }
      if (params.clearOmittedEvents) {
        for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
          hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] = {
            enabled: false,
          } satisfies JsonValue;
        }
      }
      continue;
    }
    const timeout = normalizeHookTimeoutSec(params.hookTimeoutSec);
    const command = params.relay.commandForEvent(event, {
      timeoutMs: resolveCodexNativeHookRelayCommandTimeoutMs(timeout),
    });
    const matcher = selectedNoopPreToolUse
      ? undefined
      : buildCodexNativeToolMatcher(params.relay.toolMatcherForEvent(event));
    config[`hooks.${codexEvent}`] = [
      {
        ...(matcher ? { matcher } : {}),
        hooks: [
          {
            type: "command",
            command,
            timeout,
            async: false,
            statusMessage: "OpenClaw native hook relay",
          },
        ],
      },
    ] satisfies JsonValue;
    const state = {
      enabled: true,
      trusted_hash: codexCommandHookTrustedHash({
        event,
        command,
        matcher,
        timeout,
        statusMessage: "OpenClaw native hook relay",
      }),
    };
    for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
      hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] =
        state satisfies JsonValue;
    }
  }
  config["hooks.state"] = hookState;
  return config;
}

/** Builds a Codex config overlay that disables native hooks and clears hook arrays. */
export function buildCodexNativeHookRelayDisabledConfig(): JsonObject {
  return {
    "features.hooks": false,
    "hooks.PreToolUse": [],
    "hooks.PostToolUse": [],
    "hooks.PermissionRequest": [],
    "hooks.Stop": [],
  };
}

export function normalizeHookTimeoutSec(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : CODEX_NATIVE_HOOK_RELAY_DEFAULT_TIMEOUT_SEC;
}

function resolveCodexNativeHookRelayCommandTimeoutMs(hookTimeoutSec: number | undefined): number {
  const parentTimeoutMs =
    finiteSecondsToTimerSafeMilliseconds(normalizeHookTimeoutSec(hookTimeoutSec)) ?? 5_000;
  const parentMarginMs = Math.min(
    CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS,
    Math.max(CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS, Math.floor(parentTimeoutMs / 5)),
  );
  return Math.max(1, parentTimeoutMs - parentMarginMs);
}

function buildCodexNativeToolMatcher(toolNames: readonly string[] | undefined): string | undefined {
  if (toolNames === undefined) {
    return undefined;
  }
  if (toolNames.length === 0) {
    throw new TypeError("Codex native hook matcher requires at least one tool name");
  }
  const nativeNames = new Set<string>();
  let hasCustomToolName = false;
  for (const toolName of toolNames) {
    const canonicalToolName = toolName.trim();
    if (!canonicalToolName || canonicalToolName === "*") {
      throw new TypeError("Codex native hook matcher requires canonical OpenClaw tool ids");
    }
    const nativeAliases = CODEX_HOOK_MATCHER_NAMES_BY_TOOL_ID[canonicalToolName];
    if (!nativeAliases) {
      hasCustomToolName = true;
    }
    for (const nativeName of nativeAliases ?? [canonicalToolName]) {
      nativeNames.add(nativeName);
    }
  }
  const sortedNames = Array.from(nativeNames).toSorted();
  if (!hasCustomToolName && sortedNames.every((toolName) => /^[A-Za-z0-9_]+$/.test(toolName))) {
    return sortedNames.join("|");
  }
  const escapedNames = sortedNames.map((toolName) =>
    toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `(?i)^(?:${escapedNames.join("|")})$`;
}

function codexCommandHookTrustedHash(params: {
  event: NativeHookRelayEvent;
  command: string;
  matcher?: string;
  timeout: number;
  statusMessage: string;
}): string {
  // Keep the match-all matcher omitted rather than null. Codex app-server
  // converts JSON null to an empty TOML string before hashing, which changes the
  // trust identity even though both forms match all tools.
  const identity = {
    event_name: CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[params.event],
    ...(params.matcher ? { matcher: params.matcher } : {}),
    hooks: [
      {
        async: false,
        command: params.command,
        statusMessage: params.statusMessage,
        timeout: params.timeout,
        type: "command",
      },
    ],
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(sortJsonValue(identity)))
    .digest("hex");
  return `sha256:${hash}`;
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  const sorted: JsonObject = {};
  for (const [key, entry] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    sorted[key] = sortJsonValue(entry);
  }
  return sorted;
}
