import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { PluginApprovalResolutions } from "../../plugins/types.js";
import { runBeforeToolCallHook } from "../pi-tools.before-tool-call.js";
import { normalizeToolName } from "../tool-policy.js";
import { callGatewayTool } from "../tools/gateway.js";
import { runAgentHarnessAfterToolCallHook } from "./hook-helpers.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const NATIVE_HOOK_RELAY_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
] as const;

export const NATIVE_HOOK_RELAY_PROVIDERS = ["codex"] as const;

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
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  allowedEvents: readonly NativeHookRelayEvent[];
  expiresAtMs: number;
  signal?: AbortSignal;
};

export type NativeHookRelayRegistrationHandle = NativeHookRelayRegistration & {
  commandForEvent: (event: NativeHookRelayEvent) => string;
  unregister: () => void;
};

export type RegisterNativeHookRelayParams = {
  provider: NativeHookRelayProvider;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  allowedEvents?: readonly NativeHookRelayEvent[];
  ttlMs?: number;
  command?: NativeHookRelayCommandOptions;
  signal?: AbortSignal;
};

export type NativeHookRelayCommandOptions = {
  executable?: string;
  nodeExecutable?: string;
  timeoutMs?: number;
};

export type InvokeNativeHookRelayParams = {
  provider: unknown;
  relayId: unknown;
  event: unknown;
  rawPayload: unknown;
};

type NativeHookRelayInvocationMetadata = Partial<
  Pick<NativeHookRelayInvocation, "nativeEventName" | "cwd" | "model" | "toolName" | "toolUseId">
>;

type NativeHookRelayProviderAdapter = {
  normalizeMetadata: (rawPayload: JsonValue) => NativeHookRelayInvocationMetadata;
  readToolInput: (rawPayload: JsonValue) => Record<string, unknown>;
  readToolResponse: (rawPayload: JsonValue) => unknown;
  renderNoopResponse: (event: NativeHookRelayEvent) => NativeHookRelayProcessResponse;
  renderPreToolUseBlockResponse: (reason: string) => NativeHookRelayProcessResponse;
  renderPermissionDecisionResponse: (
    decision: NativeHookRelayPermissionDecision,
    message?: string,
  ) => NativeHookRelayProcessResponse;
};

const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RELAY_TIMEOUT_MS = 5_000;
const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
const MAX_APPROVAL_TITLE_LENGTH = 80;
const MAX_APPROVAL_DESCRIPTION_LENGTH = 700;
const relays = new Map<string, NativeHookRelayRegistration>();
const invocations: NativeHookRelayInvocation[] = [];
const log = createSubsystemLogger("agents/harness/native-hook-relay");

type NativeHookRelayPermissionDecision = "allow" | "deny";

type NativeHookRelayPermissionApprovalResult = NativeHookRelayPermissionDecision | "defer";

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
  toolInput: Record<string, unknown>;
  signal?: AbortSignal;
};

type NativeHookRelayPermissionApprovalRequester = (
  request: NativeHookRelayPermissionApprovalRequest,
) => Promise<NativeHookRelayPermissionApprovalResult>;

let nativeHookRelayPermissionApprovalRequester: NativeHookRelayPermissionApprovalRequester =
  requestNativeHookRelayPermissionApproval;

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
): NativeHookRelayRegistrationHandle {
  const relayId = randomUUID();
  const allowedEvents = normalizeAllowedEvents(params.allowedEvents);
  const registration: NativeHookRelayRegistration = {
    relayId,
    provider: params.provider,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    runId: params.runId,
    allowedEvents,
    expiresAtMs: Date.now() + normalizePositiveInteger(params.ttlMs, DEFAULT_RELAY_TTL_MS),
    ...(params.signal ? { signal: params.signal } : {}),
  };
  relays.set(relayId, registration);
  return {
    ...registration,
    commandForEvent: (event) =>
      buildNativeHookRelayCommand({
        provider: params.provider,
        relayId,
        event,
        timeoutMs: params.command?.timeoutMs,
        executable: params.command?.executable,
        nodeExecutable: params.command?.nodeExecutable,
      }),
    unregister: () => unregisterNativeHookRelay(relayId),
  };
}

