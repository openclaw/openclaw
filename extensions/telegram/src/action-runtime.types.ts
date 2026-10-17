import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { TelegramMessageMutationContext } from "./message-topic-binding.js";

/** Host-owned context for one Telegram message action; never sourced from model params. */
export type TelegramActionRuntimeOptions = {
  mediaAccess?: ChannelMessageActionContext["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  sessionKey?: string | null;
  inboundEventKind?: string;
  gatewayClientScopes?: readonly string[];
  deliveryRetryOwner?: ChannelMessageActionContext["deliveryRetryOwner"];
  actionOrigin?: ChannelMessageActionContext["actionOrigin"];
  onPlatformSendDispatch?: ChannelMessageActionContext["onPlatformSendDispatch"];
  assertDirectAdapterHandoff?: ChannelMessageActionContext["assertDirectAdapterHandoff"];
  skipQueue?: boolean;
  conversationReadOrigin?: NonNullable<ChannelMessageActionContext["conversationReadOrigin"]>;
  requesterAccountId?: string | null;
  requesterSenderId?: string | null;
  reply?: ChannelMessageActionContext["reply"];
  progressSnapshot?: ChannelMessageActionContext["progressSnapshot"];
  toolContext?: TelegramMessageMutationContext["toolContext"];
};
