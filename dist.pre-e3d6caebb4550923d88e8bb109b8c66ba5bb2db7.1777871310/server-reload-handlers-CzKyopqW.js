import { t as isTruthyEnvValue } from "./env-Bw2O6sSO.js";
import { n as isRestartEnabled } from "./commands.flags-D-_dSu_7.js";
import { a as deferGatewayRestartUntilIdle, d as resolveGatewayRestartDeferralTimeoutMs, o as emitGatewayRestart, p as setGatewaySigusr1RestartPolicy } from "./restart-BjnlYmGj.js";
import { g as getActiveEmbeddedRunCount, n as abortEmbeddedPiRun } from "./runs-qXGu5GiY.js";
import { o as resetModelCatalogCache } from "./model-catalog-DH6dOsB0.js";
import { l as getTotalQueueSize } from "./command-queue-CIYT9xfZ.js";
import { i as disposeAllSessionMcpRuntimes } from "./pi-bundle-mcp-runtime-zzBMxCEv.js";
import "./pi-bundle-mcp-tools-Byqvhfhp.js";
import { i as getActiveSecretsRuntimeSnapshot, n as clearSecretsRuntimeSnapshot, t as activateSecretsRuntimeSnapshot } from "./runtime-BphUzQ8_.js";
import { r as resetDirectoryCache } from "./target-resolver-CStqf4b2.js";
import { i as getInspectableTaskRegistrySummary, n as getInspectableActiveTaskRestartBlockers } from "./task-registry.maintenance-DWoFx_kv.js";
import { t as getTotalPendingReplies } from "./dispatcher-registry-Cfi_yr3Z.js";
import { _ as resolveHooksConfig } from "./hooks-G78ue1G2.js";
import { r as markGatewayModelCatalogStaleForReload } from "./server-model-catalog-CwRiu1k8.js";
import { r as startGatewayConfigReloader } from "./config-reload-BiGXFYSb.js";
import { c as startGatewayChannelHealthMonitor, g as enqueueConfigRecoveryNotice, h as buildGatewayCronService, l as startGatewayCronWithLogging, m as applyGatewayLaneConcurrency, o as setCurrentSharedGatewaySessionGeneration, r as disconnectStaleSharedGatewayAuthClients, t as resolveHookClientIpConfig } from "./hook-client-ip-config-BsaChfCW.js";
//#region src/gateway/server-reload-handlers.ts
const MCP_RUNTIME_RELOAD_DISPOSE_TIMEOUT_MS = 5e3;
const CHANNEL_RELOAD_DEFERRAL_POLL_MS = 500;
const CHANNEL_RELOAD_STILL_PENDING_WARN_MS = 3e4;
function abortActiveAgentRunsAfterConfigRecovery(params) {
	if (!abortEmbeddedPiRun(void 0, { mode: "all" })) return;
	params.logReload.warn(`config recovery aborted active agent run(s) after reload-${params.reason}`);
}
async function disposeMcpRuntimesWithTimeout(params) {
	let timer;
	const disposePromise = params.dispose().catch((error) => {
		params.onWarn(`${params.label} failed: ${String(error)}`);
	});
	const timeoutPromise = new Promise((resolve) => {
		timer = setTimeout(() => resolve("timeout"), params.timeoutMs);
		timer.unref?.();
	});
	const result = await Promise.race([disposePromise.then(() => "done"), timeoutPromise]);
	if (timer) clearTimeout(timer);
	if (result === "timeout") params.onWarn(`${params.label} exceeded ${params.timeoutMs}ms; continuing`);
}
function createGatewayReloadHandlers(params) {
	const getActiveCounts = () => {
		const queueSize = getTotalQueueSize();
		const pendingReplies = getTotalPendingReplies();
		const embeddedRuns = getActiveEmbeddedRunCount();
		const activeTasks = getInspectableTaskRegistrySummary().active;
		return {
			queueSize,
			pendingReplies,
			embeddedRuns,
			activeTasks,
			totalActive: queueSize + pendingReplies + embeddedRuns + activeTasks
		};
	};
	const formatActiveDetails = (counts) => {
		const details = [];
		if (counts.queueSize > 0) details.push(`${counts.queueSize} operation(s)`);
		if (counts.pendingReplies > 0) details.push(`${counts.pendingReplies} reply(ies)`);
		if (counts.embeddedRuns > 0) details.push(`${counts.embeddedRuns} embedded run(s)`);
		if (counts.activeTasks > 0) details.push(`${counts.activeTasks} task run(s)`);
		return details;
	};
	const formatTaskBlocker = (task) => {
		return [
			`taskId=${task.taskId}`,
			task.runId ? `runId=${task.runId}` : null,
			`status=${task.status}`,
			`runtime=${task.runtime}`,
			task.label ? `label=${task.label}` : null,
			task.title ? `title=${task.title.slice(0, 80)}` : null
		].filter((value) => Boolean(value)).join(" ");
	};
	const formatTaskBlockers = () => {
		const blockers = getInspectableActiveTaskRestartBlockers();
		if (blockers.length === 0) return null;
		const shown = blockers.slice(0, 8).map(formatTaskBlocker);
		const omitted = blockers.length - shown.length;
		return omitted > 0 ? `${shown.join("; ")}; +${omitted} more` : shown.join("; ");
	};
	const waitForActiveWorkBeforeChannelReload = async (channels, nextConfig) => {
		const initial = getActiveCounts();
		if (initial.totalActive <= 0) return;
		const channelNames = [...channels].join(", ");
		const initialDetails = formatActiveDetails(initial);
		params.logReload.warn(`config change requires channel reload (${channelNames}) — deferring until ${initialDetails.join(", ")} complete`);
		const timeoutMsRaw = nextConfig.gateway?.reload?.deferralTimeoutMs;
		const timeoutMs = typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.max(CHANNEL_RELOAD_DEFERRAL_POLL_MS, Math.floor(timeoutMsRaw)) : void 0;
		const startedAt = Date.now();
		let nextStillPendingAt = startedAt + CHANNEL_RELOAD_STILL_PENDING_WARN_MS;
		while (true) {
			await new Promise((resolve) => {
				setTimeout(resolve, CHANNEL_RELOAD_DEFERRAL_POLL_MS).unref?.();
			});
			const current = getActiveCounts();
			if (current.totalActive <= 0) {
				params.logReload.info("active operations and replies completed; reloading channels now");
				return;
			}
			const elapsedMs = Date.now() - startedAt;
			if (timeoutMs !== void 0 && elapsedMs >= timeoutMs) {
				const remaining = formatActiveDetails(current);
				params.logReload.warn(`channel reload timeout after ${elapsedMs}ms with ${remaining.join(", ")} still active; reloading channels anyway`);
				return;
			}
			if (Date.now() >= nextStillPendingAt) {
				const remaining = formatActiveDetails(current);
				params.logReload.warn(`channel reload still deferred after ${elapsedMs}ms with ${remaining.join(", ")} active`);
				nextStillPendingAt = Date.now() + CHANNEL_RELOAD_STILL_PENDING_WARN_MS;
			}
		}
	};
	const applyHotReload = async (plan, nextConfig) => {
		setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
		const state = params.getState();
		const nextState = { ...state };
		if (plan.changedPaths.some((path) => path === "models" || path.startsWith("models.") || path === "agents.defaults.model" || path.startsWith("agents.defaults.model.") || path === "agents.defaults.models" || path.startsWith("agents.defaults.models."))) {
			resetModelCatalogCache();
			markGatewayModelCatalogStaleForReload();
		}
		if (plan.reloadHooks) try {
			nextState.hooksConfig = resolveHooksConfig(nextConfig);
		} catch (err) {
			params.logHooks.warn(`hooks config reload failed: ${String(err)}`);
		}
		nextState.hookClientIpConfig = resolveHookClientIpConfig(nextConfig);
		if (plan.restartHeartbeat) nextState.heartbeatRunner.updateConfig(nextConfig);
		resetDirectoryCache();
		const channelsToRestart = new Set(plan.restartChannels);
		const channelsStoppedBeforePluginReload = /* @__PURE__ */ new Set();
		let activePluginChannelsAfterReload = null;
		const shouldSkipChannelRestart = () => isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) || isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
		if (plan.reloadPlugins) {
			const stopChannelsBeforePluginReplace = async (channels) => {
				for (const channel of channels) channelsToRestart.add(channel);
				if (channelsToRestart.size === 0 || shouldSkipChannelRestart()) return;
				await waitForActiveWorkBeforeChannelReload(channelsToRestart, nextConfig);
				for (const channel of channelsToRestart) {
					if (channelsStoppedBeforePluginReload.has(channel)) continue;
					params.logChannels.info(`stopping ${channel} channel before plugin reload`);
					await params.stopChannel(channel);
					channelsStoppedBeforePluginReload.add(channel);
				}
			};
			const pluginReloadResult = await params.reloadPlugins({
				nextConfig,
				changedPaths: plan.changedPaths,
				beforeReplace: stopChannelsBeforePluginReplace
			});
			for (const channel of pluginReloadResult.restartChannels) channelsToRestart.add(channel);
			activePluginChannelsAfterReload = pluginReloadResult.activeChannels;
		}
		if (plan.restartCron) {
			state.cronState.cron.stop();
			nextState.cronState = buildGatewayCronService({
				cfg: nextConfig,
				deps: params.deps,
				broadcast: params.broadcast
			});
			startGatewayCronWithLogging({
				cron: nextState.cronState.cron,
				logCron: params.logCron
			});
		}
		if (plan.restartHealthMonitor) {
			state.channelHealthMonitor?.stop();
			nextState.channelHealthMonitor = params.createHealthMonitor(nextConfig);
		}
		if (plan.disposeMcpRuntimes) await disposeMcpRuntimesWithTimeout({
			dispose: disposeAllSessionMcpRuntimes,
			timeoutMs: MCP_RUNTIME_RELOAD_DISPOSE_TIMEOUT_MS,
			onWarn: params.logReload.warn,
			label: "bundle-mcp runtime disposal during config reload"
		});
		if (plan.restartGmailWatcher) {
			const [{ stopGmailWatcher }, { startGmailWatcherWithLogs }] = await Promise.all([import("./gmail-watcher-dIad7mqb.js"), import("./gmail-watcher-lifecycle-CeTbXKod.js")]);
			await stopGmailWatcher().catch((err) => {
				params.logHooks.warn(`gmail watcher stop failed during reload: ${String(err)}`);
			});
			await startGmailWatcherWithLogs({
				cfg: nextConfig,
				log: params.logHooks,
				onSkipped: () => params.logHooks.info("skipping gmail watcher restart (OPENCLAW_SKIP_GMAIL_WATCHER=1)")
			});
		}
		if (channelsToRestart.size > 0) if (shouldSkipChannelRestart()) params.logChannels.info("skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)");
		else {
			if (!plan.reloadPlugins) await waitForActiveWorkBeforeChannelReload(channelsToRestart, nextConfig);
			const restartChannel = async (name) => {
				if (plan.reloadPlugins && activePluginChannelsAfterReload?.has(name) === false) return;
				params.logChannels.info(`restarting ${name} channel`);
				if (!channelsStoppedBeforePluginReload.has(name)) await params.stopChannel(name);
				await params.startChannel(name);
			};
			for (const channel of channelsToRestart) await restartChannel(channel);
		}
		applyGatewayLaneConcurrency(nextConfig);
		if (plan.hotReasons.length > 0) params.logReload.info(`config hot reload applied (${plan.hotReasons.join(", ")})`);
		else if (plan.noopPaths.length > 0) params.logReload.info(`config change applied (dynamic reads: ${plan.noopPaths.join(", ")})`);
		params.setState(nextState);
	};
	let restartPending = false;
	const requestGatewayRestart = (plan, nextConfig) => {
		setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
		const reasons = plan.restartReasons.length ? plan.restartReasons.join(", ") : plan.changedPaths.join(", ");
		if (process.listenerCount("SIGUSR1") === 0) {
			params.logReload.warn("no SIGUSR1 listener found; restart skipped");
			return false;
		}
		const active = getActiveCounts();
		if (active.totalActive > 0) {
			if (restartPending) {
				params.logReload.info(`config change requires gateway restart (${reasons}) — already waiting for operations to complete`);
				return true;
			}
			restartPending = true;
			const initialDetails = formatActiveDetails(active);
			params.logReload.warn(`config change requires gateway restart (${reasons}) — deferring until ${initialDetails.join(", ")} complete`);
			const taskBlockers = formatTaskBlockers();
			if (taskBlockers) params.logReload.warn(`restart blocked by active task run(s): ${taskBlockers}`);
			deferGatewayRestartUntilIdle({
				getPendingCount: () => getActiveCounts().totalActive,
				maxWaitMs: resolveGatewayRestartDeferralTimeoutMs(nextConfig.gateway?.reload?.deferralTimeoutMs),
				hooks: {
					onReady: () => {
						restartPending = false;
						params.logReload.info("all operations and replies completed; restarting gateway now");
					},
					onStillPending: (_pending, elapsedMs) => {
						const remaining = formatActiveDetails(getActiveCounts());
						const taskBlockers = formatTaskBlockers();
						params.logReload.warn(`restart still deferred after ${elapsedMs}ms with ${remaining.join(", ")} active${taskBlockers ? ` (${taskBlockers})` : ""}`);
					},
					onTimeout: (_pending, elapsedMs) => {
						const remaining = formatActiveDetails(getActiveCounts());
						const taskBlockers = formatTaskBlockers();
						restartPending = false;
						params.logReload.warn(`restart timeout after ${elapsedMs}ms with ${remaining.join(", ")} still active${taskBlockers ? ` (${taskBlockers})` : ""}; forcing restart`);
					},
					onCheckError: (err) => {
						restartPending = false;
						params.logReload.warn(`restart deferral check failed (${String(err)}); restarting gateway now`);
					}
				}
			});
			return true;
		}
		params.logReload.warn(`config change requires gateway restart (${reasons})`);
		if (!emitGatewayRestart()) params.logReload.info("gateway restart already scheduled; skipping duplicate signal");
		return true;
	};
	return {
		applyHotReload,
		requestGatewayRestart
	};
}
function startManagedGatewayConfigReloader(params) {
	if (params.minimalTestGateway) return { stop: async () => {} };
	const { applyHotReload, requestGatewayRestart } = createGatewayReloadHandlers({
		deps: params.deps,
		broadcast: params.broadcast,
		getState: params.getState,
		setState: params.setState,
		startChannel: params.startChannel,
		stopChannel: params.stopChannel,
		reloadPlugins: params.reloadPlugins,
		logHooks: params.logHooks,
		logChannels: params.logChannels,
		logCron: params.logCron,
		logReload: params.logReload,
		createHealthMonitor: (config) => startGatewayChannelHealthMonitor({
			cfg: config,
			channelManager: params.channelManager
		})
	});
	return startGatewayConfigReloader({
		initialConfig: params.initialConfig,
		initialCompareConfig: params.initialCompareConfig,
		initialInternalWriteHash: params.initialInternalWriteHash,
		readSnapshot: params.readSnapshot,
		recoverSnapshot: async (snapshot, reason) => await params.recoverSnapshot({
			snapshot,
			reason: `reload-${reason}`
		}),
		promoteSnapshot: async (snapshot, _reason) => await params.promoteSnapshot(snapshot),
		onRecovered: ({ reason, snapshot, recoveredSnapshot }) => {
			abortActiveAgentRunsAfterConfigRecovery({
				reason,
				logReload: params.logReload
			});
			enqueueConfigRecoveryNotice({
				cfg: recoveredSnapshot.config,
				phase: "reload",
				reason: `reload-${reason}`,
				configPath: snapshot.path,
				issues: [...snapshot.issues, ...snapshot.legacyIssues]
			});
		},
		subscribeToWrites: params.subscribeToWrites,
		onHotReload: async (plan, nextConfig) => {
			const previousSharedGatewaySessionGeneration = params.sharedGatewaySessionGenerationState.current;
			const previousSnapshot = getActiveSecretsRuntimeSnapshot();
			const prepared = await params.activateRuntimeSecrets(nextConfig, {
				reason: "reload",
				activate: true
			});
			const nextSharedGatewaySessionGeneration = params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
			params.sharedGatewaySessionGenerationState.current = nextSharedGatewaySessionGeneration;
			const sharedGatewaySessionGenerationChanged = previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration;
			if (sharedGatewaySessionGenerationChanged) disconnectStaleSharedGatewayAuthClients({
				clients: params.clients,
				expectedGeneration: nextSharedGatewaySessionGeneration
			});
			try {
				await applyHotReload(plan, prepared.config);
			} catch (err) {
				if (previousSnapshot) activateSecretsRuntimeSnapshot(previousSnapshot);
				else clearSecretsRuntimeSnapshot();
				params.sharedGatewaySessionGenerationState.current = previousSharedGatewaySessionGeneration;
				if (sharedGatewaySessionGenerationChanged) disconnectStaleSharedGatewayAuthClients({
					clients: params.clients,
					expectedGeneration: previousSharedGatewaySessionGeneration
				});
				throw err;
			}
			setCurrentSharedGatewaySessionGeneration(params.sharedGatewaySessionGenerationState, nextSharedGatewaySessionGeneration);
		},
		onRestart: async (plan, nextConfig) => {
			const previousRequiredSharedGatewaySessionGeneration = params.sharedGatewaySessionGenerationState.required;
			const previousSharedGatewaySessionGeneration = params.sharedGatewaySessionGenerationState.current;
			try {
				const prepared = await params.activateRuntimeSecrets(nextConfig, {
					reason: "restart-check",
					activate: false
				});
				const nextSharedGatewaySessionGeneration = params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
				if (!requestGatewayRestart(plan, nextConfig)) {
					if (previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration) {
						activateSecretsRuntimeSnapshot(prepared);
						setCurrentSharedGatewaySessionGeneration(params.sharedGatewaySessionGenerationState, nextSharedGatewaySessionGeneration);
						params.sharedGatewaySessionGenerationState.required = null;
						disconnectStaleSharedGatewayAuthClients({
							clients: params.clients,
							expectedGeneration: nextSharedGatewaySessionGeneration
						});
					} else params.sharedGatewaySessionGenerationState.required = null;
					return;
				}
				if (previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration) {
					params.sharedGatewaySessionGenerationState.required = nextSharedGatewaySessionGeneration;
					disconnectStaleSharedGatewayAuthClients({
						clients: params.clients,
						expectedGeneration: nextSharedGatewaySessionGeneration
					});
				} else params.sharedGatewaySessionGenerationState.required = null;
			} catch (error) {
				params.sharedGatewaySessionGenerationState.required = previousRequiredSharedGatewaySessionGeneration;
				throw error;
			}
		},
		log: {
			info: (msg) => params.logReload.info(msg),
			warn: (msg) => params.logReload.warn(msg),
			error: (msg) => params.logReload.error(msg)
		},
		watchPath: params.watchPath
	});
}
//#endregion
export { startManagedGatewayConfigReloader };
