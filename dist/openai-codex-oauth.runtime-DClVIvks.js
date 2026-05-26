import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { r as ensureGlobalUndiciEnvProxyDispatcher } from "./undici-global-dispatcher-B3DjrQKu.js";
import "./error-runtime-DGHc7DZw.js";
import "./runtime-env-BtvWnLRh.js";
import "./setup-tools-DuiMNzp5.js";
import path from "node:path";
import { loginOpenAICodex } from "@earendil-works/pi-ai/oauth";
//#region extensions/openai/openai-codex-oauth.runtime.ts
const manualInputPromptMessage = "Paste the authorization code (or full redirect URL):";
const openAICodexOAuthOriginator = "openclaw";
const localManualFallbackDelayMs = 15e3;
const localManualFallbackGraceMs = 1e3;
const openAIAuthProbeUrl = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=openclaw-preflight&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email";
const tlsCertErrorCodes = new Set([
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"ERR_TLS_CERT_ALTNAME_INVALID"
]);
const tlsCertErrorPatterns = [
	/unable to get local issuer certificate/i,
	/unable to verify the first certificate/i,
	/self[- ]signed certificate/i,
	/certificate has expired/i
];
function getErrorRecord(error) {
	return error && typeof error === "object" ? error : null;
}
function extractFailure(error) {
	const root = getErrorRecord(error);
	const rootCause = getErrorRecord(root?.cause);
	const code = typeof rootCause?.code === "string" ? rootCause.code : void 0;
	const message = typeof rootCause?.message === "string" ? rootCause.message : typeof root?.message === "string" ? root.message : String(error);
	return {
		code,
		message,
		kind: (code ? tlsCertErrorCodes.has(code) : false) || tlsCertErrorPatterns.some((pattern) => pattern.test(message)) ? "tls-cert" : "network"
	};
}
function resolveHomebrewPrefixFromExecPath(execPath) {
	const marker = `${path.sep}Cellar${path.sep}`;
	const idx = execPath.indexOf(marker);
	if (idx > 0) return execPath.slice(0, idx);
	return process.env.HOMEBREW_PREFIX?.trim() || null;
}
function resolveCertBundlePath() {
	const prefix = resolveHomebrewPrefixFromExecPath(process.execPath);
	return prefix ? path.join(prefix, "etc", "openssl@3", "cert.pem") : null;
}
async function runOpenAIOAuthTlsPreflight(options) {
	const timeoutMs = options?.timeoutMs ?? 5e3;
	const fetchImpl = options?.fetchImpl ?? fetch;
	try {
		await fetchImpl(openAIAuthProbeUrl, {
			method: "GET",
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs)
		});
		return { ok: true };
	} catch (error) {
		const failure = extractFailure(error);
		return {
			ok: false,
			kind: failure.kind,
			code: failure.code,
			message: failure.message
		};
	}
}
function formatOpenAIOAuthTlsPreflightFix(result) {
	if (result.kind !== "tls-cert") return [
		"OpenAI OAuth prerequisites check failed due to a network error before the browser flow.",
		`Cause: ${result.message}`,
		"Verify DNS/firewall/proxy access to auth.openai.com and retry."
	].join("\n");
	const certBundlePath = resolveCertBundlePath();
	const lines = [
		"OpenAI OAuth prerequisites check failed: Node/OpenSSL cannot validate TLS certificates.",
		`Cause: ${result.code ? `${result.code} (${result.message})` : result.message}`,
		"",
		"Fix (Homebrew Node/OpenSSL):",
		`- ${formatCliCommand("brew postinstall ca-certificates")}`,
		`- ${formatCliCommand("brew postinstall openssl@3")}`
	];
	if (certBundlePath) lines.push(`- Verify cert bundle exists: ${certBundlePath}`);
	lines.push("- Retry the OAuth login flow.");
	return lines.join("\n");
}
function settleAfterDelay(params) {
	return new Promise((resolve) => {
		let done = false;
		const complete = (outcome) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(outcome);
		};
		const timer = setTimeout(() => complete("delay"), params.delayMs);
		params.waitForLoginToSettle.then(() => complete("settled"), () => complete("settled"));
	});
}
function waitForeverForPromptInput() {
	return new Promise(() => void 0);
}
function createOpenAICodexOAuthError(code, message, cause) {
	return Object.assign(new Error(`OpenAI Codex OAuth failed (${code}): ${message}`, { cause }), { code });
}
function rewriteOpenAICodexOAuthError(error) {
	const message = formatErrorMessage(error);
	if (/unsupported_country_region_territory/i.test(message)) return createOpenAICodexOAuthError("unsupported_region", ["OpenAI rejected the token exchange for this country, region, or network route.", "If you normally use a proxy, verify HTTPS_PROXY, HTTP_PROXY, or ALL_PROXY is set for the OpenClaw process and then retry `openclaw models auth login --provider openai-codex`."].join(" "), error);
	if (/state mismatch|missing authorization code/i.test(message)) return createOpenAICodexOAuthError("callback_validation_failed", message, error);
	return error instanceof Error ? error : new Error(message);
}
function createManualCodeInputHandler(params) {
	let manualFallbackPromise;
	const promptForManualCode = () => params.onPrompt({ message: manualInputPromptMessage });
	if (params.isRemote) return async () => {
		manualFallbackPromise ??= promptForManualCode();
		return await manualFallbackPromise;
	};
	const switchToManualEntry = async (progressMessage, logMessage) => {
		params.updateProgress(progressMessage);
		if (logMessage) params.runtime.log(logMessage);
		params.stopProgress("Manual OAuth entry required");
		return await promptForManualCode();
	};
	const runLocalManualFallback = async () => {
		if (!params.hasBrowserAuthStarted()) return await switchToManualEntry("Local OAuth callback was unavailable. Paste the redirect URL to continue...", "OpenAI Codex OAuth local callback did not start; switching to manual entry immediately.");
		if (await settleAfterDelay({
			delayMs: localManualFallbackDelayMs,
			waitForLoginToSettle: params.waitForLoginToSettle
		}) === "settled") return await waitForeverForPromptInput();
		if (await settleAfterDelay({
			delayMs: localManualFallbackGraceMs,
			waitForLoginToSettle: params.waitForLoginToSettle
		}) === "settled") return await waitForeverForPromptInput();
		return await switchToManualEntry("Browser callback did not finish. Paste the redirect URL to continue...", `OpenAI Codex OAuth callback did not arrive within ${localManualFallbackDelayMs}ms; switching to manual entry (callback_timeout).`);
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
	const spin = prompter.progress("Starting OAuth flow...");
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
		const { onAuth: baseOnAuth, onPrompt } = params.oauth.createVpsAwareHandlers({
			isRemote,
			prompter,
			runtime,
			spin,
			openUrl,
			localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser...",
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
export { loginOpenAICodexOAuth as t };
