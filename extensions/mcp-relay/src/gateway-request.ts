import type { GatewayIngressPrincipalBindingV1 } from "openclaw/plugin-sdk/gateway-ingress";

export type GatewayRequest = (
  ...args: Parameters<GatewayIngressPrincipalBindingV1["request"]>
) => Promise<unknown>;
