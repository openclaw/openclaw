import { l as normalizeNonEmptyString, n as resolveSystemRunCommandRequest, s as normalizeSystemRunApprovalPlan, t as formatExecCommand, u as normalizeStringArray } from "./system-run-command-BT3YU9qx.js";
//#region src/infra/system-run-approval-context.ts
function normalizeCommandText(value) {
	return typeof value === "string" ? value : "";
}
function normalizeCommandPreview(value, authoritative) {
	const preview = normalizeNonEmptyString(value);
	if (!preview || preview === authoritative) return null;
	return preview;
}
function parsePreparedSystemRunPayload(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const raw = payload;
	const plan = normalizeSystemRunApprovalPlan(raw.plan);
	if (plan) return { plan };
	if (!raw.plan || typeof raw.plan !== "object" || Array.isArray(raw.plan)) return null;
	const legacyPlan = raw.plan;
	const argv = normalizeStringArray(legacyPlan.argv);
	const commandText = normalizeNonEmptyString(legacyPlan.rawCommand) ?? normalizeNonEmptyString(raw.commandText) ?? normalizeNonEmptyString(raw.cmdText);
	if (argv.length === 0 || !commandText) return null;
	return { plan: {
		argv,
		cwd: normalizeNonEmptyString(legacyPlan.cwd),
		commandText,
		commandPreview: normalizeNonEmptyString(legacyPlan.commandPreview),
		agentId: normalizeNonEmptyString(legacyPlan.agentId),
		sessionKey: normalizeNonEmptyString(legacyPlan.sessionKey)
	} };
}
function resolveSystemRunApprovalRequestContext(params) {
	const normalizedPlan = (normalizeNonEmptyString(params.host) ?? "") === "node" ? normalizeSystemRunApprovalPlan(params.systemRunPlan) : null;
	const fallbackArgv = normalizeStringArray(params.commandArgv);
	const fallbackCommand = normalizeCommandText(params.command);
	const commandText = normalizedPlan ? normalizedPlan.commandText || formatExecCommand(normalizedPlan.argv) : fallbackCommand;
	const commandPreview = normalizedPlan ? normalizeCommandPreview(normalizedPlan.commandPreview ?? fallbackCommand, commandText) : null;
	const plan = normalizedPlan ? {
		...normalizedPlan,
		commandPreview
	} : null;
	return {
		plan,
		commandArgv: plan?.argv ?? (fallbackArgv.length > 0 ? fallbackArgv : void 0),
		commandText,
		commandPreview,
		cwd: plan?.cwd ?? normalizeNonEmptyString(params.cwd),
		agentId: plan?.agentId ?? normalizeNonEmptyString(params.agentId),
		sessionKey: plan?.sessionKey ?? normalizeNonEmptyString(params.sessionKey)
	};
}
function resolveSystemRunApprovalRuntimeContext(params) {
	const normalizedPlan = normalizeSystemRunApprovalPlan(params.plan ?? null);
	if (normalizedPlan) return {
		ok: true,
		plan: normalizedPlan,
		argv: [...normalizedPlan.argv],
		cwd: normalizedPlan.cwd,
		agentId: normalizedPlan.agentId,
		sessionKey: normalizedPlan.sessionKey,
		commandText: normalizedPlan.commandText
	};
	const command = resolveSystemRunCommandRequest({
		command: params.command,
		rawCommand: params.rawCommand
	});
	if (!command.ok) return {
		ok: false,
		message: command.message,
		details: command.details
	};
	return {
		ok: true,
		plan: null,
		argv: command.argv,
		cwd: normalizeNonEmptyString(params.cwd),
		agentId: normalizeNonEmptyString(params.agentId),
		sessionKey: normalizeNonEmptyString(params.sessionKey),
		commandText: command.commandText
	};
}
//#endregion
export { resolveSystemRunApprovalRequestContext as n, resolveSystemRunApprovalRuntimeContext as r, parsePreparedSystemRunPayload as t };
