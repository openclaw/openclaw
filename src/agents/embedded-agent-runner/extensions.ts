/**
 * Builds extension factories available to embedded-agent runtime sessions.
 */
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import contextPruningExtension from "../agent-hooks/context-pruning.js";
import { setContextPruningRuntime } from "../agent-hooks/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../agent-hooks/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../agent-hooks/context-pruning/tools.js";
import { resolveEffectiveCompactionMode } from "../agent-settings.js";
import {
  finalizeToolTerminalPresentation,
  peekAdjustedParamsForToolCall,
} from "../agent-tools.before-tool-call.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { createAgentToolResultMiddlewareRunner } from "../harness/tool-result-middleware.js";
import type { AgentToolResult } from "../runtime/index.js";
import type { ExtensionFactory, ModelRegistry, SessionManager } from "../sessions/index.js";
import { isToolResultError } from "../tool-result-error.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";
import { resolveEmbeddedCompactionTarget } from "./compaction-runtime-context.js";
import { log } from "./logger.js";
import { resolveModelWithRegistry } from "./model.js";
import { recordEmbeddedToolSendReceipt } from "./tool-send-receipts.js";

type AgentToolResultEvent = {
  threadId?: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  content?: AgentToolResult<unknown>["content"];
  details?: unknown;
  isError?: boolean;
};

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function snapshotToolSendReceipt(details: unknown): unknown {
  const toolSend = recordFromUnknown(details).toolSend;
  return toolSend && typeof toolSend === "object" && !Array.isArray(toolSend)
    ? { ...(toolSend as Record<string, unknown>) }
    : toolSend;
}

function buildAgentToolResultMiddlewareFactory(
  sessionManager: SessionManager,
  runId?: string,
): ExtensionFactory {
  const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" });
  return (agent) => {
    agent.on("tool_result", async (rawEvent: unknown, ctx: { cwd?: string }) => {
      const event = recordFromUnknown(rawEvent) as AgentToolResultEvent;
      if (!event.toolName) {
        return undefined;
      }
      const eventToolCallId =
        typeof event.toolCallId === "string" && event.toolCallId.trim()
          ? event.toolCallId
          : undefined;
      const toolCallId = eventToolCallId ?? `openclaw-${randomUUID()}`;
      const content = Array.isArray(event.content) ? event.content : [];
      const current = {
        content,
        details: event.details,
      } satisfies AgentToolResult<unknown>;
      const rawToolSend = snapshotToolSendReceipt(current.details);
      if (eventToolCallId && rawToolSend !== undefined) {
        // Routing evidence stays private so middleware may fully replace result details.
        recordEmbeddedToolSendReceipt(sessionManager, eventToolCallId, rawToolSend);
      }
      const inputHadErrorStatus = isToolResultError(current);
      const adjustedInput = eventToolCallId
        ? peekAdjustedParamsForToolCall(eventToolCallId, runId)
        : undefined;
      const result = await runner.applyToolResultMiddleware({
        threadId: event.threadId,
        turnId: event.turnId,
        toolCallId,
        toolName: event.toolName,
        args: recordFromUnknown(adjustedInput ?? event.input),
        cwd: ctx.cwd,
        isError: event.isError,
        result: current,
      });
      const isError = event.isError === true || inputHadErrorStatus || isToolResultError(result);
      if (eventToolCallId) {
        finalizeToolTerminalPresentation({
          toolCallId: eventToolCallId,
          runId,
          result,
          isError,
        });
      }
      return {
        content: result.content,
        details: result.details,
        ...(isError ? { isError: true } : {}),
      };
    });
  };
}

function resolveContextWindowTokens(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    modelContextTokens: params.model?.contextTokens,
    modelContextWindow: params.model?.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
}

function buildContextPruningFactory(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
}): ExtensionFactory | undefined {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "cache-ttl") {
    return undefined;
  }
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId, params.model?.api)) {
    return undefined;
  }

  const settings = computeEffectiveSettings(raw);
  if (!settings) {
    return undefined;
  }
  const transcriptPolicy = resolveTranscriptPolicy({
    modelApi: params.model?.api,
    provider: params.provider,
    modelId: params.modelId,
  });

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    dropThinkingBlocks: transcriptPolicy.dropThinkingBlocks,
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager, {
      provider: params.provider,
      modelId: params.modelId,
    }),
  });

  return contextPruningExtension;
}

function hasCompactionModelOverride(cfg?: OpenClawConfig): boolean {
  return Boolean(cfg?.agents?.defaults?.compaction?.model?.trim());
}

export function resolveSafeguardRuntimeTarget(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
  modelRegistry?: ModelRegistry;
  agentDir?: string;
  workspaceDir?: string;
}): { provider: string; modelId: string; model: ProviderRuntimeModel | undefined } {
  const resolved = resolveEmbeddedCompactionTarget({
    config: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
  });
  const provider = resolved.provider ?? params.provider;
  const modelId = resolved.model ?? params.modelId;
  if (
    !hasCompactionModelOverride(params.cfg) ||
    (provider === params.provider && modelId === params.modelId)
  ) {
    return { provider, modelId, model: params.model };
  }

  const model = params.modelRegistry
    ? resolveModelWithRegistry({
        provider,
        modelId,
        modelRegistry: params.modelRegistry,
        cfg: params.cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      })
    : undefined;
  if (!model) {
    log.warn(
      `Configured safeguard compaction model "${provider}/${modelId}" could not be resolved against the model registry; using the session model when available, otherwise compaction will be skipped.`,
    );
  }
  return { provider, modelId, model };
}
export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
  modelRegistry?: ModelRegistry;
  agentDir?: string;
  runId?: string;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  if (resolveEffectiveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const qualityGuardCfg = compactionCfg?.qualityGuard;
    const runtimeTarget = resolveSafeguardRuntimeTarget(params);
    const contextWindowInfo = resolveContextWindowInfo({
      cfg: params.cfg,
      provider: runtimeTarget.provider,
      modelId: runtimeTarget.modelId,
      modelContextTokens: runtimeTarget.model?.contextTokens,
      modelContextWindow: runtimeTarget.model?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    setCompactionSafeguardRuntime(params.sessionManager, {
      maxHistoryShare: compactionCfg?.maxHistoryShare,
      contextWindowTokens: contextWindowInfo.tokens,
      identifierPolicy: compactionCfg?.identifierPolicy,
      identifierInstructions: compactionCfg?.identifierInstructions,
      customInstructions: compactionCfg?.customInstructions,
      qualityGuardEnabled: qualityGuardCfg?.enabled ?? true,
      qualityGuardMaxRetries: qualityGuardCfg?.maxRetries,
      model: runtimeTarget.model,
      recentTurnsPreserve: compactionCfg?.recentTurnsPreserve,
      workspaceDir: params.workspaceDir,
      postCompactionSections: compactionCfg?.postCompactionSections,
      provider: compactionCfg?.provider,
    });
    factories.push(compactionSafeguardExtension);
  }
  const pruningFactory = buildContextPruningFactory(params);
  if (pruningFactory) {
    factories.push(pruningFactory);
  }
  factories.push(buildAgentToolResultMiddlewareFactory(params.sessionManager, params.runId));
  return factories;
}
