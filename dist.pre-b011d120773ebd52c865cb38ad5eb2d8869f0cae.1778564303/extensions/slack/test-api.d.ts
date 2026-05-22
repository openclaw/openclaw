import { n as ChannelOutboundAdapter } from "../../outbound.types-DgglYInj.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-D5GEzFhB.js";
import { t as ResolvedSlackAccount } from "../../accounts-DzivhUQ4.js";
import { t as slackPlugin } from "../../channel-DR3c_t47.js";
import { x as sendMessageSlack } from "../../blocks-input-C1rJwN9p.js";
import { t as SlackMessageEvent } from "../../types-Uo9VbEE4.js";
import { n as prepareSlackMessage, t as createInboundSlackTestContext } from "../../prepare.test-helpers-BjvNMmTr.js";
import { t as createSlackOutboundPayloadHarness } from "../../outbound-payload.test-harness-Dgk4yKRG.js";
import { t as setSlackRuntime } from "../../runtime-Cle04az_.js";
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