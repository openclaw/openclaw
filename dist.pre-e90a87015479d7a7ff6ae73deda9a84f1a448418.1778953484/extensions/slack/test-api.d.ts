import { n as ChannelOutboundAdapter } from "../../outbound.types-BK1BT_uT.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-yC1NCFUF.js";
import { t as ResolvedSlackAccount } from "../../accounts-BMIuQygD.js";
import { t as slackPlugin } from "../../channel-CpPSZELg.js";
import { x as sendMessageSlack } from "../../blocks-input-DlPUT-rK.js";
import { t as SlackMessageEvent } from "../../types-CvB-_Bvl.js";
import { n as prepareSlackMessage, t as createInboundSlackTestContext } from "../../prepare.test-helpers-B9NgD5TH.js";
import { t as createSlackOutboundPayloadHarness } from "../../outbound-payload.test-harness-DQwqgKrM.js";
import { t as setSlackRuntime } from "../../runtime-B7FEZR3r.js";
import { AgentToolResult } from "@earendil-works/pi-agent-core";

//#region extensions/slack/src/channel-actions.d.ts
type SlackActionInvoke = (action: Record<string, unknown>, cfg: unknown, toolContext: unknown) => Promise<AgentToolResult<unknown>>;
declare function createSlackActions(providerId: string, options?: {
  invoke?: SlackActionInvoke;
}): ChannelMessageActionAdapter;
//#endregion
//#region extensions/slack/src/outbound-adapter.d.ts
declare const slackOutbound: ChannelOutboundAdapter;
//#endregion
export { type ResolvedSlackAccount, type SlackMessageEvent, createInboundSlackTestContext, createSlackActions, createSlackOutboundPayloadHarness, prepareSlackMessage, sendMessageSlack, setSlackRuntime, slackOutbound, slackPlugin };