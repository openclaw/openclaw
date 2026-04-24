import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

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
  renderNoopResponse: (event: NativeHookRelayEvent) => NativeHookRelayProcessResponse;
};

const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RELAY_TIMEOUT_MS = 5_000;
const relays = new Map<string, NativeHookRelayRegistration>();
const invocations: NativeHookRelayInvocation[] = [];

const nativeHookRelayProviderAdapters: Record<
  NativeHookRelayProvider,
  NativeHookRelayProviderAdapter
> = {
  codex: {
    normalizeMetadata: normalizeCodexHookMetadata,
    renderNoopResponse: () => {
      // Codex treats empty stdout plus exit 0 as no decision/no additional context.
      return { stdout: "", stderr: "", exitCode: 0 };
    },
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

export function invokeNativeHookRelay(
  params: InvokeNativeHookRelayParams,
): NativeHookRelayProcessResponse {
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
  return getNativeHookRelayProviderAdapter(provider).renderNoopResponse(event);
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
  },
  getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[] {
    return [...invocations];
  },
  getNativeHookRelayRegistrationForTests(relayId: string): NativeHookRelayRegistration | undefined {
    return relays.get(relayId);
  },
} as const;
