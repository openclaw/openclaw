import {
  resolveApprovalOverGateway,
  type ApprovalResolveResult,
} from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelMessageReplyPipeline,
  deliverStructuredInboundReplyWithMessageSendContext,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  readChannelAllowFromStore,
  recordInboundSession,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { buildPreparedModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import {
  getSessionEntry,
  readSessionUpdatedAtAsync,
  readAmbientTranscriptWatermark,
  resolveAmbientTranscriptWatermarkKey,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { prepareSkillCommandsForAgents } from "openclaw/plugin-sdk/skill-commands-runtime";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { syncTelegramMenuCommands } from "./bot-native-command-menu.js";
import {
  deliverReplies,
  deliverStructuredReplies,
  emitTelegramMessageSentHooks,
} from "./bot/delivery.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { editMessageTelegram } from "./send.js";
import { wasSentByBot } from "./sent-message-cache.js";

type ResolveTelegramApprovalParams = {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalReplyDecision;
  channel: "telegram";
  senderId?: string | null;
  gatewayUrl?: string;
} & (
  | { approvalKind: ChannelApprovalKind; resolveMethod?: never }
  | { approvalKind?: never; resolveMethod: ChannelApprovalKind }
);

type ResolveTelegramApproval = (
  params: ResolveTelegramApprovalParams,
) => Promise<ApprovalResolveResult | void>;

type RequiredTelegramBotDeps = Pick<
  typeof telegramBotImplementations,
  | "getRuntimeConfig"
  | "resolveStorePath"
  | "readChannelAllowFromStore"
  | "upsertChannelPairingRequest"
  | "enqueueRoutedSystemEvent"
  | "dispatchReplyWithBufferedBlockDispatcher"
  | "buildModelsProviderData"
  | "prepareSkillCommandsForAgents"
>;

export type TelegramBotDeps = RequiredTelegramBotDeps &
  Partial<
    Omit<typeof telegramBotImplementations, keyof RequiredTelegramBotDeps | "wasSentByBot">
  > & {
    wasSentByBot: (...args: Parameters<typeof wasSentByBot>) => boolean | Promise<boolean>;
  };

const telegramBotImplementations = {
  getRuntimeConfig,
  resolveStorePath,
  getSessionEntry,
  readChannelAllowFromStore,
  readSessionUpdatedAtAsync,
  readAmbientTranscriptWatermark,
  resolveAmbientTranscriptWatermarkKey,
  recordInboundSession,
  recordChannelActivity,
  resolveInboundLastRouteSessionKey,
  resolvePinnedMainDmOwnerFromAllowlist,
  buildChannelInboundEventContext,
  upsertChannelPairingRequest,
  enqueueRoutedSystemEvent,
  dispatchReplyWithBufferedBlockDispatcher,
  loadWebMedia,
  buildModelsProviderData: buildPreparedModelsProviderData,
  prepareSkillCommandsForAgents,
  syncTelegramMenuCommands,
  wasSentByBot,
  resolveApproval: resolveApprovalOverGateway as ResolveTelegramApproval,
  createTelegramDraftStream,
  deliverReplies,
  deliverStructuredReplies,
  deliverStructuredInboundReplyWithMessageSendContext,
  emitTelegramMessageSentHooks,
  editMessageTelegram,
  recordOutboundMessageForPromptContext,
  createChannelMessageReplyPipeline,
};

export const defaultTelegramBotDeps: TelegramBotDeps = telegramBotImplementations;
