import { i as OpenClawConfig } from "./types.openclaw-GamulG8g.js";
import { n as ReasoningLevel, o as VerboseLevel, r as ThinkLevel, t as ElevatedLevel } from "./thinking.shared-DZFlsfdo.js";
import { m as ExecToolDefaults, o as SilentReplyPromptMode, t as CurrentInboundPromptContext } from "./params-DyZT9rDl.js";
import { Y as PromptImageOrderEntry, a as QueuedReplyDeliveryCorrelation, c as SourceReplyDeliveryMode, o as QueuedReplyLifecycle } from "./get-reply-options.types-BbifzHXd.js";
import { n as InboundEventKind, t as InputProvenance } from "./input-provenance-DgsxhTbk.js";
import { n as SkillSnapshot } from "./skills-BRkHvK1T.js";
import { n as AutoFallbackPrimaryProbe } from "./agent-scope-B-tPvwjF.js";
import { r as OriginatingChannelType } from "./templating-C1EVuBnx.js";
//#region src/auto-reply/reply/queue/types.d.ts
type QueueMode = "steer" | "followup" | "collect" | "interrupt";
type QueueDropPolicy = "old" | "new" | "summarize";
type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};
type FollowupRun = {
  prompt: string; /** User-visible prompt body persisted to transcript; excludes runtime-only prompt context. */
  transcriptPrompt?: string;
  currentInboundEventKind?: InboundEventKind; /** Explicit current-turn context that should be visible for this run but not persisted as user text. */
  currentInboundContext?: CurrentInboundPromptContext; /** Abort signal for turns that are canceled by their source-channel admission fence. */
  abortSignal?: AbortSignal;
  deliveryCorrelations?: QueuedReplyDeliveryCorrelation[];
  queuedLifecycle?: QueuedReplyLifecycle; /** Provider message ID, when available (for deduplication). */
  messageId?: string;
  summaryLine?: string;
  enqueuedAt: number;
  images?: Array<{
    type: "image";
    data: string;
    mimeType: string;
  }>;
  imageOrder?: PromptImageOrderEntry[];
  /**
   * Originating channel for reply routing.
   * When set, replies should be routed back to this provider
   * instead of using the session's lastChannel.
   */
  originatingChannel?: OriginatingChannelType;
  /**
   * Originating destination for reply routing.
   * The chat/channel/user ID where the reply should be sent.
   */
  originatingTo?: string; /** Provider account id (multi-account). */
  originatingAccountId?: string; /** Thread id for reply routing (Telegram topic id or Matrix thread event id). */
  originatingThreadId?: string | number; /** Chat type for context-aware threading (e.g., DM vs channel). */
  originatingChatType?: string;
  run: {
    agentId: string;
    agentDir: string;
    sessionId: string;
    sessionKey?: string;
    runtimePolicySessionKey?: string;
    messageProvider?: string;
    agentAccountId?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
    senderIsOwner?: boolean;
    traceAuthorized?: boolean;
    sessionFile: string;
    workspaceDir: string;
    config: OpenClawConfig;
    skillsSnapshot?: SkillSnapshot;
    provider: string;
    model: string;
    hasOneTurnModelOverride?: boolean;
    hasSessionModelOverride?: boolean;
    modelOverrideSource?: "auto" | "user";
    hasAutoFallbackProvenance?: boolean;
    imageModelFallbacksOverride?: string[];
    autoFallbackPrimaryProbe?: AutoFallbackPrimaryProbe;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    thinkLevel?: ThinkLevel;
    verboseLevel?: VerboseLevel;
    reasoningLevel?: ReasoningLevel;
    elevatedLevel?: ElevatedLevel;
    execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
    bashElevated?: {
      enabled: boolean;
      allowed: boolean;
      defaultLevel: ElevatedLevel;
    };
    timeoutMs: number;
    blockReplyBreak: "text_end" | "message_end";
    ownerNumbers?: string[];
    inputProvenance?: InputProvenance;
    extraSystemPrompt?: string;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    silentReplyPromptMode?: SilentReplyPromptMode;
    extraSystemPromptStatic?: string;
    enforceFinalTag?: boolean;
    skipProviderRuntimeHints?: boolean;
    silentExpected?: boolean;
    allowEmptyAssistantReplyAsSilent?: boolean;
    suppressNextUserMessagePersistence?: boolean;
    suppressTranscriptOnlyAssistantPersistence?: boolean;
    drainsContinuationDelegateQueue?: boolean;
    traceparent?: string;
  };
};
//#endregion
export { QueueSettings as i, QueueDropPolicy as n, QueueMode as r, FollowupRun as t };