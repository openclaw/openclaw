Total output lines: 2383

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { privateFileStoreSync } from "../../infra/private-file-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { hasGlobalHooks } from "../../plugins/hook-runner-global.js";
import { PluginApprovalResolutions } from "../../plugins/types.js";
import {
  cancelDeferredPluginToolApproval,
  hasBeforeToolCallPolicy,
  requestDeferredPluginToolApproval,
  runBeforeToolCallHook,
  type DeferredPluginToolApproval,
} from "../agent-tools.before-tool-call.js";
import { stableStringify } from "../stable-stringify.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import { normalizeToolName } from "../tool-policy.js";
import { callGatewayTool } from "../tools/gateway.js";
import { runAgentHarnessAfterToolCallHook } from "./hook-helpers.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "./lifecycle-hook-helpers.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const NATIVE_HOOK_RELAY_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

const NATIVE_HOOK_RELAY_PROVIDERS = ["codex"] as const;

export type NativeHookRelayEvent = (typeof NATIVE_HOOK_RELAY_EVENTS)[number];
export type NativeHookRelayProvider = (typeof NATIVE_HOOK_RELAY_PROVIDERS)[number];

export type NativeHookRelayInvocation = {
  provider: NativeHookRelayProvider;
  relayId: string;
  event: NativeHookRelayEvent;
  nativeEventName?: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  cwd?: string;
  model?: string;
  turnId?: string;
  transcriptPath?: string;
  permissionMode?: string;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  toolName?: string;
  toolUseId?: string;
  rawPayload: JsonValue;
  receivedAt: string;
};

export type NativeHookRelayProcessResponse = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type NativeHookRelayRegistration = {
  relayId: string;
  provider: NativeHookRelayProvider;
  generationMismatchGraceExpiresAtMs?: number;
  generationMismatchGraceAcceptedGeneration?: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  runId: string;
  channelId?: string;
  allowedEvents: readonly NativeHookRelayEvent[];
  expiresAtMs: number;
  signal?: AbortSignal;
};

export type NativeHookRelayRegistrationHandle = NativeHookRelayRegistration & {
  generation?: string;
  shouldRelayEvent: (event: NativeHookRelayEvent) => boolean;
  commandForEvent: (event: NativeHookRelayEvent) => string;
  renew: (ttlMs?: number) => void;
  unregister: () => void;
};

export type RegisterNativeHookRelayParams = {
  provider: NativeHookRelayProvider;
  relayId?: string;
  generation?: string;
  generationMismatchGraceMs?: number;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  runId: string;
  channelId?: string;
  allowedEvents?: readonly NativeHookRelayEvent[];
  ttlMs?: number;
  command?: NativeHookRelayCommandOptions;
  signal?: AbortSignal;
};

export type NativeHookRelayCommandOptions = {
  executable?: string;
  nice?: number | false;
  nodeExecutable?: string;
  timeoutMs?: number;
};

type NativeHookRelayPreToolUseUnavailableMode = "noop" | "loop-detection-only";

export type InvokeNativeHookRelayParams = {
  provider: unknown;
  relayId: unknown;
  generation?: unknown;
  event: unknown;
  rawPayload: unknown;
  requireGeneration?: boolean;
};

export type InvokeNativeHookRelayBridgeParams = InvokeNativeHookRelayParams & {
  registrationTimeoutMs?: number;
  timeoutMs?: number;
};

type NativeHookRelayInvocationMetadata = Partial<
  Pick<
    NativeHookRelayInvocation,
    | "nativeEventName"
    | "cwd"
    | "model"
    | "turnId"
    | "transcriptPath"
    | "permissionMode"
    | "stopHookActive"
    | "lastAssistantMessage"
    | "toolName"
    | "toolUseId"
  >
>;

type NativeHookRelayProviderAdapter = {
  normalizeMetadata: (rawPayload: JsonValue) => NativeHookRelayInvocationMetadata;
  readToolInput: (rawPayload: JsonValue) => Record<string, JsonValue>;
  readToolResponse: (rawPayload: JsonValue) => unknown;
  renderNoopResponse: (event: NativeHookRelayEvent) => NativeHookRelayProcessResponse;
  renderPreToolUseBlockResponse: (reason: string) => NativeHookRelayProcessResponse;
  renderBeforeAgentFinalizeReviseResponse: (reason: string) => NativeHookRelayProcessResponse;
  renderBeforeAgentFinalizeStopResponse: (reason?: string) => NativeHookRelayProcessResponse;
  renderPermissionDecisionResponse: (
    decision: NativeHookRelayPermissionDecision,
    message?: string,
  ) => NativeHookRelayProcessResponse;
};

