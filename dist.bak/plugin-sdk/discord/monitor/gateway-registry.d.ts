import type { GatewayPlugin } from "@buape/carbon/gateway";
/** Register a GatewayPlugin instance for an account. */
export declare function registerGateway(accountId: string | undefined, gateway: GatewayPlugin): void;
/** Unregister a GatewayPlugin instance for an account. */
export declare function unregisterGateway(accountId?: string): void;
/** Get the GatewayPlugin for an account. Returns undefined if not registered. */
export declare function getGateway(accountId?: string): GatewayPlugin | undefined;
/** Clear all registered gateways (for testing). */
export declare function clearGateways(): void;
