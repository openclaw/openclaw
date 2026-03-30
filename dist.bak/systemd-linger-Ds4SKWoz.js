import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { t as note } from "./note-DcEdE35k.js";
import { d as enableSystemdUserLinger, f as readSystemdUserLingerStatus, r as isSystemdUserServiceAvailable } from "./systemd-C5rdv1uf.js";

//#region src/commands/systemd-linger.ts
var systemd_linger_exports = /* @__PURE__ */ __exportAll({
	ensureSystemdUserLingerInteractive: () => ensureSystemdUserLingerInteractive,
	ensureSystemdUserLingerNonInteractive: () => ensureSystemdUserLingerNonInteractive
});
async function ensureSystemdUserLingerInteractive(params) {
	if (process.platform !== "linux") return;
	if (params.prompt === false) return;
	const env = params.env ?? process.env;
	const prompter = params.prompter ?? { note };
	const title = params.title ?? "Systemd";
	if (!await isSystemdUserServiceAvailable()) {
		await prompter.note("Systemd user services are unavailable. Skipping lingering checks.", title);
		return;
	}
	const status = await readSystemdUserLingerStatus(env);
	if (!status) {
		await prompter.note("Unable to read loginctl linger status. Ensure systemd + loginctl are available.", title);
		return;
	}
	if (status.linger === "yes") return;
	const reason = params.reason ?? "Systemd user services stop when you log out or go idle, which kills the Gateway.";
	const actionNote = params.requireConfirm ? "We can enable lingering now (may require sudo; writes /var/lib/systemd/linger)." : "Enabling lingering now (may require sudo; writes /var/lib/systemd/linger).";
	await prompter.note(`${reason}\n${actionNote}`, title);
	if (params.requireConfirm && prompter.confirm) {
		if (!await prompter.confirm({
			message: `Enable systemd lingering for ${status.user}?`,
			initialValue: true
		})) {
			await prompter.note("Without lingering, the Gateway will stop when you log out.", title);
			return;
		}
	}
	if ((await enableSystemdUserLinger({
		env,
		user: status.user
	})).ok) {
		await prompter.note(`Enabled systemd lingering for ${status.user}.`, title);
		return;
	}
	const result = await enableSystemdUserLinger({
		env,
		user: status.user,
		sudoMode: "prompt"
	});
	if (result.ok) {
		await prompter.note(`Enabled systemd lingering for ${status.user}.`, title);
		return;
	}
	params.runtime.error(`Failed to enable lingering: ${result.stderr || result.stdout || "unknown error"}`);
	await prompter.note(`Run manually: sudo loginctl enable-linger ${status.user}`, title);
}
async function ensureSystemdUserLingerNonInteractive(params) {
	if (process.platform !== "linux") return;
	const env = params.env ?? process.env;
	if (!await isSystemdUserServiceAvailable()) return;
	const status = await readSystemdUserLingerStatus(env);
	if (!status || status.linger === "yes") return;
	if ((await enableSystemdUserLinger({
		env,
		user: status.user,
		sudoMode: "non-interactive"
	})).ok) {
		params.runtime.log(`Enabled systemd lingering for ${status.user}.`);
		return;
	}
	params.runtime.log(`Systemd lingering is disabled for ${status.user}. Run: sudo loginctl enable-linger ${status.user}`);
}

//#endregion
export { ensureSystemdUserLingerNonInteractive as n, systemd_linger_exports as r, ensureSystemdUserLingerInteractive as t };