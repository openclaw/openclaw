import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { a as normalizeHostOverrideEnvVarKey } from "./host-env-security-66KkrZF_.js";
import { O as normalizeExecutableToken, _ as resolvePowerShellInlineCommandMatch, d as unwrapKnownShellMultiplexerInvocation, f as POSIX_INLINE_COMMAND_FLAGS, g as resolveInlineCommandMatch, h as isPowerShellInlineRestCommandFlag, i as extractShellWrapperCommand, o as hasEnvManipulationBeforeShellWrapper, x as unwrapDispatchWrappersForResolution } from "./shell-wrapper-resolution-CehhL5X5.js";
import "./risks-GkUMojAA.js";
import { m as mapAllowFromEntries } from "./channel-config-helpers-xZ4-bv2H.js";
import crypto from "node:crypto";
//#region src/infra/system-run-normalize.ts
function normalizeNonEmptyString(value) {
	return typeof value === "string" ? normalizeOptionalString(value) ?? null : null;
}
function normalizeStringArray(value) {
	return Array.isArray(value) ? mapAllowFromEntries(value) : [];
}
//#endregion
//#region src/infra/system-run-approval-binding.ts
function normalizeSystemRunApprovalFileOperand(value) {
	if (value === void 0) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value;
	const argvIndex = typeof candidate.argvIndex === "number" && Number.isInteger(candidate.argvIndex) && candidate.argvIndex >= 0 ? candidate.argvIndex : null;
	const filePath = normalizeNonEmptyString(candidate.path);
	const sha256 = normalizeNonEmptyString(candidate.sha256);
	if (argvIndex === null || !filePath || !sha256) return null;
	return {
		argvIndex,
		path: filePath,
		sha256
	};
}
function normalizeSystemRunApprovalPlan(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value;
	const argv = normalizeStringArray(candidate.argv);
	if (argv.length === 0) return null;
	const mutableFileOperand = normalizeSystemRunApprovalFileOperand(candidate.mutableFileOperand);
	if (candidate.mutableFileOperand !== void 0 && mutableFileOperand === null) return null;
	const commandText = normalizeNonEmptyString(candidate.commandText) ?? normalizeNonEmptyString(candidate.rawCommand);
	if (!commandText) return null;
	return {
		argv,
		cwd: normalizeNonEmptyString(candidate.cwd),
		commandText,
		commandPreview: normalizeNonEmptyString(candidate.commandPreview),
		agentId: normalizeNonEmptyString(candidate.agentId),
		sessionKey: normalizeNonEmptyString(candidate.sessionKey),
		mutableFileOperand: mutableFileOperand ?? void 0
	};
}
function normalizeSystemRunEnvEntries(env) {
	if (!env || typeof env !== "object" || Array.isArray(env)) return [];
	const entries = [];
	for (const [rawKey, rawValue] of Object.entries(env)) {
		if (typeof rawValue !== "string") continue;
		const key = normalizeHostOverrideEnvVarKey(rawKey);
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
function buildSystemRunApprovalBinding(params) {
	const envBinding = buildSystemRunApprovalEnvBinding(params.env);
	return {
		binding: {
			argv: normalizeStringArray(params.argv),
			cwd: normalizeNonEmptyString(params.cwd),
			agentId: normalizeNonEmptyString(params.agentId),
			sessionKey: normalizeNonEmptyString(params.sessionKey),
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
	if (!params.expectedEnvHash && !params.actualEnvHash && params.actualEnvKeys.length > 0) return {
		ok: false,
		code: "APPROVAL_ENV_BINDING_MISSING",
		message: "approval id missing env binding for requested env overrides",
		details: { envKeys: params.actualEnvKeys }
	};
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
function matchSystemRunApprovalBinding(params) {
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
function missingSystemRunApprovalBinding(params) {
	return requestMismatch({ envKeys: params.actualEnvKeys });
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
//#region src/infra/system-run-command.ts
function formatExecCommand(argv) {
	return argv.map((arg) => {
		if (arg.length === 0) return "\"\"";
		if (!/\s|"/.test(arg)) return arg;
		return `"${arg.replace(/"/g, "\\\"")}"`;
	}).join(" ");
}
const POSIX_OR_POWERSHELL_INLINE_WRAPPER_NAMES = new Set([
	"ash",
	"bash",
	"dash",
	"fish",
	"ksh",
	"powershell",
	"pwsh",
	"sh",
	"zsh"
]);
function unwrapShellWrapperArgv(argv) {
	const dispatchUnwrapped = unwrapDispatchWrappersForResolution(argv);
	const shellMultiplexer = unwrapKnownShellMultiplexerInvocation(dispatchUnwrapped);
	return shellMultiplexer.kind === "unwrapped" ? shellMultiplexer.argv : dispatchUnwrapped;
}
function hasTrailingPositionalArgvAfterInlineCommand(argv) {
	const wrapperArgv = unwrapShellWrapperArgv(argv);
	const token0 = wrapperArgv[0]?.trim();
	if (!token0) return false;
	const wrapper = normalizeExecutableToken(token0);
	if (!POSIX_OR_POWERSHELL_INLINE_WRAPPER_NAMES.has(wrapper)) return false;
	const inlineCommandIndex = wrapper === "powershell" || wrapper === "pwsh" ? resolvePowerShellInlineCommandMatch(wrapperArgv).valueTokenIndex : resolveInlineCommandMatch(wrapperArgv, POSIX_INLINE_COMMAND_FLAGS, { allowCombinedC: true }).valueTokenIndex;
	if (inlineCommandIndex === null) return false;
	if ((wrapper === "powershell" || wrapper === "pwsh") && isPowerShellInlineRestCommandFlag(wrapperArgv[inlineCommandIndex - 1] ?? "")) return false;
	return wrapperArgv.slice(inlineCommandIndex + 1).some((entry) => entry.trim().length > 0);
}
function buildSystemRunCommandDisplay(argv, rawCommand) {
	const rawlessShellWrapperResolution = extractShellWrapperCommand(argv);
	const shellWrapperResolution = rawlessShellWrapperResolution.command === null && rawCommand !== null ? extractShellWrapperCommand(argv, rawCommand) : rawlessShellWrapperResolution;
	const shellPayload = shellWrapperResolution.command;
	const shellWrapperPositionalArgv = hasTrailingPositionalArgvAfterInlineCommand(argv);
	const envManipulationBeforeShellWrapper = shellWrapperResolution.isWrapper && hasEnvManipulationBeforeShellWrapper(argv);
	return {
		shellPayload,
		commandText: formatExecCommand(argv),
		previewText: shellPayload !== null && !envManipulationBeforeShellWrapper && !shellWrapperPositionalArgv ? shellPayload.trim() : null
	};
}
function normalizeRawCommandText(rawCommand) {
	return typeof rawCommand === "string" && rawCommand.trim().length > 0 ? rawCommand.trim() : null;
}
function validateSystemRunCommandConsistency(params) {
	const raw = normalizeRawCommandText(params.rawCommand);
	const display = buildSystemRunCommandDisplay(params.argv, raw);
	if (raw) {
		const matchesCanonicalArgv = raw === display.commandText;
		const matchesLegacyShellText = params.allowLegacyShellText === true && display.previewText !== null && raw === display.previewText;
		if (!matchesCanonicalArgv && !matchesLegacyShellText) return {
			ok: false,
			message: "INVALID_REQUEST: rawCommand does not match command",
			details: {
				code: "RAW_COMMAND_MISMATCH",
				rawCommand: raw,
				inferred: display.commandText,
				formattedArgv: display.commandText
			}
		};
	}
	return {
		ok: true,
		shellPayload: display.shellPayload,
		commandText: display.commandText,
		previewText: display.previewText
	};
}
function resolveSystemRunCommandRequest(params) {
	return resolveSystemRunCommandWithMode(params, true);
}
function resolveSystemRunCommandWithMode(params, allowLegacyShellText) {
	const raw = normalizeRawCommandText(params.rawCommand);
	const command = Array.isArray(params.command) ? params.command : [];
	if (command.length === 0) {
		if (raw) return {
			ok: false,
			message: "rawCommand requires params.command",
			details: { code: "MISSING_COMMAND" }
		};
		return {
			ok: true,
			argv: [],
			commandText: "",
			shellPayload: null,
			previewText: null
		};
	}
	const argv = command.map((v) => String(v));
	const validation = validateSystemRunCommandConsistency({
		argv,
		rawCommand: raw,
		allowLegacyShellText
	});
	if (!validation.ok) return {
		ok: false,
		message: validation.message,
		details: validation.details ?? { code: "RAW_COMMAND_MISMATCH" }
	};
	return {
		ok: true,
		argv,
		commandText: validation.commandText,
		shellPayload: validation.shellPayload,
		previewText: validation.previewText
	};
}
//#endregion
export { matchSystemRunApprovalBinding as a, toSystemRunApprovalMismatchError as c, buildSystemRunApprovalEnvBinding as i, normalizeNonEmptyString as l, resolveSystemRunCommandRequest as n, missingSystemRunApprovalBinding as o, buildSystemRunApprovalBinding as r, normalizeSystemRunApprovalPlan as s, formatExecCommand as t, normalizeStringArray as u };
