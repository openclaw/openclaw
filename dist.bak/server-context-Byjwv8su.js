import { u as resolveGatewayPort } from "./paths-B4BZAPZh.js";
import { Gt as writeConfigFile, Rt as createConfigIO, zt as loadConfig } from "./model-selection-DILdVnl8.js";
import { t as parseBooleanValue } from "./boolean-Wzu0-e0P.js";
import { A as DEFAULT_OPENCLAW_BROWSER_ENABLED, C as stopChromeExtensionRelayServer, D as DEFAULT_BROWSER_DEFAULT_PROFILE_NAME, E as DEFAULT_AI_SNAPSHOT_MAX_CHARS, O as DEFAULT_BROWSER_EVALUATE_ENABLED, S as ensureChromeExtensionRelayServer, T as DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS, _ as appendCdpPath, a as resolveOpenClawUserDataDir, c as captureScreenshot, d as normalizeCdpWsUrl, f as snapshotAria, g as withBrowserNavigationPolicy, h as assertBrowserNavigationResultAllowed, i as launchOpenClawChrome, j as DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME, k as DEFAULT_OPENCLAW_BROWSER_COLOR, l as createTargetViaCdp, m as assertBrowserNavigationAllowed, n as isChromeCdpReady, o as stopOpenClawChrome, p as InvalidBrowserNavigationUrlError, r as isChromeReachable, s as resolveBrowserExecutableForPlatform, v as fetchJson, w as DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH, y as fetchOk } from "./chrome-b8UNhmri.js";
import { i as isLoopbackHost } from "./ws-zZ6eXqMi.js";
import { a as resolveGatewayAuth } from "./auth-BcIsRQqi.js";
import { c as normalizeBrowserFormField, i as resolveExistingPathsWithinRoot, n as DEFAULT_TRACE_DIR, o as resolveWritablePathWithinRoot, r as DEFAULT_UPLOAD_DIR, t as DEFAULT_DOWNLOAD_DIR } from "./paths-s0KCOZny.js";
import { n as formatErrorMessage, t as extractErrorCode } from "./errors-8IxbaLwV.js";
import { t as SsrFBlockedError } from "./ssrf-DN6IsWAy.js";
import { i as getImageMetadata, n as buildImageResizeSideGrid, s as resizeToJpeg, t as IMAGE_REDUCE_QUALITY_STEPS } from "./image-ops-CFCg0YOh.js";
import { r as saveMediaBuffer, t as ensureMediaDir } from "./store-DLi2fq1F.js";
import { t as movePathToTrash } from "./trash-B8xEzWgw.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import crypto from "node:crypto";

//#region src/gateway/startup-auth.ts
function mergeGatewayTailscaleConfig(base, override) {
	const merged = { ...base };
	if (!override) return merged;
	if (override.mode !== void 0) merged.mode = override.mode;
	if (override.resetOnExit !== void 0) merged.resetOnExit = override.resetOnExit;
	return merged;
}
function resolveGatewayAuthFromConfig(params) {
	const tailscaleConfig = mergeGatewayTailscaleConfig(params.cfg.gateway?.tailscale, params.tailscaleOverride);
	return resolveGatewayAuth({
		authConfig: params.cfg.gateway?.auth,
		authOverride: params.authOverride,
		env: params.env,
		tailscaleMode: tailscaleConfig.mode ?? "off"
	});
}
function shouldPersistGeneratedToken(params) {
	if (!params.persistRequested) return false;
	if (params.resolvedAuth.modeSource === "override") return false;
	return true;
}
async function ensureGatewayStartupAuth(params) {
	const env = params.env ?? process.env;
	const persistRequested = params.persist === true;
	const resolved = resolveGatewayAuthFromConfig({
		cfg: params.cfg,
		env,
		authOverride: params.authOverride,
		tailscaleOverride: params.tailscaleOverride
	});
	if (resolved.mode !== "token" || (resolved.token?.trim().length ?? 0) > 0) {
		assertHooksTokenSeparateFromGatewayAuth({
			cfg: params.cfg,
			auth: resolved
		});
		return {
			cfg: params.cfg,
			auth: resolved,
			persistedGeneratedToken: false
		};
	}
	const generatedToken = crypto.randomBytes(24).toString("hex");
	const nextCfg = {
		...params.cfg,
		gateway: {
			...params.cfg.gateway,
			auth: {
				...params.cfg.gateway?.auth,
				mode: "token",
				token: generatedToken
			}
		}
	};
	const persist = shouldPersistGeneratedToken({
		persistRequested,
		resolvedAuth: resolved
	});
	if (persist) await writeConfigFile(nextCfg);
	const nextAuth = resolveGatewayAuthFromConfig({
		cfg: nextCfg,
		env,
		authOverride: params.authOverride,
		tailscaleOverride: params.tailscaleOverride
	});
	assertHooksTokenSeparateFromGatewayAuth({
		cfg: nextCfg,
		auth: nextAuth
	});
	return {
		cfg: nextCfg,
		auth: nextAuth,
		generatedToken,
		persistedGeneratedToken: persist
	};
}
function assertHooksTokenSeparateFromGatewayAuth(params) {
	if (params.cfg.hooks?.enabled !== true) return;
	const hooksToken = typeof params.cfg.hooks.token === "string" ? params.cfg.hooks.token.trim() : "";
	if (!hooksToken) return;
	const gatewayToken = params.auth.mode === "token" && typeof params.auth.token === "string" ? params.auth.token.trim() : "";
	if (!gatewayToken) return;
	if (hooksToken !== gatewayToken) return;
	throw new Error("Invalid config: hooks.token must not match gateway auth token. Set a distinct hooks.token for hook ingress.");
}

//#endregion
//#region src/browser/control-auth.ts
function resolveBrowserControlAuth(cfg, env = process.env) {
	const auth = resolveGatewayAuth({
		authConfig: cfg?.gateway?.auth,
		env,
		tailscaleMode: cfg?.gateway?.tailscale?.mode
	});
	const token = typeof auth.token === "string" ? auth.token.trim() : "";
	const password = typeof auth.password === "string" ? auth.password.trim() : "";
	return {
		token: token || void 0,
		password: password || void 0
	};
}
function shouldAutoGenerateBrowserAuth(env) {
	if ((env.NODE_ENV ?? "").trim().toLowerCase() === "test") return false;
	const vitest = (env.VITEST ?? "").trim().toLowerCase();
	if (vitest && vitest !== "0" && vitest !== "false" && vitest !== "off") return false;
	return true;
}
async function ensureBrowserControlAuth(params) {
	const env = params.env ?? process.env;
	const auth = resolveBrowserControlAuth(params.cfg, env);
	if (auth.token || auth.password) return { auth };
	if (!shouldAutoGenerateBrowserAuth(env)) return { auth };
	if (params.cfg.gateway?.auth?.mode === "password") return { auth };
	if (params.cfg.gateway?.auth?.mode === "none") return { auth };
	if (params.cfg.gateway?.auth?.mode === "trusted-proxy") return { auth };
	const latestCfg = loadConfig();
	const latestAuth = resolveBrowserControlAuth(latestCfg, env);
	if (latestAuth.token || latestAuth.password) return { auth: latestAuth };
	if (latestCfg.gateway?.auth?.mode === "password") return { auth: latestAuth };
	if (latestCfg.gateway?.auth?.mode === "none") return { auth: latestAuth };
	if (latestCfg.gateway?.auth?.mode === "trusted-proxy") return { auth: latestAuth };
	const ensured = await ensureGatewayStartupAuth({
		cfg: latestCfg,
		env,
		persist: true
	});
	return {
		auth: resolveBrowserControlAuth(ensured.cfg, env),
		generatedToken: ensured.generatedToken
	};
}

//#endregion
//#region src/browser/pw-ai-module.ts
let pwAiModuleSoft = null;
let pwAiModuleStrict = null;
function isModuleNotFoundError(err) {
	if (extractErrorCode(err) === "ERR_MODULE_NOT_FOUND") return true;
	const msg = formatErrorMessage(err);
	return msg.includes("Cannot find module") || msg.includes("Cannot find package") || msg.includes("Failed to resolve import") || msg.includes("Failed to resolve entry for package") || msg.includes("Failed to load url");
}
async function loadPwAiModule(mode) {
	try {
		return await import("./pw-ai-LhIMGWVB.js");
	} catch (err) {
		if (mode === "soft") return null;
		if (isModuleNotFoundError(err)) return null;
		throw err;
	}
}
async function getPwAiModule$1(opts) {
	if ((opts?.mode ?? "soft") === "soft") {
		if (!pwAiModuleSoft) pwAiModuleSoft = loadPwAiModule("soft");
		return await pwAiModuleSoft;
	}
	if (!pwAiModuleStrict) pwAiModuleStrict = loadPwAiModule("strict");
	return await pwAiModuleStrict;
}

