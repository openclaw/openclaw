import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

export enum CodexNativeThreadLifecycleReason {
  NativeTokenGuard = "native-token-guard",
  NativeByteGuard = "native-byte-guard",
  ContextEngineBindingMismatch = "context-engine-binding-mismatch",
  ProjectionMismatch = "projection-mismatch",
  DynamicToolsMismatch = "dynamic-tools-mismatch",
  McpConfigMismatch = "mcp-config-mismatch",
  EnvironmentSelectionMismatch = "environment-selection-mismatch",
  NativeToolSurfaceDisabled = "native-tool-surface-disabled",
  PluginAppConfigMismatch = "plugin-app-config-mismatch",
  AuthProfileMismatch = "auth-profile-mismatch",
  MissingThreadBinding = "missing-thread-binding",
  AppServerRejectedThread = "app-server-rejected-thread",
  ContextEngineCompactionInvalidatedBinding = "context-engine-compaction-invalidated-binding",
  ThreadBootstrapSemanticReuse = "thread-bootstrap-semantic-reuse",
}

export type CodexNativeThreadLifecycleAction =
  | "bypassed"
  | "failed"
  | "invalidated"
  | "rejected"
  | "reused"
  | "rotated";

export type CodexNativeThreadBindingMode =
  | "legacy"
  | "none"
  | "per_turn"
  | "thread_bootstrap"
  | "transient";

export type CodexNativeThreadLifecycleDiagnostic = {
  action: CodexNativeThreadLifecycleAction;
  reason: CodexNativeThreadLifecycleReason;
  threadId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  bindingMode?: CodexNativeThreadBindingMode;
  contextEngineId?: string;
  contextEnginePolicyFingerprint?: string;
  previousContextEngineId?: string;
  previousContextEnginePolicyFingerprint?: string;
  projectionMode?: "per_turn" | "thread_bootstrap";
  projectionEpoch?: string;
  projectionFingerprint?: string;
  previousProjectionEpoch?: string;
  previousProjectionFingerprint?: string;
  dynamicToolsFingerprint?: string;
  previousDynamicToolsFingerprint?: string;
  userMcpServersFingerprint?: string;
  previousUserMcpServersFingerprint?: string;
  mcpServersFingerprint?: string;
  previousMcpServersFingerprint?: string;
  environmentSelectionFingerprint?: string;
  previousEnvironmentSelectionFingerprint?: string;
  pluginAppsFingerprint?: string;
  previousPluginAppsFingerprint?: string;
  pluginAppsInputFingerprint?: string;
  previousPluginAppsInputFingerprint?: string;
  contextTokenBudget?: number;
  sessionTokens?: number;
  nativeTokens?: number;
  maxActiveTranscriptTokens?: number;
  maxActiveTranscriptBytes?: number;
  nativeTranscriptBytes?: number;
  renderedPromptChars?: number;
  renderedDeveloperInstructionChars?: number;
  renderedPromptTokensEstimate?: number;
  renderedDeveloperInstructionTokensEstimate?: number;
  contextEngineProjectionContributed?: boolean;
  workspaceBootstrapContributed?: boolean;
  nativeToolSurfaceEnabled?: boolean;
  semanticReuse?: boolean;
};

export type CodexNativeThreadLifecycleDiagnosticInput = CodexNativeThreadLifecycleDiagnostic & {
  level?: "debug" | "info" | "warn";
  message?: string;
  extra?: Record<string, unknown>;
};

export function resolveCodexNativeThreadBindingMode(
  binding: Pick<CodexAppServerThreadBinding, "contextEngine" | "threadId"> | undefined,
): CodexNativeThreadBindingMode {
  if (!binding?.threadId) {
    return "none";
  }
  if (binding.contextEngine?.projection?.mode === "thread_bootstrap") {
    return "thread_bootstrap";
  }
  if (binding.contextEngine) {
    return "per_turn";
  }
  return "legacy";
}

export function emitCodexNativeThreadLifecycleDiagnostic(
  input: CodexNativeThreadLifecycleDiagnosticInput,
): void {
  const { level = "info", message } = input;
  const payload = compactDiagnosticPayload(input);
  const logPayload = compactDiagnosticLogPayload(payload);
  const logMessage =
    message ?? `codex app-server native thread lifecycle: ${input.action} (${input.reason})`;

  if (level === "warn") {
    embeddedAgentLog.warn(logMessage, logPayload);
  } else if (level === "debug") {
    embeddedAgentLog.debug(logMessage, logPayload);
  } else {
    embeddedAgentLog.info(logMessage, logPayload);
  }

  emitTrustedDiagnosticEvent({
    type: "codex.native_thread.lifecycle",
    ...payload,
  });
}

function compactDiagnosticPayload(
  diagnostic: CodexNativeThreadLifecycleDiagnostic | CodexNativeThreadLifecycleDiagnosticInput,
): CodexNativeThreadLifecycleDiagnostic {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(diagnostic)) {
    if (key === "level" || key === "message" || key === "extra") {
      continue;
    }
    if (value === undefined) {
      continue;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      continue;
    }
    payload[key] = value;
  }
  return payload as CodexNativeThreadLifecycleDiagnostic;
}

function compactDiagnosticLogPayload(
  diagnostic: CodexNativeThreadLifecycleDiagnostic,
): Record<string, string | number | boolean> {
  const allowedKeys: Array<keyof CodexNativeThreadLifecycleDiagnostic> = [
    "action",
    "reason",
    "bindingMode",
    "projectionMode",
    "contextTokenBudget",
    "sessionTokens",
    "nativeTokens",
    "maxActiveTranscriptTokens",
    "maxActiveTranscriptBytes",
    "nativeTranscriptBytes",
    "renderedPromptChars",
    "renderedDeveloperInstructionChars",
    "renderedPromptTokensEstimate",
    "renderedDeveloperInstructionTokensEstimate",
    "contextEngineProjectionContributed",
    "workspaceBootstrapContributed",
    "nativeToolSurfaceEnabled",
    "semanticReuse",
  ];
  const payload: Record<string, string | number | boolean> = {};
  for (const key of allowedKeys) {
    const value = diagnostic[key];
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      payload[key] = value;
    }
  }
  return payload;
}
