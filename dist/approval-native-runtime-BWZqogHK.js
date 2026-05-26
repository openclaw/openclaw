import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as startGatewayClientWhenEventLoopReady } from "./client-start-readiness-zY0I9Wur.js";
import { l as readConnectErrorDetailCode } from "./connect-error-details-BNpp20bs.js";
import { t as createApprovalNativeRouteReporter } from "./approval-native-route-coordinator-7EKM2kRd.js";
import { t as buildChannelApprovalNativeTargetKey } from "./approval-native-target-key-D2RQhpuG.js";
import { t as createOperatorApprovalsGatewayClient } from "./operator-approvals-client-Dby3RB4d.js";
//#region src/infra/approval-native-delivery.ts
function dedupeTargets(targets) {
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const target of targets) {
		const key = buildChannelApprovalNativeTargetKey(target.target);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(target);
	}
	return deduped;
}
async function resolveChannelNativeApprovalDeliveryPlan(params) {
	const adapter = params.adapter;
	if (!adapter) return {
		targets: [],
		originTarget: null,
		notifyOriginWhenDmOnly: false
	};
	const capabilities = adapter.describeDeliveryCapabilities({
		cfg: params.cfg,
		accountId: params.accountId,
		approvalKind: params.approvalKind,
		request: params.request
	});
	if (!capabilities.enabled) return {
		targets: [],
		originTarget: null,
		notifyOriginWhenDmOnly: false
	};
	const originTarget = capabilities.supportsOriginSurface && adapter.resolveOriginTarget ? await adapter.resolveOriginTarget({
		cfg: params.cfg,
		accountId: params.accountId,
		approvalKind: params.approvalKind,
		request: params.request
	}) ?? null : null;
	const approverDmTargets = capabilities.supportsApproverDmSurface && adapter.resolveApproverDmTargets ? await adapter.resolveApproverDmTargets({
		cfg: params.cfg,
		accountId: params.accountId,
		approvalKind: params.approvalKind,
		request: params.request
	}) : [];
	const plannedTargets = [];
	const preferOrigin = capabilities.preferredSurface === "origin" || capabilities.preferredSurface === "both";
	const preferApproverDm = capabilities.preferredSurface === "approver-dm" || capabilities.preferredSurface === "both";
	if (preferOrigin && originTarget) plannedTargets.push({
		surface: "origin",
		target: originTarget,
		reason: "preferred"
	});
	if (preferApproverDm) for (const target of approverDmTargets) plannedTargets.push({
		surface: "approver-dm",
		target,
		reason: "preferred"
	});
	else if (!originTarget) for (const target of approverDmTargets) plannedTargets.push({
		surface: "approver-dm",
		target,
		reason: "fallback"
	});
	return {
		targets: dedupeTargets(plannedTargets),
		originTarget,
		notifyOriginWhenDmOnly: capabilities.preferredSurface === "approver-dm" && capabilities.notifyOriginWhenDmOnly === true && originTarget !== null
	};
}
//#endregion
//#region src/infra/exec-approval-channel-runtime.ts
var ExecApprovalChannelRuntimeTerminalStartError = class extends Error {
	constructor(info, cause) {
		super(`native approval gateway client paused reconnect after startup auth failure (${info.detailCode ?? "unknown"}): gateway closed (${info.code}): ${info.reason}`, cause === void 0 ? void 0 : { cause });
		this.name = "ExecApprovalChannelRuntimeTerminalStartError";
		this.detailCode = info.detailCode;
	}
};
function isExecApprovalChannelRuntimeTerminalStartError(error) {
	return error instanceof ExecApprovalChannelRuntimeTerminalStartError;
}
function resolveApprovalReplayMethods(eventKinds) {
	const methods = [];
	if (eventKinds.has("exec")) methods.push("exec.approval.list");
	if (eventKinds.has("plugin")) methods.push("plugin.approval.list");
	return methods;
}
function readGatewayConnectErrorDetailCode(error) {
	if (!error || typeof error !== "object") return null;
	return readConnectErrorDetailCode(error.details);
}
function createExecApprovalChannelRuntime(adapter) {
	const log = createSubsystemLogger(adapter.label);
	const nowMs = adapter.nowMs ?? Date.now;
	const eventKinds = new Set(adapter.eventKinds ?? ["exec"]);
	const pending = /* @__PURE__ */ new Map();
	let gatewayClient = null;
	let started = false;
	let shouldRun = false;
	let startPromise = null;
	let replayPromise = null;
	const shouldKeepRunning = () => shouldRun;
	const spawn = (label, promise) => {
		promise.catch((err) => {
			const message = formatErrorMessage(err);
			log.error(`${label}: ${message}`);
		});
	};
	const stopClientIfInactive = (client) => {
		if (shouldKeepRunning()) return false;
		gatewayClient = null;
		client.stop();
		return true;
	};
	const clearPendingEntry = (approvalId) => {
		const entry = pending.get(approvalId);
		if (!entry) return null;
		pending.delete(approvalId);
		if (entry.timeoutId) clearTimeout(entry.timeoutId);
		return entry;
	};
	const handleExpired = async (approvalId) => {
		const entry = clearPendingEntry(approvalId);
		if (!entry) return;
		log.debug(`expired ${approvalId}`);
		await adapter.finalizeExpired?.({
			request: entry.request,
			entries: entry.entries
		});
	};
	const handleRequested = async (request, opts) => {
		if (opts?.ignoreIfInactive && !shouldKeepRunning()) return;
		if (!adapter.shouldHandle(request)) return;
		if (pending.has(request.id)) {
			log.debug(`ignored duplicate request ${request.id}`);
			return;
		}
		log.debug(`received request ${request.id}`);
		const entry = {
			request,
			entries: [],
			timeoutId: null,
			delivering: true,
			pendingResolution: null
		};
		pending.set(request.id, entry);
		let entries;
		try {
			entries = await adapter.deliverRequested(request);
		} catch (err) {
			if (pending.get(request.id) === entry) clearPendingEntry(request.id);
			throw err;
		}
		if (pending.get(request.id) !== entry) return;
		if (!entries.length) {
			pending.delete(request.id);
			return;
		}
		entry.entries = entries;
		entry.delivering = false;
		if (entry.pendingResolution) {
			pending.delete(request.id);
			log.debug(`resolved ${entry.pendingResolution.id} with ${entry.pendingResolution.decision}`);
			await adapter.finalizeResolved({
				request: entry.request,
				resolved: entry.pendingResolution,
				entries: entry.entries
			});
			return;
		}
		const timeoutMs = Math.max(0, request.expiresAtMs - nowMs());
		const timeoutId = setTimeout(() => {
			spawn("error handling approval expiration", handleExpired(request.id));
		}, timeoutMs);
		timeoutId.unref?.();
		entry.timeoutId = timeoutId;
	};
	const handleResolved = async (resolved) => {
		const entry = pending.get(resolved.id);
		if (!entry) return;
		if (entry.delivering) {
			entry.pendingResolution = resolved;
			return;
		}
		const finalizedEntry = clearPendingEntry(resolved.id);
		if (!finalizedEntry) return;
		log.debug(`resolved ${resolved.id} with ${resolved.decision}`);
		await adapter.finalizeResolved({
			request: finalizedEntry.request,
			resolved,
			entries: finalizedEntry.entries
		});
	};
	const handleGatewayEvent = (evt) => {
		if (evt.event === "exec.approval.requested" && eventKinds.has("exec")) {
			spawn("error handling approval request", handleRequested(evt.payload, { ignoreIfInactive: true }));
			return;
		}
		if (evt.event === "plugin.approval.requested" && eventKinds.has("plugin")) {
			spawn("error handling approval request", handleRequested(evt.payload, { ignoreIfInactive: true }));
			return;
		}
		if (evt.event === "exec.approval.resolved" && eventKinds.has("exec")) {
			spawn("error handling approval resolved", handleResolved(evt.payload));
			return;
		}
		if (evt.event === "plugin.approval.resolved" && eventKinds.has("plugin")) spawn("error handling approval resolved", handleResolved(evt.payload));
	};
	const replayPendingApprovals = async (client) => {
		try {
			for (const method of resolveApprovalReplayMethods(eventKinds)) {
				if (stopClientIfInactive(client)) return;
				const pendingRequests = await client.request(method, {});
				if (stopClientIfInactive(client)) return;
				for (const request of pendingRequests) {
					if (stopClientIfInactive(client)) return;
					await handleRequested(request, { ignoreIfInactive: true });
				}
			}
		} catch (error) {
			if (!shouldKeepRunning()) return;
			throw error;
		}
	};
	const startPendingApprovalReplay = (client) => {
		const promise = replayPendingApprovals(client).catch((err) => {
			const message = formatErrorMessage(err);
			log.error(`error replaying pending approvals: ${message}`);
		}).finally(() => {
			if (replayPromise === promise) replayPromise = null;
		});
		replayPromise = promise;
	};
	const waitForPendingApprovalReplay = async () => {
		const replay = replayPromise;
		if (!replay) return;
		await replay.catch(() => {});
	};
	return {
		async start() {
			if (started) return;
			if (startPromise) {
				await startPromise;
				return;
			}
			shouldRun = true;
			startPromise = (async () => {
				if (!adapter.isConfigured()) {
					log.debug("disabled");
					return;
				}
				let readySettled = false;
				let resolveReady;
				let rejectReady;
				const ready = new Promise((resolve, reject) => {
					resolveReady = resolve;
					rejectReady = reject;
				});
				let lastConnectError = null;
				const settleReady = (fn) => {
					if (readySettled) return;
					readySettled = true;
					fn();
				};
				const client = await createOperatorApprovalsGatewayClient({
					config: adapter.cfg,
					gatewayUrl: adapter.gatewayUrl,
					clientDisplayName: adapter.clientDisplayName,
					onEvent: handleGatewayEvent,
					onHelloOk: () => {
						log.debug("connected to gateway");
						settleReady(resolveReady);
					},
					onConnectError: (err) => {
						log.error(`connect error: ${err.message}`);
						lastConnectError = err;
						if (readGatewayConnectErrorDetailCode(err)) return;
						settleReady(() => rejectReady(err));
					},
					onReconnectPaused: (info) => {
						settleReady(() => rejectReady(new ExecApprovalChannelRuntimeTerminalStartError(info, lastConnectError)));
					},
					onClose: (code, reason) => {
						log.debug(`gateway closed: ${code} ${reason}`);
						settleReady(() => rejectReady(lastConnectError ?? /* @__PURE__ */ new Error(`gateway closed: ${code} ${reason}`)));
					}
				});
				if (!shouldRun) {
					client.stop();
					return;
				}
				await adapter.beforeGatewayClientStart?.();
				gatewayClient = client;
				try {
					const readiness = await startGatewayClientWhenEventLoopReady(client, { clientOptions: { preauthHandshakeTimeoutMs: adapter.cfg.gateway?.handshakeTimeoutMs } });
					if (!readiness.ready) throw new Error(readiness.aborted ? "gateway approval runtime start aborted before readiness" : "gateway readiness unavailable before exec approval runtime start");
					await ready;
					if (stopClientIfInactive(client)) return;
					started = true;
					startPendingApprovalReplay(client);
				} catch (error) {
					gatewayClient = null;
					started = false;
					client.stop();
					throw error;
				}
			})().finally(() => {
				startPromise = null;
			});
			await startPromise;
		},
		async stop() {
			shouldRun = false;
			if (startPromise) await startPromise.catch(() => {});
			const wasActive = started || gatewayClient !== null || replayPromise !== null;
			started = false;
			gatewayClient?.stop();
			gatewayClient = null;
			await waitForPendingApprovalReplay();
			if (!wasActive) {
				await adapter.onStopped?.();
				return;
			}
			for (const entry of pending.values()) if (entry.timeoutId) clearTimeout(entry.timeoutId);
			pending.clear();
			await adapter.onStopped?.();
			log.debug("stopped");
		},
		handleRequested,
		handleResolved,
		handleExpired,
		async request(method, params) {
			if (!gatewayClient) throw new Error(`${adapter.label}: gateway client not connected`);
			return await gatewayClient.request(method, params);
		}
	};
}
//#endregion
//#region src/infra/approval-native-runtime.ts
async function deliverApprovalRequestViaChannelNativePlan(params) {
	const deliveryPlan = await resolveChannelNativeApprovalDeliveryPlan({
		cfg: params.cfg,
		accountId: params.accountId,
		approvalKind: params.approvalKind,
		request: params.request,
		adapter: params.adapter
	});
	const deliveredKeys = /* @__PURE__ */ new Set();
	const pendingEntries = [];
	const deliveredTargets = [];
	for (const plannedTarget of deliveryPlan.targets) try {
		const preparedTarget = await params.prepareTarget({
			plannedTarget,
			request: params.request
		});
		if (!preparedTarget) continue;
		if (deliveredKeys.has(preparedTarget.dedupeKey)) {
			params.onDuplicateSkipped?.({
				plannedTarget,
				preparedTarget,
				request: params.request
			});
			continue;
		}
		const entry = await params.deliverTarget({
			plannedTarget,
			preparedTarget: preparedTarget.target,
			request: params.request
		});
		if (!entry) continue;
		deliveredKeys.add(preparedTarget.dedupeKey);
		pendingEntries.push(entry);
		deliveredTargets.push(plannedTarget);
		params.onDelivered?.({
			plannedTarget,
			preparedTarget,
			request: params.request,
			entry
		});
	} catch (error) {
		params.onDeliveryError?.({
			error,
			plannedTarget,
			request: params.request
		});
	}
	return {
		entries: pendingEntries,
		deliveryPlan,
		deliveredTargets
	};
}
function defaultResolveApprovalKind(request) {
	return request.id.startsWith("plugin:") ? "plugin" : "exec";
}
function createChannelNativeApprovalRuntime(adapter) {
	const nowMs = adapter.nowMs ?? Date.now;
	const resolveApprovalKind = adapter.resolveApprovalKind ?? ((request) => defaultResolveApprovalKind(request));
	let runtimeRequest = null;
	const routeReporter = createApprovalNativeRouteReporter({
		handledKinds: new Set(adapter.eventKinds ?? ["exec"]),
		channel: adapter.channel,
		channelLabel: adapter.channelLabel,
		accountId: adapter.accountId,
		requestGateway: async (method, params) => {
			if (!runtimeRequest) throw new Error(`${adapter.label}: gateway client not connected`);
			return await runtimeRequest(method, params);
		}
	});
	const runtime = createExecApprovalChannelRuntime({
		label: adapter.label,
		clientDisplayName: adapter.clientDisplayName,
		cfg: adapter.cfg,
		gatewayUrl: adapter.gatewayUrl,
		eventKinds: adapter.eventKinds,
		isConfigured: adapter.isConfigured,
		shouldHandle: (request) => {
			const approvalKind = resolveApprovalKind(request);
			routeReporter.observeRequest({
				approvalKind,
				request
			});
			let shouldHandle;
			try {
				shouldHandle = adapter.shouldHandle(request);
			} catch (error) {
				routeReporter.reportSkipped({
					approvalKind,
					request
				});
				throw error;
			}
			if (shouldHandle) return shouldHandle;
			routeReporter.reportSkipped({
				approvalKind,
				request
			});
			return false;
		},
		finalizeResolved: adapter.finalizeResolved,
		finalizeExpired: adapter.finalizeExpired,
		onStopped: adapter.onStopped,
		beforeGatewayClientStart: () => {
			routeReporter.start();
		},
		nowMs,
		deliverRequested: async (request) => {
			const approvalKind = resolveApprovalKind(request);
			let deliveryPlan = {
				targets: [],
				originTarget: null,
				notifyOriginWhenDmOnly: false
			};
			let deliveredTargets = [];
			try {
				const pendingContent = await adapter.buildPendingContent({
					request,
					approvalKind,
					nowMs: nowMs()
				});
				const deliveryResult = await deliverApprovalRequestViaChannelNativePlan({
					cfg: adapter.cfg,
					accountId: adapter.accountId,
					approvalKind,
					request,
					adapter: adapter.nativeAdapter,
					prepareTarget: async ({ plannedTarget, request }) => await adapter.prepareTarget({
						plannedTarget,
						request,
						approvalKind,
						pendingContent
					}),
					deliverTarget: async ({ plannedTarget, preparedTarget, request }) => await adapter.deliverTarget({
						plannedTarget,
						preparedTarget,
						request,
						approvalKind,
						pendingContent
					}),
					onDeliveryError: adapter.onDeliveryError ? ({ error, plannedTarget, request }) => {
						adapter.onDeliveryError?.({
							error,
							plannedTarget,
							request,
							approvalKind,
							pendingContent
						});
					} : void 0,
					onDuplicateSkipped: adapter.onDuplicateSkipped ? ({ plannedTarget, preparedTarget, request }) => {
						adapter.onDuplicateSkipped?.({
							plannedTarget,
							preparedTarget,
							request,
							approvalKind,
							pendingContent
						});
					} : void 0,
					onDelivered: adapter.onDelivered ? ({ plannedTarget, preparedTarget, request, entry }) => {
						adapter.onDelivered?.({
							plannedTarget,
							preparedTarget,
							request,
							approvalKind,
							pendingContent,
							entry
						});
					} : void 0
				});
				deliveryPlan = deliveryResult.deliveryPlan;
				deliveredTargets = deliveryResult.deliveredTargets;
				return deliveryResult.entries;
			} finally {
				await routeReporter.reportDelivery({
					approvalKind,
					request,
					deliveryPlan,
					deliveredTargets
				});
			}
		}
	});
	runtimeRequest = (method, params) => runtime.request(method, params);
	return {
		...runtime,
		async start() {
			try {
				await runtime.start();
			} catch (error) {
				await routeReporter.stop();
				throw error;
			}
		},
		async stop() {
			await routeReporter.stop();
			await runtime.stop();
		}
	};
}
//#endregion
export { isExecApprovalChannelRuntimeTerminalStartError as a, createExecApprovalChannelRuntime as i, deliverApprovalRequestViaChannelNativePlan as n, resolveChannelNativeApprovalDeliveryPlan as o, ExecApprovalChannelRuntimeTerminalStartError as r, createChannelNativeApprovalRuntime as t };
