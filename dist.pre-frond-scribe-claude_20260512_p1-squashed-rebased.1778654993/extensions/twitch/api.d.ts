import { i as OpenClawConfig } from "../../types.openclaw-BdSNxnBz.js";
import { n as RuntimeEnv } from "../../runtime-DwtdMXkL.js";
import { i as WizardPrompter } from "../../prompts-DFjWh2n9.js";
import { i as ChannelOutboundContext, n as ChannelOutboundAdapter, y as OutboundDeliveryResult } from "../../outbound.types-DsiI6f93.js";
import { E as ChannelMeta, _ as ChannelLogSink, b as ChannelMessageActionContext, c as ChannelCapabilities, r as ChannelAccountSnapshot, y as ChannelMessageActionAdapter } from "../../types.core-BDQOD1ST.js";
import { L as ChannelResolveKind, R as ChannelResolveResult, U as ChannelStatusAdapter, k as ChannelGatewayContext } from "../../types.adapters-DcVjcbEK.js";
import { n as ChannelPlugin } from "../../types.public-D-nwYThg.js";
import { n as PluginRuntime } from "../../types-Czv_rpgT.js";
import { t as twitchPlugin } from "../../plugin-CcWUuJ2S.js";

//#region extensions/twitch/src/runtime.d.ts
declare const setTwitchRuntime: (next: PluginRuntime) => void, getTwitchRuntime: () => PluginRuntime;
//#endregion
export { type ChannelAccountSnapshot, type ChannelCapabilities, type ChannelGatewayContext, type ChannelLogSink, type ChannelMessageActionAdapter, type ChannelMessageActionContext, type ChannelMeta, type ChannelOutboundAdapter, type ChannelOutboundContext, type ChannelPlugin, type ChannelResolveKind, type ChannelResolveResult, type ChannelStatusAdapter, type OpenClawConfig, type OutboundDeliveryResult, type RuntimeEnv, type WizardPrompter, setTwitchRuntime, twitchPlugin };