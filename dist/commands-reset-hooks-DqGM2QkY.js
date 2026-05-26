import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-DpfQDjis.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/auto-reply/reply/commands-reset-hooks.ts
const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));
function loadRouteReplyRuntime() {
	return routeReplyRuntimeLoader.load();
}
function parseTranscriptMessages(content) {
	const messages = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message) messages.push(entry.message);
		} catch {}
	}
	return messages;
}
async function findLatestArchivedTranscript(sessionFile) {
	try {
		const dir = path.dirname(sessionFile);
		const resetPrefix = `${path.basename(sessionFile)}.reset.`;
		const archived = (await fs.readdir(dir)).filter((name) => name.startsWith(resetPrefix)).toSorted();
		const latest = archived[archived.length - 1];
		return latest ? path.join(dir, latest) : void 0;
	} catch {
		return;
	}
}
async function loadBeforeResetTranscript(params) {
	const sessionFile = params.sessionFile;
	if (!sessionFile) {
		logVerbose("before_reset: no session file available, firing hook with empty messages");
		return {
			sessionFile,
			messages: []
		};
	}
	try {
		return {
			sessionFile,
			messages: parseTranscriptMessages(await fs.readFile(sessionFile, "utf-8"))
		};
	} catch (err) {
		if (err?.code !== "ENOENT") {
			logVerbose(`before_reset: failed to read session file ${sessionFile}; firing hook with empty messages (${String(err)})`);
			return {
				sessionFile,
				messages: []
			};
		}
	}
	const archivedSessionFile = await findLatestArchivedTranscript(sessionFile);
	if (!archivedSessionFile) {
		logVerbose(`before_reset: failed to find archived transcript for ${sessionFile}; firing hook with empty messages`);
		return {
			sessionFile,
			messages: []
		};
	}
	try {
		return {
			sessionFile: archivedSessionFile,
			messages: parseTranscriptMessages(await fs.readFile(archivedSessionFile, "utf-8"))
		};
	} catch (err) {
		logVerbose(`before_reset: failed to read archived session file ${archivedSessionFile}; firing hook with empty messages (${String(err)})`);
		return {
			sessionFile: archivedSessionFile,
			messages: []
		};
	}
}
async function emitResetCommandHooks(params) {
	const hookEvent = createInternalHookEvent("command", params.action, params.sessionKey ?? "", {
		sessionEntry: params.sessionEntry,
		previousSessionEntry: params.previousSessionEntry,
		commandSource: params.command.surface,
		senderId: params.command.senderId,
		workspaceDir: params.workspaceDir,
		cfg: params.cfg
	});
	await triggerInternalHook(hookEvent);
	params.command.resetHookTriggered = true;
	let routedReply = false;
	if (hookEvent.messages.length > 0) {
		const channel = params.ctx.OriginatingChannel || params.command.channel;
		const to = params.ctx.OriginatingTo || params.command.from || params.command.to;
		if (channel && to) {
			const { routeReply } = await loadRouteReplyRuntime();
			await routeReply({
				payload: { text: hookEvent.messages.join("\n\n") },
				channel,
				to,
				sessionKey: params.sessionKey,
				accountId: params.ctx.AccountId,
				requesterSenderId: params.command.senderId,
				requesterSenderName: params.ctx.SenderName,
				requesterSenderUsername: params.ctx.SenderUsername,
				requesterSenderE164: params.ctx.SenderE164,
				threadId: params.ctx.MessageThreadId,
				cfg: params.cfg
			});
			routedReply = true;
		}
	}
	const hookRunner = getGlobalHookRunner();
	if (hookRunner?.hasHooks("before_reset")) {
		const prevEntry = params.previousSessionEntry;
		(async () => {
			const { sessionFile, messages } = await loadBeforeResetTranscript({ sessionFile: prevEntry?.sessionFile });
			try {
				await hookRunner.runBeforeReset({
					sessionFile,
					messages,
					reason: params.action
				}, {
					agentId: resolveAgentIdFromSessionKey(params.sessionKey),
					sessionKey: params.sessionKey,
					sessionId: prevEntry?.sessionId,
					workspaceDir: params.workspaceDir
				});
			} catch (err) {
				logVerbose(`before_reset hook failed: ${String(err)}`);
			}
		})();
	}
	return { routedReply };
}
//#endregion
export { emitResetCommandHooks as t };
