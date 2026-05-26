import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as isVitestRuntimeEnv, r as logAcceptedEnvOption, t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { a as normalizeStateDirEnv, i as isNixMode } from "./paths-Cw7f9XhU.js";
import { _ as sleep } from "./utils-sBTEdeml.js";
import { a as emitDiagnosticsTimelineEvent, o as isDiagnosticsTimelineEnabled } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { _ as clearCurrentPluginMetadataSnapshot, x as setCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-B6ofplrA.js";
import { S as runWithDiagnosticTraceContext, o as isDiagnosticsEnabled, p as createDiagnosticTraceContext, u as setDiagnosticsEnabledForProcess } from "./diagnostic-events-BLgzARSp.js";
import { r as runtimeForLogger, t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { _ as resolveRequestClientIp, i as isLoopbackHost, m as resolveGatewayListenHosts, v as isContainerEnvironment } from "./net-DCUMtgJy.js";
import { a as createAuthRateLimiter } from "./auth-rate-limit-DA3xJNFz.js";
import { o as isLocalDirectRequest, r as authorizeHttpGatewayConnect } from "./auth-DZ1o6pTQ.js";
import { n as resolveGatewayAuth } from "./auth-resolve-BEn3Se6k.js";
import { A as applyConfigOverrides, c as promoteConfigSnapshotToLastKnownGood, i as getRuntimeConfig, u as readConfigFileSnapshot, v as registerConfigWriteListener } from "./io-DoswVvYe.js";
import { _ as setRuntimeConfigSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import { n as isRestartEnabled } from "./commands.flags-CeKA8V9z.js";
import { t as loadGatewayTlsRuntime$1 } from "./gateway-kClD4_Qv.js";
import { n as createCoreGatewayMethodDescriptors, r as isCoreGatewayMethodClassified, s as listCoreGatewayMethodNames, t as STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./core-descriptors-zcE5f_RQ.js";
import { i as READ_SCOPE, n as APPROVALS_SCOPE, o as WRITE_SCOPE, r as PAIRING_SCOPE, t as ADMIN_SCOPE } from "./operator-scopes-DGvgHuOd.js";
import "./method-scopes-D4RcH8qD.js";
import { m as setPreRestartDeferralCheck, p as setGatewaySigusr1RestartPolicy } from "./restart-C-r_0sSG.js";
import { n as readGatewayRestartHandoffSync } from "./restart-handoff-BSak1pJo.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-CuCUT4Z1.js";
import { C as createPluginGatewayMethodDescriptors, S as createGatewayMethodRegistry, x as createGatewayMethodDescriptorsFromHandlers } from "./loader-DKK7Ita0.js";
import { d as pinActivePluginChannelRegistry, f as pinActivePluginHttpRouteRegistry, h as releasePinnedPluginHttpRouteRegistry, m as releasePinnedPluginChannelRegistry } from "./runtime-DHxRl5F1.js";
import { i as resolveMainSessionKey } from "./main-session-D3q_5w0B.js";
import { n as getLoadedChannelPluginEntryById, r as listLoadedChannelPlugins } from "./registry-loaded-BE-rpJc1.js";
import "./sessions-CQHHcgC_.js";
import { a as enqueueSystemEvent } from "./system-events-11EG3LzK.js";
import { b as startDiagnosticHeartbeat, x as stopDiagnosticHeartbeat } from "./diagnostic-DEgTYLXt.js";
import { i as withDiagnosticPhase } from "./diagnostic-phase-B3JejDeW.js";
import { o as getActiveEmbeddedRunCount } from "./run-state-primn49x.js";
import { l as getTotalQueueSize } from "./command-queue-Da2Lh3Ua.js";
import { r as resolveCronStorePath } from "./store-PoorarMW.js";
import { a as getActiveSecretsRuntimeSnapshot, n as clearSecretsRuntimeSnapshot } from "./runtime-state-CPpp7_ve.js";
import { o as setFallbackGatewayContextResolver } from "./server-plugins-Dzx4kGwz.js";
import { t as getTotalPendingReplies } from "./dispatcher-registry-CaTZukRA.js";
import { c as recordGatewayRestartTraceDetail, d as resumeGatewayRestartTraceFromHandoff, i as finishGatewayRestartTrace, l as recordGatewayRestartTraceSpan, n as collectGatewayProcessMemoryUsageMb, u as resumeGatewayRestartTraceFromEnv } from "./restart-trace-BKGWAIro.js";
import { t as ensureOpenClawCliOnPath } from "./path-env-BY1Xr76b.js";
import { n as logRejectedLargePayload } from "./diagnostic-payload-DTCZLTc7.js";
import { i as MAX_BUFFERED_BYTES, o as MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants-BGwLM6XN.js";
import { s as normalizePluginNodeCapabilityScopedUrl } from "./plugin-node-capability-C7GppvZZ.js";
import { i as summarizeAgentEventForWsLog, n as logWs, r as shouldLogWs } from "./ws-log-Ds39xp21.js";
import { t as createDefaultDeps } from "./deps-C1bdn-NA.js";
import { c as setDefaultSecurityHeaders, r as sendGatewayAuthFailure } from "./http-common-D6Lgf8u5.js";
import { t as GatewayLockError } from "./gateway-lock-D08Qdchp.js";
import { c as resolveControlUiRootSync, n as isPackageProvenControlUiRootSync, s as resolveControlUiRootOverrideSync, t as ensureControlUiAssetsBuilt } from "./control-ui-assets-W5GRTbBr.js";
import { n as DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS, r as evaluateChannelHealth, t as DEFAULT_CHANNEL_CONNECT_GRACE_MS } from "./channel-health-policy-D_eDwUBm.js";
import { n as ensureControlUiAllowedOriginsForNonLoopbackBind } from "./gateway-control-ui-origins-BX09k5CR.js";
import { n as resolveAssistantIdentity } from "./assistant-identity-BpQbk1Fj.js";
import { i as getRequiredSharedGatewaySessionGeneration, r as enforceSharedGatewaySessionGenerationForConfigWrite } from "./server-shared-auth-generation-Csm1h6QK.js";
import { a as createToolEventRecipientRegistry, n as createChatRunState } from "./server-chat-state-5p6_r5uT.js";
import { a as incrementPresenceVersion, i as getPresenceVersion, n as getHealthCache, o as refreshGatewayHealthSnapshot, r as getHealthVersion } from "./health-state-DDBJpyWb.js";
import { n as applyGatewayLaneConcurrency, t as resolveHookClientIpConfig } from "./hook-client-ip-config-CtULy7ip.js";
import { t as GATEWAY_EVENTS } from "./server-methods-list-DSjj8sa9.js";
import { t as resolveSharedGatewaySessionGeneration } from "./ws-shared-generation-Bp5l7wzu.js";
import { n as isProtectedPluginRoutePathFromContext, r as resolvePluginRoutePathContext } from "./route-match-h17yQGxB.js";
import { n as shouldEnforceGatewayAuthForPluginPath } from "./route-auth-DM0bAQOW.js";
import { t as findMatchingPluginNodeCapabilityRoute } from "./route-capability-DjuFZOJp.js";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { createServer as createServer$1 } from "node:https";
//#region src/gateway/plugin-channel-reload-targets.ts
function addNormalizedTarget(targets, value) {
	const normalized = normalizeOptionalString(value);
	if (normalized) targets.add(normalized);
}
function listChannelPluginConfigTargetIds(target) {
	const targets = /* @__PURE__ */ new Set();
	addNormalizedTarget(targets, target.channelId);
	addNormalizedTarget(targets, target.pluginId);
	for (const alias of target.aliases ?? []) addNormalizedTarget(targets, alias);
	return targets;
}
function pluginConfigTargetsChanged(targetIds, changedPaths) {
	const prefixes = Array.from(targetIds, (id) => [`plugins.entries.${id}`, `plugins.installs.${id}`]).flat();
	return changedPaths.some((path) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)));
}
//#endregion
//#region src/gateway/server-control-ui-root.ts
async function resolveGatewayControlUiRootState(params) {
	if (params.controlUiRootOverride) {
		const resolvedOverride = resolveControlUiRootOverrideSync(params.controlUiRootOverride);
		const resolvedOverridePath = path.resolve(params.controlUiRootOverride);
		if (!resolvedOverride) params.log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
		return resolvedOverride ? {
			kind: "resolved",
			path: resolvedOverride
		} : {
			kind: "invalid",
			path: resolvedOverridePath
		};
	}
	if (!params.controlUiEnabled) return;
	const resolveRoot = () => resolveControlUiRootSync({
		moduleUrl: import.meta.url,
		argv1: process.argv[1],
		cwd: process.cwd()
	});
	let resolvedRoot = resolveRoot();
	if (!resolvedRoot) {
		const ensureResult = await ensureControlUiAssetsBuilt(params.gatewayRuntime);
		if (!ensureResult.ok && ensureResult.message) params.log.warn(`gateway: ${ensureResult.message}`);
		resolvedRoot = resolveRoot();
	}
	if (!resolvedRoot) return { kind: "missing" };
	return {
		kind: isPackageProvenControlUiRootSync(resolvedRoot, {
			moduleUrl: import.meta.url,
			argv1: process.argv[1],
			cwd: process.cwd()
		}) ? "bundled" : "resolved",
		path: resolvedRoot
	};
}
//#endregion
//#region src/gateway/server-cron-lazy.ts
function createLazyGatewayCronState(params) {
	const storePath = resolveCronStorePath(params.cfg.cron?.store);
	const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;
	let loaded = null;
	let loading = null;
	let stopped = false;
	const load = async () => {
		if (loaded) return loaded;
		loading ??= import("./server-cron-BdkSOADn.js").then(({ buildGatewayCronService }) => {
			loaded = {
				state: buildGatewayCronService(params),
				started: false
			};
			return loaded;
		});
		return await loading;
	};
	return {
		cron: {
			async start() {
				stopped = false;
				const resolved = await load();
				if (stopped) return;
				if (resolved.started) return;
				resolved.started = true;
				await resolved.state.cron.start();
				if (stopped && resolved.started) {
					resolved.started = false;
					resolved.state.cron.stop();
				}
			},
			stop() {
				stopped = true;
				if (loaded) {
					loaded.started = false;
					loaded.state.cron.stop();
					return;
				}
				if (loading) loading.then((resolved) => {
					if (!stopped) return;
					resolved.started = false;
					resolved.state.cron.stop();
				}).catch(() => {});
			},
			async status() {
				return await (await load()).state.cron.status();
			},
			async list(opts) {
				return await (await load()).state.cron.list(opts);
			},
			async listPage(opts) {
				return await (await load()).state.cron.listPage(opts);
			},
			async add(input) {
				return await (await load()).state.cron.add(input);
			},
			async update(id, patch) {
				return await (await load()).state.cron.update(id, patch);
			},
			async remove(id) {
				return await (await load()).state.cron.remove(id);
			},
			async run(id, mode) {
				return await (await load()).state.cron.run(id, mode);
			},
			async enqueueRun(id, mode) {
				return await (await load()).state.cron.enqueueRun(id, mode);
			},
			getJob(id) {
				if (!loaded) return;
				return loaded.state.cron.getJob(id);
			},
			async readJob(id) {
				return await (await load()).state.cron.readJob(id);
			},
			getDefaultAgentId() {
				if (!loaded) return;
				return loaded.state.cron.getDefaultAgentId();
			},
			wake(opts) {
				if (!loaded) {
					load();
					return { ok: false };
				}
				return loaded.state.cron.wake(opts);
			}
		},
		storePath,
		cronEnabled
	};
}
//#endregion
//#region src/gateway/server-runtime-handles.ts
function createGatewayServerMutableState() {
	const noopInterval = () => {
		const timer = setInterval(() => {}, 1 << 30);
		timer.unref?.();
		return timer;
	};
	return {
		bonjourStop: null,
		tickInterval: noopInterval(),
		healthInterval: noopInterval(),
		dedupeCleanup: noopInterval(),
		mediaCleanup: null,
		heartbeatRunner: {
			stop: () => {},
			updateConfig: (_cfg) => {}
		},
		stopGatewayUpdateCheck: () => {},
		tailscaleCleanup: null,
		postReadySidecars: [],
		gatewayLifetimeSidecars: [],
		skillsRefreshTimer: null,
		skillsRefreshDelayMs: 3e4,
		skillsChangeUnsub: () => {},
		channelHealthMonitor: null,
		stopModelPricingRefresh: () => {},
		mcpServer: void 0,
		configReloader: { stop: async () => {} },
		agentUnsub: null,
		heartbeatUnsub: null,
		transcriptUnsub: null,
		lifecycleUnsub: null
	};
}
//#endregion
//#region src/gateway/server-live-state.ts
function createGatewayServerLiveState(params) {
	return {
		...createGatewayServerMutableState(),
		hooksConfig: params.hooksConfig,
		hookClientIpConfig: params.hookClientIpConfig,
		cronState: params.cronState,
		pluginServices: null,
		gatewayMethods: params.gatewayMethods
	};
}
//#endregion
//#region src/gateway/server-broadcast.ts
const EVENT_SCOPE_GUARDS = {
	agent: [READ_SCOPE],
	chat: [READ_SCOPE],
	"chat.side_result": [READ_SCOPE],
	cron: [READ_SCOPE],
	health: [],
	"exec.approval.requested": [APPROVALS_SCOPE],
	"exec.approval.resolved": [APPROVALS_SCOPE],
	heartbeat: [],
	"plugin.approval.requested": [APPROVALS_SCOPE],
	"plugin.approval.resolved": [APPROVALS_SCOPE],
	presence: [],
	shutdown: [],
	tick: [],
	"talk.event": [READ_SCOPE],
	"talk.mode": [WRITE_SCOPE],
	"update.available": [],
	"voicewake.changed": [READ_SCOPE],
	"voicewake.routing.changed": [READ_SCOPE],
	"device.pair.requested": [PAIRING_SCOPE],
	"device.pair.resolved": [PAIRING_SCOPE],
	"node.pair.requested": [PAIRING_SCOPE],
	"node.pair.resolved": [PAIRING_SCOPE],
	"sessions.changed": [READ_SCOPE],
	"session.message": [READ_SCOPE],
	"session.operation": [READ_SCOPE],
	"session.tool": [READ_SCOPE]
};
const NODE_ALLOWED_EVENTS = new Set(["voicewake.changed", "voicewake.routing.changed"]);
function serializeFrameField(name, value) {
	const fieldJSON = JSON.stringify({ [name]: value });
	const keyJSON = JSON.stringify(name);
	const prefix = `{${keyJSON}:`;
	return fieldJSON.startsWith(prefix) ? `,${keyJSON}:${fieldJSON.slice(prefix.length, -1)}` : "";
}
function hasEventScope(client, event) {
	const required = EVENT_SCOPE_GUARDS[event];
	if (!required && event.startsWith("plugin.")) {
		if ((client.connect.role ?? "operator") !== "operator") return false;
		const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
		return scopes.includes("operator.write") || scopes.includes("operator.admin");
	}
	if (!required) return false;
	if (required.length === 0) return true;
	const role = client.connect.role ?? "operator";
	if (role !== "operator") return role === "node" && NODE_ALLOWED_EVENTS.has(event);
	const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
	if (scopes.includes("operator.admin")) return true;
	if (required.includes("operator.read")) return scopes.includes("operator.read") || scopes.includes("operator.write");
	return required.some((scope) => scopes.includes(scope));
}
function createGatewayBroadcaster(params) {
	const clientSeq = /* @__PURE__ */ new WeakMap();
	const reportedSlowPayloadClients = /* @__PURE__ */ new WeakSet();
	const broadcastInternal = (event, payload, opts, targetConnIds) => {
		if (params.clients.size === 0) return;
		const isTargeted = Boolean(targetConnIds);
		if (shouldLogWs()) {
			const logMeta = {
				event,
				seq: isTargeted ? "targeted" : "per-client",
				clients: params.clients.size,
				targets: targetConnIds ? targetConnIds.size : void 0,
				dropIfSlow: opts?.dropIfSlow,
				presenceVersion: opts?.stateVersion?.presence,
				healthVersion: opts?.stateVersion?.health
			};
			if (event === "agent") Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
			logWs("out", "event", logMeta);
		}
		let frameBase;
		const getFrameBase = () => {
			if (!frameBase) frameBase = {
				eventJSON: JSON.stringify(event),
				payloadFragment: serializeFrameField("payload", payload),
				stateVersionFragment: opts?.stateVersion === void 0 ? "" : serializeFrameField("stateVersion", opts.stateVersion)
			};
			return frameBase;
		};
		for (const c of params.clients) {
			if (targetConnIds && !targetConnIds.has(c.connId)) continue;
			if (!hasEventScope(c, event)) continue;
			const nextSeq = (clientSeq.get(c) ?? 0) + 1;
			const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
			if (!slow) reportedSlowPayloadClients.delete(c);
			else if (!reportedSlowPayloadClients.has(c)) {
				reportedSlowPayloadClients.add(c);
				logRejectedLargePayload({
					surface: "gateway.ws.outbound_buffer",
					bytes: c.socket.bufferedAmount,
					limitBytes: MAX_BUFFERED_BYTES,
					reason: opts?.dropIfSlow ? "ws_send_buffer_drop" : "ws_send_buffer_close"
				});
			}
			if (slow && opts?.dropIfSlow) {
				if (!isTargeted) clientSeq.set(c, nextSeq);
				continue;
			}
			if (slow) {
				try {
					c.socket.close(1008, "slow consumer");
				} catch {}
				continue;
			}
			try {
				const eventSeq = isTargeted ? void 0 : nextSeq;
				if (!isTargeted) clientSeq.set(c, nextSeq);
				const base = getFrameBase();
				const seqFragment = eventSeq === void 0 ? "" : `,"seq":${eventSeq}`;
				const frame = `{"type":"event","event":${base.eventJSON}${base.payloadFragment}${seqFragment}${base.stateVersionFragment}}`;
				c.socket.send(frame);
			} catch {}
		}
	};
	const broadcast = (event, payload, opts) => broadcastInternal(event, payload, opts);
	const broadcastToConnIds = (event, payload, connIds, opts) => {
		if (connIds.size === 0) return;
		broadcastInternal(event, payload, opts, connIds);
	};
	return {
		broadcast,
		broadcastToConnIds
	};
}
//#endregion
//#region src/channels/plugins/gateway-auth-bypass.ts
const GATEWAY_AUTH_API_ARTIFACT_BASENAME = "gateway-auth-api.js";
const MISSING_PUBLIC_SURFACE_PREFIX = "Unable to resolve bundled plugin public surface ";
function loadBundledChannelGatewayAuthApi(channelId) {
	try {
		return loadBundledPluginPublicArtifactModuleSync({
			dirName: channelId,
			artifactBasename: GATEWAY_AUTH_API_ARTIFACT_BASENAME
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(MISSING_PUBLIC_SURFACE_PREFIX)) return;
		throw error;
	}
}
function resolveBundledChannelGatewayAuthBypassPaths(params) {
	return (loadBundledChannelGatewayAuthApi(params.channelId)?.resolveGatewayAuthBypassPaths?.({ cfg: params.cfg }) ?? []).flatMap((path) => typeof path === "string" && path.trim() ? [path.trim()] : []);
}
//#endregion
//#region src/gateway/server-http.ts
let identityAvatarModulePromise;
let controlUiModulePromise;
let embeddingsHttpModulePromise;
let managedImageAttachmentsModulePromise;
let modelsHttpModulePromise;
let openAiHttpModulePromise;
let openResponsesHttpModulePromise;
let sessionHistoryHttpModulePromise;
let sessionKillHttpModulePromise;
let toolsInvokeHttpModulePromise;
let pluginNodeCapabilityAuthModulePromise;
let httpAuthUtilsModulePromise;
let pluginRouteRuntimeScopesModulePromise;
function getIdentityAvatarModule() {
	identityAvatarModulePromise ??= import("./identity-avatar-BQnRIqWq.js");
	return identityAvatarModulePromise;
}
function getControlUiModule() {
	controlUiModulePromise ??= import("./control-ui-CcUWt-IU.js");
	return controlUiModulePromise;
}
function getEmbeddingsHttpModule() {
	embeddingsHttpModulePromise ??= import("./embeddings-http-CTyElen0.js");
	return embeddingsHttpModulePromise;
}
function getManagedImageAttachmentsModule() {
	managedImageAttachmentsModulePromise ??= import("./managed-image-attachments-DSHfl7W5.js");
	return managedImageAttachmentsModulePromise;
}
function getModelsHttpModule() {
	modelsHttpModulePromise ??= import("./models-http-BTNmrAW1.js");
	return modelsHttpModulePromise;
}
function getOpenAiHttpModule() {
	openAiHttpModulePromise ??= import("./openai-http-nhZKOrX6.js");
	return openAiHttpModulePromise;
}
function getOpenResponsesHttpModule() {
	openResponsesHttpModulePromise ??= import("./openresponses-http-BBEFtb_x.js");
	return openResponsesHttpModulePromise;
}
function getSessionHistoryHttpModule() {
	sessionHistoryHttpModulePromise ??= import("./sessions-history-http-K4p9YuU2.js");
	return sessionHistoryHttpModulePromise;
}
function getSessionKillHttpModule() {
	sessionKillHttpModulePromise ??= import("./session-kill-http-BcIZWtri.js");
	return sessionKillHttpModulePromise;
}
function getToolsInvokeHttpModule() {
	toolsInvokeHttpModulePromise ??= import("./tools-invoke-http-Ciew-vAJ.js");
	return toolsInvokeHttpModulePromise;
}
function getPluginNodeCapabilityAuthModule() {
	pluginNodeCapabilityAuthModulePromise ??= import("./plugin-node-capability-auth-GW_BEO8O.js");
	return pluginNodeCapabilityAuthModulePromise;
}
function getHttpAuthUtilsModule() {
	httpAuthUtilsModulePromise ??= import("./http-auth-utils-CY6sYDaq.js");
	return httpAuthUtilsModulePromise;
}
function getPluginRouteRuntimeScopesModule() {
	pluginRouteRuntimeScopesModulePromise ??= import("./plugin-route-runtime-scopes-Dy25XxQ5.js");
	return pluginRouteRuntimeScopesModulePromise;
}
const GATEWAY_PROBE_STATUS_BY_PATH = new Map([
	["/health", "live"],
	["/healthz", "live"],
	["/ready", "ready"],
	["/readyz", "ready"]
]);
const pluginGatewayAuthBypassPathsCache = /* @__PURE__ */ new WeakMap();
async function resolvePluginGatewayAuthBypassPaths(configSnapshot) {
	const paths = /* @__PURE__ */ new Set();
	const configuredChannels = configSnapshot.channels;
	if (!configuredChannels || Object.keys(configuredChannels).length === 0) return paths;
	for (const channelId of Object.keys(configuredChannels)) for (const path of resolveBundledChannelGatewayAuthBypassPaths({
		channelId,
		cfg: configSnapshot
	})) paths.add(path);
	return paths;
}
function getCachedPluginGatewayAuthBypassPaths(configSnapshot) {
	const cached = pluginGatewayAuthBypassPathsCache.get(configSnapshot);
	if (cached) return cached;
	const resolved = resolvePluginGatewayAuthBypassPaths(configSnapshot).catch((error) => {
		pluginGatewayAuthBypassPathsCache.delete(configSnapshot);
		throw error;
	});
	pluginGatewayAuthBypassPathsCache.set(configSnapshot, resolved);
	return resolved;
}
function isOpenAiModelsPath(pathname) {
	return pathname === "/v1/models" || pathname.startsWith("/v1/models/");
}
function isEmbeddingsPath(pathname) {
	return pathname === "/v1/embeddings";
}
function isOpenAiChatCompletionsPath(pathname) {
	return pathname === "/v1/chat/completions";
}
function isOpenResponsesPath(pathname) {
	return pathname === "/v1/responses";
}
function isToolsInvokePath(pathname) {
	return pathname === "/tools/invoke";
}
function isManagedOutgoingImagePath(pathname) {
	return pathname.startsWith("/api/chat/media/outgoing/");
}
function isSessionKillPath(pathname) {
	return /^\/sessions\/[^/]+\/kill$/.test(pathname);
}
function isSessionHistoryPath(pathname) {
	return /^\/sessions\/[^/]+\/history$/.test(pathname);
}
function shouldEnforceDefaultPluginGatewayAuth(pathContext) {
	return pathContext.malformedEncoding || pathContext.decodePassLimitReached || isProtectedPluginRoutePathFromContext(pathContext);
}
async function canRevealReadinessDetails(params) {
	if (isLocalDirectRequest(params.req, params.trustedProxies, params.allowRealIpFallback)) return true;
	if (params.resolvedAuth.mode === "none") return false;
	const { getBearerToken, resolveHttpBrowserOriginPolicy } = await getHttpAuthUtilsModule();
	const bearerToken = getBearerToken(params.req);
	return (await authorizeHttpGatewayConnect({
		auth: params.resolvedAuth,
		connectAuth: bearerToken ? {
			token: bearerToken,
			password: bearerToken
		} : null,
		req: params.req,
		trustedProxies: params.trustedProxies,
		allowRealIpFallback: params.allowRealIpFallback,
		browserOriginPolicy: resolveHttpBrowserOriginPolicy(params.req)
	})).ok;
}
async function handleGatewayProbeRequest(req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback, getReadiness) {
	const status = GATEWAY_PROBE_STATUS_BY_PATH.get(requestPath);
	if (!status) return false;
	const method = (req.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		res.statusCode = 405;
		res.setHeader("Allow", "GET, HEAD");
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end("Method Not Allowed");
		return true;
	}
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	let statusCode;
	let body;
	if (status === "ready" && getReadiness) {
		const includeDetails = await canRevealReadinessDetails({
			req,
			resolvedAuth,
			trustedProxies,
			allowRealIpFallback
		});
		try {
			const result = getReadiness();
			statusCode = result.ready ? 200 : 503;
			body = JSON.stringify(includeDetails ? result : { ready: result.ready });
		} catch {
			statusCode = 503;
			body = JSON.stringify(includeDetails ? {
				ready: false,
				failing: ["internal"],
				uptimeMs: 0
			} : { ready: false });
		}
	} else {
		statusCode = 200;
		body = JSON.stringify({
			ok: true,
			status
		});
	}
	res.statusCode = statusCode;
	res.end(method === "HEAD" ? void 0 : body);
	return true;
}
function writeUpgradeAuthFailure(socket, auth) {
	if (auth.rateLimited) {
		const retryAfterSeconds = auth.retryAfterMs && auth.retryAfterMs > 0 ? Math.ceil(auth.retryAfterMs / 1e3) : void 0;
		socket.write([
			"HTTP/1.1 429 Too Many Requests",
			retryAfterSeconds ? `Retry-After: ${retryAfterSeconds}` : void 0,
			"Content-Type: application/json; charset=utf-8",
			"Connection: close",
			"",
			JSON.stringify({ error: {
				message: "Too many failed authentication attempts. Please try again later.",
				type: "rate_limited"
			} })
		].filter(Boolean).join("\r\n"));
		return;
	}
	socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
}
function writeUpgradeServiceUnavailable(socket, body) {
	socket.write(`HTTP/1.1 503 Service Unavailable\r
Connection: close\r
Content-Type: text/plain; charset=utf-8\r
Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r
` + body);
}
function parseGatewayRequestPath(rawUrl) {
	try {
		return new URL(rawUrl ?? "/", "http://localhost").pathname;
	} catch {
		return;
	}
}
async function runGatewayHttpRequestStages(stages) {
	for (const stage of stages) try {
		if (await stage.run()) return true;
	} catch (err) {
		if (!stage.continueOnError) throw err;
		console.error(`[gateway-http] stage "${stage.name}" threw — skipping:`, err);
	}
	return false;
}
function buildPluginRequestStages(params) {
	if (!params.handlePluginRequest) return [];
	let pluginGatewayAuthSatisfied = false;
	let pluginGatewayRequestAuth;
	let pluginRequestOperatorScopes;
	return [{
		name: "plugin-auth",
		run: async () => {
			const pathContext = params.pluginPathContext ?? resolvePluginRoutePathContext(params.requestPath);
			if (!(params.shouldEnforcePluginGatewayAuth ?? shouldEnforceDefaultPluginGatewayAuth)(pathContext)) return false;
			if ((await params.getGatewayAuthBypassPaths()).has(params.requestPath)) return false;
			const { authorizeGatewayHttpRequestOrReply } = await getHttpAuthUtilsModule();
			const requestAuth = await authorizeGatewayHttpRequestOrReply({
				req: params.req,
				res: params.res,
				auth: params.resolvedAuth,
				trustedProxies: params.trustedProxies,
				allowRealIpFallback: params.allowRealIpFallback,
				rateLimiter: params.rateLimiter
			});
			if (!requestAuth) return true;
			pluginGatewayAuthSatisfied = true;
			pluginGatewayRequestAuth = requestAuth;
			const { resolvePluginRouteRuntimeOperatorScopes } = await getPluginRouteRuntimeScopesModule();
			pluginRequestOperatorScopes = resolvePluginRouteRuntimeOperatorScopes(params.req, requestAuth);
			return false;
		}
	}, {
		name: "plugin-http",
		continueOnError: true,
		run: () => {
			const pathContext = params.pluginPathContext ?? resolvePluginRoutePathContext(params.requestPath);
			return params.handlePluginRequest?.(params.req, params.res, pathContext, {
				gatewayAuthSatisfied: pluginGatewayAuthSatisfied,
				gatewayRequestAuth: pluginGatewayRequestAuth,
				gatewayRequestOperatorScopes: pluginRequestOperatorScopes
			}) ?? false;
		}
	}];
}
function createGatewayHttpServer(opts) {
	const { clients, controlUiEnabled, controlUiBasePath, controlUiRoot, openAiChatCompletionsEnabled, openAiChatCompletionsConfig, openResponsesEnabled, openResponsesConfig, strictTransportSecurityHeader, handleHooksRequest, handlePluginRequest, shouldEnforcePluginGatewayAuth, resolvePluginNodeCapabilityRoute, resolvedAuth, rateLimiter, getReadiness } = opts;
	const getResolvedAuth = opts.getResolvedAuth ?? (() => resolvedAuth);
	const loadGatewayConfig = opts.getRuntimeConfig ?? getRuntimeConfig;
	const openAiCompatEnabled = openAiChatCompletionsEnabled || openResponsesEnabled;
	const httpServer = opts.tlsOptions ? createServer$1(opts.tlsOptions, (req, res) => {
		handleRequestWithTrace(req, res);
	}) : createServer((req, res) => {
		handleRequestWithTrace(req, res);
	});
	function handleRequestWithTrace(req, res) {
		return runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () => handleRequest(req, res));
	}
	async function handleRequest(req, res) {
		setDefaultSecurityHeaders(res, { strictTransportSecurity: strictTransportSecurityHeader });
		if ((req.headers.upgrade ?? "").toLowerCase() === "websocket") return;
		try {
			const requestPath = parseGatewayRequestPath(req.url);
			if (requestPath === void 0) {
				sendGatewayAuthFailure(res, {
					ok: false,
					reason: "unauthorized"
				});
				return;
			}
			if (GATEWAY_PROBE_STATUS_BY_PATH.get(requestPath) === "live") {
				await handleGatewayProbeRequest(req, res, requestPath, getResolvedAuth(), [], false, getReadiness);
				return;
			}
			const configSnapshot = loadGatewayConfig();
			const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
			const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
			const scopedNodeCapability = normalizePluginNodeCapabilityScopedUrl(req.url ?? "/");
			if (scopedNodeCapability.malformedScopedPath) {
				sendGatewayAuthFailure(res, {
					ok: false,
					reason: "unauthorized"
				});
				return;
			}
			if (scopedNodeCapability.rewrittenUrl) req.url = scopedNodeCapability.rewrittenUrl;
			const scopedRequestPath = scopedNodeCapability.pathname;
			const pluginPathContext = handlePluginRequest ? resolvePluginRoutePathContext(scopedRequestPath) : null;
			const resolvedAuth = getResolvedAuth();
			const requestStages = [{
				name: "gateway-probes",
				run: () => handleGatewayProbeRequest(req, res, scopedRequestPath, resolvedAuth, trustedProxies, allowRealIpFallback, getReadiness)
			}, {
				name: "hooks",
				run: () => handleHooksRequest(req, res)
			}];
			if (openAiCompatEnabled && isOpenAiModelsPath(scopedRequestPath)) requestStages.push({
				name: "models",
				run: async () => (await getModelsHttpModule()).handleOpenAiModelsHttpRequest(req, res, {
					auth: resolvedAuth,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter
				})
			});
			if (openAiCompatEnabled && isEmbeddingsPath(scopedRequestPath)) requestStages.push({
				name: "embeddings",
				run: async () => (await getEmbeddingsHttpModule()).handleOpenAiEmbeddingsHttpRequest(req, res, {
					auth: resolvedAuth,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter
				})
			});
			if (isToolsInvokePath(scopedRequestPath)) requestStages.push({
				name: "tools-invoke",
				run: async () => (await getToolsInvokeHttpModule()).handleToolsInvokeHttpRequest(req, res, {
					auth: resolvedAuth,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter
				})
			});
			if (isSessionKillPath(scopedRequestPath)) requestStages.push({
				name: "sessions-kill",
				run: async () => (await getSessionKillHttpModule()).handleSessionKillHttpRequest(req, res, {
					auth: resolvedAuth,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter
				})
			});
			if (isSessionHistoryPath(scopedRequestPath)) requestStages.push({
				name: "sessions-history",
				run: async () => (await getSessionHistoryHttpModule()).handleSessionHistoryHttpRequest(req, res, {
					auth: resolvedAuth,
					getResolvedAuth,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter
				})
			});
			if (openResponsesEnabled && isOpenResponsesPath(scopedRequestPath)) requestStages.push({
				name: "openresponses",
				run: async () => (await getOpenResponsesHttpModule()).handleOpenResponsesHttpRequest(req, res, {
					auth: resolvedAuth,
					config: openResponsesConfig,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter
				})
			});
			if (openAiChatCompletionsEnabled && isOpenAiChatCompletionsPath(scopedRequestPath)) requestStages.push({
				name: "openai",
				run: async () => (await getOpenAiHttpModule()).handleOpenAiHttpRequest(req, res, {
					auth: resolvedAuth,
					config: openAiChatCompletionsConfig,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter
				})
			});
			if (handlePluginRequest && pluginPathContext && resolvePluginNodeCapabilityRoute?.(pluginPathContext)) {
				const nodeCapability = resolvePluginNodeCapabilityRoute(pluginPathContext);
				requestStages.push({
					name: "plugin-node-capability-auth",
					run: async () => {
						if (!nodeCapability) return false;
						const { authorizePluginNodeCapabilityRequest } = await getPluginNodeCapabilityAuthModule();
						const ok = await authorizePluginNodeCapabilityRequest({
							req,
							auth: resolvedAuth,
							trustedProxies,
							allowRealIpFallback,
							clients,
							nodeCapability,
							capability: scopedNodeCapability.capability,
							malformedScopedPath: scopedNodeCapability.malformedScopedPath,
							rateLimiter
						});
						if (!ok.ok) {
							sendGatewayAuthFailure(res, ok);
							return true;
						}
						return false;
					}
				});
			}
			requestStages.push(...buildPluginRequestStages({
				req,
				res,
				requestPath: scopedRequestPath,
				getGatewayAuthBypassPaths: () => getCachedPluginGatewayAuthBypassPaths(configSnapshot),
				pluginPathContext,
				handlePluginRequest,
				shouldEnforcePluginGatewayAuth,
				resolvedAuth,
				trustedProxies,
				allowRealIpFallback,
				rateLimiter
			}));
			if (isManagedOutgoingImagePath(scopedRequestPath)) requestStages.push({
				name: "chat-managed-image-media",
				run: async () => (await getManagedImageAttachmentsModule()).handleManagedOutgoingImageHttpRequest(req, res, {
					auth: resolvedAuth,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter
				})
			});
			if (controlUiEnabled) {
				requestStages.push({
					name: "control-ui-assistant-media",
					run: async () => (await getControlUiModule()).handleControlUiAssistantMediaRequest(req, res, {
						basePath: controlUiBasePath,
						config: configSnapshot,
						agentId: resolveAssistantIdentity({ cfg: configSnapshot }).agentId,
						auth: resolvedAuth,
						trustedProxies,
						allowRealIpFallback,
						rateLimiter
					})
				});
				requestStages.push({
					name: "control-ui-avatar",
					run: async () => {
						const { handleControlUiAvatarRequest } = await getControlUiModule();
						const { resolveAgentAvatar } = await getIdentityAvatarModule();
						return handleControlUiAvatarRequest(req, res, {
							basePath: controlUiBasePath,
							auth: resolvedAuth,
							trustedProxies,
							allowRealIpFallback,
							rateLimiter,
							resolveAvatar: (agentId) => resolveAgentAvatar(configSnapshot, agentId, { includeUiOverride: true })
						});
					}
				});
				requestStages.push({
					name: "control-ui-http",
					run: async () => (await getControlUiModule()).handleControlUiHttpRequest(req, res, {
						basePath: controlUiBasePath,
						config: configSnapshot,
						agentId: resolveAssistantIdentity({ cfg: configSnapshot }).agentId,
						root: controlUiRoot,
						auth: resolvedAuth,
						trustedProxies,
						allowRealIpFallback,
						rateLimiter
					})
				});
			}
			if (await runGatewayHttpRequestStages(requestStages)) return;
			res.statusCode = 404;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Not Found");
		} catch (err) {
			console.error("[gateway-http] unhandled error in request handler:", err);
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Internal Server Error");
		}
	}
	return httpServer;
}
function attachGatewayUpgradeHandler(opts) {
	const { httpServer, wss, handlePluginUpgrade, shouldEnforcePluginGatewayAuth, resolvePluginNodeCapabilityRoute, clients, preauthConnectionBudget, resolvedAuth, rateLimiter, log } = opts;
	const getResolvedAuth = opts.getResolvedAuth ?? (() => resolvedAuth);
	httpServer.on("upgrade", (req, socket, head) => {
		runWithDiagnosticTraceContext(createDiagnosticTraceContext(), async () => {
			const configSnapshot = getRuntimeConfig();
			const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
			const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
			const scopedNodeCapability = normalizePluginNodeCapabilityScopedUrl(req.url ?? "/");
			if (scopedNodeCapability.malformedScopedPath) {
				writeUpgradeAuthFailure(socket, {
					ok: false,
					reason: "unauthorized"
				});
				socket.destroy();
				return;
			}
			if (scopedNodeCapability.rewrittenUrl) req.url = scopedNodeCapability.rewrittenUrl;
			const resolvedAuth = getResolvedAuth();
			const requestPath = scopedNodeCapability.pathname;
			const pathContext = resolvePluginRoutePathContext(requestPath);
			const nodeCapability = resolvePluginNodeCapabilityRoute?.(pathContext);
			if (nodeCapability) {
				const { authorizePluginNodeCapabilityRequest } = await getPluginNodeCapabilityAuthModule();
				const ok = await authorizePluginNodeCapabilityRequest({
					req,
					auth: resolvedAuth,
					trustedProxies,
					allowRealIpFallback,
					clients,
					nodeCapability,
					capability: scopedNodeCapability.capability,
					malformedScopedPath: scopedNodeCapability.malformedScopedPath,
					rateLimiter
				});
				if (!ok.ok) {
					writeUpgradeAuthFailure(socket, ok);
					socket.destroy();
					return;
				}
			}
			if (handlePluginUpgrade) {
				let pluginGatewayAuthSatisfied = false;
				let pluginGatewayRequestAuth;
				let pluginGatewayRequestOperatorScopes;
				if ((shouldEnforcePluginGatewayAuth ?? shouldEnforceDefaultPluginGatewayAuth)(pathContext) && !(await getCachedPluginGatewayAuthBypassPaths(configSnapshot)).has(requestPath)) {
					const { checkGatewayHttpRequestAuth } = await getHttpAuthUtilsModule();
					const authCheck = await checkGatewayHttpRequestAuth({
						req,
						auth: resolvedAuth,
						trustedProxies,
						allowRealIpFallback,
						rateLimiter,
						cfg: configSnapshot
					});
					if (!authCheck.ok) {
						writeUpgradeAuthFailure(socket, authCheck.authResult);
						socket.destroy();
						return;
					}
					pluginGatewayAuthSatisfied = true;
					pluginGatewayRequestAuth = authCheck.requestAuth;
					const { resolvePluginRouteRuntimeOperatorScopes } = await getPluginRouteRuntimeScopesModule();
					pluginGatewayRequestOperatorScopes = resolvePluginRouteRuntimeOperatorScopes(req, authCheck.requestAuth);
				}
				if (await handlePluginUpgrade(req, socket, head, pathContext, {
					gatewayAuthSatisfied: pluginGatewayAuthSatisfied,
					gatewayRequestAuth: pluginGatewayRequestAuth,
					gatewayRequestOperatorScopes: pluginGatewayRequestOperatorScopes
				})) return;
			}
			const preauthBudgetKey = resolveRequestClientIp(req, trustedProxies, allowRealIpFallback);
			if (wss.listenerCount("connection") === 0) {
				writeUpgradeServiceUnavailable(socket, "Gateway websocket handlers unavailable");
				socket.destroy();
				return;
			}
			if (!preauthConnectionBudget.acquire(preauthBudgetKey)) {
				writeUpgradeServiceUnavailable(socket, "Too many unauthenticated sockets");
				socket.destroy();
				return;
			}
			let budgetTransferred = false;
			const releaseUpgradeBudget = () => {
				if (budgetTransferred) return;
				budgetTransferred = true;
				preauthConnectionBudget.release(preauthBudgetKey);
			};
			socket.once("close", releaseUpgradeBudget);
			try {
				wss.handleUpgrade(req, socket, head, (ws) => {
					ws["__openclawPreauthBudgetKey"] = preauthBudgetKey;
					wss.emit("connection", ws, req);
					if (Boolean(ws["__openclawPreauthBudgetClaimed"])) {
						budgetTransferred = true;
						socket.off("close", releaseUpgradeBudget);
					}
				});
			} catch {
				socket.off("close", releaseUpgradeBudget);
				releaseUpgradeBudget();
				throw new Error("gateway websocket upgrade failed");
			}
		}).catch((err) => {
			const remoteAddress = socket.remoteAddress ?? "unknown";
			const errorMessage = err instanceof Error ? err.message : String(err);
			log?.warn(`ws upgrade error from ${remoteAddress}: ${errorMessage}`);
			socket.destroy();
		});
	});
}
//#endregion
//#region src/gateway/server/http-listen.ts
const EADDRINUSE_MAX_RETRIES = 20;
const EADDRINUSE_RETRY_INTERVAL_MS = 500;
async function closeServerQuietly(httpServer) {
	await new Promise((resolve) => {
		try {
			httpServer.close(() => resolve());
		} catch {
			resolve();
		}
	});
}
async function listenGatewayHttpServer(params) {
	const { httpServer, bindHost, port } = params;
	for (let attempt = 0;; attempt++) try {
		await new Promise((resolve, reject) => {
			const onError = (err) => {
				httpServer.off("listening", onListening);
				reject(err);
			};
			const onListening = () => {
				httpServer.off("error", onError);
				resolve();
			};
			httpServer.once("error", onError);
			httpServer.once("listening", onListening);
			httpServer.listen(port, bindHost);
		});
		return;
	} catch (err) {
		const code = err.code;
		if (code === "EADDRINUSE" && attempt < EADDRINUSE_MAX_RETRIES) {
			await closeServerQuietly(httpServer);
			await sleep(EADDRINUSE_RETRY_INTERVAL_MS);
			continue;
		}
		if (code === "EADDRINUSE") throw new GatewayLockError(`another gateway instance is already listening on ws://${bindHost}:${port}`, err);
		throw new GatewayLockError(`failed to bind gateway socket on ws://${bindHost}:${port}: ${String(err)}`, err);
	}
}
//#endregion
//#region src/gateway/server/preauth-connection-budget.ts
const DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP = 32;
const UNKNOWN_CLIENT_IP_BUDGET_KEY = "__openclaw_unknown_client_ip__";
function getMaxPreauthConnectionsPerIpFromEnv(env = process.env) {
	const configured = env.OPENCLAW_MAX_PREAUTH_CONNECTIONS_PER_IP || env.VITEST && env.OPENCLAW_TEST_MAX_PREAUTH_CONNECTIONS_PER_IP;
	if (!configured) return DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP;
	const parsed = Number(configured);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP;
	return Math.max(1, Math.floor(parsed));
}
function createPreauthConnectionBudget(limit = getMaxPreauthConnectionsPerIpFromEnv()) {
	const counts = /* @__PURE__ */ new Map();
	const normalizeBudgetKey = (clientIp) => {
		return clientIp?.trim() || UNKNOWN_CLIENT_IP_BUDGET_KEY;
	};
	return {
		acquire(clientIp) {
			const ip = normalizeBudgetKey(clientIp);
			const next = (counts.get(ip) ?? 0) + 1;
			if (next > limit) return false;
			counts.set(ip, next);
			return true;
		},
		release(clientIp) {
			const ip = normalizeBudgetKey(clientIp);
			const current = counts.get(ip);
			if (current === void 0) return;
			if (current <= 1) {
				counts.delete(ip);
				return;
			}
			counts.set(ip, current - 1);
		}
	};
}
//#endregion
//#region src/gateway/server-runtime-state.ts
async function createGatewayRuntimeState(params) {
	pinActivePluginHttpRouteRegistry(params.pluginRegistry);
	if (params.pinChannelRegistry !== false) pinActivePluginChannelRegistry(params.pluginRegistry);
	else releasePinnedPluginChannelRegistry();
	try {
		const resolvePluginRouteRegistry = () => params.getPluginRouteRegistry?.() ?? params.pluginRegistry;
		const clients = /* @__PURE__ */ new Set();
		const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });
		let loadedHooksRequestHandler = null;
		const handleHooksRequest = async (req, res) => {
			const hooksConfig = params.hooksConfig();
			if (!hooksConfig) return false;
			const url = new URL(req.url ?? "/", "http://localhost");
			const basePath = hooksConfig.basePath;
			if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return false;
			if (!loadedHooksRequestHandler) {
				const { createGatewayHooksRequestHandler } = await import("./hooks-DG2iwSA7.js");
				loadedHooksRequestHandler = createGatewayHooksRequestHandler({
					deps: params.deps,
					getHooksConfig: params.hooksConfig,
					getClientIpConfig: params.getHookClientIpConfig,
					bindHost: params.bindHost,
					port: params.port,
					logHooks: params.logHooks
				});
			}
			return await loadedHooksRequestHandler(req, res);
		};
		let loadedPluginRequestHandler = null;
		let loadedPluginUpgradeHandler = null;
		const handlePluginRequest = async (req, res, pathContext, dispatchContext) => {
			if ((resolvePluginRouteRegistry().httpRoutes ?? []).length === 0) return false;
			if (!loadedPluginRequestHandler) {
				const { createGatewayPluginRequestHandler } = await import("./plugins-http-BgFlYdn0.js");
				loadedPluginRequestHandler = createGatewayPluginRequestHandler({
					registry: params.pluginRegistry,
					getRouteRegistry: resolvePluginRouteRegistry,
					log: params.logPlugins,
					getGatewayRequestContext: params.getGatewayRequestContext
				});
			}
			return await loadedPluginRequestHandler(req, res, pathContext, dispatchContext);
		};
		const handlePluginUpgrade = async (req, socket, head, pathContext, dispatchContext) => {
			if ((resolvePluginRouteRegistry().httpRoutes ?? []).length === 0) return false;
			if (!loadedPluginUpgradeHandler) {
				const { createGatewayPluginUpgradeHandler } = await import("./plugins-http-BgFlYdn0.js");
				loadedPluginUpgradeHandler = createGatewayPluginUpgradeHandler({
					registry: params.pluginRegistry,
					getRouteRegistry: resolvePluginRouteRegistry,
					log: params.logPlugins,
					getGatewayRequestContext: params.getGatewayRequestContext
				});
			}
			return await loadedPluginUpgradeHandler(req, socket, head, pathContext, dispatchContext);
		};
		const shouldEnforcePluginGatewayAuth = (pathContext) => {
			return shouldEnforceGatewayAuthForPluginPath(resolvePluginRouteRegistry(), pathContext);
		};
		const resolvePluginNodeCapabilityRoute = (pathContext) => findMatchingPluginNodeCapabilityRoute(resolvePluginRouteRegistry(), pathContext)?.nodeCapability;
		const bindHosts = await resolveGatewayListenHosts(params.bindHost);
		if (!isLoopbackHost(params.bindHost)) params.log.warn("⚠️  Gateway is binding to a non-loopback address. Ensure authentication is configured before exposing to public networks.");
		if (params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) params.log.warn("⚠️  gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true is enabled. Host-header origin fallback weakens origin checks and should only be used as break-glass.");
		const wss = new WebSocketServer({
			noServer: true,
			maxPayload: MAX_PREAUTH_PAYLOAD_BYTES
		});
		const preauthConnectionBudget = createPreauthConnectionBudget();
		const httpServers = [];
		const httpBindHosts = [];
		for (const _ of bindHosts) {
			const httpServer = createGatewayHttpServer({
				clients,
				controlUiEnabled: params.controlUiEnabled,
				controlUiBasePath: params.controlUiBasePath,
				controlUiRoot: params.controlUiRoot,
				openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
				openAiChatCompletionsConfig: params.openAiChatCompletionsConfig,
				openResponsesEnabled: params.openResponsesEnabled,
				openResponsesConfig: params.openResponsesConfig,
				strictTransportSecurityHeader: params.strictTransportSecurityHeader,
				handleHooksRequest,
				handlePluginRequest,
				shouldEnforcePluginGatewayAuth,
				resolvePluginNodeCapabilityRoute,
				resolvedAuth: params.resolvedAuth,
				getResolvedAuth: params.getResolvedAuth,
				rateLimiter: params.rateLimiter,
				getReadiness: params.getReadiness,
				tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : void 0
			});
			attachGatewayUpgradeHandler({
				httpServer,
				wss,
				handlePluginUpgrade,
				shouldEnforcePluginGatewayAuth,
				resolvePluginNodeCapabilityRoute,
				clients,
				preauthConnectionBudget,
				resolvedAuth: params.resolvedAuth,
				getResolvedAuth: params.getResolvedAuth,
				rateLimiter: params.rateLimiter,
				log: params.log
			});
			httpServers.push(httpServer);
		}
		const httpServer = httpServers[0];
		if (!httpServer) throw new Error("Gateway HTTP server failed to start");
		let startListeningPromise = null;
		const startListening = async () => {
			if (startListeningPromise) {
				await startListeningPromise;
				return;
			}
			startListeningPromise = (async () => {
				for (const [index, host] of bindHosts.entries()) {
					const server = httpServers[index];
					if (!server) throw new Error(`Missing gateway HTTP server for bind host ${host}`);
					try {
						await listenGatewayHttpServer({
							httpServer: server,
							bindHost: host,
							port: params.port
						});
						httpBindHosts.push(host);
					} catch (err) {
						if (host === bindHosts[0]) throw err;
						params.log.warn(`gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`);
					}
				}
				if (httpBindHosts.length === 0) throw new Error("Gateway HTTP server failed to start");
			})();
			try {
				await startListeningPromise;
			} catch (err) {
				startListeningPromise = null;
				throw err;
			}
		};
		const agentRunSeq = /* @__PURE__ */ new Map();
		const dedupe = /* @__PURE__ */ new Map();
		const chatRunState = createChatRunState();
		const chatRunRegistry = chatRunState.registry;
		return {
			releasePluginRouteRegistry: () => {
				releasePinnedPluginHttpRouteRegistry();
				releasePinnedPluginChannelRegistry();
			},
			httpServer,
			httpServers,
			httpBindHosts,
			startListening,
			wss,
			preauthConnectionBudget,
			clients,
			broadcast,
			broadcastToConnIds,
			agentRunSeq,
			dedupe,
			chatRunState,
			chatRunBuffers: chatRunState.buffers,
			chatDeltaSentAt: chatRunState.deltaSentAt,
			chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
			addChatRun: chatRunRegistry.add,
			removeChatRun: chatRunRegistry.remove,
			chatAbortControllers: /* @__PURE__ */ new Map(),
			toolEventRecipients: createToolEventRecipientRegistry()
		};
	} catch (err) {
		releasePinnedPluginHttpRouteRegistry();
		releasePinnedPluginChannelRegistry();
		throw err;
	}
}
//#endregion
//#region src/gateway/server-wizard-sessions.ts
function createWizardSessionTracker() {
	const wizardSessions = /* @__PURE__ */ new Map();
	const findRunningWizard = () => {
		for (const [id, session] of wizardSessions) if (session.getStatus() === "running") return id;
		return null;
	};
	const purgeWizardSession = (id) => {
		const session = wizardSessions.get(id);
		if (!session) return;
		if (session.getStatus() === "running") return;
		wizardSessions.delete(id);
	};
	return {
		wizardSessions,
		findRunningWizard,
		purgeWizardSession
	};
}
//#endregion
//#region src/gateway/server/event-loop-health.ts
const EVENT_LOOP_MONITOR_RESOLUTION_MS = 20;
const EVENT_LOOP_DELAY_WARN_MS = 1e3;
const EVENT_LOOP_UTILIZATION_WARN = .95;
const CPU_CORE_RATIO_WARN = .9;
const LOAD_DEGRADATION_DELAY_COEVIDENCE_MS = 25;
const SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS = 1e3;
function roundMetric(value, digits = 3) {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
function nanosecondsToMilliseconds(value) {
	return roundMetric(value / 1e6, 1);
}
function classifyGatewayEventLoopHealthReasons(metrics) {
	const reasons = [];
	if (metrics.delayP99Ms >= EVENT_LOOP_DELAY_WARN_MS || metrics.delayMaxMs >= EVENT_LOOP_DELAY_WARN_MS) reasons.push("event_loop_delay");
	if (metrics.intervalMs < SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS) return reasons;
	if (!(metrics.delayP99Ms >= LOAD_DEGRADATION_DELAY_COEVIDENCE_MS || metrics.delayMaxMs >= LOAD_DEGRADATION_DELAY_COEVIDENCE_MS)) return reasons;
	if (metrics.utilization >= EVENT_LOOP_UTILIZATION_WARN) reasons.push("event_loop_utilization");
	if (metrics.cpuCoreRatio >= CPU_CORE_RATIO_WARN) reasons.push("cpu");
	return reasons;
}
function createGatewayEventLoopHealthMonitor(deps = {}) {
	const nowMs = deps.now ?? Date.now;
	const readCpuUsage = deps.cpuUsage ?? process.cpuUsage.bind(process);
	const readEventLoopUtilization = deps.eventLoopUtilization ?? performance.eventLoopUtilization.bind(performance);
	const createDelayMonitor = deps.createDelayMonitor ?? ((resolutionMs) => monitorEventLoopDelay({ resolution: resolutionMs }));
	let monitor = null;
	let lastWallAt = nowMs();
	let lastCpuUsage = readCpuUsage();
	let lastEventLoopUtilization = readEventLoopUtilization();
	let lastSnapshot;
	try {
		monitor = createDelayMonitor(EVENT_LOOP_MONITOR_RESOLUTION_MS);
		monitor.enable();
		monitor.reset();
	} catch {
		monitor = null;
	}
	return {
		snapshot: () => {
			if (!monitor || !lastCpuUsage || !lastEventLoopUtilization || lastWallAt <= 0) return;
			const now = nowMs();
			const intervalMs = Math.max(1, now - lastWallAt);
			const delayP99Ms = nanosecondsToMilliseconds(monitor.percentile(99));
			const delayMaxMs = nanosecondsToMilliseconds(monitor.max);
			if (!(delayP99Ms >= EVENT_LOOP_DELAY_WARN_MS || delayMaxMs >= EVENT_LOOP_DELAY_WARN_MS) && intervalMs < SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS) return lastSnapshot;
			const cpuUsage = readCpuUsage(lastCpuUsage);
			const currentEventLoopUtilization = readEventLoopUtilization();
			const utilization = roundMetric(readEventLoopUtilization(currentEventLoopUtilization, lastEventLoopUtilization).utilization);
			const cpuCoreRatio = roundMetric(roundMetric((cpuUsage.user + cpuUsage.system) / 1e3, 1) / intervalMs);
			const reasons = classifyGatewayEventLoopHealthReasons({
				intervalMs,
				delayP99Ms,
				delayMaxMs,
				utilization,
				cpuCoreRatio
			});
			const snapshot = {
				degraded: reasons.length > 0,
				reasons,
				intervalMs,
				delayP99Ms,
				delayMaxMs,
				utilization,
				cpuCoreRatio
			};
			monitor.reset();
			lastWallAt = now;
			lastCpuUsage = readCpuUsage();
			lastEventLoopUtilization = currentEventLoopUtilization;
			lastSnapshot = snapshot;
			return snapshot;
		},
		stop: () => {
			monitor?.disable();
			monitor = null;
			lastWallAt = 0;
			lastCpuUsage = null;
			lastEventLoopUtilization = null;
			lastSnapshot = void 0;
		}
	};
}
//#endregion
//#region src/gateway/server/readiness.ts
const DEFAULT_READINESS_CACHE_TTL_MS = 1e3;
function shouldIgnoreReadinessFailure(accountSnapshot, health) {
	if (health.reason === "unmanaged" || health.reason === "stale-socket") return true;
	return health.reason === "not-running" && accountSnapshot.restartPending === true;
}
function createReadinessChecker(deps) {
	const { channelManager, startedAt } = deps;
	const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
	let cachedAt = 0;
	let cachedState = null;
	return () => {
		const now = Date.now();
		const uptimeMs = now - startedAt;
		if (deps.getStartupPending?.()) return withEventLoopHealth({
			ready: false,
			failing: [deps.getStartupPendingReason?.() ?? "startup-sidecars"],
			uptimeMs
		}, deps.getEventLoopHealth);
		if (deps.shouldSkipChannelReadiness?.()) return withEventLoopHealth({
			ready: true,
			failing: [],
			uptimeMs
		}, deps.getEventLoopHealth);
		if (cachedState && now - cachedAt < cacheTtlMs) return withEventLoopHealth({
			...cachedState,
			uptimeMs
		}, deps.getEventLoopHealth);
		const snapshot = channelManager.getRuntimeSnapshot();
		const failing = [];
		for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
			if (!accounts) continue;
			for (const accountSnapshot of Object.values(accounts)) {
				if (!accountSnapshot) continue;
				const health = evaluateChannelHealth(accountSnapshot, {
					now,
					staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
					channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
					channelId
				});
				if (!health.healthy && !shouldIgnoreReadinessFailure(accountSnapshot, health)) {
					failing.push(channelId);
					break;
				}
			}
		}
		cachedAt = now;
		cachedState = {
			ready: failing.length === 0,
			failing
		};
		return withEventLoopHealth({
			...cachedState,
			uptimeMs
		}, deps.getEventLoopHealth);
	};
}
function withEventLoopHealth(result, getEventLoopHealth) {
	const eventLoop = getEventLoopHealth?.();
	return eventLoop ? {
		...result,
		eventLoop
	} : result;
}
//#endregion
//#region src/gateway/server/tls.ts
async function loadGatewayTlsRuntime(cfg, log) {
	return await loadGatewayTlsRuntime$1(cfg, log);
}
//#endregion
//#region src/gateway/startup-control-ui-origins.ts
async function maybeSeedControlUiAllowedOriginsAtStartup(params) {
	const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(params.config, {
		isContainerEnvironment,
		runtimeBind: params.runtimeBind,
		runtimePort: params.runtimePort
	});
	if (!seeded.seededOrigins || !seeded.bind) return {
		config: params.config,
		seededAllowedOrigins: false
	};
	params.log.info(buildSeededOriginsInfoLog(seeded.seededOrigins, seeded.bind));
	return {
		config: seeded.config,
		seededAllowedOrigins: true
	};
}
function buildSeededOriginsInfoLog(origins, bind) {
	return `gateway: seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} for bind=${bind} (required since v2026.2.26; see issue #29385). Applied for this runtime without writing config; add other origins to gateway.controlUi.allowedOrigins if needed.`;
}
//#endregion
//#region src/gateway/server.impl.ts
async function resetModelCatalogCacheForTest() {
	const { resetModelCatalogCacheForTest } = await import("./server-model-catalog-iTaUGB-S.js");
	await resetModelCatalogCacheForTest();
}
ensureOpenClawCliOnPath();
const MAX_MEDIA_TTL_HOURS = 168;
const POST_READY_MAINTENANCE_DELAY_MS = 250;
let gatewayStartupEarlyModulePromise = null;
let gatewayStartupPostAttachModulePromise = null;
function loadGatewayStartupEarlyModule() {
	gatewayStartupEarlyModulePromise ??= import("./server-startup-early-BG0kglEG.js");
	return gatewayStartupEarlyModulePromise;
}
function loadGatewayStartupPostAttachModule() {
	gatewayStartupPostAttachModulePromise ??= import("./server-startup-post-attach-ezNyN6B3.js");
	return gatewayStartupPostAttachModulePromise;
}
function listGatewayStartupChannelPlugins() {
	return listLoadedChannelPlugins();
}
function resolveMediaCleanupTtlMs(ttlHoursRaw) {
	const ttlMs = Math.min(Math.max(ttlHoursRaw, 1), MAX_MEDIA_TTL_HOURS) * 60 * 6e4;
	if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(ttlMs)) throw new Error(`Invalid media.ttlHours: ${String(ttlHoursRaw)}`);
	return ttlMs;
}
const log = createSubsystemLogger("gateway");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");
let cachedChannelRuntimePromise = null;
let cachedStartupChannelRuntimePromise = null;
function getChannelRuntime() {
	cachedChannelRuntimePromise ??= import("./runtime-channel-LL78rR71.js").then(({ createRuntimeChannel }) => createRuntimeChannel());
	return cachedChannelRuntimePromise;
}
function getStartupChannelRuntime() {
	cachedStartupChannelRuntimePromise ??= import("./channel-runtime-contexts-BsQzMAGZ.js").then(({ createChannelRuntimeContextRegistry }) => ({ runtimeContexts: createChannelRuntimeContextRegistry() }));
	return cachedStartupChannelRuntimePromise;
}
async function closeMcpLoopbackServerOnDemand() {
	const { closeMcpLoopbackServer } = await import("./mcp-http-BO2CYtjK.js");
	await closeMcpLoopbackServer();
}
let gatewayCloseModulePromise = null;
function loadGatewayCloseModule() {
	gatewayCloseModulePromise ??= import("./server-close.runtime.js");
	return gatewayCloseModulePromise;
}
let gatewayModelCatalogModulePromise = null;
const loadGatewayModelCatalog = async (...args) => {
	gatewayModelCatalogModulePromise ??= import("./server-model-catalog-iTaUGB-S.js");
	return (await gatewayModelCatalogModulePromise).loadGatewayModelCatalog(...args);
};
const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const logSecrets = log.child("secrets");
const gatewayRuntime = runtimeForLogger(log);
function createGatewayStartupTrace() {
	const logEnabled = isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE);
	let timelineConfig;
	let eventLoopDelay;
	const timelineOptions = () => ({
		...timelineConfig ? { config: timelineConfig } : {},
		env: process.env
	});
	const eventLoopTimelineEnabled = () => isDiagnosticsTimelineEnabled(timelineOptions()) && isTruthyEnvValue(process.env.OPENCLAW_DIAGNOSTICS_EVENT_LOOP);
	const ensureEventLoopDelay = () => {
		if (eventLoopDelay || !logEnabled && !eventLoopTimelineEnabled()) return;
		eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
		eventLoopDelay.enable();
	};
	ensureEventLoopDelay();
	const started = performance.now();
	let last = started;
	let spanSequence = 0;
	const formatMetric = (key, value) => `${key}=${typeof value === "number" ? value.toFixed(1) : value}`;
	const mapTimelineName = (name) => {
		switch (name) {
			case "config.snapshot": return "config.load";
			case "config.auth":
			case "config.final-snapshot":
			case "runtime.config": return "config.normalize";
			case "plugins.bootstrap": return "plugins.load";
			case "runtime.post-attach":
			case "ready": return "gateway.ready";
			default: return name;
		}
	};
	const takeEventLoopSample = () => {
		if (!eventLoopDelay) return;
		const sample = {
			p50Ms: eventLoopDelay.percentile(50) / 1e6,
			p95Ms: eventLoopDelay.percentile(95) / 1e6,
			p99Ms: eventLoopDelay.percentile(99) / 1e6,
			maxMs: eventLoopDelay.max / 1e6
		};
		eventLoopDelay.reset();
		return sample;
	};
	const emitEventLoopTimelineSample = (activeSpanName, sample) => {
		if (!eventLoopTimelineEnabled()) return;
		if (!sample) return;
		emitDiagnosticsTimelineEvent({
			type: "eventLoop.sample",
			name: "eventLoop",
			phase: "startup",
			activeSpanName: mapTimelineName(activeSpanName),
			attributes: activeSpanName === mapTimelineName(activeSpanName) ? void 0 : { traceName: activeSpanName },
			...sample
		}, timelineOptions());
	};
	const emit = (name, durationMs, totalMs, eventLoopSample, extras = []) => {
		const metrics = [["eventLoopMax", `${(eventLoopSample?.maxMs ?? 0).toFixed(1)}ms`], ...extras];
		recordGatewayRestartTraceSpan(`restart.ready.${name}`, durationMs, totalMs, metrics);
		if (logEnabled) log.info(`startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms ${metrics.map(([key, value]) => formatMetric(key, value)).join(" ")}`);
	};
	return {
		setConfig(config) {
			timelineConfig = config;
			ensureEventLoopDelay();
		},
		mark(name) {
			const now = performance.now();
			const eventLoopSample = takeEventLoopSample();
			emit(name, now - last, now - started, eventLoopSample);
			emitDiagnosticsTimelineEvent({
				type: "mark",
				name: mapTimelineName(name),
				phase: "startup",
				durationMs: now - started,
				attributes: name === mapTimelineName(name) ? void 0 : { traceName: name }
			}, timelineOptions());
			emitEventLoopTimelineSample(name, eventLoopSample);
			last = now;
			if (name === "ready") eventLoopDelay?.disable();
		},
		detail(name, metrics) {
			const attributes = Object.fromEntries(metrics);
			recordGatewayRestartTraceDetail(`restart.ready.${name}`, metrics);
			if (logEnabled) log.info(`startup trace: ${name} ${metrics.map(([key, value]) => formatMetric(key, value)).join(" ")}`);
			emitDiagnosticsTimelineEvent({
				type: "mark",
				name: mapTimelineName(name),
				phase: "startup",
				attributes: {
					traceName: name,
					...attributes
				}
			}, timelineOptions());
		},
		async measure(name, run) {
			const before = performance.now();
			const spanId = `gateway-startup-${++spanSequence}`;
			emitDiagnosticsTimelineEvent({
				type: "span.start",
				name: mapTimelineName(name),
				phase: "startup",
				spanId,
				attributes: name === mapTimelineName(name) ? void 0 : { traceName: name }
			}, timelineOptions());
			try {
				const result = await withDiagnosticPhase(mapTimelineName(name), run, { traceName: name });
				const now = performance.now();
				emitDiagnosticsTimelineEvent({
					type: "span.end",
					name: mapTimelineName(name),
					phase: "startup",
					spanId,
					durationMs: now - before,
					attributes: name === mapTimelineName(name) ? void 0 : { traceName: name }
				}, timelineOptions());
				return result;
			} catch (error) {
				const now = performance.now();
				emitDiagnosticsTimelineEvent({
					type: "span.error",
					name: mapTimelineName(name),
					phase: "startup",
					spanId,
					durationMs: now - before,
					attributes: name === mapTimelineName(name) ? void 0 : { traceName: name },
					errorName: error instanceof Error ? error.name : typeof error,
					errorMessage: error instanceof Error ? error.message : String(error)
				}, timelineOptions());
				throw error;
			} finally {
				const now = performance.now();
				const eventLoopSample = takeEventLoopSample();
				emit(name, now - before, now - started, eventLoopSample);
				emitEventLoopTimelineSample(name, eventLoopSample);
				last = now;
			}
		}
	};
}
function formatRuntimeGatewayAuthTokenWarning() {
	const base = "Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token.";
	if (!isNixMode) return `${base} Persist one with \`openclaw config set gateway.auth.mode token\` and \`openclaw config set gateway.auth.token <token>\`.`;
	return [
		base,
		"In Nix mode, set gateway.auth.token in your Nix-managed OpenClaw config and rebuild.",
		"For the first-party Nix flow, see https://github.com/openclaw/nix-openclaw#quick-start and https://docs.openclaw.ai/install/nix."
	].join(" ");
}
async function stopTaskRegistryMaintenanceOnDemand() {
	const { stopTaskRegistryMaintenance } = await import("./task-registry.maintenance-CtLE61v7.js");
	stopTaskRegistryMaintenance();
}
function createGatewayAuthRateLimiters(rateLimitConfig) {
	return {
		rateLimiter: rateLimitConfig ? createAuthRateLimiter(rateLimitConfig) : void 0,
		browserRateLimiter: createAuthRateLimiter({
			...rateLimitConfig,
			exemptLoopback: false
		})
	};
}
const runDefaultSetupWizard = async (...args) => {
	const { runSetupWizard } = await import("./setup-CCBLBWaw.js");
	return runSetupWizard(...args);
};
async function startGatewayServer(port = 18789, opts = {}) {
	normalizeStateDirEnv(process.env);
	const { bootstrapGatewayNetworkRuntime } = await import("./server-network-runtime-Br2HEIV9.js");
	bootstrapGatewayNetworkRuntime();
	const minimalTestGateway = isVitestRuntimeEnv() && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";
	process.env.OPENCLAW_GATEWAY_PORT = String(port);
	logAcceptedEnvOption({
		key: "OPENCLAW_RAW_STREAM",
		description: "raw stream logging enabled"
	});
	logAcceptedEnvOption({
		key: "OPENCLAW_RAW_STREAM_PATH",
		description: "raw stream log path override"
	});
	if (!resumeGatewayRestartTraceFromEnv(process.env, [["source", "env"]])) {
		const restartHandoff = readGatewayRestartHandoffSync();
		resumeGatewayRestartTraceFromHandoff(restartHandoff?.restartTrace, [
			["source", restartHandoff?.source],
			["restartKind", restartHandoff?.restartKind],
			["supervisorMode", restartHandoff?.supervisorMode]
		]);
	}
	const startupTrace = createGatewayStartupTrace();
	const startupConfigModulePromise = import("./server-startup-config-C-rNKEbY.js");
	let startupPluginsModulePromise = null;
	const loadStartupPluginsModule = () => {
		startupPluginsModulePromise ??= import("./server-startup-plugins-CD06rso_.js");
		return startupPluginsModulePromise;
	};
	const { loadGatewayStartupConfigSnapshot } = await startupConfigModulePromise;
	const startupConfigLoad = await startupTrace.measure("config.snapshot", () => loadGatewayStartupConfigSnapshot({
		minimalTestGateway,
		log,
		measure: (name, run) => startupTrace.measure(name, run),
		...opts.startupConfigSnapshotRead ? { initialSnapshotRead: opts.startupConfigSnapshotRead } : {}
	}));
	const configSnapshot = startupConfigLoad.snapshot;
	const emitSecretsStateEvent = (code, message, cfg) => {
		enqueueSystemEvent(`[${code}] ${message}`, {
			sessionKey: resolveMainSessionKey(cfg),
			contextKey: code
		});
	};
	const { createRuntimeSecretsActivator } = await startupConfigModulePromise;
	const activateRuntimeSecrets = createRuntimeSecretsActivator({
		logSecrets,
		emitStateEvent: emitSecretsStateEvent
	});
	let cfgAtStart;
	let startupInternalWriteHash = null;
	let startupLastGoodSnapshot = configSnapshot;
	const startupActivationSourceConfig = configSnapshot.sourceConfig;
	const startupRuntimeConfig = applyConfigOverrides(configSnapshot.config);
	startupTrace.setConfig(startupRuntimeConfig);
	const { prepareGatewayStartupConfig } = await startupConfigModulePromise;
	const authBootstrap = await startupTrace.measure("config.auth", () => prepareGatewayStartupConfig({
		configSnapshot,
		authOverride: opts.auth,
		tailscaleOverride: opts.tailscale,
		activateRuntimeSecrets,
		measure: (name, run) => startupTrace.measure(name, run)
	}));
	cfgAtStart = authBootstrap.cfg;
	startupTrace.setConfig(cfgAtStart);
	if (authBootstrap.generatedToken) log.warn(formatRuntimeGatewayAuthTokenWarning());
	const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
	setDiagnosticsEnabledForProcess(diagnosticsEnabled);
	if (diagnosticsEnabled) startDiagnosticHeartbeat(void 0, {
		getConfig: getRuntimeConfig,
		startupGraceMs: 6e4
	});
	setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(cfgAtStart) });
	let getActiveTaskCount = () => 0;
	setPreRestartDeferralCheck(() => getTotalQueueSize() + getTotalPendingReplies() + getActiveEmbeddedRunCount() + getActiveTaskCount());
	cfgAtStart = (minimalTestGateway ? {
		config: cfgAtStart,
		seededAllowedOrigins: false
	} : await startupTrace.measure("control-ui.seed", () => maybeSeedControlUiAllowedOriginsAtStartup({
		config: cfgAtStart,
		log,
		runtimeBind: opts.bind,
		runtimePort: port
	}))).config;
	if (startupConfigLoad.wroteConfig || authBootstrap.persistedGeneratedToken) {
		const startupSnapshot = await startupTrace.measure("config.final-snapshot", () => readConfigFileSnapshot());
		startupInternalWriteHash = startupSnapshot.hash ?? null;
		startupLastGoodSnapshot = startupSnapshot;
	}
	setRuntimeConfigSnapshot(cfgAtStart, startupLastGoodSnapshot.sourceConfig);
	const { prepareGatewayPluginBootstrap } = await loadStartupPluginsModule();
	const pluginBootstrap = await startupTrace.measure("plugins.bootstrap", () => prepareGatewayPluginBootstrap({
		cfgAtStart,
		activationSourceConfig: startupActivationSourceConfig,
		startupRuntimeConfig,
		pluginMetadataSnapshot: startupConfigLoad.pluginMetadataSnapshot,
		minimalTestGateway,
		log,
		loadRuntimePlugins: false
	}));
	const { gatewayPluginConfigAtStart, defaultWorkspaceDir, deferredConfiguredChannelPluginIds, startupPluginIds, pluginLookUpTable, baseMethods, runtimePluginsLoaded } = pluginBootstrap;
	const coreGatewayMethodNames = listCoreGatewayMethodNames();
	setCurrentPluginMetadataSnapshot(pluginLookUpTable, {
		config: startupActivationSourceConfig,
		compatibleConfigs: [
			startupRuntimeConfig,
			cfgAtStart,
			gatewayPluginConfigAtStart
		],
		env: process.env,
		workspaceDir: defaultWorkspaceDir
	});
	if (pluginLookUpTable) {
		const metrics = pluginLookUpTable.metrics;
		startupTrace.detail("plugins.lookup-table", [
			["registrySnapshotMs", metrics.registrySnapshotMs],
			["manifestRegistryMs", metrics.manifestRegistryMs],
			["startupPlanMs", metrics.startupPlanMs],
			["ownerMapsMs", metrics.ownerMapsMs],
			["totalMs", metrics.totalMs],
			["indexPlugins", String(metrics.indexPluginCount)],
			["indexPluginCount", metrics.indexPluginCount],
			["manifestPlugins", String(metrics.manifestPluginCount)],
			["manifestPluginCount", metrics.manifestPluginCount],
			["startupPlugins", String(metrics.startupPluginCount)],
			["startupPluginCount", metrics.startupPluginCount],
			["deferredChannelPlugins", String(metrics.deferredChannelPluginCount)],
			["deferredChannelPluginCount", metrics.deferredChannelPluginCount]
		]);
	}
	let { pluginRegistry, baseGatewayMethods } = pluginBootstrap;
	const channelLogs = Object.fromEntries(listGatewayStartupChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]));
	const channelRuntimeEnvs = Object.fromEntries(Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]));
	const listStartupChannelGatewayMethods = () => {
		const methods = [];
		for (const plugin of listGatewayStartupChannelPlugins()) {
			methods.push(...plugin.gatewayMethods ?? []);
			for (const descriptor of plugin.gatewayMethodDescriptors ?? []) methods.push(descriptor.name);
		}
		return methods;
	};
	const listActiveGatewayMethods = (nextBaseGatewayMethods) => Array.from(new Set([...nextBaseGatewayMethods, ...listStartupChannelGatewayMethods()]));
	const runtimeConfig = await startupTrace.measure("runtime.config", async () => {
		const { resolveGatewayRuntimeConfig } = await import("./server-runtime-config-BGwV747J.js");
		return resolveGatewayRuntimeConfig({
			cfg: cfgAtStart,
			port,
			bind: opts.bind,
			host: opts.host,
			controlUiEnabled: opts.controlUiEnabled,
			openAiChatCompletionsEnabled: opts.openAiChatCompletionsEnabled,
			openResponsesEnabled: opts.openResponsesEnabled,
			auth: opts.auth,
			tailscale: opts.tailscale
		});
	});
	const { bindHost, controlUiEnabled, openAiChatCompletionsEnabled, openAiChatCompletionsConfig, openResponsesEnabled, openResponsesConfig, strictTransportSecurityHeader, controlUiBasePath, controlUiRoot: controlUiRootOverride, resolvedAuth, tailscaleConfig, tailscaleMode } = runtimeConfig;
	const getResolvedAuth = () => resolveGatewayAuth({
		authConfig: getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth ?? getRuntimeConfig().gateway?.auth,
		authOverride: opts.auth,
		env: process.env,
		tailscaleMode
	});
	const resolveSharedGatewaySessionGenerationForConfig = (config) => resolveSharedGatewaySessionGeneration(resolveGatewayAuth({
		authConfig: config.gateway?.auth,
		authOverride: opts.auth,
		env: process.env,
		tailscaleMode
	}), config.gateway?.trustedProxies);
	const resolveCurrentSharedGatewaySessionGeneration = () => resolveSharedGatewaySessionGeneration(getResolvedAuth(), getRuntimeConfig().gateway?.trustedProxies);
	const resolveSharedGatewaySessionGenerationForRuntimeSnapshot = () => resolveSharedGatewaySessionGeneration(resolveGatewayAuth({
		authConfig: getRuntimeConfig().gateway?.auth,
		authOverride: opts.auth,
		env: process.env,
		tailscaleMode
	}), getRuntimeConfig().gateway?.trustedProxies);
	const sharedGatewaySessionGenerationState = {
		current: resolveCurrentSharedGatewaySessionGeneration(),
		required: null
	};
	const preauthHandshakeTimeoutMs = cfgAtStart.gateway?.handshakeTimeoutMs ?? getRuntimeConfig().gateway?.handshakeTimeoutMs;
	const initialHooksConfig = runtimeConfig.hooksConfig;
	const initialHookClientIpConfig = resolveHookClientIpConfig(cfgAtStart);
	const rateLimitConfig = cfgAtStart.gateway?.auth?.rateLimit;
	const { rateLimiter: authRateLimiter, browserRateLimiter: browserAuthRateLimiter } = createGatewayAuthRateLimiters(rateLimitConfig);
	const controlUiRootState = await startupTrace.measure("control-ui.root", () => resolveGatewayControlUiRootState({
		controlUiRootOverride,
		controlUiEnabled,
		gatewayRuntime,
		log
	}));
	const wizardRunner = opts.wizardRunner ?? runDefaultSetupWizard;
	const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();
	const deps = createDefaultDeps();
	let runtimeState = null;
	let gatewayCronStartHandled = false;
	const gatewayTls = await startupTrace.measure("tls.runtime", () => loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls")));
	if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
	const serverStartedAt = Date.now();
	const readinessEventLoopHealth = createGatewayEventLoopHealthMonitor();
	let startupSidecarsReady = minimalTestGateway;
	let startupPendingReason = "startup-sidecars";
	const { createChannelManager } = await import("./server-channels-CRUeVkRN.js");
	const channelManager = createChannelManager({
		getRuntimeConfig: () => applyPluginAutoEnable({
			config: getRuntimeConfig(),
			env: process.env
		}).config,
		channelLogs,
		channelRuntimeEnvs,
		resolveChannelRuntime: getChannelRuntime,
		resolveStartupChannelRuntime: getStartupChannelRuntime,
		getPluginHttpRouteRegistry: () => pluginRegistry,
		startupTrace
	});
	const getReadiness = createReadinessChecker({
		channelManager,
		startedAt: serverStartedAt,
		getStartupPending: () => !startupSidecarsReady,
		getStartupPendingReason: () => startupPendingReason,
		getEventLoopHealth: readinessEventLoopHealth.snapshot,
		shouldSkipChannelReadiness: () => isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) || isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)
	});
	log.info("starting HTTP server...");
	let currentPluginRegistryGatewayContext;
	const { releasePluginRouteRegistry, httpServer, httpServers, httpBindHosts, startListening, wss, preauthConnectionBudget, clients, broadcast, broadcastToConnIds, agentRunSeq, dedupe, chatRunState, chatRunBuffers, chatDeltaSentAt, chatDeltaLastBroadcastLen, addChatRun, removeChatRun, chatAbortControllers, toolEventRecipients } = await startupTrace.measure("runtime.state", () => createGatewayRuntimeState({
		cfg: cfgAtStart,
		bindHost,
		port,
		controlUiEnabled,
		controlUiBasePath,
		controlUiRoot: controlUiRootState,
		openAiChatCompletionsEnabled,
		openAiChatCompletionsConfig,
		openResponsesEnabled,
		openResponsesConfig,
		strictTransportSecurityHeader,
		resolvedAuth,
		rateLimiter: authRateLimiter,
		gatewayTls,
		getResolvedAuth,
		hooksConfig: () => runtimeState?.hooksConfig ?? initialHooksConfig,
		getHookClientIpConfig: () => runtimeState?.hookClientIpConfig ?? initialHookClientIpConfig,
		pluginRegistry,
		getPluginRouteRegistry: () => pluginRegistry,
		getGatewayRequestContext: () => currentPluginRegistryGatewayContext,
		pinChannelRegistry: !minimalTestGateway,
		deps,
		log,
		logHooks,
		logPlugins,
		getReadiness
	}));
	const { createGatewayNodeSessionRuntime } = await import("./server-node-session-runtime-C2gow8hU.js");
	const { nodeRegistry, nodePresenceTimers, sessionEventSubscribers, sessionMessageSubscribers, nodeSendToSession, nodeSendToAllSubscribed, nodeSubscribe, nodeUnsubscribe, nodeUnsubscribeAll, broadcastVoiceWakeChanged, hasTalkNodeConnected } = createGatewayNodeSessionRuntime({ broadcast });
	applyGatewayLaneConcurrency(cfgAtStart);
	runtimeState = createGatewayServerLiveState({
		hooksConfig: initialHooksConfig,
		hookClientIpConfig: initialHookClientIpConfig,
		cronState: createLazyGatewayCronState({
			cfg: cfgAtStart,
			deps,
			broadcast
		}),
		gatewayMethods: listActiveGatewayMethods(baseGatewayMethods)
	});
	deps.cron = runtimeState.cronState.cron;
	const pluginHostServices = { get cron() {
		return runtimeState.cronState.cron;
	} };
	let closePreludeStarted = false;
	let postReadyMaintenanceTimer = null;
	const clearPostReadyMaintenanceTimer = () => {
		if (!postReadyMaintenanceTimer) return;
		clearTimeout(postReadyMaintenanceTimer);
		postReadyMaintenanceTimer = null;
	};
	const markClosePreludeStarted = () => {
		closePreludeStarted = true;
		clearPostReadyMaintenanceTimer();
	};
	const runClosePrelude = async () => {
		markClosePreludeStarted();
		clearCurrentPluginMetadataSnapshot();
		const { runGatewayClosePrelude } = await loadGatewayCloseModule();
		await runGatewayClosePrelude({
			...diagnosticsEnabled ? { stopDiagnostics: stopDiagnosticHeartbeat } : {},
			clearSkillsRefreshTimer: () => {
				if (!runtimeState?.skillsRefreshTimer) return;
				clearTimeout(runtimeState.skillsRefreshTimer);
				runtimeState.skillsRefreshTimer = null;
			},
			skillsChangeUnsub: runtimeState.skillsChangeUnsub,
			...authRateLimiter ? { disposeAuthRateLimiter: () => authRateLimiter.dispose() } : {},
			disposeBrowserAuthRateLimiter: () => browserAuthRateLimiter.dispose(),
			stopModelPricingRefresh: runtimeState.stopModelPricingRefresh,
			stopChannelHealthMonitor: () => runtimeState?.channelHealthMonitor?.stop(),
			stopReadinessEventLoopHealth: readinessEventLoopHealth.stop,
			clearSecretsRuntimeSnapshot,
			closeMcpServer: closeMcpLoopbackServerOnDemand
		});
	};
	const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } = channelManager;
	const refreshGatewayHealthSnapshotWithRuntime = (opts) => refreshGatewayHealthSnapshot({
		...opts,
		getRuntimeSnapshot,
		getEventLoopHealth: readinessEventLoopHealth.snapshot
	});
	const stopRegisteredPostReadySidecars = () => {
		const postReadySidecars = runtimeState.postReadySidecars;
		runtimeState.postReadySidecars = [];
		for (const postReadySidecar of postReadySidecars) postReadySidecar.stop();
	};
	const stopRegisteredGatewayLifetimeSidecars = () => {
		const gatewayLifetimeSidecars = runtimeState.gatewayLifetimeSidecars;
		runtimeState.gatewayLifetimeSidecars = [];
		for (const gatewayLifetimeSidecar of gatewayLifetimeSidecars) gatewayLifetimeSidecar.stop();
	};
	const createCloseHandler = () => async (opts) => {
		const channelIds = listLoadedChannelPlugins().map((plugin) => plugin.id);
		const { createGatewayCloseHandler, drainActiveSessionsForShutdown } = await loadGatewayCloseModule();
		await createGatewayCloseHandler({
			bonjourStop: runtimeState.bonjourStop,
			tailscaleCleanup: runtimeState.tailscaleCleanup,
			releasePluginRouteRegistry,
			channelIds,
			stopChannel,
			pluginServices: runtimeState.pluginServices,
			postReadySidecars: runtimeState.postReadySidecars,
			cron: runtimeState.cronState.cron,
			heartbeatRunner: runtimeState.heartbeatRunner,
			updateCheckStop: runtimeState.stopGatewayUpdateCheck,
			stopTaskRegistryMaintenance: stopTaskRegistryMaintenanceOnDemand,
			nodePresenceTimers,
			broadcast,
			tickInterval: runtimeState.tickInterval,
			healthInterval: runtimeState.healthInterval,
			dedupeCleanup: runtimeState.dedupeCleanup,
			mediaCleanup: runtimeState.mediaCleanup,
			agentUnsub: runtimeState.agentUnsub,
			heartbeatUnsub: runtimeState.heartbeatUnsub,
			transcriptUnsub: runtimeState.transcriptUnsub,
			lifecycleUnsub: runtimeState.lifecycleUnsub,
			chatRunState,
			chatAbortControllers,
			removeChatRun,
			agentRunSeq,
			nodeSendToSession,
			getPendingReplyCount: getTotalPendingReplies,
			clients,
			configReloader: runtimeState.configReloader,
			wss,
			httpServer,
			httpServers,
			drainActiveSessionsForShutdown
		})(opts);
	};
	let clearFallbackGatewayContextForServer = () => {};
	const closeOnStartupFailure = async () => {
		try {
			stopRegisteredGatewayLifetimeSidecars();
			stopRegisteredPostReadySidecars();
			await runClosePrelude();
			await createCloseHandler()({ reason: "gateway startup failed" });
		} finally {
			clearFallbackGatewayContextForServer();
		}
	};
	const broadcastVoiceWakeRoutingChanged = (config) => {
		broadcast("voicewake.routing.changed", { config }, { dropIfSlow: true });
	};
	try {
		const earlyRuntime = await startupTrace.measure("runtime.early", () => loadGatewayStartupEarlyModule().then(({ startGatewayEarlyRuntime }) => startGatewayEarlyRuntime({
			minimalTestGateway,
			cfgAtStart,
			port,
			gatewayTls,
			gatewayDirectReachable: !isLoopbackHost(bindHost),
			tailscaleMode,
			log,
			logDiscovery,
			nodeRegistry,
			pluginRegistry,
			broadcast,
			nodeSendToAllSubscribed,
			getPresenceVersion,
			getHealthVersion,
			refreshGatewayHealthSnapshot: refreshGatewayHealthSnapshotWithRuntime,
			logHealth,
			dedupe,
			chatAbortControllers,
			chatRunState,
			chatRunBuffers,
			chatDeltaSentAt,
			chatDeltaLastBroadcastLen,
			removeChatRun,
			agentRunSeq,
			nodeSendToSession,
			...typeof cfgAtStart.media?.ttlHours === "number" ? { mediaCleanupTtlMs: resolveMediaCleanupTtlMs(cfgAtStart.media.ttlHours) } : {},
			skillsRefreshDelayMs: runtimeState.skillsRefreshDelayMs,
			getSkillsRefreshTimer: () => runtimeState.skillsRefreshTimer,
			setSkillsRefreshTimer: (timer) => {
				runtimeState.skillsRefreshTimer = timer;
			},
			getRuntimeConfig,
			startupTrace
		})));
		runtimeState.bonjourStop = earlyRuntime.bonjourStop;
		getActiveTaskCount = earlyRuntime.getActiveTaskCount;
		runtimeState.skillsChangeUnsub = earlyRuntime.skillsChangeUnsub;
		const [{ startGatewayEventSubscriptions }, gatewayRuntimeServices] = await Promise.all([import("./server-runtime-subscriptions-K1ToqQoD.js"), import("./server-runtime-services-DIy3QoBL.js")]);
		Object.assign(runtimeState, startGatewayEventSubscriptions({
			broadcast,
			broadcastToConnIds,
			nodeSendToSession,
			agentRunSeq,
			chatRunState,
			toolEventRecipients,
			sessionEventSubscribers,
			sessionMessageSubscribers,
			chatAbortControllers
		}));
		Object.assign(runtimeState, gatewayRuntimeServices.startGatewayRuntimeServices({
			minimalTestGateway,
			cfgAtStart,
			channelManager,
			log
		}));
		const { createGatewayAuxHandlers } = await import("./server-aux-handlers-CLxg0m7D.js");
		const { coreGatewayHandlers } = await import("./server-methods-90LGtoqF.js");
		const { execApprovalManager, pluginApprovalManager, extraHandlers } = createGatewayAuxHandlers({
			log,
			activateRuntimeSecrets,
			sharedGatewaySessionGenerationState,
			resolveSharedGatewaySessionGenerationForConfig,
			clients,
			startChannel,
			stopChannel,
			logChannels
		});
		const attachedGatewayExtraHandlers = {
			...pluginRegistry.gatewayHandlers,
			...extraHandlers
		};
		let attachedPluginGatewayHandlerKeys = new Set(Object.keys(pluginRegistry.gatewayHandlers));
		const buildAttachedGatewayMethodRegistry = (nextPluginRegistry) => {
			const coreDescriptorHandlers = { ...coreGatewayHandlers };
			const auxHandlers = {};
			for (const [method, handler] of Object.entries(extraHandlers)) if (isCoreGatewayMethodClassified(method)) coreDescriptorHandlers[method] = handler;
			else auxHandlers[method] = handler;
			return createGatewayMethodRegistry([
				...createCoreGatewayMethodDescriptors(coreDescriptorHandlers),
				...createPluginGatewayMethodDescriptors(nextPluginRegistry),
				...createGatewayMethodDescriptorsFromHandlers({
					handlers: auxHandlers,
					owner: {
						kind: "aux",
						area: "gateway-extra"
					},
					defaultScope: ADMIN_SCOPE
				})
			]);
		};
		let attachedGatewayMethodRegistry = buildAttachedGatewayMethodRegistry(pluginRegistry);
		const listAttachedGatewayMethods = () => {
			const methods = attachedGatewayMethodRegistry.listAdvertisedMethods();
			methods.push(...listStartupChannelGatewayMethods());
			return Array.from(new Set(methods));
		};
		runtimeState.gatewayMethods.splice(0, runtimeState.gatewayMethods.length, ...listAttachedGatewayMethods());
		const replaceAttachedPluginRuntime = (loaded) => {
			pluginRegistry = loaded.pluginRegistry;
			baseGatewayMethods = loaded.gatewayMethods;
			for (const key of attachedPluginGatewayHandlerKeys) delete attachedGatewayExtraHandlers[key];
			Object.assign(attachedGatewayExtraHandlers, pluginRegistry.gatewayHandlers);
			attachedPluginGatewayHandlerKeys = new Set(Object.keys(pluginRegistry.gatewayHandlers));
			attachedGatewayMethodRegistry = buildAttachedGatewayMethodRegistry(pluginRegistry);
			runtimeState.gatewayMethods.splice(0, runtimeState.gatewayMethods.length, ...listAttachedGatewayMethods());
			pinActivePluginHttpRouteRegistry(pluginRegistry);
			pinActivePluginChannelRegistry(pluginRegistry);
		};
		const refreshAttachedGatewayDiscovery = async (nextPluginRegistry) => {
			if (minimalTestGateway) return;
			try {
				const stopPreviousDiscovery = runtimeState.bonjourStop;
				runtimeState.bonjourStop = null;
				if (stopPreviousDiscovery) try {
					await stopPreviousDiscovery();
				} catch (err) {
					logDiscovery.warn(`gateway discovery stop failed before plugin refresh: ${String(err)}`);
				}
				const { startGatewayPluginDiscovery } = await loadGatewayStartupEarlyModule();
				runtimeState.bonjourStop = await startGatewayPluginDiscovery({
					minimalTestGateway,
					cfgAtStart,
					port,
					gatewayTls,
					gatewayDirectReachable: !isLoopbackHost(bindHost),
					tailscaleMode,
					logDiscovery,
					pluginRegistry: nextPluginRegistry
				});
			} catch (err) {
				logDiscovery.warn(`gateway discovery refresh failed after plugin load: ${String(err)}`);
			}
		};
		const listAttachedChannelConfigTargets = () => new Map(listGatewayStartupChannelPlugins().map((plugin) => [plugin.id, listChannelPluginConfigTargetIds({
			channelId: plugin.id,
			pluginId: getLoadedChannelPluginEntryById(plugin.id)?.pluginId,
			aliases: plugin.meta.aliases
		})]));
		const reloadAttachedGatewayPlugins = async (params) => {
			const beforeChannelTargets = listAttachedChannelConfigTargets();
			const beforeChannelIds = new Set(beforeChannelTargets.keys());
			const [{ loadPluginLookUpTable }, { prepareGatewayPluginLoad }, { startPluginServices }] = await Promise.all([
				import("./plugin-lookup-table-Ciy2ad3x.js"),
				import("./server-plugin-bootstrap-Cf8Io8s6.js"),
				import("./services-Bi127fBi.js")
			]);
			const nextPluginLookUpTable = loadPluginLookUpTable({
				config: params.nextConfig,
				workspaceDir: defaultWorkspaceDir,
				env: process.env,
				activationSourceConfig: params.nextConfig
			});
			const nextStartupPluginIds = new Set(nextPluginLookUpTable.startup.pluginIds);
			const nextStartupChannelIds = /* @__PURE__ */ new Set();
			for (const plugin of nextPluginLookUpTable.manifestRegistry.plugins) {
				if (!nextStartupPluginIds.has(plugin.id)) continue;
				if (plugin.channels.length === 0) {
					nextStartupChannelIds.add(plugin.id);
					continue;
				}
				for (const channelId of plugin.channels) nextStartupChannelIds.add(channelId);
			}
			const channelsToStopBeforeReplace = /* @__PURE__ */ new Set();
			for (const channelId of beforeChannelIds) {
				const targetIds = beforeChannelTargets.get(channelId) ?? new Set([channelId]);
				if (!nextStartupChannelIds.has(channelId) || pluginConfigTargetsChanged(targetIds, params.changedPaths)) channelsToStopBeforeReplace.add(channelId);
			}
			await params.beforeReplace(channelsToStopBeforeReplace);
			setCurrentPluginMetadataSnapshot(nextPluginLookUpTable, {
				config: params.nextConfig,
				env: process.env,
				workspaceDir: defaultWorkspaceDir
			});
			const loaded = prepareGatewayPluginLoad({
				cfg: params.nextConfig,
				workspaceDir: defaultWorkspaceDir,
				log,
				coreGatewayMethodNames,
				hostServices: pluginHostServices,
				baseMethods,
				pluginLookUpTable: nextPluginLookUpTable
			});
			const previousPluginServices = runtimeState.pluginServices;
			runtimeState.pluginServices = null;
			if (previousPluginServices) await previousPluginServices.stop().catch((err) => {
				log.warn(`plugin services stop failed during reload: ${String(err)}`);
			});
			replaceAttachedPluginRuntime(loaded);
			await refreshAttachedGatewayDiscovery(loaded.pluginRegistry);
			try {
				runtimeState.pluginServices = await startPluginServices({
					registry: loaded.pluginRegistry,
					config: params.nextConfig,
					workspaceDir: defaultWorkspaceDir
				});
			} catch (err) {
				log.warn(`plugin services failed to start after reload: ${String(err)}`);
			}
			const afterChannelTargets = listAttachedChannelConfigTargets();
			const afterChannelIds = new Set(afterChannelTargets.keys());
			const restartChannels = /* @__PURE__ */ new Set();
			for (const channelId of new Set([...beforeChannelIds, ...afterChannelIds])) {
				const targetIds = afterChannelTargets.get(channelId) ?? beforeChannelTargets.get(channelId) ?? new Set([channelId]);
				if (afterChannelIds.has(channelId) && (beforeChannelIds.has(channelId) !== afterChannelIds.has(channelId) || pluginConfigTargetsChanged(targetIds, params.changedPaths))) restartChannels.add(channelId);
			}
			return {
				restartChannels,
				activeChannels: afterChannelIds
			};
		};
		const unavailableGatewayMethods = new Set(minimalTestGateway ? [] : STARTUP_UNAVAILABLE_GATEWAY_METHODS);
		const { createGatewayRequestContext } = await import("./server-request-context-BClu1RJg.js");
		const gatewayRequestContext = createGatewayRequestContext({
			deps,
			runtimeState,
			getRuntimeConfig,
			execApprovalManager,
			pluginApprovalManager,
			loadGatewayModelCatalog,
			getHealthCache,
			refreshHealthSnapshot: refreshGatewayHealthSnapshotWithRuntime,
			logHealth,
			logGateway: log,
			incrementPresenceVersion,
			getHealthVersion,
			broadcast,
			broadcastToConnIds,
			nodeSendToSession,
			nodeSendToAllSubscribed,
			nodeSubscribe,
			nodeUnsubscribe,
			nodeUnsubscribeAll,
			hasConnectedTalkNode: hasTalkNodeConnected,
			clients,
			enforceSharedGatewayAuthGenerationForConfigWrite: (nextConfig) => {
				enforceSharedGatewaySessionGenerationForConfigWrite({
					state: sharedGatewaySessionGenerationState,
					nextConfig,
					resolveRuntimeSnapshotGeneration: resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
					clients
				});
			},
			nodeRegistry,
			agentRunSeq,
			chatAbortControllers,
			chatAbortedRuns: chatRunState.abortedRuns,
			chatRunBuffers: chatRunState.buffers,
			chatDeltaSentAt: chatRunState.deltaSentAt,
			chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
			chatDeltaLastBroadcastText: chatRunState.deltaLastBroadcastText,
			agentDeltaSentAt: chatRunState.agentDeltaSentAt,
			bufferedAgentEvents: chatRunState.bufferedAgentEvents,
			addChatRun,
			removeChatRun,
			subscribeSessionEvents: sessionEventSubscribers.subscribe,
			unsubscribeSessionEvents: sessionEventSubscribers.unsubscribe,
			subscribeSessionMessageEvents: sessionMessageSubscribers.subscribe,
			unsubscribeSessionMessageEvents: sessionMessageSubscribers.unsubscribe,
			unsubscribeAllSessionEvents: (connId) => {
				sessionEventSubscribers.unsubscribe(connId);
				sessionMessageSubscribers.unsubscribeAll(connId);
			},
			getSessionEventSubscriberConnIds: sessionEventSubscribers.getAll,
			registerToolEventRecipient: toolEventRecipients.add,
			dedupe,
			wizardSessions,
			findRunningWizard,
			purgeWizardSession,
			getRuntimeSnapshot,
			getEventLoopHealth: readinessEventLoopHealth.snapshot,
			startChannel,
			stopChannel,
			markChannelLoggedOut,
			wizardRunner,
			broadcastVoiceWakeChanged,
			unavailableGatewayMethods,
			broadcastVoiceWakeRoutingChanged
		});
		currentPluginRegistryGatewayContext = gatewayRequestContext;
		const fallbackGatewayContextCleanup = setFallbackGatewayContextResolver(() => gatewayRequestContext);
		clearFallbackGatewayContextForServer = typeof fallbackGatewayContextCleanup === "function" ? () => {
			fallbackGatewayContextCleanup();
		} : () => {};
		if (!minimalTestGateway) {
			if (runtimePluginsLoaded && deferredConfiguredChannelPluginIds.length > 0) {
				const { reloadDeferredGatewayPlugins } = await import("./server-plugin-bootstrap-Cf8Io8s6.js");
				const loaded = reloadDeferredGatewayPlugins({
					cfg: gatewayPluginConfigAtStart,
					activationSourceConfig: startupActivationSourceConfig,
					workspaceDir: defaultWorkspaceDir,
					log,
					coreGatewayMethodNames,
					hostServices: pluginHostServices,
					baseMethods,
					pluginIds: startupPluginIds,
					pluginLookUpTable,
					logDiagnostics: false
				});
				replaceAttachedPluginRuntime(loaded);
				await refreshAttachedGatewayDiscovery(loaded.pluginRegistry);
			}
		}
		const { attachGatewayWsHandlers } = await import("./server-ws-runtime-CGwRNHq_.js");
		const { listPluginNodeCapabilities } = await import("./route-capability-DMdOu_-R.js");
		const pluginSurfaceScheme = gatewayTls.enabled ? "https" : "http";
		attachGatewayWsHandlers({
			wss,
			clients,
			preauthConnectionBudget,
			port,
			gatewayHost: bindHost ?? void 0,
			pluginSurfaceScheme,
			getPluginNodeCapabilities: () => listPluginNodeCapabilities(pluginRegistry),
			resolvedAuth,
			getResolvedAuth,
			getRequiredSharedGatewaySessionGeneration: () => getRequiredSharedGatewaySessionGeneration(sharedGatewaySessionGenerationState),
			rateLimiter: authRateLimiter,
			browserRateLimiter: browserAuthRateLimiter,
			preauthHandshakeTimeoutMs,
			isStartupPending: () => !startupSidecarsReady,
			gatewayMethods: runtimeState.gatewayMethods,
			events: GATEWAY_EVENTS,
			logGateway: log,
			logHealth,
			logWsControl,
			extraHandlers: attachedGatewayExtraHandlers,
			getMethodRegistry: () => attachedGatewayMethodRegistry,
			broadcast,
			context: gatewayRequestContext
		});
		await startListening();
		startupTrace.mark("http.bound");
		const sessionDeliveryRecoveryMaxEnqueuedAt = Date.now();
		let postAttachRuntimeReturned = false;
		let scheduledServicesActivated = false;
		const activateScheduledServicesWhenReady = () => {
			if (closePreludeStarted || !postAttachRuntimeReturned || !startupSidecarsReady || scheduledServicesActivated) return;
			const activated = gatewayRuntimeServices.activateGatewayScheduledServices({
				minimalTestGateway,
				cfgAtStart,
				deps,
				sessionDeliveryRecoveryMaxEnqueuedAt,
				cron: runtimeState.cronState.cron,
				startCron: false,
				logCron,
				log,
				pluginLookUpTable
			});
			scheduledServicesActivated = true;
			runtimeState.heartbeatRunner = activated.heartbeatRunner;
			runtimeState.stopModelPricingRefresh = activated.stopModelPricingRefresh;
		};
		({stopGatewayUpdateCheck: runtimeState.stopGatewayUpdateCheck, tailscaleCleanup: runtimeState.tailscaleCleanup, pluginServices: runtimeState.pluginServices} = await startupTrace.measure("runtime.post-attach", () => loadGatewayStartupPostAttachModule().then(({ startGatewayPostAttachRuntime, stopPostReadySidecarsAfterCloseStarted }) => startGatewayPostAttachRuntime({
			minimalTestGateway,
			cfgAtStart,
			bindHost,
			bindHosts: httpBindHosts,
			port,
			tlsEnabled: gatewayTls.enabled,
			log,
			isNixMode,
			startupStartedAt: opts.startupStartedAt,
			broadcast,
			tailscaleMode,
			resetOnExit: tailscaleConfig.resetOnExit ?? false,
			preserveFunnel: tailscaleConfig.preserveFunnel ?? false,
			controlUiBasePath,
			logTailscale,
			gatewayPluginConfigAtStart,
			pluginRegistry,
			defaultWorkspaceDir,
			deps,
			startChannels,
			logHooks,
			logChannels,
			unavailableGatewayMethods,
			loadStartupPlugins: runtimePluginsLoaded ? void 0 : async () => {
				const { loadGatewayStartupPluginRuntime } = await loadStartupPluginsModule();
				return loadGatewayStartupPluginRuntime({
					cfg: gatewayPluginConfigAtStart,
					activationSourceConfig: startupActivationSourceConfig,
					workspaceDir: defaultWorkspaceDir,
					log,
					baseMethods,
					coreGatewayMethodNames,
					hostServices: pluginHostServices,
					startupPluginIds,
					pluginLookUpTable,
					startupTrace
				});
			},
			onStartupPluginsLoading: () => {
				startupPendingReason = "startup-sidecars";
			},
			onStartupPluginsLoaded: async (loaded) => {
				replaceAttachedPluginRuntime(loaded);
				startupPendingReason = "startup-sidecars";
				await refreshAttachedGatewayDiscovery(loaded.pluginRegistry);
			},
			getCronService: () => runtimeState?.cronState.cron,
			onPluginServices: (pluginServices) => {
				runtimeState.pluginServices = pluginServices;
			},
			onPostReadySidecars: (postReadySidecars) => {
				runtimeState.postReadySidecars = postReadySidecars;
				stopPostReadySidecarsAfterCloseStarted({
					postReadySidecars,
					closeStarted: closePreludeStarted
				});
				if (closePreludeStarted) runtimeState.postReadySidecars = [];
			},
			onGatewayLifetimeSidecars: (gatewayLifetimeSidecars) => {
				runtimeState.gatewayLifetimeSidecars = gatewayLifetimeSidecars;
				stopPostReadySidecarsAfterCloseStarted({
					postReadySidecars: gatewayLifetimeSidecars,
					closeStarted: closePreludeStarted
				});
				if (closePreludeStarted) runtimeState.gatewayLifetimeSidecars = [];
			},
			onSidecarsReady: () => {
				startupSidecarsReady = true;
				activateScheduledServicesWhenReady();
			},
			startupTrace,
			deferSidecars: opts.deferStartupSidecars === true,
			providerAuthPrewarm: { getConfig: getRuntimeConfig }
		}))));
		startupTrace.detail("memory.ready", collectGatewayProcessMemoryUsageMb());
		startupTrace.mark("ready");
		finishGatewayRestartTrace("restart.ready", collectGatewayProcessMemoryUsageMb());
		postAttachRuntimeReturned = true;
		activateScheduledServicesWhenReady();
		const { startManagedGatewayConfigReloader } = await import("./server-reload-handlers-PJ6pQPWj.js");
		runtimeState.configReloader = startManagedGatewayConfigReloader({
			minimalTestGateway,
			initialConfig: cfgAtStart,
			initialCompareConfig: startupLastGoodSnapshot.sourceConfig,
			initialInternalWriteHash: startupInternalWriteHash,
			watchPath: configSnapshot.path,
			readSnapshot: readConfigFileSnapshot,
			promoteSnapshot: promoteConfigSnapshotToLastKnownGood,
			subscribeToWrites: registerConfigWriteListener,
			deps,
			broadcast,
			getState: () => ({
				hooksConfig: runtimeState.hooksConfig,
				hookClientIpConfig: runtimeState.hookClientIpConfig,
				heartbeatRunner: runtimeState.heartbeatRunner,
				cronState: runtimeState.cronState,
				channelHealthMonitor: runtimeState.channelHealthMonitor
			}),
			setState: (nextState) => {
				const cronStateChanged = nextState.cronState !== runtimeState.cronState;
				runtimeState.hooksConfig = nextState.hooksConfig;
				runtimeState.hookClientIpConfig = nextState.hookClientIpConfig;
				runtimeState.heartbeatRunner = nextState.heartbeatRunner;
				runtimeState.cronState = nextState.cronState;
				deps.cron = runtimeState.cronState.cron;
				runtimeState.channelHealthMonitor = nextState.channelHealthMonitor;
				if (cronStateChanged) gatewayCronStartHandled = true;
			},
			startChannel,
			stopChannel,
			stopPostReadySidecars: stopRegisteredPostReadySidecars,
			reloadPlugins: reloadAttachedGatewayPlugins,
			logHooks,
			logChannels,
			logCron,
			logReload,
			onCronRestart: () => {
				gatewayCronStartHandled = true;
			},
			channelManager,
			activateRuntimeSecrets,
			resolveSharedGatewaySessionGenerationForConfig,
			sharedGatewaySessionGenerationState,
			clients
		});
		await promoteConfigSnapshotToLastKnownGood(startupLastGoodSnapshot).catch((err) => {
			log.warn(`gateway: failed to promote config last-known-good backup: ${String(err)}`);
		});
		if (!minimalTestGateway) postReadyMaintenanceTimer = gatewayRuntimeServices.scheduleGatewayPostReadyMaintenance({
			delayMs: POST_READY_MAINTENANCE_DELAY_MS,
			isClosing: () => closePreludeStarted,
			onStarted: () => {
				postReadyMaintenanceTimer = null;
			},
			startMaintenance: async () => {
				if (closePreludeStarted) return null;
				return earlyRuntime.startMaintenance();
			},
			applyMaintenance: (maintenance) => {
				if (closePreludeStarted) {
					clearInterval(maintenance.tickInterval);
					clearInterval(maintenance.healthInterval);
					clearInterval(maintenance.dedupeCleanup);
					if (maintenance.mediaCleanup) clearInterval(maintenance.mediaCleanup);
					return;
				}
				runtimeState.tickInterval = maintenance.tickInterval;
				runtimeState.healthInterval = maintenance.healthInterval;
				runtimeState.dedupeCleanup = maintenance.dedupeCleanup;
				runtimeState.mediaCleanup = maintenance.mediaCleanup;
			},
			shouldStartCron: () => !closePreludeStarted && !gatewayCronStartHandled,
			markCronStartHandled: () => {
				gatewayCronStartHandled = true;
			},
			cron: runtimeState.cronState.cron,
			logCron,
			log,
			recordPostReadyMemory: () => {
				startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
			}
		});
		else startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
	} catch (err) {
		await closeOnStartupFailure();
		throw err;
	}
	const close = createCloseHandler();
	return { close: async (opts) => {
		try {
			markClosePreludeStarted();
			stopRegisteredGatewayLifetimeSidecars();
			stopRegisteredPostReadySidecars();
			const { runGlobalGatewayStopSafely } = await import("./plugins/hook-runner-global.js");
			await runGlobalGatewayStopSafely({
				event: { reason: opts?.reason ?? "gateway stopping" },
				ctx: { port },
				onError: (err) => log.warn(`gateway_stop hook failed: ${String(err)}`)
			});
			await runClosePrelude();
			await close(opts);
		} finally {
			clearFallbackGatewayContextForServer();
		}
	} };
}
//#endregion
export { resetModelCatalogCacheForTest, startGatewayServer };
