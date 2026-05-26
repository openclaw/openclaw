import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString$4 } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { f as pathScope } from "./fs-safe-CV86zY9G.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { c as getImageMetadata, o as buildImageResizeSideGrid, p as resizeToJpeg, r as IMAGE_REDUCE_QUALITY_STEPS, u as isImageProcessorUnavailableError } from "./media-services-CLFjOJQs.js";
import { a as ensureMediaDir, u as saveMediaBuffer } from "./store-rQFzzX5P.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { C as BrowserTabNotFoundError, E as toBrowserErrorResponse, L as DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS, R as DEFAULT_AI_SNAPSHOT_MAX_CHARS, T as BrowserValidationError, W as DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS, _ as BrowserConflictError, b as BrowserProfileUnavailableError, d as parseBrowserHttpUrl, f as redactCdpUrl, n as assertCdpEndpointAllowed, p as withCdpSocket, v as BrowserError, w as BrowserTargetAmbiguousError, y as BrowserProfileNotFoundError } from "./cdp.helpers-D-78hr0t.js";
import { a as DEFAULT_DOWNLOAD_DIR, i as resolveProfile, o as DEFAULT_TRACE_DIR, r as resolveManagedBrowserHeadlessMode, s as DEFAULT_UPLOAD_DIR } from "./config-F211Ihcd.js";
import "./config-CblF4FCf.js";
import "./errors-BUgcAIYJ.js";
import { i as isValidProfileName, n as deleteBrowserProfileConfig, t as createBrowserProfileConfig } from "./config-mutations-DKye8C0d.js";
import { r as resolveBrowserExecutableForPlatform } from "./chrome.executables-C_GQZhm-.js";
import { t as movePathToTrash } from "./trash-9JTCtLvh.js";
import { n as normalizeString } from "./record-shared-D84z0tk0.js";
import "./sdk-setup-tools-C1n7gEuG.js";
import { E as uploadChromeMcpFile, T as takeChromeMcpSnapshot, _ as navigateChromeMcpPage, a as closeChromeMcpTab, c as evaluateChromeMcpScript, f as getChromeMcpPid, l as fillChromeMcpElement, m as hoverChromeMcpElement, n as clickChromeMcpCoords, o as dragChromeMcpElement, r as clickChromeMcpElement, u as fillChromeMcpForm, w as takeChromeMcpScreenshot, x as resizeChromeMcpPage, y as pressChromeMcpKey } from "./chrome-mcp-8F7lv9bk.js";
import { E as withBrowserNavigationPolicy, S as assertBrowserNavigationAllowed, _ as INTERACTIVE_ROLES, a as resolveOpenClawUserDataDir, b as resolveBrowserNavigationProxyMode, g as CONTENT_ROLES, h as snapshotRoleViaCdp, m as snapshotAria, t as getChromeWebSocketUrl, u as captureScreenshot, v as STRUCTURAL_ROLES, w as assertBrowserNavigationResultAllowed, y as ensureOutputDirectory } from "./chrome-BZjIEoo0.js";
import { a as shouldUsePlaywrightForAriaSnapshot, i as resolveDefaultSnapshotFormat, n as getPwAiModule$1, o as shouldUsePlaywrightForScreenshot, r as getBrowserProfileCapabilities, t as resolveTargetIdFromTabs } from "./target-id-BUwa2OxY.js";
import { c as ACT_MAX_CLICK_DELAY_MS, l as ACT_MAX_WAIT_TIME_MS, o as normalizeBrowserFormField, p as matchBrowserUrlPattern, r as getRoleSnapshotStats, u as normalizeActBoundedNonNegativeMs } from "./pw-role-snapshot-Bmne5jZK.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
//#region extensions/browser/src/browser/routes/utils.ts
function normalizeOptionalString$3(value) {
	return value.trim() || void 0;
}
function asyncBrowserRoute(handler) {
	return (req, res) => handler(req, res);
}
/**
* Extract profile name from query string or body and get profile context.
* Query string takes precedence over body for consistency with GET routes.
*/
function getProfileContext(req, ctx) {
	let profileName;
	if (typeof req.query.profile === "string") profileName = normalizeOptionalString$3(req.query.profile);
	if (!profileName && req.body && typeof req.body === "object") {
		const body = req.body;
		if (typeof body.profile === "string") profileName = normalizeOptionalString$3(body.profile);
	}
	try {
		return ctx.forProfile(profileName);
	} catch (err) {
		return {
			error: String(err),
			status: 404
		};
	}
}
function jsonError(res, status, message) {
	res.status(status).json({ error: message });
}
function toStringOrEmpty(value) {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return normalizeOptionalString$3(String(value)) ?? "";
	return "";
}
function toNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	const normalized = typeof value === "string" ? normalizeOptionalString$3(value) : void 0;
	if (normalized) {
		const parsed = Number(normalized);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function toBoolean(value) {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string" && typeof value !== "number") return;
	const normalized = String(value).trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
	if (normalized === "false" || normalized === "0" || normalized === "no") return false;
}
function toStringArray(value) {
	if (!Array.isArray(value)) return;
	const strings = value.map((v) => toStringOrEmpty(v)).filter(Boolean);
	return strings.length ? strings : void 0;
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.shared.ts
function normalizeOptionalString$2(value) {
	return typeof value === "string" ? value.trim() || void 0 : void 0;
}
const SELECTOR_UNSUPPORTED_MESSAGE = [
	"Error: 'selector' is not supported. Use 'ref' from snapshot instead.",
	"",
	"Example workflow:",
	"1. snapshot action to get page state with refs",
	"2. act with ref: \"e123\" to interact with element",
	"",
	"This is more reliable for modern SPAs."
].join("\n");
function readBody(req) {
	const body = req.body;
	if (!body || typeof body !== "object" || Array.isArray(body)) return {};
	return body;
}
function resolveTargetIdFromBody(body) {
	return (normalizeOptionalString$2(body.targetId) ?? "") || void 0;
}
function resolveTargetIdFromQuery(query) {
	return (normalizeOptionalString$2(query.targetId) ?? "") || void 0;
}
function handleRouteError(ctx, res, err) {
	const mapped = ctx.mapTabError(err);
	if (mapped) return jsonError(res, mapped.status, mapped.message);
	const browserMapped = toBrowserErrorResponse(err);
	if (browserMapped) return jsonError(res, browserMapped.status, browserMapped.message);
	jsonError(res, 500, String(err));
}
function resolveProfileContext(req, res, ctx) {
	const profileCtx = getProfileContext(req, ctx);
	if ("error" in profileCtx) {
		jsonError(res, profileCtx.status, profileCtx.error);
		return null;
	}
	return profileCtx;
}
async function getPwAiModule() {
	return await getPwAiModule$1({ mode: "soft" });
}
async function requirePwAi(res, feature) {
	const mod = await getPwAiModule();
	if (mod) return mod;
	jsonError(res, 501, [
		`Playwright is not available in this gateway build; '${feature}' is unsupported.`,
		"Reinstall or update OpenClaw so the core browser runtime dependency is present, then restart the gateway. In Docker, also install Chromium with the bundled playwright-core CLI.",
		"Docs: /tools/browser#playwright-requirement"
	].join("\n"));
	return null;
}
async function withRouteTabContext(params) {
	const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
	if (!profileCtx) return;
	try {
		const tab = await profileCtx.ensureTabAvailable(params.targetId);
		if (params.enforceCurrentUrlAllowed) await assertBrowserNavigationResultAllowed({
			url: tab.url,
			...withBrowserNavigationPolicy(params.ctx.state().resolved.ssrfPolicy, { browserProxyMode: resolveBrowserNavigationProxyMode({
				resolved: params.ctx.state().resolved,
				profile: profileCtx.profile
			}) })
		});
		return await params.run({
			profileCtx,
			tab,
			cdpUrl: profileCtx.profile.cdpUrl,
			resolveTabUrl: (fallbackUrl) => resolveSafeRouteTabUrl({
				ctx: params.ctx,
				profileCtx,
				targetId: tab.targetId,
				fallbackUrl
			})
		});
	} catch (err) {
		handleRouteError(params.ctx, params.res, err);
		return;
	}
}
/**
* Response-only URL redaction. This swallows policy failures and must not be used as
* an execution gate; use enforceCurrentUrlAllowed on the route helper instead.
*/
async function resolveSafeRouteTabUrl(params) {
	const candidateUrl = (await params.profileCtx.listTabs().catch(() => [])).find((tab) => tab.targetId === params.targetId)?.url ?? params.fallbackUrl;
	if (!candidateUrl) return;
	try {
		await assertBrowserNavigationResultAllowed({
			url: candidateUrl,
			...withBrowserNavigationPolicy(params.ctx.state().resolved.ssrfPolicy, { browserProxyMode: resolveBrowserNavigationProxyMode({
				resolved: params.ctx.state().resolved,
				profile: params.profileCtx.profile
			}) })
		});
		return candidateUrl;
	} catch {
		return;
	}
}
async function withPlaywrightRouteContext(params) {
	return await withRouteTabContext({
		req: params.req,
		res: params.res,
		ctx: params.ctx,
		targetId: params.targetId,
		enforceCurrentUrlAllowed: params.enforceCurrentUrlAllowed,
		run: async ({ profileCtx, tab, cdpUrl, resolveTabUrl }) => {
			const pw = await requirePwAi(params.res, params.feature);
			if (!pw) return;
			return await params.run({
				profileCtx,
				tab,
				cdpUrl,
				resolveTabUrl,
				pw
			});
		}
	});
}
//#endregion
//#region extensions/browser/src/browser/routes/existing-session-limits.ts
const EXISTING_SESSION_LIMITS = {
	act: {
		clickSelector: "existing-session click does not support selector targeting yet; use ref.",
		clickButtonOrModifiers: "existing-session click currently supports left-click only (no button overrides/modifiers).",
		typeSelector: "existing-session type does not support selector targeting yet; use ref.",
		typeSlowly: "existing-session type does not support slowly=true; use fill/press instead.",
		typeTimeout: "existing-session type does not support timeoutMs overrides.",
		pressDelay: "existing-session press does not support delayMs.",
		hoverSelector: "existing-session hover does not support selector targeting yet; use ref.",
		hoverTimeout: "existing-session hover does not support timeoutMs overrides.",
		scrollSelector: "existing-session scrollIntoView does not support selector targeting yet; use ref.",
		scrollTimeout: "existing-session scrollIntoView does not support timeoutMs overrides.",
		dragSelector: "existing-session drag does not support selector targeting yet; use startRef/endRef.",
		dragTimeout: "existing-session drag does not support timeoutMs overrides.",
		selectSelector: "existing-session select does not support selector targeting yet; use ref.",
		selectSingleValue: "existing-session select currently supports a single value only.",
		selectTimeout: "existing-session select does not support timeoutMs overrides.",
		fillTimeout: "existing-session fill does not support timeoutMs overrides.",
		waitNetworkIdle: "existing-session wait does not support loadState=networkidle yet.",
		evaluateTimeout: "existing-session evaluate does not support timeoutMs overrides.",
		batch: "existing-session batch is not supported yet; send actions individually."
	},
	hooks: {
		uploadElement: "existing-session file uploads do not support element selectors; use ref/inputRef.",
		uploadSingleFile: "existing-session file uploads currently support one file at a time.",
		uploadRefRequired: "existing-session file uploads require ref or inputRef.",
		dialogId: "existing-session dialog handling does not support dialogId.",
		dialogTimeout: "existing-session dialog handling does not support timeoutMs."
	},
	download: {
		waitUnsupported: "download waiting is not supported for existing-session profiles yet.",
		downloadUnsupported: "downloads are not supported for existing-session profiles yet."
	},
	snapshot: {
		pdfUnsupported: "pdf is not supported for existing-session profiles yet; use screenshot/snapshot instead.",
		screenshotElement: "element screenshots are not supported for existing-session profiles; use ref from snapshot.",
		snapshotSelector: "selector/frame snapshots are not supported for existing-session profiles; snapshot the whole page and use refs."
	},
	responseBody: "response body is not supported for existing-session profiles yet."
};
//#endregion
//#region extensions/browser/src/browser/routes/output-paths.ts
async function ensureOutputRootDir(rootDir) {
	await ensureOutputDirectory(rootDir);
}
async function resolveWritableOutputPathOrRespond(params) {
	if (params.ensureRootDir) await ensureOutputRootDir(params.rootDir);
	const pathResult = await pathScope(params.rootDir, { label: params.scopeLabel }).writable(params.requestedPath, { defaultName: params.defaultFileName });
	if (!pathResult.ok) {
		params.res.status(400).json({ error: pathResult.error });
		return null;
	}
	return pathResult.path;
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.act.download.ts
function buildDownloadRequestBase(cdpUrl, targetId, timeoutMs) {
	return {
		cdpUrl,
		targetId,
		timeoutMs: timeoutMs ?? void 0
	};
}
function registerBrowserAgentActDownloadRoutes(app, ctx) {
	app.post("/wait/download", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const out = toStringOrEmpty(body.path) || "";
		const timeoutMs = toNumber(body.timeoutMs);
		await withRouteTabContext({
			req,
			res,
			ctx,
			targetId,
			run: async ({ profileCtx, cdpUrl, tab }) => {
				if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) return jsonError(res, 501, EXISTING_SESSION_LIMITS.download.waitUnsupported);
				const pw = await requirePwAi(res, "wait for download");
				if (!pw) return;
				await ensureOutputRootDir(DEFAULT_DOWNLOAD_DIR);
				let downloadPath;
				if (out.trim()) {
					const resolvedDownloadPath = await resolveWritableOutputPathOrRespond({
						res,
						rootDir: DEFAULT_DOWNLOAD_DIR,
						requestedPath: out,
						scopeLabel: "downloads directory"
					});
					if (!resolvedDownloadPath) return;
					downloadPath = resolvedDownloadPath;
				}
				const requestBase = buildDownloadRequestBase(cdpUrl, tab.targetId, timeoutMs);
				const result = await pw.waitForDownloadViaPlaywright({
					...requestBase,
					path: downloadPath,
					rootDir: DEFAULT_DOWNLOAD_DIR
				});
				res.json({
					ok: true,
					targetId: tab.targetId,
					download: result
				});
			}
		});
	}));
	app.post("/download", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const ref = toStringOrEmpty(body.ref);
		const out = toStringOrEmpty(body.path);
		const timeoutMs = toNumber(body.timeoutMs);
		if (!ref) return jsonError(res, 400, "ref is required");
		if (!out) return jsonError(res, 400, "path is required");
		await withRouteTabContext({
			req,
			res,
			ctx,
			targetId,
			run: async ({ profileCtx, cdpUrl, tab }) => {
				if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) return jsonError(res, 501, EXISTING_SESSION_LIMITS.download.downloadUnsupported);
				const pw = await requirePwAi(res, "download");
				if (!pw) return;
				await ensureOutputRootDir(DEFAULT_DOWNLOAD_DIR);
				const downloadPath = await resolveWritableOutputPathOrRespond({
					res,
					rootDir: DEFAULT_DOWNLOAD_DIR,
					requestedPath: out,
					scopeLabel: "downloads directory"
				});
				if (!downloadPath) return;
				const requestBase = buildDownloadRequestBase(cdpUrl, tab.targetId, timeoutMs);
				const result = await pw.downloadViaPlaywright({
					...requestBase,
					ref,
					path: downloadPath,
					rootDir: DEFAULT_DOWNLOAD_DIR
				});
				res.json({
					ok: true,
					targetId: tab.targetId,
					download: result
				});
			}
		});
	}));
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.act.errors.ts
const ACT_ERROR_CODES = {
	kindRequired: "ACT_KIND_REQUIRED",
	invalidRequest: "ACT_INVALID_REQUEST",
	selectorUnsupported: "ACT_SELECTOR_UNSUPPORTED",
	evaluateDisabled: "ACT_EVALUATE_DISABLED",
	unsupportedForExistingSession: "ACT_EXISTING_SESSION_UNSUPPORTED",
	targetIdMismatch: "ACT_TARGET_ID_MISMATCH"
};
function jsonActError(res, status, code, message) {
	res.status(status).json({
		error: message,
		code
	});
}
function browserEvaluateDisabledMessage(action) {
	return [action === "wait" ? "wait --fn is disabled by config (browser.evaluateEnabled=false)." : "act:evaluate is disabled by config (browser.evaluateEnabled=false).", "Docs: /gateway/configuration#browser-openclaw-managed-browser"].join("\n");
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.act.hooks.ts
function registerBrowserAgentActHookRoutes(app, ctx) {
	app.post("/hooks/file-chooser", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const ref = toStringOrEmpty(body.ref) || void 0;
		const inputRef = toStringOrEmpty(body.inputRef) || void 0;
		const element = toStringOrEmpty(body.element) || void 0;
		const paths = toStringArray(body.paths) ?? [];
		const timeoutMs = toNumber(body.timeoutMs);
		if (!paths.length) return jsonError(res, 400, "paths are required");
		await withRouteTabContext({
			req,
			res,
			ctx,
			targetId,
			run: async ({ profileCtx, cdpUrl, tab }) => {
				const uploadPathsResult = await pathScope(DEFAULT_UPLOAD_DIR, { label: `uploads directory (${DEFAULT_UPLOAD_DIR})` }).existing(paths);
				if (!uploadPathsResult.ok) {
					res.status(400).json({ error: uploadPathsResult.error });
					return;
				}
				const resolvedPaths = uploadPathsResult.paths;
				if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
					if (element) return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.uploadElement);
					if (resolvedPaths.length !== 1) return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.uploadSingleFile);
					const uid = inputRef || ref;
					if (!uid) return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.uploadRefRequired);
					await uploadChromeMcpFile({
						profileName: profileCtx.profile.name,
						profile: profileCtx.profile,
						targetId: tab.targetId,
						uid,
						filePath: resolvedPaths[0] ?? ""
					});
					return res.json({ ok: true });
				}
				const pw = await requirePwAi(res, "file chooser hook");
				if (!pw) return;
				if (inputRef || element) {
					if (ref) return jsonError(res, 400, "ref cannot be combined with inputRef/element");
					await pw.setInputFilesViaPlaywright({
						cdpUrl,
						targetId: tab.targetId,
						inputRef,
						element,
						paths: resolvedPaths
					});
				} else {
					await pw.armFileUploadViaPlaywright({
						cdpUrl,
						targetId: tab.targetId,
						paths: resolvedPaths,
						timeoutMs: timeoutMs ?? void 0
					});
					if (ref) await pw.clickViaPlaywright({
						cdpUrl,
						targetId: tab.targetId,
						ssrfPolicy: ctx.state().resolved.ssrfPolicy,
						ref
					});
				}
				res.json({ ok: true });
			}
		});
	}));
	app.post("/hooks/dialog", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const accept = toBoolean(body.accept);
		const promptText = toStringOrEmpty(body.promptText) || void 0;
		const timeoutMs = toNumber(body.timeoutMs);
		const dialogId = toStringOrEmpty(body.dialogId) || void 0;
		if (accept === void 0) return jsonError(res, 400, "accept is required");
		await withRouteTabContext({
			req,
			res,
			ctx,
			targetId,
			run: async ({ profileCtx, cdpUrl, tab }) => {
				if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
					if (dialogId) return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.dialogId);
					if (timeoutMs) return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.dialogTimeout);
					await evaluateChromeMcpScript({
						profileName: profileCtx.profile.name,
						profile: profileCtx.profile,
						targetId: tab.targetId,
						fn: `() => {
              const state = (window.__openclawDialogHook ??= {});
              if (!state.originals) {
                state.originals = {
                  alert: window.alert.bind(window),
                  confirm: window.confirm.bind(window),
                  prompt: window.prompt.bind(window),
                };
              }
              const originals = state.originals;
              const restore = () => {
                window.alert = originals.alert;
                window.confirm = originals.confirm;
                window.prompt = originals.prompt;
                delete window.__openclawDialogHook;
              };
              window.alert = (...args) => {
                try {
                  return undefined;
                } finally {
                  restore();
                }
              };
              window.confirm = (...args) => {
                try {
                  return ${accept ? "true" : "false"};
                } finally {
                  restore();
                }
              };
              window.prompt = (...args) => {
                try {
                  return ${accept ? JSON.stringify(promptText ?? "") : "null"};
                } finally {
                  restore();
                }
              };
              return true;
            }`
					});
					return res.json({ ok: true });
				}
				const pw = await requirePwAi(res, "dialog hook");
				if (!pw) return;
				await pw.armDialogViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					dialogId,
					accept,
					promptText,
					timeoutMs: timeoutMs ?? void 0
				});
				res.json({ ok: true });
			}
		});
	}));
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.act.shared.ts
const ACT_KINDS = [
	"batch",
	"click",
	"clickCoords",
	"close",
	"drag",
	"evaluate",
	"fill",
	"hover",
	"scrollIntoView",
	"press",
	"resize",
	"select",
	"type",
	"wait"
];
function isActKind(value) {
	if (typeof value !== "string") return false;
	return ACT_KINDS.includes(value);
}
const ALLOWED_CLICK_MODIFIERS = new Set([
	"Alt",
	"Control",
	"ControlOrMeta",
	"Meta",
	"Shift"
]);
function parseClickButton(raw) {
	if (raw === "left" || raw === "right" || raw === "middle") return raw;
}
function parseClickModifiers(raw) {
	if (raw.filter((m) => !ALLOWED_CLICK_MODIFIERS.has(m)).length) return { error: "modifiers must be Alt|Control|ControlOrMeta|Meta|Shift" };
	return { modifiers: raw.length ? raw : void 0 };
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.act.normalize.ts
function normalizeActKind(raw) {
	const kind = toStringOrEmpty(raw);
	if (!isActKind(kind)) throw new Error("kind is required");
	return kind;
}
function countBatchActions(actions) {
	let count = 0;
	for (const action of actions) {
		count += 1;
		if (action.kind === "batch") count += countBatchActions(action.actions);
	}
	return count;
}
function validateBatchTargetIds(actions, targetId) {
	for (const action of actions) {
		if (action.targetId && action.targetId !== targetId) return "batched action targetId must match request targetId";
		if (action.kind === "batch") {
			const nestedError = validateBatchTargetIds(action.actions, targetId);
			if (nestedError) return nestedError;
		}
	}
	return null;
}
function normalizeFields(rawFields) {
	return (Array.isArray(rawFields) ? rawFields : []).map((field) => {
		if (!field || typeof field !== "object") return null;
		return normalizeBrowserFormField(field);
	}).filter((field) => field !== null);
}
function normalizeBatchAction(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("batch actions must be objects");
	return normalizeActRequest(value, { source: "batch" });
}
function normalizeActRequest(body, options) {
	const source = options?.source ?? "request";
	const kind = normalizeActKind(body.kind);
	switch (kind) {
		case "click": {
			const ref = toStringOrEmpty(body.ref) || void 0;
			const selector = toStringOrEmpty(body.selector) || void 0;
			if (!ref && !selector) throw new Error("click requires ref or selector");
			const buttonRaw = toStringOrEmpty(body.button);
			const button = buttonRaw ? parseClickButton(buttonRaw) : void 0;
			if (buttonRaw && !button) throw new Error("click button must be left|right|middle");
			const parsedModifiers = parseClickModifiers(toStringArray(body.modifiers) ?? []);
			if (parsedModifiers.error) throw new Error(parsedModifiers.error);
			const doubleClick = toBoolean(body.doubleClick);
			const delayMs = normalizeActBoundedNonNegativeMs(toNumber(body.delayMs), "click delayMs", ACT_MAX_CLICK_DELAY_MS);
			const timeoutMs = toNumber(body.timeoutMs);
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			return {
				kind,
				...ref ? { ref } : {},
				...selector ? { selector } : {},
				...targetId ? { targetId } : {},
				...doubleClick !== void 0 ? { doubleClick } : {},
				...button ? { button } : {},
				...parsedModifiers.modifiers ? { modifiers: parsedModifiers.modifiers } : {},
				...delayMs !== void 0 ? { delayMs } : {},
				...timeoutMs !== void 0 ? { timeoutMs } : {}
			};
		}
		case "clickCoords": {
			const x = toNumber(body.x);
			const y = toNumber(body.y);
			if (x === void 0 || y === void 0 || x < 0 || y < 0) throw new Error("clickCoords requires non-negative x and y");
			const buttonRaw = toStringOrEmpty(body.button);
			const button = buttonRaw ? parseClickButton(buttonRaw) : void 0;
			if (buttonRaw && !button) throw new Error("clickCoords button must be left|right|middle");
			const doubleClick = toBoolean(body.doubleClick);
			const delayMs = normalizeActBoundedNonNegativeMs(toNumber(body.delayMs), "clickCoords delayMs", ACT_MAX_CLICK_DELAY_MS);
			const timeoutMs = toNumber(body.timeoutMs);
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			return {
				kind,
				x,
				y,
				...targetId ? { targetId } : {},
				...doubleClick !== void 0 ? { doubleClick } : {},
				...button ? { button } : {},
				...delayMs !== void 0 ? { delayMs } : {},
				...timeoutMs !== void 0 ? { timeoutMs } : {}
			};
		}
		case "type": {
			const ref = toStringOrEmpty(body.ref) || void 0;
			const selector = toStringOrEmpty(body.selector) || void 0;
			const text = body.text;
			if (!ref && !selector) throw new Error("type requires ref or selector");
			if (typeof text !== "string") throw new Error("type requires text");
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			const submit = toBoolean(body.submit);
			const slowly = toBoolean(body.slowly);
			const timeoutMs = toNumber(body.timeoutMs);
			return {
				kind,
				...ref ? { ref } : {},
				...selector ? { selector } : {},
				text,
				...targetId ? { targetId } : {},
				...submit !== void 0 ? { submit } : {},
				...slowly !== void 0 ? { slowly } : {},
				...timeoutMs !== void 0 ? { timeoutMs } : {}
			};
		}
		case "press": {
			const key = toStringOrEmpty(body.key);
			if (!key) throw new Error("press requires key");
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			const delayMs = toNumber(body.delayMs);
			return {
				kind,
				key,
				...targetId ? { targetId } : {},
				...delayMs !== void 0 ? { delayMs } : {}
			};
		}
		case "hover":
		case "scrollIntoView": {
			const ref = toStringOrEmpty(body.ref) || void 0;
			const selector = toStringOrEmpty(body.selector) || void 0;
			if (!ref && !selector) throw new Error(`${kind} requires ref or selector`);
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			const timeoutMs = toNumber(body.timeoutMs);
			return {
				kind,
				...ref ? { ref } : {},
				...selector ? { selector } : {},
				...targetId ? { targetId } : {},
				...timeoutMs !== void 0 ? { timeoutMs } : {}
			};
		}
		case "drag": {
			const startRef = toStringOrEmpty(body.startRef) || void 0;
			const startSelector = toStringOrEmpty(body.startSelector) || void 0;
			const endRef = toStringOrEmpty(body.endRef) || void 0;
			const endSelector = toStringOrEmpty(body.endSelector) || void 0;
			if (!startRef && !startSelector) throw new Error("drag requires startRef or startSelector");
			if (!endRef && !endSelector) throw new Error("drag requires endRef or endSelector");
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			const timeoutMs = toNumber(body.timeoutMs);
			return {
				kind,
				...startRef ? { startRef } : {},
				...startSelector ? { startSelector } : {},
				...endRef ? { endRef } : {},
				...endSelector ? { endSelector } : {},
				...targetId ? { targetId } : {},
				...timeoutMs !== void 0 ? { timeoutMs } : {}
			};
		}
		case "select": {
			const ref = toStringOrEmpty(body.ref) || void 0;
			const selector = toStringOrEmpty(body.selector) || void 0;
			const values = toStringArray(body.values);
			if (!ref && !selector || !values?.length) throw new Error("select requires ref/selector and values");
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			const timeoutMs = toNumber(body.timeoutMs);
			return {
				kind,
				...ref ? { ref } : {},
				...selector ? { selector } : {},
				values,
				...targetId ? { targetId } : {},
				...timeoutMs !== void 0 ? { timeoutMs } : {}
			};
		}
		case "fill": {
			const fields = normalizeFields(body.fields);
			if (!fields.length) throw new Error("fill requires fields");
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			const timeoutMs = toNumber(body.timeoutMs);
			return {
				kind,
				fields,
				...targetId ? { targetId } : {},
				...timeoutMs !== void 0 ? { timeoutMs } : {}
			};
		}
		case "resize": {
			const width = toNumber(body.width);
			const height = toNumber(body.height);
			if (width === void 0 || height === void 0 || width <= 0 || height <= 0) throw new Error("resize requires positive width and height");
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			return {
				kind,
				width,
				height,
				...targetId ? { targetId } : {}
			};
		}
		case "wait": {
			const loadStateRaw = toStringOrEmpty(body.loadState);
			const loadState = loadStateRaw === "load" || loadStateRaw === "domcontentloaded" || loadStateRaw === "networkidle" ? loadStateRaw : void 0;
			const timeMs = normalizeActBoundedNonNegativeMs(toNumber(body.timeMs), "wait timeMs", ACT_MAX_WAIT_TIME_MS);
			const text = toStringOrEmpty(body.text) || void 0;
			const textGone = toStringOrEmpty(body.textGone) || void 0;
			const selector = toStringOrEmpty(body.selector) || void 0;
			const url = toStringOrEmpty(body.url) || void 0;
			const fn = toStringOrEmpty(body.fn) || void 0;
			if (timeMs === void 0 && !text && !textGone && !selector && !url && !loadState && !fn) throw new Error("wait requires at least one of: timeMs, text, textGone, selector, url, loadState, fn");
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			const timeoutMs = toNumber(body.timeoutMs);
			return {
				kind,
				...timeMs !== void 0 ? { timeMs } : {},
				...text ? { text } : {},
				...textGone ? { textGone } : {},
				...selector ? { selector } : {},
				...url ? { url } : {},
				...loadState ? { loadState } : {},
				...fn ? { fn } : {},
				...targetId ? { targetId } : {},
				...timeoutMs !== void 0 ? { timeoutMs } : {}
			};
		}
		case "evaluate": {
			const fn = toStringOrEmpty(body.fn);
			if (!fn) throw new Error("evaluate requires fn");
			const ref = toStringOrEmpty(body.ref) || void 0;
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			const timeoutMs = toNumber(body.timeoutMs);
			return {
				kind,
				fn,
				...ref ? { ref } : {},
				...targetId ? { targetId } : {},
				...timeoutMs !== void 0 ? { timeoutMs } : {}
			};
		}
		case "close": {
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			return {
				kind,
				...targetId ? { targetId } : {}
			};
		}
		case "batch": {
			const actions = Array.isArray(body.actions) ? body.actions.map(normalizeBatchAction) : [];
			if (!actions.length) throw new Error(source === "batch" ? "batch requires actions" : "actions are required");
			if (countBatchActions(actions) > 100) throw new Error(`batch exceeds maximum of 100 actions`);
			const targetId = toStringOrEmpty(body.targetId) || void 0;
			const stopOnError = toBoolean(body.stopOnError);
			return {
				kind,
				actions,
				...targetId ? { targetId } : {},
				...stopOnError !== void 0 ? { stopOnError } : {}
			};
		}
	}
	throw new Error("Unsupported browser act kind");
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.snapshot-target.ts
/** Resolve the correct targetId after a navigation that may trigger a renderer swap. */
async function resolveTargetIdAfterNavigate(opts) {
	let currentTargetId = opts.oldTargetId;
	try {
		const pickReplacement = (tabs, options) => {
			if (tabs.some((tab) => tab.targetId === opts.oldTargetId)) return {
				targetId: opts.oldTargetId,
				shouldRetry: false
			};
			const byUrl = tabs.filter((tab) => tab.url === opts.navigatedUrl);
			if (byUrl.length === 1) return {
				targetId: byUrl[0]?.targetId ?? opts.oldTargetId,
				shouldRetry: false
			};
			const uniqueReplacement = byUrl.filter((tab) => tab.targetId !== opts.oldTargetId);
			if (uniqueReplacement.length === 1) return {
				targetId: uniqueReplacement[0]?.targetId ?? opts.oldTargetId,
				shouldRetry: false
			};
			if (options?.allowSingleTabFallback && tabs.length === 1) return {
				targetId: tabs[0]?.targetId ?? opts.oldTargetId,
				shouldRetry: false
			};
			return {
				targetId: opts.oldTargetId,
				shouldRetry: true
			};
		};
		const first = pickReplacement(await opts.listTabs());
		currentTargetId = first.targetId;
		if (first.shouldRetry) {
			await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 800));
			currentTargetId = pickReplacement(await opts.listTabs(), { allowSingleTabFallback: true }).targetId;
		}
	} catch {}
	return currentTargetId;
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.act.ts
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
const EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS = [
	0,
	250,
	500
];
async function readExistingSessionLocationHref(params) {
	const currentUrl = await evaluateChromeMcpScript({
		profileName: params.profileName,
		profile: params.profile,
		userDataDir: params.userDataDir,
		targetId: params.targetId,
		fn: "() => window.location.href"
	});
	if (typeof currentUrl !== "string") throw new Error("Location probe returned a non-string result");
	const normalizedUrl = currentUrl.trim();
	if (!normalizedUrl) throw new Error("Location probe returned an empty URL");
	return normalizedUrl;
}
async function assertExistingSessionPostInteractionNavigationAllowed(params) {
	const ssrfPolicyOpts = withBrowserNavigationPolicy(params.ssrfPolicy);
	if (!ssrfPolicyOpts.ssrfPolicy) return;
	const listTabs = params.listTabs;
	const initialTabTargetIds = params.initialTabTargetIds;
	const assertNewTabsAllowed = async () => {
		const tabs = await listTabs();
		for (const tab of tabs) {
			if (initialTabTargetIds.has(tab.targetId)) continue;
			await assertBrowserNavigationResultAllowed({
				url: tab.url,
				...ssrfPolicyOpts
			});
		}
	};
	let lastObservedUrl;
	let sawStableAllowedUrl = false;
	for (const delayMs of EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS) {
		if (delayMs > 0) await sleep(delayMs);
		let currentUrl;
		try {
			currentUrl = await readExistingSessionLocationHref(params);
		} catch {
			sawStableAllowedUrl = false;
			continue;
		}
		await assertBrowserNavigationResultAllowed({
			url: currentUrl,
			...ssrfPolicyOpts
		});
		if (currentUrl === lastObservedUrl) sawStableAllowedUrl = true;
		else sawStableAllowedUrl = false;
		lastObservedUrl = currentUrl;
	}
	if (sawStableAllowedUrl) {
		await assertNewTabsAllowed();
		return;
	}
	if (lastObservedUrl) {
		const lastDelay = EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS[EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS.length - 1];
		await sleep(lastDelay);
		try {
			const followUpUrl = await readExistingSessionLocationHref(params);
			await assertBrowserNavigationResultAllowed({
				url: followUpUrl,
				...ssrfPolicyOpts
			});
			if (followUpUrl === lastObservedUrl) {
				await assertNewTabsAllowed();
				return;
			}
		} catch {}
	}
	throw new Error("Unable to verify stable post-interaction navigation");
}
async function runExistingSessionActionWithNavigationGuard(params) {
	let actionError;
	let result;
	try {
		result = await params.execute();
	} catch (error) {
		actionError = error;
	}
	if (params.guard) await assertExistingSessionPostInteractionNavigationAllowed(params.guard);
	if (actionError) throw actionError;
	return result;
}
function buildExistingSessionWaitPredicate(params) {
	const checks = [];
	if (params.text) checks.push(`Boolean(document.body?.innerText?.includes(${JSON.stringify(params.text)}))`);
	if (params.textGone) checks.push(`!document.body?.innerText?.includes(${JSON.stringify(params.textGone)})`);
	if (params.selector) checks.push(`Boolean(document.querySelector(${JSON.stringify(params.selector)}))`);
	if (params.loadState === "domcontentloaded") checks.push(`document.readyState === "interactive" || document.readyState === "complete"`);
	else if (params.loadState === "load") checks.push(`document.readyState === "complete"`);
	if (params.fn) checks.push(`Boolean(await (${params.fn})())`);
	if (checks.length === 0) return null;
	return checks.length === 1 ? checks[0] : checks.map((check) => `(${check})`).join(" && ");
}
async function waitForExistingSessionCondition(params) {
	if (params.timeMs && params.timeMs > 0) await sleep(params.timeMs);
	const predicate = buildExistingSessionWaitPredicate(params);
	if (!predicate && !params.url) return;
	const timeoutMs = Math.max(250, params.timeoutMs ?? 1e4);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let ready = true;
		if (predicate) ready = Boolean(await evaluateChromeMcpScript({
			profileName: params.profileName,
			profile: params.profile,
			userDataDir: params.userDataDir,
			targetId: params.targetId,
			fn: `async () => ${predicate}`
		}));
		if (ready && params.url) {
			const currentUrl = await evaluateChromeMcpScript({
				profileName: params.profileName,
				profile: params.profile,
				userDataDir: params.userDataDir,
				targetId: params.targetId,
				fn: "() => window.location.href"
			});
			ready = typeof currentUrl === "string" && matchBrowserUrlPattern(params.url, currentUrl);
		}
		if (ready) return;
		await sleep(250);
	}
	throw new Error("Timed out waiting for condition");
}
const SELECTOR_ALLOWED_KINDS = new Set([
	"batch",
	"click",
	"drag",
	"hover",
	"scrollIntoView",
	"select",
	"type",
	"wait"
]);
function shouldEnforceCurrentUrlForAct(action) {
	return action.kind !== "resize" && action.kind !== "close";
}
function getExistingSessionUnsupportedMessage(action) {
	switch (action.kind) {
		case "click":
			if (action.selector) return EXISTING_SESSION_LIMITS.act.clickSelector;
			if (action.button && action.button !== "left" || Array.isArray(action.modifiers) && action.modifiers.length > 0) return EXISTING_SESSION_LIMITS.act.clickButtonOrModifiers;
			return null;
		case "clickCoords": return null;
		case "type":
			if (action.selector) return EXISTING_SESSION_LIMITS.act.typeSelector;
			if (action.slowly) return EXISTING_SESSION_LIMITS.act.typeSlowly;
			return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.typeTimeout : null;
		case "press": return action.delayMs ? EXISTING_SESSION_LIMITS.act.pressDelay : null;
		case "hover":
			if (action.selector) return EXISTING_SESSION_LIMITS.act.hoverSelector;
			return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.hoverTimeout : null;
		case "scrollIntoView":
			if (action.selector) return EXISTING_SESSION_LIMITS.act.scrollSelector;
			return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.scrollTimeout : null;
		case "drag":
			if (action.startSelector || action.endSelector) return EXISTING_SESSION_LIMITS.act.dragSelector;
			return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.dragTimeout : null;
		case "select":
			if (action.selector) return EXISTING_SESSION_LIMITS.act.selectSelector;
			if (action.values.length !== 1) return EXISTING_SESSION_LIMITS.act.selectSingleValue;
			return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.selectTimeout : null;
		case "fill": return action.timeoutMs ? EXISTING_SESSION_LIMITS.act.fillTimeout : null;
		case "wait": return action.loadState === "networkidle" ? EXISTING_SESSION_LIMITS.act.waitNetworkIdle : null;
		case "evaluate": return action.timeoutMs !== void 0 ? EXISTING_SESSION_LIMITS.act.evaluateTimeout : null;
		case "batch": return EXISTING_SESSION_LIMITS.act.batch;
		case "resize":
		case "close": return null;
	}
	throw new Error("Unsupported browser act kind");
}
function registerBrowserAgentActRoutes(app, ctx) {
	app.post("/act", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const kindRaw = toStringOrEmpty(body.kind);
		if (!isActKind(kindRaw)) return jsonActError(res, 400, ACT_ERROR_CODES.kindRequired, "kind is required");
		const kind = kindRaw;
		let action;
		try {
			action = normalizeActRequest(body);
		} catch (err) {
			return jsonActError(res, 400, ACT_ERROR_CODES.invalidRequest, formatErrorMessage(err));
		}
		const targetId = resolveTargetIdFromBody(body);
		if (Object.hasOwn(body, "selector") && !SELECTOR_ALLOWED_KINDS.has(kind)) return jsonActError(res, 400, ACT_ERROR_CODES.selectorUnsupported, SELECTOR_UNSUPPORTED_MESSAGE);
		const earlyFn = action.kind === "wait" || action.kind === "evaluate" ? action.fn : "";
		if ((action.kind === "evaluate" || action.kind === "wait" && earlyFn) && !ctx.state().resolved.evaluateEnabled) return jsonActError(res, 403, ACT_ERROR_CODES.evaluateDisabled, browserEvaluateDisabledMessage(action.kind === "evaluate" ? "evaluate" : "wait"));
		await withRouteTabContext({
			req,
			res,
			ctx,
			targetId,
			enforceCurrentUrlAllowed: shouldEnforceCurrentUrlForAct(action),
			run: async ({ profileCtx, cdpUrl, tab, resolveTabUrl }) => {
				const evaluateEnabled = ctx.state().resolved.evaluateEnabled;
				const ssrfPolicy = ctx.state().resolved.ssrfPolicy;
				const isExistingSession = getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp;
				const hasNavigationResultPolicy = Boolean(withBrowserNavigationPolicy(ssrfPolicy).ssrfPolicy);
				const jsonOk = async (extra, options) => {
					const responseTargetId = options?.resolveCurrentTarget && (!isExistingSession || hasNavigationResultPolicy) ? await resolveTargetIdAfterNavigate({
						oldTargetId: tab.targetId,
						navigatedUrl: tab.url,
						listTabs: () => profileCtx.listTabs()
					}) : tab.targetId;
					const url = responseTargetId === tab.targetId ? await resolveTabUrl(tab.url) : await resolveSafeRouteTabUrl({
						ctx,
						profileCtx,
						targetId: responseTargetId,
						fallbackUrl: tab.url
					});
					return res.json({
						ok: true,
						targetId: responseTargetId,
						...url ? { url } : {},
						...extra
					});
				};
				if (action.targetId && action.targetId !== tab.targetId) return jsonActError(res, 403, ACT_ERROR_CODES.targetIdMismatch, "action targetId must match request targetId");
				const profileName = profileCtx.profile.name;
				if (isExistingSession) {
					const initialTabTargetIds = hasNavigationResultPolicy ? new Set((await profileCtx.listTabs()).map((currentTab) => currentTab.targetId)) : /* @__PURE__ */ new Set();
					const existingSessionNavigationGuard = {
						profileName,
						profile: profileCtx.profile,
						targetId: tab.targetId,
						ssrfPolicy,
						listTabs: () => profileCtx.listTabs(),
						initialTabTargetIds
					};
					const unsupportedMessage = getExistingSessionUnsupportedMessage(action);
					if (unsupportedMessage) return jsonActError(res, 501, ACT_ERROR_CODES.unsupportedForExistingSession, unsupportedMessage);
					switch (action.kind) {
						case "click":
							await runExistingSessionActionWithNavigationGuard({
								execute: () => clickChromeMcpElement({
									profileName,
									profile: profileCtx.profile,
									targetId: tab.targetId,
									uid: action.ref,
									doubleClick: action.doubleClick ?? false,
									timeoutMs: action.timeoutMs,
									signal: req.signal
								}),
								guard: existingSessionNavigationGuard
							});
							return await jsonOk(void 0, { resolveCurrentTarget: true });
						case "clickCoords":
							await runExistingSessionActionWithNavigationGuard({
								execute: () => clickChromeMcpCoords({
									profileName,
									profile: profileCtx.profile,
									targetId: tab.targetId,
									x: action.x,
									y: action.y,
									doubleClick: action.doubleClick ?? false,
									button: action.button,
									delayMs: action.delayMs
								}),
								guard: existingSessionNavigationGuard
							});
							return await jsonOk(void 0, { resolveCurrentTarget: true });
						case "type":
							await runExistingSessionActionWithNavigationGuard({
								execute: async () => {
									await fillChromeMcpElement({
										profileName,
										profile: profileCtx.profile,
										targetId: tab.targetId,
										uid: action.ref,
										value: action.text
									});
									if (action.submit) await pressChromeMcpKey({
										profileName,
										profile: profileCtx.profile,
										targetId: tab.targetId,
										key: "Enter"
									});
								},
								guard: existingSessionNavigationGuard
							});
							return await jsonOk(void 0, { resolveCurrentTarget: true });
						case "press":
							await runExistingSessionActionWithNavigationGuard({
								execute: () => pressChromeMcpKey({
									profileName,
									profile: profileCtx.profile,
									targetId: tab.targetId,
									key: action.key
								}),
								guard: existingSessionNavigationGuard
							});
							return await jsonOk(void 0, { resolveCurrentTarget: true });
						case "hover":
							await runExistingSessionActionWithNavigationGuard({
								execute: () => hoverChromeMcpElement({
									profileName,
									profile: profileCtx.profile,
									targetId: tab.targetId,
									uid: action.ref
								}),
								guard: existingSessionNavigationGuard
							});
							return await jsonOk();
						case "scrollIntoView":
							await runExistingSessionActionWithNavigationGuard({
								execute: () => evaluateChromeMcpScript({
									profileName,
									profile: profileCtx.profile,
									targetId: tab.targetId,
									fn: `(el) => { el.scrollIntoView({ block: "center", inline: "center" }); return true; }`,
									args: [action.ref]
								}),
								guard: existingSessionNavigationGuard
							});
							return await jsonOk();
						case "drag":
							await runExistingSessionActionWithNavigationGuard({
								execute: () => dragChromeMcpElement({
									profileName,
									profile: profileCtx.profile,
									targetId: tab.targetId,
									fromUid: action.startRef,
									toUid: action.endRef
								}),
								guard: existingSessionNavigationGuard
							});
							return await jsonOk();
						case "select":
							await runExistingSessionActionWithNavigationGuard({
								execute: () => fillChromeMcpElement({
									profileName,
									profile: profileCtx.profile,
									targetId: tab.targetId,
									uid: action.ref,
									value: action.values[0] ?? ""
								}),
								guard: existingSessionNavigationGuard
							});
							return await jsonOk();
						case "fill":
							await runExistingSessionActionWithNavigationGuard({
								execute: () => fillChromeMcpForm({
									profileName,
									profile: profileCtx.profile,
									targetId: tab.targetId,
									elements: action.fields.map((field) => ({
										uid: field.ref,
										value: String(field.value ?? "")
									}))
								}),
								guard: existingSessionNavigationGuard
							});
							return await jsonOk();
						case "resize":
							await resizeChromeMcpPage({
								profileName,
								profile: profileCtx.profile,
								targetId: tab.targetId,
								width: action.width,
								height: action.height
							});
							return await jsonOk();
						case "wait":
							await waitForExistingSessionCondition({
								profileName,
								profile: profileCtx.profile,
								targetId: tab.targetId,
								timeMs: action.timeMs,
								text: action.text,
								textGone: action.textGone,
								selector: action.selector,
								url: action.url,
								loadState: action.loadState,
								fn: action.fn,
								timeoutMs: action.timeoutMs
							});
							return await jsonOk();
						case "evaluate": return await jsonOk({ result: await runExistingSessionActionWithNavigationGuard({
							execute: () => evaluateChromeMcpScript({
								profileName,
								profile: profileCtx.profile,
								targetId: tab.targetId,
								fn: action.fn,
								args: action.ref ? [action.ref] : void 0
							}),
							guard: existingSessionNavigationGuard
						}) });
						case "close":
							await closeChromeMcpTab(profileName, tab.targetId, profileCtx.profile);
							return await jsonOk();
						case "batch": return jsonActError(res, 501, ACT_ERROR_CODES.unsupportedForExistingSession, EXISTING_SESSION_LIMITS.act.batch);
					}
				}
				const pw = await requirePwAi(res, `act:${kind}`);
				if (!pw) return;
				if (action.kind === "batch") {
					const targetIdError = validateBatchTargetIds(action.actions, tab.targetId);
					if (targetIdError) return jsonActError(res, 403, ACT_ERROR_CODES.targetIdMismatch, targetIdError);
				}
				const result = await pw.executeActViaPlaywright({
					cdpUrl,
					action,
					targetId: tab.targetId,
					evaluateEnabled,
					ssrfPolicy,
					signal: req.signal
				});
				if (result.blockedByDialog) return await jsonOk({
					blockedByDialog: true,
					browserState: result.browserState
				});
				switch (action.kind) {
					case "batch": return await jsonOk({ results: result.results ?? [] }, { resolveCurrentTarget: true });
					case "evaluate": return await jsonOk({ result: result.result }, { resolveCurrentTarget: true });
					case "click":
					case "clickCoords": return await jsonOk(void 0, { resolveCurrentTarget: true });
					case "resize": return await jsonOk();
					default: return await jsonOk(void 0, { resolveCurrentTarget: true });
				}
			}
		});
	}));
	registerBrowserAgentActHookRoutes(app, ctx);
	registerBrowserAgentActDownloadRoutes(app, ctx);
	app.post("/response/body", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const url = toStringOrEmpty(body.url);
		const timeoutMs = toNumber(body.timeoutMs);
		const maxChars = toNumber(body.maxChars);
		if (!url) return jsonError(res, 400, "url is required");
		await withRouteTabContext({
			req,
			res,
			ctx,
			targetId,
			enforceCurrentUrlAllowed: true,
			run: async ({ profileCtx, cdpUrl, tab, resolveTabUrl }) => {
				if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) return jsonError(res, 501, EXISTING_SESSION_LIMITS.responseBody);
				const pw = await requirePwAi(res, "response body");
				if (!pw) return;
				const result = await pw.responseBodyViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					url,
					timeoutMs: timeoutMs ?? void 0,
					maxChars: maxChars ?? void 0
				});
				const currentUrl = await resolveTabUrl(tab.url);
				res.json({
					ok: true,
					targetId: tab.targetId,
					...currentUrl ? { url: currentUrl } : {},
					response: result
				});
			}
		});
	}));
	app.post("/highlight", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const ref = toStringOrEmpty(body.ref);
		if (!ref) return jsonError(res, 400, "ref is required");
		await withRouteTabContext({
			req,
			res,
			ctx,
			targetId,
			enforceCurrentUrlAllowed: true,
			run: async ({ profileCtx, cdpUrl, tab, resolveTabUrl }) => {
				const jsonOk = async () => {
					const currentUrl = await resolveTabUrl(tab.url);
					return res.json({
						ok: true,
						targetId: tab.targetId,
						...currentUrl ? { url: currentUrl } : {}
					});
				};
				if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
					await evaluateChromeMcpScript({
						profileName: profileCtx.profile.name,
						profile: profileCtx.profile,
						targetId: tab.targetId,
						args: [ref],
						fn: `(el) => {
              if (!(el instanceof Element)) {
                return false;
              }
              el.scrollIntoView({ block: "center", inline: "center" });
              const previousOutline = el.style.outline;
              const previousOffset = el.style.outlineOffset;
              el.style.outline = "3px solid #FF4500";
              el.style.outlineOffset = "2px";
              setTimeout(() => {
                el.style.outline = previousOutline;
                el.style.outlineOffset = previousOffset;
              }, 2000);
              return true;
            }`
					});
					return await jsonOk();
				}
				const pw = await requirePwAi(res, "highlight");
				if (!pw) return;
				await pw.highlightViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					ref
				});
				await jsonOk();
			}
		});
	}));
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.debug.ts
function registerBrowserAgentDebugRoutes(app, ctx) {
	app.get("/console", asyncBrowserRoute(async (req, res) => {
		const targetId = resolveTargetIdFromQuery(req.query);
		const level = typeof req.query.level === "string" ? req.query.level : "";
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "console messages",
			enforceCurrentUrlAllowed: true,
			run: async ({ cdpUrl, tab, pw, resolveTabUrl }) => {
				const messages = await pw.getConsoleMessagesViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					level: normalizeOptionalString$4(level)
				});
				const url = await resolveTabUrl(tab.url);
				res.json({
					ok: true,
					messages,
					targetId: tab.targetId,
					...url ? { url } : {}
				});
			}
		});
	}));
	app.get("/errors", asyncBrowserRoute(async (req, res) => {
		const targetId = resolveTargetIdFromQuery(req.query);
		const clear = toBoolean(req.query.clear) ?? false;
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "page errors",
			enforceCurrentUrlAllowed: true,
			run: async ({ cdpUrl, tab, pw, resolveTabUrl }) => {
				const result = await pw.getPageErrorsViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					clear
				});
				const url = await resolveTabUrl(tab.url);
				res.json({
					ok: true,
					targetId: tab.targetId,
					...url ? { url } : {},
					...result
				});
			}
		});
	}));
	app.get("/requests", asyncBrowserRoute(async (req, res) => {
		const targetId = resolveTargetIdFromQuery(req.query);
		const filter = typeof req.query.filter === "string" ? req.query.filter : "";
		const clear = toBoolean(req.query.clear) ?? false;
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "network requests",
			enforceCurrentUrlAllowed: true,
			run: async ({ cdpUrl, tab, pw, resolveTabUrl }) => {
				const result = await pw.getNetworkRequestsViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					filter: normalizeOptionalString$4(filter),
					clear
				});
				const url = await resolveTabUrl(tab.url);
				res.json({
					ok: true,
					targetId: tab.targetId,
					...url ? { url } : {},
					...result
				});
			}
		});
	}));
	app.get("/dialogs", asyncBrowserRoute(async (req, res) => {
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId: resolveTargetIdFromQuery(req.query),
			feature: "dialog state",
			enforceCurrentUrlAllowed: true,
			run: async ({ cdpUrl, tab, pw, resolveTabUrl }) => {
				const browserState = await pw.getObservedBrowserStateViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					ssrfPolicy: ctx.state().resolved.ssrfPolicy
				});
				const url = await resolveTabUrl(tab.url);
				res.json({
					ok: true,
					targetId: tab.targetId,
					...url ? { url } : {},
					browserState
				});
			}
		});
	}));
	app.post("/trace/start", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const screenshots = toBoolean(body.screenshots) ?? void 0;
		const snapshots = toBoolean(body.snapshots) ?? void 0;
		const sources = toBoolean(body.sources) ?? void 0;
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "trace start",
			enforceCurrentUrlAllowed: true,
			run: async ({ cdpUrl, tab, pw, resolveTabUrl }) => {
				await pw.traceStartViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					screenshots,
					snapshots,
					sources
				});
				const url = await resolveTabUrl(tab.url);
				res.json({
					ok: true,
					targetId: tab.targetId,
					...url ? { url } : {}
				});
			}
		});
	}));
	app.post("/trace/stop", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const out = toStringOrEmpty(body.path) || "";
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "trace stop",
			enforceCurrentUrlAllowed: true,
			run: async ({ cdpUrl, tab, pw, resolveTabUrl }) => {
				const tracePath = await resolveWritableOutputPathOrRespond({
					res,
					rootDir: DEFAULT_TRACE_DIR,
					requestedPath: out,
					scopeLabel: "trace directory",
					defaultFileName: `browser-trace-${crypto.randomUUID()}.zip`,
					ensureRootDir: true
				});
				if (!tracePath) return;
				await pw.traceStopViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					path: tracePath
				});
				const url = await resolveTabUrl(tab.url);
				res.json({
					ok: true,
					targetId: tab.targetId,
					...url ? { url } : {},
					path: path.resolve(tracePath)
				});
			}
		});
	}));
}
//#endregion
//#region extensions/browser/src/browser/chrome-mcp.snapshot.ts
function normalizeRole(node) {
	return normalizeLowercaseStringOrEmpty(node.role) || "generic";
}
function escapeQuoted(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}
function shouldIncludeNode(params) {
	if (params.options?.interactive && !INTERACTIVE_ROLES.has(params.role)) return false;
	if (params.options?.compact && STRUCTURAL_ROLES.has(params.role) && !params.name) return false;
	return true;
}
function shouldCreateRef(role, name) {
	return INTERACTIVE_ROLES.has(role) || CONTENT_ROLES.has(role) && Boolean(name);
}
function createDuplicateTracker() {
	return {
		counts: /* @__PURE__ */ new Map(),
		keysByRef: /* @__PURE__ */ new Map(),
		duplicates: /* @__PURE__ */ new Set()
	};
}
function registerRef(tracker, ref, role, name) {
	const key = `${role}:${name ?? ""}`;
	const count = tracker.counts.get(key) ?? 0;
	tracker.counts.set(key, count + 1);
	tracker.keysByRef.set(ref, key);
	if (count > 0) {
		tracker.duplicates.add(key);
		return count;
	}
}
function flattenChromeMcpSnapshotToAriaNodes(root, limit = 500) {
	const boundedLimit = Math.max(1, Math.min(2e3, Math.floor(limit)));
	const out = [];
	const visit = (node, depth) => {
		if (out.length >= boundedLimit) return;
		const ref = normalizeString(node.id);
		if (ref) out.push({
			ref,
			role: normalizeRole(node),
			name: normalizeString(node.name) ?? "",
			value: normalizeString(node.value),
			description: normalizeString(node.description),
			depth
		});
		for (const child of node.children ?? []) {
			visit(child, depth + 1);
			if (out.length >= boundedLimit) return;
		}
	};
	visit(root, 0);
	return out;
}
function buildAiSnapshotFromChromeMcpSnapshot(params) {
	const refs = {};
	const tracker = createDuplicateTracker();
	const lines = [];
	const visit = (node, depth) => {
		const role = normalizeRole(node);
		const name = normalizeString(node.name);
		const value = normalizeString(node.value);
		const description = normalizeString(node.description);
		const maxDepth = params.options?.maxDepth;
		if (maxDepth !== void 0 && depth > maxDepth) return;
		if (shouldIncludeNode({
			role,
			name,
			options: params.options
		})) {
			let line = `${"  ".repeat(depth)}- ${role}`;
			if (name) line += ` "${escapeQuoted(name)}"`;
			const ref = normalizeString(node.id);
			if (ref && shouldCreateRef(role, name)) {
				const nth = registerRef(tracker, ref, role, name);
				refs[ref] = nth === void 0 ? {
					role,
					name
				} : {
					role,
					name,
					nth
				};
				line += ` [ref=${ref}]`;
			}
			if (value) line += ` value="${escapeQuoted(value)}"`;
			if (description) line += ` description="${escapeQuoted(description)}"`;
			lines.push(line);
		}
		for (const child of node.children ?? []) visit(child, depth + 1);
	};
	visit(params.root, 0);
	for (const [ref, data] of Object.entries(refs)) {
		const key = tracker.keysByRef.get(ref);
		if (key && !tracker.duplicates.has(key)) delete data.nth;
	}
	let snapshot = lines.join("\n");
	let truncated = false;
	const maxChars = typeof params.maxChars === "number" && Number.isFinite(params.maxChars) && params.maxChars > 0 ? Math.floor(params.maxChars) : void 0;
	if (maxChars && snapshot.length > maxChars) {
		snapshot = `${snapshot.slice(0, maxChars)}\n\n[...TRUNCATED - page too large]`;
		truncated = true;
	}
	const stats = getRoleSnapshotStats(snapshot, refs);
	return truncated ? {
		snapshot,
		truncated,
		refs,
		stats
	} : {
		snapshot,
		refs,
		stats
	};
}
//#endregion
//#region extensions/browser/src/browser/screenshot.ts
const DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE = 2e3;
const DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
async function normalizeBrowserScreenshot(buffer, opts) {
	const maxSide = Math.max(1, Math.round(opts?.maxSide ?? 2e3));
	const maxBytes = Math.max(1, Math.round(opts?.maxBytes ?? 5242880));
	const meta = await getImageMetadata(buffer);
	const width = meta?.width ?? 0;
	const height = meta?.height ?? 0;
	const maxDim = Math.max(width, height);
	if (buffer.byteLength <= maxBytes && (maxDim === 0 || width <= maxSide && height <= maxSide)) return { buffer };
	const sideGrid = buildImageResizeSideGrid(maxSide, maxDim > 0 ? Math.min(maxSide, maxDim) : maxSide);
	let smallest = null;
	let processorUnavailableError;
	for (const side of sideGrid) {
		for (const quality of IMAGE_REDUCE_QUALITY_STEPS) {
			let out;
			try {
				out = await resizeToJpeg({
					buffer,
					maxSide: side,
					quality,
					withoutEnlargement: true
				});
			} catch (err) {
				if (isImageProcessorUnavailableError(err)) {
					processorUnavailableError = err;
					break;
				}
				throw err;
			}
			if (!smallest || out.byteLength < smallest.size) smallest = {
				buffer: out,
				size: out.byteLength
			};
			if (out.byteLength <= maxBytes) return {
				buffer: out,
				contentType: "image/jpeg"
			};
		}
		if (processorUnavailableError) break;
	}
	if (processorUnavailableError) throw processorUnavailableError;
	const best = smallest?.buffer ?? buffer;
	throw new Error(`Browser screenshot could not be reduced below ${(maxBytes / (1024 * 1024)).toFixed(0)}MB (got ${(best.byteLength / (1024 * 1024)).toFixed(2)}MB)`);
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.snapshot.plan.ts
function readStringValue$1(value) {
	return typeof value === "string" ? value : void 0;
}
function normalizeOptionalString$1(value) {
	return readStringValue$1(value)?.trim() || void 0;
}
function resolveSnapshotPlan(params) {
	const mode = params.query.mode === "efficient" ? "efficient" : void 0;
	const labels = toBoolean(params.query.labels) ?? void 0;
	const urls = toBoolean(params.query.urls) ?? void 0;
	const explicitFormat = params.query.format === "aria" ? "aria" : params.query.format === "ai" ? "ai" : void 0;
	const format = resolveDefaultSnapshotFormat({
		profile: params.profile,
		hasPlaywright: params.hasPlaywright,
		explicitFormat,
		mode
	});
	const limitRaw = readStringValue$1(params.query.limit);
	const hasMaxChars = Object.hasOwn(params.query, "maxChars");
	const maxCharsRaw = readStringValue$1(params.query.maxChars);
	const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : void 0;
	const maxChars = Number.isFinite(Number(maxCharsRaw)) && Number(maxCharsRaw) > 0 ? Math.floor(Number(maxCharsRaw)) : void 0;
	const resolvedMaxChars = format === "ai" ? hasMaxChars ? maxChars : mode === "efficient" ? DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS : DEFAULT_AI_SNAPSHOT_MAX_CHARS : void 0;
	const interactiveRaw = toBoolean(params.query.interactive);
	const compactRaw = toBoolean(params.query.compact);
	const depthRaw = toNumber(params.query.depth);
	const refsModeRaw = toStringOrEmpty(params.query.refs).trim();
	const refsMode = refsModeRaw === "aria" ? "aria" : refsModeRaw === "role" ? "role" : void 0;
	const interactive = interactiveRaw ?? (mode === "efficient" ? true : void 0);
	const compact = compactRaw ?? (mode === "efficient" ? true : void 0);
	const depth = depthRaw ?? (mode === "efficient" ? 6 : void 0);
	const selectorValue = normalizeOptionalString$1(toStringOrEmpty(params.query.selector));
	const frameSelectorValue = normalizeOptionalString$1(toStringOrEmpty(params.query.frame));
	return {
		format,
		mode,
		labels,
		urls,
		limit,
		resolvedMaxChars,
		interactive,
		compact,
		depth,
		refsMode,
		selectorValue,
		frameSelectorValue,
		wantsRoleSnapshot: labels === true || urls === true || mode === "efficient" || interactive === true || compact === true || depth !== void 0 || Boolean(selectorValue) || Boolean(frameSelectorValue)
	};
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.snapshot.ts
const CHROME_MCP_OVERLAY_ATTR = "data-openclaw-mcp-overlay";
function browserNavigationPolicyForProfile$1(ctx, profileCtx) {
	return withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy, { browserProxyMode: resolveBrowserNavigationProxyMode({
		resolved: ctx.state().resolved,
		profile: profileCtx.profile
	}) });
}
async function collectChromeMcpSnapshotUrls(params) {
	const result = await evaluateChromeMcpScript({
		profileName: params.profileName,
		profile: params.profile,
		userDataDir: params.userDataDir,
		targetId: params.targetId,
		fn: `() => {
      const seen = new Set();
      const out = [];
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = anchor.href || "";
        if (!href || seen.has(href)) continue;
        const text = (anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, 120) || href;
        seen.add(href);
        out.push({ text, url: href });
        if (out.length >= 100) break;
      }
      return out;
    }`
	}).catch(() => []);
	return Array.isArray(result) ? result.filter((entry) => entry && typeof entry === "object" && typeof entry.text === "string" && typeof entry.url === "string") : [];
}
function appendSnapshotUrls(snapshot, urls) {
	if (urls.length === 0) return snapshot;
	return `${snapshot}\n\nLinks:\n${urls.map((entry, index) => `${index + 1}. ${entry.text} -> ${entry.url}`).join("\n")}`;
}
async function clearChromeMcpOverlay(params) {
	await evaluateChromeMcpScript({
		profileName: params.profileName,
		profile: params.profile,
		userDataDir: params.userDataDir,
		targetId: params.targetId,
		fn: `() => {
      document.querySelectorAll("[${CHROME_MCP_OVERLAY_ATTR}]").forEach((node) => node.remove());
      return true;
    }`
	}).catch(() => {});
}
async function renderChromeMcpLabels(params) {
	const refList = JSON.stringify(params.refs);
	const result = await evaluateChromeMcpScript({
		profileName: params.profileName,
		profile: params.profile,
		userDataDir: params.userDataDir,
		targetId: params.targetId,
		args: params.refs,
		fn: `(...elements) => {
      const refs = ${refList};
      document.querySelectorAll("[${CHROME_MCP_OVERLAY_ATTR}]").forEach((node) => node.remove());
      const root = document.createElement("div");
      root.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", "labels");
      root.style.position = "fixed";
      root.style.inset = "0";
      root.style.pointerEvents = "none";
      root.style.zIndex = "2147483647";
      let labels = 0;
      let skipped = 0;
      elements.forEach((el, index) => {
        if (!(el instanceof Element)) {
          skipped += 1;
          return;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) {
          skipped += 1;
          return;
        }
        labels += 1;
        const badge = document.createElement("div");
        badge.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", "label");
        badge.textContent = refs[index] || String(labels);
        badge.style.position = "fixed";
        badge.style.left = \`\${Math.max(0, rect.left)}px\`;
        badge.style.top = \`\${Math.max(0, rect.top)}px\`;
        badge.style.transform = "translateY(-100%)";
        badge.style.padding = "2px 6px";
        badge.style.borderRadius = "999px";
        badge.style.background = "#FF4500";
        badge.style.color = "#fff";
        badge.style.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
        badge.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
        badge.style.whiteSpace = "nowrap";
        root.appendChild(badge);
      });
      document.documentElement.appendChild(root);
      return { labels, skipped };
    }`
	});
	return {
		labels: result && typeof result === "object" && typeof result.labels === "number" ? result.labels : 0,
		skipped: result && typeof result === "object" && typeof result.skipped === "number" ? result.skipped : 0
	};
}
async function saveNormalizedScreenshotResponse(params) {
	const normalized = await normalizeBrowserScreenshot(params.buffer, {
		maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
		maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES
	});
	await saveBrowserMediaResponse({
		res: params.res,
		buffer: normalized.buffer,
		contentType: normalized.contentType ?? `image/${params.type}`,
		maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
		targetId: params.targetId,
		url: params.url,
		labels: params.labels,
		labelsCount: params.labelsCount,
		labelsSkipped: params.labelsSkipped
	});
}
async function saveBrowserMediaResponse(params) {
	await ensureMediaDir();
	const saved = await saveMediaBuffer(params.buffer, params.contentType, "browser", params.maxBytes);
	params.res.json({
		ok: true,
		path: path.resolve(saved.path),
		targetId: params.targetId,
		url: params.url,
		...params.labels ? { labels: true } : {},
		...typeof params.labelsCount === "number" ? { labelsCount: params.labelsCount } : {},
		...typeof params.labelsSkipped === "number" ? { labelsSkipped: params.labelsSkipped } : {}
	});
}
function hasObservableBrowserState(state) {
	if (!state || typeof state !== "object") return false;
	const dialogs = state.dialogs;
	return Boolean(dialogs?.pending?.length || dialogs?.recent?.length);
}
function hasPendingDialogs(state) {
	if (!state || typeof state !== "object") return false;
	const dialogs = state.dialogs;
	return Boolean(dialogs?.pending?.length);
}
function browserStateResponseFields(state) {
	return hasObservableBrowserState(state) ? { browserState: state } : {};
}
function registerBrowserAgentSnapshotRoutes(app, ctx) {
	app.post("/navigate", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const url = toStringOrEmpty(body.url);
		const targetId = toStringOrEmpty(body.targetId) || void 0;
		if (!url) return jsonError(res, 400, "url is required");
		await withRouteTabContext({
			req,
			res,
			ctx,
			targetId,
			run: async ({ profileCtx, tab, cdpUrl }) => {
				if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
					const ssrfPolicyOpts = browserNavigationPolicyForProfile$1(ctx, profileCtx);
					await assertBrowserNavigationAllowed({
						url,
						...ssrfPolicyOpts
					});
					const result = await navigateChromeMcpPage({
						profileName: profileCtx.profile.name,
						profile: profileCtx.profile,
						targetId: tab.targetId,
						url
					});
					await assertBrowserNavigationResultAllowed({
						url: result.url,
						...ssrfPolicyOpts
					});
					return res.json({
						ok: true,
						targetId: tab.targetId,
						...result
					});
				}
				const pw = await requirePwAi(res, "navigate");
				if (!pw) return;
				const result = await pw.navigateViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					url,
					...browserNavigationPolicyForProfile$1(ctx, profileCtx)
				});
				const currentTargetId = await resolveTargetIdAfterNavigate({
					oldTargetId: tab.targetId,
					navigatedUrl: result.url,
					listTabs: () => profileCtx.listTabs()
				});
				res.json({
					ok: true,
					targetId: currentTargetId,
					...result
				});
			}
		});
	}));
	app.post("/pdf", asyncBrowserRoute(async (req, res) => {
		const targetId = toStringOrEmpty(readBody(req).targetId) || void 0;
		const profileCtx = resolveProfileContext(req, res, ctx);
		if (!profileCtx) return;
		if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) return jsonError(res, 501, EXISTING_SESSION_LIMITS.snapshot.pdfUnsupported);
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "pdf",
			enforceCurrentUrlAllowed: true,
			run: async ({ cdpUrl, tab, pw }) => {
				const pdf = await pw.pdfViaPlaywright({
					cdpUrl,
					targetId: tab.targetId
				});
				await saveBrowserMediaResponse({
					res,
					buffer: pdf.buffer,
					contentType: "application/pdf",
					maxBytes: pdf.buffer.byteLength,
					targetId: tab.targetId,
					url: tab.url
				});
			}
		});
	}));
	app.post("/screenshot", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = toStringOrEmpty(body.targetId) || void 0;
		const fullPage = toBoolean(body.fullPage) ?? false;
		const ref = toStringOrEmpty(body.ref) || void 0;
		const element = toStringOrEmpty(body.element) || void 0;
		const labels = toBoolean(body.labels) ?? false;
		const type = body.type === "jpeg" ? "jpeg" : "png";
		const timeoutMsRaw = toNumber(body.timeoutMs);
		const timeoutMs = timeoutMsRaw !== void 0 ? Math.max(1, Math.floor(timeoutMsRaw)) : DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS;
		if (fullPage && (ref || element)) return jsonError(res, 400, "fullPage is not supported for element screenshots");
		await withRouteTabContext({
			req,
			res,
			ctx,
			targetId,
			enforceCurrentUrlAllowed: true,
			run: async ({ profileCtx, tab, cdpUrl }) => {
				if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
					const ssrfPolicyOpts = browserNavigationPolicyForProfile$1(ctx, profileCtx);
					if (ssrfPolicyOpts.ssrfPolicy) await assertBrowserNavigationResultAllowed({
						url: tab.url,
						...ssrfPolicyOpts
					});
					if (element) return jsonError(res, 400, EXISTING_SESSION_LIMITS.snapshot.screenshotElement);
					if (labels) {
						const built = buildAiSnapshotFromChromeMcpSnapshot({ root: await takeChromeMcpSnapshot({
							profileName: profileCtx.profile.name,
							profile: profileCtx.profile,
							targetId: tab.targetId
						}) });
						const labelResult = await renderChromeMcpLabels({
							profileName: profileCtx.profile.name,
							profile: profileCtx.profile,
							targetId: tab.targetId,
							refs: Object.keys(built.refs)
						});
						try {
							await saveNormalizedScreenshotResponse({
								res,
								buffer: await takeChromeMcpScreenshot({
									profileName: profileCtx.profile.name,
									profile: profileCtx.profile,
									targetId: tab.targetId,
									fullPage,
									format: type,
									timeoutMs
								}),
								type,
								targetId: tab.targetId,
								url: tab.url,
								labels: true,
								labelsCount: labelResult.labels,
								labelsSkipped: labelResult.skipped
							});
						} finally {
							await clearChromeMcpOverlay({
								profileName: profileCtx.profile.name,
								profile: profileCtx.profile,
								targetId: tab.targetId
							});
						}
						return;
					}
					await saveNormalizedScreenshotResponse({
						res,
						buffer: await takeChromeMcpScreenshot({
							profileName: profileCtx.profile.name,
							profile: profileCtx.profile,
							targetId: tab.targetId,
							uid: ref,
							fullPage,
							format: type,
							timeoutMs
						}),
						type,
						targetId: tab.targetId,
						url: tab.url
					});
					return;
				}
				let buffer;
				if (labels || shouldUsePlaywrightForScreenshot({
					profile: profileCtx.profile,
					wsUrl: tab.wsUrl,
					ref,
					element
				})) {
					const pw = await requirePwAi(res, "screenshot");
					if (!pw) return;
					if (labels) {
						const snap = await pw.snapshotRoleViaPlaywright({
							cdpUrl,
							targetId: tab.targetId,
							ssrfPolicy: ctx.state().resolved.ssrfPolicy
						});
						const labeled = await pw.screenshotWithLabelsViaPlaywright({
							cdpUrl,
							targetId: tab.targetId,
							refs: snap.refs,
							type,
							timeoutMs
						});
						await saveNormalizedScreenshotResponse({
							res,
							buffer: labeled.buffer,
							type,
							targetId: tab.targetId,
							url: tab.url,
							labels: true,
							labelsCount: labeled.labels,
							labelsSkipped: labeled.skipped
						});
						return;
					}
					buffer = (await pw.takeScreenshotViaPlaywright({
						cdpUrl,
						targetId: tab.targetId,
						ref,
						element,
						fullPage,
						type,
						timeoutMs
					})).buffer;
				} else buffer = await captureScreenshot({
					wsUrl: tab.wsUrl ?? "",
					fullPage,
					format: type,
					quality: type === "jpeg" ? 85 : void 0,
					timeoutMs
				});
				await saveNormalizedScreenshotResponse({
					res,
					buffer,
					type,
					targetId: tab.targetId,
					url: tab.url
				});
			}
		});
	}));
	app.get("/snapshot", asyncBrowserRoute(async (req, res) => {
		const profileCtx = resolveProfileContext(req, res, ctx);
		if (!profileCtx) return;
		const targetId = typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
		const pwModule = await getPwAiModule();
		const hasPlaywright = Boolean(pwModule);
		const plan = resolveSnapshotPlan({
			profile: profileCtx.profile,
			query: req.query,
			hasPlaywright
		});
		try {
			const tab = await profileCtx.ensureTabAvailable(targetId || void 0);
			const usesChromeMcp = getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp;
			const ssrfPolicyOpts = browserNavigationPolicyForProfile$1(ctx, profileCtx);
			let observedBrowserState;
			if (!usesChromeMcp && pwModule) {
				await assertBrowserNavigationResultAllowed({
					url: tab.url,
					...ssrfPolicyOpts
				});
				observedBrowserState = await pwModule.getObservedBrowserStateViaPlaywright({
					cdpUrl: profileCtx.profile.cdpUrl,
					targetId: tab.targetId,
					ssrfPolicy: ctx.state().resolved.ssrfPolicy
				}).catch(() => void 0);
			}
			if ((plan.labels || plan.mode === "efficient") && plan.format === "aria") return jsonError(res, 400, "labels/mode=efficient require format=ai");
			if (usesChromeMcp) {
				if (plan.selectorValue || plan.frameSelectorValue) return jsonError(res, 400, EXISTING_SESSION_LIMITS.snapshot.snapshotSelector);
				if (ssrfPolicyOpts.ssrfPolicy) await assertBrowserNavigationResultAllowed({
					url: tab.url,
					...ssrfPolicyOpts
				});
				const snapshot = await takeChromeMcpSnapshot({
					profileName: profileCtx.profile.name,
					profile: profileCtx.profile,
					targetId: tab.targetId
				});
				if (plan.format === "aria") return res.json({
					ok: true,
					format: "aria",
					targetId: tab.targetId,
					url: tab.url,
					nodes: flattenChromeMcpSnapshotToAriaNodes(snapshot, plan.limit)
				});
				const built = buildAiSnapshotFromChromeMcpSnapshot({
					root: snapshot,
					options: {
						interactive: plan.interactive ?? void 0,
						compact: plan.compact ?? void 0,
						maxDepth: plan.depth ?? void 0
					},
					maxChars: plan.resolvedMaxChars
				});
				const builtWithUrls = plan.urls ? {
					...built,
					snapshot: appendSnapshotUrls(built.snapshot, await collectChromeMcpSnapshotUrls({
						profileName: profileCtx.profile.name,
						profile: profileCtx.profile,
						targetId: tab.targetId
					}))
				} : built;
				if (plan.labels) {
					const refs = Object.keys(builtWithUrls.refs);
					const labelResult = await renderChromeMcpLabels({
						profileName: profileCtx.profile.name,
						profile: profileCtx.profile,
						targetId: tab.targetId,
						refs
					});
					try {
						const normalized = await normalizeBrowserScreenshot(await takeChromeMcpScreenshot({
							profileName: profileCtx.profile.name,
							profile: profileCtx.profile,
							targetId: tab.targetId,
							format: "png"
						}), {
							maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
							maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES
						});
						await ensureMediaDir();
						const saved = await saveMediaBuffer(normalized.buffer, normalized.contentType ?? "image/png", "browser", DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES);
						return res.json({
							ok: true,
							format: "ai",
							targetId: tab.targetId,
							url: tab.url,
							labels: true,
							labelsCount: labelResult.labels,
							labelsSkipped: labelResult.skipped,
							imagePath: path.resolve(saved.path),
							imageType: normalized.contentType?.includes("jpeg") ? "jpeg" : "png",
							...builtWithUrls
						});
					} finally {
						await clearChromeMcpOverlay({
							profileName: profileCtx.profile.name,
							profile: profileCtx.profile,
							targetId: tab.targetId
						});
					}
				}
				return res.json({
					ok: true,
					format: "ai",
					targetId: tab.targetId,
					url: tab.url,
					...builtWithUrls
				});
			}
			if (hasPendingDialogs(observedBrowserState)) return res.json({
				ok: true,
				format: plan.format,
				targetId: tab.targetId,
				url: tab.url,
				blockedByDialog: true,
				...browserStateResponseFields(observedBrowserState),
				...plan.format === "aria" ? { nodes: [] } : {
					snapshot: "",
					refs: {}
				}
			});
			if (plan.format === "ai") {
				const roleSnapshotArgs = {
					cdpUrl: profileCtx.profile.cdpUrl,
					targetId: tab.targetId,
					selector: plan.selectorValue,
					frameSelector: plan.frameSelectorValue,
					refsMode: plan.refsMode,
					ssrfPolicy: ctx.state().resolved.ssrfPolicy,
					urls: plan.urls,
					options: {
						interactive: plan.interactive ?? void 0,
						compact: plan.compact ?? void 0,
						maxDepth: plan.depth ?? void 0
					}
				};
				const cdpRoleSnapshot = async () => {
					if (!tab.wsUrl) return null;
					if (plan.selectorValue || plan.frameSelectorValue) return null;
					return await snapshotRoleViaCdp({
						wsUrl: tab.wsUrl,
						urls: plan.urls,
						options: {
							interactive: plan.interactive ?? void 0,
							compact: plan.compact ?? void 0,
							maxDepth: plan.depth ?? void 0
						}
					});
				};
				const pw = await getPwAiModule();
				const snap = plan.wantsRoleSnapshot ? pw ? await pw.snapshotRoleViaPlaywright(roleSnapshotArgs).catch(async (err) => {
					const fallback = await cdpRoleSnapshot();
					if (fallback) return fallback;
					throw err;
				}) : await cdpRoleSnapshot() : pw ? await pw.snapshotAiViaPlaywright({
					cdpUrl: profileCtx.profile.cdpUrl,
					targetId: tab.targetId,
					ssrfPolicy: ctx.state().resolved.ssrfPolicy,
					urls: plan.urls,
					...typeof plan.resolvedMaxChars === "number" ? { maxChars: plan.resolvedMaxChars } : {}
				}) : await cdpRoleSnapshot();
				if (!snap) {
					await requirePwAi(res, "ai snapshot");
					return;
				}
				if (plan.labels) {
					if (!pw) return jsonError(res, 501, "Snapshot labels require Playwright.");
					const labeled = await pw.screenshotWithLabelsViaPlaywright({
						cdpUrl: profileCtx.profile.cdpUrl,
						targetId: tab.targetId,
						refs: "refs" in snap ? snap.refs : {},
						type: "png"
					});
					const normalized = await normalizeBrowserScreenshot(labeled.buffer, {
						maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
						maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES
					});
					await ensureMediaDir();
					const saved = await saveMediaBuffer(normalized.buffer, normalized.contentType ?? "image/png", "browser", DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES);
					const imageType = normalized.contentType?.includes("jpeg") ? "jpeg" : "png";
					return res.json({
						ok: true,
						format: plan.format,
						targetId: tab.targetId,
						url: tab.url,
						...browserStateResponseFields(observedBrowserState),
						labels: true,
						labelsCount: labeled.labels,
						labelsSkipped: labeled.skipped,
						imagePath: path.resolve(saved.path),
						imageType,
						...snap
					});
				}
				return res.json({
					ok: true,
					format: plan.format,
					targetId: tab.targetId,
					url: tab.url,
					...browserStateResponseFields(observedBrowserState),
					...snap
				});
			}
			const usePlaywrightAriaSnapshot = shouldUsePlaywrightForAriaSnapshot({
				profile: profileCtx.profile,
				wsUrl: tab.wsUrl
			});
			const snap = usePlaywrightAriaSnapshot ? requirePwAi(res, "aria snapshot").then(async (pw) => {
				if (!pw) return null;
				return await pw.snapshotAriaViaPlaywright({
					cdpUrl: profileCtx.profile.cdpUrl,
					targetId: tab.targetId,
					limit: plan.limit,
					ssrfPolicy: ctx.state().resolved.ssrfPolicy
				});
			}) : snapshotAria({
				wsUrl: tab.wsUrl ?? "",
				limit: plan.limit
			});
			const resolved = await Promise.resolve(snap);
			if (!resolved) return;
			if (!usePlaywrightAriaSnapshot) await pwModule?.storeAriaSnapshotRefsViaPlaywright?.({
				cdpUrl: profileCtx.profile.cdpUrl,
				targetId: tab.targetId,
				nodes: resolved.nodes
			});
			return res.json({
				ok: true,
				format: plan.format,
				targetId: tab.targetId,
				url: tab.url,
				...browserStateResponseFields(observedBrowserState),
				...resolved
			});
		} catch (err) {
			handleRouteError(ctx, res, err);
		}
	}));
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.storage.ts
function readStringValue(value) {
	return typeof value === "string" ? value : void 0;
}
function normalizeOptionalString(value) {
	return readStringValue(value)?.trim() || void 0;
}
function parseStorageKind(raw) {
	if (raw === "local" || raw === "session") return raw;
	return null;
}
function parseStorageMutationRequest(kindParam, body) {
	return {
		kind: parseStorageKind(toStringOrEmpty(kindParam)),
		targetId: resolveTargetIdFromBody(body)
	};
}
function parseRequiredStorageMutationRequest(kindParam, body) {
	const parsed = parseStorageMutationRequest(kindParam, body);
	if (!parsed.kind) return null;
	return {
		kind: parsed.kind,
		targetId: parsed.targetId
	};
}
function parseStorageMutationOrRespond(res, kindParam, body) {
	const parsed = parseRequiredStorageMutationRequest(kindParam, body);
	if (!parsed) {
		jsonError(res, 400, "kind must be local|session");
		return null;
	}
	return parsed;
}
function parseStorageMutationFromRequest(req, res) {
	const body = readBody(req);
	const parsed = parseStorageMutationOrRespond(res, req.params.kind, body);
	if (!parsed) return null;
	return {
		body,
		parsed
	};
}
function registerBrowserAgentStorageRoutes(app, ctx) {
	app.get("/cookies", asyncBrowserRoute(async (req, res) => {
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId: resolveTargetIdFromQuery(req.query),
			feature: "cookies",
			enforceCurrentUrlAllowed: true,
			run: async ({ cdpUrl, tab, pw }) => {
				const result = await pw.cookiesGetViaPlaywright({
					cdpUrl,
					targetId: tab.targetId
				});
				res.json({
					ok: true,
					targetId: tab.targetId,
					...result
				});
			}
		});
	}));
	app.post("/cookies/set", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const cookie = body.cookie && typeof body.cookie === "object" && !Array.isArray(body.cookie) ? body.cookie : null;
		if (!cookie) return jsonError(res, 400, "cookie is required");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "cookies set",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.cookiesSetViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					cookie: {
						name: toStringOrEmpty(cookie.name),
						value: toStringOrEmpty(cookie.value),
						url: toStringOrEmpty(cookie.url) || void 0,
						domain: toStringOrEmpty(cookie.domain) || void 0,
						path: toStringOrEmpty(cookie.path) || void 0,
						expires: toNumber(cookie.expires) ?? void 0,
						httpOnly: toBoolean(cookie.httpOnly) ?? void 0,
						secure: toBoolean(cookie.secure) ?? void 0,
						sameSite: cookie.sameSite === "Lax" || cookie.sameSite === "None" || cookie.sameSite === "Strict" ? cookie.sameSite : void 0
					}
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
	app.post("/cookies/clear", asyncBrowserRoute(async (req, res) => {
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId: resolveTargetIdFromBody(readBody(req)),
			feature: "cookies clear",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.cookiesClearViaPlaywright({
					cdpUrl,
					targetId: tab.targetId
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
	app.get("/storage/:kind", asyncBrowserRoute(async (req, res) => {
		const kind = parseStorageKind(toStringOrEmpty(req.params.kind));
		if (!kind) return jsonError(res, 400, "kind must be local|session");
		const targetId = resolveTargetIdFromQuery(req.query);
		const key = toStringOrEmpty(req.query.key);
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "storage get",
			enforceCurrentUrlAllowed: true,
			run: async ({ cdpUrl, tab, pw }) => {
				const result = await pw.storageGetViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					kind,
					key: normalizeOptionalString(key)
				});
				res.json({
					ok: true,
					targetId: tab.targetId,
					...result
				});
			}
		});
	}));
	app.post("/storage/:kind/set", asyncBrowserRoute(async (req, res) => {
		const mutation = parseStorageMutationFromRequest(req, res);
		if (!mutation) return;
		const key = toStringOrEmpty(mutation.body.key);
		if (!key) return jsonError(res, 400, "key is required");
		const value = typeof mutation.body.value === "string" ? mutation.body.value : "";
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId: mutation.parsed.targetId,
			feature: "storage set",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.storageSetViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					kind: mutation.parsed.kind,
					key,
					value
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
	app.post("/storage/:kind/clear", asyncBrowserRoute(async (req, res) => {
		const mutation = parseStorageMutationFromRequest(req, res);
		if (!mutation) return;
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId: mutation.parsed.targetId,
			feature: "storage clear",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.storageClearViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					kind: mutation.parsed.kind
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
	app.post("/set/offline", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const offline = toBoolean(body.offline);
		if (offline === void 0) return jsonError(res, 400, "offline is required");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "offline",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.setOfflineViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					offline
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
	app.post("/set/headers", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const headers = body.headers && typeof body.headers === "object" && !Array.isArray(body.headers) ? body.headers : null;
		if (!headers) return jsonError(res, 400, "headers is required");
		const parsed = {};
		for (const [k, v] of Object.entries(headers)) if (typeof v === "string") parsed[k] = v;
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "headers",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.setExtraHTTPHeadersViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					headers: parsed
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
	app.post("/set/credentials", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const clear = toBoolean(body.clear) ?? false;
		const username = toStringOrEmpty(body.username) || void 0;
		const password = readStringValue(body.password);
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "http credentials",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.setHttpCredentialsViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					username,
					password,
					clear
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
	app.post("/set/geolocation", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const clear = toBoolean(body.clear) ?? false;
		const latitude = toNumber(body.latitude);
		const longitude = toNumber(body.longitude);
		const accuracy = toNumber(body.accuracy) ?? void 0;
		const origin = toStringOrEmpty(body.origin) || void 0;
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "geolocation",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.setGeolocationViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					latitude,
					longitude,
					accuracy,
					origin,
					clear
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
	app.post("/set/media", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const schemeRaw = toStringOrEmpty(body.colorScheme);
		const colorScheme = schemeRaw === "dark" || schemeRaw === "light" || schemeRaw === "no-preference" ? schemeRaw : schemeRaw === "none" ? null : void 0;
		if (colorScheme === void 0) return jsonError(res, 400, "colorScheme must be dark|light|no-preference|none");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "media emulation",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.emulateMediaViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					colorScheme
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
	app.post("/set/timezone", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const timezoneId = toStringOrEmpty(body.timezoneId);
		if (!timezoneId) return jsonError(res, 400, "timezoneId is required");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "timezone",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.setTimezoneViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					timezoneId
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
	app.post("/set/locale", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const locale = toStringOrEmpty(body.locale);
		if (!locale) return jsonError(res, 400, "locale is required");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "locale",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.setLocaleViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					locale
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
	app.post("/set/device", asyncBrowserRoute(async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const name = toStringOrEmpty(body.name);
		if (!name) return jsonError(res, 400, "name is required");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "device emulation",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.setDeviceViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					name
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	}));
}
//#endregion
//#region extensions/browser/src/browser/routes/agent.ts
function registerBrowserAgentRoutes(app, ctx) {
	registerBrowserAgentSnapshotRoutes(app, ctx);
	registerBrowserAgentActRoutes(app, ctx);
	registerBrowserAgentDebugRoutes(app, ctx);
	registerBrowserAgentStorageRoutes(app, ctx);
}
//#endregion
//#region extensions/browser/src/browser/doctor.ts
function buildBrowserDoctorReport(params) {
	const status = params.status;
	const checks = [];
	const transport = status.transport === "chrome-mcp" ? "chrome-mcp" : "cdp";
	checks.push({
		id: "plugin-enabled",
		label: "Browser plugin",
		status: status.enabled ? "pass" : "fail",
		summary: status.enabled ? "enabled" : "disabled",
		...status.enabled ? {} : { fixHint: "Enable the browser plugin and restart the Gateway." }
	});
	checks.push({
		id: "profile",
		label: "Profile",
		status: "pass",
		summary: `${status.profile ?? "openclaw"} via ${transport}`
	});
	if (transport === "chrome-mcp") checks.push({
		id: "attach-target",
		label: "Existing browser attach",
		status: status.running ? "pass" : "fail",
		summary: status.running ? "Chrome MCP target is reachable" : "Chrome MCP target is not reachable",
		...status.running ? {} : { fixHint: "Keep the matching Chromium browser running, enable remote debugging in chrome://inspect, and accept the attach prompt." }
	});
	else {
		checks.push({
			id: "managed-executable",
			label: "Chromium executable",
			status: status.detectError ? "fail" : status.detectedExecutablePath ? "pass" : "warn",
			summary: status.detectError ? status.detectError : status.detectedExecutablePath ? `${status.detectedBrowser ?? "chromium"} at ${status.detectedExecutablePath}` : "No Chromium executable detected",
			...status.detectedExecutablePath || status.detectError ? {} : { fixHint: "Install Chrome/Chromium/Brave/Edge or set browser.executablePath." }
		});
		const platform = params.platform ?? process.platform;
		const env = params.env ?? process.env;
		const uid = params.uid ?? process.getuid?.();
		const missingDisplay = platform === "linux" && !status.headless && !env.DISPLAY && !env.WAYLAND_DISPLAY;
		if (status.headlessSource === "linux-display-fallback") checks.push({
			id: "headless-mode",
			label: "Headless mode",
			status: "pass",
			summary: "Linux no-display fallback selected headless mode"
		});
		if (missingDisplay) checks.push({
			id: "display",
			label: "Display",
			status: "warn",
			summary: `No DISPLAY or WAYLAND_DISPLAY is set while headed mode is selected (${status.headlessSource ?? "unknown"})`,
			fixHint: "Use a desktop session, Xvfb, set OPENCLAW_BROWSER_HEADLESS=1, or remove the headed override."
		});
		if (platform === "linux" && uid === 0 && !status.noSandbox) checks.push({
			id: "linux-sandbox",
			label: "Linux sandbox",
			status: "warn",
			summary: "Gateway is running as root while browser.noSandbox is false",
			fixHint: "Set browser.noSandbox: true for container/root Chromium runtimes."
		});
		checks.push({
			id: "cdp-http",
			label: "CDP HTTP",
			status: status.cdpHttp ? "pass" : status.running ? "fail" : "info",
			summary: status.cdpHttp ? "CDP HTTP endpoint is reachable" : status.running ? "CDP HTTP endpoint is not reachable" : "Browser is not currently running",
			...status.cdpHttp || !status.running ? {} : { fixHint: "Run openclaw browser start or inspect browser.cdpUrl/CDP port reachability." }
		});
		checks.push({
			id: "cdp-websocket",
			label: "CDP WebSocket",
			status: status.cdpReady ? "pass" : status.running ? "fail" : "info",
			summary: status.cdpReady ? "CDP WebSocket is reachable" : status.running ? "CDP WebSocket is not reachable" : "Browser is launchable but not running",
			...status.cdpReady || !status.running ? {} : { fixHint: "Check Chrome launch logs, stale locks, proxy env, and port conflicts." }
		});
	}
	return {
		ok: checks.every((check) => check.status !== "fail"),
		profile: status.profile ?? "openclaw",
		transport,
		checks,
		status
	};
}
//#endregion
//#region extensions/browser/src/browser/profiles-service.ts
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
function createBrowserProfilesService(ctx) {
	const listProfiles = async () => {
		return await ctx.listProfiles();
	};
	const createProfile = async (params) => {
		const name = params.name.trim();
		const rawCdpUrl = normalizeOptionalString$4(params.cdpUrl);
		const rawUserDataDir = normalizeOptionalString$4(params.userDataDir);
		const normalizedUserDataDir = rawUserDataDir ? resolveUserPath(rawUserDataDir) : void 0;
		const driver = params.driver === "existing-session" ? "existing-session" : void 0;
		if (!isValidProfileName(name)) throw new BrowserValidationError("invalid profile name: use lowercase letters, numbers, and hyphens only");
		const state = ctx.state();
		if (name in state.resolved.profiles) throw new BrowserConflictError(`profile "${name}" already exists`);
		if (name in (getRuntimeConfig().browser?.profiles ?? {})) throw new BrowserConflictError(`profile "${name}" already exists`);
		const explicitProfileColor = params.color && HEX_COLOR_RE.test(params.color) ? params.color : void 0;
		let parsedCdpUrl;
		if (normalizedUserDataDir && driver !== "existing-session") throw new BrowserValidationError("driver=existing-session is required when userDataDir is provided");
		if (normalizedUserDataDir && !fs.existsSync(normalizedUserDataDir)) throw new BrowserValidationError(`browser user data directory not found: ${normalizedUserDataDir}`);
		if (rawCdpUrl) {
			if (driver === "existing-session") throw new BrowserValidationError("driver=existing-session does not accept cdpUrl; it attaches via the Chrome MCP auto-connect flow");
			let parsed;
			try {
				parsed = parseBrowserHttpUrl(rawCdpUrl, "browser.profiles.cdpUrl");
				await assertCdpEndpointAllowed(parsed.normalized, state.resolved.ssrfPolicy);
			} catch (err) {
				throw new BrowserValidationError(formatErrorMessage(err));
			}
			parsedCdpUrl = parsed.normalized;
		}
		const profileConfig = await createBrowserProfileConfig({
			name,
			resolved: state.resolved,
			...explicitProfileColor ? { color: explicitProfileColor } : {},
			...parsedCdpUrl ? { parsedCdpUrl } : {},
			...normalizedUserDataDir ? { userDataDir: normalizedUserDataDir } : {},
			...driver ? { driver } : {}
		});
		if (!profileConfig) throw new BrowserProfileNotFoundError(`profile "${name}" not found after creation`);
		state.resolved.profiles[name] = profileConfig;
		const resolved = resolveProfile(state.resolved, name);
		if (!resolved) throw new BrowserProfileNotFoundError(`profile "${name}" not found after creation`);
		const capabilities = getBrowserProfileCapabilities(resolved);
		return {
			ok: true,
			profile: name,
			transport: capabilities.usesChromeMcp ? "chrome-mcp" : "cdp",
			cdpPort: capabilities.usesChromeMcp ? null : resolved.cdpPort,
			cdpUrl: capabilities.usesChromeMcp ? null : resolved.cdpUrl,
			userDataDir: resolved.userDataDir ?? null,
			color: resolved.color,
			isRemote: !resolved.cdpIsLoopback
		};
	};
	const deleteProfile = async (nameRaw) => {
		const name = nameRaw.trim();
		if (!name) throw new BrowserValidationError("profile name is required");
		if (!isValidProfileName(name)) throw new BrowserValidationError("invalid profile name");
		const state = ctx.state();
		const cfg = getRuntimeConfig();
		const profiles = cfg.browser?.profiles ?? {};
		if (name === (cfg.browser?.defaultProfile ?? state.resolved.defaultProfile)) throw new BrowserValidationError(`cannot delete the default profile "${name}"; change browser.defaultProfile first`);
		if (!(name in profiles)) throw new BrowserProfileNotFoundError(`profile "${name}" not found`);
		let deleted = false;
		const resolved = resolveProfile(state.resolved, name);
		if (resolved?.cdpIsLoopback && resolved.driver === "openclaw") {
			try {
				await ctx.forProfile(name).stopRunningBrowser();
			} catch {}
			const userDataDir = resolveOpenClawUserDataDir(name);
			const profileDir = path.dirname(userDataDir);
			if (fs.existsSync(profileDir)) {
				await movePathToTrash(profileDir);
				deleted = true;
			}
		}
		await deleteBrowserProfileConfig(name);
		delete state.resolved.profiles[name];
		state.profiles.delete(name);
		return {
			ok: true,
			profile: name,
			deleted
		};
	};
	return {
		listProfiles,
		createProfile,
		deleteProfile
	};
}
//#endregion
//#region extensions/browser/src/browser/routes/basic.ts
const STATUS_CDP_HTTP_TIMEOUT_MS = 300;
const STATUS_CDP_TRANSPORT_TIMEOUT_MS = 600;
const STATUS_CHROME_MCP_TOTAL_TIMEOUT_MS = 7e3;
const STATUS_CHROME_MCP_TRANSPORT_TIMEOUT_MS = 5e3;
function remainingChromeMcpStatusTimeoutMs(startedAtMs) {
	return Math.max(1, STATUS_CHROME_MCP_TOTAL_TIMEOUT_MS - (Date.now() - startedAtMs));
}
async function probeChromeMcpPageReady(profileCtx, timeoutMs) {
	const abort = new AbortController();
	const timer = setTimeout(() => {
		abort.abort(/* @__PURE__ */ new Error(`Chrome MCP page-readiness probe timed out after ${timeoutMs}ms.`));
	}, timeoutMs);
	try {
		return await profileCtx.isReachable(timeoutMs, {
			ephemeral: true,
			signal: abort.signal
		});
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
function handleBrowserRouteError(res, err) {
	const mapped = toBrowserErrorResponse(err);
	if (mapped) return jsonError(res, mapped.status, mapped.message);
	jsonError(res, 500, String(err));
}
async function withBasicProfileRoute(params) {
	const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
	if (!profileCtx) return;
	try {
		await params.run(profileCtx);
	} catch (err) {
		return handleBrowserRouteError(params.res, err);
	}
}
async function withProfilesServiceMutation(params) {
	try {
		const service = createBrowserProfilesService(params.ctx);
		const result = await params.run(service);
		params.res.json(result);
	} catch (err) {
		return handleBrowserRouteError(params.res, err);
	}
}
async function buildBrowserStatus(req, ctx) {
	let current;
	try {
		current = ctx.state();
	} catch {
		throw new BrowserError("browser server not started", 503);
	}
	const profileCtx = getProfileContext(req, ctx);
	if ("error" in profileCtx) throw new BrowserError(profileCtx.error, profileCtx.status);
	const capabilities = getBrowserProfileCapabilities(profileCtx.profile);
	const [cdpHttp, cdpReady, pageReady] = capabilities.usesChromeMcp ? await (async () => {
		const statusStartedAtMs = Date.now();
		const transportReady = await profileCtx.isTransportAvailable(STATUS_CHROME_MCP_TRANSPORT_TIMEOUT_MS);
		if (!transportReady) return [
			false,
			false,
			false
		];
		return [
			transportReady,
			transportReady,
			await probeChromeMcpPageReady(profileCtx, remainingChromeMcpStatusTimeoutMs(statusStartedAtMs))
		];
	})() : await (async () => {
		const [http, ready] = await Promise.all([profileCtx.isHttpReachable(STATUS_CDP_HTTP_TIMEOUT_MS), profileCtx.isTransportAvailable(STATUS_CDP_TRANSPORT_TIMEOUT_MS)]);
		return [
			http,
			ready,
			ready
		];
	})();
	const profileState = current.profiles.get(profileCtx.profile.name);
	let detectedBrowser = null;
	let detectedExecutablePath = null;
	let detectError = null;
	try {
		const detected = resolveBrowserExecutableForPlatform(current.resolved, process.platform);
		if (detected) {
			detectedBrowser = detected.kind;
			detectedExecutablePath = detected.path;
		}
	} catch (err) {
		detectError = String(err);
	}
	const configuredHeadlessMode = resolveManagedBrowserHeadlessMode(current.resolved, profileCtx.profile);
	const headlessMode = typeof profileState?.running?.headless === "boolean" ? {
		headless: profileState.running.headless,
		source: profileState.running.headlessSource ?? configuredHeadlessMode.source
	} : configuredHeadlessMode;
	return {
		enabled: current.resolved.enabled,
		profile: profileCtx.profile.name,
		driver: profileCtx.profile.driver,
		transport: capabilities.usesChromeMcp ? "chrome-mcp" : "cdp",
		running: cdpReady,
		cdpReady,
		cdpHttp,
		pageReady,
		pid: capabilities.usesChromeMcp ? getChromeMcpPid(profileCtx.profile.name) : profileState?.running?.pid ?? null,
		cdpPort: capabilities.usesChromeMcp ? null : profileCtx.profile.cdpPort,
		cdpUrl: capabilities.usesChromeMcp ? null : redactCdpUrl(profileCtx.profile.cdpUrl) ?? null,
		chosenBrowser: profileState?.running?.exe.kind ?? null,
		detectedBrowser,
		detectedExecutablePath,
		detectError,
		userDataDir: profileState?.running?.userDataDir ?? profileCtx.profile.userDataDir ?? null,
		color: profileCtx.profile.color,
		headless: headlessMode.headless,
		headlessSource: headlessMode.source,
		noSandbox: current.resolved.noSandbox,
		executablePath: profileCtx.profile.executablePath ?? null,
		attachOnly: profileCtx.profile.attachOnly
	};
}
async function runBrowserLiveProbe(req, ctx) {
	const profileCtx = getProfileContext(req, ctx);
	if ("error" in profileCtx) return {
		id: "live-snapshot",
		label: "Live snapshot",
		status: "fail",
		summary: profileCtx.error
	};
	const capabilities = getBrowserProfileCapabilities(profileCtx.profile);
	try {
		const tab = await profileCtx.ensureTabAvailable();
		if (capabilities.usesChromeMcp) {
			const { takeChromeMcpSnapshot } = await import("./chrome-mcp-CZQfPH5e.js");
			await takeChromeMcpSnapshot({
				profileName: profileCtx.profile.name,
				profile: profileCtx.profile,
				targetId: tab.targetId
			});
			return {
				id: "live-snapshot",
				label: "Live snapshot",
				status: "pass",
				summary: `Chrome MCP snapshot succeeded on ${tab.suggestedTargetId ?? tab.targetId}`
			};
		}
		if (!tab.wsUrl) return {
			id: "live-snapshot",
			label: "Live snapshot",
			status: "warn",
			summary: "No per-tab CDP WebSocket available for the lightweight live snapshot probe"
		};
		const snap = await snapshotAria({
			wsUrl: tab.wsUrl,
			limit: 25
		});
		return {
			id: "live-snapshot",
			label: "Live snapshot",
			status: snap.nodes.length > 0 ? "pass" : "warn",
			summary: snap.nodes.length > 0 ? `CDP accessibility snapshot returned ${snap.nodes.length} nodes on ${tab.suggestedTargetId ?? tab.targetId}` : `CDP accessibility snapshot returned no nodes on ${tab.suggestedTargetId ?? tab.targetId}`
		};
	} catch (err) {
		return {
			id: "live-snapshot",
			label: "Live snapshot",
			status: "fail",
			summary: String(err),
			fixHint: "Run openclaw browser start, then retry with openclaw browser doctor --deep."
		};
	}
}
function hasQueryKey(query, key) {
	return Object.prototype.hasOwnProperty.call(query ?? {}, key);
}
function parseHeadlessStartOverride(params) {
	if (!hasQueryKey(params.req.query, "headless")) return { ok: true };
	const headless = toBoolean(params.req.query.headless);
	if (typeof headless !== "boolean") {
		jsonError(params.res, 400, "Invalid headless value. Use \"true\" or \"false\".");
		return { ok: false };
	}
	const capabilities = getBrowserProfileCapabilities(params.profileCtx.profile);
	if (params.profileCtx.profile.driver !== "openclaw" || params.profileCtx.profile.attachOnly || capabilities.isRemote) {
		jsonError(params.res, 400, `Headless start override is only supported for locally launched openclaw profiles. Profile "${params.profileCtx.profile.name}" is attach-only, remote, or existing-session.`);
		return { ok: false };
	}
	return {
		ok: true,
		headless
	};
}
function registerBrowserBasicRoutes(app, ctx) {
	app.get("/profiles", asyncBrowserRoute(async (_req, res) => {
		try {
			const profiles = await createBrowserProfilesService(ctx).listProfiles();
			res.json({ profiles });
		} catch (err) {
			jsonError(res, 500, String(err));
		}
	}));
	app.get("/", asyncBrowserRoute(async (req, res) => {
		try {
			res.json(await buildBrowserStatus(req, ctx));
		} catch (err) {
			const mapped = toBrowserErrorResponse(err);
			if (mapped) return jsonError(res, mapped.status, mapped.message);
			jsonError(res, 500, String(err));
		}
	}));
	app.get("/doctor", asyncBrowserRoute(async (req, res) => {
		try {
			const report = buildBrowserDoctorReport({ status: await buildBrowserStatus(req, ctx) });
			if (toBoolean(req.query.deep) === true || toBoolean(req.query.live) === true) {
				report.checks.push(await runBrowserLiveProbe(req, ctx));
				report.ok = report.checks.every((check) => check.status !== "fail");
			}
			res.json(report);
		} catch (err) {
			const mapped = toBrowserErrorResponse(err);
			if (mapped) return jsonError(res, mapped.status, mapped.message);
			jsonError(res, 500, String(err));
		}
	}));
	app.post("/start", asyncBrowserRoute(async (req, res) => {
		await withBasicProfileRoute({
			req,
			res,
			ctx,
			run: async (profileCtx) => {
				const headlessOverride = parseHeadlessStartOverride({
					req,
					res,
					profileCtx
				});
				if (!headlessOverride.ok) return;
				await profileCtx.ensureBrowserAvailable({ headless: headlessOverride.headless });
				res.json({
					ok: true,
					profile: profileCtx.profile.name
				});
			}
		});
	}));
	app.post("/stop", asyncBrowserRoute(async (req, res) => {
		await withBasicProfileRoute({
			req,
			res,
			ctx,
			run: async (profileCtx) => {
				const result = await profileCtx.stopRunningBrowser();
				res.json({
					ok: true,
					stopped: result.stopped,
					profile: profileCtx.profile.name
				});
			}
		});
	}));
	app.post("/reset-profile", asyncBrowserRoute(async (req, res) => {
		await withBasicProfileRoute({
			req,
			res,
			ctx,
			run: async (profileCtx) => {
				const result = await profileCtx.resetProfile();
				res.json({
					ok: true,
					profile: profileCtx.profile.name,
					...result
				});
			}
		});
	}));
	app.post("/profiles/create", asyncBrowserRoute(async (req, res) => {
		const name = toStringOrEmpty(req.body?.name);
		const color = toStringOrEmpty(req.body?.color);
		const cdpUrl = toStringOrEmpty(req.body?.cdpUrl);
		const userDataDir = toStringOrEmpty(req.body?.userDataDir);
		const driver = toStringOrEmpty(req.body?.driver);
		if (!name) return jsonError(res, 400, "name is required");
		if (driver && driver !== "openclaw" && driver !== "clawd" && driver !== "existing-session") return jsonError(res, 400, `unsupported profile driver "${driver}"; use "openclaw", "clawd", or "existing-session"`);
		await withProfilesServiceMutation({
			res,
			ctx,
			run: async (service) => await service.createProfile({
				name,
				color: color || void 0,
				cdpUrl: cdpUrl || void 0,
				userDataDir: userDataDir || void 0,
				driver: driver === "existing-session" ? "existing-session" : driver === "openclaw" || driver === "clawd" ? "openclaw" : void 0
			})
		});
	}));
	app.delete("/profiles/:name", asyncBrowserRoute(async (req, res) => {
		const name = toStringOrEmpty(req.params.name);
		if (!name) return jsonError(res, 400, "profile name is required");
		await withProfilesServiceMutation({
			res,
			ctx,
			run: async (service) => await service.deleteProfile(name)
		});
	}));
}
//#endregion
//#region extensions/browser/src/browser/routes/permissions.ts
const permissionRouteDeps = { getPwAiModule: getPwAiModule$1 };
function readOrigin(raw) {
	const value = toStringOrEmpty(raw);
	if (!value) return null;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return parsed.origin;
	} catch {
		return null;
	}
}
function readPermissions(raw) {
	if (!Array.isArray(raw)) return null;
	const permissions = raw.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean);
	if (permissions.length !== raw.length) return null;
	return [...new Set(permissions)];
}
async function grantPermissions(params) {
	const allPermissions = [...new Set([...params.requiredPermissions, ...params.optionalPermissions])];
	const playwrightRequiredPermissions = params.requiredPermissions.map(toPlaywrightPermission);
	if (playwrightRequiredPermissions.every((value) => Boolean(value)) && params.requiredPermissions.length > 0) {
		const pw = await permissionRouteDeps.getPwAiModule({ mode: "soft" });
		if (pw) try {
			await (await pw.getPageForTargetId({
				cdpUrl: params.profileCtx.profile.cdpUrl,
				targetId: params.targetId,
				ssrfPolicy: params.ssrfPolicy
			})).context().grantPermissions(playwrightRequiredPermissions, { origin: params.origin });
			return {
				grantedPermissions: params.requiredPermissions,
				unsupportedPermissions: params.optionalPermissions,
				grantMethod: "playwright"
			};
		} catch {}
	}
	let unsupportedPermissions = [];
	await withCdpSocket(params.wsUrl, async (send) => {
		try {
			await send("Browser.grantPermissions", {
				origin: params.origin,
				permissions: allPermissions
			});
			return;
		} catch (error) {
			if (params.optionalPermissions.length === 0) throw error;
		}
		await send("Browser.grantPermissions", {
			origin: params.origin,
			permissions: params.requiredPermissions
		});
		unsupportedPermissions = params.optionalPermissions;
	}, { commandTimeoutMs: params.timeoutMs });
	return {
		grantedPermissions: allPermissions.filter((value) => !unsupportedPermissions.includes(value)),
		unsupportedPermissions,
		grantMethod: "cdp"
	};
}
function toPlaywrightPermission(permission) {
	switch (permission) {
		case "audioCapture": return "microphone";
		case "videoCapture": return "camera";
		default: return;
	}
}
function registerBrowserPermissionRoutes(app, ctx) {
	app.post("/permissions/grant", asyncBrowserRoute(async (req, res) => {
		const profileCtx = getProfileContext(req, ctx);
		if ("error" in profileCtx) return jsonError(res, profileCtx.status, profileCtx.error);
		const body = req.body ?? {};
		const origin = readOrigin(body.origin);
		if (!origin) return jsonError(res, 400, "origin must be an http(s) origin");
		const requiredPermissions = readPermissions(body.permissions);
		if (!requiredPermissions || requiredPermissions.length === 0) return jsonError(res, 400, "permissions must be a non-empty string array");
		const optionalPermissions = readPermissions(body.optionalPermissions ?? []) ?? [];
		const targetId = toStringOrEmpty(body.targetId) || void 0;
		const timeoutMs = Math.max(1e3, toNumber(body.timeoutMs) ?? 5e3);
		try {
			await profileCtx.ensureBrowserAvailable();
			const wsUrl = await getChromeWebSocketUrl(profileCtx.profile.cdpUrl, timeoutMs, ctx.state().resolved.ssrfPolicy);
			if (!wsUrl) return jsonError(res, 409, "browser CDP WebSocket unavailable");
			const granted = await grantPermissions({
				profileCtx,
				targetId,
				wsUrl,
				origin,
				requiredPermissions,
				optionalPermissions,
				timeoutMs,
				ssrfPolicy: ctx.state().resolved.ssrfPolicy
			});
			return res.json({
				ok: true,
				origin,
				...granted
			});
		} catch (error) {
			return jsonError(res, 500, error instanceof Error ? error.message : String(error));
		}
	}));
}
//#endregion
//#region extensions/browser/src/browser/routes/tabs.ts
function resolveTabsProfileContext(req, res, ctx) {
	const profileCtx = getProfileContext(req, ctx);
	if ("error" in profileCtx) {
		jsonError(res, profileCtx.status, profileCtx.error);
		return null;
	}
	return profileCtx;
}
function browserNavigationPolicyForProfile(ctx, profileCtx) {
	return withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy, { browserProxyMode: resolveBrowserNavigationProxyMode({
		resolved: ctx.state().resolved,
		profile: profileCtx.profile
	}) });
}
function handleTabsRouteError(ctx, res, err, opts) {
	if (opts?.mapTabError) {
		const mapped = ctx.mapTabError(err);
		if (mapped) return jsonError(res, mapped.status, mapped.message);
	}
	return jsonError(res, 500, String(err));
}
async function withTabsProfileRoute(params) {
	const profileCtx = resolveTabsProfileContext(params.req, params.res, params.ctx);
	if (!profileCtx) return;
	try {
		await params.run(profileCtx);
	} catch (err) {
		handleTabsRouteError(params.ctx, params.res, err, { mapTabError: params.mapTabError });
	}
}
async function ensureBrowserRunning(profileCtx, res) {
	if (!await profileCtx.isReachable(300)) {
		jsonError(res, new BrowserProfileUnavailableError("browser not running").status, "browser not running");
		return false;
	}
	return true;
}
async function redactBlockedTabUrls(params) {
	const ssrfPolicyOpts = withBrowserNavigationPolicy(params.ssrfPolicy);
	if (!ssrfPolicyOpts.ssrfPolicy) return params.tabs;
	const redactedTabs = [];
	for (const tab of params.tabs) try {
		await assertBrowserNavigationResultAllowed({
			url: tab.url,
			...ssrfPolicyOpts
		});
		redactedTabs.push(tab);
	} catch {
		redactedTabs.push({
			...tab,
			url: ""
		});
	}
	return redactedTabs;
}
function resolveIndexedTab(tabs, index) {
	return typeof index === "number" ? tabs[index] : tabs.at(0);
}
function parseRequiredTargetId(res, rawTargetId) {
	const targetId = toStringOrEmpty(rawTargetId);
	if (!targetId) {
		jsonError(res, 400, "targetId is required");
		return null;
	}
	return targetId;
}
function readOptionalTabLabel(body) {
	return toStringOrEmpty(body?.label) || void 0;
}
async function runTabTargetMutation(params) {
	await withTabsProfileRoute({
		req: params.req,
		res: params.res,
		ctx: params.ctx,
		mapTabError: true,
		run: async (profileCtx) => {
			if (!await ensureBrowserRunning(profileCtx, params.res)) return;
			await params.mutate(profileCtx, params.targetId);
			params.res.json({ ok: true });
		}
	});
}
function registerBrowserTabRoutes(app, ctx) {
	app.get("/tabs", asyncBrowserRoute(async (req, res) => {
		await withTabsProfileRoute({
			req,
			res,
			ctx,
			run: async (profileCtx) => {
				if (!await profileCtx.isReachable(300)) return res.json({
					running: false,
					tabs: []
				});
				const tabs = await redactBlockedTabUrls({
					tabs: await profileCtx.listTabs(),
					ssrfPolicy: ctx.state().resolved.ssrfPolicy
				});
				res.json({
					running: true,
					tabs
				});
			}
		});
	}));
	app.post("/tabs/open", asyncBrowserRoute(async (req, res) => {
		const url = toStringOrEmpty(req.body?.url);
		const label = readOptionalTabLabel(req.body);
		if (!url) return jsonError(res, 400, "url is required");
		await withTabsProfileRoute({
			req,
			res,
			ctx,
			mapTabError: true,
			run: async (profileCtx) => {
				await assertBrowserNavigationAllowed({
					url,
					...browserNavigationPolicyForProfile(ctx, profileCtx)
				});
				await profileCtx.ensureBrowserAvailable();
				const tab = await profileCtx.openTab(url, { label });
				res.json(tab);
			}
		});
	}));
	app.post("/tabs/focus", asyncBrowserRoute(async (req, res) => {
		const targetId = parseRequiredTargetId(res, req.body?.targetId);
		if (!targetId) return;
		await runTabTargetMutation({
			req,
			res,
			ctx,
			targetId,
			mutate: async (profileCtx, id) => {
				const tabs = await profileCtx.listTabs();
				const resolved = resolveTargetIdFromTabs(id, tabs);
				if (!resolved.ok) {
					if (resolved.reason === "ambiguous") throw new BrowserTargetAmbiguousError();
					throw new BrowserTabNotFoundError({ input: id });
				}
				const tab = tabs.find((currentTab) => currentTab.targetId === resolved.targetId);
				if (!tab) throw new BrowserTabNotFoundError({ input: id });
				const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
				if (ssrfPolicyOpts.ssrfPolicy) await assertBrowserNavigationResultAllowed({
					url: tab.url,
					...ssrfPolicyOpts
				});
				await profileCtx.focusTab(resolved.targetId);
			}
		});
	}));
	app.delete("/tabs/:targetId", asyncBrowserRoute(async (req, res) => {
		const targetId = parseRequiredTargetId(res, req.params.targetId);
		if (!targetId) return;
		await runTabTargetMutation({
			req,
			res,
			ctx,
			targetId,
			mutate: async (profileCtx, id) => {
				await profileCtx.closeTab(id);
			}
		});
	}));
	app.post("/tabs/action", asyncBrowserRoute(async (req, res) => {
		const action = toStringOrEmpty(req.body?.action);
		const index = toNumber(req.body?.index);
		await withTabsProfileRoute({
			req,
			res,
			ctx,
			mapTabError: true,
			run: async (profileCtx) => {
				if (action === "list") {
					if (!await profileCtx.isReachable(300)) return res.json({
						ok: true,
						tabs: []
					});
					const tabs = await redactBlockedTabUrls({
						tabs: await profileCtx.listTabs(),
						ssrfPolicy: ctx.state().resolved.ssrfPolicy
					});
					return res.json({
						ok: true,
						tabs
					});
				}
				if (action === "new") {
					await profileCtx.ensureBrowserAvailable();
					const tab = await profileCtx.openTab("about:blank", { label: readOptionalTabLabel(req.body) });
					return res.json({
						ok: true,
						tab
					});
				}
				if (action === "label") {
					if (!await ensureBrowserRunning(profileCtx, res)) return;
					const targetId = parseRequiredTargetId(res, req.body?.targetId);
					if (!targetId) return;
					const label = readOptionalTabLabel(req.body);
					if (!label) return jsonError(res, 400, "label is required");
					const tab = await profileCtx.labelTab(targetId, label);
					return res.json({
						ok: true,
						tab
					});
				}
				if (action === "close") {
					if (!await ensureBrowserRunning(profileCtx, res)) return;
					const target = resolveIndexedTab(await profileCtx.listTabs(), index);
					if (!target) throw new BrowserTabNotFoundError();
					await profileCtx.closeTab(target.targetId);
					return res.json({
						ok: true,
						targetId: target.targetId
					});
				}
				if (action === "select") {
					if (typeof index !== "number") return jsonError(res, 400, "index is required");
					if (!await ensureBrowserRunning(profileCtx, res)) return;
					const target = (await profileCtx.listTabs())[index];
					if (!target) throw new BrowserTabNotFoundError();
					const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
					if (ssrfPolicyOpts.ssrfPolicy) await assertBrowserNavigationResultAllowed({
						url: target.url,
						...ssrfPolicyOpts
					});
					await profileCtx.focusTab(target.targetId);
					return res.json({
						ok: true,
						targetId: target.targetId
					});
				}
				return jsonError(res, 400, "unknown tab action");
			}
		});
	}));
}
//#endregion
//#region extensions/browser/src/browser/routes/index.ts
function registerBrowserRoutes(app, ctx) {
	registerBrowserBasicRoutes(app, ctx);
	registerBrowserTabRoutes(app, ctx);
	registerBrowserPermissionRoutes(app, ctx);
	registerBrowserAgentRoutes(app, ctx);
}
//#endregion
export { registerBrowserRoutes as t };
