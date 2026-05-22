import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import { a as resolveContextEngineOwnerPluginId } from "./registry-2sJBjayk.js";
import { t as log } from "./logger-drL4w85E.js";
import { o as isActiveHarnessContextEngine, s as runHarnessContextEngineMaintenance } from "./context-engine-lifecycle-CswAeY9m.js";
import "./agent-harness-runtime-DppcSF-K.js";
import { c as resolveCodexAppServerRuntimeOptions } from "./config-DP4qTgax.js";
import { t as isJsonObject } from "./protocol-CidUhcEm.js";
import { i as readCodexAppServerBinding, t as clearCodexAppServerBinding } from "./session-binding-DxYKT8pE.js";
import { t as defaultCodexAppServerClientFactory } from "./client-factory-Xs9ypayo.js";
//#region extensions/codex/src/app-server/compact.ts
const DEFAULT_CODEX_COMPACTION_WAIT_TIMEOUT_MS = 300 * 1e3;
const warnedIgnoredCompactionOverrides = /* @__PURE__ */ new Set();
async function maybeCompactCodexAppServerSession(params, options = {}) {
	const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine) ? params.contextEngine : void 0;
	if (activeContextEngine?.info.ownsCompaction) return await compactOwningContextEngine(params, activeContextEngine);
	warnIfIgnoringOpenClawCompactionOverrides(params);
	const nativeResult = await compactCodexNativeThread(params, options);
	if (activeContextEngine && nativeResult?.ok && nativeResult.compacted) try {
		await runHarnessContextEngineMaintenance({
			contextEngine: activeContextEngine,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			sessionFile: params.sessionFile,
			reason: "compaction",
			runtimeContext: params.contextEngineRuntimeContext,
			config: params.config
		});
	} catch (error) {
		log.warn("context engine compaction maintenance failed after Codex compaction", {
			sessionId: params.sessionId,
			engineId: activeContextEngine.info.id,
			error: formatErrorMessage(error)
		});
	}
	return nativeResult;
}
async function compactOwningContextEngine(params, contextEngine) {
	log.info("starting context-engine-owned Codex app-server compaction", {
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		engineId: contextEngine.info.id,
		tokenBudget: params.contextTokenBudget,
		currentTokenCount: params.currentTokenCount,
		trigger: params.trigger,
		compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
		force: params.trigger === "manual"
	});
	let result;
	try {
		result = await contextEngine.compact({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			sessionFile: params.sessionFile,
			tokenBudget: params.contextTokenBudget,
			currentTokenCount: params.currentTokenCount,
			compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
			customInstructions: params.customInstructions,
			force: params.trigger === "manual",
			runtimeContext: params.contextEngineRuntimeContext
		});
	} catch (error) {
		log.warn("context-engine-owned Codex app-server compaction failed", {
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			engineId: contextEngine.info.id,
			error: formatErrorMessage(error)
		});
		return {
			ok: false,
			compacted: false,
			reason: `context engine compaction failed: ${formatErrorMessage(error)}`
		};
	}
	if (result.ok && result.compacted) {
		const compactedSessionId = result.result?.sessionId ?? params.sessionId;
		const compactedSessionFile = result.result?.sessionFile ?? params.sessionFile;
		try {
			await runHarnessContextEngineMaintenance({
				contextEngine,
				sessionId: compactedSessionId,
				sessionKey: params.sessionKey,
				sessionFile: compactedSessionFile,
				reason: "compaction",
				runtimeContext: params.contextEngineRuntimeContext,
				config: params.config
			});
		} catch (error) {
			log.warn("context engine compaction maintenance failed", {
				sessionId: compactedSessionId,
				engineId: contextEngine.info.id,
				error: formatErrorMessage(error)
			});
		}
		await clearCodexAppServerBinding(params.sessionFile);
		if (compactedSessionFile !== params.sessionFile) await clearCodexAppServerBinding(compactedSessionFile);
	}
	log.info("completed context-engine-owned Codex app-server compaction", {
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		engineId: contextEngine.info.id,
		ok: result.ok,
		compacted: result.compacted,
		reason: result.reason,
		codexThreadBindingInvalidated: result.ok && result.compacted
	});
	return {
		ok: result.ok,
		compacted: result.compacted,
		reason: result.reason,
		result: result.result ? {
			...result.result,
			summary: result.result.summary ?? "",
			firstKeptEntryId: result.result.firstKeptEntryId ?? "",
			details: mergeContextEngineCompactionDetails(result.result.details, { codexThreadBindingInvalidated: result.ok && result.compacted })
		} : result.ok && result.compacted ? {
			summary: "",
			firstKeptEntryId: "",
			tokensBefore: params.currentTokenCount ?? 0,
			details: { codexThreadBindingInvalidated: true }
		} : void 0
	};
}
function mergeContextEngineCompactionDetails(details, extra) {
	if (details && typeof details === "object" && !Array.isArray(details)) return {
		...details,
		...extra
	};
	return extra;
}
function warnIfIgnoringOpenClawCompactionOverrides(params) {
	const ignoredConfig = readIgnoredCompactionOverridePaths(params, isActiveHarnessContextEngine(params.contextEngine) ? params.contextEngine : void 0);
	if (ignoredConfig.length === 0) return;
	const warningKey = ignoredConfig.join("\0");
	if (warnedIgnoredCompactionOverrides.has(warningKey)) return;
	warnedIgnoredCompactionOverrides.add(warningKey);
	log.warn("ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction", {
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		ignoredConfig
	});
}
function readIgnoredCompactionOverridePaths(params, activeContextEngine) {
	const ignored = /* @__PURE__ */ new Set();
	const configuredContextEngine = readStringPath(params.config, [
		"plugins",
		"slots",
		"contextEngine"
	]);
	const runtimeContextEnginePlugin = typeof params.contextEngineRuntimeContext?.contextEnginePluginId === "string" ? params.contextEngineRuntimeContext.contextEnginePluginId.trim() : "";
	const activeContextEnginePlugin = resolveContextEngineOwnerPluginId(activeContextEngine);
	for (const entry of readCompactionOverrideEntries(params)) {
		const localProvider = typeof entry.record.provider === "string" ? entry.record.provider.trim() : "";
		const inheritedProvider = !localProvider && typeof entry.inheritedRecord?.provider === "string" ? entry.inheritedRecord.provider.trim() : "";
		const provider = localProvider || inheritedProvider;
		const providerPath = localProvider ? `${entry.path}.compaction.provider` : inheritedProvider && entry.inheritedPath ? `${entry.inheritedPath}.compaction.provider` : void 0;
		if (provider.toLowerCase() === "lossless-claw" && (activeContextEnginePlugin === "lossless-claw" || runtimeContextEnginePlugin.toLowerCase() === "lossless-claw" || configuredContextEngine?.toLowerCase() === "lossless-claw")) continue;
		if (typeof entry.record.model === "string" && entry.record.model.trim()) ignored.add(`${entry.path}.compaction.model`);
		if (providerPath) ignored.add(providerPath);
	}
	return [...ignored];
}
function readCompactionOverrideEntries(params) {
	const entries = [];
	const defaultCompaction = readRecord(readRecord(params.config?.agents)?.defaults)?.compaction;
	const defaultRecord = readRecord(defaultCompaction);
	if (defaultRecord) entries.push({
		path: "agents.defaults",
		record: defaultRecord
	});
	const agentId = readAgentIdFromSessionKey(params.sessionKey ?? params.sandboxSessionKey);
	if (!agentId) return entries;
	const agentCompaction = readRecord((Array.isArray(params.config?.agents?.list) ? params.config.agents.list : []).find((agent) => {
		return (typeof agent?.id === "string" ? agent.id.trim().toLowerCase() : "") === agentId;
	}))?.compaction;
	const agentRecord = readRecord(agentCompaction);
	if (agentRecord) entries.push({
		path: `agents.list.${agentId}`,
		record: agentRecord,
		inheritedRecord: defaultRecord,
		inheritedPath: "agents.defaults"
	});
	return entries;
}
function readAgentIdFromSessionKey(sessionKey) {
	const parts = sessionKey?.trim().toLowerCase().split(":").filter(Boolean) ?? [];
	if (parts.length < 3 || parts[0] !== "agent") return;
	return parts[1]?.trim() || void 0;
}
function readRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function readStringPath(value, path) {
	let current = value;
	for (const segment of path) current = readRecord(current)?.[segment];
	return typeof current === "string" && current.trim() ? current.trim() : void 0;
}
async function compactCodexNativeThread(params, options = {}) {
	const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
	const binding = await readCodexAppServerBinding(params.sessionFile, { config: params.config });
	if (!binding?.threadId) return {
		ok: false,
		compacted: false,
		reason: "no codex app-server thread binding"
	};
	const requestedAuthProfileId = params.authProfileId?.trim() || void 0;
	if (requestedAuthProfileId && binding.authProfileId && binding.authProfileId !== requestedAuthProfileId) return {
		ok: false,
		compacted: false,
		reason: "auth profile mismatch for session binding"
	};
	const client = await (options.clientFactory ?? defaultCodexAppServerClientFactory)(appServer.start, requestedAuthProfileId ?? binding.authProfileId, params.agentDir, params.config);
	const waiter = createCodexNativeCompactionWaiter(client, binding.threadId);
	let completion;
	try {
		await client.request("thread/compact/start", { threadId: binding.threadId });
		log.info("started codex app-server compaction", {
			sessionId: params.sessionId,
			threadId: binding.threadId
		});
		waiter.startTimeout();
		completion = await waiter.promise;
	} catch (error) {
		waiter.cancel();
		return {
			ok: false,
			compacted: false,
			reason: formatCompactionError(error)
		};
	}
	log.info("completed codex app-server compaction", {
		sessionId: params.sessionId,
		threadId: binding.threadId,
		signal: completion.signal,
		turnId: completion.turnId,
		itemId: completion.itemId
	});
	return {
		ok: true,
		compacted: true,
		result: {
			summary: "",
			firstKeptEntryId: "",
			tokensBefore: params.currentTokenCount ?? 0,
			details: {
				backend: "codex-app-server",
				threadId: binding.threadId,
				signal: completion.signal,
				turnId: completion.turnId,
				itemId: completion.itemId
			}
		}
	};
}
function createCodexNativeCompactionWaiter(client, threadId) {
	let settled = false;
	let removeHandler = () => {};
	let timeout;
	let failWaiter = () => {};
	return {
		promise: new Promise((resolve, reject) => {
			const cleanup = () => {
				removeHandler();
				if (timeout) clearTimeout(timeout);
			};
			const complete = (completion) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(completion);
			};
			const fail = (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			failWaiter = fail;
			const handler = (notification) => {
				const completion = readNativeCompactionCompletion(notification, threadId);
				if (completion) complete(completion);
			};
			removeHandler = client.addNotificationHandler(handler);
		}),
		startTimeout() {
			if (settled || timeout) return;
			timeout = setTimeout(() => {
				failWaiter(/* @__PURE__ */ new Error(`timed out waiting for codex app-server compaction for ${threadId}`));
			}, resolveCompactionWaitTimeoutMs());
			timeout.unref?.();
		},
		cancel() {
			if (settled) return;
			settled = true;
			removeHandler();
			if (timeout) clearTimeout(timeout);
		}
	};
}
function readNativeCompactionCompletion(notification, threadId) {
	const params = notification.params;
	if (!isJsonObject(params) || readString(params, "threadId", "thread_id") !== threadId) return;
	if (notification.method === "thread/compacted") return {
		signal: "thread/compacted",
		turnId: readString(params, "turnId", "turn_id")
	};
	if (notification.method !== "item/completed") return;
	const item = isJsonObject(params.item) ? params.item : void 0;
	if (readString(item, "type") !== "contextCompaction") return;
	return {
		signal: "item/completed",
		turnId: readString(params, "turnId", "turn_id"),
		itemId: readString(item, "id") ?? readString(params, "itemId", "item_id", "id")
	};
}
function resolveCompactionWaitTimeoutMs() {
	const raw = process.env.OPENCLAW_CODEX_COMPACTION_WAIT_TIMEOUT_MS?.trim();
	const parsed = raw ? Number.parseInt(raw, 10) : NaN;
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	return DEFAULT_CODEX_COMPACTION_WAIT_TIMEOUT_MS;
}
function readString(params, ...keys) {
	if (!params) return;
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string") return value;
	}
}
function formatCompactionError(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
//#endregion
export { maybeCompactCodexAppServerSession };
