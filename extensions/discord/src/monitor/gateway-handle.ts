import type { GatewayPlugin } from "@buape/carbon/gateway";

/**
 * Alias for GatewayPlugin used within the lifecycle layer.
 * The "Mutable" prefix reflects that the lifecycle may write to internal
 * gateway state (e.g. clearing session/sequence for forced reconnects).
 */
export type MutableDiscordGateway = GatewayPlugin;
