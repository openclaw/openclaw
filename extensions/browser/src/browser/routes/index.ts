import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserAgentActRoutes } from "./agent.act.js";
import { registerBrowserAgentDebugRoutes } from "./agent.debug.js";
import { registerBrowserAgentScreencastRoutes } from "./agent.screencast.js";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";
import { registerBrowserAgentStorageRoutes } from "./agent.storage.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { registerBrowserPermissionRoutes } from "./permissions.js";
import { withBrowserProfileCapabilities } from "./profile-capabilities.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import type { BrowserRouteRegistrar } from "./types.js";

export function registerBrowserRoutes(registrar: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  const app = withBrowserProfileCapabilities(registrar, ctx);
  registerBrowserBasicRoutes(app, ctx);
  registerBrowserTabRoutes(app, ctx);
  registerBrowserPermissionRoutes(app, ctx);
  registerBrowserAgentSnapshotRoutes(app, ctx);
  registerBrowserAgentScreencastRoutes(app, ctx);
  registerBrowserAgentActRoutes(app, ctx);
  registerBrowserAgentDebugRoutes(app, ctx);
  registerBrowserAgentStorageRoutes(app, ctx);
}
