import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type {
  ContextEnginePromptCacheInfo,
  ContextEngineRuntimeContext,
  ContextEngineSessionTarget,
} from "../../../context-engine/types.js";
import { pruneMapToMaxSize } from "../../../infra/map-size.js";
import type { HookRunner } from "../../../plugins/hooks.js";
import { drainPluginNextTurnInjectionContext } from "../../../plugins/host-hook-state.js";
import { buildPluginAgentTurnPrepareContext } from "../../../plugins/host-hooks.js";
import { buildPromptBuildDropResult } from "../../../plugins/prompt-build-drop.js";
import type {
  PluginNextTurnInjectionRecord,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
} from "../../../plugins/types.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import {
  normalizeInputProvenance,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../../../sessions/input-provenance.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { truncateUtf16Safe } from "../../../utils.js";
import { listActiveProcessSessionReferences } from "../../bash-process-references.js";
import { resolveProcessToolScopeKey } from "../../bash-process-scope.js";
import { wrapPluginSystemContextSection } from "../../hook-system-context-boundary.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../tool-fs-policy.js";
import { deriveContextPromptTokens, type NormalizedUsage } from "../../usage.js";
import { buildEmbeddedCompactionRuntimeContext } from "../compaction-runtime-context.js";
import { resolveContextEngineCapabilities } from "../context-engine-capabilities.js";
import { log } from "../logger.js";
import { normalizeContextTokenBudget } from "../utils.js";
import type { DecisionPromptBuildFields } from "./attempt-decision-prefilter.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type ResolvedPromptBuildHookResult = PluginHookBeforePromptBuildResult & {
  decisionPromptBuildFields?: DecisionPromptBuildFields;
  hasPendingNonPromptBuildContext: boolean;
};

type PromptBuildHookRunner = Pick<HookRunner, "runBeforePromptBuild"> &
  Partial<Pick<HookRunner, "runAgentTurnPrepare" | "runHeartbeatPromptContribution">> & {
    hasHooks: (
      hookName: "agent_turn_prepare" | "heartbeat_prompt_contribution" | "before_prompt_build",
    ) => boolean;
  };

// Draining consumes durable injections. Retain them for retries of the same run.
const PROMPT_BUILD_DRAIN_CACHE_MAX = 256;
const promptBuildDrainCache = new Map<string, PluginNextTurnInjectionRecord[]>();

function rememberDrainedInjections(
  runId: string,
  injections: PluginNextTurnInjectionRecord[],
): void {
  if (promptBuildDrainCache.has(runId)) {
    promptBuildDrainCache.delete(runId);
  } else if (promptBuildDrainCache.size >= PROMPT_BUILD_DRAIN_CACHE_MAX) {
    pruneMapToMaxSize(promptBuildDrainCache, PROMPT_BUILD_DRAIN_CACHE_MAX - 1);
  }
  promptBuildDrainCache.set(runId, injections);
}

/** Release at run termination so active retries retain cache headroom. */
export function forgetPromptBuildDrainCacheForRun(runId: string | undefined): void {
  if (runId) {
    promptBuildDrainCache.delete(runId);
  }
}

