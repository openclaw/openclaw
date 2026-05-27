import { createHash } from "node:crypto";
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
  ContextEngineCompactionPreservedBinding = "context-engine-compaction-preserved-binding",
  ThreadBootstrapSemanticReuse = "thread-bootstrap-semantic-reuse",
}

export type CodexNativeThreadLifecycleAction =
  | "bypassed"
  | "failed"
  | "invalidated"
  | "preserved"
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
  sessionFile?: string;
  previousSessionFile?: string;
  successorSessionFile?: string;
  compactionRolledOver?: boolean;
  sessionKey?: string;
  sessionId?: string;
  previousSessionId?: string;
  successorSessionId?: string;
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

const SENSITIVE_COMPARISON_FIELDS = new Set<string>([
  "userMcpServersFingerprint",
  "previousUserMcpServersFingerprint",
  "environmentSelectionFingerprint",
  "previousEnvironmentSelectionFingerprint",
]);

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
    payload[key] = sanitizeDiagnosticValue(key, value);
  }
  return payload as CodexNativeThreadLifecycleDiagnostic;
}

function sanitizeDiagnosticValue(key: string, value: unknown): unknown {
  if (SENSITIVE_COMPARISON_FIELDS.has(key) && typeof value === "string") {
    if (/^sha256:[a-f0-9]{64}$/i.test(value)) {
      return value;
    }
    return fingerprintDiagnosticString(key, value);
  }
  return value;
}

function fingerprintDiagnosticString(key: string, value: string): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:native-thread-diagnostic:v1");
  hash.update("\0");
  hash.update(key);
  hash.update("\0");
  hash.update(value);
  return `sha256:${hash.digest("hex")}`;
}

function compactDiagnosticLogPayload(
  diagnostic: CodexNativeThreadLifecycleDiagnostic,
): Record<string, string | number | boolean> {
  const allowedKeys: Array<keyof CodexNativeThreadLifecycleDiagnostic> = [
    "action",
    "reason",
    "bindingMode",
    "projectionMode",
    "compactionRolledOver",
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
