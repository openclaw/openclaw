import { t as getWindowsInstallRoots } from "./windows-install-roots-C-V7Ai9d.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { t as isWSL } from "./wsl-2-jVkfxN.js";
import { t as detectBinary } from "./detect-binary-C4HxcF68.js";
import path from "node:path";
//#region src/infra/browser-open.ts
function shouldSkipBrowserOpenInTests() {
	if (process.env.VITEST) return true;
	return false;
}
function resolveWindowsRundll32Path() {
	const { systemRoot } = getWindowsInstallRoots();
	return path.win32.join(systemRoot, "System32", "rundll32.exe");
}
function normalizeBrowserOpenUrl(raw) {
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return parsed.toString();
	} catch {
		return null;
	}
}
async function resolveBrowserOpenCommand() {
	const platform = process.platform;
	const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
	if ((Boolean(process.env.SSH_CLIENT) || Boolean(process.env.SSH_TTY) || Boolean(process.env.SSH_CONNECTION)) && !hasDisplay && platform !== "win32" && platform !== "darwin") return {
		argv: null,
		reason: "ssh-no-display"
	};
	if (platform === "win32") {
		const rundll32 = resolveWindowsRundll32Path();
		return {
			argv: [rundll32, "url.dll,FileProtocolHandler"],
			command: rundll32
		};
	}
	if (platform === "darwin") return await detectBinary("open") ? {
		argv: ["open"],
		command: "open"
	} : {
		argv: null,
		reason: "missing-open"
	};
	if (platform === "linux") {
		const wsl = await isWSL();
		if (!hasDisplay && !wsl) return {
			argv: null,
			reason: "no-display"
		};
		if (wsl) {
			if (await detectBinary("wslview")) return {
				argv: ["wslview"],
				command: "wslview"
			};
			if (!hasDisplay) return {
				argv: null,
				reason: "wsl-no-wslview"
			};
		}
		return await detectBinary("xdg-open") ? {
			argv: ["xdg-open"],
			command: "xdg-open"
		} : {
			argv: null,
			reason: "missing-xdg-open"
		};
	}
	return {
		argv: null,
		reason: "unsupported-platform"
	};
}
async function detectBrowserOpenSupport() {
	const resolved = await resolveBrowserOpenCommand();
	if (!resolved.argv) return {
		ok: false,
		reason: resolved.reason
	};
	return {
		ok: true,
		command: resolved.command
	};
}
async function openUrl(url) {
	if (shouldSkipBrowserOpenInTests()) return false;
	const normalizedUrl = normalizeBrowserOpenUrl(url);
	if (!normalizedUrl) return false;
	const resolved = await resolveBrowserOpenCommand();
	if (!resolved.argv) return false;
	const command = [...resolved.argv];
	command.push(normalizedUrl);
	try {
		await runCommandWithTimeout(command, { timeoutMs: 5e3 });
		return true;
	} catch {
		return false;
	}
}
//#endregion
export { openUrl as n, resolveBrowserOpenCommand as r, detectBrowserOpenSupport as t };
