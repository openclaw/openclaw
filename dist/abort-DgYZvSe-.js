import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { c as parseAgentSessionKey, n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { F as resolveSessionStoreEntry, t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import "./sessions-CQHHcgC_.js";
import { t as getAcpSessionManager } from "./manager-CnO_4PJM.js";
import { f as replyRunRegistry } from "./reply-run-registry-CwZ9EftF.js";
import { n as abortEmbeddedPiRun, p as resolveActiveEmbeddedRunSessionId } from "./runs-DrbsiywK.js";
import { c as resolveMainSessionAlias, s as resolveInternalSessionKey } from "./sessions-helpers-AhiZZPDz.js";
import { a as clearSessionQueues } from "./queue-DskPlua9.js";
import { f as markSubagentRunTerminated, o as getLatestSubagentRunByChildSessionKey, u as listSubagentRunsForController } from "./subagent-registry-QwuPQSxK.js";
import { i as resolveConversationBindingContextFromMessage } from "./conversation-binding-input-CG40gdHa.js";
import { o as stripMentions, s as stripStructuralPrefixes } from "./mentions-DmNrCnsQ.js";
import { i as setAbortMemory, n as isAbortRequestText } from "./abort-primitives-BPrDmF9O.js";
import { t as resolveCommandAuthorization } from "./command-auth-B6j-kluy.js";
import { a as shouldPersistAbortCutoff, i as resolveAbortCutoffFromContext, t as applyAbortCutoffToSessionEntry } from "./abort-cutoff-cRHrB_Kx.js";
import { t as resolveEffectiveResetTargetSessionKey } from "./acp-reset-target-CFsyva-u.js";
const abortDeps = {
	getAcpSessionManager,
	abortEmbeddedPiRun,
	resolveActiveEmbeddedRunSessionId,
	getLatestSubagentRunByChildSessionKey,
	listSubagentRunsForController,
	markSubagentRunTerminated
};
function abortSessionRunTarget(params) {
	const sessionIds = /* @__PURE__ */ new Set();
	const key = normalizeOptionalString(params.key);
	if (key) {
		const activeSessionId = abortDeps.resolveActiveEmbeddedRunSessionId(key);
		if (activeSessionId) sessionIds.add(activeSessionId);
	}
	const explicitSessionId = normalizeOptionalString(params.sessionId);
	if (explicitSessionId) sessionIds.add(explicitSessionId);
	let aborted = key ? replyRunRegistry.abort(key) : false;
	for (const sessionId of sessionIds) aborted = abortDeps.abortEmbeddedPiRun(sessionId) || aborted;
	return aborted;
}
function formatAbortReplyText(stoppedSubagents) {
	if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) return "⚙️ Agent was aborted.";
	return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${stoppedSubagents === 1 ? "sub-agent" : "sub-agents"}.`;
}
function resolveSessionEntryForKey(store, sessionKey) {
	if (!store || !sessionKey) return {};
	const resolved = resolveSessionStoreEntry({
		store,
		sessionKey
	});
	if (resolved.existing) return resolved.legacyKeys.length > 0 ? {
		entry: resolved.existing,
		key: resolved.normalizedKey,
		legacyKeys: resolved.legacyKeys
	} : {
		entry: resolved.existing,
		key: resolved.normalizedKey
	};
	return {};
}
function resolveStoredSessionId(params) {
	const agentId = resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	});
	const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
	try {
		return resolveSessionEntryForKey(loadSessionStore(storePath), params.sessionKey).entry?.sessionId;
	} catch {
		return;
	}
}
function resolveBoundAcpAbortTargetSessionKey(params) {
	const bindingContext = resolveConversationBindingContextFromMessage({
		cfg: params.cfg,
		ctx: params.ctx
	});
	if (!bindingContext) return;
	return resolveEffectiveResetTargetSessionKey({
		cfg: params.cfg,
		channel: bindingContext.channel,
		accountId: bindingContext.accountId,
		conversationId: bindingContext.conversationId,
		parentConversationId: bindingContext.parentConversationId,
		activeSessionKey: params.activeSessionKey,
		skipConfiguredFallbackWhenActiveSessionNonAcp: false,
		fallbackToActiveAcpWhenUnbound: false
	});
}
function normalizeRequesterSessionKey(cfg, key) {
	const cleaned = normalizeOptionalString(key);
	if (!cleaned) return;
	const { mainKey, alias } = resolveMainSessionAlias(cfg);
	return resolveInternalSessionKey({
		key: cleaned,
		alias,
		mainKey
	});
}
function stopSubagentsForRequester(params) {
	const requesterKey = normalizeRequesterSessionKey(params.cfg, params.requesterSessionKey);
	if (!requesterKey) return { stopped: 0 };
	const dedupedRunsByChildKey = /* @__PURE__ */ new Map();
	for (const run of abortDeps.listSubagentRunsForController(requesterKey)) {
		const childKey = normalizeOptionalString(run.childSessionKey);
		if (!childKey) continue;
		const latest = abortDeps.getLatestSubagentRunByChildSessionKey(childKey);
		if (!latest) {
			const existing = dedupedRunsByChildKey.get(childKey);
			if (!existing || run.createdAt >= existing.createdAt) dedupedRunsByChildKey.set(childKey, run);
			continue;
		}
		const latestControllerSessionKey = normalizeOptionalString(latest?.controllerSessionKey) ?? normalizeOptionalString(latest?.requesterSessionKey);
		if (latest.runId !== run.runId || latestControllerSessionKey !== requesterKey) continue;
		const existing = dedupedRunsByChildKey.get(childKey);
		if (!existing || run.createdAt >= existing.createdAt) dedupedRunsByChildKey.set(childKey, run);
	}
	const runs = Array.from(dedupedRunsByChildKey.values());
	if (runs.length === 0) return { stopped: 0 };
	const storeCache = /* @__PURE__ */ new Map();
	const seenChildKeys = /* @__PURE__ */ new Set();
	let stopped = 0;
	for (const run of runs) {
		const childKey = normalizeOptionalString(run.childSessionKey);
		if (!childKey || seenChildKeys.has(childKey)) continue;
		seenChildKeys.add(childKey);
		if (!run.endedAt) {
			const cleared = clearSessionQueues([childKey]);
			const parsed = parseAgentSessionKey(childKey);
			const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed?.agentId });
			let store = storeCache.get(storePath);
			if (!store) {
				store = loadSessionStore(storePath);
				storeCache.set(storePath, store);
			}
			const entry = store[childKey];
			const aborted = abortSessionRunTarget({
				key: childKey,
				sessionId: replyRunRegistry.resolveSessionId(childKey) ?? entry?.sessionId
			});
			if (abortDeps.markSubagentRunTerminated({
				runId: run.runId,
				childSessionKey: childKey,
				reason: "killed"
			}) > 0 || aborted || cleared.followupCleared > 0 || cleared.laneCleared > 0) stopped += 1;
		}
		const cascadeResult = stopSubagentsForRequester({
			cfg: params.cfg,
			requesterSessionKey: childKey
		});
		stopped += cascadeResult.stopped;
	}
	if (stopped > 0) logVerbose(`abort: stopped ${stopped} subagent run(s) for ${requesterKey}`);
	return { stopped };
}
async function tryFastAbortFromMessage(params) {
	const { ctx, cfg } = params;
	const commandSessionKey = normalizeOptionalString(ctx.SessionKey) ?? normalizeOptionalString(ctx.ParentSessionKey);
	const targetKey = normalizeOptionalString(ctx.CommandTargetSessionKey) ?? commandSessionKey;
	const raw = stripStructuralPrefixes(ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "");
	if (!isAbortRequestText(normalizeOptionalLowercaseString(ctx.ChatType) === "group" ? stripMentions(raw, ctx, cfg, resolveSessionAgentId({
		sessionKey: targetKey ?? ctx.SessionKey ?? "",
		config: cfg
	})) : raw)) return {
		handled: false,
		aborted: false
	};
	const commandAuthorized = ctx.CommandAuthorized;
	const auth = resolveCommandAuthorization({
		ctx,
		cfg,
		commandAuthorized
	});
	if (!auth.isAuthorizedSender) return {
		handled: false,
		aborted: false
	};
	const agentId = resolveSessionAgentId({
		sessionKey: targetKey ?? ctx.SessionKey ?? "",
		config: cfg
	});
	const abortKey = targetKey ?? auth.from ?? auth.to;
	const requesterSessionKey = targetKey ?? ctx.SessionKey ?? abortKey;
	if (targetKey) {
		const storePath = resolveStorePath(cfg.session?.store, { agentId });
		const store = loadSessionStore(storePath);
		const { entry, key, legacyKeys } = resolveSessionEntryForKey(store, targetKey);
		const resolvedTargetKey = key ?? targetKey;
		const conversationBoundAcpTargetKey = commandSessionKey ? resolveBoundAcpAbortTargetSessionKey({
			ctx,
			cfg,
			activeSessionKey: commandSessionKey
		}) : void 0;
		const boundAcpTargetKey = !isAcpSessionKey(resolvedTargetKey) ? conversationBoundAcpTargetKey : void 0;
		const abortTargetKeys = [resolvedTargetKey];
		if (boundAcpTargetKey && boundAcpTargetKey !== resolvedTargetKey) abortTargetKeys.push(boundAcpTargetKey);
		const acpManager = abortDeps.getAcpSessionManager();
		for (const acpTargetKey of abortTargetKeys.filter(isAcpSessionKey)) {
			if (acpManager.resolveSession({
				cfg,
				sessionKey: acpTargetKey
			}).kind === "none") continue;
			try {
				await acpManager.cancelSession({
					cfg,
					sessionKey: acpTargetKey,
					reason: "fast-abort"
				});
			} catch (error) {
				logVerbose(`abort: ACP cancel failed for ${acpTargetKey}: ${formatErrorMessage(error)}`);
			}
		}
		const sourceAbortKey = commandSessionKey && !abortTargetKeys.includes(commandSessionKey) && conversationBoundAcpTargetKey && abortTargetKeys.includes(conversationBoundAcpTargetKey) ? commandSessionKey : void 0;
		const sessionIdsByKey = new Map(abortTargetKeys.map((abortTargetKey) => [abortTargetKey, replyRunRegistry.resolveSessionId(abortTargetKey) ?? (abortTargetKey === resolvedTargetKey ? entry?.sessionId : resolveStoredSessionId({
			cfg,
			sessionKey: abortTargetKey
		}))]));
		let aborted = false;
		for (const abortTargetKey of abortTargetKeys) aborted = abortSessionRunTarget({
			key: abortTargetKey,
			sessionId: sessionIdsByKey.get(abortTargetKey)
		}) || aborted;
		const sourceSessionId = sourceAbortKey ? replyRunRegistry.resolveSessionId(sourceAbortKey) ?? resolveStoredSessionId({
			cfg,
			sessionKey: sourceAbortKey
		}) : void 0;
		if (sourceAbortKey) aborted = abortSessionRunTarget({
			key: sourceAbortKey,
			sessionId: sourceSessionId
		}) || aborted;
		const cleared = clearSessionQueues(abortTargetKeys.flatMap((abortTargetKey) => [abortTargetKey, sessionIdsByKey.get(abortTargetKey)]).concat(sourceAbortKey, sourceSessionId));
		if (cleared.followupCleared > 0 || cleared.laneCleared > 0) logVerbose(`abort: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`);
		const abortCutoff = shouldPersistAbortCutoff({
			commandSessionKey,
			targetSessionKey: resolvedTargetKey
		}) ? resolveAbortCutoffFromContext(ctx) : void 0;
		if (entry && key) {
			entry.abortedLastRun = true;
			applyAbortCutoffToSessionEntry(entry, abortCutoff);
			entry.updatedAt = Date.now();
			store[key] = entry;
			for (const legacyKey of legacyKeys ?? []) if (legacyKey !== key) delete store[legacyKey];
			await updateSessionStore(storePath, (nextStore) => {
				const nextEntry = nextStore[key] ?? entry;
				if (!nextEntry) return;
				nextEntry.abortedLastRun = true;
				applyAbortCutoffToSessionEntry(nextEntry, abortCutoff);
				nextEntry.updatedAt = Date.now();
				nextStore[key] = nextEntry;
				for (const legacyKey of legacyKeys ?? []) if (legacyKey !== key) delete nextStore[legacyKey];
			});
		} else if (abortKey) setAbortMemory(abortKey, true);
		const { stopped } = stopSubagentsForRequester({
			cfg,
			requesterSessionKey
		});
		return {
			handled: true,
			aborted,
			stoppedSubagents: stopped
		};
	}
	if (abortKey) setAbortMemory(abortKey, true);
	const { stopped } = stopSubagentsForRequester({
		cfg,
		requesterSessionKey
	});
	return {
		handled: true,
		aborted: false,
		stoppedSubagents: stopped
	};
}
//#endregion
export { tryFastAbortFromMessage as a, stopSubagentsForRequester as i, formatAbortReplyText as n, resolveSessionEntryForKey as r, abortSessionRunTarget as t };
