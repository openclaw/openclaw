import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { t as isTruthyEnvValue } from "./env-DL0trrAI.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { r as runCommandWithTimeout } from "./exec-DusmGtXL.js";
import { t as note } from "./note-Bg5THHEx.js";
import { n as runGatewayUpdate } from "./update-runner-H-pPQ1P6.js";
//#region src/commands/doctor-update.ts
async function detectOpenClawGitCheckout(root) {
	const res = await runCommandWithTimeout([
		"git",
		"-C",
		root,
		"rev-parse",
		"--show-toplevel"
	], { timeoutMs: 5e3 }).catch(() => null);
	if (!res) return "unknown";
	if (res.code !== 0) {
		if (normalizeLowercaseStringOrEmpty(res.stderr).includes("not a git repository")) return "not-git";
		return "unknown";
	}
	return res.stdout.trim() === root ? "git" : "not-git";
}
async function maybeOfferUpdateBeforeDoctor(params) {
	if (!(!isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS) && params.options.nonInteractive !== true && params.options.yes !== true && params.options.repair !== true && process.stdin.isTTY) || !params.root) return { updated: false };
	const git = await detectOpenClawGitCheckout(params.root);
	if (git === "git") {
		if (!await params.confirm({
			message: "Update OpenClaw from git before running doctor?",
			initialValue: true
		})) return { updated: false };
		note("Running update (fetch/rebase/build/ui:build/doctor)…", "Update");
		const result = await runGatewayUpdate({
			cwd: params.root,
			argv1: process.argv[1]
		});
		note([
			`Status: ${result.status}`,
			`Mode: ${result.mode}`,
			result.root ? `Root: ${result.root}` : null,
			result.reason ? `Reason: ${result.reason}` : null
		].filter(Boolean).join("\n"), "Update result");
		if (result.status === "ok") {
			params.outro("Update completed (doctor already ran as part of the update).");
			return {
				updated: true,
				handled: true
			};
		}
		return {
			updated: true,
			handled: false
		};
	}
	if (git === "not-git") note(["This install is not a git checkout.", `Run \`${formatCliCommand("openclaw update")}\` to update via your package manager (npm/pnpm), then rerun doctor.`].join("\n"), "Update");
	return { updated: false };
}
//#endregion
export { maybeOfferUpdateBeforeDoctor };
