import type { Bot } from "grammy";
import type { HistoryEntry } from "../../../src/auto-reply/reply/history.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type {
  DmPolicy,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../../../src/config/types.js";
import type { StickerMetadata, TelegramContext } from "./bot/types.js";

export type TelegramMediaRef = {
  path: string;
  contentType?: string;
  stickerMetadata?: StickerMetadata;
};

export type TelegramMessageContextOptions = {
  forceWasMentioned?: boolean;
  messageIdOverride?: string;
};

export type TelegramLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
};

export type ResolveTelegramGroupConfig = (
  chatId: string | number,
  messageThreadId?: number,
) => {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
};

export type ResolveGroupActivation = (params: {
  chatId: string | number;
  agentId?: string;
  messageThreadId?: number;
  sessionKey?: string;
}) => boolean | undefined;

export type ResolveGroupRequireMention = (chatId: string | number) => boolean;

export type BuildTelegramMessageContextParams = {
  primaryCtx: TelegramContext;
  allMedia: TelegramMediaRef[];
  replyMedia?: TelegramMediaRef[];
  storeAllowFrom: string[];
  options?: TelegramMessageContextOptions;
  bot: Bot;
  cfg: OpenClawConfig;
  account: { accountId: string };
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  dmPolicy: DmPolicy;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  ackReactionScope: "off" | "none" | "group-mentions" | "group-all" | "direct" | "all";
  logger: TelegramLogger;
  resolveGroupActivation: ResolveGroupActivation;
  resolveGroupRequireMention: ResolveGroupRequireMention;
  resolveTelegramGroupConfig: ResolveTelegramGroupConfig;
  /** Global (per-account) handler for sendChatAction 401 backoff (#27092). */
  sendChatActionHandler: import("./sendchataction-401-backoff.js").TelegramSendChatActionHandler;
};
