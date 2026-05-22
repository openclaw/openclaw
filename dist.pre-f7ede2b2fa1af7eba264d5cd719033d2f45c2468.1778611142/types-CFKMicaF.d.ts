import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";
import { n as ReasoningLevel, o as VerboseLevel, r as ThinkLevel, t as ElevatedLevel } from "./thinking.shared-n4jFAre1.js";
import { m as ExecToolDefaults, o as SilentReplyPromptMode, t as CurrentTurnPromptContext } from "./params-DUjSTOLX.js";
import { l as PromptImageOrderEntry, o as SourceReplyDeliveryMode } from "./get-reply-options.types-xkFn9Z_M.js";
import { t as InputProvenance } from "./input-provenance-Bq6kK3ye.js";
import { n as SkillSnapshot } from "./skills-D7Hm_45J.js";
import { r as OriginatingChannelType } from "./templating-BkJN6_hx.js";
//#region src/auto-reply/reply/queue/types.d.ts
type QueueMode = "steer" | "followup" | "collect" | "steer-backlog" | "interrupt" | "queue";
type QueueDropPolicy = "old" | "new" | "summarize";
type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};
type FollowupRun = {
  prompt: string; /** User-visible prompt body persisted to transcript; excludes runtime-only prompt context. */
  transcriptPrompt?: string; /** Explicit current-turn context that should be visible for this run but not persisted as user text. */
  currentTurnContext?: CurrentTurnPromptContext; /** Provider message ID, when available (for deduplication). */
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
    hasSessionModelOverride?: boolean;
    modelOverrideSource?: "auto" | "user";
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
    drainsContinuationDelegateQueue?: boolean;
    traceparent?: string;
  };
};
//#endregion
export { QueueSettings as i, QueueDropPolicy as n, QueueMode as r, FollowupRun as t };