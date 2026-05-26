import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as resolveGlobalMap } from "./global-singleton-DE6St75u.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { n as resolveGlobalDedupeCache } from "./dedupe-BD30U36x.js";
import { n as channelRouteDedupeKey, t as channelRouteCompactKey } from "./channel-route-L2PJ-xNE.js";
import { t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { r as clearCommandLane } from "./command-queue-Da2Lh3Ua.js";
import { i as normalizeQueueMode, n as normalizePersistedQueueMode, r as normalizeQueueDropPolicy } from "./directive-Dz6UwJA7.js";
import { t as resolveEmbeddedSessionLane } from "./lanes-BrQRlRRS.js";
import { t as isRoutableChannel } from "./route-reply-xAts-3Gi.js";
//#region src/utils/queue-helpers.ts
function clearQueueSummaryState(state) {
	state.droppedCount = 0;
	state.summaryLines = [];
}
function previewQueueSummaryPrompt(params) {
	return buildQueueSummaryPrompt({
		state: {
			dropPolicy: params.state.dropPolicy,
			droppedCount: params.state.droppedCount,
			summaryLines: [...params.state.summaryLines]
		},
		noun: params.noun,
		title: params.title
	});
}
function applyQueueRuntimeSettings(params) {
	params.target.mode = params.settings.mode;
	params.target.debounceMs = typeof params.settings.debounceMs === "number" ? Math.max(0, params.settings.debounceMs) : params.target.debounceMs;
	params.target.cap = typeof params.settings.cap === "number" && params.settings.cap > 0 ? Math.floor(params.settings.cap) : params.target.cap;
	params.target.dropPolicy = params.settings.dropPolicy ?? params.target.dropPolicy;
}
function elideQueueText(text, limit = 140) {
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
function buildQueueSummaryLine(text, limit = 160) {
	return elideQueueText(text.replace(/\s+/g, " ").trim(), limit);
}
function shouldSkipQueueItem(params) {
	if (!params.dedupe) return false;
	return params.dedupe(params.item, params.items);
}
function applyQueueDropPolicy(params) {
	const cap = params.queue.cap;
	if (cap <= 0 || params.queue.items.length < cap) return true;
	if (params.queue.dropPolicy === "new") return false;
	const dropCount = params.queue.items.length - cap + 1;
	const dropped = params.queue.items.splice(0, dropCount);
	params.onDrop?.(dropped);
	if (params.queue.dropPolicy === "summarize") {
		for (const item of dropped) {
			params.queue.droppedCount += 1;
			params.queue.summaryLines.push(buildQueueSummaryLine(params.summarize(item)));
		}
		const limit = Math.max(0, params.summaryLimit ?? cap);
		while (params.queue.summaryLines.length > limit) params.queue.summaryLines.shift();
	}
	return true;
}
function waitForQueueDebounce(queue) {
	if (process.env.OPENCLAW_TEST_FAST === "1") return Promise.resolve();
	const debounceMs = Math.max(0, queue.debounceMs);
	if (debounceMs <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const check = () => {
			const since = Date.now() - queue.lastEnqueuedAt;
			if (since >= debounceMs) {
				resolve();
				return;
			}
			setTimeout(check, debounceMs - since);
		};
		check();
	});
}
function beginQueueDrain(map, key) {
	const queue = map.get(key);
	if (!queue || queue.draining) return;
	queue.draining = true;
	return queue;
}
async function drainNextQueueItem(items, run) {
	const next = items[0];
	if (!next) return false;
	await run(next);
	items.shift();
	return true;
}
async function drainCollectItemIfNeeded(params) {
	if (!params.forceIndividualCollect && !params.isCrossChannel) return "skipped";
	if (params.isCrossChannel) params.setForceIndividualCollect?.(true);
	return await drainNextQueueItem(params.items, params.run) ? "drained" : "empty";
}
async function drainCollectQueueStep(params) {
	return await drainCollectItemIfNeeded({
		forceIndividualCollect: params.collectState.forceIndividualCollect,
		isCrossChannel: params.isCrossChannel,
		setForceIndividualCollect: (next) => {
			params.collectState.forceIndividualCollect = next;
		},
		items: params.items,
		run: params.run
	});
}
function buildQueueSummaryPrompt(params) {
	if (params.state.dropPolicy !== "summarize" || params.state.droppedCount <= 0) return;
	const noun = params.noun;
	const lines = [params.title ?? `[Queue overflow] Dropped ${params.state.droppedCount} ${noun}${params.state.droppedCount === 1 ? "" : "s"} due to cap.`];
	if (params.state.summaryLines.length > 0) {
		lines.push("Summary:");
		for (const line of params.state.summaryLines) lines.push(`- ${line}`);
	}
	clearQueueSummaryState(params.state);
	return lines.join("\n");
}
function buildCollectPrompt(params) {
	const blocks = [params.title];
	if (params.summary) blocks.push(params.summary);
	params.items.forEach((item, idx) => {
		blocks.push(params.renderItem(item, idx));
	});
	return blocks.join("\n\n");
}
function hasCrossChannelItems(items, resolveKey) {
	const keys = /* @__PURE__ */ new Set();
	for (const item of items) {
		const resolved = resolveKey(item);
		if (resolved.cross) return true;
		if (!resolved.key) continue;
		keys.add(resolved.key);
	}
	return keys.size > 1;
}
//#endregion
//#region src/auto-reply/reply/queue/types.ts
function isFollowupRunAborted(run) {
	return run.abortSignal?.aborted === true;
}
const enqueuedFollowupLifecycles = /* @__PURE__ */ new WeakSet();
const completedFollowupLifecycles = /* @__PURE__ */ new WeakSet();
function markFollowupRunEnqueued(run) {
	const lifecycle = run.queuedLifecycle;
	if (!lifecycle || enqueuedFollowupLifecycles.has(lifecycle)) return;
	enqueuedFollowupLifecycles.add(lifecycle);
	lifecycle.onEnqueued?.();
}
function completeFollowupRunLifecycle(run) {
	const lifecycle = run.queuedLifecycle;
	if (!lifecycle || completedFollowupLifecycles.has(lifecycle)) return;
	completedFollowupLifecycles.add(lifecycle);
	lifecycle.onComplete?.();
}
const FOLLOWUP_QUEUES = resolveGlobalMap(Symbol.for("openclaw.followupQueues"));
function getExistingFollowupQueue(key) {
	const cleaned = key.trim();
	if (!cleaned) return;
	return FOLLOWUP_QUEUES.get(cleaned);
}
function getFollowupQueue(key, settings) {
	const existing = FOLLOWUP_QUEUES.get(key);
	if (existing) {
		applyQueueRuntimeSettings({
			target: existing,
			settings
		});
		return existing;
	}
	const created = {
		items: [],
		draining: false,
		lastEnqueuedAt: 0,
		mode: settings.mode,
		debounceMs: typeof settings.debounceMs === "number" ? Math.max(0, settings.debounceMs) : 500,
		cap: typeof settings.cap === "number" && settings.cap > 0 ? Math.floor(settings.cap) : 20,
		dropPolicy: settings.dropPolicy ?? "summarize",
		droppedCount: 0,
		summaryLines: [],
		summarySources: []
	};
	applyQueueRuntimeSettings({
		target: created,
		settings
	});
	FOLLOWUP_QUEUES.set(key, created);
	return created;
}
function clearFollowupQueue(key) {
	const cleaned = key.trim();
	const queue = getExistingFollowupQueue(cleaned);
	if (!queue) return 0;
	const cleared = queue.items.length + queue.droppedCount;
	for (const item of queue.items) completeFollowupRunLifecycle(item);
	for (const item of queue.summarySources) completeFollowupRunLifecycle(item);
	queue.items.length = 0;
	queue.droppedCount = 0;
	queue.summaryLines = [];
	queue.summarySources = [];
	queue.lastRun = void 0;
	queue.lastEnqueuedAt = 0;
	FOLLOWUP_QUEUES.delete(cleaned);
	return cleared;
}
function refreshQueuedFollowupSession(params) {
	const cleaned = params.key.trim();
	if (!cleaned) return;
	const queue = getExistingFollowupQueue(cleaned);
	if (!queue) return;
	const shouldRewriteSession = Boolean(params.previousSessionId) && Boolean(params.nextSessionId) && params.previousSessionId !== params.nextSessionId;
	const shouldRewriteModelSelection = typeof params.nextProvider === "string" || typeof params.nextModel === "string" || Object.hasOwn(params, "nextModelOverrideSource");
	const shouldRewriteSelection = shouldRewriteModelSelection || Object.hasOwn(params, "nextAuthProfileId") || Object.hasOwn(params, "nextAuthProfileIdSource");
	if (!shouldRewriteSession && !shouldRewriteSelection) return;
	const rewriteRun = (run) => {
		if (!run) return;
		if (shouldRewriteSession && run.sessionId === params.previousSessionId) {
			run.sessionId = params.nextSessionId;
			const nextSessionFile = normalizeOptionalString(params.nextSessionFile);
			if (nextSessionFile) run.sessionFile = nextSessionFile;
		}
		if (shouldRewriteSelection) {
			if (typeof params.nextProvider === "string") run.provider = params.nextProvider;
			if (typeof params.nextModel === "string") run.model = params.nextModel;
			if (shouldRewriteModelSelection) delete run.hasAutoFallbackProvenance;
			if (Object.hasOwn(params, "nextModelOverrideSource")) {
				run.hasSessionModelOverride = Boolean(run.provider || run.model);
				run.modelOverrideSource = params.nextModelOverrideSource;
			}
			if (Object.hasOwn(params, "nextAuthProfileId")) run.authProfileId = normalizeOptionalString(params.nextAuthProfileId);
			if (Object.hasOwn(params, "nextAuthProfileIdSource")) run.authProfileIdSource = run.authProfileId ? params.nextAuthProfileIdSource : void 0;
		}
	};
	rewriteRun(queue.lastRun);
	for (const item of queue.items) rewriteRun(item.run);
}
//#endregion
//#region src/auto-reply/reply/queue/drain.ts
const FOLLOWUP_RUN_CALLBACKS = resolveGlobalMap(Symbol.for("openclaw.followupDrainCallbacks"));
function rememberFollowupDrainCallback(key, runFollowup) {
	FOLLOWUP_RUN_CALLBACKS.set(key, runFollowup);
}
function clearFollowupDrainCallback(key) {
	FOLLOWUP_RUN_CALLBACKS.delete(key);
}
/** Restart the drain for `key` if it is currently idle, using the stored callback. */
function kickFollowupDrainIfIdle(key) {
	const cb = FOLLOWUP_RUN_CALLBACKS.get(key);
	if (!cb) return;
	scheduleFollowupDrain(key, cb);
}
function resolveOriginRoutingMetadata(items) {
	const metadata = {};
	for (const item of items) {
		if (!metadata.originatingChannel && item.originatingChannel) metadata.originatingChannel = item.originatingChannel;
		if (!metadata.originatingTo && item.originatingTo) metadata.originatingTo = item.originatingTo;
		if (!metadata.originatingAccountId && item.originatingAccountId) metadata.originatingAccountId = item.originatingAccountId;
		if (metadata.originatingThreadId == null && item.originatingThreadId != null && item.originatingThreadId !== "") metadata.originatingThreadId = item.originatingThreadId;
		if (metadata.originatingChannel && metadata.originatingTo && metadata.originatingAccountId && metadata.originatingThreadId != null) break;
	}
	return metadata;
}
function resolveFollowupAuthorizationKey(run) {
	return JSON.stringify([
		run.senderId ?? "",
		run.senderE164 ?? "",
		run.senderIsOwner === true,
		run.execOverrides?.host ?? "",
		run.execOverrides?.security ?? "",
		run.execOverrides?.ask ?? "",
		run.execOverrides?.node ?? "",
		run.bashElevated?.enabled === true,
		run.bashElevated?.allowed === true,
		run.bashElevated?.defaultLevel ?? ""
	]);
}
function splitCollectItemsByAuthorization(items) {
	if (items.length <= 1) return items.length === 0 ? [] : [items];
	const groups = [];
	let currentGroup = [];
	let currentKey;
	for (const item of items) {
		const itemKey = resolveFollowupAuthorizationKey(item.run);
		if (currentGroup.length === 0 || itemKey === currentKey) {
			currentGroup.push(item);
			currentKey = itemKey;
			continue;
		}
		groups.push(currentGroup);
		currentGroup = [item];
		currentKey = itemKey;
	}
	if (currentGroup.length > 0) groups.push(currentGroup);
	return groups;
}
function renderCollectItem(item, idx) {
	const senderLabel = item.run.senderName ?? item.run.senderUsername ?? item.run.senderId ?? item.run.senderE164;
	const senderSuffix = senderLabel ? ` (from ${senderLabel})` : "";
	return `---\nQueued #${idx + 1}${senderSuffix}\n${item.prompt}`.trim();
}
function collectQueuedImages(items) {
	const images = [];
	const imageOrder = [];
	for (const item of items) {
		if (item.images) images.push(...item.images);
		if (item.imageOrder) imageOrder.push(...item.imageOrder);
	}
	return {
		...images.length > 0 ? { images } : {},
		...imageOrder.length > 0 ? { imageOrder } : {}
	};
}
function hasCurrentTurnRuntimeMetadata(item) {
	return item.currentInboundEventKind === "room_event" || Boolean(item.currentInboundContext);
}
function hasRuntimeOnlyFollowupMetadata(item) {
	return Boolean(hasCurrentTurnRuntimeMetadata(item) || item.abortSignal || item.deliveryCorrelations?.length || item.queuedLifecycle);
}
function combineAbortSignals(items) {
	const signals = items.flatMap((item) => item.abortSignal ? [item.abortSignal] : []);
	if (signals.length === 0) return;
	if (signals.length === 1) return signals[0];
	const nativeAny = AbortSignal.any;
	if (nativeAny) return nativeAny(signals);
	const controller = new AbortController();
	const abort = () => controller.abort();
	for (const signal of signals) {
		if (signal.aborted) {
			abort();
			break;
		}
		signal.addEventListener("abort", abort, { once: true });
	}
	return controller.signal;
}
function collectRuntimeMetadata(items, singletonOwner) {
	const candidates = singletonOwner ? [singletonOwner, ...items] : items;
	const currentTurnSource = singletonOwner && hasCurrentTurnRuntimeMetadata(singletonOwner) ? singletonOwner : items.find(hasCurrentTurnRuntimeMetadata);
	const abortSignal = singletonOwner?.abortSignal ?? combineAbortSignals(candidates);
	const deliveryCorrelations = items.flatMap((item) => item.deliveryCorrelations ?? []);
	const lifecycleSource = singletonOwner ?? items.find((item) => item.queuedLifecycle);
	return {
		currentInboundEventKind: currentTurnSource?.currentInboundEventKind,
		currentInboundContext: currentTurnSource?.currentInboundContext,
		abortSignal,
		deliveryCorrelations: deliveryCorrelations.length > 0 ? deliveryCorrelations : void 0,
		queuedLifecycle: singletonOwner?.queuedLifecycle ?? (items.length === 1 ? lifecycleSource?.queuedLifecycle : void 0)
	};
}
function collectSummaryRuntimeMetadata(items) {
	return collectRuntimeMetadata(items, items.length === 1 ? items[0] : void 0);
}
function clearFollowupQueueSummaryState(queue) {
	completeFollowupQueueSummarySources(queue);
	clearQueueSummaryState(queue);
}
function completeFollowupQueueSummarySources(queue) {
	for (const item of queue.summarySources ?? []) completeFollowupRunLifecycle(item);
	if (queue.summarySources) queue.summarySources = [];
}
async function runWithSummarySourceCleanup(queue, run) {
	try {
		await run();
	} finally {
		completeFollowupQueueSummarySources(queue);
	}
}
async function dropAbortedFollowups(items, runFollowup) {
	let dropped = 0;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (isFollowupRunAborted(item)) {
			await runFollowup(item);
			completeFollowupRunLifecycle(item);
			items.splice(index, 1);
			dropped += 1;
		}
	}
	return dropped;
}
function resolveCrossChannelKey(item) {
	const { originatingChannel: channel, originatingTo: to, originatingAccountId: accountId } = item;
	const threadId = item.originatingThreadId;
	if (!channel && !to && !accountId && (threadId == null || threadId === "")) return {};
	if (!isRoutableChannel(channel) || !to) return { cross: true };
	const key = channelRouteCompactKey({
		channel,
		to,
		accountId,
		threadId
	});
	return key ? { key } : { cross: true };
}
function scheduleFollowupDrain(key, runFollowup) {
	const queue = beginQueueDrain(FOLLOWUP_QUEUES, key);
	if (!queue) return;
	const effectiveRunFollowup = FOLLOWUP_RUN_CALLBACKS.get(key) ?? runFollowup;
	rememberFollowupDrainCallback(key, effectiveRunFollowup);
	(async () => {
		try {
			const collectState = { forceIndividualCollect: false };
			while (queue.items.length > 0 || queue.droppedCount > 0) {
				if (await dropAbortedFollowups(queue.items, effectiveRunFollowup) > 0 && queue.items.length === 0) clearFollowupQueueSummaryState(queue);
				if (queue.items.length === 0 && queue.droppedCount === 0) break;
				await waitForQueueDebounce(queue);
				if (await dropAbortedFollowups(queue.items, effectiveRunFollowup) > 0 && queue.items.length === 0) clearFollowupQueueSummaryState(queue);
				if (queue.items.length === 0 && queue.droppedCount === 0) break;
				if (queue.mode === "collect") {
					const isCrossChannel = hasCrossChannelItems(queue.items, resolveCrossChannelKey) || queue.items.some(hasRuntimeOnlyFollowupMetadata);
					if (collectState.forceIndividualCollect && !isCrossChannel && queue.items.length > 1) collectState.forceIndividualCollect = false;
					const collectDrainResult = await drainCollectQueueStep({
						collectState,
						isCrossChannel,
						items: queue.items,
						run: effectiveRunFollowup
					});
					if (collectDrainResult === "empty") {
						const summaryOnlyPrompt = previewQueueSummaryPrompt({
							state: queue,
							noun: "message"
						});
						const run = queue.lastRun;
						if (summaryOnlyPrompt && run) {
							await runWithSummarySourceCleanup(queue, async () => {
								await effectiveRunFollowup({
									prompt: summaryOnlyPrompt,
									run,
									enqueuedAt: Date.now(),
									...collectSummaryRuntimeMetadata([]),
									...collectQueuedImages(queue.items)
								});
							});
							clearFollowupQueueSummaryState(queue);
							continue;
						}
						break;
					}
					if (collectDrainResult === "drained") continue;
					const items = queue.items.slice();
					const summary = previewQueueSummaryPrompt({
						state: queue,
						noun: "message"
					});
					const authGroups = splitCollectItemsByAuthorization(items);
					if (authGroups.length === 0) {
						const run = queue.lastRun;
						if (!summary || !run) break;
						await runWithSummarySourceCleanup(queue, async () => {
							await effectiveRunFollowup({
								prompt: summary,
								run,
								enqueuedAt: Date.now(),
								...collectSummaryRuntimeMetadata([])
							});
						});
						clearFollowupQueueSummaryState(queue);
						continue;
					}
					let pendingSummary = summary;
					for (const groupItems of authGroups) {
						const run = groupItems.at(-1)?.run ?? queue.lastRun;
						if (!run) break;
						const routing = resolveOriginRoutingMetadata(groupItems);
						const prompt = buildCollectPrompt({
							title: "[Queued messages while agent was busy]",
							items: groupItems,
							summary: pendingSummary,
							renderItem: renderCollectItem
						});
						const drainGroup = async () => {
							await effectiveRunFollowup({
								prompt,
								run,
								enqueuedAt: Date.now(),
								...routing,
								...collectRuntimeMetadata(groupItems),
								...collectQueuedImages(groupItems)
							});
						};
						if (pendingSummary) await runWithSummarySourceCleanup(queue, drainGroup);
						else await drainGroup();
						queue.items.splice(0, groupItems.length);
						if (pendingSummary) {
							clearFollowupQueueSummaryState(queue);
							pendingSummary = void 0;
						}
					}
					continue;
				}
				const summaryPrompt = previewQueueSummaryPrompt({
					state: queue,
					noun: "message"
				});
				if (summaryPrompt) {
					const run = queue.lastRun;
					if (!run) break;
					if (!await drainNextQueueItem(queue.items, async (item) => {
						await runWithSummarySourceCleanup(queue, async () => {
							await effectiveRunFollowup({
								prompt: summaryPrompt,
								run,
								enqueuedAt: Date.now(),
								originatingChannel: item.originatingChannel,
								originatingTo: item.originatingTo,
								originatingAccountId: item.originatingAccountId,
								originatingThreadId: item.originatingThreadId,
								...collectSummaryRuntimeMetadata([item]),
								...collectQueuedImages([item])
							});
						});
					})) break;
					clearFollowupQueueSummaryState(queue);
					continue;
				}
				if (!await drainNextQueueItem(queue.items, effectiveRunFollowup)) break;
			}
		} catch (err) {
			queue.lastEnqueuedAt = Date.now();
			defaultRuntime.error?.(`followup queue drain failed for ${key}: ${String(err)}`);
		} finally {
			queue.draining = false;
			if (queue.items.length === 0 && queue.droppedCount === 0) {
				if (FOLLOWUP_QUEUES.get(key) === queue) {
					FOLLOWUP_QUEUES.delete(key);
					clearFollowupDrainCallback(key);
				}
			} else scheduleFollowupDrain(key, effectiveRunFollowup);
		}
	})();
}
//#endregion
//#region src/auto-reply/reply/queue/cleanup.ts
const defaultQueueCleanupDeps = {
	resolveEmbeddedSessionLane,
	clearCommandLane
};
const queueCleanupDeps = { ...defaultQueueCleanupDeps };
function resolveQueueCleanupLaneResolver() {
	return typeof queueCleanupDeps.resolveEmbeddedSessionLane === "function" ? queueCleanupDeps.resolveEmbeddedSessionLane : defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
}
function resolveQueueCleanupLaneClearer() {
	return typeof queueCleanupDeps.clearCommandLane === "function" ? queueCleanupDeps.clearCommandLane : defaultQueueCleanupDeps.clearCommandLane;
}
function clearSessionQueues(keys) {
	const seen = /* @__PURE__ */ new Set();
	let followupCleared = 0;
	let laneCleared = 0;
	const clearedKeys = [];
	const resolveLane = resolveQueueCleanupLaneResolver();
	const clearLane = resolveQueueCleanupLaneClearer();
	for (const key of keys) {
		const cleaned = normalizeOptionalString(key);
		if (!cleaned || seen.has(cleaned)) continue;
		seen.add(cleaned);
		clearedKeys.push(cleaned);
		followupCleared += clearFollowupQueue(cleaned);
		clearFollowupDrainCallback(cleaned);
		laneCleared += clearLane(resolveLane(cleaned));
	}
	return {
		followupCleared,
		laneCleared,
		keys: clearedKeys
	};
}
//#endregion
//#region src/auto-reply/reply/queue/enqueue.ts
const RECENT_QUEUE_MESSAGE_IDS = resolveGlobalDedupeCache(Symbol.for("openclaw.recentQueueMessageIds"), {
	ttlMs: 300 * 1e3,
	maxSize: 1e4
});
function followupRouteIdentityKey(run) {
	return channelRouteDedupeKey({
		channel: run.originatingChannel,
		to: run.originatingTo,
		accountId: run.originatingAccountId,
		threadId: run.originatingThreadId
	});
}
function buildRecentMessageIdKey(run, queueKey) {
	const messageId = normalizeOptionalString(run.messageId);
	if (!messageId) return;
	return JSON.stringify([
		"queue",
		queueKey,
		followupRouteIdentityKey(run),
		messageId
	]);
}
function isRunAlreadyQueued(run, items, allowPromptFallback = false) {
	const routeKey = followupRouteIdentityKey(run);
	const hasSameRouting = (item) => followupRouteIdentityKey(item) === routeKey;
	const messageId = normalizeOptionalString(run.messageId);
	if (messageId) return items.some((item) => normalizeOptionalString(item.messageId) === messageId && hasSameRouting(item));
	if (!allowPromptFallback) return false;
	return items.some((item) => item.prompt === run.prompt && hasSameRouting(item));
}
function enqueueFollowupRun(key, run, settings, dedupeMode = "message-id", runFollowup, restartIfIdle = true) {
	if (isFollowupRunAborted(run)) return false;
	const queue = getFollowupQueue(key, settings);
	const recentMessageIdKey = dedupeMode !== "none" ? buildRecentMessageIdKey(run, key) : void 0;
	if (recentMessageIdKey && RECENT_QUEUE_MESSAGE_IDS.peek(recentMessageIdKey)) return false;
	const dedupe = dedupeMode === "none" ? void 0 : (item, items) => isRunAlreadyQueued(item, items, dedupeMode === "prompt");
	if (shouldSkipQueueItem({
		item: run,
		items: queue.items,
		dedupe
	})) return false;
	queue.lastEnqueuedAt = Date.now();
	queue.lastRun = run.run;
	const shouldEnqueue = applyQueueDropPolicy({
		queue,
		summarize: (item) => normalizeOptionalString(item.summaryLine) || item.prompt.trim(),
		onDrop: (dropped) => {
			if (queue.dropPolicy === "summarize") {
				queue.summarySources.push(...dropped);
				return;
			}
			for (const item of dropped) completeFollowupRunLifecycle(item);
		}
	});
	if (queue.dropPolicy === "summarize") {
		const overflow = queue.summarySources.length - queue.summaryLines.length;
		if (overflow > 0) {
			const removed = queue.summarySources.splice(0, overflow);
			for (const item of removed) completeFollowupRunLifecycle(item);
		}
	}
	if (!shouldEnqueue) return false;
	queue.items.push(run);
	markFollowupRunEnqueued(run);
	if (recentMessageIdKey) RECENT_QUEUE_MESSAGE_IDS.check(recentMessageIdKey);
	if (runFollowup) rememberFollowupDrainCallback(key, runFollowup);
	if (restartIfIdle && !queue.draining) kickFollowupDrainIfIdle(key);
	return true;
}
function getFollowupQueueDepth(key) {
	const queue = getExistingFollowupQueue(key);
	if (!queue) return 0;
	return queue.items.length;
}
//#endregion
//#region src/auto-reply/reply/queue/settings.ts
function defaultQueueModeForChannel(_channel) {
	return "steer";
}
/** Resolve per-channel debounce override from debounceMsByChannel map. */
function resolveChannelDebounce(byChannel, channelKey) {
	if (!channelKey || !byChannel) return;
	const value = byChannel[channelKey];
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : void 0;
}
function resolveQueueSettings$1(params) {
	const channelKey = normalizeOptionalLowercaseString(params.channel);
	const queueCfg = params.cfg.messages?.queue;
	const providerModeRaw = channelKey && queueCfg?.byChannel ? queueCfg.byChannel[channelKey] : void 0;
	const resolvedMode = params.inlineMode ?? normalizePersistedQueueMode(params.sessionEntry?.queueMode) ?? normalizeQueueMode(providerModeRaw) ?? normalizeQueueMode(queueCfg?.mode) ?? defaultQueueModeForChannel(channelKey);
	const debounceRaw = params.inlineOptions?.debounceMs ?? params.sessionEntry?.queueDebounceMs ?? resolveChannelDebounce(queueCfg?.debounceMsByChannel, channelKey) ?? params.pluginDebounceMs ?? queueCfg?.debounceMs ?? 500;
	const capRaw = params.inlineOptions?.cap ?? params.sessionEntry?.queueCap ?? queueCfg?.cap ?? 20;
	const dropRaw = params.inlineOptions?.dropPolicy ?? params.sessionEntry?.queueDrop ?? normalizeQueueDropPolicy(queueCfg?.drop) ?? "summarize";
	return {
		mode: resolvedMode,
		debounceMs: typeof debounceRaw === "number" ? Math.max(0, debounceRaw) : void 0,
		cap: typeof capRaw === "number" ? Math.max(1, Math.floor(capRaw)) : void 0,
		dropPolicy: dropRaw
	};
}
//#endregion
//#region src/auto-reply/reply/queue/settings-runtime.ts
function resolvePluginDebounce(channelKey) {
	if (!channelKey) return;
	const value = getChannelPlugin(channelKey)?.defaults?.queue?.debounceMs;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : void 0;
}
function resolveQueueSettings(params) {
	const channelKey = normalizeOptionalLowercaseString(params.channel);
	return resolveQueueSettings$1({
		...params,
		pluginDebounceMs: params.pluginDebounceMs ?? resolvePluginDebounce(channelKey)
	});
}
//#endregion
export { clearSessionQueues as a, completeFollowupRunLifecycle as c, getFollowupQueueDepth as i, isFollowupRunAborted as l, resolveQueueSettings$1 as n, scheduleFollowupDrain as o, enqueueFollowupRun as r, refreshQueuedFollowupSession as s, resolveQueueSettings as t };
