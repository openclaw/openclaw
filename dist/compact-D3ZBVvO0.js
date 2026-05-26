import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { c as runHarnessContextEngineMaintenance, s as isActiveHarnessContextEngine } from "./attempt.tool-run-context-BuKiw0o1.js";
import { t as log } from "./logger-8oA4pYXO.js";
import "./agent-harness-runtime-Cs9KBB7L.js";
import { s as resolveCodexAppServerRuntimeOptions } from "./config-1YKbZ7CA.js";
import { t as isJsonObject } from "./protocol-CJecV8AU.js";
import { i as readCodexAppServerBinding } from "./session-binding-Dns4vGBT.js";
import { n as defaultCodexAppServerClientFactory, t as createCodexAppServerClientFactoryTestHooks } from "./client-factory-BJfCLxQa.js";
//#region extensions/codex/src/app-server/compact.ts
const DEFAULT_CODEX_COMPACTION_WAIT_TIMEOUT_MS = 300 * 1e3;
let clientFactory = defaultCodexAppServerClientFactory;
async function maybeCompactCodexAppServerSession(params, options = {}) {
	const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine) ? params.contextEngine : void 0;
	if (activeContextEngine?.info.ownsCompaction) {
		let primary;
		let primaryError;
		try {
			primary = await activeContextEngine.compact({
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
			primaryError = formatErrorMessage(error);
			log.warn("context engine compaction failed; attempting Codex native compaction", {
				sessionId: params.sessionId,
				engineId: activeContextEngine.info.id,
				error: primaryError
			});
		}
		if (primary?.ok && primary.compacted) try {
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
			log.warn("context engine compaction maintenance failed; continuing Codex native compaction", {
				sessionId: params.sessionId,
				engineId: activeContextEngine.info.id,
				error: formatErrorMessage(error)
			});
		}
		const nativeResult = await compactCodexNativeThread(params, options);
		if (!primary) return buildContextEngineCompactionFailureResult({
			primaryError,
			nativeResult,
			currentTokenCount: params.currentTokenCount
		});
		return {
			ok: primary.ok,
			compacted: primary.compacted,
			reason: primary.reason,
			result: buildContextEnginePrimaryResult(primary, nativeResult, params.currentTokenCount)
		};
	}
	return await compactCodexNativeThread(params, options);
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
	const client = await clientFactory(appServer.start, requestedAuthProfileId ?? binding.authProfileId, params.agentDir, params.config);
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
				ownsCompaction: params.contextEngine?.info?.ownsCompaction === true,
				threadId: binding.threadId,
				signal: completion.signal,
				turnId: completion.turnId,
				itemId: completion.itemId
			}
		}
	};
}
function mergeCompactionDetails(primaryDetails, nativeResult, contextEngineCompaction) {
	const codexNativeCompaction = nativeResult ? nativeResult.ok && nativeResult.compacted ? {
		ok: true,
		compacted: true,
		details: nativeResult.result?.details
	} : {
		ok: false,
		compacted: false,
		reason: nativeResult.reason
	} : void 0;
	const extraDetails = {
		...codexNativeCompaction ? { codexNativeCompaction } : {},
		...contextEngineCompaction ? { contextEngineCompaction } : {}
	};
	if (primaryDetails && typeof primaryDetails === "object" && !Array.isArray(primaryDetails)) return {
		...primaryDetails,
		...extraDetails
	};
	return Object.keys(extraDetails).length > 0 ? extraDetails : primaryDetails;
}
function buildContextEnginePrimaryResult(primary, nativeResult, currentTokenCount) {
	if (primary.result) return {
		summary: primary.result.summary ?? "",
		firstKeptEntryId: primary.result.firstKeptEntryId ?? "",
		tokensBefore: primary.result.tokensBefore,
		tokensAfter: primary.result.tokensAfter,
		details: mergeCompactionDetails(primary.result.details, nativeResult)
	};
	const details = mergeCompactionDetails(void 0, nativeResult);
	return details ? {
		summary: "",
		firstKeptEntryId: "",
		tokensBefore: nativeResult?.result?.tokensBefore ?? currentTokenCount ?? 0,
		details
	} : void 0;
}
function buildContextEngineCompactionFailureResult(params) {
	const reason = params.primaryError ? `context engine compaction failed: ${params.primaryError}` : "context engine compaction failed";
	return {
		ok: false,
		compacted: params.nativeResult?.compacted ?? false,
		reason,
		result: {
			summary: params.nativeResult?.result?.summary ?? "",
			firstKeptEntryId: params.nativeResult?.result?.firstKeptEntryId ?? "",
			tokensBefore: params.nativeResult?.result?.tokensBefore ?? params.currentTokenCount ?? 0,
			tokensAfter: params.nativeResult?.result?.tokensAfter,
			details: mergeCompactionDetails(params.nativeResult?.result?.details, params.nativeResult, {
				ok: false,
				reason
			})
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
createCodexAppServerClientFactoryTestHooks((factory) => {
	clientFactory = factory;
});
//#endregion
export { maybeCompactCodexAppServerSession };
