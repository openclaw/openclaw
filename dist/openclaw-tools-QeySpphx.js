import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue, l as normalizeOptionalStringifiedId, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { l as redactToolPayloadText } from "./redact-ok5Q8nmw.js";
import { i as resolveOsHomeDir, t as expandHomePrefix } from "./home-dir-BOPFpGo8.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { m as FsSafeError } from "./path-BlG8lhgR.js";
import { S as hasEncodedFileUrlSeparator, T as trySafeFileURLToPath } from "./fs-safe-CV86zY9G.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import { h as isWindowsDrivePath } from "./archive-DBeZ8ywX.js";
import { c as isRecord$2, p as resolveUserPath, y as truncateUtf16Safe } from "./utils-sBTEdeml.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { a as resolveAgentModelTimeoutMsValue, i as resolveAgentModelPrimaryValue, r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { _ as resolveSessionAgentId, a as resolveAgentEffectiveModelPrimary, o as resolveAgentExecutionContract, v as resolveSessionAgentIds } from "./agent-scope-CtLXGcWm.js";
import { a as isSubagentSessionKey, c as parseAgentSessionKey, u as parseThreadSessionSuffix } from "./session-key-utils-Ce_xWkNq.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { d as resolveAgentIdFromSessionKey, l as normalizeAgentId, m as sanitizeAgentId, r as buildAgentMainSessionKey, t as DEFAULT_AGENT_ID, v as toAgentStoreSessionKey } from "./session-key-Bte0mmcq.js";
import { n as listAgentIds, o as resolveAgentWorkspaceDir, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { n as createConfigScopedPromiseLoader } from "./plugin-cache-primitives-DcK62VYf.js";
import { i as resolveManifestContractOwnerPluginId, v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-B6ofplrA.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as logDebug } from "./logger-0o2znY2U.js";
import { i as getRuntimeConfig, o as parseConfigJson5, y as resolveConfigSnapshotHash } from "./io-DoswVvYe.js";
import { n as getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state-DRIYGASz.js";
import { n as modelKey } from "./model-ref-shared-BkjJfDrJ.js";
import { t as applyMergePatch } from "./merge-patch-BAO515t_.js";
import { g as selectApplicableRuntimeConfig, i as getRuntimeConfigSnapshot, s as getRuntimeConfigSourceSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import { t as getProviderEnvVars } from "./provider-env-vars-HpAfBQBJ.js";
import { t as parseDurationMs } from "./parse-duration-CD4d_yk2.js";
import "./config-B6Oplu5W.js";
import { n as isRestartEnabled } from "./commands.flags-CeKA8V9z.js";
import { o as normalizeChannelId } from "./registry-CtWyD2pE.js";
import { n as GATEWAY_CLIENT_IDS, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { r as INTERNAL_MESSAGE_CHANNEL } from "./message-channel-core-BoUoCGOD.js";
import { s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { d as readConnectPairingRequiredMessage } from "./connect-error-details-BNpp20bs.js";
import { r as annotateInterSessionPromptText } from "./input-provenance-CmqYxlZ2.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { f as scheduleGatewaySigusr1Restart } from "./restart-C-r_0sSG.js";
import { a as loadManifestContractSnapshot, i as listAvailableManifestContractValues, n as isManifestPluginAvailableForControlPlane } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { h as synthesizeMediaGenerationCatalogEntries, m as listMediaGenerationProviderModels } from "./loader-DKK7Ita0.js";
import { i as hasInternalHookListeners, m as triggerInternalHook } from "./internal-hooks-DpfQDjis.js";
import { t as clearAgentRunContext, u as registerAgentRunContext } from "./agent-events-BuYtWSh4.js";
import { n as assertSandboxPath } from "./sandbox-paths-BTYunIeX.js";
import "./local-file-access-CBe_wA_B.js";
import { a as toRelativeWorkspacePath, n as resolveWorkspaceRoot, t as normalizeWorkspaceDir } from "./workspace-dir-DICx6sb6.js";
import { h as stringifyRouteThreadId } from "./channel-route-L2PJ-xNE.js";
import { n as deliveryContextFromSession, o as normalizeDeliveryContext } from "./delivery-context.shared-CBmB9dF7.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath, u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { O as parseSessionThreadInfoFast, t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { a as normalizeChannelId$1, i as listChannelPlugins, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import { n as resolveSessionConversationRef } from "./session-conversation-XHNnUnBT.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import "./plugins-DYTHbmt7.js";
import { n as mergeSessionEntry } from "./types-BgvyBC-3.js";
import { u as extractDeliveryInfo } from "./sessions-CQHHcgC_.js";
import { a as imageMimeFromFormat, n as detectMime } from "./mime-DppuT-pZ.js";
import { v as normalizeProviderTransportWithPlugin } from "./provider-runtime-D8jQEgmu.js";
import { i as buildModelAliasIndex, x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import { n as modelKey$1, r as normalizeModelRef } from "./model-selection-normalize-CBfQo-Fd.js";
import { n as ensureOpenClawModelsJson } from "./models-config-DNlTw_QX.js";
import { h as resolveThinkingDefaultWithRuntimeCatalog, s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { n as requireApiKey } from "./model-auth-runtime-shared-cdTr1v5l.js";
import { t as stableStringify } from "./stable-stringify-TfJ9A6yH.js";
import { n as loadModelCatalog } from "./model-catalog-DhWpNp70.js";
import { d as listFreshTasksForOwnerKey, h as listTasksForOwnerKey } from "./task-registry-B9ljq8Nk.js";
import { n as extractTextFromChatContent } from "./chat-content-BNTcXm1Z.js";
import { n as formatTaskStatusDetail, r as formatTaskStatusTitle } from "./task-status-BvwcU8qI.js";
import "./runtime-internal-2F71tA3B.js";
import { a as failTaskRunByRunId, c as recordTaskRunProgressByRunId, i as createRunningTaskRun, n as completeTaskRunByRunId } from "./detached-task-runtime-C79km_82.js";
import { n as SILENT_REPLY_TOKEN } from "./tokens-CFv3Qu_v.js";
import { f as readSessionTitleFieldsFromTranscriptAsync, n as capArrayByJsonBytes, x as jsonUtf8Bytes } from "./session-utils.fs-CsnHXIqH.js";
import { t as resolveModelAgentRuntimeMetadata } from "./agent-runtime-metadata-DOglN8Yf.js";
import { _ as resolveSessionModelIdentityRef, n as deriveSessionTitle } from "./session-utils-CRKr-5AU.js";
import { d as writeRestartSentinel, r as formatDoctorNonInteractiveHint, s as removeRestartSentinelFile, t as buildRestartSuccessContinuation } from "./restart-sentinel-BDtpdKoy.js";
import { S as describeUpdatePlanTool, _ as describeSessionStatusTool, b as describeSessionsSendTool, d as SESSIONS_LIST_TOOL_DISPLAY_SUMMARY, f as SESSIONS_SEND_TOOL_DISPLAY_SUMMARY, g as UPDATE_PLAN_TOOL_DISPLAY_SUMMARY, h as SESSION_STATUS_TOOL_DISPLAY_SUMMARY, m as SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY, p as SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY, s as CRON_TOOL_DISPLAY_SUMMARY, u as SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY, v as describeSessionsHistoryTool, x as describeSessionsSpawnTool, y as describeSessionsListTool } from "./tool-catalog-8X_kZYZC.js";
import "./tool-policy-COX5DaEj.js";
import { n as isToolAllowedByPolicyName } from "./tool-policy-match-C9WqMgmG.js";
import { c as findAcpUnsupportedInheritedToolAllow, d as formatAcpInheritedToolDenyError, l as findAcpUnsupportedInheritedToolDeny, u as formatAcpInheritedToolAllowError } from "./subagent-capabilities-mB73wM9t.js";
import { t as isAcpRuntimeSpawnAvailable } from "./availability-C-N5XwGI.js";
import { n as HEARTBEAT_TOOL_OUTCOMES, o as normalizeHeartbeatToolResponse, r as HEARTBEAT_TOOL_PRIORITIES, t as HEARTBEAT_RESPONSE_TOOL_NAME } from "./heartbeat-tool-response-Cf_D5Tj1.js";
import { a as manifestProviderBaseUrlGuardPasses, i as manifestPluginSetupProviderEnvVars, n as hasNonEmptyManifestEnvCandidate, r as manifestConfigSignalPasses } from "./manifest-tool-availability-6BoazIq-.js";
import { a as resolvePluginTools } from "./tools-KpflAzxD.js";
import { t as canonicalizeBase64 } from "./base64-D03BM6T6.js";
import { c as getImageMetadata } from "./media-services-CLFjOJQs.js";
import { i as resolveImageSanitizationLimits, r as sanitizeToolResultImages } from "./tool-images-Cv3ZnK02.js";
import { i as listCrossChannelSchemaSupportedMessageActions, n as channelSupportsMessageCapabilityForChannel, o as resolveChannelMessageToolSchemaProperties, t as channelSupportsMessageCapability } from "./message-action-discovery-C_vRmQ0H.js";
import { C as listAllChannelSupportedActions, T as listChannelSupportedActions, c as isToolWrappedWithBeforeToolCallHook, p as wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call-CP_aEkky.js";
import { i as stringEnum, n as channelTargetsSchema, r as optionalStringEnum, t as channelTargetSchema } from "./typebox-CjEaoMel.js";
import { c as jsonResult, f as readNumberParam, g as readStringParam$1, l as normalizeToolModelOverride, m as readStringArrayParam, n as ToolInputError, r as asToolParamsRecord, y as readSnakeCaseParamRaw } from "./common-E9YpX7pB.js";
import { n as readGatewayCallOptions, r as resolveGatewayOptions, t as callGatewayTool } from "./gateway-CnPnSTsW.js";
import "./auth-profiles-D6NMnufG.js";
import { n as resolveApiKeyForProfile } from "./oauth--yqMDDjF.js";
import { n as listProfilesForProvider } from "./profile-list-C0HtPlut.js";
import { i as resolveAuthProfileOrder } from "./order-DJrj83KE.js";
import { a as getCustomProviderApiKey, i as getApiKeyForModel } from "./model-auth-Db-JGIrg.js";
import { i as loadSessionEntryByKey, m as mediaUrlsFromGeneratedAttachments, p as formatGeneratedAttachmentLines, t as deliverSubagentAnnouncement } from "./subagent-announce-delivery-p160OmJs.js";
import { n as extractAssistantText } from "./pi-embedded-utils-D6gJe2Np.js";
import { n as runWithImageModelFallback } from "./model-fallback-BCpDvqqS.js";
import "./delivery-context-B4XSfAAB.js";
import { n as getActiveRuntimeWebToolsMetadata } from "./runtime-web-tools-state-BgXXPpNN.js";
import { a as getActiveSecretsRuntimeSnapshot } from "./runtime-state-CPpp7_ve.js";
import { o as resolveSubagentAllowedTargetIds } from "./spawn-requester-origin-u-IVBdHC.js";
import { i as createSessionVisibilityRowChecker, o as resolveEffectiveSessionToolsVisibility, r as createSessionVisibilityGuard, t as createAgentToAgentPolicy } from "./session-visibility-DWz6M2DP.js";
import { a as resolveCurrentSessionClientAlias, c as resolveMainSessionAlias, d as shouldResolveSessionIdInput, i as resolveSandboxedSessionToolContext, l as resolveSessionReference, n as deriveChannel, o as resolveDisplaySessionKey, r as resolveSessionToolContext, s as resolveInternalSessionKey, t as classifySessionKind, u as resolveVisibleSessionReference } from "./sessions-helpers-AhiZZPDz.js";
import { r as stripToolMessages } from "./chat-history-text-BaMeG8tt.js";
import { c as resolveCronCreationDelivery, i as resolveCronCurrentSessionTarget, n as assertSafeCronSessionTargetId, t as normalizeHttpWebhookUrl } from "./webhook-url-CYBYCR4B.js";
import { a as parseDeliveryInput, i as TrimmedNonEmptyStringFieldSchema, o as parseOptionalField, r as TimeoutSecondsFieldSchema } from "./delivery-field-schemas-BqP7BUbz.js";
import { i as parseAbsoluteTimeMs, r as resolveDefaultCronStaggerMs, t as normalizeCronStaggerMs } from "./stagger-Bn6ApiDa.js";
import { t as inferLegacyName } from "./normalize-CV8XB8wE.js";
import { t as collectEnabledInsecureOrDangerousFlags } from "./dangerous-config-flags-CTbQ4iqx.js";
import { r as parseImageGenerationModelRef } from "./provider-registry-B3fo_9Pr.js";
import { a as normalizeDurationToClosestMax, i as hasMediaNormalizationEntry, n as buildNoCapabilityModelConfiguredMessage, o as recordCapabilityCandidateFailure, p as throwCapabilityGenerationFailure, s as resolveCapabilityModelCandidates, t as buildMediaGenerationNormalizationMetadata } from "./runtime-shared-CXEq0Bjh.js";
import { n as listRuntimeImageGenerationProviders, t as generateImage } from "./runtime-DXmZDQh5.js";
import { t as loadCapabilityManifestSnapshot } from "./capability-provider-runtime-BwiWIvn0.js";
import { n as resolveConfiguredMediaMaxBytes, r as resolveGeneratedMediaMaxBytes } from "./configured-max-bytes-CNKFB65A.js";
import { u as saveMediaBuffer } from "./store-rQFzzX5P.js";
import { t as SsrFBlockedError } from "./ssrf-DdDeGa5L.js";
import { n as classifyMediaReferenceSource, r as normalizeMediaReferenceSource } from "./media-reference-efB9JQqF.js";
import { n as buildTimeoutAbortSignal } from "./fetch-timeout-CptH2le9.js";
import { r as getDefaultLocalRoots } from "./local-media-access-Cfwhp6hG.js";
import { n as loadWebMediaRaw, t as loadWebMedia } from "./web-media-GlH39bZn.js";
import { n as formatAgentInternalEventsForPrompt } from "./internal-events-yCBm9zLb.js";
import { a as hasProviderAuthForTool, n as coerceToolModelConfig, o as hasToolModelConfig$1, r as hasAuthForProvider, s as resolveDefaultModelRef, t as buildToolModelConfigFromCandidates } from "./model-config.helpers-6EP_rOvT.js";
import { i as discoverModels, r as discoverAuthStorage } from "./pi-model-discovery-LbwIS40h.js";
import { n as resolveSandboxedBridgeMediaPath, t as createSandboxBridgeReadFile } from "./sandbox-media-paths-hJE2oO_A.js";
import { n as isMinimaxVlmProvider } from "./minimax-vlm-Bk6rsboX.js";
import { a as resolveConfiguredImageModelRefs, n as coerceImageModelConfig, o as resolveProviderVisionModelFromConfig, r as decodeDataUrl } from "./image-tool.helpers-B4np7FaQ.js";
import { n as normalizeMediaProviderId } from "./provider-id-BETgOIvU.js";
import { n as resolveAutoMediaKeyProviders, r as resolveDefaultMediaModel, t as providerSupportsNativePdfDocument } from "./defaults-DCsp7qAB.js";
import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-Dye6Uj6e.js";
import { d as getMediaUnderstandingProvider, s as DEFAULT_TIMEOUT_SECONDS } from "./defaults.constants-DeIx7Gbv.js";
import { t as matchesMediaEntryCapability } from "./entry-capabilities-DGvNSGdr.js";
import { s as resolveTimeoutMs } from "./resolve-CJVCx0AN.js";
import { t as buildProviderRegistry } from "./runner-C8f8m91V.js";
import "./media-understanding-C_qxfCIa.js";
import { n as CHANNEL_MESSAGE_ACTION_NAMES, t as resolveMessageSecretScope } from "./message-secret-scope-NhV1S-c7.js";
import { t as resolveCommandSecretRefsViaGateway } from "./command-secret-gateway-BpOVXOFV.js";
import { d as getScopedChannelsCommandSecretTargets } from "./command-secret-targets-UUlaHEu2.js";
import { a as POLL_CREATION_PARAM_DEFS, i as stripFormattedReasoningMessage, n as runMessageAction, o as SHARED_POLL_CREATION_PARAM_NAMES, r as resolveAllowedMessageActions, t as getToolResult } from "./message-action-runner-B4oH5EYj.js";
import { n as listMusicGenerationProviders, r as parseMusicGenerationModelRef, t as getMusicGenerationProvider } from "./provider-registry-CpK0zzwT.js";
import { t as resolveNodePairApprovalScopes } from "./node-pairing-authz-BEOIjx2Q.js";
import { t as parseTimeoutMs } from "./parse-timeout-91AFhn8L.js";
import { a as parseCameraClipPayload, c as writeCameraPayloadToFile, i as cameraTempPath, n as screenRecordTempPath, o as parseCameraSnapPayload, r as writeScreenRecordToFile, s as writeCameraClipPayloadToFile, t as parseScreenRecordPayload } from "./nodes-screen-DEoX3jQ4.js";
import { n as resolveNode, r as resolveNodeId } from "./nodes-utils-BZvT6hX1.js";
import { n as resolveEnabledBundledManifestContractPlugins, t as extractPdfContent } from "./pdf-extract-Cb7tCN-u.js";
import { t as applyModelOverrideToSessionEntry } from "./model-overrides-CUnMI0Oj.js";
import { t as buildTaskStatusSnapshotForRelatedSessionKeyForOwner } from "./task-owner-access-MrVYMLx_.js";
import { t as createModelVisibilityPolicy } from "./model-visibility-policy-X7G_tvfc.js";
import { i as resolveNestedAgentLaneForSession } from "./lanes-ReZ09_e4.js";
import { a as waitForAgentRunAndReadUpdatedAssistantReply, i as waitForAgentRun, r as readLatestAssistantReplySnapshot } from "./run-wait-BlZoP48F.js";
import { _ as isReplySkip, f as runAgentStep, g as isNonDeliverableSessionsReply, h as isAnnounceSkip, m as REPLY_SKIP_TOKEN, p as ANNOUNCE_SKIP_TOKEN } from "./subagent-session-cleanup-B3w9Gz1A.js";
import { f as supportsAutomaticThreadBindingSpawn, u as resolveThreadBindingSpawnPolicy } from "./thread-bindings-policy-BAuuUJk1.js";
import { p as registerSubagentRun } from "./subagent-registry-QwuPQSxK.js";
import { a as resolveSubagentSpawnOwnership, i as normalizeSubagentTaskName, n as SUBAGENT_SPAWN_CONTEXT_MODES, r as SUBAGENT_SPAWN_MODES, t as spawnSubagentDirect } from "./subagent-spawn-BHpOcEcG.js";
import { i as isActiveSubagentRun, n as buildSubagentList, r as createPendingDescendantCounter } from "./subagent-list-GHsV668o.js";
import { c as resolveSubagentController, i as killControlledSubagentRun, n as MAX_STEER_MESSAGE_CHARS, o as listControlledSubagentRuns, r as killAllControlledSubagentRuns, s as resolveControlledSubagentTarget, t as MAX_RECENT_MINUTES, u as steerControlledSubagentRun } from "./subagent-control-lL9C38ND.js";
import { k as textToSpeech } from "./tts-runtime-B3-lBCQj.js";
import "./tts-Bd-K2Dd6.js";
import { a as resolveVideoGenerationModeCapabilities, i as resolveVideoGenerationMode, r as listSupportedVideoGenerationModes } from "./duration-support-0igMBB1p.js";
import { t as parseVideoGenerationModelRef } from "./model-ref-Bmr4a8Ak.js";
import { n as listRuntimeVideoGenerationProviders, t as generateVideo } from "./runtime-CivQQNy1.js";
import { a as wrapWebContent, i as wrapExternalContent } from "./external-content-BWPoz0BU.js";
import { i as resolveWebProviderConfig } from "./provider-runtime-shared-B1Ic1Utb.js";
import { a as truncateText$1, n as htmlToMarkdown, r as markdownToText, t as extractBasicHtmlContent } from "./web-fetch-utils-C4SBPqhU.js";
import { a as readResponseText, i as readCache, l as writeCache, o as resolveCacheTtlMs, r as normalizeCacheKey, s as resolveTimeoutSeconds } from "./web-shared-CYJpPo1M.js";
import { i as runWebSearch } from "./runtime-JrxuINJZ.js";
import "./web-search-provider-common-Dg4Eh9ob.js";
import { URL as URL$1 } from "node:url";
import path, { isAbsolute, resolve } from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
//#region src/acp/session-interaction-mode.ts
function resolveAcpSessionInteractionMode(entry) {
	if (!entry?.acp) return "interactive";
	if (normalizeOptionalString(entry.spawnedBy) || normalizeOptionalString(entry.parentSessionKey)) return "parent-owned-background";
	return "interactive";
}
function isParentOwnedBackgroundAcpSession(entry) {
	return resolveAcpSessionInteractionMode(entry) === "parent-owned-background";
}
/**
* Returns true when `entry` is a parent-owned background ACP session AND the
* given `requesterSessionKey` is the session that spawned/owns it. This is a
* strictly narrower check than {@link isParentOwnedBackgroundAcpSession}: the
* target must match *and* the caller must be the parent.
*
* Used to gate behaviors that only make sense for the parent↔own-child pair
* (e.g. skipping the A2A ping-pong flow in `sessions_send`), so that an
* unrelated session with broad visibility (e.g. `tools.sessions.visibility=all`)
* sending to the same target is still routed through the normal A2A path.
*/
function isRequesterParentOfBackgroundAcpSession(entry, requesterSessionKey) {
	if (!isParentOwnedBackgroundAcpSession(entry)) return false;
	const requester = normalizeOptionalString(requesterSessionKey);
	if (!requester) return false;
	const spawnedBy = normalizeOptionalString(entry?.spawnedBy);
	const parentSessionKey = normalizeOptionalString(entry?.parentSessionKey);
	return requester === spawnedBy || requester === parentSessionKey;
}
//#endregion
//#region src/infra/embedded-mode.ts
let embeddedModeValue = false;
function setEmbeddedMode(value) {
	embeddedModeValue = value;
}
function isEmbeddedMode() {
	return embeddedModeValue;
}
//#endregion
//#region src/agents/execution-contract.ts
/**
* Strip any leading `provider/` or `provider:` prefix from a model id so the
* bare-name regex matching below works against `openai/gpt-5.4` and
* `openai:gpt-5.4` the same way it does against `gpt-5.4`. Returns the bare
* model id lowercased for comparison.
*
* Without this, auto-activation silently failed on prefixed model ids — a
* user who configured `model: "openai/gpt-5.4"` in their agent config would
* get the pre-PR-H looser default behavior because the regex only matched
* bare names. The adversarial review in #64227 flagged this as a quality
* gap on completion-gate criterion 1.
*/
function stripProviderPrefix(modelId) {
	const normalizedModelId = modelId.trim();
	return (/^([^/:]+)[/:](.+)$/.exec(normalizedModelId)?.[2] ?? normalizedModelId).toLowerCase();
}
/**
* Regex that matches the full set of GPT-5 variants the strict-agentic
* contract should auto-activate for. Intentionally permissive: every
* model id in the gpt-5 family should opt in by default, not just the
* canonical `gpt-5.4`.
*
* Covers:
* - `gpt-5`, `gpt-5o`, `gpt-5o-mini` (no separator after `5`)
* - `gpt-5.4`, `gpt-5.4-alt`, `gpt-5.0` (dot separator)
* - `gpt-5-preview`, `gpt-5-turbo`, `gpt-5-2025-03` (dash separator)
*
* Does NOT cover `gpt-4.5`, `gpt-6`, or any non-gpt-5 family member.
*/
const STRICT_AGENTIC_MODEL_ID_PATTERN = /^gpt-5(?:[.o-]|$)/i;
/**
* Supported provider + model combinations where strict-agentic is the intended
* runtime contract. Kept as a narrow helper so both the execution-contract
* resolver and the `update_plan` auto-enable gate converge on the same
* definition of "GPT-5-family openai/openai-codex run". The embedded
* `mock-openai` QA lane intentionally piggybacks on that contract so repo QA
* can exercise the same incomplete-turn recovery rules end to end.
*/
function isStrictAgenticSupportedProviderModel(params) {
	const provider = normalizeLowercaseStringOrEmpty(params.provider ?? "");
	if (provider !== "openai" && provider !== "openai-codex" && provider !== "mock-openai") return false;
	const bareModelId = stripProviderPrefix(typeof params.modelId === "string" ? params.modelId : "");
	return STRICT_AGENTIC_MODEL_ID_PATTERN.test(bareModelId);
}
/**
* Returns the effective execution contract for an embedded Pi run.
*
* strict-agentic is a GPT-5-family openai/openai-codex-only runtime contract,
* so an unsupported provider/model pair always collapses to `"default"`
* regardless of what the caller passed or what config says — the contract
* is inert off-provider. Within the supported lane, the behavior matrix is:
*
* - Supported provider/model + explicit `"strict-agentic"` in config
*   (defaults or per-agent override) ⇒ `"strict-agentic"`.
* - Supported provider/model + explicit `"default"` in config ⇒ `"default"`
*   (opt-out honored).
* - Supported provider/model + unspecified ⇒ `"strict-agentic"` so the
*   no-stall completion-gate criterion applies to out-of-the-box GPT-5 runs
*   without requiring every user to set the flag.
* - Unsupported provider/model (anything that is not openai or openai-codex
*   with a gpt-5-family model id) ⇒ `"default"`, even when the config
*   explicitly sets `"strict-agentic"`. The retry guard and blocked-exit
*   helpers all check this lane again, so an explicit `"strict-agentic"`
*   on an unsupported lane is a no-op rather than a hard failure.
*
* This means explicit opt-out still works, but the gate criterion
* "GPT-5.4 no longer stalls after planning" now covers unconfigured
* installations, not only users who opted in manually.
*/
function resolveEffectiveExecutionContract(params) {
	const { sessionAgentId } = resolveSessionAgentIds({
		sessionKey: params.sessionKey,
		config: params.config,
		agentId: params.agentId ?? void 0
	});
	const explicit = resolveAgentExecutionContract(params.config, sessionAgentId);
	if (!isStrictAgenticSupportedProviderModel({
		provider: params.provider,
		modelId: params.modelId
	})) return "default";
	if (explicit === "default") return "default";
	return "strict-agentic";
}
function isStrictAgenticExecutionContractActive(params) {
	return resolveEffectiveExecutionContract(params) === "strict-agentic";
}
//#endregion
//#region src/agents/openclaw-tools.plugin-context.ts
function resolveOpenClawPluginToolInputs(params) {
	const { options, resolvedConfig, runtimeConfig, getRuntimeConfig } = params;
	const { sessionAgentId } = resolveSessionAgentIds({
		sessionKey: options?.agentSessionKey,
		config: resolvedConfig,
		agentId: options?.requesterAgentIdOverride
	});
	const inferredWorkspaceDir = options?.workspaceDir || !resolvedConfig ? void 0 : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
	const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
	const modelProvider = options?.modelProvider?.trim();
	const modelId = options?.modelId?.trim();
	const activeModel = modelProvider || modelId ? {
		...modelProvider ? { provider: modelProvider } : {},
		...modelId ? { modelId } : {},
		...modelProvider && modelId ? { modelRef: modelKey(modelProvider, modelId) } : {}
	} : void 0;
	const deliveryContext = normalizeDeliveryContext({
		channel: options?.agentChannel,
		to: options?.agentTo,
		accountId: options?.agentAccountId,
		threadId: options?.agentThreadId
	});
	return {
		context: {
			config: options?.config,
			runtimeConfig,
			getRuntimeConfig,
			fsPolicy: options?.fsPolicy,
			workspaceDir,
			agentDir: options?.agentDir,
			agentId: sessionAgentId,
			sessionKey: options?.agentSessionKey,
			sessionId: options?.sessionId,
			activeModel,
			browser: {
				sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
				allowHostControl: options?.allowHostBrowserControl
			},
			messageChannel: options?.agentChannel,
			agentAccountId: options?.agentAccountId,
			deliveryContext,
			requesterSenderId: options?.requesterSenderId ?? void 0,
			sandboxed: options?.sandboxed
		},
		allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding
	};
}
//#endregion
//#region src/agents/plugin-tool-delivery-defaults.ts
function applyPluginToolDeliveryDefaults(params) {
	params.deliveryContext;
	return params.tools;
}
//#endregion
//#region src/agents/openclaw-plugin-tools.ts
function resolveApplicablePluginRuntimeConfig(inputConfig) {
	const runtimeConfig = getRuntimeConfigSnapshot() ?? void 0;
	if (!runtimeConfig) return inputConfig;
	if (!inputConfig || inputConfig === runtimeConfig) return runtimeConfig;
	const runtimeSourceConfig = getRuntimeConfigSourceSnapshot() ?? void 0;
	if (!runtimeSourceConfig) return inputConfig;
	return selectApplicableRuntimeConfig({
		inputConfig,
		runtimeConfig,
		runtimeSourceConfig
	});
}
function resolveOpenClawPluginToolsForOptions(params) {
	if (params.options?.disablePluginTools) return [];
	const deliveryContext = normalizeDeliveryContext({
		channel: params.options?.agentChannel,
		to: params.options?.agentTo,
		accountId: params.options?.agentAccountId,
		threadId: params.options?.agentThreadId
	});
	const resolveCurrentRuntimeConfig = () => {
		return resolveApplicablePluginRuntimeConfig(params.resolvedConfig ?? params.options?.config);
	};
	const authProfileStore = params.options?.authProfileStore;
	const resolveAuthProfileIdsForProvider = authProfileStore ? (providerId) => resolveAuthProfileOrder({
		cfg: resolveCurrentRuntimeConfig(),
		store: authProfileStore,
		provider: providerId
	}) : void 0;
	const hasAuthForProvider = authProfileStore ? (providerId) => (resolveAuthProfileIdsForProvider?.(providerId) ?? []).length > 0 : void 0;
	const resolveApiKeyForProvider = authProfileStore ? async (providerId) => {
		for (const profileId of resolveAuthProfileIdsForProvider?.(providerId) ?? []) {
			const resolved = await resolveApiKeyForProfile({
				cfg: resolveCurrentRuntimeConfig(),
				store: authProfileStore,
				profileId,
				agentDir: params.options?.agentDir
			});
			if (resolved?.apiKey) return resolved.apiKey;
		}
	} : void 0;
	const pluginToolInputs = resolveOpenClawPluginToolInputs({
		options: params.options,
		resolvedConfig: params.resolvedConfig,
		runtimeConfig: resolveCurrentRuntimeConfig(),
		getRuntimeConfig: resolveCurrentRuntimeConfig
	});
	return applyPluginToolDeliveryDefaults({
		tools: resolvePluginTools({
			...pluginToolInputs,
			context: {
				...pluginToolInputs.context,
				...hasAuthForProvider ? { hasAuthForProvider } : {},
				...resolveApiKeyForProvider ? { resolveApiKeyForProvider } : {}
			},
			existingToolNames: params.existingToolNames ?? /* @__PURE__ */ new Set(),
			toolAllowlist: params.options?.pluginToolAllowlist,
			toolDenylist: params.options?.pluginToolDenylist,
			allowGatewaySubagentBinding: params.options?.allowGatewaySubagentBinding,
			...hasAuthForProvider ? { hasAuthForProvider } : {}
		}),
		deliveryContext
	});
}
//#endregion
//#region src/agents/tools/manifest-capability-availability.ts
function metadataKeyForCapabilityContract(key) {
	switch (key) {
		case "imageGenerationProviders": return "imageGenerationProviderMetadata";
		case "videoGenerationProviders": return "videoGenerationProviderMetadata";
		case "musicGenerationProviders": return "musicGenerationProviderMetadata";
		case "mediaUnderstandingProviders": return;
	}
}
function listCapabilityAuthSignals(params) {
	const metadataKey = metadataKeyForCapabilityContract(params.key);
	const metadata = metadataKey ? params.plugin[metadataKey]?.[params.providerId] : void 0;
	if (metadata?.authSignals?.length) return metadata.authSignals;
	return [
		params.providerId,
		...metadata?.aliases ?? [],
		...metadata?.authProviders ?? []
	].map((provider) => ({ provider }));
}
function getCurrentCapabilityMetadataSnapshot(params) {
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
	return getCurrentPluginMetadataSnapshot({
		config: params.config,
		...workspaceDir ? { workspaceDir } : {}
	});
}
function loadCapabilityMetadataSnapshot(params) {
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
	const current = getCurrentPluginMetadataSnapshot({
		config: params.config,
		...workspaceDir ? { workspaceDir } : {}
	});
	if (current) return current;
	return workspaceDir ? loadManifestContractSnapshot({
		config: params.config,
		env: params.env,
		workspaceDir
	}) : loadPluginMetadataSnapshot({
		config: params.config ?? {},
		env: params.env ?? process.env
	});
}
function hasSnapshotCapabilityAvailability(params) {
	if (params.config?.plugins?.enabled === false) return false;
	for (const plugin of params.snapshot.plugins) {
		if (!isManifestPluginAvailableForControlPlane({
			snapshot: params.snapshot,
			plugin,
			config: params.config
		})) continue;
		const metadataKey = metadataKeyForCapabilityContract(params.key);
		for (const providerId of plugin.contracts?.[params.key] ?? []) {
			if ((metadataKey ? plugin[metadataKey]?.[providerId] : void 0)?.configSignals?.some((signal) => manifestConfigSignalPasses({
				config: params.config,
				env: process.env,
				signal
			}))) return true;
			for (const signal of listCapabilityAuthSignals({
				plugin,
				key: params.key,
				providerId
			})) {
				if (!manifestProviderBaseUrlGuardPasses({
					config: params.config,
					guard: signal.providerBaseUrl
				})) continue;
				if (params.authStore && listProfilesForProvider(params.authStore, signal.provider).length > 0) return true;
				if (hasNonEmptyManifestEnvCandidate(process.env, manifestPluginSetupProviderEnvVars(plugin, signal.provider))) return true;
			}
		}
	}
	return false;
}
function hasSnapshotProviderEnvAvailability(params) {
	if (params.config?.plugins?.enabled === false) return false;
	for (const plugin of params.snapshot.plugins) {
		if (!isManifestPluginAvailableForControlPlane({
			snapshot: params.snapshot,
			plugin,
			config: params.config
		})) continue;
		if (hasNonEmptyManifestEnvCandidate(process.env, manifestPluginSetupProviderEnvVars(plugin, params.providerId))) return true;
	}
	return false;
}
function hasSnapshotCapabilityProviderAvailability(params) {
	if (params.config?.plugins?.enabled === false) return false;
	for (const plugin of params.snapshot.plugins) {
		if (!isManifestPluginAvailableForControlPlane({
			snapshot: params.snapshot,
			plugin,
			config: params.config
		})) continue;
		if (!plugin.contracts?.[params.key]?.includes(params.providerId)) continue;
		const metadataKey = metadataKeyForCapabilityContract(params.key);
		if ((metadataKey ? plugin[metadataKey]?.[params.providerId] : void 0)?.configSignals?.some((signal) => manifestConfigSignalPasses({
			config: params.config,
			env: process.env,
			signal
		}))) return true;
		for (const signal of listCapabilityAuthSignals({
			plugin,
			key: params.key,
			providerId: params.providerId
		})) {
			if (!manifestProviderBaseUrlGuardPasses({
				config: params.config,
				guard: signal.providerBaseUrl
			})) continue;
			if (params.authStore && listProfilesForProvider(params.authStore, signal.provider).length > 0) return true;
			if (hasNonEmptyManifestEnvCandidate(process.env, manifestPluginSetupProviderEnvVars(plugin, signal.provider))) return true;
		}
	}
	return false;
}
//#endregion
//#region src/agents/openclaw-tools.media-factory-plan.ts
function coerceFactoryToolModelConfig(model) {
	const primary = resolveAgentModelPrimaryValue(model);
	const fallbacks = resolveAgentModelFallbackValues(model);
	return {
		...primary?.trim() ? { primary: primary.trim() } : {},
		...fallbacks.length > 0 ? { fallbacks } : {}
	};
}
function hasToolModelConfig(model) {
	return Boolean(model?.primary?.trim() || (model?.fallbacks ?? []).some((entry) => entry.trim().length > 0));
}
function hasExplicitToolModelConfig(modelConfig) {
	return hasToolModelConfig(coerceFactoryToolModelConfig(modelConfig));
}
function hasExplicitImageModelConfig(config) {
	return hasExplicitToolModelConfig(config?.agents?.defaults?.imageModel);
}
function hasExplicitPdfModelConfig(config) {
	return hasExplicitToolModelConfig(config?.agents?.defaults?.pdfModel) || hasExplicitImageModelConfig(config);
}
function isToolAllowedByFactoryPolicy(params) {
	return isToolAllowedByPolicyName(params.toolName, {
		allow: params.allowlist,
		deny: params.denylist
	});
}
function isToolExplicitlyAllowedByFactoryPolicy(params) {
	if (!params.allowlist?.some((entry) => typeof entry === "string" && entry.trim().length > 0)) return false;
	return isToolAllowedByFactoryPolicy(params);
}
function mergeFactoryPolicyList(...lists) {
	const merged = lists.flatMap((list) => Array.isArray(list) ? list : []);
	return merged.length > 0 ? Array.from(new Set(merged)) : void 0;
}
function mergeBuiltInFactoryAllowlist(...lists) {
	const allowlist = mergeFactoryPolicyList(...lists);
	if (!allowlist?.some((entry) => typeof entry === "string" && entry.trim() === "__openclaw_default_plugin_tools__")) return allowlist;
	const withoutDefaultPluginMarker = allowlist.filter((entry) => typeof entry !== "string" || entry.trim() !== "__openclaw_default_plugin_tools__");
	return Array.from(new Set(["*", ...withoutDefaultPluginMarker]));
}
function resolveImageToolFactoryAvailable(params) {
	if (!params.agentDir?.trim()) return false;
	if (params.modelHasVision || hasExplicitImageModelConfig(params.config)) return true;
	const snapshot = loadCapabilityMetadataSnapshot({
		config: params.config,
		...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
	});
	return hasSnapshotCapabilityAvailability({
		snapshot,
		authStore: params.authStore,
		key: "mediaUnderstandingProviders",
		config: params.config
	}) || hasConfiguredVisionModelAuthSignal({
		config: params.config,
		snapshot,
		authStore: params.authStore
	});
}
function hasConfiguredVisionModelAuthSignal(params) {
	const providers = params.config?.models?.providers;
	if (!providers || typeof providers !== "object") return false;
	for (const [providerId, providerConfig] of Object.entries(providers)) {
		if (!providerConfig?.models?.some((model) => Array.isArray(model?.input) && model.input.includes("image"))) continue;
		if (params.authStore && listProfilesForProvider(params.authStore, providerId).length > 0) return true;
		if (hasSnapshotProviderEnvAvailability({
			snapshot: params.snapshot,
			providerId,
			config: params.config
		})) return true;
	}
	return false;
}
function resolveOptionalMediaToolFactoryPlan(params) {
	const defaults = params.config?.agents?.defaults;
	const toolAllowlist = mergeBuiltInFactoryAllowlist(params.config?.tools?.allow, params.toolAllowlist);
	const toolDenylist = mergeFactoryPolicyList(params.config?.tools?.deny, params.toolDenylist);
	const allowImageGenerate = isToolAllowedByFactoryPolicy({
		toolName: "image_generate",
		allowlist: toolAllowlist,
		denylist: toolDenylist
	});
	const allowVideoGenerate = isToolAllowedByFactoryPolicy({
		toolName: "video_generate",
		allowlist: toolAllowlist,
		denylist: toolDenylist
	});
	const allowMusicGenerate = isToolAllowedByFactoryPolicy({
		toolName: "music_generate",
		allowlist: toolAllowlist,
		denylist: toolDenylist
	});
	const allowPdf = isToolAllowedByFactoryPolicy({
		toolName: "pdf",
		allowlist: toolAllowlist,
		denylist: toolDenylist
	});
	const explicitImageGeneration = hasExplicitToolModelConfig(defaults?.imageGenerationModel);
	const explicitVideoGeneration = hasExplicitToolModelConfig(defaults?.videoGenerationModel);
	const explicitMusicGeneration = hasExplicitToolModelConfig(defaults?.musicGenerationModel);
	const explicitPdf = hasExplicitPdfModelConfig(params.config);
	if (params.config?.plugins?.enabled === false) return {
		imageGenerate: false,
		videoGenerate: false,
		musicGenerate: false,
		pdf: false
	};
	const snapshot = loadCapabilityMetadataSnapshot({
		config: params.config,
		...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
	});
	return {
		imageGenerate: allowImageGenerate && (explicitImageGeneration || hasSnapshotCapabilityAvailability({
			snapshot,
			authStore: params.authStore,
			key: "imageGenerationProviders",
			config: params.config
		})),
		videoGenerate: allowVideoGenerate && (explicitVideoGeneration || hasSnapshotCapabilityAvailability({
			snapshot,
			authStore: params.authStore,
			key: "videoGenerationProviders",
			config: params.config
		})),
		musicGenerate: allowMusicGenerate && (explicitMusicGeneration || hasSnapshotCapabilityAvailability({
			snapshot,
			authStore: params.authStore,
			key: "musicGenerationProviders",
			config: params.config
		})),
		pdf: allowPdf && (explicitPdf || hasSnapshotCapabilityAvailability({
			snapshot,
			authStore: params.authStore,
			key: "mediaUnderstandingProviders",
			config: params.config
		}) || hasConfiguredVisionModelAuthSignal({
			config: params.config,
			snapshot,
			authStore: params.authStore
		}))
	};
}
//#endregion
//#region src/media/sniff-mime-from-base64.ts
async function sniffMimeFromBase64(base64) {
	const trimmed = base64.trim();
	const canonicalBase64 = trimmed ? canonicalizeBase64(trimmed) : void 0;
	if (!canonicalBase64) return;
	const take = Math.min(256, canonicalBase64.length);
	const sliceLen = take - take % 4;
	if (sliceLen < 8) return;
	try {
		return await detectMime({ buffer: Buffer.from(canonicalBase64.slice(0, sliceLen), "base64") });
	} catch {
		return;
	}
}
//#endregion
//#region src/agents/pi-tools.params.ts
const RETRY_GUIDANCE_SUFFIX = " Supply correct parameters before retrying.";
function parameterValidationError(message) {
	return /* @__PURE__ */ new Error(`${message}.${RETRY_GUIDANCE_SUFFIX}`);
}
function describeReceivedParamValue(value, allowEmpty = false) {
	if (value === void 0 || value === null) return;
	if (typeof value === "string") {
		if (allowEmpty || value.trim().length > 0) return;
		return "<empty-string>";
	}
	if (Array.isArray(value)) return "<array>";
	return `<${typeof value}>`;
}
function formatReceivedParamHint(record, groups) {
	const allowEmptyKeys = /* @__PURE__ */ new Set();
	for (const group of groups) if (group.allowEmpty) for (const key of group.keys) allowEmptyKeys.add(key);
	const received = [];
	for (const key of Object.keys(record)) {
		const detail = describeReceivedParamValue(record[key], allowEmptyKeys.has(key));
		if (record[key] === void 0 || record[key] === null) continue;
		received.push(detail ? `${key}=${detail}` : key);
	}
	return received.length > 0 ? ` (received: ${received.join(", ")})` : "";
}
function isValidEditReplacement(value) {
	if (!value || typeof value !== "object") return false;
	const record = value;
	return typeof record.oldText === "string" && record.oldText.trim().length > 0 && typeof record.newText === "string";
}
function hasValidEditReplacements(record) {
	const edits = record.edits;
	return Array.isArray(edits) && edits.length > 0 && edits.every((entry) => isValidEditReplacement(entry));
}
const REQUIRED_PARAM_GROUPS = {
	read: [{
		keys: ["path"],
		label: "path"
	}],
	write: [{
		keys: ["path"],
		label: "path"
	}, {
		keys: ["content"],
		label: "content"
	}],
	edit: [{
		keys: ["path"],
		label: "path"
	}, {
		keys: ["edits"],
		label: "edits",
		validator: hasValidEditReplacements
	}]
};
function getToolParamsRecord(params) {
	return params && typeof params === "object" ? params : void 0;
}
function assertRequiredParams(record, groups, toolName) {
	if (!record || typeof record !== "object") throw parameterValidationError(`Missing parameters for ${toolName}`);
	const missingLabels = [];
	for (const group of groups) if (!(group.validator?.(record) ?? group.keys.some((key) => {
		if (!(key in record)) return false;
		const value = record[key];
		if (typeof value !== "string") return false;
		if (group.allowEmpty) return true;
		return value.trim().length > 0;
	}))) {
		const label = group.label ?? group.keys.join(" or ");
		missingLabels.push(label);
	}
	if (missingLabels.length > 0) {
		const joined = missingLabels.join(", ");
		throw parameterValidationError(`Missing required ${missingLabels.length === 1 ? "parameter" : "parameters"}: ${joined}${formatReceivedParamHint(record, groups)}`);
	}
}
function wrapToolParamValidation(tool, requiredParamGroups) {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const record = getToolParamsRecord(params);
			if (requiredParamGroups?.length) assertRequiredParams(record, requiredParamGroups, tool.name);
			return tool.execute(toolCallId, params, signal, onUpdate);
		}
	};
}
//#endregion
//#region src/agents/pi-tools.host-edit.ts
const EDIT_MISMATCH_MESSAGE = "Could not find the exact text in";
const EDIT_MISMATCH_HINT_LIMIT = 800;
function resolveEditPath(root, pathParam) {
	const home = resolveOsHomeDir();
	const expanded = home ? expandHomePrefix(pathParam, { home }) : pathParam;
	return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}
function readStringParam(record, ...keys) {
	for (const key of keys) {
		const value = record?.[key];
		if (typeof value === "string") return value;
	}
}
function readEditReplacements(record) {
	if (!Array.isArray(record?.edits)) return [];
	return record.edits.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const replacement = entry;
		if (typeof replacement.oldText !== "string" || replacement.oldText.trim().length === 0) return [];
		if (typeof replacement.newText !== "string") return [];
		return [{
			oldText: replacement.oldText,
			newText: replacement.newText
		}];
	});
}
function readEditToolParams(params) {
	const record = getToolParamsRecord(params);
	return {
		pathParam: readStringParam(record, "path", "file_path", "filePath", "filepath", "file"),
		edits: readEditReplacements(record)
	};
}
function normalizeToLF(value) {
	return value.replace(/\r\n?/g, "\n");
}
function removeExactOccurrences(content, needle) {
	return needle.length > 0 ? content.split(needle).join("") : content;
}
function didEditLikelyApply(params) {
	if (params.edits.length === 0) return false;
	const normalizedCurrent = normalizeToLF(params.currentContent);
	const normalizedOriginal = typeof params.originalContent === "string" ? normalizeToLF(params.originalContent) : void 0;
	if (normalizedOriginal !== void 0 && normalizedOriginal === normalizedCurrent) return false;
	let withoutInsertedNewText = normalizedCurrent;
	for (const edit of params.edits) {
		const normalizedNew = normalizeToLF(edit.newText);
		if (normalizedNew.length > 0 && !normalizedCurrent.includes(normalizedNew)) return false;
		withoutInsertedNewText = normalizedNew.length > 0 ? removeExactOccurrences(withoutInsertedNewText, normalizedNew) : withoutInsertedNewText;
	}
	for (const edit of params.edits) {
		const normalizedOld = normalizeToLF(edit.oldText);
		if (withoutInsertedNewText.includes(normalizedOld)) return false;
	}
	return true;
}
function buildEditSuccessResult(pathParam, editCount) {
	return {
		isError: false,
		content: [{
			type: "text",
			text: editCount > 1 ? `Successfully replaced ${editCount} block(s) in ${pathParam}.` : `Successfully replaced text in ${pathParam}.`
		}],
		details: {
			diff: "",
			firstChangedLine: void 0
		}
	};
}
function shouldAddMismatchHint(error) {
	return error instanceof Error && error.message.includes(EDIT_MISMATCH_MESSAGE);
}
function appendMismatchHint(error, currentContent) {
	const snippet = currentContent.length <= EDIT_MISMATCH_HINT_LIMIT ? currentContent : `${currentContent.slice(0, EDIT_MISMATCH_HINT_LIMIT)}\n... (truncated)`;
	const enhanced = /* @__PURE__ */ new Error(`${error.message}\nCurrent file contents:\n${snippet}`);
	enhanced.stack = error.stack;
	return enhanced;
}
/**
* Recover from two edit-tool failure classes without changing edit semantics:
* - exact-match mismatch errors become actionable by including current file contents
* - post-write throws are converted back to success only if the file actually changed
*/
function wrapEditToolWithRecovery(base, options) {
	return {
		...base,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const { pathParam, edits } = readEditToolParams(params);
			const absolutePath = typeof pathParam === "string" ? resolveEditPath(options.root, pathParam) : void 0;
			let originalContent;
			if (absolutePath && edits.length > 0) try {
				originalContent = await options.readFile(absolutePath);
			} catch {}
			try {
				return await base.execute(toolCallId, params, signal, onUpdate);
			} catch (err) {
				if (!absolutePath) throw err;
				let currentContent;
				try {
					currentContent = await options.readFile(absolutePath);
				} catch {}
				if (typeof currentContent === "string" && edits.length > 0) {
					if (didEditLikelyApply({
						originalContent,
						currentContent,
						edits
					})) return buildEditSuccessResult(pathParam ?? absolutePath, edits.length);
				}
				if (typeof currentContent === "string" && err instanceof Error && shouldAddMismatchHint(err)) throw appendMismatchHint(err, currentContent);
				throw err;
			}
		}
	};
}
//#endregion
//#region src/agents/pi-tools.read.ts
const DEFAULT_READ_PAGE_MAX_BYTES = 32 * 1024;
const MAX_ADAPTIVE_READ_MAX_BYTES = 128 * 1024;
const ADAPTIVE_READ_CONTEXT_SHARE = .1;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_ADAPTIVE_READ_PAGES = 4;
const OFFSET_BEYOND_EOF_RE = /^Offset \d+ is beyond end of file \(\d+ lines total\)$/;
const READ_CONTINUATION_NOTICE_RE = /\n\n\[(?:Showing lines [^\]]*?Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\]\s*$/;
function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}
function resolveAdaptiveReadMaxBytes(options) {
	const contextWindowTokens = options?.modelContextWindowTokens;
	if (typeof contextWindowTokens !== "number" || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return DEFAULT_READ_PAGE_MAX_BYTES;
	return clamp(Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * ADAPTIVE_READ_CONTEXT_SHARE), DEFAULT_READ_PAGE_MAX_BYTES, MAX_ADAPTIVE_READ_MAX_BYTES);
}
function formatBytes(bytes) {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${bytes}B`;
}
function getToolResultText(result) {
	const textBlocks = (Array.isArray(result.content) ? result.content : []).map((block) => {
		if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") return block.text;
	}).filter((value) => typeof value === "string");
	if (textBlocks.length === 0) return;
	return textBlocks.join("\n");
}
function withToolResultText(result, text) {
	const content = Array.isArray(result.content) ? result.content : [];
	let replaced = false;
	const nextContent = content.map((block) => {
		if (!replaced && block && typeof block === "object" && block.type === "text") {
			replaced = true;
			return Object.assign({}, block, { text });
		}
		return block;
	});
	if (replaced) return {
		...result,
		content: nextContent
	};
	const textBlock = {
		type: "text",
		text
	};
	return {
		...result,
		content: [textBlock]
	};
}
function extractReadTruncationDetails(result) {
	const details = result.details;
	if (!details || typeof details !== "object") return null;
	const truncation = details.truncation;
	if (!truncation || typeof truncation !== "object") return null;
	const record = truncation;
	if (record.truncated !== true) return null;
	const outputLinesRaw = record.outputLines;
	return {
		truncated: true,
		outputLines: typeof outputLinesRaw === "number" && Number.isFinite(outputLinesRaw) ? Math.max(0, Math.floor(outputLinesRaw)) : 0,
		firstLineExceedsLimit: record.firstLineExceedsLimit === true
	};
}
function stripReadContinuationNotice(text) {
	return text.replace(READ_CONTINUATION_NOTICE_RE, "");
}
function stripReadTruncationContentDetails(result) {
	const details = result.details;
	if (!details || typeof details !== "object") return result;
	const detailsRecord = details;
	const truncationRaw = detailsRecord.truncation;
	if (!truncationRaw || typeof truncationRaw !== "object") return result;
	const truncation = truncationRaw;
	if (!Object.prototype.hasOwnProperty.call(truncation, "content")) return result;
	const { content: _content, ...restTruncation } = truncation;
	return {
		...result,
		details: {
			...detailsRecord,
			truncation: restTruncation
		}
	};
}
function isOffsetBeyondEof(error, args) {
	const offset = args.offset;
	return typeof offset === "number" && Number.isFinite(offset) && offset > 0 && error instanceof Error && OFFSET_BEYOND_EOF_RE.test(error.message);
}
function emptyReadResult() {
	return {
		content: [{
			type: "text",
			text: ""
		}],
		details: void 0
	};
}
async function executeReadPage(params) {
	try {
		return await params.base.execute(params.toolCallId, params.args, params.signal);
	} catch (error) {
		if (isOffsetBeyondEof(error, params.args)) return emptyReadResult();
		throw error;
	}
}
async function executeReadWithAdaptivePaging(params) {
	const userLimit = params.args.limit;
	if (typeof userLimit === "number" && Number.isFinite(userLimit) && userLimit > 0) return await executeReadPage(params);
	const offsetRaw = params.args.offset;
	let nextOffset = typeof offsetRaw === "number" && Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 1;
	let firstResult = null;
	let aggregatedText = "";
	let aggregatedBytes = 0;
	let capped = false;
	let continuationOffset;
	for (let page = 0; page < MAX_ADAPTIVE_READ_PAGES; page += 1) {
		const pageArgs = {
			...params.args,
			offset: nextOffset
		};
		const pageResult = await executeReadPage({
			base: params.base,
			toolCallId: params.toolCallId,
			args: pageArgs,
			signal: params.signal
		});
		firstResult ??= pageResult;
		const rawText = getToolResultText(pageResult);
		if (typeof rawText !== "string") return pageResult;
		const truncation = extractReadTruncationDetails(pageResult);
		const canContinue = Boolean(truncation?.truncated) && !truncation?.firstLineExceedsLimit && (truncation?.outputLines ?? 0) > 0 && page < MAX_ADAPTIVE_READ_PAGES - 1;
		const pageText = canContinue ? stripReadContinuationNotice(rawText) : rawText;
		const delimiter = aggregatedText && pageText ? "\n\n" : "";
		const nextBytes = Buffer.byteLength(`${delimiter}${pageText}`, "utf-8");
		if (aggregatedText && aggregatedBytes + nextBytes > params.maxBytes) {
			capped = true;
			continuationOffset = nextOffset;
			break;
		}
		aggregatedText += `${delimiter}${pageText}`;
		aggregatedBytes += nextBytes;
		if (!canContinue || !truncation) return withToolResultText(pageResult, aggregatedText);
		nextOffset += truncation.outputLines;
		continuationOffset = nextOffset;
		if (aggregatedBytes >= params.maxBytes) {
			capped = true;
			break;
		}
	}
	if (!firstResult) return await executeReadPage(params);
	let finalText = aggregatedText;
	if (capped && continuationOffset) finalText += `\n\n[Read output capped at ${formatBytes(params.maxBytes)} for this call. Use offset=${continuationOffset} to continue.]`;
	return withToolResultText(firstResult, finalText);
}
function rewriteReadImageHeader(text, mimeType) {
	if (text.startsWith("Read image file [") && text.endsWith("]")) return `Read image file [${mimeType}]`;
	return text;
}
async function normalizeReadImageResult(result, filePath) {
	const content = Array.isArray(result.content) ? result.content : [];
	const image = content.find((b) => !!b && typeof b === "object" && b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string");
	if (!image) return result;
	if (!image.data.trim()) throw new Error(`read: image payload is empty (${filePath})`);
	const sniffed = await sniffMimeFromBase64(image.data);
	if (!sniffed) return result;
	if (!sniffed.startsWith("image/")) throw new Error(`read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`);
	if (sniffed === image.mimeType) return result;
	const nextContent = content.map((block) => {
		if (block && typeof block === "object" && block.type === "image") return Object.assign({}, block, { mimeType: sniffed });
		if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
			const b = block;
			return Object.assign({}, b, { text: rewriteReadImageHeader(b.text, sniffed) });
		}
		return block;
	});
	return {
		...result,
		content: nextContent
	};
}
function wrapToolWorkspaceRootGuard(tool, root) {
	return wrapToolWorkspaceRootGuardWithOptions(tool, root);
}
function mapContainerPathToWorkspaceRoot(params) {
	return mapContainerPathToRoot({
		filePath: params.filePath,
		root: params.root,
		containerRoot: params.containerWorkdir
	}).filePath;
}
function resolveContainerPathCandidate(filePath) {
	let candidate = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	if (/^file:\/\//i.test(candidate)) {
		const localFilePath = trySafeFileURLToPath(candidate);
		if (localFilePath) candidate = localFilePath;
		else {
			let parsed;
			try {
				parsed = new URL$1(candidate);
			} catch {
				return filePath;
			}
			if (parsed.protocol !== "file:") return filePath;
			const host = parsed.hostname.trim().toLowerCase();
			if (host && host !== "localhost") return filePath;
			if (hasEncodedFileUrlSeparator(parsed.pathname)) return filePath;
			let normalizedPathname;
			try {
				normalizedPathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
			} catch {
				return filePath;
			}
			candidate = normalizedPathname;
		}
	}
	return candidate;
}
function mapContainerPathToRoot(params) {
	const containerRoot = params.containerRoot?.trim();
	if (!containerRoot) return {
		filePath: params.filePath,
		matched: false
	};
	const normalizedRoot = containerRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!normalizedRoot.startsWith("/") || !normalizedRoot) return {
		filePath: params.filePath,
		matched: false
	};
	const candidate = resolveContainerPathCandidate(params.filePath);
	if (candidate === null) return {
		filePath: params.filePath,
		matched: false
	};
	const normalizedCandidate = candidate.replace(/\\/g, "/");
	if (normalizedCandidate === normalizedRoot) return {
		filePath: path.resolve(params.root),
		matched: true
	};
	const prefix = `${normalizedRoot}/`;
	if (!normalizedCandidate.startsWith(prefix)) return {
		filePath: candidate,
		matched: false
	};
	const relative = normalizedCandidate.slice(prefix.length);
	if (!relative) return {
		filePath: path.resolve(params.root),
		matched: true
	};
	return {
		filePath: path.resolve(params.root, ...relative.split("/").filter(Boolean)),
		matched: true
	};
}
function resolveToolPathAgainstWorkspaceRoot(params) {
	const mapped = mapContainerPathToWorkspaceRoot(params);
	const candidate = mapped.startsWith("@") ? mapped.slice(1) : mapped;
	if (isWindowsDrivePath(candidate)) return path.win32.normalize(candidate);
	if (path.isAbsolute(candidate)) return path.resolve(candidate);
	return path.resolve(params.root, candidate || ".");
}
async function readOptionalUtf8File(params) {
	try {
		if (params.sandbox) {
			if (!await params.sandbox.bridge.stat({
				filePath: params.relativePath,
				cwd: params.sandbox.root,
				signal: params.signal
			})) return "";
			return (await params.sandbox.bridge.readFile({
				filePath: params.relativePath,
				cwd: params.sandbox.root,
				signal: params.signal
			})).toString("utf-8");
		}
		return await fs.readFile(params.absolutePath, "utf-8");
	} catch (error) {
		if (error?.code === "ENOENT") return "";
		throw error;
	}
}
async function appendMemoryFlushContent(params) {
	if (!params.sandbox) {
		await (await root(params.root)).append(params.relativePath, params.content, {
			mkdir: true,
			prependNewlineIfNeeded: true
		});
		return;
	}
	const existing = await readOptionalUtf8File({
		absolutePath: params.absolutePath,
		relativePath: params.relativePath,
		sandbox: params.sandbox,
		signal: params.signal
	});
	const next = `${existing}${existing.length > 0 && !existing.endsWith("\n") && !params.content.startsWith("\n") ? "\n" : ""}${params.content}`;
	if (params.sandbox) {
		const parent = path.posix.dirname(params.relativePath);
		if (parent && parent !== ".") await params.sandbox.bridge.mkdirp({
			filePath: parent,
			cwd: params.sandbox.root,
			signal: params.signal
		});
		await params.sandbox.bridge.writeFile({
			filePath: params.relativePath,
			cwd: params.sandbox.root,
			data: next,
			mkdir: true,
			signal: params.signal
		});
		return;
	}
	await fs.mkdir(path.dirname(params.absolutePath), { recursive: true });
	await fs.writeFile(params.absolutePath, next, "utf-8");
}
function wrapToolMemoryFlushAppendOnlyWrite(tool, options) {
	const allowedAbsolutePath = path.resolve(options.root, options.relativePath);
	return {
		...tool,
		description: `${tool.description} During memory flush, this tool may only append to ${options.relativePath}.`,
		execute: async (toolCallId, args, signal, onUpdate) => {
			const record = getToolParamsRecord(args);
			assertRequiredParams(record, REQUIRED_PARAM_GROUPS.write, tool.name);
			const filePath = typeof record?.path === "string" && record.path.trim() ? record.path : void 0;
			const content = typeof record?.content === "string" ? record.content : void 0;
			if (!filePath || content === void 0) return tool.execute(toolCallId, args, signal, onUpdate);
			if (resolveToolPathAgainstWorkspaceRoot({
				filePath,
				root: options.root,
				containerWorkdir: options.containerWorkdir
			}) !== allowedAbsolutePath) throw new Error(`Memory flush writes are restricted to ${options.relativePath}; use that path only.`);
			await appendMemoryFlushContent({
				absolutePath: allowedAbsolutePath,
				root: options.root,
				relativePath: options.relativePath,
				content,
				sandbox: options.sandbox,
				signal
			});
			return {
				content: [{
					type: "text",
					text: `Appended content to ${options.relativePath}.`
				}],
				details: {
					path: options.relativePath,
					appendOnly: true
				}
			};
		}
	};
}
function isSandboxRootEscapeError(error) {
	return error instanceof Error && /^Path escapes sandbox root \(/i.test(error.message);
}
async function assertSandboxPathWithinAnyRoot(params) {
	let firstRootEscapeError;
	const seen = /* @__PURE__ */ new Set();
	for (const candidateRoot of params.roots) {
		const trimmedRoot = candidateRoot.trim();
		if (!trimmedRoot) continue;
		const root = path.resolve(trimmedRoot);
		if (seen.has(root)) continue;
		seen.add(root);
		try {
			return await assertSandboxPath({
				filePath: params.filePath,
				cwd: root,
				root
			});
		} catch (error) {
			if (!isSandboxRootEscapeError(error)) throw error;
			firstRootEscapeError ??= error;
		}
	}
	throw firstRootEscapeError ?? /* @__PURE__ */ new Error("Path guard has no configured roots.");
}
function wrapToolWorkspaceRootGuardWithOptions(tool, root, options) {
	const pathParamKeys = options?.pathParamKeys && options.pathParamKeys.length > 0 ? options.pathParamKeys : ["path"];
	return {
		...tool,
		execute: async (toolCallId, args, signal, onUpdate) => {
			const record = getToolParamsRecord(args);
			let normalizedRecord;
			for (const key of pathParamKeys) {
				const filePath = record?.[key];
				if (typeof filePath !== "string" || !filePath.trim()) continue;
				let guardedRoot = root;
				const workspaceMapping = mapContainerPathToRoot({
					filePath,
					root,
					containerRoot: options?.containerWorkdir
				});
				let sandboxPath = workspaceMapping.filePath;
				if (!workspaceMapping.matched) for (const mount of options?.additionalContainerMounts ?? []) {
					const mountMapping = mapContainerPathToRoot({
						filePath,
						root: mount.hostRoot,
						containerRoot: mount.containerRoot
					});
					if (mountMapping.matched) {
						guardedRoot = path.resolve(mount.hostRoot);
						sandboxPath = mountMapping.filePath;
						break;
					}
				}
				const additionalRoots = guardedRoot === root && !workspaceMapping.matched ? options?.additionalRoots ?? [] : [];
				const sandboxResult = await assertSandboxPathWithinAnyRoot({
					filePath: sandboxPath,
					roots: [guardedRoot, ...additionalRoots]
				});
				if (options?.normalizeGuardedPathParams && record) {
					normalizedRecord ??= { ...record };
					normalizedRecord[key] = sandboxResult.resolved;
				}
			}
			return tool.execute(toolCallId, normalizedRecord ?? args, signal, onUpdate);
		}
	};
}
function createSandboxedReadTool(params) {
	return createOpenClawReadTool(createReadTool(params.root, { operations: createSandboxReadOperations(params) }), {
		modelContextWindowTokens: params.modelContextWindowTokens,
		imageSanitization: params.imageSanitization
	});
}
function createSandboxedWriteTool(params) {
	return wrapToolParamValidation(createWriteTool(params.root, { operations: createSandboxWriteOperations(params) }), REQUIRED_PARAM_GROUPS.write);
}
function createSandboxedEditTool(params) {
	return wrapToolParamValidation(wrapEditToolWithRecovery(createEditTool(params.root, { operations: createSandboxEditOperations(params) }), {
		root: params.root,
		readFile: async (absolutePath) => (await params.bridge.readFile({
			filePath: absolutePath,
			cwd: params.root
		})).toString("utf8")
	}), REQUIRED_PARAM_GROUPS.edit);
}
function createHostWorkspaceWriteTool(root, options) {
	return wrapToolParamValidation(createWriteTool(root, { operations: createHostWriteOperations(root, options) }), REQUIRED_PARAM_GROUPS.write);
}
function createHostWorkspaceEditTool(root, options) {
	return wrapToolParamValidation(wrapEditToolWithRecovery(createEditTool(root, { operations: createHostEditOperations(root, options) }), {
		root,
		readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8")
	}), REQUIRED_PARAM_GROUPS.edit);
}
function createOpenClawReadTool(base, options) {
	return {
		...base,
		execute: async (toolCallId, params, signal) => {
			const record = getToolParamsRecord(params);
			assertRequiredParams(record, REQUIRED_PARAM_GROUPS.read, base.name);
			const result = await executeReadWithAdaptivePaging({
				base,
				toolCallId,
				args: record ?? {},
				signal,
				maxBytes: resolveAdaptiveReadMaxBytes(options)
			});
			const filePath = typeof record?.path === "string" ? record.path : "<unknown>";
			return sanitizeToolResultImages(await normalizeReadImageResult(stripReadTruncationContentDetails(result), filePath), `read:${filePath}`, options?.imageSanitization);
		}
	};
}
function createSandboxReadOperations(params) {
	return {
		readFile: (absolutePath) => params.bridge.readFile({
			filePath: absolutePath,
			cwd: params.root
		}),
		access: async (absolutePath) => {
			if (!await params.bridge.stat({
				filePath: absolutePath,
				cwd: params.root
			})) throw createFsAccessError("ENOENT", absolutePath);
		},
		detectImageMimeType: async (absolutePath) => {
			const mime = await detectMime({
				buffer: await params.bridge.readFile({
					filePath: absolutePath,
					cwd: params.root
				}),
				filePath: absolutePath
			});
			return mime && mime.startsWith("image/") ? mime : void 0;
		}
	};
}
function createSandboxWriteOperations(params) {
	return {
		mkdir: async (dir) => {
			await params.bridge.mkdirp({
				filePath: dir,
				cwd: params.root
			});
		},
		writeFile: async (absolutePath, content) => {
			await params.bridge.writeFile({
				filePath: absolutePath,
				cwd: params.root,
				data: content
			});
		}
	};
}
function createSandboxEditOperations(params) {
	return {
		readFile: (absolutePath) => params.bridge.readFile({
			filePath: absolutePath,
			cwd: params.root
		}),
		writeFile: (absolutePath, content) => params.bridge.writeFile({
			filePath: absolutePath,
			cwd: params.root,
			data: content
		}),
		access: async (absolutePath) => {
			if (!await params.bridge.stat({
				filePath: absolutePath,
				cwd: params.root
			})) throw createFsAccessError("ENOENT", absolutePath);
		}
	};
}
function expandTildeToOsHome(filePath) {
	const home = resolveOsHomeDir();
	return home ? expandHomePrefix(filePath, { home }) : filePath;
}
async function writeHostFile(absolutePath, content) {
	const resolved = path.resolve(expandTildeToOsHome(absolutePath));
	await fs.mkdir(path.dirname(resolved), { recursive: true });
	await fs.writeFile(resolved, content, "utf-8");
}
function createHostWriteOperations(root$1, options) {
	if (!(options?.workspaceOnly ?? false)) return {
		mkdir: async (dir) => {
			const resolved = path.resolve(expandTildeToOsHome(dir));
			await fs.mkdir(resolved, { recursive: true });
		},
		writeFile: writeHostFile
	};
	const rootPromise = root(root$1);
	return {
		mkdir: async (dir) => {
			const relative = toRelativeWorkspacePath(root$1, dir, { allowRoot: true });
			const resolved = relative ? path.resolve(root$1, relative) : path.resolve(root$1);
			await assertSandboxPath({
				filePath: resolved,
				cwd: root$1,
				root: root$1
			});
			await fs.mkdir(resolved, { recursive: true });
		},
		writeFile: async (absolutePath, content) => {
			const relative = toRelativeWorkspacePath(root$1, absolutePath);
			await (await rootPromise).write(relative, content, { mkdir: true });
		}
	};
}
function createHostEditOperations(root$2, options) {
	if (!(options?.workspaceOnly ?? false)) return {
		readFile: async (absolutePath) => {
			const resolved = path.resolve(expandTildeToOsHome(absolutePath));
			return await fs.readFile(resolved);
		},
		writeFile: writeHostFile,
		access: async (absolutePath) => {
			const resolved = path.resolve(expandTildeToOsHome(absolutePath));
			await fs.access(resolved);
		}
	};
	const rootPromise = root(root$2);
	return {
		readFile: async (absolutePath) => {
			const relative = toRelativeWorkspacePath(root$2, absolutePath);
			return (await (await rootPromise).read(relative)).buffer;
		},
		writeFile: async (absolutePath, content) => {
			const relative = toRelativeWorkspacePath(root$2, absolutePath);
			await (await rootPromise).write(relative, content, { mkdir: true });
		},
		access: async (absolutePath) => {
			let relative;
			try {
				relative = toRelativeWorkspacePath(root$2, absolutePath);
			} catch {
				return;
			}
			try {
				await (await (await rootPromise).open(relative)).handle.close().catch(() => {});
			} catch (error) {
				if (error instanceof FsSafeError && error.code === "not-found") throw createFsAccessError("ENOENT", absolutePath);
				if (error instanceof FsSafeError && error.code === "outside-workspace") return;
				throw error;
			}
		}
	};
}
function createFsAccessError(code, filePath) {
	const error = /* @__PURE__ */ new Error(`Sandbox FS error (${code}): ${filePath}`);
	error.code = code;
	return error;
}
//#endregion
//#region src/agents/openclaw-tools.nodes-workspace-guard.ts
function applyNodesToolWorkspaceGuard(nodesToolBase, options) {
	if (options.fsPolicy?.workspaceOnly !== true) return nodesToolBase;
	return wrapToolWorkspaceRootGuardWithOptions(nodesToolBase, options.sandboxRoot ?? options.workspaceDir, {
		containerWorkdir: options.sandboxContainerWorkdir,
		normalizeGuardedPathParams: true,
		pathParamKeys: ["outPath"]
	});
}
//#endregion
//#region src/agents/openclaw-tools.registration.ts
function collectPresentOpenClawTools(candidates) {
	return candidates.filter((tool) => tool !== null && tool !== void 0);
}
function isUpdatePlanToolEnabledForOpenClawTools(params) {
	const configured = params.config?.tools?.experimental?.planTool;
	if (configured !== void 0) return configured;
	return isStrictAgenticExecutionContractActive({
		config: params.config,
		sessionKey: params.agentSessionKey,
		agentId: params.agentId,
		provider: params.modelProvider,
		modelId: params.modelId
	});
}
//#endregion
//#region src/agents/tool-loop-detection-config.ts
function resolveToolLoopDetectionConfig(params) {
	const global = params.cfg?.tools?.loopDetection;
	const agent = params.agentId && params.cfg ? resolveAgentConfig(params.cfg, params.agentId)?.tools?.loopDetection : void 0;
	if (!agent) return global;
	if (!global) return agent;
	return {
		...global,
		...agent,
		detectors: {
			...global.detectors,
			...agent.detectors
		},
		postCompactionGuard: {
			...global.postCompactionGuard,
			...agent.postCompactionGuard
		}
	};
}
//#endregion
//#region src/agents/tools/agents-list-tool.ts
const AgentsListToolSchema = Type.Object({});
function createAgentsListTool(opts) {
	return {
		label: "Agents",
		name: "agents_list",
		description: "List agent ids allowed for `sessions_spawn runtime=\"subagent\"`.",
		parameters: AgentsListToolSchema,
		execute: async () => {
			const cfg = getRuntimeConfig();
			const { mainKey, alias } = resolveMainSessionAlias(cfg);
			const requesterInternalKey = typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim() ? resolveInternalSessionKey({
				key: opts.agentSessionKey,
				alias,
				mainKey
			}) : alias;
			const requesterAgentId = normalizeAgentId(opts?.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId ?? "main");
			const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? cfg?.agents?.defaults?.subagents?.allowAgents;
			const configuredAgents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
			const configuredIds = listAgentIds(cfg);
			const configuredNameMap = /* @__PURE__ */ new Map();
			for (const entry of configuredAgents) {
				const name = entry?.name?.trim() ?? "";
				if (!name) continue;
				configuredNameMap.set(normalizeAgentId(entry.id), name);
			}
			const allowed = resolveSubagentAllowedTargetIds({
				requesterAgentId,
				allowAgents,
				configuredAgentIds: configuredIds
			});
			const all = allowed.allowedIds;
			const rest = all.filter((id) => id !== requesterAgentId).toSorted((a, b) => a.localeCompare(b));
			const agents = (all.includes(requesterAgentId) ? [requesterAgentId, ...rest] : rest).map((id) => {
				const model = resolveAgentEffectiveModelPrimary(cfg, id);
				const resolvedModel = resolveDefaultModelForAgent({
					cfg,
					agentId: id
				});
				const agentRuntime = resolveModelAgentRuntimeMetadata({
					cfg,
					agentId: id,
					provider: resolvedModel.provider,
					model: resolvedModel.model
				});
				return {
					id,
					name: configuredNameMap.get(id),
					configured: configuredIds.includes(id),
					model,
					agentRuntime
				};
			});
			return jsonResult({
				requester: requesterAgentId,
				allowAny: allowed.allowAny,
				agents
			});
		}
	};
}
//#endregion
//#region src/cron/normalize.ts
const DEFAULT_OPTIONS = { applyDefaults: false };
function hasTrimmedStringValue(value) {
	return parseOptionalField(TrimmedNonEmptyStringFieldSchema, value) !== void 0;
}
function hasAgentTurnPayloadHint(payload) {
	return hasTrimmedStringValue(payload.model) || normalizeTrimmedStringArray(payload.fallbacks) !== void 0 || normalizeTrimmedStringArray(payload.toolsAllow, { allowNull: true }) !== void 0 || hasTrimmedStringValue(payload.thinking) || typeof payload.timeoutSeconds === "number" || typeof payload.lightContext === "boolean" || typeof payload.allowUnsafeExternalContent === "boolean";
}
function normalizeTrimmedStringArray(value, options) {
	if (Array.isArray(value)) {
		const normalized = value.map((entry) => normalizeOptionalString(entry)).filter((entry) => Boolean(entry));
		if (normalized.length === 0 && value.length > 0) return;
		return normalized;
	}
	if (options?.allowNull && value === null) return null;
}
function coerceSchedule(schedule) {
	const next = { ...schedule };
	const rawKind = normalizeLowercaseStringOrEmpty(schedule.kind);
	const kind = rawKind === "at" || rawKind === "every" || rawKind === "cron" ? rawKind : void 0;
	const exprRaw = normalizeOptionalString(schedule.expr) ?? "";
	const legacyCronRaw = normalizeOptionalString(schedule.cron) ?? "";
	const normalizedExpr = exprRaw || legacyCronRaw;
	const atMsRaw = schedule.atMs;
	const atRaw = schedule.at;
	const atString = normalizeOptionalString(atRaw) ?? "";
	const parsedAtMs = typeof atMsRaw === "number" ? atMsRaw : typeof atMsRaw === "string" ? parseAbsoluteTimeMs(atMsRaw) : atString ? parseAbsoluteTimeMs(atString) : null;
	if (kind) next.kind = kind;
	else if (typeof schedule.atMs === "number" || typeof schedule.at === "string" || typeof schedule.atMs === "string") next.kind = "at";
	else if (typeof schedule.everyMs === "number") next.kind = "every";
	else if (normalizedExpr) next.kind = "cron";
	if (atString) next.at = parsedAtMs !== null ? new Date(parsedAtMs).toISOString() : atString;
	else if (parsedAtMs !== null) next.at = new Date(parsedAtMs).toISOString();
	if ("atMs" in next) delete next.atMs;
	if (normalizedExpr) next.expr = normalizedExpr;
	else if ("expr" in next) delete next.expr;
	if ("cron" in next) delete next.cron;
	const staggerMs = normalizeCronStaggerMs(schedule.staggerMs);
	if (staggerMs !== void 0) next.staggerMs = staggerMs;
	else if ("staggerMs" in next) delete next.staggerMs;
	if (next.kind === "at") {
		delete next.everyMs;
		delete next.anchorMs;
		delete next.expr;
		delete next.tz;
		delete next.staggerMs;
	} else if (next.kind === "every") {
		delete next.at;
		delete next.expr;
		delete next.tz;
		delete next.staggerMs;
	} else if (next.kind === "cron") {
		delete next.at;
		delete next.everyMs;
		delete next.anchorMs;
	}
	return next;
}
function inferTopLevelSchedule(next) {
	const kindRaw = normalizeLowercaseStringOrEmpty(next.kind);
	const kind = kindRaw === "at" || kindRaw === "every" || kindRaw === "cron" ? kindRaw : void 0;
	const schedule = {};
	if (kind) schedule.kind = kind;
	for (const field of [
		"at",
		"atMs",
		"everyMs",
		"anchorMs",
		"expr",
		"cron",
		"tz",
		"staggerMs"
	]) if (field in next) schedule[field] = next[field];
	return Object.keys(schedule).length > 0 ? coerceSchedule(schedule) : null;
}
function coercePayload(payload) {
	const next = { ...payload };
	const kindRaw = normalizeLowercaseStringOrEmpty(next.kind);
	if (kindRaw === "agentturn") next.kind = "agentTurn";
	else if (kindRaw === "systemevent") next.kind = "systemEvent";
	else if (kindRaw) next.kind = kindRaw;
	if (!next.kind) {
		const message = normalizeOptionalString(next.message);
		const text = normalizeOptionalString(next.text);
		const hasAgentTurnHint = hasAgentTurnPayloadHint(next);
		if (message) next.kind = "agentTurn";
		else if (text && hasAgentTurnHint) {
			next.kind = "agentTurn";
			next.message = text;
		} else if (text) next.kind = "systemEvent";
		else if (hasAgentTurnHint) next.kind = "agentTurn";
	}
	if (typeof next.message === "string") {
		const trimmed = normalizeOptionalString(next.message) ?? "";
		if (trimmed) next.message = trimmed;
	}
	if (typeof next.text === "string") {
		const trimmed = normalizeOptionalString(next.text) ?? "";
		if (trimmed) next.text = trimmed;
	}
	if ("model" in next) {
		const model = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next.model);
		if (model !== void 0) next.model = model;
		else delete next.model;
	}
	if ("thinking" in next) {
		const thinking = parseOptionalField(TrimmedNonEmptyStringFieldSchema, next.thinking);
		if (thinking !== void 0) next.thinking = thinking;
		else delete next.thinking;
	}
	if ("timeoutSeconds" in next) {
		const timeoutSeconds = parseOptionalField(TimeoutSecondsFieldSchema, next.timeoutSeconds);
		if (timeoutSeconds !== void 0) next.timeoutSeconds = timeoutSeconds;
		else delete next.timeoutSeconds;
	}
	if ("fallbacks" in next) {
		const fallbacks = normalizeTrimmedStringArray(next.fallbacks);
		if (fallbacks !== void 0) next.fallbacks = fallbacks;
		else delete next.fallbacks;
	}
	if ("toolsAllow" in next) {
		const toolsAllow = normalizeTrimmedStringArray(next.toolsAllow, { allowNull: true });
		if (toolsAllow !== void 0) next.toolsAllow = toolsAllow;
		else delete next.toolsAllow;
	}
	if ("allowUnsafeExternalContent" in next && typeof next.allowUnsafeExternalContent !== "boolean") delete next.allowUnsafeExternalContent;
	if (next.kind === "systemEvent") {
		delete next.message;
		delete next.model;
		delete next.fallbacks;
		delete next.thinking;
		delete next.timeoutSeconds;
		delete next.lightContext;
		delete next.allowUnsafeExternalContent;
		delete next.toolsAllow;
	} else if (next.kind === "agentTurn") delete next.text;
	if ("deliver" in next) delete next.deliver;
	if ("channel" in next) delete next.channel;
	if ("to" in next) delete next.to;
	if ("threadId" in next) delete next.threadId;
	if ("bestEffortDeliver" in next) delete next.bestEffortDeliver;
	if ("provider" in next) delete next.provider;
	return next;
}
function coerceDelivery(delivery) {
	const next = { ...delivery };
	const parsed = parseDeliveryInput(delivery);
	if (parsed.mode !== void 0) next.mode = parsed.mode;
	else if ("mode" in next) delete next.mode;
	if (parsed.channel !== void 0) next.channel = parsed.channel;
	else if ("channel" in next) delete next.channel;
	if (parsed.to !== void 0) next.to = parsed.to;
	else if ("to" in next) delete next.to;
	if (parsed.threadId !== void 0) next.threadId = parsed.threadId;
	else if ("threadId" in next) delete next.threadId;
	if (parsed.accountId !== void 0) next.accountId = parsed.accountId;
	else if ("accountId" in next) delete next.accountId;
	return next;
}
function inferTopLevelPayload(next) {
	const message = normalizeOptionalString(next.message) ?? "";
	if (message) return {
		kind: "agentTurn",
		message
	};
	const text = normalizeOptionalString(next.text) ?? "";
	if (text) {
		if (hasAgentTurnPayloadHint(next)) return {
			kind: "agentTurn",
			message: text
		};
		return {
			kind: "systemEvent",
			text
		};
	}
	if (hasAgentTurnPayloadHint(next)) return { kind: "agentTurn" };
	return null;
}
function unwrapJob(raw) {
	if (isRecord$2(raw.data)) return raw.data;
	if (isRecord$2(raw.job)) return raw.job;
	return raw;
}
function normalizeSessionTarget(raw) {
	if (typeof raw !== "string") return;
	const trimmed = raw.trim();
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	if (lower === "main" || lower === "isolated" || lower === "current") return lower;
	if (lower.startsWith("session:")) return `session:${assertSafeCronSessionTargetId(trimmed.slice(8))}`;
}
function normalizeWakeMode(raw) {
	if (typeof raw !== "string") return;
	const trimmed = normalizeOptionalLowercaseString(raw);
	if (trimmed === "now" || trimmed === "next-heartbeat") return trimmed;
}
function copyTopLevelAgentTurnFields(next, payload) {
	const copyString = (field) => {
		if (normalizeOptionalString(payload[field])) return;
		const value = next[field];
		const normalized = normalizeOptionalString(value);
		if (normalized) payload[field] = normalized;
	};
	copyString("model");
	copyString("thinking");
	if (typeof payload.timeoutSeconds !== "number" && typeof next.timeoutSeconds === "number") payload.timeoutSeconds = next.timeoutSeconds;
	if (!Array.isArray(payload.fallbacks) && Array.isArray(next.fallbacks)) {
		const fallbacks = normalizeTrimmedStringArray(next.fallbacks);
		if (fallbacks !== void 0) payload.fallbacks = fallbacks;
	}
	if (!("toolsAllow" in payload) || payload.toolsAllow === void 0) {
		const toolsAllow = normalizeTrimmedStringArray(next.toolsAllow, { allowNull: true }) ?? normalizeTrimmedStringArray(next.tools);
		if (toolsAllow !== void 0) payload.toolsAllow = toolsAllow;
	}
	if (typeof payload.lightContext !== "boolean" && typeof next.lightContext === "boolean") payload.lightContext = next.lightContext;
	if (typeof payload.allowUnsafeExternalContent !== "boolean" && typeof next.allowUnsafeExternalContent === "boolean") payload.allowUnsafeExternalContent = next.allowUnsafeExternalContent;
}
function stripLegacyTopLevelFields(next) {
	delete next.model;
	delete next.thinking;
	delete next.timeoutSeconds;
	delete next.fallbacks;
	delete next.lightContext;
	delete next.toolsAllow;
	delete next.allowUnsafeExternalContent;
	delete next.message;
	delete next.text;
	delete next.kind;
	delete next.cron;
	delete next.tz;
	delete next.at;
	delete next.atMs;
	delete next.everyMs;
	delete next.anchorMs;
	delete next.staggerMs;
	delete next.session;
	delete next.tools;
	delete next.deliver;
	delete next.channel;
	delete next.to;
	delete next.toolsAllow;
	delete next.threadId;
	delete next.bestEffortDeliver;
	delete next.provider;
}
function normalizeCronJobInput(raw, options = DEFAULT_OPTIONS) {
	if (!isRecord$2(raw)) return null;
	const base = unwrapJob(raw);
	const next = { ...base };
	if ("agentId" in base) {
		const agentId = base.agentId;
		if (agentId === null) next.agentId = null;
		else if (typeof agentId === "string") {
			const trimmed = agentId.trim();
			if (trimmed) next.agentId = sanitizeAgentId(trimmed);
			else delete next.agentId;
		}
	}
	if ("sessionKey" in base) {
		const sessionKey = base.sessionKey;
		if (sessionKey === null) next.sessionKey = null;
		else if (typeof sessionKey === "string") {
			const trimmed = sessionKey.trim();
			if (trimmed) next.sessionKey = trimmed;
			else delete next.sessionKey;
		}
	}
	if ("enabled" in base) {
		const enabled = base.enabled;
		if (typeof enabled === "boolean") next.enabled = enabled;
		else if (typeof enabled === "string") {
			const trimmed = normalizeOptionalLowercaseString(enabled);
			if (trimmed === "true") next.enabled = true;
			if (trimmed === "false") next.enabled = false;
		}
	}
	if ("sessionTarget" in base) {
		const normalized = normalizeSessionTarget(base.sessionTarget);
		if (normalized) next.sessionTarget = normalized;
		else delete next.sessionTarget;
	} else if ("session" in base) {
		const normalized = normalizeSessionTarget(base.session);
		if (normalized) next.sessionTarget = normalized;
	}
	if ("wakeMode" in base) {
		const normalized = normalizeWakeMode(base.wakeMode);
		if (normalized) next.wakeMode = normalized;
		else delete next.wakeMode;
	}
	if (isRecord$2(base.schedule)) next.schedule = coerceSchedule(base.schedule);
	else if (!isRecord$2(next.schedule)) {
		const inferredSchedule = inferTopLevelSchedule(next);
		if (inferredSchedule) next.schedule = inferredSchedule;
	}
	if (!("payload" in next) || !isRecord$2(next.payload)) {
		const inferredPayload = inferTopLevelPayload(next);
		if (inferredPayload) next.payload = inferredPayload;
	}
	if (isRecord$2(base.payload)) next.payload = coercePayload(base.payload);
	if (isRecord$2(base.delivery)) next.delivery = coerceDelivery(base.delivery);
	if ("isolation" in next) delete next.isolation;
	const payload = isRecord$2(next.payload) ? next.payload : null;
	if (payload && payload.kind === "agentTurn") copyTopLevelAgentTurnFields(next, payload);
	stripLegacyTopLevelFields(next);
	if (options.applyDefaults) {
		if (!next.wakeMode) next.wakeMode = "now";
		if (typeof next.enabled !== "boolean") next.enabled = true;
		if ((typeof next.name !== "string" || !next.name.trim()) && isRecord$2(next.schedule) && isRecord$2(next.payload)) next.name = inferLegacyName({
			schedule: next.schedule,
			payload: next.payload
		});
		else if (typeof next.name === "string") {
			const trimmed = next.name.trim();
			if (trimmed) next.name = trimmed;
		}
		if (!next.sessionTarget && isRecord$2(next.payload)) {
			const kind = typeof next.payload.kind === "string" ? next.payload.kind : "";
			if (kind === "systemEvent") next.sessionTarget = "main";
			else if (kind === "agentTurn") next.sessionTarget = "isolated";
		}
		const resolvedSessionTarget = resolveCronCurrentSessionTarget({
			sessionTarget: typeof next.sessionTarget === "string" ? next.sessionTarget : void 0,
			sessionKey: options.sessionContext?.sessionKey
		});
		if (resolvedSessionTarget !== void 0) next.sessionTarget = resolvedSessionTarget;
		else delete next.sessionTarget;
		if ("schedule" in next && isRecord$2(next.schedule) && next.schedule.kind === "at" && !("deleteAfterRun" in next)) next.deleteAfterRun = true;
		if ("schedule" in next && isRecord$2(next.schedule) && next.schedule.kind === "cron") {
			const schedule = next.schedule;
			const explicit = normalizeCronStaggerMs(schedule.staggerMs);
			if (explicit !== void 0) schedule.staggerMs = explicit;
			else {
				const defaultStaggerMs = resolveDefaultCronStaggerMs(typeof schedule.expr === "string" ? schedule.expr : "");
				if (defaultStaggerMs !== void 0) schedule.staggerMs = defaultStaggerMs;
			}
		}
		const payload = isRecord$2(next.payload) ? next.payload : null;
		const payloadKind = payload && typeof payload.kind === "string" ? payload.kind : "";
		const sessionTarget = typeof next.sessionTarget === "string" ? next.sessionTarget : "";
		const isIsolatedAgentTurn = sessionTarget === "isolated" || sessionTarget === "current" || sessionTarget.startsWith("session:") || sessionTarget === "" && payloadKind === "agentTurn";
		if (!("delivery" in next && next.delivery !== void 0) && isIsolatedAgentTurn && payloadKind === "agentTurn") next.delivery = { mode: "announce" };
	}
	return next;
}
function normalizeCronJobCreate(raw, options) {
	return normalizeCronJobInput(raw, {
		applyDefaults: true,
		...options
	});
}
function normalizeCronJobPatch(raw, options) {
	return normalizeCronJobInput(raw, {
		applyDefaults: false,
		...options
	});
}
//#endregion
//#region src/agents/tools/cron-tool.ts
const CRON_ACTIONS = [
	"status",
	"list",
	"get",
	"add",
	"update",
	"remove",
	"run",
	"runs",
	"wake"
];
const CRON_SCHEDULE_KINDS = [
	"at",
	"every",
	"cron"
];
const CRON_WAKE_MODES = ["now", "next-heartbeat"];
const CRON_PAYLOAD_KINDS = ["systemEvent", "agentTurn"];
const CRON_DELIVERY_MODES = [
	"none",
	"announce",
	"webhook"
];
const CRON_RUN_MODES = ["due", "force"];
const CRON_FLAT_PAYLOAD_KEYS = [
	"message",
	"text",
	"model",
	"fallbacks",
	"toolsAllow",
	"thinking",
	"timeoutSeconds",
	"lightContext",
	"allowUnsafeExternalContent"
];
const CRON_FLAT_SCHEDULE_KEYS = [
	"kind",
	"at",
	"atMs",
	"every",
	"everyMs",
	"anchorMs",
	"cron",
	"expr",
	"tz",
	"stagger",
	"staggerMs",
	"exact"
];
const CRON_RECOVERABLE_OBJECT_KEYS = new Set([
	"name",
	"schedule",
	"sessionTarget",
	"wakeMode",
	"payload",
	"delivery",
	"enabled",
	"description",
	"deleteAfterRun",
	"agentId",
	"sessionKey",
	"failureAlert",
	...CRON_FLAT_PAYLOAD_KEYS,
	...CRON_FLAT_SCHEDULE_KEYS
]);
const REMINDER_CONTEXT_MESSAGES_MAX = 10;
const REMINDER_CONTEXT_PER_MESSAGE_MAX = 220;
const REMINDER_CONTEXT_TOTAL_MAX = 700;
const REMINDER_CONTEXT_MARKER = "\n\nRecent context:\n";
function isMissingOrEmptyObject(value) {
	return !value || isRecord$2(value) && Object.keys(value).length === 0;
}
function recoverCronObjectFromFlatParams(params) {
	const value = {};
	let found = false;
	for (const key of Object.keys(params)) if (CRON_RECOVERABLE_OBJECT_KEYS.has(key) && params[key] !== void 0) {
		value[key] = params[key];
		found = true;
	}
	if (value.everyMs === void 0 && value.every !== void 0) value.everyMs = value.every;
	if (value.staggerMs === void 0 && value.stagger !== void 0) value.staggerMs = value.stagger;
	if (value.exact === true && value.staggerMs === void 0) value.staggerMs = 0;
	delete value.every;
	delete value.stagger;
	delete value.exact;
	return {
		found,
		value
	};
}
function hasCronCreateSignal(value) {
	return value.schedule !== void 0 || value.at !== void 0 || value.atMs !== void 0 || value.everyMs !== void 0 || value.cron !== void 0 || value.expr !== void 0 || value.payload !== void 0 || value.message !== void 0 || value.text !== void 0;
}
function nullableStringSchema(description) {
	return Type.Optional(Type.String({ description }));
}
function nullableStringArraySchema(description) {
	return Type.Optional(Type.Array(Type.String(), { description }));
}
function cronPayloadObjectSchema(params) {
	return Type.Object({
		kind: optionalStringEnum(CRON_PAYLOAD_KINDS, { description: "Payload kind" }),
		text: Type.Optional(Type.String({ description: "systemEvent text" })),
		message: Type.Optional(Type.String({ description: "agentTurn prompt" })),
		model: Type.Optional(Type.String({ description: "Model override" })),
		thinking: Type.Optional(Type.String({ description: "Thinking override" })),
		timeoutSeconds: Type.Optional(Type.Number()),
		lightContext: Type.Optional(Type.Boolean()),
		allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
		fallbacks: Type.Optional(Type.Array(Type.String(), { description: "Fallback models" })),
		toolsAllow: params.toolsAllow
	}, { additionalProperties: true });
}
const CronScheduleSchema = Type.Optional(Type.Object({
	kind: optionalStringEnum(CRON_SCHEDULE_KINDS, { description: "Schedule kind" }),
	at: Type.Optional(Type.String({ description: "ISO-8601 time (kind=at)" })),
	everyMs: Type.Optional(Type.Number({ description: "Interval ms (kind=every)" })),
	anchorMs: Type.Optional(Type.Number({ description: "Start anchor ms (kind=every)" })),
	expr: Type.Optional(Type.String({ description: "Cron expr in tz wall-clock time; do not convert to UTC. Omitted tz => Gateway host local timezone. Example 6pm Shanghai daily: expr \"0 18 * * *\", tz \"Asia/Shanghai\"." })),
	tz: Type.Optional(Type.String({ description: "IANA timezone for cron wall-clock fields, e.g. \"Asia/Shanghai\"; omitted => Gateway host local timezone." })),
	staggerMs: Type.Optional(Type.Number({ description: "Jitter ms (kind=cron)" }))
}, { additionalProperties: true }));
const CronPayloadSchema = Type.Optional(cronPayloadObjectSchema({ toolsAllow: Type.Optional(Type.Array(Type.String(), { description: "Allowed tools" })) }));
const CronDeliverySchema = Type.Optional(Type.Object({
	mode: optionalStringEnum(CRON_DELIVERY_MODES, { description: "Delivery mode" }),
	channel: Type.Optional(Type.String({ description: "Delivery channel" })),
	to: Type.Optional(Type.String({ description: "Delivery target" })),
	threadId: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Thread/topic id" })),
	bestEffort: Type.Optional(Type.Boolean()),
	accountId: Type.Optional(Type.String({ description: "Delivery account" })),
	failureDestination: Type.Optional(Type.Object({
		channel: Type.Optional(Type.String()),
		to: Type.Optional(Type.String()),
		accountId: Type.Optional(Type.String()),
		mode: optionalStringEnum(["announce", "webhook"])
	}, { additionalProperties: true }))
}, { additionalProperties: true }));
const CronFailureAlertSchema = Type.Optional(Type.Unsafe({
	type: "object",
	properties: {
		after: Type.Optional(Type.Number({ description: "Failures before alert" })),
		channel: Type.Optional(Type.String({ description: "Alert channel" })),
		to: Type.Optional(Type.String({ description: "Alert target" })),
		cooldownMs: Type.Optional(Type.Number({ description: "Alert cooldown ms" })),
		includeSkipped: Type.Optional(Type.Boolean({ description: "Skipped runs count toward alert" })),
		mode: optionalStringEnum(["announce", "webhook"]),
		accountId: Type.Optional(Type.String())
	},
	additionalProperties: true,
	description: "Failure alert object; false disables alerts"
}));
const CronJobObjectSchema = Type.Optional(Type.Object({
	name: Type.Optional(Type.String({ description: "Job name" })),
	schedule: CronScheduleSchema,
	sessionTarget: Type.Optional(Type.String({ description: "main | isolated | current | session:<id>" })),
	wakeMode: optionalStringEnum(CRON_WAKE_MODES, { description: "Wake timing" }),
	payload: CronPayloadSchema,
	delivery: CronDeliverySchema,
	agentId: nullableStringSchema("Agent id, or null to keep it unset"),
	description: Type.Optional(Type.String({ description: "Human description" })),
	enabled: Type.Optional(Type.Boolean()),
	deleteAfterRun: Type.Optional(Type.Boolean({ description: "Delete after first run" })),
	sessionKey: nullableStringSchema("Explicit session key, or null to clear it"),
	failureAlert: CronFailureAlertSchema
}, { additionalProperties: true }));
const CronPatchObjectSchema = Type.Optional(Type.Object({
	name: Type.Optional(Type.String({ description: "Job name" })),
	schedule: CronScheduleSchema,
	sessionTarget: Type.Optional(Type.String({ description: "Session target" })),
	wakeMode: optionalStringEnum(CRON_WAKE_MODES),
	payload: Type.Optional(cronPayloadObjectSchema({ toolsAllow: nullableStringArraySchema("Allowed tool ids, or null to clear") })),
	delivery: CronDeliverySchema,
	description: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	deleteAfterRun: Type.Optional(Type.Boolean()),
	agentId: nullableStringSchema("Agent id, or null to clear it"),
	sessionKey: nullableStringSchema("Explicit session key, or null to clear it"),
	failureAlert: CronFailureAlertSchema
}, { additionalProperties: true }));
const CronToolSchema = Type.Object({
	action: stringEnum(CRON_ACTIONS),
	gatewayUrl: Type.Optional(Type.String()),
	gatewayToken: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Number()),
	includeDisabled: Type.Optional(Type.Boolean()),
	job: CronJobObjectSchema,
	jobId: Type.Optional(Type.String()),
	id: Type.Optional(Type.String()),
	patch: CronPatchObjectSchema,
	text: Type.Optional(Type.String()),
	mode: optionalStringEnum(CRON_WAKE_MODES),
	runMode: optionalStringEnum(CRON_RUN_MODES),
	contextMessages: Type.Optional(Type.Number({
		minimum: 0,
		maximum: REMINDER_CONTEXT_MESSAGES_MAX
	})),
	agentId: Type.Optional(Type.String({ description: "List filter: agent id" }))
}, { additionalProperties: true });
function stripExistingContext(text) {
	const index = text.indexOf(REMINDER_CONTEXT_MARKER);
	if (index === -1) return text;
	return text.slice(0, index).trim();
}
function truncateText(input, maxLen) {
	if (input.length <= maxLen) return input;
	return `${truncateUtf16Safe(input, Math.max(0, maxLen - 3)).trimEnd()}...`;
}
function readCronJobIdParam(params) {
	return readStringParam$1(params, "jobId") ?? readStringParam$1(params, "id");
}
const CRON_SELF_REMOVE_SCOPE_ERROR = "Cron tool is restricted to the current cron job.";
function readCronSelfRemoveOnlyJobId(opts) {
	return opts?.selfRemoveOnlyJobId?.trim() || void 0;
}
function isCronSelfIntrospectionAction(action) {
	return action === "status" || action === "list";
}
function assertCronSelfRemoveScope(opts, action, params) {
	const selfRemoveOnlyJobId = readCronSelfRemoveOnlyJobId(opts);
	if (!selfRemoveOnlyJobId || isCronSelfIntrospectionAction(action)) return;
	if (action === "get" || action === "remove" || action === "runs") {
		const id = readCronJobIdParam(params);
		if (id && id === selfRemoveOnlyJobId) return;
	}
	throw new Error(CRON_SELF_REMOVE_SCOPE_ERROR);
}
function filterCronDeliveryPreviewsByJobId(previews, jobId) {
	if (!isRecord$2(previews)) return previews;
	if (!Object.hasOwn(previews, jobId)) return {};
	return { [jobId]: previews[jobId] };
}
function filterCronListResultToJobId(result, jobId) {
	if (!isRecord$2(result) || !Array.isArray(result.jobs)) return result;
	const jobs = result.jobs.filter((job) => isRecord$2(job) && job.id === jobId);
	return {
		...result,
		jobs,
		total: jobs.length,
		offset: 0,
		limit: jobs.length,
		hasMore: false,
		nextOffset: null,
		...Object.hasOwn(result, "deliveryPreviews") ? { deliveryPreviews: filterCronDeliveryPreviewsByJobId(result.deliveryPreviews, jobId) } : {}
	};
}
function filterCronStatusResultForSelfScope(result) {
	return { enabled: isRecord$2(result) && result.enabled === true };
}
function cronListResultHasJob(result, jobId) {
	return isRecord$2(result) && Array.isArray(result.jobs) && result.jobs.some((job) => isRecord$2(job) && job.id === jobId);
}
function readCronListNextOffset(result, currentOffset) {
	if (!isRecord$2(result) || result.hasMore !== true || typeof result.nextOffset !== "number") return;
	const nextOffset = Math.floor(result.nextOffset);
	return Number.isFinite(nextOffset) && nextOffset > currentOffset ? nextOffset : void 0;
}
function extractMessageText(message) {
	const role = typeof message.role === "string" ? message.role : "";
	if (role !== "user" && role !== "assistant") return null;
	const text = extractTextFromChatContent(message.content);
	return text ? {
		role,
		text
	} : null;
}
async function buildReminderContextLines(params) {
	const maxMessages = Math.min(REMINDER_CONTEXT_MESSAGES_MAX, Math.max(0, Math.floor(params.contextMessages)));
	if (maxMessages <= 0) return [];
	const sessionKey = params.agentSessionKey?.trim();
	if (!sessionKey) return [];
	const { mainKey, alias } = resolveMainSessionAlias(getRuntimeConfig());
	const resolvedKey = resolveInternalSessionKey({
		key: sessionKey,
		alias,
		mainKey
	});
	try {
		const res = await params.callGatewayTool("chat.history", params.gatewayOpts, {
			sessionKey: resolvedKey,
			limit: maxMessages
		});
		const recent = (Array.isArray(res?.messages) ? res.messages : []).map((msg) => extractMessageText(msg)).filter((msg) => Boolean(msg)).slice(-maxMessages);
		if (recent.length === 0) return [];
		const lines = [];
		let total = 0;
		for (const entry of recent) {
			const line = `- ${entry.role === "user" ? "User" : "Assistant"}: ${truncateText(entry.text, REMINDER_CONTEXT_PER_MESSAGE_MAX)}`;
			total += line.length;
			if (total > REMINDER_CONTEXT_TOTAL_MAX) break;
			lines.push(line);
		}
		return lines;
	} catch {
		return [];
	}
}
function createCronTool(opts, deps) {
	const callGateway = deps?.callGatewayTool ?? callGatewayTool;
	return {
		label: "Cron",
		name: "cron",
		displaySummary: CRON_TOOL_DISPLAY_SUMMARY,
		description: `Manage Gateway cron jobs and wake events: reminders, check-back-later, delayed follow-ups, recurring work. Do not emulate scheduling with exec sleep/process polling.

Main cron => system events for heartbeat. Isolated cron => background task in \`openclaw tasks\`.

ACTIONS:
- status: scheduler status
- list: jobs; includeDisabled true includes disabled; agentId filter auto-filled from session
- get: one job; needs jobId
- add: create job; needs job object
- update: patch job; needs jobId + patch
- remove: delete job; needs jobId
- run: trigger now; needs jobId
- runs: run history; needs jobId
- wake: send wake event; needs text, optional mode

JOB SCHEMA (for add action):
{
  "name": "string",
  "schedule": { ... },      // required
  "payload": { ... },       // required
  "delivery": { ... },      // optional announce for isolated/current/session, webhook for any target
  "sessionTarget": "main" | "isolated" | "current" | "session:<id>",
  "enabled": true | false   // default true
}

SESSION TARGET OPTIONS:
- "main": main session; requires payload.kind="systemEvent"
- "isolated": ephemeral isolated session; requires payload.kind="agentTurn"
- "current": bind current session at creation
- "session:<id>": persistent named session

DEFAULTS:
- payload.kind="systemEvent" → defaults to "main"
- payload.kind="agentTurn" → defaults to "isolated"
Current binding needs sessionTarget="current".

SCHEDULE TYPES (schedule.kind):
- "at": one-shot absolute time
  { "kind": "at", "at": "<ISO-8601 timestamp>" }
- "every": recurring interval
  { "kind": "every", "everyMs": <ms>, "anchorMs": <optional-ms> }
- "cron": expr in supplied timezone, or Gateway host local timezone when tz omitted
  { "kind": "cron", "expr": "<cron-expression>", "tz": "<optional-IANA-timezone>" }
  Write expr in local wall-clock time; do not convert the requested local time to UTC first.
  tz omitted => Gateway host local timezone, not UTC.
  Example 6pm Shanghai daily: { "kind": "cron", "expr": "0 18 * * *", "tz": "Asia/Shanghai" }

For "at", ISO timestamps without timezone are UTC.

PAYLOAD TYPES (payload.kind):
- "systemEvent": inject text as system event
  { "kind": "systemEvent", "text": "<message>" }
- "agentTurn": run agent with prompt; isolated/current/session only
  { "kind": "agentTurn", "message": "<prompt>", "model": "<optional>", "thinking": "<optional>", "timeoutSeconds": <optional, 0=no timeout> }

DELIVERY (top-level):
  { "mode": "none|announce|webhook", "channel": "<optional>", "to": "<optional>", "threadId": "<optional>", "bestEffort": <optional-bool> }
  - isolated agentTurn default when omitted: "announce"
  - announce: send to chat channel; isolated/current/session only; optional channel/to
  - threadId: chat thread/topic id
  - webhook: POST finished-run event to delivery.to URL
  - Specific chat/recipient: set announce delivery.channel/to; do not call messaging tools inside run.

CRITICAL CONSTRAINTS:
- sessionTarget="main" REQUIRES payload.kind="systemEvent"
- sessionTarget="isolated" | "current" | "session:xxx" REQUIRES payload.kind="agentTurn"
- Webhook: delivery.mode="webhook" and delivery.to URL.
Default: prefer isolated agentTurn jobs unless the user explicitly wants current-session binding.

RESTRICTED CRON RUNS:
- Some isolated cron runs get narrow self-cleanup grant: status/list self-only, get/runs current job only, mutation only remove current job.

WAKE MODES (for wake action):
- "next-heartbeat" default: wake next heartbeat
- "now": wake immediately

Use jobId canonical; id accepted compat. contextMessages (0-10) adds previous messages as job context.`,
		parameters: CronToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const action = readStringParam$1(params, "action", { required: true });
			assertCronSelfRemoveScope(opts, action, params);
			const gatewayOpts = {
				...readGatewayCallOptions(params),
				timeoutMs: typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? params.timeoutMs : 6e4
			};
			switch (action) {
				case "status": {
					const result = await callGateway("cron.status", gatewayOpts, {});
					return jsonResult(readCronSelfRemoveOnlyJobId(opts) ? filterCronStatusResultForSelfScope(result) : result);
				}
				case "list": {
					const cfg = getRuntimeConfig();
					const selfRemoveOnlyJobId = readCronSelfRemoveOnlyJobId(opts);
					const listAgentId = selfRemoveOnlyJobId ? opts?.agentSessionKey?.trim() ? resolveSessionAgentId({
						sessionKey: opts.agentSessionKey,
						config: cfg
					}) : void 0 : typeof params.agentId === "string" && params.agentId.trim() ? params.agentId.trim() : opts?.agentSessionKey ? resolveSessionAgentId({
						sessionKey: opts.agentSessionKey,
						config: cfg
					}) : void 0;
					const includeDisabled = Boolean(params.includeDisabled);
					let offset = 0;
					let result;
					let shouldContinue = true;
					while (shouldContinue) {
						result = await callGateway("cron.list", gatewayOpts, {
							includeDisabled,
							agentId: listAgentId,
							...selfRemoveOnlyJobId ? {
								limit: 200,
								offset
							} : {}
						});
						if (!selfRemoveOnlyJobId || cronListResultHasJob(result, selfRemoveOnlyJobId)) shouldContinue = false;
						else {
							const nextOffset = readCronListNextOffset(result, offset);
							if (nextOffset === void 0) shouldContinue = false;
							else offset = nextOffset;
						}
					}
					return jsonResult(selfRemoveOnlyJobId ? filterCronListResultToJobId(result, selfRemoveOnlyJobId) : result);
				}
				case "get": {
					const id = readCronJobIdParam(params);
					if (!id) throw new Error("jobId required (id accepted for backward compatibility)");
					return jsonResult(await callGateway("cron.get", gatewayOpts, { id }));
				}
				case "add": {
					if (isMissingOrEmptyObject(params.job)) {
						const synthetic = recoverCronObjectFromFlatParams(params);
						if (synthetic.found && hasCronCreateSignal(synthetic.value)) params.job = synthetic.value;
					}
					if (!params.job || typeof params.job !== "object") throw new Error("job required");
					const job = normalizeCronJobCreate(params.job, { sessionContext: { sessionKey: opts?.agentSessionKey } }) ?? params.job;
					const cfg = getRuntimeConfig();
					if (job && typeof job === "object") {
						const { mainKey, alias } = resolveMainSessionAlias(cfg);
						const resolvedSessionKey = opts?.agentSessionKey ? resolveInternalSessionKey({
							key: opts.agentSessionKey,
							alias,
							mainKey
						}) : void 0;
						if (!("agentId" in job) || job.agentId === void 0) {
							const agentId = opts?.agentSessionKey ? resolveSessionAgentId({
								sessionKey: opts.agentSessionKey,
								config: cfg
							}) : void 0;
							if (agentId) job.agentId = agentId;
						}
						if (!("sessionKey" in job) && resolvedSessionKey) job.sessionKey = resolvedSessionKey;
					}
					if ((opts?.agentSessionKey || opts?.currentDeliveryContext) && job && typeof job === "object" && "payload" in job && job.payload?.kind === "agentTurn") {
						const deliveryValue = job.delivery;
						const delivery = isRecord$2(deliveryValue) ? deliveryValue : void 0;
						const mode = normalizeLowercaseStringOrEmpty(typeof delivery?.mode === "string" ? delivery.mode : "");
						if (mode === "webhook") {
							const webhookUrl = normalizeHttpWebhookUrl(delivery?.to);
							if (!webhookUrl) throw new Error("delivery.mode=\"webhook\" requires delivery.to to be a valid http(s) URL");
							if (delivery) delivery.to = webhookUrl;
						}
						const hasTarget = typeof delivery?.channel === "string" && delivery.channel.trim() || typeof delivery?.to === "string" && delivery.to.trim();
						if ((deliveryValue == null || delivery) && (mode === "" || mode === "announce") && !hasTarget) {
							const inferred = resolveCronCreationDelivery({
								cfg,
								currentDeliveryContext: opts.currentDeliveryContext,
								agentSessionKey: opts.agentSessionKey
							});
							if (inferred) job.delivery = {
								...inferred,
								...delivery
							};
						}
					}
					const contextMessages = typeof params.contextMessages === "number" && Number.isFinite(params.contextMessages) ? params.contextMessages : 0;
					if (job && typeof job === "object" && "payload" in job && job.payload?.kind === "systemEvent") {
						const payload = job.payload;
						if (typeof payload.text === "string" && payload.text.trim()) {
							const contextLines = await buildReminderContextLines({
								agentSessionKey: opts?.agentSessionKey,
								gatewayOpts,
								contextMessages,
								callGatewayTool: callGateway
							});
							if (contextLines.length > 0) payload.text = `${stripExistingContext(payload.text)}${REMINDER_CONTEXT_MARKER}${contextLines.join("\n")}`;
						}
					}
					return jsonResult(await callGateway("cron.add", gatewayOpts, job));
				}
				case "update": {
					const id = readCronJobIdParam(params);
					if (!id) throw new Error("jobId required (id accepted for backward compatibility)");
					let recoveredFlatPatch = false;
					if (isMissingOrEmptyObject(params.patch)) {
						const synthetic = recoverCronObjectFromFlatParams(params);
						if (synthetic.found) {
							params.patch = synthetic.value;
							recoveredFlatPatch = true;
						}
					}
					if (!params.patch || typeof params.patch !== "object") throw new Error("patch required");
					const patch = normalizeCronJobPatch(params.patch) ?? params.patch;
					if (recoveredFlatPatch && typeof patch === "object" && patch !== null && Object.keys(patch).length === 0) throw new Error("patch required");
					return jsonResult(await callGateway("cron.update", gatewayOpts, {
						id,
						patch
					}));
				}
				case "remove": {
					const id = readCronJobIdParam(params);
					if (!id) throw new Error("jobId required (id accepted for backward compatibility)");
					return jsonResult(await callGateway("cron.remove", gatewayOpts, { id }));
				}
				case "run": {
					const id = readCronJobIdParam(params);
					if (!id) throw new Error("jobId required (id accepted for backward compatibility)");
					return jsonResult(await callGateway("cron.run", gatewayOpts, {
						id,
						mode: params.runMode === "due" || params.runMode === "force" ? params.runMode : "force"
					}));
				}
				case "runs": {
					const id = readCronJobIdParam(params);
					if (!id) throw new Error("jobId required (id accepted for backward compatibility)");
					return jsonResult(await callGateway("cron.runs", gatewayOpts, { id }));
				}
				case "wake": {
					const text = readStringParam$1(params, "text", { required: true });
					return jsonResult(await callGateway("wake", gatewayOpts, {
						mode: params.mode === "now" || params.mode === "next-heartbeat" ? params.mode : "next-heartbeat",
						text
					}, { expectFinal: false }));
				}
				default: throw new Error(`Unknown action: ${action}`);
			}
		}
	};
}
//#endregion
//#region src/agents/tools/embedded-gateway-stub.ts
let runtimeMod;
async function getRuntime() {
	if (!runtimeMod) runtimeMod = await import("./embedded-gateway-stub.runtime.js");
	return runtimeMod;
}
async function handleSessionsList(params) {
	const rt = await getRuntime();
	const cfg = rt.getRuntimeConfig();
	const { storePath, store } = rt.loadCombinedSessionStoreForGateway(cfg);
	return rt.listSessionsFromStoreAsync({
		cfg,
		storePath,
		store,
		opts: params
	});
}
async function handleSessionsResolve(params) {
	const rt = await getRuntime();
	const cfg = rt.getRuntimeConfig();
	const resolved = await rt.resolveSessionKeyFromResolveParams({
		cfg,
		p: params
	});
	if (!resolved.ok) throw new Error(resolved.error.message);
	return {
		ok: true,
		key: resolved.key
	};
}
async function handleChatHistory(params) {
	const rt = await getRuntime();
	const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
	const limit = typeof params.limit === "number" ? params.limit : void 0;
	const { cfg, storePath, entry } = rt.loadSessionEntry(sessionKey);
	const sessionId = entry?.sessionId;
	const sessionAgentId = rt.resolveSessionAgentId({
		sessionKey,
		config: cfg
	});
	const resolvedSessionModel = rt.resolveSessionModelRef(cfg, entry, sessionAgentId);
	const max = Math.min(1e3, typeof limit === "number" ? limit : 200);
	const maxHistoryBytes = rt.getMaxChatHistoryMessagesBytes();
	const localMessages = sessionId && storePath ? await rt.readSessionMessagesAsync(sessionId, storePath, entry?.sessionFile, {
		mode: "recent",
		maxMessages: max,
		maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024)
	}) : [];
	const rawMessages = rt.augmentChatHistoryWithCliSessionImports({
		entry,
		provider: resolvedSessionModel.provider,
		localMessages
	});
	const effectiveMaxChars = rt.resolveEffectiveChatHistoryMaxChars(cfg);
	const normalized = rt.augmentChatHistoryWithCanvasBlocks(rt.projectRecentChatDisplayMessages(rawMessages, {
		maxChars: effectiveMaxChars,
		maxMessages: max
	}));
	const perMessageHardCap = Math.min(rt.CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
	const replaced = rt.replaceOversizedChatHistoryMessages({
		messages: normalized,
		maxSingleMessageBytes: perMessageHardCap
	});
	const capped = rt.capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
	return {
		sessionKey,
		sessionId,
		messages: rt.enforceChatHistoryFinalBudget({
			messages: capped,
			maxBytes: maxHistoryBytes
		}).messages,
		thinkingLevel: entry?.thinkingLevel,
		fastMode: entry?.fastMode,
		verboseLevel: entry?.verboseLevel
	};
}
function createEmbeddedCallGateway() {
	return async (opts) => {
		const method = opts.method?.trim();
		const params = opts.params ?? {};
		switch (method) {
			case "sessions.list": return await handleSessionsList(params);
			case "sessions.resolve": return await handleSessionsResolve(params);
			case "chat.history": return await handleChatHistory(params);
			default: throw new Error(`Method "${method}" requires a running gateway (unavailable in local embedded mode).`);
		}
	};
}
//#endregion
//#region src/agents/tools/gateway-tool.ts
const log$6 = createSubsystemLogger("gateway-tool");
const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 6e4;
const ALLOWED_GATEWAY_CONFIG_PATHS = [
	"agents.defaults.systemPromptOverride",
	"agents.defaults.promptOverlays",
	"agents.defaults.model",
	"agents.defaults.thinkingDefault",
	"agents.defaults.subagents.thinking",
	"agents.defaults.reasoningDefault",
	"agents.defaults.fastModeDefault",
	"agents.list[].id",
	"agents.list[].systemPromptOverride",
	"agents.list[].model",
	"agents.list[].thinkingDefault",
	"agents.list[].subagents.thinking",
	"agents.list[].reasoningDefault",
	"agents.list[].fastModeDefault",
	"channels.*.requireMention",
	"channels.*.*.requireMention",
	"channels.*.*.*.requireMention",
	"channels.*.*.*.*.requireMention",
	"channels.*.*.*.*.*.requireMention",
	"messages.visibleReplies",
	"messages.groupChat.visibleReplies",
	"messages.groupChat.unmentionedInbound"
];
function resolveBaseHashFromSnapshot(snapshot) {
	if (!snapshot || typeof snapshot !== "object") return;
	const hashValue = snapshot.hash;
	const rawValue = snapshot.raw;
	return resolveConfigSnapshotHash({
		hash: readStringValue(hashValue),
		raw: readStringValue(rawValue)
	}) ?? void 0;
}
function getSnapshotConfig(snapshot) {
	if (!snapshot || typeof snapshot !== "object") throw new Error("config.get response is not an object.");
	const config = snapshot.config;
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config.get response is missing a config object.");
	return config;
}
function stripConfigWriteResultPayload(result) {
	if (!isPlainObject(result) || !Object.hasOwn(result, "config")) return result;
	const stripped = { ...result };
	delete stripped.config;
	return stripped;
}
function parseGatewayConfigMutationRaw(raw, action) {
	const parsedRes = parseConfigJson5(raw);
	if (!parsedRes.ok) throw new Error(parsedRes.error);
	if (!parsedRes.parsed || typeof parsedRes.parsed !== "object" || Array.isArray(parsedRes.parsed)) throw new Error(`${action} raw must be an object.`);
	return parsedRes.parsed;
}
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeGatewayConfigPath(path) {
	return path.startsWith("tools.bash.") ? path.replace(/^tools\.bash\./, "tools.exec.") : path;
}
function readKeyedArrayEntries(list) {
	if (!Array.isArray(list)) return null;
	let duplicateIds = false;
	let hasUnkeyedEntries = false;
	const entries = /* @__PURE__ */ new Map();
	for (const entry of list) {
		if (!isPlainObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
			hasUnkeyedEntries = true;
			continue;
		}
		if (entries.has(entry.id)) {
			duplicateIds = true;
			continue;
		}
		entries.set(entry.id, entry);
	}
	return {
		duplicateIds,
		entries,
		hasUnkeyedEntries
	};
}
function collectConfigLeafPaths(value, basePath, out) {
	const canonicalPath = normalizeGatewayConfigPath(basePath);
	if (value === void 0) {
		if (canonicalPath) out.add(canonicalPath);
		return;
	}
	if (Array.isArray(value)) {
		const keyedEntries = readKeyedArrayEntries(value);
		if (keyedEntries && !keyedEntries.duplicateIds && !keyedEntries.hasUnkeyedEntries && keyedEntries.entries.size > 0) {
			for (const entryValue of keyedEntries.entries.values()) collectConfigLeafPaths(entryValue, `${basePath}[]`, out);
			return;
		}
		if (canonicalPath) out.add(canonicalPath);
		return;
	}
	if (!isPlainObject(value)) {
		if (canonicalPath) out.add(canonicalPath);
		return;
	}
	const entries = Object.entries(value);
	if (entries.length === 0) {
		if (canonicalPath) out.add(canonicalPath);
		return;
	}
	for (const [key, child] of entries) collectConfigLeafPaths(child, basePath ? `${basePath}.${key}` : key, out);
}
function collectChangedConfigPaths(currentValue, nextValue, basePath = "", out = /* @__PURE__ */ new Set()) {
	if (isDeepStrictEqual(currentValue, nextValue)) return out;
	if (currentValue === void 0 || nextValue === void 0) {
		collectConfigLeafPaths(currentValue ?? nextValue, basePath, out);
		return out;
	}
	if (Array.isArray(currentValue) || Array.isArray(nextValue)) {
		if (!Array.isArray(currentValue) || !Array.isArray(nextValue)) {
			collectConfigLeafPaths(currentValue, basePath, out);
			collectConfigLeafPaths(nextValue, basePath, out);
			return out;
		}
		const currentEntries = readKeyedArrayEntries(currentValue);
		const nextEntries = readKeyedArrayEntries(nextValue);
		if (!currentEntries || !nextEntries || currentEntries.duplicateIds || nextEntries.duplicateIds || currentEntries.hasUnkeyedEntries || nextEntries.hasUnkeyedEntries) {
			out.add(normalizeGatewayConfigPath(basePath));
			return out;
		}
		const ids = new Set([...currentEntries.entries.keys(), ...nextEntries.entries.keys()]);
		for (const id of ids) collectChangedConfigPaths(currentEntries.entries.get(id), nextEntries.entries.get(id), `${basePath}[]`, out);
		return out;
	}
	if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
		const keys = new Set([...Object.keys(currentValue), ...Object.keys(nextValue)]);
		for (const key of keys) collectChangedConfigPaths(currentValue[key], nextValue[key], basePath ? `${basePath}.${key}` : key, out);
		return out;
	}
	out.add(normalizeGatewayConfigPath(basePath));
	return out;
}
function pathSegmentMatches(patternSegment, pathSegment) {
	return patternSegment === "*" || patternSegment === pathSegment;
}
function isAllowedGatewayConfigPath(path) {
	const pathSegments = path.split(".");
	return ALLOWED_GATEWAY_CONFIG_PATHS.some((pattern) => {
		const patternSegments = pattern.split(".");
		if (patternSegments.length > pathSegments.length) return false;
		for (let i = 0; i < patternSegments.length; i += 1) if (!pathSegmentMatches(patternSegments[i], pathSegments[i])) return false;
		return true;
	});
}
function assertGatewayConfigMutationAllowed(params) {
	const parsed = parseGatewayConfigMutationRaw(params.raw, params.action);
	const nextConfig = params.action === "config.apply" ? parsed : applyMergePatch(params.currentConfig, parsed, { mergeObjectArraysById: true });
	const disallowedPaths = [...collectChangedConfigPaths(params.currentConfig, nextConfig)].toSorted().filter((path) => !isAllowedGatewayConfigPath(path));
	if (disallowedPaths.length > 0) throw new Error(`gateway ${params.action} cannot change protected config paths: ${disallowedPaths.join(", ")}`);
	const currentFlags = new Set(collectEnabledInsecureOrDangerousFlags(params.currentConfig));
	const newlyEnabled = collectEnabledInsecureOrDangerousFlags(nextConfig).filter((f) => !currentFlags.has(f));
	if (newlyEnabled.length > 0) throw new Error(`gateway ${params.action} cannot enable dangerous config flags: ${newlyEnabled.join(", ")}`);
}
const GatewayToolSchema = Type.Object({
	action: stringEnum([
		"restart",
		"config.get",
		"config.schema.lookup",
		"config.apply",
		"config.patch",
		"update.run"
	]),
	delayMs: Type.Optional(Type.Number()),
	reason: Type.Optional(Type.String()),
	continuationMessage: Type.Optional(Type.String()),
	gatewayUrl: Type.Optional(Type.String()),
	gatewayToken: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Number()),
	path: Type.Optional(Type.String()),
	raw: Type.Optional(Type.String()),
	baseHash: Type.Optional(Type.String()),
	sessionKey: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	restartDelayMs: Type.Optional(Type.Number())
});
function createGatewayTool(opts) {
	return {
		label: "Gateway",
		name: "gateway",
		description: "Gateway restart/config/update. Before config edits, use config.schema.lookup with targeted dot path. Prefer config.patch for partial merge; config.apply only full replace. Writes hot-reload or restart as needed. Always pass human `note` for post-restart delivery. If still owe the user a reply, pass one-shot `continuationMessage`; do not write restart sentinel files directly.",
		parameters: GatewayToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const action = readStringParam$1(params, "action", { required: true });
			if (action === "restart") {
				if (!isRestartEnabled(opts?.config)) throw new Error("Gateway restart is disabled (commands.restart=false).");
				const sessionKey = normalizeOptionalString(params.sessionKey) ?? normalizeOptionalString(opts?.agentSessionKey);
				const delayMs = typeof params.delayMs === "number" && Number.isFinite(params.delayMs) ? Math.floor(params.delayMs) : void 0;
				const reason = normalizeOptionalString(params.reason)?.slice(0, 200);
				const note = normalizeOptionalString(params.note);
				const continuationMessage = normalizeOptionalString(params.continuationMessage);
				const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
				const payload = {
					kind: "restart",
					status: "ok",
					ts: Date.now(),
					sessionKey,
					deliveryContext,
					threadId,
					message: note ?? reason ?? null,
					continuation: buildRestartSuccessContinuation({
						sessionKey,
						continuationMessage
					}),
					doctorHint: formatDoctorNonInteractiveHint(),
					stats: {
						mode: "gateway.restart",
						reason
					}
				};
				log$6.info(`gateway tool: restart requested (delayMs=${delayMs ?? "default"}, reason=${reason ?? "none"})`);
				let sentinelPath = null;
				return jsonResult(scheduleGatewaySigusr1Restart({
					delayMs,
					reason,
					emitHooks: {
						beforeEmit: async () => {
							sentinelPath = await writeRestartSentinel(payload);
						},
						afterEmitRejected: async () => {
							await removeRestartSentinelFile(sentinelPath);
						}
					}
				}));
			}
			const gatewayOpts = readGatewayCallOptions(params);
			const resolveGatewayWriteMeta = () => {
				return {
					sessionKey: normalizeOptionalString(params.sessionKey) ?? normalizeOptionalString(opts?.agentSessionKey),
					note: normalizeOptionalString(params.note),
					restartDelayMs: typeof params.restartDelayMs === "number" && Number.isFinite(params.restartDelayMs) ? Math.floor(params.restartDelayMs) : void 0
				};
			};
			const resolveConfigWriteParams = async () => {
				const raw = readStringParam$1(params, "raw", { required: true });
				const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
				const snapshotConfig = getSnapshotConfig(snapshot);
				let baseHash = readStringParam$1(params, "baseHash");
				if (!baseHash) baseHash = resolveBaseHashFromSnapshot(snapshot);
				if (!baseHash) throw new Error("Missing baseHash from config snapshot.");
				return {
					raw,
					baseHash,
					snapshotConfig,
					...resolveGatewayWriteMeta()
				};
			};
			if (action === "config.get") return jsonResult({
				ok: true,
				result: await callGatewayTool("config.get", gatewayOpts, {})
			});
			if (action === "config.schema.lookup") return jsonResult({
				ok: true,
				result: await callGatewayTool("config.schema.lookup", gatewayOpts, { path: readStringParam$1(params, "path", {
					required: true,
					label: "path"
				}) })
			});
			if (action === "config.apply") {
				const { raw, baseHash, snapshotConfig, sessionKey, note, restartDelayMs } = await resolveConfigWriteParams();
				assertGatewayConfigMutationAllowed({
					action: "config.apply",
					currentConfig: snapshotConfig,
					raw
				});
				return jsonResult({
					ok: true,
					result: stripConfigWriteResultPayload(await callGatewayTool("config.apply", gatewayOpts, {
						raw,
						baseHash,
						sessionKey,
						note,
						restartDelayMs
					}))
				});
			}
			if (action === "config.patch") {
				const { raw, baseHash, snapshotConfig, sessionKey, note, restartDelayMs } = await resolveConfigWriteParams();
				assertGatewayConfigMutationAllowed({
					action: "config.patch",
					currentConfig: snapshotConfig,
					raw
				});
				return jsonResult({
					ok: true,
					result: stripConfigWriteResultPayload(await callGatewayTool("config.patch", gatewayOpts, {
						raw,
						baseHash,
						sessionKey,
						note,
						restartDelayMs
					}))
				});
			}
			if (action === "update.run") {
				const { sessionKey, note, restartDelayMs } = resolveGatewayWriteMeta();
				const continuationMessage = normalizeOptionalString(params.continuationMessage);
				const updateTimeoutMs = gatewayOpts.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
				return jsonResult({
					ok: true,
					result: await callGatewayTool("update.run", {
						...gatewayOpts,
						timeoutMs: updateTimeoutMs
					}, {
						sessionKey,
						note,
						continuationMessage,
						restartDelayMs,
						timeoutMs: updateTimeoutMs
					})
				});
			}
			throw new Error(`Unknown action: ${action}`);
		}
	};
}
//#endregion
//#region src/agents/tools/heartbeat-response-tool.ts
const HeartbeatResponseToolSchema = Type.Object({
	outcome: stringEnum(HEARTBEAT_TOOL_OUTCOMES),
	notify: Type.Boolean(),
	summary: Type.String(),
	notificationText: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
	priority: optionalStringEnum(HEARTBEAT_TOOL_PRIORITIES),
	nextCheck: Type.Optional(Type.String())
}, { additionalProperties: false });
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readRequiredBoolean(params, key) {
	const raw = readSnakeCaseParamRaw(params, key);
	if (typeof raw !== "boolean") throw new ToolInputError(`${key} required`);
	return raw;
}
function createHeartbeatResponseTool() {
	return {
		label: "Heartbeat",
		name: HEARTBEAT_RESPONSE_TOOL_NAME,
		displaySummary: "Record heartbeat outcome/notify choice.",
		description: "Record heartbeat result. `notify=false` no visible send. `notify=true` needs concise notificationText.",
		parameters: HeartbeatResponseToolSchema,
		execute: async (_toolCallId, args) => {
			if (!isRecord$1(args)) throw new ToolInputError("Heartbeat response arguments required");
			readRequiredBoolean(args, "notify");
			const response = normalizeHeartbeatToolResponse(args);
			if (!response) throw new ToolInputError("Invalid heartbeat response. Provide outcome, notify, and non-empty summary.");
			return jsonResult({
				status: "recorded",
				...response
			});
		}
	};
}
//#endregion
//#region src/agents/session-async-task-status.ts
const DEFAULT_ACTIVE_STATUSES = new Set(["queued", "running"]);
function findActiveSessionTask(params) {
	const normalizedSessionKey = normalizeOptionalString(params.sessionKey);
	if (!normalizedSessionKey) return;
	const statuses = params.statuses ?? DEFAULT_ACTIVE_STATUSES;
	const taskKind = normalizeOptionalString(params.taskKind);
	const taskLabel = normalizeOptionalString(params.task);
	const sourceIdPrefix = normalizeOptionalString(params.sourceIdPrefix);
	const matches = listTasksForOwnerKey(normalizedSessionKey).filter((task) => {
		if (task.scopeKind !== "session") return false;
		if (params.runtime && task.runtime !== params.runtime) return false;
		if (!statuses.has(task.status)) return false;
		if (taskKind && task.taskKind !== taskKind) return false;
		if (taskLabel) {
			if (normalizeOptionalString(task.task) !== taskLabel) return false;
		}
		if (sourceIdPrefix) {
			const sourceId = normalizeOptionalString(task.sourceId) ?? "";
			if (sourceId !== sourceIdPrefix && !sourceId.startsWith(`${sourceIdPrefix}:`)) return false;
		}
		return true;
	});
	if (matches.length === 0) return;
	return matches.find((task) => task.status === "running") ?? matches[0];
}
function buildSessionAsyncTaskStatusDetails(task) {
	return {
		async: true,
		active: true,
		existingTask: true,
		status: task.status,
		task: {
			taskId: task.taskId,
			...task.runId ? { runId: task.runId } : {}
		},
		...task.taskKind ? { taskKind: task.taskKind } : {},
		...task.progressSummary ? { progressSummary: task.progressSummary } : {},
		...task.sourceId ? { sourceId: task.sourceId } : {}
	};
}
//#endregion
//#region src/agents/media-generation-task-status-shared.ts
const recentMediaGenerationTaskStarts = /* @__PURE__ */ new Map();
const RECENT_MEDIA_GENERATION_TASK_START_CACHE_MS = 2 * 6e4;
function buildMediaGenerationRequestKey(value) {
	return stableStringify(value);
}
function buildRecentMediaGenerationTaskKey(params) {
	const sessionKey = normalizeOptionalString(params.sessionKey);
	const taskKind = normalizeOptionalString(params.taskKind);
	const sourcePrefix = normalizeOptionalString(params.sourcePrefix);
	if (!sessionKey || !taskKind || !sourcePrefix) return;
	return `${sessionKey}\0${taskKind}\0${sourcePrefix}`;
}
function isRecentMediaGenerationTaskRecord(params) {
	const activityAt = params.task.endedAt ?? params.task.lastEventAt ?? params.task.startedAt ?? params.task.createdAt;
	return Number.isFinite(activityAt) && params.nowMs - activityAt <= params.maxAgeMs;
}
function pruneRecentMediaGenerationTaskStarts(params) {
	for (const [key, entries] of recentMediaGenerationTaskStarts.entries()) {
		if (params.preserveKey === key) continue;
		const freshEntries = entries.filter((entry) => isRecentMediaGenerationTaskRecord({
			task: entry.task,
			...params
		}));
		if (freshEntries.length > 0) recentMediaGenerationTaskStarts.set(key, freshEntries);
		else recentMediaGenerationTaskStarts.delete(key);
	}
}
function mediaGenerationSourceMatches(task, sourcePrefix) {
	const sourceId = task.sourceId?.trim() ?? "";
	return sourceId === sourcePrefix || sourceId.startsWith(`${sourcePrefix}:`);
}
function mediaGenerationTaskLabelMatches(task, taskLabel) {
	return normalizeOptionalString(task.task) === taskLabel;
}
function isTaskStillBlockingDuplicateGuard(task) {
	return task.status === "queued" || task.status === "running";
}
function isTaskRecentSuccessfulDuplicate(params) {
	return params.task.status === "succeeded" && Boolean(params.requestKey && params.cachedRequestKey === params.requestKey) && isRecentMediaGenerationTaskRecord({
		task: params.task,
		maxAgeMs: params.maxAgeMs,
		nowMs: params.nowMs
	});
}
function recentMediaGenerationTaskStartMatches(left, right) {
	if (left.requestKey && right.requestKey) return left.requestKey === right.requestKey;
	if (left.task.runId && right.task.runId) return left.task.runId === right.task.runId;
	return left.task.taskId === right.task.taskId;
}
function findPersistedTaskForRecentMediaGenerationStart(params) {
	return listFreshTasksForOwnerKey(params.sessionKey).find((task) => {
		if (task.runtime !== "cli" || task.scopeKind !== "session" || task.taskKind !== params.taskKind || !mediaGenerationSourceMatches(task, params.sourcePrefix)) return false;
		if (task.taskId === params.cachedTask.taskId) return true;
		return Boolean(task.runId && task.runId === params.cachedTask.runId);
	});
}
function recordRecentMediaGenerationTaskStartForSession(params) {
	const key = buildRecentMediaGenerationTaskKey(params);
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (!key || !sessionKey) return;
	const nowMs = params.nowMs ?? Date.now();
	pruneRecentMediaGenerationTaskStarts({
		maxAgeMs: RECENT_MEDIA_GENERATION_TASK_START_CACHE_MS,
		nowMs,
		preserveKey: key
	});
	const entry = {
		requestKey: normalizeOptionalString(params.requestKey),
		task: {
			taskId: params.taskId,
			runtime: "cli",
			taskKind: params.taskKind,
			sourceId: params.providerId?.trim() ? `${params.sourcePrefix}:${params.providerId.trim()}` : params.sourcePrefix,
			requesterSessionKey: sessionKey,
			ownerKey: sessionKey,
			scopeKind: "session",
			...params.runId ? { runId: params.runId } : {},
			task: params.taskLabel,
			status: "running",
			deliveryStatus: "not_applicable",
			notifyPolicy: "silent",
			createdAt: nowMs,
			startedAt: nowMs,
			lastEventAt: nowMs,
			progressSummary: params.progressSummary
		}
	};
	const previousEntries = (recentMediaGenerationTaskStarts.get(key) ?? []).filter((entry) => isRecentMediaGenerationTaskRecord({
		task: entry.task,
		maxAgeMs: RECENT_MEDIA_GENERATION_TASK_START_CACHE_MS,
		nowMs
	}));
	recentMediaGenerationTaskStarts.set(key, [...previousEntries.filter((previousEntry) => !recentMediaGenerationTaskStartMatches(previousEntry, entry)), entry]);
}
function findRecentStartedMediaGenerationTaskForSession(params) {
	const key = buildRecentMediaGenerationTaskKey(params);
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (!key || !sessionKey) return;
	const nowMs = params.nowMs ?? Date.now();
	const maxAgeMs = Math.max(0, Math.floor(params.maxAgeMs));
	const taskLabel = normalizeOptionalString(params.taskLabel);
	pruneRecentMediaGenerationTaskStarts({
		maxAgeMs,
		nowMs,
		preserveKey: key
	});
	const entries = recentMediaGenerationTaskStarts.get(key);
	if (!entries?.length) return;
	const retainedEntries = [];
	for (const entry of entries.toReversed()) {
		const task = entry.task;
		const persistedTask = findPersistedTaskForRecentMediaGenerationStart({
			sessionKey,
			cachedTask: task,
			taskKind: params.taskKind,
			sourcePrefix: params.sourcePrefix
		});
		if (persistedTask) {
			const persistedTaskLabelMatches = !taskLabel || mediaGenerationTaskLabelMatches(persistedTask, taskLabel);
			if (isTaskStillBlockingDuplicateGuard(persistedTask) && persistedTaskLabelMatches) return persistedTask;
			if (isTaskRecentSuccessfulDuplicate({
				task: persistedTask,
				requestKey: params.requestKey,
				cachedRequestKey: entry.requestKey,
				maxAgeMs,
				nowMs
			})) return persistedTask;
			if (isRecentMediaGenerationTaskRecord({
				task: persistedTask,
				maxAgeMs,
				nowMs
			})) retainedEntries.push(entry);
			continue;
		}
		if (isRecentMediaGenerationTaskRecord({
			task,
			maxAgeMs,
			nowMs
		})) {
			const cachedTaskLabelMatches = !taskLabel || mediaGenerationTaskLabelMatches(task, taskLabel);
			if (isTaskStillBlockingDuplicateGuard(task) && cachedTaskLabelMatches) return { ...task };
			retainedEntries.push(entry);
		}
	}
	if (retainedEntries.length > 0) recentMediaGenerationTaskStarts.set(key, retainedEntries.toReversed());
	else recentMediaGenerationTaskStarts.delete(key);
}
function getMediaGenerationTaskProviderId(task, sourcePrefix) {
	const sourceId = task.sourceId?.trim() ?? "";
	if (!sourceId.startsWith(`${sourcePrefix}:`)) return;
	return sourceId.slice(`${sourcePrefix}:`.length).trim() || void 0;
}
function findActiveMediaGenerationTaskForSession(params) {
	return listActiveMediaGenerationTasksForSession(params)[0];
}
function listActiveMediaGenerationTasksForSession(params) {
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (!sessionKey) return [];
	const taskLabel = normalizeOptionalString(params.taskLabel);
	const sourcePrefix = normalizeOptionalString(params.sourcePrefix);
	const matches = listFreshTasksForOwnerKey(sessionKey).filter((task) => {
		if (task.runtime !== "cli" || task.scopeKind !== "session" || task.taskKind !== params.taskKind || !isTaskStillBlockingDuplicateGuard(task)) return false;
		if (sourcePrefix && !mediaGenerationSourceMatches(task, sourcePrefix)) return false;
		if (taskLabel && !mediaGenerationTaskLabelMatches(task, taskLabel)) return false;
		return true;
	});
	return [...matches.filter((task) => task.status === "running"), ...matches.filter((task) => task.status !== "running")];
}
function findDuplicateGuardMediaGenerationTaskForSession(params) {
	return findRecentStartedMediaGenerationTaskForSession(params) ?? findActiveMediaGenerationTaskForSession({
		sessionKey: params.sessionKey,
		taskKind: params.taskKind,
		sourcePrefix: params.sourcePrefix,
		taskLabel: params.taskLabel
	}) ?? void 0;
}
function buildMediaGenerationTaskStatusDetails(params) {
	const provider = getMediaGenerationTaskProviderId(params.task, params.sourcePrefix);
	return {
		...buildSessionAsyncTaskStatusDetails(params.task),
		active: isTaskStillBlockingDuplicateGuard(params.task),
		...provider ? { provider } : {}
	};
}
function buildMediaGenerationTaskStatusListDetails(params) {
	return {
		async: true,
		active: true,
		existingTask: true,
		taskCount: params.tasks.length,
		tasks: params.tasks.map((task) => buildMediaGenerationTaskStatusDetails({
			task,
			sourcePrefix: params.sourcePrefix
		}))
	};
}
function buildMediaGenerationTaskStatusText(params) {
	const provider = getMediaGenerationTaskProviderId(params.task, params.sourcePrefix);
	const active = params.task.status === "queued" || params.task.status === "running" || params.task.terminalOutcome === "blocked";
	return [
		active ? `${params.nounLabel} task ${params.task.taskId} is already ${params.task.status}${provider ? ` with ${provider}` : ""}.` : `${params.nounLabel} task ${params.task.taskId} recently ${params.task.status}${provider ? ` with ${provider}` : ""}.`,
		params.task.progressSummary ? `Progress: ${params.task.progressSummary}.` : null,
		params.duplicateGuard ? active ? `Do not call ${params.toolName} again for this request. Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here.` : `Do not call ${params.toolName} again for the same request; this recent ${params.completionLabel} generation already completed.` : `Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here when it's ready.`
	].filter((entry) => Boolean(entry)).join("\n");
}
function buildMediaGenerationTaskStatusListText(params) {
	const nounLabel = normalizeLowercaseStringOrEmpty(params.nounLabel);
	return [
		`${params.tasks.length} active ${nounLabel} tasks are queued or running for this session.`,
		...params.tasks.map((task) => {
			const provider = getMediaGenerationTaskProviderId(task, params.sourcePrefix);
			const runId = task.runId ? ` (run ${task.runId})` : "";
			const progress = task.progressSummary ? ` Progress: ${task.progressSummary}.` : "";
			return `- Task ${task.taskId}${runId} is ${task.status}${provider ? ` with ${provider}` : ""}.${progress}`;
		}),
		`Wait for the completion events; the completion agent will send the finished ${params.completionLabel} here when each is ready.`,
		`Only start a new ${params.toolName} call if the user clearly asks for different/new ${params.completionLabel}.`
	].join("\n");
}
function buildActiveMediaGenerationTaskPromptContextForSession(params) {
	const task = findActiveMediaGenerationTaskForSession({
		sessionKey: params.sessionKey,
		taskKind: params.taskKind,
		sourcePrefix: params.sourcePrefix
	});
	if (!task) return;
	const provider = getMediaGenerationTaskProviderId(task, params.sourcePrefix);
	return [
		`An active ${normalizeLowercaseStringOrEmpty(params.nounLabel)} background task already exists for this session.`,
		`Task ${task.taskId} is currently ${task.status}${provider ? ` via ${provider}` : ""}.`,
		task.progressSummary ? `Current progress: ${task.progressSummary}.` : null,
		`Do not call \`${params.toolName}\` again for the same request while that task is queued or running.`,
		`If the user asks for progress or whether the work is async, explain the active task state or call \`${params.toolName}\` with \`action:"status"\` instead of starting a new generation.`,
		`Only start a new \`${params.toolName}\` call if the user clearly asks for different/new ${params.completionLabel}.`
	].filter((entry) => Boolean(entry)).join("\n");
}
//#endregion
//#region src/agents/image-generation-task-status.ts
const IMAGE_GENERATION_TASK_KIND = "image_generation";
const IMAGE_GENERATION_SOURCE_PREFIX = "image_generate";
const RECENT_IMAGE_GENERATION_DUPLICATE_GUARD_MS = 2 * 6e4;
function findActiveImageGenerationTaskForSession(sessionKey, params) {
	return findActiveMediaGenerationTaskForSession({
		sessionKey,
		taskKind: IMAGE_GENERATION_TASK_KIND,
		sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
		taskLabel: params?.prompt
	});
}
function listActiveImageGenerationTasksForSession(sessionKey) {
	return listActiveMediaGenerationTasksForSession({
		sessionKey,
		taskKind: IMAGE_GENERATION_TASK_KIND,
		sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX
	});
}
function findDuplicateGuardImageGenerationTaskForSession(sessionKey, params) {
	return findDuplicateGuardMediaGenerationTaskForSession({
		sessionKey,
		taskKind: IMAGE_GENERATION_TASK_KIND,
		sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
		taskLabel: params?.prompt,
		requestKey: params?.requestKey,
		maxAgeMs: RECENT_IMAGE_GENERATION_DUPLICATE_GUARD_MS
	});
}
function buildImageGenerationTaskStatusDetails(task) {
	return buildMediaGenerationTaskStatusDetails({
		task,
		sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX
	});
}
function buildImageGenerationTaskStatusListDetails(tasks) {
	return buildMediaGenerationTaskStatusListDetails({
		tasks,
		sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX
	});
}
function buildImageGenerationTaskStatusText(task, params) {
	return buildMediaGenerationTaskStatusText({
		task,
		sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
		nounLabel: "Image generation",
		toolName: "image_generate",
		completionLabel: "image",
		duplicateGuard: params?.duplicateGuard
	});
}
function buildImageGenerationTaskStatusListText(tasks) {
	return buildMediaGenerationTaskStatusListText({
		tasks,
		sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
		nounLabel: "Image generation",
		toolName: "image_generate",
		completionLabel: "images"
	});
}
function buildActiveImageGenerationTaskPromptContextForSession(sessionKey) {
	return buildActiveMediaGenerationTaskPromptContextForSession({
		sessionKey,
		taskKind: IMAGE_GENERATION_TASK_KIND,
		sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
		nounLabel: "Image generation",
		toolName: "image_generate",
		completionLabel: "images"
	});
}
//#endregion
//#region src/agents/tools/media-generate-background-shared.ts
const log$5 = createSubsystemLogger("agents/tools/media-generate-background-shared");
const MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS = 6e4;
function touchMediaGenerationTaskRunContext(handle) {
	registerAgentRunContext(handle.runId, {
		sessionKey: handle.requesterSessionKey,
		lastActiveAt: Date.now()
	});
}
function createMediaGenerationTaskRun(params) {
	const sessionKey = params.sessionKey?.trim();
	if (!sessionKey) return null;
	const runId = `tool:${params.toolName}:${crypto.randomUUID()}`;
	try {
		const handle = {
			taskId: createRunningTaskRun({
				runtime: "cli",
				taskKind: params.taskKind,
				sourceId: params.providerId ? `${params.toolName}:${params.providerId}` : params.toolName,
				requesterSessionKey: sessionKey,
				ownerKey: sessionKey,
				scopeKind: "session",
				requesterOrigin: params.requesterOrigin,
				childSessionKey: sessionKey,
				runId,
				label: params.label,
				task: params.prompt,
				deliveryStatus: "not_applicable",
				notifyPolicy: "silent",
				startedAt: Date.now(),
				lastEventAt: Date.now(),
				progressSummary: params.queuedProgressSummary
			}).taskId,
			runId,
			requesterSessionKey: sessionKey,
			requesterOrigin: params.requesterOrigin,
			taskLabel: params.prompt
		};
		touchMediaGenerationTaskRunContext(handle);
		return handle;
	} catch (error) {
		log$5.warn("Failed to create media generation task ledger record", {
			sessionKey,
			toolName: params.toolName,
			providerId: params.providerId,
			error
		});
		return null;
	}
}
function recordMediaGenerationTaskProgress(params) {
	if (!params.handle) return;
	touchMediaGenerationTaskRunContext(params.handle);
	recordTaskRunProgressByRunId({
		runId: params.handle.runId,
		runtime: "cli",
		sessionKey: params.handle.requesterSessionKey,
		lastEventAt: Date.now(),
		progressSummary: params.progressSummary,
		eventSummary: params.eventSummary
	});
}
async function withMediaGenerationTaskKeepalive(params) {
	if (!params.handle) return await params.run();
	const interval = setInterval(() => {
		recordMediaGenerationTaskProgress({
			handle: params.handle,
			progressSummary: params.progressSummary,
			eventSummary: params.eventSummary
		});
	}, MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS);
	interval.unref?.();
	try {
		return await params.run();
	} finally {
		clearInterval(interval);
	}
}
function completeMediaGenerationTaskRun(params) {
	if (!params.handle) return;
	try {
		const endedAt = Date.now();
		const target = params.count === 1 ? params.paths[0] : `${params.count} files`;
		completeTaskRunByRunId({
			runId: params.handle.runId,
			runtime: "cli",
			sessionKey: params.handle.requesterSessionKey,
			endedAt,
			lastEventAt: endedAt,
			progressSummary: `Generated ${params.count} ${params.generatedLabel}${params.count === 1 ? "" : "s"}`,
			terminalSummary: `Generated ${params.count} ${params.generatedLabel}${params.count === 1 ? "" : "s"} with ${params.provider}/${params.model}${target ? ` -> ${target}` : ""}.`
		});
	} finally {
		clearAgentRunContext(params.handle.runId);
	}
}
function failMediaGenerationTaskRun(params) {
	if (!params.handle) return;
	try {
		const endedAt = Date.now();
		const errorText = formatErrorMessage(params.error);
		failTaskRunByRunId({
			runId: params.handle.runId,
			runtime: "cli",
			sessionKey: params.handle.requesterSessionKey,
			endedAt,
			lastEventAt: endedAt,
			error: errorText,
			progressSummary: params.progressSummary,
			terminalSummary: errorText
		});
	} finally {
		clearAgentRunContext(params.handle.runId);
	}
}
function buildMediaGenerationReplyInstruction(params) {
	if (params.status === "ok") return [
		`The ${params.completionLabel} is ready for the original chat.`,
		"This route requires message-tool delivery: the user will NOT see your normal assistant final reply.",
		"Call the message tool with action=\"send\" to the original/current chat, put a short caption in the message, and attach every structured attachment from the internal event.",
		`After the message tool succeeds, reply only ${SILENT_REPLY_TOKEN}.`,
		"Do not rely on text-only output; the media must be sent as message-tool attachments."
	].join(" ");
	return [
		`${params.completionLabel[0]?.toUpperCase() ?? "T"}${params.completionLabel.slice(1)} generation task failed for the original chat.`,
		"This route requires message-tool delivery: the user will NOT see your normal assistant final reply.",
		"Call the message tool with action=\"send\" to the original/current chat and put the failure summary in the message.",
		`After the message tool succeeds, reply only ${SILENT_REPLY_TOKEN}.`,
		"Keep internal task/session details private and do not copy the internal event text verbatim."
	].join(" ");
}
function createDefaultMediaGenerateBackgroundScheduler(params) {
	return (work) => {
		queueMicrotask(() => {
			work().catch((error) => {
				params.onCrash(`Detached ${params.toolName} job crashed`, { error });
			});
		});
	};
}
function buildMediaGenerationStartedToolResult(params) {
	return {
		content: [{
			type: "text",
			text: [`Background task started for ${params.generationLabel} generation (${params.taskHandle?.taskId ?? "unknown"}). Do not call ${params.toolName} again for this request. Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here when it's ready.`, ...params.messages ?? []].filter((entry) => Boolean(entry)).join("\n")
		}],
		details: {
			async: true,
			status: "started",
			...params.taskHandle ? {
				taskId: params.taskHandle.taskId,
				runId: params.taskHandle.runId,
				task: {
					taskId: params.taskHandle.taskId,
					runId: params.taskHandle.runId
				}
			} : {},
			...params.detailExtras
		},
		terminate: true
	};
}
async function notifyMediaGenerationAsyncTaskStarted(params) {
	if (!params.callback) return;
	try {
		await params.callback(params.message);
	} catch (error) {
		params.onFailure("Media generation async-start callback failed", {
			toolName: params.toolName,
			taskId: params.handle?.taskId,
			runId: params.handle?.runId,
			error
		});
	}
}
function scheduleMediaGenerationTaskCompletion(params) {
	params.scheduleBackgroundWork(async () => {
		try {
			const executed = await withMediaGenerationTaskKeepalive({
				handle: params.handle,
				progressSummary: params.progressSummary,
				run: params.run
			});
			params.lifecycle.recordTaskProgress({
				handle: params.handle,
				progressSummary: "Generated media; delivering completion"
			});
			let completionDelivered = false;
			try {
				completionDelivered = await params.lifecycle.wakeTaskCompletion({
					config: params.config,
					handle: params.handle,
					status: "ok",
					statusLabel: "completed successfully",
					result: executed.wakeResult,
					attachments: executed.attachments,
					mediaUrls: executed.mediaUrls
				});
			} catch (error) {
				params.onWakeFailure(`${params.toolName} completion wake failed after successful generation`, {
					taskId: params.handle?.taskId,
					runId: params.handle?.runId,
					error
				});
			}
			if (!completionDelivered) throw new Error(`${params.toolName} completion delivery failed after successful generation`);
			params.lifecycle.completeTaskRun({
				handle: params.handle,
				provider: executed.provider,
				model: executed.model,
				count: executed.count,
				paths: executed.paths
			});
		} catch (error) {
			params.lifecycle.failTaskRun({
				handle: params.handle,
				error
			});
			await params.lifecycle.wakeTaskCompletion({
				config: params.config,
				handle: params.handle,
				status: "error",
				statusLabel: "failed",
				result: formatErrorMessage(error)
			});
		}
	});
}
async function wakeMediaGenerationTaskCompletion(params) {
	if (!params.handle) return true;
	const announceId = `${params.toolName}:${params.handle.taskId}:${params.status}`;
	const mediaUrls = Array.from(new Set([...params.mediaUrls ?? [], ...mediaUrlsFromGeneratedAttachments(params.attachments)]));
	const internalEvents = [{
		type: "task_completion",
		source: params.eventSource,
		childSessionKey: `${params.toolName}:${params.handle.taskId}`,
		childSessionId: params.handle.taskId,
		announceType: params.announceType,
		taskLabel: params.handle.taskLabel,
		status: params.status,
		statusLabel: params.statusLabel,
		result: params.result,
		...params.attachments?.length ? { attachments: params.attachments } : {},
		...mediaUrls.length ? { mediaUrls } : {},
		...params.statsLine?.trim() ? { statsLine: params.statsLine } : {},
		replyInstruction: buildMediaGenerationReplyInstruction({
			status: params.status,
			completionLabel: params.completionLabel
		})
	}];
	const triggerMessage = formatAgentInternalEventsForPrompt(internalEvents) || `A ${params.completionLabel} generation task finished. Process the completion update now.`;
	const delivery = await deliverSubagentAnnouncement({
		requesterSessionKey: params.handle.requesterSessionKey,
		targetRequesterSessionKey: params.handle.requesterSessionKey,
		announceId,
		triggerMessage,
		steerMessage: triggerMessage,
		internalEvents,
		summaryLine: params.handle.taskLabel,
		requesterSessionOrigin: params.handle.requesterOrigin,
		requesterOrigin: params.handle.requesterOrigin,
		completionDirectOrigin: params.handle.requesterOrigin,
		directOrigin: params.handle.requesterOrigin,
		sourceSessionKey: `${params.toolName}:${params.handle.taskId}`,
		sourceChannel: INTERNAL_MESSAGE_CHANNEL,
		sourceTool: params.toolName,
		requesterIsSubagent: false,
		expectsCompletionMessage: true,
		bestEffortDeliver: true,
		directIdempotencyKey: announceId
	});
	if (delivery.delivered) return true;
	if (params.status === "error") {
		if (await tryDeliverMediaGenerationFailureDirect({
			config: params.config,
			handle: params.handle,
			toolName: params.toolName,
			completionLabel: params.completionLabel,
			result: params.result
		})) return true;
	}
	if (delivery.error) log$5.error("Media generation completion wake failed; requester session was not woken", {
		taskId: params.handle.taskId,
		runId: params.handle.runId,
		toolName: params.toolName,
		error: delivery.error
	});
	return false;
}
async function tryDeliverMediaGenerationFailureDirect(params) {
	const origin = normalizeDeliveryContext(params.handle.requesterOrigin);
	if (!origin?.channel || !origin.to || !isDeliverableMessageChannel(origin.channel)) return false;
	const label = `${params.completionLabel[0]?.toUpperCase() ?? "M"}${params.completionLabel.slice(1)}`;
	const agentId = resolveAgentIdFromSessionKey(params.handle.requesterSessionKey);
	const idempotencyKey = `${params.toolName}:${params.handle.taskId}:error:direct`;
	try {
		const { sendMessage } = await import("./task-registry-delivery-runtime-oTt1u1XX.js");
		await sendMessage({
			cfg: params.config,
			channel: origin.channel,
			to: origin.to,
			accountId: origin.accountId,
			threadId: origin.threadId,
			content: `${label} generation failed: ${params.result}`,
			requesterSessionKey: params.handle.requesterSessionKey,
			agentId,
			idempotencyKey,
			mirror: {
				sessionKey: params.handle.requesterSessionKey,
				agentId,
				idempotencyKey
			}
		});
		return true;
	} catch (error) {
		log$5.warn("Direct media generation failure delivery failed; falling back to agent wake", {
			taskId: params.handle.taskId,
			runId: params.handle.runId,
			toolName: params.toolName,
			error
		});
		return false;
	}
}
function createMediaGenerationTaskLifecycle(params) {
	return {
		createTaskRun(runParams) {
			return createMediaGenerationTaskRun({
				...runParams,
				toolName: params.toolName,
				taskKind: params.taskKind,
				label: params.label,
				queuedProgressSummary: params.queuedProgressSummary
			});
		},
		recordTaskProgress(progressParams) {
			recordMediaGenerationTaskProgress(progressParams);
		},
		completeTaskRun(completionParams) {
			completeMediaGenerationTaskRun({
				...completionParams,
				generatedLabel: params.generatedLabel
			});
		},
		failTaskRun(failureParams) {
			failMediaGenerationTaskRun({
				...failureParams,
				progressSummary: params.failureProgressSummary
			});
		},
		async wakeTaskCompletion(completionParams) {
			return await wakeMediaGenerationTaskCompletion({
				...completionParams,
				eventSource: params.eventSource,
				announceType: params.announceType,
				toolName: params.toolName,
				completionLabel: params.completionLabel
			});
		}
	};
}
//#endregion
//#region src/agents/tools/image-generate-background.ts
const imageGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
	toolName: "image_generate",
	taskKind: IMAGE_GENERATION_TASK_KIND,
	label: "Image generation",
	queuedProgressSummary: "Queued image generation",
	generatedLabel: "image",
	failureProgressSummary: "Image generation failed",
	eventSource: "image_generation",
	announceType: "image generation task",
	completionLabel: "image"
});
const createImageGenerationTaskRun = (...params) => imageGenerationTaskLifecycle.createTaskRun(...params);
const recordImageGenerationTaskProgress = (...params) => imageGenerationTaskLifecycle.recordTaskProgress(...params);
const completeImageGenerationTaskRun = (...params) => imageGenerationTaskLifecycle.completeTaskRun(...params);
const failImageGenerationTaskRun = (...params) => imageGenerationTaskLifecycle.failTaskRun(...params);
//#endregion
//#region src/agents/tools/media-tool-shared.ts
function applyImageModelConfigDefaults(cfg, imageModelConfig) {
	return applyAgentDefaultModelConfig(cfg, "imageModel", imageModelConfig);
}
function applyImageGenerationModelConfigDefaults(cfg, imageGenerationModelConfig) {
	return applyAgentDefaultModelConfig(cfg, "imageGenerationModel", imageGenerationModelConfig);
}
function applyVideoGenerationModelConfigDefaults(cfg, videoGenerationModelConfig) {
	return applyAgentDefaultModelConfig(cfg, "videoGenerationModel", videoGenerationModelConfig);
}
function applyMusicGenerationModelConfigDefaults(cfg, musicGenerationModelConfig) {
	return applyAgentDefaultModelConfig(cfg, "musicGenerationModel", musicGenerationModelConfig);
}
function readGenerationTimeoutMs(args) {
	const timeoutMs = readNumberParam(args, "timeoutMs", {
		integer: true,
		strict: true
	});
	if (timeoutMs === void 0) return;
	if (timeoutMs <= 0) throw new ToolInputError("timeoutMs must be a positive integer in milliseconds.");
	return timeoutMs;
}
function resolveRemoteMediaSsrfPolicy(cfg) {
	return cfg?.tools?.web?.fetch?.ssrfPolicy;
}
function applyAgentDefaultModelConfig(cfg, key, modelConfig) {
	if (!cfg) return;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				[key]: modelConfig
			}
		}
	};
}
function findCapabilityProviderById(params) {
	const selectedProvider = normalizeProviderId(params.providerId ?? "");
	return params.providers.find((provider) => normalizeProviderId(provider.id) === selectedProvider || (provider.aliases ?? []).some((alias) => normalizeProviderId(alias) === selectedProvider));
}
function parseCapabilityModelRefForProviders(params) {
	const raw = normalizeOptionalString(params.raw);
	if (!raw) return null;
	const parsed = params.parseModelRef(raw);
	if (parsed && findCapabilityProviderById({
		providers: params.providers,
		providerId: parsed.provider
	})) return parsed;
	const provider = params.providers.find((candidate) => {
		return [candidate.defaultModel, ...candidate.models ?? []].some((model) => normalizeOptionalString(model) === raw);
	});
	if (provider) return {
		provider: provider.id,
		model: raw
	};
	return parsed;
}
function isCapabilityProviderConfigured(params) {
	const provider = params.provider ?? findCapabilityProviderById({
		providers: params.providers,
		providerId: params.providerId
	});
	if (!provider) return params.providerId ? hasProviderAuthForTool({
		provider: params.providerId,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore
	}) : false;
	if (provider.isConfigured) return provider.isConfigured({
		cfg: params.cfg,
		agentDir: params.agentDir
	});
	return hasProviderAuthForTool({
		provider: provider.id,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore
	});
}
function resolveSelectedCapabilityProvider(params) {
	const selectedRef = parseCapabilityModelRefForProviders({
		providers: params.providers,
		raw: params.modelOverride,
		parseModelRef: params.parseModelRef
	}) ?? parseCapabilityModelRefForProviders({
		providers: params.providers,
		raw: params.modelConfig.primary,
		parseModelRef: params.parseModelRef
	});
	if (!selectedRef) return;
	return findCapabilityProviderById({
		providers: params.providers,
		providerId: selectedRef.provider
	});
}
function resolveCapabilityModelCandidatesForTool(params) {
	const providerDefaults = /* @__PURE__ */ new Map();
	for (const provider of params.providers) {
		const providerId = provider.id.trim();
		const modelId = provider.defaultModel?.trim();
		if (!providerId || !modelId || providerDefaults.has(providerId) || !isCapabilityProviderConfigured({
			providers: params.providers,
			provider,
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			agentDir: params.agentDir,
			authStore: params.authStore
		})) continue;
		const aliases = (provider.aliases ?? []).flatMap((alias) => {
			const normalized = normalizeProviderId(alias);
			return normalized ? [normalized] : [];
		});
		providerDefaults.set(providerId, {
			ref: `${providerId}/${modelId}`,
			aliases
		});
	}
	const primaryProvider = resolveDefaultModelRef(params.cfg).provider;
	const normalizedPrimaryProvider = normalizeProviderId(primaryProvider);
	const providerIds = [...providerDefaults.keys()].toSorted();
	const matchesPrimaryProvider = (providerId) => {
		const entry = providerDefaults.get(providerId);
		return normalizeProviderId(providerId) === normalizedPrimaryProvider || (entry?.aliases ?? []).includes(normalizedPrimaryProvider);
	};
	const orderedProviders = [...providerIds.filter(matchesPrimaryProvider), ...providerIds.filter((providerId) => !matchesPrimaryProvider(providerId))];
	const orderedRefs = [];
	const seen = /* @__PURE__ */ new Set();
	for (const providerId of orderedProviders) {
		const entry = providerDefaults.get(providerId);
		if (!entry || seen.has(entry.ref)) continue;
		seen.add(entry.ref);
		orderedRefs.push(entry.ref);
	}
	return orderedRefs;
}
function resolveCapabilityModelConfigForTool(params) {
	const explicit = coerceToolModelConfig(params.modelConfig);
	if (hasToolModelConfig$1(explicit)) return explicit;
	let resolvedProviders;
	const getProviders = () => {
		resolvedProviders ??= typeof params.providers === "function" ? params.providers() : params.providers;
		return resolvedProviders;
	};
	return buildToolModelConfigFromCandidates({
		explicit,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore,
		candidates: resolveCapabilityModelCandidatesForTool({
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			agentDir: params.agentDir,
			authStore: params.authStore,
			providers: getProviders()
		}),
		isProviderConfigured: (providerId) => isCapabilityProviderConfigured({
			providers: getProviders(),
			providerId,
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			agentDir: params.agentDir,
			authStore: params.authStore
		})
	});
}
function hasGenerationToolAvailability(params) {
	if (params.cfg?.plugins?.enabled === false) return false;
	if (hasToolModelConfig$1(coerceToolModelConfig(params.modelConfig))) return true;
	const providers = typeof params.providers === "function" ? params.providers() : params.providers;
	if (providers) return providers.some((provider) => isCapabilityProviderConfigured({
		providers,
		provider,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore
	}));
	const snapshot = getCurrentCapabilityMetadataSnapshot({
		config: params.cfg,
		workspaceDir: params.workspaceDir
	}) ?? loadCapabilityManifestSnapshot({
		cfg: params.cfg,
		workspaceDir: params.workspaceDir
	});
	if (hasSnapshotCapabilityAvailability({
		snapshot,
		key: params.providerKey,
		config: params.cfg,
		authStore: params.authStore
	})) return true;
	return listAvailableManifestContractValues({
		snapshot,
		contract: params.providerKey,
		config: params.cfg
	}).some((providerId) => hasProviderAuthForTool({
		provider: providerId,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore
	}));
}
function formatQuotedList(values) {
	if (values.length === 1) return `"${values[0]}"`;
	if (values.length === 2) return `"${values[0]}" or "${values[1]}"`;
	return `${values.slice(0, -1).map((value) => `"${value}"`).join(", ")}, or "${values[values.length - 1]}"`;
}
function resolveGenerateAction(params) {
	const raw = readStringParam$1(params.args, "action");
	if (!raw) return params.defaultAction;
	const normalized = normalizeOptionalLowercaseString(raw);
	if (normalized && params.allowed.includes(normalized)) return normalized;
	throw new ToolInputError(`action must be ${formatQuotedList(params.allowed)}`);
}
function readBooleanToolParam(params, key) {
	const raw = readSnakeCaseParamRaw(params, key);
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "string") {
		const normalized = normalizeOptionalLowercaseString(raw);
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
}
function normalizeMediaReferenceInputs(params) {
	const single = readStringParam$1(params.args, params.singularKey);
	const multiple = readStringArrayParam(params.args, params.pluralKey);
	const combined = [...single ? [single] : [], ...multiple ?? []];
	const deduped = [];
	const seen = /* @__PURE__ */ new Set();
	for (const candidate of combined) {
		const trimmed = candidate.trim();
		const dedupe = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
		if (!dedupe || seen.has(dedupe)) continue;
		seen.add(dedupe);
		deduped.push(trimmed);
	}
	if (deduped.length > params.maxCount) throw new ToolInputError(`Too many ${params.label}: ${deduped.length} provided, maximum is ${params.maxCount}.`);
	return deduped;
}
function buildMediaReferenceDetails(params) {
	if (params.entries.length === 1) {
		const entry = params.entries[0];
		if (!entry) return {};
		const rewriteKey = params.singleRewriteKey ?? "rewrittenFrom";
		return {
			[params.singleKey]: params.getResolvedInput(entry),
			...entry.rewrittenFrom ? { [rewriteKey]: entry.rewrittenFrom } : {}
		};
	}
	if (params.entries.length > 1) return { [params.pluralKey]: params.entries.map((entry) => ({
		[params.singleKey]: params.getResolvedInput(entry),
		...entry.rewrittenFrom ? { rewrittenFrom: entry.rewrittenFrom } : {}
	})) };
	return {};
}
function buildTaskRunDetails(handle) {
	return handle ? { task: {
		taskId: handle.taskId,
		runId: handle.runId
	} } : {};
}
function resolveMediaToolLocalRoots(workspaceDirRaw, options, _mediaSources) {
	const workspaceDir = normalizeWorkspaceDir(workspaceDirRaw);
	if (options?.workspaceOnly) return workspaceDir ? [workspaceDir] : [];
	const roots = getDefaultLocalRoots();
	return workspaceDir ? Array.from(new Set([...roots, workspaceDir])) : [...roots];
}
function resolvePromptAndModelOverride(args, defaultPrompt) {
	return {
		prompt: normalizeOptionalString(args.prompt) ?? defaultPrompt,
		modelOverride: normalizeOptionalString(args.model)
	};
}
function buildTextToolResult(result, extraDetails) {
	return {
		content: [{
			type: "text",
			text: result.text
		}],
		details: {
			model: `${result.provider}/${result.model}`,
			...extraDetails,
			attempts: result.attempts
		}
	};
}
function resolveModelFromRegistry(params) {
	const resolvedRef = normalizeModelRef(params.provider, params.modelId, { allowPluginNormalization: false });
	let model = params.modelRegistry.find(resolvedRef.provider, resolvedRef.model);
	if (!model && !resolvedRef.model.includes("/")) model = params.modelRegistry.find(resolvedRef.provider, `${resolvedRef.provider}/${resolvedRef.model}`);
	if (!model) throw new Error(`Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
	return model;
}
async function resolveModelRuntimeApiKey(params) {
	const apiKey = requireApiKey(await getApiKeyForModel({
		model: params.model,
		cfg: params.cfg,
		agentDir: params.agentDir
	}), params.model.provider);
	params.authStorage.setRuntimeApiKey(params.model.provider, apiKey);
	return apiKey;
}
//#endregion
//#region src/agents/tools/media-generate-tool-actions-shared.ts
function createMediaGenerateProviderListActionResult(params) {
	if (params.providers.length === 0) return {
		content: [{
			type: "text",
			text: params.emptyText
		}],
		details: { providers: [] }
	};
	const providerDetails = params.providers.map((provider) => {
		const modes = params.listModes(provider);
		const models = listMediaGenerationProviderModels(provider);
		return {
			id: provider.id,
			...provider.label ? { label: provider.label } : {},
			...provider.defaultModel ? { defaultModel: provider.defaultModel } : {},
			models,
			modes,
			configured: isCapabilityProviderConfigured({
				providers: params.providers,
				provider,
				cfg: params.cfg,
				workspaceDir: params.workspaceDir,
				agentDir: params.agentDir,
				authStore: params.authStore
			}),
			authEnvVars: getProviderEnvVars(provider.id),
			capabilities: provider.capabilities,
			catalog: synthesizeMediaGenerationCatalogEntries({
				kind: params.kind,
				provider,
				modes
			})
		};
	});
	return {
		content: [{
			type: "text",
			text: providerDetails.flatMap((details, index) => {
				const provider = params.providers[index];
				const authHints = getProviderEnvVars(provider.id);
				const capabilities = params.summarizeCapabilities(provider);
				const modelLine = details.models.length > 0 ? details.models.join(", ") : "unknown";
				const authHint = params.formatAuthHint?.({
					id: details.id,
					authEnvVars: authHints
				}) ?? (authHints.length > 0 ? `set ${authHints.join(" / ")} to use ${details.id}/*` : void 0);
				return [
					`${details.id}${details.defaultModel ? ` (default ${details.defaultModel})` : ""}`,
					`  models: ${modelLine}`,
					`  configured: ${details.configured ? "yes" : "no"}`,
					...authHint ? [`  auth: ${authHint}`] : [],
					"  source: static",
					...capabilities ? [`  capabilities: ${capabilities}`] : []
				];
			}).join("\n")
		}],
		details: {
			kind: params.kind,
			providers: providerDetails
		}
	};
}
function createMediaGenerateTaskStatusActions(params) {
	return {
		createStatusActionResult(sessionKey) {
			return createMediaGenerateStatusActionResult({
				sessionKey,
				inactiveText: params.inactiveText,
				findActiveTask: params.findActiveTask,
				buildStatusText: params.buildStatusText,
				buildStatusDetails: params.buildStatusDetails
			});
		},
		createDuplicateGuardResult(sessionKey) {
			return createMediaGenerateDuplicateGuardResult({
				sessionKey,
				findActiveTask: params.findActiveTask,
				buildStatusText: params.buildStatusText,
				buildStatusDetails: params.buildStatusDetails
			});
		}
	};
}
function createMediaGenerateStatusActionResult(params) {
	const activeTask = params.findActiveTask(params.sessionKey);
	if (!activeTask) return {
		content: [{
			type: "text",
			text: params.inactiveText
		}],
		details: {
			action: "status",
			active: false
		}
	};
	return {
		content: [{
			type: "text",
			text: params.buildStatusText(activeTask)
		}],
		details: {
			action: "status",
			...params.buildStatusDetails(activeTask)
		}
	};
}
function createMediaGenerateDuplicateGuardResult(params) {
	const activeTask = params.findActiveTask(params.sessionKey);
	if (!activeTask) return;
	return {
		content: [{
			type: "text",
			text: params.buildStatusText(activeTask, { duplicateGuard: true })
		}],
		details: {
			action: "status",
			duplicateGuard: true,
			...params.buildStatusDetails(activeTask)
		}
	};
}
//#endregion
//#region src/agents/tools/image-generate-tool.actions.ts
function formatImageGenerationAuthHint(provider) {
	if (provider.id === "openai") return "set OPENAI_API_KEY or configure OpenAI Codex OAuth for openai/gpt-image-2";
	if (provider.authEnvVars.length === 0) return;
	return `set ${provider.authEnvVars.join(" / ")} to use ${provider.id}/*`;
}
function listSupportedImageGenerationModes(provider) {
	return ["generate", ...provider.capabilities.edit.enabled ? ["edit"] : []];
}
function summarizeImageGenerationCapabilities(provider) {
	const caps = [];
	if (provider.capabilities.edit.enabled) {
		const maxRefs = provider.capabilities.edit.maxInputImages;
		caps.push(`editing${typeof maxRefs === "number" ? ` up to ${maxRefs} ref${maxRefs === 1 ? "" : "s"}` : ""}`);
	}
	if ((provider.capabilities.geometry?.resolutions?.length ?? 0) > 0) caps.push(`resolutions ${provider.capabilities.geometry?.resolutions?.join("/")}`);
	if ((provider.capabilities.geometry?.sizes?.length ?? 0) > 0) caps.push(`sizes ${provider.capabilities.geometry?.sizes?.join(", ")}`);
	if ((provider.capabilities.geometry?.aspectRatios?.length ?? 0) > 0) caps.push(`aspect ratios ${provider.capabilities.geometry?.aspectRatios?.join(", ")}`);
	if ((provider.capabilities.output?.formats?.length ?? 0) > 0) caps.push(`formats ${provider.capabilities.output?.formats?.join("/")}`);
	if ((provider.capabilities.output?.backgrounds?.length ?? 0) > 0) caps.push(`backgrounds ${provider.capabilities.output?.backgrounds?.join("/")}`);
	return caps.join("; ");
}
function createImageGenerateListActionResult(params) {
	return createMediaGenerateProviderListActionResult({
		kind: "image_generation",
		providers: listRuntimeImageGenerationProviders({ config: params.cfg }),
		emptyText: "No image-generation providers are registered.",
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore,
		listModes: listSupportedImageGenerationModes,
		summarizeCapabilities: summarizeImageGenerationCapabilities,
		formatAuthHint: formatImageGenerationAuthHint
	});
}
const imageGenerateTaskStatusActions = createMediaGenerateTaskStatusActions({
	inactiveText: "No active image generation task is currently running for this session.",
	findActiveTask: (sessionKey) => findActiveImageGenerationTaskForSession(sessionKey) ?? void 0,
	buildStatusText: buildImageGenerationTaskStatusText,
	buildStatusDetails: buildImageGenerationTaskStatusDetails
});
function createImageGenerateStatusActionResult(sessionKey) {
	const activeTasks = listActiveImageGenerationTasksForSession(sessionKey);
	if (activeTasks.length > 1) return {
		content: [{
			type: "text",
			text: buildImageGenerationTaskStatusListText(activeTasks)
		}],
		details: {
			action: "status",
			...buildImageGenerationTaskStatusListDetails(activeTasks)
		}
	};
	return imageGenerateTaskStatusActions.createStatusActionResult(sessionKey);
}
function createImageGenerateDuplicateGuardResult(sessionKey, params) {
	const blockingTask = findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
		prompt: params?.prompt,
		requestKey: params?.requestKey
	});
	if (!blockingTask) return;
	return {
		content: [{
			type: "text",
			text: buildImageGenerationTaskStatusText(blockingTask, { duplicateGuard: true })
		}],
		details: {
			action: "status",
			duplicateGuard: true,
			...buildImageGenerationTaskStatusDetails(blockingTask)
		}
	};
}
//#endregion
//#region src/agents/tools/image-generate-tool.ts
const DEFAULT_COUNT = 1;
const MAX_COUNT = 4;
const MAX_INPUT_IMAGES$2 = 5;
const DEFAULT_RESOLUTION = "1K";
const SUPPORTED_QUALITIES = [
	"low",
	"medium",
	"high",
	"auto"
];
const SUPPORTED_OUTPUT_FORMATS$1 = [
	"png",
	"jpeg",
	"webp"
];
const SUPPORTED_BACKGROUNDS = [
	"transparent",
	"opaque",
	"auto"
];
const SUPPORTED_OPENAI_MODERATIONS = ["low", "auto"];
const SUPPORTED_ASPECT_RATIOS = new Set([
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9"
]);
const log$4 = createSubsystemLogger("agents/tools/image-generate");
const ImageGenerateToolSchema = Type.Object({
	action: Type.Optional(Type.String({ description: "\"generate\" default, \"status\" active task, \"list\" providers/models." })),
	prompt: Type.Optional(Type.String({ description: "Image prompt." })),
	image: Type.Optional(Type.String({ description: "Reference image path/URL for edit." })),
	images: Type.Optional(Type.Array(Type.String(), { description: `Reference images for edit; max ${MAX_INPUT_IMAGES$2}.` })),
	model: Type.Optional(Type.String({ description: "Provider/model override, e.g. openai/gpt-image-2; transparent OpenAI: openai/gpt-image-1.5." })),
	filename: Type.Optional(Type.String({ description: "Output filename hint; basename preserved in managed media dir." })),
	size: Type.Optional(Type.String({ description: "Size hint: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 3840x2160." })),
	aspectRatio: Type.Optional(Type.String({ description: "Aspect ratio: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9." })),
	resolution: Type.Optional(Type.String({ description: "Resolution: 1K, 2K, 4K; useful for Google." })),
	quality: optionalStringEnum(SUPPORTED_QUALITIES, { description: "Quality: low, medium, high, auto." }),
	outputFormat: optionalStringEnum(SUPPORTED_OUTPUT_FORMATS$1, { description: "Output format: png, jpeg, webp." }),
	background: optionalStringEnum(SUPPORTED_BACKGROUNDS, { description: "Background: transparent, opaque, auto. Transparent needs png/webp output." }),
	openai: Type.Optional(Type.Object({
		background: optionalStringEnum(SUPPORTED_BACKGROUNDS, { description: "OpenAI background: transparent, opaque, auto. Transparent needs png/webp; default model routes to gpt-image-1.5." }),
		moderation: optionalStringEnum(SUPPORTED_OPENAI_MODERATIONS, { description: "OpenAI moderation: low, auto." }),
		outputCompression: Type.Optional(Type.Number({
			description: "OpenAI jpeg/webp compression 0-100.",
			minimum: 0,
			maximum: 100
		})),
		user: Type.Optional(Type.String({ description: "OpenAI stable end-user id." }))
	})),
	count: Type.Optional(Type.Number({
		description: `Image count 1-${MAX_COUNT}.`,
		minimum: 1,
		maximum: MAX_COUNT
	})),
	timeoutMs: Type.Optional(Type.Number({
		description: "Provider timeout ms.",
		minimum: 1
	}))
});
function resolveImageGenerationModelConfigForTool(params) {
	return resolveCapabilityModelConfigForTool({
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore,
		modelConfig: params.cfg?.agents?.defaults?.imageGenerationModel,
		providers: () => listRuntimeImageGenerationProviders({ config: params.cfg })
	});
}
function hasExplicitImageGenerationModelConfig(cfg) {
	return hasToolModelConfig$1(coerceToolModelConfig(cfg?.agents?.defaults?.imageGenerationModel));
}
function resolveAction$2(args) {
	return resolveGenerateAction({
		args,
		allowed: [
			"generate",
			"status",
			"list"
		],
		defaultAction: "generate"
	});
}
function resolveRequestedCount(args) {
	const count = readNumberParam(args, "count", { integer: true });
	if (count === void 0) return DEFAULT_COUNT;
	if (count < 1 || count > MAX_COUNT) throw new ToolInputError(`count must be between 1 and ${MAX_COUNT}`);
	return count;
}
function normalizeResolution$1(raw) {
	const normalized = raw?.trim().toUpperCase();
	if (!normalized) return;
	if (normalized === "1K" || normalized === "2K" || normalized === "4K") return normalized;
	throw new ToolInputError("resolution must be one of 1K, 2K, or 4K");
}
function normalizeAspectRatio$1(raw) {
	const normalized = raw?.trim();
	if (!normalized) return;
	if (SUPPORTED_ASPECT_RATIOS.has(normalized)) return normalized;
	throw new ToolInputError("aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9");
}
function normalizeQuality(raw) {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return;
	if (SUPPORTED_QUALITIES.includes(normalized)) return normalized;
	throw new ToolInputError("quality must be one of low, medium, high, or auto");
}
function normalizeOutputFormat$1(raw) {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return;
	if (SUPPORTED_OUTPUT_FORMATS$1.includes(normalized)) return normalized;
	throw new ToolInputError("outputFormat must be one of png, jpeg, or webp");
}
function normalizeOpenAIBackground(raw) {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return;
	if (SUPPORTED_BACKGROUNDS.includes(normalized)) return normalized;
	throw new ToolInputError("openai.background must be one of transparent, opaque, or auto");
}
function normalizeBackground(raw) {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return;
	if (SUPPORTED_BACKGROUNDS.includes(normalized)) return normalized;
	throw new ToolInputError("background must be one of transparent, opaque, or auto");
}
function normalizeOpenAIModeration(raw) {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return;
	if (SUPPORTED_OPENAI_MODERATIONS.includes(normalized)) return normalized;
	throw new ToolInputError("openai.moderation must be one of low or auto");
}
function readRecordParam(params, key) {
	const raw = params[key];
	return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}
function normalizeOpenAIOptions(args) {
	const raw = readRecordParam(args, "openai");
	const background = normalizeOpenAIBackground(readStringParam$1(raw, "background"));
	const moderation = normalizeOpenAIModeration(readStringParam$1(raw, "moderation"));
	const outputCompression = readNumberParam(raw, "outputCompression", { integer: true });
	const user = readStringParam$1(raw, "user");
	if (outputCompression !== void 0 && (outputCompression < 0 || outputCompression > 100)) throw new ToolInputError("openai.outputCompression must be between 0 and 100");
	return {
		...background ? { background } : {},
		...moderation ? { moderation } : {},
		...outputCompression !== void 0 ? { outputCompression } : {},
		...user ? { user } : {}
	};
}
function normalizeProviderOptions(args) {
	const openai = normalizeOpenAIOptions(args);
	return Object.keys(openai).length > 0 ? { openai } : void 0;
}
function normalizeReferenceImages(args) {
	return normalizeMediaReferenceInputs({
		args,
		singularKey: "image",
		pluralKey: "images",
		maxCount: MAX_INPUT_IMAGES$2,
		label: "reference images"
	});
}
function resolveSelectedImageGenerationProvider(params) {
	return resolveSelectedCapabilityProvider({
		providers: listRuntimeImageGenerationProviders({ config: params.config }),
		modelConfig: params.imageGenerationModelConfig,
		modelOverride: params.modelOverride,
		parseModelRef: parseImageGenerationModelRef
	});
}
function formatIgnoredImageGenerationOverride(override) {
	return `${override.key}=${sanitizeInlineDirectiveText(override.value)}`;
}
function sanitizeInlineDirectiveText(value) {
	let sanitized = "";
	for (const char of value) switch (char) {
		case "\\":
			sanitized += "\\\\";
			break;
		case "\r":
			sanitized += "\\r";
			break;
		case "\n":
			sanitized += "\\n";
			break;
		case "	":
			sanitized += "\\t";
			break;
		default: if (isInlineDirectiveControlCharacter(char)) sanitized += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
		else sanitized += char;
	}
	return sanitized;
}
function isInlineDirectiveControlCharacter(char) {
	const code = char.charCodeAt(0);
	return code <= 31 || code === 127 || code === 8232 || code === 8233;
}
function validateImageGenerationCapabilities(params) {
	const provider = params.provider;
	if (!provider) return;
	const isEdit = params.inputImageCount > 0;
	const maxCount = (isEdit ? provider.capabilities.edit : provider.capabilities.generate).maxCount ?? MAX_COUNT;
	if (params.count > maxCount) throw new ToolInputError(`${provider.id} ${isEdit ? "edit" : "generate"} supports at most ${maxCount} output image${maxCount === 1 ? "" : "s"}.`);
	if (isEdit) {
		if (!provider.capabilities.edit.enabled) throw new ToolInputError(`${provider.id} does not support reference-image edits.`);
		const maxInputImages = provider.capabilities.edit.maxInputImages ?? MAX_INPUT_IMAGES$2;
		if (params.inputImageCount > maxInputImages) throw new ToolInputError(`${provider.id} edit supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`);
	}
}
async function loadReferenceImages$1(params) {
	const loaded = [];
	for (const imageRawInput of params.imageInputs) {
		const trimmed = imageRawInput.trim();
		const imageRaw = normalizeMediaReferenceSource(trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed);
		if (!imageRaw) throw new ToolInputError("image required (empty string in array)");
		const refInfo = classifyMediaReferenceSource(imageRaw);
		const { isDataUrl, isHttpUrl } = refInfo;
		if (refInfo.hasUnsupportedScheme) throw new ToolInputError(`Unsupported image reference: ${imageRawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`);
		if (params.sandboxConfig && isHttpUrl) throw new ToolInputError("Sandboxed image_generate does not allow remote URLs.");
		const resolvedImage = (() => {
			if (params.sandboxConfig) return imageRaw;
			if (imageRaw.startsWith("~")) return resolveUserPath(imageRaw);
			return imageRaw;
		})();
		const resolvedPathInfo = isDataUrl ? { resolved: "" } : params.sandboxConfig ? await resolveSandboxedBridgeMediaPath({
			sandbox: params.sandboxConfig,
			mediaPath: resolvedImage,
			inboundFallbackDir: "media/inbound"
		}) : { resolved: resolvedImage.startsWith("file://") ? resolvedImage.slice(7) : resolvedImage };
		const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;
		const localRoots = resolveMediaToolLocalRoots(params.workspaceDir, { workspaceOnly: params.sandboxConfig?.workspaceOnly === true }, resolvedPath ? [resolvedPath] : void 0);
		const media = isDataUrl ? decodeDataUrl(resolvedImage, { maxBytes: params.maxBytes }) : params.sandboxConfig ? await loadWebMedia(resolvedPath ?? resolvedImage, {
			maxBytes: params.maxBytes,
			sandboxValidated: true,
			readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig })
		}) : await loadWebMedia(resolvedPath ?? resolvedImage, {
			maxBytes: params.maxBytes,
			localRoots,
			ssrfPolicy: params.ssrfPolicy
		});
		if (media.kind !== "image") throw new ToolInputError(`Unsupported media type: ${media.kind}`);
		const mimeType = "contentType" in media && media.contentType || "mimeType" in media && media.mimeType || "image/png";
		loaded.push({
			sourceImage: {
				buffer: media.buffer,
				mimeType
			},
			resolvedImage,
			...resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}
		});
	}
	return loaded;
}
async function inferResolutionFromInputImages(images) {
	let maxDimension = 0;
	for (const image of images) {
		const meta = await getImageMetadata(image.buffer);
		const dimension = Math.max(meta?.width ?? 0, meta?.height ?? 0);
		maxDimension = Math.max(maxDimension, dimension);
	}
	if (maxDimension >= 3e3) return "4K";
	if (maxDimension >= 1500) return "2K";
	return DEFAULT_RESOLUTION;
}
const defaultScheduleImageGenerateBackgroundWork = createDefaultMediaGenerateBackgroundScheduler({
	toolName: "image_generate",
	onCrash: (message, meta) => log$4.error(message, meta)
});
async function executeImageGenerationJob(params) {
	if (params.taskHandle) recordImageGenerationTaskProgress({
		handle: params.taskHandle,
		progressSummary: "Generating image"
	});
	const result = await generateImage({
		cfg: params.effectiveCfg,
		prompt: params.prompt,
		agentDir: params.agentDir,
		modelOverride: params.model,
		autoProviderFallback: params.autoProviderFallback,
		size: params.size,
		aspectRatio: params.aspectRatio,
		resolution: params.resolution,
		quality: params.quality,
		outputFormat: params.outputFormat,
		background: params.background,
		count: params.count,
		inputImages: params.inputImages,
		timeoutMs: params.timeoutMs,
		providerOptions: params.providerOptions,
		ssrfPolicy: params.ssrfPolicy
	});
	if (params.taskHandle) recordImageGenerationTaskProgress({
		handle: params.taskHandle,
		progressSummary: "Saving generated image"
	});
	const ignoredOverrides = result.ignoredOverrides ?? [];
	const displayProvider = sanitizeInlineDirectiveText(result.provider);
	const displayModel = sanitizeInlineDirectiveText(result.model);
	const warning = ignoredOverrides.length > 0 ? `Ignored unsupported overrides for ${displayProvider}/${displayModel}: ${ignoredOverrides.map(formatIgnoredImageGenerationOverride).join(", ")}.` : void 0;
	const normalizedSize = result.normalization?.size?.applied ?? (typeof result.metadata?.normalizedSize === "string" && result.metadata.normalizedSize.trim() ? result.metadata.normalizedSize : void 0);
	const normalizedAspectRatio = result.normalization?.aspectRatio?.applied ?? (typeof result.metadata?.normalizedAspectRatio === "string" && result.metadata.normalizedAspectRatio.trim() ? result.metadata.normalizedAspectRatio : void 0);
	const normalizedResolution = result.normalization?.resolution?.applied ?? (typeof result.metadata?.normalizedResolution === "string" && result.metadata.normalizedResolution.trim() ? result.metadata.normalizedResolution : void 0);
	const sizeTranslatedToAspectRatio = result.normalization?.aspectRatio?.derivedFrom === "size" || !normalizedSize && typeof result.metadata?.requestedSize === "string" && result.metadata.requestedSize === params.size && Boolean(normalizedAspectRatio);
	const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "image");
	const savedImages = await Promise.all(result.images.map((image) => saveMediaBuffer(image.buffer, image.mimeType, "tool-image-generation", mediaMaxBytes, params.filename || image.fileName)));
	const revisedPrompts = result.images.map((image) => image.revisedPrompt?.trim()).filter((entry) => Boolean(entry));
	const attachments = savedImages.map((image) => ({
		type: "image",
		path: image.path,
		mimeType: image.contentType,
		name: image.id
	}));
	const lines = [
		`Generated ${savedImages.length} image${savedImages.length === 1 ? "" : "s"} with ${displayProvider}/${displayModel}.`,
		...warning ? [`Warning: ${warning}`] : [],
		...formatGeneratedAttachmentLines(attachments)
	];
	return {
		provider: result.provider,
		model: result.model,
		savedPaths: savedImages.map((image) => image.path),
		count: savedImages.length,
		paths: savedImages.map((image) => image.path),
		attachments,
		contentText: lines.join("\n"),
		wakeResult: lines.join("\n"),
		details: {
			provider: result.provider,
			model: result.model,
			count: savedImages.length,
			media: {
				mediaUrls: savedImages.map((image) => image.path),
				attachments
			},
			attachments,
			paths: savedImages.map((image) => image.path),
			...buildTaskRunDetails(params.taskHandle),
			...buildMediaReferenceDetails({
				entries: params.loadedReferenceImages,
				singleKey: "image",
				pluralKey: "images",
				getResolvedInput: (entry) => entry.resolvedImage
			}),
			...normalizedResolution || params.resolution ? { resolution: normalizedResolution ?? params.resolution } : {},
			...normalizedSize || params.size && !sizeTranslatedToAspectRatio ? { size: normalizedSize ?? params.size } : {},
			...normalizedAspectRatio || params.aspectRatio ? { aspectRatio: normalizedAspectRatio ?? params.aspectRatio } : {},
			...params.quality ? { quality: params.quality } : {},
			...params.outputFormat ? { outputFormat: params.outputFormat } : {},
			...params.background ? { background: params.background } : {},
			...params.filename ? { filename: params.filename } : {},
			...params.timeoutMs !== void 0 ? { timeoutMs: params.timeoutMs } : {},
			attempts: result.attempts,
			...result.normalization ? { normalization: result.normalization } : {},
			metadata: result.metadata,
			...warning ? { warning } : {},
			...ignoredOverrides.length > 0 ? { ignoredOverrides } : {},
			...revisedPrompts.length > 0 ? { revisedPrompts } : {}
		}
	};
}
function createImageGenerateTool(options) {
	const cfg = options?.config ?? getRuntimeConfig();
	if (!hasGenerationToolAvailability({
		cfg,
		agentDir: options?.agentDir,
		workspaceDir: options?.workspaceDir,
		authStore: options?.authProfileStore,
		modelConfig: cfg.agents?.defaults?.imageGenerationModel,
		providerKey: "imageGenerationProviders"
	})) return null;
	const sandboxConfig = options?.sandbox && options.sandbox.root.trim() ? {
		root: options.sandbox.root.trim(),
		bridge: options.sandbox.bridge,
		workspaceOnly: options.fsPolicy?.workspaceOnly === true
	} : null;
	const scheduleBackgroundWork = options?.scheduleBackgroundWork ?? defaultScheduleImageGenerateBackgroundWork;
	return {
		label: "Image Generation",
		name: "image_generate",
		description: "Create/edit images. Session chats: background task; do not call image_generate again for same request; wait completion, then send attachments via message tool. Transparent: outputFormat=\"png\" or \"webp\" + background=\"transparent\"; OpenAI also supports openai.background and routes default model to gpt-image-1.5. Use action=\"list\" for providers/models/readiness/auth, \"status\" for active task.",
		parameters: ImageGenerateToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const action = resolveAction$2(params);
			if (action === "list") return createImageGenerateListActionResult({
				cfg,
				workspaceDir: options?.workspaceDir,
				agentDir: options?.agentDir,
				authStore: options?.authProfileStore
			});
			if (action === "status") return createImageGenerateStatusActionResult(options?.agentSessionKey);
			const imageGenerationModelConfig = resolveImageGenerationModelConfigForTool({
				cfg,
				workspaceDir: options?.workspaceDir,
				agentDir: options?.agentDir,
				authStore: options?.authProfileStore
			});
			if (!imageGenerationModelConfig) throw new ToolInputError("No image-generation model configured.");
			const explicitModelConfig = hasExplicitImageGenerationModelConfig(cfg);
			const effectiveCfg = applyImageGenerationModelConfigDefaults(cfg, imageGenerationModelConfig) ?? cfg;
			const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
			const prompt = readStringParam$1(params, "prompt", { required: true });
			const activeDuplicateGuardResult = createImageGenerateDuplicateGuardResult(options?.agentSessionKey, { prompt });
			if (activeDuplicateGuardResult) return activeDuplicateGuardResult;
			const imageInputs = normalizeReferenceImages(params);
			const model = readStringParam$1(params, "model");
			const filename = readStringParam$1(params, "filename");
			const size = readStringParam$1(params, "size");
			const aspectRatio = normalizeAspectRatio$1(readStringParam$1(params, "aspectRatio"));
			const explicitResolution = normalizeResolution$1(readStringParam$1(params, "resolution"));
			const timeoutMs = readGenerationTimeoutMs(params) ?? imageGenerationModelConfig.timeoutMs;
			const quality = normalizeQuality(readStringParam$1(params, "quality"));
			const outputFormat = normalizeOutputFormat$1(readStringParam$1(params, "outputFormat"));
			const background = normalizeBackground(readStringParam$1(params, "background"));
			const providerOptions = normalizeProviderOptions(params);
			const selectedProvider = resolveSelectedImageGenerationProvider({
				config: effectiveCfg,
				imageGenerationModelConfig,
				modelOverride: model
			});
			const explicitModelRef = parseImageGenerationModelRef(model);
			const primaryModelRef = parseImageGenerationModelRef(imageGenerationModelConfig.primary);
			const count = resolveRequestedCount(params);
			const requestKey = buildMediaGenerationRequestKey({
				tool: "image_generate",
				prompt,
				provider: selectedProvider?.id ?? explicitModelRef?.provider ?? primaryModelRef?.provider,
				model: model !== void 0 ? explicitModelRef?.model ?? model : primaryModelRef?.model ?? imageGenerationModelConfig.primary ?? selectedProvider?.defaultModel,
				count,
				imageInputs,
				size,
				aspectRatio,
				resolution: explicitResolution,
				quality,
				outputFormat,
				background,
				filename,
				providerOptions
			});
			const duplicateGuardResult = createImageGenerateDuplicateGuardResult(options?.agentSessionKey, {
				prompt,
				requestKey
			});
			if (duplicateGuardResult) return duplicateGuardResult;
			const loadedReferenceImages = await loadReferenceImages$1({
				imageInputs,
				maxBytes: resolveConfiguredMediaMaxBytes(effectiveCfg),
				workspaceDir: options?.workspaceDir,
				sandboxConfig,
				ssrfPolicy: remoteMediaSsrfPolicy
			});
			const inputImages = loadedReferenceImages.map((entry) => entry.sourceImage);
			const modeCaps = inputImages.length > 0 ? selectedProvider?.capabilities.edit : selectedProvider?.capabilities.generate;
			const resolution = explicitResolution ?? (size || modeCaps?.supportsResolution === false ? void 0 : inputImages.length > 0 ? await inferResolutionFromInputImages(inputImages) : void 0);
			validateImageGenerationCapabilities({
				provider: selectedProvider,
				count,
				inputImageCount: inputImages.length,
				size,
				aspectRatio,
				resolution,
				explicitResolution: Boolean(explicitResolution)
			});
			const taskHandle = createImageGenerationTaskRun({
				sessionKey: options?.agentSessionKey,
				requesterOrigin: options?.requesterOrigin,
				prompt,
				providerId: selectedProvider?.id
			});
			if (Boolean(taskHandle && options?.agentSessionKey?.trim()) && taskHandle) {
				recordRecentMediaGenerationTaskStartForSession({
					sessionKey: options?.agentSessionKey,
					taskKind: "image_generation",
					sourcePrefix: "image_generate",
					taskId: taskHandle.taskId,
					runId: taskHandle.runId,
					taskLabel: prompt,
					requestKey,
					providerId: selectedProvider?.id,
					progressSummary: "Generating image"
				});
				scheduleMediaGenerationTaskCompletion({
					lifecycle: imageGenerationTaskLifecycle,
					handle: taskHandle,
					scheduleBackgroundWork,
					progressSummary: "Generating image",
					config: effectiveCfg,
					toolName: "Image generation",
					onWakeFailure: (message, meta) => log$4.warn(message, meta),
					run: () => executeImageGenerationJob({
						effectiveCfg,
						prompt,
						agentDir: options?.agentDir,
						model,
						size,
						aspectRatio,
						resolution,
						quality,
						outputFormat,
						background,
						count,
						inputImages,
						timeoutMs,
						providerOptions,
						ssrfPolicy: remoteMediaSsrfPolicy,
						filename,
						loadedReferenceImages,
						taskHandle,
						autoProviderFallback: explicitModelConfig ? false : void 0
					})
				});
				await notifyMediaGenerationAsyncTaskStarted({
					callback: options?.onAsyncTaskStarted,
					message: "Image generation started; wait for the generated image completion event.",
					toolName: "image_generate",
					handle: taskHandle,
					onFailure: (message, meta) => log$4.warn(message, meta)
				});
				return buildMediaGenerationStartedToolResult({
					toolName: "image_generate",
					generationLabel: "image",
					completionLabel: "image",
					taskHandle,
					detailExtras: {
						...buildMediaReferenceDetails({
							entries: loadedReferenceImages,
							singleKey: "image",
							pluralKey: "images",
							getResolvedInput: (entry) => entry.resolvedImage
						}),
						...model ? { model } : {},
						...resolution ? { resolution } : {},
						...size ? { size } : {},
						...aspectRatio ? { aspectRatio } : {},
						...quality ? { quality } : {},
						...outputFormat ? { outputFormat } : {},
						...background ? { background } : {},
						...filename ? { filename } : {},
						...timeoutMs !== void 0 ? { timeoutMs } : {}
					}
				});
			}
			try {
				const executed = await executeImageGenerationJob({
					effectiveCfg,
					prompt,
					agentDir: options?.agentDir,
					model,
					size,
					aspectRatio,
					resolution,
					quality,
					outputFormat,
					background,
					count,
					inputImages,
					timeoutMs,
					providerOptions,
					ssrfPolicy: remoteMediaSsrfPolicy,
					filename,
					loadedReferenceImages,
					taskHandle,
					autoProviderFallback: explicitModelConfig ? false : void 0
				});
				completeImageGenerationTaskRun({
					handle: taskHandle,
					provider: executed.provider,
					model: executed.model,
					count: executed.count,
					paths: executed.paths
				});
				return {
					content: [{
						type: "text",
						text: executed.contentText
					}],
					details: executed.details
				};
			} catch (error) {
				failImageGenerationTaskRun({
					handle: taskHandle,
					error
				});
				throw error;
			}
		}
	};
}
//#endregion
//#region src/agents/tools/image-tool.ts
const DEFAULT_PROMPT$1 = "Describe the image.";
const DEFAULT_MAX_IMAGES = 20;
const imageToolProviderDeps = {
	buildProviderRegistry,
	getMediaUnderstandingProvider,
	describeImageWithModel,
	describeImagesWithModel,
	resolveAutoMediaKeyProviders,
	resolveDefaultMediaModel
};
function hasExplicitDefaultPrimaryModel(cfg) {
	const model = cfg?.agents?.defaults?.model;
	if (typeof model === "string") return model.trim().length > 0;
	return typeof model?.primary === "string" && model.primary.trim().length > 0;
}
function modelRefProvider(candidate) {
	const trimmed = candidate?.trim();
	if (!trimmed?.includes("/")) return;
	return trimmed.slice(0, trimmed.indexOf("/")).trim();
}
function isExecutionAliasCandidateForProvider(candidate, provider) {
	const candidateProvider = modelRefProvider(candidate);
	return Boolean(candidateProvider && candidateProvider !== normalizeMediaProviderId(candidateProvider) && normalizeMediaProviderId(candidateProvider) === normalizeMediaProviderId(provider));
}
function isCanonicalCandidateShadowedByExecutionAlias(candidate, candidates) {
	const candidateProvider = modelRefProvider(candidate);
	if (!candidateProvider || candidateProvider !== normalizeMediaProviderId(candidateProvider)) return false;
	if (!isMinimaxVlmProvider(candidateProvider)) return false;
	return candidates.some((shadowCandidate) => isExecutionAliasCandidateForProvider(shadowCandidate, candidateProvider));
}
function resolveImageToolMaxTokens(modelMaxTokens, requestedMaxTokens = 4096) {
	if (typeof modelMaxTokens !== "number" || !Number.isFinite(modelMaxTokens) || modelMaxTokens <= 0) return requestedMaxTokens;
	return Math.min(requestedMaxTokens, modelMaxTokens);
}
/**
* Resolve the effective image model config for the `image` tool.
*
* - Prefer explicit config (`agents.defaults.imageModel`).
* - Otherwise, try to "pair" the primary model with an image-capable model:
*   - same provider (best effort)
*   - fall back to OpenAI/Anthropic when available
*/
function resolveImageModelConfigForTool(params) {
	const explicit = coerceImageModelConfig(params.cfg);
	if (hasToolModelConfig$1(explicit)) return resolveConfiguredImageModelRefs({
		cfg: params.cfg,
		imageModelConfig: explicit
	});
	const primary = resolveDefaultModelRef(params.cfg);
	const providerVisionFromConfig = resolveProviderVisionModelFromConfig({
		cfg: params.cfg,
		provider: primary.provider
	});
	const primaryCandidates = (() => {
		if (providerVisionFromConfig) return [providerVisionFromConfig];
		const providerDefault = imageToolProviderDeps.resolveDefaultMediaModel({
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			providerId: primary.provider,
			capability: "image",
			includeConfiguredImageModels: !isMinimaxVlmProvider(primary.provider)
		});
		if (providerDefault) return [`${primary.provider}/${providerDefault}`];
		if (isMinimaxVlmProvider(primary.provider)) return [`${primary.provider}/MiniMax-VL-01`];
		return [];
	})();
	const rawAutoCandidates = imageToolProviderDeps.resolveAutoMediaKeyProviders({
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		capability: "image"
	}).map((providerId) => {
		const modelId = imageToolProviderDeps.resolveDefaultMediaModel({
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			providerId,
			capability: "image",
			includeConfiguredImageModels: !isMinimaxVlmProvider(providerId)
		});
		return modelId ? `${providerId}/${modelId}` : null;
	});
	const autoCandidates = rawAutoCandidates.filter((candidate) => !isCanonicalCandidateShadowedByExecutionAlias(candidate, [...primaryCandidates, ...rawAutoCandidates]));
	const primaryAliasCandidates = !hasExplicitDefaultPrimaryModel(params.cfg) ? autoCandidates.filter((candidate) => isExecutionAliasCandidateForProvider(candidate, primary.provider)) : [];
	const remainingAutoCandidates = primaryAliasCandidates.length === 0 ? autoCandidates : autoCandidates.filter((candidate) => !primaryAliasCandidates.includes(candidate));
	return buildToolModelConfigFromCandidates({
		explicit,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore,
		candidates: [
			...primaryAliasCandidates,
			...primaryCandidates,
			...remainingAutoCandidates
		]
	});
}
function resolveImageModelConfigForOverride(params) {
	const model = params.modelOverride?.trim();
	if (!model) return null;
	return resolveConfiguredImageModelRefs({
		cfg: params.cfg,
		imageModelConfig: { primary: model }
	});
}
function pickMaxBytes(cfg, maxBytesMb) {
	if (typeof maxBytesMb === "number" && Number.isFinite(maxBytesMb) && maxBytesMb > 0) return Math.floor(maxBytesMb * 1024 * 1024);
	const configured = cfg?.agents?.defaults?.mediaMaxMb;
	if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) return Math.floor(configured * 1024 * 1024);
}
function matchesImageTimeoutEntry(params) {
	const configuredProvider = normalizeMediaProviderId(params.entry.provider ?? "");
	const selectedProvider = normalizeMediaProviderId(params.provider);
	if (!configuredProvider || configuredProvider !== selectedProvider) return false;
	if (!matchesMediaEntryCapability({
		entry: params.entry,
		source: params.source,
		capability: "image",
		providerRegistry: params.providerRegistry
	})) return false;
	const configuredModel = params.entry.model?.trim();
	if (!configuredModel) return true;
	const providerPrefix = `${selectedProvider}/`;
	return (configuredModel.startsWith(providerPrefix) ? configuredModel.slice(providerPrefix.length) : configuredModel) === params.model;
}
function resolveImageToolTimeoutMs(params) {
	const imageConfig = params.cfg.tools?.media?.image;
	const capabilityEntry = imageConfig?.models?.find((entry) => matchesImageTimeoutEntry({
		entry,
		source: "capability",
		provider: params.provider,
		model: params.model,
		providerRegistry: params.providerRegistry
	}));
	const sharedEntry = params.cfg.tools?.media?.models?.find((entry) => matchesImageTimeoutEntry({
		entry,
		source: "shared",
		provider: params.provider,
		model: params.model,
		providerRegistry: params.providerRegistry
	}));
	return resolveTimeoutMs(capabilityEntry?.timeoutSeconds ?? sharedEntry?.timeoutSeconds ?? imageConfig?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS.image);
}
async function runImagePrompt(params) {
	const effectiveCfg = applyImageModelConfigDefaults(params.cfg, params.imageModelConfig);
	const providerCfg = effectiveCfg ?? {};
	const providerRegistry = imageToolProviderDeps.buildProviderRegistry(void 0, providerCfg);
	const result = await runWithImageModelFallback({
		cfg: effectiveCfg,
		modelOverride: params.modelOverride,
		run: async (provider, modelId) => {
			const timeoutMs = resolveImageToolTimeoutMs({
				cfg: providerCfg,
				provider,
				model: modelId,
				providerRegistry
			});
			const imageProvider = imageToolProviderDeps.getMediaUnderstandingProvider(provider, providerRegistry);
			if (params.images.length > 1 && (imageProvider?.describeImages || !imageProvider?.describeImage)) {
				const described = await (imageProvider?.describeImages ?? imageToolProviderDeps.describeImagesWithModel)({
					images: params.images.map((image, index) => ({
						buffer: image.buffer,
						fileName: `image-${index + 1}`,
						mime: image.mimeType
					})),
					provider,
					model: modelId,
					prompt: params.prompt,
					maxTokens: resolveImageToolMaxTokens(void 0),
					timeoutMs,
					cfg: providerCfg,
					agentDir: params.agentDir,
					...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
				});
				return {
					text: described.text,
					provider,
					model: described.model ?? modelId
				};
			}
			const describeImage = imageProvider?.describeImage ?? imageToolProviderDeps.describeImageWithModel;
			if (params.images.length === 1) {
				const image = params.images[0];
				const described = await describeImage({
					buffer: image.buffer,
					fileName: "image-1",
					mime: image.mimeType,
					provider,
					model: modelId,
					prompt: params.prompt,
					maxTokens: resolveImageToolMaxTokens(void 0),
					timeoutMs,
					cfg: providerCfg,
					agentDir: params.agentDir,
					...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
				});
				return {
					text: described.text,
					provider,
					model: described.model ?? modelId
				};
			}
			const parts = [];
			for (const [index, image] of params.images.entries()) {
				const described = await describeImage({
					buffer: image.buffer,
					fileName: `image-${index + 1}`,
					mime: image.mimeType,
					provider,
					model: modelId,
					prompt: `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length}.`,
					maxTokens: resolveImageToolMaxTokens(void 0),
					timeoutMs,
					cfg: providerCfg,
					agentDir: params.agentDir,
					...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
				});
				parts.push(`Image ${index + 1}:\n${described.text.trim()}`);
			}
			return {
				text: parts.join("\n\n").trim(),
				provider,
				model: modelId
			};
		}
	});
	return {
		text: result.result.text,
		provider: result.result.provider,
		model: result.result.model,
		attempts: result.attempts.map((attempt) => ({
			provider: attempt.provider,
			model: attempt.model,
			error: attempt.error
		}))
	};
}
function createImageTool(options) {
	const agentDir = options?.agentDir?.trim();
	const explicit = coerceImageModelConfig(options?.config);
	if (!agentDir) {
		if (hasToolModelConfig$1(explicit)) throw new Error("createImageTool requires agentDir when enabled");
		return null;
	}
	const explicitImageModelConfig = hasToolModelConfig$1(explicit) ? resolveConfiguredImageModelRefs({
		cfg: options?.config,
		imageModelConfig: explicit
	}) : null;
	const resolvedImageModelConfig = !explicitImageModelConfig && !options?.deferAutoModelResolution ? resolveImageModelConfigForTool({
		cfg: options?.config,
		agentDir,
		workspaceDir: options?.workspaceDir,
		authStore: options?.authProfileStore
	}) : explicitImageModelConfig;
	if (!resolvedImageModelConfig && !options?.deferAutoModelResolution) return null;
	const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(options?.config);
	return {
		label: "Image",
		name: "image",
		description: options?.modelHasVision ? "Analyze images with vision model. Use image for one path/URL, images for max 20. Only use this tool when images were NOT already provided; prompt images already visible." : explicitImageModelConfig ? "Analyze images with configured image model. Use image for one path/URL, images for max 20. Prompt says what to inspect." : "Analyze images with available vision model. Use image for one path/URL, images for max 20. Prompt says what to inspect.",
		parameters: Type.Object({
			prompt: Type.Optional(Type.String()),
			image: Type.Optional(Type.String({ description: "One image path/URL." })),
			images: Type.Optional(Type.Array(Type.String(), { description: "Image paths/URLs; maxImages default 20." })),
			model: Type.Optional(Type.String()),
			maxBytesMb: Type.Optional(Type.Number()),
			maxImages: Type.Optional(Type.Number())
		}),
		execute: async (_toolCallId, args) => {
			const record = args && typeof args === "object" ? args : {};
			const imageCandidates = [];
			if (typeof record.image === "string") imageCandidates.push(record.image);
			if (Array.isArray(record.images)) imageCandidates.push(...record.images.filter((v) => typeof v === "string"));
			const seenImages = /* @__PURE__ */ new Set();
			const imageInputs = [];
			for (const candidate of imageCandidates) {
				const trimmedCandidate = candidate.trim();
				const normalizedForDedupe = trimmedCandidate.startsWith("@") ? trimmedCandidate.slice(1).trim() : trimmedCandidate;
				if (!normalizedForDedupe || seenImages.has(normalizedForDedupe)) continue;
				seenImages.add(normalizedForDedupe);
				imageInputs.push(trimmedCandidate);
			}
			if (imageInputs.length === 0) throw new Error("image required");
			const maxImagesRaw = typeof record.maxImages === "number" ? record.maxImages : void 0;
			const maxImages = typeof maxImagesRaw === "number" && Number.isFinite(maxImagesRaw) && maxImagesRaw > 0 ? Math.floor(maxImagesRaw) : DEFAULT_MAX_IMAGES;
			if (imageInputs.length > maxImages) return {
				content: [{
					type: "text",
					text: `Too many images: ${imageInputs.length} provided, maximum is ${maxImages}. Please reduce the number of images.`
				}],
				details: {
					error: "too_many_images",
					count: imageInputs.length,
					max: maxImages
				}
			};
			const { prompt: promptRaw, modelOverride } = resolvePromptAndModelOverride(record, DEFAULT_PROMPT$1);
			const maxBytesMb = typeof record.maxBytesMb === "number" ? record.maxBytesMb : void 0;
			const maxBytes = pickMaxBytes(options?.config, maxBytesMb);
			const sandboxConfig = options?.sandbox && options?.sandbox.root.trim() ? {
				root: options.sandbox.root.trim(),
				bridge: options.sandbox.bridge,
				workspaceOnly: options.fsPolicy?.workspaceOnly === true
			} : null;
			const loadedImages = [];
			for (const imageRawInput of imageInputs) {
				const trimmed = imageRawInput.trim();
				const imageRaw = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
				if (!imageRaw) throw new Error("image required (empty string in array)");
				const normalizedRef = normalizeMediaReferenceSource(imageRaw);
				const refInfo = classifyMediaReferenceSource(normalizedRef);
				const { isDataUrl, isFileUrl, isHttpUrl } = refInfo;
				if (refInfo.hasUnsupportedScheme) return {
					content: [{
						type: "text",
						text: `Unsupported image reference: ${imageRawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`
					}],
					details: {
						error: "unsupported_image_reference",
						image: imageRawInput
					}
				};
				if (sandboxConfig && isHttpUrl) throw new Error("Sandboxed image tool does not allow remote URLs.");
				const resolvedImage = (() => {
					if (sandboxConfig) return normalizedRef;
					if (normalizedRef.startsWith("~")) return resolveUserPath(normalizedRef);
					if (!isDataUrl && !isFileUrl && !isHttpUrl && !refInfo.looksLikeWindowsDrivePath && !isAbsolute(normalizedRef) && options?.workspaceDir) return resolve(options.workspaceDir, normalizedRef);
					return normalizedRef;
				})();
				const resolvedPathInfo = isDataUrl ? { resolved: "" } : sandboxConfig ? await resolveSandboxedBridgeMediaPath({
					sandbox: sandboxConfig,
					mediaPath: resolvedImage,
					inboundFallbackDir: "media/inbound"
				}) : { resolved: resolvedImage.startsWith("file://") ? resolvedImage.slice(7) : resolvedImage };
				const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;
				const mediaLocalRoots = resolveMediaToolLocalRoots(options?.workspaceDir, { workspaceOnly: options?.fsPolicy?.workspaceOnly === true }, resolvedPath ? [resolvedPath] : void 0);
				const media = isDataUrl ? decodeDataUrl(resolvedImage, { maxBytes }) : sandboxConfig ? await loadWebMedia(resolvedPath ?? resolvedImage, {
					maxBytes,
					sandboxValidated: true,
					readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig })
				}) : await loadWebMedia(resolvedPath ?? resolvedImage, {
					maxBytes,
					localRoots: mediaLocalRoots,
					ssrfPolicy: remoteMediaSsrfPolicy
				});
				if (media.kind !== "image") throw new Error(`Unsupported media type: ${media.kind}`);
				const mimeType = "contentType" in media && media.contentType || "mimeType" in media && media.mimeType || "image/png";
				loadedImages.push({
					buffer: media.buffer,
					mimeType,
					resolvedImage,
					...resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}
				});
			}
			const imageModelConfig = resolvedImageModelConfig ?? resolveImageModelConfigForOverride({
				cfg: options?.config,
				modelOverride
			}) ?? resolveImageModelConfigForTool({
				cfg: options?.config,
				agentDir,
				workspaceDir: options?.workspaceDir,
				authStore: options?.authProfileStore
			});
			if (!imageModelConfig) throw new Error("No image model is configured. Set agents.defaults.imageModel or configure an image-capable provider.");
			return buildTextToolResult(await runImagePrompt({
				cfg: options?.config,
				agentDir,
				imageModelConfig,
				modelOverride,
				prompt: promptRaw,
				images: loadedImages.map((img) => ({
					buffer: img.buffer,
					mimeType: img.mimeType
				})),
				workspaceDir: options?.workspaceDir
			}), loadedImages.length === 1 ? {
				image: loadedImages[0].resolvedImage,
				...loadedImages[0].rewrittenFrom ? { rewrittenFrom: loadedImages[0].rewrittenFrom } : {}
			} : { images: loadedImages.map((img) => Object.assign({ image: img.resolvedImage }, img.rewrittenFrom ? { rewrittenFrom: img.rewrittenFrom } : {})) });
		}
	};
}
//#endregion
//#region src/agents/tools/message-tool.ts
const AllMessageActions = CHANNEL_MESSAGE_ACTION_NAMES;
const MESSAGE_TOOL_THREAD_READ_HINT = " Use action=\"read\" with threadId to fetch prior messages in a thread when you need conversation context you do not have yet.";
const EXPLICIT_TARGET_ACTIONS = new Set([
	"send",
	"sendWithEffect",
	"sendAttachment",
	"upload-file",
	"reply",
	"thread-reply",
	"broadcast"
]);
function actionNeedsExplicitTarget(action) {
	return EXPLICIT_TARGET_ACTIONS.has(action);
}
function normalizeToolCallIdForIdempotencyKey(toolCallId) {
	const value = normalizeOptionalString(toolCallId);
	if (!value) return;
	return value.replace(/[^A-Za-z0-9._:-]+/gu, "_");
}
function sanitizePresentationTextFields(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const presentation = { ...value };
	if (typeof presentation.title === "string") presentation.title = stripFormattedReasoningMessage(presentation.title);
	if (Array.isArray(presentation.blocks)) presentation.blocks = presentation.blocks.map((block) => {
		if (!block || typeof block !== "object" || Array.isArray(block)) return block;
		const sanitizedBlock = { ...block };
		for (const field of ["text", "placeholder"]) if (typeof sanitizedBlock[field] === "string") sanitizedBlock[field] = stripFormattedReasoningMessage(sanitizedBlock[field]);
		if (Array.isArray(sanitizedBlock.buttons)) sanitizedBlock.buttons = sanitizedBlock.buttons.map((button) => {
			if (!button || typeof button !== "object" || Array.isArray(button)) return button;
			const sanitizedButton = { ...button };
			if (typeof sanitizedButton.label === "string") sanitizedButton.label = stripFormattedReasoningMessage(sanitizedButton.label);
			return sanitizedButton;
		});
		if (Array.isArray(sanitizedBlock.options)) sanitizedBlock.options = sanitizedBlock.options.map((option) => {
			if (!option || typeof option !== "object" || Array.isArray(option)) return option;
			const sanitizedOption = { ...option };
			if (typeof sanitizedOption.label === "string") sanitizedOption.label = stripFormattedReasoningMessage(sanitizedOption.label);
			return sanitizedOption;
		});
		return sanitizedBlock;
	});
	return presentation;
}
function buildRoutingSchema() {
	return {
		channel: Type.Optional(Type.String()),
		target: Type.Optional(channelTargetSchema()),
		targets: Type.Optional(channelTargetsSchema()),
		accountId: Type.Optional(Type.String()),
		dryRun: Type.Optional(Type.Boolean())
	};
}
const presentationOptionSchema = Type.Object({
	label: Type.String(),
	value: Type.String()
});
const presentationButtonSchema = Type.Object({
	label: Type.String(),
	value: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	webApp: Type.Optional(Type.Object({ url: Type.String() })),
	web_app: Type.Optional(Type.Object({ url: Type.String() })),
	disabled: Type.Optional(Type.Boolean()),
	reusable: Type.Optional(Type.Boolean()),
	style: Type.Optional(stringEnum([
		"primary",
		"secondary",
		"success",
		"danger"
	]))
});
const presentationBlockSchema = Type.Object({
	type: stringEnum([
		"text",
		"context",
		"divider",
		"buttons",
		"select"
	]),
	text: Type.Optional(Type.String()),
	buttons: Type.Optional(Type.Array(presentationButtonSchema)),
	placeholder: Type.Optional(Type.String()),
	options: Type.Optional(Type.Array(presentationOptionSchema))
});
const presentationMessageSchema = Type.Object({
	title: Type.Optional(Type.String()),
	tone: Type.Optional(stringEnum([
		"info",
		"success",
		"warning",
		"danger",
		"neutral"
	])),
	blocks: Type.Array(presentationBlockSchema)
}, { description: "Rich message payload: text/buttons/selects/context. Unsupported blocks degrade to text." });
function buildSendSchema(options) {
	const props = {
		message: Type.Optional(Type.String()),
		effectId: Type.Optional(Type.String({ description: "Effect id/name for sendWithEffect." })),
		effect: Type.Optional(Type.String({ description: "Alias for effectId." })),
		media: Type.Optional(Type.String({ description: "Media URL/path. data: use buffer." })),
		filename: Type.Optional(Type.String()),
		buffer: Type.Optional(Type.String({ description: "Base64 attachment payload; data URL ok." })),
		contentType: Type.Optional(Type.String()),
		mimeType: Type.Optional(Type.String()),
		caption: Type.Optional(Type.String()),
		path: Type.Optional(Type.String()),
		filePath: Type.Optional(Type.String()),
		attachments: Type.Optional(Type.Array(Type.Object({
			type: Type.Optional(stringEnum([
				"image",
				"audio",
				"video",
				"file"
			])),
			media: Type.Optional(Type.String()),
			mediaUrl: Type.Optional(Type.String()),
			path: Type.Optional(Type.String()),
			filePath: Type.Optional(Type.String()),
			fileUrl: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			mimeType: Type.Optional(Type.String())
		}), { description: "Structured attachments; each needs media/mediaUrl/path/filePath/fileUrl/url." })),
		replyTo: Type.Optional(Type.String()),
		threadId: Type.Optional(Type.String()),
		asVoice: Type.Optional(Type.Boolean()),
		silent: Type.Optional(Type.Boolean()),
		quoteText: Type.Optional(Type.String({ description: "Telegram reply quote text." })),
		bestEffort: Type.Optional(Type.Boolean()),
		gifPlayback: Type.Optional(Type.Boolean()),
		forceDocument: Type.Optional(Type.Boolean({ description: "Send image/GIF/video as document; avoids compression." })),
		asDocument: Type.Optional(Type.Boolean({ description: "Alias for forceDocument." }))
	};
	if (options.includePresentation) props.presentation = Type.Optional(presentationMessageSchema);
	if (options.includeDeliveryPin) props.delivery = Type.Optional(Type.Object({ pin: Type.Optional(Type.Union([Type.Boolean(), Type.Object({
		enabled: Type.Boolean(),
		notify: Type.Optional(Type.Boolean()),
		required: Type.Optional(Type.Boolean())
	})])) }, { description: "Delivery prefs. pin requests pin when channel supports it." }));
	return props;
}
function buildReactionSchema() {
	return {
		messageId: Type.Optional(Type.String({ description: "Target message id for read/react/edit/delete/pin/unpin. Reaction-like defaults current inbound id when available." })),
		message_id: Type.Optional(Type.String({ description: "snake_case alias of messageId; same defaults." })),
		emoji: Type.Optional(Type.String()),
		remove: Type.Optional(Type.Boolean()),
		trackToolCalls: Type.Optional(Type.Boolean({ description: "For current-message reaction, make reacted message the tool-progress reaction target." })),
		track_tool_calls: Type.Optional(Type.Boolean({ description: "snake_case alias of trackToolCalls." })),
		targetAuthor: Type.Optional(Type.String()),
		targetAuthorUuid: Type.Optional(Type.String()),
		groupId: Type.Optional(Type.String())
	};
}
function buildFetchSchema() {
	return {
		limit: Type.Optional(Type.Number()),
		pageSize: Type.Optional(Type.Number()),
		pageToken: Type.Optional(Type.String()),
		before: Type.Optional(Type.String()),
		after: Type.Optional(Type.String()),
		around: Type.Optional(Type.String()),
		fromMe: Type.Optional(Type.Boolean()),
		includeArchived: Type.Optional(Type.Boolean())
	};
}
function buildPollSchema() {
	const props = {
		pollId: Type.Optional(Type.String()),
		pollOptionId: Type.Optional(Type.String({ description: "Poll answer id." })),
		pollOptionIds: Type.Optional(Type.Array(Type.String({ description: "Poll answer ids for multiselect." }))),
		pollOptionIndex: Type.Optional(Type.Number({ description: "1-based poll option number." })),
		pollOptionIndexes: Type.Optional(Type.Array(Type.Number({ description: "1-based poll option numbers for multiselect." })))
	};
	for (const name of SHARED_POLL_CREATION_PARAM_NAMES) switch (POLL_CREATION_PARAM_DEFS[name].kind) {
		case "string":
			props[name] = Type.Optional(Type.String());
			break;
		case "stringArray":
			props[name] = Type.Optional(Type.Array(Type.String()));
			break;
		case "number":
			props[name] = Type.Optional(Type.Number());
			break;
		case "boolean":
			props[name] = Type.Optional(Type.Boolean());
			break;
	}
	return props;
}
function buildChannelTargetSchema() {
	return {
		channelId: Type.Optional(Type.String({ description: "Channel id filter." })),
		chatId: Type.Optional(Type.String({ description: "Chat id for chat metadata." })),
		channelIds: Type.Optional(Type.Array(Type.String({ description: "Channel id filter." }))),
		memberId: Type.Optional(Type.String()),
		memberIdType: Type.Optional(Type.String()),
		guildId: Type.Optional(Type.String()),
		userId: Type.Optional(Type.String()),
		openId: Type.Optional(Type.String()),
		unionId: Type.Optional(Type.String()),
		authorId: Type.Optional(Type.String()),
		authorIds: Type.Optional(Type.Array(Type.String())),
		roleId: Type.Optional(Type.String()),
		roleIds: Type.Optional(Type.Array(Type.String())),
		participant: Type.Optional(Type.String()),
		includeMembers: Type.Optional(Type.Boolean()),
		members: Type.Optional(Type.Boolean()),
		scope: Type.Optional(Type.String()),
		kind: Type.Optional(Type.String())
	};
}
function buildStickerSchema() {
	return {
		fileId: Type.Optional(Type.String()),
		emojiName: Type.Optional(Type.String()),
		stickerId: Type.Optional(Type.Array(Type.String())),
		stickerName: Type.Optional(Type.String()),
		stickerDesc: Type.Optional(Type.String()),
		stickerTags: Type.Optional(Type.String())
	};
}
function buildThreadSchema() {
	return {
		threadName: Type.Optional(Type.String()),
		autoArchiveMin: Type.Optional(Type.Number()),
		appliedTags: Type.Optional(Type.Array(Type.String()))
	};
}
function buildEventSchema() {
	return {
		query: Type.Optional(Type.String()),
		eventName: Type.Optional(Type.String()),
		eventType: Type.Optional(Type.String()),
		startTime: Type.Optional(Type.String()),
		endTime: Type.Optional(Type.String()),
		desc: Type.Optional(Type.String()),
		location: Type.Optional(Type.String()),
		image: Type.Optional(Type.String({ description: "Event cover image URL/path." })),
		durationMin: Type.Optional(Type.Number()),
		until: Type.Optional(Type.String())
	};
}
function buildModerationSchema() {
	return {
		reason: Type.Optional(Type.String()),
		deleteDays: Type.Optional(Type.Number())
	};
}
function buildGatewaySchema() {
	return {
		gatewayUrl: Type.Optional(Type.String()),
		gatewayToken: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Number())
	};
}
function buildPresenceSchema() {
	return {
		activityType: Type.Optional(Type.String({ description: "Activity type: playing, streaming, listening, watching, competing, custom." })),
		activityName: Type.Optional(Type.String({ description: "Activity name shown in sidebar; ignored for custom." })),
		activityUrl: Type.Optional(Type.String({ description: "Streaming URL; streaming type only." })),
		activityState: Type.Optional(Type.String({ description: "State text; custom type uses as status text." })),
		status: Type.Optional(Type.String({ description: "Bot status: online, dnd, idle, invisible." }))
	};
}
function buildChannelManagementSchema() {
	return {
		name: Type.Optional(Type.String()),
		channelType: Type.Optional(Type.Number({ description: "Numeric channel type, e.g. Discord. Avoids JSON Schema `type` collision." })),
		parentId: Type.Optional(Type.String()),
		topic: Type.Optional(Type.String()),
		position: Type.Optional(Type.Number()),
		nsfw: Type.Optional(Type.Boolean()),
		rateLimitPerUser: Type.Optional(Type.Number()),
		categoryId: Type.Optional(Type.String()),
		clearParent: Type.Optional(Type.Boolean({ description: "Clear parent/category when supported." }))
	};
}
function buildMessageToolSchemaProps(options) {
	return {
		...buildRoutingSchema(),
		...buildSendSchema(options),
		...buildReactionSchema(),
		...buildFetchSchema(),
		...buildPollSchema(),
		...buildChannelTargetSchema(),
		...buildStickerSchema(),
		...buildThreadSchema(),
		...buildEventSchema(),
		...buildModerationSchema(),
		...buildGatewaySchema(),
		...buildChannelManagementSchema(),
		...buildPresenceSchema(),
		...options.extraProperties
	};
}
function isSendOnlyActions(actions) {
	const uniqueActions = new Set(actions);
	return uniqueActions.size === 1 && uniqueActions.has("send");
}
function buildSendOnlyMessageToolSchemaProps(options) {
	return {
		...buildRoutingSchema(),
		...buildSendSchema(options),
		...buildGatewaySchema(),
		...options.extraProperties
	};
}
function buildMessageToolSchemaFromActions(actions, options) {
	const props = isSendOnlyActions(actions) ? buildSendOnlyMessageToolSchemaProps(options) : buildMessageToolSchemaProps(options);
	return Type.Object({
		action: stringEnum(actions),
		...props
	});
}
const MessageToolSchema = buildMessageToolSchemaFromActions(AllMessageActions, {
	includePresentation: true,
	includeDeliveryPin: true
});
const SESSION_DELIVERY_PEER_KINDS = new Set([
	"channel",
	"direct",
	"dm",
	"group"
]);
const USER_PREFIXED_DIRECT_TARGET_CHANNELS = new Set([
	"discord",
	"mattermost",
	"msteams",
	"slack"
]);
function formatSessionDeliveryTarget(channel, peerKind, to) {
	return (peerKind === "direct" || peerKind === "dm") && USER_PREFIXED_DIRECT_TARGET_CHANNELS.has(channel) ? `user:${to}` : to;
}
function inferDeliveryFromSessionKey(sessionKey) {
	const parsedThread = parseThreadSessionSuffix(sessionKey);
	const parsed = parseAgentSessionKey(parsedThread.baseSessionKey ?? sessionKey);
	if (!parsed) return null;
	const parts = parsed.rest.split(":").filter(Boolean);
	if (parts.length < 3) return null;
	const channel = normalizeMessageChannel(parts[0]);
	if (!channel) return null;
	if (parts.length >= 4 && (parts[2] === "direct" || parts[2] === "dm")) {
		const accountId = resolveAgentAccountId(parts[1]);
		const to = parts.slice(3).join(":").trim();
		return to ? {
			accountId,
			channel,
			threadId: parsedThread.threadId,
			to: formatSessionDeliveryTarget(channel, parts[2], to)
		} : null;
	}
	const peerKind = parts[1] ?? "";
	if (SESSION_DELIVERY_PEER_KINDS.has(peerKind)) {
		const to = parts.slice(2).join(":").trim();
		return to ? {
			channel,
			threadId: parsedThread.threadId,
			to: formatSessionDeliveryTarget(channel, peerKind, to)
		} : null;
	}
	return null;
}
function resolveEffectiveCurrentChannelContext(options) {
	const currentChannelProvider = options?.currentChannelProvider;
	const currentChannelId = options?.currentChannelId;
	const sessionDelivery = inferDeliveryFromSessionKey(options?.agentSessionKey);
	const sessionDeliveryChannel = normalizeMessageChannel(sessionDelivery?.channel);
	if (!(normalizeMessageChannel(currentChannelProvider) === "webchat" && sessionDeliveryChannel !== void 0 && sessionDeliveryChannel !== "webchat" && Boolean(sessionDelivery?.to))) return {
		currentChannelProvider,
		currentChannelId
	};
	return {
		accountId: sessionDelivery?.accountId,
		currentChannelProvider: sessionDeliveryChannel,
		currentChannelId: sessionDelivery?.to,
		currentThreadTs: sessionDelivery?.threadId
	};
}
function buildMessageActionDiscoveryInput(params, channel) {
	return {
		cfg: params.cfg,
		...channel ? { channel } : {},
		currentChannelId: params.currentChannelId,
		currentThreadTs: params.currentThreadTs,
		currentMessageId: params.currentMessageId,
		accountId: params.currentAccountId,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		agentId: params.agentId,
		requesterSenderId: params.requesterSenderId,
		senderIsOwner: params.senderIsOwner
	};
}
function resolveMessageToolSchemaActions(params) {
	const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
	if (currentChannel) {
		const scopedActions = listChannelSupportedActions(buildMessageActionDiscoveryInput(params, currentChannel));
		const allActions = new Set(["send", ...scopedActions]);
		for (const plugin of listChannelPlugins()) {
			if (plugin.id === currentChannel) continue;
			for (const action of listCrossChannelSchemaSupportedMessageActions(buildMessageActionDiscoveryInput(params, plugin.id))) allActions.add(action);
		}
		return Array.from(allActions);
	}
	return listAllMessageToolActions(params);
}
function resolveMessageToolActionSchemaActions(params) {
	const discoveredActions = resolveMessageToolSchemaActions(params);
	const allowedActions = resolveAllowedMessageActions({
		cfg: params.cfg,
		agentId: params.agentId
	});
	if (!allowedActions) return discoveredActions;
	const allow = new Set(allowedActions);
	const filtered = discoveredActions.filter((action) => allow.has(action));
	return filtered.length > 0 ? filtered : allowedActions;
}
function listAllMessageToolActions(params) {
	const pluginActions = listAllChannelSupportedActions(buildMessageActionDiscoveryInput(params));
	return Array.from(new Set([
		"send",
		"broadcast",
		...pluginActions
	]));
}
function resolveIncludeCapability(params, capability) {
	const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
	if (currentChannel) return channelSupportsMessageCapabilityForChannel(buildMessageActionDiscoveryInput(params, currentChannel), capability);
	return channelSupportsMessageCapability(params.cfg, capability);
}
function resolveIncludePresentation(params) {
	return resolveIncludeCapability(params, "presentation");
}
function resolveIncludeDeliveryPin(params) {
	return resolveIncludeCapability(params, "delivery-pin");
}
function buildMessageToolSchema(params) {
	const actions = resolveMessageToolActionSchemaActions(params);
	const includePresentation = resolveIncludePresentation(params);
	const includeDeliveryPin = resolveIncludeDeliveryPin(params);
	const extraProperties = resolveChannelMessageToolSchemaProperties(buildMessageActionDiscoveryInput(params, normalizeMessageChannel(params.currentChannelProvider) ?? void 0));
	return buildMessageToolSchemaFromActions(actions.length > 0 ? actions : ["send"], {
		includePresentation,
		includeDeliveryPin,
		extraProperties
	});
}
function resolveAgentAccountId(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	return normalizeAccountId(trimmed);
}
function buildMessageToolDescription(options) {
	const baseDescription = "Send/delete/manage channel messages.";
	const resolvedOptions = options ?? {};
	const messageToolDiscoveryParams = resolvedOptions.config ? {
		cfg: resolvedOptions.config,
		currentChannelProvider: resolvedOptions.currentChannel,
		currentChannelId: resolvedOptions.currentChannelId,
		currentThreadTs: resolvedOptions.currentThreadTs,
		currentMessageId: resolvedOptions.currentMessageId,
		currentAccountId: resolvedOptions.currentAccountId,
		sessionKey: resolvedOptions.sessionKey,
		sessionId: resolvedOptions.sessionId,
		agentId: resolvedOptions.agentId,
		requesterSenderId: resolvedOptions.requesterSenderId,
		senderIsOwner: resolvedOptions.senderIsOwner
	} : void 0;
	if (messageToolDiscoveryParams) {
		const actions = resolveMessageToolActionSchemaActions(messageToolDiscoveryParams);
		if (actions.length > 0) {
			const sortedActions = Array.from(new Set(actions)).toSorted();
			return appendMessageToolReadHint(appendMessageToolVisibleReplyHint(`${baseDescription} Supports actions: ${sortedActions.join(", ")}.`, resolvedOptions.sourceReplyDeliveryMode, resolvedOptions.requireExplicitTarget), sortedActions);
		}
	}
	return appendMessageToolVisibleReplyHint(`${baseDescription} Supports actions: send, delete, react, poll, pin, threads, and more.`, resolvedOptions.sourceReplyDeliveryMode, resolvedOptions.requireExplicitTarget);
}
function appendMessageToolVisibleReplyHint(description, sourceReplyDeliveryMode, requireExplicitTarget) {
	if (sourceReplyDeliveryMode !== "message_tool_only") return description;
	return `${description} This turn: use action="send" with message for visible replies to the current source conversation. ${requireExplicitTarget ? "Include target when sending." : "target defaults to the current source conversation; omit unless sending elsewhere."} Normal final answers stay private.`;
}
function appendMessageToolReadHint(description, actions) {
	for (const action of actions) if (action === "read") return `${description}${MESSAGE_TOOL_THREAD_READ_HINT}`;
	return description;
}
function createMessageTool(options) {
	const loadConfigForTool = options?.getRuntimeConfig ?? getRuntimeConfig;
	const getScopedSecretTargetsForTool = options?.getScopedChannelsCommandSecretTargets ?? getScopedChannelsCommandSecretTargets;
	const resolveSecretRefsForTool = options?.resolveCommandSecretRefsViaGateway ?? resolveCommandSecretRefsViaGateway;
	const runMessageActionForTool = options?.runMessageAction ?? runMessageAction;
	let generatedIdempotencyCounter = 0;
	const effectiveCurrentChannel = resolveEffectiveCurrentChannelContext(options);
	const currentThreadTs = options?.currentThreadTs ?? (options?.agentThreadId != null ? stringifyRouteThreadId(options.agentThreadId) : effectiveCurrentChannel.currentThreadTs);
	const replyToMode = options?.replyToMode ?? (currentThreadTs ? "all" : void 0);
	const agentAccountId = resolveAgentAccountId(options?.agentAccountId) ?? effectiveCurrentChannel.accountId;
	const resolvedAgentId = options?.agentId ?? (options?.agentSessionKey ? resolveSessionAgentId({
		sessionKey: options.agentSessionKey,
		config: options?.config
	}) : void 0);
	const schema = options?.config ? buildMessageToolSchema({
		cfg: options.config,
		currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
		currentChannelId: effectiveCurrentChannel.currentChannelId,
		currentThreadTs,
		currentMessageId: options.currentMessageId,
		currentAccountId: agentAccountId,
		sessionKey: options.agentSessionKey,
		sessionId: options.sessionId,
		agentId: resolvedAgentId,
		requesterSenderId: options.requesterSenderId,
		senderIsOwner: options.senderIsOwner
	}) : MessageToolSchema;
	return {
		label: "Message",
		name: "message",
		displaySummary: "Send and manage messages across configured channels.",
		description: buildMessageToolDescription({
			config: options?.config,
			currentChannel: effectiveCurrentChannel.currentChannelProvider,
			currentChannelId: effectiveCurrentChannel.currentChannelId,
			currentThreadTs,
			currentMessageId: options?.currentMessageId,
			currentAccountId: agentAccountId,
			sessionKey: options?.agentSessionKey,
			sessionId: options?.sessionId,
			agentId: resolvedAgentId,
			requireExplicitTarget: options?.requireExplicitTarget,
			sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
			requesterSenderId: options?.requesterSenderId,
			senderIsOwner: options?.senderIsOwner
		}),
		parameters: schema,
		execute: async (toolCallId, args, signal) => {
			if (signal?.aborted) {
				const err = /* @__PURE__ */ new Error("Message send aborted");
				err.name = "AbortError";
				throw err;
			}
			const params = { ...args };
			for (const field of [
				"text",
				"content",
				"message",
				"caption"
			]) if (typeof params[field] === "string") params[field] = stripFormattedReasoningMessage(params[field]);
			params.presentation = sanitizePresentationTextFields(params.presentation);
			const action = readStringParam$1(params, "action", { required: true });
			if (options?.requireExplicitTarget === true && actionNeedsExplicitTarget(action)) {
				if (!(typeof params.target === "string" && params.target.trim().length > 0 || typeof params.to === "string" && params.to.trim().length > 0 || typeof params.channelId === "string" && params.channelId.trim().length > 0 || Array.isArray(params.targets) && params.targets.some((value) => typeof value === "string" && value.trim().length > 0))) throw new Error("Explicit message target required for this run. Provide target/targets (and channel when needed).");
			}
			const rawConfig = options?.config ?? loadConfigForTool();
			const scope = resolveMessageSecretScope({
				channel: params.channel,
				target: params.target,
				targets: params.targets,
				fallbackChannel: effectiveCurrentChannel.currentChannelProvider,
				accountId: params.accountId,
				fallbackAccountId: agentAccountId
			});
			const scopedTargets = getScopedSecretTargetsForTool({
				config: rawConfig,
				channel: scope.channel,
				accountId: scope.accountId
			});
			const cfg = (await resolveSecretRefsForTool({
				config: rawConfig,
				commandName: "tools.message",
				targetIds: scopedTargets.targetIds,
				...scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {},
				mode: "enforce_resolved"
			})).resolvedConfig;
			const accountId = readStringParam$1(params, "accountId") ?? agentAccountId;
			if (accountId) params.accountId = accountId;
			const gatewayResolved = resolveGatewayOptions({
				gatewayUrl: readStringParam$1(params, "gatewayUrl", { trim: false }),
				gatewayToken: readStringParam$1(params, "gatewayToken", { trim: false }),
				timeoutMs: readNumberParam(params, "timeoutMs")
			});
			const gateway = {
				url: gatewayResolved.url,
				token: gatewayResolved.token,
				timeoutMs: gatewayResolved.timeoutMs,
				clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
				clientDisplayName: "agent",
				mode: GATEWAY_CLIENT_MODES.BACKEND
			};
			const hasCurrentMessageId = typeof options?.currentMessageId === "number" || typeof options?.currentMessageId === "string" && options.currentMessageId.trim().length > 0;
			const toolContext = effectiveCurrentChannel.currentChannelId || effectiveCurrentChannel.currentChannelProvider || currentThreadTs || hasCurrentMessageId || replyToMode || options?.hasRepliedRef || options?.sameChannelThreadRequired ? {
				currentChannelId: effectiveCurrentChannel.currentChannelId,
				currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
				currentThreadTs,
				currentMessageId: options?.currentMessageId,
				replyToMode,
				hasRepliedRef: options?.hasRepliedRef,
				sameChannelThreadRequired: options?.sameChannelThreadRequired,
				skipCrossContextDecoration: true
			} : void 0;
			const actionIdempotencyKey = normalizeOptionalString(params.idempotencyKey) ?? (options?.runId ? `${options.runId}:message-tool:${normalizeToolCallIdForIdempotencyKey(toolCallId) ?? ++generatedIdempotencyCounter}` : void 0);
			const result = await runMessageActionForTool({
				cfg,
				action,
				params: actionIdempotencyKey ? {
					...params,
					idempotencyKey: actionIdempotencyKey
				} : params,
				defaultAccountId: accountId ?? void 0,
				requesterSenderId: options?.requesterSenderId,
				senderIsOwner: options?.senderIsOwner,
				gateway,
				toolContext,
				sessionKey: options?.agentSessionKey,
				sessionId: options?.sessionId,
				agentId: resolvedAgentId,
				sandboxRoot: options?.sandboxRoot,
				sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
				inboundEventKind: options?.inboundEventKind,
				abortSignal: signal
			});
			const toolResult = getToolResult(result);
			if (toolResult) return toolResult;
			return jsonResult(result.payload);
		}
	};
}
//#endregion
//#region src/music-generation/capabilities.ts
function resolveMusicGenerationMode(params) {
	return (params.inputImageCount ?? 0) > 0 ? "edit" : "generate";
}
function listSupportedMusicGenerationModes(provider) {
	const modes = ["generate"];
	if (provider.capabilities.edit?.enabled) modes.push("edit");
	return modes;
}
function resolveMusicGenerationModeCapabilities(params) {
	const mode = resolveMusicGenerationMode(params);
	const capabilities = params.provider?.capabilities;
	if (!capabilities) return {
		mode,
		capabilities: void 0
	};
	if (mode === "generate") return {
		mode,
		capabilities: capabilities.generate
	};
	return {
		mode,
		capabilities: capabilities.edit
	};
}
//#endregion
//#region src/music-generation/normalization.ts
function resolveModelBooleanSupport(model, defaultSupport, supportByModel) {
	return supportByModel?.[model] ?? defaultSupport === true;
}
function resolveMusicGenerationOverrides(params) {
	const { capabilities: caps } = resolveMusicGenerationModeCapabilities({
		provider: params.provider,
		inputImageCount: params.inputImages?.length ?? 0
	});
	const ignoredOverrides = [];
	const normalization = {};
	let lyrics = params.lyrics;
	let instrumental = params.instrumental;
	let durationSeconds = params.durationSeconds;
	let format = params.format;
	if (!caps) return {
		lyrics,
		instrumental,
		durationSeconds,
		format,
		ignoredOverrides
	};
	if (lyrics?.trim() && !resolveModelBooleanSupport(params.model, caps.supportsLyrics, caps.supportsLyricsByModel)) {
		ignoredOverrides.push({
			key: "lyrics",
			value: lyrics
		});
		lyrics = void 0;
	}
	if (typeof instrumental === "boolean" && !resolveModelBooleanSupport(params.model, caps.supportsInstrumental, caps.supportsInstrumentalByModel)) {
		ignoredOverrides.push({
			key: "instrumental",
			value: instrumental
		});
		instrumental = void 0;
	}
	if (typeof durationSeconds === "number" && !caps.supportsDuration) {
		ignoredOverrides.push({
			key: "durationSeconds",
			value: durationSeconds
		});
		durationSeconds = void 0;
	} else if (typeof durationSeconds === "number") {
		const normalizedDurationSeconds = normalizeDurationToClosestMax(durationSeconds, caps.maxDurationSeconds);
		if (typeof normalizedDurationSeconds === "number" && normalizedDurationSeconds !== durationSeconds) normalization.durationSeconds = {
			requested: durationSeconds,
			applied: normalizedDurationSeconds
		};
		durationSeconds = normalizedDurationSeconds;
	}
	if (format) {
		const supportedFormats = caps.supportedFormatsByModel?.[params.model] ?? caps.supportedFormats ?? [];
		if (!caps.supportsFormat || supportedFormats.length > 0 && !supportedFormats.includes(format)) {
			ignoredOverrides.push({
				key: "format",
				value: format
			});
			format = void 0;
		}
	}
	return {
		lyrics,
		instrumental,
		durationSeconds,
		format,
		ignoredOverrides,
		normalization: hasMediaNormalizationEntry(normalization.durationSeconds) ? normalization : void 0
	};
}
//#endregion
//#region src/music-generation/runtime.ts
const log$3 = createSubsystemLogger("music-generation");
function listRuntimeMusicGenerationProviders(params, deps = {}) {
	return (deps.listProviders ?? listMusicGenerationProviders)(params?.config);
}
async function generateMusic(params, deps = {}) {
	const getProvider = deps.getProvider ?? getMusicGenerationProvider;
	const listProviders = deps.listProviders ?? listMusicGenerationProviders;
	const logger = deps.log ?? log$3;
	const timeoutMs = params.timeoutMs ?? resolveAgentModelTimeoutMsValue(params.cfg.agents?.defaults?.musicGenerationModel);
	const candidates = resolveCapabilityModelCandidates({
		cfg: params.cfg,
		modelConfig: params.cfg.agents?.defaults?.musicGenerationModel,
		modelOverride: params.modelOverride,
		parseModelRef: parseMusicGenerationModelRef,
		agentDir: params.agentDir,
		listProviders,
		autoProviderFallback: params.autoProviderFallback
	});
	if (candidates.length === 0) throw new Error(buildNoCapabilityModelConfiguredMessage({
		capabilityLabel: "music-generation",
		modelConfigKey: "musicGenerationModel",
		providers: listProviders(params.cfg),
		fallbackSampleRef: "google/lyria-3-clip-preview",
		getProviderEnvVars: deps.getProviderEnvVars
	}));
	const attempts = [];
	let lastError;
	for (const candidate of candidates) {
		const provider = getProvider(candidate.provider, params.cfg);
		if (!provider) {
			const error = `No music-generation provider registered for ${candidate.provider}`;
			attempts.push({
				provider: candidate.provider,
				model: candidate.model,
				error
			});
			lastError = new Error(error);
			continue;
		}
		try {
			const sanitized = resolveMusicGenerationOverrides({
				provider,
				model: candidate.model,
				lyrics: params.lyrics,
				instrumental: params.instrumental,
				durationSeconds: params.durationSeconds,
				format: params.format,
				inputImages: params.inputImages
			});
			const result = await provider.generateMusic({
				provider: candidate.provider,
				model: candidate.model,
				prompt: params.prompt,
				cfg: params.cfg,
				agentDir: params.agentDir,
				authStore: params.authStore,
				lyrics: sanitized.lyrics,
				instrumental: sanitized.instrumental,
				durationSeconds: sanitized.durationSeconds,
				format: sanitized.format,
				inputImages: params.inputImages,
				...timeoutMs !== void 0 ? { timeoutMs } : {}
			});
			if (!Array.isArray(result.tracks) || result.tracks.length === 0) throw new Error("Music generation provider returned no tracks.");
			return {
				tracks: result.tracks,
				provider: candidate.provider,
				model: result.model ?? candidate.model,
				attempts,
				lyrics: result.lyrics,
				normalization: sanitized.normalization,
				metadata: {
					...result.metadata,
					...buildMediaGenerationNormalizationMetadata({ normalization: sanitized.normalization })
				},
				ignoredOverrides: sanitized.ignoredOverrides
			};
		} catch (err) {
			lastError = err;
			recordCapabilityCandidateFailure({
				attempts,
				provider: candidate.provider,
				model: candidate.model,
				error: err
			});
			logger.debug(`music-generation candidate failed: ${candidate.provider}/${candidate.model}`);
		}
	}
	return throwCapabilityGenerationFailure({
		capabilityLabel: "music generation",
		attempts,
		lastError
	});
}
//#endregion
//#region src/agents/music-generation-task-status.ts
const MUSIC_GENERATION_TASK_KIND = "music_generation";
const MUSIC_GENERATION_SOURCE_PREFIX = "music_generate";
const RECENT_MUSIC_GENERATION_DUPLICATE_GUARD_MS = 2 * 6e4;
function findActiveMusicGenerationTaskForSession(sessionKey) {
	return findActiveMediaGenerationTaskForSession({
		sessionKey,
		taskKind: MUSIC_GENERATION_TASK_KIND,
		sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX
	});
}
function findDuplicateGuardMusicGenerationTaskForSession(sessionKey, params) {
	return findDuplicateGuardMediaGenerationTaskForSession({
		sessionKey,
		taskKind: MUSIC_GENERATION_TASK_KIND,
		sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
		taskLabel: params?.prompt,
		requestKey: params?.requestKey,
		maxAgeMs: RECENT_MUSIC_GENERATION_DUPLICATE_GUARD_MS
	});
}
function buildMusicGenerationTaskStatusDetails(task) {
	return buildMediaGenerationTaskStatusDetails({
		task,
		sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX
	});
}
function buildMusicGenerationTaskStatusText(task, params) {
	return buildMediaGenerationTaskStatusText({
		task,
		sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
		nounLabel: "Music generation",
		toolName: "music_generate",
		completionLabel: "music",
		duplicateGuard: params?.duplicateGuard
	});
}
function buildActiveMusicGenerationTaskPromptContextForSession(sessionKey) {
	return buildActiveMediaGenerationTaskPromptContextForSession({
		sessionKey,
		taskKind: MUSIC_GENERATION_TASK_KIND,
		sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
		nounLabel: "Music generation",
		toolName: "music_generate",
		completionLabel: "music tracks"
	});
}
//#endregion
//#region src/agents/tools/music-generate-background.ts
const musicGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
	toolName: "music_generate",
	taskKind: MUSIC_GENERATION_TASK_KIND,
	label: "Music generation",
	queuedProgressSummary: "Queued music generation",
	generatedLabel: "track",
	failureProgressSummary: "Music generation failed",
	eventSource: "music_generation",
	announceType: "music generation task",
	completionLabel: "music"
});
const createMusicGenerationTaskRun = (...params) => musicGenerationTaskLifecycle.createTaskRun(...params);
const recordMusicGenerationTaskProgress = (...params) => musicGenerationTaskLifecycle.recordTaskProgress(...params);
const completeMusicGenerationTaskRun = (...params) => musicGenerationTaskLifecycle.completeTaskRun(...params);
const failMusicGenerationTaskRun = (...params) => musicGenerationTaskLifecycle.failTaskRun(...params);
//#endregion
//#region src/agents/tools/music-generate-tool.actions.ts
function summarizeMusicGenerationCapabilities(provider) {
	const supportedModes = listSupportedMusicGenerationModes(provider);
	const generate = provider.capabilities.generate;
	const edit = provider.capabilities.edit;
	return [
		supportedModes.length > 0 ? `modes=${supportedModes.join("/")}` : null,
		generate?.maxTracks ? `maxTracks=${generate.maxTracks}` : null,
		edit?.maxInputImages ? `maxInputImages=${edit.maxInputImages}` : null,
		generate?.maxDurationSeconds ? `maxDurationSeconds=${generate.maxDurationSeconds}` : null,
		generate?.supportsLyrics ? "lyrics" : null,
		generate?.supportsLyricsByModel && Object.keys(generate.supportsLyricsByModel).length > 0 ? `supportsLyricsByModel=${Object.entries(generate.supportsLyricsByModel).map(([modelId, supported]) => `${modelId}:${supported}`).join("; ")}` : null,
		generate?.supportsInstrumental ? "instrumental" : null,
		generate?.supportsInstrumentalByModel && Object.keys(generate.supportsInstrumentalByModel).length > 0 ? `supportsInstrumentalByModel=${Object.entries(generate.supportsInstrumentalByModel).map(([modelId, supported]) => `${modelId}:${supported}`).join("; ")}` : null,
		generate?.supportsDuration ? "duration" : null,
		generate?.supportsFormat ? "format" : null,
		generate?.supportedFormats?.length ? `supportedFormats=${generate.supportedFormats.join("/")}` : null,
		generate?.supportedFormatsByModel && Object.keys(generate.supportedFormatsByModel).length > 0 ? `supportedFormatsByModel=${Object.entries(generate.supportedFormatsByModel).map(([modelId, formats]) => `${modelId}:${formats.join("/")}`).join("; ")}` : null
	].filter((entry) => Boolean(entry)).join(", ");
}
function createMusicGenerateListActionResult(config, options) {
	return createMediaGenerateProviderListActionResult({
		kind: "music_generation",
		providers: listRuntimeMusicGenerationProviders({ config }),
		emptyText: "No music-generation providers are registered.",
		cfg: config,
		workspaceDir: options?.workspaceDir,
		agentDir: options?.agentDir,
		authStore: options?.authStore,
		listModes: listSupportedMusicGenerationModes,
		summarizeCapabilities: summarizeMusicGenerationCapabilities
	});
}
const musicGenerateTaskStatusActions = createMediaGenerateTaskStatusActions({
	inactiveText: "No active music generation task is currently running for this session.",
	findActiveTask: (sessionKey) => findActiveMusicGenerationTaskForSession(sessionKey) ?? void 0,
	buildStatusText: buildMusicGenerationTaskStatusText,
	buildStatusDetails: buildMusicGenerationTaskStatusDetails
});
function createMusicGenerateStatusActionResult(sessionKey) {
	return musicGenerateTaskStatusActions.createStatusActionResult(sessionKey);
}
function createMusicGenerateDuplicateGuardResult(sessionKey, params) {
	const blockingTask = findDuplicateGuardMusicGenerationTaskForSession(sessionKey, {
		prompt: params?.prompt,
		requestKey: params?.requestKey
	});
	if (!blockingTask) return;
	return {
		content: [{
			type: "text",
			text: buildMusicGenerationTaskStatusText(blockingTask, { duplicateGuard: true })
		}],
		details: {
			action: "status",
			duplicateGuard: true,
			...buildMusicGenerationTaskStatusDetails(blockingTask)
		}
	};
}
//#endregion
//#region src/agents/tools/music-generate-tool.ts
const log$2 = createSubsystemLogger("agents/tools/music-generate");
const MAX_INPUT_IMAGES$1 = 10;
const SUPPORTED_OUTPUT_FORMATS = new Set(["mp3", "wav"]);
const DEFAULT_REFERENCE_FETCH_TIMEOUT_MS = 3e4;
const DEFAULT_MUSIC_GENERATION_TIMEOUT_MS = 3e5;
const MIN_MUSIC_GENERATION_TIMEOUT_MS = 12e4;
const MusicGenerateToolSchema = Type.Object({
	action: Type.Optional(Type.String({ description: "\"generate\" default, \"status\" active task, \"list\" providers/models." })),
	prompt: Type.Optional(Type.String({ description: "Music prompt: style, genre, mood, purpose." })),
	lyrics: Type.Optional(Type.String({ description: "Exact sung lyrics only when the user supplies lyrics or asks for vocal words. For song/style requests, use prompt instead." })),
	instrumental: Type.Optional(Type.Boolean({ description: "Instrumental-only toggle." })),
	image: Type.Optional(Type.String({ description: "Reference image path/URL." })),
	images: Type.Optional(Type.Array(Type.String(), { description: `Reference images; max ${MAX_INPUT_IMAGES$1}.` })),
	model: Type.Optional(Type.String({ description: "Provider/model override, e.g. google/lyria-3-pro-preview." })),
	durationSeconds: Type.Optional(Type.Number({
		description: "Target seconds; provider may clamp.",
		minimum: 1
	})),
	format: Type.Optional(Type.String({ description: "Output format: mp3, wav." })),
	filename: Type.Optional(Type.String({ description: "Output filename hint; basename preserved in managed media dir." }))
});
function resolveMusicGenerationModelConfigForTool(params) {
	return resolveCapabilityModelConfigForTool({
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore,
		modelConfig: params.cfg?.agents?.defaults?.musicGenerationModel,
		providers: () => listRuntimeMusicGenerationProviders({ config: params.cfg })
	});
}
function hasExplicitMusicGenerationModelConfig(cfg) {
	return hasToolModelConfig$1(coerceToolModelConfig(cfg?.agents?.defaults?.musicGenerationModel));
}
function resolveSelectedMusicGenerationProvider(params) {
	return resolveSelectedCapabilityProvider({
		providers: listRuntimeMusicGenerationProviders({ config: params.config }),
		modelConfig: params.musicGenerationModelConfig,
		modelOverride: params.modelOverride,
		parseModelRef: parseMusicGenerationModelRef
	});
}
function resolveAction$1(args) {
	return resolveGenerateAction({
		args,
		allowed: [
			"generate",
			"status",
			"list"
		],
		defaultAction: "generate"
	});
}
function normalizeOutputFormat(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	if (!normalized) return;
	if (SUPPORTED_OUTPUT_FORMATS.has(normalized)) return normalized;
	throw new ToolInputError("format must be one of \"mp3\" or \"wav\"");
}
function normalizeReferenceImageInputs(args) {
	return normalizeMediaReferenceInputs({
		args,
		singularKey: "image",
		pluralKey: "images",
		maxCount: MAX_INPUT_IMAGES$1,
		label: "reference images"
	});
}
function validateMusicGenerationCapabilities(params) {
	const provider = params.provider;
	if (!provider) return;
	const { capabilities: caps } = resolveMusicGenerationModeCapabilities({
		provider,
		inputImageCount: params.inputImageCount
	});
	if (params.inputImageCount > 0) {
		if (!caps) throw new ToolInputError(`${provider.id} does not support reference-image edit inputs.`);
		if ("enabled" in caps && !caps.enabled) throw new ToolInputError(`${provider.id} does not support reference-image edit inputs.`);
		const maxInputImages = ("maxInputImages" in caps ? caps.maxInputImages : void 0) ?? MAX_INPUT_IMAGES$1;
		if (params.inputImageCount > maxInputImages) throw new ToolInputError(`${provider.id} supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`);
	}
	if (!caps) return;
}
function normalizeMusicGenerationTimeoutMs(timeoutMs) {
	if (timeoutMs === void 0) return { timeoutMs: DEFAULT_MUSIC_GENERATION_TIMEOUT_MS };
	if (timeoutMs >= MIN_MUSIC_GENERATION_TIMEOUT_MS) return { timeoutMs };
	const normalization = {
		requested: timeoutMs,
		applied: MIN_MUSIC_GENERATION_TIMEOUT_MS,
		minimum: MIN_MUSIC_GENERATION_TIMEOUT_MS
	};
	const message = `Timeout normalized: requested ${timeoutMs}ms; used ${MIN_MUSIC_GENERATION_TIMEOUT_MS}ms.`;
	log$2.warn("music_generate timeoutMs is below provider minimum; using minimum", {
		requestedTimeoutMs: timeoutMs,
		appliedTimeoutMs: MIN_MUSIC_GENERATION_TIMEOUT_MS,
		minimumTimeoutMs: MIN_MUSIC_GENERATION_TIMEOUT_MS
	});
	return {
		timeoutMs: MIN_MUSIC_GENERATION_TIMEOUT_MS,
		normalization,
		message
	};
}
const defaultScheduleMusicGenerateBackgroundWork = createDefaultMediaGenerateBackgroundScheduler({
	toolName: "music_generate",
	onCrash: (message, meta) => log$2.error(message, meta)
});
async function loadReferenceImages(params) {
	const loaded = [];
	for (const rawInput of params.inputs) {
		const trimmed = rawInput.trim();
		const inputRaw = normalizeMediaReferenceSource(trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed);
		if (!inputRaw) throw new ToolInputError("image required (empty string in array)");
		const refInfo = classifyMediaReferenceSource(inputRaw);
		const { isDataUrl, isHttpUrl } = refInfo;
		if (refInfo.hasUnsupportedScheme) throw new ToolInputError(`Unsupported image reference: ${rawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`);
		if (params.sandboxConfig && isHttpUrl) throw new ToolInputError("Sandboxed music_generate does not allow remote image URLs.");
		const resolvedInput = params.sandboxConfig ? inputRaw : inputRaw.startsWith("~") ? resolveUserPath(inputRaw) : inputRaw;
		const resolvedPathInfo = isDataUrl ? { resolved: "" } : params.sandboxConfig ? await resolveSandboxedBridgeMediaPath({
			sandbox: params.sandboxConfig,
			mediaPath: resolvedInput,
			inboundFallbackDir: "media/inbound"
		}) : { resolved: resolvedInput.startsWith("file://") ? resolvedInput.slice(7) : resolvedInput };
		const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;
		const localRoots = resolveMediaToolLocalRoots(params.workspaceDir, { workspaceOnly: params.sandboxConfig?.workspaceOnly === true }, resolvedPath ? [resolvedPath] : void 0);
		const media = isDataUrl ? decodeDataUrl(resolvedInput) : params.sandboxConfig ? await loadWebMedia(resolvedPath ?? resolvedInput, {
			sandboxValidated: true,
			readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig })
		}) : await (async () => {
			const referenceTarget = resolvedPath ?? resolvedInput;
			const isRemoteReference = /^https?:\/\//i.test(referenceTarget);
			const { signal, cleanup } = buildTimeoutAbortSignal({
				timeoutMs: params.timeoutMs ?? DEFAULT_REFERENCE_FETCH_TIMEOUT_MS,
				operation: "music-generate.reference-fetch",
				...isRemoteReference ? { url: referenceTarget } : {}
			});
			try {
				return await loadWebMedia(resolvedPath ?? resolvedInput, {
					localRoots,
					requestInit: signal ? { signal } : void 0,
					ssrfPolicy: params.ssrfPolicy
				});
			} finally {
				cleanup();
			}
		})();
		if (media.kind !== "image") throw new ToolInputError(`Unsupported media type: ${media.kind ?? "unknown"}`);
		const mimeType = "mimeType" in media ? media.mimeType : media.contentType;
		const fileName = "fileName" in media ? media.fileName : void 0;
		loaded.push({
			sourceImage: {
				buffer: media.buffer,
				mimeType,
				fileName
			},
			resolvedInput,
			...resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}
		});
	}
	return loaded;
}
async function executeMusicGenerationJob(params) {
	if (params.taskHandle) recordMusicGenerationTaskProgress({
		handle: params.taskHandle,
		progressSummary: "Generating music"
	});
	const result = await generateMusic({
		cfg: params.effectiveCfg,
		prompt: params.prompt,
		agentDir: params.agentDir,
		modelOverride: params.model,
		lyrics: params.lyrics,
		instrumental: params.instrumental,
		durationSeconds: params.durationSeconds,
		format: params.format,
		inputImages: params.loadedReferenceImages.map((entry) => entry.sourceImage),
		autoProviderFallback: params.autoProviderFallback,
		timeoutMs: params.timeoutMs
	});
	if (params.taskHandle) recordMusicGenerationTaskProgress({
		handle: params.taskHandle,
		progressSummary: "Saving generated music"
	});
	const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "audio");
	const savedTracks = await Promise.all(result.tracks.map((track) => saveMediaBuffer(track.buffer, track.mimeType, "tool-music-generation", mediaMaxBytes, params.filename || track.fileName)));
	const ignoredOverrides = result.ignoredOverrides ?? [];
	const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
	const requestedDurationSeconds = result.normalization?.durationSeconds?.requested ?? (typeof result.metadata?.requestedDurationSeconds === "number" && Number.isFinite(result.metadata.requestedDurationSeconds) ? result.metadata.requestedDurationSeconds : params.durationSeconds);
	const appliedDurationSeconds = result.normalization?.durationSeconds?.applied ?? (typeof result.metadata?.normalizedDurationSeconds === "number" && Number.isFinite(result.metadata.normalizedDurationSeconds) ? result.metadata.normalizedDurationSeconds : void 0) ?? (!ignoredOverrideKeys.has("durationSeconds") && typeof params.durationSeconds === "number" ? params.durationSeconds : void 0);
	const warning = ignoredOverrides.length > 0 ? `Ignored unsupported overrides for ${result.provider}/${result.model}: ${ignoredOverrides.map((entry) => `${entry.key}=${String(entry.value)}`).join(", ")}.` : void 0;
	const attachments = savedTracks.map((track, index) => ({
		type: "audio",
		path: track.path,
		mimeType: track.contentType,
		name: result.tracks[index]?.fileName
	}));
	const lines = [
		`Generated ${savedTracks.length} track${savedTracks.length === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
		...warning ? [`Warning: ${warning}`] : [],
		...params.timeoutNormalization ? [`Timeout normalized: requested ${params.timeoutNormalization.requested}ms; used ${params.timeoutNormalization.applied}ms.`] : [],
		typeof requestedDurationSeconds === "number" && typeof appliedDurationSeconds === "number" && requestedDurationSeconds !== appliedDurationSeconds ? `Duration normalized: requested ${requestedDurationSeconds}s; used ${appliedDurationSeconds}s.` : null,
		...result.lyrics?.length ? ["Lyrics returned.", ...result.lyrics] : [],
		...formatGeneratedAttachmentLines(attachments)
	].filter((entry) => Boolean(entry));
	return {
		provider: result.provider,
		model: result.model,
		savedPaths: savedTracks.map((track) => track.path),
		count: savedTracks.length,
		paths: savedTracks.map((track) => track.path),
		attachments,
		contentText: lines.join("\n"),
		wakeResult: lines.join("\n"),
		details: {
			provider: result.provider,
			model: result.model,
			count: savedTracks.length,
			media: {
				mediaUrls: savedTracks.map((track) => track.path),
				attachments
			},
			attachments,
			paths: savedTracks.map((track) => track.path),
			...buildTaskRunDetails(params.taskHandle),
			...!ignoredOverrideKeys.has("lyrics") && params.lyrics ? { requestedLyrics: params.lyrics } : {},
			...!ignoredOverrideKeys.has("instrumental") && typeof params.instrumental === "boolean" ? { instrumental: params.instrumental } : {},
			...typeof appliedDurationSeconds === "number" ? { durationSeconds: appliedDurationSeconds } : {},
			...typeof requestedDurationSeconds === "number" && typeof appliedDurationSeconds === "number" && requestedDurationSeconds !== appliedDurationSeconds ? { requestedDurationSeconds } : {},
			...!ignoredOverrideKeys.has("format") && params.format ? { format: params.format } : {},
			...params.filename ? { filename: params.filename } : {},
			...params.timeoutMs !== void 0 ? { timeoutMs: params.timeoutMs } : {},
			...params.timeoutNormalization ? {
				requestedTimeoutMs: params.timeoutNormalization.requested,
				timeoutNormalization: params.timeoutNormalization
			} : {},
			...buildMediaReferenceDetails({
				entries: params.loadedReferenceImages,
				singleKey: "image",
				pluralKey: "images",
				getResolvedInput: (entry) => entry.resolvedInput
			}),
			...result.lyrics?.length ? { lyrics: result.lyrics } : {},
			attempts: result.attempts,
			...result.normalization ? { normalization: result.normalization } : {},
			metadata: result.metadata,
			...warning ? { warning } : {},
			...ignoredOverrides.length > 0 ? { ignoredOverrides } : {}
		}
	};
}
function createMusicGenerateTool(options) {
	const cfg = options?.config ?? getRuntimeConfig();
	if (!hasGenerationToolAvailability({
		cfg,
		agentDir: options?.agentDir,
		workspaceDir: options?.workspaceDir,
		authStore: options?.authProfileStore,
		modelConfig: cfg.agents?.defaults?.musicGenerationModel,
		providerKey: "musicGenerationProviders"
	})) return null;
	const sandboxConfig = options?.sandbox ? {
		root: options.sandbox.root,
		bridge: options.sandbox.bridge,
		workspaceOnly: options.fsPolicy?.workspaceOnly === true
	} : null;
	const scheduleBackgroundWork = options?.scheduleBackgroundWork ?? defaultScheduleMusicGenerateBackgroundWork;
	return {
		label: "Music Generation",
		name: "music_generate",
		displaySummary: "Generate music",
		description: "Create audio/music for song, jingle, beat, loop, soundtrack, anthem, instrumental requests. If user asks make/generate/create song/music, call music_generate; do not just write lyrics unless lyrics/text only. Prompt gets style/genre/mood/tempo/instruments/purpose. lyrics only exact sung words. Session chats: background task; do not call again for same request; wait completion, send attachments via message tool. \"status\" checks active task.",
		parameters: MusicGenerateToolSchema,
		execute: async (_toolCallId, rawArgs) => {
			const args = rawArgs;
			const action = resolveAction$1(args);
			if (action === "list") return createMusicGenerateListActionResult(cfg, {
				workspaceDir: options?.workspaceDir,
				agentDir: options?.agentDir,
				authStore: options?.authProfileStore
			});
			if (action === "status") return createMusicGenerateStatusActionResult(options?.agentSessionKey);
			const musicGenerationModelConfig = resolveMusicGenerationModelConfigForTool({
				cfg,
				workspaceDir: options?.workspaceDir,
				agentDir: options?.agentDir,
				authStore: options?.authProfileStore
			});
			if (!musicGenerationModelConfig) throw new ToolInputError("No music-generation model configured.");
			const explicitModelConfig = hasExplicitMusicGenerationModelConfig(cfg);
			const effectiveCfg = applyMusicGenerationModelConfigDefaults(cfg, musicGenerationModelConfig) ?? cfg;
			const prompt = readStringParam$1(args, "prompt", { required: true });
			const activeDuplicateGuardResult = createMusicGenerateDuplicateGuardResult(options?.agentSessionKey);
			if (activeDuplicateGuardResult) return activeDuplicateGuardResult;
			const lyrics = readStringParam$1(args, "lyrics");
			const instrumental = readBooleanToolParam(args, "instrumental");
			const model = readStringParam$1(args, "model");
			const durationSeconds = readNumberParam(args, "durationSeconds", {
				integer: true,
				strict: true
			});
			const format = normalizeOutputFormat(readStringParam$1(args, "format"));
			const filename = readStringParam$1(args, "filename");
			const timeout = normalizeMusicGenerationTimeoutMs(musicGenerationModelConfig.timeoutMs);
			const timeoutMs = timeout.timeoutMs;
			const imageInputs = normalizeReferenceImageInputs(args);
			const explicitModelRef = parseMusicGenerationModelRef(model);
			const primaryModelRef = parseMusicGenerationModelRef(musicGenerationModelConfig.primary);
			const selectedModelRef = explicitModelRef ?? primaryModelRef;
			const selectedProvider = imageInputs.length > 0 || model !== void 0 && !explicitModelRef || model === void 0 && !primaryModelRef ? resolveSelectedMusicGenerationProvider({
				config: effectiveCfg,
				musicGenerationModelConfig,
				modelOverride: model
			}) : void 0;
			const selectedProviderId = selectedProvider?.id ?? selectedModelRef?.provider;
			const requestKey = buildMediaGenerationRequestKey({
				tool: "music_generate",
				prompt,
				provider: selectedProviderId,
				model: model !== void 0 ? explicitModelRef?.model ?? model : primaryModelRef?.model ?? musicGenerationModelConfig.primary ?? selectedProvider?.defaultModel,
				lyrics,
				instrumental,
				durationSeconds,
				format,
				filename,
				imageInputs
			});
			const duplicateGuardResult = createMusicGenerateDuplicateGuardResult(options?.agentSessionKey, { requestKey });
			if (duplicateGuardResult) return duplicateGuardResult;
			const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
			const loadedReferenceImages = await loadReferenceImages({
				inputs: imageInputs,
				workspaceDir: options?.workspaceDir,
				sandboxConfig,
				ssrfPolicy: remoteMediaSsrfPolicy
			});
			validateMusicGenerationCapabilities({
				provider: selectedProvider,
				model: selectedModelRef?.model ?? model ?? selectedProvider?.defaultModel,
				inputImageCount: loadedReferenceImages.length,
				lyrics,
				instrumental,
				durationSeconds,
				format
			});
			const taskHandle = createMusicGenerationTaskRun({
				sessionKey: options?.agentSessionKey,
				requesterOrigin: options?.requesterOrigin,
				prompt,
				providerId: selectedProvider?.id ?? selectedModelRef?.provider
			});
			if (Boolean(taskHandle && options?.agentSessionKey?.trim()) && taskHandle) {
				recordRecentMediaGenerationTaskStartForSession({
					sessionKey: options?.agentSessionKey,
					taskKind: "music_generation",
					sourcePrefix: "music_generate",
					taskId: taskHandle.taskId,
					runId: taskHandle.runId,
					taskLabel: prompt,
					requestKey,
					providerId: selectedProviderId,
					progressSummary: "Generating music"
				});
				scheduleMediaGenerationTaskCompletion({
					lifecycle: musicGenerationTaskLifecycle,
					handle: taskHandle,
					scheduleBackgroundWork,
					progressSummary: "Generating music",
					config: effectiveCfg,
					toolName: "Music generation",
					onWakeFailure: (message, meta) => log$2.warn(message, meta),
					run: () => executeMusicGenerationJob({
						effectiveCfg,
						prompt,
						agentDir: options?.agentDir,
						model,
						lyrics,
						instrumental,
						durationSeconds,
						format,
						filename,
						loadedReferenceImages,
						taskHandle,
						autoProviderFallback: explicitModelConfig ? false : void 0,
						timeoutMs,
						timeoutNormalization: timeout.normalization
					})
				});
				await notifyMediaGenerationAsyncTaskStarted({
					callback: options?.onAsyncTaskStarted,
					message: "Music generation started; wait for the generated music completion event.",
					toolName: "music_generate",
					handle: taskHandle,
					onFailure: (message, meta) => log$2.warn(message, meta)
				});
				return buildMediaGenerationStartedToolResult({
					toolName: "music_generate",
					generationLabel: "music",
					completionLabel: "music",
					taskHandle,
					messages: [timeout.message],
					detailExtras: {
						...buildMediaReferenceDetails({
							entries: loadedReferenceImages,
							singleKey: "image",
							pluralKey: "images",
							getResolvedInput: (entry) => entry.resolvedInput
						}),
						...model ? { model } : {},
						...lyrics ? { requestedLyrics: lyrics } : {},
						...typeof instrumental === "boolean" ? { instrumental } : {},
						...typeof durationSeconds === "number" ? { durationSeconds } : {},
						...format ? { format } : {},
						...filename ? { filename } : {},
						...timeoutMs !== void 0 ? { timeoutMs } : {},
						...timeout.normalization ? {
							requestedTimeoutMs: timeout.normalization.requested,
							timeoutNormalization: timeout.normalization,
							warning: timeout.message
						} : {}
					}
				});
			}
			try {
				const executed = await executeMusicGenerationJob({
					effectiveCfg,
					prompt,
					agentDir: options?.agentDir,
					lyrics,
					instrumental,
					durationSeconds,
					model,
					format,
					filename,
					loadedReferenceImages,
					taskHandle,
					autoProviderFallback: explicitModelConfig ? false : void 0,
					timeoutMs,
					timeoutNormalization: timeout.normalization
				});
				completeMusicGenerationTaskRun({
					handle: taskHandle,
					provider: executed.provider,
					model: executed.model,
					count: executed.savedPaths.length,
					paths: executed.savedPaths
				});
				return {
					content: [{
						type: "text",
						text: executed.contentText
					}],
					details: executed.details
				};
			} catch (error) {
				failMusicGenerationTaskRun({
					handle: taskHandle,
					error
				});
				throw error;
			}
		}
	};
}
//#endregion
//#region src/agents/tools/nodes-tool-media.ts
const MEDIA_INVOKE_ACTIONS = {
	"camera.snap": "camera_snap",
	"camera.clip": "camera_clip",
	"photos.latest": "photos_latest",
	"screen.record": "screen_record",
	"file.fetch": "file_fetch",
	"dir.list": "dir_list",
	"dir.fetch": "dir_fetch",
	"file.write": "file_write"
};
const POLICY_REDIRECT_INVOKE_COMMANDS = new Set([
	"file.fetch",
	"dir.list",
	"dir.fetch",
	"file.write"
]);
async function executeNodeMediaAction(input) {
	switch (input.action) {
		case "camera_snap": return await executeCameraSnap(input);
		case "photos_latest": return await executePhotosLatest(input);
		case "camera_clip": return await executeCameraClip(input);
		case "screen_record": return await executeScreenRecord(input);
	}
	throw new Error("Unsupported node media action");
}
async function executeCameraSnap({ params, gatewayOpts, modelHasVision, imageSanitization }) {
	const resolvedNode = await resolveNode(gatewayOpts, requireString(params, "node"));
	const nodeId = resolvedNode.nodeId;
	const facingRaw = normalizeLowercaseStringOrEmpty(params.facing) || "front";
	const facings = facingRaw === "both" ? ["front", "back"] : facingRaw === "front" || facingRaw === "back" ? [facingRaw] : (() => {
		throw new Error("invalid facing (front|back|both)");
	})();
	const maxWidth = typeof params.maxWidth === "number" && Number.isFinite(params.maxWidth) ? params.maxWidth : 1600;
	const quality = typeof params.quality === "number" && Number.isFinite(params.quality) ? params.quality : .95;
	const delayMs = typeof params.delayMs === "number" && Number.isFinite(params.delayMs) ? params.delayMs : void 0;
	const deviceId = typeof params.deviceId === "string" && params.deviceId.trim() ? params.deviceId.trim() : void 0;
	if (deviceId && facings.length > 1) throw new Error("facing=both is not allowed when deviceId is set");
	const content = [];
	const details = [];
	for (const facing of facings) {
		const payload = parseCameraSnapPayload((await callGatewayTool("node.invoke", gatewayOpts, {
			nodeId,
			command: "camera.snap",
			params: {
				facing,
				maxWidth,
				quality,
				format: "jpg",
				delayMs,
				deviceId
			},
			idempotencyKey: crypto.randomUUID()
		}))?.payload);
		const normalizedFormat = normalizeLowercaseStringOrEmpty(payload.format);
		if (normalizedFormat !== "jpg" && normalizedFormat !== "jpeg" && normalizedFormat !== "png") throw new Error(`unsupported camera.snap format: ${payload.format}`);
		const isJpeg = normalizedFormat === "jpg" || normalizedFormat === "jpeg";
		const filePath = cameraTempPath({
			kind: "snap",
			facing,
			ext: isJpeg ? "jpg" : "png"
		});
		await writeCameraPayloadToFile({
			filePath,
			payload,
			expectedHost: resolvedNode.remoteIp,
			invalidPayloadMessage: "invalid camera.snap payload"
		});
		if (modelHasVision && payload.base64) content.push({
			type: "image",
			data: payload.base64,
			mimeType: imageMimeFromFormat(payload.format) ?? (isJpeg ? "image/jpeg" : "image/png")
		});
		details.push({
			facing,
			path: filePath,
			width: payload.width,
			height: payload.height
		});
	}
	return await sanitizeToolResultImages({
		content,
		details: {
			snaps: details,
			media: { mediaUrls: details.map((entry) => entry.path).filter((path) => typeof path === "string") }
		}
	}, "nodes:camera_snap", imageSanitization);
}
async function executePhotosLatest({ params, gatewayOpts, modelHasVision, imageSanitization }) {
	const resolvedNode = await resolveNode(gatewayOpts, requireString(params, "node"));
	const nodeId = resolvedNode.nodeId;
	const limitRaw = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : DEFAULT_PHOTOS_LIMIT;
	const raw = await callGatewayTool("node.invoke", gatewayOpts, {
		nodeId,
		command: "photos.latest",
		params: {
			limit: Math.max(1, Math.min(limitRaw, MAX_PHOTOS_LIMIT)),
			maxWidth: typeof params.maxWidth === "number" && Number.isFinite(params.maxWidth) ? params.maxWidth : DEFAULT_PHOTOS_MAX_WIDTH,
			quality: typeof params.quality === "number" && Number.isFinite(params.quality) ? params.quality : DEFAULT_PHOTOS_QUALITY
		},
		idempotencyKey: crypto.randomUUID()
	});
	const payload = raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : {};
	const photos = Array.isArray(payload.photos) ? payload.photos : [];
	if (photos.length === 0) return await sanitizeToolResultImages({
		content: [],
		details: []
	}, "nodes:photos_latest", imageSanitization);
	const content = [];
	const details = [];
	for (const [index, photoRaw] of photos.entries()) {
		const photo = parseCameraSnapPayload(photoRaw);
		const normalizedFormat = normalizeLowercaseStringOrEmpty(photo.format);
		if (normalizedFormat !== "jpg" && normalizedFormat !== "jpeg" && normalizedFormat !== "png") throw new Error(`unsupported photos.latest format: ${photo.format}`);
		const isJpeg = normalizedFormat === "jpg" || normalizedFormat === "jpeg";
		const filePath = cameraTempPath({
			kind: "snap",
			ext: isJpeg ? "jpg" : "png",
			id: crypto.randomUUID()
		});
		await writeCameraPayloadToFile({
			filePath,
			payload: photo,
			expectedHost: resolvedNode.remoteIp,
			invalidPayloadMessage: "invalid photos.latest payload"
		});
		if (modelHasVision && photo.base64) content.push({
			type: "image",
			data: photo.base64,
			mimeType: imageMimeFromFormat(photo.format) ?? (isJpeg ? "image/jpeg" : "image/png")
		});
		const createdAt = photoRaw && typeof photoRaw === "object" && !Array.isArray(photoRaw) ? photoRaw.createdAt : void 0;
		details.push({
			index,
			path: filePath,
			width: photo.width,
			height: photo.height,
			...typeof createdAt === "string" ? { createdAt } : {}
		});
	}
	return await sanitizeToolResultImages({
		content,
		details: {
			photos: details,
			media: { mediaUrls: details.map((entry) => entry.path).filter((path) => typeof path === "string") }
		}
	}, "nodes:photos_latest", imageSanitization);
}
async function executeCameraClip({ params, gatewayOpts }) {
	const resolvedNode = await resolveNode(gatewayOpts, requireString(params, "node"));
	const nodeId = resolvedNode.nodeId;
	const facing = normalizeLowercaseStringOrEmpty(params.facing) || "front";
	if (facing !== "front" && facing !== "back") throw new Error("invalid facing (front|back)");
	const payload = parseCameraClipPayload((await callGatewayTool("node.invoke", gatewayOpts, {
		nodeId,
		command: "camera.clip",
		params: {
			facing,
			durationMs: typeof params.durationMs === "number" && Number.isFinite(params.durationMs) ? params.durationMs : typeof params.duration === "string" ? parseDurationMs(params.duration) : 3e3,
			includeAudio: typeof params.includeAudio === "boolean" ? params.includeAudio : true,
			format: "mp4",
			deviceId: typeof params.deviceId === "string" && params.deviceId.trim() ? params.deviceId.trim() : void 0
		},
		idempotencyKey: crypto.randomUUID()
	}))?.payload);
	const filePath = await writeCameraClipPayloadToFile({
		payload,
		facing,
		expectedHost: resolvedNode.remoteIp
	});
	return {
		content: [{
			type: "text",
			text: `FILE:${filePath}`
		}],
		details: {
			facing,
			path: filePath,
			durationMs: payload.durationMs,
			hasAudio: payload.hasAudio
		}
	};
}
async function executeScreenRecord({ params, gatewayOpts }) {
	const nodeId = await resolveNodeId(gatewayOpts, requireString(params, "node"));
	const durationMs = Math.min(typeof params.durationMs === "number" && Number.isFinite(params.durationMs) ? params.durationMs : typeof params.duration === "string" ? parseDurationMs(params.duration) : 1e4, 3e5);
	const fps = typeof params.fps === "number" && Number.isFinite(params.fps) ? params.fps : 10;
	const payload = parseScreenRecordPayload((await callGatewayTool("node.invoke", gatewayOpts, {
		nodeId,
		command: "screen.record",
		params: {
			durationMs,
			screenIndex: typeof params.screenIndex === "number" && Number.isFinite(params.screenIndex) ? params.screenIndex : 0,
			fps,
			format: "mp4",
			includeAudio: typeof params.includeAudio === "boolean" ? params.includeAudio : true
		},
		idempotencyKey: crypto.randomUUID()
	}))?.payload);
	const written = await writeScreenRecordToFile(typeof params.outPath === "string" && params.outPath.trim() ? params.outPath.trim() : screenRecordTempPath({ ext: payload.format || "mp4" }), payload.base64);
	return {
		content: [{
			type: "text",
			text: `FILE:${written.path}`
		}],
		details: {
			path: written.path,
			durationMs: payload.durationMs,
			fps: payload.fps,
			screenIndex: payload.screenIndex,
			hasAudio: payload.hasAudio
		}
	};
}
function requireString(params, key) {
	const raw = params[key];
	if (typeof raw !== "string" || raw.trim().length === 0) throw new Error(`${key} required`);
	return raw.trim();
}
const DEFAULT_PHOTOS_LIMIT = 1;
const MAX_PHOTOS_LIMIT = 20;
const DEFAULT_PHOTOS_MAX_WIDTH = 1600;
const DEFAULT_PHOTOS_QUALITY = .85;
//#endregion
//#region src/agents/tools/nodes-tool-commands.ts
const BLOCKED_INVOKE_COMMANDS = new Set(["system.run", "system.run.prepare"]);
const NODE_READ_ACTION_COMMANDS = {
	camera_list: "camera.list",
	notifications_list: "notifications.list",
	device_status: "device.status",
	device_info: "device.info",
	device_permissions: "device.permissions",
	device_health: "device.health"
};
async function executeNodeCommandAction(params) {
	switch (params.action) {
		case "camera_list":
		case "notifications_list":
		case "device_status":
		case "device_info":
		case "device_permissions":
		case "device_health": {
			const node = readStringParam$1(params.input, "node", { required: true });
			const payloadRaw = await invokeNodeCommandPayload({
				gatewayOpts: params.gatewayOpts,
				node,
				command: NODE_READ_ACTION_COMMANDS[params.action]
			});
			return jsonResult(payloadRaw && typeof payloadRaw === "object" && payloadRaw !== null ? payloadRaw : {});
		}
		case "notifications_action": {
			const node = readStringParam$1(params.input, "node", { required: true });
			const notificationKey = readStringParam$1(params.input, "notificationKey", { required: true });
			const notificationAction = normalizeLowercaseStringOrEmpty(params.input.notificationAction);
			if (notificationAction !== "open" && notificationAction !== "dismiss" && notificationAction !== "reply") throw new Error("notificationAction must be open|dismiss|reply");
			const notificationReplyText = typeof params.input.notificationReplyText === "string" ? params.input.notificationReplyText.trim() : void 0;
			if (notificationAction === "reply" && !notificationReplyText) throw new Error("notificationReplyText required when notificationAction=reply");
			const payloadRaw = await invokeNodeCommandPayload({
				gatewayOpts: params.gatewayOpts,
				node,
				command: "notifications.actions",
				commandParams: {
					key: notificationKey,
					action: notificationAction,
					replyText: notificationReplyText
				}
			});
			return jsonResult(payloadRaw && typeof payloadRaw === "object" && payloadRaw !== null ? payloadRaw : {});
		}
		case "location_get": {
			const node = readStringParam$1(params.input, "node", { required: true });
			const maxAgeMs = typeof params.input.maxAgeMs === "number" && Number.isFinite(params.input.maxAgeMs) ? params.input.maxAgeMs : void 0;
			const desiredAccuracy = params.input.desiredAccuracy === "coarse" || params.input.desiredAccuracy === "balanced" || params.input.desiredAccuracy === "precise" ? params.input.desiredAccuracy : void 0;
			const locationTimeoutMs = typeof params.input.locationTimeoutMs === "number" && Number.isFinite(params.input.locationTimeoutMs) ? params.input.locationTimeoutMs : void 0;
			return jsonResult(await invokeNodeCommandPayload({
				gatewayOpts: params.gatewayOpts,
				node,
				command: "location.get",
				commandParams: {
					maxAgeMs,
					desiredAccuracy,
					timeoutMs: locationTimeoutMs
				}
			}));
		}
		case "invoke": {
			const node = readStringParam$1(params.input, "node", { required: true });
			const nodeId = await resolveNodeId(params.gatewayOpts, node);
			const invokeCommand = readStringParam$1(params.input, "invokeCommand", { required: true });
			const invokeCommandNormalized = normalizeLowercaseStringOrEmpty(invokeCommand);
			if (BLOCKED_INVOKE_COMMANDS.has(invokeCommandNormalized)) throw new Error(`invokeCommand "${invokeCommand}" is reserved for shell execution; use exec with host=node instead`);
			const dedicatedAction = params.mediaInvokeActions[invokeCommandNormalized];
			if (dedicatedAction && POLICY_REDIRECT_INVOKE_COMMANDS.has(invokeCommandNormalized)) throw new Error(`invokeCommand "${invokeCommand}" enforces a path-allowlist policy and cannot be invoked via the generic nodes.invoke surface; use the dedicated file-transfer tool "${dedicatedAction}"`);
			if (dedicatedAction && !params.allowMediaInvokeCommands) throw new Error(`invokeCommand "${invokeCommand}" returns media payloads and is blocked to prevent base64 context bloat; use action="${dedicatedAction}"`);
			const invokeParamsJson = typeof params.input.invokeParamsJson === "string" ? params.input.invokeParamsJson.trim() : "";
			let invokeParams = {};
			if (invokeParamsJson) try {
				invokeParams = JSON.parse(invokeParamsJson);
			} catch (err) {
				const message = formatErrorMessage(err);
				throw new Error(`invokeParamsJson must be valid JSON: ${message}`, { cause: err });
			}
			const invokeTimeoutMs = parseTimeoutMs(params.input.invokeTimeoutMs);
			return jsonResult(await callGatewayTool("node.invoke", params.gatewayOpts, {
				nodeId,
				command: invokeCommand,
				params: invokeParams,
				timeoutMs: invokeTimeoutMs,
				idempotencyKey: crypto.randomUUID()
			}) ?? {});
		}
	}
	throw new Error("Unsupported node command action");
}
async function invokeNodeCommandPayload(params) {
	const nodeId = await resolveNodeId(params.gatewayOpts, params.node);
	return (await callGatewayTool("node.invoke", params.gatewayOpts, {
		nodeId,
		command: params.command,
		params: params.commandParams ?? {},
		idempotencyKey: crypto.randomUUID()
	}))?.payload ?? {};
}
//#endregion
//#region src/agents/tools/nodes-tool.ts
const NODES_TOOL_ACTIONS = [
	"status",
	"describe",
	"pending",
	"approve",
	"reject",
	"notify",
	"camera_snap",
	"camera_list",
	"camera_clip",
	"photos_latest",
	"screen_record",
	"location_get",
	"notifications_list",
	"notifications_action",
	"device_status",
	"device_info",
	"device_permissions",
	"device_health",
	"invoke"
];
const NOTIFY_PRIORITIES = [
	"passive",
	"active",
	"timeSensitive"
];
const NOTIFY_DELIVERIES = [
	"system",
	"overlay",
	"auto"
];
const NOTIFICATIONS_ACTIONS = [
	"open",
	"dismiss",
	"reply"
];
const CAMERA_FACING = [
	"front",
	"back",
	"both"
];
const LOCATION_ACCURACY = [
	"coarse",
	"balanced",
	"precise"
];
function resolveApproveScopes(commands) {
	return resolveNodePairApprovalScopes(commands);
}
async function resolveNodePairApproveScopes(gatewayOpts, requestId) {
	const pairing = await callGatewayTool("node.pair.list", gatewayOpts, {}, { scopes: ["operator.pairing"] });
	const match = (Array.isArray(pairing?.pending) ? pairing.pending : []).find((entry) => entry?.requestId === requestId);
	if (Array.isArray(match?.requiredApproveScopes)) {
		const scopes = match.requiredApproveScopes.filter((scope) => scope === "operator.pairing" || scope === "operator.write" || scope === "operator.admin");
		if (scopes.length > 0) return scopes;
	}
	return resolveApproveScopes(match?.commands);
}
const NodesToolSchema = Type.Object({
	action: stringEnum(NODES_TOOL_ACTIONS),
	gatewayUrl: Type.Optional(Type.String()),
	gatewayToken: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Number()),
	node: Type.Optional(Type.String()),
	requestId: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	body: Type.Optional(Type.String()),
	sound: Type.Optional(Type.String()),
	priority: optionalStringEnum(NOTIFY_PRIORITIES),
	delivery: optionalStringEnum(NOTIFY_DELIVERIES),
	facing: optionalStringEnum(CAMERA_FACING, { description: "camera_snap: front/back/both; camera_clip: front/back only." }),
	maxWidth: Type.Optional(Type.Number()),
	quality: Type.Optional(Type.Number()),
	delayMs: Type.Optional(Type.Number()),
	deviceId: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number()),
	duration: Type.Optional(Type.String()),
	durationMs: Type.Optional(Type.Number({ maximum: 3e5 })),
	includeAudio: Type.Optional(Type.Boolean()),
	fps: Type.Optional(Type.Number()),
	screenIndex: Type.Optional(Type.Number()),
	outPath: Type.Optional(Type.String()),
	maxAgeMs: Type.Optional(Type.Number()),
	locationTimeoutMs: Type.Optional(Type.Number()),
	desiredAccuracy: optionalStringEnum(LOCATION_ACCURACY),
	notificationAction: optionalStringEnum(NOTIFICATIONS_ACTIONS),
	notificationKey: Type.Optional(Type.String()),
	notificationReplyText: Type.Optional(Type.String()),
	invokeCommand: Type.Optional(Type.String()),
	invokeParamsJson: Type.Optional(Type.String()),
	invokeTimeoutMs: Type.Optional(Type.Number())
});
function createNodesTool(options) {
	const agentId = resolveSessionAgentId({
		sessionKey: options?.agentSessionKey,
		config: options?.config
	});
	const imageSanitization = resolveImageSanitizationLimits(options?.config);
	return {
		label: "Nodes",
		name: "nodes",
		description: "Discover/control paired nodes: status, describe, pairing, notify, camera/photos/screen/location/notifications/invoke. Use file_fetch for files.",
		parameters: NodesToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const action = readStringParam$1(params, "action", { required: true });
			const gatewayOpts = readGatewayCallOptions(params);
			try {
				switch (action) {
					case "status": return jsonResult(await callGatewayTool("node.list", gatewayOpts, {}));
					case "describe": return jsonResult(await callGatewayTool("node.describe", gatewayOpts, { nodeId: await resolveNodeId(gatewayOpts, readStringParam$1(params, "node", { required: true })) }));
					case "pending": return jsonResult(await callGatewayTool("node.pair.list", gatewayOpts, {}));
					case "approve": {
						const requestId = readStringParam$1(params, "requestId", { required: true });
						const scopes = await resolveNodePairApproveScopes(gatewayOpts, requestId);
						return jsonResult(await callGatewayTool("node.pair.approve", gatewayOpts, { requestId }, { scopes }));
					}
					case "reject": return jsonResult(await callGatewayTool("node.pair.reject", gatewayOpts, { requestId: readStringParam$1(params, "requestId", { required: true }) }));
					case "notify": {
						const node = readStringParam$1(params, "node", { required: true });
						const title = typeof params.title === "string" ? params.title : "";
						const body = typeof params.body === "string" ? params.body : "";
						if (!title.trim() && !body.trim()) throw new Error("title or body required");
						await callGatewayTool("node.invoke", gatewayOpts, {
							nodeId: await resolveNodeId(gatewayOpts, node),
							command: "system.notify",
							params: {
								title: title.trim() || void 0,
								body: body.trim() || void 0,
								sound: typeof params.sound === "string" ? params.sound : void 0,
								priority: typeof params.priority === "string" ? params.priority : void 0,
								delivery: typeof params.delivery === "string" ? params.delivery : void 0
							},
							idempotencyKey: crypto.randomUUID()
						});
						return jsonResult({ ok: true });
					}
					case "camera_snap": return await executeNodeMediaAction({
						action,
						params,
						gatewayOpts,
						modelHasVision: options?.modelHasVision,
						imageSanitization
					});
					case "photos_latest": return await executeNodeMediaAction({
						action,
						params,
						gatewayOpts,
						modelHasVision: options?.modelHasVision,
						imageSanitization
					});
					case "camera_list":
					case "notifications_list":
					case "device_status":
					case "device_info":
					case "device_permissions":
					case "device_health": return await executeNodeCommandAction({
						action,
						input: params,
						gatewayOpts,
						allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
						mediaInvokeActions: MEDIA_INVOKE_ACTIONS
					});
					case "notifications_action": return await executeNodeCommandAction({
						action,
						input: params,
						gatewayOpts,
						allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
						mediaInvokeActions: MEDIA_INVOKE_ACTIONS
					});
					case "camera_clip": return await executeNodeMediaAction({
						action,
						params,
						gatewayOpts,
						modelHasVision: options?.modelHasVision,
						imageSanitization
					});
					case "screen_record": return await executeNodeMediaAction({
						action,
						params,
						gatewayOpts,
						modelHasVision: options?.modelHasVision,
						imageSanitization
					});
					case "location_get": return await executeNodeCommandAction({
						action,
						input: params,
						gatewayOpts,
						allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
						mediaInvokeActions: MEDIA_INVOKE_ACTIONS
					});
					case "invoke": return await executeNodeCommandAction({
						action,
						input: params,
						gatewayOpts,
						allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
						mediaInvokeActions: MEDIA_INVOKE_ACTIONS
					});
					default: throw new Error(`Unknown action: ${action}`);
				}
			} catch (err) {
				const nodeLabel = typeof params.node === "string" && params.node.trim() ? params.node.trim() : "auto";
				const gatewayLabel = gatewayOpts.gatewayUrl && gatewayOpts.gatewayUrl.trim() ? gatewayOpts.gatewayUrl.trim() : "default";
				const agentLabel = agentId ?? "unknown";
				let message = formatErrorMessage(err);
				const pairing = action === "invoke" ? readConnectPairingRequiredMessage(message) : null;
				if (pairing) {
					const requestId = pairing.requestId ?? null;
					message = `pairing required before node invoke. ${requestId ? `Approve pairing request ${requestId} and retry.` : "Approve the pending pairing request and retry."}`;
				}
				throw new Error(`agent=${agentLabel} node=${nodeLabel} gateway=${gatewayLabel} action=${action}: ${message}`, { cause: err });
			}
		}
	};
}
//#endregion
//#region src/agents/tools/pdf-native-providers.ts
/**
* Direct SDK/HTTP calls for providers that support native PDF document input.
* This bypasses pi-ai's content type system which does not have a "document" type.
*/
const NATIVE_PDF_PROVIDER_FETCH_TIMEOUT_MS = 12e4;
async function anthropicAnalyzePdf(params) {
	const apiKey = normalizeSecretInput(params.apiKey);
	if (!apiKey) throw new Error("Anthropic PDF: apiKey required");
	const content = [];
	for (const pdf of params.pdfs) content.push({
		type: "document",
		source: {
			type: "base64",
			media_type: "application/pdf",
			data: pdf.base64
		}
	});
	content.push({
		type: "text",
		text: params.prompt
	});
	const baseUrl = (params.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
	const res = await fetch(`${baseUrl}/v1/messages`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "pdfs-2024-09-25"
		},
		body: JSON.stringify({
			model: params.modelId,
			max_tokens: params.maxTokens ?? 4096,
			messages: [{
				role: "user",
				content
			}]
		}),
		signal: AbortSignal.timeout(NATIVE_PDF_PROVIDER_FETCH_TIMEOUT_MS)
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Anthropic PDF request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 400)}` : ""}`);
	}
	const json = await res.json().catch(() => null);
	if (!isRecord$2(json)) throw new Error("Anthropic PDF response was not JSON.");
	const responseContent = json.content;
	if (!Array.isArray(responseContent)) throw new Error("Anthropic PDF response missing content array.");
	const text = responseContent.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
	if (!text.trim()) throw new Error("Anthropic PDF returned no text.");
	return text.trim();
}
async function geminiAnalyzePdf(params) {
	const apiKey = normalizeSecretInput(params.apiKey);
	if (!apiKey) throw new Error("Gemini PDF: apiKey required");
	const parts = [];
	for (const pdf of params.pdfs) parts.push({ inline_data: {
		mime_type: "application/pdf",
		data: pdf.base64
	} });
	parts.push({ text: params.prompt });
	const url = `${((normalizeProviderTransportWithPlugin({
		provider: "google",
		context: {
			provider: "google",
			api: "google-generative-ai",
			baseUrl: params.baseUrl
		}
	}) ?? { baseUrl: params.baseUrl }).baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/v1beta$/i, "")}/v1beta/models/${encodeURIComponent(params.modelId)}:generateContent`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-goog-api-key": apiKey
		},
		body: JSON.stringify({ contents: [{
			role: "user",
			parts
		}] }),
		signal: AbortSignal.timeout(NATIVE_PDF_PROVIDER_FETCH_TIMEOUT_MS)
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Gemini PDF request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 400)}` : ""}`);
	}
	const json = await res.json().catch(() => null);
	if (!isRecord$2(json)) throw new Error("Gemini PDF response was not JSON.");
	const candidates = json.candidates;
	if (!Array.isArray(candidates) || candidates.length === 0) throw new Error("Gemini PDF returned no candidates.");
	const text = (candidates[0].content?.parts?.filter((p) => typeof p.text === "string") ?? []).map((p) => p.text).join("");
	if (!text.trim()) throw new Error("Gemini PDF returned no text.");
	return text.trim();
}
//#endregion
//#region src/agents/tools/pdf-tool.helpers.ts
function resolvePdfInputs(record) {
	const pdfCandidates = [];
	if (typeof record.pdf === "string") pdfCandidates.push(record.pdf);
	if (Array.isArray(record.pdfs)) pdfCandidates.push(...record.pdfs.filter((v) => typeof v === "string"));
	const seenPdfs = /* @__PURE__ */ new Set();
	const pdfInputs = [];
	for (const candidate of pdfCandidates) {
		const trimmed = candidate.trim();
		if (!trimmed || seenPdfs.has(trimmed)) continue;
		seenPdfs.add(trimmed);
		pdfInputs.push(trimmed);
	}
	if (pdfInputs.length === 0) throw new Error("pdf required: provide a path or URL to a PDF document");
	return pdfInputs;
}
/**
* Check whether a provider supports native PDF document input.
*/
function providerSupportsNativePdf(provider) {
	return providerSupportsNativePdfDocument({ providerId: provider });
}
/**
* Parse a page range string (e.g. "1-5", "3", "1-3,7-9") into an array of 1-based page numbers.
*/
function parsePageRange(range, maxPages) {
	const pages = /* @__PURE__ */ new Set();
	const parts = range.split(",").map((p) => p.trim());
	for (const part of parts) {
		if (!part) continue;
		const dashMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
		if (dashMatch) {
			const start = Number(dashMatch[1]);
			const end = Number(dashMatch[2]);
			if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) throw new Error(`Invalid page range: "${part}"`);
			for (let i = start; i <= Math.min(end, maxPages); i++) pages.add(i);
		} else {
			const num = Number(part);
			if (!Number.isFinite(num) || num < 1) throw new Error(`Invalid page number: "${part}"`);
			if (num <= maxPages) pages.add(num);
		}
	}
	return Array.from(pages).toSorted((a, b) => a - b);
}
function coercePdfAssistantText(params) {
	const label = `${params.provider}/${params.model}`;
	const errorMessage = params.message.errorMessage?.trim();
	const fail = (message) => {
		throw new Error(message ? `PDF model failed (${label}): ${message}` : `PDF model failed (${label})`);
	};
	if (params.message.stopReason === "error" || params.message.stopReason === "aborted") fail(errorMessage);
	if (errorMessage) fail(errorMessage);
	const trimmed = extractAssistantText(params.message).trim();
	if (trimmed) return trimmed;
	throw new Error(`PDF model returned no text (${label}).`);
}
function coercePdfModelConfig(cfg) {
	const primary = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.pdfModel);
	const fallbacks = resolveAgentModelFallbackValues(cfg?.agents?.defaults?.pdfModel);
	const modelConfig = {};
	if (primary?.trim()) modelConfig.primary = primary.trim();
	if (fallbacks.length > 0) modelConfig.fallbacks = fallbacks;
	return modelConfig;
}
function resolvePdfToolMaxTokens(modelMaxTokens, requestedMaxTokens = 4096) {
	if (typeof modelMaxTokens !== "number" || !Number.isFinite(modelMaxTokens) || modelMaxTokens <= 0) return requestedMaxTokens;
	return Math.min(requestedMaxTokens, modelMaxTokens);
}
//#endregion
//#region src/agents/tools/pdf-tool.model-config.ts
function resolveImageCandidateRefs(params) {
	return resolveAutoMediaKeyProviders({
		capability: "image",
		cfg: params.cfg,
		workspaceDir: params.workspaceDir
	}).filter((providerId) => !params.filter || params.filter(providerId)).filter((providerId) => hasProviderAuthForTool({
		provider: providerId,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore
	})).map((providerId) => {
		const modelId = resolveProviderVisionModelFromConfig({
			cfg: params.cfg,
			provider: providerId
		})?.split("/")[1] ?? resolveDefaultMediaModel({
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			providerId,
			capability: "image",
			includeConfiguredImageModels: !isMinimaxVlmProvider(providerId)
		});
		return modelId ? `${providerId}/${modelId}` : null;
	}).filter((value) => Boolean(value));
}
function resolvePdfModelConfigForTool(params) {
	const explicitPdf = coercePdfModelConfig(params.cfg);
	if (explicitPdf.primary?.trim() || (explicitPdf.fallbacks?.length ?? 0) > 0) return resolveConfiguredImageModelRefs({
		cfg: params.cfg,
		imageModelConfig: explicitPdf
	});
	const explicitImage = coerceImageModelConfig(params.cfg);
	if (explicitImage.primary?.trim() || (explicitImage.fallbacks?.length ?? 0) > 0) return resolveConfiguredImageModelRefs({
		cfg: params.cfg,
		imageModelConfig: explicitImage
	});
	const primary = resolveDefaultModelRef(params.cfg);
	const googleOk = hasProviderAuthForTool({
		provider: "google",
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore
	});
	const fallbacks = [];
	const addFallback = (ref) => {
		const trimmed = ref.trim();
		if (trimmed && !fallbacks.includes(trimmed)) fallbacks.push(trimmed);
	};
	let preferred = null;
	const providerOk = hasProviderAuthForTool({
		provider: primary.provider,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore
	});
	const providerVision = resolveProviderVisionModelFromConfig({
		cfg: params.cfg,
		provider: primary.provider
	});
	const providerDefault = providerVision?.split("/")[1] ?? resolveDefaultMediaModel({
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		providerId: primary.provider,
		capability: "image",
		includeConfiguredImageModels: !isMinimaxVlmProvider(primary.provider)
	});
	const primarySupportsNativePdf = providerSupportsNativePdfDocument({
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		providerId: primary.provider
	});
	const nativePdfCandidates = resolveImageCandidateRefs({
		cfg: params.cfg,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		authStore: params.authStore,
		filter: (providerId) => providerSupportsNativePdfDocument({
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			providerId
		})
	});
	const genericImageCandidates = resolveImageCandidateRefs({
		cfg: params.cfg,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		authStore: params.authStore
	});
	if (params.cfg?.models?.providers && typeof params.cfg.models.providers === "object") for (const [providerKey, providerCfg] of Object.entries(params.cfg.models.providers)) {
		const providerId = providerKey.trim();
		if (!providerId || isMinimaxVlmProvider(providerId) || !hasProviderAuthForTool({
			provider: providerId,
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			agentDir: params.agentDir,
			authStore: params.authStore
		})) continue;
		const modelId = (providerCfg?.models ?? []).find((model) => Boolean(model?.id?.trim()) && Array.isArray(model?.input) && model.input.includes("image"))?.id?.trim();
		if (!modelId) continue;
		const ref = `${providerId}/${modelId}`;
		if (!genericImageCandidates.includes(ref)) genericImageCandidates.push(ref);
	}
	if (primary.provider === "google" && googleOk && providerVision && primarySupportsNativePdf) preferred = providerVision;
	else if (providerOk && primarySupportsNativePdf && (providerVision || providerDefault)) preferred = providerVision ?? `${primary.provider}/${providerDefault}`;
	else preferred = nativePdfCandidates[0] ?? genericImageCandidates[0] ?? null;
	if (preferred?.trim()) {
		for (const candidate of [...nativePdfCandidates, ...genericImageCandidates]) if (candidate !== preferred) addFallback(candidate);
		const pruned = fallbacks.filter((ref) => ref !== preferred);
		return {
			primary: preferred,
			...pruned.length > 0 ? { fallbacks: pruned } : {}
		};
	}
	return null;
}
//#endregion
//#region src/agents/tools/pdf-tool.ts
const DEFAULT_PROMPT = "Analyze this PDF document.";
const DEFAULT_MAX_PDFS = 10;
const DEFAULT_MAX_BYTES_MB = 10;
const DEFAULT_MAX_PAGES = 20;
const PDF_REMOTE_READ_IDLE_TIMEOUT_MS = 12e4;
const PDF_MIN_TEXT_CHARS = 200;
const PDF_MAX_PIXELS = 4e6;
const PdfToolSchema = Type.Object({
	prompt: Type.Optional(Type.String()),
	pdf: Type.Optional(Type.String({ description: "One PDF path/URL." })),
	pdfs: Type.Optional(Type.Array(Type.String(), { description: "PDF paths/URLs; max 10." })),
	pages: Type.Optional(Type.String({ description: "Pages, e.g. \"1-5\", \"1,3,5-7\"; default all." })),
	model: Type.Optional(Type.String()),
	maxBytesMb: Type.Optional(Type.Number())
});
function hasExplicitPdfToolModelConfig(config) {
	return hasToolModelConfig$1(coercePdfModelConfig(config)) || hasToolModelConfig$1(coerceImageModelConfig(config));
}
const CODEX_PDF_INSTRUCTIONS = "Analyze the provided PDF content and answer the user's request accurately.";
function buildPdfExtractionContext(prompt, extractions, model) {
	const content = [];
	for (let i = 0; i < extractions.length; i++) {
		const extraction = extractions[i];
		if (extraction.text.trim()) {
			const label = extractions.length > 1 ? `[PDF ${i + 1} text]\n` : "[PDF text]\n";
			content.push({
				type: "text",
				text: label + extraction.text
			});
		}
		for (const img of extraction.images) content.push({
			type: "image",
			data: img.data,
			mimeType: img.mimeType
		});
	}
	content.push({
		type: "text",
		text: prompt
	});
	const systemPrompt = model?.api === "openai-codex-responses" ? CODEX_PDF_INSTRUCTIONS : void 0;
	return {
		...systemPrompt ? { systemPrompt } : {},
		messages: [{
			role: "user",
			content,
			timestamp: Date.now()
		}]
	};
}
async function runPdfPrompt(params) {
	const effectiveCfg = applyImageModelConfigDefaults(params.cfg, params.pdfModelConfig);
	const modelsOptions = params.workspaceDir ? { workspaceDir: params.workspaceDir } : void 0;
	await ensureOpenClawModelsJson(effectiveCfg, params.agentDir, modelsOptions);
	const authStorage = discoverAuthStorage(params.agentDir);
	const modelRegistry = discoverModels(authStorage, params.agentDir);
	let extractionCache = null;
	const getExtractions = async () => {
		if (!extractionCache) extractionCache = await params.getExtractions();
		return extractionCache;
	};
	const result = await runWithImageModelFallback({
		cfg: effectiveCfg,
		modelOverride: params.modelOverride,
		run: async (provider, modelId) => {
			const model = resolveModelFromRegistry({
				modelRegistry,
				provider,
				modelId
			});
			const apiKey = await resolveModelRuntimeApiKey({
				model,
				cfg: effectiveCfg,
				agentDir: params.agentDir,
				authStorage
			});
			if (providerSupportsNativePdf(provider)) {
				if (params.pageNumbers && params.pageNumbers.length > 0) throw new Error(`pages is not supported with native PDF providers (${provider}/${modelId}). Remove pages, or use a non-native model for page filtering.`);
				const pdfs = params.pdfBuffers.map((p) => ({
					base64: p.base64,
					filename: p.filename
				}));
				if (provider === "anthropic") return {
					text: await anthropicAnalyzePdf({
						apiKey,
						modelId,
						prompt: params.prompt,
						pdfs,
						maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
						baseUrl: model.baseUrl
					}),
					provider,
					model: modelId,
					native: true
				};
				if (provider === "google") return {
					text: await geminiAnalyzePdf({
						apiKey,
						modelId,
						prompt: params.prompt,
						pdfs,
						baseUrl: model.baseUrl
					}),
					provider,
					model: modelId,
					native: true
				};
			}
			const extractions = await getExtractions();
			if (extractions.some((e) => e.images.length > 0) && !model.input?.includes("image")) {
				if (!extractions.some((e) => e.text.trim().length > 0)) throw new Error(`Model ${provider}/${modelId} does not support images and PDF has no extractable text.`);
				const textOnlyExtractions = extractions.map((e) => ({
					text: e.text,
					images: []
				}));
				return {
					text: coercePdfAssistantText({
						message: await complete(model, buildPdfExtractionContext(params.prompt, textOnlyExtractions, model), {
							apiKey,
							maxTokens: resolvePdfToolMaxTokens(model.maxTokens)
						}),
						provider,
						model: modelId
					}),
					provider,
					model: modelId,
					native: false
				};
			}
			return {
				text: coercePdfAssistantText({
					message: await complete(model, buildPdfExtractionContext(params.prompt, extractions, model), {
						apiKey,
						maxTokens: resolvePdfToolMaxTokens(model.maxTokens)
					}),
					provider,
					model: modelId
				}),
				provider,
				model: modelId,
				native: false
			};
		}
	});
	return {
		text: result.result.text,
		provider: result.result.provider,
		model: result.result.model,
		native: result.result.native,
		attempts: result.attempts.map((a) => ({
			provider: a.provider,
			model: a.model,
			error: a.error
		}))
	};
}
function createPdfTool(options) {
	const agentDir = options?.agentDir?.trim();
	const hasExplicitModelConfig = hasExplicitPdfToolModelConfig(options?.config);
	if (!agentDir) {
		if (hasExplicitModelConfig) throw new Error("createPdfTool requires agentDir when enabled");
		return null;
	}
	const shouldDeferAutoModelResolution = options?.deferAutoModelResolution === true && !hasExplicitModelConfig;
	const registrationPdfModelConfig = shouldDeferAutoModelResolution ? null : resolvePdfModelConfigForTool({
		cfg: options?.config,
		agentDir,
		workspaceDir: options?.workspaceDir,
		authStore: options?.authProfileStore
	});
	if (!registrationPdfModelConfig && !shouldDeferAutoModelResolution) return null;
	const maxBytesMbDefault = (options?.config?.agents?.defaults)?.pdfMaxBytesMb;
	const maxPagesDefault = (options?.config?.agents?.defaults)?.pdfMaxPages;
	const configuredMaxBytesMb = typeof maxBytesMbDefault === "number" && Number.isFinite(maxBytesMbDefault) ? maxBytesMbDefault : DEFAULT_MAX_BYTES_MB;
	const configuredMaxPages = typeof maxPagesDefault === "number" && Number.isFinite(maxPagesDefault) ? Math.floor(maxPagesDefault) : DEFAULT_MAX_PAGES;
	const description = "Analyze PDFs with model. Anthropic/Google native PDF when supported; else text/image extraction. Use pdf for one, pdfs for max 10; prompt says what to inspect.";
	const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(options?.config);
	return {
		label: "PDF",
		name: "pdf",
		description,
		parameters: PdfToolSchema,
		execute: async (_toolCallId, args) => {
			const record = args && typeof args === "object" ? args : {};
			const pdfInputs = resolvePdfInputs(record);
			if (pdfInputs.length > DEFAULT_MAX_PDFS) return {
				content: [{
					type: "text",
					text: `Too many PDFs: ${pdfInputs.length} provided, maximum is ${DEFAULT_MAX_PDFS}. Please reduce the number.`
				}],
				details: {
					error: "too_many_pdfs",
					count: pdfInputs.length,
					max: DEFAULT_MAX_PDFS
				}
			};
			const { prompt: promptRaw, modelOverride } = resolvePromptAndModelOverride(record, DEFAULT_PROMPT);
			const maxBytesMbRaw = typeof record.maxBytesMb === "number" ? record.maxBytesMb : void 0;
			const maxBytes = Math.floor((typeof maxBytesMbRaw === "number" && Number.isFinite(maxBytesMbRaw) && maxBytesMbRaw > 0 ? maxBytesMbRaw : configuredMaxBytesMb) * 1024 * 1024);
			const pagesRaw = normalizeOptionalString(record.pages);
			const pdfModelConfig = registrationPdfModelConfig ?? resolvePdfModelConfigForTool({
				cfg: options?.config,
				agentDir,
				workspaceDir: options?.workspaceDir,
				authStore: options?.authProfileStore
			});
			if (!pdfModelConfig) throw new ToolInputError("No PDF model configured.");
			const sandboxConfig = options?.sandbox && options.sandbox.root.trim() ? {
				root: options.sandbox.root.trim(),
				bridge: options.sandbox.bridge,
				workspaceOnly: options.fsPolicy?.workspaceOnly === true
			} : null;
			const loadedPdfs = [];
			for (const pdfRaw of pdfInputs) {
				const trimmed = normalizeMediaReferenceSource(pdfRaw);
				const refInfo = classifyMediaReferenceSource(trimmed);
				const { isHttpUrl } = refInfo;
				if (refInfo.hasUnsupportedScheme) return {
					content: [{
						type: "text",
						text: `Unsupported PDF reference: ${pdfRaw}. Use a file path, file:// URL, or http(s) URL.`
					}],
					details: {
						error: "unsupported_pdf_reference",
						pdf: pdfRaw
					}
				};
				if (sandboxConfig && isHttpUrl) throw new Error("Sandboxed PDF tool does not allow remote URLs.");
				const resolvedPdf = (() => {
					if (sandboxConfig) return trimmed;
					if (trimmed.startsWith("~")) return resolveUserPath(trimmed);
					return trimmed;
				})();
				const resolvedPathInfo = sandboxConfig ? await resolveSandboxedBridgeMediaPath({
					sandbox: sandboxConfig,
					mediaPath: resolvedPdf,
					inboundFallbackDir: "media/inbound"
				}) : { resolved: resolvedPdf.startsWith("file://") ? resolvedPdf.slice(7) : resolvedPdf };
				const localRoots = resolveMediaToolLocalRoots(options?.workspaceDir, { workspaceOnly: options?.fsPolicy?.workspaceOnly === true }, [resolvedPathInfo.resolved]);
				const media = sandboxConfig ? await loadWebMediaRaw(resolvedPathInfo.resolved, {
					maxBytes,
					sandboxValidated: true,
					readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig })
				}) : await loadWebMediaRaw(resolvedPathInfo.resolved, {
					maxBytes,
					localRoots,
					...isHttpUrl ? { readIdleTimeoutMs: PDF_REMOTE_READ_IDLE_TIMEOUT_MS } : {},
					ssrfPolicy: remoteMediaSsrfPolicy
				});
				if (media.kind !== "document") {
					const ct = normalizeLowercaseStringOrEmpty(media.contentType);
					if (!ct.includes("pdf") && !ct.includes("application/pdf")) throw new Error(`Expected PDF but got ${media.contentType ?? media.kind}: ${pdfRaw}`);
				}
				const base64 = media.buffer.toString("base64");
				const filename = media.fileName ?? (isHttpUrl ? new URL(trimmed).pathname.split("/").pop() ?? "document.pdf" : "document.pdf");
				loadedPdfs.push({
					base64,
					buffer: media.buffer,
					filename,
					resolvedPath: resolvedPathInfo.resolved,
					...resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}
				});
			}
			const pageNumbers = pagesRaw ? parsePageRange(pagesRaw, configuredMaxPages) : void 0;
			const getExtractions = async () => {
				const extractedAll = [];
				for (const pdf of loadedPdfs) {
					const extracted = await extractPdfContent({
						buffer: pdf.buffer,
						maxPages: configuredMaxPages,
						maxPixels: PDF_MAX_PIXELS,
						minTextChars: PDF_MIN_TEXT_CHARS,
						pageNumbers,
						config: options?.config
					});
					extractedAll.push(extracted);
				}
				return extractedAll;
			};
			const result = await runPdfPrompt({
				cfg: options?.config,
				agentDir,
				...options?.workspaceDir ? { workspaceDir: options.workspaceDir } : {},
				pdfModelConfig,
				modelOverride,
				prompt: promptRaw,
				pdfBuffers: loadedPdfs.map((p) => ({
					base64: p.base64,
					filename: p.filename
				})),
				pageNumbers,
				getExtractions
			});
			const pdfDetails = loadedPdfs.length === 1 ? {
				pdf: loadedPdfs[0].resolvedPath,
				...loadedPdfs[0].rewrittenFrom ? { rewrittenFrom: loadedPdfs[0].rewrittenFrom } : {}
			} : { pdfs: loadedPdfs.map((p) => Object.assign({ pdf: p.resolvedPath }, p.rewrittenFrom ? { rewrittenFrom: p.rewrittenFrom } : {})) };
			return buildTextToolResult(result, {
				native: result.native,
				...pdfDetails
			});
		}
	};
}
//#endregion
//#region src/gateway/session-patch-hooks.ts
function triggerSessionPatchHook(params) {
	if (!hasInternalHookListeners("session", "patch")) return;
	const hookContext = structuredClone({
		sessionEntry: params.sessionEntry,
		patch: params.patch,
		cfg: params.cfg
	});
	triggerInternalHook({
		type: "session",
		action: "patch",
		sessionKey: params.sessionKey,
		context: hookContext,
		timestamp: /* @__PURE__ */ new Date(),
		messages: []
	});
}
//#endregion
//#region src/agents/tools/session-status-tool.ts
const SessionStatusToolSchema = Type.Object({
	sessionKey: Type.Optional(Type.String()),
	model: Type.Optional(Type.String())
});
const commandsStatusRuntimeLoader = createLazyImportLoader(() => import("./session-status.runtime.js"));
function loadCommandsStatusRuntime() {
	return commandsStatusRuntimeLoader.load();
}
function resolveSessionEntry(params) {
	const keyRaw = params.keyRaw.trim();
	if (!keyRaw) return null;
	const includeAliasFallback = params.includeAliasFallback ?? true;
	const internal = resolveInternalSessionKey({
		key: keyRaw,
		alias: params.alias,
		mainKey: params.mainKey,
		requesterInternalKey: params.requesterInternalKey
	});
	const candidates = [keyRaw];
	if (!keyRaw.startsWith("agent:")) candidates.push(`agent:${DEFAULT_AGENT_ID}:${keyRaw}`);
	if (includeAliasFallback && internal !== keyRaw) candidates.push(internal);
	if (includeAliasFallback && !keyRaw.startsWith("agent:")) {
		const agentInternal = `agent:${DEFAULT_AGENT_ID}:${internal}`;
		if (agentInternal !== `agent:main:${keyRaw}`) candidates.push(agentInternal);
	}
	if (includeAliasFallback && (keyRaw === "main" || keyRaw === "current")) {
		const defaultMainKey = buildAgentMainSessionKey({
			agentId: DEFAULT_AGENT_ID,
			mainKey: params.mainKey
		});
		if (!candidates.includes(defaultMainKey)) candidates.push(defaultMainKey);
	}
	for (const key of candidates) {
		const entry = params.store[key];
		if (entry) return {
			key,
			entry
		};
	}
	return null;
}
function resolveStoreScopedRequesterKey(params) {
	const parsed = parseAgentSessionKey(params.requesterKey);
	if (!parsed || parsed.agentId !== params.agentId) return params.requesterKey;
	return parsed.rest === params.mainKey ? params.mainKey : params.requesterKey;
}
function synthesizeImplicitCurrentSessionEntry() {
	return {
		sessionId: "",
		updatedAt: Date.now()
	};
}
function resolveImplicitCurrentSessionFallback(params) {
	const fallbackKey = params.fallbackKey.trim();
	if (!params.allowFallback || !fallbackKey) return null;
	return {
		key: fallbackKey,
		entry: synthesizeImplicitCurrentSessionEntry()
	};
}
function listImplicitDefaultDirectFallbackKeys(params) {
	const parsed = parseAgentSessionKey(params.keyRaw.trim());
	if (!parsed) return [];
	const parts = parsed.rest.split(":");
	if (parts.length < 4 || parts[1] !== "default" || parts[2] !== "direct") return [];
	const [channel, , , ...peerParts] = parts;
	if (!channel || peerParts.length === 0) return [];
	const candidates = [
		`agent:${parsed.agentId}:${channel}:direct:${peerParts.join(":")}`,
		buildAgentMainSessionKey({
			agentId: parsed.agentId,
			mainKey: params.mainKey
		}),
		params.mainKey
	];
	return [...new Set(candidates)];
}
function resolveActiveStatusModelIdentity(params) {
	const activeModelId = params.activeModelId?.trim();
	if (!activeModelId || params.modelRaw !== void 0) return;
	if (!params.isSemanticCurrentRequest && !params.isImplicitCurrentRequest) return;
	const resolvedKey = params.resolvedKey.trim();
	if (!new Set(Array.from(params.liveSessionKeys, (value) => value?.trim()).filter((value) => Boolean(value))).has(resolvedKey)) return;
	const activeModelProvider = params.activeModelProvider?.trim();
	return activeModelProvider ? {
		provider: activeModelProvider,
		model: activeModelId
	} : { model: activeModelId };
}
function withActiveStatusModelIdentity(entry, identity) {
	const next = {
		...entry,
		model: identity.model,
		...identity.provider ? { modelProvider: identity.provider } : {}
	};
	delete next.providerOverride;
	delete next.modelOverride;
	delete next.modelOverrideSource;
	return next;
}
function formatSessionTaskLine(params) {
	const snapshot = buildTaskStatusSnapshotForRelatedSessionKeyForOwner({
		relatedSessionKey: params.relatedSessionKey,
		callerOwnerKey: params.callerOwnerKey
	});
	const task = snapshot.focus;
	if (!task) return;
	const headline = snapshot.activeCount > 0 ? `${snapshot.activeCount} active` : snapshot.recentFailureCount > 0 ? `${snapshot.recentFailureCount} recent failure${snapshot.recentFailureCount === 1 ? "" : "s"}` : `latest ${task.status.replaceAll("_", " ")}`;
	const title = formatTaskStatusTitle(task);
	const detail = formatTaskStatusDetail(task);
	const parts = [
		headline,
		task.runtime,
		title,
		detail
	].filter(Boolean);
	return parts.length ? `📌 Tasks: ${parts.join(" · ")}` : void 0;
}
async function resolveModelOverride(params) {
	const raw = normalizeToolModelOverride(params.raw);
	if (!raw) return { kind: "reset" };
	const configDefault = resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId: params.agentId
	});
	const currentProvider = params.sessionEntry?.providerOverride?.trim() || configDefault.provider;
	const currentModel = params.sessionEntry?.modelOverride?.trim() || configDefault.model;
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: currentProvider
	});
	const catalog = await loadModelCatalog({ config: params.cfg });
	const policy = createModelVisibilityPolicy({
		cfg: params.cfg,
		catalog,
		defaultProvider: currentProvider,
		defaultModel: currentModel,
		agentId: params.agentId
	});
	const resolved = resolveModelRefFromString({
		raw,
		defaultProvider: currentProvider,
		aliasIndex
	});
	if (!resolved) throw new Error(`Unrecognized model "${raw}".`);
	const key = modelKey$1(resolved.ref.provider, resolved.ref.model);
	if (!policy.allowsKey(key)) throw new Error(`Model "${key}" is not allowed.`);
	const isDefault = resolved.ref.provider === configDefault.provider && resolved.ref.model === configDefault.model;
	return {
		kind: "set",
		provider: resolved.ref.provider,
		model: resolved.ref.model,
		isDefault
	};
}
function createSessionStatusTool(opts) {
	return {
		label: "Session Status",
		name: "session_status",
		displaySummary: SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
		description: describeSessionStatusTool(),
		parameters: SessionStatusToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const cfg = opts?.config ?? getRuntimeConfig();
			const { mainKey, alias, effectiveRequesterKey } = resolveSandboxedSessionToolContext({
				cfg,
				agentSessionKey: opts?.agentSessionKey,
				sandboxed: opts?.sandboxed
			});
			const a2aPolicy = createAgentToAgentPolicy(cfg);
			const requesterAgentId = resolveAgentIdFromSessionKey(opts?.agentSessionKey ?? effectiveRequesterKey);
			const visibilityRequesterKey = (opts?.agentSessionKey ?? effectiveRequesterKey).trim();
			const usesLegacyMainAlias = alias === mainKey;
			const isLegacyMainVisibilityKey = (sessionKey) => {
				const trimmed = sessionKey.trim();
				return usesLegacyMainAlias && (trimmed === "main" || trimmed === mainKey);
			};
			const resolveVisibilityMainSessionKey = (sessionAgentId) => {
				const requesterParsed = parseAgentSessionKey(visibilityRequesterKey);
				if (resolveAgentIdFromSessionKey(visibilityRequesterKey) === sessionAgentId && (requesterParsed?.rest === mainKey || isLegacyMainVisibilityKey(visibilityRequesterKey))) return visibilityRequesterKey;
				return buildAgentMainSessionKey({
					agentId: sessionAgentId,
					mainKey
				});
			};
			const normalizeVisibilityTargetSessionKey = (sessionKey, sessionAgentId) => {
				const trimmed = sessionKey.trim();
				if (!trimmed) return trimmed;
				if (trimmed.startsWith("agent:")) {
					if (parseAgentSessionKey(trimmed)?.rest === mainKey) return resolveVisibilityMainSessionKey(sessionAgentId);
					return trimmed;
				}
				if (isLegacyMainVisibilityKey(trimmed)) return resolveVisibilityMainSessionKey(sessionAgentId);
				return trimmed;
			};
			const visibilityGuard = await createSessionVisibilityGuard({
				action: "status",
				requesterSessionKey: visibilityRequesterKey,
				visibility: resolveEffectiveSessionToolsVisibility({
					cfg,
					sandboxed: opts?.sandboxed === true
				}),
				a2aPolicy
			});
			const requestedKeyParam = readStringParam$1(params, "sessionKey");
			const isImplicitRunSessionStatus = requestedKeyParam === void 0 && Boolean(opts?.runSessionKey?.trim());
			let requestedKeyRaw = requestedKeyParam ?? opts?.agentSessionKey;
			if (isImplicitRunSessionStatus) requestedKeyRaw = opts?.runSessionKey;
			const isSemanticCurrentRequest = requestedKeyRaw === "current" || isImplicitRunSessionStatus || Boolean(resolveCurrentSessionClientAlias({
				key: requestedKeyRaw ?? "",
				requesterInternalKey: effectiveRequesterKey
			}));
			if (requestedKeyRaw === "current" && (opts?.runSessionKey || opts?.sandboxed === true)) requestedKeyRaw = opts.runSessionKey ?? effectiveRequesterKey;
			const currentSessionAlias = resolveCurrentSessionClientAlias({
				key: requestedKeyRaw ?? "",
				requesterInternalKey: effectiveRequesterKey
			});
			if (currentSessionAlias) requestedKeyRaw = opts?.runSessionKey ?? currentSessionAlias;
			const requestedKeyInput = requestedKeyRaw?.trim() ?? "";
			let resolvedViaSessionId = false;
			let resolvedViaImplicitCurrentFallback = false;
			if (!requestedKeyRaw?.trim()) throw new Error("sessionKey required");
			const ensureAgentAccess = (targetAgentId) => {
				if (targetAgentId === requesterAgentId) return;
				if (!a2aPolicy.enabled) throw new Error("Agent-to-agent status is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.");
				if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) throw new Error("Agent-to-agent session status denied by tools.agentToAgent.allow.");
			};
			if (requestedKeyRaw.startsWith("agent:") && !isSemanticCurrentRequest) {
				const requestedAgentId = resolveAgentIdFromSessionKey(requestedKeyRaw);
				ensureAgentAccess(requestedAgentId);
				const access = visibilityGuard.check(normalizeVisibilityTargetSessionKey(requestedKeyRaw, requestedAgentId));
				if (!access.allowed) throw new Error(access.error);
			}
			let agentId = requestedKeyRaw.startsWith("agent:") ? resolveAgentIdFromSessionKey(requestedKeyRaw) : requesterAgentId;
			let storePath = resolveStorePath(cfg.session?.store, { agentId });
			let store = loadSessionStore(storePath);
			let storeScopedRequesterKey = resolveStoreScopedRequesterKey({
				requesterKey: effectiveRequesterKey,
				agentId,
				mainKey
			});
			let resolved = resolveSessionEntry({
				store,
				keyRaw: requestedKeyRaw,
				alias,
				mainKey,
				requesterInternalKey: storeScopedRequesterKey,
				includeAliasFallback: requestedKeyRaw !== "current"
			});
			if (!resolved && (requestedKeyRaw === "current" || shouldResolveSessionIdInput(requestedKeyRaw))) {
				const resolvedSession = await resolveSessionReference({
					sessionKey: requestedKeyRaw,
					alias,
					mainKey,
					requesterInternalKey: effectiveRequesterKey,
					restrictToSpawned: opts?.sandboxed === true
				});
				if (resolvedSession.ok && resolvedSession.resolvedViaSessionId) {
					const visibleSession = await resolveVisibleSessionReference({
						resolvedSession,
						requesterSessionKey: effectiveRequesterKey,
						restrictToSpawned: opts?.sandboxed === true,
						visibilitySessionKey: requestedKeyRaw
					});
					if (!visibleSession.ok) throw new Error("Session status visibility is restricted to the current session tree.");
					ensureAgentAccess(resolveAgentIdFromSessionKey(visibleSession.key));
					resolvedViaSessionId = true;
					requestedKeyRaw = visibleSession.key;
					agentId = resolveAgentIdFromSessionKey(visibleSession.key);
					storePath = resolveStorePath(cfg.session?.store, { agentId });
					store = loadSessionStore(storePath);
					storeScopedRequesterKey = resolveStoreScopedRequesterKey({
						requesterKey: effectiveRequesterKey,
						agentId,
						mainKey
					});
					resolved = resolveSessionEntry({
						store,
						keyRaw: requestedKeyRaw,
						alias,
						mainKey,
						requesterInternalKey: storeScopedRequesterKey
					});
				} else if (!resolvedSession.ok && opts?.sandboxed === true) throw new Error("Session status visibility is restricted to the current session tree.");
			}
			if (!resolved && requestedKeyRaw === "current") resolved = resolveSessionEntry({
				store,
				keyRaw: requestedKeyRaw,
				alias,
				mainKey,
				requesterInternalKey: storeScopedRequesterKey,
				includeAliasFallback: true
			});
			if (!resolved && requestedKeyParam === void 0) for (const fallbackKey of listImplicitDefaultDirectFallbackKeys({
				keyRaw: requestedKeyRaw,
				mainKey
			})) {
				resolved = resolveSessionEntry({
					store,
					keyRaw: fallbackKey,
					alias,
					mainKey,
					requesterInternalKey: storeScopedRequesterKey,
					includeAliasFallback: true
				});
				if (resolved) {
					resolvedViaImplicitCurrentFallback = true;
					break;
				}
			}
			if (!resolved) {
				const fallback = resolveImplicitCurrentSessionFallback({
					allowFallback: isSemanticCurrentRequest || requestedKeyParam === void 0,
					fallbackKey: (isSemanticCurrentRequest || isImplicitRunSessionStatus) && opts?.runSessionKey ? opts.runSessionKey : storeScopedRequesterKey
				});
				if (fallback) {
					resolved = fallback;
					resolvedViaImplicitCurrentFallback = true;
				}
			}
			if (!resolved) {
				const kind = shouldResolveSessionIdInput(requestedKeyRaw) ? "sessionId" : "sessionKey";
				throw new Error(`Unknown ${kind}: ${requestedKeyRaw}`);
			}
			const visibilityTargetKey = isSemanticCurrentRequest || resolvedViaImplicitCurrentFallback || !resolvedViaSessionId && (requestedKeyInput === "current" || resolved.key === requestedKeyInput) ? visibilityRequesterKey : normalizeVisibilityTargetSessionKey(resolved.key, agentId);
			const access = visibilityGuard.check(visibilityTargetKey);
			if (!access.allowed) throw new Error(access.error);
			const configured = resolveDefaultModelForAgent({
				cfg,
				agentId
			});
			const modelRaw = readStringParam$1(params, "model");
			let changedModel = false;
			if (typeof modelRaw === "string") {
				const selection = await resolveModelOverride({
					cfg,
					raw: modelRaw,
					sessionEntry: resolved.entry,
					agentId
				});
				const nextEntry = { ...resolved.entry };
				if (applyModelOverrideToSessionEntry({
					entry: nextEntry,
					selection: selection.kind === "reset" ? {
						provider: configured.provider,
						model: configured.model,
						isDefault: true
					} : {
						provider: selection.provider,
						model: selection.model,
						isDefault: selection.isDefault
					},
					markLiveSwitchPending: true
				}).updated) {
					const persistedEntry = nextEntry.sessionId.trim() ? nextEntry : (() => {
						const persistedEntryPatch = { ...nextEntry };
						delete persistedEntryPatch.sessionId;
						const existingEntry = store[resolved.key];
						return mergeSessionEntry(existingEntry?.sessionId?.trim() ? existingEntry : void 0, persistedEntryPatch);
					})();
					store[resolved.key] = persistedEntry;
					await updateSessionStore(storePath, (nextStore) => {
						nextStore[resolved.key] = persistedEntry;
					});
					resolved.entry = persistedEntry;
					triggerSessionPatchHook({
						cfg,
						sessionEntry: persistedEntry,
						sessionKey: resolved.key,
						patch: {
							key: resolved.key,
							model: selection.kind === "reset" ? null : `${selection.provider}/${selection.model}`
						}
					});
					changedModel = true;
				}
			}
			const activeModelId = opts?.activeModelId?.trim();
			const activeModelProvider = opts?.activeModelProvider?.trim();
			const activeModelIdentity = resolveActiveStatusModelIdentity({
				activeModelId,
				activeModelProvider,
				isImplicitCurrentRequest: requestedKeyParam === void 0,
				isSemanticCurrentRequest,
				liveSessionKeys: [
					opts?.runSessionKey,
					storeScopedRequesterKey,
					effectiveRequesterKey,
					visibilityRequesterKey
				],
				modelRaw,
				resolvedKey: resolved.key
			});
			const runtimeModelIdentity = activeModelIdentity ? activeModelIdentity : resolveSessionModelIdentityRef(cfg, resolved.entry, agentId, `${configured.provider}/${configured.model}`);
			const hasExplicitModelOverride = Boolean(!activeModelIdentity && (resolved.entry.providerOverride?.trim() || resolved.entry.modelOverride?.trim()));
			const runtimeProviderForCard = runtimeModelIdentity.provider?.trim();
			const runtimeModelForCard = runtimeModelIdentity.model.trim();
			const defaultProviderForCard = hasExplicitModelOverride ? configured.provider : runtimeProviderForCard ?? "";
			const defaultModelForCard = hasExplicitModelOverride ? configured.model : runtimeModelForCard || configured.model;
			const statusSessionEntry = activeModelIdentity ? withActiveStatusModelIdentity(resolved.entry, activeModelIdentity) : !hasExplicitModelOverride && !runtimeProviderForCard && runtimeModelForCard ? {
				...resolved.entry,
				providerOverride: ""
			} : resolved.entry;
			const providerForCard = statusSessionEntry.providerOverride?.trim() ?? defaultProviderForCard;
			const primaryModelLabel = providerForCard && defaultModelForCard ? `${providerForCard}/${defaultModelForCard}` : defaultModelForCard;
			const isGroup = statusSessionEntry.chatType === "group" || statusSessionEntry.chatType === "channel" || resolved.key.includes(":group:") || resolved.key.includes(":channel:");
			const taskLine = formatSessionTaskLine({
				relatedSessionKey: resolved.key,
				callerOwnerKey: visibilityRequesterKey
			});
			const { buildStatusText } = await loadCommandsStatusRuntime();
			const statusText = await buildStatusText({
				cfg,
				sessionEntry: statusSessionEntry,
				sessionKey: resolved.key,
				parentSessionKey: statusSessionEntry.parentSessionKey,
				sessionScope: cfg.session?.scope,
				storePath,
				statusChannel: statusSessionEntry.channel ?? statusSessionEntry.lastChannel ?? statusSessionEntry.origin?.provider ?? "unknown",
				workspaceDir: statusSessionEntry.spawnedWorkspaceDir,
				provider: providerForCard,
				model: defaultModelForCard,
				resolvedThinkLevel: statusSessionEntry.thinkingLevel,
				resolvedFastMode: statusSessionEntry.fastMode,
				resolvedVerboseLevel: statusSessionEntry.verboseLevel ?? "off",
				resolvedReasoningLevel: statusSessionEntry.reasoningLevel ?? "off",
				resolvedElevatedLevel: statusSessionEntry.elevatedLevel,
				resolveDefaultThinkingLevel: () => resolveThinkingDefaultWithRuntimeCatalog({
					cfg,
					provider: providerForCard,
					model: defaultModelForCard,
					loadModelCatalog: () => loadModelCatalog({ config: cfg })
				}),
				isGroup,
				defaultGroupActivation: () => "mention",
				taskLineOverride: taskLine,
				skipDefaultTaskLookup: true,
				primaryModelLabelOverride: primaryModelLabel,
				...providerForCard ? {} : { modelAuthOverride: void 0 },
				includeTranscriptUsage: true
			});
			const fullStatusText = taskLine && !statusText.includes(taskLine) ? `${statusText}\n${taskLine}` : statusText;
			const resultOverrideProvider = statusSessionEntry.providerOverride?.trim();
			const resultOverrideModel = statusSessionEntry.modelOverride?.trim();
			const modelOverrideForResult = modelRaw === void 0 ? void 0 : resultOverrideModel ? resultOverrideProvider ? `${resultOverrideProvider}/${resultOverrideModel}` : resultOverrideModel : null;
			return {
				content: [{
					type: "text",
					text: fullStatusText
				}],
				details: {
					ok: true,
					sessionKey: resolved.key,
					changedModel,
					...modelRaw !== void 0 ? {
						model: resultOverrideModel ?? defaultModelForCard,
						...resultOverrideProvider ?? providerForCard ? { modelProvider: resultOverrideProvider ?? providerForCard } : {},
						modelOverride: modelOverrideForResult
					} : {},
					statusText: fullStatusText
				}
			};
		}
	};
}
//#endregion
//#region src/agents/tools/sessions-history-tool.ts
const SessionsHistoryToolSchema = Type.Object({
	sessionKey: Type.String(),
	limit: Type.Optional(Type.Number({ minimum: 1 })),
	includeTools: Type.Optional(Type.Boolean())
});
const SESSIONS_HISTORY_MAX_BYTES = 80 * 1024;
const SESSIONS_HISTORY_TEXT_MAX_CHARS = 4e3;
function truncateHistoryText(text) {
	const sanitized = redactToolPayloadText(text);
	const redacted = sanitized !== text;
	if (sanitized.length <= SESSIONS_HISTORY_TEXT_MAX_CHARS) return {
		text: sanitized,
		truncated: false,
		redacted
	};
	return {
		text: `${truncateUtf16Safe(sanitized, SESSIONS_HISTORY_TEXT_MAX_CHARS)}\n…(truncated)…`,
		truncated: true,
		redacted
	};
}
function sanitizeHistoryContentBlock(block) {
	if (!block || typeof block !== "object") return {
		block,
		truncated: false,
		redacted: false
	};
	const entry = { ...block };
	let truncated = false;
	let redacted = false;
	const type = typeof entry.type === "string" ? entry.type : "";
	if (typeof entry.text === "string") {
		const res = truncateHistoryText(entry.text);
		entry.text = res.text;
		truncated ||= res.truncated;
		redacted ||= res.redacted;
	}
	if (type === "thinking") {
		if (typeof entry.thinking === "string") {
			const res = truncateHistoryText(entry.thinking);
			entry.thinking = res.text;
			truncated ||= res.truncated;
			redacted ||= res.redacted;
		}
		if ("thinkingSignature" in entry) {
			delete entry.thinkingSignature;
			truncated = true;
		}
		if ("openclawReasoningReplay" in entry) {
			delete entry.openclawReasoningReplay;
			truncated = true;
		}
	}
	if (typeof entry.partialJson === "string") {
		const res = truncateHistoryText(entry.partialJson);
		entry.partialJson = res.text;
		truncated ||= res.truncated;
		redacted ||= res.redacted;
	}
	if (type === "image") {
		const data = readStringValue(entry.data);
		const bytes = data ? data.length : void 0;
		if ("data" in entry) {
			delete entry.data;
			truncated = true;
		}
		entry.omitted = true;
		if (bytes !== void 0) entry.bytes = bytes;
	}
	return {
		block: entry,
		truncated,
		redacted
	};
}
function sanitizeHistoryMessage(message) {
	if (!message || typeof message !== "object") return {
		message,
		truncated: false,
		redacted: false
	};
	const entry = { ...message };
	let truncated = false;
	let redacted = false;
	if ("details" in entry) {
		delete entry.details;
		truncated = true;
	}
	if ("usage" in entry) {
		delete entry.usage;
		truncated = true;
	}
	if ("cost" in entry) {
		delete entry.cost;
		truncated = true;
	}
	if (typeof entry.content === "string") {
		const res = truncateHistoryText(entry.content);
		entry.content = res.text;
		truncated ||= res.truncated;
		redacted ||= res.redacted;
	} else if (Array.isArray(entry.content)) {
		const updated = entry.content.map((block) => sanitizeHistoryContentBlock(block));
		entry.content = updated.map((item) => item.block);
		truncated ||= updated.some((item) => item.truncated);
		redacted ||= updated.some((item) => item.redacted);
	}
	if (typeof entry.text === "string") {
		const res = truncateHistoryText(entry.text);
		entry.text = res.text;
		truncated ||= res.truncated;
		redacted ||= res.redacted;
	}
	return {
		message: entry,
		truncated,
		redacted
	};
}
function enforceSessionsHistoryHardCap(params) {
	if (params.bytes <= params.maxBytes) return {
		items: params.items,
		bytes: params.bytes,
		hardCapped: false
	};
	const last = params.items.at(-1);
	const lastOnly = last ? [last] : [];
	const lastBytes = jsonUtf8Bytes(lastOnly);
	if (lastBytes <= params.maxBytes) return {
		items: lastOnly,
		bytes: lastBytes,
		hardCapped: true
	};
	const placeholder = [{
		role: "assistant",
		content: "[sessions_history omitted: message too large]"
	}];
	return {
		items: placeholder,
		bytes: jsonUtf8Bytes(placeholder),
		hardCapped: true
	};
}
function createSessionsHistoryTool(opts) {
	return {
		label: "Session History",
		name: "sessions_history",
		displaySummary: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
		description: describeSessionsHistoryTool(),
		parameters: SessionsHistoryToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const gatewayCall = opts?.callGateway ?? callGateway;
			const sessionKeyParam = readStringParam$1(params, "sessionKey", { required: true });
			const cfg = opts?.config ?? getRuntimeConfig();
			const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } = resolveSandboxedSessionToolContext({
				cfg,
				agentSessionKey: opts?.agentSessionKey,
				sandboxed: opts?.sandboxed
			});
			const resolvedSession = await resolveSessionReference({
				sessionKey: sessionKeyParam,
				alias,
				mainKey,
				requesterInternalKey: effectiveRequesterKey,
				restrictToSpawned
			});
			if (!resolvedSession.ok) return jsonResult({
				status: resolvedSession.status,
				error: resolvedSession.error
			});
			const visibleSession = await resolveVisibleSessionReference({
				resolvedSession,
				requesterSessionKey: effectiveRequesterKey,
				restrictToSpawned,
				visibilitySessionKey: sessionKeyParam
			});
			if (!visibleSession.ok) return jsonResult({
				status: visibleSession.status,
				error: visibleSession.error
			});
			const resolvedKey = visibleSession.key;
			const displayKey = visibleSession.displayKey;
			const a2aPolicy = createAgentToAgentPolicy(cfg);
			const access = (await createSessionVisibilityGuard({
				action: "history",
				requesterSessionKey: effectiveRequesterKey,
				visibility: resolveEffectiveSessionToolsVisibility({
					cfg,
					sandboxed: opts?.sandboxed === true
				}),
				a2aPolicy
			})).check(resolvedKey);
			if (!access.allowed) return jsonResult({
				status: access.status,
				error: access.error
			});
			const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : void 0;
			const includeTools = Boolean(params.includeTools);
			const result = await gatewayCall({
				method: "chat.history",
				params: {
					sessionKey: resolvedKey,
					limit
				}
			});
			const rawMessages = Array.isArray(result?.messages) ? result.messages : [];
			const selectedMessages = includeTools ? rawMessages : stripToolMessages(rawMessages);
			const sanitizedMessages = selectedMessages.map((message) => sanitizeHistoryMessage(message));
			const contentTruncated = sanitizedMessages.some((entry) => entry.truncated);
			const contentRedacted = sanitizedMessages.some((entry) => entry.redacted);
			const cappedMessages = capArrayByJsonBytes(sanitizedMessages.map((entry) => entry.message), SESSIONS_HISTORY_MAX_BYTES);
			const droppedMessages = cappedMessages.items.length < selectedMessages.length;
			const hardened = enforceSessionsHistoryHardCap({
				items: cappedMessages.items,
				bytes: cappedMessages.bytes,
				maxBytes: SESSIONS_HISTORY_MAX_BYTES
			});
			return jsonResult({
				sessionKey: displayKey,
				messages: hardened.items,
				truncated: droppedMessages || contentTruncated || hardened.hardCapped,
				droppedMessages: droppedMessages || hardened.hardCapped,
				contentTruncated,
				contentRedacted,
				bytes: hardened.bytes
			});
		}
	};
}
//#endregion
//#region src/agents/tools/sessions-list-tool.ts
const SessionsListToolSchema = Type.Object({
	kinds: Type.Optional(Type.Array(Type.String())),
	limit: Type.Optional(Type.Number({ minimum: 1 })),
	activeMinutes: Type.Optional(Type.Number({ minimum: 1 })),
	messageLimit: Type.Optional(Type.Number({ minimum: 0 })),
	label: Type.Optional(Type.String({ minLength: 1 })),
	agentId: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 64
	})),
	search: Type.Optional(Type.String({ minLength: 1 })),
	includeDerivedTitles: Type.Optional(Type.Boolean()),
	includeLastMessage: Type.Optional(Type.Boolean())
});
const SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS = 100;
function readSessionRunStatus(value) {
	return value === "running" || value === "done" || value === "failed" || value === "killed" || value === "timeout" ? value : void 0;
}
function createSessionsListTool(opts) {
	return {
		label: "Sessions",
		name: "sessions_list",
		displaySummary: SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
		description: describeSessionsListTool(),
		parameters: SessionsListToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const cfg = opts?.config ?? getRuntimeConfig();
			const { mainKey, alias, requesterInternalKey, restrictToSpawned } = resolveSandboxedSessionToolContext({
				cfg,
				agentSessionKey: opts?.agentSessionKey,
				sandboxed: opts?.sandboxed
			});
			const effectiveRequesterKey = requesterInternalKey ?? alias;
			const visibility = resolveEffectiveSessionToolsVisibility({
				cfg,
				sandboxed: opts?.sandboxed === true
			});
			const allowedKindsList = (readStringArrayParam(params, "kinds")?.map((value) => normalizeOptionalLowercaseString(value)).filter((value) => Boolean(value)) ?? []).filter((value) => [
				"main",
				"group",
				"cron",
				"hook",
				"node",
				"other"
			].includes(value));
			const allowedKinds = allowedKindsList.length ? new Set(allowedKindsList) : void 0;
			const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : void 0;
			const activeMinutes = typeof params.activeMinutes === "number" && Number.isFinite(params.activeMinutes) ? Math.max(1, Math.floor(params.activeMinutes)) : void 0;
			const messageLimitRaw = typeof params.messageLimit === "number" && Number.isFinite(params.messageLimit) ? Math.max(0, Math.floor(params.messageLimit)) : 0;
			const messageLimit = Math.min(messageLimitRaw, 20);
			const label = readStringParam$1(params, "label");
			const agentId = readStringParam$1(params, "agentId");
			const search = readStringParam$1(params, "search");
			const includeDerivedTitles = params.includeDerivedTitles === true;
			const includeLastMessage = params.includeLastMessage === true;
			const gatewayCall = opts?.callGateway ?? callGateway;
			const a2aPolicy = createAgentToAgentPolicy(cfg);
			const hydrateTranscriptFieldsAfterFiltering = includeDerivedTitles || includeLastMessage;
			const list = await gatewayCall({
				method: "sessions.list",
				params: {
					limit,
					activeMinutes,
					label,
					agentId,
					search,
					includeDerivedTitles: false,
					includeLastMessage: false,
					includeGlobal: !restrictToSpawned,
					includeUnknown: !restrictToSpawned,
					spawnedBy: restrictToSpawned ? effectiveRequesterKey : void 0
				}
			});
			const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
			const storePath = typeof list?.path === "string" ? list.path : void 0;
			const visibilityGuard = createSessionVisibilityRowChecker({
				action: "list",
				requesterSessionKey: effectiveRequesterKey,
				visibility,
				a2aPolicy
			});
			const rows = [];
			const historyTargets = [];
			const titleTargets = [];
			for (const entry of sessions) {
				if (!entry || typeof entry !== "object") continue;
				const key = typeof entry.key === "string" ? entry.key : "";
				if (!key) continue;
				if (!visibilityGuard.check({
					key,
					agentId: typeof entry.agentId === "string" ? entry.agentId : void 0,
					ownerSessionKey: typeof entry.ownerSessionKey === "string" ? entry.ownerSessionKey : void 0,
					spawnedBy: typeof entry.spawnedBy === "string" ? entry.spawnedBy : void 0,
					parentSessionKey: typeof entry.parentSessionKey === "string" ? entry.parentSessionKey : void 0
				}).allowed) continue;
				if (key === "unknown") continue;
				if (key === "global" && alias !== "global") continue;
				const kind = classifySessionKind({
					key,
					gatewayKind: typeof entry.kind === "string" ? entry.kind : void 0,
					alias,
					mainKey
				});
				if (allowedKinds && !allowedKinds.has(kind)) continue;
				const displayKey = resolveDisplaySessionKey({
					key,
					alias,
					mainKey
				});
				const entryChannel = typeof entry.channel === "string" ? entry.channel : void 0;
				const entryOrigin = entry.origin && typeof entry.origin === "object" ? entry.origin : void 0;
				const originChannel = typeof entryOrigin?.provider === "string" ? entryOrigin.provider : void 0;
				const deliveryContext = deliveryContextFromSession(entry);
				const deliveryChannel = readStringValue(deliveryContext?.channel);
				const deliveryTo = readStringValue(deliveryContext?.to);
				const deliveryAccountId = readStringValue(deliveryContext?.accountId);
				const deliveryThreadId = typeof deliveryContext?.threadId === "string" || typeof deliveryContext?.threadId === "number" && Number.isFinite(deliveryContext.threadId) ? deliveryContext.threadId : void 0;
				const lastChannel = deliveryChannel ?? readStringValue(entry.lastChannel);
				const lastAccountId = deliveryAccountId ?? readStringValue(entry.lastAccountId);
				const derivedChannel = deriveChannel({
					key,
					kind,
					channel: entryChannel ?? originChannel,
					lastChannel
				});
				const sessionId = readStringValue(entry.sessionId);
				const sessionFileRaw = entry.sessionFile;
				const sessionFile = readStringValue(sessionFileRaw);
				const resolvedAgentId = resolveAgentIdFromSessionKey(key);
				let transcriptPath;
				if (sessionId) try {
					const trimmedStorePath = storePath?.trim();
					let effectiveStorePath;
					if (trimmedStorePath && trimmedStorePath !== "(multiple)") {
						if (trimmedStorePath.includes("{agentId}") || trimmedStorePath.startsWith("~")) effectiveStorePath = resolveStorePath(trimmedStorePath, { agentId: resolvedAgentId });
						else if (path.isAbsolute(trimmedStorePath)) effectiveStorePath = trimmedStorePath;
					}
					const filePathOpts = resolveSessionFilePathOptions({
						agentId: resolvedAgentId,
						storePath: effectiveStorePath
					});
					transcriptPath = resolveSessionFilePath(sessionId, sessionFile ? { sessionFile } : void 0, filePathOpts);
				} catch {
					transcriptPath = void 0;
				}
				const row = {
					key: displayKey,
					agentId: resolvedAgentId,
					kind,
					channel: derivedChannel,
					origin: originChannel || (typeof entryOrigin?.accountId === "string" ? entryOrigin.accountId : void 0) ? {
						provider: originChannel,
						accountId: readStringValue(entryOrigin?.accountId)
					} : void 0,
					spawnedBy: typeof entry.spawnedBy === "string" ? resolveDisplaySessionKey({
						key: entry.spawnedBy,
						alias,
						mainKey
					}) : void 0,
					label: readStringValue(entry.label),
					displayName: readStringValue(entry.displayName),
					derivedTitle: readStringValue(entry.derivedTitle),
					lastMessagePreview: readStringValue(entry.lastMessagePreview),
					parentSessionKey: typeof entry.parentSessionKey === "string" ? resolveDisplaySessionKey({
						key: entry.parentSessionKey,
						alias,
						mainKey
					}) : void 0,
					deliveryContext: deliveryChannel || deliveryTo || deliveryAccountId || deliveryThreadId ? {
						channel: deliveryChannel,
						to: deliveryTo,
						accountId: deliveryAccountId,
						threadId: deliveryThreadId
					} : void 0,
					updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : void 0,
					sessionId,
					model: readStringValue(entry.model),
					contextTokens: typeof entry.contextTokens === "number" ? entry.contextTokens : void 0,
					totalTokens: typeof entry.totalTokens === "number" ? entry.totalTokens : void 0,
					estimatedCostUsd: typeof entry.estimatedCostUsd === "number" ? entry.estimatedCostUsd : void 0,
					status: readSessionRunStatus(entry.status),
					startedAt: typeof entry.startedAt === "number" ? entry.startedAt : void 0,
					endedAt: typeof entry.endedAt === "number" ? entry.endedAt : void 0,
					runtimeMs: typeof entry.runtimeMs === "number" ? entry.runtimeMs : void 0,
					childSessions: Array.isArray(entry.childSessions) ? entry.childSessions.filter((value) => typeof value === "string").map((value) => resolveDisplaySessionKey({
						key: value,
						alias,
						mainKey
					})) : void 0,
					thinkingLevel: readStringValue(entry.thinkingLevel),
					fastMode: typeof entry.fastMode === "boolean" ? entry.fastMode : void 0,
					verboseLevel: readStringValue(entry.verboseLevel),
					reasoningLevel: readStringValue(entry.reasoningLevel),
					elevatedLevel: readStringValue(entry.elevatedLevel),
					responseUsage: readStringValue(entry.responseUsage),
					systemSent: typeof entry.systemSent === "boolean" ? entry.systemSent : void 0,
					abortedLastRun: typeof entry.abortedLastRun === "boolean" ? entry.abortedLastRun : void 0,
					sendPolicy: readStringValue(entry.sendPolicy),
					lastChannel,
					lastTo: deliveryTo ?? readStringValue(entry.lastTo),
					lastAccountId,
					transcriptPath
				};
				if (sessionId && hydrateTranscriptFieldsAfterFiltering && titleTargets.length < SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS) titleTargets.push({
					row,
					titleEntry: {
						sessionId,
						displayName: row.displayName,
						label: row.label,
						subject: readStringValue(entry.subject),
						updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0
					},
					sessionId,
					...sessionFile ? { sessionFile } : {},
					agentId: resolvedAgentId
				});
				if (messageLimit > 0) {
					const resolvedKey = resolveInternalSessionKey({
						key,
						alias,
						mainKey
					});
					historyTargets.push({
						row,
						resolvedKey
					});
				}
				rows.push(row);
			}
			if (titleTargets.length > 0) {
				const maxConcurrent = Math.min(4, titleTargets.length);
				let index = 0;
				const worker = async () => {
					while (true) {
						const next = index;
						index += 1;
						if (next >= titleTargets.length) return;
						const target = titleTargets[next];
						const fields = await readSessionTitleFieldsFromTranscriptAsync(target.sessionId, storePath, target.sessionFile, target.agentId);
						if (includeDerivedTitles && !target.row.derivedTitle) target.row.derivedTitle = deriveSessionTitle(target.titleEntry, fields.firstUserMessage);
						if (includeLastMessage && fields.lastMessagePreview) target.row.lastMessagePreview = fields.lastMessagePreview;
					}
				};
				await Promise.all(Array.from({ length: maxConcurrent }, () => worker()));
			}
			if (messageLimit > 0 && historyTargets.length > 0) {
				const maxConcurrent = Math.min(4, historyTargets.length);
				let index = 0;
				const worker = async () => {
					while (true) {
						const next = index;
						index += 1;
						if (next >= historyTargets.length) return;
						const target = historyTargets[next];
						const history = await gatewayCall({
							method: "chat.history",
							params: {
								sessionKey: target.resolvedKey,
								limit: messageLimit
							}
						});
						const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
						target.row.messages = filtered.length > messageLimit ? filtered.slice(-messageLimit) : filtered;
					}
				};
				await Promise.all(Array.from({ length: maxConcurrent }, () => worker()));
			}
			return jsonResult({
				count: rows.length,
				sessions: rows
			});
		}
	};
}
//#endregion
//#region src/agents/tools/sessions-send-helpers.ts
const DEFAULT_PING_PONG_TURNS = 5;
const MAX_PING_PONG_TURNS = 20;
function resolveAnnounceTargetFromKey(sessionKey) {
	const parsed = resolveSessionConversationRef(sessionKey);
	if (!parsed) return null;
	const normalizedChannel = normalizeChannelId$1(parsed.channel) ?? normalizeChannelId(parsed.channel);
	const channel = normalizedChannel ?? parsed.channel;
	const plugin = normalizedChannel ? getChannelPlugin(normalizedChannel) : null;
	const genericTarget = parsed.kind === "channel" ? `channel:${parsed.id}` : `group:${parsed.id}`;
	return {
		channel,
		to: plugin?.messaging?.resolveSessionTarget?.({
			kind: parsed.kind,
			id: parsed.id,
			threadId: parsed.threadId
		}) ?? plugin?.messaging?.normalizeTarget?.(genericTarget) ?? (normalizedChannel ? genericTarget : parsed.id),
		threadId: parsed.threadId
	};
}
function buildAgentSessionLines(params) {
	return [
		params.requesterSessionKey ? `Agent 1 (requester) session: ${params.requesterSessionKey}.` : void 0,
		params.requesterChannel ? `Agent 1 (requester) channel: ${params.requesterChannel}.` : void 0,
		`Agent 2 (target) session: ${params.targetSessionKey}.`,
		params.targetChannel ? `Agent 2 (target) channel: ${params.targetChannel}.` : void 0
	].filter((line) => Boolean(line));
}
function buildAgentToAgentMessageContext(params) {
	return ["Agent-to-agent message context:", ...buildAgentSessionLines(params)].filter(Boolean).join("\n");
}
function buildAgentToAgentReplyContext(params) {
	return [
		"Agent-to-agent reply step:",
		`Current agent: ${params.currentRole === "requester" ? "Agent 1 (requester)" : "Agent 2 (target)"}.`,
		`Turn ${params.turn} of ${params.maxTurns}.`,
		...buildAgentSessionLines(params),
		`If you want to stop the ping-pong, reply exactly "${REPLY_SKIP_TOKEN}".`
	].filter(Boolean).join("\n");
}
function buildAgentToAgentAnnounceContext(params) {
	return [
		"Agent-to-agent announce step:",
		...buildAgentSessionLines(params),
		`Original request: ${params.originalMessage}`,
		params.roundOneReply ? `Round 1 reply: ${params.roundOneReply}` : "Round 1 reply: (not available).",
		params.latestReply ? `Latest reply: ${params.latestReply}` : "Latest reply: (not available).",
		`If you want to remain silent, reply exactly "${ANNOUNCE_SKIP_TOKEN}".`,
		"Any other reply will be posted to the target channel.",
		"After this reply, the agent-to-agent conversation is over."
	].filter(Boolean).join("\n");
}
function resolvePingPongTurns(cfg) {
	const raw = cfg?.session?.agentToAgent?.maxPingPongTurns;
	const fallback = DEFAULT_PING_PONG_TURNS;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	return Math.max(0, Math.min(MAX_PING_PONG_TURNS, Math.floor(raw)));
}
//#endregion
//#region src/agents/tools/sessions-announce-target.ts
async function callGatewayLazy(opts) {
	const { callGateway } = await import("./call-C8FPOqHS.js");
	return callGateway(opts);
}
async function resolveAnnounceTarget(params) {
	const parsed = resolveAnnounceTargetFromKey(params.sessionKey);
	const parsedDisplay = resolveAnnounceTargetFromKey(params.displayKey);
	const fallback = parsed ?? parsedDisplay ?? null;
	const fallbackThreadId = fallback?.threadId ?? parseThreadSessionSuffix(params.sessionKey).threadId ?? parseThreadSessionSuffix(params.displayKey).threadId;
	if (fallback) {
		const normalized = normalizeChannelId$1(fallback.channel);
		if (!(normalized ? getChannelPlugin(normalized) : null)?.meta?.preferSessionLookupForAnnounceTarget) return fallback;
	}
	try {
		const list = await callGatewayLazy({
			method: "sessions.list",
			params: {
				includeGlobal: true,
				includeUnknown: true,
				limit: 200
			}
		});
		const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
		const context = deliveryContextFromSession(sessions.find((entry) => entry?.key === params.sessionKey) ?? sessions.find((entry) => entry?.key === params.displayKey));
		const threadId = normalizeOptionalStringifiedId(context?.threadId ?? fallbackThreadId);
		if (context?.channel && context.to) return {
			channel: context.channel,
			to: context.to,
			accountId: context.accountId,
			threadId
		};
	} catch {}
	return fallback;
}
//#endregion
//#region src/agents/tools/sessions-send-tool.a2a.ts
const log$1 = createSubsystemLogger("agents/sessions-send");
let sessionsSendA2ADeps = { callGateway: async (opts) => {
	const { callGateway } = await import("./call-C8FPOqHS.js");
	return callGateway(opts);
} };
async function runSessionsSendA2AFlow(params) {
	const runContextId = params.waitRunId ?? "unknown";
	try {
		let primaryReply = params.roundOneReply;
		let latestReply = params.roundOneReply;
		if (!primaryReply && params.waitRunId) {
			if ((await waitForAgentRun({
				runId: params.waitRunId,
				timeoutMs: Math.min(params.announceTimeoutMs, 6e4),
				callGateway: sessionsSendA2ADeps.callGateway
			})).status === "ok") {
				const latestSnapshot = await readLatestAssistantReplySnapshot({
					sessionKey: params.targetSessionKey,
					callGateway: sessionsSendA2ADeps.callGateway
				});
				const baselineFingerprint = params.baseline?.fingerprint;
				primaryReply = latestSnapshot.text && (!baselineFingerprint || latestSnapshot.fingerprint !== baselineFingerprint) ? latestSnapshot.text : void 0;
				latestReply = primaryReply;
			}
		}
		if (!latestReply) return;
		if (isNonDeliverableSessionsReply(latestReply)) return;
		const announceTarget = await resolveAnnounceTarget({
			sessionKey: params.targetSessionKey,
			displayKey: params.displayKey
		});
		const targetChannel = announceTarget?.channel ?? "unknown";
		if (params.maxPingPongTurns > 0 && params.requesterSessionKey && params.requesterSessionKey !== params.targetSessionKey) {
			let currentSessionKey = params.requesterSessionKey;
			let nextSessionKey = params.targetSessionKey;
			let incomingMessage = latestReply;
			for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
				const currentRole = currentSessionKey === params.requesterSessionKey ? "requester" : "target";
				const replyPrompt = buildAgentToAgentReplyContext({
					requesterSessionKey: params.requesterSessionKey,
					requesterChannel: params.requesterChannel,
					targetSessionKey: params.displayKey,
					targetChannel,
					currentRole,
					turn,
					maxTurns: params.maxPingPongTurns
				});
				const replyText = await runAgentStep({
					sessionKey: currentSessionKey,
					message: incomingMessage,
					extraSystemPrompt: replyPrompt,
					timeoutMs: params.announceTimeoutMs,
					lane: resolveNestedAgentLaneForSession(currentSessionKey),
					sourceSessionKey: nextSessionKey,
					sourceChannel: nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
					sourceTool: "sessions_send"
				});
				if (!replyText || isReplySkip(replyText) || isNonDeliverableSessionsReply(replyText)) break;
				latestReply = replyText;
				incomingMessage = replyText;
				const swap = currentSessionKey;
				currentSessionKey = nextSessionKey;
				nextSessionKey = swap;
			}
		}
		const announcePrompt = buildAgentToAgentAnnounceContext({
			requesterSessionKey: params.requesterSessionKey,
			requesterChannel: params.requesterChannel,
			targetSessionKey: params.displayKey,
			targetChannel,
			originalMessage: params.message,
			roundOneReply: primaryReply,
			latestReply
		});
		const announceReply = await runAgentStep({
			sessionKey: params.targetSessionKey,
			message: "Agent-to-agent announce step.",
			extraSystemPrompt: announcePrompt,
			timeoutMs: params.announceTimeoutMs,
			lane: resolveNestedAgentLaneForSession(params.targetSessionKey),
			transcriptMessage: "",
			sourceSessionKey: params.requesterSessionKey,
			sourceChannel: params.requesterChannel,
			sourceTool: "sessions_send"
		});
		if (announceTarget && announceReply && announceReply.trim() && !isAnnounceSkip(announceReply) && !isNonDeliverableSessionsReply(announceReply)) try {
			await sessionsSendA2ADeps.callGateway({
				method: "send",
				params: {
					to: announceTarget.to,
					message: announceReply.trim(),
					channel: announceTarget.channel,
					accountId: announceTarget.accountId,
					threadId: announceTarget.threadId,
					idempotencyKey: crypto.randomUUID()
				},
				timeoutMs: 1e4
			});
		} catch (err) {
			log$1.warn("sessions_send announce delivery failed", {
				runId: runContextId,
				channel: announceTarget.channel,
				to: announceTarget.to,
				error: formatErrorMessage(err)
			});
		}
	} catch (err) {
		log$1.warn("sessions_send announce flow failed", {
			runId: runContextId,
			error: formatErrorMessage(err)
		});
	}
}
//#endregion
//#region src/agents/tools/sessions-send-tool.ts
const SessionsSendToolSchema = Type.Object({
	sessionKey: Type.Optional(Type.String()),
	label: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 512
	})),
	agentId: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 64
	})),
	message: Type.String(),
	timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 }))
});
const SESSIONS_SEND_REPLY_HISTORY_LIMIT = 50;
function resolveConfiguredAgentMainSessionKey(params) {
	const agentId = normalizeAgentId(params.agentId);
	if (!listAgentIds(params.cfg).includes(agentId)) return;
	return toAgentStoreSessionKey({
		agentId,
		requestKey: "main",
		mainKey: params.mainKey
	});
}
function isConfiguredAgentMainSessionKey(params) {
	const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
	return params.sessionKey === resolveConfiguredAgentMainSessionKey({
		cfg: params.cfg,
		agentId,
		mainKey: params.mainKey
	});
}
async function ensureConfiguredAgentMainSession(params) {
	if (!isConfiguredAgentMainSessionKey({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		mainKey: params.mainKey
	})) return { ok: true };
	try {
		await params.callGateway({
			method: "sessions.resolve",
			params: { key: params.sessionKey },
			timeoutMs: 1e4
		});
		return { ok: true };
	} catch {
		try {
			await params.callGateway({
				method: "sessions.create",
				params: {
					key: params.sessionKey,
					agentId: resolveAgentIdFromSessionKey(params.sessionKey)
				},
				timeoutMs: 1e4
			});
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: formatErrorMessage(err)
			};
		}
	}
}
function isRequesterParentOfNativeSubagentSession(params) {
	if (!params.entry || params.entry.acp || !isSubagentSessionKey(params.targetSessionKey)) return false;
	const requester = normalizeOptionalString(params.requesterSessionKey);
	if (!requester) return false;
	const spawnedBy = normalizeOptionalString(params.entry.spawnedBy);
	const parentSessionKey = normalizeOptionalString(params.entry.parentSessionKey);
	return requester === spawnedBy || requester === parentSessionKey;
}
function isTerminalAgentWaitTimeout(result) {
	return result.endedAt !== void 0 || Boolean(result.stopReason || result.livenessState);
}
async function startAgentRun(params) {
	try {
		const response = await params.callGateway({
			method: "agent",
			params: params.sendParams,
			timeoutMs: 1e4
		});
		return {
			ok: true,
			runId: typeof response?.runId === "string" && response.runId ? response.runId : params.runId
		};
	} catch (err) {
		const messageText = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
		return {
			ok: false,
			result: jsonResult({
				runId: params.runId,
				status: "error",
				error: messageText,
				sessionKey: params.sessionKey
			})
		};
	}
}
function createSessionsSendTool(opts) {
	return {
		label: "Session Send",
		name: "sessions_send",
		displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
		description: describeSessionsSendTool(),
		parameters: SessionsSendToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const gatewayCall = opts?.callGateway ?? callGateway;
			const message = readStringParam$1(params, "message", { required: true });
			const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } = resolveSessionToolContext(opts);
			const a2aPolicy = createAgentToAgentPolicy(cfg);
			const sessionVisibility = resolveEffectiveSessionToolsVisibility({
				cfg,
				sandboxed: opts?.sandboxed === true
			});
			const sessionKeyParam = readStringParam$1(params, "sessionKey");
			const labelParam = normalizeOptionalString(readStringParam$1(params, "label"));
			const labelAgentIdParam = normalizeOptionalString(readStringParam$1(params, "agentId"));
			if (sessionKeyParam && labelParam) return jsonResult({
				runId: crypto.randomUUID(),
				status: "error",
				error: "Provide either sessionKey or label (not both)."
			});
			let sessionKey = sessionKeyParam;
			if (!sessionKey && !labelParam && labelAgentIdParam) {
				const agentMainKey = resolveConfiguredAgentMainSessionKey({
					cfg,
					agentId: labelAgentIdParam,
					mainKey
				});
				if (!agentMainKey) return jsonResult({
					runId: crypto.randomUUID(),
					status: "error",
					error: `agent not found: ${labelAgentIdParam}`
				});
				sessionKey = agentMainKey;
			}
			if (!sessionKey && labelParam) {
				const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
				const requestedAgentId = labelAgentIdParam ? normalizeAgentId(labelAgentIdParam) : void 0;
				if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) return jsonResult({
					runId: crypto.randomUUID(),
					status: "forbidden",
					error: "Sandboxed sessions_send label lookup is limited to this agent"
				});
				if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
					if (!a2aPolicy.enabled) return jsonResult({
						runId: crypto.randomUUID(),
						status: "forbidden",
						error: "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends."
					});
					if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) return jsonResult({
						runId: crypto.randomUUID(),
						status: "forbidden",
						error: "Agent-to-agent messaging denied by tools.agentToAgent.allow."
					});
				}
				const resolveParams = {
					label: labelParam,
					...requestedAgentId ? { agentId: requestedAgentId } : {},
					...restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}
				};
				let resolvedKey = "";
				try {
					resolvedKey = normalizeOptionalString((await gatewayCall({
						method: "sessions.resolve",
						params: resolveParams,
						timeoutMs: 1e4
					}))?.key) ?? "";
				} catch (err) {
					const msg = formatErrorMessage(err);
					if (restrictToSpawned) return jsonResult({
						runId: crypto.randomUUID(),
						status: "forbidden",
						error: "Session not visible from this sandboxed agent session."
					});
					return jsonResult({
						runId: crypto.randomUUID(),
						status: "error",
						error: msg || `No session found with label: ${labelParam}`
					});
				}
				if (!resolvedKey) {
					if (restrictToSpawned) return jsonResult({
						runId: crypto.randomUUID(),
						status: "forbidden",
						error: "Session not visible from this sandboxed agent session."
					});
					return jsonResult({
						runId: crypto.randomUUID(),
						status: "error",
						error: `No session found with label: ${labelParam}`
					});
				}
				sessionKey = resolvedKey;
			}
			if (!sessionKey) return jsonResult({
				runId: crypto.randomUUID(),
				status: "error",
				error: "Either sessionKey or label is required"
			});
			const resolvedSession = await resolveSessionReference({
				sessionKey,
				alias,
				mainKey,
				requesterInternalKey: effectiveRequesterKey,
				restrictToSpawned
			});
			if (!resolvedSession.ok) return jsonResult({
				runId: crypto.randomUUID(),
				status: resolvedSession.status,
				error: resolvedSession.error
			});
			const visibleSession = await resolveVisibleSessionReference({
				resolvedSession,
				requesterSessionKey: effectiveRequesterKey,
				restrictToSpawned,
				visibilitySessionKey: sessionKey
			});
			if (!visibleSession.ok) return jsonResult({
				runId: crypto.randomUUID(),
				status: visibleSession.status,
				error: visibleSession.error,
				sessionKey: visibleSession.displayKey
			});
			const resolvedKey = visibleSession.key;
			const displayKey = visibleSession.displayKey;
			const timeoutSeconds = typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds) ? Math.max(0, Math.floor(params.timeoutSeconds)) : 30;
			const timeoutMs = timeoutSeconds * 1e3;
			const announceTimeoutMs = timeoutSeconds === 0 ? 3e4 : timeoutMs;
			const idempotencyKey = crypto.randomUUID();
			let runId = idempotencyKey;
			if (parseSessionThreadInfoFast(resolvedKey).threadId) return jsonResult({
				runId: crypto.randomUUID(),
				status: "error",
				error: "sessions_send cannot target a thread session for inter-agent coordination. Use the parent channel session key instead.",
				sessionKey: displayKey
			});
			const access = (await createSessionVisibilityGuard({
				action: "send",
				requesterSessionKey: effectiveRequesterKey,
				visibility: sessionVisibility,
				a2aPolicy
			})).check(resolvedKey);
			if (!access.allowed) return jsonResult({
				runId: crypto.randomUUID(),
				status: access.status,
				error: access.error,
				sessionKey: displayKey
			});
			const ensuredSession = await ensureConfiguredAgentMainSession({
				cfg,
				callGateway: gatewayCall,
				sessionKey: resolvedKey,
				mainKey
			});
			if (!ensuredSession.ok) return jsonResult({
				runId: crypto.randomUUID(),
				status: "error",
				error: ensuredSession.error,
				sessionKey: displayKey
			});
			const baselineReply = timeoutSeconds === 0 ? void 0 : await readLatestAssistantReplySnapshot({
				sessionKey: resolvedKey,
				limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
				callGateway: gatewayCall
			});
			const agentMessageContext = buildAgentToAgentMessageContext({
				requesterSessionKey: opts?.agentSessionKey,
				requesterChannel: opts?.agentChannel,
				targetSessionKey: displayKey
			});
			const inputProvenance = {
				kind: "inter_session",
				sourceSessionKey: opts?.agentSessionKey,
				sourceChannel: opts?.agentChannel,
				sourceTool: "sessions_send"
			};
			const sendParams = {
				message: annotateInterSessionPromptText(message, inputProvenance),
				sessionKey: resolvedKey,
				idempotencyKey,
				deliver: false,
				channel: INTERNAL_MESSAGE_CHANNEL,
				lane: resolveNestedAgentLaneForSession(resolvedKey),
				extraSystemPrompt: agentMessageContext,
				inputProvenance
			};
			const requesterSessionKey = opts?.agentSessionKey;
			const requesterChannel = opts?.agentChannel;
			const maxPingPongTurns = resolvePingPongTurns(cfg);
			const targetSessionEntry = loadSessionEntryByKey(resolvedKey);
			const skipAcpA2AFlow = isRequesterParentOfBackgroundAcpSession(targetSessionEntry, effectiveRequesterKey);
			const skipNativeParentA2AFlow = timeoutSeconds !== 0 && isRequesterParentOfNativeSubagentSession({
				entry: targetSessionEntry,
				requesterSessionKey: effectiveRequesterKey,
				targetSessionKey: resolvedKey
			});
			const skipA2AFlow = skipAcpA2AFlow || skipNativeParentA2AFlow;
			const delivery = skipA2AFlow ? {
				status: "skipped",
				mode: "announce"
			} : {
				status: "pending",
				mode: "announce"
			};
			const startA2AFlow = (roundOneReply, waitRunId) => {
				if (skipA2AFlow) return;
				runSessionsSendA2AFlow({
					targetSessionKey: resolvedKey,
					displayKey,
					message,
					announceTimeoutMs,
					maxPingPongTurns,
					requesterSessionKey,
					requesterChannel,
					baseline: baselineReply,
					roundOneReply,
					waitRunId
				});
			};
			if (timeoutSeconds === 0) {
				const start = await startAgentRun({
					callGateway: gatewayCall,
					runId,
					sendParams,
					sessionKey: displayKey
				});
				if (!start.ok) return start.result;
				runId = start.runId;
				startA2AFlow(void 0, runId);
				return jsonResult({
					runId,
					status: "accepted",
					sessionKey: displayKey,
					delivery
				});
			}
			const start = await startAgentRun({
				callGateway: gatewayCall,
				runId,
				sendParams,
				sessionKey: displayKey
			});
			if (!start.ok) return start.result;
			runId = start.runId;
			const result = await waitForAgentRunAndReadUpdatedAssistantReply({
				runId,
				sessionKey: resolvedKey,
				timeoutMs,
				limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
				baseline: baselineReply,
				callGateway: gatewayCall
			});
			if (result.status === "timeout") {
				if (!isTerminalAgentWaitTimeout(result)) {
					startA2AFlow(void 0, runId);
					return jsonResult({
						runId,
						status: "accepted",
						sessionKey: displayKey,
						delivery
					});
				}
				return jsonResult({
					runId,
					status: "timeout",
					error: result.error,
					sessionKey: displayKey
				});
			}
			if (result.status === "error") return jsonResult({
				runId,
				status: "error",
				error: result.error ?? "agent error",
				sessionKey: displayKey
			});
			const reply = result.replyText;
			startA2AFlow(reply ?? void 0);
			return jsonResult({
				runId,
				status: "ok",
				reply,
				sessionKey: displayKey,
				delivery
			});
		}
	};
}
//#endregion
//#region src/agents/tools/sessions-spawn-tool.ts
const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"];
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"];
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"];
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
	"target",
	"transport",
	"channel",
	"to",
	"threadId",
	"thread_id",
	"replyTo",
	"reply_to"
];
const acpSpawnModuleLoader = createLazyImportLoader(() => import("./acp-spawn-BhSOzgaj.js"));
async function loadAcpSpawnModule() {
	return await acpSpawnModuleLoader.load();
}
function summarizeError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "error";
}
function addRoleToFailureResult(result, role) {
	if (!role || result.status !== "error" && result.status !== "forbidden") return result;
	return {
		...result,
		role
	};
}
function resolveTrackedSpawnMode(params) {
	if (params.requestedMode === "run" || params.requestedMode === "session") return params.requestedMode;
	return params.threadRequested ? "session" : "run";
}
async function cleanupUntrackedAcpSession(sessionKey) {
	const key = sessionKey.trim();
	if (!key) return;
	try {
		await callGateway({
			method: "sessions.delete",
			params: {
				key,
				deleteTranscript: true,
				emitLifecycleHooks: false
			},
			timeoutMs: 1e4
		});
	} catch {}
}
function hasAnyThreadAvailability(availability) {
	return availability.subagent || availability.acp;
}
function resolveSessionsSpawnThreadAvailability(opts) {
	const channel = opts?.agentChannel;
	const cfg = opts?.config;
	if (!channel || !cfg || !supportsAutomaticThreadBindingSpawn(channel)) return {
		subagent: false,
		acp: false
	};
	const resolve = (kind) => {
		const policy = resolveThreadBindingSpawnPolicy({
			cfg,
			channel,
			accountId: opts?.agentAccountId,
			kind
		});
		return policy.enabled && policy.spawnEnabled;
	};
	return {
		subagent: resolve("subagent"),
		acp: resolve("acp")
	};
}
function createSessionsSpawnToolSchema(params) {
	const spawnModes = params.threadAvailable ? SUBAGENT_SPAWN_MODES : ["run"];
	const schema = {
		task: Type.String(),
		taskName: Type.Optional(Type.String({ description: "Stable alias for later targeting; lowercase letters/digits/underscores, starts letter." })),
		label: Type.Optional(Type.String()),
		runtime: optionalStringEnum(params.acpAvailable ? SESSIONS_SPAWN_RUNTIMES : ["subagent"]),
		agentId: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.String()),
		cwd: Type.Optional(Type.String()),
		runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
		timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
		...params.threadAvailable ? { thread: Type.Optional(Type.Boolean({ description: "Bind spawn to new chat thread when supported. `thread=true` defaults mode=\"session\"." })) } : {},
		mode: optionalStringEnum(spawnModes),
		cleanup: optionalStringEnum(["delete", "keep"]),
		sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
		context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, { description: "Native context. Omit/\"isolated\" for clean child; \"fork\" only when child needs requester transcript." }),
		lightContext: Type.Optional(Type.Boolean({ description: "Light bootstrap context; runtime=\"subagent\" only." })),
		attachments: Type.Optional(Type.Array(Type.Object({
			name: Type.String(),
			content: Type.String(),
			encoding: Type.Optional(optionalStringEnum(["utf8", "base64"])),
			mimeType: Type.Optional(Type.String())
		}), { maxItems: 50 })),
		attachAs: Type.Optional(Type.Object({ mountPath: Type.Optional(Type.String()) })),
		...params.acpAvailable ? {
			resumeSessionId: Type.Optional(Type.String({ description: "ACP-only resume target; ignored for runtime=\"subagent\". Use id already recorded for this requester." })),
			streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS, { description: "ACP-only stream target; ignored for runtime=\"subagent\". Use \"parent\" to stream turn to requester." })
		} : {}
	};
	return Type.Object(schema);
}
function resolveAcpUnavailableMessage(opts) {
	if (opts?.sandboxed === true) return "runtime=\"acp\" is unavailable from sandboxed sessions because ACP sessions run on the host. Use runtime=\"subagent\".";
	if (opts?.config?.acp?.enabled === false) return "runtime=\"acp\" is unavailable because ACP is disabled by policy (`acp.enabled=false`). Use runtime=\"subagent\".";
	return "runtime=\"acp\" is unavailable in this session because no ACP runtime backend is loaded. Enable the acpx plugin or use runtime=\"subagent\".";
}
function createSessionsSpawnTool(opts) {
	const acpAvailable = isAcpRuntimeSpawnAvailable({
		config: opts?.config,
		sandboxed: opts?.sandboxed
	});
	const threadAvailable = hasAnyThreadAvailability(resolveSessionsSpawnThreadAvailability(opts));
	return {
		label: "Sessions",
		name: "sessions_spawn",
		displaySummary: acpAvailable ? SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY : SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
		description: describeSessionsSpawnTool({
			acpAvailable,
			threadAvailable
		}),
		parameters: createSessionsSpawnToolSchema({
			acpAvailable,
			threadAvailable
		}),
		execute: async (_toolCallId, args) => {
			const params = args;
			const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) => Object.hasOwn(params, key));
			if (unsupportedParam) throw new ToolInputError(`sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`);
			const task = readStringParam$1(params, "task", { required: true });
			const taskNameResult = normalizeSubagentTaskName(params.taskName);
			if (taskNameResult.error) return jsonResult({
				status: "error",
				error: taskNameResult.error
			});
			const taskName = taskNameResult.taskName;
			const label = readStringParam$1(params, "label") ?? "";
			const runtime = params.runtime === "acp" ? "acp" : "subagent";
			const requestedAgentId = readStringParam$1(params, "agentId");
			const resumeSessionId = readStringParam$1(params, "resumeSessionId");
			const modelOverride = normalizeToolModelOverride(readStringParam$1(params, "model"));
			const thinkingOverrideRaw = readStringParam$1(params, "thinking");
			const cwd = readStringParam$1(params, "cwd");
			const mode = params.mode === "run" || params.mode === "session" ? params.mode : void 0;
			const cleanup = params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
			const expectsCompletionMessage = params.expectsCompletionMessage !== false;
			const sandbox = params.sandbox === "require" ? "require" : "inherit";
			const context = params.context === "fork" || params.context === "isolated" ? params.context : void 0;
			const streamTo = runtime === "acp" && params.streamTo === "parent" ? "parent" : void 0;
			const lightContext = params.lightContext === true;
			const roleContext = requestedAgentId ? { role: requestedAgentId } : {};
			if (runtime === "acp" && !acpAvailable) return jsonResult({
				status: "error",
				error: resolveAcpUnavailableMessage(opts),
				...roleContext
			});
			const acpUnsupportedInheritedTool = runtime === "acp" ? findAcpUnsupportedInheritedToolDeny(opts?.inheritedToolDenylist) : void 0;
			if (acpUnsupportedInheritedTool) return jsonResult({
				status: "forbidden",
				error: formatAcpInheritedToolDenyError(acpUnsupportedInheritedTool),
				...roleContext
			});
			const acpUnsupportedInheritedAllow = runtime === "acp" ? findAcpUnsupportedInheritedToolAllow(opts?.inheritedToolAllowlist) : void 0;
			if (acpUnsupportedInheritedAllow) return jsonResult({
				status: "forbidden",
				error: formatAcpInheritedToolAllowError(acpUnsupportedInheritedAllow),
				...roleContext
			});
			if (runtime === "acp" && lightContext) throw new Error("lightContext is only supported for runtime='subagent'.");
			if (runtime === "acp" && context === "fork") throw new Error("context=\"fork\" is only supported for runtime=\"subagent\".");
			const timeoutSecondsCandidate = typeof params.runTimeoutSeconds === "number" ? params.runTimeoutSeconds : typeof params.timeoutSeconds === "number" ? params.timeoutSeconds : void 0;
			const runTimeoutSeconds = typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate) ? Math.max(0, Math.floor(timeoutSecondsCandidate)) : void 0;
			const thread = params.thread === true;
			const attachments = Array.isArray(params.attachments) ? params.attachments : void 0;
			if (runtime === "acp") {
				const { isSpawnAcpAcceptedResult, spawnAcpDirect } = await loadAcpSpawnModule();
				if (Array.isArray(attachments) && attachments.length > 0) return jsonResult({
					status: "error",
					error: "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
					...roleContext
				});
				const result = await spawnAcpDirect({
					task,
					label: label || void 0,
					agentId: requestedAgentId,
					resumeSessionId,
					model: modelOverride,
					thinking: thinkingOverrideRaw,
					runTimeoutSeconds,
					cwd,
					mode: mode === "run" || mode === "session" ? mode : void 0,
					thread,
					sandbox,
					streamTo
				}, {
					agentSessionKey: opts?.agentSessionKey,
					agentChannel: opts?.agentChannel,
					agentAccountId: opts?.agentAccountId,
					agentTo: opts?.agentTo,
					agentThreadId: opts?.agentThreadId,
					agentGroupId: opts?.agentGroupId ?? void 0,
					agentGroupSpace: opts?.agentGroupSpace,
					agentMemberRoleIds: opts?.agentMemberRoleIds,
					sandboxed: opts?.sandboxed,
					inheritedToolAllowlist: opts?.inheritedToolAllowlist,
					inheritedToolDenylist: opts?.inheritedToolDenylist
				});
				const childSessionKey = result.childSessionKey?.trim();
				const childRunId = isSpawnAcpAcceptedResult(result) ? result.runId?.trim() : void 0;
				if (result.status === "accepted" && Boolean(childSessionKey) && Boolean(childRunId) && streamTo !== "parent" && childSessionKey && childRunId) {
					const cfg = getRuntimeConfig();
					const trackedSpawnMode = resolveTrackedSpawnMode({
						requestedMode: result.mode,
						threadRequested: thread
					});
					const trackedCleanup = trackedSpawnMode === "session" ? "keep" : cleanup;
					const ownership = resolveSubagentSpawnOwnership({
						cfg,
						agentSessionKey: opts?.agentSessionKey,
						completionOwnerKey: opts?.completionOwnerKey
					});
					const requesterOrigin = normalizeDeliveryContext({
						channel: opts?.agentChannel,
						accountId: opts?.agentAccountId,
						to: opts?.agentTo,
						threadId: opts?.agentThreadId
					});
					const shouldExpectCompletionMessage = result.inlineDelivery ? false : expectsCompletionMessage;
					try {
						registerSubagentRun({
							runId: childRunId,
							childSessionKey,
							controllerSessionKey: ownership.controllerSessionKey,
							requesterSessionKey: ownership.completionRequesterSessionKey,
							requesterOrigin,
							requesterDisplayKey: ownership.completionRequesterDisplayKey,
							task,
							taskName,
							cleanup: trackedCleanup,
							label: label || void 0,
							runTimeoutSeconds,
							expectsCompletionMessage: shouldExpectCompletionMessage,
							spawnMode: trackedSpawnMode
						});
					} catch (err) {
						await cleanupUntrackedAcpSession(childSessionKey);
						return jsonResult({
							status: "error",
							error: `Failed to register ACP run: ${summarizeError(err)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
							childSessionKey,
							runId: childRunId,
							...roleContext
						});
					}
				}
				return jsonResult(addRoleToFailureResult(result, requestedAgentId));
			}
			return jsonResult(addRoleToFailureResult(await spawnSubagentDirect({
				task,
				taskName,
				label: label || void 0,
				agentId: requestedAgentId,
				model: modelOverride,
				thinking: thinkingOverrideRaw,
				cwd,
				runTimeoutSeconds,
				thread,
				mode,
				cleanup,
				sandbox,
				context,
				lightContext,
				expectsCompletionMessage,
				attachments,
				attachMountPath: params.attachAs && typeof params.attachAs === "object" ? readStringParam$1(params.attachAs, "mountPath") : void 0
			}, {
				agentSessionKey: opts?.agentSessionKey,
				completionOwnerKey: opts?.completionOwnerKey,
				agentChannel: opts?.agentChannel,
				agentAccountId: opts?.agentAccountId,
				agentTo: opts?.agentTo,
				agentThreadId: opts?.agentThreadId,
				agentGroupId: opts?.agentGroupId,
				agentGroupChannel: opts?.agentGroupChannel,
				agentGroupSpace: opts?.agentGroupSpace,
				agentMemberRoleIds: opts?.agentMemberRoleIds,
				requesterAgentIdOverride: opts?.requesterAgentIdOverride,
				workspaceDir: opts?.workspaceDir,
				inheritedToolAllowlist: opts?.inheritedToolAllowlist,
				inheritedToolDenylist: opts?.inheritedToolDenylist
			}), requestedAgentId));
		}
	};
}
//#endregion
//#region src/agents/tools/sessions-yield-tool.ts
const SessionsYieldToolSchema = Type.Object({ message: Type.Optional(Type.String()) });
function createSessionsYieldTool(opts) {
	return {
		label: "Yield",
		name: "sessions_yield",
		description: "End current turn. Use after spawning subagents; results arrive as next message.",
		parameters: SessionsYieldToolSchema,
		execute: async (_toolCallId, args) => {
			const message = readStringParam$1(args, "message") || "Turn yielded.";
			if (!opts?.sessionId) return jsonResult({
				status: "error",
				error: "No session context"
			});
			if (!opts?.onYield) return jsonResult({
				status: "error",
				error: "Yield not supported in this context"
			});
			await opts.onYield(message);
			return jsonResult({
				status: "yielded",
				message
			});
		}
	};
}
//#endregion
//#region src/agents/tools/subagents-tool.ts
const SubagentsToolSchema = Type.Object({
	action: optionalStringEnum([
		"list",
		"kill",
		"steer"
	]),
	target: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	recentMinutes: Type.Optional(Type.Number({ minimum: 1 }))
});
function createSubagentsTool(opts) {
	return {
		label: "Subagents",
		name: "subagents",
		description: "List/kill/steer spawned subagents for requester session. If sessions_yield exists, use it for completion; do not poll wait loops.",
		parameters: SubagentsToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const action = readStringParam$1(params, "action") ?? "list";
			const cfg = getRuntimeConfig();
			const controller = resolveSubagentController({
				cfg,
				agentSessionKey: opts?.agentSessionKey
			});
			const runs = listControlledSubagentRuns(controller.controllerSessionKey);
			const recentMinutesRaw = readNumberParam(params, "recentMinutes");
			const recentMinutes = recentMinutesRaw ? Math.max(1, Math.min(MAX_RECENT_MINUTES, Math.floor(recentMinutesRaw))) : 30;
			const pendingDescendantCount = createPendingDescendantCounter();
			const isActive = (entry) => isActiveSubagentRun(entry, pendingDescendantCount);
			if (action === "list") {
				const list = buildSubagentList({
					cfg,
					runs,
					recentMinutes
				});
				return jsonResult({
					status: "ok",
					action: "list",
					requesterSessionKey: controller.controllerSessionKey,
					callerSessionKey: controller.callerSessionKey,
					callerIsSubagent: controller.callerIsSubagent,
					total: list.total,
					active: list.active.map(({ line: _line, ...view }) => view),
					recent: list.recent.map(({ line: _line, ...view }) => view),
					text: list.text
				});
			}
			if (action === "kill") {
				const target = readStringParam$1(params, "target", { required: true });
				if (target === "all" || target === "*") {
					const result = await killAllControlledSubagentRuns({
						cfg,
						controller,
						runs
					});
					if (result.status === "forbidden") return jsonResult({
						status: "forbidden",
						action: "kill",
						target: "all",
						error: result.error
					});
					return jsonResult({
						status: "ok",
						action: "kill",
						target: "all",
						killed: result.killed,
						labels: result.labels,
						text: result.killed > 0 ? `killed ${result.killed} subagent${result.killed === 1 ? "" : "s"}.` : "no running subagents to kill."
					});
				}
				const resolved = resolveControlledSubagentTarget(runs, target, {
					recentMinutes,
					isActive
				});
				if (!resolved.entry) return jsonResult({
					status: "error",
					action: "kill",
					target,
					error: resolved.error ?? "Unknown subagent target."
				});
				const result = await killControlledSubagentRun({
					cfg,
					controller,
					entry: resolved.entry
				});
				return jsonResult({
					status: result.status,
					action: "kill",
					target,
					runId: result.runId,
					sessionKey: result.sessionKey,
					label: result.label,
					cascadeKilled: "cascadeKilled" in result ? result.cascadeKilled : void 0,
					cascadeLabels: "cascadeLabels" in result ? result.cascadeLabels : void 0,
					error: "error" in result ? result.error : void 0,
					text: result.text
				});
			}
			if (action === "steer") {
				const target = readStringParam$1(params, "target", { required: true });
				const message = readStringParam$1(params, "message", { required: true });
				if (message.length > 4e3) return jsonResult({
					status: "error",
					action: "steer",
					target,
					error: `Message too long (${message.length} chars, max ${MAX_STEER_MESSAGE_CHARS}).`
				});
				const resolved = resolveControlledSubagentTarget(runs, target, {
					recentMinutes,
					isActive
				});
				if (!resolved.entry) return jsonResult({
					status: "error",
					action: "steer",
					target,
					error: resolved.error ?? "Unknown subagent target."
				});
				const result = await steerControlledSubagentRun({
					cfg,
					controller,
					entry: resolved.entry,
					message
				});
				return jsonResult({
					status: result.status,
					action: "steer",
					target,
					runId: result.runId,
					sessionKey: result.sessionKey,
					sessionId: result.sessionId,
					mode: "mode" in result ? result.mode : void 0,
					label: "label" in result ? result.label : void 0,
					error: "error" in result ? result.error : void 0,
					text: result.text
				});
			}
			return jsonResult({
				status: "error",
				error: "Unsupported action."
			});
		}
	};
}
//#endregion
//#region src/agents/tools/tts-tool.ts
const TtsToolSchema = Type.Object({
	text: Type.String({ description: "Text to speak." }),
	channel: Type.Optional(Type.String({ description: "Channel id; output-format hint." })),
	timeoutMs: Type.Optional(Type.Number({
		description: "Provider timeout ms.",
		minimum: 1
	}))
});
function readTtsTimeoutMs(args) {
	const timeoutMs = readNumberParam(args, "timeoutMs", {
		integer: true,
		strict: true
	});
	if (timeoutMs === void 0) return;
	if (timeoutMs <= 0) throw new ToolInputError("timeoutMs must be a positive integer in milliseconds.");
	return timeoutMs;
}
/**
* Defuse reply-directive tokens inside spoken transcripts before they flow
* through tool-result content. When verbose tool output is enabled,
* `emitToolOutput` passes the content through `parseReplyDirectives`
* (`src/media/parse.ts` / `src/utils/directive-tags.ts`), and unfiltered
* `MEDIA:` or `[[audio_as_voice]]`-shaped tokens in the transcript would be
* rewritten into actual media URLs and audio-as-voice flags. Insert a
* zero-width word joiner so the regex patterns stop matching without
* changing the visible text.
*/
function sanitizeTranscriptForToolContent(text) {
	return text.replace(/^([^\S\r\n]*)MEDIA:/gim, "$1⁠MEDIA:").replace(/\[\[/g, "[⁠[").replace(/^([ \t]*)(`{3,})/gm, (_match, indent, fence) => {
		const [first = "", ...rest] = fence;
		return `${indent}${first}\u2060${rest.join("")}`;
	});
}
function createTtsTool(opts) {
	return {
		label: "TTS",
		name: "tts",
		displaySummary: "Text to speech audio.",
		description: "Use only for explicit audio intent (voice/speech/TTS) or active TTS config. Never use for ordinary text replies. Audio auto-delivered from tool result; after success follow reply instructions, no duplicate text/audio.",
		parameters: TtsToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const text = readStringParam$1(params, "text", { required: true });
			const channel = readStringParam$1(params, "channel");
			const timeoutMs = readTtsTimeoutMs(params);
			const result = await textToSpeech({
				text,
				cfg: opts?.config ?? getRuntimeConfig(),
				channel: channel ?? opts?.agentChannel,
				timeoutMs,
				agentId: opts?.agentId,
				accountId: opts?.agentAccountId
			});
			if (result.success && result.audioPath) return {
				content: [{
					type: "text",
					text: `(spoken) ${sanitizeTranscriptForToolContent(text)}`
				}],
				details: {
					audioPath: result.audioPath,
					provider: result.provider,
					...timeoutMs !== void 0 ? { timeoutMs } : {},
					media: {
						mediaUrl: result.audioPath,
						trustedLocalMedia: true,
						...result.audioAsVoice || result.voiceCompatible ? { audioAsVoice: true } : {}
					}
				}
			};
			throw new Error(result.error ?? "TTS conversion failed");
		}
	};
}
//#endregion
//#region src/agents/tools/update-plan-tool.ts
const PLAN_STEP_STATUSES = [
	"pending",
	"in_progress",
	"completed"
];
const UpdatePlanToolSchema = Type.Object({
	explanation: Type.Optional(Type.String({ description: "Short note: what changed." })),
	plan: Type.Array(Type.Object({
		step: Type.String({ description: "Short step." }),
		status: stringEnum(PLAN_STEP_STATUSES, { description: "pending | in_progress | completed." })
	}, { additionalProperties: true }), {
		minItems: 1,
		description: "Ordered steps; max one in_progress."
	})
});
function readPlanSteps(params) {
	const rawPlan = params.plan;
	if (!Array.isArray(rawPlan) || rawPlan.length === 0) throw new ToolInputError("plan required");
	const steps = rawPlan.map((entry, index) => {
		if (!entry || typeof entry !== "object") throw new ToolInputError(`plan[${index}] must be an object`);
		const stepParams = entry;
		const step = readStringParam$1(stepParams, "step", {
			required: true,
			label: `plan[${index}].step`
		});
		const status = readStringParam$1(stepParams, "status", {
			required: true,
			label: `plan[${index}].status`
		});
		if (!PLAN_STEP_STATUSES.includes(status)) throw new ToolInputError(`plan[${index}].status must be one of ${PLAN_STEP_STATUSES.join(", ")}`);
		return {
			step,
			status
		};
	});
	if (steps.filter((entry) => entry.status === "in_progress").length > 1) throw new ToolInputError("plan can contain at most one in_progress step");
	return steps;
}
function createUpdatePlanTool() {
	return {
		label: "Update Plan",
		name: "update_plan",
		displaySummary: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
		description: describeUpdatePlanTool(),
		parameters: UpdatePlanToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const explanation = readStringParam$1(params, "explanation");
			const plan = readPlanSteps(params);
			return {
				content: [],
				details: {
					status: "updated",
					...explanation ? { explanation } : {},
					plan
				}
			};
		}
	};
}
//#endregion
//#region src/agents/video-generation-task-status.ts
const VIDEO_GENERATION_TASK_KIND = "video_generation";
const VIDEO_GENERATION_SOURCE_PREFIX = "video_generate";
const RECENT_VIDEO_GENERATION_DUPLICATE_GUARD_MS = 2 * 6e4;
function findActiveVideoGenerationTaskForSession(sessionKey) {
	return findActiveMediaGenerationTaskForSession({
		sessionKey,
		taskKind: VIDEO_GENERATION_TASK_KIND,
		sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX
	});
}
function findDuplicateGuardVideoGenerationTaskForSession(sessionKey, params) {
	return findDuplicateGuardMediaGenerationTaskForSession({
		sessionKey,
		taskKind: VIDEO_GENERATION_TASK_KIND,
		sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
		taskLabel: params?.prompt,
		requestKey: params?.requestKey,
		maxAgeMs: RECENT_VIDEO_GENERATION_DUPLICATE_GUARD_MS
	});
}
function buildVideoGenerationTaskStatusDetails(task) {
	return buildMediaGenerationTaskStatusDetails({
		task,
		sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX
	});
}
function buildVideoGenerationTaskStatusText(task, params) {
	return buildMediaGenerationTaskStatusText({
		task,
		sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
		nounLabel: "Video generation",
		toolName: "video_generate",
		completionLabel: "video",
		duplicateGuard: params?.duplicateGuard
	});
}
function buildActiveVideoGenerationTaskPromptContextForSession(sessionKey) {
	return buildActiveMediaGenerationTaskPromptContextForSession({
		sessionKey,
		taskKind: VIDEO_GENERATION_TASK_KIND,
		sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
		nounLabel: "Video generation",
		toolName: "video_generate",
		completionLabel: "videos"
	});
}
//#endregion
//#region src/agents/tools/video-generate-background.ts
const videoGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
	toolName: "video_generate",
	taskKind: VIDEO_GENERATION_TASK_KIND,
	label: "Video generation",
	queuedProgressSummary: "Queued video generation",
	generatedLabel: "video",
	failureProgressSummary: "Video generation failed",
	eventSource: "video_generation",
	announceType: "video generation task",
	completionLabel: "video"
});
const createVideoGenerationTaskRun = (...params) => videoGenerationTaskLifecycle.createTaskRun(...params);
const recordVideoGenerationTaskProgress = (...params) => videoGenerationTaskLifecycle.recordTaskProgress(...params);
const completeVideoGenerationTaskRun = (...params) => videoGenerationTaskLifecycle.completeTaskRun(...params);
const failVideoGenerationTaskRun = (...params) => videoGenerationTaskLifecycle.failTaskRun(...params);
//#endregion
//#region src/agents/tools/video-generate-tool.actions.ts
function summarizeVideoGenerationCapabilities(provider) {
	const supportedModes = listSupportedVideoGenerationModes(provider);
	const generate = provider.capabilities.generate;
	const imageToVideo = provider.capabilities.imageToVideo;
	const videoToVideo = provider.capabilities.videoToVideo;
	const declaredProviderOptions = {};
	for (const [key, type] of Object.entries(provider.capabilities.providerOptions ?? {})) declaredProviderOptions[key] = type;
	for (const [key, type] of Object.entries(generate?.providerOptions ?? {})) declaredProviderOptions[key] = type;
	for (const [key, type] of Object.entries(imageToVideo?.providerOptions ?? {})) declaredProviderOptions[key] = type;
	for (const [key, type] of Object.entries(videoToVideo?.providerOptions ?? {})) declaredProviderOptions[key] = type;
	const maxInputAudios = generate?.maxInputAudios ?? imageToVideo?.maxInputAudios ?? videoToVideo?.maxInputAudios ?? provider.capabilities.maxInputAudios;
	return [
		supportedModes.length > 0 ? `modes=${supportedModes.join("/")}` : null,
		generate?.maxVideos ? `maxVideos=${generate.maxVideos}` : null,
		imageToVideo?.maxInputImages ? `maxInputImages=${imageToVideo.maxInputImages}` : null,
		videoToVideo?.maxInputVideos ? `maxInputVideos=${videoToVideo.maxInputVideos}` : null,
		typeof maxInputAudios === "number" && maxInputAudios > 0 ? `maxInputAudios=${maxInputAudios}` : null,
		generate?.maxDurationSeconds ? `maxDurationSeconds=${generate.maxDurationSeconds}` : null,
		generate?.supportedDurationSeconds?.length ? `supportedDurationSeconds=${generate.supportedDurationSeconds.join("/")}` : null,
		generate?.supportedDurationSecondsByModel && Object.keys(generate.supportedDurationSecondsByModel).length > 0 ? `supportedDurationSecondsByModel=${Object.entries(generate.supportedDurationSecondsByModel).map(([modelId, durations]) => `${modelId}:${durations.join("/")}`).join("; ")}` : null,
		generate?.supportsResolution ? "resolution" : null,
		generate?.supportsAspectRatio ? "aspectRatio" : null,
		generate?.supportsSize ? "size" : null,
		generate?.supportsAudio ? "audio" : null,
		generate?.supportsWatermark ? "watermark" : null,
		Object.keys(declaredProviderOptions).length > 0 ? `providerOptions={${Object.entries(declaredProviderOptions).map(([key, type]) => `${key}:${type}`).join(", ")}}` : null
	].filter((entry) => Boolean(entry)).join(", ");
}
function createVideoGenerateListActionResult(config, options) {
	return createMediaGenerateProviderListActionResult({
		kind: "video_generation",
		providers: listRuntimeVideoGenerationProviders({ config }),
		emptyText: "No video-generation providers are registered.",
		cfg: config,
		workspaceDir: options?.workspaceDir,
		agentDir: options?.agentDir,
		authStore: options?.authStore,
		listModes: listSupportedVideoGenerationModes,
		summarizeCapabilities: summarizeVideoGenerationCapabilities
	});
}
const videoGenerateTaskStatusActions = createMediaGenerateTaskStatusActions({
	inactiveText: "No active video generation task is currently running for this session.",
	findActiveTask: (sessionKey) => findActiveVideoGenerationTaskForSession(sessionKey) ?? void 0,
	buildStatusText: buildVideoGenerationTaskStatusText,
	buildStatusDetails: buildVideoGenerationTaskStatusDetails
});
function createVideoGenerateStatusActionResult(sessionKey) {
	return videoGenerateTaskStatusActions.createStatusActionResult(sessionKey);
}
function createVideoGenerateDuplicateGuardResult(sessionKey, params) {
	const blockingTask = findDuplicateGuardVideoGenerationTaskForSession(sessionKey, {
		prompt: params?.prompt,
		requestKey: params?.requestKey
	});
	if (!blockingTask) return;
	return {
		content: [{
			type: "text",
			text: buildVideoGenerationTaskStatusText(blockingTask, { duplicateGuard: true })
		}],
		details: {
			action: "status",
			duplicateGuard: true,
			...buildVideoGenerationTaskStatusDetails(blockingTask)
		}
	};
}
//#endregion
//#region src/agents/tools/video-generate-tool.ts
const log = createSubsystemLogger("agents/tools/video-generate");
const MAX_INPUT_IMAGES = 9;
const MAX_INPUT_VIDEOS = 4;
const MAX_INPUT_AUDIOS = 3;
const VideoGenerateToolProperties = {
	action: Type.Optional(Type.String({ description: "\"generate\" default, \"status\" active task, \"list\" providers/models." })),
	prompt: Type.Optional(Type.String({ description: "Video prompt." })),
	image: Type.Optional(Type.String({ description: "One reference image path/URL." })),
	images: Type.Optional(Type.Array(Type.String(), { description: `Reference images; max ${MAX_INPUT_IMAGES}.` })),
	imageRoles: Type.Optional(Type.Array(Type.String(), { description: "`image` + `images` roles by index after de-dupe. Values: first_frame, last_frame, reference_image; empty string leaves unset." })),
	video: Type.Optional(Type.String({ description: "One reference video path/URL." })),
	videos: Type.Optional(Type.Array(Type.String(), { description: `Reference videos; max ${MAX_INPUT_VIDEOS}.` })),
	videoRoles: Type.Optional(Type.Array(Type.String(), { description: "`video` + `videos` roles by index after de-dupe. Value: reference_video; empty string leaves unset." })),
	audioRef: Type.Optional(Type.String({ description: "One reference audio path/URL, e.g. music." })),
	audioRefs: Type.Optional(Type.Array(Type.String(), { description: `Reference audios; max ${MAX_INPUT_AUDIOS}.` })),
	audioRoles: Type.Optional(Type.Array(Type.String(), { description: "`audioRef` + `audioRefs` roles by index after de-dupe. Value: reference_audio; empty string leaves unset." })),
	model: Type.Optional(Type.String({ description: "Provider/model override, e.g. qwen/wan2.6-t2v." })),
	filename: Type.Optional(Type.String({ description: "Output filename hint; basename preserved in managed media dir." })),
	size: Type.Optional(Type.String({ description: "Size hint, e.g. 1280x720, 1920x1080." })),
	aspectRatio: Type.Optional(Type.String({ description: "Aspect ratio: 1:1, 16:9, 9:16, \"adaptive\", or provider value; unsupported normalized/ignored." })),
	resolution: Type.Optional(Type.String({ description: "Resolution: 480P, 720P, 768P, 1080P, 4K, or provider value; unsupported normalized/ignored." })),
	durationSeconds: Type.Optional(Type.Number({
		description: "Target seconds; may round to nearest supported duration.",
		minimum: 1
	})),
	audio: Type.Optional(Type.Boolean({ description: "Generated-audio toggle." })),
	watermark: Type.Optional(Type.Boolean({ description: "Watermark toggle." })),
	providerOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Provider JSON options, e.g. {\"seed\":42}. Keys/types must match provider capabilities; mismatch skips candidate. Use action=list for accepted keys." })),
	timeoutMs: Type.Optional(Type.Number({
		description: "Provider timeout ms.",
		minimum: 1
	}))
};
function createVideoGenerateToolSchema(params) {
	const properties = { ...VideoGenerateToolProperties };
	if (!params.includeAudioReferences) {
		delete properties.audioRef;
		delete properties.audioRefs;
		delete properties.audioRoles;
	}
	return Type.Object(properties);
}
function resolveVideoGenerationModelConfigForTool(params) {
	return resolveCapabilityModelConfigForTool({
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		authStore: params.authStore,
		modelConfig: params.cfg?.agents?.defaults?.videoGenerationModel,
		providers: () => listRuntimeVideoGenerationProviders({ config: params.cfg })
	});
}
function hasExplicitVideoGenerationModelConfig(cfg) {
	return hasToolModelConfig$1(coerceToolModelConfig(cfg?.agents?.defaults?.videoGenerationModel));
}
function collectVideoGenerationModelProviderIds(modelConfig) {
	const providerIds = /* @__PURE__ */ new Set();
	for (const modelRef of [modelConfig.primary, ...modelConfig.fallbacks ?? []]) {
		const parsed = parseVideoGenerationModelRef(modelRef);
		if (parsed?.provider) providerIds.add(parsed.provider);
	}
	return providerIds;
}
function isVideoGenerationProviderConfigured(params) {
	return getCustomProviderApiKey(params.cfg, params.providerId) !== void 0 || hasSnapshotCapabilityProviderAvailability({
		snapshot: params.snapshot,
		key: "videoGenerationProviders",
		providerId: params.providerId,
		config: params.cfg,
		authStore: params.authStore
	}) || hasAuthForProvider({
		provider: params.providerId,
		agentDir: params.agentDir,
		authStore: params.authStore
	});
}
function shouldExposeVideoReferenceAudioParams(params) {
	const snapshot = loadCapabilityMetadataSnapshot({
		config: params.cfg,
		workspaceDir: params.workspaceDir
	});
	const knownProviderIds = /* @__PURE__ */ new Set();
	const audioCandidateProviderIds = /* @__PURE__ */ new Set();
	const explicitProviderIds = collectVideoGenerationModelProviderIds(coerceToolModelConfig(params.cfg.agents?.defaults?.videoGenerationModel));
	for (const plugin of snapshot.plugins) {
		if (!isManifestPluginAvailableForControlPlane({
			snapshot,
			plugin,
			config: params.cfg
		})) continue;
		const providerIds = plugin.contracts?.videoGenerationProviders ?? [];
		for (const providerId of providerIds) {
			knownProviderIds.add(providerId);
			const metadata = plugin.videoGenerationProviderMetadata?.[providerId];
			const providerCanUseReferenceAudio = metadata?.referenceAudioInputs === true;
			for (const alias of metadata?.aliases ?? []) {
				knownProviderIds.add(alias);
				if (providerCanUseReferenceAudio) audioCandidateProviderIds.add(alias);
			}
			if (providerCanUseReferenceAudio) audioCandidateProviderIds.add(providerId);
		}
	}
	for (const providerId of explicitProviderIds) if (!knownProviderIds.has(providerId) || audioCandidateProviderIds.has(providerId)) return true;
	for (const providerId of audioCandidateProviderIds) if (isVideoGenerationProviderConfigured({
		snapshot,
		cfg: params.cfg,
		agentDir: params.agentDir,
		authStore: params.authStore,
		providerId
	})) return true;
	return false;
}
function resolveAction(args) {
	return resolveGenerateAction({
		args,
		allowed: [
			"generate",
			"status",
			"list"
		],
		defaultAction: "generate"
	});
}
function normalizeResolution(raw) {
	const normalized = raw?.trim();
	if (!normalized) return;
	const uppercase = normalized.toUpperCase();
	if (/^\d+P$/.test(uppercase) || /^\d+K$/.test(uppercase)) return uppercase;
	return normalized;
}
function normalizeAspectRatio(raw) {
	const normalized = raw?.trim();
	if (!normalized) return;
	return normalized;
}
/**
* Parse a `*Roles` parallel string array for `video_generate`. Throws when
* the caller supplies more roles than assets so off-by-one alignment bugs
* fail loudly at the tool boundary instead of silently dropping the
* trailing roles. Empty strings in the array are allowed and mean "no
* role at this position". Non-string entries are coerced to empty strings
* and treated as "unset" so providers can leave individual slots empty.
*/
function parseRoleArray(params) {
	if (params.raw === void 0 || params.raw === null) return [];
	if (!Array.isArray(params.raw)) throw new ToolInputError(`${params.kind} must be a JSON array of role strings, parallel to the reference list.`);
	const roles = params.raw.map((entry) => typeof entry === "string" ? entry.trim() : "");
	if (roles.length > params.assetCount) throw new ToolInputError(`${params.kind} has ${roles.length} entries but only ${params.assetCount} reference ${params.kind === "imageRoles" ? "image" : params.kind === "videoRoles" ? "video" : "audio"}${params.assetCount === 1 ? "" : "s"} were provided; extra roles cannot be aligned positionally.`);
	return roles;
}
function normalizeReferenceInputs(params) {
	return normalizeMediaReferenceInputs({
		args: params.args,
		singularKey: params.singularKey,
		pluralKey: params.pluralKey,
		maxCount: params.maxCount,
		label: `reference ${params.pluralKey}`
	});
}
function resolveSelectedVideoGenerationProvider(params) {
	return resolveSelectedCapabilityProvider({
		providers: listRuntimeVideoGenerationProviders({ config: params.config }),
		modelConfig: params.videoGenerationModelConfig,
		modelOverride: params.modelOverride,
		parseModelRef: parseVideoGenerationModelRef
	});
}
function validateVideoGenerationCapabilities(params) {
	const provider = params.provider;
	if (!provider) return;
	const mode = resolveVideoGenerationMode({
		inputImageCount: params.inputImageCount,
		inputVideoCount: params.inputVideoCount
	});
	const { capabilities: caps } = resolveVideoGenerationModeCapabilities({
		provider,
		model: params.model,
		inputImageCount: params.inputImageCount,
		inputVideoCount: params.inputVideoCount
	});
	if (!caps && mode === "imageToVideo" && params.inputVideoCount === 0) throw new ToolInputError(`${provider.id} does not support image-to-video reference inputs.`);
	if (!caps && mode === "videoToVideo" && params.inputImageCount === 0) throw new ToolInputError(`${provider.id} does not support video-to-video reference inputs.`);
	if (!caps) return;
	if (mode === "imageToVideo" && "enabled" in caps && !caps.enabled && params.inputVideoCount === 0) throw new ToolInputError(`${provider.id} does not support image-to-video reference inputs.`);
	if (mode === "videoToVideo" && "enabled" in caps && !caps.enabled && params.inputImageCount === 0) throw new ToolInputError(`${provider.id} does not support video-to-video reference inputs.`);
	if (params.inputImageCount > 0) {
		const maxInputImages = caps.maxInputImages ?? MAX_INPUT_IMAGES;
		if (params.inputImageCount > maxInputImages) throw new ToolInputError(`${provider.id} supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`);
	}
	if (params.inputVideoCount > 0) {
		const maxInputVideos = caps.maxInputVideos ?? MAX_INPUT_VIDEOS;
		if (params.inputVideoCount > maxInputVideos) throw new ToolInputError(`${provider.id} supports at most ${maxInputVideos} reference video${maxInputVideos === 1 ? "" : "s"}.`);
	}
}
function formatIgnoredVideoGenerationOverride(override) {
	return `${override.key}=${String(override.value)}`;
}
const defaultScheduleVideoGenerateBackgroundWork = createDefaultMediaGenerateBackgroundScheduler({
	toolName: "video_generate",
	onCrash: (message, meta) => log.error(message, meta)
});
async function loadReferenceAssets(params) {
	const loaded = [];
	for (const rawInput of params.inputs) {
		const trimmed = rawInput.trim();
		const inputRaw = normalizeMediaReferenceSource(trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed);
		if (!inputRaw) throw new ToolInputError(`${params.expectedKind} required (empty string in array)`);
		const refInfo = classifyMediaReferenceSource(inputRaw);
		const { isDataUrl, isHttpUrl } = refInfo;
		if (refInfo.hasUnsupportedScheme) throw new ToolInputError(`Unsupported ${params.expectedKind} reference: ${rawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`);
		if (params.sandboxConfig && isHttpUrl) throw new ToolInputError(`Sandboxed video_generate does not allow remote ${params.expectedKind} URLs.`);
		const resolvedInput = (() => {
			if (params.sandboxConfig) return inputRaw;
			if (inputRaw.startsWith("~")) return resolveUserPath(inputRaw);
			return inputRaw;
		})();
		if (isHttpUrl && !params.sandboxConfig) {
			loaded.push({
				sourceAsset: { url: resolvedInput },
				resolvedInput
			});
			continue;
		}
		const resolvedPathInfo = isDataUrl ? { resolved: "" } : params.sandboxConfig ? await resolveSandboxedBridgeMediaPath({
			sandbox: params.sandboxConfig,
			mediaPath: resolvedInput,
			inboundFallbackDir: "media/inbound"
		}) : { resolved: resolvedInput.startsWith("file://") ? resolvedInput.slice(7) : resolvedInput };
		const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;
		const localRoots = resolveMediaToolLocalRoots(params.workspaceDir, { workspaceOnly: params.sandboxConfig?.workspaceOnly === true }, resolvedPath ? [resolvedPath] : void 0);
		const media = isDataUrl ? params.expectedKind === "image" ? decodeDataUrl(resolvedInput) : (() => {
			throw new ToolInputError(`${params.expectedKind} data: URLs are not supported for video_generate.`);
		})() : params.sandboxConfig ? await loadWebMedia(resolvedPath ?? resolvedInput, {
			maxBytes: params.maxBytes,
			sandboxValidated: true,
			readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig })
		}) : await loadWebMedia(resolvedPath ?? resolvedInput, {
			maxBytes: params.maxBytes,
			localRoots,
			ssrfPolicy: params.ssrfPolicy
		});
		if (media.kind !== params.expectedKind) throw new ToolInputError(`Unsupported media type: ${media.kind ?? "unknown"}`);
		const mimeType = "mimeType" in media ? media.mimeType : media.contentType;
		const fileName = "fileName" in media ? media.fileName : void 0;
		loaded.push({
			sourceAsset: {
				buffer: media.buffer,
				mimeType,
				fileName
			},
			resolvedInput,
			...resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}
		});
	}
	return loaded;
}
function isGeneratedMediaSizeLimitError(error) {
	return error instanceof Error && /^Media exceeds \d+MB limit$/.test(error.message);
}
async function executeVideoGenerationJob(params) {
	if (params.taskHandle) recordVideoGenerationTaskProgress({
		handle: params.taskHandle,
		progressSummary: "Generating video"
	});
	const result = await generateVideo({
		cfg: params.effectiveCfg,
		prompt: params.prompt,
		agentDir: params.agentDir,
		modelOverride: params.model,
		size: params.size,
		aspectRatio: params.aspectRatio,
		resolution: params.resolution,
		durationSeconds: params.durationSeconds,
		audio: params.audio,
		watermark: params.watermark,
		inputImages: params.loadedReferenceImages.map((entry) => entry.sourceAsset),
		inputVideos: params.loadedReferenceVideos.map((entry) => entry.sourceAsset),
		inputAudios: params.loadedReferenceAudios.map((entry) => entry.sourceAsset),
		autoProviderFallback: params.autoProviderFallback,
		providerOptions: params.providerOptions,
		timeoutMs: params.timeoutMs
	});
	if (params.taskHandle) recordVideoGenerationTaskProgress({
		handle: params.taskHandle,
		progressSummary: "Saving generated video"
	});
	const urlOnlyVideos = [];
	const bufferVideos = [];
	for (const video of result.videos) {
		if (video.buffer) {
			bufferVideos.push(video);
			continue;
		}
		if (video.url) {
			urlOnlyVideos.push({
				url: video.url,
				mimeType: video.mimeType,
				fileName: video.fileName
			});
			continue;
		}
		throw new Error(`Provider ${result.provider} returned a video asset with neither buffer nor url — cannot deliver.`);
	}
	const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "video");
	const savedVideos = [];
	for (const video of bufferVideos) try {
		const saved = await saveMediaBuffer(video.buffer, video.mimeType, "tool-video-generation", mediaMaxBytes, params.filename || video.fileName);
		savedVideos.push(saved);
	} catch (error) {
		if (video.url && isGeneratedMediaSizeLimitError(error)) {
			urlOnlyVideos.push({
				url: video.url,
				mimeType: video.mimeType,
				fileName: video.fileName
			});
			continue;
		}
		throw error;
	}
	const totalCount = savedVideos.length + urlOnlyVideos.length;
	const requestedDurationSeconds = result.normalization?.durationSeconds?.requested ?? (typeof result.metadata?.requestedDurationSeconds === "number" && Number.isFinite(result.metadata.requestedDurationSeconds) ? result.metadata.requestedDurationSeconds : params.durationSeconds);
	const ignoredOverrides = result.ignoredOverrides ?? [];
	const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
	const warning = ignoredOverrides.length > 0 ? `Ignored unsupported overrides for ${result.provider}/${result.model}: ${ignoredOverrides.map(formatIgnoredVideoGenerationOverride).join(", ")}.` : void 0;
	const normalizedDurationSeconds = result.normalization?.durationSeconds?.applied ?? (typeof result.metadata?.normalizedDurationSeconds === "number" && Number.isFinite(result.metadata.normalizedDurationSeconds) ? result.metadata.normalizedDurationSeconds : requestedDurationSeconds);
	const supportedDurationSeconds = result.normalization?.durationSeconds?.supportedValues ?? (Array.isArray(result.metadata?.supportedDurationSeconds) ? result.metadata.supportedDurationSeconds.filter((entry) => typeof entry === "number" && Number.isFinite(entry)) : void 0);
	const normalizedSize = result.normalization?.size?.applied ?? (typeof result.metadata?.normalizedSize === "string" && result.metadata.normalizedSize.trim() ? result.metadata.normalizedSize : void 0);
	const normalizedAspectRatio = result.normalization?.aspectRatio?.applied ?? (typeof result.metadata?.normalizedAspectRatio === "string" && result.metadata.normalizedAspectRatio.trim() ? result.metadata.normalizedAspectRatio : void 0);
	const normalizedResolution = result.normalization?.resolution?.applied ?? (typeof result.metadata?.normalizedResolution === "string" && result.metadata.normalizedResolution.trim() ? result.metadata.normalizedResolution : void 0);
	const sizeTranslatedToAspectRatio = result.normalization?.aspectRatio?.derivedFrom === "size" || !normalizedSize && typeof result.metadata?.requestedSize === "string" && result.metadata.requestedSize === params.size && Boolean(normalizedAspectRatio);
	const allMediaUrls = [...savedVideos.map((video) => video.path), ...urlOnlyVideos.map((video) => video.url)];
	const attachments = [...savedVideos.map((video) => ({
		type: "video",
		path: video.path,
		mimeType: video.contentType,
		name: video.id
	})), ...urlOnlyVideos.map((video) => ({
		type: "video",
		url: video.url,
		mimeType: video.mimeType,
		name: video.fileName
	}))];
	const lines = [
		`Generated ${totalCount} video${totalCount === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
		...warning ? [`Warning: ${warning}`] : [],
		typeof requestedDurationSeconds === "number" && typeof normalizedDurationSeconds === "number" && requestedDurationSeconds !== normalizedDurationSeconds ? `Duration normalized: requested ${requestedDurationSeconds}s; used ${normalizedDurationSeconds}s.` : null,
		...formatGeneratedAttachmentLines(attachments)
	].filter((entry) => Boolean(entry));
	return {
		provider: result.provider,
		model: result.model,
		savedPaths: savedVideos.map((video) => video.path),
		urlOnlyUrls: urlOnlyVideos.map((video) => video.url),
		count: totalCount,
		paths: savedVideos.map((video) => video.path),
		mediaUrls: allMediaUrls,
		attachments,
		contentText: lines.join("\n"),
		wakeResult: lines.join("\n"),
		details: {
			provider: result.provider,
			model: result.model,
			count: totalCount,
			media: {
				mediaUrls: allMediaUrls,
				attachments
			},
			attachments,
			paths: allMediaUrls,
			...buildTaskRunDetails(params.taskHandle),
			...buildMediaReferenceDetails({
				entries: params.loadedReferenceImages,
				singleKey: "image",
				pluralKey: "images",
				getResolvedInput: (entry) => entry.resolvedInput
			}),
			...buildMediaReferenceDetails({
				entries: params.loadedReferenceVideos,
				singleKey: "video",
				pluralKey: "videos",
				getResolvedInput: (entry) => entry.resolvedInput,
				singleRewriteKey: "videoRewrittenFrom"
			}),
			...normalizedSize || !ignoredOverrideKeys.has("size") && params.size && !sizeTranslatedToAspectRatio ? { size: normalizedSize ?? params.size } : {},
			...normalizedAspectRatio || !ignoredOverrideKeys.has("aspectRatio") && params.aspectRatio ? { aspectRatio: normalizedAspectRatio ?? params.aspectRatio } : {},
			...normalizedResolution || !ignoredOverrideKeys.has("resolution") && params.resolution ? { resolution: normalizedResolution ?? params.resolution } : {},
			...typeof normalizedDurationSeconds === "number" ? { durationSeconds: normalizedDurationSeconds } : {},
			...typeof requestedDurationSeconds === "number" && typeof normalizedDurationSeconds === "number" && requestedDurationSeconds !== normalizedDurationSeconds ? { requestedDurationSeconds } : {},
			...supportedDurationSeconds && supportedDurationSeconds.length > 0 ? { supportedDurationSeconds } : {},
			...!ignoredOverrideKeys.has("audio") && typeof params.audio === "boolean" ? { audio: params.audio } : {},
			...!ignoredOverrideKeys.has("watermark") && typeof params.watermark === "boolean" ? { watermark: params.watermark } : {},
			...params.filename ? { filename: params.filename } : {},
			...params.timeoutMs !== void 0 ? { timeoutMs: params.timeoutMs } : {},
			attempts: result.attempts,
			...result.normalization ? { normalization: result.normalization } : {},
			metadata: result.metadata,
			...warning ? { warning } : {},
			...ignoredOverrides.length > 0 ? { ignoredOverrides } : {}
		}
	};
}
function createVideoGenerateTool(options) {
	const cfg = options?.config ?? getRuntimeConfig();
	if (!hasGenerationToolAvailability({
		cfg,
		agentDir: options?.agentDir,
		workspaceDir: options?.workspaceDir,
		authStore: options?.authProfileStore,
		modelConfig: cfg.agents?.defaults?.videoGenerationModel,
		providerKey: "videoGenerationProviders"
	})) return null;
	const sandboxConfig = options?.sandbox ? {
		root: options.sandbox.root,
		bridge: options.sandbox.bridge,
		workspaceOnly: options.fsPolicy?.workspaceOnly === true
	} : null;
	const scheduleBackgroundWork = options?.scheduleBackgroundWork ?? defaultScheduleVideoGenerateBackgroundWork;
	return {
		label: "Video Generation",
		name: "video_generate",
		displaySummary: "Generate videos",
		description: "Create videos. Session chats: background task; do not call video_generate again for same request; wait completion, then send attachments via message tool. \"status\" checks active task. Duration may round to provider-supported value.",
		parameters: createVideoGenerateToolSchema({ includeAudioReferences: shouldExposeVideoReferenceAudioParams({
			cfg,
			agentDir: options?.agentDir,
			authStore: options?.authProfileStore,
			workspaceDir: options?.workspaceDir
		}) }),
		execute: async (_toolCallId, rawArgs) => {
			const args = rawArgs;
			const action = resolveAction(args);
			if (action === "list") return createVideoGenerateListActionResult(cfg, {
				workspaceDir: options?.workspaceDir,
				agentDir: options?.agentDir,
				authStore: options?.authProfileStore
			});
			if (action === "status") return createVideoGenerateStatusActionResult(options?.agentSessionKey);
			const videoGenerationModelConfig = resolveVideoGenerationModelConfigForTool({
				cfg,
				workspaceDir: options?.workspaceDir,
				agentDir: options?.agentDir,
				authStore: options?.authProfileStore
			});
			if (!videoGenerationModelConfig) throw new ToolInputError("No video-generation model configured.");
			const explicitModelConfig = hasExplicitVideoGenerationModelConfig(cfg);
			const effectiveCfg = applyVideoGenerationModelConfigDefaults(cfg, videoGenerationModelConfig) ?? cfg;
			const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
			const prompt = readStringParam$1(args, "prompt", { required: true });
			const activeDuplicateGuardResult = createVideoGenerateDuplicateGuardResult(options?.agentSessionKey);
			if (activeDuplicateGuardResult) return activeDuplicateGuardResult;
			const model = readStringParam$1(args, "model");
			const filename = readStringParam$1(args, "filename");
			const size = readStringParam$1(args, "size");
			const aspectRatio = normalizeAspectRatio(readStringParam$1(args, "aspectRatio"));
			const resolution = normalizeResolution(readStringParam$1(args, "resolution"));
			const durationSeconds = readNumberParam(args, "durationSeconds", {
				integer: true,
				strict: true
			});
			const audio = readBooleanToolParam(args, "audio");
			const watermark = readBooleanToolParam(args, "watermark");
			const timeoutMs = readGenerationTimeoutMs(args) ?? videoGenerationModelConfig.timeoutMs;
			const providerOptionsRaw = readSnakeCaseParamRaw(args, "providerOptions");
			if (providerOptionsRaw != null && (typeof providerOptionsRaw !== "object" || Array.isArray(providerOptionsRaw))) throw new ToolInputError("providerOptions must be a JSON object keyed by provider-specific option name.");
			const providerOptions = providerOptionsRaw != null ? providerOptionsRaw : void 0;
			const imageInputs = normalizeReferenceInputs({
				args,
				singularKey: "image",
				pluralKey: "images",
				maxCount: MAX_INPUT_IMAGES
			});
			const imageRoles = parseRoleArray({
				raw: readSnakeCaseParamRaw(args, "imageRoles"),
				kind: "imageRoles",
				assetCount: imageInputs.length
			});
			const videoInputs = normalizeReferenceInputs({
				args,
				singularKey: "video",
				pluralKey: "videos",
				maxCount: MAX_INPUT_VIDEOS
			});
			const videoRoles = parseRoleArray({
				raw: readSnakeCaseParamRaw(args, "videoRoles"),
				kind: "videoRoles",
				assetCount: videoInputs.length
			});
			const audioInputs = normalizeReferenceInputs({
				args,
				singularKey: "audioRef",
				pluralKey: "audioRefs",
				maxCount: MAX_INPUT_AUDIOS
			});
			const audioRoles = parseRoleArray({
				raw: readSnakeCaseParamRaw(args, "audioRoles"),
				kind: "audioRoles",
				assetCount: audioInputs.length
			});
			const selectedProvider = resolveSelectedVideoGenerationProvider({
				config: effectiveCfg,
				videoGenerationModelConfig,
				modelOverride: model
			});
			const explicitModelRef = parseVideoGenerationModelRef(model);
			const primaryModelRef = parseVideoGenerationModelRef(videoGenerationModelConfig.primary);
			const requestKey = buildMediaGenerationRequestKey({
				tool: "video_generate",
				prompt,
				provider: selectedProvider?.id ?? explicitModelRef?.provider ?? primaryModelRef?.provider,
				model: model !== void 0 ? explicitModelRef?.model ?? model : primaryModelRef?.model ?? videoGenerationModelConfig.primary ?? selectedProvider?.defaultModel,
				size,
				aspectRatio,
				resolution,
				durationSeconds,
				audio,
				watermark,
				filename,
				providerOptions,
				imageInputs,
				imageRoles,
				videoInputs,
				videoRoles,
				audioInputs,
				audioRoles
			});
			const duplicateGuardResult = createVideoGenerateDuplicateGuardResult(options?.agentSessionKey, { requestKey });
			if (duplicateGuardResult) return duplicateGuardResult;
			const loadedReferenceImages = await loadReferenceAssets({
				inputs: imageInputs,
				expectedKind: "image",
				workspaceDir: options?.workspaceDir,
				sandboxConfig,
				ssrfPolicy: remoteMediaSsrfPolicy
			});
			for (let i = 0; i < loadedReferenceImages.length; i++) {
				const role = imageRoles[i];
				if (role) loadedReferenceImages[i].sourceAsset.role = role;
			}
			const loadedReferenceVideos = await loadReferenceAssets({
				inputs: videoInputs,
				expectedKind: "video",
				workspaceDir: options?.workspaceDir,
				sandboxConfig,
				ssrfPolicy: remoteMediaSsrfPolicy
			});
			for (let i = 0; i < loadedReferenceVideos.length; i++) {
				const role = videoRoles[i];
				if (role) loadedReferenceVideos[i].sourceAsset.role = role;
			}
			const loadedReferenceAudios = await loadReferenceAssets({
				inputs: audioInputs,
				expectedKind: "audio",
				workspaceDir: options?.workspaceDir,
				sandboxConfig,
				ssrfPolicy: remoteMediaSsrfPolicy
			});
			for (let i = 0; i < loadedReferenceAudios.length; i++) {
				const role = audioRoles[i];
				if (role) loadedReferenceAudios[i].sourceAsset.role = role;
			}
			validateVideoGenerationCapabilities({
				provider: selectedProvider,
				model: parseVideoGenerationModelRef(model)?.model ?? model ?? selectedProvider?.defaultModel,
				inputImageCount: loadedReferenceImages.length,
				inputVideoCount: loadedReferenceVideos.length,
				inputAudioCount: loadedReferenceAudios.length,
				size,
				aspectRatio,
				resolution,
				durationSeconds,
				audio,
				watermark
			});
			const taskHandle = createVideoGenerationTaskRun({
				sessionKey: options?.agentSessionKey,
				requesterOrigin: options?.requesterOrigin,
				prompt,
				providerId: selectedProvider?.id
			});
			if (Boolean(taskHandle && options?.agentSessionKey?.trim()) && taskHandle) {
				recordRecentMediaGenerationTaskStartForSession({
					sessionKey: options?.agentSessionKey,
					taskKind: "video_generation",
					sourcePrefix: "video_generate",
					taskId: taskHandle.taskId,
					runId: taskHandle.runId,
					taskLabel: prompt,
					requestKey,
					providerId: selectedProvider?.id,
					progressSummary: "Generating video"
				});
				scheduleMediaGenerationTaskCompletion({
					lifecycle: videoGenerationTaskLifecycle,
					handle: taskHandle,
					scheduleBackgroundWork,
					progressSummary: "Generating video",
					config: effectiveCfg,
					toolName: "Video generation",
					onWakeFailure: (message, meta) => log.warn(message, meta),
					run: () => executeVideoGenerationJob({
						effectiveCfg,
						prompt,
						agentDir: options?.agentDir,
						model,
						size,
						aspectRatio,
						resolution,
						durationSeconds,
						audio,
						watermark,
						filename,
						loadedReferenceImages,
						loadedReferenceVideos,
						loadedReferenceAudios,
						taskHandle,
						providerOptions,
						autoProviderFallback: explicitModelConfig ? false : void 0,
						timeoutMs
					})
				});
				await notifyMediaGenerationAsyncTaskStarted({
					callback: options?.onAsyncTaskStarted,
					message: "Video generation started; wait for the generated video completion event.",
					toolName: "video_generate",
					handle: taskHandle,
					onFailure: (message, meta) => log.warn(message, meta)
				});
				return buildMediaGenerationStartedToolResult({
					toolName: "video_generate",
					generationLabel: "video",
					completionLabel: "video",
					taskHandle,
					detailExtras: {
						...buildMediaReferenceDetails({
							entries: loadedReferenceImages,
							singleKey: "image",
							pluralKey: "images",
							getResolvedInput: (entry) => entry.resolvedInput
						}),
						...buildMediaReferenceDetails({
							entries: loadedReferenceVideos,
							singleKey: "video",
							pluralKey: "videos",
							getResolvedInput: (entry) => entry.resolvedInput,
							singleRewriteKey: "videoRewrittenFrom"
						}),
						...model ? { model } : {},
						...size ? { size } : {},
						...aspectRatio ? { aspectRatio } : {},
						...resolution ? { resolution } : {},
						...typeof durationSeconds === "number" ? { durationSeconds } : {},
						...typeof audio === "boolean" ? { audio } : {},
						...typeof watermark === "boolean" ? { watermark } : {},
						...filename ? { filename } : {},
						...timeoutMs !== void 0 ? { timeoutMs } : {}
					}
				});
			}
			try {
				const executed = await executeVideoGenerationJob({
					effectiveCfg,
					prompt,
					agentDir: options?.agentDir,
					model,
					size,
					aspectRatio,
					resolution,
					durationSeconds,
					audio,
					watermark,
					filename,
					loadedReferenceImages,
					loadedReferenceVideos,
					loadedReferenceAudios,
					taskHandle,
					providerOptions,
					autoProviderFallback: explicitModelConfig ? false : void 0,
					timeoutMs
				});
				completeVideoGenerationTaskRun({
					handle: taskHandle,
					provider: executed.provider,
					model: executed.model,
					count: executed.count,
					paths: executed.savedPaths
				});
				return {
					content: [{
						type: "text",
						text: executed.contentText
					}],
					details: executed.details
				};
			} catch (error) {
				failVideoGenerationTaskRun({
					handle: taskHandle,
					error
				});
				throw error;
			}
		}
	};
}
//#endregion
//#region src/plugins/web-content-extractor-public-artifacts.ts
const WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES = ["web-content-extractor.js", "web-content-extractor-api.js"];
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isWebContentExtractorPlugin(value) {
	return isRecord(value) && typeof value.id === "string" && typeof value.label === "string" && (value.autoDetectOrder === void 0 || typeof value.autoDetectOrder === "number") && typeof value.extract === "function";
}
function tryLoadBundledPublicArtifactModule(params) {
	for (const artifactBasename of WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES) try {
		return loadBundledPluginPublicArtifactModuleSync({
			dirName: params.dirName,
			artifactBasename
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Unable to resolve bundled plugin public surface ")) continue;
		throw error;
	}
	return null;
}
function collectExtractorFactories(mod) {
	const extractors = [];
	for (const [name, exported] of Object.entries(mod).toSorted(([left], [right]) => left.localeCompare(right))) {
		if (typeof exported !== "function" || exported.length !== 0 || !name.startsWith("create") || !name.endsWith("WebContentExtractor")) continue;
		const candidate = exported();
		if (isWebContentExtractorPlugin(candidate)) extractors.push(candidate);
	}
	return extractors;
}
function loadBundledWebContentExtractorEntriesFromDir(params) {
	const mod = tryLoadBundledPublicArtifactModule({ dirName: params.dirName });
	if (!mod) return null;
	const extractors = collectExtractorFactories(mod);
	if (extractors.length === 0) return null;
	return extractors.map((extractor) => Object.assign({}, extractor, { pluginId: params.pluginId }));
}
//#endregion
//#region src/plugins/web-content-extractors.runtime.ts
function compareExtractors(left, right) {
	const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
	const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
	if (leftOrder !== rightOrder) return leftOrder - rightOrder;
	return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}
function resolvePluginWebContentExtractors(params) {
	const extractors = [];
	for (const plugin of resolveEnabledBundledManifestContractPlugins({
		config: params?.config,
		workspaceDir: params?.workspaceDir,
		env: params?.env,
		onlyPluginIds: params?.onlyPluginIds,
		contract: "webContentExtractors",
		compatMode: {
			allowlist: true,
			enablement: "always",
			vitest: true
		}
	})) {
		const loaded = loadBundledWebContentExtractorEntriesFromDir({
			dirName: plugin.id,
			pluginId: plugin.id
		});
		if (loaded) extractors.push(...loaded);
	}
	return extractors.toSorted(compareExtractors);
}
//#endregion
//#region src/web-fetch/content-extractors.runtime.ts
const webContentExtractorLoader = createConfigScopedPromiseLoader((config) => resolvePluginWebContentExtractors(config ? { config } : void 0));
async function extractReadableContent(params) {
	let extractors;
	try {
		extractors = await webContentExtractorLoader.load(params.config);
	} catch {
		return null;
	}
	for (const extractor of extractors) {
		let result;
		try {
			result = await extractor.extract({
				html: params.html,
				url: params.url,
				extractMode: params.extractMode
			});
		} catch {
			continue;
		}
		if (result?.text) return {
			...result,
			extractor: extractor.id
		};
	}
	return null;
}
//#endregion
//#region src/agents/tools/web-tool-runtime-context.ts
function resolveConfiguredWebProviderId(config, kind) {
	const provider = config?.tools?.web?.[kind]?.provider;
	return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}
function resolveRuntimeWebProviderId(metadata) {
	return metadata?.selectedProvider ?? metadata?.providerConfigured ?? "";
}
function resolveWebProviderContract(kind) {
	return kind === "fetch" ? "webFetchProviders" : "webSearchProviders";
}
function shouldPreferRuntimeProviders(params) {
	if (!params.providerSelectionId) return true;
	return !resolveManifestContractOwnerPluginId({
		contract: resolveWebProviderContract(params.kind),
		value: params.providerSelectionId,
		...params.kind === "fetch" ? { origin: "bundled" } : {},
		config: params.config
	});
}
function resolveWebToolRuntimeContext(params) {
	const runtimeMetadata = (params.lateBindRuntimeConfig === true ? getActiveRuntimeWebToolsMetadata() : null)?.[params.kind] ?? params.capturedRuntimeMetadata;
	const config = params.lateBindRuntimeConfig === true ? getActiveSecretsRuntimeSnapshot()?.config ?? params.capturedConfig : params.capturedConfig;
	const providerSelectionId = resolveRuntimeWebProviderId(runtimeMetadata) || resolveConfiguredWebProviderId(config, params.kind);
	return {
		config,
		preferRuntimeProviders: shouldPreferRuntimeProviders({
			config,
			kind: params.kind,
			providerSelectionId
		}),
		runtimeMetadata
	};
}
function resolveWebSearchToolRuntimeContext(params) {
	const resolved = resolveWebToolRuntimeContext({
		capturedConfig: params.config,
		capturedRuntimeMetadata: params.runtimeWebSearch,
		kind: "search",
		lateBindRuntimeConfig: params.lateBindRuntimeConfig
	});
	return {
		config: resolved.config,
		preferRuntimeProviders: resolved.preferRuntimeProviders,
		runtimeMetadata: resolved.runtimeMetadata,
		runtimeWebSearch: resolved.runtimeMetadata
	};
}
function resolveWebFetchToolRuntimeContext(params) {
	const resolved = resolveWebToolRuntimeContext({
		capturedConfig: params.config,
		capturedRuntimeMetadata: params.runtimeWebFetch,
		kind: "fetch",
		lateBindRuntimeConfig: params.lateBindRuntimeConfig
	});
	return {
		config: resolved.config,
		preferRuntimeProviders: resolved.preferRuntimeProviders,
		runtimeMetadata: resolved.runtimeMetadata,
		runtimeWebFetch: resolved.runtimeMetadata
	};
}
//#endregion
//#region src/agents/tools/web-fetch.ts
const EXTRACT_MODES = ["markdown", "text"];
const DEFAULT_FETCH_MAX_CHARS = 2e4;
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 75e4;
const FETCH_MAX_RESPONSE_BYTES_MIN = 32e3;
const FETCH_MAX_RESPONSE_BYTES_MAX = 1e7;
const DEFAULT_FETCH_MAX_REDIRECTS = 3;
const DEFAULT_ERROR_MAX_CHARS = 4e3;
const DEFAULT_ERROR_MAX_BYTES = 64e3;
const DEFAULT_FETCH_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FETCH_CACHE = /* @__PURE__ */ new Map();
const WebFetchSchema = Type.Object({
	url: Type.String({ description: "HTTP(S) URL." }),
	extractMode: Type.Optional(stringEnum(EXTRACT_MODES, {
		description: "Extract as markdown/text.",
		default: "markdown"
	})),
	maxChars: Type.Optional(Type.Number({
		description: "Max chars returned; truncates.",
		minimum: 100
	}))
});
const webFetchRuntimeLoader = createLazyImportLoader(() => import("./web-fetch/runtime.js"));
const webGuardedFetchLoader = createLazyImportLoader(() => import("./web-guarded-fetch-CL_R462D.js"));
async function loadWebFetchRuntime() {
	return await webFetchRuntimeLoader.load();
}
async function loadWebGuardedFetch() {
	return (await webGuardedFetchLoader.load()).fetchWithWebToolsNetworkGuard;
}
function resolveFetchConfig(cfg) {
	return resolveWebProviderConfig(cfg, "fetch");
}
function resolveFetchEnabled(params) {
	if (typeof params.fetch?.enabled === "boolean") return params.fetch.enabled;
	return true;
}
function resolveFetchReadabilityEnabled(fetch) {
	if (typeof fetch?.readability === "boolean") return fetch.readability;
	return true;
}
function resolveFetchUseTrustedEnvProxy(fetch) {
	return fetch?.useTrustedEnvProxy === true;
}
function resolveFetchMaxCharsCap(fetch) {
	const raw = fetch && "maxCharsCap" in fetch && typeof fetch.maxCharsCap === "number" ? fetch.maxCharsCap : void 0;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_FETCH_MAX_CHARS;
	return Math.max(100, Math.floor(raw));
}
function resolveFetchMaxResponseBytes(fetch) {
	const raw = fetch && "maxResponseBytes" in fetch && typeof fetch.maxResponseBytes === "number" ? fetch.maxResponseBytes : void 0;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_FETCH_MAX_RESPONSE_BYTES;
	return Math.min(FETCH_MAX_RESPONSE_BYTES_MAX, Math.max(FETCH_MAX_RESPONSE_BYTES_MIN, Math.floor(raw)));
}
function resolveMaxChars(value, fallback, cap) {
	return Math.min(Math.max(100, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : fallback)), cap);
}
function resolveMaxRedirects(value, fallback) {
	return Math.max(0, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : fallback));
}
function looksLikeHtml(value) {
	const trimmed = value.trimStart();
	if (!trimmed) return false;
	const head = normalizeLowercaseStringOrEmpty(trimmed.slice(0, 256));
	return head.startsWith("<!doctype html") || head.startsWith("<html");
}
function formatWebFetchErrorDetail(params) {
	const { detail, contentType, maxChars } = params;
	if (!detail) return "";
	let text = detail;
	if (normalizeOptionalLowercaseString(contentType)?.includes("text/html") || looksLikeHtml(detail)) {
		const rendered = htmlToMarkdown(detail);
		text = markdownToText(rendered.title ? `${rendered.title}\n${rendered.text}` : rendered.text);
	}
	return truncateText$1(text.trim(), maxChars).text;
}
function redactUrlForDebugLog(rawUrl) {
	try {
		const parsed = new URL(rawUrl);
		return parsed.pathname && parsed.pathname !== "/" ? `${parsed.origin}/...` : parsed.origin;
	} catch {
		return "[invalid-url]";
	}
}
const WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD = wrapWebContent("", "web_fetch").length;
const WEB_FETCH_WRAPPER_NO_WARNING_OVERHEAD = wrapExternalContent("", {
	source: "web_fetch",
	includeWarning: false
}).length;
function wrapWebFetchContent(value, maxChars) {
	if (maxChars <= 0) return {
		text: "",
		truncated: true,
		rawLength: 0,
		wrappedLength: 0
	};
	const includeWarning = maxChars >= WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD;
	const wrapperOverhead = includeWarning ? WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD : WEB_FETCH_WRAPPER_NO_WARNING_OVERHEAD;
	if (wrapperOverhead > maxChars) {
		const truncatedWrapper = truncateText$1(includeWarning ? wrapWebContent("", "web_fetch") : wrapExternalContent("", {
			source: "web_fetch",
			includeWarning: false
		}), maxChars);
		return {
			text: truncatedWrapper.text,
			truncated: true,
			rawLength: 0,
			wrappedLength: truncatedWrapper.text.length
		};
	}
	const maxInner = Math.max(0, maxChars - wrapperOverhead);
	let truncated = truncateText$1(value, maxInner);
	let wrappedText = includeWarning ? wrapWebContent(truncated.text, "web_fetch") : wrapExternalContent(truncated.text, {
		source: "web_fetch",
		includeWarning: false
	});
	if (wrappedText.length > maxChars) {
		const excess = wrappedText.length - maxChars;
		truncated = truncateText$1(value, Math.max(0, maxInner - excess));
		wrappedText = includeWarning ? wrapWebContent(truncated.text, "web_fetch") : wrapExternalContent(truncated.text, {
			source: "web_fetch",
			includeWarning: false
		});
	}
	return {
		text: wrappedText,
		truncated: truncated.truncated,
		rawLength: truncated.text.length,
		wrappedLength: wrappedText.length
	};
}
function wrapWebFetchField(value) {
	if (!value) return value;
	return wrapExternalContent(value, {
		source: "web_fetch",
		includeWarning: false
	});
}
function normalizeContentType(value) {
	if (!value) return;
	const [raw] = value.split(";");
	return raw?.trim() || void 0;
}
function normalizeProviderFinalUrl(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	for (const char of trimmed) {
		const code = char.charCodeAt(0);
		if (code <= 32 || code === 127) return;
	}
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		return url.toString();
	} catch {
		return;
	}
}
function normalizeProviderWebFetchPayload(params) {
	const payload = isRecord$2(params.payload) ? params.payload : {};
	const wrapped = wrapWebFetchContent(typeof payload.text === "string" ? payload.text : "", params.maxChars);
	const url = params.requestedUrl;
	const finalUrl = normalizeProviderFinalUrl(payload.finalUrl) ?? url;
	const status = typeof payload.status === "number" && Number.isFinite(payload.status) ? Math.max(0, Math.floor(payload.status)) : 200;
	const contentType = typeof payload.contentType === "string" ? normalizeContentType(payload.contentType) : void 0;
	const title = typeof payload.title === "string" ? wrapWebFetchField(payload.title) : void 0;
	const warning = typeof payload.warning === "string" ? wrapWebFetchField(payload.warning) : void 0;
	const extractor = typeof payload.extractor === "string" && payload.extractor.trim() ? payload.extractor : params.providerId;
	return {
		url,
		finalUrl,
		...contentType ? { contentType } : {},
		status,
		...title ? { title } : {},
		extractMode: params.extractMode,
		extractor,
		externalContent: {
			untrusted: true,
			source: "web_fetch",
			wrapped: true,
			provider: params.providerId
		},
		truncated: wrapped.truncated,
		length: wrapped.wrappedLength,
		rawLength: wrapped.rawLength,
		wrappedLength: wrapped.wrappedLength,
		fetchedAt: typeof payload.fetchedAt === "string" && payload.fetchedAt ? payload.fetchedAt : (/* @__PURE__ */ new Date()).toISOString(),
		tookMs: typeof payload.tookMs === "number" && Number.isFinite(payload.tookMs) ? Math.max(0, Math.floor(payload.tookMs)) : params.tookMs,
		text: wrapped.text,
		...warning ? { warning } : {}
	};
}
async function maybeFetchProviderWebFetchPayload(params) {
	const providerFallback = await params.resolveProviderFallback();
	if (!providerFallback) return null;
	const rawPayload = await providerFallback.definition.execute({
		url: params.urlToFetch,
		extractMode: params.extractMode,
		maxChars: params.maxChars
	});
	const payload = normalizeProviderWebFetchPayload({
		providerId: providerFallback.provider.id,
		payload: rawPayload,
		requestedUrl: params.url,
		extractMode: params.extractMode,
		maxChars: params.maxChars,
		tookMs: params.tookMs
	});
	writeCache(FETCH_CACHE, params.cacheKey, payload, params.cacheTtlMs);
	return payload;
}
async function runWebFetch(params) {
	const allowRfc2544BenchmarkRange = params.ssrfPolicy?.allowRfc2544BenchmarkRange === true;
	const allowIpv6UniqueLocalRange = params.ssrfPolicy?.allowIpv6UniqueLocalRange === true;
	const useTrustedEnvProxy = params.useTrustedEnvProxy;
	const ssrfPolicy = allowRfc2544BenchmarkRange || allowIpv6UniqueLocalRange ? {
		...allowRfc2544BenchmarkRange ? { allowRfc2544BenchmarkRange } : {},
		...allowIpv6UniqueLocalRange ? { allowIpv6UniqueLocalRange } : {}
	} : void 0;
	const cacheKey = normalizeCacheKey(`fetch:${params.url}:${params.extractMode}:${params.maxChars}${params.providerCacheKey ? `:provider:${params.providerCacheKey}` : ""}${allowRfc2544BenchmarkRange ? ":allow-rfc2544" : ""}${allowIpv6UniqueLocalRange ? ":allow-ipv6-ula" : ""}${useTrustedEnvProxy ? ":trusted-env-proxy" : ""}`);
	const cached = readCache(FETCH_CACHE, cacheKey);
	if (cached) return {
		...cached.value,
		cached: true
	};
	let parsedUrl;
	try {
		parsedUrl = new URL(params.url);
	} catch {
		throw new Error("Invalid URL: must be http or https");
	}
	if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Invalid URL: must be http or https");
	const start = Date.now();
	let res;
	let release = null;
	let finalUrl = params.url;
	try {
		const result = await (await loadWebGuardedFetch())({
			url: params.url,
			maxRedirects: params.maxRedirects,
			timeoutSeconds: params.timeoutSeconds,
			lookupFn: params.lookupFn,
			useEnvProxy: useTrustedEnvProxy,
			policy: ssrfPolicy,
			init: { headers: {
				Accept: "text/markdown, text/html;q=0.9, */*;q=0.1",
				"User-Agent": params.userAgent,
				"Accept-Language": "en-US,en;q=0.9"
			} }
		});
		res = result.response;
		finalUrl = result.finalUrl;
		release = result.release;
		const markdownTokens = res.headers.get("x-markdown-tokens");
		if (markdownTokens) logDebug(`[web-fetch] x-markdown-tokens: ${markdownTokens} (${redactUrlForDebugLog(finalUrl)})`);
	} catch (error) {
		if (error instanceof SsrFBlockedError) throw error;
		const payload = await maybeFetchProviderWebFetchPayload({
			...params,
			urlToFetch: finalUrl,
			cacheKey,
			tookMs: Date.now() - start
		});
		if (payload) return payload;
		throw error;
	}
	try {
		if (!res.ok) {
			const payload = await maybeFetchProviderWebFetchPayload({
				...params,
				urlToFetch: params.url,
				cacheKey,
				tookMs: Date.now() - start
			});
			if (payload) return payload;
			const rawDetail = (await readResponseText(res, { maxBytes: DEFAULT_ERROR_MAX_BYTES })).text;
			const wrappedDetail = wrapWebFetchContent(formatWebFetchErrorDetail({
				detail: rawDetail,
				contentType: res.headers.get("content-type"),
				maxChars: DEFAULT_ERROR_MAX_CHARS
			}) || res.statusText, DEFAULT_ERROR_MAX_CHARS);
			throw new Error(`Web fetch failed (${res.status}): ${wrappedDetail.text}`);
		}
		const contentType = res.headers.get("content-type") ?? "application/octet-stream";
		const normalizedContentType = normalizeContentType(contentType) ?? "application/octet-stream";
		const bodyResult = await readResponseText(res, { maxBytes: params.maxResponseBytes });
		const body = bodyResult.text;
		const responseTruncatedWarning = bodyResult.truncated ? `Response body truncated after ${params.maxResponseBytes} bytes.` : void 0;
		let title;
		let extractor = "raw";
		let text = body;
		if (contentType.includes("text/markdown")) {
			extractor = "cf-markdown";
			if (params.extractMode === "text") text = markdownToText(body);
		} else if (contentType.includes("text/html")) if (params.readabilityEnabled) {
			const readable = await extractReadableContent({
				html: body,
				url: finalUrl,
				extractMode: params.extractMode,
				config: params.config
			});
			if (readable?.text) {
				text = readable.text;
				title = readable.title;
				extractor = readable.extractor;
			} else {
				let payload = null;
				try {
					payload = await maybeFetchProviderWebFetchPayload({
						...params,
						urlToFetch: finalUrl,
						cacheKey,
						tookMs: Date.now() - start
					});
				} catch {
					payload = null;
				}
				if (payload) return payload;
				const basic = await extractBasicHtmlContent({
					html: body,
					extractMode: params.extractMode
				});
				if (basic?.text) {
					text = basic.text;
					title = basic.title;
					extractor = "raw-html";
				} else {
					const providerLabel = (await params.resolveProviderFallback())?.provider.label ?? "provider fallback";
					throw new Error(`Web fetch extraction failed: Readability, ${providerLabel}, and basic HTML cleanup returned no content.`);
				}
			}
		} else {
			const payload = await maybeFetchProviderWebFetchPayload({
				...params,
				urlToFetch: finalUrl,
				cacheKey,
				tookMs: Date.now() - start
			});
			if (payload) return payload;
			throw new Error("Web fetch extraction failed: Readability disabled and no fetch provider is available.");
		}
		else if (contentType.includes("application/json")) try {
			text = JSON.stringify(JSON.parse(body), null, 2);
			extractor = "json";
		} catch {
			text = body;
			extractor = "raw";
		}
		const wrapped = wrapWebFetchContent(text, params.maxChars);
		const wrappedTitle = title ? wrapWebFetchField(title) : void 0;
		const wrappedWarning = wrapWebFetchField(responseTruncatedWarning);
		const payload = {
			url: params.url,
			finalUrl,
			status: res.status,
			contentType: normalizedContentType,
			title: wrappedTitle,
			extractMode: params.extractMode,
			extractor,
			externalContent: {
				untrusted: true,
				source: "web_fetch",
				wrapped: true
			},
			truncated: wrapped.truncated,
			length: wrapped.wrappedLength,
			rawLength: wrapped.rawLength,
			wrappedLength: wrapped.wrappedLength,
			fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
			tookMs: Date.now() - start,
			text: wrapped.text,
			warning: wrappedWarning
		};
		writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
		return payload;
	} finally {
		if (release) await release();
	}
}
function createWebFetchTool(options) {
	if (!resolveFetchEnabled({
		fetch: resolveFetchConfig(options?.config),
		sandboxed: options?.sandboxed
	})) return null;
	return {
		label: "Web Fetch",
		name: "web_fetch",
		description: "Fetch URL and extract readable markdown/text. Lightweight page access; no browser automation.",
		parameters: WebFetchSchema,
		execute: async (_toolCallId, args) => {
			const { config, preferRuntimeProviders, runtimeWebFetch } = resolveWebFetchToolRuntimeContext({
				config: options?.config,
				lateBindRuntimeConfig: options?.lateBindRuntimeConfig,
				runtimeWebFetch: options?.runtimeWebFetch
			});
			const executionFetch = resolveFetchConfig(config);
			if (!resolveFetchEnabled({
				fetch: executionFetch,
				sandboxed: options?.sandboxed
			})) throw new Error("web_fetch is disabled.");
			const providerCacheKey = normalizeOptionalLowercaseString(runtimeWebFetch?.selectedProvider) ?? normalizeOptionalLowercaseString(runtimeWebFetch?.providerConfigured) ?? (executionFetch && "provider" in executionFetch ? normalizeOptionalLowercaseString(executionFetch.provider) : void 0);
			const readabilityEnabled = resolveFetchReadabilityEnabled(executionFetch);
			const userAgent = executionFetch && "userAgent" in executionFetch && typeof executionFetch.userAgent === "string" && executionFetch.userAgent || DEFAULT_FETCH_USER_AGENT;
			const maxResponseBytes = resolveFetchMaxResponseBytes(executionFetch);
			let providerFallbackResolved = false;
			let providerFallbackCache;
			const resolveProviderFallback = async () => {
				if (!providerFallbackResolved) {
					const { resolveWebFetchDefinition } = await loadWebFetchRuntime();
					providerFallbackCache = resolveWebFetchDefinition({
						config,
						sandboxed: options?.sandboxed,
						runtimeWebFetch,
						preferRuntimeProviders
					});
					providerFallbackResolved = true;
				}
				return providerFallbackCache;
			};
			const params = args;
			const url = readStringParam$1(params, "url", { required: true });
			const extractMode = readStringParam$1(params, "extractMode") === "text" ? "text" : "markdown";
			const maxChars = readNumberParam(params, "maxChars", { integer: true });
			const maxCharsCap = resolveFetchMaxCharsCap(executionFetch);
			return jsonResult(await runWebFetch({
				url,
				extractMode,
				maxChars: resolveMaxChars(maxChars ?? executionFetch?.maxChars, DEFAULT_FETCH_MAX_CHARS, maxCharsCap),
				maxResponseBytes,
				maxRedirects: resolveMaxRedirects(executionFetch?.maxRedirects, DEFAULT_FETCH_MAX_REDIRECTS),
				timeoutSeconds: resolveTimeoutSeconds(executionFetch?.timeoutSeconds, 30),
				cacheTtlMs: resolveCacheTtlMs(executionFetch?.cacheTtlMinutes, 15),
				userAgent,
				readabilityEnabled,
				config,
				useTrustedEnvProxy: resolveFetchUseTrustedEnvProxy(executionFetch),
				ssrfPolicy: executionFetch?.ssrfPolicy,
				...providerCacheKey ? { providerCacheKey } : {},
				lookupFn: options?.lookupFn,
				resolveProviderFallback
			}));
		}
	};
}
//#endregion
//#region src/agents/tools/web-search.ts
const WebSearchSchema = {
	type: "object",
	required: ["query"],
	properties: {
		query: {
			type: "string",
			description: "Search query."
		},
		count: {
			type: "number",
			description: "Result count.",
			minimum: 1,
			maximum: 10
		},
		country: {
			type: "string",
			description: "2-letter country code."
		},
		language: {
			type: "string",
			description: "ISO 639-1 language."
		},
		freshness: {
			type: "string",
			description: "Time filter: day/week/month/year."
		},
		date_after: {
			type: "string",
			description: "Published after YYYY-MM-DD."
		},
		date_before: {
			type: "string",
			description: "Published before YYYY-MM-DD."
		},
		search_lang: {
			type: "string",
			description: "Brave result language."
		},
		ui_lang: {
			type: "string",
			description: "Brave UI locale."
		},
		domain_filter: {
			type: "array",
			items: { type: "string" },
			description: "Perplexity domain filter."
		},
		max_tokens: {
			type: "number",
			description: "Perplexity total token budget.",
			minimum: 1,
			maximum: 1e6
		},
		max_tokens_per_page: {
			type: "number",
			description: "Perplexity tokens per page.",
			minimum: 1
		}
	}
};
function isWebSearchDisabled(config) {
	const search = config?.tools?.web?.search;
	return Boolean(search && typeof search === "object" && search.enabled === false);
}
function createWebSearchTool(options) {
	if (isWebSearchDisabled(options?.config)) return null;
	return {
		label: "Web Search",
		name: "web_search",
		description: "Search web for current info; returns normalized provider results.",
		parameters: WebSearchSchema,
		execute: async (_toolCallId, args, signal) => {
			const { config, preferRuntimeProviders, runtimeWebSearch } = resolveWebSearchToolRuntimeContext({
				config: options?.config,
				lateBindRuntimeConfig: options?.lateBindRuntimeConfig,
				runtimeWebSearch: options?.runtimeWebSearch
			});
			if (isWebSearchDisabled(config)) throw new Error("web_search is disabled.");
			const result = await runWebSearch({
				config,
				agentDir: options?.agentDir,
				sandboxed: options?.sandboxed,
				runtimeWebSearch,
				preferRuntimeProviders,
				args: asToolParamsRecord(args),
				signal
			});
			return jsonResult({
				...result.result,
				provider: result.provider
			});
		}
	};
}
let openClawToolsDeps = { callGateway };
function createOpenClawTools(options) {
	const resolvedConfig = options?.config ?? openClawToolsDeps.config;
	const runtimeSnapshot = getActiveSecretsRuntimeSnapshot();
	const availabilityConfig = selectApplicableRuntimeConfig({
		inputConfig: resolvedConfig,
		runtimeConfig: runtimeSnapshot?.config,
		runtimeSourceConfig: runtimeSnapshot?.sourceConfig
	});
	const { sessionAgentId } = resolveSessionAgentIds({
		sessionKey: options?.agentSessionKey,
		config: resolvedConfig,
		agentId: options?.requesterAgentIdOverride
	});
	const inferredWorkspaceDir = options?.workspaceDir || !resolvedConfig ? void 0 : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
	const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
	const spawnWorkspaceDir = resolveWorkspaceRoot(options?.spawnWorkspaceDir ?? options?.workspaceDir ?? inferredWorkspaceDir);
	options?.recordToolPrepStage?.("openclaw-tools:session-workspace");
	const deliveryContext = normalizeDeliveryContext({
		channel: options?.agentChannel,
		to: options?.agentTo,
		accountId: options?.agentAccountId,
		threadId: options?.agentThreadId
	});
	const runtimeWebTools = getActiveRuntimeWebToolsMetadata();
	const sandbox = options?.sandboxRoot && options?.sandboxFsBridge ? {
		root: options.sandboxRoot,
		bridge: options.sandboxFsBridge
	} : void 0;
	const optionalMediaTools = resolveOptionalMediaToolFactoryPlan({
		config: availabilityConfig ?? resolvedConfig,
		workspaceDir,
		authStore: options?.authProfileStore,
		toolAllowlist: options?.pluginToolAllowlist,
		toolDenylist: options?.pluginToolDenylist
	});
	const imageToolAgentDir = options?.agentDir;
	const imageTool = resolveImageToolFactoryAvailable({
		config: availabilityConfig ?? resolvedConfig,
		agentDir: imageToolAgentDir,
		workspaceDir,
		modelHasVision: options?.modelHasVision,
		authStore: options?.authProfileStore
	}) ? createImageTool({
		config: availabilityConfig ?? options?.config,
		agentDir: imageToolAgentDir,
		authProfileStore: options?.authProfileStore,
		workspaceDir,
		sandbox,
		fsPolicy: options?.fsPolicy,
		modelHasVision: options?.modelHasVision,
		deferAutoModelResolution: true
	}) : null;
	options?.recordToolPrepStage?.("openclaw-tools:image-tool");
	const imageGenerateTool = optionalMediaTools.imageGenerate ? createImageGenerateTool({
		config: options?.config,
		agentDir: options?.agentDir,
		authProfileStore: options?.authProfileStore,
		agentSessionKey: options?.agentSessionKey,
		requesterOrigin: deliveryContext ?? void 0,
		workspaceDir,
		sandbox,
		fsPolicy: options?.fsPolicy,
		onAsyncTaskStarted: options?.onAsyncTaskStarted
	}) : null;
	options?.recordToolPrepStage?.("openclaw-tools:image-generate-tool");
	const videoGenerateTool = optionalMediaTools.videoGenerate ? createVideoGenerateTool({
		config: options?.config,
		agentDir: options?.agentDir,
		authProfileStore: options?.authProfileStore,
		agentSessionKey: options?.agentSessionKey,
		requesterOrigin: deliveryContext ?? void 0,
		workspaceDir,
		sandbox,
		fsPolicy: options?.fsPolicy,
		onAsyncTaskStarted: options?.onAsyncTaskStarted
	}) : null;
	options?.recordToolPrepStage?.("openclaw-tools:video-generate-tool");
	const musicGenerateTool = optionalMediaTools.musicGenerate ? createMusicGenerateTool({
		config: options?.config,
		agentDir: options?.agentDir,
		authProfileStore: options?.authProfileStore,
		agentSessionKey: options?.agentSessionKey,
		requesterOrigin: deliveryContext ?? void 0,
		workspaceDir,
		sandbox,
		fsPolicy: options?.fsPolicy,
		onAsyncTaskStarted: options?.onAsyncTaskStarted
	}) : null;
	options?.recordToolPrepStage?.("openclaw-tools:music-generate-tool");
	const pdfTool = optionalMediaTools.pdf && options?.agentDir?.trim() ? createPdfTool({
		config: options?.config,
		agentDir: options.agentDir,
		authProfileStore: options?.authProfileStore,
		workspaceDir,
		sandbox,
		fsPolicy: options?.fsPolicy,
		deferAutoModelResolution: true
	}) : null;
	options?.recordToolPrepStage?.("openclaw-tools:pdf-tool");
	const webSearchTool = createWebSearchTool({
		config: options?.config,
		agentDir: options?.agentDir,
		sandboxed: options?.sandboxed,
		runtimeWebSearch: runtimeWebTools?.search,
		lateBindRuntimeConfig: true
	});
	options?.recordToolPrepStage?.("openclaw-tools:web-search-tool");
	const webFetchTool = createWebFetchTool({
		config: options?.config,
		sandboxed: options?.sandboxed,
		runtimeWebFetch: runtimeWebTools?.fetch,
		lateBindRuntimeConfig: true
	});
	options?.recordToolPrepStage?.("openclaw-tools:web-fetch-tool");
	const messageTool = options?.disableMessageTool ? null : createMessageTool({
		agentAccountId: options?.agentAccountId,
		agentSessionKey: options?.agentSessionKey,
		runId: options?.runId,
		agentId: sessionAgentId,
		sessionId: options?.sessionId,
		config: options?.config,
		currentChannelId: options?.currentChannelId,
		currentChannelProvider: options?.agentChannel,
		currentThreadTs: options?.currentThreadTs,
		agentThreadId: options?.agentThreadId,
		currentMessageId: options?.currentMessageId,
		replyToMode: options?.replyToMode,
		hasRepliedRef: options?.hasRepliedRef,
		sameChannelThreadRequired: options?.sameChannelThreadRequired,
		sandboxRoot: options?.sandboxRoot,
		requireExplicitTarget: options?.requireExplicitMessageTarget,
		sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
		inboundEventKind: options?.inboundEventKind,
		requesterSenderId: options?.requesterSenderId ?? void 0,
		senderIsOwner: options?.senderIsOwner
	});
	const heartbeatTool = options?.enableHeartbeatTool ? createHeartbeatResponseTool() : null;
	options?.recordToolPrepStage?.("openclaw-tools:message-tool");
	const nodesTool = applyNodesToolWorkspaceGuard(createNodesTool({
		agentSessionKey: options?.agentSessionKey,
		agentChannel: options?.agentChannel,
		agentAccountId: options?.agentAccountId,
		currentChannelId: options?.currentChannelId,
		currentThreadTs: options?.currentThreadTs,
		config: options?.config,
		modelHasVision: options?.modelHasVision,
		allowMediaInvokeCommands: options?.allowMediaInvokeCommands
	}), {
		fsPolicy: options?.fsPolicy,
		sandboxContainerWorkdir: options?.sandboxContainerWorkdir,
		sandboxRoot: options?.sandboxRoot,
		workspaceDir
	});
	options?.recordToolPrepStage?.("openclaw-tools:nodes-tool");
	const embedded = isEmbeddedMode();
	const explicitFactoryAllowlist = mergeFactoryPolicyList(resolvedConfig?.tools?.allow, resolvedConfig?.tools?.alsoAllow, options?.pluginToolAllowlist);
	const explicitFactoryDenylist = mergeFactoryPolicyList(resolvedConfig?.tools?.deny, options?.pluginToolDenylist);
	const messageExplicitlyAllowed = isToolExplicitlyAllowedByFactoryPolicy({
		toolName: "message",
		allowlist: explicitFactoryAllowlist,
		denylist: explicitFactoryDenylist
	});
	const includeMessageTool = !embedded || options?.sourceReplyDeliveryMode === "message_tool_only" || messageExplicitlyAllowed;
	const includeSubagentSpawnTool = !embedded || options?.allowGatewaySubagentBinding === true;
	const effectiveCallGateway = embedded ? createEmbeddedCallGateway() : openClawToolsDeps.callGateway;
	const includeUpdatePlanTool = isToolExplicitlyAllowedByFactoryPolicy({
		toolName: "update_plan",
		allowlist: explicitFactoryAllowlist,
		denylist: explicitFactoryDenylist
	}) || isUpdatePlanToolEnabledForOpenClawTools({
		config: resolvedConfig,
		agentSessionKey: options?.agentSessionKey,
		agentId: options?.requesterAgentIdOverride,
		modelProvider: options?.modelProvider,
		modelId: options?.modelId
	});
	const tools = [
		...embedded ? [] : [nodesTool, createCronTool({
			agentSessionKey: options?.agentSessionKey,
			currentDeliveryContext: {
				channel: options?.agentChannel,
				to: options?.currentChannelId ?? options?.agentTo,
				accountId: options?.agentAccountId,
				threadId: options?.currentThreadTs ?? options?.agentThreadId
			},
			...options?.cronSelfRemoveOnlyJobId ? { selfRemoveOnlyJobId: options.cronSelfRemoveOnlyJobId } : {}
		})],
		...messageTool && includeMessageTool ? [messageTool] : [],
		...collectPresentOpenClawTools([heartbeatTool]),
		createTtsTool({
			agentChannel: options?.agentChannel,
			config: resolvedConfig,
			agentId: sessionAgentId,
			agentAccountId: options?.agentAccountId
		}),
		...collectPresentOpenClawTools([
			imageGenerateTool,
			musicGenerateTool,
			videoGenerateTool
		]),
		...embedded ? [] : [createGatewayTool({
			agentSessionKey: options?.agentSessionKey,
			config: options?.config
		})],
		createAgentsListTool({
			agentSessionKey: options?.agentSessionKey,
			requesterAgentIdOverride: options?.requesterAgentIdOverride
		}),
		...includeUpdatePlanTool ? [createUpdatePlanTool()] : [],
		createSessionsListTool({
			agentSessionKey: options?.agentSessionKey,
			sandboxed: options?.sandboxed,
			config: resolvedConfig,
			callGateway: effectiveCallGateway
		}),
		createSessionsHistoryTool({
			agentSessionKey: options?.agentSessionKey,
			sandboxed: options?.sandboxed,
			config: resolvedConfig,
			callGateway: effectiveCallGateway
		}),
		...embedded ? [] : [createSessionsSendTool({
			agentSessionKey: options?.agentSessionKey,
			agentChannel: options?.agentChannel,
			sandboxed: options?.sandboxed,
			config: resolvedConfig,
			callGateway: openClawToolsDeps.callGateway
		})],
		...includeSubagentSpawnTool ? [createSessionsSpawnTool({
			agentSessionKey: options?.agentSessionKey,
			completionOwnerKey: options?.runSessionKey,
			agentChannel: options?.agentChannel,
			agentAccountId: options?.agentAccountId,
			agentTo: options?.agentTo,
			agentThreadId: options?.agentThreadId,
			agentGroupId: options?.agentGroupId,
			agentGroupChannel: options?.agentGroupChannel,
			agentGroupSpace: options?.agentGroupSpace,
			agentMemberRoleIds: options?.agentMemberRoleIds,
			sandboxed: options?.sandboxed,
			config: resolvedConfig,
			requesterAgentIdOverride: options?.requesterAgentIdOverride,
			workspaceDir: spawnWorkspaceDir,
			inheritedToolAllowlist: options?.inheritedToolAllowlist,
			inheritedToolDenylist: options?.inheritedToolDenylist
		})] : [],
		createSessionsYieldTool({
			sessionId: options?.sessionId,
			onYield: options?.onYield
		}),
		createSubagentsTool({ agentSessionKey: options?.agentSessionKey }),
		createSessionStatusTool({
			agentSessionKey: options?.agentSessionKey,
			runSessionKey: options?.runSessionKey,
			config: resolvedConfig,
			sandboxed: options?.sandboxed,
			activeModelProvider: options?.modelProvider,
			activeModelId: options?.modelId
		}),
		...collectPresentOpenClawTools([
			webSearchTool,
			webFetchTool,
			imageTool,
			pdfTool
		])
	];
	options?.recordToolPrepStage?.("openclaw-tools:core-tool-list");
	let allTools = tools;
	if (!options?.disablePluginTools) {
		const existingToolNames = /* @__PURE__ */ new Set();
		for (const tool of tools) existingToolNames.add(tool.name);
		allTools = [...tools, ...resolveOpenClawPluginToolsForOptions({
			options,
			resolvedConfig,
			existingToolNames
		})];
		options?.recordToolPrepStage?.("openclaw-tools:plugin-tools");
	}
	if (options?.wrapBeforeToolCallHook === false) return allTools;
	const hookAgentId = options?.requesterAgentIdOverride ?? sessionAgentId;
	const hookContext = {
		...hookAgentId ? { agentId: hookAgentId } : {},
		...resolvedConfig ? { config: resolvedConfig } : {},
		...options?.agentSessionKey ? { sessionKey: options.agentSessionKey } : {},
		...options?.sessionId ? { sessionId: options.sessionId } : {},
		...options?.currentChannelId ? { channelId: options.currentChannelId } : {},
		loopDetection: resolveToolLoopDetectionConfig({
			cfg: resolvedConfig,
			agentId: hookAgentId
		}),
		...options?.beforeToolCallHookContext
	};
	options?.recordToolPrepStage?.("openclaw-tools:tool-hooks");
	return allTools.map((tool) => isToolWrappedWithBeforeToolCallHook(tool) ? tool : wrapToolWithBeforeToolCallHook(tool, hookContext));
}
//#endregion
export { isParentOwnedBackgroundAcpSession as A, sniffMimeFromBase64 as C, stripProviderPrefix as D, isStrictAgenticSupportedProviderModel as E, isEmbeddedMode as O, wrapToolWorkspaceRootGuardWithOptions as S, isStrictAgenticExecutionContractActive as T, createSandboxedEditTool as _, generateMusic as a, wrapToolMemoryFlushAppendOnlyWrite as b, buildActiveImageGenerationTaskPromptContextForSession as c, normalizeCronJobInput as d, normalizeCronJobPatch as f, createOpenClawReadTool as g, createHostWorkspaceWriteTool as h, buildActiveMusicGenerationTaskPromptContextForSession as i, setEmbeddedMode as k, findActiveSessionTask as l, createHostWorkspaceEditTool as m, buildActiveVideoGenerationTaskPromptContextForSession as n, listRuntimeMusicGenerationProviders as o, resolveToolLoopDetectionConfig as p, triggerSessionPatchHook as r, listSupportedMusicGenerationModes as s, createOpenClawTools as t, normalizeCronJobCreate as u, createSandboxedReadTool as v, resolveOpenClawPluginToolsForOptions as w, wrapToolWorkspaceRootGuard as x, createSandboxedWriteTool as y };
