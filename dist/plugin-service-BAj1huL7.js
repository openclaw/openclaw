import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue } from "./string-coerce-DyL154ka.js";
import { p as resolveExistingPathsWithinRoot } from "./fs-safe-CV86zY9G.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { Ni as ErrorCodes, Pi as errorShape } from "./protocol-DiXjp30g.js";
import { c as jsonResult, g as readStringParam, s as imageResultFromFile } from "./common-E9YpX7pB.js";
import { t as callGatewayTool } from "./gateway-CnPnSTsW.js";
import { a as selectDefaultNodeFromList, i as resolveNodeIdFromList, t as listNodes } from "./nodes-utils-BZvT6hX1.js";
import { i as wrapExternalContent } from "./external-content-BWPoz0BU.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as startLazyPluginServiceModule } from "./plugin-runtime-DG_BosJY.js";
import { o as resolveNodeCommandAllowlist, r as isNodeCommandAllowed } from "./node-command-policy-Bsyvfkrl.js";
import { i as safeParseJson, n as respondUnavailableOnNodeInvokeError } from "./nodes.helpers-DvsMU-XC.js";
import { t as BrowserToolSchema } from "./browser-tool.schema-C8BVx0PT.js";
import { n as withTimeout } from "./sdk-security-runtime-C8OhDycR.js";
import { R as DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "./cdp.helpers-D-78hr0t.js";
import { i as resolveProfile, n as resolveBrowserConfig, s as DEFAULT_UPLOAD_DIR } from "./config-F211Ihcd.js";
import "./sdk-setup-tools-C1n7gEuG.js";
import { _ as browserStop, a as untrackSessionBrowserTab, d as browserOpenTab, f as browserProfiles, g as browserStatus, h as browserStart, i as trackSessionBrowserTab, l as browserDoctor, m as browserSnapshot, o as browserCloseTab, r as touchSessionBrowserTab, u as browserFocusTab, y as browserTabs } from "./session-tab-registry-BXl_ZBre.js";
import { c as browserPdfSave, d as browserArmFileChooser, f as browserNavigate, i as isPersistentBrowserProfileMutation, l as browserAct, n as persistBrowserProxyFiles, o as resolveRequestedBrowserProfile, p as browserScreenshotAction, s as browserConsoleMessages, t as applyBrowserProxyPaths, u as browserArmDialog } from "./browser-runtime-C-DbpndW.js";
import { r as getBrowserProfileCapabilities } from "./target-id-BUwa2OxY.js";
import { r as createBrowserRouteDispatcher, t as startBrowserControlServiceFromConfig } from "./control-service-QFP_AmWr.js";
import { n as createBrowserControlContext } from "./plugin-enabled-QdB1nwFY.js";
import "./core-api-CznnLkt_.js";
import crypto from "node:crypto";
//#region extensions/browser/src/browser-tool.runtime.ts
function resolveRuntimeImageSanitization() {
	const configured = getRuntimeConfig().agents?.defaults?.imageMaxDimensionPx;
	if (typeof configured !== "number" || !Number.isFinite(configured)) return;
	return { maxDimensionPx: Math.max(1, Math.floor(configured)) };
}
//#endregion
//#region extensions/browser/src/browser-tool.actions.ts
const browserToolActionDeps = {
	browserAct,
	browserConsoleMessages,
	browserSnapshot,
	browserTabs,
	getRuntimeConfig,
	imageResultFromFile
};
const BROWSER_ACT_REQUEST_TIMEOUT_SLACK_MS = 5e3;
function normalizePositiveTimeoutMs(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function supportsBrowserActTimeout(request) {
	switch (request.kind) {
		case "click":
		case "type":
		case "hover":
		case "scrollIntoView":
		case "drag":
		case "select":
		case "fill":
		case "evaluate":
		case "wait": return true;
		default: return false;
	}
}
function existingSessionRejectsActTimeout(request) {
	switch (request.kind) {
		case "type":
		case "hover":
		case "scrollIntoView":
		case "drag":
		case "select":
		case "fill":
		case "evaluate": return true;
		default: return false;
	}
}
function usesExistingSessionProfile(profileName) {
	const cfg = browserToolActionDeps.getRuntimeConfig();
	const resolved = resolveBrowserConfig(cfg.browser, cfg);
	const profile = resolveProfile(resolved, profileName ?? resolved.defaultProfile);
	return profile ? getBrowserProfileCapabilities(profile).usesChromeMcp : false;
}
function withConfiguredActTimeout(request, profileName) {
	const typedRequest = request;
	if (normalizePositiveTimeoutMs(typedRequest.timeoutMs) !== void 0) return request;
	if (!supportsBrowserActTimeout(request)) return request;
	if (existingSessionRejectsActTimeout(request) && usesExistingSessionProfile(profileName)) return request;
	const configuredTimeout = normalizePositiveTimeoutMs(browserToolActionDeps.getRuntimeConfig().browser?.actionTimeoutMs) ?? 6e4;
	return {
		...typedRequest,
		timeoutMs: configuredTimeout
	};
}
function resolveActProxyTimeoutMs(request) {
	const candidateTimeouts = [];
	const explicitTimeout = normalizePositiveTimeoutMs(request.timeoutMs);
	if (explicitTimeout !== void 0) candidateTimeouts.push(explicitTimeout + BROWSER_ACT_REQUEST_TIMEOUT_SLACK_MS);
	if (request.kind === "wait") {
		const waitDuration = normalizePositiveTimeoutMs(request.timeMs);
		if (waitDuration !== void 0) candidateTimeouts.push(waitDuration + BROWSER_ACT_REQUEST_TIMEOUT_SLACK_MS);
	}
	return candidateTimeouts.length ? Math.max(...candidateTimeouts) : void 0;
}
function formatAgentTab(tab) {
	if (!tab || typeof tab !== "object") return { value: tab };
	const source = tab;
	const targetId = readStringValue(source.targetId);
	const tabId = readStringValue(source.tabId);
	const label = readStringValue(source.label);
	const suggestedTargetId = readStringValue(source.suggestedTargetId) ?? label ?? tabId ?? targetId;
	return {
		...suggestedTargetId ? { suggestedTargetId } : {},
		...tabId ? { tabId } : {},
		...label ? { label } : {},
		title: source.title,
		url: source.url,
		type: source.type,
		...targetId ? { targetId } : {},
		...source.wsUrl ? { wsUrl: source.wsUrl } : {}
	};
}
function wrapBrowserExternalJson(params) {
	return {
		wrappedText: wrapExternalContent(JSON.stringify(params.payload, null, 2), {
			source: "browser",
			includeWarning: params.includeWarning ?? true
		}),
		safeDetails: {
			ok: true,
			externalContent: {
				untrusted: true,
				source: "browser",
				kind: params.kind,
				wrapped: true
			}
		}
	};
}
function formatTabsToolResult(tabs) {
	const formattedTabs = tabs.map((tab) => formatAgentTab(tab));
	const wrapped = wrapBrowserExternalJson({
		kind: "tabs",
		payload: { tabs: formattedTabs },
		includeWarning: false
	});
	return {
		content: [{
			type: "text",
			text: wrapped.wrappedText
		}],
		details: {
			...wrapped.safeDetails,
			tabCount: tabs.length,
			tabs: formattedTabs
		}
	};
}
function formatConsoleToolResult(result) {
	const wrapped = wrapBrowserExternalJson({
		kind: "console",
		payload: result,
		includeWarning: false
	});
	return {
		content: [{
			type: "text",
			text: wrapped.wrappedText
		}],
		details: {
			...wrapped.safeDetails,
			targetId: readStringValue(result.targetId),
			url: readStringValue(result.url),
			messageCount: Array.isArray(result.messages) ? result.messages.length : void 0
		}
	};
}
function isChromeStaleTargetError(profile, err) {
	if (!profile) return false;
	if (profile === "user") {
		const msg = String(err);
		return msg.includes("404:") && msg.includes("tab not found");
	}
	const cfg = browserToolActionDeps.getRuntimeConfig();
	const browserProfile = resolveProfile(resolveBrowserConfig(cfg.browser, cfg), profile);
	if (!browserProfile || !getBrowserProfileCapabilities(browserProfile).usesChromeMcp) return false;
	const msg = String(err);
	return msg.includes("404:") && msg.includes("tab not found");
}
function stripTargetIdFromActRequest(request) {
	if (!normalizeOptionalString(request.targetId)) return null;
	const retryRequest = { ...request };
	delete retryRequest.targetId;
	return retryRequest;
}
function canRetryChromeActWithoutTargetId(request) {
	const typedRequest = request;
	const kind = typeof typedRequest.kind === "string" ? typedRequest.kind : typeof typedRequest.action === "string" ? typedRequest.action : "";
	return kind === "hover" || kind === "scrollIntoView" || kind === "wait";
}
function isAriaRefsUnsupportedError(err) {
	const msg = String(err).toLowerCase();
	return msg.includes("refs=aria") && msg.includes("not support");
}
function withRoleRefsFallback(snapshotQuery) {
	return {
		...snapshotQuery,
		refs: "role"
	};
}
async function executeTabsAction(params) {
	const { baseUrl, profile, timeoutMs, proxyRequest } = params;
	if (proxyRequest) return formatTabsToolResult((await proxyRequest({
		method: "GET",
		path: "/tabs",
		profile,
		timeoutMs
	})).tabs ?? []);
	return formatTabsToolResult(await browserToolActionDeps.browserTabs(baseUrl, {
		profile,
		timeoutMs
	}));
}
async function executeSnapshotAction(params) {
	const { input, baseUrl, profile, proxyRequest } = params;
	const snapshotDefaults = browserToolActionDeps.getRuntimeConfig().browser?.snapshotDefaults;
	const format = input.snapshotFormat === "ai" ? "ai" : input.snapshotFormat === "aria" ? "aria" : void 0;
	const formatExplicit = format !== void 0;
	const mode = input.mode === "efficient" ? "efficient" : !formatExplicit && format !== "aria" && snapshotDefaults?.mode === "efficient" ? "efficient" : void 0;
	const labels = typeof input.labels === "boolean" ? input.labels : void 0;
	const urls = typeof input.urls === "boolean" ? input.urls : void 0;
	const refs = input.refs === "aria" || input.refs === "role" ? input.refs : void 0;
	const hasMaxChars = Object.hasOwn(input, "maxChars");
	const targetId = normalizeOptionalString(input.targetId);
	const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : void 0;
	const maxChars = typeof input.maxChars === "number" && Number.isFinite(input.maxChars) && input.maxChars > 0 ? Math.floor(input.maxChars) : void 0;
	const interactive = typeof input.interactive === "boolean" ? input.interactive : void 0;
	const compact = typeof input.compact === "boolean" ? input.compact : void 0;
	const depth = typeof input.depth === "number" && Number.isFinite(input.depth) ? input.depth : void 0;
	const selector = normalizeOptionalString(input.selector);
	const frame = normalizeOptionalString(input.frame);
	const resolvedMaxChars = format === "ai" ? hasMaxChars ? maxChars : mode === "efficient" ? void 0 : DEFAULT_AI_SNAPSHOT_MAX_CHARS : hasMaxChars ? maxChars : void 0;
	const snapshotQuery = {
		...format ? { format } : {},
		targetId,
		limit,
		...typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {},
		refs,
		interactive,
		compact,
		depth,
		selector,
		frame,
		labels,
		urls,
		mode
	};
	let refsFallback;
	const readSnapshot = async (query) => proxyRequest ? await proxyRequest({
		method: "GET",
		path: "/snapshot",
		profile,
		query
	}) : await browserToolActionDeps.browserSnapshot(baseUrl, {
		...query,
		profile
	});
	let snapshot;
	try {
		snapshot = await readSnapshot(snapshotQuery);
	} catch (err) {
		if (refs !== "aria" || !isAriaRefsUnsupportedError(err)) throw err;
		refsFallback = "role";
		snapshot = await readSnapshot(withRoleRefsFallback(snapshotQuery));
	}
	params.onTabActivity?.(readStringValue(snapshot.targetId) ?? targetId);
	if (snapshot.format === "ai") {
		const dialogStateFields = {
			...snapshot.blockedByDialog ? { blockedByDialog: true } : {},
			...snapshot.browserState !== void 0 ? { browserState: snapshot.browserState } : {}
		};
		if (snapshot.blockedByDialog) {
			const wrapped = wrapBrowserExternalJson({
				kind: "snapshot",
				payload: {
					format: snapshot.format,
					targetId: snapshot.targetId,
					url: snapshot.url,
					...dialogStateFields
				}
			});
			return {
				content: [{
					type: "text",
					text: wrapped.wrappedText
				}],
				details: {
					...wrapped.safeDetails,
					format: snapshot.format,
					targetId: snapshot.targetId,
					url: snapshot.url,
					...dialogStateFields
				}
			};
		}
		const wrappedSnapshot = wrapExternalContent(snapshot.snapshot ?? "", {
			source: "browser",
			includeWarning: true
		});
		const safeDetails = {
			ok: true,
			format: snapshot.format,
			targetId: snapshot.targetId,
			url: snapshot.url,
			truncated: snapshot.truncated,
			stats: snapshot.stats,
			refs: snapshot.refs ? Object.keys(snapshot.refs).length : void 0,
			labels: snapshot.labels,
			labelsCount: snapshot.labelsCount,
			labelsSkipped: snapshot.labelsSkipped,
			imagePath: snapshot.imagePath,
			imageType: snapshot.imageType,
			refsFallback,
			...dialogStateFields,
			externalContent: {
				untrusted: true,
				source: "browser",
				kind: "snapshot",
				format: "ai",
				wrapped: true
			}
		};
		if (labels && snapshot.imagePath) return await browserToolActionDeps.imageResultFromFile({
			label: "browser:snapshot",
			path: snapshot.imagePath,
			extraText: wrappedSnapshot,
			details: safeDetails,
			imageSanitization: resolveRuntimeImageSanitization()
		});
		return {
			content: [{
				type: "text",
				text: wrappedSnapshot
			}],
			details: safeDetails
		};
	}
	{
		const wrapped = wrapBrowserExternalJson({
			kind: "snapshot",
			payload: snapshot
		});
		return {
			content: [{
				type: "text",
				text: wrapped.wrappedText
			}],
			details: {
				...wrapped.safeDetails,
				format: "aria",
				targetId: snapshot.targetId,
				url: snapshot.url,
				nodeCount: snapshot.nodes.length,
				...snapshot.blockedByDialog ? { blockedByDialog: true } : {},
				...snapshot.browserState !== void 0 ? { browserState: snapshot.browserState } : {},
				externalContent: {
					untrusted: true,
					source: "browser",
					kind: "snapshot",
					format: "aria",
					wrapped: true
				}
			}
		};
	}
}
async function executeConsoleAction(params) {
	const { input, baseUrl, profile, proxyRequest } = params;
	const level = normalizeOptionalString(input.level);
	const targetId = normalizeOptionalString(input.targetId);
	if (proxyRequest) return formatConsoleToolResult(await proxyRequest({
		method: "GET",
		path: "/console",
		profile,
		query: {
			level,
			targetId
		}
	}));
	return formatConsoleToolResult(await browserToolActionDeps.browserConsoleMessages(baseUrl, {
		level,
		targetId,
		profile
	}));
}
async function executeActAction(params) {
	const { request, baseUrl, profile, proxyRequest } = params;
	const effectiveRequest = withConfiguredActTimeout(request, profile);
	try {
		const result = proxyRequest ? await proxyRequest({
			method: "POST",
			path: "/act",
			profile,
			body: effectiveRequest,
			timeoutMs: resolveActProxyTimeoutMs(effectiveRequest)
		}) : await browserToolActionDeps.browserAct(baseUrl, effectiveRequest, { profile });
		params.onTabActivity?.(readStringValue(result.targetId) ?? readStringValue(effectiveRequest.targetId));
		return jsonResult(result);
	} catch (err) {
		if (isChromeStaleTargetError(profile, err)) {
			const retryRequest = stripTargetIdFromActRequest(effectiveRequest);
			const tabs = proxyRequest ? (await proxyRequest({
				method: "GET",
				path: "/tabs",
				profile
			})).tabs ?? [] : await browserToolActionDeps.browserTabs(baseUrl, { profile }).catch(() => []);
			if (retryRequest && canRetryChromeActWithoutTargetId(effectiveRequest) && tabs.length === 1) try {
				const retryResult = proxyRequest ? await proxyRequest({
					method: "POST",
					path: "/act",
					profile,
					body: retryRequest,
					timeoutMs: resolveActProxyTimeoutMs(retryRequest)
				}) : await browserToolActionDeps.browserAct(baseUrl, retryRequest, { profile });
				params.onTabActivity?.(readStringValue(retryResult.targetId) ?? readStringValue(retryRequest.targetId));
				return jsonResult(retryResult);
			} catch {}
			if (!tabs.length) throw new Error(`No browser tabs found for profile="${profile}". Make sure the configured Chromium-based browser (v144+) is running and has open tabs, then retry.`, { cause: err });
			throw new Error(`Chrome tab not found (stale targetId?). Run action=tabs profile="${profile}" and use one of the returned targetIds.`, { cause: err });
		}
		throw err;
	}
}
//#endregion
//#region extensions/browser/src/browser-tool.ts
const browserToolDeps = {
	browserAct,
	browserArmDialog,
	browserArmFileChooser,
	browserCloseTab,
	browserDoctor,
	browserFocusTab,
	browserNavigate,
	browserOpenTab,
	browserPdfSave,
	browserProfiles,
	browserScreenshotAction,
	browserStart,
	browserStatus,
	browserStop,
	getRuntimeConfig,
	imageResultFromFile,
	listNodes,
	callGatewayTool,
	touchSessionBrowserTab,
	trackSessionBrowserTab,
	untrackSessionBrowserTab
};
function readOptionalTargetAndTimeout(params) {
	return {
		targetId: normalizeOptionalString(params.targetId),
		timeoutMs: typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? params.timeoutMs : void 0
	};
}
function readTargetUrlParam(params) {
	return readStringParam(params, "targetUrl") ?? readStringParam(params, "url", {
		required: true,
		label: "targetUrl"
	});
}
const LEGACY_BROWSER_ACT_REQUEST_KEYS = [
	"targetId",
	"ref",
	"doubleClick",
	"button",
	"modifiers",
	"x",
	"y",
	"text",
	"submit",
	"slowly",
	"key",
	"delayMs",
	"startRef",
	"endRef",
	"values",
	"fields",
	"width",
	"height",
	"timeMs",
	"textGone",
	"selector",
	"url",
	"loadState",
	"fn",
	"timeoutMs"
];
function readActRequestParam(params) {
	const requestParam = params.request;
	if (requestParam && typeof requestParam === "object") return requestParam;
	const kind = readStringParam(params, "kind");
	if (!kind) return;
	const request = { kind };
	for (const key of LEGACY_BROWSER_ACT_REQUEST_KEYS) {
		if (!Object.hasOwn(params, key)) continue;
		request[key] = params[key];
	}
	return request;
}
const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 2e4;
const BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS = 5e3;
function isBrowserNode$1(node) {
	const caps = Array.isArray(node.caps) ? node.caps : [];
	const commands = Array.isArray(node.commands) ? node.commands : [];
	return caps.includes("browser") || commands.includes("browser.proxy");
}
async function resolveBrowserNodeTarget$1(params) {
	const policy = browserToolDeps.getRuntimeConfig().gateway?.nodes?.browser;
	const mode = policy?.mode ?? "auto";
	if (mode === "off") {
		if (params.target === "node" || params.requestedNode) throw new Error("Node browser proxy is disabled (gateway.nodes.browser.mode=off).");
		return null;
	}
	if (params.sandboxBridgeUrl?.trim() && params.target !== "node" && !params.requestedNode) return null;
	if (params.target && params.target !== "node") return null;
	if (mode === "manual" && params.target !== "node" && !params.requestedNode) return null;
	const browserNodes = (await browserToolDeps.listNodes({})).filter((node) => node.connected && isBrowserNode$1(node));
	if (browserNodes.length === 0) {
		if (params.target === "node" || params.requestedNode) throw new Error("No connected browser-capable nodes.");
		return null;
	}
	const requested = params.requestedNode?.trim() || policy?.node?.trim();
	if (requested) {
		const nodeId = resolveNodeIdFromList(browserNodes, requested, false);
		const node = browserNodes.find((entry) => entry.nodeId === nodeId);
		return {
			nodeId,
			label: node?.displayName ?? node?.remoteIp ?? nodeId
		};
	}
	const selected = selectDefaultNodeFromList(browserNodes, {
		preferLocalMac: false,
		fallback: "none"
	});
	if (params.target === "node") {
		if (selected) return {
			nodeId: selected.nodeId,
			label: selected.displayName ?? selected.remoteIp ?? selected.nodeId
		};
		throw new Error(`Multiple browser-capable nodes connected (${browserNodes.length}). Set gateway.nodes.browser.node or pass node=<id>.`);
	}
	if (mode === "manual") return null;
	if (selected) return {
		nodeId: selected.nodeId,
		label: selected.displayName ?? selected.remoteIp ?? selected.nodeId
	};
	return null;
}
async function callBrowserProxy(params) {
	const proxyTimeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? Math.max(1, Math.floor(params.timeoutMs)) : DEFAULT_BROWSER_PROXY_TIMEOUT_MS;
	const gatewayTimeoutMs = proxyTimeoutMs + BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS;
	const parsed = unwrapBrowserProxyPayload(await browserToolDeps.callGatewayTool("node.invoke", { timeoutMs: gatewayTimeoutMs }, {
		nodeId: params.nodeId,
		command: "browser.proxy",
		params: {
			method: params.method,
			path: params.path,
			query: params.query,
			body: params.body,
			timeoutMs: proxyTimeoutMs,
			profile: params.profile
		},
		idempotencyKey: crypto.randomUUID()
	}));
	if (!parsed || typeof parsed !== "object" || !("result" in parsed)) throw new Error("browser proxy failed");
	return parsed;
}
function unwrapBrowserProxyPayload(payload) {
	if (payload?.payload !== void 0) return payload.payload;
	if (typeof payload?.payloadJSON !== "string" || !payload.payloadJSON.trim()) return null;
	try {
		return JSON.parse(payload.payloadJSON);
	} catch {
		return null;
	}
}
async function persistProxyFiles$1(files) {
	return await persistBrowserProxyFiles(files);
}
function applyProxyPaths$1(result, mapping) {
	applyBrowserProxyPaths(result, mapping);
}
function resolveBrowserBaseUrl(params) {
	const cfg = getRuntimeConfig();
	const resolved = resolveBrowserConfig(cfg.browser, cfg);
	const normalizedSandbox = params.sandboxBridgeUrl?.trim() ?? "";
	if ((params.target ?? (normalizedSandbox ? "sandbox" : "host")) === "sandbox") {
		if (!normalizedSandbox) throw new Error("Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target=\"host\" if allowed.");
		return normalizedSandbox.replace(/\/$/, "");
	}
	if (params.allowHostControl === false) throw new Error("Host browser control is disabled by sandbox policy.");
	if (!resolved.enabled) throw new Error("Browser control is disabled. Set browser.enabled=true in ~/.openclaw/openclaw.json.");
}
function shouldPreferHostForProfile(profileName) {
	if (!profileName) return false;
	const cfg = browserToolDeps.getRuntimeConfig();
	const profile = resolveProfile(resolveBrowserConfig(cfg.browser, cfg), profileName);
	if (!profile) return false;
	return getBrowserProfileCapabilities(profile).usesChromeMcp;
}
const DEFAULT_EXISTING_SESSION_MANAGE_TIMEOUT_MS = 45e3;
const EXISTING_SESSION_MANAGE_ACTIONS = new Set([
	"status",
	"start",
	"stop",
	"profiles",
	"tabs",
	"open",
	"focus",
	"close"
]);
function usesExistingSessionManageFlow(params) {
	if (!EXISTING_SESSION_MANAGE_ACTIONS.has(params.action)) return false;
	const cfg = browserToolDeps.getRuntimeConfig();
	const resolved = resolveBrowserConfig(cfg.browser, cfg);
	const profile = resolveProfile(resolved, params.profileName ?? resolved.defaultProfile);
	if (profile && getBrowserProfileCapabilities(profile).usesChromeMcp) return true;
	if (params.action !== "profiles") return false;
	return Object.keys(resolved.profiles).some((name) => {
		const candidate = resolveProfile(resolved, name);
		return candidate ? getBrowserProfileCapabilities(candidate).usesChromeMcp : false;
	});
}
function readToolTimeoutMs(params) {
	return typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? Math.max(1, Math.floor(params.timeoutMs)) : void 0;
}
function createBrowserTool(opts) {
	const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
	const hostHint = opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
	return {
		label: "Browser",
		name: "browser",
		description: [
			"Control the browser via OpenClaw's browser control server (status/start/stop/profiles/tabs/open/snapshot/screenshot/actions).",
			"Browser choice: omit profile by default for the isolated OpenClaw-managed browser (`openclaw`).",
			"For the logged-in user browser, use profile=\"user\". A supported Chromium-based browser (v144+) must be running on the selected host or browser node. Use only when existing logins/cookies matter and the user is present.",
			"For profile=\"user\" or other existing-session profiles, omit timeoutMs on act:type, evaluate, hover, scrollIntoView, drag, select, and fill; that driver rejects per-call timeout overrides for those actions.",
			"When a node-hosted browser proxy is available, the tool may auto-route to it. Pin a node with node=<id|name> or target=\"node\".",
			"When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (act/click/type/etc). For tab operations, targetId also accepts tabId handles (t1) and labels from action=tabs.",
			"For multi-step browser work, login checks, stale refs, duplicate tabs, or Google Meet flows, use the bundled browser-automation skill when it is available.",
			"For stable, self-resolving refs across calls, use snapshot with refs=\"aria\" (Playwright aria-ref ids). Default refs=\"role\" are role+name-based.",
			"Use snapshot+act for UI automation. Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
			`target selects browser location (sandbox|host|node). Default: ${targetDefault}.`,
			hostHint
		].join(" "),
		parameters: BrowserToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const action = readStringParam(params, "action", { required: true });
			const profile = readStringParam(params, "profile");
			const requestedNode = readStringParam(params, "node");
			const requestedTimeoutMs = readToolTimeoutMs(params);
			let target = readStringParam(params, "target");
			const configuredNode = browserToolDeps.getRuntimeConfig().gateway?.nodes?.browser?.node?.trim();
			if (requestedNode && target && target !== "node") throw new Error("node is only supported with target=\"node\".");
			const isUserBrowserProfile = shouldPreferHostForProfile(profile);
			if (isUserBrowserProfile) {
				if (target === "sandbox") throw new Error(`profile="${profile}" cannot use the sandbox browser; use target="host" or omit target.`);
			}
			let nodeTarget = null;
			try {
				nodeTarget = await resolveBrowserNodeTarget$1({
					requestedNode: requestedNode ?? void 0,
					target,
					sandboxBridgeUrl: opts?.sandboxBridgeUrl
				});
			} catch (error) {
				if (!(isUserBrowserProfile && !target && !requestedNode && !configuredNode)) throw error;
			}
			if (isUserBrowserProfile && !target && !requestedNode && !nodeTarget) target = "host";
			const baseUrl = nodeTarget ? void 0 : resolveBrowserBaseUrl({
				target: target === "node" ? void 0 : target,
				sandboxBridgeUrl: opts?.sandboxBridgeUrl,
				allowHostControl: opts?.allowHostControl
			});
			const proxyRequest = nodeTarget ? async (opts) => {
				const proxy = await callBrowserProxy({
					nodeId: nodeTarget.nodeId,
					method: opts.method,
					path: opts.path,
					query: opts.query,
					body: opts.body,
					timeoutMs: opts.timeoutMs,
					profile: opts.profile
				});
				const mapping = await persistProxyFiles$1(proxy.files);
				applyProxyPaths$1(proxy.result, mapping);
				return proxy.result;
			} : null;
			const toolTimeoutMs = requestedTimeoutMs ?? (usesExistingSessionManageFlow({
				action,
				profileName: profile
			}) ? DEFAULT_EXISTING_SESSION_MANAGE_TIMEOUT_MS : void 0);
			const touchTrackedTab = (targetId) => {
				if (proxyRequest || !targetId) return;
				browserToolDeps.touchSessionBrowserTab({
					sessionKey: opts?.agentSessionKey,
					targetId,
					baseUrl,
					profile
				});
			};
			switch (action) {
				case "doctor":
					if (proxyRequest) return jsonResult(await proxyRequest({
						method: "GET",
						path: "/doctor",
						profile
					}));
					return jsonResult(await browserToolDeps.browserDoctor(baseUrl, { profile }));
				case "status":
					if (proxyRequest) return jsonResult(await proxyRequest({
						method: "GET",
						path: "/",
						profile,
						timeoutMs: toolTimeoutMs
					}));
					return jsonResult(await browserToolDeps.browserStatus(baseUrl, {
						profile,
						timeoutMs: toolTimeoutMs
					}));
				case "start":
					if (proxyRequest) {
						await proxyRequest({
							method: "POST",
							path: "/start",
							profile,
							timeoutMs: toolTimeoutMs
						});
						return jsonResult(await proxyRequest({
							method: "GET",
							path: "/",
							profile,
							timeoutMs: toolTimeoutMs
						}));
					}
					await browserToolDeps.browserStart(baseUrl, {
						profile,
						timeoutMs: toolTimeoutMs
					});
					return jsonResult(await browserToolDeps.browserStatus(baseUrl, {
						profile,
						timeoutMs: toolTimeoutMs
					}));
				case "stop":
					if (proxyRequest) {
						await proxyRequest({
							method: "POST",
							path: "/stop",
							profile,
							timeoutMs: toolTimeoutMs
						});
						return jsonResult(await proxyRequest({
							method: "GET",
							path: "/",
							profile,
							timeoutMs: toolTimeoutMs
						}));
					}
					await browserToolDeps.browserStop(baseUrl, {
						profile,
						timeoutMs: toolTimeoutMs
					});
					return jsonResult(await browserToolDeps.browserStatus(baseUrl, {
						profile,
						timeoutMs: toolTimeoutMs
					}));
				case "profiles":
					if (proxyRequest) return jsonResult(await proxyRequest({
						method: "GET",
						path: "/profiles",
						timeoutMs: toolTimeoutMs
					}));
					return jsonResult({ profiles: await browserToolDeps.browserProfiles(baseUrl, { timeoutMs: toolTimeoutMs }) });
				case "tabs": return await executeTabsAction({
					baseUrl,
					profile,
					timeoutMs: toolTimeoutMs,
					proxyRequest
				});
				case "open": {
					const targetUrl = readTargetUrlParam(params);
					const label = normalizeOptionalString(params.label);
					if (proxyRequest) return jsonResult(await proxyRequest({
						method: "POST",
						path: "/tabs/open",
						profile,
						body: {
							url: targetUrl,
							...label ? { label } : {}
						},
						timeoutMs: toolTimeoutMs
					}));
					const opened = await browserToolDeps.browserOpenTab(baseUrl, targetUrl, {
						profile,
						label,
						timeoutMs: toolTimeoutMs
					});
					browserToolDeps.trackSessionBrowserTab({
						sessionKey: opts?.agentSessionKey,
						targetId: opened.targetId,
						baseUrl,
						profile
					});
					return jsonResult(opened);
				}
				case "focus": {
					const targetId = readStringParam(params, "targetId", { required: true });
					if (proxyRequest) return jsonResult(await proxyRequest({
						method: "POST",
						path: "/tabs/focus",
						profile,
						body: { targetId },
						timeoutMs: toolTimeoutMs
					}));
					await browserToolDeps.browserFocusTab(baseUrl, targetId, {
						profile,
						timeoutMs: toolTimeoutMs
					});
					touchTrackedTab(targetId);
					return jsonResult({ ok: true });
				}
				case "close": {
					const targetId = readStringParam(params, "targetId");
					if (proxyRequest) return jsonResult(targetId ? await proxyRequest({
						method: "DELETE",
						path: `/tabs/${encodeURIComponent(targetId)}`,
						profile,
						timeoutMs: toolTimeoutMs
					}) : await proxyRequest({
						method: "POST",
						path: "/act",
						profile,
						body: { kind: "close" },
						timeoutMs: toolTimeoutMs
					}));
					if (targetId) {
						await browserToolDeps.browserCloseTab(baseUrl, targetId, {
							profile,
							timeoutMs: toolTimeoutMs
						});
						browserToolDeps.untrackSessionBrowserTab({
							sessionKey: opts?.agentSessionKey,
							targetId,
							baseUrl,
							profile
						});
					} else await browserToolDeps.browserAct(baseUrl, { kind: "close" }, {
						profile,
						timeoutMs: toolTimeoutMs
					});
					return jsonResult({ ok: true });
				}
				case "snapshot": return await executeSnapshotAction({
					input: params,
					baseUrl,
					profile,
					proxyRequest,
					onTabActivity: touchTrackedTab
				});
				case "screenshot": {
					const targetId = readStringParam(params, "targetId");
					const fullPage = Boolean(params.fullPage);
					const ref = readStringParam(params, "ref");
					const element = readStringParam(params, "element");
					const labels = typeof params.labels === "boolean" ? params.labels : void 0;
					const type = params.type === "jpeg" ? "jpeg" : "png";
					const effectiveTimeoutMs = (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? Math.max(1, Math.floor(params.timeoutMs)) : void 0) ?? 2e4;
					const result = proxyRequest ? await proxyRequest({
						method: "POST",
						path: "/screenshot",
						profile,
						timeoutMs: effectiveTimeoutMs,
						body: {
							targetId,
							fullPage,
							ref,
							element,
							type,
							labels,
							timeoutMs: effectiveTimeoutMs
						}
					}) : await browserToolDeps.browserScreenshotAction(baseUrl, {
						targetId,
						fullPage,
						ref,
						element,
						type,
						labels,
						timeoutMs: effectiveTimeoutMs,
						profile
					});
					touchTrackedTab(readStringValue(result.targetId) ?? targetId);
					return await browserToolDeps.imageResultFromFile({
						label: "browser:screenshot",
						path: result.path,
						details: result,
						imageSanitization: resolveRuntimeImageSanitization()
					});
				}
				case "navigate": {
					const targetUrl = readTargetUrlParam(params);
					const targetId = readStringParam(params, "targetId");
					if (proxyRequest) return jsonResult(await proxyRequest({
						method: "POST",
						path: "/navigate",
						profile,
						body: {
							url: targetUrl,
							targetId
						}
					}));
					const result = await browserToolDeps.browserNavigate(baseUrl, {
						url: targetUrl,
						targetId,
						profile
					});
					touchTrackedTab(readStringValue(result.targetId) ?? targetId);
					return jsonResult(result);
				}
				case "console": return await executeConsoleAction({
					input: params,
					baseUrl,
					profile,
					proxyRequest
				});
				case "pdf": {
					const targetId = normalizeOptionalString(params.targetId);
					const result = proxyRequest ? await proxyRequest({
						method: "POST",
						path: "/pdf",
						profile,
						body: { targetId }
					}) : await browserToolDeps.browserPdfSave(baseUrl, {
						targetId,
						profile
					});
					touchTrackedTab(readStringValue(result.targetId) ?? targetId);
					return {
						content: [{
							type: "text",
							text: `FILE:${result.path}`
						}],
						details: result
					};
				}
				case "upload": {
					const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
					if (paths.length === 0) throw new Error("paths required");
					const uploadPathsResult = await resolveExistingPathsWithinRoot({
						rootDir: DEFAULT_UPLOAD_DIR,
						requestedPaths: paths,
						scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`
					});
					if (!uploadPathsResult.ok) throw new Error(uploadPathsResult.error);
					const normalizedPaths = uploadPathsResult.paths;
					const ref = readStringParam(params, "ref");
					const inputRef = readStringParam(params, "inputRef");
					const element = readStringParam(params, "element");
					const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
					if (proxyRequest) return jsonResult(await proxyRequest({
						method: "POST",
						path: "/hooks/file-chooser",
						profile,
						body: {
							paths: normalizedPaths,
							ref,
							inputRef,
							element,
							targetId,
							timeoutMs
						}
					}));
					const result = await browserToolDeps.browserArmFileChooser(baseUrl, {
						paths: normalizedPaths,
						ref,
						inputRef,
						element,
						targetId,
						timeoutMs,
						profile
					});
					touchTrackedTab(readStringValue(result.targetId) ?? targetId);
					return jsonResult(result);
				}
				case "dialog": {
					const accept = Boolean(params.accept);
					const promptText = readStringValue(params.promptText);
					const dialogId = readStringValue(params.dialogId);
					const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
					if (proxyRequest) return jsonResult(await proxyRequest({
						method: "POST",
						path: "/hooks/dialog",
						profile,
						body: {
							accept,
							promptText,
							dialogId,
							targetId,
							timeoutMs
						}
					}));
					const result = await browserToolDeps.browserArmDialog(baseUrl, {
						accept,
						promptText,
						dialogId,
						targetId,
						timeoutMs,
						profile
					});
					touchTrackedTab(readStringValue(result.targetId) ?? targetId);
					return jsonResult(result);
				}
				case "act": {
					const request = readActRequestParam(params);
					if (!request) throw new Error("request required");
					return await executeActAction({
						request,
						baseUrl,
						profile,
						proxyRequest,
						onTabActivity: touchTrackedTab
					});
				}
				default: throw new Error(`Unknown action: ${action}`);
			}
		}
	};
}
//#endregion
//#region extensions/browser/src/gateway/browser-request.ts
function isBrowserNode(node) {
	const caps = Array.isArray(node.caps) ? node.caps : [];
	const commands = Array.isArray(node.commands) ? node.commands : [];
	return caps.includes("browser") || commands.includes("browser.proxy");
}
function normalizeNodeKey(value) {
	return normalizeLowercaseStringOrEmpty(value).replace(/[^a-z0-9]+/g, "");
}
function resolveBrowserNode(nodes, query) {
	const q = normalizeOptionalString(query) ?? "";
	if (!q) return null;
	const qNorm = normalizeNodeKey(q);
	const matches = nodes.filter((node) => {
		if (node.nodeId === q) return true;
		if (typeof node.remoteIp === "string" && node.remoteIp === q) return true;
		const name = typeof node.displayName === "string" ? node.displayName : "";
		if (name && normalizeNodeKey(name) === qNorm) return true;
		if (q.length >= 6 && node.nodeId.startsWith(q)) return true;
		return false;
	});
	if (matches.length === 1) return matches[0] ?? null;
	if (matches.length === 0) return null;
	throw new Error(`ambiguous node: ${q} (matches: ${matches.map((node) => node.displayName || node.remoteIp || node.nodeId).join(", ")})`);
}
function resolveBrowserNodeTarget(params) {
	const policy = params.cfg.gateway?.nodes?.browser;
	const mode = policy?.mode ?? "auto";
	if (mode === "off") return null;
	const browserNodes = params.nodes.filter((node) => isBrowserNode(node));
	if (browserNodes.length === 0) {
		if (normalizeOptionalString(policy?.node)) throw new Error("No connected browser-capable nodes.");
		return null;
	}
	const requested = normalizeOptionalString(policy?.node) ?? "";
	if (requested) {
		const resolved = resolveBrowserNode(browserNodes, requested);
		if (!resolved) throw new Error(`Configured browser node not connected: ${requested}`);
		return resolved;
	}
	if (mode === "manual") return null;
	if (browserNodes.length === 1) return browserNodes[0] ?? null;
	return null;
}
async function persistProxyFiles(files) {
	return await persistBrowserProxyFiles(files);
}
function applyProxyPaths(result, mapping) {
	applyBrowserProxyPaths(result, mapping);
}
async function handleBrowserGatewayRequest({ params, respond, context }) {
	const typed = params;
	const methodRaw = (normalizeOptionalString(typed.method) ?? "").toUpperCase();
	const path = normalizeOptionalString(typed.path) ?? "";
	const query = typed.query && typeof typed.query === "object" ? typed.query : void 0;
	const body = typed.body;
	const timeoutMs = typeof typed.timeoutMs === "number" && Number.isFinite(typed.timeoutMs) ? Math.max(1, Math.floor(typed.timeoutMs)) : void 0;
	if (!methodRaw || !path) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "method and path are required"));
		return;
	}
	if (methodRaw !== "GET" && methodRaw !== "POST" && methodRaw !== "DELETE") {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "method must be GET, POST, or DELETE"));
		return;
	}
	if (isPersistentBrowserProfileMutation(methodRaw, path)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "browser.request cannot mutate persistent browser profiles"));
		return;
	}
	const cfg = getRuntimeConfig();
	let nodeTarget = null;
	try {
		nodeTarget = resolveBrowserNodeTarget({
			cfg,
			nodes: context.nodeRegistry.listConnected()
		});
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
		return;
	}
	if (nodeTarget) {
		const allowlist = resolveNodeCommandAllowlist(cfg, nodeTarget);
		const allowed = isNodeCommandAllowed({
			command: "browser.proxy",
			declaredCommands: nodeTarget.commands,
			allowlist
		});
		if (!allowed.ok) {
			const platform = nodeTarget.platform ?? "unknown";
			const hint = `node command not allowed: ${allowed.reason} (platform: ${platform}, command: browser.proxy)`;
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, hint, { details: {
				reason: allowed.reason,
				command: "browser.proxy"
			} }));
			return;
		}
		const proxyParams = {
			method: methodRaw,
			path,
			query,
			body,
			timeoutMs,
			profile: resolveRequestedBrowserProfile({
				query,
				body
			})
		};
		const res = await context.nodeRegistry.invoke({
			nodeId: nodeTarget.nodeId,
			command: "browser.proxy",
			params: proxyParams,
			timeoutMs,
			idempotencyKey: crypto.randomUUID()
		});
		if (!respondUnavailableOnNodeInvokeError(respond, res)) return;
		const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
		const proxy = payload && typeof payload === "object" ? payload : null;
		if (!proxy || !("result" in proxy)) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "browser proxy failed"));
			return;
		}
		const mapping = await persistProxyFiles(proxy.files);
		applyProxyPaths(proxy.result, mapping);
		respond(true, proxy.result);
		return;
	}
	if (!await startBrowserControlServiceFromConfig()) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "browser control is disabled"));
		return;
	}
	let dispatcher;
	try {
		dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
		return;
	}
	let result;
	try {
		result = timeoutMs ? await withTimeout((signal) => dispatcher.dispatch({
			method: methodRaw,
			path,
			query,
			body,
			signal
		}), timeoutMs, "browser request") : await dispatcher.dispatch({
			method: methodRaw,
			path,
			query,
			body
		});
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
		return;
	}
	if (result.status >= 400) {
		const message = result.body && typeof result.body === "object" && "error" in result.body ? String(result.body.error) : `browser request failed (${result.status})`;
		respond(false, void 0, errorShape(result.status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST, message, { details: result.body }));
		return;
	}
	respond(true, result.body);
}
const browserHandlers = { "browser.request": handleBrowserGatewayRequest };
//#endregion
//#region extensions/browser/src/plugin-service.ts
const UNSAFE_BROWSER_CONTROL_OVERRIDE_SPECIFIER = /^(?:data|http|https|node):/i;
function validateBrowserControlOverrideSpecifier(specifier) {
	const trimmed = specifier.trim();
	if (UNSAFE_BROWSER_CONTROL_OVERRIDE_SPECIFIER.test(trimmed)) throw new Error(`Refusing unsafe browser control override specifier: ${trimmed}`);
	return trimmed;
}
function createBrowserPluginService() {
	let handle = null;
	return {
		id: "browser-control",
		start: async () => {
			if (handle) return;
			handle = await startLazyPluginServiceModule({
				skipEnvVar: "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
				overrideEnvVar: "OPENCLAW_BROWSER_CONTROL_MODULE",
				validateOverrideSpecifier: validateBrowserControlOverrideSpecifier,
				loadDefaultModule: async () => await import("./server-BrWAO6vY.js"),
				startExportNames: ["startBrowserControlServiceFromConfig", "startBrowserControlServerFromConfig"],
				stopExportNames: ["stopBrowserControlService", "stopBrowserControlServer"]
			});
		},
		stop: async () => {
			const current = handle;
			handle = null;
			if (!current) return;
			await current.stop().catch(() => {});
		}
	};
}
//#endregion
export { createBrowserTool as i, browserHandlers as n, handleBrowserGatewayRequest as r, createBrowserPluginService as t };