export function unregisterNativeHookRelay(relayId: string): void {
  relays.delete(relayId);
}

export function buildNativeHookRelayCommand(params: {
  provider: NativeHookRelayProvider;
  relayId: string;
  event: NativeHookRelayEvent;
  timeoutMs?: number;
  executable?: string;
  nodeExecutable?: string;
}): string {
  const timeoutMs = normalizePositiveInteger(params.timeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
  const executable = params.executable ?? resolveOpenClawCliExecutable();
  const argv =
    executable === "openclaw"
      ? ["openclaw"]
      : [params.nodeExecutable ?? process.execPath, executable];
  return shellQuoteArgs([
    ...argv,
    "hooks",
    "relay",
    "--provider",
    params.provider,
    "--relay-id",
    params.relayId,
    "--event",
    params.event,
    "--timeout",
    String(timeoutMs),
  ]);
}

export async function invokeNativeHookRelay(
  params: InvokeNativeHookRelayParams,
): Promise<NativeHookRelayProcessResponse> {
  const provider = readNativeHookRelayProvider(params.provider);
  const relayId = readNonEmptyString(params.relayId, "relayId");
  const event = readNativeHookRelayEvent(params.event);
  const registration = relays.get(relayId);
  if (!registration) {
    throw new Error("native hook relay not found");
  }
  if (Date.now() > registration.expiresAtMs) {
    relays.delete(relayId);
    throw new Error("native hook relay expired");
  }
  if (registration.provider !== provider) {
    throw new Error("native hook relay provider mismatch");
  }
  if (!registration.allowedEvents.includes(event)) {
    throw new Error("native hook relay event not allowed");
  }
  if (!isJsonValue(params.rawPayload)) {
    throw new Error("native hook relay payload must be JSON-compatible");
  }

  const normalized = normalizeNativeHookInvocation({
    registration,
    event,
    rawPayload: params.rawPayload,
  });
  invocations.push(normalized);
  return processNativeHookRelayInvocation({
    registration,
    invocation: normalized,
    adapter: getNativeHookRelayProviderAdapter(provider),
  });
}

async function processNativeHookRelayInvocation(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  if (params.invocation.event === "pre_tool_use") {
    return runNativeHookRelayPreToolUse(params);
  }
  if (params.invocation.event === "post_tool_use") {
    return runNativeHookRelayPostToolUse(params);
  }
  return runNativeHookRelayPermissionRequest(params);
}

async function runNativeHookRelayPreToolUse(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const toolName = normalizeNativeHookToolName(params.invocation.toolName);
  const toolInput = params.adapter.readToolInput(params.invocation.rawPayload);
  const outcome = await runBeforeToolCallHook({
    toolName,
    params: toolInput,
    ...(params.invocation.toolUseId ? { toolCallId: params.invocation.toolUseId } : {}),
    signal: params.registration.signal,
    ctx: {
      ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
      sessionId: params.registration.sessionId,
      ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
      runId: params.registration.runId,
    },
  });
  if (outcome.blocked) {
    return params.adapter.renderPreToolUseBlockResponse(outcome.reason);
  }
  // Codex PreToolUse supports block/allow, not argument mutation. If an
  // OpenClaw plugin returns adjusted params here, we intentionally ignore them.
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function runNativeHookRelayPostToolUse(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const toolName = normalizeNativeHookToolName(params.invocation.toolName);
  const toolCallId =
    params.invocation.toolUseId ?? `${params.invocation.event}:${params.invocation.receivedAt}`;
  await runAgentHarnessAfterToolCallHook({
    toolName,
    toolCallId,
    runId: params.registration.runId,
    ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
    sessionId: params.registration.sessionId,
    ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
    startArgs: params.adapter.readToolInput(params.invocation.rawPayload),
    result: params.adapter.readToolResponse(params.invocation.rawPayload),
  });
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function runNativeHookRelayPermissionRequest(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  try {
    const decision = await nativeHookRelayPermissionApprovalRequester({
      provider: params.registration.provider,
      ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
      sessionId: params.registration.sessionId,
      ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
      runId: params.registration.runId,
      toolName: normalizeNativeHookToolName(params.invocation.toolName),
      ...(params.invocation.toolUseId ? { toolCallId: params.invocation.toolUseId } : {}),
      ...(params.invocation.cwd ? { cwd: params.invocation.cwd } : {}),
      ...(params.invocation.model ? { model: params.invocation.model } : {}),
      toolInput: params.adapter.readToolInput(params.invocation.rawPayload),
      ...(params.registration.signal ? { signal: params.registration.signal } : {}),
    });
    if (decision === "allow") {
      return params.adapter.renderPermissionDecisionResponse("allow");
    }
    if (decision === "deny") {
      return params.adapter.renderPermissionDecisionResponse("deny", "Denied by user");
    }
  } catch (error) {
    log.warn(`native hook permission approval failed; deferring: ${String(error)}`);
  }
  return params.adapter.renderNoopResponse(params.invocation.event);
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

function readCodexToolInput(rawPayload: JsonValue): Record<string, unknown> {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  const toolInput = payload.tool_input;
  if (isJsonObject(toolInput)) {
    return toolInput;
  }
  if (toolInput === undefined) {
    return {};
  }
  return { value: toolInput };
}

function readCodexToolResponse(rawPayload: JsonValue): unknown {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  return payload.tool_response;
}

function normalizeNativeHookToolName(toolName: string | undefined): string {
  return normalizeToolName(toolName ?? "tool");
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
  if (Object.prototype.hasOwnProperty.call(requestResult ?? {}, "decision")) {
    decision = requestResult.decision;
  } else {
    const waitResult = await waitForNativeHookRelayApprovalDecision({
      approvalId,
      signal: request.signal,
      timeoutMs,
    });
    decision = waitResult?.decision;
  }
  if (
    decision === PluginApprovalResolutions.ALLOW_ONCE ||
    decision === PluginApprovalResolutions.ALLOW_ALWAYS
  ) {
    return "allow";
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
      reject(params.signal!.reason);
      return;
    }
    onAbort = () => reject(params.signal!.reason);
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
    `Tool: ${request.toolName}`,
    request.cwd ? `Cwd: ${request.cwd}` : undefined,
    request.model ? `Model: ${request.model}` : undefined,
    request.sessionKey ? `Session: ${request.sessionKey}` : undefined,
    formatToolInputPreview(request.toolInput),
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function formatToolInputPreview(toolInput: Record<string, unknown>): string | undefined {
  const command = readOptionalString(toolInput.command);
  if (command) {
    return `Command: ${truncateText(command.replace(/\s+/g, " ").trim(), 240)}`;
  }
  const keys = Object.keys(toolInput).toSorted();
  if (!keys.length) {
    return undefined;
  }
  return `Input keys: ${keys.slice(0, 12).join(", ")}`;
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
  const argvEntry = process.argv[1];
  if (argvEntry && existsSync(argvEntry)) {
    return argvEntry;
  }
  return "openclaw";
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
  return args.map(shellQuoteArg).join(" ");
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
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
  if (value === "pre_tool_use" || value === "post_tool_use" || value === "permission_request") {
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

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value as number) || typeof value !== "number";
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (!isJsonObject(value)) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export const __testing = {
  clearNativeHookRelaysForTests(): void {
    relays.clear();
    invocations.length = 0;
    nativeHookRelayPermissionApprovalRequester = requestNativeHookRelayPermissionApproval;
  },
  getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[] {
    return [...invocations];
  },
  getNativeHookRelayRegistrationForTests(relayId: string): NativeHookRelayRegistration | undefined {
    return relays.get(relayId);
  },
  setNativeHookRelayPermissionApprovalRequesterForTests(
    requester: NativeHookRelayPermissionApprovalRequester,
  ): void {
    nativeHookRelayPermissionApprovalRequester = requester;
  },
} as const;
