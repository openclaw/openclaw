import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as sanitizeForLog } from "./ansi-Bk0Jp_0O.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { c as isSecretRef } from "./types.secrets-BxqheYvy.js";
import { a as isSubagentSessionKey } from "./session-key-utils-qD-NZHCY.js";
import { c as normalizeAgentId, u as resolveAgentIdFromSessionKey } from "./session-key-DFEyR49L.js";
import { a as resolveAgentDir, n as listAgentIds, o as resolveAgentWorkspaceDir } from "./agent-scope-config-26EcJVc0.js";
import { l as resolveAgentSkillsFilter, p as resolveSessionAgentId, u as resolveEffectiveModelFallbacks } from "./agent-scope-C1Fl7gAf.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { d as readConfigFileSnapshotForWrite, i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-BGwElg4C.js";
import { g as normalizeVerboseLevel, n as isThinkingLevelSupported, o as resolveSupportedThinkingLevel, p as normalizeThinkLevel, t as formatThinkingLevels } from "./thinking-ix_990qw.js";
import { _ as setRuntimeConfigSnapshot } from "./runtime-snapshot-tLK3Mx7y.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-3NFJcokO.js";
import { f as resolveMessageChannel } from "./message-channel-s-A-ruKR.js";
import { n as ensureAuthProfileStore } from "./store-a4exFSck.js";
import { i as listOpenAIAuthProfileProvidersForAgentRuntime } from "./openai-codex-routing-kS7Ub1vB.js";
import { t as resolveAgentHarnessPolicy } from "./policy-AKMwD9k5.js";
import { i as emitAgentEvent, t as clearAgentRunContext, u as registerAgentRunContext } from "./agent-events-CXxjiM_O.js";
import { h as stringifyRouteThreadId } from "./channel-route-jaZFObQA.js";
import { o as normalizeAccountId } from "./delivery-context.shared-Dk7-07JJ.js";
import { _ as resolveConfiguredModelRef, r as buildConfiguredModelCatalog } from "./model-selection-shared-Dh1KrVmr.js";
import { i as parseModelRef, n as modelKey, r as normalizeModelRef } from "./model-selection-normalize-B4tdZ1L4.js";
import { m as resolveThinkingDefault, s as resolveDefaultModelForAgent } from "./model-selection-VRXWv5rs.js";
import { n as loadManifestModelCatalog } from "./model-catalog-Bej-qOX2.js";
import { t as resolveAgentTimeoutMs } from "./timeout-B90p_5rC.js";
import { w as createTrajectoryRuntimeRecorder } from "./selection-61FIEezO.js";
import { l as ensureAgentWorkspace } from "./workspace-BNTZ_9-b.js";
import { r as runWithModelFallback, s as resolveSession, u as LiveSessionModelSwitchError } from "./model-fallback-CFP2h22a.js";
import { r as normalizeSpawnedRunMetadata } from "./spawn-requester-origin-0ARboxa_.js";
import { t as getAgentRuntimeCommandSecretTargetIds } from "./command-secret-targets-DHIk2CaO.js";
import { t as buildOutboundSessionContext } from "./session-context-CUlUeE66.js";
import { n as repairProviderWrappedModelOverride, t as applyModelOverrideToSessionEntry } from "./model-overrides-BZTQYrDg.js";
import { t as createModelVisibilityPolicy } from "./model-visibility-policy-H_5vLqqk.js";
import { t as AGENT_LANE_SUBAGENT } from "./lanes-B7XP14wc.js";
import { n as resolveSendPolicy } from "./send-policy-CXgyJWYr.js";
import { r as ensureSelectedAgentHarnessPlugin } from "./live-model-switch-CgybHLBX.js";
import { t as classifyEmbeddedPiRunResultForModelFallback } from "./result-fallback-classifier-CxOwFLYE.js";
import { t as resolveFastModeState } from "./fast-mode-Dp7dTDjI.js";
import { t as clearSessionAuthProfileOverride } from "./session-override-BdKkz8by.js";
import { n as applyVerboseOverride } from "./level-overrides-BRv950_B.js";
import { i as resolveInternalEventTranscriptBody, n as prependInternalEventContext, r as resolveAcpPromptBody, t as persistSessionEntry$1 } from "./attempt-execution.shared-LCPsluai.js";
import { n as hydrateResolvedSkillsAsync } from "./snapshot-hydration-cKF9lnUH.js";
//#region src/agents/agent-runtime-config.ts
async function resolveAgentRuntimeConfig(runtime, params) {
	const loadedRaw = getRuntimeConfig();
	const sourceConfig = await (async () => {
		try {
			const { snapshot } = await readConfigFileSnapshotForWrite();
			if (snapshot.valid) return snapshot.resolved;
		} catch {}
		return loadedRaw;
	})();
	const includeChannelTargets = params?.runtimeTargetsChannelSecrets === true;
	const cfg = hasAgentRuntimeSecretRefs({
		config: loadedRaw,
		includeChannelTargets
	}) ? (await (await import("./command-config-resolution.runtime.js")).resolveCommandConfigWithSecrets({
		config: loadedRaw,
		commandName: "agent",
		targetIds: getAgentRuntimeCommandSecretTargetIds({ includeChannelTargets }),
		runtime
	})).resolvedConfig : loadedRaw;
	setRuntimeConfigSnapshot(cfg, sourceConfig);
	return {
		loadedRaw,
		sourceConfig,
		cfg
	};
}
function hasNestedSecretRef(value) {
	if (isSecretRef(value)) return true;
	if (Array.isArray(value)) return value.some((entry) => hasNestedSecretRef(entry));
	if (!value || typeof value !== "object") return false;
	return Object.values(value).some((entry) => hasNestedSecretRef(entry));
}
function hasAgentRuntimeSecretRefs(params) {
	const { config } = params;
	if (hasNestedSecretRef(config.models?.providers)) return true;
	if (hasNestedSecretRef(config.agents?.defaults?.memorySearch?.remote?.apiKey)) return true;
	if (Array.isArray(config.agents?.list) && config.agents.list.some((agent) => hasNestedSecretRef(agent?.memorySearch?.remote?.apiKey))) return true;
	if (hasNestedSecretRef(config.messages?.tts?.providers)) return true;
	if (hasNestedSecretRef(config.skills?.entries)) return true;
	if (hasNestedSecretRef(config.tools?.web?.search)) return true;
	if (config.plugins?.entries && Object.values(config.plugins.entries).some((entry) => hasNestedSecretRef({
		webSearch: entry?.config?.webSearch,
		webFetch: entry?.config?.webFetch
	}))) return true;
	return params.includeChannelTargets ? hasNestedSecretRef(config.channels) : false;
}
//#endregion
//#region src/agents/command/run-context.ts
function resolveAgentRunContext(opts) {
	const merged = opts.runContext ? { ...opts.runContext } : {};
	const normalizedChannel = resolveMessageChannel(merged.messageChannel ?? opts.messageChannel, opts.replyChannel ?? opts.channel);
	if (normalizedChannel) merged.messageChannel = normalizedChannel;
	const normalizedAccountId = normalizeAccountId(merged.accountId ?? opts.accountId);
	if (normalizedAccountId) merged.accountId = normalizedAccountId;
	const groupId = (merged.groupId ?? opts.groupId)?.toString().trim();
	if (groupId) merged.groupId = groupId;
	const groupChannel = (merged.groupChannel ?? opts.groupChannel)?.toString().trim();
	if (groupChannel) merged.groupChannel = groupChannel;
	const groupSpace = (merged.groupSpace ?? opts.groupSpace)?.toString().trim();
	if (groupSpace) merged.groupSpace = groupSpace;
	if (merged.currentThreadTs == null && opts.threadId != null && opts.threadId !== "" && opts.threadId !== null) {
		const threadId = stringifyRouteThreadId(opts.threadId);
		if (threadId) merged.currentThreadTs = threadId;
	}
	if (!merged.currentChannelId && opts.to) {
		const trimmedTo = opts.to.trim();
		if (trimmedTo) merged.currentChannelId = trimmedTo;
	}
	return merged;
}
//#endregion
//#region src/agents/agent-command.ts
const log = createSubsystemLogger("agents/agent-command");
const attemptExecutionRuntimeLoader = createLazyImportLoader(() => import("./attempt-execution.runtime.js"));
const acpManagerRuntimeLoader = createLazyImportLoader(() => import("./acp/control-plane/manager.js"));
const acpPolicyRuntimeLoader = createLazyImportLoader(() => import("./policy-CNTeeink.js"));
const acpRuntimeErrorsRuntimeLoader = createLazyImportLoader(() => import("./errors-qazTiRGe.js"));
const acpSessionIdentifiersRuntimeLoader = createLazyImportLoader(() => import("./session-identifiers-B33HErIU.js"));
const deliveryRuntimeLoader = createLazyImportLoader(() => import("./delivery.runtime.js"));
const sessionStoreRuntimeLoader = createLazyImportLoader(() => import("./session-store.runtime.js"));
const cliCompactionRuntimeLoader = createLazyImportLoader(() => import("./cli-compaction-Cs2hAcPz.js"));
const transcriptResolveRuntimeLoader = createLazyImportLoader(() => import("./transcript-resolve.runtime.js"));
const cliDepsRuntimeLoader = createLazyImportLoader(() => import("./deps-ybi3uQGM.js"));
const execDefaultsRuntimeLoader = createLazyImportLoader(() => import("./exec-defaults-DNs-OBLk.js"));
const skillsRuntimeLoader = createLazyImportLoader(() => import("./skills-VuJ8H5Qy.js"));
const skillsFilterRuntimeLoader = createLazyImportLoader(() => import("./filter-C0PbDor_.js"));
const skillsRefreshStateRuntimeLoader = createLazyImportLoader(() => import("./refresh-state-DzguSa0y.js"));
const skillsRemoteRuntimeLoader = createLazyImportLoader(() => import("./skills-remote-B8JtHP4x.js"));
function loadAttemptExecutionRuntime() {
	return attemptExecutionRuntimeLoader.load();
}
function loadAcpManagerRuntime() {
	return acpManagerRuntimeLoader.load();
}
function loadAcpPolicyRuntime() {
	return acpPolicyRuntimeLoader.load();
}
function loadAcpRuntimeErrorsRuntime() {
	return acpRuntimeErrorsRuntimeLoader.load();
}
function loadAcpSessionIdentifiersRuntime() {
	return acpSessionIdentifiersRuntimeLoader.load();
}
function loadDeliveryRuntime() {
	return deliveryRuntimeLoader.load();
}
function loadSessionStoreRuntime() {
	return sessionStoreRuntimeLoader.load();
}
function loadCliCompactionRuntime() {
	return cliCompactionRuntimeLoader.load();
}
function loadTranscriptResolveRuntime() {
	return transcriptResolveRuntimeLoader.load();
}
function loadCliDepsRuntime() {
	return cliDepsRuntimeLoader.load();
}
function loadExecDefaultsRuntime() {
	return execDefaultsRuntimeLoader.load();
}
function loadSkillsRuntime() {
	return skillsRuntimeLoader.load();
}
function loadSkillsFilterRuntime() {
	return skillsFilterRuntimeLoader.load();
}
function loadSkillsRefreshStateRuntime() {
	return skillsRefreshStateRuntimeLoader.load();
}
function loadSkillsRemoteRuntime() {
	return skillsRemoteRuntimeLoader.load();
}
async function resolveAgentCommandDeps(deps) {
	if (deps) return deps;
	const { createDefaultDeps } = await loadCliDepsRuntime();
	return createDefaultDeps();
}
const OVERRIDE_FIELDS_CLEARED_BY_DELETE = [
	"providerOverride",
	"modelOverride",
	"authProfileOverride",
	"authProfileOverrideSource",
	"authProfileOverrideCompactionCount",
	"fallbackNoticeSelectedModel",
	"fallbackNoticeActiveModel",
	"fallbackNoticeReason",
	"claudeCliSessionId"
];
const OVERRIDE_VALUE_MAX_LENGTH = 256;
async function persistSessionEntry(params) {
	await persistSessionEntry$1({
		...params,
		clearedFields: OVERRIDE_FIELDS_CLEARED_BY_DELETE
	});
}
function containsControlCharacters(value) {
	for (const char of value) {
		const code = char.codePointAt(0);
		if (code === void 0) continue;
		if (code <= 31 || code >= 127 && code <= 159) return true;
	}
	return false;
}
function normalizeExplicitOverrideInput(raw, kind) {
	const trimmed = raw.trim();
	const label = kind === "provider" ? "Provider" : "Model";
	if (!trimmed) throw new Error(`${label} override must be non-empty.`);
	if (trimmed.length > OVERRIDE_VALUE_MAX_LENGTH) throw new Error(`${label} override exceeds ${String(OVERRIDE_VALUE_MAX_LENGTH)} characters.`);
	if (containsControlCharacters(trimmed)) throw new Error(`${label} override contains invalid control characters.`);
	return trimmed;
}
async function prepareAgentCommandExecution(opts, runtime) {
	const isRawModelRun = opts.modelRun === true || opts.promptMode === "none";
	const message = opts.message ?? "";
	if (!message.trim()) throw new Error("Message (--message) is required");
	if (!opts.to && !opts.sessionId && !opts.sessionKey && !opts.agentId) throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
	const { cfg } = await resolveAgentRuntimeConfig(runtime, { runtimeTargetsChannelSecrets: opts.deliver === true });
	const normalizedSpawned = normalizeSpawnedRunMetadata({
		spawnedBy: opts.spawnedBy,
		groupId: opts.groupId,
		groupChannel: opts.groupChannel,
		groupSpace: opts.groupSpace,
		workspaceDir: opts.workspaceDir
	});
	const agentIdOverrideRaw = opts.agentId?.trim();
	const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : void 0;
	if (agentIdOverride) {
		if (!listAgentIds(cfg).includes(agentIdOverride)) throw new Error(`Unknown agent id "${agentIdOverrideRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`);
	}
	if (agentIdOverride && opts.sessionKey) {
		const sessionAgentId = resolveAgentIdFromSessionKey(opts.sessionKey);
		if (sessionAgentId !== agentIdOverride) throw new Error(`Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`);
	}
	const agentCfg = cfg.agents?.defaults;
	const configuredModel = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const configuredThinkingCatalog = buildConfiguredModelCatalog({ cfg });
	const thinkingLevelsHint = formatThinkingLevels(configuredModel.provider, configuredModel.model, ", ", configuredThinkingCatalog.length > 0 ? configuredThinkingCatalog : void 0);
	const thinkOverride = normalizeThinkLevel(opts.thinking);
	const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
	if (opts.thinking && !thinkOverride) throw new Error(`Invalid thinking level. Use one of: ${thinkingLevelsHint}.`);
	if (opts.thinkingOnce && !thinkOnce) throw new Error(`Invalid one-shot thinking level. Use one of: ${thinkingLevelsHint}.`);
	const verboseOverride = normalizeVerboseLevel(opts.verbose);
	if (opts.verbose && !verboseOverride) throw new Error("Invalid verbose level. Use \"on\", \"full\", or \"off\".");
	const isSubagentLane = (normalizeOptionalString(opts.lane) ?? "") === AGENT_LANE_SUBAGENT;
	const timeoutSecondsRaw = opts.timeout !== void 0 ? Number.parseInt(opts.timeout, 10) : isSubagentLane ? 0 : void 0;
	if (timeoutSecondsRaw !== void 0 && (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw < 0)) throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
	const timeoutMs = resolveAgentTimeoutMs({
		cfg,
		overrideSeconds: timeoutSecondsRaw
	});
	const { sessionId, sessionKey, sessionEntry: sessionEntryRaw, sessionStore, storePath, isNewSession, persistedThinking, persistedVerbose } = resolveSession({
		cfg,
		to: opts.to,
		sessionId: opts.sessionId,
		sessionKey: opts.sessionKey,
		agentId: agentIdOverride
	});
	const sessionAgentId = agentIdOverride ?? resolveSessionAgentId({
		sessionKey: sessionKey ?? opts.sessionKey?.trim(),
		config: cfg
	});
	const outboundSession = buildOutboundSessionContext({
		cfg,
		agentId: sessionAgentId,
		sessionKey
	});
	const workspaceDirRaw = normalizedSpawned.workspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
	const agentDir = resolveAgentDir(cfg, sessionAgentId);
	const workspaceDir = (await ensureAgentWorkspace({
		dir: workspaceDirRaw,
		ensureBootstrapFiles: !agentCfg?.skipBootstrap,
		skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles
	})).dir;
	const runId = opts.runId?.trim() || sessionId;
	const { getAcpSessionManager } = await loadAcpManagerRuntime();
	const acpManager = getAcpSessionManager();
	const acpResolution = sessionKey ? acpManager.resolveSession({
		cfg,
		sessionKey
	}) : null;
	return {
		body: !isRawModelRun && acpResolution?.kind === "ready" ? resolveAcpPromptBody(message, opts.internalEvents) : prependInternalEventContext(message, opts.internalEvents),
		transcriptBody: opts.transcriptMessage ?? resolveInternalEventTranscriptBody(message, opts.internalEvents),
		cfg,
		configuredThinkingCatalog,
		normalizedSpawned,
		agentCfg,
		thinkOverride,
		thinkOnce,
		verboseOverride,
		timeoutMs,
		sessionId,
		sessionKey,
		sessionEntry: sessionEntryRaw,
		sessionStore,
		storePath,
		isNewSession,
		persistedThinking,
		persistedVerbose,
		sessionAgentId,
		outboundSession,
		workspaceDir,
		agentDir,
		runId,
		acpManager,
		acpResolution
	};
}
async function agentCommandInternal(opts, runtime = defaultRuntime, deps) {
	const resolvedDeps = await resolveAgentCommandDeps(deps);
	const isRawModelRun = opts.modelRun === true || opts.promptMode === "none";
	const prepared = await prepareAgentCommandExecution(opts, runtime);
	const { body, transcriptBody, cfg, configuredThinkingCatalog, normalizedSpawned, agentCfg, thinkOverride, thinkOnce, verboseOverride, timeoutMs, sessionId, sessionKey, sessionStore, storePath, isNewSession, persistedThinking, persistedVerbose, sessionAgentId, outboundSession, workspaceDir, agentDir, runId, acpManager, acpResolution } = prepared;
	let sessionEntry = prepared.sessionEntry;
	try {
		if (opts.deliver === true) {
			if (resolveSendPolicy({
				cfg,
				entry: sessionEntry,
				sessionKey,
				channel: sessionEntry?.channel,
				chatType: sessionEntry?.chatType
			}) === "deny") throw new Error("send blocked by session policy");
		}
		if (!isRawModelRun && acpResolution?.kind === "stale") throw acpResolution.error;
		if (!isRawModelRun && acpResolution?.kind === "ready" && sessionKey) {
			const attemptExecutionRuntime = await loadAttemptExecutionRuntime();
			const startedAt = Date.now();
			registerAgentRunContext(runId, { sessionKey });
			attemptExecutionRuntime.emitAcpLifecycleStart({
				runId,
				startedAt
			});
			const visibleTextAccumulator = attemptExecutionRuntime.createAcpVisibleTextAccumulator();
			let stopReason;
			try {
				const { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError, resolveAcpExplicitTurnPolicyError } = await loadAcpPolicyRuntime();
				const turnPolicyError = opts.acpTurnSource === "manual_spawn" ? resolveAcpExplicitTurnPolicyError(cfg) : resolveAcpDispatchPolicyError(cfg);
				if (turnPolicyError) throw turnPolicyError;
				const agentPolicyError = resolveAcpAgentPolicyError(cfg, normalizeAgentId(acpResolution.meta.agent || resolveAgentIdFromSessionKey(sessionKey)));
				if (agentPolicyError) throw agentPolicyError;
				await acpManager.runTurn({
					cfg,
					sessionKey,
					text: body,
					mode: "prompt",
					requestId: runId,
					signal: opts.abortSignal,
					onEvent: (event) => {
						if (event.type === "done") {
							stopReason = event.stopReason;
							return;
						}
						if (event.type !== "text_delta") return;
						if (event.stream && event.stream !== "output") return;
						if (!event.text) return;
						const visibleUpdate = visibleTextAccumulator.consume(event.text);
						if (!visibleUpdate) return;
						attemptExecutionRuntime.emitAcpAssistantDelta({
							runId,
							text: visibleUpdate.text,
							delta: visibleUpdate.delta
						});
					}
				});
			} catch (error) {
				const { toAcpRuntimeError } = await loadAcpRuntimeErrorsRuntime();
				const acpError = toAcpRuntimeError({
					error,
					fallbackCode: "ACP_TURN_FAILED",
					fallbackMessage: "ACP turn failed before completion."
				});
				attemptExecutionRuntime.emitAcpLifecycleError({
					runId,
					error: acpError,
					sessionKey
				});
				throw acpError;
			}
			attemptExecutionRuntime.emitAcpLifecycleEnd({ runId });
			const finalTextRaw = visibleTextAccumulator.finalizeRaw();
			const finalText = visibleTextAccumulator.finalize();
			try {
				const { resolveAcpSessionCwd } = await loadAcpSessionIdentifiersRuntime();
				sessionEntry = await attemptExecutionRuntime.persistAcpTurnTranscript({
					body,
					transcriptBody,
					finalText: finalTextRaw,
					sessionId,
					sessionKey,
					sessionEntry,
					sessionStore,
					storePath,
					sessionAgentId,
					threadId: opts.threadId,
					sessionCwd: resolveAcpSessionCwd(acpResolution.meta) ?? workspaceDir,
					config: cfg
				});
			} catch (error) {
				log.warn(`ACP transcript persistence failed for ${sessionKey}: ${formatErrorMessage(error)}`);
			}
			const result = attemptExecutionRuntime.buildAcpResult({
				payloadText: finalText,
				startedAt,
				stopReason,
				abortSignal: opts.abortSignal
			});
			const payloads = result.payloads;
			const { deliverAgentCommandResult } = await loadDeliveryRuntime();
			return await deliverAgentCommandResult({
				cfg,
				deps: resolvedDeps,
				runtime,
				opts,
				outboundSession,
				sessionEntry,
				result,
				payloads
			});
		}
		let resolvedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;
		const resolvedVerboseLevel = verboseOverride ?? persistedVerbose ?? agentCfg?.verboseDefault;
		if (sessionKey) registerAgentRunContext(runId, {
			sessionKey,
			verboseLevel: resolvedVerboseLevel
		});
		const [{ getSkillsSnapshotVersion, shouldRefreshSnapshotForVersion }, { matchesSkillFilter }] = await Promise.all([loadSkillsRefreshStateRuntime(), loadSkillsFilterRuntime()]);
		const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
		const skillFilter = resolveAgentSkillsFilter(cfg, sessionAgentId);
		const currentSkillsSnapshot = sessionEntry?.skillsSnapshot;
		const shouldRefreshSkillsSnapshot = !currentSkillsSnapshot || shouldRefreshSnapshotForVersion(currentSkillsSnapshot.version, skillsSnapshotVersion) || !matchesSkillFilter(currentSkillsSnapshot.skillFilter, skillFilter);
		const needsSkillsSnapshot = isNewSession || shouldRefreshSkillsSnapshot;
		const buildSkillsSnapshot = async () => {
			const [{ buildWorkspaceSkillSnapshot }, { getRemoteSkillEligibility }, { canExecRequestNode }] = await Promise.all([
				loadSkillsRuntime(),
				loadSkillsRemoteRuntime(),
				loadExecDefaultsRuntime()
			]);
			return buildWorkspaceSkillSnapshot(workspaceDir, {
				config: cfg,
				eligibility: { remote: getRemoteSkillEligibility({ advertiseExecNode: canExecRequestNode({
					cfg,
					sessionEntry,
					sessionKey,
					agentId: sessionAgentId
				}) }) },
				snapshotVersion: skillsSnapshotVersion,
				skillFilter,
				agentId: sessionAgentId
			});
		};
		const skillsSnapshot = needsSkillsSnapshot ? await buildSkillsSnapshot() : !currentSkillsSnapshot ? void 0 : await hydrateResolvedSkillsAsync(currentSkillsSnapshot, buildSkillsSnapshot);
		if (skillsSnapshot && sessionStore && sessionKey && needsSkillsSnapshot) {
			const now = Date.now();
			const current = sessionEntry ?? {
				sessionId,
				updatedAt: now,
				sessionStartedAt: now
			};
			const next = {
				...current,
				sessionId,
				updatedAt: now,
				sessionStartedAt: current.sessionStartedAt ?? now,
				skillsSnapshot
			};
			await persistSessionEntry({
				sessionStore,
				sessionKey,
				storePath,
				entry: next
			});
			sessionEntry = next;
		}
		if (sessionStore && sessionKey) {
			const now = Date.now();
			const entry = sessionStore[sessionKey] ?? sessionEntry ?? {
				sessionId,
				updatedAt: now,
				sessionStartedAt: now
			};
			const next = {
				...entry,
				sessionId,
				updatedAt: now,
				sessionStartedAt: entry.sessionStartedAt ?? now,
				lastInteractionAt: now
			};
			if (thinkOverride) next.thinkingLevel = thinkOverride;
			applyVerboseOverride(next, verboseOverride);
			await persistSessionEntry({
				sessionStore,
				sessionKey,
				storePath,
				entry: next
			});
			sessionEntry = next;
		}
		const configuredDefaultRef = resolveDefaultModelForAgent({
			cfg,
			agentId: sessionAgentId
		});
		const { provider: defaultProvider, model: defaultModel } = normalizeModelRef(configuredDefaultRef.provider, configuredDefaultRef.model);
		let provider = defaultProvider;
		let model = defaultModel;
		const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
		const hasStoredOverride = Boolean(sessionEntry?.modelOverride || sessionEntry?.providerOverride);
		let storedModelOverrideSource = hasStoredOverride ? sessionEntry?.modelOverrideSource : void 0;
		const explicitProviderOverride = typeof opts.provider === "string" ? normalizeExplicitOverrideInput(opts.provider, "provider") : void 0;
		const explicitModelOverride = typeof opts.model === "string" ? normalizeExplicitOverrideInput(opts.model, "model") : void 0;
		const hasExplicitRunOverride = Boolean(explicitProviderOverride || explicitModelOverride);
		if (hasExplicitRunOverride && opts.allowModelOverride !== true) throw new Error("Model override is not authorized for this caller.");
		const needsModelCatalog = Boolean(hasAllowlist);
		let allowedModelCatalog = [];
		let modelCatalog = null;
		let visibilityPolicy = createModelVisibilityPolicy({
			cfg,
			catalog: [],
			defaultProvider,
			defaultModel
		});
		if (needsModelCatalog) {
			modelCatalog = loadManifestModelCatalog({
				config: cfg,
				workspaceDir
			});
			visibilityPolicy = createModelVisibilityPolicy({
				cfg,
				catalog: modelCatalog,
				defaultProvider,
				defaultModel,
				agentId: sessionAgentId
			});
			allowedModelCatalog = visibilityPolicy.allowedCatalog;
		}
		if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
			const entry = sessionEntry;
			if (repairProviderWrappedModelOverride({
				entry,
				defaultProvider,
				defaultModel
			}).updated) await persistSessionEntry({
				sessionStore,
				sessionKey,
				storePath,
				entry
			});
			const overrideProvider = sessionEntry.providerOverride?.trim() || defaultProvider;
			const overrideModel = sessionEntry.modelOverride?.trim();
			if (overrideModel) {
				const normalizedOverride = normalizeModelRef(overrideProvider, overrideModel);
				const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
				if (!visibilityPolicy.allowsKey(key)) {
					const { updated } = applyModelOverrideToSessionEntry({
						entry,
						selection: {
							provider: defaultProvider,
							model: defaultModel,
							isDefault: true
						}
					});
					if (updated) await persistSessionEntry({
						sessionStore,
						sessionKey,
						storePath,
						entry
					});
				}
			}
		}
		const storedProviderOverride = sessionEntry?.providerOverride?.trim();
		let storedModelOverride = sessionEntry?.modelOverride?.trim();
		if (storedModelOverride) {
			const normalizedStored = normalizeModelRef(storedProviderOverride || defaultProvider, storedModelOverride);
			const key = modelKey(normalizedStored.provider, normalizedStored.model);
			if (visibilityPolicy.allowsKey(key)) {
				provider = normalizedStored.provider;
				model = normalizedStored.model;
			}
		}
		let providerForAuthProfileValidation = provider;
		if (hasExplicitRunOverride) {
			const explicitRef = explicitModelOverride ? explicitProviderOverride ? normalizeModelRef(explicitProviderOverride, explicitModelOverride) : parseModelRef(explicitModelOverride, provider) : explicitProviderOverride ? normalizeModelRef(explicitProviderOverride, model) : null;
			if (!explicitRef) throw new Error("Invalid model override.");
			const explicitKey = modelKey(explicitRef.provider, explicitRef.model);
			if (!visibilityPolicy.allowsKey(explicitKey)) throw new Error(`Model override "${sanitizeForLog(explicitRef.provider)}/${sanitizeForLog(explicitRef.model)}" is not allowed for agent "${sessionAgentId}".`);
			provider = explicitRef.provider;
			model = explicitRef.model;
		}
		const allowedInitialSelection = visibilityPolicy.resolveSelection({
			provider,
			model
		});
		if (!allowedInitialSelection) throw new Error(`Configured default model "${modelKey(provider, model)}" is not allowed by agents.defaults.models, and no allowed model is available.`);
		provider = allowedInitialSelection.provider;
		model = allowedInitialSelection.model;
		providerForAuthProfileValidation = provider;
		let sessionEntryForAttempt = sessionEntry;
		if (sessionEntry) {
			const authProfileId = sessionEntry.authProfileOverride;
			if (authProfileId) {
				const entry = sessionEntry;
				const profile = ensureAuthProfileStore().profiles[authProfileId];
				const profileAuthProvider = profile ? resolveProviderIdForAuth(profile.provider, {
					config: cfg,
					workspaceDir
				}) : void 0;
				const validationHarnessPolicy = resolveAgentHarnessPolicy({
					provider: providerForAuthProfileValidation,
					modelId: model,
					config: cfg,
					agentId: sessionAgentId,
					sessionKey
				});
				const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
					provider: providerForAuthProfileValidation,
					harnessRuntime: validationHarnessPolicy.runtime
				}).map((candidateProvider) => resolveProviderIdForAuth(candidateProvider, {
					config: cfg,
					workspaceDir
				}));
				if (!profile || !acceptedAuthProviders.includes(profileAuthProvider ?? "")) {
					if (hasExplicitRunOverride) sessionEntryForAttempt = {
						...entry,
						authProfileOverride: void 0,
						authProfileOverrideSource: void 0,
						authProfileOverrideCompactionCount: void 0
					};
					else if (sessionStore && sessionKey) await clearSessionAuthProfileOverride({
						sessionEntry: entry,
						sessionStore,
						sessionKey,
						storePath
					});
				}
			}
		}
		const catalogForThinking = allowedModelCatalog.length > 0 ? allowedModelCatalog : modelCatalog && modelCatalog.length > 0 ? modelCatalog : configuredThinkingCatalog;
		const thinkingCatalog = catalogForThinking.length > 0 ? catalogForThinking : void 0;
		if (!resolvedThinkLevel) resolvedThinkLevel = resolveThinkingDefault({
			cfg,
			provider,
			model,
			catalog: thinkingCatalog
		});
		if (!isThinkingLevelSupported({
			provider,
			model,
			level: resolvedThinkLevel,
			catalog: thinkingCatalog
		})) {
			if (Boolean(thinkOnce || thinkOverride)) throw new Error(`Thinking level "${resolvedThinkLevel}" is not supported for ${provider}/${model}. Use one of: ${formatThinkingLevels(provider, model, ", ", thinkingCatalog)}.`);
			const fallbackThinkLevel = resolveSupportedThinkingLevel({
				provider,
				model,
				level: resolvedThinkLevel,
				catalog: thinkingCatalog
			});
			if (fallbackThinkLevel !== resolvedThinkLevel) {
				const previousThinkLevel = resolvedThinkLevel;
				resolvedThinkLevel = fallbackThinkLevel;
				if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === previousThinkLevel) {
					const entry = sessionEntry;
					entry.thinkingLevel = fallbackThinkLevel;
					entry.updatedAt = Date.now();
					await persistSessionEntry({
						sessionStore,
						sessionKey,
						storePath,
						entry
					});
				}
			}
		}
		await ensureSelectedAgentHarnessPlugin({
			config: cfg,
			provider,
			modelId: model,
			agentId: sessionAgentId,
			sessionKey,
			workspaceDir
		});
		const { resolveSessionTranscriptFile } = await loadTranscriptResolveRuntime();
		let sessionFile;
		if (sessionStore && sessionKey) {
			const resolvedSessionFile = await resolveSessionTranscriptFile({
				sessionId,
				sessionKey,
				sessionStore,
				storePath,
				sessionEntry,
				agentId: sessionAgentId,
				threadId: opts.threadId
			});
			sessionFile = resolvedSessionFile.sessionFile;
			sessionEntry = resolvedSessionFile.sessionEntry;
		}
		if (!sessionFile) {
			const resolvedSessionFile = await resolveSessionTranscriptFile({
				sessionId,
				sessionKey: sessionKey ?? sessionId,
				storePath,
				sessionEntry,
				agentId: sessionAgentId,
				threadId: opts.threadId
			});
			sessionFile = resolvedSessionFile.sessionFile;
			sessionEntry = resolvedSessionFile.sessionEntry;
		}
		const startedAt = Date.now();
		let lifecycleEnded = false;
		const attemptExecutionRuntime = await loadAttemptExecutionRuntime();
		const runContext = resolveAgentRunContext(opts);
		const messageChannel = resolveMessageChannel(runContext.messageChannel, opts.replyChannel ?? opts.channel);
		let result;
		let fallbackProvider = provider;
		let fallbackModel = model;
		const MAX_LIVE_SWITCH_RETRIES = 5;
		let liveSwitchRetries = 0;
		const fallbackTrajectoryRecorder = createTrajectoryRuntimeRecorder({
			cfg,
			runId,
			sessionId,
			sessionKey,
			sessionFile,
			provider,
			modelId: model,
			workspaceDir
		});
		for (;;) try {
			const spawnedBy = normalizedSpawned.spawnedBy ?? sessionEntry?.spawnedBy;
			const effectiveFallbacksOverride = resolveEffectiveModelFallbacks({
				cfg,
				agentId: sessionAgentId,
				hasSessionModelOverride: hasExplicitRunOverride || Boolean(storedProviderOverride || storedModelOverride),
				modelOverrideSource: hasExplicitRunOverride ? "user" : storedModelOverrideSource
			});
			let fallbackAttemptIndex = 0;
			let currentTurnUserMessagePersisted = false;
			const fallbackResult = await runWithModelFallback({
				cfg,
				provider,
				model,
				runId,
				agentDir,
				fallbacksOverride: effectiveFallbacksOverride,
				onFallbackStep: (step) => {
					fallbackTrajectoryRecorder?.recordEvent("model.fallback_step", step);
				},
				classifyResult: ({ provider, model, result }) => classifyEmbeddedPiRunResultForModelFallback({
					provider,
					model,
					result
				}),
				run: async (providerOverride, modelOverride, runOptions) => {
					const isFallbackRetry = fallbackAttemptIndex > 0;
					fallbackAttemptIndex += 1;
					return attemptExecutionRuntime.runAgentAttempt({
						providerOverride,
						modelOverride,
						modelFallbacksOverride: effectiveFallbacksOverride,
						originalProvider: provider,
						cfg,
						sessionEntry: sessionEntryForAttempt,
						sessionId,
						sessionKey,
						sessionAgentId,
						sessionFile,
						workspaceDir,
						body,
						isFallbackRetry,
						resolvedThinkLevel,
						fastMode: resolveFastModeState({
							cfg,
							provider: providerOverride,
							model: modelOverride,
							agentId: sessionAgentId,
							sessionEntry
						}).enabled,
						timeoutMs,
						runId,
						opts,
						runContext,
						spawnedBy,
						messageChannel,
						skillsSnapshot,
						resolvedVerboseLevel,
						agentDir,
						authProfileProvider: providerForAuthProfileValidation,
						sessionStore,
						storePath,
						allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
						sessionHasHistory: !isNewSession || await attemptExecutionRuntime.sessionFileHasContent(sessionFile),
						suppressPromptPersistenceOnRetry: opts.suppressPromptPersistence === true || isFallbackRetry && currentTurnUserMessagePersisted,
						onUserMessagePersisted: () => {
							currentTurnUserMessagePersisted = true;
						},
						onAgentEvent: (evt) => {
							if (evt.stream === "lifecycle" && typeof evt.data?.phase === "string" && (evt.data.phase === "end" || evt.data.phase === "error")) lifecycleEnded = true;
						}
					});
				}
			});
			result = fallbackResult.result;
			fallbackProvider = fallbackResult.provider;
			fallbackModel = fallbackResult.model;
			if (fallbackResult.attempts.length > 0 && result.meta.agentMeta) result = {
				...result,
				meta: {
					...result.meta,
					agentMeta: {
						...result.meta.agentMeta,
						fallbackAttempts: fallbackResult.attempts
					}
				}
			};
			if (!lifecycleEnded) {
				const stopReason = result.meta.stopReason;
				if (stopReason && stopReason !== "end_turn") console.error(`[agent] run ${runId} ended with stopReason=${stopReason}`);
				emitAgentEvent({
					runId,
					stream: "lifecycle",
					data: {
						phase: "end",
						startedAt,
						endedAt: Date.now(),
						aborted: result.meta.aborted ?? false,
						stopReason
					}
				});
			}
			break;
		} catch (err) {
			if (err instanceof LiveSessionModelSwitchError) {
				liveSwitchRetries++;
				if (liveSwitchRetries > MAX_LIVE_SWITCH_RETRIES) {
					log.error(`Live session model switch in subagent run ${runId}: exceeded maximum retries (${MAX_LIVE_SWITCH_RETRIES})`);
					if (!lifecycleEnded) emitAgentEvent({
						runId,
						stream: "lifecycle",
						data: {
							phase: "error",
							startedAt,
							endedAt: Date.now(),
							error: "Agent run failed"
						}
					});
					await fallbackTrajectoryRecorder?.flush();
					throw new Error(`Exceeded maximum live model switch retries (${MAX_LIVE_SWITCH_RETRIES})`, { cause: err });
				}
				const switchRef = normalizeModelRef(err.provider, err.model);
				const switchKey = modelKey(switchRef.provider, switchRef.model);
				if (!visibilityPolicy.allowsKey(switchKey)) {
					log.info(`Live session model switch in subagent run ${runId}: rejected ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)} (not in allowlist)`);
					if (!lifecycleEnded) emitAgentEvent({
						runId,
						stream: "lifecycle",
						data: {
							phase: "error",
							startedAt,
							endedAt: Date.now(),
							error: "Agent run failed"
						}
					});
					await fallbackTrajectoryRecorder?.flush();
					throw new Error(`Live model switch rejected: ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)} is not in the agent allowlist`, { cause: err });
				}
				const previousProvider = provider;
				const previousModel = model;
				provider = err.provider;
				model = err.model;
				fallbackProvider = err.provider;
				fallbackModel = err.model;
				providerForAuthProfileValidation = err.provider;
				if (sessionEntry) {
					sessionEntry = { ...sessionEntry };
					sessionEntry.authProfileOverride = err.authProfileId;
					sessionEntry.authProfileOverrideSource = err.authProfileId ? err.authProfileIdSource : void 0;
					sessionEntry.authProfileOverrideCompactionCount = void 0;
				}
				if (storedModelOverride || err.model !== previousModel || err.provider !== previousProvider) {
					storedModelOverride = err.model;
					storedModelOverrideSource = "user";
				}
				lifecycleEnded = false;
				log.info(`Live session model switch in subagent run ${runId}: switching to ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)}`);
				continue;
			}
			if (!lifecycleEnded) emitAgentEvent({
				runId,
				stream: "lifecycle",
				data: {
					phase: "error",
					startedAt,
					endedAt: Date.now(),
					error: err instanceof Error ? err.message : "Agent run failed"
				}
			});
			await fallbackTrajectoryRecorder?.flush();
			throw err;
		}
		await fallbackTrajectoryRecorder?.flush();
		if (sessionStore && sessionKey) {
			const { updateSessionStoreAfterAgentRun } = await loadSessionStoreRuntime();
			await updateSessionStoreAfterAgentRun({
				cfg,
				contextTokensOverride: agentCfg?.contextTokens,
				sessionId,
				sessionKey,
				storePath,
				sessionStore,
				defaultProvider: provider,
				defaultModel: model,
				fallbackProvider,
				fallbackModel,
				result,
				touchInteraction: opts.bootstrapContextRunKind !== "cron" && opts.bootstrapContextRunKind !== "heartbeat" && !opts.internalEvents?.length,
				preserveRuntimeModel: opts.bootstrapContextRunKind === "heartbeat"
			});
			sessionEntry = sessionStore[sessionKey] ?? sessionEntry;
		}
		const transcriptPersistenceRunner = result.meta.executionTrace?.runner;
		const embeddedAssistantGapFill = transcriptPersistenceRunner === "embedded" || transcriptPersistenceRunner === void 0 && Boolean(result.meta.finalAssistantVisibleText?.trim());
		if (transcriptPersistenceRunner === "cli" || embeddedAssistantGapFill) try {
			sessionEntry = await attemptExecutionRuntime.persistCliTurnTranscript({
				body,
				transcriptBody,
				result,
				sessionId,
				sessionKey: sessionKey ?? sessionId,
				sessionEntry,
				sessionStore,
				storePath,
				sessionAgentId,
				threadId: opts.threadId,
				sessionCwd: workspaceDir,
				config: cfg,
				embeddedAssistantGapFill
			});
			sessionEntry = await (await loadCliCompactionRuntime()).runCliTurnCompactionLifecycle({
				cfg,
				sessionId,
				sessionKey: sessionKey ?? sessionId,
				sessionEntry,
				sessionStore,
				storePath,
				sessionAgentId,
				workspaceDir,
				agentDir,
				provider: result.meta.agentMeta?.provider ?? provider,
				model: result.meta.agentMeta?.model ?? model,
				skillsSnapshot,
				messageChannel,
				agentAccountId: runContext.accountId,
				senderIsOwner: opts.senderIsOwner,
				thinkLevel: resolvedThinkLevel,
				extraSystemPrompt: opts.extraSystemPrompt
			});
		} catch (error) {
			log.warn(`Turn transcript persistence failed for ${sessionKey ?? sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const payloads = result.payloads ?? [];
		if (opts.deliver === true && sessionStore && sessionKey && payloads.length > 0 && !isSubagentSessionKey(sessionKey)) {
			const now = Date.now();
			const combinedPayload = payloads.map((p) => typeof p.text === "string" ? p.text : "").filter(Boolean).join("\n\n");
			if (combinedPayload) {
				const next = {
					...sessionStore[sessionKey] ?? sessionEntry,
					pendingFinalDelivery: true,
					pendingFinalDeliveryText: combinedPayload,
					pendingFinalDeliveryCreatedAt: now,
					updatedAt: now
				};
				await persistSessionEntry({
					sessionStore,
					sessionKey,
					storePath,
					entry: next
				});
				sessionEntry = next;
			}
		}
		const { deliverAgentCommandResult } = await loadDeliveryRuntime();
		const deliveryResult = await deliverAgentCommandResult({
			cfg,
			deps: resolvedDeps,
			runtime,
			opts,
			outboundSession,
			sessionEntry,
			result,
			payloads
		});
		if (deliveryResult?.deliverySucceeded === true && sessionStore && sessionKey && !isSubagentSessionKey(sessionKey)) {
			const next = {
				...sessionStore[sessionKey] ?? sessionEntry,
				pendingFinalDelivery: void 0,
				pendingFinalDeliveryText: void 0,
				pendingFinalDeliveryCreatedAt: void 0,
				updatedAt: Date.now()
			};
			await persistSessionEntry({
				sessionStore,
				sessionKey,
				storePath,
				entry: next
			});
			sessionEntry = next;
		}
		return deliveryResult;
	} finally {
		clearAgentRunContext(runId);
	}
}
async function agentCommand(opts, runtime = defaultRuntime, deps) {
	return await agentCommandInternal({
		...opts,
		senderIsOwner: opts.senderIsOwner ?? true,
		allowModelOverride: opts.allowModelOverride ?? true
	}, runtime, deps);
}
async function agentCommandFromIngress(opts, runtime = defaultRuntime, deps) {
	if (typeof opts.senderIsOwner !== "boolean") throw new Error("senderIsOwner must be explicitly set for ingress agent runs.");
	if (typeof opts.allowModelOverride !== "boolean") throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
	return await agentCommandInternal({
		...opts,
		senderIsOwner: opts.senderIsOwner,
		allowModelOverride: opts.allowModelOverride
	}, runtime, deps);
}
const __testing = {
	resolveAgentRuntimeConfig,
	prepareAgentCommandExecution
};
//#endregion
export { agentCommand as n, agentCommandFromIngress as r, __testing as t };
