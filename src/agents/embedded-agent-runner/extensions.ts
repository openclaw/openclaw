/**
 * Builds extension factories available to embedded-agent runtime sessions.
 */
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { normalizeAcceptedSessionSpawnResult } from "../accepted-session-spawn.js";
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
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { createAgentToolResultMiddlewareRunner } from "../harness/tool-result-middleware.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "../model-auth.js";
import { isOpenAIProvider } from "../openai-routing.js";
import { agentRuntimeAuthPlanMatchesTarget } from "../runtime-plan/prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";
import type { AgentToolResult } from "../runtime/index.js";
import type { ExtensionFactory, ModelRegistry, SessionManager } from "../sessions/index.js";
import { isToolResultError } from "../tool-result-error.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";
import { prepareCompactionRuntimeAuth } from "./compaction-runtime-auth.js";
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
      const isAcceptedSessionSpawn =
        event.toolName === "sessions_spawn" && normalizeAcceptedSessionSpawnResult(result) !== null;
      const isError =
        !isAcceptedSessionSpawn &&
        (event.isError === true || inputHadErrorStatus || isToolResultError(result));
      const clearsAcceptedSessionSpawnError =
        isAcceptedSessionSpawn &&
        (event.isError === true || inputHadErrorStatus || isToolResultError(result));
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
        ...(clearsAcceptedSessionSpawnError ? { isError: false } : {}),
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

export type SafeguardRuntimeTarget = {
  provider: string;
  runtimeProvider?: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
  modelRegistry?: ModelRegistry;
  authProfileId?: string;
  runtimeAuthPlan?: AgentRuntimeAuthPlan;
  requiresAuthPreparation: boolean;
};

function resolveSafeguardRuntimeTarget(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
  modelRegistry?: ModelRegistry;
  agentDir?: string;
  workspaceDir?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  runtimeAuthPlan?: AgentRuntimeAuthPlan;
  harnessRuntime?: string;
  modelSelectionLocked?: boolean;
  resolveOverrideModel?: boolean;
}): SafeguardRuntimeTarget {
  const resolved = resolveEmbeddedCompactionTarget({
    config: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    authProfileId: params.authProfileId,
    harnessRuntime: params.harnessRuntime,
    modelSelectionLocked: params.modelSelectionLocked,
  });
  const provider = resolved.provider ?? params.provider;
  const modelId = resolved.model ?? params.modelId;
  const matchingRuntimeAuthPlan =
    params.runtimeAuthPlan &&
    agentRuntimeAuthPlanMatchesTarget(params.runtimeAuthPlan, { provider, modelId })
      ? params.runtimeAuthPlan
      : undefined;
  if (
    !hasCompactionModelOverride(params.cfg) ||
    (provider === params.provider && modelId === params.modelId)
  ) {
    return {
      provider,
      runtimeProvider: resolved.runtimeProvider,
      modelId,
      model: params.model,
      modelRegistry: params.modelRegistry,
      authProfileId: resolved.authProfileId,
      runtimeAuthPlan: matchingRuntimeAuthPlan,
      requiresAuthPreparation: false,
    };
  }

  if (params.resolveOverrideModel === false) {
    return {
      provider,
      runtimeProvider: resolved.runtimeProvider,
      modelId,
      model: undefined,
      authProfileId: resolved.authProfileId,
      requiresAuthPreparation: true,
    };
  }

  const model = params.modelRegistry
    ? resolveModelWithRegistry({
        provider: resolved.runtimeProvider ?? provider,
        modelId,
        modelRegistry: params.modelRegistry,
        cfg: params.cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        authProfileId: resolved.authProfileId,
      })
    : undefined;
  if (model) {
    return {
      provider,
      runtimeProvider: resolved.runtimeProvider,
      modelId,
      model,
      modelRegistry: params.modelRegistry,
      authProfileId: resolved.authProfileId,
      requiresAuthPreparation: true,
    };
  }

  log.warn(
    `Configured safeguard compaction model "${provider}/${modelId}" could not be resolved; ` +
      "using the active session model when available, otherwise safeguard compaction will be skipped.",
  );
  return {
    provider: params.provider,
    modelId: params.modelId,
    model: params.model,
    modelRegistry: params.modelRegistry,
    authProfileId: params.authProfileId,
    runtimeAuthPlan:
      params.runtimeAuthPlan &&
      agentRuntimeAuthPlanMatchesTarget(params.runtimeAuthPlan, {
        provider: params.provider,
        modelId: params.modelId,
      })
        ? params.runtimeAuthPlan
        : undefined,
    requiresAuthPreparation: false,
  };
}

export async function prepareSafeguardRuntimeTarget(
  params: Parameters<typeof resolveSafeguardRuntimeTarget>[0] & {
    /** Optional target-store injection for tests; callers must not pass the active scoped store. */
    authProfileStore?: AuthProfileStore;
  },
): Promise<SafeguardRuntimeTarget | undefined> {
  if (resolveEffectiveCompactionMode(params.cfg) !== "safeguard") {
    return undefined;
  }
  const target = resolveSafeguardRuntimeTarget({ ...params, resolveOverrideModel: false });
  if (!target.requiresAuthPreparation) {
    return target;
  }

  try {
    const authProfileStore =
      params.authProfileStore ??
      (isOpenAIProvider(target.provider)
        ? ensureAuthProfileStore(params.agentDir, {
            externalCliProviderIds: ["openai"],
            allowKeychainPrompt: false,
          })
        : ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
            allowKeychainPrompt: false,
          }));
    const prepared = await prepareCompactionRuntimeAuth({
      provider: target.provider,
      runtimeProvider: target.runtimeProvider,
      modelId: target.modelId,
      config: params.cfg,
      authProfileStore,
      authProfileId: target.authProfileId,
      authProfileIdSource:
        target.authProfileId && target.authProfileId === params.authProfileId
          ? params.authProfileIdSource
          : undefined,
      runtimeAuthPlan: params.runtimeAuthPlan,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    });
    return {
      ...target,
      model: prepared.model,
      modelRegistry: prepared.modelRegistry,
      authProfileId: prepared.authProfileId,
      runtimeAuthPlan: prepared.runtimeAuthPlan,
    };
  } catch (err) {
    log.warn(
      `Configured safeguard compaction model "${target.provider}/${target.modelId}" auth could not be prepared (${formatErrorMessage(err)}); ` +
        "using the active session model when available, otherwise safeguard compaction will be skipped.",
    );
    return {
      provider: params.provider,
      modelId: params.modelId,
      model: params.model,
      modelRegistry: params.modelRegistry,
      authProfileId: params.authProfileId,
      runtimeAuthPlan:
        params.runtimeAuthPlan &&
        agentRuntimeAuthPlanMatchesTarget(params.runtimeAuthPlan, {
          provider: params.provider,
          modelId: params.modelId,
        })
          ? params.runtimeAuthPlan
          : undefined,
      requiresAuthPreparation: false,
    };
  }
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
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  runtimeAuthPlan?: AgentRuntimeAuthPlan;
  harnessRuntime?: string;
  modelSelectionLocked?: boolean;
  safeguardRuntimeTarget?: SafeguardRuntimeTarget;
  runId?: string;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  if (resolveEffectiveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const qualityGuardCfg = compactionCfg?.qualityGuard;
    const runtimeTarget = params.safeguardRuntimeTarget ?? resolveSafeguardRuntimeTarget(params);
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
      modelRegistry: runtimeTarget.modelRegistry,
      runtimeAuthPlan: runtimeTarget.runtimeAuthPlan,
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
