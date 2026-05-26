import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { m as resolveSecretInputRef } from "./types.secrets-DwPik3M8.js";
import { i as resolveManifestContractOwnerPluginId } from "./plugin-registry-CgH_ZSlH.js";
import { i as setPathExistingStrict, n as getPath } from "./path-utils-BCEW_1WB.js";
import { r as discoverConfigSecretTargetsByIds } from "./target-registry-t5xykQQS.js";
import { a as resolveSecretRefValue } from "./resolve-D1Ko6pWx.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { c as buildPluginApprovalRequestMessage, o as approvalDecisionLabel, s as buildPluginApprovalExpiredMessage, u as resolvePluginApprovalRequestAllowedDecisions } from "./plugin-approvals-BAd_Vwt-.js";
import { n as channelRouteDedupeKey } from "./channel-route-L2PJ-xNE.js";
import { n as getLoadedChannelPlugin } from "./registry-Bf5TpUad.js";
import { t as resolveChannelApprovalAdapter } from "./plugins-DYTHbmt7.js";
import { i as resolveBundledExplicitWebSearchProvidersFromPublicArtifacts } from "./web-provider-public-artifacts.explicit-BwvGaIk_.js";
import { D as resolveExecApprovalRequestAllowedDecisions } from "./exec-approvals-Bef7TPVc.js";
import { a as getActiveSecretsRuntimeSnapshot, r as getActiveSecretsRuntimeEnv } from "./runtime-state-CPpp7_ve.js";
import { t as assertExpectedResolvedSecretValue } from "./secret-value-BZ8grP0G.js";
import { n as collectCommandSecretAssignmentsFromSnapshot, t as analyzeCommandSecretAssignmentsFromSnapshot } from "./command-config-CauQG7Yw.js";
import { r as createResolverContext } from "./runtime-shared-CPFXAPqc.js";
import { t as resolveRuntimeWebTools } from "./runtime-web-tools-BWcHW4P-.js";
import { t as matchesApprovalRequestFilters } from "./approval-request-filters-CMNXbdNy.js";
import { d as formatExecApprovalExpiresIn } from "./exec-approval-reply-DtVFspP8.js";
import { i as sanitizeExecApprovalWarningText, t as resolveExecApprovalCommandDisplay } from "./exec-approval-command-display-DFkfeGi4.js";
import { i as buildPluginApprovalResolvedReplyPayload, n as buildApprovalResolvedReplyPayload, r as buildPluginApprovalPendingReplyPayload, t as buildApprovalPendingReplyPayload } from "./approval-renderers-DDenJTVv.js";
import { l as roleScopesAllow } from "./pairing-token-CX9_g8Xs.js";
import { l as listDevicePairing, s as hasEffectivePairedDeviceRole } from "./device-pairing-C3feAqgm.js";
import { a as diffConfigPaths, t as buildGatewayReloadPlan } from "./config-reload-plan-el2pIdzi.js";
import { a as resolveApnsAuthConfigFromEnv, c as sendApnsExecApprovalAlert, d as resolveApnsRelayConfigFromEnv, l as sendApnsExecApprovalResolvedWake, n as loadApnsRegistration, t as clearApnsRegistrationIfCurrent, u as shouldClearStoredApnsRegistration } from "./push-apns-CvAnrySM.js";
import { a as setCurrentSharedGatewaySessionGeneration, n as disconnectStaleSharedGatewayAuthClients } from "./server-shared-auth-generation-Csm1h6QK.js";
import "./server-aux-methods-7_eKUKOQ.js";
import { randomUUID } from "node:crypto";
//#region src/infra/exec-approval-forwarder.ts
const log = createSubsystemLogger("gateway/exec-approvals");
const DEFAULT_MODE = "session";
const SYNTHETIC_APPROVAL_REQUEST_ID = "__approval-routing__";
let execApprovalForwarderRuntimePromise = null;
function loadExecApprovalForwarderRuntime() {
	execApprovalForwarderRuntimePromise ??= import("./exec-approval-forwarder.runtime.js");
	return execApprovalForwarderRuntimePromise;
}
function normalizeMode(mode) {
	return mode ?? DEFAULT_MODE;
}
function shouldForwardRoute(params) {
	const config = params.config;
	if (!config?.enabled) return false;
	return matchesApprovalRequestFilters({
		request: params.routeRequest,
		agentFilter: config.agentFilter,
		sessionFilter: config.sessionFilter,
		fallbackAgentIdFromSessionKey: true
	});
}
function buildTargetKey(target) {
	return channelRouteDedupeKey({
		channel: normalizeMessageChannel(target.channel) ?? target.channel,
		to: target.to,
		accountId: target.accountId,
		threadId: target.threadId
	});
}
function buildSyntheticApprovalRequest(routeRequest) {
	return {
		id: SYNTHETIC_APPROVAL_REQUEST_ID,
		request: {
			command: "",
			agentId: routeRequest.agentId ?? null,
			sessionKey: routeRequest.sessionKey ?? null,
			turnSourceChannel: routeRequest.turnSourceChannel ?? null,
			turnSourceTo: routeRequest.turnSourceTo ?? null,
			turnSourceAccountId: routeRequest.turnSourceAccountId ?? null,
			turnSourceThreadId: routeRequest.turnSourceThreadId ?? null
		},
		createdAtMs: 0,
		expiresAtMs: 0
	};
}
function shouldSkipForwardingFallback(params) {
	const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
	if (!channel) return false;
	return resolveChannelApprovalAdapter(getLoadedChannelPlugin(channel))?.delivery?.shouldSuppressForwardingFallback?.({
		cfg: params.cfg,
		approvalKind: params.approvalKind,
		target: params.target,
		request: buildSyntheticApprovalRequest(params.routeRequest)
	}) ?? false;
}
function formatApprovalCommand(command) {
	if (!command.includes("\n") && !command.includes("`")) return {
		inline: true,
		text: `\`${command}\``
	};
	let fence = "```";
	while (command.includes(fence)) fence += "`";
	return {
		inline: false,
		text: `${fence}\n${command}\n${fence}`
	};
}
function buildExecApprovalRequestMessage(request, nowMs) {
	const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(request.request);
	const decisionText = allowedDecisions.join("|");
	const lines = ["🔒 Exec approval required", `ID: ${request.id}`];
	const warningText = request.request.warningText?.trim();
	if (warningText) lines.push("", warningText);
	const analysisWarningLines = request.request.commandAnalysis?.warningLines.map((line) => sanitizeExecApprovalWarningText(line).trim()).filter(Boolean).slice(0, 5);
	if (analysisWarningLines && analysisWarningLines.length > 0) {
		lines.push("", "Command analysis:");
		for (const line of analysisWarningLines) lines.push(`- ${line}`);
	}
	const command = formatApprovalCommand(resolveExecApprovalCommandDisplay(request.request).commandText);
	if (command.inline) lines.push(`Command: ${command.text}`);
	else {
		lines.push("Command:");
		lines.push(command.text);
	}
	if (request.request.cwd) lines.push(`CWD: ${request.request.cwd}`);
	if (request.request.nodeId) lines.push(`Node: ${request.request.nodeId}`);
	if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) lines.push(`Env overrides: ${request.request.envKeys.join(", ")}`);
	if (request.request.host) lines.push(`Host: ${request.request.host}`);
	if (request.request.agentId) lines.push(`Agent: ${request.request.agentId}`);
	if (request.request.security) lines.push(`Security: ${request.request.security}`);
	if (request.request.ask) lines.push(`Ask: ${request.request.ask}`);
	lines.push(`Expires in: ${formatExecApprovalExpiresIn(request.expiresAtMs, nowMs)}`);
	lines.push("Mode: foreground (interactive approvals available in this chat).");
	lines.push(allowedDecisions.includes("allow-always") ? "Background mode note: non-interactive runs cannot wait for chat approvals; use pre-approved policy (allow-always or ask=off)." : "Background mode note: non-interactive runs cannot wait for chat approvals; the effective policy still requires per-run approval unless ask=off.");
	lines.push(`Reply with: /approve <id> ${decisionText}`);
	if (!allowedDecisions.includes("allow-always")) lines.push("Allow Always is unavailable because the effective policy requires approval every time.");
	return lines.join("\n");
}
const decisionLabel = approvalDecisionLabel;
function buildResolvedMessage(resolved) {
	return `${`✅ Exec approval ${decisionLabel(resolved.decision)}.`}${resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : ""} ID: ${resolved.id}`;
}
function buildExpiredMessage(request) {
	return `⏱️ Exec approval expired. ID: ${request.id}`;
}
function normalizeTurnSourceChannel(value) {
	const normalized = value ? normalizeMessageChannel(value) : void 0;
	return normalized && isDeliverableMessageChannel(normalized) ? normalized : void 0;
}
function extractApprovalRouteRequest(request) {
	if (!request) return null;
	return {
		agentId: request.agentId ?? null,
		sessionKey: request.sessionKey ?? null,
		turnSourceChannel: request.turnSourceChannel ?? null,
		turnSourceTo: request.turnSourceTo ?? null,
		turnSourceAccountId: request.turnSourceAccountId ?? null,
		turnSourceThreadId: request.turnSourceThreadId ?? null
	};
}
function defaultResolveSessionTarget(params) {
	return loadExecApprovalForwarderRuntime().then(({ resolveExecApprovalSessionTarget }) => {
		const resolvedTarget = resolveExecApprovalSessionTarget({
			cfg: params.cfg,
			request: params.request,
			turnSourceChannel: normalizeTurnSourceChannel(params.request.request.turnSourceChannel),
			turnSourceTo: normalizeOptionalString(params.request.request.turnSourceTo),
			turnSourceAccountId: normalizeOptionalString(params.request.request.turnSourceAccountId),
			turnSourceThreadId: params.request.request.turnSourceThreadId ?? void 0
		});
		if (!resolvedTarget?.channel || !resolvedTarget.to) return null;
		const channel = resolvedTarget.channel;
		if (!isDeliverableMessageChannel(channel)) return null;
		return {
			channel,
			to: resolvedTarget.to,
			accountId: resolvedTarget.accountId,
			threadId: resolvedTarget.threadId
		};
	});
}
async function deliverToTargets(params) {
	const deliveries = params.targets.map(async (target) => {
		if (params.shouldSend && !params.shouldSend()) return;
		const channel = normalizeMessageChannel(target.channel) ?? target.channel;
		if (!isDeliverableMessageChannel(channel)) return;
		try {
			const payload = params.buildPayload(target);
			await params.beforeDeliver?.(target, payload);
			const send = await params.deliver({
				cfg: params.cfg,
				channel,
				to: target.to,
				accountId: target.accountId,
				threadId: target.threadId,
				payloads: [payload]
			});
			if (send.status === "failed" || send.status === "partial_failed") throw send.error;
		} catch (err) {
			log.error(`exec approvals: failed to deliver to ${channel}:${target.to}: ${String(err)}`);
		}
	});
	await Promise.allSettled(deliveries);
}
function buildApprovalRenderPayload(params) {
	const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
	return (channel ? params.resolveRenderer(resolveChannelApprovalAdapter(getLoadedChannelPlugin(channel)))?.(params.renderParams) : null) ?? params.buildFallback();
}
function buildExecPendingPayload(params) {
	return buildApprovalRenderPayload({
		target: params.target,
		renderParams: params,
		resolveRenderer: (adapter) => adapter?.render?.exec?.buildPendingPayload,
		buildFallback: () => buildApprovalPendingReplyPayload({
			approvalId: params.request.id,
			approvalSlug: params.request.id.slice(0, 8),
			text: buildExecApprovalRequestMessage(params.request, params.nowMs),
			agentId: params.request.request.agentId ?? null,
			allowedDecisions: resolveExecApprovalRequestAllowedDecisions(params.request.request),
			sessionKey: params.request.request.sessionKey ?? null
		})
	});
}
function buildExecResolvedPayload(params) {
	return buildApprovalRenderPayload({
		target: params.target,
		renderParams: params,
		resolveRenderer: (adapter) => adapter?.render?.exec?.buildResolvedPayload,
		buildFallback: () => buildApprovalResolvedReplyPayload({
			approvalId: params.resolved.id,
			approvalSlug: params.resolved.id.slice(0, 8),
			text: buildResolvedMessage(params.resolved)
		})
	});
}
function buildPluginPendingPayload(params) {
	return buildApprovalRenderPayload({
		target: params.target,
		renderParams: params,
		resolveRenderer: (adapter) => adapter?.render?.plugin?.buildPendingPayload,
		buildFallback: () => buildPluginApprovalPendingReplyPayload({
			request: params.request,
			nowMs: params.nowMs,
			text: buildPluginApprovalRequestMessage(params.request, params.nowMs),
			allowedDecisions: resolvePluginApprovalRequestAllowedDecisions(params.request.request)
		})
	});
}
function buildPluginResolvedPayload(params) {
	return buildApprovalRenderPayload({
		target: params.target,
		renderParams: params,
		resolveRenderer: (adapter) => adapter?.render?.plugin?.buildResolvedPayload,
		buildFallback: () => buildPluginApprovalResolvedReplyPayload({ resolved: params.resolved })
	});
}
async function resolveForwardTargets(params) {
	const mode = normalizeMode(params.config?.mode);
	const targets = [];
	const seen = /* @__PURE__ */ new Set();
	if (mode === "session" || mode === "both") {
		const sessionTarget = await params.resolveSessionTarget({
			cfg: params.cfg,
			request: buildSyntheticApprovalRequest(params.routeRequest)
		});
		if (sessionTarget) {
			const key = buildTargetKey(sessionTarget);
			if (!seen.has(key)) {
				seen.add(key);
				targets.push({
					...sessionTarget,
					source: "session"
				});
			}
		}
	}
	if (mode === "targets" || mode === "both") {
		const explicitTargets = params.config?.targets ?? [];
		for (const target of explicitTargets) {
			const key = buildTargetKey(target);
			if (seen.has(key)) continue;
			seen.add(key);
			targets.push({
				...target,
				source: "target"
			});
		}
	}
	return targets;
}
function createApprovalHandlers(params) {
	const pending = /* @__PURE__ */ new Map();
	const handleRequested = async (request) => {
		const cfg = params.getConfig();
		const config = params.strategy.config(cfg);
		const requestId = params.strategy.getRequestId(request);
		const routeRequest = params.strategy.getRouteRequestFromRequest(request);
		const filteredTargets = [...shouldForwardRoute({
			config,
			routeRequest
		}) ? await resolveForwardTargets({
			cfg,
			config,
			routeRequest,
			resolveSessionTarget: params.resolveSessionTarget
		}) : []].filter((target) => !shouldSkipForwardingFallback({
			approvalKind: params.strategy.kind,
			target,
			cfg,
			routeRequest
		}));
		if (filteredTargets.length === 0) return false;
		const expiresInMs = Math.max(0, params.strategy.getExpiresAtMs(request) - params.nowMs());
		const timeoutId = setTimeout(() => {
			(async () => {
				const entry = pending.get(requestId);
				if (!entry) return;
				pending.delete(requestId);
				await deliverToTargets({
					cfg,
					targets: entry.targets,
					buildPayload: () => ({ text: params.strategy.buildExpiredText(request) }),
					deliver: params.deliver
				});
			})();
		}, expiresInMs);
		timeoutId.unref?.();
		const pendingEntry = {
			routeRequest,
			targets: filteredTargets,
			timeoutId
		};
		pending.set(requestId, pendingEntry);
		if (pending.get(requestId) !== pendingEntry) return false;
		deliverToTargets({
			cfg,
			targets: filteredTargets,
			buildPayload: (target) => params.strategy.buildPendingPayload({
				cfg,
				request,
				target,
				routeRequest,
				nowMs: params.nowMs()
			}),
			beforeDeliver: async (target, payload) => {
				const channel = normalizeMessageChannel(target.channel) ?? target.channel;
				if (!channel) return;
				await getLoadedChannelPlugin(channel)?.outbound?.beforeDeliverPayload?.({
					cfg,
					target,
					payload,
					hint: {
						kind: "approval-pending",
						approvalKind: params.strategy.kind
					}
				});
			},
			deliver: params.deliver,
			shouldSend: () => pending.get(requestId) === pendingEntry
		}).catch((err) => {
			log.error(`${params.strategy.kind} approvals: failed to deliver request ${requestId}: ${String(err)}`);
		});
		return true;
	};
	const handleResolved = async (resolved) => {
		const resolvedId = params.strategy.getResolvedId(resolved);
		const entry = pending.get(resolvedId);
		if (entry?.timeoutId) clearTimeout(entry.timeoutId);
		if (entry) pending.delete(resolvedId);
		const cfg = params.getConfig();
		let targets = entry?.targets;
		if (!targets) {
			const routeRequest = params.strategy.getRouteRequestFromResolved(resolved);
			if (routeRequest) {
				const config = params.strategy.config(cfg);
				targets = [...shouldForwardRoute({
					config,
					routeRequest
				}) ? await resolveForwardTargets({
					cfg,
					config,
					routeRequest,
					resolveSessionTarget: params.resolveSessionTarget
				}) : []].filter((target) => !shouldSkipForwardingFallback({
					approvalKind: params.strategy.kind,
					target,
					cfg,
					routeRequest
				}));
			}
		}
		if (!targets?.length) return;
		await deliverToTargets({
			cfg,
			targets,
			buildPayload: (target) => params.strategy.buildResolvedPayload({
				cfg,
				resolved,
				target,
				routeRequest: entry?.routeRequest ?? params.strategy.getRouteRequestFromResolved(resolved) ?? {}
			}),
			deliver: params.deliver
		});
	};
	const stop = () => {
		for (const entry of pending.values()) if (entry.timeoutId) clearTimeout(entry.timeoutId);
		pending.clear();
	};
	return {
		handleRequested,
		handleResolved,
		stop
	};
}
function createApprovalStrategy(params) {
	return {
		kind: params.kind,
		config: params.config,
		getRequestId: (request) => request.id,
		getResolvedId: (resolved) => resolved.id,
		getExpiresAtMs: (request) => request.expiresAtMs,
		getRouteRequestFromRequest: (request) => extractApprovalRouteRequest(request.request) ?? {},
		getRouteRequestFromResolved: (resolved) => extractApprovalRouteRequest(resolved.request),
		buildExpiredText: params.buildExpiredText,
		buildPendingPayload: params.buildPendingPayload,
		buildResolvedPayload: params.buildResolvedPayload
	};
}
const execApprovalStrategy = createApprovalStrategy({
	kind: "exec",
	config: (cfg) => cfg.approvals?.exec,
	buildExpiredText: buildExpiredMessage,
	buildPendingPayload: ({ cfg, request, target, nowMs }) => buildExecPendingPayload({
		cfg,
		request,
		target,
		nowMs
	}),
	buildResolvedPayload: ({ cfg, resolved, target }) => buildExecResolvedPayload({
		cfg,
		resolved,
		target
	})
});
const pluginApprovalStrategy = createApprovalStrategy({
	kind: "plugin",
	config: (cfg) => cfg.approvals?.plugin,
	buildExpiredText: buildPluginApprovalExpiredMessage,
	buildPendingPayload: ({ cfg, request, target, nowMs }) => buildPluginPendingPayload({
		cfg,
		request,
		target,
		nowMs
	}),
	buildResolvedPayload: ({ cfg, resolved, target }) => buildPluginResolvedPayload({
		cfg,
		resolved,
		target
	})
});
function createExecApprovalForwarder(deps = {}) {
	const getConfig = deps.getConfig ?? getRuntimeConfig;
	const deliver = deps.deliver ?? (async (params) => {
		const { sendDurableMessageBatch } = await loadExecApprovalForwarderRuntime();
		return sendDurableMessageBatch(params);
	});
	const nowMs = deps.nowMs ?? Date.now;
	const resolveSessionTarget = deps.resolveSessionTarget ?? defaultResolveSessionTarget;
	const execHandlers = createApprovalHandlers({
		strategy: execApprovalStrategy,
		getConfig,
		deliver,
		nowMs,
		resolveSessionTarget
	});
	const pluginHandlers = createApprovalHandlers({
		strategy: pluginApprovalStrategy,
		getConfig,
		deliver,
		nowMs,
		resolveSessionTarget
	});
	return {
		handleRequested: execHandlers.handleRequested,
		handleResolved: execHandlers.handleResolved,
		handlePluginApprovalRequested: pluginHandlers.handleRequested,
		handlePluginApprovalResolved: pluginHandlers.handleResolved,
		stop: () => {
			execHandlers.stop();
			pluginHandlers.stop();
		}
	};
}
//#endregion
//#region src/secrets/runtime-command-secrets.ts
function hasProviderOverrides(overrides) {
	return normalizeOptionalString(overrides?.webSearch) !== void 0 || normalizeOptionalString(overrides?.webFetch) !== void 0;
}
function applyProviderOverridesToConfig(config, overrides) {
	if (!hasProviderOverrides(overrides)) return config;
	const next = structuredClone(config);
	const tools = next.tools ??= {};
	const web = tools.web ??= {};
	const webSearch = normalizeOptionalString(overrides?.webSearch);
	if (webSearch) {
		const search = web.search ??= {};
		search.provider = webSearch;
	}
	const webFetch = normalizeOptionalString(overrides?.webFetch);
	if (webFetch) {
		const fetch = web.fetch ??= {};
		fetch.provider = webFetch;
	}
	return next;
}
function pluginIdFromRuntimeWebPath(path) {
	return /^plugins\.entries\.([^.]+)\.config\.(webSearch|webFetch)\.apiKey$/.exec(path)?.[1];
}
function searchProviderFromDirectWebPath(path) {
	return /^tools\.web\.search\.([^.]+)\.apiKey$/.exec(path)?.[1];
}
function fetchProviderFromDirectWebPath(path) {
	return /^tools\.web\.fetch\.([^.]+)\.apiKey$/.exec(path)?.[1];
}
function isWebCommandSecretPath(path) {
	return path === "tools.web.search.apiKey" || /^tools\.web\.(search|fetch)\.[^.]+\.apiKey$/.test(path) || /^plugins\.entries\.[^.]+\.config\.(webSearch|webFetch)\.apiKey$/.test(path);
}
function webSearchProviderUsesSharedSearchCredential(params) {
	const sentinel = "__openclaw_shared_web_search_probe__";
	const pluginId = resolveManifestContractOwnerPluginId({
		contract: "webSearchProviders",
		value: params.provider,
		origin: "bundled",
		config: params.config
	});
	if (!pluginId) return false;
	const provider = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({ onlyPluginIds: [pluginId] })?.find((entry) => entry.id === params.provider);
	return provider?.credentialPath === "tools.web.search.apiKey" || provider?.getCredentialValue({ apiKey: sentinel }) === sentinel || provider?.getConfiguredCredentialFallback?.(params.config)?.path === "tools.web.search.apiKey";
}
function isProviderOverridePath(params) {
	const webSearch = normalizeOptionalString(params.providerOverrides?.webSearch);
	if (webSearch) {
		if (params.config.tools?.web?.search?.enabled === false) return false;
		if (params.path === "tools.web.search.apiKey") return webSearchProviderUsesSharedSearchCredential({
			config: params.config,
			provider: webSearch
		});
		const directProvider = searchProviderFromDirectWebPath(params.path);
		if (directProvider) return directProvider === webSearch;
		const pluginId = pluginIdFromRuntimeWebPath(params.path);
		if (pluginId && params.path.endsWith(".config.webSearch.apiKey")) return resolveManifestContractOwnerPluginId({
			contract: "webSearchProviders",
			value: webSearch,
			origin: "bundled",
			config: params.config
		}) === pluginId;
	}
	const webFetch = normalizeOptionalString(params.providerOverrides?.webFetch);
	if (webFetch) {
		if (params.config.tools?.web?.fetch?.enabled === false) return false;
		const directProvider = fetchProviderFromDirectWebPath(params.path);
		if (directProvider) return directProvider === webFetch;
		const pluginId = pluginIdFromRuntimeWebPath(params.path);
		if (pluginId && params.path.endsWith(".config.webFetch.apiKey")) return resolveManifestContractOwnerPluginId({
			contract: "webFetchProviders",
			value: webFetch,
			origin: "bundled",
			config: params.config
		}) === pluginId;
	}
	return false;
}
function restoreInactiveWebCommandSecretTargets(params) {
	if (!hasProviderOverrides(params.providerOverrides)) return params.inactiveRefPaths;
	const inactive = new Set(params.inactiveRefPaths);
	const defaults = params.sourceConfig.secrets?.defaults;
	for (const target of discoverConfigSecretTargetsByIds(params.sourceConfig, params.targetIds)) {
		if (params.allowedPaths && !params.allowedPaths.has(target.path)) continue;
		if (!isWebCommandSecretPath(target.path)) continue;
		const { ref } = resolveSecretInputRef({
			value: target.value,
			refValue: target.refValue,
			defaults
		});
		if (!ref) continue;
		if (params.forcedActivePaths?.has(target.path) || params.optionalActivePaths?.has(target.path)) continue;
		if (isProviderOverridePath({
			config: params.sourceConfig,
			path: target.path,
			providerOverrides: params.providerOverrides
		})) continue;
		inactive.add(target.path);
		setPathExistingStrict(params.resolvedConfig, target.pathSegments, target.value);
	}
	return [...inactive];
}
function filterInactiveRefPaths(params) {
	return params.inactiveRefPaths.filter((path) => {
		if (params.allowedPaths && !params.allowedPaths.has(path)) return false;
		if (params.forcedActivePaths?.has(path) || params.optionalActivePaths?.has(path)) return false;
		if (!hasProviderOverrides(params.providerOverrides)) return true;
		return !isProviderOverridePath({
			config: params.config,
			path,
			providerOverrides: params.providerOverrides
		});
	});
}
function mirrorResolvedProviderCredentialToDirectPath(params) {
	const provider = normalizeOptionalString(params.provider);
	if (!provider) return;
	const pluginId = resolveManifestContractOwnerPluginId({
		contract: params.contract,
		value: provider,
		origin: "bundled",
		config: params.config
	});
	if (!pluginId) return;
	const directSegments = [
		...params.directPathPrefix.split("."),
		provider,
		"apiKey"
	];
	if (getPath(params.config, directSegments) === void 0) return;
	const resolvedValue = getPath(params.resolvedConfig, [
		"plugins",
		"entries",
		pluginId,
		"config",
		params.pluginConfigKey,
		"apiKey"
	]);
	if (typeof resolvedValue !== "string" || resolvedValue.length === 0) return;
	setPathExistingStrict(params.resolvedConfig, directSegments, resolvedValue);
}
function mirrorResolvedProviderCredentialToDirectPaths(params) {
	const configuredSearchProvider = normalizeOptionalString(params.providerOverrides?.webSearch) ?? normalizeOptionalString(params.config.tools?.web?.search?.provider);
	const configuredFetchProvider = normalizeOptionalString(params.providerOverrides?.webFetch) ?? normalizeOptionalString(params.config.tools?.web?.fetch?.provider);
	mirrorResolvedProviderCredentialToDirectPath({
		config: params.config,
		resolvedConfig: params.resolvedConfig,
		contract: "webSearchProviders",
		provider: configuredSearchProvider,
		directPathPrefix: "tools.web.search",
		pluginConfigKey: "webSearch"
	});
	mirrorResolvedProviderCredentialToDirectPath({
		config: params.config,
		resolvedConfig: params.resolvedConfig,
		contract: "webFetchProviders",
		provider: configuredFetchProvider,
		directPathPrefix: "tools.web.fetch",
		pluginConfigKey: "webFetch"
	});
	const webSearch = configuredSearchProvider;
	if (webSearch && webSearchProviderUsesSharedSearchCredential({
		config: params.config,
		provider: webSearch
	}) && getPath(params.config, [
		"tools",
		"web",
		"search",
		"apiKey"
	]) !== void 0) {
		const pluginId = resolveManifestContractOwnerPluginId({
			contract: "webSearchProviders",
			value: webSearch,
			origin: "bundled",
			config: params.config
		});
		const resolvedValue = pluginId ? getPath(params.resolvedConfig, [
			"plugins",
			"entries",
			pluginId,
			"config",
			"webSearch",
			"apiKey"
		]) : void 0;
		if (typeof resolvedValue === "string" && resolvedValue.length > 0) setPathExistingStrict(params.resolvedConfig, [
			"tools",
			"web",
			"search",
			"apiKey"
		], resolvedValue);
	}
}
async function resolveForcedActiveCommandSecretTargets(params) {
	const activePaths = new Set([...params.forcedActivePaths ?? [], ...params.optionalActivePaths ?? []]);
	if (activePaths.size === 0) return;
	const context = createResolverContext({
		sourceConfig: params.sourceConfig,
		env: getActiveSecretsRuntimeEnv()
	});
	const defaults = params.sourceConfig.secrets?.defaults;
	for (const target of discoverConfigSecretTargetsByIds(params.sourceConfig, params.targetIds)) {
		if (params.allowedPaths && !params.allowedPaths.has(target.path)) continue;
		if (!activePaths.has(target.path)) continue;
		const { ref } = resolveSecretInputRef({
			value: target.value,
			refValue: target.refValue,
			defaults
		});
		if (!ref) continue;
		try {
			const resolved = await resolveSecretRefValue(ref, {
				config: params.sourceConfig,
				env: context.env,
				cache: context.cache
			});
			assertExpectedResolvedSecretValue({
				value: resolved,
				expected: target.entry.expectedResolvedValue,
				errorMessage: target.entry.expectedResolvedValue === "string" ? `${target.path} resolved to a non-string or empty value.` : `${target.path} resolved to an unsupported value type.`
			});
			setPathExistingStrict(params.resolvedConfig, target.pathSegments, resolved);
		} catch {}
	}
}
function resolveCommandSecretsFromActiveRuntimeSnapshot(params) {
	const activeSnapshot = getActiveSecretsRuntimeSnapshot();
	if (!activeSnapshot) throw new Error("Secrets runtime snapshot is not active.");
	if (params.targetIds.size === 0) return Promise.resolve({
		assignments: [],
		diagnostics: [],
		inactiveRefPaths: []
	});
	return resolveCommandSecretsFromSnapshot({
		activeSnapshot,
		commandName: params.commandName,
		targetIds: params.targetIds,
		allowedPaths: params.allowedPaths,
		forcedActivePaths: params.forcedActivePaths,
		optionalActivePaths: params.optionalActivePaths,
		providerOverrides: params.providerOverrides
	});
}
async function resolveCommandSecretsFromSnapshot(params) {
	const hasOverrides = hasProviderOverrides(params.providerOverrides);
	const sourceConfig = applyProviderOverridesToConfig(params.activeSnapshot.sourceConfig, params.providerOverrides);
	const resolvedConfig = applyProviderOverridesToConfig(params.activeSnapshot.config, params.providerOverrides);
	const context = hasOverrides ? createResolverContext({
		sourceConfig,
		env: getActiveSecretsRuntimeEnv()
	}) : void 0;
	if (context) await resolveRuntimeWebTools({
		sourceConfig,
		resolvedConfig,
		context
	});
	mirrorResolvedProviderCredentialToDirectPaths({
		config: sourceConfig,
		resolvedConfig,
		providerOverrides: params.providerOverrides
	});
	await resolveForcedActiveCommandSecretTargets({
		sourceConfig,
		resolvedConfig,
		targetIds: params.targetIds,
		allowedPaths: params.allowedPaths,
		forcedActivePaths: params.forcedActivePaths,
		optionalActivePaths: params.optionalActivePaths
	});
	const warningSource = context?.warnings ?? params.activeSnapshot.warnings;
	let inactiveRefPaths = filterInactiveRefPaths({
		config: sourceConfig,
		providerOverrides: params.providerOverrides,
		allowedPaths: params.allowedPaths,
		forcedActivePaths: params.forcedActivePaths,
		optionalActivePaths: params.optionalActivePaths,
		inactiveRefPaths: [...new Set(warningSource.filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE").map((warning) => warning.path))]
	});
	inactiveRefPaths = restoreInactiveWebCommandSecretTargets({
		sourceConfig,
		resolvedConfig,
		targetIds: params.targetIds,
		inactiveRefPaths,
		providerOverrides: params.providerOverrides,
		allowedPaths: params.allowedPaths,
		forcedActivePaths: params.forcedActivePaths,
		optionalActivePaths: params.optionalActivePaths
	});
	let analyzed = analyzeCommandSecretAssignmentsFromSnapshot({
		sourceConfig,
		resolvedConfig,
		targetIds: params.targetIds,
		inactiveRefPaths: new Set(inactiveRefPaths),
		...params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}
	});
	if (hasOverrides) {
		const impliedInactivePaths = analyzed.unresolved.filter((entry) => isWebCommandSecretPath(entry.path)).filter((entry) => !isProviderOverridePath({
			config: sourceConfig,
			path: entry.path,
			providerOverrides: params.providerOverrides
		})).map((entry) => entry.path);
		if (impliedInactivePaths.length > 0) {
			inactiveRefPaths = [...new Set([...inactiveRefPaths, ...impliedInactivePaths])];
			analyzed = analyzeCommandSecretAssignmentsFromSnapshot({
				sourceConfig,
				resolvedConfig,
				targetIds: params.targetIds,
				inactiveRefPaths: new Set(inactiveRefPaths),
				...params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}
			});
		}
	}
	const optionalActiveUnresolvedPaths = analyzed.unresolved.filter((entry) => params.optionalActivePaths?.has(entry.path)).map((entry) => entry.path);
	if (optionalActiveUnresolvedPaths.length > 0) {
		inactiveRefPaths = [...new Set([...inactiveRefPaths, ...optionalActiveUnresolvedPaths])];
		analyzed = analyzeCommandSecretAssignmentsFromSnapshot({
			sourceConfig,
			resolvedConfig,
			targetIds: params.targetIds,
			inactiveRefPaths: new Set(inactiveRefPaths),
			...params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}
		});
	}
	const selectedProviderUnresolved = analyzed.unresolved.filter((entry) => isProviderOverridePath({
		config: sourceConfig,
		path: entry.path,
		providerOverrides: params.providerOverrides
	}));
	const forcedActiveUnresolved = analyzed.unresolved.filter((entry) => params.forcedActivePaths?.has(entry.path));
	if (selectedProviderUnresolved.length > 0 || forcedActiveUnresolved.length > 0) return {
		assignments: analyzed.assignments,
		diagnostics: analyzed.diagnostics,
		inactiveRefPaths
	};
	const resolved = collectCommandSecretAssignmentsFromSnapshot({
		sourceConfig,
		resolvedConfig,
		commandName: params.commandName,
		targetIds: params.targetIds,
		inactiveRefPaths: new Set(inactiveRefPaths),
		...params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}
	});
	return {
		assignments: resolved.assignments,
		diagnostics: resolved.diagnostics,
		inactiveRefPaths
	};
}
//#endregion
//#region src/gateway/exec-approval-ios-push.ts
const APPROVALS_SCOPE = "operator.approvals";
const OPERATOR_ROLE = "operator";
function isIosPlatform(platform) {
	const normalized = normalizeOptionalLowercaseString(platform) ?? "";
	return normalized.startsWith("ios") || normalized.startsWith("ipados");
}
function resolveActiveOperatorToken(device) {
	const operatorToken = device.tokens?.[OPERATOR_ROLE];
	if (!operatorToken || operatorToken.revokedAtMs) return null;
	return operatorToken;
}
function canApproveExecRequests(device) {
	const operatorToken = resolveActiveOperatorToken(device);
	if (!operatorToken) return false;
	return roleScopesAllow({
		role: OPERATOR_ROLE,
		requestedScopes: [APPROVALS_SCOPE],
		allowedScopes: operatorToken.scopes
	});
}
function shouldTargetDevice(params) {
	if (!isIosPlatform(params.device.platform)) return false;
	if (!hasEffectivePairedDeviceRole(params.device, OPERATOR_ROLE)) return false;
	if (!params.requireApprovalScope) return true;
	return canApproveExecRequests(params.device);
}
async function loadRegisteredTargets(params) {
	return (await Promise.all(params.deviceIds.map(async (nodeId) => {
		const registration = await loadApnsRegistration(nodeId);
		return registration ? {
			nodeId,
			registration
		} : null;
	}))).filter((target) => target !== null);
}
async function resolvePairedTargets(params) {
	return await loadRegisteredTargets({ deviceIds: (await listDevicePairing()).paired.filter((device) => {
		if (!shouldTargetDevice({
			device,
			requireApprovalScope: params.requireApprovalScope
		})) return false;
		const operatorToken = resolveActiveOperatorToken(device);
		if (params.isTargetVisible && !params.isTargetVisible({
			deviceId: device.deviceId,
			scopes: operatorToken?.scopes ?? []
		})) return false;
		return true;
	}).map((device) => device.deviceId) });
}
async function resolveDeliveryPlan(params) {
	const targets = params.explicitNodeIds?.length ? await loadRegisteredTargets({ deviceIds: params.explicitNodeIds }) : await resolvePairedTargets({
		requireApprovalScope: params.requireApprovalScope,
		isTargetVisible: params.isTargetVisible
	});
	if (targets.length === 0) return { targets: [] };
	const needsDirect = targets.some((target) => target.registration.transport === "direct");
	const needsRelay = targets.some((target) => target.registration.transport === "relay");
	let directAuth;
	if (needsDirect) {
		const auth = await resolveApnsAuthConfigFromEnv(process.env);
		if (auth.ok) directAuth = auth.value;
		else params.log.warn?.(`exec approvals: iOS direct APNs auth unavailable: ${auth.error}`);
	}
	let relayConfig;
	if (needsRelay) {
		const relay = resolveApnsRelayConfigFromEnv(process.env, getRuntimeConfig().gateway);
		if (relay.ok) relayConfig = relay.value;
		else params.log.warn?.(`exec approvals: iOS relay APNs config unavailable: ${relay.error}`);
	}
	return {
		targets: targets.filter((target) => target.registration.transport === "direct" ? Boolean(directAuth) : Boolean(relayConfig)),
		directAuth,
		relayConfig
	};
}
async function clearStaleApnsRegistrationIfNeeded(params) {
	if (shouldClearStoredApnsRegistration({
		registration: params.registration,
		result: params.result
	})) await clearApnsRegistrationIfCurrent({
		nodeId: params.nodeId,
		registration: params.registration
	});
}
async function sendRequestedPushes(params) {
	const results = await Promise.allSettled(params.plan.targets.map(async (target) => {
		const result = target.registration.transport === "direct" ? await sendApnsExecApprovalAlert({
			registration: target.registration,
			nodeId: target.nodeId,
			approvalId: params.request.id,
			auth: params.plan.directAuth
		}) : await sendApnsExecApprovalAlert({
			registration: target.registration,
			nodeId: target.nodeId,
			approvalId: params.request.id,
			relayConfig: params.plan.relayConfig
		});
		await clearStaleApnsRegistrationIfNeeded({
			nodeId: target.nodeId,
			registration: target.registration,
			result
		});
		if (!result.ok) params.log.warn?.(`exec approvals: iOS request push failed node=${target.nodeId} status=${result.status} reason=${result.reason ?? "unknown"}`);
		return {
			nodeId: target.nodeId,
			ok: result.ok
		};
	}));
	for (const result of results) if (result.status === "rejected") {
		const message = formatErrorMessage(result.reason);
		params.log.warn?.(`exec approvals: iOS request push threw error: ${message}`);
	}
	return {
		attempted: params.plan.targets.length,
		delivered: results.filter((result) => result.status === "fulfilled" && result.value.ok).length
	};
}
async function sendResolvedPushes(params) {
	await Promise.allSettled(params.plan.targets.map(async (target) => {
		const result = target.registration.transport === "direct" ? await sendApnsExecApprovalResolvedWake({
			registration: target.registration,
			nodeId: target.nodeId,
			approvalId: params.approvalId,
			auth: params.plan.directAuth
		}) : await sendApnsExecApprovalResolvedWake({
			registration: target.registration,
			nodeId: target.nodeId,
			approvalId: params.approvalId,
			relayConfig: params.plan.relayConfig
		});
		await clearStaleApnsRegistrationIfNeeded({
			nodeId: target.nodeId,
			registration: target.registration,
			result
		});
		if (!result.ok) params.log.warn?.(`exec approvals: iOS cleanup push failed node=${target.nodeId} status=${result.status} reason=${result.reason ?? "unknown"}`);
	}));
}
function createExecApprovalIosPushDelivery(params) {
	const approvalDeliveriesById = /* @__PURE__ */ new Map();
	const pendingDeliveryStateById = /* @__PURE__ */ new Map();
	return {
		async handleRequested(request, opts) {
			const deliveryStatePromise = (async () => {
				const plan = await resolveDeliveryPlan({
					requireApprovalScope: true,
					isTargetVisible: opts?.isTargetVisible,
					log: params.log
				});
				if (plan.targets.length === 0) {
					approvalDeliveriesById.delete(request.id);
					return null;
				}
				const deliveryState = {
					nodeIds: plan.targets.map((target) => target.nodeId),
					requestPushPromise: sendRequestedPushes({
						request,
						plan,
						log: params.log
					}).catch((err) => {
						const message = formatErrorMessage(err);
						params.log.error?.(`exec approvals: iOS request push failed: ${message}`);
						return {
							attempted: plan.targets.length,
							delivered: 0
						};
					})
				};
				approvalDeliveriesById.set(request.id, deliveryState);
				return deliveryState;
			})();
			pendingDeliveryStateById.set(request.id, deliveryStatePromise);
			const deliveryState = await deliveryStatePromise;
			if (pendingDeliveryStateById.get(request.id) === deliveryStatePromise) pendingDeliveryStateById.delete(request.id);
			if (!deliveryState) return false;
			const { attempted, delivered } = await deliveryState.requestPushPromise;
			if (attempted > 0 && delivered === 0) {
				params.log.warn?.(`exec approvals: iOS request push reached no devices approvalId=${request.id} attempted=${attempted}`);
				if (approvalDeliveriesById.get(request.id)?.requestPushPromise === deliveryState.requestPushPromise) approvalDeliveriesById.delete(request.id);
				return false;
			}
			return true;
		},
		async handleResolved(resolved) {
			const deliveryState = approvalDeliveriesById.get(resolved.id) ?? await pendingDeliveryStateById.get(resolved.id);
			approvalDeliveriesById.delete(resolved.id);
			pendingDeliveryStateById.delete(resolved.id);
			if (!deliveryState?.nodeIds.length) {
				params.log.debug?.(`exec approvals: iOS cleanup push skipped approvalId=${resolved.id} reason=missing-targets`);
				return;
			}
			await deliveryState.requestPushPromise;
			const plan = await resolveDeliveryPlan({
				requireApprovalScope: false,
				explicitNodeIds: deliveryState.nodeIds,
				log: params.log
			});
			if (plan.targets.length === 0) return;
			await sendResolvedPushes({
				approvalId: resolved.id,
				plan,
				log: params.log
			});
		},
		async handleExpired(request) {
			const deliveryState = approvalDeliveriesById.get(request.id) ?? await pendingDeliveryStateById.get(request.id);
			approvalDeliveriesById.delete(request.id);
			pendingDeliveryStateById.delete(request.id);
			if (!deliveryState?.nodeIds.length) {
				params.log.debug?.(`exec approvals: iOS cleanup push skipped approvalId=${request.id} reason=missing-targets`);
				return;
			}
			await deliveryState.requestPushPromise;
			const plan = await resolveDeliveryPlan({
				requireApprovalScope: false,
				explicitNodeIds: deliveryState.nodeIds,
				log: params.log
			});
			if (plan.targets.length === 0) return;
			await sendResolvedPushes({
				approvalId: request.id,
				plan,
				log: params.log
			});
		}
	};
}
//#endregion
//#region src/gateway/exec-approval-manager.ts
const RESOLVED_ENTRY_GRACE_MS = 15e3;
function unrefTimer(timer) {
	const unref = timer.unref;
	if (typeof unref === "function") unref.call(timer);
}
function scheduleResolvedEntryCleanup(cleanup) {
	unrefTimer(setTimeout(cleanup, RESOLVED_ENTRY_GRACE_MS));
}
var ExecApprovalManager = class {
	constructor() {
		this.pending = /* @__PURE__ */ new Map();
	}
	create(request, timeoutMs, id) {
		const now = Date.now();
		return {
			id: id && id.trim().length > 0 ? id.trim() : randomUUID(),
			request,
			createdAtMs: now,
			expiresAtMs: now + timeoutMs
		};
	}
	/**
	* Register an approval record and return a promise that resolves when the decision is made.
	* This separates registration (synchronous) from waiting (async), allowing callers to
	* confirm registration before the decision is made.
	*/
	register(record, timeoutMs) {
		const existing = this.pending.get(record.id);
		if (existing) {
			if (existing.record.resolvedAtMs === void 0) return existing.promise;
			throw new Error(`approval id '${record.id}' already resolved`);
		}
		let resolvePromise;
		let rejectPromise;
		const promise = new Promise((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		const entry = {
			record,
			resolve: resolvePromise,
			reject: rejectPromise,
			timer: null,
			promise
		};
		entry.timer = setTimeout(() => {
			this.expire(record.id);
		}, timeoutMs);
		this.pending.set(record.id, entry);
		return promise;
	}
	/**
	* @deprecated Use register() instead for explicit separation of registration and waiting.
	*/
	async waitForDecision(record, timeoutMs) {
		return this.register(record, timeoutMs);
	}
	resolve(recordId, decision, resolvedBy) {
		const pending = this.pending.get(recordId);
		if (!pending) return false;
		if (pending.record.resolvedAtMs !== void 0) return false;
		clearTimeout(pending.timer);
		pending.record.resolvedAtMs = Date.now();
		pending.record.decision = decision;
		pending.record.resolvedBy = resolvedBy ?? null;
		pending.resolve(decision);
		scheduleResolvedEntryCleanup(() => {
			if (this.pending.get(recordId) === pending) this.pending.delete(recordId);
		});
		return true;
	}
	expire(recordId, resolvedBy) {
		const pending = this.pending.get(recordId);
		if (!pending) return false;
		if (pending.record.resolvedAtMs !== void 0) return false;
		clearTimeout(pending.timer);
		pending.record.resolvedAtMs = Date.now();
		pending.record.decision = void 0;
		pending.record.resolvedBy = resolvedBy ?? null;
		pending.resolve(null);
		scheduleResolvedEntryCleanup(() => {
			if (this.pending.get(recordId) === pending) this.pending.delete(recordId);
		});
		return true;
	}
	getSnapshot(recordId) {
		return this.pending.get(recordId)?.record ?? null;
	}
	listPendingRecords() {
		return Array.from(this.pending.values()).map((entry) => entry.record).filter((record) => record.resolvedAtMs === void 0);
	}
	consumeAllowOnce(recordId) {
		const entry = this.pending.get(recordId);
		if (!entry) return false;
		const record = entry.record;
		if (record.decision !== "allow-once") return false;
		record.consumedDecision = record.decision;
		record.decision = void 0;
		return true;
	}
	/**
	* Wait for decision on an already-registered approval.
	* Returns the decision promise if the ID is pending, null otherwise.
	*/
	awaitDecision(recordId) {
		return this.pending.get(recordId)?.promise ?? null;
	}
	lookupApprovalId(input, opts = {}) {
		const normalized = input.trim();
		if (!normalized) return { kind: "none" };
		const exact = this.pending.get(normalized);
		if (exact) return (opts.includeResolved || exact.record.resolvedAtMs === void 0) && (opts.filter?.(exact.record) ?? true) ? {
			kind: "exact",
			id: normalized
		} : { kind: "none" };
		const lowerPrefix = normalizeLowercaseStringOrEmpty(normalized);
		const matches = [];
		for (const [id, entry] of this.pending.entries()) {
			if (!opts.includeResolved && entry.record.resolvedAtMs !== void 0) continue;
			if (opts.filter && !opts.filter(entry.record)) continue;
			if (normalizeLowercaseStringOrEmpty(id).startsWith(lowerPrefix)) matches.push(id);
		}
		if (matches.length === 1) return {
			kind: "prefix",
			id: matches[0]
		};
		if (matches.length > 1) return {
			kind: "ambiguous",
			ids: matches
		};
		return { kind: "none" };
	}
	lookupPendingId(input) {
		return this.lookupApprovalId(input);
	}
};
//#endregion
//#region src/gateway/server-aux-handlers.ts
async function activateSecretsRuntimeSnapshot(snapshot) {
	(await import("./runtime-bGk5qNxI.js")).activateSecretsRuntimeSnapshot(snapshot);
}
function createLazyHandler(method, loadHandlers) {
	return async (opts) => {
		const handler = (await loadHandlers())[method];
		if (!handler) throw new Error(`lazy gateway handler not found: ${method}`);
		await handler(opts);
	};
}
function createGatewayAuxHandlers(params) {
	const execApprovalManager = new ExecApprovalManager();
	const execApprovalForwarder = createExecApprovalForwarder();
	const execApprovalIosPushDelivery = createExecApprovalIosPushDelivery({ log: params.log });
	let execApprovalHandlersPromise = null;
	const loadExecApprovalHandlers = () => execApprovalHandlersPromise ??= import("./exec-approval-gyXDGGTH.js").then(({ createExecApprovalHandlers }) => createExecApprovalHandlers(execApprovalManager, {
		forwarder: execApprovalForwarder,
		iosPushDelivery: execApprovalIosPushDelivery
	}));
	const buildReloadPlan = params.buildReloadPlan ?? buildGatewayReloadPlan;
	const pluginApprovalManager = new ExecApprovalManager();
	let pluginApprovalHandlersPromise = null;
	const loadPluginApprovalHandlers = () => pluginApprovalHandlersPromise ??= import("./plugin-approval-DztsM-lP.js").then(({ createPluginApprovalHandlers }) => createPluginApprovalHandlers(pluginApprovalManager, { forwarder: execApprovalForwarder }));
	let reloadInFlight = null;
	const runExclusiveReload = (fn) => {
		if (reloadInFlight) return reloadInFlight;
		const run = (async () => {
			try {
				return await fn();
			} finally {
				reloadInFlight = null;
			}
		})();
		reloadInFlight = run;
		return run;
	};
	let secretsHandlersPromise = null;
	const loadSecretsHandlers = () => secretsHandlersPromise ??= import("./secrets-CNuO1c04.js").then(({ createSecretsHandlers }) => createSecretsHandlers({
		reloadSecrets: () => runExclusiveReload(async () => {
			const previousSnapshot = getActiveSecretsRuntimeSnapshot();
			if (!previousSnapshot) throw new Error("Secrets runtime snapshot is not active.");
			const previousSharedGatewaySessionGeneration = params.sharedGatewaySessionGenerationState.current;
			const previousSharedGatewaySessionGenerationRequired = params.sharedGatewaySessionGenerationState.required;
			let nextSharedGatewaySessionGeneration = previousSharedGatewaySessionGeneration;
			let sharedGatewaySessionGenerationChanged = false;
			const stoppedChannels = [];
			const restartedChannels = /* @__PURE__ */ new Set();
			try {
				const prepared = await params.activateRuntimeSecrets(previousSnapshot.sourceConfig, {
					reason: "reload",
					activate: true
				});
				nextSharedGatewaySessionGeneration = params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
				const plan = buildReloadPlan(diffConfigPaths(previousSnapshot.config, prepared.config));
				setCurrentSharedGatewaySessionGeneration(params.sharedGatewaySessionGenerationState, nextSharedGatewaySessionGeneration);
				sharedGatewaySessionGenerationChanged = previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration;
				if (sharedGatewaySessionGenerationChanged) disconnectStaleSharedGatewayAuthClients({
					clients: params.clients,
					expectedGeneration: nextSharedGatewaySessionGeneration
				});
				if (plan.restartChannels.size > 0) {
					const restartChannels = [...plan.restartChannels];
					if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) || isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)) throw new Error(`secrets.reload requires restarting channels: ${restartChannels.join(", ")}`);
					const restartFailures = [];
					for (const channel of restartChannels) {
						params.logChannels.info(`restarting ${channel} channel after secrets reload`);
						stoppedChannels.push(channel);
						try {
							await params.stopChannel(channel);
							await params.startChannel(channel);
							restartedChannels.add(channel);
						} catch {
							params.logChannels.info(`failed to restart ${channel} channel after secrets reload`);
							restartFailures.push(channel);
						}
					}
					if (restartFailures.length > 0) throw new Error(`failed to restart channels after secrets reload: ${restartFailures.join(", ")}`);
				}
				return { warningCount: prepared.warnings.length };
			} catch (err) {
				await activateSecretsRuntimeSnapshot(previousSnapshot);
				params.sharedGatewaySessionGenerationState.current = previousSharedGatewaySessionGeneration;
				params.sharedGatewaySessionGenerationState.required = previousSharedGatewaySessionGenerationRequired;
				if (sharedGatewaySessionGenerationChanged) disconnectStaleSharedGatewayAuthClients({
					clients: params.clients,
					expectedGeneration: previousSharedGatewaySessionGeneration
				});
				for (const channel of stoppedChannels) {
					params.logChannels.info(`rolling back ${channel} channel after secrets reload failure`);
					try {
						if (restartedChannels.has(channel)) await params.stopChannel(channel);
						await params.startChannel(channel);
					} catch {
						params.logChannels.info(`failed to roll back ${channel} channel after secrets reload`);
					}
				}
				throw err;
			}
		}),
		log: params.log,
		resolveSecrets: async ({ allowedPaths, commandName, forcedActivePaths, optionalActivePaths, providerOverrides, targetIds }) => {
			const { assignments, diagnostics, inactiveRefPaths } = await resolveCommandSecretsFromActiveRuntimeSnapshot({
				commandName,
				targetIds: new Set(targetIds),
				...allowedPaths ? { allowedPaths: new Set(allowedPaths) } : {},
				...forcedActivePaths ? { forcedActivePaths: new Set(forcedActivePaths) } : {},
				...optionalActivePaths ? { optionalActivePaths: new Set(optionalActivePaths) } : {},
				...providerOverrides ? { providerOverrides } : {}
			});
			if (assignments.length === 0) return {
				assignments: [],
				diagnostics,
				inactiveRefPaths
			};
			return {
				assignments,
				diagnostics,
				inactiveRefPaths
			};
		}
	}));
	return {
		execApprovalManager,
		pluginApprovalManager,
		extraHandlers: {
			"exec.approval.get": createLazyHandler("exec.approval.get", loadExecApprovalHandlers),
			"exec.approval.list": createLazyHandler("exec.approval.list", loadExecApprovalHandlers),
			"exec.approval.request": createLazyHandler("exec.approval.request", loadExecApprovalHandlers),
			"exec.approval.waitDecision": createLazyHandler("exec.approval.waitDecision", loadExecApprovalHandlers),
			"exec.approval.resolve": createLazyHandler("exec.approval.resolve", loadExecApprovalHandlers),
			"plugin.approval.list": createLazyHandler("plugin.approval.list", loadPluginApprovalHandlers),
			"plugin.approval.request": createLazyHandler("plugin.approval.request", loadPluginApprovalHandlers),
			"plugin.approval.waitDecision": createLazyHandler("plugin.approval.waitDecision", loadPluginApprovalHandlers),
			"plugin.approval.resolve": createLazyHandler("plugin.approval.resolve", loadPluginApprovalHandlers),
			"secrets.reload": createLazyHandler("secrets.reload", loadSecretsHandlers),
			"secrets.resolve": createLazyHandler("secrets.resolve", loadSecretsHandlers)
		}
	};
}
//#endregion
export { createGatewayAuxHandlers };
