import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { t as resolveGlobalMap } from "./global-singleton-B2nbp4Tq.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { n as resolveGlobalDedupeCache } from "./dedupe-Cby1DfpJ.js";
import { n as channelRouteDedupeKey, t as channelRouteCompactKey } from "./channel-route-jaZFObQA.js";
import { t as getChannelPlugin } from "./registry-BdfZSqhE2.js";
import "./plugins-YTdL-Pji.js";
import { r as clearCommandLane } from "./command-queue-DB7xEnvP.js";
import { n as normalizeQueueDropPolicy, r as normalizeQueueMode } from "./directive-LORhZ93v.js";
import { t as resolveEmbeddedSessionLane } from "./lanes-BQ7rTa0w.js";
import { a as clearQueueSummaryState, c as hasCrossChannelItems, d as waitForQueueDebounce, i as buildCollectPrompt, l as previewQueueSummaryPrompt, n as applyQueueRuntimeSettings, o as drainCollectQueueStep, r as beginQueueDrain, s as drainNextQueueItem, t as applyQueueDropPolicy, u as shouldSkipQueueItem } from "./queue-helpers-DHvHrahl.js";
import { t as isRoutableChannel } from "./route-reply-CnKBhB8X.js";
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
		summaryLines: []
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
	queue.items.length = 0;
	queue.droppedCount = 0;
	queue.summaryLines = [];
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
	const shouldRewriteSelection = typeof params.nextProvider === "string" || typeof params.nextModel === "string" || Object.hasOwn(params, "nextModelOverrideSource") || Object.hasOwn(params, "nextAuthProfileId") || Object.hasOwn(params, "nextAuthProfileIdSource");
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
				await waitForQueueDebounce(queue);
				if (queue.mode === "collect") {
					const collectDrainResult = await drainCollectQueueStep({
						collectState,
						isCrossChannel: hasCrossChannelItems(queue.items, resolveCrossChannelKey),
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
							await effectiveRunFollowup({
								prompt: summaryOnlyPrompt,
								run,
								enqueuedAt: Date.now(),
								...collectQueuedImages(queue.items)
							});
							clearQueueSummaryState(queue);
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
						await effectiveRunFollowup({
							prompt: summary,
							run,
							enqueuedAt: Date.now()
						});
						clearQueueSummaryState(queue);
						continue;
					}
					let pendingSummary = summary;
					for (const groupItems of authGroups) {
						const run = groupItems.at(-1)?.run ?? queue.lastRun;
						if (!run) break;
						const routing = resolveOriginRoutingMetadata(groupItems);
						await effectiveRunFollowup({
							prompt: buildCollectPrompt({
								title: "[Queued messages while agent was busy]",
								items: groupItems,
								summary: pendingSummary,
								renderItem: renderCollectItem
							}),
							run,
							enqueuedAt: Date.now(),
							...routing,
							...collectQueuedImages(groupItems)
						});
						queue.items.splice(0, groupItems.length);
						if (pendingSummary) {
							clearQueueSummaryState(queue);
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
						await effectiveRunFollowup({
							prompt: summaryPrompt,
							run,
							enqueuedAt: Date.now(),
							originatingChannel: item.originatingChannel,
							originatingTo: item.originatingTo,
							originatingAccountId: item.originatingAccountId,
							originatingThreadId: item.originatingThreadId,
							...collectQueuedImages([item])
						});
					})) break;
					clearQueueSummaryState(queue);
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
	if (!applyQueueDropPolicy({
		queue,
		summarize: (item) => normalizeOptionalString(item.summaryLine) || item.prompt.trim()
	})) return false;
	queue.items.push(run);
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
	const resolvedMode = params.inlineMode ?? normalizeQueueMode(params.sessionEntry?.queueMode) ?? normalizeQueueMode(providerModeRaw) ?? normalizeQueueMode(queueCfg?.mode) ?? defaultQueueModeForChannel(channelKey);
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
//#region src/auto-reply/reply/queue/steering.ts
function isSteeringQueueMode(mode) {
	return mode === "steer" || mode === "queue" || mode === "steer-backlog";
}
function resolvePiSteeringModeForQueueMode(mode) {
	return mode === "queue" ? "one-at-a-time" : "all";
}
//#endregion
export { enqueueFollowupRun as a, scheduleFollowupDrain as c, resolveQueueSettings$1 as i, refreshQueuedFollowupSession as l, resolvePiSteeringModeForQueueMode as n, getFollowupQueueDepth as o, resolveQueueSettings as r, clearSessionQueues as s, isSteeringQueueMode as t };