const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RELAY_TIMEOUT_MS = 5_000;
const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
const PERMISSION_ALLOW_ALWAYS_TTL_MS = 30 * 60 * 1000;
const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;
const MAX_NATIVE_HOOK_RELAY_JSON_DEPTH = 64;
const MAX_NATIVE_HOOK_RELAY_JSON_NODES = 20_000;
const MAX_NATIVE_HOOK_RELAY_STRING_LENGTH = 1_000_000;
const MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH = 4_000_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_STRING_LENGTH = 4_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_TOTAL_STRING_LENGTH = 20_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS = 50;
const MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS = 50;
const MAX_PERMISSION_FALLBACK_KEYS = 200;
const MAX_PERMISSION_FALLBACK_KEY_CHARS = 240;
const MAX_PERMISSION_FINGERPRINT_SORT_KEYS = 200;
const MAX_APPROVAL_TITLE_LENGTH = 80;
const MAX_APPROVAL_DESCRIPTION_LENGTH = 700;
const MAX_PERMISSION_APPROVALS_PER_WINDOW = 12;
const PERMISSION_APPROVAL_WINDOW_MS = 60_000;
const MAX_PERMISSION_ALLOW_ALWAYS_ENTRIES = 512;
const MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES = 5_000_000;
const MAX_NATIVE_HOOK_BRIDGE_RESPONSE_BYTES = 5_000_000;
const NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS = 25;
const NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS = 250;
const NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR =
  "native hook relay bridge stale registration";
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const log = createSubsystemLogger("agents/harness/native-hook-relay");

function resolveNativeHookRelayExpiresAtMs(ttlMs: number | undefined): number | undefined {
  return resolveExpiresAtMsFromDurationMs(normalizePositiveInteger(ttlMs, DEFAULT_RELAY_TTL_MS));
}

type NativeHookRelayPermissionDecision = "allow" | "deny";

type NativeHookRelayPermissionApprovalResult =
  | NativeHookRelayPermissionDecision
  | "allow-always"
  | "defer";

type NativeHookRelaySharedState = {
  relays: Map<string, ActiveNativeHookRelayRegistration>;
  relayBridges: Map<string, NativeHookRelayBridgeRegistration>;
  invocations: NativeHookRelayInvocation[];
  pendingPermissionApprovals: Map<string, Promise<NativeHookRelayPermissionApprovalResult>>;
  pendingPreToolUseApprovals: Map<string, NativeHookRelayPreToolUseApproval>;
  permissionApprovalWindows: Map<string, number[]>;
  permissionAllowAlwaysApprovals: Map<string, { expiresAtMs: number }>;
};

type ActiveNativeHookRelayRegistration = NativeHookRelayRegistration & {
  generation: string;
};

type ActiveNativeHookRelayRegistrationHandle = NativeHookRelayRegistrationHandle & {
  generation: string;
};

const NATIVE_HOOK_RELAY_STATE_SYMBOL = Symbol.for("openclaw.nativeHookRelay.state");

function getNativeHookRelaySharedState(): NativeHookRelaySharedState {
  const globalRecord = globalThis as typeof globalThis & {
    [key: symbol]: NativeHookRelaySharedState | undefined;
  };
  globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL] ??= {
    relays: new Map<string, ActiveNativeHookRelayRegistration>(),
    relayBridges: new Map<string, NativeHookRelayBridgeRegistration>(),
    invocations: [],
    pendingPermissionApprovals: new Map<string, Promise<NativeHookRelayPermissionApprovalResult>>(),
    pendingPreToolUseApprovals: new Map<string, NativeHookRelayPreToolUseApproval>(),
    permissionApprovalWindows: new Map<string, number[]>(),
    permissionAllowAlwaysApprovals: new Map<string, { expiresAtMs: number }>(),
  };
  return globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL];
}

