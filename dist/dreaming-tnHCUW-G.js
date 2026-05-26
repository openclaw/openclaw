import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { B as MEMORY_DREAMING_SYSTEM_EVENT_TEXT, J as resolveMemoryDreamingWorkspaces, R as MANAGED_MEMORY_DREAMING_CRON_NAME, U as resolveMemoryCorePluginConfig, W as resolveMemoryDeepDreamingConfig, z as MANAGED_MEMORY_DREAMING_CRON_TAG } from "./dreaming-CxCxWYoC.js";
import { c as peekSystemEventEntries } from "./system-events-11EG3LzK.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./system-event-runtime-DldWy4vd.js";
import "./memory-core-host-status-CceUImkn.js";
import { c as runDetachedDreamNarrative, o as generateAndAppendDreamNarrative, r as runDreamingSweepPhases, u as writeDeepDreamingReport } from "./dreaming-phases-B7KNuvKO.js";
import { n as normalizeTrimmedString, t as includesSystemEventToken } from "./dreaming-shared-TJ4wErqZ.js";
import { a as rankShortTermPromotionCandidates, d as repairShortTermPromotionArtifacts, n as applyShortTermPromotions } from "./short-term-promotion-BpCbM_k1.js";
//#region extensions/memory-core/src/dreaming.ts
const RUNTIME_CRON_RECONCILE_INTERVAL_MS = 6e4;
const STARTUP_CRON_RETRY_DELAY_MS = 5e3;
const STARTUP_CRON_RETRY_MAX_ATTEMPTS = 12;
const HEARTBEAT_ISOLATED_SESSION_SUFFIX = ":heartbeat";
function formatRepairSummary(repair) {
	const actions = [];
	if (repair.rewroteStore) actions.push(`rewrote recall store${repair.removedInvalidEntries > 0 ? ` (-${repair.removedInvalidEntries} invalid)` : ""}`);
	if (repair.removedStaleLock) actions.push("removed stale promotion lock");
	return actions.join(", ");
}
function resolveManagedCronDescription(config) {
	const recencyHalfLifeDays = config.recencyHalfLifeDays ?? 14;
	return `${MANAGED_MEMORY_DREAMING_CRON_TAG} Promote weighted short-term recalls into MEMORY.md (limit=${config.limit}, minScore=${config.minScore.toFixed(3)}, minRecallCount=${config.minRecallCount}, minUniqueQueries=${config.minUniqueQueries}, recencyHalfLifeDays=${recencyHalfLifeDays}, maxAgeDays=${config.maxAgeDays ?? "none"}).`;
}
function buildManagedDreamingCronJob(config) {
	return {
		name: MANAGED_MEMORY_DREAMING_CRON_NAME,
		description: resolveManagedCronDescription(config),
		enabled: true,
		schedule: {
			kind: "cron",
			expr: config.cron,
			...config.timezone ? { tz: config.timezone } : {}
		},
		sessionTarget: "isolated",
		wakeMode: "now",
		payload: {
			kind: "agentTurn",
			message: MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
			lightContext: true
		},
		delivery: { mode: "none" }
	};
}
function resolveManagedDreamingPayloadToken(payload) {
	const payloadKind = normalizeLowercaseStringOrEmpty(normalizeTrimmedString(payload?.kind));
	if (payloadKind === "systemevent") return normalizeTrimmedString(payload?.text);
	if (payloadKind === "agentturn") return normalizeTrimmedString(payload?.message);
}
function isManagedDreamingJob(job) {
	if (normalizeTrimmedString(job.description)?.includes("[managed-by=memory-core.short-term-promotion]")) return true;
	const name = normalizeTrimmedString(job.name);
	const payloadToken = resolveManagedDreamingPayloadToken(job.payload);
	return name === "Memory Dreaming Promotion" && payloadToken === "__openclaw_memory_core_short_term_promotion_dream__";
}
function isLegacyPhaseDreamingJob(job) {
	const description = normalizeTrimmedString(job.description);
	if (description?.includes("[managed-by=memory-core.dreaming.light]") || description?.includes("[managed-by=memory-core.dreaming.rem]")) return true;
	const name = normalizeTrimmedString(job.name);
	const payloadText = normalizeTrimmedString(job.payload?.text);
	if (name === "Memory Light Dreaming" && payloadText === "__openclaw_memory_core_light_sleep__") return true;
	return name === "Memory REM Dreaming" && payloadText === "__openclaw_memory_core_rem_sleep__";
}
function compareOptionalStrings(a, b) {
	return a === b;
}
async function migrateLegacyPhaseDreamingCronJobs(params) {
	let migrated = 0;
	for (const job of params.legacyJobs) try {
		if ((await params.cron.remove(job.id)).removed === true) migrated += 1;
	} catch (err) {
		params.logger.warn(`memory-core: failed to migrate legacy phase dreaming cron job ${job.id}: ${formatErrorMessage(err)}`);
	}
	if (migrated > 0) if (params.mode === "enabled") params.logger.info(`memory-core: migrated ${migrated} legacy phase dreaming cron job(s) to the unified dreaming controller.`);
	else params.logger.info(`memory-core: completed legacy phase dreaming cron migration while unified dreaming is disabled (${migrated} job(s) removed).`);
	return migrated;
}
function buildManagedDreamingPatch(job, desired) {
	const patch = {};
	if (!compareOptionalStrings(normalizeTrimmedString(job.name), desired.name)) patch.name = desired.name;
	if (!compareOptionalStrings(normalizeTrimmedString(job.description), desired.description)) patch.description = desired.description;
	if (job.enabled !== true) patch.enabled = true;
	const scheduleKind = normalizeLowercaseStringOrEmpty(normalizeTrimmedString(job.schedule?.kind));
	const scheduleExpr = normalizeTrimmedString(job.schedule?.expr);
	const scheduleTz = normalizeTrimmedString(job.schedule?.tz);
	if (scheduleKind !== "cron" || !compareOptionalStrings(scheduleExpr, desired.schedule.expr) || !compareOptionalStrings(scheduleTz, desired.schedule.tz)) patch.schedule = desired.schedule;
	if (normalizeLowercaseStringOrEmpty(normalizeTrimmedString(job.sessionTarget)) !== desired.sessionTarget) patch.sessionTarget = desired.sessionTarget;
	if (normalizeLowercaseStringOrEmpty(normalizeTrimmedString(job.wakeMode)) !== "now") patch.wakeMode = "now";
	const payloadKind = normalizeLowercaseStringOrEmpty(normalizeTrimmedString(job.payload?.kind));
	const payloadToken = resolveManagedDreamingPayloadToken(job.payload);
	const desiredPayloadToken = desired.payload.kind === "systemEvent" ? desired.payload.text : desired.payload.message;
	if (payloadKind !== normalizeLowercaseStringOrEmpty(desired.payload.kind) || !compareOptionalStrings(payloadToken, desiredPayloadToken) || desired.payload.kind === "agentTurn" && job.payload?.lightContext !== desired.payload.lightContext) patch.payload = desired.payload;
	if (normalizeLowercaseStringOrEmpty(normalizeTrimmedString(job.delivery?.mode)) !== "none") patch.delivery = desired.delivery;
	return Object.keys(patch).length > 0 ? patch : null;
}
function sortManagedJobs(managed) {
	return managed.toSorted((a, b) => {
		const aCreated = typeof a.createdAtMs === "number" && Number.isFinite(a.createdAtMs) ? a.createdAtMs : Number.MAX_SAFE_INTEGER;
		const bCreated = typeof b.createdAtMs === "number" && Number.isFinite(b.createdAtMs) ? b.createdAtMs : Number.MAX_SAFE_INTEGER;
		if (aCreated !== bCreated) return aCreated - bCreated;
		return a.id.localeCompare(b.id);
	});
}
function resolveCronServiceFromCandidate(candidate) {
	if (!candidate || typeof candidate !== "object") return null;
	const cron = candidate;
	if (typeof cron.list !== "function" || typeof cron.add !== "function" || typeof cron.update !== "function" || typeof cron.remove !== "function") return null;
	return cron;
}
function resolveCronServiceFromGatewayContext(context) {
	return resolveCronServiceFromCandidate(context?.getCron?.());
}
function resolveDreamingTriggerSessionKeys(sessionKey) {
	const normalized = normalizeTrimmedString(sessionKey);
	if (!normalized) return [];
	const keys = [normalized];
	if (normalized.endsWith(HEARTBEAT_ISOLATED_SESSION_SUFFIX)) {
		const baseSessionKey = normalized.slice(0, -10).trim();
		if (baseSessionKey) keys.push(baseSessionKey);
	}
	return Array.from(new Set(keys));
}
function hasPendingManagedDreamingCronEvent(sessionKey) {
	return resolveDreamingTriggerSessionKeys(sessionKey).some((candidateSessionKey) => peekSystemEventEntries(candidateSessionKey).some((event) => event.contextKey?.startsWith("cron:") === true && normalizeTrimmedString(event.text) === "__openclaw_memory_core_short_term_promotion_dream__"));
}
function resolveShortTermPromotionDreamingConfig(params) {
	const resolved = resolveMemoryDeepDreamingConfig(params);
	return {
		enabled: resolved.enabled,
		cron: resolved.cron,
		...resolved.timezone ? { timezone: resolved.timezone } : {},
		limit: resolved.limit,
		minScore: resolved.minScore,
		minRecallCount: resolved.minRecallCount,
		minUniqueQueries: resolved.minUniqueQueries,
		recencyHalfLifeDays: resolved.recencyHalfLifeDays,
		...typeof resolved.maxAgeDays === "number" ? { maxAgeDays: resolved.maxAgeDays } : {},
		verboseLogging: resolved.verboseLogging,
		storage: resolved.storage,
		...resolved.execution.model ? { execution: { model: resolved.execution.model } } : {}
	};
}
async function reconcileShortTermDreamingCronJob(params) {
	const cron = params.cron;
	if (!cron) return {
		status: "unavailable",
		removed: 0
	};
	const allJobs = await cron.list({ includeDisabled: true });
	const managed = allJobs.filter(isManagedDreamingJob);
	const legacyPhaseJobs = allJobs.filter(isLegacyPhaseDreamingJob);
	if (!params.config.enabled) {
		let removed = await migrateLegacyPhaseDreamingCronJobs({
			cron,
			legacyJobs: legacyPhaseJobs,
			logger: params.logger,
			mode: "disabled"
		});
		for (const job of managed) try {
			if ((await cron.remove(job.id)).removed === true) removed += 1;
		} catch (err) {
			params.logger.warn(`memory-core: failed to remove managed dreaming cron job ${job.id}: ${formatErrorMessage(err)}`);
		}
		if (removed > 0) params.logger.info(`memory-core: removed ${removed} managed dreaming cron job(s).`);
		return {
			status: "disabled",
			removed
		};
	}
	const desired = buildManagedDreamingCronJob(params.config);
	if (managed.length === 0) {
		await cron.add(desired);
		const migratedLegacy = await migrateLegacyPhaseDreamingCronJobs({
			cron,
			legacyJobs: legacyPhaseJobs,
			logger: params.logger,
			mode: "enabled"
		});
		params.logger.info("memory-core: created managed dreaming cron job.");
		return {
			status: "added",
			removed: migratedLegacy
		};
	}
	const [primary, ...duplicates] = sortManagedJobs(managed);
	let removed = await migrateLegacyPhaseDreamingCronJobs({
		cron,
		legacyJobs: legacyPhaseJobs,
		logger: params.logger,
		mode: "enabled"
	});
	for (const duplicate of duplicates) try {
		if ((await cron.remove(duplicate.id)).removed === true) removed += 1;
	} catch (err) {
		params.logger.warn(`memory-core: failed to prune duplicate managed dreaming cron job ${duplicate.id}: ${formatErrorMessage(err)}`);
	}
	const patch = buildManagedDreamingPatch(primary, desired);
	if (!patch) {
		if (removed > 0) params.logger.info("memory-core: pruned duplicate managed dreaming cron jobs.");
		return {
			status: "noop",
			removed
		};
	}
	await cron.update(primary.id, patch);
	params.logger.info("memory-core: updated managed dreaming cron job.");
	return {
		status: "updated",
		removed
	};
}
async function runShortTermDreamingPromotionIfTriggered(params) {
	if (params.trigger !== "heartbeat" && params.trigger !== "cron") return;
	if (!includesSystemEventToken(params.cleanedBody, "__openclaw_memory_core_short_term_promotion_dream__")) return;
	if (!params.config.enabled) return {
		handled: true,
		reason: "memory-core: short-term dreaming disabled"
	};
	const recencyHalfLifeDays = params.config.recencyHalfLifeDays ?? 14;
	const fallbackWorkspaceDir = normalizeTrimmedString(params.workspaceDir);
	const workspaceCandidates = params.cfg ? resolveMemoryDreamingWorkspaces(params.cfg, {
		primaryWorkspaceDir: fallbackWorkspaceDir,
		primaryAgentId: "main"
	}).map((entry) => entry.workspaceDir) : [];
	const seenWorkspaces = /* @__PURE__ */ new Set();
	const workspaces = workspaceCandidates.filter((workspaceDir) => {
		if (seenWorkspaces.has(workspaceDir)) return false;
		seenWorkspaces.add(workspaceDir);
		return true;
	});
	if (workspaces.length === 0 && fallbackWorkspaceDir) workspaces.push(fallbackWorkspaceDir);
	if (workspaces.length === 0) {
		params.logger.warn("memory-core: dreaming promotion skipped because no memory workspace is available.");
		return {
			handled: true,
			reason: "memory-core: short-term dreaming missing workspace"
		};
	}
	if (params.config.limit === 0) {
		params.logger.info("memory-core: dreaming promotion skipped because limit=0.");
		return {
			handled: true,
			reason: "memory-core: short-term dreaming disabled by limit"
		};
	}
	if (params.config.verboseLogging) params.logger.info(`memory-core: dreaming verbose enabled (cron=${params.config.cron}, limit=${params.config.limit}, minScore=${params.config.minScore.toFixed(3)}, minRecallCount=${params.config.minRecallCount}, minUniqueQueries=${params.config.minUniqueQueries}, recencyHalfLifeDays=${recencyHalfLifeDays}, maxAgeDays=${params.config.maxAgeDays ?? "none"}, workspaces=${workspaces.length}).`);
	let totalCandidates = 0;
	let totalApplied = 0;
	let failedWorkspaces = 0;
	const pluginConfig = params.cfg ? resolveMemoryCorePluginConfig(params.cfg) : void 0;
	const detachNarratives = params.trigger === "cron";
	for (const workspaceDir of workspaces) try {
		const sweepNowMs = Date.now();
		await runDreamingSweepPhases({
			workspaceDir,
			pluginConfig,
			cfg: params.cfg,
			logger: params.logger,
			subagent: params.subagent,
			detachNarratives,
			nowMs: sweepNowMs
		});
		const reportLines = [];
		const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
		if (repair.changed) {
			params.logger.info(`memory-core: normalized recall artifacts before dreaming (${formatRepairSummary(repair)}) [workspace=${workspaceDir}].`);
			reportLines.push(`- Repaired recall artifacts: ${formatRepairSummary(repair)}.`);
		}
		const candidates = await rankShortTermPromotionCandidates({
			workspaceDir,
			limit: params.config.limit,
			minScore: params.config.minScore,
			minRecallCount: params.config.minRecallCount,
			minUniqueQueries: params.config.minUniqueQueries,
			recencyHalfLifeDays,
			maxAgeDays: params.config.maxAgeDays,
			nowMs: sweepNowMs
		});
		totalCandidates += candidates.length;
		reportLines.push(`- Ranked ${candidates.length} candidate(s) for durable promotion.`);
		if (params.config.verboseLogging) {
			const candidateSummary = candidates.length > 0 ? candidates.map((candidate) => `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} recalls=${candidate.recallCount} queries=${candidate.uniqueQueries} components={freq=${candidate.components.frequency.toFixed(3)},rel=${candidate.components.relevance.toFixed(3)},div=${candidate.components.diversity.toFixed(3)},rec=${candidate.components.recency.toFixed(3)},cons=${candidate.components.consolidation.toFixed(3)},concept=${candidate.components.conceptual.toFixed(3)}}`).join(" | ") : "none";
			params.logger.info(`memory-core: dreaming candidate details [workspace=${workspaceDir}] ${candidateSummary}`);
		}
		const applied = await applyShortTermPromotions({
			workspaceDir,
			candidates,
			limit: params.config.limit,
			minScore: params.config.minScore,
			minRecallCount: params.config.minRecallCount,
			minUniqueQueries: params.config.minUniqueQueries,
			maxAgeDays: params.config.maxAgeDays,
			timezone: params.config.timezone,
			nowMs: sweepNowMs
		});
		totalApplied += applied.applied;
		reportLines.push(`- Promoted ${applied.applied} candidate(s) into MEMORY.md.`);
		if (params.config.verboseLogging) {
			const appliedSummary = applied.appliedCandidates.length > 0 ? applied.appliedCandidates.map((candidate) => `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} recalls=${candidate.recallCount}`).join(" | ") : "none";
			params.logger.info(`memory-core: dreaming applied details [workspace=${workspaceDir}] ${appliedSummary}`);
		}
		await writeDeepDreamingReport({
			workspaceDir,
			bodyLines: reportLines,
			nowMs: sweepNowMs,
			timezone: params.config.timezone,
			storage: params.config.storage ?? {
				mode: "separate",
				separateReports: false
			}
		});
		if (params.subagent && (candidates.length > 0 || applied.applied > 0)) {
			const data = {
				phase: "deep",
				snippets: candidates.map((c) => c.snippet).filter(Boolean),
				promotions: applied.appliedCandidates.map((c) => c.snippet).filter(Boolean)
			};
			if (detachNarratives) runDetachedDreamNarrative({
				subagent: params.subagent,
				workspaceDir,
				data,
				nowMs: sweepNowMs,
				timezone: params.config.timezone,
				model: params.config.execution?.model,
				logger: params.logger
			});
			else await generateAndAppendDreamNarrative({
				subagent: params.subagent,
				workspaceDir,
				data,
				nowMs: sweepNowMs,
				timezone: params.config.timezone,
				model: params.config.execution?.model,
				logger: params.logger
			});
		}
	} catch (err) {
		failedWorkspaces += 1;
		params.logger.error(`memory-core: dreaming promotion failed for workspace ${workspaceDir}: ${formatErrorMessage(err)}`);
	}
	params.logger.info(`memory-core: dreaming promotion complete (workspaces=${workspaces.length}, candidates=${totalCandidates}, applied=${totalApplied}, failed=${failedWorkspaces}).`);
	return {
		handled: true,
		reason: "memory-core: short-term dreaming processed"
	};
}
function registerShortTermPromotionDreaming(api) {
	let resolveStartupCron = null;
	let gatewayContext = null;
	let unavailableCronWarningEmitted = false;
	let lastRuntimeReconcileAtMs = 0;
	let lastRuntimeConfigKey = null;
	let lastRuntimeCronRef = null;
	let startupCronRetryTimer = null;
	let startupCronRetryAttempts = 0;
	let disposed = false;
	const resolveCurrentConfig = () => api.runtime.config?.current?.() ?? api.config;
	const clearStartupCronRetry = () => {
		if (startupCronRetryTimer) {
			clearTimeout(startupCronRetryTimer);
			startupCronRetryTimer = null;
		}
		startupCronRetryAttempts = 0;
	};
	const hasStartupCron = () => {
		try {
			return Boolean(resolveStartupCron?.());
		} catch {
			return false;
		}
	};
	const hasCronManagementContext = () => Boolean(resolveStartupCron || gatewayContext?.getCron);
	const disposeStartupCronRetry = () => {
		disposed = true;
		clearStartupCronRetry();
		gatewayContext = null;
		resolveStartupCron = null;
	};
	const runtimeConfigKey = (config) => [
		config.enabled ? "enabled" : "disabled",
		config.cron,
		config.timezone ?? "",
		String(config.limit),
		String(config.minScore),
		String(config.minRecallCount),
		String(config.minUniqueQueries),
		String(config.recencyHalfLifeDays ?? ""),
		String(config.maxAgeDays ?? ""),
		config.verboseLogging ? "verbose" : "quiet",
		config.storage?.mode ?? "",
		config.storage?.separateReports ? "separate" : "inline"
	].join("|");
	const reconcileManagedDreamingCron = async (params) => {
		const startupCfg = params.reason === "startup" ? params.startupConfig ?? api.config : resolveCurrentConfig();
		const config = resolveShortTermPromotionDreamingConfig({
			pluginConfig: params.reason === "runtime" ? resolveMemoryCorePluginConfig(startupCfg) : resolveMemoryCorePluginConfig(startupCfg) ?? resolveMemoryCorePluginConfig(api.config) ?? api.pluginConfig,
			cfg: startupCfg
		});
		if (params.reason === "startup") resolveStartupCron = params.startupCron ?? null;
		let cron = resolveStartupCron?.() ?? null;
		if (!cron && params.reason === "runtime" && gatewayContext) try {
			cron = resolveCronServiceFromGatewayContext(gatewayContext);
			if (cron) resolveStartupCron = () => cron;
		} catch {}
		const configKey = runtimeConfigKey(config);
		if (!cron && config.enabled && !unavailableCronWarningEmitted) if (params.reason === "startup") api.logger.debug?.("memory-core: cron service not yet available at gateway_start; deferring to runtime reconciliation.");
		else {
			api.logger.warn("memory-core: managed dreaming cron could not be reconciled (cron service unavailable).");
			unavailableCronWarningEmitted = true;
		}
		if (cron) {
			unavailableCronWarningEmitted = false;
			clearStartupCronRetry();
		}
		if (params.reason === "runtime") {
			const now = Date.now();
			if (now - lastRuntimeReconcileAtMs < RUNTIME_CRON_RECONCILE_INTERVAL_MS && lastRuntimeConfigKey === configKey && lastRuntimeCronRef === cron) return config;
			lastRuntimeReconcileAtMs = now;
			lastRuntimeConfigKey = configKey;
			lastRuntimeCronRef = cron;
		}
		await reconcileShortTermDreamingCronJob({
			cron,
			config,
			logger: api.logger
		});
		return config;
	};
	const scheduleStartupCronRetry = () => {
		if (disposed || hasStartupCron()) {
			clearStartupCronRetry();
			return;
		}
		if (startupCronRetryTimer || startupCronRetryAttempts >= STARTUP_CRON_RETRY_MAX_ATTEMPTS) return;
		startupCronRetryTimer = setTimeout(() => {
			startupCronRetryTimer = null;
			if (disposed) return;
			startupCronRetryAttempts += 1;
			reconcileManagedDreamingCron({ reason: "runtime" }).then(() => {
				if (disposed || hasStartupCron()) {
					clearStartupCronRetry();
					return;
				}
				scheduleStartupCronRetry();
			}).catch((err) => {
				if (disposed) return;
				api.logger.error(`memory-core: deferred dreaming cron retry failed: ${formatErrorMessage(err)}`);
				scheduleStartupCronRetry();
			});
		}, STARTUP_CRON_RETRY_DELAY_MS);
	};
	api.on("gateway_start", async (_event, ctx) => {
		disposed = false;
		gatewayContext = ctx;
		try {
			await reconcileManagedDreamingCron({
				reason: "startup",
				startupConfig: ctx.config,
				startupCron: () => resolveCronServiceFromGatewayContext(ctx)
			});
			scheduleStartupCronRetry();
		} catch (err) {
			api.logger.error(`memory-core: dreaming startup reconciliation failed: ${formatErrorMessage(err)}`);
		}
	});
	api.on("gateway_stop", () => {
		disposeStartupCronRetry();
	});
	api.on("before_agent_reply", async (event, ctx) => {
		try {
			if (ctx.trigger !== "heartbeat" && ctx.trigger !== "cron") return;
			const currentConfig = resolveCurrentConfig();
			const hasManagedDreamingToken = includesSystemEventToken(event.cleanedBody, MEMORY_DREAMING_SYSTEM_EVENT_TEXT);
			const isManagedHeartbeatTrigger = ctx.trigger === "heartbeat" && hasPendingManagedDreamingCronEvent(ctx.sessionKey);
			const isManagedCronTrigger = ctx.trigger === "cron";
			const shouldHandleManagedDreaming = hasManagedDreamingToken && (isManagedHeartbeatTrigger || isManagedCronTrigger);
			if (!shouldHandleManagedDreaming && !hasCronManagementContext()) return;
			const config = await reconcileManagedDreamingCron({ reason: "runtime" });
			if (!shouldHandleManagedDreaming) return;
			return await runShortTermDreamingPromotionIfTriggered({
				cleanedBody: event.cleanedBody,
				trigger: ctx.trigger,
				workspaceDir: ctx.workspaceDir,
				cfg: currentConfig,
				config,
				logger: api.logger,
				subagent: config.enabled ? api.runtime?.subagent : void 0
			});
		} catch (err) {
			api.logger.error(`memory-core: dreaming trigger failed: ${formatErrorMessage(err)}`);
			return;
		}
	});
}
//#endregion
export { resolveShortTermPromotionDreamingConfig as n, registerShortTermPromotionDreaming as t };
