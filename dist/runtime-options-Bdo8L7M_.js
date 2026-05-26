import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { a as sanitizeTaskStatusText } from "./task-status-BvwcU8qI.js";
import { a as validateRuntimeConfigOptionInput, c as validateRuntimeModelInput, i as parseRuntimeTimeoutSecondsInput, l as validateRuntimePermissionProfileInput, o as validateRuntimeCwdInput, s as validateRuntimeModeInput, t as getAcpSessionManager } from "./manager-CnO_4PJM.js";
import { r as findLatestTaskForRelatedSessionKeyForOwner } from "./task-owner-access-MrVYMLx_.js";
import { C as stopWithText, _ as parseSingleValueCommandInput, a as ACP_PERMISSIONS_USAGE, c as ACP_SET_MODE_USAGE, g as parseSetCommandInput, h as parseOptionalSingleTarget, i as ACP_MODEL_USAGE, l as ACP_STATUS_USAGE, m as formatRuntimeOptionsText, o as ACP_RESET_OPTIONS_USAGE, p as formatAcpCapabilitiesText, t as ACP_CWD_USAGE, u as ACP_TIMEOUT_USAGE, w as withAcpCommandErrorBoundary } from "./shared-CALYaGy9.js";
import { i as resolveAcpSessionIdentifierLinesFromIdentity } from "./session-identifiers-CYNMp_8N.js";
import { t as resolveAcpTargetSessionKey } from "./targets-DpDfVVdw.js";
//#region src/auto-reply/reply/commands-acp/runtime-options.ts
async function resolveTargetSessionKeyOrStop(params) {
	const target = await resolveAcpTargetSessionKey({
		commandParams: params.commandParams,
		token: params.token
	});
	if (!target.ok) return stopWithText(`⚠️ ${target.error}`);
	return target.sessionKey;
}
async function resolveOptionalSingleTargetOrStop(params) {
	const parsed = parseOptionalSingleTarget(params.restTokens, params.usage);
	if (!parsed.ok) return stopWithText(`⚠️ ${parsed.error}`);
	return await resolveTargetSessionKeyOrStop({
		commandParams: params.commandParams,
		token: parsed.sessionToken
	});
}
async function resolveSingleTargetValueOrStop(params) {
	const parsed = parseSingleValueCommandInput(params.restTokens, params.usage);
	if (!parsed.ok) return stopWithText(`⚠️ ${parsed.error}`);
	const targetSessionKey = await resolveTargetSessionKeyOrStop({
		commandParams: params.commandParams,
		token: parsed.value.sessionToken
	});
	if (typeof targetSessionKey !== "string") return targetSessionKey;
	return {
		targetSessionKey,
		value: parsed.value.value
	};
}
async function withSingleTargetValue(params) {
	const resolved = await resolveSingleTargetValueOrStop({
		commandParams: params.commandParams,
		restTokens: params.restTokens,
		usage: params.usage
	});
	if (!("targetSessionKey" in resolved)) return resolved;
	return await params.run(resolved);
}
async function handleAcpStatusAction(params, restTokens) {
	const targetSessionKey = await resolveOptionalSingleTargetOrStop({
		commandParams: params,
		restTokens,
		usage: ACP_STATUS_USAGE
	});
	if (typeof targetSessionKey !== "string") return targetSessionKey;
	return await withAcpCommandErrorBoundary({
		run: async () => await getAcpSessionManager().getSessionStatus({
			cfg: params.cfg,
			sessionKey: targetSessionKey
		}),
		fallbackCode: "ACP_TURN_FAILED",
		fallbackMessage: "Could not read ACP session status.",
		onSuccess: (status) => {
			const linkedTask = findLatestTaskForRelatedSessionKeyForOwner({
				relatedSessionKey: status.sessionKey,
				callerOwnerKey: params.sessionKey
			});
			const sessionIdentifierLines = resolveAcpSessionIdentifierLinesFromIdentity({
				backend: status.backend,
				identity: status.identity
			});
			const taskProgress = sanitizeTaskStatusText(linkedTask?.progressSummary);
			const taskSummary = sanitizeTaskStatusText(linkedTask?.terminalSummary, { errorContext: true });
			const taskError = sanitizeTaskStatusText(linkedTask?.error, { errorContext: true });
			const lastError = sanitizeTaskStatusText(status.lastError, { errorContext: true });
			const runtimeSummary = sanitizeTaskStatusText(status.runtimeStatus?.summary, { errorContext: true });
			const runtimeDetails = sanitizeTaskStatusText(status.runtimeStatus?.details, { errorContext: true });
			return stopWithText([
				"ACP status:",
				"-----",
				`session: ${status.sessionKey}`,
				`backend: ${status.backend}`,
				`agent: ${status.agent}`,
				...sessionIdentifierLines,
				`sessionMode: ${status.mode}`,
				`state: ${status.state}`,
				...linkedTask ? [
					`taskId: ${linkedTask.taskId}`,
					`taskStatus: ${linkedTask.status}`,
					`delivery: ${linkedTask.deliveryStatus}`,
					...taskProgress ? [`taskProgress: ${taskProgress}`] : [],
					...taskSummary ? [`taskSummary: ${taskSummary}`] : [],
					...taskError ? [`taskError: ${taskError}`] : [],
					...typeof linkedTask.lastEventAt === "number" ? [`taskUpdatedAt: ${new Date(linkedTask.lastEventAt).toISOString()}`] : []
				] : [],
				`runtimeOptions: ${formatRuntimeOptionsText(status.runtimeOptions)}`,
				`capabilities: ${formatAcpCapabilitiesText(status.capabilities.controls)}`,
				`lastActivityAt: ${new Date(status.lastActivityAt).toISOString()}`,
				...lastError ? [`lastError: ${lastError}`] : [],
				...runtimeSummary ? [`runtime: ${runtimeSummary}`] : [],
				...runtimeDetails ? [`runtimeDetails: ${runtimeDetails}`] : []
			].join("\n"));
		}
	});
}
async function handleAcpSetModeAction(params, restTokens) {
	return await withSingleTargetValue({
		commandParams: params,
		restTokens,
		usage: ACP_SET_MODE_USAGE,
		run: async ({ targetSessionKey, value }) => await withAcpCommandErrorBoundary({
			run: async () => {
				const runtimeMode = validateRuntimeModeInput(value);
				return {
					runtimeMode,
					options: await getAcpSessionManager().setSessionRuntimeMode({
						cfg: params.cfg,
						sessionKey: targetSessionKey,
						runtimeMode
					})
				};
			},
			fallbackCode: "ACP_TURN_FAILED",
			fallbackMessage: "Could not update ACP runtime mode.",
			onSuccess: ({ runtimeMode, options }) => stopWithText(`✅ Updated ACP runtime mode for ${targetSessionKey}: ${runtimeMode}. Effective options: ${formatRuntimeOptionsText(options)}`)
		})
	});
}
async function handleAcpSetAction(params, restTokens) {
	const parsed = parseSetCommandInput(restTokens);
	if (!parsed.ok) return stopWithText(`⚠️ ${parsed.error}`);
	const target = await resolveAcpTargetSessionKey({
		commandParams: params,
		token: parsed.value.sessionToken
	});
	if (!target.ok) return stopWithText(`⚠️ ${target.error}`);
	const key = parsed.value.key.trim();
	const value = parsed.value.value.trim();
	return await withAcpCommandErrorBoundary({
		run: async () => {
			if (normalizeLowercaseStringOrEmpty(key) === "cwd") {
				const cwd = validateRuntimeCwdInput(value);
				const options = await getAcpSessionManager().updateSessionRuntimeOptions({
					cfg: params.cfg,
					sessionKey: target.sessionKey,
					patch: { cwd }
				});
				return { text: `✅ Updated ACP cwd for ${target.sessionKey}: ${cwd}. Effective options: ${formatRuntimeOptionsText(options)}` };
			}
			const validated = validateRuntimeConfigOptionInput(key, value);
			const options = await getAcpSessionManager().setSessionConfigOption({
				cfg: params.cfg,
				sessionKey: target.sessionKey,
				key: validated.key,
				value: validated.value
			});
			return { text: `✅ Updated ACP config option for ${target.sessionKey}: ${validated.key}=${validated.value}. Effective options: ${formatRuntimeOptionsText(options)}` };
		},
		fallbackCode: "ACP_TURN_FAILED",
		fallbackMessage: "Could not update ACP config option.",
		onSuccess: ({ text }) => stopWithText(text)
	});
}
async function handleAcpCwdAction(params, restTokens) {
	return await withSingleTargetValue({
		commandParams: params,
		restTokens,
		usage: ACP_CWD_USAGE,
		run: async ({ targetSessionKey, value }) => await withAcpCommandErrorBoundary({
			run: async () => {
				const cwd = validateRuntimeCwdInput(value);
				return {
					cwd,
					options: await getAcpSessionManager().updateSessionRuntimeOptions({
						cfg: params.cfg,
						sessionKey: targetSessionKey,
						patch: { cwd }
					})
				};
			},
			fallbackCode: "ACP_TURN_FAILED",
			fallbackMessage: "Could not update ACP cwd.",
			onSuccess: ({ cwd, options }) => stopWithText(`✅ Updated ACP cwd for ${targetSessionKey}: ${cwd}. Effective options: ${formatRuntimeOptionsText(options)}`)
		})
	});
}
async function handleAcpPermissionsAction(params, restTokens) {
	return await withSingleTargetValue({
		commandParams: params,
		restTokens,
		usage: ACP_PERMISSIONS_USAGE,
		run: async ({ targetSessionKey, value }) => await withAcpCommandErrorBoundary({
			run: async () => {
				const permissionProfile = validateRuntimePermissionProfileInput(value);
				return {
					permissionProfile,
					options: await getAcpSessionManager().setSessionConfigOption({
						cfg: params.cfg,
						sessionKey: targetSessionKey,
						key: "approval_policy",
						value: permissionProfile
					})
				};
			},
			fallbackCode: "ACP_TURN_FAILED",
			fallbackMessage: "Could not update ACP permissions profile.",
			onSuccess: ({ permissionProfile, options }) => stopWithText(`✅ Updated ACP permissions profile for ${targetSessionKey}: ${permissionProfile}. Effective options: ${formatRuntimeOptionsText(options)}`)
		})
	});
}
async function handleAcpTimeoutAction(params, restTokens) {
	return await withSingleTargetValue({
		commandParams: params,
		restTokens,
		usage: ACP_TIMEOUT_USAGE,
		run: async ({ targetSessionKey, value }) => await withAcpCommandErrorBoundary({
			run: async () => {
				const timeoutSeconds = parseRuntimeTimeoutSecondsInput(value);
				return {
					timeoutSeconds,
					options: await getAcpSessionManager().setSessionConfigOption({
						cfg: params.cfg,
						sessionKey: targetSessionKey,
						key: "timeout",
						value: String(timeoutSeconds)
					})
				};
			},
			fallbackCode: "ACP_TURN_FAILED",
			fallbackMessage: "Could not update ACP timeout.",
			onSuccess: ({ timeoutSeconds, options }) => stopWithText(`✅ Updated ACP timeout for ${targetSessionKey}: ${timeoutSeconds}s. Effective options: ${formatRuntimeOptionsText(options)}`)
		})
	});
}
async function handleAcpModelAction(params, restTokens) {
	return await withSingleTargetValue({
		commandParams: params,
		restTokens,
		usage: ACP_MODEL_USAGE,
		run: async ({ targetSessionKey, value }) => await withAcpCommandErrorBoundary({
			run: async () => {
				const model = validateRuntimeModelInput(value);
				return {
					model,
					options: await getAcpSessionManager().setSessionConfigOption({
						cfg: params.cfg,
						sessionKey: targetSessionKey,
						key: "model",
						value: model
					})
				};
			},
			fallbackCode: "ACP_TURN_FAILED",
			fallbackMessage: "Could not update ACP model.",
			onSuccess: ({ model, options }) => stopWithText(`✅ Updated ACP model for ${targetSessionKey}: ${model}. Effective options: ${formatRuntimeOptionsText(options)}`)
		})
	});
}
async function handleAcpResetOptionsAction(params, restTokens) {
	const targetSessionKey = await resolveOptionalSingleTargetOrStop({
		commandParams: params,
		restTokens,
		usage: ACP_RESET_OPTIONS_USAGE
	});
	if (typeof targetSessionKey !== "string") return targetSessionKey;
	return await withAcpCommandErrorBoundary({
		run: async () => await getAcpSessionManager().resetSessionRuntimeOptions({
			cfg: params.cfg,
			sessionKey: targetSessionKey
		}),
		fallbackCode: "ACP_TURN_FAILED",
		fallbackMessage: "Could not reset ACP runtime options.",
		onSuccess: () => stopWithText(`✅ Reset ACP runtime options for ${targetSessionKey}.`)
	});
}
//#endregion
export { handleAcpCwdAction, handleAcpModelAction, handleAcpPermissionsAction, handleAcpResetOptionsAction, handleAcpSetAction, handleAcpSetModeAction, handleAcpStatusAction, handleAcpTimeoutAction };
