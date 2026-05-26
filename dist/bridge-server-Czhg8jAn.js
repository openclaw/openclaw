import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as isLoopbackHost } from "./net-DCUMtgJy.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./sdk-security-runtime-C8OhDycR.js";
import { r as setBridgeAuthForPort, t as deleteBridgeAuthForPort } from "./bridge-auth-registry-Dh7lGqUM.js";
import { n as installBrowserAuthMiddleware, r as installBrowserCommonMiddleware, t as hasVerifiedBrowserAuth } from "./server-middleware-F31GNlgQ.js";
import express from "express";
//#region extensions/browser/src/browser/bridge-server.ts
function buildNoVncBootstrapHtml(params) {
	const hash = new URLSearchParams({
		autoconnect: "1",
		resize: "remote"
	});
	const password = normalizeOptionalString(params.password);
	if (password) hash.set("password", password);
	const targetUrl = `http://127.0.0.1:${params.noVncPort}/vnc.html#${hash.toString()}`;
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>OpenClaw noVNC Observer</title>
</head>
<body>
  <p>Opening sandbox observer...</p>
  <script>
    const target = ${JSON.stringify(targetUrl)};
    window.location.replace(target);
  <\/script>
</body>
</html>`;
}
async function startBrowserBridgeServer(params) {
	const host = params.host ?? "127.0.0.1";
	if (!isLoopbackHost(host)) throw new Error(`bridge server must bind to loopback host (got ${host})`);
	const port = params.port ?? 0;
	const app = express();
	installBrowserCommonMiddleware(app);
	const authToken = normalizeOptionalString(params.authToken);
	const authPassword = normalizeOptionalString(params.authPassword);
	if (!authToken && !authPassword) throw new Error("bridge server requires auth (authToken/authPassword missing)");
	installBrowserAuthMiddleware(app, {
		token: authToken,
		password: authPassword
	});
	if (params.resolveSandboxNoVncToken) app.get("/sandbox/novnc", (req, res) => {
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
	const state = {
		server: null,
		port,
		resolved: params.resolved,
		profiles: /* @__PURE__ */ new Map()
	};
	if (params.skipRouteRegistrationForTest) app.get("/", (_req, res) => {
		res.status(200).send("OK");
	});
	else {
		const [{ createBrowserRouteContext }, { registerBrowserRoutes }] = await Promise.all([import("./server-context-CLJBu24Y.js"), import("./routes-H3zu_CJ3.js")]);
		registerBrowserRoutes(app, createBrowserRouteContext({
			getState: () => state,
			onEnsureAttachTarget: params.onEnsureAttachTarget
		}));
	}
	const server = await new Promise((resolve, reject) => {
		const s = app.listen(port, host, () => resolve(s));
		s.once("error", reject);
	});
	const resolvedPort = server.address()?.port ?? port;
	state.server = server;
	state.port = resolvedPort;
	state.resolved.controlPort = resolvedPort;
	setBridgeAuthForPort(resolvedPort, {
		token: authToken,
		password: authPassword
	});
	return {
		server,
		port: resolvedPort,
		baseUrl: `http://${host}:${resolvedPort}`,
		state
	};
}
async function stopBrowserBridgeServer(server) {
	try {
		const address = server.address();
		if (address?.port) deleteBridgeAuthForPort(address.port);
	} catch {}
	await new Promise((resolve) => {
		server.close(() => resolve());
	});
}
//#endregion
export { stopBrowserBridgeServer as n, startBrowserBridgeServer as t };
