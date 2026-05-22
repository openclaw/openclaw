import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as createLazyImportLoader } from "./lazy-promise-B6on3yPt.js";
import { i as isCronSessionKey } from "./session-key-utils-bmH32UOR.js";
import { u as resolveAgentIdFromSessionKey } from "./session-key-8g_Q03Po.js";
import { n as defaultRuntime } from "./runtime-Bd9_VI2J.js";
import { i as getRuntimeConfig } from "./io-C7AkIz5l.js";
import { r as INTERNAL_MESSAGE_CHANNEL } from "./message-channel-core-B0llrko_.js";
import "./message-channel-TU1A55ap.js";
import { i as callGateway } from "./call-WDuoqUff.js";
import { i as normalizeDeliveryContext } from "./delivery-context.shared-Cx37tn1U.js";
import { u as resolveStorePath } from "./paths-D2tVOYHR.js";
import { s as updateSessionStore } from "./store-DWV_PSjG.js";
import "./sessions-DDKzhGib.js";
import { _ as waitForEmbeddedPiRunEnd, s as isEmbeddedPiRunActive } from "./runs-B1USHROf.js";
import { a as getSubagentDepthFromSessionStore } from "./subagent-capabilities-DMa6cF_X.js";
import { t as buildSubagentSystemPrompt } from "./subagent-system-prompt-Cq1qfD4s.js";
import { a as isSilentReplyText, c as stripLeadingSilentToken, l as stripSilentToken, n as SILENT_REPLY_TOKEN, o as startsWithSilentToken, s as stripContinuationSignal } from "./tokens-1nrYy2wZ.js";
import { i as consumePendingDelegates } from "./delegate-store-f9id5UI-.js";
import "./continuation-delegate-store-DNFZcvVq.js";
import { n as resolveContinuationRuntimeConfig } from "./config-CTQqYp1V.js";
import { a as resolveSubagentAnnounceTimeoutMs, c as resolveAnnounceOrigin, i as loadSessionEntryByKey, l as buildAnnounceIdFromChildRun, o as resolveSubagentCompletionOrigin, r as loadRequesterSessionEntry, s as runAnnounceDeliveryWithRetry, t as deliverSubagentAnnouncement, u as buildAnnounceIdempotencyKey } from "./subagent-announce-delivery-BPvMwLLv.js";
import "./delivery-context-C8sZgR2o.js";
import { n as formatAgentInternalEventsForPrompt } from "./internal-events-CUJZLQY8.js";
import { a as captureSubagentCompletionReply, c as readLatestSubagentOutputWithRetry, f as importRuntimeModule, g as isAnnounceSkip, i as buildCompactAnnounceStatsLine, l as readSubagentOutput, n as applySubagentWaitOutcome, o as dedupeLatestChildCompletionRows, r as buildChildCompletionFindings, s as filterCurrentDirectChildCompletionRows, t as deleteSubagentSessionForCleanup, u as waitForSubagentRunOutcome } from "./subagent-session-cleanup-CC5Q3s5U.js";
//#region src/agents/subagent-announce.ts
const defaultSubagentAnnounceDeps = {
	callGateway,
	getRuntimeConfig,
	loadSubagentRegistryRuntime,
	resolveContinuationRuntimeConfig
};
let subagentAnnounceDeps = defaultSubagentAnnounceDeps;
let continuationStateRuntimePromise = null;
let subagentSpawnRuntimePromise = null;
const CONTINUATION_CHAIN_HOP_PATTERN = /\[continuation:chain-hop:(\d+)\]/;
function resolveCompletionTraceContext(params) {
	if (!params.traceparent) return {};
	const hopMatch = params.task.match(CONTINUATION_CHAIN_HOP_PATTERN);
	if (!hopMatch) return { traceparent: params.traceparent };
	const childChainHop = Number.parseInt(hopMatch[1], 10);
	if (!Number.isFinite(childChainHop)) return { traceparent: params.traceparent };
	const chainStepRemaining = Math.max(0, params.resolveMaxChainLength() - childChainHop);
	return {
		chainStepRemaining,
		...chainStepRemaining > 0 ? { traceparent: params.traceparent } : {}
	};
}
const subagentRegistryRuntimeLoader = createLazyImportLoader(() => import("./subagent-announce.registry.runtime.js"));
function loadSubagentRegistryRuntime() {
	return subagentRegistryRuntimeLoader.load();
}
function loadContinuationStateRuntime() {
	continuationStateRuntimePromise ??= import("./state-BYeKmbEl.js");
	return continuationStateRuntimePromise;
}
function loadSubagentSpawnRuntime() {
	subagentSpawnRuntimePromise ??= import("./subagent-spawn-BvZplPGO.js");
	return subagentSpawnRuntimePromise;
}
async function listKnownSessionKeysOnHost(cfg) {
	const [{ resolveAllAgentSessionStoreTargetsSync }, { loadSessionStore }] = await Promise.all([import("./targets-BRsGkJlv.js"), import("./store-load-BBRYBMMm.js")]);
	const keys = /* @__PURE__ */ new Set();
	for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
		const store = loadSessionStore(target.storePath);
		for (const key of Object.keys(store)) {
			const normalized = normalizeOptionalString(key);
			if (normalized) keys.add(normalized);
		}
	}
	return [...keys].toSorted();
}
function buildAnnounceReplyInstruction(params) {
	if (params.requesterIsSubagent) return `Convert this completion into a concise internal orchestration update for your parent agent in your own words. Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
	if (params.expectsCompletionMessage) return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type).`;
	return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}
