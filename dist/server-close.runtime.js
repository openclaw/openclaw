import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { n as disposeRegisteredAgentHarnesses } from "./registry-481lFxWt.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-C8Y435Ix.js";
import { n as closePluginStateSqliteStore } from "./plugin-state-store-agWe2J3x.js";
import { i as listChannelPlugins } from "./registry-BdfZSqhE2.js";
import "./plugins-YTdL-Pji.js";
import { i as disposeAllSessionMcpRuntimes } from "./pi-bundle-mcp-runtime-kbIcAyUH.js";
import "./pi-bundle-mcp-tools-CPhPya-V.js";
import { r as drainActiveSessionsForShutdown } from "./session-reset-service-CZlxWK9Q.js";
//#region src/gateway/server-close.ts
const shutdownLog = createSubsystemLogger("gateway/shutdown");
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 1e3;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 1e3;
const ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS = 2e3;
const WEBSOCKET_CLOSE_GRACE_MS = 1e3;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1e3;
const HTTP_CLOSE_FORCE_WAIT_MS = 5e3;
const MCP_RUNTIME_CLOSE_GRACE_MS = 5e3;
const LSP_RUNTIME_CLOSE_GRACE_MS = 5e3;
function createTimeoutRace(timeoutMs, onTimeout) {
	let timer = null;
	timer = setTimeout(() => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		resolve(onTimeout());
	}, timeoutMs);
	timer.unref?.();
	let resolve;
	return {
		promise: new Promise((innerResolve) => {
			resolve = innerResolve;
		}),
		clear() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		}
	};
}
async function shutdownStep(name, fn, warnings) {
	try {
		await fn();
		return true;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		shutdownLog.warn(`${name}: ${detail}`);
		recordShutdownWarning(warnings, name);
		return false;
	}
}
function recordShutdownWarning(warnings, name) {
	if (!warnings.includes(name)) warnings.push(name);
}
async function triggerGatewayLifecycleHookWithTimeout(params) {
	let timeout;
	const hookPromise = triggerInternalHook(params.event);
	hookPromise.catch(() => void 0);
	try {
		const result = await Promise.race([hookPromise.then(() => "completed"), new Promise((resolve) => {
			timeout = setTimeout(() => resolve("timeout"), params.timeoutMs);
			timeout.unref?.();
		})]);
		if (result === "timeout") shutdownLog.warn(`${params.hookName} hook timed out after ${params.timeoutMs}ms; continuing shutdown`);
		return result;
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
async function disposeRuntimeWithShutdownGrace(params) {
	const disposePromise = Promise.resolve().then(params.dispose).catch((err) => {
		shutdownLog.warn(`${params.label} runtime disposal failed during shutdown: ${String(err)}`);
		recordShutdownWarning(params.warnings, params.label);
	});
	const disposeTimeout = createTimeoutRace(params.graceMs, () => {
		shutdownLog.warn(`${params.label} runtime disposal exceeded ${params.graceMs}ms; continuing shutdown`);
		recordShutdownWarning(params.warnings, params.label);
	});
	await Promise.race([disposePromise, disposeTimeout.promise]);
	disposeTimeout.clear();
}
async function disposeAllBundleLspRuntimesOnDemand() {
	const { disposeAllBundleLspRuntimes } = await import("./pi-bundle-lsp-runtime-BFmEv9yU.js");
	await disposeAllBundleLspRuntimes();
}
async function stopGmailWatcherOnDemand() {
	const { stopGmailWatcher } = await import("./gmail-watcher-R8s8rFyC.js");
	await stopGmailWatcher();
}
async function runGatewayClosePrelude(params) {
	params.stopDiagnostics?.();
	params.clearSkillsRefreshTimer?.();
	params.skillsChangeUnsub?.();
	params.disposeAuthRateLimiter?.();
	params.disposeBrowserAuthRateLimiter();
	params.stopModelPricingRefresh?.();
	params.stopChannelHealthMonitor?.();
	params.stopReadinessEventLoopHealth?.();
	params.clearSecretsRuntimeSnapshot?.();
	await params.closeMcpServer?.().catch(() => {});
}
function isServerNotRunningError(err) {
	return Boolean(err && typeof err === "object" && "code" in err && err.code === "ERR_SERVER_NOT_RUNNING");
}
function createGatewayCloseHandler(params) {
	return async (opts) => {
		const start = Date.now();
		const warnings = [];
		try {
			const reason = (normalizeOptionalString(opts?.reason) ?? "") || "gateway stopping";
			const restartExpectedMs = typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs) ? Math.max(0, Math.floor(opts.restartExpectedMs)) : null;
			shutdownLog.info(`shutdown started: ${reason}`);
			await shutdownStep("gateway:shutdown", async () => {
				if (await triggerGatewayLifecycleHookWithTimeout({
					event: createInternalHookEvent("gateway", "shutdown", "gateway:shutdown", {
						reason,
						restartExpectedMs
					}),
					hookName: "gateway:shutdown",
					timeoutMs: GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS
				}) === "timeout") recordShutdownWarning(warnings, "gateway:shutdown");
			}, warnings);
			if (restartExpectedMs !== null) await shutdownStep("gateway:pre-restart", async () => {
				if (await triggerGatewayLifecycleHookWithTimeout({
					event: createInternalHookEvent("gateway", "pre-restart", "gateway:pre-restart", {
						reason,
						restartExpectedMs
					}),
					hookName: "gateway:pre-restart",
					timeoutMs: GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS
				}) === "timeout") recordShutdownWarning(warnings, "gateway:pre-restart");
			}, warnings);
			if (params.drainActiveSessionsForShutdown) await shutdownStep("session-end-drain", async () => {
				const drainReason = restartExpectedMs !== null ? "restart" : "shutdown";
				const result = await params.drainActiveSessionsForShutdown({
					reason: drainReason,
					totalTimeoutMs: ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS
				});
				if (result.timedOut) {
					shutdownLog.warn(`session-end-drain timed out after ${ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS}ms after ${result.emittedSessionIds.length} sessions; continuing shutdown`);
					recordShutdownWarning(warnings, "session-end-drain");
				}
			}, warnings);
			if (params.bonjourStop) await shutdownStep("bonjour", () => params.bonjourStop(), warnings);
			if (params.tailscaleCleanup) await shutdownStep("tailscale", () => params.tailscaleCleanup(), warnings);
			const channelIds = params.channelIds ?? listChannelPlugins().map((plugin) => plugin.id);
			for (const channelId of channelIds) await shutdownStep(`channel/${channelId}`, () => params.stopChannel(channelId), warnings);
			await shutdownStep("agent-harnesses", () => disposeRegisteredAgentHarnesses(), warnings);
			await Promise.all([disposeRuntimeWithShutdownGrace({
				label: "bundle-mcp",
				dispose: params.disposeSessionMcpRuntimes ?? disposeAllSessionMcpRuntimes,
				graceMs: MCP_RUNTIME_CLOSE_GRACE_MS,
				warnings
			}), disposeRuntimeWithShutdownGrace({
				label: "bundle-lsp",
				dispose: params.disposeBundleLspRuntimes ?? disposeAllBundleLspRuntimesOnDemand,
				graceMs: LSP_RUNTIME_CLOSE_GRACE_MS,
				warnings
			})]);
			if (params.pluginServices) await shutdownStep("plugin-services", () => params.pluginServices.stop(), warnings);
			await shutdownStep("plugin-state-store", () => closePluginStateSqliteStore(), warnings);
			await shutdownStep("gmail-watcher", () => stopGmailWatcherOnDemand(), warnings);
			params.cron.stop();
			params.heartbeatRunner.stop();
			await shutdownStep("task-registry-maintenance", () => params.stopTaskRegistryMaintenance?.(), warnings);
			await shutdownStep("update-check", () => params.updateCheckStop?.(), warnings);
			for (const timer of params.nodePresenceTimers.values()) clearInterval(timer);
			params.nodePresenceTimers.clear();
			params.broadcast("shutdown", {
				reason,
				restartExpectedMs
			});
			clearInterval(params.tickInterval);
			clearInterval(params.healthInterval);
			clearInterval(params.dedupeCleanup);
			if (params.mediaCleanup) clearInterval(params.mediaCleanup);
			if (params.agentUnsub) await shutdownStep("agent-unsub", () => params.agentUnsub(), warnings);
			if (params.heartbeatUnsub) await shutdownStep("heartbeat-unsub", () => params.heartbeatUnsub(), warnings);
			if (params.transcriptUnsub) await shutdownStep("transcript-unsub", () => params.transcriptUnsub(), warnings);
			if (params.lifecycleUnsub) await shutdownStep("lifecycle-unsub", () => params.lifecycleUnsub(), warnings);
			params.chatRunState.clear();
			let clientCloseFailures = 0;
			for (const c of params.clients) try {
				c.socket.close(1012, "service restart");
			} catch {
				clientCloseFailures++;
			}
			if (clientCloseFailures > 0) {
				shutdownLog.warn(`failed to close ${clientCloseFailures} WebSocket client(s)`);
				recordShutdownWarning(warnings, "ws-clients");
			}
			params.clients.clear();
			await shutdownStep("config-reloader", () => params.configReloader.stop(), warnings);
			const wsClients = params.wss.clients ?? /* @__PURE__ */ new Set();
			const closePromise = new Promise((resolve) => params.wss.close(() => resolve()));
			const websocketGraceTimeout = createTimeoutRace(WEBSOCKET_CLOSE_GRACE_MS, () => false);
			const closedWithinGrace = await Promise.race([closePromise.then(() => true), websocketGraceTimeout.promise]);
			websocketGraceTimeout.clear();
			if (!closedWithinGrace) {
				shutdownLog.warn(`websocket server close exceeded ${WEBSOCKET_CLOSE_GRACE_MS}ms; forcing shutdown continuation with ${wsClients.size} tracked client(s)`);
				recordShutdownWarning(warnings, "websocket-server");
				for (const client of wsClients) try {
					client.terminate();
				} catch {}
				const websocketForceTimeout = createTimeoutRace(WEBSOCKET_CLOSE_FORCE_CONTINUE_MS, () => {
					shutdownLog.warn(`websocket server close still pending after ${WEBSOCKET_CLOSE_FORCE_CONTINUE_MS}ms force window; continuing shutdown`);
				});
				await Promise.race([closePromise, websocketForceTimeout.promise]);
				websocketForceTimeout.clear();
			}
			const servers = params.httpServers && params.httpServers.length > 0 ? params.httpServers : [params.httpServer];
			for (let i = 0; i < servers.length; i++) {
				const httpServer = servers[i];
				const label = servers.length > 1 ? `http-server[${i}]` : "http-server";
				if (typeof httpServer.closeIdleConnections === "function") httpServer.closeIdleConnections();
				const closePromise = new Promise((resolve, reject) => httpServer.close((err) => {
					if (!err || isServerNotRunningError(err)) {
						resolve();
						return;
					}
					reject(err);
				}));
				closePromise.catch(() => void 0);
				const httpGraceTimeout = createTimeoutRace(HTTP_CLOSE_GRACE_MS, () => false);
				const closedWithinGrace = await Promise.race([closePromise.then(() => true, (err) => {
					throw err;
				}), httpGraceTimeout.promise]).catch((err) => {
					const detail = err instanceof Error ? err.message : String(err);
					shutdownLog.warn(`${label}: ${detail}`);
					recordShutdownWarning(warnings, label);
					return true;
				});
				httpGraceTimeout.clear();
				if (!closedWithinGrace) {
					shutdownLog.warn(`${label} close exceeded ${HTTP_CLOSE_GRACE_MS}ms; forcing connection shutdown and waiting for close`);
					recordShutdownWarning(warnings, label);
					httpServer.closeAllConnections?.();
					const httpForceTimeout = createTimeoutRace(HTTP_CLOSE_FORCE_WAIT_MS, () => false);
					const closedAfterForce = await Promise.race([closePromise.then(() => true, (err) => {
						throw err;
					}), httpForceTimeout.promise]).catch((err) => {
						const detail = err instanceof Error ? err.message : String(err);
						shutdownLog.warn(`${label}: ${detail}`);
						recordShutdownWarning(warnings, label);
						return true;
					});
					httpForceTimeout.clear();
					if (!closedAfterForce) throw new Error(`${label} close still pending after forced connection shutdown (${HTTP_CLOSE_FORCE_WAIT_MS}ms)`);
				}
			}
		} finally {
			try {
				params.releasePluginRouteRegistry?.();
			} catch {}
		}
		const durationMs = Date.now() - start;
		if (warnings.length > 0) shutdownLog.warn(`shutdown completed in ${durationMs}ms with warnings: ${warnings.join(", ")}`);
		else shutdownLog.info(`shutdown completed cleanly in ${durationMs}ms`);
		return {
			durationMs,
			warnings
		};
	};
}
//#endregion
export { createGatewayCloseHandler, drainActiveSessionsForShutdown, runGatewayClosePrelude };
