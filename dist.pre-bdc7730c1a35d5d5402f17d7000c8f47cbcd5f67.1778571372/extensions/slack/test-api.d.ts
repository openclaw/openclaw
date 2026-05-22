import { n as ChannelOutboundAdapter } from "../../outbound.types-DgglYInj.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-D5GEzFhB.js";
import { t as ResolvedSlackAccount } from "../../accounts-5S0jVCHp.js";
import { t as slackPlugin } from "../../channel-DRKwf5Wx.js";
import { x as sendMessageSlack } from "../../blocks-input-BrUjghWI.js";
import { t as SlackMessageEvent } from "../../types-C8u7Kbsp.js";
import { n as prepareSlackMessage, t as createInboundSlackTestContext } from "../../prepare.test-helpers-pW4ov52B.js";
import { t as createSlackOutboundPayloadHarness } from "../../outbound-payload.test-harness-CUk0cmgR.js";
import { t as setSlackRuntime } from "../../runtime-D5LSt0qB.js";
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