import { f as toAcpRuntimeError } from "./provider-env-vars-BfZUtZAn.js";
import { c as normalizeAgentId, l as normalizeMainKey, u as resolveAgentIdFromSessionKey } from "./session-key-BfFG0xOA.js";
import { $ as normalizeChannelId, St as formatDiscordUserTag, Z as getChannelPlugin, gt as resolveDiscordOwnerAccess, i as resolveAgentRoute } from "./resolve-route-BZ4hHpx2.js";
import { t as formatCliCommand } from "./command-format-ZZqKRRhR.js";
import "./logger-CRwcgB9y.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-Bz3ouN_i.js";
import "./paths-Byjx7_T6.js";
import { a as defaultRuntime, f as logVerbose, h as shouldLogVerbose, t as createSubsystemLogger } from "./subsystem-CsP80x3t.js";
import "./utils-o1tyfnZ_.js";
import "./fetch-Dx857jUp.js";
import "./retry-BY_ggjbn.js";
import { S as ensureAgentWorkspace, c as resolveAgentWorkspaceDir, f as resolveSessionAgentId, i as resolveAgentDir, n as listAgentIds, s as resolveAgentSkillsFilter, u as resolveEffectiveModelFallbacks } from "./agent-scope-DV_aCIyi.js";
import "./exec-BLi45_38.js";
import "./logger-Bsnck4bK.js";
import "./paths-OqPpu-UR.js";
import { $n as deliverOutboundPayloads, Af as DEFAULT_MODEL, An as resolveBootstrapWarningSignaturesSeen, Ba as registerAgentRunContext, Bn as AGENT_LANE_SUBAGENT, Dn as runEmbeddedPiAgent, Ds as loadSessionStore, En as normalizeReplyPayload, Es as emitSessionTranscriptUpdate, Ff as isGatewayMessageChannel, Fn as normalizeSpawnedRunMetadata, Fs as normalizeAccountId, Gd as formatErrorMessage, Gf as isSilentReplyText, Gn as deriveSessionTotalTokens, If as isInternalMessageChannel, In as resolveAcpSessionCwd, J as setCliSessionId, Jd as buildWorkspaceSkillSnapshot, Kn as hasNonzeroUsage, Lf as normalizeMessageChannel, Ln as resolveAcpAgentPolicyError, Ls as resolveSessionKey, Mp as formatXHighModelHint, Ms as updateSessionStore, Nf as INTERNAL_MESSAGE_CHANNEL, Np as normalizeThinkLevel, On as prepareSessionManagerForRun, Pc as formatMention, Pf as isDeliverableMessageChannel, Pp as normalizeVerboseLevel, Qn as buildOutboundSessionContext, Ra as clearAgentRunContext, Rf as resolveMessageChannel, Rn as resolveAcpDispatchPolicyError, Sr as parseTtsDirectives, Tn as formatAgentInternalEventsForPrompt, Ts as resolveSessionTranscriptFile, Vf as resolveAgentTimeoutMs, Vn as applyModelOverrideToSessionEntry, Wf as isSilentReplyPrefixText, Xn as resolveOutboundTarget, Y as runCliAgent, Z as applyVerboseOverride, Zn as resolveSessionDeliveryTarget, a as buildAllowedModelSet, ad as resolveChannelResetConfig, as as resolveSendPolicy, br as resolveTtsConfig, c as normalizeModelRef, cd as mergeSessionEntry, cf as readConfigFileSnapshotForWrite, d as resolveThinkingDefault, dr as resolveCommandSecretRefsViaGateway, er as formatOutboundPayloadLog, f as formatThinkingLevels, fn as getRemoteSkillEligibility, fs as buildProviderRegistry, gs as runCapability, hn as clearSessionAuthProfileOverride, hr as FailoverError, id as evaluateSessionFreshness, jf as DEFAULT_PROVIDER, l as resolveConfiguredModelRef, ld as setSessionRuntimeModel, lf as setRuntimeConfigSnapshot, lr as resolveMessageChannelSelection, ls as getAcpSessionManager, mr as runWithModelFallback, ms as normalizeMediaAttachments, nr as normalizeOutboundPayloadsForJson, o as isCliProvider, od as resolveSessionResetPolicy, of as loadConfig, p as supportsXHighThinking, pn as getSkillsSnapshotVersion, ps as createMediaAttachmentCache, q as getCliSessionId, qn as resolveContextTokensForModel, s as modelKey, sd as resolveSessionResetType, tr as normalizeOutboundPayloads, u as resolveDefaultModelForAgent, ud as resolveExplicitAgentSessionKey, ur as getAgentRuntimeCommandSecretTargetIds, vs as loadModelCatalog, xr as textToSpeech, yr as clearBootstrapSnapshotOnSessionRollover, za as emitAgentEvent, zn as AGENT_LANE_NESTED } from "./auth-profiles-CuJtivJK.js";
import { a as ensureAuthProfileStore, l as normalizeProviderId } from "./profiles-CV7WLKIX.js";
import "./fetch-D2ZOzaXt.js";
import "./external-content-vZzOHxnd.js";
import "./kilocode-shared-Ci8SRxXc.js";
import "./models-config.providers.static-DRBnLpDj.js";
import "./models-config.providers.discovery-l-LpSxGW.js";
import "./pairing-token-DKpN4qO0.js";
import { R as resolveStorePath } from "./query-expansion-txqQdNIf.js";
import "./redact-BefI-5cC.js";
import "./mime-33LCeGh-.js";
import "./typebox-BmZP6XXv.js";
import "./web-search-plugin-factory-DStYVW2B.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-CHxlFG8H.js";
import { createRequire } from "node:module";
import path from "node:path";
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { ChannelType, ReadyListener } from "@buape/carbon";
import { AudioPlayerStatus, EndBehaviorType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel } from "@discordjs/voice";
//#region src/cli/outbound-send-mapping.ts
const LEGACY_SOURCE_TO_CHANNEL = {
	sendMessageWhatsApp: "whatsapp",
	sendMessageTelegram: "telegram",
	sendMessageDiscord: "discord",
	sendMessageSlack: "slack",
	sendMessageSignal: "signal",
	sendMessageIMessage: "imessage"
};
const CHANNEL_TO_LEGACY_DEP_KEY = {
	whatsapp: "sendWhatsApp",
	telegram: "sendTelegram",
	discord: "sendDiscord",
	slack: "sendSlack",
	signal: "sendSignal",
	imessage: "sendIMessage"
};
/**
* Pass CLI send sources through as-is — both CliOutboundSendSource and
* OutboundSendDeps are now channel-ID-keyed records.
*/
function createOutboundSendDepsFromCliSource(deps) {
	const outbound = { ...deps };
	for (const [legacySourceKey, channelId] of Object.entries(LEGACY_SOURCE_TO_CHANNEL)) {
		const sourceValue = deps[legacySourceKey];
		if (sourceValue !== void 0 && outbound[channelId] === void 0) {outbound[channelId] = sourceValue;}
	}
	for (const [channelId, legacyDepKey] of Object.entries(CHANNEL_TO_LEGACY_DEP_KEY)) {
		const sourceValue = outbound[channelId];
		if (sourceValue !== void 0 && outbound[legacyDepKey] === void 0) {outbound[legacyDepKey] = sourceValue;}
	}
	return outbound;
}
//#endregion
//#region src/cli/deps.ts
const senderCache = /* @__PURE__ */ new Map();
/**
* Create a lazy-loading send function proxy for a channel.
* The channel's module is loaded on first call and cached for reuse.
*/
function createLazySender(channelId, loader, exportName) {
	return async (...args) => {
		let cached = senderCache.get(channelId);
		if (!cached) {
			cached = loader();
			senderCache.set(channelId, cached);
		}
		const fn = (await cached)[exportName];
		return await fn(...args);
	};
}
function createDefaultDeps() {
	return {
		whatsapp: createLazySender("whatsapp", () => import("./auth-profiles-CuJtivJK.js").then((n) => n.y), "sendMessageWhatsApp"),
		telegram: createLazySender("telegram", () => import("./auth-profiles-CuJtivJK.js").then((n) => n.Br), "sendMessageTelegram"),
		discord: createLazySender("discord", () => import("./auth-profiles-CuJtivJK.js").then((n) => n.Rs), "sendMessageDiscord"),
		slack: createLazySender("slack", () => import("./auth-profiles-CuJtivJK.js").then((n) => n.pl), "sendMessageSlack"),
		signal: createLazySender("signal", () => import("./auth-profiles-CuJtivJK.js").then((n) => n.Sa), "sendMessageSignal"),
		imessage: createLazySender("imessage", () => import("./imessage-CRu9VOhJ.js"), "sendMessageIMessage")
	};
}
//#endregion
//#region src/cli/outbound-send-deps.ts
function createOutboundSendDeps(deps) {
	return createOutboundSendDepsFromCliSource(deps);
}
//#endregion
//#region src/infra/outbound/agent-delivery.ts
function resolveAgentDeliveryPlan(params) {
	const requestedRaw = typeof params.requestedChannel === "string" ? params.requestedChannel.trim() : "";
	const requestedChannel = (requestedRaw ? normalizeMessageChannel(requestedRaw) : void 0) || "last";
	const explicitTo = typeof params.explicitTo === "string" && params.explicitTo.trim() ? params.explicitTo.trim() : void 0;
	const normalizedTurnSource = params.turnSourceChannel ? normalizeMessageChannel(params.turnSourceChannel) : void 0;
	const turnSourceChannel = normalizedTurnSource && isDeliverableMessageChannel(normalizedTurnSource) ? normalizedTurnSource : void 0;
	const turnSourceTo = typeof params.turnSourceTo === "string" && params.turnSourceTo.trim() ? params.turnSourceTo.trim() : void 0;
	const turnSourceAccountId = normalizeAccountId(params.turnSourceAccountId);
	const turnSourceThreadId = params.turnSourceThreadId != null && params.turnSourceThreadId !== "" ? params.turnSourceThreadId : void 0;
	const baseDelivery = resolveSessionDeliveryTarget({
		entry: params.sessionEntry,
		requestedChannel: requestedChannel === "webchat" ? "last" : requestedChannel,
		explicitTo,
		explicitThreadId: params.explicitThreadId,
		turnSourceChannel,
		turnSourceTo,
		turnSourceAccountId,
		turnSourceThreadId
	});
	const resolvedChannel = (() => {
		if (requestedChannel === "webchat") {return INTERNAL_MESSAGE_CHANNEL;}
		if (requestedChannel === "last") {
			if (baseDelivery.channel && baseDelivery.channel !== "webchat") {return baseDelivery.channel;}
			return INTERNAL_MESSAGE_CHANNEL;
		}
		if (isGatewayMessageChannel(requestedChannel)) {return requestedChannel;}
		if (baseDelivery.channel && baseDelivery.channel !== "webchat") {return baseDelivery.channel;}
		return INTERNAL_MESSAGE_CHANNEL;
	})();
	const deliveryTargetMode = explicitTo ? "explicit" : isDeliverableMessageChannel(resolvedChannel) ? "implicit" : void 0;
	const resolvedAccountId = normalizeAccountId(params.accountId) ?? (deliveryTargetMode === "implicit" ? baseDelivery.accountId : void 0);
	let resolvedTo = explicitTo;
	if (!resolvedTo && isDeliverableMessageChannel(resolvedChannel) && resolvedChannel === baseDelivery.lastChannel) {resolvedTo = baseDelivery.lastTo;}
	return {
		baseDelivery,
		resolvedChannel,
		resolvedTo,
		resolvedAccountId,
		resolvedThreadId: baseDelivery.threadId,
		deliveryTargetMode
	};
}
function resolveAgentOutboundTarget(params) {
	const targetMode = params.targetMode ?? params.plan.deliveryTargetMode ?? (params.plan.resolvedTo ? "explicit" : "implicit");
	if (!isDeliverableMessageChannel(params.plan.resolvedChannel)) {return {
		resolvedTarget: null,
		resolvedTo: params.plan.resolvedTo,
		targetMode
	};}
	if (params.validateExplicitTarget !== true && params.plan.resolvedTo) {return {
		resolvedTarget: null,
		resolvedTo: params.plan.resolvedTo,
		targetMode
	};}
	const resolvedTarget = resolveOutboundTarget({
		channel: params.plan.resolvedChannel,
		to: params.plan.resolvedTo,
		cfg: params.cfg,
		accountId: params.plan.resolvedAccountId,
		mode: targetMode
	});
	return {
		resolvedTarget,
		resolvedTo: resolvedTarget.ok ? resolvedTarget.to : params.plan.resolvedTo,
		targetMode
	};
}
//#endregion
//#region src/infra/outbound/envelope.ts
const isOutboundPayloadJson = (payload) => "mediaUrl" in payload;
function buildOutboundResultEnvelope(params) {
	const hasPayloads = params.payloads !== void 0;
	const payloads = params.payloads === void 0 ? void 0 : params.payloads.length === 0 ? [] : isOutboundPayloadJson(params.payloads[0]) ? [...params.payloads] : normalizeOutboundPayloadsForJson(params.payloads);
	if (params.flattenDelivery !== false && params.delivery && !params.meta && !hasPayloads) {return params.delivery;}
	return {
		...hasPayloads ? { payloads } : {},
		...params.meta ? { meta: params.meta } : {},
		...params.delivery ? { delivery: params.delivery } : {}
	};
}
//#endregion
//#region src/commands/agent/delivery.ts
const NESTED_LOG_PREFIX = "[agent:nested]";
function formatNestedLogPrefix(opts, sessionKey) {
	const parts = [NESTED_LOG_PREFIX];
	const session = sessionKey ?? opts.sessionKey ?? opts.sessionId;
	if (session) {parts.push(`session=${session}`);}
	if (opts.runId) {parts.push(`run=${opts.runId}`);}
	const channel = opts.messageChannel ?? opts.channel;
	if (channel) {parts.push(`channel=${channel}`);}
	if (opts.to) {parts.push(`to=${opts.to}`);}
	if (opts.accountId) {parts.push(`account=${opts.accountId}`);}
	return parts.join(" ");
}
function logNestedOutput(runtime, opts, output, sessionKey) {
	const prefix = formatNestedLogPrefix(opts, sessionKey);
	for (const line of output.split(/\r?\n/)) {
		if (!line) {continue;}
		runtime.log(`${prefix} ${line}`);
	}
}
async function deliverAgentCommandResult(params) {
	const { cfg, deps, runtime, opts, outboundSession, sessionEntry, payloads, result } = params;
	const effectiveSessionKey = outboundSession?.key ?? opts.sessionKey;
	const deliver = opts.deliver === true;
	const bestEffortDeliver = opts.bestEffortDeliver === true;
	const turnSourceChannel = opts.runContext?.messageChannel ?? opts.messageChannel;
	const turnSourceTo = opts.runContext?.currentChannelId ?? opts.to;
	const turnSourceAccountId = opts.runContext?.accountId ?? opts.accountId;
	const turnSourceThreadId = opts.runContext?.currentThreadTs ?? opts.threadId;
	const deliveryPlan = resolveAgentDeliveryPlan({
		sessionEntry,
		requestedChannel: opts.replyChannel ?? opts.channel,
		explicitTo: opts.replyTo ?? opts.to,
		explicitThreadId: opts.threadId,
		accountId: opts.replyAccountId ?? opts.accountId,
		wantsDelivery: deliver,
		turnSourceChannel,
		turnSourceTo,
		turnSourceAccountId,
		turnSourceThreadId
	});
	let deliveryChannel = deliveryPlan.resolvedChannel;
	const explicitChannelHint = (opts.replyChannel ?? opts.channel)?.trim();
	if (deliver && isInternalMessageChannel(deliveryChannel) && !explicitChannelHint) {try {
		deliveryChannel = (await resolveMessageChannelSelection({ cfg })).channel;
	} catch {}}
	const effectiveDeliveryPlan = deliveryChannel === deliveryPlan.resolvedChannel ? deliveryPlan : {
		...deliveryPlan,
		resolvedChannel: deliveryChannel
	};
	const deliveryPlugin = !isInternalMessageChannel(deliveryChannel) ? getChannelPlugin(normalizeChannelId(deliveryChannel) ?? deliveryChannel) : void 0;
	const isDeliveryChannelKnown = isInternalMessageChannel(deliveryChannel) || Boolean(deliveryPlugin);
	const targetMode = opts.deliveryTargetMode ?? effectiveDeliveryPlan.deliveryTargetMode ?? (opts.to ? "explicit" : "implicit");
	const resolvedAccountId = effectiveDeliveryPlan.resolvedAccountId;
	const resolved = deliver && isDeliveryChannelKnown && deliveryChannel ? resolveAgentOutboundTarget({
		cfg,
		plan: effectiveDeliveryPlan,
		targetMode,
		validateExplicitTarget: true
	}) : {
		resolvedTarget: null,
		resolvedTo: effectiveDeliveryPlan.resolvedTo,
		targetMode
	};
	const resolvedTarget = resolved.resolvedTarget;
	const deliveryTarget = resolved.resolvedTo;
	const resolvedThreadId = deliveryPlan.resolvedThreadId ?? opts.threadId;
	const resolvedReplyToId = deliveryChannel === "slack" && resolvedThreadId != null ? String(resolvedThreadId) : void 0;
	const resolvedThreadTarget = deliveryChannel === "slack" ? void 0 : resolvedThreadId;
	const logDeliveryError = (err) => {
		const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
		runtime.error?.(message);
		if (!runtime.error) {runtime.log(message);}
	};
	if (deliver) {
		if (isInternalMessageChannel(deliveryChannel)) {
			const err = /* @__PURE__ */ new Error("delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel");
			if (!bestEffortDeliver) {throw err;}
			logDeliveryError(err);
		} else if (!isDeliveryChannelKnown) {
			const err = /* @__PURE__ */ new Error(`Unknown channel: ${deliveryChannel}`);
			if (!bestEffortDeliver) {throw err;}
			logDeliveryError(err);
		} else if (resolvedTarget && !resolvedTarget.ok) {
			if (!bestEffortDeliver) {throw resolvedTarget.error;}
			logDeliveryError(resolvedTarget.error);
		}
	}
	const normalizedPayloads = normalizeOutboundPayloadsForJson(payloads ?? []);
	if (opts.json) {
		runtime.log(JSON.stringify(buildOutboundResultEnvelope({
			payloads: normalizedPayloads,
			meta: result.meta
		}), null, 2));
		if (!deliver) {return {
			payloads: normalizedPayloads,
			meta: result.meta
		};}
	}
	if (!payloads || payloads.length === 0) {
		runtime.log("No reply from agent.");
		return {
			payloads: [],
			meta: result.meta
		};
	}
	const deliveryPayloads = normalizeOutboundPayloads(payloads);
	const logPayload = (payload) => {
		if (opts.json) {return;}
		const output = formatOutboundPayloadLog(payload);
		if (!output) {return;}
		if (opts.lane === AGENT_LANE_NESTED) {
			logNestedOutput(runtime, opts, output, effectiveSessionKey);
			return;
		}
		runtime.log(output);
	};
	if (!deliver) {for (const payload of deliveryPayloads) logPayload(payload);}
	if (deliver && deliveryChannel && !isInternalMessageChannel(deliveryChannel)) {
		if (deliveryTarget) {await deliverOutboundPayloads({
			cfg,
			channel: deliveryChannel,
			to: deliveryTarget,
			accountId: resolvedAccountId,
			payloads: deliveryPayloads,
			session: outboundSession,
			replyToId: resolvedReplyToId ?? null,
			threadId: resolvedThreadTarget ?? null,
			bestEffort: bestEffortDeliver,
			onError: (err) => logDeliveryError(err),
			onPayload: logPayload,
			deps: createOutboundSendDeps(deps)
		});}
	}
	return {
		payloads: normalizedPayloads,
		meta: result.meta
	};
}
//#endregion
//#region src/commands/agent/run-context.ts
function resolveAgentRunContext(opts) {
	const merged = opts.runContext ? { ...opts.runContext } : {};
	const normalizedChannel = resolveMessageChannel(merged.messageChannel ?? opts.messageChannel, opts.replyChannel ?? opts.channel);
	if (normalizedChannel) {merged.messageChannel = normalizedChannel;}
	const normalizedAccountId = normalizeAccountId(merged.accountId ?? opts.accountId);
	if (normalizedAccountId) {merged.accountId = normalizedAccountId;}
	const groupId = (merged.groupId ?? opts.groupId)?.toString().trim();
	if (groupId) {merged.groupId = groupId;}
	const groupChannel = (merged.groupChannel ?? opts.groupChannel)?.toString().trim();
	if (groupChannel) {merged.groupChannel = groupChannel;}
	const groupSpace = (merged.groupSpace ?? opts.groupSpace)?.toString().trim();
	if (groupSpace) {merged.groupSpace = groupSpace;}
	if (merged.currentThreadTs == null && opts.threadId != null && opts.threadId !== "" && opts.threadId !== null) {merged.currentThreadTs = String(opts.threadId);}
	if (!merged.currentChannelId && opts.to) {
		const trimmedTo = opts.to.trim();
		if (trimmedTo) {merged.currentChannelId = trimmedTo;}
	}
	return merged;
}
//#endregion
//#region src/commands/agent/session-store.ts
async function updateSessionStoreAfterAgentRun(params) {
	const { cfg, sessionId, sessionKey, storePath, sessionStore, defaultProvider, defaultModel, fallbackProvider, fallbackModel, result } = params;
	const usage = result.meta.agentMeta?.usage;
	const promptTokens = result.meta.agentMeta?.promptTokens;
	const compactionsThisRun = Math.max(0, result.meta.agentMeta?.compactionCount ?? 0);
	const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
	const providerUsed = result.meta.agentMeta?.provider ?? fallbackProvider ?? defaultProvider;
	const contextTokens = resolveContextTokensForModel({
		cfg,
		provider: providerUsed,
		model: modelUsed,
		contextTokensOverride: params.contextTokensOverride,
		fallbackContextTokens: 2e5
	}) ?? 2e5;
	const entry = sessionStore[sessionKey] ?? {
		sessionId,
		updatedAt: Date.now()
	};
	const next = {
		...entry,
		sessionId,
		updatedAt: Date.now(),
		contextTokens
	};
	setSessionRuntimeModel(next, {
		provider: providerUsed,
		model: modelUsed
	});
	if (isCliProvider(providerUsed, cfg)) {
		const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
		if (cliSessionId) {setCliSessionId(next, providerUsed, cliSessionId);}
	}
	next.abortedLastRun = result.meta.aborted ?? false;
	if (result.meta.systemPromptReport) {next.systemPromptReport = result.meta.systemPromptReport;}
	if (hasNonzeroUsage(usage)) {
		const input = usage.input ?? 0;
		const output = usage.output ?? 0;
		const totalTokens = deriveSessionTotalTokens({
			usage,
			contextTokens,
			promptTokens
		});
		next.inputTokens = input;
		next.outputTokens = output;
		if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
			next.totalTokens = totalTokens;
			next.totalTokensFresh = true;
		} else {
			next.totalTokens = void 0;
			next.totalTokensFresh = false;
		}
		next.cacheRead = usage.cacheRead ?? 0;
		next.cacheWrite = usage.cacheWrite ?? 0;
	}
	if (compactionsThisRun > 0) {next.compactionCount = (entry.compactionCount ?? 0) + compactionsThisRun;}
	sessionStore[sessionKey] = await updateSessionStore(storePath, (store) => {
		const merged = mergeSessionEntry(store[sessionKey], next);
		store[sessionKey] = merged;
		return merged;
	});
}
//#endregion
//#region src/commands/agent/session.ts
function resolveSessionKeyForRequest(opts) {
	const sessionCfg = opts.cfg.session;
	const scope = sessionCfg?.scope ?? "per-sender";
	const mainKey = normalizeMainKey(sessionCfg?.mainKey);
	const explicitSessionKey = opts.sessionKey?.trim() || resolveExplicitAgentSessionKey({
		cfg: opts.cfg,
		agentId: opts.agentId
	});
	const storeAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);
	const storePath = resolveStorePath(sessionCfg?.store, { agentId: storeAgentId });
	const sessionStore = loadSessionStore(storePath);
	const ctx = opts.to?.trim() ? { From: opts.to } : void 0;
	let sessionKey = explicitSessionKey ?? (ctx ? resolveSessionKey(scope, ctx, mainKey) : void 0);
	if (!explicitSessionKey && opts.sessionId && (!sessionKey || sessionStore[sessionKey]?.sessionId !== opts.sessionId)) {
		const foundKey = Object.keys(sessionStore).find((key) => sessionStore[key]?.sessionId === opts.sessionId);
		if (foundKey) {sessionKey = foundKey;}
	}
	if (opts.sessionId && !explicitSessionKey && (!sessionKey || sessionStore[sessionKey]?.sessionId !== opts.sessionId)) {
		const allAgentIds = listAgentIds(opts.cfg);
		for (const agentId of allAgentIds) {
			if (agentId === storeAgentId) {continue;}
			const altStorePath = resolveStorePath(sessionCfg?.store, { agentId });
			const altStore = loadSessionStore(altStorePath);
			const foundKey = Object.keys(altStore).find((key) => altStore[key]?.sessionId === opts.sessionId);
			if (foundKey) {return {
				sessionKey: foundKey,
				sessionStore: altStore,
				storePath: altStorePath
			};}
		}
	}
	return {
		sessionKey,
		sessionStore,
		storePath
	};
}
function resolveSession(opts) {
	const sessionCfg = opts.cfg.session;
	const { sessionKey, sessionStore, storePath } = resolveSessionKeyForRequest({
		cfg: opts.cfg,
		to: opts.to,
		sessionId: opts.sessionId,
		sessionKey: opts.sessionKey,
		agentId: opts.agentId
	});
	const now = Date.now();
	const sessionEntry = sessionKey ? sessionStore[sessionKey] : void 0;
	const resetPolicy = resolveSessionResetPolicy({
		sessionCfg,
		resetType: resolveSessionResetType({ sessionKey }),
		resetOverride: resolveChannelResetConfig({
			sessionCfg,
			channel: sessionEntry?.lastChannel ?? sessionEntry?.channel
		})
	});
	const fresh = sessionEntry ? evaluateSessionFreshness({
		updatedAt: sessionEntry.updatedAt,
		now,
		policy: resetPolicy
	}).fresh : false;
	const sessionId = opts.sessionId?.trim() || (fresh ? sessionEntry?.sessionId : void 0) || crypto.randomUUID();
	const isNewSession = !fresh && !opts.sessionId;
	clearBootstrapSnapshotOnSessionRollover({
		sessionKey,
		previousSessionId: isNewSession ? sessionEntry?.sessionId : void 0
	});
	return {
		sessionId,
		sessionKey,
		sessionEntry,
		sessionStore,
		storePath,
		isNewSession,
		persistedThinking: fresh && sessionEntry?.thinkingLevel ? normalizeThinkLevel(sessionEntry.thinkingLevel) : void 0,
		persistedVerbose: fresh && sessionEntry?.verboseLevel ? normalizeVerboseLevel(sessionEntry.verboseLevel) : void 0
	};
}
//#endregion
//#region src/commands/agent.ts
const log = createSubsystemLogger("commands/agent");
const OVERRIDE_FIELDS_CLEARED_BY_DELETE = [
	"providerOverride",
	"modelOverride",
	"authProfileOverride",
	"authProfileOverrideSource",
	"authProfileOverrideCompactionCount",
	"fallbackNoticeSelectedModel",
	"fallbackNoticeActiveModel",
	"fallbackNoticeReason",
	"claudeCliSessionId"
];
async function persistSessionEntry(params) {
	const persisted = await updateSessionStore(params.storePath, (store) => {
		const merged = mergeSessionEntry(store[params.sessionKey], params.entry);
		for (const field of OVERRIDE_FIELDS_CLEARED_BY_DELETE) {if (!Object.hasOwn(params.entry, field)) Reflect.deleteProperty(merged, field);}
		store[params.sessionKey] = merged;
		return merged;
	});
	params.sessionStore[params.sessionKey] = persisted;
}
function resolveFallbackRetryPrompt(params) {
	if (!params.isFallbackRetry) {return params.body;}
	return "Continue where you left off. The previous model attempt failed or timed out.";
}
function prependInternalEventContext(body, events) {
	if (body.includes("OpenClaw runtime context (internal):")) {return body;}
	const renderedEvents = formatAgentInternalEventsForPrompt(events);
	if (!renderedEvents) {return body;}
	return [renderedEvents, body].filter(Boolean).join("\n\n");
}
function createAcpVisibleTextAccumulator() {
	let pendingSilentPrefix = "";
	let visibleText = "";
	const startsWithWordChar = (chunk) => /^[\p{L}\p{N}]/u.test(chunk);
	const resolveNextCandidate = (base, chunk) => {
		if (!base) {return chunk;}
		if (isSilentReplyText(base, "NO_REPLY") && !chunk.startsWith(base) && startsWithWordChar(chunk)) {return chunk;}
		if (chunk.startsWith(base) && chunk.length > base.length) {return chunk;}
		return `${base}${chunk}`;
	};
	const mergeVisibleChunk = (base, chunk) => {
		if (!base) {return {
			text: chunk,
			delta: chunk
		};}
		if (chunk.startsWith(base) && chunk.length > base.length) {return {
			text: chunk,
			delta: chunk.slice(base.length)
		};}
		return {
			text: `${base}${chunk}`,
			delta: chunk
		};
	};
	return {
		consume(chunk) {
			if (!chunk) {return null;}
			if (!visibleText) {
				const leadCandidate = resolveNextCandidate(pendingSilentPrefix, chunk);
				const trimmedLeadCandidate = leadCandidate.trim();
				if (isSilentReplyText(trimmedLeadCandidate, "NO_REPLY") || isSilentReplyPrefixText(trimmedLeadCandidate, "NO_REPLY")) {
					pendingSilentPrefix = leadCandidate;
					return null;
				}
				if (pendingSilentPrefix) {
					pendingSilentPrefix = "";
					visibleText = leadCandidate;
					return {
						text: visibleText,
						delta: leadCandidate
					};
				}
			}
			const nextVisible = mergeVisibleChunk(visibleText, chunk);
			visibleText = nextVisible.text;
			return nextVisible.delta ? nextVisible : null;
		},
		finalize() {
			return visibleText.trim();
		},
		finalizeRaw() {
			return visibleText;
		}
	};
}
const ACP_TRANSCRIPT_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0
	}
};
async function persistAcpTurnTranscript(params) {
	const promptText = params.body;
	const replyText = params.finalText;
	if (!promptText && !replyText) {return params.sessionEntry;}
	const { sessionFile, sessionEntry } = await resolveSessionTranscriptFile({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		sessionEntry: params.sessionEntry,
		sessionStore: params.sessionStore,
		storePath: params.storePath,
		agentId: params.sessionAgentId,
		threadId: params.threadId
	});
	const hadSessionFile = await fs.access(sessionFile).then(() => true).catch(() => false);
	const sessionManager = SessionManager.open(sessionFile);
	await prepareSessionManagerForRun({
		sessionManager,
		sessionFile,
		hadSessionFile,
		sessionId: params.sessionId,
		cwd: params.sessionCwd
	});
	if (promptText) {sessionManager.appendMessage({
		role: "user",
		content: promptText,
		timestamp: Date.now()
	});}
	if (replyText) {sessionManager.appendMessage({
		role: "assistant",
		content: [{
			type: "text",
			text: replyText
		}],
		api: "openai-responses",
		provider: "openclaw",
		model: "acp-runtime",
		usage: ACP_TRANSCRIPT_USAGE,
		stopReason: "stop",
		timestamp: Date.now()
	});}
	emitSessionTranscriptUpdate(sessionFile);
	return sessionEntry;
}
function runAgentAttempt(params) {
	const effectivePrompt = resolveFallbackRetryPrompt({
		body: params.body,
		isFallbackRetry: params.isFallbackRetry
	});
	const bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(params.sessionEntry?.systemPromptReport);
	const bootstrapPromptWarningSignature = bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
	if (isCliProvider(params.providerOverride, params.cfg)) {
		const cliSessionId = getCliSessionId(params.sessionEntry, params.providerOverride);
		const runCliWithSession = (nextCliSessionId) => runCliAgent({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			agentId: params.sessionAgentId,
			sessionFile: params.sessionFile,
			workspaceDir: params.workspaceDir,
			config: params.cfg,
			prompt: effectivePrompt,
			provider: params.providerOverride,
			model: params.modelOverride,
			thinkLevel: params.resolvedThinkLevel,
			timeoutMs: params.timeoutMs,
			runId: params.runId,
			extraSystemPrompt: params.opts.extraSystemPrompt,
			cliSessionId: nextCliSessionId,
			bootstrapPromptWarningSignaturesSeen,
			bootstrapPromptWarningSignature,
			images: params.isFallbackRetry ? void 0 : params.opts.images,
			streamParams: params.opts.streamParams
		});
		return runCliWithSession(cliSessionId).catch(async (err) => {
			if (err instanceof FailoverError && err.reason === "session_expired" && cliSessionId && params.sessionKey && params.sessionStore && params.storePath) {
				log.warn(`CLI session expired, clearing from session store: provider=${params.providerOverride} sessionKey=${params.sessionKey}`);
				const entry = params.sessionStore[params.sessionKey];
				if (entry) {
					const updatedEntry = { ...entry };
					if (params.providerOverride === "claude-cli") {delete updatedEntry.claudeCliSessionId;}
					if (updatedEntry.cliSessionIds) {
						const normalizedProvider = normalizeProviderId(params.providerOverride);
						const newCliSessionIds = { ...updatedEntry.cliSessionIds };
						delete newCliSessionIds[normalizedProvider];
						updatedEntry.cliSessionIds = newCliSessionIds;
					}
					updatedEntry.updatedAt = Date.now();
					await persistSessionEntry({
						sessionStore: params.sessionStore,
						sessionKey: params.sessionKey,
						storePath: params.storePath,
						entry: updatedEntry
					});
					params.sessionEntry = updatedEntry;
				}
				return runCliWithSession(void 0).then(async (result) => {
					if (result.meta.agentMeta?.sessionId && params.sessionKey && params.sessionStore && params.storePath) {
						const entry = params.sessionStore[params.sessionKey];
						if (entry) {
							const updatedEntry = { ...entry };
							setCliSessionId(updatedEntry, params.providerOverride, result.meta.agentMeta.sessionId);
							updatedEntry.updatedAt = Date.now();
							await persistSessionEntry({
								sessionStore: params.sessionStore,
								sessionKey: params.sessionKey,
								storePath: params.storePath,
								entry: updatedEntry
							});
						}
					}
					return result;
				});
			}
			throw err;
		});
	}
	const authProfileId = params.providerOverride === params.primaryProvider ? params.sessionEntry?.authProfileOverride : void 0;
	return runEmbeddedPiAgent({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		agentId: params.sessionAgentId,
		trigger: "user",
		messageChannel: params.messageChannel,
		agentAccountId: params.runContext.accountId,
		messageTo: params.opts.replyTo ?? params.opts.to,
		messageThreadId: params.opts.threadId,
		groupId: params.runContext.groupId,
		groupChannel: params.runContext.groupChannel,
		groupSpace: params.runContext.groupSpace,
		spawnedBy: params.spawnedBy,
		currentChannelId: params.runContext.currentChannelId,
		currentThreadTs: params.runContext.currentThreadTs,
		replyToMode: params.runContext.replyToMode,
		hasRepliedRef: params.runContext.hasRepliedRef,
		senderIsOwner: params.opts.senderIsOwner,
		sessionFile: params.sessionFile,
		workspaceDir: params.workspaceDir,
		config: params.cfg,
		skillsSnapshot: params.skillsSnapshot,
		prompt: effectivePrompt,
		images: params.isFallbackRetry ? void 0 : params.opts.images,
		clientTools: params.opts.clientTools,
		provider: params.providerOverride,
		model: params.modelOverride,
		authProfileId,
		authProfileIdSource: authProfileId ? params.sessionEntry?.authProfileOverrideSource : void 0,
		thinkLevel: params.resolvedThinkLevel,
		verboseLevel: params.resolvedVerboseLevel,
		timeoutMs: params.timeoutMs,
		runId: params.runId,
		lane: params.opts.lane,
		abortSignal: params.opts.abortSignal,
		extraSystemPrompt: params.opts.extraSystemPrompt,
		inputProvenance: params.opts.inputProvenance,
		streamParams: params.opts.streamParams,
		agentDir: params.agentDir,
		allowTransientCooldownProbe: params.allowTransientCooldownProbe,
		onAgentEvent: params.onAgentEvent,
		bootstrapPromptWarningSignaturesSeen,
		bootstrapPromptWarningSignature
	});
}
async function prepareAgentCommandExecution(opts, runtime) {
	const message = opts.message ?? "";
	if (!message.trim()) {throw new Error("Message (--message) is required");}
	const body = prependInternalEventContext(message, opts.internalEvents);
	if (!opts.to && !opts.sessionId && !opts.sessionKey && !opts.agentId) {throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");}
	const loadedRaw = loadConfig();
	const sourceConfig = await (async () => {
		try {
			const { snapshot } = await readConfigFileSnapshotForWrite();
			if (snapshot.valid) {return snapshot.resolved;}
		} catch {}
		return loadedRaw;
	})();
	const { resolvedConfig: cfg, diagnostics } = await resolveCommandSecretRefsViaGateway({
		config: loadedRaw,
		commandName: "agent",
		targetIds: getAgentRuntimeCommandSecretTargetIds()
	});
	setRuntimeConfigSnapshot(cfg, sourceConfig);
	const normalizedSpawned = normalizeSpawnedRunMetadata({
		spawnedBy: opts.spawnedBy,
		groupId: opts.groupId,
		groupChannel: opts.groupChannel,
		groupSpace: opts.groupSpace,
		workspaceDir: opts.workspaceDir
	});
	for (const entry of diagnostics) {runtime.log(`[secrets] ${entry}`);}
	const agentIdOverrideRaw = opts.agentId?.trim();
	const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : void 0;
	if (agentIdOverride) {
		if (!listAgentIds(cfg).includes(agentIdOverride)) {throw new Error(`Unknown agent id "${agentIdOverrideRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`);}
	}
	if (agentIdOverride && opts.sessionKey) {
		const sessionAgentId = resolveAgentIdFromSessionKey(opts.sessionKey);
		if (sessionAgentId !== agentIdOverride) {throw new Error(`Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`);}
	}
	const agentCfg = cfg.agents?.defaults;
	const configuredModel = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const thinkingLevelsHint = formatThinkingLevels(configuredModel.provider, configuredModel.model);
	const thinkOverride = normalizeThinkLevel(opts.thinking);
	const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
	if (opts.thinking && !thinkOverride) {throw new Error(`Invalid thinking level. Use one of: ${thinkingLevelsHint}.`);}
	if (opts.thinkingOnce && !thinkOnce) {throw new Error(`Invalid one-shot thinking level. Use one of: ${thinkingLevelsHint}.`);}
	const verboseOverride = normalizeVerboseLevel(opts.verbose);
	if (opts.verbose && !verboseOverride) {throw new Error("Invalid verbose level. Use \"on\", \"full\", or \"off\".");}
	const isSubagentLane = (typeof opts.lane === "string" ? opts.lane.trim() : "") === String(AGENT_LANE_SUBAGENT);
	const timeoutSecondsRaw = opts.timeout !== void 0 ? Number.parseInt(String(opts.timeout), 10) : isSubagentLane ? 0 : void 0;
	if (timeoutSecondsRaw !== void 0 && (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw < 0)) {throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");}
	const timeoutMs = resolveAgentTimeoutMs({
		cfg,
		overrideSeconds: timeoutSecondsRaw
	});
	const { sessionId, sessionKey, sessionEntry: sessionEntryRaw, sessionStore, storePath, isNewSession, persistedThinking, persistedVerbose } = resolveSession({
		cfg,
		to: opts.to,
		sessionId: opts.sessionId,
		sessionKey: opts.sessionKey,
		agentId: agentIdOverride
	});
	const sessionAgentId = agentIdOverride ?? resolveSessionAgentId({
		sessionKey: sessionKey ?? opts.sessionKey?.trim(),
		config: cfg
	});
	const outboundSession = buildOutboundSessionContext({
		cfg,
		agentId: sessionAgentId,
		sessionKey
	});
	const workspaceDirRaw = normalizedSpawned.workspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
	const agentDir = resolveAgentDir(cfg, sessionAgentId);
	const workspaceDir = (await ensureAgentWorkspace({
		dir: workspaceDirRaw,
		ensureBootstrapFiles: !agentCfg?.skipBootstrap
	})).dir;
	const runId = opts.runId?.trim() || sessionId;
	const acpManager = getAcpSessionManager();
	return {
		body,
		cfg,
		normalizedSpawned,
		agentCfg,
		thinkOverride,
		thinkOnce,
		verboseOverride,
		timeoutMs,
		sessionId,
		sessionKey,
		sessionEntry: sessionEntryRaw,
		sessionStore,
		storePath,
		isNewSession,
		persistedThinking,
		persistedVerbose,
		sessionAgentId,
		outboundSession,
		workspaceDir,
		agentDir,
		runId,
		acpManager,
		acpResolution: sessionKey ? acpManager.resolveSession({
			cfg,
			sessionKey
		}) : null
	};
}
async function agentCommandInternal(opts, runtime = defaultRuntime, deps = createDefaultDeps()) {
	const prepared = await prepareAgentCommandExecution(opts, runtime);
	const { body, cfg, normalizedSpawned, agentCfg, thinkOverride, thinkOnce, verboseOverride, timeoutMs, sessionId, sessionKey, sessionStore, storePath, isNewSession, persistedThinking, persistedVerbose, sessionAgentId, outboundSession, workspaceDir, agentDir, runId, acpManager, acpResolution } = prepared;
	let sessionEntry = prepared.sessionEntry;
	try {
		if (opts.deliver === true) {
			if (resolveSendPolicy({
				cfg,
				entry: sessionEntry,
				sessionKey,
				channel: sessionEntry?.channel,
				chatType: sessionEntry?.chatType
			}) === "deny") {throw new Error("send blocked by session policy");}
		}
		if (acpResolution?.kind === "stale") {throw acpResolution.error;}
		if (acpResolution?.kind === "ready" && sessionKey) {
			const startedAt = Date.now();
			registerAgentRunContext(runId, { sessionKey });
			emitAgentEvent({
				runId,
				stream: "lifecycle",
				data: {
					phase: "start",
					startedAt
				}
			});
			const visibleTextAccumulator = createAcpVisibleTextAccumulator();
			let stopReason;
			try {
				const dispatchPolicyError = resolveAcpDispatchPolicyError(cfg);
				if (dispatchPolicyError) {throw dispatchPolicyError;}
				const agentPolicyError = resolveAcpAgentPolicyError(cfg, normalizeAgentId(acpResolution.meta.agent || resolveAgentIdFromSessionKey(sessionKey)));
				if (agentPolicyError) {throw agentPolicyError;}
				await acpManager.runTurn({
					cfg,
					sessionKey,
					text: body,
					mode: "prompt",
					requestId: runId,
					signal: opts.abortSignal,
					onEvent: (event) => {
						if (event.type === "done") {
							stopReason = event.stopReason;
							return;
						}
						if (event.type !== "text_delta") {return;}
						if (event.stream && event.stream !== "output") {return;}
						if (!event.text) {return;}
						const visibleUpdate = visibleTextAccumulator.consume(event.text);
						if (!visibleUpdate) {return;}
						emitAgentEvent({
							runId,
							stream: "assistant",
							data: {
								text: visibleUpdate.text,
								delta: visibleUpdate.delta
							}
						});
					}
				});
			} catch (error) {
				const acpError = toAcpRuntimeError({
					error,
					fallbackCode: "ACP_TURN_FAILED",
					fallbackMessage: "ACP turn failed before completion."
				});
				emitAgentEvent({
					runId,
					stream: "lifecycle",
					data: {
						phase: "error",
						error: acpError.message,
						endedAt: Date.now()
					}
				});
				throw acpError;
			}
			emitAgentEvent({
				runId,
				stream: "lifecycle",
				data: {
					phase: "end",
					endedAt: Date.now()
				}
			});
			const finalTextRaw = visibleTextAccumulator.finalizeRaw();
			const finalText = visibleTextAccumulator.finalize();
			try {
				sessionEntry = await persistAcpTurnTranscript({
					body,
					finalText: finalTextRaw,
					sessionId,
					sessionKey,
					sessionEntry,
					sessionStore,
					storePath,
					sessionAgentId,
					threadId: opts.threadId,
					sessionCwd: resolveAcpSessionCwd(acpResolution.meta) ?? workspaceDir
				});
			} catch (error) {
				log.warn(`ACP transcript persistence failed for ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`);
			}
			const normalizedFinalPayload = normalizeReplyPayload({ text: finalText });
			const payloads = normalizedFinalPayload ? [normalizedFinalPayload] : [];
			const result = {
				payloads,
				meta: {
					durationMs: Date.now() - startedAt,
					aborted: opts.abortSignal?.aborted === true,
					stopReason
				}
			};
			return await deliverAgentCommandResult({
				cfg,
				deps,
				runtime,
				opts,
				outboundSession,
				sessionEntry,
				result,
				payloads
			});
		}
		let resolvedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;
		const resolvedVerboseLevel = verboseOverride ?? persistedVerbose ?? agentCfg?.verboseDefault;
		if (sessionKey) {registerAgentRunContext(runId, {
			sessionKey,
			verboseLevel: resolvedVerboseLevel
		});}
		const needsSkillsSnapshot = isNewSession || !sessionEntry?.skillsSnapshot;
		const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
		const skillFilter = resolveAgentSkillsFilter(cfg, sessionAgentId);
		const skillsSnapshot = needsSkillsSnapshot ? buildWorkspaceSkillSnapshot(workspaceDir, {
			config: cfg,
			eligibility: { remote: getRemoteSkillEligibility() },
			snapshotVersion: skillsSnapshotVersion,
			skillFilter
		}) : sessionEntry?.skillsSnapshot;
		if (skillsSnapshot && sessionStore && sessionKey && needsSkillsSnapshot) {
			const next = {
				...sessionEntry ?? {
					sessionId,
					updatedAt: Date.now()
				},
				sessionId,
				updatedAt: Date.now(),
				skillsSnapshot
			};
			await persistSessionEntry({
				sessionStore,
				sessionKey,
				storePath,
				entry: next
			});
			sessionEntry = next;
		}
		if (sessionStore && sessionKey) {
			const next = {
				...sessionStore[sessionKey] ?? sessionEntry ?? {
					sessionId,
					updatedAt: Date.now()
				},
				sessionId,
				updatedAt: Date.now()
			};
			if (thinkOverride) {next.thinkingLevel = thinkOverride;}
			applyVerboseOverride(next, verboseOverride);
			await persistSessionEntry({
				sessionStore,
				sessionKey,
				storePath,
				entry: next
			});
			sessionEntry = next;
		}
		const configuredDefaultRef = resolveDefaultModelForAgent({
			cfg,
			agentId: sessionAgentId
		});
		const { provider: defaultProvider, model: defaultModel } = normalizeModelRef(configuredDefaultRef.provider, configuredDefaultRef.model);
		let provider = defaultProvider;
		let model = defaultModel;
		const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
		const hasStoredOverride = Boolean(sessionEntry?.modelOverride || sessionEntry?.providerOverride);
		const needsModelCatalog = hasAllowlist || hasStoredOverride;
		let allowedModelKeys = /* @__PURE__ */ new Set();
		let allowedModelCatalog = [];
		let modelCatalog = null;
		let allowAnyModel = false;
		if (needsModelCatalog) {
			modelCatalog = await loadModelCatalog({ config: cfg });
			const allowed = buildAllowedModelSet({
				cfg,
				catalog: modelCatalog,
				defaultProvider,
				defaultModel,
				agentId: sessionAgentId
			});
			allowedModelKeys = allowed.allowedKeys;
			allowedModelCatalog = allowed.allowedCatalog;
			allowAnyModel = allowed.allowAny ?? false;
		}
		if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
			const entry = sessionEntry;
			const overrideProvider = sessionEntry.providerOverride?.trim() || defaultProvider;
			const overrideModel = sessionEntry.modelOverride?.trim();
			if (overrideModel) {
				const normalizedOverride = normalizeModelRef(overrideProvider, overrideModel);
				const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
				if (!isCliProvider(normalizedOverride.provider, cfg) && !allowAnyModel && !allowedModelKeys.has(key)) {
					const { updated } = applyModelOverrideToSessionEntry({
						entry,
						selection: {
							provider: defaultProvider,
							model: defaultModel,
							isDefault: true
						}
					});
					if (updated) {await persistSessionEntry({
						sessionStore,
						sessionKey,
						storePath,
						entry
					});}
				}
			}
		}
		const storedProviderOverride = sessionEntry?.providerOverride?.trim();
		const storedModelOverride = sessionEntry?.modelOverride?.trim();
		if (storedModelOverride) {
			const normalizedStored = normalizeModelRef(storedProviderOverride || defaultProvider, storedModelOverride);
			const key = modelKey(normalizedStored.provider, normalizedStored.model);
			if (isCliProvider(normalizedStored.provider, cfg) || allowAnyModel || allowedModelKeys.has(key)) {
				provider = normalizedStored.provider;
				model = normalizedStored.model;
			}
		}
		if (sessionEntry) {
			const authProfileId = sessionEntry.authProfileOverride;
			if (authProfileId) {
				const entry = sessionEntry;
				const profile = ensureAuthProfileStore().profiles[authProfileId];
				if (!profile || profile.provider !== provider) {
					if (sessionStore && sessionKey) {await clearSessionAuthProfileOverride({
						sessionEntry: entry,
						sessionStore,
						sessionKey,
						storePath
					});}
				}
			}
		}
		if (!resolvedThinkLevel) {
			let catalogForThinking = modelCatalog ?? allowedModelCatalog;
			if (!catalogForThinking || catalogForThinking.length === 0) {
				modelCatalog = await loadModelCatalog({ config: cfg });
				catalogForThinking = modelCatalog;
			}
			resolvedThinkLevel = resolveThinkingDefault({
				cfg,
				provider,
				model,
				catalog: catalogForThinking
			});
		}
		if (resolvedThinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
			if (thinkOnce || thinkOverride) {throw new Error(`Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`);}
			resolvedThinkLevel = "high";
			if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === "xhigh") {
				const entry = sessionEntry;
				entry.thinkingLevel = "high";
				entry.updatedAt = Date.now();
				await persistSessionEntry({
					sessionStore,
					sessionKey,
					storePath,
					entry
				});
			}
		}
		let sessionFile;
		if (sessionStore && sessionKey) {
			const resolvedSessionFile = await resolveSessionTranscriptFile({
				sessionId,
				sessionKey,
				sessionStore,
				storePath,
				sessionEntry,
				agentId: sessionAgentId,
				threadId: opts.threadId
			});
			sessionFile = resolvedSessionFile.sessionFile;
			sessionEntry = resolvedSessionFile.sessionEntry;
		}
		if (!sessionFile) {
			const resolvedSessionFile = await resolveSessionTranscriptFile({
				sessionId,
				sessionKey: sessionKey ?? sessionId,
				sessionEntry,
				agentId: sessionAgentId,
				threadId: opts.threadId
			});
			sessionFile = resolvedSessionFile.sessionFile;
			sessionEntry = resolvedSessionFile.sessionEntry;
		}
		const startedAt = Date.now();
		let lifecycleEnded = false;
		let result;
		let fallbackProvider = provider;
		let fallbackModel = model;
		try {
			const runContext = resolveAgentRunContext(opts);
			const messageChannel = resolveMessageChannel(runContext.messageChannel, opts.replyChannel ?? opts.channel);
			const spawnedBy = normalizedSpawned.spawnedBy ?? sessionEntry?.spawnedBy;
			const effectiveFallbacksOverride = resolveEffectiveModelFallbacks({
				cfg,
				agentId: sessionAgentId,
				hasSessionModelOverride: Boolean(storedModelOverride)
			});
			let fallbackAttemptIndex = 0;
			const fallbackResult = await runWithModelFallback({
				cfg,
				provider,
				model,
				runId,
				agentDir,
				fallbacksOverride: effectiveFallbacksOverride,
				run: (providerOverride, modelOverride, runOptions) => {
					const isFallbackRetry = fallbackAttemptIndex > 0;
					fallbackAttemptIndex += 1;
					return runAgentAttempt({
						providerOverride,
						modelOverride,
						cfg,
						sessionEntry,
						sessionId,
						sessionKey,
						sessionAgentId,
						sessionFile,
						workspaceDir,
						body,
						isFallbackRetry,
						resolvedThinkLevel,
						timeoutMs,
						runId,
						opts,
						runContext,
						spawnedBy,
						messageChannel,
						skillsSnapshot,
						resolvedVerboseLevel,
						agentDir,
						primaryProvider: provider,
						sessionStore,
						storePath,
						allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
						onAgentEvent: (evt) => {
							if (evt.stream === "lifecycle" && typeof evt.data?.phase === "string" && (evt.data.phase === "end" || evt.data.phase === "error")) {lifecycleEnded = true;}
						}
					});
				}
			});
			result = fallbackResult.result;
			fallbackProvider = fallbackResult.provider;
			fallbackModel = fallbackResult.model;
			if (!lifecycleEnded) {
				const stopReason = result.meta.stopReason;
				if (stopReason && stopReason !== "end_turn") {console.error(`[agent] run ${runId} ended with stopReason=${stopReason}`);}
				emitAgentEvent({
					runId,
					stream: "lifecycle",
					data: {
						phase: "end",
						startedAt,
						endedAt: Date.now(),
						aborted: result.meta.aborted ?? false,
						stopReason
					}
				});
			}
		} catch (err) {
			if (!lifecycleEnded) {emitAgentEvent({
				runId,
				stream: "lifecycle",
				data: {
					phase: "error",
					startedAt,
					endedAt: Date.now(),
					error: String(err)
				}
			});}
			throw err;
		}
		if (sessionStore && sessionKey) {await updateSessionStoreAfterAgentRun({
			cfg,
			contextTokensOverride: agentCfg?.contextTokens,
			sessionId,
			sessionKey,
			storePath,
			sessionStore,
			defaultProvider: provider,
			defaultModel: model,
			fallbackProvider,
			fallbackModel,
			result
		});}
		const payloads = result.payloads ?? [];
		return await deliverAgentCommandResult({
			cfg,
			deps,
			runtime,
			opts,
			outboundSession,
			sessionEntry,
			result,
			payloads
		});
	} finally {
		clearAgentRunContext(runId);
	}
}
async function agentCommandFromIngress(opts, runtime = defaultRuntime, deps = createDefaultDeps()) {
	if (typeof opts.senderIsOwner !== "boolean") {throw new Error("senderIsOwner must be explicitly set for ingress agent runs.");}
	return await agentCommandInternal({
		...opts,
		senderIsOwner: opts.senderIsOwner
	}, runtime, deps);
}
//#endregion
//#region extensions/discord/src/voice/manager.ts
const require = createRequire(import.meta.url);
const SAMPLE_RATE = 48e3;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const MIN_SEGMENT_SECONDS = .35;
const SILENCE_DURATION_MS = 1e3;
const PLAYBACK_READY_TIMEOUT_MS = 15e3;
const SPEAKING_READY_TIMEOUT_MS = 6e4;
const DECRYPT_FAILURE_WINDOW_MS = 3e4;
const DECRYPT_FAILURE_RECONNECT_THRESHOLD = 3;
const DECRYPT_FAILURE_PATTERN = /DecryptionFailed\(/;
const SPEAKER_CONTEXT_CACHE_TTL_MS = 6e4;
const logger = createSubsystemLogger("discord/voice");
const logVoiceVerbose = (message) => {
	logVerbose(`discord voice: ${message}`);
};
function mergeTtsConfig(base, override) {
	if (!override) {return base;}
	return {
		...base,
		...override,
		modelOverrides: {
			...base.modelOverrides,
			...override.modelOverrides
		},
		elevenlabs: {
			...base.elevenlabs,
			...override.elevenlabs,
			voiceSettings: {
				...base.elevenlabs?.voiceSettings,
				...override.elevenlabs?.voiceSettings
			}
		},
		openai: {
			...base.openai,
			...override.openai
		},
		edge: {
			...base.edge,
			...override.edge
		}
	};
}
function resolveVoiceTtsConfig(params) {
	if (!params.override) {return {
		cfg: params.cfg,
		resolved: resolveTtsConfig(params.cfg)
	};}
	const merged = mergeTtsConfig(params.cfg.messages?.tts ?? {}, params.override);
	const messages = params.cfg.messages ?? {};
	const cfg = {
		...params.cfg,
		messages: {
			...messages,
			tts: merged
		}
	};
	return {
		cfg,
		resolved: resolveTtsConfig(cfg)
	};
}
function buildWavBuffer(pcm) {
	const blockAlign = CHANNELS * BIT_DEPTH / 8;
	const byteRate = SAMPLE_RATE * blockAlign;
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(BIT_DEPTH, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}
let warnedOpusMissing = false;
function createOpusDecoder() {
	try {
		const OpusScript = require("opusscript");
		return {
			decoder: new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO),
			name: "opusscript"
		};
	} catch (err) {
		if (!warnedOpusMissing) {
			warnedOpusMissing = true;
			logger.warn(`discord voice: opusscript unavailable (${formatErrorMessage(err)}); cannot decode voice audio`);
		}
	}
	return null;
}
async function decodeOpusStream(stream) {
	const selected = createOpusDecoder();
	if (!selected) {return Buffer.alloc(0);}
	logVoiceVerbose(`opus decoder: ${selected.name}`);
	const chunks = [];
	try {
		for await (const chunk of stream) {
			if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {continue;}
			const decoded = selected.decoder.decode(chunk);
			if (decoded && decoded.length > 0) {chunks.push(Buffer.from(decoded));}
		}
	} catch (err) {
		if (shouldLogVerbose()) {logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);}
	}
	return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}
