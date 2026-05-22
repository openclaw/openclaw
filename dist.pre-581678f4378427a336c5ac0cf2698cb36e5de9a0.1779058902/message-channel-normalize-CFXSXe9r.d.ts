//#region src/utils/message-channel-normalize.d.ts
type ChannelId = string & {
  readonly __openclawChannelIdBrand?: never;
};
type DeliverableMessageChannel = ChannelId;
type GatewayMessageChannel = DeliverableMessageChannel;
declare function normalizeMessageChannel(raw?: string | null): string | undefined;
declare function resolveGatewayMessageChannel(raw?: string | null): GatewayMessageChannel | undefined;
//#endregion
export { resolveGatewayMessageChannel as i, GatewayMessageChannel as n, normalizeMessageChannel as r, DeliverableMessageChannel as t };