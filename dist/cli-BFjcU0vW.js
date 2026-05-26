import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as COGNITIVE_SERVICES_RESOURCE } from "./shared-BspuLN8V.js";
import { execFile, execFileSync, spawn } from "node:child_process";
//#region extensions/microsoft-foundry/cli.ts
function summarizeAzErrorMessage(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const normalized = trimmed.replace(/\s+/g, " ");
	if (/not recognized|enoent|spawn .* az/i.test(normalized)) return "Azure CLI (az) is not installed or not on PATH.";
	if (/az login/i.test(normalized) || /please run 'az login'/i.test(normalized)) return "Azure CLI is not logged in. Run `az login --use-device-code`.";
	if (/subscription/i.test(normalized) && /could not be found|does not exist|no subscriptions/i.test(normalized)) return "Azure CLI could not find an accessible subscription. Check the selected subscription or tenant access.";
	if (/tenant/i.test(normalized) && /not found|invalid|doesn't exist|does not exist/i.test(normalized)) return "Azure CLI could not use that tenant. Verify the tenant ID or tenant domain and try `az login --tenant <tenant>`.";
	if (/aadsts\d+/i.test(normalized)) return "Azure login failed for the selected tenant. Re-run `az login --use-device-code` and confirm the tenant is correct.";
	return normalized.slice(0, 300);
}
function buildAzCommandError(error, stderr, stdout) {
	const details = summarizeAzErrorMessage(`${stderr ?? ""} ${stdout ?? ""}`);
	return new Error(details ? `${error.message}: ${details}` : error.message);
}
function execAz(args) {
	return normalizeOptionalString(execFileSync("az", args, {
		encoding: "utf-8",
		timeout: 3e4,
		shell: process.platform === "win32"
	})) ?? "";
}
async function execAzAsync(args) {
	return await new Promise((resolve, reject) => {
		execFile("az", args, {
			encoding: "utf-8",
			timeout: 3e4,
			shell: process.platform === "win32"
		}, (error, stdout, stderr) => {
			if (error) {
				reject(buildAzCommandError(error, stderr ?? "", stdout ?? ""));
				return;
			}
			resolve(normalizeStringifiedOptionalString(stdout) ?? "");
		});
	});
}
function isAzCliInstalled() {
	try {
		execAz([
			"version",
			"--output",
			"none"
		]);
		return true;
	} catch {
		return false;
	}
}
function getLoggedInAccount() {
	try {
		return parseAzJson(execAz([
			"account",
			"show",
			"--output",
			"json"
		]), "account");
	} catch {
		return null;
	}
}
function listSubscriptions() {
	try {
		return parseAzJson(execAz([
			"account",
			"list",
			"--output",
			"json",
			"--all"
		]), "subscriptions").filter((sub) => sub.state === "Enabled");
	} catch {
		return [];
	}
}
function parseAzJson(raw, label) {
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(`Azure CLI returned malformed ${label} JSON.`);
	}
}
function buildAccessTokenArgs(params) {
	const args = [
		"account",
		"get-access-token",
		"--resource",
		COGNITIVE_SERVICES_RESOURCE,
		"--output",
		"json"
	];
	if (params?.subscriptionId) args.push("--subscription", params.subscriptionId);
	else if (params?.tenantId) args.push("--tenant", params.tenantId);
	return args;
}
function getAccessTokenResult(params) {
	return parseAzJson(execAz(buildAccessTokenArgs(params)), "access token");
}
async function getAccessTokenResultAsync(params) {
	return parseAzJson(await execAzAsync(buildAccessTokenArgs(params)), "access token");
}
async function azLoginDeviceCode() {
	return azLoginDeviceCodeWithOptions({});
}
async function azLoginDeviceCodeWithOptions(params) {
	return new Promise((resolve, reject) => {
		const maxCapturedLoginOutputChars = 8e3;
		const child = spawn("az", [
			"login",
			"--use-device-code",
			...params.tenantId ? ["--tenant", params.tenantId] : [],
			...params.allowNoSubscriptions ? ["--allow-no-subscriptions"] : []
		], {
			stdio: [
				"inherit",
				"pipe",
				"pipe"
			],
			shell: process.platform === "win32"
		});
		const stdoutChunks = [];
		const stderrChunks = [];
		let stdoutLen = 0;
		let stderrLen = 0;
		const appendBoundedChunk = (chunks, text, len) => {
			if (!text) return len;
			chunks.push(text);
			let total = len + text.length;
			while (total > maxCapturedLoginOutputChars && chunks.length > 0) {
				const removed = chunks.shift();
				total -= removed?.length ?? 0;
			}
			return total;
		};
		child.stdout?.on("data", (chunk) => {
			const text = String(chunk);
			stdoutLen = appendBoundedChunk(stdoutChunks, text, stdoutLen);
			process.stdout.write(text);
		});
		child.stderr?.on("data", (chunk) => {
			const text = String(chunk);
			stderrLen = appendBoundedChunk(stderrChunks, text, stderrLen);
			process.stderr.write(text);
		});
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			const output = normalizeOptionalString([...stderrChunks, ...stdoutChunks].join("")) ?? "";
			reject(/* @__PURE__ */ new Error(output ? `az login exited with code ${code}: ${output}` : `az login exited with code ${code}`));
		});
		child.on("error", reject);
	});
}
//#endregion
export { getAccessTokenResultAsync as a, listSubscriptions as c, getAccessTokenResult as i, azLoginDeviceCodeWithOptions as n, getLoggedInAccount as o, execAz as r, isAzCliInstalled as s, azLoginDeviceCode as t };
