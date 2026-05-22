import { n as VERSION } from "./version-CQfgAE7_.js";
import { r as shouldWarnOnTouchedVersion } from "./version-CAjjTWnS.js";
//#region src/config/future-version-guard.ts
const ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV = "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS";
function allowOlderBinaryDestructiveActions(env) {
	const raw = env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}
function resolveTouchedVersion(params) {
	return params.snapshot?.sourceConfig?.meta?.lastTouchedVersion?.trim() || params.snapshot?.config?.meta?.lastTouchedVersion?.trim() || params.config?.meta?.lastTouchedVersion?.trim() || null;
}
function resolveFutureConfigActionBlock(params) {
	if (allowOlderBinaryDestructiveActions(params.env ?? process.env)) return null;
	const currentVersion = params.currentVersion ?? VERSION;
	const touchedVersion = resolveTouchedVersion(params);
	if (!touchedVersion || !shouldWarnOnTouchedVersion(currentVersion, touchedVersion)) return null;
	return {
		action: params.action,
		currentVersion,
		touchedVersion,
		message: `Refusing to ${params.action} because this OpenClaw binary (${currentVersion}) is older than the config last written by OpenClaw ${touchedVersion}.`,
		hints: ["Run the newer openclaw binary on PATH, or reinstall the intended gateway service from the newer install.", `Set ${ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV}=1 only for an intentional downgrade or recovery action.`]
	};
}
function formatFutureConfigActionBlock(block) {
	return [block.message, ...block.hints].join("\n");
}
//#endregion
export { formatFutureConfigActionBlock as n, resolveFutureConfigActionBlock as r, ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV as t };
