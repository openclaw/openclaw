import crypto from "node:crypto";
import { loadCoreAgentDeps } from "./core-bridge.js";
async function generateVoiceResponse(params) {
  const { voiceConfig, callId, from, transcript, userMessage, coreConfig } = params;
  if (!coreConfig) {
    return { text: null, error: "Core config unavailable for voice response" };
  }
  let deps;
  try {
    deps = await loadCoreAgentDeps();
  } catch (err) {
    return {
      text: null,
      error: err instanceof Error ? err.message : "Unable to load core agent dependencies"
    };
  }
  const cfg = coreConfig;
  const normalizedPhone = from.replace(/\D/g, "");
  const sessionKey = `voice:${normalizedPhone}`;
  const agentId = "main";
  const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = deps.resolveAgentDir(cfg, agentId);
  const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);
  await deps.ensureAgentWorkspace({ dir: workspaceDir });
  const sessionStore = deps.loadSessionStore(storePath);
  const now = Date.now();
  let sessionEntry = sessionStore[sessionKey];
  if (!sessionEntry) {
    sessionEntry = {
      sessionId: crypto.randomUUID(),
      updatedAt: now
    };
    sessionStore[sessionKey] = sessionEntry;
    await deps.saveSessionStore(storePath, sessionStore);
  }
  const sessionId = sessionEntry.sessionId;
  const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, {
    agentId
  });
  const modelRef = voiceConfig.responseModel || `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
  const slashIndex = modelRef.indexOf("/");
  const provider = slashIndex === -1 ? deps.DEFAULT_PROVIDER : modelRef.slice(0, slashIndex);
  const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);
  const thinkLevel = deps.resolveThinkingDefault({ cfg, provider, model });
  const identity = deps.resolveAgentIdentity(cfg, agentId);
  const agentName = identity?.name?.trim() || "assistant";
  const basePrompt = voiceConfig.responseSystemPrompt ?? `You are ${agentName}, a helpful voice assistant on a phone call. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. The caller's phone number is ${from}. You have access to tools - use them when helpful.`;
  let extraSystemPrompt = basePrompt;
  if (transcript.length > 0) {
    const history = transcript.map((entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`).join("\n");
    extraSystemPrompt = `${basePrompt}

Conversation so far:
${history}`;
  }
  const timeoutMs = voiceConfig.responseTimeoutMs ?? deps.resolveAgentTimeoutMs({ cfg });
  const runId = `voice:${callId}:${Date.now()}`;
  try {
    const result = await deps.runEmbeddedPiAgent({
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
    const texts = (result.payloads ?? []).filter((p) => p.text && !p.isError).map((p) => p.text?.trim()).filter(Boolean);
    const text = texts.join(" ") || null;
    if (!text && result.meta?.aborted) {
      return { text: null, error: "Response generation was aborted" };
    }
    return { text };
  } catch (err) {
    console.error(`[voice-call] Response generation failed:`, err);
    return { text: null, error: String(err) };
  }
}
export {
  generateVoiceResponse
};
