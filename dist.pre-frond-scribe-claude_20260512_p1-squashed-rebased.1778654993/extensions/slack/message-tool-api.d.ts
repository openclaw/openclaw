import { C as ChannelMessageToolDiscovery, y as ChannelMessageActionAdapter } from "../../types.core-BDQOD1ST.js";
//#region extensions/slack/src/message-tool-api.d.ts
declare function describeSlackMessageTool({
  cfg,
  accountId
}: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0]): ChannelMessageToolDiscovery;
//#endregion
export { describeSlackMessageTool as describeMessageTool };