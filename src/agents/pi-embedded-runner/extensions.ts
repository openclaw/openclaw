import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { createAgentToolResultMiddlewareRunner } from "../harness/tool-result-middleware.js";
import { setCompactionInterceptRuntime } from "../pi-hooks/compaction-intercept-runtime.js";
import compactionInterceptExtension from "../pi-hooks/compaction-intercept.js";
import { setCompactionSafeguardRuntime } from "../pi-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-hooks/compaction-safeguard.js";
import contextPruningExtension from "../pi-hooks/context-pruning.js";
import { setContextPruningRuntime } from "../pi-hooks/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-hooks/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-hooks/context-pruning/tools.js";
import { ensurePiCompactionReserveTokens, resolveEffectiveCompactionMode } from "../pi-settings.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";

type PiToolResultEvent = {
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

// Only checks "error" and "timeout" — the status values emitted by the
// adapter's buildToolExecutionErrorResult. The subscribe-side classifier
// (isErrorLikeStatus) uses a broader regex because it handles arbitrary
// external tool results; this bridge only elevates adapter-produced statuses.
function hasErrorToolResultStatus(result: AgentToolResult<unknown>): boolean {
  const details = recordFromUnknown(result.details);
  const status = normalizeOptionalLowercaseString(details.status);
  return status === "error" || status === "timeout";
}

function buildAgentToolResultMiddlewareFactory(): ExtensionFactory {
  const runner = createAgentToolResultMiddlewareRunner({ runtime: "pi" });
  return (pi) => {
    pi.on("tool_result", async (rawEvent: unknown, ctx: { cwd?: string }) => {
      const event = recordFromUnknown(rawEvent) as PiToolResultEvent;
      if (!event.toolName) {
        return undefined;
      }
      const toolCallId =
        typeof event.toolCallId === "string" && event.toolCallId.trim()
          ? event.toolCallId
          : `pi-${randomUUID()}`;
      const content = Array.isArray(event.content) ? event.content : [];
      const current = {
        content,
        details: event.details,
      } satisfies AgentToolResult<unknown>;
      const inputHadErrorStatus = hasErrorToolResultStatus(current);
      const result = await runner.applyToolResultMiddleware({
        threadId: event.threadId,
        turnId: event.turnId,
        toolCallId,
        toolName: event.toolName,
        args: recordFromUnknown(event.input),
        cwd: ctx.cwd,
        isError: event.isError,
        result: current,
      });
      const isError =
        event.isError === true || inputHadErrorStatus || hasErrorToolResultStatus(result);
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

export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
  /**
   * Active context engine for the user-facing session, when known.
   *
   * When the engine declares `info.interceptsCompaction === true` and does
   * NOT own compaction outright, a `compaction-intercept` extension is
   * registered that routes `session_before_compact` events through
   * `engine.interceptCompaction()`. Inner LLM sessions (compaction LLM,
   * subagent runs that have no separate engine) pass `undefined` to skip.
   */
  activeContextEngine?: ContextEngine;
  /**
   * Openclaw session key (agent:id:suffix form) for the active session.
   * Threaded into the compaction-intercept runtime so engines that route on
   * sessionKey (e.g. ignored-/stateless-session patterns in lossless-claw)
   * receive it inside the `session_before_compact` handler.
   */
  sessionKey?: string;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  if (resolveEffectiveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const qualityGuardCfg = compactionCfg?.qualityGuard;
    const contextWindowInfo = resolveContextWindowInfo({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      modelContextTokens: params.model?.contextTokens,
      modelContextWindow: params.model?.contextWindow,
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
      model: params.model,
      recentTurnsPreserve: compactionCfg?.recentTurnsPreserve,
      provider: compactionCfg?.provider,
    });
    factories.push(compactionSafeguardExtension);
  }
  // Context-engine intercept: registered AFTER the safeguard so its result
  // wins under last-truthy-wins semantics when both are active.
  //
  // Gate is `interceptsCompaction === true` ONLY (no exclusion for
  // `ownsCompaction === true`). The two flags advertise capability against
  // distinct flows:
  //   - `ownsCompaction` covers the openclaw queued-compaction lane
  //     (`compact.queued.ts` → `engine.compact()`), driven by `afterTurn`
  //     or explicit user `/compact`.
  //   - `interceptsCompaction` covers the pi-coding-agent SDK event
  //     (`session_before_compact`), driven by codex's in-attempt overflow
  //     auto-compact at ~90% context.
  // An engine can advertise BOTH (e.g. lossless-claw v4.1 owns the queued
  // lane AND intercepts the SDK lane), so neither flag excludes the other.
  const engineInfo = params.activeContextEngine?.info;
  if (params.activeContextEngine && engineInfo?.interceptsCompaction === true) {
    setCompactionInterceptRuntime(params.sessionManager, {
      contextEngine: params.activeContextEngine,
      sessionKey: params.sessionKey,
    });
    factories.push(compactionInterceptExtension);
  }
  const pruningFactory = buildContextPruningFactory(params);
  if (pruningFactory) {
    factories.push(pruningFactory);
  }
  factories.push(buildAgentToolResultMiddlewareFactory());
  return factories;
}

export { ensurePiCompactionReserveTokens };
