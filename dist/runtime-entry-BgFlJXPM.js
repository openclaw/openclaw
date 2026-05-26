import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import { t as appendRegularFile } from "./regular-file-DaVeNX32.js";
import { At as boolean, Bt as discriminatedUnion, Et as array, Nn as record, Rn as string, Tn as object, Zn as unknown, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { n as privateFileStoreSync, t as privateFileStore } from "./private-file-store-DMtyjgoc.js";
import { i as isLoopbackHost } from "./net-DCUMtgJy.js";
import { c as isBlockedHostnameOrIp } from "./ssrf-DdDeGa5L.js";
import { n as parseTtsDirectives } from "./directives-DiYOXJC0.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as isRequestBodyLimitError, c as requestBodyErrorToText, s as readRequestBodyWithLimit } from "./http-body-BfDL157U.js";
import "./security-runtime-CcSekjBd.js";
import "./gateway-runtime-HxuTzDuS.js";
import { S as recordTalkObservabilityEvent, b as createTalkSessionController, c as REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, d as buildRealtimeVoiceAgentConsultPolicyInstructions, v as resolveRealtimeVoiceAgentConsultTools, y as resolveRealtimeVoiceAgentConsultToolsAllow } from "./session-runtime-CCTSwqCz.js";
import { f as resolveRealtimeVoiceFastContextConsult, m as consultRealtimeVoiceAgent, t as convertPcmToMulaw8k } from "./realtime-voice-D-uczs8E.js";
import { t as resolveConfiguredCapabilityProvider } from "./provider-selection-runtime-Dmu4VbAd.js";
import "./speech-DNHVYL_R.js";
import "./webhook-ingress-R0qMwT4u.js";
import { a as createWebhookInFlightLimiter, t as WEBHOOK_BODY_READ_DEFAULTS } from "./webhook-request-guards-iMi786D5.js";
import "./api-DJljBPJY.js";
import { a as resolveVoiceCallEffectiveConfig, c as deepMergeDefined, i as resolveVoiceCallConfig, n as normalizeVoiceCallConfig, o as resolveVoiceCallSessionKey, r as resolveTwilioAuthToken, s as validateProviderConfig } from "./config-Ct8zalEd.js";
import { n as mapVoiceToPolly, t as escapeXml } from "./voice-mapping-C2Mn-7t2.js";
import { t as resolveVoiceResponseModel } from "./response-model-Ci4XSDqB.js";
import { t as isProviderStatusTerminal } from "./call-status-tNVXDwVn.js";
import { t as getHeader } from "./http-headers-Dh8bFB_3.js";
import { URL as URL$1 } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { WebSocket as WebSocket$1, WebSocketServer } from "ws";
import http from "node:http";
//#region extensions/voice-call/src/allowlist.ts
function normalizePhoneNumber(input) {
	if (!input) return "";
	return input.replace(/\D/g, "");
}
function isAllowlistedCaller(normalizedFrom, allowFrom) {
	if (!normalizedFrom) return false;
	return (allowFrom ?? []).some((num) => {
		const normalizedAllow = normalizePhoneNumber(num);
		return normalizedAllow !== "" && normalizedAllow === normalizedFrom;
	});
}
//#endregion
//#region extensions/voice-call/src/types.ts
const ProviderNameSchema = _enum([
	"telnyx",
	"twilio",
	"plivo",
	"mock"
]);
const CallStateSchema = _enum([
	"initiated",
	"ringing",
	"answered",
	"active",
	"speaking",
	"listening",
	"completed",
	"hangup-user",
	"hangup-bot",
	"timeout",
	"error",
	"failed",
	"no-answer",
	"busy",
	"voicemail"
]);
const TerminalStates = new Set([
	"completed",
	"hangup-user",
	"hangup-bot",
	"timeout",
	"error",
	"failed",
	"no-answer",
	"busy",
	"voicemail"
]);
const EndReasonSchema = _enum([
	"completed",
	"hangup-user",
	"hangup-bot",
	"timeout",
	"error",
	"failed",
	"no-answer",
	"busy",
	"voicemail"
]);
const BaseEventSchema = object({
	id: string(),
	dedupeKey: string().optional(),
	callId: string(),
	providerCallId: string().optional(),
	timestamp: number(),
	turnToken: string().optional(),
	direction: _enum(["inbound", "outbound"]).optional(),
	from: string().optional(),
	to: string().optional()
});
discriminatedUnion("type", [
	BaseEventSchema.extend({ type: literal("call.initiated") }),
	BaseEventSchema.extend({ type: literal("call.ringing") }),
	BaseEventSchema.extend({ type: literal("call.answered") }),
	BaseEventSchema.extend({ type: literal("call.active") }),
	BaseEventSchema.extend({
		type: literal("call.speaking"),
		text: string()
	}),
	BaseEventSchema.extend({
		type: literal("call.speech"),
		transcript: string(),
		isFinal: boolean(),
		confidence: number().min(0).max(1).optional()
	}),
	BaseEventSchema.extend({
		type: literal("call.silence"),
		durationMs: number()
	}),
	BaseEventSchema.extend({
		type: literal("call.dtmf"),
		digits: string()
	}),
	BaseEventSchema.extend({
		type: literal("call.ended"),
		reason: EndReasonSchema
	}),
	BaseEventSchema.extend({
		type: literal("call.error"),
		error: string(),
		retryable: boolean().optional()
	})
]);
const CallDirectionSchema = _enum(["outbound", "inbound"]);
const TranscriptEntrySchema = object({
	timestamp: number(),
	speaker: _enum(["bot", "user"]),
	text: string(),
	isFinal: boolean().default(true)
});
const CallRecordSchema = object({
	callId: string(),
	providerCallId: string().optional(),
	provider: ProviderNameSchema,
	direction: CallDirectionSchema,
	state: CallStateSchema,
	from: string(),
	to: string(),
	sessionKey: string().optional(),
	startedAt: number(),
	answeredAt: number().optional(),
	endedAt: number().optional(),
	endReason: EndReasonSchema.optional(),
	transcript: array(TranscriptEntrySchema).default([]),
	processedEventIds: array(string()).default([]),
	metadata: record(string(), unknown()).optional()
});
//#endregion
//#region extensions/voice-call/src/manager/state.ts
const ConversationStates = new Set(["speaking", "listening"]);
const StateOrder = [
	"initiated",
	"ringing",
	"answered",
	"active",
	"speaking",
	"listening"
];
function transitionState(call, newState) {
	if (call.state === newState || TerminalStates.has(call.state)) return;
	if (TerminalStates.has(newState)) {
		call.state = newState;
		return;
	}
	if (ConversationStates.has(call.state) && ConversationStates.has(newState)) {
		call.state = newState;
		return;
	}
	const currentIndex = StateOrder.indexOf(call.state);
	if (StateOrder.indexOf(newState) > currentIndex) call.state = newState;
}
function addTranscriptEntry(call, speaker, text) {
	const entry = {
		timestamp: Date.now(),
		speaker,
		text,
		isFinal: true
	};
	call.transcript.push(entry);
}
//#endregion
//#region extensions/voice-call/src/manager/store.ts
const pendingPersistWrites = /* @__PURE__ */ new Set();
function persistCallRecord(storePath, call) {
	const write = appendRegularFile({
		filePath: path.join(storePath, "calls.jsonl"),
		content: `${JSON.stringify(call)}\n`,
		rejectSymlinkParents: true
	}).catch((err) => {
		console.error("[voice-call] Failed to persist call record:", err);
	}).finally(() => {
		pendingPersistWrites.delete(write);
	});
	pendingPersistWrites.add(write);
}
function loadActiveCallsFromStore(storePath) {
	const logPath = path.join(storePath, "calls.jsonl");
	const content = privateFileStoreSync(storePath).readTextIfExists(path.basename(logPath));
	if (content === null) return {
		activeCalls: /* @__PURE__ */ new Map(),
		providerCallIdMap: /* @__PURE__ */ new Map(),
		processedEventIds: /* @__PURE__ */ new Set(),
		rejectedProviderCallIds: /* @__PURE__ */ new Set()
	};
	const lines = content.split("\n");
	const callMap = /* @__PURE__ */ new Map();
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const call = CallRecordSchema.parse(JSON.parse(line));
			callMap.set(call.callId, call);
		} catch {}
	}
	const activeCalls = /* @__PURE__ */ new Map();
	const providerCallIdMap = /* @__PURE__ */ new Map();
	const processedEventIds = /* @__PURE__ */ new Set();
	const rejectedProviderCallIds = /* @__PURE__ */ new Set();
	for (const [callId, call] of callMap) {
		for (const eventId of call.processedEventIds) processedEventIds.add(eventId);
		if (TerminalStates.has(call.state)) continue;
		activeCalls.set(callId, call);
		if (call.providerCallId) providerCallIdMap.set(call.providerCallId, callId);
	}
	return {
		activeCalls,
		providerCallIdMap,
		processedEventIds,
		rejectedProviderCallIds
	};
}
async function getCallHistoryFromStore(storePath, limit = 50) {
	const logPath = path.join(storePath, "calls.jsonl");
	const content = await privateFileStore(storePath).readTextIfExists(path.basename(logPath));
	if (content === null) return [];
	const lines = content.trim().split("\n").filter(Boolean);
	const calls = [];
	for (const line of lines.slice(-limit)) try {
		const parsed = CallRecordSchema.parse(JSON.parse(line));
		calls.push(parsed);
	} catch {}
	return calls;
}
//#endregion
//#region extensions/voice-call/src/manager/timers.ts
function clearMaxDurationTimer(ctx, callId) {
	const timer = ctx.maxDurationTimers.get(callId);
	if (timer) {
		clearTimeout(timer);
		ctx.maxDurationTimers.delete(callId);
	}
}
function startMaxDurationTimer(params) {
	clearMaxDurationTimer(params.ctx, params.callId);
	const maxDurationMs = params.timeoutMs ?? params.ctx.config.maxDurationSeconds * 1e3;
	console.log(`[voice-call] Starting max duration timer (${Math.ceil(maxDurationMs / 1e3)}s) for call ${params.callId}`);
	const timer = setTimeout(async () => {
		params.ctx.maxDurationTimers.delete(params.callId);
		const call = params.ctx.activeCalls.get(params.callId);
		if (call && !TerminalStates.has(call.state)) {
			console.log(`[voice-call] Max duration reached (${Math.ceil(maxDurationMs / 1e3)}s), ending call ${params.callId}`);
			call.endReason = "timeout";
			persistCallRecord(params.ctx.storePath, call);
			await params.onTimeout(params.callId);
		}
	}, maxDurationMs);
	params.ctx.maxDurationTimers.set(params.callId, timer);
}
function clearTranscriptWaiter(ctx, callId) {
	const waiter = ctx.transcriptWaiters.get(callId);
	if (!waiter) return;
	clearTimeout(waiter.timeout);
	ctx.transcriptWaiters.delete(callId);
}
function rejectTranscriptWaiter(ctx, callId, reason) {
	const waiter = ctx.transcriptWaiters.get(callId);
	if (!waiter) return;
	clearTranscriptWaiter(ctx, callId);
	waiter.reject(new Error(reason));
}
function resolveTranscriptWaiter(ctx, callId, transcript, turnToken) {
	const waiter = ctx.transcriptWaiters.get(callId);
	if (!waiter) return false;
	if (waiter.turnToken && waiter.turnToken !== turnToken) return false;
	clearTranscriptWaiter(ctx, callId);
	waiter.resolve(transcript);
	return true;
}
function waitForFinalTranscript(ctx, callId, turnToken) {
	if (ctx.transcriptWaiters.has(callId)) return Promise.reject(/* @__PURE__ */ new Error("Already waiting for transcript"));
	const timeoutMs = ctx.config.transcriptTimeoutMs;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			ctx.transcriptWaiters.delete(callId);
			reject(/* @__PURE__ */ new Error(`Timed out waiting for transcript after ${timeoutMs}ms`));
		}, timeoutMs);
		ctx.transcriptWaiters.set(callId, {
			resolve,
			reject,
			timeout,
			turnToken
		});
	});
}
//#endregion
//#region extensions/voice-call/src/manager/lifecycle.ts
function removeProviderCallMapping(providerCallIdMap, call) {
	if (!call.providerCallId) return;
	if (providerCallIdMap.get(call.providerCallId) === call.callId) providerCallIdMap.delete(call.providerCallId);
}
function finalizeCall(params) {
	const { ctx, call, endReason } = params;
	call.endedAt = params.endedAt ?? Date.now();
	call.endReason = endReason;
	transitionState(call, endReason);
	persistCallRecord(ctx.storePath, call);
	if (ctx.maxDurationTimers) clearMaxDurationTimer({ maxDurationTimers: ctx.maxDurationTimers }, call.callId);
	if (ctx.transcriptWaiters) rejectTranscriptWaiter({ transcriptWaiters: ctx.transcriptWaiters }, call.callId, params.transcriptRejectReason ?? `Call ended: ${endReason}`);
	ctx.activeCalls.delete(call.callId);
	removeProviderCallMapping(ctx.providerCallIdMap, call);
}
//#endregion
//#region extensions/voice-call/src/manager/lookup.ts
function getCallByProviderCallId(params) {
	const callId = params.providerCallIdMap.get(params.providerCallId);
	if (callId) return params.activeCalls.get(callId);
	for (const call of params.activeCalls.values()) if (call.providerCallId === params.providerCallId) return call;
}
function findCall(params) {
	const directCall = params.activeCalls.get(params.callIdOrProviderCallId);
	if (directCall) return directCall;
	return getCallByProviderCallId({
		activeCalls: params.activeCalls,
		providerCallIdMap: params.providerCallIdMap,
		providerCallId: params.callIdOrProviderCallId
	});
}
//#endregion
//#region extensions/voice-call/src/tts-provider-voice.ts
function resolveProviderVoiceSetting(providerConfig) {
	if (!providerConfig || typeof providerConfig !== "object") return;
	const candidate = providerConfig;
	return normalizeOptionalString(candidate.voice) ?? normalizeOptionalString(candidate.voiceId);
}
function resolvePreferredTtsVoice(config) {
	const providerId = config.tts?.provider;
	if (!providerId) return;
	return resolveProviderVoiceSetting(config.tts?.providers?.[providerId]);
}
//#endregion
//#region extensions/voice-call/src/manager/twiml.ts
function generateNotifyTwiml(message, voice) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}
function generateDtmfRedirectTwiml(digits, webhookUrl) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${escapeXml(digits)}" />
  <Redirect method="POST">${escapeXml(webhookUrl)}</Redirect>
