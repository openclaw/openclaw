// Browser copilot runtime bundle entry. Keep this list narrow: the extension
// consumes the canonical Gateway auth/wire engines plus the Ed25519 primitive
// needed below Chrome's native WebCrypto support floor.
export { GatewayBrowserDeviceAuthLifecycle } from "../../../packages/gateway-client/src/browser-device-auth.ts";
export {
  GatewayProtocolClient,
  GatewayProtocolRequestError,
} from "../../../packages/gateway-client/src/protocol-client.ts";
export {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.ts";
export {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../packages/gateway-protocol/src/version.ts";
export { getPublicKeyAsync, signAsync, utils as ed25519Utils } from "@noble/ed25519";
