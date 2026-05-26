import { c as normalizeOptionalString, u as normalizeOptionalThreadValue } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { n as resolveAgentMainSessionKey } from "./main-session-D3q_5w0B.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { i as readSessionEntry } from "./store-load-z4thf6ld.js";
import { t as getLoadedChannelPluginForRead } from "./registry-loaded-read-DQJDORLt.js";
import { o as normalizeTargetForProvider, t as maybeResolveIdLikeTarget } from "./target-id-resolution-DVSHqxJ3.js";
import { l as resolveCronStoredDeliveryContext, n as assertSafeCronSessionTargetId, t as normalizeHttpWebhookUrl } from "./webhook-url-CYBYCR4B.js";
import { i as parseAbsoluteTimeMs, n as resolveCronStaggerMs, r as resolveDefaultCronStaggerMs, t as normalizeCronStaggerMs } from "./stagger-Bn6ApiDa.js";
import { i as normalizeRequiredName, n as normalizeOptionalAgentId, r as normalizePayloadToSystemText } from "./normalize-CV8XB8wE.js";
import { n as resolveOutboundTargetWithPlugin, t as resolveSessionDeliveryTarget } from "./targets-session-B-pkKm7E.js";
import { t as parseExplicitTargetForLoadedChannel } from "./target-parsing-loaded-iZGz63Hr.js";
import { n as computeNextRunAtMs, r as computePreviousRunAtMs, t as coerceFiniteScheduleNumber } from "./schedule-xgcX1vdP.js";
import { t as resolveCronAgentSessionKey } from "./session-key-D_ijetg2.js";
import crypto from "node:crypto";
//#region src/infra/outbound/targets-loaded.ts
function resolveLoadedOutboundChannelPlugin(channel) {
	const normalized = normalizeOptionalString(channel);
	if (!normalized) return;
	return getLoadedChannelPluginForRead(normalized);
}
function tryResolveLoadedOutboundTarget(params) {
	return resolveOutboundTargetWithPlugin({
		plugin: resolveLoadedOutboundChannelPlugin(params.channel),
		target: params
	});
}
//#endregion
//#region src/cron/isolated-agent/delivery-target.ts
const targetsRuntimeLoader = createLazyImportLoader(() => import("./targets.runtime.js"));
async function loadTargetsRuntime() {
	return await targetsRuntimeLoader.load();
}
async function resolveOutboundTargetWithRuntime(params) {
	try {
		const loaded = tryResolveLoadedOutboundTarget(params);
		if (loaded) return loaded;
		const { resolveOutboundTarget } = await loadTargetsRuntime();
		return resolveOutboundTarget({
			...params,
			allowBootstrap: true
		});
	} catch (err) {
		return {
			ok: false,
			error: /* @__PURE__ */ new Error(`Invalid delivery target: ${formatErrorMessage(err)}`)
		};
	}
}
function normalizeTargetForThreadCarry(channel, to) {
	if (!channel || !to) return;
	try {
		const comparable = normalizeTargetForProvider(channel, to) ?? to.trim();
		if (!comparable) return;
		const base = parseExplicitTargetForLoadedChannel(channel, comparable)?.to ?? comparable;
		return normalizeTargetForProvider(channel, base) ?? base;
	} catch {
		return;
	}
}
function deliveryTargetsShareThreadRoute(params) {
	if (!params.to || !params.lastTo) return false;
	if (params.to === params.lastTo) return true;
	const normalizedTo = normalizeTargetForThreadCarry(params.channel, params.to);
	const normalizedLastTo = normalizeTargetForThreadCarry(params.channel, params.lastTo);
	return Boolean(normalizedTo && normalizedLastTo && normalizedTo === normalizedLastTo);
}
const channelSelectionRuntimeLoader = createLazyImportLoader(() => import("./channel-selection.runtime.js"));
const deliveryTargetRuntimeLoader = createLazyImportLoader(() => import("./delivery-target.runtime.js"));
async function loadChannelSelectionRuntime() {
	return await channelSelectionRuntimeLoader.load();
}
async function loadDeliveryTargetRuntime() {
	return await deliveryTargetRuntimeLoader.load();
}
async function resolveDeliveryTarget(cfg, agentId, jobPayload, options) {
	const requestedChannel = typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
	const explicitTo = typeof jobPayload.to === "string" ? jobPayload.to : void 0;
	const allowMismatchedLastTo = requestedChannel === "last";
	const sessionCfg = cfg.session;
	const mainSessionKey = resolveAgentMainSessionKey({
		cfg,
		agentId
	});
	const storePath = resolveStorePath(sessionCfg?.store, { agentId });
	const rawSessionKey = jobPayload.sessionKey?.trim();
	const threadSessionKey = rawSessionKey ? resolveCronAgentSessionKey({
		sessionKey: rawSessionKey,
		agentId,
		mainKey: cfg.session?.mainKey,
		cfg
	}) : void 0;
	const storedDeliveryContext = resolveCronStoredDeliveryContext({
		cfg,
		sessionKey: threadSessionKey
	});
	const storedDeliveryEntry = storedDeliveryContext ? {
		sessionId: threadSessionKey ?? mainSessionKey,
		updatedAt: 0,
		deliveryContext: storedDeliveryContext
	} : void 0;
	const threadEntry = threadSessionKey ? readSessionEntry(storePath, threadSessionKey) : void 0;
	const mainEntry = readSessionEntry(storePath, mainSessionKey);
	const main = storedDeliveryEntry ?? threadEntry ?? mainEntry;
	const preliminary = resolveSessionDeliveryTarget({
		entry: main,
		requestedChannel,
		explicitTo,
		explicitThreadId: jobPayload.threadId,
		allowMismatchedLastTo
	});
	let fallbackChannel;
	let channelResolutionError;
	if (!preliminary.channel) if (preliminary.lastChannel) fallbackChannel = preliminary.lastChannel;
	else try {
		const { resolveMessageChannelSelection } = await loadChannelSelectionRuntime();
		fallbackChannel = (await resolveMessageChannelSelection({ cfg })).channel;
	} catch (err) {
		const detail = formatErrorMessage(err);
		channelResolutionError = /* @__PURE__ */ new Error(`${detail} Set delivery.channel explicitly or use a main session with a previous channel.`);
	}
	const resolved = fallbackChannel ? resolveSessionDeliveryTarget({
		entry: main,
		requestedChannel,
		explicitTo,
		explicitThreadId: jobPayload.threadId,
		fallbackChannel,
		allowMismatchedLastTo,
		mode: preliminary.mode
	}) : preliminary;
	const channel = resolved.channel ?? fallbackChannel;
	const mode = resolved.mode;
	let toCandidate = resolved.to;
	let accountId = (typeof jobPayload.accountId === "string" && jobPayload.accountId.trim() ? jobPayload.accountId.trim() : void 0) ?? resolved.accountId;
	if (!accountId && channel) {
		const { resolveFirstBoundAccountId } = await loadDeliveryTargetRuntime();
		accountId = resolveFirstBoundAccountId({
			cfg,
			channelId: channel,
			agentId
		});
	}
	if (jobPayload.accountId) accountId = jobPayload.accountId;
	let threadId = resolved.threadId && (resolved.threadIdExplicit || deliveryTargetsShareThreadRoute({
		channel,
		to: resolved.to,
		lastTo: resolved.lastTo
	})) ? resolved.threadId : void 0;
	if (channel === "telegram" && typeof toCandidate === "string") {
		const topicMatch = toCandidate.match(/:topic:(\d+)$/i);
		if (topicMatch) {
			if (jobPayload.threadId == null || jobPayload.threadId === "") threadId = Number(topicMatch[1]);
			toCandidate = toCandidate.replace(/:topic:\d+$/i, "");
		}
	}
	if (!channel) return {
		ok: false,
		channel: void 0,
		to: void 0,
		accountId,
		threadId,
		mode,
		error: channelResolutionError ?? /* @__PURE__ */ new Error("Channel is required when delivery.channel=last has no previous channel.")
	};
	let effectiveAllowFrom;
	if (mode === "implicit") {
		const { getLoadedChannelPluginForRead, mapAllowFromEntries } = await loadDeliveryTargetRuntime();
		const channelPlugin = getLoadedChannelPluginForRead(channel);
		const resolvedAccountId = normalizeAccountId(accountId);
		const configuredAllowFromRaw = channelPlugin?.config.resolveAllowFrom?.({
			cfg,
			accountId: resolvedAccountId
		});
		const configuredAllowFrom = configuredAllowFromRaw ? mapAllowFromEntries(configuredAllowFromRaw) : [];
		const allowFromOverride = [...new Set(configuredAllowFrom)];
		effectiveAllowFrom = allowFromOverride;
		if (toCandidate && allowFromOverride.length > 0) {
			if (!(await resolveOutboundTargetWithRuntime({
				channel,
				to: toCandidate,
				cfg,
				accountId,
				mode,
				allowFrom: effectiveAllowFrom
			})).ok) toCandidate = allowFromOverride[0];
		}
	}
	const docked = await resolveOutboundTargetWithRuntime({
		channel,
		to: toCandidate,
		cfg,
		accountId,
		mode,
		allowFrom: effectiveAllowFrom
	});
	if (!docked.ok) return {
		ok: false,
		channel,
		to: void 0,
		accountId,
		threadId,
		mode,
		error: docked.error
	};
	if (options?.dryRun) return {
		ok: true,
		channel,
		to: docked.to,
		accountId,
		threadId,
		mode
	};
	return {
		ok: true,
		channel,
		to: (await maybeResolveIdLikeTarget({
			cfg,
			channel,
			input: docked.to,
			accountId
		}))?.to ?? docked.to,
		accountId,
		threadId,
		mode
	};
}
//#endregion
//#region src/cron/service/initial-delivery.ts
function resolveInitialCronDelivery(input) {
	if (input.delivery) return input.delivery;
	if (input.sessionTarget === "isolated" && input.payload.kind === "agentTurn") return { mode: "announce" };
}
//#endregion
//#region src/cron/service/jobs.ts
const STUCK_RUN_MS = 7200 * 1e3;
const STAGGER_OFFSET_CACHE_MAX = 4096;
const staggerOffsetCache = /* @__PURE__ */ new Map();
const DEFAULT_ERROR_BACKOFF_SCHEDULE_MS = [
	3e4,
	6e4,
	5 * 6e4,
	15 * 6e4,
	60 * 6e4
];
function isFiniteTimestamp(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function hasScheduledNextRunAtMs(value) {
	return isFiniteTimestamp(value) && value > 0;
}
function errorBackoffMs(consecutiveErrors, scheduleMs = DEFAULT_ERROR_BACKOFF_SCHEDULE_MS) {
	const idx = Math.min(consecutiveErrors - 1, scheduleMs.length - 1);
	return scheduleMs[Math.max(0, idx)] ?? DEFAULT_ERROR_BACKOFF_SCHEDULE_MS[0];
}
function resolveStableCronOffsetMs(jobId, staggerMs) {
	if (staggerMs <= 1) return 0;
	const cacheKey = `${staggerMs}:${jobId}`;
	const cached = staggerOffsetCache.get(cacheKey);
	if (cached !== void 0) return cached;
	const offset = crypto.createHash("sha256").update(jobId).digest().readUInt32BE(0) % staggerMs;
	if (staggerOffsetCache.size >= STAGGER_OFFSET_CACHE_MAX) {
		const first = staggerOffsetCache.keys().next();
		if (!first.done) staggerOffsetCache.delete(first.value);
	}
	staggerOffsetCache.set(cacheKey, offset);
	return offset;
}
function computeStaggeredCronNextRunAtMs(job, nowMs) {
	if (job.schedule.kind !== "cron") return computeNextRunAtMs(job.schedule, nowMs);
	const staggerMs = resolveCronStaggerMs(job.schedule);
	const offsetMs = resolveStableCronOffsetMs(job.id, staggerMs);
	if (offsetMs <= 0) return computeNextRunAtMs(job.schedule, nowMs);
	let cursorMs = Math.max(0, nowMs - offsetMs);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const baseNext = computeNextRunAtMs(job.schedule, cursorMs);
		if (baseNext === void 0) return;
		const shifted = baseNext + offsetMs;
		if (shifted > nowMs) return shifted;
		cursorMs = Math.max(cursorMs + 1, baseNext + 1e3);
	}
}
function computeStaggeredCronPreviousRunAtMs(job, nowMs) {
	if (job.schedule.kind !== "cron") return;
	const staggerMs = resolveCronStaggerMs(job.schedule);
	const offsetMs = resolveStableCronOffsetMs(job.id, staggerMs);
	if (offsetMs <= 0) return computePreviousRunAtMs(job.schedule, nowMs);
	let cursorMs = Math.max(0, nowMs - offsetMs);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const basePrevious = computePreviousRunAtMs(job.schedule, cursorMs);
		if (basePrevious === void 0) return;
		const shifted = basePrevious + offsetMs;
		if (shifted <= nowMs) return shifted;
		cursorMs = Math.max(0, basePrevious - 1e3);
	}
}
function isStaggeredCronRunAtMs(job, runAtMs) {
	if (job.schedule.kind !== "cron" || !isFiniteTimestamp(runAtMs)) return false;
	return computeStaggeredCronPreviousRunAtMs(job, runAtMs + 1) === runAtMs;
}
function isPendingErrorBackoffSlot(params) {
	const { state, job, nextRunAtMs, nowMs } = params;
	if (job.state.lastStatus !== "error" || !isFiniteTimestamp(job.state.lastRunAtMs)) return false;
	const consecutiveErrorsRaw = job.state.consecutiveErrors;
	const consecutiveErrors = typeof consecutiveErrorsRaw === "number" && Number.isFinite(consecutiveErrorsRaw) ? Math.max(1, Math.floor(consecutiveErrorsRaw)) : 1;
	const lastDurationMs = typeof job.state.lastDurationMs === "number" && Number.isFinite(job.state.lastDurationMs) ? Math.max(0, Math.floor(job.state.lastDurationMs)) : 0;
	const backoffFloor = job.state.lastRunAtMs + lastDurationMs + errorBackoffMs(consecutiveErrors, state.deps.cronConfig?.retry?.backoffMs ?? DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
	return nowMs < backoffFloor && nextRunAtMs <= backoffFloor;
}
function shouldRepairFutureCronNextRunAtMs(params) {
	const { state, job, nowMs } = params;
	const nextRun = job.state.nextRunAtMs;
	if (job.schedule.kind !== "cron" || !hasScheduledNextRunAtMs(nextRun) || nowMs >= nextRun || typeof job.state.runningAtMs === "number") return false;
	if (isPendingErrorBackoffSlot({
		state,
		job,
		nextRunAtMs: nextRun,
		nowMs
	})) return false;
	let naturalNext;
	try {
		naturalNext = computeStaggeredCronNextRunAtMs(job, nowMs);
	} catch {
		return false;
	}
	if (!isFiniteTimestamp(naturalNext)) return false;
	let isScheduledSlot = false;
	try {
		isScheduledSlot = isStaggeredCronRunAtMs(job, nextRun);
	} catch {
		return false;
	}
	if (isScheduledSlot) return false;
	if (nextRun < naturalNext) return job.payload.kind !== "agentTurn";
	if (nextRun === naturalNext) return false;
	let followingNaturalNext;
	try {
		followingNaturalNext = computeStaggeredCronNextRunAtMs(job, naturalNext);
	} catch {
		return false;
	}
	if (!isFiniteTimestamp(followingNaturalNext)) return false;
	const naturalIntervalMs = followingNaturalNext - naturalNext;
	return naturalIntervalMs > 0 && nextRun >= followingNaturalNext + naturalIntervalMs;
}
function resolveEveryAnchorMs(params) {
	const coerced = coerceFiniteScheduleNumber(params.schedule.anchorMs);
	if (coerced !== void 0) return Math.max(0, Math.floor(coerced));
	if (isFiniteTimestamp(params.fallbackAnchorMs)) return Math.max(0, Math.floor(params.fallbackAnchorMs));
	return 0;
}
function assertSupportedJobSpec(job) {
	if (typeof job.sessionTarget !== "string") throw new Error("cron job is missing sessionTarget; expected \"main\", \"isolated\", \"current\", or \"session:<id>\"");
	const isIsolatedLike = job.sessionTarget === "isolated" || job.sessionTarget === "current" || job.sessionTarget.startsWith("session:");
	if (job.sessionTarget.startsWith("session:")) assertSafeCronSessionTargetId(job.sessionTarget.slice(8));
	if (job.sessionTarget === "main" && job.payload.kind !== "systemEvent") throw new Error("main cron jobs require payload.kind=\"systemEvent\"");
	if (isIsolatedLike && job.payload.kind !== "agentTurn") throw new Error("isolated/current/session cron jobs require payload.kind=\"agentTurn\"");
}
function assertMainSessionAgentId(job, defaultAgentId) {
	if (job.sessionTarget !== "main") return;
	if (!job.agentId) return;
	if (normalizeAgentId(job.agentId) !== normalizeAgentId(defaultAgentId)) throw new Error(`cron: sessionTarget "main" is only valid for the default agent. Use sessionTarget "isolated" with payload.kind "agentTurn" for non-default agents (agentId: ${job.agentId})`);
}
function assertDeliverySupport(job) {
	if (!job.delivery || job.delivery.mode === "none") return;
	if (job.delivery.mode === "webhook") {
		const target = normalizeHttpWebhookUrl(job.delivery.to);
		if (!target) throw new Error("cron webhook delivery requires delivery.to to be a valid http(s) URL");
		job.delivery.to = target;
		return;
	}
	if (!(job.sessionTarget === "isolated" || job.sessionTarget === "current" || job.sessionTarget.startsWith("session:"))) throw new Error("cron channel delivery config is only supported for sessionTarget=\"isolated\"");
}
function assertFailureDestinationSupport(job) {
	const failureDestination = job.delivery?.failureDestination;
	if (!failureDestination) return;
	if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook") throw new Error("cron delivery.failureDestination is only supported for sessionTarget=\"isolated\" unless delivery.mode=\"webhook\"");
	if (failureDestination.mode === "webhook") {
		const target = normalizeHttpWebhookUrl(failureDestination.to);
		if (!target) throw new Error("cron failure destination webhook requires delivery.failureDestination.to to be a valid http(s) URL");
		failureDestination.to = target;
	}
}
function findJobOrThrow(state, id) {
	const job = state.store?.jobs.find((j) => j.id === id);
	if (!job) throw new Error(`unknown cron job id: ${id}`);
	return job;
}
function isJobEnabled(job) {
	return job.enabled ?? true;
}
function computeJobNextRunAtMs(job, nowMs) {
	if (!isJobEnabled(job)) return;
	if (job.schedule.kind === "every") {
		const everyMsRaw = coerceFiniteScheduleNumber(job.schedule.everyMs);
		if (everyMsRaw === void 0) return;
		const everyMs = Math.max(1, Math.floor(everyMsRaw));
		const lastRunAtMs = job.state.lastRunAtMs;
		if (typeof lastRunAtMs === "number" && Number.isFinite(lastRunAtMs)) {
			const nextFromLastRun = Math.floor(lastRunAtMs) + everyMs;
			if (nextFromLastRun > nowMs) return nextFromLastRun;
		}
		const fallbackAnchorMs = isFiniteTimestamp(job.createdAtMs) ? job.createdAtMs : nowMs;
		const anchorMs = resolveEveryAnchorMs({
			schedule: job.schedule,
			fallbackAnchorMs
		});
		const next = computeNextRunAtMs({
			...job.schedule,
			everyMs,
			anchorMs
		}, nowMs);
		return isFiniteTimestamp(next) ? next : void 0;
	}
	if (job.schedule.kind === "at") {
		const schedule = job.schedule;
		const atMs = typeof schedule.atMs === "number" && Number.isFinite(schedule.atMs) && schedule.atMs > 0 ? schedule.atMs : typeof schedule.atMs === "string" ? parseAbsoluteTimeMs(schedule.atMs) : typeof schedule.at === "string" ? parseAbsoluteTimeMs(schedule.at) : null;
		if (job.state.lastStatus === "ok" && job.state.lastRunAtMs) {
			if (atMs !== null && Number.isFinite(atMs) && atMs > job.state.lastRunAtMs) return atMs;
			return;
		}
		return atMs !== null && Number.isFinite(atMs) ? atMs : void 0;
	}
	const next = computeStaggeredCronNextRunAtMs(job, nowMs);
	if (next === void 0 && job.schedule.kind === "cron") return computeStaggeredCronNextRunAtMs(job, Math.floor(nowMs / 1e3) * 1e3 + 1e3);
	return isFiniteTimestamp(next) ? next : void 0;
}
function computeJobPreviousRunAtMs(job, nowMs) {
	if (!isJobEnabled(job) || job.schedule.kind !== "cron") return;
	const previous = computeStaggeredCronPreviousRunAtMs(job, nowMs);
	return isFiniteTimestamp(previous) ? previous : void 0;
}
/** Maximum consecutive schedule errors before auto-disabling a job. */
const MAX_SCHEDULE_ERRORS = 3;
function recordScheduleComputeError(params) {
	const { state, job, err } = params;
	const errorCount = (job.state.scheduleErrorCount ?? 0) + 1;
	const errText = String(err);
	job.state.scheduleErrorCount = errorCount;
	job.state.nextRunAtMs = void 0;
	job.state.lastError = `schedule error: ${errText}`;
	if (errorCount >= MAX_SCHEDULE_ERRORS) {
		job.enabled = false;
		state.deps.log.error({
			jobId: job.id,
			name: job.name,
			errorCount,
			err: errText
		}, "cron: auto-disabled job after repeated schedule errors");
		const notifyText = `⚠️ Cron job "${job.name}" has been auto-disabled after ${errorCount} consecutive schedule errors. Last error: ${errText}`;
		state.deps.enqueueSystemEvent(notifyText, {
			agentId: job.agentId,
			sessionKey: job.sessionKey,
			contextKey: `cron:${job.id}:auto-disabled`
		});
		state.deps.requestHeartbeat({
			source: "cron",
			intent: "event",
			reason: `cron:${job.id}:auto-disabled`,
			agentId: job.agentId,
			sessionKey: job.sessionKey
		});
	} else state.deps.log.warn({
		jobId: job.id,
		name: job.name,
		errorCount,
		err: errText
	}, "cron: failed to compute next run for job (skipping)");
	return true;
}
function normalizeJobTickState(params) {
	const { state, job, nowMs } = params;
	let changed = false;
	if (!job.state) {
		job.state = {};
		changed = true;
	}
	if (job.schedule.kind === "every") {
		const normalizedAnchorMs = resolveEveryAnchorMs({
			schedule: job.schedule,
			fallbackAnchorMs: isFiniteTimestamp(job.createdAtMs) ? job.createdAtMs : nowMs
		});
		if (job.schedule.anchorMs !== normalizedAnchorMs) {
			job.schedule = {
				...job.schedule,
				anchorMs: normalizedAnchorMs
			};
			changed = true;
		}
	}
	if (!isJobEnabled(job)) {
		if (job.state.nextRunAtMs !== void 0) {
			job.state.nextRunAtMs = void 0;
			changed = true;
		}
		if (job.state.runningAtMs !== void 0) {
			job.state.runningAtMs = void 0;
			changed = true;
		}
		return {
			changed,
			skip: true
		};
	}
	if (!hasScheduledNextRunAtMs(job.state.nextRunAtMs) && job.state.nextRunAtMs !== void 0) {
		job.state.nextRunAtMs = void 0;
		changed = true;
	}
	const runningAt = job.state.runningAtMs;
	if (typeof runningAt === "number" && nowMs - runningAt > STUCK_RUN_MS) {
		state.deps.log.warn({
			jobId: job.id,
			runningAtMs: runningAt
		}, "cron: clearing stuck running marker");
		job.state.runningAtMs = void 0;
		changed = true;
		const nextRun = job.state.nextRunAtMs;
		const lastRun = job.state.lastRunAtMs;
		const alreadyExecutedSlot = hasScheduledNextRunAtMs(nextRun) && isFiniteTimestamp(lastRun) && lastRun >= nextRun;
		return {
			changed,
			skip: !alreadyExecutedSlot
		};
	}
	return {
		changed,
		skip: false
	};
}
function walkSchedulableJobs(state, fn, nowMs = state.deps.nowMs()) {
	if (!state.store) return false;
	let changed = false;
	for (const job of state.store.jobs) {
		const tick = normalizeJobTickState({
			state,
			job,
			nowMs
		});
		if (tick.changed) changed = true;
		if (tick.skip) continue;
		if (fn({
			job,
			nowMs
		})) changed = true;
	}
	return changed;
}
function recomputeJobNextRunAtMs(params) {
	let changed = false;
	try {
		let newNext = computeJobNextRunAtMs(params.job, params.nowMs);
		if (params.job.schedule.kind !== "at" && params.job.state.lastStatus === "error" && isFiniteTimestamp(params.job.state.lastRunAtMs)) {
			const consecutiveErrorsRaw = params.job.state.consecutiveErrors;
			const consecutiveErrors = typeof consecutiveErrorsRaw === "number" && Number.isFinite(consecutiveErrorsRaw) ? Math.max(1, Math.floor(consecutiveErrorsRaw)) : 1;
			const backoffFloor = params.job.state.lastRunAtMs + errorBackoffMs(consecutiveErrors, params.state.deps.cronConfig?.retry?.backoffMs ?? DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
			if (newNext !== void 0) newNext = Math.max(newNext, backoffFloor);
		}
		if (params.job.state.nextRunAtMs !== newNext) {
			params.job.state.nextRunAtMs = newNext;
			changed = true;
		}
		if (params.job.state.scheduleErrorCount) {
			params.job.state.scheduleErrorCount = void 0;
			changed = true;
		}
	} catch (err) {
		if (recordScheduleComputeError({
			state: params.state,
			job: params.job,
			err
		})) changed = true;
	}
	return changed;
}
function recomputeNextRuns(state) {
	return walkSchedulableJobs(state, ({ job, nowMs: now }) => {
		let changed = false;
		const nextRun = job.state.nextRunAtMs;
		if (!hasScheduledNextRunAtMs(nextRun) || now >= nextRun || shouldRepairFutureCronNextRunAtMs({
			state,
			job,
			nowMs: now
		})) {
			if (recomputeJobNextRunAtMs({
				state,
				job,
				nowMs: now
			})) changed = true;
		}
		return changed;
	});
}
/**
* Maintenance-only version of recomputeNextRuns that handles disabled jobs
* and stuck markers, but does NOT recompute nextRunAtMs for enabled jobs
* with existing values. Used during timer ticks when no due jobs were found
* to prevent silently advancing past-due nextRunAtMs values without execution
* (see #13992).
*/
function recomputeNextRunsForMaintenance(state, opts) {
	const recomputeExpired = opts?.recomputeExpired ?? false;
	const repairFutureCronNextRunAtMs = opts?.repairFutureCronNextRunAtMs ?? true;
	return walkSchedulableJobs(state, ({ job, nowMs: now }) => {
		let changed = false;
		if (!hasScheduledNextRunAtMs(job.state.nextRunAtMs)) {
			if (recomputeJobNextRunAtMs({
				state,
				job,
				nowMs: now
			})) changed = true;
		} else if (repairFutureCronNextRunAtMs && shouldRepairFutureCronNextRunAtMs({
			state,
			job,
			nowMs: now
		})) {
			if (recomputeJobNextRunAtMs({
				state,
				job,
				nowMs: now
			})) changed = true;
		} else if (recomputeExpired && now >= job.state.nextRunAtMs && typeof job.state.runningAtMs !== "number") {
			const lastRun = job.state.lastRunAtMs;
			if (isFiniteTimestamp(lastRun) && lastRun >= job.state.nextRunAtMs) {
				if (recomputeJobNextRunAtMs({
					state,
					job,
					nowMs: now
				})) changed = true;
			}
		}
		return changed;
	}, opts?.nowMs);
}
function nextWakeAtMs(state) {
	const enabled = (state.store?.jobs ?? []).filter((j) => j.enabled && hasScheduledNextRunAtMs(j.state.nextRunAtMs));
	if (enabled.length === 0) return;
	const first = enabled[0]?.state.nextRunAtMs;
	if (!hasScheduledNextRunAtMs(first)) return;
	return enabled.reduce((min, j) => {
		const next = j.state.nextRunAtMs;
		return hasScheduledNextRunAtMs(next) ? Math.min(min, next) : min;
	}, first);
}
function createJob(state, input) {
	const now = state.deps.nowMs();
	const id = crypto.randomUUID();
	const schedule = input.schedule.kind === "every" ? {
		...input.schedule,
		anchorMs: resolveEveryAnchorMs({
			schedule: input.schedule,
			fallbackAnchorMs: now
		})
	} : input.schedule.kind === "cron" ? (() => {
		const explicitStaggerMs = normalizeCronStaggerMs(input.schedule.staggerMs);
		if (explicitStaggerMs !== void 0) return {
			...input.schedule,
			staggerMs: explicitStaggerMs
		};
		const defaultStaggerMs = resolveDefaultCronStaggerMs(input.schedule.expr);
		return defaultStaggerMs !== void 0 ? {
			...input.schedule,
			staggerMs: defaultStaggerMs
		} : input.schedule;
	})() : input.schedule;
	const deleteAfterRun = typeof input.deleteAfterRun === "boolean" ? input.deleteAfterRun : schedule.kind === "at" ? true : void 0;
	const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
	const job = {
		id,
		agentId: normalizeOptionalAgentId(input.agentId),
		sessionKey: normalizeOptionalString(input.sessionKey),
		name: normalizeRequiredName(input.name),
		description: normalizeOptionalString(input.description),
		enabled,
		deleteAfterRun,
		createdAtMs: now,
		updatedAtMs: now,
		schedule,
		sessionTarget: input.sessionTarget,
		wakeMode: input.wakeMode,
		payload: input.payload,
		delivery: resolveInitialCronDelivery(input),
		failureAlert: input.failureAlert,
		state: { ...input.state }
	};
	assertSupportedJobSpec(job);
	assertMainSessionAgentId(job, state.deps.defaultAgentId);
	assertDeliverySupport(job);
	assertFailureDestinationSupport(job);
	job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
	return job;
}
function applyJobPatch(job, patch, opts) {
	if ("name" in patch) job.name = normalizeRequiredName(patch.name);
	if ("description" in patch) job.description = normalizeOptionalString(patch.description);
	if (typeof patch.enabled === "boolean") job.enabled = patch.enabled;
	if (typeof patch.deleteAfterRun === "boolean") job.deleteAfterRun = patch.deleteAfterRun;
	if (patch.schedule) if (patch.schedule.kind === "cron") {
		const explicitStaggerMs = normalizeCronStaggerMs(patch.schedule.staggerMs);
		if (explicitStaggerMs !== void 0) job.schedule = {
			...patch.schedule,
			staggerMs: explicitStaggerMs
		};
		else if (job.schedule.kind === "cron") job.schedule = {
			...patch.schedule,
			staggerMs: job.schedule.staggerMs
		};
		else {
			const defaultStaggerMs = resolveDefaultCronStaggerMs(patch.schedule.expr);
			job.schedule = defaultStaggerMs !== void 0 ? {
				...patch.schedule,
				staggerMs: defaultStaggerMs
			} : patch.schedule;
		}
	} else job.schedule = patch.schedule;
	if (patch.sessionTarget) job.sessionTarget = patch.sessionTarget;
	if (patch.wakeMode) job.wakeMode = patch.wakeMode;
	if (patch.payload) job.payload = mergeCronPayload(job.payload, patch.payload);
	if (patch.delivery) job.delivery = mergeCronDelivery(job.delivery, patch.delivery);
	if ("failureAlert" in patch) job.failureAlert = mergeCronFailureAlert(job.failureAlert, patch.failureAlert);
	if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook" && job.delivery?.failureDestination) throw new Error("cron delivery.failureDestination is only supported for sessionTarget=\"isolated\" unless delivery.mode=\"webhook\"");
	if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook") job.delivery = void 0;
	if (patch.state) job.state = {
		...job.state,
		...patch.state
	};
	if ("agentId" in patch) job.agentId = normalizeOptionalAgentId(patch.agentId);
	if ("sessionKey" in patch) job.sessionKey = normalizeOptionalString(patch.sessionKey);
	assertSupportedJobSpec(job);
	assertMainSessionAgentId(job, opts?.defaultAgentId);
	assertDeliverySupport(job);
	assertFailureDestinationSupport(job);
}
function mergeCronPayload(existing, patch) {
	if (patch.kind !== existing.kind) return buildPayloadFromPatch(patch);
	if (patch.kind === "systemEvent") {
		if (existing.kind !== "systemEvent") return buildPayloadFromPatch(patch);
		return {
			kind: "systemEvent",
			text: typeof patch.text === "string" ? patch.text : existing.text
		};
	}
	if (existing.kind !== "agentTurn") return buildPayloadFromPatch(patch);
	const next = { ...existing };
	if (typeof patch.message === "string") next.message = patch.message;
	if (typeof patch.model === "string") next.model = patch.model;
	if (Array.isArray(patch.fallbacks)) next.fallbacks = patch.fallbacks;
	if (Array.isArray(patch.toolsAllow)) next.toolsAllow = patch.toolsAllow;
	else if (patch.toolsAllow === null) delete next.toolsAllow;
	if (typeof patch.thinking === "string") next.thinking = patch.thinking;
	if (typeof patch.timeoutSeconds === "number") next.timeoutSeconds = patch.timeoutSeconds;
	if (typeof patch.lightContext === "boolean") next.lightContext = patch.lightContext;
	if (typeof patch.allowUnsafeExternalContent === "boolean") next.allowUnsafeExternalContent = patch.allowUnsafeExternalContent;
	return next;
}
function buildPayloadFromPatch(patch) {
	if (patch.kind === "systemEvent") {
		if (typeof patch.text !== "string" || patch.text.length === 0) throw new Error("cron.update payload.kind=\"systemEvent\" requires text");
		return {
			kind: "systemEvent",
			text: patch.text
		};
	}
	if (typeof patch.message !== "string" || patch.message.length === 0) throw new Error("cron.update payload.kind=\"agentTurn\" requires message");
	return {
		kind: "agentTurn",
		message: patch.message,
		model: patch.model,
		fallbacks: patch.fallbacks,
		toolsAllow: Array.isArray(patch.toolsAllow) ? patch.toolsAllow : void 0,
		thinking: patch.thinking,
		timeoutSeconds: patch.timeoutSeconds,
		lightContext: patch.lightContext,
		allowUnsafeExternalContent: patch.allowUnsafeExternalContent
	};
}
function mergeCronDelivery(existing, patch) {
	const next = {
		mode: existing?.mode ?? "none",
		channel: existing?.channel,
		to: existing?.to,
		threadId: existing?.threadId,
		accountId: existing?.accountId,
		bestEffort: existing?.bestEffort,
		failureDestination: existing?.failureDestination
	};
	if (typeof patch.mode === "string") next.mode = patch.mode === "deliver" ? "announce" : patch.mode;
	if ("channel" in patch) next.channel = normalizeOptionalString(patch.channel);
	if ("to" in patch) next.to = normalizeOptionalString(patch.to);
	if ("threadId" in patch) next.threadId = normalizeOptionalThreadValue(patch.threadId);
	if ("accountId" in patch) next.accountId = normalizeOptionalString(patch.accountId);
	if (typeof patch.bestEffort === "boolean") next.bestEffort = patch.bestEffort;
	if ("failureDestination" in patch) if (patch.failureDestination === void 0) next.failureDestination = void 0;
	else {
		const existingFd = next.failureDestination;
		const patchFd = patch.failureDestination;
		const nextFd = {
			channel: existingFd?.channel,
			to: existingFd?.to,
			accountId: existingFd?.accountId,
			mode: existingFd?.mode
		};
		if (patchFd) {
			if ("channel" in patchFd) {
				const channel = normalizeOptionalString(patchFd.channel) ?? "";
				nextFd.channel = channel ? channel : void 0;
			}
			if ("to" in patchFd) {
				const to = normalizeOptionalString(patchFd.to) ?? "";
				nextFd.to = to ? to : void 0;
			}
			if ("accountId" in patchFd) {
				const accountId = normalizeOptionalString(patchFd.accountId) ?? "";
				nextFd.accountId = accountId ? accountId : void 0;
			}
			if ("mode" in patchFd) {
				const mode = normalizeOptionalString(patchFd.mode) ?? "";
				nextFd.mode = mode === "announce" || mode === "webhook" ? mode : void 0;
			}
		}
		next.failureDestination = nextFd;
	}
	return next;
}
function mergeCronFailureAlert(existing, patch) {
	if (patch === false) return false;
	if (patch === void 0) return existing;
	const next = { ...existing === false || existing === void 0 ? {} : existing };
	if ("after" in patch) {
		const after = typeof patch.after === "number" && Number.isFinite(patch.after) ? patch.after : 0;
		next.after = after > 0 ? Math.floor(after) : void 0;
	}
	if ("channel" in patch) next.channel = normalizeOptionalString(patch.channel);
	if ("to" in patch) next.to = normalizeOptionalString(patch.to);
	if ("cooldownMs" in patch) {
		const cooldownMs = typeof patch.cooldownMs === "number" && Number.isFinite(patch.cooldownMs) ? patch.cooldownMs : -1;
		next.cooldownMs = cooldownMs >= 0 ? Math.floor(cooldownMs) : void 0;
	}
	if ("includeSkipped" in patch) next.includeSkipped = typeof patch.includeSkipped === "boolean" ? patch.includeSkipped : void 0;
	if ("mode" in patch) {
		const mode = normalizeOptionalString(patch.mode) ?? "";
		next.mode = mode === "announce" || mode === "webhook" ? mode : void 0;
	}
	if ("accountId" in patch) {
		const accountId = normalizeOptionalString(patch.accountId) ?? "";
		next.accountId = accountId ? accountId : void 0;
	}
	return next;
}
function isJobDue(job, nowMs, opts) {
	if (!job.state) job.state = {};
	if (typeof job.state.runningAtMs === "number") return false;
	if (opts.forced) return true;
	return isJobEnabled(job) && hasScheduledNextRunAtMs(job.state.nextRunAtMs) && nowMs >= job.state.nextRunAtMs;
}
function resolveJobPayloadTextForMain(job) {
	if (job.payload.kind !== "systemEvent") return;
	const text = normalizePayloadToSystemText(job.payload);
	return text.trim() ? text : void 0;
}
//#endregion
export { resolveDeliveryTarget as _, computeJobPreviousRunAtMs as a, findJobOrThrow as c, isJobEnabled as d, nextWakeAtMs as f, resolveJobPayloadTextForMain as g, recordScheduleComputeError as h, computeJobNextRunAtMs as i, hasScheduledNextRunAtMs as l, recomputeNextRunsForMaintenance as m, applyJobPatch as n, createJob as o, recomputeNextRuns as p, assertSupportedJobSpec as r, errorBackoffMs as s, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS as t, isJobDue as u };
