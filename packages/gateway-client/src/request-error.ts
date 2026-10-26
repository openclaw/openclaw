import { formatConnectErrorMessage } from "@openclaw/gateway-protocol/connect-error-details";
import type { ErrorShape } from "@openclaw/gateway-protocol/frame-guards";
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "./protocol-request.js";

export class GatewayClientRequestError extends GatewayProtocolRequestError {
  constructor(error: Partial<ErrorShape>) {
    super({
      ...error,
      message: formatConnectErrorMessage({ message: error.message, details: error.details }),
    });
    this.name = "GatewayClientRequestError";
  }
}

export class GatewayClientRequestTimeoutError extends GatewayProtocolRequestTimeoutError {
  constructor(params: { method: string; timeoutMs: number; requestSent: boolean }) {
    super(params, `gateway request timeout for ${params.method}`);
    this.name = "GatewayClientRequestTimeoutError";
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
