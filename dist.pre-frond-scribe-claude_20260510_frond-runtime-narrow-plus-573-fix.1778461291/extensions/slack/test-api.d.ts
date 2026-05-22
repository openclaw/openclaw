import { n as ChannelOutboundAdapter } from "../../outbound.types-DfHbN8bI.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-CQScvK0N.js";
import { t as ResolvedSlackAccount } from "../../accounts-DPsUsrfo.js";
import { t as slackPlugin } from "../../channel-CrvO5LMT.js";
import { x as sendMessageSlack } from "../../blocks-input-3CUCsqZv.js";
import { t as SlackMessageEvent } from "../../types-DYymt4A4.js";
import { n as prepareSlackMessage, t as createInboundSlackTestContext } from "../../prepare.test-helpers-DfmIIo2j.js";
import { t as createSlackOutboundPayloadHarness } from "../../outbound-payload.test-harness-bbBWtowo.js";
import { t as setSlackRuntime } from "../../runtime-BM-lC4vq.js";
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