const nativeHookRelayState = getNativeHookRelaySharedState();
const relays = nativeHookRelayState.relays;
const relayBridges = nativeHookRelayState.relayBridges;
const invocations = nativeHookRelayState.invocations;
const pendingPermissionApprovals = nativeHookRelayState.pendingPermissionApprovals;
const pendingPreToolUseApprovals = nativeHookRelayState.pendingPreToolUseApprovals;
const permissionApprovalWindows = nativeHookRelayState.permissionApprovalWindows;
const permissionAllowAlwaysApprovals = nativeHookRelayState.permissionAllowAlwaysApprovals;

type NativeHookRelayPermissionApprovalRequest = {
  provider: NativeHookRelayProvider;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  toolName: string;
  toolCallId?: string;
  cwd?: string;
  model?: string;
  toolInput: Record<string, JsonValue>;
  signal?: AbortSignal;
};

type NativeHookRelayPermissionApprovalRequester = (
  request: NativeHookRelayPermissionApprovalRequest,
) => Promise<NativeHookRelayPermissionApprovalResult>;

type NativeHookRelayDeferredToolApprovalRequester = typeof requestDeferredPluginToolApproval;

type NativeHookRelayPreToolUseApproval = {
  deferredApproval: DeferredPluginToolApproval;
  originalParamsFingerprint: string;
  resolutionPromise?: Promise<NativeHookRelayDeferredApprovalOutcome>;
};

export type NativeHookRelayDeferredApprovalOutcome =
  | {
      handled: true;
      outcome: "approved-once";
    }
  | {
      handled: true;
      outcome: "denied";
      reason: string;
    };

type NativeHookRelayBridgeRegistration = {
  relayId: string;
  registryPath: string;
  token: string;
  server: Server;
};

type NativeHookRelayBridgeRecord = {
  version: 1;
  relayId: string;
  pid: number;
  hostname: string;
  port: number;
  token: string;
  expiresAtMs: number;
};

type NativeHookRelayBridgeRequestAuth = {
  provider: NativeHookRelayProvider;
  relayId: string;
  token: string;
  registration: ActiveNativeHookRelayRegistration;
  bridge: NativeHookRelayBridgeRegistration;
};

let nativeHookRelayPermissionApprovalRequester: NativeHookRelayPermissionApprovalRequester =
  requestNativeHookRelayPermissionApproval;
let nativeHookRelayDeferredToolApprovalRequester: NativeHookRelayDeferredToolApprovalRequester =
  requestDeferredPluginToolApproval;

const NATIVE_HOOK_TOOL_NAME_ALIASES: Record<string, string> = {
  exec_command: "exec",
};

const nativeHookRelayProviderAdapters: Record<
  NativeHookRelayProvider,
  NativeHookRelayProviderAdapter
