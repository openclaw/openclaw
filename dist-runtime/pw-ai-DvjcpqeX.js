import "./redact-qojvLPM7.js";
import { r as formatErrorMessage } from "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import { M as init_tmp_openclaw_dir, N as resolvePreferredOpenClawTmpDir } from "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import "./theme-CL08MjAq.js";
import "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-BiUV1eIQ.js";
import "./links-DPi3kBux.js";
import { By as BrowserTabNotFoundError, Cy as getChromeWebSocketUrl, Dy as markPwAiLoaded, Fy as resolveStrictExistingPathsWithinRoot, Hy as assertBrowserNavigationRedirectChainAllowed, Iy as matchBrowserUrlPattern, My as DEFAULT_TRACE_DIR, Ny as DEFAULT_UPLOAD_DIR, Oy as withNoProxyForCdpUrl, Uy as assertBrowserNavigationResultAllowed, Vy as assertBrowserNavigationAllowed, Wy as withBrowserNavigationPolicy, ay as buildRoleSnapshotFromAriaSnapshot, cy as formatAriaSnapshot, dy as fetchJson, fy as getHeadersWithAuth, hy as withCdpSocket, iy as buildRoleSnapshotFromAiSnapshot, ly as normalizeCdpWsUrl, oy as getRoleSnapshotStats, py as normalizeCdpHttpBaseForJsonEndpoints, sy as parseRoleRef, uy as appendCdpPath } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import { N as writeFileFromPathWithinRoot } from "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { chromium, devices } from "playwright-core";
//#region src/browser/pw-session.page-cdp.ts
async function withPlaywrightPageCdpSession(page, fn) {
	const session = await page.context().newCDPSession(page);
	try {
		return await fn(session);
	} finally {
		await session.detach().catch(() => {});
	}
}
async function withPageScopedCdpClient(opts) {
	return await withPlaywrightPageCdpSession(opts.page, async (session) => {
		return await opts.fn((method, params) => session.send(method, params));
	});
}
//#endregion
//#region src/browser/pw-session.ts
const pageStates = /* @__PURE__ */ new WeakMap();
const contextStates = /* @__PURE__ */ new WeakMap();
const observedContexts = /* @__PURE__ */ new WeakSet();
const observedPages = /* @__PURE__ */ new WeakSet();
const roleRefsByTarget = /* @__PURE__ */ new Map();
const MAX_ROLE_REFS_CACHE = 50;
const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;
const cachedByCdpUrl = /* @__PURE__ */ new Map();
const connectingByCdpUrl = /* @__PURE__ */ new Map();
function normalizeCdpUrl(raw) {
	return raw.replace(/\/$/, "");
}
function findNetworkRequestById(state, id) {
	for (let i = state.requests.length - 1; i >= 0; i -= 1) {
		const candidate = state.requests[i];
		if (candidate && candidate.id === id) return candidate;
	}
}
function roleRefsKey(cdpUrl, targetId) {
	return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}
