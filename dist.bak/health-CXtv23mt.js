import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { Dt as isRich, Ot as theme, Z as escapeRegExp, _t as info, r as isTruthyEnvValue, s as createSubsystemLogger, v as defaultRuntime } from "./entry.js";
import { j as loadConfig, rt as parseDurationMs } from "./auth-profiles-D6H-HVV8.js";
import { d as resolveDefaultAgentId, i as resolveAgentConfig, u as resolveAgentWorkspaceDir, y as DEFAULT_HEARTBEAT_FILENAME } from "./agent-scope-C2k6BQnt.js";
import { l as resolveAgentIdFromSessionKey, p as toAgentStoreSessionKey, s as normalizeAgentId } from "./session-key-qmb11-mH.js";
import { $ as resolveAgentMainSessionKey, Q as canonicalizeMainSessionAlias, c as loadSessionStore, h as updateSessionStore, p as saveSessionStore } from "./sessions-B8Y6oyPb.js";
import { n as listChannelPlugins, t as getChannelPlugin } from "./plugins-BOmV0yTv.js";
import { a as resolvePreferredAccountId, t as buildChannelAccountBindings } from "./bindings-DcFNU_QL.js";
import { Ar as isHeartbeatContentEffectivelyEmpty, Dr as CommandLane, Fn as isHeartbeatEventDrivenReason, In as resolveHeartbeatReasonKind, Mr as stripHeartbeatToken, Nn as requestHeartbeatNow, Or as DEFAULT_HEARTBEAT_ACK_MAX_CHARS, Pn as setHeartbeatWakeHandler, ar as resolveUserTimezone, gt as resolveHeartbeatSenderContext, ht as resolveHeartbeatDeliveryTarget, it as appendCronStyleCurrentTimeLine, jn as peekSystemEventEntries, jr as resolveHeartbeatPrompt$1, kr as DEFAULT_HEARTBEAT_EVERY, nt as getReplyFromConfig, on as buildOutboundSessionContext, xr as getQueueSize } from "./subagent-registry-BrzwRDvR.js";
import { l as resolveStorePath, r as resolveSessionFilePath } from "./paths-DWsXK0S0.js";
import { n as callGateway, t as buildGatewayConnectionDetails } from "./call-D6IYi30Z.js";
import { t as HEARTBEAT_TOKEN } from "./tokens-DytUXmpb.js";
import { t as deliverOutboundPayloads } from "./deliver-3nGJ2B10.js";
import { i as hasErrnoCode, n as formatErrorMessage } from "./errors-Cu3BYw29.js";
import { o as resolveEffectiveMessagesConfig } from "./reply-prefix-CJW3v-NP.js";
import { n as withProgress } from "./progress-bvyZjsUc.js";
import { a as resolveIndicatorType, n as emitHeartbeatEvent, o as resolveHeartbeatReplyPayload, t as resolveHeartbeatVisibility } from "./heartbeat-visibility-CyUGZxub.js";
import { t as resolveChannelDefaultAccountId } from "./helpers-BgzIw8DX.js";
import path from "node:path";
import fs from "node:fs/promises";

//#region src/infra/heartbeat-active-hours.ts
const ACTIVE_HOURS_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
function resolveActiveHoursTimezone(cfg, raw) {
	const trimmed = raw?.trim();
	if (!trimmed || trimmed === "user") return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
	if (trimmed === "local") return Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(/* @__PURE__ */ new Date());
		return trimmed;
	} catch {
		return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
	}
}
function parseActiveHoursTime(opts, raw) {
	if (!raw || !ACTIVE_HOURS_TIME_PATTERN.test(raw)) return null;
	const [hourStr, minuteStr] = raw.split(":");
	const hour = Number(hourStr);
	const minute = Number(minuteStr);
	if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
	if (hour === 24) {
		if (!opts.allow24 || minute !== 0) return null;
		return 1440;
	}
	return hour * 60 + minute;
}
function resolveMinutesInTimeZone(nowMs, timeZone) {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23"
		}).formatToParts(new Date(nowMs));
		const map = {};
		for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
		const hour = Number(map.hour);
		const minute = Number(map.minute);
		if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
		return hour * 60 + minute;
	} catch {
		return null;
	}
}
function isWithinActiveHours(cfg, heartbeat, nowMs) {
	const active = heartbeat?.activeHours;
	if (!active) return true;
	const startMin = parseActiveHoursTime({ allow24: false }, active.start);
	const endMin = parseActiveHoursTime({ allow24: true }, active.end);
	if (startMin === null || endMin === null) return true;
	if (startMin === endMin) return false;
	const timeZone = resolveActiveHoursTimezone(cfg, active.timezone);
	const currentMin = resolveMinutesInTimeZone(nowMs ?? Date.now(), timeZone);
	if (currentMin === null) return true;
	if (endMin > startMin) return currentMin >= startMin && currentMin < endMin;
	return currentMin >= startMin || currentMin < endMin;
}

//#endregion
//#region src/infra/heartbeat-events-filter.ts
function buildCronEventPrompt(pendingEvents, opts) {
	const deliverToUser = opts?.deliverToUser ?? true;
	const eventText = pendingEvents.join("\n").trim();
	if (!eventText) {
		if (!deliverToUser) return "A scheduled cron event was triggered, but no event content was found. Handle this internally and reply HEARTBEAT_OK when nothing needs user-facing follow-up.";
		return "A scheduled cron event was triggered, but no event content was found. Reply HEARTBEAT_OK.";
	}
	if (!deliverToUser) return "A scheduled reminder has been triggered. The reminder content is:\n\n" + eventText + "\n\nHandle this reminder internally. Do not relay it to the user unless explicitly requested.";
	return "A scheduled reminder has been triggered. The reminder content is:\n\n" + eventText + "\n\nPlease relay this reminder to the user in a helpful and friendly way.";
}
function buildExecEventPrompt(opts) {
	if (!(opts?.deliverToUser ?? true)) return "An async command you ran earlier has completed. The result is shown in the system messages above. Handle the result internally. Do not relay it to the user unless explicitly requested.";
	return "An async command you ran earlier has completed. The result is shown in the system messages above. Please relay the command output to the user in a helpful way. If the command succeeded, share the relevant output. If it failed, explain what went wrong.";
}
const HEARTBEAT_OK_PREFIX = HEARTBEAT_TOKEN.toLowerCase();
function isHeartbeatAckEvent(evt) {
	const trimmed = evt.trim();
	if (!trimmed) return false;
	const lower = trimmed.toLowerCase();
	if (!lower.startsWith(HEARTBEAT_OK_PREFIX)) return false;
	const suffix = lower.slice(HEARTBEAT_OK_PREFIX.length);
	if (suffix.length === 0) return true;
	return !/[a-z0-9_]/.test(suffix[0]);
}
function isHeartbeatNoiseEvent(evt) {
	const lower = evt.trim().toLowerCase();
	if (!lower) return false;
	return isHeartbeatAckEvent(lower) || lower.includes("heartbeat poll") || lower.includes("heartbeat wake");
}
function isExecCompletionEvent(evt) {
	return evt.toLowerCase().includes("exec finished");
}
function isCronSystemEvent(evt) {
	if (!evt.trim()) return false;
	return !isHeartbeatNoiseEvent(evt) && !isExecCompletionEvent(evt);
}

