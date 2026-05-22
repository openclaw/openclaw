import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
import { n as RuntimeEnv } from "../../runtime-D0p4Vp8x.js";
import { i as WizardPrompter } from "../../prompts-lrXrb5IE.js";
import { i as ChannelOutboundContext, n as ChannelOutboundAdapter, y as OutboundDeliveryResult } from "../../outbound.types-IRn7e6X5.js";
import { E as ChannelMeta, _ as ChannelLogSink, b as ChannelMessageActionContext, c as ChannelCapabilities, r as ChannelAccountSnapshot, y as ChannelMessageActionAdapter } from "../../types.core-gexONR-2.js";
import { L as ChannelResolveKind, R as ChannelResolveResult, U as ChannelStatusAdapter, k as ChannelGatewayContext } from "../../types.adapters-BLIJ2aQP.js";
import { n as ChannelPlugin } from "../../types.public-D_xOTs5v.js";
import { n as PluginRuntime } from "../../types-C2b0JJwH.js";
import { t as twitchPlugin } from "../../plugin-CwPGdeG2.js";

//#region extensions/twitch/src/runtime.d.ts
declare const setTwitchRuntime: (next: PluginRuntime) => void, getTwitchRuntime: () => PluginRuntime;
//#endregion
export { type ChannelAccountSnapshot, type ChannelCapabilities, type ChannelGatewayContext, type ChannelLogSink, type ChannelMessageActionAdapter, type ChannelMessageActionContext, type ChannelMeta, type ChannelOutboundAdapter, type ChannelOutboundContext, type ChannelPlugin, type ChannelResolveKind, type ChannelResolveResult, type ChannelStatusAdapter, type OpenClawConfig, type OutboundDeliveryResult, type RuntimeEnv, type WizardPrompter, setTwitchRuntime, twitchPlugin };