</Response>`;
}
//#endregion
//#region extensions/voice-call/src/manager/outbound.ts
function lookupConnectedCall(ctx, callId) {
	const call = ctx.activeCalls.get(callId);
	if (!call) return {
		kind: "error",
		error: "Call not found"
	};
	if (!ctx.provider || !call.providerCallId) return {
		kind: "error",
		error: "Call not connected"
	};
	if (TerminalStates.has(call.state)) return {
		kind: "ended",
		call
	};
	return {
		kind: "ok",
		call,
		providerCallId: call.providerCallId,
		provider: ctx.provider
	};
}
function requireConnectedCall(ctx, callId) {
	const lookup = lookupConnectedCall(ctx, callId);
	if (lookup.kind === "error") return {
		ok: false,
		error: lookup.error
	};
	if (lookup.kind === "ended") return {
		ok: false,
		error: "Call has ended"
	};
	return {
		ok: true,
		call: lookup.call,
		providerCallId: lookup.providerCallId,
		provider: lookup.provider
	};
}
function validateDtmfDigits(digits) {
	return /^[0-9*#wWpP,]+$/.test(digits) ? null : "digits may only contain digits, *, #, comma, w, p";
}
async function initiateCall(ctx, to, sessionKey, options) {
	const opts = typeof options === "string" ? { message: options } : options ?? {};
	const initialMessage = opts.message;
	const mode = opts.mode ?? ctx.config.outbound.defaultMode;
	const dtmfSequence = opts.dtmfSequence;
	const requesterSessionKey = opts.requesterSessionKey?.trim();
	if (dtmfSequence) {
		const validationError = validateDtmfDigits(dtmfSequence);
		if (validationError) return {
			callId: "",
			success: false,
			error: validationError
		};
		if (mode !== "conversation") return {
			callId: "",
			success: false,
			error: "dtmfSequence requires conversation mode"
		};
	}
	if (!ctx.provider) return {
		callId: "",
		success: false,
		error: "Provider not initialized"
	};
	if (!ctx.webhookUrl) return {
		callId: "",
		success: false,
		error: "Webhook URL not configured"
	};
	if (ctx.activeCalls.size >= ctx.config.maxConcurrentCalls) return {
		callId: "",
		success: false,
		error: `Maximum concurrent calls (${ctx.config.maxConcurrentCalls}) reached`
	};
	const callId = crypto.randomUUID();
	const from = ctx.config.fromNumber || (ctx.provider?.name === "mock" ? "+15550000000" : void 0);
	if (!from) return {
		callId: "",
		success: false,
		error: "fromNumber not configured"
	};
	const callRecord = {
		callId,
		provider: ctx.provider.name,
		direction: "outbound",
		state: "initiated",
		from,
		to,
		sessionKey: resolveVoiceCallSessionKey({
			config: ctx.config,
			callId,
			phone: to,
			explicitSessionKey: sessionKey
		}),
		startedAt: Date.now(),
		transcript: [],
		processedEventIds: [],
		metadata: {
			...initialMessage && { initialMessage },
			mode,
			...requesterSessionKey ? { requesterSessionKey } : {}
		}
	};
	ctx.activeCalls.set(callId, callRecord);
	persistCallRecord(ctx.storePath, callRecord);
	try {
		let inlineTwiml;
		let preConnectTwiml;
		if (mode === "notify" && initialMessage) {
			const pollyVoice = mapVoiceToPolly(resolvePreferredTtsVoice(ctx.config));
			inlineTwiml = generateNotifyTwiml(initialMessage, pollyVoice);
			console.log(`[voice-call] Using inline TwiML for notify mode (voice: ${pollyVoice})`);
		} else if (dtmfSequence) {
			preConnectTwiml = generateDtmfRedirectTwiml(dtmfSequence, ctx.webhookUrl);
			console.log(`[voice-call] Using pre-connect DTMF TwiML for call ${callId} (digits=${dtmfSequence.length}, initialMessage=${initialMessage ? "yes" : "no"})`);
		}
		const streamSession = ctx.config.realtime?.enabled && ctx.provider.name === "telnyx" && ctx.streamSessionIssuer ? ctx.streamSessionIssuer({
			providerName: "telnyx",
			callId,
			from,
			to,
			direction: "outbound"
		}) : void 0;
		const result = await ctx.provider.initiateCall({
			callId,
			from,
			to,
			webhookUrl: ctx.webhookUrl,
			inlineTwiml,
			preConnectTwiml,
			...streamSession ? {
				streamUrl: streamSession.streamUrl,
				streamAuthToken: streamSession.token
			} : {}
		});
		callRecord.providerCallId = result.providerCallId;
		ctx.providerCallIdMap.set(result.providerCallId, callId);
		persistCallRecord(ctx.storePath, callRecord);
		console.log(`[voice-call] Outbound call initiated: callId=${callId} providerCallId=${result.providerCallId} mode=${mode} preConnectDtmf=${preConnectTwiml ? "yes" : "no"} initialMessage=${initialMessage ? "yes" : "no"}`);
		return {
			callId,
			success: true
		};
	} catch (err) {
		finalizeCall({
			ctx,
			call: callRecord,
			endReason: "failed"
		});
		return {
			callId,
			success: false,
			error: formatErrorMessage(err)
		};
	}
}
async function speak(ctx, callId, text) {
	const connected = requireConnectedCall(ctx, callId);
	if (!connected.ok) return {
		success: false,
		error: connected.error
	};
	const { call, providerCallId, provider } = connected;
	try {
		transitionState(call, "speaking");
		persistCallRecord(ctx.storePath, call);
		const numberRouteKey = typeof call.metadata?.numberRouteKey === "string" ? call.metadata.numberRouteKey : call.to;
		const voice = resolvePreferredTtsVoice(resolveVoiceCallEffectiveConfig(ctx.config, numberRouteKey).config);
		await provider.playTts({
			callId,
			providerCallId,
			text,
			voice
		});
		addTranscriptEntry(call, "bot", text);
		persistCallRecord(ctx.storePath, call);
		return { success: true };
	} catch (err) {
		transitionState(call, "listening");
		persistCallRecord(ctx.storePath, call);
		return {
			success: false,
			error: formatErrorMessage(err)
		};
	}
}
function shouldStartListeningAfterInitialMessage(ctx) {
	if (ctx.provider?.name !== "twilio") return true;
	if (!ctx.config.streaming.enabled) return true;
	return ctx.provider.isConversationStreamConnectEnabled?.() !== true;
}
async function sendDtmf(ctx, callId, digits) {
	const validationError = validateDtmfDigits(digits);
	if (validationError) return {
		success: false,
		error: validationError
	};
	const connected = requireConnectedCall(ctx, callId);
	if (!connected.ok) return {
		success: false,
		error: connected.error
	};
	if (!connected.provider.sendDtmf) return {
		success: false,
		error: `${connected.provider.name} does not support outbound DTMF`
	};
	try {
		await connected.provider.sendDtmf({
			callId,
			providerCallId: connected.providerCallId,
			digits
		});
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: formatErrorMessage(err)
		};
	}
}
async function speakInitialMessage(ctx, providerCallId) {
	const call = getCallByProviderCallId({
		activeCalls: ctx.activeCalls,
		providerCallIdMap: ctx.providerCallIdMap,
		providerCallId
	});
	if (!call) {
		console.warn(`[voice-call] speakInitialMessage: no call found for ${providerCallId}`);
		return;
	}
	const initialMessage = call.metadata?.initialMessage;
	const mode = call.metadata?.mode ?? "conversation";
	if (!initialMessage) {
		console.log(`[voice-call] speakInitialMessage: no initial message for ${call.callId}`);
		return;
	}
	if (ctx.initialMessageInFlight.has(call.callId)) {
		console.log(`[voice-call] speakInitialMessage: initial message already in flight for ${call.callId}`);
		return;
	}
	ctx.initialMessageInFlight.add(call.callId);
	try {
		console.log(`[voice-call] Speaking initial message for call ${call.callId} (mode: ${mode})`);
		const result = await speak(ctx, call.callId, initialMessage);
		if (!result.success) {
			console.warn(`[voice-call] Failed to speak initial message: ${result.error}`);
			return;
		}
		if (call.metadata) {
			delete call.metadata.initialMessage;
			persistCallRecord(ctx.storePath, call);
		}
		if (mode === "notify") {
			const delaySec = ctx.config.outbound.notifyHangupDelaySec;
			console.log(`[voice-call] Notify mode: auto-hangup in ${delaySec}s for call ${call.callId}`);
			setTimeout(async () => {
				const currentCall = ctx.activeCalls.get(call.callId);
				if (currentCall && !TerminalStates.has(currentCall.state)) {
					console.log(`[voice-call] Notify mode: hanging up call ${call.callId}`);
					await endCall(ctx, call.callId);
				}
			}, delaySec * 1e3);
		} else if (mode === "conversation" && ctx.provider && shouldStartListeningAfterInitialMessage(ctx)) {
			transitionState(call, "listening");
			persistCallRecord(ctx.storePath, call);
			await ctx.provider.startListening({
				callId: call.callId,
				providerCallId
			});
		}
	} finally {
		ctx.initialMessageInFlight.delete(call.callId);
	}
}
async function continueCall(ctx, callId, prompt) {
	const connected = requireConnectedCall(ctx, callId);
	if (!connected.ok) return {
		success: false,
		error: connected.error
	};
	const { call, providerCallId, provider } = connected;
	if (ctx.activeTurnCalls.has(callId) || ctx.transcriptWaiters.has(callId)) return {
		success: false,
		error: "Already waiting for transcript"
	};
	ctx.activeTurnCalls.add(callId);
	const turnStartedAt = Date.now();
	const turnToken = provider.name === "twilio" ? crypto.randomUUID() : void 0;
	try {
		await speak(ctx, callId, prompt);
		transitionState(call, "listening");
		persistCallRecord(ctx.storePath, call);
		const listenStartedAt = Date.now();
		await provider.startListening({
			callId,
			providerCallId,
			turnToken
		});
		const transcript = await waitForFinalTranscript(ctx, callId, turnToken);
		const transcriptReceivedAt = Date.now();
		await provider.stopListening({
			callId,
			providerCallId
		});
		const lastTurnLatencyMs = transcriptReceivedAt - turnStartedAt;
		const lastTurnListenWaitMs = transcriptReceivedAt - listenStartedAt;
		const turnCount = call.metadata && typeof call.metadata.turnCount === "number" ? call.metadata.turnCount + 1 : 1;
		call.metadata = {
			...call.metadata,
			turnCount,
			lastTurnLatencyMs,
			lastTurnListenWaitMs,
			lastTurnCompletedAt: transcriptReceivedAt
		};
		persistCallRecord(ctx.storePath, call);
		console.log("[voice-call] continueCall latency call=" + call.callId + " totalMs=" + String(lastTurnLatencyMs) + " listenWaitMs=" + String(lastTurnListenWaitMs));
		return {
			success: true,
			transcript
		};
	} catch (err) {
		return {
			success: false,
			error: formatErrorMessage(err)
		};
	} finally {
		ctx.activeTurnCalls.delete(callId);
		clearTranscriptWaiter(ctx, callId);
	}
}
async function endCall(ctx, callId, options) {
	const lookup = lookupConnectedCall(ctx, callId);
	if (lookup.kind === "error") return {
		success: false,
		error: lookup.error
	};
	if (lookup.kind === "ended") return { success: true };
	const { call, providerCallId, provider } = lookup;
	const reason = options?.reason ?? "hangup-bot";
	try {
		await provider.hangupCall({
			callId,
			providerCallId,
			reason
		});
		finalizeCall({
			ctx,
			call,
			endReason: reason
		});
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: formatErrorMessage(err)
		};
	}
}
//#endregion
//#region extensions/voice-call/src/manager/events.ts
function shouldAcceptInbound(config, from) {
	const { inboundPolicy: policy, allowFrom } = config;
	switch (policy) {
		case "disabled":
			console.log("[voice-call] Inbound call rejected: policy is disabled");
			return false;
		case "open":
			console.log("[voice-call] Inbound call accepted: policy is open");
			return true;
		case "allowlist":
		case "pairing": {
			const normalized = normalizePhoneNumber(from);
			if (!normalized) {
				console.log("[voice-call] Inbound call rejected: missing caller ID");
				return false;
			}
			const allowed = isAllowlistedCaller(normalized, allowFrom);
			console.log(`[voice-call] Inbound call ${allowed ? "accepted" : "rejected"}: ${from} ${allowed ? "is in" : "not in"} allowlist`);
			return allowed;
		}
		default: return false;
	}
}
function createWebhookCall(params) {
	const callId = crypto.randomUUID();
	const effective = resolveVoiceCallEffectiveConfig(params.ctx.config, params.direction === "inbound" ? params.to : void 0);
	const effectiveConfig = effective.config;
	const callRecord = {
		callId,
		providerCallId: params.providerCallId,
		provider: params.ctx.provider?.name || "twilio",
		direction: params.direction,
		state: "ringing",
		from: params.from,
		to: params.to,
		sessionKey: resolveVoiceCallSessionKey({
			config: effectiveConfig,
			callId,
			phone: params.direction === "outbound" ? params.to : params.from
		}),
		startedAt: Date.now(),
		transcript: [],
		processedEventIds: [],
		metadata: {
			initialMessage: params.direction === "inbound" ? effectiveConfig.inboundGreeting || "Hello! How can I help you today?" : void 0,
			...effective.numberRouteKey ? { numberRouteKey: effective.numberRouteKey } : {}
		}
	};
	params.ctx.activeCalls.set(callId, callRecord);
	params.ctx.providerCallIdMap.set(params.providerCallId, callId);
	persistCallRecord(params.ctx.storePath, callRecord);
	console.log(`[voice-call] Created ${params.direction} call record: ${callId} from ${params.from}`);
	return callRecord;
}
function persistRejectedInboundCall(params) {
	const callId = params.event.callId || params.providerCallId;
	const now = Date.now();
	const rejectedCall = {
		callId,
		providerCallId: params.providerCallId,
		provider: params.ctx.provider?.name || "twilio",
		direction: "inbound",
		state: "hangup-bot",
		from: params.event.from || "unknown",
		to: params.event.to || params.ctx.config.fromNumber || "unknown",
		startedAt: params.event.timestamp || now,
		endedAt: now,
		endReason: "hangup-bot",
		transcript: [],
		processedEventIds: [params.dedupeKey],
		metadata: { rejectionReason: "inbound-policy" }
	};
	persistCallRecord(params.ctx.storePath, rejectedCall);
}
function processEvent(ctx, event) {
	const dedupeKey = event.dedupeKey || event.id;
	if (ctx.processedEventIds.has(dedupeKey)) return;
	let call = findCall({
		activeCalls: ctx.activeCalls,
		providerCallIdMap: ctx.providerCallIdMap,
		callIdOrProviderCallId: event.callId
	});
	const providerCallId = event.providerCallId;
	const eventDirection = event.direction === "inbound" || event.direction === "outbound" ? event.direction : void 0;
	if (!call && providerCallId && eventDirection) {
		if (eventDirection === "inbound" && !shouldAcceptInbound(ctx.config, event.from)) {
			const pid = providerCallId;
			if (!ctx.provider) {
				console.warn(`[voice-call] Inbound call rejected by policy but no provider to hang up (providerCallId: ${pid}, from: ${event.from}); call will time out on provider side.`);
				return;
			}
			ctx.processedEventIds.add(dedupeKey);
			if (ctx.rejectedProviderCallIds.has(pid)) return;
			ctx.rejectedProviderCallIds.add(pid);
			const callId = event.callId ?? pid;
			persistRejectedInboundCall({
				ctx,
				event,
				dedupeKey,
				providerCallId: pid
			});
			console.log(`[voice-call] Rejecting inbound call by policy: ${pid}`);
			ctx.provider.hangupCall({
				callId,
				providerCallId: pid,
				reason: "hangup-bot"
			}).catch((err) => {
				ctx.rejectedProviderCallIds.delete(pid);
				const message = formatErrorMessage(err);
				console.warn(`[voice-call] Failed to reject inbound call ${pid}:`, message);
			});
			return;
		}
		call = createWebhookCall({
			ctx,
			providerCallId,
			direction: eventDirection === "outbound" ? "outbound" : "inbound",
			from: event.from || "unknown",
			to: event.to || ctx.config.fromNumber || "unknown"
		});
		event.callId = call.callId;
	}
	if (!call) return;
	if (event.providerCallId && event.providerCallId !== call.providerCallId) {
		const previousProviderCallId = call.providerCallId;
		call.providerCallId = event.providerCallId;
		ctx.providerCallIdMap.set(event.providerCallId, call.callId);
		if (previousProviderCallId) {
			if (ctx.providerCallIdMap.get(previousProviderCallId) === call.callId) ctx.providerCallIdMap.delete(previousProviderCallId);
		}
	}
	if (!(event.type === "call.error" && event.retryable)) {
		ctx.processedEventIds.add(dedupeKey);
		call.processedEventIds.push(dedupeKey);
	}
	switch (event.type) {
		case "call.initiated":
			transitionState(call, "initiated");
			if (call.direction === "inbound" && call.providerCallId && ctx.provider?.answerCall) {
				const inboundStreamSession = ctx.config.realtime?.enabled && ctx.provider.name === "telnyx" && ctx.streamSessionIssuer ? ctx.streamSessionIssuer({
					providerName: "telnyx",
					callId: call.callId,
					from: call.from,
					to: call.to,
					direction: "inbound"
				}) : void 0;
				ctx.provider.answerCall({
					callId: call.callId,
					providerCallId: call.providerCallId,
					...inboundStreamSession ? {
						streamUrl: inboundStreamSession.streamUrl,
						streamAuthToken: inboundStreamSession.token
					} : {}
				}).catch((err) => {
					const message = formatErrorMessage(err);
					console.warn(`[voice-call] Failed to answer inbound call ${call.providerCallId}:`, message);
				});
			}
			break;
		case "call.ringing":
			transitionState(call, "ringing");
			break;
		case "call.answered":
			call.answeredAt = event.timestamp;
			transitionState(call, "answered");
			startMaxDurationTimer({
				ctx,
				callId: call.callId,
				onTimeout: async (callId) => {
					await endCall(ctx, callId, { reason: "timeout" });
				}
			});
			ctx.onCallAnswered?.(call);
			break;
		case "call.active":
			transitionState(call, "active");
			break;
		case "call.speaking":
			transitionState(call, "speaking");
			break;
		case "call.speech":
			if (event.isFinal) {
				const hadWaiter = ctx.transcriptWaiters.has(call.callId);
				const resolved = resolveTranscriptWaiter(ctx, call.callId, event.transcript, event.turnToken);
				if (hadWaiter && !resolved) {
					console.warn(`[voice-call] Ignoring speech event with mismatched turn token for ${call.callId}`);
					break;
				}
				addTranscriptEntry(call, "user", event.transcript);
			}
			transitionState(call, "listening");
			break;
		case "call.silence":
		case "call.dtmf": break;
		case "call.ended":
			finalizeCall({
				ctx,
				call,
				endReason: event.reason,
				endedAt: event.timestamp
			});
			return;
		case "call.error":
			if (!event.retryable) {
				finalizeCall({
					ctx,
					call,
					endReason: "error",
					endedAt: event.timestamp,
					transcriptRejectReason: `Call error: ${event.error}`
				});
				return;
			}
			break;
	}
	persistCallRecord(ctx.storePath, call);
}
//#endregion
//#region extensions/voice-call/src/utils.ts
function resolveUserPath(input) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
		return path.resolve(expanded);
	}
	return path.resolve(trimmed);
}
//#endregion
//#region extensions/voice-call/src/manager.ts
function markRestoredCallSkipped(call, endReason) {
	call.endedAt = Date.now();
	call.endReason = endReason;
	call.state = endReason;
}
function incrementRestoreStatusCount(counts, status) {
	const key = normalizeOptionalString(status) ?? "terminal";
	counts.set(key, (counts.get(key) ?? 0) + 1);
}
function resolveDefaultStoreBase(config, storePath) {
	const rawOverride = storePath?.trim() || config.store?.trim();
	if (rawOverride) return resolveUserPath(rawOverride);
	const preferred = path.join(os.homedir(), ".openclaw", "voice-calls");
	return [preferred].map((dir) => resolveUserPath(dir)).find((dir) => {
		try {
			return fs.existsSync(path.join(dir, "calls.jsonl")) || fs.existsSync(dir);
		} catch {
			return false;
		}
	}) ?? resolveUserPath(preferred);
}
/**
* Manages voice calls: state ownership and delegation to manager helper modules.
*/
var CallManager = class {
	constructor(config, storePath) {
		this.activeCalls = /* @__PURE__ */ new Map();
		this.providerCallIdMap = /* @__PURE__ */ new Map();
		this.processedEventIds = /* @__PURE__ */ new Set();
		this.rejectedProviderCallIds = /* @__PURE__ */ new Set();
		this.provider = null;
		this.webhookUrl = null;
		this.activeTurnCalls = /* @__PURE__ */ new Set();
		this.transcriptWaiters = /* @__PURE__ */ new Map();
		this.maxDurationTimers = /* @__PURE__ */ new Map();
		this.initialMessageInFlight = /* @__PURE__ */ new Set();
		this.config = config;
		this.storePath = resolveDefaultStoreBase(config, storePath);
	}
	/**
	* Initialize the call manager with a provider.
	* Verifies persisted calls with the provider and restarts timers.
	*/
	async initialize(provider, webhookUrl) {
		this.provider = provider;
		this.webhookUrl = webhookUrl;
		fs.mkdirSync(this.storePath, { recursive: true });
		const persisted = loadActiveCallsFromStore(this.storePath);
		this.processedEventIds = persisted.processedEventIds;
		this.rejectedProviderCallIds = persisted.rejectedProviderCallIds;
		const verified = await this.verifyRestoredCalls(provider, persisted.activeCalls);
		this.activeCalls = verified;
		this.providerCallIdMap = /* @__PURE__ */ new Map();
		for (const [callId, call] of verified) if (call.providerCallId) this.providerCallIdMap.set(call.providerCallId, callId);
		let skippedAlreadyElapsedTimers = 0;
		for (const [callId, call] of verified) if (call.answeredAt && !TerminalStates.has(call.state)) {
			const elapsed = Date.now() - call.answeredAt;
			const maxDurationMs = this.config.maxDurationSeconds * 1e3;
			if (elapsed >= maxDurationMs) {
				verified.delete(callId);
				if (call.providerCallId) this.providerCallIdMap.delete(call.providerCallId);
				skippedAlreadyElapsedTimers += 1;
				continue;
			}
			startMaxDurationTimer({
				ctx: this.getContext(),
				callId,
				timeoutMs: maxDurationMs - elapsed,
				onTimeout: async (id) => {
					await endCall(this.getContext(), id, { reason: "timeout" });
				}
			});
			console.log(`[voice-call] Restarted max-duration timer for restored call ${callId}`);
		}
		if (skippedAlreadyElapsedTimers > 0) console.log(`[voice-call] Skipped ${skippedAlreadyElapsedTimers} restored call(s) whose max-duration timer already elapsed`);
		if (verified.size > 0) console.log(`[voice-call] Restored ${verified.size} active call(s) from store`);
	}
	/**
	* Verify persisted calls with the provider before restoring.
	* Calls without providerCallId or older than maxDurationSeconds are skipped.
	* Transient provider errors keep the call (rely on timer fallback).
	*/
	async verifyRestoredCalls(provider, candidates) {
		if (candidates.size === 0) return /* @__PURE__ */ new Map();
		const maxAgeMs = this.config.maxDurationSeconds * 1e3;
		const now = Date.now();
		const verified = /* @__PURE__ */ new Map();
		const verifyTasks = [];
		let skippedNoProviderCallId = 0;
		let skippedOlderThanMaxDuration = 0;
		const skippedTerminalStatuses = /* @__PURE__ */ new Map();
		let keptVerifiedActive = 0;
		let keptUnknownProviderStatus = 0;
		let keptVerificationFailures = 0;
		for (const [callId, call] of candidates) {
			if (!call.providerCallId) {
				skippedNoProviderCallId += 1;
				continue;
			}
			if (now - call.startedAt > maxAgeMs) {
				skippedOlderThanMaxDuration += 1;
				markRestoredCallSkipped(call, "timeout");
				persistCallRecord(this.storePath, call);
				await provider.hangupCall({
					callId,
					providerCallId: call.providerCallId,
					reason: "timeout"
				}).catch((err) => {
					console.warn(`[voice-call] Failed to hang up expired restored call ${callId}:`, err instanceof Error ? err.message : String(err));
				});
				continue;
			}
			const task = {
				callId,
				call,
				promise: provider.getCallStatus({ providerCallId: call.providerCallId }).then((result) => {
					if (result.isTerminal) {
						incrementRestoreStatusCount(skippedTerminalStatuses, result.status);
						markRestoredCallSkipped(call, "completed");
						persistCallRecord(this.storePath, call);
					} else if (result.isUnknown) {
						keptUnknownProviderStatus += 1;
						verified.set(callId, call);
					} else {
						keptVerifiedActive += 1;
						verified.set(callId, call);
					}
				}).catch(() => {
					keptVerificationFailures += 1;
					verified.set(callId, call);
				})
			};
			verifyTasks.push(task);
		}
		await Promise.allSettled(verifyTasks.map((t) => t.promise));
		if (skippedNoProviderCallId > 0) console.log(`[voice-call] Skipped ${skippedNoProviderCallId} restored call(s) with no providerCallId`);
		if (skippedOlderThanMaxDuration > 0) console.log(`[voice-call] Skipped ${skippedOlderThanMaxDuration} restored call(s) older than maxDurationSeconds`);
		for (const [status, count] of [...skippedTerminalStatuses].toSorted(([a], [b]) => a.localeCompare(b))) console.log(`[voice-call] Skipped ${count} restored call(s) with provider status: ${status}`);
		if (keptVerifiedActive > 0) console.log(`[voice-call] Kept ${keptVerifiedActive} restored call(s) confirmed active by provider`);
		if (keptUnknownProviderStatus > 0) console.log(`[voice-call] Kept ${keptUnknownProviderStatus} restored call(s) with unknown provider status (relying on timer)`);
		if (keptVerificationFailures > 0) console.log(`[voice-call] Kept ${keptVerificationFailures} restored call(s) after verification failure (relying on timer)`);
		return verified;
	}
	/**
	* Get the current provider.
	*/
	getProvider() {
		return this.provider;
	}
	/**
	* Initiate an outbound call.
	*/
	async initiateCall(to, sessionKey, options) {
		return initiateCall(this.getContext(), to, sessionKey, options);
	}
	/**
	* Speak to user in an active call.
	*/
	async speak(callId, text) {
		return speak(this.getContext(), callId, text);
	}
	/**
	* Send DTMF digits to an active call.
	*/
	async sendDtmf(callId, digits) {
		return sendDtmf(this.getContext(), callId, digits);
	}
	/**
	* Speak the initial message for a call (called when media stream connects).
	*/
	async speakInitialMessage(providerCallId) {
		return speakInitialMessage(this.getContext(), providerCallId);
	}
	/**
	* Continue call: speak prompt, then wait for user's final transcript.
	*/
	async continueCall(callId, prompt) {
		return continueCall(this.getContext(), callId, prompt);
	}
	/**
	* End an active call.
	*/
	async endCall(callId) {
		return endCall(this.getContext(), callId);
	}
	getContext() {
		return {
			activeCalls: this.activeCalls,
			providerCallIdMap: this.providerCallIdMap,
			processedEventIds: this.processedEventIds,
			rejectedProviderCallIds: this.rejectedProviderCallIds,
			provider: this.provider,
			config: this.config,
			storePath: this.storePath,
			webhookUrl: this.webhookUrl,
			activeTurnCalls: this.activeTurnCalls,
			transcriptWaiters: this.transcriptWaiters,
			maxDurationTimers: this.maxDurationTimers,
			initialMessageInFlight: this.initialMessageInFlight,
			onCallAnswered: (call) => {
				this.maybeSpeakInitialMessageOnAnswered(call);
			},
			streamSessionIssuer: this.streamSessionIssuer
		};
	}
	/**
	* Process a webhook event.
	*/
	processEvent(event) {
		processEvent(this.getContext(), event);
	}
	shouldDeferConversationInitialMessageUntilStreamConnect() {
		if (!this.provider || this.provider.name !== "twilio" || !this.config.streaming.enabled) return false;
		const streamAwareProvider = this.provider;
		if (typeof streamAwareProvider.isConversationStreamConnectEnabled !== "function") return false;
		return streamAwareProvider.isConversationStreamConnectEnabled();
	}
	maybeSpeakInitialMessageOnAnswered(call) {
		if (!(normalizeOptionalString(call.metadata?.initialMessage) ?? "")) return;
		const mode = call.metadata?.mode ?? "conversation";
		if (mode === "conversation") {
			if (this.config.realtime.enabled) return;
			if (this.shouldDeferConversationInitialMessageUntilStreamConnect()) return;
		} else if (mode !== "notify") return;
		if (!this.provider || !call.providerCallId) return;
		this.speakInitialMessage(call.providerCallId).catch((err) => {
			console.warn(`[voice-call] Failed to speak initial message for call ${call.callId}: ${formatErrorMessage(err)}`);
		});
	}
	/**
	* Get an active call by ID.
	*/
	getCall(callId) {
		return this.activeCalls.get(callId);
	}
	/**
	* Get an active call by provider call ID (e.g., Twilio CallSid).
	*/
	getCallByProviderCallId(providerCallId) {
		return getCallByProviderCallId({
			activeCalls: this.activeCalls,
			providerCallIdMap: this.providerCallIdMap,
			providerCallId
		});
	}
	/**
	* Get all active calls.
	*/
	getActiveCalls() {
		return Array.from(this.activeCalls.values());
	}
	/**
	* Get call history (from persisted logs).
	*/
	async getCallHistory(limit = 50) {
		return getCallHistoryFromStore(this.storePath, limit);
	}
};
//#endregion
//#region extensions/voice-call/src/realtime-agent-context.ts
function normalizeString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readAgentEntries(cfg) {
	const agents = cfg.agents;
	return Array.isArray(agents?.list) ? agents.list.filter((entry) => Boolean(entry && typeof entry === "object")) : [];
}
function resolveAgentSystemPromptOverride(cfg, agentId) {
	return normalizeString(readAgentEntries(cfg).find((candidate) => normalizeString(candidate.id) === agentId)?.systemPromptOverride) ?? normalizeString(cfg.agents?.defaults?.systemPromptOverride);
}
function limitText(text, maxChars) {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n[truncated]`;
}
async function readWorkspaceVoiceContextFiles(params) {
	const sections = [];
	let remaining = params.maxChars;
	const workspaceRoot = await root(params.workspaceDir).catch(() => null);
	if (!workspaceRoot) return sections;
	for (const file of params.files) {
		if (remaining <= 0) continue;
		const trimmed = (await workspaceRoot.readText(file).catch(() => void 0))?.trim();
		if (!trimmed) continue;
		const section = `### ${file}\n${limitText(trimmed, Math.max(0, remaining - file.length - 16))}`;
		sections.push(section);
		remaining -= section.length;
	}
	return sections;
}
async function buildRealtimeVoiceInstructions(params) {
	const { config } = params;
	const sections = [params.baseInstructions];
	const consultGuidance = buildRealtimeVoiceAgentConsultPolicyInstructions(config.realtime);
	if (consultGuidance) sections.push(consultGuidance);
	const contextConfig = config.realtime.agentContext;
	if (!contextConfig.enabled) return sections.filter(Boolean).join("\n\n");
	const agentId = config.agentId ?? "main";
	const capsule = [
		"OpenClaw agent voice context:",
		`- Agent id: ${agentId}`,
		"- Use this context to match the OpenClaw agent's personality and standing preferences on fast voice turns.",
		"- Treat this as compact context only; call openclaw_agent_consult when the caller needs the full agent brain, tools, memory, or workspace state."
	];
	if (contextConfig.includeIdentity) {
		const identity = params.agentRuntime.resolveAgentIdentity(params.coreConfig, agentId);
		const identityLines = [
			normalizeString(identity?.name) ? `- Name: ${normalizeString(identity?.name)}` : void 0,
			normalizeString(identity?.emoji) ? `- Emoji: ${normalizeString(identity?.emoji)}` : void 0,
			normalizeString(identity?.vibe) ? `- Vibe: ${normalizeString(identity?.vibe)}` : void 0,
			normalizeString(identity?.theme) ? `- Theme: ${normalizeString(identity?.theme)}` : void 0,
			normalizeString(identity?.creature) ? `- Creature/persona: ${normalizeString(identity?.creature)}` : void 0
		].filter(Boolean);
		if (identityLines.length > 0) capsule.push(`Configured identity:\n${identityLines.join("\n")}`);
	}
	if (contextConfig.includeSystemPrompt) {
		const systemPrompt = resolveAgentSystemPromptOverride(params.coreConfig, agentId);
		if (systemPrompt) capsule.push(`Configured system prompt override:\n${systemPrompt}`);
	}
	if (contextConfig.includeWorkspaceFiles) {
		const fileSections = await readWorkspaceVoiceContextFiles({
			workspaceDir: params.agentRuntime.resolveAgentWorkspaceDir(params.coreConfig, agentId),
			files: contextConfig.files,
			maxChars: contextConfig.maxChars
		});
		if (fileSections.length > 0) capsule.push(`Workspace voice context:\n${fileSections.join("\n\n")}`);
	}
	sections.push(limitText(capsule.join("\n\n"), contextConfig.maxChars));
	return sections.filter(Boolean).join("\n\n");
}
//#endregion
//#region extensions/voice-call/src/realtime-fast-context.ts
async function resolveRealtimeFastContextConsult(params) {
	return await resolveRealtimeVoiceFastContextConsult({
		...params,
		labels: {
			audienceLabel: "caller",
			contextName: "OpenClaw memory or session context"
		}
	});
}
//#endregion
//#region extensions/voice-call/src/telephony-tts.ts
const TELEPHONY_DEFAULT_TTS_TIMEOUT_MS = 8e3;
function createTelephonyTtsProvider(params) {
	const { coreConfig, ttsOverride, runtime, logger } = params;
	const mergedConfig = applyTtsOverride(coreConfig, ttsOverride);
	const ttsConfig = mergedConfig.messages?.tts;
	const modelOverrides = resolveTelephonyModelOverridePolicy(readTelephonyModelOverrides(ttsConfig));
	const providerConfigs = collectTelephonyProviderConfigs(ttsConfig);
	const activeProvider = normalizeProviderId(ttsConfig?.provider);
	return {
		synthesisTimeoutMs: mergedConfig.messages?.tts?.timeoutMs ?? 8e3,
		synthesizeForTelephony: async (text) => {
			const directives = parseTtsDirectives(text, modelOverrides, {
				cfg: mergedConfig,
				providerConfigs,
				preferredProviderId: activeProvider
			});
			if (directives.warnings.length > 0) logger?.warn?.(`[voice-call] Ignored telephony TTS directive overrides (${directives.warnings.join("; ")})`);
			const cleanText = directives.hasDirective ? directives.ttsText?.trim() || directives.cleanedText.trim() : text;
			const result = await runtime.textToSpeechTelephony({
				text: cleanText,
				cfg: mergedConfig,
				overrides: directives.overrides
			});
			if (!result.success || !result.audioBuffer || !result.sampleRate) throw new Error(result.error ?? "TTS conversion failed");
			if (result.fallbackFrom && result.provider && result.fallbackFrom !== result.provider) {
				const attemptedChain = result.attemptedProviders && result.attemptedProviders.length > 0 ? result.attemptedProviders.join(" -> ") : `${result.fallbackFrom} -> ${result.provider}`;
				logger?.warn?.(`[voice-call] Telephony TTS fallback used from=${result.fallbackFrom} to=${result.provider} attempts=${attemptedChain}`);
			}
			return convertPcmToMulaw8k(result.audioBuffer, result.sampleRate);
		}
	};
}
function applyTtsOverride(coreConfig, override) {
	if (!override) return coreConfig;
	const base = coreConfig.messages?.tts;
	const merged = mergeTtsConfig(base, override);
	if (!merged) return coreConfig;
	return {
		...coreConfig,
		messages: {
			...coreConfig.messages,
			tts: merged
		}
	};
}
function mergeTtsConfig(base, override) {
	if (!base && !override) return;
	if (!override) return base;
	if (!base) return override;
	return deepMergeDefined(base, override);
}
function resolveTelephonyModelOverridePolicy(overrides) {
	if (!(overrides?.enabled ?? true)) return {
		enabled: false,
		allowText: false,
		allowProvider: false,
		allowVoice: false,
		allowModelId: false,
		allowVoiceSettings: false,
		allowNormalization: false,
		allowSeed: false
	};
	const allow = (value, defaultValue = true) => value ?? defaultValue;
	return {
		enabled: true,
		allowText: allow(overrides?.allowText),
		allowProvider: allow(overrides?.allowProvider, false),
		allowVoice: allow(overrides?.allowVoice),
		allowModelId: allow(overrides?.allowModelId),
		allowVoiceSettings: allow(overrides?.allowVoiceSettings),
		allowNormalization: allow(overrides?.allowNormalization),
		allowSeed: allow(overrides?.allowSeed)
	};
}
function readTelephonyModelOverrides(ttsConfig) {
	const value = ttsConfig?.modelOverrides;
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function normalizeProviderId(value) {
	return typeof value === "string" ? value.trim().toLowerCase() || void 0 : void 0;
}
function asProviderConfig(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function collectTelephonyProviderConfigs(ttsConfig) {
	if (!ttsConfig) return {};
	const entries = {};
	const rawProviders = ttsConfig.providers && typeof ttsConfig.providers === "object" && !Array.isArray(ttsConfig.providers) ? ttsConfig.providers : {};
	for (const [providerId, value] of Object.entries(rawProviders)) {
		const normalized = normalizeProviderId(providerId) ?? providerId;
		entries[normalized] = asProviderConfig(value);
	}
	const reservedKeys = new Set([
		"auto",
		"enabled",
		"maxTextLength",
		"mode",
		"modelOverrides",
		"persona",
		"personas",
		"prefsPath",
		"provider",
		"providers",
		"summaryModel",
		"timeoutMs"
	]);
	for (const [key, value] of Object.entries(ttsConfig)) {
		if (reservedKeys.has(key) || typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const normalized = normalizeProviderId(key) ?? key;
		entries[normalized] ??= asProviderConfig(value);
	}
	return entries;
}
//#endregion
//#region extensions/voice-call/src/webhook/tailscale.ts
function runTailscaleCommand(args, timeoutMs = 2500) {
	return new Promise((resolve) => {
		const proc = spawn("tailscale", args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let settled = false;
		let timer;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		proc.stdout.on("data", (data) => {
			stdout += data;
		});
		timer = setTimeout(() => {
			proc.kill("SIGKILL");
			finish({
				code: -1,
				stdout: ""
			});
		}, timeoutMs);
		proc.on("error", () => {
			finish({
				code: -1,
				stdout: ""
			});
		});
		proc.on("close", (code) => {
			finish({
				code: code ?? -1,
				stdout
			});
		});
	});
}
async function getTailscaleSelfInfo() {
	const { code, stdout } = await runTailscaleCommand(["status", "--json"]);
	if (code !== 0) return null;
	try {
		const status = JSON.parse(stdout);
		return {
			dnsName: status.Self?.DNSName?.replace(/\.$/, "") || null,
			nodeId: status.Self?.ID || null
		};
	} catch {
		return null;
	}
}
async function getTailscaleDnsName() {
	return (await getTailscaleSelfInfo())?.dnsName ?? null;
}
async function setupTailscaleExposureRoute(opts) {
	const dnsName = await getTailscaleDnsName();
	if (!dnsName) {
		console.warn("[voice-call] Could not get Tailscale DNS name");
		return null;
	}
	const { code } = await runTailscaleCommand([
		opts.mode,
		"--bg",
		"--yes",
		"--set-path",
		opts.path,
		opts.localUrl
	]);
	if (code === 0) {
		const publicUrl = `https://${dnsName}${opts.path}`;
		console.log(`[voice-call] Tailscale ${opts.mode} active: ${publicUrl}`);
		return publicUrl;
	}
	console.warn(`[voice-call] Tailscale ${opts.mode} failed`);
	return null;
}
async function cleanupTailscaleExposureRoute(opts) {
	await runTailscaleCommand([
		opts.mode,
		"off",
		opts.path
	]);
}
async function setupTailscaleExposure(config) {
	if (config.tailscale.mode === "off") return null;
	const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
	const localUrl = `http://127.0.0.1:${config.serve.port}${config.serve.path}`;
	return setupTailscaleExposureRoute({
		mode,
		path: config.tailscale.path,
		localUrl
	});
}
async function cleanupTailscaleExposure(config) {
	if (config.tailscale.mode === "off") return;
	await cleanupTailscaleExposureRoute({
		mode: config.tailscale.mode === "funnel" ? "funnel" : "serve",
		path: config.tailscale.path
	});
}
//#endregion
//#region extensions/voice-call/src/tunnel.ts
/**
* Start an ngrok tunnel to expose the local webhook server.
*
* Uses the ngrok CLI which must be installed: https://ngrok.com/download
*
* @example
* const tunnel = await startNgrokTunnel({ port: 3334, path: '/voice/webhook' });
* console.log('Public URL:', tunnel.publicUrl);
* // Later: await tunnel.stop();
*/
async function startNgrokTunnel(config) {
	if (config.authToken) await runNgrokCommand([
		"config",
		"add-authtoken",
		config.authToken
	]);
	const args = [
		"http",
		String(config.port),
		"--log",
		"stdout",
		"--log-format",
		"json"
	];
	if (config.domain) args.push("--domain", config.domain);
	return new Promise((resolve, reject) => {
		const proc = spawn("ngrok", args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let resolved = false;
		let publicUrl = null;
		let outputBuffer = "";
		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				proc.kill("SIGTERM");
				reject(/* @__PURE__ */ new Error("ngrok startup timed out (30s)"));
			}
		}, 3e4);
		const processLine = (line) => {
			try {
				const log = JSON.parse(line);
				if (log.msg === "started tunnel" && log.url) publicUrl = log.url;
				if (log.addr && log.url && !publicUrl) publicUrl = log.url;
				if (publicUrl && !resolved) {
					resolved = true;
					clearTimeout(timeout);
					const fullUrl = publicUrl + config.path;
					console.log(`[voice-call] ngrok tunnel active: ${fullUrl}`);
					resolve({
						publicUrl: fullUrl,
						provider: "ngrok",
						stop: async () => {
							proc.kill("SIGTERM");
							await new Promise((res) => {
								proc.on("close", () => res());
								setTimeout(res, 2e3);
							});
						}
					});
				}
			} catch {}
		};
		proc.stdout.on("data", (data) => {
			outputBuffer += data.toString();
			const lines = outputBuffer.split("\n");
			outputBuffer = lines.pop() || "";
			for (const line of lines) if (line.trim()) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			const msg = data.toString();
			if (msg.includes("ERR_NGROK")) {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeout);
					reject(/* @__PURE__ */ new Error(`ngrok error: ${msg}`));
				}
			}
		});
		proc.on("error", (err) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				reject(/* @__PURE__ */ new Error(`Failed to start ngrok: ${err.message}`));
			}
		});
		proc.on("close", (code) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				reject(/* @__PURE__ */ new Error(`ngrok exited unexpectedly with code ${code}`));
			}
		});
	});
}
/**
* Run an ngrok command and wait for completion.
*/
async function runNgrokCommand(args) {
	return new Promise((resolve, reject) => {
		const proc = spawn("ngrok", args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(/* @__PURE__ */ new Error(`ngrok command failed: ${stderr || stdout}`));
		});
		proc.on("error", reject);
	});
}
/**
* Start a Tailscale serve/funnel tunnel.
*/
async function startTailscaleTunnel(config) {
	const dnsName = await getTailscaleDnsName();
	if (!dnsName) throw new Error("Could not get Tailscale DNS name. Is Tailscale running?");
	const path = config.path.startsWith("/") ? config.path : `/${config.path}`;
	const localUrl = `http://127.0.0.1:${config.port}${path}`;
	return new Promise((resolve, reject) => {
		const proc = spawn("tailscale", [
			config.mode,
			"--bg",
			"--yes",
			"--set-path",
			path,
			localUrl
		], { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		const timeout = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(/* @__PURE__ */ new Error(`Tailscale ${config.mode} timed out`));
		}, 1e4);
		proc.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) {
				const publicUrl = `https://${dnsName}${path}`;
				console.log(`[voice-call] Tailscale ${config.mode} active: ${publicUrl}`);
				resolve({
					publicUrl,
					provider: `tailscale-${config.mode}`,
					stop: async () => {
						await stopTailscaleTunnel(config.mode, path);
					}
				});
			} else reject(/* @__PURE__ */ new Error(`Tailscale ${config.mode} failed with code ${code}`));
		});
		proc.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}
