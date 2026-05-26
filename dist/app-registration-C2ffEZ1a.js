import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { t as renderQrTerminal } from "./qr-terminal-CJoQsh1V.js";
import "./media-runtime-BheBFFxc.js";
//#region extensions/feishu/src/app-registration.ts
/**
* Feishu app registration via OAuth device-code flow.
*
* Migrated from feishu-plugin-cli's `feishu-auth.ts` and `install-prompts.ts`.
* Replaces axios with native fetch, removes inquirer/ora/chalk in favor of
* the openclaw WizardPrompter surface.
*/
const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_URL = "https://accounts.larksuite.com";
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const REQUEST_TIMEOUT_MS = 1e4;
function accountsBaseUrl(domain) {
	return domain === "lark" ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
}
async function postRegistration(baseUrl, body) {
	return await fetchFeishuJson({
		url: `${baseUrl}${REGISTRATION_PATH}`,
		init: {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(body).toString(),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		},
		auditContext: "feishu.app-registration.post"
	});
}
async function fetchFeishuJson(params) {
	const { response, release } = await fetchWithSsrFGuard({
		url: params.url,
		init: params.init,
		policy: { allowedHostnames: [new URL(params.url).hostname] },
		auditContext: params.auditContext
	});
	try {
		return await response.json();
	} finally {
		await release();
	}
}
/**
* Step 1: Initialize registration and verify the environment supports
* `client_secret` auth.
*
* @throws If the environment does not support `client_secret`.
*/
async function initAppRegistration(domain = "feishu") {
	if (!(await postRegistration(accountsBaseUrl(domain), { action: "init" })).supported_auth_methods?.includes("client_secret")) throw new Error("Current environment does not support client_secret auth method");
}
/**
* Step 2: Begin the device-code flow. Returns a device code and a QR URL
* that the user should scan with Feishu/Lark mobile app.
*/
async function beginAppRegistration(domain = "feishu") {
	const res = await postRegistration(accountsBaseUrl(domain), {
		action: "begin",
		archetype: "PersonalAgent",
		auth_method: "client_secret",
		request_user_info: "open_id"
	});
	const qrUrl = new URL(res.verification_uri_complete);
	qrUrl.searchParams.set("from", "oc_onboard");
	qrUrl.searchParams.set("tp", "ob_cli_app");
	return {
		deviceCode: res.device_code,
		qrUrl: qrUrl.toString(),
		userCode: res.user_code,
		interval: res.interval || 5,
		expireIn: res.expire_in || 600
	};
}
/**
* Step 3: Poll for authorization result until success, denial, expiry, or
* timeout. Automatically handles domain switching when `tenant_brand` is
* detected as "lark".
*/
async function pollAppRegistration(params) {
	const { deviceCode, expireIn, initialDomain = "feishu", abortSignal, tp } = params;
	let currentInterval = params.interval;
	let domain = initialDomain;
	let domainSwitched = false;
	const deadline = Date.now() + expireIn * 1e3;
	while (Date.now() < deadline) {
		if (abortSignal?.aborted) return { status: "timeout" };
		const baseUrl = accountsBaseUrl(domain);
		let pollRes;
		try {
			pollRes = await postRegistration(baseUrl, {
				action: "poll",
				device_code: deviceCode,
				...tp ? { tp } : {}
			});
		} catch {
			await sleep(currentInterval * 1e3);
			continue;
		}
		if (pollRes.user_info?.tenant_brand) {
			const isLark = pollRes.user_info.tenant_brand === "lark";
			if (!domainSwitched && isLark) {
				domain = "lark";
				domainSwitched = true;
				continue;
			}
		}
		if (pollRes.client_id && pollRes.client_secret) return {
			status: "success",
			result: {
				appId: pollRes.client_id,
				appSecret: pollRes.client_secret,
				domain,
				openId: pollRes.user_info?.open_id
			}
		};
		if (pollRes.error) if (pollRes.error === "authorization_pending") {} else if (pollRes.error === "slow_down") currentInterval += 5;
		else if (pollRes.error === "access_denied") return { status: "access_denied" };
		else if (pollRes.error === "expired_token") return { status: "expired" };
		else return {
			status: "error",
			message: `${pollRes.error}: ${pollRes.error_description ?? "unknown"}`
		};
		await sleep(currentInterval * 1e3);
	}
	return { status: "timeout" };
}
/**
* Print QR code directly to stdout.
*
* QR codes must be printed without any surrounding box/border decoration,
* otherwise the pattern is corrupted and cannot be scanned.
*/
async function printQrCode(url) {
	const output = await renderQrTerminal(url);
	process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}
/**
* Fetch the app owner's open_id using the application.v6.application.get API.
*
* Used during setup to auto-populate security policy allowlists.
* Returns undefined on any failure (fail-open).
*/
async function getAppOwnerOpenId(params) {
	const baseUrl = params.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
	try {
		const tokenData = await fetchFeishuJson({
			url: `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
			init: {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					app_id: params.appId,
					app_secret: params.appSecret
				}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			},
			auditContext: "feishu.app-registration.owner-token"
		});
		if (!tokenData.tenant_access_token) return;
		const appData = await fetchFeishuJson({
			url: `${baseUrl}/open-apis/application/v6/applications/${params.appId}?user_id_type=open_id`,
			init: {
				method: "GET",
				headers: {
					Authorization: `Bearer ${tokenData.tenant_access_token}`,
					"Content-Type": "application/json"
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			},
			auditContext: "feishu.app-registration.owner-app"
		});
		if (appData.code !== 0) return;
		const app = appData.data?.app;
		const owner = app?.owner;
		return (owner?.owner_type ?? owner?.type) === 2 && owner?.owner_id ? owner.owner_id : app?.creator_id ?? owner?.owner_id;
	} catch {
		return;
	}
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
export { beginAppRegistration, getAppOwnerOpenId, initAppRegistration, pollAppRegistration, printQrCode };
