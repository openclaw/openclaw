//#region src/cli/outbound-send-mapping.d.ts
/**
 * CLI-internal send function sources, keyed by channel ID.
 * Each value is a lazily-loaded send function for that channel.
 */
declare const CLI_OUTBOUND_SEND_FACTORY: unique symbol;
type CliOutboundSendFactory = (channelId: string) => unknown;
type CliOutboundSendSource = {
  [channelId: string]: unknown;
  [CLI_OUTBOUND_SEND_FACTORY]?: CliOutboundSendFactory;
};
//#endregion
//#region src/cli/deps.types.d.ts
type CliDeps = CliOutboundSendSource;
//#endregion
export { CliDeps as t };