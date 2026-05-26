import { t as collectErrorGraphCandidates } from "./errors-b3ZrCRlt.js";
import { d as registerUnhandledRejectionHandler } from "./unhandled-rejections-Km9wbHjh.js";
import { a as isSubagentSessionKey, i as isCronSessionKey, n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { c as resolveEffectiveEnableState, s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./error-runtime-DGHc7DZw.js";
import "./runtime-env-BtvWnLRh.js";
import "./routing-79DRZvfm.js";
import { n as resolveBrowserConfig } from "./config-F211Ihcd.js";
import "./config-CblF4FCf.js";
import { n as sweepTrackedBrowserTabs } from "./session-tab-registry-BXl_ZBre.js";
import { n as listKnownProfileNames, t as createBrowserRouteContext } from "./server-context-DxDoSex8.js";
import { o as stopOpenClawChrome } from "./chrome-BZjIEoo0.js";
import { n as getPwAiModule } from "./target-id-BUwa2OxY.js";
import { t as isPwAiLoaded } from "./pw-ai-state-DL7FXLI8.js";
//#region extensions/browser/src/browser/server-lifecycle.ts
async function ensureExtensionRelayForProfiles(_params) {}
async function stopKnownBrowserProfiles(params) {
	const current = params.getState();
	if (!current) return;
	const ctx = createBrowserRouteContext({
		getState: params.getState,
		refreshConfigFromDisk: true
	});
	try {
		for (const name of listKnownProfileNames(current)) try {
			const runtime = current.profiles.get(name);
			if (runtime?.running) {
				await stopOpenClawChrome(runtime.running);
				runtime.running = null;
				continue;
			}
			await ctx.forProfile(name).stopRunningBrowser();
		} catch {}
	} catch (err) {
		params.onWarn(`openclaw browser stop failed: ${String(err)}`);
	}
}
//#endregion
//#region extensions/browser/src/browser/session-tab-cleanup.ts
const MIN_SWEEP_INTERVAL_MS = 6e4;
function minutesToMs(minutes) {
	return Math.max(0, Math.floor(minutes * 6e4));
}
function isPrimaryTrackedBrowserSessionKey(sessionKey) {
	return !isSubagentSessionKey(sessionKey) && !isCronSessionKey(sessionKey) && !isAcpSessionKey(sessionKey);
}
function resolveBrowserTabCleanupRuntimeConfig() {
	const cfg = getRuntimeConfig();
	return resolveBrowserConfig(cfg.browser, cfg).tabCleanup;
}
async function runTrackedBrowserTabCleanupOnce(params) {
	const cleanup = params?.cleanup ?? resolveBrowserTabCleanupRuntimeConfig();
	if (!cleanup.enabled) return 0;
	return await sweepTrackedBrowserTabs({
		now: params?.now,
		idleMs: minutesToMs(cleanup.idleMinutes),
		maxTabsPerSession: cleanup.maxTabsPerSession,
		sessionFilter: isPrimaryTrackedBrowserSessionKey,
		closeTab: params?.closeTab,
		onWarn: params?.onWarn
	});
}
function startTrackedBrowserTabCleanupTimer(params) {
	let stopped = false;
	let timer = null;
	let running = null;
	const schedule = () => {
		if (stopped) return;
		let sweepMinutes = 5;
		try {
			sweepMinutes = resolveBrowserTabCleanupRuntimeConfig().sweepMinutes;
		} catch (err) {
			params.onWarn(`failed to resolve browser tab cleanup config: ${String(err)}`);
		}
		timer = setTimeout(run, Math.max(MIN_SWEEP_INTERVAL_MS, minutesToMs(sweepMinutes)));
		timer.unref?.();
	};
	const run = () => {
		if (stopped) return;
		if (!running) {
			running = runTrackedBrowserTabCleanupOnce({ onWarn: params.onWarn }).finally(() => {
				running = null;
				schedule();
			});
			return;
		}
		schedule();
	};
	schedule();
	return () => {
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
}
//#endregion
//#region extensions/browser/src/browser/unhandled-rejections.ts
const PLAYWRIGHT_DIALOG_METHODS = new Set(["Page.handleJavaScriptDialog", "Dialog.handleJavaScriptDialog"]);
const NO_DIALOG_MESSAGE = "no dialog is showing";
function readMessage(err) {
	if (typeof err === "string") return err;
	if (!err || typeof err !== "object") return "";
	const message = err.message;
	return typeof message === "string" ? message : "";
}
function readPlaywrightMethod(err) {
	if (!err || typeof err !== "object") return;
	const method = err.method;
	return typeof method === "string" ? method : void 0;
}
function isPlaywrightDialogRaceUnhandledRejection(reason) {
	for (const candidate of collectErrorGraphCandidates(reason, (current) => [
		current.cause,
		current.reason,
		current.original,
		current.error,
		current.data,
		...Array.isArray(current.errors) ? current.errors : []
	])) {
		const message = readMessage(candidate);
		if (!message.toLowerCase().includes(NO_DIALOG_MESSAGE)) continue;
		const method = readPlaywrightMethod(candidate);
		if (method && PLAYWRIGHT_DIALOG_METHODS.has(method)) return true;
		for (const playwrightMethod of PLAYWRIGHT_DIALOG_METHODS) if (message.includes(playwrightMethod)) return true;
	}
	return false;
}
function registerBrowserUnhandledRejectionHandler() {
	return registerUnhandledRejectionHandler(isPlaywrightDialogRaceUnhandledRejection);
}
//#endregion
//#region extensions/browser/src/browser/runtime-lifecycle.ts
async function createBrowserRuntimeState(params) {
	const state = {
		server: params.server ?? null,
		port: params.port,
		resolved: params.resolved,
		profiles: /* @__PURE__ */ new Map()
	};
	state.stopTrackedTabCleanup = startTrackedBrowserTabCleanupTimer({ onWarn: params.onWarn });
	await ensureExtensionRelayForProfiles({
		resolved: params.resolved,
		onWarn: params.onWarn
	});
	state.stopUnhandledRejectionHandler = registerBrowserUnhandledRejectionHandler();
	return state;
}
async function stopBrowserRuntime(params) {
	if (!params.current) return;
	try {
		params.current.stopTrackedTabCleanup?.();
		await stopKnownBrowserProfiles({
			getState: params.getState,
			onWarn: params.onWarn
		});
		if (params.closeServer && params.current.server) await new Promise((resolve) => {
			params.current?.server?.close(() => resolve());
		});
		params.clearState();
		if (!isPwAiLoaded()) return;
		try {
			await (await getPwAiModule({ mode: "soft" }))?.closePlaywrightBrowserConnection();
		} catch {}
	} finally {
		params.current.stopUnhandledRejectionHandler?.();
	}
}
//#endregion
//#region extensions/browser/src/browser-control-state.ts
let state = null;
let owner = null;
function getBrowserControlState() {
	return state;
}
function createBrowserControlContext() {
	return createBrowserRouteContext({
		getState: () => state,
		refreshConfigFromDisk: true
	});
}
async function ensureBrowserControlRuntime(params) {
	if (state) {
		if (params.server) {
			state.server = params.server;
			state.port = params.port;
			state.resolved = {
				...params.resolved,
				controlPort: params.port
			};
			owner = "server";
		}
		return state;
	}
	state = await createBrowserRuntimeState({
		server: params.server ?? null,
		port: params.port,
		resolved: params.resolved,
		onWarn: params.onWarn
	});
	owner = params.owner;
	return state;
}
async function stopBrowserControlRuntime(params) {
	const current = state;
	if (!current) return;
	if (params.requestedBy === "service" && current.server && owner === "server") return;
	await stopBrowserRuntime({
		current,
		getState: () => state,
		clearState: () => {
			state = null;
			owner = null;
		},
		closeServer: params.closeServer,
		onWarn: params.onWarn
	});
}
//#endregion
//#region extensions/browser/src/plugin-enabled.ts
function isDefaultBrowserPluginEnabled(cfg) {
	return resolveEffectiveEnableState({
		id: "browser",
		origin: "bundled",
		config: normalizePluginsConfig(cfg.plugins),
		rootConfig: cfg,
		enabledByDefault: true
	}).enabled;
}
//#endregion
export { stopBrowserControlRuntime as a, getBrowserControlState as i, createBrowserControlContext as n, createBrowserRuntimeState as o, ensureBrowserControlRuntime as r, stopBrowserRuntime as s, isDefaultBrowserPluginEnabled as t };
