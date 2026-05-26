import { n as isVitestRuntimeEnv } from "./env-Dhqok4CP.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as isGatewayModelPricingEnabled } from "./model-pricing-config-CpVOfxdS.js";
import { i as resolveChannelRestartReason, r as evaluateChannelHealth } from "./channel-health-policy-D_eDwUBm.js";
import { r as startHeartbeatRunner } from "./heartbeat-runner-DDFMtPQL.js";
//#region src/gateway/channel-health-monitor.ts
const log = createSubsystemLogger("gateway/health-monitor");
const DEFAULT_CHECK_INTERVAL_MS = 5 * 6e4;
const DEFAULT_MONITOR_STARTUP_GRACE_MS = 6e4;
const DEFAULT_COOLDOWN_CYCLES = 2;
const DEFAULT_MAX_RESTARTS_PER_HOUR = 10;
const ONE_HOUR_MS = 60 * 6e4;
function resolveTimingPolicy(deps) {
	return {
		monitorStartupGraceMs: deps.timing?.monitorStartupGraceMs ?? deps.startupGraceMs ?? DEFAULT_MONITOR_STARTUP_GRACE_MS,
		channelConnectGraceMs: deps.timing?.channelConnectGraceMs ?? deps.channelStartupGraceMs ?? 12e4,
		staleEventThresholdMs: deps.timing?.staleEventThresholdMs ?? deps.staleEventThresholdMs ?? 18e5
	};
}
function startChannelHealthMonitor(deps) {
	const { channelManager, checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS, cooldownCycles = DEFAULT_COOLDOWN_CYCLES, maxRestartsPerHour = DEFAULT_MAX_RESTARTS_PER_HOUR, abortSignal } = deps;
	const timing = resolveTimingPolicy(deps);
	const cooldownMs = cooldownCycles * checkIntervalMs;
	const restartRecords = /* @__PURE__ */ new Map();
	const startedAt = Date.now();
	let stopped = false;
	let checkInFlight = false;
	let timer = null;
	const rKey = (channelId, accountId) => `${channelId}:${accountId}`;
	function pruneOldRestarts(record, now) {
		record.restartsThisHour = record.restartsThisHour.filter((r) => now - r.at < ONE_HOUR_MS);
	}
	async function runCheck() {
		if (stopped || checkInFlight) return;
		checkInFlight = true;
		try {
			const now = Date.now();
			if (now - startedAt < timing.monitorStartupGraceMs) return;
			const snapshot = channelManager.getRuntimeSnapshot();
			for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
				if (!accounts) continue;
				for (const [accountId, status] of Object.entries(accounts)) {
					if (!status) continue;
					if (!channelManager.isHealthMonitorEnabled(channelId, accountId)) continue;
					if (channelManager.isManuallyStopped(channelId, accountId)) continue;
					const health = evaluateChannelHealth(status, {
						channelId,
						now,
						staleEventThresholdMs: timing.staleEventThresholdMs,
						channelConnectGraceMs: timing.channelConnectGraceMs
					});
					if (health.healthy) continue;
					const key = rKey(channelId, accountId);
					const record = restartRecords.get(key) ?? {
						lastRestartAt: 0,
						restartsThisHour: []
					};
					if (now - record.lastRestartAt <= cooldownMs) continue;
					pruneOldRestarts(record, now);
					if (record.restartsThisHour.length >= maxRestartsPerHour) {
						log.warn?.(`[${channelId}:${accountId}] health-monitor: hit ${maxRestartsPerHour} restarts/hour limit, skipping`);
						continue;
					}
					const reason = resolveChannelRestartReason(status, health);
					log.info?.(`[${channelId}:${accountId}] health-monitor: restarting (reason: ${reason})`);
					record.lastRestartAt = now;
					record.restartsThisHour.push({ at: now });
					restartRecords.set(key, record);
					try {
						if (status.running) await channelManager.stopChannel(channelId, accountId, { manual: false });
						channelManager.resetRestartAttempts(channelId, accountId);
						await channelManager.startChannel(channelId, accountId);
					} catch (err) {
						log.error?.(`[${channelId}:${accountId}] health-monitor: restart failed: ${String(err)}`);
					}
				}
			}
		} catch (err) {
			log.error?.(`health-monitor: check failed: ${String(err)}`);
		} finally {
			checkInFlight = false;
		}
	}
	function stop() {
		stopped = true;
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		abortSignal?.removeEventListener("abort", stop);
	}
	if (abortSignal?.aborted) stopped = true;
	else {
		abortSignal?.addEventListener("abort", stop, { once: true });
		timer = setInterval(() => void runCheck(), checkIntervalMs);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		log.info?.(`started (interval: ${Math.round(checkIntervalMs / 1e3)}s, startup-grace: ${Math.round(timing.monitorStartupGraceMs / 1e3)}s, channel-connect-grace: ${Math.round(timing.channelConnectGraceMs / 1e3)}s)`);
	}
	return { stop };
}
//#endregion
//#region src/gateway/server-runtime-services.ts
function createNoopHeartbeatRunner() {
	return {
		stop: () => {},
		updateConfig: (_cfg) => {}
	};
}
function startGatewayChannelHealthMonitor(params) {
	const healthCheckMinutes = params.cfg.gateway?.channelHealthCheckMinutes;
	if (healthCheckMinutes === 0) return null;
	const staleEventThresholdMinutes = params.cfg.gateway?.channelStaleEventThresholdMinutes;
	const maxRestartsPerHour = params.cfg.gateway?.channelMaxRestartsPerHour;
	return startChannelHealthMonitor({
		channelManager: params.channelManager,
		checkIntervalMs: (healthCheckMinutes ?? 5) * 6e4,
		...staleEventThresholdMinutes != null && { staleEventThresholdMs: staleEventThresholdMinutes * 6e4 },
		...maxRestartsPerHour != null && { maxRestartsPerHour }
	});
}
function startGatewayCronWithLogging(params) {
	params.cron.start().catch((err) => params.logCron.error(`failed to start: ${String(err)}`));
}
function clearGatewayMaintenanceHandles(maintenance) {
	if (!maintenance) return;
	clearInterval(maintenance.tickInterval);
	clearInterval(maintenance.healthInterval);
	clearInterval(maintenance.dedupeCleanup);
	if (maintenance.mediaCleanup) clearInterval(maintenance.mediaCleanup);
}
async function runGatewayPostReadyMaintenance(params) {
	try {
		const maintenance = await params.startMaintenance();
		if (maintenance) params.applyMaintenance(maintenance);
	} catch (err) {
		params.log.warn(`gateway post-ready maintenance startup failed: ${String(err)}`);
	}
	if (params.shouldStartCron()) {
		params.markCronStartHandled();
		startGatewayCronWithLogging({
			cron: params.cron,
			logCron: params.logCron
		});
	}
	params.recordPostReadyMemory();
}
function scheduleGatewayPostReadyMaintenance(params) {
	const timer = setTimeout(() => {
		params.onStarted?.();
		if (params.isClosing()) return;
		runGatewayPostReadyMaintenance({
			startMaintenance: async () => {
				if (params.isClosing()) return null;
				const maintenance = await params.startMaintenance();
				if (params.isClosing()) {
					clearGatewayMaintenanceHandles(maintenance);
					return null;
				}
				return maintenance;
			},
			applyMaintenance: (maintenance) => {
				if (params.isClosing()) {
					clearGatewayMaintenanceHandles(maintenance);
					return;
				}
				params.applyMaintenance(maintenance);
			},
			shouldStartCron: () => !params.isClosing() && params.shouldStartCron(),
			markCronStartHandled: params.markCronStartHandled,
			cron: params.cron,
			logCron: params.logCron,
			log: params.log,
			recordPostReadyMemory: () => {
				if (!params.isClosing()) params.recordPostReadyMemory();
			}
		});
	}, params.delayMs);
	timer.unref?.();
	return timer;
}
function recoverPendingOutboundDeliveries(params) {
	(async () => {
		const { recoverPendingDeliveries } = await import("./delivery-queue-DGJMPgsO.js");
		const { deliverOutboundPayloadsInternal } = await import("./deliver-x7f5ZN9X.js");
		await recoverPendingDeliveries({
			deliver: deliverOutboundPayloadsInternal,
			log: params.log.child("delivery-recovery"),
			cfg: params.cfg
		});
	})().catch((err) => params.log.error(`Delivery recovery failed: ${String(err)}`));
}
function recoverPendingSessionDeliveries(params) {
	setTimeout(() => {
		(async () => {
			const { recoverPendingRestartContinuationDeliveries } = await import("./server-restart-sentinel-DaLonhWX.js");
			const logRecovery = params.log.child("session-delivery-recovery");
			await recoverPendingRestartContinuationDeliveries({
				deps: params.deps,
				log: logRecovery,
				maxEnqueuedAt: params.maxEnqueuedAt
			});
		})().catch((err) => params.log.error(`Session delivery recovery failed: ${String(err)}`));
	}, 1250).unref?.();
}
function startGatewayModelPricingRefreshOnDemand(params) {
	if (!isGatewayModelPricingEnabled(params.config)) return () => {};
	let stopped = false;
	let stopRefresh;
	(async () => {
		const { startGatewayModelPricingRefresh } = await import("./model-pricing-cache-C25Q9QCF.js");
		if (stopped) return;
		stopRefresh = startGatewayModelPricingRefresh({
			config: params.config,
			...params.pluginLookUpTable ? { pluginLookUpTable: params.pluginLookUpTable } : {}
		});
		if (stopped) {
			stopRefresh();
			stopRefresh = void 0;
		}
	})().catch((err) => params.log.error(`Model pricing refresh failed to start: ${String(err)}`));
	return () => {
		stopped = true;
		stopRefresh?.();
		stopRefresh = void 0;
	};
}
function startGatewayRuntimeServices(params) {
	const channelHealthMonitor = startGatewayChannelHealthMonitor({
		cfg: params.cfgAtStart,
		channelManager: params.channelManager
	});
	return {
		heartbeatRunner: createNoopHeartbeatRunner(),
		channelHealthMonitor,
		stopModelPricingRefresh: () => {}
	};
}
function activateGatewayScheduledServices(params) {
	if (params.minimalTestGateway) return {
		heartbeatRunner: createNoopHeartbeatRunner(),
		stopModelPricingRefresh: () => {}
	};
	const heartbeatRunner = startHeartbeatRunner({ cfg: params.cfgAtStart });
	if (params.startCron !== false) startGatewayCronWithLogging({
		cron: params.cron,
		logCron: params.logCron
	});
	recoverPendingOutboundDeliveries({
		cfg: params.cfgAtStart,
		log: params.log
	});
	recoverPendingSessionDeliveries({
		deps: params.deps,
		log: params.log,
		maxEnqueuedAt: params.sessionDeliveryRecoveryMaxEnqueuedAt
	});
	return {
		heartbeatRunner,
		stopModelPricingRefresh: !isVitestRuntimeEnv() ? startGatewayModelPricingRefreshOnDemand({
			config: params.cfgAtStart,
			...params.pluginLookUpTable ? { pluginLookUpTable: params.pluginLookUpTable } : {},
			log: params.log
		}) : () => {}
	};
}
//#endregion
export { startGatewayCronWithLogging as a, startGatewayChannelHealthMonitor as i, runGatewayPostReadyMaintenance as n, startGatewayRuntimeServices as o, scheduleGatewayPostReadyMaintenance as r, activateGatewayScheduledServices as t };
