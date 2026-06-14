// Telegram type declarations define plugin contracts.
import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  DmPolicy,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { StickerMetadata, TelegramContext } from "./bot/types.js";
import type { TelegramReplyChainEntry } from "./message-cache.js";

export type TelegramMediaRef = {
  path: string;
  contentType?: string;
  stickerMetadata?: StickerMetadata;
};

export type TelegramMessageContextOptions = {
  commandSource?: "text" | "native";
  forceWasMentioned?: boolean;
  messageIdOverride?: string;
  receivedAtMs?: number;
  ingressBuffer?: "inbound-debounce" | "text-fragment";
  promptContextMinTimestampMs?: number;
  spooledReplay?: boolean;
  /**
   * Pin-from-here mirror turn: a synthetic inbound re-homing an already-authorized
   * session's turn onto this chat. The SENDER allowFrom gate is skipped (the pin was
   * the authorization, and the inbound is synthetic), but the DESTINATION-enablement
   * gates (group/topic disabled, requireTopic) are STILL enforced so a pin stops
   * delivering once the destination is later disabled or restricted (revocation).
   * Everything else builds normally so the mirror renders + persists like a native turn.
   */
  mirror?: boolean;
  /**
   * Called (mirror turns only) when admission is denied by a destination-enablement
   * gate, i.e. the pin has been revoked. Lets the caller distinguish an intentional
   * revocation drop (keep the target suppressed) from an unexpected null context.
   */
  onMirrorAdmissionBlocked?: () => void;
};

export type TelegramPromptContextEntry = NonNullable<
  MsgContext["UntrustedStructuredContext"]
>[number];

export type TelegramLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
};

type ResolveTelegramGroupConfig = (
  chatId: string | number,
  messageThreadId?: number,
) => {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
};

type ResolveGroupActivation = (params: {
  chatId: string | number;
  agentId?: string;
  messageThreadId?: number;
  sessionKey?: string;
}) => boolean | undefined;

type ResolveGroupRequireMention = (chatId: string | number) => boolean;

type TelegramMessageContextRuntimeOverrides = Partial<
  Pick<
    typeof import("./bot-message-context.runtime.js"),
    | "createStatusReactionController"
    | "ensureConfiguredBindingRouteReady"
    | "getRuntimeConfig"
    | "recordChannelActivity"
  >
>;

export type TelegramMessageContextSessionRuntimeOverrides = Partial<
  Pick<
    typeof import("./bot-message-context.session.runtime.js"),
    | "buildChannelInboundEventContext"
    | "readSessionUpdatedAt"
    | "recordInboundSession"
    | "resolveInboundLastRouteSessionKey"
    | "resolvePinnedMainDmOwnerFromAllowlist"
    | "resolveStorePath"
  >
>;

export type BuildTelegramMessageContextParams = {
  primaryCtx: TelegramContext;
  allMedia: TelegramMediaRef[];
  replyMedia?: TelegramMediaRef[];
  replyChain?: TelegramReplyChainEntry[];
  promptContext?: TelegramPromptContextEntry[];
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
  loadFreshConfig?: () => OpenClawConfig;
  runtime?: TelegramMessageContextRuntimeOverrides;
  sessionRuntime?: TelegramMessageContextSessionRuntimeOverrides;
  upsertPairingRequest?: typeof import("openclaw/plugin-sdk/conversation-runtime").upsertChannelPairingRequest;
  /** Global (per-account) handler for sendChatAction 401 backoff (#27092). */
  sendChatActionHandler: import("./sendchataction-401-backoff.js").TelegramSendChatActionHandler;
};
