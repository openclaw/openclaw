import { n as ChannelOutboundAdapter } from "../../outbound.types-DsiI6f93.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-BDQOD1ST.js";
import { t as ResolvedSlackAccount } from "../../accounts-DPUg_I8o.js";
import { t as slackPlugin } from "../../channel-BAWrRxQG.js";
import { x as sendMessageSlack } from "../../blocks-input-CcreN6BI.js";
import { t as SlackMessageEvent } from "../../types-DVXp7Rot.js";
import { n as prepareSlackMessage, t as createInboundSlackTestContext } from "../../prepare.test-helpers-DK2roPVH.js";
import { t as createSlackOutboundPayloadHarness } from "../../outbound-payload.test-harness-Bixqcb3v.js";
import { t as setSlackRuntime } from "../../runtime-C-U-FNUo.js";
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