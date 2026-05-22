import { t as createLazyImportLoader } from "./lazy-promise-B6on3yPt.js";
import { r as logVerbose } from "./globals-ZEce9oym.js";
import { a as requireGatewayClientScopeForInternalChannel } from "./command-gates-CYrfVWqU.js";
import { C as stopWithText, b as resolveAcpAction, d as COMMAND, x as resolveAcpHelpText } from "./shared-DknqxYow.js";
//#region src/auto-reply/reply/commands-acp.ts
const lifecycleHandlersLoader = createLazyImportLoader(() => import("./lifecycle-Dykeptoe.js"));
const runtimeOptionHandlersLoader = createLazyImportLoader(() => import("./runtime-options-Df9b1i5p.js"));
const diagnosticHandlersLoader = createLazyImportLoader(() => import("./diagnostics-t2udXqO7.js"));
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
		const scopeBlock = requireGatewayClientScopeForInternalChannel(params, {
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
