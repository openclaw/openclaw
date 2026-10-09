import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createA2aChannelPluginBase } from "./channel-base.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

export const a2aChannelSetupPlugin: ChannelPlugin<ResolvedA2aChannelAccount> =
  createA2aChannelPluginBase();