> = {
  codex: {
    normalizeMetadata: normalizeCodexHookMetadata,
    readToolInput: readCodexToolInput,
    readToolResponse: readCodexToolResponse,
    renderNoopResponse: () => {
      // Codex treats empty stdout plus exit 0 as no decision/no additional context.
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    renderPreToolUseBlockResponse: (reason) => ({
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    }),
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
    renderPermissionDecisionResponse: (decision, message) => ({
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision:
            decision === "allow"
              ? { behavior: "allow" }
              : {
                  behavior: "deny",
                  message: message?.trim() || "Denied by OpenClaw",
                },
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    }),
  },
};

export function registerNativeHookRelay(
  params: RegisterNativeHookRelayParams,
): ActiveNativeHookRelayRegistrationHandle {
  pruneExpiredNativeHookRelays();
  pruneNativeHookRelayPermissionAllowAlways();
  const relayId = normalizeRelayId(params.relayId) ?? randomUUID();
  const generation = normalizeRelayGeneration(params.generation) ?? randomUUID();
  const generationMismatchGraceMs = normalizePositiveInteger(params.generationMismatchGraceMs, 0);
  const now = Date.now();
  const expiresAtMs = resolveNativeHookRelayExpiresAtMs(params.ttlMs);
  if (expiresAtMs === undefined) {
    throw new Error("Native hook relay expiry is outside the supported Date range");
  }
  const allowedEvents = normalizeAllowedEvents(params.allowedEvents);
  unregisterNativeHookRelay(relayId);
  const registration: ActiveNativeHookRelayRegistration = {
    relayId,
    provider: params.provider,
    generation,
    ...(generationMismatchGraceMs > 0
      ? { generationMismatchGraceExpiresAtMs: now + generationMismatchGraceMs }
      : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.config ? { config: params.config } : {}),
    runId: params.runId,
    ...(params.channelId ? { channelId: params.channelId } : {}),
    allowedEvents,
    expiresAtMs,
    ...(params.signal ? { signal: params.signal } : {}),
  };
  relays.set(relayId, registration);
  registerNativeHookRelayBridge(registration);
  const handle: ActiveNativeHookRelayRegistrationHandle = {
    ...registration,
    shouldRelayEvent: (event) => nativeHookRelayEventHasLocalWork(registration, event),
    commandForEvent: (event) =>
      buildNativeHookRelayCommand({
        provider: params.provider,
        relayId,
        generation: registration.generation,
        event,
        preToolUseUnavailable: resolveNativeHookRelayPreToolUseUnavailableMode({
          registration,
          event,
        }),
        nice: params.command?.nice,
        timeoutMs: params.command?.timeoutMs,
        executable: params.command?.executable,
        nodeExecutable: params.command?.nodeExecutable,
      }),
    renew: (ttlMs) => {
      const current = relays.get(relayId);
      if (current !== registration) {
        return;
      }
      const renewedExpiresAtMs = resolveNativeHookRelayExpiresAtMs(ttlMs);
      if (renewedExpiresAtMs === undefined) {
        return;
      }
      current.expiresAtMs = renewedExpiresAtMs;
      handle.expiresAtMs = renewedExpiresAtMs;
      const bridge = relayBridges.get(relayId);
      if (bridge) {
        writeNativeHookRelayBridgeRecordForRegistration(current, bridge);
      }
    },
    unregister: () => unregisterNativeHookRelay(relayId, registration),
  };
  return handle;
}

function unregisterNativeHookRelay(
  relayId: string,
  expectedRegistration?: ActiveNativeHookRelayRegistration,
): void {
  if (expectedRegistration && relays.get(relayId) !== expectedRegistration) {
    return;
  }
  unregisterNativeHookRelayBridge(relayId);
  relays.delete(relayId);
  removeNativeHookRelayInvocations(relayId);
  removeNativeHookRelayPreToolUseApprovals(relayId);
  removeNativeHookRelayPermissionState(relayId);
}

function normalizeRelayId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error("native hook relay id must be non-empty, compact, and URL-safe");
  }
  return trimmed;
}

function normalizeRelayGeneration(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error("native hook relay generation must be non-empty, compact, and URL-safe");
  }
  return trimmed;
}

function resolveNativeHookRelayNicePrefix(value: number | false | undefined): string[] {
  if (process.platform === "win32" || value === false || value === undefined) {
    return [];
  }
  const nice = normalizePositiveInteger(value, 0);
  if (nice <= 0) {
    return [];
  }
  return ["nice", "-n", String(nice)];
}

