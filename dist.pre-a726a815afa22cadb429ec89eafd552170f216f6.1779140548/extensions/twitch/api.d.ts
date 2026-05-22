import { i as OpenClawConfig } from "../../types.openclaw-CQzDxdpQ.js";
import { n as RuntimeEnv } from "../../runtime-dOUD4nei.js";
import { i as WizardPrompter } from "../../prompts-2VxOUGug.js";
import { b as OutboundDeliveryResult, i as ChannelOutboundContext, n as ChannelOutboundAdapter } from "../../outbound.types-_qtghrWY.js";
import { E as ChannelMeta, _ as ChannelLogSink, b as ChannelMessageActionContext, c as ChannelCapabilities, r as ChannelAccountSnapshot, y as ChannelMessageActionAdapter } from "../../types.core-DrB_kWzl.js";
import { L as ChannelResolveKind, R as ChannelResolveResult, U as ChannelStatusAdapter, k as ChannelGatewayContext } from "../../types.adapters-r3TJy9mk.js";
import { n as ChannelPlugin } from "../../types.public-C5MFEvPW.js";
import { n as PluginRuntime } from "../../types-CXGnubLv.js";
import { t as twitchPlugin } from "../../plugin-CjYSiOrA.js";

//#region extensions/twitch/src/runtime.d.ts
declare const setTwitchRuntime: (next: PluginRuntime) => void, getTwitchRuntime: () => PluginRuntime;
//#endregion
export { type ChannelAccountSnapshot, type ChannelCapabilities, type ChannelGatewayContext, type ChannelLogSink, type ChannelMessageActionAdapter, type ChannelMessageActionContext, type ChannelMeta, type ChannelOutboundAdapter, type ChannelOutboundContext, type ChannelPlugin, type ChannelResolveKind, type ChannelResolveResult, type ChannelStatusAdapter, type OpenClawConfig, type OutboundDeliveryResult, type RuntimeEnv, type WizardPrompter, setTwitchRuntime, twitchPlugin };