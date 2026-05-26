import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { b as resolveSubagentModelConfigSelectionResult } from "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { t as matchesSkillFilter } from "./filter-CuPfbjn1.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { n as isThinkingLevelSupported, o as resolveSupportedThinkingLevel, p as normalizeThinkLevel } from "./thinking-DNSlsULp.js";
import { a as listOpenAIAuthProfileProvidersForAgentRuntime } from "./openai-codex-routing-DwRY-_VI.js";
import { t as resolveAgentHarnessPolicy } from "./policy-BwWh-R0D.js";
import { t as clearAgentRunContext } from "./agent-events-BuYtWSh4.js";
import { h as stringifyRouteThreadId } from "./channel-route-L2PJ-xNE.js";
import { o as resolveSessionTranscriptPath } from "./paths-Bg3PO6Gj.js";
import { u as setSessionRuntimeModel } from "./types-BgvyBC-3.js";
import { t as hasAnyAuthProfileStoreSource } from "./source-check-BMw3fGLx.js";
import { b as resolveHooksGmailModel, d as normalizeModelSelection, v as resolveConfiguredModelRef } from "./model-selection-shared-ClxdEp4X.js";
import { i as resolveAllowedModelRef, r as getModelRefStatus, t as isCliProvider } from "./model-selection-cli-DS-HhXIv.js";
import { m as resolveThinkingDefault } from "./model-selection-P-81eBKx.js";
import { n as loadModelCatalog } from "./model-catalog-DhWpNp70.js";
import { r as resolveAgentTimeoutMs } from "./task-completion-contract-D5t-_eBh.js";
import { i as hasNonzeroUsage, r as deriveSessionTotalTokens } from "./usage-DKNTRfvn.js";
import { u as isCommandLaneTaskTimeoutError } from "./command-queue-Da2Lh3Ua.js";
import { n as createCronRunDiagnosticsFromError, r as mergeCronRunDiagnostics, t as createCronRunDiagnosticsFromAgentResult } from "./run-diagnostics-BXtBy-0s.js";
import "./selection-hR-AeOeU.js";
import { l as ensureAgentWorkspace } from "./workspace-DTx8zuCN.js";
import { s as retireSessionMcpRuntime } from "./pi-bundle-mcp-runtime-CwBDIKIq.js";
import "./pi-bundle-mcp-tools-_xKQdIka.js";
import { o as normalizeTargetForProvider } from "./target-id-resolution-DVSHqxJ3.js";
import { c as resolveHookExternalContentSource, o as isExternalHookSession, s as mapHookExternalContentSource } from "./external-content-BWPoz0BU.js";
import { n as resolveCronStyleNow } from "./current-time-DEwZwyQB.js";
import { t as resolveCronDeliveryPlan } from "./delivery-plan-DRpBOJ2V.js";
import { i as persistCronSkillsSnapshotIfChanged, n as createPersistCronSessionEntry, o as resolveCronChannelOutputPolicy, r as markCronSessionPreRun, t as adoptCronRunSessionMetadata } from "./run-session-state-UVBQbELh.js";
import { a as resolveHeartbeatAckMaxChars, i as resolveCronPayloadOutcome, t as isHeartbeatOnlyResponse } from "./helpers-CdmKDEvq.js";
import { t as resolveCronAgentSessionKey } from "./session-key-D_ijetg2.js";
import { t as resolveCronSession } from "./session-0QcI3GAo.js";
//#region src/infra/outbound/source-delivery-plan.ts
function isMessageToolOwnedDelivery(owner) {
	return owner === "message_tool" || owner === "message_tool_then_direct_fallback";
}
function normalizeDeliveryTarget(channel, to) {
	const toTrimmed = to.trim();
	return normalizeTargetForProvider(channel, toTrimmed) ?? toTrimmed;
}
const caseSensitivePrefixedTargetProviders = new Set([
	"googlechat",
	"mattermost",
	"matrix"
]);
const lowercaseNormalizedPrefixedTargetProviders = new Set(["discord", "slack"]);
function deliveryTargetsMatch(channel, targetTo, deliveryTo) {
	const targetToTrimmed = targetTo.trim();
	const deliveryToTrimmed = deliveryTo.trim();
	if (targetToTrimmed === deliveryToTrimmed) return true;
	const targetPrefixed = targetToTrimmed.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
	const deliveryPrefixed = deliveryToTrimmed.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
	const targetKind = targetPrefixed?.[1]?.toLowerCase();
	const deliveryKind = deliveryPrefixed?.[1]?.toLowerCase();
	if (targetKind && targetKind === deliveryKind && [
		"channel",
		"conversation",
		"group",
		"user"
	].includes(targetKind)) {
		const targetId = targetPrefixed?.[2]?.trim();
		const deliveryId = deliveryPrefixed?.[2]?.trim();
		if (caseSensitivePrefixedTargetProviders.has(channel)) return targetId === deliveryId;
		if (lowercaseNormalizedPrefixedTargetProviders.has(channel)) return targetId?.toLowerCase() === deliveryId?.toLowerCase();
	}
	return normalizeDeliveryTarget(channel, targetToTrimmed) === normalizeDeliveryTarget(channel, deliveryToTrimmed);
}
function normalizeDeliveryThreadId(threadId) {
	return stringifyRouteThreadId(threadId)?.trim() || void 0;
}
function extractTopicThreadId(targetTo) {
	return targetTo.match(/:topic:(\d+)$/i)?.[1];
}
function sourceDeliveryTargetsMatch(target, delivery) {
	if (!delivery.channel || !delivery.to || !target.to) return false;
	const channel = delivery.channel.trim().toLowerCase();
	const provider = target.provider?.trim().toLowerCase();
	if (provider && provider !== "message" && provider !== channel) return false;
	if (delivery.accountId && target.accountId && target.accountId !== delivery.accountId) return false;
	if (!deliveryTargetsMatch(channel, target.to.replace(/:topic:\d+$/, ""), delivery.to)) return false;
	const deliveryThreadId = normalizeDeliveryThreadId(delivery.threadId);
	const targetThreadId = normalizeDeliveryThreadId(target.threadId) ?? extractTopicThreadId(target.to);
	if (!deliveryThreadId && !targetThreadId) return true;
	if (deliveryThreadId && !targetThreadId) return target.threadImplicit === true && target.threadSuppressed !== true;
	return deliveryThreadId === targetThreadId;
}
function createSourceDeliveryPlan(params) {
	const messageToolOwnsDelivery = isMessageToolOwnedDelivery(params.owner);
	const sourceReplyDeliveryMode = messageToolOwnsDelivery ? "message_tool_only" : void 0;
	const directDelivery = params.directFallback ?? (params.owner === "direct_fallback" || params.owner === "message_tool_then_direct_fallback");
	return {
		owner: params.owner,
		reason: params.reason,
		target: params.target ?? {},
		normalFinal: sourceReplyDeliveryMode === "message_tool_only" || params.owner === "none" ? "private" : "visible",
		sourceReplyDeliveryMode,
		messageTool: {
			enabled: params.messageToolEnabled ?? messageToolOwnsDelivery,
			force: params.messageToolForced ?? messageToolOwnsDelivery,
			requireExplicitTarget: params.requireExplicitMessageTarget ?? false,
			defaultTarget: Boolean(params.target?.channel || params.target?.to)
		},
		fallback: {
			directDelivery,
			skipWhenMessageToolSentToTarget: params.skipFallbackWhenMessageToolSentToTarget ?? params.owner === "message_tool_then_direct_fallback",
			bestEffort: params.fallbackBestEffort ?? false
		},
		progress: { allowCallbacksWhenSourceDeliverySuppressed: params.allowProgressCallbacksWhenSourceDeliverySuppressed ?? false }
	};
}
function resolveImplicitMessageToolDeliveryTarget(plan) {
	if (!plan.target.channel || !plan.target.to) return;
	const threadId = stringifyRouteThreadId(plan.target.threadId);
	return {
		tool: "message",
		provider: plan.target.channel,
		...plan.target.accountId ? { accountId: plan.target.accountId } : {},
		...plan.target.to ? { to: plan.target.to } : {},
		...threadId ? { threadId } : {}
	};
}
function resolveSourceDeliveryOutcome(plan, params) {
	const didSendViaMessageTool = params.didSendViaMessageTool === true;
	const explicitTargets = params.messageToolSentTargets ?? [];
	const sentTargets = explicitTargets.length > 0 ? explicitTargets : didSendViaMessageTool ? [resolveImplicitMessageToolDeliveryTarget(plan)].filter((target) => Boolean(target)) : [];
	const visibleDeliveries = sentTargets.map((target) => ({
		via: "message_tool",
		target,
		verifiedTarget: sourceDeliveryTargetsMatch(target, plan.target)
	}));
	const hasVerifiedMessageToolDelivery = visibleDeliveries.some((delivery) => didSendViaMessageTool && delivery.verifiedTarget);
	return {
		visibleDeliveries,
		verifiedMessageToolDelivery: hasVerifiedMessageToolDelivery,
		satisfiesSourceDelivery: plan.fallback.skipWhenMessageToolSentToTarget && hasVerifiedMessageToolDelivery,
		unverifiedMessageToolDelivery: didSendViaMessageTool && sentTargets.length > 0 && !hasVerifiedMessageToolDelivery
	};
}
//#endregion
//#region src/cron/isolated-agent/model-selection.ts
function formatAllowedModelRefs(params) {
	const configured = params.cfg.agents?.defaults?.models;
	if (configured && typeof configured === "object" && Object.keys(configured).length > 0) return Object.keys(configured).toSorted().join(", ");
	return "(none configured)";
}
function formatCronPayloadModelRejection(params) {
	const { modelOverride, error } = params;
	if (error.startsWith("model not allowed:")) return `cron payload.model '${modelOverride}' rejected by agents.defaults.models allowlist: ${error.slice(18).trim()} is not in [${formatAllowedModelRefs({ cfg: params.cfg })}]`;
	return `cron payload.model '${modelOverride}' rejected: ${error}`;
}
async function resolveCronModelSelection(params) {
	const resolvedDefault = resolveConfiguredModelRef({
		cfg: params.cfgWithAgentDefaults,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	let provider = resolvedDefault.provider;
	let model = resolvedDefault.model;
	let modelSource = "default";
	let catalog;
	const loadCatalogOnce = async () => {
		if (!catalog) catalog = await loadModelCatalog({ config: params.cfgWithAgentDefaults });
		return catalog;
	};
	const subagentModelConfigSelection = resolveSubagentModelConfigSelectionResult({
		cfg: params.cfg,
		agentId: params.agentId,
		agentConfigOverride: params.agentConfigOverride
	});
	const subagentModelRaw = normalizeModelSelection(subagentModelConfigSelection?.raw);
	const subagentModelSource = subagentModelConfigSelection?.source === "agent" ? "agent" : "subagent";
	if (subagentModelRaw) {
		const resolvedSubagent = resolveAllowedModelRef({
			cfg: params.cfgWithAgentDefaults,
			catalog: await loadCatalogOnce(),
			raw: subagentModelRaw,
			defaultProvider: resolvedDefault.provider,
			defaultModel: resolvedDefault.model
		});
		if (!("error" in resolvedSubagent)) {
			provider = resolvedSubagent.ref.provider;
			model = resolvedSubagent.ref.model;
			modelSource = subagentModelSource;
		}
	}
	let hooksGmailModelApplied = false;
	const hooksGmailModelRef = params.isGmailHook ? resolveHooksGmailModel({
		cfg: params.cfg,
		defaultProvider: DEFAULT_PROVIDER
	}) : null;
	if (hooksGmailModelRef) {
		if (getModelRefStatus({
			cfg: params.cfg,
			catalog: await loadCatalogOnce(),
			ref: hooksGmailModelRef,
			defaultProvider: resolvedDefault.provider,
			defaultModel: resolvedDefault.model
		}).allowed) {
			provider = hooksGmailModelRef.provider;
			model = hooksGmailModelRef.model;
			hooksGmailModelApplied = true;
			modelSource = "hook";
		}
	}
	const modelOverrideRaw = params.payload.kind === "agentTurn" ? params.payload.model : void 0;
	const modelOverride = typeof modelOverrideRaw === "string" ? modelOverrideRaw.trim() : void 0;
	if (modelOverride !== void 0 && modelOverride.length > 0) {
		const resolvedOverride = resolveAllowedModelRef({
			cfg: params.cfgWithAgentDefaults,
			catalog: await loadCatalogOnce(),
			raw: modelOverride,
			defaultProvider: resolvedDefault.provider,
			defaultModel: resolvedDefault.model
		});
		if ("error" in resolvedOverride) return {
			ok: false,
			error: formatCronPayloadModelRejection({
				cfg: params.cfgWithAgentDefaults,
				modelOverride,
				error: resolvedOverride.error
			})
		};
		provider = resolvedOverride.ref.provider;
		model = resolvedOverride.ref.model;
		modelSource = "payload";
	}
	if (!modelOverride && !hooksGmailModelApplied) {
		const sessionModelOverride = params.sessionEntry.modelOverride?.trim();
		if (sessionModelOverride) {
			const sessionProviderOverride = params.sessionEntry.providerOverride?.trim() || resolvedDefault.provider;
			const resolvedSessionOverride = resolveAllowedModelRef({
				cfg: params.cfgWithAgentDefaults,
				catalog: await loadCatalogOnce(),
				raw: `${sessionProviderOverride}/${sessionModelOverride}`,
				defaultProvider: resolvedDefault.provider,
				defaultModel: resolvedDefault.model
			});
			if (!("error" in resolvedSessionOverride)) {
				provider = resolvedSessionOverride.ref.provider;
				model = resolvedSessionOverride.ref.model;
				modelSource = "session";
			}
		}
	}
	return {
		ok: true,
		provider,
		model,
		modelSource
	};
}
//#endregion
//#region src/cron/isolated-agent/run-config.ts
function extractCronAgentDefaultsOverride(agentConfigOverride) {
	const { model: overrideModel, sandbox: _agentSandboxOverride, ...agentOverrideRest } = agentConfigOverride ?? {};
	return {
		overrideModel,
		definedOverrides: Object.fromEntries(Object.entries(agentOverrideRest).filter(([, value]) => value !== void 0))
	};
}
function mergeCronAgentModelOverride(params) {
	const nextDefaults = { ...params.defaults };
	const existingModel = nextDefaults.model && typeof nextDefaults.model === "object" ? nextDefaults.model : {};
	if (typeof params.overrideModel === "string") nextDefaults.model = {
		...existingModel,
		primary: params.overrideModel
	};
	else if (params.overrideModel) nextDefaults.model = {
		...existingModel,
		...params.overrideModel
	};
	return nextDefaults;
}
function buildCronAgentDefaultsConfig(params) {
	const { overrideModel, definedOverrides } = extractCronAgentDefaultsOverride(params.agentConfigOverride);
	return mergeCronAgentModelOverride({
		defaults: Object.assign({}, params.defaults, definedOverrides),
		overrideModel
	});
}
//#endregion
//#region src/cron/isolated-agent/skills-snapshot.ts
const skillsSnapshotRuntimeLoader = createLazyImportLoader(() => import("./skills-snapshot.runtime.js"));
async function loadSkillsSnapshotRuntime() {
	return await skillsSnapshotRuntimeLoader.load();
}
async function resolveCronSkillsSnapshot(params) {
	if (params.isFastTestEnv) return params.existingSnapshot ?? {
		prompt: "",
		skills: []
	};
	const runtime = await loadSkillsSnapshotRuntime();
	const snapshotVersion = runtime.getSkillsSnapshotVersion(params.workspaceDir);
	const skillFilter = runtime.resolveAgentSkillsFilter(params.config, params.agentId);
	const existingSnapshot = params.existingSnapshot;
	if (!(!existingSnapshot || existingSnapshot.version !== snapshotVersion || !matchesSkillFilter(existingSnapshot.skillFilter, skillFilter))) return existingSnapshot;
	return runtime.buildWorkspaceSkillSnapshot(params.workspaceDir, {
		config: params.config,
		agentId: params.agentId,
		skillFilter,
		eligibility: { remote: runtime.getRemoteSkillEligibility({ advertiseExecNode: runtime.canExecRequestNode({
			cfg: params.config,
			agentId: params.agentId
		}) }) },
		snapshotVersion
	});
}
//#endregion
//#region src/cron/isolated-agent/run.ts
const sessionStoreRuntimeLoader = createLazyImportLoader(() => import("./store.runtime.js"));
const cronExecutorRuntimeLoader = createLazyImportLoader(() => import("./run-executor.runtime.js"));
const cronExternalContentRuntimeLoader = createLazyImportLoader(() => import("./run-external-content.runtime.js"));
const cronAuthProfileRuntimeLoader = createLazyImportLoader(() => import("./run-auth-profile.runtime.js"));
const cronContextRuntimeLoader = createLazyImportLoader(() => import("./run-context.runtime.js"));
const cronModelCatalogRuntimeLoader = createLazyImportLoader(() => import("./run-model-catalog.runtime.js"));
const cronDeliveryRuntimeLoader = createLazyImportLoader(() => import("./run-delivery.runtime.js"));
const cronModelPreflightRuntimeLoader = createLazyImportLoader(() => import("./model-preflight.runtime.js"));
const runtimePluginsLoader = createLazyImportLoader(() => import("./run-runtime-plugins.runtime.js"));
async function loadSessionStoreRuntime() {
	return await sessionStoreRuntimeLoader.load();
}
async function loadCronExecutorRuntime() {
	return await cronExecutorRuntimeLoader.load();
}
async function loadCronExternalContentRuntime() {
	return await cronExternalContentRuntimeLoader.load();
}
async function loadCronAuthProfileRuntime() {
	return await cronAuthProfileRuntimeLoader.load();
}
async function loadCronContextRuntime() {
	return await cronContextRuntimeLoader.load();
}
async function loadCronModelCatalogRuntime() {
	return await cronModelCatalogRuntimeLoader.load();
}
async function loadCronDeliveryRuntime() {
	return await cronDeliveryRuntimeLoader.load();
}
async function loadCronModelPreflightRuntime() {
	return await cronModelPreflightRuntimeLoader.load();
}
async function loadRuntimePlugins() {
	return await runtimePluginsLoader.load();
}
function hasConfiguredAuthProfiles(cfg) {
	return Boolean(cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) || Boolean(cfg.auth?.order && Object.keys(cfg.auth.order).length > 0);
}
function resolveNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function isCronNestedLaneTaskTimeoutError(err) {
	return isCommandLaneTaskTimeoutError(err, "cron-nested");
}
async function retireRolledCronSessionMcpRuntime(params) {
	if (params.job.sessionTarget === "isolated") return;
	const previousSessionId = normalizeOptionalString(params.cronSession.previousSessionId);
	const currentSessionId = normalizeOptionalString(params.cronSession.sessionEntry.sessionId);
	if (!previousSessionId || previousSessionId === currentSessionId) return;
	await retireSessionMcpRuntime({
		sessionId: previousSessionId,
		reason: "cron-session-rollover",
		onError: (error, sessionId) => {
			logWarn(`[cron:${params.job.id}] Failed to dispose retired bundle MCP runtime for session ${sessionId}: ${String(error)}`);
		}
	});
}
function normalizeCronTraceTarget(target) {
	if (!target) return;
	return {
		...target.channel ? { channel: target.channel } : {},
		...target.to !== void 0 ? { to: target.to } : {},
		...target.accountId ? { accountId: target.accountId } : {},
		...target.threadId !== void 0 ? { threadId: target.threadId } : {},
		...target.source ? { source: target.source } : {}
	};
}
function normalizeMessagingToolTarget(delivery, resolvedDelivery) {
	const { target } = delivery;
	const channel = target.provider?.trim();
	if (!channel) return;
	return {
		channel: channel === "message" && resolvedDelivery.ok && delivery.verifiedTarget ? resolvedDelivery.channel : channel,
		...target.to ? { to: target.to } : {},
		...target.accountId ? { accountId: target.accountId } : {},
		...target.threadId ? { threadId: target.threadId } : {}
	};
}
function buildResolvedCronTraceTarget(resolvedDelivery) {
	if (resolvedDelivery.ok) return {
		ok: true,
		...normalizeCronTraceTarget({
			channel: resolvedDelivery.channel,
			to: resolvedDelivery.to,
			accountId: resolvedDelivery.accountId,
			threadId: resolvedDelivery.threadId,
			source: resolvedDelivery.mode === "implicit" ? "last" : "explicit"
		})
	};
	return {
		ok: false,
		...normalizeCronTraceTarget({
			channel: resolvedDelivery.channel,
			to: resolvedDelivery.to ?? null,
			accountId: resolvedDelivery.accountId,
			threadId: resolvedDelivery.threadId,
			source: resolvedDelivery.mode === "implicit" ? "last" : "explicit"
		}),
		error: resolvedDelivery.error.message
	};
}
function buildCronDeliveryTrace(params) {
	const intended = normalizeCronTraceTarget({
		channel: params.deliveryPlan.channel ?? "last",
		to: params.deliveryPlan.to ?? null,
		accountId: params.deliveryPlan.accountId,
		threadId: params.deliveryPlan.threadId,
		source: params.deliveryPlan.channel === "last" || !params.deliveryPlan.channel ? "last" : "explicit"
	});
	const resolved = params.deliveryPlan.mode !== "none" || hasExplicitCronDeliveryTarget(params.deliveryPlan) ? buildResolvedCronTraceTarget(params.resolvedDelivery) : void 0;
	const messageToolSentTo = params.sourceDeliveryOutcome.visibleDeliveries.map((delivery) => normalizeMessagingToolTarget(delivery, params.resolvedDelivery)).filter((target) => Boolean(target));
	return {
		...intended ? { intended } : {},
		...resolved ? { resolved } : {},
		...messageToolSentTo.length > 0 ? { messageToolSentTo } : {},
		fallbackUsed: params.fallbackUsed,
		delivered: params.delivered
	};
}
function resolveCronSourceDeliveryPlan(params) {
	const target = {
		channel: params.resolvedDelivery.channel,
		to: params.resolvedDelivery.to,
		accountId: params.resolvedDelivery.accountId,
		threadId: params.resolvedDelivery.threadId
	};
	if (params.deliveryPlan.mode === "webhook") return createSourceDeliveryPlan({
		owner: "none",
		reason: "cron_webhook",
		messageToolEnabled: false,
		directFallback: false
	});
	if (params.deliveryPlan.mode === "none") return createSourceDeliveryPlan({
		owner: "none",
		reason: "cron_none",
		target,
		messageToolEnabled: true,
		messageToolForced: true,
		directFallback: false
	});
	return createSourceDeliveryPlan({
		owner: params.resolvedDelivery.ok ? "message_tool_then_direct_fallback" : "direct_fallback",
		reason: "cron_announce",
		target,
		messageToolEnabled: true,
		messageToolForced: true,
		directFallback: true,
		skipFallbackWhenMessageToolSentToTarget: params.resolvedDelivery.ok
	});
}
function canPromptForMessageTool(params) {
	if (!params.sourceDelivery.messageTool.enabled) return false;
	return !params.toolsAllow?.length || params.toolsAllow.includes("message");
}
function hasExplicitCronDeliveryTarget(plan) {
	return Boolean(plan.channel && plan.channel !== "last" || plan.to || plan.threadId || plan.accountId);
}
async function resolveCronDeliveryContext(params) {
	const deliveryPlan = resolveCronDeliveryPlan(params.job);
	if (deliveryPlan.mode === "webhook") {
		const resolvedDelivery = {
			ok: false,
			channel: void 0,
			to: void 0,
			accountId: void 0,
			threadId: void 0,
			mode: "implicit",
			error: /* @__PURE__ */ new Error("webhook delivery has no chat target")
		};
		return {
			deliveryPlan,
			deliveryRequested: deliveryPlan.requested,
			resolvedDelivery,
			sourceDelivery: resolveCronSourceDeliveryPlan({
				deliveryPlan,
				resolvedDelivery
			})
		};
	}
	if (deliveryPlan.mode === "none" && !hasExplicitCronDeliveryTarget(deliveryPlan)) {
		const resolvedDelivery = {
			ok: false,
			channel: void 0,
			to: void 0,
			accountId: void 0,
			threadId: void 0,
			mode: "implicit",
			error: /* @__PURE__ */ new Error("delivery is disabled")
		};
		return {
			deliveryPlan,
			deliveryRequested: false,
			resolvedDelivery,
			sourceDelivery: resolveCronSourceDeliveryPlan({
				deliveryPlan,
				resolvedDelivery
			})
		};
	}
	const { resolveDeliveryTarget } = await loadCronDeliveryRuntime();
	const resolvedDelivery = await resolveDeliveryTarget(params.cfg, params.agentId, {
		channel: deliveryPlan.channel ?? "last",
		to: deliveryPlan.to,
		threadId: deliveryPlan.threadId,
		accountId: deliveryPlan.accountId,
		sessionKey: params.job.sessionKey
	});
	return {
		deliveryPlan,
		deliveryRequested: deliveryPlan.requested,
		resolvedDelivery,
		sourceDelivery: resolveCronSourceDeliveryPlan({
			deliveryPlan,
			resolvedDelivery
		})
	};
}
function appendCronDeliveryInstruction(params) {
	if (!params.deliveryRequested) return params.commandBody;
	if (params.messageToolEnabled) {
		const targetHint = params.resolvedDeliveryOk ? "for the current chat" : "with an explicit target";
		return `${params.commandBody}\n\nUse the message tool if you need to notify the user directly ${targetHint}. If you do not send directly, your final plain-text reply will be delivered automatically.`.trim();
	}
	return `${params.commandBody}\n\nReturn your response as plain text; it will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`.trim();
}
function resolvePositiveContextTokens(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
async function loadCliRunnerRuntime() {
	return await import("./cli-runner.runtime-DJ58zdzi.js");
}
async function loadUsageFormatRuntime() {
	return await import("./usage-format-DOZpqb2o.js");
}
async function prepareCronRunContext(params) {
	const { input } = params;
	const defaultAgentId = resolveDefaultAgentId(input.cfg);
	const requestedAgentId = typeof input.agentId === "string" && input.agentId.trim() ? input.agentId : typeof input.job.agentId === "string" && input.job.agentId.trim() ? input.job.agentId : void 0;
	const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : void 0;
	const agentConfigOverride = normalizedRequested ? resolveAgentConfig(input.cfg, normalizedRequested) : void 0;
	const agentId = normalizedRequested ?? defaultAgentId;
	const agentCfg = buildCronAgentDefaultsConfig({
		defaults: input.cfg.agents?.defaults,
		agentConfigOverride
	});
	const cfgWithAgentDefaults = {
		...input.cfg,
		agents: Object.assign({}, input.cfg.agents, { defaults: agentCfg })
	};
	let catalog;
	const loadCatalog = async () => {
		if (!catalog) catalog = await (await loadCronModelCatalogRuntime()).loadModelCatalog({ config: cfgWithAgentDefaults });
		return catalog;
	};
	const baseSessionKey = (input.sessionKey?.trim() || `cron:${input.job.id}`).trim();
	const agentSessionKey = resolveCronAgentSessionKey({
		sessionKey: baseSessionKey,
		agentId,
		mainKey: input.cfg.session?.mainKey,
		cfg: input.cfg
	});
	const hookExternalContentSource = (input.job.payload.kind === "agentTurn" ? input.job.payload.externalContentSource : void 0) ?? resolveHookExternalContentSource(baseSessionKey);
	const workspaceDirRaw = resolveAgentWorkspaceDir(input.cfg, agentId);
	const agentDir = resolveAgentDir(input.cfg, agentId);
	const workspaceDir = (await ensureAgentWorkspace({
		dir: workspaceDirRaw,
		ensureBootstrapFiles: !agentCfg?.skipBootstrap && !params.isFastTestEnv,
		skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles
	})).dir;
	const { ensureRuntimePluginsLoaded } = await loadRuntimePlugins();
	ensureRuntimePluginsLoaded({
		config: cfgWithAgentDefaults,
		workspaceDir,
		allowGatewaySubagentBinding: true
	});
	const isGmailHook = hookExternalContentSource === "gmail";
	const now = Date.now();
	const cronSession = resolveCronSession({
		cfg: input.cfg,
		sessionKey: agentSessionKey,
		agentId,
		nowMs: now,
		forceNew: input.job.sessionTarget === "isolated"
	});
	const runSessionId = cronSession.sessionEntry.sessionId;
	const currentRunSessionId = () => cronSession.sessionEntry.sessionId ?? runSessionId;
	if (!cronSession.sessionEntry.sessionFile?.trim()) cronSession.sessionEntry.sessionFile = resolveSessionTranscriptPath(runSessionId, agentId);
	const runSessionKey = baseSessionKey.startsWith("cron:") ? `${agentSessionKey}:run:${runSessionId}` : agentSessionKey;
	const persistSessionEntry = createPersistCronSessionEntry({
		isFastTestEnv: params.isFastTestEnv,
		cronSession,
		agentSessionKey,
		updateSessionStore: async (storePath, update) => {
			const { updateSessionStore } = await loadSessionStoreRuntime();
			await updateSessionStore(storePath, update);
		}
	});
	const withRunSession = (result) => ({
		...result,
		sessionId: currentRunSessionId(),
		sessionKey: runSessionKey
	});
	if (!cronSession.sessionEntry.label?.trim() && baseSessionKey.startsWith("cron:")) {
		const labelSuffix = typeof input.job.name === "string" && input.job.name.trim() ? input.job.name.trim() : input.job.id;
		cronSession.sessionEntry.label = `Cron: ${labelSuffix}`;
	}
	const resolvedModelSelection = await resolveCronModelSelection({
		cfg: input.cfg,
		cfgWithAgentDefaults,
		agentConfigOverride,
		sessionEntry: cronSession.sessionEntry,
		payload: input.job.payload,
		isGmailHook,
		agentId
	});
	if (!resolvedModelSelection.ok) return {
		ok: false,
		result: withRunSession({
			status: "error",
			error: resolvedModelSelection.error,
			diagnostics: createCronRunDiagnosticsFromError("cron-preflight", resolvedModelSelection.error)
		})
	};
	let provider = resolvedModelSelection.provider;
	let model = resolvedModelSelection.model;
	const useSubagentFallbacks = resolvedModelSelection.modelSource === "subagent";
	const preflight = await (await loadCronModelPreflightRuntime()).preflightCronModelProvider({
		cfg: cfgWithAgentDefaults,
		provider,
		model
	});
	if (preflight.status === "unavailable") {
		logWarn(`[cron:${input.job.id}] ${preflight.reason}`);
		return {
			ok: false,
			result: withRunSession({
				status: "skipped",
				error: preflight.reason,
				diagnostics: createCronRunDiagnosticsFromError("model-preflight", preflight.reason, { severity: "warn" }),
				provider,
				model
			})
		};
	}
	const hooksGmailThinking = isGmailHook ? normalizeThinkLevel(input.cfg.hooks?.gmail?.thinking) : void 0;
	let thinkLevel = normalizeThinkLevel((input.job.payload.kind === "agentTurn" ? input.job.payload.thinking : void 0) ?? void 0) ?? hooksGmailThinking;
	if (!thinkLevel) thinkLevel = resolveThinkingDefault({
		cfg: cfgWithAgentDefaults,
		provider,
		model,
		catalog: await loadCatalog()
	});
	const thinkingCatalog = await loadCatalog();
	if (!isThinkingLevelSupported({
		provider,
		model,
		level: thinkLevel,
		catalog: thinkingCatalog
	})) {
		const fallbackThinkLevel = resolveSupportedThinkingLevel({
			provider,
			model,
			level: thinkLevel,
			catalog: thinkingCatalog
		});
		if (fallbackThinkLevel !== thinkLevel) {
			logWarn(`[cron:${input.job.id}] Thinking level "${thinkLevel}" is not supported for ${provider}/${model}; downgrading to "${fallbackThinkLevel}".`);
			thinkLevel = fallbackThinkLevel;
		}
	}
	const explicitTimeoutSeconds = input.job.payload.kind === "agentTurn" ? input.job.payload.timeoutSeconds : void 0;
	const timeoutMs = resolveAgentTimeoutMs({
		cfg: cfgWithAgentDefaults,
		overrideSeconds: explicitTimeoutSeconds
	});
	const runTimeoutOverrideMs = typeof explicitTimeoutSeconds === "number" && Number.isFinite(explicitTimeoutSeconds) && explicitTimeoutSeconds > 0 ? explicitTimeoutSeconds * 1e3 : void 0;
	const agentPayload = input.job.payload.kind === "agentTurn" ? input.job.payload : null;
	const { deliveryPlan, deliveryRequested, resolvedDelivery, sourceDelivery } = await resolveCronDeliveryContext({
		cfg: cfgWithAgentDefaults,
		job: input.job,
		agentId
	});
	const { formattedTime, timeLine } = resolveCronStyleNow(input.cfg, now);
	const base = `[cron:${input.job.id} ${input.job.name}] ${input.message}`.trim();
	const isExternalHook = hookExternalContentSource !== void 0 || isExternalHookSession(baseSessionKey);
	const allowUnsafeExternalContent = agentPayload?.allowUnsafeExternalContent === true || isGmailHook && input.cfg.hooks?.gmail?.allowUnsafeExternalContent === true;
	const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
	let commandBody;
	if (isExternalHook) {
		const { detectSuspiciousPatterns } = await loadCronExternalContentRuntime();
		const suspiciousPatterns = detectSuspiciousPatterns(input.message);
		if (suspiciousPatterns.length > 0) logWarn(`[security] Suspicious patterns detected in external hook content (session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`);
	}
	if (shouldWrapExternal) {
		const { buildSafeExternalPrompt } = await loadCronExternalContentRuntime();
		const hookType = mapHookExternalContentSource(hookExternalContentSource ?? "webhook");
		commandBody = `${buildSafeExternalPrompt({
			content: input.message,
			source: hookType,
			jobName: input.job.name,
			jobId: input.job.id,
			timestamp: formattedTime
		})}\n\n${timeLine}`.trim();
	} else commandBody = `${base}\n${timeLine}`.trim();
	commandBody = appendCronDeliveryInstruction({
		commandBody,
		deliveryRequested,
		messageToolEnabled: canPromptForMessageTool({
			sourceDelivery,
			toolsAllow: agentPayload?.toolsAllow
		}),
		resolvedDeliveryOk: resolvedDelivery.ok
	});
	const skillsSnapshot = await resolveCronSkillsSnapshot({
		workspaceDir,
		config: cfgWithAgentDefaults,
		agentId,
		existingSnapshot: cronSession.sessionEntry.skillsSnapshot,
		isFastTestEnv: params.isFastTestEnv
	});
	await persistCronSkillsSnapshotIfChanged({
		isFastTestEnv: params.isFastTestEnv,
		cronSession,
		skillsSnapshot,
		nowMs: Date.now(),
		persistSessionEntry
	});
	markCronSessionPreRun({
		entry: cronSession.sessionEntry,
		provider,
		model
	});
	try {
		await persistSessionEntry();
	} catch (err) {
		logWarn(`[cron:${input.job.id}] Failed to persist pre-run session entry: ${String(err)}`);
	}
	await retireRolledCronSessionMcpRuntime({
		job: input.job,
		cronSession
	});
	const authProfileId = !Boolean(cronSession.sessionEntry.authProfileOverride?.trim()) && !hasConfiguredAuthProfiles(cfgWithAgentDefaults) && !hasAnyAuthProfileStoreSource(agentDir) ? void 0 : await (await loadCronAuthProfileRuntime()).resolveSessionAuthProfileOverride({
		cfg: cfgWithAgentDefaults,
		provider,
		acceptedProviderIds: listOpenAIAuthProfileProvidersForAgentRuntime({
			provider,
			harnessRuntime: resolveAgentHarnessPolicy({
				provider,
				modelId: model,
				config: cfgWithAgentDefaults,
				agentId,
				sessionKey: agentSessionKey
			}).runtime,
			config: cfgWithAgentDefaults
		}),
		agentDir,
		sessionEntry: cronSession.sessionEntry,
		sessionStore: cronSession.store,
		sessionKey: agentSessionKey,
		storePath: cronSession.storePath,
		isNewSession: cronSession.isNewSession && input.job.sessionTarget !== "isolated"
	});
	const liveSelection = {
		provider,
		model,
		authProfileId,
		authProfileIdSource: authProfileId ? cronSession.sessionEntry.authProfileOverrideSource : void 0
	};
	return {
		ok: true,
		context: {
			input,
			cfgWithAgentDefaults,
			agentId,
			agentCfg,
			agentDir,
			agentSessionKey,
			runSessionId,
			currentRunSessionId,
			runSessionKey,
			workspaceDir,
			commandBody,
			cronSession,
			persistSessionEntry,
			withRunSession,
			agentPayload,
			deliveryPlan,
			resolvedDelivery,
			deliveryRequested,
			sourceDelivery,
			suppressExecNotifyOnExit: deliveryPlan.mode === "none",
			skillsSnapshot,
			liveSelection,
			useSubagentFallbacks,
			thinkLevel,
			timeoutMs,
			runTimeoutOverrideMs
		}
	};
}
async function finalizeCronRun(params) {
	const { prepared, execution } = params;
	const finalRunResult = execution.runResult;
	const payloads = finalRunResult.payloads ?? [];
	let telemetry;
	if (finalRunResult.meta?.systemPromptReport) prepared.cronSession.sessionEntry.systemPromptReport = finalRunResult.meta.systemPromptReport;
	adoptCronRunSessionMetadata({
		entry: prepared.cronSession.sessionEntry,
		sessionKey: prepared.agentSessionKey,
		runMeta: finalRunResult.meta?.agentMeta
	});
	const usage = finalRunResult.meta?.agentMeta?.usage;
	const promptTokens = finalRunResult.meta?.agentMeta?.promptTokens;
	const modelUsed = finalRunResult.meta?.agentMeta?.model ?? execution.fallbackModel ?? execution.liveSelection.model;
	const providerUsed = finalRunResult.meta?.agentMeta?.provider ?? execution.fallbackProvider ?? execution.liveSelection.provider;
	const contextTokens = resolvePositiveContextTokens(prepared.agentCfg?.contextTokens) ?? (await loadCronContextRuntime()).lookupContextTokens(modelUsed, { allowAsyncLoad: false }) ?? resolvePositiveContextTokens(prepared.cronSession.sessionEntry.contextTokens) ?? 2e5;
	setSessionRuntimeModel(prepared.cronSession.sessionEntry, {
		provider: providerUsed,
		model: modelUsed
	});
	prepared.cronSession.sessionEntry.contextTokens = contextTokens;
	if (isCliProvider(providerUsed, prepared.cfgWithAgentDefaults)) {
		const cliSessionId = finalRunResult.meta?.agentMeta?.sessionId?.trim();
		if (cliSessionId) {
			const { setCliSessionId } = await loadCliRunnerRuntime();
			setCliSessionId(prepared.cronSession.sessionEntry, providerUsed, cliSessionId);
		}
	}
	if (hasNonzeroUsage(usage)) {
		const { estimateUsageCost, resolveModelCostConfig } = await loadUsageFormatRuntime();
		const input = usage.input ?? 0;
		const output = usage.output ?? 0;
		const totalTokens = deriveSessionTotalTokens({
			usage,
			contextTokens,
			promptTokens
		});
		const runEstimatedCostUsd = resolveNonNegativeNumber(estimateUsageCost({
			usage,
			cost: resolveModelCostConfig({
				provider: providerUsed,
				model: modelUsed,
				config: prepared.cfgWithAgentDefaults
			})
		}));
		prepared.cronSession.sessionEntry.inputTokens = input;
		prepared.cronSession.sessionEntry.outputTokens = output;
		const telemetryUsage = {
			input_tokens: input,
			output_tokens: output
		};
		if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
			prepared.cronSession.sessionEntry.totalTokens = totalTokens;
			prepared.cronSession.sessionEntry.totalTokensFresh = true;
			telemetryUsage.total_tokens = totalTokens;
		} else {
			prepared.cronSession.sessionEntry.totalTokens = void 0;
			prepared.cronSession.sessionEntry.totalTokensFresh = false;
		}
		prepared.cronSession.sessionEntry.cacheRead = usage.cacheRead ?? 0;
		prepared.cronSession.sessionEntry.cacheWrite = usage.cacheWrite ?? 0;
		if (runEstimatedCostUsd !== void 0) prepared.cronSession.sessionEntry.estimatedCostUsd = runEstimatedCostUsd;
		telemetry = {
			model: modelUsed,
			provider: providerUsed,
			usage: telemetryUsage
		};
	} else telemetry = {
		model: modelUsed,
		provider: providerUsed
	};
	await prepared.persistSessionEntry();
	if (params.isAborted()) return prepared.withRunSession({
		status: "error",
		error: params.abortReason(),
		diagnostics: mergeCronRunDiagnostics(createCronRunDiagnosticsFromAgentResult(finalRunResult, { finalStatus: "error" }), createCronRunDiagnosticsFromError("cron-setup", params.abortReason())),
		...telemetry
	});
	let { summary, outputText, synthesizedText, deliveryPayloads, deliveryPayloadHasStructuredContent, hasFatalErrorPayload, hasFatalStructuredErrorPayload, embeddedRunError, pendingPresentationWarningError } = resolveCronPayloadOutcome({
		payloads,
		runLevelError: finalRunResult.meta?.error,
		failureSignal: finalRunResult.meta?.failureSignal,
		finalAssistantVisibleText: finalRunResult.meta?.finalAssistantVisibleText,
		preferFinalAssistantVisibleText: (await resolveCronChannelOutputPolicy(prepared.resolvedDelivery.channel)).preferFinalAssistantVisibleText
	});
	const agentDiagnostics = createCronRunDiagnosticsFromAgentResult(finalRunResult, { finalStatus: hasFatalErrorPayload ? "error" : "ok" });
	const resolveRunOutcome = (result) => prepared.withRunSession({
		status: hasFatalErrorPayload ? "error" : "ok",
		...hasFatalErrorPayload ? { error: embeddedRunError ?? "cron isolated run returned an error payload" } : {},
		summary,
		outputText,
		delivered: result?.delivered,
		deliveryAttempted: result?.deliveryAttempted,
		delivery: result?.delivery,
		diagnostics: hasFatalErrorPayload ? mergeCronRunDiagnostics(agentDiagnostics, createCronRunDiagnosticsFromError("agent-run", embeddedRunError ?? "cron isolated run returned an error payload")) : agentDiagnostics,
		...telemetry
	});
	const failPendingPresentationWarningUnlessDelivered = (delivered) => {
		if (pendingPresentationWarningError && delivered !== true) {
			hasFatalErrorPayload = true;
			embeddedRunError = pendingPresentationWarningError;
		}
	};
	const skipHeartbeatDelivery = prepared.deliveryRequested && !hasFatalErrorPayload && isHeartbeatOnlyResponse(deliveryPayloads, resolveHeartbeatAckMaxChars(prepared.agentCfg));
	const sourceDeliveryOutcome = resolveSourceDeliveryOutcome(prepared.sourceDelivery, {
		didSendViaMessageTool: finalRunResult.didSendViaMessagingTool,
		messageToolSentTargets: finalRunResult.messagingToolSentTargets
	});
	if (hasFatalStructuredErrorPayload && prepared.deliveryRequested) {
		const { cleanupDirectCronSession } = await loadCronDeliveryRuntime();
		await cleanupDirectCronSession({
			job: prepared.input.job,
			agentSessionKey: prepared.agentSessionKey,
			sessionId: prepared.currentRunSessionId(),
			retireReason: "cron-delete-after-run-fatal-error"
		});
		const deliveryTrace = buildCronDeliveryTrace({
			deliveryPlan: prepared.deliveryPlan,
			resolvedDelivery: prepared.resolvedDelivery,
			sourceDeliveryOutcome,
			fallbackUsed: false,
			delivered: sourceDeliveryOutcome.verifiedMessageToolDelivery
		});
		return resolveRunOutcome({
			delivered: sourceDeliveryOutcome.verifiedMessageToolDelivery,
			deliveryAttempted: sourceDeliveryOutcome.verifiedMessageToolDelivery,
			delivery: deliveryTrace
		});
	}
	const { dispatchCronDelivery, resolveCronDeliveryBestEffort } = await loadCronDeliveryRuntime();
	const deliveryResult = await dispatchCronDelivery({
		cfg: prepared.input.cfg,
		cfgWithAgentDefaults: prepared.cfgWithAgentDefaults,
		deps: prepared.input.deps,
		job: prepared.input.job,
		agentId: prepared.agentId,
		agentSessionKey: prepared.agentSessionKey,
		runSessionKey: prepared.runSessionKey,
		sessionId: prepared.currentRunSessionId(),
		runStartedAt: execution.runStartedAt,
		runEndedAt: execution.runEndedAt,
		timeoutMs: prepared.timeoutMs,
		resolvedDelivery: prepared.resolvedDelivery,
		deliveryRequested: prepared.deliveryRequested,
		skipHeartbeatDelivery,
		sourceDeliveryOutcome,
		deliveryBestEffort: resolveCronDeliveryBestEffort(prepared.input.job),
		deliveryPayloadHasStructuredContent,
		deliveryPayloads,
		synthesizedText,
		ttsAuto: prepared.cronSession.sessionEntry.ttsAuto,
		summary,
		outputText,
		telemetry,
		abortSignal: prepared.input.abortSignal ?? prepared.input.signal,
		isAborted: params.isAborted,
		abortReason: params.abortReason,
		withRunSession: prepared.withRunSession
	});
	const deliveryTrace = buildCronDeliveryTrace({
		deliveryPlan: prepared.deliveryPlan,
		resolvedDelivery: prepared.resolvedDelivery,
		sourceDeliveryOutcome,
		fallbackUsed: prepared.deliveryRequested && deliveryResult.deliveryAttempted && !sourceDeliveryOutcome.satisfiesSourceDelivery,
		delivered: deliveryResult.delivered
	});
	if (deliveryResult.result) {
		const resultWithDeliveryMeta = {
			...deliveryResult.result,
			deliveryAttempted: deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
			delivery: deliveryTrace,
			diagnostics: mergeCronRunDiagnostics(agentDiagnostics, deliveryResult.result.diagnostics, deliveryResult.result.status === "error" && deliveryResult.result.error ? createCronRunDiagnosticsFromError("delivery", deliveryResult.result.error) : void 0)
		};
		failPendingPresentationWarningUnlessDelivered(resultWithDeliveryMeta.delivered ?? deliveryResult.delivered);
		if (!hasFatalErrorPayload || deliveryResult.result.status !== "ok") return resultWithDeliveryMeta;
		return resolveRunOutcome({
			delivered: deliveryResult.result.delivered,
			deliveryAttempted: resultWithDeliveryMeta.deliveryAttempted,
			delivery: deliveryTrace
		});
	}
	summary = deliveryResult.summary;
	outputText = deliveryResult.outputText;
	failPendingPresentationWarningUnlessDelivered(deliveryResult.delivered);
	return resolveRunOutcome({
		delivered: deliveryResult.delivered,
		deliveryAttempted: deliveryResult.deliveryAttempted,
		delivery: deliveryTrace
	});
}
/**
* Release runtime references held by a completed isolated cron run.
*
* After the final durable write and delivery complete, the cron session store
* and run context are no longer needed in memory.  This shallow disposal prevents
* the heap-retention pattern described in #85019 where ~113k copies of the skill
* prompt string accumulated through cron run contexts that were never released.
*
* O(1) — nulls known large fields without deep traversal.  MUST run after the
* final `persistSessionEntry()` and delivery construction, never before.
*/
function disposeCronRunContext(params) {
	if (params.ownsRunContext) clearAgentRunContext(params.sessionId);
	params.cronSession.store = void 0;
}
async function runCronIsolatedAgentTurn(params) {
	const abortSignal = params.abortSignal ?? params.signal;
	const isAborted = () => abortSignal?.aborted === true;
	const abortReason = () => {
		const reason = abortSignal?.reason;
		return typeof reason === "string" && reason.trim() ? reason.trim() : "cron: job execution timed out";
	};
	const prepared = await prepareCronRunContext({
		input: params,
		isFastTestEnv: process.env.OPENCLAW_TEST_FAST === "1"
	});
	if (!prepared.ok) return prepared.result;
	const notifyExecutionStarted = () => params.onExecutionStarted?.({
		jobId: params.job.id,
		agentId: prepared.context.agentId,
		sessionId: prepared.context.currentRunSessionId(),
		sessionKey: prepared.context.runSessionKey,
		phase: "runner_entered",
		provider: prepared.context.liveSelection.provider,
		model: prepared.context.liveSelection.model
	});
	const notifyExecutionPhase = (info) => {
		params.onExecutionPhase?.({
			jobId: params.job.id,
			agentId: prepared.context.agentId,
			sessionId: prepared.context.currentRunSessionId(),
			sessionKey: prepared.context.runSessionKey,
			provider: prepared.context.liveSelection.provider,
			model: prepared.context.liveSelection.model,
			...info
		});
	};
	const initialSessionId = prepared.context.cronSession.sessionEntry.sessionId;
	try {
		const { executeCronRun } = await loadCronExecutorRuntime();
		const execution = await executeCronRun({
			cfg: params.cfg,
			cfgWithAgentDefaults: prepared.context.cfgWithAgentDefaults,
			job: params.job,
			agentId: prepared.context.agentId,
			agentDir: prepared.context.agentDir,
			agentSessionKey: prepared.context.agentSessionKey,
			runSessionKey: prepared.context.runSessionKey,
			workspaceDir: prepared.context.workspaceDir,
			lane: params.lane,
			resolvedDelivery: {
				channel: prepared.context.resolvedDelivery.channel,
				to: prepared.context.resolvedDelivery.to,
				accountId: prepared.context.resolvedDelivery.accountId,
				threadId: prepared.context.resolvedDelivery.threadId
			},
			sourceDelivery: prepared.context.sourceDelivery,
			skillsSnapshot: prepared.context.skillsSnapshot,
			agentPayload: prepared.context.agentPayload,
			useSubagentFallbacks: prepared.context.useSubagentFallbacks,
			agentVerboseDefault: prepared.context.agentCfg?.verboseDefault,
			liveSelection: prepared.context.liveSelection,
			cronSession: prepared.context.cronSession,
			commandBody: prepared.context.commandBody,
			persistSessionEntry: prepared.context.persistSessionEntry,
			abortSignal,
			onExecutionStarted: notifyExecutionStarted,
			onExecutionPhase: notifyExecutionPhase,
			abortReason,
			isAborted,
			thinkLevel: prepared.context.thinkLevel,
			timeoutMs: prepared.context.timeoutMs,
			runTimeoutOverrideMs: prepared.context.runTimeoutOverrideMs,
			suppressExecNotifyOnExit: prepared.context.suppressExecNotifyOnExit
		});
		if (isAborted()) return prepared.context.withRunSession({
			status: "error",
			error: abortReason(),
			diagnostics: createCronRunDiagnosticsFromError("cron-setup", abortReason())
		});
		return await finalizeCronRun({
			prepared: prepared.context,
			execution,
			abortReason,
			isAborted
		});
	} catch (err) {
		const isCronLaneTimeout = isAborted() || isCronNestedLaneTaskTimeoutError(err);
		const error = isCronLaneTimeout ? abortReason() : String(err);
		return prepared.context.withRunSession({
			status: "error",
			error,
			diagnostics: createCronRunDiagnosticsFromError(isCronLaneTimeout ? "cron-setup" : "agent-run", isCronLaneTimeout ? error : err)
		});
	} finally {
		disposeCronRunContext({
			sessionId: initialSessionId,
			cronSession: prepared.context.cronSession,
			ownsRunContext: params.job.sessionTarget === "isolated"
		});
	}
}
//#endregion
export { runCronIsolatedAgentTurn as t };
