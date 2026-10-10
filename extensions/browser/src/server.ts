import express from "express";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import {
  createBrowserControlContext,
  ensureBrowserControlRuntime,
  getBrowserControlState,
  stopBrowserControlRuntime,
  withBrowserControlStart,
} from "./browser-control-state.js";
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from "./browser/bridge-auth-registry.js";
import { loadBrowserConfigForRuntimeRefresh } from "./browser/config-refresh-source.js";
import { resolveBrowserConfig } from "./browser/config.js";
import {
  ensureBrowserControlAuth,
  resolveBrowserControlAuth,
  shouldAutoGenerateBrowserAuth,
} from "./browser/control-auth.js";
import { startControlStateExtensionRelays } from "./browser/extension-relay/control-startup.js";
import { listenBrowserHttpServer } from "./browser/http-listen.js";
import { registerBrowserRoutes } from "./browser/routes/index.js";
import type { BrowserServerState } from "./browser/server-context.js";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./browser/server-middleware.js";
import { resolveBrowserPluginEnableState } from "./plugin-enabled.js";

const EAGER_BROWSER_CONTROL_SERVER_ENV = "OPENCLAW_EAGER_BROWSER_CONTROL_SERVER";
const log = createSubsystemLogger("browser");
const logServer = log.child("server");

async function startBrowserControlServerUnlocked(): Promise<BrowserServerState | null> {
  const current = getBrowserControlState();
  if (current?.server) {
    return current;
  }

  const cfg = getRuntimeConfig();
  const browserCfg = loadBrowserConfigForRuntimeRefresh();
  if (!resolveBrowserPluginEnableState(cfg).enabled) {
    return null;
  }
  const resolved = resolveBrowserConfig(browserCfg.browser, browserCfg);
  if (!resolved.enabled) {
    return null;
  }

  let browserAuth = resolveBrowserControlAuth(cfg);
  let browserAuthBootstrapFailed = false;
  try {
    const ensured = await ensureBrowserControlAuth({ cfg });
    browserAuth = ensured.auth;
    if (ensured.generatedToken) {
      logServer.info(
        "No browser auth configured; generated browser control auth credential automatically.",
      );
    }
  } catch (err) {
    logServer.warn(`failed to auto-configure browser auth: ${String(err)}`);
    browserAuthBootstrapFailed = true;
  }

  const browserAuthRequired =
    browserAuthBootstrapFailed || shouldAutoGenerateBrowserAuth(process.env);
  if (browserAuthRequired && !browserAuth.token && !browserAuth.password) {
    if (browserAuthBootstrapFailed) {
      logServer.error(
        "browser control startup aborted: authentication bootstrap failed " +
          "and no fallback auth is configured.",
      );
    } else {
      logServer.error("browser control startup aborted: no authentication configured.");
    }
    return null;
  }

  const app = express();
  installBrowserCommonMiddleware(app);
  installBrowserAuthMiddleware(app, browserAuth);

  const ctx = createBrowserControlContext();
  registerBrowserRoutes(app, ctx);

  const port = resolved.controlPort;
  const server = await listenBrowserHttpServer(app, port, "127.0.0.1").catch((err: unknown) => {
    logServer.error(`openclaw browser server failed to bind 127.0.0.1:${port}: ${String(err)}`);
    return null;
  });

  if (!server) {
    return null;
  }

  let state: BrowserServerState;
  try {
    state = await ensureBrowserControlRuntime({
      server,
      port,
      resolved,
    });
  } catch (err) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    throw err;
  }
  setBridgeAuthForPort(port, browserAuth);

  // Gateway boot reaches this HTTP owner only when the eager flag is set.
  // Honor that flag here too so an HTTP start without it does not bind relay
  // ports. Non-extension profiles never do. Relay failure must not tear down
  // the already-bound loopback control server.
  if (isTruthyEnvValue(process.env[EAGER_BROWSER_CONTROL_SERVER_ENV])) {
    try {
      await startControlStateExtensionRelays(state, (message) => logServer.warn(message));
    } catch (err) {
      logServer.warn(`extension relay startup failed: ${String(err)}`);
    }
  }

  const authMode = browserAuth.token ? "token" : browserAuth.password ? "password" : "off";
  logServer.info(`Browser control listening on http://127.0.0.1:${port}/ (auth=${authMode})`);
  return state;
}

export async function startBrowserControlServerFromConfig(): Promise<BrowserServerState | null> {
  return await withBrowserControlStart(startBrowserControlServerUnlocked);
}

export async function stopBrowserControlServer(): Promise<void> {
  const stopped = await stopBrowserControlRuntime({
    requestedBy: "server",
    closeServer: true,
    onWarn: (message) => logServer.warn(message),
  });
  if (stopped?.port) {
    deleteBridgeAuthForPort(stopped.port);
  }
}
