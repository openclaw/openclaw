import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { d as updateSessionStoreEntry } from "./store-BmtchQvp.js";
import { t as clearBootstrapSnapshot } from "./bootstrap-cache-ClkciH8b.js";
import { n as shouldHandleTextCommands } from "./commands-text-routing-C2SuW22t.js";
import "./commands-registry-Bthd8JBl.js";
import { t as clearAllCliSessions } from "./cli-session-FftCLDUT.js";
import { t as parseSoftResetCommand } from "./commands-reset-mode-CrHFTxVv.js";
import "./commands-context-CI74miNY.js";
import { t as isResetAuthorizedForContext } from "./reset-authorization-DyduhI7x.js";
import { r as resetConfiguredBindingTargetInPlace } from "./binding-targets-DimW-OV5.js";
import { n as resolveBoundAcpThreadSessionKey } from "./targets-DpDfVVdw.js";
import { t as emitResetCommandHooks } from "./commands-reset-hooks-DqGM2QkY.js";
import { t as buildStatusReply } from "./commands-status-DXkk1v-c.js";
//#region src/auto-reply/reply/commands-reset.ts
function applyAcpResetTailContext(ctx, resetTail) {
	const mutableCtx = ctx;
	mutableCtx.Body = resetTail;
	mutableCtx.RawBody = resetTail;
	mutableCtx.CommandBody = resetTail;
	mutableCtx.BodyForCommands = resetTail;
	mutableCtx.BodyForAgent = resetTail;
	mutableCtx.BodyStripped = resetTail;
	mutableCtx.AcpDispatchTailAfterReset = true;
}
function isResetAuthorized(params) {
	return isResetAuthorizedForContext({
		ctx: params.ctx,
		cfg: params.cfg,
		commandAuthorized: params.command.isAuthorizedSender || params.ctx.CommandAuthorized === true
	});
}
async function maybeHandleResetCommand(params) {
	const softReset = parseSoftResetCommand(params.command.commandBodyNormalized);
	if (softReset.matched) {
		if (!isResetAuthorized(params)) {
			logVerbose(`Ignoring /reset soft from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
			return { shouldContinue: false };
		}
		const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
		if (boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey) ? boundAcpSessionKey.trim() : void 0) return {
			shouldContinue: false,
			reply: { text: "Usage: /reset soft is not available for ACP-bound sessions yet." }
		};
		const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
		const previousSessionEntry = params.previousSessionEntry ?? (targetSessionEntry ? { ...targetSessionEntry } : void 0);
		if (targetSessionEntry) {
			const now = Date.now();
			clearAllCliSessions(targetSessionEntry);
			if (params.sessionEntry && params.sessionEntry !== targetSessionEntry) {
				clearAllCliSessions(params.sessionEntry);
				params.sessionEntry.updatedAt = now;
				params.sessionEntry.lastInteractionAt = now;
			}
			if (params.sessionKey) clearBootstrapSnapshot(params.sessionKey);
			targetSessionEntry.updatedAt = now;
			targetSessionEntry.lastInteractionAt = now;
			if (params.sessionStore && params.sessionKey) params.sessionStore[params.sessionKey] = targetSessionEntry;
			if (params.storePath && params.sessionKey) await updateSessionStoreEntry({
				storePath: params.storePath,
				sessionKey: params.sessionKey,
				update: async (entry) => {
					const next = { ...entry };
					clearAllCliSessions(next);
					return {
						cliSessionBindings: next.cliSessionBindings,
						cliSessionIds: next.cliSessionIds,
						claudeCliSessionId: next.claudeCliSessionId,
						updatedAt: now,
						lastInteractionAt: now
					};
				}
			});
		}
		await emitResetCommandHooks({
			action: "reset",
			ctx: params.ctx,
			cfg: params.cfg,
			command: params.command,
			sessionKey: params.sessionKey,
			sessionEntry: targetSessionEntry,
			previousSessionEntry,
			workspaceDir: params.workspaceDir
		});
		params.command.softResetTriggered = true;
		params.command.softResetTail = softReset.tail;
		return null;
	}
	const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
	if (!resetMatch) return null;
	if (!isResetAuthorized(params)) {
		logVerbose(`Ignoring /reset from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const commandAction = resetMatch[1] === "reset" ? "reset" : "new";
	const resetTail = params.command.commandBodyNormalized.slice(resetMatch[0].length).trimStart();
	const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
	const boundAcpKey = boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey) ? boundAcpSessionKey.trim() : void 0;
	if (boundAcpKey) {
		const resetResult = await resetConfiguredBindingTargetInPlace({
			cfg: params.cfg,
			sessionKey: boundAcpKey,
			reason: commandAction,
			commandSource: `${params.command.surface}:${params.ctx.CommandSource ?? "text"}`
		});
		if (!resetResult.ok) logVerbose(`acp reset failed for ${boundAcpKey}: ${resetResult.error ?? "unknown error"}`);
		if (resetResult.ok) {
			params.command.resetHookTriggered = true;
			if (resetTail) {
				applyAcpResetTailContext(params.ctx, resetTail);
				if (params.rootCtx && params.rootCtx !== params.ctx) applyAcpResetTailContext(params.rootCtx, resetTail);
				return { shouldContinue: false };
			}
			return {
				shouldContinue: false,
				reply: { text: "✅ ACP session reset in place." }
			};
		}
		return {
			shouldContinue: false,
			reply: { text: "⚠️ ACP session reset failed. Check /acp status and try again." }
		};
	}
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	const hookResult = await emitResetCommandHooks({
		action: commandAction,
		ctx: params.ctx,
		cfg: params.cfg,
		command: params.command,
		sessionKey: params.sessionKey,
		sessionEntry: targetSessionEntry,
		previousSessionEntry: params.previousSessionEntry,
		workspaceDir: params.workspaceDir
	});
	if (!resetTail) return {
		shouldContinue: false,
		...hookResult.routedReply ? {} : { reply: { text: commandAction === "reset" ? "✅ Session reset." : "✅ New session started." } }
	};
	return null;
}
//#endregion
//#region src/auto-reply/reply/commands-core.ts
const commandHandlersRuntimeLoader = createLazyImportLoader(() => import("./commands-handlers.runtime.js"));
function loadCommandHandlersRuntime() {
	return commandHandlersRuntimeLoader.load();
}
let HANDLERS = null;
function normalizeCommandHandlerResult(result) {
	if (!result.reply) return result;
	return {
		...result,
		reply: {
			...result.reply,
			replyToId: void 0,
			replyToCurrent: false
		}
	};
}
async function handleCommands(params) {
	if (HANDLERS === null) HANDLERS = (await loadCommandHandlersRuntime()).loadCommandHandlers();
	const resetResult = await maybeHandleResetCommand(params);
	if (resetResult) return normalizeCommandHandlerResult(resetResult);
	const allowTextCommands = shouldHandleTextCommands({
		cfg: params.cfg,
		surface: params.command.surface,
		commandSource: params.ctx.CommandSource
	});
	for (const handler of HANDLERS) {
		const result = await handler(params, allowTextCommands);
		if (result) return normalizeCommandHandlerResult(result);
	}
	return { shouldContinue: true };
}
//#endregion
export { buildStatusReply, handleCommands };
