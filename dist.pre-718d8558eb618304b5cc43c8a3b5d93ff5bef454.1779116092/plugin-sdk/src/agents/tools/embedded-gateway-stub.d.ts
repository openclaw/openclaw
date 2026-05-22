import type { CallGatewayOptions } from "../../gateway/call.js";
type EmbeddedCallGateway = <T = Record<string, unknown>>(opts: CallGatewayOptions) => Promise<T>;
export declare function createEmbeddedCallGateway(): EmbeddedCallGateway;
export {};
