import crypto from "node:crypto";
//#region extensions/voice-call/src/response-generator.ts
/**
* Voice call response generator - uses the embedded Pi agent for tool support.
* Routes voice responses through the same agent infrastructure as messaging.
*/
/**
* Generate a voice response using the embedded Pi agent with full tool support.
* Uses the same agent infrastructure as messaging for consistent behavior.
*/
async function generateVoiceResponse(params) {
	const { voiceConfig, callId, from, transcript, userMessage, coreConfig, agentRuntime } = params;
	if (!coreConfig) {return {
		text: null,
		error: "Core config unavailable for voice response"
	};}
	const cfg = coreConfig;
	const sessionKey = `voice:${from.replace(/\D/g, "")}`;
	const agentId = "main";
	const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, { agentId });
	const agentDir = agentRuntime.resolveAgentDir(cfg, agentId);
	const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);
	await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });
	const sessionStore = agentRuntime.session.loadSessionStore(storePath);
	const now = Date.now();
	let sessionEntry = sessionStore[sessionKey];
	if (!sessionEntry) {
		sessionEntry = {
			sessionId: crypto.randomUUID(),
			updatedAt: now
		};
		sessionStore[sessionKey] = sessionEntry;
		await agentRuntime.session.saveSessionStore(storePath, sessionStore);
	}
	const sessionId = sessionEntry.sessionId;
	const sessionFile = agentRuntime.session.resolveSessionFilePath(sessionId, sessionEntry, { agentId });
	const modelRef = voiceConfig.responseModel || `${agentRuntime.defaults.provider}/${agentRuntime.defaults.model}`;
	const slashIndex = modelRef.indexOf("/");
	const provider = slashIndex === -1 ? agentRuntime.defaults.provider : modelRef.slice(0, slashIndex);
	const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);
	const thinkLevel = agentRuntime.resolveThinkingDefault({
		cfg,
		provider,
		model
	});
	const agentName = agentRuntime.resolveAgentIdentity(cfg, agentId)?.name?.trim() || "assistant";
	const basePrompt = voiceConfig.responseSystemPrompt ?? `You are ${agentName}, a helpful voice assistant on a phone call. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. The caller's phone number is ${from}. You have access to tools - use them when helpful.`;
	let extraSystemPrompt = basePrompt;
	if (transcript.length > 0) {extraSystemPrompt = `${basePrompt}\n\nConversation so far:\n${transcript.map((entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`).join("\n")}`;}
	const timeoutMs = voiceConfig.responseTimeoutMs ?? agentRuntime.resolveAgentTimeoutMs({ cfg });
	const runId = `voice:${callId}:${Date.now()}`;
	try {
		const result = await agentRuntime.runEmbeddedPiAgent({
			sessionId,
			sessionKey,
			messageProvider: "voice",
			sessionFile,
			workspaceDir,
			config: cfg,
			prompt: userMessage,
			provider,
			model,
			thinkLevel,
			verboseLevel: "off",
			timeoutMs,
			runId,
			lane: "voice",
			extraSystemPrompt,
			agentDir
		});
		const text = (result.payloads ?? []).filter((p) => p.text && !p.isError).map((p) => p.text?.trim()).filter(Boolean).join(" ") || null;
		if (!text && result.meta?.aborted) {return {
			text: null,
			error: "Response generation was aborted"
		};}
		return { text };
	} catch (err) {
		console.error(`[voice-call] Response generation failed:`, err);
		return {
			text: null,
			error: String(err)
		};
	}
}
//#endregion
export { generateVoiceResponse };
