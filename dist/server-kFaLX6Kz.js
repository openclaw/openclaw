import "./paths-BJV7vkaX.js";
import { t as createSubsystemLogger } from "./subsystem-DBBM_0ww.js";
import "./utils-JhJvOE-Q.js";
import { $m as createBrowserRuntimeState, Bm as installBrowserAuthMiddleware, Hm as registerBrowserRoutes, Nh as ensureBrowserControlAuth, Ph as resolveBrowserControlAuth, Vm as installBrowserCommonMiddleware, eh as stopBrowserRuntime, mh as resolveBrowserConfig, th as createBrowserRouteContext, x_ as loadConfig } from "./reply-kqyKJg4x.js";
import "./agent-scope-BwZuo7sQ.js";
import "./openclaw-root-CGu4EGX8.js";
import "./logger-B7cfoxgB.js";
import "./exec-eWx7-KTZ.js";
import "./github-copilot-token-DLfBlMRf.js";
import "./boolean-B938tROv.js";
import "./env-Cb5JzEB2.js";
import "./env-overrides-C-ZXrJon.js";
import "./registry-BbhZ8aJW.js";
import "./skills-3AC6GJLt.js";
import "./frontmatter-BngyYhS0.js";
import "./plugins-By9GTgrF.js";
import "./query-expansion-yWVZ1kDa.js";
import "./redact-ey2aG4c9.js";
import "./path-alias-guards-Cb4NBV2_.js";
import "./fetch-pr82VtKF.js";
import "./cli-utils-DMoIioWo.js";
import "./delivery-queue-DFrlUHFS.js";
import "./paths-DtZZPyOl.js";
import "./session-cost-usage-CUa3Yrhb.js";
import "./prompt-style-DxRe6Qmy.js";
import "./links-D5--5M_8.js";
import express from "express";
//#region src/browser/server.ts
let state = null;
const logServer = createSubsystemLogger("browser").child("server");
async function startBrowserControlServerFromConfig() {
	if (state) return state;
	const cfg = loadConfig();
	const resolved = resolveBrowserConfig(cfg.browser, cfg);
	if (!resolved.enabled) return null;
	let browserAuth = resolveBrowserControlAuth(cfg);
	let browserAuthBootstrapFailed = false;
	try {
		const ensured = await ensureBrowserControlAuth({ cfg });
		browserAuth = ensured.auth;
		if (ensured.generatedToken) logServer.info("No browser auth configured; generated gateway.auth.token automatically.");
	} catch (err) {
		logServer.warn(`failed to auto-configure browser auth: ${String(err)}`);
		browserAuthBootstrapFailed = true;
	}
	if (browserAuthBootstrapFailed && !browserAuth.token && !browserAuth.password) {
		logServer.error("browser control startup aborted: authentication bootstrap failed and no fallback auth is configured.");
		return null;
	}
	const app = express();
	installBrowserCommonMiddleware(app);
	installBrowserAuthMiddleware(app, browserAuth);
	registerBrowserRoutes(app, createBrowserRouteContext({
		getState: () => state,
		refreshConfigFromDisk: true
	}));
	const port = resolved.controlPort;
	const server = await new Promise((resolve, reject) => {
		const s = app.listen(port, "127.0.0.1", () => resolve(s));
		s.once("error", reject);
	}).catch((err) => {
		logServer.error(`openclaw browser server failed to bind 127.0.0.1:${port}: ${String(err)}`);
		return null;
	});
	if (!server) return null;
	state = await createBrowserRuntimeState({
		server,
		port,
		resolved,
		onWarn: (message) => logServer.warn(message)
	});
	const authMode = browserAuth.token ? "token" : browserAuth.password ? "password" : "off";
	logServer.info(`Browser control listening on http://127.0.0.1:${port}/ (auth=${authMode})`);
	return state;
}
async function stopBrowserControlServer() {
	await stopBrowserRuntime({
		current: state,
		getState: () => state,
		clearState: () => {
			state = null;
		},
		closeServer: true,
		onWarn: (message) => logServer.warn(message)
	});
}
//#endregion
export { startBrowserControlServerFromConfig, stopBrowserControlServer };
