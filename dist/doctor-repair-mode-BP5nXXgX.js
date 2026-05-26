import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
//#region src/commands/doctor-repair-mode.ts
function resolveDoctorRepairMode(options) {
	const yes = options.yes === true;
	const requestedNonInteractive = options.nonInteractive === true;
	const shouldRepair = options.repair === true || yes;
	const shouldForce = options.force === true;
	const isTty = process.stdin.isTTY;
	const nonInteractive = requestedNonInteractive || !isTty && !yes;
	const updateInProgress = isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS);
	return {
		shouldRepair,
		shouldForce,
		nonInteractive,
		canPrompt: isTty && !yes && !nonInteractive,
		updateInProgress
	};
}
function isDoctorUpdateRepairMode(mode) {
	return mode.updateInProgress && mode.nonInteractive;
}
function shouldAutoApproveDoctorFix(mode, params = {}) {
	if (!mode.shouldRepair) return false;
	if (params.requiresForce && !mode.shouldForce) return false;
	if (params.blockDuringUpdate && isDoctorUpdateRepairMode(mode)) return false;
	return true;
}
//#endregion
export { resolveDoctorRepairMode as n, shouldAutoApproveDoctorFix as r, isDoctorUpdateRepairMode as t };