function estimateDurationSeconds(pcm) {
	const bytesPerSample = BIT_DEPTH / 8 * CHANNELS;
	if (bytesPerSample <= 0) {return 0;}
	return pcm.length / (bytesPerSample * SAMPLE_RATE);
}
async function writeWavFile(pcm) {
	const tempDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "discord-voice-"));
	const filePath = path.join(tempDir, `segment-${randomUUID()}.wav`);
	const wav = buildWavBuffer(pcm);
	await fs.writeFile(filePath, wav);
	scheduleTempCleanup(tempDir);
	return {
		path: filePath,
		durationSeconds: estimateDurationSeconds(pcm)
	};
}
function scheduleTempCleanup(tempDir, delayMs = 1800 * 1e3) {
	setTimeout(() => {
		fs.rm(tempDir, {
			recursive: true,
			force: true
		}).catch((err) => {
			if (shouldLogVerbose()) {logVerbose(`discord voice: temp cleanup failed for ${tempDir}: ${formatErrorMessage(err)}`);}
		});
	}, delayMs).unref();
}
async function transcribeAudio(params) {
	const ctx = {
		MediaPath: params.filePath,
		MediaType: "audio/wav"
	};
	const attachments = normalizeMediaAttachments(ctx);
	if (attachments.length === 0) {return;}
	const cache = createMediaAttachmentCache(attachments);
	const providerRegistry = buildProviderRegistry();
	try {
		return (await runCapability({
			capability: "audio",
			cfg: params.cfg,
			ctx,
			attachments: cache,
			media: attachments,
			agentDir: resolveAgentDir(params.cfg, params.agentId),
			providerRegistry,
			config: params.cfg.tools?.media?.audio
		})).outputs.find((entry) => entry.kind === "audio.transcription")?.text?.trim() || void 0;
	} finally {
		await cache.cleanup();
	}
}
var DiscordVoiceManager = class {
	constructor(params) {
		this.params = params;
		this.sessions = /* @__PURE__ */ new Map();
		this.autoJoinTask = null;
		this.speakerContextCache = /* @__PURE__ */ new Map();
		this.botUserId = params.botUserId;
		this.voiceEnabled = params.discordConfig.voice?.enabled !== false;
		this.ownerAllowFrom = params.discordConfig.allowFrom ?? params.discordConfig.dm?.allowFrom ?? [];
		this.allowDangerousNameMatching = isDangerousNameMatchingEnabled(params.discordConfig);
	}
	setBotUserId(id) {
		if (id) {this.botUserId = id;}
	}
	isEnabled() {
		return this.voiceEnabled;
	}
	async autoJoin() {
		if (!this.voiceEnabled) {return;}
		if (this.autoJoinTask) {return this.autoJoinTask;}
		this.autoJoinTask = (async () => {
			const entries = this.params.discordConfig.voice?.autoJoin ?? [];
			logVoiceVerbose(`autoJoin: ${entries.length} entries`);
			const seenGuilds = /* @__PURE__ */ new Set();
			for (const entry of entries) {
				const guildId = entry.guildId.trim();
				if (!guildId) {continue;}
				if (seenGuilds.has(guildId)) {
					logger.warn(`discord voice: autoJoin has multiple entries for guild ${guildId}; skipping`);
					continue;
				}
				seenGuilds.add(guildId);
				logVoiceVerbose(`autoJoin: joining guild ${guildId} channel ${entry.channelId}`);
				await this.join({
					guildId: entry.guildId,
					channelId: entry.channelId
				});
			}
		})().finally(() => {
			this.autoJoinTask = null;
		});
		return this.autoJoinTask;
	}
	status() {
		return Array.from(this.sessions.values()).map((session) => ({
			ok: true,
			message: `connected: guild ${session.guildId} channel ${session.channelId}`,
			guildId: session.guildId,
			channelId: session.channelId
		}));
	}
	async join(params) {
		if (!this.voiceEnabled) {return {
			ok: false,
			message: "Discord voice is disabled (channels.discord.voice.enabled)."
		};}
		const guildId = params.guildId.trim();
		const channelId = params.channelId.trim();
		if (!guildId || !channelId) {return {
			ok: false,
			message: "Missing guildId or channelId."
		};}
		logVoiceVerbose(`join requested: guild ${guildId} channel ${channelId}`);
		const existing = this.sessions.get(guildId);
		if (existing && existing.channelId === channelId) {
			logVoiceVerbose(`join: already connected to guild ${guildId} channel ${channelId}`);
			return {
				ok: true,
				message: `Already connected to ${formatMention({ channelId })}.`,
				guildId,
				channelId
			};
		}
		if (existing) {
			logVoiceVerbose(`join: replacing existing session for guild ${guildId}`);
			await this.leave({ guildId });
		}
		const channelInfo = await this.params.client.fetchChannel(channelId).catch(() => null);
		if (!channelInfo || "type" in channelInfo && !isVoiceChannel(channelInfo.type)) {return {
			ok: false,
			message: `Channel ${channelId} is not a voice channel.`
		};}
		const channelGuildId = "guildId" in channelInfo ? channelInfo.guildId : void 0;
		if (channelGuildId && channelGuildId !== guildId) {return {
			ok: false,
			message: "Voice channel is not in this guild."
		};}
		const voicePlugin = this.params.client.getPlugin("voice");
		if (!voicePlugin) {return {
			ok: false,
			message: "Discord voice plugin is not available."
		};}
		const adapterCreator = voicePlugin.getGatewayAdapterCreator(guildId);
		const daveEncryption = this.params.discordConfig.voice?.daveEncryption;
		const decryptionFailureTolerance = this.params.discordConfig.voice?.decryptionFailureTolerance;
		logVoiceVerbose(`join: DAVE settings encryption=${daveEncryption === false ? "off" : "on"} tolerance=${decryptionFailureTolerance ?? "default"}`);
		const connection = joinVoiceChannel({
			channelId,
			guildId,
			adapterCreator,
			selfDeaf: false,
			selfMute: false,
			daveEncryption,
			decryptionFailureTolerance
		});
		try {
			await entersState(connection, VoiceConnectionStatus.Ready, PLAYBACK_READY_TIMEOUT_MS);
			logVoiceVerbose(`join: connected to guild ${guildId} channel ${channelId}`);
		} catch (err) {
			connection.destroy();
			return {
				ok: false,
				message: `Failed to join voice channel: ${formatErrorMessage(err)}`
			};
		}
		const sessionChannelId = channelInfo?.id ?? channelId;
		if (sessionChannelId !== channelId) {logVoiceVerbose(`join: using session channel ${sessionChannelId} for voice channel ${channelId}`);}
		const route = resolveAgentRoute({
			cfg: this.params.cfg,
			channel: "discord",
			accountId: this.params.accountId,
			guildId,
			peer: {
				kind: "channel",
				id: sessionChannelId
			}
		});
		const player = createAudioPlayer();
		connection.subscribe(player);
		let speakingHandler;
		let disconnectedHandler;
		let destroyedHandler;
		let playerErrorHandler;
		const clearSessionIfCurrent = () => {
			if (this.sessions.get(guildId)?.connection === connection) {this.sessions.delete(guildId);}
		};
		const entry = {
			guildId,
			channelId,
			sessionChannelId,
			route,
			connection,
			player,
			playbackQueue: Promise.resolve(),
			processingQueue: Promise.resolve(),
			activeSpeakers: /* @__PURE__ */ new Set(),
			decryptFailureCount: 0,
			lastDecryptFailureAt: 0,
			decryptRecoveryInFlight: false,
			stop: () => {
				if (speakingHandler) {connection.receiver.speaking.off("start", speakingHandler);}
				if (disconnectedHandler) {connection.off(VoiceConnectionStatus.Disconnected, disconnectedHandler);}
				if (destroyedHandler) {connection.off(VoiceConnectionStatus.Destroyed, destroyedHandler);}
				if (playerErrorHandler) {player.off("error", playerErrorHandler);}
				player.stop();
				connection.destroy();
			}
		};
		speakingHandler = (userId) => {
			this.handleSpeakingStart(entry, userId).catch((err) => {
				logger.warn(`discord voice: capture failed: ${formatErrorMessage(err)}`);
			});
		};
		disconnectedHandler = async () => {
			try {
				await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5e3), entersState(connection, VoiceConnectionStatus.Connecting, 5e3)]);
			} catch {
				clearSessionIfCurrent();
				connection.destroy();
			}
		};
		destroyedHandler = () => {
			clearSessionIfCurrent();
		};
		playerErrorHandler = (err) => {
			logger.warn(`discord voice: playback error: ${formatErrorMessage(err)}`);
		};
		connection.receiver.speaking.on("start", speakingHandler);
		connection.on(VoiceConnectionStatus.Disconnected, disconnectedHandler);
		connection.on(VoiceConnectionStatus.Destroyed, destroyedHandler);
		player.on("error", playerErrorHandler);
		this.sessions.set(guildId, entry);
		return {
			ok: true,
			message: `Joined ${formatMention({ channelId })}.`,
			guildId,
			channelId
		};
	}
	async leave(params) {
		const guildId = params.guildId.trim();
		logVoiceVerbose(`leave requested: guild ${guildId} channel ${params.channelId ?? "current"}`);
		const entry = this.sessions.get(guildId);
		if (!entry) {return {
			ok: false,
			message: "Not connected to a voice channel."
		};}
		if (params.channelId && params.channelId !== entry.channelId) {return {
			ok: false,
			message: "Not connected to that voice channel."
		};}
		entry.stop();
		this.sessions.delete(guildId);
		logVoiceVerbose(`leave: disconnected from guild ${guildId} channel ${entry.channelId}`);
		return {
			ok: true,
			message: `Left ${formatMention({ channelId: entry.channelId })}.`,
			guildId,
			channelId: entry.channelId
		};
	}
	async destroy() {
		for (const entry of this.sessions.values()) {entry.stop();}
		this.sessions.clear();
	}
	enqueueProcessing(entry, task) {
		entry.processingQueue = entry.processingQueue.then(task).catch((err) => logger.warn(`discord voice: processing failed: ${formatErrorMessage(err)}`));
	}
	enqueuePlayback(entry, task) {
		entry.playbackQueue = entry.playbackQueue.then(task).catch((err) => logger.warn(`discord voice: playback failed: ${formatErrorMessage(err)}`));
	}
	async handleSpeakingStart(entry, userId) {
		if (!userId || entry.activeSpeakers.has(userId)) {return;}
		if (this.botUserId && userId === this.botUserId) {return;}
		entry.activeSpeakers.add(userId);
		logVoiceVerbose(`capture start: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
		if (entry.player.state.status === AudioPlayerStatus.Playing) {entry.player.stop(true);}
		const stream = entry.connection.receiver.subscribe(userId, { end: {
			behavior: EndBehaviorType.AfterSilence,
			duration: SILENCE_DURATION_MS
		} });
		stream.on("error", (err) => {
			this.handleReceiveError(entry, err);
		});
		try {
			const pcm = await decodeOpusStream(stream);
			if (pcm.length === 0) {
				logVoiceVerbose(`capture empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
				return;
			}
			this.resetDecryptFailureState(entry);
			const { path: wavPath, durationSeconds } = await writeWavFile(pcm);
			if (durationSeconds < MIN_SEGMENT_SECONDS) {
				logVoiceVerbose(`capture too short (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
				return;
			}
			logVoiceVerbose(`capture ready (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			this.enqueueProcessing(entry, async () => {
				await this.processSegment({
					entry,
					wavPath,
					userId,
					durationSeconds
				});
			});
		} finally {
			entry.activeSpeakers.delete(userId);
		}
	}
	async processSegment(params) {
		const { entry, wavPath, userId, durationSeconds } = params;
		logVoiceVerbose(`segment processing (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId}`);
		const transcript = await transcribeAudio({
			cfg: this.params.cfg,
			agentId: entry.route.agentId,
			filePath: wavPath
		});
		if (!transcript) {
			logVoiceVerbose(`transcription empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			return;
		}
		logVoiceVerbose(`transcription ok (${transcript.length} chars): guild ${entry.guildId} channel ${entry.channelId}`);
		const speaker = await this.resolveSpeakerContext(entry.guildId, userId);
		const replyText = ((await agentCommandFromIngress({
			message: speaker.label ? `${speaker.label}: ${transcript}` : transcript,
			sessionKey: entry.route.sessionKey,
			agentId: entry.route.agentId,
			messageChannel: "discord",
			senderIsOwner: speaker.senderIsOwner,
			deliver: false
		}, this.params.runtime)).payloads ?? []).map((payload) => payload.text).filter((text) => typeof text === "string" && text.trim()).join("\n").trim();
		if (!replyText) {
			logVoiceVerbose(`reply empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			return;
		}
		logVoiceVerbose(`reply ok (${replyText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`);
		const { cfg: ttsCfg, resolved: ttsConfig } = resolveVoiceTtsConfig({
			cfg: this.params.cfg,
			override: this.params.discordConfig.voice?.tts
		});
		const directive = parseTtsDirectives(replyText, ttsConfig.modelOverrides, ttsConfig.openai.baseUrl);
		const speakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
		if (!speakText) {
			logVoiceVerbose(`tts skipped (empty): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			return;
		}
		const ttsResult = await textToSpeech({
			text: speakText,
			cfg: ttsCfg,
			channel: "discord",
			overrides: directive.overrides
		});
		if (!ttsResult.success || !ttsResult.audioPath) {
			logger.warn(`discord voice: TTS failed: ${ttsResult.error ?? "unknown error"}`);
			return;
		}
		const audioPath = ttsResult.audioPath;
		logVoiceVerbose(`tts ok (${speakText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`);
		this.enqueuePlayback(entry, async () => {
			logVoiceVerbose(`playback start: guild ${entry.guildId} channel ${entry.channelId} file ${path.basename(audioPath)}`);
			const resource = createAudioResource(audioPath);
			entry.player.play(resource);
			await entersState(entry.player, AudioPlayerStatus.Playing, PLAYBACK_READY_TIMEOUT_MS).catch(() => void 0);
			await entersState(entry.player, AudioPlayerStatus.Idle, SPEAKING_READY_TIMEOUT_MS).catch(() => void 0);
			logVoiceVerbose(`playback done: guild ${entry.guildId} channel ${entry.channelId}`);
		});
	}
	handleReceiveError(entry, err) {
		const message = formatErrorMessage(err);
		logger.warn(`discord voice: receive error: ${message}`);
		if (!DECRYPT_FAILURE_PATTERN.test(message)) {return;}
		const now = Date.now();
		if (now - entry.lastDecryptFailureAt > DECRYPT_FAILURE_WINDOW_MS) {entry.decryptFailureCount = 0;}
		entry.lastDecryptFailureAt = now;
		entry.decryptFailureCount += 1;
		if (entry.decryptFailureCount === 1) {logger.warn("discord voice: DAVE decrypt failures detected; voice receive may be unstable (upstream: discordjs/discord.js#11419)");}
		if (entry.decryptFailureCount < DECRYPT_FAILURE_RECONNECT_THRESHOLD || entry.decryptRecoveryInFlight) {return;}
		entry.decryptRecoveryInFlight = true;
		this.resetDecryptFailureState(entry);
		this.recoverFromDecryptFailures(entry).catch((recoverErr) => logger.warn(`discord voice: decrypt recovery failed: ${formatErrorMessage(recoverErr)}`)).finally(() => {
			entry.decryptRecoveryInFlight = false;
		});
	}
	resetDecryptFailureState(entry) {
		entry.decryptFailureCount = 0;
		entry.lastDecryptFailureAt = 0;
	}
	async recoverFromDecryptFailures(entry) {
		const active = this.sessions.get(entry.guildId);
		if (!active || active.connection !== entry.connection) {return;}
		logger.warn(`discord voice: repeated decrypt failures; attempting rejoin for guild ${entry.guildId} channel ${entry.channelId}`);
		const leaveResult = await this.leave({ guildId: entry.guildId });
		if (!leaveResult.ok) {
			logger.warn(`discord voice: decrypt recovery leave failed: ${leaveResult.message}`);
			return;
		}
		const result = await this.join({
			guildId: entry.guildId,
			channelId: entry.channelId
		});
		if (!result.ok) {logger.warn(`discord voice: rejoin after decrypt failures failed: ${result.message}`);}
	}
	resolveSpeakerIsOwner(params) {
		return resolveDiscordOwnerAccess({
			allowFrom: this.ownerAllowFrom,
			sender: {
				id: params.id,
				name: params.name,
				tag: params.tag
			},
			allowNameMatching: this.allowDangerousNameMatching
		}).ownerAllowed;
	}
	resolveSpeakerContextCacheKey(guildId, userId) {
		return `${guildId}:${userId}`;
	}
	getCachedSpeakerContext(guildId, userId) {
		const key = this.resolveSpeakerContextCacheKey(guildId, userId);
		const cached = this.speakerContextCache.get(key);
		if (!cached) {return;}
		if (cached.expiresAt <= Date.now()) {
			this.speakerContextCache.delete(key);
			return;
		}
		return {
			label: cached.label,
			senderIsOwner: cached.senderIsOwner
		};
	}
	setCachedSpeakerContext(guildId, userId, context) {
		const key = this.resolveSpeakerContextCacheKey(guildId, userId);
		this.speakerContextCache.set(key, {
			label: context.label,
			senderIsOwner: context.senderIsOwner,
			expiresAt: Date.now() + SPEAKER_CONTEXT_CACHE_TTL_MS
		});
	}
	async resolveSpeakerContext(guildId, userId) {
		const cached = this.getCachedSpeakerContext(guildId, userId);
		if (cached) {return cached;}
		const identity = await this.resolveSpeakerIdentity(guildId, userId);
		const context = {
			label: identity.label,
			senderIsOwner: this.resolveSpeakerIsOwner({
				id: identity.id,
				name: identity.name,
				tag: identity.tag
			})
		};
		this.setCachedSpeakerContext(guildId, userId, context);
		return context;
	}
	async resolveSpeakerIdentity(guildId, userId) {
		try {
			const member = await this.params.client.fetchMember(guildId, userId);
			const username = member.user?.username ?? void 0;
			return {
				id: userId,
				label: member.nickname ?? member.user?.globalName ?? username ?? userId,
				name: username,
				tag: member.user ? formatDiscordUserTag(member.user) : void 0
			};
		} catch {
			try {
				const user = await this.params.client.fetchUser(userId);
				const username = user.username ?? void 0;
				return {
					id: userId,
					label: user.globalName ?? username ?? userId,
					name: username,
					tag: formatDiscordUserTag(user)
				};
			} catch {
				return {
					id: userId,
					label: userId
				};
			}
		}
	}
};
var DiscordVoiceReadyListener = class extends ReadyListener {
	constructor(manager) {
		super();
		this.manager = manager;
	}
	async handle() {
		await this.manager.autoJoin();
	}
};
function isVoiceChannel(type) {
	return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}
//#endregion
export { DiscordVoiceManager, DiscordVoiceReadyListener };
