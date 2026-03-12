import { t as runCommandWithTimeout } from "./exec-BhaMholX.js";

//#region src/infra/clipboard.ts
async function copyToClipboard(value) {
	for (const attempt of [
		{ argv: ["pbcopy"] },
		{ argv: [
			"xclip",
			"-selection",
			"clipboard"
		] },
		{ argv: ["wl-copy"] },
		{ argv: ["clip.exe"] },
		{ argv: [
			"powershell",
			"-NoProfile",
			"-Command",
			"Set-Clipboard"
		] }
	]) try {
		const result = await runCommandWithTimeout(attempt.argv, {
			timeoutMs: 3e3,
			input: value
		});
		if (result.code === 0 && !result.killed) return true;
	} catch {}
	return false;
}

//#endregion
export { copyToClipboard as t };