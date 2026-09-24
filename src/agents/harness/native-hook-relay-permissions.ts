import { createHash } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { isApprovalNotFoundError } from "../../infra/approval-errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import {
  prepareSystemRunMutableFileBinding,
  revalidateSystemRunMutableFileBinding,
  type SystemRunMutableFileBinding,
} from "../../infra/system-run-approval-binding.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { PluginApprovalResolutions } from "../../plugins/types.js";
import {
  cancelDeferredPluginToolApproval,
  requestDeferredPluginToolApproval,
  type DeferredPluginToolApproval,
} from "../agent-tools.before-tool-call.js";
import { formatMcpCodexApprovalRemedy } from "../mcp-codex-tool-approval.js";
import { callGatewayTool } from "../tools/gateway.js";
import { formatNativeHookRelayApprovalPresentation } from "./native-hook-relay-approval-presentation.js";
import {
  nativeHookRelayParamsWereRewritten,
  normalizeNativeHookToolName,
} from "./native-hook-relay-codec.js";
import {
  MAX_NATIVE_HOOK_RELAY_INVOCATIONS,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import type {
  JsonValue,
  NativeHookRelayDeferredApprovalOutcome,
  NativeHookRelayInvocation,
  NativeHookRelayPermissionApprovalRequest,
  NativeHookRelayPermissionApprovalRequester,
  NativeHookRelayPermissionApprovalResult,
  NativeHookRelayPendingPermissionApproval,
  NativeHookRelayPreToolUseApproval,
  NativeHookRelayProcessResponse,
  NativeHookRelayProviderAdapter,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";
import { readOptionalNonEmptyString, truncateRelayText } from "./native-hook-relay-utils.js";

export type NativeHookRelayDeferredToolApprovalRequester = typeof requestDeferredPluginToolApproval;

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
const PERMISSION_ALLOW_ALWAYS_TTL_MS = 30 * 60 * 1000;
const MAX_PERMISSION_FALLBACK_KEYS = 200;
const MAX_PERMISSION_FALLBACK_KEY_CHARS = 240;
const MAX_PERMISSION_FINGERPRINT_SORT_KEYS = 200;
const MAX_PERMISSION_APPROVALS_PER_WINDOW = 12;
const PERMISSION_APPROVAL_WINDOW_MS = 60_000;
const MAX_PERMISSION_ALLOW_ALWAYS_ENTRIES = 512;
const log = createSubsystemLogger("agents/harness/native-hook-relay");
const NATIVE_SHELL_APPROVAL_TOOLS = new Set([
  "bash",
  "exec",
  "exec_command",
  "shell",
  "shell_command",
]);

const {
  pendingPermissionApprovals,
  pendingPreToolUseApprovals,
  permissionApprovalWindows,
  permissionAllowAlwaysApprovals,
} = nativeHookRelayState;

let nativeHookRelayPermissionApprovalRequester: NativeHookRelayPermissionApprovalRequester =
  requestNativeHookRelayPermissionApproval;
let nativeHookRelayDeferredToolApprovalRequester: NativeHookRelayDeferredToolApprovalRequester =
  requestDeferredPluginToolApproval;

function nativeHookRelayPreToolUseApprovalKey(params: {
  relayId: string;
  toolUseId?: string;
}): string | undefined {
  const toolUseId = params.toolUseId?.trim();
  return toolUseId ? JSON.stringify([params.relayId, toolUseId]) : undefined;
}

export function setNativeHookRelayPreToolUseApproval(params: {
  relayId: string;
  toolUseId?: string;
  deferredApproval: DeferredPluginToolApproval;
  originalParamsFingerprint: string;
}): boolean {
  const key = nativeHookRelayPreToolUseApprovalKey(params);
  if (!key) {
    return false;
  }
  const previousApproval = pendingPreToolUseApprovals.get(key);
  pendingPreToolUseApprovals.set(key, {
    relayId: params.relayId,
    deferredApproval: params.deferredApproval,
    originalParamsFingerprint: params.originalParamsFingerprint,
  });
  let evictedApproval: NativeHookRelayPreToolUseApproval | undefined;
  if (pendingPreToolUseApprovals.size > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    const oldestKey = pendingPreToolUseApprovals.keys().next().value;
    if (oldestKey) {
      evictedApproval = pendingPreToolUseApprovals.get(oldestKey);
      pendingPreToolUseApprovals.delete(oldestKey);
    }
  }
  // Publish/detach before notifying: cancellation callbacks may replace or
  // retire this relay synchronously, and their successor must remain authoritative.
  if (previousApproval) {
    cancelDeferredPluginToolApproval(previousApproval.deferredApproval);
  }
  if (evictedApproval) {
    cancelDeferredPluginToolApproval(evictedApproval.deferredApproval);
  }
  return true;
}

export function detachNativeHookRelayApprovalState(relayId: string): () => void {
  const preToolUseApprovals: NativeHookRelayPreToolUseApproval[] = [];
  for (const [key, approval] of pendingPreToolUseApprovals) {
    if (approval.relayId === relayId) {
      pendingPreToolUseApprovals.delete(key);
      preToolUseApprovals.push(approval);
    }
  }
  const permissionApprovals = detachNativeHookRelayPermissionState(relayId);
  // Detach every old entry before any callback can register a same-id successor.
  // Completion finalizers still compare object identity before deleting entries.
  return () => {
    for (const approval of preToolUseApprovals) {
      cancelDeferredPluginToolApproval(approval.deferredApproval);
    }
    for (const approval of permissionApprovals) {
      approval.controller.abort();
    }
  };
}

export async function resolveNativeHookRelayDeferredToolApproval(params: {
  relayId: string;
  toolUseId?: string;
  signal?: AbortSignal;
}): Promise<NativeHookRelayDeferredApprovalOutcome | undefined> {
  const pendingApprovalKey = nativeHookRelayPreToolUseApprovalKey(params);
  if (!pendingApprovalKey) {
    return undefined;
  }
  const pendingApproval = pendingPreToolUseApprovals.get(pendingApprovalKey);
  if (!pendingApproval) {
    return undefined;
  }
  pendingApproval.resolutionPromise ??= resolveNativeHookRelayPreToolUseApproval(
    pendingApproval,
    params.signal,
  ).finally(() => {
    if (pendingPreToolUseApprovals.get(pendingApprovalKey) === pendingApproval) {
      pendingPreToolUseApprovals.delete(pendingApprovalKey);
    }
  });
  return pendingApproval.resolutionPromise;
}

async function resolveNativeHookRelayPreToolUseApproval(
  pendingApproval: NativeHookRelayPreToolUseApproval,
  signal?: AbortSignal,
): Promise<NativeHookRelayDeferredApprovalOutcome> {
  const outcome = await nativeHookRelayDeferredToolApprovalRequester({
    deferredApproval: pendingApproval.deferredApproval,
    signal,
  });
  if (outcome.blocked) {
    return {
      handled: true,
      outcome: "denied",
      reason: outcome.reason,
      ...(outcome.kind === "failure" && outcome.disposition !== "blocked"
        ? { failureDisposition: outcome.disposition }
        : {}),
    };
  }
  if (
    nativeHookRelayParamsWereRewritten(pendingApproval.originalParamsFingerprint, outcome.params)
  ) {
    return {
      handled: true,
      outcome: "denied",
      reason:
        "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
    };
  }
  return { handled: true, outcome: "approved-once" };
}

export async function runNativeHookRelayPermissionRequest(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const mcpToolName = params.invocation.toolName?.startsWith("mcp__")
    ? params.invocation.toolName
    : undefined;
  // Native MCP names can be hashed or trimmed. Only Codex knows the exact server;
  // defer so full posture cannot bypass plugin-app policy before elicitation.
  if (mcpToolName && params.registration.deferMcpToolApprovals) {
    return params.adapter.renderNoopResponse(params.invocation.event);
  }
  const request: NativeHookRelayPermissionApprovalRequest = {
    provider: params.registration.provider,
    ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
    sessionId: params.registration.sessionId,
    ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
    runId: params.registration.runId,
    toolName: mcpToolName ?? normalizeNativeHookToolName(params.invocation.toolName),
    ...(params.invocation.toolUseId ? { toolCallId: params.invocation.toolUseId } : {}),
    ...(params.invocation.cwd ? { cwd: params.invocation.cwd } : {}),
    ...(params.invocation.model ? { model: params.invocation.model } : {}),
    toolInput: params.adapter.readToolInput(params.invocation.rawPayload),
    ...(params.registration.signal ? { signal: params.registration.signal } : {}),
  };
  const mcpServerName = /^mcp__(.+?)__/.exec(request.toolName)?.[1];
  const mutableFileBinding = await prepareNativeHookMutableFileBinding(request);
  // File preparation yields; a disconnected callback must not create a new approval.
  params.registration.assertActive?.();
  if (!mutableFileBinding.ok) {
    return params.adapter.renderPermissionDecisionResponse("deny", mutableFileBinding.message);
  }
  const approvalKey = nativeHookRelayPermissionApprovalKey({
    registration: params.registration,
    request,
    binding: mutableFileBinding.binding,
  });
  const allowAlwaysKey = nativeHookRelayPermissionAllowAlwaysKey({
    registration: params.registration,
    request,
    binding: mutableFileBinding.binding,
  });
  if (hasNativeHookRelayPermissionAllowAlways(allowAlwaysKey)) {
    params.registration.assertActive?.();
    if (mutableFileBinding.binding) {
      const current = await revalidateSystemRunMutableFileBinding({
        binding: mutableFileBinding.binding,
        cwd: request.cwd,
      });
      params.registration.assertActive?.();
      if (!current.ok) {
        return params.adapter.renderPermissionDecisionResponse("deny", current.message);
      }
    }
    return params.adapter.renderPermissionDecisionResponse("allow");
  }
  try {
    const decision = await waitForNativeHookRelayPermissionApproval({
      registration: params.registration,
      approvalKey,
      request,
    });
    params.registration.assertActive?.();
    if ((decision === "allow" || decision === "allow-always") && mutableFileBinding.binding) {
      // PermissionRequest is OpenClaw's last boundary before the native runtime
      // owns spawn; recheck after the wait before returning its allow response.
      const current = await revalidateSystemRunMutableFileBinding({
        binding: mutableFileBinding.binding,
        cwd: request.cwd,
      });
      params.registration.assertActive?.();
      if (!current.ok) {
        return params.adapter.renderPermissionDecisionResponse("deny", current.message);
      }
    }
    if (decision === "allow") {
      return params.adapter.renderPermissionDecisionResponse("allow");
    }
    if (decision === "allow-always") {
      rememberNativeHookRelayPermissionAllowAlways({
        key: allowAlwaysKey,
        relayId: params.registration.relayId,
        mcpTool: mcpToolName !== undefined,
      });
      return params.adapter.renderPermissionDecisionResponse("allow");
    }
    if (decision === "deny" || (decision === "timed-out" && mcpToolName)) {
      const reason = decision === "deny" ? "Denied by user" : "MCP tool approval timed out";
      return params.adapter.renderPermissionDecisionResponse(
        "deny",
        mcpToolName ? `${reason}. ${formatMcpCodexApprovalRemedy(mcpServerName)}` : reason,
      );
    }
  } catch (error) {
    params.registration.assertActive?.();
    log.warn(
      `native hook permission approval failed; deferring to provider approval path: ${String(error)}`,
    );
  }
  // A PermissionRequest no-op is not an allow decision. Codex interprets it as
  // "no hook decision" and falls through to its normal guardian/user approval path.
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function waitForNativeHookRelayPermissionApproval(params: {
  registration: NativeHookRelayRegistration;
  approvalKey: string;
  request: NativeHookRelayPermissionApprovalRequest;
}): Promise<NativeHookRelayPermissionApprovalResult> {
  let approval = pendingPermissionApprovals.get(params.approvalKey);
  if (!approval) {
    if (!consumeNativeHookRelayPermissionBudget(params.registration.relayId)) {
      log.warn(
        `native hook permission approval rate limit exceeded; deferring to provider approval path: relay=${params.registration.relayId} run=${params.registration.runId}`,
      );
      return "defer";
    }
    const controller = new AbortController();
    const pending: NativeHookRelayPendingPermissionApproval = {
      relayId: params.registration.relayId,
      controller,
      waiters: 0,
      cancelWhenUnobserved: params.registration.approvalHost !== undefined,
      promise: racePromiseWithAbortSignal(
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          const request = {
            ...params.request,
            signal: controller.signal,
          };
          return params.registration.approvalHost
            ? requestNativeHookRelayPermissionApproval(request, params.registration.approvalHost)
            : nativeHookRelayPermissionApprovalRequester(request);
        }),
        controller.signal,
      ).finally(() => {
        if (pendingPermissionApprovals.get(params.approvalKey) === pending) {
          pendingPermissionApprovals.delete(params.approvalKey);
        }
      }),
    };
    pendingPermissionApprovals.set(params.approvalKey, pending);
    approval = pending;
  }
  approval.waiters++;
  try {
    return await racePromiseWithAbortSignal(approval.promise, params.registration.signal);
  } finally {
    // A duplicate callback owns its wait, not the shared approval request.
    // Only the admitted host can retract an accepted Gateway approval. Public
    // callers keep dedup until decision/expiry so a retry rejoins that prompt.
    approval.waiters--;
    if (
      approval.cancelWhenUnobserved &&
      approval.waiters === 0 &&
      pendingPermissionApprovals.get(params.approvalKey) === approval
    ) {
      pendingPermissionApprovals.delete(params.approvalKey);
      approval.controller.abort();
    }
  }
}

function nativeHookRelayPermissionApprovalKey(params: {
  registration: NativeHookRelayRegistration;
  request: NativeHookRelayPermissionApprovalRequest;
  binding?: SystemRunMutableFileBinding;
}): string {
  return JSON.stringify([
    params.registration.relayId,
    params.registration.runId,
    params.request.toolCallId
      ? ["call", params.request.toolCallId]
      : ["fallback", permissionRequestFallbackKey(params.request)],
    permissionRequestContentFingerprint(params.request),
    params.binding ? permissionRequestBindingFingerprint(params.binding) : "no-file-binding",
  ]);
}

async function prepareNativeHookMutableFileBinding(
  request: NativeHookRelayPermissionApprovalRequest,
): Promise<{ ok: true; binding?: SystemRunMutableFileBinding } | { ok: false; message: string }> {
  if (!NATIVE_SHELL_APPROVAL_TOOLS.has(request.toolName.trim().toLowerCase())) {
    return { ok: true };
  }
  const command = readOptionalNonEmptyString(request.toolInput.command);
  const prepared = await prepareSystemRunMutableFileBinding({
    command: { kind: "shell", text: command ?? "" },
    cwd: request.cwd,
  });
  if (!prepared.ok) {
    return { ok: false, message: prepared.message };
  }
  return prepared.binding.operands.length > 0
    ? { ok: true, binding: prepared.binding }
    : { ok: true };
}

function permissionRequestBindingFingerprint(binding: SystemRunMutableFileBinding): string {
  const hash = createHash("sha256");
  for (const { argv, snapshot } of binding.operands) {
    hash.update(JSON.stringify([argv, snapshot.argvIndex, snapshot.path, snapshot.sha256]));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function nativeHookRelayPermissionAllowAlwaysKey(params: {
  registration: NativeHookRelayRegistration;
  request: NativeHookRelayPermissionApprovalRequest;
  binding?: SystemRunMutableFileBinding;
}): string {
  // MCP consent covers the tool; executable/file grants must remain input- and
  // content-bound so approving one invocation cannot authorize another program.
  return createHash("sha256")
    .update(
      JSON.stringify([
        params.registration.relayId,
        params.request.provider,
        params.request.agentId,
        params.request.sessionKey ?? params.request.sessionId,
        params.request.toolName.startsWith("mcp__")
          ? params.request.toolName
          : permissionRequestContentFingerprint(params.request),
        params.binding ? permissionRequestBindingFingerprint(params.binding) : undefined,
      ]),
    )
    .digest("hex");
}

function permissionRequestFallbackKey(request: NativeHookRelayPermissionApprovalRequest): string {
  const command = readOptionalNonEmptyString(request.toolInput.command);
  if (command) {
    return `${request.toolName}:command:${truncateRelayText(command, 240)}`;
  }
  return `${request.toolName}:keys:${permissionRequestToolInputKeyFingerprint(request.toolInput)}`;
}

export function permissionRequestToolInputKeyFingerprintForTests(
  toolInput: Record<string, unknown>,
): string {
  return permissionRequestToolInputKeyFingerprint(toolInput);
}

function permissionRequestToolInputKeyFingerprint(toolInput: Record<string, unknown>): string {
  let fingerprint = "";
  const { keys, truncated } = readBoundedOwnKeys(toolInput, MAX_PERMISSION_FALLBACK_KEYS);
  for (const key of keys) {
    const separator = fingerprint ? "," : "";
    const remaining = MAX_PERMISSION_FALLBACK_KEY_CHARS - fingerprint.length - separator.length;
    if (remaining <= 0) {
      break;
    }
    fingerprint += `${separator}${key.slice(0, remaining)}`;
  }
  if (truncated && fingerprint.length < MAX_PERMISSION_FALLBACK_KEY_CHARS) {
    const marker = `${fingerprint ? "," : ""}...`;
    fingerprint += marker.slice(0, MAX_PERMISSION_FALLBACK_KEY_CHARS - fingerprint.length);
  }
  return fingerprint || "none";
}

export function permissionRequestContentFingerprintForTests(
  request: NativeHookRelayPermissionApprovalRequest,
): string {
  return permissionRequestContentFingerprint(request);
}

function permissionRequestContentFingerprint(
  request: NativeHookRelayPermissionApprovalRequest,
): string {
  const hash = createHash("sha256");
  hash.update(request.toolName);
  hash.update("\0");
  hash.update(request.cwd ?? "");
  hash.update("\0");
  updateJsonHash(hash, request.toolInput);
  return hash.digest("hex");
}

function updateJsonHash(hash: ReturnType<typeof createHash>, value: JsonValue): void {
  if (value === null) {
    hash.update("null");
    return;
  }
  if (typeof value === "string") {
    hash.update("string:");
    hash.update(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    hash.update(`number:${String(value)}`);
    return;
  }
  if (typeof value === "boolean") {
    hash.update(`boolean:${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    hash.update("[");
    for (const item of value) {
      updateJsonHash(hash, item);
      hash.update(",");
    }
    hash.update("]");
    return;
  }
  hash.update("{");
  const { keys, truncated } = readBoundedOwnKeys(value, MAX_PERMISSION_FINGERPRINT_SORT_KEYS);
  for (const key of keys) {
    hash.update(JSON.stringify(key));
    hash.update(":");
    const item = value[key];
    if (item !== undefined) {
      updateJsonHash(hash, item);
    }
    hash.update(",");
  }
  if (truncated) {
    // Keep ordinary objects order-independent without sorting a broad native
    // hook payload. The tail remains content-sensitive in traversal order.
    const sortedKeySet = new Set(keys);
    hash.update("#object-tail:");
    for (const key in value) {
      if (!Object.hasOwn(value, key) || sortedKeySet.has(key)) {
        continue;
      }
      hash.update(JSON.stringify(key));
      hash.update(":");
      const item = value[key];
      if (item !== undefined) {
        updateJsonHash(hash, item);
      }
      hash.update(",");
    }
  }
  hash.update("}");
}

function readBoundedOwnKeys(
  value: Record<string, unknown>,
  maxKeys: number,
): { keys: string[]; truncated: boolean } {
  const keys: string[] = [];
  let truncated = false;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    if (keys.length >= maxKeys) {
      truncated = true;
      break;
    }
    keys.push(key);
  }
  keys.sort();
  return { keys, truncated };
}

function consumeNativeHookRelayPermissionBudget(relayId: string, now = Date.now()): boolean {
  const windowStart = now - PERMISSION_APPROVAL_WINDOW_MS;
  const timestamps = (permissionApprovalWindows.get(relayId) ?? []).filter(
    (timestamp) => timestamp >= windowStart,
  );
  if (timestamps.length >= MAX_PERMISSION_APPROVALS_PER_WINDOW) {
    permissionApprovalWindows.set(relayId, timestamps);
    return false;
  }
  timestamps.push(now);
  permissionApprovalWindows.set(relayId, timestamps);
  return true;
}

function hasNativeHookRelayPermissionAllowAlways(key: string, now = Date.now()): boolean {
  const entry = permissionAllowAlwaysApprovals.get(key);
  if (!entry) {
    return false;
  }
  if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= now) {
    permissionAllowAlwaysApprovals.delete(key);
    return false;
  }
  return true;
}

function rememberNativeHookRelayPermissionAllowAlways(
  params: { key: string; relayId: string; mcpTool: boolean },
  now = Date.now(),
): void {
  pruneNativeHookRelayPermissionAllowAlways(now);
  // MCP grants end with their relay registration, not a wall-clock timeout.
  const expiresAtMs = params.mcpTool
    ? undefined
    : resolveExpiresAtMsFromDurationMs(PERMISSION_ALLOW_ALWAYS_TTL_MS, { nowMs: now });
  if (!params.mcpTool && expiresAtMs === undefined) {
    return;
  }
  permissionAllowAlwaysApprovals.set(params.key, { relayId: params.relayId, expiresAtMs });
  pruneMapToMaxSize(permissionAllowAlwaysApprovals, MAX_PERMISSION_ALLOW_ALWAYS_ENTRIES);
}

export function pruneNativeHookRelayPermissionAllowAlways(now = Date.now()): void {
  for (const [key, entry] of permissionAllowAlwaysApprovals) {
    if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= now) {
      permissionAllowAlwaysApprovals.delete(key);
    }
  }
}

function detachNativeHookRelayPermissionState(
  relayId: string,
): NativeHookRelayPendingPermissionApproval[] {
  const approvals: NativeHookRelayPendingPermissionApproval[] = [];
  permissionApprovalWindows.delete(relayId);
  for (const [key, entry] of permissionAllowAlwaysApprovals) {
    if (entry.relayId === relayId) {
      permissionAllowAlwaysApprovals.delete(key);
    }
  }
  for (const [key, approval] of pendingPermissionApprovals) {
    if (approval.relayId === relayId) {
      pendingPermissionApprovals.delete(key);
      approvals.push(approval);
    }
  }
  return approvals;
}

export function removeNativeHookRelayPermissionState(relayId: string): void {
  for (const approval of detachNativeHookRelayPermissionState(relayId)) {
    approval.controller.abort();
  }
}

async function requestNativeHookRelayPermissionApproval(
  request: NativeHookRelayPermissionApprovalRequest,
  approvalHost?: NativeHookRelayRegistration["approvalHost"],
): Promise<NativeHookRelayPermissionApprovalResult> {
  const timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;
  const approvalRequest = {
    ...formatNativeHookRelayApprovalPresentation(request),
    severity: "warning" as const,
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    allowedDecisions: [
      PluginApprovalResolutions.ALLOW_ONCE,
      PluginApprovalResolutions.ALLOW_ALWAYS,
      PluginApprovalResolutions.DENY,
    ],
    timeoutMs,
  };
  const requestResult = approvalHost
    ? await approvalHost.requestApproval({
        ...approvalRequest,
        transportTimeoutMs: timeoutMs + 10_000,
        signal: request.signal,
      })
    : await callGatewayTool<{ id?: string; decision?: string | null }>(
        "plugin.approval.request",
        { timeoutMs: timeoutMs + 10_000 },
        {
          ...approvalRequest,
          pluginId: `openclaw-native-hook-relay-${request.provider}`,
          agentId: request.agentId,
          sessionKey: request.sessionKey,
          twoPhase: true,
        },
        { expectFinal: false, signal: request.signal },
      );
  request.signal?.throwIfAborted();
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
      approvalHost,
    });
    // Bind the verdict to the request that parked this call. A stale or
    // misrouted reply must never release a different tool gate.
    if (!waitResult || waitResult.id !== approvalId) {
      return "defer";
    }
    decision = waitResult.decision;
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
  return decision == null ? "timed-out" : "defer";
}

async function waitForNativeHookRelayApprovalDecision(params: {
  approvalId: string;
  signal?: AbortSignal;
  timeoutMs: number;
  approvalHost?: NativeHookRelayRegistration["approvalHost"];
}): Promise<{ id?: string; decision?: string | null } | undefined> {
  const pending = params.approvalHost
    ? params.approvalHost
        .waitForApproval({
          approvalId: params.approvalId,
          timeoutMs: params.timeoutMs,
          transportTimeoutMs: params.timeoutMs + 10_000,
          signal: params.signal,
        })
        .then((result) =>
          result ? { id: params.approvalId, decision: result.decision } : undefined,
        )
    : callGatewayTool<{ id?: string; decision?: string | null }>(
        "plugin.approval.waitDecision",
        { timeoutMs: params.timeoutMs + 10_000 },
        { id: params.approvalId },
        { signal: params.signal },
      );
  return pending.catch((error: unknown) => {
    if (isApprovalNotFoundError(error)) {
      return undefined;
    }
    throw error;
  });
}

export function setNativeHookRelayPermissionApprovalRequesterForTests(
  requester: NativeHookRelayPermissionApprovalRequester,
): void {
  nativeHookRelayPermissionApprovalRequester = requester;
}

export function setNativeHookRelayDeferredToolApprovalRequesterForTests(
  requester: NativeHookRelayDeferredToolApprovalRequester,
): void {
  nativeHookRelayDeferredToolApprovalRequester = requester;
}

export function clearNativeHookRelayPermissionsForTests(): void {
  for (const approval of pendingPermissionApprovals.values()) {
    approval.controller.abort();
  }
  pendingPermissionApprovals.clear();
  for (const pendingApproval of pendingPreToolUseApprovals.values()) {
    cancelDeferredPluginToolApproval(pendingApproval.deferredApproval);
  }
  pendingPreToolUseApprovals.clear();
  permissionApprovalWindows.clear();
  permissionAllowAlwaysApprovals.clear();
  nativeHookRelayPermissionApprovalRequester = requestNativeHookRelayPermissionApproval;
  nativeHookRelayDeferredToolApprovalRequester = requestDeferredPluginToolApproval;
}
