import { n as ChannelOutboundAdapter } from "../../outbound.types-Bzt2qlxn.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-BoZgMdCh.js";
import { t as ResolvedSlackAccount } from "../../accounts-BW0mLoDq.js";
import { t as slackPlugin } from "../../channel-B2Kjyt8D.js";
import { x as sendMessageSlack } from "../../blocks-input-B9yXrU6o.js";
import { t as SlackMessageEvent } from "../../types-D2gDkdxg.js";
import { n as prepareSlackMessage, t as createInboundSlackTestContext } from "../../prepare.test-helpers-BiAiKytb.js";
import { t as createSlackOutboundPayloadHarness } from "../../outbound-payload.test-harness-D1_31Kf4.js";
import { t as setSlackRuntime } from "../../runtime-CGcWr3rv.js";
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