export async function resolvePromptBuildHookResult(params: {
  config: OpenClawConfig;
  prompt: string;
  messages: unknown[];
  hookCtx: PluginHookAgentContext;
  hookRunner?: PromptBuildHookRunner | null;
}): Promise<ResolvedPromptBuildHookResult> {
  const runId = params.hookCtx.runId;
  const cachedInjections = runId ? promptBuildDrainCache.get(runId) : undefined;
  const queuedContext = cachedInjections
    ? {
        queuedInjections: cachedInjections,
        ...buildPluginAgentTurnPrepareContext({ queuedInjections: cachedInjections }),
      }
    : await drainPluginNextTurnInjectionContext({
        cfg: params.config,
        sessionKey: params.hookCtx.sessionKey,
        agentId: params.hookCtx.agentId,
      });
  if (runId && !cachedInjections) {
    rememberDrainedInjections(runId, queuedContext.queuedInjections);
  }
  // Hook ordering mirrors the prompt assembly boundary: queued injections first,
  // then prepare/heartbeat contributions, then prompt-build hooks.
  const logHookFailure = (hookName: string) => (hookErr: unknown) => {
    log.warn(`${hookName} hook failed: ${String(hookErr)}`);
    return undefined;
  };
  const turnPrepareResult =
    params.hookRunner?.runAgentTurnPrepare && params.hookRunner.hasHooks("agent_turn_prepare")
      ? await params.hookRunner
          .runAgentTurnPrepare(
            {
              prompt: params.prompt,
              messages: params.messages,
              queuedInjections: queuedContext.queuedInjections,
            },
            params.hookCtx,
          )
          .catch(logHookFailure("agent_turn_prepare"))
      : undefined;
  const heartbeatContribution =
    params.hookCtx.trigger === "heartbeat" &&
    params.hookRunner?.runHeartbeatPromptContribution &&
    params.hookRunner.hasHooks("heartbeat_prompt_contribution")
      ? await params.hookRunner
          .runHeartbeatPromptContribution(
            {
              sessionKey: params.hookCtx.sessionKey,
              agentId: params.hookCtx.agentId,
              heartbeatName: "heartbeat",
            },
            params.hookCtx,
          )
          .catch(logHookFailure("heartbeat_prompt_contribution"))
      : undefined;
  const promptBuildResult = params.hookRunner?.hasHooks("before_prompt_build")
    ? await params.hookRunner
        .runBeforePromptBuild(
          {
            prompt: params.prompt,
            messages: params.messages,
          },
          params.hookCtx,
        )
        .catch((hookErr: unknown) => {
          log.warn(`before_prompt_build hook failed: ${String(hookErr)}`);
          // The contribution is gone; say so in the prompt rather than handing
          // the agent a context that only looks complete (openclaw-beads-201).
          // The error stays in the warn above: the marker carries a bounded
          // reason code, never error-derived text.
          return buildPromptBuildDropResult([{ reason: "dispatch-failed" }]);
        })
    : undefined;
  const decisionPromptBuildFields = promptBuildResult
    ? Object.fromEntries(
        (
          [
            "systemPrompt",
            "prependContext",
            "appendContext",
            "prependSystemContext",
            "appendSystemContext",
          ] as const
        ).flatMap((field) =>
          typeof promptBuildResult[field] === "string"
            ? [[field, promptBuildResult[field]] as const]
            : [],
        ),
      )
    : undefined;
  const pendingContext = [queuedContext, turnPrepareResult, heartbeatContribution];
  const joinContext = (key: "prependContext" | "appendContext") =>
    joinPresentTextSegments([...pendingContext, promptBuildResult].map((source) => source?.[key]));
  return {
    hasPendingNonPromptBuildContext: pendingContext.some(
      (source) => source?.prependContext?.trim() || source?.appendContext?.trim(),
    ),
    ...(decisionPromptBuildFields && Object.keys(decisionPromptBuildFields).length > 0
      ? { decisionPromptBuildFields }
      : {}),
    systemPrompt: promptBuildResult?.systemPrompt,
    ...(promptBuildResult?.toolsAllow !== undefined
      ? { toolsAllow: promptBuildResult.toolsAllow }
      : {}),
    prependContext: joinContext("prependContext"),
    appendContext: joinContext("appendContext"),
    prependSystemContext: wrapPluginSystemContextSection(promptBuildResult?.prependSystemContext),
    appendSystemContext: wrapPluginSystemContextSection(promptBuildResult?.appendSystemContext),
  };
}

export function resolvePromptModeForSession(sessionKey?: string): "minimal" | "full" {
  return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) ? "minimal" : "full";
}

/** User-visible runs warn when transcript repair had to merge an orphaned user turn. */
export function shouldWarnOnOrphanedUserRepair(
  trigger: EmbeddedRunAttemptParams["trigger"],
): boolean {
  return trigger === "user" || trigger === "manual";
}

const QUEUED_USER_MESSAGE_MARKER =
  "[Earlier unanswered user message. Address this request alongside the current input; " +
  "follow the latest user instruction if they conflict.]";
const QUEUED_INTER_SESSION_MESSAGE_MARKER =
  "[Queued user message from a previous active turn; preserved as context only. " +
  "Continue with the active prompt below.]";
const MAX_STRUCTURED_MEDIA_REF_CHARS = 300;
const MAX_STRUCTURED_JSON_STRING_CHARS = 300;
const MAX_STRUCTURED_JSON_DEPTH = 4;
const MAX_STRUCTURED_JSON_ARRAY_ITEMS = 16;
const MAX_STRUCTURED_JSON_OBJECT_KEYS = 32;

function summarizeStructuredMediaRef(label: string, value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const dataUriMatch = trimmed.match(/^data:([^;,]+)?(?:;[^,]*)?,/i);
  if (dataUriMatch) {
    const mimeType = dataUriMatch[1]?.trim() || "unknown";
    return `[${label}] inline data URI (${mimeType}, ${trimmed.length} chars)`;
  }
  if (trimmed.length > MAX_STRUCTURED_MEDIA_REF_CHARS) {
    return `[${label}] ${truncateUtf16Safe(trimmed, MAX_STRUCTURED_MEDIA_REF_CHARS)}... (${trimmed.length} chars)`;
  }
  return `[${label}] ${trimmed}`;
}