//#endregion
//#region src/browser/routes/utils.ts
/**
* Extract profile name from query string or body and get profile context.
* Query string takes precedence over body for consistency with GET routes.
*/
function getProfileContext(req, ctx) {
	let profileName;
	if (typeof req.query.profile === "string") profileName = req.query.profile.trim() || void 0;
	if (!profileName && req.body && typeof req.body === "object") {
		const body = req.body;
		if (typeof body.profile === "string") profileName = body.profile.trim() || void 0;
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
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
	return "";
}
function toNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function toBoolean(value) {
	return parseBooleanValue(value, {
		truthy: [
			"true",
			"1",
			"yes"
		],
		falsy: [
			"false",
			"0",
			"no"
		]
	});
}
function toStringArray(value) {
	if (!Array.isArray(value)) return;
	const strings = value.map((v) => toStringOrEmpty(v)).filter(Boolean);
	return strings.length ? strings : void 0;
}

//#endregion
//#region src/browser/routes/agent.shared.ts
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
	return (typeof body.targetId === "string" ? body.targetId.trim() : "") || void 0;
}
function resolveTargetIdFromQuery(query) {
	return (typeof query.targetId === "string" ? query.targetId.trim() : "") || void 0;
}
function handleRouteError(ctx, res, err) {
	const mapped = ctx.mapTabError(err);
	if (mapped) return jsonError(res, mapped.status, mapped.message);
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
		"Install the full Playwright package (not playwright-core) and restart the gateway, or reinstall with browser support.",
		"Docs: /tools/browser#playwright-requirement"
	].join("\n"));
	return null;
}
async function withRouteTabContext(params) {
	const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
	if (!profileCtx) return;
	try {
		const tab = await profileCtx.ensureTabAvailable(params.targetId);
		return await params.run({
			profileCtx,
			tab,
			cdpUrl: profileCtx.profile.cdpUrl
		});
	} catch (err) {
		handleRouteError(params.ctx, params.res, err);
		return;
	}
}
async function withPlaywrightRouteContext(params) {
	return await withRouteTabContext({
		req: params.req,
		res: params.res,
		ctx: params.ctx,
		targetId: params.targetId,
		run: async ({ profileCtx, tab, cdpUrl }) => {
			const pw = await requirePwAi(params.res, params.feature);
			if (!pw) return;
			return await params.run({
				profileCtx,
				tab,
				cdpUrl,
				pw
			});
		}
	});
}

//#endregion
//#region src/browser/routes/output-paths.ts
async function ensureOutputRootDir(rootDir) {
	await fs$1.mkdir(rootDir, { recursive: true });
}
async function resolveWritableOutputPathOrRespond(params) {
	if (params.ensureRootDir) await ensureOutputRootDir(params.rootDir);
	const pathResult = await resolveWritablePathWithinRoot({
		rootDir: params.rootDir,
		requestedPath: params.requestedPath,
		scopeLabel: params.scopeLabel,
		defaultFileName: params.defaultFileName
	});
	if (!pathResult.ok) {
		params.res.status(400).json({ error: pathResult.error });
		return null;
	}
	return pathResult.path;
}

//#endregion
//#region src/browser/routes/agent.act.download.ts
function buildDownloadRequestBase(cdpUrl, targetId, timeoutMs) {
	return {
		cdpUrl,
		targetId,
		timeoutMs: timeoutMs ?? void 0
	};
}
function registerBrowserAgentActDownloadRoutes(app, ctx) {
	app.post("/wait/download", async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const out = toStringOrEmpty(body.path) || "";
		const timeoutMs = toNumber(body.timeoutMs);
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "wait for download",
			run: async ({ cdpUrl, tab, pw }) => {
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
					path: downloadPath
				});
				res.json({
					ok: true,
					targetId: tab.targetId,
					download: result
				});
			}
		});
	});
	app.post("/download", async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const ref = toStringOrEmpty(body.ref);
		const out = toStringOrEmpty(body.path);
		const timeoutMs = toNumber(body.timeoutMs);
		if (!ref) return jsonError(res, 400, "ref is required");
		if (!out) return jsonError(res, 400, "path is required");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "download",
			run: async ({ cdpUrl, tab, pw }) => {
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
					path: downloadPath
				});
				res.json({
					ok: true,
					targetId: tab.targetId,
					download: result
				});
			}
		});
	});
}

