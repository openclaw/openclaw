import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { r as setBridgeAuthForPort, t as deleteBridgeAuthForPort } from "./bridge-auth-registry-Cea97afU.js";
import { n as installBrowserAuthMiddleware, r as installBrowserCommonMiddleware } from "./server-middleware-CrsKmHlo.js";
import { n as resolveBrowserConfig } from "./config-CHem-I24.js";
import "./config-CE_TxBVx.js";
import { n as resolveBrowserControlAuth, r as shouldAutoGenerateBrowserAuth, t as ensureBrowserControlAuth } from "./control-auth-zWOv_LPv.js";
import { r as loadBrowserConfigForRuntimeRefresh } from "./server-context-CT7Wt-QD.js";
import "./subsystem-4c3DI8Hy.js";
import { t as registerBrowserRoutes } from "./routes-CV9kuc0U.js";
import { a as stopBrowserControlRuntime, i as getBrowserControlState, n as createBrowserControlContext, r as ensureBrowserControlRuntime, t as isDefaultBrowserPluginEnabled } from "./plugin-enabled-BN2Ji8Ib.js";
import express from "express";
//#region extensions/browser/src/server.ts
const logServer = createSubsystemLogger("browser").child("server");
async function startBrowserControlServerFromConfig() {
	const current = getBrowserControlState();
	if (current?.server) return current;
	const cfg = getRuntimeConfig();
	const browserCfg = loadBrowserConfigForRuntimeRefresh();
	if (!isDefaultBrowserPluginEnabled(browserCfg)) return null;
	const resolved = resolveBrowserConfig(browserCfg.browser, browserCfg);
	if (!resolved.enabled) return null;
	let browserAuth = resolveBrowserControlAuth(cfg);
	let browserAuthBootstrapFailed = false;
	try {
		const ensured = await ensureBrowserControlAuth({ cfg });
		browserAuth = ensured.auth;
		if (ensured.generatedToken) logServer.info("No browser auth configured; generated browser control auth credential automatically.");
	} catch (err) {
		logServer.warn(`failed to auto-configure browser auth: ${String(err)}`);
		browserAuthBootstrapFailed = true;
	}
	if ((browserAuthBootstrapFailed || shouldAutoGenerateBrowserAuth(process.env)) && !browserAuth.token && !browserAuth.password) {
		if (browserAuthBootstrapFailed) logServer.error("browser control startup aborted: authentication bootstrap failed and no fallback auth is configured.");
		else logServer.error("browser control startup aborted: no authentication configured.");
		return null;
	}
	const app = express();
	installBrowserCommonMiddleware(app);
	installBrowserAuthMiddleware(app, browserAuth);
	registerBrowserRoutes(app, createBrowserControlContext());
	const port = resolved.controlPort;
	const server = await new Promise((resolve, reject) => {
		const s = app.listen(port, "127.0.0.1", () => resolve(s));
		s.once("error", reject);
	}).catch((err) => {
		logServer.error(`openclaw browser server failed to bind 127.0.0.1:${port}: ${String(err)}`);
		return null;
	});
	if (!server) return null;
	const state = await ensureBrowserControlRuntime({
		server,
		port,
		resolved,
		owner: "server",
		onWarn: (message) => logServer.warn(message)
	});
	setBridgeAuthForPort(port, browserAuth);
	const authMode = browserAuth.token ? "token" : browserAuth.password ? "password" : "off";
	logServer.info(`Browser control listening on http://127.0.0.1:${port}/ (auth=${authMode})`);
	return state;
}
async function stopBrowserControlServer() {
	const current = getBrowserControlState();
	if (current?.port) deleteBridgeAuthForPort(current.port);
	await stopBrowserControlRuntime({
		requestedBy: "server",
		closeServer: true,
		onWarn: (message) => logServer.warn(message)
	});
}
//#endregion
export { startBrowserControlServerFromConfig, stopBrowserControlServer };
