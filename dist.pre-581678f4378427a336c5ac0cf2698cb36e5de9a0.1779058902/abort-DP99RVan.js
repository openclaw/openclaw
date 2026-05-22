import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import { _ as resolveSessionAgentId } from "./agent-scope-B7Gl_3a6.js";
import { c as parseAgentSessionKey } from "./session-key-utils-CJRKuBJA.js";
import { r as logVerbose } from "./globals-CrpmxZTV.js";
import { u as resolveStorePath } from "./paths-789ECJN2.js";
import { A as resolveSessionStoreEntry, t as loadSessionStore } from "./store-load-BRLw4_SR.js";
import { s as updateSessionStore } from "./store-CTOVSWL0.js";
import "./sessions-Ct_pHdrL.js";
import { f as replyRunRegistry } from "./reply-run-registry-ob9jzuSv.js";
import { n as abortEmbeddedPiRun, p as resolveActiveEmbeddedRunSessionId } from "./runs-BOMfzUwh.js";
import { c as resolveMainSessionAlias, s as resolveInternalSessionKey } from "./sessions-helpers-QNHaZNPy.js";
import { a as clearSessionQueues } from "./queue-DFtTyg3X.js";
import { f as markSubagentRunTerminated, o as getLatestSubagentRunByChildSessionKey, u as listSubagentRunsForController } from "./subagent-registry-BhmeZiZg.js";
import { n as getAcpSessionManager } from "./manager-D7I4HRut.js";
import { o as stripMentions, s as stripStructuralPrefixes } from "./mentions-C32eFLeh.js";
import { i as setAbortMemory, n as isAbortRequestText } from "./abort-primitives-BYaVWyyb.js";
import { t as resolveCommandAuthorization } from "./command-auth-DX_jvZDM.js";
import { a as shouldPersistAbortCutoff, i as resolveAbortCutoffFromContext, t as applyAbortCutoffToSessionEntry } from "./abort-cutoff-BDxE7fea.js";
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
	const targetKey = normalizeOptionalString(ctx.CommandTargetSessionKey) ?? normalizeOptionalString(ctx.SessionKey);
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
		const acpManager = abortDeps.getAcpSessionManager();
		if (acpManager.resolveSession({
			cfg,
			sessionKey: resolvedTargetKey
		}).kind !== "none") try {
			await acpManager.cancelSession({
				cfg,
				sessionKey: resolvedTargetKey,
				reason: "fast-abort"
			});
		} catch (error) {
			logVerbose(`abort: ACP cancel failed for ${resolvedTargetKey}: ${formatErrorMessage(error)}`);
		}
		const sessionId = replyRunRegistry.resolveSessionId(resolvedTargetKey) ?? entry?.sessionId;
		const aborted = abortSessionRunTarget({
			key: resolvedTargetKey,
			sessionId
		});
		const cleared = clearSessionQueues([resolvedTargetKey, sessionId]);
		if (cleared.followupCleared > 0 || cleared.laneCleared > 0) logVerbose(`abort: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`);
		const abortCutoff = shouldPersistAbortCutoff({
			commandSessionKey: ctx.SessionKey,
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