function buildAnnounceSteerMessage(events) {
	return formatAgentInternalEventsForPrompt(events) || "A background task finished. Process the completion update now.";
}
function hasUsableSessionEntry(entry) {
	if (!entry || typeof entry !== "object") return false;
	const sessionId = entry.sessionId;
	return typeof sessionId !== "string" || sessionId.trim() !== "";
}
/**
* Drain the child session's continue_delegate queue after the subagent has
* settled. Chain state is inherited from the child session entry so nested
* hops stay sequential across the chain. Best-effort — dispatch failures
* are logged and swallowed so they cannot break the announce path.
*/
async function drainChildContinuationQueue(params) {
	let cfg;
	try {
		cfg = subagentAnnounceDeps.getRuntimeConfig();
	} catch (err) {
		defaultRuntime.error?.(`[continuation:drain-config-load-failed] child=${params.childSessionKey} error=${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	if (cfg?.agents?.defaults?.continuation?.enabled !== true) return;
	try {
		const [dispatchModule, stateModule, sessionStoreModule] = await Promise.all([
			importRuntimeModule(import.meta.url, ["./subagent-announce.continuation.runtime", ".js"]),
			importRuntimeModule(import.meta.url, ["./subagent-announce.continuation.runtime", ".js"]),
			importRuntimeModule(import.meta.url, ["./subagent-announce.continuation.runtime", ".js"])
		]);
		const { dispatchToolDelegates } = dispatchModule;
		const { loadContinuationChainState, persistContinuationChainState } = stateModule;
		const { updateSessionStore, resolveStorePath, resolveAgentIdFromSessionKey } = sessionStoreModule;
		const childEntry = loadSessionEntryByKey(params.childSessionKey);
		const dispatchConfig = subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg);
		const dispatchResult = await dispatchToolDelegates({
			sessionKey: params.childSessionKey,
			chainState: loadContinuationChainState(childEntry),
			ctx: {
				sessionKey: params.childSessionKey,
				agentChannel: params.requesterOrigin?.channel,
				agentAccountId: params.requesterOrigin?.accountId,
				agentTo: params.requesterOrigin?.to,
				agentThreadId: params.requesterOrigin?.threadId
			},
			maxChainLength: dispatchConfig.maxChainLength
		});
		if (dispatchResult && dispatchResult.dispatched > 0) {
			const advanced = dispatchResult.chainState;
			persistContinuationChainState({
				sessionEntry: childEntry,
				count: advanced.currentChainCount,
				startedAt: advanced.chainStartedAt,
				tokens: advanced.accumulatedChainTokens
			});
			try {
				const agentId = resolveAgentIdFromSessionKey(params.childSessionKey);
				await updateSessionStore(resolveStorePath(cfg.session?.store, { agentId }), (store) => {
					const existing = store[params.childSessionKey];
					if (!existing) return;
					store[params.childSessionKey] = {
						...existing,
						continuationChainCount: advanced.currentChainCount,
						continuationChainStartedAt: advanced.chainStartedAt,
						continuationChainTokens: advanced.accumulatedChainTokens
					};
				});
			} catch (writeErr) {
				defaultRuntime.error?.(`[continuation:drain-persist-failed] child=${params.childSessionKey} error=${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
			}
		}
	} catch (err) {
		defaultRuntime.error?.(`Subagent continuation delegate drain failed for ${params.childSessionKey}: ${String(err)}`);
	}
}
function buildDescendantWakeMessage(params) {
	return [
		"[Subagent Context] Your prior run ended while waiting for descendant subagent completions.",
		"[Subagent Context] All pending descendants for that run have now settled.",
		"[Subagent Context] Continue your workflow using these results. Spawn more subagents if needed, otherwise send your final answer.",
		"",
		`Task: ${params.taskLabel}`,
		"",
		params.findings
	].join("\n");
}
const WAKE_RUN_SUFFIX = ":wake";
function stripWakeRunSuffixes(runId) {
	let next = runId.trim();
	while (next.endsWith(WAKE_RUN_SUFFIX)) next = next.slice(0, -5);
	return next || runId.trim();
}
function isWakeContinuationRun(runId) {
	const trimmed = runId.trim();
	if (!trimmed) return false;
	return stripWakeRunSuffixes(trimmed) !== trimmed;
}
function stripAndClassifyReply(text) {
	let result = text;
	let didStrip = false;
	const hasLeadingSilentToken = startsWithSilentToken(result, SILENT_REPLY_TOKEN);
	if (hasLeadingSilentToken) {
		result = stripLeadingSilentToken(result, SILENT_REPLY_TOKEN);
		didStrip = true;
	}
	if (hasLeadingSilentToken || result.toLowerCase().includes("NO_REPLY".toLowerCase())) {
		result = stripSilentToken(result, SILENT_REPLY_TOKEN);
		didStrip = true;
	}
	if (didStrip && (!result.trim() || isSilentReplyText(result, "NO_REPLY") || isAnnounceSkip(result))) return null;
	return result;
}
async function wakeSubagentRunAfterDescendants(params) {
	if (params.signal?.aborted) return false;
	if (!hasUsableSessionEntry(loadSessionEntryByKey(params.childSessionKey))) return false;
	const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(subagentAnnounceDeps.getRuntimeConfig());
	const wakeMessage = buildDescendantWakeMessage({
		findings: params.findings,
		taskLabel: params.taskLabel
	});
	let wakeRunId = "";
	try {
		wakeRunId = normalizeOptionalString((await runAnnounceDeliveryWithRetry({
			operation: "descendant wake agent call",
			signal: params.signal,
			run: async () => await subagentAnnounceDeps.callGateway({
				method: "agent",
				params: {
					sessionKey: params.childSessionKey,
					message: wakeMessage,
					deliver: false,
					inputProvenance: {
						kind: "inter_session",
						sourceSessionKey: params.childSessionKey,
						sourceChannel: "webchat",
						sourceTool: "subagent_announce"
					},
					idempotencyKey: buildAnnounceIdempotencyKey(`${params.announceId}:wake`)
				},
				timeoutMs: announceTimeoutMs
			})
		}))?.runId) ?? "";
	} catch {
		return false;
	}
	if (!wakeRunId) return false;
	const { replaceSubagentRunAfterSteer } = await loadSubagentRegistryRuntime();
	return replaceSubagentRunAfterSteer({
		previousRunId: params.runId,
		nextRunId: wakeRunId,
		preserveFrozenResultFallback: true
	});
}
async function runSubagentAnnounceFlow(params) {
	let didAnnounce = false;
	const expectsCompletionMessage = params.expectsCompletionMessage === true;
	const announceType = params.announceType ?? "subagent task";
	let shouldDeleteChildSession = params.cleanup === "delete";
	try {
		const sessionEntryCache = /* @__PURE__ */ new Map();
		const requesterEntryCache = /* @__PURE__ */ new Map();
		const readSessionEntryByKey = (sessionKey, options) => {
			if (options?.refresh || !sessionEntryCache.has(sessionKey)) sessionEntryCache.set(sessionKey, loadSessionEntryByKey(sessionKey));
			return sessionEntryCache.get(sessionKey);
		};
		const readRequesterSessionEntry = (requesterSessionKey, options) => {
			if (options?.refresh || !requesterEntryCache.has(requesterSessionKey)) requesterEntryCache.set(requesterSessionKey, loadRequesterSessionEntry(requesterSessionKey));
			return requesterEntryCache.get(requesterSessionKey);
		};
		const invalidateSessionEntry = (sessionKey) => {
			sessionEntryCache.delete(sessionKey);
			requesterEntryCache.delete(sessionKey);
		};
		let targetRequesterSessionKey = params.requesterSessionKey;
		let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
		const childSessionId = (() => {
			const entry = readSessionEntryByKey(params.childSessionKey);
			return typeof entry?.sessionId === "string" && entry.sessionId.trim() ? entry.sessionId.trim() : void 0;
		})();
		const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 12e4);
		let reply = params.roundOneReply;
		let outcome = params.outcome;
		if (childSessionId && isEmbeddedPiRunActive(childSessionId)) {
			if (!await waitForEmbeddedPiRunEnd(childSessionId, settleTimeoutMs) && isEmbeddedPiRunActive(childSessionId)) {
				shouldDeleteChildSession = false;
				return false;
			}
		}
		if (!reply && params.waitForCompletion !== false) {
			const applied = applySubagentWaitOutcome({
				wait: await waitForSubagentRunOutcome(params.childRunId, settleTimeoutMs),
				outcome,
				startedAt: params.startedAt,
				endedAt: params.endedAt
			});
			outcome = applied.outcome;
			params.startedAt = applied.startedAt;
			params.endedAt = applied.endedAt;
		}
		if (!outcome) outcome = { status: "unknown" };
		const failedTerminalOutcome = outcome.status === "error";
		const allowFailedOutputCapture = !failedTerminalOutcome || !params.roundOneReply && !params.fallbackReply;
		if (failedTerminalOutcome) reply = void 0;
		await drainChildContinuationQueue({
			childSessionKey: params.childSessionKey,
			requesterOrigin: targetRequesterOrigin
		});
		let requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
		const requesterIsInternalSession = () => requesterDepth >= 1 || isCronSessionKey(targetRequesterSessionKey);
		let childCompletionFindings;
		let subagentRegistryRuntime;
		try {
			subagentRegistryRuntime = await subagentAnnounceDeps.loadSubagentRegistryRuntime();
			const runtime = subagentRegistryRuntime;
			const refreshRequesterTarget = () => {
				if (!requesterIsInternalSession()) return { ok: true };
				if (runtime.isSubagentSessionRunActive(targetRequesterSessionKey)) return { ok: true };
				if (runtime.shouldIgnorePostCompletionAnnounceForSession(targetRequesterSessionKey)) return {
					ok: false,
					ignored: true
				};
				if (hasUsableSessionEntry(readSessionEntryByKey(targetRequesterSessionKey))) return { ok: true };
				const fallback = runtime.resolveRequesterForChildSession(targetRequesterSessionKey);
				if (!fallback?.requesterSessionKey) return {
					ok: false,
					missing: true
				};
				targetRequesterSessionKey = fallback.requesterSessionKey;
				targetRequesterOrigin = normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
				requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
				return { ok: true };
			};
			const requesterTarget = refreshRequesterTarget();
			if (!requesterTarget.ok) {
				if (requesterTarget.ignored) return true;
				shouldDeleteChildSession = false;
				return false;
			}
			if (Math.max(0, subagentRegistryRuntime.countPendingDescendantRuns(params.childSessionKey)) > 0 && announceType !== "cron job") {
				shouldDeleteChildSession = false;
				return false;
			}
			if (typeof subagentRegistryRuntime.listSubagentRunsForRequester === "function") {
				const directChildren = subagentRegistryRuntime.listSubagentRunsForRequester(params.childSessionKey, { requesterRunId: params.childRunId });
				if (Array.isArray(directChildren) && directChildren.length > 0) childCompletionFindings = buildChildCompletionFindings(dedupeLatestChildCompletionRows(filterCurrentDirectChildCompletionRows(directChildren, {
					requesterSessionKey: params.childSessionKey,
					getLatestSubagentRunByChildSessionKey: subagentRegistryRuntime.getLatestSubagentRunByChildSessionKey
				})));
			}
		} catch {}
		const announceId = buildAnnounceIdFromChildRun({
			childSessionKey: params.childSessionKey,
			childRunId: params.childRunId
		});
		const childRunAlreadyWoken = isWakeContinuationRun(params.childRunId);
		if (params.wakeOnDescendantSettle === true && childCompletionFindings?.trim() && !childRunAlreadyWoken) {
			const wakeAnnounceId = buildAnnounceIdFromChildRun({
				childSessionKey: params.childSessionKey,
				childRunId: stripWakeRunSuffixes(params.childRunId)
			});
			if (await wakeSubagentRunAfterDescendants({
				runId: params.childRunId,
				childSessionKey: params.childSessionKey,
				taskLabel: params.label || params.task || "task",
				findings: childCompletionFindings,
				announceId: wakeAnnounceId,
				signal: params.signal
			})) {
				shouldDeleteChildSession = false;
				return true;
			}
		}
		let skipAnnounceDelivery = false;
		if (childCompletionFindings?.trim()) reply = childCompletionFindings;
		else if (!failedTerminalOutcome) {
			const fallbackReply = normalizeOptionalString(params.fallbackReply);
			const fallbackIsSilent = Boolean(fallbackReply) && (isAnnounceSkip(fallbackReply) || isSilentReplyText(fallbackReply, "NO_REPLY"));
			if (!reply && allowFailedOutputCapture) reply = await readSubagentOutput(params.childSessionKey, outcome);
			if (!reply?.trim() && allowFailedOutputCapture) reply = await readLatestSubagentOutputWithRetry({
				sessionKey: params.childSessionKey,
				maxWaitMs: params.timeoutMs,
				outcome
			});
			if (!reply?.trim() && fallbackReply && !fallbackIsSilent) reply = fallbackReply;
			if (outcome?.status === "timeout" && reply?.trim() && params.waitForCompletion !== false) try {
				const applied = applySubagentWaitOutcome({
					wait: await waitForSubagentRunOutcome(params.childRunId, 0),
					outcome,
					startedAt: params.startedAt,
					endedAt: params.endedAt
				});
				outcome = applied.outcome;
				params.startedAt = applied.startedAt;
				params.endedAt = applied.endedAt;
			} catch {}
			if (isAnnounceSkip(reply) || isSilentReplyText(reply, "NO_REPLY")) if (fallbackReply && !fallbackIsSilent) {
				const cleaned = stripAndClassifyReply(fallbackReply);
				if (cleaned === null) return true;
				reply = cleaned;
			} else skipAnnounceDelivery = true;
			else if (reply) {
				const cleaned = stripAndClassifyReply(reply);
				if (cleaned === null) if (fallbackReply && !fallbackIsSilent) {
					const cleanedFallback = stripAndClassifyReply(fallbackReply);
					if (cleanedFallback === null) return true;
					reply = cleanedFallback;
				} else return true;
				else reply = cleaned;
			}
		}
		if (!outcome) outcome = { status: "unknown" };
		const statusLabel = outcome.status === "ok" ? "completed successfully" : outcome.status === "timeout" ? "timed out" : outcome.status === "error" ? `failed: ${outcome.error || "unknown error"}` : "finished with unknown status";
		const taskLabel = params.label || params.task || "task";
		const announceSessionId = childSessionId || "unknown";
		let findings = reply || "(no output)";
		if (childCompletionFindings?.trim() && findings !== "(no output)" && findings !== childCompletionFindings) findings = `${findings}\n\n[Descendant completions]\n${childCompletionFindings}`;
		const cfg = subagentAnnounceDeps.getRuntimeConfig();
		const continuationEnabled = cfg?.agents?.defaults?.continuation?.enabled === true;
		const childTask = params.task ?? "";
		const isContinuationChainDelegate = CONTINUATION_CHAIN_HOP_PATTERN.test(childTask);
		let accumulatedChildTokens = 0;
		if (continuationEnabled && isContinuationChainDelegate) {
			let childEntry = readSessionEntryByKey(params.childSessionKey);
			if (!(typeof childEntry?.inputTokens === "number" || typeof childEntry?.outputTokens === "number")) {
				await new Promise((resolve) => setTimeout(resolve, 150));
				childEntry = readSessionEntryByKey(params.childSessionKey, { refresh: true });
				if (!(typeof childEntry?.inputTokens === "number" || typeof childEntry?.outputTokens === "number")) defaultRuntime.log(`[subagent-chain-hop] Token data unavailable for ${params.childSessionKey} after retry, proceeding with zero token accumulation`);
			}
			accumulatedChildTokens = (typeof childEntry?.inputTokens === "number" ? childEntry.inputTokens : 0) + (typeof childEntry?.outputTokens === "number" ? childEntry.outputTokens : 0);
			if (accumulatedChildTokens > 0) {
				const parentAgentId = resolveAgentIdFromSessionKey(targetRequesterSessionKey);
				const parentStorePath = resolveStorePath(cfg?.session?.store, { agentId: parentAgentId });
				try {
					await updateSessionStore(parentStorePath, (store) => {
						const parentEntry = store[targetRequesterSessionKey];
						if (parentEntry) parentEntry.continuationChainTokens = (typeof parentEntry.continuationChainTokens === "number" ? parentEntry.continuationChainTokens : 0) + accumulatedChildTokens;
					});
					defaultRuntime.log(`[subagent-chain-hop] Accumulated ${accumulatedChildTokens} tokens from ${params.childSessionKey} to parent chain cost`);
					invalidateSessionEntry(targetRequesterSessionKey);
				} catch (err) {
					defaultRuntime.log(`[subagent-chain-hop] Failed to persist token accumulation for ${targetRequesterSessionKey}: ${String(err)}`);
				}
			}
		}
		const toolDelegates = continuationEnabled && isContinuationChainDelegate ? consumePendingDelegates(params.childSessionKey) : [];
		if (toolDelegates.length > 0) defaultRuntime.log(`[subagent-chain-hop] Consuming ${toolDelegates.length} tool delegate(s) from subagent ${params.childSessionKey}`);
		if (!isContinuationChainDelegate && continuationEnabled) {
			const orphaned = consumePendingDelegates(params.childSessionKey);
			if (orphaned.length > 0) defaultRuntime.log(`[subagent-chain-hop] WARNING: ${orphaned.length} tool delegate(s) orphaned from non-chain-hop subagent ${params.childSessionKey} — drainsContinuationDelegateQueue was set but task has no chain-hop prefix`);
		}
		let bracketDelegateConsumed = false;
		if (continuationEnabled && (findings !== "(no output)" || toolDelegates.length > 0)) {
			const continuationResult = stripContinuationSignal(findings);
			if (continuationResult.signal?.kind === "work") defaultRuntime.log(`[subagent-chain-hop] CONTINUE_WORK not supported in sub-agent chain (from ${params.childSessionKey}), ignoring`);
			else if (continuationResult.signal?.kind === "delegate") {
				bracketDelegateConsumed = true;
				findings = continuationResult.text || "(no output)";
				const chainSignal = continuationResult.signal;
				const chainTask = chainSignal.task;
				const chainDelayMs = chainSignal.delayMs;
				const parentWasSilent = params.silentAnnounce === true;
				const chainSilent = chainSignal.silent || chainSignal.silentWake || parentWasSilent;
				const chainWake = chainSignal.silentWake || parentWasSilent && params.wakeOnReturn === true;
				const { maxChainLength, costCapTokens, minDelayMs, maxDelayMs } = subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg);
				const hopMatch = childTask.match(CONTINUATION_CHAIN_HOP_PATTERN);
				const childChainHop = hopMatch ? Number.parseInt(hopMatch[1], 10) : 0;
				const nextChainHop = childChainHop + 1;
				let chainGuardResult;
				if (childChainHop >= maxChainLength) chainGuardResult = {
					allowed: false,
					reason: "chain-length",
					chainCount: nextChainHop,
					maxChainLength
				};
				else {
					const storedChainTokens = readSessionEntryByKey(targetRequesterSessionKey)?.continuationChainTokens ?? 0;
					const parentChainTokens = storedChainTokens >= accumulatedChildTokens ? storedChainTokens : storedChainTokens + accumulatedChildTokens;
					if (costCapTokens > 0 && parentChainTokens > costCapTokens) chainGuardResult = {
						allowed: false,
						reason: "cost-cap",
						chainTokens: parentChainTokens,
						costCapTokens
					};
					else chainGuardResult = {
						allowed: true,
						nextChainHop
					};
				}
				if (!chainGuardResult.allowed) if (chainGuardResult.reason === "chain-length") defaultRuntime.log(`[subagent-chain-hop] Chain length ${chainGuardResult.chainCount} > ${chainGuardResult.maxChainLength}, rejecting hop from ${params.childSessionKey}`);
				else defaultRuntime.log(`[subagent-chain-hop] Cost cap exceeded (${chainGuardResult.chainTokens} > ${chainGuardResult.costCapTokens}), rejecting hop from ${params.childSessionKey}`);
				else {
					const nextChainHop = chainGuardResult.nextChainHop;
					const continuationStateRuntime = await loadContinuationStateRuntime();
					const doChainSpawn = async (timerTriggered = false) => {
						try {
							const childDepth = getSubagentDepthFromSessionStore(params.childSessionKey);
							const { spawnSubagentDirect } = await loadSubagentSpawnRuntime();
							const spawnResult = await spawnSubagentDirect({
								task: `[continuation:chain-hop:${nextChainHop}] Delegated from sub-agent (depth ${childDepth}): ${chainTask}`,
								...chainSilent ? { silentAnnounce: true } : {},
								...chainWake ? {
									silentAnnounce: true,
									wakeOnReturn: true
								} : {},
								...chainSignal.targetSessionKey ? { continuationTargetSessionKey: chainSignal.targetSessionKey } : {},
								...chainSignal.targetSessionKeys && chainSignal.targetSessionKeys.length > 0 ? { continuationTargetSessionKeys: chainSignal.targetSessionKeys } : {},
								...chainSignal.fanoutMode ? { continuationFanoutMode: chainSignal.fanoutMode } : {},
								drainsContinuationDelegateQueue: true
							}, {
								agentSessionKey: targetRequesterSessionKey,
								agentChannel: targetRequesterOrigin?.channel ?? void 0,
								agentAccountId: targetRequesterOrigin?.accountId ?? void 0,
								agentTo: targetRequesterOrigin?.to ?? void 0,
								agentThreadId: targetRequesterOrigin?.threadId ?? void 0
							});
							if (spawnResult.status === "accepted") defaultRuntime.log(timerTriggered ? `[subagent-chain-hop] Timer fired and spawned chain delegate (${nextChainHop}/${maxChainLength}) from ${params.childSessionKey}: ${chainTask.slice(0, 80)}` : `[subagent-chain-hop] Spawned chain delegate (${nextChainHop}/${maxChainLength}) from ${params.childSessionKey}: ${chainTask.slice(0, 80)}`);
							else defaultRuntime.log(`[subagent-chain-hop] Spawn rejected (${spawnResult.status}) from ${params.childSessionKey}: ${chainTask.slice(0, 80)}`);
						} catch (err) {
							defaultRuntime.log(`[subagent-chain-hop] Spawn failed from ${params.childSessionKey}: ${String(err)}`);
						}
					};
					if (chainDelayMs && chainDelayMs > 0) {
						const clampedDelay = Math.max(minDelayMs, Math.min(maxDelayMs, chainDelayMs));
						continuationStateRuntime.retainContinuationTimerRef(targetRequesterSessionKey);
						const timerHandle = setTimeout(() => {
							try {
								doChainSpawn(true).catch((err) => {
									defaultRuntime.log(`[subagent-chain-hop] Unhandled bracket delegate spawn error from ${params.childSessionKey}: ${String(err)}`);
								});
							} finally {
								continuationStateRuntime.unregisterContinuationTimerHandle(targetRequesterSessionKey, timerHandle);
							}
						}, clampedDelay);
						continuationStateRuntime.registerContinuationTimerHandle(targetRequesterSessionKey, timerHandle);
						timerHandle.unref();
					} else doChainSpawn().catch((err) => {
						defaultRuntime.log(`[subagent-chain-hop] Unhandled bracket delegate spawn error from ${params.childSessionKey}: ${String(err)}`);
					});
				}
			}
			if (toolDelegates.length > 0 && isContinuationChainDelegate) {
				const { maxChainLength: toolMaxChainLength, costCapTokens: toolCostCapTokens, minDelayMs: toolMinDelayMs, maxDelayMs: toolMaxDelayMs } = subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg);
				const hopMatch = childTask.match(CONTINUATION_CHAIN_HOP_PATTERN);
				let toolHopBase = (hopMatch ? Number.parseInt(hopMatch[1], 10) : 0) + (bracketDelegateConsumed ? 1 : 0);
				const parentWasSilent = params.silentAnnounce === true;
				let toolDelegateIdx = 0;
				for (const toolDelegate of toolDelegates) {
					const nextToolHop = toolHopBase + 1;
					if (nextToolHop > toolMaxChainLength) {
						const remaining = toolDelegates.length - toolDelegateIdx;
						defaultRuntime.log(`[subagent-chain-hop] Tool delegate chain length ${nextToolHop} > ${toolMaxChainLength}, rejecting from ${params.childSessionKey}. ${remaining} delegate(s) dropped.`);
						break;
					}
					const storedToolChainTokens = readSessionEntryByKey(targetRequesterSessionKey)?.continuationChainTokens ?? 0;
					const parentChainTokensForTool = storedToolChainTokens >= accumulatedChildTokens ? storedToolChainTokens : storedToolChainTokens + accumulatedChildTokens;
					if (toolCostCapTokens > 0 && parentChainTokensForTool > toolCostCapTokens) {
						const remaining = toolDelegates.length - toolDelegateIdx;
						defaultRuntime.log(`[subagent-chain-hop] Tool delegate cost cap exceeded (${parentChainTokensForTool} > ${toolCostCapTokens}), rejecting from ${params.childSessionKey}. ${remaining} delegate(s) dropped.`);
						break;
					}
					const delegateMode = toolDelegate.mode ?? "normal";
					const toolSilent = delegateMode === "silent" || delegateMode === "silent-wake" || parentWasSilent;
					const toolWake = delegateMode === "silent-wake" || parentWasSilent && params.wakeOnReturn === true;
					const toolDelayMs = toolDelegate.delayMs;
					const continuationStateRuntime = await loadContinuationStateRuntime();
					const childDepth = getSubagentDepthFromSessionStore(params.childSessionKey);
					const doToolChainSpawn = async (timerTriggered = false) => {
						try {
							const { spawnSubagentDirect } = await loadSubagentSpawnRuntime();
							const spawnResult = await spawnSubagentDirect({
								task: `[continuation:chain-hop:${nextToolHop}] Tool-delegated from sub-agent (depth ${childDepth}): ${toolDelegate.task}`,
								...toolSilent ? { silentAnnounce: true } : {},
								...toolWake ? {
									silentAnnounce: true,
									wakeOnReturn: true
								} : {},
								...toolDelegate.targetSessionKey ? { continuationTargetSessionKey: toolDelegate.targetSessionKey } : {},
								...toolDelegate.targetSessionKeys && toolDelegate.targetSessionKeys.length > 0 ? { continuationTargetSessionKeys: toolDelegate.targetSessionKeys } : {},
								...toolDelegate.fanoutMode ? { continuationFanoutMode: toolDelegate.fanoutMode } : {},
								drainsContinuationDelegateQueue: true
							}, {
								agentSessionKey: targetRequesterSessionKey,
								agentChannel: targetRequesterOrigin?.channel ?? void 0,
								agentAccountId: targetRequesterOrigin?.accountId ?? void 0,
								agentTo: targetRequesterOrigin?.to ?? void 0,
								agentThreadId: targetRequesterOrigin?.threadId ?? void 0
							});
							if (spawnResult.status === "accepted") defaultRuntime.log(`[subagent-chain-hop] ${timerTriggered ? "Timer: " : ""}Tool delegate (${nextToolHop}/${toolMaxChainLength}) from ${params.childSessionKey}: ${toolDelegate.task.slice(0, 80)}`);
							else defaultRuntime.log(`[subagent-chain-hop] Tool delegate spawn rejected (${spawnResult.status}) from ${params.childSessionKey}`);
						} catch (err) {
							defaultRuntime.log(`[subagent-chain-hop] Tool delegate spawn failed from ${params.childSessionKey}: ${String(err)}`);
						}
					};
					if (toolDelayMs && toolDelayMs > 0) {
						const clampedDelay = Math.max(toolMinDelayMs, Math.min(toolMaxDelayMs, toolDelayMs));
						continuationStateRuntime.retainContinuationTimerRef(targetRequesterSessionKey);
						const timerHandle = setTimeout(() => {
							try {
								doToolChainSpawn(true).catch((err) => {
									defaultRuntime.log(`[subagent-chain-hop] Unhandled tool delegate spawn error from ${params.childSessionKey}: ${String(err)}`);
								});
							} finally {
								continuationStateRuntime.unregisterContinuationTimerHandle(targetRequesterSessionKey, timerHandle);
							}
						}, clampedDelay);
						continuationStateRuntime.registerContinuationTimerHandle(targetRequesterSessionKey, timerHandle);
						timerHandle.unref();
					} else doToolChainSpawn().catch((err) => {
						defaultRuntime.log(`[subagent-chain-hop] Unhandled tool delegate spawn error from ${params.childSessionKey}: ${String(err)}`);
					});
					toolHopBase = nextToolHop;
					toolDelegateIdx += 1;
				}
			}
		}
		if (skipAnnounceDelivery) return true;
		const requesterIsSubagent = requesterIsInternalSession();
		const replyInstruction = buildAnnounceReplyInstruction({
			requesterIsSubagent,
			announceType,
			expectsCompletionMessage,
			silentEnrichment: params.silentAnnounce === true,
			silentWakeEnrichment: params.silentAnnounce === true && params.wakeOnReturn === true
		});
		const statsLine = await buildCompactAnnounceStatsLine({
			sessionKey: params.childSessionKey,
			startedAt: params.startedAt,
			endedAt: params.endedAt
		});
		const internalEvents = [{
			type: "task_completion",
			source: announceType === "cron job" ? "cron" : "subagent",
			childSessionKey: params.childSessionKey,
			childSessionId: announceSessionId,
			announceType,
			taskLabel,
			status: outcome.status,
			statusLabel,
			result: findings,
			statsLine,
			replyInstruction
		}];
		const triggerMessage = buildAnnounceSteerMessage(internalEvents);
		const completionTrace = resolveCompletionTraceContext({
			traceparent: params.traceparent,
			task: childTask,
			resolveMaxChainLength: () => subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg).maxChainLength
		});
		if (Boolean(params.continuationTargetSessionKey || params.continuationTargetSessionKeys && params.continuationTargetSessionKeys.length > 0 || params.continuationFanoutMode)) {
			const { enqueueContinuationReturnDeliveries, resolveContinuationReturnTargetSessionKeys } = await import("./targeting-BroN4PfO.js");
			const treeSessionKeys = params.continuationFanoutMode === "tree" && subagentRegistryRuntime ? subagentRegistryRuntime.listAncestorSessionKeys(targetRequesterSessionKey) : void 0;
			const allSessionKeys = params.continuationFanoutMode === "all" ? await listKnownSessionKeysOnHost(cfg) : void 0;
			const targetSessionKeys = resolveContinuationReturnTargetSessionKeys({
				defaultSessionKey: targetRequesterSessionKey,
				targetSessionKey: params.continuationTargetSessionKey,
				targetSessionKeys: params.continuationTargetSessionKeys,
				fanoutMode: params.continuationFanoutMode,
				treeSessionKeys,
				allSessionKeys,
				childSessionKey: params.childSessionKey
			});
			await enqueueContinuationReturnDeliveries({
				targetSessionKeys,
				text: triggerMessage || `[continuation:enrichment-return] Delegate completed: ${taskLabel}`,
				idempotencyKeyBase: `continuation-return:${announceId}`,
				wakeRecipients: params.wakeOnReturn === true || params.silentAnnounce !== true,
				childRunId: params.childRunId,
				...params.continuationFanoutMode ? { fanoutMode: params.continuationFanoutMode } : {},
				...completionTrace.chainStepRemaining !== void 0 ? { chainStepRemaining: completionTrace.chainStepRemaining } : {},
				...completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}
			});
			defaultRuntime.log(`[continuation:targeted-return] Delivered to ${targetSessionKeys.join(",")} from ${params.childSessionKey}`);
			didAnnounce = true;
			shouldDeleteChildSession = params.cleanup === "delete";
			return true;
		}
		let directOrigin = targetRequesterOrigin;
		if (!requesterIsSubagent) {
			const { entry } = readRequesterSessionEntry(targetRequesterSessionKey);
			directOrigin = resolveAnnounceOrigin(entry, targetRequesterOrigin);
		}
		const completionDirectOrigin = expectsCompletionMessage && !requesterIsSubagent ? await resolveSubagentCompletionOrigin({
			childSessionKey: params.childSessionKey,
			requesterSessionKey: targetRequesterSessionKey,
			requesterOrigin: directOrigin,
			childRunId: params.childRunId,
			spawnMode: params.spawnMode,
			expectsCompletionMessage
		}) : targetRequesterOrigin;
		if (params.silentAnnounce) {
			const { enqueueSystemEvent } = await import("./system-events-DHgAtkme.js");
			const { createSubsystemLogger } = await import("./subsystem-D6RvAVka.js");
			const continuationLog = createSubsystemLogger("continuation/announce");
			if (params.wakeOnReturn) continuationLog.info(`[continuation/silent-wake] wakeOnReturn=true target=${targetRequesterSessionKey} silentAnnounce=true`);
			enqueueSystemEvent(triggerMessage || `[continuation:enrichment-return] Delegate completed: ${taskLabel}`, {
				sessionKey: targetRequesterSessionKey,
				trusted: true,
				...completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}
			});
			continuationLog.info(`[continuation:enrichment-return] Delivered to ${targetRequesterSessionKey} from ${params.childSessionKey}`);
			if (params.wakeOnReturn) {
				const { requestHeartbeatNow } = await import("./heartbeat-wake-5k2Xy3qm.js");
				requestHeartbeatNow({
					sessionKey: targetRequesterSessionKey,
					reason: "silent-wake-enrichment",
					parentRunId: params.childRunId
				});
			}
			didAnnounce = true;
			shouldDeleteChildSession = params.cleanup === "delete";
			return true;
		}
		const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
		const delegateReturnTrigger = continuationEnabled ? "delegate-return" : void 0;
		const delivery = await deliverSubagentAnnouncement({
			requesterSessionKey: targetRequesterSessionKey,
			announceId,
			triggerMessage,
			steerMessage: triggerMessage,
			internalEvents,
			summaryLine: taskLabel,
			requesterSessionOrigin: targetRequesterOrigin,
			requesterOrigin: expectsCompletionMessage && !requesterIsSubagent ? completionDirectOrigin : targetRequesterOrigin,
			completionDirectOrigin,
			directOrigin,
			sourceSessionKey: params.childSessionKey,
			sourceChannel: INTERNAL_MESSAGE_CHANNEL,
			sourceTool: "subagent_announce",
			targetRequesterSessionKey,
			requesterIsSubagent,
			expectsCompletionMessage,
			bestEffortDeliver: params.bestEffortDeliver,
			directIdempotencyKey,
			signal: params.signal,
			continuationTriggerOverride: delegateReturnTrigger,
			...completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}
		});
		params.onDeliveryResult?.(delivery);
		didAnnounce = delivery.delivered;
		if (!delivery.delivered && delivery.path === "direct" && delivery.error) defaultRuntime.error?.(`Subagent completion direct announce failed for run ${params.childRunId}: ${delivery.error}`);
	} catch (err) {
		defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
	} finally {
		if (params.label) try {
			await subagentAnnounceDeps.callGateway({
				method: "sessions.patch",
				params: {
					key: params.childSessionKey,
					label: params.label
				},
				timeoutMs: 1e4
			});
		} catch {}
		if (shouldDeleteChildSession) await deleteSubagentSessionForCleanup({
			callGateway: subagentAnnounceDeps.callGateway,
			childSessionKey: params.childSessionKey,
			spawnMode: params.spawnMode
		});
	}
	return didAnnounce;
}
const __testing = { setDepsForTest(overrides) {
	subagentAnnounceDeps = overrides ? {
		...defaultSubagentAnnounceDeps,
		...overrides
	} : defaultSubagentAnnounceDeps;
} };
//#endregion
export { __testing, buildSubagentSystemPrompt, captureSubagentCompletionReply, runSubagentAnnounceFlow };
