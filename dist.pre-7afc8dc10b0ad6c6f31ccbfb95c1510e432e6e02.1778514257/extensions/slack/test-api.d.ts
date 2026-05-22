import { n as ChannelOutboundAdapter } from "../../outbound.types-IRn7e6X5.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-gexONR-2.js";
import { t as ResolvedSlackAccount } from "../../accounts-ClUjHerM.js";
import { t as slackPlugin } from "../../channel-CiG_3xyP.js";
import { x as sendMessageSlack } from "../../blocks-input-2u2litgz.js";
import { t as SlackMessageEvent } from "../../types-Dlj-m6r3.js";
import { n as prepareSlackMessage, t as createInboundSlackTestContext } from "../../prepare.test-helpers-SHd8ob1E.js";
import { t as createSlackOutboundPayloadHarness } from "../../outbound-payload.test-harness-DAh6q8Lr.js";
import { t as setSlackRuntime } from "../../runtime-BH8THR6R.js";
import { AgentToolResult } from "@mariozechner/pi-agent-core";

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