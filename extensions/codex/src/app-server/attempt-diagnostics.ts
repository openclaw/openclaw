/**
 * Diagnostic helpers for Codex app-server model calls and plugin-thread config
 * eligibility.
 */
import { createHash } from "node:crypto";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticModelCallContent,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { CodexAppServerRuntimeOptions, resolveCodexPluginsPolicy } from "./config.js";

type TrustedDiagnosticEventInput = Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0];
const UNREADABLE_DIAGNOSTIC_VALUE = "<unreadable>";
const UNREADABLE_DIAGNOSTIC_TOOL_NAME = "<unreadable diagnostic tool>";
const MAX_DIAGNOSTIC_VALUE_DEPTH = 6;
const MAX_DIAGNOSTIC_VALUE_NODES = 1_000;
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 100;
const MAX_DIAGNOSTIC_OBJECT_KEYS = 100;

type CodexDiagnosticValueState = {
  seen: WeakSet<object>;
  nodes: number;
};

/** Reads a tool schema field in either app-server or OpenClaw naming. */
export function readCodexDiagnosticToolParameters(tool: {
  inputSchema?: unknown;
  parameters?: unknown;
}): unknown {
  const inputSchema = readCodexDiagnosticToolField(tool, "inputSchema");
  if (!inputSchema.readable) {
    return UNREADABLE_DIAGNOSTIC_VALUE;
  }
  if (inputSchema.value !== undefined) {
    return toJsonSafeCodexDiagnosticValue(inputSchema.value);
  }

  const parameters = readCodexDiagnosticToolField(tool, "parameters");
  if (!parameters.readable) {
    return UNREADABLE_DIAGNOSTIC_VALUE;
  }
  return toJsonSafeCodexDiagnosticValue(parameters.value);
}

/** Builds compact diagnostic tool definitions for trusted private telemetry. */
export function buildCodexDiagnosticToolDefinitions(
  tools: readonly {
    name: string;
    description: string;
    inputSchema?: unknown;
    parameters?: unknown;
  }[],
) {
  return tools.map((tool) => ({
    name: readCodexDiagnosticToolName(tool),
    description: readCodexDiagnosticToolDescription(tool),
    parameters: readCodexDiagnosticToolParameters(tool),
  }));
}

function readCodexDiagnosticToolName(tool: { name: string }): string {
  const name = readCodexDiagnosticToolField(tool, "name");
  if (!name.readable || typeof name.value !== "string" || name.value.trim().length === 0) {
    return UNREADABLE_DIAGNOSTIC_TOOL_NAME;
  }
  return name.value;
}

function readCodexDiagnosticToolDescription(tool: { description: string }): string {
  const description = readCodexDiagnosticToolField(tool, "description");
  return description.readable && typeof description.value === "string" ? description.value : "";
}

function readCodexDiagnosticToolField<TTool extends object, TField extends keyof TTool & string>(
  tool: TTool,
  field: TField,
): { readable: true; value: TTool[TField] } | { readable: false } {
  try {
    return { readable: true, value: tool[field] };
  } catch {
    return { readable: false };
  }
}

function toJsonSafeCodexDiagnosticValue(
  value: unknown,
  depth = 0,
  state: CodexDiagnosticValueState = { seen: new WeakSet(), nodes: 0 },
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_DIAGNOSTIC_VALUE_NODES) {
    return "<truncated>";
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return null;
  }
  if (depth >= MAX_DIAGNOSTIC_VALUE_DEPTH) {
    return "<truncated>";
  }
  if (isDiagnosticArray(value)) {
    if (state.seen.has(value)) {
      return "<truncated>";
    }
    state.seen.add(value);
    let length: number;
    try {
      length = Math.min(value.length, MAX_DIAGNOSTIC_ARRAY_ITEMS);
    } catch {
      return UNREADABLE_DIAGNOSTIC_VALUE;
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      result.push(
        toJsonSafeCodexDiagnosticValue(readDiagnosticArrayItem(value, index), depth + 1, state),
      );
    }
    return result;
  }
  if (typeof value === "object") {
    if (state.seen.has(value)) {
      return "<truncated>";
    }
    state.seen.add(value);
    let keys: string[];
    try {
      keys = Object.keys(value).slice(0, MAX_DIAGNOSTIC_OBJECT_KEYS);
    } catch {
      return UNREADABLE_DIAGNOSTIC_VALUE;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = toJsonSafeCodexDiagnosticValue(
        readDiagnosticObjectField(value as Record<string, unknown>, key),
        depth + 1,
        state,
      );
    }
    return result;
  }
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return UNREADABLE_DIAGNOSTIC_VALUE;
  }
}

function isDiagnosticArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function readDiagnosticArrayItem(value: readonly unknown[], index: number): unknown {
  try {
    return value[index];
  } catch {
    return UNREADABLE_DIAGNOSTIC_VALUE;
  }
}

function readDiagnosticObjectField(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return UNREADABLE_DIAGNOSTIC_VALUE;
  }
}

/** Returns the serialized UTF-8 byte length for a JSON-compatible value. */
export function utf8JsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

/** Builds a short namespaced fingerprint for sensitive log values. */
export function fingerprintCodexLogValue(namespace: string, value: string): string {
  const hash = createHash("sha256");
  hash.update(namespace);
  hash.update("\0");
  hash.update(value);
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}

/**
 * Builds redacted diagnostics explaining whether plugin thread config was
 * eligible for a Codex app-server attempt.
 */
