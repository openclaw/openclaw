import { i as OpenClawConfig } from "../../types.openclaw-D8bJSZjd.js";
import { n as RuntimeEnv } from "../../runtime-gBwJlInh.js";
import { i as WizardPrompter } from "../../prompts-De2QZdpv.js";
import { i as ChannelOutboundContext, n as ChannelOutboundAdapter, y as OutboundDeliveryResult } from "../../outbound.types-GcP9rxun.js";
import { E as ChannelMeta, _ as ChannelLogSink, b as ChannelMessageActionContext, c as ChannelCapabilities, r as ChannelAccountSnapshot, y as ChannelMessageActionAdapter } from "../../types.core-CcKckzwX.js";
import { L as ChannelResolveKind, R as ChannelResolveResult, U as ChannelStatusAdapter, k as ChannelGatewayContext } from "../../types.adapters-BU-dRZaf.js";
import { n as ChannelPlugin } from "../../types.public-DAjiQLbJ.js";
import { n as PluginRuntime } from "../../types-DBMmCO8F.js";
import { t as twitchPlugin } from "../../plugin-CHeJhH-q.js";

//#region extensions/twitch/src/runtime.d.ts
declare const setTwitchRuntime: (next: PluginRuntime) => void, getTwitchRuntime: () => PluginRuntime;
//#endregion
export { type ChannelAccountSnapshot, type ChannelCapabilities, type ChannelGatewayContext, type ChannelLogSink, type ChannelMessageActionAdapter, type ChannelMessageActionContext, type ChannelMeta, type ChannelOutboundAdapter, type ChannelOutboundContext, type ChannelPlugin, type ChannelResolveKind, type ChannelResolveResult, type ChannelStatusAdapter, type OpenClawConfig, type OutboundDeliveryResult, type RuntimeEnv, type WizardPrompter, setTwitchRuntime, twitchPlugin };