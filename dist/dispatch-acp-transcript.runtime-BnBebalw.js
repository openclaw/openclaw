import { p as resolveSessionAgentId } from "./agent-scope-C1Fl7gAf.js";
import { u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { s as resolveSessionStoreEntry, t as loadSessionStore } from "./store-load-cmAGD4uk.js";
import "./sessions-BhOk6siH.js";
import { n as resolveAcpSessionCwd } from "./session-identifiers-DHFGxli3.js";
import { o as persistAcpTurnTranscript } from "./attempt-execution-Bt2wFQmK.js";
//#region src/auto-reply/reply/dispatch-acp-transcript.runtime.ts
async function persistAcpDispatchTranscript(params) {
	const promptText = params.promptText.trim();
	const finalText = params.finalText.trim();
	if (!promptText && !finalText) return;
	const sessionAgentId = resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	});
	const storePath = resolveStorePath(params.cfg.session?.store, { agentId: sessionAgentId });
	const sessionStore = loadSessionStore(storePath, { skipCache: true });
	const sessionEntry = resolveSessionStoreEntry({
		store: sessionStore,
		sessionKey: params.sessionKey
	}).existing;
	const sessionId = sessionEntry?.sessionId;
	if (!sessionId) throw new Error(`unknown ACP session key: ${params.sessionKey}`);
	await persistAcpTurnTranscript({
		body: promptText,
		transcriptBody: promptText,
		finalText,
		sessionId,
		sessionKey: params.sessionKey,
		sessionEntry,
		sessionStore,
		storePath,
		sessionAgentId,
		threadId: params.threadId,
		sessionCwd: resolveAcpSessionCwd(params.meta) ?? process.cwd(),
		config: params.cfg
	});
}
//#endregion
export { persistAcpDispatchTranscript };
