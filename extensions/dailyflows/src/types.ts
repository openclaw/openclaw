import type {
  ChannelConfigAdapter,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelStatusAdapter,
} from "../../../src/channels/plugins/types.adapters.js";
import type { ChannelCapabilities, ChannelMeta } from "../../../src/channels/plugins/types.core.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { OutboundDeliveryResult } from "../../../src/infra/outbound/deliver.js";
import type { RuntimeEnv } from "../../../src/runtime.js";

export type DailyflowsAttachmentType = "image" | "file" | "audio";

export type DailyflowsInboundAttachment = {
  type: DailyflowsAttachmentType;
  url: string;
  name?: string;
  mime?: string;
  size?: number;
  durationMs?: number;
};

export type DailyflowsInboundMessage = {
  messageId?: string;
  chatType?: "direct" | "group";
  senderId: string;
  senderName?: string;
  conversationId: string;
  conversationName?: string;
  text?: string;
  attachments?: DailyflowsInboundAttachment[];
};

export type DailyflowsWebhookPayload = {
  id: string;
  type: "message.received";
  occurredAt?: number;
  accountId?: string;
  message: DailyflowsInboundMessage;
};

export type DailyflowsOutboundAttachment = {
  type: DailyflowsAttachmentType;
  url: string;
  name?: string;
  mime?: string;
  size?: number;
  durationMs?: number;
};

export type DailyflowsOutboundPayload = {
  accountId: string;
  conversationId: string;
  messageId?: string;
  text?: string;
  replyToId?: string;
  attachments?: DailyflowsOutboundAttachment[];
};

export type DailyflowsAccountConfig = {
  name?: string;
  enabled?: boolean;
  webhookSecret?: string;
  outboundUrl?: string;
  outboundToken?: string;
};

export type DailyflowsChannelConfig = {
  enabled?: boolean;
  webhookPath?: string;
  webhookSecret?: string;
  accounts?: Record<string, DailyflowsAccountConfig>;
};

export type ResolvedDailyflowsAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  webhookSecret?: string;
  outboundUrl?: string;
  outboundToken?: string;
  config: DailyflowsChannelConfig;
};

export type DailyflowsChannelPlugin = ChannelPlugin<ResolvedDailyflowsAccount>;
export type DailyflowsOutboundAdapter = ChannelOutboundAdapter;
export type DailyflowsOutboundContext = ChannelOutboundContext;
export type DailyflowsOutboundResult = OutboundDeliveryResult;
export type DailyflowsChannelConfigAdapter = ChannelConfigAdapter<ResolvedDailyflowsAccount>;
export type DailyflowsChannelStatusAdapter = ChannelStatusAdapter<ResolvedDailyflowsAccount>;
export type DailyflowsRuntimeEnv = RuntimeEnv;
export type DailyflowsChannelMeta = ChannelMeta;
export type DailyflowsChannelCapabilities = ChannelCapabilities;
export type DailyflowsConfig = OpenClawConfig;
