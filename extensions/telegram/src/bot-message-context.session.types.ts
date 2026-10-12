import type {
  OpenClawConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { NormalizedAllowFrom } from "./bot-access.js";
import type { resolveTelegramInboundBody } from "./bot-message-context.body.js";
import type {
  TelegramMediaRef,
  TelegramMessageContextOptions,
  TelegramMessageContextSessionRuntimeOverrides,
  TelegramPromptContextEntry,
} from "./bot-message-context.types.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramReplyChainEntry } from "./message-cache-codec.js";

export type BuildTelegramInboundContextPayloadParams = {
  conversationAvatar?: string;
  cfg: OpenClawConfig;
  primaryCtx: TelegramContext;
  msg: TelegramContext["message"];
  allMedia: TelegramMediaRef[];
  replyMedia: TelegramMediaRef[];
  replyChain: TelegramReplyChainEntry[];
  promptContext: TelegramPromptContextEntry[];
  isGroup: boolean;
  isForum: boolean;
  chatId: number | string;
  senderId: string;
  senderUsername: string;
  resolvedThreadId?: number;
  dmThreadId?: number;
  threadSpec: TelegramThreadSpec;
  route: ResolvedAgentRoute;
  bodyResult: NonNullable<Awaited<ReturnType<typeof resolveTelegramInboundBody>>>;
  historyLimit: number;
  dmHistoryLimit: number;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  groupRequireMention: boolean;
  options?: TelegramMessageContextOptions;
  dmAllowFrom?: Array<string | number>;
  effectiveGroupAllow?: NormalizedAllowFrom;
  topicName?: string;
  sessionRuntime?: TelegramMessageContextSessionRuntimeOverrides;
};
