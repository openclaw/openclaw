import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedQaChannelAccount } from "./accounts.js";
import { createQaChannelPluginBase } from "./channel-base.js";

export const qaChannelSetupPlugin: ChannelPlugin<ResolvedQaChannelAccount> =
  createQaChannelPluginBase();
