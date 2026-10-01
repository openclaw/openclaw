/**
 * Lazy boundary for the extension relay (pulls in the ws server dependency).
 */
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

let modPromise: Promise<typeof import("./extension-relay/relay-lifecycle.js")> | null = null;

// Ingress owns loading; shutdown only joins the module that acquired its sockets.
export const getGatewayExtensionRelayModule = createLazyRuntimeModule(
  () => import("./extension-relay/gateway-relay-route.js"),
);

/** Load the extension relay lifecycle module on demand. */
export function getExtensionRelayModule(): Promise<
  typeof import("./extension-relay/relay-lifecycle.js")
> {
  modPromise ??= import("./extension-relay/relay-lifecycle.js");
  return modPromise;
}
