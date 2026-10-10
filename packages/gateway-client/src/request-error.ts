import { formatConnectErrorMessage } from "@openclaw/gateway-protocol/connect-error-details";
import type { ErrorShape } from "@openclaw/gateway-protocol/frame-guards";
import { GatewayProtocolRequestError } from "./protocol-request.js";

export class GatewayClientRequestError extends GatewayProtocolRequestError {
  constructor(error: Partial<ErrorShape>) {
    super({
      ...error,
      message: formatConnectErrorMessage({ message: error.message, details: error.details }),
    });
    this.name = "GatewayClientRequestError";
  }
}

const GATEWAY_CONNECT_ASSEMBLY_ERROR = Symbol("gateway.connectAssemblyError");

type GatewayConnectAssemblyError = Error & {
  [GATEWAY_CONNECT_ASSEMBLY_ERROR]?: true;
};

export function markGatewayConnectAssemblyError(error: Error): Error {
  Object.defineProperty(error, GATEWAY_CONNECT_ASSEMBLY_ERROR, {
    configurable: true,
    value: true,
  });
  return error;
}

export function isGatewayConnectAssemblyError(value: unknown): value is Error {
  return (
    value instanceof Error &&
    // SAFETY: The Error may carry this module's optional private-symbol marker; absence reads undefined.
    (value as GatewayConnectAssemblyError)[GATEWAY_CONNECT_ASSEMBLY_ERROR] === true
  );
}
