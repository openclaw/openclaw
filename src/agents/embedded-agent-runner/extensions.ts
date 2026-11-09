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
import { createAgentToolResultMiddlewareApplier } from "../harness/tool-result-middleware.js";
import type { AgentToolResult } from "../runtime/index.js";
import type { ToolResultEvent } from "../sessions/extensions/types.js";
import type { ExtensionFactory, SessionManager } from "../sessions/index.js";
import { reconcileSkillInstructionDelivery } from "../skill-instruction-result.js";
import { isToolResultError } from "../tool-result-error.js";
import { recordEmbeddedToolReceipt } from "./tool-send-receipts.js";

/** Concatenates the text the model will receive after middleware has run. */
function deliveredTextOf(result: AgentToolResult<unknown>): string {
  return result.content
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  workspaceDir: string;
  model: ProviderRuntimeModel | undefined;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  if (resolveEffectiveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const qualityGuardCfg = compactionCfg?.qualityGuard;
    setCompactionSafeguardRuntime(params.sessionManager, {
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
  const applyToolResultMiddleware = createAgentToolResultMiddlewareApplier({
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
      const current: AgentToolResult<unknown> = {
        content: Array.isArray(event.content) ? event.content : [],
        details: event.details,
      };
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
      const update = await applyToolResultMiddleware({
        threadId: event.threadId,
        turnId: event.turnId,
        toolCallId,
        toolName: event.toolName,
        args:
          asOptionalRecord(adjustedInput == null ? event.input : structuredClone(adjustedInput)) ??
          {},
        cwd: ctx.cwd,
        isError: event.isError,
        result: current,
      });
      const result = update ?? current;
      if (eventToolCallId) {
        // A reducer may have shortened a skill read after the tool served it whole;
        // drop the whole-read cache entry so an explicit re-read serves the document.
        reconcileSkillInstructionDelivery({
          runId,
          toolCallId: eventToolCallId,
          deliveredText: deliveredTextOf(result),
        });
      }
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
      // No middleware ran, so classification alone must not rewrite the tool's outcome.
      if (update === undefined && isError === event.isError) {
        return undefined;
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
