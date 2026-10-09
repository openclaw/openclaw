import type { Bot, Context } from "grammy";
import type {
  ChannelGroupPolicy,
  OpenClawConfig,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.types.js";
import type {
  TelegramMessageProcessingResult,
  TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";
import type { TelegramBotOptions } from "./bot.types.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramTransport } from "./fetch.js";
import type { TelegramThreadSpec } from "./thread-spec.js";

export type TelegramPendingInboundTarget = {
  chatId: number;
  threadSpec: TelegramThreadSpec;
  senderId: string;
};

type TelegramMessageProcessorTurnContext = {
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  onDispatchStart?: () => Promise<void> | void;
  /** The turn holds its FIFO slot in the session lane while it waits for adoption. */
  onTurnDeferred?: () => void;
  /** The turn waits behind earlier spool rows; its buffer may release the sender key. */
  onTurnAdmissionWait?: () => void;
  spooledReplayAbortSignal?: AbortSignal;
  spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
  finalizeSpooledReplayResult?: (
    result: TelegramMessageProcessingResult,
    phase: "adopted" | "terminal",
  ) => Promise<TelegramMessageProcessingResult>;
  completeSpooledReplayAfterIrrevocableAdoption?: (
    error: unknown,
  ) => Promise<TelegramMessageProcessingResult> | TelegramMessageProcessingResult;
};

type ProcessTelegramMessageOptions = Pick<
  BuildTelegramMessageContextParams,
  "allMedia" | "storeAllowFrom" | "options" | "replyMedia" | "replyChain" | "promptContext"
> & {
  ctx: TelegramContext;
  turnContext: TelegramMessageProcessorTurnContext;
};

type ProcessTelegramMessage = (
  options: ProcessTelegramMessageOptions,
) => Promise<TelegramMessageProcessingResult>;

export type TelegramResolvedGroupConfig = ReturnType<
  BuildTelegramMessageContextParams["resolveTelegramGroupConfig"]
>;

export type TelegramNativeCommandCallbackDispatcher = (params: {
  botUser: Context["me"];
  callbackQuery: NonNullable<Context["callbackQuery"]>;
  commandText: string;
}) => Promise<{ handled: boolean; clearButtons: boolean }>;

type TelegramHandlerLogger = {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
};

export type RegisterTelegramHandlerParams = {
  nativeCommandNames?: ReadonlyMap<string, string>;
  cfg: OpenClawConfig;
  accountId: string;
  ownerAgentId: string;
  bot: Bot;
  mediaMaxBytes: number;
  opts: TelegramBotOptions;
  telegramTransport?: TelegramTransport;
  runtime: RuntimeEnv;
  telegramCfg: TelegramAccountConfig;
  telegramDeps: TelegramBotDeps;
  resolveGroupPolicy: (chatId: string | number, cfg: OpenClawConfig) => ChannelGroupPolicy;
  resolveGroupActivation: BuildTelegramMessageContextParams["resolveGroupActivation"];
  resolveGroupRequireMention: BuildTelegramMessageContextParams["resolveGroupRequireMention"];
  resolveTelegramGroupConfig: BuildTelegramMessageContextParams["resolveTelegramGroupConfig"];
  shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
  processMessage: ProcessTelegramMessage;
  logger: TelegramHandlerLogger;
  nativeCommandCallbackDispatcher?: TelegramNativeCommandCallbackDispatcher;
};

export type TelegramInboundDisposition =
  | { kind: "ignored" }
  | { kind: "recorded" }
  | { kind: "buffered"; buffer: "media-group" | "debounce" }
  | { kind: "processed" };

export interface TelegramInboundPipeline {
  handle: (ctx: Context) => Promise<TelegramInboundDisposition>;
}
