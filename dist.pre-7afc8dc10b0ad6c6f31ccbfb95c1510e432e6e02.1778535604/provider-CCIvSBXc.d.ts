import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { Dn as GroupToolPolicyConfig, H as SlackSlashCommandConfig } from "./types.channels-CZZMDOR0.js";
import { c as MessagePresentation, n as InteractiveReply } from "./payload-FceNgIH0.js";
import { n as RuntimeEnv } from "./runtime-D0p4Vp8x.js";
import { m as ChannelGroupContext } from "./types.core-gexONR-2.js";
import { n as ChannelRuntimeSurface } from "./channel-runtime-surface.types-CYtR007D.js";
import { i as resolveOpenProviderRuntimeGroupPolicy } from "./runtime-group-policy-CFR3xeVt.js";
import { Block, KnownBlock, WebClient } from "@slack/web-api";
//#region extensions/slack/src/blocks-render.d.ts
type SlackBlock = Block | KnownBlock;
type SlackInteractiveBlockRenderOptions = {
  buttonIndexOffset?: number;
  selectIndexOffset?: number;
};
declare function buildSlackInteractiveBlocks(interactive?: InteractiveReply, options?: SlackInteractiveBlockRenderOptions): SlackBlock[];
declare function buildSlackPresentationBlocks(presentation?: MessagePresentation, options?: SlackInteractiveBlockRenderOptions): SlackBlock[];
//#endregion
//#region extensions/slack/src/group-policy.d.ts
declare function resolveSlackGroupRequireMention(params: ChannelGroupContext): boolean;
declare function resolveSlackGroupToolPolicy(params: ChannelGroupContext): GroupToolPolicyConfig | undefined;
//#endregion
//#region extensions/slack/src/resolve-channels.d.ts
type SlackChannelLookup = {
  id: string;
  name: string;
  archived: boolean;
  isPrivate: boolean;
};
type SlackChannelResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  archived?: boolean;
};
declare function resolveSlackChannelAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackChannelResolution[]>;
//#endregion
//#region extensions/slack/src/resolve-users.d.ts
type SlackUserLookup = {
  id: string;
  name: string;
  displayName?: string;
  realName?: string;
  email?: string;
  deleted: boolean;
  isBot: boolean;
  isAppUser: boolean;
};
type SlackUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  email?: string;
  deleted?: boolean;
  isBot?: boolean;
  note?: string;
};
declare function resolveSlackUserAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackUserResolution[]>;
//#endregion
//#region extensions/slack/src/monitor/types.d.ts
type MonitorSlackOpts = {
  botToken?: string;
  appToken?: string;
  accountId?: string;
  mode?: "socket" | "http";
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  slashCommand?: SlackSlashCommandConfig; /** Callback to update app-level channel account activity (e.g. lastEventAt). */
  setStatus?: (next: Record<string, unknown>) => void; /** Callback to read the current channel account status snapshot. */
  getStatus?: () => Record<string, unknown>;
};
//#endregion
//#region extensions/slack/src/monitor/provider.d.ts
declare function monitorSlackProvider(opts?: MonitorSlackOpts): Promise<void>;
declare const resolveSlackRuntimeGroupPolicy: typeof resolveOpenProviderRuntimeGroupPolicy;
//#endregion
export { resolveSlackUserAllowlist as a, resolveSlackChannelAllowlist as c, SlackBlock as d, buildSlackInteractiveBlocks as f, SlackUserResolution as i, resolveSlackGroupRequireMention as l, resolveSlackRuntimeGroupPolicy as n, SlackChannelLookup as o, buildSlackPresentationBlocks as p, SlackUserLookup as r, SlackChannelResolution as s, monitorSlackProvider as t, resolveSlackGroupToolPolicy as u };