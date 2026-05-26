import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { n as deliveryContextFromSession, o as normalizeDeliveryContext } from "./delivery-context.shared-CBmB9dF7.js";
import { O as parseSessionThreadInfoFast } from "./store-load-z4thf6ld.js";
import { n as resolveParentForkDecision, t as forkSessionFromParent } from "./session-fork-D_pWGD5e.js";
import { r as getActiveMemorySearchManager } from "./memory-runtime-DxsWIMOy.js";
import { f as buildRealtimeVoiceAgentConsultPrompt, g as parseRealtimeVoiceAgentConsultArgs, m as collectRealtimeVoiceAgentConsultVisibleText } from "./session-runtime-CCTSwqCz.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
let realtimeVoiceAgentConsultDeps = {
	randomUUID,
	resolveParentForkDecision,
	forkSessionFromParent
};
function resolveRealtimeVoiceAgentSandboxSessionKey(agentId, sessionKey) {
	const trimmed = sessionKey.trim();
	if (trimmed.toLowerCase().startsWith("agent:")) return trimmed;
	return `agent:${agentId}:${trimmed}`;
}
function hasRoutableDeliveryContext(context) {
	return Boolean(context?.channel && context?.to);
}
function resolveDeliverySessionFields(context) {
	const normalized = normalizeDeliveryContext(context);
	if (!normalized?.channel || !normalized.to) return {};
	return {
		deliveryContext: normalized,
		lastChannel: normalized.channel,
		lastTo: normalized.to,
		lastAccountId: normalized.accountId,
		lastThreadId: normalized.threadId
	};
}
function resolveRealtimeVoiceAgentDeliveryContext(params) {
	const requesterSessionKey = params.spawnedBy?.trim();
	try {
		const candidates = [];
		if (requesterSessionKey) {
			const { baseSessionKey } = parseSessionThreadInfoFast(requesterSessionKey);
			candidates.push(...[requesterSessionKey, baseSessionKey].filter((key) => Boolean(key)));
		}
		candidates.push(params.sessionKey);
		for (const key of candidates) {
			const context = deliveryContextFromSession(params.agentRuntime.session.getSessionEntry({
				storePath: params.storePath,
				sessionKey: key
			}));
			if (hasRoutableDeliveryContext(context)) return context;
		}
	} catch {}
}
async function resolveRealtimeVoiceAgentConsultSessionEntry(params) {
	const now = Date.now();
	const deliveryFields = resolveDeliverySessionFields(params.deliveryContext);
	const requesterSessionKey = params.spawnedBy?.trim();
	const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
	const shouldFork = params.contextMode === "fork" && requesterSessionKey && (!requesterAgentId || requesterAgentId === params.agentId);
	let forkDecisionWarning;
	const patched = await params.agentRuntime.session.patchSessionEntry({
		storePath: params.storePath,
		sessionKey: params.sessionKey,
		fallbackEntry: {
			sessionId: "",
			updatedAt: now
		},
		update: async (entry) => {
			if (entry.sessionId?.trim()) return {
				...deliveryFields,
				updatedAt: now
			};
			if (shouldFork) {
				const parentEntry = params.agentRuntime.session.getSessionEntry({
					storePath: params.storePath,
					sessionKey: requesterSessionKey
				});
				if (parentEntry?.sessionId?.trim()) {
					const decision = await realtimeVoiceAgentConsultDeps.resolveParentForkDecision({
						parentEntry,
						storePath: params.storePath
					});
					if (decision.status === "fork") {
						const fork = await realtimeVoiceAgentConsultDeps.forkSessionFromParent({
							parentEntry,
							agentId: params.agentId,
							sessionsDir: path.dirname(params.storePath)
						});
						if (fork) return {
							...deliveryFields,
							sessionId: fork.sessionId,
							sessionFile: fork.sessionFile,
							spawnedBy: requesterSessionKey,
							forkedFromParent: true,
							updatedAt: now
						};
					} else forkDecisionWarning = decision.message;
				}
			}
			return {
				...deliveryFields,
				sessionId: realtimeVoiceAgentConsultDeps.randomUUID(),
				...requesterSessionKey ? { spawnedBy: requesterSessionKey } : {},
				updatedAt: now
			};
		}
	});
	if (forkDecisionWarning) params.logger.warn(`[talk] ${forkDecisionWarning}`);
	if (patched?.sessionId?.trim()) return patched;
	throw new Error("realtime voice agent consult session could not be initialized");
}
async function consultRealtimeVoiceAgent(params) {
	const agentId = params.agentId ?? "main";
	const agentDir = params.agentRuntime.resolveAgentDir(params.cfg, agentId);
	const workspaceDir = params.agentRuntime.resolveAgentWorkspaceDir(params.cfg, agentId);
	await params.agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });
	const storePath = params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, { agentId });
	const resolvedDeliveryContext = resolveRealtimeVoiceAgentDeliveryContext({
		agentRuntime: params.agentRuntime,
		storePath,
		sessionKey: params.sessionKey,
		spawnedBy: params.spawnedBy
	});
	const sessionEntry = await resolveRealtimeVoiceAgentConsultSessionEntry({
		agentId,
		sessionKey: params.sessionKey,
		spawnedBy: params.spawnedBy,
		contextMode: params.contextMode,
		deliveryContext: resolvedDeliveryContext,
		storePath,
		agentRuntime: params.agentRuntime,
		logger: params.logger
	});
	const consultDeliveryContext = resolvedDeliveryContext ?? deliveryContextFromSession(sessionEntry);
	const sessionId = sessionEntry.sessionId;
	const sessionFile = params.agentRuntime.session.resolveSessionFilePath(sessionId, sessionEntry, { agentId });
	const result = await params.agentRuntime.runEmbeddedPiAgent({
		sessionId,
		sessionKey: params.sessionKey,
		sandboxSessionKey: resolveRealtimeVoiceAgentSandboxSessionKey(agentId, params.sessionKey),
		agentId,
		spawnedBy: params.spawnedBy,
		messageProvider: consultDeliveryContext?.channel ?? params.messageProvider,
		agentAccountId: consultDeliveryContext?.accountId,
		messageTo: consultDeliveryContext?.to,
		messageThreadId: consultDeliveryContext?.threadId,
		currentChannelId: consultDeliveryContext?.to,
		currentThreadTs: consultDeliveryContext?.threadId != null ? String(consultDeliveryContext.threadId) : void 0,
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
		fastMode: params.fastMode,
		verboseLevel: "off",
		reasoningLevel: "off",
		toolResultFormat: "plain",
		toolsAllow: params.toolsAllow,
		timeoutMs: params.timeoutMs ?? params.agentRuntime.resolveAgentTimeoutMs({ cfg: params.cfg }),
		runId: `${params.runIdPrefix}:${Date.now()}`,
		lane: params.lane,
		extraSystemPrompt: params.extraSystemPrompt ?? "You are the configured OpenClaw agent receiving delegated requests from a live voice bridge. Act on behalf of the user, use available tools when appropriate, and return a brief speakable result.",
		agentDir
	});
	const text = collectRealtimeVoiceAgentConsultVisibleText(result.payloads ?? []);
	if (!text) {
		const reason = result.meta?.aborted ? "agent run aborted" : "agent returned no speakable text";
		params.logger.warn(`[talk] agent consult produced no answer: ${reason}`);
		return { text: params.fallbackText ?? "I need a moment to verify that before answering." };
	}
	return { text };
}
//#endregion
//#region src/talk/agent-talkback-runtime.ts
function createRealtimeVoiceAgentTalkbackQueue(params) {
	let active = false;
	let pendingQuestions = [];
	let debounceTimer;
	let activeAbortController;
	const clearDebounceTimer = () => {
		if (!debounceTimer) return;
		clearTimeout(debounceTimer);
		debounceTimer = void 0;
	};
	const run = async (pending) => {
		const trimmed = pending.question.trim();
		if (!trimmed || params.isStopped()) return;
		if (active) {
			appendPendingQuestion(pendingQuestions, {
				question: trimmed,
				metadata: pending.metadata
			});
			return;
		}
		active = true;
		let nextQuestion = {
			question: trimmed,
			metadata: pending.metadata
		};
		let consultStartedAt;
		try {
			while (nextQuestion) {
				if (params.isStopped()) return;
				const currentQuestion = nextQuestion;
				consultStartedAt = Date.now();
				params.logger.info(`${params.logPrefix} consult: chars=${currentQuestion.question.length} queued=${pendingQuestions.length}`);
				activeAbortController = new AbortController();
				const result = await params.consult({
					question: currentQuestion.question,
					metadata: currentQuestion.metadata,
					responseStyle: params.responseStyle,
					signal: activeAbortController.signal
				});
				activeAbortController = void 0;
				const text = result.text.trim();
				params.logger.info(`${params.logPrefix} consult done: elapsedMs=${Date.now() - consultStartedAt} answerChars=${text.length} queued=${pendingQuestions.length}`);
				if (!params.isStopped() && text) params.deliver(text);
				nextQuestion = pendingQuestions.shift();
			}
		} catch (error) {
			activeAbortController = void 0;
			if (params.isStopped() || isAbortError(error)) return;
			const message = error instanceof Error ? error.message : String(error);
			const elapsedDetail = consultStartedAt === void 0 ? "" : ` elapsedMs=${Date.now() - consultStartedAt}`;
			params.logger.warn(`${params.logPrefix} consult failed:${elapsedDetail} ${message}`);
			params.deliver(params.fallbackText);
		} finally {
			active = false;
			const queuedQuestion = pendingQuestions.shift();
			if (queuedQuestion && !params.isStopped()) run(queuedQuestion);
		}
	};
	return {
		close: () => {
			clearDebounceTimer();
			pendingQuestions = [];
			activeAbortController?.abort();
		},
		enqueue: (question, metadata) => {
			const trimmed = question.trim();
			if (!trimmed || params.isStopped()) return;
			if (active) {
				appendPendingQuestion(pendingQuestions, {
					question: trimmed,
					metadata
				});
				params.logger.info(`${params.logPrefix} consult queued: chars=${trimmed.length} queued=${pendingQuestions.length}`);
				clearDebounceTimer();
				return;
			}
			appendPendingQuestion(pendingQuestions, {
				question: trimmed,
				metadata
			});
			clearDebounceTimer();
			debounceTimer = setTimeout(() => {
				debounceTimer = void 0;
				const queuedQuestion = pendingQuestions.shift();
				if (queuedQuestion && !params.isStopped()) run(queuedQuestion);
			}, params.debounceMs);
			debounceTimer.unref?.();
		}
	};
}
function appendPendingQuestion(queue, next) {
	const current = queue.at(-1);
	if (current && Object.is(current.metadata, next.metadata)) {
		current.question = `${current.question}\n${next.question}`;
		return;
	}
	queue.push(next);
}
function isAbortError(error) {
	return error instanceof Error && error.name === "AbortError";
}
//#endregion
//#region src/talk/fast-context-runtime.ts
const MAX_SNIPPET_CHARS = 700;
var RealtimeFastContextTimeoutError = class extends Error {
	constructor(timeoutMs) {
		super(`fast context lookup timed out after ${timeoutMs}ms`);
		this.name = "RealtimeFastContextTimeoutError";
	}
};
function normalizeSnippet(text) {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_SNIPPET_CHARS) return normalized;
	return `${normalized.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}...`;
}
function buildSearchQuery(args) {
	const parsed = parseRealtimeVoiceAgentConsultArgs(args);
	return [parsed.question, parsed.context].filter(Boolean).join("\n\n");
}
function resolveLabels(labels) {
	return {
		audienceLabel: labels?.audienceLabel?.trim() || "person",
		contextName: labels?.contextName?.trim() || "OpenClaw memory context"
	};
}
function buildContextText(params) {
	const hits = params.hits.map((hit, index) => {
		const location = `${hit.path}:${hit.startLine}-${hit.endLine}`;
		return `${index + 1}. [${hit.source}] ${location}\n${normalizeSnippet(hit.snippet)}`;
	}).join("\n\n");
	return [
		`Fast ${params.labels.contextName} found for the live ${params.labels.audienceLabel}.`,
		`Use this context only if it answers the ${params.labels.audienceLabel}'s question. If it is not relevant, say briefly that you do not have that context handy.`,
		`Question:\n${params.query}`,
		`Context:\n${hits}`
	].join("\n\n");
}
function buildMissText(query, labels) {
	return [
		`No relevant ${labels.contextName} was found quickly for the live ${labels.audienceLabel}.`,
		`Answer briefly that you do not have that context handy. Do not keep checking unless the ${labels.audienceLabel} asks you to.`,
		`Question:\n${query}`
	].join("\n\n");
}
async function withTimeout(promise, timeoutMs) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(new RealtimeFastContextTimeoutError(timeoutMs)), timeoutMs);
		})]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function lookupFastContext(params) {
	const memory = await getActiveMemorySearchManager({
		cfg: params.cfg,
		agentId: params.agentId
	});
	if (!memory.manager) return {
		status: "unavailable",
		error: memory.error ?? "no active memory manager"
	};
	return {
		status: "hits",
		hits: await memory.manager.search(params.query, {
			maxResults: params.config.maxResults,
			sessionKey: params.sessionKey,
			sources: params.config.sources
		})
	};
}
async function resolveRealtimeVoiceFastContextConsult(params) {
	if (!params.config.enabled) return { handled: false };
	const labels = resolveLabels(params.labels);
	const query = buildSearchQuery(params.args);
	try {
		const lookup = await withTimeout(lookupFastContext({
			cfg: params.cfg,
			agentId: params.agentId,
			sessionKey: params.sessionKey,
			config: params.config,
			query
		}), params.config.timeoutMs);
		if (lookup.status === "unavailable") {
			params.logger.debug?.(`[talk] fast context unavailable: ${lookup.error}`);
			return params.config.fallbackToConsult ? { handled: false } : {
				handled: true,
				result: { text: buildMissText(query, labels) }
			};
		}
		const { hits } = lookup;
		if (hits.length === 0) return params.config.fallbackToConsult ? { handled: false } : {
			handled: true,
			result: { text: buildMissText(query, labels) }
		};
		return {
			handled: true,
			result: { text: buildContextText({
				query,
				hits,
				labels
			}) }
		};
	} catch (error) {
		const message = formatErrorMessage(error);
		params.logger.debug?.(`[talk] fast context lookup failed: ${message}`);
		return params.config.fallbackToConsult ? { handled: false } : {
			handled: true,
			result: { text: buildMissText(query, labels) }
		};
	}
}
//#endregion
//#region src/talk/session-log-runtime.ts
function recordRealtimeVoiceTranscript(transcript, role, text, maxEntries = 40) {
	const entry = {
		at: (/* @__PURE__ */ new Date()).toISOString(),
		role,
		text
	};
	transcript.push(entry);
	if (transcript.length > maxEntries) transcript.splice(0, transcript.length - maxEntries);
	return entry;
}
function getRealtimeVoiceTranscriptHealth(transcript) {
	const last = transcript.at(-1);
	return {
		realtimeTranscriptLines: transcript.length,
		lastRealtimeTranscriptAt: last?.at,
		lastRealtimeTranscriptRole: last?.role,
		lastRealtimeTranscriptText: last?.text,
		recentRealtimeTranscript: transcript.slice(-5)
	};
}
function recordRealtimeVoiceBridgeEvent(events, event, maxEntries = 40) {
	if (event.direction === "client" && event.type === "input_audio_buffer.append") return;
	events.push({
		at: (/* @__PURE__ */ new Date()).toISOString(),
		...event
	});
	if (events.length > maxEntries) events.splice(0, events.length - maxEntries);
}
function getRealtimeVoiceBridgeEventHealth(events) {
	const last = events.at(-1);
	return {
		lastRealtimeEventAt: last?.at,
		lastRealtimeEventType: last ? `${last.direction}:${last.type}` : void 0,
		lastRealtimeEventDetail: last?.detail,
		recentRealtimeEvents: events.slice(-10)
	};
}
function normalizeTranscriptForEchoMatch(text) {
	return text.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((token) => token.length > 1);
}
function hasMeaningfulEchoOverlap(userTokens, assistantTokens) {
	if (userTokens.length < 4 || assistantTokens.length < 4) return false;
	const uniqueUserTokens = [...new Set(userTokens)];
	if (uniqueUserTokens.length < 4) return false;
	const assistantTokenSet = new Set(assistantTokens);
	return uniqueUserTokens.filter((token) => assistantTokenSet.has(token)).length / uniqueUserTokens.length >= .58;
}
function isLikelyRealtimeVoiceAssistantEchoTranscript(params) {
	const userTokens = normalizeTranscriptForEchoMatch(params.text);
	if (userTokens.length < 4) return false;
	const nowMs = params.nowMs ?? Date.now();
	const recentAssistantText = params.transcript.filter((entry) => {
		if (entry.role !== "assistant") return false;
		const at = Date.parse(entry.at);
		return Number.isFinite(at) && nowMs - at <= params.lookbackMs;
	}).slice(-6).map((entry) => entry.text).join(" ");
	if (!recentAssistantText.trim()) return false;
	const userNormalized = userTokens.join(" ");
	const assistantTokens = normalizeTranscriptForEchoMatch(recentAssistantText);
	const assistantNormalized = assistantTokens.join(" ");
	return userNormalized.length >= 18 && assistantNormalized.includes(userNormalized) || assistantNormalized.length >= 18 && userNormalized.includes(assistantNormalized) || hasMeaningfulEchoOverlap(userTokens, assistantTokens);
}
function extendRealtimeVoiceOutputEchoSuppression(params) {
	const durationMs = Math.ceil(params.audio.byteLength / params.bytesPerMs);
	const playbackEndMs = Math.max(params.nowMs, params.lastOutputPlayableUntilMs) + durationMs;
	return {
		durationMs,
		lastOutputPlayableUntilMs: playbackEndMs,
		suppressInputUntilMs: Math.max(params.suppressInputUntilMs, playbackEndMs + params.tailMs)
	};
}
//#endregion
//#region src/talk/audio-codec.ts
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
	for (let tap = -15; tap <= half; tap += 1) {
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
export { resamplePcmTo8k as a, getRealtimeVoiceTranscriptHealth as c, recordRealtimeVoiceTranscript as d, resolveRealtimeVoiceFastContextConsult as f, resamplePcm as i, isLikelyRealtimeVoiceAssistantEchoTranscript as l, consultRealtimeVoiceAgent as m, mulawToPcm as n, extendRealtimeVoiceOutputEchoSuppression as o, createRealtimeVoiceAgentTalkbackQueue as p, pcmToMulaw as r, getRealtimeVoiceBridgeEventHealth as s, convertPcmToMulaw8k as t, recordRealtimeVoiceBridgeEvent as u };
