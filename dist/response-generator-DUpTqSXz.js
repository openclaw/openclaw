import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as applyModelOverrideToSessionEntry } from "./model-overrides-CUnMI0Oj.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./model-session-runtime-B9_KVsJx.js";
import { o as resolveVoiceCallSessionKey } from "./config-Ct8zalEd.js";
import { t as resolveVoiceResponseModel } from "./response-model-Ci4XSDqB.js";
import crypto from "node:crypto";
//#region extensions/voice-call/src/response-generator.ts
/**
* Voice call response generator - uses the embedded Pi agent for tool support.
* Routes voice responses through the same agent infrastructure as messaging.
*/
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readExplicitToolsAllow(value) {
	if (!isRecord(value)) return;
	const allow = value.allow;
	if (!Array.isArray(allow)) return;
	return allow.filter((entry) => typeof entry === "string");
}
function resolveVoiceAgentToolsAllow(config, agentId) {
	const agents = isRecord(config.agents) ? config.agents : void 0;
	const agent = (Array.isArray(agents?.list) ? agents.list : []).find((entry) => isRecord(entry) && entry.id === agentId);
	if (!isRecord(agent)) return;
	return readExplicitToolsAllow(isRecord(agent.tools) ? agent.tools : void 0);
}
const VOICE_SPOKEN_OUTPUT_CONTRACT = [
	"Output format requirements:",
	"- Return only valid JSON in this exact shape: {\"spoken\":\"...\"}",
	"- Do not include markdown, code fences, planning text, or extra keys.",
	"- Put exactly what should be spoken to the caller into \"spoken\".",
	"- If there is nothing to say, return {\"spoken\":\"\"}."
].join("\n");
function normalizeSpokenText(value) {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : null;
}
function tryParseSpokenJson(text) {
	const candidates = [];
	const trimmed = text.trim();
	if (!trimmed) return null;
	candidates.push(trimmed);
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fenced?.[1]) candidates.push(fenced[1]);
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
	for (const candidate of candidates) try {
		const parsed = JSON.parse(candidate);
		if (typeof parsed?.spoken !== "string") continue;
		return normalizeSpokenText(parsed.spoken) ?? "";
	} catch {}
	const inlineSpokenMatch = trimmed.match(/"spoken"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
	if (!inlineSpokenMatch) return null;
	try {
		return normalizeSpokenText(JSON.parse(`"${inlineSpokenMatch[1] ?? ""}"`)) ?? "";
	} catch {
		return null;
	}
}
function isLikelyMetaReasoningParagraph(paragraph) {
	const lower = normalizeLowercaseStringOrEmpty(paragraph);
	if (!lower) return false;
	if (lower.startsWith("thinking process")) return true;
	if (lower.startsWith("reasoning:") || lower.startsWith("analysis:")) return true;
	if (lower.startsWith("the user ") && (lower.includes("i should") || lower.includes("i need to") || lower.includes("i will"))) return true;
	if (lower.includes("this is a natural continuation of the conversation") || lower.includes("keep the conversation flowing")) return true;
	return false;
}
function sanitizePlainSpokenText(text) {
	const withoutCodeFences = text.replace(/```[\s\S]*?```/g, " ").trim();
	if (!withoutCodeFences) return null;
	const paragraphs = withoutCodeFences.split(/\n\s*\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
	while (paragraphs.length > 1 && isLikelyMetaReasoningParagraph(paragraphs[0])) paragraphs.shift();
	return normalizeSpokenText(paragraphs.join(" "));
}
function extractSpokenTextFromPayloads(payloads) {
	const spokenSegments = [];
	for (const payload of payloads) {
		if (payload.isError || payload.isReasoning) continue;
		const rawText = payload.text?.trim() ?? "";
		if (!rawText) continue;
		const structured = tryParseSpokenJson(rawText);
		if (structured !== null) {
			if (structured.length > 0) spokenSegments.push(structured);
			continue;
		}
		const plain = sanitizePlainSpokenText(rawText);
		if (plain) spokenSegments.push(plain);
	}
	return spokenSegments.length > 0 ? spokenSegments.join(" ").trim() : null;
}
function resolveVoiceSandboxSessionKey(agentId, sessionKey) {
	const trimmed = sessionKey.trim();
	if (trimmed.toLowerCase().startsWith("agent:")) return trimmed;
	return `agent:${agentId}:${trimmed}`;
}
/**
* Generate a voice response using the embedded Pi agent with full tool support.
* Uses the same agent infrastructure as messaging for consistent behavior.
*/
async function generateVoiceResponse(params) {
	const { voiceConfig, callId, sessionKey, from, transcript, userMessage, coreConfig, agentRuntime } = params;
	if (!coreConfig) return {
		text: null,
		error: "Core config unavailable for voice response"
	};
	const cfg = coreConfig;
	const resolvedSessionKey = resolveVoiceCallSessionKey({
		config: voiceConfig,
		callId,
		phone: from,
		explicitSessionKey: sessionKey
	});
	const agentId = voiceConfig.agentId ?? "main";
	const toolsAllow = resolveVoiceAgentToolsAllow(cfg, agentId);
	const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, { agentId });
	const agentDir = agentRuntime.resolveAgentDir(cfg, agentId);
	const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);
	await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });
	const now = Date.now();
	const existingSessionEntry = agentRuntime.session.getSessionEntry({
		storePath,
		sessionKey: resolvedSessionKey
	});
	const { provider, model } = resolveVoiceResponseModel({
		voiceConfig,
		agentRuntime
	});
	let sessionEntry = existingSessionEntry;
	if (!sessionEntry?.sessionId || voiceConfig.responseModel) sessionEntry = await agentRuntime.session.patchSessionEntry({
		storePath,
		sessionKey: resolvedSessionKey,
		replaceEntry: true,
		fallbackEntry: sessionEntry ?? {
			sessionId: crypto.randomUUID(),
			updatedAt: now
		},
		update: (entry) => {
			const next = entry.sessionId ? { ...entry } : {
				...entry,
				sessionId: crypto.randomUUID(),
				updatedAt: now
			};
			if (voiceConfig.responseModel) applyModelOverrideToSessionEntry({
				entry: next,
				selection: {
					provider,
					model
				},
				selectionSource: "auto"
			});
			return next;
		}
	}) ?? void 0;
	if (!sessionEntry?.sessionId) return {
		text: null,
		error: "Voice response session could not be initialized"
	};
	const sessionId = sessionEntry.sessionId;
	const sessionFile = agentRuntime.session.resolveSessionFilePath(sessionId, sessionEntry, { agentId });
	const thinkLevel = agentRuntime.resolveThinkingDefault({
		cfg,
		provider,
		model
	});
	const agentName = agentRuntime.resolveAgentIdentity(cfg, agentId)?.name?.trim() || "assistant";
	const basePrompt = voiceConfig.responseSystemPrompt ?? `You are ${agentName}, a helpful voice assistant on a phone call. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. The caller's phone number is ${from}. You have access to tools - use them when helpful.`;
	let extraSystemPrompt = basePrompt;
	if (transcript.length > 0) extraSystemPrompt = `${basePrompt}\n\nConversation so far:\n${transcript.map((entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`).join("\n")}`;
	extraSystemPrompt = `${extraSystemPrompt}\n\n${VOICE_SPOKEN_OUTPUT_CONTRACT}`;
	const timeoutMs = voiceConfig.responseTimeoutMs ?? agentRuntime.resolveAgentTimeoutMs({ cfg });
	const runId = `voice:${callId}:${Date.now()}`;
	try {
		const result = await agentRuntime.runEmbeddedPiAgent({
			sessionId,
			sessionKey: resolvedSessionKey,
			sandboxSessionKey: resolveVoiceSandboxSessionKey(agentId, resolvedSessionKey),
			agentId,
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
			agentDir,
			toolsAllow
		});
		const text = extractSpokenTextFromPayloads(result.payloads ?? []);
		if (!text && result.meta?.aborted) return {
			text: null,
			error: "Response generation was aborted"
		};
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
