/**
 * Loopback browser bridge server.
 *
 * Hosts the browser control routes on an authenticated local port for sandbox,
 * host, and node browser integrations that need HTTP access to browser control.
 */
import type { Server } from "node:http";
import { isIPv6, type AddressInfo } from "node:net";
import { promisify } from "node:util";
import express from "express";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  escapeHtml,
  openClawMascotStyles,
  openClawWordmarkTextSvg,
  renderOpenClawMascot,
} from "openclaw/plugin-sdk/status-page";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from "./bridge-auth-registry.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { listenBrowserHttpServer } from "./http-listen.js";
import { stopBrowserBridgeRuntime } from "./runtime-lifecycle.js";
import type { BrowserServerState, ProfileContext } from "./server-context.js";
import {
  hasVerifiedBrowserAuth,
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./server-middleware.js";

export type BrowserBridge = {
  server: Server;
  port: number;
  baseUrl: string;
  state: BrowserServerState;
};

const bridgeStates = new WeakMap<Server, BrowserServerState>();
const bridgeStopPromises = new WeakMap<Server, Promise<void>>();

async function closeBridgeHttpServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await promisify(server.close.bind(server))();
}

type ResolvedNoVncObserver = {
  noVncPort: number;
  password?: string;
};

function buildNoVncBootstrapHtml(params: ResolvedNoVncObserver): string {
  const hash = new URLSearchParams({
    autoconnect: "1",
    resize: "remote",
  });
  const password = normalizeOptionalString(params.password);
  if (password) {
    hash.set("password", password);
  }
  const targetUrl = `http://127.0.0.1:${params.noVncPort}/vnc.html#${hash.toString()}`;
  const encodedTarget = JSON.stringify(targetUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <meta name="color-scheme" content="light" />
  <title>OpenClaw noVNC Observer</title>
  <style>
    /* Gateway status-page tokens and geometry, with the observer's existing light theme. */
    :root{color-scheme:light;--bg:#f8f8f8;--text:#353535;--text-strong:#202020;--muted:#5e5e5e;--accent:#bd4531;--mascot-ground:radial-gradient(closest-side,rgb(32 32 32/.16),rgb(32 32 32/.06) 60%,transparent);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.55;letter-spacing:-.01em;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}body{margin:0;background:var(--bg)}
    .shell{display:flex;min-height:100svh}
    .content{position:relative;display:flex;flex-direction:column;flex:1;min-width:0}
    .topbar{display:flex;align-items:flex-start;justify-content:center;padding:14.5px 12px 0}
    .wordmark{display:block;width:105px;height:32px;color:var(--text-strong)}
    main{position:relative;flex:1;min-height:calc(100svh - 64px)}
    .body{position:absolute;top:38%;left:50%;width:min(460px,calc(100% - 48px));transform:translateX(-50%);text-align:center}
    h1{position:relative;margin:0;color:var(--text-strong);font-size:22px;font-weight:600;line-height:28px;letter-spacing:-.01em;text-wrap:balance}
    p{margin:6px 0 0;color:var(--muted);font-size:14px;line-height:21px;text-wrap:pretty}
    a{color:var(--accent)}
    @media(max-width:768px),(max-width:932px) and (max-height:500px) and (orientation:landscape){.content{padding:0 4px}.body{top:36%;left:24px;right:24px;width:auto;transform:none}h1{font-size:20px;line-height:26px}}
    ${openClawMascotStyles({
      busy: ".mascot",
      error: ".mascot[data-pose=error]",
      phone:
        "@media(max-width:768px),(max-width:932px) and (max-height:500px) and (orientation:landscape)",
    })}
  </style>
</head>
<body>
  <div class="shell"><div class="content">
    <header class="topbar">${openClawWordmarkTextSvg}</header>
    <main><div class="body">
      <h1>${renderOpenClawMascot("openclaw-mascot-shell")}Opening sandbox observer…</h1>
      <p>If it doesn’t open, <a href="${escapeHtml(targetUrl)}">continue to the observer</a>.</p>
    </div></main>
  </div></div>
  <script>
    const target = ${encodedTarget};
    window.location.replace(target);
  </script>
</body>
</html>`;
}

export async function startBrowserBridgeServer(params: {
  resolved: ResolvedBrowserConfig;
  host?: string;
  port?: number;
  authToken?: string;
  authPassword?: string;
  onEnsureAttachTarget?: (profile: ProfileContext["profile"]) => Promise<void>;
  resolveSandboxNoVncToken?: (token: string) => ResolvedNoVncObserver | null;
}): Promise<BrowserBridge> {
  const host = params.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`bridge server must bind to loopback host (got ${host})`);
  }
  const port = params.port ?? 0;

  const app = express();
  installBrowserCommonMiddleware(app);

  const authToken = normalizeOptionalString(params.authToken);
  const authPassword = normalizeOptionalString(params.authPassword);
  if (!authToken && !authPassword) {
    throw new Error("bridge server requires auth (authToken/authPassword missing)");
  }
  installBrowserAuthMiddleware(app, { token: authToken, password: authPassword });

  if (params.resolveSandboxNoVncToken) {
    app.get("/sandbox/novnc", (req, res) => {
      if (!hasVerifiedBrowserAuth(req)) {
        res.status(401).send("Unauthorized");
        return;
      }
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Referrer-Policy", "no-referrer");
      const rawToken = normalizeOptionalString(req.query?.token);
      if (!rawToken) {
        res.status(400).send("Missing token");
        return;
      }
      const resolved = params.resolveSandboxNoVncToken?.(rawToken);
      if (!resolved) {
        res.status(404).send("Invalid or expired token");
        return;
      }
      res.type("html").status(200).send(buildNoVncBootstrapHtml(resolved));
    });
  }

  const state: BrowserServerState = {
    server: null,
    port,
    resolved: params.resolved,
    profiles: new Map(),
  };

  const [{ createBrowserRouteContext }, { registerBrowserRoutes }] = await Promise.all([
    import("./server-context.js"),
    import("./routes/index.js"),
  ]);
  const ctx = createBrowserRouteContext({
    getState: () => state,
    onEnsureAttachTarget: params.onEnsureAttachTarget,
  });
  registerBrowserRoutes(app, ctx);

  const server = await listenBrowserHttpServer(app, port, host);

  const address = server.address() as AddressInfo | null;
  const resolvedPort = address?.port ?? port;
  state.server = server;
  state.port = resolvedPort;
  state.resolved.controlPort = resolvedPort;
  bridgeStates.set(server, state);

  setBridgeAuthForPort(resolvedPort, { token: authToken, password: authPassword });

  const baseUrl = `http://${isIPv6(host) ? `[${host}]` : host}:${resolvedPort}`;
  return { server, port: resolvedPort, baseUrl, state };
}

async function stopBrowserBridgeServerOnce(server: Server): Promise<void> {
  let port: number | undefined;
  try {
    const address = server.address() as AddressInfo | null;
    if (address?.port) {
      port = address.port;
    }
  } catch {
    // ignore
  }
  const state = bridgeStates.get(server);
  // Calling close stops new accepts synchronously; its callback waits for
  // already-admitted requests, which runtime invalidation below will abort.
  const httpClose = closeBridgeHttpServer(server);
  if (state) {
    deleteBridgeAuthForPort(state.port);
  } else if (port) {
    deleteBridgeAuthForPort(port);
  }
  if (!state) {
    await httpClose;
    return;
  }
  const runtimeClose = stopBrowserBridgeRuntime({
    current: state,
    // Retain the exact state until ingress and resource cleanup both succeed.
    clearState: () => {},
    onWarn: () => {},
  });
  const settled = await Promise.allSettled([httpClose, runtimeClose]);
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) {
    throw failed.reason;
  }
  bridgeStates.delete(server);
}

export function stopBrowserBridgeServer(server: Server): Promise<void> {
  const current = bridgeStopPromises.get(server);
  if (current) {
    return current;
  }
  const { promise: stopping, resolve, reject } = createDeferred<void>();
  bridgeStopPromises.set(server, stopping);
  void stopBrowserBridgeServerOnce(server).then(resolve, reject);
  void stopping
    .finally(() => {
      bridgeStopPromises.delete(server);
    })
    .catch(() => {});
  return stopping;
}
