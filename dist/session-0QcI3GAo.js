import { C as hasSessionAutoModelFallbackProvenance } from "./agent-scope-CtLXGcWm.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { c as resolveSessionLifecycleTimestamps } from "./sessions-CQHHcgC_.js";
import { c as resolveSessionResetPolicy, o as evaluateSessionFreshness } from "./reset-B0OJOtNI.js";
import { n as clearBootstrapSnapshotOnSessionRollover } from "./bootstrap-cache-ClkciH8b.js";
import crypto from "node:crypto";
//#region src/cron/isolated-agent/session.ts
const FRESH_CRON_CARRIED_PREFERENCE_FIELDS = [
	"heartbeatTaskState",
	"chatType",
	"thinkingLevel",
	"fastMode",
	"verboseLevel",
	"traceLevel",
	"reasoningLevel",
	"ttsAuto",
	"responseUsage",
	"label",
	"displayName"
];
const AMBIENT_SESSION_CONTEXT_FIELDS = [
	"elevatedLevel",
	"groupActivation",
	"groupActivationNeedsSystemIntro",
	"sendPolicy",
	"queueMode",
	"queueDebounceMs",
	"queueCap",
	"queueDrop",
	"channel",
	"groupId",
	"subject",
	"groupChannel",
	"space",
	"origin",
	"acp"
];
function cloneSessionField(value) {
	return globalThis.structuredClone(value);
}
function copySessionFields(target, entry, fields) {
	for (const field of fields) if (entry[field] !== void 0) target[field] = cloneSessionField(entry[field]);
}
function preserveNonAutoModelOverride(target, entry) {
	const recoveredAutoFallbackOverride = entry.modelOverrideSource === void 0 && hasSessionAutoModelFallbackProvenance(entry);
	if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
		if (entry.modelOverride !== void 0) target.modelOverride = entry.modelOverride;
		if (entry.providerOverride !== void 0) target.providerOverride = entry.providerOverride;
		if (entry.modelOverrideSource !== void 0) target.modelOverrideSource = entry.modelOverrideSource;
	}
}
function preserveUserAuthOverride(target, entry) {
	if (entry.authProfileOverrideSource === "user") {
		if (entry.authProfileOverride !== void 0) target.authProfileOverride = entry.authProfileOverride;
		target.authProfileOverrideSource = entry.authProfileOverrideSource;
		if (entry.authProfileOverrideCompactionCount !== void 0) target.authProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
	}
}
function sanitizeFreshCronSessionEntry(entry, options) {
	const next = {};
	copySessionFields(next, entry, FRESH_CRON_CARRIED_PREFERENCE_FIELDS);
	if (options.preserveAmbientContext) copySessionFields(next, entry, AMBIENT_SESSION_CONTEXT_FIELDS);
	preserveNonAutoModelOverride(next, entry);
	preserveUserAuthOverride(next, entry);
	return next;
}
function resolveCronSession(params) {
	const sessionCfg = params.cfg.session;
	const storePath = resolveStorePath(sessionCfg?.store, { agentId: params.agentId });
	const store = params.store ?? loadSessionStore(storePath);
	const entry = store[params.sessionKey];
	let sessionId;
	let isNewSession;
	let systemSent;
	if (!params.forceNew && entry?.sessionId) {
		const resetPolicy = resolveSessionResetPolicy({
			sessionCfg,
			resetType: "direct"
		});
		if (evaluateSessionFreshness({
			updatedAt: entry.updatedAt,
			...resolveSessionLifecycleTimestamps({
				entry,
				agentId: params.agentId,
				storePath
			}),
			now: params.nowMs,
			policy: resetPolicy
		}).fresh) {
			sessionId = entry.sessionId;
			isNewSession = false;
			systemSent = entry.systemSent ?? false;
		} else {
			sessionId = crypto.randomUUID();
			isNewSession = true;
			systemSent = false;
		}
	} else {
		sessionId = crypto.randomUUID();
		isNewSession = true;
		systemSent = false;
	}
	const previousSessionId = isNewSession ? entry?.sessionId : void 0;
	clearBootstrapSnapshotOnSessionRollover({
		sessionKey: params.sessionKey,
		previousSessionId
	});
	const baseEntry = entry ? isNewSession ? sanitizeFreshCronSessionEntry(entry, { preserveAmbientContext: !params.forceNew }) : entry : void 0;
	return {
		storePath,
		store,
		sessionEntry: {
			...baseEntry,
			sessionId,
			updatedAt: params.nowMs,
			sessionStartedAt: isNewSession ? params.nowMs : baseEntry?.sessionStartedAt ?? resolveSessionLifecycleTimestamps({
				entry,
				agentId: params.agentId,
				storePath
			}).sessionStartedAt,
			lastInteractionAt: isNewSession ? params.nowMs : baseEntry?.lastInteractionAt,
			systemSent
		},
		systemSent,
		isNewSession,
		previousSessionId
	};
}
//#endregion
export { resolveCronSession as t };
