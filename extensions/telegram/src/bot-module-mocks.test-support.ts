/** Types for test controls at the real Telegram/SDK module boundaries. */
export type TelegramBotFixtureMocks = {
  getRuntimeConfig: typeof import("openclaw/plugin-sdk/runtime-config-snapshot").readRuntimeConfig;
  resolveStorePath: typeof import("openclaw/plugin-sdk/session-store-runtime").resolveStorePath;
  getSessionEntryAsync: typeof import("openclaw/plugin-sdk/session-store-runtime").getSessionEntryAsync;
  readChannelAllowFromStore: typeof import("openclaw/plugin-sdk/conversation-runtime").readChannelAllowFromStore;
  readSessionUpdatedAtAsync: typeof import("openclaw/plugin-sdk/session-store-runtime").readSessionUpdatedAtAsync;
  readAmbientTranscriptWatermarkAsync: typeof import("openclaw/plugin-sdk/session-store-runtime").readAmbientTranscriptWatermarkAsync;
  resolveAmbientTranscriptWatermarkKey: typeof import("openclaw/plugin-sdk/session-store-runtime").resolveAmbientTranscriptWatermarkKey;
  recordInboundSession: typeof import("openclaw/plugin-sdk/conversation-runtime").recordInboundSession;
  recordChannelActivity: typeof import("openclaw/plugin-sdk/channel-activity-runtime").recordChannelActivity;
  resolveInboundLastRouteSessionKey: typeof import("openclaw/plugin-sdk/routing").resolveInboundLastRouteSessionKey;
  resolvePinnedMainDmOwnerFromAllowlist: typeof import("openclaw/plugin-sdk/security-runtime").resolvePinnedMainDmOwnerFromAllowlist;
  buildChannelInboundEventContext: typeof import("openclaw/plugin-sdk/channel-inbound").buildChannelInboundEventContext;
  upsertChannelPairingRequest: typeof import("openclaw/plugin-sdk/conversation-runtime").upsertChannelPairingRequest;
  enqueueRoutedSystemEvent: typeof import("openclaw/plugin-sdk/system-event-runtime").enqueueRoutedSystemEvent;
  dispatchReplyWithBufferedBlockDispatcher: typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
  loadWebMedia: typeof import("openclaw/plugin-sdk/web-media").loadWebMedia;
  buildModelsProviderData: typeof import("openclaw/plugin-sdk/models-provider-runtime").buildPreparedModelsProviderData;
  prepareSkillCommandsForAgents: typeof import("openclaw/plugin-sdk/skill-commands-runtime").prepareSkillCommandsForAgents;
  syncTelegramMenuCommands: typeof import("./bot-native-command-menu.js").syncTelegramMenuCommands;
  wasSentByBot: (
    ...args: Parameters<typeof import("./sent-message-cache.js").wasSentByBot>
  ) => boolean | Promise<boolean>;
  resolveApproval: (
    params: {
      cfg: import("openclaw/plugin-sdk/config-contracts").OpenClawConfig;
      approvalId: string;
      decision: import("openclaw/plugin-sdk/approval-reply-runtime").ExecApprovalReplyDecision;
      channel: "telegram";
      accountId?: string | null;
      senderId?: string | null;
      gatewayUrl?: string;
    } & (
      | {
          approvalKind: import("openclaw/plugin-sdk/approval-handler-runtime").ChannelApprovalKind;
          resolveMethod?: never;
        }
      | {
          approvalKind?: never;
          resolveMethod: import("openclaw/plugin-sdk/approval-handler-runtime").ChannelApprovalKind;
        }
    ),
  ) => Promise<import("openclaw/plugin-sdk/approval-gateway-runtime").ApprovalResolveResult | void>;
  createTelegramDraftStream: typeof import("./draft-stream.js").createTelegramDraftStream;
  deliverReplies: typeof import("./bot/delivery.js").deliverReplies;
  deliverStructuredReplies: typeof import("./bot/delivery.js").deliverStructuredReplies;
  deliverStructuredInboundReplyWithMessageSendContext: typeof import("openclaw/plugin-sdk/channel-outbound").deliverStructuredInboundReplyWithMessageSendContext;
  emitTelegramMessageSentHooks: typeof import("./bot/delivery.js").emitTelegramMessageSentHooks;
  editMessageTelegram: typeof import("./send.js").editMessageTelegram;
  recordOutboundMessageForPromptContext: typeof import("./outbound-message-context.js").recordOutboundMessageForPromptContext;
  createChannelMessageReplyPipeline: typeof import("openclaw/plugin-sdk/channel-outbound").createChannelMessageReplyPipeline;
};
