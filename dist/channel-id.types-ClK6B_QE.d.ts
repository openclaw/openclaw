//#region src/channels/ids.d.ts
type ChatChannelId = string;
//#endregion
//#region src/channels/plugins/channel-id.types.d.ts
type ChannelId = ChatChannelId | (string & {});
//#endregion
export { ChatChannelId as n, ChannelId as t };