/**
* Stop a Tailscale serve/funnel tunnel.
*/
async function stopTailscaleTunnel(mode, path) {
	return new Promise((resolve) => {
		const proc = spawn("tailscale", [
			mode,
			"off",
			path
		], { stdio: "ignore" });
		const timeout = setTimeout(() => {
			proc.kill("SIGKILL");
			resolve();
		}, 5e3);
		proc.on("close", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
}
/**
* Start a tunnel based on configuration.
*/
async function startTunnel(config) {
	switch (config.provider) {
		case "ngrok": return startNgrokTunnel({
			port: config.port,
			path: config.path,
			authToken: config.ngrokAuthToken,
			domain: config.ngrokDomain
		});
		case "tailscale-serve": return startTailscaleTunnel({
			mode: "serve",
			port: config.port,
			path: config.path
		});
		case "tailscale-funnel": return startTailscaleTunnel({
			mode: "funnel",
			port: config.port,
			path: config.path
		});
		default: return null;
	}
}
//#endregion
//#region extensions/voice-call/src/webhook-exposure.ts
function providerRequiresPublicWebhook(providerName) {
	return providerName === "twilio" || providerName === "telnyx" || providerName === "plivo";
}
function isLocalOnlyWebhookHost(hostname) {
	return isBlockedHostnameOrIp(hostname);
}
function isProviderUnreachableWebhookUrl(webhookUrl) {
	try {
		return isLocalOnlyWebhookHost(new URL(webhookUrl).hostname);
	} catch {
		return false;
	}
}
function resolveWebhookExposureStatus(config) {
	if (config.provider === "mock") return {
		ok: true,
		configured: true,
		message: "Mock provider does not need a public webhook"
	};
	if (config.publicUrl) {
		if (isProviderUnreachableWebhookUrl(config.publicUrl)) return {
			ok: false,
			configured: true,
			message: `Public webhook URL is local/private and cannot be reached by ${config.provider ?? "the provider"}: ${config.publicUrl}`
		};
		return {
			ok: true,
			configured: true,
			message: `Public webhook URL configured: ${config.publicUrl}`
		};
	}
	if (config.tunnel?.provider && config.tunnel.provider !== "none") return {
		ok: true,
		configured: true,
		message: "Webhook exposure configured through tunnel"
	};
	if (config.tailscale?.mode && config.tailscale.mode !== "off") return {
		ok: true,
		configured: true,
		message: "Webhook exposure configured through Tailscale"
	};
	return {
		ok: false,
		configured: false,
		message: "Set publicUrl or configure tunnel/tailscale so the provider can reach webhooks"
	};
}
//#endregion
//#region extensions/voice-call/src/media-stream.ts
const DEFAULT_PRE_START_TIMEOUT_MS = 5e3;
const DEFAULT_MAX_PENDING_CONNECTIONS = 32;
const DEFAULT_MAX_PENDING_CONNECTIONS_PER_IP = 4;
const DEFAULT_MAX_CONNECTIONS = 128;
const MAX_INBOUND_MESSAGE_BYTES = 64 * 1024;
const MAX_WS_BUFFERED_BYTES = 1024 * 1024;
const CLOSE_REASON_LOG_MAX_CHARS = 120;
function sanitizeLogText(value, maxChars) {
	const sanitized = value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
	if (sanitized.length <= maxChars) return sanitized;
	return `${sanitized.slice(0, maxChars)}...`;
}
function normalizeWsMessageData(data) {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}
function parseTwilioMediaMessage(data) {
	const raw = normalizeWsMessageData(data);
	try {
		return JSON.parse(raw.toString("utf8"));
	} catch (cause) {
		throw new Error("Twilio media stream message was malformed JSON", { cause });
	}
}
/**
* Manages WebSocket connections for Twilio media streams.
*/
var MediaStreamHandler = class {
	constructor(config) {
		this.wss = null;
		this.sessions = /* @__PURE__ */ new Map();
		this.pendingConnections = /* @__PURE__ */ new Map();
		this.pendingByIp = /* @__PURE__ */ new Map();
		this.inflightUpgrades = 0;
		this.ttsQueues = /* @__PURE__ */ new Map();
		this.ttsPlaying = /* @__PURE__ */ new Map();
		this.ttsActiveControllers = /* @__PURE__ */ new Map();
		this.config = config;
		this.preStartTimeoutMs = config.preStartTimeoutMs ?? DEFAULT_PRE_START_TIMEOUT_MS;
		this.maxPendingConnections = config.maxPendingConnections ?? DEFAULT_MAX_PENDING_CONNECTIONS;
		this.maxPendingConnectionsPerIp = config.maxPendingConnectionsPerIp ?? DEFAULT_MAX_PENDING_CONNECTIONS_PER_IP;
		this.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
	}
	/**
	* Handle WebSocket upgrade for media stream connections.
	*/
	handleUpgrade(request, socket, head) {
		if (!this.wss) {
			this.wss = new WebSocketServer({
				noServer: true,
				maxPayload: MAX_INBOUND_MESSAGE_BYTES
			});
			this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
		}
		if (this.getCurrentConnectionCount() >= this.maxConnections) {
			this.rejectUpgrade(socket, 503, "Too many media stream connections");
			return;
		}
		this.inflightUpgrades += 1;
		let released = false;
		const releaseUpgradeReservation = () => {
			if (released) return;
			released = true;
			this.inflightUpgrades = Math.max(0, this.inflightUpgrades - 1);
		};
		const handleUpgradeAbort = () => {
			socket.removeListener("error", handleUpgradeAbort);
			socket.removeListener("close", handleUpgradeAbort);
			releaseUpgradeReservation();
		};
		socket.once("error", handleUpgradeAbort);
		socket.once("close", handleUpgradeAbort);
		try {
			this.wss.handleUpgrade(request, socket, head, (ws) => {
				socket.removeListener("error", handleUpgradeAbort);
				socket.removeListener("close", handleUpgradeAbort);
				releaseUpgradeReservation();
				this.wss?.emit("connection", ws, request);
			});
		} catch (error) {
			socket.removeListener("error", handleUpgradeAbort);
			socket.removeListener("close", handleUpgradeAbort);
			releaseUpgradeReservation();
			throw error;
		}
	}
	/**
	* Handle new WebSocket connection from Twilio.
	*/
	async handleConnection(ws, _request) {
		let session = null;
		const streamToken = this.getStreamToken(_request);
		const ip = this.getClientIp(_request);
		if (!this.registerPendingConnection(ws, ip)) {
			ws.close(1013, "Too many pending media stream connections");
			return;
		}
		ws.on("message", async (data) => {
			try {
				const message = parseTwilioMediaMessage(data);
				switch (message.event) {
					case "connected":
						console.log("[MediaStream] Twilio connected");
						break;
					case "start":
						session = this.handleStart(ws, message, streamToken);
						if (session) this.clearPendingConnection(ws);
						break;
					case "media":
						if (session && message.media?.payload) {
							const audioBuffer = Buffer.from(message.media.payload, "base64");
							const turnId = this.ensureActiveTurn(session);
							this.emitTalkEvent(session, {
								type: "input.audio.delta",
								turnId,
								payload: {
									callId: session.callId,
									streamSid: session.streamSid,
									bytes: audioBuffer.byteLength
								}
							});
							session.sttSession.sendAudio(audioBuffer);
						}
						break;
					case "stop":
						if (session) {
							this.handleStop(session);
							session = null;
						}
						break;
					case "clear":
					case "mark": break;
				}
			} catch (error) {
				console.error("[MediaStream] Error processing message:", error);
			}
		});
		ws.on("close", (code, reason) => {
			const reasonText = sanitizeLogText(Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || ""), CLOSE_REASON_LOG_MAX_CHARS);
			console.log(`[MediaStream] WebSocket closed (code: ${code}, reason: ${reasonText || "none"})`);
			this.clearPendingConnection(ws);
			if (session) this.handleStop(session);
		});
		ws.on("error", (error) => {
			console.error("[MediaStream] WebSocket error:", error);
		});
	}
	/**
	* Handle stream start event.
	*/
	handleStart(ws, message, streamToken) {
		const streamSid = message.streamSid || "";
		const callSid = message.start?.callSid || "";
		const effectiveToken = message.start?.customParameters?.token ?? streamToken;
		console.log(`[MediaStream] Stream started: ${streamSid} (call: ${callSid})`);
		if (!callSid) {
			console.warn("[MediaStream] Missing callSid; closing stream");
			ws.close(1008, "Missing callSid");
			return null;
		}
		if (this.config.shouldAcceptStream && !this.config.shouldAcceptStream({
			callId: callSid,
			streamSid,
			token: effectiveToken
		})) {
			console.warn(`[MediaStream] Rejecting stream for unknown call: ${callSid}`);
			ws.close(1008, "Unknown call");
			return null;
		}
		const session = {
			callId: callSid,
			streamSid,
			ws,
			sttSession: this.config.transcriptionProvider.createSession({
				cfg: this.config.cfg,
				providerConfig: this.config.providerConfig,
				onPartial: (partial) => {
					const session = this.sessions.get(streamSid);
					if (session) this.emitTalkEvent(session, {
						type: "transcript.delta",
						turnId: this.ensureActiveTurn(session),
						payload: {
							callId: callSid,
							streamSid,
							text: partial,
							role: "user"
						}
					});
					this.config.onPartialTranscript?.(callSid, partial);
				},
				onTranscript: (transcript) => {
					const session = this.sessions.get(streamSid);
					if (session) {
						const turnId = this.ensureActiveTurn(session);
						this.emitTalkEvent(session, {
							type: "input.audio.committed",
							turnId,
							final: true,
							payload: {
								callId: callSid,
								streamSid
							}
						});
						this.emitTalkEvent(session, {
							type: "transcript.done",
							turnId,
							final: true,
							payload: {
								callId: callSid,
								streamSid,
								text: transcript,
								role: "user"
							}
						});
					}
					this.config.onTranscript?.(callSid, transcript);
				},
				onSpeechStart: () => {
					const session = this.sessions.get(streamSid);
					if (session) this.ensureActiveTurn(session);
					this.config.onSpeechStart?.(callSid);
				},
				onError: (error) => {
					console.warn("[MediaStream] Transcription session error:", error.message);
					const session = this.sessions.get(streamSid);
					if (session) this.emitTalkEvent(session, {
						type: "session.error",
						final: true,
						payload: {
							callId: callSid,
							streamSid,
							error: error.message
						}
					});
				}
			}),
			talk: this.createTalkEvents(callSid, streamSid)
		};
		this.sessions.set(streamSid, session);
		this.config.onConnect?.(callSid, streamSid);
		this.emitTalkEvent(session, {
			type: "session.started",
			payload: {
				callId: callSid,
				streamSid,
				provider: this.config.transcriptionProvider.id
			}
		});
		this.connectTranscriptionAndNotify(session);
		return session;
	}
	async connectTranscriptionAndNotify(session) {
		try {
			await session.sttSession.connect();
		} catch (error) {
			console.warn("[MediaStream] STT connection failed; closing media stream:", error instanceof Error ? error.message : String(error));
			this.emitTalkEvent(session, {
				type: "session.error",
				final: true,
				payload: {
					callId: session.callId,
					streamSid: session.streamSid,
					error: error instanceof Error ? error.message : String(error)
				}
			});
			if (this.sessions.get(session.streamSid) === session && session.ws.readyState === WebSocket$1.OPEN) session.ws.close(1011, "STT connection failed");
			else session.sttSession.close();
			return;
		}
		if (this.sessions.get(session.streamSid) !== session || session.ws.readyState !== WebSocket$1.OPEN) {
			session.sttSession.close();
			return;
		}
		this.emitTalkEvent(session, {
			type: "session.ready",
			payload: {
				callId: session.callId,
				streamSid: session.streamSid
			}
		});
		this.config.onTranscriptionReady?.(session.callId, session.streamSid);
	}
	/**
	* Handle stream stop event.
	*/
	handleStop(session) {
		console.log(`[MediaStream] Stream stopped: ${session.streamSid}`);
		this.clearTtsState(session.streamSid);
		session.sttSession.close();
		this.sessions.delete(session.streamSid);
		this.emitTalkEvent(session, {
			type: "session.closed",
			final: true,
			payload: {
				callId: session.callId,
				streamSid: session.streamSid
			}
		});
		this.config.onDisconnect?.(session.callId, session.streamSid);
	}
	getStreamToken(request) {
		if (!request.url || !request.headers.host) return;
		try {
			return new URL(request.url, `http://${request.headers.host}`).searchParams.get("token") ?? void 0;
		} catch {
			return;
		}
	}
	getClientIp(request) {
		const resolvedIp = this.config.resolveClientIp?.(request)?.trim();
		if (resolvedIp) return resolvedIp;
		return request.socket.remoteAddress || "unknown";
	}
	getCurrentConnectionCount() {
		return this.wss ? this.wss.clients.size + this.inflightUpgrades : this.inflightUpgrades;
	}
	registerPendingConnection(ws, ip) {
		if (this.pendingConnections.size >= this.maxPendingConnections) {
			console.warn("[MediaStream] Rejecting connection: pending connection limit reached");
			return false;
		}
		const pendingForIp = this.pendingByIp.get(ip) ?? 0;
		if (pendingForIp >= this.maxPendingConnectionsPerIp) {
			console.warn(`[MediaStream] Rejecting connection: pending per-IP limit reached (${ip})`);
			return false;
		}
		const timeout = setTimeout(() => {
			if (!this.pendingConnections.has(ws)) return;
			console.warn(`[MediaStream] Closing pre-start idle connection after ${this.preStartTimeoutMs}ms (${ip})`);
			ws.close(1008, "Start timeout");
		}, this.preStartTimeoutMs);
		timeout.unref?.();
		this.pendingConnections.set(ws, {
			ip,
			timeout
		});
		this.pendingByIp.set(ip, pendingForIp + 1);
		return true;
	}
	clearPendingConnection(ws) {
		const pending = this.pendingConnections.get(ws);
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.pendingConnections.delete(ws);
		const current = this.pendingByIp.get(pending.ip) ?? 0;
		if (current <= 1) {
			this.pendingByIp.delete(pending.ip);
			return;
		}
		this.pendingByIp.set(pending.ip, current - 1);
	}
	rejectUpgrade(socket, statusCode, message) {
		const statusText = statusCode === 429 ? "Too Many Requests" : "Service Unavailable";
		const body = `${message}\n`;
		socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r
Content-Type: text/plain; charset=utf-8\r
Content-Length: ${Buffer.byteLength(body)}\r\n\r
` + body);
		socket.destroy();
	}
	/**
	* Get an active session with an open WebSocket, or undefined if unavailable.
	*/
	getOpenSession(streamSid) {
		const session = this.sessions.get(streamSid);
		return session?.ws.readyState === WebSocket$1.OPEN ? session : void 0;
	}
	/**
	* Send a message to a stream's WebSocket if available.
	*/
	sendToStream(streamSid, message) {
		const session = this.sessions.get(streamSid);
		if (!session) return {
			sent: false,
			bufferedBeforeBytes: 0,
			bufferedAfterBytes: 0
		};
		const readyState = session.ws.readyState;
		const bufferedBeforeBytes = session.ws.bufferedAmount;
		if (readyState !== WebSocket$1.OPEN) return {
			sent: false,
			readyState,
			bufferedBeforeBytes,
			bufferedAfterBytes: session.ws.bufferedAmount
		};
		if (bufferedBeforeBytes > MAX_WS_BUFFERED_BYTES) {
			try {
				session.ws.close(1013, "Backpressure: send buffer exceeded");
			} catch {}
			return {
				sent: false,
				readyState,
				bufferedBeforeBytes,
				bufferedAfterBytes: session.ws.bufferedAmount
			};
		}
		try {
			session.ws.send(JSON.stringify(message));
			const bufferedAfterBytes = session.ws.bufferedAmount;
			if (bufferedAfterBytes > MAX_WS_BUFFERED_BYTES) {
				try {
					session.ws.close(1013, "Backpressure: send buffer exceeded");
				} catch {}
				return {
					sent: false,
					readyState,
					bufferedBeforeBytes,
					bufferedAfterBytes
				};
			}
			return {
				sent: true,
				readyState,
				bufferedBeforeBytes,
				bufferedAfterBytes
			};
		} catch {
			return {
				sent: false,
				readyState,
				bufferedBeforeBytes,
				bufferedAfterBytes: session.ws.bufferedAmount
			};
		}
	}
	/**
	* Send audio to a specific stream (for TTS playback).
	* Audio should be mu-law encoded at 8kHz mono.
	*/
	sendAudio(streamSid, muLawAudio) {
		const session = this.getOpenSession(streamSid);
		if (session) this.emitTalkEvent(session, {
			type: "output.audio.delta",
			turnId: this.ensureActiveTurn(session),
			payload: {
				callId: session.callId,
				streamSid,
				bytes: muLawAudio.byteLength
			}
		});
		return this.sendToStream(streamSid, {
			event: "media",
			streamSid,
			media: { payload: muLawAudio.toString("base64") }
		});
	}
	/**
	* Send a mark event to track audio playback position.
	*/
	sendMark(streamSid, name) {
		return this.sendToStream(streamSid, {
			event: "mark",
			streamSid,
			mark: { name }
		});
	}
	/**
	* Clear audio buffer (interrupt playback).
	*/
	clearAudio(streamSid) {
		return this.sendToStream(streamSid, {
			event: "clear",
			streamSid
		});
	}
	/**
	* Queue a TTS operation for sequential playback.
	* Only one TTS operation plays at a time per stream to prevent overlap.
	*/
	async queueTts(streamSid, playFn) {
		const queue = this.getTtsQueue(streamSid);
		let resolveEntry;
		let rejectEntry;
		const promise = new Promise((resolve, reject) => {
			resolveEntry = resolve;
			rejectEntry = reject;
		});
		queue.push({
			playFn,
			controller: new AbortController(),
			resolve: resolveEntry,
			reject: rejectEntry
		});
		if (!this.ttsPlaying.get(streamSid)) this.processQueue(streamSid);
		return promise;
	}
	/**
	* Clear TTS queue and interrupt current playback (barge-in).
	*/
	clearTtsQueue(streamSid, _reason = "unspecified") {
		const queue = this.getTtsQueue(streamSid);
		this.resolveQueuedTtsEntries(queue);
		this.ttsActiveControllers.get(streamSid)?.abort();
		const session = this.sessions.get(streamSid);
		if (session?.talk.activeTurnId) {
			const cancelled = session.talk.cancelTurn({ payload: {
				callId: session.callId,
				streamSid,
				reason: _reason
			} });
			if (cancelled.ok) this.config.onTalkEvent?.(session.callId, session.streamSid, cancelled.event);
		}
		this.clearAudio(streamSid);
	}
	/**
	* Get active session by call ID.
	*/
	getSessionByCallId(callId) {
		return [...this.sessions.values()].find((session) => session.callId === callId);
	}
	/**
	* Close all sessions.
	*/
	closeAll() {
		for (const session of this.sessions.values()) {
			this.clearTtsState(session.streamSid);
			session.sttSession.close();
			session.ws.close();
		}
		this.sessions.clear();
	}
	getTtsQueue(streamSid) {
		const existing = this.ttsQueues.get(streamSid);
		if (existing) return existing;
		const queue = [];
		this.ttsQueues.set(streamSid, queue);
		return queue;
	}
	/**
	* Process the TTS queue for a stream.
	* Uses iterative approach to avoid stack accumulation from recursion.
	*/
	async processQueue(streamSid) {
		this.ttsPlaying.set(streamSid, true);
		while (true) {
			const queue = this.ttsQueues.get(streamSid);
			if (!queue || queue.length === 0) {
				this.ttsPlaying.set(streamSid, false);
				this.ttsActiveControllers.delete(streamSid);
				return;
			}
			const entry = queue.shift();
			this.ttsActiveControllers.set(streamSid, entry.controller);
			const session = this.sessions.get(streamSid);
			let playbackTurnId;
			try {
				if (session) {
					playbackTurnId = this.ensureActiveTurn(session);
					this.emitTalkEvent(session, {
						type: "output.audio.started",
						turnId: playbackTurnId,
						payload: {
							callId: session.callId,
							streamSid
						}
					});
				}
				await entry.playFn(entry.controller.signal);
				if (entry.controller.signal.aborted) {
					entry.resolve();
					continue;
				}
				if (session) {
					const turnId = playbackTurnId ?? this.ensureActiveTurn(session);
					this.emitTalkEvent(session, {
						type: "output.audio.done",
						turnId,
						final: true,
						payload: {
							callId: session.callId,
							streamSid
						}
					});
					if (session.talk.activeTurnId) {
						const ended = session.talk.endTurn({ payload: {
							callId: session.callId,
							streamSid
						} });
						if (ended.ok) this.config.onTalkEvent?.(session.callId, session.streamSid, ended.event);
					}
				}
				entry.resolve();
			} catch (error) {
				if (entry.controller.signal.aborted) entry.resolve();
				else {
					console.error("[MediaStream] TTS playback error:", error);
					entry.reject(error);
				}
			} finally {
				if (this.ttsActiveControllers.get(streamSid) === entry.controller) this.ttsActiveControllers.delete(streamSid);
			}
		}
	}
	createTalkEvents(callId, streamSid) {
		return createTalkSessionController({
			sessionId: `voice-call:${callId}:${streamSid}`,
			mode: "stt-tts",
			transport: "gateway-relay",
			brain: "agent-consult",
			provider: this.config.transcriptionProvider.id,
			turnIdPrefix: `${streamSid}:turn`
		}, { onEvent: recordTalkObservabilityEvent });
	}
	emitTalkEvent(session, input) {
		const event = session.talk.emit(input);
		this.config.onTalkEvent?.(session.callId, session.streamSid, event);
	}
	ensureActiveTurn(session) {
		const turn = session.talk.ensureTurn({ payload: {
			callId: session.callId,
			streamSid: session.streamSid
		} });
		if (turn.event) this.config.onTalkEvent?.(session.callId, session.streamSid, turn.event);
		return turn.turnId;
	}
	clearTtsState(streamSid) {
		const queue = this.ttsQueues.get(streamSid);
		if (queue) this.resolveQueuedTtsEntries(queue);
		this.ttsActiveControllers.get(streamSid)?.abort();
		this.ttsActiveControllers.delete(streamSid);
		this.ttsPlaying.delete(streamSid);
		this.ttsQueues.delete(streamSid);
	}
	resolveQueuedTtsEntries(queue) {
		const pending = queue.splice(0);
		for (const entry of pending) {
			entry.controller.abort();
			entry.resolve();
		}
	}
};
//#endregion
//#region extensions/voice-call/src/webhook/stale-call-reaper.ts
const CHECK_INTERVAL_MS = 3e4;
function startStaleCallReaper(params) {
	const maxAgeSeconds = params.staleCallReaperSeconds;
	if (!maxAgeSeconds || maxAgeSeconds <= 0) return null;
	const maxAgeMs = maxAgeSeconds * 1e3;
	const interval = setInterval(() => {
		const now = Date.now();
		for (const call of params.manager.getActiveCalls()) {
			if (call.answeredAt || TerminalStates.has(call.state)) continue;
			const age = now - call.startedAt;
			if (age > maxAgeMs) {
				console.log(`[voice-call] Reaping stale call ${call.callId} (age: ${Math.round(age / 1e3)}s, state: ${call.state})`);
				params.manager.endCall(call.callId).catch((err) => {
					console.warn(`[voice-call] Reaper failed to end call ${call.callId}:`, err);
				});
			}
		}
	}, CHECK_INTERVAL_MS);
	return () => {
		clearInterval(interval);
	};
}
//#endregion
//#region extensions/voice-call/src/webhook.ts
const MAX_WEBHOOK_BODY_BYTES = WEBHOOK_BODY_READ_DEFAULTS.preAuth.maxBytes;
const WEBHOOK_BODY_TIMEOUT_MS = WEBHOOK_BODY_READ_DEFAULTS.preAuth.timeoutMs;
const MISSING_REMOTE_ADDRESS_IN_FLIGHT_KEY = "__voice_call_no_remote__";
const STREAM_DISCONNECT_HANGUP_GRACE_MS = 2e3;
const TRANSCRIPT_LOG_MAX_CHARS = 200;
let realtimeTranscriptionRuntimePromise;
let responseGeneratorModulePromise;
function loadRealtimeTranscriptionRuntime() {
	realtimeTranscriptionRuntimePromise ??= import("./realtime-transcription.runtime.js");
	return realtimeTranscriptionRuntimePromise;
}
function loadResponseGeneratorModule() {
	responseGeneratorModulePromise ??= import("./response-generator-DUpTqSXz.js");
	return responseGeneratorModulePromise;
}
function sanitizeTranscriptForLog(value) {
	const sanitized = value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
	if (sanitized.length <= TRANSCRIPT_LOG_MAX_CHARS) return sanitized;
	return `${sanitized.slice(0, TRANSCRIPT_LOG_MAX_CHARS)}...`;
}
function appendRecentTalkEventMetadata(call, event) {
	const metadata = call.metadata ?? {};
	const recent = Array.isArray(metadata.recentTalkEvents) ? metadata.recentTalkEvents.filter((entry) => !!entry && typeof entry === "object" && !Array.isArray(entry)) : [];
	recent.push({
		at: event.timestamp,
		type: event.type,
		sessionId: event.sessionId,
		turnId: event.turnId
	});
	call.metadata = {
		...metadata,
		lastTalkEventAt: event.timestamp,
		lastTalkEventType: event.type,
		recentTalkEvents: recent.slice(-10)
	};
}
function buildRequestUrl(requestUrl) {
	return new URL$1(requestUrl ?? "/", "http://localhost");
}
function normalizeProxyIp(value) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	const normalized = (trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed).toLowerCase();
	if (normalized.startsWith("::ffff:")) {
		const mappedIpv4 = normalized.slice(7);
		if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(mappedIpv4)) return mappedIpv4;
	}
	return normalized;
}
function resolveForwardedClientIp(request, trustedProxyIPs) {
	const normalizedTrustedProxyIps = new Set(trustedProxyIPs.map((ip) => normalizeProxyIp(ip)).filter((ip) => Boolean(ip)));
	const forwardedFor = getHeader(request.headers, "x-forwarded-for");
	if (forwardedFor) {
		const forwardedIps = forwardedFor.split(",").map((part) => part.trim()).filter(Boolean);
		if (forwardedIps.length > 0) {
			if (normalizedTrustedProxyIps.size === 0) return forwardedIps[0];
			for (let index = forwardedIps.length - 1; index >= 0; index -= 1) {
				const hop = forwardedIps[index];
				if (!normalizedTrustedProxyIps.has(normalizeProxyIp(hop) ?? "")) return hop;
			}
			return forwardedIps[0];
		}
	}
	return getHeader(request.headers, "x-real-ip")?.trim() || void 0;
}
function normalizeWebhookResponse(parsed) {
	return {
		statusCode: parsed.statusCode ?? 200,
		headers: parsed.providerResponseHeaders,
		body: parsed.providerResponseBody ?? "OK"
	};
}
function buildRealtimeRejectedTwiML() {
	return {
		statusCode: 200,
		headers: { "Content-Type": "text/xml" },
		body: "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Reject reason=\"rejected\" /></Response>"
	};
}
/**
* HTTP server for receiving voice call webhooks from providers.
* Supports WebSocket upgrades for media streams when streaming is enabled.
*/
var VoiceCallWebhookServer = class {
	constructor(config, manager, provider, coreConfig, fullConfig, agentRuntime, logger) {
		this.server = null;
		this.listeningUrl = null;
		this.startPromise = null;
		this.stopStaleCallReaper = null;
		this.webhookInFlightLimiter = createWebhookInFlightLimiter();
		this.mediaStreamHandler = null;
		this.pendingDisconnectHangups = /* @__PURE__ */ new Map();
		this.realtimeHandler = null;
		this.config = normalizeVoiceCallConfig(config);
		this.manager = manager;
		this.provider = provider;
		this.coreConfig = coreConfig ?? null;
		this.fullConfig = fullConfig ?? null;
		this.agentRuntime = agentRuntime ?? null;
		this.logger = logger ?? {
			info: console.log,
			warn: console.warn,
			error: console.error,
			debug: console.debug
		};
	}
	/**
	* Get the media stream handler (for wiring to provider).
	*/
	getMediaStreamHandler() {
		return this.mediaStreamHandler;
	}
	getRealtimeHandler() {
		return this.realtimeHandler;
	}
	speakRealtime(callId, instructions) {
		if (!this.realtimeHandler) return {
			success: false,
			error: "Realtime voice handler is not configured"
		};
		return this.realtimeHandler.speak(callId, instructions);
	}
	setRealtimeHandler(handler) {
		this.realtimeHandler = handler;
	}
	clearPendingDisconnectHangup(providerCallId) {
		const existing = this.pendingDisconnectHangups.get(providerCallId);
		if (!existing) return;
		clearTimeout(existing);
		this.pendingDisconnectHangups.delete(providerCallId);
	}
	resolveMediaStreamClientIp(request) {
		const remoteIp = request.socket.remoteAddress ?? void 0;
		const trustedProxyIPs = this.config.webhookSecurity.trustedProxyIPs.filter(Boolean);
		const normalizedTrustedProxyIps = new Set(trustedProxyIPs.map((ip) => normalizeProxyIp(ip)).filter((ip) => Boolean(ip)));
		const normalizedRemoteIp = normalizeProxyIp(remoteIp);
		const fromTrustedProxy = normalizedTrustedProxyIps.size > 0 && normalizedRemoteIp !== void 0 && normalizedTrustedProxyIps.has(normalizedRemoteIp);
		if (this.config.webhookSecurity.trustForwardingHeaders && fromTrustedProxy) {
			const forwardedIp = resolveForwardedClientIp(request, trustedProxyIPs);
			if (forwardedIp) return forwardedIp;
		}
		return remoteIp;
	}
	shouldSuppressBargeInForInitialMessage(call) {
		if (!call || call.direction !== "outbound") return false;
		if (call.state !== "speaking") return false;
		if ((call.metadata?.mode ?? "conversation") !== "conversation") return false;
		return (normalizeOptionalString(call.metadata?.initialMessage) ?? "").length > 0;
	}
	/**
	* Initialize media streaming with the selected realtime transcription provider.
	*/
	async initializeMediaStreaming() {
		const streaming = this.config.streaming;
		const pluginConfig = this.fullConfig ?? this.coreConfig;
		const { getRealtimeTranscriptionProvider, listRealtimeTranscriptionProviders } = await loadRealtimeTranscriptionRuntime();
		const resolution = resolveConfiguredCapabilityProvider({
			configuredProviderId: streaming.provider,
			providerConfigs: streaming.providers,
			cfg: pluginConfig,
			cfgForResolve: pluginConfig ?? {},
			getConfiguredProvider: (providerId) => getRealtimeTranscriptionProvider(providerId, pluginConfig),
			listProviders: () => listRealtimeTranscriptionProviders(pluginConfig),
			resolveProviderConfig: ({ provider, cfg, rawConfig }) => provider.resolveConfig?.({
				cfg,
				rawConfig
			}) ?? rawConfig,
			isProviderConfigured: ({ provider, cfg, providerConfig }) => provider.isConfigured({
				cfg,
				providerConfig
			})
		});
		if (!resolution.ok && resolution.code === "missing-configured-provider") {
			console.warn(`[voice-call] Streaming enabled but realtime transcription provider "${resolution.configuredProviderId}" is not registered`);
			return;
		}
		if (!resolution.ok && resolution.code === "no-registered-provider") {
			console.warn("[voice-call] Streaming enabled but no realtime transcription provider is registered");
			return;
		}
		if (!resolution.ok) {
			console.warn(`[voice-call] Streaming enabled but provider "${resolution.provider?.id}" is not configured`);
			return;
		}
		const streamConfig = {
			transcriptionProvider: resolution.provider,
			providerConfig: resolution.providerConfig,
			cfg: this.fullConfig ?? this.coreConfig ?? void 0,
			preStartTimeoutMs: streaming.preStartTimeoutMs,
			maxPendingConnections: streaming.maxPendingConnections,
			maxPendingConnectionsPerIp: streaming.maxPendingConnectionsPerIp,
			maxConnections: streaming.maxConnections,
			resolveClientIp: (request) => this.resolveMediaStreamClientIp(request),
			shouldAcceptStream: ({ callId, token }) => {
				if (!this.manager.getCallByProviderCallId(callId)) return false;
				if (this.provider.name === "twilio") {
					if (!this.provider.isValidStreamToken(callId, token)) {
						console.warn(`[voice-call] Rejecting media stream: invalid token for ${callId}`);
						return false;
					}
				}
				return true;
			},
			onTranscript: (providerCallId, transcript) => {
				const safeTranscript = sanitizeTranscriptForLog(transcript);
				console.log(`[voice-call] Transcript for ${providerCallId}: ${safeTranscript} (chars=${transcript.length})`);
				const call = this.manager.getCallByProviderCallId(providerCallId);
				if (!call) {
					console.warn(`[voice-call] No active call found for provider ID: ${providerCallId}`);
					return;
				}
				if (this.shouldSuppressBargeInForInitialMessage(call)) {
					console.log(`[voice-call] Ignoring barge transcript while initial message is still playing (${providerCallId})`);
					return;
				}
				if (this.provider.name === "twilio") this.provider.clearTtsQueue(providerCallId);
				const event = {
					id: `stream-transcript-${Date.now()}`,
					type: "call.speech",
					callId: call.callId,
					providerCallId,
					timestamp: Date.now(),
					transcript,
					isFinal: true
				};
				this.manager.processEvent(event);
				const callMode = call.metadata?.mode;
				if (call.direction === "inbound" || callMode === "conversation") this.handleInboundResponse(call.callId, transcript).catch((err) => {
					console.warn(`[voice-call] Failed to auto-respond:`, err);
				});
			},
			onSpeechStart: (providerCallId) => {
				if (this.provider.name !== "twilio") return;
				const call = this.manager.getCallByProviderCallId(providerCallId);
				if (this.shouldSuppressBargeInForInitialMessage(call)) return;
				this.provider.clearTtsQueue(providerCallId);
			},
			onPartialTranscript: (callId, partial) => {
				const safePartial = sanitizeTranscriptForLog(partial);
				console.log(`[voice-call] Partial for ${callId}: ${safePartial} (chars=${partial.length})`);
			},
			onTalkEvent: (providerCallId, _streamSid, event) => {
				const call = this.manager.getCallByProviderCallId(providerCallId);
				if (call) appendRecentTalkEventMetadata(call, event);
			},
			onConnect: (callId, streamSid) => {
				console.log(`[voice-call] Media stream connected: ${callId} -> ${streamSid}`);
				this.clearPendingDisconnectHangup(callId);
				if (this.provider.name === "twilio") this.provider.registerCallStream(callId, streamSid);
			},
			onTranscriptionReady: (callId) => {
				this.manager.speakInitialMessage(callId).catch((err) => {
					console.warn(`[voice-call] Failed to speak initial message:`, err);
				});
			},
			onDisconnect: (callId, streamSid) => {
				console.log(`[voice-call] Media stream disconnected: ${callId} (${streamSid})`);
				if (this.provider.name === "twilio") this.provider.unregisterCallStream(callId, streamSid);
				this.clearPendingDisconnectHangup(callId);
				const timer = setTimeout(() => {
					this.pendingDisconnectHangups.delete(callId);
					const disconnectedCall = this.manager.getCallByProviderCallId(callId);
					if (!disconnectedCall) return;
					if (this.provider.name === "twilio") {
						if (this.provider.hasRegisteredStream(callId)) return;
					}
					console.log(`[voice-call] Auto-ending call ${disconnectedCall.callId} after stream disconnect grace`);
					this.manager.endCall(disconnectedCall.callId).catch((err) => {
						console.warn(`[voice-call] Failed to auto-end call ${disconnectedCall.callId}:`, err);
					});
				}, STREAM_DISCONNECT_HANGUP_GRACE_MS);
				timer.unref?.();
				this.pendingDisconnectHangups.set(callId, timer);
			}
		};
		this.mediaStreamHandler = new MediaStreamHandler(streamConfig);
		console.log("[voice-call] Media streaming initialized");
	}
	/**
	* Start the webhook server.
	* Idempotent: returns immediately if the server is already listening.
	*/
	async start() {
		const { port, bind, path: webhookPath } = this.config.serve;
		const streamPath = this.config.streaming.streamPath;
		if (this.server?.listening) return this.listeningUrl ?? this.resolveListeningUrl(bind, webhookPath);
		if (this.config.streaming.enabled && !this.mediaStreamHandler) await this.initializeMediaStreaming();
		if (this.startPromise) return this.startPromise;
		this.startPromise = new Promise((resolve, reject) => {
			this.server = http.createServer((req, res) => {
				this.handleRequest(req, res, webhookPath).catch((err) => {
					console.error("[voice-call] Webhook error:", err);
					res.statusCode = 500;
					res.end("Internal Server Error");
				});
			});
			if (this.realtimeHandler || this.mediaStreamHandler) this.server.on("upgrade", (request, socket, head) => {
				if (this.realtimeHandler && this.isRealtimeWebSocketUpgrade(request)) {
					this.realtimeHandler.handleWebSocketUpgrade(request, socket, head);
					return;
				}
				if (this.getUpgradePathname(request) === streamPath && this.mediaStreamHandler) this.mediaStreamHandler?.handleUpgrade(request, socket, head);
				else socket.destroy();
			});
			this.server.on("error", (err) => {
				this.server = null;
				this.listeningUrl = null;
				this.startPromise = null;
				reject(err);
			});
			this.server.listen(port, bind, () => {
				const url = this.resolveListeningUrl(bind, webhookPath);
				this.listeningUrl = url;
				this.startPromise = null;
				this.logger.info(`[voice-call] Webhook server listening on ${url}`);
				if (this.mediaStreamHandler) {
					const address = this.server?.address();
					const actualPort = address && typeof address === "object" ? address.port : this.config.serve.port;
					this.logger.info(`[voice-call] Media stream WebSocket on ws://${bind}:${actualPort}${streamPath}`);
				}
				resolve(url);
				this.stopStaleCallReaper = startStaleCallReaper({
					manager: this.manager,
					staleCallReaperSeconds: this.config.staleCallReaperSeconds
				});
			});
		});
		return this.startPromise;
	}
	/**
	* Stop the webhook server.
	*/
	async stop() {
		for (const timer of this.pendingDisconnectHangups.values()) clearTimeout(timer);
		this.pendingDisconnectHangups.clear();
		this.webhookInFlightLimiter.clear();
		this.startPromise = null;
		if (this.stopStaleCallReaper) {
			this.stopStaleCallReaper();
			this.stopStaleCallReaper = null;
		}
		return new Promise((resolve) => {
			if (this.server) this.server.close(() => {
				this.server = null;
				this.listeningUrl = null;
				resolve();
			});
			else {
				this.listeningUrl = null;
				resolve();
			}
		});
	}
	resolveListeningUrl(bind, webhookPath) {
		const address = this.server?.address();
		if (address && typeof address === "object") {
			const host = address.address && address.address.length > 0 ? address.address : bind;
			return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${address.port}${webhookPath}`;
		}
		return `http://${bind}:${this.config.serve.port}${webhookPath}`;
	}
	getUpgradePathname(request) {
		try {
			return buildRequestUrl(request.url).pathname;
		} catch {
			return null;
		}
	}
	normalizeWebhookPathForMatch(pathname) {
		const trimmed = pathname.trim();
		if (!trimmed) return "/";
		const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
		if (prefixed === "/") return prefixed;
		return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
	}
	isWebhookPathMatch(requestPath, configuredPath) {
		return this.normalizeWebhookPathForMatch(requestPath) === this.normalizeWebhookPathForMatch(configuredPath);
	}
	/**
	* Handle incoming HTTP request.
	*/
	async handleRequest(req, res, webhookPath) {
		const payload = await this.runWebhookPipeline(req, webhookPath);
		this.writeWebhookResponse(res, payload);
	}
	async runWebhookPipeline(req, webhookPath) {
		const url = buildRequestUrl(req.url);
		if (url.pathname === "/voice/hold-music") return {
			statusCode: 200,
			headers: { "Content-Type": "text/xml" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">All agents are currently busy. Please hold.</Say>
  <Play loop="0">https://s3.amazonaws.com/com.twilio.music.classical/BusyStrings.mp3</Play>
</Response>`
		};
		if (!this.isWebhookPathMatch(url.pathname, webhookPath)) return {
			statusCode: 404,
			body: "Not Found"
		};
		if (req.method !== "POST") return {
			statusCode: 405,
			body: "Method Not Allowed"
		};
		const headerGate = this.verifyPreAuthWebhookHeaders(req.headers);
		if (!headerGate.ok) {
			console.warn(`[voice-call] Webhook rejected before body read: ${headerGate.reason}`);
			return {
				statusCode: 401,
				body: "Unauthorized"
			};
		}
		const remoteAddress = req.socket.remoteAddress;
		if (!remoteAddress) console.warn(`[voice-call] Webhook accepted with no remote address; using shared fallback in-flight key`);
		const inFlightKey = remoteAddress || MISSING_REMOTE_ADDRESS_IN_FLIGHT_KEY;
		if (!this.webhookInFlightLimiter.tryAcquire(inFlightKey)) {
			console.warn(`[voice-call] Webhook rejected before body read: too many in-flight requests`);
			return {
				statusCode: 429,
				body: "Too Many Requests"
			};
		}
		try {
			let body = "";
			try {
				body = await this.readBody(req, MAX_WEBHOOK_BODY_BYTES, WEBHOOK_BODY_TIMEOUT_MS);
			} catch (err) {
				if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) return {
					statusCode: 413,
					body: "Payload Too Large"
				};
				if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) return {
					statusCode: 408,
					body: requestBodyErrorToText("REQUEST_BODY_TIMEOUT")
				};
				throw err;
			}
			const ctx = {
				headers: req.headers,
				rawBody: body,
				url: url.toString(),
				method: "POST",
				query: Object.fromEntries(url.searchParams),
				remoteAddress: req.socket.remoteAddress ?? void 0
			};
			const verification = this.provider.verifyWebhook(ctx);
			if (!verification.ok) {
				console.warn(`[voice-call] Webhook verification failed: ${verification.reason}`);
				return {
					statusCode: 401,
					body: "Unauthorized"
				};
			}
			if (!verification.verifiedRequestKey) {
				console.warn("[voice-call] Webhook verification succeeded without request identity key");
				return {
					statusCode: 401,
					body: "Unauthorized"
				};
			}
			const initialTwiML = this.provider.consumeInitialTwiML?.(ctx);
			if (initialTwiML !== void 0 && initialTwiML !== null) {
				const params = new URLSearchParams(ctx.rawBody);
				console.log(`[voice-call] Serving provider initial TwiML before realtime handling (callSid=${params.get("CallSid") ?? "unknown"}, direction=${params.get("Direction") ?? "unknown"})`);
				return {
					statusCode: 200,
					headers: { "Content-Type": "application/xml" },
					body: initialTwiML
				};
			}
			const realtimeParams = this.getRealtimeTwimlParams(ctx);
			if (realtimeParams) {
				const direction = realtimeParams.get("Direction");
				if ((!direction || direction === "inbound") && !this.shouldAcceptRealtimeInboundRequest(realtimeParams)) {
					console.log("[voice-call] Realtime inbound call rejected before stream setup");
					return buildRealtimeRejectedTwiML();
				}
				console.log(`[voice-call] Serving realtime TwiML for Twilio call ${realtimeParams.get("CallSid") ?? "unknown"} (direction=${direction ?? "unknown"})`);
				return this.realtimeHandler.buildTwiMLPayload(req, realtimeParams);
			}
			const parsed = this.provider.parseWebhookEvent(ctx, { verifiedRequestKey: verification.verifiedRequestKey });
			if (verification.isReplay) console.warn("[voice-call] Replay detected; skipping event side effects");
			else this.processParsedEvents(parsed.events);
			return normalizeWebhookResponse(parsed);
		} finally {
			this.webhookInFlightLimiter.release(inFlightKey);
		}
	}
	verifyPreAuthWebhookHeaders(headers) {
		if (this.config.skipSignatureVerification) return { ok: true };
		switch (this.provider.name) {
			case "telnyx": {
				const signature = getHeader(headers, "telnyx-signature-ed25519");
				const timestamp = getHeader(headers, "telnyx-timestamp");
				if (signature && timestamp) return { ok: true };
				return {
					ok: false,
					reason: "missing Telnyx signature or timestamp header"
				};
			}
			case "twilio":
				if (getHeader(headers, "x-twilio-signature")) return { ok: true };
				return {
					ok: false,
					reason: "missing X-Twilio-Signature header"
				};
			case "plivo": {
				const hasV3 = Boolean(getHeader(headers, "x-plivo-signature-v3")) && Boolean(getHeader(headers, "x-plivo-signature-v3-nonce"));
				const hasV2 = Boolean(getHeader(headers, "x-plivo-signature-v2")) && Boolean(getHeader(headers, "x-plivo-signature-v2-nonce"));
				if (hasV3 || hasV2) return { ok: true };
				return {
					ok: false,
					reason: "missing Plivo signature headers"
				};
			}
			default: return { ok: true };
		}
	}
	isRealtimeWebSocketUpgrade(req) {
		try {
			const pathname = buildRequestUrl(req.url).pathname;
			const pattern = this.realtimeHandler?.getStreamPathPattern();
			return Boolean(pattern && pathname.startsWith(pattern));
		} catch {
			return false;
		}
	}
	getRealtimeTwimlParams(ctx) {
		if (!this.realtimeHandler || this.provider.name !== "twilio") return null;
		const params = new URLSearchParams(ctx.rawBody);
		const direction = params.get("Direction");
		if (!(!direction || direction === "inbound" || direction.startsWith("outbound"))) return null;
		if (ctx.query?.type === "status") return null;
		const callStatus = params.get("CallStatus");
		if (callStatus && isProviderStatusTerminal(callStatus)) return null;
		return !params.get("SpeechResult") && !params.get("Digits") ? params : null;
	}
	shouldAcceptRealtimeInboundRequest(params) {
		switch (this.config.inboundPolicy) {
			case "open": return true;
			case "allowlist":
			case "pairing": return isAllowlistedCaller(normalizePhoneNumber(params.get("From") ?? void 0), this.config.allowFrom);
			default: return false;
		}
	}
	processParsedEvents(events) {
		for (const event of events) try {
			this.manager.processEvent(event);
		} catch (err) {
			console.error(`[voice-call] Error processing event ${event.type}:`, err);
		}
	}
	writeWebhookResponse(res, payload) {
		res.statusCode = payload.statusCode;
		if (payload.headers) for (const [key, value] of Object.entries(payload.headers)) res.setHeader(key, value);
		res.end(payload.body);
	}
	/**
	* Read request body as string with timeout protection.
	*/
	readBody(req, maxBytes, timeoutMs = WEBHOOK_BODY_TIMEOUT_MS) {
		return readRequestBodyWithLimit(req, {
			maxBytes,
			timeoutMs
		});
	}
	/**
	* Handle auto-response for inbound calls using the agent system.
	* Supports tool calling for richer voice interactions.
	*/
	async handleInboundResponse(callId, userMessage) {
		console.log(`[voice-call] Auto-responding to inbound call ${callId}: "${userMessage}"`);
		const call = this.manager.getCall(callId);
		if (!call) {
			console.warn(`[voice-call] Call ${callId} not found for auto-response`);
			return;
		}
		if (!this.coreConfig) {
			console.warn("[voice-call] Core config missing; skipping auto-response");
			return;
		}
		if (!this.agentRuntime) {
			console.warn("[voice-call] Agent runtime missing; skipping auto-response");
			return;
		}
		try {
			const { generateVoiceResponse } = await loadResponseGeneratorModule();
			const numberRouteKey = typeof call.metadata?.numberRouteKey === "string" ? call.metadata.numberRouteKey : call.to;
			const effectiveConfig = resolveVoiceCallEffectiveConfig(this.config, numberRouteKey).config;
			const result = await generateVoiceResponse({
				voiceConfig: effectiveConfig,
				coreConfig: this.coreConfig,
				agentRuntime: this.agentRuntime,
				callId,
				sessionKey: call.sessionKey,
				from: call.from,
				transcript: call.transcript,
				userMessage
			});
			if (result.error) {
				console.error(`[voice-call] Response generation error: ${result.error}`);
				return;
			}
			if (result.text) {
				console.log(`[voice-call] AI response: "${result.text}"`);
				await this.manager.speak(callId, result.text);
			}
		} catch (err) {
			console.error(`[voice-call] Auto-response error:`, err);
		}
	}
};
//#endregion
//#region extensions/voice-call/src/runtime.ts
const REALTIME_VOICE_CONSULT_SYSTEM_PROMPT = [
	"You are the configured OpenClaw agent receiving delegated requests from a live phone voice bridge.",
	"Act on behalf of the caller using the normal available tools when the caller asks you to do work.",
	"Prioritize completing the user's request and returning a fast, speakable result over exhaustive investigation.",
	"For tool-backed status checks, prefer one or two bounded read-only queries before answering.",
	"Do not print secret values or dump environment variables; only check whether required configuration is present.",
	"Be accurate, brief, and speakable."
].join(" ");
let telnyxProviderPromise;
let twilioProviderPromise;
let plivoProviderPromise;
let mockProviderPromise;
let realtimeVoiceRuntimePromise;
let realtimeHandlerPromise;
function loadTelnyxProvider() {
	telnyxProviderPromise ??= import("./telnyx-D8D1Kb8-.js");
	return telnyxProviderPromise;
}
function loadTwilioProvider() {
	twilioProviderPromise ??= import("./twilio-CKpPVkDM.js");
	return twilioProviderPromise;
}
function loadPlivoProvider() {
	plivoProviderPromise ??= import("./plivo-BzjBVOxu.js");
	return plivoProviderPromise;
}
function loadMockProvider() {
	mockProviderPromise ??= import("./mock-Bi6oweSn.js");
	return mockProviderPromise;
}
function loadRealtimeVoiceRuntime() {
	realtimeVoiceRuntimePromise ??= import("./realtime-voice.runtime.js");
	return realtimeVoiceRuntimePromise;
}
function loadRealtimeHandler() {
	realtimeHandlerPromise ??= import("./realtime-handler-DOj1QCVr.js");
	return realtimeHandlerPromise;
}
function resolveVoiceCallConsultSessionKey(call) {
	if (call.sessionKey) return call.sessionKey;
	const phone = call.direction === "outbound" ? call.to : call.from;
	return resolveVoiceCallSessionKey({
		config: call.config,
		callId: call.callId,
		phone
	});
}
function mapVoiceCallConsultTranscript(call, context) {
	const transcript = (call.transcript ?? []).map((entry) => ({
		role: entry.speaker === "bot" ? "assistant" : "user",
		text: entry.text
	}));
	const partial = context?.partialUserTranscript?.trim();
	if (partial && transcript.at(-1)?.text !== partial) transcript.push({
		role: "user",
		text: partial
	});
	return transcript;
}
function createRuntimeResourceLifecycle(params) {
	let tunnelResult = null;
	let stopped = false;
	const runStep = async (step, suppressErrors) => {
		if (suppressErrors) {
			await step().catch(() => {});
			return;
		}
		await step();
	};
	return {
		setTunnelResult: (result) => {
			tunnelResult = result;
		},
		stop: async (opts) => {
			if (stopped) return;
			stopped = true;
			const suppressErrors = opts?.suppressErrors ?? false;
			await runStep(async () => {
				if (tunnelResult) await tunnelResult.stop();
			}, suppressErrors);
			await runStep(async () => {
				await cleanupTailscaleExposure(params.config);
			}, suppressErrors);
			await runStep(async () => {
				await params.webhookServer.stop();
			}, suppressErrors);
		}
	};
}
async function resolveProvider(config) {
	const allowNgrokFreeTierLoopbackBypass = config.tunnel?.provider === "ngrok" && isLoopbackHost(config.serve?.bind ?? "") && (config.tunnel?.allowNgrokFreeTierLoopbackBypass ?? false);
	switch (config.provider) {
		case "telnyx": {
			const { TelnyxProvider } = await loadTelnyxProvider();
			return new TelnyxProvider({
				apiKey: config.telnyx?.apiKey,
				connectionId: config.telnyx?.connectionId,
				publicKey: config.telnyx?.publicKey
			}, { skipVerification: config.skipSignatureVerification });
		}
		case "twilio": {
			const { TwilioProvider } = await loadTwilioProvider();
			return new TwilioProvider({
				accountSid: config.twilio?.accountSid,
				authToken: resolveTwilioAuthToken(config)
			}, {
				allowNgrokFreeTierLoopbackBypass,
				publicUrl: config.publicUrl,
				skipVerification: config.skipSignatureVerification,
				streamPath: config.streaming?.enabled ? config.streaming.streamPath : void 0,
				webhookSecurity: config.webhookSecurity
			});
		}
		case "plivo": {
			const { PlivoProvider } = await loadPlivoProvider();
			return new PlivoProvider({
				authId: config.plivo?.authId,
				authToken: config.plivo?.authToken
			}, {
				publicUrl: config.publicUrl,
				skipVerification: config.skipSignatureVerification,
				ringTimeoutSec: Math.max(1, Math.floor(config.ringTimeoutMs / 1e3)),
				webhookSecurity: config.webhookSecurity
			});
		}
		case "mock": {
			const { MockProvider } = await loadMockProvider();
			return new MockProvider();
		}
		default: throw new Error(`Unsupported voice-call provider: ${String(config.provider)}`);
	}
}
async function resolveRealtimeProvider(params) {
	const { resolveConfiguredRealtimeVoiceProvider } = await loadRealtimeVoiceRuntime();
	return resolveConfiguredRealtimeVoiceProvider({
		configuredProviderId: params.config.realtime.provider,
		providerConfigs: params.config.realtime.providers,
		cfg: params.fullConfig
	});
}
async function createVoiceCallRuntime(params) {
	const { config: rawConfig, coreConfig, fullConfig, agentRuntime, ttsRuntime, logger } = params;
	const log = logger ?? {
		info: console.log,
		warn: console.warn,
		error: console.error,
		debug: console.debug
	};
	const config = resolveVoiceCallConfig(rawConfig);
	const cfg = fullConfig ?? coreConfig;
	if (!config.enabled) throw new Error("Voice call disabled. Enable the plugin entry in config.");
	if (config.skipSignatureVerification) log.warn("[voice-call] SECURITY WARNING: skipSignatureVerification=true disables webhook signature verification (development only). Do not use in production.");
	const validation = validateProviderConfig(config);
	if (!validation.valid) throw new Error(`Invalid voice-call config: ${validation.errors.join("; ")}`);
	const provider = await resolveProvider(config);
	const manager = new CallManager(config);
	const realtimeProvider = config.realtime.enabled ? await resolveRealtimeProvider({
		config,
		fullConfig: cfg
	}) : null;
	const webhookServer = new VoiceCallWebhookServer(config, manager, provider, coreConfig, fullConfig ?? coreConfig, agentRuntime, log);
	if (realtimeProvider) {
		const { RealtimeCallHandler } = await loadRealtimeHandler();
		const realtimeInstructions = await buildRealtimeVoiceInstructions({
			baseInstructions: config.realtime.instructions,
			config,
			coreConfig,
			agentRuntime
		});
		const realtimeHandler = new RealtimeCallHandler({
			...config.realtime,
			instructions: realtimeInstructions,
			tools: resolveRealtimeVoiceAgentConsultTools(config.realtime.toolPolicy, config.realtime.tools)
		}, manager, provider, realtimeProvider.provider, realtimeProvider.providerConfig, config.serve.path, cfg);
		if (config.realtime.toolPolicy !== "none") realtimeHandler.registerToolHandler(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, async (args, callId, handlerContext) => {
			const call = manager.getCall(callId);
			if (!call) return { error: `Call "${callId}" not found` };
			const effectiveConfig = resolveVoiceCallEffectiveConfig(config, typeof call.metadata?.numberRouteKey === "string" ? call.metadata.numberRouteKey : call.to).config;
			const agentId = effectiveConfig.agentId ?? "main";
			const sessionKey = resolveVoiceCallConsultSessionKey({
				...call,
				config: effectiveConfig
			});
			const requesterSessionKey = typeof call.metadata?.requesterSessionKey === "string" ? call.metadata.requesterSessionKey : void 0;
			const fastContext = await resolveRealtimeFastContextConsult({
				cfg,
				agentId,
				sessionKey,
				config: effectiveConfig.realtime.fastContext,
				args,
				logger: log
			});
			if (fastContext.handled) return fastContext.result;
			const { provider: agentProvider, model } = resolveVoiceResponseModel({
				voiceConfig: effectiveConfig,
				agentRuntime
			});
			const thinkLevel = effectiveConfig.realtime.consultThinkingLevel ?? agentRuntime.resolveThinkingDefault({
				cfg,
				provider: agentProvider,
				model
			});
			return await consultRealtimeVoiceAgent({
				cfg,
				agentRuntime,
				logger: log,
				agentId,
				sessionKey,
				messageProvider: "voice",
				lane: "voice",
				runIdPrefix: `voice-realtime-consult:${callId}`,
				args,
				transcript: mapVoiceCallConsultTranscript(call, handlerContext),
				surface: "a live phone call",
				userLabel: "Caller",
				assistantLabel: "Agent",
				questionSourceLabel: "caller",
				provider: agentProvider,
				model,
				thinkLevel,
				fastMode: effectiveConfig.realtime.consultFastMode,
				timeoutMs: effectiveConfig.responseTimeoutMs,
				spawnedBy: requesterSessionKey,
				contextMode: requesterSessionKey ? "fork" : void 0,
				toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(effectiveConfig.realtime.toolPolicy),
				extraSystemPrompt: REALTIME_VOICE_CONSULT_SYSTEM_PROMPT
			});
		});
		webhookServer.setRealtimeHandler(realtimeHandler);
	}
	const lifecycle = createRuntimeResourceLifecycle({
		config,
		webhookServer
	});
	const localUrl = await webhookServer.start();
	try {
		let publicUrl = config.publicUrl ?? null;
		if (!publicUrl && config.tunnel?.provider && config.tunnel.provider !== "none") try {
			const nextTunnelResult = await startTunnel({
				provider: config.tunnel.provider,
				port: config.serve.port,
				path: config.serve.path,
				ngrokAuthToken: config.tunnel.ngrokAuthToken,
				ngrokDomain: config.tunnel.ngrokDomain
			});
			lifecycle.setTunnelResult(nextTunnelResult);
			publicUrl = nextTunnelResult?.publicUrl ?? null;
		} catch (err) {
			log.error(`[voice-call] Tunnel setup failed: ${formatErrorMessage(err)}`);
		}
		if (!publicUrl && config.tailscale?.mode !== "off") publicUrl = await setupTailscaleExposure(config);
		const webhookUrl = publicUrl ?? localUrl;
		if (providerRequiresPublicWebhook(provider.name) && isProviderUnreachableWebhookUrl(webhookUrl)) throw new Error(`[voice-call] ${provider.name} requires a publicly reachable webhook URL. Refusing to use local-only webhook ${webhookUrl}. Set plugins.entries.voice-call.config.publicUrl or enable tunnel/tailscale exposure.`);
		if (publicUrl) provider.setPublicUrl?.(publicUrl);
		if (publicUrl && realtimeProvider) webhookServer.getRealtimeHandler()?.setPublicUrl(publicUrl);
		const realtimeHandler = webhookServer.getRealtimeHandler();
		if (realtimeHandler) manager.streamSessionIssuer = (request) => realtimeHandler.issueStreamSession(request);
		if (provider.name === "twilio" && config.streaming?.enabled) {
			const twilioProvider = provider;
			if (ttsRuntime?.textToSpeechTelephony) try {
				const ttsProvider = createTelephonyTtsProvider({
					coreConfig,
					ttsOverride: config.tts,
					runtime: ttsRuntime,
					logger: log
				});
				twilioProvider.setTTSProvider(ttsProvider);
				log.info("[voice-call] Telephony TTS provider configured");
			} catch (err) {
				log.warn(`[voice-call] Failed to initialize telephony TTS: ${formatErrorMessage(err)}`);
			}
			else log.warn("[voice-call] Telephony TTS unavailable; streaming TTS disabled");
			const mediaHandler = webhookServer.getMediaStreamHandler();
			if (mediaHandler) {
				twilioProvider.setMediaStreamHandler(mediaHandler);
				log.info("[voice-call] Media stream handler wired to provider");
			}
		}
		if (realtimeProvider) log.info(`[voice-call] Realtime voice provider: ${realtimeProvider.provider.id}`);
		await manager.initialize(provider, webhookUrl);
		const stop = async () => await lifecycle.stop();
		log.info("[voice-call] Runtime initialized");
		log.info(`[voice-call] Webhook URL: ${webhookUrl}`);
		if (publicUrl && publicUrl !== webhookUrl) log.info(`[voice-call] Public URL: ${publicUrl}`);
		return {
			config,
			provider,
			manager,
			webhookServer,
			webhookUrl,
			publicUrl,
			stop
		};
	} catch (err) {
		await lifecycle.stop({ suppressErrors: true });
		throw err;
	}
}
//#endregion
export { setupTailscaleExposureRoute as a, getTailscaleSelfInfo as i, resolveWebhookExposureStatus as n, TELEPHONY_DEFAULT_TTS_TIMEOUT_MS as o, cleanupTailscaleExposureRoute as r, resolveUserPath as s, createVoiceCallRuntime as t };
