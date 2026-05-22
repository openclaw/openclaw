import { C as ChannelMessageToolDiscovery, y as ChannelMessageActionAdapter } from "../../types.core-yC1NCFUF.js";
//#region extensions/slack/src/message-tool-api.d.ts
declare function describeSlackMessageTool({
  cfg,
  accountId
}: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0]): ChannelMessageToolDiscovery;
//#endregion
export { describeSlackMessageTool as describeMessageTool };