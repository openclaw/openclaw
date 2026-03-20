import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { wechatLinuxPlugin } from "./channel.js";
import type { ResolvedWechatLinuxAccount } from "./types.js";

export const wechatLinuxSetupPlugin: ChannelPlugin<ResolvedWechatLinuxAccount> =
  wechatLinuxPlugin as ChannelPlugin<ResolvedWechatLinuxAccount>;
