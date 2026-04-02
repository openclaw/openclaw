import type { Server } from "node:http";
import express from "express";
import { resolveBrowserConfig } from "./browser/config.js";
import { ensureBrowserControlAuth, resolveBrowserControlAuth } from "./browser/control-auth.js";
import { registerBrowserRoutes } from "./browser/routes/index.js";
import type { BrowserRouteRegistrar } from "./browser/routes/types.js";
import { createBrowserRuntimeState, stopBrowserRuntime } from "./browser/runtime-lifecycle.js";
import { type BrowserServerState, createBrowserRouteContext } from "./browser/server-context.js";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./browser/server-middleware.js";
import { loadConfig } from "./config/config.js";
import { createSubsystemLogger } from "./logging/subsystem.js";
import { isDefaultBrowserPluginEnabled } from "./plugin-enabled.js";

let state: BrowserServerState | null = null;
const log = createSubsystemLogger("browser");
const logServer = log.child("server");

export async function startBrowserControlServerFromConfig(): Promise<BrowserServerState | null> {
  if (state) {
    return state;
  }

  const cfg = loadConfig();
  if (!isDefaultBrowserPluginEnabled(cfg)) {
    return null;
  }
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  if (!resolved.enabled) {
    return null;
  }

  let browserAuth = resolveBrowserControlAuth(cfg);
  let browserAuthBootstrapFailed = false;
  try {
    const ensured = await ensureBrowserControlAuth({ cfg });
    browserAuth = ensured.auth;
    if (ensured.generatedToken) {
      logServer.info("No browser auth configured; generated gateway.auth.token automatically.");
    }
  } catch (err) {
    logServer.warn(`failed to auto-configure browser auth: ${String(err)}`);
    browserAuthBootstrapFailed = true;
  }

  // Fail closed: if auth bootstrap failed and no explicit auth is available,
  // do not start the browser control HTTP server.
  if (browserAuthBootstrapFailed && !browserAuth.token && !browserAuth.password) {
    logServer.error(
      "browser control startup aborted: authentication bootstrap failed and no fallback auth is configured.",
    );
    return null;
  }

  const app = express();
  installBrowserCommonMiddleware(app);
  installBrowserAuthMiddleware(app, browserAuth);

  const ctx = createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: true,
  });
  registerBrowserRoutes(app as unknown as BrowserRouteRegistrar, ctx);

  const port = resolved.controlPort;
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  }).catch((err) => {
    logServer.error(`openclaw browser server failed to bind 127.0.0.1:${port}: ${String(err)}`);
    return null;
  });

  if (!server) {
    return null;
  }

  state = await createBrowserRuntimeState({
    server,
    port,
    resolved,
    onWarn: (message) => logServer.warn(message),
  });

  const authMode = browserAuth.token ? "token" : browserAuth.password ? "password" : "off";
  logServer.info(`Browser control listening on http://127.0.0.1:${port}/ (auth=${authMode})`);
  return state;
}

export async function stopBrowserControlServer(): Promise<void> {
  const current = state;
  await stopBrowserRuntime({
    current,
    getState: () => state,
    clearState: () => {
      state = null;
    },
    closeServer: true,
    onWarn: (message) => logServer.warn(message),
  });
}
