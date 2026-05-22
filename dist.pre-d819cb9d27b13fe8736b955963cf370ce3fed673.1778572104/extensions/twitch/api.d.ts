import { i as OpenClawConfig } from "../../types.openclaw-BlE9q7jU.js";
import { n as RuntimeEnv } from "../../runtime-B7xbUSXv.js";
import { i as WizardPrompter } from "../../prompts-BT1CkWIz.js";
import { i as ChannelOutboundContext, n as ChannelOutboundAdapter, y as OutboundDeliveryResult } from "../../outbound.types-Bzt2qlxn.js";
import { E as ChannelMeta, _ as ChannelLogSink, b as ChannelMessageActionContext, c as ChannelCapabilities, r as ChannelAccountSnapshot, y as ChannelMessageActionAdapter } from "../../types.core-BoZgMdCh.js";
import { L as ChannelResolveKind, R as ChannelResolveResult, U as ChannelStatusAdapter, k as ChannelGatewayContext } from "../../types.adapters-mQGWB7d9.js";
import { n as ChannelPlugin } from "../../types.public-Bp4rl8_W.js";
import { n as PluginRuntime } from "../../types-6GKVZ6OQ.js";
import { t as twitchPlugin } from "../../plugin-DWGp65UK.js";

//#region extensions/twitch/src/runtime.d.ts
declare const setTwitchRuntime: (next: PluginRuntime) => void, getTwitchRuntime: () => PluginRuntime;
//#endregion
export { type ChannelAccountSnapshot, type ChannelCapabilities, type ChannelGatewayContext, type ChannelLogSink, type ChannelMessageActionAdapter, type ChannelMessageActionContext, type ChannelMeta, type ChannelOutboundAdapter, type ChannelOutboundContext, type ChannelPlugin, type ChannelResolveKind, type ChannelResolveResult, type ChannelStatusAdapter, type OpenClawConfig, type OutboundDeliveryResult, type RuntimeEnv, type WizardPrompter, setTwitchRuntime, twitchPlugin };