function rememberRoleRefsForTarget(opts) {
	const targetId = opts.targetId.trim();
	if (!targetId) return;
	roleRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
		refs: opts.refs,
		...opts.frameSelector ? { frameSelector: opts.frameSelector } : {},
		...opts.mode ? { mode: opts.mode } : {}
	});
	while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
		const first = roleRefsByTarget.keys().next();
		if (first.done) break;
		roleRefsByTarget.delete(first.value);
	}
}
function storeRoleRefsForTarget(opts) {
	const state = ensurePageState(opts.page);
	state.roleRefs = opts.refs;
	state.roleRefsFrameSelector = opts.frameSelector;
	state.roleRefsMode = opts.mode;
	if (!opts.targetId?.trim()) return;
	rememberRoleRefsForTarget({
		cdpUrl: opts.cdpUrl,
		targetId: opts.targetId,
		refs: opts.refs,
		frameSelector: opts.frameSelector,
		mode: opts.mode
	});
}
function restoreRoleRefsForTarget(opts) {
	const targetId = opts.targetId?.trim() || "";
	if (!targetId) return;
	const cached = roleRefsByTarget.get(roleRefsKey(opts.cdpUrl, targetId));
	if (!cached) return;
	const state = ensurePageState(opts.page);
	if (state.roleRefs) return;
	state.roleRefs = cached.refs;
	state.roleRefsFrameSelector = cached.frameSelector;
	state.roleRefsMode = cached.mode;
}
function ensurePageState(page) {
	const existing = pageStates.get(page);
	if (existing) return existing;
	const state = {
		console: [],
		errors: [],
		requests: [],
		requestIds: /* @__PURE__ */ new WeakMap(),
		nextRequestId: 0,
		armIdUpload: 0,
		armIdDialog: 0,
		armIdDownload: 0
	};
	pageStates.set(page, state);
	if (!observedPages.has(page)) {
		observedPages.add(page);
		page.on("console", (msg) => {
			const entry = {
				type: msg.type(),
				text: msg.text(),
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				location: msg.location()
			};
			state.console.push(entry);
			if (state.console.length > MAX_CONSOLE_MESSAGES) state.console.shift();
		});
		page.on("pageerror", (err) => {
			state.errors.push({
				message: err?.message ? String(err.message) : String(err),
				name: err?.name ? String(err.name) : void 0,
				stack: err?.stack ? String(err.stack) : void 0,
				timestamp: (/* @__PURE__ */ new Date()).toISOString()
			});
			if (state.errors.length > MAX_PAGE_ERRORS) state.errors.shift();
		});
		page.on("request", (req) => {
			state.nextRequestId += 1;
			const id = `r${state.nextRequestId}`;
			state.requestIds.set(req, id);
			state.requests.push({
				id,
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				method: req.method(),
				url: req.url(),
				resourceType: req.resourceType()
			});
			if (state.requests.length > MAX_NETWORK_REQUESTS) state.requests.shift();
		});
		page.on("response", (resp) => {
			const req = resp.request();
			const id = state.requestIds.get(req);
			if (!id) return;
			const rec = findNetworkRequestById(state, id);
			if (!rec) return;
			rec.status = resp.status();
			rec.ok = resp.ok();
		});
		page.on("requestfailed", (req) => {
			const id = state.requestIds.get(req);
			if (!id) return;
			const rec = findNetworkRequestById(state, id);
			if (!rec) return;
			rec.failureText = req.failure()?.errorText;
			rec.ok = false;
		});
		page.on("close", () => {
			pageStates.delete(page);
			observedPages.delete(page);
		});
	}
	return state;
}
function observeContext(context) {
	if (observedContexts.has(context)) return;
	observedContexts.add(context);
	ensureContextState(context);
	for (const page of context.pages()) ensurePageState(page);
	context.on("page", (page) => ensurePageState(page));
}
function ensureContextState(context) {
	const existing = contextStates.get(context);
	if (existing) return existing;
	const state = { traceActive: false };
	contextStates.set(context, state);
	return state;
}
function observeBrowser(browser) {
	for (const context of browser.contexts()) observeContext(context);
}
async function connectBrowser(cdpUrl) {
	const normalized = normalizeCdpUrl(cdpUrl);
	const cached = cachedByCdpUrl.get(normalized);
	if (cached) return cached;
	const connecting = connectingByCdpUrl.get(normalized);
	if (connecting) return await connecting;
	const connectWithRetry = async () => {
		let lastErr;
		for (let attempt = 0; attempt < 3; attempt += 1) try {
			const timeout = 5e3 + attempt * 2e3;
			const endpoint = await getChromeWebSocketUrl(normalized, timeout).catch(() => null) ?? normalized;
			const headers = getHeadersWithAuth(endpoint);
			const browser = await withNoProxyForCdpUrl(endpoint, () => chromium.connectOverCDP(endpoint, {
				timeout,
				headers
			}));
			const onDisconnected = () => {
				if (cachedByCdpUrl.get(normalized)?.browser === browser) cachedByCdpUrl.delete(normalized);
			};
			const connected = {
				browser,
				cdpUrl: normalized,
				onDisconnected
			};
			cachedByCdpUrl.set(normalized, connected);
			browser.on("disconnected", onDisconnected);
			observeBrowser(browser);
			return connected;
		} catch (err) {
			lastErr = err;
			if ((err instanceof Error ? err.message : String(err)).includes("rate limit")) break;
			const delay = 250 + attempt * 250;
			await new Promise((r) => setTimeout(r, delay));
		}
		if (lastErr instanceof Error) throw lastErr;
		const message = lastErr ? formatErrorMessage(lastErr) : "CDP connect failed";
		throw new Error(message);
	};
	const pending = connectWithRetry().finally(() => {
		connectingByCdpUrl.delete(normalized);
	});
	connectingByCdpUrl.set(normalized, pending);
	return await pending;
}
async function getAllPages(browser) {
	return browser.contexts().flatMap((c) => c.pages());
}
async function pageTargetId(page) {
	const session = await page.context().newCDPSession(page);
	try {
		const info = await session.send("Target.getTargetInfo");
		return String(info?.targetInfo?.targetId ?? "").trim() || null;
	} finally {
		await session.detach().catch(() => {});
	}
}
function matchPageByTargetList(pages, targets, targetId) {
	const target = targets.find((entry) => entry.id === targetId);
	if (!target) return null;
	const urlMatch = pages.filter((page) => page.url() === target.url);
	if (urlMatch.length === 1) return urlMatch[0] ?? null;
	if (urlMatch.length > 1) {
		const sameUrlTargets = targets.filter((entry) => entry.url === target.url);
		if (sameUrlTargets.length === urlMatch.length) {
			const idx = sameUrlTargets.findIndex((entry) => entry.id === targetId);
			if (idx >= 0 && idx < urlMatch.length) return urlMatch[idx] ?? null;
		}
	}
	return null;
}
async function findPageByTargetIdViaTargetList(pages, targetId, cdpUrl) {
	return matchPageByTargetList(pages, await fetchJson(appendCdpPath(normalizeCdpHttpBaseForJsonEndpoints(cdpUrl), "/json/list"), 2e3), targetId);
}
async function findPageByTargetId(browser, targetId, cdpUrl) {
	const pages = await getAllPages(browser);
	let resolvedViaCdp = false;
	for (const page of pages) {
		let tid = null;
		try {
			tid = await pageTargetId(page);
			resolvedViaCdp = true;
		} catch {
			tid = null;
		}
		if (tid && tid === targetId) return page;
	}
	if (cdpUrl) try {
		return await findPageByTargetIdViaTargetList(pages, targetId, cdpUrl);
	} catch {}
	if (!resolvedViaCdp && pages.length === 1) return pages[0] ?? null;
	return null;
}
async function resolvePageByTargetIdOrThrow(opts) {
	const { browser } = await connectBrowser(opts.cdpUrl);
	const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
	if (!page) throw new BrowserTabNotFoundError();
	return page;
}
async function getPageForTargetId(opts) {
	const { browser } = await connectBrowser(opts.cdpUrl);
	const pages = await getAllPages(browser);
	if (!pages.length) throw new Error("No pages available in the connected browser.");
	const first = pages[0];
	if (!opts.targetId) return first;
	const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
	if (!found) {
		if (pages.length === 1) return first;
		throw new BrowserTabNotFoundError();
	}
	return found;
}
function refLocator(page, ref) {
	const normalized = ref.startsWith("@") ? ref.slice(1) : ref.startsWith("ref=") ? ref.slice(4) : ref;
	if (/^e\d+$/.test(normalized)) {
		const state = pageStates.get(page);
		if (state?.roleRefsMode === "aria") return (state.roleRefsFrameSelector ? page.frameLocator(state.roleRefsFrameSelector) : page).locator(`aria-ref=${normalized}`);
		const info = state?.roleRefs?.[normalized];
		if (!info) throw new Error(`Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`);
		const locAny = state?.roleRefsFrameSelector ? page.frameLocator(state.roleRefsFrameSelector) : page;
		const locator = info.name ? locAny.getByRole(info.role, {
			name: info.name,
			exact: true
		}) : locAny.getByRole(info.role);
		return info.nth !== void 0 ? locator.nth(info.nth) : locator;
	}
	return page.locator(`aria-ref=${normalized}`);
}
async function closePlaywrightBrowserConnection(opts) {
	const normalized = opts?.cdpUrl ? normalizeCdpUrl(opts.cdpUrl) : null;
	if (normalized) {
		const cur = cachedByCdpUrl.get(normalized);
		cachedByCdpUrl.delete(normalized);
		connectingByCdpUrl.delete(normalized);
		if (!cur) return;
		if (cur.onDisconnected && typeof cur.browser.off === "function") cur.browser.off("disconnected", cur.onDisconnected);
		await cur.browser.close().catch(() => {});
		return;
	}
	const connections = Array.from(cachedByCdpUrl.values());
	cachedByCdpUrl.clear();
	connectingByCdpUrl.clear();
	for (const cur of connections) {
		if (cur.onDisconnected && typeof cur.browser.off === "function") cur.browser.off("disconnected", cur.onDisconnected);
		await cur.browser.close().catch(() => {});
	}
}
function cdpSocketNeedsAttach(wsUrl) {
	try {
		const pathname = new URL(wsUrl).pathname;
		return pathname === "/cdp" || pathname.endsWith("/cdp") || pathname.includes("/devtools/browser/");
	} catch {
		return false;
	}
}
async function tryTerminateExecutionViaCdp(opts) {
	const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(opts.cdpUrl);
	const pages = await fetchJson(appendCdpPath(cdpHttpBase, "/json/list"), 2e3).catch(() => null);
	if (!pages || pages.length === 0) return;
	const target = pages.find((p) => String(p.id ?? "").trim() === opts.targetId);
	const wsUrlRaw = String(target?.webSocketDebuggerUrl ?? "").trim();
	if (!wsUrlRaw) return;
	const wsUrl = normalizeCdpWsUrl(wsUrlRaw, cdpHttpBase);
	const needsAttach = cdpSocketNeedsAttach(wsUrl);
	const runWithTimeout = async (work, ms) => {
		let timer;
		const timeoutPromise = new Promise((_, reject) => {
			timer = setTimeout(() => reject(/* @__PURE__ */ new Error("CDP command timed out")), ms);
		});
		try {
			return await Promise.race([work, timeoutPromise]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	await withCdpSocket(wsUrl, async (send) => {
		let sessionId;
		try {
			if (needsAttach) {
				const attached = await runWithTimeout(send("Target.attachToTarget", {
					targetId: opts.targetId,
					flatten: true
				}), 1500);
				if (typeof attached?.sessionId === "string" && attached.sessionId.trim()) sessionId = attached.sessionId;
			}
			await runWithTimeout(send("Runtime.terminateExecution", void 0, sessionId), 1500);
			if (sessionId) send("Target.detachFromTarget", { sessionId }).catch(() => {});
		} catch {}
	}, { handshakeTimeoutMs: 2e3 }).catch(() => {});
}
/**
* Best-effort cancellation for stuck page operations.
*
* Playwright serializes CDP commands per page; a long-running or stuck operation (notably evaluate)
* can block all subsequent commands. We cannot safely "cancel" an individual command, and we do
* not want to close the actual Chromium tab. Instead, we disconnect Playwright's CDP connection
* so in-flight commands fail fast and the next request reconnects transparently.
*
* IMPORTANT: We CANNOT call Connection.close() because Playwright shares a single Connection
* across all objects (BrowserType, Browser, etc.). Closing it corrupts the entire Playwright
* instance, preventing reconnection.
*
* Instead we:
* 1. Null out `cached` so the next call triggers a fresh connectOverCDP
* 2. Fire-and-forget browser.close() — it may hang but won't block us
* 3. The next connectBrowser() creates a completely new CDP WebSocket connection
*
* The old browser.close() eventually resolves when the in-browser evaluate timeout fires,
* or the old connection gets GC'd. Either way, it doesn't affect the fresh connection.
*/
async function forceDisconnectPlaywrightForTarget(opts) {
	const normalized = normalizeCdpUrl(opts.cdpUrl);
	const cur = cachedByCdpUrl.get(normalized);
	if (!cur) return;
	cachedByCdpUrl.delete(normalized);
	connectingByCdpUrl.delete(normalized);
	if (cur.onDisconnected && typeof cur.browser.off === "function") cur.browser.off("disconnected", cur.onDisconnected);
	const targetId = opts.targetId?.trim() || "";
	if (targetId) await tryTerminateExecutionViaCdp({
		cdpUrl: normalized,
		targetId
	}).catch(() => {});
	cur.browser.close().catch(() => {});
}
/**
* List all pages/tabs from the persistent Playwright connection.
* Used for remote profiles where HTTP-based /json/list is ephemeral.
*/
async function listPagesViaPlaywright(opts) {
	const { browser } = await connectBrowser(opts.cdpUrl);
	const pages = await getAllPages(browser);
	const results = [];
	for (const page of pages) {
		const tid = await pageTargetId(page).catch(() => null);
		if (tid) results.push({
			targetId: tid,
			title: await page.title().catch(() => ""),
			url: page.url(),
			type: "page"
		});
	}
	return results;
}
/**
* Create a new page/tab using the persistent Playwright connection.
* Used for remote profiles where HTTP-based /json/new is ephemeral.
* Returns the new page's targetId and metadata.
*/
async function createPageViaPlaywright(opts) {
	const { browser } = await connectBrowser(opts.cdpUrl);
	const context = browser.contexts()[0] ?? await browser.newContext();
	ensureContextState(context);
	const page = await context.newPage();
	ensurePageState(page);
	const targetUrl = opts.url.trim() || "about:blank";
	if (targetUrl !== "about:blank") {
		const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy);
		await assertBrowserNavigationAllowed({
			url: targetUrl,
			...navigationPolicy
		});
		await assertBrowserNavigationRedirectChainAllowed({
			request: (await page.goto(targetUrl, { timeout: 3e4 }).catch(() => {
				return null;
			}))?.request(),
			...navigationPolicy
		});
		await assertBrowserNavigationResultAllowed({
			url: page.url(),
			...navigationPolicy
		});
	}
	const tid = await pageTargetId(page).catch(() => null);
	if (!tid) throw new Error("Failed to get targetId for new page");
	return {
		targetId: tid,
		title: await page.title().catch(() => ""),
		url: page.url(),
		type: "page"
	};
}
/**
* Close a page/tab by targetId using the persistent Playwright connection.
* Used for remote profiles where HTTP-based /json/close is ephemeral.
*/
async function closePageByTargetIdViaPlaywright(opts) {
	await (await resolvePageByTargetIdOrThrow(opts)).close();
}
/**
* Focus a page/tab by targetId using the persistent Playwright connection.
* Used for remote profiles where HTTP-based /json/activate can be ephemeral.
*/
async function focusPageByTargetIdViaPlaywright(opts) {
	const page = await resolvePageByTargetIdOrThrow(opts);
	try {
		await page.bringToFront();
	} catch (err) {
		try {
			await withPageScopedCdpClient({
				cdpUrl: opts.cdpUrl,
				page,
				targetId: opts.targetId,
				fn: async (send) => {
					await send("Page.bringToFront");
				}
			});
			return;
		} catch {
			throw err;
		}
	}
}
//#endregion
//#region src/browser/pw-tools-core.activity.ts
async function getPageErrorsViaPlaywright(opts) {
	const state = ensurePageState(await getPageForTargetId(opts));
	const errors = [...state.errors];
	if (opts.clear) state.errors = [];
	return { errors };
}
async function getNetworkRequestsViaPlaywright(opts) {
	const state = ensurePageState(await getPageForTargetId(opts));
	const raw = [...state.requests];
	const filter = typeof opts.filter === "string" ? opts.filter.trim() : "";
	const requests = filter ? raw.filter((r) => r.url.includes(filter)) : raw;
	if (opts.clear) {
		state.requests = [];
		state.requestIds = /* @__PURE__ */ new WeakMap();
	}
	return { requests };
}
function consolePriority(level) {
	switch (level) {
		case "error": return 3;
		case "warning": return 2;
		case "info":
		case "log": return 1;
		case "debug": return 0;
		default: return 1;
	}
}
async function getConsoleMessagesViaPlaywright(opts) {
	const state = ensurePageState(await getPageForTargetId(opts));
	if (!opts.level) return [...state.console];
	const min = consolePriority(opts.level);
	return state.console.filter((msg) => consolePriority(msg.type) >= min);
}
//#endregion
//#region src/browser/safe-filename.ts
init_tmp_openclaw_dir();
function sanitizeUntrustedFileName(fileName, fallbackName) {
	const trimmed = String(fileName ?? "").trim();
	if (!trimmed) return fallbackName;
	let base = path.posix.basename(trimmed);
	base = path.win32.basename(base);
	let cleaned = "";
	for (let i = 0; i < base.length; i++) {
		const code = base.charCodeAt(i);
		if (code < 32 || code === 127) continue;
		cleaned += base[i];
	}
	base = cleaned.trim();
	if (!base || base === "." || base === "..") return fallbackName;
	if (base.length > 200) base = base.slice(0, 200);
	return base;
}
//#endregion
//#region src/browser/output-atomic.ts
function buildSiblingTempPath(targetPath) {
	const id = crypto.randomUUID();
	const safeTail = sanitizeUntrustedFileName(path.basename(targetPath), "output.bin");
	return path.join(path.dirname(targetPath), `.openclaw-output-${id}-${safeTail}.part`);
}
async function writeViaSiblingTempPath(params) {
	const rootDir = await fs.realpath(path.resolve(params.rootDir)).catch(() => path.resolve(params.rootDir));
	const requestedTargetPath = path.resolve(params.targetPath);
	const targetPath = await fs.realpath(path.dirname(requestedTargetPath)).then((realDir) => path.join(realDir, path.basename(requestedTargetPath))).catch(() => requestedTargetPath);
	const relativeTargetPath = path.relative(rootDir, targetPath);
	if (!relativeTargetPath || relativeTargetPath === ".." || relativeTargetPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTargetPath)) throw new Error("Target path is outside the allowed root");
	const tempPath = buildSiblingTempPath(targetPath);
	let renameSucceeded = false;
	try {
		await params.writeTemp(tempPath);
		await writeFileFromPathWithinRoot({
			rootDir,
			relativePath: relativeTargetPath,
			sourcePath: tempPath,
			mkdir: false
		});
		renameSucceeded = true;
	} finally {
		if (!renameSucceeded) await fs.rm(tempPath, { force: true }).catch(() => {});
	}
}
//#endregion
//#region src/browser/pw-tools-core.shared.ts
let nextUploadArmId = 0;
let nextDialogArmId = 0;
let nextDownloadArmId = 0;
function bumpUploadArmId() {
	nextUploadArmId += 1;
	return nextUploadArmId;
}
function bumpDialogArmId() {
	nextDialogArmId += 1;
	return nextDialogArmId;
}
function bumpDownloadArmId() {
	nextDownloadArmId += 1;
	return nextDownloadArmId;
}
function requireRef(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	const ref = (raw ? parseRoleRef(raw) : null) ?? (raw.startsWith("@") ? raw.slice(1) : raw);
	if (!ref) throw new Error("ref is required");
	return ref;
}
function requireRefOrSelector(ref, selector) {
	const trimmedRef = typeof ref === "string" ? ref.trim() : "";
	const trimmedSelector = typeof selector === "string" ? selector.trim() : "";
	if (!trimmedRef && !trimmedSelector) throw new Error("ref or selector is required");
	return {
		ref: trimmedRef || void 0,
		selector: trimmedSelector || void 0
	};
}
function normalizeTimeoutMs(timeoutMs, fallback) {
	return Math.max(500, Math.min(12e4, timeoutMs ?? fallback));
}
function toAIFriendlyError(error, selector) {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("strict mode violation")) {
		const countMatch = message.match(/resolved to (\d+) elements/);
		const count = countMatch ? countMatch[1] : "multiple";
		return /* @__PURE__ */ new Error(`Selector "${selector}" matched ${count} elements. Run a new snapshot to get updated refs, or use a different ref.`);
	}
	if ((message.includes("Timeout") || message.includes("waiting for")) && (message.includes("to be visible") || message.includes("not visible"))) return /* @__PURE__ */ new Error(`Element "${selector}" not found or not visible. Run a new snapshot to see current page elements.`);
	if (message.includes("intercepts pointer events") || message.includes("not visible") || message.includes("not receive pointer events")) return /* @__PURE__ */ new Error(`Element "${selector}" is not interactable (hidden or covered). Try scrolling it into view, closing overlays, or re-snapshotting.`);
	return error instanceof Error ? error : new Error(message);
}
//#endregion
//#region src/browser/pw-tools-core.downloads.ts
function buildTempDownloadPath(fileName) {
	const id = crypto.randomUUID();
	const safeName = sanitizeUntrustedFileName(fileName, "download.bin");
	return path.join(resolvePreferredOpenClawTmpDir(), "downloads", `${id}-${safeName}`);
}
function createPageDownloadWaiter(page, timeoutMs) {
	let done = false;
	let timer;
	let handler;
	const cleanup = () => {
		if (timer) clearTimeout(timer);
		timer = void 0;
		if (handler) {
			page.off("download", handler);
			handler = void 0;
		}
	};
	return {
		promise: new Promise((resolve, reject) => {
			handler = (download) => {
				if (done) return;
				done = true;
				cleanup();
				resolve(download);
			};
			page.on("download", handler);
			timer = setTimeout(() => {
				if (done) return;
				done = true;
				cleanup();
				reject(/* @__PURE__ */ new Error("Timeout waiting for download"));
			}, timeoutMs);
		}),
		cancel: () => {
			if (done) return;
			done = true;
			cleanup();
		}
	};
}
async function saveDownloadPayload(download, outPath) {
	const suggested = download.suggestedFilename?.() || "download.bin";
	const requestedPath = outPath?.trim();
	const resolvedOutPath = path.resolve(requestedPath || buildTempDownloadPath(suggested));
	await fs.mkdir(path.dirname(resolvedOutPath), { recursive: true });
	if (!requestedPath) await download.saveAs?.(resolvedOutPath);
	else await writeViaSiblingTempPath({
		rootDir: path.dirname(resolvedOutPath),
		targetPath: resolvedOutPath,
		writeTemp: async (tempPath) => {
			await download.saveAs?.(tempPath);
		}
	});
	return {
		url: download.url?.() || "",
		suggestedFilename: suggested,
		path: resolvedOutPath
	};
}
async function awaitDownloadPayload(params) {
	try {
		const download = await params.waiter.promise;
		if (params.state.armIdDownload !== params.armId) throw new Error("Download was superseded by another waiter");
		return await saveDownloadPayload(download, params.outPath ?? "");
	} catch (err) {
		params.waiter.cancel();
		throw err;
	}
}
async function armFileUploadViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	const state = ensurePageState(page);
	const timeout = Math.max(500, Math.min(12e4, opts.timeoutMs ?? 12e4));
	state.armIdUpload = bumpUploadArmId();
	const armId = state.armIdUpload;
	page.waitForEvent("filechooser", { timeout }).then(async (fileChooser) => {
		if (state.armIdUpload !== armId) return;
		if (!opts.paths?.length) {
			try {
				await page.keyboard.press("Escape");
			} catch {}
			return;
		}
		const uploadPathsResult = await resolveStrictExistingPathsWithinRoot({
			rootDir: DEFAULT_UPLOAD_DIR,
			requestedPaths: opts.paths,
			scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`
		});
		if (!uploadPathsResult.ok) {
			try {
				await page.keyboard.press("Escape");
			} catch {}
			return;
		}
		await fileChooser.setFiles(uploadPathsResult.paths);
		try {
			const input = typeof fileChooser.element === "function" ? await Promise.resolve(fileChooser.element()) : null;
			if (input) await input.evaluate((el) => {
				el.dispatchEvent(new Event("input", { bubbles: true }));
				el.dispatchEvent(new Event("change", { bubbles: true }));
			});
		} catch {}
	}).catch(() => {});
}
async function armDialogViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	const state = ensurePageState(page);
	const timeout = normalizeTimeoutMs(opts.timeoutMs, 12e4);
	state.armIdDialog = bumpDialogArmId();
	const armId = state.armIdDialog;
	page.waitForEvent("dialog", { timeout }).then(async (dialog) => {
		if (state.armIdDialog !== armId) return;
		if (opts.accept) await dialog.accept(opts.promptText);
		else await dialog.dismiss();
	}).catch(() => {});
}
async function waitForDownloadViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	const state = ensurePageState(page);
	const timeout = normalizeTimeoutMs(opts.timeoutMs, 12e4);
	state.armIdDownload = bumpDownloadArmId();
	const armId = state.armIdDownload;
	return await awaitDownloadPayload({
		waiter: createPageDownloadWaiter(page, timeout),
		state,
		armId,
		outPath: opts.path
	});
}
async function downloadViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	const state = ensurePageState(page);
	restoreRoleRefsForTarget({
		cdpUrl: opts.cdpUrl,
		targetId: opts.targetId,
		page
	});
	const timeout = normalizeTimeoutMs(opts.timeoutMs, 12e4);
	const ref = requireRef(opts.ref);
	const outPath = String(opts.path ?? "").trim();
	if (!outPath) throw new Error("path is required");
	state.armIdDownload = bumpDownloadArmId();
	const armId = state.armIdDownload;
	const waiter = createPageDownloadWaiter(page, timeout);
	try {
		const locator = refLocator(page, ref);
		try {
			await locator.click({ timeout });
		} catch (err) {
			throw toAIFriendlyError(err, ref);
		}
		return await awaitDownloadPayload({
			waiter,
			state,
			armId,
			outPath
		});
	} catch (err) {
		waiter.cancel();
		throw err;
	}
}
//#endregion
//#region src/browser/pw-tools-core.snapshot.ts
async function snapshotAriaViaPlaywright(opts) {
	const limit = Math.max(1, Math.min(2e3, Math.floor(opts.limit ?? 500)));
	const page = await getPageForTargetId({
		cdpUrl: opts.cdpUrl,
		targetId: opts.targetId
	});
	ensurePageState(page);
	const res = await withPageScopedCdpClient({
		cdpUrl: opts.cdpUrl,
		page,
		targetId: opts.targetId,
		fn: async (send) => {
			await send("Accessibility.enable").catch(() => {});
			return await send("Accessibility.getFullAXTree");
		}
	});
	return { nodes: formatAriaSnapshot(Array.isArray(res?.nodes) ? res.nodes : [], limit) };
}
async function snapshotAiViaPlaywright(opts) {
	const page = await getPageForTargetId({
		cdpUrl: opts.cdpUrl,
		targetId: opts.targetId
	});
	ensurePageState(page);
	const maybe = page;
	if (!maybe._snapshotForAI) throw new Error("Playwright _snapshotForAI is not available. Upgrade playwright-core.");
	const result = await maybe._snapshotForAI({
		timeout: Math.max(500, Math.min(6e4, Math.floor(opts.timeoutMs ?? 5e3))),
		track: "response"
	});
	let snapshot = String(result?.full ?? "");
	const maxChars = opts.maxChars;
	const limit = typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : void 0;
	let truncated = false;
	if (limit && snapshot.length > limit) {
		snapshot = `${snapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`;
		truncated = true;
	}
	const built = buildRoleSnapshotFromAiSnapshot(snapshot);
	storeRoleRefsForTarget({
		page,
		cdpUrl: opts.cdpUrl,
		targetId: opts.targetId,
		refs: built.refs,
		mode: "aria"
	});
	return truncated ? {
		snapshot,
		truncated,
		refs: built.refs
	} : {
		snapshot,
		refs: built.refs
	};
}
async function snapshotRoleViaPlaywright(opts) {
	const page = await getPageForTargetId({
		cdpUrl: opts.cdpUrl,
		targetId: opts.targetId
	});
	ensurePageState(page);
	if (opts.refsMode === "aria") {
		if (opts.selector?.trim() || opts.frameSelector?.trim()) throw new Error("refs=aria does not support selector/frame snapshots yet.");
		const maybe = page;
		if (!maybe._snapshotForAI) throw new Error("refs=aria requires Playwright _snapshotForAI support.");
		const result = await maybe._snapshotForAI({
			timeout: 5e3,
			track: "response"
		});
		const built = buildRoleSnapshotFromAiSnapshot(String(result?.full ?? ""), opts.options);
		storeRoleRefsForTarget({
			page,
			cdpUrl: opts.cdpUrl,
			targetId: opts.targetId,
			refs: built.refs,
			mode: "aria"
		});
		return {
			snapshot: built.snapshot,
			refs: built.refs,
			stats: getRoleSnapshotStats(built.snapshot, built.refs)
		};
	}
	const frameSelector = opts.frameSelector?.trim() || "";
	const selector = opts.selector?.trim() || "";
	const ariaSnapshot = await (frameSelector ? selector ? page.frameLocator(frameSelector).locator(selector) : page.frameLocator(frameSelector).locator(":root") : selector ? page.locator(selector) : page.locator(":root")).ariaSnapshot();
	const built = buildRoleSnapshotFromAriaSnapshot(String(ariaSnapshot ?? ""), opts.options);
	storeRoleRefsForTarget({
		page,
		cdpUrl: opts.cdpUrl,
		targetId: opts.targetId,
		refs: built.refs,
		frameSelector: frameSelector || void 0,
		mode: "role"
	});
	return {
		snapshot: built.snapshot,
		refs: built.refs,
		stats: getRoleSnapshotStats(built.snapshot, built.refs)
	};
}
async function navigateViaPlaywright(opts) {
	const isRetryableNavigateError = (err) => {
		const msg = typeof err === "string" ? err.toLowerCase() : err instanceof Error ? err.message.toLowerCase() : "";
		return msg.includes("frame has been detached") || msg.includes("target page, context or browser has been closed");
	};
	const url = String(opts.url ?? "").trim();
	if (!url) throw new Error("url is required");
	await assertBrowserNavigationAllowed({
		url,
		...withBrowserNavigationPolicy(opts.ssrfPolicy)
	});
	const timeout = Math.max(1e3, Math.min(12e4, opts.timeoutMs ?? 2e4));
	let page = await getPageForTargetId(opts);
	ensurePageState(page);
	const navigate = async () => await page.goto(url, { timeout });
	let response;
	try {
		response = await navigate();
	} catch (err) {
		if (!isRetryableNavigateError(err)) throw err;
		await forceDisconnectPlaywrightForTarget({
			cdpUrl: opts.cdpUrl,
			targetId: opts.targetId,
			reason: "retry navigate after detached frame"
		}).catch(() => {});
		page = await getPageForTargetId(opts);
		ensurePageState(page);
		response = await navigate();
	}
	await assertBrowserNavigationRedirectChainAllowed({
		request: response?.request(),
		...withBrowserNavigationPolicy(opts.ssrfPolicy)
	});
	const finalUrl = page.url();
	await assertBrowserNavigationResultAllowed({
		url: finalUrl,
		...withBrowserNavigationPolicy(opts.ssrfPolicy)
	});
	return { url: finalUrl };
}
async function resizeViewportViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	await page.setViewportSize({
		width: Math.max(1, Math.floor(opts.width)),
		height: Math.max(1, Math.floor(opts.height))
	});
}
async function closePageViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	await page.close();
}
async function pdfViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	return { buffer: await page.pdf({ printBackground: true }) };
}
//#endregion
//#region src/browser/pw-tools-core.interactions.ts
const MAX_CLICK_DELAY_MS = 5e3;
const MAX_WAIT_TIME_MS = 3e4;
const MAX_BATCH_ACTIONS = 100;
function resolveBoundedDelayMs(value, label, maxMs) {
	const normalized = Math.floor(value ?? 0);
	if (!Number.isFinite(normalized) || normalized < 0) throw new Error(`${label} must be >= 0`);
	if (normalized > maxMs) throw new Error(`${label} exceeds maximum of ${maxMs}ms`);
	return normalized;
}
async function getRestoredPageForTarget(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	restoreRoleRefsForTarget({
		cdpUrl: opts.cdpUrl,
		targetId: opts.targetId,
		page
	});
	return page;
}
function resolveInteractionTimeoutMs(timeoutMs) {
	return Math.max(500, Math.min(6e4, Math.floor(timeoutMs ?? 8e3)));
}
async function awaitEvalWithAbort(evalPromise, abortPromise) {
	if (!abortPromise) return await evalPromise;
	try {
		return await Promise.race([evalPromise, abortPromise]);
	} catch (err) {
		evalPromise.catch(() => {});
		throw err;
	}
}
async function highlightViaPlaywright(opts) {
	const page = await getRestoredPageForTarget(opts);
	const ref = requireRef(opts.ref);
	try {
		await refLocator(page, ref).highlight();
	} catch (err) {
		throw toAIFriendlyError(err, ref);
	}
}
async function clickViaPlaywright(opts) {
	const resolved = requireRefOrSelector(opts.ref, opts.selector);
	const page = await getRestoredPageForTarget(opts);
	const label = resolved.ref ?? resolved.selector;
	const locator = resolved.ref ? refLocator(page, requireRef(resolved.ref)) : page.locator(resolved.selector);
	const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
	try {
		const delayMs = resolveBoundedDelayMs(opts.delayMs, "click delayMs", MAX_CLICK_DELAY_MS);
		if (delayMs > 0) {
			await locator.hover({ timeout });
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		if (opts.doubleClick) await locator.dblclick({
			timeout,
			button: opts.button,
			modifiers: opts.modifiers
		});
		else await locator.click({
			timeout,
			button: opts.button,
			modifiers: opts.modifiers
		});
	} catch (err) {
		throw toAIFriendlyError(err, label);
	}
}
async function hoverViaPlaywright(opts) {
	const resolved = requireRefOrSelector(opts.ref, opts.selector);
	const page = await getRestoredPageForTarget(opts);
	const label = resolved.ref ?? resolved.selector;
	const locator = resolved.ref ? refLocator(page, requireRef(resolved.ref)) : page.locator(resolved.selector);
	try {
		await locator.hover({ timeout: resolveInteractionTimeoutMs(opts.timeoutMs) });
	} catch (err) {
		throw toAIFriendlyError(err, label);
	}
}
async function dragViaPlaywright(opts) {
	const resolvedStart = requireRefOrSelector(opts.startRef, opts.startSelector);
	const resolvedEnd = requireRefOrSelector(opts.endRef, opts.endSelector);
	const page = await getRestoredPageForTarget(opts);
	const startLocator = resolvedStart.ref ? refLocator(page, requireRef(resolvedStart.ref)) : page.locator(resolvedStart.selector);
	const endLocator = resolvedEnd.ref ? refLocator(page, requireRef(resolvedEnd.ref)) : page.locator(resolvedEnd.selector);
	const startLabel = resolvedStart.ref ?? resolvedStart.selector;
	const endLabel = resolvedEnd.ref ?? resolvedEnd.selector;
	try {
		await startLocator.dragTo(endLocator, { timeout: resolveInteractionTimeoutMs(opts.timeoutMs) });
	} catch (err) {
		throw toAIFriendlyError(err, `${startLabel} -> ${endLabel}`);
	}
}
async function selectOptionViaPlaywright(opts) {
	const resolved = requireRefOrSelector(opts.ref, opts.selector);
	if (!opts.values?.length) throw new Error("values are required");
	const page = await getRestoredPageForTarget(opts);
	const label = resolved.ref ?? resolved.selector;
	const locator = resolved.ref ? refLocator(page, requireRef(resolved.ref)) : page.locator(resolved.selector);
	try {
		await locator.selectOption(opts.values, { timeout: resolveInteractionTimeoutMs(opts.timeoutMs) });
	} catch (err) {
		throw toAIFriendlyError(err, label);
	}
}
async function pressKeyViaPlaywright(opts) {
	const key = String(opts.key ?? "").trim();
	if (!key) throw new Error("key is required");
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	await page.keyboard.press(key, { delay: Math.max(0, Math.floor(opts.delayMs ?? 0)) });
}
async function typeViaPlaywright(opts) {
	const resolved = requireRefOrSelector(opts.ref, opts.selector);
	const text = String(opts.text ?? "");
	const page = await getRestoredPageForTarget(opts);
	const label = resolved.ref ?? resolved.selector;
	const locator = resolved.ref ? refLocator(page, requireRef(resolved.ref)) : page.locator(resolved.selector);
	const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
	try {
		if (opts.slowly) {
			await locator.click({ timeout });
			await locator.type(text, {
				timeout,
				delay: 75
			});
		} else await locator.fill(text, { timeout });
		if (opts.submit) await locator.press("Enter", { timeout });
	} catch (err) {
		throw toAIFriendlyError(err, label);
	}
}
async function fillFormViaPlaywright(opts) {
	const page = await getRestoredPageForTarget(opts);
	const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
	for (const field of opts.fields) {
		const ref = field.ref.trim();
		const type = (field.type || "text").trim() || "text";
		const rawValue = field.value;
		const value = typeof rawValue === "string" ? rawValue : typeof rawValue === "number" || typeof rawValue === "boolean" ? String(rawValue) : "";
		if (!ref) continue;
		const locator = refLocator(page, ref);
		if (type === "checkbox" || type === "radio") {
			const checked = rawValue === true || rawValue === 1 || rawValue === "1" || rawValue === "true";
			try {
				await locator.setChecked(checked, { timeout });
			} catch (err) {
				throw toAIFriendlyError(err, ref);
			}
			continue;
		}
		try {
			await locator.fill(value, { timeout });
		} catch (err) {
			throw toAIFriendlyError(err, ref);
		}
	}
}
async function evaluateViaPlaywright(opts) {
	const fnText = String(opts.fn ?? "").trim();
	if (!fnText) throw new Error("function is required");
	const page = await getRestoredPageForTarget(opts);
	const outerTimeout = normalizeTimeoutMs(opts.timeoutMs, 2e4);
	let evaluateTimeout = Math.max(1e3, Math.min(12e4, outerTimeout - 500));
	evaluateTimeout = Math.min(evaluateTimeout, outerTimeout);
	const signal = opts.signal;
	let abortListener;
	let abortReject;
	let abortPromise;
	if (signal) {
		abortPromise = new Promise((_, reject) => {
			abortReject = reject;
		});
		abortPromise.catch(() => {});
	}
	if (signal) {
		const disconnect = () => {
			forceDisconnectPlaywrightForTarget({
				cdpUrl: opts.cdpUrl,
				targetId: opts.targetId,
				reason: "evaluate aborted"
			}).catch(() => {});
		};
		if (signal.aborted) {
			disconnect();
			throw signal.reason ?? /* @__PURE__ */ new Error("aborted");
		}
		abortListener = () => {
			disconnect();
			abortReject?.(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
		};
		signal.addEventListener("abort", abortListener, { once: true });
		if (signal.aborted) {
			abortListener();
			throw signal.reason ?? /* @__PURE__ */ new Error("aborted");
		}
	}
	try {
		if (opts.ref) {
			const locator = refLocator(page, opts.ref);
			const elementEvaluator = new Function("el", "args", `
        "use strict";
        var fnBody = args.fnBody, timeoutMs = args.timeoutMs;
        try {
          var candidate = eval("(" + fnBody + ")");
          var result = typeof candidate === "function" ? candidate(el) : candidate;
          if (result && typeof result.then === "function") {
            return Promise.race([
              result,
              new Promise(function(_, reject) {
                setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
              })
            ]);
          }
          return result;
        } catch (err) {
          throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
        }
        `);
			return await awaitEvalWithAbort(locator.evaluate(elementEvaluator, {
				fnBody: fnText,
				timeoutMs: evaluateTimeout
			}), abortPromise);
		}
		const browserEvaluator = new Function("args", `
        "use strict";
        var fnBody = args.fnBody, timeoutMs = args.timeoutMs;
        try {
          var candidate = eval("(" + fnBody + ")");
          var result = typeof candidate === "function" ? candidate() : candidate;
          if (result && typeof result.then === "function") {
            return Promise.race([
              result,
              new Promise(function(_, reject) {
                setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
              })
            ]);
          }
          return result;
        } catch (err) {
          throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
        }
      `);
		return await awaitEvalWithAbort(page.evaluate(browserEvaluator, {
			fnBody: fnText,
			timeoutMs: evaluateTimeout
		}), abortPromise);
	} finally {
		if (signal && abortListener) signal.removeEventListener("abort", abortListener);
	}
}
async function scrollIntoViewViaPlaywright(opts) {
	const resolved = requireRefOrSelector(opts.ref, opts.selector);
	const page = await getRestoredPageForTarget(opts);
	const timeout = normalizeTimeoutMs(opts.timeoutMs, 2e4);
	const label = resolved.ref ?? resolved.selector;
	const locator = resolved.ref ? refLocator(page, requireRef(resolved.ref)) : page.locator(resolved.selector);
	try {
		await locator.scrollIntoViewIfNeeded({ timeout });
	} catch (err) {
		throw toAIFriendlyError(err, label);
	}
}
async function waitForViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	const timeout = normalizeTimeoutMs(opts.timeoutMs, 2e4);
	if (typeof opts.timeMs === "number" && Number.isFinite(opts.timeMs)) await page.waitForTimeout(resolveBoundedDelayMs(opts.timeMs, "wait timeMs", MAX_WAIT_TIME_MS));
	if (opts.text) await page.getByText(opts.text).first().waitFor({
		state: "visible",
		timeout
	});
	if (opts.textGone) await page.getByText(opts.textGone).first().waitFor({
		state: "hidden",
		timeout
	});
	if (opts.selector) {
		const selector = String(opts.selector).trim();
		if (selector) await page.locator(selector).first().waitFor({
			state: "visible",
			timeout
		});
	}
	if (opts.url) {
		const url = String(opts.url).trim();
		if (url) await page.waitForURL(url, { timeout });
	}
	if (opts.loadState) await page.waitForLoadState(opts.loadState, { timeout });
	if (opts.fn) {
		const fn = String(opts.fn).trim();
		if (fn) await page.waitForFunction(fn, { timeout });
	}
}
async function takeScreenshotViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	restoreRoleRefsForTarget({
		cdpUrl: opts.cdpUrl,
		targetId: opts.targetId,
		page
	});
	const type = opts.type ?? "png";
	if (opts.ref) {
		if (opts.fullPage) throw new Error("fullPage is not supported for element screenshots");
		return { buffer: await refLocator(page, opts.ref).screenshot({ type }) };
	}
	if (opts.element) {
		if (opts.fullPage) throw new Error("fullPage is not supported for element screenshots");
		return { buffer: await page.locator(opts.element).first().screenshot({ type }) };
	}
	return { buffer: await page.screenshot({
		type,
		fullPage: Boolean(opts.fullPage)
	}) };
}
async function screenshotWithLabelsViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	restoreRoleRefsForTarget({
		cdpUrl: opts.cdpUrl,
		targetId: opts.targetId,
		page
	});
	const type = opts.type ?? "png";
	const maxLabels = typeof opts.maxLabels === "number" && Number.isFinite(opts.maxLabels) ? Math.max(1, Math.floor(opts.maxLabels)) : 150;
	const viewport = await page.evaluate(() => ({
		scrollX: window.scrollX || 0,
		scrollY: window.scrollY || 0,
		width: window.innerWidth || 0,
		height: window.innerHeight || 0
	}));
	const refs = Object.keys(opts.refs ?? {});
	const boxes = [];
	let skipped = 0;
	for (const ref of refs) {
		if (boxes.length >= maxLabels) {
			skipped += 1;
			continue;
		}
		try {
			const box = await refLocator(page, ref).boundingBox();
			if (!box) {
				skipped += 1;
				continue;
			}
			const x0 = box.x;
			const y0 = box.y;
			const x1 = box.x + box.width;
			const y1 = box.y + box.height;
			const vx0 = viewport.scrollX;
			const vy0 = viewport.scrollY;
			const vx1 = viewport.scrollX + viewport.width;
			const vy1 = viewport.scrollY + viewport.height;
			if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) {
				skipped += 1;
				continue;
			}
			boxes.push({
				ref,
				x: x0 - viewport.scrollX,
				y: y0 - viewport.scrollY,
				w: Math.max(1, box.width),
				h: Math.max(1, box.height)
			});
		} catch {
			skipped += 1;
		}
	}
	try {
		if (boxes.length > 0) await page.evaluate((labels) => {
			document.querySelectorAll("[data-openclaw-labels]").forEach((el) => el.remove());
			const root = document.createElement("div");
			root.setAttribute("data-openclaw-labels", "1");
			root.style.position = "fixed";
			root.style.left = "0";
			root.style.top = "0";
			root.style.zIndex = "2147483647";
			root.style.pointerEvents = "none";
			root.style.fontFamily = "\"SF Mono\",\"SFMono-Regular\",Menlo,Monaco,Consolas,\"Liberation Mono\",\"Courier New\",monospace";
			const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
			for (const label of labels) {
				const box = document.createElement("div");
				box.setAttribute("data-openclaw-labels", "1");
				box.style.position = "absolute";
				box.style.left = `${label.x}px`;
				box.style.top = `${label.y}px`;
				box.style.width = `${label.w}px`;
				box.style.height = `${label.h}px`;
				box.style.border = "2px solid #ffb020";
				box.style.boxSizing = "border-box";
				const tag = document.createElement("div");
				tag.setAttribute("data-openclaw-labels", "1");
				tag.textContent = label.ref;
				tag.style.position = "absolute";
				tag.style.left = `${label.x}px`;
				tag.style.top = `${clamp(label.y - 18, 0, 2e4)}px`;
				tag.style.background = "#ffb020";
				tag.style.color = "#1a1a1a";
				tag.style.fontSize = "12px";
				tag.style.lineHeight = "14px";
				tag.style.padding = "1px 4px";
				tag.style.borderRadius = "3px";
				tag.style.boxShadow = "0 1px 2px rgba(0,0,0,0.35)";
				tag.style.whiteSpace = "nowrap";
				root.appendChild(box);
				root.appendChild(tag);
			}
			document.documentElement.appendChild(root);
		}, boxes);
		return {
			buffer: await page.screenshot({ type }),
			labels: boxes.length,
			skipped
		};
	} finally {
		await page.evaluate(() => {
			document.querySelectorAll("[data-openclaw-labels]").forEach((el) => el.remove());
		}).catch(() => {});
	}
}
async function setInputFilesViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	restoreRoleRefsForTarget({
		cdpUrl: opts.cdpUrl,
		targetId: opts.targetId,
		page
	});
	if (!opts.paths.length) throw new Error("paths are required");
	const inputRef = typeof opts.inputRef === "string" ? opts.inputRef.trim() : "";
	const element = typeof opts.element === "string" ? opts.element.trim() : "";
	if (inputRef && element) throw new Error("inputRef and element are mutually exclusive");
	if (!inputRef && !element) throw new Error("inputRef or element is required");
	const locator = inputRef ? refLocator(page, inputRef) : page.locator(element).first();
	const uploadPathsResult = await resolveStrictExistingPathsWithinRoot({
		rootDir: DEFAULT_UPLOAD_DIR,
		requestedPaths: opts.paths,
		scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`
	});
	if (!uploadPathsResult.ok) throw new Error(uploadPathsResult.error);
	const resolvedPaths = uploadPathsResult.paths;
	try {
		await locator.setInputFiles(resolvedPaths);
	} catch (err) {
		throw toAIFriendlyError(err, inputRef || element);
	}
	try {
		const handle = await locator.elementHandle();
		if (handle) await handle.evaluate((el) => {
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		});
	} catch {}
}
const MAX_BATCH_DEPTH = 5;
async function executeSingleAction(action, cdpUrl, targetId, evaluateEnabled, depth = 0) {
	if (depth > MAX_BATCH_DEPTH) throw new Error(`Batch nesting depth exceeds maximum of ${MAX_BATCH_DEPTH}`);
	const effectiveTargetId = action.targetId ?? targetId;
	switch (action.kind) {
		case "click":
			await clickViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				ref: action.ref,
				selector: action.selector,
				doubleClick: action.doubleClick,
				button: action.button,
				modifiers: action.modifiers,
				delayMs: action.delayMs,
				timeoutMs: action.timeoutMs
			});
			break;
		case "type":
			await typeViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				ref: action.ref,
				selector: action.selector,
				text: action.text,
				submit: action.submit,
				slowly: action.slowly,
				timeoutMs: action.timeoutMs
			});
			break;
		case "press":
			await pressKeyViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				key: action.key,
				delayMs: action.delayMs
			});
			break;
		case "hover":
			await hoverViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				ref: action.ref,
				selector: action.selector,
				timeoutMs: action.timeoutMs
			});
			break;
		case "scrollIntoView":
			await scrollIntoViewViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				ref: action.ref,
				selector: action.selector,
				timeoutMs: action.timeoutMs
			});
			break;
		case "drag":
			await dragViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				startRef: action.startRef,
				startSelector: action.startSelector,
				endRef: action.endRef,
				endSelector: action.endSelector,
				timeoutMs: action.timeoutMs
			});
			break;
		case "select":
			await selectOptionViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				ref: action.ref,
				selector: action.selector,
				values: action.values,
				timeoutMs: action.timeoutMs
			});
			break;
		case "fill":
			await fillFormViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				fields: action.fields,
				timeoutMs: action.timeoutMs
			});
			break;
		case "resize":
			await resizeViewportViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				width: action.width,
				height: action.height
			});
			break;
		case "wait":
			if (action.fn && !evaluateEnabled) throw new Error("wait --fn is disabled by config (browser.evaluateEnabled=false)");
			await waitForViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				timeMs: action.timeMs,
				text: action.text,
				textGone: action.textGone,
				selector: action.selector,
				url: action.url,
				loadState: action.loadState,
				fn: action.fn,
				timeoutMs: action.timeoutMs
			});
			break;
		case "evaluate":
			if (!evaluateEnabled) throw new Error("act:evaluate is disabled by config (browser.evaluateEnabled=false)");
			await evaluateViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				fn: action.fn,
				ref: action.ref,
				timeoutMs: action.timeoutMs
			});
			break;
		case "close":
			await closePageViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId
			});
			break;
		case "batch":
			await batchViaPlaywright({
				cdpUrl,
				targetId: effectiveTargetId,
				actions: action.actions,
				stopOnError: action.stopOnError,
				evaluateEnabled,
				depth: depth + 1
			});
			break;
		default: throw new Error(`Unsupported batch action kind: ${action.kind}`);
	}
}
async function batchViaPlaywright(opts) {
	const depth = opts.depth ?? 0;
	if (depth > MAX_BATCH_DEPTH) throw new Error(`Batch nesting depth exceeds maximum of ${MAX_BATCH_DEPTH}`);
	if (opts.actions.length > MAX_BATCH_ACTIONS) throw new Error(`Batch exceeds maximum of ${MAX_BATCH_ACTIONS} actions`);
	const results = [];
	for (const action of opts.actions) try {
		await executeSingleAction(action, opts.cdpUrl, opts.targetId, opts.evaluateEnabled, depth);
		results.push({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		results.push({
			ok: false,
			error: message
		});
		if (opts.stopOnError !== false) break;
	}
	return { results };
}
//#endregion
//#region src/browser/pw-tools-core.responses.ts
async function responseBodyViaPlaywright(opts) {
	const pattern = String(opts.url ?? "").trim();
	if (!pattern) throw new Error("url is required");
	const maxChars = typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars) ? Math.max(1, Math.min(5e6, Math.floor(opts.maxChars))) : 2e5;
	const timeout = normalizeTimeoutMs(opts.timeoutMs, 2e4);
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	const resp = await new Promise((resolve, reject) => {
		let done = false;
		let timer;
		let handler;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			timer = void 0;
			if (handler) page.off("response", handler);
		};
		handler = (resp) => {
			if (done) return;
			if (!matchBrowserUrlPattern(pattern, resp.url?.() || "")) return;
			done = true;
			cleanup();
			resolve(resp);
		};
		page.on("response", handler);
		timer = setTimeout(() => {
			if (done) return;
			done = true;
			cleanup();
			reject(/* @__PURE__ */ new Error(`Response not found for url pattern "${pattern}". Run '${formatCliCommand("openclaw browser requests")}' to inspect recent network activity.`));
		}, timeout);
	});
	const url = resp.url?.() || "";
	const status = resp.status?.();
	const headers = resp.headers?.();
	let bodyText = "";
	try {
		if (typeof resp.text === "function") bodyText = await resp.text();
		else if (typeof resp.body === "function") {
			const buf = await resp.body();
			bodyText = new TextDecoder("utf-8").decode(buf);
		}
	} catch (err) {
		throw new Error(`Failed to read response body for "${url}": ${String(err)}`, { cause: err });
	}
	return {
		url,
		status,
		headers,
		body: bodyText.length > maxChars ? bodyText.slice(0, maxChars) : bodyText,
		truncated: bodyText.length > maxChars ? true : void 0
	};
}
//#endregion
//#region src/browser/pw-tools-core.state.ts
async function setOfflineViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	await page.context().setOffline(Boolean(opts.offline));
}
async function setExtraHTTPHeadersViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	await page.context().setExtraHTTPHeaders(opts.headers);
}
async function setHttpCredentialsViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	if (opts.clear) {
		await page.context().setHTTPCredentials(null);
		return;
	}
	const username = String(opts.username ?? "");
	const password = String(opts.password ?? "");
	if (!username) throw new Error("username is required (or set clear=true)");
	await page.context().setHTTPCredentials({
		username,
		password
	});
}
async function setGeolocationViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	const context = page.context();
	if (opts.clear) {
		await context.setGeolocation(null);
		await context.clearPermissions().catch(() => {});
		return;
	}
	if (typeof opts.latitude !== "number" || typeof opts.longitude !== "number") throw new Error("latitude and longitude are required (or set clear=true)");
	await context.setGeolocation({
		latitude: opts.latitude,
		longitude: opts.longitude,
		accuracy: typeof opts.accuracy === "number" ? opts.accuracy : void 0
	});
	const origin = opts.origin?.trim() || (() => {
		try {
			return new URL(page.url()).origin;
		} catch {
			return "";
		}
	})();
	if (origin) await context.grantPermissions(["geolocation"], { origin }).catch(() => {});
}
async function emulateMediaViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	await page.emulateMedia({ colorScheme: opts.colorScheme });
}
async function setLocaleViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	const locale = String(opts.locale ?? "").trim();
	if (!locale) throw new Error("locale is required");
	await withPageScopedCdpClient({
		cdpUrl: opts.cdpUrl,
		page,
		targetId: opts.targetId,
		fn: async (send) => {
			try {
				await send("Emulation.setLocaleOverride", { locale });
			} catch (err) {
				if (String(err).includes("Another locale override is already in effect")) return;
				throw err;
			}
		}
	});
}
async function setTimezoneViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	const timezoneId = String(opts.timezoneId ?? "").trim();
	if (!timezoneId) throw new Error("timezoneId is required");
	await withPageScopedCdpClient({
		cdpUrl: opts.cdpUrl,
		page,
		targetId: opts.targetId,
		fn: async (send) => {
			try {
				await send("Emulation.setTimezoneOverride", { timezoneId });
			} catch (err) {
				const msg = String(err);
				if (msg.includes("Timezone override is already in effect")) return;
				if (msg.includes("Invalid timezone")) throw new Error(`Invalid timezone ID: ${timezoneId}`, { cause: err });
				throw err;
			}
		}
	});
}
async function setDeviceViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	const name = String(opts.name ?? "").trim();
	if (!name) throw new Error("device name is required");
	const descriptor = devices[name];
	if (!descriptor) throw new Error(`Unknown device "${name}".`);
	if (descriptor.viewport) await page.setViewportSize({
		width: descriptor.viewport.width,
		height: descriptor.viewport.height
	});
	await withPageScopedCdpClient({
		cdpUrl: opts.cdpUrl,
		page,
		targetId: opts.targetId,
		fn: async (send) => {
			if (descriptor.userAgent || descriptor.locale) await send("Emulation.setUserAgentOverride", {
				userAgent: descriptor.userAgent ?? "",
				acceptLanguage: descriptor.locale ?? void 0
			});
			if (descriptor.viewport) await send("Emulation.setDeviceMetricsOverride", {
				mobile: Boolean(descriptor.isMobile),
				width: descriptor.viewport.width,
				height: descriptor.viewport.height,
				deviceScaleFactor: descriptor.deviceScaleFactor ?? 1,
				screenWidth: descriptor.viewport.width,
				screenHeight: descriptor.viewport.height
			});
			if (descriptor.hasTouch) await send("Emulation.setTouchEmulationEnabled", { enabled: true });
		}
	});
}
//#endregion
//#region src/browser/pw-tools-core.storage.ts
async function cookiesGetViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	return { cookies: await page.context().cookies() };
}
async function cookiesSetViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	const cookie = opts.cookie;
	if (!cookie.name || cookie.value === void 0) throw new Error("cookie name and value are required");
	const hasUrl = typeof cookie.url === "string" && cookie.url.trim();
	const hasDomainPath = typeof cookie.domain === "string" && cookie.domain.trim() && typeof cookie.path === "string" && cookie.path.trim();
	if (!hasUrl && !hasDomainPath) throw new Error("cookie requires url, or domain+path");
	await page.context().addCookies([cookie]);
}
async function cookiesClearViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	await page.context().clearCookies();
}
async function storageGetViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	const kind = opts.kind;
	const key = typeof opts.key === "string" ? opts.key : void 0;
	return { values: await page.evaluate(({ kind: kind2, key: key2 }) => {
		const store = kind2 === "session" ? window.sessionStorage : window.localStorage;
		if (key2) {
			const value = store.getItem(key2);
			return value === null ? {} : { [key2]: value };
		}
		const out = {};
		for (let i = 0; i < store.length; i += 1) {
			const k = store.key(i);
			if (!k) continue;
			const v = store.getItem(k);
			if (v !== null) out[k] = v;
		}
		return out;
	}, {
		kind,
		key
	}) ?? {} };
}
async function storageSetViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	const key = String(opts.key ?? "");
	if (!key) throw new Error("key is required");
	await page.evaluate(({ kind, key: k, value }) => {
		(kind === "session" ? window.sessionStorage : window.localStorage).setItem(k, value);
	}, {
		kind: opts.kind,
		key,
		value: String(opts.value ?? "")
	});
}
async function storageClearViaPlaywright(opts) {
	const page = await getPageForTargetId(opts);
	ensurePageState(page);
	await page.evaluate(({ kind }) => {
		(kind === "session" ? window.sessionStorage : window.localStorage).clear();
	}, { kind: opts.kind });
}
//#endregion
//#region src/browser/pw-tools-core.trace.ts
async function traceStartViaPlaywright(opts) {
	const context = (await getPageForTargetId(opts)).context();
	const ctxState = ensureContextState(context);
	if (ctxState.traceActive) throw new Error("Trace already running. Stop the current trace before starting a new one.");
	await context.tracing.start({
		screenshots: opts.screenshots ?? true,
		snapshots: opts.snapshots ?? true,
		sources: opts.sources ?? false
	});
	ctxState.traceActive = true;
}
async function traceStopViaPlaywright(opts) {
	const context = (await getPageForTargetId(opts)).context();
	const ctxState = ensureContextState(context);
	if (!ctxState.traceActive) throw new Error("No active trace. Start a trace before stopping it.");
	await writeViaSiblingTempPath({
		rootDir: DEFAULT_TRACE_DIR,
		targetPath: opts.path,
		writeTemp: async (tempPath) => {
			await context.tracing.stop({ path: tempPath });
		}
	});
	ctxState.traceActive = false;
}
//#endregion
//#region src/browser/pw-ai.ts
markPwAiLoaded();
//#endregion
export { armDialogViaPlaywright, armFileUploadViaPlaywright, batchViaPlaywright, clickViaPlaywright, closePageByTargetIdViaPlaywright, closePageViaPlaywright, closePlaywrightBrowserConnection, cookiesClearViaPlaywright, cookiesGetViaPlaywright, cookiesSetViaPlaywright, createPageViaPlaywright, downloadViaPlaywright, dragViaPlaywright, emulateMediaViaPlaywright, ensurePageState, evaluateViaPlaywright, fillFormViaPlaywright, focusPageByTargetIdViaPlaywright, forceDisconnectPlaywrightForTarget, getConsoleMessagesViaPlaywright, getNetworkRequestsViaPlaywright, getPageErrorsViaPlaywright, getPageForTargetId, highlightViaPlaywright, hoverViaPlaywright, listPagesViaPlaywright, navigateViaPlaywright, pdfViaPlaywright, pressKeyViaPlaywright, refLocator, resizeViewportViaPlaywright, responseBodyViaPlaywright, screenshotWithLabelsViaPlaywright, scrollIntoViewViaPlaywright, selectOptionViaPlaywright, setDeviceViaPlaywright, setExtraHTTPHeadersViaPlaywright, setGeolocationViaPlaywright, setHttpCredentialsViaPlaywright, setInputFilesViaPlaywright, setLocaleViaPlaywright, setOfflineViaPlaywright, setTimezoneViaPlaywright, snapshotAiViaPlaywright, snapshotAriaViaPlaywright, snapshotRoleViaPlaywright, storageClearViaPlaywright, storageGetViaPlaywright, storageSetViaPlaywright, takeScreenshotViaPlaywright, traceStartViaPlaywright, traceStopViaPlaywright, typeViaPlaywright, waitForDownloadViaPlaywright, waitForViaPlaywright };