export function buildNativeHookRelayCommand(params: {
  provider: NativeHookRelayProvider;
  relayId: string;
  generation?: string;
  event: NativeHookRelayEvent;
  preToolUseUnavailable?: NativeHookRelayPreToolUseUnavailableMode;
  timeoutMs?: number;
  executable?: string;
  nice?: number | false;
  nodeExecutable?: string;
}): string {
  const timeoutMs = normalizePositiveInteger(params.timeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
  const executable = params.executable ?? resolveOpenClawCliExecutable();
  const argv =
    executable === "openclaw"
      ? ["openclaw"]
      : [params.nodeExecutable ?? process.execPath, executable];
  const nicePrefix = resolveNativeHookRelayNicePrefix(params.nice);
  return shellQuoteArgs([
    ...nicePrefix,
    ...argv,
    "hooks",
    "relay",
    "--provider",
    params.provider,
    "--relay-id",
    params.relayId,
    ...(params.generation ? ["--generation", params.generation] : []),
    "--event",
    params.event,
    ...(params.event === "pre_tool_use" && params.preToolUseUnavailable
      ? ["--pre-tool-use-unavailable", params.preToolUseUnavailable]
      : []),
    "--timeout",
    String(timeoutMs),
  ]);
}

function resolveNativeHookRelayPreToolUseUnavailableMode(params: {
  registration: NativeHookRelayRegistration;
  event: NativeHookRelayEvent;
}): NativeHookRelayPreToolUseUnavailableMode | undefined {
  if (params.event !== "pre_tool_use") {
    return undefined;
  }
  if (hasBeforeToolCallPolicy()) {
    return undefined;
  }
  return nativePreToolUseMayRunLoopDetection(params.registration) ? "loop-detection-only" : "noop";
}

function nativePreToolUseMayRunLoopDetection(registration: NativeHookRelayRegistration): boolean {
  if (!registration.sessionKey) {
    return false;
  }
  const loopDetection = resolveToolLoopDetectionConfig({
    cfg: registration.config,
    agentId: registration.agentId,
  });
  return loopDetection?.enabled !== false;
}

function nativeHookRelayEventHasLocalWork(
  registration: NativeHookRelayRegistration,
  event: NativeHookRelayEvent,
): boolean {
  if (event === "pre_tool_use") {
    // Avoid spawning a native hook relay for every Codex tool call when there
    // is no before_tool_call hook, trusted-tool policy, or loop detector work.
    return hasBeforeToolCallPolicy() || nativePreToolUseMayRunLoopDetection(registration);
  }
  if (event === "post_tool_use") {
    return hasGlobalHooks("after_tool_call");
  }
  if (event === "before_agent_finalize") {
    return hasGlobalHooks("before_agent_finalize");
  }
  return true;
}

export async function invokeNativeHookRelay(
  params: InvokeNativeHookRelayParams,
): Promise<NativeHookRelayProcessResponse> {
  const provider = readNativeHookRelayProvider(params.provider);
  const relayId = read…10196 tokens truncated…MISSION_ALLOW_ALWAYS_ENTRIES) {
    const oldestKey = permissionAllowAlwaysApprovals.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    permissionAllowAlwaysApprovals.delete(oldestKey);
  }
}

function pruneNativeHookRelayPermissionAllowAlways(now = Date.now()): void {
  const validNow = asDateTimestampMs(now);
  if (validNow === undefined) {
    return;
  }
  for (const [key, entry] of permissionAllowAlwaysApprovals) {
    const expiresAtMs = asDateTimestampMs(entry.expiresAtMs);
    if (expiresAtMs === undefined || expiresAtMs <= validNow) {
      permissionAllowAlwaysApprovals.delete(key);
    }
  }
}

function removeNativeHookRelayPermissionState(relayId: string): void {
  permissionApprovalWindows.delete(relayId);
  for (const key of pendingPermissionApprovals.keys()) {
    if (key.startsWith(`${relayId}:`)) {
      pendingPermissionApprovals.delete(key);
    }
  }
}

function snapshotNativeHookRelayPayload(payload: JsonValue): JsonValue {
  return snapshotJsonValue(payload, {
    remainingStringLength: MAX_NATIVE_HOOK_RELAY_HISTORY_TOTAL_STRING_LENGTH,
  });
}

function snapshotJsonValue(value: JsonValue, state: { remainingStringLength: number }): JsonValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return snapshotString(value, state);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS)
      .map((item) => snapshotJsonValue(item, state));
    if (value.length > MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS) {
      items.push("[truncated]");
    }
    return items;
  }
  const snapshot: Record<string, JsonValue> = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS)) {
    snapshot[snapshotString(key, state)] = snapshotJsonValue(value[key], state);
  }
  if (keys.length > MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS) {
    snapshot["[truncated]"] = keys.length - MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS;
  }
  return snapshot;
}

function snapshotString(value: string, state: { remainingStringLength: number }): string {
  if (state.remainingStringLength <= 0) {
    return "[truncated]";
  }
  const limit = Math.min(
    value.length,
    MAX_NATIVE_HOOK_RELAY_HISTORY_STRING_LENGTH,
    state.remainingStringLength,
  );
  state.remainingStringLength -= limit;
  if (limit >= value.length) {
    return value;
  }
  return `${value.slice(0, limit)}...[truncated]`;
}

