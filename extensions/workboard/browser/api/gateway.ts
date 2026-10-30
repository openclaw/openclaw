import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";

export type GatewayBrowserClient = Pick<ControlUiHost, "request">;

export function isGatewayRequestError(error: unknown): error is Error & {
  code: string;
  gatewayCode: string;
  details?: unknown;
} {
  // Host and plugin have independent module graphs; constructor identity is not a wire contract.
  return error instanceof Error && "gatewayCode" in error && "code" in error;
}
