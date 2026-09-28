/**
 * Browser control route root registration.
 *
 * Wires basic, tab, permission, and agent route groups onto the supplied HTTP
 * or in-process route registrar.
 */
import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserAgentRoutes } from "./agent.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { registerBrowserPermissionRoutes } from "./permissions.js";
import { withBrowserProfileCapabilities } from "./profile-capabilities.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import type { BrowserRouteRegistrar } from "./types.js";

/** Register every browser control route group. */
export function registerBrowserRoutes(registrar: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  const app = withBrowserProfileCapabilities(registrar, ctx);
  registerBrowserBasicRoutes(app, ctx);
  registerBrowserTabRoutes(app, ctx);
  registerBrowserPermissionRoutes(app, ctx);
  registerBrowserAgentRoutes(app, ctx);
}
