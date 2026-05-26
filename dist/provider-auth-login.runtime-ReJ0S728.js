import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { i as isLoopbackHost } from "./net-DCUMtgJy.js";
import { r as ensureGlobalUndiciEnvProxyDispatcher } from "./undici-global-dispatcher-B3DjrQKu.js";
import { r as loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader-Cog8gw3V.js";
import { i as parseOAuthCallbackInput, n as exchangeChutesCodeForTokens, r as generateChutesPkce, t as CHUTES_AUTHORIZE_ENDPOINT } from "./chutes-oauth-CixIqCkm.js";
import { t as createVpsAwareOAuthHandlers } from "./provider-oauth-flow-yFbEzcQS.js";
import { r as runOpenAIOAuthTlsPreflight, t as formatOpenAIOAuthTlsPreflightFix } from "./provider-openai-codex-oauth-tls-n9XynoaA.js";
import { randomBytes } from "node:crypto";
import { loginOpenAICodex } from "@earendil-works/pi-ai/oauth";
import { createServer } from "node:http";
//#region src/commands/chutes-oauth.ts
function parseManualOAuthInput(input, expectedState) {
	const trimmed = normalizeOptionalString(input ?? "") ?? "";
	if (!trimmed) throw new Error("Missing OAuth redirect URL or authorization code.");
	if (!(/^https?:\/\//i.test(trimmed) || trimmed.includes("://") || trimmed.includes("?"))) return {
		code: trimmed,
		state: expectedState
	};
	const parsed = parseOAuthCallbackInput(trimmed, expectedState);
	if ("error" in parsed) throw new Error(parsed.error);
	if (parsed.state !== expectedState) throw new Error("Invalid OAuth state");
	return parsed;
}
function buildAuthorizeUrl(params) {
	return `${CHUTES_AUTHORIZE_ENDPOINT}?${new URLSearchParams({
		client_id: params.clientId,
		redirect_uri: params.redirectUri,
		response_type: "code",
		scope: params.scopes.join(" "),
		state: params.state,
		code_challenge: params.challenge,
		code_challenge_method: "S256"
	}).toString()}`;
}
async function waitForLocalCallback(params) {
	const redirectUrl = new URL(params.redirectUri);
	if (redirectUrl.protocol !== "http:") throw new Error(`Chutes OAuth redirect URI must be http:// (got ${params.redirectUri})`);
	const hostname = redirectUrl.hostname || "127.0.0.1";
	if (!isLoopbackHost(hostname)) throw new Error(`Chutes OAuth redirect hostname must be loopback (got ${hostname}). Use http://127.0.0.1:<port>/...`);
	const port = redirectUrl.port ? Number.parseInt(redirectUrl.port, 10) : 80;
	const expectedPath = redirectUrl.pathname || "/";
	return await new Promise((resolve, reject) => {
		let timeout = null;
		const server = createServer((req, res) => {
			try {
				const requestUrl = new URL(req.url ?? "/", redirectUrl.origin);
				if (requestUrl.pathname !== expectedPath) {
					res.statusCode = 404;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end("Not found");
					return;
				}
				const code = requestUrl.searchParams.get("code")?.trim();
				const state = requestUrl.searchParams.get("state")?.trim();
				if (!code) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end("Missing code");
					return;
				}
				if (!state || state !== params.expectedState) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end("Invalid state");
					return;
				}
				res.statusCode = 200;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end([
					"<!doctype html>",
					"<html><head><meta charset='utf-8' /></head>",
					"<body><h2>Chutes OAuth complete</h2>",
					"<p>You can close this window and return to OpenClaw.</p></body></html>"
				].join(""));
				if (timeout) clearTimeout(timeout);
				server.close();
				resolve({
					code,
					state
				});
			} catch (err) {
				if (timeout) clearTimeout(timeout);
				server.close();
				reject(err);
			}
		});
		server.once("error", (err) => {
			if (timeout) clearTimeout(timeout);
			server.close();
			reject(err);
		});
		server.listen(port, hostname, () => {
			params.onProgress?.(`Waiting for OAuth callback on ${redirectUrl.origin}${expectedPath}…`);
		});
		timeout = setTimeout(() => {
			try {
				server.close();
			} catch {}
			reject(/* @__PURE__ */ new Error("OAuth callback timeout"));
		}, params.timeoutMs);
	});
}
async function loginChutes(params) {
	const createPkce = params.createPkce ?? generateChutesPkce;
	const createState = params.createState ?? (() => randomBytes(16).toString("hex"));
	const { verifier, challenge } = createPkce();
	const state = createState();
	const timeoutMs = params.timeoutMs ?? 180 * 1e3;
	const url = buildAuthorizeUrl({
		clientId: params.app.clientId,
		redirectUri: params.app.redirectUri,
		scopes: params.app.scopes,
		state,
		challenge
	});
	let codeAndState;
	if (params.manual) {
		await params.onAuth({ url });
		params.onProgress?.("Waiting for redirect URL…");
		codeAndState = parseManualOAuthInput(await params.onPrompt({
			message: "Paste the redirect URL (or authorization code)",
			placeholder: `${params.app.redirectUri}?code=...&state=...`
		}), state);
	} else {
		const callback = waitForLocalCallback({
			redirectUri: params.app.redirectUri,
			expectedState: state,
			timeoutMs,
			onProgress: params.onProgress
		}).catch(async () => {
			params.onProgress?.("OAuth callback not detected; paste redirect URL…");
			return parseManualOAuthInput(await params.onPrompt({
				message: "Paste the redirect URL (or authorization code)",
				placeholder: `${params.app.redirectUri}?code=...&state=...`
			}), state);
		});
		await params.onAuth({ url });
		codeAndState = await callback;
	}
	params.onProgress?.("Exchanging code for tokens…");
	return await exchangeChutesCodeForTokens({
		app: params.app,
		code: codeAndState.code,
		codeVerifier: verifier,
		fetchFn: params.fetchFn
	});
}
//#endregion
//#region src/plugins/provider-openai-codex-oauth.ts
const manualInputPromptMessage = "Paste the authorization code (or full redirect URL):";
const openAICodexOAuthOriginator = "openclaw";
const localManualFallbackDelayMs = 15e3;
const localManualFallbackGraceMs = 1e3;
function waitForDelayOrLoginSettle(params) {
	return new Promise((resolve) => {
		let finished = false;
		const finish = (outcome) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeoutHandle);
			resolve(outcome);
		};
		const timeoutHandle = setTimeout(() => finish("delay"), params.delayMs);
		params.waitForLoginToSettle.then(() => finish("settled"), () => finish("settled"));
	});
}
function createNeverSettlingPromptResult() {
	return new Promise(() => void 0);
}
function createOpenAICodexOAuthError(code, message, cause) {
	const error = new Error(`OpenAI Codex OAuth failed (${code}): ${message}`, { cause });
	return Object.assign(error, { code });
}
function rewriteOpenAICodexOAuthError(error) {
	const message = formatErrorMessage(error);
	if (/unsupported_country_region_territory/i.test(message)) return createOpenAICodexOAuthError("unsupported_region", ["OpenAI rejected the token exchange for this country, region, or network route.", "If you normally use a proxy, verify HTTPS_PROXY, HTTP_PROXY, or ALL_PROXY is set for the OpenClaw process and then retry `openclaw models auth login --provider openai-codex`."].join(" "), error);
	if (/state mismatch|missing authorization code/i.test(message)) return createOpenAICodexOAuthError("callback_validation_failed", message, error);
	return error instanceof Error ? error : new Error(message);
}
function createManualCodeInputHandler(params) {
	let manualFallbackPromise;
	if (params.isRemote) return async () => {
		manualFallbackPromise ??= params.onPrompt({ message: manualInputPromptMessage });
		return await manualFallbackPromise;
	};
	const runLocalManualFallback = async () => {
		if (!params.hasBrowserAuthStarted()) {
			params.updateProgress("Local OAuth callback was unavailable. Paste the redirect URL to continue…");
			params.runtime.log("OpenAI Codex OAuth local callback did not start; switching to manual entry immediately.");
			params.stopProgress("Manual OAuth entry required");
			return await params.onPrompt({ message: manualInputPromptMessage });
		}
		if (await waitForDelayOrLoginSettle({
			delayMs: localManualFallbackDelayMs,
			waitForLoginToSettle: params.waitForLoginToSettle
		}) === "settled") return await createNeverSettlingPromptResult();
		if (await waitForDelayOrLoginSettle({
			delayMs: localManualFallbackGraceMs,
			waitForLoginToSettle: params.waitForLoginToSettle
		}) === "settled") return await createNeverSettlingPromptResult();
		params.updateProgress("Browser callback did not finish. Paste the redirect URL to continue…");
		params.runtime.log(`OpenAI Codex OAuth callback did not arrive within ${localManualFallbackDelayMs}ms; switching to manual entry (callback_timeout).`);
		params.stopProgress("Manual OAuth entry required");
		return await params.onPrompt({ message: manualInputPromptMessage });
	};
	return async () => {
		manualFallbackPromise ??= runLocalManualFallback();
		return await manualFallbackPromise;
	};
}
async function loginOpenAICodexOAuth(params) {
	const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;
	ensureGlobalUndiciEnvProxyDispatcher();
	const preflight = await runOpenAIOAuthTlsPreflight();
	if (!preflight.ok && preflight.kind === "tls-cert") {
		const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
		await prompter.note(hint, "OAuth prerequisites");
		runtime.error(hint);
		throw new Error(`OpenAI Codex OAuth prerequisites failed: ${preflight.message}`);
	}
	await prompter.note(isRemote ? [
		"You are running in a remote/VPS environment.",
		"A URL will be shown for you to open in your LOCAL browser.",
		"Open it, sign in, then paste the redirect URL here.",
		"If this OpenClaw process can receive the browser callback, sign-in may finish automatically before you paste."
	].join("\n") : [
		"Browser will open for OpenAI authentication.",
		"If the callback doesn't auto-complete, paste the redirect URL.",
		"OpenAI OAuth uses localhost:1455 for the callback."
	].join("\n"), "OpenAI Codex OAuth");
	const spin = prompter.progress("Starting OAuth flow…");
	let progressActive = true;
	const updateProgress = (message) => {
		if (progressActive) spin.update(message);
	};
	const stopProgress = (message) => {
		if (progressActive) {
			progressActive = false;
			spin.stop(message);
		}
	};
	let browserAuthStarted = false;
	let markLoginSettled;
	const waitForLoginToSettle = new Promise((resolve) => {
		markLoginSettled = resolve;
	});
	try {
		const { onAuth: baseOnAuth, onPrompt } = createVpsAwareOAuthHandlers({
			isRemote,
			prompter,
			runtime,
			spin,
			openUrl,
			localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser…",
			manualPromptMessage: manualInputPromptMessage
		});
		const onAuth = async (event) => {
			browserAuthStarted = true;
			await baseOnAuth(event);
		};
		const creds = await loginOpenAICodex({
			onAuth,
			onPrompt,
			originator: openAICodexOAuthOriginator,
			onManualCodeInput: createManualCodeInputHandler({
				isRemote,
				onPrompt,
				runtime,
				updateProgress,
				stopProgress,
				waitForLoginToSettle,
				hasBrowserAuthStarted: () => browserAuthStarted
			}),
			onProgress: (msg) => updateProgress(msg)
		});
		stopProgress("OpenAI OAuth complete");
		return creds ?? null;
	} catch (err) {
		stopProgress("OpenAI OAuth failed");
		const rewrittenError = rewriteOpenAICodexOAuthError(err);
		runtime.error(String(rewrittenError));
		await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
		throw rewrittenError;
	} finally {
		markLoginSettled();
	}
}
//#endregion
//#region src/plugin-sdk/github-copilot-login.ts
function loadFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "github-copilot",
		artifactBasename: "api.js"
	});
}
/** @deprecated GitHub Copilot provider-owned login helper; use provider auth hooks instead. */
const githubCopilotLoginCommand = ((...args) => loadFacadeModule()["githubCopilotLoginCommand"](...args));
//#endregion
export { githubCopilotLoginCommand, loginChutes, loginOpenAICodexOAuth };
