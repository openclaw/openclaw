import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { normalizeAcceptedSessionSpawnResult } from "../accepted-session-spawn.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import { resolveEffectiveCompactionMode } from "../agent-settings.js";
import {
  finalizeToolTerminalPresentation,
  peekAdjustedParamsForToolCall,
} from "../agent-tools.before-tool-call.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { createAgentToolResultMiddlewareRunner } from "../harness/tool-result-middleware.js";
import type { AgentToolResult } from "../runtime/index.js";
import type { ToolResultEvent } from "../sessions/extensions/types.js";
import type { ExtensionFactory, SessionManager } from "../sessions/index.js";
import { isToolResultError } from "../tool-result-error.js";
import { recordEmbeddedToolReceipt } from "./tool-send-receipts.js";

export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
  contextTokenBudget?: number;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  if (resolveEffectiveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const qualityGuardCfg = compactionCfg?.qualityGuard;
    // Prepared runs carry the canonical policy budget; fallback resolution is
    // only for callers that do not own a prepared attempt.
    const contextWindowTokens =
      params.contextTokenBudget ??
      resolveContextWindowInfo({
        cfg: params.cfg,
        provider: params.provider,
        modelId: params.modelId,
        modelContextTokens: params.model?.contextTokens,
        modelContextWindow: params.model?.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      }).tokens;
    setCompactionSafeguardRuntime(params.sessionManager, {
      contextWindowTokens,
      identifierPolicy: compactionCfg?.identifierPolicy,
      qualityGuardEnabled: qualityGuardCfg?.enabled ?? true,
      qualityGuardMaxRetries: qualityGuardCfg?.maxRetries,
      model: params.model,
      recentTurnsPreserve: compactionCfg?.recentTurnsPreserve,
      workspaceDir: params.workspaceDir,
      postCompactionSections: compactionCfg?.postCompactionSections,
      provider: compactionCfg?.provider,
    });
    factories.push(compactionSafeguardExtension);
  }
  const { agentId, sessionKey, runId, sessionManager } = params;
  // Snapshot the prepared session once; tool results must never rediscover
  // mutable session identity after a later turn has started.
  const sessionId = params.sessionId ?? sessionManager.getSessionId?.();
  const runner = createAgentToolResultMiddlewareRunner({
    runtime: "openclaw",
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
  });
  factories.push((agent) => {
    agent.on("tool_result", async (rawEvent: unknown, ctx) => {
      const event = (asOptionalRecord(rawEvent) ?? {}) as Partial<ToolResultEvent> & {
        threadId?: string;
        turnId?: string;
      };
      if (!event.toolName) {
        return undefined;
      }
      const eventToolCallId =
        typeof event.toolCallId === "string" && event.toolCallId.trim()
          ? event.toolCallId
          : undefined;
      const toolCallId = eventToolCallId ?? `openclaw-${randomUUID()}`;
      const current = {
        content: Array.isArray(event.content) ? event.content : [],
        details: event.details,
      } satisfies AgentToolResult<unknown>;
      if (eventToolCallId) {
        // Delivery evidence stays private so middleware may fully replace result details.
        recordEmbeddedToolReceipt(
          sessionManager,
          eventToolCallId,
          current.details,
          event.toolName === "message",
        );
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
        args: asOptionalRecord(adjustedInput ?? event.input) ?? {},
        cwd: ctx.cwd,
        isError: event.isError,
        result: current,
      });
      const isAcceptedSessionSpawn =
        event.toolName === "sessions_spawn" && normalizeAcceptedSessionSpawnResult(result) !== null;
      const hasError = event.isError === true || inputHadErrorStatus || isToolResultError(result);
      const isError = !isAcceptedSessionSpawn && hasError;
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
        ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
        ...(hasError ? { isError } : {}),
      };
    });
  });
  return factories;
}
