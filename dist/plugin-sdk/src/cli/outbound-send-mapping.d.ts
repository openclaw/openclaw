import { type OutboundSendDeps } from "../infra/outbound/send-deps.js";
/**
 * CLI-internal send function sources, keyed by channel ID.
 * Each value is a lazily-loaded send function for that channel.
 */
export declare const CLI_OUTBOUND_SEND_FACTORY: unique symbol;
type CliOutboundSendFactory = (channelId: string) => unknown;
export type CliOutboundSendSource = {
    [channelId: string]: unknown;
    [CLI_OUTBOUND_SEND_FACTORY]?: CliOutboundSendFactory;
};
/**
 * Pass CLI send sources through as-is — both CliOutboundSendSource and
 * OutboundSendDeps are now channel-ID-keyed records.
 */
export declare function createOutboundSendDepsFromCliSource(deps: CliOutboundSendSource): OutboundSendDeps;
export {};
