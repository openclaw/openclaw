import { d as buildRealtimeVoiceAgentConsultPrompt, p as collectRealtimeVoiceAgentConsultVisibleText } from "./session-runtime-B3oRoije.js";
import { randomUUID } from "node:crypto";
//#region src/realtime-voice/agent-consult-runtime.ts
function resolveRealtimeVoiceAgentSandboxSessionKey(agentId, sessionKey) {
	const trimmed = sessionKey.trim();
	if (trimmed.toLowerCase().startsWith("agent:")) return trimmed;
	return `agent:${agentId}:${trimmed}`;
}
async function consultRealtimeVoiceAgent(params) {
	const agentId = params.agentId ?? "main";
	const agentDir = params.agentRuntime.resolveAgentDir(params.cfg, agentId);
	const workspaceDir = params.agentRuntime.resolveAgentWorkspaceDir(params.cfg, agentId);
	await params.agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });
	const storePath = params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, { agentId });
	const now = Date.now();
	const sessionEntry = await params.agentRuntime.session.updateSessionStore(storePath, (store) => {
		const existing = store[params.sessionKey];
		const sessionId = existing?.sessionId?.trim() || randomUUID();
		const next = {
			...existing,
			sessionId,
			updatedAt: now
		};
		store[params.sessionKey] = next;
		return next;
	});
	const sessionId = sessionEntry.sessionId;
	const sessionFile = params.agentRuntime.session.resolveSessionFilePath(sessionId, sessionEntry, { agentId });
	const result = await params.agentRuntime.runEmbeddedPiAgent({
		sessionId,
		sessionKey: params.sessionKey,
		sandboxSessionKey: resolveRealtimeVoiceAgentSandboxSessionKey(agentId, params.sessionKey),
		agentId,
		messageProvider: params.messageProvider,
		sessionFile,
		workspaceDir,
		config: params.cfg,
		prompt: buildRealtimeVoiceAgentConsultPrompt({
			args: params.args,
			transcript: params.transcript,
			surface: params.surface,
			userLabel: params.userLabel,
			assistantLabel: params.assistantLabel,
			questionSourceLabel: params.questionSourceLabel
		}),
		provider: params.provider,
		model: params.model,
		thinkLevel: params.thinkLevel ?? "high",
		verboseLevel: "off",
		reasoningLevel: "off",
		toolResultFormat: "plain",
		toolsAllow: params.toolsAllow,
		timeoutMs: params.timeoutMs ?? params.agentRuntime.resolveAgentTimeoutMs({ cfg: params.cfg }),
		runId: `${params.runIdPrefix}:${Date.now()}`,
		lane: params.lane,
		extraSystemPrompt: params.extraSystemPrompt ?? "You are a behind-the-scenes consultant for a live voice agent. Be accurate, brief, and speakable.",
		agentDir
	});
	const text = collectRealtimeVoiceAgentConsultVisibleText(result.payloads ?? []);
	if (!text) {
		const reason = result.meta?.aborted ? "agent run aborted" : "agent returned no speakable text";
		params.logger.warn(`[realtime-voice] agent consult produced no answer: ${reason}`);
		return { text: params.fallbackText ?? "I need a moment to verify that before answering." };
	}
	return { text };
}
//#endregion
//#region src/realtime-voice/audio-codec.ts
const TELEPHONY_SAMPLE_RATE = 8e3;
const RESAMPLE_FILTER_TAPS = 31;
const RESAMPLE_CUTOFF_GUARD = .94;
function clamp16(value) {
	return Math.max(-32768, Math.min(32767, value));
}
function sinc(x) {
	if (x === 0) return 1;
	return Math.sin(Math.PI * x) / (Math.PI * x);
}
function sampleBandlimited(input, inputSamples, srcPos, cutoffCyclesPerSample) {
	const half = Math.floor(RESAMPLE_FILTER_TAPS / 2);
	const center = Math.floor(srcPos);
	let weighted = 0;
	let weightSum = 0;
	for (let tap = -half; tap <= half; tap += 1) {
		const sampleIndex = center + tap;
		if (sampleIndex < 0 || sampleIndex >= inputSamples) continue;
		const distance = sampleIndex - srcPos;
		const lowPass = 2 * cutoffCyclesPerSample * sinc(2 * cutoffCyclesPerSample * distance);
		const tapIndex = tap + half;
		const coeff = lowPass * (.5 - .5 * Math.cos(2 * Math.PI * tapIndex / (RESAMPLE_FILTER_TAPS - 1)));
		weighted += input.readInt16LE(sampleIndex * 2) * coeff;
		weightSum += coeff;
	}
	if (weightSum === 0) {
		const nearest = Math.max(0, Math.min(inputSamples - 1, Math.round(srcPos)));
		return input.readInt16LE(nearest * 2);
	}
	return weighted / weightSum;
}
function resamplePcm(input, inputSampleRate, outputSampleRate) {
	if (inputSampleRate === outputSampleRate) return input;
	const inputSamples = Math.floor(input.length / 2);
	if (inputSamples === 0) return Buffer.alloc(0);
	const ratio = inputSampleRate / outputSampleRate;
	const outputSamples = Math.floor(inputSamples / ratio);
	const output = Buffer.alloc(outputSamples * 2);
	const maxCutoff = .5;
	const downsampleCutoff = ratio > 1 ? maxCutoff / ratio : maxCutoff;
	const cutoffCyclesPerSample = Math.max(.01, downsampleCutoff * RESAMPLE_CUTOFF_GUARD);
	for (let i = 0; i < outputSamples; i += 1) {
		const sample = Math.round(sampleBandlimited(input, inputSamples, i * ratio, cutoffCyclesPerSample));
		output.writeInt16LE(clamp16(sample), i * 2);
	}
	return output;
}
function resamplePcmTo8k(input, inputSampleRate) {
	return resamplePcm(input, inputSampleRate, TELEPHONY_SAMPLE_RATE);
}
function pcmToMulaw(pcm) {
	const samples = Math.floor(pcm.length / 2);
	const mulaw = Buffer.alloc(samples);
	for (let i = 0; i < samples; i += 1) mulaw[i] = linearToMulaw(pcm.readInt16LE(i * 2));
	return mulaw;
}
function mulawToPcm(mulaw) {
	const pcm = Buffer.alloc(mulaw.length * 2);
	for (let i = 0; i < mulaw.length; i += 1) pcm.writeInt16LE(clamp16(mulawToLinear(mulaw[i] ?? 0)), i * 2);
	return pcm;
}
function convertPcmToMulaw8k(pcm, inputSampleRate) {
	return pcmToMulaw(resamplePcmTo8k(pcm, inputSampleRate));
}
function linearToMulaw(sample) {
	const BIAS = 132;
	const CLIP = 32635;
	const sign = sample < 0 ? 128 : 0;
	if (sample < 0) sample = -sample;
	if (sample > CLIP) sample = CLIP;
	sample += BIAS;
	let exponent = 7;
	for (let expMask = 16384; (sample & expMask) === 0 && exponent > 0; exponent -= 1) expMask >>= 1;
	const mantissa = sample >> exponent + 3 & 15;
	return ~(sign | exponent << 4 | mantissa) & 255;
}
function mulawToLinear(value) {
	const muLaw = ~value & 255;
	const sign = muLaw & 128;
	const exponent = muLaw >> 4 & 7;
	let sample = ((muLaw & 15) << 3) + 132 << exponent;
	sample -= 132;
	return sign ? -sample : sample;
}
//#endregion
export { resamplePcmTo8k as a, resamplePcm as i, mulawToPcm as n, consultRealtimeVoiceAgent as o, pcmToMulaw as r, convertPcmToMulaw8k as t };