//#endregion
//#region src/infra/heartbeat-runner.ts
const log = createSubsystemLogger("gateway/heartbeat");
let heartbeatsEnabled = true;
function setHeartbeatsEnabled(enabled) {
	heartbeatsEnabled = enabled;
}
const DEFAULT_HEARTBEAT_TARGET = "none";
function hasExplicitHeartbeatAgents(cfg) {
	return (cfg.agents?.list ?? []).some((entry) => Boolean(entry?.heartbeat));
}
function isHeartbeatEnabledForAgent(cfg, agentId) {
	const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
	const list = cfg.agents?.list ?? [];
	if (hasExplicitHeartbeatAgents(cfg)) return list.some((entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry?.id) === resolvedAgentId);
	return resolvedAgentId === resolveDefaultAgentId(cfg);
}
function resolveHeartbeatConfig(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.heartbeat;
	if (!agentId) return defaults;
	const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
	if (!defaults && !overrides) return overrides;
	return {
		...defaults,
		...overrides
	};
}
function resolveHeartbeatSummaryForAgent(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.heartbeat;
	const overrides = agentId ? resolveAgentConfig(cfg, agentId)?.heartbeat : void 0;
	if (!isHeartbeatEnabledForAgent(cfg, agentId)) return {
		enabled: false,
		every: "disabled",
		everyMs: null,
		prompt: resolveHeartbeatPrompt$1(defaults?.prompt),
		target: defaults?.target ?? DEFAULT_HEARTBEAT_TARGET,
		model: defaults?.model,
		ackMaxChars: Math.max(0, defaults?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS)
	};
	const merged = defaults || overrides ? {
		...defaults,
		...overrides
	} : void 0;
	return {
		enabled: true,
		every: merged?.every ?? defaults?.every ?? overrides?.every ?? DEFAULT_HEARTBEAT_EVERY,
		everyMs: resolveHeartbeatIntervalMs(cfg, void 0, merged),
		prompt: resolveHeartbeatPrompt$1(merged?.prompt ?? defaults?.prompt ?? overrides?.prompt),
		target: merged?.target ?? defaults?.target ?? overrides?.target ?? DEFAULT_HEARTBEAT_TARGET,
		model: merged?.model ?? defaults?.model ?? overrides?.model,
		ackMaxChars: Math.max(0, merged?.ackMaxChars ?? defaults?.ackMaxChars ?? overrides?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS)
	};
}
function resolveHeartbeatAgents(cfg) {
	const list = cfg.agents?.list ?? [];
	if (hasExplicitHeartbeatAgents(cfg)) return list.filter((entry) => entry?.heartbeat).map((entry) => {
		const id = normalizeAgentId(entry.id);
		return {
			agentId: id,
			heartbeat: resolveHeartbeatConfig(cfg, id)
		};
	}).filter((entry) => entry.agentId);
	const fallbackId = resolveDefaultAgentId(cfg);
	return [{
		agentId: fallbackId,
		heartbeat: resolveHeartbeatConfig(cfg, fallbackId)
	}];
}
function resolveHeartbeatIntervalMs(cfg, overrideEvery, heartbeat) {
	const raw = overrideEvery ?? heartbeat?.every ?? cfg.agents?.defaults?.heartbeat?.every ?? DEFAULT_HEARTBEAT_EVERY;
	if (!raw) return null;
	const trimmed = String(raw).trim();
	if (!trimmed) return null;
	let ms;
	try {
		ms = parseDurationMs(trimmed, { defaultUnit: "m" });
	} catch {
		return null;
	}
	if (ms <= 0) return null;
	return ms;
}
function resolveHeartbeatPrompt(cfg, heartbeat) {
	return resolveHeartbeatPrompt$1(heartbeat?.prompt ?? cfg.agents?.defaults?.heartbeat?.prompt);
}
function resolveHeartbeatAckMaxChars(cfg, heartbeat) {
	return Math.max(0, heartbeat?.ackMaxChars ?? cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS);
}
function resolveHeartbeatSession(cfg, agentId, heartbeat, forcedSessionKey) {
	const sessionCfg = cfg.session;
	const scope = sessionCfg?.scope ?? "per-sender";
	const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
	const mainSessionKey = scope === "global" ? "global" : resolveAgentMainSessionKey({
		cfg,
		agentId: resolvedAgentId
	});
	const storeAgentId = scope === "global" ? resolveDefaultAgentId(cfg) : resolvedAgentId;
	const storePath = resolveStorePath(sessionCfg?.store, { agentId: storeAgentId });
	const store = loadSessionStore(storePath);
	const mainEntry = store[mainSessionKey];
	if (scope === "global") return {
		sessionKey: mainSessionKey,
		storePath,
		store,
		entry: mainEntry
	};
	const forced = forcedSessionKey?.trim();
	if (forced) {
		const forcedCanonical = canonicalizeMainSessionAlias({
			cfg,
			agentId: resolvedAgentId,
			sessionKey: toAgentStoreSessionKey({
				agentId: resolvedAgentId,
				requestKey: forced,
				mainKey: cfg.session?.mainKey
			})
		});
		if (forcedCanonical !== "global") {
			if (resolveAgentIdFromSessionKey(forcedCanonical) === normalizeAgentId(resolvedAgentId)) return {
				sessionKey: forcedCanonical,
				storePath,
				store,
				entry: store[forcedCanonical]
			};
		}
	}
	const trimmed = heartbeat?.session?.trim() ?? "";
	if (!trimmed) return {
		sessionKey: mainSessionKey,
		storePath,
		store,
		entry: mainEntry
	};
	const normalized = trimmed.toLowerCase();
	if (normalized === "main" || normalized === "global") return {
		sessionKey: mainSessionKey,
		storePath,
		store,
		entry: mainEntry
	};
	const canonical = canonicalizeMainSessionAlias({
		cfg,
		agentId: resolvedAgentId,
		sessionKey: toAgentStoreSessionKey({
			agentId: resolvedAgentId,
			requestKey: trimmed,
			mainKey: cfg.session?.mainKey
		})
	});
	if (canonical !== "global") {
		if (resolveAgentIdFromSessionKey(canonical) === normalizeAgentId(resolvedAgentId)) return {
			sessionKey: canonical,
			storePath,
			store,
			entry: store[canonical]
		};
	}
	return {
		sessionKey: mainSessionKey,
		storePath,
		store,
		entry: mainEntry
	};
}
function resolveHeartbeatReasoningPayloads(replyResult) {
	return (Array.isArray(replyResult) ? replyResult : replyResult ? [replyResult] : []).filter((payload) => {
		return (typeof payload.text === "string" ? payload.text : "").trimStart().startsWith("Reasoning:");
	});
}
async function restoreHeartbeatUpdatedAt(params) {
	const { storePath, sessionKey, updatedAt } = params;
	if (typeof updatedAt !== "number") return;
	const entry = loadSessionStore(storePath)[sessionKey];
	if (!entry) return;
	const nextUpdatedAt = Math.max(entry.updatedAt ?? 0, updatedAt);
	if (entry.updatedAt === nextUpdatedAt) return;
	await updateSessionStore(storePath, (nextStore) => {
		const nextEntry = nextStore[sessionKey] ?? entry;
		if (!nextEntry) return;
		const resolvedUpdatedAt = Math.max(nextEntry.updatedAt ?? 0, updatedAt);
		if (nextEntry.updatedAt === resolvedUpdatedAt) return;
		nextStore[sessionKey] = {
			...nextEntry,
			updatedAt: resolvedUpdatedAt
		};
	});
}
/**
* Prune heartbeat transcript entries by truncating the file back to a previous size.
* This removes the user+assistant turns that were written during a HEARTBEAT_OK run,
* preventing context pollution from zero-information exchanges.
*/
async function pruneHeartbeatTranscript(params) {
	const { transcriptPath, preHeartbeatSize } = params;
	if (!transcriptPath || typeof preHeartbeatSize !== "number" || preHeartbeatSize < 0) return;
	try {
		if ((await fs.stat(transcriptPath)).size > preHeartbeatSize) await fs.truncate(transcriptPath, preHeartbeatSize);
	} catch {}
}
/**
* Get the transcript file path and its current size before a heartbeat run.
* Returns undefined values if the session or transcript doesn't exist yet.
*/
async function captureTranscriptState(params) {
	const { storePath, sessionKey, agentId } = params;
	try {
		const entry = loadSessionStore(storePath)[sessionKey];
		if (!entry?.sessionId) return {};
		const transcriptPath = resolveSessionFilePath(entry.sessionId, entry, {
			agentId,
			sessionsDir: path.dirname(storePath)
		});
		return {
			transcriptPath,
			preHeartbeatSize: (await fs.stat(transcriptPath)).size
		};
	} catch {
		return {};
	}
}
function stripLeadingHeartbeatResponsePrefix(text, responsePrefix) {
	const normalizedPrefix = responsePrefix?.trim();
	if (!normalizedPrefix) return text;
	const prefixPattern = new RegExp(`^${escapeRegExp(normalizedPrefix)}(?=$|\\s|[\\p{P}\\p{S}])\\s*`, "iu");
	return text.replace(prefixPattern, "");
}
function normalizeHeartbeatReply(payload, responsePrefix, ackMaxChars) {
	const stripped = stripHeartbeatToken(stripLeadingHeartbeatResponsePrefix(typeof payload.text === "string" ? payload.text : "", responsePrefix), {
		mode: "heartbeat",
		maxAckChars: ackMaxChars
	});
	const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);
	if (stripped.shouldSkip && !hasMedia) return {
		shouldSkip: true,
		text: "",
		hasMedia
	};
	let finalText = stripped.text;
	if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) finalText = `${responsePrefix} ${finalText}`;
	return {
		shouldSkip: false,
		text: finalText,
		hasMedia
	};
}
function resolveHeartbeatReasonFlags(reason) {
	const reasonKind = resolveHeartbeatReasonKind(reason);
	return {
		isExecEventReason: reasonKind === "exec-event",
		isCronEventReason: reasonKind === "cron",
		isWakeReason: reasonKind === "wake" || reasonKind === "hook"
	};
}
async function resolveHeartbeatPreflight(params) {
	const reasonFlags = resolveHeartbeatReasonFlags(params.reason);
	const session = resolveHeartbeatSession(params.cfg, params.agentId, params.heartbeat, params.forcedSessionKey);
	const pendingEventEntries = peekSystemEventEntries(session.sessionKey);
	const hasTaggedCronEvents = pendingEventEntries.some((event) => event.contextKey?.startsWith("cron:"));
	const shouldInspectPendingEvents = reasonFlags.isExecEventReason || reasonFlags.isCronEventReason || hasTaggedCronEvents;
	const shouldBypassFileGates = reasonFlags.isExecEventReason || reasonFlags.isCronEventReason || reasonFlags.isWakeReason || hasTaggedCronEvents;
	const basePreflight = {
		...reasonFlags,
		session,
		pendingEventEntries,
		hasTaggedCronEvents,
		shouldInspectPendingEvents
	};
	if (shouldBypassFileGates) return basePreflight;
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
	const heartbeatFilePath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
	try {
		if (isHeartbeatContentEffectivelyEmpty(await fs.readFile(heartbeatFilePath, "utf-8"))) return {
			...basePreflight,
			skipReason: "empty-heartbeat-file"
		};
	} catch (err) {
		if (hasErrnoCode(err, "ENOENT")) return basePreflight;
	}
	return basePreflight;
}
function resolveHeartbeatRunPrompt(params) {
	const pendingEventEntries = params.preflight.pendingEventEntries;
	const pendingEvents = params.preflight.shouldInspectPendingEvents ? pendingEventEntries.map((event) => event.text) : [];
	const cronEvents = pendingEventEntries.filter((event) => (params.preflight.isCronEventReason || event.contextKey?.startsWith("cron:")) && isCronSystemEvent(event.text)).map((event) => event.text);
	const hasExecCompletion = pendingEvents.some(isExecCompletionEvent);
	const hasCronEvents = cronEvents.length > 0;
	return {
		prompt: hasExecCompletion ? buildExecEventPrompt({ deliverToUser: params.canRelayToUser }) : hasCronEvents ? buildCronEventPrompt(cronEvents, { deliverToUser: params.canRelayToUser }) : resolveHeartbeatPrompt(params.cfg, params.heartbeat),
		hasExecCompletion,
		hasCronEvents
	};
}
async function runHeartbeatOnce(opts) {
	const cfg = opts.cfg ?? loadConfig();
	const agentId = normalizeAgentId(opts.agentId ?? resolveDefaultAgentId(cfg));
	const heartbeat = opts.heartbeat ?? resolveHeartbeatConfig(cfg, agentId);
	if (!isHeartbeatEventDrivenReason(opts.reason)) {
		if (!heartbeatsEnabled) return {
			status: "skipped",
			reason: "disabled"
		};
		if (!isHeartbeatEnabledForAgent(cfg, agentId)) return {
			status: "skipped",
			reason: "disabled"
		};
		if (!resolveHeartbeatIntervalMs(cfg, void 0, heartbeat)) return {
			status: "skipped",
			reason: "disabled"
		};
	}
	const startedAt = opts.deps?.nowMs?.() ?? Date.now();
	if (!isWithinActiveHours(cfg, heartbeat, startedAt)) return {
		status: "skipped",
		reason: "quiet-hours"
	};
	if ((opts.deps?.getQueueSize ?? getQueueSize)(CommandLane.Main) > 0) return {
		status: "skipped",
		reason: "requests-in-flight"
	};
	const preflight = await resolveHeartbeatPreflight({
		cfg,
		agentId,
		heartbeat,
		forcedSessionKey: opts.sessionKey,
		reason: opts.reason
	});
	if (preflight.skipReason) {
		emitHeartbeatEvent({
			status: "skipped",
			reason: preflight.skipReason,
			durationMs: Date.now() - startedAt
		});
		return {
			status: "skipped",
			reason: preflight.skipReason
		};
	}
	const { entry, sessionKey, storePath } = preflight.session;
	const previousUpdatedAt = entry?.updatedAt;
	const delivery = resolveHeartbeatDeliveryTarget({
		cfg,
		entry,
		heartbeat
	});
	const heartbeatAccountId = heartbeat?.accountId?.trim();
	if (delivery.reason === "unknown-account") log.warn("heartbeat: unknown accountId", {
		accountId: delivery.accountId ?? heartbeatAccountId ?? null,
		target: heartbeat?.target ?? "none"
	});
	else if (heartbeatAccountId) log.info("heartbeat: using explicit accountId", {
		accountId: delivery.accountId ?? heartbeatAccountId,
		target: heartbeat?.target ?? "none",
		channel: delivery.channel
	});
	const visibility = delivery.channel !== "none" ? resolveHeartbeatVisibility({
		cfg,
		channel: delivery.channel,
		accountId: delivery.accountId
	}) : {
		showOk: false,
		showAlerts: true,
		useIndicator: true
	};
	const { sender } = resolveHeartbeatSenderContext({
		cfg,
		entry,
		delivery
	});
	const responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId, {
		channel: delivery.channel !== "none" ? delivery.channel : void 0,
		accountId: delivery.accountId
	}).responsePrefix;
	const { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({
		cfg,
		heartbeat,
		preflight,
		canRelayToUser: Boolean(delivery.channel !== "none" && delivery.to && visibility.showAlerts)
	});
	const ctx = {
		Body: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),
		From: sender,
		To: sender,
		OriginatingChannel: delivery.channel !== "none" ? delivery.channel : void 0,
		OriginatingTo: delivery.to,
		AccountId: delivery.accountId,
		MessageThreadId: delivery.threadId,
		Provider: hasExecCompletion ? "exec-event" : hasCronEvents ? "cron-event" : "heartbeat",
		SessionKey: sessionKey
	};
	if (!visibility.showAlerts && !visibility.showOk && !visibility.useIndicator) {
		emitHeartbeatEvent({
			status: "skipped",
			reason: "alerts-disabled",
			durationMs: Date.now() - startedAt,
			channel: delivery.channel !== "none" ? delivery.channel : void 0,
			accountId: delivery.accountId
		});
		return {
			status: "skipped",
			reason: "alerts-disabled"
		};
	}
	const heartbeatOkText = responsePrefix ? `${responsePrefix} ${HEARTBEAT_TOKEN}` : HEARTBEAT_TOKEN;
	const outboundSession = buildOutboundSessionContext({
		cfg,
		agentId,
		sessionKey
	});
	const canAttemptHeartbeatOk = Boolean(visibility.showOk && delivery.channel !== "none" && delivery.to);
	const maybeSendHeartbeatOk = async () => {
		if (!canAttemptHeartbeatOk || delivery.channel === "none" || !delivery.to) return false;
		const heartbeatPlugin = getChannelPlugin(delivery.channel);
		if (heartbeatPlugin?.heartbeat?.checkReady) {
			if (!(await heartbeatPlugin.heartbeat.checkReady({
				cfg,
				accountId: delivery.accountId,
				deps: opts.deps
			})).ok) return false;
		}
		await deliverOutboundPayloads({
			cfg,
			channel: delivery.channel,
			to: delivery.to,
			accountId: delivery.accountId,
			threadId: delivery.threadId,
			payloads: [{ text: heartbeatOkText }],
			session: outboundSession,
			deps: opts.deps
		});
		return true;
	};
	try {
		const transcriptState = await captureTranscriptState({
			storePath,
			sessionKey,
			agentId
		});
		const heartbeatModelOverride = heartbeat?.model?.trim() || void 0;
		const suppressToolErrorWarnings = heartbeat?.suppressToolErrorWarnings === true;
		const replyResult = await getReplyFromConfig(ctx, heartbeatModelOverride ? {
			isHeartbeat: true,
			heartbeatModelOverride,
			suppressToolErrorWarnings
		} : {
			isHeartbeat: true,
			suppressToolErrorWarnings
		}, cfg);
		const replyPayload = resolveHeartbeatReplyPayload(replyResult);
		const reasoningPayloads = heartbeat?.includeReasoning === true ? resolveHeartbeatReasoningPayloads(replyResult).filter((payload) => payload !== replyPayload) : [];
		if (!replyPayload || !replyPayload.text && !replyPayload.mediaUrl && !replyPayload.mediaUrls?.length) {
			await restoreHeartbeatUpdatedAt({
				storePath,
				sessionKey,
				updatedAt: previousUpdatedAt
			});
			await pruneHeartbeatTranscript(transcriptState);
			const okSent = await maybeSendHeartbeatOk();
			emitHeartbeatEvent({
				status: "ok-empty",
				reason: opts.reason,
				durationMs: Date.now() - startedAt,
				channel: delivery.channel !== "none" ? delivery.channel : void 0,
				accountId: delivery.accountId,
				silent: !okSent,
				indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-empty") : void 0
			});
			return {
				status: "ran",
				durationMs: Date.now() - startedAt
			};
		}
		const normalized = normalizeHeartbeatReply(replyPayload, responsePrefix, resolveHeartbeatAckMaxChars(cfg, heartbeat));
		const execFallbackText = hasExecCompletion && !normalized.text.trim() && replyPayload.text?.trim() ? replyPayload.text.trim() : null;
		if (execFallbackText) {
			normalized.text = execFallbackText;
			normalized.shouldSkip = false;
		}
		const shouldSkipMain = normalized.shouldSkip && !normalized.hasMedia && !hasExecCompletion;
		if (shouldSkipMain && reasoningPayloads.length === 0) {
			await restoreHeartbeatUpdatedAt({
				storePath,
				sessionKey,
				updatedAt: previousUpdatedAt
			});
			await pruneHeartbeatTranscript(transcriptState);
			const okSent = await maybeSendHeartbeatOk();
			emitHeartbeatEvent({
				status: "ok-token",
				reason: opts.reason,
				durationMs: Date.now() - startedAt,
				channel: delivery.channel !== "none" ? delivery.channel : void 0,
				accountId: delivery.accountId,
				silent: !okSent,
				indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-token") : void 0
			});
			return {
				status: "ran",
				durationMs: Date.now() - startedAt
			};
		}
		const mediaUrls = replyPayload.mediaUrls ?? (replyPayload.mediaUrl ? [replyPayload.mediaUrl] : []);
		const prevHeartbeatText = typeof entry?.lastHeartbeatText === "string" ? entry.lastHeartbeatText : "";
		const prevHeartbeatAt = typeof entry?.lastHeartbeatSentAt === "number" ? entry.lastHeartbeatSentAt : void 0;
		if (!shouldSkipMain && !mediaUrls.length && Boolean(prevHeartbeatText.trim()) && normalized.text.trim() === prevHeartbeatText.trim() && typeof prevHeartbeatAt === "number" && startedAt - prevHeartbeatAt < 1440 * 60 * 1e3) {
			await restoreHeartbeatUpdatedAt({
				storePath,
				sessionKey,
				updatedAt: previousUpdatedAt
			});
			await pruneHeartbeatTranscript(transcriptState);
			emitHeartbeatEvent({
				status: "skipped",
				reason: "duplicate",
				preview: normalized.text.slice(0, 200),
				durationMs: Date.now() - startedAt,
				hasMedia: false,
				channel: delivery.channel !== "none" ? delivery.channel : void 0,
				accountId: delivery.accountId
			});
			return {
				status: "ran",
				durationMs: Date.now() - startedAt
			};
		}
		const previewText = shouldSkipMain ? reasoningPayloads.map((payload) => payload.text).filter((text) => Boolean(text?.trim())).join("\n") : normalized.text;
		if (delivery.channel === "none" || !delivery.to) {
			emitHeartbeatEvent({
				status: "skipped",
				reason: delivery.reason ?? "no-target",
				preview: previewText?.slice(0, 200),
				durationMs: Date.now() - startedAt,
				hasMedia: mediaUrls.length > 0,
				accountId: delivery.accountId
			});
			return {
				status: "ran",
				durationMs: Date.now() - startedAt
			};
		}
		if (!visibility.showAlerts) {
			await restoreHeartbeatUpdatedAt({
				storePath,
				sessionKey,
				updatedAt: previousUpdatedAt
			});
			emitHeartbeatEvent({
				status: "skipped",
				reason: "alerts-disabled",
				preview: previewText?.slice(0, 200),
				durationMs: Date.now() - startedAt,
				channel: delivery.channel,
				hasMedia: mediaUrls.length > 0,
				accountId: delivery.accountId,
				indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : void 0
			});
			return {
				status: "ran",
				durationMs: Date.now() - startedAt
			};
		}
		const deliveryAccountId = delivery.accountId;
		const heartbeatPlugin = getChannelPlugin(delivery.channel);
		if (heartbeatPlugin?.heartbeat?.checkReady) {
			const readiness = await heartbeatPlugin.heartbeat.checkReady({
				cfg,
				accountId: deliveryAccountId,
				deps: opts.deps
			});
			if (!readiness.ok) {
				emitHeartbeatEvent({
					status: "skipped",
					reason: readiness.reason,
					preview: previewText?.slice(0, 200),
					durationMs: Date.now() - startedAt,
					hasMedia: mediaUrls.length > 0,
					channel: delivery.channel,
					accountId: delivery.accountId
				});
				log.info("heartbeat: channel not ready", {
					channel: delivery.channel,
					reason: readiness.reason
				});
				return {
					status: "skipped",
					reason: readiness.reason
				};
			}
		}
		await deliverOutboundPayloads({
			cfg,
			channel: delivery.channel,
			to: delivery.to,
			accountId: deliveryAccountId,
			session: outboundSession,
			threadId: delivery.threadId,
			payloads: [...reasoningPayloads, ...shouldSkipMain ? [] : [{
				text: normalized.text,
				mediaUrls
			}]],
			deps: opts.deps
		});
		if (!shouldSkipMain && normalized.text.trim()) {
			const store = loadSessionStore(storePath);
			const current = store[sessionKey];
			if (current) {
				store[sessionKey] = {
					...current,
					lastHeartbeatText: normalized.text,
					lastHeartbeatSentAt: startedAt
				};
				await saveSessionStore(storePath, store);
			}
		}
		emitHeartbeatEvent({
			status: "sent",
			to: delivery.to,
			preview: previewText?.slice(0, 200),
			durationMs: Date.now() - startedAt,
			hasMedia: mediaUrls.length > 0,
			channel: delivery.channel,
			accountId: delivery.accountId,
			indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : void 0
		});
		return {
			status: "ran",
			durationMs: Date.now() - startedAt
		};
	} catch (err) {
		const reason = formatErrorMessage(err);
		emitHeartbeatEvent({
			status: "failed",
			reason,
			durationMs: Date.now() - startedAt,
			channel: delivery.channel !== "none" ? delivery.channel : void 0,
			accountId: delivery.accountId,
			indicatorType: visibility.useIndicator ? resolveIndicatorType("failed") : void 0
		});
		log.error(`heartbeat failed: ${reason}`, { error: reason });
		return {
			status: "failed",
			reason
		};
	}
}
function startHeartbeatRunner(opts) {
	const runtime = opts.runtime ?? defaultRuntime;
	const runOnce = opts.runOnce ?? runHeartbeatOnce;
	const state = {
		cfg: opts.cfg ?? loadConfig(),
		runtime,
		agents: /* @__PURE__ */ new Map(),
		timer: null,
		stopped: false
	};
	let initialized = false;
	const resolveNextDue = (now, intervalMs, prevState) => {
		if (typeof prevState?.lastRunMs === "number") return prevState.lastRunMs + intervalMs;
		if (prevState && prevState.intervalMs === intervalMs && prevState.nextDueMs > now) return prevState.nextDueMs;
		return now + intervalMs;
	};
	const advanceAgentSchedule = (agent, now) => {
		agent.lastRunMs = now;
		agent.nextDueMs = now + agent.intervalMs;
	};
	const scheduleNext = () => {
		if (state.stopped) return;
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}
		if (state.agents.size === 0) return;
		const now = Date.now();
		let nextDue = Number.POSITIVE_INFINITY;
		for (const agent of state.agents.values()) if (agent.nextDueMs < nextDue) nextDue = agent.nextDueMs;
		if (!Number.isFinite(nextDue)) return;
		const delay = Math.max(0, nextDue - now);
		state.timer = setTimeout(() => {
			state.timer = null;
			requestHeartbeatNow({
				reason: "interval",
				coalesceMs: 0
			});
		}, delay);
		state.timer.unref?.();
	};
	const updateConfig = (cfg) => {
		if (state.stopped) return;
		const now = Date.now();
		const prevAgents = state.agents;
		const prevEnabled = prevAgents.size > 0;
		const nextAgents = /* @__PURE__ */ new Map();
		const intervals = [];
		for (const agent of resolveHeartbeatAgents(cfg)) {
			const intervalMs = resolveHeartbeatIntervalMs(cfg, void 0, agent.heartbeat);
			if (!intervalMs) continue;
			intervals.push(intervalMs);
			const prevState = prevAgents.get(agent.agentId);
			const nextDueMs = resolveNextDue(now, intervalMs, prevState);
			nextAgents.set(agent.agentId, {
				agentId: agent.agentId,
				heartbeat: agent.heartbeat,
				intervalMs,
				lastRunMs: prevState?.lastRunMs,
				nextDueMs
			});
		}
		state.cfg = cfg;
		state.agents = nextAgents;
		const nextEnabled = nextAgents.size > 0;
		if (!initialized) {
			if (!nextEnabled) log.info("heartbeat: disabled", { enabled: false });
			else log.info("heartbeat: started", { intervalMs: Math.min(...intervals) });
			initialized = true;
		} else if (prevEnabled !== nextEnabled) if (!nextEnabled) log.info("heartbeat: disabled", { enabled: false });
		else log.info("heartbeat: started", { intervalMs: Math.min(...intervals) });
		scheduleNext();
	};
	const run = async (params) => {
		if (state.stopped) return {
			status: "skipped",
			reason: "disabled"
		};
		const reason = params?.reason;
		const isEventDriven = isHeartbeatEventDrivenReason(reason);
		if (!heartbeatsEnabled && !isEventDriven) return {
			status: "skipped",
			reason: "disabled"
		};
		if (state.agents.size === 0 && !isEventDriven) return {
			status: "skipped",
			reason: "disabled"
		};
		const requestedAgentId = params?.agentId ? normalizeAgentId(params.agentId) : void 0;
		const requestedSessionKey = params?.sessionKey?.trim() || void 0;
		const isInterval = reason === "interval";
		const startedAt = Date.now();
		const now = startedAt;
		let ran = false;
		if (requestedSessionKey || requestedAgentId) {
			const targetAgentId = requestedAgentId ?? resolveAgentIdFromSessionKey(requestedSessionKey);
			const targetAgent = state.agents.get(targetAgentId);
			if (!targetAgent && !isEventDriven) {
				scheduleNext();
				return {
					status: "skipped",
					reason: "disabled"
				};
			}
			const effectiveAgentId = targetAgent?.agentId ?? targetAgentId;
			const effectiveHeartbeat = targetAgent?.heartbeat ?? resolveHeartbeatConfig(state.cfg, targetAgentId);
			try {
				const res = await runOnce({
					cfg: state.cfg,
					agentId: effectiveAgentId,
					heartbeat: effectiveHeartbeat,
					reason,
					sessionKey: requestedSessionKey,
					deps: { runtime: state.runtime }
				});
				if (targetAgent && (res.status !== "skipped" || res.reason !== "disabled")) advanceAgentSchedule(targetAgent, now);
				scheduleNext();
				return res.status === "ran" ? {
					status: "ran",
					durationMs: Date.now() - startedAt
				} : res;
			} catch (err) {
				const errMsg = formatErrorMessage(err);
				log.error(`heartbeat runner: targeted runOnce threw unexpectedly: ${errMsg}`, { error: errMsg });
				if (targetAgent) advanceAgentSchedule(targetAgent, now);
				scheduleNext();
				return {
					status: "failed",
					reason: errMsg
				};
			}
		}
		for (const agent of state.agents.values()) {
			if (isInterval && now < agent.nextDueMs) continue;
			let res;
			try {
				res = await runOnce({
					cfg: state.cfg,
					agentId: agent.agentId,
					heartbeat: agent.heartbeat,
					reason,
					deps: { runtime: state.runtime }
				});
			} catch (err) {
				const errMsg = formatErrorMessage(err);
				log.error(`heartbeat runner: runOnce threw unexpectedly: ${errMsg}`, { error: errMsg });
				advanceAgentSchedule(agent, now);
				continue;
			}
			if (res.status === "skipped" && res.reason === "requests-in-flight") {
				advanceAgentSchedule(agent, now);
				scheduleNext();
				return res;
			}
			if (res.status !== "skipped" || res.reason !== "disabled") advanceAgentSchedule(agent, now);
			if (res.status === "ran") ran = true;
		}
		scheduleNext();
		if (ran) return {
			status: "ran",
			durationMs: Date.now() - startedAt
		};
		return {
			status: "skipped",
			reason: isInterval ? "not-due" : "disabled"
		};
	};
	const wakeHandler = async (params) => run({
		reason: params.reason,
		agentId: params.agentId,
		sessionKey: params.sessionKey
	});
	const disposeWakeHandler = setHeartbeatWakeHandler(wakeHandler);
	updateConfig(state.cfg);
	const cleanup = () => {
		if (state.stopped) return;
		state.stopped = true;
		disposeWakeHandler();
		if (state.timer) clearTimeout(state.timer);
		state.timer = null;
	};
	opts.abortSignal?.addEventListener("abort", cleanup, { once: true });
	return {
		stop: cleanup,
		updateConfig
	};
}

