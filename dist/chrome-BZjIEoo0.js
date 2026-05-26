import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { l as redactToolPayloadText, s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { t as CONFIG_DIR } from "./utils-sBTEdeml.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as isLoopbackHost } from "./net-DCUMtgJy.js";
import { r as ensurePortAvailable } from "./ports-C3z_VZTO.js";
import { r as saveJsonFile, t as loadJsonFile } from "./json-store-ChgPP2Sf.js";
import { t as prepareOomScoreAdjustedSpawn } from "./linux-oom-score-eO5nXmjv.js";
import { t as normalizeHostname } from "./hostname-DX6nIUV7.js";
import { _ as resolvePinnedHostnameWithPolicy, d as isPrivateNetworkAllowedByPolicy, p as matchesHostnameAllowlist } from "./ssrf-DdDeGa5L.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./process-runtime-Bice6fS7.js";
import { t as ensureAbsoluteDirectory } from "./sdk-security-runtime-C8OhDycR.js";
import { A as CHROME_LAUNCH_READY_WINDOW_MS, M as CHROME_STDERR_HINT_MAX_CHARS, N as CHROME_STOP_TIMEOUT_MS, O as CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS, b as BrowserProfileUnavailableError, c as isWebSocketUrl, f as redactCdpUrl, g as BrowserCdpEndpointBlockedError, i as fetchJson, k as CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS, l as normalizeCdpHttpBaseForJsonEndpoints, n as assertCdpEndpointAllowed, p as withCdpSocket, q as DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME, r as fetchCdpChecked, s as isDirectCdpWebSocketEndpoint, t as appendCdpPath, u as openCdpWebSocket } from "./cdp.helpers-D-78hr0t.js";
import { a as DEFAULT_DOWNLOAD_DIR, r as resolveManagedBrowserHeadlessMode, t as getManagedBrowserMissingDisplayError } from "./config-F211Ihcd.js";
import "./tmp-openclaw-dir-3NYlGVmB.js";
import { r as resolveBrowserExecutableForPlatform } from "./chrome.executables-C_GQZhm-.js";
import "./subsystem-CZs4Zera.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
//#region extensions/browser/src/browser/navigation-guard.ts
const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);
function isAllowedNonNetworkNavigationUrl(parsed) {
	return SAFE_NON_NETWORK_URLS.has(parsed.href);
}
function normalizeNavigationUrl(url) {
	return url.trim();
}
var InvalidBrowserNavigationUrlError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "InvalidBrowserNavigationUrlError";
	}
};
function withBrowserNavigationPolicy(ssrfPolicy, opts) {
	return {
		...ssrfPolicy ? { ssrfPolicy } : {},
		...opts?.browserProxyMode && opts.browserProxyMode !== "direct" ? { browserProxyMode: opts.browserProxyMode } : {}
	};
}
function requiresInspectableBrowserNavigationRedirects(ssrfPolicy) {
	return ssrfPolicy?.dangerouslyAllowPrivateNetwork === false;
}
function requiresInspectableBrowserNavigationRedirectsForUrl(url, ssrfPolicy) {
	if (!requiresInspectableBrowserNavigationRedirects(ssrfPolicy)) return false;
	try {
		const parsed = new URL(url);
		return NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol);
	} catch {
		return false;
	}
}
function isIpLiteralHostname(hostname) {
	return isIP(normalizeHostname(hostname)) !== 0;
}
function isExplicitlyAllowedBrowserHostname(hostname, ssrfPolicy) {
	const normalizedHostname = normalizeHostname(hostname);
	if ((ssrfPolicy?.allowedHostnames ?? []).some((value) => normalizeHostname(value) === normalizedHostname)) return true;
	const hostnameAllowlist = (ssrfPolicy?.hostnameAllowlist ?? []).map((pattern) => normalizeHostname(pattern)).filter(Boolean);
	return hostnameAllowlist.length > 0 ? matchesHostnameAllowlist(normalizedHostname, hostnameAllowlist) : false;
}
async function assertBrowserNavigationAllowed(opts) {
	const rawUrl = normalizeNavigationUrl(opts.url);
	if (!rawUrl) throw new InvalidBrowserNavigationUrlError("url is required");
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`);
	}
	if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
		if (isAllowedNonNetworkNavigationUrl(parsed)) return;
		throw new InvalidBrowserNavigationUrlError(`Navigation blocked: unsupported protocol "${parsed.protocol}"`);
	}
	if (opts.browserProxyMode === "explicit-browser-proxy" && !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)) throw new InvalidBrowserNavigationUrlError("Navigation blocked: strict browser SSRF policy cannot be enforced while this browser profile is proxy-routed");
	if (opts.ssrfPolicy && opts.ssrfPolicy.dangerouslyAllowPrivateNetwork === false && !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy) && !isIpLiteralHostname(parsed.hostname) && !isExplicitlyAllowedBrowserHostname(parsed.hostname, opts.ssrfPolicy)) throw new InvalidBrowserNavigationUrlError("Navigation blocked: strict browser SSRF policy requires an IP-literal URL because browser DNS rebinding protections are unavailable for hostname-based navigation");
	await resolvePinnedHostnameWithPolicy(parsed.hostname, {
		lookupFn: opts.lookupFn,
		policy: opts.ssrfPolicy
	});
}
/**
* Best-effort post-navigation guard for final page URLs.
* Only validates network URLs (http/https) and about:blank to avoid false
* positives on browser-internal error pages (e.g. chrome-error://). In strict
* mode this intentionally re-applies the hostname gate after redirects.
*/
async function assertBrowserNavigationResultAllowed(opts) {
	const rawUrl = normalizeNavigationUrl(opts.url);
	if (!rawUrl) return;
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return;
	}
	if (NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) || isAllowedNonNetworkNavigationUrl(parsed)) await assertBrowserNavigationAllowed(opts);
}
async function assertBrowserNavigationRedirectChainAllowed(opts) {
	const chain = [];
	let current = opts.request ?? null;
	while (current) {
		chain.push(current.url());
		current = current.redirectedFrom();
	}
	for (const url of chain.toReversed()) await assertBrowserNavigationAllowed({
		url,
		lookupFn: opts.lookupFn,
		ssrfPolicy: opts.ssrfPolicy,
		browserProxyMode: opts.browserProxyMode
	});
}
//#endregion
//#region extensions/browser/src/browser/browser-proxy-mode.ts
const PROXY_ROUTING_CHROME_ARGS = new Set([
	"--proxy-auto-detect",
	"--proxy-pac-url",
	"--proxy-server"
]);
const PROXY_CONTROL_CHROME_ARGS = new Set(["--no-proxy-server", ...PROXY_ROUTING_CHROME_ARGS]);
const CHROME_PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy"
];
function chromeArgName(arg) {
	return arg.trim().split("=", 1)[0]?.toLowerCase() ?? "";
}
function hasChromeProxyControlArg(args) {
	return args.some((arg) => PROXY_CONTROL_CHROME_ARGS.has(chromeArgName(arg)));
}
function hasExplicitChromeProxyRoutingArg(args) {
	return args.some((arg) => PROXY_ROUTING_CHROME_ARGS.has(chromeArgName(arg)));
}
function omitChromeProxyEnv(env) {
	const next = { ...env };
	for (const key of CHROME_PROXY_ENV_KEYS) delete next[key];
	return next;
}
function resolveBrowserNavigationProxyMode(params) {
	if (params.profile.driver === "openclaw" && params.profile.cdpIsLoopback && hasExplicitChromeProxyRoutingArg(params.resolved.extraArgs)) return "explicit-browser-proxy";
	return "direct";
}
//#endregion
//#region extensions/browser/src/browser/output-directories.ts
async function resolveSystemDirectoryAlias(dirPath) {
	for (const aliasRoot of ["/tmp", "/var"]) {
		if (dirPath !== aliasRoot && !dirPath.startsWith(`${aliasRoot}${path.sep}`)) continue;
		try {
			if (!(await fs$1.lstat(aliasRoot)).isSymbolicLink()) return dirPath;
			return path.join(await fs$1.realpath(aliasRoot), path.relative(aliasRoot, dirPath));
		} catch {
			return dirPath;
		}
	}
	return dirPath;
}
async function ensureOutputDirectory(dirPath) {
	const result = await ensureAbsoluteDirectory(await resolveSystemDirectoryAlias(path.resolve(dirPath)), { scopeLabel: "output directory" });
	if (!result.ok) throw result.error;
}
//#endregion
//#region extensions/browser/src/browser/snapshot-roles.ts
/**
* Shared ARIA role classification sets used by both the Playwright and Chrome MCP
* snapshot paths. Keep these in sync — divergence causes the two drivers to produce
* different snapshot output for the same page.
*/
/** Roles that represent user-interactive elements and always get a ref. */
const INTERACTIVE_ROLES = new Set([
	"button",
	"checkbox",
	"combobox",
	"link",
	"listbox",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"radio",
	"searchbox",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"textbox",
	"treeitem"
]);
/** Roles that carry meaningful content and get a ref when named. */
const CONTENT_ROLES = new Set([
	"article",
	"cell",
	"columnheader",
	"gridcell",
	"heading",
	"listitem",
	"main",
	"navigation",
	"region",
	"rowheader"
]);
/** Structural/container roles — typically skipped in compact mode. */
const STRUCTURAL_ROLES = new Set([
	"application",
	"directory",
	"document",
	"generic",
	"grid",
	"group",
	"ignored",
	"list",
	"menu",
	"menubar",
	"none",
	"presentation",
	"row",
	"rowgroup",
	"table",
	"tablist",
	"toolbar",
	"tree",
	"treegrid"
]);
//#endregion
//#region extensions/browser/src/browser/cdp.ts
function normalizeCdpWsUrl(wsUrl, cdpUrl) {
	const ws = new URL(wsUrl);
	const cdp = new URL(cdpUrl);
	const isWildcardBind = ws.hostname === "0.0.0.0" || ws.hostname === "[::]";
	if ((isLoopbackHost(ws.hostname) || isWildcardBind) && !isLoopbackHost(cdp.hostname)) {
		ws.hostname = cdp.hostname;
		const cdpPort = cdp.port || (cdp.protocol === "https:" ? "443" : "80");
		/* c8 ignore next 3 */
		if (cdpPort) ws.port = cdpPort;
		ws.protocol = cdp.protocol === "https:" ? "wss:" : "ws:";
	} else if (isLoopbackHost(ws.hostname) && isLoopbackHost(cdp.hostname)) ws.hostname = cdp.hostname;
	if (cdp.protocol === "https:" && ws.protocol === "ws:") ws.protocol = "wss:";
	if (!ws.username && !ws.password && (cdp.username || cdp.password)) {
		ws.username = cdp.username;
		ws.password = cdp.password;
	}
	for (const [key, value] of cdp.searchParams.entries()) if (!ws.searchParams.has(key)) ws.searchParams.append(key, value);
	return ws.toString();
}
async function captureScreenshot(opts) {
	return await withCdpSocket(opts.wsUrl, async (send) => {
		await send("Page.enable");
		let savedVp;
		if (opts.fullPage) {
			const metrics = await send("Page.getLayoutMetrics");
			const size = metrics?.cssContentSize ?? metrics?.contentSize;
			const contentWidth = size?.width ?? 0;
			const contentHeight = size?.height ?? 0;
			if (contentWidth > 0 && contentHeight > 0) {
				const v = (await send("Runtime.evaluate", {
					expression: "({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, sw: screen.width, sh: screen.height })",
					returnByValue: true
				}))?.result?.value;
				const currentW = v?.w ?? 0;
				const currentH = v?.h ?? 0;
				savedVp = {
					w: currentW,
					h: currentH,
					dpr: v?.dpr ?? 1,
					sw: v?.sw ?? currentW,
					sh: v?.sh ?? currentH
				};
				await send("Emulation.setDeviceMetricsOverride", {
					width: Math.ceil(Math.max(currentW, contentWidth)),
					height: Math.ceil(Math.max(currentH, contentHeight)),
					deviceScaleFactor: savedVp.dpr,
					mobile: false,
					screenWidth: savedVp.sw,
					screenHeight: savedVp.sh
				});
			}
		}
		const format = opts.format ?? "png";
		const quality = format === "jpeg" ? Math.max(0, Math.min(100, Math.round(opts.quality ?? 85))) : void 0;
		try {
			const base64 = (await send("Page.captureScreenshot", {
				format,
				...quality !== void 0 ? { quality } : {},
				...opts.fullPage ? { captureBeyondViewport: true } : {}
			}))?.data;
			if (!base64) throw new Error("Screenshot failed: missing data");
			return Buffer.from(base64, "base64");
		} finally {
			if (savedVp) {
				await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
				try {
					const p = (await send("Runtime.evaluate", {
						expression: "({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })",
						returnByValue: true
					}))?.result?.value;
					if (p?.w !== savedVp.w || p?.h !== savedVp.h || p?.dpr !== savedVp.dpr) await send("Emulation.setDeviceMetricsOverride", {
						width: savedVp.w,
						height: savedVp.h,
						deviceScaleFactor: savedVp.dpr,
						mobile: false,
						screenWidth: savedVp.sw,
						screenHeight: savedVp.sh
					});
				} catch {}
			}
		}
	}, { commandTimeoutMs: opts.timeoutMs });
}
async function createTargetViaCdp(opts) {
	await assertBrowserNavigationAllowed({
		url: opts.url,
		...withBrowserNavigationPolicy(opts.ssrfPolicy)
	});
	let wsUrl;
	if (isDirectCdpWebSocketEndpoint(opts.cdpUrl)) {
		await assertCdpEndpointAllowed(opts.cdpUrl, opts.ssrfPolicy);
		wsUrl = opts.cdpUrl;
	} else {
		const discoveryUrl = isWebSocketUrl(opts.cdpUrl) ? normalizeCdpHttpBaseForJsonEndpoints(opts.cdpUrl) : opts.cdpUrl;
		let version = null;
		try {
			version = await fetchJson(appendCdpPath(discoveryUrl, "/json/version"), opts.timeouts?.httpTimeoutMs, void 0, opts.ssrfPolicy);
		} catch (err) {
			if (!isWebSocketUrl(opts.cdpUrl)) throw err;
		}
		const wsUrlRaw = version?.webSocketDebuggerUrl?.trim() ?? "";
		if (wsUrlRaw) wsUrl = normalizeCdpWsUrl(wsUrlRaw, discoveryUrl);
		else if (isWebSocketUrl(opts.cdpUrl)) wsUrl = opts.cdpUrl;
		else throw new Error("CDP /json/version missing webSocketDebuggerUrl");
	}
	const candidateWsUrls = isWebSocketUrl(opts.cdpUrl) && wsUrl !== opts.cdpUrl ? [wsUrl, opts.cdpUrl] : [wsUrl];
	let lastError;
	for (const candidateWsUrl of candidateWsUrls) try {
		await assertCdpEndpointAllowed(candidateWsUrl, opts.ssrfPolicy);
		return await withCdpSocket(candidateWsUrl, async (send) => {
			const targetId = (await send("Target.createTarget", { url: opts.url }))?.targetId?.trim() ?? "";
			if (!targetId) throw new Error("CDP Target.createTarget returned no targetId");
			await prepareCdpTargetSession(send, targetId);
			return { targetId };
		}, {
			commandTimeoutMs: opts.timeouts?.httpTimeoutMs ?? 5e3,
			handshakeTimeoutMs: opts.timeouts?.handshakeTimeoutMs
		});
	} catch (err) {
		lastError = err;
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error("CDP Target.createTarget failed");
}
async function prepareCdpTargetSession(send, targetId) {
	const attached = await send("Target.attachToTarget", {
		targetId,
		flatten: true
	}).catch(() => null);
	const sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : void 0;
	if (!sessionId) return;
	try {
		await prepareCdpPageSession(send, sessionId);
	} finally {
		await send("Target.detachFromTarget", { sessionId }).catch(() => {});
	}
}
async function prepareCdpPageSession(send, sessionId) {
	await Promise.all([
		send("Page.enable", void 0, sessionId).catch(() => {}),
		send("Runtime.enable", void 0, sessionId).catch(() => {}),
		send("Network.enable", void 0, sessionId).catch(() => {}),
		send("DOM.enable", void 0, sessionId).catch(() => {}),
		send("Accessibility.enable", void 0, sessionId).catch(() => {})
	]);
	await send("Runtime.runIfWaitingForDebugger", void 0, sessionId).catch(() => {});
}
const AX_REF_PATTERN = new RegExp(`^ax\\d+$`);
function axValue(v) {
	if (!v || typeof v !== "object") return "";
	const value = v.value;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}
function formatAriaSnapshot(nodes, limit) {
	const byId = /* @__PURE__ */ new Map();
	for (const n of nodes) if (n.nodeId) byId.set(n.nodeId, n);
	const referenced = /* @__PURE__ */ new Set();
	for (const n of nodes) for (const c of n.childIds ?? []) referenced.add(c);
	const root = nodes.find((n) => n.nodeId && !referenced.has(n.nodeId)) ?? nodes[0];
	if (!root?.nodeId) return [];
	const out = [];
	const stack = [{
		id: root.nodeId,
		depth: 0
	}];
	while (stack.length && out.length < limit) {
		const popped = stack.pop();
		/* c8 ignore next 3 */
		if (!popped) break;
		const { id, depth } = popped;
		const n = byId.get(id);
		/* c8 ignore next 3 */
		if (!n) continue;
		const role = axValue(n.role);
		const name = axValue(n.name);
		const value = axValue(n.value);
		const description = axValue(n.description);
		const ref = `ax${out.length + 1}`;
		out.push({
			ref,
			role: role || "unknown",
			name: name || "",
			...value ? { value } : {},
			...description ? { description } : {},
			...typeof n.backendDOMNodeId === "number" ? { backendDOMNodeId: n.backendDOMNodeId } : {},
			depth
		});
		const children = (n.childIds ?? []).filter((c) => byId.has(c));
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			/* c8 ignore next 3 */
			if (child) stack.push({
				id: child,
				depth: depth + 1
			});
		}
	}
	return out;
}
async function snapshotAria(opts) {
	const limit = Math.max(1, Math.min(2e3, Math.floor(opts.limit ?? 500)));
	return await withCdpSocket(opts.wsUrl, async (send) => {
		await prepareCdpPageSession(send);
		const res = await send("Accessibility.getFullAXTree");
		return { nodes: formatAriaSnapshot(Array.isArray(res?.nodes) ? res.nodes : [], limit) };
	}, { commandTimeoutMs: opts.timeoutMs ?? 5e3 });
}
function buildRoleTree(nodes) {
	const byId = /* @__PURE__ */ new Map();
	const tree = [];
	for (const raw of nodes) {
		const nodeId = raw.nodeId ?? "";
		if (!nodeId) continue;
		byId.set(nodeId, tree.length);
		tree.push({
			raw,
			role: axValue(raw.role) || "unknown",
			name: axValue(raw.name),
			value: axValue(raw.value),
			backendDOMNodeId: typeof raw.backendDOMNodeId === "number" && raw.backendDOMNodeId > 0 ? Math.floor(raw.backendDOMNodeId) : void 0,
			children: [],
			depth: 0
		});
	}
	const childIndexes = /* @__PURE__ */ new Set();
	for (let index = 0; index < tree.length; index += 1) for (const childId of tree[index]?.raw.childIds ?? []) {
		const childIndex = byId.get(childId);
		if (childIndex === void 0) continue;
		tree[index]?.children.push(childIndex);
		tree[childIndex].parent = index;
		childIndexes.add(childIndex);
	}
	const roots = tree.map((_node, index) => index).filter((index) => !childIndexes.has(index));
	const stack = roots.map((index) => ({
		index,
		depth: 0
	}));
	while (stack.length) {
		const current = stack.pop();
		if (!current) break;
		tree[current.index].depth = current.depth;
		for (const child of (tree[current.index]?.children ?? []).toReversed()) stack.push({
			index: child,
			depth: current.depth + 1
		});
	}
	return {
		tree,
		roots: roots.length ? roots : tree.length ? [0] : []
	};
}
function shouldIncludeRoleNode(node, options) {
	const role = node.role.toLowerCase();
	if (options.maxDepth !== void 0 && node.depth > options.maxDepth) return false;
	if (options.interactive) return INTERACTIVE_ROLES.has(role) || role === "iframe" || Boolean(node.cursorInfo);
	if (options.compact && STRUCTURAL_ROLES.has(role) && !node.name && !node.ref) return false;
	return true;
}
function cursorSuffix(info) {
	if (!info) return "";
	const parts = [
		info.hasCursorPointer ? "cursor:pointer" : void 0,
		info.hasOnClick ? "onclick" : void 0,
		info.hasTabIndex ? "tabindex" : void 0,
		info.isEditable ? "contenteditable" : void 0,
		info.hiddenInputType ? `hidden-${info.hiddenInputType}` : void 0
	].filter(Boolean);
	return parts.length ? ` [${parts.join(", ")}]` : "";
}
function renderRoleTree(tree, index, output, options, indentOffset = 0) {
	const node = tree[index];
	if (!node) return;
	if (shouldIncludeRoleNode(node, options)) {
		const indent = "  ".repeat(Math.max(0, node.depth + indentOffset));
		const name = node.name ? ` "${node.name.replaceAll("\"", "\\\"")}"` : "";
		const ref = node.ref ? ` [ref=${node.ref}]` : "";
		const nth = node.nth !== void 0 && node.nth > 0 ? ` [nth=${node.nth}]` : "";
		const value = node.value ? ` value="${node.value.replaceAll("\"", "\\\"")}"` : "";
		const url = node.url ? ` [url=${node.url}]` : "";
		output.push(`${indent}- ${node.role}${name}${ref}${nth}${value}${url}${cursorSuffix(node.cursorInfo)}`);
	}
	for (const child of node.children) renderRoleTree(tree, child, output, options, indentOffset);
}
async function findCursorInteractiveElements(send, sessionId) {
	const attr = "data-openclaw-cdp-ci";
	const evaluated = await send("Runtime.evaluate", {
		expression: `(() => {
        const out = [];
        const roles = new Set(["button","link","textbox","checkbox","radio","combobox","listbox","menuitem","menuitemcheckbox","menuitemradio","option","searchbox","slider","spinbutton","switch","tab","treeitem"]);
        const tags = new Set(["a","button","input","select","textarea","details","summary"]);
        document.querySelectorAll("[${attr}]").forEach((el) => el.removeAttribute("${attr}"));
        for (const el of Array.from(document.body ? document.body.querySelectorAll("*") : [])) {
          if (!(el instanceof HTMLElement) || el.closest("[hidden],[aria-hidden='true']")) continue;
          const tagName = el.tagName.toLowerCase();
          if (tags.has(tagName)) continue;
          const role = String(el.getAttribute("role") || "").toLowerCase();
          if (roles.has(role)) continue;
          const style = getComputedStyle(el);
          const hasCursorPointer = style.cursor === "pointer";
          const hasOnClick = el.hasAttribute("onclick") || el.onclick !== null;
          const tabIndex = el.getAttribute("tabindex");
          const hasTabIndex = tabIndex !== null && tabIndex !== "-1";
          const ce = el.getAttribute("contenteditable");
          const isEditable = ce === "" || ce === "true";
          if (!hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable) continue;
          if (hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable) {
            const parent = el.parentElement;
            if (parent && getComputedStyle(parent).cursor === "pointer") continue;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          let hiddenInputType = "";
          const hiddenInput = el.querySelector("input[type='radio'],input[type='checkbox']");
          if (hiddenInput instanceof HTMLInputElement) {
            const hiddenStyle = getComputedStyle(hiddenInput);
            if (hiddenInput.hidden || hiddenStyle.display === "none" || hiddenStyle.visibility === "hidden") {
              hiddenInputType = hiddenInput.type;
            }
          }
          el.setAttribute("${attr}", String(out.length));
          out.push({
            text: String(el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 100),
            tagName,
            hasCursorPointer,
            hasOnClick,
            hasTabIndex,
            isEditable,
            hiddenInputType,
          });
        }
        return out;
      })()`,
		returnByValue: true,
		awaitPromise: false
	}, sessionId).catch(() => null);
	const entries = Array.isArray(evaluated?.result?.value) ? evaluated.result.value : [];
	if (!entries.length) return /* @__PURE__ */ new Map();
	const rootNodeId = (await send("DOM.getDocument", { depth: 0 }, sessionId).catch(() => null))?.root?.nodeId;
	if (typeof rootNodeId !== "number") return /* @__PURE__ */ new Map();
	const queried = await send("DOM.querySelectorAll", {
		nodeId: rootNodeId,
		selector: `[${attr}]`
	}, sessionId).catch(() => null);
	const out = /* @__PURE__ */ new Map();
	await Promise.all((queried?.nodeIds ?? []).map(async (nodeId) => {
		const described = await send("DOM.describeNode", { nodeId }, sessionId).catch(() => null);
		const attrs = described?.node?.attributes ?? [];
		const attrIndex = attrs.indexOf(attr);
		const rawIndex = attrIndex >= 0 ? attrs[attrIndex + 1] : void 0;
		const index = typeof rawIndex === "string" ? Number(rawIndex) : NaN;
		const backendNodeId = described?.node?.backendNodeId;
		if (typeof backendNodeId === "number" && Number.isInteger(index) && entries[index]) out.set(backendNodeId, entries[index]);
	}));
	await send("Runtime.evaluate", {
		expression: `document.querySelectorAll("[${attr}]").forEach((el) => el.removeAttribute("${attr}"))`,
		returnByValue: true
	}, sessionId).catch(() => {});
	return out;
}
async function resolveLinkUrls(send, refs, sessionId) {
	const out = /* @__PURE__ */ new Map();
	await Promise.all(Object.values(refs).map(async (ref) => {
		if (ref.role !== "link" || !ref.backendDOMNodeId) return;
		const objectId = (await send("DOM.resolveNode", { backendNodeId: ref.backendDOMNodeId }, sessionId).catch(() => null))?.object?.objectId;
		if (!objectId) return;
		const hrefResult = await send("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: "function() { return this.href || ''; }",
			returnByValue: true
		}, sessionId).catch(() => null);
		const href = typeof hrefResult?.result?.value === "string" ? hrefResult.result.value : "";
		if (href) out.set(ref.backendDOMNodeId, href);
	}));
	return out;
}
async function resolveIframeFrameIds(send, tree, sessionId) {
	const out = /* @__PURE__ */ new Map();
	await Promise.all(tree.map(async (node) => {
		if (node.role.toLowerCase() !== "iframe" || !node.backendDOMNodeId) return;
		const described = await send("DOM.describeNode", {
			backendNodeId: node.backendDOMNodeId,
			depth: 1
		}, sessionId).catch(() => null);
		const frameId = described?.node?.contentDocument?.frameId ?? described?.node?.frameId ?? "";
		if (frameId) out.set(node.backendDOMNodeId, frameId);
	}));
	return out;
}
async function buildCdpRoleSnapshot(params) {
	const res = await params.send("Accessibility.getFullAXTree", params.frameId ? { frameId: params.frameId } : void 0, params.sessionId);
	const { tree, roots } = buildRoleTree(Array.isArray(res.nodes) ? res.nodes : []);
	const cursorElements = await findCursorInteractiveElements(params.send, params.sessionId);
	for (const node of tree) if (node.backendDOMNodeId && cursorElements.has(node.backendDOMNodeId)) {
		const cursorInfo = cursorElements.get(node.backendDOMNodeId);
		node.cursorInfo = cursorInfo;
		if (!node.name && cursorInfo?.text) node.name = cursorInfo.text;
	}
	const counts = /* @__PURE__ */ new Map();
	const refsByKey = /* @__PURE__ */ new Map();
	const refs = {};
	for (const node of tree) {
		const role = node.role.toLowerCase();
		if (!(INTERACTIVE_ROLES.has(role) || CONTENT_ROLES.has(role) && Boolean(node.name) || role === "iframe" || Boolean(node.cursorInfo))) continue;
		const key = `${role}:${node.name}`;
		const nth = counts.get(key) ?? 0;
		counts.set(key, nth + 1);
		const ref = `e${params.nextRef.value}`;
		params.nextRef.value += 1;
		node.ref = ref;
		node.nth = nth;
		refsByKey.set(key, [...refsByKey.get(key) ?? [], ref]);
		refs[ref] = {
			role,
			...node.name ? { name: node.name } : {},
			...nth > 0 ? { nth } : {},
			...node.backendDOMNodeId ? { backendDOMNodeId: node.backendDOMNodeId } : {},
			...params.frameId ? { frameId: params.frameId } : {}
		};
	}
	for (const refList of refsByKey.values()) {
		if (refList.length > 1) continue;
		const ref = refList[0];
		if (ref) {
			delete refs[ref]?.nth;
			const node = tree.find((entry) => entry.ref === ref);
			if (node) delete node.nth;
		}
	}
	const iframeFrameIds = await resolveIframeFrameIds(params.send, tree, params.sessionId);
	for (const node of tree) if (node.backendDOMNodeId && iframeFrameIds.has(node.backendDOMNodeId)) {
		node.frameId = iframeFrameIds.get(node.backendDOMNodeId);
		if (node.ref && refs[node.ref]) refs[node.ref].frameId = node.frameId;
	}
	if (params.urls) {
		const urls = await resolveLinkUrls(params.send, refs, params.sessionId);
		for (const node of tree) if (node.backendDOMNodeId && urls.has(node.backendDOMNodeId)) node.url = urls.get(node.backendDOMNodeId);
	}
	const lines = [];
	for (const root of roots) renderRoleTree(tree, root, lines, params.options);
	if (params.recurseIframes) {
		const iframeNodes = tree.filter((node) => node.ref && node.frameId);
		for (const iframe of iframeNodes) {
			const marker = `[ref=${iframe.ref}]`;
			const lineIndex = lines.findIndex((line) => line.includes(marker));
			if (lineIndex < 0 || !iframe.frameId) continue;
			const child = await buildCdpRoleSnapshot({
				...params,
				frameId: iframe.frameId,
				recurseIframes: false
			}).catch(() => null);
			if (!child?.lines.length) continue;
			Object.assign(refs, child.refs);
			lines.splice(lineIndex + 1, 0, ...child.lines.map((line) => `  ${line}`));
		}
	}
	const refValues = Object.values(refs);
	return {
		lines,
		refs,
		stats: {
			refs: refValues.length,
			interactive: refValues.filter((ref) => INTERACTIVE_ROLES.has(ref.role)).length
		}
	};
}
async function snapshotRoleViaCdp(opts) {
	return await withCdpSocket(opts.wsUrl, async (send) => {
		await prepareCdpPageSession(send);
		const built = await buildCdpRoleSnapshot({
			send,
			options: opts.options ?? {},
			urls: opts.urls,
			recurseIframes: true,
			nextRef: { value: 1 }
		});
		const snapshot = built.lines.join("\n").trim() || (opts.options?.interactive ? "(no interactive elements)" : "(empty page)");
		return {
			snapshot,
			refs: built.refs,
			stats: {
				lines: snapshot.split("\n").length,
				chars: snapshot.length,
				refs: built.stats.refs,
				interactive: built.stats.interactive
			}
		};
	}, { commandTimeoutMs: opts.timeoutMs ?? 5e3 });
}
//#endregion
//#region extensions/browser/src/infra/ws.ts
function rawDataToString(data) {
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	return String(data);
}
//#endregion
//#region extensions/browser/src/browser/chrome.diagnostics.ts
function elapsedSince(startedAt) {
	return Math.max(0, Date.now() - startedAt);
}
function safeChromeCdpErrorMessage(error) {
	const message = error instanceof Error ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : void 0;
	const causeMessage = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : void 0;
	if (message && causeMessage && !message.includes(causeMessage)) return redactSensitiveText(`${message}: ${causeMessage}`);
	return redactSensitiveText(message || "unknown error");
}
function failureDiagnostic(params) {
	return {
		ok: false,
		cdpUrl: params.cdpUrl,
		wsUrl: params.wsUrl,
		code: params.code,
		message: redactSensitiveText(params.message),
		elapsedMs: elapsedSince(params.startedAt)
	};
}
async function readChromeVersion(cdpUrl, timeoutMs = 500, ssrfPolicy) {
	const ctrl = new AbortController();
	const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
	try {
		const { response, release } = await fetchCdpChecked(appendCdpPath(cdpUrl, "/json/version"), timeoutMs, { signal: ctrl.signal }, ssrfPolicy);
		try {
			const data = await response.json();
			if (!data || typeof data !== "object") throw new Error("CDP /json/version returned non-object JSON");
			return data;
		} finally {
			await release();
		}
	} finally {
		clearTimeout(t);
	}
}
async function diagnoseCdpHealthCommand(wsUrl, timeoutMs = 800) {
	return await new Promise((resolve) => {
		const ws = openCdpWebSocket(wsUrl, { handshakeTimeoutMs: timeoutMs });
		let settled = false;
		let opened = false;
		const onMessage = (raw) => {
			if (settled) return;
			let parsed = null;
			try {
				parsed = JSON.parse(rawDataToString(raw));
			} catch {
				return;
			}
			if (parsed?.id !== 1) return;
			if (parsed.result && typeof parsed.result === "object") {
				finish({ ok: true });
				return;
			}
			finish({
				ok: false,
				code: "websocket_health_command_failed",
				message: "Browser.getVersion returned no result object"
			});
		};
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ws.off("message", onMessage);
			try {
				ws.close();
			} catch {}
			resolve(value);
		};
		const timer = setTimeout(() => {
			try {
				ws.terminate();
			} catch {}
			finish({
				ok: false,
				code: opened ? "websocket_health_command_timeout" : "websocket_handshake_failed",
				message: opened ? `Browser.getVersion did not respond within ${timeoutMs}ms` : `WebSocket handshake did not complete within ${timeoutMs}ms`
			});
		}, Math.max(1, timeoutMs + Math.min(25, timeoutMs)));
		ws.once("open", () => {
			opened = true;
			try {
				ws.send(JSON.stringify({
					id: 1,
					method: "Browser.getVersion"
				}));
			} catch (err) {
				finish({
					ok: false,
					code: "websocket_health_command_failed",
					message: safeChromeCdpErrorMessage(err)
				});
			}
		});
		ws.on("message", onMessage);
		ws.once("error", (err) => {
			finish({
				ok: false,
				code: opened ? "websocket_health_command_failed" : "websocket_handshake_failed",
				message: safeChromeCdpErrorMessage(err)
			});
		});
		ws.once("close", () => {
			finish({
				ok: false,
				code: opened ? "websocket_health_command_failed" : "websocket_handshake_failed",
				message: opened ? "WebSocket closed before Browser.getVersion completed" : "WebSocket closed before handshake completed"
			});
		});
	});
}
function classifyChromeVersionError(error) {
	const message = safeChromeCdpErrorMessage(error);
	if (error instanceof BrowserCdpEndpointBlockedError) return {
		code: "ssrf_blocked",
		message
	};
	if (/^HTTP \d+/.test(message)) return {
		code: "http_status_failed",
		message
	};
	if (error instanceof SyntaxError || message.includes("non-object JSON")) return {
		code: "invalid_json",
		message
	};
	return {
		code: "http_unreachable",
		message
	};
}
function formatChromeCdpDiagnostic(diagnostic) {
	const redactedCdpUrl = redactCdpUrl(diagnostic.cdpUrl) ?? diagnostic.cdpUrl;
	const redactedWsUrl = redactCdpUrl(diagnostic.wsUrl) ?? diagnostic.wsUrl;
	if (diagnostic.ok) {
		const browser = diagnostic.browser ? ` browser=${diagnostic.browser}` : "";
		return `CDP diagnostic: ready after ${diagnostic.elapsedMs}ms; cdp=${redactedCdpUrl}; websocket=${redactedWsUrl}.${browser}`;
	}
	const websocket = redactedWsUrl ? `; websocket=${redactedWsUrl}` : "";
	const wslPortproxyHint = diagnostic.code === "http_unreachable" && isLikelyEmptyHttpReply(diagnostic.message) ? " In WSL2-to-Windows Chrome setups, this can be a stale netsh portproxy self-loop where svchost/iphlpsvc owns the CDP port instead of chrome.exe; verify with tasklist /svc and curl /json/version, then remove any 127.0.0.1:9222 -> 127.0.0.1:9222 portproxy rule." : "";
	return `CDP diagnostic: ${diagnostic.code} after ${diagnostic.elapsedMs}ms; cdp=${redactedCdpUrl}${websocket}; ${diagnostic.message}.${wslPortproxyHint}`;
}
function isLikelyEmptyHttpReply(message) {
	return /empty reply|other side closed|socket closed|terminated before response/i.test(message);
}
async function diagnoseChromeCdp(cdpUrl, timeoutMs = 500, handshakeTimeoutMs = 800, ssrfPolicy) {
	const startedAt = Date.now();
	try {
		await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
	} catch (err) {
		return failureDiagnostic({
			cdpUrl,
			code: "ssrf_blocked",
			message: safeChromeCdpErrorMessage(err),
			startedAt
		});
	}
	if (isDirectCdpWebSocketEndpoint(cdpUrl)) {
		const health = await diagnoseCdpHealthCommand(cdpUrl, handshakeTimeoutMs);
		if (!health.ok) return failureDiagnostic({
			cdpUrl,
			wsUrl: cdpUrl,
			code: health.code,
			message: health.message,
			startedAt
		});
		return {
			ok: true,
			cdpUrl,
			wsUrl: cdpUrl,
			elapsedMs: elapsedSince(startedAt)
		};
	}
	const discoveryUrl = isWebSocketUrl(cdpUrl) ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl) : cdpUrl;
	let version;
	try {
		version = await readChromeVersion(discoveryUrl, timeoutMs, ssrfPolicy);
	} catch (err) {
		if (isWebSocketUrl(cdpUrl)) {
			const health = await diagnoseCdpHealthCommand(cdpUrl, handshakeTimeoutMs);
			if (!health.ok) return failureDiagnostic({
				cdpUrl,
				wsUrl: cdpUrl,
				code: health.code,
				message: health.message,
				startedAt
			});
			return {
				ok: true,
				cdpUrl,
				wsUrl: cdpUrl,
				elapsedMs: elapsedSince(startedAt)
			};
		}
		const classified = classifyChromeVersionError(err);
		return failureDiagnostic({
			cdpUrl,
			code: classified.code,
			message: classified.message,
			startedAt
		});
	}
	const wsUrlRaw = normalizeOptionalString(version.webSocketDebuggerUrl) ?? "";
	if (!wsUrlRaw) {
		if (isWebSocketUrl(cdpUrl)) {
			const health = await diagnoseCdpHealthCommand(cdpUrl, handshakeTimeoutMs);
			if (!health.ok) return failureDiagnostic({
				cdpUrl,
				wsUrl: cdpUrl,
				code: health.code,
				message: health.message,
				startedAt
			});
			return {
				ok: true,
				cdpUrl,
				wsUrl: cdpUrl,
				browser: version.Browser,
				userAgent: version["User-Agent"],
				elapsedMs: elapsedSince(startedAt)
			};
		}
		return failureDiagnostic({
			cdpUrl,
			code: "missing_websocket_debugger_url",
			message: "CDP /json/version did not include webSocketDebuggerUrl",
			startedAt
		});
	}
	const wsUrl = normalizeCdpWsUrl(wsUrlRaw, discoveryUrl);
	try {
		await assertCdpEndpointAllowed(wsUrl, ssrfPolicy);
	} catch (err) {
		return failureDiagnostic({
			cdpUrl,
			wsUrl,
			code: "websocket_ssrf_blocked",
			message: safeChromeCdpErrorMessage(err),
			startedAt
		});
	}
	const health = await diagnoseCdpHealthCommand(wsUrl, handshakeTimeoutMs);
	if (!health.ok) {
		if (isWebSocketUrl(cdpUrl) && wsUrl !== cdpUrl) {
			if ((await diagnoseCdpHealthCommand(cdpUrl, handshakeTimeoutMs)).ok) return {
				ok: true,
				cdpUrl,
				wsUrl: cdpUrl,
				browser: version.Browser,
				userAgent: version["User-Agent"],
				elapsedMs: elapsedSince(startedAt)
			};
		}
		return failureDiagnostic({
			cdpUrl,
			wsUrl,
			code: health.code,
			message: health.message,
			startedAt
		});
	}
	return {
		ok: true,
		cdpUrl,
		wsUrl,
		browser: version.Browser,
		userAgent: version["User-Agent"],
		elapsedMs: elapsedSince(startedAt)
	};
}
//#endregion
//#region extensions/browser/src/browser/chrome.profile-decoration.ts
function decoratedMarkerPath(userDataDir) {
	return path.join(userDataDir, ".openclaw-profile-decorated");
}
function safeReadJson(filePath) {
	const parsed = loadJsonFile(filePath);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
}
function safeWriteJson(filePath, data) {
	saveJsonFile(filePath, data);
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function readNestedRecord(root, key) {
	return asRecord(asRecord(root)?.[key]);
}
function setDeep(obj, keys, value) {
	let node = obj;
	for (const key of keys.slice(0, -1)) {
		const next = node[key];
		if (typeof next !== "object" || next === null || Array.isArray(next)) node[key] = {};
		node = node[key];
	}
	node[keys[keys.length - 1] ?? ""] = value;
}
function parseHexRgbToSignedArgbInt(hex) {
	const cleaned = hex.trim().replace(/^#/, "");
	if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
	const argbUnsigned = 255 << 24 | Number.parseInt(cleaned, 16);
	return argbUnsigned > 2147483647 ? argbUnsigned - 4294967296 : argbUnsigned;
}
function isProfileDecorated(userDataDir, desiredName, desiredColorHex, desiredDownloadDir) {
	const desiredColorInt = parseHexRgbToSignedArgbInt(desiredColorHex);
	const localStatePath = path.join(userDataDir, "Local State");
	const preferencesPath = path.join(userDataDir, "Default", "Preferences");
	const profile = safeReadJson(localStatePath)?.profile;
	const info = readNestedRecord(readNestedRecord(profile, "info_cache"), "Default");
	const prefs = safeReadJson(preferencesPath);
	const browserTheme = readNestedRecord(prefs?.browser, "theme");
	const autogeneratedTheme = readNestedRecord(prefs?.autogenerated, "theme");
	const download = readNestedRecord(prefs, "download");
	const savefile = readNestedRecord(prefs, "savefile");
	const nameOk = typeof info?.name === "string" ? info.name === desiredName : true;
	const downloadOk = desiredDownloadDir ? download?.default_directory === desiredDownloadDir && download.prompt_for_download === false && download.directory_upgrade === true && savefile?.default_directory === desiredDownloadDir : true;
	if (desiredColorInt == null) return nameOk && downloadOk;
	const localSeedOk = typeof info?.profile_color_seed === "number" ? info.profile_color_seed === desiredColorInt : false;
	const prefOk = typeof browserTheme?.user_color2 === "number" && browserTheme.user_color2 === desiredColorInt || typeof autogeneratedTheme?.color === "number" && autogeneratedTheme.color === desiredColorInt;
	return nameOk && localSeedOk && prefOk && downloadOk;
}
/**
* Best-effort profile decoration (name + lobster-orange). Chrome preference keys
* vary by version; we keep this conservative and idempotent.
*/
function decorateOpenClawProfile(userDataDir, opts) {
	const desiredName = opts?.name ?? "openclaw";
	const desiredColor = (opts?.color ?? "#FF4500").toUpperCase();
	const desiredColorInt = parseHexRgbToSignedArgbInt(desiredColor);
	const localStatePath = path.join(userDataDir, "Local State");
	const preferencesPath = path.join(userDataDir, "Default", "Preferences");
	const localState = safeReadJson(localStatePath) ?? {};
	setDeep(localState, [
		"profile",
		"info_cache",
		"Default",
		"name"
	], desiredName);
	setDeep(localState, [
		"profile",
		"info_cache",
		"Default",
		"shortcut_name"
	], desiredName);
	setDeep(localState, [
		"profile",
		"info_cache",
		"Default",
		"user_name"
	], desiredName);
	setDeep(localState, [
		"profile",
		"info_cache",
		"Default",
		"profile_color"
	], desiredColor);
	setDeep(localState, [
		"profile",
		"info_cache",
		"Default",
		"user_color"
	], desiredColor);
	if (desiredColorInt != null) {
		setDeep(localState, [
			"profile",
			"info_cache",
			"Default",
			"profile_color_seed"
		], desiredColorInt);
		setDeep(localState, [
			"profile",
			"info_cache",
			"Default",
			"profile_highlight_color"
		], desiredColorInt);
		setDeep(localState, [
			"profile",
			"info_cache",
			"Default",
			"default_avatar_fill_color"
		], desiredColorInt);
		setDeep(localState, [
			"profile",
			"info_cache",
			"Default",
			"default_avatar_stroke_color"
		], desiredColorInt);
	}
	safeWriteJson(localStatePath, localState);
	const prefs = safeReadJson(preferencesPath) ?? {};
	setDeep(prefs, ["profile", "name"], desiredName);
	setDeep(prefs, ["profile", "profile_color"], desiredColor);
	setDeep(prefs, ["profile", "user_color"], desiredColor);
	if (desiredColorInt != null) {
		setDeep(prefs, [
			"autogenerated",
			"theme",
			"color"
		], desiredColorInt);
		setDeep(prefs, [
			"browser",
			"theme",
			"user_color2"
		], desiredColorInt);
	}
	if (opts?.downloadDir) {
		setDeep(prefs, ["download", "default_directory"], opts.downloadDir);
		setDeep(prefs, ["download", "prompt_for_download"], false);
		setDeep(prefs, ["download", "directory_upgrade"], true);
		setDeep(prefs, ["savefile", "default_directory"], opts.downloadDir);
	}
	safeWriteJson(preferencesPath, prefs);
	try {
		fs.writeFileSync(decoratedMarkerPath(userDataDir), `${Date.now()}\n`, "utf-8");
	} catch {}
}
function ensureProfileCleanExit(userDataDir) {
	const preferencesPath = path.join(userDataDir, "Default", "Preferences");
	const prefs = safeReadJson(preferencesPath) ?? {};
	setDeep(prefs, ["exit_type"], "Normal");
	setDeep(prefs, ["exited_cleanly"], true);
	safeWriteJson(preferencesPath, prefs);
}
//#endregion
//#region extensions/browser/src/browser/chrome.ts
const log = createSubsystemLogger("browser").child("chrome");
const CHROME_SINGLETON_LOCK_PATHS = [
	"SingletonLock",
	"SingletonSocket",
	"SingletonCookie"
];
const CHROME_SINGLETON_IN_USE_PATTERN = /profile appears to be in use by another chromium process/i;
const CHROME_MISSING_DISPLAY_PATTERN = /missing x server|\$DISPLAY/i;
const CHROME_HTTP_DISCOVERY_FAILURE_CODES = new Set([
	"ssrf_blocked",
	"http_unreachable",
	"http_status_failed",
	"invalid_json"
]);
function exists(filePath) {
	try {
		return fs.existsSync(filePath);
	} catch {
		return false;
	}
}
function diagnosticShowsChromeHttpDiscovery(diagnostic) {
	if (!diagnostic) return false;
	if (diagnostic.ok) return true;
	return !CHROME_HTTP_DISCOVERY_FAILURE_CODES.has(diagnostic.code);
}
function processExists(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if (err.code === "EPERM") return true;
		return false;
	}
}
function clearChromeSingletonArtifacts(userDataDir) {
	for (const basename of CHROME_SINGLETON_LOCK_PATHS) try {
		fs.rmSync(path.join(userDataDir, basename), { force: true });
	} catch {}
}
function clearStaleChromeSingletonLocks(userDataDir, hostname = os.hostname()) {
	const lockPath = path.join(userDataDir, "SingletonLock");
	let target;
	try {
		target = fs.readlinkSync(lockPath);
	} catch {
		return false;
	}
	const match = /^(?<lockHost>.+)-(?<pid>\d+)$/.exec(target);
	if (!match?.groups) return false;
	const lockHost = normalizeOptionalString(match.groups.lockHost) ?? "";
	const pid = Number.parseInt(match.groups.pid ?? "", 10);
	if (lockHost === hostname && processExists(pid)) return false;
	clearChromeSingletonArtifacts(userDataDir);
	return true;
}
async function waitForChromeProcessExit(proc, timeoutMs) {
	if (proc.exitCode != null || proc.signalCode != null || proc.killed) return;
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			proc.off("exit", onExit);
			proc.off("close", onExit);
			resolve();
		}, timeoutMs);
		const onExit = () => {
			clearTimeout(timer);
			resolve();
		};
		proc.once("exit", onExit);
		proc.once("close", onExit);
	});
}
async function terminateChromeForRetry(proc, userDataDir) {
	try {
		proc.kill("SIGKILL");
	} catch {}
	await waitForChromeProcessExit(proc, CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS);
	clearStaleChromeSingletonLocks(userDataDir);
}
function chromeLaunchHints(params) {
	const hints = [];
	if (process.platform === "linux" && !params.resolved.noSandbox) hints.push("If running in a container or as root, try setting browser.noSandbox: true.");
	const headlessMode = resolveManagedBrowserHeadlessMode(params.resolved, params.profile, params.launchOptions);
	if (CHROME_MISSING_DISPLAY_PATTERN.test(params.stderrOutput) && !headlessMode.headless) hints.push("No DISPLAY/X server was detected. Set OPENCLAW_BROWSER_HEADLESS=1, remove the headed override, start Xvfb, or run the Gateway in a desktop session.");
	if (CHROME_SINGLETON_IN_USE_PATTERN.test(params.stderrOutput)) hints.push(`The Chromium profile "${params.profile.name}" is locked. Stop the existing browser or remove stale Singleton* lock files under ~/.openclaw/browser/${params.profile.name}/user-data.`);
	return hints.length > 0 ? `\nHint: ${hints.join("\nHint: ")}` : "";
}
function resolveBrowserExecutable(resolved, profile) {
	return resolveBrowserExecutableForPlatform({
		...resolved,
		executablePath: profile.executablePath ?? resolved.executablePath
	}, process.platform);
}
function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
	return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}
