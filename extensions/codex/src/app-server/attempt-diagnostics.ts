import { createHash } from "node:crypto";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticModelCallContent,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { CodexAppServerRuntimeOptions, resolveCodexPluginsPolicy } from "./config.js";

type TrustedDiagnosticEventInput = Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0];

export function utf8JsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function fingerprintCodexLogValue(namespace: string, value: string): string {
  const hash = createHash("sha256");
  hash.update(namespace);
  hash.update("\0");
  hash.update(value);
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}

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
    allowAllPlugins: params.resolvedPluginPolicy?.allowAllPlugins === true,
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
    ? params.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? tool.parameters,
      }))
    : undefined;
  let startedAt = now();
  let started = false;
  let terminalEmitted = false;
  let requestPayloadBytes: number | undefined;

  const privateData = (modelContent: DiagnosticModelCallContent | undefined) =>
    modelContent && Object.keys(modelContent).length > 0 ? { modelContent } : undefined;
  const buildContent = (): DiagnosticModelCallContent => ({
    ...(params.capture.inputMessages ? { inputMessages: params.buildInputMessages() } : {}),
    ...(params.capture.systemPrompt ? { systemPrompt: params.buildSystemPrompt() } : {}),
    ...(toolDefinitions ? { toolDefinitions } : {}),
  });
  const emitTerminal = (
    type: "model.call.completed" | "model.call.error",
    outputMessages: unknown,
    fields: { errorCategory?: string; failureKind?: CodexModelCallFailureKind } = {},
  ): boolean => {
    if (!started || terminalEmitted) {
      return false;
    }
    terminalEmitted = true;
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type,
        ...params.baseFields,
        durationMs: Math.max(0, now() - startedAt),
        ...fields,
        ...(requestPayloadBytes !== undefined ? { requestPayloadBytes } : {}),
      } as TrustedDiagnosticEventInput,
      privateData({
        ...buildContent(),
        ...(params.capture.outputMessages ? { outputMessages } : {}),
      }),
    );
    return true;
  };

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
      emitTerminal(
        "model.call.completed",
        result.lastAssistant ? [result.lastAssistant] : result.assistantTexts,
      );
    },
    emitError(error: unknown, fields: { failureKind?: CodexModelCallFailureKind } = {}): void {
      if (
        emitTerminal("model.call.error", [], {
          errorCategory: fields.failureKind ?? "error",
          ...(fields.failureKind ? { failureKind: fields.failureKind } : {}),
        })
      ) {
        params.onErrorDiagnostic?.(error);
      }
    },
  };
}

export function classifyCodexModelCallFailureKind(params: {
  error: unknown;
  timedOut: boolean;
  runAborted: boolean;
  abortReason: unknown;
  clientClosedAbort: boolean;
  formatError: (error: unknown) => string;
}): CodexModelCallFailureKind | undefined {
  if (params.timedOut) {
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