//#endregion
//#region src/terminal/health-style.ts
function styleHealthChannelLine(line, rich) {
	if (!rich) return line;
	const colon = line.indexOf(":");
	if (colon === -1) return line;
	const label = line.slice(0, colon + 1);
	const detail = line.slice(colon + 1).trimStart();
	const normalized = detail.toLowerCase();
	const applyPrefix = (prefix, color) => `${label} ${color(detail.slice(0, prefix.length))}${detail.slice(prefix.length)}`;
	if (normalized.startsWith("failed")) return applyPrefix("failed", theme.error);
	if (normalized.startsWith("ok")) return applyPrefix("ok", theme.success);
	if (normalized.startsWith("linked")) return applyPrefix("linked", theme.success);
	if (normalized.startsWith("configured")) return applyPrefix("configured", theme.success);
	if (normalized.startsWith("not linked")) return applyPrefix("not linked", theme.warn);
	if (normalized.startsWith("not configured")) return applyPrefix("not configured", theme.muted);
	if (normalized.startsWith("unknown")) return applyPrefix("unknown", theme.warn);
	return line;
}

//#endregion
//#region src/commands/health.ts
var health_exports = /* @__PURE__ */ __exportAll({
	formatHealthChannelLines: () => formatHealthChannelLines,
	getHealthSnapshot: () => getHealthSnapshot,
	healthCommand: () => healthCommand
});
const DEFAULT_TIMEOUT_MS = 1e4;
const debugHealth = (...args) => {
	if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_HEALTH)) console.warn("[health:debug]", ...args);
};
const formatDurationParts = (ms) => {
	if (!Number.isFinite(ms)) return "unknown";
	if (ms < 1e3) return `${Math.max(0, Math.round(ms))}ms`;
	const units = [
		{
			label: "w",
			size: 10080 * 60 * 1e3
		},
		{
			label: "d",
			size: 1440 * 60 * 1e3
		},
		{
			label: "h",
			size: 3600 * 1e3
		},
		{
			label: "m",
			size: 60 * 1e3
		},
		{
			label: "s",
			size: 1e3
		}
	];
	let remaining = Math.max(0, Math.floor(ms));
	const parts = [];
	for (const unit of units) {
		const value = Math.floor(remaining / unit.size);
		if (value > 0) {
			parts.push(`${value}${unit.label}`);
			remaining -= value * unit.size;
		}
	}
	if (parts.length === 0) return "0s";
	return parts.join(" ");
};
const resolveHeartbeatSummary = (cfg, agentId) => resolveHeartbeatSummaryForAgent(cfg, agentId);
const resolveAgentOrder = (cfg) => {
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const entries = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	const seen = /* @__PURE__ */ new Set();
	const ordered = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.id !== "string" || !entry.id.trim()) continue;
		const id = normalizeAgentId(entry.id);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ordered.push({
			id,
			name: typeof entry.name === "string" ? entry.name : void 0
		});
	}
	if (!seen.has(defaultAgentId)) ordered.unshift({ id: defaultAgentId });
	if (ordered.length === 0) ordered.push({ id: defaultAgentId });
	return {
		defaultAgentId,
		ordered
	};
};
const buildSessionSummary = (storePath) => {
	const store = loadSessionStore(storePath);
	const sessions = Object.entries(store).filter(([key]) => key !== "global" && key !== "unknown").map(([key, entry]) => ({
		key,
		updatedAt: entry?.updatedAt ?? 0
	})).toSorted((a, b) => b.updatedAt - a.updatedAt);
	const recent = sessions.slice(0, 5).map((s) => ({
		key: s.key,
		updatedAt: s.updatedAt || null,
		age: s.updatedAt ? Date.now() - s.updatedAt : null
	}));
	return {
		path: storePath,
		count: sessions.length,
		recent
	};
};
const isAccountEnabled = (account) => {
	if (!account || typeof account !== "object") return true;
	return account.enabled !== false;
};
const asRecord = (value) => value && typeof value === "object" ? value : null;
const formatProbeLine = (probe, opts = {}) => {
	const record = asRecord(probe);
	if (!record) return null;
	const ok = typeof record.ok === "boolean" ? record.ok : void 0;
	if (ok === void 0) return null;
	const elapsedMs = typeof record.elapsedMs === "number" ? record.elapsedMs : null;
	const status = typeof record.status === "number" ? record.status : null;
	const error = typeof record.error === "string" ? record.error : null;
	const bot = asRecord(record.bot);
	const botUsername = bot && typeof bot.username === "string" ? bot.username : null;
	const webhook = asRecord(record.webhook);
	const webhookUrl = webhook && typeof webhook.url === "string" ? webhook.url : null;
	const usernames = /* @__PURE__ */ new Set();
	if (botUsername) usernames.add(botUsername);
	for (const extra of opts.botUsernames ?? []) if (extra) usernames.add(extra);
	if (ok) {
		let label = "ok";
		if (usernames.size > 0) label += ` (@${Array.from(usernames).join(", @")})`;
		if (elapsedMs != null) label += ` (${elapsedMs}ms)`;
		if (webhookUrl) label += ` - webhook ${webhookUrl}`;
		return label;
	}
	let label = `failed (${status ?? "unknown"})`;
	if (error) label += ` - ${error}`;
	return label;
};
const formatAccountProbeTiming = (summary) => {
	const probe = asRecord(summary.probe);
	if (!probe) return null;
	const elapsedMs = typeof probe.elapsedMs === "number" ? Math.round(probe.elapsedMs) : null;
	const ok = typeof probe.ok === "boolean" ? probe.ok : null;
	if (elapsedMs == null && ok !== true) return null;
	const accountId = summary.accountId || "default";
	const botRecord = asRecord(probe.bot);
	const botUsername = botRecord && typeof botRecord.username === "string" ? botRecord.username : null;
	return `${botUsername ? `@${botUsername}` : accountId}:${accountId}:${elapsedMs != null ? `${elapsedMs}ms` : "ok"}`;
};
const isProbeFailure = (summary) => {
	const probe = asRecord(summary.probe);
	if (!probe) return false;
	return (typeof probe.ok === "boolean" ? probe.ok : null) === false;
};
const formatHealthChannelLines = (summary, opts = {}) => {
	const channels = summary.channels ?? {};
	const channelOrder = summary.channelOrder?.length > 0 ? summary.channelOrder : Object.keys(channels);
	const accountMode = opts.accountMode ?? "default";
	const lines = [];
	for (const channelId of channelOrder) {
		const channelSummary = channels[channelId];
		if (!channelSummary) continue;
		const plugin = getChannelPlugin(channelId);
		const label = summary.channelLabels?.[channelId] ?? plugin?.meta.label ?? channelId;
		const accountSummaries = channelSummary.accounts ?? {};
		const accountIds = opts.accountIdsByChannel?.[channelId];
		const filteredSummaries = accountIds && accountIds.length > 0 ? accountIds.map((accountId) => accountSummaries[accountId]).filter((entry) => Boolean(entry)) : void 0;
		const listSummaries = accountMode === "all" ? Object.values(accountSummaries) : filteredSummaries ?? (channelSummary.accounts ? Object.values(accountSummaries) : []);
		const baseSummary = filteredSummaries && filteredSummaries.length > 0 ? filteredSummaries[0] : channelSummary;
		const botUsernames = listSummaries ? listSummaries.map((account) => {
			const probeRecord = asRecord(account.probe);
			const bot = probeRecord ? asRecord(probeRecord.bot) : null;
			return bot && typeof bot.username === "string" ? bot.username : null;
		}).filter((value) => Boolean(value)) : [];
		const linked = typeof baseSummary.linked === "boolean" ? baseSummary.linked : null;
		if (linked !== null) {
			if (linked) {
				const authAgeMs = typeof baseSummary.authAgeMs === "number" ? baseSummary.authAgeMs : null;
				const authLabel = authAgeMs != null ? ` (auth age ${Math.round(authAgeMs / 6e4)}m)` : "";
				lines.push(`${label}: linked${authLabel}`);
			} else lines.push(`${label}: not linked`);
			continue;
		}
		const configured = typeof baseSummary.configured === "boolean" ? baseSummary.configured : null;
		if (configured === false) {
			lines.push(`${label}: not configured`);
			continue;
		}
		const accountTimings = accountMode === "all" ? listSummaries.map((account) => formatAccountProbeTiming(account)).filter((value) => Boolean(value)) : [];
		const failedSummary = listSummaries.find((summary) => isProbeFailure(summary));
		if (failedSummary) {
			const failureLine = formatProbeLine(failedSummary.probe, { botUsernames });
			if (failureLine) {
				lines.push(`${label}: ${failureLine}`);
				continue;
			}
		}
		if (accountTimings.length > 0) {
			lines.push(`${label}: ok (${accountTimings.join(", ")})`);
			continue;
		}
		const probeLine = formatProbeLine(baseSummary.probe, { botUsernames });
		if (probeLine) {
			lines.push(`${label}: ${probeLine}`);
			continue;
		}
		if (configured === true) {
			lines.push(`${label}: configured`);
			continue;
		}
		lines.push(`${label}: unknown`);
	}
	return lines;
};
async function getHealthSnapshot(params) {
	const timeoutMs = params?.timeoutMs;
	const cfg = loadConfig();
	const { defaultAgentId, ordered } = resolveAgentOrder(cfg);
	const channelBindings = buildChannelAccountBindings(cfg);
	const sessionCache = /* @__PURE__ */ new Map();
	const agents = ordered.map((entry) => {
		const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
		const sessions = sessionCache.get(storePath) ?? buildSessionSummary(storePath);
		sessionCache.set(storePath, sessions);
		return {
			agentId: entry.id,
			name: entry.name,
			isDefault: entry.id === defaultAgentId,
			heartbeat: resolveHeartbeatSummary(cfg, entry.id),
			sessions
		};
	});
	const defaultAgent = agents.find((agent) => agent.isDefault) ?? agents[0];
	const heartbeatSeconds = defaultAgent?.heartbeat.everyMs ? Math.round(defaultAgent.heartbeat.everyMs / 1e3) : 0;
	const sessions = defaultAgent?.sessions ?? buildSessionSummary(resolveStorePath(cfg.session?.store, { agentId: defaultAgentId }));
	const start = Date.now();
	const cappedTimeout = timeoutMs === void 0 ? DEFAULT_TIMEOUT_MS : Math.max(50, timeoutMs);
	const doProbe = params?.probe !== false;
	const channels = {};
	const channelOrder = listChannelPlugins().map((plugin) => plugin.id);
	const channelLabels = {};
	for (const plugin of listChannelPlugins()) {
		channelLabels[plugin.id] = plugin.meta.label ?? plugin.id;
		const accountIds = plugin.config.listAccountIds(cfg);
		const defaultAccountId = resolveChannelDefaultAccountId({
			plugin,
			cfg,
			accountIds
		});
		const boundAccounts = channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [];
		const preferredAccountId = resolvePreferredAccountId({
			accountIds,
			defaultAccountId,
			boundAccounts
		});
		const boundAccountIdsAll = Array.from(new Set(Array.from(channelBindings.get(plugin.id)?.values() ?? []).flatMap((ids) => ids)));
		const accountIdsToProbe = Array.from(new Set([
			preferredAccountId,
			defaultAccountId,
			...accountIds,
			...boundAccountIdsAll
		].filter((value) => value && value.trim())));
		debugHealth("channel", {
			id: plugin.id,
			accountIds,
			defaultAccountId,
			boundAccounts,
			preferredAccountId,
			accountIdsToProbe
		});
		const accountSummaries = {};
		for (const accountId of accountIdsToProbe) {
			const account = plugin.config.resolveAccount(cfg, accountId);
			const enabled = plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : isAccountEnabled(account);
			const configured = plugin.config.isConfigured ? await plugin.config.isConfigured(account, cfg) : true;
			let probe;
			let lastProbeAt = null;
			if (enabled && configured && doProbe && plugin.status?.probeAccount) try {
				probe = await plugin.status.probeAccount({
					account,
					timeoutMs: cappedTimeout,
					cfg
				});
				lastProbeAt = Date.now();
			} catch (err) {
				probe = {
					ok: false,
					error: formatErrorMessage(err)
				};
				lastProbeAt = Date.now();
			}
			const probeRecord = probe && typeof probe === "object" ? probe : null;
			const bot = probeRecord && typeof probeRecord.bot === "object" ? probeRecord.bot : null;
			if (bot?.username) debugHealth("probe.bot", {
				channel: plugin.id,
				accountId,
				username: bot.username
			});
			const snapshot = {
				accountId,
				enabled,
				configured
			};
			if (probe !== void 0) snapshot.probe = probe;
			if (lastProbeAt) snapshot.lastProbeAt = lastProbeAt;
			const summary = plugin.status?.buildChannelSummary ? await plugin.status.buildChannelSummary({
				account,
				cfg,
				defaultAccountId: accountId,
				snapshot
			}) : void 0;
			const record = summary && typeof summary === "object" ? summary : {
				accountId,
				configured,
				probe,
				lastProbeAt
			};
			if (record.configured === void 0) record.configured = configured;
			if (record.lastProbeAt === void 0 && lastProbeAt) record.lastProbeAt = lastProbeAt;
			record.accountId = accountId;
			accountSummaries[accountId] = record;
		}
		const fallbackSummary = accountSummaries[preferredAccountId] ?? accountSummaries[defaultAccountId] ?? accountSummaries[accountIdsToProbe[0] ?? preferredAccountId] ?? accountSummaries[Object.keys(accountSummaries)[0]];
		if (fallbackSummary) channels[plugin.id] = {
			...fallbackSummary,
			accounts: accountSummaries
		};
	}
	return {
		ok: true,
		ts: Date.now(),
		durationMs: Date.now() - start,
		channels,
		channelOrder,
		channelLabels,
		heartbeatSeconds,
		defaultAgentId,
		agents,
		sessions: {
			path: sessions.path,
			count: sessions.count,
			recent: sessions.recent
		}
	};
}
async function healthCommand(opts, runtime) {
	const cfg = opts.config ?? loadConfig();
	const summary = await withProgress({
		label: "Checking gateway health…",
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => await callGateway({
		method: "health",
		params: opts.verbose ? { probe: true } : void 0,
		timeoutMs: opts.timeoutMs,
		config: cfg
	}));
	if (opts.json) runtime.log(JSON.stringify(summary, null, 2));
	else {
		const debugEnabled = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_HEALTH);
		const rich = isRich();
		if (opts.verbose) {
			const details = buildGatewayConnectionDetails({ config: cfg });
			runtime.log(info("Gateway connection:"));
			for (const line of details.message.split("\n")) runtime.log(`  ${line}`);
		}
		const localAgents = resolveAgentOrder(cfg);
		const defaultAgentId = summary.defaultAgentId ?? localAgents.defaultAgentId;
		const agents = Array.isArray(summary.agents) ? summary.agents : [];
		const fallbackAgents = localAgents.ordered.map((entry) => {
			const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
			return {
				agentId: entry.id,
				name: entry.name,
				isDefault: entry.id === localAgents.defaultAgentId,
				heartbeat: resolveHeartbeatSummary(cfg, entry.id),
				sessions: buildSessionSummary(storePath)
			};
		});
		const resolvedAgents = agents.length > 0 ? agents : fallbackAgents;
		const displayAgents = opts.verbose ? resolvedAgents : resolvedAgents.filter((agent) => agent.agentId === defaultAgentId);
		const channelBindings = buildChannelAccountBindings(cfg);
		if (debugEnabled) {
			runtime.log(info("[debug] local channel accounts"));
			for (const plugin of listChannelPlugins()) {
				const accountIds = plugin.config.listAccountIds(cfg);
				const defaultAccountId = resolveChannelDefaultAccountId({
					plugin,
					cfg,
					accountIds
				});
				runtime.log(`  ${plugin.id}: accounts=${accountIds.join(", ") || "(none)"} default=${defaultAccountId}`);
				for (const accountId of accountIds) {
					const account = plugin.config.resolveAccount(cfg, accountId);
					const record = asRecord(account);
					const tokenSource = record && typeof record.tokenSource === "string" ? record.tokenSource : void 0;
					const configured = plugin.config.isConfigured ? await plugin.config.isConfigured(account, cfg) : true;
					runtime.log(`    - ${accountId}: configured=${configured}${tokenSource ? ` tokenSource=${tokenSource}` : ""}`);
				}
			}
			runtime.log(info("[debug] bindings map"));
			for (const [channelId, byAgent] of channelBindings.entries()) {
				const entries = Array.from(byAgent.entries()).map(([agentId, ids]) => `${agentId}=[${ids.join(", ")}]`);
				runtime.log(`  ${channelId}: ${entries.join(" ")}`);
			}
			runtime.log(info("[debug] gateway channel probes"));
			for (const [channelId, channelSummary] of Object.entries(summary.channels ?? {})) {
				const accounts = channelSummary.accounts ?? {};
				const probes = Object.entries(accounts).map(([accountId, accountSummary]) => {
					const probe = asRecord(accountSummary.probe);
					const bot = probe ? asRecord(probe.bot) : null;
					return `${accountId}=${(bot && typeof bot.username === "string" ? bot.username : null) ?? "(no bot)"}`;
				});
				runtime.log(`  ${channelId}: ${probes.join(", ") || "(none)"}`);
			}
		}
		const channelAccountFallbacks = Object.fromEntries(listChannelPlugins().map((plugin) => {
			const accountIds = plugin.config.listAccountIds(cfg);
			const preferred = resolvePreferredAccountId({
				accountIds,
				defaultAccountId: resolveChannelDefaultAccountId({
					plugin,
					cfg,
					accountIds
				}),
				boundAccounts: channelBindings.get(plugin.id)?.get(defaultAgentId) ?? []
			});
			return [plugin.id, [preferred]];
		}));
		const accountIdsByChannel = (() => {
			const entries = displayAgents.length > 0 ? displayAgents : resolvedAgents;
			const byChannel = {};
			for (const [channelId, byAgent] of channelBindings.entries()) {
				const accountIds = [];
				for (const agent of entries) {
					const ids = byAgent.get(agent.agentId) ?? [];
					for (const id of ids) if (!accountIds.includes(id)) accountIds.push(id);
				}
				if (accountIds.length > 0) byChannel[channelId] = accountIds;
			}
			for (const [channelId, fallbackIds] of Object.entries(channelAccountFallbacks)) if (!byChannel[channelId] || byChannel[channelId].length === 0) byChannel[channelId] = fallbackIds;
			return byChannel;
		})();
		const channelLines = Object.keys(accountIdsByChannel).length > 0 ? formatHealthChannelLines(summary, {
			accountMode: opts.verbose ? "all" : "default",
			accountIdsByChannel
		}) : formatHealthChannelLines(summary, { accountMode: opts.verbose ? "all" : "default" });
		for (const line of channelLines) runtime.log(styleHealthChannelLine(line, rich));
		for (const plugin of listChannelPlugins()) {
			const channelSummary = summary.channels?.[plugin.id];
			if (!channelSummary || channelSummary.linked !== true) continue;
			if (!plugin.status?.logSelfId) continue;
			const boundAccounts = channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [];
			const accountIds = plugin.config.listAccountIds(cfg);
			const accountId = resolvePreferredAccountId({
				accountIds,
				defaultAccountId: resolveChannelDefaultAccountId({
					plugin,
					cfg,
					accountIds
				}),
				boundAccounts
			});
			const account = plugin.config.resolveAccount(cfg, accountId);
			plugin.status.logSelfId({
				account,
				cfg,
				runtime,
				includeChannelPrefix: true
			});
		}
		if (resolvedAgents.length > 0) {
			const agentLabels = resolvedAgents.map((agent) => agent.isDefault ? `${agent.agentId} (default)` : agent.agentId);
			runtime.log(info(`Agents: ${agentLabels.join(", ")}`));
		}
		const heartbeatParts = displayAgents.map((agent) => {
			const everyMs = agent.heartbeat?.everyMs;
			return `${everyMs ? formatDurationParts(everyMs) : "disabled"} (${agent.agentId})`;
		}).filter(Boolean);
		if (heartbeatParts.length > 0) runtime.log(info(`Heartbeat interval: ${heartbeatParts.join(", ")}`));
		if (displayAgents.length === 0) {
			runtime.log(info(`Session store: ${summary.sessions.path} (${summary.sessions.count} entries)`));
			if (summary.sessions.recent.length > 0) for (const r of summary.sessions.recent) runtime.log(`- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 6e4)}m ago` : "no activity"})`);
		} else for (const agent of displayAgents) {
			runtime.log(info(`Session store (${agent.agentId}): ${agent.sessions.path} (${agent.sessions.count} entries)`));
			if (agent.sessions.recent.length > 0) for (const r of agent.sessions.recent) runtime.log(`- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 6e4)}m ago` : "no activity"})`);
		}
	}
}

//#endregion
export { styleHealthChannelLine as a, setHeartbeatsEnabled as c, health_exports as i, startHeartbeatRunner as l, getHealthSnapshot as n, resolveHeartbeatSummaryForAgent as o, healthCommand as r, runHeartbeatOnce as s, formatHealthChannelLines as t };