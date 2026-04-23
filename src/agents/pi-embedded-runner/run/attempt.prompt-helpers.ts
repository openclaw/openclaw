import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type {
  ContextEnginePromptCacheInfo,
  ContextEngineRuntimeContext,
} from "../../../context-engine/types.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
} from "../../../plugins/types.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../../heartbeat-system-prompt.js";
import { buildActiveMusicGenerationTaskPromptContextForSession } from "../../music-generation-task-status.js";
import { prependSystemPromptAdditionAfterCacheBoundary } from "../../system-prompt-cache-boundary.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../tool-fs-policy.js";
import { derivePromptTokens, type NormalizedUsage } from "../../usage.js";
import { buildActiveVideoGenerationTaskPromptContextForSession } from "../../video-generation-task-status.js";
import { buildEmbeddedCompactionRuntimeContext } from "../compaction-runtime-context.js";
import { log } from "../logger.js";
import { shouldInjectHeartbeatPromptForTrigger } from "./trigger-policy.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type PromptBuildHookRunner = {
  hasHooks: (hookName: "before_prompt_build" | "before_agent_start") => boolean;
  runBeforePromptBuild: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforePromptBuildResult | undefined>;
  runBeforeAgentStart: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforeAgentStartResult | undefined>;
};

export async function resolvePromptBuildHookResult(params: {
  prompt: string;
  messages: unknown[];
  hookCtx: PluginHookAgentContext;
  hookRunner?: PromptBuildHookRunner | null;
  legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
}): Promise<PluginHookBeforePromptBuildResult> {
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
          return undefined;
        })
    : undefined;
  const legacyResult =
    params.legacyBeforeAgentStartResult ??
    (params.hookRunner?.hasHooks("before_agent_start")
      ? await params.hookRunner
          .runBeforeAgentStart(
            {
              prompt: params.prompt,
              messages: params.messages,
            },
            params.hookCtx,
          )
          .catch((hookErr: unknown) => {
            log.warn(
              `before_agent_start hook (legacy prompt build path) failed: ${String(hookErr)}`,
            );
            return undefined;
          })
      : undefined);
  return {
    systemPrompt: promptBuildResult?.systemPrompt ?? legacyResult?.systemPrompt,
    prependContext: joinPresentTextSegments([
      promptBuildResult?.prependContext,
      legacyResult?.prependContext,
    ]),
    prependSystemContext: joinPresentTextSegments([
      promptBuildResult?.prependSystemContext,
      legacyResult?.prependSystemContext,
    ]),
    appendSystemContext: joinPresentTextSegments([
      promptBuildResult?.appendSystemContext,
      legacyResult?.appendSystemContext,
    ]),
  };
}

export function resolvePromptModeForSession(sessionKey?: string): "minimal" | "full" {
  if (!sessionKey) {
    return "full";
  }
  return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) ? "minimal" : "full";
}

export function shouldInjectHeartbeatPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  defaultAgentId?: string;
  isDefaultAgent: boolean;
  trigger?: EmbeddedRunAttemptParams["trigger"];
}): boolean {
  return (
    params.isDefaultAgent &&
    shouldInjectHeartbeatPromptForTrigger(params.trigger) &&
    Boolean(
      resolveHeartbeatPromptForSystemPrompt({
        config: params.config,
        agentId: params.agentId,
        defaultAgentId: params.defaultAgentId,
      }),
    )
  );
}

export function shouldWarnOnOrphanedUserRepair(
  trigger: EmbeddedRunAttemptParams["trigger"],
): boolean {
  return trigger === "user" || trigger === "manual";
}

const MAX_STRUCTURED_MEDIA_REF_CHARS = 300;

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
    return `[${label}] ${trimmed.slice(0, MAX_STRUCTURED_MEDIA_REF_CHARS)}... (${trimmed.length} chars)`;
  }
  return `[${label}] ${trimmed}`;
}

