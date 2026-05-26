import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { n as disposeRegisteredAgentHarnesses } from "./registry-BiKIFOzv.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-DpfQDjis.js";
import { n as closePluginStateSqliteStore } from "./plugin-state-store-BqBrqTkQ.js";
import { i as listChannelPlugins } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { r as disposeAllSessionMcpRuntimes } from "./pi-bundle-mcp-runtime-CwBDIKIq.js";
import "./pi-bundle-mcp-tools-_xKQdIka.js";
import { t as abortChatRunById } from "./chat-abort-GHhFaqcz.js";
import { n as collectGatewayProcessMemoryUsageMb, o as measureGatewayRestartTrace, s as recordGatewayRestartTrace } from "./restart-trace-BKGWAIro.js";
import { r as drainActiveSessionsForShutdown } from "./session-reset-service-URLQHV3O.js";
//#region src/gateway/server-close.ts
const shutdownLog = createSubsystemLogger("gateway/shutdown");
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 5e3;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 1e4;
const ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS = 2e3;
const WEBSOCKET_CLOSE_GRACE_MS = 1e3;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1e3;
const HTTP_CLOSE_FORCE_WAIT_MS = 5e3;
const MCP_RUNTIME_CLOSE_GRACE_MS = 5e3;
const LSP_RUNTIME_CLOSE_GRACE_MS = 5e3;
const RESTART_REPLY_DRAIN_POLL_MS = 100;
const RESTART_REPLY_POST_ABORT_DRAIN_TIMEOUT_MS = 1e3;
const RESTART_REPLY_POST_ABORT_DRAIN_POLL_MS = 50;
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
function getRestartReplyDrainCounts(params) {
	const pendingReplyCount = params.getPendingReplyCount();
	const activeChatRuns = listRestartDrainChatRuns(params.chatAbortControllers).length;
	return {
		pendingReplies: Number.isFinite(pendingReplyCount) && pendingReplyCount > 0 ? Math.floor(pendingReplyCount) : 0,
		activeChatRuns
	};
}
function listRestartDrainChatRuns(chatAbortControllers) {
	return Array.from(chatAbortControllers.entries()).filter(([, entry]) => entry.kind !== "agent");
}
function formatRestartReplyDrainDetails(counts) {
	const details = [];
	if (counts.pendingReplies > 0) details.push(`${counts.pendingReplies} pending reply(ies)`);
	if (counts.activeChatRuns > 0) details.push(`${counts.activeChatRuns} active chat run(s)`);
	return details.length > 0 ? details.join(", ") : "no pending reply work";
}
async function sleepForRestartReplyDrain(delayMs) {
	await new Promise((resolve) => {
		setTimeout(resolve, delayMs).unref?.();
	});
}
async function waitForRestartReplyDrain(params) {
	const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
	const pollMs = Math.max(25, Math.floor(params.pollMs ?? RESTART_REPLY_DRAIN_POLL_MS));
	let counts = getRestartReplyDrainCounts(params);
	if (counts.pendingReplies <= 0 && counts.activeChatRuns <= 0) return {
		drained: true,
		elapsedMs: 0,
		counts
	};
	if (timeoutMs <= 0) return {
		drained: false,
		elapsedMs: 0,
		counts
	};
	const startedAt = Date.now();
	for (;;) {
		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= timeoutMs) return {
			drained: false,
			elapsedMs,
			counts
		};
		await sleepForRestartReplyDrain(Math.min(pollMs, timeoutMs - elapsedMs));
		counts = getRestartReplyDrainCounts(params);
		if (counts.pendingReplies <= 0 && counts.activeChatRuns <= 0) return {
			drained: true,
			elapsedMs: Date.now() - startedAt,
			counts
		};
	}
}
function abortActiveChatRunsForRestart(params) {
	let aborted = 0;
	for (const [runId, entry] of listRestartDrainChatRuns(params.chatAbortControllers)) if (abortChatRunById({
		chatAbortControllers: params.chatAbortControllers,
		chatRunBuffers: params.chatRunState.buffers,
		chatDeltaSentAt: params.chatRunState.deltaSentAt,
		chatDeltaLastBroadcastLen: params.chatRunState.deltaLastBroadcastLen,
		chatDeltaLastBroadcastText: params.chatRunState.deltaLastBroadcastText,
		agentDeltaSentAt: params.chatRunState.agentDeltaSentAt,
		bufferedAgentEvents: params.chatRunState.bufferedAgentEvents,
		chatAbortedRuns: params.chatRunState.abortedRuns,
		removeChatRun: params.removeChatRun,
		agentRunSeq: params.agentRunSeq,
		broadcast: params.broadcast,
		nodeSendToSession: params.nodeSendToSession
	}, {
		runId,
		sessionKey: entry.sessionKey,
		stopReason: "restart"
	}).aborted) aborted += 1;
	return aborted;
}
async function drainRestartPendingRepliesForShutdown(params) {
	const initialCounts = getRestartReplyDrainCounts(params);
	if (initialCounts.pendingReplies <= 0 && initialCounts.activeChatRuns <= 0) return;
	const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
	if (timeoutMs > 0) shutdownLog.info(`waiting for ${formatRestartReplyDrainDetails(initialCounts)} before restart shutdown (timeout ${timeoutMs}ms)`);
	const drainResult = await waitForRestartReplyDrain({
		getPendingReplyCount: params.getPendingReplyCount,
		chatAbortControllers: params.chatAbortControllers,
		timeoutMs
	});
	if (drainResult.drained) {
		shutdownLog.info(`restart reply drain completed after ${drainResult.elapsedMs}ms`);
		return;
	}
	shutdownLog.warn(`restart reply drain timed out after ${drainResult.elapsedMs}ms with ${formatRestartReplyDrainDetails(drainResult.counts)} still active; continuing shutdown`);
	recordShutdownWarning(params.warnings, "restart-reply-drain");
	if (drainResult.counts.activeChatRuns <= 0) return;
	const abortedRuns = abortActiveChatRunsForRestart(params);
	if (abortedRuns <= 0) return;
	shutdownLog.warn(`aborted ${abortedRuns} active chat run(s) during restart shutdown`);
	if ((await waitForRestartReplyDrain({
		getPendingReplyCount: params.getPendingReplyCount,
		chatAbortControllers: params.chatAbortControllers,
		timeoutMs: RESTART_REPLY_POST_ABORT_DRAIN_TIMEOUT_MS,
		pollMs: RESTART_REPLY_POST_ABORT_DRAIN_POLL_MS
	})).drained) shutdownLog.info("restart reply drain completed after abort cleanup");
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
	const { disposeAllBundleLspRuntimes } = await import("./pi-bundle-lsp-runtime-CwH9yzw2.js");
	await disposeAllBundleLspRuntimes();
}
async function stopGmailWatcherOnDemand() {
	const { stopGmailWatcher } = await import("./gmail-watcher-DG_lNeOd.js");
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
		const reason = (normalizeOptionalString(opts?.reason) ?? "") || "gateway stopping";
		const restartExpectedMs = typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs) ? Math.max(0, Math.floor(opts.restartExpectedMs)) : null;
		const measureCloseStep = (name, run) => measureGatewayRestartTrace(`restart.close.${name}`, run, [["reason", reason]]);
		try {
			shutdownLog.info(`shutdown started: ${reason}`);
			await measureCloseStep("gateway-shutdown-hook", () => shutdownStep("gateway:shutdown", async () => {
				if (await triggerGatewayLifecycleHookWithTimeout({
					event: createInternalHookEvent("gateway", "shutdown", "gateway:shutdown", {
						reason,
						restartExpectedMs
					}),
					hookName: "gateway:shutdown",
					timeoutMs: GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS
				}) === "timeout") recordShutdownWarning(warnings, "gateway:shutdown");
			}, warnings));
			if (restartExpectedMs !== null) await measureCloseStep("gateway-pre-restart-hook", () => shutdownStep("gateway:pre-restart", async () => {
				if (await triggerGatewayLifecycleHookWithTimeout({
					event: createInternalHookEvent("gateway", "pre-restart", "gateway:pre-restart", {
						reason,
						restartExpectedMs
					}),
					hookName: "gateway:pre-restart",
					timeoutMs: GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS
				}) === "timeout") recordShutdownWarning(warnings, "gateway:pre-restart");
			}, warnings));
			if (restartExpectedMs !== null && params.getPendingReplyCount) {
				const drainTimeoutMs = typeof opts?.drainTimeoutMs === "number" && Number.isFinite(opts.drainTimeoutMs) ? Math.max(0, Math.floor(opts.drainTimeoutMs)) : 0;
				await measureCloseStep("reply-drain", () => shutdownStep("restart-reply-drain", () => drainRestartPendingRepliesForShutdown({
					getPendingReplyCount: params.getPendingReplyCount,
					chatAbortControllers: params.chatAbortControllers,
					chatRunState: params.chatRunState,
					removeChatRun: params.removeChatRun,
					agentRunSeq: params.agentRunSeq,
					broadcast: params.broadcast,
					nodeSendToSession: params.nodeSendToSession,
					timeoutMs: drainTimeoutMs,
					warnings
				}), warnings));
			}
			if (params.drainActiveSessionsForShutdown) await measureCloseStep("session-end-drain", () => shutdownStep("session-end-drain", async () => {
				const drainReason = restartExpectedMs !== null ? "restart" : "shutdown";
				const result = await params.drainActiveSessionsForShutdown({
					reason: drainReason,
					totalTimeoutMs: ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS
				});
				if (result.timedOut) {
					shutdownLog.warn(`session-end-drain timed out after ${ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS}ms after ${result.emittedSessionIds.length} sessions; continuing shutdown`);
					recordShutdownWarning(warnings, "session-end-drain");
				}
			}, warnings));
			if (params.bonjourStop) await shutdownStep("bonjour", () => params.bonjourStop(), warnings);
			if (params.tailscaleCleanup) await shutdownStep("tailscale", () => params.tailscaleCleanup(), warnings);
			await measureCloseStep("channels", async () => {
				const channelIds = params.channelIds ?? listChannelPlugins().map((plugin) => plugin.id);
				for (const channelId of channelIds) await shutdownStep(`channel/${channelId}`, () => params.stopChannel(channelId), warnings);
			});
			await shutdownStep("agent-harnesses", () => disposeRegisteredAgentHarnesses(), warnings);
			await measureCloseStep("bundle-runtimes", async () => {
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
			});
			if (params.pluginServices) await measureCloseStep("plugin-services", () => shutdownStep("plugin-services", () => params.pluginServices.stop(), warnings));
			await shutdownStep("plugin-state-store", () => closePluginStateSqliteStore(), warnings);
			await measureCloseStep("config-reloader", () => shutdownStep("config-reloader", () => params.configReloader.stop(), warnings));
			await measureCloseStep("gmail-watcher", () => shutdownStep("gmail-watcher", () => stopGmailWatcherOnDemand(), warnings));
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
			await measureCloseStep("websocket-server", async () => {
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
			});
			await measureCloseStep("http-server", async () => {
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
			});
		} finally {
			try {
				params.releasePluginRouteRegistry?.();
			} catch {}
		}
		const durationMs = Date.now() - start;
		if (warnings.length > 0) shutdownLog.warn(`shutdown completed in ${durationMs}ms with warnings: ${warnings.join(", ")}`);
		else shutdownLog.info(`shutdown completed cleanly in ${durationMs}ms`);
		recordGatewayRestartTrace("restart.close.total", durationMs, [
			["reason", reason],
			["restartExpectedMs", restartExpectedMs ?? "none"],
			...collectGatewayProcessMemoryUsageMb()
		]);
		return {
			durationMs,
			warnings
		};
	};
}
//#endregion
export { createGatewayCloseHandler, drainActiveSessionsForShutdown, runGatewayClosePrelude };