//#endregion
//#region src/browser/routes/agent.act.hooks.ts
function registerBrowserAgentActHookRoutes(app, ctx) {
	app.post("/hooks/file-chooser", async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const ref = toStringOrEmpty(body.ref) || void 0;
		const inputRef = toStringOrEmpty(body.inputRef) || void 0;
		const element = toStringOrEmpty(body.element) || void 0;
		const paths = toStringArray(body.paths) ?? [];
		const timeoutMs = toNumber(body.timeoutMs);
		if (!paths.length) return jsonError(res, 400, "paths are required");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "file chooser hook",
			run: async ({ cdpUrl, tab, pw }) => {
				const uploadPathsResult = await resolveExistingPathsWithinRoot({
					rootDir: DEFAULT_UPLOAD_DIR,
					requestedPaths: paths,
					scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`
				});
				if (!uploadPathsResult.ok) {
					res.status(400).json({ error: uploadPathsResult.error });
					return;
				}
				const resolvedPaths = uploadPathsResult.paths;
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
						ref
					});
				}
				res.json({ ok: true });
			}
		});
	});
	app.post("/hooks/dialog", async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const accept = toBoolean(body.accept);
		const promptText = toStringOrEmpty(body.promptText) || void 0;
		const timeoutMs = toNumber(body.timeoutMs);
		if (accept === void 0) return jsonError(res, 400, "accept is required");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "dialog hook",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.armDialogViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					accept,
					promptText,
					timeoutMs: timeoutMs ?? void 0
				});
				res.json({ ok: true });
			}
		});
	});
}

//#endregion
//#region src/browser/routes/agent.act.shared.ts
const ACT_KINDS = [
	"click",
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
//#region src/browser/routes/agent.act.ts
function registerBrowserAgentActRoutes(app, ctx) {
	app.post("/act", async (req, res) => {
		const body = readBody(req);
		const kindRaw = toStringOrEmpty(body.kind);
		if (!isActKind(kindRaw)) return jsonError(res, 400, "kind is required");
		const kind = kindRaw;
		const targetId = resolveTargetIdFromBody(body);
		if (Object.hasOwn(body, "selector") && kind !== "wait") return jsonError(res, 400, SELECTOR_UNSUPPORTED_MESSAGE);
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: `act:${kind}`,
			run: async ({ cdpUrl, tab, pw }) => {
				const evaluateEnabled = ctx.state().resolved.evaluateEnabled;
				switch (kind) {
					case "click": {
						const ref = toStringOrEmpty(body.ref);
						if (!ref) return jsonError(res, 400, "ref is required");
						const doubleClick = toBoolean(body.doubleClick) ?? false;
						const timeoutMs = toNumber(body.timeoutMs);
						const buttonRaw = toStringOrEmpty(body.button) || "";
						const button = buttonRaw ? parseClickButton(buttonRaw) : void 0;
						if (buttonRaw && !button) return jsonError(res, 400, "button must be left|right|middle");
						const parsedModifiers = parseClickModifiers(toStringArray(body.modifiers) ?? []);
						if (parsedModifiers.error) return jsonError(res, 400, parsedModifiers.error);
						const modifiers = parsedModifiers.modifiers;
						const clickRequest = {
							cdpUrl,
							targetId: tab.targetId,
							ref,
							doubleClick
						};
						if (button) clickRequest.button = button;
						if (modifiers) clickRequest.modifiers = modifiers;
						if (timeoutMs) clickRequest.timeoutMs = timeoutMs;
						await pw.clickViaPlaywright(clickRequest);
						return res.json({
							ok: true,
							targetId: tab.targetId,
							url: tab.url
						});
					}
					case "type": {
						const ref = toStringOrEmpty(body.ref);
						if (!ref) return jsonError(res, 400, "ref is required");
						if (typeof body.text !== "string") return jsonError(res, 400, "text is required");
						const text = body.text;
						const submit = toBoolean(body.submit) ?? false;
						const slowly = toBoolean(body.slowly) ?? false;
						const timeoutMs = toNumber(body.timeoutMs);
						const typeRequest = {
							cdpUrl,
							targetId: tab.targetId,
							ref,
							text,
							submit,
							slowly
						};
						if (timeoutMs) typeRequest.timeoutMs = timeoutMs;
						await pw.typeViaPlaywright(typeRequest);
						return res.json({
							ok: true,
							targetId: tab.targetId
						});
					}
					case "press": {
						const key = toStringOrEmpty(body.key);
						if (!key) return jsonError(res, 400, "key is required");
						const delayMs = toNumber(body.delayMs);
						await pw.pressKeyViaPlaywright({
							cdpUrl,
							targetId: tab.targetId,
							key,
							delayMs: delayMs ?? void 0
						});
						return res.json({
							ok: true,
							targetId: tab.targetId
						});
					}
					case "hover": {
						const ref = toStringOrEmpty(body.ref);
						if (!ref) return jsonError(res, 400, "ref is required");
						const timeoutMs = toNumber(body.timeoutMs);
						await pw.hoverViaPlaywright({
							cdpUrl,
							targetId: tab.targetId,
							ref,
							timeoutMs: timeoutMs ?? void 0
						});
						return res.json({
							ok: true,
							targetId: tab.targetId
						});
					}
					case "scrollIntoView": {
						const ref = toStringOrEmpty(body.ref);
						if (!ref) return jsonError(res, 400, "ref is required");
						const timeoutMs = toNumber(body.timeoutMs);
						const scrollRequest = {
							cdpUrl,
							targetId: tab.targetId,
							ref
						};
						if (timeoutMs) scrollRequest.timeoutMs = timeoutMs;
						await pw.scrollIntoViewViaPlaywright(scrollRequest);
						return res.json({
							ok: true,
							targetId: tab.targetId
						});
					}
					case "drag": {
						const startRef = toStringOrEmpty(body.startRef);
						const endRef = toStringOrEmpty(body.endRef);
						if (!startRef || !endRef) return jsonError(res, 400, "startRef and endRef are required");
						const timeoutMs = toNumber(body.timeoutMs);
						await pw.dragViaPlaywright({
							cdpUrl,
							targetId: tab.targetId,
							startRef,
							endRef,
							timeoutMs: timeoutMs ?? void 0
						});
						return res.json({
							ok: true,
							targetId: tab.targetId
						});
					}
					case "select": {
						const ref = toStringOrEmpty(body.ref);
						const values = toStringArray(body.values);
						if (!ref || !values?.length) return jsonError(res, 400, "ref and values are required");
						const timeoutMs = toNumber(body.timeoutMs);
						await pw.selectOptionViaPlaywright({
							cdpUrl,
							targetId: tab.targetId,
							ref,
							values,
							timeoutMs: timeoutMs ?? void 0
						});
						return res.json({
							ok: true,
							targetId: tab.targetId
						});
					}
					case "fill": {
						const fields = (Array.isArray(body.fields) ? body.fields : []).map((field) => {
							if (!field || typeof field !== "object") return null;
							return normalizeBrowserFormField(field);
						}).filter((field) => field !== null);
						if (!fields.length) return jsonError(res, 400, "fields are required");
						const timeoutMs = toNumber(body.timeoutMs);
						await pw.fillFormViaPlaywright({
							cdpUrl,
							targetId: tab.targetId,
							fields,
							timeoutMs: timeoutMs ?? void 0
						});
						return res.json({
							ok: true,
							targetId: tab.targetId
						});
					}
					case "resize": {
						const width = toNumber(body.width);
						const height = toNumber(body.height);
						if (!width || !height) return jsonError(res, 400, "width and height are required");
						await pw.resizeViewportViaPlaywright({
							cdpUrl,
							targetId: tab.targetId,
							width,
							height
						});
						return res.json({
							ok: true,
							targetId: tab.targetId,
							url: tab.url
						});
					}
					case "wait": {
						const timeMs = toNumber(body.timeMs);
						const text = toStringOrEmpty(body.text) || void 0;
						const textGone = toStringOrEmpty(body.textGone) || void 0;
						const selector = toStringOrEmpty(body.selector) || void 0;
						const url = toStringOrEmpty(body.url) || void 0;
						const loadStateRaw = toStringOrEmpty(body.loadState);
						const loadState = loadStateRaw === "load" || loadStateRaw === "domcontentloaded" || loadStateRaw === "networkidle" ? loadStateRaw : void 0;
						const fn = toStringOrEmpty(body.fn) || void 0;
						const timeoutMs = toNumber(body.timeoutMs) ?? void 0;
						if (fn && !evaluateEnabled) return jsonError(res, 403, ["wait --fn is disabled by config (browser.evaluateEnabled=false).", "Docs: /gateway/configuration#browser-openclaw-managed-browser"].join("\n"));
						if (timeMs === void 0 && !text && !textGone && !selector && !url && !loadState && !fn) return jsonError(res, 400, "wait requires at least one of: timeMs, text, textGone, selector, url, loadState, fn");
						await pw.waitForViaPlaywright({
							cdpUrl,
							targetId: tab.targetId,
							timeMs,
							text,
							textGone,
							selector,
							url,
							loadState,
							fn,
							timeoutMs
						});
						return res.json({
							ok: true,
							targetId: tab.targetId
						});
					}
					case "evaluate": {
						if (!evaluateEnabled) return jsonError(res, 403, ["act:evaluate is disabled by config (browser.evaluateEnabled=false).", "Docs: /gateway/configuration#browser-openclaw-managed-browser"].join("\n"));
						const fn = toStringOrEmpty(body.fn);
						if (!fn) return jsonError(res, 400, "fn is required");
						const ref = toStringOrEmpty(body.ref) || void 0;
						const evalTimeoutMs = toNumber(body.timeoutMs);
						const evalRequest = {
							cdpUrl,
							targetId: tab.targetId,
							fn,
							ref,
							signal: req.signal
						};
						if (evalTimeoutMs !== void 0) evalRequest.timeoutMs = evalTimeoutMs;
						const result = await pw.evaluateViaPlaywright(evalRequest);
						return res.json({
							ok: true,
							targetId: tab.targetId,
							url: tab.url,
							result
						});
					}
					case "close":
						await pw.closePageViaPlaywright({
							cdpUrl,
							targetId: tab.targetId
						});
						return res.json({
							ok: true,
							targetId: tab.targetId
						});
					default: return jsonError(res, 400, "unsupported kind");
				}
			}
		});
	});
	registerBrowserAgentActHookRoutes(app, ctx);
	registerBrowserAgentActDownloadRoutes(app, ctx);
	app.post("/response/body", async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const url = toStringOrEmpty(body.url);
		const timeoutMs = toNumber(body.timeoutMs);
		const maxChars = toNumber(body.maxChars);
		if (!url) return jsonError(res, 400, "url is required");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "response body",
			run: async ({ cdpUrl, tab, pw }) => {
				const result = await pw.responseBodyViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					url,
					timeoutMs: timeoutMs ?? void 0,
					maxChars: maxChars ?? void 0
				});
				res.json({
					ok: true,
					targetId: tab.targetId,
					response: result
				});
			}
		});
	});
	app.post("/highlight", async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const ref = toStringOrEmpty(body.ref);
		if (!ref) return jsonError(res, 400, "ref is required");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "highlight",
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.highlightViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					ref
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	});
}

//#endregion
//#region src/browser/routes/agent.debug.ts
function registerBrowserAgentDebugRoutes(app, ctx) {
	app.get("/console", async (req, res) => {
		const targetId = resolveTargetIdFromQuery(req.query);
		const level = typeof req.query.level === "string" ? req.query.level : "";
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "console messages",
			run: async ({ cdpUrl, tab, pw }) => {
				const messages = await pw.getConsoleMessagesViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					level: level.trim() || void 0
				});
				res.json({
					ok: true,
					messages,
					targetId: tab.targetId
				});
			}
		});
	});
	app.get("/errors", async (req, res) => {
		const targetId = resolveTargetIdFromQuery(req.query);
		const clear = toBoolean(req.query.clear) ?? false;
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "page errors",
			run: async ({ cdpUrl, tab, pw }) => {
				const result = await pw.getPageErrorsViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					clear
				});
				res.json({
					ok: true,
					targetId: tab.targetId,
					...result
				});
			}
		});
	});
	app.get("/requests", async (req, res) => {
		const targetId = resolveTargetIdFromQuery(req.query);
		const filter = typeof req.query.filter === "string" ? req.query.filter : "";
		const clear = toBoolean(req.query.clear) ?? false;
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "network requests",
			run: async ({ cdpUrl, tab, pw }) => {
				const result = await pw.getNetworkRequestsViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					filter: filter.trim() || void 0,
					clear
				});
				res.json({
					ok: true,
					targetId: tab.targetId,
					...result
				});
			}
		});
	});
	app.post("/trace/start", async (req, res) => {
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
			run: async ({ cdpUrl, tab, pw }) => {
				await pw.traceStartViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					screenshots,
					snapshots,
					sources
				});
				res.json({
					ok: true,
					targetId: tab.targetId
				});
			}
		});
	});
	app.post("/trace/stop", async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const out = toStringOrEmpty(body.path) || "";
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "trace stop",
			run: async ({ cdpUrl, tab, pw }) => {
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
				res.json({
					ok: true,
					targetId: tab.targetId,
					path: path.resolve(tracePath)
				});
			}
		});
	});
}

//#endregion
//#region src/browser/screenshot.ts
const DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE = 2e3;
const DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
async function normalizeBrowserScreenshot(buffer, opts) {
	const maxSide = Math.max(1, Math.round(opts?.maxSide ?? DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE));
	const maxBytes = Math.max(1, Math.round(opts?.maxBytes ?? DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES));
	const meta = await getImageMetadata(buffer);
	const width = Number(meta?.width ?? 0);
	const height = Number(meta?.height ?? 0);
	const maxDim = Math.max(width, height);
	if (buffer.byteLength <= maxBytes && (maxDim === 0 || width <= maxSide && height <= maxSide)) return { buffer };
	const sideGrid = buildImageResizeSideGrid(maxSide, maxDim > 0 ? Math.min(maxSide, maxDim) : maxSide);
	let smallest = null;
	for (const side of sideGrid) for (const quality of IMAGE_REDUCE_QUALITY_STEPS) {
		const out = await resizeToJpeg({
			buffer,
			maxSide: side,
			quality,
			withoutEnlargement: true
		});
		if (!smallest || out.byteLength < smallest.size) smallest = {
			buffer: out,
			size: out.byteLength
		};
		if (out.byteLength <= maxBytes) return {
			buffer: out,
			contentType: "image/jpeg"
		};
	}
	const best = smallest?.buffer ?? buffer;
	throw new Error(`Browser screenshot could not be reduced below ${(maxBytes / (1024 * 1024)).toFixed(0)}MB (got ${(best.byteLength / (1024 * 1024)).toFixed(2)}MB)`);
}

//#endregion
//#region src/browser/routes/agent.snapshot.ts
async function saveBrowserMediaResponse(params) {
	await ensureMediaDir();
	const saved = await saveMediaBuffer(params.buffer, params.contentType, "browser", params.maxBytes);
	params.res.json({
		ok: true,
		path: path.resolve(saved.path),
		targetId: params.targetId,
		url: params.url
	});
}
/** Resolve the correct targetId after a navigation that may trigger a renderer swap. */
async function resolveTargetIdAfterNavigate(opts) {
	let currentTargetId = opts.oldTargetId;
	try {
		const refreshed = await opts.listTabs();
		if (!refreshed.some((t) => t.targetId === opts.oldTargetId)) {
			const byUrl = refreshed.filter((t) => t.url === opts.navigatedUrl);
			const replaced = byUrl.find((t) => t.targetId !== opts.oldTargetId) ?? byUrl[0];
			if (replaced) currentTargetId = replaced.targetId;
			else {
				await new Promise((r) => setTimeout(r, 800));
				const retried = await opts.listTabs();
				const match = retried.find((t) => t.url === opts.navigatedUrl && t.targetId !== opts.oldTargetId) ?? retried.find((t) => t.url === opts.navigatedUrl) ?? (retried.length === 1 ? retried[0] : null);
				if (match) currentTargetId = match.targetId;
			}
		}
	} catch {}
	return currentTargetId;
}
function registerBrowserAgentSnapshotRoutes(app, ctx) {
	app.post("/navigate", async (req, res) => {
		const body = readBody(req);
		const url = toStringOrEmpty(body.url);
		const targetId = toStringOrEmpty(body.targetId) || void 0;
		if (!url) return jsonError(res, 400, "url is required");
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId,
			feature: "navigate",
			run: async ({ cdpUrl, tab, pw, profileCtx }) => {
				const result = await pw.navigateViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					url,
					...withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy)
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
	});
	app.post("/pdf", async (req, res) => {
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId: toStringOrEmpty(readBody(req).targetId) || void 0,
			feature: "pdf",
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
	});
	app.post("/screenshot", async (req, res) => {
		const body = readBody(req);
		const targetId = toStringOrEmpty(body.targetId) || void 0;
		const fullPage = toBoolean(body.fullPage) ?? false;
		const ref = toStringOrEmpty(body.ref) || void 0;
		const element = toStringOrEmpty(body.element) || void 0;
		const type = body.type === "jpeg" ? "jpeg" : "png";
		if (fullPage && (ref || element)) return jsonError(res, 400, "fullPage is not supported for element screenshots");
		await withRouteTabContext({
			req,
			res,
			ctx,
			targetId,
			run: async ({ profileCtx, tab, cdpUrl }) => {
				let buffer;
				if (profileCtx.profile.driver === "extension" || !tab.wsUrl || Boolean(ref) || Boolean(element)) {
					const pw = await requirePwAi(res, "screenshot");
					if (!pw) return;
					buffer = (await pw.takeScreenshotViaPlaywright({
						cdpUrl,
						targetId: tab.targetId,
						ref,
						element,
						fullPage,
						type
					})).buffer;
				} else buffer = await captureScreenshot({
					wsUrl: tab.wsUrl ?? "",
					fullPage,
					format: type,
					quality: type === "jpeg" ? 85 : void 0
				});
				const normalized = await normalizeBrowserScreenshot(buffer, {
					maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
					maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES
				});
				await saveBrowserMediaResponse({
					res,
					buffer: normalized.buffer,
					contentType: normalized.contentType ?? `image/${type}`,
					maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
					targetId: tab.targetId,
					url: tab.url
				});
			}
		});
	});
	app.get("/snapshot", async (req, res) => {
		const profileCtx = resolveProfileContext(req, res, ctx);
		if (!profileCtx) return;
		const targetId = typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
		const mode = req.query.mode === "efficient" ? "efficient" : void 0;
		const labels = toBoolean(req.query.labels) ?? void 0;
		const format = (req.query.format === "aria" ? "aria" : req.query.format === "ai" ? "ai" : void 0) ?? (mode ? "ai" : await getPwAiModule() ? "ai" : "aria");
		const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : void 0;
		const hasMaxChars = Object.hasOwn(req.query, "maxChars");
		const maxCharsRaw = typeof req.query.maxChars === "string" ? Number(req.query.maxChars) : void 0;
		const limit = Number.isFinite(limitRaw) ? limitRaw : void 0;
		const resolvedMaxChars = format === "ai" ? hasMaxChars ? typeof maxCharsRaw === "number" && Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? Math.floor(maxCharsRaw) : void 0 : mode === "efficient" ? DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS : DEFAULT_AI_SNAPSHOT_MAX_CHARS : void 0;
		const interactiveRaw = toBoolean(req.query.interactive);
		const compactRaw = toBoolean(req.query.compact);
		const depthRaw = toNumber(req.query.depth);
		const refsModeRaw = toStringOrEmpty(req.query.refs).trim();
		const refsMode = refsModeRaw === "aria" ? "aria" : refsModeRaw === "role" ? "role" : void 0;
		const interactive = interactiveRaw ?? (mode === "efficient" ? true : void 0);
		const compact = compactRaw ?? (mode === "efficient" ? true : void 0);
		const depth = depthRaw ?? (mode === "efficient" ? DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH : void 0);
		const selector = toStringOrEmpty(req.query.selector);
		const frameSelector = toStringOrEmpty(req.query.frame);
		const selectorValue = selector.trim() || void 0;
		const frameSelectorValue = frameSelector.trim() || void 0;
		try {
			const tab = await profileCtx.ensureTabAvailable(targetId || void 0);
			if ((labels || mode === "efficient") && format === "aria") return jsonError(res, 400, "labels/mode=efficient require format=ai");
			if (format === "ai") {
				const pw = await requirePwAi(res, "ai snapshot");
				if (!pw) return;
				const wantsRoleSnapshot = labels === true || mode === "efficient" || interactive === true || compact === true || depth !== void 0 || Boolean(selectorValue) || Boolean(frameSelectorValue);
				const roleSnapshotArgs = {
					cdpUrl: profileCtx.profile.cdpUrl,
					targetId: tab.targetId,
					selector: selectorValue,
					frameSelector: frameSelectorValue,
					refsMode,
					options: {
						interactive: interactive ?? void 0,
						compact: compact ?? void 0,
						maxDepth: depth ?? void 0
					}
				};
				const snap = wantsRoleSnapshot ? await pw.snapshotRoleViaPlaywright(roleSnapshotArgs) : await pw.snapshotAiViaPlaywright({
					cdpUrl: profileCtx.profile.cdpUrl,
					targetId: tab.targetId,
					...typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}
				}).catch(async (err) => {
					if (String(err).toLowerCase().includes("_snapshotforai")) return await pw.snapshotRoleViaPlaywright(roleSnapshotArgs);
					throw err;
				});
				if (labels) {
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
						format,
						targetId: tab.targetId,
						url: tab.url,
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
					format,
					targetId: tab.targetId,
					url: tab.url,
					...snap
				});
			}
			const snap = profileCtx.profile.driver === "extension" || !tab.wsUrl ? requirePwAi(res, "aria snapshot").then(async (pw) => {
				if (!pw) return null;
				return await pw.snapshotAriaViaPlaywright({
					cdpUrl: profileCtx.profile.cdpUrl,
					targetId: tab.targetId,
					limit
				});
			}) : snapshotAria({
				wsUrl: tab.wsUrl ?? "",
				limit
			});
			const resolved = await Promise.resolve(snap);
			if (!resolved) return;
			return res.json({
				ok: true,
				format,
				targetId: tab.targetId,
				url: tab.url,
				...resolved
			});
		} catch (err) {
			handleRouteError(ctx, res, err);
		}
	});
}

//#endregion
//#region src/browser/routes/agent.storage.ts
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
	app.get("/cookies", async (req, res) => {
		await withPlaywrightRouteContext({
			req,
			res,
			ctx,
			targetId: resolveTargetIdFromQuery(req.query),
			feature: "cookies",
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
	});
	app.post("/cookies/set", async (req, res) => {
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
	});
	app.post("/cookies/clear", async (req, res) => {
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
	});
	app.get("/storage/:kind", async (req, res) => {
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
			run: async ({ cdpUrl, tab, pw }) => {
				const result = await pw.storageGetViaPlaywright({
					cdpUrl,
					targetId: tab.targetId,
					kind,
					key: key.trim() || void 0
				});
				res.json({
					ok: true,
					targetId: tab.targetId,
					...result
				});
			}
		});
	});
	app.post("/storage/:kind/set", async (req, res) => {
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
	});
	app.post("/storage/:kind/clear", async (req, res) => {
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
	});
	app.post("/set/offline", async (req, res) => {
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
	});
	app.post("/set/headers", async (req, res) => {
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
	});
	app.post("/set/credentials", async (req, res) => {
		const body = readBody(req);
		const targetId = resolveTargetIdFromBody(body);
		const clear = toBoolean(body.clear) ?? false;
		const username = toStringOrEmpty(body.username) || void 0;
		const password = typeof body.password === "string" ? body.password : void 0;
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
	});
	app.post("/set/geolocation", async (req, res) => {
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
	});
	app.post("/set/media", async (req, res) => {
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
	});
	app.post("/set/timezone", async (req, res) => {
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
	});
	app.post("/set/locale", async (req, res) => {
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
	});
	app.post("/set/device", async (req, res) => {
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
	});
}

//#endregion
//#region src/browser/routes/agent.ts
function registerBrowserAgentRoutes(app, ctx) {
	registerBrowserAgentSnapshotRoutes(app, ctx);
	registerBrowserAgentActRoutes(app, ctx);
	registerBrowserAgentDebugRoutes(app, ctx);
	registerBrowserAgentStorageRoutes(app, ctx);
}

//#endregion
//#region src/config/port-defaults.ts
function isValidPort(port) {
	return Number.isFinite(port) && port > 0 && port <= 65535;
}
function clampPort(port, fallback) {
	return isValidPort(port) ? port : fallback;
}
function derivePort(base, offset, fallback) {
	return clampPort(base + offset, fallback);
}
const DEFAULT_BROWSER_CONTROL_PORT = 18791;
const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;
const DEFAULT_BROWSER_CDP_PORT_RANGE_END = 18899;
function deriveDefaultBrowserControlPort(gatewayPort) {
	return derivePort(gatewayPort, 2, DEFAULT_BROWSER_CONTROL_PORT);
}
function deriveDefaultBrowserCdpPortRange(browserControlPort) {
	const start = derivePort(browserControlPort, 9, DEFAULT_BROWSER_CDP_PORT_RANGE_START);
	const end = clampPort(start + (DEFAULT_BROWSER_CDP_PORT_RANGE_END - DEFAULT_BROWSER_CDP_PORT_RANGE_START), DEFAULT_BROWSER_CDP_PORT_RANGE_END);
	if (end < start) return {
		start,
		end: start
	};
	return {
		start,
		end
	};
}

//#endregion
//#region src/browser/profiles.ts
/**
* CDP port allocation for browser profiles.
*
* Default port range: 18800-18899 (100 profiles max)
* Ports are allocated once at profile creation and persisted in config.
* Multi-instance: callers may pass an explicit range to avoid collisions.
*
* Reserved ports (do not use for CDP):
*   18789 - Gateway WebSocket
*   18790 - Bridge
*   18791 - Browser control server
*   18792-18799 - Reserved for future one-off services (canvas at 18793)
*/
const CDP_PORT_RANGE_START = 18800;
const CDP_PORT_RANGE_END = 18899;
const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;
function isValidProfileName(name) {
	if (!name || name.length > 64) return false;
	return PROFILE_NAME_REGEX.test(name);
}
function allocateCdpPort(usedPorts, range) {
	const start = range?.start ?? CDP_PORT_RANGE_START;
	const end = range?.end ?? CDP_PORT_RANGE_END;
	if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) return null;
	if (start > end) return null;
	for (let port = start; port <= end; port++) if (!usedPorts.has(port)) return port;
	return null;
}
function getUsedPorts(profiles) {
	if (!profiles) return /* @__PURE__ */ new Set();
	const used = /* @__PURE__ */ new Set();
	for (const profile of Object.values(profiles)) {
		if (typeof profile.cdpPort === "number") {
			used.add(profile.cdpPort);
			continue;
		}
		const rawUrl = profile.cdpUrl?.trim();
		if (!rawUrl) continue;
		try {
			const parsed = new URL(rawUrl);
			const port = parsed.port && Number.parseInt(parsed.port, 10) > 0 ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
			if (!Number.isNaN(port) && port > 0 && port <= 65535) used.add(port);
		} catch {}
	}
	return used;
}
const PROFILE_COLORS = [
	"#FF4500",
	"#0066CC",
	"#00AA00",
	"#9933FF",
	"#FF6699",
	"#00CCCC",
	"#FF9900",
	"#6666FF",
	"#CC3366",
	"#339966"
];
function allocateColor(usedColors) {
	for (const color of PROFILE_COLORS) if (!usedColors.has(color.toUpperCase())) return color;
	return PROFILE_COLORS[usedColors.size % PROFILE_COLORS.length] ?? PROFILE_COLORS[0];
}
function getUsedColors(profiles) {
	if (!profiles) return /* @__PURE__ */ new Set();
	return new Set(Object.values(profiles).map((p) => p.color.toUpperCase()));
}

//#endregion
//#region src/browser/config.ts
function normalizeHexColor(raw) {
	const value = (raw ?? "").trim();
	if (!value) return DEFAULT_OPENCLAW_BROWSER_COLOR;
	const normalized = value.startsWith("#") ? value : `#${value}`;
	if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return DEFAULT_OPENCLAW_BROWSER_COLOR;
	return normalized.toUpperCase();
}
function normalizeTimeoutMs(raw, fallback) {
	const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
	return value < 0 ? fallback : value;
}
function normalizeStringList(raw) {
	if (!Array.isArray(raw) || raw.length === 0) return;
	const values = raw.map((value) => value.trim()).filter((value) => value.length > 0);
	return values.length > 0 ? values : void 0;
}
function resolveBrowserSsrFPolicy(cfg) {
	const allowPrivateNetwork = cfg?.ssrfPolicy?.allowPrivateNetwork;
	const dangerouslyAllowPrivateNetwork = cfg?.ssrfPolicy?.dangerouslyAllowPrivateNetwork;
	const allowedHostnames = normalizeStringList(cfg?.ssrfPolicy?.allowedHostnames);
	const hostnameAllowlist = normalizeStringList(cfg?.ssrfPolicy?.hostnameAllowlist);
	const hasExplicitPrivateSetting = allowPrivateNetwork !== void 0 || dangerouslyAllowPrivateNetwork !== void 0;
	const resolvedAllowPrivateNetwork = dangerouslyAllowPrivateNetwork === true || allowPrivateNetwork === true || !hasExplicitPrivateSetting;
	if (!resolvedAllowPrivateNetwork && !hasExplicitPrivateSetting && !allowedHostnames && !hostnameAllowlist) return;
	return {
		...resolvedAllowPrivateNetwork ? { dangerouslyAllowPrivateNetwork: true } : {},
		...allowedHostnames ? { allowedHostnames } : {},
		...hostnameAllowlist ? { hostnameAllowlist } : {}
	};
}
function parseHttpUrl(raw, label) {
	const trimmed = raw.trim();
	const parsed = new URL(trimmed);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${label} must be http(s), got: ${parsed.protocol.replace(":", "")}`);
	const port = parsed.port && Number.parseInt(parsed.port, 10) > 0 ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
	if (Number.isNaN(port) || port <= 0 || port > 65535) throw new Error(`${label} has invalid port: ${parsed.port}`);
	return {
		parsed,
		port,
		normalized: parsed.toString().replace(/\/$/, "")
	};
}
/**
* Ensure the default "openclaw" profile exists in the profiles map.
* Auto-creates it with the legacy CDP port (from browser.cdpUrl) or first port if missing.
*/
function ensureDefaultProfile(profiles, defaultColor, legacyCdpPort, derivedDefaultCdpPort) {
	const result = { ...profiles };
	if (!result[DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]) result[DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME] = {
		cdpPort: legacyCdpPort ?? derivedDefaultCdpPort ?? CDP_PORT_RANGE_START,
		color: defaultColor
	};
	return result;
}
/**
* Ensure a built-in "chrome" profile exists for the Chrome extension relay.
*
* Note: this is an OpenClaw browser profile (routing config), not a Chrome user profile.
* It points at the local relay CDP endpoint (controlPort + 1).
*/
function ensureDefaultChromeExtensionProfile(profiles, controlPort) {
	const result = { ...profiles };
	if (result.chrome) return result;
	const relayPort = controlPort + 1;
	if (!Number.isFinite(relayPort) || relayPort <= 0 || relayPort > 65535) return result;
	if (getUsedPorts(result).has(relayPort)) return result;
	result.chrome = {
		driver: "extension",
		cdpUrl: `http://127.0.0.1:${relayPort}`,
		color: "#00AA00"
	};
	return result;
}
function resolveBrowserConfig(cfg, rootConfig) {
	const enabled = cfg?.enabled ?? DEFAULT_OPENCLAW_BROWSER_ENABLED;
	const evaluateEnabled = cfg?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;
	const controlPort = deriveDefaultBrowserControlPort(resolveGatewayPort(rootConfig) ?? DEFAULT_BROWSER_CONTROL_PORT);
	const defaultColor = normalizeHexColor(cfg?.color);
	const remoteCdpTimeoutMs = normalizeTimeoutMs(cfg?.remoteCdpTimeoutMs, 1500);
	const remoteCdpHandshakeTimeoutMs = normalizeTimeoutMs(cfg?.remoteCdpHandshakeTimeoutMs, Math.max(2e3, remoteCdpTimeoutMs * 2));
	const derivedCdpRange = deriveDefaultBrowserCdpPortRange(controlPort);
	const rawCdpUrl = (cfg?.cdpUrl ?? "").trim();
	let cdpInfo;
	if (rawCdpUrl) cdpInfo = parseHttpUrl(rawCdpUrl, "browser.cdpUrl");
	else {
		const derivedPort = controlPort + 1;
		if (derivedPort > 65535) throw new Error(`Derived CDP port (${derivedPort}) is too high; check gateway port configuration.`);
		const derived = new URL(`http://127.0.0.1:${derivedPort}`);
		cdpInfo = {
			parsed: derived,
			port: derivedPort,
			normalized: derived.toString().replace(/\/$/, "")
		};
	}
	const headless = cfg?.headless === true;
	const noSandbox = cfg?.noSandbox === true;
	const attachOnly = cfg?.attachOnly === true;
	const executablePath = cfg?.executablePath?.trim() || void 0;
	const defaultProfileFromConfig = cfg?.defaultProfile?.trim() || void 0;
	const legacyCdpPort = rawCdpUrl ? cdpInfo.port : void 0;
	const profiles = ensureDefaultChromeExtensionProfile(ensureDefaultProfile(cfg?.profiles, defaultColor, legacyCdpPort, derivedCdpRange.start), controlPort);
	const cdpProtocol = cdpInfo.parsed.protocol === "https:" ? "https" : "http";
	const defaultProfile = defaultProfileFromConfig ?? (profiles[DEFAULT_BROWSER_DEFAULT_PROFILE_NAME] ? DEFAULT_BROWSER_DEFAULT_PROFILE_NAME : DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME);
	const extraArgs = Array.isArray(cfg?.extraArgs) ? cfg.extraArgs.filter((a) => typeof a === "string" && a.trim().length > 0) : [];
	const ssrfPolicy = resolveBrowserSsrFPolicy(cfg);
	return {
		enabled,
		evaluateEnabled,
		controlPort,
		cdpProtocol,
		cdpHost: cdpInfo.parsed.hostname,
		cdpIsLoopback: isLoopbackHost(cdpInfo.parsed.hostname),
		remoteCdpTimeoutMs,
		remoteCdpHandshakeTimeoutMs,
		color: defaultColor,
		executablePath,
		headless,
		noSandbox,
		attachOnly,
		defaultProfile,
		profiles,
		ssrfPolicy,
		extraArgs
	};
}
/**
* Resolve a profile by name from the config.
* Returns null if the profile doesn't exist.
*/
function resolveProfile(resolved, profileName) {
	const profile = resolved.profiles[profileName];
	if (!profile) return null;
	const rawProfileUrl = profile.cdpUrl?.trim() ?? "";
	let cdpHost = resolved.cdpHost;
	let cdpPort = profile.cdpPort ?? 0;
	let cdpUrl = "";
	const driver = profile.driver === "extension" ? "extension" : "openclaw";
	if (rawProfileUrl) {
		const parsed = parseHttpUrl(rawProfileUrl, `browser.profiles.${profileName}.cdpUrl`);
		cdpHost = parsed.parsed.hostname;
		cdpPort = parsed.port;
		cdpUrl = parsed.normalized;
	} else if (cdpPort) cdpUrl = `${resolved.cdpProtocol}://${resolved.cdpHost}:${cdpPort}`;
	else throw new Error(`Profile "${profileName}" must define cdpPort or cdpUrl.`);
	return {
		name: profileName,
		cdpPort,
		cdpUrl,
		cdpHost,
		cdpIsLoopback: isLoopbackHost(cdpHost),
		color: profile.color,
		driver
	};
}

//#endregion
//#region src/browser/profiles-service.ts
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
function createBrowserProfilesService(ctx) {
	const listProfiles = async () => {
		return await ctx.listProfiles();
	};
	const createProfile = async (params) => {
		const name = params.name.trim();
		const rawCdpUrl = params.cdpUrl?.trim() || void 0;
		const driver = params.driver === "extension" ? "extension" : void 0;
		if (!isValidProfileName(name)) throw new Error("invalid profile name: use lowercase letters, numbers, and hyphens only");
		const state = ctx.state();
		const resolvedProfiles = state.resolved.profiles;
		if (name in resolvedProfiles) throw new Error(`profile "${name}" already exists`);
		const cfg = loadConfig();
		const rawProfiles = cfg.browser?.profiles ?? {};
		if (name in rawProfiles) throw new Error(`profile "${name}" already exists`);
		const usedColors = getUsedColors(resolvedProfiles);
		const profileColor = params.color && HEX_COLOR_RE.test(params.color) ? params.color : allocateColor(usedColors);
		let profileConfig;
		if (rawCdpUrl) profileConfig = {
			cdpUrl: parseHttpUrl(rawCdpUrl, "browser.profiles.cdpUrl").normalized,
			...driver ? { driver } : {},
			color: profileColor
		};
		else {
			const cdpPort = allocateCdpPort(getUsedPorts(resolvedProfiles), deriveDefaultBrowserCdpPortRange(state.resolved.controlPort));
			if (cdpPort === null) throw new Error("no available CDP ports in range");
			profileConfig = {
				cdpPort,
				...driver ? { driver } : {},
				color: profileColor
			};
		}
		await writeConfigFile({
			...cfg,
			browser: {
				...cfg.browser,
				profiles: {
					...rawProfiles,
					[name]: profileConfig
				}
			}
		});
		state.resolved.profiles[name] = profileConfig;
		const resolved = resolveProfile(state.resolved, name);
		if (!resolved) throw new Error(`profile "${name}" not found after creation`);
		return {
			ok: true,
			profile: name,
			cdpPort: resolved.cdpPort,
			cdpUrl: resolved.cdpUrl,
			color: resolved.color,
			isRemote: !resolved.cdpIsLoopback
		};
	};
	const deleteProfile = async (nameRaw) => {
		const name = nameRaw.trim();
		if (!name) throw new Error("profile name is required");
		if (!isValidProfileName(name)) throw new Error("invalid profile name");
		const cfg = loadConfig();
		const profiles = cfg.browser?.profiles ?? {};
		if (!(name in profiles)) throw new Error(`profile "${name}" not found`);
		if (name === (cfg.browser?.defaultProfile ?? DEFAULT_BROWSER_DEFAULT_PROFILE_NAME)) throw new Error(`cannot delete the default profile "${name}"; change browser.defaultProfile first`);
		let deleted = false;
		const state = ctx.state();
		if (resolveProfile(state.resolved, name)?.cdpIsLoopback) {
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
		const { [name]: _removed, ...remainingProfiles } = profiles;
		await writeConfigFile({
			...cfg,
			browser: {
				...cfg.browser,
				profiles: remainingProfiles
			}
		});
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
//#region src/browser/routes/basic.ts
async function withBasicProfileRoute(params) {
	const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
	if (!profileCtx) return;
	try {
		await params.run(profileCtx);
	} catch (err) {
		jsonError(params.res, 500, String(err));
	}
}
function registerBrowserBasicRoutes(app, ctx) {
	app.get("/profiles", async (_req, res) => {
		try {
			const profiles = await createBrowserProfilesService(ctx).listProfiles();
			res.json({ profiles });
		} catch (err) {
			jsonError(res, 500, String(err));
		}
	});
	app.get("/", async (req, res) => {
		let current;
		try {
			current = ctx.state();
		} catch {
			return jsonError(res, 503, "browser server not started");
		}
		const profileCtx = getProfileContext(req, ctx);
		if ("error" in profileCtx) return jsonError(res, profileCtx.status, profileCtx.error);
		const [cdpHttp, cdpReady] = await Promise.all([profileCtx.isHttpReachable(300), profileCtx.isReachable(600)]);
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
		res.json({
			enabled: current.resolved.enabled,
			profile: profileCtx.profile.name,
			running: cdpReady,
			cdpReady,
			cdpHttp,
			pid: profileState?.running?.pid ?? null,
			cdpPort: profileCtx.profile.cdpPort,
			cdpUrl: profileCtx.profile.cdpUrl,
			chosenBrowser: profileState?.running?.exe.kind ?? null,
			detectedBrowser,
			detectedExecutablePath,
			detectError,
			userDataDir: profileState?.running?.userDataDir ?? null,
			color: profileCtx.profile.color,
			headless: current.resolved.headless,
			noSandbox: current.resolved.noSandbox,
			executablePath: current.resolved.executablePath ?? null,
			attachOnly: current.resolved.attachOnly
		});
	});
	app.post("/start", async (req, res) => {
		await withBasicProfileRoute({
			req,
			res,
			ctx,
			run: async (profileCtx) => {
				await profileCtx.ensureBrowserAvailable();
				res.json({
					ok: true,
					profile: profileCtx.profile.name
				});
			}
		});
	});
	app.post("/stop", async (req, res) => {
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
	});
	app.post("/reset-profile", async (req, res) => {
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
	});
	app.post("/profiles/create", async (req, res) => {
		const name = toStringOrEmpty(req.body?.name);
		const color = toStringOrEmpty(req.body?.color);
		const cdpUrl = toStringOrEmpty(req.body?.cdpUrl);
		const driver = toStringOrEmpty(req.body?.driver);
		if (!name) return jsonError(res, 400, "name is required");
		try {
			const result = await createBrowserProfilesService(ctx).createProfile({
				name,
				color: color || void 0,
				cdpUrl: cdpUrl || void 0,
				driver: driver === "extension" ? "extension" : void 0
			});
			res.json(result);
		} catch (err) {
			const msg = String(err);
			if (msg.includes("already exists")) return jsonError(res, 409, msg);
			if (msg.includes("invalid profile name")) return jsonError(res, 400, msg);
			if (msg.includes("no available CDP ports")) return jsonError(res, 507, msg);
			if (msg.includes("cdpUrl")) return jsonError(res, 400, msg);
			jsonError(res, 500, msg);
		}
	});
	app.delete("/profiles/:name", async (req, res) => {
		const name = toStringOrEmpty(req.params.name);
		if (!name) return jsonError(res, 400, "profile name is required");
		try {
			const result = await createBrowserProfilesService(ctx).deleteProfile(name);
			res.json(result);
		} catch (err) {
			const msg = String(err);
			if (msg.includes("invalid profile name")) return jsonError(res, 400, msg);
			if (msg.includes("default profile")) return jsonError(res, 400, msg);
			if (msg.includes("not found")) return jsonError(res, 404, msg);
			jsonError(res, 500, msg);
		}
	});
}

//#endregion
//#region src/browser/routes/tabs.ts
function resolveTabsProfileContext(req, res, ctx) {
	const profileCtx = getProfileContext(req, ctx);
	if ("error" in profileCtx) {
		jsonError(res, profileCtx.status, profileCtx.error);
		return null;
	}
	return profileCtx;
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
		jsonError(res, 409, "browser not running");
		return false;
	}
	return true;
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
	app.get("/tabs", async (req, res) => {
		await withTabsProfileRoute({
			req,
			res,
			ctx,
			run: async (profileCtx) => {
				if (!await profileCtx.isReachable(300)) return res.json({
					running: false,
					tabs: []
				});
				const tabs = await profileCtx.listTabs();
				res.json({
					running: true,
					tabs
				});
			}
		});
	});
	app.post("/tabs/open", async (req, res) => {
		const url = toStringOrEmpty(req.body?.url);
		if (!url) return jsonError(res, 400, "url is required");
		await withTabsProfileRoute({
			req,
			res,
			ctx,
			mapTabError: true,
			run: async (profileCtx) => {
				await profileCtx.ensureBrowserAvailable();
				const tab = await profileCtx.openTab(url);
				res.json(tab);
			}
		});
	});
	app.post("/tabs/focus", async (req, res) => {
		const targetId = parseRequiredTargetId(res, req.body?.targetId);
		if (!targetId) return;
		await runTabTargetMutation({
			req,
			res,
			ctx,
			targetId,
			mutate: async (profileCtx, id) => {
				await profileCtx.focusTab(id);
			}
		});
	});
	app.delete("/tabs/:targetId", async (req, res) => {
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
	});
	app.post("/tabs/action", async (req, res) => {
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
					const tabs = await profileCtx.listTabs();
					return res.json({
						ok: true,
						tabs
					});
				}
				if (action === "new") {
					await profileCtx.ensureBrowserAvailable();
					const tab = await profileCtx.openTab("about:blank");
					return res.json({
						ok: true,
						tab
					});
				}
				if (action === "close") {
					const target = resolveIndexedTab(await profileCtx.listTabs(), index);
					if (!target) return jsonError(res, 404, "tab not found");
					await profileCtx.closeTab(target.targetId);
					return res.json({
						ok: true,
						targetId: target.targetId
					});
				}
				if (action === "select") {
					if (typeof index !== "number") return jsonError(res, 400, "index is required");
					const target = (await profileCtx.listTabs())[index];
					if (!target) return jsonError(res, 404, "tab not found");
					await profileCtx.focusTab(target.targetId);
					return res.json({
						ok: true,
						targetId: target.targetId
					});
				}
				return jsonError(res, 400, "unknown tab action");
			}
		});
	});
}

//#endregion
//#region src/browser/routes/index.ts
function registerBrowserRoutes(app, ctx) {
	registerBrowserBasicRoutes(app, ctx);
	registerBrowserTabRoutes(app, ctx);
	registerBrowserAgentRoutes(app, ctx);
}

//#endregion
//#region src/browser/resolved-config-refresh.ts
function applyResolvedConfig(current, freshResolved) {
	current.resolved = freshResolved;
	for (const [name, runtime] of current.profiles) {
		const nextProfile = resolveProfile(freshResolved, name);
		if (nextProfile) {
			runtime.profile = nextProfile;
			continue;
		}
		if (!runtime.running) current.profiles.delete(name);
	}
}
function refreshResolvedBrowserConfigFromDisk(params) {
	if (!params.refreshConfigFromDisk) return;
	const cfg = params.mode === "fresh" ? createConfigIO().loadConfig() : loadConfig();
	const freshResolved = resolveBrowserConfig(cfg.browser, cfg);
	applyResolvedConfig(params.current, freshResolved);
}
function resolveBrowserProfileWithHotReload(params) {
	refreshResolvedBrowserConfigFromDisk({
		current: params.current,
		refreshConfigFromDisk: params.refreshConfigFromDisk,
		mode: "cached"
	});
	let profile = resolveProfile(params.current.resolved, params.name);
	if (profile) return profile;
	refreshResolvedBrowserConfigFromDisk({
		current: params.current,
		refreshConfigFromDisk: params.refreshConfigFromDisk,
		mode: "fresh"
	});
	profile = resolveProfile(params.current.resolved, params.name);
	return profile;
}

//#endregion
//#region src/browser/target-id.ts
function resolveTargetIdFromTabs(input, tabs) {
	const needle = input.trim();
	if (!needle) return {
		ok: false,
		reason: "not_found"
	};
	const exact = tabs.find((t) => t.targetId === needle);
	if (exact) return {
		ok: true,
		targetId: exact.targetId
	};
	const lower = needle.toLowerCase();
	const matches = tabs.map((t) => t.targetId).filter((id) => id.toLowerCase().startsWith(lower));
	const only = matches.length === 1 ? matches[0] : void 0;
	if (only) return {
		ok: true,
		targetId: only
	};
	if (matches.length === 0) return {
		ok: false,
		reason: "not_found"
	};
	return {
		ok: false,
		reason: "ambiguous",
		matches
	};
}

//#endregion
//#region src/browser/server-context.ts
function listKnownProfileNames(state) {
	const names = new Set(Object.keys(state.resolved.profiles));
	for (const name of state.profiles.keys()) names.add(name);
	return [...names];
}
/**
* Normalize a CDP WebSocket URL to use the correct base URL.
*/
function normalizeWsUrl(raw, cdpBaseUrl) {
	if (!raw) return;
	try {
		return normalizeCdpWsUrl(raw, cdpBaseUrl);
	} catch {
		return raw;
	}
}
/**
* Create a profile-scoped context for browser operations.
*/
function createProfileContext(opts, profile) {
	const state = () => {
		const current = opts.getState();
		if (!current) throw new Error("Browser server not started");
		return current;
	};
	const getProfileState = () => {
		const current = state();
		let profileState = current.profiles.get(profile.name);
		if (!profileState) {
			profileState = {
				profile,
				running: null,
				lastTargetId: null
			};
			current.profiles.set(profile.name, profileState);
		}
		return profileState;
	};
	const setProfileRunning = (running) => {
		const profileState = getProfileState();
		profileState.running = running;
	};
	const listTabs = async () => {
		if (!profile.cdpIsLoopback) {
			const listPagesViaPlaywright = (await getPwAiModule$1({ mode: "strict" }))?.listPagesViaPlaywright;
			if (typeof listPagesViaPlaywright === "function") return (await listPagesViaPlaywright({ cdpUrl: profile.cdpUrl })).map((p) => ({
				targetId: p.targetId,
				title: p.title,
				url: p.url,
				type: p.type
			}));
		}
		return (await fetchJson(appendCdpPath(profile.cdpUrl, "/json/list"))).map((t) => ({
			targetId: t.id ?? "",
			title: t.title ?? "",
			url: t.url ?? "",
			wsUrl: normalizeWsUrl(t.webSocketDebuggerUrl, profile.cdpUrl),
			type: t.type
		})).filter((t) => Boolean(t.targetId));
	};
	const openTab = async (url) => {
		const ssrfPolicyOpts = withBrowserNavigationPolicy(state().resolved.ssrfPolicy);
		if (!profile.cdpIsLoopback) {
			const createPageViaPlaywright = (await getPwAiModule$1({ mode: "strict" }))?.createPageViaPlaywright;
			if (typeof createPageViaPlaywright === "function") {
				const page = await createPageViaPlaywright({
					cdpUrl: profile.cdpUrl,
					url,
					...ssrfPolicyOpts
				});
				const profileState = getProfileState();
				profileState.lastTargetId = page.targetId;
				return {
					targetId: page.targetId,
					title: page.title,
					url: page.url,
					type: page.type
				};
			}
		}
		const createdViaCdp = await createTargetViaCdp({
			cdpUrl: profile.cdpUrl,
			url,
			...ssrfPolicyOpts
		}).then((r) => r.targetId).catch(() => null);
		if (createdViaCdp) {
			const profileState = getProfileState();
			profileState.lastTargetId = createdViaCdp;
			const deadline = Date.now() + 2e3;
			while (Date.now() < deadline) {
				const found = (await listTabs().catch(() => [])).find((t) => t.targetId === createdViaCdp);
				if (found) {
					await assertBrowserNavigationResultAllowed({
						url: found.url,
						...ssrfPolicyOpts
					});
					return found;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			return {
				targetId: createdViaCdp,
				title: "",
				url,
				type: "page"
			};
		}
		const encoded = encodeURIComponent(url);
		const endpointUrl = new URL(appendCdpPath(profile.cdpUrl, "/json/new"));
		await assertBrowserNavigationAllowed({
			url,
			...ssrfPolicyOpts
		});
		const endpoint = endpointUrl.search ? (() => {
			endpointUrl.searchParams.set("url", url);
			return endpointUrl.toString();
		})() : `${endpointUrl.toString()}?${encoded}`;
		const created = await fetchJson(endpoint, 1500, { method: "PUT" }).catch(async (err) => {
			if (String(err).includes("HTTP 405")) return await fetchJson(endpoint, 1500);
			throw err;
		});
		if (!created.id) throw new Error("Failed to open tab (missing id)");
		const profileState = getProfileState();
		profileState.lastTargetId = created.id;
		const resolvedUrl = created.url ?? url;
		await assertBrowserNavigationResultAllowed({
			url: resolvedUrl,
			...ssrfPolicyOpts
		});
		return {
			targetId: created.id,
			title: created.title ?? "",
			url: resolvedUrl,
			wsUrl: normalizeWsUrl(created.webSocketDebuggerUrl, profile.cdpUrl),
			type: created.type
		};
	};
	const resolveRemoteHttpTimeout = (timeoutMs) => {
		if (profile.cdpIsLoopback) return timeoutMs ?? 300;
		const resolved = state().resolved;
		if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) return Math.max(Math.floor(timeoutMs), resolved.remoteCdpTimeoutMs);
		return resolved.remoteCdpTimeoutMs;
	};
	const resolveRemoteWsTimeout = (timeoutMs) => {
		if (profile.cdpIsLoopback) {
			const base = timeoutMs ?? 300;
			return Math.max(200, Math.min(2e3, base * 2));
		}
		const resolved = state().resolved;
		if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) return Math.max(Math.floor(timeoutMs) * 2, resolved.remoteCdpHandshakeTimeoutMs);
		return resolved.remoteCdpHandshakeTimeoutMs;
	};
	const isReachable = async (timeoutMs) => {
		const httpTimeout = resolveRemoteHttpTimeout(timeoutMs);
		const wsTimeout = resolveRemoteWsTimeout(timeoutMs);
		return await isChromeCdpReady(profile.cdpUrl, httpTimeout, wsTimeout);
	};
	const isHttpReachable = async (timeoutMs) => {
		const httpTimeout = resolveRemoteHttpTimeout(timeoutMs);
		return await isChromeReachable(profile.cdpUrl, httpTimeout);
	};
	const attachRunning = (running) => {
		setProfileRunning(running);
		running.proc.on("exit", () => {
			if (!opts.getState()) return;
			if (getProfileState().running?.pid === running.pid) setProfileRunning(null);
		});
	};
	const ensureBrowserAvailable = async () => {
		const current = state();
		const remoteCdp = !profile.cdpIsLoopback;
		const isExtension = profile.driver === "extension";
		const profileState = getProfileState();
		const httpReachable = await isHttpReachable();
		if (isExtension && remoteCdp) throw new Error(`Profile "${profile.name}" uses driver=extension but cdpUrl is not loopback (${profile.cdpUrl}).`);
		if (isExtension) {
			if (!httpReachable) {
				await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl });
				if (await isHttpReachable(1200)) {} else throw new Error(`Chrome extension relay for profile "${profile.name}" is not reachable at ${profile.cdpUrl}.`);
			}
			if (await isReachable(600)) return;
			throw new Error(`Chrome extension relay is running, but no tab is connected. Click the OpenClaw Chrome extension icon on a tab to attach it (profile "${profile.name}").`);
		}
		if (!httpReachable) {
			if ((current.resolved.attachOnly || remoteCdp) && opts.onEnsureAttachTarget) {
				await opts.onEnsureAttachTarget(profile);
				if (await isHttpReachable(1200)) return;
			}
			if (current.resolved.attachOnly || remoteCdp) throw new Error(remoteCdp ? `Remote CDP for profile "${profile.name}" is not reachable at ${profile.cdpUrl}.` : `Browser attachOnly is enabled and profile "${profile.name}" is not running.`);
			attachRunning(await launchOpenClawChrome(current.resolved, profile));
			return;
		}
		if (await isReachable()) return;
		if (!profileState.running) throw new Error(`Port ${profile.cdpPort} is in use for profile "${profile.name}" but not by openclaw. Run action=reset-profile profile=${profile.name} to kill the process.`);
		if (current.resolved.attachOnly || remoteCdp) {
			if (opts.onEnsureAttachTarget) {
				await opts.onEnsureAttachTarget(profile);
				if (await isReachable(1200)) return;
			}
			throw new Error(remoteCdp ? `Remote CDP websocket for profile "${profile.name}" is not reachable.` : `Browser attachOnly is enabled and CDP websocket for profile "${profile.name}" is not reachable.`);
		}
		await stopOpenClawChrome(profileState.running);
		setProfileRunning(null);
		attachRunning(await launchOpenClawChrome(current.resolved, profile));
		if (!await isReachable(600)) throw new Error(`Chrome CDP websocket for profile "${profile.name}" is not reachable after restart.`);
	};
	const ensureTabAvailable = async (targetId) => {
		await ensureBrowserAvailable();
		const profileState = getProfileState();
		if ((await listTabs()).length === 0) {
			if (profile.driver === "extension") throw new Error(`tab not found (no attached Chrome tabs for profile "${profile.name}"). Click the OpenClaw Browser Relay toolbar icon on the tab you want to control (badge ON).`);
			await openTab("about:blank");
		}
		const tabs = await listTabs();
		const candidates = profile.driver === "extension" || !profile.cdpIsLoopback ? tabs : tabs.filter((t) => Boolean(t.wsUrl));
		const resolveById = (raw) => {
			const resolved = resolveTargetIdFromTabs(raw, candidates);
			if (!resolved.ok) {
				if (resolved.reason === "ambiguous") return "AMBIGUOUS";
				return null;
			}
			return candidates.find((t) => t.targetId === resolved.targetId) ?? null;
		};
		const pickDefault = () => {
			const last = profileState.lastTargetId?.trim() || "";
			const lastResolved = last ? resolveById(last) : null;
			if (lastResolved && lastResolved !== "AMBIGUOUS") return lastResolved;
			return candidates.find((t) => (t.type ?? "page") === "page") ?? candidates.at(0) ?? null;
		};
		let chosen = targetId ? resolveById(targetId) : pickDefault();
		if (!chosen && (profile.driver === "extension" || !profile.cdpIsLoopback) && candidates.length === 1) chosen = candidates[0] ?? null;
		if (chosen === "AMBIGUOUS") throw new Error("ambiguous target id prefix");
		if (!chosen) throw new Error("tab not found");
		profileState.lastTargetId = chosen.targetId;
		return chosen;
	};
	const resolveTargetIdOrThrow = async (targetId) => {
		const resolved = resolveTargetIdFromTabs(targetId, await listTabs());
		if (!resolved.ok) {
			if (resolved.reason === "ambiguous") throw new Error("ambiguous target id prefix");
			throw new Error("tab not found");
		}
		return resolved.targetId;
	};
	const focusTab = async (targetId) => {
		const resolvedTargetId = await resolveTargetIdOrThrow(targetId);
		if (!profile.cdpIsLoopback) {
			const focusPageByTargetIdViaPlaywright = (await getPwAiModule$1({ mode: "strict" }))?.focusPageByTargetIdViaPlaywright;
			if (typeof focusPageByTargetIdViaPlaywright === "function") {
				await focusPageByTargetIdViaPlaywright({
					cdpUrl: profile.cdpUrl,
					targetId: resolvedTargetId
				});
				const profileState = getProfileState();
				profileState.lastTargetId = resolvedTargetId;
				return;
			}
		}
		await fetchOk(appendCdpPath(profile.cdpUrl, `/json/activate/${resolvedTargetId}`));
		const profileState = getProfileState();
		profileState.lastTargetId = resolvedTargetId;
	};
	const closeTab = async (targetId) => {
		const resolvedTargetId = await resolveTargetIdOrThrow(targetId);
		if (!profile.cdpIsLoopback) {
			const closePageByTargetIdViaPlaywright = (await getPwAiModule$1({ mode: "strict" }))?.closePageByTargetIdViaPlaywright;
			if (typeof closePageByTargetIdViaPlaywright === "function") {
				await closePageByTargetIdViaPlaywright({
					cdpUrl: profile.cdpUrl,
					targetId: resolvedTargetId
				});
				return;
			}
		}
		await fetchOk(appendCdpPath(profile.cdpUrl, `/json/close/${resolvedTargetId}`));
	};
	const stopRunningBrowser = async () => {
		if (profile.driver === "extension") return { stopped: await stopChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }) };
		const profileState = getProfileState();
		if (!profileState.running) return { stopped: false };
		await stopOpenClawChrome(profileState.running);
		setProfileRunning(null);
		return { stopped: true };
	};
	const resetProfile = async () => {
		if (profile.driver === "extension") {
			await stopChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch(() => {});
			return {
				moved: false,
				from: profile.cdpUrl
			};
		}
		if (!profile.cdpIsLoopback) throw new Error(`reset-profile is only supported for local profiles (profile "${profile.name}" is remote).`);
		const userDataDir = resolveOpenClawUserDataDir(profile.name);
		const profileState = getProfileState();
		if (await isHttpReachable(300) && !profileState.running) try {
			await (await import("./pw-ai-LhIMGWVB.js")).closePlaywrightBrowserConnection();
		} catch {}
		if (profileState.running) await stopRunningBrowser();
		try {
			await (await import("./pw-ai-LhIMGWVB.js")).closePlaywrightBrowserConnection();
		} catch {}
		if (!fs.existsSync(userDataDir)) return {
			moved: false,
			from: userDataDir
		};
		return {
			moved: true,
			from: userDataDir,
			to: await movePathToTrash(userDataDir)
		};
	};
	return {
		profile,
		ensureBrowserAvailable,
		ensureTabAvailable,
		isHttpReachable,
		isReachable,
		listTabs,
		openTab,
		focusTab,
		closeTab,
		stopRunningBrowser,
		resetProfile
	};
}
function createBrowserRouteContext(opts) {
	const refreshConfigFromDisk = opts.refreshConfigFromDisk === true;
	const state = () => {
		const current = opts.getState();
		if (!current) throw new Error("Browser server not started");
		return current;
	};
	const forProfile = (profileName) => {
		const current = state();
		const name = profileName ?? current.resolved.defaultProfile;
		const profile = resolveBrowserProfileWithHotReload({
			current,
			refreshConfigFromDisk,
			name
		});
		if (!profile) {
			const available = Object.keys(current.resolved.profiles).join(", ");
			throw new Error(`Profile "${name}" not found. Available profiles: ${available || "(none)"}`);
		}
		return createProfileContext(opts, profile);
	};
	const listProfiles = async () => {
		const current = state();
		refreshResolvedBrowserConfigFromDisk({
			current,
			refreshConfigFromDisk,
			mode: "cached"
		});
		const result = [];
		for (const name of Object.keys(current.resolved.profiles)) {
			const profileState = current.profiles.get(name);
			const profile = resolveProfile(current.resolved, name);
			if (!profile) continue;
			let tabCount = 0;
			let running = false;
			if (profileState?.running) {
				running = true;
				try {
					tabCount = (await createProfileContext(opts, profile).listTabs()).filter((t) => t.type === "page").length;
				} catch {}
			} else try {
				if (await isChromeReachable(profile.cdpUrl, 200)) {
					running = true;
					tabCount = (await createProfileContext(opts, profile).listTabs().catch(() => [])).filter((t) => t.type === "page").length;
				}
			} catch {}
			result.push({
				name,
				cdpPort: profile.cdpPort,
				cdpUrl: profile.cdpUrl,
				color: profile.color,
				running,
				tabCount,
				isDefault: name === current.resolved.defaultProfile,
				isRemote: !profile.cdpIsLoopback
			});
		}
		return result;
	};
	const getDefaultContext = () => forProfile();
	const mapTabError = (err) => {
		if (err instanceof SsrFBlockedError) return {
			status: 400,
			message: err.message
		};
		if (err instanceof InvalidBrowserNavigationUrlError) return {
			status: 400,
			message: err.message
		};
		const msg = String(err);
		if (msg.includes("ambiguous target id prefix")) return {
			status: 409,
			message: "ambiguous target id prefix"
		};
		if (msg.includes("tab not found")) return {
			status: 404,
			message: msg
		};
		if (msg.includes("not found")) return {
			status: 404,
			message: msg
		};
		return null;
	};
	return {
		state,
		forProfile,
		listProfiles,
		ensureBrowserAvailable: () => getDefaultContext().ensureBrowserAvailable(),
		ensureTabAvailable: (targetId) => getDefaultContext().ensureTabAvailable(targetId),
		isHttpReachable: (timeoutMs) => getDefaultContext().isHttpReachable(timeoutMs),
		isReachable: (timeoutMs) => getDefaultContext().isReachable(timeoutMs),
		listTabs: () => getDefaultContext().listTabs(),
		openTab: (url) => getDefaultContext().openTab(url),
		focusTab: (targetId) => getDefaultContext().focusTab(targetId),
		closeTab: (targetId) => getDefaultContext().closeTab(targetId),
		stopRunningBrowser: () => getDefaultContext().stopRunningBrowser(),
		resetProfile: () => getDefaultContext().resetProfile(),
		mapTabError
	};
}

//#endregion
export { resolveProfile as a, ensureGatewayStartupAuth as c, resolveBrowserConfig as i, mergeGatewayTailscaleConfig as l, listKnownProfileNames as n, ensureBrowserControlAuth as o, registerBrowserRoutes as r, resolveBrowserControlAuth as s, createBrowserRouteContext as t };