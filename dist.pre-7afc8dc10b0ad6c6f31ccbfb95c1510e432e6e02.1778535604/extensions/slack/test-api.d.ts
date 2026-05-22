import { n as ChannelOutboundAdapter } from "../../outbound.types-IRn7e6X5.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-gexONR-2.js";
import { t as ResolvedSlackAccount } from "../../accounts-Dtsb9sj2.js";
import { t as slackPlugin } from "../../channel-BQgBXmPS.js";
import { x as sendMessageSlack } from "../../blocks-input-Cxm2ntt1.js";
import { t as SlackMessageEvent } from "../../types-7eeC8zOM.js";
import { n as prepareSlackMessage, t as createInboundSlackTestContext } from "../../prepare.test-helpers-JHzWEiOH.js";
import { t as createSlackOutboundPayloadHarness } from "../../outbound-payload.test-harness-CNo8bi3A.js";
import { t as setSlackRuntime } from "../../runtime-Bds7r0hy.js";
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