function cdpUrlForPort(cdpPort) {
	return `http://127.0.0.1:${cdpPort}`;
}
function buildOpenClawChromeLaunchArgs(params) {
	const { resolved, profile, userDataDir } = params;
	const headlessMode = resolveManagedBrowserHeadlessMode(resolved, profile, params);
	const args = [
		`--remote-debugging-port=${profile.cdpPort}`,
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-sync",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-features=Translate,MediaRouter",
		"--disable-session-crashed-bubble",
		"--hide-crash-restore-bubble",
		"--password-store=basic"
	];
	if (headlessMode.headless) {
		args.push("--headless=new");
		args.push("--disable-gpu");
	}
	if (resolved.noSandbox) args.push("--no-sandbox");
	if (process.platform === "linux") args.push("--disable-dev-shm-usage");
	if (!hasChromeProxyControlArg(resolved.extraArgs)) args.push("--no-proxy-server");
	if (resolved.extraArgs.length > 0) args.push(...resolved.extraArgs);
	return args;
}
async function canOpenWebSocket(url, timeoutMs) {
	return new Promise((resolve) => {
		const ws = openCdpWebSocket(url, { handshakeTimeoutMs: timeoutMs });
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		ws.once("open", () => {
			try {
				ws.close();
			} catch {}
			finish(true);
		});
		ws.once("error", () => finish(false));
		ws.once("close", () => finish(false));
	});
}
async function isChromeReachable(cdpUrl, timeoutMs = 500, ssrfPolicy) {
	try {
		await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
		if (isDirectCdpWebSocketEndpoint(cdpUrl)) return await canOpenWebSocket(cdpUrl, timeoutMs);
		if (await fetchChromeVersion(isWebSocketUrl(cdpUrl) ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl) : cdpUrl, timeoutMs, ssrfPolicy)) return true;
		if (isWebSocketUrl(cdpUrl)) return await canOpenWebSocket(cdpUrl, timeoutMs);
		return false;
	} catch {
		return false;
	}
}
async function fetchChromeVersion(cdpUrl, timeoutMs = 500, ssrfPolicy) {
	try {
		return await readChromeVersion(cdpUrl, timeoutMs, ssrfPolicy);
	} catch {
		return null;
	}
}
async function getChromeWebSocketUrl(cdpUrl, timeoutMs = 500, ssrfPolicy) {
	await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
	if (isDirectCdpWebSocketEndpoint(cdpUrl)) return cdpUrl;
	const discoveryUrl = isWebSocketUrl(cdpUrl) ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl) : cdpUrl;
	const wsUrl = normalizeOptionalString((await fetchChromeVersion(discoveryUrl, timeoutMs, ssrfPolicy))?.webSocketDebuggerUrl) ?? "";
	if (!wsUrl) {
		if (isWebSocketUrl(cdpUrl)) return cdpUrl;
		return null;
	}
	const normalizedWsUrl = normalizeCdpWsUrl(wsUrl, discoveryUrl);
	await assertCdpEndpointAllowed(normalizedWsUrl, ssrfPolicy);
	return normalizedWsUrl;
}
async function isChromeCdpReady(cdpUrl, timeoutMs = 500, handshakeTimeoutMs = 800, ssrfPolicy) {
	const diagnostic = await diagnoseChromeCdp(cdpUrl, timeoutMs, handshakeTimeoutMs, ssrfPolicy);
	if (!diagnostic.ok) log.debug(formatChromeCdpDiagnostic(diagnostic));
	return diagnostic.ok;
}
async function launchOpenClawChrome(resolved, profile, launchOptions = {}) {
	if (!profile.cdpIsLoopback) throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
	const headlessMode = resolveManagedBrowserHeadlessMode(resolved, profile, launchOptions);
	const missingDisplayError = getManagedBrowserMissingDisplayError(resolved, profile, launchOptions);
	if (missingDisplayError) throw new BrowserProfileUnavailableError(missingDisplayError);
	await ensurePortAvailable(profile.cdpPort);
	const exe = resolveBrowserExecutable(resolved, profile);
	if (!exe) throw new Error("No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).");
	const userDataDir = resolveOpenClawUserDataDir(profile.name);
	fs.mkdirSync(userDataDir, { recursive: true });
	await ensureOutputDirectory(DEFAULT_DOWNLOAD_DIR);
	const needsDecorate = !isProfileDecorated(userDataDir, profile.name, (profile.color ?? "#FF4500").toUpperCase(), DEFAULT_DOWNLOAD_DIR);
	const spawnOnce = () => {
		const args = buildOpenClawChromeLaunchArgs({
			resolved,
			profile,
			userDataDir,
			...launchOptions
		});
		const env = {
			...omitChromeProxyEnv(process.env),
			HOME: os.homedir()
		};
		if (process.platform === "linux") {
			const chromiumStateDir = path.join(resolvePreferredOpenClawTmpDir(), ".chromium");
			env.XDG_CONFIG_HOME ??= chromiumStateDir;
			env.XDG_CACHE_HOME ??= chromiumStateDir;
		}
		const preparedSpawn = prepareOomScoreAdjustedSpawn(exe.path, args, { env });
		return spawn(preparedSpawn.command, preparedSpawn.args, {
			stdio: [
				"ignore",
				"ignore",
				"pipe"
			],
			env: preparedSpawn.env
		});
	};
	const startedAt = Date.now();
	const localStatePath = path.join(userDataDir, "Local State");
	const preferencesPath = path.join(userDataDir, "Default", "Preferences");
	if (!exists(localStatePath) || !exists(preferencesPath)) {
		const bootstrap = spawnOnce();
		const deadline = Date.now() + CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (exists(localStatePath) && exists(preferencesPath)) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		try {
			bootstrap.kill("SIGTERM");
		} catch {}
		const exitDeadline = Date.now() + CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS;
		while (Date.now() < exitDeadline) {
			if (bootstrap.exitCode != null) break;
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	if (needsDecorate) try {
		decorateOpenClawProfile(userDataDir, {
			name: profile.name,
			color: profile.color,
			downloadDir: DEFAULT_DOWNLOAD_DIR
		});
		log.info(`🦞 openclaw browser profile decorated (${profile.color})`);
	} catch (err) {
		log.warn(`openclaw browser profile decoration failed: ${String(err)}`);
	}
	try {
		ensureProfileCleanExit(userDataDir);
	} catch (err) {
		log.warn(`openclaw browser clean-exit prefs failed: ${String(err)}`);
	}
	const launchOnceAndWait = async (allowSingletonRecovery) => {
		const proc = spawnOnce();
		const stderrChunks = [];
		const onStderr = (chunk) => {
			stderrChunks.push(chunk);
		};
		proc.stderr?.on("data", onStderr);
		try {
			const readyDeadline = Date.now() + (resolved.localLaunchTimeoutMs ?? CHROME_LAUNCH_READY_WINDOW_MS);
			let launchHttpReachable = false;
			while (Date.now() < readyDeadline) {
				if (await isChromeReachable(profile.cdpUrl)) {
					launchHttpReachable = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 200));
			}
			if (!launchHttpReachable) {
				let finalDiagnostic = null;
				let diagnosticErrorText = null;
				try {
					finalDiagnostic = await diagnoseChromeCdp(profile.cdpUrl, 500, 800);
				} catch (err) {
					diagnosticErrorText = `CDP diagnostic failed: ${safeChromeCdpErrorMessage(err)}.`;
				}
				if (diagnosticShowsChromeHttpDiscovery(finalDiagnostic)) launchHttpReachable = true;
				const diagnosticText = finalDiagnostic ? formatChromeCdpDiagnostic(finalDiagnostic) : diagnosticErrorText ?? "CDP diagnostic failed.";
				if (launchHttpReachable) log.debug(diagnosticText);
				else {
					const stderrOutput = normalizeOptionalString(Buffer.concat(stderrChunks).toString("utf8")) ?? "";
					const redactedStderrOutput = redactToolPayloadText(stderrOutput);
					if (allowSingletonRecovery && CHROME_SINGLETON_IN_USE_PATTERN.test(stderrOutput) && clearStaleChromeSingletonLocks(userDataDir)) {
						log.warn(`Removed stale Chromium Singleton* locks for profile "${profile.name}" and retrying launch.`);
						await terminateChromeForRetry(proc, userDataDir);
						return await launchOnceAndWait(false);
					}
					const stderrHint = redactedStderrOutput ? `\nChrome stderr:\n${redactedStderrOutput.slice(0, CHROME_STDERR_HINT_MAX_CHARS)}` : "";
					const launchHints = chromeLaunchHints({
						stderrOutput,
						resolved,
						profile,
						launchOptions
					});
					try {
						proc.kill("SIGKILL");
					} catch {}
					throw new Error(`Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}". ${diagnosticText}${launchHints}${stderrHint}`);
				}
			}
			const pid = proc.pid ?? -1;
			log.info(`🦞 openclaw browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`);
			return {
				pid,
				exe,
				userDataDir,
				cdpPort: profile.cdpPort,
				startedAt,
				proc,
				headless: headlessMode.headless,
				headlessSource: headlessMode.source
			};
		} finally {
			proc.stderr?.off("data", onStderr);
			stderrChunks.length = 0;
		}
	};
	return await launchOnceAndWait(true);
}
async function stopOpenClawChrome(running, timeoutMs = CHROME_STOP_TIMEOUT_MS) {
	const proc = running.proc;
	if (proc.killed) return;
	try {
		proc.kill("SIGTERM");
	} catch {}
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!proc.exitCode && proc.killed) break;
		if (!await isChromeReachable(cdpUrlForPort(running.cdpPort), 200)) return;
		const remainingMs = timeoutMs - (Date.now() - start);
		await new Promise((r) => setTimeout(r, Math.max(1, Math.min(100, remainingMs))));
	}
	try {
		proc.kill("SIGKILL");
	} catch {}
}
//#endregion
export { assertBrowserNavigationRedirectChainAllowed as C, withBrowserNavigationPolicy as E, assertBrowserNavigationAllowed as S, requiresInspectableBrowserNavigationRedirectsForUrl as T, INTERACTIVE_ROLES as _, resolveOpenClawUserDataDir as a, resolveBrowserNavigationProxyMode as b, formatChromeCdpDiagnostic as c, createTargetViaCdp as d, formatAriaSnapshot as f, CONTENT_ROLES as g, snapshotRoleViaCdp as h, launchOpenClawChrome as i, AX_REF_PATTERN as l, snapshotAria as m, isChromeCdpReady as n, stopOpenClawChrome as o, normalizeCdpWsUrl as p, isChromeReachable as r, diagnoseChromeCdp as s, getChromeWebSocketUrl as t, captureScreenshot as u, STRUCTURAL_ROLES as v, assertBrowserNavigationResultAllowed as w, InvalidBrowserNavigationUrlError as x, ensureOutputDirectory as y };