function normalizeNativeHookInvocation(params: {
  registration: NativeHookRelayRegistration;
  event: NativeHookRelayEvent;
  rawPayload: JsonValue;
}): NativeHookRelayInvocation {
  const metadata = getNativeHookRelayProviderAdapter(
    params.registration.provider,
  ).normalizeMetadata(params.rawPayload);
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

function getNativeHookRelayProviderAdapter(
  provider: NativeHookRelayProvider,
): NativeHookRelayProviderAdapter {
  return nativeHookRelayProviderAdapters[provider];
}

function normalizeCodexHookMetadata(rawPayload: JsonValue): NativeHookRelayInvocationMetadata {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  const metadata: NativeHookRelayInvocationMetadata = {};
  const nativeEventName = readOptionalString(payload.hook_event_name);
  if (nativeEventName) {
    metadata.nativeEventName = nativeEventName;
  }
  const cwd = readOptionalString(payload.cwd);
  if (cwd) {
    metadata.cwd = cwd;
  }
  const model = readOptionalString(payload.model);
  if (model) {
    metadata.model = model;
  }
  const turnId = readOptionalString(payload.turn_id);
  if (turnId) {
    metadata.turnId = turnId;
  }
  const transcriptPath = readOptionalString(payload.transcript_path);
  if (transcriptPath) {
    metadata.transcriptPath = transcriptPath;
  }
  const permissionMode = readOptionalString(payload.permission_mode);
  if (permissionMode) {
    metadata.permissionMode = permissionMode;
  }
  const stopHookActive = readOptionalBoolean(payload.stop_hook_active);
  if (stopHookActive !== undefined) {
    metadata.stopHookActive = stopHookActive;
  }
  const lastAssistantMessage = readOptionalString(payload.last_assistant_message);
  if (lastAssistantMessage) {
    metadata.lastAssistantMessage = lastAssistantMessage;
  }
  const toolName = readOptionalString(payload.tool_name);
  if (toolName) {
    metadata.toolName = toolName;
  }
  const toolUseId = readOptionalString(payload.tool_use_id);
  if (toolUseId) {
    metadata.toolUseId = toolUseId;
  }
  return metadata;
}

function readCodexToolInput(rawPayload: JsonValue): Record<string, JsonValue> {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  const toolInput = payload.tool_input;
  if (isJsonObject(toolInput)) {
    const toolName = readOptionalString(payload.tool_name);
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

function nativeHookRelayParamsWereRewritten(
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

function readNativeHookRelayApprovalMode(rawPayload: JsonValue): "report" | undefined {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  return payload.openclaw_approval_mode === "report" ? "report" : undefined;
}

function normalizeNativeHookToolName(toolName: string | undefined): string {
  const normalized = normalizeToolName(toolName ?? "tool");
  return NATIVE_HOOK_TOOL_NAME_ALIASES[normalized] ?? normalized;
}

async function requestNativeHookRelayPermissionApproval(
  request: NativeHookRelayPermissionApprovalRequest,
): Promise<NativeHookRelayPermissionApprovalResult> {
  const timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;
  const requestResult: {
    id?: string;
    decision?: string | null;
  } = await callGatewayTool(
    "plugin.approval.request",
    { timeoutMs: timeoutMs + 10_000 },
    {
      pluginId: `openclaw-native-hook-relay-${request.provider}`,
      title: truncateText(
        `${nativeHookRelayProviderDisplayName(request.provider)} permission request`,
        MAX_APPROVAL_TITLE_LENGTH,
      ),
      description: truncateText(
        formatPermissionApprovalDescription(request),
        MAX_APPROVAL_DESCRIPTION_LENGTH,
      ),
      severity: "warning",
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      allowedDecisions: [
        PluginApprovalResolutions.ALLOW_ONCE,
        PluginApprovalResolutions.ALLOW_ALWAYS,
        PluginApprovalResolutions.DENY,
      ],
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      timeoutMs,
      twoPhase: true,
    },
    { expectFinal: false },
  );
  const approvalId = requestResult?.id;
  if (!approvalId) {
    return "defer";
  }
  let decision: string | null | undefined;
  if (Object.hasOwn(requestResult ?? {}, "decision")) {
    decision = requestResult.decision;
  } else {
    const waitResult = await waitForNativeHookRelayApprovalDecision({
      approvalId,
      signal: request.signal,
      timeoutMs,
    });
    decision = waitResult?.decision;
  }
  if (decision === PluginApprovalResolutions.ALLOW_ONCE) {
    return "allow";
  }
  if (decision === PluginApprovalResolutions.ALLOW_ALWAYS) {
    return "allow-always";
  }
  if (decision === PluginApprovalResolutions.DENY) {
    return "deny";
  }
  return "defer";
}

async function waitForNativeHookRelayApprovalDecision(params: {
  approvalId: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<{ id?: string; decision?: string | null } | undefined> {
  const waitPromise: Promise<{ id?: string; decision?: string | null } | undefined> =
    callGatewayTool(
      "plugin.approval.waitDecision",
      { timeoutMs: params.timeoutMs + 10_000 },
      { id: params.approvalId },
    );
  if (!params.signal) {
    return waitPromise;
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (params.signal!.aborted) {
      reject(toLintErrorObject(params.signal!.reason, "Non-Error rejection"));
      return;
    }
    onAbort = () => reject(toLintErrorObject(params.signal!.reason, "Non-Error rejection"));
    params.signal!.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([waitPromise, abortPromise]);
  } finally {
    if (onAbort) {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
}

function formatPermissionApprovalDescription(
  request: NativeHookRelayPermissionApprovalRequest,
): string {
  const lines = [
    `Tool: ${sanitizeApprovalText(request.toolName)}`,
    request.cwd ? `Cwd: ${sanitizeApprovalText(request.cwd)}` : undefined,
    request.model ? `Model: ${sanitizeApprovalText(request.model)}` : undefined,
    formatToolInputPreview(request.toolInput),
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function formatToolInputPreview(toolInput: Record<string, unknown>): string | undefined {
  const command = readOptionalString(toolInput.command);
  if (command) {
    return `Command: ${truncateText(sanitizeApprovalText(command), 240)}`;
  }
  const keys = Object.keys(toolInput).map(sanitizeApprovalText).filter(Boolean).toSorted();
  if (!keys.length) {
    return undefined;
  }
  const shownKeys = keys.slice(0, 12).join(", ");
  const omitted = keys.length > 12 ? ` (${keys.length - 12} omitted)` : "";
  return `Input keys: ${shownKeys}${omitted}`;
}

function sanitizeApprovalText(value: string): string {
  let sanitized = "";
  for (const char of value.replace(ANSI_ESCAPE_PATTERN, "")) {
    const codePoint = char.codePointAt(0);
    sanitized += codePoint != null && isUnsafeApprovalCodePoint(codePoint) ? " " : char;
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

function isUnsafeApprovalCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0 && codePoint <= 8) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    (codePoint >= 127 && codePoint <= 159) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function nativeHookRelayProviderDisplayName(provider: NativeHookRelayProvider): string {
  if (provider === "codex") {
    return "Codex";
  }
  return provider;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function resolveOpenClawCliExecutable(): string {
  const envPath = process.env.OPENCLAW_CLI_PATH?.trim();
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (packageRoot) {
    for (const candidate of [
      path.join(packageRoot, "openclaw.mjs"),
      path.join(packageRoot, "dist", "entry.js"),
      path.join(packageRoot, "scripts", "run-node.mjs"),
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  const argvEntry = process.argv[1];
  if (argvEntry) {
    const resolved = path.resolve(argvEntry);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  throw new Error("Cannot resolve OpenClaw CLI executable path for native hook relay");
}

function normalizeAllowedEvents(
  events: readonly NativeHookRelayEvent[] | undefined,
): readonly NativeHookRelayEvent[] {
  if (!events?.length) {
    return NATIVE_HOOK_RELAY_EVENTS;
  }
  return [...new Set(events)];
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function shellQuoteArgs(args: readonly string[]): string {
  return args.map((arg) => shellQuoteArg(arg, process.platform)).join(" ");
}

function shellQuoteArg(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  if (platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readNativeHookRelayProvider(value: unknown): NativeHookRelayProvider {
  if (value === "codex") {
    return value;
  }
  throw new Error("unsupported native hook relay provider");
}

function readNativeHookRelayEvent(value: unknown): NativeHookRelayEvent {
  if (
    value === "pre_tool_use" ||
    value === "post_tool_use" ||
    value === "permission_request" ||
    value === "before_agent_finalize"
  ) {
    return value;
  }
  throw new Error("unsupported native hook relay event");
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`native hook relay ${name} is required`);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let totalStringLength = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_NATIVE_HOOK_RELAY_JSON_NODES) {
      return false;
    }
    if (current.depth > MAX_NATIVE_HOOK_RELAY_JSON_DEPTH) {
      return false;
    }
    if (current.value === null) {
      continue;
    }
    if (typeof current.value === "string") {
      if (current.value.length > MAX_NATIVE_HOOK_RELAY_STRING_LENGTH) {
        return false;
      }
      totalStringLength += current.value.length;
      if (totalStringLength > MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH) {
        return false;
      }
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        return false;
      }
      continue;
    }
    if (typeof current.value === "boolean") {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const valueLocal of current.value) {
        if (nodes + stack.length + 1 > MAX_NATIVE_HOOK_RELAY_JSON_NODES) {
          return false;
        }
        stack.push({ value: valueLocal, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isJsonObject(current.value)) {
      return false;
    }
    try {
      for (const key in current.value) {
        if (!Object.hasOwn(current.value, key)) {
          continue;
        }
        if (key.length > MAX_NATIVE_HOOK_RELAY_STRING_LENGTH) {
          return false;
        }
        totalStringLength += key.length;
        if (totalStringLength > MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH) {
          return false;
        }
        if (nodes + stack.length + 1 > MAX_NATIVE_HOOK_RELAY_JSON_NODES) {
          return false;
        }
        stack.push({ value: current.value[key], depth: current.depth + 1 });
      }
    } catch {
      return false;
    }
  }
  return true;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export const testing = {
  clearNativeHookRelaysForTests(): void {
    for (const relayId of relayBridges.keys()) {
      unregisterNativeHookRelayBridge(relayId);
    }
    relays.clear();
    invocations.length = 0;
    pendingPermissionApprovals.clear();
    for (const pendingApproval of pendingPreToolUseApprovals.values()) {
      cancelDeferredPluginToolApproval(pendingApproval.deferredApproval);
    }
    pendingPreToolUseApprovals.clear();
    permissionApprovalWindows.clear();
    permissionAllowAlwaysApprovals.clear();
    nativeHookRelayPermissionApprovalRequester = requestNativeHookRelayPermissionApproval;
    nativeHookRelayDeferredToolApprovalRequester = requestDeferredPluginToolApproval;
  },
  getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[] {
    return [...invocations];
  },
  getNativeHookRelayRegistrationForTests(relayId: string): NativeHookRelayRegistration | undefined {
    return relays.get(relayId);
  },
  getNativeHookRelayBridgeDirForTests(): string {
    return nativeHookRelayBridgeDir();
  },
  getNativeHookRelayBridgeRegistryPathForTests(relayId: string): string {
    return nativeHookRelayBridgeRegistryPath(relayId);
  },
  getNativeHookRelayBridgeRecordForTests(relayId: string): Record<string, unknown> | undefined {
    const record = readNativeHookRelayBridgeRecordIfExists(relayId);
    return record ? { ...record } : undefined;
  },
  isNativeHookRelayBridgeLookupRetryableForTests(error: unknown, elapsedMs = 0): boolean {
    return isRetryableNativeHookRelayBridgeLookupError({ error, elapsedMs });
  },
  formatPermissionApprovalDescriptionForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return formatPermissionApprovalDescription(request);
  },
  permissionRequestContentFingerprintForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return permissionRequestContentFingerprint(request);
  },
  permissionRequestToolInputKeyFingerprintForTests(toolInput: Record<string, unknown>): string {
    return permissionRequestToolInputKeyFingerprint(toolInput);
  },
  setNativeHookRelayPermissionApprovalRequesterForTests(
    requester: NativeHookRelayPermissionApprovalRequester,
  ): void {
    nativeHookRelayPermissionApprovalRequester = requester;
  },
  setNativeHookRelayDeferredToolApprovalRequesterForTests(
    requester: NativeHookRelayDeferredToolApprovalRequester,
  ): void {
    nativeHookRelayDeferredToolApprovalRequester = requester;
  },
} as const;
export { testing as __testing };

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