export function buildCodexPluginThreadConfigEligibilityLogData(params: {
  sessionId: string;
  sessionKey: string;
  pluginThreadConfigRequired: boolean;
  resolvedPluginPolicy: ReturnType<typeof resolveCodexPluginsPolicy> | undefined;
  enabledPluginConfigKeys: string[] | undefined;
  pluginAppCacheKey: string;
  startupAuthProfileId: string | undefined;
  appServer: CodexAppServerRuntimeOptions;
}): Record<string, unknown> {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    enabled: params.pluginThreadConfigRequired,
    policyConfigured: params.resolvedPluginPolicy?.configured === true,
    policyEnabled: params.resolvedPluginPolicy?.enabled === true,
    pluginConfigKeys: params.resolvedPluginPolicy?.pluginPolicies
      .map((plugin) => plugin.configKey)
      .toSorted(),
    enabledPluginConfigKeys: params.enabledPluginConfigKeys,
    appCacheKeyFingerprint: fingerprintCodexLogValue(
      "openclaw:codex:plugin-app-cache-key:v1",
      params.pluginAppCacheKey,
    ),
    authProfileId: params.startupAuthProfileId,
    appServerTransport: params.appServer.start.transport,
    appServerCommandSource: params.appServer.start.commandSource,
  };
}

type CodexModelCallFailureKind = "aborted" | "timeout";

type CodexModelCallDiagnosticCapture = {
  inputMessages?: boolean;
  outputMessages?: boolean;
  systemPrompt?: boolean;
  toolDefinitions?: boolean;
};

type CodexModelCallDiagnosticTool = {
  name: string;
  description: string;
  inputSchema?: unknown;
  parameters?: unknown;
};

/**
 * Creates lifecycle emitters for trusted model-call diagnostics with optional
 * private payload capture.
 */
export function createCodexModelCallDiagnosticEmitter(params: {
  baseFields: Record<string, unknown>;
  capture: CodexModelCallDiagnosticCapture;
  tools: readonly CodexModelCallDiagnosticTool[];
  buildInputMessages: () => unknown;
  buildSystemPrompt: () => string | undefined;
  now?: () => number;
  onErrorDiagnostic?: (error: unknown) => void;
}) {
  const now = params.now ?? (() => Date.now());
  const toolDefinitions = params.capture.toolDefinitions
    ? buildCodexDiagnosticToolDefinitions(params.tools)
    : undefined;
  let startedAt = now();
  let started = false;
  let terminalEmitted = false;
  let requestPayloadBytes: number | undefined;

  const privateData = (modelContent: DiagnosticModelCallContent | undefined) =>
    modelContent && Object.keys(modelContent).length > 0 ? { modelContent } : undefined;
  const buildContent = (): DiagnosticModelCallContent | undefined => {
    const modelContent = {
      ...(params.capture.inputMessages ? { inputMessages: params.buildInputMessages() } : {}),
      ...(params.capture.systemPrompt ? { systemPrompt: params.buildSystemPrompt() } : {}),
      ...(toolDefinitions ? { toolDefinitions } : {}),
    };
    return Object.keys(modelContent).length > 0 ? modelContent : undefined;
  };
  const requestPayloadBytesField = () =>
    requestPayloadBytes !== undefined ? { requestPayloadBytes } : {};

  return {
    setRequestPayloadBytes(bytes: number | undefined): void {
      requestPayloadBytes = bytes;
    },
    emitStarted(): void {
      startedAt = now();
      started = true;
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.started",
          ...params.baseFields,
        } as TrustedDiagnosticEventInput,
        privateData(buildContent()),
      );
    },
    emitCompleted(result: { assistantTexts?: unknown; lastAssistant?: unknown }): void {
      if (!started || terminalEmitted) {
        return;
      }
      terminalEmitted = true;
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.completed",
          ...params.baseFields,
          durationMs: Math.max(0, now() - startedAt),
          ...requestPayloadBytesField(),
        } as TrustedDiagnosticEventInput,
        privateData({
          ...buildContent(),
          ...(params.capture.outputMessages
            ? {
                outputMessages: result.lastAssistant
                  ? [result.lastAssistant]
                  : result.assistantTexts,
              }
            : {}),
        }),
      );
    },
    emitError(error: unknown, fields: { failureKind?: CodexModelCallFailureKind } = {}): void {
      if (!started || terminalEmitted) {
        return;
      }
      terminalEmitted = true;
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.error",
          ...params.baseFields,
          durationMs: Math.max(0, now() - startedAt),
          errorCategory: fields.failureKind ?? "error",
          ...(fields.failureKind ? { failureKind: fields.failureKind } : {}),
          ...requestPayloadBytesField(),
        } as TrustedDiagnosticEventInput,
        privateData({
          ...buildContent(),
          ...(params.capture.outputMessages ? { outputMessages: [] } : {}),
        }),
      );
      params.onErrorDiagnostic?.(error);
    },
  };
}

/** Classifies model-call failures into timeout/abort buckets for diagnostics. */
export function classifyCodexModelCallFailureKind(params: {
  error: unknown;
  timedOut: boolean;
  turnCompletionIdleTimedOut: boolean;
  runAborted: boolean;
  abortReason: unknown;
  clientClosedAbort: boolean;
  formatError: (error: unknown) => string;
}): CodexModelCallFailureKind | undefined {
  if (params.timedOut || params.turnCompletionIdleTimedOut) {
    return "timeout";
  }
  const errorMessage = params.error ? params.formatError(params.error).toLowerCase() : "";
  if (errorMessage.includes("timed out") || errorMessage.includes("timeout")) {
    return "timeout";
  }
  if (params.runAborted && !params.clientClosedAbort) {
    const abortReason =
      typeof params.abortReason === "string"
        ? params.abortReason.toLowerCase()
        : params.abortReason
          ? params.formatError(params.abortReason).toLowerCase()
          : "";
    return abortReason.includes("timeout") ? "timeout" : "aborted";
  }
  return errorMessage.includes("aborted") ? "aborted" : undefined;
}
