import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { n as readAcpSessionEntry } from "./session-meta-CZ8B2a4Z.js";
import { a as resolveThreadBindingIdleTimeoutMs, s as resolveThreadBindingMaxAgeMs } from "./thread-bindings-policy-BAuuUJk1.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./routing-79DRZvfm.js";
import "./conversation-runtime-guwDSNIo.js";
import { i as resolveThreadBindingThreadName, r as resolveThreadBindingIntroText } from "./thread-bindings-messages-D73K8IGt.js";
import "./acp-runtime-Dk1AA16X.js";
import { t as parseDiscordTarget } from "./target-parsing-D1FhMbX6.js";
import "./targets-B8AIYxNL.js";
import { O as shouldPersistBindingMutations, T as saveBindingsToDisk, c as getThreadBindingToken, f as normalizeThreadId, g as removeBindingRecord, n as MANAGERS_BY_ACCOUNT_ID, p as rememberRecentUnboundWebhookEcho, t as BINDINGS_BY_THREAD_ID } from "./thread-bindings.state-c758dGj_.js";
import { r as resolveBindingIdsForTargetSession } from "./thread-bindings.session-updates-_9DIWMBI.js";
import { s as resolveChannelIdForBinding } from "./thread-bindings.discord-api-DSvzGMuw.js";
import { r as getThreadBindingManager } from "./thread-bindings.manager-Bb0kya8V.js";
//#region extensions/discord/src/monitor/thread-bindings.config.ts
function resolveDiscordThreadBindingIdleTimeoutMs(params) {
	const accountId = normalizeAccountId(params.accountId);
	const root = params.cfg.channels?.discord?.threadBindings;
	const account = params.cfg.channels?.discord?.accounts?.[accountId]?.threadBindings;
	return resolveThreadBindingIdleTimeoutMs({
		channelIdleHoursRaw: account?.idleHours ?? root?.idleHours,
		sessionIdleHoursRaw: params.cfg.session?.threadBindings?.idleHours
	});
}
function resolveDiscordThreadBindingMaxAgeMs(params) {
	const accountId = normalizeAccountId(params.accountId);
	const root = params.cfg.channels?.discord?.threadBindings;
	const account = params.cfg.channels?.discord?.accounts?.[accountId]?.threadBindings;
	return resolveThreadBindingMaxAgeMs({
		channelMaxAgeHoursRaw: account?.maxAgeHours ?? root?.maxAgeHours,
		sessionMaxAgeHoursRaw: params.cfg.session?.threadBindings?.maxAgeHours
	});
}
//#endregion
//#region extensions/discord/src/monitor/thread-bindings.lifecycle.ts
const ACP_STARTUP_HEALTH_PROBE_CONCURRENCY_LIMIT = 8;
async function mapWithConcurrency(params) {
	if (params.items.length === 0) return [];
	const limit = Math.max(1, Math.floor(params.limit));
	const resultsByIndex = /* @__PURE__ */ new Map();
	let nextIndex = 0;
	const runWorker = async () => {
		for (;;) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= params.items.length) return;
			resultsByIndex.set(index, await params.worker(params.items[index], index));
		}
	};
	const workers = Array.from({ length: Math.min(limit, params.items.length) }, () => runWorker());
	await Promise.all(workers);
	return params.items.map((_item, index) => resultsByIndex.get(index));
}
function listThreadBindingsForAccount(accountId) {
	const manager = getThreadBindingManager(accountId);
	if (!manager) return [];
	return manager.listBindings();
}
function listThreadBindingsBySessionKey(params) {
	return resolveBindingIdsForTargetSession(params).map((bindingKey) => BINDINGS_BY_THREAD_ID.get(bindingKey)).filter((entry) => Boolean(entry));
}
async function autoBindSpawnedDiscordSubagent(params) {
	if (normalizeOptionalLowercaseString(params.channel) !== "discord") return null;
	const manager = getThreadBindingManager(params.accountId);
	if (!manager) return null;
	const managerToken = getThreadBindingToken(manager.accountId);
	const requesterThreadId = normalizeThreadId(params.threadId);
	let channelId = "";
	if (requesterThreadId) {
		const existing = manager.getByThreadId(requesterThreadId);
		if (existing?.channelId?.trim()) channelId = existing.channelId.trim();
		else channelId = await resolveChannelIdForBinding({
			cfg: params.cfg,
			accountId: manager.accountId,
			token: managerToken,
			threadId: requesterThreadId
		}) ?? "";
	}
	if (!channelId) {
		const to = normalizeOptionalString(params.to) ?? "";
		if (!to) return null;
		try {
			const target = parseDiscordTarget(to, { defaultKind: "channel" });
			if (!target || target.kind !== "channel") return null;
			channelId = await resolveChannelIdForBinding({
				cfg: params.cfg,
				accountId: manager.accountId,
				token: managerToken,
				threadId: target.id
			}) ?? "";
		} catch {
			return null;
		}
	}
	return await manager.bindTarget({
		threadId: void 0,
		channelId,
		createThread: true,
		threadName: resolveThreadBindingThreadName({
			agentId: params.agentId,
			label: params.label
		}),
		targetKind: "subagent",
		targetSessionKey: params.childSessionKey,
		agentId: params.agentId,
		label: params.label,
		boundBy: params.boundBy ?? "system",
		introText: resolveThreadBindingIntroText({
			agentId: params.agentId,
			label: params.label,
			idleTimeoutMs: manager.getIdleTimeoutMs(),
			maxAgeMs: manager.getMaxAgeMs()
		})
	});
}
function unbindThreadBindingsBySessionKey(params) {
	const ids = resolveBindingIdsForTargetSession(params);
	if (ids.length === 0) return [];
	const removed = [];
	for (const bindingKey of ids) {
		const record = BINDINGS_BY_THREAD_ID.get(bindingKey);
		if (!record) continue;
		const manager = MANAGERS_BY_ACCOUNT_ID.get(record.accountId);
		if (manager) {
			const unbound = manager.unbindThread({
				threadId: record.threadId,
				reason: params.reason,
				sendFarewell: params.sendFarewell,
				farewellText: params.farewellText
			});
			if (unbound) removed.push(unbound);
			continue;
		}
		const unbound = removeBindingRecord(bindingKey);
		if (unbound) {
			rememberRecentUnboundWebhookEcho(unbound);
			removed.push(unbound);
		}
	}
	if (removed.length > 0 && shouldPersistBindingMutations()) saveBindingsToDisk({ force: true });
	return removed;
}
function resolveStoredAcpBindingHealth(params) {
	if (!params.session.acp) return "stale";
	return "healthy";
}
async function reconcileAcpThreadBindingsOnStartup(params) {
	const manager = getThreadBindingManager(params.accountId);
	if (!manager) return {
		checked: 0,
		removed: 0,
		staleSessionKeys: []
	};
	const acpBindings = manager.listBindings().filter((binding) => binding.targetKind === "acp" && binding.metadata?.pluginBindingOwner !== "plugin");
	const staleBindings = [];
	const probeTargets = [];
	for (const binding of acpBindings) {
		const sessionKey = binding.targetSessionKey.trim();
		if (!sessionKey) {
			staleBindings.push(binding);
			continue;
		}
		const session = readAcpSessionEntry({
			cfg: params.cfg,
			sessionKey
		});
		if (!session) {
			staleBindings.push(binding);
			continue;
		}
		if (session.storeReadFailed) continue;
		if (resolveStoredAcpBindingHealth({ session }) === "stale") {
			staleBindings.push(binding);
			continue;
		}
		if (!params.healthProbe) continue;
		probeTargets.push({
			binding,
			sessionKey,
			session
		});
	}
	if (params.healthProbe && probeTargets.length > 0) {
		const probeResults = await mapWithConcurrency({
			items: probeTargets,
			limit: ACP_STARTUP_HEALTH_PROBE_CONCURRENCY_LIMIT,
			worker: async ({ binding, sessionKey, session }) => {
				try {
					return {
						binding,
						status: (await params.healthProbe?.({
							cfg: params.cfg,
							accountId: manager.accountId,
							sessionKey,
							binding,
							session
						}))?.status ?? "uncertain"
					};
				} catch {
					return {
						binding,
						status: "uncertain"
					};
				}
			}
		});
		for (const probeResult of probeResults) if (probeResult.status === "stale") staleBindings.push(probeResult.binding);
	}
	if (staleBindings.length === 0) return {
		checked: acpBindings.length,
		removed: 0,
		staleSessionKeys: []
	};
	const staleSessionKeys = [];
	let removed = 0;
	for (const binding of staleBindings) {
		staleSessionKeys.push(binding.targetSessionKey);
		if (manager.unbindThread({
			threadId: binding.threadId,
			reason: "stale-session",
			sendFarewell: params.sendFarewell ?? false
		})) removed += 1;
	}
	return {
		checked: acpBindings.length,
		removed,
		staleSessionKeys: [...new Set(staleSessionKeys)]
	};
}
//#endregion
export { unbindThreadBindingsBySessionKey as a, reconcileAcpThreadBindingsOnStartup as i, listThreadBindingsBySessionKey as n, resolveDiscordThreadBindingIdleTimeoutMs as o, listThreadBindingsForAccount as r, resolveDiscordThreadBindingMaxAgeMs as s, autoBindSpawnedDiscordSubagent as t };
