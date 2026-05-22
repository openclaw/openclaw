import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { r as logVerbose } from "./globals-DaPK6X5S.js";
import { a as requireGatewayClientScope } from "./command-gates-Blhjh9ot.js";
import { C as stopWithText, b as resolveAcpAction, d as COMMAND, x as resolveAcpHelpText } from "./shared-BypWniyl.js";
//#region src/auto-reply/reply/commands-acp.ts
const lifecycleHandlersLoader = createLazyImportLoader(() => import("./lifecycle-Qim_yMDo.js"));
const runtimeOptionHandlersLoader = createLazyImportLoader(() => import("./runtime-options-D1Bwv3-O.js"));
const diagnosticHandlersLoader = createLazyImportLoader(() => import("./diagnostics-DS_OLqVs.js"));
async function loadAcpActionHandler(action) {
	if (action === "spawn" || action === "cancel" || action === "steer" || action === "close") {
		const handlers = await lifecycleHandlersLoader.load();
		return {
			spawn: handlers.handleAcpSpawnAction,
			cancel: handlers.handleAcpCancelAction,
			steer: handlers.handleAcpSteerAction,
			close: handlers.handleAcpCloseAction
		}[action];
	}
	if (action === "status" || action === "set-mode" || action === "set" || action === "cwd" || action === "permissions" || action === "timeout" || action === "model" || action === "reset-options") {
		const handlers = await runtimeOptionHandlersLoader.load();
		return {
			status: handlers.handleAcpStatusAction,
			"set-mode": handlers.handleAcpSetModeAction,
			set: handlers.handleAcpSetAction,
			cwd: handlers.handleAcpCwdAction,
			permissions: handlers.handleAcpPermissionsAction,
			timeout: handlers.handleAcpTimeoutAction,
			model: handlers.handleAcpModelAction,
			"reset-options": handlers.handleAcpResetOptionsAction
		}[action];
	}
	const handlers = await diagnosticHandlersLoader.load();
	return {
		doctor: handlers.handleAcpDoctorAction,
		install: async (params, tokens) => handlers.handleAcpInstallAction(params, tokens),
		sessions: async (params, tokens) => handlers.handleAcpSessionsAction(params, tokens)
	}[action];
}
const ACP_MUTATING_ACTIONS = new Set([
	"spawn",
	"cancel",
	"steer",
	"close",
	"status",
	"set-mode",
	"set",
	"cwd",
	"permissions",
	"timeout",
	"model",
	"reset-options"
]);
const handleAcpCommand = async (params, _allowTextCommands) => {
	const normalized = params.command.commandBodyNormalized;
	if (!normalized.startsWith("/acp")) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /acp from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const tokens = normalized.slice(COMMAND.length).trim().split(/\s+/).filter(Boolean);
	const action = resolveAcpAction(tokens);
	if (action === "help") return stopWithText(resolveAcpHelpText());
	if (ACP_MUTATING_ACTIONS.has(action)) {
		const scopeBlock = requireGatewayClientScope(params, {
			label: "/acp",
			allowedScopes: ["operator.admin"],
			missingText: "This /acp action requires operator.admin on the internal channel."
		});
		if (scopeBlock) return scopeBlock;
	}
	return await (await loadAcpActionHandler(action))(params, tokens);
};
//#endregion
export { handleAcpCommand as t };
