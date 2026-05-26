import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString$1, d as normalizeStringifiedOptionalString, f as readStringValue, o as normalizeNullableString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as resolveOpenClawPackageRoot } from "./openclaw-root-CNp1Ofdk.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { a as formatUncaughtError, i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as isAbortError } from "./unhandled-rejections-Km9wbHjh.js";
import { t as createAsyncLock } from "./async-lock-CaiUOILd.js";
import { m as FsSafeError } from "./path-BlG8lhgR.js";
import { d as movePathToTrash } from "./fs-safe-CV86zY9G.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import "./archive-DBeZ8ywX.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { c as isSecretRef } from "./types.secrets-DwPik3M8.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { a as isSubagentSessionKey, c as parseAgentSessionKey, l as parseRawSessionConversationRef, n as isAcpSessionKey, u as parseThreadSessionSuffix } from "./session-key-utils-Ce_xWkNq.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { d as resolveAgentIdFromSessionKey, l as normalizeAgentId, o as classifySessionKeyShape, t as DEFAULT_AGENT_ID, v as toAgentStoreSessionKey } from "./session-key-Bte0mmcq.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default--mMaLHGD.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, n as listAgentIds, o as resolveAgentWorkspaceDir, s as resolveDefaultAgentDir, t as listAgentEntries } from "./agent-scope-config-CMp71_27.js";
import { c as measureDiagnosticsTimelineSpanSync, s as measureDiagnosticsTimelineSpan } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { m as writeJson, o as tryReadJson, t as readDurableJsonFile } from "./json-files-C2hqjU--.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as runTasksWithConcurrency } from "./run-with-concurrency-5cC57eDC.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { a as logWarn, t as logDebug } from "./logger-0o2znY2U.js";
import "./auth-DZ1o6pTQ.js";
import { n as resolveGatewayAuth, t as resolveEffectiveSharedGatewayAuth } from "./auth-resolve-BEn3Se6k.js";
import { T as validateConfigObjectWithPlugins, d as readConfigFileSnapshotForWrite, i as getRuntimeConfig, o as parseConfigJson5, r as createConfigIO, u as readConfigFileSnapshot, y as resolveConfigSnapshotHash } from "./io-DoswVvYe.js";
import "./archive-CBe_wA_B.js";
import { n as formatConfigIssueLines } from "./issue-format-c8ezaSew.js";
import { r as getPluginRegistryState } from "./runtime-state-DRIYGASz.js";
import { t as applyMergePatch } from "./merge-patch-BAO515t_.js";
import { r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { f as normalizeReasoningLevel, p as normalizeThinkLevel } from "./thinking-DNSlsULp.js";
import { i as resolveActiveTalkProviderConfig, r as normalizeTalkSection, t as buildTalkConfigResponse } from "./talk-C8XF4d_d.js";
import { h as resolveRuntimeConfigCacheKey } from "./runtime-snapshot-DgdkBEdP.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { t as validateJsonSchemaValue } from "./schema-validator-CoHaB3Uu.js";
import { i as replaceConfigFile, r as mutateConfigFileWithRetry } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { n as isRestartEnabled } from "./commands.flags-CeKA8V9z.js";
import { a as publicKeyRawBase64UrlFromPem, r as loadOrCreateDeviceIdentity } from "./device-identity-BuQ9YOu8.js";
import { a as hasGatewayClientCap, i as GATEWAY_CLIENT_NAMES, n as GATEWAY_CLIENT_IDS, r as GATEWAY_CLIENT_MODES, t as GATEWAY_CLIENT_CAPS } from "./client-info-BVWE_ra1.js";
import { i as isInternalNonDeliveryChannel } from "./message-channel-core-BoUoCGOD.js";
import { c as isGatewayMessageChannel, s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { r as setSafeTimeout } from "./timer-delay-awNPCchy.js";
import { u as gatewayStartupUnavailableDetails } from "./client-B1EH_7Mz.js";
import { $ as validateExecApprovalsGetParams, $t as validateSessionsSendParams, A as validateConfigSchemaParams, An as validateTalkSessionTurnParams, B as validateCronUpdateParams, Bn as validateUpdateRunParams, Bt as validateSessionsCompactionListParams, Cn as validateTalkSessionCloseParams, D as validateConfigPatchParams, Dt as validatePluginsUiDescriptorsParams, E as validateConfigGetParams, En as validateTalkSessionJoinParams, Et as validatePluginsSessionActionResult, F as validateCronListParams, Fn as validateTasksGetParams, Ft as validateSessionsAbortParams, G as validateDeviceTokenRevokeParams, Gn as validateWebPushSubscribeParams, Gt as validateSessionsListParams, H as validateDevicePairListParams, Hn as validateWakeParams, Ht as validateSessionsCreateParams, I as validateCronRemoveParams, In as validateTasksListParams, It as validateSessionsCleanupParams, J as validateEnvironmentsStatusParams, Jn as validateWebPushVapidPublicKeyParams, Jt as validateSessionsPatchParams, K as validateDeviceTokenRotateParams, Kn as validateWebPushTestParams, Kt as validateSessionsMessagesSubscribeParams, L as validateCronRunParams, Ln as validateToolsCatalogParams, Lt as validateSessionsCompactParams, Mn as validateTalkSpeakParams, N as validateCronAddParams, Ni as ErrorCodes, O as validateConfigSchemaLookupParams, Ot as validatePollParams, P as validateCronGetParams, Pi as errorShape, Pn as validateTasksCancelParams, Pt as validateSendParams, Qn as validateWizardStatusParams, Qt as validateSessionsResolveParams, R as validateCronRunsParams, Rn as validateToolsEffectiveParams, Rt as validateSessionsCompactionBranchParams, Sn as validateTalkSessionCancelTurnParams, St as validateNodeRenameParams, T as validateConfigApplyParams, Tt as validatePluginsSessionActionParams, U as validateDevicePairRejectParams, Un as validateWebLoginStartParams, Ut as validateSessionsDeleteParams, V as validateDevicePairApproveParams, Vn as validateUpdateStatusParams, Vt as validateSessionsCompactionRestoreParams, W as validateDevicePairRemoveParams, Wn as validateWebLoginWaitParams, Wt as validateSessionsDescribeParams, Xn as validateWizardNextParams, Xt as validateSessionsPreviewParams, Yn as validateWizardCancelParams, Yt as validateSessionsPluginPatchParams, Zn as validateWizardStartParams, Zt as validateSessionsResetParams, _ as validateChannelsStatusParams, _t as validateNodePairVerifyParams, a as validateAgentsCreateParams, an as validateSkillsStatusParams, at as validateModelsListParams, bn as validateTalkSessionAppendAudioParams, bt as validateNodePendingEnqueueParams, c as validateAgentsFilesListParams, cn as validateSkillsUploadChunkParams, d as validateAgentsUpdateParams, dt as validateNodeListParams, ea as COMMAND_DESCRIPTION_MAX_LENGTH, en as validateSessionsUsageParams, et as validateExecApprovalsNodeGetParams, f as validateArtifactsDownloadParams, fn as validateTalkClientCreateParams, ft as validateNodePairApproveParams, g as validateChannelsStartParams, gn as validateTalkConfigParams, gt as validateNodePairRequestParams, h as validateChannelsLogoutParams, ht as validateNodePairRemoveParams, i as validateAgentWaitParams, in as validateSkillsSearchParams, it as validateMessageActionParams, j as validateConfigSetParams, k as validateConfigSchemaLookupResult, kn as validateTalkSessionSubmitToolResultParams, kt as validatePushTestParams, l as validateAgentsFilesSetParams, ln as validateSkillsUploadCommitParams, lt as validateNodeInvokeParams, m as validateArtifactsListParams, mn as validateTalkClientToolCallParams, mt as validateNodePairRejectParams, n as validateAgentIdentityParams, nn as validateSkillsDetailParams, nt as validateExecApprovalsSetParams, o as validateAgentsDeleteParams, on as validateSkillsUpdateParams, ot as validateNodeDescribeParams, p as validateArtifactsGetParams, pt as validateNodePairListParams, q as validateEnvironmentsListParams, qn as validateWebPushUnsubscribeParams, qt as validateSessionsMessagesUnsubscribeParams, r as validateAgentParams, rn as validateSkillsInstallParams, rt as validateLogsTailParams, s as validateAgentsFilesGetParams, sn as validateSkillsUploadBeginParams, st as validateNodeEventParams, t as formatValidationErrors, tn as validateSkillsBinsParams, tt as validateExecApprovalsNodeSetParams, u as validateAgentsListParams, un as validateTalkCatalogParams, ut as validateNodeInvokeResultParams, v as validateChannelsStopParams, vt as validateNodePendingAckParams, w as validateCommandsListParams, wn as validateTalkSessionCreateParams, xn as validateTalkSessionCancelOutputParams, yn as validateTalkModeParams, yt as validateNodePendingDrainParams, z as validateCronStatusParams, zn as validateToolsInvokeParams, zt as validateSessionsCompactionGetParams } from "./protocol-DiXjp30g.js";
import { r as annotateInterSessionPromptText, s as normalizeInputProvenance } from "./input-provenance-CmqYxlZ2.js";
import { n as DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS } from "./plugin-approvals-BAd_Vwt-.js";
import { n as createCoreGatewayMethodDescriptors, r as isCoreGatewayMethodClassified } from "./core-descriptors-zcE5f_RQ.js";
import { a as TALK_SECRETS_SCOPE, o as WRITE_SCOPE, t as ADMIN_SCOPE$1 } from "./operator-scopes-DGvgHuOd.js";
import { n as authorizeOperatorScopesForMethod } from "./method-scopes-D4RcH8qD.js";
import { f as scheduleGatewaySigusr1Restart } from "./restart-C-r_0sSG.js";
import { i as resolveAssistantAvatarUrl } from "./control-ui-shared-C2-bVRg-.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-CuCUT4Z1.js";
import { i as asOptionalRecord, n as asNullableRecord } from "./record-coerce-aMlBWINm.js";
import { G as resolveMemoryDreamingConfig, H as isSameMemoryDreamingDay, J as resolveMemoryDreamingWorkspaces, K as resolveMemoryDreamingPluginConfig, W as resolveMemoryDeepDreamingConfig, X as resolveMemoryRemDreamingConfig, Y as resolveMemoryLightDreamingConfig } from "./dreaming-CxCxWYoC.js";
import { C as createPluginGatewayMethodDescriptors, S as createGatewayMethodRegistry, v as patchPluginSessionExtension, x as createGatewayMethodDescriptorsFromHandlers } from "./loader-DKK7Ita0.js";
import { a as getActivePluginRegistry, n as getActivePluginChannelRegistryVersion, s as getActivePluginRegistryVersion } from "./runtime-DHxRl5F1.js";
import { i as hasInternalHookListeners, m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-DpfQDjis.js";
import { l as onAgentEvent, u as registerAgentRunContext } from "./agent-events-BuYtWSh4.js";
import { t as isPluginJsonValue } from "./host-hook-json-BHsxXV1L.js";
import { i as resolveMainSessionKey, n as resolveAgentMainSessionKey, r as resolveExplicitAgentSessionKey } from "./main-session-D3q_5w0B.js";
import { a as resolveSessionStoreKey, i as resolveSessionStoreAgentId, o as resolveStoredSessionKeyForAgentStore, r as canonicalizeSpawnedByForAgent, s as resolveStoredSessionOwnerAgentId, t as loadCombinedSessionStoreForGateway } from "./combined-store-gateway-NV2GSCR6.js";
import { h as stringifyRouteThreadId } from "./channel-route-L2PJ-xNE.js";
import { i as mergeDeliveryContext, n as deliveryContextFromSession, o as normalizeDeliveryContext, s as normalizeSessionDeliveryFields } from "./delivery-context.shared-CBmB9dF7.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath, l as resolveSessionTranscriptsDirForAgent } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { a as normalizeChannelId, i as listChannelPlugins, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import "./plugins-DYTHbmt7.js";
import { n as mergeSessionEntry } from "./types-BgvyBC-3.js";
import { t as listConfiguredSessionStoreAgentIds } from "./targets-B5o7Ubgb.js";
import { c as resolveSessionLifecycleTimestamps, i as serializeSessionCleanupResult, l as resolveMainSessionKeyFromConfig, r as runSessionsCleanup, t as purgeAgentSessionStoreEntries, u as extractDeliveryInfo } from "./sessions-CQHHcgC_.js";
import { c as resolveSessionResetPolicy, n as resolveChannelResetConfig, o as evaluateSessionFreshness, r as resolveSessionResetType } from "./reset-B0OJOtNI.js";
import { t as appendAssistantMessageToSessionTranscript } from "./transcript-BA0Ngd-A.js";
import { n as withPluginRuntimeGatewayRequestScope } from "./gateway-request-scope-B9qYB9tg.js";
import { t as getActiveRuntimePluginRegistry } from "./active-runtime-registry-wEpAEHY2.js";
import { d as resolvePersistedAuthProfileOwnerAgentDir, i as ensureAuthProfileStoreWithoutExternalProfiles, n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { r as resolveAgentTimeoutMs } from "./task-completion-contract-D5t-_eBh.js";
import { c as setHeartbeatsEnabled } from "./heartbeat-wake-BEc0M8hq.js";
import { a as enqueueSystemEvent, s as isSystemEventContextChanged } from "./system-events-11EG3LzK.js";
import { f as listTaskRecords, s as getTaskById } from "./task-registry-B9ljq8Nk.js";
import { t as extractToolPayload } from "./tool-payload-Gp3uQTKH.js";
import { a as sanitizeTaskStatusText, r as formatTaskStatusTitle } from "./task-status-BvwcU8qI.js";
import "./runtime-internal-2F71tA3B.js";
import { i as createRunningTaskRun, o as finalizeTaskRunByRunId, t as cancelDetachedTaskRunById } from "./detached-task-runtime-C79km_82.js";
import { n as getDiagnosticStabilitySnapshot, r as normalizeDiagnosticStabilityQuery } from "./diagnostic-stability-BzQFUHBy.js";
import { o as getActiveEmbeddedRunCount } from "./run-state-primn49x.js";
import { _ as waitForEmbeddedPiRunEnd, n as abortEmbeddedPiRun, o as isEmbeddedPiRunActive } from "./runs-DrbsiywK.js";
import { a as readRecentSessionMessagesWithStatsAsync, c as readSessionMessageCountAsync, o as readRecentSessionTranscriptLines, p as visitSessionMessagesAsync, u as readSessionPreviewItemsFromTranscript } from "./session-utils.fs-CsnHXIqH.js";
import { a as resolveSessionTranscriptCandidates, t as archiveFileOnDisk } from "./session-transcript-files.fs-CDIpA7EV.js";
import { t as resolveModelAgentRuntimeMetadata } from "./agent-runtime-metadata-DOglN8Yf.js";
import { r as getLatestSubagentRunByChildSessionKey } from "./subagent-registry-read-0y5BjaUV.js";
import { o as getGatewayModelPricingHealth } from "./model-pricing-cache-state-CABhovg9.js";
import { c as loadSessionEntry, d as resolveDeletedAgentIdFromSessionKey, f as resolveFreshestSessionEntryFromStoreKeys, g as resolveSessionDisplayModelIdentityRef, i as listAgentsForGateway, l as migrateAndPruneGatewaySessionStoreKey, m as resolveGatewaySessionStoreTarget, o as listSessionsFromStoreAsync, p as resolveGatewayModelSupportsImages, s as loadGatewaySessionRow, t as buildGatewaySessionRow, v as resolveSessionModelRef } from "./session-utils-CRKr-5AU.js";
import { n as detectRespawnSupervisor, t as SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers-B5EgETF5.js";
import { c as resolveRestartSentinelPath, d as writeRestartSentinel, r as formatDoctorNonInteractiveHint } from "./restart-sentinel-BDtpdKoy.js";
import { l as getTotalQueueSize } from "./command-queue-Da2Lh3Ua.js";
import { a as resolveCronRunLogPath, n as readCronRunLogEntriesPage, r as readCronRunLogEntriesPageAll } from "./run-log-Bi9tKROY.js";
import { n as getInspectableActiveTaskRestartBlockers } from "./task-registry.maintenance-BGxQNDMF.js";
import { f as normalizeCronJobPatch, r as triggerSessionPatchHook, u as normalizeCronJobCreate } from "./openclaw-tools-QeySpphx.js";
import { i as listCoreToolSections, n as PROFILE_OPTIONS, o as resolveCoreToolProfiles } from "./tool-catalog-8X_kZYZC.js";
import { s as resolveTrustedGroupId } from "./pi-tools.policy-DWPg8MXT.js";
import { i as resolveSandboxConfigForAgent } from "./config-CcQ2HijN.js";
import { a as resolvePluginTools, i as getPluginToolMeta, r as ensureStandalonePluginToolRegistryLoaded, t as buildPluginToolMetadataKey } from "./tools-KpflAzxD.js";
import { i as restoreRedactedValues, n as redactConfigObject, r as redactConfigSnapshot } from "./redact-snapshot-DLK0iGBB.js";
import { a as DEFAULT_MEMORY_FILENAME, c as DEFAULT_USER_FILENAME, f as isWorkspaceSetupCompleted, i as DEFAULT_IDENTITY_FILENAME, l as ensureAgentWorkspace, n as DEFAULT_BOOTSTRAP_FILENAME, o as DEFAULT_SOUL_FILENAME, r as DEFAULT_HEARTBEAT_FILENAME, s as DEFAULT_TOOLS_FILENAME, t as DEFAULT_AGENTS_FILENAME } from "./workspace-DTx8zuCN.js";
import { o as isTimeoutError } from "./failover-error-CZCIurQK.js";
import "./auth-profiles-D6NMnufG.js";
import { n as externalCliDiscoveryForConfigStatus } from "./external-cli-discovery-D0JQl8du.js";
import { n as listProfilesForProvider } from "./profile-list-C0HtPlut.js";
import { i as removeProviderAuthProfilesWithLock } from "./profiles-9GB1thhi.js";
import { t as maybeResolveIdLikeTarget } from "./target-id-resolution-DVSHqxJ3.js";
import { s as projectOutboundPayloadPlanForMirror, t as createOutboundPayloadPlan } from "./payloads-BOM5t2O4.js";
import { N as saveExecApprovals, b as readExecApprovalsSnapshot, f as mergeExecApprovalsSocketDefaults, m as normalizeExecApprovals, s as ensureExecApprovals } from "./exec-approvals-Bef7TPVc.js";
import { a as getActiveSecretsRuntimeSnapshot } from "./runtime-state-CPpp7_ve.js";
import { i as resolveIngressWorkspaceOverrideForSpawnedRun, r as normalizeSpawnedRunMetadata } from "./spawn-requester-origin-u-IVBdHC.js";
import { a as resolveCronDeliverySessionKey, r as isInvalidCronSessionTargetIdError } from "./webhook-url-CYBYCR4B.js";
import { i as parseAbsoluteTimeMs } from "./stagger-Bn6ApiDa.js";
import { r as getAgentScopedMediaLocalRoots } from "./local-roots-Pi6a9oaK.js";
import { d as listConfiguredAnnounceChannelIdsForConfig } from "./channel-plugin-ids-nB-ga3MN.js";
import { a as clearSessionQueues } from "./queue-DskPlua9.js";
import { n as resolveAgentIdentity } from "./identity-nYw-h8DL.js";
import { t as buildOutboundSessionContext } from "./session-context-DSIPIqLK.js";
import { i as resolveReplyToMode } from "./reply-threading-Bgku_ISs.js";
import { n as shouldDowngradeDeliveryToSessionOnly } from "./best-effort-delivery-9526ai4g.js";
import { r as resolveOutboundChannelPlugin } from "./channel-resolution-Ecs0HEdK.js";
import { t as sendDurableMessageBatch } from "./send-CGvo7HYh.js";
import "./runtime-BN74dT7u.js";
import { n as normalizePollInput } from "./polls-C-v11_tu.js";
import { n as resolveMessageChannelSelection } from "./channel-selection-DQG3SYlu.js";
import { i as resolveChannelDefaultAccountId } from "./helpers-CswdXPdi.js";
import { i as validateTargetProviderPrefix, r as resolveTargetPrefixedChannel } from "./targets-session-B-pkKm7E.js";
import { r as resolveOutboundTarget } from "./targets-CNDTJ9IB.js";
import { t as resolvePreferredSessionKeyForSessionIdMatches } from "./session-id-resolution-CQPMwA0q.js";
import { s as dispatchChannelMessageAction } from "./message-action-runner-B4oH5EYj.js";
import "./target-resolver-8NiS43Zp.js";
import { n as resolveOutboundSessionRoute, t as ensureOutboundSessionEntry } from "./outbound-session-DKXWYF4a.js";
import { c as normalizeProviderStarted, l as formatBlockedLivenessError, s as normalizeAgentRunTimeoutPhase, u as isBlockedLivenessState } from "./run-wait-BlZoP48F.js";
import { D as synthesizeSpeech, S as setTtsEnabled, T as setTtsProvider, _ as resolveTtsPrefsPath, a as getTtsPersona, c as isTtsEnabled, d as listTtsPersonas, g as resolveTtsConfig, h as resolveTtsAutoMode, k as textToSpeech, l as isTtsProviderConfigured, m as resolveExplicitTtsOverrides, o as getTtsProvider, r as getResolvedSpeechProviderConfig, v as resolveTtsProviderOrder, w as setTtsPersona } from "./tts-runtime-B3-lBCQj.js";
import "./tts-Bd-K2Dd6.js";
import { o as loadWorkspaceSkillEntries } from "./workspace-BoRIIBbL.js";
import "./skills-JUNRkaHl.js";
import { t as getPluginCommandSpecs } from "./command-specs-ByDvK7rB.js";
import { n as listPluginCommands } from "./commands-knen7QS8.js";
import { n as resolveSendPolicy } from "./send-policy-Dh6BW0dE.js";
import { i as listSpeechProviders, n as getSpeechProvider, t as canonicalizeSpeechProviderId } from "./provider-registry-mISFpr4F.js";
import { r as listChatCommandsForConfig } from "./commands-registry-list--98FRviq.js";
import "./commands-registry-Bthd8JBl.js";
import { d as getSessionCompactionCheckpoint, f as listSessionCompactionCheckpoints, u as forkCompactionCheckpointTranscriptAsync } from "./model-context-tokens-C2LIZoUn.js";
import { r as getActiveMemorySearchManager } from "./memory-runtime-DxsWIMOy.js";
import { n as compactEmbeddedPiSession } from "./pi-embedded-CsSFzly6.js";
import { t as getTotalPendingReplies } from "./dispatcher-registry-CaTZukRA.js";
import { a as resolveAgentRunExpiresAtMs, i as registerChatAbortController, n as abortChatRunsForProvider, o as updateChatRunProvider, t as abortChatRunById } from "./chat-abort-GHhFaqcz.js";
import "./browser-maintenance-CIdUceQj.js";
import { c as performGatewaySessionReset } from "./session-reset-service-URLQHV3O.js";
import { t as getChannelActivity } from "./channel-activity-eMQlJ3BE.js";
import { t as WizardCancelledError } from "./prompts-E0FayNjJ.js";
import { n as summarizeToolDescriptionText } from "./tool-description-summary-Dy6DgmPc.js";
import { t as resolveEffectiveToolInventory } from "./tools-effective-inventory-DvFk0LI9.js";
import { i as resolveBareSessionResetPromptState, n as shouldApplyStartupContext, r as resolveBareResetBootstrapFileAccess, t as buildSessionStartupContextPrelude } from "./startup-context-B172cCS8.js";
import { n as getLastHeartbeatEvent } from "./heartbeat-events-BMVPfx2x.js";
import { r as mergeIdentityMarkdownContent } from "./identity-file-BfwiD4th.js";
import { n as resolvePublicAgentAvatarSource, t as resolveAgentAvatar } from "./identity-avatar-B6GTrfBh.js";
import "./server-constants-BGwLM6XN.js";
import { n as agentCommandFromIngress } from "./agent-command-QBBzz2Au.js";
import { c as refreshClientPluginNodeCapability } from "./plugin-node-capability-C7GppvZZ.js";
import { a as normalizeDeclaredNodeCommands, n as isForegroundRestrictedPluginNodeCommand, o as resolveNodeCommandAllowlist, r as isNodeCommandAllowed } from "./node-command-policy-Bsyvfkrl.js";
import { i as safeParseJson, n as respondUnavailableOnNodeInvokeError, r as respondUnavailableOnThrow, t as respondInvalidParams } from "./nodes.helpers-DvsMU-XC.js";
import { t as formatForLog } from "./ws-log-Ds39xp21.js";
import { r as invokeNativeHookRelay } from "./native-hook-relay-CKQJJkrR.js";
import { t as canExecRequestNode } from "./exec-defaults-60zNtKRO.js";
import { t as listAgentWorkspaceDirs } from "./workspace-dirs-BOQJykhE.js";
import { a as removePairedNode, i as rejectNodePairing, l as verifyNodeToken, o as renamePairedNode, r as listNodePairing, s as requestNodePairing, t as approveNodePairing } from "./node-pairing-Dqxd4uL_.js";
import { i as recordRemoteNodeInfo, o as refreshRemoteNodeBins, s as removeRemoteNodeInfo, t as getRemoteSkillEligibility } from "./skills-remote-BCbpja7h.js";
import { t as listSkillCommandsForAgents } from "./skill-commands-dLqoqLxl.js";
import { t as loadModelCatalogForBrowse } from "./model-catalog-browse-C1cYTG2K.js";
import { i as warmCurrentProviderAuthState, t as clearCurrentProviderAuthState } from "./model-provider-auth-DAG1ddFR.js";
import { t as resolveVisibleModelCatalog } from "./model-catalog-visibility-kfqhTKJH.js";
import { a as getPairedDevice, d as rejectDevicePairing, f as removePairedDevice, g as summarizeDeviceTokens, h as rotateDeviceToken, i as formatDevicePairingForbiddenMessage, l as listDevicePairing, m as revokeDeviceToken, n as approveDevicePairing, o as getPendingDevicePairing, s as hasEffectivePairedDeviceRole } from "./device-pairing-C3feAqgm.js";
import { r as listRealtimeTranscriptionProviders } from "./provider-registry-DpzahkXi.js";
import { A as REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ, S as recordTalkObservabilityEvent, a as listRealtimeVoiceProviders, b as createTalkSessionController, c as REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, n as resolveConfiguredRealtimeVoiceProvider, p as buildRealtimeVoiceAgentConsultWorkingResponse, r as canonicalizeRealtimeVoiceProviderId, s as REALTIME_VOICE_AGENT_CONSULT_TOOL, t as createRealtimeVoiceBridgeSession, u as buildRealtimeVoiceAgentConsultChatMessage } from "./session-runtime-CCTSwqCz.js";
import { n as PROVIDER_LABELS, o as resolveUsageProviderId } from "./provider-usage.shared-Dk5t9Xpy.js";
import { n as createOutboundSendDeps } from "./deps-C1bdn-NA.js";
import "./agent-DBVvbEwY.js";
import { n as consumeExecApprovalFollowupRuntimeHandoff, r as parseExecApprovalFollowupApprovalId } from "./bash-tools.exec-approval-followup-state-C20XbeZj.js";
import { a as matchSystemRunApprovalBinding, c as toSystemRunApprovalMismatchError, n as resolveSystemRunCommandRequest, o as missingSystemRunApprovalBinding, r as buildSystemRunApprovalBinding } from "./system-run-command-BT3YU9qx.js";
import { r as resolveSystemRunApprovalRuntimeContext } from "./system-run-approval-context-jl9czEM4.js";
import { n as resolveAgentOutboundTarget, t as resolveAgentDeliveryPlan } from "./agent-delivery-BF85uL-M.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-DPLbsdcw.js";
import { c as waitForTerminalGatewayDedupe, o as readTerminalSnapshotFromGatewayDedupe, r as chatHandlers, s as setGatewayDedupeEntry } from "./chat-zFy9Y_4Y.js";
import { i as parseMessageWithAttachments, n as MediaOffloadError, o as resolveChatAttachmentMaxBytes, t as normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize-DnMVXpe_.js";
import { n as timestampOptsFromConfig, t as injectTimestamp } from "./agent-timestamp-JdPenpRZ.js";
import { t as resolveSessionKeyFromResolveParams } from "./sessions-resolve-BsXEJyiD.js";
import { t as loadProviderUsageSummary } from "./provider-usage-Ccwl6xqF.js";
import { t as getTaskSessionLookupByIdForStatus } from "./task-status-access-C4wDBrvB.js";
import { s as fetchClawHubSkillDetail } from "./clawhub-B9rdLaiz.js";
import { a as loadSessionCostSummaryFromCache, c as resolveExistingUsageSessionFile, o as loadSessionLogs, r as loadCostUsageSummaryFromCache, s as loadSessionUsageTimeSeries, t as discoverAllSessions } from "./session-cost-usage-Dn79gKT8.js";
import { n as buildAuthHealthSummary, r as formatRemainingShort } from "./auth-health-Cr2XZkMa.js";
import { t as buildChannelUiCatalog } from "./catalog-Cw2Qtjnc.js";
import { c as repairDreamingArtifacts, i as previewRemHarness, l as writeBackfillDiaryEntries, n as dedupeDreamDiaryEntries, o as removeBackfillDiaryEntries, r as previewGroundedRemMarkdown, s as removeGroundedShortTermCandidates } from "./memory-core-bundled-runtime-GCLqlS7d.js";
import { s as normalizeUpdateChannel } from "./update-channels-f-ieRme5.js";
import { r as lookupConfigSchema, t as loadGatewayRuntimeConfigSchema } from "./runtime-schema-pPVn7_7T.js";
import { t as readConfiguredLogTail } from "./log-tail-A9kBoCdj.js";
import { a as updateSkillsFromClawHub, c as validateRequestedSkillSlug, r as searchSkillsFromClawHub, s as installSkillArchiveFromPath, t as installSkillFromClawHub } from "./skills-clawhub-z6Pr6l8N.js";
import { r as readPackageVersion } from "./package-json-CWP51tfk.js";
import { n as runGatewayUpdate, t as resolveUpdateInstallSurface } from "./update-runner-DaxSiueb.js";
import { l as buildUpdateRestartSentinelPayload, r as CONTROL_PLANE_UPDATE_SENTINEL_META_ENV, t as CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON } from "./update-control-plane-sentinel-C4970WGr.js";
import { t as MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX } from "./update-managed-service-handoff-cleanup-BKQxjJf5.js";
import { a as pruneAgentConfig, r as findAgentEntryIndex, t as applyAgentConfig } from "./agents.config-BhjhdYsc.js";
import { t as findOverlappingWorkspaceAgentIds } from "./agent-delete-safety-CY69TiFE.js";
import { t as buildChannelAccountSnapshot } from "./status-DQVTMawq.js";
import { n as DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS, r as evaluateChannelHealth, t as DEFAULT_CHANNEL_CONNECT_GRACE_MS } from "./channel-health-policy-D_eDwUBm.js";
import { t as installSkill } from "./skills-install-BG5un9km.js";
import { t as getStatusSummary } from "./status.summary-C3N6vo18.js";
import "./status-CX0pO0y4.js";
import { t as resolveCronDeliveryPlan } from "./delivery-plan-DRpBOJ2V.js";
import { _ as resolveDeliveryTarget, n as applyJobPatch } from "./jobs-CYMnCvkL.js";
import { n as resolveAssistantIdentity } from "./assistant-identity-BpQbk1Fj.js";
import { a as diffConfigPaths, i as resolveConfigReloadMetadata, t as buildGatewayReloadPlan } from "./config-reload-plan-el2pIdzi.js";
import { a as resolveApnsAuthConfigFromEnv, d as resolveApnsRelayConfigFromEnv, n as loadApnsRegistration, o as sendApnsAlert, r as normalizeApnsEnvironment, s as sendApnsBackgroundWake, t as clearApnsRegistrationIfCurrent, u as shouldClearStoredApnsRegistration } from "./push-apns-CvAnrySM.js";
import { t as resolveGatewayReloadSettings } from "./config-reload-settings-BCSjTPm-.js";
import "./heartbeat-runner-DDFMtPQL.js";
import { t as consumeControlPlaneWriteBudget } from "./control-plane-rate-limit-AYt-ugaJ.js";
import { i as setVoiceWakeTriggers, n as normalizeVoiceWakeTriggers, r as loadVoiceWakeConfig, t as formatError$1 } from "./server-utils-9y0vZuz2.js";
import { n as updateSystemPresence, t as listSystemPresence } from "./system-presence-Cj1j_O4u.js";
import { a as validateVoiceWakeRoutingConfigInput, i as setVoiceWakeRoutingConfig, n as normalizeVoiceWakeRoutingConfig, o as isRoleAuthorizedForMethod, r as resolveVoiceWakeRouteByTrigger, s as parseGatewayRole, t as loadVoiceWakeRoutingConfig } from "./voicewake-routing-DJqnkQlz.js";
import { n as resolveSessionKeyForRun } from "./server-session-key-C0AknAXZ.js";
import { o as prepareSecretsRuntimeSnapshot, s as refreshActiveSecretsRuntimeSnapshot } from "./runtime-nQoXP16c.js";
import { o as resolveApprovalRequestRecipientConnIds } from "./approval-shared-D6QkOF6w.js";
import { a as nodeWakeById, n as NODE_WAKE_RECONNECT_RETRY_WAIT_MS, o as nodeWakeNudgeById, r as NODE_WAKE_RECONNECT_WAIT_MS, t as broadcastPresenceSnapshot } from "./presence-events-BpQxlCGY.js";
import { t as applySessionsPatchToStore } from "./sessions-patch-DxE2Tyw9.js";
import { t as invokeGatewayTool } from "./tools-invoke-shared-DvoGicTA.js";
import { n as recordLatestUpdateRestartSentinel, t as getLatestUpdateRestartSentinel } from "./server-restart-sentinel-zgIzZ1w7.js";
import fs, { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
//#region src/gateway/control-plane-audit.ts
function normalizePart(value, fallback) {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback;
}
function resolveControlPlaneActor(client) {
	return {
		actor: normalizePart(client?.connect?.client?.id, "unknown-actor"),
		deviceId: normalizePart(client?.connect?.device?.id, "unknown-device"),
		clientIp: normalizePart(client?.clientIp, "unknown-ip"),
		connId: normalizePart(client?.connId, "unknown-conn")
	};
}
function formatControlPlaneActor(actor) {
	return `actor=${actor.actor} device=${actor.deviceId} ip=${actor.clientIp} conn=${actor.connId}`;
}
function summarizeChangedPaths(paths, maxPaths = 8) {
	if (paths.length === 0) return "<none>";
	if (paths.length <= maxPaths) return paths.join(",");
	return `${paths.slice(0, maxPaths).join(",")},+${paths.length - maxPaths} more`;
}
//#endregion
//#region src/gateway/session-subagent-reactivation.ts
async function loadSessionSubagentReactivationRuntime() {
	return import("./session-subagent-reactivation.runtime.js");
}
async function reactivateCompletedSubagentSession(params) {
	const runId = params.runId?.trim();
	if (!runId) return false;
	const existing = getLatestSubagentRunByChildSessionKey(params.sessionKey);
	if (!existing || typeof existing.endedAt !== "number") return false;
	const { replaceSubagentRunAfterSteer } = await loadSessionSubagentReactivationRuntime();
	return replaceSubagentRunAfterSteer({
		previousRunId: existing.runId,
		nextRunId: runId,
		fallback: existing,
		runTimeoutSeconds: existing.runTimeoutSeconds ?? 0
	});
}
//#endregion
//#region src/gateway/server-methods/agent-job.ts
const AGENT_RUN_CACHE_TTL_MS = 10 * 6e4;
/**
* Embedded runs can emit transient lifecycle `error` events while auth/model
* failover is still in progress. Give errors a short grace window so a
* subsequent `start` event can cancel premature terminal snapshots.
*/
const AGENT_RUN_ERROR_RETRY_GRACE_MS = 15e3;
/**
* Some embedded runtimes emit an intermediate lifecycle `end` with
* `aborted=true` immediately before retrying the same run. Hold timeout
* snapshots briefly so `agent.wait` does not resolve to a stale timeout when a
* final success is about to arrive.
*/
const AGENT_RUN_TIMEOUT_RETRY_GRACE_MS = 15e3;
const agentRunCache = /* @__PURE__ */ new Map();
const agentRunStarts = /* @__PURE__ */ new Map();
const pendingAgentRunErrors = /* @__PURE__ */ new Map();
const pendingAgentRunTimeouts = /* @__PURE__ */ new Map();
const agentRunWaiterCounts = /* @__PURE__ */ new Map();
let agentRunListenerStarted = false;
function pruneAgentRunCache(now = Date.now()) {
	for (const [runId, entry] of agentRunCache) if (now - entry.ts > AGENT_RUN_CACHE_TTL_MS) agentRunCache.delete(runId);
}
function recordAgentRunSnapshot(entry) {
	pruneAgentRunCache(entry.ts);
	agentRunCache.set(entry.runId, entry);
}
function clearPendingAgentRunError(runId) {
	const pending = pendingAgentRunErrors.get(runId);
	if (!pending) return;
	clearTimeout(pending.timer);
	pendingAgentRunErrors.delete(runId);
}
function clearPendingAgentRunTimeout(runId) {
	const pending = pendingAgentRunTimeouts.get(runId);
	if (!pending) return;
	clearTimeout(pending.timer);
	pendingAgentRunTimeouts.delete(runId);
}
function schedulePendingAgentRunError(snapshot) {
	clearPendingAgentRunTimeout(snapshot.runId);
	clearPendingAgentRunError(snapshot.runId);
	const dueAt = Date.now() + AGENT_RUN_ERROR_RETRY_GRACE_MS;
	const timer = setTimeout(() => {
		const pending = pendingAgentRunErrors.get(snapshot.runId);
		if (!pending) return;
		pendingAgentRunErrors.delete(snapshot.runId);
		recordAgentRunSnapshot(pending.snapshot);
	}, AGENT_RUN_ERROR_RETRY_GRACE_MS);
	timer.unref?.();
	pendingAgentRunErrors.set(snapshot.runId, {
		snapshot,
		dueAt,
		timer
	});
}
function schedulePendingAgentRunTimeout(snapshot) {
	clearPendingAgentRunError(snapshot.runId);
	clearPendingAgentRunTimeout(snapshot.runId);
	const dueAt = Date.now() + AGENT_RUN_TIMEOUT_RETRY_GRACE_MS;
	const timer = setTimeout(() => {
		const pending = pendingAgentRunTimeouts.get(snapshot.runId);
		if (!pending) return;
		pendingAgentRunTimeouts.delete(snapshot.runId);
		recordAgentRunSnapshot(pending.snapshot);
	}, AGENT_RUN_TIMEOUT_RETRY_GRACE_MS);
	timer.unref?.();
	pendingAgentRunTimeouts.set(snapshot.runId, {
		snapshot,
		dueAt,
		timer
	});
}
function getPendingAgentRunError(runId) {
	const pending = pendingAgentRunErrors.get(runId);
	if (!pending) return;
	return {
		snapshot: pending.snapshot,
		dueAt: pending.dueAt
	};
}
function getPendingAgentRunTimeout(runId) {
	const pending = pendingAgentRunTimeouts.get(runId);
	if (!pending) return;
	return {
		snapshot: pending.snapshot,
		dueAt: pending.dueAt
	};
}
function createSnapshotFromLifecycleEvent(params) {
	const { runId, phase, data } = params;
	const startedAt = typeof data?.startedAt === "number" ? data.startedAt : agentRunStarts.get(runId);
	const endedAt = typeof data?.endedAt === "number" ? data.endedAt : void 0;
	const error = typeof data?.error === "string" ? data.error : void 0;
	const stopReason = typeof data?.stopReason === "string" ? data.stopReason : void 0;
	const livenessState = typeof data?.livenessState === "string" ? data.livenessState : void 0;
	const blocked = isBlockedLivenessState(livenessState);
	const status = phase === "error" || blocked ? "error" : data?.aborted ? "timeout" : "ok";
	const timeoutPhase = status === "timeout" ? normalizeAgentRunTimeoutPhase(data?.timeoutPhase) : void 0;
	const providerStarted = normalizeProviderStarted(data?.providerStarted);
	return {
		runId,
		status,
		startedAt,
		endedAt,
		error: blocked ? formatBlockedLivenessError(error) : error,
		stopReason,
		livenessState,
		...data?.yielded === true ? { yielded: true } : {},
		...timeoutPhase ? { timeoutPhase } : {},
		...providerStarted !== void 0 ? { providerStarted } : {},
		ts: Date.now()
	};
}
function ensureAgentRunListener() {
	if (agentRunListenerStarted) return;
	agentRunListenerStarted = true;
	onAgentEvent((evt) => {
		if (!evt) return;
		if (evt.stream !== "lifecycle") return;
		const phase = evt.data?.phase;
		if (phase === "start") {
			const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : void 0;
			agentRunStarts.set(evt.runId, startedAt ?? Date.now());
			clearPendingAgentRunError(evt.runId);
			clearPendingAgentRunTimeout(evt.runId);
			agentRunCache.delete(evt.runId);
			return;
		}
		if (phase !== "end" && phase !== "error") return;
		const snapshot = createSnapshotFromLifecycleEvent({
			runId: evt.runId,
			phase,
			data: evt.data
		});
		agentRunStarts.delete(evt.runId);
		if (phase === "error") {
			schedulePendingAgentRunError(snapshot);
			return;
		}
		if (snapshot.status === "timeout") {
			schedulePendingAgentRunTimeout(snapshot);
			return;
		}
		clearPendingAgentRunError(evt.runId);
		clearPendingAgentRunTimeout(evt.runId);
		recordAgentRunSnapshot(snapshot);
	});
}
function getCachedAgentRun(runId) {
	pruneAgentRunCache();
	return agentRunCache.get(runId);
}
function addAgentRunWaiter(runId) {
	agentRunWaiterCounts.set(runId, (agentRunWaiterCounts.get(runId) ?? 0) + 1);
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		const nextCount = (agentRunWaiterCounts.get(runId) ?? 1) - 1;
		if (nextCount <= 0) {
			agentRunWaiterCounts.delete(runId);
			return;
		}
		agentRunWaiterCounts.set(runId, nextCount);
	};
}
async function waitForAgentJob(params) {
	const { runId, timeoutMs, signal, ignoreCachedSnapshot = false } = params;
	ensureAgentRunListener();
	const cached = ignoreCachedSnapshot ? void 0 : getCachedAgentRun(runId);
	if (cached) return cached;
	if (timeoutMs <= 0 || signal?.aborted) return null;
	return await new Promise((resolve) => {
		let settled = false;
		let pendingErrorTimer;
		let pendingTimeoutTimer;
		let onAbort;
		let removeWaiter = () => {};
		const clearPendingErrorTimer = () => {
			if (!pendingErrorTimer) return;
			clearTimeout(pendingErrorTimer);
			pendingErrorTimer = void 0;
		};
		const clearPendingTimeoutTimer = () => {
			if (!pendingTimeoutTimer) return;
			clearTimeout(pendingTimeoutTimer);
			pendingTimeoutTimer = void 0;
		};
		const finish = (entry) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearPendingErrorTimer();
			clearPendingTimeoutTimer();
			unsubscribe();
			removeWaiter();
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			resolve(entry);
		};
		const scheduleTerminalFinish = (kind, snapshot, delayMs) => {
			clearPendingErrorTimer();
			clearPendingTimeoutTimer();
			const timerRef = setSafeTimeout(() => {
				const latest = ignoreCachedSnapshot ? void 0 : getCachedAgentRun(runId);
				if (latest) {
					finish(latest);
					return;
				}
				recordAgentRunSnapshot(snapshot);
				finish(snapshot);
			}, delayMs);
			timerRef.unref?.();
			if (kind === "error") pendingErrorTimer = timerRef;
			else pendingTimeoutTimer = timerRef;
		};
		const scheduleErrorFinish = (snapshot, delayMs = AGENT_RUN_ERROR_RETRY_GRACE_MS) => {
			scheduleTerminalFinish("error", snapshot, delayMs);
		};
		const scheduleTimeoutFinish = (snapshot, delayMs = AGENT_RUN_TIMEOUT_RETRY_GRACE_MS) => {
			scheduleTerminalFinish("timeout", snapshot, delayMs);
		};
		if (!ignoreCachedSnapshot) {
			const pendingError = getPendingAgentRunError(runId);
			if (pendingError) scheduleErrorFinish(pendingError.snapshot, pendingError.dueAt - Date.now());
			const pendingTimeout = getPendingAgentRunTimeout(runId);
			if (pendingTimeout) scheduleTimeoutFinish(pendingTimeout.snapshot, pendingTimeout.dueAt - Date.now());
		}
		const unsubscribe = onAgentEvent((evt) => {
			if (!evt || evt.stream !== "lifecycle") return;
			if (evt.runId !== runId) return;
			const phase = evt.data?.phase;
			if (phase === "start") {
				clearPendingErrorTimer();
				clearPendingTimeoutTimer();
				return;
			}
			if (phase !== "end" && phase !== "error") return;
			const latest = ignoreCachedSnapshot ? void 0 : getCachedAgentRun(runId);
			if (latest) {
				finish(latest);
				return;
			}
			const snapshot = createSnapshotFromLifecycleEvent({
				runId: evt.runId,
				phase,
				data: evt.data
			});
			if (phase === "error") {
				scheduleErrorFinish(snapshot);
				return;
			}
			if (snapshot.status === "timeout") {
				scheduleTimeoutFinish(snapshot);
				return;
			}
			recordAgentRunSnapshot(snapshot);
			finish(snapshot);
		});
		removeWaiter = addAgentRunWaiter(runId);
		const timer = setSafeTimeout(() => finish(null), timeoutMs);
		onAbort = () => finish(null);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
ensureAgentRunListener();
//#endregion
//#region src/gateway/server-methods/agent.ts
const RESET_COMMAND_RE = /^\/(new|reset)(?:\s+([\s\S]*))?$/i;
function formatAttachmentFailureForLog(err) {
	const primary = formatUncaughtError(err);
	const cause = err instanceof Error ? err.cause : void 0;
	if (cause === void 0) return primary;
	const causeText = formatUncaughtError(cause);
	if (!causeText || causeText === primary) return primary;
	return `${primary}\nCaused by: ${causeText}`;
}
function logAttachmentFailure(logGateway, label, err) {
	logGateway.error(label, {
		error: formatAttachmentFailureForLog(err),
		consoleMessage: `${label}: ${formatForLog(err)}`
	});
}
function clientHasAdminScope(client) {
	return (Array.isArray(client?.connect?.scopes) ? client.connect.scopes : []).includes(ADMIN_SCOPE$1);
}
function resolveAllowModelOverrideFromClient(client) {
	return clientHasAdminScope(client) || client?.internal?.allowModelOverride === true;
}
function resolveCanResetSessionFromClient(client) {
	return clientHasAdminScope(client);
}
function resolveCanUseInternalRuntimeHandoff(client) {
	return client?.connect?.client?.mode === GATEWAY_CLIENT_MODES.BACKEND;
}
async function runSessionResetFromAgent(params) {
	const result = await performGatewaySessionReset({
		key: params.key,
		reason: params.reason,
		commandSource: "gateway:agent"
	});
	if (!result.ok) return result;
	return {
		ok: true,
		key: result.key,
		sessionId: result.entry.sessionId
	};
}
function resolveSessionRuntimeWorkspace(params) {
	const sessionAgentId = resolveAgentIdFromSessionKey(params.sessionKey);
	const workspaceOverride = resolveIngressWorkspaceOverrideForSpawnedRun({
		spawnedBy: params.spawnedBy,
		workspaceDir: params.sessionEntry?.spawnedWorkspaceDir
	});
	return {
		runtimeWorkspaceDir: workspaceOverride ?? resolveAgentWorkspaceDir(params.cfg, sessionAgentId),
		isCanonicalWorkspace: !workspaceOverride
	};
}
function shouldSkipStartupContextForSpawnedSandbox(params) {
	if (!params.spawnedBy) return false;
	const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
	const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, agentId);
	if (sandboxCfg.mode === "off") return false;
	if (sandboxCfg.mode === "non-main") {
		const mainSessionKey = resolveAgentMainSessionKey({
			cfg: params.cfg,
			agentId
		});
		if (params.sessionKey.trim() === mainSessionKey.trim()) return false;
	}
	return sandboxCfg.workspaceAccess !== "rw";
}
function normalizeTrustedGroupMetadata(value) {
	return {
		groupId: normalizeOptionalString$1(value?.groupId),
		groupChannel: normalizeOptionalString$1(value?.groupChannel),
		groupSpace: normalizeOptionalString$1(value?.groupSpace ?? value?.space)
	};
}
function resolveSessionKeyGroupId(sessionKey) {
	const { baseSessionKey } = parseThreadSessionSuffix(sessionKey);
	const conversation = parseRawSessionConversationRef(baseSessionKey ?? sessionKey);
	if (!conversation || conversation.kind !== "group" && conversation.kind !== "channel") return;
	return conversation.rawId;
}
function resolveTrustedGroupMetadata(params) {
	return {
		groupId: params.stored.groupId ?? params.inherited?.groupId ?? resolveSessionKeyGroupId(params.sessionKey) ?? (params.spawnedBy ? resolveSessionKeyGroupId(params.spawnedBy) : void 0),
		groupChannel: params.stored.groupChannel ?? params.inherited?.groupChannel,
		groupSpace: params.stored.groupSpace ?? params.inherited?.groupSpace
	};
}
function requestGroupMatchesTrusted(params) {
	const requestGroupId = params.requestGroupId?.trim();
	if (!requestGroupId) return true;
	return Boolean(params.trustedGroupId && requestGroupId === params.trustedGroupId);
}
function emitSessionsChanged$1(context, payload) {
	const connIds = context.getSessionEventSubscriberConnIds();
	if (connIds.size === 0) return;
	const sessionRow = payload.sessionKey ? loadGatewaySessionRow(payload.sessionKey) : null;
	context.broadcastToConnIds("sessions.changed", {
		...payload,
		ts: Date.now(),
		...sessionRow ? {
			updatedAt: sessionRow.updatedAt ?? void 0,
			sessionId: sessionRow.sessionId,
			kind: sessionRow.kind,
			channel: sessionRow.channel,
			subject: sessionRow.subject,
			groupChannel: sessionRow.groupChannel,
			space: sessionRow.space,
			chatType: sessionRow.chatType,
			origin: sessionRow.origin,
			spawnedBy: sessionRow.spawnedBy,
			spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
			forkedFromParent: sessionRow.forkedFromParent,
			spawnDepth: sessionRow.spawnDepth,
			subagentRole: sessionRow.subagentRole,
			subagentControlScope: sessionRow.subagentControlScope,
			label: sessionRow.label,
			displayName: sessionRow.displayName,
			deliveryContext: sessionRow.deliveryContext,
			parentSessionKey: sessionRow.parentSessionKey,
			childSessions: sessionRow.childSessions,
			thinkingLevel: sessionRow.thinkingLevel,
			fastMode: sessionRow.fastMode,
			verboseLevel: sessionRow.verboseLevel,
			traceLevel: sessionRow.traceLevel,
			reasoningLevel: sessionRow.reasoningLevel,
			elevatedLevel: sessionRow.elevatedLevel,
			sendPolicy: sessionRow.sendPolicy,
			systemSent: sessionRow.systemSent,
			abortedLastRun: sessionRow.abortedLastRun,
			inputTokens: sessionRow.inputTokens,
			outputTokens: sessionRow.outputTokens,
			lastChannel: sessionRow.lastChannel,
			lastTo: sessionRow.lastTo,
			lastAccountId: sessionRow.lastAccountId,
			lastThreadId: sessionRow.lastThreadId,
			totalTokens: sessionRow.totalTokens,
			totalTokensFresh: sessionRow.totalTokensFresh,
			contextTokens: sessionRow.contextTokens,
			estimatedCostUsd: sessionRow.estimatedCostUsd,
			responseUsage: sessionRow.responseUsage,
			modelProvider: sessionRow.modelProvider,
			model: sessionRow.model,
			status: sessionRow.status,
			startedAt: sessionRow.startedAt,
			endedAt: sessionRow.endedAt,
			runtimeMs: sessionRow.runtimeMs,
			compactionCheckpointCount: sessionRow.compactionCheckpointCount,
			latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint
		} : {}
	}, connIds, { dropIfSlow: true });
}
function resolveFailedTrackedAgentTaskStatus(error) {
	return isAbortError(error) || isTimeoutError(error) ? "timed_out" : "failed";
}
function tryFinalizeTrackedAgentTask(params) {
	try {
		finalizeTaskRunByRunId({
			runId: params.runId,
			runtime: "cli",
			status: params.status,
			endedAt: Date.now(),
			...params.error !== void 0 ? { error: params.error } : {},
			...params.terminalSummary !== void 0 ? { terminalSummary: params.terminalSummary } : {}
		});
	} catch {}
}
function resolveAgentDedupeKeys(params) {
	const keys = [`agent:${params.idempotencyKey}`];
	const approvalId = params.execApprovalFollowupApprovalId?.trim();
	if (approvalId) keys.push(`agent:exec-approval-followup:${approvalId}`);
	return [...new Set(keys)];
}
function readGatewayDedupeEntry(params) {
	for (const key of params.keys) {
		const entry = params.dedupe.get(key);
		if (entry) return entry;
	}
}
function isAcceptedAgentDedupePayload(payload) {
	return typeof payload === "object" && payload !== null && payload.status === "accepted";
}
function isPreRegistrationAbortedAgentDedupePayload(payload) {
	const stopReason = payload?.stopReason;
	return typeof payload === "object" && payload !== null && payload.status === "timeout" && (stopReason === "rpc" || stopReason === "stop");
}
function isPreRegistrationAbortedAgentDedupeEntryForSession(params) {
	if (!params.entry?.ok || !isPreRegistrationAbortedAgentDedupePayload(params.entry.payload)) return false;
	const payload = params.entry.payload;
	const payloadRunId = typeof payload.runId === "string" ? payload.runId.trim() : "";
	if (payloadRunId && payloadRunId !== params.runId) return false;
	const payloadSessionKey = typeof payload.sessionKey === "string" && payload.sessionKey.trim() ? payload.sessionKey.trim() : void 0;
	const expectedSessionKeys = new Set([params.sessionKey, ...params.alternateSessionKeys ?? []].filter((value) => Boolean(value?.trim())));
	return !payloadSessionKey || expectedSessionKeys.size === 0 || expectedSessionKeys.has(payloadSessionKey);
}
function setGatewayDedupeEntries(params) {
	for (const key of params.keys) setGatewayDedupeEntry({
		dedupe: params.dedupe,
		key,
		entry: params.entry
	});
}
function setAbortedAgentDedupeEntries(params) {
	setGatewayDedupeEntries({
		dedupe: params.dedupe,
		keys: params.keys,
		entry: {
			ts: Date.now(),
			ok: true,
			payload: {
				runId: params.runId,
				status: "timeout",
				summary: "aborted",
				stopReason: params.stopReason,
				timeoutPhase: "queue",
				providerStarted: false
			}
		}
	});
}
function readAgentRunTimeoutAttribution(meta) {
	const record = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : void 0;
	return {
		timeoutPhase: normalizeAgentRunTimeoutPhase(record?.timeoutPhase),
		providerStarted: normalizeProviderStarted(record?.providerStarted)
	};
}
function resolveAbortedAgentStopReason(entry) {
	return entry?.abortStopReason?.trim() || "rpc";
}
function deleteGatewayDedupeEntries(params) {
	for (const key of params.keys) params.dedupe.delete(key);
}
function dispatchAgentRunFromGateway(params) {
	const inputProvenance = normalizeInputProvenance(params.ingressOpts.inputProvenance);
	const shouldTrackTask = params.ingressOpts.sessionKey?.trim() && inputProvenance?.kind !== "inter_session";
	if (shouldTrackTask) try {
		createRunningTaskRun({
			runtime: "cli",
			sourceId: params.runId,
			ownerKey: params.ingressOpts.sessionKey,
			scopeKind: "session",
			requesterOrigin: normalizeDeliveryContext({
				channel: params.ingressOpts.channel,
				to: params.ingressOpts.to,
				accountId: params.ingressOpts.accountId,
				threadId: params.ingressOpts.threadId
			}),
			childSessionKey: params.ingressOpts.sessionKey,
			runId: params.runId,
			task: params.ingressOpts.message,
			deliveryStatus: "not_applicable",
			startedAt: Date.now()
		});
	} catch {}
	agentCommandFromIngress(params.ingressOpts, defaultRuntime, params.context.deps).then((result) => {
		const aborted = result?.meta?.aborted === true;
		const timeoutAttribution = readAgentRunTimeoutAttribution(result?.meta);
		if (shouldTrackTask) tryFinalizeTrackedAgentTask({
			runId: params.runId,
			status: aborted ? "timed_out" : "succeeded",
			terminalSummary: aborted ? "aborted" : "completed"
		});
		const payload = {
			runId: params.runId,
			status: aborted ? "timeout" : "ok",
			summary: aborted ? "aborted" : "completed",
			...aborted ? { stopReason: result?.meta?.stopReason ?? "rpc" } : {},
			...aborted && timeoutAttribution.timeoutPhase ? { timeoutPhase: timeoutAttribution.timeoutPhase } : {},
			...aborted && timeoutAttribution.providerStarted !== void 0 ? { providerStarted: timeoutAttribution.providerStarted } : {},
			result
		};
		setGatewayDedupeEntries({
			dedupe: params.context.dedupe,
			keys: params.dedupeKeys,
			entry: {
				ts: Date.now(),
				ok: true,
				payload
			}
		});
		params.respond(true, payload, void 0, { runId: params.runId });
	}).catch((err) => {
		const aborted = isAbortError(err);
		const renderedErr = formatForLog(err);
		if (shouldTrackTask) tryFinalizeTrackedAgentTask({
			runId: params.runId,
			status: resolveFailedTrackedAgentTaskStatus(err),
			error: renderedErr,
			terminalSummary: renderedErr
		});
		const error = errorShape(ErrorCodes.UNAVAILABLE, renderedErr);
		const payload = {
			runId: params.runId,
			status: aborted ? "timeout" : "error",
			summary: aborted ? "aborted" : renderedErr,
			...aborted ? {
				stopReason: "rpc",
				timeoutPhase: "gateway_draining"
			} : {}
		};
		setGatewayDedupeEntries({
			dedupe: params.context.dedupe,
			keys: params.dedupeKeys,
			entry: {
				ts: Date.now(),
				ok: aborted,
				payload,
				...aborted ? {} : { error }
			}
		});
		params.respond(aborted, payload, aborted ? void 0 : error, {
			runId: params.runId,
			...aborted ? {} : { error: formatForLog(err) }
		});
	}).finally(() => {
		if (params.context.chatAbortControllers.get(params.runId)?.controller === params.abortController) params.context.chatAbortControllers.delete(params.runId);
	});
}
function shouldSuppressAgentPromptPersistence(params) {
	if (params.inputProvenance?.kind !== "inter_session" || params.inputProvenance.sourceTool !== "subagent_announce") return false;
	return params.internalEvents?.some((event) => event.type === "task_completion" && event.source === "subagent") === true;
}
function yieldAfterAgentAcceptedAck() {
	return new Promise((resolve) => {
		setTimeout(resolve, 10);
	});
}
const agentHandlers = {
	agent: async ({ params, respond, context, client, isWebchatConnect }) => {
		const p = params;
		if (!validateAgentParams(p)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent params: ${formatValidationErrors(validateAgentParams.errors)}`));
			return;
		}
		const request = p;
		const allowModelOverride = resolveAllowModelOverrideFromClient(client);
		const canResetSession = resolveCanResetSessionFromClient(client);
		const canUseInternalRuntimeHandoff = resolveCanUseInternalRuntimeHandoff(client);
		const requestedModelOverride = Boolean(request.provider || request.model);
		const isRawModelRun = request.modelRun === true || request.promptMode === "none";
		if (requestedModelOverride && !allowModelOverride) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "provider/model overrides are not authorized for this caller."));
			return;
		}
		const providerOverride = allowModelOverride ? request.provider : void 0;
		const modelOverride = allowModelOverride ? request.model : void 0;
		const cfg = context.getRuntimeConfig();
		const idem = request.idempotencyKey;
		const runId = idem;
		const execApprovalFollowupApprovalId = parseExecApprovalFollowupApprovalId(idem);
		if (execApprovalFollowupApprovalId && !canUseInternalRuntimeHandoff) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "exec approval followup idempotency keys are reserved for backend callers."));
			return;
		}
		const normalizedSpawned = normalizeSpawnedRunMetadata({
			groupId: request.groupId,
			groupChannel: request.groupChannel,
			groupSpace: request.groupSpace
		});
		let resolvedGroupId = normalizedSpawned.groupId;
		let resolvedGroupChannel = normalizedSpawned.groupChannel;
		let resolvedGroupSpace = normalizedSpawned.groupSpace;
		let spawnedByValue;
		const inputProvenance = normalizeInputProvenance(request.inputProvenance);
		const agentDedupeKeys = resolveAgentDedupeKeys({
			idempotencyKey: idem,
			execApprovalFollowupApprovalId
		});
		const cached = readGatewayDedupeEntry({
			dedupe: context.dedupe,
			keys: agentDedupeKeys
		});
		if (cached) {
			if (cached.ok && isAcceptedAgentDedupePayload(cached.payload)) {
				const cachedRunId = typeof cached.payload.runId === "string" && cached.payload.runId.trim() ? cached.payload.runId.trim() : runId;
				const cachedSessionKey = typeof cached.payload.sessionKey === "string" && cached.payload.sessionKey.trim() ? cached.payload.sessionKey.trim() : void 0;
				respond(true, {
					runId: cachedRunId,
					status: "in_flight",
					...cachedSessionKey ? { sessionKey: cachedSessionKey } : {}
				}, void 0, {
					cached: true,
					runId: cachedRunId
				});
				return;
			}
			respond(cached.ok, cached.payload, cached.error, { cached: true });
			return;
		}
		let agentDedupeReserved = false;
		let agentRunAccepted = false;
		const ownerConnId = typeof client?.connId === "string" ? client.connId : void 0;
		const ownerDeviceId = typeof client?.connect?.device?.id === "string" ? client.connect.device.id : void 0;
		const reservePreAcceptedAgentDedupe = (sessionKey) => {
			if (agentDedupeReserved || !sessionKey) return;
			const acceptedAt = Date.now();
			const pendingTimeoutMs = resolveAgentTimeoutMs({
				cfg,
				overrideSeconds: typeof request.timeout === "number" ? request.timeout : void 0
			});
			setGatewayDedupeEntries({
				dedupe: context.dedupe,
				keys: agentDedupeKeys,
				entry: {
					ts: acceptedAt,
					ok: true,
					payload: {
						runId,
						status: "accepted",
						sessionKey,
						acceptedAt,
						dedupeKeys: agentDedupeKeys,
						expiresAtMs: resolveAgentRunExpiresAtMs({
							now: acceptedAt,
							timeoutMs: pendingTimeoutMs
						}),
						ownerConnId,
						ownerDeviceId
					}
				}
			});
			agentDedupeReserved = true;
		};
		const clearUnacceptedExecApprovalFollowupDedupe = () => {
			if (!agentDedupeReserved || agentRunAccepted) return;
			if (isPreRegistrationAbortedAgentDedupeEntryForSession({
				entry: readGatewayDedupeEntry({
					dedupe: context.dedupe,
					keys: agentDedupeKeys
				}),
				runId
			})) return;
			deleteGatewayDedupeEntries({
				dedupe: context.dedupe,
				keys: agentDedupeKeys
			});
			agentDedupeReserved = false;
		};
		const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(request.attachments);
		const requestedBestEffortDeliver = typeof request.bestEffortDeliver === "boolean" ? request.bestEffortDeliver : void 0;
		const knownAgents = listAgentIds(cfg);
		const agentIdRaw = normalizeOptionalString$1(request.agentId) ?? "";
		let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : void 0;
		if (agentId && !knownAgents.includes(agentId)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent params: unknown agent id "${request.agentId}"`));
			return;
		}
		const requestedSessionKeyRaw = normalizeOptionalString$1(request.sessionKey);
		if (requestedSessionKeyRaw && classifySessionKeyShape(requestedSessionKeyRaw) === "malformed_agent") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent params: malformed session key "${requestedSessionKeyRaw}"`));
			return;
		}
		const requestedSessionId = normalizeOptionalString$1(request.sessionId);
		let requestedSessionKey = requestedSessionKeyRaw ?? (!requestedSessionId ? resolveExplicitAgentSessionKey({
			cfg,
			agentId
		}) : void 0);
		if (agentId && requestedSessionKeyRaw) {
			const sessionAgentId = resolveAgentIdFromSessionKey(requestedSessionKeyRaw);
			if (sessionAgentId !== agentId) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent params: agent "${request.agentId}" does not match session key agent "${sessionAgentId}"`));
				return;
			}
		}
		const preAcceptedReservedSessionKey = requestedSessionKey;
		reservePreAcceptedAgentDedupe(preAcceptedReservedSessionKey);
		try {
			let message = (request.message ?? "").trim();
			if (!isRawModelRun) message = annotateInterSessionPromptText(message, inputProvenance);
			let images = [];
			let imageOrder = [];
			if (normalizedAttachments.length > 0) {
				let baseProvider;
				let baseModel;
				if (requestedSessionKeyRaw) {
					const { cfg: sessCfg, entry: sessEntry } = loadSessionEntry(requestedSessionKeyRaw);
					const modelRef = resolveSessionModelRef(sessCfg, sessEntry, resolveAgentIdFromSessionKey(requestedSessionKeyRaw));
					baseProvider = modelRef.provider;
					baseModel = modelRef.model;
				}
				const effectiveProvider = providerOverride || baseProvider;
				const effectiveModel = modelOverride || baseModel;
				const supportsInlineImages = await resolveGatewayModelSupportsImages({
					loadGatewayModelCatalog: context.loadGatewayModelCatalog,
					provider: effectiveProvider,
					model: effectiveModel
				});
				try {
					const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
						maxBytes: resolveChatAttachmentMaxBytes(cfg),
						log: context.logGateway,
						supportsInlineImages,
						acceptNonImage: false
					});
					message = parsed.message.trim();
					images = parsed.images;
					imageOrder = parsed.imageOrder;
				} catch (err) {
					logAttachmentFailure(context.logGateway, "agent attachment parse failed", err);
					respond(false, void 0, errorShape(err instanceof MediaOffloadError ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST, String(err)));
					return;
				}
			}
			const isKnownGatewayChannel = (value) => isGatewayMessageChannel(value) || isInternalNonDeliveryChannel(value);
			const channelHints = [request.channel, request.replyChannel].filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean);
			for (const rawChannel of channelHints) {
				const normalized = normalizeMessageChannel(rawChannel);
				if (normalized && normalized !== "last" && !isKnownGatewayChannel(normalized)) {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent params: unknown channel: ${normalized}`));
					return;
				}
			}
			const voiceWakeTrigger = normalizeOptionalString$1(request.voiceWakeTrigger) ?? "";
			const replyTo = normalizeOptionalString$1(request.replyTo) ?? "";
			const to = normalizeOptionalString$1(request.to) ?? "";
			const explicitVoiceWakeSessionTarget = !agentId && requestedSessionKeyRaw ? (() => {
				const { cfg: sessionCfg, canonicalKey } = loadSessionEntry(requestedSessionKeyRaw);
				const routedAgentId = resolveAgentIdFromSessionKey(canonicalKey);
				if (routedAgentId !== normalizeAgentId(resolveDefaultAgentId(sessionCfg))) return true;
				return canonicalKey !== resolveAgentMainSessionKey({
					cfg: sessionCfg,
					agentId: routedAgentId
				});
			})() : false;
			const canAutoRouteVoiceWake = !agentId && !explicitVoiceWakeSessionTarget && !requestedSessionId && !replyTo && !to;
			if (Object.prototype.hasOwnProperty.call(request, "voiceWakeTrigger") && canAutoRouteVoiceWake) try {
				const routingConfig = await loadVoiceWakeRoutingConfig();
				const route = resolveVoiceWakeRouteByTrigger({
					trigger: voiceWakeTrigger || void 0,
					config: routingConfig
				});
				if ("agentId" in route) if (knownAgents.includes(route.agentId)) {
					agentId = route.agentId;
					requestedSessionKey = resolveExplicitAgentSessionKey({
						cfg,
						agentId
					});
				} else context.logGateway.warn(`voicewake routing ignored unknown agentId="${route.agentId}" trigger="${voiceWakeTrigger}"`);
				else if ("sessionKey" in route) if (classifySessionKeyShape(route.sessionKey) !== "malformed_agent") {
					const canonicalRouteSession = loadSessionEntry(route.sessionKey).canonicalKey;
					const routedAgentId = resolveAgentIdFromSessionKey(canonicalRouteSession);
					if (knownAgents.includes(routedAgentId)) {
						requestedSessionKey = canonicalRouteSession;
						agentId = routedAgentId;
					} else context.logGateway.warn(`voicewake routing ignored unknown session agent="${routedAgentId}" sessionKey="${canonicalRouteSession}" trigger="${voiceWakeTrigger}"`);
				} else context.logGateway.warn(`voicewake routing ignored malformed sessionKey="${route.sessionKey}" trigger="${voiceWakeTrigger}"`);
			} catch (err) {
				context.logGateway.warn(`voicewake routing load failed: ${formatForLog(err)}`);
			}
			let resolvedSessionId = requestedSessionId;
			let sessionEntry;
			let bestEffortDeliver = requestedBestEffortDeliver ?? false;
			let cfgForAgent;
			let resolvedSessionKey = requestedSessionKey;
			let isNewSession = false;
			let skipTimestampInjection = false;
			let shouldPrependStartupContext = false;
			const resetCommandMatch = message.match(RESET_COMMAND_RE);
			if (resetCommandMatch && requestedSessionKey) {
				if (!canResetSession) {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${ADMIN_SCOPE$1}`));
					return;
				}
				const resetReason = normalizeOptionalLowercaseString(resetCommandMatch[1]) === "new" ? "new" : "reset";
				const resetResult = await runSessionResetFromAgent({
					key: requestedSessionKey,
					reason: resetReason
				});
				if (!resetResult.ok) {
					respond(false, void 0, resetResult.error);
					return;
				}
				requestedSessionKey = resetResult.key;
				resolvedSessionId = resetResult.sessionId ?? resolvedSessionId;
				const postResetMessage = normalizeOptionalString$1(resetCommandMatch[2]) ?? "";
				if (postResetMessage) message = postResetMessage;
				else {
					const resetLoadedSession = loadSessionEntry(requestedSessionKey);
					const resetCfg = resetLoadedSession?.cfg ?? cfg;
					const resetSessionEntry = resetLoadedSession?.entry;
					const resetSpawnedBy = canonicalizeSpawnedByForAgent(resetCfg, resolveAgentIdFromSessionKey(requestedSessionKey), resetSessionEntry?.spawnedBy);
					const { runtimeWorkspaceDir, isCanonicalWorkspace } = resolveSessionRuntimeWorkspace({
						cfg: resetCfg,
						sessionKey: requestedSessionKey,
						sessionEntry: resetSessionEntry,
						spawnedBy: resetSpawnedBy
					});
					const resetSessionAgentId = resolveAgentIdFromSessionKey(requestedSessionKey);
					const resetBaseModelRef = resolveSessionModelRef(resetCfg, resetSessionEntry, resetSessionAgentId);
					const resetEffectiveModelRef = {
						provider: providerOverride || resetBaseModelRef.provider,
						model: modelOverride || resetBaseModelRef.model
					};
					const bareResetPromptState = await resolveBareSessionResetPromptState({
						cfg: resetCfg,
						workspaceDir: runtimeWorkspaceDir,
						isPrimaryRun: !isSubagentSessionKey(requestedSessionKey) && !isAcpSessionKey(requestedSessionKey),
						isCanonicalWorkspace,
						hasBootstrapFileAccess: resolveBareResetBootstrapFileAccess({
							cfg: resetCfg,
							agentId: resetSessionAgentId,
							sessionKey: requestedSessionKey,
							workspaceDir: runtimeWorkspaceDir,
							modelProvider: resetEffectiveModelRef.provider,
							modelId: resetEffectiveModelRef.model
						})
					});
					message = bareResetPromptState.prompt;
					skipTimestampInjection = true;
					shouldPrependStartupContext = bareResetPromptState.shouldPrependStartupContext && shouldApplyStartupContext({
						cfg,
						action: resetReason
					});
				}
			}
			if (!skipTimestampInjection && !isRawModelRun && inputProvenance?.kind !== "inter_session") message = injectTimestamp(message, timestampOptsFromConfig(cfg));
			if (requestedSessionKey) {
				const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(requestedSessionKey);
				cfgForAgent = cfg;
				const now = Date.now();
				const resetPolicy = resolveSessionResetPolicy({
					sessionCfg: cfg.session,
					resetType: resolveSessionResetType({ sessionKey: canonicalKey }),
					resetOverride: resolveChannelResetConfig({
						sessionCfg: cfg.session,
						channel: entry?.lastChannel ?? entry?.channel ?? request.channel
					})
				});
				const freshness = entry ? evaluateSessionFreshness({
					updatedAt: entry.updatedAt,
					...resolveSessionLifecycleTimestamps({
						entry,
						storePath,
						agentId: resolveAgentIdFromSessionKey(canonicalKey)
					}),
					now,
					policy: resetPolicy
				}) : void 0;
				let failedSessionTranscriptMissing = false;
				if (entry?.status === "failed" && entry.sessionId?.trim()) try {
					const sessionPathOpts = resolveSessionFilePathOptions({
						storePath,
						agentId: resolveAgentIdFromSessionKey(canonicalKey)
					});
					failedSessionTranscriptMissing = !existsSync(resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts));
				} catch {
					failedSessionTranscriptMissing = true;
				}
				const canReuseSession = Boolean(entry?.sessionId) && (freshness?.fresh ?? false) && !failedSessionTranscriptMissing;
				const usableRequestedSessionId = requestedSessionId && (!entry?.sessionId || canReuseSession) ? requestedSessionId : void 0;
				const sessionId = usableRequestedSessionId ? usableRequestedSessionId : (canReuseSession ? entry?.sessionId : void 0) ?? randomUUID();
				isNewSession = !entry || !canReuseSession && !usableRequestedSessionId || Boolean(usableRequestedSessionId && entry?.sessionId !== usableRequestedSessionId);
				const rotatedSessionId = Boolean(entry?.sessionId && entry.sessionId !== sessionId);
				const touchInteraction = request.bootstrapContextRunKind !== "cron" && request.bootstrapContextRunKind !== "heartbeat" && !request.internalEvents?.length;
				const sessionAgent = resolveAgentIdFromSessionKey(canonicalKey);
				const requestDeliveryHint = normalizeDeliveryContext({
					channel: request.channel?.trim(),
					to: request.to?.trim(),
					accountId: request.accountId?.trim(),
					threadId: request.threadId
				});
				const buildSessionPatch = (freshEntry) => {
					const freshSpawnedBy = canonicalizeSpawnedByForAgent(cfg, sessionAgent, freshEntry?.spawnedBy);
					const storedGroup = normalizeTrustedGroupMetadata(freshEntry);
					let inheritedGroup;
					if (freshSpawnedBy && (!storedGroup.groupId || !storedGroup.groupChannel || !storedGroup.groupSpace)) try {
						const parentEntry = loadSessionEntry(freshSpawnedBy)?.entry;
						inheritedGroup = normalizeTrustedGroupMetadata({
							groupId: parentEntry?.groupId,
							groupChannel: parentEntry?.groupChannel,
							groupSpace: parentEntry?.space
						});
					} catch {
						inheritedGroup = void 0;
					}
					const trustedGroup = resolveTrustedGroupMetadata({
						sessionKey: canonicalKey,
						spawnedBy: freshSpawnedBy,
						stored: storedGroup,
						inherited: inheritedGroup
					});
					const nextGroup = (trustedGroup.groupId ? resolveTrustedGroupId({
						groupId: trustedGroup.groupId,
						sessionKey: canonicalKey,
						spawnedBy: freshSpawnedBy
					}) : void 0)?.dropped === true ? {
						groupId: void 0,
						groupChannel: void 0,
						groupSpace: void 0
					} : (() => {
						const trustRequestSelectors = Boolean(trustedGroup.groupId) && requestGroupMatchesTrusted({
							requestGroupId: normalizedSpawned.groupId,
							trustedGroupId: trustedGroup.groupId
						});
						return {
							groupId: trustedGroup.groupId,
							groupChannel: trustedGroup.groupChannel ?? (trustRequestSelectors ? normalizedSpawned.groupChannel : void 0),
							groupSpace: trustedGroup.groupSpace ?? (trustRequestSelectors ? normalizedSpawned.groupSpace : void 0)
						};
					})();
					const deliveryFields = normalizeSessionDeliveryFields(freshEntry);
					const effectiveDelivery = mergeDeliveryContext(deliveryFields.deliveryContext, requestDeliveryHint);
					const effectiveDeliveryFields = normalizeSessionDeliveryFields({
						route: deliveryFields.route,
						deliveryContext: effectiveDelivery
					});
					const labelValue = normalizeOptionalString$1(request.label) || freshEntry?.label;
					const channelValue = freshEntry?.channel ?? request.channel?.trim();
					const pluginOwnerId = freshEntry === void 0 ? normalizeOptionalString$1(client?.internal?.pluginRuntimeOwnerId) : void 0;
					const freshSessionRotatedSinceLoad = Boolean(entry?.sessionId && freshEntry?.sessionId && freshEntry.sessionId !== entry.sessionId);
					const patchSessionId = freshSessionRotatedSinceLoad ? freshEntry?.sessionId : sessionId;
					const shouldClearRotatedState = rotatedSessionId && !freshSessionRotatedSinceLoad;
					return {
						patch: {
							sessionId: patchSessionId,
							updatedAt: now,
							...isNewSession && !freshSessionRotatedSinceLoad ? { sessionStartedAt: now } : {},
							...touchInteraction ? { lastInteractionAt: now } : {},
							...effectiveDeliveryFields.route ? { route: effectiveDeliveryFields.route } : {},
							...effectiveDeliveryFields.deliveryContext ? { deliveryContext: effectiveDeliveryFields.deliveryContext } : {},
							...effectiveDeliveryFields.lastChannel ? { lastChannel: effectiveDeliveryFields.lastChannel } : {},
							...effectiveDeliveryFields.lastTo ? { lastTo: effectiveDeliveryFields.lastTo } : {},
							...effectiveDeliveryFields.lastAccountId ? { lastAccountId: effectiveDeliveryFields.lastAccountId } : {},
							...effectiveDeliveryFields.lastThreadId != null ? { lastThreadId: effectiveDeliveryFields.lastThreadId } : {},
							...labelValue ? { label: labelValue } : {},
							...freshSpawnedBy ? { spawnedBy: freshSpawnedBy } : {},
							...channelValue ? { channel: channelValue } : {},
							groupId: nextGroup.groupId,
							groupChannel: nextGroup.groupChannel,
							space: nextGroup.groupSpace,
							...pluginOwnerId ? { pluginOwnerId } : {},
							...shouldClearRotatedState ? {
								status: void 0,
								startedAt: void 0,
								endedAt: void 0,
								runtimeMs: void 0,
								abortedLastRun: void 0,
								sessionFile: void 0
							} : {}
						},
						spawnedBy: freshSpawnedBy,
						groupId: nextGroup.groupId,
						groupChannel: nextGroup.groupChannel,
						groupSpace: nextGroup.groupSpace
					};
				};
				let patchBuild = buildSessionPatch(entry);
				sessionEntry = mergeSessionEntry(entry, patchBuild.patch);
				resolvedSessionId = sessionEntry?.sessionId ?? sessionId;
				const canonicalSessionKey = canonicalKey;
				resolvedSessionKey = canonicalSessionKey;
				const agentId = resolveAgentIdFromSessionKey(canonicalSessionKey);
				const mainSessionKey = resolveAgentMainSessionKey({
					cfg,
					agentId
				});
				const recoveredSessionStartedAt = !isNewSession && entry !== void 0 && entry.sessionStartedAt === void 0 ? resolveSessionLifecycleTimestamps({
					entry,
					storePath,
					agentId
				}).sessionStartedAt : void 0;
				if (storePath) {
					const requestedStoreKey = requestedSessionKey;
					let deniedBySendPolicy = false;
					const persisted = await updateSessionStore(storePath, (store) => {
						const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
							cfg,
							key: requestedStoreKey,
							store
						});
						const freshEntry = store[primaryKey];
						patchBuild = buildSessionPatch(freshEntry);
						const merged = mergeSessionEntry(freshEntry, recoveredSessionStartedAt !== void 0 && freshEntry?.sessionStartedAt === void 0 && freshEntry?.sessionId === entry?.sessionId ? {
							...patchBuild.patch,
							sessionStartedAt: recoveredSessionStartedAt
						} : patchBuild.patch);
						if ((request.deliver === true ? resolveSendPolicy({
							cfg,
							entry: merged,
							sessionKey: canonicalKey,
							channel: merged?.channel,
							chatType: merged?.chatType
						}) : "allow") === "deny") {
							deniedBySendPolicy = true;
							return merged;
						}
						store[primaryKey] = merged;
						return merged;
					});
					if (persisted) {
						sessionEntry = persisted;
						resolvedSessionId = sessionEntry.sessionId;
					}
					if (deniedBySendPolicy) {
						respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"));
						return;
					}
				}
				spawnedByValue = patchBuild.spawnedBy;
				resolvedGroupId = patchBuild.groupId;
				resolvedGroupChannel = patchBuild.groupChannel;
				resolvedGroupSpace = patchBuild.groupSpace;
				if (request.deliver === true) {
					if (resolveSendPolicy({
						cfg,
						entry: sessionEntry,
						sessionKey: canonicalKey,
						channel: sessionEntry?.channel,
						chatType: sessionEntry?.chatType
					}) === "deny") {
						respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"));
						return;
					}
				}
				if (canonicalSessionKey === mainSessionKey || canonicalSessionKey === "global") {
					context.addChatRun(idem, {
						sessionKey: canonicalSessionKey,
						clientRunId: idem
					});
					if (requestedBestEffortDeliver === void 0) bestEffortDeliver = true;
				}
				registerAgentRunContext(idem, { sessionKey: canonicalSessionKey });
			}
			const connId = typeof client?.connId === "string" ? client.connId : void 0;
			const wantsToolEvents = hasGatewayClientCap(client?.connect?.caps, GATEWAY_CLIENT_CAPS.TOOL_EVENTS);
			if (connId && wantsToolEvents) {
				context.registerToolEventRecipient(runId, connId);
				for (const [activeRunId, active] of context.chatAbortControllers) if (activeRunId !== runId && active.sessionKey === requestedSessionKey) context.registerToolEventRecipient(activeRunId, connId);
			}
			const wantsDelivery = request.deliver === true;
			const explicitTo = normalizeOptionalString$1(request.replyTo) ?? normalizeOptionalString$1(request.to);
			const explicitThreadId = normalizeOptionalString$1(request.threadId);
			const turnSourceChannel = normalizeOptionalString$1(request.channel);
			const turnSourceTo = normalizeOptionalString$1(request.to);
			const turnSourceAccountId = normalizeOptionalString$1(request.accountId);
			const deliveryPlan = resolveAgentDeliveryPlan({
				sessionEntry,
				requestedChannel: request.replyChannel ?? request.channel,
				explicitTo,
				explicitThreadId,
				accountId: request.replyAccountId ?? request.accountId,
				wantsDelivery,
				turnSourceChannel,
				turnSourceTo,
				turnSourceAccountId,
				turnSourceThreadId: explicitThreadId
			});
			let resolvedChannel = deliveryPlan.resolvedChannel;
			let deliveryTargetMode = deliveryPlan.deliveryTargetMode;
			let resolvedAccountId = deliveryPlan.resolvedAccountId;
			let resolvedTo = deliveryPlan.resolvedTo;
			let effectivePlan = deliveryPlan;
			let deliveryDowngradeReason = null;
			let deliveryTargetResolutionError;
			if (wantsDelivery && resolvedChannel === "webchat") {
				const cfgResolved = cfgForAgent ?? cfg;
				try {
					resolvedChannel = (await resolveMessageChannelSelection({ cfg: cfgResolved })).channel;
					deliveryTargetMode = deliveryTargetMode ?? "implicit";
					effectivePlan = {
						...deliveryPlan,
						resolvedChannel,
						deliveryTargetMode,
						resolvedAccountId
					};
				} catch (err) {
					if (!shouldDowngradeDeliveryToSessionOnly({
						wantsDelivery,
						bestEffortDeliver,
						resolvedChannel
					})) {
						respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
						return;
					}
					deliveryDowngradeReason = String(err);
				}
			}
			if (!resolvedTo && isDeliverableMessageChannel(resolvedChannel)) {
				const fallback = resolveAgentOutboundTarget({
					cfg: cfgForAgent ?? cfg,
					plan: effectivePlan,
					targetMode: deliveryTargetMode ?? "implicit",
					validateExplicitTarget: false
				});
				if (fallback.resolvedTarget?.ok) resolvedTo = fallback.resolvedTo;
				else if (fallback.resolvedTarget && !fallback.resolvedTarget.ok) deliveryTargetResolutionError = fallback.resolvedTarget.error;
			}
			if (wantsDelivery && isDeliverableMessageChannel(resolvedChannel) && !resolvedTo) {
				if (!bestEffortDeliver) {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, deliveryTargetResolutionError ? String(deliveryTargetResolutionError) : `delivery target is required for ${resolvedChannel}: pass --to/--reply-to or configure a default target`));
					return;
				}
				context.logGateway.info(deliveryTargetResolutionError ? `agent delivery target missing (bestEffortDeliver): ${String(deliveryTargetResolutionError)}` : "agent delivery target missing (bestEffortDeliver): no deliverable target");
			}
			if (wantsDelivery && resolvedChannel === "webchat") {
				if (!shouldDowngradeDeliveryToSessionOnly({
					wantsDelivery,
					bestEffortDeliver,
					resolvedChannel
				})) {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel"));
					return;
				}
				context.logGateway.info(deliveryDowngradeReason ? `agent delivery downgraded to session-only (bestEffortDeliver): ${deliveryDowngradeReason}` : "agent delivery downgraded to session-only (bestEffortDeliver): no deliverable channel");
			}
			const normalizedTurnSource = normalizeMessageChannel(turnSourceChannel);
			const originMessageChannel = (normalizedTurnSource && isKnownGatewayChannel(normalizedTurnSource) ? normalizedTurnSource : void 0) ?? (client?.connect && isWebchatConnect(client.connect) ? "webchat" : resolvedChannel);
			const deliver = request.deliver === true && resolvedChannel !== "webchat";
			const preRegistrationAbort = readGatewayDedupeEntry({
				dedupe: context.dedupe,
				keys: agentDedupeKeys
			});
			if (isPreRegistrationAbortedAgentDedupeEntryForSession({
				entry: preRegistrationAbort,
				runId,
				sessionKey: resolvedSessionKey,
				alternateSessionKeys: [preAcceptedReservedSessionKey, requestedSessionKey]
			})) {
				agentRunAccepted = true;
				respond(true, preRegistrationAbort?.payload, void 0, {
					cached: true,
					runId
				});
				return;
			}
			const now = Date.now();
			const timeoutMs = resolveAgentTimeoutMs({
				cfg: cfgForAgent ?? cfg,
				overrideSeconds: typeof request.timeout === "number" ? request.timeout : void 0
			});
			const activeModelProvider = providerOverride ?? resolveSessionModelRef(cfgForAgent ?? cfg, sessionEntry, resolvedSessionKey ? resolveAgentIdFromSessionKey(resolvedSessionKey) : agentId ?? resolveDefaultAgentId(cfgForAgent ?? cfg)).provider;
			const activeAuthProvider = resolveProviderIdForAuth(activeModelProvider, { config: cfgForAgent ?? cfg });
			const activeRunAbort = registerChatAbortController({
				chatAbortControllers: context.chatAbortControllers,
				runId,
				sessionId: resolvedSessionId ?? runId,
				sessionKey: resolvedSessionKey,
				timeoutMs,
				now,
				expiresAtMs: resolveAgentRunExpiresAtMs({
					now,
					timeoutMs
				}),
				ownerConnId,
				ownerDeviceId,
				providerId: activeModelProvider,
				authProviderId: activeAuthProvider,
				kind: "agent"
			});
			const existingRunAbort = context.chatAbortControllers.get(runId);
			if (!activeRunAbort.registered && existingRunAbort) {
				agentRunAccepted = existingRunAbort.kind === "agent";
				respond(true, {
					runId,
					status: "in_flight"
				}, void 0, {
					cached: true,
					runId
				});
				return;
			}
			const accepted = {
				runId,
				sessionKey: resolvedSessionKey,
				status: "accepted",
				acceptedAt: Date.now()
			};
			const acceptedDedupePayload = {
				...accepted,
				dedupeKeys: agentDedupeKeys,
				ownerConnId,
				ownerDeviceId
			};
			agentRunAccepted = true;
			setGatewayDedupeEntries({
				dedupe: context.dedupe,
				keys: agentDedupeKeys,
				entry: {
					ts: Date.now(),
					ok: true,
					payload: acceptedDedupePayload
				}
			});
			respond(true, accepted, void 0, { runId });
			(async () => {
				await yieldAfterAgentAcceptedAck();
				let dispatched = false;
				try {
					if (activeRunAbort.controller.signal.aborted) {
						const stopReason = resolveAbortedAgentStopReason(activeRunAbort.entry);
						setAbortedAgentDedupeEntries({
							dedupe: context.dedupe,
							keys: agentDedupeKeys,
							runId,
							stopReason
						});
						respond(true, {
							runId,
							status: "timeout",
							summary: "aborted",
							stopReason,
							timeoutPhase: "queue",
							providerStarted: false
						}, void 0, { runId });
						return;
					}
					if (resolvedSessionKey) await reactivateCompletedSubagentSession({
						sessionKey: resolvedSessionKey,
						runId
					});
					if (requestedSessionKey && resolvedSessionKey && isNewSession) emitSessionsChanged$1(context, {
						sessionKey: resolvedSessionKey,
						reason: "create"
					});
					if (resolvedSessionKey) emitSessionsChanged$1(context, {
						sessionKey: resolvedSessionKey,
						reason: "send"
					});
					if (shouldPrependStartupContext && resolvedSessionKey) {
						const startupCfg = cfgForAgent ?? cfg;
						if (!shouldSkipStartupContextForSpawnedSandbox({
							cfg: startupCfg,
							sessionKey: resolvedSessionKey,
							spawnedBy: spawnedByValue
						})) {
							const { runtimeWorkspaceDir } = resolveSessionRuntimeWorkspace({
								cfg: startupCfg,
								sessionKey: resolvedSessionKey,
								sessionEntry,
								spawnedBy: spawnedByValue
							});
							const startupContextPrelude = await buildSessionStartupContextPrelude({
								workspaceDir: runtimeWorkspaceDir,
								cfg: startupCfg
							});
							if (startupContextPrelude) message = `${startupContextPrelude}\n\n${message}`;
						}
					}
					if (!isRawModelRun) message = annotateInterSessionPromptText(message, inputProvenance);
					const resolvedThreadId = explicitThreadId ?? deliveryPlan.resolvedThreadId;
					const ingressAgentId = agentId && (!resolvedSessionKey || resolveAgentIdFromSessionKey(resolvedSessionKey) === agentId) ? agentId : void 0;
					let execApprovalFollowupRuntimeHandoff = canUseInternalRuntimeHandoff && execApprovalFollowupApprovalId ? consumeExecApprovalFollowupRuntimeHandoff({
						handoffId: request.internalRuntimeHandoffId,
						approvalId: execApprovalFollowupApprovalId,
						idempotencyKey: idem,
						sessionKey: resolvedSessionKey
					}) : void 0;
					if (!execApprovalFollowupRuntimeHandoff && canUseInternalRuntimeHandoff && execApprovalFollowupApprovalId && requestedSessionKeyRaw && requestedSessionKeyRaw !== resolvedSessionKey) execApprovalFollowupRuntimeHandoff = consumeExecApprovalFollowupRuntimeHandoff({
						handoffId: request.internalRuntimeHandoffId,
						approvalId: execApprovalFollowupApprovalId,
						idempotencyKey: idem,
						sessionKey: requestedSessionKeyRaw
					});
					const execApprovalFollowupElevatedDefaults = execApprovalFollowupRuntimeHandoff?.bashElevated;
					dispatchAgentRunFromGateway({
						ingressOpts: {
							message,
							images,
							imageOrder,
							agentId: ingressAgentId,
							provider: providerOverride,
							model: modelOverride,
							to: resolvedTo,
							sessionId: resolvedSessionId,
							sessionKey: resolvedSessionKey,
							thinking: request.thinking,
							deliver,
							deliveryTargetMode,
							channel: resolvedChannel,
							accountId: resolvedAccountId,
							threadId: resolvedThreadId,
							runContext: {
								messageChannel: originMessageChannel,
								accountId: resolvedAccountId,
								groupId: resolvedGroupId,
								groupChannel: resolvedGroupChannel,
								groupSpace: resolvedGroupSpace,
								currentThreadTs: resolvedThreadId != null ? String(resolvedThreadId) : void 0
							},
							...execApprovalFollowupElevatedDefaults ? { bashElevated: execApprovalFollowupElevatedDefaults } : {},
							groupId: resolvedGroupId,
							groupChannel: resolvedGroupChannel,
							groupSpace: resolvedGroupSpace,
							spawnedBy: spawnedByValue,
							timeout: request.timeout?.toString(),
							bestEffortDeliver,
							messageChannel: originMessageChannel,
							runId,
							lane: request.lane,
							modelRun: request.modelRun === true,
							promptMode: request.promptMode,
							extraSystemPrompt: request.extraSystemPrompt,
							bootstrapContextMode: request.bootstrapContextMode,
							bootstrapContextRunKind: request.bootstrapContextRunKind,
							acpTurnSource: request.acpTurnSource,
							internalEvents: request.internalEvents,
							inputProvenance,
							sourceReplyDeliveryMode: request.sourceReplyDeliveryMode,
							suppressPromptPersistence: shouldSuppressAgentPromptPersistence({
								inputProvenance,
								internalEvents: request.internalEvents
							}),
							cleanupBundleMcpOnRunEnd: request.cleanupBundleMcpOnRunEnd,
							abortSignal: activeRunAbort.controller.signal,
							onActiveModelSelected: ({ provider }) => {
								updateChatRunProvider(context.chatAbortControllers, {
									runId,
									providerId: provider,
									authProviderId: resolveProviderIdForAuth(provider, { config: cfgForAgent ?? cfg })
								});
							},
							workspaceDir: resolveIngressWorkspaceOverrideForSpawnedRun({
								spawnedBy: spawnedByValue,
								workspaceDir: sessionEntry?.spawnedWorkspaceDir
							}),
							allowModelOverride
						},
						runId,
						dedupeKeys: agentDedupeKeys,
						abortController: activeRunAbort.controller,
						respond,
						context
					});
					dispatched = true;
				} catch (err) {
					const error = errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err));
					const payload = {
						runId,
						status: "error",
						summary: formatForLog(err)
					};
					setGatewayDedupeEntries({
						dedupe: context.dedupe,
						keys: agentDedupeKeys,
						entry: {
							ts: Date.now(),
							ok: false,
							payload,
							error
						}
					});
					respond(false, payload, error, {
						runId,
						error: formatForLog(err)
					});
				} finally {
					if (!dispatched) activeRunAbort.cleanup();
				}
			})();
		} finally {
			clearUnacceptedExecApprovalFollowupDedupe();
		}
	},
	"agent.identity.get": ({ params, respond, context }) => {
		if (!validateAgentIdentityParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent.identity.get params: ${formatValidationErrors(validateAgentIdentityParams.errors)}`));
			return;
		}
		const p = params;
		const agentIdRaw = normalizeOptionalString$1(p.agentId) ?? "";
		const sessionKeyRaw = normalizeOptionalString$1(p.sessionKey) ?? "";
		let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : void 0;
		if (sessionKeyRaw) {
			if (classifySessionKeyShape(sessionKeyRaw) === "malformed_agent") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent.identity.get params: malformed session key "${sessionKeyRaw}"`));
				return;
			}
			const resolved = resolveAgentIdFromSessionKey(sessionKeyRaw);
			if (agentId && resolved !== agentId) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent.identity.get params: agent "${agentIdRaw}" does not match session key agent "${resolved}"`));
				return;
			}
			agentId = resolved;
		}
		const cfg = context.getRuntimeConfig();
		const identity = resolveAssistantIdentity({
			cfg,
			agentId
		});
		const avatarValue = resolveAssistantAvatarUrl({
			avatar: identity.avatar,
			agentId: identity.agentId,
			basePath: cfg.gateway?.controlUi?.basePath
		}) ?? identity.avatar;
		const avatarResolution = resolveAgentAvatar(cfg, identity.agentId, { includeUiOverride: true });
		respond(true, {
			...identity,
			avatar: avatarValue,
			avatarSource: resolvePublicAgentAvatarSource(avatarResolution),
			avatarStatus: avatarResolution.kind,
			avatarReason: avatarResolution.kind === "none" ? avatarResolution.reason : void 0
		}, void 0);
	},
	"agent.wait": async ({ params, respond, context }) => {
		if (!validateAgentWaitParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent.wait params: ${formatValidationErrors(validateAgentWaitParams.errors)}`));
			return;
		}
		const p = params;
		const runId = (p.runId ?? "").trim();
		const timeoutMs = typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs) ? Math.max(0, Math.floor(p.timeoutMs)) : 3e4;
		const activeChatEntry = context.chatAbortControllers.get(runId);
		const hasActiveChatRun = activeChatEntry !== void 0 && activeChatEntry.kind !== "agent";
		const cachedGatewaySnapshot = readTerminalSnapshotFromGatewayDedupe({
			dedupe: context.dedupe,
			runId,
			ignoreAgentTerminalSnapshot: hasActiveChatRun
		});
		if (cachedGatewaySnapshot) {
			respond(true, {
				runId,
				status: cachedGatewaySnapshot.status,
				startedAt: cachedGatewaySnapshot.startedAt,
				endedAt: cachedGatewaySnapshot.endedAt,
				error: cachedGatewaySnapshot.error,
				stopReason: cachedGatewaySnapshot.stopReason,
				livenessState: cachedGatewaySnapshot.livenessState,
				yielded: cachedGatewaySnapshot.yielded,
				timeoutPhase: cachedGatewaySnapshot.timeoutPhase,
				providerStarted: cachedGatewaySnapshot.providerStarted
			});
			return;
		}
		const lifecycleAbortController = new AbortController();
		const dedupeAbortController = new AbortController();
		const lifecyclePromise = waitForAgentJob({
			runId,
			timeoutMs,
			signal: lifecycleAbortController.signal,
			ignoreCachedSnapshot: hasActiveChatRun
		});
		const dedupePromise = waitForTerminalGatewayDedupe({
			dedupe: context.dedupe,
			runId,
			timeoutMs,
			signal: dedupeAbortController.signal,
			ignoreAgentTerminalSnapshot: hasActiveChatRun
		});
		const first = await Promise.race([lifecyclePromise.then((snapshot) => ({
			source: "lifecycle",
			snapshot
		})), dedupePromise.then((snapshot) => ({
			source: "dedupe",
			snapshot
		}))]);
		let snapshot = first.snapshot;
		if (snapshot) if (first.source === "lifecycle") dedupeAbortController.abort();
		else lifecycleAbortController.abort();
		else {
			snapshot = first.source === "lifecycle" ? await dedupePromise : await lifecyclePromise;
			lifecycleAbortController.abort();
			dedupeAbortController.abort();
		}
		if (!snapshot) {
			const activeRunRegistered = activeChatEntry !== void 0;
			respond(true, {
				runId,
				status: "timeout",
				timeoutPhase: activeRunRegistered ? "gateway_draining" : "queue",
				...activeRunRegistered ? {} : { providerStarted: false }
			});
			return;
		}
		respond(true, {
			runId,
			status: snapshot.status,
			startedAt: snapshot.startedAt,
			endedAt: snapshot.endedAt,
			error: snapshot.error,
			stopReason: snapshot.stopReason,
			livenessState: snapshot.livenessState,
			yielded: snapshot.yielded,
			timeoutPhase: snapshot.timeoutPhase,
			providerStarted: snapshot.providerStarted
		});
	}
};
//#endregion
//#region src/gateway/server-methods/agents-config-mutations.ts
var AgentConfigPreconditionError = class extends Error {
	constructor(kind, agentId) {
		super(kind === "already-exists" ? `agent "${agentId}" already exists` : `agent "${agentId}" not found`);
		this.kind = kind;
		this.agentId = agentId;
		this.name = "AgentConfigPreconditionError";
	}
};
function isConfiguredAgent(cfg, agentId) {
	return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}
async function createAgentConfigEntry(params) {
	await mutateConfigFileWithRetry({
		afterWrite: { mode: "auto" },
		mutate: (draft) => {
			if (isConfiguredAgent(draft, params.agentId)) throw new AgentConfigPreconditionError("already-exists", params.agentId);
			const latestNextConfig = applyAgentConfig(draft, {
				agentId: params.agentId,
				name: params.name,
				workspace: params.workspace,
				model: params.model,
				identity: params.identity,
				agentDir: params.agentDir
			});
			Object.assign(draft, latestNextConfig);
		}
	});
}
async function updateAgentConfigEntry(params) {
	await mutateConfigFileWithRetry({
		afterWrite: { mode: "auto" },
		mutate: (draft) => {
			if (!isConfiguredAgent(draft, params.agentId)) throw new AgentConfigPreconditionError("not-found", params.agentId);
			const latestNextConfig = applyAgentConfig(draft, {
				agentId: params.agentId,
				...params.name ? { name: params.name } : {},
				...params.workspace ? { workspace: params.workspace } : {},
				...params.model ? { model: params.model } : {},
				...params.identity ? { identity: params.identity } : {}
			});
			Object.assign(draft, latestNextConfig);
		}
	});
}
async function deleteAgentConfigEntry(params) {
	const committed = await mutateConfigFileWithRetry({
		afterWrite: { mode: "auto" },
		mutate: (draft) => {
			if (!isConfiguredAgent(draft, params.agentId)) throw new AgentConfigPreconditionError("not-found", params.agentId);
			const workspaceDir = resolveAgentWorkspaceDir(draft, params.agentId);
			const agentDir = resolveAgentDir(draft, params.agentId);
			const sessionsDir = resolveSessionTranscriptsDirForAgent(params.agentId);
			const result = pruneAgentConfig(draft, params.agentId);
			Object.assign(draft, result.config);
			return {
				workspaceDir,
				agentDir,
				sessionsDir,
				removedBindings: result.removedBindings
			};
		}
	});
	return {
		nextConfig: committed.nextConfig,
		result: committed.result
	};
}
//#endregion
//#region src/gateway/server-methods/agents.ts
const BOOTSTRAP_FILE_NAMES = [
	DEFAULT_AGENTS_FILENAME,
	DEFAULT_SOUL_FILENAME,
	DEFAULT_TOOLS_FILENAME,
	DEFAULT_IDENTITY_FILENAME,
	DEFAULT_USER_FILENAME,
	DEFAULT_HEARTBEAT_FILENAME,
	DEFAULT_BOOTSTRAP_FILENAME
];
const BOOTSTRAP_FILE_NAMES_POST_ONBOARDING = BOOTSTRAP_FILE_NAMES.filter((name) => name !== DEFAULT_BOOTSTRAP_FILENAME);
const agentsHandlerDeps = {
	root,
	isWorkspaceSetupCompleted
};
const MEMORY_FILE_NAMES = [DEFAULT_MEMORY_FILENAME];
const ALLOWED_FILE_NAMES = new Set([...BOOTSTRAP_FILE_NAMES, ...MEMORY_FILE_NAMES]);
function resolveAgentWorkspaceFileOrRespondError(params, respond, cfg) {
	const rawAgentId = params.agentId;
	const agentId = resolveAgentIdOrError(typeof rawAgentId === "string" || typeof rawAgentId === "number" ? String(rawAgentId) : "", cfg);
	if (!agentId) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
		return null;
	}
	const rawName = params.name;
	const name = (typeof rawName === "string" || typeof rawName === "number" ? String(rawName) : "").trim();
	if (!ALLOWED_FILE_NAMES.has(name)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported file "${name}"`));
		return null;
	}
	return {
		cfg,
		agentId,
		workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
		name
	};
}
function isRegularWorkspaceFileStat(stat) {
	const isFile = typeof stat.isFile === "function" ? stat.isFile() : stat.isFile;
	const isSymbolicLink = typeof stat.isSymbolicLink === "function" ? stat.isSymbolicLink() : stat.isSymbolicLink;
	return isFile && !isSymbolicLink && stat.nlink <= 1;
}
async function statWorkspaceFileSafely(workspaceRoot, workspaceDir, name) {
	try {
		const stat = workspaceRoot ? await workspaceRoot.stat(name) : await fs$1.lstat(path.join(workspaceDir, name));
		if (!isRegularWorkspaceFileStat(stat)) return null;
		return {
			size: stat.size,
			updatedAtMs: Math.floor(stat.mtimeMs)
		};
	} catch {
		if (!workspaceRoot) return null;
		try {
			const stat = await fs$1.lstat(path.join(workspaceDir, name));
			if (!isRegularWorkspaceFileStat(stat)) return null;
			return {
				size: stat.size,
				updatedAtMs: Math.floor(stat.mtimeMs)
			};
		} catch {
			return null;
		}
	}
}
async function openWorkspaceRootSafely(workspaceDir) {
	try {
		return await agentsHandlerDeps.root(workspaceDir);
	} catch {
		return null;
	}
}
async function listAgentFiles(workspaceDir, options) {
	const files = [];
	const workspaceRoot = await openWorkspaceRootSafely(workspaceDir);
	if (!workspaceRoot) return [...options?.hideBootstrap ? BOOTSTRAP_FILE_NAMES_POST_ONBOARDING : BOOTSTRAP_FILE_NAMES, DEFAULT_MEMORY_FILENAME].map((name) => ({
		name,
		path: path.join(workspaceDir, name),
		missing: true
	}));
	const bootstrapFileNames = options?.hideBootstrap ? BOOTSTRAP_FILE_NAMES_POST_ONBOARDING : BOOTSTRAP_FILE_NAMES;
	for (const name of bootstrapFileNames) {
		const filePath = path.join(workspaceDir, name);
		const meta = await statWorkspaceFileSafely(workspaceRoot, workspaceDir, name);
		if (meta) files.push({
			name,
			path: filePath,
			missing: false,
			size: meta.size,
			updatedAtMs: meta.updatedAtMs
		});
		else files.push({
			name,
			path: filePath,
			missing: true
		});
	}
	const primaryMeta = await statWorkspaceFileSafely(workspaceRoot, workspaceDir, DEFAULT_MEMORY_FILENAME);
	if (primaryMeta) files.push({
		name: DEFAULT_MEMORY_FILENAME,
		path: path.join(workspaceDir, DEFAULT_MEMORY_FILENAME),
		missing: false,
		size: primaryMeta.size,
		updatedAtMs: primaryMeta.updatedAtMs
	});
	else files.push({
		name: DEFAULT_MEMORY_FILENAME,
		path: path.join(workspaceDir, DEFAULT_MEMORY_FILENAME),
		missing: true
	});
	return files;
}
function resolveAgentIdOrError(agentIdRaw, cfg) {
	const agentId = normalizeAgentId(agentIdRaw);
	if (!new Set(listAgentIds(cfg)).has(agentId)) return null;
	return agentId;
}
function sanitizeIdentityLine(value) {
	return value.replace(/\s+/g, " ").trim();
}
function resolveOptionalStringParam(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function respondInvalidMethodParams(respond, method, errors) {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params: ${formatValidationErrors(errors)}`));
}
function respondAgentNotFound(respond, agentId) {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`));
}
function respondAgentConfigPreconditionError(respond, error) {
	if (error.kind === "not-found") {
		respondAgentNotFound(respond, error.agentId);
		return;
	}
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${error.agentId}" already exists`));
}
async function moveToTrashBestEffort(pathname) {
	if (!pathname) return;
	try {
		await fs$1.access(pathname);
	} catch {
		return;
	}
	try {
		await movePathToTrash(pathname);
	} catch {}
}
function respondWorkspaceFileUnsafe(respond, name) {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unsafe workspace file "${name}"`));
}
function respondWorkspaceFileMissing(params) {
	params.respond(true, {
		agentId: params.agentId,
		workspace: params.workspaceDir,
		file: {
			name: params.name,
			path: params.filePath,
			missing: true
		}
	}, void 0);
}
async function writeWorkspaceFileOrRespond(params) {
	await fs$1.mkdir(params.workspaceDir, { recursive: true });
	try {
		await (await agentsHandlerDeps.root(params.workspaceDir)).write(params.name, params.content, { encoding: "utf8" });
	} catch (err) {
		if (err instanceof FsSafeError) {
			respondWorkspaceFileUnsafe(params.respond, params.name);
			return false;
		}
		throw err;
	}
	return true;
}
function normalizeIdentityForFile(identity) {
	if (!identity) return;
	const resolved = {
		name: identity.name?.trim() || void 0,
		theme: identity.theme?.trim() || void 0,
		emoji: identity.emoji?.trim() || void 0,
		avatar: identity.avatar?.trim() || void 0
	};
	if (!resolved.name && !resolved.theme && !resolved.emoji && !resolved.avatar) return;
	return resolved;
}
async function readWorkspaceFileContent(workspaceDir, name) {
	try {
		return (await (await agentsHandlerDeps.root(workspaceDir)).read(name, {
			hardlinks: "reject",
			nonBlockingRead: true
		})).buffer.toString("utf-8");
	} catch (err) {
		if (err instanceof FsSafeError && err.code === "not-found") return;
		throw err;
	}
}
async function buildIdentityMarkdownForWrite(params) {
	let baseContent;
	if (params.preferFallbackWorkspaceContent && params.fallbackWorkspaceDir) {
		baseContent = await readWorkspaceFileContent(params.fallbackWorkspaceDir, DEFAULT_IDENTITY_FILENAME);
		if (baseContent === void 0) baseContent = await readWorkspaceFileContent(params.workspaceDir, DEFAULT_IDENTITY_FILENAME);
	} else {
		baseContent = await readWorkspaceFileContent(params.workspaceDir, DEFAULT_IDENTITY_FILENAME);
		if (baseContent === void 0 && params.fallbackWorkspaceDir) baseContent = await readWorkspaceFileContent(params.fallbackWorkspaceDir, DEFAULT_IDENTITY_FILENAME);
	}
	return mergeIdentityMarkdownContent(baseContent, params.identity);
}
async function buildIdentityMarkdownOrRespondUnsafe(params) {
	try {
		return await buildIdentityMarkdownForWrite(params);
	} catch (err) {
		if (err instanceof FsSafeError) {
			respondWorkspaceFileUnsafe(params.respond, DEFAULT_IDENTITY_FILENAME);
			return null;
		}
		throw err;
	}
}
const agentsHandlers = {
	"agents.list": ({ params, respond, context }) => {
		if (!validateAgentsListParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agents.list params: ${formatValidationErrors(validateAgentsListParams.errors)}`));
			return;
		}
		respond(true, listAgentsForGateway(context.getRuntimeConfig()), void 0);
	},
	"agents.create": async ({ params, respond, context }) => {
		if (!validateAgentsCreateParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agents.create params: ${formatValidationErrors(validateAgentsCreateParams.errors)}`));
			return;
		}
		const cfg = context.getRuntimeConfig();
		const rawName = params.name.trim();
		const agentId = normalizeAgentId(rawName);
		if (agentId === "main") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" is reserved`));
			return;
		}
		if (isConfiguredAgent(cfg, agentId)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" already exists`));
			return;
		}
		const workspaceDir = resolveUserPath(params.workspace.trim());
		const safeName = sanitizeIdentityLine(rawName);
		const model = resolveOptionalStringParam(params.model);
		const emoji = resolveOptionalStringParam(params.emoji);
		const avatar = resolveOptionalStringParam(params.avatar);
		const identity = {
			name: safeName,
			...emoji ? { emoji: sanitizeIdentityLine(emoji) } : {},
			...avatar ? { avatar: sanitizeIdentityLine(avatar) } : {}
		};
		let nextConfig = applyAgentConfig(cfg, {
			agentId,
			name: safeName,
			workspace: workspaceDir,
			model,
			identity
		});
		const agentDir = resolveAgentDir(nextConfig, agentId);
		nextConfig = applyAgentConfig(nextConfig, {
			agentId,
			agentDir
		});
		await ensureAgentWorkspace({
			dir: workspaceDir,
			ensureBootstrapFiles: !Boolean(nextConfig.agents?.defaults?.skipBootstrap),
			skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles
		});
		await fs$1.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });
		const persistedIdentity = normalizeIdentityForFile(resolveAgentIdentity(nextConfig, agentId));
		if (persistedIdentity) {
			const identityContent = await buildIdentityMarkdownOrRespondUnsafe({
				respond,
				workspaceDir,
				identity: persistedIdentity
			});
			if (identityContent === null) return;
			if (!await writeWorkspaceFileOrRespond({
				respond,
				workspaceDir,
				name: "IDENTITY.md",
				content: identityContent
			})) return;
		}
		try {
			await createAgentConfigEntry({
				agentId,
				name: safeName,
				workspace: workspaceDir,
				model,
				identity,
				agentDir
			});
		} catch (error) {
			if (error instanceof AgentConfigPreconditionError) {
				respondAgentConfigPreconditionError(respond, error);
				return;
			}
			throw error;
		}
		respond(true, {
			ok: true,
			agentId,
			name: safeName,
			workspace: workspaceDir,
			model
		}, void 0);
	},
	"agents.update": async ({ params, respond, context }) => {
		if (!validateAgentsUpdateParams(params)) {
			respondInvalidMethodParams(respond, "agents.update", validateAgentsUpdateParams.errors);
			return;
		}
		const cfg = context.getRuntimeConfig();
		const agentId = normalizeAgentId(params.agentId);
		if (!isConfiguredAgent(cfg, agentId)) {
			respondAgentNotFound(respond, agentId);
			return;
		}
		const workspaceDir = typeof params.workspace === "string" && params.workspace.trim() ? resolveUserPath(params.workspace.trim()) : void 0;
		const model = resolveOptionalStringParam(params.model);
		const emoji = resolveOptionalStringParam(params.emoji);
		const avatar = resolveOptionalStringParam(params.avatar);
		const safeName = typeof params.name === "string" && params.name.trim() ? sanitizeIdentityLine(params.name.trim()) : void 0;
		const hasIdentityFields = Boolean(safeName || emoji || avatar);
		const identity = hasIdentityFields ? {
			...safeName ? { name: safeName } : {},
			...emoji ? { emoji: sanitizeIdentityLine(emoji) } : {},
			...avatar ? { avatar: sanitizeIdentityLine(avatar) } : {}
		} : void 0;
		const nextConfig = applyAgentConfig(cfg, {
			agentId,
			...safeName ? { name: safeName } : {},
			...workspaceDir ? { workspace: workspaceDir } : {},
			...model ? { model } : {},
			...identity ? { identity } : {}
		});
		let ensuredWorkspace;
		if (workspaceDir) ensuredWorkspace = await ensureAgentWorkspace({
			dir: workspaceDir,
			ensureBootstrapFiles: !Boolean(nextConfig.agents?.defaults?.skipBootstrap),
			skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles
		});
		const persistedIdentity = normalizeIdentityForFile(resolveAgentIdentity(nextConfig, agentId));
		if (persistedIdentity && (workspaceDir || hasIdentityFields)) {
			const identityWorkspaceDir = resolveAgentWorkspaceDir(nextConfig, agentId);
			const previousWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
			const fallbackWorkspaceDir = workspaceDir && identityWorkspaceDir !== previousWorkspaceDir ? previousWorkspaceDir : void 0;
			const identityContent = await buildIdentityMarkdownOrRespondUnsafe({
				respond,
				workspaceDir: identityWorkspaceDir,
				identity: persistedIdentity,
				fallbackWorkspaceDir,
				preferFallbackWorkspaceContent: Boolean(fallbackWorkspaceDir) && ensuredWorkspace?.identityPathCreated === true
			});
			if (identityContent === null) return;
			if (!await writeWorkspaceFileOrRespond({
				respond,
				workspaceDir: identityWorkspaceDir,
				name: "IDENTITY.md",
				content: identityContent
			})) return;
		}
		try {
			await updateAgentConfigEntry({
				agentId,
				...safeName ? { name: safeName } : {},
				...workspaceDir ? { workspace: workspaceDir } : {},
				...model ? { model } : {},
				...identity ? { identity } : {}
			});
		} catch (error) {
			if (error instanceof AgentConfigPreconditionError) {
				respondAgentConfigPreconditionError(respond, error);
				return;
			}
			throw error;
		}
		respond(true, {
			ok: true,
			agentId
		}, void 0);
	},
	"agents.delete": async ({ params, respond, context }) => {
		if (!validateAgentsDeleteParams(params)) {
			respondInvalidMethodParams(respond, "agents.delete", validateAgentsDeleteParams.errors);
			return;
		}
		const cfg = context.getRuntimeConfig();
		const agentId = normalizeAgentId(params.agentId);
		if (agentId === "main") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" cannot be deleted`));
			return;
		}
		if (!isConfiguredAgent(cfg, agentId)) {
			respondAgentNotFound(respond, agentId);
			return;
		}
		const deleteFiles = typeof params.deleteFiles === "boolean" ? params.deleteFiles : true;
		let committed;
		try {
			committed = await deleteAgentConfigEntry({ agentId });
		} catch (error) {
			if (error instanceof AgentConfigPreconditionError) {
				respondAgentConfigPreconditionError(respond, error);
				return;
			}
			throw error;
		}
		const deleteResult = committed.result;
		if (!deleteResult) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "agent delete did not commit"));
			return;
		}
		await purgeAgentSessionStoreEntries(cfg, agentId);
		if (deleteFiles) {
			const deleteWorkspace = findOverlappingWorkspaceAgentIds(committed.nextConfig, agentId, deleteResult.workspaceDir).length === 0;
			await Promise.all([
				...deleteWorkspace ? [moveToTrashBestEffort(deleteResult.workspaceDir)] : [],
				moveToTrashBestEffort(deleteResult.agentDir),
				moveToTrashBestEffort(deleteResult.sessionsDir)
			]);
		}
		respond(true, {
			ok: true,
			agentId,
			removedBindings: deleteResult.removedBindings
		}, void 0);
	},
	"agents.files.list": async ({ params, respond, context }) => {
		if (!validateAgentsFilesListParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agents.files.list params: ${formatValidationErrors(validateAgentsFilesListParams.errors)}`));
			return;
		}
		const cfg = context.getRuntimeConfig();
		const agentId = resolveAgentIdOrError(params.agentId, cfg);
		if (!agentId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
			return;
		}
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		let hideBootstrap = false;
		try {
			hideBootstrap = await agentsHandlerDeps.isWorkspaceSetupCompleted(workspaceDir);
		} catch {}
		respond(true, {
			agentId,
			workspace: workspaceDir,
			files: await listAgentFiles(workspaceDir, { hideBootstrap })
		}, void 0);
	},
	"agents.files.get": async ({ params, respond, context }) => {
		if (!validateAgentsFilesGetParams(params)) {
			respondInvalidMethodParams(respond, "agents.files.get", validateAgentsFilesGetParams.errors);
			return;
		}
		const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond, context.getRuntimeConfig());
		if (!resolved) return;
		const { agentId, workspaceDir, name } = resolved;
		const filePath = path.join(workspaceDir, name);
		let safeRead;
		try {
			safeRead = await (await agentsHandlerDeps.root(workspaceDir)).read(name, {
				hardlinks: "reject",
				nonBlockingRead: true
			});
		} catch (err) {
			if (err instanceof FsSafeError && err.code === "not-found") {
				respondWorkspaceFileMissing({
					respond,
					agentId,
					workspaceDir,
					name,
					filePath
				});
				return;
			}
			if (err instanceof FsSafeError) {
				respondWorkspaceFileUnsafe(respond, name);
				return;
			}
			throw err;
		}
		respond(true, {
			agentId,
			workspace: workspaceDir,
			file: {
				name,
				path: filePath,
				missing: false,
				size: safeRead.stat.size,
				updatedAtMs: Math.floor(safeRead.stat.mtimeMs),
				content: safeRead.buffer.toString("utf-8")
			}
		}, void 0);
	},
	"agents.files.set": async ({ params, respond, context }) => {
		if (!validateAgentsFilesSetParams(params)) {
			respondInvalidMethodParams(respond, "agents.files.set", validateAgentsFilesSetParams.errors);
			return;
		}
		const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond, context.getRuntimeConfig());
		if (!resolved) return;
		const { agentId, workspaceDir, name } = resolved;
		await fs$1.mkdir(workspaceDir, { recursive: true });
		const filePath = path.join(workspaceDir, name);
		const content = params.content;
		let workspaceRoot;
		try {
			workspaceRoot = await agentsHandlerDeps.root(workspaceDir);
			await workspaceRoot.write(name, content, { encoding: "utf8" });
		} catch (err) {
			if (!(err instanceof FsSafeError)) throw err;
			respondWorkspaceFileUnsafe(respond, name);
			return;
		}
		const meta = await statWorkspaceFileSafely(workspaceRoot, workspaceDir, name);
		respond(true, {
			ok: true,
			agentId,
			workspace: workspaceDir,
			file: {
				name,
				path: filePath,
				missing: false,
				size: meta?.size,
				updatedAtMs: meta?.updatedAtMs,
				content
			}
		}, void 0);
	}
};
//#endregion
//#region src/gateway/server-methods/validation.ts
function assertValidParams(params, validate, method, respond) {
	if (validate(params)) return true;
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params: ${formatValidationErrors(validate.errors)}`));
	return false;
}
//#endregion
//#region src/gateway/server-methods/artifacts.ts
function artifactError(type, message, details) {
	return errorShape(ErrorCodes.INVALID_REQUEST, message, { details: {
		type,
		...details
	} });
}
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function asNonEmptyString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function resolveRequesterSessionAgentId(sessionKey, cfg) {
	const key = asNonEmptyString(sessionKey);
	if (!key) return;
	const parsed = parseAgentSessionKey(key);
	if (!parsed && key.toLowerCase().startsWith("agent:")) return;
	if (cfg) return resolveSessionStoreAgentId(cfg, resolveSessionStoreKey({
		cfg,
		sessionKey: key
	}));
	if (parsed) return parsed.agentId;
	return resolveAgentIdFromSessionKey(key);
}
function resolveScopedArtifactSessionKey(sessionKey, agentId, cfg) {
	const key = asNonEmptyString(sessionKey);
	if (!key) return;
	const scopedAgentId = asNonEmptyString(agentId);
	if (!scopedAgentId) return key;
	const parsed = parseAgentSessionKey(key);
	if (!parsed && key.toLowerCase().startsWith("agent:")) return;
	if (cfg) {
		const scopedKey = resolveStoredSessionKeyForAgentStore({
			cfg,
			agentId: scopedAgentId,
			sessionKey: key
		});
		if (scopedKey !== "global" && scopedKey !== "unknown" && resolveSessionStoreAgentId(cfg, scopedKey) !== normalizeAgentId(scopedAgentId)) return;
		return scopedKey;
	}
	if (parsed && parsed.agentId !== normalizeAgentId(scopedAgentId)) return;
	return toAgentStoreSessionKey({
		agentId: scopedAgentId,
		requestKey: key
	});
}
function normalizeArtifactType(value) {
	const normalized = value.trim().toLowerCase();
	if (normalized === "image" || normalized === "input_image" || normalized === "image_url") return "image";
	if (normalized === "audio" || normalized === "input_audio") return "audio";
	if (normalized === "file" || normalized === "input_file") return "file";
	return "file";
}
function mimeFromDataUrl(value) {
	return /^data:([^;,]+)(?:;[^,]*)?,/i.exec(value.trim())?.[1]?.toLowerCase();
}
function base64FromDataUrl(value) {
	return /^data:[^,]*;base64,(.*)$/is.exec(value.trim())?.[1]?.replace(/\s+/g, "");
}
function estimateBase64Size(value) {
	if (!value) return;
	try {
		return Buffer.from(value, "base64").byteLength;
	} catch {
		return;
	}
}
function mediaUrlValue(value) {
	if (typeof value === "string") return asNonEmptyString(value);
	return asNonEmptyString(asRecord(value)?.url);
}
function isSafeDownloadUrl(value) {
	const trimmed = value.trim();
	if (!trimmed || /^data:/i.test(trimmed)) return false;
	if (trimmed.startsWith("/")) return !trimmed.startsWith("//") && trimmed.startsWith("/api/");
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}
function artifactId(parts) {
	return `artifact_${createHash("sha256").update(`${parts.sessionKey}\0${parts.messageSeq}\0${parts.contentIndex}\0${parts.type}\0${parts.title}`).digest("base64url").slice(0, 18)}`;
}
function resolveMessageSeq(message, fallback) {
	const seq = asRecord(message["__openclaw"])?.seq;
	return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : fallback;
}
function resolveMessageRunId(message) {
	return asNonEmptyString(asRecord(message["__openclaw"])?.runId) ?? asNonEmptyString(message.runId);
}
function resolveMessageTaskId(message) {
	const meta = asRecord(message["__openclaw"]);
	return asNonEmptyString(meta?.messageTaskId) ?? asNonEmptyString(meta?.taskId) ?? asNonEmptyString(message.messageTaskId) ?? asNonEmptyString(message.taskId);
}
function resolveBlockDownload(block) {
	const data = asNonEmptyString(block.data);
	const content = asNonEmptyString(block.content);
	const url = asNonEmptyString(block.url) ?? asNonEmptyString(block.openUrl);
	const imageUrl = mediaUrlValue(block.image_url);
	const audioUrl = asNonEmptyString(block.audio_url);
	const source = asRecord(block.source);
	const sourceData = asNonEmptyString(source?.data);
	const sourceUrl = asNonEmptyString(source?.url);
	const dataUrl = [
		url,
		sourceUrl,
		imageUrl,
		audioUrl,
		data,
		content,
		sourceData
	].find((value) => typeof value === "string" && /^data:/i.test(value));
	const base64FromDetectedDataUrl = dataUrl ? base64FromDataUrl(dataUrl) : void 0;
	const directBase64 = [
		data,
		sourceData,
		content
	].find((value) => typeof value === "string" && !/^data:/i.test(value));
	const base64 = base64FromDetectedDataUrl ?? directBase64;
	const remoteUrl = [
		url,
		sourceUrl,
		imageUrl,
		audioUrl
	].find((value) => typeof value === "string" && isSafeDownloadUrl(value));
	const mimeType = asNonEmptyString(block.mimeType) ?? asNonEmptyString(block.media_type) ?? asNonEmptyString(source?.media_type) ?? asNonEmptyString(source?.mimeType) ?? (dataUrl ? mimeFromDataUrl(dataUrl) : void 0);
	const explicitSize = block.sizeBytes ?? source?.sizeBytes;
	const sizeBytes = typeof explicitSize === "number" && Number.isFinite(explicitSize) && explicitSize >= 0 ? Math.floor(explicitSize) : estimateBase64Size(base64);
	if (base64) return {
		mode: "bytes",
		data: base64,
		mimeType,
		sizeBytes
	};
	if (remoteUrl) return {
		mode: "url",
		url: remoteUrl,
		mimeType,
		sizeBytes
	};
	return {
		mode: "unsupported",
		mimeType,
		sizeBytes
	};
}
function isArtifactBlock(block) {
	const type = asNonEmptyString(block.type)?.toLowerCase();
	if (type === "image" || type === "audio" || type === "file" || type === "input_image" || type === "input_audio" || type === "input_file" || type === "image_url") return true;
	return Boolean(block.url || block.openUrl || block.data || block.source || block.image_url || block.audio_url);
}
function collectArtifactsFromMessage(params) {
	const msg = asRecord(params.message);
	if (!msg) return;
	const messageSeq = resolveMessageSeq(msg, params.messageFallbackSeq);
	const messageRunId = resolveMessageRunId(msg);
	const messageTaskId = resolveMessageTaskId(msg);
	if (params.runId && messageRunId !== params.runId) return;
	if (params.taskId && messageTaskId !== params.taskId) return;
	const content = Array.isArray(msg.content) ? msg.content : [];
	for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
		const block = asRecord(content[contentIndex]);
		if (!block || !isArtifactBlock(block)) continue;
		const type = normalizeArtifactType(asNonEmptyString(block.type) ?? "file");
		const title = asNonEmptyString(block.title) ?? asNonEmptyString(block.fileName) ?? asNonEmptyString(block.filename) ?? asNonEmptyString(block.alt) ?? `${type} ${params.artifacts.length + 1}`;
		const download = resolveBlockDownload(block);
		const summary = {
			id: artifactId({
				sessionKey: params.sessionKey,
				messageSeq,
				contentIndex,
				title,
				type
			}),
			type,
			title,
			...download.mimeType ? { mimeType: download.mimeType } : {},
			...download.sizeBytes !== void 0 ? { sizeBytes: download.sizeBytes } : {},
			sessionKey: params.sessionKey,
			...messageRunId ? { runId: messageRunId } : {},
			...messageTaskId ? { taskId: messageTaskId } : {},
			messageSeq,
			source: "session-transcript",
			download: { mode: download.mode },
			...download.data ? { data: download.data } : {},
			...download.url ? { url: download.url } : {}
		};
		params.artifacts.push(summary);
	}
}
function resolveQuerySession(query, cfg) {
	if (query.sessionKey) {
		const sessionKey = resolveScopedArtifactSessionKey(query.sessionKey, query.agentId, cfg);
		if (!sessionKey) return;
		return {
			sessionKey,
			...query.agentId ? { agentId: query.agentId } : {}
		};
	}
	if (query.runId) {
		const agentId = query.agentId ?? resolveDefaultAgentId(cfg ?? {});
		const scopedSessionKey = resolveScopedArtifactSessionKey(resolveSessionKeyForRun(query.runId, { agentId }), agentId, cfg);
		return scopedSessionKey ? {
			sessionKey: scopedSessionKey,
			agentId
		} : void 0;
	}
	if (query.taskId) {
		const task = getTaskSessionLookupByIdForStatus(query.taskId);
		const requesterSessionKey = asNonEmptyString(task?.requesterSessionKey);
		const taskAgentId = asNonEmptyString(task?.agentId) ?? resolveRequesterSessionAgentId(requesterSessionKey, cfg);
		if (query.agentId && taskAgentId && normalizeAgentId(query.agentId) !== normalizeAgentId(taskAgentId)) return;
		const agentId = query.agentId ?? taskAgentId ?? resolveDefaultAgentId(cfg ?? {});
		if (requesterSessionKey) {
			const scopedSessionKey = resolveScopedArtifactSessionKey(requesterSessionKey, agentId, cfg);
			return scopedSessionKey ? {
				sessionKey: scopedSessionKey,
				agentId
			} : void 0;
		}
		const runId = asNonEmptyString(task?.runId);
		const scopedSessionKey = resolveScopedArtifactSessionKey(runId ? resolveSessionKeyForRun(runId, { agentId }) : void 0, agentId, cfg);
		return scopedSessionKey ? {
			sessionKey: scopedSessionKey,
			agentId
		} : void 0;
	}
}
async function loadArtifacts(query, cfg) {
	const resolved = resolveQuerySession(query, cfg);
	if (!resolved) return { artifacts: [] };
	const { sessionKey } = resolved;
	const scopedGlobalAgentId = cfg?.session?.scope === "global" && sessionKey === "global" ? resolved.agentId : void 0;
	const { storePath, entry } = scopedGlobalAgentId ? loadSessionEntry(sessionKey, { agentId: scopedGlobalAgentId }) : loadSessionEntry(sessionKey);
	const sessionId = entry?.sessionId;
	if (!sessionId || !storePath) return {
		sessionKey,
		artifacts: []
	};
	const artifacts = [];
	await visitSessionMessagesAsync(sessionId, storePath, entry?.sessionFile, (message, seq) => {
		collectArtifactsFromMessage({
			message,
			messageFallbackSeq: seq,
			artifacts,
			sessionKey,
			runId: query.runId,
			taskId: query.taskId
		});
	}, {
		mode: "full",
		reason: "artifact query transcript scan"
	});
	return {
		sessionKey,
		artifacts
	};
}
function requireQueryable(params, respond) {
	if (params.sessionKey || params.runId || params.taskId) return true;
	respond(false, void 0, artifactError("artifact_query_unsupported", "artifacts require one of sessionKey, runId, or taskId"));
	return false;
}
async function findArtifact(params, cfg) {
	const loaded = await loadArtifacts(params, cfg);
	return {
		sessionKey: loaded.sessionKey,
		artifact: loaded.artifacts.find((artifact) => artifact.id === params.artifactId)
	};
}
function toSummary(artifact) {
	const { data: dataValue, url: _url, ...summary } = artifact;
	return summary;
}
const artifactsHandlers = {
	"artifacts.list": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateArtifactsListParams, "artifacts.list", respond)) return;
		if (!requireQueryable(params, respond)) return;
		const { artifacts, sessionKey } = await loadArtifacts(params, context.getRuntimeConfig?.());
		if (!sessionKey && (params.runId || params.taskId)) {
			respond(false, void 0, artifactError("artifact_scope_not_found", "no session found for artifact query"));
			return;
		}
		respond(true, { artifacts: artifacts.map(toSummary) });
	},
	"artifacts.get": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateArtifactsGetParams, "artifacts.get", respond)) return;
		if (!requireQueryable(params, respond)) return;
		const { artifact } = await findArtifact(params, context.getRuntimeConfig?.());
		if (!artifact) {
			respond(false, void 0, artifactError("artifact_not_found", "artifact not found", { artifactId: params.artifactId }));
			return;
		}
		respond(true, { artifact: toSummary(artifact) });
	},
	"artifacts.download": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateArtifactsDownloadParams, "artifacts.download", respond)) return;
		if (!requireQueryable(params, respond)) return;
		const { artifact } = await findArtifact(params, context.getRuntimeConfig?.());
		if (!artifact) {
			respond(false, void 0, artifactError("artifact_not_found", "artifact not found", { artifactId: params.artifactId }));
			return;
		}
		if (artifact.download.mode === "unsupported") {
			respond(false, void 0, artifactError("artifact_download_unsupported", "artifact download is unsupported", { artifactId: artifact.id }));
			return;
		}
		respond(true, {
			artifact: toSummary(artifact),
			...artifact.download.mode === "bytes" ? {
				encoding: "base64",
				data: artifact.data
			} : {},
			...artifact.download.mode === "url" ? { url: artifact.url } : {}
		});
	}
};
//#endregion
//#region src/gateway/server-methods/channels.ts
const CHANNEL_STATUS_MAX_TIMEOUT_MS = 3e4;
const CHANNEL_STATUS_PROBE_CONCURRENCY = 5;
function channelStatusTimeoutPayload(step, timeoutMs) {
	return {
		ok: false,
		timedOut: true,
		error: `${step} timed out after ${timeoutMs}ms`
	};
}
async function raceWithTimeout(params) {
	const timeoutMs = params.timeoutMs;
	let timer = null;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
	});
	const result = await Promise.race([Promise.resolve().then(params.run).then((value) => ({
		kind: "value",
		value
	}), (error) => ({
		kind: "error",
		error
	})), timeout]);
	if (timer) clearTimeout(timer);
	return result;
}
async function runChannelStatusHook(params) {
	const timeoutMs = Math.max(1, params.timeoutMs);
	const result = await raceWithTimeout({
		timeoutMs,
		run: params.run
	});
	if (result.kind === "value") return result.value;
	const warningPrefix = `${params.channelId}:${params.accountId} ${params.step}`;
	if (result.kind === "timeout") {
		params.warnings.push(`${warningPrefix} timed out after ${timeoutMs}ms`);
		return channelStatusTimeoutPayload(params.step, timeoutMs);
	}
	const message = formatForLog(result.error);
	params.warnings.push(`${warningPrefix} failed: ${message}`);
	return {
		ok: false,
		error: message
	};
}
async function runChannelStatusSummary(params) {
	const timeoutMs = Math.max(1, params.timeoutMs);
	const result = await raceWithTimeout({
		timeoutMs,
		run: params.run
	});
	const warningPrefix = `${params.channelId} summary`;
	if (result.kind === "value") return {
		ok: true,
		value: result.value
	};
	if (result.kind === "timeout") {
		const error = `summary timed out after ${timeoutMs}ms`;
		params.warnings.push(`${warningPrefix} timed out after ${timeoutMs}ms`);
		return {
			ok: false,
			timedOut: true,
			error
		};
	}
	const message = formatForLog(result.error);
	params.warnings.push(`${warningPrefix} failed: ${message}`);
	return {
		ok: false,
		error: message
	};
}
function channelStatusFailureMessage(value) {
	if (!value || typeof value !== "object") return null;
	const record = value;
	if (record.ok !== false || typeof record.error !== "string" || record.error.length === 0) return null;
	return record.error;
}
function resolveChannelsStatusTimeoutMs(params) {
	const fallback = params.probe ? CHANNEL_STATUS_MAX_TIMEOUT_MS : 1e4;
	if (typeof params.timeoutMsRaw !== "number" || !Number.isFinite(params.timeoutMsRaw)) return fallback;
	return Math.min(Math.max(1e3, params.timeoutMsRaw), CHANNEL_STATUS_MAX_TIMEOUT_MS);
}
function resolveRuntimeAccountSnapshot(params) {
	const direct = params.runtime.channelAccounts[params.channelId]?.[params.accountId];
	if (direct) return direct;
	const fallback = params.runtime.channels[params.channelId];
	return fallback?.accountId === params.accountId ? fallback : void 0;
}
function resolveChannelGatewayAccountId(params) {
	return normalizeOptionalString$1(params.accountId) || params.plugin.config.defaultAccountId?.(params.cfg) || params.plugin.config.listAccountIds(params.cfg)[0] || "default";
}
async function logoutChannelAccount(params) {
	const resolvedAccountId = resolveChannelGatewayAccountId(params);
	const account = params.plugin.config.resolveAccount(params.cfg, resolvedAccountId);
	await params.context.stopChannel(params.channelId, resolvedAccountId);
	const result = await params.plugin.gateway?.logoutAccount?.({
		cfg: params.cfg,
		accountId: resolvedAccountId,
		account,
		runtime: defaultRuntime
	});
	if (!result) throw new Error(`Channel ${params.channelId} does not support logout`);
	const cleared = result.cleared;
	if (typeof result.loggedOut === "boolean" ? result.loggedOut : cleared) params.context.markChannelLoggedOut(params.channelId, true, resolvedAccountId);
	return {
		channel: params.channelId,
		accountId: resolvedAccountId,
		...result,
		cleared
	};
}
async function startChannelAccount(params) {
	if (!params.plugin.gateway?.startAccount) throw new Error(`Channel ${params.channelId} does not support runtime start`);
	const resolvedAccountId = resolveChannelGatewayAccountId(params);
	await params.context.startChannel(params.channelId, resolvedAccountId);
	const started = resolveRuntimeAccountSnapshot({
		runtime: params.context.getRuntimeSnapshot(),
		channelId: params.channelId,
		accountId: resolvedAccountId
	})?.running === true;
	return {
		channel: params.channelId,
		accountId: resolvedAccountId,
		started
	};
}
async function stopChannelAccount(params) {
	const resolvedAccountId = resolveChannelGatewayAccountId(params);
	await params.context.stopChannel(params.channelId, resolvedAccountId);
	const stopped = resolveRuntimeAccountSnapshot({
		runtime: params.context.getRuntimeSnapshot(),
		channelId: params.channelId,
		accountId: resolvedAccountId
	})?.running !== true;
	return {
		channel: params.channelId,
		accountId: resolvedAccountId,
		stopped
	};
}
const channelsHandlers = {
	"channels.status": async ({ params, respond, context }) => {
		if (!validateChannelsStatusParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid channels.status params: ${formatValidationErrors(validateChannelsStatusParams.errors)}`));
			return;
		}
		const probe = params.probe === true;
		const timeoutMsRaw = params.timeoutMs;
		const timeoutMs = resolveChannelsStatusTimeoutMs({
			probe,
			timeoutMsRaw
		});
		const rawChannel = params.channel;
		const requestedChannel = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : void 0;
		const cfg = applyPluginAutoEnable({
			config: context.getRuntimeConfig(),
			env: process.env
		}).config;
		const runtime = context.getRuntimeSnapshot();
		const plugins = listChannelPlugins();
		const selectedPlugins = requestedChannel ? plugins.filter((plugin) => plugin.id === requestedChannel) : plugins;
		if (rawChannel !== void 0 && !requestedChannel) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unknown channel: ${formatForLog(rawChannel)}`));
			return;
		}
		const pluginMap = new Map(selectedPlugins.map((plugin) => [plugin.id, plugin]));
		const statusWarnings = [];
		const resolveRuntimeSnapshot = (channelId, accountId, defaultAccountId) => {
			const accounts = runtime.channelAccounts[channelId];
			const defaultRuntime = runtime.channels[channelId];
			const raw = accounts?.[accountId] ?? (accountId === defaultAccountId ? defaultRuntime : void 0);
			if (!raw) return;
			return raw;
		};
		const isAccountEnabled = (plugin, account) => plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : !account || typeof account !== "object" || account.enabled !== false;
		const buildAccountSnapshot = async (channelId, plugin, accountId, defaultAccountId) => {
			const account = plugin.config.resolveAccount(cfg, accountId);
			const enabled = isAccountEnabled(plugin, account);
			let probeResult;
			let lastProbeAt = null;
			if (probe && enabled && plugin.status?.probeAccount) {
				let configured = true;
				if (plugin.config.isConfigured) configured = await plugin.config.isConfigured(account, cfg);
				if (configured) {
					probeResult = await runChannelStatusHook({
						channelId,
						accountId,
						step: "probe",
						timeoutMs,
						warnings: statusWarnings,
						run: () => plugin.status.probeAccount({
							account,
							timeoutMs,
							cfg
						})
					});
					lastProbeAt = Date.now();
				}
			}
			let auditResult;
			if (probe && enabled && plugin.status?.auditAccount) {
				let configured = true;
				if (plugin.config.isConfigured) configured = await plugin.config.isConfigured(account, cfg);
				if (configured) auditResult = await runChannelStatusHook({
					channelId,
					accountId,
					step: "audit",
					timeoutMs,
					warnings: statusWarnings,
					run: () => plugin.status.auditAccount({
						account,
						timeoutMs,
						cfg,
						probe: probeResult
					})
				});
			}
			const snapshot = await buildChannelAccountSnapshot({
				plugin,
				cfg,
				accountId,
				runtime: resolveRuntimeSnapshot(channelId, accountId, defaultAccountId),
				probe: probeResult,
				audit: auditResult
			});
			const hookError = channelStatusFailureMessage(auditResult) ?? channelStatusFailureMessage(probeResult);
			if (hookError && !snapshot.lastError) snapshot.lastError = hookError;
			if (lastProbeAt) snapshot.lastProbeAt = lastProbeAt;
			const activity = getChannelActivity({
				channel: channelId,
				accountId
			});
			if (snapshot.lastInboundAt == null) snapshot.lastInboundAt = activity.inboundAt;
			if (snapshot.lastOutboundAt == null) snapshot.lastOutboundAt = activity.outboundAt;
			const health = evaluateChannelHealth(snapshot, {
				channelId,
				now: Date.now(),
				staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
				channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS
			});
			if (!health.healthy) snapshot.healthState = health.reason;
			return {
				accountId,
				account,
				snapshot
			};
		};
		const buildChannelAccounts = async (channelId) => {
			const plugin = pluginMap.get(channelId);
			if (!plugin) return {
				accounts: [],
				defaultAccountId: DEFAULT_ACCOUNT_ID,
				defaultAccount: void 0,
				resolvedAccounts: {}
			};
			const accountIds = plugin.config.listAccountIds(cfg);
			const defaultAccountId = resolveChannelDefaultAccountId({
				plugin,
				cfg,
				accountIds
			});
			const resolvedAccounts = {};
			const { results } = await runTasksWithConcurrency({
				tasks: accountIds.map((accountId) => async () => await buildAccountSnapshot(channelId, plugin, accountId, defaultAccountId)),
				limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : accountIds.length || 1
			});
			const accounts = [];
			for (const result of results) if (result) {
				resolvedAccounts[result.accountId] = result.account;
				accounts.push(result.snapshot);
			}
			return {
				accounts,
				defaultAccountId,
				defaultAccount: accounts.find((entry) => entry.accountId === defaultAccountId) ?? accounts[0],
				resolvedAccounts
			};
		};
		const uiCatalog = buildChannelUiCatalog(selectedPlugins);
		const payload = {
			ts: Date.now(),
			channelOrder: uiCatalog.order,
			channelLabels: uiCatalog.labels,
			channelDetailLabels: uiCatalog.detailLabels,
			channelSystemImages: uiCatalog.systemImages,
			channelMeta: uiCatalog.entries,
			...context.getEventLoopHealth ? { eventLoop: context.getEventLoopHealth() } : {},
			channels: {},
			channelAccounts: {},
			channelDefaultAccountId: {}
		};
		const channelsMap = payload.channels;
		const accountsMap = payload.channelAccounts;
		const defaultAccountIdMap = payload.channelDefaultAccountId;
		const { results: channelResults } = await runTasksWithConcurrency({
			tasks: selectedPlugins.map((plugin) => async () => {
				const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } = await buildChannelAccounts(plugin.id);
				const fallbackAccount = resolvedAccounts[defaultAccountId] ?? plugin.config.resolveAccount(cfg, defaultAccountId);
				const fallbackSummary = (lastError) => ({
					configured: defaultAccount?.configured ?? false,
					...lastError ? { lastError } : {}
				});
				let summary = fallbackSummary();
				if (plugin.status?.buildChannelSummary) {
					const summaryResult = await runChannelStatusSummary({
						channelId: plugin.id,
						timeoutMs,
						warnings: statusWarnings,
						run: () => plugin.status.buildChannelSummary({
							account: fallbackAccount,
							cfg,
							defaultAccountId,
							snapshot: defaultAccount ?? { accountId: defaultAccountId }
						})
					});
					summary = summaryResult.ok ? summaryResult.value : fallbackSummary(summaryResult.error);
				}
				return {
					pluginId: plugin.id,
					summary,
					accounts,
					defaultAccountId
				};
			}),
			limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : selectedPlugins.length || 1
		});
		for (const result of channelResults) if (result) {
			channelsMap[result.pluginId] = result.summary;
			accountsMap[result.pluginId] = result.accounts;
			defaultAccountIdMap[result.pluginId] = result.defaultAccountId;
		}
		if (statusWarnings.length > 0) {
			payload.partial = true;
			payload.warnings = statusWarnings.slice(0, 50);
		}
		respond(true, payload, void 0);
	},
	"channels.start": async ({ params, respond, context }) => {
		if (!validateChannelsStartParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid channels.start params: ${formatValidationErrors(validateChannelsStartParams.errors)}`));
			return;
		}
		const rawChannel = params.channel;
		const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
		if (!channelId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.start channel"));
			return;
		}
		const plugin = getChannelPlugin(channelId);
		if (!plugin) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unknown channel: ${formatForLog(rawChannel)}`));
			return;
		}
		if (!plugin.gateway?.startAccount) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support start`));
			return;
		}
		try {
			const cfg = applyPluginAutoEnable({
				config: context.getRuntimeConfig(),
				env: process.env
			}).config;
			respond(true, await startChannelAccount({
				channelId,
				accountId: params.accountId,
				cfg,
				context,
				plugin
			}), void 0);
		} catch (error) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
		}
	},
	"channels.stop": async ({ params, respond, context }) => {
		if (!validateChannelsStopParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid channels.stop params: ${formatValidationErrors(validateChannelsStopParams.errors)}`));
			return;
		}
		const rawChannel = params.channel;
		const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
		if (!channelId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.stop channel"));
			return;
		}
		const plugin = getChannelPlugin(channelId);
		if (!plugin) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unknown channel ${channelId}`));
			return;
		}
		const accountIdRaw = params.accountId;
		const accountId = normalizeOptionalString$1(accountIdRaw);
		try {
			respond(true, await stopChannelAccount({
				channelId,
				accountId,
				cfg: context.getRuntimeConfig(),
				context,
				plugin
			}), void 0);
		} catch (error) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
		}
	},
	"channels.logout": async ({ params, respond, context }) => {
		if (!validateChannelsLogoutParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid channels.logout params: ${formatValidationErrors(validateChannelsLogoutParams.errors)}`));
			return;
		}
		const rawChannel = params.channel;
		const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
		if (!channelId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.logout channel"));
			return;
		}
		const plugin = getChannelPlugin(channelId);
		if (!plugin?.gateway?.logoutAccount) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support logout`));
			return;
		}
		const accountIdRaw = params.accountId;
		const accountId = normalizeOptionalString$1(accountIdRaw);
		if (!(await readConfigFileSnapshot()).valid) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"));
			return;
		}
		try {
			respond(true, await logoutChannelAccount({
				channelId,
				accountId,
				cfg: context.getRuntimeConfig(),
				context,
				plugin
			}), void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	}
};
//#endregion
//#region src/gateway/server-methods/commands.ts
function clampString(value, maxLength) {
	return value.length > maxLength ? value.slice(0, maxLength) : value;
}
function trimClampNonEmpty(value, maxLength) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	return clampString(trimmed, maxLength);
}
function clampDescription(value) {
	return clampString(value ?? "", COMMAND_DESCRIPTION_MAX_LENGTH);
}
function resolveAgentIdOrRespondError$1(rawAgentId, respond, cfg) {
	const knownAgents = listAgentIds(cfg);
	const requestedAgentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
	const agentId = requestedAgentId || resolveDefaultAgentId(cfg);
	if (requestedAgentId && !knownAgents.includes(agentId)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`));
		return null;
	}
	return {
		cfg,
		agentId
	};
}
function resolveNativeName(cmd, provider) {
	const baseName = cmd.nativeName ?? cmd.key;
	if (!provider || !cmd.nativeName) return baseName;
	return getChannelPlugin(provider)?.commands?.resolveNativeCommandName?.({
		commandKey: cmd.key,
		defaultName: cmd.nativeName
	}) ?? baseName;
}
function stripLeadingSlash(value) {
	return value.startsWith("/") ? value.slice(1) : value;
}
function resolveTextAliases(cmd) {
	const seen = /* @__PURE__ */ new Set();
	const aliases = [];
	for (const alias of cmd.textAliases) {
		const trimmed = trimClampNonEmpty(alias, 200);
		if (!trimmed) continue;
		const exactAlias = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
		if (seen.has(exactAlias)) continue;
		seen.add(exactAlias);
		aliases.push(exactAlias);
		if (aliases.length >= 20) break;
	}
	if (aliases.length > 0) return aliases;
	return [`/${clampString(cmd.key, 200)}`];
}
function resolvePrimaryTextName(cmd) {
	return stripLeadingSlash(resolveTextAliases(cmd)[0] ?? `/${cmd.key}`);
}
function serializeArg(arg) {
	const isDynamic = typeof arg.choices === "function";
	const staticChoices = Array.isArray(arg.choices) ? arg.choices.slice(0, 50).map(normalizeChoice) : void 0;
	return {
		name: clampString(arg.name, 200),
		description: clampString(arg.description, 500),
		type: arg.type,
		...arg.required ? { required: true } : {},
		...staticChoices ? { choices: staticChoices } : {},
		...isDynamic ? { dynamic: true } : {}
	};
}
function normalizeChoice(choice) {
	if (typeof choice === "string") return {
		value: clampString(choice, 200),
		label: clampString(choice, 200)
	};
	return {
		value: clampString(choice.value, 200),
		label: clampString(choice.label, 200)
	};
}
function mapCommand(cmd, source, includeArgs, nameSurface, provider) {
	const shouldIncludeArgs = includeArgs && cmd.acceptsArgs && cmd.args?.length;
	const nativeName = cmd.scope === "text" ? void 0 : resolveNativeName(cmd, provider);
	return {
		name: clampString(nameSurface === "text" ? resolvePrimaryTextName(cmd) : nativeName ?? cmd.key, 200),
		...nativeName ? { nativeName: clampString(nativeName, 200) } : {},
		...cmd.scope !== "native" ? { textAliases: resolveTextAliases(cmd) } : {},
		description: clampDescription(cmd.description),
		...cmd.category ? { category: cmd.category } : {},
		source,
		scope: cmd.scope,
		acceptsArgs: Boolean(cmd.acceptsArgs),
		...shouldIncludeArgs ? { args: cmd.args.slice(0, 20).map(serializeArg) } : {}
	};
}
function buildPluginCommandEntries(params) {
	const pluginTextSpecs = listPluginCommands();
	const pluginNativeSpecs = getPluginCommandSpecs(params.provider, { config: params.cfg });
	const entries = [];
	for (const [index, textSpec] of pluginTextSpecs.entries()) {
		const nativeName = pluginNativeSpecs[index]?.name;
		entries.push({
			name: clampString(params.nameSurface === "text" ? textSpec.name : nativeName ?? textSpec.name, 200),
			...nativeName ? { nativeName: clampString(nativeName, 200) } : {},
			textAliases: [`/${clampString(textSpec.name, 200)}`],
			description: clampDescription(textSpec.description),
			source: "plugin",
			scope: "both",
			acceptsArgs: textSpec.acceptsArgs
		});
	}
	if (params.nameSurface === "native") return entries.filter((entry) => entry.nativeName);
	return entries;
}
function buildCommandsListResult(params) {
	const includeArgs = params.includeArgs !== false;
	const scopeFilter = params.scope ?? "both";
	const nameSurface = scopeFilter === "text" ? "text" : "native";
	const provider = normalizeOptionalLowercaseString(params.provider);
	const skillCommands = listSkillCommandsForAgents({
		cfg: params.cfg,
		agentIds: [params.agentId]
	});
	const chatCommands = listChatCommandsForConfig(params.cfg, { skillCommands });
	const skillKeys = new Set(skillCommands.map((sc) => `skill:${sc.skillName}`));
	const commands = [];
	for (const cmd of chatCommands) {
		if (scopeFilter !== "both" && cmd.scope !== "both" && cmd.scope !== scopeFilter) continue;
		commands.push(mapCommand(cmd, skillKeys.has(cmd.key) ? "skill" : "native", includeArgs, nameSurface, provider));
	}
	commands.push(...buildPluginCommandEntries({
		provider,
		nameSurface,
		cfg: params.cfg
	}));
	return { commands: commands.slice(0, 500) };
}
const commandsHandlers = { "commands.list": ({ params, respond, context }) => {
	if (!validateCommandsListParams(params)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid commands.list params: ${formatValidationErrors(validateCommandsListParams.errors)}`));
		return;
	}
	const resolved = resolveAgentIdOrRespondError$1(params.agentId, respond, context.getRuntimeConfig());
	if (!resolved) return;
	respond(true, buildCommandsListResult({
		cfg: resolved.cfg,
		agentId: resolved.agentId,
		provider: params.provider,
		scope: params.scope,
		includeArgs: params.includeArgs
	}), void 0);
} };
//#endregion
//#region src/gateway/server-methods/base-hash.ts
function resolveBaseHashParam(params) {
	const raw = params?.baseHash;
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed ? trimmed : null;
}
//#endregion
//#region src/gateway/server-methods/restart-request.ts
function parseRestartDeliveryContext(params) {
	const raw = params.deliveryContext;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {
		deliveryContext: void 0,
		threadId: void 0
	};
	const context = raw;
	const deliveryContext = {
		channel: normalizeOptionalString$1(context.channel),
		to: normalizeOptionalString$1(context.to),
		accountId: normalizeOptionalString$1(context.accountId)
	};
	return {
		deliveryContext: deliveryContext.channel || deliveryContext.to || deliveryContext.accountId ? deliveryContext : void 0,
		threadId: stringifyRouteThreadId(context.threadId)
	};
}
function parseRestartRequestParams(params) {
	const sessionKey = normalizeOptionalString$1(params.sessionKey);
	const { deliveryContext, threadId } = parseRestartDeliveryContext(params);
	const note = normalizeOptionalString$1(params.note);
	const continuationMessage = normalizeOptionalString$1(params.continuationMessage);
	const restartDelayMsRaw = params.restartDelayMs;
	return {
		sessionKey,
		deliveryContext,
		threadId,
		note,
		continuationMessage,
		restartDelayMs: typeof restartDelayMsRaw === "number" && Number.isFinite(restartDelayMsRaw) ? Math.max(0, Math.floor(restartDelayMsRaw)) : void 0
	};
}
//#endregion
//#region src/gateway/server-methods/config-write-flow.ts
function resolveGatewayConfigPath(snapshot) {
	return snapshot?.path ?? createConfigIO().configPath;
}
function normalizeStringListForAuthCompare(items) {
	return [...items ?? []].toSorted();
}
function normalizeTrustedProxyAuthForCompare(auth) {
	return {
		userHeader: auth.trustedProxy?.userHeader,
		requiredHeaders: normalizeStringListForAuthCompare(auth.trustedProxy?.requiredHeaders),
		allowUsers: normalizeStringListForAuthCompare(auth.trustedProxy?.allowUsers),
		allowLoopback: auth.trustedProxy?.allowLoopback
	};
}
function didSharedGatewayAuthChange(prev, next) {
	const prevResolvedAuth = resolveGatewayAuth({
		authConfig: prev.gateway?.auth,
		env: process.env,
		tailscaleMode: prev.gateway?.tailscale?.mode
	});
	const nextResolvedAuth = resolveGatewayAuth({
		authConfig: next.gateway?.auth,
		env: process.env,
		tailscaleMode: next.gateway?.tailscale?.mode
	});
	if (prevResolvedAuth.mode === "trusted-proxy" || nextResolvedAuth.mode === "trusted-proxy") {
		if (prevResolvedAuth.mode !== nextResolvedAuth.mode) return true;
		return !isDeepStrictEqual(normalizeTrustedProxyAuthForCompare(prevResolvedAuth), normalizeTrustedProxyAuthForCompare(nextResolvedAuth)) || !isDeepStrictEqual(normalizeStringListForAuthCompare(prev.gateway?.trustedProxies), normalizeStringListForAuthCompare(next.gateway?.trustedProxies));
	}
	const prevAuth = resolveEffectiveSharedGatewayAuth({
		authConfig: prev.gateway?.auth,
		env: process.env,
		tailscaleMode: prev.gateway?.tailscale?.mode
	});
	const nextAuth = resolveEffectiveSharedGatewayAuth({
		authConfig: next.gateway?.auth,
		env: process.env,
		tailscaleMode: next.gateway?.tailscale?.mode
	});
	if (prevAuth === null || nextAuth === null) return prevAuth !== nextAuth;
	return prevAuth.mode !== nextAuth.mode || !isDeepStrictEqual(prevAuth.secret, nextAuth.secret);
}
function didActiveSharedGatewayAuthChange(params) {
	return didSharedGatewayAuthChange(getActiveSecretsRuntimeSnapshot()?.config ?? params.fallbackPrev, params.next);
}
function queueSharedGatewayAuthDisconnect(shouldDisconnect, context) {
	if (!shouldDisconnect) return;
	queueMicrotask(() => {
		context?.disconnectClientsUsingSharedGatewayAuth?.();
	});
}
function queueSharedGatewayAuthGenerationRefresh(shouldRefresh, nextConfig, context) {
	if (!shouldRefresh) return;
	queueMicrotask(() => {
		context?.enforceSharedGatewayAuthGenerationForConfigWrite?.(nextConfig);
	});
}
function shouldScheduleDirectConfigRestart(params) {
	const reloadSettings = resolveGatewayReloadSettings(params.nextConfig);
	if (reloadSettings.mode === "off") return true;
	const plan = buildGatewayReloadPlan(params.changedPaths);
	if (reloadSettings.mode === "hot" && plan.restartGateway) return true;
	return false;
}
function resolveConfigRestartRequest(params) {
	const { sessionKey, deliveryContext: requestedDeliveryContext, threadId: requestedThreadId, note, restartDelayMs } = parseRestartRequestParams(params);
	const { deliveryContext: sessionDeliveryContext, threadId: sessionThreadId } = extractDeliveryInfo(sessionKey);
	return {
		sessionKey,
		note,
		restartDelayMs,
		deliveryContext: requestedDeliveryContext ?? sessionDeliveryContext,
		threadId: requestedThreadId ?? sessionThreadId
	};
}
function buildConfigRestartSentinelPayload(params) {
	return {
		kind: params.kind,
		status: "ok",
		ts: Date.now(),
		sessionKey: params.sessionKey,
		deliveryContext: params.deliveryContext,
		threadId: params.threadId,
		message: params.note ?? null,
		doctorHint: formatDoctorNonInteractiveHint(),
		stats: {
			mode: params.mode,
			root: params.configPath
		}
	};
}
async function tryWriteRestartSentinelPayload(payload) {
	try {
		return await writeRestartSentinel(payload);
	} catch {
		return null;
	}
}
async function commitGatewayConfigWrite(params) {
	const result = await replaceConfigFile({
		nextConfig: params.nextConfig,
		writeOptions: {
			...params.writeOptions,
			runtimeRefresh: {
				...params.writeOptions.runtimeRefresh,
				includeAuthStoreRefs: false
			}
		},
		afterWrite: { mode: "auto" }
	});
	return {
		path: resolveGatewayConfigPath(params.snapshot),
		config: result.nextConfig,
		queueFollowUp: () => {
			queueSharedGatewayAuthGenerationRefresh(true, result.nextConfig, params.context);
			queueSharedGatewayAuthDisconnect(Boolean(params.disconnectSharedAuthClients), params.context);
		}
	};
}
async function resolveGatewayConfigRestartWriteResult(params) {
	const { sessionKey, note, restartDelayMs, deliveryContext, threadId } = resolveConfigRestartRequest(params.requestParams);
	const payload = buildConfigRestartSentinelPayload({
		kind: params.kind,
		mode: params.mode,
		configPath: params.configPath,
		sessionKey,
		deliveryContext,
		threadId,
		note
	});
	const sentinelPath = await tryWriteRestartSentinelPayload(payload);
	const restart = shouldScheduleDirectConfigRestart({
		changedPaths: params.changedPaths,
		nextConfig: params.nextConfig
	}) ? scheduleGatewaySigusr1Restart({
		delayMs: restartDelayMs,
		reason: params.mode,
		audit: {
			actor: params.actor.actor,
			deviceId: params.actor.deviceId,
			clientIp: params.actor.clientIp,
			changedPaths: params.changedPaths
		}
	}) : void 0;
	if (restart?.coalesced) params.context?.logGateway?.warn(`${params.mode} restart coalesced ${formatControlPlaneActor(params.actor)} delayMs=${restart.delayMs}`);
	return {
		payload,
		sentinelPath,
		restart
	};
}
//#endregion
//#region src/gateway/server-methods/config.ts
const MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE = 3;
const CONFIG_SCHEMA_RESPONSE_CACHE_TTL_MS = 5e3;
let configSchemaResponseCache = null;
function requireConfigBaseHash(params, snapshot, respond) {
	if (!snapshot.exists) return true;
	const snapshotHash = resolveConfigSnapshotHash(snapshot);
	if (!snapshotHash) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "config base hash unavailable; re-run config.get and retry"));
		return false;
	}
	const baseHash = resolveBaseHashParam(params);
	if (!baseHash) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "config base hash required; re-run config.get and retry"));
		return false;
	}
	if (baseHash !== snapshotHash) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "config changed since last load; re-run config.get and retry"));
		return false;
	}
	return true;
}
function parseRawConfigOrRespond(params, requestName, respond) {
	const rawValue = params.raw;
	if (typeof rawValue !== "string") {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${requestName} params: raw (string) required`));
		return null;
	}
	return rawValue;
}
function sanitizeLookupPathForLog(path) {
	const sanitized = Array.from(path, (char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127 ? "?" : char;
	}).join("");
	return sanitized.length > 120 ? `${sanitized.slice(0, 117)}...` : sanitized;
}
function escapePowerShellSingleQuotedString(value) {
	return value.replaceAll("'", "''");
}
function resolveConfigOpenCommand(configPath, platform = process.platform) {
	if (platform === "win32") return {
		command: "powershell.exe",
		args: [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Start-Process -LiteralPath '${escapePowerShellSingleQuotedString(configPath)}'`
		]
	};
	return {
		command: platform === "darwin" ? "open" : "xdg-open",
		args: [configPath]
	};
}
function execConfigOpenCommand(command) {
	return new Promise((resolve, reject) => {
		execFile(command.command, command.args, (error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}
function formatConfigOpenError(error) {
	if (typeof error === "object" && error && "message" in error && typeof error.message === "string") return error.message;
	return String(error);
}
function parseValidateConfigFromRawOrRespond(params, requestName, snapshot, respond) {
	const rawValue = parseRawConfigOrRespond(params, requestName, respond);
	if (!rawValue) return null;
	const parsedRes = parseConfigJson5(rawValue);
	if (!parsedRes.ok) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
		return null;
	}
	const schema = loadSchemaWithPlugins();
	const restored = restoreRedactedValues(parsedRes.parsed, snapshot.config, schema.uiHints);
	if (!restored.ok) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, restored.humanReadableMessage ?? "invalid config"));
		return null;
	}
	const validated = validateConfigObjectWithPlugins(restored.result);
	if (!validated.ok) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, summarizeConfigValidationIssues(validated.issues), { details: { issues: validated.issues } }));
		return null;
	}
	return {
		config: validated.config,
		schema
	};
}
function summarizeConfigValidationIssues(issues) {
	const lines = formatConfigIssueLines(issues.slice(0, MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE), "", { normalizeRoot: true }).map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return "invalid config";
	const hiddenCount = Math.max(0, issues.length - lines.length);
	return `invalid config: ${lines.join("; ")}${hiddenCount > 0 ? ` (+${hiddenCount} more issue${hiddenCount === 1 ? "" : "s"})` : ""}`;
}
async function ensureResolvableSecretRefsOrRespond(params) {
	try {
		return await prepareSecretsRuntimeSnapshot({
			config: params.config,
			includeAuthStoreRefs: false
		});
	} catch (error) {
		const details = formatErrorMessage(error);
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid config: active SecretRef resolution failed (${details})`));
		return null;
	}
}
function clearConfigSchemaResponseCache() {
	configSchemaResponseCache = null;
}
function loadSchemaWithPlugins() {
	const now = Date.now();
	if (configSchemaResponseCache && configSchemaResponseCache.expiresAtMs > now) return configSchemaResponseCache.response;
	const response = loadGatewayRuntimeConfigSchema();
	configSchemaResponseCache = {
		expiresAtMs: Date.now() + CONFIG_SCHEMA_RESPONSE_CACHE_TTL_MS,
		response
	};
	return response;
}
const configHandlers = {
	"config.get": async ({ params, respond }) => {
		if (!assertValidParams(params, validateConfigGetParams, "config.get", respond)) return;
		respond(true, redactConfigSnapshot(await readConfigFileSnapshot(), loadSchemaWithPlugins().uiHints), void 0);
	},
	"config.schema": ({ params, respond }) => {
		if (!assertValidParams(params, validateConfigSchemaParams, "config.schema", respond)) return;
		respond(true, loadSchemaWithPlugins(), void 0);
	},
	"config.schema.lookup": ({ params, respond, context }) => {
		if (!assertValidParams(params, validateConfigSchemaLookupParams, "config.schema.lookup", respond)) return;
		const path = params.path;
		const result = lookupConfigSchema(loadSchemaWithPlugins(), path, resolveConfigReloadMetadata);
		if (!result) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "config schema path not found"));
			return;
		}
		if (!validateConfigSchemaLookupResult(result)) {
			const errors = validateConfigSchemaLookupResult.errors ?? [];
			context.logGateway.warn(`config.schema.lookup produced invalid payload for ${sanitizeLookupPathForLog(path)}: ${formatValidationErrors(errors)}`);
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "config.schema.lookup returned invalid payload", { details: { errors } }));
			return;
		}
		respond(true, result, void 0);
	},
	"config.set": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateConfigSetParams, "config.set", respond)) return;
		const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
		if (!requireConfigBaseHash(params, snapshot, respond)) return;
		const parsed = parseValidateConfigFromRawOrRespond(params, "config.set", snapshot, respond);
		if (!parsed) return;
		if (!await ensureResolvableSecretRefsOrRespond({
			config: parsed.config,
			respond
		})) return;
		const writeResult = await commitGatewayConfigWrite({
			snapshot,
			writeOptions,
			nextConfig: parsed.config,
			context
		});
		clearConfigSchemaResponseCache();
		respond(true, {
			ok: true,
			path: writeResult.path,
			config: redactConfigObject(writeResult.config, parsed.schema.uiHints)
		}, void 0);
		writeResult.queueFollowUp();
	},
	"config.patch": async ({ params, respond, client, context }) => {
		if (!assertValidParams(params, validateConfigPatchParams, "config.patch", respond)) return;
		const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
		if (!requireConfigBaseHash(params, snapshot, respond)) return;
		if (!snapshot.valid) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before patching"));
			return;
		}
		const rawValue = params.raw;
		if (typeof rawValue !== "string") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid config.patch params: raw (string) required"));
			return;
		}
		const parsedRes = parseConfigJson5(rawValue);
		if (!parsedRes.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
			return;
		}
		if (!parsedRes.parsed || typeof parsedRes.parsed !== "object" || Array.isArray(parsedRes.parsed)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "config.patch raw must be an object"));
			return;
		}
		const merged = applyMergePatch(snapshot.config, parsedRes.parsed, { mergeObjectArraysById: true });
		const schemaPatch = loadSchemaWithPlugins();
		const restoredMerge = restoreRedactedValues(merged, snapshot.config, schemaPatch.uiHints);
		if (!restoredMerge.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, restoredMerge.humanReadableMessage ?? "invalid config"));
			return;
		}
		const restoredChangedPaths = diffConfigPaths(snapshot.config, restoredMerge.result);
		const actor = resolveControlPlaneActor(client);
		if (restoredChangedPaths.length === 0) {
			context?.logGateway?.info(`config.patch noop ${formatControlPlaneActor(actor)} (no changed paths)`);
			respond(true, {
				ok: true,
				noop: true,
				path: resolveGatewayConfigPath(snapshot),
				config: redactConfigObject(snapshot.config, schemaPatch.uiHints)
			}, void 0);
			return;
		}
		const validated = validateConfigObjectWithPlugins(restoredMerge.result);
		if (!validated.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, summarizeConfigValidationIssues(validated.issues), { details: { issues: validated.issues } }));
			return;
		}
		const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
			config: validated.config,
			respond
		});
		if (!preparedSecretsSnapshot) return;
		const changedPaths = diffConfigPaths(snapshot.config, validated.config);
		if (changedPaths.length === 0) {
			context?.logGateway?.info(`config.patch noop ${formatControlPlaneActor(actor)} (no changed paths)`);
			respond(true, {
				ok: true,
				noop: true,
				path: resolveGatewayConfigPath(snapshot),
				config: redactConfigObject(validated.config, schemaPatch.uiHints)
			}, void 0);
			return;
		}
		context?.logGateway?.info(`config.patch write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.patch`);
		const disconnectSharedAuthClients = didSharedGatewayAuthChange(snapshot.config, validated.config) || didActiveSharedGatewayAuthChange({
			fallbackPrev: snapshot.config,
			next: preparedSecretsSnapshot.config
		});
		const writeResult = await commitGatewayConfigWrite({
			snapshot,
			writeOptions,
			nextConfig: validated.config,
			context,
			disconnectSharedAuthClients
		});
		clearConfigSchemaResponseCache();
		const { payload, sentinelPath, restart } = await resolveGatewayConfigRestartWriteResult({
			requestParams: params,
			kind: "config-patch",
			mode: "config.patch",
			configPath: writeResult.path,
			changedPaths,
			nextConfig: writeResult.config,
			actor,
			context
		});
		respond(true, {
			ok: true,
			path: writeResult.path,
			config: redactConfigObject(writeResult.config, schemaPatch.uiHints),
			restart,
			sentinel: {
				path: sentinelPath,
				payload
			}
		}, void 0);
		writeResult.queueFollowUp();
	},
	"config.apply": async ({ params, respond, client, context }) => {
		if (!assertValidParams(params, validateConfigApplyParams, "config.apply", respond)) return;
		const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
		if (!requireConfigBaseHash(params, snapshot, respond)) return;
		const parsed = parseValidateConfigFromRawOrRespond(params, "config.apply", snapshot, respond);
		if (!parsed) return;
		const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
			config: parsed.config,
			respond
		});
		if (!preparedSecretsSnapshot) return;
		const changedPaths = diffConfigPaths(snapshot.config, parsed.config);
		const actor = resolveControlPlaneActor(client);
		context?.logGateway?.info(`config.apply write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.apply`);
		const disconnectSharedAuthClients = didSharedGatewayAuthChange(snapshot.config, parsed.config) || didActiveSharedGatewayAuthChange({
			fallbackPrev: snapshot.config,
			next: preparedSecretsSnapshot.config
		});
		const writeResult = await commitGatewayConfigWrite({
			snapshot,
			writeOptions,
			nextConfig: parsed.config,
			context,
			disconnectSharedAuthClients
		});
		clearConfigSchemaResponseCache();
		const { payload, sentinelPath, restart } = await resolveGatewayConfigRestartWriteResult({
			requestParams: params,
			kind: "config-apply",
			mode: "config.apply",
			configPath: writeResult.path,
			changedPaths,
			nextConfig: writeResult.config,
			actor,
			context
		});
		respond(true, {
			ok: true,
			path: writeResult.path,
			config: redactConfigObject(writeResult.config, parsed.schema.uiHints),
			restart,
			sentinel: {
				path: sentinelPath,
				payload
			}
		}, void 0);
		writeResult.queueFollowUp();
	},
	"config.openFile": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateConfigGetParams, "config.openFile", respond)) return;
		const configPath = createConfigIO().configPath;
		try {
			await execConfigOpenCommand(resolveConfigOpenCommand(configPath));
			respond(true, {
				ok: true,
				path: configPath
			}, void 0);
		} catch (error) {
			context?.logGateway?.warn(`config.openFile failed path=${sanitizeLookupPathForLog(configPath)}: ${formatConfigOpenError(error)}`);
			respond(true, {
				ok: false,
				path: configPath,
				error: "failed to open config file"
			}, void 0);
		}
	}
};
//#endregion
//#region src/gateway/server-methods/connect.ts
const connectHandlers = { connect: ({ respond }) => {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "connect is only valid as the first request"));
} };
//#endregion
//#region src/cron/delivery-preview.ts
function formatTarget(channel, to) {
	if (!channel) return "last";
	if (to) return `${channel}:${to}`;
	return channel;
}
function formatDeliveryDetail(params) {
	if (params.requestedChannel === "last" || !params.requestedChannel) {
		if (!params.resolved) return params.error ? `last -> no route, will fail-closed: ${params.error}` : "last -> no route, will fail-closed";
		return params.sessionKey ? `resolved from last, session ${params.sessionKey}` : "resolved from last, main session";
	}
	return params.resolved ? "explicit" : params.error ?? "unresolved";
}
async function resolveCronDeliveryPreview(params) {
	const plan = resolveCronDeliveryPlan(params.job);
	if (plan.mode === "none") return {
		label: "not requested",
		detail: "not requested"
	};
	if (plan.mode === "webhook") return {
		label: plan.to ? `webhook:${plan.to}` : "webhook",
		detail: plan.to ? "webhook" : "webhook target missing"
	};
	const requestedChannel = plan.channel ?? "last";
	const agentId = params.job.agentId?.trim() || params.defaultAgentId || resolveDefaultAgentId(params.cfg);
	const deliverySessionKey = resolveCronDeliverySessionKey(params.job);
	const resolved = await resolveDeliveryTarget(params.cfg, agentId, {
		channel: requestedChannel,
		to: plan.to,
		threadId: plan.threadId,
		accountId: plan.accountId,
		sessionKey: deliverySessionKey
	}, { dryRun: true });
	if (!resolved.ok) return {
		label: `${plan.mode} -> ${formatTarget(requestedChannel, plan.to ?? null)}`,
		detail: formatDeliveryDetail({
			requestedChannel,
			resolved: false,
			sessionKey: deliverySessionKey,
			error: resolved.error.message
		})
	};
	return {
		label: `${plan.mode} -> ${formatTarget(resolved.channel, resolved.to)}`,
		detail: formatDeliveryDetail({
			requestedChannel,
			resolved: true,
			sessionKey: deliverySessionKey
		})
	};
}
async function resolveCronDeliveryPreviews(params) {
	const entries = await Promise.all(params.jobs.map(async (job) => [job.id, await resolveCronDeliveryPreview({
		cfg: params.cfg,
		defaultAgentId: params.defaultAgentId,
		job
	})]));
	return Object.fromEntries(entries);
}
//#endregion
//#region src/cron/validate-timestamp.ts
const ONE_MINUTE_MS = 60 * 1e3;
const TEN_YEARS_MS = 10 * 365.25 * 24 * 60 * 60 * 1e3;
/**
* Validates at timestamps in cron schedules.
* Rejects timestamps that are:
* - More than 1 minute in the past
* - More than 10 years in the future
*/
function validateScheduleTimestamp(schedule, nowMs = Date.now()) {
	if (schedule.kind !== "at") return { ok: true };
	const atRaw = normalizeOptionalString$1(schedule.at) ?? "";
	const atMs = atRaw ? parseAbsoluteTimeMs(atRaw) : null;
	if (atMs === null || !Number.isFinite(atMs)) return {
		ok: false,
		message: `Invalid schedule.at: expected ISO-8601 timestamp (got ${schedule.at})`
	};
	const diffMs = atMs - nowMs;
	if (diffMs < -6e4) {
		const nowDate = new Date(nowMs).toISOString();
		return {
			ok: false,
			message: `schedule.at is in the past: ${new Date(atMs).toISOString()} (${Math.floor(-diffMs / ONE_MINUTE_MS)} minutes ago). Current time: ${nowDate}`
		};
	}
	if (diffMs > TEN_YEARS_MS) return {
		ok: false,
		message: `schedule.at is too far in the future: ${new Date(atMs).toISOString()} (${Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1e3))} years ahead). Maximum allowed: 10 years`
	};
	return { ok: true };
}
//#endregion
//#region src/gateway/server-methods/cron.ts
function listConfiguredAnnounceChannelIds(cfg) {
	return listConfiguredAnnounceChannelIdsForConfig({
		config: cfg,
		env: process.env
	});
}
function assertConfiguredAnnounceChannel(params) {
	if (params.channel === "last") return;
	const configuredChannels = listConfiguredAnnounceChannelIds(params.cfg).toSorted();
	const normalizedChannel = normalizeMessageChannel(params.channel);
	if (!normalizedChannel) {
		if (configuredChannels.length <= 1) return;
		throw new Error(`${params.field} is required when multiple channels are configured: ${configuredChannels.join(", ")}`);
	}
	if (configuredChannels.length === 0) return;
	if (configuredChannels.includes(normalizedChannel)) return;
	throw new Error(`${params.field} must be one of: ${configuredChannels.join(", ")}`);
}
function resolveAnnounceValidationChannel(params) {
	if (params.channel && params.channel !== "last") return params.channel;
	return resolveTargetPrefixedChannel(params.to) ?? params.channel;
}
function assertCompatibleAnnounceTarget(params) {
	if (!params.channel || params.channel === "last") return;
	const error = validateTargetProviderPrefix({
		channel: params.channel,
		to: params.to
	});
	if (error) throw new Error(`${params.field}: ${error.message}`);
}
function assertValidCronAnnounceDelivery(params) {
	if (params.delivery && (params.delivery.mode ?? "announce") === "announce") {
		assertCompatibleAnnounceTarget({
			channel: params.delivery.channel,
			to: params.delivery.to,
			field: "delivery.channel"
		});
		assertConfiguredAnnounceChannel({
			cfg: params.cfg,
			channel: resolveAnnounceValidationChannel({
				channel: params.delivery.channel,
				to: params.delivery.to
			}),
			field: "delivery.channel"
		});
	}
	const failureDestination = params.delivery?.failureDestination;
	if (failureDestination && (failureDestination.mode ?? "announce") === "announce") {
		assertCompatibleAnnounceTarget({
			channel: failureDestination.channel,
			to: failureDestination.to,
			field: "delivery.failureDestination.channel"
		});
		assertConfiguredAnnounceChannel({
			cfg: params.cfg,
			channel: resolveAnnounceValidationChannel({
				channel: failureDestination.channel,
				to: failureDestination.to
			}),
			field: "delivery.failureDestination.channel"
		});
	}
}
function assertValidCronCreateDelivery(cfg, jobCreate) {
	assertValidCronAnnounceDelivery({
		cfg,
		delivery: jobCreate.delivery
	});
}
function assertValidCronUpdateDelivery(params) {
	if (!params.currentJob || !("delivery" in params.patch)) return;
	const nextJob = structuredClone(params.currentJob);
	applyJobPatch(nextJob, params.patch, { defaultAgentId: params.defaultAgentId });
	assertValidCronAnnounceDelivery({
		cfg: params.cfg,
		delivery: nextJob.delivery
	});
}
const cronHandlers = {
	wake: ({ params, respond, context }) => {
		if (!validateWakeParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid wake params: ${formatValidationErrors(validateWakeParams.errors)}`));
			return;
		}
		const p = params;
		const sessionKey = p.sessionKey?.trim() || void 0;
		if (sessionKey && isSubagentSessionKey(sessionKey)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "wake sessionKey cannot target a subagent session"));
			return;
		}
		respond(true, context.cron.wake({
			mode: p.mode,
			text: p.text,
			...sessionKey ? { sessionKey } : {}
		}), void 0);
	},
	"cron.list": async ({ params, respond, context }) => {
		if (!validateCronListParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.list params: ${formatValidationErrors(validateCronListParams.errors)}`));
			return;
		}
		const p = params;
		const page = await context.cron.listPage({
			includeDisabled: p.includeDisabled,
			limit: p.limit,
			offset: p.offset,
			query: p.query,
			enabled: p.enabled,
			sortBy: p.sortBy,
			sortDir: p.sortDir,
			agentId: p.agentId
		});
		const deliveryPreviews = await resolveCronDeliveryPreviews({
			cfg: context.getRuntimeConfig(),
			defaultAgentId: context.cron.getDefaultAgentId(),
			jobs: page.jobs
		});
		respond(true, {
			...page,
			deliveryPreviews
		}, void 0);
	},
	"cron.status": async ({ params, respond, context }) => {
		if (!validateCronStatusParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.status params: ${formatValidationErrors(validateCronStatusParams.errors)}`));
			return;
		}
		respond(true, await context.cron.status(), void 0);
	},
	"cron.get": async ({ params, respond, context }) => {
		if (!validateCronGetParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.get params: ${formatValidationErrors(validateCronGetParams.errors)}`));
			return;
		}
		const p = params;
		const jobId = p.id ?? p.jobId;
		if (!jobId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.get params: missing id"));
			return;
		}
		const job = await context.cron.readJob(jobId);
		if (!job) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `cron job not found: ${jobId}`));
			return;
		}
		respond(true, job, void 0);
	},
	"cron.add": async ({ params, respond, context }) => {
		const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : void 0;
		let normalized;
		try {
			normalized = normalizeCronJobCreate(params, { sessionContext: { sessionKey } }) ?? params;
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.add params: ${formatErrorMessage(err)}`));
			return;
		}
		if (!validateCronAddParams(normalized)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`));
			return;
		}
		const jobCreate = normalized;
		const cfg = context.getRuntimeConfig();
		const timestampValidation = validateScheduleTimestamp(jobCreate.schedule);
		if (!timestampValidation.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message));
			return;
		}
		try {
			assertValidCronCreateDelivery(cfg, jobCreate);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.add params: ${formatErrorMessage(err)}`));
			return;
		}
		let job;
		try {
			job = await context.cron.add(jobCreate);
		} catch (err) {
			if (!(err instanceof TypeError) && !(err instanceof RangeError)) throw err;
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.add params: ${formatErrorMessage(err)}`));
			return;
		}
		context.logGateway.info("cron: job created", {
			jobId: job.id,
			schedule: jobCreate.schedule
		});
		respond(true, job, void 0);
	},
	"cron.update": async ({ params, respond, context }) => {
		let normalizedPatch;
		try {
			normalizedPatch = normalizeCronJobPatch(params?.patch);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.update params: ${formatErrorMessage(err)}`));
			return;
		}
		const candidate = normalizedPatch && typeof params === "object" && params !== null ? {
			...params,
			patch: normalizedPatch
		} : params;
		if (!validateCronUpdateParams(candidate)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.update params: ${formatValidationErrors(validateCronUpdateParams.errors)}`));
			return;
		}
		const p = candidate;
		const jobId = p.id ?? p.jobId;
		if (!jobId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.update params: missing id"));
			return;
		}
		const patch = p.patch;
		const cfg = context.getRuntimeConfig();
		if (patch.schedule) {
			const timestampValidation = validateScheduleTimestamp(patch.schedule);
			if (!timestampValidation.ok) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message));
				return;
			}
		}
		try {
			assertValidCronUpdateDelivery({
				cfg,
				defaultAgentId: context.cron.getDefaultAgentId(),
				currentJob: context.cron.getJob(jobId),
				patch
			});
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.update params: ${formatErrorMessage(err)}`));
			return;
		}
		let job;
		try {
			job = await context.cron.update(jobId, patch);
		} catch (err) {
			if (!(err instanceof TypeError) && !(err instanceof RangeError)) throw err;
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.update params: ${formatErrorMessage(err)}`));
			return;
		}
		context.logGateway.info("cron: job updated", { jobId });
		respond(true, job, void 0);
	},
	"cron.remove": async ({ params, respond, context }) => {
		if (!validateCronRemoveParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.remove params: ${formatValidationErrors(validateCronRemoveParams.errors)}`));
			return;
		}
		const p = params;
		const jobId = p.id ?? p.jobId;
		if (!jobId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.remove params: missing id"));
			return;
		}
		const result = await context.cron.remove(jobId);
		if (result.removed) context.logGateway.info("cron: job removed", { jobId });
		respond(true, result, void 0);
	},
	"cron.run": async ({ params, respond, context }) => {
		if (!validateCronRunParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.run params: ${formatValidationErrors(validateCronRunParams.errors)}`));
			return;
		}
		const p = params;
		const jobId = p.id ?? p.jobId;
		if (!jobId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.run params: missing id"));
			return;
		}
		let result;
		try {
			result = await context.cron.enqueueRun(jobId, p.mode ?? "force");
		} catch (error) {
			if (isInvalidCronSessionTargetIdError(error)) {
				respond(true, {
					ok: true,
					ran: false,
					reason: "invalid-spec"
				}, void 0);
				return;
			}
			throw error;
		}
		respond(true, result, void 0);
	},
	"cron.runs": async ({ params, respond, context }) => {
		if (!validateCronRunsParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.runs params: ${formatValidationErrors(validateCronRunsParams.errors)}`));
			return;
		}
		const p = params;
		const explicitScope = p.scope;
		const jobId = p.id ?? p.jobId;
		const scope = explicitScope ?? (jobId ? "job" : "all");
		if (scope === "job" && !jobId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: missing id"));
			return;
		}
		if (scope === "all") {
			const jobs = await context.cron.list({ includeDisabled: true });
			const jobNameById = Object.fromEntries(jobs.filter((job) => typeof job.id === "string" && typeof job.name === "string").map((job) => [job.id, job.name]));
			respond(true, await readCronRunLogEntriesPageAll({
				storePath: context.cronStorePath,
				limit: p.limit,
				offset: p.offset,
				statuses: p.statuses,
				status: p.status,
				runId: p.runId,
				deliveryStatuses: p.deliveryStatuses,
				deliveryStatus: p.deliveryStatus,
				query: p.query,
				sortDir: p.sortDir,
				jobNameById
			}), void 0);
			return;
		}
		let logPath;
		try {
			logPath = resolveCronRunLogPath({
				storePath: context.cronStorePath,
				jobId
			});
		} catch {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: invalid id"));
			return;
		}
		respond(true, await readCronRunLogEntriesPage(logPath, {
			limit: p.limit,
			offset: p.offset,
			jobId,
			statuses: p.statuses,
			status: p.status,
			runId: p.runId,
			deliveryStatuses: p.deliveryStatuses,
			deliveryStatus: p.deliveryStatus,
			query: p.query,
			sortDir: p.sortDir
		}), void 0);
	}
};
//#endregion
//#region src/gateway/server-methods/devices.ts
const DEVICE_TOKEN_ROTATION_DENIED_MESSAGE = "device token rotation denied";
const DEVICE_TOKEN_REVOCATION_DENIED_MESSAGE = "device token revocation denied";
const DEVICE_PAIR_APPROVAL_DENIED_MESSAGE = "device pairing approval denied";
const DEVICE_PAIR_REJECTION_DENIED_MESSAGE = "device pairing rejection denied";
function redactPairedDevice(device) {
	const { tokens, approvedScopes: _approvedScopes, ...rest } = device;
	return {
		...rest,
		tokens: summarizeDeviceTokens(tokens)
	};
}
function logDeviceTokenRotationDenied(params) {
	const suffix = params.scope ? ` scope=${params.scope}` : "";
	params.log.warn(`device token rotation denied device=${params.deviceId} role=${params.role} reason=${params.reason}${suffix}`);
}
function logDeviceTokenRevocationDenied(params) {
	const suffix = params.scope ? ` scope=${params.scope}` : "";
	params.log.warn(`device token revocation denied device=${params.deviceId} role=${params.role} reason=${params.reason}${suffix}`);
}
function resolveDeviceManagementAuthz(client, targetDeviceId) {
	return {
		...resolveDeviceSessionAuthz(client),
		normalizedTargetDeviceId: targetDeviceId.trim()
	};
}
function resolveDeviceSessionAuthz(client) {
	const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
	const rawCallerDeviceId = client?.connect?.device?.id;
	return {
		callerDeviceId: client?.isDeviceTokenAuth && typeof rawCallerDeviceId === "string" && rawCallerDeviceId.trim() ? rawCallerDeviceId.trim() : null,
		callerScopes,
		isAdminCaller: callerScopes.includes("operator.admin")
	};
}
function deniesCrossDeviceManagement(authz) {
	return Boolean(authz.callerDeviceId && authz.callerDeviceId !== authz.normalizedTargetDeviceId && !authz.isAdminCaller);
}
function shouldReturnRotatedDeviceToken(authz) {
	return Boolean(authz.callerDeviceId && authz.callerDeviceId === authz.normalizedTargetDeviceId);
}
function deniesDeviceTokenRoleManagement(authz, targetRole) {
	const normalizedTargetRole = targetRole.trim();
	if (!normalizedTargetRole || authz.isAdminCaller) return false;
	return normalizedTargetRole !== "operator";
}
function hasNonOperatorDeviceRole(input) {
	const roles = /* @__PURE__ */ new Set();
	const role = input.role?.trim();
	if (role) roles.add(role);
	for (const entry of input.roles ?? []) {
		const normalized = entry.trim();
		if (normalized) roles.add(normalized);
	}
	return [...roles].some((entry) => entry !== "operator");
}
function hasNonOperatorDeviceTokenRole(tokens) {
	for (const token of Object.values(tokens ?? {})) {
		const normalized = token.role.trim();
		if (normalized && normalized !== "operator") return true;
	}
	return false;
}
function requestsNonOperatorDeviceRole(pending) {
	return hasNonOperatorDeviceRole(pending);
}
function pairedDeviceHasNonOperatorRole(device) {
	return hasNonOperatorDeviceRole(device) || hasNonOperatorDeviceTokenRole(device.tokens);
}
const deviceHandlers = {
	"device.pair.list": async ({ params, respond, client }) => {
		if (!validateDevicePairListParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.pair.list params: ${formatValidationErrors(validateDevicePairListParams.errors)}`));
			return;
		}
		const list = await listDevicePairing();
		const authz = resolveDeviceSessionAuthz(client);
		const visibleList = authz.callerDeviceId && !authz.isAdminCaller ? {
			pending: list.pending.filter((request) => request.deviceId.trim() === authz.callerDeviceId),
			paired: list.paired.filter((device) => device.deviceId.trim() === authz.callerDeviceId)
		} : list;
		respond(true, {
			pending: visibleList.pending,
			paired: visibleList.paired.map((device) => redactPairedDevice(device))
		}, void 0);
	},
	"device.pair.approve": async ({ params, respond, context, client }) => {
		if (!validateDevicePairApproveParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.pair.approve params: ${formatValidationErrors(validateDevicePairApproveParams.errors)}`));
			return;
		}
		const { requestId } = params;
		const authz = resolveDeviceSessionAuthz(client);
		if (authz.callerDeviceId && !authz.isAdminCaller) {
			const pending = await getPendingDevicePairing(requestId);
			if (!pending) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE));
				return;
			}
			if (pending.deviceId.trim() !== authz.callerDeviceId) {
				context.logGateway.warn(`device pairing approval denied request=${requestId} reason=device-ownership-mismatch`);
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE));
				return;
			}
			if (requestsNonOperatorDeviceRole(pending)) {
				context.logGateway.warn(`device pairing approval denied request=${requestId} reason=role-management-requires-admin`);
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE));
				return;
			}
		}
		const approved = await approveDevicePairing(requestId, { callerScopes: authz.callerScopes });
		if (!approved) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
			return;
		}
		if (approved.status === "forbidden") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, formatDevicePairingForbiddenMessage(approved)));
			return;
		}
		context.logGateway.info(`device pairing approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`);
		context.broadcast("device.pair.resolved", {
			requestId,
			deviceId: approved.device.deviceId,
			decision: "approved",
			ts: Date.now()
		}, { dropIfSlow: true });
		respond(true, {
			requestId,
			device: redactPairedDevice(approved.device)
		}, void 0);
	},
	"device.pair.reject": async ({ params, respond, context, client }) => {
		if (!validateDevicePairRejectParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.pair.reject params: ${formatValidationErrors(validateDevicePairRejectParams.errors)}`));
			return;
		}
		const { requestId } = params;
		const authz = resolveDeviceSessionAuthz(client);
		if (authz.callerDeviceId && !authz.isAdminCaller) {
			const pending = await getPendingDevicePairing(requestId);
			if (!pending) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_REJECTION_DENIED_MESSAGE));
				return;
			}
			if (pending.deviceId.trim() !== authz.callerDeviceId) {
				context.logGateway.warn(`device pairing rejection denied request=${requestId} reason=device-ownership-mismatch`);
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_REJECTION_DENIED_MESSAGE));
				return;
			}
		}
		const rejected = await rejectDevicePairing(requestId);
		if (!rejected) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
			return;
		}
		context.broadcast("device.pair.resolved", {
			requestId,
			deviceId: rejected.deviceId,
			decision: "rejected",
			ts: Date.now()
		}, { dropIfSlow: true });
		respond(true, rejected, void 0);
	},
	"device.pair.remove": async ({ params, respond, context, client }) => {
		if (!validateDevicePairRemoveParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.pair.remove params: ${formatValidationErrors(validateDevicePairRemoveParams.errors)}`));
			return;
		}
		const { deviceId } = params;
		const authz = resolveDeviceManagementAuthz(client, deviceId);
		if (deniesCrossDeviceManagement(authz)) {
			context.logGateway.warn(`device pairing removal denied device=${deviceId} reason=device-ownership-mismatch`);
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "device pairing removal denied"));
			return;
		}
		if (authz.callerDeviceId && !authz.isAdminCaller) {
			const paired = await getPairedDevice(authz.normalizedTargetDeviceId);
			if (paired && pairedDeviceHasNonOperatorRole(paired)) {
				context.logGateway.warn(`device pairing removal denied device=${deviceId} reason=role-management-requires-admin`);
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "device pairing removal denied"));
				return;
			}
		}
		const removed = await removePairedDevice(deviceId);
		if (!removed) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId"));
			return;
		}
		context.logGateway.info(`device pairing removed device=${removed.deviceId}`);
		respond(true, removed, void 0);
		queueMicrotask(() => {
			context.disconnectClientsForDevice?.(removed.deviceId);
		});
	},
	"device.token.rotate": async ({ params, respond, context, client }) => {
		if (!validateDeviceTokenRotateParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.token.rotate params: ${formatValidationErrors(validateDeviceTokenRotateParams.errors)}`));
			return;
		}
		const { deviceId, role, scopes } = params;
		const authz = resolveDeviceManagementAuthz(client, deviceId);
		if (deniesCrossDeviceManagement(authz)) {
			logDeviceTokenRotationDenied({
				log: context.logGateway,
				deviceId,
				role,
				reason: "device-ownership-mismatch"
			});
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE));
			return;
		}
		if (deniesDeviceTokenRoleManagement(authz, role)) {
			logDeviceTokenRotationDenied({
				log: context.logGateway,
				deviceId,
				role,
				reason: "role-management-requires-admin"
			});
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE));
			return;
		}
		const rotated = await rotateDeviceToken({
			deviceId,
			role,
			scopes,
			callerScopes: authz.callerScopes
		});
		if (!rotated.ok) {
			logDeviceTokenRotationDenied({
				log: context.logGateway,
				deviceId,
				role,
				reason: rotated.reason,
				scope: rotated.scope
			});
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE));
			return;
		}
		const entry = rotated.entry;
		context.logGateway.info(`device token rotated device=${deviceId} role=${entry.role} scopes=${entry.scopes.join(",")}`);
		respond(true, {
			deviceId,
			role: entry.role,
			...shouldReturnRotatedDeviceToken(authz) ? { token: entry.token } : {},
			scopes: entry.scopes,
			rotatedAtMs: entry.rotatedAtMs ?? entry.createdAtMs
		}, void 0);
		queueMicrotask(() => {
			context.disconnectClientsForDevice?.(deviceId.trim(), { role: entry.role });
		});
	},
	"device.token.revoke": async ({ params, respond, context, client }) => {
		if (!validateDeviceTokenRevokeParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.token.revoke params: ${formatValidationErrors(validateDeviceTokenRevokeParams.errors)}`));
			return;
		}
		const { deviceId, role } = params;
		const authz = resolveDeviceManagementAuthz(client, deviceId);
		if (deniesCrossDeviceManagement(authz)) {
			context.logGateway.warn(`device token revocation denied device=${deviceId} role=${role} reason=device-ownership-mismatch`);
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_REVOCATION_DENIED_MESSAGE));
			return;
		}
		if (deniesDeviceTokenRoleManagement(authz, role)) {
			logDeviceTokenRevocationDenied({
				log: context.logGateway,
				deviceId,
				role,
				reason: "role-management-requires-admin"
			});
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_REVOCATION_DENIED_MESSAGE));
			return;
		}
		const revoked = await revokeDeviceToken({
			deviceId,
			role,
			callerScopes: authz.callerScopes
		});
		if (!revoked.ok) {
			logDeviceTokenRevocationDenied({
				log: context.logGateway,
				deviceId,
				role,
				reason: revoked.reason,
				scope: revoked.scope
			});
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_REVOCATION_DENIED_MESSAGE));
			return;
		}
		const entry = revoked.entry;
		const normalizedDeviceId = deviceId.trim();
		context.logGateway.info(`device token revoked device=${normalizedDeviceId} role=${entry.role}`);
		respond(true, {
			deviceId: normalizedDeviceId,
			role: entry.role,
			revokedAtMs: entry.revokedAtMs ?? Date.now()
		}, void 0);
		queueMicrotask(() => {
			context.disconnectClientsForDevice?.(normalizedDeviceId, { role: entry.role });
		});
	}
};
//#endregion
//#region src/gateway/server-methods/diagnostics.ts
const diagnosticsHandlers = { "diagnostics.stability": async ({ params, respond }) => {
	try {
		respond(true, getDiagnosticStabilitySnapshot(normalizeDiagnosticStabilityQuery(params)), void 0);
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : "invalid diagnostics.stability params"));
	}
} };
//#endregion
//#region src/gateway/server-methods/record-shared.ts
function normalizeTrimmedString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
//#endregion
//#region src/gateway/server-methods/doctor.ts
const SHORT_TERM_STORE_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-recall.json");
const SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH = path.join("memory", ".dreams", "phase-signals.json");
const MANAGED_DEEP_SLEEP_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DEEP_SLEEP_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
const DEEP_SLEEP_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_short_term_promotion_dream__";
const DREAM_DIARY_FILE_NAMES = ["DREAMS.md", "dreams.md"];
const REM_HARNESS_DEFAULT_CANDIDATE_LIMIT = 25;
const REM_HARNESS_MAX_CANDIDATE_LIMIT = 100;
const REM_HARNESS_MAX_GROUNDED_FILES = 10;
const REM_HARNESS_MAX_REM_PREVIEW_LIMIT = 50;
function extractIsoDayFromPath(filePath) {
	return filePath.replaceAll("\\", "/").match(/(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/i)?.[1] ?? null;
}
function groundedMarkdownToDiaryLines(markdown) {
	return markdown.split("\n").map((line) => line.replace(/^##\s+/, "").trimEnd()).filter((line, index, lines) => line.length > 0 || index > 0 && lines[index - 1]?.length > 0);
}
async function listWorkspaceDailyFiles(memoryDir) {
	let entries = [];
	try {
		entries = await fs$1.readdir(memoryDir);
	} catch (err) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
	return entries.filter((name) => /^\d{4}-\d{2}-\d{2}(?:-[^/]+)?\.md$/i.test(name)).map((name) => path.join(memoryDir, name)).toSorted((left, right) => left.localeCompare(right));
}
function resolveDreamingConfig(cfg) {
	const resolved = resolveMemoryDreamingConfig({
		pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
		cfg
	});
	const light = resolveMemoryLightDreamingConfig({
		pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
		cfg
	});
	const deep = resolveMemoryDeepDreamingConfig({
		pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
		cfg
	});
	const rem = resolveMemoryRemDreamingConfig({
		pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
		cfg
	});
	return {
		enabled: resolved.enabled,
		...resolved.timezone ? { timezone: resolved.timezone } : {},
		verboseLogging: resolved.verboseLogging,
		storageMode: resolved.storage.mode,
		separateReports: resolved.storage.separateReports,
		shortTermEntries: [],
		signalEntries: [],
		promotedEntries: [],
		phases: {
			light: {
				enabled: light.enabled,
				cron: light.cron,
				lookbackDays: light.lookbackDays,
				limit: light.limit,
				managedCronPresent: false
			},
			deep: {
				enabled: deep.enabled,
				cron: deep.cron,
				limit: deep.limit,
				minScore: deep.minScore,
				minRecallCount: deep.minRecallCount,
				minUniqueQueries: deep.minUniqueQueries,
				recencyHalfLifeDays: deep.recencyHalfLifeDays,
				managedCronPresent: false,
				...typeof deep.maxAgeDays === "number" ? { maxAgeDays: deep.maxAgeDays } : {}
			},
			rem: {
				enabled: rem.enabled,
				cron: rem.cron,
				lookbackDays: rem.lookbackDays,
				limit: rem.limit,
				minPatternStrength: rem.minPatternStrength,
				managedCronPresent: false
			}
		}
	};
}
function normalizeMemoryPath(rawPath) {
	return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}
function normalizeMemoryPathForWorkspace(workspaceDir, rawPath) {
	const normalized = normalizeMemoryPath(rawPath);
	const workspaceNormalized = normalizeMemoryPath(workspaceDir);
	if (path.isAbsolute(rawPath) && normalized.startsWith(`${workspaceNormalized}/`)) return normalized.slice(workspaceNormalized.length + 1);
	return normalized;
}
function isShortTermMemoryPath(filePath) {
	const normalized = normalizeMemoryPath(filePath);
	if (/(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/.test(normalized)) return true;
	if (/(?:^|\/)memory\/\.dreams\/session-corpus\/(\d{4})-(\d{2})-(\d{2})\.(?:md|txt)$/.test(normalized)) return true;
	return /^(\d{4})-(\d{2})-(\d{2})\.md$/.test(normalized);
}
const DREAMING_ENTRY_LIST_LIMIT = 8;
function toNonNegativeInt(value) {
	const num = Number(value);
	if (!Number.isFinite(num)) return 0;
	return Math.max(0, Math.floor(num));
}
function parseEntryRangeFromKey(key, fallbackStartLine, fallbackEndLine) {
	const startLine = toNonNegativeInt(fallbackStartLine);
	const endLine = toNonNegativeInt(fallbackEndLine);
	if (startLine > 0 && endLine > 0) return {
		startLine,
		endLine
	};
	const match = key.match(/:(\d+):(\d+)$/);
	if (match) return {
		startLine: Math.max(1, toNonNegativeInt(match[1])),
		endLine: Math.max(1, toNonNegativeInt(match[2]))
	};
	return {
		startLine: 1,
		endLine: 1
	};
}
function compareDreamingEntryByRecency(a, b) {
	const aMs = a.lastRecalledAt ? Date.parse(a.lastRecalledAt) : Number.NEGATIVE_INFINITY;
	const bMs = b.lastRecalledAt ? Date.parse(b.lastRecalledAt) : Number.NEGATIVE_INFINITY;
	if (Number.isFinite(aMs) || Number.isFinite(bMs)) {
		if (bMs !== aMs) return bMs - aMs;
	}
	if (b.totalSignalCount !== a.totalSignalCount) return b.totalSignalCount - a.totalSignalCount;
	return a.path.localeCompare(b.path);
}
function compareDreamingEntryBySignals(a, b) {
	if (b.totalSignalCount !== a.totalSignalCount) return b.totalSignalCount - a.totalSignalCount;
	if (b.phaseHitCount !== a.phaseHitCount) return b.phaseHitCount - a.phaseHitCount;
	return compareDreamingEntryByRecency(a, b);
}
function compareDreamingEntryByPromotion(a, b) {
	const aMs = a.promotedAt ? Date.parse(a.promotedAt) : Number.NEGATIVE_INFINITY;
	const bMs = b.promotedAt ? Date.parse(b.promotedAt) : Number.NEGATIVE_INFINITY;
	if (Number.isFinite(aMs) || Number.isFinite(bMs)) {
		if (bMs !== aMs) return bMs - aMs;
	}
	return compareDreamingEntryBySignals(a, b);
}
function trimDreamingEntries(entries, compare) {
	const selected = [];
	for (const entry of entries) {
		let insertAt = selected.length;
		for (let index = 0; index < selected.length; index += 1) if (compare(entry, selected[index]) < 0) {
			insertAt = index;
			break;
		}
		if (insertAt < DREAMING_ENTRY_LIST_LIMIT) {
			selected.splice(insertAt, 0, entry);
			if (selected.length > DREAMING_ENTRY_LIST_LIMIT) selected.pop();
		} else if (selected.length < DREAMING_ENTRY_LIST_LIMIT) selected.push(entry);
	}
	return selected;
}
async function loadDreamingStoreStats(workspaceDir, nowMs, timezone) {
	const storePath = path.join(workspaceDir, SHORT_TERM_STORE_RELATIVE_PATH);
	const phaseSignalPath = path.join(workspaceDir, SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH);
	try {
		const raw = await fs$1.readFile(storePath, "utf-8");
		const entries = asOptionalRecord(asOptionalRecord(JSON.parse(raw))?.entries) ?? {};
		let shortTermCount = 0;
		let recallSignalCount = 0;
		let dailySignalCount = 0;
		let groundedSignalCount = 0;
		let totalSignalCount = 0;
		let phaseSignalCount = 0;
		let lightPhaseHitCount = 0;
		let remPhaseHitCount = 0;
		let promotedTotal = 0;
		let promotedToday = 0;
		let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
		let latestPromotedAt;
		const activeKeys = /* @__PURE__ */ new Set();
		const activeEntries = /* @__PURE__ */ new Map();
		const shortTermEntries = [];
		const promotedEntries = [];
		for (const [entryKey, value] of Object.entries(entries)) {
			const entry = asOptionalRecord(value);
			if (!entry) continue;
			const source = normalizeTrimmedString(entry.source);
			const entryPath = normalizeTrimmedString(entry.path);
			if (source !== "memory" || !entryPath || !isShortTermMemoryPath(entryPath)) continue;
			const range = parseEntryRangeFromKey(entryKey, entry.startLine, entry.endLine);
			const recallCount = toNonNegativeInt(entry.recallCount);
			const dailyCount = toNonNegativeInt(entry.dailyCount);
			const groundedCount = toNonNegativeInt(entry.groundedCount);
			const totalEntrySignalCount = recallCount + dailyCount + groundedCount;
			const normalizedEntryPath = normalizeMemoryPathForWorkspace(workspaceDir, entryPath);
			const snippet = normalizeTrimmedString(entry.snippet) ?? normalizeTrimmedString(entry.summary) ?? normalizedEntryPath;
			const lastRecalledAt = normalizeTrimmedString(entry.lastRecalledAt);
			const detail = {
				key: entryKey,
				path: normalizedEntryPath,
				startLine: range.startLine,
				endLine: Math.max(range.startLine, range.endLine),
				snippet,
				recallCount,
				dailyCount,
				groundedCount,
				totalSignalCount: totalEntrySignalCount,
				lightHits: 0,
				remHits: 0,
				phaseHitCount: 0,
				...lastRecalledAt ? { lastRecalledAt } : {}
			};
			const promotedAt = normalizeTrimmedString(entry.promotedAt);
			if (!promotedAt) {
				shortTermCount += 1;
				activeKeys.add(entryKey);
				recallSignalCount += recallCount;
				dailySignalCount += dailyCount;
				groundedSignalCount += groundedCount;
				totalSignalCount += totalEntrySignalCount;
				shortTermEntries.push(detail);
				activeEntries.set(entryKey, detail);
				continue;
			}
			promotedTotal += 1;
			promotedEntries.push({
				...detail,
				promotedAt
			});
			const promotedAtMs = Date.parse(promotedAt);
			if (Number.isFinite(promotedAtMs) && isSameMemoryDreamingDay(promotedAtMs, nowMs, timezone)) promotedToday += 1;
			if (Number.isFinite(promotedAtMs) && promotedAtMs > latestPromotedAtMs) {
				latestPromotedAtMs = promotedAtMs;
				latestPromotedAt = promotedAt;
			}
		}
		let phaseSignalError;
		try {
			const phaseRaw = await fs$1.readFile(phaseSignalPath, "utf-8");
			const phaseEntries = asOptionalRecord(asOptionalRecord(JSON.parse(phaseRaw))?.entries) ?? {};
			for (const [key, value] of Object.entries(phaseEntries)) {
				if (!activeKeys.has(key)) continue;
				const phaseEntry = asOptionalRecord(value);
				const lightHits = toNonNegativeInt(phaseEntry?.lightHits);
				const remHits = toNonNegativeInt(phaseEntry?.remHits);
				lightPhaseHitCount += lightHits;
				remPhaseHitCount += remHits;
				phaseSignalCount += lightHits + remHits;
				const detail = activeEntries.get(key);
				if (detail) {
					detail.lightHits = lightHits;
					detail.remHits = remHits;
					detail.phaseHitCount = lightHits + remHits;
				}
			}
		} catch (err) {
			if (err?.code !== "ENOENT") phaseSignalError = formatError$1(err);
		}
		return {
			shortTermCount,
			recallSignalCount,
			dailySignalCount,
			groundedSignalCount,
			totalSignalCount,
			phaseSignalCount,
			lightPhaseHitCount,
			remPhaseHitCount,
			promotedTotal,
			promotedToday,
			storePath,
			phaseSignalPath,
			shortTermEntries: trimDreamingEntries(shortTermEntries, compareDreamingEntryByRecency),
			signalEntries: trimDreamingEntries(shortTermEntries, compareDreamingEntryBySignals),
			promotedEntries: trimDreamingEntries(promotedEntries, compareDreamingEntryByPromotion),
			...latestPromotedAt ? { lastPromotedAt: latestPromotedAt } : {},
			...phaseSignalError ? { phaseSignalError } : {}
		};
	} catch (err) {
		if (err?.code === "ENOENT") return {
			shortTermCount: 0,
			recallSignalCount: 0,
			dailySignalCount: 0,
			groundedSignalCount: 0,
			totalSignalCount: 0,
			phaseSignalCount: 0,
			lightPhaseHitCount: 0,
			remPhaseHitCount: 0,
			promotedTotal: 0,
			promotedToday: 0,
			storePath,
			phaseSignalPath,
			shortTermEntries: [],
			signalEntries: [],
			promotedEntries: []
		};
		return {
			shortTermCount: 0,
			recallSignalCount: 0,
			dailySignalCount: 0,
			groundedSignalCount: 0,
			totalSignalCount: 0,
			phaseSignalCount: 0,
			lightPhaseHitCount: 0,
			remPhaseHitCount: 0,
			promotedTotal: 0,
			promotedToday: 0,
			storePath,
			phaseSignalPath,
			shortTermEntries: [],
			signalEntries: [],
			promotedEntries: [],
			storeError: formatError$1(err)
		};
	}
}
function mergeDreamingStoreStats(stats) {
	let shortTermCount = 0;
	let recallSignalCount = 0;
	let dailySignalCount = 0;
	let groundedSignalCount = 0;
	let totalSignalCount = 0;
	let phaseSignalCount = 0;
	let lightPhaseHitCount = 0;
	let remPhaseHitCount = 0;
	let promotedTotal = 0;
	let promotedToday = 0;
	let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
	let lastPromotedAt;
	const storePaths = /* @__PURE__ */ new Set();
	const phaseSignalPaths = /* @__PURE__ */ new Set();
	const storeErrors = [];
	const phaseSignalErrors = [];
	const shortTermEntries = [];
	const signalEntries = [];
	const promotedEntries = [];
	for (const stat of stats) {
		shortTermCount += stat.shortTermCount;
		recallSignalCount += stat.recallSignalCount;
		dailySignalCount += stat.dailySignalCount;
		groundedSignalCount += stat.groundedSignalCount;
		totalSignalCount += stat.totalSignalCount;
		phaseSignalCount += stat.phaseSignalCount;
		lightPhaseHitCount += stat.lightPhaseHitCount;
		remPhaseHitCount += stat.remPhaseHitCount;
		promotedTotal += stat.promotedTotal;
		promotedToday += stat.promotedToday;
		if (stat.storePath) storePaths.add(stat.storePath);
		if (stat.phaseSignalPath) phaseSignalPaths.add(stat.phaseSignalPath);
		if (stat.storeError) storeErrors.push(stat.storeError);
		if (stat.phaseSignalError) phaseSignalErrors.push(stat.phaseSignalError);
		shortTermEntries.push(...stat.shortTermEntries);
		signalEntries.push(...stat.signalEntries);
		promotedEntries.push(...stat.promotedEntries);
		const promotedAtMs = stat.lastPromotedAt ? Date.parse(stat.lastPromotedAt) : NaN;
		if (Number.isFinite(promotedAtMs) && promotedAtMs > latestPromotedAtMs) {
			latestPromotedAtMs = promotedAtMs;
			lastPromotedAt = stat.lastPromotedAt;
		}
	}
	return {
		shortTermCount,
		recallSignalCount,
		dailySignalCount,
		groundedSignalCount,
		totalSignalCount,
		phaseSignalCount,
		lightPhaseHitCount,
		remPhaseHitCount,
		promotedTotal,
		promotedToday,
		shortTermEntries: trimDreamingEntries(shortTermEntries, compareDreamingEntryByRecency),
		signalEntries: trimDreamingEntries(signalEntries, compareDreamingEntryBySignals),
		promotedEntries: trimDreamingEntries(promotedEntries, compareDreamingEntryByPromotion),
		...storePaths.size === 1 ? { storePath: [...storePaths][0] } : {},
		...phaseSignalPaths.size === 1 ? { phaseSignalPath: [...phaseSignalPaths][0] } : {},
		...lastPromotedAt ? { lastPromotedAt } : {},
		...storeErrors.length === 1 ? { storeError: storeErrors[0] } : storeErrors.length > 1 ? { storeError: `${storeErrors.length} dreaming stores had read errors.` } : {},
		...phaseSignalErrors.length === 1 ? { phaseSignalError: phaseSignalErrors[0] } : phaseSignalErrors.length > 1 ? { phaseSignalError: `${phaseSignalErrors.length} phase signal stores had read errors.` } : {}
	};
}
function isManagedDreamingJob(job, params) {
	if (normalizeTrimmedString(job.description)?.includes(params.tag)) return true;
	const name = normalizeTrimmedString(job.name);
	const payloadKind = normalizeTrimmedString(job.payload?.kind)?.toLowerCase();
	const payloadText = normalizeTrimmedString(job.payload?.text);
	return name === params.name && payloadKind === "systemevent" && payloadText === params.payloadText;
}
async function resolveManagedDreamingCronStatus(params) {
	if (!params.context.cron || typeof params.context.cron.list !== "function") return { managedCronPresent: false };
	try {
		const managed = (await params.context.cron.list({ includeDisabled: true })).filter((job) => typeof job === "object" && job !== null).filter((job) => isManagedDreamingJob(job, params.match));
		let nextRunAtMs;
		for (const job of managed) {
			if (job.enabled !== true) continue;
			const candidate = job.state?.nextRunAtMs;
			if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
			if (nextRunAtMs === void 0 || candidate < nextRunAtMs) nextRunAtMs = candidate;
		}
		return {
			managedCronPresent: managed.length > 0,
			...nextRunAtMs !== void 0 ? { nextRunAtMs } : {}
		};
	} catch {
		return { managedCronPresent: false };
	}
}
async function resolveAllManagedDreamingCronStatuses(context) {
	const sweepStatus = await resolveManagedDreamingCronStatus({
		context,
		match: {
			name: MANAGED_DEEP_SLEEP_CRON_NAME,
			tag: MANAGED_DEEP_SLEEP_CRON_TAG,
			payloadText: DEEP_SLEEP_SYSTEM_EVENT_TEXT
		}
	});
	return {
		light: sweepStatus,
		deep: sweepStatus,
		rem: sweepStatus
	};
}
async function readDreamDiary(workspaceDir) {
	for (const name of DREAM_DIARY_FILE_NAMES) {
		const filePath = path.join(workspaceDir, name);
		let stat;
		try {
			stat = await fs$1.lstat(filePath);
		} catch (err) {
			if (err?.code === "ENOENT") continue;
			return {
				found: false,
				path: name
			};
		}
		if (stat.isSymbolicLink() || !stat.isFile()) continue;
		try {
			return {
				found: true,
				path: name,
				content: await fs$1.readFile(filePath, "utf-8"),
				updatedAtMs: Math.floor(stat.mtimeMs)
			};
		} catch {
			return {
				found: false,
				path: name
			};
		}
	}
	return {
		found: false,
		path: DREAM_DIARY_FILE_NAMES[0]
	};
}
function shouldProbeMemoryEmbeddings(params) {
	if (!params || typeof params !== "object") return false;
	const record = params;
	return record.probe === true || record.deep === true;
}
const SKIPPED_MEMORY_EMBEDDING_PROBE = {
	ok: false,
	checked: false,
	error: "memory embedding readiness not checked; run `openclaw memory status --deep` to probe"
};
const doctorHandlers = {
	"doctor.memory.status": async ({ respond, context, params }) => {
		const cfg = context.getRuntimeConfig();
		const agentId = resolveDefaultAgentId(cfg);
		const { manager, error } = await getActiveMemorySearchManager({
			cfg,
			agentId,
			purpose: "status"
		});
		if (!manager) {
			respond(true, {
				agentId,
				embedding: {
					ok: false,
					error: error ?? "memory search unavailable"
				}
			}, void 0);
			return;
		}
		try {
			const status = manager.status();
			let embedding = shouldProbeMemoryEmbeddings(params) ? await manager.probeEmbeddingAvailability() : manager.getCachedEmbeddingAvailability?.() ?? SKIPPED_MEMORY_EMBEDDING_PROBE;
			if (!embedding.ok && !embedding.error) embedding = {
				ok: false,
				error: "memory embeddings unavailable"
			};
			const nowMs = Date.now();
			const dreamingConfig = resolveDreamingConfig(cfg);
			const workspaceDir = normalizeTrimmedString(status.workspaceDir);
			const configuredWorkspaces = resolveMemoryDreamingWorkspaces(cfg, {
				primaryWorkspaceDir: workspaceDir,
				primaryAgentId: resolveDefaultAgentId(cfg)
			}).map((entry) => entry.workspaceDir);
			const allWorkspaces = configuredWorkspaces.length > 0 ? configuredWorkspaces : workspaceDir ? [workspaceDir] : [];
			const storeStats = allWorkspaces.length > 0 ? mergeDreamingStoreStats(await Promise.all(allWorkspaces.map((entry) => loadDreamingStoreStats(entry, nowMs, dreamingConfig.timezone)))) : {
				shortTermCount: 0,
				recallSignalCount: 0,
				dailySignalCount: 0,
				groundedSignalCount: 0,
				totalSignalCount: 0,
				phaseSignalCount: 0,
				lightPhaseHitCount: 0,
				remPhaseHitCount: 0,
				promotedTotal: 0,
				promotedToday: 0
			};
			const cronStatuses = await resolveAllManagedDreamingCronStatuses(context);
			respond(true, {
				agentId,
				provider: status.provider,
				embedding,
				dreaming: {
					...dreamingConfig,
					...storeStats,
					phases: {
						light: {
							...dreamingConfig.phases.light,
							...cronStatuses.light
						},
						deep: {
							...dreamingConfig.phases.deep,
							...cronStatuses.deep
						},
						rem: {
							...dreamingConfig.phases.rem,
							...cronStatuses.rem
						}
					}
				}
			}, void 0);
		} catch (err) {
			respond(true, {
				agentId,
				embedding: {
					ok: false,
					error: `gateway memory probe failed: ${formatError$1(err)}`
				}
			}, void 0);
		} finally {
			await manager.close?.().catch(() => {});
		}
	},
	"doctor.memory.dreamDiary": async ({ respond, context }) => {
		const cfg = context.getRuntimeConfig();
		const agentId = resolveDefaultAgentId(cfg);
		respond(true, {
			agentId,
			...await readDreamDiary(resolveAgentWorkspaceDir(cfg, agentId))
		}, void 0);
	},
	"doctor.memory.backfillDreamDiary": async ({ respond, context }) => {
		const cfg = context.getRuntimeConfig();
		const agentId = resolveDefaultAgentId(cfg);
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		const sourceFiles = await listWorkspaceDailyFiles(path.join(workspaceDir, "memory"));
		if (sourceFiles.length === 0) {
			const dreamDiary = await readDreamDiary(workspaceDir);
			respond(true, {
				agentId,
				path: dreamDiary.path,
				action: "backfill",
				found: dreamDiary.found,
				scannedFiles: 0,
				written: 0,
				replaced: 0
			}, void 0);
			return;
		}
		const grounded = await previewGroundedRemMarkdown({
			workspaceDir,
			inputPaths: sourceFiles
		});
		const remConfig = resolveMemoryRemDreamingConfig({
			pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
			cfg
		});
		const written = await writeBackfillDiaryEntries({
			workspaceDir,
			entries: grounded.files.map((file) => {
				const isoDay = extractIsoDayFromPath(file.path);
				if (!isoDay) return null;
				return {
					isoDay,
					sourcePath: file.path,
					bodyLines: groundedMarkdownToDiaryLines(file.renderedMarkdown)
				};
			}).filter((entry) => entry !== null),
			timezone: remConfig.timezone
		});
		const dreamDiary = await readDreamDiary(workspaceDir);
		respond(true, {
			agentId,
			path: dreamDiary.path,
			action: "backfill",
			found: dreamDiary.found,
			scannedFiles: grounded.scannedFiles,
			written: written.written,
			replaced: written.replaced
		}, void 0);
	},
	"doctor.memory.resetDreamDiary": async ({ respond, context }) => {
		const cfg = context.getRuntimeConfig();
		const agentId = resolveDefaultAgentId(cfg);
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		const removed = await removeBackfillDiaryEntries({ workspaceDir });
		const dreamDiary = await readDreamDiary(workspaceDir);
		respond(true, {
			agentId,
			path: dreamDiary.path,
			action: "reset",
			found: dreamDiary.found,
			removedEntries: removed.removed
		}, void 0);
	},
	"doctor.memory.resetGroundedShortTerm": async ({ respond, context }) => {
		const cfg = context.getRuntimeConfig();
		const agentId = resolveDefaultAgentId(cfg);
		respond(true, {
			agentId,
			action: "resetGroundedShortTerm",
			removedShortTermEntries: (await removeGroundedShortTermCandidates({ workspaceDir: resolveAgentWorkspaceDir(cfg, agentId) })).removed
		}, void 0);
	},
	"doctor.memory.repairDreamingArtifacts": async ({ respond, context }) => {
		const cfg = context.getRuntimeConfig();
		const agentId = resolveDefaultAgentId(cfg);
		const repair = await repairDreamingArtifacts({ workspaceDir: resolveAgentWorkspaceDir(cfg, agentId) });
		respond(true, {
			agentId,
			action: "repairDreamingArtifacts",
			changed: repair.changed,
			archiveDir: repair.archiveDir,
			archivedDreamsDiary: repair.archivedDreamsDiary,
			archivedSessionCorpus: repair.archivedSessionCorpus,
			archivedSessionIngestion: repair.archivedSessionIngestion,
			warnings: repair.warnings
		}, void 0);
	},
	"doctor.memory.dedupeDreamDiary": async ({ respond, context }) => {
		const cfg = context.getRuntimeConfig();
		const agentId = resolveDefaultAgentId(cfg);
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		const dedupe = await dedupeDreamDiaryEntries({ workspaceDir });
		const dreamDiary = await readDreamDiary(workspaceDir);
		respond(true, {
			agentId,
			action: "dedupeDreamDiary",
			path: dreamDiary.path,
			found: dreamDiary.found,
			removedEntries: dedupe.removed,
			dedupedEntries: dedupe.removed,
			keptEntries: dedupe.kept
		}, void 0);
	},
	"doctor.memory.remHarness": async ({ params, respond, context }) => {
		const cfg = context.getRuntimeConfig();
		const agentId = resolveDefaultAgentId(cfg);
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		const req = asOptionalRecord(params);
		const grounded = Boolean(req?.grounded);
		const includePromoted = Boolean(req?.includePromoted);
		const requestedLimit = typeof req?.limit === "number" && Number.isFinite(req.limit) ? Math.floor(req.limit) : REM_HARNESS_DEFAULT_CANDIDATE_LIMIT;
		const candidateLimit = Math.max(1, Math.min(REM_HARNESS_MAX_CANDIDATE_LIMIT, requestedLimit));
		try {
			const preview = await previewRemHarness({
				workspaceDir,
				cfg,
				pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
				grounded,
				includePromoted,
				candidateLimit,
				groundedFileLimit: REM_HARNESS_MAX_GROUNDED_FILES,
				remPreviewLimit: REM_HARNESS_MAX_REM_PREVIEW_LIMIT
			});
			const groundedPayload = preview.grounded ? {
				scannedFiles: preview.grounded.scannedFiles,
				files: preview.grounded.files.map((file) => ({
					path: file.path,
					renderedMarkdown: file.renderedMarkdown
				}))
			} : grounded ? {
				scannedFiles: 0,
				files: []
			} : null;
			respond(true, {
				ok: true,
				agentId,
				workspaceDir,
				remConfig: {
					enabled: preview.remConfig.enabled,
					lookbackDays: preview.remConfig.lookbackDays,
					limit: preview.remConfig.limit,
					minPatternStrength: preview.remConfig.minPatternStrength
				},
				deepConfig: {
					minScore: preview.deepConfig.minScore,
					minRecallCount: preview.deepConfig.minRecallCount,
					minUniqueQueries: preview.deepConfig.minUniqueQueries,
					recencyHalfLifeDays: preview.deepConfig.recencyHalfLifeDays,
					maxAgeDays: typeof preview.deepConfig.maxAgeDays === "number" ? preview.deepConfig.maxAgeDays : null
				},
				rem: {
					skipped: preview.remSkipped,
					sourceEntryCount: preview.rem.sourceEntryCount,
					reflections: [...preview.rem.reflections],
					candidateTruths: preview.rem.candidateTruths.map((truth) => ({
						snippet: truth.snippet,
						confidence: truth.confidence
					})),
					bodyLines: [...preview.rem.bodyLines]
				},
				grounded: groundedPayload,
				deep: {
					candidateLimit,
					truncated: preview.deep.truncated,
					candidates: preview.deep.candidates.map((candidate) => {
						const promoted = typeof candidate.promotedAt === "string" && candidate.promotedAt.length > 0;
						const payload = {
							key: candidate.key,
							path: candidate.path,
							startLine: candidate.startLine,
							endLine: candidate.endLine,
							snippet: candidate.snippet,
							recallCount: candidate.recallCount,
							uniqueQueries: candidate.uniqueQueries,
							avgScore: candidate.avgScore,
							maxScore: candidate.maxScore,
							ageDays: candidate.ageDays,
							firstRecalledAt: candidate.firstRecalledAt,
							lastRecalledAt: candidate.lastRecalledAt,
							promoted
						};
						if (promoted) payload.promotedAt = candidate.promotedAt;
						return payload;
					})
				}
			}, void 0);
		} catch (err) {
			respond(true, {
				ok: false,
				agentId,
				workspaceDir,
				error: `gateway rem-harness probe failed: ${formatError$1(err)}`
			}, void 0);
		}
	}
};
//#endregion
//#region src/gateway/node-catalog.ts
function uniqueSortedStrings$1(...items) {
	const values = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (!Array.isArray(item)) continue;
		for (const value of item) {
			if (typeof value !== "string") continue;
			const trimmed = value.trim();
			if (trimmed) values.add(trimmed);
		}
	}
	return [...values].toSorted((left, right) => left.localeCompare(right));
}
function buildDevicePairingSource(entry) {
	return {
		nodeId: entry.deviceId,
		displayName: entry.displayName,
		platform: entry.platform,
		clientId: entry.clientId,
		clientMode: entry.clientMode,
		remoteIp: entry.remoteIp,
		approvedAtMs: entry.approvedAtMs,
		lastSeenAtMs: entry.lastSeenAtMs,
		lastSeenReason: entry.lastSeenReason
	};
}
function buildApprovedNodeSource(entry) {
	return {
		nodeId: entry.nodeId,
		displayName: entry.displayName,
		platform: entry.platform,
		version: entry.version,
		coreVersion: entry.coreVersion,
		uiVersion: entry.uiVersion,
		remoteIp: entry.remoteIp,
		deviceFamily: entry.deviceFamily,
		modelIdentifier: entry.modelIdentifier,
		caps: entry.caps ?? [],
		commands: entry.commands ?? [],
		permissions: entry.permissions,
		approvedAtMs: entry.approvedAtMs,
		lastConnectedAtMs: entry.lastConnectedAtMs,
		lastSeenAtMs: entry.lastSeenAtMs,
		lastSeenReason: entry.lastSeenReason
	};
}
function resolveEffectiveLastSeen(params) {
	const candidates = [
		params.live?.connectedAtMs ? {
			atMs: params.live.connectedAtMs,
			reason: "connect"
		} : void 0,
		params.nodePairing?.lastSeenAtMs ? {
			atMs: params.nodePairing.lastSeenAtMs,
			reason: params.nodePairing.lastSeenReason
		} : void 0,
		params.nodePairing?.lastConnectedAtMs ? {
			atMs: params.nodePairing.lastConnectedAtMs,
			reason: "connect"
		} : void 0,
		params.devicePairing?.lastSeenAtMs ? {
			atMs: params.devicePairing.lastSeenAtMs,
			reason: params.devicePairing.lastSeenReason
		} : void 0
	].filter((entry) => entry !== void 0);
	let newest;
	for (const candidate of candidates) if (!newest || candidate.atMs > newest.atMs) newest = candidate;
	if (!newest) return {};
	return {
		lastSeenAtMs: newest.atMs,
		lastSeenReason: newest.reason
	};
}
function buildEffectiveKnownNode(entry) {
	const { nodeId, devicePairing, nodePairing, live } = entry;
	const lastSeen = resolveEffectiveLastSeen({
		live,
		devicePairing,
		nodePairing
	});
	return {
		nodeId,
		displayName: live?.displayName ?? nodePairing?.displayName ?? devicePairing?.displayName,
		platform: live?.platform ?? nodePairing?.platform ?? devicePairing?.platform,
		version: live?.version ?? nodePairing?.version,
		coreVersion: live?.coreVersion ?? nodePairing?.coreVersion,
		uiVersion: live?.uiVersion ?? nodePairing?.uiVersion,
		clientId: live?.clientId ?? devicePairing?.clientId,
		clientMode: live?.clientMode ?? devicePairing?.clientMode,
		deviceFamily: live?.deviceFamily ?? nodePairing?.deviceFamily,
		modelIdentifier: live?.modelIdentifier ?? nodePairing?.modelIdentifier,
		remoteIp: live?.remoteIp ?? nodePairing?.remoteIp ?? devicePairing?.remoteIp,
		caps: live ? uniqueSortedStrings$1(live.caps) : uniqueSortedStrings$1(nodePairing?.caps),
		commands: live ? uniqueSortedStrings$1(live.commands) : uniqueSortedStrings$1(nodePairing?.commands),
		pathEnv: live?.pathEnv,
		permissions: live?.permissions ?? nodePairing?.permissions,
		connectedAtMs: live?.connectedAtMs,
		lastSeenAtMs: lastSeen.lastSeenAtMs,
		lastSeenReason: lastSeen.lastSeenReason,
		approvedAtMs: nodePairing?.approvedAtMs ?? devicePairing?.approvedAtMs,
		paired: Boolean(devicePairing ?? nodePairing),
		connected: Boolean(live)
	};
}
function compareKnownNodes(left, right) {
	if (left.connected !== right.connected) return left.connected ? -1 : 1;
	const leftName = normalizeLowercaseStringOrEmpty(left.displayName ?? left.nodeId);
	const rightName = normalizeLowercaseStringOrEmpty(right.displayName ?? right.nodeId);
	if (leftName < rightName) return -1;
	if (leftName > rightName) return 1;
	return left.nodeId.localeCompare(right.nodeId);
}
function createKnownNodeCatalog(params) {
	const devicePairingById = new Map(params.pairedDevices.filter((entry) => hasEffectivePairedDeviceRole(entry, "node")).map((entry) => [entry.deviceId, buildDevicePairingSource(entry)]));
	const nodePairingById = new Map((params.pairedNodes ?? []).map((entry) => [entry.nodeId, buildApprovedNodeSource(entry)]));
	const liveById = new Map(params.connectedNodes.map((entry) => [entry.nodeId, entry]));
	const nodeIds = new Set([
		...devicePairingById.keys(),
		...nodePairingById.keys(),
		...liveById.keys()
	]);
	const entriesById = /* @__PURE__ */ new Map();
	for (const nodeId of nodeIds) {
		const devicePairing = devicePairingById.get(nodeId);
		const nodePairing = nodePairingById.get(nodeId);
		const live = liveById.get(nodeId);
		entriesById.set(nodeId, {
			nodeId,
			devicePairing,
			nodePairing,
			live,
			effective: buildEffectiveKnownNode({
				nodeId,
				devicePairing,
				nodePairing,
				live
			})
		});
	}
	return { entriesById };
}
function listKnownNodes(catalog) {
	return [...catalog.entriesById.values()].map((entry) => entry.effective).toSorted(compareKnownNodes);
}
function getKnownNodeEntry(catalog, nodeId) {
	return catalog.entriesById.get(nodeId) ?? null;
}
function getKnownNode(catalog, nodeId) {
	return getKnownNodeEntry(catalog, nodeId)?.effective ?? null;
}
//#endregion
//#region src/gateway/server-methods/environments.ts
const GATEWAY_ENVIRONMENT = {
	id: "gateway",
	type: "local",
	label: "Gateway local",
	status: "available",
	capabilities: [
		"agent.run",
		"sessions",
		"tools",
		"workspace"
	]
};
function uniqueSortedStrings(...items) {
	const values = /* @__PURE__ */ new Set();
	for (const item of items) for (const value of item ?? []) {
		const trimmed = value.trim();
		if (trimmed) values.add(trimmed);
	}
	return [...values].toSorted((left, right) => left.localeCompare(right));
}
function summarizeNodeEnvironment(node) {
	const capabilities = uniqueSortedStrings(node.caps, node.commands);
	return {
		id: `node:${node.nodeId}`,
		type: "node",
		label: node.displayName ?? node.nodeId,
		status: node.connected ? "available" : "unavailable",
		...capabilities.length > 0 ? { capabilities } : {}
	};
}
function listEnvironmentSummaries(nodes) {
	return [GATEWAY_ENVIRONMENT, ...nodes.map(summarizeNodeEnvironment)];
}
async function listEnvironments(context) {
	const [devicePairing, nodePairing] = await Promise.all([listDevicePairing(), listNodePairing()]);
	return listEnvironmentSummaries(listKnownNodes(createKnownNodeCatalog({
		pairedDevices: devicePairing.paired,
		pairedNodes: nodePairing.paired,
		connectedNodes: context.nodeRegistry.listConnected()
	})));
}
const environmentsHandlers = {
	"environments.list": async ({ params, respond, context }) => {
		if (!validateEnvironmentsListParams(params)) {
			respondInvalidParams({
				respond,
				method: "environments.list",
				validator: validateEnvironmentsListParams
			});
			return;
		}
		await respondUnavailableOnThrow(respond, async () => {
			respond(true, { environments: await listEnvironments(context) }, void 0);
		});
	},
	"environments.status": async ({ params, respond, context }) => {
		if (!validateEnvironmentsStatusParams(params)) {
			respondInvalidParams({
				respond,
				method: "environments.status",
				validator: validateEnvironmentsStatusParams
			});
			return;
		}
		await respondUnavailableOnThrow(respond, async () => {
			const environment = (await listEnvironments(context)).find((entry) => entry.id === params.environmentId);
			if (!environment) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"));
				return;
			}
			respond(true, environment, void 0);
		});
	}
};
//#endregion
//#region src/gateway/server-methods/exec-approvals.ts
function requireApprovalsBaseHash(params, snapshot, respond) {
	if (!snapshot.exists) return true;
	if (!snapshot.hash) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "exec approvals base hash unavailable; re-run exec.approvals.get and retry"));
		return false;
	}
	const baseHash = resolveBaseHashParam(params);
	if (!baseHash) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "exec approvals base hash required; re-run exec.approvals.get and retry"));
		return false;
	}
	if (baseHash !== snapshot.hash) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "exec approvals changed since last load; re-run exec.approvals.get and retry"));
		return false;
	}
	return true;
}
function redactExecApprovals(file) {
	const socketPath = file.socket?.path?.trim();
	return {
		...file,
		socket: socketPath ? { path: socketPath } : void 0
	};
}
function toExecApprovalsPayload(snapshot) {
	return {
		path: snapshot.path,
		exists: snapshot.exists,
		hash: snapshot.hash,
		file: redactExecApprovals(snapshot.file)
	};
}
function resolveNodeIdOrRespond(nodeId, respond) {
	const id = nodeId.trim();
	if (!id) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
		return null;
	}
	return id;
}
const execApprovalsHandlers = {
	"exec.approvals.get": ({ params, respond }) => {
		if (!assertValidParams(params, validateExecApprovalsGetParams, "exec.approvals.get", respond)) return;
		ensureExecApprovals();
		respond(true, toExecApprovalsPayload(readExecApprovalsSnapshot()), void 0);
	},
	"exec.approvals.set": ({ params, respond }) => {
		if (!assertValidParams(params, validateExecApprovalsSetParams, "exec.approvals.set", respond)) return;
		ensureExecApprovals();
		const snapshot = readExecApprovalsSnapshot();
		if (!requireApprovalsBaseHash(params, snapshot, respond)) return;
		const incoming = params.file;
		if (!incoming || typeof incoming !== "object") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "exec approvals file is required"));
			return;
		}
		saveExecApprovals(mergeExecApprovalsSocketDefaults({
			normalized: normalizeExecApprovals(incoming),
			current: snapshot.file
		}));
		respond(true, toExecApprovalsPayload(readExecApprovalsSnapshot()), void 0);
	},
	"exec.approvals.node.get": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateExecApprovalsNodeGetParams, "exec.approvals.node.get", respond)) return;
		const { nodeId } = params;
		const id = resolveNodeIdOrRespond(nodeId, respond);
		if (!id) return;
		await respondUnavailableOnThrow(respond, async () => {
			const res = await context.nodeRegistry.invoke({
				nodeId: id,
				command: "system.execApprovals.get",
				params: {}
			});
			if (!respondUnavailableOnNodeInvokeError(respond, res)) return;
			respond(true, res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload, void 0);
		});
	},
	"exec.approvals.node.set": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateExecApprovalsNodeSetParams, "exec.approvals.node.set", respond)) return;
		const { nodeId, file, baseHash } = params;
		const id = resolveNodeIdOrRespond(nodeId, respond);
		if (!id) return;
		await respondUnavailableOnThrow(respond, async () => {
			const res = await context.nodeRegistry.invoke({
				nodeId: id,
				command: "system.execApprovals.set",
				params: {
					file,
					baseHash
				}
			});
			if (!respondUnavailableOnNodeInvokeError(respond, res)) return;
			respond(true, safeParseJson(res.payloadJSON ?? null), void 0);
		});
	}
};
//#endregion
//#region src/gateway/server-methods/health.ts
const ADMIN_SCOPE = "operator.admin";
function cachedAccountForRuntimeSnapshot(params) {
	const accountId = params.accountId;
	if (accountId && params.cachedChannel?.accounts?.[accountId]) return params.cachedChannel.accounts[accountId];
}
function cachedLifecycleDiffersFromRuntime(params) {
	for (const key of ["running", "connected"]) {
		const runtimeValue = params.runtimeSnapshot[key];
		if (typeof runtimeValue !== "boolean") continue;
		if (params.cachedAccount?.[key] !== runtimeValue) return true;
	}
	return false;
}
function cachedHealthDiffersFromRuntime(cached, runtime) {
	for (const [channelId, runtimeSnapshot] of Object.entries(runtime.channels)) {
		if (!runtimeSnapshot) continue;
		const cachedChannel = cached.channels[channelId];
		if (cachedLifecycleDiffersFromRuntime({
			cachedAccount: cachedChannel,
			runtimeSnapshot
		})) return true;
	}
	for (const [channelId, accounts] of Object.entries(runtime.channelAccounts)) {
		if (!accounts) continue;
		const cachedChannel = cached.channels[channelId];
		for (const [accountId, runtimeSnapshot] of Object.entries(accounts)) {
			if (!runtimeSnapshot) continue;
			if (cachedLifecycleDiffersFromRuntime({
				cachedAccount: cachedAccountForRuntimeSnapshot({
					cachedChannel,
					accountId
				}),
				runtimeSnapshot
			})) return true;
		}
	}
	return false;
}
function mergeCachedHealthRuntimeState(params) {
	return {
		...params.cached,
		...params.eventLoop ? { eventLoop: params.eventLoop } : {},
		modelPricing: getGatewayModelPricingHealth({ enabled: params.cached.modelPricing?.state !== "disabled" })
	};
}
const healthHandlers = {
	health: async ({ respond, context, params, client }) => {
		const { getHealthCache, refreshHealthSnapshot, logHealth } = context;
		const wantsProbe = params?.probe === true;
		const includeSensitive = (Array.isArray(client?.connect?.scopes) ? client.connect.scopes : []).includes(ADMIN_SCOPE);
		const now = Date.now();
		const cached = getHealthCache();
		let cachedDiffersFromRuntime = false;
		if (!wantsProbe && cached) try {
			cachedDiffersFromRuntime = cachedHealthDiffersFromRuntime(cached, context.getRuntimeSnapshot());
		} catch {
			cachedDiffersFromRuntime = false;
		}
		if (!wantsProbe && cached && !cachedDiffersFromRuntime && now - cached.ts < 6e4) {
			respond(true, mergeCachedHealthRuntimeState({
				cached,
				eventLoop: context.getEventLoopHealth?.()
			}), void 0, { cached: true });
			refreshHealthSnapshot({
				probe: false,
				includeSensitive
			}).catch((err) => logHealth.error(`background health refresh failed: ${formatError$1(err)}`));
			return;
		}
		try {
			respond(true, await refreshHealthSnapshot({
				probe: wantsProbe,
				includeSensitive
			}), void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	status: async ({ respond, client, params, context }) => {
		const status = await getStatusSummary({
			includeSensitive: (Array.isArray(client?.connect?.scopes) ? client.connect.scopes : []).includes(ADMIN_SCOPE),
			includeChannelSummary: params.includeChannelSummary !== false
		});
		if (context.getEventLoopHealth) status.eventLoop = context.getEventLoopHealth();
		respond(true, status, void 0);
	}
};
//#endregion
//#region src/gateway/server-methods/logs.ts
const logsHandlers = { "logs.tail": async ({ params, respond }) => {
	if (!validateLogsTailParams(params)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid logs.tail params: ${formatValidationErrors(validateLogsTailParams.errors)}`));
		return;
	}
	const p = params;
	try {
		respond(true, await readConfiguredLogTail({
			cursor: p.cursor,
			limit: p.limit,
			maxBytes: p.maxBytes
		}), void 0);
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `log read failed: ${String(err)}`));
	}
} };
//#endregion
//#region src/gateway/server-methods/models-auth-status.ts
const log$1 = createSubsystemLogger("models-auth-status");
const CACHE_TTL_MS = 6e4;
let cached = null;
/**
* Invalidate the in-memory cache. Reserved for future gateway-side auth
* mutation handlers (login, logout, token rotation) so the next read returns
* fresh data. Today those mutations happen via the CLI and the 60s TTL plus
* `{refresh: true}` param cover the stale-data window.
*/
function invalidateModelAuthStatusCache() {
	cached = null;
	clearCurrentProviderAuthState();
}
function readProviderParam(params) {
	const raw = params.provider;
	if (typeof raw !== "string") return null;
	return normalizeProviderId(raw) || null;
}
function createAuthLogoutAbortOps(context) {
	return {
		chatAbortControllers: context.chatAbortControllers,
		chatRunBuffers: context.chatRunBuffers,
		chatDeltaSentAt: context.chatDeltaSentAt,
		chatDeltaLastBroadcastLen: context.chatDeltaLastBroadcastLen,
		chatDeltaLastBroadcastText: context.chatDeltaLastBroadcastText,
		agentDeltaSentAt: context.agentDeltaSentAt,
		bufferedAgentEvents: context.bufferedAgentEvents,
		chatAbortedRuns: context.chatAbortedRuns,
		removeChatRun: context.removeChatRun,
		agentRunSeq: context.agentRunSeq,
		broadcast: context.broadcast,
		nodeSendToSession: context.nodeSendToSession
	};
}
async function removeProviderAuthProfilesAcrossOwnerStores(params) {
	const ownerAgentDirs = new Set([params.agentDir]);
	for (const profileId of params.profileIds) ownerAgentDirs.add(resolvePersistedAuthProfileOwnerAgentDir({
		agentDir: params.agentDir,
		profileId
	}));
	for (const ownerAgentDir of ownerAgentDirs) if (!await removeProviderAuthProfilesWithLock({
		provider: params.provider,
		agentDir: ownerAgentDir
	})) return false;
	return true;
}
function buildExpiry(remainingMs, expiresAt) {
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || typeof remainingMs !== "number") return;
	return {
		at: expiresAt,
		remainingMs,
		label: formatRemainingShort(remainingMs)
	};
}
function providerDisplayName(provider) {
	const usageId = resolveUsageProviderId(provider);
	if (usageId && PROVIDER_LABELS[usageId]) return PROVIDER_LABELS[usageId];
	return provider;
}
/**
* Aggregate provider status from OAuth profiles only. `buildAuthHealthSummary`
* rolls up across both OAuth and token profiles, which mis-reports providers
* where a healthy OAuth sits alongside an expired/missing bearer token.
* For the dashboard's OAuth-health signal, token profiles are a separate
* concern — we want "is OAuth healthy?", not "is every credential healthy?"
* It also consumes the provider's effective profile subset when auth order
* excludes stale inventory from the runtime credential path.
*
* `expectsOAuth` surfaces the configured-OAuth-but-no-oauth-profile case as
* `missing` instead of silently falling back to the provider's rollup (which
* would report `static` if only api_key credentials exist). Without this,
* switching a provider from api_key to oauth in config but forgetting to
* login hides behind the residual api_key profile until runtime fails.
*
* Exported for direct unit testing of the rollup rules.
*/
function aggregateOAuthStatus(prov, now = Date.now(), expectsOAuth = false) {
	const oauth = (prov.effectiveProfiles ?? prov.profiles).filter((p) => p.type === "oauth");
	if (oauth.length === 0) {
		if (expectsOAuth) return { status: "missing" };
		return {
			status: prov.status,
			expiresAt: prov.expiresAt,
			remainingMs: prov.remainingMs
		};
	}
	const statuses = new Set(oauth.map((p) => p.status));
	let status;
	if (statuses.has("expired") || statuses.has("missing")) status = "expired";
	else if (statuses.has("expiring")) status = "expiring";
	else if (statuses.has("ok")) status = "ok";
	else if (statuses.has("static")) status = "static";
	else {
		Array.from(statuses)[0];
		status = "static";
	}
	const expirable = oauth.map((p) => p.expiresAt).filter((v) => typeof v === "number" && Number.isFinite(v));
	const expiresAt = expirable.length > 0 ? Math.min(...expirable) : void 0;
	const remainingMs = expiresAt !== void 0 ? expiresAt - now : void 0;
	return {
		status,
		expiresAt,
		remainingMs
	};
}
function mapProvider(prov, usageByProvider, expectsOAuthSet) {
	const usageKey = resolveUsageProviderId(prov.provider);
	const usage = usageKey ? usageByProvider.get(usageKey) : void 0;
	const rollup = aggregateOAuthStatus(prov, Date.now(), expectsOAuthSet.has(prov.provider));
	return {
		provider: prov.provider,
		displayName: providerDisplayName(prov.provider),
		status: rollup.status,
		expiry: buildExpiry(rollup.remainingMs, rollup.expiresAt),
		profiles: prov.profiles.map((prof) => ({
			profileId: prof.profileId,
			type: prof.type,
			status: prof.status,
			expiry: buildExpiry(prof.remainingMs, prof.expiresAt)
		})),
		usage: usage ? {
			windows: usage.windows,
			plan: usage.plan
		} : void 0
	};
}
/**
* Collect provider IDs with refreshable credentials (OAuth or bearer token)
* so a configured-but-not-logged-in provider surfaces as `missing` rather
* than being silently absent. API-key and AWS-SDK providers are excluded —
* their credentials don't expire on a schedule this endpoint can meaningfully
* monitor, and surfacing them here would flash a red alert on a healthy
* API-key setup.
*
* Providers with `models.providers.<id>.apiKey` set (commonly via a
* SecretRef env binding) are excluded from the "missing" synthesis even
* when their `auth` mode is `oauth` or `token` — an env-backed credential
* is already present, so flagging the dashboard as missing would cry wolf
* for a working auth path. They can still show up with real status if the
* profile store has an entry for them.
*/
function resolveConfiguredProviders(cfg) {
	const out = /* @__PURE__ */ new Set();
	const expectsOAuth = /* @__PURE__ */ new Set();
	const envBacked = /* @__PURE__ */ new Set();
	for (const [id, provider] of Object.entries(cfg.models?.providers ?? {})) {
		const apiKey = provider?.apiKey;
		if (!id || apiKey === void 0 || apiKey === null) continue;
		let resolvable = false;
		if (typeof apiKey === "string" && apiKey.length > 0) resolvable = true;
		else if (isSecretRef(apiKey)) if (apiKey.source === "env") {
			const envValue = process.env[apiKey.id];
			resolvable = typeof envValue === "string" && envValue.length > 0;
		} else resolvable = true;
		if (resolvable) envBacked.add(normalizeProviderId(id));
	}
	for (const [id, provider] of Object.entries(cfg.models?.providers ?? {})) {
		if (!id) continue;
		const mode = provider?.auth;
		if (mode !== "oauth" && mode !== "token") continue;
		if (envBacked.has(normalizeProviderId(id))) continue;
		out.add(id);
		if (mode === "oauth") expectsOAuth.add(normalizeProviderId(id));
	}
	for (const profile of Object.values(cfg.auth?.profiles ?? {})) {
		const provider = profile?.provider;
		const mode = profile?.mode;
		if (typeof provider !== "string" || provider.length === 0 || mode !== "oauth" && mode !== "token") continue;
		if (envBacked.has(normalizeProviderId(provider))) continue;
		out.add(provider);
		if (mode === "oauth") expectsOAuth.add(normalizeProviderId(provider));
	}
	return {
		providers: Array.from(out),
		expectsOAuth
	};
}
const modelsAuthStatusHandlers = {
	"models.authLogout": async ({ params, respond, context }) => {
		const provider = readProviderParam(params);
		if (!provider) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "provider is required"));
			return;
		}
		try {
			const cfg = context.getRuntimeConfig();
			const agentDir = resolveDefaultAgentDir(cfg);
			const authProvider = resolveProviderIdForAuth(provider, { config: cfg });
			const removedProfiles = listProfilesForProvider(ensureAuthProfileStoreWithoutExternalProfiles(agentDir), provider);
			if (!await removeProviderAuthProfilesAcrossOwnerStores({
				provider,
				agentDir,
				profileIds: removedProfiles
			})) {
				respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `failed to remove saved auth profiles for provider ${provider}`));
				return;
			}
			await refreshActiveSecretsRuntimeSnapshot();
			invalidateModelAuthStatusCache();
			clearCurrentProviderAuthState();
			warmCurrentProviderAuthState(context.getRuntimeConfig()).catch((err) => {
				log$1.warn(`provider auth state rewarm after logout failed: ${formatForLog(err)}`);
			});
			const { runIds: abortedRunIds } = abortChatRunsForProvider(createAuthLogoutAbortOps(context), {
				providerId: authProvider,
				stopReason: "auth-revoked"
			});
			respond(true, {
				provider,
				removedProfiles,
				abortedRunIds
			}, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"models.authStatus": async ({ params, respond, context }) => {
		const now = Date.now();
		if (!Boolean(params?.refresh) && cached && now - cached.ts < CACHE_TTL_MS) {
			respond(true, cached.result, void 0, { cached: true });
			return;
		}
		try {
			const cfg = context.getRuntimeConfig();
			const agentDir = resolveDefaultAgentDir(cfg);
			const store = ensureAuthProfileStore(agentDir, { externalCli: externalCliDiscoveryForConfigStatus({ cfg }) });
			const configured = resolveConfiguredProviders(cfg);
			const authHealth = buildAuthHealthSummary({
				store,
				cfg,
				providers: configured.providers.length > 0 ? configured.providers : void 0
			});
			const usageProviderIds = [...new Set(authHealth.profiles.filter((p) => p.type === "oauth" || p.type === "token").map((p) => resolveUsageProviderId(p.provider)).filter((id) => Boolean(id)))];
			const usageByProvider = /* @__PURE__ */ new Map();
			if (usageProviderIds.length > 0) try {
				const usage = await loadProviderUsageSummary({
					providers: usageProviderIds,
					agentDir,
					timeoutMs: 3500
				});
				for (const snap of usage.providers) usageByProvider.set(snap.provider, {
					windows: snap.windows,
					plan: snap.plan
				});
			} catch (err) {
				log$1.debug(`usage enrichment failed (auth status still returned): providers=${usageProviderIds.join(",")} error=${formatForLog(err)}`);
			}
			const result = {
				ts: now,
				providers: authHealth.providers.map((prov) => mapProvider(prov, usageByProvider, configured.expectsOAuth))
			};
			cached = {
				ts: now,
				result
			};
			respond(true, result, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	}
};
//#endregion
//#region src/gateway/server-methods/models.ts
let loggedSlowModelsListCatalog = false;
function resolveModelsListView(params) {
	return typeof params.view === "string" ? params.view : "default";
}
const modelsHandlers = { "models.list": async ({ params, respond, context }) => {
	if (!validateModelsListParams(params)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`));
		return;
	}
	try {
		const cfg = context.getRuntimeConfig();
		const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)) ?? resolveDefaultAgentWorkspaceDir();
		const view = resolveModelsListView(params);
		const catalog = await loadModelCatalogForBrowse({
			cfg,
			view,
			loadCatalog: context.loadGatewayModelCatalog,
			onTimeout: (timeoutMs) => {
				if (loggedSlowModelsListCatalog) return;
				loggedSlowModelsListCatalog = true;
				context.logGateway.debug(`models.list continuing without model catalog after ${timeoutMs}ms`);
			}
		});
		if (view === "all") {
			respond(true, { models: catalog }, void 0);
			return;
		}
		respond(true, { models: await resolveVisibleModelCatalog({
			cfg,
			catalog,
			defaultProvider: DEFAULT_PROVIDER,
			workspaceDir,
			view,
			runtimeAuthDiscovery: false
		}) }, void 0);
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
	}
} };
//#endregion
//#region src/gateway/server-methods/native-hook-relay.ts
const nativeHookRelayHandlers = { "nativeHook.invoke": async ({ params, respond }) => {
	try {
		respond(true, await invokeNativeHookRelay({
			provider: params.provider,
			relayId: params.relayId,
			event: params.event,
			rawPayload: params.rawPayload
		}));
	} catch (error) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, error instanceof Error ? error.message : "native hook relay failed"));
	}
} };
//#endregion
//#region src/gateway/node-pending-work.ts
const DEFAULT_STATUS_ITEM_ID = "baseline-status";
const DEFAULT_STATUS_PRIORITY = "default";
const DEFAULT_PRIORITY = "normal";
const DEFAULT_MAX_ITEMS = 4;
const MAX_ITEMS = 10;
const PRIORITY_RANK = {
	high: 3,
	normal: 2,
	default: 1
};
const stateByNodeId = /* @__PURE__ */ new Map();
function getOrCreateState(nodeId) {
	let state = stateByNodeId.get(nodeId);
	if (!state) {
		state = {
			revision: 0,
			itemsById: /* @__PURE__ */ new Map()
		};
		stateByNodeId.set(nodeId, state);
	}
	return state;
}
function pruneExpired(state, nowMs) {
	let changed = false;
	for (const [id, item] of state.itemsById) if (item.expiresAtMs !== null && item.expiresAtMs <= nowMs) {
		state.itemsById.delete(id);
		changed = true;
	}
	if (changed) state.revision += 1;
	return changed;
}
function pruneStateIfEmpty(nodeId, state) {
	if (state.itemsById.size === 0) stateByNodeId.delete(nodeId);
}
function sortedItems(state) {
	return [...state.itemsById.values()].toSorted((a, b) => {
		const priorityDelta = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
		if (priorityDelta !== 0) return priorityDelta;
		if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
		return a.id.localeCompare(b.id);
	});
}
function makeBaselineStatusItem(nowMs) {
	return {
		id: DEFAULT_STATUS_ITEM_ID,
		type: "status.request",
		priority: DEFAULT_STATUS_PRIORITY,
		createdAtMs: nowMs,
		expiresAtMs: null
	};
}
function enqueueNodePendingWork(params) {
	const nodeId = params.nodeId.trim();
	if (!nodeId) throw new Error("nodeId required");
	const nowMs = Date.now();
	const state = getOrCreateState(nodeId);
	pruneExpired(state, nowMs);
	const existing = [...state.itemsById.values()].find((item) => item.type === params.type);
	if (existing) return {
		revision: state.revision,
		item: existing,
		deduped: true
	};
	const item = {
		id: randomUUID(),
		type: params.type,
		priority: params.priority ?? DEFAULT_PRIORITY,
		createdAtMs: nowMs,
		expiresAtMs: typeof params.expiresInMs === "number" && Number.isFinite(params.expiresInMs) ? nowMs + Math.max(1e3, Math.trunc(params.expiresInMs)) : null,
		...params.payload ? { payload: params.payload } : {}
	};
	state.itemsById.set(item.id, item);
	state.revision += 1;
	return {
		revision: state.revision,
		item,
		deduped: false
	};
}
function drainNodePendingWork(nodeId, opts = {}) {
	const normalizedNodeId = nodeId.trim();
	if (!normalizedNodeId) return {
		revision: 0,
		items: [],
		hasMore: false
	};
	const nowMs = opts.nowMs ?? Date.now();
	const state = stateByNodeId.get(normalizedNodeId);
	const revision = state?.revision ?? 0;
	if (state) {
		pruneExpired(state, nowMs);
		pruneStateIfEmpty(normalizedNodeId, state);
	}
	const maxItems = Math.min(MAX_ITEMS, Math.max(1, Math.trunc(opts.maxItems ?? DEFAULT_MAX_ITEMS)));
	const explicitItems = state ? sortedItems(state) : [];
	const items = explicitItems.slice(0, maxItems);
	const hasExplicitStatus = explicitItems.some((item) => item.type === "status.request");
	const includeBaseline = opts.includeDefaultStatus !== false && !hasExplicitStatus;
	if (includeBaseline && items.length < maxItems) items.push(makeBaselineStatusItem(nowMs));
	const explicitReturnedCount = items.filter((item) => item.id !== DEFAULT_STATUS_ITEM_ID).length;
	const baselineIncluded = items.some((item) => item.id === DEFAULT_STATUS_ITEM_ID);
	return {
		revision,
		items,
		hasMore: explicitItems.length > explicitReturnedCount || includeBaseline && !baselineIncluded
	};
}
//#endregion
//#region src/gateway/node-invoke-plugin-policy.ts
function parseScopes(client) {
	return Array.isArray(client?.connect?.scopes) ? client.connect.scopes.filter((scope) => typeof scope === "string") : [];
}
function parsePayload(payloadJSON, payload) {
	if (!payloadJSON) return payload;
	try {
		return JSON.parse(payloadJSON);
	} catch {
		return payload;
	}
}
function findDangerousPluginNodeCommand(registry, command) {
	const normalizedCommand = command.trim();
	if (!normalizedCommand) return null;
	return registry?.nodeHostCommands?.find((entry) => entry.command.dangerous === true && entry.command.command.trim() === normalizedCommand) ?? null;
}
function createApprovalRuntime(params) {
	const manager = params.context.pluginApprovalManager;
	if (!manager) return;
	return { async request(input) {
		const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) ? input.timeoutMs : DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
		const request = {
			pluginId: params.pluginId,
			title: input.title.slice(0, 80),
			description: input.description.slice(0, 256),
			severity: input.severity ?? "warning",
			toolName: normalizeOptionalString$1(input.toolName) ?? null,
			toolCallId: normalizeOptionalString$1(input.toolCallId) ?? null,
			agentId: normalizeOptionalString$1(input.agentId) ?? null,
			sessionKey: normalizeOptionalString$1(input.sessionKey) ?? null
		};
		const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);
		record.requestedByConnId = params.client?.connId ?? null;
		record.requestedByDeviceId = params.client?.connect?.device?.id ?? null;
		record.requestedByClientId = params.client?.connect?.client?.id ?? null;
		record.requestedByDeviceTokenAuth = params.client?.isDeviceTokenAuth === true;
		const decisionPromise = manager.register(record, timeoutMs);
		const requestEvent = {
			id: record.id,
			request: record.request,
			createdAtMs: record.createdAtMs,
			expiresAtMs: record.expiresAtMs
		};
		const approvalClientConnIds = resolveApprovalRequestRecipientConnIds({
			context: params.context,
			record,
			excludeConnId: params.client?.connId
		});
		if (approvalClientConnIds) params.context.broadcastToConnIds("plugin.approval.requested", requestEvent, approvalClientConnIds, { dropIfSlow: true });
		else params.context.broadcast("plugin.approval.requested", requestEvent, { dropIfSlow: true });
		if (!(approvalClientConnIds !== null ? approvalClientConnIds.size > 0 : params.context.hasExecApprovalClients?.(params.client?.connId) ?? false)) {
			manager.expire(record.id, "no-approval-route");
			return {
				id: record.id,
				decision: null
			};
		}
		const decision = await decisionPromise;
		return {
			id: record.id,
			decision
		};
	} };
}
async function applyPluginNodeInvokePolicy(params) {
	const registry = getActiveRuntimePluginRegistry();
	const entry = registry?.nodeInvokePolicies?.find((candidate) => candidate.policy.commands.includes(params.command));
	if (!entry) {
		const dangerousCommand = findDangerousPluginNodeCommand(registry, params.command);
		if (dangerousCommand) return {
			ok: false,
			code: "PLUGIN_POLICY_MISSING",
			message: `node.invoke ${params.command} is registered as dangerous by plugin ${dangerousCommand.pluginId} but has no plugin node.invoke policy`
		};
		return null;
	}
	const invokeNode = async (override = {}) => {
		const res = await params.context.nodeRegistry.invoke({
			nodeId: params.nodeSession.nodeId,
			command: params.command,
			params: override.params ?? params.params,
			timeoutMs: override.timeoutMs ?? params.timeoutMs,
			idempotencyKey: override.idempotencyKey ?? params.idempotencyKey
		});
		if (!res.ok) return {
			ok: false,
			code: res.error?.code,
			message: res.error?.message ?? "node command failed",
			details: { nodeError: res.error ?? null }
		};
		return {
			ok: true,
			payload: parsePayload(res.payloadJSON, res.payload),
			payloadJSON: res.payloadJSON ?? null
		};
	};
	return await entry.policy.handle({
		nodeId: params.nodeSession.nodeId,
		command: params.command,
		params: params.params,
		timeoutMs: params.timeoutMs,
		idempotencyKey: params.idempotencyKey,
		config: params.context.getRuntimeConfig(),
		pluginConfig: entry.pluginConfig,
		node: {
			nodeId: params.nodeSession.nodeId,
			displayName: params.nodeSession.displayName,
			platform: params.nodeSession.platform,
			deviceFamily: params.nodeSession.deviceFamily,
			commands: params.nodeSession.commands
		},
		client: params.client ? {
			connId: params.client.connId,
			scopes: parseScopes(params.client)
		} : null,
		approvals: createApprovalRuntime({
			context: params.context,
			client: params.client,
			pluginId: entry.pluginId
		}),
		invokeNode
	});
}
//#endregion
//#region src/gateway/node-invoke-system-run-approval-errors.ts
function systemRunApprovalGuardError(params) {
	const details = params.details ? { ...params.details } : {};
	return {
		ok: false,
		message: params.message,
		details: {
			code: params.code,
			...details
		}
	};
}
function systemRunApprovalRequired(runId) {
	return systemRunApprovalGuardError({
		code: "APPROVAL_REQUIRED",
		message: "approval required",
		details: { runId }
	});
}
//#endregion
//#region src/gateway/node-invoke-system-run-approval-match.ts
function requestMismatch() {
	return {
		ok: false,
		code: "APPROVAL_REQUEST_MISMATCH",
		message: "approval id does not match request"
	};
}
function evaluateSystemRunApprovalMatch(params) {
	if (params.request.host !== "node") return requestMismatch();
	const actualBinding = buildSystemRunApprovalBinding({
		argv: params.argv,
		cwd: params.binding.cwd,
		agentId: params.binding.agentId,
		sessionKey: params.binding.sessionKey,
		env: params.binding.env
	});
	const expectedBinding = params.request.systemRunBinding;
	if (!expectedBinding) return missingSystemRunApprovalBinding({ actualEnvKeys: actualBinding.envKeys });
	return matchSystemRunApprovalBinding({
		expected: expectedBinding,
		actual: actualBinding.binding,
		actualEnvKeys: actualBinding.envKeys
	});
}
//#endregion
//#region src/gateway/node-invoke-system-run-approval.ts
const BACKEND_BRIDGEABLE_NO_DEVICE_REQUEST_CLIENT_IDS = new Set([
	GATEWAY_CLIENT_NAMES.CONTROL_UI,
	GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
	GATEWAY_CLIENT_NAMES.WEBCHAT,
	GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT
]);
function normalizeApprovalDecision(value) {
	const s = normalizeNullableString(value);
	return s === "allow-once" || s === "allow-always" ? s : null;
}
function clientHasApprovals(client) {
	const scopes = Array.isArray(client?.connect?.scopes) ? client?.connect?.scopes : [];
	return scopes.includes("operator.admin") || scopes.includes("operator.approvals");
}
function isTrustedBackendApprovalClient(client) {
	return clientHasApprovals(client) && client?.connect?.client?.id === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT && client.connect.client.mode === GATEWAY_CLIENT_MODES.BACKEND && client.isDeviceTokenAuth !== true;
}
function canBridgeNoDeviceApprovalFromBackend(params) {
	const requestedByClientId = normalizeNullableString(params.snapshot.requestedByClientId);
	const request = params.snapshot.request;
	return params.snapshot.requestedByDeviceId == null && params.snapshot.requestedByDeviceTokenAuth !== true && !hasChatApprovalReplayBinding(request) && requestedByClientId !== null && BACKEND_BRIDGEABLE_NO_DEVICE_REQUEST_CLIENT_IDS.has(requestedByClientId) && isTrustedBackendApprovalClient(params.client);
}
function hasChatApprovalReplayBinding(request) {
	return normalizeComparableString(request.turnSourceChannel, { lowercase: true }) !== null || normalizeComparableString(request.turnSourceTo) !== null || normalizeComparableString(request.turnSourceAccountId) !== null || normalizeComparableString(request.turnSourceThreadId) !== null;
}
function normalizeComparableString(value, opts = {}) {
	const normalized = typeof value === "number" && Number.isFinite(value) ? String(value) : normalizeNullableString(value);
	if (!normalized) return null;
	return opts.lowercase ? normalized.toLowerCase() : normalized;
}
function matchesRequiredString(params) {
	const expected = normalizeComparableString(params.expected, { lowercase: params.lowercase });
	if (!expected) return false;
	return expected === normalizeComparableString(params.actual, { lowercase: params.lowercase });
}
function matchesOptionalString(params) {
	const expected = normalizeComparableString(params.expected, { lowercase: params.lowercase });
	if (!expected) return true;
	return expected === normalizeComparableString(params.actual, { lowercase: params.lowercase });
}
function canBridgeNoDeviceChatApprovalFromBackend(params) {
	if (params.snapshot.requestedByDeviceId != null || params.snapshot.requestedByDeviceTokenAuth === true || !isTrustedBackendApprovalClient(params.client)) return false;
	const request = params.snapshot.request;
	const plan = request.systemRunPlan ?? null;
	return matchesRequiredString({
		expected: request.turnSourceChannel,
		actual: params.rawParams.turnSourceChannel,
		lowercase: true
	}) && matchesOptionalString({
		expected: request.turnSourceTo,
		actual: params.rawParams.turnSourceTo
	}) && matchesRequiredString({
		expected: plan?.sessionKey ?? request.sessionKey,
		actual: params.rawParams.sessionKey
	}) && matchesOptionalString({
		expected: plan?.agentId ?? request.agentId,
		actual: params.rawParams.agentId
	}) && matchesOptionalString({
		expected: request.turnSourceAccountId,
		actual: params.rawParams.turnSourceAccountId
	}) && matchesOptionalString({
		expected: request.turnSourceThreadId,
		actual: params.rawParams.turnSourceThreadId
	});
}
function pickSystemRunParams(raw) {
	const next = {};
	for (const key of [
		"command",
		"rawCommand",
		"systemRunPlan",
		"cwd",
		"env",
		"timeoutMs",
		"needsScreenRecording",
		"agentId",
		"sessionKey",
		"runId",
		"suppressNotifyOnExit"
	]) if (key in raw) next[key] = raw[key];
	return next;
}
/**
* Gate `system.run` approval flags (`approved`, `approvalDecision`) behind a real
* `exec.approval.*` record. This prevents users with only `operator.write` from
* bypassing node-host approvals by injecting control fields into `node.invoke`.
*/
function sanitizeSystemRunParamsForForwarding(opts) {
	const obj = asNullableRecord(opts.rawParams);
	if (!obj) return {
		ok: true,
		params: opts.rawParams
	};
	const p = obj;
	const approved = p.approved === true;
	const requestedDecision = normalizeApprovalDecision(p.approvalDecision);
	const wantsApprovalOverride = approved || requestedDecision !== null;
	const next = pickSystemRunParams(obj);
	if (!wantsApprovalOverride) {
		const cmdTextResolution = resolveSystemRunCommandRequest({
			command: p.command,
			rawCommand: p.rawCommand
		});
		if (!cmdTextResolution.ok) return {
			ok: false,
			message: cmdTextResolution.message,
			details: cmdTextResolution.details
		};
		return {
			ok: true,
			params: next
		};
	}
	const runId = normalizeNullableString(p.runId);
	if (!runId) return systemRunApprovalGuardError({
		code: "MISSING_RUN_ID",
		message: "approval override requires params.runId"
	});
	const manager = opts.execApprovalManager;
	if (!manager) return systemRunApprovalGuardError({
		code: "APPROVALS_UNAVAILABLE",
		message: "exec approvals unavailable"
	});
	const snapshot = manager.getSnapshot(runId);
	if (!snapshot) return systemRunApprovalGuardError({
		code: "UNKNOWN_APPROVAL_ID",
		message: "unknown or expired approval id",
		details: { runId }
	});
	if ((typeof opts.nowMs === "number" ? opts.nowMs : Date.now()) > snapshot.expiresAtMs) return systemRunApprovalGuardError({
		code: "APPROVAL_EXPIRED",
		message: "approval expired",
		details: { runId }
	});
	const targetNodeId = normalizeNullableString(opts.nodeId);
	if (!targetNodeId) return systemRunApprovalGuardError({
		code: "MISSING_NODE_ID",
		message: "node.invoke requires nodeId",
		details: { runId }
	});
	const approvalNodeId = normalizeNullableString(snapshot.request.nodeId);
	if (!approvalNodeId) return systemRunApprovalGuardError({
		code: "APPROVAL_NODE_BINDING_MISSING",
		message: "approval id missing node binding",
		details: { runId }
	});
	if (approvalNodeId !== targetNodeId) return systemRunApprovalGuardError({
		code: "APPROVAL_NODE_MISMATCH",
		message: "approval id not valid for this node",
		details: { runId }
	});
	const snapshotDeviceId = snapshot.requestedByDeviceId ?? null;
	const clientDeviceId = opts.client?.connect?.device?.id ?? null;
	if (snapshotDeviceId) {
		if (snapshotDeviceId !== clientDeviceId) return systemRunApprovalGuardError({
			code: "APPROVAL_DEVICE_MISMATCH",
			message: "approval id not valid for this device",
			details: { runId }
		});
	} else if (snapshot.requestedByConnId && snapshot.requestedByConnId !== (opts.client?.connId ?? null) && !canBridgeNoDeviceApprovalFromBackend({
		snapshot,
		client: opts.client
	}) && !canBridgeNoDeviceChatApprovalFromBackend({
		snapshot,
		rawParams: p,
		client: opts.client
	})) return systemRunApprovalGuardError({
		code: "APPROVAL_CLIENT_MISMATCH",
		message: "approval id not valid for this client",
		details: { runId }
	});
	const runtimeContext = resolveSystemRunApprovalRuntimeContext({
		plan: snapshot.request.systemRunPlan ?? null,
		command: p.command,
		rawCommand: p.rawCommand,
		cwd: p.cwd,
		agentId: p.agentId,
		sessionKey: p.sessionKey
	});
	if (!runtimeContext.ok) return {
		ok: false,
		message: runtimeContext.message,
		details: runtimeContext.details
	};
	if (runtimeContext.plan) {
		next.command = [...runtimeContext.plan.argv];
		next.systemRunPlan = runtimeContext.plan;
		if (runtimeContext.commandText) next.rawCommand = runtimeContext.commandText;
		else delete next.rawCommand;
		if (runtimeContext.cwd) next.cwd = runtimeContext.cwd;
		else delete next.cwd;
		if (runtimeContext.agentId) next.agentId = runtimeContext.agentId;
		else delete next.agentId;
		if (runtimeContext.sessionKey) next.sessionKey = runtimeContext.sessionKey;
		else delete next.sessionKey;
	}
	const approvalMatch = evaluateSystemRunApprovalMatch({
		argv: runtimeContext.argv,
		request: snapshot.request,
		binding: {
			cwd: runtimeContext.cwd,
			agentId: runtimeContext.agentId,
			sessionKey: runtimeContext.sessionKey,
			env: p.env
		}
	});
	if (!approvalMatch.ok) return toSystemRunApprovalMismatchError({
		runId,
		match: approvalMatch
	});
	if (snapshot.decision === "allow-once") {
		if (typeof manager.consumeAllowOnce !== "function" || !manager.consumeAllowOnce(runId)) return systemRunApprovalRequired(runId);
		next.approved = true;
		next.approvalDecision = "allow-once";
		return {
			ok: true,
			params: next
		};
	}
	if (snapshot.decision === "allow-always") {
		next.approved = true;
		next.approvalDecision = "allow-always";
		return {
			ok: true,
			params: next
		};
	}
	if (snapshot.resolvedAtMs !== void 0 && snapshot.decision === void 0 && snapshot.resolvedBy === null && approved && requestedDecision === "allow-once" && clientHasApprovals(opts.client)) {
		next.approved = true;
		next.approvalDecision = "allow-once";
		return {
			ok: true,
			params: next
		};
	}
	return systemRunApprovalRequired(runId);
}
//#endregion
//#region src/gateway/node-invoke-sanitize.ts
function sanitizeNodeInvokeParamsForForwarding(opts) {
	if (opts.command === "system.run") return sanitizeSystemRunParamsForForwarding({
		nodeId: opts.nodeId,
		rawParams: opts.rawParams,
		client: opts.client,
		execApprovalManager: opts.execApprovalManager
	});
	return {
		ok: true,
		params: opts.rawParams
	};
}
//#endregion
//#region src/gateway/server-methods/nodes.handlers.invoke-result.ts
function normalizeNodeInvokeResultParams(params) {
	if (!params || typeof params !== "object") return params;
	const normalized = { ...params };
	if (normalized.payloadJSON === null) delete normalized.payloadJSON;
	else if (normalized.payloadJSON !== void 0 && typeof normalized.payloadJSON !== "string") {
		if (normalized.payload === void 0) normalized.payload = normalized.payloadJSON;
		delete normalized.payloadJSON;
	}
	if (normalized.error === null) delete normalized.error;
	return normalized;
}
const handleNodeInvokeResult = async ({ params, respond, context, client }) => {
	const normalizedParams = normalizeNodeInvokeResultParams(params);
	if (!validateNodeInvokeResultParams(normalizedParams)) {
		respondInvalidParams({
			respond,
			method: "node.invoke.result",
			validator: validateNodeInvokeResultParams
		});
		return;
	}
	const p = normalizedParams;
	const callerNodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
	if (callerNodeId && callerNodeId !== p.nodeId) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId mismatch"));
		return;
	}
	if (!context.nodeRegistry.handleInvokeResult({
		id: p.id,
		nodeId: p.nodeId,
		connId: client?.connId,
		ok: p.ok,
		payload: p.payload,
		payloadJSON: p.payloadJSON ?? null,
		error: p.error ?? null
	})) {
		context.logGateway.debug(`late invoke result ignored: id=${p.id} node=${p.nodeId}`);
		respond(true, {
			ok: true,
			ignored: true
		}, void 0);
		return;
	}
	respond(true, { ok: true }, void 0);
};
//#endregion
//#region src/gateway/server-methods/nodes.ts
const NODE_WAKE_THROTTLE_MS = 15e3;
const NODE_WAKE_NUDGE_THROTTLE_MS = 10 * 6e4;
const NODE_PENDING_ACTION_TTL_MS = 10 * 6e4;
const NODE_PENDING_ACTION_MAX_PER_NODE = 64;
const TALK_PTT_COMMANDS = new Set([
	"talk.ptt.start",
	"talk.ptt.stop",
	"talk.ptt.cancel",
	"talk.ptt.once"
]);
const talkPttEventSeqBySessionId = /* @__PURE__ */ new Map();
const pendingNodeActionsById = /* @__PURE__ */ new Map();
function normalizeBrowserProxyPath(value) {
	const trimmed = value.trim();
	if (!trimmed) return trimmed;
	const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	if (withLeadingSlash.length <= 1) return withLeadingSlash;
	return withLeadingSlash.replace(/\/+$/, "");
}
function isPersistentBrowserProxyMutation(method, path) {
	const normalizedPath = normalizeBrowserProxyPath(path);
	if (method === "POST" && (normalizedPath === "/profiles/create" || normalizedPath === "/reset-profile")) return true;
	return method === "DELETE" && /^\/profiles\/[^/]+$/.test(normalizedPath);
}
function isForbiddenBrowserProxyMutation(params) {
	if (!params || typeof params !== "object") return false;
	const candidate = params;
	const method = (normalizeOptionalString$1(candidate.method) ?? "").toUpperCase();
	const path = normalizeOptionalString$1(candidate.path) ?? "";
	return Boolean(method && path && isPersistentBrowserProxyMutation(method, path));
}
function normalizePluginSurfaceRefreshParams(params) {
	if (!params || typeof params !== "object") return;
	const surface = normalizeOptionalString$1(params.surface);
	if (!surface) return;
	return { surface };
}
function respondRefreshedPluginSurface(params) {
	const refreshed = params.client ? refreshClientPluginNodeCapability({
		client: params.client,
		surface: params.client.pluginNodeCapabilitySurfaces?.[params.surface] ?? { surface: params.surface }
	}) : void 0;
	if (!refreshed) {
		params.respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `${params.surface} plugin surface unavailable`));
		return;
	}
	params.respond(true, {
		surface: refreshed.surface,
		pluginSurfaceUrls: { [refreshed.surface]: refreshed.scopedUrl },
		expiresAtMs: refreshed.expiresAtMs
	}, void 0);
}
async function resolveDirectNodePushConfig() {
	const auth = await resolveApnsAuthConfigFromEnv(process.env);
	return auth.ok ? {
		ok: true,
		auth: auth.value
	} : {
		ok: false,
		error: auth.error
	};
}
function resolveRelayNodePushConfig(cfg) {
	const relay = resolveApnsRelayConfigFromEnv(process.env, cfg.gateway);
	return relay.ok ? {
		ok: true,
		relayConfig: relay.value
	} : {
		ok: false,
		error: relay.error
	};
}
async function clearStaleApnsRegistrationIfNeeded(registration, nodeId, params) {
	if (!shouldClearStoredApnsRegistration({
		registration,
		result: params
	})) return;
	await clearApnsRegistrationIfCurrent({
		nodeId,
		registration
	});
}
async function delayMs(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
function isForegroundRestrictedIosCommand(command) {
	return isForegroundRestrictedPluginNodeCommand(command) || command.startsWith("camera.") || command.startsWith("screen.") || command.startsWith("talk.");
}
function shouldQueueAsPendingForegroundAction(params) {
	const platform = normalizeLowercaseStringOrEmpty(params.platform);
	if (!platform.startsWith("ios") && !platform.startsWith("ipados")) return false;
	if (!isForegroundRestrictedIosCommand(params.command)) return false;
	const error = params.error && typeof params.error === "object" ? params.error : null;
	const code = normalizeOptionalString$1(error?.code)?.toUpperCase() ?? "";
	const message = normalizeOptionalString$1(error?.message)?.toUpperCase() ?? "";
	return code === "NODE_BACKGROUND_UNAVAILABLE" || message.includes("BACKGROUND_UNAVAILABLE");
}
function prunePendingNodeActions(nodeId, nowMs) {
	const queue = pendingNodeActionsById.get(nodeId) ?? [];
	const minTimestampMs = nowMs - NODE_PENDING_ACTION_TTL_MS;
	const live = queue.filter((entry) => entry.enqueuedAtMs >= minTimestampMs);
	if (live.length === 0) {
		pendingNodeActionsById.delete(nodeId);
		return [];
	}
	pendingNodeActionsById.set(nodeId, live);
	return live;
}
function enqueuePendingNodeAction(params) {
	const nowMs = Date.now();
	const queue = prunePendingNodeActions(params.nodeId, nowMs);
	const existing = queue.find((entry) => entry.idempotencyKey === params.idempotencyKey);
	if (existing) return existing;
	const entry = {
		id: randomUUID(),
		nodeId: params.nodeId,
		command: params.command,
		paramsJSON: params.paramsJSON,
		idempotencyKey: params.idempotencyKey,
		enqueuedAtMs: nowMs
	};
	queue.push(entry);
	if (queue.length > NODE_PENDING_ACTION_MAX_PER_NODE) queue.splice(0, queue.length - NODE_PENDING_ACTION_MAX_PER_NODE);
	pendingNodeActionsById.set(params.nodeId, queue);
	return entry;
}
function listPendingNodeActions(nodeId) {
	return prunePendingNodeActions(nodeId, Date.now());
}
function refreshConnectedNodeSurfaceCaches(params) {
	const cfg = params.cfg ?? params.context.getRuntimeConfig();
	const { nodeSession } = params;
	recordRemoteNodeInfo({
		nodeId: nodeSession.nodeId,
		displayName: nodeSession.displayName,
		platform: nodeSession.platform,
		deviceFamily: nodeSession.deviceFamily,
		commands: nodeSession.commands,
		remoteIp: nodeSession.remoteIp
	});
	refreshRemoteNodeBins({
		nodeId: nodeSession.nodeId,
		platform: nodeSession.platform,
		deviceFamily: nodeSession.deviceFamily,
		commands: nodeSession.commands,
		cfg
	}).catch((err) => params.context.logGateway.warn(`remote bin probe failed for ${nodeSession.nodeId}: ${formatErrorMessage(err)}`));
}
function resolveAllowedPendingNodeActions(params) {
	const pending = listPendingNodeActions(params.nodeId);
	if (pending.length === 0) return pending;
	const connect = params.client?.connect;
	const declaredCommands = Array.isArray(connect?.commands) ? connect.commands : [];
	const allowlist = resolveNodeCommandAllowlist(params.cfg, {
		platform: connect?.client?.platform,
		deviceFamily: connect?.client?.deviceFamily,
		caps: connect?.caps,
		commands: declaredCommands
	});
	const allowed = pending.filter((entry) => {
		return isNodeCommandAllowed({
			command: entry.command,
			declaredCommands,
			allowlist
		}).ok;
	});
	if (allowed.length !== pending.length) if (allowed.length === 0) pendingNodeActionsById.delete(params.nodeId);
	else pendingNodeActionsById.set(params.nodeId, allowed);
	return allowed;
}
function ackPendingNodeActions(nodeId, ids) {
	if (ids.length === 0) return listPendingNodeActions(nodeId);
	const pending = prunePendingNodeActions(nodeId, Date.now());
	const idSet = new Set(ids);
	const remaining = pending.filter((entry) => !idSet.has(entry.id));
	if (remaining.length === 0) {
		pendingNodeActionsById.delete(nodeId);
		return [];
	}
	pendingNodeActionsById.set(nodeId, remaining);
	return remaining;
}
function toPendingParamsJSON(params) {
	if (params === void 0) return;
	try {
		return JSON.stringify(params);
	} catch {
		return;
	}
}
function emitTalkPttNodeEvent(params) {
	if (!TALK_PTT_COMMANDS.has(params.command)) return;
	const payloadObj = typeof params.payload === "object" && params.payload !== null ? params.payload : {};
	const captureId = normalizeOptionalString$1(payloadObj.captureId) ?? randomUUID();
	const sessionId = `node:${params.nodeId}:talk:${captureId}`;
	const seq = (talkPttEventSeqBySessionId.get(sessionId) ?? 0) + 1;
	talkPttEventSeqBySessionId.set(sessionId, seq);
	while (talkPttEventSeqBySessionId.size > 2048) {
		const oldest = talkPttEventSeqBySessionId.keys().next().value;
		if (oldest === void 0) break;
		talkPttEventSeqBySessionId.delete(oldest);
	}
	const type = params.command === "talk.ptt.start" ? "capture.started" : params.command === "talk.ptt.cancel" ? "capture.cancelled" : params.command === "talk.ptt.once" ? "capture.once" : "capture.stopped";
	const final = params.command !== "talk.ptt.start";
	const talkEvent = {
		id: `${sessionId}:${seq}`,
		type,
		sessionId,
		captureId,
		seq,
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		mode: "stt-tts",
		transport: "managed-room",
		brain: "agent-consult",
		final,
		payload: {
			nodeId: params.nodeId,
			command: params.command,
			status: normalizeOptionalString$1(payloadObj.status) ?? void 0,
			transcript: normalizeOptionalString$1(payloadObj.transcript) ?? void 0
		}
	};
	params.context.broadcast("talk.event", {
		nodeId: params.nodeId,
		command: params.command,
		talkEvent
	}, { dropIfSlow: true });
}
async function maybeWakeNodeWithApns(nodeId, opts) {
	const state = nodeWakeById.get(nodeId) ?? { lastWakeAtMs: 0 };
	nodeWakeById.set(nodeId, state);
	if (state.inFlight) return await state.inFlight;
	const now = Date.now();
	if (!(opts?.force === true) && state.lastWakeAtMs > 0 && now - state.lastWakeAtMs < NODE_WAKE_THROTTLE_MS) return {
		available: true,
		throttled: true,
		path: "throttled",
		durationMs: 0
	};
	state.inFlight = (async () => {
		const startedAtMs = Date.now();
		const withDuration = (attempt) => ({
			...attempt,
			durationMs: Math.max(0, Date.now() - startedAtMs)
		});
		try {
			const registration = await loadApnsRegistration(nodeId);
			if (!registration) {
				nodeWakeById.delete(nodeId);
				return withDuration({
					available: false,
					throttled: false,
					path: "no-registration"
				});
			}
			let wakeResult;
			if (registration.transport === "relay") {
				const relay = resolveRelayNodePushConfig(opts?.cfg ?? getRuntimeConfig());
				if (!relay.ok) return withDuration({
					available: false,
					throttled: false,
					path: "no-auth",
					apnsReason: relay.error
				});
				state.lastWakeAtMs = Date.now();
				wakeResult = await sendApnsBackgroundWake({
					registration,
					nodeId,
					wakeReason: opts?.wakeReason ?? "node.invoke",
					relayConfig: relay.relayConfig
				});
			} else {
				const auth = await resolveDirectNodePushConfig();
				if (!auth.ok) return withDuration({
					available: false,
					throttled: false,
					path: "no-auth",
					apnsReason: auth.error
				});
				state.lastWakeAtMs = Date.now();
				wakeResult = await sendApnsBackgroundWake({
					registration,
					nodeId,
					wakeReason: opts?.wakeReason ?? "node.invoke",
					auth: auth.auth
				});
			}
			await clearStaleApnsRegistrationIfNeeded(registration, nodeId, wakeResult);
			if (!wakeResult.ok) return withDuration({
				available: true,
				throttled: false,
				path: "send-error",
				apnsStatus: wakeResult.status,
				apnsReason: wakeResult.reason
			});
			return withDuration({
				available: true,
				throttled: false,
				path: "sent",
				apnsStatus: wakeResult.status,
				apnsReason: wakeResult.reason
			});
		} catch (err) {
			const message = formatErrorMessage(err);
			if (state.lastWakeAtMs === 0) return withDuration({
				available: false,
				throttled: false,
				path: "send-error",
				apnsReason: message
			});
			return withDuration({
				available: true,
				throttled: false,
				path: "send-error",
				apnsReason: message
			});
		}
	})();
	try {
		return await state.inFlight;
	} finally {
		state.inFlight = void 0;
	}
}
async function maybeSendNodeWakeNudge(nodeId, opts) {
	const startedAtMs = Date.now();
	const withDuration = (attempt) => ({
		...attempt,
		durationMs: Math.max(0, Date.now() - startedAtMs)
	});
	const lastNudgeAtMs = nodeWakeNudgeById.get(nodeId) ?? 0;
	if (lastNudgeAtMs > 0 && Date.now() - lastNudgeAtMs < NODE_WAKE_NUDGE_THROTTLE_MS) return withDuration({
		sent: false,
		throttled: true,
		reason: "throttled"
	});
	const registration = await loadApnsRegistration(nodeId);
	if (!registration) return withDuration({
		sent: false,
		throttled: false,
		reason: "no-registration"
	});
	try {
		let result;
		if (registration.transport === "relay") {
			const relay = resolveRelayNodePushConfig(opts?.cfg ?? getRuntimeConfig());
			if (!relay.ok) return withDuration({
				sent: false,
				throttled: false,
				reason: "no-auth",
				apnsReason: relay.error
			});
			result = await sendApnsAlert({
				registration,
				nodeId,
				title: "OpenClaw needs a quick reopen",
				body: "Tap to reopen OpenClaw and restore the node connection.",
				relayConfig: relay.relayConfig
			});
		} else {
			const auth = await resolveDirectNodePushConfig();
			if (!auth.ok) return withDuration({
				sent: false,
				throttled: false,
				reason: "no-auth",
				apnsReason: auth.error
			});
			result = await sendApnsAlert({
				registration,
				nodeId,
				title: "OpenClaw needs a quick reopen",
				body: "Tap to reopen OpenClaw and restore the node connection.",
				auth: auth.auth
			});
		}
		await clearStaleApnsRegistrationIfNeeded(registration, nodeId, result);
		if (!result.ok) return withDuration({
			sent: false,
			throttled: false,
			reason: "apns-not-ok",
			apnsStatus: result.status,
			apnsReason: result.reason
		});
		nodeWakeNudgeById.set(nodeId, Date.now());
		return withDuration({
			sent: true,
			throttled: false,
			reason: "sent",
			apnsStatus: result.status,
			apnsReason: result.reason
		});
	} catch (err) {
		return withDuration({
			sent: false,
			throttled: false,
			reason: "send-error",
			apnsReason: formatErrorMessage(err)
		});
	}
}
async function waitForNodeReconnect(params) {
	const timeoutMs = Math.max(250, params.timeoutMs ?? 3e3);
	const pollMs = Math.max(50, params.pollMs ?? 150);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (params.context.nodeRegistry.get(params.nodeId)) return true;
		await delayMs(pollMs);
	}
	return Boolean(params.context.nodeRegistry.get(params.nodeId));
}
const nodeHandlers = {
	"node.pair.request": async ({ params, respond, context }) => {
		if (!validateNodePairRequestParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pair.request",
				validator: validateNodePairRequestParams
			});
			return;
		}
		const p = params;
		await respondUnavailableOnThrow(respond, async () => {
			const result = await requestNodePairing({
				nodeId: p.nodeId,
				displayName: p.displayName,
				platform: p.platform,
				version: p.version,
				coreVersion: p.coreVersion,
				uiVersion: p.uiVersion,
				deviceFamily: p.deviceFamily,
				modelIdentifier: p.modelIdentifier,
				caps: p.caps,
				commands: p.commands,
				permissions: p.permissions,
				remoteIp: p.remoteIp,
				silent: p.silent
			});
			const resolvedAt = Date.now();
			for (const superseded of result.superseded ?? []) context.broadcast("node.pair.resolved", {
				requestId: superseded.requestId,
				nodeId: superseded.nodeId,
				decision: "rejected",
				ts: resolvedAt
			}, { dropIfSlow: true });
			if (result.status === "pending" && result.created) context.broadcast("node.pair.requested", result.request, { dropIfSlow: true });
			respond(true, result, void 0);
		});
	},
	"node.pair.list": async ({ params, respond }) => {
		if (!validateNodePairListParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pair.list",
				validator: validateNodePairListParams
			});
			return;
		}
		await respondUnavailableOnThrow(respond, async () => {
			respond(true, await listNodePairing(), void 0);
		});
	},
	"node.pair.approve": async ({ params, respond, context, client }) => {
		if (!validateNodePairApproveParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pair.approve",
				validator: validateNodePairApproveParams
			});
			return;
		}
		const { requestId } = params;
		const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
		await respondUnavailableOnThrow(respond, async () => {
			const approved = await approveNodePairing(requestId, { callerScopes });
			if (!approved) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
				return;
			}
			if ("status" in approved && approved.status === "forbidden") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${approved.missingScope}`));
				return;
			}
			if (!("node" in approved)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
				return;
			}
			const approvedNode = approved.node;
			const cfg = context.getRuntimeConfig();
			const currentAllowlist = resolveNodeCommandAllowlist(cfg, {
				platform: approvedNode.platform,
				deviceFamily: approvedNode.deviceFamily,
				caps: approvedNode.caps,
				commands: approvedNode.commands,
				approvedCommands: approvedNode.commands
			});
			const currentAllowedCommands = normalizeDeclaredNodeCommands({
				declaredCommands: approvedNode.commands ?? [],
				allowlist: currentAllowlist
			});
			const updatedNode = context.nodeRegistry.updateSurface(approvedNode.nodeId, {
				caps: approvedNode.caps ?? [],
				commands: currentAllowedCommands,
				permissions: approvedNode.permissions
			});
			if (updatedNode) refreshConnectedNodeSurfaceCaches({
				context,
				nodeSession: updatedNode,
				cfg
			});
			context.broadcast("node.pair.resolved", {
				requestId,
				nodeId: approvedNode.nodeId,
				decision: "approved",
				ts: Date.now()
			}, { dropIfSlow: true });
			respond(true, approved, void 0);
		});
	},
	"node.pair.reject": async ({ params, respond, context }) => {
		if (!validateNodePairRejectParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pair.reject",
				validator: validateNodePairRejectParams
			});
			return;
		}
		const { requestId } = params;
		await respondUnavailableOnThrow(respond, async () => {
			const rejected = await rejectNodePairing(requestId);
			if (!rejected) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
				return;
			}
			context.broadcast("node.pair.resolved", {
				requestId,
				nodeId: rejected.nodeId,
				decision: "rejected",
				ts: Date.now()
			}, { dropIfSlow: true });
			respond(true, rejected, void 0);
		});
	},
	"node.pair.remove": async ({ params, respond, context }) => {
		if (!validateNodePairRemoveParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pair.remove",
				validator: validateNodePairRemoveParams
			});
			return;
		}
		const { nodeId } = params;
		await respondUnavailableOnThrow(respond, async () => {
			const removed = await removePairedNode(nodeId);
			if (!removed) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
				return;
			}
			pendingNodeActionsById.delete(removed.nodeId);
			context.nodeRegistry.updateSurface(removed.nodeId, {
				caps: [],
				commands: [],
				permissions: void 0
			});
			removeRemoteNodeInfo(removed.nodeId);
			context.broadcast("node.pair.resolved", {
				requestId: "",
				nodeId: removed.nodeId,
				decision: "removed",
				ts: Date.now()
			}, { dropIfSlow: true });
			respond(true, removed, void 0);
		});
	},
	"node.pair.verify": async ({ params, respond }) => {
		if (!validateNodePairVerifyParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pair.verify",
				validator: validateNodePairVerifyParams
			});
			return;
		}
		const { nodeId, token } = params;
		await respondUnavailableOnThrow(respond, async () => {
			respond(true, await verifyNodeToken(nodeId, token), void 0);
		});
	},
	"node.rename": async ({ params, respond }) => {
		if (!validateNodeRenameParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.rename",
				validator: validateNodeRenameParams
			});
			return;
		}
		const { nodeId, displayName } = params;
		await respondUnavailableOnThrow(respond, async () => {
			const trimmed = displayName.trim();
			if (!trimmed) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "displayName required"));
				return;
			}
			const updated = await renamePairedNode(nodeId, trimmed);
			if (!updated) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
				return;
			}
			respond(true, {
				nodeId: updated.nodeId,
				displayName: updated.displayName
			}, void 0);
		});
	},
	"node.list": async ({ params, respond, context }) => {
		if (!validateNodeListParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.list",
				validator: validateNodeListParams
			});
			return;
		}
		await respondUnavailableOnThrow(respond, async () => {
			const [devicePairing, nodePairing] = await Promise.all([listDevicePairing(), listNodePairing()]);
			const nodes = listKnownNodes(createKnownNodeCatalog({
				pairedDevices: devicePairing.paired,
				pairedNodes: nodePairing.paired,
				connectedNodes: context.nodeRegistry.listConnected()
			}));
			respond(true, {
				ts: Date.now(),
				nodes
			}, void 0);
		});
	},
	"node.describe": async ({ params, respond, context }) => {
		if (!validateNodeDescribeParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.describe",
				validator: validateNodeDescribeParams
			});
			return;
		}
		const { nodeId } = params;
		const id = normalizeOptionalString$1(nodeId) ?? "";
		if (!id) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
			return;
		}
		await respondUnavailableOnThrow(respond, async () => {
			const [devicePairing, nodePairing] = await Promise.all([listDevicePairing(), listNodePairing()]);
			const node = getKnownNode(createKnownNodeCatalog({
				pairedDevices: devicePairing.paired,
				pairedNodes: nodePairing.paired,
				connectedNodes: context.nodeRegistry.listConnected()
			}), id);
			if (!node) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
				return;
			}
			respond(true, {
				ts: Date.now(),
				...node
			}, void 0);
		});
	},
	"node.pluginSurface.refresh": async ({ params, respond, client }) => {
		const parsed = normalizePluginSurfaceRefreshParams(params);
		if (!parsed) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "surface required"));
			return;
		}
		respondRefreshedPluginSurface({
			surface: parsed.surface,
			client,
			respond
		});
	},
	"node.pending.pull": async ({ params, respond, client, context }) => {
		if (!validateNodeListParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pending.pull",
				validator: validateNodeListParams
			});
			return;
		}
		const trimmedNodeId = normalizeOptionalString$1(client?.connect?.device?.id ?? client?.connect?.client?.id) ?? "";
		if (!trimmedNodeId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
			return;
		}
		respond(true, {
			nodeId: trimmedNodeId,
			actions: resolveAllowedPendingNodeActions({
				nodeId: trimmedNodeId,
				client,
				cfg: context.getRuntimeConfig()
			}).map((entry) => ({
				id: entry.id,
				command: entry.command,
				paramsJSON: entry.paramsJSON ?? null,
				enqueuedAtMs: entry.enqueuedAtMs
			}))
		}, void 0);
	},
	"node.pending.ack": async ({ params, respond, client }) => {
		if (!validateNodePendingAckParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pending.ack",
				validator: validateNodePendingAckParams
			});
			return;
		}
		const trimmedNodeId = normalizeOptionalString$1(client?.connect?.device?.id ?? client?.connect?.client?.id) ?? "";
		if (!trimmedNodeId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
			return;
		}
		const ackIds = Array.from(new Set((params.ids ?? []).map((value) => normalizeOptionalString$1(value) ?? "").filter(Boolean)));
		respond(true, {
			nodeId: trimmedNodeId,
			ackedIds: ackIds,
			remainingCount: ackPendingNodeActions(trimmedNodeId, ackIds).length
		}, void 0);
	},
	"node.invoke": async ({ params, respond, context, client, req }) => {
		if (!validateNodeInvokeParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.invoke",
				validator: validateNodeInvokeParams
			});
			return;
		}
		const p = params;
		const nodeId = normalizeOptionalString$1(p.nodeId) ?? "";
		const command = normalizeOptionalString$1(p.command) ?? "";
		if (!nodeId || !command) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId and command required"));
			return;
		}
		if (command === "system.execApprovals.get" || command === "system.execApprovals.set") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "node.invoke does not allow system.execApprovals.*; use exec.approvals.node.*", { details: { command } }));
			return;
		}
		if (command === "browser.proxy" && isForbiddenBrowserProxyMutation(p.params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "node.invoke cannot mutate persistent browser profiles via browser.proxy", { details: { command } }));
			return;
		}
		await respondUnavailableOnThrow(respond, async () => {
			const cfg = context.getRuntimeConfig();
			let nodeSession = context.nodeRegistry.get(nodeId);
			if (!nodeSession) {
				const wakeReqId = req.id;
				const wakeFlowStartedAtMs = Date.now();
				context.logGateway.info(`node wake start node=${nodeId} req=${wakeReqId} command=${command}`);
				const wake = await maybeWakeNodeWithApns(nodeId, { cfg });
				context.logGateway.info(`node wake stage=wake1 node=${nodeId} req=${wakeReqId} available=${wake.available} throttled=${wake.throttled} path=${wake.path} durationMs=${wake.durationMs} apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`);
				if (wake.available) {
					const waitStartedAtMs = Date.now();
					const waitTimeoutMs = NODE_WAKE_RECONNECT_WAIT_MS;
					const reconnected = await waitForNodeReconnect({
						nodeId,
						context,
						timeoutMs: waitTimeoutMs
					});
					const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
					context.logGateway.info(`node wake stage=wait1 node=${nodeId} req=${wakeReqId} reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`);
				}
				nodeSession = context.nodeRegistry.get(nodeId);
				if (!nodeSession && wake.available) {
					const retryWake = await maybeWakeNodeWithApns(nodeId, {
						force: true,
						cfg
					});
					context.logGateway.info(`node wake stage=wake2 node=${nodeId} req=${wakeReqId} force=true available=${retryWake.available} throttled=${retryWake.throttled} path=${retryWake.path} durationMs=${retryWake.durationMs} apnsStatus=${retryWake.apnsStatus ?? -1} apnsReason=${retryWake.apnsReason ?? "-"}`);
					if (retryWake.available) {
						const waitStartedAtMs = Date.now();
						const waitTimeoutMs = NODE_WAKE_RECONNECT_RETRY_WAIT_MS;
						const reconnected = await waitForNodeReconnect({
							nodeId,
							context,
							timeoutMs: waitTimeoutMs
						});
						const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
						context.logGateway.info(`node wake stage=wait2 node=${nodeId} req=${wakeReqId} reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`);
					}
					nodeSession = context.nodeRegistry.get(nodeId);
				}
				if (!nodeSession) {
					const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
					const nudge = await maybeSendNodeWakeNudge(nodeId, { cfg });
					context.logGateway.info(`node wake nudge node=${nodeId} req=${wakeReqId} sent=${nudge.sent} throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`);
					context.logGateway.warn(`node wake done node=${nodeId} req=${wakeReqId} connected=false reason=not_connected totalMs=${totalDurationMs}`);
					respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "node not connected", { details: { code: "NOT_CONNECTED" } }));
					return;
				}
				const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
				context.logGateway.info(`node wake done node=${nodeId} req=${wakeReqId} connected=true totalMs=${totalDurationMs}`);
			}
			const allowlist = resolveNodeCommandAllowlist(cfg, {
				...nodeSession,
				approvedCommands: nodeSession.commands
			});
			const allowed = isNodeCommandAllowed({
				command,
				declaredCommands: nodeSession.commands,
				allowlist
			});
			if (!allowed.ok) {
				const hint = buildNodeCommandRejectionHint(allowed.reason, command, nodeSession);
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, hint, { details: {
					reason: allowed.reason,
					command
				} }));
				return;
			}
			const forwardedParams = sanitizeNodeInvokeParamsForForwarding({
				nodeId,
				command,
				rawParams: p.params,
				client,
				execApprovalManager: context.execApprovalManager
			});
			if (!forwardedParams.ok) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, forwardedParams.message, { details: forwardedParams.details ?? null }));
				return;
			}
			const policyResult = await applyPluginNodeInvokePolicy({
				context,
				client,
				nodeSession,
				command,
				params: forwardedParams.params,
				timeoutMs: p.timeoutMs,
				idempotencyKey: p.idempotencyKey
			});
			if (policyResult) {
				if (!policyResult.ok) {
					respond(false, void 0, errorShape(policyResult.unavailable ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST, policyResult.message, { details: {
						...policyResult.details,
						...policyResult.code ? { code: policyResult.code } : {}
					} }));
					return;
				}
				emitTalkPttNodeEvent({
					context,
					nodeId,
					command,
					payload: policyResult.payloadJSON ? safeParseJson(policyResult.payloadJSON) : policyResult.payload
				});
				respond(true, {
					ok: true,
					nodeId,
					command,
					payload: policyResult.payload,
					payloadJSON: policyResult.payloadJSON ?? null
				}, void 0);
				return;
			}
			const res = await context.nodeRegistry.invoke({
				nodeId,
				command,
				params: forwardedParams.params,
				timeoutMs: p.timeoutMs,
				idempotencyKey: p.idempotencyKey
			});
			if (!res.ok) {
				if (shouldQueueAsPendingForegroundAction({
					platform: nodeSession.platform,
					command,
					error: res.error
				})) {
					const queued = enqueuePendingNodeAction({
						nodeId,
						command,
						paramsJSON: toPendingParamsJSON(forwardedParams.params),
						idempotencyKey: p.idempotencyKey
					});
					const wake = await maybeWakeNodeWithApns(nodeId, { cfg });
					context.logGateway.info(`node pending queued node=${nodeId} req=${req.id} command=${command} queuedId=${queued.id} wakePath=${wake.path} wakeAvailable=${wake.available}`);
					respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "node command queued until iOS returns to foreground", {
						retryable: true,
						details: {
							code: "QUEUED_UNTIL_FOREGROUND",
							queuedActionId: queued.id,
							nodeId,
							command,
							wake: {
								path: wake.path,
								available: wake.available,
								throttled: wake.throttled,
								apnsStatus: wake.apnsStatus,
								apnsReason: wake.apnsReason
							},
							nodeError: res.error ?? null
						}
					}));
					return;
				}
				if (!respondUnavailableOnNodeInvokeError(respond, res)) return;
				return;
			}
			const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
			emitTalkPttNodeEvent({
				context,
				nodeId,
				command,
				payload
			});
			respond(true, {
				ok: true,
				nodeId,
				command,
				payload,
				payloadJSON: res.payloadJSON ?? null
			}, void 0);
		});
	},
	"node.invoke.result": handleNodeInvokeResult,
	"node.event": async ({ params, respond, context, client }) => {
		if (!validateNodeEventParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.event",
				validator: validateNodeEventParams
			});
			return;
		}
		const p = params;
		const payloadJSON = typeof p.payloadJSON === "string" ? p.payloadJSON : p.payload !== void 0 ? JSON.stringify(p.payload) : null;
		await respondUnavailableOnThrow(respond, async () => {
			const { handleNodeEvent } = await import("./server-node-events-qH45974y.js");
			const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id ?? "node";
			respond(true, await handleNodeEvent({
				deps: context.deps,
				broadcast: context.broadcast,
				nodeSendToSession: context.nodeSendToSession,
				nodeSubscribe: context.nodeSubscribe,
				nodeUnsubscribe: context.nodeUnsubscribe,
				broadcastVoiceWakeChanged: context.broadcastVoiceWakeChanged,
				addChatRun: context.addChatRun,
				removeChatRun: context.removeChatRun,
				chatAbortControllers: context.chatAbortControllers,
				chatAbortedRuns: context.chatAbortedRuns,
				chatRunBuffers: context.chatRunBuffers,
				chatDeltaSentAt: context.chatDeltaSentAt,
				dedupe: context.dedupe,
				agentRunSeq: context.agentRunSeq,
				getHealthCache: context.getHealthCache,
				refreshHealthSnapshot: context.refreshHealthSnapshot,
				loadGatewayModelCatalog: context.loadGatewayModelCatalog,
				authorizeNodeSystemRunEvent: (eventParams) => context.nodeRegistry.authorizeSystemRunEvent({
					nodeId: eventParams.nodeId,
					connId: eventParams.connId,
					runId: eventParams.runId,
					sessionKey: eventParams.sessionKey,
					terminal: eventParams.terminal
				}),
				logGateway: { warn: context.logGateway.warn }
			}, nodeId, {
				event: p.event,
				payloadJSON
			}, {
				connId: client?.connId,
				deviceId: client?.connect?.device?.id
			}) ?? { ok: true }, void 0);
		});
	}
};
function buildNodeCommandRejectionHint(reason, command, node) {
	const platform = node?.platform ?? "unknown";
	if (reason === "command not declared by node") return `node command not allowed: the node (platform: ${platform}) does not support "${command}"`;
	if (reason === "command not allowlisted") {
		if (command.startsWith("talk.")) return `node command not allowed: "${command}" requires a trusted Talk-capable node`;
		return `node command not allowed: "${command}" is not in the allowlist for platform "${platform}"`;
	}
	if (reason === "node did not declare commands") return `node command not allowed: the node did not declare any supported commands`;
	return `node command not allowed: ${reason}`;
}
//#endregion
//#region src/gateway/server-methods/nodes-pending.ts
function resolveClientNodeId(client) {
	const trimmed = (client?.connect?.device?.id ?? client?.connect?.client?.id ?? "").trim();
	return trimmed.length > 0 ? trimmed : null;
}
const nodePendingHandlers = {
	"node.pending.drain": async ({ params, respond, client }) => {
		if (!validateNodePendingDrainParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pending.drain",
				validator: validateNodePendingDrainParams
			});
			return;
		}
		const nodeId = resolveClientNodeId(client);
		if (!nodeId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "node.pending.drain requires a connected device identity"));
			return;
		}
		respond(true, {
			nodeId,
			...drainNodePendingWork(nodeId, {
				maxItems: params.maxItems,
				includeDefaultStatus: true
			})
		}, void 0);
	},
	"node.pending.enqueue": async ({ params, respond, context }) => {
		if (!validateNodePendingEnqueueParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pending.enqueue",
				validator: validateNodePendingEnqueueParams
			});
			return;
		}
		const p = params;
		await respondUnavailableOnThrow(respond, async () => {
			const queued = enqueueNodePendingWork({
				nodeId: p.nodeId,
				type: p.type,
				priority: p.priority,
				expiresInMs: p.expiresInMs
			});
			let wakeTriggered = false;
			if (p.wake !== false && !queued.deduped && !context.nodeRegistry.get(p.nodeId)) {
				const wakeReqId = queued.item.id;
				context.logGateway.info(`node pending wake start node=${p.nodeId} req=${wakeReqId} type=${queued.item.type}`);
				const cfg = context.getRuntimeConfig();
				const wake = await maybeWakeNodeWithApns(p.nodeId, {
					wakeReason: "node.pending",
					cfg
				});
				context.logGateway.info(`node pending wake stage=wake1 node=${p.nodeId} req=${wakeReqId} available=${wake.available} throttled=${wake.throttled} path=${wake.path} durationMs=${wake.durationMs} apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`);
				wakeTriggered = wake.available;
				if (wake.available) {
					const reconnected = await waitForNodeReconnect({
						nodeId: p.nodeId,
						context,
						timeoutMs: NODE_WAKE_RECONNECT_WAIT_MS
					});
					context.logGateway.info(`node pending wake stage=wait1 node=${p.nodeId} req=${wakeReqId} reconnected=${reconnected} timeoutMs=${NODE_WAKE_RECONNECT_WAIT_MS}`);
				}
				if (!context.nodeRegistry.get(p.nodeId) && wake.available) {
					const retryWake = await maybeWakeNodeWithApns(p.nodeId, {
						force: true,
						wakeReason: "node.pending",
						cfg
					});
					context.logGateway.info(`node pending wake stage=wake2 node=${p.nodeId} req=${wakeReqId} force=true available=${retryWake.available} throttled=${retryWake.throttled} path=${retryWake.path} durationMs=${retryWake.durationMs} apnsStatus=${retryWake.apnsStatus ?? -1} apnsReason=${retryWake.apnsReason ?? "-"}`);
					if (retryWake.available) {
						const reconnected = await waitForNodeReconnect({
							nodeId: p.nodeId,
							context,
							timeoutMs: NODE_WAKE_RECONNECT_RETRY_WAIT_MS
						});
						context.logGateway.info(`node pending wake stage=wait2 node=${p.nodeId} req=${wakeReqId} reconnected=${reconnected} timeoutMs=${NODE_WAKE_RECONNECT_RETRY_WAIT_MS}`);
					}
				}
				if (!context.nodeRegistry.get(p.nodeId)) {
					const nudge = await maybeSendNodeWakeNudge(p.nodeId, { cfg });
					context.logGateway.info(`node pending wake nudge node=${p.nodeId} req=${wakeReqId} sent=${nudge.sent} throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`);
					context.logGateway.warn(`node pending wake done node=${p.nodeId} req=${wakeReqId} connected=false reason=not_connected`);
				} else context.logGateway.info(`node pending wake done node=${p.nodeId} req=${wakeReqId} connected=true`);
			}
			respond(true, {
				nodeId: p.nodeId,
				revision: queued.revision,
				queued: queued.item,
				wakeTriggered
			}, void 0);
		});
	}
};
//#endregion
//#region src/gateway/server-methods/plugin-host-hooks.ts
const log = createSubsystemLogger("gateway/plugin-host-hooks");
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function formatSessionActionPayloadSchemaErrors(errors) {
	return errors.map((error) => error.text).join("; ");
}
function validatePluginSessionActionJsonFields(result) {
	for (const field of [
		"result",
		"reply",
		"details"
	]) if (result[field] !== void 0 && !isPluginJsonValue(result[field])) return `plugin session action ${field} must be JSON-compatible`;
}
const pluginHostHookHandlers = {
	"plugins.uiDescriptors": ({ params, respond }) => {
		if (!validatePluginsUiDescriptorsParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid plugins.uiDescriptors params: ${formatValidationErrors(validatePluginsUiDescriptorsParams.errors)}`));
			return;
		}
		respond(true, {
			ok: true,
			descriptors: (getActivePluginRegistry()?.controlUiDescriptors ?? []).map((entry) => Object.assign({}, entry.descriptor, {
				pluginId: entry.pluginId,
				pluginName: entry.pluginName
			}))
		}, void 0);
	},
	"plugins.sessionAction": async ({ params, client, respond }) => {
		if (!validatePluginsSessionActionParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid plugins.sessionAction params: ${formatValidationErrors(validatePluginsSessionActionParams.errors)}`));
			return;
		}
		const pluginId = normalizeOptionalString$1(params.pluginId);
		const actionId = normalizeOptionalString$1(params.actionId);
		const sessionKey = normalizeOptionalString$1(params.sessionKey);
		if (!pluginId || !actionId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "plugins.sessionAction pluginId and actionId must be non-empty"));
			return;
		}
		const registry = getActivePluginRegistry();
		const pluginLoaded = Boolean(registry?.plugins.some((plugin) => plugin.id === pluginId && plugin.status === "loaded"));
		const registration = (registry?.sessionActions ?? []).find((entry) => entry.pluginId === pluginId && entry.action.id === actionId);
		if (!registration || !pluginLoaded) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `unknown plugin session action: ${pluginId}/${actionId}`));
			return;
		}
		const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
		const hasAdmin = scopes.includes(ADMIN_SCOPE$1);
		const missingScope = (registration.action.requiredScopes && registration.action.requiredScopes.length > 0 ? registration.action.requiredScopes : [WRITE_SCOPE]).find((scope) => !hasAdmin && !scopes.includes(scope) && !(scope === "operator.read" && scopes.includes("operator.write")));
		if (missingScope) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${missingScope}`));
			return;
		}
		try {
			if (params.payload !== void 0 && !isPluginJsonValue(params.payload)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "plugin session action payload must be JSON-compatible"));
				return;
			}
			if (registration.action.schema !== void 0) {
				if (typeof registration.action.schema !== "boolean" && !isRecord(registration.action.schema)) {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "plugin session action schema must be an object or boolean"));
					return;
				}
				const validation = validateJsonSchemaValue({
					schema: registration.action.schema,
					cacheKey: `plugin-session-action:${pluginId}:${actionId}`,
					value: params.payload
				});
				if (!validation.ok) {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `plugin session action payload does not match schema: ${formatSessionActionPayloadSchemaErrors(validation.errors)}`));
					return;
				}
			}
			const result = await registration.action.handler({
				pluginId,
				actionId,
				...sessionKey ? { sessionKey } : {},
				...params.payload !== void 0 ? { payload: params.payload } : {},
				client: {
					...client?.connId ? { connId: client.connId } : {},
					scopes: [...scopes]
				}
			});
			if (result !== void 0 && !isRecord(result)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "plugin session action result must be an object"));
				return;
			}
			const wireResult = result?.ok === false ? result : {
				ok: true,
				...result
			};
			if (!validatePluginsSessionActionResult(wireResult)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid plugin session action result: ${formatValidationErrors(validatePluginsSessionActionResult.errors)}`));
				return;
			}
			const jsonFieldError = result ? validatePluginSessionActionJsonFields(result) : void 0;
			if (jsonFieldError) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, jsonFieldError));
				return;
			}
			if (!wireResult.ok) {
				respond(true, {
					ok: false,
					error: wireResult.error,
					...wireResult.code !== void 0 ? { code: wireResult.code } : {},
					...wireResult.details !== void 0 ? { details: wireResult.details } : {}
				}, void 0);
				return;
			}
			respond(true, {
				ok: true,
				...wireResult.result !== void 0 ? { result: wireResult.result } : {},
				...wireResult.continueAgent !== void 0 ? { continueAgent: wireResult.continueAgent } : {},
				...wireResult.reply !== void 0 ? { reply: wireResult.reply } : {}
			});
		} catch (error) {
			log.warn(`plugin session action failed plugin=${pluginId} action=${actionId}: ${formatErrorMessage(error)}`);
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "plugin session action failed"));
		}
	}
};
//#endregion
//#region src/infra/push-web.ts
const WEB_PUSH_STATE_FILENAME = "push/web-push-subscriptions.json";
const VAPID_KEYS_FILENAME = "push/vapid-keys.json";
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;
const DEFAULT_VAPID_SUBJECT = "https://openclaw.ai";
const withLock$1 = createAsyncLock();
let webPushRuntimePromise;
async function loadWebPushRuntime() {
	webPushRuntimePromise ??= import("web-push").then((mod) => mod.default ?? mod);
	return await webPushRuntimePromise;
}
function resolveWebPushStatePath(baseDir) {
	const root = baseDir ?? resolveStateDir();
	return path.join(root, WEB_PUSH_STATE_FILENAME);
}
function resolveVapidKeysPath(baseDir) {
	const root = baseDir ?? resolveStateDir();
	return path.join(root, VAPID_KEYS_FILENAME);
}
function hashEndpoint(endpoint) {
	return createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
}
function isValidEndpoint(endpoint) {
	if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
	try {
		return new URL(endpoint).protocol === "https:";
	} catch {
		return false;
	}
}
function isValidKey(key) {
	return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH;
}
async function loadState(baseDir) {
	return await tryReadJson(resolveWebPushStatePath(baseDir)) ?? { subscriptionsByEndpointHash: {} };
}
async function persistState(state, baseDir) {
	await writeJson(resolveWebPushStatePath(baseDir), state, { trailingNewline: true });
}
async function resolveVapidKeys(baseDir) {
	const envPublic = resolveVapidPublicKeyFromEnv();
	const envPrivate = resolveVapidPrivateKeyFromEnv();
	if (envPublic && envPrivate) return {
		publicKey: envPublic,
		privateKey: envPrivate,
		subject: resolveVapidSubjectFromEnv()
	};
	return await withLock$1(async () => {
		const filePath = resolveVapidKeysPath(baseDir);
		const existing = await tryReadJson(filePath);
		if (existing?.publicKey && existing?.privateKey) return {
			publicKey: existing.publicKey,
			privateKey: existing.privateKey,
			subject: resolveVapidSubjectFromEnv()
		};
		const keys = (await loadWebPushRuntime()).generateVAPIDKeys();
		const pair = {
			publicKey: keys.publicKey,
			privateKey: keys.privateKey,
			subject: resolveVapidSubjectFromEnv()
		};
		await writeJson(filePath, pair, { trailingNewline: true });
		return pair;
	});
}
function resolveVapidSubjectFromEnv() {
	return process.env.OPENCLAW_VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;
}
function resolveVapidPublicKeyFromEnv() {
	return process.env.OPENCLAW_VAPID_PUBLIC_KEY || void 0;
}
function resolveVapidPrivateKeyFromEnv() {
	return process.env.OPENCLAW_VAPID_PRIVATE_KEY || void 0;
}
async function registerWebPushSubscription(params) {
	const { endpoint, keys, baseDir } = params;
	if (!isValidEndpoint(endpoint)) throw new Error("invalid push subscription endpoint: must be an HTTPS URL under 2048 chars");
	if (!isValidKey(keys.p256dh) || !isValidKey(keys.auth)) throw new Error("invalid push subscription keys: must be non-empty strings under 512 chars");
	return await withLock$1(async () => {
		const state = await loadState(baseDir);
		const hash = hashEndpoint(endpoint);
		const now = Date.now();
		const existing = state.subscriptionsByEndpointHash[hash];
		const subscription = {
			subscriptionId: existing?.subscriptionId ?? randomUUID(),
			endpoint,
			keys: {
				p256dh: keys.p256dh,
				auth: keys.auth
			},
			createdAtMs: existing?.createdAtMs ?? now,
			updatedAtMs: now
		};
		state.subscriptionsByEndpointHash[hash] = subscription;
		await persistState(state, baseDir);
		return subscription;
	});
}
async function listWebPushSubscriptions(baseDir) {
	const state = await loadState(baseDir);
	return Object.values(state.subscriptionsByEndpointHash);
}
async function clearWebPushSubscriptionByEndpoint(endpoint, baseDir) {
	return await withLock$1(async () => {
		const state = await loadState(baseDir);
		const hash = hashEndpoint(endpoint);
		if (state.subscriptionsByEndpointHash[hash]) {
			delete state.subscriptionsByEndpointHash[hash];
			await persistState(state, baseDir);
			return true;
		}
		return false;
	});
}
function applyVapidDetails(webPush, keys) {
	webPush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
}
async function sendPreparedWebPushNotification(webPush, subscription, payload) {
	const pushSubscription = {
		endpoint: subscription.endpoint,
		keys: {
			p256dh: subscription.keys.p256dh,
			auth: subscription.keys.auth
		}
	};
	try {
		const result = await webPush.sendNotification(pushSubscription, JSON.stringify(payload));
		return {
			ok: true,
			subscriptionId: subscription.subscriptionId,
			statusCode: result.statusCode
		};
	} catch (err) {
		const statusCode = typeof err === "object" && err !== null && "statusCode" in err ? err.statusCode : void 0;
		const message = typeof err === "object" && err !== null && "message" in err ? err.message : "unknown error";
		return {
			ok: false,
			subscriptionId: subscription.subscriptionId,
			statusCode,
			error: message
		};
	}
}
async function broadcastWebPush(payload, baseDir) {
	const subscriptions = await listWebPushSubscriptions(baseDir);
	if (subscriptions.length === 0) return [];
	const vapidKeys = await resolveVapidKeys(baseDir);
	const webPush = await loadWebPushRuntime();
	applyVapidDetails(webPush, vapidKeys);
	const mapped = (await Promise.allSettled(subscriptions.map((sub) => sendPreparedWebPushNotification(webPush, sub, payload)))).map((r, i) => r.status === "fulfilled" ? r.value : {
		ok: false,
		subscriptionId: subscriptions[i].subscriptionId,
		error: r.reason instanceof Error ? r.reason.message : "unknown error"
	});
	const expiredEndpoints = mapped.map((result, i) => ({
		result,
		sub: subscriptions[i]
	})).filter(({ result }) => !result.ok && (result.statusCode === 410 || result.statusCode === 404)).map(({ sub }) => sub.endpoint);
	if (expiredEndpoints.length > 0) await Promise.allSettled(expiredEndpoints.map((endpoint) => clearWebPushSubscriptionByEndpoint(endpoint, baseDir)));
	return mapped;
}
//#endregion
//#region src/gateway/server-methods/push.ts
const pushHandlers = {
	"push.test": async ({ params, respond, context }) => {
		if (!validatePushTestParams(params)) {
			respondInvalidParams({
				respond,
				method: "push.test",
				validator: validatePushTestParams
			});
			return;
		}
		const nodeId = normalizeStringifiedOptionalString(params.nodeId) ?? "";
		if (!nodeId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
			return;
		}
		const title = normalizeTrimmedString(params.title) ?? "OpenClaw";
		const body = normalizeTrimmedString(params.body) ?? `Push test for node ${nodeId}`;
		await respondUnavailableOnThrow(respond, async () => {
			const registration = await loadApnsRegistration(nodeId);
			if (!registration) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `node ${nodeId} has no APNs registration (connect iOS node first)`));
				return;
			}
			const overrideEnvironment = normalizeApnsEnvironment(params.environment);
			const result = registration.transport === "direct" ? await (async () => {
				const auth = await resolveApnsAuthConfigFromEnv(process.env);
				if (!auth.ok) {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, auth.error));
					return null;
				}
				return await sendApnsAlert({
					registration: {
						...registration,
						environment: overrideEnvironment ?? registration.environment
					},
					nodeId,
					title,
					body,
					auth: auth.value
				});
			})() : await (async () => {
				const relay = resolveApnsRelayConfigFromEnv(process.env, context.getRuntimeConfig().gateway);
				if (!relay.ok) {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, relay.error));
					return null;
				}
				return await sendApnsAlert({
					registration,
					nodeId,
					title,
					body,
					relayConfig: relay.value
				});
			})();
			if (!result) return;
			if (shouldClearStoredApnsRegistration({
				registration,
				result,
				overrideEnvironment
			})) await clearApnsRegistrationIfCurrent({
				nodeId,
				registration
			});
			respond(true, result, void 0);
		});
	},
	"push.web.vapidPublicKey": async ({ params, respond }) => {
		if (!validateWebPushVapidPublicKeyParams(params)) {
			respondInvalidParams({
				respond,
				method: "push.web.vapidPublicKey",
				validator: validateWebPushVapidPublicKeyParams
			});
			return;
		}
		await respondUnavailableOnThrow(respond, async () => {
			respond(true, { vapidPublicKey: (await resolveVapidKeys()).publicKey }, void 0);
		});
	},
	"push.web.subscribe": async ({ params, respond }) => {
		if (!validateWebPushSubscribeParams(params)) {
			respondInvalidParams({
				respond,
				method: "push.web.subscribe",
				validator: validateWebPushSubscribeParams
			});
			return;
		}
		await respondUnavailableOnThrow(respond, async () => {
			respond(true, { subscriptionId: (await registerWebPushSubscription({
				endpoint: params.endpoint,
				keys: params.keys
			})).subscriptionId }, void 0);
		});
	},
	"push.web.unsubscribe": async ({ params, respond }) => {
		if (!validateWebPushUnsubscribeParams(params)) {
			respondInvalidParams({
				respond,
				method: "push.web.unsubscribe",
				validator: validateWebPushUnsubscribeParams
			});
			return;
		}
		await respondUnavailableOnThrow(respond, async () => {
			respond(true, { removed: await clearWebPushSubscriptionByEndpoint(params.endpoint) }, void 0);
		});
	},
	"push.web.test": async ({ params, respond }) => {
		if (!validateWebPushTestParams(params)) {
			respondInvalidParams({
				respond,
				method: "push.web.test",
				validator: validateWebPushTestParams
			});
			return;
		}
		const title = normalizeTrimmedString(params.title) ?? "OpenClaw";
		const body = normalizeTrimmedString(params.body) ?? "Web push test notification";
		await respondUnavailableOnThrow(respond, async () => {
			const results = await broadcastWebPush({
				title,
				body
			});
			if (results.length === 0) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "no web push subscriptions registered"));
				return;
			}
			respond(true, { results }, void 0);
		});
	}
};
//#endregion
//#region src/infra/restart-coordinator.ts
const defaultInspectors = {
	getQueueSize: getTotalQueueSize,
	getPendingReplies: getTotalPendingReplies,
	getEmbeddedRuns: getActiveEmbeddedRunCount,
	getActiveTasks: () => getInspectableActiveTaskRestartBlockers().length,
	getTaskBlockers: getInspectableActiveTaskRestartBlockers
};
function normalizeCount(value) {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
function formatTaskBlocker(task) {
	return [
		`taskId=${task.taskId}`,
		task.runId ? `runId=${task.runId}` : null,
		`status=${task.status}`,
		`runtime=${task.runtime}`,
		task.label ? `label=${task.label}` : null,
		task.title ? `title=${task.title.slice(0, 80)}` : null
	].filter((value) => Boolean(value)).join(" ");
}
function createFallbackTaskBlocker(count) {
	return {
		kind: "task",
		count,
		message: `${count} active background task run(s)`
	};
}
function createSafeGatewayRestartPreflight(inspectors = {}) {
	const resolved = {
		...defaultInspectors,
		...inspectors
	};
	const counts = {
		queueSize: normalizeCount(resolved.getQueueSize()),
		pendingReplies: normalizeCount(resolved.getPendingReplies()),
		embeddedRuns: normalizeCount(resolved.getEmbeddedRuns()),
		activeTasks: normalizeCount(resolved.getActiveTasks()),
		totalActive: 0
	};
	counts.totalActive = counts.queueSize + counts.pendingReplies + counts.embeddedRuns + counts.activeTasks;
	const blockers = [];
	if (counts.queueSize > 0) blockers.push({
		kind: "queue",
		count: counts.queueSize,
		message: `${counts.queueSize} queued or active operation(s)`
	});
	if (counts.pendingReplies > 0) blockers.push({
		kind: "reply",
		count: counts.pendingReplies,
		message: `${counts.pendingReplies} pending reply delivery operation(s)`
	});
	if (counts.embeddedRuns > 0) blockers.push({
		kind: "embedded-run",
		count: counts.embeddedRuns,
		message: `${counts.embeddedRuns} active embedded run(s)`
	});
	if (counts.activeTasks > 0) {
		const taskBlockers = resolved.getTaskBlockers();
		if (taskBlockers.length === 0) blockers.push(createFallbackTaskBlocker(counts.activeTasks));
		else {
			for (const task of taskBlockers.slice(0, 8)) blockers.push({
				kind: "task",
				count: 1,
				message: formatTaskBlocker(task),
				task
			});
			const omitted = counts.activeTasks - taskBlockers.length;
			if (omitted > 0) blockers.push(createFallbackTaskBlocker(omitted));
		}
	}
	const summary = blockers.length === 0 ? "safe to restart now" : `restart deferred: ${blockers.map((blocker) => blocker.message).join("; ")}`;
	return {
		safe: counts.totalActive === 0,
		counts,
		blockers,
		summary
	};
}
function requestSafeGatewayRestart(opts = {}) {
	const preflight = createSafeGatewayRestartPreflight(opts.inspect);
	const skipDeferral = opts.skipDeferral === true;
	const restart = scheduleGatewaySigusr1Restart({
		delayMs: opts.delayMs ?? 0,
		reason: opts.reason ?? "gateway.restart.safe",
		...skipDeferral ? { skipDeferral: true } : {}
	});
	return {
		ok: true,
		status: restart.coalesced ? "coalesced" : skipDeferral || preflight.safe ? "scheduled" : "deferred",
		preflight,
		restart
	};
}
//#endregion
//#region src/gateway/server-methods/restart.ts
function normalizeReason(value) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : void 0;
}
function normalizeSkipDeferral(value) {
	return value === true;
}
const restartHandlers = {
	"gateway.restart.request": async ({ respond, params }) => {
		respond(true, requestSafeGatewayRestart({
			reason: normalizeReason(params.reason),
			delayMs: 0,
			skipDeferral: normalizeSkipDeferral(params.skipDeferral)
		}));
	},
	"gateway.restart.preflight": async ({ respond }) => {
		respond(true, createSafeGatewayRestartPreflight());
	}
};
//#endregion
//#region src/infra/outbound/source-reply-mirror.ts
function readStringArray(value) {
	if (!Array.isArray(value)) return;
	const normalized = value.map((entry) => normalizeOptionalString$1(entry)).filter((entry) => Boolean(entry));
	return normalized.length ? normalized : void 0;
}
function readFirstString(params, keys) {
	for (const key of keys) {
		const value = normalizeOptionalString$1(params[key]);
		if (value) return value;
	}
}
function resolveSourceReplyTarget(params) {
	return readFirstString(params, [
		"target",
		"to",
		"channelId",
		"chatId"
	]);
}
function resolveSourceReplyThreadId(params) {
	return readFirstString(params.actionParams, ["threadId", "messageThreadId"]);
}
function resolveThreadedSourceTarget(params, requestedTarget) {
	const threadId = resolveSourceReplyThreadId(params);
	if (!threadId) return requestedTarget;
	return normalizeOptionalString$1(getChannelPlugin(params.channel)?.threading?.resolveCurrentChannelId?.({
		to: requestedTarget,
		threadId
	})) ?? requestedTarget;
}
function hasExplicitDeliveryFailure(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
	const record = payload;
	if (record.ok === false) return true;
	const status = normalizeOptionalLowercaseString(record.status);
	if (status === "failed" || status === "error") return true;
	const deliveryStatus = normalizeOptionalLowercaseString(record.deliveryStatus);
	return deliveryStatus === "failed" || deliveryStatus === "error";
}
function isCurrentSourceConversation(params) {
	if (params.action !== "send") return false;
	if (!params.sessionKey?.trim()) return false;
	const currentChannel = normalizeOptionalLowercaseString(params.toolContext?.currentChannelProvider);
	if (!currentChannel || currentChannel !== normalizeOptionalLowercaseString(params.channel)) return false;
	const currentTarget = normalizeOptionalString$1(params.toolContext?.currentChannelId);
	if (!currentTarget) return false;
	const requestedTarget = resolveSourceReplyTarget(params.actionParams);
	if (!requestedTarget) return false;
	return requestedTarget === currentTarget || resolveThreadedSourceTarget(params, requestedTarget) === currentTarget;
}
async function mirrorDeliveredSourceReplyToTranscript(params) {
	if (hasExplicitDeliveryFailure(params.deliveredPayload)) return false;
	if (!isCurrentSourceConversation(params)) return false;
	const mirror = projectOutboundPayloadPlanForMirror(createOutboundPayloadPlan([{
		text: readFirstString(params.actionParams, [
			"message",
			"content",
			"text",
			"caption"
		]) ?? "",
		mediaUrl: readFirstString(params.actionParams, [
			"mediaUrl",
			"media",
			"path",
			"filePath",
			"fileUrl"
		]),
		mediaUrls: readStringArray(params.actionParams.mediaUrls),
		presentation: params.actionParams.presentation,
		interactive: params.actionParams.interactive,
		channelData: params.actionParams.channelData
	}]));
	if (!mirror.text && mirror.mediaUrls.length === 0) return false;
	await appendAssistantMessageToSessionTranscript({
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		text: mirror.text,
		mediaUrls: mirror.mediaUrls.length ? mirror.mediaUrls : void 0,
		idempotencyKey: params.idempotencyKey,
		config: params.cfg
	});
	return true;
}
//#endregion
//#region src/gateway/server-methods/send.ts
const inflightByContext = /* @__PURE__ */ new WeakMap();
const getInflightMap = (context) => {
	let inflight = inflightByContext.get(context);
	if (!inflight) {
		inflight = /* @__PURE__ */ new Map();
		inflightByContext.set(context, inflight);
	}
	return inflight;
};
function resolveGatewayInflightMap(params) {
	const cached = params.context.dedupe.get(params.dedupeKey);
	if (cached) return {
		kind: "cached",
		cached
	};
	const inflightMap = getInflightMap(params.context);
	const inflight = inflightMap.get(params.dedupeKey);
	if (inflight) return {
		kind: "inflight",
		inflight
	};
	return {
		kind: "ready",
		inflightMap
	};
}
async function runGatewayInflightWork(params) {
	params.inflightMap.set(params.dedupeKey, params.work);
	try {
		const result = await params.work;
		params.respond(result.ok, result.payload, result.error, result.meta);
	} finally {
		params.inflightMap.delete(params.dedupeKey);
	}
}
async function resolveRequestedChannel(params) {
	const channelInput = readStringValue(params.requestChannel);
	const normalizedChannel = channelInput ? normalizeChannelId(channelInput) : null;
	if (channelInput && !normalizedChannel) {
		const normalizedInput = normalizeOptionalLowercaseString(channelInput) ?? "";
		if (params.rejectWebchatAsInternalOnly && normalizedInput === "webchat") return { error: errorShape(ErrorCodes.INVALID_REQUEST, "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.") };
		return { error: errorShape(ErrorCodes.INVALID_REQUEST, params.unsupportedMessage(channelInput)) };
	}
	const cfg = applyPluginAutoEnable({
		config: params.context.getRuntimeConfig(),
		env: process.env
	}).config;
	let channel = normalizedChannel;
	if (!channel) try {
		channel = (await resolveMessageChannelSelection({ cfg })).channel;
	} catch (err) {
		return { error: errorShape(ErrorCodes.INVALID_REQUEST, String(err)) };
	}
	return {
		cfg,
		channel
	};
}
function resolveGatewayOutboundTarget(params) {
	const resolved = resolveOutboundTarget({
		channel: params.channel,
		to: params.to,
		cfg: params.cfg,
		accountId: params.accountId,
		mode: "explicit"
	});
	if (!resolved.ok) return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error))
	};
	return {
		ok: true,
		to: resolved.to
	};
}
function buildGatewayDeliveryPayload(params) {
	const payload = {
		runId: params.runId,
		messageId: params.result.messageId,
		channel: params.channel
	};
	if ("chatId" in params.result) payload.chatId = params.result.chatId;
	if ("channelId" in params.result) payload.channelId = params.result.channelId;
	if ("toJid" in params.result) payload.toJid = params.result.toJid;
	if ("conversationId" in params.result) payload.conversationId = params.result.conversationId;
	if ("pollId" in params.result) payload.pollId = params.result.pollId;
	return payload;
}
function cacheGatewayDedupeSuccess(params) {
	params.context.dedupe.set(params.dedupeKey, {
		ts: Date.now(),
		ok: true,
		payload: params.payload
	});
}
function cacheGatewayDedupeFailure(params) {
	params.context.dedupe.set(params.dedupeKey, {
		ts: Date.now(),
		ok: false,
		error: params.error
	});
}
function createGatewayInflightSuccess(params) {
	cacheGatewayDedupeSuccess({
		context: params.context,
		dedupeKey: params.dedupeKey,
		payload: params.payload
	});
	return {
		ok: true,
		payload: params.payload,
		meta: { channel: params.channel }
	};
}
function createGatewayInflightUnavailableFailure(params) {
	const error = errorShape(ErrorCodes.UNAVAILABLE, String(params.err));
	cacheGatewayDedupeFailure({
		context: params.context,
		dedupeKey: params.dedupeKey,
		error
	});
	return {
		ok: false,
		error,
		meta: {
			channel: params.channel,
			error: formatForLog(params.err)
		}
	};
}
async function mirrorDeliveredSourceReplyToTranscriptBestEffort(params) {
	try {
		await mirrorDeliveredSourceReplyToTranscript(params.mirror);
	} catch (err) {
		params.context.logGateway?.warn?.("Source reply transcript mirror failed after delivery.", {
			error: formatForLog(err),
			channel: params.mirror.channel,
			sessionKey: params.mirror.sessionKey
		});
	}
}
const sendHandlers = {
	"message.action": async ({ params, respond, context, client }) => {
		const p = params;
		if (!validateMessageActionParams(p)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid message.action params: ${formatValidationErrors(validateMessageActionParams.errors)}`));
			return;
		}
		const request = p;
		const dedupeKey = `message.action:${request.idempotencyKey}`;
		const inflight = resolveGatewayInflightMap({
			context,
			dedupeKey
		});
		if (inflight.kind === "cached") {
			respond(inflight.cached.ok, inflight.cached.payload, inflight.cached.error, { cached: true });
			return;
		}
		if (inflight.kind === "inflight") {
			const result = await inflight.inflight;
			const meta = result.meta ? {
				...result.meta,
				cached: true
			} : { cached: true };
			respond(result.ok, result.payload, result.error, meta);
			return;
		}
		if (inflight.kind !== "ready") return;
		const inflightMap = inflight.inflightMap;
		await runGatewayInflightWork({
			inflightMap,
			dedupeKey,
			work: (async () => {
				const resolvedChannel = await resolveRequestedChannel({
					requestChannel: request.channel,
					unsupportedMessage: (input) => `unsupported channel: ${input}`,
					context,
					rejectWebchatAsInternalOnly: true
				});
				if ("error" in resolvedChannel) return {
					ok: false,
					error: resolvedChannel.error
				};
				const { cfg, channel } = resolvedChannel;
				if (!resolveOutboundChannelPlugin({
					channel,
					cfg
				})?.actions?.handleAction) return {
					ok: false,
					error: errorShape(ErrorCodes.INVALID_REQUEST, `Channel ${channel} does not support action ${request.action}.`)
				};
				try {
					const gatewayClientScopes = client?.connect?.scopes ?? [];
					const handled = await dispatchChannelMessageAction({
						channel,
						action: request.action,
						cfg,
						params: request.params,
						accountId: normalizeOptionalString$1(request.accountId) ?? void 0,
						requesterSenderId: normalizeOptionalString$1(request.requesterSenderId) ?? void 0,
						senderIsOwner: gatewayClientScopes.includes("operator.admin") ? request.senderIsOwner === true : false,
						sessionKey: normalizeOptionalString$1(request.sessionKey) ?? void 0,
						sessionId: normalizeOptionalString$1(request.sessionId) ?? void 0,
						inboundEventKind: request.inboundTurnKind,
						agentId: normalizeOptionalString$1(request.agentId) ?? void 0,
						mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, normalizeOptionalString$1(request.agentId) ?? void 0),
						toolContext: request.toolContext,
						dryRun: false,
						gatewayClientScopes
					});
					if (!handled) {
						const error = errorShape(ErrorCodes.INVALID_REQUEST, `Message action ${request.action} not supported for channel ${channel}.`);
						cacheGatewayDedupeFailure({
							context,
							dedupeKey,
							error
						});
						return {
							ok: false,
							error,
							meta: { channel }
						};
					}
					const payload = extractToolPayload(handled);
					const sessionKey = normalizeOptionalString$1(request.sessionKey) ?? void 0;
					const agentId = normalizeOptionalString$1(request.agentId) ?? (sessionKey ? resolveSessionAgentId({
						sessionKey,
						config: cfg
					}) : void 0);
					await mirrorDeliveredSourceReplyToTranscriptBestEffort({
						context,
						mirror: {
							action: request.action,
							channel,
							actionParams: request.params,
							cfg,
							sessionKey,
							agentId,
							toolContext: request.toolContext,
							idempotencyKey: request.idempotencyKey,
							deliveredPayload: payload
						}
					});
					return createGatewayInflightSuccess({
						context,
						dedupeKey,
						payload,
						channel
					});
				} catch (err) {
					return createGatewayInflightUnavailableFailure({
						context,
						dedupeKey,
						channel,
						err
					});
				}
			})(),
			respond
		});
	},
	send: async ({ params, respond, context, client }) => {
		const p = params;
		if (!validateSendParams(p)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`));
			return;
		}
		const request = p;
		const idem = request.idempotencyKey;
		const dedupeKey = `send:${idem}`;
		const inflight = resolveGatewayInflightMap({
			context,
			dedupeKey
		});
		if (inflight.kind === "cached") {
			respond(inflight.cached.ok, inflight.cached.payload, inflight.cached.error, { cached: true });
			return;
		}
		if (inflight.kind === "inflight") {
			const result = await inflight.inflight;
			const meta = result.meta ? {
				...result.meta,
				cached: true
			} : { cached: true };
			respond(result.ok, result.payload, result.error, meta);
			return;
		}
		const inflightMap = inflight.inflightMap;
		const to = normalizeOptionalString$1(request.to) ?? "";
		const message = normalizeOptionalString$1(request.message) ?? "";
		const mediaUrl = normalizeOptionalString$1(request.mediaUrl);
		const mediaUrls = Array.isArray(request.mediaUrls) ? request.mediaUrls.map((entry) => normalizeOptionalString$1(entry)).filter((entry) => Boolean(entry)) : void 0;
		if (!message && !mediaUrl && (mediaUrls?.length ?? 0) === 0) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid send params: text or media is required"));
			return;
		}
		const accountId = normalizeOptionalString$1(request.accountId);
		const replyToId = normalizeOptionalString$1(request.replyToId);
		const threadId = normalizeOptionalString$1(request.threadId);
		await runGatewayInflightWork({
			inflightMap,
			dedupeKey,
			work: (async () => {
				const resolvedChannel = await resolveRequestedChannel({
					requestChannel: request.channel,
					unsupportedMessage: (input) => `unsupported channel: ${input}`,
					context,
					rejectWebchatAsInternalOnly: true
				});
				if ("error" in resolvedChannel) return {
					ok: false,
					error: resolvedChannel.error
				};
				const { cfg, channel } = resolvedChannel;
				const outboundChannel = channel;
				if (!resolveOutboundChannelPlugin({
					channel,
					cfg
				})) return {
					ok: false,
					error: errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`)
				};
				try {
					const resolvedTarget = resolveGatewayOutboundTarget({
						channel: outboundChannel,
						to,
						cfg,
						accountId
					});
					if (!resolvedTarget.ok) return {
						ok: false,
						error: resolvedTarget.error,
						meta: { channel }
					};
					const idLikeTarget = await maybeResolveIdLikeTarget({
						cfg,
						channel,
						input: resolvedTarget.to,
						accountId
					});
					const deliveryTarget = idLikeTarget?.to ?? resolvedTarget.to;
					const outboundDeps = context.deps ? createOutboundSendDeps(context.deps) : void 0;
					const outboundPayloads = [{
						text: message,
						mediaUrl,
						mediaUrls,
						...request.asVoice === true ? { audioAsVoice: true } : {}
					}];
					const mirrorProjection = projectOutboundPayloadPlanForMirror(createOutboundPayloadPlan(outboundPayloads));
					const mirrorText = mirrorProjection.text;
					const mirrorMediaUrls = mirrorProjection.mediaUrls;
					const providedSessionKey = normalizeOptionalLowercaseString(request.sessionKey);
					const explicitAgentId = normalizeOptionalString$1(request.agentId);
					const sessionAgentId = providedSessionKey ? resolveSessionAgentId({
						sessionKey: providedSessionKey,
						config: cfg
					}) : void 0;
					const defaultAgentId = resolveSessionAgentId({ config: cfg });
					const effectiveAgentId = explicitAgentId ?? sessionAgentId ?? defaultAgentId;
					const derivedRoute = await resolveOutboundSessionRoute({
						cfg,
						channel,
						agentId: effectiveAgentId,
						accountId,
						target: deliveryTarget,
						currentSessionKey: providedSessionKey,
						resolvedTarget: idLikeTarget,
						replyToId,
						threadId
					});
					const providedSessionBaseKey = parseThreadSessionSuffix(providedSessionKey).baseSessionKey ?? providedSessionKey;
					const shouldUseDerivedThreadSessionKey = channel === "slack" && !!providedSessionKey && !!normalizeOptionalString$1(derivedRoute?.threadId) && normalizeOptionalLowercaseString(derivedRoute?.baseSessionKey) === normalizeOptionalLowercaseString(providedSessionBaseKey) && normalizeOptionalLowercaseString(derivedRoute?.sessionKey) !== providedSessionKey;
					const outboundRoute = derivedRoute ? providedSessionKey ? shouldUseDerivedThreadSessionKey ? {
						...derivedRoute,
						baseSessionKey: derivedRoute.baseSessionKey ?? providedSessionKey
					} : {
						...derivedRoute,
						sessionKey: providedSessionKey,
						baseSessionKey: providedSessionKey
					} : derivedRoute : null;
					if (outboundRoute) await ensureOutboundSessionEntry({
						cfg,
						channel,
						accountId,
						route: outboundRoute
					});
					const outboundSessionKey = outboundRoute?.sessionKey ?? providedSessionKey;
					const outboundSession = buildOutboundSessionContext({
						cfg,
						agentId: effectiveAgentId,
						sessionKey: outboundSessionKey,
						conversationType: outboundRoute?.chatType
					});
					const send = await sendDurableMessageBatch({
						cfg,
						channel: outboundChannel,
						to: deliveryTarget,
						accountId,
						payloads: outboundPayloads,
						replyToId: replyToId ?? null,
						session: outboundSession,
						gifPlayback: request.gifPlayback,
						forceDocument: request.forceDocument,
						threadId: outboundRoute?.threadId ?? threadId ?? null,
						deps: outboundDeps,
						gatewayClientScopes: client?.connect?.scopes ?? [],
						silent: request.silent,
						formatting: request.parseMode ? { parseMode: request.parseMode } : void 0,
						mirror: outboundSessionKey ? {
							sessionKey: outboundSessionKey,
							agentId: effectiveAgentId,
							text: mirrorText || message,
							mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : void 0,
							idempotencyKey: idem
						} : void 0
					});
					if (send.status === "failed" || send.status === "partial_failed") throw send.error;
					const result = (send.status === "sent" ? send.results : []).at(-1);
					if (!result) throw new Error("No delivery result");
					return createGatewayInflightSuccess({
						context,
						dedupeKey,
						payload: buildGatewayDeliveryPayload({
							runId: idem,
							channel,
							result
						}),
						channel
					});
				} catch (err) {
					return createGatewayInflightUnavailableFailure({
						context,
						dedupeKey,
						channel,
						err
					});
				}
			})(),
			respond
		});
	},
	poll: async ({ params, respond, context, client }) => {
		const p = params;
		if (!validatePollParams(p)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid poll params: ${formatValidationErrors(validatePollParams.errors)}`));
			return;
		}
		const request = p;
		const idem = request.idempotencyKey;
		const dedupeKey = `poll:${idem}`;
		const inflight = resolveGatewayInflightMap({
			context,
			dedupeKey
		});
		if (inflight.kind === "cached") {
			respond(inflight.cached.ok, inflight.cached.payload, inflight.cached.error, { cached: true });
			return;
		}
		if (inflight.kind === "inflight") {
			const result = await inflight.inflight;
			const meta = result.meta ? {
				...result.meta,
				cached: true
			} : { cached: true };
			respond(result.ok, result.payload, result.error, meta);
			return;
		}
		if (inflight.kind !== "ready") return;
		const inflightMap = inflight.inflightMap;
		await runGatewayInflightWork({
			inflightMap,
			dedupeKey,
			work: (async () => {
				const resolvedChannel = await resolveRequestedChannel({
					requestChannel: request.channel,
					unsupportedMessage: (input) => `unsupported poll channel: ${input}`,
					context
				});
				if ("error" in resolvedChannel) return {
					ok: false,
					error: resolvedChannel.error
				};
				const { cfg, channel } = resolvedChannel;
				const outbound = resolveOutboundChannelPlugin({
					channel,
					cfg
				})?.outbound;
				if (typeof request.durationSeconds === "number" && outbound?.supportsPollDurationSeconds !== true) return {
					ok: false,
					error: errorShape(ErrorCodes.INVALID_REQUEST, `durationSeconds is not supported for ${channel} polls`)
				};
				if (typeof request.isAnonymous === "boolean" && outbound?.supportsAnonymousPolls !== true) return {
					ok: false,
					error: errorShape(ErrorCodes.INVALID_REQUEST, `isAnonymous is not supported for ${channel} polls`)
				};
				const poll = {
					question: request.question,
					options: request.options,
					maxSelections: request.maxSelections,
					durationSeconds: request.durationSeconds,
					durationHours: request.durationHours
				};
				const threadId = normalizeOptionalString$1(request.threadId);
				const accountId = normalizeOptionalString$1(request.accountId);
				try {
					if (!outbound?.sendPoll) return {
						ok: false,
						error: errorShape(ErrorCodes.INVALID_REQUEST, `unsupported poll channel: ${channel}`)
					};
					const resolvedTarget = resolveGatewayOutboundTarget({
						channel,
						to: request.to.trim(),
						cfg,
						accountId
					});
					if (!resolvedTarget.ok) return {
						ok: false,
						error: resolvedTarget.error
					};
					const normalized = outbound.pollMaxOptions ? normalizePollInput(poll, { maxOptions: outbound.pollMaxOptions }) : normalizePollInput(poll);
					const payload = buildGatewayDeliveryPayload({
						runId: idem,
						channel,
						result: await outbound.sendPoll({
							cfg,
							to: resolvedTarget.to,
							poll: normalized,
							accountId,
							threadId,
							silent: request.silent,
							isAnonymous: request.isAnonymous,
							gatewayClientScopes: client?.connect?.scopes ?? []
						})
					});
					cacheGatewayDedupeSuccess({
						context,
						dedupeKey,
						payload
					});
					return {
						ok: true,
						payload,
						meta: { channel }
					};
				} catch (err) {
					const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
					cacheGatewayDedupeFailure({
						context,
						dedupeKey,
						error
					});
					return {
						ok: false,
						error,
						meta: {
							channel,
							error: formatForLog(err)
						}
					};
				}
			})(),
			respond
		});
	}
};
//#endregion
//#region src/gateway/server-methods/sessions.ts
function filterSessionStoreToConfiguredAgents(cfg, store) {
	const configuredAgentIds = new Set(listConfiguredSessionStoreAgentIds(cfg));
	const isConfiguredSessionKey = (key) => {
		const normalizedKey = normalizeOptionalString$1(key);
		if (!normalizedKey) return false;
		const agentId = resolveSessionStoreAgentId(cfg, resolveSessionStoreKey({
			cfg,
			sessionKey: normalizedKey
		}));
		return configuredAgentIds.has(normalizeAgentId(agentId));
	};
	return Object.fromEntries(Object.entries(store).filter(([key, entry]) => {
		if (key === "global" || key === "unknown") return true;
		if (isConfiguredSessionKey(key)) return true;
		return isConfiguredSessionKey(entry?.spawnedBy) || isConfiguredSessionKey(entry?.parentSessionKey);
	}));
}
let sessionsRuntimeModulePromise;
let loggedSlowSessionsListCatalog = false;
const SESSIONS_LIST_MODEL_CATALOG_TIMEOUT_MS = 750;
function loadSessionsRuntimeModule() {
	sessionsRuntimeModulePromise ??= import("./sessions.runtime.js");
	return sessionsRuntimeModulePromise;
}
async function loadOptionalSessionsListModelCatalog(context) {
	let timeout;
	const timedOut = Symbol("sessions-list-model-catalog-timeout");
	const timeoutPromise = new Promise((resolve) => {
		timeout = setTimeout(() => resolve(timedOut), SESSIONS_LIST_MODEL_CATALOG_TIMEOUT_MS);
		timeout.unref?.();
	});
	try {
		const result = await Promise.race([context.loadGatewayModelCatalog().catch(() => void 0), timeoutPromise]);
		if (result === timedOut) {
			if (!loggedSlowSessionsListCatalog) {
				loggedSlowSessionsListCatalog = true;
				context.logGateway.debug(`sessions.list continuing without model catalog after ${SESSIONS_LIST_MODEL_CATALOG_TIMEOUT_MS}ms`);
			}
			return;
		}
		return Array.isArray(result) ? result : void 0;
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
function requireSessionKey(key, respond) {
	const normalized = normalizeOptionalString$1(typeof key === "string" ? key : typeof key === "number" ? String(key) : typeof key === "bigint" ? String(key) : "") ?? "";
	if (!normalized) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
		return null;
	}
	return normalized;
}
function rejectPluginRuntimeDeleteMismatch(params) {
	const pluginOwnerId = normalizeOptionalString$1(params.client?.internal?.pluginRuntimeOwnerId);
	if (!pluginOwnerId || !params.entry) return false;
	if (normalizeOptionalString$1(params.entry.pluginOwnerId) === pluginOwnerId) return false;
	params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `Plugin "${pluginOwnerId}" cannot delete session "${params.key}" because it did not create it.`));
	return true;
}
function resolveGatewaySessionTargetFromKey(key, cfg) {
	const target = resolveGatewaySessionStoreTarget({
		cfg,
		key
	});
	return {
		cfg,
		target,
		storePath: target.storePath
	};
}
function resolveOptionalInitialSessionMessage(params) {
	if (typeof params.task === "string" && params.task.trim()) return params.task;
	if (typeof params.message === "string" && params.message.trim()) return params.message;
}
function shouldAttachPendingMessageSeq(params) {
	if (params.cached) return false;
	return (params.payload && typeof params.payload === "object" ? params.payload.status : void 0) === "started";
}
function emitSessionsChanged(context, payload) {
	const connIds = context.getSessionEventSubscriberConnIds();
	if (connIds.size === 0) return;
	const sessionRow = payload.sessionKey ? loadGatewaySessionRow(payload.sessionKey) : null;
	context.broadcastToConnIds("sessions.changed", {
		...payload,
		ts: Date.now(),
		...sessionRow ? {
			updatedAt: sessionRow.updatedAt ?? void 0,
			sessionId: sessionRow.sessionId,
			kind: sessionRow.kind,
			channel: sessionRow.channel,
			subject: sessionRow.subject,
			groupChannel: sessionRow.groupChannel,
			space: sessionRow.space,
			chatType: sessionRow.chatType,
			origin: sessionRow.origin,
			spawnedBy: sessionRow.spawnedBy,
			spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
			forkedFromParent: sessionRow.forkedFromParent,
			spawnDepth: sessionRow.spawnDepth,
			subagentRole: sessionRow.subagentRole,
			subagentControlScope: sessionRow.subagentControlScope,
			label: sessionRow.label,
			displayName: sessionRow.displayName,
			deliveryContext: sessionRow.deliveryContext,
			parentSessionKey: sessionRow.parentSessionKey,
			childSessions: sessionRow.childSessions,
			thinkingLevel: sessionRow.thinkingLevel,
			fastMode: sessionRow.fastMode,
			verboseLevel: sessionRow.verboseLevel,
			traceLevel: sessionRow.traceLevel,
			reasoningLevel: sessionRow.reasoningLevel,
			elevatedLevel: sessionRow.elevatedLevel,
			sendPolicy: sessionRow.sendPolicy,
			systemSent: sessionRow.systemSent,
			abortedLastRun: sessionRow.abortedLastRun,
			inputTokens: sessionRow.inputTokens,
			outputTokens: sessionRow.outputTokens,
			lastChannel: sessionRow.lastChannel,
			lastTo: sessionRow.lastTo,
			lastAccountId: sessionRow.lastAccountId,
			lastThreadId: sessionRow.lastThreadId,
			totalTokens: sessionRow.totalTokens,
			totalTokensFresh: sessionRow.totalTokensFresh,
			contextTokens: sessionRow.contextTokens,
			estimatedCostUsd: sessionRow.estimatedCostUsd,
			responseUsage: sessionRow.responseUsage,
			modelProvider: sessionRow.modelProvider,
			model: sessionRow.model,
			status: sessionRow.status,
			hasActiveRun: hasTrackedActiveSessionRun({
				context,
				requestedKey: payload.sessionKey ?? sessionRow.key,
				canonicalKey: sessionRow.key
			}),
			startedAt: sessionRow.startedAt,
			endedAt: sessionRow.endedAt,
			runtimeMs: sessionRow.runtimeMs,
			compactionCheckpointCount: sessionRow.compactionCheckpointCount,
			latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
			pluginExtensions: sessionRow.pluginExtensions
		} : {}
	}, connIds, { dropIfSlow: true });
}
function emitSessionOperation(context, payload) {
	const connIds = context.getSessionEventSubscriberConnIds();
	if (connIds.size === 0) return;
	context.broadcastToConnIds("session.operation", {
		...payload,
		ts: Date.now()
	}, connIds, { dropIfSlow: true });
}
function rejectWebchatSessionMutation(params) {
	if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) return false;
	if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) return false;
	params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`));
	return true;
}
function buildDashboardSessionKey(agentId) {
	return `agent:${agentId}:dashboard:${randomUUID()}`;
}
function cloneCheckpointSessionEntry(params) {
	return {
		...params.currentEntry,
		sessionId: params.nextSessionId,
		sessionFile: params.nextSessionFile,
		updatedAt: Date.now(),
		systemSent: false,
		abortedLastRun: false,
		startedAt: void 0,
		endedAt: void 0,
		runtimeMs: void 0,
		status: void 0,
		inputTokens: void 0,
		outputTokens: void 0,
		cacheRead: void 0,
		cacheWrite: void 0,
		estimatedCostUsd: void 0,
		totalTokens: typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens) ? params.totalTokens : void 0,
		totalTokensFresh: typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens) ? true : void 0,
		label: params.label ?? params.currentEntry.label,
		parentSessionKey: params.parentSessionKey ?? params.currentEntry.parentSessionKey,
		compactionCheckpoints: params.preserveCompactionCheckpoints ? params.currentEntry.compactionCheckpoints : void 0
	};
}
function isAgentMainSessionKey(cfg, sessionKey) {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return false;
	return sessionKey === resolveAgentMainSessionKey({
		cfg,
		agentId: parsed.agentId
	});
}
async function createAgentMainSessionForSend(params) {
	const agentId = parseAgentSessionKey(params.canonicalKey)?.agentId;
	if (!agentId) return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${params.canonicalKey}`)
	};
	let createResult;
	await sessionsHandlers["sessions.create"]({
		req: params.req,
		params: {
			key: params.canonicalKey,
			agentId
		},
		respond: (ok, payload, error) => {
			createResult = {
				ok,
				payload: payload && typeof payload === "object" ? payload : void 0,
				error
			};
		},
		context: params.context,
		client: params.client,
		isWebchatConnect: params.isWebchatConnect
	});
	if (!createResult) return {
		ok: false,
		error: errorShape(ErrorCodes.UNAVAILABLE, "sessions.create did not respond")
	};
	if (!createResult.ok) return {
		ok: false,
		error: createResult.error ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to create session")
	};
	const createdKey = normalizeOptionalString$1(createResult.payload?.key) ?? params.canonicalKey;
	const loaded = loadSessionEntry(createdKey);
	if (!loaded.entry?.sessionId) return {
		ok: false,
		error: errorShape(ErrorCodes.UNAVAILABLE, `session not created: ${createdKey}`)
	};
	return {
		ok: true,
		entry: loaded.entry,
		canonicalKey: loaded.canonicalKey,
		storePath: loaded.storePath
	};
}
function ensureSessionTranscriptFile(params) {
	try {
		const transcriptPath = resolveSessionFilePath(params.sessionId, params.sessionFile ? { sessionFile: params.sessionFile } : void 0, resolveSessionFilePathOptions({
			storePath: params.storePath,
			agentId: params.agentId
		}));
		if (!fs.existsSync(transcriptPath)) {
			fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
			const header = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: params.sessionId,
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				cwd: process.cwd()
			};
			fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, {
				encoding: "utf-8",
				mode: 384
			});
		}
		return {
			ok: true,
			transcriptPath
		};
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err)
		};
	}
}
function resolveAbortSessionKey(params) {
	if (params.activeRunSessionKey) return params.activeRunSessionKey;
	const candidates = [
		params.canonicalKey,
		params.requestedKey,
		...params.aliasKeys ?? []
	];
	for (const active of params.context.chatAbortControllers.values()) for (const candidate of candidates) if (active.sessionKey === candidate) return candidate;
	return params.requestedKey;
}
function resolveSessionKeyAgentId(sessionKey, cfg) {
	const key = normalizeOptionalString$1(sessionKey);
	if (!key) return;
	if (!parseAgentSessionKey(key) && key.toLowerCase().startsWith("agent:")) return;
	return resolveSessionStoreAgentId(cfg, resolveSessionStoreKey({
		cfg,
		sessionKey: key
	}));
}
function sessionKeyBelongsToAgent(sessionKey, agentId, cfg) {
	const key = normalizeOptionalString$1(sessionKey);
	if (cfg.session?.scope === "global" && key?.toLowerCase() === "global") return true;
	const sessionAgentId = resolveSessionKeyAgentId(sessionKey, cfg);
	return Boolean(sessionAgentId && sessionAgentId === normalizeAgentId(agentId));
}
function resolveScopedAbortKey(params) {
	const key = normalizeOptionalString$1(params.key);
	if (!key) return;
	const requestedAgentId = normalizeOptionalString$1(params.agentId);
	if (!requestedAgentId) return key;
	const scopedAgentId = normalizeAgentId(requestedAgentId);
	const ownerAgentId = resolveStoredSessionOwnerAgentId({
		cfg: params.cfg,
		agentId: scopedAgentId,
		sessionKey: key
	});
	if (ownerAgentId && ownerAgentId !== scopedAgentId) return;
	return resolveStoredSessionKeyForAgentStore({
		cfg: params.cfg,
		agentId: scopedAgentId,
		sessionKey: key
	});
}
function collectTrackedActiveSessionRunKeys(context) {
	const keys = /* @__PURE__ */ new Set();
	if (!(context.chatAbortControllers instanceof Map)) return keys;
	for (const active of context.chatAbortControllers.values()) if (typeof active.sessionKey === "string" && active.sessionKey.trim()) keys.add(active.sessionKey);
	return keys;
}
function hasTrackedActiveSessionRun(params) {
	const activeSessionKeys = collectTrackedActiveSessionRunKeys(params.context);
	return activeSessionKeys.has(params.canonicalKey) || activeSessionKeys.has(params.requestedKey);
}
async function interruptSessionRunIfActive(params) {
	const hasTrackedRun = hasTrackedActiveSessionRun({
		context: params.context,
		requestedKey: params.requestedKey,
		canonicalKey: params.canonicalKey
	});
	const hasEmbeddedRun = typeof params.sessionId === "string" && params.sessionId ? isEmbeddedPiRunActive(params.sessionId) : false;
	if (!hasTrackedRun && !hasEmbeddedRun) return { interrupted: false };
	if (hasTrackedRun) {
		let abortOk = true;
		let abortError;
		const abortSessionKey = resolveAbortSessionKey({
			context: params.context,
			requestedKey: params.requestedKey,
			canonicalKey: params.canonicalKey
		});
		await chatHandlers["chat.abort"]({
			req: params.req,
			params: { sessionKey: abortSessionKey },
			respond: (ok, _payload, error) => {
				abortOk = ok;
				abortError = error;
			},
			context: params.context,
			client: params.client,
			isWebchatConnect: params.isWebchatConnect
		});
		if (!abortOk) return {
			interrupted: true,
			error: abortError ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to interrupt active session")
		};
	}
	if (hasEmbeddedRun && params.sessionId) abortEmbeddedPiRun(params.sessionId);
	clearSessionQueues([
		params.requestedKey,
		params.canonicalKey,
		params.sessionId
	]);
	if (hasEmbeddedRun && params.sessionId) {
		if (!await waitForEmbeddedPiRunEnd(params.sessionId, 15e3)) return {
			interrupted: true,
			error: errorShape(ErrorCodes.UNAVAILABLE, `Session ${params.requestedKey} is still active; try again in a moment.`)
		};
	}
	return { interrupted: true };
}
async function handleSessionSend(params) {
	if (!assertValidParams(params.params, validateSessionsSendParams, params.method, params.respond)) return;
	const p = params.params;
	const key = requireSessionKey(p.key, params.respond);
	if (!key) return;
	const loaded = loadSessionEntry(key);
	const { cfg } = loaded;
	let { entry, canonicalKey, storePath } = loaded;
	const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, canonicalKey);
	if (deletedAgentId !== null) {
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `Agent "${deletedAgentId}" no longer exists in configuration`));
		return;
	}
	if (!entry?.sessionId && !params.interruptIfActive && isAgentMainSessionKey(cfg, canonicalKey)) {
		const created = await createAgentMainSessionForSend({
			req: params.req,
			canonicalKey,
			context: params.context,
			client: params.client,
			isWebchatConnect: params.isWebchatConnect
		});
		if (!created.ok) {
			params.respond(false, void 0, created.error);
			return;
		}
		entry = created.entry;
		canonicalKey = created.canonicalKey;
		storePath = created.storePath;
	}
	if (!entry?.sessionId) {
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`));
		return;
	}
	let interruptedActiveRun = false;
	if (params.interruptIfActive) {
		const interruptResult = await interruptSessionRunIfActive({
			req: params.req,
			context: params.context,
			client: params.client,
			isWebchatConnect: params.isWebchatConnect,
			requestedKey: key,
			canonicalKey,
			sessionId: entry.sessionId
		});
		if (interruptResult.error) {
			params.respond(false, void 0, interruptResult.error);
			return;
		}
		interruptedActiveRun = interruptResult.interrupted;
	}
	const messageSeq = await readSessionMessageCountAsync(entry.sessionId, storePath, entry.sessionFile) + 1;
	let sendAcked = false;
	let sendPayload;
	let sendCached = false;
	let startedRunId;
	const rawIdempotencyKey = p.idempotencyKey;
	const idempotencyKey = typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim() ? rawIdempotencyKey.trim() : randomUUID();
	await chatHandlers["chat.send"]({
		req: params.req,
		params: {
			sessionKey: canonicalKey,
			message: p.message,
			thinking: p.thinking,
			attachments: p.attachments,
			timeoutMs: p.timeoutMs,
			idempotencyKey
		},
		respond: (ok, payload, error, meta) => {
			sendAcked = ok;
			sendPayload = payload;
			sendCached = meta?.cached === true;
			startedRunId = payload && typeof payload === "object" && typeof payload.runId === "string" ? payload.runId : void 0;
			if (ok && shouldAttachPendingMessageSeq({
				payload,
				cached: meta?.cached === true
			})) {
				params.respond(true, {
					...payload && typeof payload === "object" ? payload : {},
					messageSeq,
					...interruptedActiveRun ? { interruptedActiveRun: true } : {}
				}, void 0, meta);
				return;
			}
			params.respond(ok, ok && payload && typeof payload === "object" ? {
				...payload,
				...interruptedActiveRun ? { interruptedActiveRun: true } : {}
			} : payload, error, meta);
		},
		context: params.context,
		client: params.client,
		isWebchatConnect: params.isWebchatConnect
	});
	if (sendAcked) {
		if (shouldAttachPendingMessageSeq({
			payload: sendPayload,
			cached: sendCached
		})) await reactivateCompletedSubagentSession({
			sessionKey: canonicalKey,
			runId: startedRunId
		});
		emitSessionsChanged(params.context, {
			sessionKey: canonicalKey,
			reason: interruptedActiveRun ? "steer" : "send"
		});
	}
}
const sessionsHandlers = {
	"sessions.list": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) return;
		const p = params;
		const cfg = context.getRuntimeConfig();
		const configuredAgentsOnly = p.configuredAgentsOnly === true;
		respond(true, await measureDiagnosticsTimelineSpan("gateway.sessions.list", async () => {
			const { storePath, store } = measureDiagnosticsTimelineSpanSync("gateway.sessions.list.store_load", () => loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId }), {
				config: cfg,
				phase: "sessions.list",
				attributes: {
					agentId: p.agentId ?? null,
					configuredAgentsOnly
				}
			});
			const listStore = configuredAgentsOnly ? filterSessionStoreToConfiguredAgents(cfg, store) : store;
			const modelCatalog = await measureDiagnosticsTimelineSpan("gateway.sessions.list.model_catalog", () => loadOptionalSessionsListModelCatalog(context), {
				config: cfg,
				phase: "sessions.list"
			});
			const result = await measureDiagnosticsTimelineSpan("gateway.sessions.list.rows", () => listSessionsFromStoreAsync({
				cfg,
				storePath,
				store: listStore,
				modelCatalog,
				opts: p
			}), {
				config: cfg,
				phase: "sessions.list",
				attributes: { storeEntries: Object.keys(listStore).length }
			});
			const sessions = measureDiagnosticsTimelineSpanSync("gateway.sessions.list.active_run_flags", () => {
				const activeSessionKeys = collectTrackedActiveSessionRunKeys(context);
				return result.sessions.map((session) => Object.assign({}, session, { hasActiveRun: activeSessionKeys.has(session.key) }));
			}, {
				config: cfg,
				phase: "sessions.list",
				attributes: { sessions: result.sessions.length }
			});
			return {
				...result,
				sessions
			};
		}, {
			config: cfg,
			phase: "sessions.list",
			attributes: {
				agentId: p.agentId ?? null,
				configuredAgentsOnly
			}
		}), void 0);
	},
	"sessions.cleanup": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateSessionsCleanupParams, "sessions.cleanup", respond)) return;
		try {
			const { mode, appliedSummaries } = await runSessionsCleanup({
				cfg: context.getRuntimeConfig(),
				opts: {
					agent: params.agent,
					allAgents: params.allAgents,
					enforce: params.enforce,
					activeKey: params.activeKey,
					fixMissing: params.fixMissing,
					fixDmScope: params.fixDmScope
				}
			});
			respond(true, serializeSessionCleanupResult({
				mode,
				dryRun: false,
				summaries: appliedSummaries
			}), void 0);
			for (const summary of appliedSummaries) {
				emitSessionsChanged(context, {
					reason: "cleanup",
					sessionKey: void 0
				});
				if (summary.wouldMutate) context.logGateway.debug(`sessions.cleanup applied ${summary.storePath}: ${summary.beforeCount} -> ${summary.afterCount}`);
			}
		} catch (error) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
		}
	},
	"sessions.subscribe": ({ client, context, respond }) => {
		const connId = client?.connId?.trim();
		if (connId) context.subscribeSessionEvents(connId);
		respond(true, { subscribed: Boolean(connId) }, void 0);
	},
	"sessions.unsubscribe": ({ client, context, respond }) => {
		const connId = client?.connId?.trim();
		if (connId) context.unsubscribeSessionEvents(connId);
		respond(true, { subscribed: false }, void 0);
	},
	"sessions.messages.subscribe": ({ params, client, context, respond }) => {
		if (!assertValidParams(params, validateSessionsMessagesSubscribeParams, "sessions.messages.subscribe", respond)) return;
		const connId = client?.connId?.trim();
		const key = requireSessionKey(params.key, respond);
		if (!key) return;
		const { canonicalKey } = loadSessionEntry(key);
		if (connId) {
			context.subscribeSessionMessageEvents(connId, canonicalKey);
			respond(true, {
				subscribed: true,
				key: canonicalKey
			}, void 0);
			return;
		}
		respond(true, {
			subscribed: false,
			key: canonicalKey
		}, void 0);
	},
	"sessions.messages.unsubscribe": ({ params, client, context, respond }) => {
		if (!assertValidParams(params, validateSessionsMessagesUnsubscribeParams, "sessions.messages.unsubscribe", respond)) return;
		const connId = client?.connId?.trim();
		const key = requireSessionKey(params.key, respond);
		if (!key) return;
		const { canonicalKey } = loadSessionEntry(key);
		if (connId) context.unsubscribeSessionMessageEvents(connId, canonicalKey);
		respond(true, {
			subscribed: false,
			key: canonicalKey
		}, void 0);
	},
	"sessions.preview": ({ params, respond, context }) => {
		if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) return;
		const p = params;
		const keys = (Array.isArray(p.keys) ? p.keys : []).map((key) => normalizeOptionalString$1(key ?? "")).filter((key) => Boolean(key)).slice(0, 64);
		const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
		const maxChars = typeof p.maxChars === "number" && Number.isFinite(p.maxChars) ? Math.max(20, p.maxChars) : 240;
		if (keys.length === 0) {
			respond(true, {
				ts: Date.now(),
				previews: []
			}, void 0);
			return;
		}
		const cfg = context.getRuntimeConfig();
		const storeCache = /* @__PURE__ */ new Map();
		const previews = [];
		for (const key of keys) try {
			const storeTarget = resolveGatewaySessionStoreTarget({
				cfg,
				key,
				scanLegacyKeys: false
			});
			const store = storeCache.get(storeTarget.storePath) ?? loadSessionStore(storeTarget.storePath);
			storeCache.set(storeTarget.storePath, store);
			const target = resolveGatewaySessionStoreTarget({
				cfg,
				key,
				store
			});
			const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
			if (!entry?.sessionId) {
				previews.push({
					key,
					status: "missing",
					items: []
				});
				continue;
			}
			const items = readSessionPreviewItemsFromTranscript(entry.sessionId, target.storePath, entry.sessionFile, target.agentId, limit, maxChars);
			previews.push({
				key,
				status: items.length > 0 ? "ok" : "empty",
				items
			});
		} catch {
			previews.push({
				key,
				status: "error",
				items: []
			});
		}
		respond(true, {
			ts: Date.now(),
			previews
		}, void 0);
	},
	"sessions.describe": ({ params, respond, context }) => {
		if (!assertValidParams(params, validateSessionsDescribeParams, "sessions.describe", respond)) return;
		const key = requireSessionKey(params.key, respond);
		if (!key) return;
		const cfg = context.getRuntimeConfig();
		const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg);
		const store = loadSessionStore(storePath);
		const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
		if (!entry) {
			respond(true, { session: null }, void 0);
			return;
		}
		respond(true, { session: buildGatewaySessionRow({
			cfg,
			storePath,
			store,
			key: target.canonicalKey,
			entry,
			includeDerivedTitles: params.includeDerivedTitles,
			includeLastMessage: params.includeLastMessage,
			transcriptUsageMaxBytes: 64 * 1024
		}) }, void 0);
	},
	"sessions.resolve": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) return;
		const p = params;
		const resolved = await resolveSessionKeyFromResolveParams({
			cfg: context.getRuntimeConfig(),
			p
		});
		if (!resolved.ok) {
			respond(false, void 0, resolved.error);
			return;
		}
		respond(true, {
			ok: true,
			key: resolved.key
		}, void 0);
	},
	"sessions.compaction.list": ({ params, respond }) => {
		if (!assertValidParams(params, validateSessionsCompactionListParams, "sessions.compaction.list", respond)) return;
		const key = requireSessionKey(params.key, respond);
		if (!key) return;
		const { entry, canonicalKey } = loadSessionEntry(key);
		respond(true, {
			ok: true,
			key: canonicalKey,
			checkpoints: listSessionCompactionCheckpoints(entry)
		}, void 0);
	},
	"sessions.compaction.get": ({ params, respond }) => {
		if (!assertValidParams(params, validateSessionsCompactionGetParams, "sessions.compaction.get", respond)) return;
		const p = params;
		const key = requireSessionKey(p.key, respond);
		if (!key) return;
		const checkpointId = normalizeOptionalString$1(p.checkpointId) ?? "";
		if (!checkpointId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
			return;
		}
		const { entry, canonicalKey } = loadSessionEntry(key);
		const checkpoint = getSessionCompactionCheckpoint({
			entry,
			checkpointId
		});
		if (!checkpoint) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`));
			return;
		}
		respond(true, {
			ok: true,
			key: canonicalKey,
			checkpoint
		}, void 0);
	},
	"sessions.create": async ({ req, params, respond, context, client, isWebchatConnect }) => {
		if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) return;
		const p = params;
		const cfg = context.getRuntimeConfig();
		const requestedKey = normalizeOptionalString$1(p.key);
		const agentId = normalizeAgentId(normalizeOptionalString$1(p.agentId) ?? resolveDefaultAgentId(cfg));
		if (requestedKey) {
			const requestedAgentId = parseAgentSessionKey(requestedKey)?.agentId;
			if (requestedAgentId && requestedAgentId !== agentId && normalizeOptionalString$1(p.agentId)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `sessions.create key agent (${requestedAgentId}) does not match agentId (${agentId})`));
				return;
			}
		}
		const parentSessionKey = normalizeOptionalString$1(p.parentSessionKey);
		let canonicalParentSessionKey;
		if (parentSessionKey) {
			const parent = loadSessionEntry(parentSessionKey);
			if (!parent.entry?.sessionId) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unknown parent session: ${parentSessionKey}`));
				return;
			}
			canonicalParentSessionKey = parent.canonicalKey;
		}
		if (canonicalParentSessionKey && p.emitCommandHooks === true && !requestedKey && !resolveOptionalInitialSessionMessage(p) && cfg.session?.dmScope === "main") {
			const parentMainKey = resolveAgentMainSessionKey({
				cfg,
				agentId: normalizeAgentId(resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? resolveDefaultAgentId(cfg))
			});
			if (canonicalParentSessionKey === parentMainKey) {
				const { performGatewaySessionReset } = await loadSessionsRuntimeModule();
				const resetResult = await performGatewaySessionReset({
					key: canonicalParentSessionKey,
					reason: "new",
					commandSource: "webchat"
				});
				if (!resetResult.ok) {
					respond(false, void 0, resetResult.error);
					return;
				}
				respond(true, {
					ok: true,
					key: resetResult.key,
					sessionId: resetResult.entry.sessionId,
					entry: resetResult.entry,
					runStarted: false
				}, void 0);
				emitSessionsChanged(context, {
					sessionKey: resetResult.key,
					reason: "new"
				});
				return;
			}
		}
		if (canonicalParentSessionKey && p.emitCommandHooks === true) {
			const { entry: parentEntry } = loadSessionEntry(canonicalParentSessionKey);
			const workspaceDir = resolveAgentWorkspaceDir(cfg, normalizeAgentId(resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? resolveDefaultAgentId(cfg)));
			if (hasInternalHookListeners("command", "new")) await triggerInternalHook(createInternalHookEvent("command", "new", canonicalParentSessionKey, {
				sessionEntry: parentEntry,
				previousSessionEntry: parentEntry,
				commandSource: "webchat",
				cfg,
				workspaceDir
			}));
			const parentTarget = resolveGatewaySessionStoreTarget({
				cfg,
				key: canonicalParentSessionKey
			});
			const { emitGatewayBeforeResetPluginHook } = await loadSessionsRuntimeModule();
			await emitGatewayBeforeResetPluginHook({
				cfg,
				key: canonicalParentSessionKey,
				target: parentTarget,
				storePath: parentTarget.storePath,
				entry: parentEntry,
				reason: "new"
			});
		}
		const loweredRequestedKey = normalizeOptionalLowercaseString(requestedKey);
		const target = resolveGatewaySessionStoreTarget({
			cfg,
			key: requestedKey ? loweredRequestedKey === "global" || loweredRequestedKey === "unknown" ? loweredRequestedKey : toAgentStoreSessionKey({
				agentId,
				requestKey: requestedKey,
				mainKey: cfg.session?.mainKey
			}) : buildDashboardSessionKey(agentId)
		});
		const targetAgentId = resolveAgentIdFromSessionKey(target.canonicalKey);
		const created = await updateSessionStore(target.storePath, async (store) => {
			const patched = await applySessionsPatchToStore({
				cfg,
				store,
				storeKey: target.canonicalKey,
				patch: {
					key: target.canonicalKey,
					label: normalizeOptionalString$1(p.label),
					model: normalizeOptionalString$1(p.model)
				},
				loadGatewayModelCatalog: context.loadGatewayModelCatalog
			});
			if (!patched.ok || !canonicalParentSessionKey) return patched;
			const nextEntry = {
				...patched.entry,
				parentSessionKey: canonicalParentSessionKey
			};
			store[target.canonicalKey] = nextEntry;
			return {
				...patched,
				entry: nextEntry
			};
		});
		if (!created.ok) {
			respond(false, void 0, created.error);
			return;
		}
		const ensured = ensureSessionTranscriptFile({
			sessionId: created.entry.sessionId,
			storePath: target.storePath,
			sessionFile: created.entry.sessionFile,
			agentId: targetAgentId
		});
		if (!ensured.ok) {
			await updateSessionStore(target.storePath, (store) => {
				delete store[target.canonicalKey];
			});
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `failed to create session transcript: ${ensured.error}`));
			return;
		}
		const createdEntry = created.entry.sessionFile === ensured.transcriptPath ? created.entry : {
			...created.entry,
			sessionFile: ensured.transcriptPath
		};
		if (createdEntry !== created.entry) await updateSessionStore(target.storePath, (store) => {
			const existing = store[target.canonicalKey];
			if (existing) store[target.canonicalKey] = {
				...existing,
				sessionFile: ensured.transcriptPath
			};
		});
		const initialMessage = resolveOptionalInitialSessionMessage(p);
		let runPayload;
		let runError;
		let runMeta;
		const messageSeq = initialMessage ? await readSessionMessageCountAsync(createdEntry.sessionId, target.storePath, createdEntry.sessionFile) + 1 : void 0;
		if (initialMessage) await chatHandlers["chat.send"]({
			req,
			params: {
				sessionKey: target.canonicalKey,
				message: initialMessage,
				idempotencyKey: randomUUID()
			},
			respond: (ok, payload, error, meta) => {
				if (ok && payload && typeof payload === "object") runPayload = payload;
				else runError = error;
				runMeta = meta;
			},
			context,
			client,
			isWebchatConnect
		});
		const runStarted = runPayload !== void 0 && shouldAttachPendingMessageSeq({
			payload: runPayload,
			cached: runMeta?.cached === true
		});
		respond(true, {
			ok: true,
			key: target.canonicalKey,
			sessionId: createdEntry.sessionId,
			entry: createdEntry,
			runStarted,
			...runPayload ? runPayload : {},
			...runStarted && typeof messageSeq === "number" ? { messageSeq } : {},
			...runError ? { runError } : {}
		}, void 0);
		emitSessionsChanged(context, {
			sessionKey: target.canonicalKey,
			reason: "create"
		});
		if (runStarted) emitSessionsChanged(context, {
			sessionKey: target.canonicalKey,
			reason: "send"
		});
		if (canonicalParentSessionKey && p.emitCommandHooks === true) {
			const { entry: parentEntry } = loadSessionEntry(canonicalParentSessionKey);
			const parentTarget = resolveGatewaySessionStoreTarget({
				cfg,
				key: canonicalParentSessionKey
			});
			const { emitGatewaySessionEndPluginHook, emitGatewaySessionStartPluginHook } = await loadSessionsRuntimeModule();
			emitGatewaySessionEndPluginHook({
				cfg,
				sessionKey: canonicalParentSessionKey,
				sessionId: parentEntry?.sessionId,
				storePath: parentTarget.storePath,
				sessionFile: parentEntry?.sessionFile,
				agentId: parentTarget.agentId,
				reason: "new",
				nextSessionId: createdEntry.sessionId,
				nextSessionKey: target.canonicalKey
			});
			emitGatewaySessionStartPluginHook({
				cfg,
				sessionKey: target.canonicalKey,
				sessionId: createdEntry.sessionId,
				resumedFrom: parentEntry?.sessionId,
				storePath: target.storePath,
				sessionFile: createdEntry.sessionFile,
				agentId: target.agentId
			});
		}
	},
	"sessions.compaction.branch": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateSessionsCompactionBranchParams, "sessions.compaction.branch", respond)) return;
		const p = params;
		const key = requireSessionKey(p.key, respond);
		if (!key) return;
		const checkpointId = typeof p.checkpointId === "string" && p.checkpointId.trim() ? p.checkpointId.trim() : "";
		if (!checkpointId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
			return;
		}
		const { cfg, entry, canonicalKey } = loadSessionEntry(key);
		const target = resolveGatewaySessionStoreTarget({
			cfg,
			key: canonicalKey
		});
		if (!entry?.sessionId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`));
			return;
		}
		const checkpoint = getSessionCompactionCheckpoint({
			entry,
			checkpointId
		});
		if (!checkpoint?.preCompaction.sessionFile) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`));
			return;
		}
		const branchedSession = await forkCompactionCheckpointTranscriptAsync({
			sourceFile: checkpoint.preCompaction.sessionFile,
			sessionDir: path.dirname(checkpoint.preCompaction.sessionFile)
		});
		if (!branchedSession?.sessionFile) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "failed to create checkpoint branch transcript"));
			return;
		}
		const nextKey = buildDashboardSessionKey(target.agentId);
		const label = entry.label?.trim() ? `${entry.label.trim()} (checkpoint)` : "Checkpoint branch";
		const nextEntry = cloneCheckpointSessionEntry({
			currentEntry: entry,
			nextSessionId: branchedSession.sessionId,
			nextSessionFile: branchedSession.sessionFile,
			label,
			parentSessionKey: canonicalKey,
			totalTokens: checkpoint.tokensBefore
		});
		await updateSessionStore(target.storePath, (store) => {
			store[nextKey] = nextEntry;
		});
		respond(true, {
			ok: true,
			sourceKey: canonicalKey,
			key: nextKey,
			sessionId: nextEntry.sessionId,
			checkpoint,
			entry: nextEntry
		}, void 0);
		emitSessionsChanged(context, {
			sessionKey: canonicalKey,
			reason: "checkpoint-branch"
		});
		emitSessionsChanged(context, {
			sessionKey: nextKey,
			reason: "checkpoint-branch"
		});
	},
	"sessions.compaction.restore": async ({ req, params, respond, context, client, isWebchatConnect }) => {
		if (!assertValidParams(params, validateSessionsCompactionRestoreParams, "sessions.compaction.restore", respond)) return;
		const p = params;
		const key = requireSessionKey(p.key, respond);
		if (!key) return;
		if (rejectWebchatSessionMutation({
			action: "restore",
			client,
			isWebchatConnect,
			respond
		})) return;
		const checkpointId = typeof p.checkpointId === "string" && p.checkpointId.trim() ? p.checkpointId.trim() : "";
		if (!checkpointId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
			return;
		}
		const { entry, canonicalKey, storePath } = loadSessionEntry(key);
		if (!entry?.sessionId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`));
			return;
		}
		const checkpoint = getSessionCompactionCheckpoint({
			entry,
			checkpointId
		});
		if (!checkpoint?.preCompaction.sessionFile) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`));
			return;
		}
		const interruptResult = await interruptSessionRunIfActive({
			req,
			context,
			client,
			isWebchatConnect,
			requestedKey: key,
			canonicalKey,
			sessionId: entry.sessionId
		});
		if (interruptResult.error) {
			respond(false, void 0, interruptResult.error);
			return;
		}
		const restoredSession = await forkCompactionCheckpointTranscriptAsync({
			sourceFile: checkpoint.preCompaction.sessionFile,
			sessionDir: path.dirname(checkpoint.preCompaction.sessionFile)
		});
		if (!restoredSession?.sessionFile) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "failed to restore checkpoint transcript"));
			return;
		}
		const nextEntry = cloneCheckpointSessionEntry({
			currentEntry: entry,
			nextSessionId: restoredSession.sessionId,
			nextSessionFile: restoredSession.sessionFile,
			totalTokens: checkpoint.tokensBefore,
			preserveCompactionCheckpoints: true
		});
		await updateSessionStore(storePath, (store) => {
			store[canonicalKey] = nextEntry;
		});
		respond(true, {
			ok: true,
			key: canonicalKey,
			sessionId: nextEntry.sessionId,
			checkpoint,
			entry: nextEntry
		}, void 0);
		emitSessionsChanged(context, {
			sessionKey: canonicalKey,
			reason: "checkpoint-restore"
		});
	},
	"sessions.send": async ({ req, params, respond, context, client, isWebchatConnect }) => {
		await handleSessionSend({
			method: "sessions.send",
			req,
			params,
			respond,
			context,
			client,
			isWebchatConnect,
			interruptIfActive: false
		});
	},
	"sessions.steer": async ({ req, params, respond, context, client, isWebchatConnect }) => {
		await handleSessionSend({
			method: "sessions.steer",
			req,
			params,
			respond,
			context,
			client,
			isWebchatConnect,
			interruptIfActive: true
		});
	},
	"sessions.abort": async ({ req, params, respond, context, client, isWebchatConnect }) => {
		if (!assertValidParams(params, validateSessionsAbortParams, "sessions.abort", respond)) return;
		const p = params;
		const cfg = context.getRuntimeConfig();
		const requestedRunId = readStringValue(p.runId);
		const requestedKey = normalizeOptionalString$1(p.key);
		const requestedParamAgentId = normalizeOptionalString$1(p.agentId);
		const scopedRequestedKey = resolveScopedAbortKey({
			cfg,
			key: requestedKey,
			agentId: requestedParamAgentId
		});
		if (requestedKey && requestedParamAgentId && !scopedRequestedKey) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"));
			return;
		}
		const requestedKeyAgentId = scopedRequestedKey ? resolveSessionKeyAgentId(scopedRequestedKey, cfg) : void 0;
		const activeRunSessionKey = requestedRunId ? context.chatAbortControllers.get(requestedRunId)?.sessionKey : void 0;
		const inferredRunAgentId = requestedParamAgentId ?? requestedKeyAgentId ?? (requestedRunId && !activeRunSessionKey ? resolveDefaultAgentId(cfg) : void 0);
		const requestedRunAgentId = requestedRunId ? inferredRunAgentId ? normalizeAgentId(inferredRunAgentId) : void 0 : void 0;
		const scopedActiveRunSessionKey = activeRunSessionKey ? requestedRunAgentId ? sessionKeyBelongsToAgent(activeRunSessionKey, requestedRunAgentId, cfg) ? activeRunSessionKey : void 0 : activeRunSessionKey : void 0;
		const keyCandidate = scopedRequestedKey ?? scopedActiveRunSessionKey ?? (requestedRunId ? resolveSessionKeyForRun(requestedRunId, { agentId: requestedRunAgentId ?? resolveDefaultAgentId(cfg) }) : void 0);
		if (!keyCandidate && requestedRunId) {
			respond(true, {
				ok: true,
				abortedRunId: null,
				status: "no-active-run"
			});
			return;
		}
		const key = requireSessionKey(keyCandidate, respond);
		if (!key) return;
		const { canonicalKey } = loadSessionEntry(key);
		const abortSessionKey = resolveAbortSessionKey({
			context,
			requestedKey: key,
			canonicalKey,
			activeRunSessionKey: scopedActiveRunSessionKey,
			aliasKeys: requestedKey && requestedKey !== key && (!requestedParamAgentId || sessionKeyBelongsToAgent(requestedKey, requestedParamAgentId, cfg)) ? [requestedKey] : void 0
		});
		const preAbortRunKinds = /* @__PURE__ */ new Map();
		if (requestedRunId) preAbortRunKinds.set(requestedRunId, context.chatAbortControllers.get(requestedRunId)?.kind);
		else for (const [rid, entry] of context.chatAbortControllers) preAbortRunKinds.set(rid, entry.kind);
		let abortedRunId = null;
		await chatHandlers["chat.abort"]({
			req,
			params: {
				sessionKey: abortSessionKey,
				runId: requestedRunId
			},
			respond: (ok, payload, error, meta) => {
				if (!ok) {
					respond(ok, payload, error, meta);
					return;
				}
				const firstAbortedRunId = (payload && typeof payload === "object" && Array.isArray(payload.runIds) ? payload.runIds.filter((value) => Boolean(normalizeOptionalString$1(value))) : [])[0] ?? null;
				abortedRunId = firstAbortedRunId;
				if (firstAbortedRunId) {
					const endedAt = Date.now();
					const dedupePrefix = preAbortRunKinds.get(firstAbortedRunId) === "agent" ? "agent" : "chat";
					setGatewayDedupeEntry({
						dedupe: context.dedupe,
						key: `${dedupePrefix}:${firstAbortedRunId}`,
						entry: {
							ts: endedAt,
							ok: true,
							payload: {
								status: "timeout",
								runId: firstAbortedRunId,
								stopReason: "rpc",
								endedAt
							}
						}
					});
				}
				respond(true, {
					ok: true,
					abortedRunId,
					status: abortedRunId ? "aborted" : "no-active-run"
				}, void 0, meta);
			},
			context,
			client,
			isWebchatConnect
		});
		if (abortedRunId) emitSessionsChanged(context, {
			sessionKey: canonicalKey,
			reason: "abort"
		});
	},
	"sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
		if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) return;
		const p = params;
		const key = requireSessionKey(p.key, respond);
		if (!key) return;
		if (rejectWebchatSessionMutation({
			action: "patch",
			client,
			isWebchatConnect,
			respond
		})) return;
		const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key, context.getRuntimeConfig());
		const applied = await updateSessionStore(storePath, async (store) => {
			const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
				cfg,
				key,
				store
			});
			return await applySessionsPatchToStore({
				cfg,
				store,
				storeKey: primaryKey,
				patch: p,
				loadGatewayModelCatalog: context.loadGatewayModelCatalog
			});
		});
		if (!applied.ok) {
			respond(false, void 0, applied.error);
			return;
		}
		triggerSessionPatchHook({
			cfg,
			sessionEntry: applied.entry,
			sessionKey: target.canonicalKey ?? key,
			patch: p
		});
		const agentId = normalizeAgentId(parseAgentSessionKey(target.canonicalKey ?? key)?.agentId ?? resolveDefaultAgentId(cfg));
		const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
		const resolvedDisplayModel = resolveSessionDisplayModelIdentityRef({
			cfg,
			agentId,
			provider: resolved.provider,
			model: resolved.model
		});
		const agentRuntime = resolveModelAgentRuntimeMetadata({
			cfg,
			agentId,
			provider: resolvedDisplayModel.provider,
			model: resolvedDisplayModel.model,
			sessionKey: target.canonicalKey ?? key,
			acpRuntime: applied.entry?.acp != null,
			acpBackend: applied.entry?.acp?.backend
		});
		respond(true, {
			ok: true,
			path: storePath,
			key: target.canonicalKey,
			entry: applied.entry,
			resolved: {
				modelProvider: resolvedDisplayModel.provider,
				model: resolvedDisplayModel.model,
				agentRuntime
			}
		}, void 0);
		emitSessionsChanged(context, {
			sessionKey: target.canonicalKey,
			reason: "patch"
		});
	},
	"sessions.pluginPatch": async ({ params, respond, context, client, isWebchatConnect }) => {
		if (!assertValidParams(params, validateSessionsPluginPatchParams, "sessions.pluginPatch", respond)) return;
		const key = requireSessionKey(params.key, respond);
		if (!key) return;
		if (rejectWebchatSessionMutation({
			action: "patch",
			client,
			isWebchatConnect,
			respond
		})) return;
		if (!(Array.isArray(client?.connect.scopes) ? client.connect.scopes : []).includes("operator.admin")) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `sessions.pluginPatch requires gateway scope: ${ADMIN_SCOPE$1}`));
			return;
		}
		const pluginId = normalizeOptionalString$1(params.pluginId);
		const namespace = normalizeOptionalString$1(params.namespace);
		if (!pluginId || !namespace) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "pluginId and namespace are required"));
			return;
		}
		if (params.unset === true && params.value !== void 0) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "sessions.pluginPatch cannot specify both unset and value"));
			return;
		}
		if (params.value !== void 0 && !isPluginJsonValue(params.value)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "sessions.pluginPatch value must be JSON-compatible"));
			return;
		}
		const patched = await patchPluginSessionExtension({
			cfg: context.getRuntimeConfig(),
			sessionKey: key,
			pluginId,
			namespace,
			value: params.value,
			unset: params.unset === true
		});
		if (!patched.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, patched.error));
			return;
		}
		respond(true, {
			ok: true,
			key: patched.key,
			value: patched.value
		}, void 0);
		emitSessionsChanged(context, {
			sessionKey: patched.key,
			reason: "plugin-patch"
		});
	},
	"sessions.reset": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) return;
		const p = params;
		const key = requireSessionKey(p.key, respond);
		if (!key) return;
		const reason = p.reason === "new" ? "new" : "reset";
		const { performGatewaySessionReset } = await loadSessionsRuntimeModule();
		const result = await performGatewaySessionReset({
			key,
			reason,
			commandSource: "gateway:sessions.reset"
		});
		if (!result.ok) {
			respond(false, void 0, result.error);
			return;
		}
		respond(true, {
			ok: true,
			key: result.key,
			entry: result.entry
		}, void 0);
		emitSessionsChanged(context, {
			sessionKey: result.key,
			reason
		});
	},
	"sessions.delete": async ({ params, respond, client, isWebchatConnect, context }) => {
		if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) return;
		const p = params;
		const key = requireSessionKey(p.key, respond);
		if (!key) return;
		if (rejectWebchatSessionMutation({
			action: "delete",
			client,
			isWebchatConnect,
			respond
		})) return;
		const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key, context.getRuntimeConfig());
		const mainKey = resolveMainSessionKey(cfg);
		if (target.canonicalKey === mainKey) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`));
			return;
		}
		const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;
		const { archiveSessionTranscriptsForSessionDetailed, cleanupSessionBeforeMutation, emitGatewaySessionEndPluginHook, emitSessionUnboundLifecycleEvent } = await loadSessionsRuntimeModule();
		const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
		if (rejectPluginRuntimeDeleteMismatch({
			client,
			key: canonicalKey ?? key,
			entry,
			respond
		})) return;
		const mutationCleanupError = await cleanupSessionBeforeMutation({
			cfg,
			key,
			target,
			entry,
			legacyKey,
			canonicalKey,
			reason: "session-delete"
		});
		if (mutationCleanupError) {
			respond(false, void 0, mutationCleanupError);
			return;
		}
		const sessionId = entry?.sessionId;
		const deleted = await updateSessionStore(storePath, (store) => {
			const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
				cfg,
				key,
				store
			});
			const hadEntry = Boolean(store[primaryKey]);
			if (hadEntry) delete store[primaryKey];
			return hadEntry;
		});
		const archivedTranscripts = deleted && deleteTranscript ? archiveSessionTranscriptsForSessionDetailed({
			sessionId,
			storePath,
			sessionFile: entry?.sessionFile,
			agentId: target.agentId,
			reason: "deleted"
		}) : [];
		const archived = archivedTranscripts.map((entry) => entry.archivedPath);
		if (deleted) {
			emitGatewaySessionEndPluginHook({
				cfg,
				sessionKey: target.canonicalKey ?? key,
				sessionId,
				storePath,
				sessionFile: entry?.sessionFile,
				agentId: target.agentId,
				reason: "deleted",
				archivedTranscripts
			});
			const emitLifecycleHooks = p.emitLifecycleHooks !== false;
			await emitSessionUnboundLifecycleEvent({
				targetSessionKey: target.canonicalKey ?? key,
				reason: "session-delete",
				emitHooks: emitLifecycleHooks
			});
		}
		respond(true, {
			ok: true,
			key: target.canonicalKey,
			deleted,
			archived
		}, void 0);
		if (deleted) emitSessionsChanged(context, {
			sessionKey: target.canonicalKey,
			reason: "delete"
		});
	},
	"sessions.get": async ({ params, respond, context }) => {
		const p = params;
		const key = requireSessionKey(p.key ?? p.sessionKey, respond);
		if (!key) return;
		const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, Math.floor(p.limit)) : 200;
		const { target, storePath } = resolveGatewaySessionTargetFromKey(key, context.getRuntimeConfig());
		const entry = resolveFreshestSessionEntryFromStoreKeys(loadSessionStore(storePath), target.storeKeys);
		if (!entry?.sessionId) {
			respond(true, { messages: [] }, void 0);
			return;
		}
		const { messages } = await readRecentSessionMessagesWithStatsAsync(entry.sessionId, storePath, entry.sessionFile, {
			maxMessages: limit,
			maxLines: limit * 20 + 20
		});
		respond(true, { messages }, void 0);
	},
	"sessions.compact": async ({ req, params, respond, context, client, isWebchatConnect }) => {
		if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) return;
		const p = params;
		const key = requireSessionKey(p.key, respond);
		if (!key) return;
		if (rejectWebchatSessionMutation({
			action: "compact",
			client,
			isWebchatConnect,
			respond
		})) return;
		const maxLines = typeof p.maxLines === "number" && Number.isFinite(p.maxLines) ? Math.max(1, Math.floor(p.maxLines)) : void 0;
		const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key, context.getRuntimeConfig());
		const compactTarget = await updateSessionStore(storePath, (store) => {
			const { entry, primaryKey } = migrateAndPruneGatewaySessionStoreKey({
				cfg,
				key,
				store
			});
			return {
				entry,
				primaryKey
			};
		});
		const entry = compactTarget.entry;
		const sessionId = entry?.sessionId;
		if (!sessionId) {
			respond(true, {
				ok: true,
				key: target.canonicalKey,
				compacted: false,
				reason: "no sessionId"
			}, void 0);
			return;
		}
		const filePath = resolveSessionTranscriptCandidates(sessionId, storePath, entry?.sessionFile, target.agentId).find((candidate) => fs.existsSync(candidate));
		if (!filePath) {
			respond(true, {
				ok: true,
				key: target.canonicalKey,
				compacted: false,
				reason: "no transcript"
			}, void 0);
			return;
		}
		if (maxLines === void 0) {
			const interruptResult = await interruptSessionRunIfActive({
				req,
				context,
				client,
				isWebchatConnect,
				requestedKey: key,
				canonicalKey: target.canonicalKey,
				sessionId
			});
			if (interruptResult.error) {
				respond(false, void 0, interruptResult.error);
				return;
			}
			const resolvedModel = resolveSessionModelRef(cfg, entry, target.agentId);
			const workspaceDir = normalizeOptionalString$1(entry?.spawnedWorkspaceDir) || resolveAgentWorkspaceDir(cfg, target.agentId);
			const operationId = randomUUID();
			emitSessionOperation(context, {
				operationId,
				operation: "compact",
				phase: "start",
				sessionKey: target.canonicalKey
			});
			let result;
			try {
				result = await compactEmbeddedPiSession({
					sessionId,
					sessionKey: target.canonicalKey,
					allowGatewaySubagentBinding: true,
					sessionFile: filePath,
					workspaceDir,
					config: cfg,
					provider: resolvedModel.provider,
					model: resolvedModel.model,
					agentHarnessId: entry?.sessionId === sessionId ? entry.agentHarnessId : void 0,
					thinkLevel: normalizeThinkLevel(entry?.thinkingLevel),
					reasoningLevel: normalizeReasoningLevel(entry?.reasoningLevel),
					bashElevated: {
						enabled: false,
						allowed: false,
						defaultLevel: "off"
					},
					trigger: "manual"
				});
			} catch (err) {
				emitSessionOperation(context, {
					operationId,
					operation: "compact",
					phase: "end",
					sessionKey: target.canonicalKey,
					completed: false,
					reason: formatErrorMessage(err)
				});
				throw err;
			}
			emitSessionOperation(context, {
				operationId,
				operation: "compact",
				phase: "end",
				sessionKey: target.canonicalKey,
				completed: result.ok && result.compacted,
				reason: result.reason
			});
			if (result.ok && result.compacted) await updateSessionStore(storePath, (store) => {
				const entryToUpdate = store[compactTarget.primaryKey];
				if (!entryToUpdate) return;
				entryToUpdate.updatedAt = Date.now();
				entryToUpdate.compactionCount = Math.max(0, entryToUpdate.compactionCount ?? 0) + 1;
				if (result.result?.sessionId && result.result.sessionId !== entryToUpdate.sessionId) entryToUpdate.sessionId = result.result.sessionId;
				if (result.result?.sessionFile) entryToUpdate.sessionFile = result.result.sessionFile;
				delete entryToUpdate.inputTokens;
				delete entryToUpdate.outputTokens;
				if (typeof result.result?.tokensAfter === "number" && Number.isFinite(result.result.tokensAfter)) {
					entryToUpdate.totalTokens = result.result.tokensAfter;
					entryToUpdate.totalTokensFresh = true;
				} else {
					delete entryToUpdate.totalTokens;
					delete entryToUpdate.totalTokensFresh;
				}
			});
			respond(true, {
				ok: result.ok,
				key: target.canonicalKey,
				compacted: result.compacted,
				reason: result.reason,
				result: result.result
			}, void 0);
			if (result.ok) emitSessionsChanged(context, {
				sessionKey: target.canonicalKey,
				reason: "compact",
				compacted: result.compacted
			});
			return;
		}
		const tail = readRecentSessionTranscriptLines({
			sessionId,
			storePath,
			sessionFile: entry?.sessionFile,
			agentId: target.agentId,
			maxLines
		});
		const lines = tail?.lines ?? [];
		const totalLines = tail?.totalLines ?? 0;
		if (totalLines <= maxLines) {
			respond(true, {
				ok: true,
				key: target.canonicalKey,
				compacted: false,
				kept: totalLines
			}, void 0);
			return;
		}
		const archived = archiveFileOnDisk(filePath, "bak");
		fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
		await updateSessionStore(storePath, (store) => {
			const entryToUpdate = store[compactTarget.primaryKey];
			if (!entryToUpdate) return;
			delete entryToUpdate.inputTokens;
			delete entryToUpdate.outputTokens;
			delete entryToUpdate.totalTokens;
			delete entryToUpdate.totalTokensFresh;
			entryToUpdate.updatedAt = Date.now();
		});
		respond(true, {
			ok: true,
			key: target.canonicalKey,
			compacted: true,
			archived,
			kept: lines.length
		}, void 0);
		emitSessionsChanged(context, {
			sessionKey: target.canonicalKey,
			reason: "compact",
			compacted: true
		});
	}
};
//#endregion
//#region src/gateway/server-methods/skills-config-mutations.ts
async function updateSkillConfigEntry(params) {
	return (await mutateConfigFileWithRetry({
		afterWrite: { mode: "auto" },
		mutate: (draft) => {
			const skills = draft.skills ? { ...draft.skills } : {};
			const entries = skills.entries ? { ...skills.entries } : {};
			const current = entries[params.skillKey] ? { ...entries[params.skillKey] } : {};
			if (typeof params.enabled === "boolean") current.enabled = params.enabled;
			if (typeof params.apiKey === "string") {
				const trimmed = normalizeSecretInput(params.apiKey);
				if (trimmed === "__OPENCLAW_REDACTED__") {} else if (trimmed) current.apiKey = trimmed;
				else delete current.apiKey;
			}
			if (params.env && typeof params.env === "object") {
				const nextEnv = current.env ? { ...current.env } : {};
				for (const [key, value] of Object.entries(params.env)) {
					const trimmedKey = key.trim();
					if (!trimmedKey) continue;
					const trimmedVal = value.trim();
					if (trimmedVal === "__OPENCLAW_REDACTED__") continue;
					if (!trimmedVal) delete nextEnv[trimmedKey];
					else nextEnv[trimmedKey] = trimmedVal;
				}
				current.env = nextEnv;
			}
			entries[params.skillKey] = current;
			skills.entries = entries;
			draft.skills = skills;
			return current;
		}
	})).result ?? {};
}
const MAX_SKILL_UPLOAD_BASE64_LENGTH = Math.ceil(4 * 1024 * 1024 / 3) * 4;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const locks = /* @__PURE__ */ new Map();
var SkillUploadRequestError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "SkillUploadRequestError";
	}
};
async function withLock(key, fn) {
	let entry = locks.get(key);
	if (!entry) {
		entry = {
			lock: createAsyncLock(),
			references: 0
		};
		locks.set(key, entry);
	}
	entry.references += 1;
	try {
		return await entry.lock(fn);
	} finally {
		entry.references -= 1;
		if (entry.references === 0) locks.delete(key);
	}
}
function normalizeSkillUploadSha256(value) {
	if (value === void 0) return;
	const normalized = value.trim().toLowerCase();
	if (!SHA256_PATTERN.test(normalized)) throw new SkillUploadRequestError("invalid sha256");
	return normalized;
}
function validateUploadId(uploadId) {
	const normalized = uploadId.trim();
	if (!UPLOAD_ID_PATTERN.test(normalized)) throw new SkillUploadRequestError("invalid uploadId");
	return normalized;
}
function isUploadId(value) {
	return UPLOAD_ID_PATTERN.test(value);
}
function validateSizeBytes(sizeBytes) {
	if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new SkillUploadRequestError("invalid sizeBytes");
	if (sizeBytes > 268435456) throw new SkillUploadRequestError("skill archive exceeds maximum upload size");
	return sizeBytes;
}
function validateUploadSlug(slug) {
	try {
		return validateRequestedSkillSlug(slug);
	} catch (err) {
		throw new SkillUploadRequestError(formatErrorMessage(err));
	}
}
function validateOffset(offset) {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new SkillUploadRequestError("invalid offset");
	return offset;
}
function validateIdempotencyKey(value) {
	const normalized = value?.trim();
	if (!normalized) return;
	if (normalized.length > 2048) throw new SkillUploadRequestError("idempotencyKey is too long");
	return normalized;
}
function hashText(value) {
	return createHash("sha256").update(value).digest("hex");
}
function resolveUploadsRoot(rootDir) {
	return path.resolve(rootDir ?? path.join(resolveStateDir(), "tmp", "skill-uploads"));
}
function resolveUploadDir(rootDir, uploadId) {
	return path.join(rootDir, validateUploadId(uploadId));
}
function resolveMetadataPath(rootDir, uploadId) {
	return path.join(resolveUploadDir(rootDir, uploadId), "metadata.json");
}
function resolveArchivePath(rootDir, uploadId) {
	return path.join(resolveUploadDir(rootDir, uploadId), "archive.zip");
}
function resolveIdempotencyPath(rootDir, keyHash) {
	return path.join(rootDir, "idempotency", `${keyHash}.json`);
}
function estimateBase64DecodedBytes(value) {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return value.length / 4 * 3 - padding;
}
function decodeBase64Chunk(dataBase64) {
	const normalized = dataBase64.trim();
	if (!normalized || normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) throw new SkillUploadRequestError("invalid dataBase64");
	if (normalized.length > MAX_SKILL_UPLOAD_BASE64_LENGTH) throw new SkillUploadRequestError("upload chunk exceeds maximum size");
	if (estimateBase64DecodedBytes(normalized) > 4194304) throw new SkillUploadRequestError("upload chunk exceeds maximum size");
	const decoded = Buffer.from(normalized, "base64");
	if (decoded.length < 1) throw new SkillUploadRequestError("empty upload chunk");
	if (decoded.length > 4194304) throw new SkillUploadRequestError("upload chunk exceeds maximum size");
	return decoded;
}
async function assertNotExpired(rootDir, record, now) {
	if (record.expiresAt <= now) {
		await removeRecordFiles(rootDir, record);
		throw new SkillUploadRequestError("upload has expired");
	}
}
async function computeFileSha256(filePath) {
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) digest.update(chunk);
	return digest.digest("hex");
}
async function readRecord(rootDir, uploadId) {
	const record = await readDurableJsonFile(resolveMetadataPath(rootDir, uploadId));
	if (!record || record.version !== 1 || record.uploadId !== uploadId) throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
	return {
		...record,
		archivePath: resolveArchivePath(rootDir, uploadId)
	};
}
async function readRecordIfPresent(rootDir, uploadId) {
	const record = await readDurableJsonFile(resolveMetadataPath(rootDir, uploadId));
	if (!record || record.version !== 1 || record.uploadId !== uploadId) return null;
	return {
		...record,
		archivePath: resolveArchivePath(rootDir, uploadId)
	};
}
async function writeRecord(rootDir, record) {
	await writeJson(resolveMetadataPath(rootDir, record.uploadId), record, {
		mode: 384,
		dirMode: 448,
		trailingNewline: true
	});
}
async function removeUploadDir(rootDir, uploadId) {
	await fs$1.rm(resolveUploadDir(rootDir, uploadId), {
		recursive: true,
		force: true
	});
}
async function removeRecordFiles(rootDir, record) {
	await removeUploadDir(rootDir, record.uploadId);
	if (record.idempotencyKeyHash) await fs$1.rm(resolveIdempotencyPath(rootDir, record.idempotencyKeyHash), { force: true });
}
async function listUploadIds(rootDir) {
	return (await fs$1.readdir(rootDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && isUploadId(entry.name)).map((entry) => entry.name);
}
async function cleanupExpiredUploads(rootDir, nowMs, excludeUploadId) {
	for (const uploadId of await listUploadIds(rootDir)) {
		if (uploadId === excludeUploadId) continue;
		await withLock(`${rootDir}:upload:${uploadId}`, async () => {
			const record = await readRecordIfPresent(rootDir, uploadId).catch(() => null);
			if (record && record.expiresAt <= nowMs) await removeRecordFiles(rootDir, record);
		});
	}
}
async function countActiveUploads(rootDir, nowMs) {
	let count = 0;
	for (const uploadId of await listUploadIds(rootDir)) {
		const record = await readRecordIfPresent(rootDir, uploadId).catch(() => null);
		if (record && record.expiresAt > nowMs) count += 1;
	}
	return count;
}
async function writeArchiveChunk(params) {
	const handle = await fs$1.open(params.archivePath, "r+");
	try {
		await handle.truncate(params.offset);
		let written = 0;
		while (written < params.decoded.length) {
			const result = await handle.write(params.decoded, written, params.decoded.length - written, params.offset + written);
			if (result.bytesWritten <= 0) throw new Error("failed to write upload chunk");
			written += result.bytesWritten;
		}
		await handle.sync();
		await params.afterSync();
	} finally {
		await handle.close().catch(() => void 0);
	}
}
async function readCommittedRecord(rootDir, uploadId, nowMs) {
	const record = await readRecord(rootDir, uploadId);
	await assertNotExpired(rootDir, record, nowMs);
	if (!record.committed) throw new SkillUploadRequestError("upload is not committed");
	if (!record.actualSha256) throw new SkillUploadRequestError("committed upload is missing sha256");
	const stat = await fs$1.stat(record.archivePath).catch(() => null);
	if (!stat || stat.size !== record.sizeBytes) throw new SkillUploadRequestError("uploaded archive is missing or incomplete");
	return record;
}
function createSkillUploadStore(options) {
	const rootDir = resolveUploadsRoot(options?.rootDir);
	const now = options?.now ?? Date.now;
	const ttlMs = options?.ttlMs ?? 36e5;
	return {
		rootDir,
		async begin(params) {
			return await withLock(`${rootDir}:begin`, async () => {
				await cleanupExpiredUploads(rootDir, now());
				if (params.kind !== "skill-archive") throw new SkillUploadRequestError("unsupported upload kind");
				const slug = validateUploadSlug(params.slug);
				const sizeBytes = validateSizeBytes(params.sizeBytes);
				const sha256 = normalizeSkillUploadSha256(params.sha256);
				const force = params.force === true;
				const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);
				const keyHash = idempotencyKey ? hashText(idempotencyKey) : void 0;
				if (keyHash) {
					const existing = await readDurableJsonFile(resolveIdempotencyPath(rootDir, keyHash));
					if (existing) {
						if (existing.kind !== params.kind || existing.slug !== slug || existing.force !== force || existing.sizeBytes !== sizeBytes || existing.sha256 !== sha256) throw new SkillUploadRequestError("idempotencyKey conflicts with a different upload");
						const existingUploadId = validateUploadId(existing.uploadId);
						const activeExisting = await withLock(`${rootDir}:upload:${existingUploadId}`, async () => {
							const record = await readRecordIfPresent(rootDir, existingUploadId);
							if (record && record.expiresAt > now()) return {
								uploadId: record.uploadId,
								receivedBytes: record.receivedBytes,
								expiresAt: record.expiresAt
							};
							if (record) await removeRecordFiles(rootDir, record);
							else await removeUploadDir(rootDir, existingUploadId);
							return null;
						});
						if (activeExisting) return activeExisting;
					}
				}
				if (await countActiveUploads(rootDir, now()) >= 32) throw new SkillUploadRequestError("too many active skill uploads");
				const uploadId = randomUUID();
				const uploadDir = resolveUploadDir(rootDir, uploadId);
				const archivePath = resolveArchivePath(rootDir, uploadId);
				const createdAt = now();
				const record = {
					version: 1,
					kind: params.kind,
					uploadId,
					slug,
					force,
					sizeBytes,
					...sha256 ? { sha256 } : {},
					receivedBytes: 0,
					archivePath,
					createdAt,
					expiresAt: createdAt + ttlMs,
					committed: false,
					...keyHash ? { idempotencyKeyHash: keyHash } : {}
				};
				await fs$1.mkdir(uploadDir, {
					recursive: true,
					mode: 448
				});
				await fs$1.writeFile(archivePath, Buffer.alloc(0), { mode: 384 });
				await writeRecord(rootDir, record);
				if (keyHash) {
					const idem = {
						version: 1,
						keyHash,
						uploadId,
						kind: params.kind,
						slug,
						force,
						sizeBytes,
						...sha256 ? { sha256 } : {}
					};
					await writeJson(resolveIdempotencyPath(rootDir, keyHash), idem, {
						mode: 384,
						dirMode: 448,
						trailingNewline: true
					});
				}
				return {
					uploadId,
					receivedBytes: 0,
					expiresAt: record.expiresAt
				};
			});
		},
		async chunk(params) {
			const uploadId = validateUploadId(params.uploadId);
			const offset = validateOffset(params.offset);
			const decoded = decodeBase64Chunk(params.dataBase64);
			await cleanupExpiredUploads(rootDir, now(), uploadId);
			return await withLock(`${rootDir}:upload:${uploadId}`, async () => {
				const record = await readRecord(rootDir, uploadId);
				await assertNotExpired(rootDir, record, now());
				if (record.committed) throw new SkillUploadRequestError("upload is already committed");
				if (offset !== record.receivedBytes) throw new SkillUploadRequestError(`upload offset mismatch: expected ${record.receivedBytes}, got ${offset}`);
				const nextSize = record.receivedBytes + decoded.length;
				if (nextSize > record.sizeBytes) throw new SkillUploadRequestError("upload chunk exceeds declared size");
				const nextRecord = {
					...record,
					receivedBytes: nextSize
				};
				await writeArchiveChunk({
					archivePath: record.archivePath,
					offset: record.receivedBytes,
					decoded,
					afterSync: async () => {
						await writeRecord(rootDir, nextRecord);
					}
				});
				return {
					uploadId,
					receivedBytes: nextRecord.receivedBytes,
					expiresAt: nextRecord.expiresAt
				};
			});
		},
		async commit(params) {
			const uploadId = validateUploadId(params.uploadId);
			const requestedSha = normalizeSkillUploadSha256(params.sha256);
			return await withLock(`${rootDir}:upload:${uploadId}`, async () => {
				const record = await readRecord(rootDir, uploadId);
				await assertNotExpired(rootDir, record, now());
				if (record.committed) {
					if (!record.actualSha256) throw new SkillUploadRequestError("committed upload is missing sha256");
					if (requestedSha && requestedSha !== record.actualSha256) throw new SkillUploadRequestError("upload sha256 mismatch");
					return {
						uploadId,
						receivedBytes: record.receivedBytes,
						sha256: record.actualSha256,
						expiresAt: record.expiresAt
					};
				}
				if (record.receivedBytes !== record.sizeBytes) throw new SkillUploadRequestError(`upload size mismatch: expected ${record.sizeBytes}, got ${record.receivedBytes}`);
				const stat = await fs$1.stat(record.archivePath).catch(() => null);
				if (!stat || stat.size !== record.sizeBytes) throw new SkillUploadRequestError("uploaded archive is missing or incomplete");
				if (record.sha256 && requestedSha && record.sha256 !== requestedSha) throw new SkillUploadRequestError("upload sha256 does not match begin sha256");
				const actualSha256 = await computeFileSha256(record.archivePath);
				const expectedSha = requestedSha ?? record.sha256;
				if (expectedSha && expectedSha !== actualSha256) throw new SkillUploadRequestError("upload sha256 mismatch");
				const nextRecord = {
					...record,
					sha256: record.sha256 ?? requestedSha ?? actualSha256,
					actualSha256,
					committed: true,
					committedAt: now()
				};
				await writeRecord(rootDir, nextRecord);
				return {
					uploadId,
					receivedBytes: nextRecord.receivedBytes,
					sha256: actualSha256,
					expiresAt: nextRecord.expiresAt
				};
			});
		},
		async withCommittedUpload(uploadIdRaw, action) {
			const uploadId = validateUploadId(uploadIdRaw);
			return await withLock(`${rootDir}:upload:${uploadId}`, async () => {
				const record = await readCommittedRecord(rootDir, uploadId, now());
				return await action(record, { remove: async () => {
					await removeRecordFiles(rootDir, record);
				} });
			});
		},
		async remove(uploadIdRaw) {
			const uploadId = validateUploadId(uploadIdRaw);
			await withLock(`${rootDir}:upload:${uploadId}`, async () => {
				const record = await readDurableJsonFile(resolveMetadataPath(rootDir, uploadId));
				if (record && record.version === 1 && record.uploadId === uploadId) await removeRecordFiles(rootDir, record);
				else await removeUploadDir(rootDir, uploadId);
			});
		}
	};
}
const defaultSkillUploadStore = createSkillUploadStore();
//#endregion
//#region src/gateway/server-methods/skills-upload.ts
const UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE = "Uploaded skill archive installs are disabled by skills.install.allowUploadedArchives";
function areUploadedSkillArchivesEnabled(config) {
	return config.skills?.install?.allowUploadedArchives === true;
}
function uploadErrorShape(prefix, errors) {
	return errorShape(ErrorCodes.INVALID_REQUEST, `${prefix}: ${formatValidationErrors(errors)}`);
}
function mapUploadError(err) {
	if (err instanceof SkillUploadRequestError) return errorShape(ErrorCodes.INVALID_REQUEST, err.message);
	return errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err));
}
function uploadInstallFailureErrorCode(failureKind) {
	return failureKind === "invalid-request" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE;
}
const skillsUploadHandlers = {
	"skills.upload.begin": makeUploadHandler("skills.upload.begin", validateSkillsUploadBeginParams, (params) => defaultSkillUploadStore.begin(params)),
	"skills.upload.chunk": makeUploadHandler("skills.upload.chunk", validateSkillsUploadChunkParams, (params) => defaultSkillUploadStore.chunk(params)),
	"skills.upload.commit": makeUploadHandler("skills.upload.commit", validateSkillsUploadCommitParams, (params) => defaultSkillUploadStore.commit(params))
};
function makeUploadHandler(name, validator, action) {
	return async ({ params, respond, context }) => {
		if (!areUploadedSkillArchivesEnabled(context.getRuntimeConfig())) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE));
			return;
		}
		if (!validator(params)) {
			respond(false, void 0, uploadErrorShape(`invalid ${name} params`, validator.errors));
			return;
		}
		try {
			respond(true, await action(params), void 0);
		} catch (err) {
			respond(false, void 0, mapUploadError(err));
		}
	};
}
async function installUploadedSkillArchive(params) {
	const store = params.store ?? defaultSkillUploadStore;
	if (!areUploadedSkillArchivesEnabled(params.context.getRuntimeConfig())) return {
		ok: false,
		error: UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE,
		errorCode: ErrorCodes.UNAVAILABLE
	};
	try {
		const requestedSlug = validateRequestedSkillSlug(params.slug);
		const requestedSha = normalizeSkillUploadSha256(params.sha256);
		return await store.withCommittedUpload(params.uploadId, async (record, upload) => {
			const rejectInvalid = async (error) => {
				await upload.remove().catch(() => void 0);
				return {
					ok: false,
					error,
					errorCode: ErrorCodes.INVALID_REQUEST
				};
			};
			if (record.kind !== "skill-archive") return await rejectInvalid("unsupported upload kind");
			if (record.slug !== requestedSlug) return await rejectInvalid("install slug does not match upload slug");
			if (record.force !== params.force) return await rejectInvalid("install force does not match upload force");
			if (requestedSha && requestedSha !== record.actualSha256) return await rejectInvalid("install sha256 does not match uploaded archive");
			if (!record.actualSha256) return await rejectInvalid("committed upload is missing sha256");
			const install = await installSkillArchiveFromPath({
				archivePath: record.archivePath,
				workspaceDir: params.workspaceDir,
				slug: record.slug,
				force: record.force,
				timeoutMs: params.timeoutMs,
				logger: params.context.logGateway,
				scan: {
					installId: "upload",
					origin: "skill-upload"
				}
			});
			if (!install.ok) {
				const errorCode = uploadInstallFailureErrorCode(install.failureKind);
				if (install.failureKind === "invalid-request") await upload.remove().catch(() => void 0);
				return {
					ok: false,
					error: install.error,
					errorCode
				};
			}
			await upload.remove().catch(() => void 0);
			return {
				ok: true,
				message: `Installed ${record.slug}`,
				stdout: "",
				stderr: "",
				code: 0,
				slug: record.slug,
				targetDir: install.targetDir,
				sha256: record.actualSha256
			};
		});
	} catch (err) {
		if (err instanceof SkillUploadRequestError) return {
			ok: false,
			error: err.message,
			errorCode: ErrorCodes.INVALID_REQUEST
		};
		const error = formatErrorMessage(err);
		if (error.startsWith("Invalid skill slug")) return {
			ok: false,
			error,
			errorCode: ErrorCodes.INVALID_REQUEST
		};
		return {
			ok: false,
			error,
			errorCode: ErrorCodes.UNAVAILABLE
		};
	}
}
//#endregion
//#region src/gateway/server-methods/skills.ts
function collectSkillBins(entries) {
	const bins = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		const required = entry.metadata?.requires?.bins ?? [];
		const anyBins = entry.metadata?.requires?.anyBins ?? [];
		const install = entry.metadata?.install ?? [];
		for (const bin of required) {
			const trimmed = bin.trim();
			if (trimmed) bins.add(trimmed);
		}
		for (const bin of anyBins) {
			const trimmed = bin.trim();
			if (trimmed) bins.add(trimmed);
		}
		for (const spec of install) {
			const specBins = spec?.bins ?? [];
			for (const bin of specBins) {
				const trimmed = normalizeOptionalString$1(bin) ?? "";
				if (trimmed) bins.add(trimmed);
			}
		}
	}
	return [...bins].toSorted();
}
const skillsHandlers = {
	...skillsUploadHandlers,
	"skills.status": ({ params, respond, context }) => {
		if (!validateSkillsStatusParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`));
			return;
		}
		const cfg = context.getRuntimeConfig();
		const agentIdRaw = normalizeOptionalString$1(params?.agentId) ?? "";
		const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
		if (agentIdRaw) {
			if (!listAgentIds(cfg).includes(agentId)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`));
				return;
			}
		}
		respond(true, buildWorkspaceSkillStatus(resolveAgentWorkspaceDir(cfg, agentId), {
			config: cfg,
			eligibility: { remote: getRemoteSkillEligibility({ advertiseExecNode: canExecRequestNode({
				cfg,
				agentId
			}) }) }
		}), void 0);
	},
	"skills.bins": ({ params, respond, context }) => {
		if (!validateSkillsBinsParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`));
			return;
		}
		const cfg = context.getRuntimeConfig();
		const workspaceDirs = listAgentWorkspaceDirs(cfg);
		const bins = /* @__PURE__ */ new Set();
		for (const workspaceDir of workspaceDirs) {
			const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
			for (const bin of collectSkillBins(entries)) bins.add(bin);
		}
		respond(true, { bins: [...bins].toSorted() }, void 0);
	},
	"skills.search": async ({ params, respond }) => {
		if (!validateSkillsSearchParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid skills.search params: ${formatValidationErrors(validateSkillsSearchParams.errors)}`));
			return;
		}
		try {
			respond(true, { results: await searchSkillsFromClawHub({
				query: params.query,
				limit: params.limit
			}) }, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
		}
	},
	"skills.detail": async ({ params, respond }) => {
		if (!validateSkillsDetailParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid skills.detail params: ${formatValidationErrors(validateSkillsDetailParams.errors)}`));
			return;
		}
		try {
			respond(true, await fetchClawHubSkillDetail({ slug: params.slug }), void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
		}
	},
	"skills.install": async ({ params, respond, context }) => {
		if (!validateSkillsInstallParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`));
			return;
		}
		const cfg = context.getRuntimeConfig();
		const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
		if (params && typeof params === "object" && "source" in params && params.source === "clawhub") {
			const p = params;
			const result = await installSkillFromClawHub({
				workspaceDir: workspaceDirRaw,
				slug: p.slug,
				version: p.version,
				force: Boolean(p.force)
			});
			respond(result.ok, result.ok ? {
				ok: true,
				message: `Installed ${result.slug}@${result.version}`,
				stdout: "",
				stderr: "",
				code: 0,
				slug: result.slug,
				version: result.version,
				targetDir: result.targetDir
			} : result, result.ok ? void 0 : errorShape(ErrorCodes.UNAVAILABLE, result.error));
			return;
		}
		if (params && typeof params === "object" && "source" in params && params.source === "upload") {
			const p = params;
			const result = await installUploadedSkillArchive({
				uploadId: p.uploadId,
				slug: p.slug,
				force: Boolean(p.force),
				sha256: p.sha256,
				timeoutMs: p.timeoutMs,
				workspaceDir: workspaceDirRaw,
				context
			});
			respond(result.ok, result, result.ok ? void 0 : errorShape(result.errorCode, result.error));
			return;
		}
		const p = params;
		const result = await installSkill({
			workspaceDir: workspaceDirRaw,
			skillName: p.name,
			installId: p.installId,
			dangerouslyForceUnsafeInstall: p.dangerouslyForceUnsafeInstall,
			timeoutMs: p.timeoutMs,
			config: cfg
		});
		respond(result.ok, result, result.ok ? void 0 : errorShape(ErrorCodes.UNAVAILABLE, result.message));
	},
	"skills.update": async ({ params, respond, context }) => {
		if (!validateSkillsUpdateParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`));
			return;
		}
		if (params && typeof params === "object" && "source" in params && params.source === "clawhub") {
			const p = params;
			if (!p.slug && !p.all) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "clawhub skills.update requires \"slug\" or \"all\""));
				return;
			}
			if (p.slug && p.all) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "clawhub skills.update accepts either \"slug\" or \"all\", not both"));
				return;
			}
			const cfg = context.getRuntimeConfig();
			const results = await updateSkillsFromClawHub({
				workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
				slug: p.slug
			});
			const errors = results.filter((result) => !result.ok);
			respond(errors.length === 0, {
				ok: errors.length === 0,
				skillKey: p.slug ?? "*",
				config: {
					source: "clawhub",
					results
				}
			}, errors.length === 0 ? void 0 : errorShape(ErrorCodes.UNAVAILABLE, errors.map((result) => result.error).join("; ")));
			return;
		}
		const p = params;
		const updated = await updateSkillConfigEntry(p);
		respond(true, {
			ok: true,
			skillKey: p.skillKey,
			config: redactConfigObject(updated)
		}, void 0);
	}
};
//#endregion
//#region src/gateway/server-methods/system.ts
const systemHandlers = {
	"gateway.identity.get": ({ respond }) => {
		const identity = loadOrCreateDeviceIdentity();
		respond(true, {
			deviceId: identity.deviceId,
			publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem)
		}, void 0);
	},
	"last-heartbeat": ({ respond }) => {
		respond(true, getLastHeartbeatEvent(), void 0);
	},
	"set-heartbeats": ({ params, respond }) => {
		const enabled = params.enabled;
		if (typeof enabled !== "boolean") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid set-heartbeats params: enabled (boolean) required"));
			return;
		}
		setHeartbeatsEnabled(enabled);
		respond(true, {
			ok: true,
			enabled
		}, void 0);
	},
	"system-presence": ({ respond }) => {
		respond(true, listSystemPresence(), void 0);
	},
	"system-event": ({ params, respond, context }) => {
		const text = normalizeOptionalString$1(params.text) ?? "";
		if (!text) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "text required"));
			return;
		}
		const sessionKey = resolveMainSessionKeyFromConfig();
		const deviceId = readStringValue(params.deviceId);
		const instanceId = readStringValue(params.instanceId);
		const host = readStringValue(params.host);
		const ip = readStringValue(params.ip);
		const mode = readStringValue(params.mode);
		const version = readStringValue(params.version);
		const platform = readStringValue(params.platform);
		const deviceFamily = readStringValue(params.deviceFamily);
		const modelIdentifier = readStringValue(params.modelIdentifier);
		const lastInputSeconds = typeof params.lastInputSeconds === "number" && Number.isFinite(params.lastInputSeconds) ? params.lastInputSeconds : void 0;
		const reason = readStringValue(params.reason);
		const presenceUpdate = updateSystemPresence({
			text,
			deviceId,
			instanceId,
			host,
			ip,
			mode,
			version,
			platform,
			deviceFamily,
			modelIdentifier,
			lastInputSeconds,
			reason,
			roles: Array.isArray(params.roles) && params.roles.every((t) => typeof t === "string") ? params.roles : void 0,
			scopes: Array.isArray(params.scopes) && params.scopes.every((t) => typeof t === "string") ? params.scopes : void 0,
			tags: Array.isArray(params.tags) && params.tags.every((t) => typeof t === "string") ? params.tags : void 0
		});
		if (text.startsWith("Node:")) {
			const next = presenceUpdate.next;
			const changed = new Set(presenceUpdate.changedKeys);
			const reasonValue = next.reason ?? reason;
			const normalizedReason = normalizeLowercaseStringOrEmpty(reasonValue);
			const ignoreReason = normalizedReason.startsWith("periodic") || normalizedReason === "heartbeat";
			const hostChanged = changed.has("host");
			const ipChanged = changed.has("ip");
			const versionChanged = changed.has("version");
			const modeChanged = changed.has("mode");
			const reasonChanged = changed.has("reason") && !ignoreReason;
			if (hostChanged || ipChanged || versionChanged || modeChanged || reasonChanged) {
				const contextChanged = isSystemEventContextChanged(sessionKey, presenceUpdate.key);
				const parts = [];
				if (contextChanged || hostChanged || ipChanged) {
					const hostLabel = normalizeOptionalString$1(next.host) ?? "Unknown";
					const ipLabel = normalizeOptionalString$1(next.ip);
					parts.push(`Node: ${hostLabel}${ipLabel ? ` (${ipLabel})` : ""}`);
				}
				if (versionChanged) parts.push(`app ${normalizeOptionalString$1(next.version) ?? "unknown"}`);
				if (modeChanged) parts.push(`mode ${normalizeOptionalString$1(next.mode) ?? "unknown"}`);
				if (reasonChanged) parts.push(`reason ${normalizeOptionalString$1(reasonValue) ?? "event"}`);
				const deltaText = parts.join(" · ");
				if (deltaText) enqueueSystemEvent(deltaText, {
					sessionKey,
					contextKey: presenceUpdate.key
				});
			}
		} else enqueueSystemEvent(text, { sessionKey });
		broadcastPresenceSnapshot({
			broadcast: context.broadcast,
			incrementPresenceVersion: context.incrementPresenceVersion,
			getHealthVersion: context.getHealthVersion
		});
		respond(true, { ok: true }, void 0);
	}
};
//#endregion
//#region src/gateway/talk-session-registry.ts
const unifiedTalkSessions = /* @__PURE__ */ new Map();
function rememberUnifiedTalkSession(sessionId, session) {
	unifiedTalkSessions.set(sessionId, session);
}
function getUnifiedTalkSession(sessionId) {
	const session = unifiedTalkSessions.get(sessionId);
	if (!session) throw new Error("Unknown Talk session");
	return session;
}
function forgetUnifiedTalkSession(sessionId) {
	unifiedTalkSessions.delete(sessionId);
}
function requireUnifiedTalkSessionConn(session, connId) {
	if (!connId || session.connId !== connId) throw new Error("Talk session is not owned by this connection");
	return connId;
}
//#endregion
//#region src/gateway/talk-realtime-relay.ts
const RELAY_SESSION_TTL_MS = 1800 * 1e3;
const MAX_AUDIO_BASE64_BYTES$1 = 512 * 1024;
const MAX_RELAY_SESSIONS_PER_CONN = 2;
const MAX_RELAY_SESSIONS_GLOBAL = 64;
const RELAY_EVENT = "talk.event";
const FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const FORCED_CONSULT_NATIVE_DEDUPE_MS = 2e3;
const FORCED_CONSULT_RESULT_MAX_CHARS = 1800;
const CONSULT_QUESTION_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"can",
	"check",
	"could",
	"for",
	"in",
	"is",
	"it",
	"look",
	"me",
	"of",
	"on",
	"or",
	"please",
	"see",
	"that",
	"the",
	"this",
	"to",
	"would",
	"you"
]);
const relaySessions = /* @__PURE__ */ new Map();
function formatError(error) {
	return error instanceof Error ? error.message : String(error);
}
function readSpeakableToolResultText(result) {
	if (!result || typeof result !== "object" || Array.isArray(result)) return;
	const record = result;
	const value = typeof record.text === "string" ? record.text : typeof record.result === "string" ? record.result : record.error;
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed) return;
	return trimmed.length <= FORCED_CONSULT_RESULT_MAX_CHARS ? trimmed : `${trimmed.slice(0, FORCED_CONSULT_RESULT_MAX_CHARS - 16).trimEnd()} [truncated]`;
}
function isWorkingToolResult(result) {
	return Boolean(result) && typeof result === "object" && !Array.isArray(result) && result.status === "working";
}
function readConsultQuestion(args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return;
	const record = args;
	for (const key of [
		"question",
		"prompt",
		"query",
		"task"
	]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
}
function normalizeConsultQuestion(value) {
	return value?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim() || void 0;
}
function questionTokens(value) {
	const normalized = normalizeConsultQuestion(value);
	if (!normalized) return /* @__PURE__ */ new Set();
	return new Set(normalized.split(/[^\p{L}\p{N}]+/gu).map((token) => token.trim()).filter((token) => token.length >= 2 && !CONSULT_QUESTION_STOPWORDS.has(token)));
}
function consultQuestionsMatch(left, right) {
	const normalizedLeft = normalizeConsultQuestion(left);
	const normalizedRight = normalizeConsultQuestion(right);
	if (!normalizedLeft || !normalizedRight) return false;
	if (normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return true;
	const leftTokens = questionTokens(normalizedLeft);
	const rightTokens = questionTokens(normalizedRight);
	if (leftTokens.size === 0 || rightTokens.size === 0) return false;
	let overlap = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
	return overlap / Math.min(leftTokens.size, rightTokens.size) >= .6;
}
function buildForcedConsultCheckingPrompt() {
	return ["Briefly tell the person that you are checking with OpenClaw.", "Do not answer the request yet. Wait for the OpenClaw result before giving the actual answer."].join(" ");
}
function buildForcedConsultSpeechPrompt(text) {
	return [
		"OpenClaw finished checking. Speak this result naturally and concisely.",
		"Do not mention tool calls, JSON, or internal routing.",
		"",
		text
	].join("\n");
}
function buildAlreadyDeliveredToolResult() {
	return {
		status: "already_delivered",
		message: "OpenClaw already delivered this consult result internally. Do not repeat it."
	};
}
function clearPendingForcedConsult(session) {
	if (!session.forcedConsultTimer) return;
	clearTimeout(session.forcedConsultTimer);
	session.forcedConsultTimer = void 0;
	session.pendingForcedConsultQuestion = void 0;
}
function clearForcedConsultStates(session) {
	for (const state of session.forcedConsultCalls.values()) if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
	session.forcedConsultCalls.clear();
}
function cancelForcedConsults(session) {
	for (const state of session.forcedConsultCalls.values()) state.cancelled = true;
}
function scheduleForcedConsultCleanup(session, callId, state) {
	if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
	state.cleanupTimer = setTimeout(() => {
		if (session.forcedConsultCalls.get(callId) === state) session.forcedConsultCalls.delete(callId);
	}, FORCED_CONSULT_NATIVE_DEDUPE_MS);
	state.cleanupTimer.unref?.();
}
function findActiveForcedConsult(session, nativeArgs) {
	const nativeQuestion = readConsultQuestion(nativeArgs);
	if (!nativeQuestion) return;
	const now = Date.now();
	for (const state of session.forcedConsultCalls.values()) {
		if (state.cancelled) continue;
		if ((!state.completedAtMs || now - state.completedAtMs < FORCED_CONSULT_NATIVE_DEDUPE_MS) && consultQuestionsMatch(state.question, nativeQuestion)) return state;
	}
}
function broadcastToOwner$1(context, connId, event) {
	context.broadcastToConnIds(RELAY_EVENT, event, new Set([connId]), { dropIfSlow: true });
}
function abortRelayAgentRuns(session, reason) {
	for (const [runId, sessionKey] of session.activeAgentRuns) abortChatRunById(session.context, {
		runId,
		sessionKey,
		stopReason: reason
	});
	session.activeAgentRuns.clear();
}
function closeRelaySession(session, reason) {
	clearPendingForcedConsult(session);
	clearForcedConsultStates(session);
	relaySessions.delete(session.id);
	forgetUnifiedTalkSession(session.id);
	clearTimeout(session.cleanupTimer);
	abortRelayAgentRuns(session, reason === "error" ? "relay-error" : "relay-closed");
	session.bridge.close();
	broadcastToOwner$1(session.context, session.connId, {
		relaySessionId: session.id,
		type: "close",
		reason,
		talkEvent: session.talk.emit({
			type: "session.closed",
			payload: { reason },
			final: true
		})
	});
}
function pruneExpiredRelaySessions(nowMs = Date.now()) {
	for (const session of relaySessions.values()) if (nowMs > session.expiresAtMs) closeRelaySession(session, "completed");
}
function countRelaySessionsForConn(connId) {
	let count = 0;
	for (const session of relaySessions.values()) if (session.connId === connId) count += 1;
	return count;
}
function enforceRelaySessionLimits(connId) {
	pruneExpiredRelaySessions();
	if (relaySessions.size >= MAX_RELAY_SESSIONS_GLOBAL) throw new Error("Too many active realtime relay sessions");
	if (countRelaySessionsForConn(connId) >= MAX_RELAY_SESSIONS_PER_CONN) throw new Error("Too many active realtime relay sessions for this connection");
}
function createTalkRealtimeRelaySession(params) {
	enforceRelaySessionLimits(params.connId);
	const relaySessionId = randomUUID();
	const expiresAtMs = Date.now() + RELAY_SESSION_TTL_MS;
	const talk = createTalkSessionController({
		sessionId: relaySessionId,
		mode: "realtime",
		transport: "gateway-relay",
		brain: "agent-consult",
		provider: params.provider.id
	}, { onEvent: recordTalkObservabilityEvent });
	let relay;
	const emit = (event, talkEvent) => broadcastToOwner$1(params.context, params.connId, {
		...event,
		...talkEvent ? { talkEvent: talk.emit(talkEvent) } : {}
	});
	const bridge = createRealtimeVoiceBridgeSession({
		provider: params.provider,
		cfg: params.cfg,
		providerConfig: params.providerConfig,
		audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
		instructions: params.instructions,
		autoRespondToAudio: false,
		interruptResponseOnInputAudio: false,
		tools: params.tools,
		markStrategy: "ack-immediately",
		audioSink: {
			isOpen: () => Boolean(relay && relaySessions.has(relay.id)),
			sendAudio: (audio) => {
				const turnId = relay ? ensureRelayTurn(relay) : void 0;
				emit({
					relaySessionId,
					type: "audio",
					audioBase64: audio.toString("base64")
				}, {
					type: "output.audio.delta",
					turnId,
					payload: { byteLength: audio.length }
				});
			},
			clearAudio: () => {
				const turnId = relay ? ensureRelayTurn(relay) : void 0;
				emit({
					relaySessionId,
					type: "clear"
				}, {
					type: "output.audio.done",
					turnId,
					payload: { reason: "clear" },
					final: true
				});
			},
			sendMark: (markName) => {
				const turnId = relay ? ensureRelayTurn(relay) : void 0;
				emit({
					relaySessionId,
					type: "mark",
					markName
				}, {
					type: "output.audio.done",
					turnId,
					payload: { markName },
					final: true
				});
			}
		},
		onTranscript: (role, text, final) => {
			const turnId = relay ? ensureRelayTurn(relay) : void 0;
			emit({
				relaySessionId,
				type: "transcript",
				role,
				text,
				final
			}, {
				type: role === "assistant" ? final ? "output.text.done" : "output.text.delta" : final ? "transcript.done" : "transcript.delta",
				turnId,
				payload: role === "assistant" ? { text } : {
					role,
					text
				},
				final
			});
			if (role === "user" && final && text.trim()) {
				const question = text.trim();
				if (params.forceAgentConsultOnFinalTranscript) scheduleForcedAgentConsult(relay, question);
				else relay?.bridge.sendUserMessage(question);
			}
		},
		onToolCall: (toolCall) => {
			const turnId = relay ? ensureRelayTurn(relay) : void 0;
			if (relay && toolCall.name === "openclaw_agent_consult") {
				const nativeQuestion = readConsultQuestion(toolCall.args);
				relay.lastProviderConsult = {
					atMs: Date.now(),
					question: nativeQuestion
				};
				if (consultQuestionsMatch(relay.pendingForcedConsultQuestion, nativeQuestion)) clearPendingForcedConsult(relay);
				const forcedConsult = findActiveForcedConsult(relay, toolCall.args);
				if (forcedConsult) {
					forcedConsult.nativeCallIds.add(toolCall.callId);
					if (forcedConsult.completedAtMs) submitAlreadyDeliveredToolResult(relay, toolCall.callId, turnId);
					else submitRealtimeAgentConsultWorkingResponse(relay, toolCall.callId, turnId);
					return;
				}
				submitRealtimeAgentConsultWorkingResponse(relay, toolCall.callId, turnId);
			}
			emit({
				relaySessionId,
				type: "toolCall",
				itemId: toolCall.itemId,
				callId: toolCall.callId,
				name: toolCall.name,
				args: toolCall.args
			}, {
				type: "tool.call",
				itemId: toolCall.itemId,
				callId: toolCall.callId,
				turnId,
				payload: {
					name: toolCall.name,
					args: toolCall.args
				}
			});
		},
		onReady: () => emit({
			relaySessionId,
			type: "ready"
		}, {
			type: "session.ready",
			payload: null
		}),
		onError: (error) => emit({
			relaySessionId,
			type: "error",
			message: error.message
		}, {
			type: "session.error",
			payload: { message: error.message },
			final: true
		}),
		onClose: (reason) => {
			const active = relaySessions.get(relaySessionId);
			if (!active) return;
			clearPendingForcedConsult(active);
			clearForcedConsultStates(active);
			relaySessions.delete(relaySessionId);
			forgetUnifiedTalkSession(relaySessionId);
			clearTimeout(active.cleanupTimer);
			abortRelayAgentRuns(active, "relay-closed");
			emit({
				relaySessionId,
				type: "close",
				reason
			}, {
				type: "session.closed",
				payload: { reason },
				final: true
			});
		}
	});
	relay = {
		id: relaySessionId,
		connId: params.connId,
		context: params.context,
		bridge,
		talk,
		expiresAtMs,
		cleanupTimer: setTimeout(() => {
			const active = relaySessions.get(relaySessionId);
			if (active) closeRelaySession(active, "completed");
		}, RELAY_SESSION_TTL_MS),
		activeAgentRuns: /* @__PURE__ */ new Map(),
		forcedConsultCalls: /* @__PURE__ */ new Map()
	};
	relay.cleanupTimer.unref?.();
	relaySessions.set(relaySessionId, relay);
	bridge.connect().catch((error) => {
		emit({
			relaySessionId,
			type: "error",
			message: formatError(error)
		});
		const active = relaySessions.get(relaySessionId);
		if (active) closeRelaySession(active, "error");
	});
	return {
		provider: params.provider.id,
		transport: "gateway-relay",
		relaySessionId,
		audio: {
			inputEncoding: "pcm16",
			inputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
			outputEncoding: "pcm16",
			outputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz
		},
		...params.model ? { model: params.model } : {},
		...params.voice ? { voice: params.voice } : {},
		expiresAt: Math.floor(expiresAtMs / 1e3)
	};
}
function scheduleForcedAgentConsult(session, question) {
	if (!session || !question.trim()) return;
	clearPendingForcedConsult(session);
	session.pendingForcedConsultQuestion = question;
	session.forcedConsultTimer = setTimeout(() => {
		session.forcedConsultTimer = void 0;
		session.pendingForcedConsultQuestion = void 0;
		if (!relaySessions.has(session.id)) return;
		const providerConsult = session.lastProviderConsult;
		if (providerConsult && Date.now() - providerConsult.atMs < FORCED_CONSULT_NATIVE_DEDUPE_MS && consultQuestionsMatch(providerConsult.question, question)) return;
		const turnId = ensureRelayTurn(session);
		const callId = `forced-consult-${randomUUID()}`;
		const itemId = `forced-consult-item-${randomUUID()}`;
		session.forcedConsultCalls.set(callId, {
			question,
			nativeCallIds: /* @__PURE__ */ new Set()
		});
		session.bridge.handleBargeIn({
			audioPlaybackActive: true,
			force: true
		});
		broadcastToOwner$1(session.context, session.connId, {
			relaySessionId: session.id,
			type: "toolCall",
			itemId,
			callId,
			name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
			forced: true,
			args: {
				question,
				context: "The realtime provider produced a final user transcript without invoking openclaw_agent_consult, so OpenClaw is forcing the consult for realtime Talk.",
				responseStyle: "Reply in a concise spoken tone."
			},
			talkEvent: session.talk.emit({
				type: "tool.call",
				itemId,
				callId,
				turnId,
				payload: {
					name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
					args: { question },
					forced: true
				}
			})
		});
	}, FORCED_CONSULT_FALLBACK_DELAY_MS);
	session.forcedConsultTimer.unref?.();
}
function submitAlreadyDeliveredToolResult(session, callId, turnId = ensureRelayTurn(session)) {
	const result = buildAlreadyDeliveredToolResult();
	session.bridge.submitToolResult(callId, result, { suppressResponse: true });
	broadcastToOwner$1(session.context, session.connId, {
		relaySessionId: session.id,
		type: "toolResult",
		callId,
		talkEvent: session.talk.emit({
			type: "tool.result",
			callId,
			turnId,
			payload: {
				name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
				result
			},
			final: true
		})
	});
}
function submitRealtimeAgentConsultWorkingResponse(session, callId, turnId = ensureRelayTurn(session)) {
	if (!session.bridge.bridge.supportsToolResultContinuation) return;
	session.bridge.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("person"), { willContinue: true });
	broadcastToOwner$1(session.context, session.connId, {
		relaySessionId: session.id,
		type: "toolResult",
		callId,
		talkEvent: session.talk.emit({
			type: "tool.progress",
			callId,
			turnId,
			payload: {
				name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
				status: "working"
			}
		})
	});
}
function ensureRelayTurn(session) {
	const turn = session.talk.ensureTurn();
	if (turn.event) broadcastToOwner$1(session.context, session.connId, {
		relaySessionId: session.id,
		type: "inputAudio",
		byteLength: 0,
		talkEvent: turn.event
	});
	return turn.turnId;
}
function getRelaySession(relaySessionId, connId) {
	const session = relaySessions.get(relaySessionId);
	if (!session || session.connId !== connId || Date.now() > session.expiresAtMs) {
		if (session) closeRelaySession(session, "completed");
		throw new Error("Unknown realtime relay session");
	}
	return session;
}
function sendTalkRealtimeRelayAudio(params) {
	if (params.audioBase64.length > MAX_AUDIO_BASE64_BYTES$1) throw new Error("Realtime relay audio frame is too large");
	const session = getRelaySession(params.relaySessionId, params.connId);
	const turnId = ensureRelayTurn(session);
	const audio = Buffer.from(params.audioBase64, "base64");
	session.bridge.sendAudio(audio);
	broadcastToOwner$1(session.context, session.connId, {
		relaySessionId: session.id,
		type: "inputAudio",
		byteLength: audio.byteLength,
		talkEvent: session.talk.emit({
			type: "input.audio.delta",
			turnId,
			payload: { byteLength: audio.byteLength }
		})
	});
	if (typeof params.timestamp === "number" && Number.isFinite(params.timestamp)) session.bridge.setMediaTimestamp(params.timestamp);
}
function submitTalkRealtimeRelayToolResult(params) {
	const session = getRelaySession(params.relaySessionId, params.connId);
	const forcedConsult = session.forcedConsultCalls.get(params.callId);
	if (forcedConsult) {
		const turnId = ensureRelayTurn(session);
		if (forcedConsult.cancelled) forcedConsult.completedAtMs = Date.now();
		else if (isWorkingToolResult(params.result)) session.bridge.sendUserMessage(buildForcedConsultCheckingPrompt());
		else {
			forcedConsult.completedAtMs = Date.now();
			const text = readSpeakableToolResultText(params.result);
			for (const nativeCallId of forcedConsult.nativeCallIds) submitAlreadyDeliveredToolResult(session, nativeCallId, turnId);
			if (text) session.bridge.sendUserMessage(buildForcedConsultSpeechPrompt(text));
			scheduleForcedConsultCleanup(session, params.callId, forcedConsult);
		}
		const final = params.options?.willContinue !== true;
		if (forcedConsult.cancelled && final) scheduleForcedConsultCleanup(session, params.callId, forcedConsult);
		broadcastToOwner$1(session.context, session.connId, {
			relaySessionId: session.id,
			type: "toolResult",
			callId: params.callId,
			talkEvent: session.talk.emit({
				type: "tool.result",
				callId: params.callId,
				turnId,
				payload: {
					result: params.result,
					forced: true
				},
				final
			})
		});
		return;
	}
	session.bridge.submitToolResult(params.callId, params.result, params.options);
	const turnId = ensureRelayTurn(session);
	const final = params.options?.willContinue !== true;
	broadcastToOwner$1(session.context, session.connId, {
		relaySessionId: session.id,
		type: "toolResult",
		callId: params.callId,
		talkEvent: session.talk.emit({
			type: "tool.result",
			callId: params.callId,
			turnId,
			payload: { result: params.result },
			final
		})
	});
}
function registerTalkRealtimeRelayAgentRun(params) {
	getRelaySession(params.relaySessionId, params.connId).activeAgentRuns.set(params.runId, params.sessionKey);
}
function cancelTalkRealtimeRelayTurn(params) {
	const session = getRelaySession(params.relaySessionId, params.connId);
	const turnId = ensureRelayTurn(session);
	const reason = params.reason ?? "client-cancelled";
	clearPendingForcedConsult(session);
	cancelForcedConsults(session);
	session.bridge.handleBargeIn({ audioPlaybackActive: true });
	abortRelayAgentRuns(session, reason);
	const cancelled = session.talk.cancelTurn({
		turnId,
		payload: { reason }
	});
	broadcastToOwner$1(session.context, session.connId, {
		relaySessionId: session.id,
		type: "clear",
		talkEvent: cancelled.ok ? cancelled.event : void 0
	});
}
function stopTalkRealtimeRelaySession(params) {
	closeRelaySession(getRelaySession(params.relaySessionId, params.connId), "completed");
}
//#endregion
//#region src/gateway/talk-agent-consult.ts
async function startTalkRealtimeAgentConsult(params) {
	let message;
	try {
		message = buildRealtimeVoiceAgentConsultChatMessage(params.args);
	} catch (err) {
		return {
			ok: false,
			error: errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err))
		};
	}
	const idempotencyKey = `talk-${params.callId}-${randomUUID()}`;
	const normalizedTalk = normalizeTalkSection(params.context.getRuntimeConfig().talk);
	let chatResponse;
	await chatHandlers["chat.send"]({
		req: {
			type: "req",
			id: `${params.requestId}:talk-tool-call`,
			method: "chat.send"
		},
		client: params.client,
		isWebchatConnect: params.isWebchatConnect,
		context: params.context,
		params: {
			sessionKey: params.sessionKey,
			message,
			idempotencyKey,
			...normalizedTalk?.consultThinkingLevel ? { thinking: normalizedTalk.consultThinkingLevel } : {},
			...typeof normalizedTalk?.consultFastMode === "boolean" ? { fastMode: normalizedTalk.consultFastMode } : {}
		},
		respond: (ok, result, error) => {
			chatResponse = ok ? {
				ok: true,
				result
			} : {
				ok: false,
				error: error ?? errorShape(ErrorCodes.UNAVAILABLE, "chat.send failed without error")
			};
		}
	});
	if (!chatResponse) return {
		ok: false,
		error: errorShape(ErrorCodes.UNAVAILABLE, "chat.send did not return a realtime tool result")
	};
	if (!chatResponse.ok) return {
		ok: false,
		error: chatResponse.error
	};
	const result = chatResponse.result;
	const runId = result && typeof result === "object" && !Array.isArray(result) ? typeof result.runId === "string" ? result.runId : idempotencyKey : idempotencyKey;
	if (params.relaySessionId && params.connId) registerTalkRealtimeRelayAgentRun({
		relaySessionId: params.relaySessionId,
		connId: params.connId,
		sessionKey: params.sessionKey,
		runId
	});
	return {
		ok: true,
		runId,
		idempotencyKey
	};
}
//#endregion
//#region src/gateway/server-methods/talk-shared.ts
function canUseTalkDirectTools(client) {
	return (Array.isArray(client?.connect?.scopes) ? client.connect.scopes : []).includes(ADMIN_SCOPE$1);
}
function broadcastTalkRoomEvents(context, connId, params) {
	if (!connId || params.events.length === 0) return;
	for (const talkEvent of params.events) context.broadcastToConnIds("talk.event", {
		handoffId: params.handoffId,
		roomId: params.roomId,
		talkEvent
	}, new Set([connId]), { dropIfSlow: true });
}
function talkHandoffErrorCode(reason) {
	return reason === "invalid_token" || reason === "no_active_turn" || reason === "stale_turn" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE;
}
function getRecord(value) {
	return asOptionalRecord(value) ?? void 0;
}
function getVoiceCallRealtimeConfig(config) {
	const realtime = getRecord(getRecord(getRecord(getRecord(getRecord(config.plugins)?.entries)?.["voice-call"])?.config)?.realtime);
	const providersRaw = getRecord(realtime?.providers);
	const providers = {};
	if (providersRaw) for (const [providerId, providerConfig] of Object.entries(providersRaw)) {
		const record = getRecord(providerConfig);
		if (record) providers[providerId] = record;
	}
	return {
		provider: normalizeOptionalString$1(realtime?.provider),
		providers: Object.keys(providers).length > 0 ? providers : void 0
	};
}
function getVoiceCallStreamingConfig(config) {
	const streaming = getRecord(getRecord(getRecord(getRecord(getRecord(config.plugins)?.entries)?.["voice-call"])?.config)?.streaming);
	const providersRaw = getRecord(streaming?.providers);
	const providers = {};
	if (providersRaw) for (const [providerId, providerConfig] of Object.entries(providersRaw)) {
		const record = getRecord(providerConfig);
		if (record) providers[providerId] = record;
	}
	return {
		provider: normalizeOptionalString$1(streaming?.provider),
		providers: Object.keys(providers).length > 0 ? providers : void 0
	};
}
function buildTalkRealtimeConfig(config, requestedProvider) {
	const voiceCallRealtime = getVoiceCallRealtimeConfig(config);
	const talkRealtime = getRecord(config.talk?.realtime);
	const talkRealtimeProviderConfigs = talkRealtime?.providers;
	return {
		provider: normalizeOptionalString$1(requestedProvider) ?? normalizeOptionalString$1(talkRealtime?.provider) ?? voiceCallRealtime.provider,
		providers: {
			...voiceCallRealtime.providers,
			...talkRealtimeProviderConfigs
		},
		model: normalizeOptionalString$1(talkRealtime?.model),
		voice: normalizeOptionalString$1(talkRealtime?.voice),
		instructions: normalizeOptionalString$1(talkRealtime?.instructions),
		mode: normalizeOptionalLowercaseString(talkRealtime?.mode),
		transport: normalizeOptionalLowercaseString(talkRealtime?.transport),
		brain: normalizeOptionalLowercaseString(talkRealtime?.brain),
		consultRouting: normalizeOptionalLowercaseString(talkRealtime?.consultRouting)
	};
}
function buildTalkTranscriptionConfig(config, requestedProvider) {
	const streamingConfig = getVoiceCallStreamingConfig(config);
	return {
		provider: normalizeOptionalString$1(requestedProvider) ?? streamingConfig.provider,
		providers: streamingConfig.providers ?? {}
	};
}
function getRealtimeTranscriptionProviderConfig(params) {
	const candidates = [
		normalizeOptionalString$1(params.configuredProviderId),
		params.provider.id,
		...params.provider.aliases ?? []
	].filter((key) => Boolean(key));
	const configuredKeys = Object.keys(params.providerConfigs);
	for (const candidate of candidates) {
		if (Object.hasOwn(params.providerConfigs, candidate)) return params.providerConfigs[candidate] ?? {};
		const normalizedCandidate = normalizeOptionalLowercaseString(candidate);
		const matchingKey = configuredKeys.find((key) => normalizeOptionalLowercaseString(key) === normalizedCandidate);
		if (matchingKey) return params.providerConfigs[matchingKey] ?? {};
	}
	return {};
}
function configuredOrFalse(callback) {
	try {
		return callback();
	} catch {
		return false;
	}
}
function resolveConfiguredRealtimeTranscriptionProvider(params) {
	const providers = listRealtimeTranscriptionProviders(params.config);
	const normalizedConfigured = normalizeOptionalLowercaseString(params.configuredProviderId);
	const orderedProviders = normalizedConfigured ? providers.filter((provider) => normalizeOptionalLowercaseString(provider.id) === normalizedConfigured || (provider.aliases ?? []).some((alias) => normalizeOptionalLowercaseString(alias) === normalizedConfigured)) : providers.toSorted((a, b) => (a.autoSelectOrder ?? 1e3) - (b.autoSelectOrder ?? 1e3));
	for (const provider of orderedProviders) {
		const rawConfig = getRealtimeTranscriptionProviderConfig({
			providerConfigs: params.providerConfigs,
			provider,
			configuredProviderId: params.configuredProviderId
		});
		const providerConfig = provider.resolveConfig?.({
			cfg: params.config,
			rawConfig
		}) ?? rawConfig;
		if (configuredOrFalse(() => provider.isConfigured({
			cfg: params.config,
			providerConfig
		}))) return {
			provider,
			providerConfig
		};
	}
	if (normalizedConfigured) throw new Error(`Realtime transcription provider "${params.configuredProviderId}" is not configured`);
	throw new Error("No realtime transcription provider registered");
}
const DEFAULT_REALTIME_INSTRUCTIONS = [
	"You are OpenClaw's realtime voice interface. Keep spoken replies concise.",
	`If the user asks for code, repository state, files, current OpenClaw context, tool-backed actions, or deeper reasoning, call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} and then summarize the result naturally.`,
	`Do not claim you cannot use tools, perform actions, or reach OpenClaw unless ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} returns that failure.`,
	`When ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} is in progress, speak one brief acknowledgement such as "Let me check that for you", then wait for the final OpenClaw result before answering with the actual result.`
].join(" ");
function buildRealtimeInstructions(configuredInstructions) {
	const extra = normalizeOptionalString$1(configuredInstructions);
	if (!extra) return DEFAULT_REALTIME_INSTRUCTIONS;
	return `${DEFAULT_REALTIME_INSTRUCTIONS}\n\nAdditional realtime instructions:\n${extra}`;
}
function buildRealtimeVoiceLaunchOptions(params) {
	return {
		...pickRealtimeVoiceLaunchOptions(params.defaults),
		...pickRealtimeVoiceLaunchOptions(params.requested)
	};
}
function withRealtimeBrowserOverrides(providerConfig, params) {
	const overrides = {};
	const model = normalizeOptionalString$1(params.model);
	const voice = normalizeOptionalString$1(params.voice);
	const reasoningEffort = normalizeOptionalString$1(params.reasoningEffort);
	if (model) overrides.model = model;
	if (voice) overrides.voice = voice;
	if (typeof params.vadThreshold === "number" && Number.isFinite(params.vadThreshold)) overrides.vadThreshold = params.vadThreshold;
	if (typeof params.silenceDurationMs === "number" && Number.isFinite(params.silenceDurationMs)) overrides.silenceDurationMs = params.silenceDurationMs;
	if (typeof params.prefixPaddingMs === "number" && Number.isFinite(params.prefixPaddingMs)) overrides.prefixPaddingMs = params.prefixPaddingMs;
	if (reasoningEffort) overrides.reasoningEffort = reasoningEffort;
	return Object.keys(overrides).length > 0 ? {
		...providerConfig,
		...overrides
	} : providerConfig;
}
function pickRealtimeVoiceLaunchOptions(params) {
	const options = {};
	const model = normalizeOptionalString$1(params.model);
	const voice = normalizeOptionalString$1(params.voice);
	const reasoningEffort = normalizeOptionalString$1(params.reasoningEffort);
	if (model) options.model = model;
	if (voice) options.voice = voice;
	if (typeof params.vadThreshold === "number" && Number.isFinite(params.vadThreshold)) options.vadThreshold = params.vadThreshold;
	if (typeof params.silenceDurationMs === "number" && Number.isFinite(params.silenceDurationMs)) options.silenceDurationMs = params.silenceDurationMs;
	if (typeof params.prefixPaddingMs === "number" && Number.isFinite(params.prefixPaddingMs)) options.prefixPaddingMs = params.prefixPaddingMs;
	if (reasoningEffort) options.reasoningEffort = reasoningEffort;
	return options;
}
function isUnsupportedBrowserWebRtcSession(session) {
	const provider = normalizeLowercaseStringOrEmpty(session.provider);
	const transport = session.transport ?? "webrtc";
	return provider === "google" && transport === "webrtc";
}
//#endregion
//#region src/gateway/server-methods/talk-client.ts
const talkClientHandlers = {
	"talk.client.create": async ({ params, respond, context }) => {
		if (!validateTalkClientCreateParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.client.create params: ${formatValidationErrors(validateTalkClientCreateParams.errors)}`));
			return;
		}
		const typedParams = params;
		try {
			const runtimeConfig = context.getRuntimeConfig();
			const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, typedParams.provider);
			const mode = normalizeOptionalLowercaseString(typedParams.mode) ?? realtimeConfig.mode ?? "realtime";
			if (mode !== "realtime") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `talk.client.create only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`));
				return;
			}
			if ((normalizeOptionalLowercaseString(typedParams.brain) ?? realtimeConfig.brain ?? "agent-consult") !== "agent-consult") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `talk.client.create only supports brain="agent-consult"`));
				return;
			}
			const transport = normalizeOptionalLowercaseString(typedParams.transport) ?? realtimeConfig.transport;
			if (transport === "managed-room") {
				respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "managed-room realtime Talk sessions are not available in the browser UI yet"));
				return;
			}
			if (transport === "gateway-relay") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `talk.client.create is client-owned; use talk.session.create for gateway-relay`));
				return;
			}
			const resolution = resolveConfiguredRealtimeVoiceProvider({
				configuredProviderId: realtimeConfig.provider,
				providerConfigs: realtimeConfig.providers,
				cfg: runtimeConfig,
				cfgForResolve: runtimeConfig,
				noRegisteredProviderMessage: "No realtime voice provider registered"
			});
			const launchOptions = buildRealtimeVoiceLaunchOptions({
				requested: typedParams,
				defaults: realtimeConfig
			});
			if (resolution.provider.createBrowserSession && transport !== "gateway-relay") {
				const session = await resolution.provider.createBrowserSession({
					cfg: runtimeConfig,
					providerConfig: resolution.providerConfig,
					instructions: buildRealtimeInstructions(realtimeConfig.instructions),
					tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL],
					...launchOptions
				});
				if (!isUnsupportedBrowserWebRtcSession(session) && (!transport || session.transport === transport)) {
					respond(true, session, void 0);
					return;
				}
				if (transport) {
					respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `Realtime provider "${resolution.provider.id}" does not support requested browser transport "${transport}"`));
					return;
				}
			}
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `Realtime provider "${resolution.provider.id}" does not support client-owned realtime sessions`));
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"talk.client.toolCall": async (request) => {
		const { params, respond } = request;
		if (!validateTalkClientToolCallParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.client.toolCall params: ${formatValidationErrors(validateTalkClientToolCallParams.errors)}`));
			return;
		}
		if (params.name !== "openclaw_agent_consult") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported realtime Talk tool: ${params.name}`));
			return;
		}
		const result = await startTalkRealtimeAgentConsult({
			context: request.context,
			client: request.client,
			isWebchatConnect: request.isWebchatConnect,
			requestId: request.req.id,
			sessionKey: params.sessionKey,
			callId: params.callId,
			args: params.args ?? {},
			relaySessionId: normalizeOptionalString$1(params.relaySessionId),
			connId: normalizeOptionalString$1(request.client?.connId)
		});
		if (!result.ok) {
			respond(false, void 0, result.error);
			return;
		}
		respond(true, {
			runId: result.runId,
			idempotencyKey: result.idempotencyKey
		}, void 0);
	}
};
//#endregion
//#region src/gateway/talk-handoff.ts
const DEFAULT_TALK_HANDOFF_TTL_MS = 600 * 1e3;
const MAX_TALK_HANDOFF_TTL_MS = 3600 * 1e3;
const handoffs = /* @__PURE__ */ new Map();
function createTalkHandoff(params) {
	pruneExpiredTalkHandoffs();
	const createdAt = Date.now();
	const ttlMs = normalizeTtlMs(params.ttlMs);
	const id = randomUUID();
	const roomId = `talk_${id}`;
	const token = randomBytes(32).toString("base64url");
	const room = createTalkHandoffRoom({
		roomId,
		mode: params.mode ?? "stt-tts",
		transport: params.transport ?? "managed-room",
		brain: params.brain ?? "agent-consult",
		provider: params.provider
	});
	const record = {
		id,
		roomId,
		roomUrl: `/talk/rooms/${roomId}`,
		tokenHash: hashTalkHandoffToken(token),
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		channel: params.channel,
		target: params.target,
		provider: params.provider,
		model: params.model,
		voice: params.voice,
		mode: params.mode ?? "stt-tts",
		transport: params.transport ?? "managed-room",
		brain: params.brain ?? "agent-consult",
		createdAt,
		expiresAt: createdAt + ttlMs,
		room
	};
	appendTalkHandoffRoomEvent(record, {
		type: "session.started",
		payload: {
			handoffId: id,
			roomId
		}
	});
	handoffs.set(id, record);
	return {
		...toPublicTalkHandoffRecord(record),
		token
	};
}
function getTalkHandoff(id) {
	pruneExpiredTalkHandoffs();
	return handoffs.get(id);
}
function joinTalkHandoff(id, token, opts = {}) {
	const access = resolveTalkHandoffAccess(id, token);
	if (!access.ok) return access;
	const record = access.record;
	const previousClientId = record.room.activeClientId;
	const events = joinTalkHandoffRoom(record, opts.clientId);
	const replacedClientId = previousClientId && previousClientId !== opts.clientId ? previousClientId : void 0;
	const replacementEvents = replacedClientId ? events.filter((event) => event.type === "session.replaced") : [];
	const activeClientEvents = replacedClientId ? events.filter((event) => event.type !== "session.replaced") : events;
	return {
		ok: true,
		record: toPublicTalkHandoffRecord(record),
		events,
		replacedClientId,
		replacementEvents,
		activeClientEvents
	};
}
function startTalkHandoffTurn(id, token, opts = {}) {
	const access = resolveTalkHandoffAccess(id, token);
	if (!access.ok) return access;
	const record = access.record;
	if (opts.clientId) record.room.activeClientId = opts.clientId;
	const turnId = normalizeOptionalString(opts.turnId) ?? randomUUID();
	const turn = record.room.talk.startTurn({
		turnId,
		payload: {
			handoffId: id,
			roomId: record.roomId,
			clientId: record.room.activeClientId
		}
	});
	return {
		ok: true,
		record: toPublicTalkHandoffRecord(record),
		turnId,
		events: turn.event ? [turn.event] : []
	};
}
function endTalkHandoffTurn(id, token, opts = {}) {
	const access = resolveTalkHandoffAccess(id, token);
	if (!access.ok) return access;
	const record = access.record;
	const result = record.room.talk.endTurn({
		turnId: normalizeOptionalString(opts.turnId),
		payload: {
			handoffId: id,
			roomId: record.roomId
		}
	});
	if (!result.ok) return result;
	return {
		ok: true,
		record: toPublicTalkHandoffRecord(record),
		turnId: result.turnId,
		events: [result.event]
	};
}
function cancelTalkHandoffTurn(id, token, opts = {}) {
	const access = resolveTalkHandoffAccess(id, token);
	if (!access.ok) return access;
	const record = access.record;
	const result = record.room.talk.cancelTurn({
		turnId: normalizeOptionalString(opts.turnId),
		payload: {
			handoffId: id,
			roomId: record.roomId,
			reason: opts.reason ?? "client-cancelled"
		}
	});
	if (!result.ok) return result;
	return {
		ok: true,
		record: toPublicTalkHandoffRecord(record),
		turnId: result.turnId,
		events: [result.event]
	};
}
function revokeTalkHandoff(id) {
	pruneExpiredTalkHandoffs();
	const record = handoffs.get(id);
	if (!record) return {
		revoked: false,
		events: []
	};
	const event = appendTalkHandoffRoomEvent(record, {
		type: "session.closed",
		payload: {
			reason: "revoked",
			handoffId: id,
			roomId: record.roomId
		},
		final: true
	});
	handoffs.delete(id);
	return {
		revoked: true,
		roomId: record.roomId,
		activeClientId: record.room.activeClientId,
		events: [event]
	};
}
function verifyTalkHandoffToken(record, token) {
	return record.tokenHash === hashTalkHandoffToken(token);
}
function normalizeTtlMs(value) {
	if (!Number.isFinite(value) || value === void 0) return DEFAULT_TALK_HANDOFF_TTL_MS;
	return Math.min(Math.max(Math.trunc(value), 1e3), MAX_TALK_HANDOFF_TTL_MS);
}
function pruneExpiredTalkHandoffs(now = Date.now()) {
	for (const [id, record] of handoffs) if (record.expiresAt <= now) {
		appendTalkHandoffRoomEvent(record, {
			type: "session.closed",
			payload: {
				reason: "expired",
				handoffId: id,
				roomId: record.roomId
			},
			final: true
		});
		handoffs.delete(id);
	}
}
function hashTalkHandoffToken(token) {
	return createHash("sha256").update(token).digest("base64url");
}
function toPublicTalkHandoffRecord(record) {
	const { tokenHash: _tokenHash, room: _room, ...publicRecord } = record;
	return {
		...publicRecord,
		room: {
			activeClientId: record.room.activeClientId,
			activeTurnId: record.room.talk.activeTurnId,
			recentTalkEvents: [...record.room.talk.recentEvents]
		}
	};
}
function createTalkHandoffRoom(params) {
	return { talk: createTalkSessionController({
		sessionId: params.roomId,
		mode: params.mode,
		transport: params.transport,
		brain: params.brain,
		provider: params.provider
	}, { onEvent: recordTalkObservabilityEvent }) };
}
function resolveTalkHandoffAccess(id, token) {
	const record = handoffs.get(id);
	if (!record) return {
		ok: false,
		reason: "not_found"
	};
	if (record.expiresAt <= Date.now()) {
		appendTalkHandoffRoomEvent(record, {
			type: "session.closed",
			payload: {
				reason: "expired",
				handoffId: id,
				roomId: record.roomId
			},
			final: true
		});
		handoffs.delete(id);
		return {
			ok: false,
			reason: "expired"
		};
	}
	if (!verifyTalkHandoffToken(record, token)) return {
		ok: false,
		reason: "invalid_token"
	};
	return {
		ok: true,
		record
	};
}
function appendTalkHandoffRoomEvent(record, input) {
	return record.room.talk.emit(input);
}
function joinTalkHandoffRoom(record, clientId) {
	const events = [];
	if (record.room.activeClientId && record.room.activeClientId !== clientId) events.push(appendTalkHandoffRoomEvent(record, {
		type: "session.replaced",
		payload: {
			handoffId: record.id,
			roomId: record.roomId,
			previousClientId: record.room.activeClientId,
			nextClientId: clientId
		}
	}));
	record.room.activeClientId = clientId;
	events.push(appendTalkHandoffRoomEvent(record, {
		type: "session.ready",
		payload: {
			handoffId: record.id,
			roomId: record.roomId,
			clientId
		}
	}));
	return events;
}
function normalizeOptionalString(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
//#endregion
//#region src/gateway/talk-transcription-relay.ts
const TRANSCRIPTION_SESSION_TTL_MS = 1800 * 1e3;
const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
const MAX_TRANSCRIPTION_SESSIONS_PER_CONN = 2;
const MAX_TRANSCRIPTION_SESSIONS_GLOBAL = 64;
const TRANSCRIPTION_EVENT = "talk.event";
const RELAY_INPUT_ENCODING = "g711_ulaw";
const RELAY_INPUT_SAMPLE_RATE_HZ = 8e3;
const transcriptionSessions = /* @__PURE__ */ new Map();
function normalizeRelayInputEncoding(value) {
	if (typeof value !== "string") return;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return;
	if (normalized === "mulaw" || normalized === "ulaw" || normalized === "g711_ulaw" || normalized === "g711-mulaw" || normalized === "pcm_mulaw" || normalized === "audio/pcmu" || normalized === "ulaw_8000") return "g711_ulaw";
	if (normalized === "alaw" || normalized === "g711_alaw" || normalized === "g711-alaw" || normalized === "pcm_alaw") return "g711_alaw";
	if (normalized === "pcm" || normalized === "pcm16" || normalized === "linear16" || normalized === "pcm_s16le") return "pcm16";
}
function readFiniteNumber(value) {
	const next = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : void 0;
	return Number.isFinite(next) ? next : void 0;
}
function inferSampleRateFromAudioFormat(value) {
	if (typeof value !== "string") return;
	const match = value.match(/_(\d+)$/);
	return match ? readFiniteNumber(match[1]) : void 0;
}
function assertRelayInputAudioConfig(providerConfig) {
	const encodingValue = providerConfig.encoding ?? providerConfig.audioFormat ?? providerConfig.audio_format;
	const encoding = normalizeRelayInputEncoding(encodingValue);
	if (encoding && encoding !== RELAY_INPUT_ENCODING) throw new Error(`Gateway transcription relay requires ${RELAY_INPUT_ENCODING}/${RELAY_INPUT_SAMPLE_RATE_HZ} audio`);
	const sampleRate = readFiniteNumber(providerConfig.sampleRate ?? providerConfig.sample_rate) ?? inferSampleRateFromAudioFormat(encodingValue);
	if (sampleRate && sampleRate !== RELAY_INPUT_SAMPLE_RATE_HZ) throw new Error(`Gateway transcription relay requires ${RELAY_INPUT_ENCODING}/${RELAY_INPUT_SAMPLE_RATE_HZ} audio`);
}
function broadcastToOwner(context, connId, event) {
	context.broadcastToConnIds(TRANSCRIPTION_EVENT, event, new Set([connId]), { dropIfSlow: true });
}
function ensureTranscriptionTurn(session) {
	const turn = session.talk.ensureTurn();
	if (turn.event) broadcastToOwner(session.context, session.connId, {
		transcriptionSessionId: session.id,
		type: "speechStart",
		talkEvent: turn.event
	});
	return turn.turnId;
}
function closeTranscriptionSession(session, reason) {
	if (session.closed) return;
	session.closed = true;
	transcriptionSessions.delete(session.id);
	clearTimeout(session.cleanupTimer);
	session.sttSession.close();
	broadcastToOwner(session.context, session.connId, {
		transcriptionSessionId: session.id,
		type: "close",
		reason,
		talkEvent: session.talk.emit({
			type: "session.closed",
			payload: { reason },
			final: true
		})
	});
}
function pruneExpiredTranscriptionSessions(nowMs = Date.now()) {
	for (const session of transcriptionSessions.values()) if (nowMs > session.expiresAtMs) closeTranscriptionSession(session, "completed");
}
function countTranscriptionSessionsForConn(connId) {
	let count = 0;
	for (const session of transcriptionSessions.values()) if (session.connId === connId) count += 1;
	return count;
}
function enforceTranscriptionSessionLimits(connId) {
	pruneExpiredTranscriptionSessions();
	if (transcriptionSessions.size >= MAX_TRANSCRIPTION_SESSIONS_GLOBAL) throw new Error("Too many active transcription Talk sessions");
	if (countTranscriptionSessionsForConn(connId) >= MAX_TRANSCRIPTION_SESSIONS_PER_CONN) throw new Error("Too many active transcription Talk sessions for this connection");
}
function createTalkTranscriptionRelaySession(params) {
	enforceTranscriptionSessionLimits(params.connId);
	assertRelayInputAudioConfig(params.providerConfig);
	const transcriptionSessionId = randomUUID();
	const expiresAtMs = Date.now() + TRANSCRIPTION_SESSION_TTL_MS;
	const talk = createTalkSessionController({
		sessionId: transcriptionSessionId,
		mode: "transcription",
		transport: "gateway-relay",
		brain: "none",
		provider: params.provider.id
	}, { onEvent: recordTalkObservabilityEvent });
	let relay;
	const emit = (event, talkEvent) => {
		broadcastToOwner(params.context, params.connId, {
			...event,
			...talkEvent ? { talkEvent: talk.emit(talkEvent) } : {}
		});
	};
	const ensureTurnId = () => {
		return relay ? ensureTranscriptionTurn(relay) : "turn-1";
	};
	const sttSession = params.provider.createSession({
		cfg: params.context.getRuntimeConfig(),
		providerConfig: params.providerConfig,
		onSpeechStart: () => {
			ensureTurnId();
		},
		onPartial: (text) => {
			const turnId = ensureTurnId();
			emit({
				transcriptionSessionId,
				type: "partial",
				text
			}, {
				type: "transcript.delta",
				turnId,
				payload: { text }
			});
		},
		onTranscript: (text) => {
			const turnId = ensureTurnId();
			emit({
				transcriptionSessionId,
				type: "transcript",
				text,
				final: true
			}, {
				type: "transcript.done",
				turnId,
				payload: { text },
				final: true
			});
			if (relay) {
				const ended = relay.talk.endTurn({
					turnId,
					payload: {}
				});
				if (ended.ok) broadcastToOwner(relay.context, relay.connId, {
					transcriptionSessionId,
					type: "transcript",
					text: "",
					final: true,
					talkEvent: ended.event
				});
			}
		},
		onError: (error) => {
			emit({
				transcriptionSessionId,
				type: "error",
				message: error.message
			}, {
				type: "session.error",
				payload: { message: error.message },
				final: true
			});
			if (relay) closeTranscriptionSession(relay, "error");
		}
	});
	relay = {
		id: transcriptionSessionId,
		connId: params.connId,
		context: params.context,
		provider: params.provider,
		sttSession,
		talk,
		expiresAtMs,
		cleanupTimer: setTimeout(() => {
			const active = transcriptionSessions.get(transcriptionSessionId);
			if (active) closeTranscriptionSession(active, "completed");
		}, TRANSCRIPTION_SESSION_TTL_MS),
		closed: false
	};
	relay.cleanupTimer.unref?.();
	transcriptionSessions.set(transcriptionSessionId, relay);
	sttSession.connect().then(() => {
		emit({
			transcriptionSessionId,
			type: "ready"
		}, {
			type: "session.ready",
			payload: null
		});
	}).catch((error) => {
		emit({
			transcriptionSessionId,
			type: "error",
			message: error instanceof Error ? error.message : String(error)
		}, {
			type: "session.error",
			payload: { message: error instanceof Error ? error.message : String(error) },
			final: true
		});
		const active = transcriptionSessions.get(transcriptionSessionId);
		if (active) closeTranscriptionSession(active, "error");
	});
	return {
		provider: params.provider.id,
		mode: "transcription",
		transport: "gateway-relay",
		transcriptionSessionId,
		audio: {
			inputEncoding: RELAY_INPUT_ENCODING,
			inputSampleRateHz: RELAY_INPUT_SAMPLE_RATE_HZ
		},
		expiresAt: Math.floor(expiresAtMs / 1e3)
	};
}
function getTranscriptionSession(transcriptionSessionId, connId) {
	const session = transcriptionSessions.get(transcriptionSessionId);
	if (!session || session.connId !== connId || Date.now() > session.expiresAtMs) {
		if (session) closeTranscriptionSession(session, "completed");
		throw new Error("Unknown transcription Talk session");
	}
	return session;
}
function sendTalkTranscriptionRelayAudio(params) {
	if (params.audioBase64.length > MAX_AUDIO_BASE64_BYTES) throw new Error("Transcription Talk audio frame is too large");
	const session = getTranscriptionSession(params.transcriptionSessionId, params.connId);
	const audio = Buffer.from(params.audioBase64, "base64");
	const turnId = ensureTranscriptionTurn(session);
	session.sttSession.sendAudio(audio);
	broadcastToOwner(session.context, session.connId, {
		transcriptionSessionId: session.id,
		type: "inputAudio",
		byteLength: audio.byteLength,
		talkEvent: session.talk.emit({
			type: "input.audio.delta",
			turnId,
			payload: { byteLength: audio.byteLength }
		})
	});
}
function stopTalkTranscriptionRelaySession(params) {
	const session = getTranscriptionSession(params.transcriptionSessionId, params.connId);
	if (session.talk.activeTurnId) broadcastToOwner(session.context, session.connId, {
		transcriptionSessionId: session.id,
		type: "transcript",
		text: "",
		final: true,
		talkEvent: session.talk.emit({
			type: "input.audio.committed",
			turnId: session.talk.activeTurnId,
			payload: {},
			final: true
		})
	});
	closeTranscriptionSession(session, "completed");
}
function cancelTalkTranscriptionRelayTurn(params) {
	const session = getTranscriptionSession(params.transcriptionSessionId, params.connId);
	const turnId = ensureTranscriptionTurn(session);
	const cancelled = session.talk.cancelTurn({
		turnId,
		payload: { reason: params.reason ?? "client-cancelled" }
	});
	broadcastToOwner(session.context, session.connId, {
		transcriptionSessionId: session.id,
		type: "transcript",
		text: "",
		final: true,
		talkEvent: cancelled.ok ? cancelled.event : void 0
	});
	closeTranscriptionSession(session, "completed");
}
//#endregion
//#region src/gateway/server-methods/talk-session.ts
function normalizeTalkSessionMode(params) {
	const mode = normalizeOptionalLowercaseString(params.mode);
	if (mode) return mode;
	return normalizeOptionalLowercaseString(params.transport) === "managed-room" ? "stt-tts" : "realtime";
}
function normalizeTalkSessionTransport(params) {
	const transport = normalizeOptionalLowercaseString(params.transport);
	if (transport) return transport;
	return params.mode === "stt-tts" ? "managed-room" : "gateway-relay";
}
function normalizeTalkSessionBrain(params) {
	const brain = normalizeOptionalLowercaseString(params.brain);
	if (brain) return brain;
	return params.mode === "transcription" ? "none" : "agent-consult";
}
function isActiveManagedRoomClient(session, connId) {
	if (!connId) return false;
	return getTalkHandoff(session.handoffId)?.room.activeClientId === connId;
}
function canCloseManagedRoomSession(session, connId) {
	const handoff = getTalkHandoff(session.handoffId);
	return !handoff?.room.activeClientId || handoff.room.activeClientId === connId;
}
function canCreateUnscopedManagedRoomSession(client) {
	return client?.connect?.scopes?.includes(ADMIN_SCOPE$1) === true;
}
function managedRoomOwnershipError(action) {
	return errorShape(ErrorCodes.INVALID_REQUEST, `talk.session.${action} requires the active managed-room connection`);
}
const talkSessionHandlers = {
	"talk.session.create": async ({ params, respond, context, client }) => {
		if (!validateTalkSessionCreateParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.session.create params: ${formatValidationErrors(validateTalkSessionCreateParams.errors)}`));
			return;
		}
		const mode = normalizeTalkSessionMode(params);
		const transport = normalizeTalkSessionTransport({
			mode,
			transport: params.transport
		});
		const brain = normalizeTalkSessionBrain({
			mode,
			brain: params.brain
		});
		if (transport === "webrtc" || transport === "provider-websocket") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `talk.session.create is Gateway-managed; use talk.client.create for client transport "${transport}"`));
			return;
		}
		try {
			if (transport === "managed-room") {
				if (brain === "direct-tools" && !canUseTalkDirectTools(client)) {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `talk.session.create brain="direct-tools" requires gateway scope: ${ADMIN_SCOPE$1}`));
					return;
				}
				const spawnedBy = normalizeOptionalString$1(params.spawnedBy);
				if (normalizeOptionalString$1(params.sessionKey) && !spawnedBy && !canCreateUnscopedManagedRoomSession(client)) {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `talk.session.create managed-room sessionKey requires spawnedBy or gateway scope: ${ADMIN_SCOPE$1}`));
					return;
				}
				const resolvedSession = await resolveSessionKeyFromResolveParams({
					cfg: context.getRuntimeConfig(),
					p: {
						key: params.sessionKey,
						...spawnedBy ? { spawnedBy } : {},
						includeGlobal: true,
						includeUnknown: true
					}
				});
				if (!resolvedSession.ok) {
					respond(false, void 0, resolvedSession.error);
					return;
				}
				const handoff = createTalkHandoff({
					sessionKey: resolvedSession.key,
					provider: normalizeOptionalString$1(params.provider),
					model: normalizeOptionalString$1(params.model),
					voice: normalizeOptionalString$1(params.voice),
					mode,
					transport,
					brain,
					ttlMs: params.ttlMs
				});
				rememberUnifiedTalkSession(handoff.id, {
					kind: "managed-room",
					handoffId: handoff.id,
					token: handoff.token,
					roomId: handoff.roomId
				});
				respond(true, {
					sessionId: handoff.id,
					provider: handoff.provider,
					mode: handoff.mode,
					transport: handoff.transport,
					brain: handoff.brain,
					handoffId: handoff.id,
					roomId: handoff.roomId,
					roomUrl: handoff.roomUrl,
					token: handoff.token,
					model: handoff.model,
					voice: handoff.voice,
					expiresAt: handoff.expiresAt
				}, void 0);
				return;
			}
			const connId = client?.connId;
			if (!connId) {
				respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "Talk session unavailable"));
				return;
			}
			if (mode === "realtime") {
				if (transport !== "gateway-relay" || brain !== "agent-consult") {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `realtime talk.session.create requires transport="gateway-relay" and brain="agent-consult"`));
					return;
				}
				const runtimeConfig = context.getRuntimeConfig();
				const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, params.provider);
				const resolution = resolveConfiguredRealtimeVoiceProvider({
					configuredProviderId: realtimeConfig.provider,
					providerConfigs: realtimeConfig.providers,
					cfg: runtimeConfig,
					cfgForResolve: runtimeConfig,
					noRegisteredProviderMessage: "No realtime voice provider registered"
				});
				const launchOptions = buildRealtimeVoiceLaunchOptions({
					requested: params,
					defaults: realtimeConfig
				});
				const session = createTalkRealtimeRelaySession({
					context,
					connId,
					cfg: runtimeConfig,
					provider: resolution.provider,
					providerConfig: withRealtimeBrowserOverrides(resolution.providerConfig, launchOptions),
					instructions: buildRealtimeInstructions(realtimeConfig.instructions),
					tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL],
					model: launchOptions.model,
					voice: launchOptions.voice,
					forceAgentConsultOnFinalTranscript: realtimeConfig.consultRouting === "force-agent-consult"
				});
				rememberUnifiedTalkSession(session.relaySessionId, {
					kind: "realtime-relay",
					connId,
					relaySessionId: session.relaySessionId
				});
				respond(true, {
					...session,
					sessionId: session.relaySessionId,
					mode,
					brain
				}, void 0);
				return;
			}
			if (mode === "transcription") {
				if (transport !== "gateway-relay" || brain !== "none") {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `transcription talk.session.create requires transport="gateway-relay" and brain="none"`));
					return;
				}
				const runtimeConfig = context.getRuntimeConfig();
				const transcriptionConfig = buildTalkTranscriptionConfig(runtimeConfig, params.provider);
				const resolution = resolveConfiguredRealtimeTranscriptionProvider({
					config: runtimeConfig,
					configuredProviderId: transcriptionConfig.provider,
					providerConfigs: transcriptionConfig.providers
				});
				const session = createTalkTranscriptionRelaySession({
					context,
					connId,
					provider: resolution.provider,
					providerConfig: resolution.providerConfig
				});
				rememberUnifiedTalkSession(session.transcriptionSessionId, {
					kind: "transcription-relay",
					connId,
					transcriptionSessionId: session.transcriptionSessionId
				});
				respond(true, {
					...session,
					sessionId: session.transcriptionSessionId,
					brain
				}, void 0);
				return;
			}
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `stt-tts talk.session.create requires transport="managed-room"`));
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"talk.session.join": async ({ params, respond, client, context }) => {
		if (!validateTalkSessionJoinParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.session.join params: ${formatValidationErrors(validateTalkSessionJoinParams.errors)}`));
			return;
		}
		try {
			const session = getUnifiedTalkSession(params.sessionId);
			if (session.kind !== "managed-room") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "talk.session.join requires a managed-room session"));
				return;
			}
			const result = joinTalkHandoff(session.handoffId, params.token, { clientId: client?.connId });
			if (!result.ok) {
				respond(false, void 0, errorShape(result.reason === "invalid_token" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE, `talk session join failed: ${result.reason}`));
				return;
			}
			broadcastTalkRoomEvents(context, result.replacedClientId, {
				handoffId: result.record.id,
				roomId: result.record.roomId,
				events: result.replacementEvents
			});
			broadcastTalkRoomEvents(context, client?.connId, {
				handoffId: result.record.id,
				roomId: result.record.roomId,
				events: result.activeClientEvents
			});
			respond(true, result.record, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"talk.session.appendAudio": async ({ params, respond, client }) => {
		if (!validateTalkSessionAppendAudioParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.session.appendAudio params: ${formatValidationErrors(validateTalkSessionAppendAudioParams.errors)}`));
			return;
		}
		try {
			const session = getUnifiedTalkSession(params.sessionId);
			if (session.kind === "realtime-relay") {
				const connId = requireUnifiedTalkSessionConn(session, client?.connId);
				sendTalkRealtimeRelayAudio({
					relaySessionId: session.relaySessionId,
					connId,
					audioBase64: params.audioBase64,
					timestamp: params.timestamp
				});
				respond(true, { ok: true }, void 0);
				return;
			}
			if (session.kind === "transcription-relay") {
				const connId = requireUnifiedTalkSessionConn(session, client?.connId);
				sendTalkTranscriptionRelayAudio({
					transcriptionSessionId: session.transcriptionSessionId,
					connId,
					audioBase64: params.audioBase64
				});
				respond(true, { ok: true }, void 0);
				return;
			}
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "talk.session.appendAudio is not supported for managed-room sessions"));
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"talk.session.startTurn": async ({ params, respond, client, context }) => {
		if (!validateTalkSessionTurnParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.session.startTurn params: ${formatValidationErrors(validateTalkSessionTurnParams.errors)}`));
			return;
		}
		try {
			const session = getUnifiedTalkSession(params.sessionId);
			if (session.kind !== "managed-room") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "talk.session.startTurn requires managed-room"));
				return;
			}
			if (!isActiveManagedRoomClient(session, client?.connId)) {
				respond(false, void 0, managedRoomOwnershipError("startTurn"));
				return;
			}
			const result = startTalkHandoffTurn(session.handoffId, session.token, {
				turnId: params.turnId,
				clientId: client?.connId
			});
			if (!result.ok) {
				respond(false, void 0, errorShape(talkHandoffErrorCode(result.reason), `talk turn start failed: ${result.reason}`));
				return;
			}
			broadcastTalkRoomEvents(context, result.record.room.activeClientId, {
				handoffId: result.record.id,
				roomId: result.record.roomId,
				events: result.events
			});
			respond(true, {
				ok: true,
				turnId: result.turnId,
				events: result.events
			}, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"talk.session.endTurn": async ({ params, respond, client, context }) => {
		if (!validateTalkSessionTurnParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.session.endTurn params: ${formatValidationErrors(validateTalkSessionTurnParams.errors)}`));
			return;
		}
		try {
			const session = getUnifiedTalkSession(params.sessionId);
			if (session.kind !== "managed-room") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "talk.session.endTurn requires managed-room"));
				return;
			}
			if (!isActiveManagedRoomClient(session, client?.connId)) {
				respond(false, void 0, managedRoomOwnershipError("endTurn"));
				return;
			}
			const result = endTalkHandoffTurn(session.handoffId, session.token, { turnId: params.turnId });
			if (!result.ok) {
				respond(false, void 0, errorShape(talkHandoffErrorCode(result.reason), `talk turn end failed: ${result.reason}`));
				return;
			}
			broadcastTalkRoomEvents(context, result.record.room.activeClientId, {
				handoffId: result.record.id,
				roomId: result.record.roomId,
				events: result.events
			});
			respond(true, {
				ok: true,
				turnId: result.turnId,
				events: result.events
			}, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"talk.session.cancelTurn": async ({ params, respond, client, context }) => {
		if (!validateTalkSessionCancelTurnParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.session.cancelTurn params: ${formatValidationErrors(validateTalkSessionCancelTurnParams.errors)}`));
			return;
		}
		try {
			const session = getUnifiedTalkSession(params.sessionId);
			if (session.kind === "realtime-relay") {
				const connId = requireUnifiedTalkSessionConn(session, client?.connId);
				cancelTalkRealtimeRelayTurn({
					relaySessionId: session.relaySessionId,
					connId,
					reason: normalizeOptionalString$1(params.reason)
				});
				respond(true, { ok: true }, void 0);
				return;
			}
			if (session.kind === "transcription-relay") {
				const connId = requireUnifiedTalkSessionConn(session, client?.connId);
				cancelTalkTranscriptionRelayTurn({
					transcriptionSessionId: session.transcriptionSessionId,
					connId,
					reason: normalizeOptionalString$1(params.reason)
				});
				respond(true, { ok: true }, void 0);
				return;
			}
			if (!isActiveManagedRoomClient(session, client?.connId)) {
				respond(false, void 0, managedRoomOwnershipError("cancelTurn"));
				return;
			}
			const result = cancelTalkHandoffTurn(session.handoffId, session.token, {
				turnId: params.turnId,
				reason: params.reason
			});
			if (!result.ok) {
				respond(false, void 0, errorShape(talkHandoffErrorCode(result.reason), `talk turn cancel failed: ${result.reason}`));
				return;
			}
			broadcastTalkRoomEvents(context, result.record.room.activeClientId, {
				handoffId: result.record.id,
				roomId: result.record.roomId,
				events: result.events
			});
			respond(true, {
				ok: true,
				turnId: result.turnId,
				events: result.events
			}, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"talk.session.cancelOutput": async ({ params, respond, client }) => {
		if (!validateTalkSessionCancelOutputParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.session.cancelOutput params: ${formatValidationErrors(validateTalkSessionCancelOutputParams.errors)}`));
			return;
		}
		try {
			const session = getUnifiedTalkSession(params.sessionId);
			if (session.kind !== "realtime-relay") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "talk.session.cancelOutput requires realtime relay"));
				return;
			}
			const connId = requireUnifiedTalkSessionConn(session, client?.connId);
			cancelTalkRealtimeRelayTurn({
				relaySessionId: session.relaySessionId,
				connId,
				reason: normalizeOptionalString$1(params.reason) ?? "output-cancelled"
			});
			respond(true, { ok: true }, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"talk.session.submitToolResult": async ({ params, respond, client }) => {
		if (!validateTalkSessionSubmitToolResultParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.session.submitToolResult params: ${formatValidationErrors(validateTalkSessionSubmitToolResultParams.errors)}`));
			return;
		}
		try {
			const session = getUnifiedTalkSession(params.sessionId);
			if (session.kind !== "realtime-relay") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "talk.session.submitToolResult is only supported for realtime relay sessions"));
				return;
			}
			const connId = requireUnifiedTalkSessionConn(session, client?.connId);
			submitTalkRealtimeRelayToolResult({
				relaySessionId: session.relaySessionId,
				connId,
				callId: params.callId,
				result: params.result,
				options: params.options
			});
			respond(true, { ok: true }, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"talk.session.close": async ({ params, respond, client, context }) => {
		if (!validateTalkSessionCloseParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.session.close params: ${formatValidationErrors(validateTalkSessionCloseParams.errors)}`));
			return;
		}
		try {
			const session = getUnifiedTalkSession(params.sessionId);
			if (session.kind === "realtime-relay") {
				const connId = requireUnifiedTalkSessionConn(session, client?.connId);
				stopTalkRealtimeRelaySession({
					relaySessionId: session.relaySessionId,
					connId
				});
			} else if (session.kind === "transcription-relay") {
				const connId = requireUnifiedTalkSessionConn(session, client?.connId);
				stopTalkTranscriptionRelaySession({
					transcriptionSessionId: session.transcriptionSessionId,
					connId
				});
			} else {
				if (!canCloseManagedRoomSession(session, client?.connId)) {
					respond(false, void 0, managedRoomOwnershipError("close"));
					return;
				}
				const result = revokeTalkHandoff(session.handoffId);
				broadcastTalkRoomEvents(context, result.activeClientId, {
					handoffId: session.handoffId,
					roomId: session.roomId,
					events: result.events
				});
			}
			forgetUnifiedTalkSession(params.sessionId);
			respond(true, { ok: true }, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	}
};
//#endregion
//#region src/gateway/server-methods/talk.ts
function canReadTalkSecrets(client) {
	const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
	return scopes.includes("operator.admin") || scopes.includes("operator.talk.secrets");
}
function asStringRecord(value) {
	const record = asOptionalRecord(value);
	if (!record) return;
	const next = {};
	for (const [key, entryValue] of Object.entries(record)) if (typeof entryValue === "string") next[key] = entryValue;
	return Object.keys(next).length > 0 ? next : void 0;
}
function normalizeAliasKey(value) {
	return normalizeLowercaseStringOrEmpty(value);
}
function resolveTalkVoiceId(providerConfig, requested) {
	if (!requested) return;
	const aliases = asStringRecord(providerConfig.voiceAliases);
	if (!aliases) return requested;
	const normalizedRequested = normalizeAliasKey(requested);
	for (const [alias, voiceId] of Object.entries(aliases)) if (normalizeAliasKey(alias) === normalizedRequested) return voiceId;
	return requested;
}
function buildTalkTtsConfig(config) {
	const resolved = resolveActiveTalkProviderConfig(config.talk);
	const provider = canonicalizeSpeechProviderId(resolved?.provider, config);
	if (!resolved || !provider) return {
		error: "talk.speak unavailable: talk provider not configured",
		reason: "talk_unconfigured"
	};
	const speechProvider = getSpeechProvider(provider, config);
	if (!speechProvider) return {
		error: `talk.speak unavailable: speech provider "${provider}" does not support Talk mode`,
		reason: "talk_provider_unsupported"
	};
	const baseTts = config.messages?.tts ?? {};
	const providerConfig = resolved.config;
	const resolvedProviderConfig = speechProvider.resolveTalkConfig?.({
		cfg: config,
		baseTtsConfig: baseTts,
		talkProviderConfig: providerConfig,
		timeoutMs: baseTts.timeoutMs ?? 3e4
	}) ?? providerConfig;
	const talkTts = {
		...baseTts,
		auto: "always",
		provider,
		providers: {
			...asOptionalRecord(baseTts.providers) ?? {},
			[provider]: resolvedProviderConfig
		}
	};
	return {
		provider,
		providerConfig,
		cfg: {
			...config,
			messages: {
				...config.messages,
				tts: talkTts
			}
		}
	};
}
function buildTalkCatalog(config) {
	const ttsConfig = resolveTtsConfig(config);
	const activeSpeechProvider = canonicalizeSpeechProviderId(resolveActiveTalkProviderConfig(config.talk)?.provider, config);
	const streamingConfig = getVoiceCallStreamingConfig(config);
	const realtimeConfig = buildTalkRealtimeConfig(config);
	const activeRealtimeProvider = canonicalizeRealtimeVoiceProviderId(realtimeConfig.provider, config);
	return {
		modes: [
			"realtime",
			"stt-tts",
			"transcription"
		],
		transports: [
			"webrtc",
			"provider-websocket",
			"gateway-relay",
			"managed-room"
		],
		brains: [
			"agent-consult",
			"direct-tools",
			"none"
		],
		speech: {
			...activeSpeechProvider ? { activeProvider: activeSpeechProvider } : {},
			providers: listSpeechProviders(config).map((provider) => {
				const entry = {
					id: provider.id,
					label: provider.label,
					configured: configuredOrFalse(() => provider.isConfigured({
						cfg: config,
						providerConfig: getResolvedSpeechProviderConfig(ttsConfig, provider.id, config),
						timeoutMs: ttsConfig.timeoutMs
					})),
					modes: ["stt-tts"],
					brains: ["agent-consult"]
				};
				if (provider.models) entry.models = [...provider.models];
				if (provider.voices) entry.voices = [...provider.voices];
				return entry;
			})
		},
		transcription: {
			...streamingConfig.provider ? { activeProvider: streamingConfig.provider } : {},
			providers: listRealtimeTranscriptionProviders(config).map((provider) => {
				const rawConfig = streamingConfig.providers?.[provider.id] ?? {};
				const providerConfig = provider.resolveConfig?.({
					cfg: config,
					rawConfig
				}) ?? rawConfig;
				const entry = {
					id: provider.id,
					label: provider.label,
					configured: configuredOrFalse(() => provider.isConfigured({
						cfg: config,
						providerConfig
					})),
					modes: ["transcription"],
					transports: ["gateway-relay"],
					brains: ["none"]
				};
				if (provider.defaultModel) entry.defaultModel = provider.defaultModel;
				return entry;
			})
		},
		realtime: {
			...activeRealtimeProvider ? { activeProvider: activeRealtimeProvider } : {},
			providers: listRealtimeVoiceProviders(config).map((provider) => {
				const rawConfig = realtimeConfig.providers?.[provider.id] ?? {};
				const providerConfig = provider.resolveConfig?.({
					cfg: config,
					rawConfig
				}) ?? rawConfig;
				const capabilities = provider.capabilities;
				const entry = {
					id: provider.id,
					label: provider.label,
					configured: configuredOrFalse(() => provider.isConfigured({
						cfg: config,
						providerConfig
					})),
					modes: ["realtime"],
					brains: capabilities?.supportsToolCalls === false ? ["none"] : ["agent-consult"],
					supportsBrowserSession: Boolean(capabilities?.supportsBrowserSession ?? provider.createBrowserSession)
				};
				if (provider.defaultModel) entry.defaultModel = provider.defaultModel;
				if (capabilities?.transports) entry.transports = [...capabilities.transports];
				if (capabilities?.inputAudioFormats) entry.inputAudioFormats = capabilities.inputAudioFormats.map((format) => ({ ...format }));
				if (capabilities?.outputAudioFormats) entry.outputAudioFormats = capabilities.outputAudioFormats.map((format) => ({ ...format }));
				if (capabilities?.supportsBargeIn !== void 0) entry.supportsBargeIn = capabilities.supportsBargeIn;
				if (capabilities?.supportsToolCalls !== void 0) entry.supportsToolCalls = capabilities.supportsToolCalls;
				if (capabilities?.supportsVideoFrames !== void 0) entry.supportsVideoFrames = capabilities.supportsVideoFrames;
				if (capabilities?.supportsSessionResumption !== void 0) entry.supportsSessionResumption = capabilities.supportsSessionResumption;
				return entry;
			})
		}
	};
}
function isFallbackEligibleTalkReason(reason) {
	return reason === "talk_unconfigured" || reason === "talk_provider_unsupported" || reason === "method_unavailable";
}
function talkSpeakError(reason, message) {
	const details = {
		reason,
		fallbackEligible: isFallbackEligibleTalkReason(reason)
	};
	return errorShape(ErrorCodes.UNAVAILABLE, message, { details });
}
function resolveTalkSpeed(params) {
	if (typeof params.speed === "number") return params.speed;
	if (typeof params.rateWpm !== "number" || params.rateWpm <= 0) return;
	const resolved = params.rateWpm / 175;
	if (resolved <= .5 || resolved >= 2) return;
	return resolved;
}
function buildTalkSpeakOverrides(provider, providerConfig, config, params) {
	const speechProvider = getSpeechProvider(provider, config);
	if (!speechProvider?.resolveTalkOverrides) return { provider };
	const resolvedSpeed = resolveTalkSpeed(params);
	const resolvedVoiceId = resolveTalkVoiceId(providerConfig, normalizeOptionalString$1(params.voiceId));
	const providerOverrides = speechProvider.resolveTalkOverrides({
		talkProviderConfig: providerConfig,
		params: {
			...params,
			...resolvedVoiceId == null ? {} : { voiceId: resolvedVoiceId },
			...resolvedSpeed == null ? {} : { speed: resolvedSpeed }
		}
	});
	if (!providerOverrides || Object.keys(providerOverrides).length === 0) return { provider };
	return {
		provider,
		providerOverrides: { [provider]: providerOverrides }
	};
}
function inferMimeType(outputFormat, fileExtension) {
	const normalizedOutput = normalizeOptionalLowercaseString(outputFormat);
	const normalizedExtension = normalizeOptionalLowercaseString(fileExtension);
	if (normalizedOutput === "mp3" || normalizedOutput?.startsWith("mp3_") || normalizedOutput?.endsWith("-mp3") || normalizedExtension === ".mp3") return "audio/mpeg";
	if (normalizedOutput === "opus" || normalizedOutput?.startsWith("opus_") || normalizedExtension === ".opus" || normalizedExtension === ".ogg") return "audio/ogg";
	if (normalizedOutput?.endsWith("-wav") || normalizedExtension === ".wav") return "audio/wav";
	if (normalizedOutput?.endsWith("-webm") || normalizedExtension === ".webm") return "audio/webm";
}
function resolveTalkResponseFromConfig(params) {
	const normalizedTalk = normalizeTalkSection(params.sourceConfig.talk);
	if (!normalizedTalk) return;
	const payload = buildTalkConfigResponse(normalizedTalk);
	if (!payload) return;
	if (params.includeSecrets) return payload;
	const sourceResolved = resolveActiveTalkProviderConfig(normalizedTalk);
	const runtimeResolved = resolveActiveTalkProviderConfig(params.runtimeConfig.talk);
	const provider = canonicalizeSpeechProviderId(sourceResolved?.provider ?? runtimeResolved?.provider, params.runtimeConfig);
	if (!provider) return payload;
	const speechProvider = getSpeechProvider(provider, params.runtimeConfig);
	const sourceBaseTts = asOptionalRecord(params.sourceConfig.messages?.tts) ?? {};
	const runtimeBaseTts = asOptionalRecord(params.runtimeConfig.messages?.tts) ?? {};
	const sourceProviderConfig = sourceResolved?.config ?? {};
	const runtimeProviderConfig = runtimeResolved?.config ?? {};
	const selectedBaseTts = Object.keys(runtimeBaseTts).length > 0 ? runtimeBaseTts : stripUnresolvedSecretApiKeysFromBaseTtsProviders(sourceBaseTts);
	const providerInputConfig = stripUnresolvedSecretApiKey(Object.keys(runtimeProviderConfig).length > 0 ? runtimeProviderConfig : sourceProviderConfig);
	const resolvedConfig = speechProvider?.resolveTalkConfig?.({
		cfg: params.runtimeConfig,
		baseTtsConfig: selectedBaseTts,
		talkProviderConfig: providerInputConfig,
		timeoutMs: typeof selectedBaseTts.timeoutMs === "number" ? selectedBaseTts.timeoutMs : 3e4
	}) ?? providerInputConfig;
	const responseConfig = sourceProviderConfig.apiKey === void 0 ? resolvedConfig : {
		...resolvedConfig,
		apiKey: sourceProviderConfig.apiKey
	};
	return {
		...payload,
		provider,
		resolved: {
			provider,
			config: responseConfig
		}
	};
}
function stripUnresolvedSecretApiKey(config) {
	return stripUnresolvedSecretApiKeyFromRecord(config);
}
function stripUnresolvedSecretApiKeysFromBaseTtsProviders(base) {
	const providers = asOptionalRecord(base.providers);
	if (!providers) return base;
	let mutated = false;
	const cleaned = Object.create(null);
	for (const [providerId, providerConfig] of Object.entries(providers)) {
		const cfg = asOptionalRecord(providerConfig);
		if (!cfg) {
			cleaned[providerId] = providerConfig;
			continue;
		}
		const next = stripUnresolvedSecretApiKeyFromRecord(cfg);
		if (next !== cfg) mutated = true;
		cleaned[providerId] = next;
	}
	if (!mutated) return base;
	return {
		...base,
		providers: cleaned
	};
}
function stripUnresolvedSecretApiKeyFromRecord(config) {
	if (config.apiKey === void 0 || typeof config.apiKey === "string") return config;
	const { apiKey: _omit, ...rest } = config;
	return rest;
}
const talkHandlers = {
	...talkSessionHandlers,
	...talkClientHandlers,
	"talk.catalog": async ({ params, respond, context }) => {
		if (!validateTalkCatalogParams(params ?? {})) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.catalog params: ${formatValidationErrors(validateTalkCatalogParams.errors)}`));
			return;
		}
		try {
			respond(true, buildTalkCatalog(context.getRuntimeConfig()), void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"talk.config": async ({ params, respond, client, context }) => {
		if (!validateTalkConfigParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.config params: ${formatValidationErrors(validateTalkConfigParams.errors)}`));
			return;
		}
		const includeSecrets = Boolean(params.includeSecrets);
		if (includeSecrets && !canReadTalkSecrets(client)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${TALK_SECRETS_SCOPE}`));
			return;
		}
		const snapshot = await readConfigFileSnapshot();
		const runtimeConfig = context.getRuntimeConfig();
		const configPayload = {};
		const talk = resolveTalkResponseFromConfig({
			includeSecrets,
			sourceConfig: snapshot.config,
			runtimeConfig
		});
		if (talk) configPayload.talk = includeSecrets ? talk : redactConfigObject(talk);
		const sessionMainKey = snapshot.config.session?.mainKey;
		if (typeof sessionMainKey === "string") configPayload.session = { mainKey: sessionMainKey };
		const seamColor = snapshot.config.ui?.seamColor;
		if (typeof seamColor === "string") configPayload.ui = { seamColor };
		respond(true, { config: configPayload }, void 0);
	},
	"talk.speak": async ({ params, respond, context }) => {
		if (!validateTalkSpeakParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.speak params: ${formatValidationErrors(validateTalkSpeakParams.errors)}`));
			return;
		}
		const typedParams = params;
		const text = normalizeOptionalString$1(typedParams.text);
		if (!text) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "talk.speak requires text"));
			return;
		}
		if (typedParams.speed == null && typedParams.rateWpm != null && resolveTalkSpeed(typedParams) == null) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.speak params: rateWpm must resolve to speed between 0.5 and 2.0`));
			return;
		}
		try {
			const runtimeConfig = context.getRuntimeConfig();
			const setup = buildTalkTtsConfig(runtimeConfig);
			if ("error" in setup) {
				respond(false, void 0, talkSpeakError(setup.reason, setup.error));
				return;
			}
			const overrides = buildTalkSpeakOverrides(setup.provider, setup.providerConfig, runtimeConfig, typedParams);
			const result = await synthesizeSpeech({
				text,
				cfg: setup.cfg,
				overrides,
				disableFallback: true
			});
			if (!result.success || !result.audioBuffer) {
				respond(false, void 0, talkSpeakError("synthesis_failed", result.error ?? "talk synthesis failed"));
				return;
			}
			if ((result.provider ?? setup.provider).trim().length === 0) {
				respond(false, void 0, talkSpeakError("invalid_audio_result", "talk synthesis returned empty provider"));
				return;
			}
			if (result.audioBuffer.length === 0) {
				respond(false, void 0, talkSpeakError("invalid_audio_result", "talk synthesis returned empty audio"));
				return;
			}
			respond(true, {
				audioBase64: result.audioBuffer.toString("base64"),
				provider: result.provider ?? setup.provider,
				outputFormat: result.outputFormat,
				voiceCompatible: result.voiceCompatible,
				mimeType: inferMimeType(result.outputFormat, result.fileExtension),
				fileExtension: result.fileExtension
			}, void 0);
		} catch (err) {
			respond(false, void 0, talkSpeakError("synthesis_failed", formatForLog(err)));
		}
	},
	"talk.mode": ({ params, respond, context, client, isWebchatConnect }) => {
		if (client && isWebchatConnect(client.connect) && !context.hasConnectedTalkNode()) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "talk disabled: no connected Talk-capable nodes"));
			return;
		}
		if (!validateTalkModeParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`));
			return;
		}
		const payload = {
			enabled: params.enabled,
			phase: params.phase ?? null,
			ts: Date.now()
		};
		context.broadcast("talk.mode", payload, { dropIfSlow: true });
		respond(true, payload, void 0);
	}
};
//#endregion
//#region src/gateway/server-methods/tasks.ts
const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;
const TASK_STATUS_TO_LEDGER_STATUS = {
	queued: "queued",
	running: "running",
	succeeded: "completed",
	failed: "failed",
	timed_out: "timed_out",
	cancelled: "cancelled",
	lost: "failed"
};
const LEDGER_STATUS_TO_TASK_STATUSES = {
	queued: ["queued"],
	running: ["running"],
	completed: ["succeeded"],
	failed: ["failed", "lost"],
	timed_out: ["timed_out"],
	cancelled: ["cancelled"]
};
function taskUpdatedAt(task) {
	return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}
function sanitizeOptionalTaskText(value, opts) {
	return sanitizeTaskStatusText(value, {
		errorContext: opts?.errorContext,
		maxChars: 120
	}) || void 0;
}
function mapTaskSummary(task) {
	const progressSummary = sanitizeOptionalTaskText(task.progressSummary);
	const terminalSummary = sanitizeOptionalTaskText(task.terminalSummary, { errorContext: true });
	const error = sanitizeOptionalTaskText(task.error, { errorContext: true });
	return {
		id: task.taskId,
		taskId: task.taskId,
		kind: task.taskKind ?? task.runtime,
		runtime: task.runtime,
		status: TASK_STATUS_TO_LEDGER_STATUS[task.status],
		title: formatTaskStatusTitle(task),
		...task.agentId ? { agentId: task.agentId } : {},
		sessionKey: task.requesterSessionKey,
		...task.childSessionKey ? { childSessionKey: task.childSessionKey } : {},
		ownerKey: task.ownerKey,
		...task.runId ? { runId: task.runId } : {},
		...task.parentFlowId ? { flowId: task.parentFlowId } : {},
		...task.parentTaskId ? { parentTaskId: task.parentTaskId } : {},
		...task.sourceId ? { sourceId: task.sourceId } : {},
		createdAt: task.createdAt,
		updatedAt: taskUpdatedAt(task),
		...task.startedAt !== void 0 ? { startedAt: task.startedAt } : {},
		...task.endedAt !== void 0 ? { endedAt: task.endedAt } : {},
		...progressSummary ? { progressSummary } : {},
		...terminalSummary ? { terminalSummary } : {},
		...error ? { error } : {}
	};
}
function normalizeTaskStatusFilter(status) {
	if (!status) return null;
	return new Set((Array.isArray(status) ? status : [status]).flatMap((value) => LEDGER_STATUS_TO_TASK_STATUSES[value] ?? []));
}
function taskMatchesSession(task, sessionKey) {
	const normalized = normalizeOptionalString$1(sessionKey);
	if (!normalized) return true;
	return [
		task.requesterSessionKey,
		task.childSessionKey,
		task.ownerKey
	].some((candidate) => normalizeOptionalString$1(candidate) === normalized);
}
function taskMatchesAgent(task, agentId) {
	const normalized = normalizeOptionalString$1(agentId);
	if (!normalized) return true;
	if (normalizeOptionalString$1(task.agentId) === normalized) return true;
	return [
		task.requesterSessionKey,
		task.childSessionKey,
		task.ownerKey
	].some((candidate) => parseAgentSessionKey(candidate)?.agentId === normalized);
}
function parseCursor(cursor) {
	if (!cursor) return 0;
	if (!/^\d+$/.test(cursor.trim())) return null;
	const parsed = Number(cursor);
	return Number.isSafeInteger(parsed) ? parsed : null;
}
const tasksHandlers = {
	"tasks.list": ({ params, respond }) => {
		if (!validateTasksListParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid tasks.list params: ${formatValidationErrors(validateTasksListParams.errors)}`));
			return;
		}
		const cursor = parseCursor(params.cursor);
		if (cursor === null) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid tasks.list cursor"));
			return;
		}
		const statusFilter = normalizeTaskStatusFilter(params.status);
		const limit = Math.min(params.limit ?? DEFAULT_TASKS_LIST_LIMIT, MAX_TASKS_LIST_LIMIT);
		const filtered = listTaskRecords().filter((task) => {
			if (statusFilter && !statusFilter.has(task.status)) return false;
			return taskMatchesAgent(task, params.agentId) && taskMatchesSession(task, params.sessionKey);
		});
		const page = filtered.slice(cursor, cursor + limit);
		const nextOffset = cursor + page.length;
		respond(true, {
			tasks: page.map((task) => mapTaskSummary(task)),
			...nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}
		});
	},
	"tasks.get": ({ params, respond }) => {
		if (!validateTasksGetParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid tasks.get params: ${formatValidationErrors(validateTasksGetParams.errors)}`));
			return;
		}
		const taskId = params.taskId;
		const task = getTaskById(taskId);
		if (!task) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`));
			return;
		}
		respond(true, { task: mapTaskSummary(task) });
	},
	"tasks.cancel": async ({ params, respond, context }) => {
		if (!validateTasksCancelParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid tasks.cancel params: ${formatValidationErrors(validateTasksCancelParams.errors)}`));
			return;
		}
		const taskId = params.taskId;
		const reason = normalizeOptionalString$1(params.reason);
		const result = await cancelDetachedTaskRunById({
			cfg: context.getRuntimeConfig(),
			taskId,
			...reason ? { reason } : {}
		});
		respond(true, {
			found: result.found,
			cancelled: result.cancelled,
			...result.reason ? { reason: result.reason } : {},
			...result.task ? { task: mapTaskSummary(result.task) } : {}
		});
	}
};
//#endregion
//#region src/gateway/server-methods/tools-catalog.ts
function resolveAgentIdOrRespondError(rawAgentId, respond, cfg) {
	const knownAgents = listAgentIds(cfg);
	const requestedAgentId = normalizeOptionalString$1(rawAgentId) ?? "";
	const agentId = requestedAgentId || resolveDefaultAgentId(cfg);
	if (requestedAgentId && !knownAgents.includes(agentId)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`));
		return null;
	}
	return {
		cfg,
		agentId
	};
}
function buildCoreGroups() {
	return listCoreToolSections().map((section) => ({
		id: section.id,
		label: section.label,
		source: "core",
		tools: section.tools.map((tool) => ({
			id: tool.id,
			label: tool.label,
			description: tool.description,
			source: "core",
			defaultProfiles: resolveCoreToolProfiles(tool.id)
		}))
	}));
}
function buildPluginGroups(params) {
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
	const agentDir = resolveAgentDir(params.cfg, params.agentId);
	const toolContext = {
		config: params.cfg,
		workspaceDir,
		agentDir,
		agentId: params.agentId
	};
	ensureStandalonePluginToolRegistryLoaded({
		context: toolContext,
		toolAllowlist: ["group:plugins"],
		allowGatewaySubagentBinding: true
	});
	const pluginTools = resolvePluginTools({
		context: toolContext,
		existingToolNames: params.existingToolNames,
		toolAllowlist: ["group:plugins"],
		suppressNameConflicts: true,
		allowGatewaySubagentBinding: true
	});
	const activeRegistry = getActivePluginRegistry();
	const groups = /* @__PURE__ */ new Map();
	const pluginToolMetadata = new Map((activeRegistry?.toolMetadata ?? []).map((entry) => [buildPluginToolMetadataKey(entry.pluginId, entry.metadata.toolName), entry.metadata]));
	const seenToolIds = /* @__PURE__ */ new Set();
	for (const tool of pluginTools) {
		const meta = getPluginToolMeta(tool);
		const pluginId = meta?.pluginId ?? "plugin";
		const groupId = `plugin:${pluginId}`;
		const existing = groups.get(groupId) ?? {
			id: groupId,
			label: pluginId,
			source: "plugin",
			pluginId,
			tools: []
		};
		const ownedMetadata = meta?.pluginId ? pluginToolMetadata.get(buildPluginToolMetadataKey(meta.pluginId, tool.name)) : void 0;
		existing.tools.push({
			id: tool.name,
			label: normalizeOptionalString$1(ownedMetadata?.displayName) ?? normalizeOptionalString$1(tool.label) ?? tool.name,
			description: summarizeToolDescriptionText({
				rawDescription: ownedMetadata?.description ?? (typeof tool.description === "string" ? tool.description : void 0),
				displaySummary: tool.displaySummary
			}),
			source: "plugin",
			pluginId,
			optional: meta?.optional,
			risk: ownedMetadata?.risk,
			tags: ownedMetadata?.tags,
			defaultProfiles: []
		});
		seenToolIds.add(tool.name);
		groups.set(groupId, existing);
	}
	for (const entry of activeRegistry?.tools ?? []) {
		const names = entry.names.length > 0 ? entry.names : entry.declaredNames ?? [];
		for (const name of names) {
			if (seenToolIds.has(name) || params.existingToolNames.has(name)) continue;
			const groupId = `plugin:${entry.pluginId}`;
			const existing = groups.get(groupId) ?? {
				id: groupId,
				label: entry.pluginName ?? entry.pluginId,
				source: "plugin",
				pluginId: entry.pluginId,
				tools: []
			};
			const ownedMetadata = pluginToolMetadata.get(buildPluginToolMetadataKey(entry.pluginId, name));
			existing.tools.push({
				id: name,
				label: normalizeOptionalString$1(ownedMetadata?.displayName) ?? name,
				description: summarizeToolDescriptionText({ rawDescription: ownedMetadata?.description }) || `Plugin tool from ${entry.pluginName ?? entry.pluginId}`,
				source: "plugin",
				pluginId: entry.pluginId,
				optional: entry.optional,
				risk: ownedMetadata?.risk,
				tags: ownedMetadata?.tags,
				defaultProfiles: []
			});
			seenToolIds.add(name);
			groups.set(groupId, existing);
		}
	}
	return [...groups.values()].map((group) => Object.assign({}, group, { tools: group.tools.toSorted((a, b) => a.id.localeCompare(b.id)) })).toSorted((a, b) => a.label.localeCompare(b.label));
}
function buildToolsCatalogResult(params) {
	const agentId = normalizeOptionalString$1(params.agentId) || resolveDefaultAgentId(params.cfg);
	const includePlugins = params.includePlugins !== false;
	const groups = buildCoreGroups();
	if (includePlugins) {
		const existingToolNames = new Set(groups.flatMap((group) => group.tools.map((tool) => tool.id)));
		groups.push(...buildPluginGroups({
			cfg: params.cfg,
			agentId,
			existingToolNames
		}));
	}
	return {
		agentId,
		profiles: PROFILE_OPTIONS.map((profile) => ({
			id: profile.id,
			label: profile.label
		})),
		groups
	};
}
const toolsCatalogHandlers = { "tools.catalog": ({ params, respond, context }) => {
	if (!validateToolsCatalogParams(params)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid tools.catalog params: ${formatValidationErrors(validateToolsCatalogParams.errors)}`));
		return;
	}
	const resolved = resolveAgentIdOrRespondError(params.agentId, respond, context.getRuntimeConfig());
	if (!resolved) return;
	respond(true, buildToolsCatalogResult({
		cfg: resolved.cfg,
		agentId: resolved.agentId,
		includePlugins: params.includePlugins
	}), void 0);
} };
//#endregion
//#region src/gateway/server-methods/tools-effective.ts
const TOOLS_EFFECTIVE_FRESH_TTL_MS = 1e4;
const TOOLS_EFFECTIVE_STALE_TTL_MS = 12e4;
const TOOLS_EFFECTIVE_SLOW_LOG_MS = 250;
const TOOLS_EFFECTIVE_CACHE_LIMIT = 128;
let nowForToolsEffectiveCache = () => Date.now();
const toolsEffectiveCache = /* @__PURE__ */ new Map();
const toolsEffectiveInflight = /* @__PURE__ */ new Map();
function resolveRequestedAgentIdOrRespondError(params) {
	const knownAgents = listAgentIds(params.cfg);
	const requestedAgentId = normalizeOptionalString$1(params.rawAgentId) ?? "";
	if (!requestedAgentId) return;
	if (!knownAgents.includes(requestedAgentId)) {
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`));
		return null;
	}
	return requestedAgentId;
}
function optionalCacheString(value) {
	return value?.trim() ?? "";
}
function buildToolsEffectiveCacheKey(params) {
	const context = params.context;
	return JSON.stringify({
		v: 1,
		config: resolveRuntimeConfigCacheKey(context.cfg),
		pluginRegistry: getActivePluginRegistryVersion(),
		channelRegistry: getActivePluginChannelRegistryVersion(),
		sessionKey: params.sessionKey,
		agentId: context.agentId,
		modelProvider: optionalCacheString(context.modelProvider),
		modelId: optionalCacheString(context.modelId),
		messageProvider: optionalCacheString(context.messageProvider),
		accountId: optionalCacheString(context.accountId),
		currentChannelId: optionalCacheString(context.currentChannelId),
		currentThreadTs: optionalCacheString(context.currentThreadTs),
		groupId: optionalCacheString(context.groupId),
		groupChannel: optionalCacheString(context.groupChannel),
		groupSpace: optionalCacheString(context.groupSpace),
		replyToMode: optionalCacheString(context.replyToMode)
	});
}
function trimToolsEffectiveCache() {
	while (toolsEffectiveCache.size > TOOLS_EFFECTIVE_CACHE_LIMIT) {
		const oldest = toolsEffectiveCache.keys().next().value;
		if (typeof oldest !== "string") return;
		toolsEffectiveCache.delete(oldest);
	}
}
function cacheToolsEffectiveResult(key, value) {
	toolsEffectiveCache.delete(key);
	toolsEffectiveCache.set(key, {
		value,
		createdAtMs: nowForToolsEffectiveCache()
	});
	trimToolsEffectiveCache();
}
function scheduleToolsEffectiveRefresh(key, context) {
	const existing = toolsEffectiveInflight.get(key);
	if (existing) return existing;
	const startedAt = nowForToolsEffectiveCache();
	const task = new Promise((resolve, reject) => {
		setImmediate(() => {
			try {
				const value = resolveEffectiveToolInventory({
					cfg: context.cfg,
					agentId: context.agentId,
					sessionKey: context.sessionKey,
					messageProvider: context.messageProvider,
					modelProvider: context.modelProvider,
					modelId: context.modelId,
					currentChannelId: context.currentChannelId,
					currentThreadTs: context.currentThreadTs,
					accountId: context.accountId,
					groupId: context.groupId,
					groupChannel: context.groupChannel,
					groupSpace: context.groupSpace,
					replyToMode: context.replyToMode
				});
				cacheToolsEffectiveResult(key, value);
				const durationMs = nowForToolsEffectiveCache() - startedAt;
				if (durationMs >= TOOLS_EFFECTIVE_SLOW_LOG_MS) logDebug(`tools-effective: refresh durationMs=${durationMs} agent=${context.agentId} session=${context.sessionKey} tools=${value.groups.reduce((sum, group) => sum + group.tools.length, 0)}`);
				resolve(value);
			} catch (err) {
				reject(err);
			} finally {
				toolsEffectiveInflight.delete(key);
			}
		});
	});
	toolsEffectiveInflight.set(key, task);
	return task;
}
function refreshToolsEffectiveInBackground(key, context) {
	scheduleToolsEffectiveRefresh(key, context).catch((err) => {
		logWarn(`tools-effective: background refresh failed: ${String(err)}`);
	});
}
async function resolveCachedToolsEffective(params) {
	const key = buildToolsEffectiveCacheKey(params);
	const now = nowForToolsEffectiveCache();
	const cached = toolsEffectiveCache.get(key);
	if (cached) {
		const ageMs = now - cached.createdAtMs;
		if (ageMs < TOOLS_EFFECTIVE_FRESH_TTL_MS) return cached.value;
		if (ageMs < TOOLS_EFFECTIVE_STALE_TTL_MS) {
			refreshToolsEffectiveInBackground(key, params.context);
			return cached.value;
		}
	}
	return scheduleToolsEffectiveRefresh(key, params.context);
}
function resolveTrustedToolsEffectiveContext(params) {
	const loaded = loadSessionEntry(params.sessionKey);
	if (!loaded.entry) {
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unknown session key "${params.sessionKey}"`));
		return null;
	}
	const sessionAgentId = resolveSessionAgentId({
		sessionKey: loaded.canonicalKey ?? params.sessionKey,
		config: loaded.cfg
	});
	if (params.requestedAgentId && params.requestedAgentId !== sessionAgentId) {
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `agent id "${params.requestedAgentId}" does not match session agent "${sessionAgentId}"`));
		return null;
	}
	const delivery = deliveryContextFromSession(loaded.entry);
	const resolvedModel = resolveSessionModelRef(loaded.cfg, loaded.entry, sessionAgentId);
	return {
		cfg: loaded.cfg,
		agentId: sessionAgentId,
		sessionKey: params.sessionKey,
		modelProvider: resolvedModel.provider,
		modelId: resolvedModel.model,
		messageProvider: delivery?.channel ?? loaded.entry.lastChannel ?? loaded.entry.channel ?? loaded.entry.origin?.provider,
		accountId: delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId,
		currentChannelId: delivery?.to,
		currentThreadTs: delivery?.threadId != null ? stringifyRouteThreadId(delivery.threadId) : loaded.entry.lastThreadId != null ? stringifyRouteThreadId(loaded.entry.lastThreadId) : loaded.entry.origin?.threadId != null ? stringifyRouteThreadId(loaded.entry.origin.threadId) : void 0,
		groupId: loaded.entry.groupId,
		groupChannel: loaded.entry.groupChannel,
		groupSpace: loaded.entry.space,
		replyToMode: resolveReplyToMode(loaded.cfg, delivery?.channel ?? loaded.entry.lastChannel ?? loaded.entry.channel ?? loaded.entry.origin?.provider, delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId, loaded.entry.chatType ?? loaded.entry.origin?.chatType)
	};
}
const toolsEffectiveHandlers = { "tools.effective": async ({ params, respond, context }) => {
	if (!validateToolsEffectiveParams(params)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid tools.effective params: ${formatValidationErrors(validateToolsEffectiveParams.errors)}`));
		return;
	}
	const cfg = context.getRuntimeConfig();
	const requestedAgentId = resolveRequestedAgentIdOrRespondError({
		rawAgentId: params.agentId,
		cfg,
		respond
	});
	if (requestedAgentId === null) return;
	const trustedContext = resolveTrustedToolsEffectiveContext({
		sessionKey: params.sessionKey,
		requestedAgentId,
		respond
	});
	if (!trustedContext) return;
	try {
		respond(true, await resolveCachedToolsEffective({
			sessionKey: params.sessionKey,
			context: trustedContext
		}), void 0);
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `tools.effective failed: ${String(err)}`));
	}
} };
//#endregion
//#region src/gateway/server-methods/tools-invoke.ts
function resolveRpcErrorCode(params) {
	if (params.requiresApproval) return "requires_approval";
	switch (params.type) {
		case "invalid_request": return "validation_error";
		case "not_found": return "not_found";
		case "tool_call_blocked": return "forbidden";
		case "tool_error": return "internal_error";
	}
	return "internal_error";
}
const toolsInvokeHandlers = { "tools.invoke": async ({ params, respond, context }) => {
	if (!validateToolsInvokeParams(params)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid tools.invoke params: ${formatValidationErrors(validateToolsInvokeParams.errors)}`));
		return;
	}
	const requestedToolName = normalizeOptionalString$1(params.name);
	if (!requestedToolName) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid tools.invoke params: name required"));
		return;
	}
	const outcome = await invokeGatewayTool({
		cfg: context.getRuntimeConfig(),
		input: params,
		toolCallIdPrefix: "rpc",
		approvalMode: params.confirm === true ? "request" : "report"
	});
	if (outcome.ok) {
		respond(true, {
			ok: true,
			toolName: outcome.toolName,
			output: outcome.result,
			source: outcome.source
		}, void 0);
		return;
	}
	respond(true, {
		ok: false,
		toolName: outcome.toolName || requestedToolName,
		...outcome.error.requiresApproval ? { requiresApproval: true } : {},
		error: {
			code: resolveRpcErrorCode(outcome.error),
			message: outcome.error.message
		}
	}, void 0);
} };
//#endregion
//#region src/gateway/server-methods/tts.ts
const ttsHandlers = {
	"tts.status": async ({ respond, context }) => {
		try {
			const cfg = context.getRuntimeConfig();
			const config = resolveTtsConfig(cfg);
			const prefsPath = resolveTtsPrefsPath(config);
			const provider = getTtsProvider(config, prefsPath);
			const persona = getTtsPersona(config, prefsPath);
			const autoMode = resolveTtsAutoMode({
				config,
				prefsPath
			});
			const fallbackProviders = resolveTtsProviderOrder(provider, cfg).slice(1).filter((candidate) => isTtsProviderConfigured(config, candidate, cfg));
			const providerStates = listSpeechProviders(cfg).map((candidate) => ({
				id: candidate.id,
				label: candidate.label,
				configured: candidate.isConfigured({
					cfg,
					providerConfig: getResolvedSpeechProviderConfig(config, candidate.id, cfg),
					timeoutMs: config.timeoutMs
				})
			}));
			respond(true, {
				enabled: isTtsEnabled(config, prefsPath),
				auto: autoMode,
				provider,
				persona: persona?.id ?? null,
				personas: listTtsPersonas(config).map((entry) => ({
					id: entry.id,
					label: entry.label,
					description: entry.description,
					provider: entry.provider
				})),
				fallbackProvider: fallbackProviders[0] ?? null,
				fallbackProviders,
				prefsPath,
				providerStates
			});
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"tts.enable": async ({ respond, context }) => {
		try {
			setTtsEnabled(resolveTtsPrefsPath(resolveTtsConfig(context.getRuntimeConfig())), true);
			respond(true, { enabled: true });
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"tts.disable": async ({ respond, context }) => {
		try {
			setTtsEnabled(resolveTtsPrefsPath(resolveTtsConfig(context.getRuntimeConfig())), false);
			respond(true, { enabled: false });
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"tts.convert": async ({ params, respond, context }) => {
		const text = normalizeOptionalString$1(params.text) ?? "";
		if (!text) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "tts.convert requires text"));
			return;
		}
		try {
			const cfg = context.getRuntimeConfig();
			const channel = normalizeOptionalString$1(params.channel);
			const providerRaw = normalizeOptionalString$1(params.provider);
			const modelId = normalizeOptionalString$1(params.modelId);
			const voiceId = normalizeOptionalString$1(params.voiceId);
			let overrides;
			try {
				overrides = resolveExplicitTtsOverrides({
					cfg,
					provider: providerRaw,
					modelId,
					voiceId
				});
			} catch (err) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
				return;
			}
			const result = await textToSpeech({
				text,
				cfg,
				channel,
				overrides,
				disableFallback: Boolean(overrides.provider || modelId || voiceId)
			});
			if (result.success && result.audioPath) {
				respond(true, {
					audioPath: result.audioPath,
					provider: result.provider,
					outputFormat: result.outputFormat,
					voiceCompatible: result.voiceCompatible
				});
				return;
			}
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "TTS conversion failed"));
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"tts.setProvider": async ({ params, respond, context }) => {
		const cfg = context.getRuntimeConfig();
		const provider = canonicalizeSpeechProviderId(normalizeOptionalString$1(params.provider) ?? "", cfg);
		if (!provider || !getSpeechProvider(provider, cfg)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid provider. Use a registered TTS provider id."));
			return;
		}
		try {
			setTtsProvider(resolveTtsPrefsPath(resolveTtsConfig(cfg)), provider);
			respond(true, { provider });
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"tts.personas": async ({ respond, context }) => {
		try {
			const config = resolveTtsConfig(context.getRuntimeConfig());
			respond(true, {
				active: getTtsPersona(config, resolveTtsPrefsPath(config))?.id ?? null,
				personas: listTtsPersonas(config).map((persona) => ({
					id: persona.id,
					label: persona.label,
					description: persona.description,
					provider: persona.provider,
					fallbackPolicy: persona.fallbackPolicy,
					providers: Object.keys(persona.providers ?? {})
				}))
			});
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"tts.setPersona": async ({ params, respond, context }) => {
		const cfg = context.getRuntimeConfig();
		const rawPersona = normalizeOptionalString$1(params.persona);
		try {
			const config = resolveTtsConfig(cfg);
			const prefsPath = resolveTtsPrefsPath(config);
			if (!rawPersona || [
				"off",
				"none",
				"default"
			].includes(rawPersona.toLowerCase())) {
				setTtsPersona(prefsPath, null);
				respond(true, { persona: null });
				return;
			}
			const persona = listTtsPersonas(config).find((entry) => entry.id === rawPersona.toLowerCase());
			if (!persona) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid persona. Use a configured TTS persona id."));
				return;
			}
			setTtsPersona(prefsPath, persona.id);
			respond(true, { persona: persona.id });
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"tts.providers": async ({ respond, context }) => {
		try {
			const cfg = context.getRuntimeConfig();
			const config = resolveTtsConfig(cfg);
			const prefsPath = resolveTtsPrefsPath(config);
			respond(true, {
				providers: listSpeechProviders(cfg).map((provider) => ({
					id: provider.id,
					name: provider.label,
					configured: provider.isConfigured({
						cfg,
						providerConfig: getResolvedSpeechProviderConfig(config, provider.id, cfg),
						timeoutMs: config.timeoutMs
					}),
					models: [...provider.models ?? []],
					voices: [...provider.voices ?? []]
				})),
				active: getTtsProvider(config, prefsPath)
			});
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	}
};
//#endregion
//#region src/gateway/server-methods/update-managed-service-handoff.ts
const PARENT_EXIT_GRACE_MS = 6e4;
const SERVICE_IDENTITY_ENV_VARS = new Set([
	"OPENCLAW_LAUNCHD_LABEL",
	"OPENCLAW_SYSTEMD_UNIT",
	"OPENCLAW_WINDOWS_TASK_NAME"
]);
const HANDOFF_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const params = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(params.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(params.logPath, "[" + new Date().toISOString() + "] " + line + "\n", {
      mode: 0o600,
    });
  } catch {
    // Best effort only.
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupSensitiveFiles() {
  for (const filePath of params.sensitivePaths || []) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort only.
    }
  }
}

function resolveExistingDirectory(candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "string") {
      continue;
    }
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    "." + path.basename(filePath) + "." + process.pid + "." + Date.now() + ".tmp",
  );
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    appendLog("failed to write update sentinel failure: " + (err && err.stack ? err.stack : String(err)));
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort only.
    }
  }
}

function isPendingUpdatePayload(payload) {
  const reason = payload && payload.stats && payload.stats.reason;
  return (
    payload &&
    payload.kind === "update" &&
    payload.status === "skipped" &&
    (reason === "managed-service-handoff-started" || reason === "restart-health-pending")
  );
}

function buildFallbackFailurePayload(reason) {
  const metaFile = params.metaPath ? readJsonFile(params.metaPath) : null;
  const meta = metaFile && metaFile.version === 1 && metaFile.meta ? metaFile.meta : {};
  const payload = {
    kind: "update",
    status: "error",
    ts: Date.now(),
    message: typeof meta.note === "string" ? meta.note : null,
    stats: {
      mode: "unknown",
      ...(typeof meta.handoffId === "string" && meta.handoffId.trim()
        ? { handoffId: meta.handoffId }
        : {}),
      reason,
      steps: [],
      durationMs: 0,
    },
  };
  if (typeof meta.sessionKey === "string" && meta.sessionKey.trim()) {
    payload.sessionKey = meta.sessionKey;
  }
  if (meta.deliveryContext && typeof meta.deliveryContext === "object") {
    payload.deliveryContext = meta.deliveryContext;
  }
  if (typeof meta.threadId === "string" && meta.threadId.trim()) {
    payload.threadId = meta.threadId;
  }
  return payload;
}

function markUpdateSentinelFailureIfPending(reason) {
  if (!params.sentinelPath) {
    return;
  }
  const current = readJsonFile(params.sentinelPath);
  let payload = current && current.version === 1 ? current.payload : null;
  if (payload && (payload.kind !== "update" || !isPendingUpdatePayload(payload))) {
    return;
  }
  const handoffId = typeof params.handoffId === "string" ? params.handoffId.trim() : "";
  if (payload && handoffId && (!payload.stats || payload.stats.handoffId !== handoffId)) {
    return;
  }
  if (payload) {
    payload = { ...payload, status: "error" };
    delete payload.continuation;
    payload.stats = { ...(payload.stats || {}), reason };
  } else {
    payload = buildFallbackFailurePayload(reason);
  }
  writeJsonFile(params.sentinelPath, { version: 1, payload });
}

(async () => {
  const deadline = Date.now() + params.parentExitTimeoutMs;
  while (isPidAlive(params.parentPid) && Date.now() < deadline) {
    await sleep(250);
  }
  if (isPidAlive(params.parentPid)) {
    appendLog("gateway parent pid " + params.parentPid + " did not exit before handoff timeout");
    markUpdateSentinelFailureIfPending("managed-service-handoff-parent-timeout");
    cleanupSensitiveFiles();
    process.exitCode = 1;
    return;
  }

  appendLog("starting managed update command: " + params.commandLabel);
  let outputFd;
  try {
    outputFd = fs.openSync(params.logPath, "a", 0o600);
    const commandCwd =
      resolveExistingDirectory([
        params.cwd,
        os.homedir(),
        os.tmpdir(),
        path.parse(process.execPath).root,
      ]) || params.cwd;
    if (commandCwd !== params.cwd) {
      appendLog("managed update command cwd fallback: " + params.cwd + " -> " + commandCwd);
    }
    const child = spawn(params.commandArgv[0], params.commandArgv.slice(1), {
      cwd: commandCwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", outputFd, outputFd],
    });
    appendLog("managed update command pid=" + (child.pid || "unknown"));
    const exit = await new Promise((resolve) => {
      child.once("error", (err) => resolve({ error: err }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (exit && exit.error) {
      appendLog("managed update command failed to start: " + (exit.error && exit.error.stack ? exit.error.stack : String(exit.error)));
      markUpdateSentinelFailureIfPending("managed-service-handoff-spawn-failed");
      process.exitCode = 1;
      return;
    }
    appendLog(
      "managed update command exited code=" +
        (exit && exit.code !== null && exit.code !== undefined ? exit.code : "null") +
        " signal=" +
        (exit && exit.signal ? exit.signal : "null"),
    );
    if (exit && typeof exit.code === "number" && exit.code !== 0) {
      markUpdateSentinelFailureIfPending("managed-service-handoff-failed");
      process.exitCode = exit.code;
    } else if (exit && exit.signal) {
      markUpdateSentinelFailureIfPending("managed-service-handoff-failed");
      process.exitCode = 1;
    }
  } finally {
    if (outputFd !== undefined) {
      try {
        fs.closeSync(outputFd);
      } catch {
        // Ignore close failures.
      }
    }
    cleanupSensitiveFiles();
  }
})().catch((err) => {
  appendLog("handoff failed: " + (err && err.stack ? err.stack : String(err)));
  markUpdateSentinelFailureIfPending("managed-service-handoff-helper-failed");
  cleanupSensitiveFiles();
  process.exitCode = 1;
});
`;
function isNodeLikeRuntime(execPath) {
	if (!execPath?.trim()) return false;
	const base = path.basename(execPath).toLowerCase();
	return base === "node" || base === "node.exe" || base === "bun" || base === "bun.exe";
}
function resolveUpdateCliArgv(params) {
	const updateArgs = [
		"update",
		"--yes",
		"--json"
	];
	if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) updateArgs.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1e3))));
	const execPath = params.execPath?.trim();
	const argv1 = params.argv1?.trim();
	if (execPath && argv1) return [
		execPath,
		argv1,
		...updateArgs
	];
	if (execPath && !isNodeLikeRuntime(execPath)) return [execPath, ...updateArgs];
	return ["openclaw", ...updateArgs];
}
function formatManagedServiceUpdateCommand(timeoutMs) {
	const args = [
		"openclaw",
		"update",
		"--yes"
	];
	if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) args.push("--timeout", String(Math.max(1, Math.ceil(timeoutMs / 1e3))));
	return args.join(" ");
}
function stripSupervisorHintEnv(env) {
	const next = { ...env };
	for (const key of SUPERVISOR_HINT_ENV_VARS) {
		if (SERVICE_IDENTITY_ENV_VARS.has(key)) continue;
		delete next[key];
	}
	return next;
}
async function resolveManagedServiceHandoffCwd(root) {
	const candidates = [
		os.homedir(),
		os.tmpdir(),
		path.dirname(process.execPath),
		root
	];
	for (const candidate of candidates) {
		if (!candidate.trim()) continue;
		try {
			if ((await fs$1.stat(candidate)).isDirectory()) return candidate;
		} catch {}
	}
	return root;
}
async function startManagedServiceUpdateHandoff(params) {
	const dir = await fs$1.mkdtemp(path.join(os.tmpdir(), MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX));
	const scriptPath = path.join(dir, "handoff.cjs");
	const paramsPath = path.join(dir, "handoff.json");
	const metaPath = path.join(dir, "sentinel-meta.json");
	const logPath = path.join(dir, "handoff.log");
	const commandArgv = resolveUpdateCliArgv({
		timeoutMs: params.timeoutMs,
		execPath: params.execPath ?? process.execPath,
		argv1: params.argv1 ?? process.argv[1]
	});
	const commandLabel = formatManagedServiceUpdateCommand(params.timeoutMs);
	const handoffCwd = await resolveManagedServiceHandoffCwd(params.root);
	const metaFile = {
		version: 1,
		meta: params.meta
	};
	const helperParams = {
		parentPid: params.parentPid ?? process.pid,
		parentExitTimeoutMs: Math.max(0, params.restartDelayMs ?? 0) + PARENT_EXIT_GRACE_MS,
		cwd: handoffCwd,
		commandArgv,
		commandLabel,
		handoffId: params.handoffId,
		logPath,
		metaPath,
		sentinelPath: resolveRestartSentinelPath(),
		sensitivePaths: [
			scriptPath,
			paramsPath,
			metaPath
		]
	};
	await fs$1.writeFile(scriptPath, `${HANDOFF_SCRIPT}\n`, { mode: 448 });
	await fs$1.writeFile(paramsPath, `${JSON.stringify(helperParams, null, 2)}\n`, { mode: 384 });
	await fs$1.writeFile(metaPath, `${JSON.stringify(metaFile, null, 2)}\n`, { mode: 384 });
	const env = {
		...stripSupervisorHintEnv(params.env ?? process.env),
		[CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
		OPENCLAW_UPDATE_RUN_HANDOFF: "1"
	};
	const child = spawn(params.execPath ?? process.execPath, [scriptPath, paramsPath], {
		cwd: handoffCwd,
		env,
		detached: true,
		stdio: "ignore"
	});
	child.unref();
	return {
		status: "started",
		...child.pid ? { pid: child.pid } : {},
		command: commandLabel,
		logPath
	};
}
function buildManagedServiceHandoffUnavailableMessage(command) {
	return ["Package updates cannot safely run inside the live gateway process.", `Run \`${command}\` from a shell outside the gateway service, or restart/update from the host control plane.`].join("\n");
}
//#endregion
//#region src/gateway/server-methods/update.ts
function formatUpdateRunErrorMessage(err) {
	if (err instanceof Error) return err.message || err.name;
	return String(err);
}
function tryResolveProcessCwd() {
	try {
		return process.cwd();
	} catch {
		return;
	}
}
const updateHandlers = {
	"update.status": async ({ params, respond }) => {
		if (!assertValidParams(params, validateUpdateStatusParams, "update.status", respond)) return;
		respond(true, { sentinel: getLatestUpdateRestartSentinel() });
	},
	"update.run": async ({ params, respond, client, context }) => {
		if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) return;
		const actor = resolveControlPlaneActor(client);
		const { sessionKey, deliveryContext: requestedDeliveryContext, threadId: requestedThreadId, note, continuationMessage, restartDelayMs } = parseRestartRequestParams(params);
		const { deliveryContext: sessionDeliveryContext, threadId: sessionThreadId } = extractDeliveryInfo(sessionKey);
		const deliveryContext = requestedDeliveryContext ?? sessionDeliveryContext;
		const threadId = requestedThreadId ?? sessionThreadId;
		const timeoutMsRaw = params.timeoutMs;
		const timeoutMs = typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) ? Math.max(1e3, Math.floor(timeoutMsRaw)) : void 0;
		let result;
		let handoff = null;
		const sentinelMeta = {
			...sessionKey ? { sessionKey } : {},
			...deliveryContext ? { deliveryContext } : {},
			...threadId ? { threadId } : {},
			...note !== void 0 ? { note } : {},
			...continuationMessage !== void 0 ? { continuationMessage } : {}
		};
		try {
			const config = context.getRuntimeConfig();
			const configChannel = normalizeUpdateChannel(config.update?.channel);
			const invocationCwd = tryResolveProcessCwd();
			const root = await resolveOpenClawPackageRoot({
				moduleUrl: import.meta.url,
				argv1: process.argv[1],
				...invocationCwd ? { cwd: invocationCwd } : {}
			}) ?? invocationCwd ?? os.homedir();
			const installSurface = await resolveUpdateInstallSurface({
				timeoutMs,
				cwd: root,
				argv1: process.argv[1]
			});
			const supervisor = detectRespawnSupervisor(process.env, process.platform);
			if (!isRestartEnabled(config) && !supervisor) {
				const beforeVersion = installSurface.root ? await readPackageVersion(installSurface.root) : null;
				result = {
					status: "skipped",
					mode: installSurface.mode,
					...installSurface.root ? { root: installSurface.root } : {},
					reason: installSurface.kind === "global" ? "restart-unavailable" : "restart-disabled",
					...beforeVersion ? { before: { version: beforeVersion } } : {},
					steps: [],
					durationMs: 0
				};
			} else if (installSurface.kind === "global") {
				const command = formatManagedServiceUpdateCommand(timeoutMs);
				if (supervisor) try {
					const startedAt = Date.now();
					const handoffId = randomUUID();
					sentinelMeta.handoffId = handoffId;
					const started = await startManagedServiceUpdateHandoff({
						root,
						timeoutMs,
						restartDelayMs,
						meta: sentinelMeta,
						handoffId
					});
					handoff = {
						status: "started",
						...started.pid ? { pid: started.pid } : {},
						command: started.command
					};
					const beforeVersion = installSurface.root ? await readPackageVersion(installSurface.root) : null;
					result = {
						status: "skipped",
						mode: installSurface.mode,
						root: installSurface.root,
						reason: CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON,
						...beforeVersion ? { before: { version: beforeVersion } } : {},
						steps: [{
							name: "managed-service update handoff",
							command: started.command,
							cwd: root,
							durationMs: Date.now() - startedAt,
							exitCode: null
						}],
						durationMs: Date.now() - startedAt
					};
				} catch (err) {
					context?.logGateway?.warn(`update.run managed-service handoff failed ${formatControlPlaneActor(actor)} error=${formatUpdateRunErrorMessage(err)}`);
					result = {
						status: "error",
						mode: installSurface.mode,
						root: installSurface.root,
						reason: "managed-service-handoff-failed",
						steps: [],
						durationMs: 0
					};
				}
				else {
					const beforeVersion = installSurface.root ? await readPackageVersion(installSurface.root) : null;
					handoff = {
						status: "unavailable",
						command,
						message: buildManagedServiceHandoffUnavailableMessage(command)
					};
					result = {
						status: "skipped",
						mode: installSurface.mode,
						root: installSurface.root,
						reason: "managed-service-handoff-unavailable",
						...beforeVersion ? { before: { version: beforeVersion } } : {},
						steps: [],
						durationMs: 0
					};
				}
			} else result = await runGatewayUpdate({
				timeoutMs,
				cwd: root,
				argv1: process.argv[1],
				channel: configChannel ?? void 0
			});
		} catch {
			result = {
				status: "error",
				mode: "unknown",
				reason: "unexpected-error",
				steps: [],
				durationMs: 0
			};
		}
		const payload = buildUpdateRestartSentinelPayload({
			result,
			meta: sentinelMeta
		});
		let sentinelPath = null;
		try {
			sentinelPath = await writeRestartSentinel(payload);
			recordLatestUpdateRestartSentinel(payload);
		} catch {
			sentinelPath = null;
		}
		const updateWasPackageSwap = result.status === "ok" && result.mode !== "git";
		const restart = handoff?.status === "started" || result.status === "ok" ? scheduleGatewaySigusr1Restart({
			delayMs: handoff?.status === "started" ? restartDelayMs : updateWasPackageSwap ? 0 : restartDelayMs,
			reason: "update.run",
			skipDeferral: updateWasPackageSwap || handoff?.status === "started",
			skipCooldown: updateWasPackageSwap || handoff?.status === "started",
			audit: {
				actor: actor.actor,
				deviceId: actor.deviceId,
				clientIp: actor.clientIp,
				changedPaths: []
			}
		}) : null;
		context?.logGateway?.info(`update.run completed ${formatControlPlaneActor(actor)} changedPaths=<n/a> restartReason=update.run status=${result.status}`);
		if (restart?.coalesced) context?.logGateway?.warn(`update.run restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`);
		respond(true, {
			ok: result.status === "ok" || handoff?.status === "started",
			result,
			...handoff ? { handoff } : {},
			restart,
			sentinel: {
				path: sentinelPath,
				payload
			}
		}, void 0);
	}
};
//#endregion
//#region src/shared/usage-aggregates.ts
function mergeUsageLatency(totals, latency) {
	if (!latency || latency.count <= 0) return;
	totals.count += latency.count;
	totals.sum += latency.avgMs * latency.count;
	totals.min = Math.min(totals.min, latency.minMs);
	totals.max = Math.max(totals.max, latency.maxMs);
	totals.p95Max = Math.max(totals.p95Max, latency.p95Ms);
}
function mergeUsageDailyLatency(dailyLatencyMap, dailyLatency) {
	for (const day of dailyLatency ?? []) {
		const existing = dailyLatencyMap.get(day.date) ?? {
			date: day.date,
			count: 0,
			sum: 0,
			min: Number.POSITIVE_INFINITY,
			max: 0,
			p95Max: 0
		};
		existing.count += day.count;
		existing.sum += day.avgMs * day.count;
		existing.min = Math.min(existing.min, day.minMs);
		existing.max = Math.max(existing.max, day.maxMs);
		existing.p95Max = Math.max(existing.p95Max, day.p95Ms);
		dailyLatencyMap.set(day.date, existing);
	}
}
function buildUsageAggregateTail(params) {
	return {
		byChannel: Array.from(params.byChannelMap.entries()).map(([channel, totals]) => ({
			channel,
			totals
		})).toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
		latency: params.latencyTotals.count > 0 ? {
			count: params.latencyTotals.count,
			avgMs: params.latencyTotals.sum / params.latencyTotals.count,
			minMs: params.latencyTotals.min === Number.POSITIVE_INFINITY ? 0 : params.latencyTotals.min,
			maxMs: params.latencyTotals.max,
			p95Ms: params.latencyTotals.p95Max
		} : void 0,
		dailyLatency: Array.from(params.dailyLatencyMap.values()).map((entry) => ({
			date: entry.date,
			count: entry.count,
			avgMs: entry.count ? entry.sum / entry.count : 0,
			minMs: entry.min === Number.POSITIVE_INFINITY ? 0 : entry.min,
			maxMs: entry.max,
			p95Ms: entry.p95Max
		})).toSorted((a, b) => a.date.localeCompare(b.date)),
		modelDaily: Array.from(params.modelDailyMap.values()).toSorted((a, b) => a.date.localeCompare(b.date) || b.cost - a.cost),
		daily: Array.from(params.dailyMap.values()).toSorted((a, b) => a.date.localeCompare(b.date))
	};
}
//#endregion
//#region src/gateway/server-methods/usage.ts
const COST_USAGE_CACHE_TTL_MS = 3e4;
const COST_USAGE_CACHE_MAX = 256;
const SESSIONS_USAGE_CACHE_READ_CONCURRENCY = 12;
const DAY_MS = 1440 * 60 * 1e3;
const costUsageCache = /* @__PURE__ */ new Map();
function findCostUsageCacheEvictionKey() {
	for (const [key, entry] of costUsageCache) if (!entry.inFlight) return key;
	return costUsageCache.keys().next().value;
}
function setCostUsageCache(cacheKey, entry) {
	if (!costUsageCache.has(cacheKey) && costUsageCache.size >= COST_USAGE_CACHE_MAX) {
		const evictKey = findCostUsageCacheEvictionKey();
		if (evictKey !== void 0) costUsageCache.delete(evictKey);
	}
	costUsageCache.set(cacheKey, entry);
}
function resolveSessionUsageFileOrRespond(key, respond, config) {
	const { entry, storePath } = loadSessionEntry(key);
	const parsed = parseAgentSessionKey(key);
	const agentId = parsed?.agentId;
	const rawSessionId = parsed?.rest ?? key;
	const sessionId = entry?.sessionId ?? rawSessionId;
	let sessionFile;
	try {
		sessionFile = resolveSessionFilePath(sessionId, entry, resolveSessionFilePathOptions({
			storePath,
			agentId
		}));
	} catch {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session key: ${key}`));
		return null;
	}
	return {
		config,
		entry,
		agentId,
		sessionId,
		sessionFile
	};
}
const parseDateParts = (raw) => {
	if (typeof raw !== "string" || !raw.trim()) return;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
	if (!match) return;
	const [, yearStr, monthStr, dayStr] = match;
	const year = Number(yearStr);
	const monthIndex = Number(monthStr) - 1;
	const day = Number(dayStr);
	if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) return;
	return {
		year,
		monthIndex,
		day
	};
};
/**
* Parse a UTC offset string in the format UTC+H, UTC-H, UTC+HH, UTC-HH, UTC+H:MM, UTC-HH:MM.
* Returns the UTC offset in minutes (east-positive), or undefined if invalid.
*/
const parseUtcOffsetToMinutes = (raw) => {
	if (typeof raw !== "string" || !raw.trim()) return;
	const match = /^UTC([+-])(\d{1,2})(?::([0-5]\d))?$/.exec(raw.trim());
	if (!match) return;
	const sign = match[1] === "+" ? 1 : -1;
	const hours = Number(match[2]);
	const minutes = Number(match[3] ?? "0");
	if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return;
	if (hours > 14 || hours === 14 && minutes !== 0) return;
	const totalMinutes = sign * (hours * 60 + minutes);
	if (totalMinutes < -720 || totalMinutes > 840) return;
	return totalMinutes;
};
const resolveDateInterpretation = (params) => {
	if (params.mode === "gateway") return { mode: "gateway" };
	if (params.mode === "specific") {
		const utcOffsetMinutes = parseUtcOffsetToMinutes(params.utcOffset);
		if (utcOffsetMinutes !== void 0) return {
			mode: "specific",
			utcOffsetMinutes
		};
	}
	return { mode: "utc" };
};
/**
* Parse a date string (YYYY-MM-DD) to start-of-day timestamp based on interpretation mode.
* Returns undefined if invalid.
*/
const parseDateToMs = (raw, interpretation = { mode: "utc" }) => {
	const parts = parseDateParts(raw);
	if (!parts) return;
	const { year, monthIndex, day } = parts;
	if (interpretation.mode === "gateway") {
		const ms = new Date(year, monthIndex, day).getTime();
		return Number.isNaN(ms) ? void 0 : ms;
	}
	if (interpretation.mode === "specific") {
		const ms = Date.UTC(year, monthIndex, day) - interpretation.utcOffsetMinutes * 60 * 1e3;
		return Number.isNaN(ms) ? void 0 : ms;
	}
	const ms = Date.UTC(year, monthIndex, day);
	return Number.isNaN(ms) ? void 0 : ms;
};
const getTodayStartMs = (now, interpretation) => {
	if (interpretation.mode === "gateway") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (interpretation.mode === "specific") {
		const shifted = new Date(now.getTime() + interpretation.utcOffsetMinutes * 60 * 1e3);
		return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - interpretation.utcOffsetMinutes * 60 * 1e3;
	}
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};
const parseDays = (raw) => {
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
	if (typeof raw === "string" && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed)) return Math.floor(parsed);
	}
};
const resolveRangeDays = (raw) => {
	if (raw === "all") return "all";
	if (raw === "7d") return 7;
	if (raw === "30d") return 30;
	if (raw === "90d") return 90;
	if (raw === "1y") return 365;
};
/**
* Get date range from params (startDate/endDate or days).
* Falls back to last 30 days if not provided.
*/
const parseDateRange = (params) => {
	const now = /* @__PURE__ */ new Date();
	const interpretation = resolveDateInterpretation(params);
	const todayStartMs = getTodayStartMs(now, interpretation);
	const todayEndMs = todayStartMs + DAY_MS - 1;
	const startMs = parseDateToMs(params.startDate, interpretation);
	const endMs = parseDateToMs(params.endDate, interpretation);
	if (startMs !== void 0 && endMs !== void 0) return {
		startMs,
		endMs: endMs + DAY_MS - 1
	};
	const rangeDays = resolveRangeDays(params.range);
	if (rangeDays === "all") return {
		startMs: 0,
		endMs: todayEndMs
	};
	if (rangeDays !== void 0) return {
		startMs: todayStartMs - (rangeDays - 1) * DAY_MS,
		endMs: todayEndMs
	};
	const days = parseDays(params.days);
	if (days !== void 0) return {
		startMs: todayStartMs - (Math.max(1, days) - 1) * DAY_MS,
		endMs: todayEndMs
	};
	return {
		startMs: todayStartMs - 29 * DAY_MS,
		endMs: todayEndMs
	};
};
function buildStoreBySessionId(store) {
	const matchesBySessionId = /* @__PURE__ */ new Map();
	for (const [key, entry] of Object.entries(store)) {
		if (!entry?.sessionId) continue;
		const matches = matchesBySessionId.get(entry.sessionId) ?? [];
		matches.push([key, entry]);
		matchesBySessionId.set(entry.sessionId, matches);
	}
	const storeBySessionId = /* @__PURE__ */ new Map();
	for (const [sessionId, matches] of matchesBySessionId) {
		const preferredKey = resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId);
		if (!preferredKey) continue;
		const preferredEntry = store[preferredKey];
		if (preferredEntry) storeBySessionId.set(sessionId, {
			key: preferredKey,
			entry: preferredEntry
		});
	}
	return storeBySessionId;
}
function filterSessionStoreByAgent(params) {
	const scopedAgentId = normalizeAgentId(params.agentId);
	const scopedStore = {};
	for (const [key, entry] of Object.entries(params.store)) {
		if (params.config.session?.scope === "global" && key.trim().toLowerCase() === "global") {
			scopedStore[key] = entry;
			continue;
		}
		if (resolveSessionStoreAgentId(params.config, key) === scopedAgentId) scopedStore[key] = entry;
	}
	return scopedStore;
}
async function discoverAllSessionsForUsage(params) {
	const requestedAgentId = normalizeOptionalString$1(params.agentId);
	const agents = requestedAgentId ? [{ id: normalizeAgentId(requestedAgentId) }] : listAgentsForGateway(params.config).agents;
	return (await Promise.all(agents.map(async (agent) => {
		const agentId = normalizeAgentId(agent.id);
		return (await discoverAllSessions({
			agentId,
			startMs: params.startMs,
			endMs: params.endMs,
			includeFirstUserMessage: false
		})).map((session) => Object.assign({}, session, { agentId }));
	}))).flat().toSorted((a, b) => b.mtime - a.mtime);
}
function addUniqueSessionIds(target, ids) {
	const seen = new Set(target);
	for (const id of ids) {
		const normalized = normalizeOptionalString$1(id);
		if (normalized && !seen.has(normalized)) {
			seen.add(normalized);
			target.push(normalized);
		}
	}
	return target;
}
function resolveUsageFamilySessionIds(entry, currentSessionId) {
	return addUniqueSessionIds([], [currentSessionId, ...entry?.usageFamilySessionIds ?? []]);
}
function resolveUsageFamilyKey(params) {
	return params.entry?.usageFamilyKey ?? params.key ?? params.sessionId;
}
function maybeMergeFamilyEntry(params) {
	if (params.groupingMode !== "family") {
		params.mergedEntries.push(params.base);
		return;
	}
	const includedSessionIds = resolveUsageFamilySessionIds(params.base.storeEntry, params.base.sessionId);
	const sessionFamilyKey = resolveUsageFamilyKey({
		key: params.base.key,
		entry: params.base.storeEntry,
		sessionId: params.base.sessionId
	});
	params.mergedEntries.push({
		...params.base,
		scope: "family",
		sessionFamilyKey,
		currentSessionId: params.base.sessionId,
		includedSessionIds
	});
}
function createEmptySessionCostSummary() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		totalCost: 0,
		inputCost: 0,
		outputCost: 0,
		cacheReadCost: 0,
		cacheWriteCost: 0,
		missingCostEntries: 0
	};
}
function mergeSessionUsageInto(target, source) {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.totalTokens += source.totalTokens;
	target.totalCost += source.totalCost;
	target.inputCost += source.inputCost;
	target.outputCost += source.outputCost;
	target.cacheReadCost += source.cacheReadCost;
	target.cacheWriteCost += source.cacheWriteCost;
	target.missingCostEntries += source.missingCostEntries;
	target.firstActivity = target.firstActivity === void 0 ? source.firstActivity : source.firstActivity === void 0 ? target.firstActivity : Math.min(target.firstActivity, source.firstActivity);
	target.lastActivity = target.lastActivity === void 0 ? source.lastActivity : source.lastActivity === void 0 ? target.lastActivity : Math.max(target.lastActivity, source.lastActivity);
	if (target.firstActivity !== void 0 && target.lastActivity !== void 0) target.durationMs = Math.max(0, target.lastActivity - target.firstActivity);
	const activityDates = new Set([...target.activityDates ?? [], ...source.activityDates ?? []]);
	if (activityDates.size > 0) target.activityDates = Array.from(activityDates).toSorted();
	target.dailyBreakdown = mergeDailyRows(target.dailyBreakdown, source.dailyBreakdown, ["tokens", "cost"]);
	target.dailyMessageCounts = mergeDailyRows(target.dailyMessageCounts, source.dailyMessageCounts, [
		"total",
		"user",
		"assistant",
		"toolCalls",
		"toolResults",
		"errors"
	]);
	target.utcQuarterHourMessageCounts = mergeQuarterRows(target.utcQuarterHourMessageCounts, source.utcQuarterHourMessageCounts, [
		"total",
		"user",
		"assistant",
		"toolCalls",
		"toolResults",
		"errors"
	]);
	target.utcQuarterHourTokenUsage = mergeQuarterRows(target.utcQuarterHourTokenUsage, source.utcQuarterHourTokenUsage, [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"totalTokens",
		"totalCost"
	]);
	target.dailyLatency = mergeDailyLatencyRows(target.dailyLatency, source.dailyLatency);
	target.dailyModelUsage = mergeDailyModelRows(target.dailyModelUsage, source.dailyModelUsage);
	target.messageCounts = mergeMessageCounts(target.messageCounts, source.messageCounts);
	target.toolUsage = mergeToolUsage(target.toolUsage, source.toolUsage);
	target.modelUsage = mergeModelUsage(target.modelUsage, source.modelUsage);
	target.latency = mergeLatency(target.latency, source.latency);
}
function mergeDailyRows(left, right, fields) {
	const map = /* @__PURE__ */ new Map();
	for (const row of [...left ?? [], ...right ?? []]) {
		const existing = map.get(row.date);
		if (!existing) {
			map.set(row.date, { ...row });
			continue;
		}
		for (const field of fields) existing[field] = (existing[field] ?? 0) + (row[field] ?? 0);
	}
	return map.size > 0 ? Array.from(map.values()).toSorted((a, b) => a.date.localeCompare(b.date)) : void 0;
}
function mergeQuarterRows(left, right, fields) {
	const map = /* @__PURE__ */ new Map();
	for (const row of [...left ?? [], ...right ?? []]) {
		const key = `${row.date}:${row.quarterIndex}`;
		const existing = map.get(key);
		if (!existing) {
			map.set(key, { ...row });
			continue;
		}
		for (const field of fields) existing[field] = (existing[field] ?? 0) + (row[field] ?? 0);
	}
	return map.size > 0 ? Array.from(map.values()).toSorted((a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex) : void 0;
}
function mergeMessageCounts(left, right) {
	if (!left && !right) return;
	return {
		total: (left?.total ?? 0) + (right?.total ?? 0),
		user: (left?.user ?? 0) + (right?.user ?? 0),
		assistant: (left?.assistant ?? 0) + (right?.assistant ?? 0),
		toolCalls: (left?.toolCalls ?? 0) + (right?.toolCalls ?? 0),
		toolResults: (left?.toolResults ?? 0) + (right?.toolResults ?? 0),
		errors: (left?.errors ?? 0) + (right?.errors ?? 0)
	};
}
function mergeToolUsage(left, right) {
	const map = /* @__PURE__ */ new Map();
	for (const tool of [...left?.tools ?? [], ...right?.tools ?? []]) map.set(tool.name, (map.get(tool.name) ?? 0) + tool.count);
	return map.size > 0 ? {
		totalCalls: Array.from(map.values()).reduce((sum, count) => sum + count, 0),
		uniqueTools: map.size,
		tools: Array.from(map.entries()).map(([name, count]) => ({
			name,
			count
		})).toSorted((a, b) => b.count - a.count)
	} : void 0;
}
function mergeModelUsage(left, right) {
	const map = /* @__PURE__ */ new Map();
	const mergeTotals = (target, source) => {
		target.input += source.input;
		target.output += source.output;
		target.cacheRead += source.cacheRead;
		target.cacheWrite += source.cacheWrite;
		target.totalTokens += source.totalTokens;
		target.totalCost += source.totalCost;
		target.inputCost += source.inputCost;
		target.outputCost += source.outputCost;
		target.cacheReadCost += source.cacheReadCost;
		target.cacheWriteCost += source.cacheWriteCost;
		target.missingCostEntries += source.missingCostEntries;
	};
	for (const entry of [...left ?? [], ...right ?? []]) {
		const key = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
		const existing = map.get(key) ?? {
			provider: entry.provider,
			model: entry.model,
			count: 0,
			totals: createEmptySessionCostSummary()
		};
		existing.count += entry.count;
		mergeTotals(existing.totals, entry.totals);
		map.set(key, existing);
	}
	return map.size > 0 ? Array.from(map.values()) : void 0;
}
function mergeLatency(left, right) {
	if (!left && !right) return;
	const leftCount = left?.count ?? 0;
	const rightCount = right?.count ?? 0;
	const count = leftCount + rightCount;
	return {
		count,
		avgMs: count > 0 ? ((left?.avgMs ?? 0) * leftCount + (right?.avgMs ?? 0) * rightCount) / count : 0,
		p95Ms: Math.max(left?.p95Ms ?? 0, right?.p95Ms ?? 0),
		minMs: Math.min(left?.minMs ?? Number.POSITIVE_INFINITY, right?.minMs ?? Number.POSITIVE_INFINITY),
		maxMs: Math.max(left?.maxMs ?? 0, right?.maxMs ?? 0)
	};
}
function mergeDailyLatencyRows(left, right) {
	const map = /* @__PURE__ */ new Map();
	for (const row of [...left ?? [], ...right ?? []]) {
		const existing = map.get(row.date);
		if (!existing) {
			map.set(row.date, { ...row });
			continue;
		}
		const count = existing.count + row.count;
		existing.avgMs = count > 0 ? (existing.avgMs * existing.count + row.avgMs * row.count) / count : 0;
		existing.count = count;
		existing.p95Ms = Math.max(existing.p95Ms, row.p95Ms);
		existing.minMs = Math.min(existing.minMs, row.minMs);
		existing.maxMs = Math.max(existing.maxMs, row.maxMs);
	}
	return map.size > 0 ? Array.from(map.values()).toSorted((a, b) => a.date.localeCompare(b.date)) : void 0;
}
function mergeDailyModelRows(left, right) {
	const map = /* @__PURE__ */ new Map();
	for (const row of [...left ?? [], ...right ?? []]) {
		const key = `${row.date}:${row.provider ?? "unknown"}:${row.model ?? "unknown"}`;
		const existing = map.get(key);
		if (!existing) {
			map.set(key, { ...row });
			continue;
		}
		existing.tokens += row.tokens;
		existing.cost += row.cost;
		existing.count += row.count;
	}
	return map.size > 0 ? Array.from(map.values()).toSorted((a, b) => a.date.localeCompare(b.date)) : void 0;
}
async function loadCostUsageSummaryCached(params) {
	const cacheKey = `${params.startMs}-${params.endMs}`;
	const now = Date.now();
	const cached = costUsageCache.get(cacheKey);
	if (cached?.summary && cached.updatedAt && now - cached.updatedAt < COST_USAGE_CACHE_TTL_MS && cached.summary.cacheStatus?.status !== "refreshing") return cached.summary;
	if (cached?.inFlight) {
		if (cached.summary) return cached.summary;
		return await cached.inFlight;
	}
	const entry = cached ?? {};
	const inFlight = loadCostUsageSummaryFromCache({
		startMs: params.startMs,
		endMs: params.endMs,
		config: params.config,
		requestRefresh: true,
		refreshMode: "background"
	}).then((summary) => {
		setCostUsageCache(cacheKey, {
			summary,
			updatedAt: summary.cacheStatus?.status === "refreshing" ? void 0 : Date.now()
		});
		return summary;
	}).catch((err) => {
		if (entry.summary) return entry.summary;
		throw err;
	}).finally(() => {
		const current = costUsageCache.get(cacheKey);
		if (current?.inFlight === inFlight) {
			current.inFlight = void 0;
			setCostUsageCache(cacheKey, current);
		}
	});
	entry.inFlight = inFlight;
	setCostUsageCache(cacheKey, entry);
	if (entry.summary) return entry.summary;
	return await inFlight;
}
function mergeUsageCacheStatus(target, source) {
	if (!target) return { ...source };
	const statusRank = {
		fresh: 0,
		partial: 1,
		stale: 2,
		refreshing: 3
	};
	return {
		status: statusRank[source.status] > statusRank[target.status] ? source.status : target.status,
		cachedFiles: target.cachedFiles + source.cachedFiles,
		pendingFiles: target.pendingFiles + source.pendingFiles,
		staleFiles: target.staleFiles + source.staleFiles,
		refreshedAt: target.refreshedAt === void 0 ? source.refreshedAt : source.refreshedAt === void 0 ? target.refreshedAt : Math.max(target.refreshedAt, source.refreshedAt)
	};
}
const usageHandlers = {
	"usage.status": async ({ respond }) => {
		respond(true, await loadProviderUsageSummary(), void 0);
	},
	"usage.cost": async ({ respond, params, context }) => {
		const config = context.getRuntimeConfig();
		const { startMs, endMs } = parseDateRange({
			startDate: params?.startDate,
			endDate: params?.endDate,
			days: params?.days,
			range: params?.range,
			mode: params?.mode,
			utcOffset: params?.utcOffset
		});
		respond(true, await loadCostUsageSummaryCached({
			startMs,
			endMs,
			config
		}), void 0);
	},
	"sessions.usage": async ({ respond, params, context }) => {
		if (!validateSessionsUsageParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid sessions.usage params: ${formatValidationErrors(validateSessionsUsageParams.errors)}`));
			return;
		}
		const p = params;
		const config = context.getRuntimeConfig();
		const { startMs, endMs } = parseDateRange({
			startDate: p.startDate,
			endDate: p.endDate,
			range: p.range,
			mode: p.mode,
			utcOffset: p.utcOffset
		});
		const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 50;
		const includeContextWeight = p.includeContextWeight ?? false;
		const specificKey = normalizeOptionalString$1(p.key) ?? null;
		const requestedAgentId = normalizeOptionalString$1(p.agentId);
		const specificKeyAgentId = specificKey ? parseAgentSessionKey(specificKey)?.agentId : void 0;
		if (requestedAgentId && specificKeyAgentId && normalizeAgentId(requestedAgentId) !== specificKeyAgentId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"));
			return;
		}
		const effectiveAgentId = normalizeAgentId(requestedAgentId ?? specificKeyAgentId ?? resolveDefaultAgentId(config));
		const groupingMode = p.groupBy === "family" || p.includeHistorical === true ? "family" : "instance";
		const { storePath, store } = loadCombinedSessionStoreForGateway(config, { agentId: effectiveAgentId });
		const scopedStore = filterSessionStoreByAgent({
			config,
			store,
			agentId: effectiveAgentId
		});
		const now = Date.now();
		const mergedEntries = [];
		if (specificKey) {
			const scopedSpecificKey = resolveStoredSessionKeyForAgentStore({
				cfg: config,
				agentId: effectiveAgentId,
				sessionKey: specificKey
			});
			const scopedParsed = parseAgentSessionKey(scopedSpecificKey);
			const agentIdFromKey = scopedParsed?.agentId ?? effectiveAgentId;
			const keyRest = scopedParsed?.rest ?? specificKey;
			const storeBySessionId = buildStoreBySessionId(scopedStore);
			const storeMatch = scopedStore[scopedSpecificKey] ? {
				key: scopedSpecificKey,
				entry: scopedStore[scopedSpecificKey]
			} : scopedStore[specificKey] ? {
				key: specificKey,
				entry: scopedStore[specificKey]
			} : null;
			const storeByIdMatch = storeBySessionId.get(keyRest) ?? (keyRest !== specificKey ? storeBySessionId.get(specificKey) : void 0) ?? null;
			const resolvedStoreKey = storeMatch?.key ?? storeByIdMatch?.key ?? scopedSpecificKey;
			const storeEntry = storeMatch?.entry ?? storeByIdMatch?.entry;
			const sessionId = storeEntry?.sessionId ?? keyRest;
			let sessionFile;
			try {
				sessionFile = resolveExistingUsageSessionFile({
					sessionId,
					sessionEntry: storeEntry,
					sessionFile: resolveSessionFilePath(sessionId, storeEntry, resolveSessionFilePathOptions({
						storePath: storePath !== "(multiple)" ? storePath : void 0,
						agentId: agentIdFromKey
					})),
					agentId: agentIdFromKey
				});
			} catch {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session reference: ${specificKey}`));
				return;
			}
			if (sessionFile) try {
				const stats = fs.statSync(sessionFile);
				if (stats.isFile()) maybeMergeFamilyEntry({
					mergedEntries,
					groupingMode,
					base: {
						key: resolvedStoreKey,
						agentId: agentIdFromKey,
						sessionId,
						sessionFile,
						label: storeEntry?.label,
						updatedAt: storeEntry?.updatedAt ?? stats.mtimeMs,
						storeEntry
					}
				});
			} catch {}
		} else {
			const discoveredSessions = await discoverAllSessionsForUsage({
				config,
				agentId: effectiveAgentId,
				startMs,
				endMs
			});
			const storeBySessionId = buildStoreBySessionId(scopedStore);
			const storeFamilySessionIds = /* @__PURE__ */ new Set();
			if (groupingMode === "family") for (const entry of Object.values(scopedStore)) for (const sessionId of entry?.usageFamilySessionIds ?? []) storeFamilySessionIds.add(sessionId);
			for (const discovered of discoveredSessions) {
				const storeMatch = storeBySessionId.get(discovered.sessionId);
				if (storeMatch) maybeMergeFamilyEntry({
					mergedEntries,
					groupingMode,
					base: {
						key: storeMatch.key,
						agentId: discovered.agentId,
						sessionId: discovered.sessionId,
						sessionFile: discovered.sessionFile,
						label: storeMatch.entry.label,
						updatedAt: storeMatch.entry.updatedAt ?? discovered.mtime,
						storeEntry: storeMatch.entry
					}
				});
				else {
					if (groupingMode === "family" && storeFamilySessionIds.has(discovered.sessionId)) continue;
					mergedEntries.push({
						key: `agent:${discovered.agentId}:${discovered.sessionId}`,
						agentId: discovered.agentId,
						sessionId: discovered.sessionId,
						sessionFile: discovered.sessionFile,
						label: void 0,
						updatedAt: discovered.mtime,
						scope: "instance"
					});
				}
			}
		}
		mergedEntries.sort((a, b) => b.updatedAt - a.updatedAt);
		const limitedEntries = mergedEntries.slice(0, limit);
		const sessions = [];
		const aggregateTotals = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			totalCost: 0,
			inputCost: 0,
			outputCost: 0,
			cacheReadCost: 0,
			cacheWriteCost: 0,
			missingCostEntries: 0
		};
		const aggregateMessages = {
			total: 0,
			user: 0,
			assistant: 0,
			toolCalls: 0,
			toolResults: 0,
			errors: 0
		};
		const toolAggregateMap = /* @__PURE__ */ new Map();
		const byModelMap = /* @__PURE__ */ new Map();
		const byProviderMap = /* @__PURE__ */ new Map();
		const byAgentMap = /* @__PURE__ */ new Map();
		const byChannelMap = /* @__PURE__ */ new Map();
		const dailyAggregateMap = /* @__PURE__ */ new Map();
		const latencyTotals = {
			count: 0,
			sum: 0,
			min: Number.POSITIVE_INFINITY,
			max: 0,
			p95Max: 0
		};
		const dailyLatencyMap = /* @__PURE__ */ new Map();
		const modelDailyMap = /* @__PURE__ */ new Map();
		let cacheStatus;
		const emptyTotals = () => ({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			totalCost: 0,
			inputCost: 0,
			outputCost: 0,
			cacheReadCost: 0,
			cacheWriteCost: 0,
			missingCostEntries: 0
		});
		const mergeTotals = (target, source) => {
			target.input += source.input;
			target.output += source.output;
			target.cacheRead += source.cacheRead;
			target.cacheWrite += source.cacheWrite;
			target.totalTokens += source.totalTokens;
			target.totalCost += source.totalCost;
			target.inputCost += source.inputCost;
			target.outputCost += source.outputCost;
			target.cacheReadCost += source.cacheReadCost;
			target.cacheWriteCost += source.cacheWriteCost;
			target.missingCostEntries += source.missingCostEntries;
		};
		const usageByEntryIndex = Array.from({ length: limitedEntries.length }, () => null);
		const usageLoadTasks = [];
		for (const [entryIndex, merged] of limitedEntries.entries()) {
			const includedSessionIds = merged.includedSessionIds ?? [merged.sessionId];
			for (const includedSessionId of includedSessionIds) {
				const isCurrentSession = includedSessionId === merged.sessionId;
				const includedSessionFile = isCurrentSession ? merged.sessionFile : resolveExistingUsageSessionFile({
					sessionId: includedSessionId,
					agentId: merged.agentId
				});
				if (!includedSessionFile) continue;
				usageLoadTasks.push(async () => {
					const cachedUsage = await loadSessionCostSummaryFromCache({
						sessionId: includedSessionId,
						sessionEntry: isCurrentSession ? merged.storeEntry : void 0,
						sessionFile: includedSessionFile,
						config,
						agentId: merged.agentId,
						startMs,
						endMs,
						refreshMode: "background"
					});
					return {
						entryIndex,
						cacheStatus: cachedUsage.cacheStatus,
						summary: cachedUsage.summary
					};
				});
			}
		}
		const usageLoadResult = await runTasksWithConcurrency({
			tasks: usageLoadTasks,
			limit: SESSIONS_USAGE_CACHE_READ_CONCURRENCY,
			errorMode: "stop"
		});
		if (usageLoadResult.hasError) throw usageLoadResult.firstError;
		for (const loaded of usageLoadResult.results) {
			cacheStatus = mergeUsageCacheStatus(cacheStatus, loaded.cacheStatus);
			if (!loaded.summary) continue;
			const merged = limitedEntries[loaded.entryIndex];
			const usage = usageByEntryIndex[loaded.entryIndex] ?? createEmptySessionCostSummary();
			usage.sessionId = merged.sessionId;
			usage.sessionFile = merged.sessionFile;
			mergeSessionUsageInto(usage, loaded.summary);
			usageByEntryIndex[loaded.entryIndex] = usage;
		}
		for (const [entryIndex, merged] of limitedEntries.entries()) {
			const agentId = merged.agentId;
			const usage = usageByEntryIndex[entryIndex];
			if (usage) {
				aggregateTotals.input += usage.input;
				aggregateTotals.output += usage.output;
				aggregateTotals.cacheRead += usage.cacheRead;
				aggregateTotals.cacheWrite += usage.cacheWrite;
				aggregateTotals.totalTokens += usage.totalTokens;
				aggregateTotals.totalCost += usage.totalCost;
				aggregateTotals.inputCost += usage.inputCost;
				aggregateTotals.outputCost += usage.outputCost;
				aggregateTotals.cacheReadCost += usage.cacheReadCost;
				aggregateTotals.cacheWriteCost += usage.cacheWriteCost;
				aggregateTotals.missingCostEntries += usage.missingCostEntries;
			}
			const channel = merged.storeEntry?.channel ?? merged.storeEntry?.origin?.provider;
			const chatType = merged.storeEntry?.chatType ?? merged.storeEntry?.origin?.chatType;
			if (usage) {
				if (usage.messageCounts) {
					aggregateMessages.total += usage.messageCounts.total;
					aggregateMessages.user += usage.messageCounts.user;
					aggregateMessages.assistant += usage.messageCounts.assistant;
					aggregateMessages.toolCalls += usage.messageCounts.toolCalls;
					aggregateMessages.toolResults += usage.messageCounts.toolResults;
					aggregateMessages.errors += usage.messageCounts.errors;
				}
				if (usage.toolUsage) for (const tool of usage.toolUsage.tools) toolAggregateMap.set(tool.name, (toolAggregateMap.get(tool.name) ?? 0) + tool.count);
				if (usage.modelUsage) for (const entry of usage.modelUsage) {
					const modelKey = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
					const modelExisting = byModelMap.get(modelKey) ?? {
						provider: entry.provider,
						model: entry.model,
						count: 0,
						totals: emptyTotals()
					};
					modelExisting.count += entry.count;
					mergeTotals(modelExisting.totals, entry.totals);
					byModelMap.set(modelKey, modelExisting);
					const providerKey = entry.provider ?? "unknown";
					const providerExisting = byProviderMap.get(providerKey) ?? {
						provider: entry.provider,
						model: void 0,
						count: 0,
						totals: emptyTotals()
					};
					providerExisting.count += entry.count;
					mergeTotals(providerExisting.totals, entry.totals);
					byProviderMap.set(providerKey, providerExisting);
				}
				mergeUsageLatency(latencyTotals, usage.latency);
				mergeUsageDailyLatency(dailyLatencyMap, usage.dailyLatency);
				if (usage.dailyModelUsage) for (const entry of usage.dailyModelUsage) {
					const key = `${entry.date}::${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
					const existing = modelDailyMap.get(key) ?? {
						date: entry.date,
						provider: entry.provider,
						model: entry.model,
						tokens: 0,
						cost: 0,
						count: 0
					};
					existing.tokens += entry.tokens;
					existing.cost += entry.cost;
					existing.count += entry.count;
					modelDailyMap.set(key, existing);
				}
				if (agentId) {
					const agentTotals = byAgentMap.get(agentId) ?? emptyTotals();
					mergeTotals(agentTotals, usage);
					byAgentMap.set(agentId, agentTotals);
				}
				if (channel) {
					const channelTotals = byChannelMap.get(channel) ?? emptyTotals();
					mergeTotals(channelTotals, usage);
					byChannelMap.set(channel, channelTotals);
				}
				if (usage.dailyBreakdown) for (const day of usage.dailyBreakdown) {
					const daily = dailyAggregateMap.get(day.date) ?? {
						date: day.date,
						tokens: 0,
						cost: 0,
						messages: 0,
						toolCalls: 0,
						errors: 0
					};
					daily.tokens += day.tokens;
					daily.cost += day.cost;
					dailyAggregateMap.set(day.date, daily);
				}
				if (usage.dailyMessageCounts) for (const day of usage.dailyMessageCounts) {
					const daily = dailyAggregateMap.get(day.date) ?? {
						date: day.date,
						tokens: 0,
						cost: 0,
						messages: 0,
						toolCalls: 0,
						errors: 0
					};
					daily.messages += day.total;
					daily.toolCalls += day.toolCalls;
					daily.errors += day.errors;
					dailyAggregateMap.set(day.date, daily);
				}
			}
			sessions.push({
				key: merged.key,
				label: merged.label,
				sessionId: merged.sessionId,
				scope: merged.scope ?? "instance",
				sessionFamilyKey: merged.sessionFamilyKey,
				currentSessionId: merged.currentSessionId,
				includedSessionIds: merged.includedSessionIds,
				historicalInstanceCount: merged.includedSessionIds?.length,
				updatedAt: merged.updatedAt,
				agentId,
				channel,
				chatType,
				origin: merged.storeEntry?.origin,
				modelOverride: merged.storeEntry?.modelOverride,
				providerOverride: merged.storeEntry?.providerOverride,
				modelProvider: merged.storeEntry?.modelProvider,
				model: merged.storeEntry?.model,
				usage,
				contextWeight: includeContextWeight ? merged.storeEntry?.systemPromptReport ?? null : void 0
			});
		}
		const formatDateStr = (ms) => {
			const d = new Date(ms);
			return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
		};
		const tail = buildUsageAggregateTail({
			byChannelMap,
			latencyTotals,
			dailyLatencyMap,
			modelDailyMap,
			dailyMap: dailyAggregateMap
		});
		const aggregates = {
			messages: aggregateMessages,
			tools: {
				totalCalls: Array.from(toolAggregateMap.values()).reduce((sum, count) => sum + count, 0),
				uniqueTools: toolAggregateMap.size,
				tools: Array.from(toolAggregateMap.entries()).map(([name, count]) => ({
					name,
					count
				})).toSorted((a, b) => b.count - a.count)
			},
			byModel: Array.from(byModelMap.values()).toSorted((a, b) => {
				const costDiff = (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0);
				if (costDiff !== 0) return costDiff;
				return (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0);
			}),
			byProvider: Array.from(byProviderMap.values()).toSorted((a, b) => {
				const costDiff = (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0);
				if (costDiff !== 0) return costDiff;
				return (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0);
			}),
			byAgent: Array.from(byAgentMap.entries()).map(([id, totals]) => ({
				agentId: id,
				totals
			})).toSorted((a, b) => (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0)),
			...tail
		};
		respond(true, {
			updatedAt: now,
			startDate: formatDateStr(startMs),
			endDate: formatDateStr(endMs),
			sessions,
			totals: aggregateTotals,
			aggregates,
			cacheStatus
		}, void 0);
	},
	"sessions.usage.timeseries": async ({ respond, params, context }) => {
		const key = normalizeOptionalString$1(params?.key) ?? null;
		if (!key) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "key is required for timeseries"));
			return;
		}
		const resolved = resolveSessionUsageFileOrRespond(key, respond, context.getRuntimeConfig());
		if (!resolved) return;
		const { config, entry, agentId, sessionId, sessionFile } = resolved;
		const timeseries = await loadSessionUsageTimeSeries({
			sessionId,
			sessionEntry: entry,
			sessionFile,
			config,
			agentId,
			maxPoints: 200
		});
		if (!timeseries) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `No transcript found for session: ${key}`));
			return;
		}
		respond(true, timeseries, void 0);
	},
	"sessions.usage.logs": async ({ respond, params, context }) => {
		const key = normalizeOptionalString$1(params?.key) ?? null;
		if (!key) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "key is required for logs"));
			return;
		}
		const limit = typeof params?.limit === "number" && Number.isFinite(params.limit) ? Math.min(params.limit, 1e3) : 200;
		const resolved = resolveSessionUsageFileOrRespond(key, respond, context.getRuntimeConfig());
		if (!resolved) return;
		const { config, entry, agentId, sessionId, sessionFile } = resolved;
		respond(true, { logs: await loadSessionLogs({
			sessionId,
			sessionEntry: entry,
			sessionFile,
			config,
			agentId,
			limit
		}) ?? [] }, void 0);
	}
};
//#endregion
//#region src/gateway/server-methods/voicewake-routing.ts
const voicewakeRoutingHandlers = {
	"voicewake.routing.get": async ({ respond }) => {
		try {
			respond(true, { config: await loadVoiceWakeRoutingConfig() });
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
		}
	},
	"voicewake.routing.set": async ({ params, respond, context }) => {
		if (!params || params.config === null || typeof params.config !== "object" || Array.isArray(params.config)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "voicewake.routing.set requires config: object"));
			return;
		}
		const validated = validateVoiceWakeRoutingConfigInput(params.config);
		if (!validated.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, validated.message));
			return;
		}
		try {
			const config = await setVoiceWakeRoutingConfig(normalizeVoiceWakeRoutingConfig(params.config));
			context.broadcastVoiceWakeRoutingChanged(config);
			respond(true, { config });
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
		}
	}
};
//#endregion
//#region src/gateway/server-methods/voicewake.ts
const voicewakeHandlers = {
	"voicewake.get": async ({ respond }) => {
		try {
			respond(true, { triggers: (await loadVoiceWakeConfig()).triggers });
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"voicewake.set": async ({ params, respond, context }) => {
		if (!Array.isArray(params.triggers)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "voicewake.set requires triggers: string[]"));
			return;
		}
		try {
			const cfg = await setVoiceWakeTriggers(normalizeVoiceWakeTriggers(params.triggers));
			context.broadcastVoiceWakeChanged(cfg.triggers);
			respond(true, { triggers: cfg.triggers });
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	}
};
//#endregion
//#region src/gateway/server-methods/web.ts
const WEB_LOGIN_METHODS = new Set(["web.login.start", "web.login.wait"]);
const resolveWebLoginProvider = () => listChannelPlugins().find((plugin) => [...plugin.gatewayMethods ?? [], ...(plugin.gatewayMethodDescriptors ?? []).map((descriptor) => descriptor.name)].some((method) => WEB_LOGIN_METHODS.has(method))) ?? null;
function resolveAccountId(params) {
	return typeof params.accountId === "string" ? params.accountId : void 0;
}
function respondProviderUnavailable(respond) {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "web login provider is not available"));
}
function respondProviderUnsupported(respond, providerId) {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `web login is not supported by provider ${providerId}`));
}
function wasChannelRunning(params) {
	const runtime = params.context.getRuntimeSnapshot();
	if (params.accountId) {
		const accountRuntime = runtime.channelAccounts[params.channelId]?.[params.accountId];
		if (accountRuntime) return accountRuntime.running === true;
	}
	if (!params.accountId) return runtime.channels[params.channelId]?.running === true;
	const defaultRuntime = runtime.channels[params.channelId];
	return defaultRuntime?.accountId === params.accountId && defaultRuntime.running === true;
}
const webHandlers = {
	"web.login.start": async ({ params, respond, context }) => {
		if (!validateWebLoginStartParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid web.login.start params: ${formatValidationErrors(validateWebLoginStartParams.errors)}`));
			return;
		}
		try {
			const accountId = resolveAccountId(params);
			const provider = resolveWebLoginProvider();
			if (!provider) {
				respondProviderUnavailable(respond);
				return;
			}
			if (!provider.gateway?.loginWithQrStart) {
				respondProviderUnsupported(respond, provider.id);
				return;
			}
			const wasRunning = wasChannelRunning({
				context,
				channelId: provider.id,
				accountId
			});
			await context.stopChannel(provider.id, accountId);
			const result = await provider.gateway.loginWithQrStart({
				force: Boolean(params.force),
				timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : void 0,
				verbose: Boolean(params.verbose),
				accountId
			});
			if (result.connected) await context.startChannel(provider.id, accountId);
			else if (wasRunning && !result.qrDataUrl) await context.startChannel(provider.id, accountId);
			respond(true, result, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"web.login.wait": async ({ params, respond, context }) => {
		if (!validateWebLoginWaitParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid web.login.wait params: ${formatValidationErrors(validateWebLoginWaitParams.errors)}`));
			return;
		}
		try {
			const accountId = resolveAccountId(params);
			const provider = resolveWebLoginProvider();
			if (!provider) {
				respondProviderUnavailable(respond);
				return;
			}
			if (!provider.gateway?.loginWithQrWait) {
				respondProviderUnsupported(respond, provider.id);
				return;
			}
			const result = await provider.gateway.loginWithQrWait({
				timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : void 0,
				accountId,
				currentQrDataUrl: typeof params.currentQrDataUrl === "string" ? params.currentQrDataUrl : void 0
			});
			if (result.connected) await context.startChannel(provider.id, accountId);
			respond(true, result, void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	}
};
//#endregion
//#region src/wizard/session.ts
function createDeferred() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
}
var WizardSessionPrompter = class {
	constructor(session) {
		this.session = session;
	}
	async intro(title) {
		await this.prompt({
			type: "note",
			title,
			message: "",
			executor: "client"
		});
	}
	async outro(message) {
		await this.prompt({
			type: "note",
			title: "Done",
			message,
			executor: "client"
		});
	}
	async note(message, title) {
		await this.prompt({
			type: "note",
			title,
			message,
			executor: "client"
		});
	}
	async plain(message) {
		await this.prompt({
			type: "note",
			message,
			format: "plain",
			executor: "client"
		});
	}
	async select(params) {
		return await this.prompt({
			type: "select",
			message: params.message,
			options: params.options.map((opt) => ({
				value: opt.value,
				label: opt.label,
				hint: opt.hint
			})),
			initialValue: params.initialValue,
			executor: "client"
		});
	}
	async multiselect(params) {
		const res = await this.prompt({
			type: "multiselect",
			message: params.message,
			options: params.options.map((opt) => ({
				value: opt.value,
				label: opt.label,
				hint: opt.hint
			})),
			initialValue: params.initialValues,
			executor: "client"
		});
		return Array.isArray(res) ? res : [];
	}
	async text(params) {
		const res = await this.prompt({
			type: "text",
			message: params.message,
			initialValue: params.initialValue,
			placeholder: params.placeholder,
			sensitive: params.sensitive,
			executor: "client"
		});
		const value = res === null || res === void 0 ? "" : typeof res === "string" ? res : typeof res === "number" || typeof res === "boolean" || typeof res === "bigint" ? String(res) : "";
		const error = params.validate?.(value);
		if (error) throw new Error(error);
		return value;
	}
	async confirm(params) {
		const res = await this.prompt({
			type: "confirm",
			message: params.message,
			initialValue: params.initialValue,
			executor: "client"
		});
		return Boolean(res);
	}
	progress(_label) {
		return {
			update: (_message) => {},
			stop: (_message) => {}
		};
	}
	async prompt(step) {
		return await this.session.awaitAnswer({
			...step,
			id: randomUUID()
		});
	}
};
var WizardSession = class {
	constructor(runner) {
		this.runner = runner;
		this.currentStep = null;
		this.stepDeferred = null;
		this.pendingTerminalResolution = false;
		this.answerDeferred = /* @__PURE__ */ new Map();
		this.status = "running";
		const prompter = new WizardSessionPrompter(this);
		this.run(prompter);
	}
	async next() {
		if (this.currentStep) return {
			done: false,
			step: this.currentStep,
			status: this.status
		};
		if (this.pendingTerminalResolution) {
			this.pendingTerminalResolution = false;
			return {
				done: true,
				status: this.status,
				error: this.error
			};
		}
		if (this.status !== "running") return {
			done: true,
			status: this.status,
			error: this.error
		};
		if (!this.stepDeferred) this.stepDeferred = createDeferred();
		const step = await this.stepDeferred.promise;
		if (step) return {
			done: false,
			step,
			status: this.status
		};
		return {
			done: true,
			status: this.status,
			error: this.error
		};
	}
	async answer(stepId, value) {
		const deferred = this.answerDeferred.get(stepId);
		if (!deferred) throw new Error("wizard: no pending step");
		this.answerDeferred.delete(stepId);
		this.currentStep = null;
		deferred.resolve(value);
	}
	cancel() {
		if (this.status !== "running") return;
		this.status = "cancelled";
		this.error = "cancelled";
		this.currentStep = null;
		for (const [, deferred] of this.answerDeferred) deferred.reject(new WizardCancelledError());
		this.answerDeferred.clear();
		this.resolveStep(null);
	}
	pushStep(step) {
		this.currentStep = step;
		this.resolveStep(step);
	}
	async run(prompter) {
		try {
			await this.runner(prompter);
			this.status = "done";
		} catch (err) {
			if (err instanceof WizardCancelledError) {
				this.status = "cancelled";
				this.error = err.message;
			} else {
				this.status = "error";
				this.error = String(err);
			}
		} finally {
			this.resolveStep(null);
		}
	}
	async awaitAnswer(step) {
		if (this.status !== "running") throw new Error("wizard: session not running");
		this.pushStep(step);
		const deferred = createDeferred();
		this.answerDeferred.set(step.id, deferred);
		return await deferred.promise;
	}
	resolveStep(step) {
		if (!this.stepDeferred) {
			if (step === null) this.pendingTerminalResolution = true;
			return;
		}
		const deferred = this.stepDeferred;
		this.stepDeferred = null;
		deferred.resolve(step);
	}
	getStatus() {
		return this.status;
	}
	getError() {
		return this.error;
	}
};
//#endregion
//#region src/gateway/server-methods/wizard.ts
function readWizardStatus(session) {
	return {
		status: session.getStatus(),
		error: session.getError()
	};
}
function findWizardSessionOrRespond(params) {
	const session = params.context.wizardSessions.get(params.sessionId);
	if (!session) {
		params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not found"));
		return null;
	}
	return session;
}
const wizardHandlers = {
	"wizard.start": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateWizardStartParams, "wizard.start", respond)) return;
		if (context.findRunningWizard()) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "wizard already running"));
			return;
		}
		const sessionId = randomUUID();
		const opts = {
			mode: params.mode,
			workspace: readStringValue(params.workspace)
		};
		const session = new WizardSession((prompter) => context.wizardRunner(opts, defaultRuntime, prompter));
		context.wizardSessions.set(sessionId, session);
		const result = await session.next();
		if (result.done) context.purgeWizardSession(sessionId);
		respond(true, {
			sessionId,
			...result
		}, void 0);
	},
	"wizard.next": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateWizardNextParams, "wizard.next", respond)) return;
		const sessionId = params.sessionId;
		const session = findWizardSessionOrRespond({
			context,
			respond,
			sessionId
		});
		if (!session) return;
		const answer = params.answer;
		if (answer) {
			if (session.getStatus() !== "running") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not running"));
				return;
			}
			try {
				await session.answer(answer.stepId ?? "", answer.value);
			} catch (err) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
				return;
			}
		}
		const result = await session.next();
		if (result.done) context.purgeWizardSession(sessionId);
		respond(true, result, void 0);
	},
	"wizard.cancel": ({ params, respond, context }) => {
		if (!assertValidParams(params, validateWizardCancelParams, "wizard.cancel", respond)) return;
		const sessionId = params.sessionId;
		const session = findWizardSessionOrRespond({
			context,
			respond,
			sessionId
		});
		if (!session) return;
		session.cancel();
		const status = readWizardStatus(session);
		context.wizardSessions.delete(sessionId);
		respond(true, status, void 0);
	},
	"wizard.status": ({ params, respond, context }) => {
		if (!assertValidParams(params, validateWizardStatusParams, "wizard.status", respond)) return;
		const sessionId = params.sessionId;
		const session = findWizardSessionOrRespond({
			context,
			respond,
			sessionId
		});
		if (!session) return;
		const status = readWizardStatus(session);
		if (status.status !== "running") context.wizardSessions.delete(sessionId);
		respond(true, status, void 0);
	}
};
//#endregion
//#region src/gateway/server-methods.ts
function authorizeGatewayMethod(method, client, params) {
	if (!client?.connect) return null;
	if (method === "health") return null;
	const roleRaw = client.connect.role ?? "operator";
	const role = parseGatewayRole(roleRaw);
	if (!role) return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${roleRaw}`);
	const scopes = client.connect.scopes ?? [];
	if (!isRoleAuthorizedForMethod(role, method)) return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
	if (role === "node") return null;
	if (scopes.includes("operator.admin")) return null;
	const scopeAuth = authorizeOperatorScopesForMethod(method, scopes, params);
	if (!scopeAuth.allowed) return errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${scopeAuth.missingScope}`);
	return null;
}
const coreGatewayHandlers = {
	...connectHandlers,
	...logsHandlers,
	...voicewakeHandlers,
	...voicewakeRoutingHandlers,
	...healthHandlers,
	...channelsHandlers,
	...chatHandlers,
	...commandsHandlers,
	...cronHandlers,
	...deviceHandlers,
	...diagnosticsHandlers,
	...doctorHandlers,
	...environmentsHandlers,
	...execApprovalsHandlers,
	...webHandlers,
	...modelsHandlers,
	...modelsAuthStatusHandlers,
	...nativeHookRelayHandlers,
	...pluginHostHookHandlers,
	...configHandlers,
	...wizardHandlers,
	...talkHandlers,
	...tasksHandlers,
	...toolsCatalogHandlers,
	...toolsEffectiveHandlers,
	...toolsInvokeHandlers,
	...ttsHandlers,
	...skillsHandlers,
	...sessionsHandlers,
	...systemHandlers,
	...updateHandlers,
	...nodeHandlers,
	...nodePendingHandlers,
	...pushHandlers,
	...restartHandlers,
	...sendHandlers,
	...usageHandlers,
	...agentHandlers,
	...agentsHandlers,
	...artifactsHandlers
};
function createRequestGatewayMethodRegistry(extraHandlers) {
	const activePluginRegistry = getPluginRegistryState()?.activeRegistry;
	const activePluginHandlers = activePluginRegistry?.gatewayHandlers ?? {};
	const extraHandlerEntries = Object.entries(extraHandlers ?? {});
	const pluginMethodNames = new Set(Object.keys(activePluginHandlers));
	const coreDescriptorHandlers = { ...coreGatewayHandlers };
	for (const [method, extraHandler] of extraHandlerEntries) if (!pluginMethodNames.has(method) && isCoreGatewayMethodClassified(method)) coreDescriptorHandlers[method] = extraHandler;
	const coreDescriptors = createCoreGatewayMethodDescriptors(coreDescriptorHandlers);
	for (const descriptor of coreDescriptors) {
		const extraHandler = extraHandlers?.[descriptor.name];
		if (extraHandler && !pluginMethodNames.has(descriptor.name)) descriptor.handler = extraHandler;
	}
	const coreMethodNames = new Set(coreDescriptors.map((descriptor) => descriptor.name));
	const auxHandlers = Object.fromEntries(extraHandlerEntries.filter(([method]) => !pluginMethodNames.has(method) && !coreMethodNames.has(method)));
	return createGatewayMethodRegistry([
		...coreDescriptors,
		...activePluginRegistry ? createPluginGatewayMethodDescriptors(activePluginRegistry) : [],
		...createGatewayMethodDescriptorsFromHandlers({
			handlers: auxHandlers,
			owner: {
				kind: "aux",
				area: "gateway-extra"
			},
			defaultScope: ADMIN_SCOPE$1
		})
	]);
}
async function handleGatewayRequest(opts) {
	const { req, respond, client, isWebchatConnect, context } = opts;
	const methodRegistry = opts.methodRegistry ?? createRequestGatewayMethodRegistry(opts.extraHandlers);
	const authError = authorizeGatewayMethod(req.method, client, req.params);
	if (authError) {
		respond(false, void 0, authError);
		return;
	}
	if (context.unavailableGatewayMethods?.has(req.method)) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `${req.method} unavailable during gateway startup`, {
			retryable: true,
			retryAfterMs: 500,
			details: {
				...gatewayStartupUnavailableDetails(),
				method: req.method
			}
		}));
		return;
	}
	if (methodRegistry.isControlPlaneWrite(req.method)) {
		const budget = consumeControlPlaneWriteBudget({ client });
		if (!budget.allowed) {
			const actor = resolveControlPlaneActor(client);
			context.logGateway.warn(`control-plane write rate-limited method=${req.method} ${formatControlPlaneActor(actor)} retryAfterMs=${budget.retryAfterMs} key=${budget.key}`);
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `rate limit exceeded for ${req.method}; retry after ${Math.ceil(budget.retryAfterMs / 1e3)}s`, {
				retryable: true,
				retryAfterMs: budget.retryAfterMs,
				details: {
					method: req.method,
					limit: "3 per 60s"
				}
			}));
			return;
		}
	}
	const handler = methodRegistry.getHandler(req.method);
	if (!handler) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`));
		return;
	}
	const invokeHandler = () => handler({
		req,
		params: req.params ?? {},
		client,
		isWebchatConnect,
		respond,
		context
	});
	await withPluginRuntimeGatewayRequestScope({
		context,
		client,
		isWebchatConnect
	}, invokeHandler);
}
//#endregion
export { coreGatewayHandlers, handleGatewayRequest };
