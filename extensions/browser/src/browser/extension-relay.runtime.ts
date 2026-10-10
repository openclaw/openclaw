import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

// Ingress owns loading; shutdown only joins the module that acquired its sockets.
export const getGatewayExtensionRelayModule = createLazyRuntimeModule(
  () => import("./extension-relay/gateway-relay-route.js"),
);

export const getExtensionRelayModule = createLazyRuntimeModule(
  () => import("./extension-relay/relay-lifecycle.js"),
);