function stringifyStructuredJsonFallback(part: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(part);
    if (!serialized || serialized === "{}") {
      return undefined;
    }
    const withoutInlineData = serialized.replace(
      /data:[^"'\\\s]+/gi,
      (match) => `[inline data URI: ${match.length} chars]`,
    );
    return withoutInlineData.length > 1_000
      ? `${withoutInlineData.slice(0, 1_000)}... (${withoutInlineData.length} chars)`
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
      const text = stringifyStructuredContentPart(part);
      return text ? [text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

export function mergeOrphanedTrailingUserPrompt(params: {
  prompt: string;
  trigger: EmbeddedRunAttemptParams["trigger"];
  leafMessage: { content?: unknown };
}): { prompt: string; merged: boolean; removeLeaf: boolean } {
  const orphanText = extractUserMessagePromptText(params.leafMessage.content);
  if (!orphanText) {
    return { prompt: params.prompt, merged: false, removeLeaf: true };
  }
  if (params.prompt.includes(orphanText)) {
    return { prompt: params.prompt, merged: false, removeLeaf: true };
  }

  return {
    prompt: [
      "[Queued user message that arrived while the previous turn was still active]",
      orphanText,
      "",
      params.prompt,
    ].join("\n"),
    merged: true,
    removeLeaf: true,
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

export function prependSystemPromptAddition(params: {
  systemPrompt: string;
  systemPromptAddition?: string;
}): string {
  return prependSystemPromptAdditionAfterCacheBoundary(params);
}

export function resolveAttemptPrependSystemContext(params: {
  sessionKey?: string;
  trigger?: EmbeddedRunAttemptParams["trigger"];
  hookPrependSystemContext?: string;
}): string | undefined {
  const activeMediaTaskPromptContexts =
    params.trigger === "user" || params.trigger === "manual"
      ? [
          buildActiveVideoGenerationTaskPromptContextForSession(params.sessionKey),
          buildActiveMusicGenerationTaskPromptContextForSession(params.sessionKey),
        ]
      : [];
  return joinPresentTextSegments([
    ...activeMediaTaskPromptContexts,
    params.hookPrependSystemContext,
  ]);
}

/** Build runtime context passed into context-engine afterTurn hooks. */
export function buildAfterTurnRuntimeContext(params: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "sessionKey"
    | "messageChannel"
    | "messageProvider"
    | "agentAccountId"
    | "currentChannelId"
    | "currentThreadTs"
    | "currentMessageId"
    | "config"
    | "skillsSnapshot"
    | "senderIsOwner"
    | "senderId"
    | "provider"
    | "modelId"
    | "thinkLevel"
    | "reasoningLevel"
    | "bashElevated"
    | "extraSystemPrompt"
    | "ownerNumbers"
    | "authProfileId"
  >;
  workspaceDir: string;
  agentDir: string;
  tokenBudget?: number;
  currentTokenCount?: number;
  promptCache?: ContextEnginePromptCacheInfo;
}): ContextEngineRuntimeContext {
  return {
    ...buildEmbeddedCompactionRuntimeContext({
      sessionKey: params.attempt.sessionKey,
      messageChannel: params.attempt.messageChannel,
      messageProvider: params.attempt.messageProvider,
      agentAccountId: params.attempt.agentAccountId,
      currentChannelId: params.attempt.currentChannelId,
      currentThreadTs: params.attempt.currentThreadTs,
      currentMessageId: params.attempt.currentMessageId,
      authProfileId: params.attempt.authProfileId,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.attempt.config,
      skillsSnapshot: params.attempt.skillsSnapshot,
      senderIsOwner: params.attempt.senderIsOwner,
      senderId: params.attempt.senderId,
      provider: params.attempt.provider,
      modelId: params.attempt.modelId,
      thinkLevel: params.attempt.thinkLevel,
      reasoningLevel: params.attempt.reasoningLevel,
      bashElevated: params.attempt.bashElevated,
      extraSystemPrompt: params.attempt.extraSystemPrompt,
      ownerNumbers: params.attempt.ownerNumbers,
    }),
    ...(typeof params.tokenBudget === "number" &&
    Number.isFinite(params.tokenBudget) &&
    params.tokenBudget > 0
      ? { tokenBudget: Math.floor(params.tokenBudget) }
      : {}),
    ...(typeof params.currentTokenCount === "number" &&
    Number.isFinite(params.currentTokenCount) &&
    params.currentTokenCount > 0
      ? { currentTokenCount: Math.floor(params.currentTokenCount) }
      : {}),
    ...(params.promptCache ? { promptCache: params.promptCache } : {}),
  };
}

export function buildAfterTurnRuntimeContextFromUsage(
  params: Omit<Parameters<typeof buildAfterTurnRuntimeContext>[0], "currentTokenCount"> & {
    lastCallUsage?: NormalizedUsage;
  },
): ContextEngineRuntimeContext {
  return buildAfterTurnRuntimeContext({
    ...params,
    currentTokenCount: derivePromptTokens(params.lastCallUsage),
  });
}
