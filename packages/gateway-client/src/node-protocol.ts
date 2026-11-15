import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import type { ConnectParams } from "@openclaw/gateway-protocol/frame-guards";
import { MIN_NODE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";

type NodeClientMetadata = Pick<
  ConnectParams["client"],
  "platform" | "deviceFamily" | "modelIdentifier"
>;

/** Match the shipped v3 node envelope before signing its metadata. */
export function resolveNodeProtocolClientMetadata(
  configured: Partial<NodeClientMetadata>,
  defaultPlatform: string,
  legacy: boolean,
): NodeClientMetadata {
  const platform = configured.platform ?? defaultPlatform;
  if (!legacy) {
    return {
      platform,
      deviceFamily: configured.deviceFamily,
      modelIdentifier: configured.modelIdentifier,
    };
  }
  return {
    platform: platform === "macos" ? "darwin" : platform === "windows" ? "win32" : platform,
  };
}

export function shouldNegotiateLegacyNodeProtocol(options: {
  role?: string;
  mode?: string;
  clientName?: string;
  minProtocol?: number;
  maxProtocol?: number;
}): boolean {
  if (
    options.role !== "node" ||
    options.mode !== GATEWAY_CLIENT_MODES.NODE ||
    options.clientName !== GATEWAY_CLIENT_NAMES.NODE_HOST
  ) {
    return false;
  }
  return (
    (options.minProtocol ?? MIN_NODE_PROTOCOL_VERSION) === MIN_NODE_PROTOCOL_VERSION &&
    (options.maxProtocol ?? PROTOCOL_VERSION) === PROTOCOL_VERSION
  );
}