function summarizeStructuredJsonString(value: string): string {
  const mediaSummary = summarizeStructuredMediaRef("value", value);
  if (mediaSummary?.includes("inline data URI")) {
    return mediaSummary;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_STRUCTURED_JSON_STRING_CHARS) {
    return `${truncateUtf16Safe(trimmed, MAX_STRUCTURED_JSON_STRING_CHARS)}... (${trimmed.length} chars)`;
  }
  return value;
}

function sanitizeStructuredJsonValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") {
    return summarizeStructuredJsonString(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  if (depth >= MAX_STRUCTURED_JSON_DEPTH) {
    return "[max depth]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const limited = value
      .slice(0, MAX_STRUCTURED_JSON_ARRAY_ITEMS)
      .map((item) => sanitizeStructuredJsonValue(item, depth + 1, seen));
    if (value.length > MAX_STRUCTURED_JSON_ARRAY_ITEMS) {
      limited.push(`[${value.length - MAX_STRUCTURED_JSON_ARRAY_ITEMS} more items]`);
    }
    seen.delete(value);
    return limited;
  }
  const output: Record<string, unknown> = {};
  let keyCount = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    keyCount += 1;
    if (keyCount <= MAX_STRUCTURED_JSON_OBJECT_KEYS) {
      output[key] = sanitizeStructuredJsonValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
        seen,
      );
    }
  }
  if (keyCount > MAX_STRUCTURED_JSON_OBJECT_KEYS) {
    output["__truncated"] = `${keyCount - MAX_STRUCTURED_JSON_OBJECT_KEYS} more keys`;
  }
  seen.delete(value);
  return output;
}

function stringifyStructuredJsonFallback(part: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(sanitizeStructuredJsonValue(part));
    if (!serialized || serialized === "{}") {
      return undefined;
    }
    const withoutInlineData = serialized.replace(
      /data:[^"'\\\s]+/gi,
      (match) => `[inline data URI: ${match.length} chars]`,
    );
    return withoutInlineData.length > 1_000
      ? `${truncateUtf16Safe(withoutInlineData, 1_000)}... (${withoutInlineData.length} chars)`
      : withoutInlineData;
  } catch {
    return undefined;
  }
}

function stringifyStructuredContentPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  const record = part as Record<string, unknown>;
  if (record.type === "text") {
    const text = typeof record.text === "string" ? record.text.trim() : "";
    return text || undefined;
  }
  if (record.type === "image_url") {
    const imageUrl = record.image_url;
    const url =
      typeof imageUrl === "string"
        ? imageUrl
        : imageUrl && typeof imageUrl === "object"
          ? (imageUrl as { url?: unknown }).url
          : undefined;
    return summarizeStructuredMediaRef("image_url", url);
  }
  if (record.type === "image" || record.type === "input_image") {
    return (
      summarizeStructuredMediaRef(record.type, record.url) ??
      summarizeStructuredMediaRef(record.type, record.source)
    );
  }
  if (typeof record.type === "string") {
    const typedRef =
      summarizeStructuredMediaRef(record.type, record.audio_url) ??
      summarizeStructuredMediaRef(record.type, record.media_url) ??
      summarizeStructuredMediaRef(record.type, record.url) ??
      summarizeStructuredMediaRef(record.type, record.source);
    if (typedRef) {
      return typedRef;
    }
  }
  return stringifyStructuredJsonFallback(part);
}

