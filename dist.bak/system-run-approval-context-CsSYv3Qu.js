import { r as normalizeEnvVarKey } from "./host-env-security-BM8ktVlo.js";
import { n as resolveSystemRunCommand, t as formatExecCommand } from "./system-run-command-BqLmA4zq.js";
import crypto from "node:crypto";

//#region src/infra/system-run-approval-binding.ts
function normalizeString$1(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}
function normalizeStringArray$1(value) {
	return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}
function normalizeSystemRunApprovalPlanV2(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value;
	if (candidate.version !== 2) return null;
	const argv = normalizeStringArray$1(candidate.argv);
	if (argv.length === 0) return null;
	return {
		version: 2,
		argv,
		cwd: normalizeString$1(candidate.cwd),
		rawCommand: normalizeString$1(candidate.rawCommand),
		agentId: normalizeString$1(candidate.agentId),
		sessionKey: normalizeString$1(candidate.sessionKey)
	};
}
function normalizeSystemRunEnvEntries(env) {
	if (!env || typeof env !== "object" || Array.isArray(env)) return [];
	const entries = [];
	for (const [rawKey, rawValue] of Object.entries(env)) {
		if (typeof rawValue !== "string") continue;
		const key = normalizeEnvVarKey(rawKey, { portable: true });
		if (!key) continue;
		entries.push([key, rawValue]);
	}
	entries.sort((a, b) => a[0].localeCompare(b[0]));
	return entries;
}
function hashSystemRunEnvEntries(entries) {
	if (entries.length === 0) return null;
	return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
function buildSystemRunApprovalEnvBinding(env) {
	const entries = normalizeSystemRunEnvEntries(env);
	return {
		envHash: hashSystemRunEnvEntries(entries),
		envKeys: entries.map(([key]) => key)
	};
}
function buildSystemRunApprovalBindingV1(params) {
	const envBinding = buildSystemRunApprovalEnvBinding(params.env);
	return {
		binding: {
			version: 1,
			argv: normalizeStringArray$1(params.argv),
			cwd: normalizeString$1(params.cwd),
			agentId: normalizeString$1(params.agentId),
			sessionKey: normalizeString$1(params.sessionKey),
			envHash: envBinding.envHash
		},
		envKeys: envBinding.envKeys
	};
}
function argvMatches(expectedArgv, actualArgv) {
	if (expectedArgv.length === 0 || expectedArgv.length !== actualArgv.length) return false;
	for (let i = 0; i < expectedArgv.length; i += 1) if (expectedArgv[i] !== actualArgv[i]) return false;
	return true;
}
const APPROVAL_REQUEST_MISMATCH_MESSAGE = "approval id does not match request";
function requestMismatch(details) {
	return {
		ok: false,
		code: "APPROVAL_REQUEST_MISMATCH",
		message: APPROVAL_REQUEST_MISMATCH_MESSAGE,
		details
	};
}
function matchSystemRunApprovalEnvHash(params) {
	if (!params.expectedEnvHash && !params.actualEnvHash) return { ok: true };
	if (!params.expectedEnvHash && params.actualEnvHash) return {
		ok: false,
		code: "APPROVAL_ENV_BINDING_MISSING",
		message: "approval id missing env binding for requested env overrides",
		details: { envKeys: params.actualEnvKeys }
	};
	if (params.expectedEnvHash !== params.actualEnvHash) return {
		ok: false,
		code: "APPROVAL_ENV_MISMATCH",
		message: "approval id env binding mismatch",
		details: {
			envKeys: params.actualEnvKeys,
			expectedEnvHash: params.expectedEnvHash,
			actualEnvHash: params.actualEnvHash
		}
	};
	return { ok: true };
}
function matchSystemRunApprovalBindingV1(params) {
	if (params.expected.version !== 1 || params.actual.version !== 1) return requestMismatch({
		expectedVersion: params.expected.version,
		actualVersion: params.actual.version
	});
	if (!argvMatches(params.expected.argv, params.actual.argv)) return requestMismatch();
	if (params.expected.cwd !== params.actual.cwd) return requestMismatch();
	if (params.expected.agentId !== params.actual.agentId) return requestMismatch();
	if (params.expected.sessionKey !== params.actual.sessionKey) return requestMismatch();
	return matchSystemRunApprovalEnvHash({
		expectedEnvHash: params.expected.envHash,
		actualEnvHash: params.actual.envHash,
		actualEnvKeys: params.actualEnvKeys
	});
}
function missingSystemRunApprovalBindingV1(params) {
	return requestMismatch({
		requiredBindingVersion: 1,
		envKeys: params.actualEnvKeys
	});
}
function toSystemRunApprovalMismatchError(params) {
	const details = {
		code: params.match.code,
		runId: params.runId
	};
	if (params.match.details) Object.assign(details, params.match.details);
	return {
		ok: false,
		message: params.match.message,
		details
	};
}

//#endregion
//#region src/infra/system-run-approval-context.ts
function normalizeString(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}
function normalizeStringArray(value) {
	return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}
function normalizeCommandText(value) {
	return typeof value === "string" ? value : "";
}
function parsePreparedSystemRunPayload(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const raw = payload;
	const cmdText = normalizeString(raw.cmdText);
	const plan = normalizeSystemRunApprovalPlanV2(raw.plan);
	if (!cmdText || !plan) return null;
	return {
		cmdText,
		plan
	};
}
function resolveSystemRunApprovalRequestContext(params) {
	const planV2 = (normalizeString(params.host) ?? "") === "node" ? normalizeSystemRunApprovalPlanV2(params.systemRunPlanV2) : null;
	const fallbackArgv = normalizeStringArray(params.commandArgv);
	const fallbackCommand = normalizeCommandText(params.command);
	return {
		planV2,
		commandArgv: planV2?.argv ?? (fallbackArgv.length > 0 ? fallbackArgv : void 0),
		commandText: planV2 ? planV2.rawCommand ?? formatExecCommand(planV2.argv) : fallbackCommand,
		cwd: planV2?.cwd ?? normalizeString(params.cwd),
		agentId: planV2?.agentId ?? normalizeString(params.agentId),
		sessionKey: planV2?.sessionKey ?? normalizeString(params.sessionKey)
	};
}
function resolveSystemRunApprovalRuntimeContext(params) {
	const normalizedPlan = normalizeSystemRunApprovalPlanV2(params.planV2 ?? null);
	if (normalizedPlan) return {
		ok: true,
		planV2: normalizedPlan,
		argv: [...normalizedPlan.argv],
		cwd: normalizedPlan.cwd,
		agentId: normalizedPlan.agentId,
		sessionKey: normalizedPlan.sessionKey,
		rawCommand: normalizedPlan.rawCommand
	};
	const command = resolveSystemRunCommand({
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
		planV2: null,
		argv: command.argv,
		cwd: normalizeString(params.cwd),
		agentId: normalizeString(params.agentId),
		sessionKey: normalizeString(params.sessionKey),
		rawCommand: normalizeString(params.rawCommand)
	};
}

//#endregion
export { matchSystemRunApprovalBindingV1 as a, buildSystemRunApprovalBindingV1 as i, resolveSystemRunApprovalRequestContext as n, missingSystemRunApprovalBindingV1 as o, resolveSystemRunApprovalRuntimeContext as r, toSystemRunApprovalMismatchError as s, parsePreparedSystemRunPayload as t };