function extractUserMessagePromptText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((part) => {
      const textLocal = stringifyStructuredContentPart(part);
      return textLocal ? [textLocal] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function promptAlreadyIncludesQueuedUserMessage(prompt: string, orphanText: string): boolean {
  const normalizedPrompt = prompt.replace(/\r\n/g, "\n");
  const normalizedOrphanText = orphanText.replace(/\r\n/g, "\n").trim();
  return (
    normalizedOrphanText.length > 0 &&
    `\n${normalizedPrompt}\n`.includes(`\n${normalizedOrphanText}\n`)
  );
}

/**
 * Merges a trailing user message that was queued in transcript history but not
 * present in the active prompt.
 *
 * External user leaves are eligible to remain canonical (`removeLeaf: false`);
 * the session boundary owns whether the prompt replaces their transcript leaf.
 * Empty or stale internal leaves are always detached.
 */
export function mergeOrphanedTrailingUserPrompt(params: {
  prompt: string;
  leafMessage: { content?: unknown; provenance?: unknown };
}): { prompt: string; merged: boolean; removeLeaf: boolean } {
  const orphanText = extractUserMessagePromptText(params.leafMessage.content);
  if (!orphanText) {
    return { prompt: params.prompt, merged: false, removeLeaf: true };
  }
  if (
    params.prompt.trim().length > 0 &&
    shouldPreserveUserFacingSessionStateForInputProvenance(params.leafMessage.provenance)
  ) {
    return { prompt: params.prompt, merged: false, removeLeaf: true };
  }
  if (promptAlreadyIncludesQueuedUserMessage(params.prompt, orphanText)) {
    // Text is already in the active prompt; keep the leaf for later turns.
    return { prompt: params.prompt, merged: false, removeLeaf: false };
  }

  const provenance = normalizeInputProvenance(params.leafMessage.provenance);
  const marker =
    !provenance || provenance.kind === "external_user"
      ? QUEUED_USER_MESSAGE_MARKER
      : QUEUED_INTER_SESSION_MESSAGE_MARKER;
  return {
    prompt: [marker, orphanText, "", params.prompt].join("\n"),
    merged: true,
    removeLeaf: false,
  };
}

export function resolveAttemptFsWorkspaceOnly(params: {
  config?: OpenClawConfig;
  sessionAgentId: string;
}): boolean {
  return resolveEffectiveToolFsWorkspaceOnly({
    cfg: params.config,
    agentId: params.sessionAgentId,
  });
}

type AfterTurnRuntimeContextAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "sessionTarget"
  | "contextEngineAgentId"
  | "sessionKey"
  | "sandboxSessionKey"
  | "sandboxAgentId"
  | "messageChannel"
  | "messageProvider"
  | "agentAccountId"
  | "currentChannelId"
  | "currentThreadTs"
  | "currentMessageId"
  | "config"
  | "skillsSnapshot"
  | "toolsAllow"
  | "senderId"
  | "provider"
  | "modelId"
  | "agentHarnessId"
  | "modelSelectionLocked"
  | "thinkLevel"
  | "reasoningLevel"
  | "bashElevated"
  | "extraSystemPrompt"
  | "ownerNumbers"
  | "authProfileId"
  | "authProfileIdSource"
  | "runtimePlan"
  | "userTurnTranscriptRecorder"
> & {
  sessionId?: EmbeddedRunAttemptParams["sessionId"];
};

export function buildAfterTurnRuntimeContext(params: {
  attempt: AfterTurnRuntimeContextAttempt;
  workspaceDir: string;
  cwd?: string;
  agentDir: string;
  activeAgentId?: string;
  contextEnginePluginId?: string;
  tokenBudget?: number;
  currentTokenCount?: number;
  promptCache?: ContextEnginePromptCacheInfo;
}): ContextEngineRuntimeContext {
  const target = params.attempt.sessionTarget;
  const agentId = target?.agentId ?? params.activeAgentId;
  const sessionId = target?.sessionId ?? params.attempt.sessionId;
  const sessionKey = target?.sessionKey ?? params.attempt.sessionKey;
  const sessionTarget: ContextEngineSessionTarget | undefined =
    agentId || sessionId || sessionKey || target?.storePath || target?.threadId !== undefined
      ? {
          ...(agentId ? { agentId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(sessionKey ? { sessionKey } : {}),
          ...(target?.storePath ? { storePath: target.storePath } : {}),
          ...(target?.threadId !== undefined ? { threadId: target.threadId } : {}),
        }
      : undefined;
  const tokenBudget = normalizeContextTokenBudget(params.tokenBudget);
  const currentTokenCount = normalizeContextTokenBudget(params.currentTokenCount);
  return {
    ...buildEmbeddedCompactionRuntimeContext(
      {
        ...params.attempt,
        runtimeAuthPlan: params.attempt.runtimePlan?.auth,
        workspaceDir: params.workspaceDir,
        cwd: params.cwd,
        agentDir: params.agentDir,
        harnessRuntime: params.attempt.agentHarnessId,
        activeProcessSessions: listActiveProcessSessionReferences({
          scopeKey: resolveProcessToolScopeKey({
            sessionKey: params.attempt.sessionKey,
            sessionId: params.attempt.sessionId,
            agentId: params.activeAgentId,
          }),
        }),
      },
      "after-turn",
    ),
    ...resolveContextEngineCapabilities({
      config: params.attempt.config,
      sessionKey: params.attempt.sessionKey,
      explicitAgentId: params.attempt.contextEngineAgentId,
      authProfileId: params.attempt.authProfileId,
      contextEnginePluginId: params.contextEnginePluginId,
      purpose: "context-engine.after-turn",
    }),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(currentTokenCount !== undefined ? { currentTokenCount } : {}),
    ...(params.promptCache ? { promptCache: params.promptCache } : {}),
    transcriptStorage: { kind: "sqlite" },
    ...(sessionTarget ? { sessionTarget } : {}),
  };
}

export function buildAfterTurnRuntimeContextFromUsage(
  params: Omit<Parameters<typeof buildAfterTurnRuntimeContext>[0], "currentTokenCount"> & {
    lastCallUsage?: NormalizedUsage;
  },
): ContextEngineRuntimeContext {
  return buildAfterTurnRuntimeContext({
    ...params,
    currentTokenCount: deriveContextPromptTokens({ lastCallUsage: params.lastCallUsage }),
  });
}
