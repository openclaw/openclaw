import { a as __toCommonJS } from "./chunk-DORXReHP.js";
import { i as compileConfigRegex, s as testRegexWithBoundedInput } from "./redact-qojvLPM7.js";
import { a as hasErrnoCode, r as formatErrorMessage } from "./errors-nCFRNLA6.js";
import { a as registerUnhandledRejectionHandler } from "./unhandled-rejections-DGuis5pC.js";
import { c as setVerbose, f as getChildLogger, m as getResolvedLoggerSettings, o as logVerbose, p as getLogger, r as init_globals } from "./globals-B6h30oSy.js";
import { a as isNixMode, d as resolveGatewayPort, i as init_paths, r as STATE_DIR, s as resolveConfigPath, t as CONFIG_PATH, u as resolveGatewayLockDir, v as resolveStateDir } from "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme, r as isRich, t as colorize } from "./theme-CL08MjAq.js";
import { a as init_console, c as setConsoleTimestampPrefix, d as defaultRuntime, f as init_runtime, n as init_subsystem, r as runtimeForLogger, s as setConsoleSubsystemFilter, t as createSubsystemLogger } from "./subsystem-CZwunM2N.js";
import { n as sanitizeForLog, t as init_ansi } from "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import { n as logAcceptedEnvOption, t as isTruthyEnvValue } from "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import { C as shortenHomePath, D as truncateUtf16Safe, b as resolveUserPath, c as ensureDir, d as init_utils, k as isPlainObject, l as escapeRegExp, r as clamp, w as sleep } from "./utils-BiUV1eIQ.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { n as inheritOptionFromParent } from "./command-options-CwQM9XPT.js";
import { $ as applyPluginAutoEnable, $a as markGatewaySigusr1RestartHandled, $b as OpenClawSchema, $i as listSessionsFromStore, $o as resolveSystemRunApprovalRequestContext, $p as extractDeliveryInfo, $s as resolveTtsApiKey, $u as handleReset, Ai as resolveSubagentToolPolicy, Ap as loadModelCatalog, Ar as removeRemoteNodeInfo, B as formatThinkingLevels, Ba as resolveOutboundChannelPlugin, Bb as parseConfigJson5, Bo as clearSecretsRuntimeSnapshot, Bp as resolveInputFileLimits, Bt as buildBareSessionResetPrompt, Bv as evaluateSessionFreshness, Ca as resolveSessionDeliveryTarget, Cc as resetAllLanes, Cf as resolveAgentAvatar, Cm as readSessionPreviewItemsFromTranscript, D as isCliProvider, Df as readJsonBodyWithLimit, Dl as saveCronStore, Dm as stripInlineDirectiveTagsForDisplay, Dr as recordRemoteNodeInfo, E as getModelRefStatus, Ec as CommandLane, Ei as buildDefaultToolPolicyPipelineSteps, El as resolveCronStorePath, Em as stripEnvelopeFromMessages, Er as primeRemoteSkillsCache, Es as normalizeExecApprovals, F as resolveDefaultModelForAgent, Fd as getAgentRunContext, Ff as resolveAgentIdentity, Fp as DEFAULT_INPUT_IMAGE_MIMES, Fr as renamePairedNode, Ft as getLastHeartbeatEvent, Fx as applyMergePatch, Ga as runWithModelFallback, Gb as resolveConfigSnapshotHash, Gi as loadProviderUsageSummary, Go as evaluateGatewayAuthSurfaceStates, Gu as isWithinDir, Hb as readBestEffortConfig, Hi as resolveNestedAgentLane, Ho as prepareSecretsRuntimeSnapshot, Ht as setCliSessionId, Hv as resolveSessionResetPolicy, I as resolveHooksGmailModel, Ia as maybeResolveIdLikeTarget, Ib as createConfigIO, Id as onAgentEvent, If as resolveEffectiveMessagesConfig, Io as closeTrackedBrowserTabsForSessions, Ip as DEFAULT_INPUT_TIMEOUT_MS, Ir as requestNodePairing, Is as getPluginToolMeta, It as onHeartbeatEvent, Ix as applyLegacyMigrations, JS as buildChannelUiCatalog, Ja as resolveFailoverReasonFromError, Jb as writeConfigFile, Js as clearBootstrapSnapshot, Jv as canonicalizeMainSessionAlias, Jx as resolveSubagentMaxConcurrent, Jy as mergeGatewayAuthConfig, Kr as getSkillsSnapshotVersion, Kv as setSessionRuntimeModel, Kx as buildTalkConfigResponse, La as resetDirectoryCache, Ld as registerAgentRunContext, Lo as applyBrowserProxyPaths, Lp as extractFileContentFromSource, Lr as updatePairedNodeMetadata, Ls as resolvePluginTools, Lt as resolveIndicatorType, Lx as ensureControlUiAllowedOriginsForNonLoopbackBind, Mb as migrateLegacyConfig, Mc as stopDiagnosticHeartbeat, Md as getMachineDisplayName, Mi as createOpenClawTools, Mr as approveNodePairing, N as resolveAllowedModelRef, Nd as clearAgentRunContext, Nf as createReplyPrefixOptions, Ni as normalizeSpawnedRunMetadata, Nr as listNodePairing, Nt as resolveHeartbeatVisibility, Oi as resolveEffectiveToolPolicy, Om as stripInlineDirectiveTagsFromMessageForDisplay, Or as refreshRemoteBinsForConnectedNodes, P as resolveConfiguredModelRef, Pc as isDiagnosticsEnabled, Pd as emitAgentEvent, Pi as resolveIngressWorkspaceOverrideForSpawnedRun, Pp as DEFAULT_INPUT_IMAGE_MAX_BYTES, Pr as rejectNodePairing, Ps as saveExecApprovals, Pt as emitHeartbeatEvent, Q as loadOpenClawPlugins, Qa as isGatewaySigusr1RestartExternallyAllowed, Qb as validateConfigObjectWithPlugins, Qi as listAgentsForGateway, Qr as countActiveDescendantRuns, Qs as isTtsProviderConfigured, Qv as snapshotSessionOrigin, R as resolveSubagentConfiguredModelSelection, Ri as readLatestAssistantReply, Ro as persistBrowserProxyFiles, Rp as extractImageContentFromSource, Rr as verifyNodeToken, Sa as resolveOutboundTarget, Sc as markGatewayDraining, Sf as resolveAgentOutboundIdentity, Sm as readSessionMessages, So as normalizeRequiredName, Sy as movePathToTrash, Ta as deliverOutboundPayloads, Tc as waitForActiveTasks, Tg as normalizePollInput, Ti as applyToolPolicyPipeline, Tl as loadCronStore, Tm as stripEnvelopeFromMessage, To as normalizeLegacyDeliveryInput, Tr as getRemoteSkillEligibility, U as supportsXHighThinking, Ub as readConfigFileSnapshot, Ui as resolvePreferredSessionKeyForSessionIdMatches, Uo as resolveCommandSecretsFromActiveRuntimeSnapshot, Ut as runCliAgent, Vf as buildHistoryContextFromEntries, Vo as getActiveSecretsRuntimeSnapshot, Vt as getCliSessionId, Wb as readConfigFileSnapshotForWrite, Wi as applyModelOverrideToSessionEntry, Wo as GATEWAY_AUTH_SURFACE_PATHS, Wr as formatZonedTimestamp, Wv as mergeSessionEntry, Xa as deferGatewayRestartUntilIdle, Xi as canonicalizeSpawnedByForAgent, Xr as resolveSessionAuthProfileOverride, Xs as getTtsProvider, Xt as parseVerboseOverride, Xv as resolveExplicitAgentSessionKey, Xx as DEFAULT_MODEL, Xy as resolveConfiguredSecretInputString, Ya as consumeGatewaySigusr1RestartAuthorization, Ys as clearBootstrapSnapshotOnSessionRollover, Yt as applyVerboseOverride, Yv as resolveAgentMainSessionKey, Yy as mergeGatewayTailscaleConfig, Za as emitGatewayRestart, Zp as resolveAgentSessionDirs, Zs as isTtsEnabled, Zt as createPluginRuntime, Zv as resolveMainSessionKey, Zx as DEFAULT_PROVIDER, _p as buildChannelAccountBindings, _s as setHeartbeatsEnabled, _x as applyConfigOverrides, _y as createBrowserControlContext, aC as normalizeThinkLevel, ac as setTtsProvider, ao as formatDoctorNonInteractiveHint, as as missingSystemRunApprovalBinding, ba as resolveHeartbeatDeliveryTarget, bc as getQueueSize, bi as resolveBootstrapWarningSignaturesSeen, bm as capArrayByJsonBytes, bo as normalizeOptionalText$1, cS as isHeartbeatContentEffectivelyEmpty, ca as computeBackoff, cc as OPENAI_TTS_VOICES, co as summarizeRestartSentinel, cp as resolveSendPolicy, dS as HEARTBEAT_TOKEN, di as runEmbeddedPiAgent, do as normalizeHttpWebhookUrl, dr as dispatchInboundMessage, ds as peekSystemEventEntries, eS as resolveAgentTimeoutMs, ea as loadCombinedSessionStoreForGateway, ec as resolveTtsAutoMode, em as parseSessionThreadInfo, eo as scheduleGatewaySigusr1Restart, es as resolveSystemRunApprovalRuntimeContext, fS as SILENT_REPLY_TOKEN, fd as CONTROL_UI_AVATAR_PREFIX, fo as normalizeCronJobCreate, fv as handleSlackHttpRequest, fx as parseByteSize, ga as parseTimeoutMsWithFallback, gi as waitForEmbeddedPiRunEnd, gm as normalizeSessionDeliveryFields, go as resolveDefaultCronStaggerMs, gs as setHeartbeatWakeHandler, gx as looksLikeAvatarPath, gy as createBrowserRouteDispatcher, hd as resolveAssistantAvatarUrl, hi as waitForActiveEmbeddedRuns, hm as mergeDeliveryContext, ho as resolveCronStaggerMs, hr as getTotalPendingReplies, hs as requestHeartbeatNow, hx as isAvatarImageDataUrl, iC as normalizeReasoningLevel, iS as resolveUserTimezone, ia as resolveSessionModelRef, ic as setTtsEnabled, io as consumeRestartSentinel, is as matchSystemRunApprovalBinding, j as normalizeModelSelection, jc as startDiagnosticHeartbeat, ji as runBeforeToolCallHook, jr as setSkillsRemoteRegistry, ka as normalizeReplyPayloadsForDelivery, kf as requestBodyErrorToText, ki as resolveGroupToolPolicy, km as jsonUtf8Bytes, kr as refreshRemoteNodeBins, ks as readExecApprovalsSnapshot, ky as cleanOldMedia, lS as resolveHeartbeatPrompt$1, la as sleepWithAbort, li as clearSessionQueues, lm as updateSessionStore, lp as getGlobalHookRunner, ls as enqueueSystemEvent, mS as isSilentReplyText, md as normalizeControlUiBasePath, mi as getActiveEmbeddedRunCount, mm as deliveryContextFromSession, mo as normalizeCronStaggerMs, ms as areHeartbeatsEnabled, mx as isAvatarHttpUrl, nC as normalizeElevatedLevel, nS as appendCronStyleCurrentTimeLine, na as migrateAndPruneGatewaySessionStoreKey, nc as resolveTtsPrefsPath, nm as archiveRemovedSessionTranscripts, no as setPreRestartDeferralCheck, ns as resolveSystemRunCommandRequest, oC as normalizeUsageDisplay, oa as lookupContextTokens, oc as textToSpeech, oo as formatRestartSentinelMessage, pd as buildControlUiAvatarUrl, pi as abortEmbeddedPiRun, po as normalizeCronJobPatch, pr as createReplyDispatcher, px as AVATAR_MAX_BYTES, qd as loadGatewayTlsRuntime$1, qr as registerSkillsChangeListener, qv as resolveMainSessionKeyFromConfig, qx as resolveAgentMaxConcurrent, qy as ensureGatewayStartupAuth, rC as normalizeFastMode, rS as resolveCronStyleNow, ra as resolveGatewaySessionStoreTarget, rc as resolveTtsProviderOrder, ri as listDescendantRunsForRequester, rm as loadSessionStore, rn as formatHelpExamples, ro as triggerOpenClawRestart, rs as buildSystemRunApprovalBinding, sC as normalizeVerboseLevel, sc as OPENAI_TTS_MODELS, sm as saveSessionStore, sp as normalizeSendPolicy, ss as toSystemRunApprovalMismatchError, tC as formatXHighModelHint, tS as resolveHeartbeatReplyPayload, ta as loadSessionEntry, tc as resolveTtsConfig, ti as initSubagentRegistry, tn as withProgress, to as setGatewaySigusr1RestartPolicy, uS as stripHeartbeatToken, ua as normalizeGroupActivation, ub as extractTextFromChatContent, uo as writeRestartSentinel, up as runGlobalGatewayStopSafely, us as isSystemEventContextChanged, va as ensureOutboundSessionEntry, vc as enqueueCommandInLane, vm as archiveFileOnDisk, vo as normalizeOptionalAgentId, vr as isAbortRequestText, vs as resolveHeartbeatReasonKind, vy as startBrowserControlServiceFromConfig, w as buildAllowedModelSet, wa as buildOutboundSessionContext, wc as setCommandLaneConcurrency, wi as resolveToolLoopDetectionConfig, wm as resolveSessionTranscriptCandidates, wo as parseAbsoluteTimeMs, ws as mergeExecApprovalsSocketDefaults, xa as resolveHeartbeatSenderContext, xc as getTotalQueueSize, xi as resolveFastModeState, xm as cleanupArchivedSessionTranscripts, xo as normalizePayloadToSystemText, xs as ensureExecApprovals, yS as resolveWhatsAppAccount, ya as resolveOutboundSessionRoute, yc as getActiveTaskCount, ym as archiveSessionTranscripts, yo as normalizeOptionalSessionKey, yp as getAcpSessionManager, yr as stopSubagentsForRequester, ys as DEFAULT_EXEC_APPROVAL_TIMEOUT_MS, z as resolveThinkingDefault, za as resolveMessageChannelSelection, zb as loadConfig, zd as callGateway, zh as getChannelActivity, zi as resolveAnnounceTargetFromKey, zo as activateSecretsRuntimeSnapshot, zp as normalizeMimeList, zt as getReplyFromConfig } from "./auth-profiles-DAOR1fRn.js";
import { C as fetchWithSsrFGuard, D as ToolInputError, Q as SsrFBlockedError, U as estimateBase64DecodedBytes, a as detectSuspiciousPatterns, at as normalizeSecretInput, i as buildSafeExternalPrompt, o as getHookType, s as isExternalHookSession } from "./plugins-allowlist-E4LSkJ7R.js";
import { Bn as registerInternalHook, C as init_registry$1, F as canonicalizePathVariant, I as init_security_path, Ln as clearInternalHooks, N as PROTECTED_PLUGIN_ROUTE_PREFIXES, P as canonicalizePathForSecurity, Rn as createInternalHookEvent, Vn as triggerInternalHook, a as init_registry, d as getActivePluginRegistry, dt as listChannelPlugins, ft as normalizeChannelId, g as releasePinnedPluginHttpRouteRegistry, h as pinActivePluginHttpRouteRegistry, lt as getChannelPlugin, m as init_runtime$1, u as registry_exports, x as createEmptyPluginRegistry, y as resolveActivePluginHttpRouteRegistry, zn as init_internal_hooks } from "./registry-ep1yQ6WN.js";
import { i as normalizeOptionalAccountId, r as normalizeAccountId$1, t as DEFAULT_ACCOUNT_ID } from "./account-id-DSKLJ_RM.js";
import { C as isSubagentSessionKey, b as isAcpSessionKey, d as resolveAgentIdFromSessionKey, g as toAgentStoreSessionKey, h as toAgentRequestSessionKey, l as normalizeAgentId, o as classifySessionKeyShape, r as buildAgentMainSessionKey, s as init_session_key, t as DEFAULT_AGENT_ID, u as normalizeMainKey, w as parseAgentSessionKey, x as isCronRunSessionKey, y as init_session_key_utils } from "./session-key-B-Mu-04L.js";
import { n as resolveAccountEntry, t as init_account_lookup } from "./account-lookup-CWNewDYP.js";
import { a as hasConfiguredSecretInput, o as init_types_secrets } from "./types.secrets-Cu0Lz6pi.js";
import "./fetch-COjVSrBr.js";
import { i as writeJsonAtomic, n as init_json_files, r as readJsonFile, t as createAsyncLock } from "./json-files-Ci9Yrixm.js";
import { n as isTestDefaultMemorySlotDisabled } from "./config-state-CkhXLglq.js";
import { a as openBoundaryFileSync, i as openBoundaryFile, t as matchesSkillFilter, u as isNotFoundPathError } from "./filter-Qe6Ch68_.js";
import { n as sameFileIdentity, t as openVerifiedFileSync } from "./safe-open-sync-BmiTH5-j.js";
import "./manifest-registry-DZywV-kg.js";
import { t as resolveOpenClawPackageRoot } from "./openclaw-root-0nFkqMDM.js";
import { $ as validateExecApprovalsNodeSetParams, $t as buildDeviceAuthPayloadV3, A as validateConfigPatchParams, At as validateSessionsUsageParams, B as validateCronRunsParams, Bt as validateWebLoginStartParams, C as validateChannelsStatusParams, Cn as GATEWAY_CLIENT_CAPS, Ct as validateSessionsCompactParams, D as validateChatSendParams, Dn as hasGatewayClientCap, Dt as validateSessionsPreviewParams, E as validateChatInjectParams, En as GATEWAY_CLIENT_NAMES, Et as validateSessionsPatchParams, F as validateConnectParams, Ft as validateTalkConfigParams, G as validateDevicePairRejectParams, Gt as validateWizardStatusParams, H as validateCronUpdateParams, Ht as validateWizardCancelParams, I as validateCronAddParams, It as validateTalkModeParams, J as validateDeviceTokenRotateParams, Jt as parseSessionLabel, K as validateDevicePairRemoveParams, Kt as ErrorCodes, L as validateCronListParams, Lt as validateToolsCatalogParams, M as validateConfigSchemaLookupResult, Mt as validateSkillsInstallParams, N as validateConfigSchemaParams, Nt as validateSkillsStatusParams, O as validateConfigApplyParams, On as normalizeGatewayClientMode, Ot as validateSessionsResetParams, P as validateConfigSetParams, Pt as validateSkillsUpdateParams, Q as validateExecApprovalsNodeGetParams, Qt as buildDeviceAuthPayload, R as validateCronRemoveParams, Rt as validateUpdateRunParams, S as validateChannelsLogoutParams, St as validateSendParams, T as validateChatHistoryParams, Tn as GATEWAY_CLIENT_MODES, Tt as validateSessionsListParams, U as validateDevicePairApproveParams, Ut as validateWizardNextParams, V as validateCronStatusParams, Vt as validateWebLoginWaitParams, W as validateDevicePairListParams, Wt as validateWizardStartParams, X as validateExecApprovalResolveParams, Xt as resolveAuthConnectErrorDetailCode, Y as validateExecApprovalRequestParams, Yt as ConnectErrorDetailCodes, Z as validateExecApprovalsGetParams, Zt as resolveDeviceAuthConnectErrorDetailCode, _ as validateAgentsFilesGetParams, _t as validatePollParams, an as publicKeyRawBase64UrlFromPem, at as validateNodeInvokeParams, b as validateAgentsListParams, bn as normalizeMessageChannel, bt as validateSecretsResolveParams, c as isNodeRoleMethod, ct as validateNodePairApproveParams, d as formatValidationErrors, dn as rawDataToString, dt as validateNodePairRequestParams, en as normalizeDeviceAuthScopes, et as validateExecApprovalsSetParams, f as validateAgentIdentityParams, fn as INTERNAL_MESSAGE_CHANNEL, ft as validateNodePairVerifyParams, g as validateAgentsDeleteParams, gt as validateNodeRenameParams, h as validateAgentsCreateParams, hn as isGatewayMessageChannel, ht as validateNodePendingEnqueueParams, i as PAIRING_SCOPE$1, in as normalizeDevicePublicKeyBase64Url, it as validateNodeEventParams, j as validateConfigSchemaLookupParams, jt as validateSkillsBinsParams, k as validateConfigGetParams, kt as validateSessionsResolveParams, lt as validateNodePairListParams, m as validateAgentWaitParams, mn as isGatewayCliClient, mt as validateNodePendingDrainParams, n as APPROVALS_SCOPE$1, nn as deriveDeviceIdFromPublicKey, nt as validateModelsListParams, o as WRITE_SCOPE, ot as validateNodeInvokeResultParams, p as validateAgentParams, pn as isDeliverableMessageChannel, pt as validateNodePendingAckParams, q as validateDeviceTokenRevokeParams, qt as errorShape, rn as loadOrCreateDeviceIdentity, rt as validateNodeDescribeParams, s as authorizeOperatorScopesForMethod, sn as verifyDeviceSignature, st as validateNodeListParams, t as ADMIN_SCOPE$3, tt as validateLogsTailParams, un as normalizeInputProvenance, ut as validateNodePairRejectParams, v as validateAgentsFilesListParams, vn as isWebchatClient, vt as validatePushTestParams, w as validateChatAbortParams, wn as GATEWAY_CLIENT_IDS, wt as validateSessionsDeleteParams, x as validateAgentsUpdateParams, xt as validateSecretsResolveResult, y as validateAgentsFilesSetParams, yt as validateRequestFrame, z as validateCronRunParams, zt as validateWakeParams } from "./method-scopes-CLHNYIU6.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { I as normalizeWhatsAppTarget, U as resolveChannelDefaultAccountId } from "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import { C as DEFAULT_MEMORY_FILENAME, D as ensureAgentWorkspace, E as DEFAULT_USER_FILENAME, M as resolveWorkspaceTemplateDir, S as DEFAULT_MEMORY_ALT_FILENAME, T as DEFAULT_TOOLS_FILENAME, _ as DEFAULT_AGENTS_FILENAME, a as resolveAgentDir, b as DEFAULT_HEARTBEAT_FILENAME, d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId, h as resolveSessionAgentId, i as resolveAgentConfig, j as resolveDefaultAgentWorkspaceDir, k as isWorkspaceSetupCompleted, l as resolveAgentModelFallbacksOverride, n as listAgentEntries, r as listAgentIds, u as resolveAgentSkillsFilter, w as DEFAULT_SOUL_FILENAME, x as DEFAULT_IDENTITY_FILENAME, y as DEFAULT_BOOTSTRAP_FILENAME } from "./agent-scope-C0PckUtv.js";
import { i as logWarn, t as logDebug } from "./logger-DLmJXd-S.js";
import { n as runExec, t as runCommandWithTimeout } from "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import { n as VERSION, o as resolveRuntimeServiceVersion } from "./version-Dubp0iGu.js";
import { A as normalizeRateLimitClientIp, C as readGatewayPasswordEnv, D as AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH, E as AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN, F as enableTailscaleServe, L as getTailnetHostname, M as disableTailscaleFunnel, N as disableTailscaleServe, O as AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET, P as enableTailscaleFunnel, d as authorizeHttpGatewayConnect, f as authorizeWsControlUiGatewayConnect, j as safeEqualSecret, k as createAuthRateLimiter, m as resolveGatewayAuth, p as isLocalDirectRequest, u as assertGatewayAuthConfigured, w as readGatewayTokenEnv } from "./config-DZ3oWznn.js";
import { G as collectExplicitAllowlist, Q as PROFILE_OPTIONS, Z as resolveToolProfilePolicy, et as listCoreToolSections, k as cleanStaleLockFiles, q as mergeAlsoAllowPolicy, t as listAgentWorkspaceDirs, tt as resolveCoreToolProfiles } from "./workspace-dirs-Ejflbukt.js";
import { i as parseDurationMs, n as getMemorySearchManager, r as resolveMemoryBackendConfig } from "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import { _ as pickPrimaryTailnetIPv6, a as isLoopbackHost, c as isValidIPv4, d as resolveClientIp, f as resolveGatewayBindHost, g as pickPrimaryTailnetIPv4, i as isLoopbackAddress, l as normalizeHostHeader, m as resolveRequestClientIp, p as resolveGatewayListenHosts, r as isLocalishHost, s as isTrustedProxyAddress, t as normalizeDeviceMetadataForAuth, u as pickPrimaryLanIPv4 } from "./device-metadata-normalization-a2oQYp64.js";
import { M as readLocalFileSafely, P as writeFileWithinRoot, T as SafeOpenError, k as openFileWithinRoot } from "./query-expansion-V82ct97U.js";
import { d as isKnownSecretTargetId } from "./command-secret-targets-7sQA1Mwd.js";
import { f as hasBinary } from "./frontmatter-UI6LO8NQ.js";
import { n as assertNoPathAliasEscape } from "./path-alias-guards-SF-nwQor.js";
import { o as loadWorkspaceSkillEntries, r as buildWorkspaceSkillSnapshot } from "./skills-DUmWDILI.js";
import { c as isPidAlive, r as isRestartEnabled } from "./commands-BfMCtxuV.js";
import { a as inspectPortUsage, c as formatPortDiagnostics } from "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import { t as detectMime } from "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import { a as resolveSessionTranscriptPath, c as resolveSessionTranscriptsDirForAgent, i as resolveSessionFilePathOptions, l as resolveStorePath, r as resolveSessionFilePath } from "./paths-55bRPK_d.js";
import { a as loadSessionUsageTimeSeries, c as formatUsd, d as deriveSessionTotalTokens, f as hasNonzeroUsage, n as loadCostUsageSummary, r as loadSessionCostSummary, s as formatTokenCount, t as discoverAllSessions } from "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import { v as readChannelAllowFromStoreSync } from "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import { t as resolveMemorySearchConfig } from "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import { t as cleanStaleGatewayProcessesSync } from "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import { n as runCommandWithRuntime } from "./cli-utils-DRykF2zj.js";
import "./daemon-install-plan.shared-C-C6Cfb3.js";
import "./runtime-paths-BAKbI1QA.js";
import "./runtime-guard-BeaHeRr7.js";
import "./gateway-install-token-TIg1tNFo.js";
import "./runtime-parse-DJmitJVt.js";
import { p as scheduleDetachedLaunchdRestartHandoff } from "./launchd-CYc1PBHk.js";
import { c as parseProcCmdline, s as isGatewayArgv } from "./service-BRvD766e.js";
import "./systemd-Ca2xqSN-.js";
import "./shared-CCPEqzJi.js";
import "./systemd-hints-CyeYGmDG.js";
import { t as parsePort } from "./parse-port-CfABYuqb.js";
import { n as addGatewayServiceCommands } from "./daemon-cli-Do4KJIng.js";
import { t as probeGateway } from "./probe-XzGfgPsl.js";
import { n as formatConfigIssueLines } from "./issue-format-CBjhFckx.js";
import "./lifecycle-core-_e-4cOok.js";
import "./status-CsbXYOcT.js";
import "./diagnostics-Dt1yQ2p8.js";
import "./inspect-DCmCrH4y.js";
import "./probe-auth-5wSPlf3K.js";
import { a as rejectDevicePairing, c as revokeDeviceToken, d as updatePairedDeviceMetadata, f as verifyDeviceToken, i as listDevicePairing, l as rotateDeviceToken, n as ensureDeviceToken, o as removePairedDevice, p as roleScopesAllow, r as getPairedDevice, s as requestDevicePairing, t as approveDevicePairing, u as summarizeDeviceTokens } from "./device-pairing-D3SsXoQX.js";
import { t as WizardCancelledError } from "./prompts-BfXKoCy4.js";
import { n as createOutboundSendDeps, t as createDefaultDeps } from "./deps-Dkrq_ri6.js";
import { t as createOutboundSendDeps$1 } from "./outbound-send-deps-DgWp4KuF.js";
import { a as resolveAgentOutboundTarget, i as resolveAgentDeliveryPlan, n as agentCommandFromIngress } from "./agent-zVOYsH2V.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-BUBHarX-.js";
import { t as ensureOpenClawCliOnPath } from "./path-env-BIP146cA.js";
import { n as DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "./dangerous-tools-ACVy39Yu.js";
import { t as readSecretFromFile } from "./secret-file-ilVp6ynf.js";
import { r as resolveConfiguredDeferredChannelPluginIds } from "./channel-plugin-ids-ys55Q6Ol.js";
import { n as verifyDeviceBootstrapToken } from "./device-bootstrap-DkmPULif.js";
import { a as buildBaseHints, i as applySensitiveHints, n as redactConfigSnapshot, o as mapSensitivePaths, r as restoreRedactedValues, s as applyDerivedTags, t as redactConfigObject } from "./redact-snapshot-BvQb4wiH.js";
import "./table-BGZZcqHp.js";
import { n as resolveWideAreaDiscoveryDomain, r as writeWideAreaGatewayZone } from "./widearea-dns-DVdQjuuE.js";
import { i as toOptionString, n as extractGatewayMiskeys, r as maybeExplainGatewayServiceStop, t as describeUnknownError } from "./shared-1ycR-ZUe.js";
import { t as discoverGatewayBeacons } from "./bonjour-discovery-CTOMF9_m.js";
import { f as pickGatewaySelfPresence, t as getStatusSummary } from "./status.summary-BkBvANsF.js";
import { n as resolveHeartbeatIntervalMs, t as isHeartbeatEnabledForAgent } from "./heartbeat-summary-CLoUvRc6.js";
import { i as styleHealthChannelLine, n as getHealthSnapshot, t as formatHealthChannelLines } from "./health-BcAvG-SY.js";
import { a as resolveControlUiRootOverrideSync, n as isPackageProvenControlUiRootSync, o as resolveControlUiRootSync, t as ensureControlUiAssetsBuilt } from "./control-ui-assets-UkuykTLs.js";
import { n as sanitizeExecApprovalDisplayText, t as resolveExecApprovalCommandDisplay } from "./exec-approval-command-display-0PfuVfLg.js";
import { t as resolveExecApprovalSessionTarget } from "./exec-approval-session-target-CghyecLF.js";
import { a as resolveNpmChannelTag, n as compareSemverStrings, p as normalizeUpdateChannel, t as checkUpdateStatus } from "./update-check-C55miNMy.js";
import "./setup.secret-input-D-o1vWQB.js";
import { t as runSetupWizard } from "./setup-CYm1oiSQ.js";
import { a as resolveApnsAuthConfigFromEnv, c as shouldClearStoredApnsRegistration, d as parseMessageWithAttachments, f as formatForLog, g as setGatewayWsLogStyle, h as summarizeAgentEventForWsLog, l as resolveApnsRelayConfigFromEnv, m as shouldLogWs, n as loadApnsRegistration, o as sendApnsAlert, p as logWs, r as normalizeApnsEnvironment, s as sendApnsBackgroundWake, t as clearApnsRegistrationIfCurrent, u as normalizeRpcAttachmentsToChatAttachments } from "./push-apns-DsDEs7R5.js";
import { _ as buildGogWatchStartArgs, g as buildGogWatchServeArgs, i as ensureTailscaleEndpoint, w as resolveGmailHookRuntimeConfig } from "./gmail-setup-utils-C_l-xflM.js";
import { g as computePreviousRunAtMs, h as computeNextRunAtMs, m as coerceFiniteScheduleNumber, p as normalizeStoredCronJobs, t as runGatewayUpdate } from "./update-runner-BPWEGx1E.js";
import { i as loadAgentIdentity, o as pruneAgentConfig, r as findAgentEntryIndex, t as applyAgentConfig } from "./agents.config-D8rwsDLj.js";
import { n as isNodeCommandAllowed, r as resolveNodeCommandAllowlist } from "./node-command-policy-BpJOJ1gA.js";
import { t as buildChannelAccountSnapshot } from "./status-sRj6IZ47.js";
import "./status-hgyqnyDa.js";
import "./node-service-CLegCF40.js";
import "./channels-status-issues-1uGD2Xfa.js";
import "./channels-DiMqb9KY.js";
import "./status.update-KDWYuIrV.js";
import "./skill-scanner-PR6IiKx6.js";
import { t as installSkill } from "./skills-install-F7w_ppZv.js";
import { t as resolveAllowedAgentIds } from "./hooks-policy-BB7N_myr.js";
import { t as collectEnabledInsecureOrDangerousFlags } from "./dangerous-config-flags-CnZ_Yvu6.js";
import { i as shouldIncludeHook, r as resolveHookConfig, t as loadWorkspaceHookEntries } from "./workspace-BlrRoKxE.js";
import { n as forceFreePortAndWait, r as waitForPortBindable } from "./ports-Bkwas-HU.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as fsSync from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { exec, spawn, spawnSync } from "node:child_process";
import os from "node:os";
import chalk from "chalk";
import { isDeepStrictEqual } from "node:util";
import crypto, { createHash, randomBytes, randomUUID } from "node:crypto";
import fs$1 from "node:fs/promises";
import { z } from "zod";
import net from "node:net";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { createServer as createServer$1 } from "node:http";
import { createServer as createServer$2 } from "node:https";
import { WebSocketServer } from "ws";
import { Buffer as Buffer$1 } from "node:buffer";
import chokidar from "chokidar";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/commands/gateway-status/helpers.ts
init_types_secrets();
init_theme();
const MISSING_SCOPE_PATTERN = /\bmissing scope:\s*[a-z0-9._-]+/i;
function parseIntOrNull(value) {
	const s = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "bigint" ? String(value) : "";
	if (!s) return null;
	const n = Number.parseInt(s, 10);
	return Number.isFinite(n) ? n : null;
}
function parseTimeoutMs(raw, fallbackMs) {
	return parseTimeoutMsWithFallback(raw, fallbackMs);
}
function normalizeWsUrl(value) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) return null;
	return trimmed;
}
function resolveTargets(cfg, explicitUrl) {
	const targets = [];
	const add = (t) => {
		if (!targets.some((x) => x.url === t.url)) targets.push(t);
	};
	const explicit = typeof explicitUrl === "string" ? normalizeWsUrl(explicitUrl) : null;
	if (explicit) add({
		id: "explicit",
		kind: "explicit",
		url: explicit,
		active: true
	});
	const remoteUrl = typeof cfg.gateway?.remote?.url === "string" ? normalizeWsUrl(cfg.gateway.remote.url) : null;
	if (remoteUrl) add({
		id: "configRemote",
		kind: "configRemote",
		url: remoteUrl,
		active: cfg.gateway?.mode === "remote"
	});
	add({
		id: "localLoopback",
		kind: "localLoopback",
		url: `ws://127.0.0.1:${resolveGatewayPort(cfg)}`,
		active: cfg.gateway?.mode !== "remote"
	});
	return targets;
}
function resolveProbeBudgetMs(overallMs, kind) {
	if (kind === "localLoopback") return Math.min(800, overallMs);
	if (kind === "sshTunnel") return Math.min(2e3, overallMs);
	return Math.min(1500, overallMs);
}
function sanitizeSshTarget(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.replace(/^ssh\\s+/, "");
}
async function resolveAuthForTarget(cfg, target, overrides) {
	const tokenOverride = overrides.token?.trim() ? overrides.token.trim() : void 0;
	const passwordOverride = overrides.password?.trim() ? overrides.password.trim() : void 0;
	if (tokenOverride || passwordOverride) return {
		token: tokenOverride,
		password: passwordOverride
	};
	const diagnostics = [];
	const authMode = cfg.gateway?.auth?.mode;
	const tokenOnly = authMode === "token";
	const passwordOnly = authMode === "password";
	const resolveToken = async (value, path) => {
		const tokenResolution = await resolveConfiguredSecretInputString({
			config: cfg,
			env: process.env,
			value,
			path,
			unresolvedReasonStyle: "detailed"
		});
		if (tokenResolution.unresolvedRefReason) diagnostics.push(tokenResolution.unresolvedRefReason);
		return tokenResolution.value;
	};
	const resolvePassword = async (value, path) => {
		const passwordResolution = await resolveConfiguredSecretInputString({
			config: cfg,
			env: process.env,
			value,
			path,
			unresolvedReasonStyle: "detailed"
		});
		if (passwordResolution.unresolvedRefReason) diagnostics.push(passwordResolution.unresolvedRefReason);
		return passwordResolution.value;
	};
	const withDiagnostics = (result) => diagnostics.length > 0 ? {
		...result,
		diagnostics
	} : result;
	if (target.kind === "configRemote" || target.kind === "sshTunnel") {
		const remoteTokenValue = cfg.gateway?.remote?.token;
		const remotePasswordValue = (cfg.gateway?.remote)?.password;
		const token = await resolveToken(remoteTokenValue, "gateway.remote.token");
		return withDiagnostics({
			token,
			password: token ? void 0 : await resolvePassword(remotePasswordValue, "gateway.remote.password")
		});
	}
	if (authMode === "none" || authMode === "trusted-proxy") return {};
	const envToken = readGatewayTokenEnv();
	const envPassword = readGatewayPasswordEnv();
	if (tokenOnly) {
		const token = await resolveToken(cfg.gateway?.auth?.token, "gateway.auth.token");
		if (token) return withDiagnostics({ token });
		if (envToken) return { token: envToken };
		return withDiagnostics({});
	}
	if (passwordOnly) {
		const password = await resolvePassword(cfg.gateway?.auth?.password, "gateway.auth.password");
		if (password) return withDiagnostics({ password });
		if (envPassword) return { password: envPassword };
		return withDiagnostics({});
	}
	const token = await resolveToken(cfg.gateway?.auth?.token, "gateway.auth.token");
	if (token) return withDiagnostics({ token });
	if (envToken) return { token: envToken };
	if (envPassword) return withDiagnostics({ password: envPassword });
	return withDiagnostics({
		token,
		password: await resolvePassword(cfg.gateway?.auth?.password, "gateway.auth.password")
	});
}
function extractConfigSummary(snapshotUnknown) {
	const snap = snapshotUnknown;
	const path = typeof snap?.path === "string" ? snap.path : null;
	const exists = Boolean(snap?.exists);
	const valid = Boolean(snap?.valid);
	const issuesRaw = Array.isArray(snap?.issues) ? snap.issues : [];
	const legacyRaw = Array.isArray(snap?.legacyIssues) ? snap.legacyIssues : [];
	const cfg = snap?.config ?? {};
	const gateway = cfg.gateway ?? {};
	const secretDefaults = (cfg.secrets ?? {}).defaults ?? void 0;
	const wideArea = (cfg.discovery ?? {}).wideArea ?? {};
	const remote = gateway.remote ?? {};
	const auth = gateway.auth ?? {};
	const controlUi = gateway.controlUi ?? {};
	const tailscale = gateway.tailscale ?? {};
	const authMode = typeof auth.mode === "string" ? auth.mode : null;
	const authTokenConfigured = hasConfiguredSecretInput(auth.token, secretDefaults);
	const authPasswordConfigured = hasConfiguredSecretInput(auth.password, secretDefaults);
	const remoteUrl = typeof remote.url === "string" ? normalizeWsUrl(remote.url) : null;
	const remoteTokenConfigured = hasConfiguredSecretInput(remote.token, secretDefaults);
	const remotePasswordConfigured = hasConfiguredSecretInput(remote.password, secretDefaults);
	const wideAreaEnabled = typeof wideArea.enabled === "boolean" ? wideArea.enabled : null;
	return {
		path,
		exists,
		valid,
		issues: issuesRaw.filter((i) => Boolean(i && typeof i.path === "string" && typeof i.message === "string")).map((i) => ({
			path: i.path,
			message: i.message
		})),
		legacyIssues: legacyRaw.filter((i) => Boolean(i && typeof i.path === "string" && typeof i.message === "string")).map((i) => ({
			path: i.path,
			message: i.message
		})),
		gateway: {
			mode: typeof gateway.mode === "string" ? gateway.mode : null,
			bind: typeof gateway.bind === "string" ? gateway.bind : null,
			port: parseIntOrNull(gateway.port),
			controlUiEnabled: typeof controlUi.enabled === "boolean" ? controlUi.enabled : null,
			controlUiBasePath: typeof controlUi.basePath === "string" ? controlUi.basePath : null,
			authMode,
			authTokenConfigured,
			authPasswordConfigured,
			remoteUrl,
			remoteTokenConfigured,
			remotePasswordConfigured,
			tailscaleMode: typeof tailscale.mode === "string" ? tailscale.mode : null
		},
		discovery: { wideAreaEnabled }
	};
}
function buildNetworkHints(cfg) {
	const tailnetIPv4 = pickPrimaryTailnetIPv4();
	const port = resolveGatewayPort(cfg);
	return {
		localLoopbackUrl: `ws://127.0.0.1:${port}`,
		localTailnetUrl: tailnetIPv4 ? `ws://${tailnetIPv4}:${port}` : null,
		tailnetIPv4: tailnetIPv4 ?? null
	};
}
function renderTargetHeader(target, rich) {
	const kindLabel = target.kind === "localLoopback" ? "Local loopback" : target.kind === "sshTunnel" ? "Remote over SSH" : target.kind === "configRemote" ? target.active ? "Remote (configured)" : "Remote (configured, inactive)" : "URL (explicit)";
	return `${colorize(rich, theme.heading, kindLabel)} ${colorize(rich, theme.muted, target.url)}`;
}
function isScopeLimitedProbeFailure(probe) {
	if (probe.ok || probe.connectLatencyMs == null) return false;
	return MISSING_SCOPE_PATTERN.test(probe.error ?? "");
}
function isProbeReachable(probe) {
	return probe.ok || isScopeLimitedProbeFailure(probe);
}
function renderProbeSummaryLine(probe, rich) {
	if (probe.ok) {
		const latency = typeof probe.connectLatencyMs === "number" ? `${probe.connectLatencyMs}ms` : "unknown";
		return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${colorize(rich, theme.success, "RPC: ok")}`;
	}
	const detail = probe.error ? ` - ${probe.error}` : "";
	if (probe.connectLatencyMs != null) {
		const latency = typeof probe.connectLatencyMs === "number" ? `${probe.connectLatencyMs}ms` : "unknown";
		const rpcStatus = isScopeLimitedProbeFailure(probe) ? colorize(rich, theme.warn, "RPC: limited") : colorize(rich, theme.error, "RPC: failed");
		return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${rpcStatus}${detail}`;
	}
	return `${colorize(rich, theme.error, "Connect: failed")}${detail}`;
}
//#endregion
//#region src/commands/gateway-status.ts
init_theme();
let sshConfigModulePromise;
let sshTunnelModulePromise;
function loadSshConfigModule() {
	sshConfigModulePromise ??= import("./ssh-config-Bg6mOaEg.js");
	return sshConfigModulePromise;
}
function loadSshTunnelModule() {
	sshTunnelModulePromise ??= import("./ssh-tunnel-B8od7loK.js");
	return sshTunnelModulePromise;
}
async function gatewayStatusCommand(opts, runtime) {
	const startedAt = Date.now();
	const cfg = await readBestEffortConfig();
	const rich = isRich() && opts.json !== true;
	const overallTimeoutMs = parseTimeoutMs(opts.timeout, 3e3);
	const wideAreaDomain = resolveWideAreaDiscoveryDomain({ configDomain: cfg.discovery?.wideArea?.domain });
	const baseTargets = resolveTargets(cfg, opts.url);
	const network = buildNetworkHints(cfg);
	const discoveryTimeoutMs = Math.min(1200, overallTimeoutMs);
	const discoveryPromise = discoverGatewayBeacons({
		timeoutMs: discoveryTimeoutMs,
		wideAreaDomain
	});
	let sshTarget = sanitizeSshTarget(opts.ssh) ?? sanitizeSshTarget(cfg.gateway?.remote?.sshTarget);
	let sshIdentity = sanitizeSshTarget(opts.sshIdentity) ?? sanitizeSshTarget(cfg.gateway?.remote?.sshIdentity);
	const remotePort = resolveGatewayPort(cfg);
	let sshTunnelError = null;
	let sshTunnelStarted = false;
	if (!sshTarget) sshTarget = inferSshTargetFromRemoteUrl(cfg.gateway?.remote?.url);
	if (sshTarget) {
		const resolved = await resolveSshTarget(sshTarget, sshIdentity, overallTimeoutMs);
		if (resolved) {
			sshTarget = resolved.target;
			if (!sshIdentity && resolved.identity) sshIdentity = resolved.identity;
		}
	}
	const { discovery, probed } = await withProgress({
		label: "Inspecting gateways…",
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => {
		const tryStartTunnel = async () => {
			if (!sshTarget) return null;
			try {
				const { startSshPortForward } = await loadSshTunnelModule();
				const tunnel = await startSshPortForward({
					target: sshTarget,
					identity: sshIdentity ?? void 0,
					localPortPreferred: remotePort,
					remotePort,
					timeoutMs: Math.min(1500, overallTimeoutMs)
				});
				sshTunnelStarted = true;
				return tunnel;
			} catch (err) {
				sshTunnelError = err instanceof Error ? err.message : String(err);
				return null;
			}
		};
		const discoveryTask = discoveryPromise.catch(() => []);
		const tunnelTask = sshTarget ? tryStartTunnel() : Promise.resolve(null);
		const [discovery, tunnelFirst] = await Promise.all([discoveryTask, tunnelTask]);
		if (!sshTarget && opts.sshAuto) {
			const user = process.env.USER?.trim() || "";
			const candidates = discovery.map((b) => {
				const host = b.tailnetDns || b.lanHost || b.host;
				if (!host?.trim()) return null;
				const sshPort = typeof b.sshPort === "number" && b.sshPort > 0 ? b.sshPort : 22;
				const base = user ? `${user}@${host.trim()}` : host.trim();
				return sshPort !== 22 ? `${base}:${sshPort}` : base;
			}).filter((candidate) => Boolean(candidate));
			const { parseSshTarget } = await loadSshTunnelModule();
			const validCandidates = candidates.filter((candidate) => Boolean(parseSshTarget(candidate)));
			if (validCandidates.length > 0) sshTarget = validCandidates[0] ?? null;
		}
		const tunnel = tunnelFirst || (sshTarget && !sshTunnelStarted && !sshTunnelError ? await tryStartTunnel() : null);
		const tunnelTarget = tunnel ? {
			id: "sshTunnel",
			kind: "sshTunnel",
			url: `ws://127.0.0.1:${tunnel.localPort}`,
			active: true,
			tunnel: {
				kind: "ssh",
				target: sshTarget ?? "",
				localPort: tunnel.localPort,
				remotePort,
				pid: tunnel.pid
			}
		} : null;
		const targets = tunnelTarget ? [tunnelTarget, ...baseTargets.filter((t) => t.url !== tunnelTarget.url)] : baseTargets;
		try {
			return {
				discovery,
				probed: await Promise.all(targets.map(async (target) => {
					const authResolution = await resolveAuthForTarget(cfg, target, {
						token: typeof opts.token === "string" ? opts.token : void 0,
						password: typeof opts.password === "string" ? opts.password : void 0
					});
					const auth = {
						token: authResolution.token,
						password: authResolution.password
					};
					const timeoutMs = resolveProbeBudgetMs(overallTimeoutMs, target.kind);
					const probe = await probeGateway({
						url: target.url,
						auth,
						timeoutMs
					});
					return {
						target,
						probe,
						configSummary: probe.configSnapshot ? extractConfigSummary(probe.configSnapshot) : null,
						self: pickGatewaySelfPresence(probe.presence),
						authDiagnostics: authResolution.diagnostics ?? []
					};
				}))
			};
		} finally {
			if (tunnel) try {
				await tunnel.stop();
			} catch {}
		}
	});
	const reachable = probed.filter((p) => isProbeReachable(p.probe));
	const ok = reachable.length > 0;
	const degradedScopeLimited = probed.filter((p) => isScopeLimitedProbeFailure(p.probe));
	const degraded = degradedScopeLimited.length > 0;
	const multipleGateways = reachable.length > 1;
	const primary = reachable.find((p) => p.target.kind === "explicit") ?? reachable.find((p) => p.target.kind === "sshTunnel") ?? reachable.find((p) => p.target.kind === "configRemote") ?? reachable.find((p) => p.target.kind === "localLoopback") ?? null;
	const warnings = [];
	if (sshTarget && !sshTunnelStarted) warnings.push({
		code: "ssh_tunnel_failed",
		message: sshTunnelError ? `SSH tunnel failed: ${String(sshTunnelError)}` : "SSH tunnel failed to start; falling back to direct probes."
	});
	if (multipleGateways) warnings.push({
		code: "multiple_gateways",
		message: "Unconventional setup: multiple reachable gateways detected. Usually one gateway per network is recommended unless you intentionally run isolated profiles, like a rescue bot (see docs: /gateway#multiple-gateways-same-host).",
		targetIds: reachable.map((p) => p.target.id)
	});
	for (const result of probed) {
		if (result.authDiagnostics.length === 0 || isProbeReachable(result.probe)) continue;
		for (const diagnostic of result.authDiagnostics) warnings.push({
			code: "auth_secretref_unresolved",
			message: diagnostic,
			targetIds: [result.target.id]
		});
	}
	for (const result of degradedScopeLimited) warnings.push({
		code: "probe_scope_limited",
		message: "Probe diagnostics are limited by gateway scopes (missing operator.read). Connection succeeded, but status details may be incomplete. Hint: pair device identity or use credentials with operator.read.",
		targetIds: [result.target.id]
	});
	if (opts.json) {
		runtime.log(JSON.stringify({
			ok,
			degraded,
			ts: Date.now(),
			durationMs: Date.now() - startedAt,
			timeoutMs: overallTimeoutMs,
			primaryTargetId: primary?.target.id ?? null,
			warnings,
			network,
			discovery: {
				timeoutMs: discoveryTimeoutMs,
				count: discovery.length,
				beacons: discovery.map((b) => ({
					instanceName: b.instanceName,
					displayName: b.displayName ?? null,
					domain: b.domain ?? null,
					host: b.host ?? null,
					lanHost: b.lanHost ?? null,
					tailnetDns: b.tailnetDns ?? null,
					gatewayPort: b.gatewayPort ?? null,
					sshPort: b.sshPort ?? null,
					wsUrl: (() => {
						const host = b.tailnetDns || b.lanHost || b.host;
						const port = b.gatewayPort ?? 18789;
						return host ? `ws://${host}:${port}` : null;
					})()
				}))
			},
			targets: probed.map((p) => ({
				id: p.target.id,
				kind: p.target.kind,
				url: p.target.url,
				active: p.target.active,
				tunnel: p.target.tunnel ?? null,
				connect: {
					ok: isProbeReachable(p.probe),
					rpcOk: p.probe.ok,
					scopeLimited: isScopeLimitedProbeFailure(p.probe),
					latencyMs: p.probe.connectLatencyMs,
					error: p.probe.error,
					close: p.probe.close
				},
				self: p.self,
				config: p.configSummary,
				health: p.probe.health,
				summary: p.probe.status,
				presence: p.probe.presence
			}))
		}, null, 2));
		if (!ok) runtime.exit(1);
		return;
	}
	runtime.log(colorize(rich, theme.heading, "Gateway Status"));
	runtime.log(ok ? `${colorize(rich, theme.success, "Reachable")}: yes` : `${colorize(rich, theme.error, "Reachable")}: no`);
	runtime.log(colorize(rich, theme.muted, `Probe budget: ${overallTimeoutMs}ms`));
	if (warnings.length > 0) {
		runtime.log("");
		runtime.log(colorize(rich, theme.warn, "Warning:"));
		for (const w of warnings) runtime.log(`- ${w.message}`);
	}
	runtime.log("");
	runtime.log(colorize(rich, theme.heading, "Discovery (this machine)"));
	const discoveryDomains = wideAreaDomain ? `local. + ${wideAreaDomain}` : "local.";
	runtime.log(discovery.length > 0 ? `Found ${discovery.length} gateway(s) via Bonjour (${discoveryDomains})` : `Found 0 gateways via Bonjour (${discoveryDomains})`);
	if (discovery.length === 0) runtime.log(colorize(rich, theme.muted, "Tip: if the gateway is remote, mDNS won’t cross networks; use Wide-Area Bonjour (split DNS) or SSH tunnels."));
	runtime.log("");
	runtime.log(colorize(rich, theme.heading, "Targets"));
	for (const p of probed) {
		runtime.log(renderTargetHeader(p.target, rich));
		runtime.log(`  ${renderProbeSummaryLine(p.probe, rich)}`);
		if (p.target.tunnel?.kind === "ssh") runtime.log(`  ${colorize(rich, theme.muted, "ssh")}: ${colorize(rich, theme.command, p.target.tunnel.target)}`);
		if (p.probe.ok && p.self) {
			const host = p.self.host ?? "unknown";
			const ip = p.self.ip ? ` (${p.self.ip})` : "";
			const platform = p.self.platform ? ` · ${p.self.platform}` : "";
			const version = p.self.version ? ` · app ${p.self.version}` : "";
			runtime.log(`  ${colorize(rich, theme.info, "Gateway")}: ${host}${ip}${platform}${version}`);
		}
		if (p.configSummary) {
			const c = p.configSummary;
			const wideArea = c.discovery.wideAreaEnabled === true ? "enabled" : c.discovery.wideAreaEnabled === false ? "disabled" : "unknown";
			runtime.log(`  ${colorize(rich, theme.info, "Wide-area discovery")}: ${wideArea}`);
		}
		runtime.log("");
	}
	if (!ok) runtime.exit(1);
}
function inferSshTargetFromRemoteUrl(rawUrl) {
	if (typeof rawUrl !== "string") return null;
	const trimmed = rawUrl.trim();
	if (!trimmed) return null;
	let host = null;
	try {
		host = new URL(trimmed).hostname || null;
	} catch {
		return null;
	}
	if (!host) return null;
	const user = process.env.USER?.trim() || "";
	return user ? `${user}@${host}` : host;
}
function buildSshTarget(input) {
	const host = input.host?.trim() ?? "";
	if (!host) return null;
	const user = input.user?.trim() ?? "";
	const base = user ? `${user}@${host}` : host;
	const port = input.port ?? 22;
	if (port && port !== 22) return `${base}:${port}`;
	return base;
}
async function resolveSshTarget(rawTarget, identity, overallTimeoutMs) {
	const [{ resolveSshConfig }, { parseSshTarget }] = await Promise.all([loadSshConfigModule(), loadSshTunnelModule()]);
	const parsed = parseSshTarget(rawTarget);
	if (!parsed) return null;
	const config = await resolveSshConfig(parsed, {
		identity: identity ?? void 0,
		timeoutMs: Math.min(800, overallTimeoutMs)
	});
	if (!config) return {
		target: rawTarget,
		identity: identity ?? void 0
	};
	const target = buildSshTarget({
		user: config.user ?? parsed.user,
		host: config.host ?? parsed.host,
		port: config.port ?? parsed.port
	});
	if (!target) return {
		target: rawTarget,
		identity: identity ?? void 0
	};
	return {
		target,
		identity: identity ?? config.identityFiles.find((entry) => entry.trim().length > 0)?.trim() ?? void 0
	};
}
//#endregion
//#region src/cli/gateway-cli/call.ts
init_runtime();
const gatewayCallOpts = (cmd) => cmd.option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--password <password>", "Gateway password (password auth)").option("--timeout <ms>", "Timeout in ms", "10000").option("--expect-final", "Wait for final response (agent)", false).option("--json", "Output JSON", false);
const callGatewayCli = async (method, opts, params) => withProgress({
	label: `Gateway ${method}`,
	indeterminate: true,
	enabled: opts.json !== true
}, async () => await callGateway({
	config: opts.config,
	url: opts.url,
	token: opts.token,
	password: opts.password,
	method,
	params,
	expectFinal: Boolean(opts.expectFinal),
	timeoutMs: Number(opts.timeout ?? 1e4),
	clientName: GATEWAY_CLIENT_NAMES.CLI,
	mode: GATEWAY_CLIENT_MODES.CLI
}));
//#endregion
//#region src/cli/gateway-cli/discover.ts
init_theme();
function parseDiscoverTimeoutMs(raw, fallbackMs) {
	return parseTimeoutMsWithFallback(raw, fallbackMs, { invalidType: "error" });
}
function pickBeaconHost(beacon) {
	const host = beacon.host || beacon.tailnetDns || beacon.lanHost;
	return host?.trim() ? host.trim() : null;
}
function pickGatewayPort(beacon) {
	const port = beacon.port ?? beacon.gatewayPort ?? 18789;
	return port > 0 ? port : 18789;
}
function dedupeBeacons(beacons) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const b of beacons) {
		const host = pickBeaconHost(b) ?? "";
		const key = [
			b.domain ?? "",
			b.instanceName ?? "",
			b.displayName ?? "",
			host,
			String(b.port ?? ""),
			String(b.gatewayPort ?? "")
		].join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(b);
	}
	return out;
}
function renderBeaconLines(beacon, rich) {
	const nameRaw = (beacon.displayName || beacon.instanceName || "Gateway").trim();
	const domainRaw = (beacon.domain || "local.").trim();
	const title = colorize(rich, theme.accentBright, nameRaw);
	const domain = colorize(rich, theme.muted, domainRaw);
	const host = pickBeaconHost(beacon);
	const gatewayPort = pickGatewayPort(beacon);
	const scheme = beacon.gatewayTls ? "wss" : "ws";
	const wsUrl = host ? `${scheme}://${host}:${gatewayPort}` : null;
	const lines = [`- ${title} ${domain}`];
	if (beacon.tailnetDns) lines.push(`  ${colorize(rich, theme.info, "tailnet")}: ${beacon.tailnetDns}`);
	if (beacon.lanHost) lines.push(`  ${colorize(rich, theme.info, "lan")}: ${beacon.lanHost}`);
	if (beacon.host) lines.push(`  ${colorize(rich, theme.info, "host")}: ${beacon.host}`);
	if (wsUrl) lines.push(`  ${colorize(rich, theme.muted, "ws")}: ${colorize(rich, theme.command, wsUrl)}`);
	if (beacon.role) lines.push(`  ${colorize(rich, theme.muted, "role")}: ${beacon.role}`);
	if (beacon.transport) lines.push(`  ${colorize(rich, theme.muted, "transport")}: ${beacon.transport}`);
	if (beacon.gatewayTls) {
		const fingerprint = beacon.gatewayTlsFingerprintSha256 ? `sha256 ${beacon.gatewayTlsFingerprintSha256}` : "enabled";
		lines.push(`  ${colorize(rich, theme.muted, "tls")}: ${fingerprint}`);
	}
	if (typeof beacon.sshPort === "number" && beacon.sshPort > 0 && host) {
		const ssh = `ssh -N -L 18789:127.0.0.1:18789 <user>@${host} -p ${beacon.sshPort}`;
		lines.push(`  ${colorize(rich, theme.muted, "ssh")}: ${colorize(rich, theme.command, ssh)}`);
	}
	return lines;
}
//#endregion
//#region src/gateway/server/close-reason.ts
const CLOSE_REASON_MAX_BYTES = 120;
function truncateCloseReason(reason, maxBytes = CLOSE_REASON_MAX_BYTES) {
	if (!reason) return "invalid handshake";
	const buf = Buffer$1.from(reason);
	if (buf.length <= maxBytes) return reason;
	return buf.subarray(0, maxBytes).toString();
}
//#endregion
//#region src/infra/exec-approval-forwarder.ts
init_subsystem();
init_session_key();
const log$6 = createSubsystemLogger("gateway/exec-approvals");
const DEFAULT_MODE = "session";
function normalizeMode(mode) {
	return mode ?? DEFAULT_MODE;
}
function matchSessionFilter(sessionKey, patterns) {
	return patterns.some((pattern) => {
		if (sessionKey.includes(pattern)) return true;
		const compiled = compileConfigRegex(pattern);
		return compiled?.regex ? testRegexWithBoundedInput(compiled.regex, sessionKey) : false;
	});
}
function shouldForward(params) {
	const config = params.config;
	if (!config?.enabled) return false;
	if (config.agentFilter?.length) {
		const agentId = params.request.request.agentId ?? parseAgentSessionKey(params.request.request.sessionKey)?.agentId;
		if (!agentId) return false;
		if (!config.agentFilter.includes(agentId)) return false;
	}
	if (config.sessionFilter?.length) {
		const sessionKey = params.request.request.sessionKey;
		if (!sessionKey) return false;
		if (!matchSessionFilter(sessionKey, config.sessionFilter)) return false;
	}
	return true;
}
function buildTargetKey(target) {
	const channel = normalizeMessageChannel(target.channel) ?? target.channel;
	const accountId = target.accountId ?? "";
	const threadId = target.threadId ?? "";
	return [
		channel,
		target.to,
		accountId,
		threadId
	].join(":");
}
function shouldSkipForwardingFallback(params) {
	const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
	if (!channel) return false;
	return (getChannelPlugin(channel)?.execApprovals)?.shouldSuppressForwardingFallback?.({
		cfg: params.cfg,
		target: params.target,
		request: params.request
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
function buildRequestMessage(request, nowMs) {
	const lines = ["🔒 Exec approval required", `ID: ${request.id}`];
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
	const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1e3));
	lines.push(`Expires in: ${expiresIn}s`);
	lines.push("Mode: foreground (interactive approvals available in this chat).");
	lines.push("Background mode note: non-interactive runs cannot wait for chat approvals; use pre-approved policy (allow-always or ask=off).");
	lines.push("Reply with: /approve <id> allow-once|allow-always|deny");
	return lines.join("\n");
}
function decisionLabel(decision) {
	if (decision === "allow-once") return "allowed once";
	if (decision === "allow-always") return "allowed always";
	return "denied";
}
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
function defaultResolveSessionTarget(params) {
	const resolvedTarget = resolveExecApprovalSessionTarget({
		cfg: params.cfg,
		request: params.request,
		turnSourceChannel: normalizeTurnSourceChannel(params.request.request.turnSourceChannel),
		turnSourceTo: params.request.request.turnSourceTo?.trim() || void 0,
		turnSourceAccountId: params.request.request.turnSourceAccountId?.trim() || void 0,
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
}
async function deliverToTargets(params) {
	const deliveries = params.targets.map(async (target) => {
		if (params.shouldSend && !params.shouldSend()) return;
		const channel = normalizeMessageChannel(target.channel) ?? target.channel;
		if (!isDeliverableMessageChannel(channel)) return;
		try {
			const payload = params.buildPayload(target);
			await params.beforeDeliver?.(target, payload);
			await params.deliver({
				cfg: params.cfg,
				channel,
				to: target.to,
				accountId: target.accountId,
				threadId: target.threadId,
				payloads: [payload]
			});
		} catch (err) {
			log$6.error(`exec approvals: failed to deliver to ${channel}:${target.to}: ${String(err)}`);
		}
	});
	await Promise.allSettled(deliveries);
}
function buildRequestPayloadForTarget(cfg, request, nowMsValue, target) {
	const channel = normalizeMessageChannel(target.channel) ?? target.channel;
	const pluginPayload = channel ? getChannelPlugin(channel)?.execApprovals?.buildPendingPayload?.({
		cfg,
		request,
		target,
		nowMs: nowMsValue
	}) : null;
	if (pluginPayload) return pluginPayload;
	return { text: buildRequestMessage(request, nowMsValue) };
}
function buildResolvedPayloadForTarget(cfg, resolved, target) {
	const channel = normalizeMessageChannel(target.channel) ?? target.channel;
	const pluginPayload = channel ? getChannelPlugin(channel)?.execApprovals?.buildResolvedPayload?.({
		cfg,
		resolved,
		target
	}) : null;
	if (pluginPayload) return pluginPayload;
	return { text: buildResolvedMessage(resolved) };
}
function resolveForwardTargets(params) {
	const mode = normalizeMode(params.config?.mode);
	const targets = [];
	const seen = /* @__PURE__ */ new Set();
	if (mode === "session" || mode === "both") {
		const sessionTarget = params.resolveSessionTarget({
			cfg: params.cfg,
			request: params.request
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
function createExecApprovalForwarder(deps = {}) {
	const getConfig = deps.getConfig ?? loadConfig;
	const deliver = deps.deliver ?? deliverOutboundPayloads;
	const nowMs = deps.nowMs ?? Date.now;
	const resolveSessionTarget = deps.resolveSessionTarget ?? defaultResolveSessionTarget;
	const pending = /* @__PURE__ */ new Map();
	const handleRequested = async (request) => {
		const cfg = getConfig();
		const config = cfg.approvals?.exec;
		const filteredTargets = [...shouldForward({
			config,
			request
		}) ? resolveForwardTargets({
			cfg,
			config,
			request,
			resolveSessionTarget
		}) : []].filter((target) => !shouldSkipForwardingFallback({
			target,
			cfg,
			request
		}));
		if (filteredTargets.length === 0) return false;
		const expiresInMs = Math.max(0, request.expiresAtMs - nowMs());
		const timeoutId = setTimeout(() => {
			(async () => {
				const entry = pending.get(request.id);
				if (!entry) return;
				pending.delete(request.id);
				const expiredText = buildExpiredMessage(request);
				await deliverToTargets({
					cfg,
					targets: entry.targets,
					buildPayload: () => ({ text: expiredText }),
					deliver
				});
			})();
		}, expiresInMs);
		timeoutId.unref?.();
		const pendingEntry = {
			request,
			targets: filteredTargets,
			timeoutId
		};
		pending.set(request.id, pendingEntry);
		if (pending.get(request.id) !== pendingEntry) return false;
		deliverToTargets({
			cfg,
			targets: filteredTargets,
			buildPayload: (target) => buildRequestPayloadForTarget(cfg, request, nowMs(), target),
			beforeDeliver: async (target, payload) => {
				const channel = normalizeMessageChannel(target.channel) ?? target.channel;
				if (!channel) return;
				await getChannelPlugin(channel)?.execApprovals?.beforeDeliverPending?.({
					cfg,
					target,
					payload
				});
			},
			deliver,
			shouldSend: () => pending.get(request.id) === pendingEntry
		}).catch((err) => {
			log$6.error(`exec approvals: failed to deliver request ${request.id}: ${String(err)}`);
		});
		return true;
	};
	const handleResolved = async (resolved) => {
		const entry = pending.get(resolved.id);
		if (entry) {
			if (entry.timeoutId) clearTimeout(entry.timeoutId);
			pending.delete(resolved.id);
		}
		const cfg = getConfig();
		let targets = entry?.targets;
		if (!targets && resolved.request) {
			const request = {
				id: resolved.id,
				request: resolved.request,
				createdAtMs: resolved.ts,
				expiresAtMs: resolved.ts
			};
			const config = cfg.approvals?.exec;
			targets = [...shouldForward({
				config,
				request
			}) ? resolveForwardTargets({
				cfg,
				config,
				request,
				resolveSessionTarget
			}) : []].filter((target) => !shouldSkipForwardingFallback({
				target,
				cfg,
				request
			}));
		}
		if (!targets || targets.length === 0) return;
		await deliverToTargets({
			cfg,
			targets,
			buildPayload: (target) => buildResolvedPayloadForTarget(cfg, resolved, target),
			deliver
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
//#endregion
//#region src/cron/isolated-agent/session.ts
init_session_key_utils();
init_console();
init_ansi();
init_globals();
function resolveCronSession(params) {
	const sessionCfg = params.cfg.session;
	const storePath = resolveStorePath(sessionCfg?.store, { agentId: params.agentId });
	const store = loadSessionStore(storePath);
	const entry = store[params.sessionKey];
	let sessionId;
	let isNewSession;
	let systemSent;
	if (!params.forceNew && entry?.sessionId) {
		const resetPolicy = resolveSessionResetPolicy({
			sessionCfg,
			resetType: "direct"
		});
		if (evaluateSessionFreshness({
			updatedAt: entry.updatedAt,
			now: params.nowMs,
			policy: resetPolicy
		}).fresh) {
			sessionId = entry.sessionId;
			isNewSession = false;
			systemSent = entry.systemSent ?? false;
		} else {
			sessionId = crypto.randomUUID();
			isNewSession = true;
			systemSent = false;
		}
	} else {
		sessionId = crypto.randomUUID();
		isNewSession = true;
		systemSent = false;
	}
	clearBootstrapSnapshotOnSessionRollover({
		sessionKey: params.sessionKey,
		previousSessionId: isNewSession ? entry?.sessionId : void 0
	});
	return {
		storePath,
		store,
		sessionEntry: {
			...entry,
			sessionId,
			updatedAt: params.nowMs,
			systemSent,
			...isNewSession && {
				lastChannel: void 0,
				lastTo: void 0,
				lastAccountId: void 0,
				lastThreadId: void 0,
				deliveryContext: void 0
			}
		},
		systemSent,
		isNewSession
	};
}
//#endregion
//#region src/infra/heartbeat-active-hours.ts
init_utils();
init_paths();
const ACTIVE_HOURS_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
function resolveActiveHoursTimezone(cfg, raw) {
	const trimmed = raw?.trim();
	if (!trimmed || trimmed === "user") return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
	if (trimmed === "local") return Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(/* @__PURE__ */ new Date());
		return trimmed;
	} catch {
		return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
	}
}
function parseActiveHoursTime(opts, raw) {
	if (!raw || !ACTIVE_HOURS_TIME_PATTERN.test(raw)) return null;
	const [hourStr, minuteStr] = raw.split(":");
	const hour = Number(hourStr);
	const minute = Number(minuteStr);
	if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
	if (hour === 24) {
		if (!opts.allow24 || minute !== 0) return null;
		return 1440;
	}
	return hour * 60 + minute;
}
function resolveMinutesInTimeZone(nowMs, timeZone) {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23"
		}).formatToParts(new Date(nowMs));
		const map = {};
		for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
		const hour = Number(map.hour);
		const minute = Number(map.minute);
		if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
		return hour * 60 + minute;
	} catch {
		return null;
	}
}
function isWithinActiveHours(cfg, heartbeat, nowMs) {
	const active = heartbeat?.activeHours;
	if (!active) return true;
	const startMin = parseActiveHoursTime({ allow24: false }, active.start);
	const endMin = parseActiveHoursTime({ allow24: true }, active.end);
	if (startMin === null || endMin === null) return true;
	if (startMin === endMin) return false;
	const timeZone = resolveActiveHoursTimezone(cfg, active.timezone);
	const currentMin = resolveMinutesInTimeZone(nowMs ?? Date.now(), timeZone);
	if (currentMin === null) return true;
	if (endMin > startMin) return currentMin >= startMin && currentMin < endMin;
	return currentMin >= startMin || currentMin < endMin;
}
//#endregion
//#region src/infra/heartbeat-events-filter.ts
function buildCronEventPrompt(pendingEvents, opts) {
	const deliverToUser = opts?.deliverToUser ?? true;
	const eventText = pendingEvents.join("\n").trim();
	if (!eventText) {
		if (!deliverToUser) return "A scheduled cron event was triggered, but no event content was found. Handle this internally and reply HEARTBEAT_OK when nothing needs user-facing follow-up.";
		return "A scheduled cron event was triggered, but no event content was found. Reply HEARTBEAT_OK.";
	}
	if (!deliverToUser) return "A scheduled reminder has been triggered. The reminder content is:\n\n" + eventText + "\n\nHandle this reminder internally. Do not relay it to the user unless explicitly requested.";
	return "A scheduled reminder has been triggered. The reminder content is:\n\n" + eventText + "\n\nPlease relay this reminder to the user in a helpful and friendly way.";
}
function buildExecEventPrompt(opts) {
	if (!(opts?.deliverToUser ?? true)) return "An async command you ran earlier has completed. The result is shown in the system messages above. Handle the result internally. Do not relay it to the user unless explicitly requested.";
	return "An async command you ran earlier has completed. The result is shown in the system messages above. Please relay the command output to the user in a helpful way. If the command succeeded, share the relevant output. If it failed, explain what went wrong.";
}
const HEARTBEAT_OK_PREFIX = HEARTBEAT_TOKEN.toLowerCase();
function isHeartbeatAckEvent(evt) {
	const trimmed = evt.trim();
	if (!trimmed) return false;
	const lower = trimmed.toLowerCase();
	if (!lower.startsWith(HEARTBEAT_OK_PREFIX)) return false;
	const suffix = lower.slice(HEARTBEAT_OK_PREFIX.length);
	if (suffix.length === 0) return true;
	return !/[a-z0-9_]/.test(suffix[0]);
}
function isHeartbeatNoiseEvent(evt) {
	const lower = evt.trim().toLowerCase();
	if (!lower) return false;
	return isHeartbeatAckEvent(lower) || lower.includes("heartbeat poll") || lower.includes("heartbeat wake");
}
function isExecCompletionEvent(evt) {
	return evt.toLowerCase().includes("exec finished");
}
function isCronSystemEvent(evt) {
	if (!evt.trim()) return false;
	return !isHeartbeatNoiseEvent(evt) && !isExecCompletionEvent(evt);
}
//#endregion
//#region src/infra/heartbeat-runner.ts
init_subsystem();
init_session_key();
const log$5 = createSubsystemLogger("gateway/heartbeat");
function hasExplicitHeartbeatAgents(cfg) {
	return (cfg.agents?.list ?? []).some((entry) => Boolean(entry?.heartbeat));
}
function resolveHeartbeatConfig(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.heartbeat;
	if (!agentId) return defaults;
	const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
	if (!defaults && !overrides) return overrides;
	return {
		...defaults,
		...overrides
	};
}
function resolveHeartbeatAgents(cfg) {
	const list = cfg.agents?.list ?? [];
	if (hasExplicitHeartbeatAgents(cfg)) return list.filter((entry) => entry?.heartbeat).map((entry) => {
		const id = normalizeAgentId(entry.id);
		return {
			agentId: id,
			heartbeat: resolveHeartbeatConfig(cfg, id)
		};
	}).filter((entry) => entry.agentId);
	const fallbackId = resolveDefaultAgentId(cfg);
	return [{
		agentId: fallbackId,
		heartbeat: resolveHeartbeatConfig(cfg, fallbackId)
	}];
}
function resolveHeartbeatPrompt(cfg, heartbeat) {
	return resolveHeartbeatPrompt$1(heartbeat?.prompt ?? cfg.agents?.defaults?.heartbeat?.prompt);
}
function resolveHeartbeatAckMaxChars$2(cfg, heartbeat) {
	return Math.max(0, heartbeat?.ackMaxChars ?? cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? 300);
}
function resolveHeartbeatSession(cfg, agentId, heartbeat, forcedSessionKey) {
	const sessionCfg = cfg.session;
	const scope = sessionCfg?.scope ?? "per-sender";
	const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
	const mainSessionKey = scope === "global" ? "global" : resolveAgentMainSessionKey({
		cfg,
		agentId: resolvedAgentId
	});
	const storeAgentId = scope === "global" ? resolveDefaultAgentId(cfg) : resolvedAgentId;
	const storePath = resolveStorePath(sessionCfg?.store, { agentId: storeAgentId });
	const store = loadSessionStore(storePath);
	const mainEntry = store[mainSessionKey];
	if (scope === "global") return {
		sessionKey: mainSessionKey,
		storePath,
		store,
		entry: mainEntry
	};
	const forced = forcedSessionKey?.trim();
	if (forced) {
		const forcedCanonical = canonicalizeMainSessionAlias({
			cfg,
			agentId: resolvedAgentId,
			sessionKey: toAgentStoreSessionKey({
				agentId: resolvedAgentId,
				requestKey: forced,
				mainKey: cfg.session?.mainKey
			})
		});
		if (forcedCanonical !== "global") {
			if (resolveAgentIdFromSessionKey(forcedCanonical) === normalizeAgentId(resolvedAgentId)) return {
				sessionKey: forcedCanonical,
				storePath,
				store,
				entry: store[forcedCanonical]
			};
		}
	}
	const trimmed = heartbeat?.session?.trim() ?? "";
	if (!trimmed) return {
		sessionKey: mainSessionKey,
		storePath,
		store,
		entry: mainEntry
	};
	const normalized = trimmed.toLowerCase();
	if (normalized === "main" || normalized === "global") return {
		sessionKey: mainSessionKey,
		storePath,
		store,
		entry: mainEntry
	};
	const canonical = canonicalizeMainSessionAlias({
		cfg,
		agentId: resolvedAgentId,
		sessionKey: toAgentStoreSessionKey({
			agentId: resolvedAgentId,
			requestKey: trimmed,
			mainKey: cfg.session?.mainKey
		})
	});
	if (canonical !== "global") {
		if (resolveAgentIdFromSessionKey(canonical) === normalizeAgentId(resolvedAgentId)) return {
			sessionKey: canonical,
			storePath,
			store,
			entry: store[canonical]
		};
	}
	return {
		sessionKey: mainSessionKey,
		storePath,
		store,
		entry: mainEntry
	};
}
function resolveHeartbeatReasoningPayloads(replyResult) {
	return (Array.isArray(replyResult) ? replyResult : replyResult ? [replyResult] : []).filter((payload) => {
		return (typeof payload.text === "string" ? payload.text : "").trimStart().startsWith("Reasoning:");
	});
}
async function restoreHeartbeatUpdatedAt(params) {
	const { storePath, sessionKey, updatedAt } = params;
	if (typeof updatedAt !== "number") return;
	const entry = loadSessionStore(storePath)[sessionKey];
	if (!entry) return;
	const nextUpdatedAt = Math.max(entry.updatedAt ?? 0, updatedAt);
	if (entry.updatedAt === nextUpdatedAt) return;
	await updateSessionStore(storePath, (nextStore) => {
		const nextEntry = nextStore[sessionKey] ?? entry;
		if (!nextEntry) return;
		const resolvedUpdatedAt = Math.max(nextEntry.updatedAt ?? 0, updatedAt);
		if (nextEntry.updatedAt === resolvedUpdatedAt) return;
		nextStore[sessionKey] = {
			...nextEntry,
			updatedAt: resolvedUpdatedAt
		};
	});
}
/**
* Prune heartbeat transcript entries by truncating the file back to a previous size.
* This removes the user+assistant turns that were written during a HEARTBEAT_OK run,
* preventing context pollution from zero-information exchanges.
*/
async function pruneHeartbeatTranscript(params) {
	const { transcriptPath, preHeartbeatSize } = params;
	if (!transcriptPath || typeof preHeartbeatSize !== "number" || preHeartbeatSize < 0) return;
	try {
		if ((await fs$1.stat(transcriptPath)).size > preHeartbeatSize) await fs$1.truncate(transcriptPath, preHeartbeatSize);
	} catch {}
}
/**
* Get the transcript file path and its current size before a heartbeat run.
* Returns undefined values if the session or transcript doesn't exist yet.
*/
async function captureTranscriptState(params) {
	const { storePath, sessionKey, agentId } = params;
	try {
		const entry = loadSessionStore(storePath)[sessionKey];
		if (!entry?.sessionId) return {};
		const transcriptPath = resolveSessionFilePath(entry.sessionId, entry, {
			agentId,
			sessionsDir: path.dirname(storePath)
		});
		return {
			transcriptPath,
			preHeartbeatSize: (await fs$1.stat(transcriptPath)).size
		};
	} catch {
		return {};
	}
}
function stripLeadingHeartbeatResponsePrefix(text, responsePrefix) {
	const normalizedPrefix = responsePrefix?.trim();
	if (!normalizedPrefix) return text;
	const prefixPattern = new RegExp(`^${escapeRegExp(normalizedPrefix)}(?=$|\\s|[\\p{P}\\p{S}])\\s*`, "iu");
	return text.replace(prefixPattern, "");
}
function normalizeHeartbeatReply(payload, responsePrefix, ackMaxChars) {
	const stripped = stripHeartbeatToken(stripLeadingHeartbeatResponsePrefix(typeof payload.text === "string" ? payload.text : "", responsePrefix), {
		mode: "heartbeat",
		maxAckChars: ackMaxChars
	});
	const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);
	if (stripped.shouldSkip && !hasMedia) return {
		shouldSkip: true,
		text: "",
		hasMedia
	};
	let finalText = stripped.text;
	if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) finalText = `${responsePrefix} ${finalText}`;
	return {
		shouldSkip: false,
		text: finalText,
		hasMedia
	};
}
function resolveHeartbeatReasonFlags(reason) {
	const reasonKind = resolveHeartbeatReasonKind(reason);
	return {
		isExecEventReason: reasonKind === "exec-event",
		isCronEventReason: reasonKind === "cron",
		isWakeReason: reasonKind === "wake" || reasonKind === "hook"
	};
}
async function resolveHeartbeatPreflight(params) {
	const reasonFlags = resolveHeartbeatReasonFlags(params.reason);
	const session = resolveHeartbeatSession(params.cfg, params.agentId, params.heartbeat, params.forcedSessionKey);
	const pendingEventEntries = peekSystemEventEntries(session.sessionKey);
	const hasTaggedCronEvents = pendingEventEntries.some((event) => event.contextKey?.startsWith("cron:"));
	const shouldInspectPendingEvents = reasonFlags.isExecEventReason || reasonFlags.isCronEventReason || hasTaggedCronEvents;
	const shouldBypassFileGates = reasonFlags.isExecEventReason || reasonFlags.isCronEventReason || reasonFlags.isWakeReason || hasTaggedCronEvents;
	const basePreflight = {
		...reasonFlags,
		session,
		pendingEventEntries,
		hasTaggedCronEvents,
		shouldInspectPendingEvents
	};
	if (shouldBypassFileGates) return basePreflight;
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
	const heartbeatFilePath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
	try {
		if (isHeartbeatContentEffectivelyEmpty(await fs$1.readFile(heartbeatFilePath, "utf-8"))) return {
			...basePreflight,
			skipReason: "empty-heartbeat-file"
		};
	} catch (err) {
		if (hasErrnoCode(err, "ENOENT")) return basePreflight;
	}
	return basePreflight;
}
function appendHeartbeatWorkspacePathHint(prompt, workspaceDir) {
	if (!/heartbeat\.md/i.test(prompt)) return prompt;
	const hint = `When reading HEARTBEAT.md, use workspace file ${path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME).replace(/\\/g, "/")} (exact case). Do not read docs/heartbeat.md.`;
	if (prompt.includes(hint)) return prompt;
	return `${prompt}\n${hint}`;
}
function resolveHeartbeatRunPrompt(params) {
	const pendingEventEntries = params.preflight.pendingEventEntries;
	const pendingEvents = params.preflight.shouldInspectPendingEvents ? pendingEventEntries.map((event) => event.text) : [];
	const cronEvents = pendingEventEntries.filter((event) => (params.preflight.isCronEventReason || event.contextKey?.startsWith("cron:")) && isCronSystemEvent(event.text)).map((event) => event.text);
	const hasExecCompletion = pendingEvents.some(isExecCompletionEvent);
	const hasCronEvents = cronEvents.length > 0;
	return {
		prompt: appendHeartbeatWorkspacePathHint(hasExecCompletion ? buildExecEventPrompt({ deliverToUser: params.canRelayToUser }) : hasCronEvents ? buildCronEventPrompt(cronEvents, { deliverToUser: params.canRelayToUser }) : resolveHeartbeatPrompt(params.cfg, params.heartbeat), params.workspaceDir),
		hasExecCompletion,
		hasCronEvents
	};
}
async function runHeartbeatOnce(opts) {
	const cfg = opts.cfg ?? loadConfig();
	const explicitAgentId = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
	const forcedSessionAgentId = explicitAgentId.length > 0 ? void 0 : parseAgentSessionKey(opts.sessionKey)?.agentId;
	const agentId = normalizeAgentId(explicitAgentId || forcedSessionAgentId || resolveDefaultAgentId(cfg));
	const heartbeat = opts.heartbeat ?? resolveHeartbeatConfig(cfg, agentId);
	if (!areHeartbeatsEnabled()) return {
		status: "skipped",
		reason: "disabled"
	};
	if (!isHeartbeatEnabledForAgent(cfg, agentId)) return {
		status: "skipped",
		reason: "disabled"
	};
	if (!resolveHeartbeatIntervalMs(cfg, void 0, heartbeat)) return {
		status: "skipped",
		reason: "disabled"
	};
	const startedAt = opts.deps?.nowMs?.() ?? Date.now();
	if (!isWithinActiveHours(cfg, heartbeat, startedAt)) return {
		status: "skipped",
		reason: "quiet-hours"
	};
	if ((opts.deps?.getQueueSize ?? getQueueSize)(CommandLane.Main) > 0) return {
		status: "skipped",
		reason: "requests-in-flight"
	};
	const preflight = await resolveHeartbeatPreflight({
		cfg,
		agentId,
		heartbeat,
		forcedSessionKey: opts.sessionKey,
		reason: opts.reason
	});
	if (preflight.skipReason) {
		emitHeartbeatEvent({
			status: "skipped",
			reason: preflight.skipReason,
			durationMs: Date.now() - startedAt
		});
		return {
			status: "skipped",
			reason: preflight.skipReason
		};
	}
	const { entry, sessionKey, storePath } = preflight.session;
	const previousUpdatedAt = entry?.updatedAt;
	const useIsolatedSession = heartbeat?.isolatedSession === true;
	let runSessionKey = sessionKey;
	let runStorePath = storePath;
	if (useIsolatedSession) {
		const isolatedKey = `${sessionKey}:heartbeat`;
		const cronSession = resolveCronSession({
			cfg,
			sessionKey: isolatedKey,
			agentId,
			nowMs: startedAt,
			forceNew: true
		});
		cronSession.store[isolatedKey] = cronSession.sessionEntry;
		await saveSessionStore(cronSession.storePath, cronSession.store);
		runSessionKey = isolatedKey;
		runStorePath = cronSession.storePath;
	}
	const delivery = resolveHeartbeatDeliveryTarget({
		cfg,
		entry,
		heartbeat
	});
	const heartbeatAccountId = heartbeat?.accountId?.trim();
	if (delivery.reason === "unknown-account") log$5.warn("heartbeat: unknown accountId", {
		accountId: delivery.accountId ?? heartbeatAccountId ?? null,
		target: heartbeat?.target ?? "none"
	});
	else if (heartbeatAccountId) log$5.info("heartbeat: using explicit accountId", {
		accountId: delivery.accountId ?? heartbeatAccountId,
		target: heartbeat?.target ?? "none",
		channel: delivery.channel
	});
	const visibility = delivery.channel !== "none" ? resolveHeartbeatVisibility({
		cfg,
		channel: delivery.channel,
		accountId: delivery.accountId
	}) : {
		showOk: false,
		showAlerts: true,
		useIndicator: true
	};
	const { sender } = resolveHeartbeatSenderContext({
		cfg,
		entry,
		delivery
	});
	const responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId, {
		channel: delivery.channel !== "none" ? delivery.channel : void 0,
		accountId: delivery.accountId
	}).responsePrefix;
	const { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({
		cfg,
		heartbeat,
		preflight,
		canRelayToUser: Boolean(delivery.channel !== "none" && delivery.to && visibility.showAlerts),
		workspaceDir: resolveAgentWorkspaceDir(cfg, agentId)
	});
	const ctx = {
		Body: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),
		From: sender,
		To: sender,
		OriginatingChannel: delivery.channel !== "none" ? delivery.channel : void 0,
		OriginatingTo: delivery.to,
		AccountId: delivery.accountId,
		MessageThreadId: delivery.threadId,
		Provider: hasExecCompletion ? "exec-event" : hasCronEvents ? "cron-event" : "heartbeat",
		SessionKey: runSessionKey
	};
	if (!visibility.showAlerts && !visibility.showOk && !visibility.useIndicator) {
		emitHeartbeatEvent({
			status: "skipped",
			reason: "alerts-disabled",
			durationMs: Date.now() - startedAt,
			channel: delivery.channel !== "none" ? delivery.channel : void 0,
			accountId: delivery.accountId
		});
		return {
			status: "skipped",
			reason: "alerts-disabled"
		};
	}
	const heartbeatOkText = responsePrefix ? `${responsePrefix} ${HEARTBEAT_TOKEN}` : HEARTBEAT_TOKEN;
	const outboundSession = buildOutboundSessionContext({
		cfg,
		agentId,
		sessionKey
	});
	const canAttemptHeartbeatOk = Boolean(visibility.showOk && delivery.channel !== "none" && delivery.to);
	const maybeSendHeartbeatOk = async () => {
		if (!canAttemptHeartbeatOk || delivery.channel === "none" || !delivery.to) return false;
		const heartbeatPlugin = getChannelPlugin(delivery.channel);
		if (heartbeatPlugin?.heartbeat?.checkReady) {
			if (!(await heartbeatPlugin.heartbeat.checkReady({
				cfg,
				accountId: delivery.accountId,
				deps: opts.deps
			})).ok) return false;
		}
		await deliverOutboundPayloads({
			cfg,
			channel: delivery.channel,
			to: delivery.to,
			accountId: delivery.accountId,
			threadId: delivery.threadId,
			payloads: [{ text: heartbeatOkText }],
			session: outboundSession,
			deps: opts.deps
		});
		return true;
	};
	try {
		const transcriptState = await captureTranscriptState({
			storePath: runStorePath,
			sessionKey: runSessionKey,
			agentId
		});
		const heartbeatModelOverride = heartbeat?.model?.trim() || void 0;
		const suppressToolErrorWarnings = heartbeat?.suppressToolErrorWarnings === true;
		const bootstrapContextMode = heartbeat?.lightContext === true ? "lightweight" : void 0;
		const replyResult = await getReplyFromConfig(ctx, heartbeatModelOverride ? {
			isHeartbeat: true,
			heartbeatModelOverride,
			suppressToolErrorWarnings,
			bootstrapContextMode
		} : {
			isHeartbeat: true,
			suppressToolErrorWarnings,
			bootstrapContextMode
		}, cfg);
		const replyPayload = resolveHeartbeatReplyPayload(replyResult);
		const reasoningPayloads = heartbeat?.includeReasoning === true ? resolveHeartbeatReasoningPayloads(replyResult).filter((payload) => payload !== replyPayload) : [];
		if (!replyPayload || !replyPayload.text && !replyPayload.mediaUrl && !replyPayload.mediaUrls?.length) {
			await restoreHeartbeatUpdatedAt({
				storePath,
				sessionKey,
				updatedAt: previousUpdatedAt
			});
			await pruneHeartbeatTranscript(transcriptState);
			const okSent = await maybeSendHeartbeatOk();
			emitHeartbeatEvent({
				status: "ok-empty",
				reason: opts.reason,
				durationMs: Date.now() - startedAt,
				channel: delivery.channel !== "none" ? delivery.channel : void 0,
				accountId: delivery.accountId,
				silent: !okSent,
				indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-empty") : void 0
			});
			return {
				status: "ran",
				durationMs: Date.now() - startedAt
			};
		}
		const normalized = normalizeHeartbeatReply(replyPayload, responsePrefix, resolveHeartbeatAckMaxChars$2(cfg, heartbeat));
		const execFallbackText = hasExecCompletion && !normalized.text.trim() && replyPayload.text?.trim() ? replyPayload.text.trim() : null;
		if (execFallbackText) {
			normalized.text = execFallbackText;
			normalized.shouldSkip = false;
		}
		const shouldSkipMain = normalized.shouldSkip && !normalized.hasMedia && !hasExecCompletion;
		if (shouldSkipMain && reasoningPayloads.length === 0) {
			await restoreHeartbeatUpdatedAt({
				storePath,
				sessionKey,
				updatedAt: previousUpdatedAt
			});
			await pruneHeartbeatTranscript(transcriptState);
			const okSent = await maybeSendHeartbeatOk();
			emitHeartbeatEvent({
				status: "ok-token",
				reason: opts.reason,
				durationMs: Date.now() - startedAt,
				channel: delivery.channel !== "none" ? delivery.channel : void 0,
				accountId: delivery.accountId,
				silent: !okSent,
				indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-token") : void 0
			});
			return {
				status: "ran",
				durationMs: Date.now() - startedAt
			};
		}
		const mediaUrls = replyPayload.mediaUrls ?? (replyPayload.mediaUrl ? [replyPayload.mediaUrl] : []);
		const prevHeartbeatText = typeof entry?.lastHeartbeatText === "string" ? entry.lastHeartbeatText : "";
		const prevHeartbeatAt = typeof entry?.lastHeartbeatSentAt === "number" ? entry.lastHeartbeatSentAt : void 0;
		if (!shouldSkipMain && !mediaUrls.length && Boolean(prevHeartbeatText.trim()) && normalized.text.trim() === prevHeartbeatText.trim() && typeof prevHeartbeatAt === "number" && startedAt - prevHeartbeatAt < 1440 * 60 * 1e3) {
			await restoreHeartbeatUpdatedAt({
				storePath,
				sessionKey,
				updatedAt: previousUpdatedAt
			});
			await pruneHeartbeatTranscript(transcriptState);
			emitHeartbeatEvent({
				status: "skipped",
				reason: "duplicate",
				preview: normalized.text.slice(0, 200),
				durationMs: Date.now() - startedAt,
				hasMedia: false,
				channel: delivery.channel !== "none" ? delivery.channel : void 0,
				accountId: delivery.accountId
			});
			return {
				status: "ran",
				durationMs: Date.now() - startedAt
			};
		}
		const previewText = shouldSkipMain ? reasoningPayloads.map((payload) => payload.text).filter((text) => Boolean(text?.trim())).join("\n") : normalized.text;
		if (delivery.channel === "none" || !delivery.to) {
			emitHeartbeatEvent({
				status: "skipped",
				reason: delivery.reason ?? "no-target",
				preview: previewText?.slice(0, 200),
				durationMs: Date.now() - startedAt,
				hasMedia: mediaUrls.length > 0,
				accountId: delivery.accountId
			});
			return {
				status: "ran",
				durationMs: Date.now() - startedAt
			};
		}
		if (!visibility.showAlerts) {
			await restoreHeartbeatUpdatedAt({
				storePath,
				sessionKey,
				updatedAt: previousUpdatedAt
			});
			emitHeartbeatEvent({
				status: "skipped",
				reason: "alerts-disabled",
				preview: previewText?.slice(0, 200),
				durationMs: Date.now() - startedAt,
				channel: delivery.channel,
				hasMedia: mediaUrls.length > 0,
				accountId: delivery.accountId,
				indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : void 0
			});
			return {
				status: "ran",
				durationMs: Date.now() - startedAt
			};
		}
		const deliveryAccountId = delivery.accountId;
		const heartbeatPlugin = getChannelPlugin(delivery.channel);
		if (heartbeatPlugin?.heartbeat?.checkReady) {
			const readiness = await heartbeatPlugin.heartbeat.checkReady({
				cfg,
				accountId: deliveryAccountId,
				deps: opts.deps
			});
			if (!readiness.ok) {
				emitHeartbeatEvent({
					status: "skipped",
					reason: readiness.reason,
					preview: previewText?.slice(0, 200),
					durationMs: Date.now() - startedAt,
					hasMedia: mediaUrls.length > 0,
					channel: delivery.channel,
					accountId: delivery.accountId
				});
				log$5.info("heartbeat: channel not ready", {
					channel: delivery.channel,
					reason: readiness.reason
				});
				return {
					status: "skipped",
					reason: readiness.reason
				};
			}
		}
		await deliverOutboundPayloads({
			cfg,
			channel: delivery.channel,
			to: delivery.to,
			accountId: deliveryAccountId,
			session: outboundSession,
			threadId: delivery.threadId,
			payloads: [...reasoningPayloads, ...shouldSkipMain ? [] : [{
				text: normalized.text,
				mediaUrls
			}]],
			deps: opts.deps
		});
		if (!shouldSkipMain && normalized.text.trim()) {
			const store = loadSessionStore(storePath);
			const current = store[sessionKey];
			if (current) {
				store[sessionKey] = {
					...current,
					lastHeartbeatText: normalized.text,
					lastHeartbeatSentAt: startedAt
				};
				await saveSessionStore(storePath, store);
			}
		}
		emitHeartbeatEvent({
			status: "sent",
			to: delivery.to,
			preview: previewText?.slice(0, 200),
			durationMs: Date.now() - startedAt,
			hasMedia: mediaUrls.length > 0,
			channel: delivery.channel,
			accountId: delivery.accountId,
			indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : void 0
		});
		return {
			status: "ran",
			durationMs: Date.now() - startedAt
		};
	} catch (err) {
		const reason = formatErrorMessage(err);
		emitHeartbeatEvent({
			status: "failed",
			reason,
			durationMs: Date.now() - startedAt,
			channel: delivery.channel !== "none" ? delivery.channel : void 0,
			accountId: delivery.accountId,
			indicatorType: visibility.useIndicator ? resolveIndicatorType("failed") : void 0
		});
		log$5.error(`heartbeat failed: ${reason}`, { error: reason });
		return {
			status: "failed",
			reason
		};
	}
}
function startHeartbeatRunner(opts) {
	const runtime = opts.runtime ?? defaultRuntime;
	const runOnce = opts.runOnce ?? runHeartbeatOnce;
	const state = {
		cfg: opts.cfg ?? loadConfig(),
		runtime,
		agents: /* @__PURE__ */ new Map(),
		timer: null,
		stopped: false
	};
	let initialized = false;
	const resolveNextDue = (now, intervalMs, prevState) => {
		if (typeof prevState?.lastRunMs === "number") return prevState.lastRunMs + intervalMs;
		if (prevState && prevState.intervalMs === intervalMs && prevState.nextDueMs > now) return prevState.nextDueMs;
		return now + intervalMs;
	};
	const advanceAgentSchedule = (agent, now) => {
		agent.lastRunMs = now;
		agent.nextDueMs = now + agent.intervalMs;
	};
	const scheduleNext = () => {
		if (state.stopped) return;
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}
		if (state.agents.size === 0) return;
		const now = Date.now();
		let nextDue = Number.POSITIVE_INFINITY;
		for (const agent of state.agents.values()) if (agent.nextDueMs < nextDue) nextDue = agent.nextDueMs;
		if (!Number.isFinite(nextDue)) return;
		const delay = Math.max(0, nextDue - now);
		state.timer = setTimeout(() => {
			state.timer = null;
			requestHeartbeatNow({
				reason: "interval",
				coalesceMs: 0
			});
		}, delay);
		state.timer.unref?.();
	};
	const updateConfig = (cfg) => {
		if (state.stopped) return;
		const now = Date.now();
		const prevAgents = state.agents;
		const prevEnabled = prevAgents.size > 0;
		const nextAgents = /* @__PURE__ */ new Map();
		const intervals = [];
		for (const agent of resolveHeartbeatAgents(cfg)) {
			const intervalMs = resolveHeartbeatIntervalMs(cfg, void 0, agent.heartbeat);
			if (!intervalMs) continue;
			intervals.push(intervalMs);
			const prevState = prevAgents.get(agent.agentId);
			const nextDueMs = resolveNextDue(now, intervalMs, prevState);
			nextAgents.set(agent.agentId, {
				agentId: agent.agentId,
				heartbeat: agent.heartbeat,
				intervalMs,
				lastRunMs: prevState?.lastRunMs,
				nextDueMs
			});
		}
		state.cfg = cfg;
		state.agents = nextAgents;
		const nextEnabled = nextAgents.size > 0;
		if (!initialized) {
			if (!nextEnabled) log$5.info("heartbeat: disabled", { enabled: false });
			else log$5.info("heartbeat: started", { intervalMs: Math.min(...intervals) });
			initialized = true;
		} else if (prevEnabled !== nextEnabled) if (!nextEnabled) log$5.info("heartbeat: disabled", { enabled: false });
		else log$5.info("heartbeat: started", { intervalMs: Math.min(...intervals) });
		scheduleNext();
	};
	const run = async (params) => {
		if (state.stopped) return {
			status: "skipped",
			reason: "disabled"
		};
		if (!areHeartbeatsEnabled()) return {
			status: "skipped",
			reason: "disabled"
		};
		if (state.agents.size === 0) return {
			status: "skipped",
			reason: "disabled"
		};
		const reason = params?.reason;
		const requestedAgentId = params?.agentId ? normalizeAgentId(params.agentId) : void 0;
		const requestedSessionKey = params?.sessionKey?.trim() || void 0;
		const isInterval = reason === "interval";
		const startedAt = Date.now();
		const now = startedAt;
		let ran = false;
		if (requestedSessionKey || requestedAgentId) {
			const targetAgentId = requestedAgentId ?? resolveAgentIdFromSessionKey(requestedSessionKey);
			const targetAgent = state.agents.get(targetAgentId);
			if (!targetAgent) {
				scheduleNext();
				return {
					status: "skipped",
					reason: "disabled"
				};
			}
			try {
				const res = await runOnce({
					cfg: state.cfg,
					agentId: targetAgent.agentId,
					heartbeat: targetAgent.heartbeat,
					reason,
					sessionKey: requestedSessionKey,
					deps: { runtime: state.runtime }
				});
				if (res.status !== "skipped" || res.reason !== "disabled") advanceAgentSchedule(targetAgent, now);
				scheduleNext();
				return res.status === "ran" ? {
					status: "ran",
					durationMs: Date.now() - startedAt
				} : res;
			} catch (err) {
				const errMsg = formatErrorMessage(err);
				log$5.error(`heartbeat runner: targeted runOnce threw unexpectedly: ${errMsg}`, { error: errMsg });
				advanceAgentSchedule(targetAgent, now);
				scheduleNext();
				return {
					status: "failed",
					reason: errMsg
				};
			}
		}
		for (const agent of state.agents.values()) {
			if (isInterval && now < agent.nextDueMs) continue;
			let res;
			try {
				res = await runOnce({
					cfg: state.cfg,
					agentId: agent.agentId,
					heartbeat: agent.heartbeat,
					reason,
					deps: { runtime: state.runtime }
				});
			} catch (err) {
				const errMsg = formatErrorMessage(err);
				log$5.error(`heartbeat runner: runOnce threw unexpectedly: ${errMsg}`, { error: errMsg });
				advanceAgentSchedule(agent, now);
				continue;
			}
			if (res.status === "skipped" && res.reason === "requests-in-flight") return res;
			if (res.status !== "skipped" || res.reason !== "disabled") advanceAgentSchedule(agent, now);
			if (res.status === "ran") ran = true;
		}
		scheduleNext();
		if (ran) return {
			status: "ran",
			durationMs: Date.now() - startedAt
		};
		return {
			status: "skipped",
			reason: isInterval ? "not-due" : "disabled"
		};
	};
	const wakeHandler = async (params) => run({
		reason: params.reason,
		agentId: params.agentId,
		sessionKey: params.sessionKey
	});
	const disposeWakeHandler = setHeartbeatWakeHandler(wakeHandler);
	updateConfig(state.cfg);
	const cleanup = () => {
		if (state.stopped) return;
		state.stopped = true;
		disposeWakeHandler();
		if (state.timer) clearTimeout(state.timer);
		state.timer = null;
	};
	opts.abortSignal?.addEventListener("abort", cleanup, { once: true });
	return {
		stop: cleanup,
		updateConfig
	};
}
//#endregion
//#region src/infra/update-startup.ts
init_json_files();
let updateAvailableCache = null;
function getUpdateAvailable() {
	return updateAvailableCache;
}
const UPDATE_CHECK_FILENAME = "update-check.json";
const UPDATE_CHECK_INTERVAL_MS = 1440 * 60 * 1e3;
const ONE_HOUR_MS$1 = 3600 * 1e3;
const AUTO_UPDATE_COMMAND_TIMEOUT_MS = 2700 * 1e3;
const AUTO_STABLE_DELAY_HOURS_DEFAULT = 6;
const AUTO_STABLE_JITTER_HOURS_DEFAULT = 12;
const AUTO_BETA_CHECK_INTERVAL_HOURS_DEFAULT = 1;
function shouldSkipCheck(allowInTests) {
	if (allowInTests) return false;
	if (process.env.VITEST || false) return true;
	return false;
}
function resolveAutoUpdatePolicy(cfg) {
	const auto = cfg.update?.auto;
	const stableDelayHours = typeof auto?.stableDelayHours === "number" && Number.isFinite(auto.stableDelayHours) ? Math.max(0, auto.stableDelayHours) : AUTO_STABLE_DELAY_HOURS_DEFAULT;
	const stableJitterHours = typeof auto?.stableJitterHours === "number" && Number.isFinite(auto.stableJitterHours) ? Math.max(0, auto.stableJitterHours) : AUTO_STABLE_JITTER_HOURS_DEFAULT;
	const betaCheckIntervalHours = typeof auto?.betaCheckIntervalHours === "number" && Number.isFinite(auto.betaCheckIntervalHours) ? Math.max(.25, auto.betaCheckIntervalHours) : AUTO_BETA_CHECK_INTERVAL_HOURS_DEFAULT;
	return {
		enabled: Boolean(auto?.enabled),
		stableDelayHours,
		stableJitterHours,
		betaCheckIntervalHours
	};
}
function resolveCheckIntervalMs(cfg) {
	const channel = normalizeUpdateChannel(cfg.update?.channel) ?? "stable";
	const auto = resolveAutoUpdatePolicy(cfg);
	if (!auto.enabled) return UPDATE_CHECK_INTERVAL_MS;
	if (channel === "beta") return Math.max(ONE_HOUR_MS$1 / 4, Math.floor(auto.betaCheckIntervalHours * ONE_HOUR_MS$1));
	if (channel === "stable") return ONE_HOUR_MS$1;
	return UPDATE_CHECK_INTERVAL_MS;
}
async function readState(statePath) {
	try {
		const raw = await fs$1.readFile(statePath, "utf-8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
async function writeState(statePath, state) {
	await writeJsonAtomic(statePath, state);
}
function sameUpdateAvailable(a, b) {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.currentVersion === b.currentVersion && a.latestVersion === b.latestVersion && a.channel === b.channel;
}
function setUpdateAvailableCache(params) {
	if (sameUpdateAvailable(updateAvailableCache, params.next)) return;
	updateAvailableCache = params.next;
	params.onUpdateAvailableChange?.(params.next);
}
function resolvePersistedUpdateAvailable(state) {
	const latestVersion = state.lastAvailableVersion?.trim();
	if (!latestVersion) return null;
	const cmp = compareSemverStrings(VERSION, latestVersion);
	if (cmp == null || cmp >= 0) return null;
	return {
		currentVersion: VERSION,
		latestVersion,
		channel: state.lastAvailableTag?.trim() || "stable"
	};
}
function resolveStableJitterMs(params) {
	if (params.jitterWindowMs <= 0) return 0;
	return createHash("sha256").update(`${params.installId}:${params.version}:${params.tag}`).digest().readUInt32BE(0) % (Math.floor(params.jitterWindowMs) + 1);
}
function resolveStableAutoApplyAtMs(params) {
	if (!params.nextState.autoInstallId) params.nextState.autoInstallId = params.state.autoInstallId?.trim() || randomUUID();
	const installId = params.nextState.autoInstallId;
	if (!(params.state.autoFirstSeenVersion === params.version && params.state.autoFirstSeenTag === params.tag)) {
		params.nextState.autoFirstSeenVersion = params.version;
		params.nextState.autoFirstSeenTag = params.tag;
		params.nextState.autoFirstSeenAt = new Date(params.nowMs).toISOString();
	} else {
		params.nextState.autoFirstSeenVersion = params.state.autoFirstSeenVersion;
		params.nextState.autoFirstSeenTag = params.state.autoFirstSeenTag;
		params.nextState.autoFirstSeenAt = params.state.autoFirstSeenAt;
	}
	const firstSeenMs = params.nextState.autoFirstSeenAt ? Date.parse(params.nextState.autoFirstSeenAt) : params.nowMs;
	const baseDelayMs = Math.max(0, params.stableDelayHours) * ONE_HOUR_MS$1;
	const jitterWindowMs = Math.max(0, params.stableJitterHours) * ONE_HOUR_MS$1;
	const jitterMs = resolveStableJitterMs({
		installId,
		version: params.version,
		tag: params.tag,
		jitterWindowMs
	});
	return firstSeenMs + baseDelayMs + jitterMs;
}
async function runAutoUpdateCommand(params) {
	const baseArgs = [
		"update",
		"--yes",
		"--channel",
		params.channel,
		"--json"
	];
	const execPath = process.execPath?.trim();
	const argv1 = process.argv[1]?.trim();
	const lowerExecBase = execPath ? path.basename(execPath).toLowerCase() : "";
	const runtimeIsNodeOrBun = lowerExecBase === "node" || lowerExecBase === "node.exe" || lowerExecBase === "bun" || lowerExecBase === "bun.exe";
	const argv = [];
	if (execPath && argv1) argv.push(execPath, argv1, ...baseArgs);
	else if (execPath && !runtimeIsNodeOrBun) argv.push(execPath, ...baseArgs);
	else if (execPath && params.root) {
		const candidates = [
			path.join(params.root, "dist", "entry.js"),
			path.join(params.root, "dist", "entry.mjs"),
			path.join(params.root, "dist", "index.js"),
			path.join(params.root, "dist", "index.mjs")
		];
		for (const candidate of candidates) try {
			await fs$1.access(candidate);
			argv.push(execPath, candidate, ...baseArgs);
			break;
		} catch {}
	}
	if (argv.length === 0) argv.push("openclaw", ...baseArgs);
	try {
		const res = await runCommandWithTimeout(argv, {
			timeoutMs: params.timeoutMs,
			env: { OPENCLAW_AUTO_UPDATE: "1" }
		});
		return {
			ok: res.code === 0,
			code: res.code,
			stdout: res.stdout,
			stderr: res.stderr,
			reason: res.code === 0 ? void 0 : "non-zero-exit"
		};
	} catch (err) {
		return {
			ok: false,
			code: null,
			reason: String(err)
		};
	}
}
function clearAutoState(nextState) {
	delete nextState.autoFirstSeenVersion;
	delete nextState.autoFirstSeenTag;
	delete nextState.autoFirstSeenAt;
}
async function runGatewayUpdateCheck(params) {
	if (shouldSkipCheck(Boolean(params.allowInTests))) return;
	if (params.isNixMode) return;
	const auto = resolveAutoUpdatePolicy(params.cfg);
	const shouldRunUpdateHints = params.cfg.update?.checkOnStart !== false;
	if (!shouldRunUpdateHints && !auto.enabled) return;
	const statePath = path.join(resolveStateDir(), UPDATE_CHECK_FILENAME);
	const state = await readState(statePath);
	const now = Date.now();
	const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
	if (shouldRunUpdateHints) setUpdateAvailableCache({
		next: resolvePersistedUpdateAvailable(state),
		onUpdateAvailableChange: params.onUpdateAvailableChange
	});
	else setUpdateAvailableCache({
		next: null,
		onUpdateAvailableChange: params.onUpdateAvailableChange
	});
	const checkIntervalMs = resolveCheckIntervalMs(params.cfg);
	if (lastCheckedAt && Number.isFinite(lastCheckedAt)) {
		if (now - lastCheckedAt < checkIntervalMs) return;
	}
	const root = await resolveOpenClawPackageRoot({
		moduleUrl: import.meta.url,
		argv1: process.argv[1],
		cwd: process.cwd()
	});
	const status = await checkUpdateStatus({
		root,
		timeoutMs: 2500,
		fetchGit: false,
		includeRegistry: false
	});
	const nextState = {
		...state,
		lastCheckedAt: new Date(now).toISOString()
	};
	if (status.installKind !== "package") {
		delete nextState.lastAvailableVersion;
		delete nextState.lastAvailableTag;
		clearAutoState(nextState);
		setUpdateAvailableCache({
			next: null,
			onUpdateAvailableChange: params.onUpdateAvailableChange
		});
		await writeState(statePath, nextState);
		return;
	}
	const channel = normalizeUpdateChannel(params.cfg.update?.channel) ?? "stable";
	const resolved = await resolveNpmChannelTag({
		channel,
		timeoutMs: 2500
	});
	const tag = resolved.tag;
	if (!resolved.version) {
		await writeState(statePath, nextState);
		return;
	}
	const cmp = compareSemverStrings(VERSION, resolved.version);
	if (cmp != null && cmp < 0) {
		const nextAvailable = {
			currentVersion: VERSION,
			latestVersion: resolved.version,
			channel: tag
		};
		if (shouldRunUpdateHints) setUpdateAvailableCache({
			next: nextAvailable,
			onUpdateAvailableChange: params.onUpdateAvailableChange
		});
		nextState.lastAvailableVersion = resolved.version;
		nextState.lastAvailableTag = tag;
		const shouldNotify = state.lastNotifiedVersion !== resolved.version || state.lastNotifiedTag !== tag;
		if (shouldRunUpdateHints && shouldNotify) {
			params.log.info(`update available (${tag}): v${resolved.version} (current v${VERSION}). Run: ${formatCliCommand("openclaw update")}`);
			nextState.lastNotifiedVersion = resolved.version;
			nextState.lastNotifiedTag = tag;
		}
		if (auto.enabled && (channel === "stable" || channel === "beta")) {
			const runAuto = params.runAutoUpdate ?? runAutoUpdateCommand;
			const attemptIntervalMs = channel === "beta" ? Math.max(ONE_HOUR_MS$1 / 4, Math.floor(auto.betaCheckIntervalHours * ONE_HOUR_MS$1)) : ONE_HOUR_MS$1;
			const lastAttemptAt = state.autoLastAttemptAt ? Date.parse(state.autoLastAttemptAt) : null;
			const recentAttemptForSameVersion = state.autoLastAttemptVersion === resolved.version && lastAttemptAt != null && Number.isFinite(lastAttemptAt) && now - lastAttemptAt < attemptIntervalMs;
			let dueNow = channel === "beta";
			let applyAfterMs = null;
			if (channel === "stable") {
				applyAfterMs = resolveStableAutoApplyAtMs({
					state,
					nextState,
					nowMs: now,
					version: resolved.version,
					tag,
					stableDelayHours: auto.stableDelayHours,
					stableJitterHours: auto.stableJitterHours
				});
				dueNow = now >= applyAfterMs;
			}
			if (!dueNow) params.log.info("auto-update deferred (stable rollout window active)", {
				version: resolved.version,
				tag,
				applyAfter: applyAfterMs ? new Date(applyAfterMs).toISOString() : void 0
			});
			else if (recentAttemptForSameVersion) params.log.info("auto-update deferred (recent attempt exists)", {
				version: resolved.version,
				tag
			});
			else {
				nextState.autoLastAttemptVersion = resolved.version;
				nextState.autoLastAttemptAt = new Date(now).toISOString();
				const outcome = await runAuto({
					channel,
					timeoutMs: AUTO_UPDATE_COMMAND_TIMEOUT_MS,
					root: root ?? void 0
				});
				if (outcome.ok) {
					nextState.autoLastSuccessVersion = resolved.version;
					nextState.autoLastSuccessAt = new Date(now).toISOString();
					params.log.info("auto-update applied", {
						channel,
						version: resolved.version,
						tag
					});
				} else params.log.info("auto-update attempt failed", {
					channel,
					version: resolved.version,
					tag,
					reason: outcome.reason ?? `exit:${outcome.code}`
				});
			}
		}
	} else {
		delete nextState.lastAvailableVersion;
		delete nextState.lastAvailableTag;
		clearAutoState(nextState);
		setUpdateAvailableCache({
			next: null,
			onUpdateAvailableChange: params.onUpdateAvailableChange
		});
	}
	await writeState(statePath, nextState);
}
function scheduleGatewayUpdateCheck(params) {
	let stopped = false;
	let timer = null;
	let running = false;
	const tick = async () => {
		if (stopped || running) return;
		running = true;
		try {
			await runGatewayUpdateCheck(params);
		} catch {} finally {
			running = false;
		}
		if (stopped) return;
		const intervalMs = resolveCheckIntervalMs(params.cfg);
		timer = setTimeout(() => {
			tick();
		}, intervalMs);
	};
	tick();
	return () => {
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
}
//#endregion
//#region src/gateway/channel-health-policy.ts
init_registry$1();
init_internal_hooks();
function isManagedAccount(snapshot) {
	return snapshot.enabled !== false && snapshot.configured !== false;
}
const BUSY_ACTIVITY_STALE_THRESHOLD_MS = 25 * 6e4;
const DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS = 30 * 6e4;
const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 12e4;
function evaluateChannelHealth(snapshot, policy) {
	if (!isManagedAccount(snapshot)) return {
		healthy: true,
		reason: "unmanaged"
	};
	if (!snapshot.running) return {
		healthy: false,
		reason: "not-running"
	};
	const activeRuns = typeof snapshot.activeRuns === "number" && Number.isFinite(snapshot.activeRuns) ? Math.max(0, Math.trunc(snapshot.activeRuns)) : 0;
	const isBusy = snapshot.busy === true || activeRuns > 0;
	const lastStartAt = typeof snapshot.lastStartAt === "number" && Number.isFinite(snapshot.lastStartAt) ? snapshot.lastStartAt : null;
	const lastRunActivityAt = typeof snapshot.lastRunActivityAt === "number" && Number.isFinite(snapshot.lastRunActivityAt) ? snapshot.lastRunActivityAt : null;
	const busyStateInitializedForLifecycle = lastStartAt == null || lastRunActivityAt != null && lastRunActivityAt >= lastStartAt;
	if (isBusy) if (!busyStateInitializedForLifecycle) {} else {
		if ((lastRunActivityAt == null ? Number.POSITIVE_INFINITY : Math.max(0, policy.now - lastRunActivityAt)) < BUSY_ACTIVITY_STALE_THRESHOLD_MS) return {
			healthy: true,
			reason: "busy"
		};
		return {
			healthy: false,
			reason: "stuck"
		};
	}
	if (snapshot.lastStartAt != null) {
		if (policy.now - snapshot.lastStartAt < policy.channelConnectGraceMs) return {
			healthy: true,
			reason: "startup-connect-grace"
		};
	}
	if (snapshot.connected === false) return {
		healthy: false,
		reason: "disconnected"
	};
	if (policy.channelId !== "telegram" && snapshot.mode !== "webhook" && snapshot.connected === true && snapshot.lastEventAt != null) {
		if (lastStartAt != null && snapshot.lastEventAt < lastStartAt) {
			if (Math.max(0, policy.now - lastStartAt) <= policy.staleEventThresholdMs) return {
				healthy: true,
				reason: "healthy"
			};
			return {
				healthy: false,
				reason: "stale-socket"
			};
		}
		if (policy.now - snapshot.lastEventAt > policy.staleEventThresholdMs) return {
			healthy: false,
			reason: "stale-socket"
		};
	}
	return {
		healthy: true,
		reason: "healthy"
	};
}
function resolveChannelRestartReason(snapshot, evaluation) {
	if (evaluation.reason === "stale-socket") return "stale-socket";
	if (evaluation.reason === "not-running") return snapshot.reconnectAttempts && snapshot.reconnectAttempts >= 10 ? "gave-up" : "stopped";
	if (evaluation.reason === "disconnected") return "disconnected";
	return "stuck";
}
//#endregion
//#region src/gateway/channel-health-monitor.ts
init_subsystem();
const log$4 = createSubsystemLogger("gateway/health-monitor");
const DEFAULT_CHECK_INTERVAL_MS = 5 * 6e4;
const DEFAULT_MONITOR_STARTUP_GRACE_MS = 6e4;
const DEFAULT_COOLDOWN_CYCLES = 2;
const DEFAULT_MAX_RESTARTS_PER_HOUR = 10;
const ONE_HOUR_MS = 60 * 6e4;
function resolveTimingPolicy(deps) {
	return {
		monitorStartupGraceMs: deps.timing?.monitorStartupGraceMs ?? deps.startupGraceMs ?? DEFAULT_MONITOR_STARTUP_GRACE_MS,
		channelConnectGraceMs: deps.timing?.channelConnectGraceMs ?? deps.channelStartupGraceMs ?? 12e4,
		staleEventThresholdMs: deps.timing?.staleEventThresholdMs ?? deps.staleEventThresholdMs ?? 18e5
	};
}
function startChannelHealthMonitor(deps) {
	const { channelManager, checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS, cooldownCycles = DEFAULT_COOLDOWN_CYCLES, maxRestartsPerHour = DEFAULT_MAX_RESTARTS_PER_HOUR, abortSignal } = deps;
	const timing = resolveTimingPolicy(deps);
	const cooldownMs = cooldownCycles * checkIntervalMs;
	const restartRecords = /* @__PURE__ */ new Map();
	const startedAt = Date.now();
	let stopped = false;
	let checkInFlight = false;
	let timer = null;
	const rKey = (channelId, accountId) => `${channelId}:${accountId}`;
	function pruneOldRestarts(record, now) {
		record.restartsThisHour = record.restartsThisHour.filter((r) => now - r.at < ONE_HOUR_MS);
	}
	async function runCheck() {
		if (stopped || checkInFlight) return;
		checkInFlight = true;
		try {
			const now = Date.now();
			if (now - startedAt < timing.monitorStartupGraceMs) return;
			const snapshot = channelManager.getRuntimeSnapshot();
			for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
				if (!accounts) continue;
				for (const [accountId, status] of Object.entries(accounts)) {
					if (!status) continue;
					if (!channelManager.isHealthMonitorEnabled(channelId, accountId)) continue;
					if (channelManager.isManuallyStopped(channelId, accountId)) continue;
					const health = evaluateChannelHealth(status, {
						channelId,
						now,
						staleEventThresholdMs: timing.staleEventThresholdMs,
						channelConnectGraceMs: timing.channelConnectGraceMs
					});
					if (health.healthy) continue;
					const key = rKey(channelId, accountId);
					const record = restartRecords.get(key) ?? {
						lastRestartAt: 0,
						restartsThisHour: []
					};
					if (now - record.lastRestartAt <= cooldownMs) continue;
					pruneOldRestarts(record, now);
					if (record.restartsThisHour.length >= maxRestartsPerHour) {
						log$4.warn?.(`[${channelId}:${accountId}] health-monitor: hit ${maxRestartsPerHour} restarts/hour limit, skipping`);
						continue;
					}
					const reason = resolveChannelRestartReason(status, health);
					log$4.info?.(`[${channelId}:${accountId}] health-monitor: restarting (reason: ${reason})`);
					try {
						if (status.running) await channelManager.stopChannel(channelId, accountId);
						channelManager.resetRestartAttempts(channelId, accountId);
						await channelManager.startChannel(channelId, accountId);
						record.lastRestartAt = now;
						record.restartsThisHour.push({ at: now });
						restartRecords.set(key, record);
					} catch (err) {
						log$4.error?.(`[${channelId}:${accountId}] health-monitor: restart failed: ${String(err)}`);
					}
				}
			}
		} finally {
			checkInFlight = false;
		}
	}
	function stop() {
		stopped = true;
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}
	if (abortSignal?.aborted) stopped = true;
	else {
		abortSignal?.addEventListener("abort", stop, { once: true });
		timer = setInterval(() => void runCheck(), checkIntervalMs);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		log$4.info?.(`started (interval: ${Math.round(checkIntervalMs / 1e3)}s, startup-grace: ${Math.round(timing.monitorStartupGraceMs / 1e3)}s, channel-connect-grace: ${Math.round(timing.channelConnectGraceMs / 1e3)}s)`);
	}
	return { stop };
}
//#endregion
//#region src/gateway/config-reload-plan.ts
init_runtime$1();
const BASE_RELOAD_RULES = [
	{
		prefix: "gateway.remote",
		kind: "none"
	},
	{
		prefix: "gateway.reload",
		kind: "none"
	},
	{
		prefix: "gateway.channelHealthCheckMinutes",
		kind: "hot",
		actions: ["restart-health-monitor"]
	},
	{
		prefix: "gateway.channelStaleEventThresholdMinutes",
		kind: "hot",
		actions: ["restart-health-monitor"]
	},
	{
		prefix: "gateway.channelMaxRestartsPerHour",
		kind: "hot",
		actions: ["restart-health-monitor"]
	},
	{
		prefix: "diagnostics.stuckSessionWarnMs",
		kind: "none"
	},
	{
		prefix: "hooks.gmail",
		kind: "hot",
		actions: ["restart-gmail-watcher"]
	},
	{
		prefix: "hooks",
		kind: "hot",
		actions: ["reload-hooks"]
	},
	{
		prefix: "agents.defaults.heartbeat",
		kind: "hot",
		actions: ["restart-heartbeat"]
	},
	{
		prefix: "agents.defaults.models",
		kind: "hot",
		actions: ["restart-heartbeat"]
	},
	{
		prefix: "agents.defaults.model",
		kind: "hot",
		actions: ["restart-heartbeat"]
	},
	{
		prefix: "models",
		kind: "hot",
		actions: ["restart-heartbeat"]
	},
	{
		prefix: "agent.heartbeat",
		kind: "hot",
		actions: ["restart-heartbeat"]
	},
	{
		prefix: "cron",
		kind: "hot",
		actions: ["restart-cron"]
	},
	{
		prefix: "browser",
		kind: "hot",
		actions: ["restart-browser-control"]
	}
];
const BASE_RELOAD_RULES_TAIL = [
	{
		prefix: "meta",
		kind: "none"
	},
	{
		prefix: "identity",
		kind: "none"
	},
	{
		prefix: "wizard",
		kind: "none"
	},
	{
		prefix: "logging",
		kind: "none"
	},
	{
		prefix: "agents",
		kind: "none"
	},
	{
		prefix: "tools",
		kind: "none"
	},
	{
		prefix: "bindings",
		kind: "none"
	},
	{
		prefix: "audio",
		kind: "none"
	},
	{
		prefix: "agent",
		kind: "none"
	},
	{
		prefix: "routing",
		kind: "none"
	},
	{
		prefix: "messages",
		kind: "none"
	},
	{
		prefix: "session",
		kind: "none"
	},
	{
		prefix: "talk",
		kind: "none"
	},
	{
		prefix: "skills",
		kind: "none"
	},
	{
		prefix: "secrets",
		kind: "none"
	},
	{
		prefix: "plugins",
		kind: "restart"
	},
	{
		prefix: "ui",
		kind: "none"
	},
	{
		prefix: "gateway",
		kind: "restart"
	},
	{
		prefix: "discovery",
		kind: "restart"
	},
	{
		prefix: "canvasHost",
		kind: "restart"
	}
];
let cachedReloadRules = null;
let cachedRegistry = null;
function listReloadRules() {
	const registry = getActivePluginRegistry();
	if (registry !== cachedRegistry) {
		cachedReloadRules = null;
		cachedRegistry = registry;
	}
	if (cachedReloadRules) return cachedReloadRules;
	const channelReloadRules = listChannelPlugins().flatMap((plugin) => [...(plugin.reload?.configPrefixes ?? []).map((prefix) => ({
		prefix,
		kind: "hot",
		actions: [`restart-channel:${plugin.id}`]
	})), ...(plugin.reload?.noopPrefixes ?? []).map((prefix) => ({
		prefix,
		kind: "none"
	}))]);
	const rules = [
		...BASE_RELOAD_RULES,
		...channelReloadRules,
		...BASE_RELOAD_RULES_TAIL
	];
	cachedReloadRules = rules;
	return rules;
}
function matchRule(path) {
	for (const rule of listReloadRules()) if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) return rule;
	return null;
}
function buildGatewayReloadPlan(changedPaths) {
	const plan = {
		changedPaths,
		restartGateway: false,
		restartReasons: [],
		hotReasons: [],
		reloadHooks: false,
		restartGmailWatcher: false,
		restartBrowserControl: false,
		restartCron: false,
		restartHeartbeat: false,
		restartHealthMonitor: false,
		restartChannels: /* @__PURE__ */ new Set(),
		noopPaths: []
	};
	const applyAction = (action) => {
		if (action.startsWith("restart-channel:")) {
			const channel = action.slice(16);
			plan.restartChannels.add(channel);
			return;
		}
		switch (action) {
			case "reload-hooks":
				plan.reloadHooks = true;
				break;
			case "restart-gmail-watcher":
				plan.restartGmailWatcher = true;
				break;
			case "restart-browser-control":
				plan.restartBrowserControl = true;
				break;
			case "restart-cron":
				plan.restartCron = true;
				break;
			case "restart-heartbeat":
				plan.restartHeartbeat = true;
				break;
			case "restart-health-monitor":
				plan.restartHealthMonitor = true;
				break;
			default: break;
		}
	};
	for (const path of changedPaths) {
		const rule = matchRule(path);
		if (!rule) {
			plan.restartGateway = true;
			plan.restartReasons.push(path);
			continue;
		}
		if (rule.kind === "restart") {
			plan.restartGateway = true;
			plan.restartReasons.push(path);
			continue;
		}
		if (rule.kind === "none") {
			plan.noopPaths.push(path);
			continue;
		}
		plan.hotReasons.push(path);
		for (const action of rule.actions ?? []) applyAction(action);
	}
	if (plan.restartGmailWatcher) plan.reloadHooks = true;
	return plan;
}
//#endregion
//#region src/gateway/config-reload.ts
init_utils();
const DEFAULT_RELOAD_SETTINGS = {
	mode: "hybrid",
	debounceMs: 300
};
const MISSING_CONFIG_RETRY_DELAY_MS = 150;
const MISSING_CONFIG_MAX_RETRIES = 2;
function diffConfigPaths(prev, next, prefix = "") {
	if (prev === next) return [];
	if (isPlainObject(prev) && isPlainObject(next)) {
		const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
		const paths = [];
		for (const key of keys) {
			const prevValue = prev[key];
			const nextValue = next[key];
			if (prevValue === void 0 && nextValue === void 0) continue;
			const childPaths = diffConfigPaths(prevValue, nextValue, prefix ? `${prefix}.${key}` : key);
			if (childPaths.length > 0) paths.push(...childPaths);
		}
		return paths;
	}
	if (Array.isArray(prev) && Array.isArray(next)) {
		if (isDeepStrictEqual(prev, next)) return [];
	}
	return [prefix || "<root>"];
}
function resolveGatewayReloadSettings(cfg) {
	const rawMode = cfg.gateway?.reload?.mode;
	const mode = rawMode === "off" || rawMode === "restart" || rawMode === "hot" || rawMode === "hybrid" ? rawMode : DEFAULT_RELOAD_SETTINGS.mode;
	const debounceRaw = cfg.gateway?.reload?.debounceMs;
	return {
		mode,
		debounceMs: typeof debounceRaw === "number" && Number.isFinite(debounceRaw) ? Math.max(0, Math.floor(debounceRaw)) : DEFAULT_RELOAD_SETTINGS.debounceMs
	};
}
function startGatewayConfigReloader(opts) {
	let currentConfig = opts.initialConfig;
	let settings = resolveGatewayReloadSettings(currentConfig);
	let debounceTimer = null;
	let pending = false;
	let running = false;
	let stopped = false;
	let restartQueued = false;
	let missingConfigRetries = 0;
	const scheduleAfter = (wait) => {
		if (stopped) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			runReload();
		}, wait);
	};
	const schedule = () => {
		scheduleAfter(settings.debounceMs);
	};
	const queueRestart = (plan, nextConfig) => {
		if (restartQueued) return;
		restartQueued = true;
		(async () => {
			try {
				await opts.onRestart(plan, nextConfig);
			} catch (err) {
				restartQueued = false;
				opts.log.error(`config restart failed: ${String(err)}`);
			}
		})();
	};
	const handleMissingSnapshot = (snapshot) => {
		if (snapshot.exists) {
			missingConfigRetries = 0;
			return false;
		}
		if (missingConfigRetries < MISSING_CONFIG_MAX_RETRIES) {
			missingConfigRetries += 1;
			opts.log.info(`config reload retry (${missingConfigRetries}/${MISSING_CONFIG_MAX_RETRIES}): config file not found`);
			scheduleAfter(MISSING_CONFIG_RETRY_DELAY_MS);
			return true;
		}
		opts.log.warn("config reload skipped (config file not found)");
		return true;
	};
	const handleInvalidSnapshot = (snapshot) => {
		if (snapshot.valid) return false;
		const issues = formatConfigIssueLines(snapshot.issues, "").join(", ");
		opts.log.warn(`config reload skipped (invalid config): ${issues}`);
		return true;
	};
	const applySnapshot = async (nextConfig) => {
		const changedPaths = diffConfigPaths(currentConfig, nextConfig);
		currentConfig = nextConfig;
		settings = resolveGatewayReloadSettings(nextConfig);
		if (changedPaths.length === 0) return;
		opts.log.info(`config change detected; evaluating reload (${changedPaths.join(", ")})`);
		const plan = buildGatewayReloadPlan(changedPaths);
		if (settings.mode === "off") {
			opts.log.info("config reload disabled (gateway.reload.mode=off)");
			return;
		}
		if (settings.mode === "restart") {
			queueRestart(plan, nextConfig);
			return;
		}
		if (plan.restartGateway) {
			if (settings.mode === "hot") {
				opts.log.warn(`config reload requires gateway restart; hot mode ignoring (${plan.restartReasons.join(", ")})`);
				return;
			}
			queueRestart(plan, nextConfig);
			return;
		}
		await opts.onHotReload(plan, nextConfig);
	};
	const runReload = async () => {
		if (stopped) return;
		if (running) {
			pending = true;
			return;
		}
		running = true;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		try {
			const snapshot = await opts.readSnapshot();
			if (handleMissingSnapshot(snapshot)) return;
			if (handleInvalidSnapshot(snapshot)) return;
			await applySnapshot(snapshot.config);
		} catch (err) {
			opts.log.error(`config reload failed: ${String(err)}`);
		} finally {
			running = false;
			if (pending) {
				pending = false;
				schedule();
			}
		}
	};
	const watcher = chokidar.watch(opts.watchPath, {
		ignoreInitial: true,
		awaitWriteFinish: {
			stabilityThreshold: 200,
			pollInterval: 50
		},
		usePolling: Boolean(process.env.VITEST)
	});
	watcher.on("add", schedule);
	watcher.on("change", schedule);
	watcher.on("unlink", schedule);
	let watcherClosed = false;
	watcher.on("error", (err) => {
		if (watcherClosed) return;
		watcherClosed = true;
		opts.log.warn(`config watcher error: ${String(err)}`);
		watcher.close().catch(() => {});
	});
	return { stop: async () => {
		stopped = true;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = null;
		watcherClosed = true;
		await watcher.close().catch(() => {});
	} };
}
//#endregion
//#region src/gateway/events.ts
const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available";
//#endregion
//#region src/gateway/exec-approval-manager.ts
const RESOLVED_ENTRY_GRACE_MS = 15e3;
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
		setTimeout(() => {
			if (this.pending.get(recordId) === pending) this.pending.delete(recordId);
		}, RESOLVED_ENTRY_GRACE_MS);
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
		setTimeout(() => {
			if (this.pending.get(recordId) === pending) this.pending.delete(recordId);
		}, RESOLVED_ENTRY_GRACE_MS);
		return true;
	}
	getSnapshot(recordId) {
		return this.pending.get(recordId)?.record ?? null;
	}
	consumeAllowOnce(recordId) {
		const entry = this.pending.get(recordId);
		if (!entry) return false;
		const record = entry.record;
		if (record.decision !== "allow-once") return false;
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
	lookupPendingId(input) {
		const normalized = input.trim();
		if (!normalized) return { kind: "none" };
		const exact = this.pending.get(normalized);
		if (exact) return exact.record.resolvedAtMs === void 0 ? {
			kind: "exact",
			id: normalized
		} : { kind: "none" };
		const lowerPrefix = normalized.toLowerCase();
		const matches = [];
		for (const [id, entry] of this.pending.entries()) {
			if (entry.record.resolvedAtMs !== void 0) continue;
			if (id.toLowerCase().startsWith(lowerPrefix)) matches.push(id);
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
};
//#endregion
//#region src/gateway/node-registry.ts
var NodeRegistry = class {
	constructor() {
		this.nodesById = /* @__PURE__ */ new Map();
		this.nodesByConn = /* @__PURE__ */ new Map();
		this.pendingInvokes = /* @__PURE__ */ new Map();
	}
	register(client, opts) {
		const connect = client.connect;
		const nodeId = connect.device?.id ?? connect.client.id;
		const caps = Array.isArray(connect.caps) ? connect.caps : [];
		const commands = Array.isArray(connect.commands) ? connect.commands ?? [] : [];
		const permissions = typeof connect.permissions === "object" ? connect.permissions ?? void 0 : void 0;
		const pathEnv = typeof connect.pathEnv === "string" ? connect.pathEnv : void 0;
		const session = {
			nodeId,
			connId: client.connId,
			client,
			displayName: connect.client.displayName,
			platform: connect.client.platform,
			version: connect.client.version,
			coreVersion: connect.coreVersion,
			uiVersion: connect.uiVersion,
			deviceFamily: connect.client.deviceFamily,
			modelIdentifier: connect.client.modelIdentifier,
			remoteIp: opts.remoteIp,
			caps,
			commands,
			permissions,
			pathEnv,
			connectedAtMs: Date.now()
		};
		this.nodesById.set(nodeId, session);
		this.nodesByConn.set(client.connId, nodeId);
		return session;
	}
	unregister(connId) {
		const nodeId = this.nodesByConn.get(connId);
		if (!nodeId) return null;
		this.nodesByConn.delete(connId);
		this.nodesById.delete(nodeId);
		for (const [id, pending] of this.pendingInvokes.entries()) {
			if (pending.nodeId !== nodeId) continue;
			clearTimeout(pending.timer);
			pending.reject(/* @__PURE__ */ new Error(`node disconnected (${pending.command})`));
			this.pendingInvokes.delete(id);
		}
		return nodeId;
	}
	listConnected() {
		return [...this.nodesById.values()];
	}
	get(nodeId) {
		return this.nodesById.get(nodeId);
	}
	async invoke(params) {
		const node = this.nodesById.get(params.nodeId);
		if (!node) return {
			ok: false,
			error: {
				code: "NOT_CONNECTED",
				message: "node not connected"
			}
		};
		const requestId = randomUUID();
		const payload = {
			id: requestId,
			nodeId: params.nodeId,
			command: params.command,
			paramsJSON: "params" in params && params.params !== void 0 ? JSON.stringify(params.params) : null,
			timeoutMs: params.timeoutMs,
			idempotencyKey: params.idempotencyKey
		};
		if (!this.sendEventToSession(node, "node.invoke.request", payload)) return {
			ok: false,
			error: {
				code: "UNAVAILABLE",
				message: "failed to send invoke to node"
			}
		};
		const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 3e4;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingInvokes.delete(requestId);
				resolve({
					ok: false,
					error: {
						code: "TIMEOUT",
						message: "node invoke timed out"
					}
				});
			}, timeoutMs);
			this.pendingInvokes.set(requestId, {
				nodeId: params.nodeId,
				command: params.command,
				resolve,
				reject,
				timer
			});
		});
	}
	handleInvokeResult(params) {
		const pending = this.pendingInvokes.get(params.id);
		if (!pending) return false;
		if (pending.nodeId !== params.nodeId) return false;
		clearTimeout(pending.timer);
		this.pendingInvokes.delete(params.id);
		pending.resolve({
			ok: params.ok,
			payload: params.payload,
			payloadJSON: params.payloadJSON ?? null,
			error: params.error ?? null
		});
		return true;
	}
	sendEvent(nodeId, event, payload) {
		const node = this.nodesById.get(nodeId);
		if (!node) return false;
		return this.sendEventToSession(node, event, payload);
	}
	sendEventInternal(node, event, payload) {
		try {
			node.client.socket.send(JSON.stringify({
				type: "event",
				event,
				payload
			}));
			return true;
		} catch {
			return false;
		}
	}
	sendEventToSession(node, event, payload) {
		return this.sendEventInternal(node, event, payload);
	}
};
//#endregion
//#region src/gateway/server-channels.ts
init_account_lookup();
init_session_key();
const CHANNEL_RESTART_POLICY = {
	initialMs: 5e3,
	maxMs: 5 * 6e4,
	factor: 2,
	jitter: .1
};
const MAX_RESTART_ATTEMPTS = 10;
function createRuntimeStore() {
	return {
		aborts: /* @__PURE__ */ new Map(),
		tasks: /* @__PURE__ */ new Map(),
		runtimes: /* @__PURE__ */ new Map()
	};
}
function isAccountEnabled(account) {
	if (!account || typeof account !== "object") return true;
	return account.enabled !== false;
}
function resolveDefaultRuntime(channelId) {
	return getChannelPlugin(channelId)?.status?.defaultRuntime ?? { accountId: "default" };
}
function cloneDefaultRuntime(channelId, accountId) {
	return {
		...resolveDefaultRuntime(channelId),
		accountId
	};
}
function createChannelManager(opts) {
	const { loadConfig, channelLogs, channelRuntimeEnvs, channelRuntime, resolveChannelRuntime } = opts;
	const channelStores = /* @__PURE__ */ new Map();
	const restartAttempts = /* @__PURE__ */ new Map();
	const manuallyStopped = /* @__PURE__ */ new Set();
	const restartKey = (channelId, accountId) => `${channelId}:${accountId}`;
	const resolveAccountHealthMonitorOverride = (channelConfig, accountId) => {
		if (!channelConfig?.accounts) return;
		const direct = resolveAccountEntry(channelConfig.accounts, accountId);
		if (typeof direct?.healthMonitor?.enabled === "boolean") return direct.healthMonitor.enabled;
		const normalizedAccountId = normalizeOptionalAccountId(accountId);
		if (!normalizedAccountId) return;
		const matchKey = Object.keys(channelConfig.accounts).find((key) => normalizeAccountId$1(key) === normalizedAccountId);
		if (!matchKey) return;
		return channelConfig.accounts[matchKey]?.healthMonitor?.enabled;
	};
	const isHealthMonitorEnabled = (channelId, accountId) => {
		const cfg = loadConfig();
		const channelConfig = cfg.channels?.[channelId];
		const accountOverride = resolveAccountHealthMonitorOverride(channelConfig, accountId);
		const channelOverride = channelConfig?.healthMonitor?.enabled;
		if (typeof accountOverride === "boolean") return accountOverride;
		if (typeof channelOverride === "boolean") return channelOverride;
		const plugin = getChannelPlugin(channelId);
		if (!plugin) return true;
		try {
			plugin.config.resolveAccount(cfg, accountId);
		} catch (err) {
			channelLogs[channelId].warn?.(`[${channelId}:${accountId}] health-monitor: failed to resolve account; skipping monitor (${formatErrorMessage(err)})`);
			return false;
		}
		return true;
	};
	const getStore = (channelId) => {
		const existing = channelStores.get(channelId);
		if (existing) return existing;
		const next = createRuntimeStore();
		channelStores.set(channelId, next);
		return next;
	};
	const getRuntime = (channelId, accountId) => {
		return getStore(channelId).runtimes.get(accountId) ?? cloneDefaultRuntime(channelId, accountId);
	};
	const setRuntime = (channelId, accountId, patch) => {
		const store = getStore(channelId);
		const next = {
			...getRuntime(channelId, accountId),
			...patch,
			accountId
		};
		store.runtimes.set(accountId, next);
		return next;
	};
	const getChannelRuntime = () => {
		return channelRuntime ?? resolveChannelRuntime?.();
	};
	const startChannelInternal = async (channelId, accountId, opts = {}) => {
		const plugin = getChannelPlugin(channelId);
		const startAccount = plugin?.gateway?.startAccount;
		if (!startAccount) return;
		const { preserveRestartAttempts = false, preserveManualStop = false } = opts;
		const cfg = loadConfig();
		resetDirectoryCache({
			channel: channelId,
			accountId
		});
		const store = getStore(channelId);
		const accountIds = accountId ? [accountId] : plugin.config.listAccountIds(cfg);
		if (accountIds.length === 0) return;
		await Promise.all(accountIds.map(async (id) => {
			if (store.tasks.has(id)) return;
			const account = plugin.config.resolveAccount(cfg, id);
			if (!(plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : isAccountEnabled(account))) {
				setRuntime(channelId, id, {
					accountId: id,
					enabled: false,
					configured: true,
					running: false,
					restartPending: false,
					lastError: plugin.config.disabledReason?.(account, cfg) ?? "disabled"
				});
				return;
			}
			let configured = true;
			if (plugin.config.isConfigured) configured = await plugin.config.isConfigured(account, cfg);
			if (!configured) {
				setRuntime(channelId, id, {
					accountId: id,
					enabled: true,
					configured: false,
					running: false,
					restartPending: false,
					lastError: plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured"
				});
				return;
			}
			const rKey = restartKey(channelId, id);
			if (!preserveManualStop) manuallyStopped.delete(rKey);
			const abort = new AbortController();
			store.aborts.set(id, abort);
			if (!preserveRestartAttempts) restartAttempts.delete(rKey);
			setRuntime(channelId, id, {
				accountId: id,
				enabled: true,
				configured: true,
				running: true,
				restartPending: false,
				lastStartAt: Date.now(),
				lastError: null,
				reconnectAttempts: preserveRestartAttempts ? restartAttempts.get(rKey) ?? 0 : 0
			});
			const log = channelLogs[channelId];
			const resolvedChannelRuntime = getChannelRuntime();
			const task = startAccount({
				cfg,
				accountId: id,
				account,
				runtime: channelRuntimeEnvs[channelId],
				abortSignal: abort.signal,
				log,
				getStatus: () => getRuntime(channelId, id),
				setStatus: (next) => setRuntime(channelId, id, next),
				...resolvedChannelRuntime ? { channelRuntime: resolvedChannelRuntime } : {}
			});
			const trackedPromise = Promise.resolve(task).catch((err) => {
				const message = formatErrorMessage(err);
				setRuntime(channelId, id, {
					accountId: id,
					lastError: message
				});
				log.error?.(`[${id}] channel exited: ${message}`);
			}).finally(() => {
				setRuntime(channelId, id, {
					accountId: id,
					running: false,
					lastStopAt: Date.now()
				});
			}).then(async () => {
				if (manuallyStopped.has(rKey)) return;
				const attempt = (restartAttempts.get(rKey) ?? 0) + 1;
				restartAttempts.set(rKey, attempt);
				if (attempt > MAX_RESTART_ATTEMPTS) {
					setRuntime(channelId, id, {
						accountId: id,
						restartPending: false,
						reconnectAttempts: attempt
					});
					log.error?.(`[${id}] giving up after ${MAX_RESTART_ATTEMPTS} restart attempts`);
					return;
				}
				const delayMs = computeBackoff(CHANNEL_RESTART_POLICY, attempt);
				log.info?.(`[${id}] auto-restart attempt ${attempt}/${MAX_RESTART_ATTEMPTS} in ${Math.round(delayMs / 1e3)}s`);
				setRuntime(channelId, id, {
					accountId: id,
					restartPending: true,
					reconnectAttempts: attempt
				});
				try {
					await sleepWithAbort(delayMs, abort.signal);
					if (manuallyStopped.has(rKey)) return;
					if (store.tasks.get(id) === trackedPromise) store.tasks.delete(id);
					if (store.aborts.get(id) === abort) store.aborts.delete(id);
					await startChannelInternal(channelId, id, {
						preserveRestartAttempts: true,
						preserveManualStop: true
					});
				} catch {}
			}).finally(() => {
				if (store.tasks.get(id) === trackedPromise) store.tasks.delete(id);
				if (store.aborts.get(id) === abort) store.aborts.delete(id);
			});
			store.tasks.set(id, trackedPromise);
		}));
	};
	const startChannel = async (channelId, accountId) => {
		await startChannelInternal(channelId, accountId);
	};
	const stopChannel = async (channelId, accountId) => {
		const plugin = getChannelPlugin(channelId);
		const store = getStore(channelId);
		if (!plugin?.gateway?.stopAccount && store.aborts.size === 0 && store.tasks.size === 0) return;
		const cfg = loadConfig();
		const knownIds = new Set([
			...store.aborts.keys(),
			...store.tasks.keys(),
			...plugin ? plugin.config.listAccountIds(cfg) : []
		]);
		if (accountId) {
			knownIds.clear();
			knownIds.add(accountId);
		}
		await Promise.all(Array.from(knownIds.values()).map(async (id) => {
			const abort = store.aborts.get(id);
			const task = store.tasks.get(id);
			if (!abort && !task && !plugin?.gateway?.stopAccount) return;
			manuallyStopped.add(restartKey(channelId, id));
			abort?.abort();
			if (plugin?.gateway?.stopAccount) {
				const account = plugin.config.resolveAccount(cfg, id);
				await plugin.gateway.stopAccount({
					cfg,
					accountId: id,
					account,
					runtime: channelRuntimeEnvs[channelId],
					abortSignal: abort?.signal ?? new AbortController().signal,
					log: channelLogs[channelId],
					getStatus: () => getRuntime(channelId, id),
					setStatus: (next) => setRuntime(channelId, id, next)
				});
			}
			try {
				await task;
			} catch {}
			store.aborts.delete(id);
			store.tasks.delete(id);
			setRuntime(channelId, id, {
				accountId: id,
				running: false,
				restartPending: false,
				lastStopAt: Date.now()
			});
		}));
	};
	const startChannels = async () => {
		for (const plugin of listChannelPlugins()) await startChannel(plugin.id);
	};
	const markChannelLoggedOut = (channelId, cleared, accountId) => {
		const plugin = getChannelPlugin(channelId);
		if (!plugin) return;
		const cfg = loadConfig();
		const resolvedId = accountId ?? resolveChannelDefaultAccountId({
			plugin,
			cfg
		});
		const current = getRuntime(channelId, resolvedId);
		const next = {
			accountId: resolvedId,
			running: false,
			restartPending: false,
			lastError: cleared ? "logged out" : current.lastError
		};
		if (typeof current.connected === "boolean") next.connected = false;
		setRuntime(channelId, resolvedId, next);
	};
	const getRuntimeSnapshot = () => {
		const cfg = loadConfig();
		const channels = {};
		const channelAccounts = {};
		for (const plugin of listChannelPlugins()) {
			const store = getStore(plugin.id);
			const accountIds = plugin.config.listAccountIds(cfg);
			const defaultAccountId = resolveChannelDefaultAccountId({
				plugin,
				cfg,
				accountIds
			});
			const accounts = {};
			for (const id of accountIds) {
				const account = plugin.config.resolveAccount(cfg, id);
				const enabled = plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : isAccountEnabled(account);
				const configured = (plugin.config.describeAccount?.(account, cfg))?.configured;
				const next = {
					...store.runtimes.get(id) ?? cloneDefaultRuntime(plugin.id, id),
					accountId: id
				};
				next.enabled = enabled;
				next.configured = typeof configured === "boolean" ? configured : next.configured ?? true;
				if (!next.running) {
					if (!enabled) next.lastError ??= plugin.config.disabledReason?.(account, cfg) ?? "disabled";
					else if (configured === false) next.lastError ??= plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured";
				}
				accounts[id] = next;
			}
			const defaultAccount = accounts[defaultAccountId] ?? cloneDefaultRuntime(plugin.id, defaultAccountId);
			channels[plugin.id] = defaultAccount;
			channelAccounts[plugin.id] = accounts;
		}
		return {
			channels,
			channelAccounts
		};
	};
	const isManuallyStopped_ = (channelId, accountId) => {
		return manuallyStopped.has(restartKey(channelId, accountId));
	};
	const resetRestartAttempts_ = (channelId, accountId) => {
		restartAttempts.delete(restartKey(channelId, accountId));
	};
	return {
		getRuntimeSnapshot,
		startChannels,
		startChannel,
		stopChannel,
		markChannelLoggedOut,
		isManuallyStopped: isManuallyStopped_,
		resetRestartAttempts: resetRestartAttempts_,
		isHealthMonitorEnabled
	};
}
//#endregion
//#region src/gateway/server-chat.ts
function resolveHeartbeatAckMaxChars$1() {
	try {
		const cfg = loadConfig();
		return Math.max(0, cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? 300);
	} catch {
		return 300;
	}
}
function resolveHeartbeatContext(runId, sourceRunId) {
	const primary = getAgentRunContext(runId);
	if (primary?.isHeartbeat) return primary;
	if (sourceRunId && sourceRunId !== runId) {
		const source = getAgentRunContext(sourceRunId);
		if (source?.isHeartbeat) return source;
	}
	return primary;
}
/**
* Check if heartbeat ACK/noise should be hidden from interactive chat surfaces.
*/
function shouldHideHeartbeatChatOutput(runId, sourceRunId) {
	if (!resolveHeartbeatContext(runId, sourceRunId)?.isHeartbeat) return false;
	try {
		return !resolveHeartbeatVisibility({
			cfg: loadConfig(),
			channel: "webchat"
		}).showOk;
	} catch {
		return true;
	}
}
function normalizeHeartbeatChatFinalText(params) {
	if (!shouldHideHeartbeatChatOutput(params.runId, params.sourceRunId)) return {
		suppress: false,
		text: params.text
	};
	const stripped = stripHeartbeatToken(params.text, {
		mode: "heartbeat",
		maxAckChars: resolveHeartbeatAckMaxChars$1()
	});
	if (!stripped.didStrip) return {
		suppress: false,
		text: params.text
	};
	if (stripped.shouldSkip) return {
		suppress: true,
		text: ""
	};
	return {
		suppress: false,
		text: stripped.text
	};
}
function isSilentReplyLeadFragment(text) {
	const normalized = text.trim().toUpperCase();
	if (!normalized) return false;
	if (!/^[A-Z_]+$/.test(normalized)) return false;
	if (normalized === "NO_REPLY") return false;
	return SILENT_REPLY_TOKEN.startsWith(normalized);
}
function appendUniqueSuffix(base, suffix) {
	if (!suffix) return base;
	if (!base) return suffix;
	if (base.endsWith(suffix)) return base;
	const maxOverlap = Math.min(base.length, suffix.length);
	for (let overlap = maxOverlap; overlap > 0; overlap -= 1) if (base.slice(-overlap) === suffix.slice(0, overlap)) return base + suffix.slice(overlap);
	return base + suffix;
}
function resolveMergedAssistantText(params) {
	const { previousText, nextText, nextDelta } = params;
	if (nextText && previousText) {
		if (nextText.startsWith(previousText)) return nextText;
		if (previousText.startsWith(nextText) && !nextDelta) return previousText;
	}
	if (nextDelta) return appendUniqueSuffix(previousText, nextDelta);
	if (nextText) return nextText;
	return previousText;
}
function createChatRunRegistry() {
	const chatRunSessions = /* @__PURE__ */ new Map();
	const add = (sessionId, entry) => {
		const queue = chatRunSessions.get(sessionId);
		if (queue) queue.push(entry);
		else chatRunSessions.set(sessionId, [entry]);
	};
	const peek = (sessionId) => chatRunSessions.get(sessionId)?.[0];
	const shift = (sessionId) => {
		const queue = chatRunSessions.get(sessionId);
		if (!queue || queue.length === 0) return;
		const entry = queue.shift();
		if (!queue.length) chatRunSessions.delete(sessionId);
		return entry;
	};
	const remove = (sessionId, clientRunId, sessionKey) => {
		const queue = chatRunSessions.get(sessionId);
		if (!queue || queue.length === 0) return;
		const idx = queue.findIndex((entry) => entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true));
		if (idx < 0) return;
		const [entry] = queue.splice(idx, 1);
		if (!queue.length) chatRunSessions.delete(sessionId);
		return entry;
	};
	const clear = () => {
		chatRunSessions.clear();
	};
	return {
		add,
		peek,
		shift,
		remove,
		clear
	};
}
function createChatRunState() {
	const registry = createChatRunRegistry();
	const buffers = /* @__PURE__ */ new Map();
	const deltaSentAt = /* @__PURE__ */ new Map();
	const deltaLastBroadcastLen = /* @__PURE__ */ new Map();
	const abortedRuns = /* @__PURE__ */ new Map();
	const clear = () => {
		registry.clear();
		buffers.clear();
		deltaSentAt.clear();
		deltaLastBroadcastLen.clear();
		abortedRuns.clear();
	};
	return {
		registry,
		buffers,
		deltaSentAt,
		deltaLastBroadcastLen,
		abortedRuns,
		clear
	};
}
const TOOL_EVENT_RECIPIENT_TTL_MS = 600 * 1e3;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1e3;
function createToolEventRecipientRegistry() {
	const recipients = /* @__PURE__ */ new Map();
	const prune = () => {
		if (recipients.size === 0) return;
		const now = Date.now();
		for (const [runId, entry] of recipients) if (now >= (entry.finalizedAt ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS)) recipients.delete(runId);
	};
	const add = (runId, connId) => {
		if (!runId || !connId) return;
		const now = Date.now();
		const existing = recipients.get(runId);
		if (existing) {
			existing.connIds.add(connId);
			existing.updatedAt = now;
		} else recipients.set(runId, {
			connIds: new Set([connId]),
			updatedAt: now
		});
		prune();
	};
	const get = (runId) => {
		const entry = recipients.get(runId);
		if (!entry) return;
		entry.updatedAt = Date.now();
		prune();
		return entry.connIds;
	};
	const markFinal = (runId) => {
		const entry = recipients.get(runId);
		if (!entry) return;
		entry.finalizedAt = Date.now();
		prune();
	};
	return {
		add,
		get,
		markFinal
	};
}
function createAgentEventHandler({ broadcast, broadcastToConnIds, nodeSendToSession, agentRunSeq, chatRunState, resolveSessionKeyForRun, clearAgentRunContext, toolEventRecipients }) {
	const emitChatDelta = (sessionKey, clientRunId, sourceRunId, seq, text, delta) => {
		const cleanedText = stripInlineDirectiveTagsForDisplay(text).text;
		const cleanedDelta = typeof delta === "string" ? stripInlineDirectiveTagsForDisplay(delta).text : "";
		const mergedText = resolveMergedAssistantText({
			previousText: chatRunState.buffers.get(clientRunId) ?? "",
			nextText: cleanedText,
			nextDelta: cleanedDelta
		});
		if (!mergedText) return;
		chatRunState.buffers.set(clientRunId, mergedText);
		if (isSilentReplyText(mergedText, "NO_REPLY")) return;
		if (isSilentReplyLeadFragment(mergedText)) return;
		if (shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) return;
		const now = Date.now();
		if (now - (chatRunState.deltaSentAt.get(clientRunId) ?? 0) < 150) return;
		chatRunState.deltaSentAt.set(clientRunId, now);
		chatRunState.deltaLastBroadcastLen.set(clientRunId, mergedText.length);
		const payload = {
			runId: clientRunId,
			sessionKey,
			seq,
			state: "delta",
			message: {
				role: "assistant",
				content: [{
					type: "text",
					text: mergedText
				}],
				timestamp: now
			}
		};
		broadcast("chat", payload, { dropIfSlow: true });
		nodeSendToSession(sessionKey, "chat", payload);
	};
	const resolveBufferedChatTextState = (clientRunId, sourceRunId) => {
		const normalizedHeartbeatText = normalizeHeartbeatChatFinalText({
			runId: clientRunId,
			sourceRunId,
			text: stripInlineDirectiveTagsForDisplay(chatRunState.buffers.get(clientRunId) ?? "").text.trim()
		});
		const text = normalizedHeartbeatText.text.trim();
		return {
			text,
			shouldSuppressSilent: normalizedHeartbeatText.suppress || isSilentReplyText(text, "NO_REPLY")
		};
	};
	const flushBufferedChatDeltaIfNeeded = (sessionKey, clientRunId, sourceRunId, seq) => {
		const { text, shouldSuppressSilent } = resolveBufferedChatTextState(clientRunId, sourceRunId);
		const shouldSuppressSilentLeadFragment = isSilentReplyLeadFragment(text);
		const shouldSuppressHeartbeatStreaming = shouldHideHeartbeatChatOutput(clientRunId, sourceRunId);
		if (!text || shouldSuppressSilent || shouldSuppressSilentLeadFragment || shouldSuppressHeartbeatStreaming) return;
		const lastBroadcastLen = chatRunState.deltaLastBroadcastLen.get(clientRunId) ?? 0;
		if (text.length <= lastBroadcastLen) return;
		const now = Date.now();
		const flushPayload = {
			runId: clientRunId,
			sessionKey,
			seq,
			state: "delta",
			message: {
				role: "assistant",
				content: [{
					type: "text",
					text
				}],
				timestamp: now
			}
		};
		broadcast("chat", flushPayload, { dropIfSlow: true });
		nodeSendToSession(sessionKey, "chat", flushPayload);
		chatRunState.deltaLastBroadcastLen.set(clientRunId, text.length);
		chatRunState.deltaSentAt.set(clientRunId, now);
	};
	const emitChatFinal = (sessionKey, clientRunId, sourceRunId, seq, jobState, error, stopReason) => {
		const { text, shouldSuppressSilent } = resolveBufferedChatTextState(clientRunId, sourceRunId);
		flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, sourceRunId, seq);
		chatRunState.deltaLastBroadcastLen.delete(clientRunId);
		chatRunState.buffers.delete(clientRunId);
		chatRunState.deltaSentAt.delete(clientRunId);
		if (jobState === "done") {
			const payload = {
				runId: clientRunId,
				sessionKey,
				seq,
				state: "final",
				...stopReason && { stopReason },
				message: text && !shouldSuppressSilent ? {
					role: "assistant",
					content: [{
						type: "text",
						text
					}],
					timestamp: Date.now()
				} : void 0
			};
			broadcast("chat", payload);
			nodeSendToSession(sessionKey, "chat", payload);
			return;
		}
		const payload = {
			runId: clientRunId,
			sessionKey,
			seq,
			state: "error",
			errorMessage: error ? formatForLog(error) : void 0
		};
		broadcast("chat", payload);
		nodeSendToSession(sessionKey, "chat", payload);
	};
	const resolveToolVerboseLevel = (runId, sessionKey) => {
		const runVerbose = normalizeVerboseLevel(getAgentRunContext(runId)?.verboseLevel);
		if (runVerbose) return runVerbose;
		if (!sessionKey) return "off";
		try {
			const { cfg, entry } = loadSessionEntry(sessionKey);
			const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
			if (sessionVerbose) return sessionVerbose;
			return normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault) ?? "off";
		} catch {
			return "off";
		}
	};
	return (evt) => {
		const chatLink = chatRunState.registry.peek(evt.runId);
		const eventSessionKey = typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : void 0;
		const isControlUiVisible = getAgentRunContext(evt.runId)?.isControlUiVisible ?? true;
		const sessionKey = chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
		const clientRunId = chatLink?.clientRunId ?? evt.runId;
		const eventRunId = chatLink?.clientRunId ?? evt.runId;
		const eventForClients = chatLink ? {
			...evt,
			runId: eventRunId
		} : evt;
		const isAborted = chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
		const agentPayload = sessionKey ? {
			...eventForClients,
			sessionKey
		} : eventForClients;
		const last = agentRunSeq.get(evt.runId) ?? 0;
		const isToolEvent = evt.stream === "tool";
		const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
		const toolPayload = isToolEvent && toolVerbose !== "full" ? (() => {
			const data = evt.data ? { ...evt.data } : {};
			delete data.result;
			delete data.partialResult;
			return sessionKey ? {
				...eventForClients,
				sessionKey,
				data
			} : {
				...eventForClients,
				data
			};
		})() : agentPayload;
		if (evt.seq !== last + 1) broadcast("agent", {
			runId: eventRunId,
			stream: "error",
			ts: Date.now(),
			sessionKey,
			data: {
				reason: "seq gap",
				expected: last + 1,
				received: evt.seq
			}
		});
		agentRunSeq.set(evt.runId, evt.seq);
		if (isToolEvent) {
			if ((typeof evt.data?.phase === "string" ? evt.data.phase : "") === "start" && isControlUiVisible && sessionKey && !isAborted) flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, evt.runId, evt.seq);
			const recipients = toolEventRecipients.get(evt.runId);
			if (recipients && recipients.size > 0) broadcastToConnIds("agent", toolPayload, recipients);
		} else broadcast("agent", agentPayload);
		const lifecyclePhase = evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
		if (isControlUiVisible && sessionKey) {
			if (!isToolEvent || toolVerbose !== "off") nodeSendToSession(sessionKey, "agent", isToolEvent ? toolPayload : agentPayload);
			if (!isAborted && evt.stream === "assistant" && typeof evt.data?.text === "string") emitChatDelta(sessionKey, clientRunId, evt.runId, evt.seq, evt.data.text, evt.data.delta);
			else if (!isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
				const evtStopReason = typeof evt.data?.stopReason === "string" ? evt.data.stopReason : void 0;
				if (chatLink) {
					const finished = chatRunState.registry.shift(evt.runId);
					if (!finished) {
						clearAgentRunContext(evt.runId);
						return;
					}
					emitChatFinal(finished.sessionKey, finished.clientRunId, evt.runId, evt.seq, lifecyclePhase === "error" ? "error" : "done", evt.data?.error, evtStopReason);
				} else emitChatFinal(sessionKey, eventRunId, evt.runId, evt.seq, lifecyclePhase === "error" ? "error" : "done", evt.data?.error, evtStopReason);
			} else if (isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
				chatRunState.abortedRuns.delete(clientRunId);
				chatRunState.abortedRuns.delete(evt.runId);
				chatRunState.buffers.delete(clientRunId);
				chatRunState.deltaSentAt.delete(clientRunId);
				if (chatLink) chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
			}
		}
		if (lifecyclePhase === "end" || lifecyclePhase === "error") {
			toolEventRecipients.markFinal(evt.runId);
			clearAgentRunContext(evt.runId);
			agentRunSeq.delete(evt.runId);
			agentRunSeq.delete(clientRunId);
		}
	};
}
//#endregion
//#region src/hooks/gmail-watcher.ts
/**
* Gmail Watcher Service
*
* Automatically starts `gog gmail watch serve` when the gateway starts,
* if hooks.gmail is configured with an account.
*/
init_subsystem();
const log$3 = createSubsystemLogger("gmail-watcher");
const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;
function isAddressInUseError(line) {
	return ADDRESS_IN_USE_RE.test(line);
}
let watcherProcess = null;
let renewInterval = null;
let shuttingDown = false;
let currentConfig = null;
/**
* Check if gog binary is available
*/
function isGogAvailable() {
	return hasBinary("gog");
}
/**
* Start the Gmail watch (registers with Gmail API)
*/
async function startGmailWatch(cfg) {
	const args = ["gog", ...buildGogWatchStartArgs(cfg)];
	try {
		const result = await runCommandWithTimeout(args, { timeoutMs: 12e4 });
		if (result.code !== 0) {
			const message = result.stderr || result.stdout || "gog watch start failed";
			log$3.error(`watch start failed: ${message}`);
			return false;
		}
		log$3.info(`watch started for ${cfg.account}`);
		return true;
	} catch (err) {
		log$3.error(`watch start error: ${String(err)}`);
		return false;
	}
}
/**
* Spawn the gog gmail watch serve process
*/
function spawnGogServe(cfg) {
	const args = buildGogWatchServeArgs(cfg);
	log$3.info(`starting gog ${args.join(" ")}`);
	let addressInUse = false;
	const child = spawn("gog", args, {
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		detached: false
	});
	child.stdout?.on("data", (data) => {
		const line = data.toString().trim();
		if (line) log$3.info(`[gog] ${line}`);
	});
	child.stderr?.on("data", (data) => {
		const line = data.toString().trim();
		if (!line) return;
		if (isAddressInUseError(line)) addressInUse = true;
		log$3.warn(`[gog] ${line}`);
	});
	child.on("error", (err) => {
		log$3.error(`gog process error: ${String(err)}`);
	});
	child.on("exit", (code, signal) => {
		if (shuttingDown) return;
		if (addressInUse) {
			log$3.warn("gog serve failed to bind (address already in use); stopping restarts. Another watcher is likely running. Set OPENCLAW_SKIP_GMAIL_WATCHER=1 or stop the other process.");
			watcherProcess = null;
			return;
		}
		log$3.warn(`gog exited (code=${code}, signal=${signal}); restarting in 5s`);
		watcherProcess = null;
		setTimeout(() => {
			if (shuttingDown || !currentConfig) return;
			watcherProcess = spawnGogServe(currentConfig);
		}, 5e3);
	});
	return child;
}
/**
* Start the Gmail watcher service.
* Called automatically by the gateway if hooks.gmail is configured.
*/
async function startGmailWatcher(cfg) {
	if (!cfg.hooks?.enabled) return {
		started: false,
		reason: "hooks not enabled"
	};
	if (!cfg.hooks?.gmail?.account) return {
		started: false,
		reason: "no gmail account configured"
	};
	if (!isGogAvailable()) return {
		started: false,
		reason: "gog binary not found"
	};
	const resolved = resolveGmailHookRuntimeConfig(cfg, {});
	if (!resolved.ok) return {
		started: false,
		reason: resolved.error
	};
	const runtimeConfig = resolved.value;
	currentConfig = runtimeConfig;
	if (runtimeConfig.tailscale.mode !== "off") try {
		await ensureTailscaleEndpoint({
			mode: runtimeConfig.tailscale.mode,
			path: runtimeConfig.tailscale.path,
			port: runtimeConfig.serve.port,
			target: runtimeConfig.tailscale.target
		});
		log$3.info(`tailscale ${runtimeConfig.tailscale.mode} configured for port ${runtimeConfig.serve.port}`);
	} catch (err) {
		log$3.error(`tailscale setup failed: ${String(err)}`);
		return {
			started: false,
			reason: `tailscale setup failed: ${String(err)}`
		};
	}
	if (!await startGmailWatch(runtimeConfig)) log$3.warn("gmail watch start failed, but continuing with serve");
	shuttingDown = false;
	watcherProcess = spawnGogServe(runtimeConfig);
	const renewMs = runtimeConfig.renewEveryMinutes * 6e4;
	renewInterval = setInterval(() => {
		if (shuttingDown) return;
		startGmailWatch(runtimeConfig);
	}, renewMs);
	log$3.info(`gmail watcher started for ${runtimeConfig.account} (renew every ${runtimeConfig.renewEveryMinutes}m)`);
	return { started: true };
}
/**
* Stop the Gmail watcher service.
*/
async function stopGmailWatcher() {
	shuttingDown = true;
	if (renewInterval) {
		clearInterval(renewInterval);
		renewInterval = null;
	}
	if (watcherProcess) {
		log$3.info("stopping gmail watcher");
		watcherProcess.kill("SIGTERM");
		await new Promise((resolve) => {
			const timeout = setTimeout(() => {
				if (watcherProcess) watcherProcess.kill("SIGKILL");
				resolve();
			}, 3e3);
			watcherProcess?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
		watcherProcess = null;
	}
	currentConfig = null;
	log$3.info("gmail watcher stopped");
}
//#endregion
//#region src/gateway/server-close.ts
function createGatewayCloseHandler(params) {
	return async (opts) => {
		try {
			const reason = (typeof opts?.reason === "string" ? opts.reason.trim() : "") || "gateway stopping";
			const restartExpectedMs = typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs) ? Math.max(0, Math.floor(opts.restartExpectedMs)) : null;
			if (params.bonjourStop) try {
				await params.bonjourStop();
			} catch {}
			if (params.tailscaleCleanup) await params.tailscaleCleanup();
			if (params.canvasHost) try {
				await params.canvasHost.close();
			} catch {}
			if (params.canvasHostServer) try {
				await params.canvasHostServer.close();
			} catch {}
			for (const plugin of listChannelPlugins()) await params.stopChannel(plugin.id);
			if (params.pluginServices) await params.pluginServices.stop().catch(() => {});
			await stopGmailWatcher();
			params.cron.stop();
			params.heartbeatRunner.stop();
			try {
				params.updateCheckStop?.();
			} catch {}
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
			if (params.agentUnsub) try {
				params.agentUnsub();
			} catch {}
			if (params.heartbeatUnsub) try {
				params.heartbeatUnsub();
			} catch {}
			params.chatRunState.clear();
			for (const c of params.clients) try {
				c.socket.close(1012, "service restart");
			} catch {}
			params.clients.clear();
			await params.configReloader.stop().catch(() => {});
			if (params.browserControl) await params.browserControl.stop().catch(() => {});
			await new Promise((resolve) => params.wss.close(() => resolve()));
			const servers = params.httpServers && params.httpServers.length > 0 ? params.httpServers : [params.httpServer];
			for (const server of servers) {
				const httpServer = server;
				if (typeof httpServer.closeIdleConnections === "function") httpServer.closeIdleConnections();
				await new Promise((resolve, reject) => httpServer.close((err) => err ? reject(err) : resolve()));
			}
		} finally {
			try {
				params.releasePluginRouteRegistry?.();
			} catch {}
		}
	};
}
//#endregion
//#region src/cron/isolated-agent/delivery-target.ts
init_session_key();
async function resolveDeliveryTarget(cfg, agentId, jobPayload) {
	const requestedChannel = typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
	const explicitTo = typeof jobPayload.to === "string" ? jobPayload.to : void 0;
	const allowMismatchedLastTo = requestedChannel === "last";
	const sessionCfg = cfg.session;
	const mainSessionKey = resolveAgentMainSessionKey({
		cfg,
		agentId
	});
	const store = loadSessionStore(resolveStorePath(sessionCfg?.store, { agentId }));
	const threadSessionKey = jobPayload.sessionKey?.trim();
	const main = (threadSessionKey ? store[threadSessionKey] : void 0) ?? store[mainSessionKey];
	const preliminary = resolveSessionDeliveryTarget({
		entry: main,
		requestedChannel,
		explicitTo,
		allowMismatchedLastTo
	});
	let fallbackChannel;
	let channelResolutionError;
	if (!preliminary.channel) if (preliminary.lastChannel) fallbackChannel = preliminary.lastChannel;
	else try {
		fallbackChannel = (await resolveMessageChannelSelection({ cfg })).channel;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		channelResolutionError = /* @__PURE__ */ new Error(`${detail} Set delivery.channel explicitly or use a main session with a previous channel.`);
	}
	const resolved = fallbackChannel ? resolveSessionDeliveryTarget({
		entry: main,
		requestedChannel,
		explicitTo,
		fallbackChannel,
		allowMismatchedLastTo,
		mode: preliminary.mode
	}) : preliminary;
	const channel = resolved.channel ?? fallbackChannel;
	const mode = resolved.mode;
	let toCandidate = resolved.to;
	let accountId = (typeof jobPayload.accountId === "string" && jobPayload.accountId.trim() ? jobPayload.accountId.trim() : void 0) ?? resolved.accountId;
	if (!accountId && channel) {
		const boundAccounts = buildChannelAccountBindings(cfg).get(channel)?.get(normalizeAgentId(agentId));
		if (boundAccounts && boundAccounts.length > 0) accountId = boundAccounts[0];
	}
	if (jobPayload.accountId) accountId = jobPayload.accountId;
	const threadId = resolved.threadId && (resolved.threadIdExplicit || resolved.to && resolved.to === resolved.lastTo) ? resolved.threadId : void 0;
	if (!channel) return {
		ok: false,
		channel: void 0,
		to: void 0,
		accountId,
		threadId,
		mode,
		error: channelResolutionError ?? /* @__PURE__ */ new Error("Channel is required when delivery.channel=last has no previous channel.")
	};
	let allowFromOverride;
	if (channel === "whatsapp") {
		const resolvedAccountId = normalizeAccountId$1(accountId);
		const configuredAllowFrom = (resolveWhatsAppAccount({
			cfg,
			accountId: resolvedAccountId
		}).allowFrom ?? []).map((entry) => String(entry).trim()).filter((entry) => entry && entry !== "*").map((entry) => normalizeWhatsAppTarget(entry)).filter((entry) => Boolean(entry));
		const storeAllowFrom = readChannelAllowFromStoreSync("whatsapp", process.env, resolvedAccountId).map((entry) => normalizeWhatsAppTarget(entry)).filter((entry) => Boolean(entry));
		allowFromOverride = [...new Set([...configuredAllowFrom, ...storeAllowFrom])];
		if (toCandidate && mode === "implicit" && allowFromOverride.length > 0) {
			const normalizedCurrentTarget = normalizeWhatsAppTarget(toCandidate);
			if (!normalizedCurrentTarget || !allowFromOverride.includes(normalizedCurrentTarget)) toCandidate = allowFromOverride[0];
		}
	}
	const docked = resolveOutboundTarget({
		channel,
		to: toCandidate,
		cfg,
		accountId,
		mode,
		allowFrom: allowFromOverride
	});
	if (!docked.ok) return {
		ok: false,
		channel,
		to: void 0,
		accountId,
		threadId,
		mode,
		error: docked.error
	};
	return {
		ok: true,
		channel,
		to: (await maybeResolveIdLikeTarget({
			cfg,
			channel,
			input: docked.to,
			accountId
		}))?.to ?? docked.to,
		accountId,
		threadId,
		mode
	};
}
//#endregion
//#region src/cron/delivery.ts
function normalizeChannel(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return;
	return trimmed;
}
function normalizeTo$1(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function normalizeAccountId(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function resolveCronDeliveryPlan(job) {
	const payload = job.payload.kind === "agentTurn" ? job.payload : null;
	const delivery = job.delivery;
	const hasDelivery = delivery && typeof delivery === "object";
	const rawMode = hasDelivery ? delivery.mode : void 0;
	const normalizedMode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : rawMode;
	const mode = normalizedMode === "announce" ? "announce" : normalizedMode === "webhook" ? "webhook" : normalizedMode === "none" ? "none" : normalizedMode === "deliver" ? "announce" : void 0;
	const payloadChannel = normalizeChannel(payload?.channel);
	const payloadTo = normalizeTo$1(payload?.to);
	const deliveryChannel = normalizeChannel(delivery?.channel);
	const deliveryTo = normalizeTo$1(delivery?.to);
	const channel = deliveryChannel ?? payloadChannel ?? "last";
	const to = deliveryTo ?? payloadTo;
	const deliveryAccountId = normalizeAccountId(delivery?.accountId);
	if (hasDelivery) {
		const resolvedMode = mode ?? "announce";
		return {
			mode: resolvedMode,
			channel: resolvedMode === "announce" ? channel : void 0,
			to,
			accountId: deliveryAccountId,
			source: "delivery",
			requested: resolvedMode === "announce"
		};
	}
	const legacyMode = payload?.deliver === true ? "explicit" : payload?.deliver === false ? "off" : "auto";
	const requested = legacyMode === "explicit" || legacyMode === "auto" && Boolean(to);
	return {
		mode: requested ? "announce" : "none",
		channel,
		to,
		source: "payload",
		requested
	};
}
function normalizeFailureMode(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim().toLowerCase();
	if (trimmed === "announce" || trimmed === "webhook") return trimmed;
}
function resolveFailureDestination(job, globalConfig) {
	const delivery = job.delivery;
	const jobFailureDest = delivery?.failureDestination;
	const hasJobFailureDest = jobFailureDest && typeof jobFailureDest === "object";
	let channel;
	let to;
	let accountId;
	let mode;
	if (globalConfig) {
		channel = normalizeChannel(globalConfig.channel);
		to = normalizeTo$1(globalConfig.to);
		accountId = normalizeAccountId(globalConfig.accountId);
		mode = normalizeFailureMode(globalConfig.mode);
	}
	if (hasJobFailureDest) {
		const jobChannel = normalizeChannel(jobFailureDest.channel);
		const jobTo = normalizeTo$1(jobFailureDest.to);
		const jobAccountId = normalizeAccountId(jobFailureDest.accountId);
		const jobMode = normalizeFailureMode(jobFailureDest.mode);
		const hasJobChannelField = "channel" in jobFailureDest;
		const hasJobToField = "to" in jobFailureDest;
		const hasJobAccountIdField = "accountId" in jobFailureDest;
		const jobToExplicitValue = hasJobToField && jobTo !== void 0;
		if (hasJobChannelField) channel = jobChannel;
		if (hasJobToField) to = jobTo;
		if (hasJobAccountIdField) accountId = jobAccountId;
		if (jobMode !== void 0) {
			const globalMode = globalConfig?.mode ?? "announce";
			if (!jobToExplicitValue && globalMode !== jobMode) to = void 0;
			mode = jobMode;
		}
	}
	if (!channel && !to && !accountId && !mode) return null;
	const resolvedMode = mode ?? "announce";
	if (resolvedMode === "webhook" && !to) return null;
	const result = {
		mode: resolvedMode,
		channel: resolvedMode === "announce" ? channel ?? "last" : void 0,
		to,
		accountId
	};
	if (delivery && isSameDeliveryTarget(delivery, result)) return null;
	return result;
}
function isSameDeliveryTarget(delivery, failurePlan) {
	const primaryMode = delivery.mode ?? "announce";
	if (primaryMode === "none") return false;
	const primaryChannel = delivery.channel;
	const primaryTo = delivery.to;
	const primaryAccountId = delivery.accountId;
	if (failurePlan.mode === "webhook") return primaryMode === "webhook" && primaryTo === failurePlan.to;
	const primaryChannelNormalized = primaryChannel ?? "last";
	return (failurePlan.channel ?? "last") === primaryChannelNormalized && failurePlan.to === primaryTo && failurePlan.accountId === primaryAccountId;
}
const FAILURE_NOTIFICATION_TIMEOUT_MS = 3e4;
const cronDeliveryLogger = getChildLogger({ subsystem: "cron-delivery" });
async function sendFailureNotificationAnnounce(deps, cfg, agentId, jobId, target, message) {
	const resolvedTarget = await resolveDeliveryTarget(cfg, agentId, {
		channel: target.channel,
		to: target.to,
		accountId: target.accountId
	});
	if (!resolvedTarget.ok) {
		cronDeliveryLogger.warn({ error: resolvedTarget.error.message }, "cron: failed to resolve failure destination target");
		return;
	}
	const identity = resolveAgentOutboundIdentity(cfg, agentId);
	const session = buildOutboundSessionContext({
		cfg,
		agentId,
		sessionKey: `cron:${jobId}:failure`
	});
	const abortController = new AbortController();
	const timeout = setTimeout(() => {
		abortController.abort();
	}, FAILURE_NOTIFICATION_TIMEOUT_MS);
	try {
		await deliverOutboundPayloads({
			cfg,
			channel: resolvedTarget.channel,
			to: resolvedTarget.to,
			accountId: resolvedTarget.accountId,
			threadId: resolvedTarget.threadId,
			payloads: [{ text: message }],
			session,
			identity,
			bestEffort: false,
			deps: createOutboundSendDeps$1(deps),
			abortSignal: abortController.signal
		});
	} catch (err) {
		cronDeliveryLogger.warn({
			err: formatErrorMessage(err),
			channel: resolvedTarget.channel,
			to: resolvedTarget.to
		}, "cron: failure destination announce failed");
	} finally {
		clearTimeout(timeout);
	}
}
//#endregion
//#region src/cron/heartbeat-policy.ts
function shouldSkipHeartbeatOnlyDelivery(payloads, ackMaxChars) {
	if (payloads.length === 0) return true;
	if (payloads.some((payload) => (payload.mediaUrls?.length ?? 0) > 0 || Boolean(payload.mediaUrl))) return false;
	return payloads.some((payload) => {
		return stripHeartbeatToken(payload.text, {
			mode: "heartbeat",
			maxAckChars: ackMaxChars
		}).shouldSkip;
	});
}
//#endregion
//#region src/cron/isolated-agent/helpers.ts
init_utils();
function pickSummaryFromOutput(text) {
	const clean = (text ?? "").trim();
	if (!clean) return;
	const limit = 2e3;
	return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}
function pickSummaryFromPayloads(payloads) {
	for (let i = payloads.length - 1; i >= 0; i--) {
		if (payloads[i]?.isError) continue;
		const summary = pickSummaryFromOutput(payloads[i]?.text);
		if (summary) return summary;
	}
	for (let i = payloads.length - 1; i >= 0; i--) {
		const summary = pickSummaryFromOutput(payloads[i]?.text);
		if (summary) return summary;
	}
}
function pickLastNonEmptyTextFromPayloads(payloads) {
	for (let i = payloads.length - 1; i >= 0; i--) {
		if (payloads[i]?.isError) continue;
		const clean = (payloads[i]?.text ?? "").trim();
		if (clean) return clean;
	}
	for (let i = payloads.length - 1; i >= 0; i--) {
		const clean = (payloads[i]?.text ?? "").trim();
		if (clean) return clean;
	}
}
function pickLastDeliverablePayload(payloads) {
	const isDeliverable = (p) => {
		const text = (p?.text ?? "").trim();
		const hasMedia = Boolean(p?.mediaUrl) || (p?.mediaUrls?.length ?? 0) > 0;
		const hasInteractive = (p?.interactive?.blocks?.length ?? 0) > 0;
		const hasChannelData = Object.keys(p?.channelData ?? {}).length > 0;
		return text || hasMedia || hasInteractive || hasChannelData;
	};
	for (let i = payloads.length - 1; i >= 0; i--) {
		if (payloads[i]?.isError) continue;
		if (isDeliverable(payloads[i])) return payloads[i];
	}
	for (let i = payloads.length - 1; i >= 0; i--) if (isDeliverable(payloads[i])) return payloads[i];
}
/**
* Check if delivery should be skipped because the agent signaled no user-visible update.
* Returns true when any payload is a heartbeat ack token and no payload contains media.
*/
function isHeartbeatOnlyResponse(payloads, ackMaxChars) {
	return shouldSkipHeartbeatOnlyDelivery(payloads, ackMaxChars);
}
function resolveHeartbeatAckMaxChars(agentCfg) {
	const raw = agentCfg?.heartbeat?.ackMaxChars ?? 300;
	return Math.max(0, raw);
}
//#endregion
//#region src/cron/isolated-agent/subagent-followup.ts
const FAST_TEST_MODE = process.env.OPENCLAW_TEST_FAST === "1";
const CRON_SUBAGENT_WAIT_MIN_MS = FAST_TEST_MODE ? 10 : 3e4;
const CRON_SUBAGENT_FINAL_REPLY_GRACE_MS = FAST_TEST_MODE ? 50 : 5e3;
const CRON_SUBAGENT_GRACE_POLL_MS = FAST_TEST_MODE ? 8 : 200;
const SUBAGENT_FOLLOWUP_HINTS = [
	"subagent spawned",
	"spawned a subagent",
	"auto-announce when done",
	"both subagents are running",
	"wait for them to report back"
];
const INTERIM_CRON_HINTS = [
	"on it",
	"pulling everything together",
	"give me a few",
	"give me a few min",
	"few minutes",
	"let me compile",
	"i'll gather",
	"i will gather",
	"working on it",
	"retrying now",
	"should be about",
	"should have your summary",
	"it'll auto-announce when done",
	"it will auto-announce when done",
	...SUBAGENT_FOLLOWUP_HINTS
];
function normalizeHintText(value) {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}
function isLikelyInterimCronMessage(value) {
	const normalized = normalizeHintText(value);
	if (!normalized) return false;
	return normalized.split(" ").filter(Boolean).length <= 45 && INTERIM_CRON_HINTS.some((hint) => normalized.includes(hint));
}
function expectsSubagentFollowup(value) {
	const normalized = normalizeHintText(value);
	return Boolean(normalized && SUBAGENT_FOLLOWUP_HINTS.some((hint) => normalized.includes(hint)));
}
async function readDescendantSubagentFallbackReply(params) {
	const descendants = listDescendantRunsForRequester(params.sessionKey).filter((entry) => typeof entry.endedAt === "number" && entry.endedAt >= params.runStartedAt && entry.childSessionKey.trim().length > 0).toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
	if (descendants.length === 0) return;
	const latestByChild = /* @__PURE__ */ new Map();
	for (const entry of descendants) {
		const childKey = entry.childSessionKey.trim();
		if (!childKey) continue;
		const current = latestByChild.get(childKey);
		if (!current || (entry.endedAt ?? 0) >= (current.endedAt ?? 0)) latestByChild.set(childKey, entry);
	}
	const replies = [];
	const latestRuns = [...latestByChild.values()].toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(-4);
	for (const entry of latestRuns) {
		let reply = (await readLatestAssistantReply({ sessionKey: entry.childSessionKey }))?.trim();
		if (!reply && typeof entry.frozenResultText === "string" && entry.frozenResultText.trim()) reply = entry.frozenResultText.trim();
		if (!reply || reply.toUpperCase() === "NO_REPLY".toUpperCase()) continue;
		replies.push(reply);
	}
	if (replies.length === 0) return;
	if (replies.length === 1) return replies[0];
	return replies.join("\n\n");
}
/**
* Waits for descendant subagents to complete using a push-based approach:
* each active descendant run is awaited via `agent.wait` (gateway RPC) instead
* of a busy-poll loop.  After all active runs settle, a short grace period
* polls the cron agent's session for a post-orchestration synthesis message.
*/
async function waitForDescendantSubagentSummary(params) {
	const initialReply = params.initialReply?.trim();
	const deadline = Date.now() + Math.max(CRON_SUBAGENT_WAIT_MIN_MS, Math.floor(params.timeoutMs));
	const getActiveRuns = () => listDescendantRunsForRequester(params.sessionKey).filter((entry) => typeof entry.endedAt !== "number");
	const initialActiveRuns = getActiveRuns();
	if (!(params.observedActiveDescendants === true || initialActiveRuns.length > 0)) return initialReply;
	let pendingRunIds = new Set(initialActiveRuns.map((e) => e.runId));
	while (pendingRunIds.size > 0 && Date.now() < deadline) {
		const remainingMs = Math.max(1, deadline - Date.now());
		await Promise.allSettled([...pendingRunIds].map((runId) => callGateway({
			method: "agent.wait",
			params: {
				runId,
				timeoutMs: remainingMs
			},
			timeoutMs: remainingMs + 2e3
		}).catch(() => void 0)));
		pendingRunIds = new Set(getActiveRuns().map((e) => e.runId));
	}
	const gracePeriodDeadline = Math.min(Date.now() + CRON_SUBAGENT_FINAL_REPLY_GRACE_MS, deadline);
	const resolveUsableLatestReply = async () => {
		const latest = (await readLatestAssistantReply({ sessionKey: params.sessionKey }))?.trim();
		if (latest && latest.toUpperCase() !== "NO_REPLY".toUpperCase() && (latest !== initialReply || !isLikelyInterimCronMessage(latest))) return latest;
	};
	while (Date.now() < gracePeriodDeadline) {
		const latest = await resolveUsableLatestReply();
		if (latest) return latest;
		await new Promise((resolve) => setTimeout(resolve, CRON_SUBAGENT_GRACE_POLL_MS));
	}
	const latest = await resolveUsableLatestReply();
	if (latest) return latest;
}
//#endregion
//#region src/cron/isolated-agent/delivery-dispatch.ts
function normalizeDeliveryTarget(channel, to) {
	const channelLower = channel.trim().toLowerCase();
	const toTrimmed = to.trim();
	if (channelLower === "feishu" || channelLower === "lark") {
		const lowered = toTrimmed.toLowerCase();
		if (lowered.startsWith("user:")) return toTrimmed.slice(5).trim();
		if (lowered.startsWith("chat:")) return toTrimmed.slice(5).trim();
	}
	return toTrimmed;
}
function matchesMessagingToolDeliveryTarget(target, delivery) {
	if (!delivery.channel || !delivery.to || !target.to) return false;
	const channel = delivery.channel.trim().toLowerCase();
	const provider = target.provider?.trim().toLowerCase();
	if (provider && provider !== "message" && provider !== channel) return false;
	if (target.accountId && delivery.accountId && target.accountId !== delivery.accountId) return false;
	return normalizeDeliveryTarget(channel, target.to.replace(/:topic:\d+$/, "")) === normalizeDeliveryTarget(channel, delivery.to);
}
function resolveCronDeliveryBestEffort(job) {
	if (typeof job.delivery?.bestEffort === "boolean") return job.delivery.bestEffort;
	if (job.payload.kind === "agentTurn" && typeof job.payload.bestEffortDeliver === "boolean") return job.payload.bestEffortDeliver;
	return false;
}
const TRANSIENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS = [
	/\berrorcode=unavailable\b/i,
	/\bstatus\s*[:=]\s*"?unavailable\b/i,
	/\bUNAVAILABLE\b/,
	/no active .* listener/i,
	/gateway not connected/i,
	/gateway closed \(1006/i,
	/gateway timeout/i,
	/\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i
];
const PERMANENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS = [
	/unsupported channel/i,
	/unknown channel/i,
	/chat not found/i,
	/user not found/i,
	/bot was blocked by the user/i,
	/forbidden: bot was kicked/i,
	/recipient is not a valid/i,
	/outbound not configured for channel/i
];
const COMPLETED_DIRECT_CRON_DELIVERIES = /* @__PURE__ */ new Map();
function cloneDeliveryResults(results) {
	return results.map((result) => ({
		...result,
		...result.meta ? { meta: { ...result.meta } } : {}
	}));
}
function pruneCompletedDirectCronDeliveries(now) {
	const ttlMs = process.env.OPENCLAW_TEST_FAST === "1" ? 6e4 : 1440 * 60 * 1e3;
	for (const [key, entry] of COMPLETED_DIRECT_CRON_DELIVERIES) if (now - entry.ts >= ttlMs) COMPLETED_DIRECT_CRON_DELIVERIES.delete(key);
	const maxEntries = 2e3;
	if (COMPLETED_DIRECT_CRON_DELIVERIES.size <= maxEntries) return;
	const entries = [...COMPLETED_DIRECT_CRON_DELIVERIES.entries()].toSorted((a, b) => a[1].ts - b[1].ts);
	const toDelete = COMPLETED_DIRECT_CRON_DELIVERIES.size - maxEntries;
	for (let i = 0; i < toDelete; i += 1) {
		const oldest = entries[i];
		if (!oldest) break;
		COMPLETED_DIRECT_CRON_DELIVERIES.delete(oldest[0]);
	}
}
function rememberCompletedDirectCronDelivery(idempotencyKey, results) {
	const now = Date.now();
	COMPLETED_DIRECT_CRON_DELIVERIES.set(idempotencyKey, {
		ts: now,
		results: cloneDeliveryResults(results)
	});
	pruneCompletedDirectCronDeliveries(now);
}
function getCompletedDirectCronDelivery(idempotencyKey) {
	pruneCompletedDirectCronDeliveries(Date.now());
	const cached = COMPLETED_DIRECT_CRON_DELIVERIES.get(idempotencyKey);
	if (!cached) return;
	return cloneDeliveryResults(cached.results);
}
function buildDirectCronDeliveryIdempotencyKey(params) {
	const threadId = params.delivery.threadId == null || params.delivery.threadId === "" ? "" : String(params.delivery.threadId);
	const accountId = params.delivery.accountId?.trim() ?? "";
	const normalizedTo = normalizeDeliveryTarget(params.delivery.channel, params.delivery.to);
	return `cron-direct-delivery:v1:${params.runSessionId}:${params.delivery.channel}:${accountId}:${normalizedTo}:${threadId}`;
}
function summarizeDirectCronDeliveryError(error) {
	if (error instanceof Error) return error.message || "error";
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) || String(error);
	} catch {
		return String(error);
	}
}
function isTransientDirectCronDeliveryError(error) {
	const message = summarizeDirectCronDeliveryError(error);
	if (!message) return false;
	if (PERMANENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message))) return false;
	return TRANSIENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message));
}
function resolveDirectCronRetryDelaysMs() {
	return [
		5e3,
		1e4,
		2e4
	];
}
async function retryTransientDirectCronDelivery(params) {
	const retryDelaysMs = resolveDirectCronRetryDelaysMs();
	let retryIndex = 0;
	for (;;) {
		if (params.signal?.aborted) throw new Error("cron delivery aborted");
		try {
			return await params.run();
		} catch (err) {
			const delayMs = retryDelaysMs[retryIndex];
			if (delayMs == null || !isTransientDirectCronDeliveryError(err) || params.signal?.aborted) throw err;
			const nextAttempt = retryIndex + 2;
			const maxAttempts = retryDelaysMs.length + 1;
			logWarn(`[cron:${params.jobId}] transient direct announce delivery failure, retrying ${nextAttempt}/${maxAttempts} in ${Math.round(delayMs / 1e3)}s: ${summarizeDirectCronDeliveryError(err)}`);
			retryIndex += 1;
			await sleepWithAbort(delayMs, params.signal);
		}
	}
}
async function dispatchCronDelivery(params) {
	const skipMessagingToolDelivery = params.skipMessagingToolDelivery === true;
	let summary = params.summary;
	let outputText = params.outputText;
	let synthesizedText = params.synthesizedText;
	let deliveryPayloads = params.deliveryPayloads;
	let delivered = skipMessagingToolDelivery;
	let deliveryAttempted = skipMessagingToolDelivery;
	const failDeliveryTarget = (error) => params.withRunSession({
		status: "error",
		error,
		errorKind: "delivery-target",
		summary,
		outputText,
		deliveryAttempted,
		...params.telemetry
	});
	const deliverViaDirect = async (delivery, options) => {
		const identity = resolveAgentOutboundIdentity(params.cfgWithAgentDefaults, params.agentId);
		const deliveryIdempotencyKey = buildDirectCronDeliveryIdempotencyKey({
			runSessionId: params.runSessionId,
			delivery
		});
		try {
			const payloadsForDelivery = deliveryPayloads.length > 0 ? deliveryPayloads : synthesizedText ? [{ text: synthesizedText }] : [];
			if (payloadsForDelivery.length === 0) return null;
			if (params.isAborted()) return params.withRunSession({
				status: "error",
				error: params.abortReason(),
				deliveryAttempted,
				...params.telemetry
			});
			deliveryAttempted = true;
			if (getCompletedDirectCronDelivery(deliveryIdempotencyKey)) {
				delivered = true;
				return null;
			}
			const deliverySession = buildOutboundSessionContext({
				cfg: params.cfgWithAgentDefaults,
				agentId: params.agentId,
				sessionKey: params.agentSessionKey
			});
			const runDelivery = async () => await deliverOutboundPayloads({
				cfg: params.cfgWithAgentDefaults,
				channel: delivery.channel,
				to: delivery.to,
				accountId: delivery.accountId,
				threadId: delivery.threadId,
				payloads: payloadsForDelivery,
				session: deliverySession,
				identity,
				bestEffort: params.deliveryBestEffort,
				deps: createOutboundSendDeps$1(params.deps),
				abortSignal: params.abortSignal,
				skipQueue: true
			});
			const deliveryResults = options?.retryTransient ? await retryTransientDirectCronDelivery({
				jobId: params.job.id,
				signal: params.abortSignal,
				run: runDelivery
			}) : await runDelivery();
			delivered = deliveryResults.length > 0;
			if (delivered) rememberCompletedDirectCronDelivery(deliveryIdempotencyKey, deliveryResults);
			return null;
		} catch (err) {
			if (!params.deliveryBestEffort) return params.withRunSession({
				status: "error",
				summary,
				outputText,
				error: String(err),
				deliveryAttempted,
				...params.telemetry
			});
			return null;
		}
	};
	const finalizeTextDelivery = async (delivery) => {
		const cleanupDirectCronSessionIfNeeded = async () => {
			if (!params.job.deleteAfterRun) return;
			try {
				await callGateway({
					method: "sessions.delete",
					params: {
						key: params.agentSessionKey,
						deleteTranscript: true,
						emitLifecycleHooks: false
					},
					timeoutMs: 1e4
				});
			} catch {}
		};
		if (!synthesizedText) return null;
		const initialSynthesizedText = synthesizedText.trim();
		let activeSubagentRuns = countActiveDescendantRuns(params.agentSessionKey);
		const expectedSubagentFollowup = expectsSubagentFollowup(initialSynthesizedText);
		const completedDescendantReply = activeSubagentRuns === 0 && isLikelyInterimCronMessage(initialSynthesizedText) ? await readDescendantSubagentFallbackReply({
			sessionKey: params.agentSessionKey,
			runStartedAt: params.runStartedAt
		}) : void 0;
		const hadDescendants = activeSubagentRuns > 0 || Boolean(completedDescendantReply);
		if (activeSubagentRuns > 0 || expectedSubagentFollowup) {
			let finalReply = await waitForDescendantSubagentSummary({
				sessionKey: params.agentSessionKey,
				initialReply: initialSynthesizedText,
				timeoutMs: params.timeoutMs,
				observedActiveDescendants: activeSubagentRuns > 0 || expectedSubagentFollowup
			});
			activeSubagentRuns = countActiveDescendantRuns(params.agentSessionKey);
			if (!finalReply && activeSubagentRuns === 0) finalReply = await readDescendantSubagentFallbackReply({
				sessionKey: params.agentSessionKey,
				runStartedAt: params.runStartedAt
			});
			if (finalReply && activeSubagentRuns === 0) {
				outputText = finalReply;
				summary = pickSummaryFromOutput(finalReply) ?? summary;
				synthesizedText = finalReply;
				deliveryPayloads = [{ text: finalReply }];
			}
		} else if (completedDescendantReply) {
			outputText = completedDescendantReply;
			summary = pickSummaryFromOutput(completedDescendantReply) ?? summary;
			synthesizedText = completedDescendantReply;
			deliveryPayloads = [{ text: completedDescendantReply }];
		}
		if (activeSubagentRuns > 0) {
			deliveryAttempted = true;
			return params.withRunSession({
				status: "ok",
				summary,
				outputText,
				deliveryAttempted,
				...params.telemetry
			});
		}
		if (hadDescendants && synthesizedText.trim() === initialSynthesizedText && isLikelyInterimCronMessage(initialSynthesizedText) && initialSynthesizedText.toUpperCase() !== "NO_REPLY".toUpperCase()) {
			deliveryAttempted = true;
			return params.withRunSession({
				status: "ok",
				summary,
				outputText,
				deliveryAttempted,
				...params.telemetry
			});
		}
		if (synthesizedText.toUpperCase() === "NO_REPLY".toUpperCase()) return params.withRunSession({
			status: "ok",
			summary,
			outputText,
			delivered: true,
			...params.telemetry
		});
		if (params.isAborted()) return params.withRunSession({
			status: "error",
			error: params.abortReason(),
			deliveryAttempted,
			...params.telemetry
		});
		try {
			return await deliverViaDirect(delivery, { retryTransient: true });
		} finally {
			await cleanupDirectCronSessionIfNeeded();
		}
	};
	if (params.deliveryRequested && !params.skipHeartbeatDelivery && !skipMessagingToolDelivery) {
		if (!params.resolvedDelivery.ok) {
			if (!params.deliveryBestEffort) return {
				result: failDeliveryTarget(params.resolvedDelivery.error.message),
				delivered,
				deliveryAttempted,
				summary,
				outputText,
				synthesizedText,
				deliveryPayloads
			};
			logWarn(`[cron:${params.job.id}] ${params.resolvedDelivery.error.message}`);
			return {
				result: params.withRunSession({
					status: "ok",
					summary,
					outputText,
					deliveryAttempted,
					...params.telemetry
				}),
				delivered,
				deliveryAttempted,
				summary,
				outputText,
				synthesizedText,
				deliveryPayloads
			};
		}
		if (params.deliveryPayloadHasStructuredContent || params.resolvedDelivery.threadId != null) {
			const directResult = await deliverViaDirect(params.resolvedDelivery);
			if (directResult) return {
				result: directResult,
				delivered,
				deliveryAttempted,
				summary,
				outputText,
				synthesizedText,
				deliveryPayloads
			};
		} else {
			const finalizedTextResult = await finalizeTextDelivery(params.resolvedDelivery);
			if (finalizedTextResult) return {
				result: finalizedTextResult,
				delivered,
				deliveryAttempted,
				summary,
				outputText,
				synthesizedText,
				deliveryPayloads
			};
		}
	}
	return {
		delivered,
		deliveryAttempted,
		summary,
		outputText,
		synthesizedText,
		deliveryPayloads
	};
}
//#endregion
//#region src/cron/isolated-agent/session-key.ts
init_session_key();
function resolveCronAgentSessionKey(params) {
	return toAgentStoreSessionKey({
		agentId: params.agentId,
		requestKey: params.sessionKey.trim(),
		mainKey: params.mainKey
	});
}
//#endregion
//#region src/cron/isolated-agent/skills-snapshot.ts
function resolveCronSkillsSnapshot(params) {
	if (params.isFastTestEnv) return params.existingSnapshot ?? {
		prompt: "",
		skills: []
	};
	const snapshotVersion = getSkillsSnapshotVersion(params.workspaceDir);
	const skillFilter = resolveAgentSkillsFilter(params.config, params.agentId);
	const existingSnapshot = params.existingSnapshot;
	if (!(!existingSnapshot || existingSnapshot.version !== snapshotVersion || !matchesSkillFilter(existingSnapshot.skillFilter, skillFilter))) return existingSnapshot;
	return buildWorkspaceSkillSnapshot(params.workspaceDir, {
		config: params.config,
		skillFilter,
		eligibility: { remote: getRemoteSkillEligibility() },
		snapshotVersion
	});
}
//#endregion
//#region src/cron/isolated-agent/run.ts
init_session_key();
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
function resolveCronToolPolicy(params) {
	return {
		requireExplicitMessageTarget: params.deliveryRequested && params.resolvedDelivery.ok,
		disableMessageTool: params.deliveryContract === "cron-owned" ? true : params.deliveryRequested
	};
}
async function resolveCronDeliveryContext(params) {
	const deliveryPlan = resolveCronDeliveryPlan(params.job);
	if (!deliveryPlan.requested) {
		const resolvedDelivery = {
			ok: false,
			channel: void 0,
			to: void 0,
			accountId: void 0,
			threadId: void 0,
			mode: "implicit",
			error: /* @__PURE__ */ new Error("cron delivery not requested")
		};
		return {
			deliveryPlan,
			deliveryRequested: false,
			resolvedDelivery,
			toolPolicy: resolveCronToolPolicy({
				deliveryRequested: false,
				resolvedDelivery,
				deliveryContract: params.deliveryContract
			})
		};
	}
	const resolvedDelivery = await resolveDeliveryTarget(params.cfg, params.agentId, {
		channel: deliveryPlan.channel ?? "last",
		to: deliveryPlan.to,
		accountId: deliveryPlan.accountId,
		sessionKey: params.job.sessionKey
	});
	return {
		deliveryPlan,
		deliveryRequested: deliveryPlan.requested,
		resolvedDelivery,
		toolPolicy: resolveCronToolPolicy({
			deliveryRequested: deliveryPlan.requested,
			resolvedDelivery,
			deliveryContract: params.deliveryContract
		})
	};
}
function appendCronDeliveryInstruction(params) {
	if (!params.deliveryRequested) return params.commandBody;
	return `${params.commandBody}\n\nReturn your summary as plain text; it will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`.trim();
}
async function runCronIsolatedAgentTurn(params) {
	const abortSignal = params.abortSignal ?? params.signal;
	const isAborted = () => abortSignal?.aborted === true;
	const abortReason = () => {
		const reason = abortSignal?.reason;
		return typeof reason === "string" && reason.trim() ? reason.trim() : "cron: job execution timed out";
	};
	const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
	const deliveryContract = params.deliveryContract ?? "cron-owned";
	const defaultAgentId = resolveDefaultAgentId(params.cfg);
	const requestedAgentId = typeof params.agentId === "string" && params.agentId.trim() ? params.agentId : typeof params.job.agentId === "string" && params.job.agentId.trim() ? params.job.agentId : void 0;
	const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : void 0;
	const agentConfigOverride = normalizedRequested ? resolveAgentConfig(params.cfg, normalizedRequested) : void 0;
	const agentId = normalizedRequested ?? defaultAgentId;
	const agentCfg = buildCronAgentDefaultsConfig({
		defaults: params.cfg.agents?.defaults,
		agentConfigOverride
	});
	const cfgWithAgentDefaults = {
		...params.cfg,
		agents: Object.assign({}, params.cfg.agents, { defaults: agentCfg })
	};
	const baseSessionKey = (params.sessionKey?.trim() || `cron:${params.job.id}`).trim();
	const agentSessionKey = resolveCronAgentSessionKey({
		sessionKey: baseSessionKey,
		agentId
	});
	const workspaceDirRaw = resolveAgentWorkspaceDir(params.cfg, agentId);
	const agentDir = resolveAgentDir(params.cfg, agentId);
	const workspaceDir = (await ensureAgentWorkspace({
		dir: workspaceDirRaw,
		ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv
	})).dir;
	const resolvedDefault = resolveConfiguredModelRef({
		cfg: cfgWithAgentDefaults,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	let provider = resolvedDefault.provider;
	let model = resolvedDefault.model;
	let catalog;
	const loadCatalog = async () => {
		if (!catalog) catalog = await loadModelCatalog({ config: cfgWithAgentDefaults });
		return catalog;
	};
	const subagentModelRaw = normalizeModelSelection(agentConfigOverride?.subagents?.model) ?? normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model);
	if (subagentModelRaw) {
		const resolvedSubagent = resolveAllowedModelRef({
			cfg: cfgWithAgentDefaults,
			catalog: await loadCatalog(),
			raw: subagentModelRaw,
			defaultProvider: resolvedDefault.provider,
			defaultModel: resolvedDefault.model
		});
		if (!("error" in resolvedSubagent)) {
			provider = resolvedSubagent.ref.provider;
			model = resolvedSubagent.ref.model;
		}
	}
	const isGmailHook = baseSessionKey.startsWith("hook:gmail:");
	let hooksGmailModelApplied = false;
	const hooksGmailModelRef = isGmailHook ? resolveHooksGmailModel({
		cfg: params.cfg,
		defaultProvider: DEFAULT_PROVIDER
	}) : null;
	if (hooksGmailModelRef) {
		if (getModelRefStatus({
			cfg: params.cfg,
			catalog: await loadCatalog(),
			ref: hooksGmailModelRef,
			defaultProvider: resolvedDefault.provider,
			defaultModel: resolvedDefault.model
		}).allowed) {
			provider = hooksGmailModelRef.provider;
			model = hooksGmailModelRef.model;
			hooksGmailModelApplied = true;
		}
	}
	const modelOverrideRaw = params.job.payload.kind === "agentTurn" ? params.job.payload.model : void 0;
	const modelOverride = typeof modelOverrideRaw === "string" ? modelOverrideRaw.trim() : void 0;
	if (modelOverride !== void 0 && modelOverride.length > 0) {
		const resolvedOverride = resolveAllowedModelRef({
			cfg: cfgWithAgentDefaults,
			catalog: await loadCatalog(),
			raw: modelOverride,
			defaultProvider: resolvedDefault.provider,
			defaultModel: resolvedDefault.model
		});
		if ("error" in resolvedOverride) if (resolvedOverride.error.startsWith("model not allowed:")) logWarn(`cron: payload.model '${modelOverride}' not allowed, falling back to agent defaults`);
		else return {
			status: "error",
			error: resolvedOverride.error
		};
		else {
			provider = resolvedOverride.ref.provider;
			model = resolvedOverride.ref.model;
		}
	}
	const now = Date.now();
	const cronSession = resolveCronSession({
		cfg: params.cfg,
		sessionKey: agentSessionKey,
		agentId,
		nowMs: now,
		forceNew: params.job.sessionTarget === "isolated"
	});
	const runSessionId = cronSession.sessionEntry.sessionId;
	const runSessionKey = baseSessionKey.startsWith("cron:") ? `${agentSessionKey}:run:${runSessionId}` : agentSessionKey;
	const persistSessionEntry = async () => {
		if (isFastTestEnv) return;
		cronSession.store[agentSessionKey] = cronSession.sessionEntry;
		if (runSessionKey !== agentSessionKey) cronSession.store[runSessionKey] = cronSession.sessionEntry;
		await updateSessionStore(cronSession.storePath, (store) => {
			store[agentSessionKey] = cronSession.sessionEntry;
			if (runSessionKey !== agentSessionKey) store[runSessionKey] = cronSession.sessionEntry;
		});
	};
	const withRunSession = (result) => ({
		...result,
		sessionId: runSessionId,
		sessionKey: runSessionKey
	});
	if (!cronSession.sessionEntry.label?.trim() && baseSessionKey.startsWith("cron:")) {
		const labelSuffix = typeof params.job.name === "string" && params.job.name.trim() ? params.job.name.trim() : params.job.id;
		cronSession.sessionEntry.label = `Cron: ${labelSuffix}`;
	}
	if (!modelOverride && !hooksGmailModelApplied) {
		const sessionModelOverride = cronSession.sessionEntry.modelOverride?.trim();
		if (sessionModelOverride) {
			const sessionProviderOverride = cronSession.sessionEntry.providerOverride?.trim() || resolvedDefault.provider;
			const resolvedSessionOverride = resolveAllowedModelRef({
				cfg: cfgWithAgentDefaults,
				catalog: await loadCatalog(),
				raw: `${sessionProviderOverride}/${sessionModelOverride}`,
				defaultProvider: resolvedDefault.provider,
				defaultModel: resolvedDefault.model
			});
			if (!("error" in resolvedSessionOverride)) {
				provider = resolvedSessionOverride.ref.provider;
				model = resolvedSessionOverride.ref.model;
			}
		}
	}
	const hooksGmailThinking = isGmailHook ? normalizeThinkLevel(params.cfg.hooks?.gmail?.thinking) : void 0;
	let thinkLevel = normalizeThinkLevel((params.job.payload.kind === "agentTurn" ? params.job.payload.thinking : void 0) ?? void 0) ?? hooksGmailThinking;
	if (!thinkLevel) thinkLevel = resolveThinkingDefault({
		cfg: cfgWithAgentDefaults,
		provider,
		model,
		catalog: await loadCatalog()
	});
	if (thinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
		logWarn(`[cron:${params.job.id}] Thinking level "xhigh" is not supported for ${provider}/${model}; downgrading to "high".`);
		thinkLevel = "high";
	}
	const timeoutMs = resolveAgentTimeoutMs({
		cfg: cfgWithAgentDefaults,
		overrideSeconds: params.job.payload.kind === "agentTurn" ? params.job.payload.timeoutSeconds : void 0
	});
	const agentPayload = params.job.payload.kind === "agentTurn" ? params.job.payload : null;
	const { deliveryRequested, resolvedDelivery, toolPolicy } = await resolveCronDeliveryContext({
		cfg: cfgWithAgentDefaults,
		job: params.job,
		agentId,
		deliveryContract
	});
	const { formattedTime, timeLine } = resolveCronStyleNow(params.cfg, now);
	const base = `[cron:${params.job.id} ${params.job.name}] ${params.message}`.trim();
	const isExternalHook = isExternalHookSession(baseSessionKey);
	const allowUnsafeExternalContent = agentPayload?.allowUnsafeExternalContent === true || isGmailHook && params.cfg.hooks?.gmail?.allowUnsafeExternalContent === true;
	const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
	let commandBody;
	if (isExternalHook) {
		const suspiciousPatterns = detectSuspiciousPatterns(params.message);
		if (suspiciousPatterns.length > 0) logWarn(`[security] Suspicious patterns detected in external hook content (session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`);
	}
	if (shouldWrapExternal) {
		const hookType = getHookType(baseSessionKey);
		commandBody = `${buildSafeExternalPrompt({
			content: params.message,
			source: hookType,
			jobName: params.job.name,
			jobId: params.job.id,
			timestamp: formattedTime
		})}\n\n${timeLine}`.trim();
	} else commandBody = `${base}\n${timeLine}`.trim();
	commandBody = appendCronDeliveryInstruction({
		commandBody,
		deliveryRequested
	});
	const existingSkillsSnapshot = cronSession.sessionEntry.skillsSnapshot;
	const skillsSnapshot = resolveCronSkillsSnapshot({
		workspaceDir,
		config: cfgWithAgentDefaults,
		agentId,
		existingSnapshot: existingSkillsSnapshot,
		isFastTestEnv
	});
	if (!isFastTestEnv && skillsSnapshot !== existingSkillsSnapshot) {
		cronSession.sessionEntry = {
			...cronSession.sessionEntry,
			updatedAt: Date.now(),
			skillsSnapshot
		};
		await persistSessionEntry();
	}
	cronSession.sessionEntry.modelProvider = provider;
	cronSession.sessionEntry.model = model;
	cronSession.sessionEntry.systemSent = true;
	try {
		await persistSessionEntry();
	} catch (err) {
		logWarn(`[cron:${params.job.id}] Failed to persist pre-run session entry: ${String(err)}`);
	}
	const authProfileId = await resolveSessionAuthProfileOverride({
		cfg: cfgWithAgentDefaults,
		provider,
		agentDir,
		sessionEntry: cronSession.sessionEntry,
		sessionStore: cronSession.store,
		sessionKey: agentSessionKey,
		storePath: cronSession.storePath,
		isNewSession: cronSession.isNewSession
	});
	const authProfileIdSource = cronSession.sessionEntry.authProfileOverrideSource;
	let runResult;
	let fallbackProvider = provider;
	let fallbackModel = model;
	const runStartedAt = Date.now();
	let runEndedAt = runStartedAt;
	try {
		const sessionFile = resolveSessionTranscriptPath(cronSession.sessionEntry.sessionId, agentId);
		const resolvedVerboseLevel = normalizeVerboseLevel(cronSession.sessionEntry.verboseLevel) ?? normalizeVerboseLevel(agentCfg?.verboseDefault) ?? "off";
		registerAgentRunContext(cronSession.sessionEntry.sessionId, {
			sessionKey: agentSessionKey,
			verboseLevel: resolvedVerboseLevel
		});
		const messageChannel = resolvedDelivery.channel;
		const payloadFallbacks = params.job.payload.kind === "agentTurn" && Array.isArray(params.job.payload.fallbacks) ? params.job.payload.fallbacks : void 0;
		let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(cronSession.sessionEntry.systemPromptReport);
		const runPrompt = async (promptText) => {
			const fallbackResult = await runWithModelFallback({
				cfg: cfgWithAgentDefaults,
				provider,
				model,
				runId: cronSession.sessionEntry.sessionId,
				agentDir,
				fallbacksOverride: payloadFallbacks ?? resolveAgentModelFallbacksOverride(params.cfg, agentId),
				run: async (providerOverride, modelOverride, runOptions) => {
					if (abortSignal?.aborted) throw new Error(abortReason());
					const bootstrapPromptWarningSignature = bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
					if (isCliProvider(providerOverride, cfgWithAgentDefaults)) {
						const cliSessionId = cronSession.isNewSession ? void 0 : getCliSessionId(cronSession.sessionEntry, providerOverride);
						const result = await runCliAgent({
							sessionId: cronSession.sessionEntry.sessionId,
							sessionKey: agentSessionKey,
							agentId,
							sessionFile,
							workspaceDir,
							config: cfgWithAgentDefaults,
							prompt: promptText,
							provider: providerOverride,
							model: modelOverride,
							thinkLevel,
							timeoutMs,
							runId: cronSession.sessionEntry.sessionId,
							cliSessionId,
							bootstrapPromptWarningSignaturesSeen,
							bootstrapPromptWarningSignature
						});
						bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(result.meta?.systemPromptReport);
						return result;
					}
					const result = await runEmbeddedPiAgent({
						sessionId: cronSession.sessionEntry.sessionId,
						sessionKey: agentSessionKey,
						agentId,
						trigger: "cron",
						senderIsOwner: true,
						messageChannel,
						agentAccountId: resolvedDelivery.accountId,
						sessionFile,
						agentDir,
						workspaceDir,
						config: cfgWithAgentDefaults,
						skillsSnapshot,
						prompt: promptText,
						lane: resolveNestedAgentLane(params.lane),
						provider: providerOverride,
						model: modelOverride,
						authProfileId,
						authProfileIdSource,
						thinkLevel,
						fastMode: resolveFastModeState({
							cfg: cfgWithAgentDefaults,
							provider: providerOverride,
							model: modelOverride,
							sessionEntry: cronSession.sessionEntry
						}).enabled,
						verboseLevel: resolvedVerboseLevel,
						timeoutMs,
						bootstrapContextMode: agentPayload?.lightContext ? "lightweight" : void 0,
						bootstrapContextRunKind: "cron",
						runId: cronSession.sessionEntry.sessionId,
						requireExplicitMessageTarget: toolPolicy.requireExplicitMessageTarget,
						disableMessageTool: toolPolicy.disableMessageTool,
						allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
						abortSignal,
						bootstrapPromptWarningSignaturesSeen,
						bootstrapPromptWarningSignature
					});
					bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(result.meta?.systemPromptReport);
					return result;
				}
			});
			runResult = fallbackResult.result;
			fallbackProvider = fallbackResult.provider;
			fallbackModel = fallbackResult.model;
			provider = fallbackResult.provider;
			model = fallbackResult.model;
			runEndedAt = Date.now();
		};
		await runPrompt(commandBody);
		if (!runResult) throw new Error("cron isolated run returned no result");
		if (!isAborted()) {
			const interimRunResult = runResult;
			const interimPayloads = interimRunResult.payloads ?? [];
			const interimDeliveryPayload = pickLastDeliverablePayload(interimPayloads);
			const interimPayloadHasStructuredContent = Boolean(interimDeliveryPayload?.mediaUrl) || (interimDeliveryPayload?.mediaUrls?.length ?? 0) > 0 || Object.keys(interimDeliveryPayload?.channelData ?? {}).length > 0;
			const interimText = pickLastNonEmptyTextFromPayloads(interimPayloads)?.trim() ?? "";
			const hasDescendantsSinceRunStart = listDescendantRunsForRequester(agentSessionKey).some((entry) => {
				const descendantStartedAt = typeof entry.startedAt === "number" ? entry.startedAt : entry.createdAt;
				return typeof descendantStartedAt === "number" && descendantStartedAt >= runStartedAt;
			});
			if (!interimRunResult.meta?.error && !interimRunResult.didSendViaMessagingTool && !interimPayloadHasStructuredContent && !interimPayloads.some((payload) => payload?.isError === true) && countActiveDescendantRuns(agentSessionKey) === 0 && !hasDescendantsSinceRunStart && isLikelyInterimCronMessage(interimText)) await runPrompt([
				"Your previous response was only an acknowledgement and did not complete this cron task.",
				"Complete the original task now.",
				"Do not send a status update like 'on it'.",
				"Use tools when needed, including sessions_spawn for parallel subtasks, wait for spawned subagents to finish, then return only the final summary."
			].join(" "));
		}
	} catch (err) {
		return withRunSession({
			status: "error",
			error: String(err)
		});
	}
	if (isAborted()) return withRunSession({
		status: "error",
		error: abortReason()
	});
	if (!runResult) return withRunSession({
		status: "error",
		error: "cron isolated run returned no result"
	});
	const finalRunResult = runResult;
	const payloads = finalRunResult.payloads ?? [];
	let telemetry;
	{
		if (finalRunResult.meta?.systemPromptReport) cronSession.sessionEntry.systemPromptReport = finalRunResult.meta.systemPromptReport;
		const usage = finalRunResult.meta?.agentMeta?.usage;
		const promptTokens = finalRunResult.meta?.agentMeta?.promptTokens;
		const modelUsed = finalRunResult.meta?.agentMeta?.model ?? fallbackModel ?? model;
		const providerUsed = finalRunResult.meta?.agentMeta?.provider ?? fallbackProvider ?? provider;
		const contextTokens = agentCfg?.contextTokens ?? lookupContextTokens(modelUsed) ?? 2e5;
		setSessionRuntimeModel(cronSession.sessionEntry, {
			provider: providerUsed,
			model: modelUsed
		});
		cronSession.sessionEntry.contextTokens = contextTokens;
		if (isCliProvider(providerUsed, cfgWithAgentDefaults)) {
			const cliSessionId = finalRunResult.meta?.agentMeta?.sessionId?.trim();
			if (cliSessionId) setCliSessionId(cronSession.sessionEntry, providerUsed, cliSessionId);
		}
		if (hasNonzeroUsage(usage)) {
			const input = usage.input ?? 0;
			const output = usage.output ?? 0;
			const totalTokens = deriveSessionTotalTokens({
				usage,
				contextTokens,
				promptTokens
			});
			cronSession.sessionEntry.inputTokens = input;
			cronSession.sessionEntry.outputTokens = output;
			const telemetryUsage = {
				input_tokens: input,
				output_tokens: output
			};
			if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
				cronSession.sessionEntry.totalTokens = totalTokens;
				cronSession.sessionEntry.totalTokensFresh = true;
				telemetryUsage.total_tokens = totalTokens;
			} else {
				cronSession.sessionEntry.totalTokens = void 0;
				cronSession.sessionEntry.totalTokensFresh = false;
			}
			cronSession.sessionEntry.cacheRead = usage.cacheRead ?? 0;
			cronSession.sessionEntry.cacheWrite = usage.cacheWrite ?? 0;
			telemetry = {
				model: modelUsed,
				provider: providerUsed,
				usage: telemetryUsage
			};
		} else telemetry = {
			model: modelUsed,
			provider: providerUsed
		};
		await persistSessionEntry();
	}
	if (isAborted()) return withRunSession({
		status: "error",
		error: abortReason(),
		...telemetry
	});
	const firstText = payloads[0]?.text ?? "";
	let summary = pickSummaryFromPayloads(payloads) ?? pickSummaryFromOutput(firstText);
	let outputText = pickLastNonEmptyTextFromPayloads(payloads);
	let synthesizedText = outputText?.trim() || summary?.trim() || void 0;
	const deliveryPayload = pickLastDeliverablePayload(payloads);
	let deliveryPayloads = deliveryPayload !== void 0 ? [deliveryPayload] : synthesizedText ? [{ text: synthesizedText }] : [];
	const deliveryPayloadHasStructuredContent = Boolean(deliveryPayload?.mediaUrl) || (deliveryPayload?.mediaUrls?.length ?? 0) > 0 || Object.keys(deliveryPayload?.channelData ?? {}).length > 0;
	const deliveryBestEffort = resolveCronDeliveryBestEffort(params.job);
	const hasErrorPayload = payloads.some((payload) => payload?.isError === true);
	const runLevelError = finalRunResult.meta?.error;
	const lastErrorPayloadIndex = payloads.findLastIndex((payload) => payload?.isError === true);
	const hasSuccessfulPayloadAfterLastError = !runLevelError && lastErrorPayloadIndex >= 0 && payloads.slice(lastErrorPayloadIndex + 1).some((payload) => payload?.isError !== true && Boolean(payload?.text?.trim()));
	const hasFatalErrorPayload = hasErrorPayload && !hasSuccessfulPayloadAfterLastError;
	const lastErrorPayloadText = [...payloads].toReversed().find((payload) => payload?.isError === true && Boolean(payload?.text?.trim()))?.text?.trim();
	const embeddedRunError = hasFatalErrorPayload ? lastErrorPayloadText ?? "cron isolated run returned an error payload" : void 0;
	const resolveRunOutcome = (params) => withRunSession({
		status: hasFatalErrorPayload ? "error" : "ok",
		...hasFatalErrorPayload ? { error: embeddedRunError ?? "cron isolated run returned an error payload" } : {},
		summary,
		outputText,
		delivered: params?.delivered,
		deliveryAttempted: params?.deliveryAttempted,
		...telemetry
	});
	const ackMaxChars = resolveHeartbeatAckMaxChars(agentCfg);
	const skipHeartbeatDelivery = deliveryRequested && isHeartbeatOnlyResponse(payloads, ackMaxChars);
	const skipMessagingToolDelivery = deliveryContract === "shared" && deliveryRequested && finalRunResult.didSendViaMessagingTool === true && (finalRunResult.messagingToolSentTargets ?? []).some((target) => matchesMessagingToolDeliveryTarget(target, {
		channel: resolvedDelivery.channel,
		to: resolvedDelivery.to,
		accountId: resolvedDelivery.accountId
	}));
	const deliveryResult = await dispatchCronDelivery({
		cfg: params.cfg,
		cfgWithAgentDefaults,
		deps: params.deps,
		job: params.job,
		agentId,
		agentSessionKey,
		runSessionId,
		runStartedAt,
		runEndedAt,
		timeoutMs,
		resolvedDelivery,
		deliveryRequested,
		skipHeartbeatDelivery,
		skipMessagingToolDelivery,
		deliveryBestEffort,
		deliveryPayloadHasStructuredContent,
		deliveryPayloads,
		synthesizedText,
		summary,
		outputText,
		telemetry,
		abortSignal,
		isAborted,
		abortReason,
		withRunSession
	});
	if (deliveryResult.result) {
		const resultWithDeliveryMeta = {
			...deliveryResult.result,
			deliveryAttempted: deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted
		};
		if (!hasFatalErrorPayload || deliveryResult.result.status !== "ok") return resultWithDeliveryMeta;
		return resolveRunOutcome({
			delivered: deliveryResult.result.delivered,
			deliveryAttempted: resultWithDeliveryMeta.deliveryAttempted
		});
	}
	const delivered = deliveryResult.delivered;
	const deliveryAttempted = deliveryResult.deliveryAttempted;
	summary = deliveryResult.summary;
	outputText = deliveryResult.outputText;
	return resolveRunOutcome({
		delivered,
		deliveryAttempted
	});
}
//#endregion
//#region src/cron/run-log.ts
function assertSafeCronRunLogJobId(jobId) {
	const trimmed = jobId.trim();
	if (!trimmed) throw new Error("invalid cron run log job id");
	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) throw new Error("invalid cron run log job id");
	return trimmed;
}
function resolveCronRunLogPath(params) {
	const storePath = path.resolve(params.storePath);
	const dir = path.dirname(storePath);
	const runsDir = path.resolve(dir, "runs");
	const safeJobId = assertSafeCronRunLogJobId(params.jobId);
	const resolvedPath = path.resolve(runsDir, `${safeJobId}.jsonl`);
	if (!resolvedPath.startsWith(`${runsDir}${path.sep}`)) throw new Error("invalid cron run log job id");
	return resolvedPath;
}
const writesByPath = /* @__PURE__ */ new Map();
async function setSecureFileMode(filePath) {
	await fs$1.chmod(filePath, 384).catch(() => void 0);
}
const DEFAULT_CRON_RUN_LOG_MAX_BYTES = 2e6;
const DEFAULT_CRON_RUN_LOG_KEEP_LINES = 2e3;
function resolveCronRunLogPruneOptions(cfg) {
	let maxBytes = DEFAULT_CRON_RUN_LOG_MAX_BYTES;
	if (cfg?.maxBytes !== void 0) try {
		maxBytes = parseByteSize(String(cfg.maxBytes).trim(), { defaultUnit: "b" });
	} catch {
		maxBytes = DEFAULT_CRON_RUN_LOG_MAX_BYTES;
	}
	let keepLines = DEFAULT_CRON_RUN_LOG_KEEP_LINES;
	if (typeof cfg?.keepLines === "number" && Number.isFinite(cfg.keepLines) && cfg.keepLines > 0) keepLines = Math.floor(cfg.keepLines);
	return {
		maxBytes,
		keepLines
	};
}
async function drainPendingWrite(filePath) {
	const resolved = path.resolve(filePath);
	const pending = writesByPath.get(resolved);
	if (pending) await pending.catch(() => void 0);
}
async function pruneIfNeeded(filePath, opts) {
	const stat = await fs$1.stat(filePath).catch(() => null);
	if (!stat || stat.size <= opts.maxBytes) return;
	const lines = (await fs$1.readFile(filePath, "utf-8").catch(() => "")).split("\n").map((l) => l.trim()).filter(Boolean);
	const kept = lines.slice(Math.max(0, lines.length - opts.keepLines));
	const { randomBytes } = await import("node:crypto");
	const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	await fs$1.writeFile(tmp, `${kept.join("\n")}\n`, {
		encoding: "utf-8",
		mode: 384
	});
	await setSecureFileMode(tmp);
	await fs$1.rename(tmp, filePath);
	await setSecureFileMode(filePath);
}
async function appendCronRunLog(filePath, entry, opts) {
	const resolved = path.resolve(filePath);
	const next = (writesByPath.get(resolved) ?? Promise.resolve()).catch(() => void 0).then(async () => {
		const runDir = path.dirname(resolved);
		await fs$1.mkdir(runDir, {
			recursive: true,
			mode: 448
		});
		await fs$1.chmod(runDir, 448).catch(() => void 0);
		await fs$1.appendFile(resolved, `${JSON.stringify(entry)}\n`, {
			encoding: "utf-8",
			mode: 384
		});
		await setSecureFileMode(resolved);
		await pruneIfNeeded(resolved, {
			maxBytes: opts?.maxBytes ?? 2e6,
			keepLines: opts?.keepLines ?? 2e3
		});
	});
	writesByPath.set(resolved, next);
	try {
		await next;
	} finally {
		if (writesByPath.get(resolved) === next) writesByPath.delete(resolved);
	}
}
function normalizeRunStatusFilter(status) {
	if (status === "ok" || status === "error" || status === "skipped" || status === "all") return status;
	return "all";
}
function normalizeRunStatuses(opts) {
	if (Array.isArray(opts?.statuses) && opts.statuses.length > 0) {
		const filtered = opts.statuses.filter((status) => status === "ok" || status === "error" || status === "skipped");
		if (filtered.length > 0) return Array.from(new Set(filtered));
	}
	const status = normalizeRunStatusFilter(opts?.status);
	if (status === "all") return null;
	return [status];
}
function normalizeDeliveryStatuses(opts) {
	if (Array.isArray(opts?.deliveryStatuses) && opts.deliveryStatuses.length > 0) {
		const filtered = opts.deliveryStatuses.filter((status) => status === "delivered" || status === "not-delivered" || status === "unknown" || status === "not-requested");
		if (filtered.length > 0) return Array.from(new Set(filtered));
	}
	if (opts?.deliveryStatus === "delivered" || opts?.deliveryStatus === "not-delivered" || opts?.deliveryStatus === "unknown" || opts?.deliveryStatus === "not-requested") return [opts.deliveryStatus];
	return null;
}
function parseAllRunLogEntries(raw, opts) {
	const jobId = opts?.jobId?.trim() || void 0;
	if (!raw.trim()) return [];
	const parsed = [];
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (!line) continue;
		try {
			const obj = JSON.parse(line);
			if (!obj || typeof obj !== "object") continue;
			if (obj.action !== "finished") continue;
			if (typeof obj.jobId !== "string" || obj.jobId.trim().length === 0) continue;
			if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) continue;
			if (jobId && obj.jobId !== jobId) continue;
			const usage = obj.usage && typeof obj.usage === "object" ? obj.usage : void 0;
			const entry = {
				ts: obj.ts,
				jobId: obj.jobId,
				action: "finished",
				status: obj.status,
				error: obj.error,
				summary: obj.summary,
				runAtMs: obj.runAtMs,
				durationMs: obj.durationMs,
				nextRunAtMs: obj.nextRunAtMs,
				model: typeof obj.model === "string" && obj.model.trim() ? obj.model : void 0,
				provider: typeof obj.provider === "string" && obj.provider.trim() ? obj.provider : void 0,
				usage: usage ? {
					input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : void 0,
					output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : void 0,
					total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : void 0,
					cache_read_tokens: typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : void 0,
					cache_write_tokens: typeof usage.cache_write_tokens === "number" ? usage.cache_write_tokens : void 0
				} : void 0
			};
			if (typeof obj.delivered === "boolean") entry.delivered = obj.delivered;
			if (obj.deliveryStatus === "delivered" || obj.deliveryStatus === "not-delivered" || obj.deliveryStatus === "unknown" || obj.deliveryStatus === "not-requested") entry.deliveryStatus = obj.deliveryStatus;
			if (typeof obj.deliveryError === "string") entry.deliveryError = obj.deliveryError;
			if (typeof obj.sessionId === "string" && obj.sessionId.trim().length > 0) entry.sessionId = obj.sessionId;
			if (typeof obj.sessionKey === "string" && obj.sessionKey.trim().length > 0) entry.sessionKey = obj.sessionKey;
			parsed.push(entry);
		} catch {}
	}
	return parsed;
}
function filterRunLogEntries(entries, opts) {
	return entries.filter((entry) => {
		if (opts.statuses && (!entry.status || !opts.statuses.includes(entry.status))) return false;
		if (opts.deliveryStatuses) {
			const deliveryStatus = entry.deliveryStatus ?? "not-requested";
			if (!opts.deliveryStatuses.includes(deliveryStatus)) return false;
		}
		if (!opts.query) return true;
		return opts.queryTextForEntry(entry).toLowerCase().includes(opts.query);
	});
}
async function readCronRunLogEntriesPage(filePath, opts) {
	await drainPendingWrite(filePath);
	const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 50)));
	const raw = await fs$1.readFile(path.resolve(filePath), "utf-8").catch(() => "");
	const statuses = normalizeRunStatuses(opts);
	const deliveryStatuses = normalizeDeliveryStatuses(opts);
	const query = opts?.query?.trim().toLowerCase() ?? "";
	const sortDir = opts?.sortDir === "asc" ? "asc" : "desc";
	const filtered = filterRunLogEntries(parseAllRunLogEntries(raw, { jobId: opts?.jobId }), {
		statuses,
		deliveryStatuses,
		query,
		queryTextForEntry: (entry) => [
			entry.summary ?? "",
			entry.error ?? "",
			entry.jobId
		].join(" ")
	});
	const sorted = sortDir === "asc" ? filtered.toSorted((a, b) => a.ts - b.ts) : filtered.toSorted((a, b) => b.ts - a.ts);
	const total = sorted.length;
	const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
	const entries = sorted.slice(offset, offset + limit);
	const nextOffset = offset + entries.length;
	return {
		entries,
		total,
		offset,
		limit,
		hasMore: nextOffset < total,
		nextOffset: nextOffset < total ? nextOffset : null
	};
}
async function readCronRunLogEntriesPageAll(opts) {
	const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
	const statuses = normalizeRunStatuses(opts);
	const deliveryStatuses = normalizeDeliveryStatuses(opts);
	const query = opts.query?.trim().toLowerCase() ?? "";
	const sortDir = opts.sortDir === "asc" ? "asc" : "desc";
	const runsDir = path.resolve(path.dirname(path.resolve(opts.storePath)), "runs");
	const jsonlFiles = (await fs$1.readdir(runsDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => path.join(runsDir, entry.name));
	if (jsonlFiles.length === 0) return {
		entries: [],
		total: 0,
		offset: 0,
		limit,
		hasMore: false,
		nextOffset: null
	};
	await Promise.all(jsonlFiles.map((f) => drainPendingWrite(f)));
	const filtered = filterRunLogEntries((await Promise.all(jsonlFiles.map(async (filePath) => {
		return parseAllRunLogEntries(await fs$1.readFile(filePath, "utf-8").catch(() => ""));
	}))).flat(), {
		statuses,
		deliveryStatuses,
		query,
		queryTextForEntry: (entry) => {
			const jobName = opts.jobNameById?.[entry.jobId] ?? "";
			return [
				entry.summary ?? "",
				entry.error ?? "",
				entry.jobId,
				jobName
			].join(" ");
		}
	});
	const sorted = sortDir === "asc" ? filtered.toSorted((a, b) => a.ts - b.ts) : filtered.toSorted((a, b) => b.ts - a.ts);
	const total = sorted.length;
	const offset = Math.max(0, Math.min(total, Math.floor(opts.offset ?? 0)));
	const entries = sorted.slice(offset, offset + limit);
	if (opts.jobNameById) for (const entry of entries) {
		const jobName = opts.jobNameById[entry.jobId];
		if (jobName) entry.jobName = jobName;
	}
	const nextOffset = offset + entries.length;
	return {
		entries,
		total,
		offset,
		limit,
		hasMore: nextOffset < total,
		nextOffset: nextOffset < total ? nextOffset : null
	};
}
//#endregion
//#region src/cron/service/initial-delivery.ts
function normalizeCronCreateDeliveryInput(input) {
	const payloadRecord = input.payload && typeof input.payload === "object" ? { ...input.payload } : null;
	const normalizedLegacy = normalizeLegacyDeliveryInput({
		delivery: input.delivery && typeof input.delivery === "object" ? { ...input.delivery } : null,
		payload: payloadRecord
	});
	if (!normalizedLegacy.mutated) return input;
	return {
		...input,
		payload: payloadRecord ? payloadRecord : input.payload,
		delivery: normalizedLegacy.delivery ?? input.delivery
	};
}
function resolveInitialCronDelivery(input) {
	if (input.delivery) return input.delivery;
	if (input.sessionTarget === "isolated" && input.payload.kind === "agentTurn") return { mode: "announce" };
}
//#endregion
//#region src/cron/service/jobs.ts
init_session_key();
const STUCK_RUN_MS = 7200 * 1e3;
const STAGGER_OFFSET_CACHE_MAX = 4096;
const staggerOffsetCache = /* @__PURE__ */ new Map();
function isFiniteTimestamp(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function resolveStableCronOffsetMs(jobId, staggerMs) {
	if (staggerMs <= 1) return 0;
	const cacheKey = `${staggerMs}:${jobId}`;
	const cached = staggerOffsetCache.get(cacheKey);
	if (cached !== void 0) return cached;
	const offset = crypto.createHash("sha256").update(jobId).digest().readUInt32BE(0) % staggerMs;
	if (staggerOffsetCache.size >= STAGGER_OFFSET_CACHE_MAX) {
		const first = staggerOffsetCache.keys().next();
		if (!first.done) staggerOffsetCache.delete(first.value);
	}
	staggerOffsetCache.set(cacheKey, offset);
	return offset;
}
function computeStaggeredCronNextRunAtMs(job, nowMs) {
	if (job.schedule.kind !== "cron") return computeNextRunAtMs(job.schedule, nowMs);
	const staggerMs = resolveCronStaggerMs(job.schedule);
	const offsetMs = resolveStableCronOffsetMs(job.id, staggerMs);
	if (offsetMs <= 0) return computeNextRunAtMs(job.schedule, nowMs);
	let cursorMs = Math.max(0, nowMs - offsetMs);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const baseNext = computeNextRunAtMs(job.schedule, cursorMs);
		if (baseNext === void 0) return;
		const shifted = baseNext + offsetMs;
		if (shifted > nowMs) return shifted;
		cursorMs = Math.max(cursorMs + 1, baseNext + 1e3);
	}
}
function computeStaggeredCronPreviousRunAtMs(job, nowMs) {
	if (job.schedule.kind !== "cron") return;
	const staggerMs = resolveCronStaggerMs(job.schedule);
	const offsetMs = resolveStableCronOffsetMs(job.id, staggerMs);
	if (offsetMs <= 0) return computePreviousRunAtMs(job.schedule, nowMs);
	let cursorMs = Math.max(0, nowMs - offsetMs);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const basePrevious = computePreviousRunAtMs(job.schedule, cursorMs);
		if (basePrevious === void 0) return;
		const shifted = basePrevious + offsetMs;
		if (shifted <= nowMs) return shifted;
		cursorMs = Math.max(0, basePrevious - 1e3);
	}
}
function resolveEveryAnchorMs(params) {
	const coerced = coerceFiniteScheduleNumber(params.schedule.anchorMs);
	if (coerced !== void 0) return Math.max(0, Math.floor(coerced));
	if (isFiniteTimestamp(params.fallbackAnchorMs)) return Math.max(0, Math.floor(params.fallbackAnchorMs));
	return 0;
}
function assertSupportedJobSpec(job) {
	const isIsolatedLike = job.sessionTarget === "isolated" || job.sessionTarget === "current" || job.sessionTarget.startsWith("session:");
	if (job.sessionTarget === "main" && job.payload.kind !== "systemEvent") throw new Error("main cron jobs require payload.kind=\"systemEvent\"");
	if (isIsolatedLike && job.payload.kind !== "agentTurn") throw new Error("isolated/current/session cron jobs require payload.kind=\"agentTurn\"");
}
function assertMainSessionAgentId(job, defaultAgentId) {
	if (job.sessionTarget !== "main") return;
	if (!job.agentId) return;
	if (normalizeAgentId(job.agentId) !== normalizeAgentId(defaultAgentId)) throw new Error(`cron: sessionTarget "main" is only valid for the default agent. Use sessionTarget "isolated" with payload.kind "agentTurn" for non-default agents (agentId: ${job.agentId})`);
}
const TELEGRAM_TME_URL_REGEX = /^https?:\/\/t\.me\/|t\.me\//i;
const TELEGRAM_SLASH_TOPIC_REGEX = /^-?\d+\/\d+$/;
function validateTelegramDeliveryTarget(to) {
	if (!to) return;
	const trimmed = to.trim();
	if (TELEGRAM_TME_URL_REGEX.test(trimmed)) return;
	if (TELEGRAM_SLASH_TOPIC_REGEX.test(trimmed)) return `Invalid Telegram delivery target "${to}". Use colon (:) as delimiter for topics, not slash. Valid formats: -1001234567890, -1001234567890:123, -1001234567890:topic:123, @username, https://t.me/username`;
}
function assertDeliverySupport(job) {
	if (!job.delivery || job.delivery.mode === "none") return;
	if (job.delivery.mode === "webhook") {
		const target = normalizeHttpWebhookUrl(job.delivery.to);
		if (!target) throw new Error("cron webhook delivery requires delivery.to to be a valid http(s) URL");
		job.delivery.to = target;
		return;
	}
	if (!(job.sessionTarget === "isolated" || job.sessionTarget === "current" || job.sessionTarget.startsWith("session:"))) throw new Error("cron channel delivery config is only supported for sessionTarget=\"isolated\"");
	if (job.delivery.channel === "telegram") {
		const telegramError = validateTelegramDeliveryTarget(job.delivery.to);
		if (telegramError) throw new Error(telegramError);
	}
}
function assertFailureDestinationSupport(job) {
	const failureDestination = job.delivery?.failureDestination;
	if (!failureDestination) return;
	if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook") throw new Error("cron delivery.failureDestination is only supported for sessionTarget=\"isolated\" unless delivery.mode=\"webhook\"");
	if (failureDestination.mode === "webhook") {
		const target = normalizeHttpWebhookUrl(failureDestination.to);
		if (!target) throw new Error("cron failure destination webhook requires delivery.failureDestination.to to be a valid http(s) URL");
		failureDestination.to = target;
	}
}
function findJobOrThrow(state, id) {
	const job = state.store?.jobs.find((j) => j.id === id);
	if (!job) throw new Error(`unknown cron job id: ${id}`);
	return job;
}
function computeJobNextRunAtMs(job, nowMs) {
	if (!job.enabled) return;
	if (job.schedule.kind === "every") {
		const everyMsRaw = coerceFiniteScheduleNumber(job.schedule.everyMs);
		if (everyMsRaw === void 0) return;
		const everyMs = Math.max(1, Math.floor(everyMsRaw));
		const lastRunAtMs = job.state.lastRunAtMs;
		if (typeof lastRunAtMs === "number" && Number.isFinite(lastRunAtMs)) {
			const nextFromLastRun = Math.floor(lastRunAtMs) + everyMs;
			if (nextFromLastRun > nowMs) return nextFromLastRun;
		}
		const fallbackAnchorMs = isFiniteTimestamp(job.createdAtMs) ? job.createdAtMs : nowMs;
		const anchorMs = resolveEveryAnchorMs({
			schedule: job.schedule,
			fallbackAnchorMs
		});
		const next = computeNextRunAtMs({
			...job.schedule,
			everyMs,
			anchorMs
		}, nowMs);
		return isFiniteTimestamp(next) ? next : void 0;
	}
	if (job.schedule.kind === "at") {
		const schedule = job.schedule;
		const atMs = typeof schedule.atMs === "number" && Number.isFinite(schedule.atMs) && schedule.atMs > 0 ? schedule.atMs : typeof schedule.atMs === "string" ? parseAbsoluteTimeMs(schedule.atMs) : typeof schedule.at === "string" ? parseAbsoluteTimeMs(schedule.at) : null;
		if (job.state.lastStatus === "ok" && job.state.lastRunAtMs) {
			if (atMs !== null && Number.isFinite(atMs) && atMs > job.state.lastRunAtMs) return atMs;
			return;
		}
		return atMs !== null && Number.isFinite(atMs) ? atMs : void 0;
	}
	const next = computeStaggeredCronNextRunAtMs(job, nowMs);
	if (next === void 0 && job.schedule.kind === "cron") return computeStaggeredCronNextRunAtMs(job, Math.floor(nowMs / 1e3) * 1e3 + 1e3);
	return isFiniteTimestamp(next) ? next : void 0;
}
function computeJobPreviousRunAtMs(job, nowMs) {
	if (!job.enabled || job.schedule.kind !== "cron") return;
	const previous = computeStaggeredCronPreviousRunAtMs(job, nowMs);
	return isFiniteTimestamp(previous) ? previous : void 0;
}
/** Maximum consecutive schedule errors before auto-disabling a job. */
const MAX_SCHEDULE_ERRORS = 3;
function recordScheduleComputeError(params) {
	const { state, job, err } = params;
	const errorCount = (job.state.scheduleErrorCount ?? 0) + 1;
	const errText = String(err);
	job.state.scheduleErrorCount = errorCount;
	job.state.nextRunAtMs = void 0;
	job.state.lastError = `schedule error: ${errText}`;
	if (errorCount >= MAX_SCHEDULE_ERRORS) {
		job.enabled = false;
		state.deps.log.error({
			jobId: job.id,
			name: job.name,
			errorCount,
			err: errText
		}, "cron: auto-disabled job after repeated schedule errors");
		const notifyText = `⚠️ Cron job "${job.name}" has been auto-disabled after ${errorCount} consecutive schedule errors. Last error: ${errText}`;
		state.deps.enqueueSystemEvent(notifyText, {
			agentId: job.agentId,
			sessionKey: job.sessionKey,
			contextKey: `cron:${job.id}:auto-disabled`
		});
		state.deps.requestHeartbeatNow({
			reason: `cron:${job.id}:auto-disabled`,
			agentId: job.agentId,
			sessionKey: job.sessionKey
		});
	} else state.deps.log.warn({
		jobId: job.id,
		name: job.name,
		errorCount,
		err: errText
	}, "cron: failed to compute next run for job (skipping)");
	return true;
}
function normalizeJobTickState(params) {
	const { state, job, nowMs } = params;
	let changed = false;
	if (!job.state) {
		job.state = {};
		changed = true;
	}
	if (!job.enabled) {
		if (job.state.nextRunAtMs !== void 0) {
			job.state.nextRunAtMs = void 0;
			changed = true;
		}
		if (job.state.runningAtMs !== void 0) {
			job.state.runningAtMs = void 0;
			changed = true;
		}
		return {
			changed,
			skip: true
		};
	}
	if (!isFiniteTimestamp(job.state.nextRunAtMs) && job.state.nextRunAtMs !== void 0) {
		job.state.nextRunAtMs = void 0;
		changed = true;
	}
	const runningAt = job.state.runningAtMs;
	if (typeof runningAt === "number" && nowMs - runningAt > STUCK_RUN_MS) {
		state.deps.log.warn({
			jobId: job.id,
			runningAtMs: runningAt
		}, "cron: clearing stuck running marker");
		job.state.runningAtMs = void 0;
		changed = true;
	}
	return {
		changed,
		skip: false
	};
}
function walkSchedulableJobs(state, fn, nowMs = state.deps.nowMs()) {
	if (!state.store) return false;
	let changed = false;
	for (const job of state.store.jobs) {
		const tick = normalizeJobTickState({
			state,
			job,
			nowMs
		});
		if (tick.changed) changed = true;
		if (tick.skip) continue;
		if (fn({
			job,
			nowMs
		})) changed = true;
	}
	return changed;
}
function recomputeJobNextRunAtMs(params) {
	let changed = false;
	try {
		const newNext = computeJobNextRunAtMs(params.job, params.nowMs);
		if (params.job.state.nextRunAtMs !== newNext) {
			params.job.state.nextRunAtMs = newNext;
			changed = true;
		}
		if (params.job.state.scheduleErrorCount) {
			params.job.state.scheduleErrorCount = void 0;
			changed = true;
		}
	} catch (err) {
		if (recordScheduleComputeError({
			state: params.state,
			job: params.job,
			err
		})) changed = true;
	}
	return changed;
}
function recomputeNextRuns(state) {
	return walkSchedulableJobs(state, ({ job, nowMs: now }) => {
		let changed = false;
		const nextRun = job.state.nextRunAtMs;
		if (!isFiniteTimestamp(nextRun) || now >= nextRun) {
			if (recomputeJobNextRunAtMs({
				state,
				job,
				nowMs: now
			})) changed = true;
		}
		return changed;
	});
}
/**
* Maintenance-only version of recomputeNextRuns that handles disabled jobs
* and stuck markers, but does NOT recompute nextRunAtMs for enabled jobs
* with existing values. Used during timer ticks when no due jobs were found
* to prevent silently advancing past-due nextRunAtMs values without execution
* (see #13992).
*/
function recomputeNextRunsForMaintenance(state, opts) {
	const recomputeExpired = opts?.recomputeExpired ?? false;
	return walkSchedulableJobs(state, ({ job, nowMs: now }) => {
		let changed = false;
		if (!isFiniteTimestamp(job.state.nextRunAtMs)) {
			if (recomputeJobNextRunAtMs({
				state,
				job,
				nowMs: now
			})) changed = true;
		} else if (recomputeExpired && now >= job.state.nextRunAtMs && typeof job.state.runningAtMs !== "number") {
			const lastRun = job.state.lastRunAtMs;
			if (isFiniteTimestamp(lastRun) && lastRun >= job.state.nextRunAtMs) {
				if (recomputeJobNextRunAtMs({
					state,
					job,
					nowMs: now
				})) changed = true;
			}
		}
		return changed;
	}, opts?.nowMs);
}
function nextWakeAtMs(state) {
	const enabled = (state.store?.jobs ?? []).filter((j) => j.enabled && isFiniteTimestamp(j.state.nextRunAtMs));
	if (enabled.length === 0) return;
	const first = enabled[0]?.state.nextRunAtMs;
	if (!isFiniteTimestamp(first)) return;
	return enabled.reduce((min, j) => {
		const next = j.state.nextRunAtMs;
		return isFiniteTimestamp(next) ? Math.min(min, next) : min;
	}, first);
}
function createJob(state, input) {
	const now = state.deps.nowMs();
	const id = crypto.randomUUID();
	const schedule = input.schedule.kind === "every" ? {
		...input.schedule,
		anchorMs: resolveEveryAnchorMs({
			schedule: input.schedule,
			fallbackAnchorMs: now
		})
	} : input.schedule.kind === "cron" ? (() => {
		const explicitStaggerMs = normalizeCronStaggerMs(input.schedule.staggerMs);
		if (explicitStaggerMs !== void 0) return {
			...input.schedule,
			staggerMs: explicitStaggerMs
		};
		const defaultStaggerMs = resolveDefaultCronStaggerMs(input.schedule.expr);
		return defaultStaggerMs !== void 0 ? {
			...input.schedule,
			staggerMs: defaultStaggerMs
		} : input.schedule;
	})() : input.schedule;
	const deleteAfterRun = typeof input.deleteAfterRun === "boolean" ? input.deleteAfterRun : schedule.kind === "at" ? true : void 0;
	const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
	const job = {
		id,
		agentId: normalizeOptionalAgentId(input.agentId),
		sessionKey: normalizeOptionalSessionKey(input.sessionKey),
		name: normalizeRequiredName(input.name),
		description: normalizeOptionalText$1(input.description),
		enabled,
		deleteAfterRun,
		createdAtMs: now,
		updatedAtMs: now,
		schedule,
		sessionTarget: input.sessionTarget,
		wakeMode: input.wakeMode,
		payload: input.payload,
		delivery: resolveInitialCronDelivery(input),
		failureAlert: input.failureAlert,
		state: { ...input.state }
	};
	assertSupportedJobSpec(job);
	assertMainSessionAgentId(job, state.deps.defaultAgentId);
	assertDeliverySupport(job);
	assertFailureDestinationSupport(job);
	job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
	return job;
}
function applyJobPatch(job, patch, opts) {
	if ("name" in patch) job.name = normalizeRequiredName(patch.name);
	if ("description" in patch) job.description = normalizeOptionalText$1(patch.description);
	if (typeof patch.enabled === "boolean") job.enabled = patch.enabled;
	if (typeof patch.deleteAfterRun === "boolean") job.deleteAfterRun = patch.deleteAfterRun;
	if (patch.schedule) if (patch.schedule.kind === "cron") {
		const explicitStaggerMs = normalizeCronStaggerMs(patch.schedule.staggerMs);
		if (explicitStaggerMs !== void 0) job.schedule = {
			...patch.schedule,
			staggerMs: explicitStaggerMs
		};
		else if (job.schedule.kind === "cron") job.schedule = {
			...patch.schedule,
			staggerMs: job.schedule.staggerMs
		};
		else {
			const defaultStaggerMs = resolveDefaultCronStaggerMs(patch.schedule.expr);
			job.schedule = defaultStaggerMs !== void 0 ? {
				...patch.schedule,
				staggerMs: defaultStaggerMs
			} : patch.schedule;
		}
	} else job.schedule = patch.schedule;
	if (patch.sessionTarget) job.sessionTarget = patch.sessionTarget;
	if (patch.wakeMode) job.wakeMode = patch.wakeMode;
	if (patch.payload) job.payload = mergeCronPayload(job.payload, patch.payload);
	if (!patch.delivery && patch.payload?.kind === "agentTurn") {
		const legacyDeliveryPatch = buildLegacyDeliveryPatch(patch.payload);
		const isIsolatedLike = job.sessionTarget === "isolated" || job.sessionTarget === "current" || job.sessionTarget.startsWith("session:");
		if (legacyDeliveryPatch && isIsolatedLike && job.payload.kind === "agentTurn") job.delivery = mergeCronDelivery(job.delivery, legacyDeliveryPatch);
	}
	if (patch.delivery) job.delivery = mergeCronDelivery(job.delivery, patch.delivery);
	if ("failureAlert" in patch) job.failureAlert = mergeCronFailureAlert(job.failureAlert, patch.failureAlert);
	if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook" && job.delivery?.failureDestination) throw new Error("cron delivery.failureDestination is only supported for sessionTarget=\"isolated\" unless delivery.mode=\"webhook\"");
	if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook") job.delivery = void 0;
	if (patch.state) job.state = {
		...job.state,
		...patch.state
	};
	if ("agentId" in patch) job.agentId = normalizeOptionalAgentId(patch.agentId);
	if ("sessionKey" in patch) job.sessionKey = normalizeOptionalSessionKey(patch.sessionKey);
	assertSupportedJobSpec(job);
	assertMainSessionAgentId(job, opts?.defaultAgentId);
	assertDeliverySupport(job);
	assertFailureDestinationSupport(job);
}
function mergeCronPayload(existing, patch) {
	if (patch.kind !== existing.kind) return buildPayloadFromPatch(patch);
	if (patch.kind === "systemEvent") {
		if (existing.kind !== "systemEvent") return buildPayloadFromPatch(patch);
		return {
			kind: "systemEvent",
			text: typeof patch.text === "string" ? patch.text : existing.text
		};
	}
	if (existing.kind !== "agentTurn") return buildPayloadFromPatch(patch);
	const next = { ...existing };
	if (typeof patch.message === "string") next.message = patch.message;
	if (typeof patch.model === "string") next.model = patch.model;
	if (typeof patch.thinking === "string") next.thinking = patch.thinking;
	if (typeof patch.timeoutSeconds === "number") next.timeoutSeconds = patch.timeoutSeconds;
	if (typeof patch.lightContext === "boolean") next.lightContext = patch.lightContext;
	if (typeof patch.allowUnsafeExternalContent === "boolean") next.allowUnsafeExternalContent = patch.allowUnsafeExternalContent;
	if (typeof patch.deliver === "boolean") next.deliver = patch.deliver;
	if (typeof patch.channel === "string") next.channel = patch.channel;
	if (typeof patch.to === "string") next.to = patch.to;
	if (typeof patch.bestEffortDeliver === "boolean") next.bestEffortDeliver = patch.bestEffortDeliver;
	return next;
}
function buildLegacyDeliveryPatch(payload) {
	const deliver = payload.deliver;
	const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
	if (!(typeof deliver === "boolean" || typeof payload.bestEffortDeliver === "boolean" || Boolean(toRaw))) return null;
	const patch = {};
	let hasPatch = false;
	if (deliver === false) {
		patch.mode = "none";
		hasPatch = true;
	} else if (deliver === true || toRaw) {
		patch.mode = "announce";
		hasPatch = true;
	}
	if (typeof payload.channel === "string") {
		const channel = payload.channel.trim().toLowerCase();
		patch.channel = channel ? channel : void 0;
		hasPatch = true;
	}
	if (typeof payload.to === "string") {
		patch.to = payload.to.trim();
		hasPatch = true;
	}
	if (typeof payload.bestEffortDeliver === "boolean") {
		patch.bestEffort = payload.bestEffortDeliver;
		hasPatch = true;
	}
	return hasPatch ? patch : null;
}
function buildPayloadFromPatch(patch) {
	if (patch.kind === "systemEvent") {
		if (typeof patch.text !== "string" || patch.text.length === 0) throw new Error("cron.update payload.kind=\"systemEvent\" requires text");
		return {
			kind: "systemEvent",
			text: patch.text
		};
	}
	if (typeof patch.message !== "string" || patch.message.length === 0) throw new Error("cron.update payload.kind=\"agentTurn\" requires message");
	return {
		kind: "agentTurn",
		message: patch.message,
		model: patch.model,
		thinking: patch.thinking,
		timeoutSeconds: patch.timeoutSeconds,
		lightContext: patch.lightContext,
		allowUnsafeExternalContent: patch.allowUnsafeExternalContent,
		deliver: patch.deliver,
		channel: patch.channel,
		to: patch.to,
		bestEffortDeliver: patch.bestEffortDeliver
	};
}
function normalizeOptionalTrimmedString(value) {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed ? trimmed : void 0;
}
function mergeCronDelivery(existing, patch) {
	const next = {
		mode: existing?.mode ?? "none",
		channel: existing?.channel,
		to: existing?.to,
		accountId: existing?.accountId,
		bestEffort: existing?.bestEffort,
		failureDestination: existing?.failureDestination
	};
	if (typeof patch.mode === "string") next.mode = patch.mode === "deliver" ? "announce" : patch.mode;
	if ("channel" in patch) next.channel = normalizeOptionalTrimmedString(patch.channel);
	if ("to" in patch) next.to = normalizeOptionalTrimmedString(patch.to);
	if ("accountId" in patch) next.accountId = normalizeOptionalTrimmedString(patch.accountId);
	if (typeof patch.bestEffort === "boolean") next.bestEffort = patch.bestEffort;
	if ("failureDestination" in patch) if (patch.failureDestination === void 0) next.failureDestination = void 0;
	else {
		const existingFd = next.failureDestination;
		const patchFd = patch.failureDestination;
		const nextFd = {
			channel: existingFd?.channel,
			to: existingFd?.to,
			accountId: existingFd?.accountId,
			mode: existingFd?.mode
		};
		if (patchFd) {
			if ("channel" in patchFd) {
				const channel = typeof patchFd.channel === "string" ? patchFd.channel.trim() : "";
				nextFd.channel = channel ? channel : void 0;
			}
			if ("to" in patchFd) {
				const to = typeof patchFd.to === "string" ? patchFd.to.trim() : "";
				nextFd.to = to ? to : void 0;
			}
			if ("accountId" in patchFd) {
				const accountId = typeof patchFd.accountId === "string" ? patchFd.accountId.trim() : "";
				nextFd.accountId = accountId ? accountId : void 0;
			}
			if ("mode" in patchFd) {
				const mode = typeof patchFd.mode === "string" ? patchFd.mode.trim() : "";
				nextFd.mode = mode === "announce" || mode === "webhook" ? mode : void 0;
			}
		}
		next.failureDestination = nextFd;
	}
	return next;
}
function mergeCronFailureAlert(existing, patch) {
	if (patch === false) return false;
	if (patch === void 0) return existing;
	const next = { ...existing === false || existing === void 0 ? {} : existing };
	if ("after" in patch) {
		const after = typeof patch.after === "number" && Number.isFinite(patch.after) ? patch.after : 0;
		next.after = after > 0 ? Math.floor(after) : void 0;
	}
	if ("channel" in patch) next.channel = normalizeOptionalTrimmedString(patch.channel);
	if ("to" in patch) next.to = normalizeOptionalTrimmedString(patch.to);
	if ("cooldownMs" in patch) {
		const cooldownMs = typeof patch.cooldownMs === "number" && Number.isFinite(patch.cooldownMs) ? patch.cooldownMs : -1;
		next.cooldownMs = cooldownMs >= 0 ? Math.floor(cooldownMs) : void 0;
	}
	if ("mode" in patch) {
		const mode = typeof patch.mode === "string" ? patch.mode.trim() : "";
		next.mode = mode === "announce" || mode === "webhook" ? mode : void 0;
	}
	if ("accountId" in patch) {
		const accountId = typeof patch.accountId === "string" ? patch.accountId.trim() : "";
		next.accountId = accountId ? accountId : void 0;
	}
	return next;
}
function isJobDue(job, nowMs, opts) {
	if (!job.state) job.state = {};
	if (typeof job.state.runningAtMs === "number") return false;
	if (opts.forced) return true;
	return job.enabled && typeof job.state.nextRunAtMs === "number" && nowMs >= job.state.nextRunAtMs;
}
function resolveJobPayloadTextForMain(job) {
	if (job.payload.kind !== "systemEvent") return;
	const text = normalizePayloadToSystemText(job.payload);
	return text.trim() ? text : void 0;
}
//#endregion
//#region src/cron/service/locked.ts
const storeLocks = /* @__PURE__ */ new Map();
const resolveChain = (promise) => promise.then(() => void 0, () => void 0);
async function locked(state, fn) {
	const storePath = state.deps.storePath;
	const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
	const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(fn);
	const keepAlive = resolveChain(next);
	state.op = keepAlive;
	storeLocks.set(storePath, keepAlive);
	return await next;
}
//#endregion
//#region src/cron/service/store.ts
async function getFileMtimeMs(path) {
	try {
		return (await fs.promises.stat(path)).mtimeMs;
	} catch {
		return null;
	}
}
async function ensureLoaded(state, opts) {
	if (state.store && !opts?.forceReload) return;
	const fileMtimeMs = await getFileMtimeMs(state.deps.storePath);
	const jobs = (await loadCronStore(state.deps.storePath)).jobs ?? [];
	const { mutated } = normalizeStoredCronJobs(jobs);
	state.store = {
		version: 1,
		jobs
	};
	state.storeLoadedAtMs = state.deps.nowMs();
	state.storeFileMtimeMs = fileMtimeMs;
	if (!opts?.skipRecompute) recomputeNextRuns(state);
	if (mutated) await persist(state, { skipBackup: true });
}
function warnIfDisabled(state, action) {
	if (state.deps.cronEnabled) return;
	if (state.warnedDisabled) return;
	state.warnedDisabled = true;
	state.deps.log.warn({
		enabled: false,
		action,
		storePath: state.deps.storePath
	}, "cron: scheduler disabled; jobs will not run automatically");
}
async function persist(state, opts) {
	if (!state.store) return;
	await saveCronStore(state.deps.storePath, state.store, opts);
	state.storeFileMtimeMs = await getFileMtimeMs(state.deps.storePath);
}
//#endregion
//#region src/cron/session-reaper.ts
/**
* Cron session reaper — prunes completed isolated cron run sessions
* from the session store after a configurable retention period.
*
* Pattern: sessions keyed as `...:cron:<jobId>:run:<uuid>` are ephemeral
* run records. The base session (`...:cron:<jobId>`) is kept as-is.
*/
const DEFAULT_RETENTION_MS = 24 * 36e5;
/** Minimum interval between reaper sweeps (avoid running every timer tick). */
const MIN_SWEEP_INTERVAL_MS = 5 * 6e4;
const lastSweepAtMsByStore = /* @__PURE__ */ new Map();
function resolveRetentionMs(cronConfig) {
	if (cronConfig?.sessionRetention === false) return null;
	const raw = cronConfig?.sessionRetention;
	if (typeof raw === "string" && raw.trim()) try {
		return parseDurationMs(raw.trim(), { defaultUnit: "h" });
	} catch {
		return DEFAULT_RETENTION_MS;
	}
	return DEFAULT_RETENTION_MS;
}
/**
* Sweep the session store and prune expired cron run sessions.
* Designed to be called from the cron timer tick — self-throttles via
* MIN_SWEEP_INTERVAL_MS to avoid excessive I/O.
*
* Lock ordering: this function acquires the session-store file lock via
* `updateSessionStore`. It must be called OUTSIDE of the cron service's
* own `locked()` section to avoid lock-order inversions. The cron timer
* calls this after all `locked()` sections have been released.
*/
async function sweepCronRunSessions(params) {
	const now = params.nowMs ?? Date.now();
	const storePath = params.sessionStorePath;
	const lastSweepAtMs = lastSweepAtMsByStore.get(storePath) ?? 0;
	if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) return {
		swept: false,
		pruned: 0
	};
	const retentionMs = resolveRetentionMs(params.cronConfig);
	if (retentionMs === null) {
		lastSweepAtMsByStore.set(storePath, now);
		return {
			swept: false,
			pruned: 0
		};
	}
	let pruned = 0;
	const prunedSessions = /* @__PURE__ */ new Map();
	try {
		await updateSessionStore(storePath, (store) => {
			const cutoff = now - retentionMs;
			for (const key of Object.keys(store)) {
				if (!isCronRunSessionKey(key)) continue;
				const entry = store[key];
				if (!entry) continue;
				if ((entry.updatedAt ?? 0) < cutoff) {
					if (!prunedSessions.has(entry.sessionId) || entry.sessionFile) prunedSessions.set(entry.sessionId, entry.sessionFile);
					delete store[key];
					pruned++;
				}
			}
		});
	} catch (err) {
		params.log.warn({ err: String(err) }, "cron-reaper: failed to sweep session store");
		return {
			swept: false,
			pruned: 0
		};
	}
	lastSweepAtMsByStore.set(storePath, now);
	if (prunedSessions.size > 0) try {
		const store = loadSessionStore(storePath, { skipCache: true });
		const archivedDirs = archiveRemovedSessionTranscripts({
			removedSessionFiles: prunedSessions,
			referencedSessionIds: new Set(Object.values(store).map((entry) => entry?.sessionId).filter((id) => Boolean(id))),
			storePath,
			reason: "deleted",
			restrictToStoreDir: true
		});
		if (archivedDirs.size > 0) await cleanupArchivedSessionTranscripts({
			directories: [...archivedDirs],
			olderThanMs: retentionMs,
			reason: "deleted",
			nowMs: now
		});
	} catch (err) {
		params.log.warn({ err: String(err) }, "cron-reaper: transcript cleanup failed");
	}
	if (pruned > 0) params.log.info({
		pruned,
		retentionMs
	}, `cron-reaper: pruned ${pruned} expired cron run session(s)`);
	return {
		swept: true,
		pruned
	};
}
//#endregion
//#region src/cron/service/timeout-policy.ts
/**
* Maximum wall-clock time for a single job execution. Acts as a safety net
* on top of per-provider/per-agent timeouts to prevent one stuck job from
* wedging the entire cron lane.
*/
const DEFAULT_JOB_TIMEOUT_MS = 10 * 6e4;
/**
* Agent turns can legitimately run much longer than generic cron jobs.
* Use a larger safety ceiling when no explicit timeout is set.
*/
const AGENT_TURN_SAFETY_TIMEOUT_MS = 60 * 6e4;
function resolveCronJobTimeoutMs(job) {
	const configuredTimeoutMs = job.payload.kind === "agentTurn" && typeof job.payload.timeoutSeconds === "number" ? Math.floor(job.payload.timeoutSeconds * 1e3) : void 0;
	if (configuredTimeoutMs === void 0) return job.payload.kind === "agentTurn" ? AGENT_TURN_SAFETY_TIMEOUT_MS : DEFAULT_JOB_TIMEOUT_MS;
	return configuredTimeoutMs <= 0 ? void 0 : configuredTimeoutMs;
}
//#endregion
//#region src/cron/service/timer.ts
init_session_key();
const MAX_TIMER_DELAY_MS = 6e4;
/**
* Minimum gap between consecutive fires of the same cron job.  This is a
* safety net that prevents spin-loops when `computeJobNextRunAtMs` returns
* a value within the same second as the just-completed run.  The guard
* is intentionally generous (2 s) so it never masks a legitimate schedule
* but always breaks an infinite re-trigger cycle.  (See #17821)
*/
const MIN_REFIRE_GAP_MS = 2e3;
const DEFAULT_MISSED_JOB_STAGGER_MS = 5e3;
const DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5;
const DEFAULT_FAILURE_ALERT_AFTER = 2;
const DEFAULT_FAILURE_ALERT_COOLDOWN_MS = 60 * 6e4;
async function executeJobCoreWithTimeout(state, job) {
	const jobTimeoutMs = resolveCronJobTimeoutMs(job);
	if (typeof jobTimeoutMs !== "number") return await executeJobCore(state, job);
	const runAbortController = new AbortController();
	let timeoutId;
	try {
		return await Promise.race([executeJobCore(state, job, runAbortController.signal), new Promise((_, reject) => {
			timeoutId = setTimeout(() => {
				runAbortController.abort(timeoutErrorMessage());
				reject(new Error(timeoutErrorMessage()));
			}, jobTimeoutMs);
		})]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
function resolveRunConcurrency(state) {
	const raw = state.deps.cronConfig?.maxConcurrentRuns;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
	return Math.max(1, Math.floor(raw));
}
function timeoutErrorMessage() {
	return "cron: job execution timed out";
}
function isAbortError(err) {
	if (!(err instanceof Error)) return false;
	return err.name === "AbortError" || err.message === timeoutErrorMessage();
}
/**
* Exponential backoff delays (in ms) indexed by consecutive error count.
* After the last entry the delay stays constant.
*/
const DEFAULT_BACKOFF_SCHEDULE_MS = [
	3e4,
	6e4,
	5 * 6e4,
	15 * 6e4,
	60 * 6e4
];
function errorBackoffMs(consecutiveErrors, scheduleMs = DEFAULT_BACKOFF_SCHEDULE_MS) {
	const idx = Math.min(consecutiveErrors - 1, scheduleMs.length - 1);
	return scheduleMs[Math.max(0, idx)];
}
/** Default max retries for one-shot jobs on transient errors (#24355). */
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;
const TRANSIENT_PATTERNS = {
	rate_limit: /(rate[_ ]limit|too many requests|429|resource has been exhausted|cloudflare|tokens per day)/i,
	overloaded: /\b529\b|\boverloaded(?:_error)?\b|high demand|temporar(?:ily|y) overloaded|capacity exceeded/i,
	network: /(network|econnreset|econnrefused|fetch failed|socket)/i,
	timeout: /(timeout|etimedout)/i,
	server_error: /\b5\d{2}\b/
};
function isTransientCronError(error, retryOn) {
	if (!error || typeof error !== "string") return false;
	return (retryOn?.length ? retryOn : Object.keys(TRANSIENT_PATTERNS)).some((k) => TRANSIENT_PATTERNS[k]?.test(error));
}
function resolveRetryConfig(cronConfig) {
	const retry = cronConfig?.retry;
	return {
		maxAttempts: typeof retry?.maxAttempts === "number" ? retry.maxAttempts : DEFAULT_MAX_TRANSIENT_RETRIES,
		backoffMs: Array.isArray(retry?.backoffMs) && retry.backoffMs.length > 0 ? retry.backoffMs : DEFAULT_BACKOFF_SCHEDULE_MS.slice(0, 3),
		retryOn: Array.isArray(retry?.retryOn) && retry.retryOn.length > 0 ? retry.retryOn : void 0
	};
}
function resolveDeliveryStatus(params) {
	if (params.delivered === true) return "delivered";
	if (params.delivered === false) return "not-delivered";
	return resolveCronDeliveryPlan(params.job).requested ? "unknown" : "not-requested";
}
function normalizeCronMessageChannel(input) {
	if (typeof input !== "string") return;
	const channel = input.trim().toLowerCase();
	return channel ? channel : void 0;
}
function normalizeTo(input) {
	if (typeof input !== "string") return;
	const to = input.trim();
	return to ? to : void 0;
}
function clampPositiveInt(value, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const floored = Math.floor(value);
	return floored >= 1 ? floored : fallback;
}
function clampNonNegativeInt(value, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const floored = Math.floor(value);
	return floored >= 0 ? floored : fallback;
}
function resolveFailureAlert(state, job) {
	const globalConfig = state.deps.cronConfig?.failureAlert;
	const jobConfig = job.failureAlert === false ? void 0 : job.failureAlert;
	if (job.failureAlert === false) return null;
	if (!jobConfig && globalConfig?.enabled !== true) return null;
	const mode = jobConfig?.mode ?? globalConfig?.mode;
	const explicitTo = normalizeTo(jobConfig?.to);
	return {
		after: clampPositiveInt(jobConfig?.after ?? globalConfig?.after, DEFAULT_FAILURE_ALERT_AFTER),
		cooldownMs: clampNonNegativeInt(jobConfig?.cooldownMs ?? globalConfig?.cooldownMs, DEFAULT_FAILURE_ALERT_COOLDOWN_MS),
		channel: normalizeCronMessageChannel(jobConfig?.channel) ?? normalizeCronMessageChannel(job.delivery?.channel) ?? "last",
		to: mode === "webhook" ? explicitTo : explicitTo ?? normalizeTo(job.delivery?.to),
		mode,
		accountId: jobConfig?.accountId ?? globalConfig?.accountId
	};
}
function emitFailureAlert(state, params) {
	const safeJobName = params.job.name || params.job.id;
	const truncatedError = (params.error?.trim() || "unknown error").slice(0, 200);
	const text = [`Cron job "${safeJobName}" failed ${params.consecutiveErrors} times`, `Last error: ${truncatedError}`].join("\n");
	if (state.deps.sendCronFailureAlert) {
		state.deps.sendCronFailureAlert({
			job: params.job,
			text,
			channel: params.channel,
			to: params.to,
			mode: params.mode,
			accountId: params.accountId
		}).catch((err) => {
			state.deps.log.warn({
				jobId: params.job.id,
				err: String(err)
			}, "cron: failure alert delivery failed");
		});
		return;
	}
	state.deps.enqueueSystemEvent(text, { agentId: params.job.agentId });
	if (params.job.wakeMode === "now") state.deps.requestHeartbeatNow({ reason: `cron:${params.job.id}:failure-alert` });
}
/**
* Apply the result of a job execution to the job's state.
* Handles consecutive error tracking, exponential backoff, one-shot disable,
* and nextRunAtMs computation. Returns `true` if the job should be deleted.
*/
function applyJobResult(state, job, result, opts) {
	const prevLastRunAtMs = job.state.lastRunAtMs;
	const computeNextWithPreservedLastRun = (nowMs) => {
		const saved = job.state.lastRunAtMs;
		job.state.lastRunAtMs = prevLastRunAtMs;
		try {
			return computeJobNextRunAtMs(job, nowMs);
		} finally {
			job.state.lastRunAtMs = saved;
		}
	};
	job.state.runningAtMs = void 0;
	job.state.lastRunAtMs = result.startedAt;
	job.state.lastRunStatus = result.status;
	job.state.lastStatus = result.status;
	job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
	job.state.lastError = result.error;
	job.state.lastErrorReason = result.status === "error" && typeof result.error === "string" ? resolveFailoverReasonFromError(result.error) ?? void 0 : void 0;
	job.state.lastDelivered = result.delivered;
	const deliveryStatus = resolveDeliveryStatus({
		job,
		delivered: result.delivered
	});
	job.state.lastDeliveryStatus = deliveryStatus;
	job.state.lastDeliveryError = deliveryStatus === "not-delivered" && result.error ? result.error : void 0;
	job.updatedAtMs = result.endedAt;
	if (result.status === "error") {
		job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
		const alertConfig = resolveFailureAlert(state, job);
		if (alertConfig && job.state.consecutiveErrors >= alertConfig.after) {
			if (!(job.delivery?.bestEffort === true || job.payload.kind === "agentTurn" && job.payload.bestEffortDeliver === true)) {
				const now = state.deps.nowMs();
				const lastAlert = job.state.lastFailureAlertAtMs;
				if (!(typeof lastAlert === "number" && now - lastAlert < Math.max(0, alertConfig.cooldownMs))) {
					emitFailureAlert(state, {
						job,
						error: result.error,
						consecutiveErrors: job.state.consecutiveErrors,
						channel: alertConfig.channel,
						to: alertConfig.to,
						mode: alertConfig.mode,
						accountId: alertConfig.accountId
					});
					job.state.lastFailureAlertAtMs = now;
				}
			}
		}
	} else {
		job.state.consecutiveErrors = 0;
		job.state.lastFailureAlertAtMs = void 0;
	}
	const shouldDelete = job.schedule.kind === "at" && job.deleteAfterRun === true && result.status === "ok";
	if (!shouldDelete) if (job.schedule.kind === "at") {
		if (result.status === "ok" || result.status === "skipped") {
			job.enabled = false;
			job.state.nextRunAtMs = void 0;
		} else if (result.status === "error") {
			const retryConfig = resolveRetryConfig(state.deps.cronConfig);
			const transient = isTransientCronError(result.error, retryConfig.retryOn);
			const consecutive = job.state.consecutiveErrors;
			if (transient && consecutive <= retryConfig.maxAttempts) {
				const backoff = errorBackoffMs(consecutive, retryConfig.backoffMs);
				job.state.nextRunAtMs = result.endedAt + backoff;
				state.deps.log.info({
					jobId: job.id,
					jobName: job.name,
					consecutiveErrors: consecutive,
					backoffMs: backoff,
					nextRunAtMs: job.state.nextRunAtMs
				}, "cron: scheduling one-shot retry after transient error");
			} else {
				job.enabled = false;
				job.state.nextRunAtMs = void 0;
				state.deps.log.warn({
					jobId: job.id,
					jobName: job.name,
					consecutiveErrors: consecutive,
					error: result.error,
					reason: transient ? "max retries exhausted" : "permanent error"
				}, "cron: disabling one-shot job after error");
			}
		}
	} else if (result.status === "error" && job.enabled) {
		const backoff = errorBackoffMs(job.state.consecutiveErrors ?? 1);
		let normalNext;
		try {
			normalNext = opts?.preserveSchedule && job.schedule.kind === "every" ? computeNextWithPreservedLastRun(result.endedAt) : computeJobNextRunAtMs(job, result.endedAt);
		} catch (err) {
			recordScheduleComputeError({
				state,
				job,
				err
			});
		}
		const backoffNext = result.endedAt + backoff;
		job.state.nextRunAtMs = normalNext !== void 0 ? Math.max(normalNext, backoffNext) : backoffNext;
		state.deps.log.info({
			jobId: job.id,
			consecutiveErrors: job.state.consecutiveErrors,
			backoffMs: backoff,
			nextRunAtMs: job.state.nextRunAtMs
		}, "cron: applying error backoff");
	} else if (job.enabled) {
		let naturalNext;
		try {
			naturalNext = opts?.preserveSchedule && job.schedule.kind === "every" ? computeNextWithPreservedLastRun(result.endedAt) : computeJobNextRunAtMs(job, result.endedAt);
		} catch (err) {
			recordScheduleComputeError({
				state,
				job,
				err
			});
		}
		if (job.schedule.kind === "cron") {
			const minNext = result.endedAt + MIN_REFIRE_GAP_MS;
			job.state.nextRunAtMs = naturalNext !== void 0 ? Math.max(naturalNext, minNext) : minNext;
		} else job.state.nextRunAtMs = naturalNext;
	} else job.state.nextRunAtMs = void 0;
	return shouldDelete;
}
function applyOutcomeToStoredJob(state, result) {
	const store = state.store;
	if (!store) return;
	const jobs = store.jobs;
	const job = jobs.find((entry) => entry.id === result.jobId);
	if (!job) {
		state.deps.log.warn({ jobId: result.jobId }, "cron: applyOutcomeToStoredJob — job not found after forceReload, result discarded");
		return;
	}
	const shouldDelete = applyJobResult(state, job, {
		status: result.status,
		error: result.error,
		delivered: result.delivered,
		startedAt: result.startedAt,
		endedAt: result.endedAt
	});
	emitJobFinished(state, job, result, result.startedAt);
	if (shouldDelete) {
		store.jobs = jobs.filter((entry) => entry.id !== job.id);
		emit(state, {
			jobId: job.id,
			action: "removed"
		});
	}
}
function armTimer(state) {
	if (state.timer) clearTimeout(state.timer);
	state.timer = null;
	if (!state.deps.cronEnabled) {
		state.deps.log.debug({}, "cron: armTimer skipped - scheduler disabled");
		return;
	}
	const nextAt = nextWakeAtMs(state);
	if (!nextAt) {
		const jobCount = state.store?.jobs.length ?? 0;
		const enabledCount = state.store?.jobs.filter((j) => j.enabled).length ?? 0;
		const withNextRun = state.store?.jobs.filter((j) => j.enabled && typeof j.state.nextRunAtMs === "number" && Number.isFinite(j.state.nextRunAtMs)).length ?? 0;
		state.deps.log.debug({
			jobCount,
			enabledCount,
			withNextRun
		}, "cron: armTimer skipped - no jobs with nextRunAtMs");
		return;
	}
	const now = state.deps.nowMs();
	const delay = Math.max(nextAt - now, 0);
	const flooredDelay = delay === 0 ? MIN_REFIRE_GAP_MS : delay;
	const clampedDelay = Math.min(flooredDelay, MAX_TIMER_DELAY_MS);
	state.timer = setTimeout(() => {
		onTimer(state).catch((err) => {
			state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
		});
	}, clampedDelay);
	state.deps.log.debug({
		nextAt,
		delayMs: clampedDelay,
		clamped: delay > MAX_TIMER_DELAY_MS
	}, "cron: timer armed");
}
function armRunningRecheckTimer(state) {
	if (state.timer) clearTimeout(state.timer);
	state.timer = setTimeout(() => {
		onTimer(state).catch((err) => {
			state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
		});
	}, MAX_TIMER_DELAY_MS);
}
async function onTimer(state) {
	if (state.running) {
		armRunningRecheckTimer(state);
		return;
	}
	state.running = true;
	armRunningRecheckTimer(state);
	try {
		const dueJobs = await locked(state, async () => {
			await ensureLoaded(state, {
				forceReload: true,
				skipRecompute: true
			});
			const dueCheckNow = state.deps.nowMs();
			const due = collectRunnableJobs(state, dueCheckNow);
			if (due.length === 0) {
				if (recomputeNextRunsForMaintenance(state, {
					recomputeExpired: true,
					nowMs: dueCheckNow
				})) await persist(state);
				return [];
			}
			const now = state.deps.nowMs();
			for (const job of due) {
				job.state.runningAtMs = now;
				job.state.lastError = void 0;
			}
			await persist(state);
			return due.map((j) => ({
				id: j.id,
				job: j
			}));
		});
		const runDueJob = async (params) => {
			const { id, job } = params;
			const startedAt = state.deps.nowMs();
			job.state.runningAtMs = startedAt;
			emit(state, {
				jobId: job.id,
				action: "started",
				runAtMs: startedAt
			});
			const jobTimeoutMs = resolveCronJobTimeoutMs(job);
			try {
				return {
					jobId: id,
					...await executeJobCoreWithTimeout(state, job),
					startedAt,
					endedAt: state.deps.nowMs()
				};
			} catch (err) {
				const errorText = isAbortError(err) ? timeoutErrorMessage() : String(err);
				state.deps.log.warn({
					jobId: id,
					jobName: job.name,
					timeoutMs: jobTimeoutMs ?? null
				}, `cron: job failed: ${errorText}`);
				return {
					jobId: id,
					status: "error",
					error: errorText,
					startedAt,
					endedAt: state.deps.nowMs()
				};
			}
		};
		const concurrency = Math.min(resolveRunConcurrency(state), Math.max(1, dueJobs.length));
		const results = Array.from({ length: dueJobs.length });
		let cursor = 0;
		const workers = Array.from({ length: concurrency }, async () => {
			for (;;) {
				const index = cursor++;
				if (index >= dueJobs.length) return;
				const due = dueJobs[index];
				if (!due) return;
				results[index] = await runDueJob(due);
			}
		});
		await Promise.all(workers);
		const completedResults = results.filter((entry) => entry !== void 0);
		if (completedResults.length > 0) await locked(state, async () => {
			await ensureLoaded(state, {
				forceReload: true,
				skipRecompute: true
			});
			for (const result of completedResults) applyOutcomeToStoredJob(state, result);
			recomputeNextRunsForMaintenance(state);
			await persist(state);
		});
	} finally {
		const storePaths = /* @__PURE__ */ new Set();
		if (state.deps.resolveSessionStorePath) {
			const defaultAgentId = state.deps.defaultAgentId ?? "main";
			if (state.store?.jobs?.length) for (const job of state.store.jobs) {
				const agentId = typeof job.agentId === "string" && job.agentId.trim() ? job.agentId : defaultAgentId;
				storePaths.add(state.deps.resolveSessionStorePath(agentId));
			}
			else storePaths.add(state.deps.resolveSessionStorePath(defaultAgentId));
		} else if (state.deps.sessionStorePath) storePaths.add(state.deps.sessionStorePath);
		if (storePaths.size > 0) {
			const nowMs = state.deps.nowMs();
			for (const storePath of storePaths) try {
				await sweepCronRunSessions({
					cronConfig: state.deps.cronConfig,
					sessionStorePath: storePath,
					nowMs,
					log: state.deps.log
				});
			} catch (err) {
				state.deps.log.warn({
					err: String(err),
					storePath
				}, "cron: session reaper sweep failed");
			}
		}
		state.running = false;
		armTimer(state);
	}
}
function isRunnableJob(params) {
	const { job, nowMs } = params;
	if (!job.state) job.state = {};
	if (!job.enabled) return false;
	if (params.skipJobIds?.has(job.id)) return false;
	if (typeof job.state.runningAtMs === "number") return false;
	if (params.skipAtIfAlreadyRan && job.schedule.kind === "at" && job.state.lastStatus) {
		const lastRun = job.state.lastRunAtMs;
		const nextRun = job.state.nextRunAtMs;
		if (job.state.lastStatus === "error" && job.enabled && typeof nextRun === "number" && typeof lastRun === "number" && nextRun > lastRun) return nowMs >= nextRun;
		return false;
	}
	const next = job.state.nextRunAtMs;
	if (typeof next === "number" && Number.isFinite(next) && nowMs >= next) return true;
	if (typeof next === "number" && Number.isFinite(next) && next > nowMs && isErrorBackoffPending(job, nowMs)) return false;
	if (!params.allowCronMissedRunByLastRun || job.schedule.kind !== "cron") return false;
	let previousRunAtMs;
	try {
		previousRunAtMs = computeJobPreviousRunAtMs(job, nowMs);
	} catch {
		return false;
	}
	if (typeof previousRunAtMs !== "number" || !Number.isFinite(previousRunAtMs)) return false;
	const lastRunAtMs = job.state.lastRunAtMs;
	if (typeof lastRunAtMs !== "number" || !Number.isFinite(lastRunAtMs)) return false;
	return previousRunAtMs > lastRunAtMs;
}
function isErrorBackoffPending(job, nowMs) {
	if (job.schedule.kind === "at" || job.state.lastStatus !== "error") return false;
	const lastRunAtMs = job.state.lastRunAtMs;
	if (typeof lastRunAtMs !== "number" || !Number.isFinite(lastRunAtMs)) return false;
	const consecutiveErrorsRaw = job.state.consecutiveErrors;
	return nowMs < lastRunAtMs + errorBackoffMs(typeof consecutiveErrorsRaw === "number" && Number.isFinite(consecutiveErrorsRaw) ? Math.max(1, Math.floor(consecutiveErrorsRaw)) : 1);
}
function collectRunnableJobs(state, nowMs, opts) {
	if (!state.store) return [];
	return state.store.jobs.filter((job) => isRunnableJob({
		job,
		nowMs,
		skipJobIds: opts?.skipJobIds,
		skipAtIfAlreadyRan: opts?.skipAtIfAlreadyRan,
		allowCronMissedRunByLastRun: opts?.allowCronMissedRunByLastRun
	}));
}
async function runMissedJobs(state, opts) {
	const plan = await planStartupCatchup(state, opts);
	if (plan.candidates.length === 0 && plan.deferredJobIds.length === 0) return;
	await applyStartupCatchupOutcomes(state, plan, await executeStartupCatchupPlan(state, plan));
}
async function planStartupCatchup(state, opts) {
	const maxImmediate = Math.max(0, state.deps.maxMissedJobsPerRestart ?? DEFAULT_MAX_MISSED_JOBS_PER_RESTART);
	return locked(state, async () => {
		await ensureLoaded(state, { skipRecompute: true });
		if (!state.store) return {
			candidates: [],
			deferredJobIds: []
		};
		const now = state.deps.nowMs();
		const missed = collectRunnableJobs(state, now, {
			skipJobIds: opts?.skipJobIds,
			skipAtIfAlreadyRan: true,
			allowCronMissedRunByLastRun: true
		});
		if (missed.length === 0) return {
			candidates: [],
			deferredJobIds: []
		};
		const sorted = missed.toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
		const startupCandidates = sorted.slice(0, maxImmediate);
		const deferred = sorted.slice(maxImmediate);
		if (deferred.length > 0) state.deps.log.info({
			immediateCount: startupCandidates.length,
			deferredCount: deferred.length,
			totalMissed: missed.length
		}, "cron: staggering missed jobs to prevent gateway overload");
		if (startupCandidates.length > 0) state.deps.log.info({
			count: startupCandidates.length,
			jobIds: startupCandidates.map((j) => j.id)
		}, "cron: running missed jobs after restart");
		for (const job of startupCandidates) {
			job.state.runningAtMs = now;
			job.state.lastError = void 0;
		}
		await persist(state);
		return {
			candidates: startupCandidates.map((job) => ({
				jobId: job.id,
				job
			})),
			deferredJobIds: deferred.map((job) => job.id)
		};
	});
}
async function executeStartupCatchupPlan(state, plan) {
	const outcomes = [];
	for (const candidate of plan.candidates) outcomes.push(await runStartupCatchupCandidate(state, candidate));
	return outcomes;
}
async function runStartupCatchupCandidate(state, candidate) {
	const startedAt = state.deps.nowMs();
	emit(state, {
		jobId: candidate.job.id,
		action: "started",
		runAtMs: startedAt
	});
	try {
		const result = await executeJobCoreWithTimeout(state, candidate.job);
		return {
			jobId: candidate.jobId,
			status: result.status,
			error: result.error,
			summary: result.summary,
			delivered: result.delivered,
			sessionId: result.sessionId,
			sessionKey: result.sessionKey,
			model: result.model,
			provider: result.provider,
			usage: result.usage,
			startedAt,
			endedAt: state.deps.nowMs()
		};
	} catch (err) {
		return {
			jobId: candidate.jobId,
			status: "error",
			error: String(err),
			startedAt,
			endedAt: state.deps.nowMs()
		};
	}
}
async function applyStartupCatchupOutcomes(state, plan, outcomes) {
	const staggerMs = Math.max(0, state.deps.missedJobStaggerMs ?? DEFAULT_MISSED_JOB_STAGGER_MS);
	await locked(state, async () => {
		await ensureLoaded(state, {
			forceReload: true,
			skipRecompute: true
		});
		if (!state.store) return;
		for (const result of outcomes) applyOutcomeToStoredJob(state, result);
		if (plan.deferredJobIds.length > 0) {
			const baseNow = state.deps.nowMs();
			let offset = staggerMs;
			for (const jobId of plan.deferredJobIds) {
				const job = state.store.jobs.find((entry) => entry.id === jobId);
				if (!job || !job.enabled) continue;
				job.state.nextRunAtMs = baseNow + offset;
				offset += staggerMs;
			}
		}
		recomputeNextRunsForMaintenance(state);
		await persist(state);
	});
}
async function executeJobCore(state, job, abortSignal) {
	const resolveAbortError = () => ({
		status: "error",
		error: timeoutErrorMessage()
	});
	const waitWithAbort = async (ms) => {
		if (!abortSignal) {
			await new Promise((resolve) => setTimeout(resolve, ms));
			return;
		}
		if (abortSignal.aborted) return;
		await new Promise((resolve) => {
			const timer = setTimeout(() => {
				abortSignal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				abortSignal.removeEventListener("abort", onAbort);
				resolve();
			};
			abortSignal.addEventListener("abort", onAbort, { once: true });
		});
	};
	if (abortSignal?.aborted) return resolveAbortError();
	if (job.sessionTarget === "main") {
		const text = resolveJobPayloadTextForMain(job);
		if (!text) return {
			status: "skipped",
			error: job.payload.kind === "systemEvent" ? "main job requires non-empty systemEvent text" : "main job requires payload.kind=\"systemEvent\""
		};
		const targetMainSessionKey = job.sessionKey;
		state.deps.enqueueSystemEvent(text, {
			agentId: job.agentId,
			sessionKey: targetMainSessionKey,
			contextKey: `cron:${job.id}`
		});
		if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
			const reason = `cron:${job.id}`;
			const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 6e4;
			const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
			const waitStartedAt = state.deps.nowMs();
			let heartbeatResult;
			for (;;) {
				if (abortSignal?.aborted) return resolveAbortError();
				heartbeatResult = await state.deps.runHeartbeatOnce({
					reason,
					agentId: job.agentId,
					sessionKey: targetMainSessionKey,
					heartbeat: { target: "last" }
				});
				if (heartbeatResult.status !== "skipped" || heartbeatResult.reason !== "requests-in-flight") break;
				if (abortSignal?.aborted) return resolveAbortError();
				if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
					if (abortSignal?.aborted) return resolveAbortError();
					state.deps.requestHeartbeatNow({
						reason,
						agentId: job.agentId,
						sessionKey: targetMainSessionKey
					});
					return {
						status: "ok",
						summary: text
					};
				}
				await waitWithAbort(retryDelayMs);
			}
			if (heartbeatResult.status === "ran") return {
				status: "ok",
				summary: text
			};
			else if (heartbeatResult.status === "skipped") return {
				status: "skipped",
				error: heartbeatResult.reason,
				summary: text
			};
			else return {
				status: "error",
				error: heartbeatResult.reason,
				summary: text
			};
		} else {
			if (abortSignal?.aborted) return resolveAbortError();
			state.deps.requestHeartbeatNow({
				reason: `cron:${job.id}`,
				agentId: job.agentId,
				sessionKey: targetMainSessionKey
			});
			return {
				status: "ok",
				summary: text
			};
		}
	}
	if (job.payload.kind !== "agentTurn") return {
		status: "skipped",
		error: "isolated job requires payload.kind=agentTurn"
	};
	if (abortSignal?.aborted) return resolveAbortError();
	const res = await state.deps.runIsolatedAgentJob({
		job,
		message: job.payload.message,
		abortSignal
	});
	if (abortSignal?.aborted) return {
		status: "error",
		error: timeoutErrorMessage()
	};
	return {
		status: res.status,
		error: res.error,
		summary: res.summary,
		delivered: res.delivered,
		deliveryAttempted: res.deliveryAttempted,
		sessionId: res.sessionId,
		sessionKey: res.sessionKey,
		model: res.model,
		provider: res.provider,
		usage: res.usage
	};
}
function emitJobFinished(state, job, result, runAtMs) {
	emit(state, {
		jobId: job.id,
		action: "finished",
		status: result.status,
		error: result.error,
		summary: result.summary,
		delivered: result.delivered,
		deliveryStatus: job.state.lastDeliveryStatus,
		deliveryError: job.state.lastDeliveryError,
		sessionId: result.sessionId,
		sessionKey: result.sessionKey,
		runAtMs,
		durationMs: job.state.lastDurationMs,
		nextRunAtMs: job.state.nextRunAtMs,
		model: result.model,
		provider: result.provider,
		usage: result.usage
	});
}
function wake(state, opts) {
	const text = opts.text.trim();
	if (!text) return { ok: false };
	state.deps.enqueueSystemEvent(text);
	if (opts.mode === "now") state.deps.requestHeartbeatNow({ reason: "wake" });
	return { ok: true };
}
function stopTimer(state) {
	if (state.timer) clearTimeout(state.timer);
	state.timer = null;
}
function emit(state, evt) {
	try {
		state.deps.onEvent?.(evt);
	} catch {}
}
//#endregion
//#region src/cron/service/ops.ts
function mergeManualRunSnapshotAfterReload(params) {
	if (!params.state.store) return;
	if (params.removed) {
		params.state.store.jobs = params.state.store.jobs.filter((job) => job.id !== params.jobId);
		return;
	}
	if (!params.snapshot) return;
	const reloaded = params.state.store.jobs.find((job) => job.id === params.jobId);
	if (!reloaded) return;
	reloaded.enabled = params.snapshot.enabled;
	reloaded.updatedAtMs = params.snapshot.updatedAtMs;
	reloaded.state = params.snapshot.state;
}
async function ensureLoadedForRead(state) {
	await ensureLoaded(state, { skipRecompute: true });
	if (!state.store) return;
	if (recomputeNextRunsForMaintenance(state)) await persist(state);
}
async function start(state) {
	if (!state.deps.cronEnabled) {
		state.deps.log.info({ enabled: false }, "cron: disabled");
		return;
	}
	const startupInterruptedJobIds = /* @__PURE__ */ new Set();
	await locked(state, async () => {
		await ensureLoaded(state, { skipRecompute: true });
		const jobs = state.store?.jobs ?? [];
		for (const job of jobs) if (typeof job.state.runningAtMs === "number") {
			state.deps.log.warn({
				jobId: job.id,
				runningAtMs: job.state.runningAtMs
			}, "cron: clearing stale running marker on startup");
			job.state.runningAtMs = void 0;
			startupInterruptedJobIds.add(job.id);
		}
		await persist(state);
	});
	await runMissedJobs(state, { skipJobIds: startupInterruptedJobIds });
	await locked(state, async () => {
		await ensureLoaded(state, {
			forceReload: true,
			skipRecompute: true
		});
		recomputeNextRuns(state);
		await persist(state);
		armTimer(state);
		state.deps.log.info({
			enabled: true,
			jobs: state.store?.jobs.length ?? 0,
			nextWakeAtMs: nextWakeAtMs(state) ?? null
		}, "cron: started");
	});
}
function stop(state) {
	stopTimer(state);
}
async function status(state) {
	return await locked(state, async () => {
		await ensureLoadedForRead(state);
		return {
			enabled: state.deps.cronEnabled,
			storePath: state.deps.storePath,
			jobs: state.store?.jobs.length ?? 0,
			nextWakeAtMs: state.deps.cronEnabled ? nextWakeAtMs(state) ?? null : null
		};
	});
}
async function list(state, opts) {
	return await locked(state, async () => {
		await ensureLoadedForRead(state);
		const includeDisabled = opts?.includeDisabled === true;
		return (state.store?.jobs ?? []).filter((j) => includeDisabled || j.enabled).toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
	});
}
function resolveEnabledFilter(opts) {
	if (opts?.enabled === "all" || opts?.enabled === "enabled" || opts?.enabled === "disabled") return opts.enabled;
	return opts?.includeDisabled ? "all" : "enabled";
}
function sortJobs(jobs, sortBy, sortDir) {
	const dir = sortDir === "desc" ? -1 : 1;
	return jobs.toSorted((a, b) => {
		let cmp = 0;
		if (sortBy === "name") {
			const aName = typeof a.name === "string" ? a.name : "";
			const bName = typeof b.name === "string" ? b.name : "";
			cmp = aName.localeCompare(bName, void 0, { sensitivity: "base" });
		} else if (sortBy === "updatedAtMs") cmp = a.updatedAtMs - b.updatedAtMs;
		else {
			const aNext = a.state.nextRunAtMs;
			const bNext = b.state.nextRunAtMs;
			if (typeof aNext === "number" && typeof bNext === "number") cmp = aNext - bNext;
			else if (typeof aNext === "number") cmp = -1;
			else if (typeof bNext === "number") cmp = 1;
			else cmp = 0;
		}
		if (cmp !== 0) return cmp * dir;
		const aId = typeof a.id === "string" ? a.id : "";
		const bId = typeof b.id === "string" ? b.id : "";
		return aId.localeCompare(bId);
	});
}
async function listPage(state, opts) {
	return await locked(state, async () => {
		await ensureLoadedForRead(state);
		const query = opts?.query?.trim().toLowerCase() ?? "";
		const enabledFilter = resolveEnabledFilter(opts);
		const sortBy = opts?.sortBy ?? "nextRunAtMs";
		const sortDir = opts?.sortDir ?? "asc";
		const sorted = sortJobs((state.store?.jobs ?? []).filter((job) => {
			if (enabledFilter === "enabled" && !job.enabled) return false;
			if (enabledFilter === "disabled" && job.enabled) return false;
			if (!query) return true;
			return [
				job.name,
				job.description ?? "",
				job.agentId ?? ""
			].join(" ").toLowerCase().includes(query);
		}), sortBy, sortDir);
		const total = sorted.length;
		const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
		const defaultLimit = total === 0 ? 50 : total;
		const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
		const jobs = sorted.slice(offset, offset + limit);
		const nextOffset = offset + jobs.length;
		return {
			jobs,
			total,
			offset,
			limit,
			hasMore: nextOffset < total,
			nextOffset: nextOffset < total ? nextOffset : null
		};
	});
}
async function add(state, input) {
	return await locked(state, async () => {
		warnIfDisabled(state, "add");
		await ensureLoaded(state);
		const job = createJob(state, normalizeCronCreateDeliveryInput(input));
		state.store?.jobs.push(job);
		recomputeNextRuns(state);
		await persist(state);
		armTimer(state);
		state.deps.log.info({
			jobId: job.id,
			jobName: job.name,
			nextRunAtMs: job.state.nextRunAtMs,
			schedulerNextWakeAtMs: nextWakeAtMs(state) ?? null,
			timerArmed: state.timer !== null,
			cronEnabled: state.deps.cronEnabled
		}, "cron: job added");
		emit(state, {
			jobId: job.id,
			action: "added",
			nextRunAtMs: job.state.nextRunAtMs
		});
		return job;
	});
}
async function update(state, id, patch) {
	return await locked(state, async () => {
		warnIfDisabled(state, "update");
		await ensureLoaded(state, { skipRecompute: true });
		const job = findJobOrThrow(state, id);
		const now = state.deps.nowMs();
		applyJobPatch(job, patch, { defaultAgentId: state.deps.defaultAgentId });
		if (job.schedule.kind === "every") {
			const anchor = job.schedule.anchorMs;
			if (typeof anchor !== "number" || !Number.isFinite(anchor)) {
				const fallbackAnchorMs = patch.schedule?.kind === "every" ? now : typeof job.createdAtMs === "number" && Number.isFinite(job.createdAtMs) ? job.createdAtMs : now;
				job.schedule = {
					...job.schedule,
					anchorMs: Math.max(0, Math.floor(fallbackAnchorMs))
				};
			}
		}
		const scheduleChanged = patch.schedule !== void 0;
		const enabledChanged = patch.enabled !== void 0;
		job.updatedAtMs = now;
		if (scheduleChanged || enabledChanged) if (job.enabled) job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
		else {
			job.state.nextRunAtMs = void 0;
			job.state.runningAtMs = void 0;
		}
		else if (job.enabled) {
			const nextRun = job.state.nextRunAtMs;
			if (typeof nextRun !== "number" || !Number.isFinite(nextRun)) job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
		}
		await persist(state);
		armTimer(state);
		emit(state, {
			jobId: id,
			action: "updated",
			nextRunAtMs: job.state.nextRunAtMs
		});
		return job;
	});
}
async function remove(state, id) {
	return await locked(state, async () => {
		warnIfDisabled(state, "remove");
		await ensureLoaded(state);
		const before = state.store?.jobs.length ?? 0;
		if (!state.store) return {
			ok: false,
			removed: false
		};
		state.store.jobs = state.store.jobs.filter((j) => j.id !== id);
		const removed = (state.store.jobs.length ?? 0) !== before;
		await persist(state);
		armTimer(state);
		if (removed) emit(state, {
			jobId: id,
			action: "removed"
		});
		return {
			ok: true,
			removed
		};
	});
}
let nextManualRunId = 1;
async function inspectManualRunPreflight(state, id, mode) {
	return await locked(state, async () => {
		warnIfDisabled(state, "run");
		await ensureLoaded(state, { skipRecompute: true });
		recomputeNextRunsForMaintenance(state);
		const job = findJobOrThrow(state, id);
		if (typeof job.state.runningAtMs === "number") return {
			ok: true,
			ran: false,
			reason: "already-running"
		};
		const now = state.deps.nowMs();
		if (!isJobDue(job, now, { forced: mode === "force" })) return {
			ok: true,
			ran: false,
			reason: "not-due"
		};
		return {
			ok: true,
			runnable: true,
			job,
			now
		};
	});
}
async function inspectManualRunDisposition(state, id, mode) {
	const result = await inspectManualRunPreflight(state, id, mode);
	if (!result.ok) return result;
	if ("reason" in result) return result;
	return {
		ok: true,
		runnable: true
	};
}
async function prepareManualRun(state, id, mode) {
	const preflight = await inspectManualRunPreflight(state, id, mode);
	if (!preflight.ok) return preflight;
	if ("reason" in preflight) return {
		ok: true,
		ran: false,
		reason: preflight.reason
	};
	return await locked(state, async () => {
		const job = findJobOrThrow(state, id);
		if (typeof job.state.runningAtMs === "number") return {
			ok: true,
			ran: false,
			reason: "already-running"
		};
		job.state.runningAtMs = preflight.now;
		job.state.lastError = void 0;
		await persist(state);
		emit(state, {
			jobId: job.id,
			action: "started",
			runAtMs: preflight.now
		});
		const executionJob = JSON.parse(JSON.stringify(job));
		return {
			ok: true,
			ran: true,
			jobId: job.id,
			startedAt: preflight.now,
			executionJob
		};
	});
}
async function finishPreparedManualRun(state, prepared, mode) {
	const executionJob = prepared.executionJob;
	const startedAt = prepared.startedAt;
	const jobId = prepared.jobId;
	let coreResult;
	try {
		coreResult = await executeJobCoreWithTimeout(state, executionJob);
	} catch (err) {
		coreResult = {
			status: "error",
			error: String(err)
		};
	}
	const endedAt = state.deps.nowMs();
	await locked(state, async () => {
		await ensureLoaded(state, { skipRecompute: true });
		const job = state.store?.jobs.find((entry) => entry.id === jobId);
		if (!job) return;
		const shouldDelete = applyJobResult(state, job, {
			status: coreResult.status,
			error: coreResult.error,
			delivered: coreResult.delivered,
			startedAt,
			endedAt
		}, { preserveSchedule: mode === "force" });
		emit(state, {
			jobId: job.id,
			action: "finished",
			status: coreResult.status,
			error: coreResult.error,
			summary: coreResult.summary,
			delivered: coreResult.delivered,
			deliveryStatus: job.state.lastDeliveryStatus,
			deliveryError: job.state.lastDeliveryError,
			sessionId: coreResult.sessionId,
			sessionKey: coreResult.sessionKey,
			runAtMs: startedAt,
			durationMs: job.state.lastDurationMs,
			nextRunAtMs: job.state.nextRunAtMs,
			model: coreResult.model,
			provider: coreResult.provider,
			usage: coreResult.usage
		});
		if (shouldDelete && state.store) {
			state.store.jobs = state.store.jobs.filter((entry) => entry.id !== job.id);
			emit(state, {
				jobId: job.id,
				action: "removed"
			});
		}
		const postRunSnapshot = shouldDelete ? null : {
			enabled: job.enabled,
			updatedAtMs: job.updatedAtMs,
			state: structuredClone(job.state)
		};
		const postRunRemoved = shouldDelete;
		await ensureLoaded(state, {
			forceReload: true,
			skipRecompute: true
		});
		mergeManualRunSnapshotAfterReload({
			state,
			jobId,
			snapshot: postRunSnapshot,
			removed: postRunRemoved
		});
		recomputeNextRunsForMaintenance(state, { recomputeExpired: true });
		await persist(state);
		armTimer(state);
	});
}
async function run(state, id, mode) {
	const prepared = await prepareManualRun(state, id, mode);
	if (!prepared.ok || !prepared.ran) return prepared;
	await finishPreparedManualRun(state, prepared, mode);
	return {
		ok: true,
		ran: true
	};
}
async function enqueueRun(state, id, mode) {
	const disposition = await inspectManualRunDisposition(state, id, mode);
	if (!disposition.ok || !("runnable" in disposition && disposition.runnable)) return disposition;
	const runId = `manual:${id}:${state.deps.nowMs()}:${nextManualRunId++}`;
	enqueueCommandInLane(CommandLane.Cron, async () => {
		const result = await run(state, id, mode);
		if (result.ok && "ran" in result && !result.ran) state.deps.log.info({
			jobId: id,
			runId,
			reason: result.reason
		}, "cron: queued manual run skipped before execution");
		return result;
	}, {
		warnAfterMs: 5e3,
		onWait: (waitMs, queuedAhead) => {
			state.deps.log.warn({
				jobId: id,
				runId,
				waitMs,
				queuedAhead
			}, "cron: queued manual run waiting for an execution slot");
		}
	}).catch((err) => {
		state.deps.log.error({
			jobId: id,
			runId,
			err: String(err)
		}, "cron: queued manual run background execution failed");
	});
	return {
		ok: true,
		enqueued: true,
		runId
	};
}
function wakeNow(state, opts) {
	return wake(state, opts);
}
//#endregion
//#region src/cron/service/state.ts
function createCronServiceState(deps) {
	return {
		deps: {
			...deps,
			nowMs: deps.nowMs ?? (() => Date.now())
		},
		store: null,
		timer: null,
		running: false,
		op: Promise.resolve(),
		warnedDisabled: false,
		storeLoadedAtMs: null,
		storeFileMtimeMs: null
	};
}
//#endregion
//#region src/cron/service.ts
var CronService = class {
	constructor(deps) {
		this.state = createCronServiceState(deps);
	}
	async start() {
		await start(this.state);
	}
	stop() {
		stop(this.state);
	}
	async status() {
		return await status(this.state);
	}
	async list(opts) {
		return await list(this.state, opts);
	}
	async listPage(opts) {
		return await listPage(this.state, opts);
	}
	async add(input) {
		return await add(this.state, input);
	}
	async update(id, patch) {
		return await update(this.state, id, patch);
	}
	async remove(id) {
		return await remove(this.state, id);
	}
	async run(id, mode) {
		return await run(this.state, id, mode);
	}
	async enqueueRun(id, mode) {
		return await enqueueRun(this.state, id, mode);
	}
	getJob(id) {
		return this.state.store?.jobs.find((job) => job.id === id);
	}
	wake(opts) {
		return wakeNow(this.state, opts);
	}
};
//#endregion
//#region src/gateway/server-cron.ts
init_session_key();
init_runtime();
const CRON_WEBHOOK_TIMEOUT_MS = 1e4;
function trimToOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function redactWebhookUrl(url) {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "<invalid-webhook-url>";
	}
}
function resolveCronWebhookTarget(params) {
	if (params.delivery?.mode?.trim().toLowerCase() === "webhook") {
		const url = normalizeHttpWebhookUrl(params.delivery?.to);
		return url ? {
			url,
			source: "delivery"
		} : null;
	}
	if (params.legacyNotify) {
		const legacyUrl = normalizeHttpWebhookUrl(params.legacyWebhook);
		if (legacyUrl) return {
			url: legacyUrl,
			source: "legacy"
		};
	}
	return null;
}
function buildCronWebhookHeaders(webhookToken) {
	const headers = { "Content-Type": "application/json" };
	if (webhookToken) headers.Authorization = `Bearer ${webhookToken}`;
	return headers;
}
async function postCronWebhook(params) {
	const abortController = new AbortController();
	const timeout = setTimeout(() => {
		abortController.abort();
	}, CRON_WEBHOOK_TIMEOUT_MS);
	try {
		await (await fetchWithSsrFGuard({
			url: params.webhookUrl,
			init: {
				method: "POST",
				headers: buildCronWebhookHeaders(params.webhookToken),
				body: JSON.stringify(params.payload),
				signal: abortController.signal
			}
		})).release();
	} catch (err) {
		if (err instanceof SsrFBlockedError) params.logger.warn({
			...params.logContext,
			reason: formatErrorMessage(err),
			webhookUrl: redactWebhookUrl(params.webhookUrl)
		}, params.blockedLog);
		else params.logger.warn({
			...params.logContext,
			err: formatErrorMessage(err),
			webhookUrl: redactWebhookUrl(params.webhookUrl)
		}, params.failedLog);
	} finally {
		clearTimeout(timeout);
	}
}
function buildGatewayCronService(params) {
	const cronLogger = getChildLogger({ module: "cron" });
	const storePath = resolveCronStorePath(params.cfg.cron?.store);
	const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;
	const resolveCronAgent = (requested) => {
		const runtimeConfig = loadConfig();
		const normalized = typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : void 0;
		return {
			agentId: normalized !== void 0 && Array.isArray(runtimeConfig.agents?.list) && runtimeConfig.agents.list.some((entry) => entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized) ? normalized : resolveDefaultAgentId(runtimeConfig),
			cfg: runtimeConfig
		};
	};
	const resolveCronSessionKey = (params) => {
		const requested = params.requestedSessionKey?.trim();
		if (!requested) return resolveAgentMainSessionKey({
			cfg: params.runtimeConfig,
			agentId: params.agentId
		});
		const candidate = toAgentStoreSessionKey({
			agentId: params.agentId,
			requestKey: requested,
			mainKey: params.runtimeConfig.session?.mainKey
		});
		const canonical = canonicalizeMainSessionAlias({
			cfg: params.runtimeConfig,
			agentId: params.agentId,
			sessionKey: candidate
		});
		if (canonical !== "global") {
			if (normalizeAgentId(resolveAgentIdFromSessionKey(canonical)) !== normalizeAgentId(params.agentId)) return resolveAgentMainSessionKey({
				cfg: params.runtimeConfig,
				agentId: params.agentId
			});
		}
		return canonical;
	};
	const resolveCronWakeTarget = (opts) => {
		const runtimeConfig = loadConfig();
		const agentId = ((opts?.agentId ? resolveCronAgent(opts.agentId).agentId : void 0) ?? (opts?.sessionKey ? normalizeAgentId(resolveAgentIdFromSessionKey(opts.sessionKey)) : void 0)) || void 0;
		return {
			runtimeConfig,
			agentId,
			sessionKey: opts?.sessionKey && agentId ? resolveCronSessionKey({
				runtimeConfig,
				agentId,
				requestedSessionKey: opts.sessionKey
			}) : void 0
		};
	};
	const defaultAgentId = resolveDefaultAgentId(params.cfg);
	const runLogPrune = resolveCronRunLogPruneOptions(params.cfg.cron?.runLog);
	const resolveSessionStorePath = (agentId) => resolveStorePath(params.cfg.session?.store, { agentId: agentId ?? defaultAgentId });
	const sessionStorePath = resolveSessionStorePath(defaultAgentId);
	const warnedLegacyWebhookJobs = /* @__PURE__ */ new Set();
	const cron = new CronService({
		storePath,
		cronEnabled,
		cronConfig: params.cfg.cron,
		defaultAgentId,
		resolveSessionStorePath,
		sessionStorePath,
		enqueueSystemEvent: (text, opts) => {
			const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
			enqueueSystemEvent(text, {
				sessionKey: resolveCronSessionKey({
					runtimeConfig,
					agentId,
					requestedSessionKey: opts?.sessionKey
				}),
				contextKey: opts?.contextKey
			});
		},
		requestHeartbeatNow: (opts) => {
			const { agentId, sessionKey } = resolveCronWakeTarget(opts);
			requestHeartbeatNow({
				reason: opts?.reason,
				agentId,
				sessionKey
			});
		},
		runHeartbeatOnce: async (opts) => {
			const { runtimeConfig, agentId, sessionKey } = resolveCronWakeTarget(opts);
			const agentEntry = Array.isArray(runtimeConfig.agents?.list) && runtimeConfig.agents.list.find((entry) => entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === agentId);
			const agentHeartbeat = agentEntry && typeof agentEntry === "object" ? agentEntry.heartbeat : void 0;
			const baseHeartbeat = {
				...runtimeConfig.agents?.defaults?.heartbeat,
				...agentHeartbeat
			};
			const heartbeatOverride = opts?.heartbeat ? {
				...baseHeartbeat,
				...opts.heartbeat
			} : void 0;
			return await runHeartbeatOnce({
				cfg: runtimeConfig,
				reason: opts?.reason,
				agentId,
				sessionKey,
				heartbeat: heartbeatOverride,
				deps: {
					...params.deps,
					runtime: defaultRuntime
				}
			});
		},
		runIsolatedAgentJob: async ({ job, message, abortSignal }) => {
			const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
			let sessionKey = `cron:${job.id}`;
			if (job.sessionTarget.startsWith("session:")) {
				const customSessionId = job.sessionTarget.slice(8).trim();
				if (customSessionId) sessionKey = customSessionId;
			}
			return await runCronIsolatedAgentTurn({
				cfg: runtimeConfig,
				deps: params.deps,
				job,
				message,
				abortSignal,
				agentId,
				sessionKey,
				lane: "cron"
			});
		},
		sendCronFailureAlert: async ({ job, text, channel, to, mode, accountId }) => {
			const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
			const webhookToken = trimToOptionalString(params.cfg.cron?.webhookToken);
			if (mode === "webhook" && !to) {
				cronLogger.warn({ jobId: job.id }, "cron: failure alert webhook mode requires URL, skipping");
				return;
			}
			if (mode === "webhook" && to) {
				const webhookUrl = normalizeHttpWebhookUrl(to);
				if (webhookUrl) await postCronWebhook({
					webhookUrl,
					webhookToken,
					payload: {
						jobId: job.id,
						jobName: job.name,
						message: text
					},
					logContext: { jobId: job.id },
					blockedLog: "cron: failure alert webhook blocked by SSRF guard",
					failedLog: "cron: failure alert webhook failed",
					logger: cronLogger
				});
				else cronLogger.warn({
					jobId: job.id,
					webhookUrl: redactWebhookUrl(to)
				}, "cron: failure alert webhook URL is invalid, skipping");
				return;
			}
			const target = await resolveDeliveryTarget(runtimeConfig, agentId, {
				channel,
				to,
				accountId
			});
			if (!target.ok) throw target.error;
			await deliverOutboundPayloads({
				cfg: runtimeConfig,
				channel: target.channel,
				to: target.to,
				accountId: target.accountId,
				threadId: target.threadId,
				payloads: [{ text }],
				deps: createOutboundSendDeps$1(params.deps)
			});
		},
		log: getChildLogger({
			module: "cron",
			storePath
		}),
		onEvent: (evt) => {
			params.broadcast("cron", evt, { dropIfSlow: true });
			if (evt.action === "finished") {
				const webhookToken = trimToOptionalString(params.cfg.cron?.webhookToken);
				const legacyWebhook = trimToOptionalString(params.cfg.cron?.webhook);
				const job = cron.getJob(evt.jobId);
				const legacyNotify = job?.notify === true;
				const webhookTarget = resolveCronWebhookTarget({
					delivery: job?.delivery && typeof job.delivery.mode === "string" ? {
						mode: job.delivery.mode,
						to: job.delivery.to
					} : void 0,
					legacyNotify,
					legacyWebhook
				});
				if (!webhookTarget && job?.delivery?.mode === "webhook") cronLogger.warn({
					jobId: evt.jobId,
					deliveryTo: job.delivery.to
				}, "cron: skipped webhook delivery, delivery.to must be a valid http(s) URL");
				if (webhookTarget?.source === "legacy" && !warnedLegacyWebhookJobs.has(evt.jobId)) {
					warnedLegacyWebhookJobs.add(evt.jobId);
					cronLogger.warn({
						jobId: evt.jobId,
						legacyWebhook: redactWebhookUrl(webhookTarget.url)
					}, "cron: deprecated notify+cron.webhook fallback in use, migrate to delivery.mode=webhook with delivery.to");
				}
				if (webhookTarget && evt.summary) (async () => {
					await postCronWebhook({
						webhookUrl: webhookTarget.url,
						webhookToken,
						payload: evt,
						logContext: { jobId: evt.jobId },
						blockedLog: "cron: webhook delivery blocked by SSRF guard",
						failedLog: "cron: webhook delivery failed",
						logger: cronLogger
					});
				})();
				if (evt.status === "error" && job) {
					const failureDest = resolveFailureDestination(job, params.cfg.cron?.failureDestination);
					if (failureDest) {
						if (!(job.delivery?.bestEffort === true || job.payload.kind === "agentTurn" && job.payload.bestEffortDeliver === true)) {
							const failureMessage = `Cron job "${job.name}" failed: ${evt.error ?? "unknown error"}`;
							const failurePayload = {
								jobId: job.id,
								jobName: job.name,
								message: failureMessage,
								status: evt.status,
								error: evt.error,
								runAtMs: evt.runAtMs,
								durationMs: evt.durationMs,
								nextRunAtMs: evt.nextRunAtMs
							};
							if (failureDest.mode === "webhook" && failureDest.to) {
								const webhookUrl = normalizeHttpWebhookUrl(failureDest.to);
								if (webhookUrl) (async () => {
									await postCronWebhook({
										webhookUrl,
										webhookToken,
										payload: failurePayload,
										logContext: { jobId: evt.jobId },
										blockedLog: "cron: failure destination webhook blocked by SSRF guard",
										failedLog: "cron: failure destination webhook failed",
										logger: cronLogger
									});
								})();
								else cronLogger.warn({
									jobId: evt.jobId,
									webhookUrl: redactWebhookUrl(failureDest.to)
								}, "cron: failure destination webhook URL is invalid, skipping");
							} else if (failureDest.mode === "announce") {
								const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
								sendFailureNotificationAnnounce(params.deps, runtimeConfig, agentId, job.id, {
									channel: failureDest.channel,
									to: failureDest.to,
									accountId: failureDest.accountId
								}, `[Cron Failure] ${failureMessage}`);
							}
						}
					}
				}
				const logPath = resolveCronRunLogPath({
					storePath,
					jobId: evt.jobId
				});
				appendCronRunLog(logPath, {
					ts: Date.now(),
					jobId: evt.jobId,
					action: "finished",
					status: evt.status,
					error: evt.error,
					summary: evt.summary,
					delivered: evt.delivered,
					deliveryStatus: evt.deliveryStatus,
					deliveryError: evt.deliveryError,
					sessionId: evt.sessionId,
					sessionKey: evt.sessionKey,
					runAtMs: evt.runAtMs,
					durationMs: evt.durationMs,
					nextRunAtMs: evt.nextRunAtMs,
					model: evt.model,
					provider: evt.provider,
					usage: evt.usage
				}, runLogPrune).catch((err) => {
					cronLogger.warn({
						err: String(err),
						logPath
					}, "cron: run log append failed");
				});
			}
		}
	});
	return {
		cron,
		storePath,
		cronEnabled
	};
}
//#endregion
//#region src/infra/bonjour-errors.ts
function formatBonjourError(err) {
	if (err instanceof Error) {
		const msg = err.message.trim() || err.name || String(err).trim();
		if (err.name && err.name !== "Error") return msg === err.name ? err.name : `${err.name}: ${msg}`;
		return msg;
	}
	return String(err);
}
//#endregion
//#region src/infra/bonjour-ciao.ts
const CIAO_CANCELLATION_MESSAGE_RE = /^CIAO (?:ANNOUNCEMENT|PROBING) CANCELLED\b/u;
function ignoreCiaoCancellationRejection(reason) {
	const message = formatBonjourError(reason).toUpperCase();
	if (!CIAO_CANCELLATION_MESSAGE_RE.test(message)) return false;
	logDebug(`bonjour: ignoring unhandled ciao rejection: ${formatBonjourError(reason)}`);
	return true;
}
//#endregion
//#region src/infra/bonjour.ts
function isDisabledByEnv$1() {
	if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_BONJOUR)) return true;
	if (process.env.VITEST) return true;
	return false;
}
function safeServiceName(name) {
	const trimmed = name.trim();
	return trimmed.length > 0 ? trimmed : "OpenClaw";
}
function prettifyInstanceName(name) {
	const normalized = name.trim().replace(/\s+/g, " ");
	return normalized.replace(/\s+\(OpenClaw\)\s*$/i, "").trim() || normalized;
}
const WATCHDOG_INTERVAL_MS = 5e3;
const REPAIR_DEBOUNCE_MS = 3e4;
const STUCK_ANNOUNCING_MS = 8e3;
function serviceSummary(label, svc) {
	let fqdn = "unknown";
	let hostname = "unknown";
	let port = -1;
	try {
		fqdn = svc.getFQDN();
	} catch {}
	try {
		hostname = svc.getHostname();
	} catch {}
	try {
		port = svc.getPort();
	} catch {}
	const state = typeof svc.serviceState === "string" ? svc.serviceState : "unknown";
	return `${label} fqdn=${fqdn} host=${hostname} port=${port} state=${state}`;
}
function isAnnouncedState(state) {
	return String(state) === "announced";
}
async function startGatewayBonjourAdvertiser(opts) {
	if (isDisabledByEnv$1()) return { stop: async () => {} };
	const { getResponder, Protocol } = await import("@homebridge/ciao");
	const hostname = (process.env.OPENCLAW_MDNS_HOSTNAME?.trim() || process.env.CLAWDBOT_MDNS_HOSTNAME?.trim() || "openclaw").replace(/\.local$/i, "").split(".")[0].trim() || "openclaw";
	const instanceName = typeof opts.instanceName === "string" && opts.instanceName.trim() ? opts.instanceName.trim() : `${hostname} (OpenClaw)`;
	const displayName = prettifyInstanceName(instanceName);
	const txtBase = {
		role: "gateway",
		gatewayPort: String(opts.gatewayPort),
		lanHost: `${hostname}.local`,
		displayName
	};
	if (opts.gatewayTlsEnabled) {
		txtBase.gatewayTls = "1";
		if (opts.gatewayTlsFingerprintSha256) txtBase.gatewayTlsSha256 = opts.gatewayTlsFingerprintSha256;
	}
	if (typeof opts.canvasPort === "number" && opts.canvasPort > 0) txtBase.canvasPort = String(opts.canvasPort);
	if (typeof opts.tailnetDns === "string" && opts.tailnetDns.trim()) txtBase.tailnetDns = opts.tailnetDns.trim();
	if (!opts.minimal && typeof opts.cliPath === "string" && opts.cliPath.trim()) txtBase.cliPath = opts.cliPath.trim();
	const gatewayTxt = {
		...txtBase,
		transport: "gateway"
	};
	if (!opts.minimal) gatewayTxt.sshPort = String(opts.sshPort ?? 22);
	function createCycle() {
		const responder = getResponder();
		const services = [];
		const gateway = responder.createService({
			name: safeServiceName(instanceName),
			type: "openclaw-gw",
			protocol: Protocol.TCP,
			port: opts.gatewayPort,
			domain: "local",
			hostname,
			txt: gatewayTxt
		});
		services.push({
			label: "gateway",
			svc: gateway
		});
		return {
			responder,
			services,
			cleanupUnhandledRejection: services.length > 0 ? registerUnhandledRejectionHandler(ignoreCiaoCancellationRejection) : void 0
		};
	}
	async function stopCycle(cycle) {
		if (!cycle) return;
		const responder = cycle.responder;
		const noopAsync = async () => {};
		responder.advertiseService = noopAsync;
		responder.announce = noopAsync;
		responder.probe = noopAsync;
		responder.republishService = noopAsync;
		for (const { svc } of cycle.services) try {
			await svc.destroy();
		} catch {}
		try {
			await cycle.responder.shutdown();
		} catch {} finally {
			cycle.cleanupUnhandledRejection?.();
		}
	}
	function attachConflictListeners(services) {
		for (const { label, svc } of services) try {
			svc.on("name-change", (name) => {
				const next = typeof name === "string" ? name : String(name);
				logWarn(`bonjour: ${label} name conflict resolved; newName=${JSON.stringify(next)}`);
			});
			svc.on("hostname-change", (nextHostname) => {
				const next = typeof nextHostname === "string" ? nextHostname : String(nextHostname);
				logWarn(`bonjour: ${label} hostname conflict resolved; newHostname=${JSON.stringify(next)}`);
			});
		} catch (err) {
			logDebug(`bonjour: failed to attach listeners for ${label}: ${String(err)}`);
		}
	}
	function startAdvertising(services) {
		for (const { label, svc } of services) try {
			svc.advertise().then(() => {
				getLogger().info(`bonjour: advertised ${serviceSummary(label, svc)}`);
			}).catch((err) => {
				logWarn(`bonjour: advertise failed (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`);
			});
		} catch (err) {
			logWarn(`bonjour: advertise threw (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`);
		}
	}
	logDebug(`bonjour: starting (hostname=${hostname}, instance=${JSON.stringify(safeServiceName(instanceName))}, gatewayPort=${opts.gatewayPort}${opts.minimal ? ", minimal=true" : `, sshPort=${opts.sshPort ?? 22}`})`);
	let stopped = false;
	let recreatePromise = null;
	let cycle = createCycle();
	const stateTracker = /* @__PURE__ */ new Map();
	attachConflictListeners(cycle.services);
	startAdvertising(cycle.services);
	const updateStateTrackers = (services) => {
		const now = Date.now();
		for (const { label, svc } of services) {
			const nextState = typeof svc.serviceState === "string" ? svc.serviceState : "unknown";
			const current = stateTracker.get(label);
			const nextEnteredAt = current && !isAnnouncedState(current.state) && !isAnnouncedState(nextState) ? current.sinceMs : now;
			if (!current || current.state !== nextState || current.sinceMs !== nextEnteredAt) stateTracker.set(label, {
				state: nextState,
				sinceMs: nextEnteredAt
			});
		}
	};
	const recreateAdvertiser = async (reason) => {
		if (stopped) return;
		if (recreatePromise) return recreatePromise;
		recreatePromise = (async () => {
			logWarn(`bonjour: restarting advertiser (${reason})`);
			await stopCycle(cycle);
			cycle = createCycle();
			stateTracker.clear();
			attachConflictListeners(cycle.services);
			startAdvertising(cycle.services);
		})().finally(() => {
			recreatePromise = null;
		});
		return recreatePromise;
	};
	const lastRepairAttempt = /* @__PURE__ */ new Map();
	const watchdog = setInterval(() => {
		if (stopped || recreatePromise) return;
		updateStateTrackers(cycle.services);
		for (const { label, svc } of cycle.services) {
			const stateUnknown = svc.serviceState;
			if (typeof stateUnknown !== "string") continue;
			const tracked = stateTracker.get(label);
			if (stateUnknown !== "announced" && tracked && Date.now() - tracked.sinceMs >= STUCK_ANNOUNCING_MS) {
				recreateAdvertiser(`service stuck in ${stateUnknown} for ${Date.now() - tracked.sinceMs}ms (${serviceSummary(label, svc)})`);
				return;
			}
			if (stateUnknown === "announced" || stateUnknown === "announcing") continue;
			let key = label;
			try {
				key = `${label}:${svc.getFQDN()}`;
			} catch {}
			const now = Date.now();
			if (now - (lastRepairAttempt.get(key) ?? 0) < REPAIR_DEBOUNCE_MS) continue;
			lastRepairAttempt.set(key, now);
			logWarn(`bonjour: watchdog detected non-announced service; attempting re-advertise (${serviceSummary(label, svc)})`);
			try {
				svc.advertise().catch((err) => {
					logWarn(`bonjour: watchdog advertise failed (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`);
				});
			} catch (err) {
				logWarn(`bonjour: watchdog advertise threw (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`);
			}
		}
	}, WATCHDOG_INTERVAL_MS);
	watchdog.unref?.();
	return { stop: async () => {
		stopped = true;
		clearInterval(watchdog);
		await recreatePromise;
		await stopCycle(cycle);
	} };
}
//#endregion
//#region src/gateway/server-discovery.ts
function formatBonjourInstanceName(displayName) {
	const trimmed = displayName.trim();
	if (!trimmed) return "OpenClaw";
	if (/openclaw/i.test(trimmed)) return trimmed;
	return `${trimmed} (OpenClaw)`;
}
function resolveBonjourCliPath(opts = {}) {
	const envPath = (opts.env ?? process.env).OPENCLAW_CLI_PATH?.trim();
	if (envPath) return envPath;
	const statSync = opts.statSync ?? fs.statSync;
	const isFile = (candidate) => {
		try {
			return statSync(candidate).isFile();
		} catch {
			return false;
		}
	};
	const execPath = opts.execPath ?? process.execPath;
	const execDir = path.dirname(execPath);
	const siblingCli = path.join(execDir, "openclaw");
	if (isFile(siblingCli)) return siblingCli;
	const argvPath = (opts.argv ?? process.argv)[1];
	if (argvPath && isFile(argvPath)) return argvPath;
	const cwd = opts.cwd ?? process.cwd();
	const distCli = path.join(cwd, "dist", "index.js");
	if (isFile(distCli)) return distCli;
	const binCli = path.join(cwd, "bin", "openclaw");
	if (isFile(binCli)) return binCli;
}
async function resolveTailnetDnsHint(opts) {
	const envRaw = (opts?.env ?? process.env).OPENCLAW_TAILNET_DNS?.trim();
	const envValue = envRaw && envRaw.length > 0 ? envRaw.replace(/\.$/, "") : "";
	if (envValue) return envValue;
	if (opts?.enabled === false) return;
	const exec = opts?.exec ?? ((command, args) => runExec(command, args, {
		timeoutMs: 1500,
		maxBuffer: 2e5
	}));
	try {
		return await getTailnetHostname(exec);
	} catch {
		return;
	}
}
//#endregion
//#region src/gateway/server-discovery-runtime.ts
async function startGatewayDiscovery(params) {
	let bonjourStop = null;
	const mdnsMode = params.mdnsMode ?? "minimal";
	const bonjourEnabled = mdnsMode !== "off" && process.env.OPENCLAW_DISABLE_BONJOUR !== "1" && !process.env.VITEST;
	const mdnsMinimal = mdnsMode !== "full";
	const tailscaleEnabled = params.tailscaleMode !== "off";
	const tailnetDns = bonjourEnabled || params.wideAreaDiscoveryEnabled ? await resolveTailnetDnsHint({ enabled: tailscaleEnabled }) : void 0;
	const sshPortEnv = mdnsMinimal ? void 0 : process.env.OPENCLAW_SSH_PORT?.trim();
	const sshPortParsed = sshPortEnv ? Number.parseInt(sshPortEnv, 10) : NaN;
	const sshPort = Number.isFinite(sshPortParsed) && sshPortParsed > 0 ? sshPortParsed : void 0;
	const cliPath = mdnsMinimal ? void 0 : resolveBonjourCliPath();
	if (bonjourEnabled) try {
		bonjourStop = (await startGatewayBonjourAdvertiser({
			instanceName: formatBonjourInstanceName(params.machineDisplayName),
			gatewayPort: params.port,
			gatewayTlsEnabled: params.gatewayTls?.enabled ?? false,
			gatewayTlsFingerprintSha256: params.gatewayTls?.fingerprintSha256,
			canvasPort: params.canvasPort,
			sshPort,
			tailnetDns,
			cliPath,
			minimal: mdnsMinimal
		})).stop;
	} catch (err) {
		params.logDiscovery.warn(`bonjour advertising failed: ${String(err)}`);
	}
	if (params.wideAreaDiscoveryEnabled) {
		const wideAreaDomain = resolveWideAreaDiscoveryDomain({ configDomain: params.wideAreaDiscoveryDomain ?? void 0 });
		if (!wideAreaDomain) {
			params.logDiscovery.warn("discovery.wideArea.enabled is true, but no domain was configured; set discovery.wideArea.domain to enable unicast DNS-SD");
			return { bonjourStop };
		}
		const tailnetIPv4 = pickPrimaryTailnetIPv4();
		if (!tailnetIPv4) params.logDiscovery.warn("discovery.wideArea.enabled is true, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update");
		else try {
			const tailnetIPv6 = pickPrimaryTailnetIPv6();
			const result = await writeWideAreaGatewayZone({
				domain: wideAreaDomain,
				gatewayPort: params.port,
				displayName: formatBonjourInstanceName(params.machineDisplayName),
				tailnetIPv4,
				tailnetIPv6: tailnetIPv6 ?? void 0,
				gatewayTlsEnabled: params.gatewayTls?.enabled ?? false,
				gatewayTlsFingerprintSha256: params.gatewayTls?.fingerprintSha256,
				tailnetDns,
				sshPort,
				cliPath: resolveBonjourCliPath()
			});
			params.logDiscovery.info(`wide-area DNS-SD ${result.changed ? "updated" : "unchanged"} (${wideAreaDomain} → ${result.zonePath})`);
		} catch (err) {
			params.logDiscovery.warn(`wide-area discovery update failed: ${String(err)}`);
		}
	}
	return { bonjourStop };
}
//#endregion
//#region src/gateway/server-lanes.ts
function applyGatewayLaneConcurrency(cfg) {
	setCommandLaneConcurrency(CommandLane.Cron, cfg.cron?.maxConcurrentRuns ?? 1);
	setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
	setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
}
//#endregion
//#region src/gateway/chat-abort.ts
function isChatStopCommandText(text) {
	return isAbortRequestText(text);
}
function resolveChatRunExpiresAtMs(params) {
	const { now, timeoutMs, graceMs = 6e4, minMs = 2 * 6e4, maxMs = 1440 * 6e4 } = params;
	const target = now + Math.max(0, timeoutMs) + graceMs;
	const min = now + minMs;
	const max = now + maxMs;
	return Math.min(max, Math.max(min, target));
}
function broadcastChatAborted(ops, params) {
	const { runId, sessionKey, stopReason, partialText } = params;
	const payload = {
		runId,
		sessionKey,
		seq: (ops.agentRunSeq.get(runId) ?? 0) + 1,
		state: "aborted",
		stopReason,
		message: partialText ? {
			role: "assistant",
			content: [{
				type: "text",
				text: partialText
			}],
			timestamp: Date.now()
		} : void 0
	};
	ops.broadcast("chat", payload);
	ops.nodeSendToSession(sessionKey, "chat", payload);
}
function abortChatRunById(ops, params) {
	const { runId, sessionKey, stopReason } = params;
	const active = ops.chatAbortControllers.get(runId);
	if (!active) return { aborted: false };
	if (active.sessionKey !== sessionKey) return { aborted: false };
	const bufferedText = ops.chatRunBuffers.get(runId);
	const partialText = bufferedText && bufferedText.trim() ? bufferedText : void 0;
	ops.chatAbortedRuns.set(runId, Date.now());
	active.controller.abort();
	ops.chatAbortControllers.delete(runId);
	ops.chatRunBuffers.delete(runId);
	ops.chatDeltaSentAt.delete(runId);
	const removed = ops.removeChatRun(runId, runId, sessionKey);
	broadcastChatAborted(ops, {
		runId,
		sessionKey,
		stopReason,
		partialText
	});
	ops.agentRunSeq.delete(runId);
	if (removed?.clientRunId) ops.agentRunSeq.delete(removed.clientRunId);
	return { aborted: true };
}
//#endregion
//#region src/gateway/server-constants.ts
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 50 * 1024 * 1024;
const MAX_PREAUTH_PAYLOAD_BYTES = 64 * 1024;
let maxChatHistoryMessagesBytes = 6 * 1024 * 1024;
const getMaxChatHistoryMessagesBytes = () => maxChatHistoryMessagesBytes;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3e3;
const getHandshakeTimeoutMs = () => {
	if (process.env.VITEST && process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS) {
		const parsed = Number(process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return DEFAULT_HANDSHAKE_TIMEOUT_MS;
};
const TICK_INTERVAL_MS = 3e4;
const HEALTH_REFRESH_INTERVAL_MS = 6e4;
const DEDUPE_TTL_MS = 5 * 6e4;
const DEDUPE_MAX = 1e3;
//#endregion
//#region src/infra/voicewake.ts
init_paths();
init_json_files();
const DEFAULT_TRIGGERS = [
	"openclaw",
	"claude",
	"computer"
];
function resolvePath$1(baseDir) {
	const root = baseDir ?? resolveStateDir();
	return path.join(root, "settings", "voicewake.json");
}
function sanitizeTriggers(triggers) {
	const cleaned = (triggers ?? []).map((w) => typeof w === "string" ? w.trim() : "").filter((w) => w.length > 0);
	return cleaned.length > 0 ? cleaned : DEFAULT_TRIGGERS;
}
const withLock = createAsyncLock();
function defaultVoiceWakeTriggers() {
	return [...DEFAULT_TRIGGERS];
}
async function loadVoiceWakeConfig(baseDir) {
	const existing = await readJsonFile(resolvePath$1(baseDir));
	if (!existing) return {
		triggers: defaultVoiceWakeTriggers(),
		updatedAtMs: 0
	};
	return {
		triggers: sanitizeTriggers(existing.triggers),
		updatedAtMs: typeof existing.updatedAtMs === "number" && existing.updatedAtMs > 0 ? existing.updatedAtMs : 0
	};
}
async function setVoiceWakeTriggers(triggers, baseDir) {
	const sanitized = sanitizeTriggers(triggers);
	const filePath = resolvePath$1(baseDir);
	return await withLock(async () => {
		const next = {
			triggers: sanitized,
			updatedAtMs: Date.now()
		};
		await writeJsonAtomic(filePath, next);
		return next;
	});
}
//#endregion
//#region src/gateway/server-utils.ts
function normalizeVoiceWakeTriggers(input) {
	const cleaned = (Array.isArray(input) ? input : []).map((v) => typeof v === "string" ? v.trim() : "").filter((v) => v.length > 0).slice(0, 32).map((v) => v.slice(0, 64));
	return cleaned.length > 0 ? cleaned : defaultVoiceWakeTriggers();
}
function formatError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	const statusValue = err?.status;
	const codeValue = err?.code;
	if (statusValue !== void 0 || codeValue !== void 0) return `status=${typeof statusValue === "string" || typeof statusValue === "number" ? String(statusValue) : "unknown"} code=${typeof codeValue === "string" || typeof codeValue === "number" ? String(codeValue) : "unknown"}`;
	try {
		return JSON.stringify(err, null, 2);
	} catch {
		return String(err);
	}
}
//#endregion
//#region src/infra/system-presence.ts
const entries = /* @__PURE__ */ new Map();
const TTL_MS = 300 * 1e3;
const MAX_ENTRIES = 200;
function normalizePresenceKey(key) {
	if (!key) return;
	const trimmed = key.trim();
	if (!trimmed) return;
	return trimmed.toLowerCase();
}
function resolvePrimaryIPv4() {
	return pickPrimaryLanIPv4() ?? os.hostname();
}
function initSelfPresence() {
	const host = os.hostname();
	const ip = resolvePrimaryIPv4() ?? void 0;
	const version = resolveRuntimeServiceVersion(process.env);
	const modelIdentifier = (() => {
		if (os.platform() === "darwin") {
			const res = spawnSync("sysctl", ["-n", "hw.model"], { encoding: "utf-8" });
			const out = typeof res.stdout === "string" ? res.stdout.trim() : "";
			return out.length > 0 ? out : void 0;
		}
		return os.arch();
	})();
	const macOSVersion = () => {
		const res = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" });
		const out = typeof res.stdout === "string" ? res.stdout.trim() : "";
		return out.length > 0 ? out : os.release();
	};
	const selfEntry = {
		host,
		ip,
		version,
		platform: (() => {
			const p = os.platform();
			const rel = os.release();
			if (p === "darwin") return `macos ${macOSVersion()}`;
			if (p === "win32") return `windows ${rel}`;
			return `${p} ${rel}`;
		})(),
		deviceFamily: (() => {
			const p = os.platform();
			if (p === "darwin") return "Mac";
			if (p === "win32") return "Windows";
			if (p === "linux") return "Linux";
			return p;
		})(),
		modelIdentifier,
		mode: "gateway",
		reason: "self",
		text: `Gateway: ${host}${ip ? ` (${ip})` : ""} · app ${version} · mode gateway · reason self`,
		ts: Date.now()
	};
	const key = host.toLowerCase();
	entries.set(key, selfEntry);
}
function ensureSelfPresence() {
	if (entries.size === 0) initSelfPresence();
}
function touchSelfPresence() {
	const key = os.hostname().toLowerCase();
	const existing = entries.get(key);
	if (existing) entries.set(key, {
		...existing,
		ts: Date.now()
	});
	else initSelfPresence();
}
initSelfPresence();
function parsePresence(text) {
	const trimmed = text.trim();
	const match = trimmed.match(/Node:\s*([^ (]+)\s*\(([^)]+)\)\s*·\s*app\s*([^·]+?)\s*·\s*last input\s*([0-9]+)s ago\s*·\s*mode\s*([^·]+?)\s*·\s*reason\s*(.+)$/i);
	if (!match) return {
		text: trimmed,
		ts: Date.now()
	};
	const [, host, ip, version, lastInputStr, mode, reasonRaw] = match;
	const lastInputSeconds = Number.parseInt(lastInputStr, 10);
	const reason = reasonRaw.trim();
	return {
		host: host.trim(),
		ip: ip.trim(),
		version: version.trim(),
		lastInputSeconds: Number.isFinite(lastInputSeconds) ? lastInputSeconds : void 0,
		mode: mode.trim(),
		reason,
		text: trimmed,
		ts: Date.now()
	};
}
function mergeStringList(...values) {
	const out = /* @__PURE__ */ new Set();
	for (const list of values) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			const trimmed = String(item).trim();
			if (trimmed) out.add(trimmed);
		}
	}
	return out.size > 0 ? [...out] : void 0;
}
function updateSystemPresence(payload) {
	ensureSelfPresence();
	const parsed = parsePresence(payload.text);
	const key = normalizePresenceKey(payload.deviceId) || normalizePresenceKey(payload.instanceId) || normalizePresenceKey(parsed.instanceId) || normalizePresenceKey(parsed.host) || parsed.ip || parsed.text.slice(0, 64) || os.hostname().toLowerCase();
	const hadExisting = entries.has(key);
	const existing = entries.get(key) ?? {};
	const merged = {
		...existing,
		...parsed,
		host: payload.host ?? parsed.host ?? existing.host,
		ip: payload.ip ?? parsed.ip ?? existing.ip,
		version: payload.version ?? parsed.version ?? existing.version,
		platform: payload.platform ?? existing.platform,
		deviceFamily: payload.deviceFamily ?? existing.deviceFamily,
		modelIdentifier: payload.modelIdentifier ?? existing.modelIdentifier,
		mode: payload.mode ?? parsed.mode ?? existing.mode,
		lastInputSeconds: payload.lastInputSeconds ?? parsed.lastInputSeconds ?? existing.lastInputSeconds,
		reason: payload.reason ?? parsed.reason ?? existing.reason,
		deviceId: payload.deviceId ?? existing.deviceId,
		roles: mergeStringList(existing.roles, payload.roles),
		scopes: mergeStringList(existing.scopes, payload.scopes),
		instanceId: payload.instanceId ?? parsed.instanceId ?? existing.instanceId,
		text: payload.text || parsed.text || existing.text,
		ts: Date.now()
	};
	entries.set(key, merged);
	const trackKeys = [
		"host",
		"ip",
		"version",
		"mode",
		"reason"
	];
	const changes = {};
	const changedKeys = [];
	for (const k of trackKeys) {
		const prev = existing[k];
		const next = merged[k];
		if (prev !== next) {
			changes[k] = next;
			changedKeys.push(k);
		}
	}
	return {
		key,
		previous: hadExisting ? existing : void 0,
		next: merged,
		changes,
		changedKeys
	};
}
function upsertPresence(key, presence) {
	ensureSelfPresence();
	const normalizedKey = normalizePresenceKey(key) ?? os.hostname().toLowerCase();
	const existing = entries.get(normalizedKey) ?? {};
	const roles = mergeStringList(existing.roles, presence.roles);
	const scopes = mergeStringList(existing.scopes, presence.scopes);
	const merged = {
		...existing,
		...presence,
		roles,
		scopes,
		ts: Date.now(),
		text: presence.text || existing.text || `Node: ${presence.host ?? existing.host ?? "unknown"} · mode ${presence.mode ?? existing.mode ?? "unknown"}`
	};
	entries.set(normalizedKey, merged);
}
function listSystemPresence() {
	ensureSelfPresence();
	const now = Date.now();
	for (const [k, v] of entries) if (now - v.ts > TTL_MS) entries.delete(k);
	if (entries.size > MAX_ENTRIES) {
		const sorted = [...entries.entries()].toSorted((a, b) => a[1].ts - b[1].ts);
		const toDrop = entries.size - MAX_ENTRIES;
		for (let i = 0; i < toDrop; i++) entries.delete(sorted[i][0]);
	}
	touchSelfPresence();
	return [...entries.values()].toSorted((a, b) => b.ts - a.ts);
}
//#endregion
//#region src/gateway/server/health-state.ts
init_session_key();
let presenceVersion = 1;
let healthVersion = 1;
let healthCache = null;
let healthRefresh = null;
let broadcastHealthUpdate = null;
function buildGatewaySnapshot() {
	const cfg = loadConfig();
	const configPath = createConfigIO().configPath;
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const mainKey = normalizeMainKey(cfg.session?.mainKey);
	const mainSessionKey = resolveMainSessionKey(cfg);
	const scope = cfg.session?.scope ?? "per-sender";
	const presence = listSystemPresence();
	const uptimeMs = Math.round(process.uptime() * 1e3);
	const auth = resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		env: process.env
	});
	const updateAvailable = getUpdateAvailable() ?? void 0;
	return {
		presence,
		health: {},
		stateVersion: {
			presence: presenceVersion,
			health: healthVersion
		},
		uptimeMs,
		configPath,
		stateDir: STATE_DIR,
		sessionDefaults: {
			defaultAgentId,
			mainKey,
			mainSessionKey,
			scope
		},
		authMode: auth.mode,
		updateAvailable
	};
}
function getHealthCache() {
	return healthCache;
}
function getHealthVersion() {
	return healthVersion;
}
function incrementPresenceVersion() {
	presenceVersion += 1;
	return presenceVersion;
}
function getPresenceVersion() {
	return presenceVersion;
}
function setBroadcastHealthUpdate(fn) {
	broadcastHealthUpdate = fn;
}
async function refreshGatewayHealthSnapshot(opts) {
	if (!healthRefresh) healthRefresh = (async () => {
		const snap = await getHealthSnapshot({ probe: opts?.probe });
		healthCache = snap;
		healthVersion += 1;
		if (broadcastHealthUpdate) broadcastHealthUpdate(snap);
		return snap;
	})().finally(() => {
		healthRefresh = null;
	});
	return healthRefresh;
}
//#endregion
//#region src/gateway/server-maintenance.ts
function startGatewayMaintenanceTimers(params) {
	setBroadcastHealthUpdate((snap) => {
		params.broadcast("health", snap, { stateVersion: {
			presence: params.getPresenceVersion(),
			health: params.getHealthVersion()
		} });
		params.nodeSendToAllSubscribed("health", snap);
	});
	const tickInterval = setInterval(() => {
		const payload = { ts: Date.now() };
		params.broadcast("tick", payload, { dropIfSlow: true });
		params.nodeSendToAllSubscribed("tick", payload);
	}, TICK_INTERVAL_MS);
	const healthInterval = setInterval(() => {
		params.refreshGatewayHealthSnapshot({ probe: true }).catch((err) => params.logHealth.error(`refresh failed: ${formatError(err)}`));
	}, HEALTH_REFRESH_INTERVAL_MS);
	params.refreshGatewayHealthSnapshot({ probe: true }).catch((err) => params.logHealth.error(`initial refresh failed: ${formatError(err)}`));
	const dedupeCleanup = setInterval(() => {
		const AGENT_RUN_SEQ_MAX = 1e4;
		const now = Date.now();
		for (const [k, v] of params.dedupe) if (now - v.ts > 3e5) params.dedupe.delete(k);
		if (params.dedupe.size > 1e3) {
			const entries = [...params.dedupe.entries()].toSorted((a, b) => a[1].ts - b[1].ts);
			for (let i = 0; i < params.dedupe.size - DEDUPE_MAX; i++) params.dedupe.delete(entries[i][0]);
		}
		if (params.agentRunSeq.size > AGENT_RUN_SEQ_MAX) {
			const excess = params.agentRunSeq.size - AGENT_RUN_SEQ_MAX;
			let removed = 0;
			for (const runId of params.agentRunSeq.keys()) {
				params.agentRunSeq.delete(runId);
				removed += 1;
				if (removed >= excess) break;
			}
		}
		for (const [runId, entry] of params.chatAbortControllers) {
			if (now <= entry.expiresAtMs) continue;
			abortChatRunById({
				chatAbortControllers: params.chatAbortControllers,
				chatRunBuffers: params.chatRunBuffers,
				chatDeltaSentAt: params.chatDeltaSentAt,
				chatAbortedRuns: params.chatRunState.abortedRuns,
				removeChatRun: params.removeChatRun,
				agentRunSeq: params.agentRunSeq,
				broadcast: params.broadcast,
				nodeSendToSession: params.nodeSendToSession
			}, {
				runId,
				sessionKey: entry.sessionKey,
				stopReason: "timeout"
			});
		}
		const ABORTED_RUN_TTL_MS = 60 * 6e4;
		for (const [runId, abortedAt] of params.chatRunState.abortedRuns) {
			if (now - abortedAt <= ABORTED_RUN_TTL_MS) continue;
			params.chatRunState.abortedRuns.delete(runId);
			params.chatRunBuffers.delete(runId);
			params.chatDeltaSentAt.delete(runId);
		}
	}, 6e4);
	if (typeof params.mediaCleanupTtlMs !== "number") return {
		tickInterval,
		healthInterval,
		dedupeCleanup,
		mediaCleanup: null
	};
	let mediaCleanupInFlight = null;
	const runMediaCleanup = () => {
		if (mediaCleanupInFlight) return mediaCleanupInFlight;
		mediaCleanupInFlight = cleanOldMedia(params.mediaCleanupTtlMs, {
			recursive: true,
			pruneEmptyDirs: true
		}).catch((err) => {
			params.logHealth.error(`media cleanup failed: ${formatError(err)}`);
		}).finally(() => {
			mediaCleanupInFlight = null;
		});
		return mediaCleanupInFlight;
	};
	const mediaCleanup = setInterval(() => {
		runMediaCleanup();
	}, 60 * 6e4);
	runMediaCleanup();
	return {
		tickInterval,
		healthInterval,
		dedupeCleanup,
		mediaCleanup
	};
}
//#endregion
//#region src/gateway/server-methods-list.ts
const BASE_METHODS = [
	"health",
	"doctor.memory.status",
	"logs.tail",
	"channels.status",
	"channels.logout",
	"status",
	"usage.status",
	"usage.cost",
	"tts.status",
	"tts.providers",
	"tts.enable",
	"tts.disable",
	"tts.convert",
	"tts.setProvider",
	"config.get",
	"config.set",
	"config.apply",
	"config.patch",
	"config.schema",
	"config.schema.lookup",
	"exec.approvals.get",
	"exec.approvals.set",
	"exec.approvals.node.get",
	"exec.approvals.node.set",
	"exec.approval.request",
	"exec.approval.waitDecision",
	"exec.approval.resolve",
	"wizard.start",
	"wizard.next",
	"wizard.cancel",
	"wizard.status",
	"talk.config",
	"talk.mode",
	"models.list",
	"tools.catalog",
	"agents.list",
	"agents.create",
	"agents.update",
	"agents.delete",
	"agents.files.list",
	"agents.files.get",
	"agents.files.set",
	"skills.status",
	"skills.bins",
	"skills.install",
	"skills.update",
	"update.run",
	"voicewake.get",
	"voicewake.set",
	"secrets.reload",
	"secrets.resolve",
	"sessions.list",
	"sessions.preview",
	"sessions.patch",
	"sessions.reset",
	"sessions.delete",
	"sessions.compact",
	"last-heartbeat",
	"set-heartbeats",
	"wake",
	"node.pair.request",
	"node.pair.list",
	"node.pair.approve",
	"node.pair.reject",
	"node.pair.verify",
	"device.pair.list",
	"device.pair.approve",
	"device.pair.reject",
	"device.pair.remove",
	"device.token.rotate",
	"device.token.revoke",
	"node.rename",
	"node.list",
	"node.describe",
	"node.pending.drain",
	"node.pending.enqueue",
	"node.invoke",
	"node.pending.pull",
	"node.pending.ack",
	"node.invoke.result",
	"node.event",
	"node.canvas.capability.refresh",
	"cron.list",
	"cron.status",
	"cron.add",
	"cron.update",
	"cron.remove",
	"cron.run",
	"cron.runs",
	"gateway.identity.get",
	"system-presence",
	"system-event",
	"send",
	"agent",
	"agent.identity.get",
	"agent.wait",
	"browser.request",
	"chat.history",
	"chat.abort",
	"chat.send"
];
function listGatewayMethods() {
	const channelMethods = listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []);
	return Array.from(new Set([...BASE_METHODS, ...channelMethods]));
}
const GATEWAY_EVENTS = [
	"connect.challenge",
	"agent",
	"chat",
	"presence",
	"tick",
	"talk.mode",
	"shutdown",
	"health",
	"heartbeat",
	"cron",
	"node.pair.requested",
	"node.pair.resolved",
	"node.invoke.request",
	"device.pair.requested",
	"device.pair.resolved",
	"voicewake.changed",
	"exec.approval.requested",
	"exec.approval.resolved",
	GATEWAY_EVENT_UPDATE_AVAILABLE
];
//#endregion
//#region src/plugins/runtime/gateway-request-scope.ts
const PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY = Symbol.for("openclaw.pluginRuntimeGatewayRequestScope");
const pluginRuntimeGatewayRequestScope = (() => {
	const globalState = globalThis;
	const existing = globalState[PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY];
	if (existing) return existing;
	const created = new AsyncLocalStorage();
	globalState[PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY] = created;
	return created;
})();
/**
* Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
*/
function withPluginRuntimeGatewayRequestScope(scope, run) {
	return pluginRuntimeGatewayRequestScope.run(scope, run);
}
/**
* Returns the current plugin gateway request scope when called from a plugin request handler.
*/
function getPluginRuntimeGatewayRequestScope() {
	return pluginRuntimeGatewayRequestScope.getStore();
}
//#endregion
//#region src/gateway/control-plane-audit.ts
function normalizePart$1(value, fallback) {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback;
}
function resolveControlPlaneActor(client) {
	return {
		actor: normalizePart$1(client?.connect?.client?.id, "unknown-actor"),
		deviceId: normalizePart$1(client?.connect?.device?.id, "unknown-device"),
		clientIp: normalizePart$1(client?.clientIp, "unknown-ip"),
		connId: normalizePart$1(client?.connId, "unknown-conn")
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
//#region src/gateway/control-plane-rate-limit.ts
const CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS = 3;
const CONTROL_PLANE_RATE_LIMIT_WINDOW_MS = 6e4;
const controlPlaneBuckets = /* @__PURE__ */ new Map();
function normalizePart(value, fallback) {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback;
}
function resolveControlPlaneRateLimitKey(client) {
	const deviceId = normalizePart(client?.connect?.device?.id, "unknown-device");
	const clientIp = normalizePart(client?.clientIp, "unknown-ip");
	if (deviceId === "unknown-device" && clientIp === "unknown-ip") {
		const connId = normalizePart(client?.connId, "");
		if (connId) return `${deviceId}|${clientIp}|conn=${connId}`;
	}
	return `${deviceId}|${clientIp}`;
}
function consumeControlPlaneWriteBudget(params) {
	const nowMs = params.nowMs ?? Date.now();
	const key = resolveControlPlaneRateLimitKey(params.client);
	const bucket = controlPlaneBuckets.get(key);
	if (!bucket || nowMs - bucket.windowStartMs >= CONTROL_PLANE_RATE_LIMIT_WINDOW_MS) {
		controlPlaneBuckets.set(key, {
			count: 1,
			windowStartMs: nowMs
		});
		return {
			allowed: true,
			retryAfterMs: 0,
			remaining: CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS - 1,
			key
		};
	}
	if (bucket.count >= CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS) return {
		allowed: false,
		retryAfterMs: Math.max(0, bucket.windowStartMs + CONTROL_PLANE_RATE_LIMIT_WINDOW_MS - nowMs),
		remaining: 0,
		key
	};
	bucket.count += 1;
	return {
		allowed: true,
		retryAfterMs: 0,
		remaining: Math.max(0, CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS - bucket.count),
		key
	};
}
//#endregion
//#region src/gateway/role-policy.ts
function parseGatewayRole(roleRaw) {
	if (roleRaw === "operator" || roleRaw === "node") return roleRaw;
	return null;
}
function roleCanSkipDeviceIdentity(role, sharedAuthOk) {
	return role === "operator" && sharedAuthOk;
}
function isRoleAuthorizedForMethod(role, method) {
	if (isNodeRoleMethod(method)) return role === "node";
	return role === "operator";
}
//#endregion
//#region src/shared/assistant-identity-values.ts
function coerceIdentityValue(value, maxLength) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (trimmed.length <= maxLength) return trimmed;
	return trimmed.slice(0, maxLength);
}
//#endregion
//#region src/gateway/assistant-identity.ts
init_session_key();
const MAX_ASSISTANT_NAME = 50;
const MAX_ASSISTANT_AVATAR = 200;
const MAX_ASSISTANT_EMOJI = 16;
const DEFAULT_ASSISTANT_IDENTITY = {
	agentId: "main",
	name: "Assistant",
	avatar: "A"
};
function isAvatarUrl(value) {
	return isAvatarHttpUrl(value) || isAvatarImageDataUrl(value);
}
function normalizeAvatarValue(value) {
	if (!value) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (isAvatarUrl(trimmed)) return trimmed;
	if (looksLikeAvatarPath(trimmed)) return trimmed;
	if (!/\s/.test(trimmed) && trimmed.length <= 4) return trimmed;
}
function normalizeEmojiValue(value) {
	if (!value) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (trimmed.length > MAX_ASSISTANT_EMOJI) return;
	let hasNonAscii = false;
	for (let i = 0; i < trimmed.length; i += 1) if (trimmed.charCodeAt(i) > 127) {
		hasNonAscii = true;
		break;
	}
	if (!hasNonAscii) return;
	if (isAvatarUrl(trimmed) || looksLikeAvatarPath(trimmed)) return;
	return trimmed;
}
function resolveAssistantIdentity(params) {
	const agentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(params.cfg));
	const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
	const configAssistant = params.cfg.ui?.assistant;
	const agentIdentity = resolveAgentIdentity(params.cfg, agentId);
	const fileIdentity = workspaceDir ? loadAgentIdentity(workspaceDir) : null;
	return {
		agentId,
		name: coerceIdentityValue(configAssistant?.name, MAX_ASSISTANT_NAME) ?? coerceIdentityValue(agentIdentity?.name, MAX_ASSISTANT_NAME) ?? coerceIdentityValue(fileIdentity?.name, MAX_ASSISTANT_NAME) ?? DEFAULT_ASSISTANT_IDENTITY.name,
		avatar: [
			coerceIdentityValue(configAssistant?.avatar, MAX_ASSISTANT_AVATAR),
			coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_AVATAR),
			coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_AVATAR),
			coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_AVATAR),
			coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_AVATAR)
		].map((candidate) => normalizeAvatarValue(candidate)).find(Boolean) ?? DEFAULT_ASSISTANT_IDENTITY.avatar,
		emoji: [
			coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_EMOJI),
			coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_EMOJI),
			coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_EMOJI),
			coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_EMOJI)
		].map((candidate) => normalizeEmojiValue(candidate)).find(Boolean)
	};
}
//#endregion
//#region src/gateway/session-reset-service.ts
init_session_key();
const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15e3;
let cachedChannelRuntime$1;
function getChannelRuntime$1() {
	cachedChannelRuntime$1 ??= createPluginRuntime().channel;
	return cachedChannelRuntime$1;
}
function stripRuntimeModelState(entry) {
	if (!entry) return entry;
	return {
		...entry,
		model: void 0,
		modelProvider: void 0,
		contextTokens: void 0,
		systemPromptReport: void 0
	};
}
function archiveSessionTranscriptsForSession(params) {
	if (!params.sessionId) return [];
	return archiveSessionTranscripts({
		sessionId: params.sessionId,
		storePath: params.storePath,
		sessionFile: params.sessionFile,
		agentId: params.agentId,
		reason: params.reason
	});
}
async function emitSessionUnboundLifecycleEvent(params) {
	const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
	getChannelRuntime$1().discord.threadBindings.unbindBySessionKey({
		targetSessionKey: params.targetSessionKey,
		targetKind,
		reason: params.reason,
		sendFarewell: true
	});
	if (params.emitHooks === false) return;
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("subagent_ended")) return;
	await hookRunner.runSubagentEnded({
		targetSessionKey: params.targetSessionKey,
		targetKind,
		reason: params.reason,
		sendFarewell: true,
		outcome: params.reason === "session-reset" ? "reset" : "deleted"
	}, { childSessionKey: params.targetSessionKey });
}
async function ensureSessionRuntimeCleanup(params) {
	const closeTrackedBrowserTabs = async () => {
		return await closeTrackedBrowserTabsForSessions({
			sessionKeys: [...new Set([
				params.key,
				params.target.canonicalKey,
				...params.target.storeKeys,
				params.sessionId ?? ""
			])],
			onWarn: (message) => logVerbose(message)
		});
	};
	const queueKeys = new Set(params.target.storeKeys);
	queueKeys.add(params.target.canonicalKey);
	if (params.sessionId) queueKeys.add(params.sessionId);
	clearSessionQueues([...queueKeys]);
	stopSubagentsForRequester({
		cfg: params.cfg,
		requesterSessionKey: params.target.canonicalKey
	});
	if (!params.sessionId) {
		clearBootstrapSnapshot(params.target.canonicalKey);
		await closeTrackedBrowserTabs();
		return;
	}
	abortEmbeddedPiRun(params.sessionId);
	const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15e3);
	clearBootstrapSnapshot(params.target.canonicalKey);
	if (ended) {
		await closeTrackedBrowserTabs();
		return;
	}
	return errorShape(ErrorCodes.UNAVAILABLE, `Session ${params.key} is still active; try again in a moment.`);
}
async function runAcpCleanupStep(params) {
	let timer;
	const timeoutPromise = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
	});
	const opPromise = params.op().then(() => ({ status: "ok" })).catch((error) => ({
		status: "error",
		error
	}));
	const outcome = await Promise.race([opPromise, timeoutPromise]);
	if (timer) clearTimeout(timer);
	return outcome;
}
async function closeAcpRuntimeForSession(params) {
	if (!params.entry?.acp) return;
	const acpManager = getAcpSessionManager();
	const cancelOutcome = await runAcpCleanupStep({ op: async () => {
		await acpManager.cancelSession({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			reason: params.reason
		});
	} });
	if (cancelOutcome.status === "timeout") return errorShape(ErrorCodes.UNAVAILABLE, `Session ${params.sessionKey} is still active; try again in a moment.`);
	if (cancelOutcome.status === "error") logVerbose(`sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`);
	const closeOutcome = await runAcpCleanupStep({ op: async () => {
		await acpManager.closeSession({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			reason: params.reason,
			requireAcpSession: false,
			allowBackendUnavailable: true
		});
	} });
	if (closeOutcome.status === "timeout") return errorShape(ErrorCodes.UNAVAILABLE, `Session ${params.sessionKey} is still active; try again in a moment.`);
	if (closeOutcome.status === "error") logVerbose(`sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`);
}
async function cleanupSessionBeforeMutation(params) {
	const cleanupError = await ensureSessionRuntimeCleanup({
		cfg: params.cfg,
		key: params.key,
		target: params.target,
		sessionId: params.entry?.sessionId
	});
	if (cleanupError) return cleanupError;
	return await closeAcpRuntimeForSession({
		cfg: params.cfg,
		sessionKey: params.legacyKey ?? params.canonicalKey ?? params.target.canonicalKey ?? params.key,
		entry: params.entry,
		reason: params.reason
	});
}
async function performGatewaySessionReset(params) {
	const { cfg, target, storePath } = (() => {
		const cfg = loadConfig();
		const target = resolveGatewaySessionStoreTarget({
			cfg,
			key: params.key
		});
		return {
			cfg,
			target,
			storePath: target.storePath
		};
	})();
	const { entry, legacyKey, canonicalKey } = loadSessionEntry(params.key);
	const hadExistingEntry = Boolean(entry);
	await triggerInternalHook(createInternalHookEvent("command", params.reason, target.canonicalKey ?? params.key, {
		sessionEntry: entry,
		previousSessionEntry: entry,
		commandSource: params.commandSource,
		cfg
	}));
	const mutationCleanupError = await cleanupSessionBeforeMutation({
		cfg,
		key: params.key,
		target,
		entry,
		legacyKey,
		canonicalKey,
		reason: "session-reset"
	});
	if (mutationCleanupError) return {
		ok: false,
		error: mutationCleanupError
	};
	let oldSessionId;
	let oldSessionFile;
	const next = await updateSessionStore(storePath, (store) => {
		const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
			cfg,
			key: params.key,
			store
		});
		const currentEntry = store[primaryKey];
		const resetEntry = stripRuntimeModelState(currentEntry);
		const resolvedModel = resolveSessionModelRef(cfg, resetEntry, normalizeAgentId(parseAgentSessionKey(primaryKey)?.agentId ?? resolveDefaultAgentId(cfg)));
		oldSessionId = currentEntry?.sessionId;
		oldSessionFile = currentEntry?.sessionFile;
		const now = Date.now();
		const nextEntry = {
			sessionId: randomUUID(),
			updatedAt: now,
			systemSent: false,
			abortedLastRun: false,
			thinkingLevel: currentEntry?.thinkingLevel,
			fastMode: currentEntry?.fastMode,
			verboseLevel: currentEntry?.verboseLevel,
			reasoningLevel: currentEntry?.reasoningLevel,
			responseUsage: currentEntry?.responseUsage,
			model: resolvedModel.model,
			modelProvider: resolvedModel.provider,
			contextTokens: resetEntry?.contextTokens,
			sendPolicy: currentEntry?.sendPolicy,
			label: currentEntry?.label,
			origin: snapshotSessionOrigin(currentEntry),
			lastChannel: currentEntry?.lastChannel,
			lastTo: currentEntry?.lastTo,
			lastAccountId: currentEntry?.lastAccountId,
			lastThreadId: currentEntry?.lastThreadId,
			skillsSnapshot: currentEntry?.skillsSnapshot,
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			totalTokensFresh: true
		};
		store[primaryKey] = nextEntry;
		return nextEntry;
	});
	archiveSessionTranscriptsForSession({
		sessionId: oldSessionId,
		storePath,
		sessionFile: oldSessionFile,
		agentId: target.agentId,
		reason: "reset"
	});
	if (hadExistingEntry) await emitSessionUnboundLifecycleEvent({
		targetSessionKey: target.canonicalKey ?? params.key,
		reason: "session-reset"
	});
	return {
		ok: true,
		key: target.canonicalKey,
		entry: next
	};
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
const agentRunCache = /* @__PURE__ */ new Map();
const agentRunStarts = /* @__PURE__ */ new Map();
const pendingAgentRunErrors = /* @__PURE__ */ new Map();
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
function schedulePendingAgentRunError(snapshot) {
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
function getPendingAgentRunError(runId) {
	const pending = pendingAgentRunErrors.get(runId);
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
	return {
		runId,
		status: phase === "error" ? "error" : data?.aborted ? "timeout" : "ok",
		startedAt,
		endedAt,
		error,
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
		clearPendingAgentRunError(evt.runId);
		recordAgentRunSnapshot(snapshot);
	});
}
function getCachedAgentRun(runId) {
	pruneAgentRunCache();
	return agentRunCache.get(runId);
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
		let onAbort;
		const clearPendingErrorTimer = () => {
			if (!pendingErrorTimer) return;
			clearTimeout(pendingErrorTimer);
			pendingErrorTimer = void 0;
		};
		const finish = (entry) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearPendingErrorTimer();
			unsubscribe();
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			resolve(entry);
		};
		const scheduleErrorFinish = (snapshot, delayMs = AGENT_RUN_ERROR_RETRY_GRACE_MS) => {
			clearPendingErrorTimer();
			const effectiveDelay = Math.max(1, Math.min(Math.floor(delayMs), 2147483647));
			pendingErrorTimer = setTimeout(() => {
				const latest = ignoreCachedSnapshot ? void 0 : getCachedAgentRun(runId);
				if (latest) {
					finish(latest);
					return;
				}
				recordAgentRunSnapshot(snapshot);
				finish(snapshot);
			}, effectiveDelay);
			pendingErrorTimer.unref?.();
		};
		if (!ignoreCachedSnapshot) {
			const pending = getPendingAgentRunError(runId);
			if (pending) scheduleErrorFinish(pending.snapshot, pending.dueAt - Date.now());
		}
		const unsubscribe = onAgentEvent((evt) => {
			if (!evt || evt.stream !== "lifecycle") return;
			if (evt.runId !== runId) return;
			const phase = evt.data?.phase;
			if (phase === "start") {
				clearPendingErrorTimer();
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
			recordAgentRunSnapshot(snapshot);
			finish(snapshot);
		});
		const timerDelayMs = Math.max(1, Math.min(Math.floor(timeoutMs), 2147483647));
		const timer = setTimeout(() => finish(null), timerDelayMs);
		onAbort = () => finish(null);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
ensureAgentRunListener();
//#endregion
//#region src/gateway/server-methods/agent-timestamp.ts
/**
* Cron jobs inject "Current time: ..." into their messages.
* Skip injection for those.
*/
const CRON_TIME_PATTERN = /Current time: /;
/**
* Matches a leading `[... YYYY-MM-DD HH:MM ...]` envelope — either from
* channel plugins or from a previous injection. Uses the same YYYY-MM-DD
* HH:MM format as {@link formatZonedTimestamp}, so detection stays in sync
* with the formatting.
*/
const TIMESTAMP_ENVELOPE_PATTERN = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
/**
* Injects a compact timestamp prefix into a message if one isn't already
* present. Uses the same `YYYY-MM-DD HH:MM TZ` format as channel envelope
* timestamps ({@link formatZonedTimestamp}), keeping token cost low (~7
* tokens) and format consistent across all agent contexts.
*
* Used by the gateway `agent` and `chat.send` handlers to give TUI, web,
* spawned subagents, `sessions_send`, and heartbeat wake events date/time
* awareness — without modifying the system prompt (which is cached).
*
* Channel messages (Discord, Telegram, etc.) already have timestamps via
* envelope formatting and take a separate code path — they never reach
* these handlers, so there is no double-stamping risk. The detection
* pattern is a safety net for edge cases.
*
* @see https://github.com/moltbot/moltbot/issues/3658
*/
function injectTimestamp(message, opts) {
	if (!message.trim()) return message;
	if (TIMESTAMP_ENVELOPE_PATTERN.test(message)) return message;
	if (CRON_TIME_PATTERN.test(message)) return message;
	const now = opts?.now ?? /* @__PURE__ */ new Date();
	const timezone = opts?.timezone ?? "UTC";
	const formatted = formatZonedTimestamp(now, { timeZone: timezone });
	if (!formatted) return message;
	return `[${new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		weekday: "short"
	}).format(now)} ${formatted}] ${message}`;
}
/**
* Build TimestampInjectionOptions from an OpenClawConfig.
*/
function timestampOptsFromConfig(cfg) {
	return { timezone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone) };
}
//#endregion
//#region src/gateway/server-methods/agent-wait-dedupe.ts
const AGENT_WAITERS_BY_RUN_ID = /* @__PURE__ */ new Map();
function parseRunIdFromDedupeKey(key) {
	if (key.startsWith("agent:")) return key.slice(6) || null;
	if (key.startsWith("chat:")) return key.slice(5) || null;
	return null;
}
function asFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function removeWaiter(runId, waiter) {
	const waiters = AGENT_WAITERS_BY_RUN_ID.get(runId);
	if (!waiters) return;
	waiters.delete(waiter);
	if (waiters.size === 0) AGENT_WAITERS_BY_RUN_ID.delete(runId);
}
function addWaiter(runId, waiter) {
	const normalizedRunId = runId.trim();
	if (!normalizedRunId) return () => {};
	const existing = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
	if (existing) {
		existing.add(waiter);
		return () => removeWaiter(normalizedRunId, waiter);
	}
	AGENT_WAITERS_BY_RUN_ID.set(normalizedRunId, new Set([waiter]));
	return () => removeWaiter(normalizedRunId, waiter);
}
function notifyWaiters(runId) {
	const normalizedRunId = runId.trim();
	if (!normalizedRunId) return;
	const waiters = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
	if (!waiters || waiters.size === 0) return;
	for (const waiter of waiters) waiter();
}
function readTerminalSnapshotFromDedupeEntry(entry) {
	const payload = entry.payload;
	const status = typeof payload?.status === "string" ? payload.status : void 0;
	if (status === "accepted" || status === "started" || status === "in_flight") return null;
	const startedAt = asFiniteNumber(payload?.startedAt);
	const endedAt = asFiniteNumber(payload?.endedAt) ?? entry.ts;
	const errorMessage = typeof payload?.error === "string" ? payload.error : typeof payload?.summary === "string" ? payload.summary : entry.error?.message;
	if (status === "ok" || status === "timeout") return {
		status,
		startedAt,
		endedAt,
		error: status === "timeout" ? errorMessage : void 0
	};
	if (status === "error" || !entry.ok) return {
		status: "error",
		startedAt,
		endedAt,
		error: errorMessage
	};
	return null;
}
function readTerminalSnapshotFromGatewayDedupe(params) {
	if (params.ignoreAgentTerminalSnapshot) {
		const chatEntry = params.dedupe.get(`chat:${params.runId}`);
		if (!chatEntry) return null;
		return readTerminalSnapshotFromDedupeEntry(chatEntry);
	}
	const chatEntry = params.dedupe.get(`chat:${params.runId}`);
	const chatSnapshot = chatEntry ? readTerminalSnapshotFromDedupeEntry(chatEntry) : null;
	const agentEntry = params.dedupe.get(`agent:${params.runId}`);
	const agentSnapshot = agentEntry ? readTerminalSnapshotFromDedupeEntry(agentEntry) : null;
	if (agentEntry) {
		if (!agentSnapshot) {
			if (chatSnapshot && chatEntry && chatEntry.ts > agentEntry.ts) return chatSnapshot;
			return null;
		}
	}
	if (agentSnapshot && chatSnapshot && agentEntry && chatEntry) return chatEntry.ts > agentEntry.ts ? chatSnapshot : agentSnapshot;
	return agentSnapshot ?? chatSnapshot;
}
async function waitForTerminalGatewayDedupe(params) {
	const initial = readTerminalSnapshotFromGatewayDedupe(params);
	if (initial) return initial;
	if (params.timeoutMs <= 0 || params.signal?.aborted) return null;
	return await new Promise((resolve) => {
		let settled = false;
		let timeoutHandle;
		let onAbort;
		let removeWaiter;
		const finish = (snapshot) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (onAbort) params.signal?.removeEventListener("abort", onAbort);
			removeWaiter?.();
			resolve(snapshot);
		};
		const onWake = () => {
			const snapshot = readTerminalSnapshotFromGatewayDedupe(params);
			if (snapshot) finish(snapshot);
		};
		removeWaiter = addWaiter(params.runId, onWake);
		onWake();
		if (settled) return;
		const timeoutDelayMs = Math.max(1, Math.min(Math.floor(params.timeoutMs), 2147483647));
		timeoutHandle = setTimeout(() => finish(null), timeoutDelayMs);
		timeoutHandle.unref?.();
		onAbort = () => finish(null);
		params.signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function setGatewayDedupeEntry(params) {
	params.dedupe.set(params.key, params.entry);
	const runId = parseRunIdFromDedupeKey(params.key);
	if (!runId) return;
	if (!readTerminalSnapshotFromDedupeEntry(params.entry)) return;
	notifyWaiters(runId);
}
//#endregion
//#region src/gateway/server-methods/agent.ts
init_session_key();
init_runtime();
const RESET_COMMAND_RE = /^\/(new|reset)(?:\s+([\s\S]*))?$/i;
function resolveSenderIsOwnerFromClient(client) {
	return (Array.isArray(client?.connect?.scopes) ? client.connect.scopes : []).includes(ADMIN_SCOPE$3);
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
function dispatchAgentRunFromGateway(params) {
	agentCommandFromIngress(params.ingressOpts, defaultRuntime, params.context.deps).then((result) => {
		const payload = {
			runId: params.runId,
			status: "ok",
			summary: "completed",
			result
		};
		setGatewayDedupeEntry({
			dedupe: params.context.dedupe,
			key: `agent:${params.idempotencyKey}`,
			entry: {
				ts: Date.now(),
				ok: true,
				payload
			}
		});
		params.respond(true, payload, void 0, { runId: params.runId });
	}).catch((err) => {
		const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
		const payload = {
			runId: params.runId,
			status: "error",
			summary: String(err)
		};
		setGatewayDedupeEntry({
			dedupe: params.context.dedupe,
			key: `agent:${params.idempotencyKey}`,
			entry: {
				ts: Date.now(),
				ok: false,
				payload,
				error
			}
		});
		params.respond(false, payload, error, {
			runId: params.runId,
			error: formatForLog(err)
		});
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
		const senderIsOwner = resolveSenderIsOwnerFromClient(client);
		const cfg = loadConfig();
		const idem = request.idempotencyKey;
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
		const cached = context.dedupe.get(`agent:${idem}`);
		if (cached) {
			respond(cached.ok, cached.payload, cached.error, { cached: true });
			return;
		}
		const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(request.attachments);
		const requestedBestEffortDeliver = typeof request.bestEffortDeliver === "boolean" ? request.bestEffortDeliver : void 0;
		let message = (request.message ?? "").trim();
		let images = [];
		if (normalizedAttachments.length > 0) try {
			const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
				maxBytes: 5e6,
				log: context.logGateway
			});
			message = parsed.message.trim();
			images = parsed.images;
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
			return;
		}
		const isKnownGatewayChannel = (value) => isGatewayMessageChannel(value);
		const channelHints = [request.channel, request.replyChannel].filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean);
		for (const rawChannel of channelHints) {
			const normalized = normalizeMessageChannel(rawChannel);
			if (normalized && normalized !== "last" && !isKnownGatewayChannel(normalized)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent params: unknown channel: ${String(normalized)}`));
				return;
			}
		}
		const agentIdRaw = typeof request.agentId === "string" ? request.agentId.trim() : "";
		const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : void 0;
		if (agentId) {
			if (!listAgentIds(cfg).includes(agentId)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent params: unknown agent id "${request.agentId}"`));
				return;
			}
		}
		const requestedSessionKeyRaw = typeof request.sessionKey === "string" && request.sessionKey.trim() ? request.sessionKey.trim() : void 0;
		if (requestedSessionKeyRaw && classifySessionKeyShape(requestedSessionKeyRaw) === "malformed_agent") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent params: malformed session key "${requestedSessionKeyRaw}"`));
			return;
		}
		let requestedSessionKey = requestedSessionKeyRaw ?? resolveExplicitAgentSessionKey({
			cfg,
			agentId
		});
		if (agentId && requestedSessionKeyRaw) {
			const sessionAgentId = resolveAgentIdFromSessionKey(requestedSessionKeyRaw);
			if (sessionAgentId !== agentId) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent params: agent "${request.agentId}" does not match session key agent "${sessionAgentId}"`));
				return;
			}
		}
		let resolvedSessionId = request.sessionId?.trim() || void 0;
		let sessionEntry;
		let bestEffortDeliver = requestedBestEffortDeliver ?? false;
		let cfgForAgent;
		let resolvedSessionKey = requestedSessionKey;
		let skipTimestampInjection = false;
		const resetCommandMatch = message.match(RESET_COMMAND_RE);
		if (resetCommandMatch && requestedSessionKey) {
			const resetReason = resetCommandMatch[1]?.toLowerCase() === "new" ? "new" : "reset";
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
			const postResetMessage = resetCommandMatch[2]?.trim() ?? "";
			if (postResetMessage) message = postResetMessage;
			else {
				message = buildBareSessionResetPrompt(cfg);
				skipTimestampInjection = true;
			}
		}
		if (!skipTimestampInjection) message = injectTimestamp(message, timestampOptsFromConfig(cfg));
		if (requestedSessionKey) {
			const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(requestedSessionKey);
			cfgForAgent = cfg;
			const now = Date.now();
			const sessionId = entry?.sessionId ?? randomUUID();
			const labelValue = request.label?.trim() || entry?.label;
			spawnedByValue = canonicalizeSpawnedByForAgent(cfg, resolveAgentIdFromSessionKey(canonicalKey), entry?.spawnedBy);
			let inheritedGroup;
			if (spawnedByValue && (!resolvedGroupId || !resolvedGroupChannel || !resolvedGroupSpace)) try {
				const parentEntry = loadSessionEntry(spawnedByValue)?.entry;
				inheritedGroup = {
					groupId: parentEntry?.groupId,
					groupChannel: parentEntry?.groupChannel,
					groupSpace: parentEntry?.space
				};
			} catch {
				inheritedGroup = void 0;
			}
			resolvedGroupId = resolvedGroupId || inheritedGroup?.groupId;
			resolvedGroupChannel = resolvedGroupChannel || inheritedGroup?.groupChannel;
			resolvedGroupSpace = resolvedGroupSpace || inheritedGroup?.groupSpace;
			const deliveryFields = normalizeSessionDeliveryFields(entry);
			const nextEntryPatch = {
				sessionId,
				updatedAt: now,
				thinkingLevel: entry?.thinkingLevel,
				fastMode: entry?.fastMode,
				verboseLevel: entry?.verboseLevel,
				reasoningLevel: entry?.reasoningLevel,
				systemSent: entry?.systemSent,
				sendPolicy: entry?.sendPolicy,
				skillsSnapshot: entry?.skillsSnapshot,
				deliveryContext: deliveryFields.deliveryContext,
				lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
				lastTo: deliveryFields.lastTo ?? entry?.lastTo,
				lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
				modelOverride: entry?.modelOverride,
				providerOverride: entry?.providerOverride,
				label: labelValue,
				spawnedBy: spawnedByValue,
				spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
				spawnDepth: entry?.spawnDepth,
				channel: entry?.channel ?? request.channel?.trim(),
				groupId: resolvedGroupId ?? entry?.groupId,
				groupChannel: resolvedGroupChannel ?? entry?.groupChannel,
				space: resolvedGroupSpace ?? entry?.space,
				cliSessionIds: entry?.cliSessionIds,
				claudeCliSessionId: entry?.claudeCliSessionId
			};
			sessionEntry = mergeSessionEntry(entry, nextEntryPatch);
			if (resolveSendPolicy({
				cfg,
				entry,
				sessionKey: canonicalKey,
				channel: entry?.channel,
				chatType: entry?.chatType
			}) === "deny") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"));
				return;
			}
			resolvedSessionId = sessionId;
			const canonicalSessionKey = canonicalKey;
			resolvedSessionKey = canonicalSessionKey;
			const mainSessionKey = resolveAgentMainSessionKey({
				cfg,
				agentId: resolveAgentIdFromSessionKey(canonicalSessionKey)
			});
			if (storePath) sessionEntry = await updateSessionStore(storePath, (store) => {
				const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
					cfg,
					key: requestedSessionKey,
					store
				});
				const merged = mergeSessionEntry(store[primaryKey], nextEntryPatch);
				store[primaryKey] = merged;
				return merged;
			});
			if (canonicalSessionKey === mainSessionKey || canonicalSessionKey === "global") {
				context.addChatRun(idem, {
					sessionKey: canonicalSessionKey,
					clientRunId: idem
				});
				if (requestedBestEffortDeliver === void 0) bestEffortDeliver = true;
			}
			registerAgentRunContext(idem, { sessionKey: canonicalSessionKey });
		}
		const runId = idem;
		const connId = typeof client?.connId === "string" ? client.connId : void 0;
		const wantsToolEvents = hasGatewayClientCap(client?.connect?.caps, GATEWAY_CLIENT_CAPS.TOOL_EVENTS);
		if (connId && wantsToolEvents) {
			context.registerToolEventRecipient(runId, connId);
			for (const [activeRunId, active] of context.chatAbortControllers) if (activeRunId !== runId && active.sessionKey === requestedSessionKey) context.registerToolEventRecipient(activeRunId, connId);
		}
		const wantsDelivery = request.deliver === true;
		const explicitTo = typeof request.replyTo === "string" && request.replyTo.trim() ? request.replyTo.trim() : typeof request.to === "string" && request.to.trim() ? request.to.trim() : void 0;
		const explicitThreadId = typeof request.threadId === "string" && request.threadId.trim() ? request.threadId.trim() : void 0;
		const turnSourceChannel = typeof request.channel === "string" && request.channel.trim() ? request.channel.trim() : void 0;
		const turnSourceTo = typeof request.to === "string" && request.to.trim() ? request.to.trim() : void 0;
		const turnSourceAccountId = typeof request.accountId === "string" && request.accountId.trim() ? request.accountId.trim() : void 0;
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
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
				return;
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
		}
		if (wantsDelivery && resolvedChannel === "webchat") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel"));
			return;
		}
		const normalizedTurnSource = normalizeMessageChannel(turnSourceChannel);
		const originMessageChannel = (normalizedTurnSource && isGatewayMessageChannel(normalizedTurnSource) ? normalizedTurnSource : void 0) ?? (client?.connect && isWebchatConnect(client.connect) ? "webchat" : resolvedChannel);
		const deliver = request.deliver === true && resolvedChannel !== "webchat";
		const accepted = {
			runId,
			status: "accepted",
			acceptedAt: Date.now()
		};
		setGatewayDedupeEntry({
			dedupe: context.dedupe,
			key: `agent:${idem}`,
			entry: {
				ts: Date.now(),
				ok: true,
				payload: accepted
			}
		});
		respond(true, accepted, void 0, { runId });
		const resolvedThreadId = explicitThreadId ?? deliveryPlan.resolvedThreadId;
		dispatchAgentRunFromGateway({
			ingressOpts: {
				message,
				images,
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
				groupId: resolvedGroupId,
				groupChannel: resolvedGroupChannel,
				groupSpace: resolvedGroupSpace,
				spawnedBy: spawnedByValue,
				timeout: request.timeout?.toString(),
				bestEffortDeliver,
				messageChannel: originMessageChannel,
				runId,
				lane: request.lane,
				extraSystemPrompt: request.extraSystemPrompt,
				internalEvents: request.internalEvents,
				inputProvenance,
				workspaceDir: resolveIngressWorkspaceOverrideForSpawnedRun({
					spawnedBy: spawnedByValue,
					workspaceDir: sessionEntry?.spawnedWorkspaceDir
				}),
				senderIsOwner
			},
			runId,
			idempotencyKey: idem,
			respond,
			context
		});
	},
	"agent.identity.get": ({ params, respond }) => {
		if (!validateAgentIdentityParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent.identity.get params: ${formatValidationErrors(validateAgentIdentityParams.errors)}`));
			return;
		}
		const p = params;
		const agentIdRaw = typeof p.agentId === "string" ? p.agentId.trim() : "";
		const sessionKeyRaw = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
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
		const cfg = loadConfig();
		const identity = resolveAssistantIdentity({
			cfg,
			agentId
		});
		const avatarValue = resolveAssistantAvatarUrl({
			avatar: identity.avatar,
			agentId: identity.agentId,
			basePath: cfg.gateway?.controlUi?.basePath
		}) ?? identity.avatar;
		respond(true, {
			...identity,
			avatar: avatarValue
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
		const hasActiveChatRun = context.chatAbortControllers.has(runId);
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
				error: cachedGatewaySnapshot.error
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
			respond(true, {
				runId,
				status: "timeout"
			});
			return;
		}
		respond(true, {
			runId,
			status: snapshot.status,
			startedAt: snapshot.startedAt,
			endedAt: snapshot.endedAt,
			error: snapshot.error
		});
	}
};
//#endregion
//#region src/gateway/server-methods/agents.ts
init_session_key();
init_utils();
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
const MEMORY_FILE_NAMES = [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME];
const ALLOWED_FILE_NAMES = new Set([...BOOTSTRAP_FILE_NAMES, ...MEMORY_FILE_NAMES]);
function resolveAgentWorkspaceFileOrRespondError(params, respond) {
	const cfg = loadConfig();
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
function resolveNotFoundWorkspaceFilePathResult(params) {
	if (!isNotFoundPathError(params.error)) return;
	if (params.allowMissing) return {
		kind: "missing",
		requestPath: params.requestPath,
		ioPath: params.ioPath,
		workspaceReal: params.workspaceReal
	};
	return {
		kind: "invalid",
		requestPath: params.requestPath,
		reason: "file not found"
	};
}
function resolveWorkspaceFilePathResultOrThrow(params) {
	const notFoundResult = resolveNotFoundWorkspaceFilePathResult(params);
	if (notFoundResult) return notFoundResult;
	throw params.error;
}
async function resolveWorkspaceRealPath(workspaceDir) {
	try {
		return await fs$1.realpath(workspaceDir);
	} catch {
		return path.resolve(workspaceDir);
	}
}
async function resolveAgentWorkspaceFilePath(params) {
	const requestPath = path.join(params.workspaceDir, params.name);
	const workspaceReal = await resolveWorkspaceRealPath(params.workspaceDir);
	const candidatePath = path.resolve(workspaceReal, params.name);
	try {
		await assertNoPathAliasEscape({
			absolutePath: candidatePath,
			rootPath: workspaceReal,
			boundaryLabel: "workspace root"
		});
	} catch (error) {
		return {
			kind: "invalid",
			requestPath,
			reason: error instanceof Error ? error.message : "path escapes workspace root"
		};
	}
	const notFoundContext = {
		allowMissing: params.allowMissing,
		requestPath,
		workspaceReal
	};
	let candidateLstat;
	try {
		candidateLstat = await fs$1.lstat(candidatePath);
	} catch (err) {
		return resolveWorkspaceFilePathResultOrThrow({
			error: err,
			...notFoundContext,
			ioPath: candidatePath
		});
	}
	if (candidateLstat.isSymbolicLink()) {
		let targetReal;
		try {
			targetReal = await fs$1.realpath(candidatePath);
		} catch (err) {
			return resolveWorkspaceFilePathResultOrThrow({
				error: err,
				...notFoundContext,
				ioPath: candidatePath
			});
		}
		let targetStat;
		try {
			targetStat = await fs$1.stat(targetReal);
		} catch (err) {
			return resolveWorkspaceFilePathResultOrThrow({
				error: err,
				...notFoundContext,
				ioPath: targetReal
			});
		}
		if (!targetStat.isFile()) return {
			kind: "invalid",
			requestPath,
			reason: "path is not a regular file"
		};
		if (targetStat.nlink > 1) return {
			kind: "invalid",
			requestPath,
			reason: "hardlinked file path not allowed"
		};
		return {
			kind: "ready",
			requestPath,
			ioPath: targetReal,
			workspaceReal
		};
	}
	if (!candidateLstat.isFile()) return {
		kind: "invalid",
		requestPath,
		reason: "path is not a regular file"
	};
	if (candidateLstat.nlink > 1) return {
		kind: "invalid",
		requestPath,
		reason: "hardlinked file path not allowed"
	};
	return {
		kind: "ready",
		requestPath,
		ioPath: await fs$1.realpath(candidatePath).catch(() => candidatePath),
		workspaceReal
	};
}
async function statFileSafely(filePath) {
	try {
		const [stat, lstat] = await Promise.all([fs$1.stat(filePath), fs$1.lstat(filePath)]);
		if (lstat.isSymbolicLink() || !stat.isFile()) return null;
		if (stat.nlink > 1) return null;
		if (!sameFileIdentity(stat, lstat)) return null;
		return {
			size: stat.size,
			updatedAtMs: Math.floor(stat.mtimeMs)
		};
	} catch {
		return null;
	}
}
async function listAgentFiles(workspaceDir, options) {
	const files = [];
	const bootstrapFileNames = options?.hideBootstrap ? BOOTSTRAP_FILE_NAMES_POST_ONBOARDING : BOOTSTRAP_FILE_NAMES;
	for (const name of bootstrapFileNames) {
		const resolved = await resolveAgentWorkspaceFilePath({
			workspaceDir,
			name,
			allowMissing: true
		});
		const filePath = resolved.requestPath;
		const meta = resolved.kind === "ready" ? await statFileSafely(resolved.ioPath) : resolved.kind === "missing" ? null : null;
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
	const primaryResolved = await resolveAgentWorkspaceFilePath({
		workspaceDir,
		name: DEFAULT_MEMORY_FILENAME,
		allowMissing: true
	});
	const primaryMeta = primaryResolved.kind === "ready" ? await statFileSafely(primaryResolved.ioPath) : null;
	if (primaryMeta) files.push({
		name: DEFAULT_MEMORY_FILENAME,
		path: primaryResolved.requestPath,
		missing: false,
		size: primaryMeta.size,
		updatedAtMs: primaryMeta.updatedAtMs
	});
	else {
		const altMemoryResolved = await resolveAgentWorkspaceFilePath({
			workspaceDir,
			name: DEFAULT_MEMORY_ALT_FILENAME,
			allowMissing: true
		});
		const altMeta = altMemoryResolved.kind === "ready" ? await statFileSafely(altMemoryResolved.ioPath) : null;
		if (altMeta) files.push({
			name: DEFAULT_MEMORY_ALT_FILENAME,
			path: altMemoryResolved.requestPath,
			missing: false,
			size: altMeta.size,
			updatedAtMs: altMeta.updatedAtMs
		});
		else files.push({
			name: DEFAULT_MEMORY_FILENAME,
			path: primaryResolved.requestPath,
			missing: true
		});
	}
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
function isConfiguredAgent(cfg, agentId) {
	return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}
function respondAgentNotFound(respond, agentId) {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`));
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
function respondWorkspaceFileInvalid(respond, name, reason) {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unsafe workspace file "${name}" (${reason})`));
}
async function resolveWorkspaceFilePathOrRespond(params) {
	const resolvedPath = await resolveAgentWorkspaceFilePath({
		workspaceDir: params.workspaceDir,
		name: params.name,
		allowMissing: true
	});
	if (resolvedPath.kind === "invalid") {
		respondWorkspaceFileInvalid(params.respond, params.name, resolvedPath.reason);
		return;
	}
	return resolvedPath;
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
const agentsHandlers = {
	"agents.list": ({ params, respond }) => {
		if (!validateAgentsListParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agents.list params: ${formatValidationErrors(validateAgentsListParams.errors)}`));
			return;
		}
		respond(true, listAgentsForGateway(loadConfig()), void 0);
	},
	"agents.create": async ({ params, respond }) => {
		if (!validateAgentsCreateParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agents.create params: ${formatValidationErrors(validateAgentsCreateParams.errors)}`));
			return;
		}
		const cfg = loadConfig();
		const rawName = String(params.name ?? "").trim();
		const agentId = normalizeAgentId(rawName);
		if (agentId === "main") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" is reserved`));
			return;
		}
		if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" already exists`));
			return;
		}
		const workspaceDir = resolveUserPath(String(params.workspace ?? "").trim());
		let nextConfig = applyAgentConfig(cfg, {
			agentId,
			name: rawName,
			workspace: workspaceDir
		});
		const agentDir = resolveAgentDir(nextConfig, agentId);
		nextConfig = applyAgentConfig(nextConfig, {
			agentId,
			agentDir
		});
		await ensureAgentWorkspace({
			dir: workspaceDir,
			ensureBootstrapFiles: !Boolean(nextConfig.agents?.defaults?.skipBootstrap)
		});
		await fs$1.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });
		await writeConfigFile(nextConfig);
		const safeName = sanitizeIdentityLine(rawName);
		const emoji = resolveOptionalStringParam(params.emoji);
		const avatar = resolveOptionalStringParam(params.avatar);
		const identityPath = path.join(workspaceDir, DEFAULT_IDENTITY_FILENAME);
		const lines = [
			"",
			`- Name: ${safeName}`,
			...emoji ? [`- Emoji: ${sanitizeIdentityLine(emoji)}`] : [],
			...avatar ? [`- Avatar: ${sanitizeIdentityLine(avatar)}`] : [],
			""
		];
		await fs$1.appendFile(identityPath, lines.join("\n"), "utf-8");
		respond(true, {
			ok: true,
			agentId,
			name: rawName,
			workspace: workspaceDir
		}, void 0);
	},
	"agents.update": async ({ params, respond }) => {
		if (!validateAgentsUpdateParams(params)) {
			respondInvalidMethodParams(respond, "agents.update", validateAgentsUpdateParams.errors);
			return;
		}
		const cfg = loadConfig();
		const agentId = normalizeAgentId(String(params.agentId ?? ""));
		if (!isConfiguredAgent(cfg, agentId)) {
			respondAgentNotFound(respond, agentId);
			return;
		}
		const workspaceDir = typeof params.workspace === "string" && params.workspace.trim() ? resolveUserPath(params.workspace.trim()) : void 0;
		const model = resolveOptionalStringParam(params.model);
		const avatar = resolveOptionalStringParam(params.avatar);
		const nextConfig = applyAgentConfig(cfg, {
			agentId,
			...typeof params.name === "string" && params.name.trim() ? { name: params.name.trim() } : {},
			...workspaceDir ? { workspace: workspaceDir } : {},
			...model ? { model } : {}
		});
		await writeConfigFile(nextConfig);
		if (workspaceDir) await ensureAgentWorkspace({
			dir: workspaceDir,
			ensureBootstrapFiles: !Boolean(nextConfig.agents?.defaults?.skipBootstrap)
		});
		if (avatar) {
			const workspace = workspaceDir ?? resolveAgentWorkspaceDir(nextConfig, agentId);
			await fs$1.mkdir(workspace, { recursive: true });
			const identityPath = path.join(workspace, DEFAULT_IDENTITY_FILENAME);
			await fs$1.appendFile(identityPath, `\n- Avatar: ${sanitizeIdentityLine(avatar)}\n`, "utf-8");
		}
		respond(true, {
			ok: true,
			agentId
		}, void 0);
	},
	"agents.delete": async ({ params, respond }) => {
		if (!validateAgentsDeleteParams(params)) {
			respondInvalidMethodParams(respond, "agents.delete", validateAgentsDeleteParams.errors);
			return;
		}
		const cfg = loadConfig();
		const agentId = normalizeAgentId(String(params.agentId ?? ""));
		if (agentId === "main") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" cannot be deleted`));
			return;
		}
		if (!isConfiguredAgent(cfg, agentId)) {
			respondAgentNotFound(respond, agentId);
			return;
		}
		const deleteFiles = typeof params.deleteFiles === "boolean" ? params.deleteFiles : true;
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		const agentDir = resolveAgentDir(cfg, agentId);
		const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
		const result = pruneAgentConfig(cfg, agentId);
		await writeConfigFile(result.config);
		if (deleteFiles) await Promise.all([
			moveToTrashBestEffort(workspaceDir),
			moveToTrashBestEffort(agentDir),
			moveToTrashBestEffort(sessionsDir)
		]);
		respond(true, {
			ok: true,
			agentId,
			removedBindings: result.removedBindings
		}, void 0);
	},
	"agents.files.list": async ({ params, respond }) => {
		if (!validateAgentsFilesListParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agents.files.list params: ${formatValidationErrors(validateAgentsFilesListParams.errors)}`));
			return;
		}
		const cfg = loadConfig();
		const agentId = resolveAgentIdOrError(String(params.agentId ?? ""), cfg);
		if (!agentId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
			return;
		}
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		let hideBootstrap = false;
		try {
			hideBootstrap = await isWorkspaceSetupCompleted(workspaceDir);
		} catch {}
		respond(true, {
			agentId,
			workspace: workspaceDir,
			files: await listAgentFiles(workspaceDir, { hideBootstrap })
		}, void 0);
	},
	"agents.files.get": async ({ params, respond }) => {
		if (!validateAgentsFilesGetParams(params)) {
			respondInvalidMethodParams(respond, "agents.files.get", validateAgentsFilesGetParams.errors);
			return;
		}
		const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond);
		if (!resolved) return;
		const { agentId, workspaceDir, name } = resolved;
		const filePath = path.join(workspaceDir, name);
		const resolvedPath = await resolveWorkspaceFilePathOrRespond({
			respond,
			workspaceDir,
			name
		});
		if (!resolvedPath) return;
		if (resolvedPath.kind === "missing") {
			respondWorkspaceFileMissing({
				respond,
				agentId,
				workspaceDir,
				name,
				filePath
			});
			return;
		}
		let safeRead;
		try {
			safeRead = await readLocalFileSafely({ filePath: resolvedPath.ioPath });
		} catch (err) {
			if (err instanceof SafeOpenError && err.code === "not-found") {
				respondWorkspaceFileMissing({
					respond,
					agentId,
					workspaceDir,
					name,
					filePath
				});
				return;
			}
			respondWorkspaceFileUnsafe(respond, name);
			return;
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
	"agents.files.set": async ({ params, respond }) => {
		if (!validateAgentsFilesSetParams(params)) {
			respondInvalidMethodParams(respond, "agents.files.set", validateAgentsFilesSetParams.errors);
			return;
		}
		const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond);
		if (!resolved) return;
		const { agentId, workspaceDir, name } = resolved;
		await fs$1.mkdir(workspaceDir, { recursive: true });
		const filePath = path.join(workspaceDir, name);
		const resolvedPath = await resolveWorkspaceFilePathOrRespond({
			respond,
			workspaceDir,
			name
		});
		if (!resolvedPath) return;
		const content = String(params.content ?? "");
		const relativeWritePath = path.relative(resolvedPath.workspaceReal, resolvedPath.ioPath);
		if (!relativeWritePath || relativeWritePath.startsWith("..") || path.isAbsolute(relativeWritePath)) {
			respondWorkspaceFileUnsafe(respond, name);
			return;
		}
		try {
			await writeFileWithinRoot({
				rootDir: resolvedPath.workspaceReal,
				relativePath: relativeWritePath,
				data: content,
				encoding: "utf8"
			});
		} catch {
			respondWorkspaceFileUnsafe(respond, name);
			return;
		}
		const meta = await statFileSafely(resolvedPath.ioPath);
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
//#region src/gateway/server-methods/nodes.helpers.ts
function respondInvalidParams(params) {
	params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${params.method} params: ${formatValidationErrors(params.validator.errors)}`));
}
async function respondUnavailableOnThrow(respond, fn) {
	try {
		await fn();
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
	}
}
function uniqueSortedStrings(values) {
	return [...new Set(values.filter((v) => typeof v === "string"))].map((v) => v.trim()).filter(Boolean).toSorted();
}
function safeParseJson(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed) return;
	try {
		return JSON.parse(trimmed);
	} catch {
		return { payloadJSON: value };
	}
}
function respondUnavailableOnNodeInvokeError(respond, res) {
	if (res.ok) return true;
	const nodeError = res.error && typeof res.error === "object" ? res.error : null;
	const nodeCode = typeof nodeError?.code === "string" ? nodeError.code.trim() : "";
	const nodeMessage = typeof nodeError?.message === "string" && nodeError.message.trim().length > 0 ? nodeError.message.trim() : "node invoke failed";
	const message = nodeCode ? `${nodeCode}: ${nodeMessage}` : nodeMessage;
	respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, message, { details: { nodeError: res.error ?? null } }));
	return false;
}
//#endregion
//#region src/gateway/server-methods/browser.ts
function normalizeBrowserRequestPath(value) {
	const trimmed = value.trim();
	if (!trimmed) return trimmed;
	const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	if (withLeadingSlash.length <= 1) return withLeadingSlash;
	return withLeadingSlash.replace(/\/+$/, "");
}
function isPersistentBrowserProfileMutation(method, path) {
	const normalizedPath = normalizeBrowserRequestPath(path);
	if (method === "POST" && normalizedPath === "/profiles/create") return true;
	return method === "DELETE" && /^\/profiles\/[^/]+$/.test(normalizedPath);
}
function resolveRequestedProfile(params) {
	const queryProfile = typeof params.query?.profile === "string" ? params.query.profile.trim() : void 0;
	if (queryProfile) return queryProfile;
	if (!params.body || typeof params.body !== "object") return;
	return ("profile" in params.body && typeof params.body.profile === "string" ? params.body.profile.trim() : void 0) || void 0;
}
function isBrowserNode(node) {
	const caps = Array.isArray(node.caps) ? node.caps : [];
	const commands = Array.isArray(node.commands) ? node.commands : [];
	return caps.includes("browser") || commands.includes("browser.proxy");
}
function normalizeNodeKey(value) {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function resolveBrowserNode(nodes, query) {
	const q = query.trim();
	if (!q) return null;
	const qNorm = normalizeNodeKey(q);
	const matches = nodes.filter((node) => {
		if (node.nodeId === q) return true;
		if (typeof node.remoteIp === "string" && node.remoteIp === q) return true;
		const name = typeof node.displayName === "string" ? node.displayName : "";
		if (name && normalizeNodeKey(name) === qNorm) return true;
		if (q.length >= 6 && node.nodeId.startsWith(q)) return true;
		return false;
	});
	if (matches.length === 1) return matches[0] ?? null;
	if (matches.length === 0) return null;
	throw new Error(`ambiguous node: ${q} (matches: ${matches.map((node) => node.displayName || node.remoteIp || node.nodeId).join(", ")})`);
}
function resolveBrowserNodeTarget(params) {
	const policy = params.cfg.gateway?.nodes?.browser;
	const mode = policy?.mode ?? "auto";
	if (mode === "off") return null;
	const browserNodes = params.nodes.filter((node) => isBrowserNode(node));
	if (browserNodes.length === 0) {
		if (policy?.node?.trim()) throw new Error("No connected browser-capable nodes.");
		return null;
	}
	const requested = policy?.node?.trim() || "";
	if (requested) {
		const resolved = resolveBrowserNode(browserNodes, requested);
		if (!resolved) throw new Error(`Configured browser node not connected: ${requested}`);
		return resolved;
	}
	if (mode === "manual") return null;
	if (browserNodes.length === 1) return browserNodes[0] ?? null;
	return null;
}
async function persistProxyFiles(files) {
	return await persistBrowserProxyFiles(files);
}
function applyProxyPaths(result, mapping) {
	applyBrowserProxyPaths(result, mapping);
}
const browserHandlers = { "browser.request": async ({ params, respond, context }) => {
	const typed = params;
	const methodRaw = typeof typed.method === "string" ? typed.method.trim().toUpperCase() : "";
	const path = typeof typed.path === "string" ? typed.path.trim() : "";
	const query = typed.query && typeof typed.query === "object" ? typed.query : void 0;
	const body = typed.body;
	const timeoutMs = typeof typed.timeoutMs === "number" && Number.isFinite(typed.timeoutMs) ? Math.max(1, Math.floor(typed.timeoutMs)) : void 0;
	if (!methodRaw || !path) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "method and path are required"));
		return;
	}
	if (methodRaw !== "GET" && methodRaw !== "POST" && methodRaw !== "DELETE") {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "method must be GET, POST, or DELETE"));
		return;
	}
	if (isPersistentBrowserProfileMutation(methodRaw, path)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "browser.request cannot create or delete persistent browser profiles"));
		return;
	}
	const cfg = loadConfig();
	let nodeTarget = null;
	try {
		nodeTarget = resolveBrowserNodeTarget({
			cfg,
			nodes: context.nodeRegistry.listConnected()
		});
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
		return;
	}
	if (nodeTarget) {
		const allowlist = resolveNodeCommandAllowlist(cfg, nodeTarget);
		const allowed = isNodeCommandAllowed({
			command: "browser.proxy",
			declaredCommands: nodeTarget.commands,
			allowlist
		});
		if (!allowed.ok) {
			const platform = nodeTarget.platform ?? "unknown";
			const hint = `node command not allowed: ${allowed.reason} (platform: ${platform}, command: browser.proxy)`;
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, hint, { details: {
				reason: allowed.reason,
				command: "browser.proxy"
			} }));
			return;
		}
		const proxyParams = {
			method: methodRaw,
			path,
			query,
			body,
			timeoutMs,
			profile: resolveRequestedProfile({
				query,
				body
			})
		};
		const res = await context.nodeRegistry.invoke({
			nodeId: nodeTarget.nodeId,
			command: "browser.proxy",
			params: proxyParams,
			timeoutMs,
			idempotencyKey: crypto.randomUUID()
		});
		if (!respondUnavailableOnNodeInvokeError(respond, res)) return;
		const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
		const proxy = payload && typeof payload === "object" ? payload : null;
		if (!proxy || !("result" in proxy)) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "browser proxy failed"));
			return;
		}
		const mapping = await persistProxyFiles(proxy.files);
		applyProxyPaths(proxy.result, mapping);
		respond(true, proxy.result);
		return;
	}
	if (!await startBrowserControlServiceFromConfig()) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "browser control is disabled"));
		return;
	}
	let dispatcher;
	try {
		dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
		return;
	}
	const result = await dispatcher.dispatch({
		method: methodRaw,
		path,
		query,
		body
	});
	if (result.status >= 400) {
		const message = result.body && typeof result.body === "object" && "error" in result.body ? String(result.body.error) : `browser request failed (${result.status})`;
		respond(false, void 0, errorShape(result.status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST, message, { details: result.body }));
		return;
	}
	respond(true, result.body);
} };
//#endregion
//#region src/gateway/server-methods/channels.ts
init_session_key();
init_runtime();
async function logoutChannelAccount(params) {
	const resolvedAccountId = params.accountId?.trim() || params.plugin.config.defaultAccountId?.(params.cfg) || params.plugin.config.listAccountIds(params.cfg)[0] || "default";
	const account = params.plugin.config.resolveAccount(params.cfg, resolvedAccountId);
	await params.context.stopChannel(params.channelId, resolvedAccountId);
	const result = await params.plugin.gateway?.logoutAccount?.({
		cfg: params.cfg,
		accountId: resolvedAccountId,
		account,
		runtime: defaultRuntime
	});
	if (!result) throw new Error(`Channel ${params.channelId} does not support logout`);
	const cleared = Boolean(result.cleared);
	if (typeof result.loggedOut === "boolean" ? result.loggedOut : cleared) params.context.markChannelLoggedOut(params.channelId, true, resolvedAccountId);
	return {
		channel: params.channelId,
		accountId: resolvedAccountId,
		...result,
		cleared
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
		const timeoutMs = typeof timeoutMsRaw === "number" ? Math.max(1e3, timeoutMsRaw) : 1e4;
		const cfg = loadConfig();
		const runtime = context.getRuntimeSnapshot();
		const plugins = listChannelPlugins();
		const pluginMap = new Map(plugins.map((plugin) => [plugin.id, plugin]));
		const resolveRuntimeSnapshot = (channelId, accountId, defaultAccountId) => {
			const accounts = runtime.channelAccounts[channelId];
			const defaultRuntime = runtime.channels[channelId];
			const raw = accounts?.[accountId] ?? (accountId === defaultAccountId ? defaultRuntime : void 0);
			if (!raw) return;
			return raw;
		};
		const isAccountEnabled = (plugin, account) => plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : !account || typeof account !== "object" || account.enabled !== false;
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
			const accounts = [];
			const resolvedAccounts = {};
			for (const accountId of accountIds) {
				const account = plugin.config.resolveAccount(cfg, accountId);
				const enabled = isAccountEnabled(plugin, account);
				resolvedAccounts[accountId] = account;
				let probeResult;
				let lastProbeAt = null;
				if (probe && enabled && plugin.status?.probeAccount) {
					let configured = true;
					if (plugin.config.isConfigured) configured = await plugin.config.isConfigured(account, cfg);
					if (configured) {
						probeResult = await plugin.status.probeAccount({
							account,
							timeoutMs,
							cfg
						});
						lastProbeAt = Date.now();
					}
				}
				let auditResult;
				if (probe && enabled && plugin.status?.auditAccount) {
					let configured = true;
					if (plugin.config.isConfigured) configured = await plugin.config.isConfigured(account, cfg);
					if (configured) auditResult = await plugin.status.auditAccount({
						account,
						timeoutMs,
						cfg,
						probe: probeResult
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
				if (lastProbeAt) snapshot.lastProbeAt = lastProbeAt;
				const activity = getChannelActivity({
					channel: channelId,
					accountId
				});
				if (snapshot.lastInboundAt == null) snapshot.lastInboundAt = activity.inboundAt;
				if (snapshot.lastOutboundAt == null) snapshot.lastOutboundAt = activity.outboundAt;
				accounts.push(snapshot);
			}
			return {
				accounts,
				defaultAccountId,
				defaultAccount: accounts.find((entry) => entry.accountId === defaultAccountId) ?? accounts[0],
				resolvedAccounts
			};
		};
		const uiCatalog = buildChannelUiCatalog(plugins);
		const payload = {
			ts: Date.now(),
			channelOrder: uiCatalog.order,
			channelLabels: uiCatalog.labels,
			channelDetailLabels: uiCatalog.detailLabels,
			channelSystemImages: uiCatalog.systemImages,
			channelMeta: uiCatalog.entries,
			channels: {},
			channelAccounts: {},
			channelDefaultAccountId: {}
		};
		const channelsMap = payload.channels;
		const accountsMap = payload.channelAccounts;
		const defaultAccountIdMap = payload.channelDefaultAccountId;
		for (const plugin of plugins) {
			const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } = await buildChannelAccounts(plugin.id);
			const fallbackAccount = resolvedAccounts[defaultAccountId] ?? plugin.config.resolveAccount(cfg, defaultAccountId);
			const summary = plugin.status?.buildChannelSummary ? await plugin.status.buildChannelSummary({
				account: fallbackAccount,
				cfg,
				defaultAccountId,
				snapshot: defaultAccount ?? { accountId: defaultAccountId }
			}) : { configured: defaultAccount?.configured ?? false };
			channelsMap[plugin.id] = summary;
			accountsMap[plugin.id] = accounts;
			defaultAccountIdMap[plugin.id] = defaultAccountId;
		}
		respond(true, payload, void 0);
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
		const accountId = typeof accountIdRaw === "string" ? accountIdRaw.trim() : void 0;
		const snapshot = await readConfigFileSnapshot();
		if (!snapshot.valid) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"));
			return;
		}
		try {
			respond(true, await logoutChannelAccount({
				channelId,
				accountId,
				cfg: snapshot.config ?? {},
				context,
				plugin
			}), void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	}
};
//#endregion
//#region src/gateway/server-methods/chat-transcript-inject.ts
function appendInjectedAssistantMessageToTranscript(params) {
	const now = params.now ?? Date.now();
	const messageBody = {
		role: "assistant",
		content: [{
			type: "text",
			text: `${params.label ? `[${params.label}]\n\n` : ""}${params.message}`
		}],
		timestamp: now,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0
			}
		},
		api: "openai-responses",
		provider: "openclaw",
		model: "gateway-injected",
		...params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {},
		...params.abortMeta ? { openclawAbort: {
			aborted: true,
			origin: params.abortMeta.origin,
			runId: params.abortMeta.runId
		} } : {}
	};
	try {
		return {
			ok: true,
			messageId: SessionManager.open(params.transcriptPath).appendMessage(messageBody),
			message: messageBody
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
//#endregion
//#region src/gateway/server-methods/chat.ts
init_session_key_utils();
const CHAT_HISTORY_TEXT_MAX_CHARS = 12e3;
const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
let chatHistoryPlaceholderEmitCount = 0;
const CHANNEL_AGNOSTIC_SESSION_SCOPES = new Set([
	"main",
	"direct",
	"dm",
	"group",
	"channel",
	"cron",
	"run",
	"subagent",
	"acp",
	"thread",
	"topic"
]);
const CHANNEL_SCOPED_SESSION_SHAPES = new Set([
	"direct",
	"dm",
	"group",
	"channel"
]);
function resolveChatSendOriginatingRoute(params) {
	if (!(params.deliver === true)) return {
		originatingChannel: INTERNAL_MESSAGE_CHANNEL,
		explicitDeliverRoute: false
	};
	const routeChannelCandidate = normalizeMessageChannel(params.entry?.deliveryContext?.channel ?? params.entry?.lastChannel);
	const routeToCandidate = params.entry?.deliveryContext?.to ?? params.entry?.lastTo;
	const routeAccountIdCandidate = params.entry?.deliveryContext?.accountId ?? params.entry?.lastAccountId ?? void 0;
	const routeThreadIdCandidate = params.entry?.deliveryContext?.threadId ?? params.entry?.lastThreadId;
	if (params.sessionKey.length > 512) return {
		originatingChannel: INTERNAL_MESSAGE_CHANNEL,
		explicitDeliverRoute: false
	};
	const sessionScopeParts = (parseAgentSessionKey(params.sessionKey)?.rest ?? params.sessionKey).split(":", 3).filter(Boolean);
	const sessionScopeHead = sessionScopeParts[0];
	const sessionChannelHint = normalizeMessageChannel(sessionScopeHead);
	const normalizedSessionScopeHead = (sessionScopeHead ?? "").trim().toLowerCase();
	const sessionPeerShapeCandidates = [sessionScopeParts[1], sessionScopeParts[2]].map((part) => (part ?? "").trim().toLowerCase()).filter(Boolean);
	const isChannelAgnosticSessionScope = CHANNEL_AGNOSTIC_SESSION_SCOPES.has(normalizedSessionScopeHead);
	const isChannelScopedSession = sessionPeerShapeCandidates.some((part) => CHANNEL_SCOPED_SESSION_SHAPES.has(part));
	const hasLegacyChannelPeerShape = !isChannelScopedSession && typeof sessionScopeParts[1] === "string" && sessionChannelHint === routeChannelCandidate;
	const isFromWebchatClient = isWebchatClient(params.client);
	const isFromGatewayCliClient = isGatewayCliClient(params.client);
	const hasClientMetadata = typeof params.client?.mode === "string" && params.client.mode.trim().length > 0 || typeof params.client?.id === "string" && params.client.id.trim().length > 0;
	const configuredMainKey = (params.mainKey ?? "main").trim().toLowerCase();
	const canInheritConfiguredMainRoute = normalizedSessionScopeHead.length > 0 && normalizedSessionScopeHead === configuredMainKey && params.hasConnectedClient && (isFromGatewayCliClient || !hasClientMetadata);
	if (!(Boolean(!isFromWebchatClient && sessionChannelHint && sessionChannelHint !== "webchat" && (!isChannelAgnosticSessionScope && (isChannelScopedSession || hasLegacyChannelPeerShape) || canInheritConfiguredMainRoute)) && routeChannelCandidate && routeChannelCandidate !== "webchat" && typeof routeToCandidate === "string" && routeToCandidate.trim().length > 0)) return {
		originatingChannel: INTERNAL_MESSAGE_CHANNEL,
		explicitDeliverRoute: false
	};
	return {
		originatingChannel: routeChannelCandidate,
		originatingTo: routeToCandidate,
		accountId: routeAccountIdCandidate,
		messageThreadId: routeThreadIdCandidate,
		explicitDeliverRoute: true
	};
}
function stripDisallowedChatControlChars(message) {
	let output = "";
	for (const char of message) {
		const code = char.charCodeAt(0);
		if (code === 9 || code === 10 || code === 13 || code >= 32 && code !== 127) output += char;
	}
	return output;
}
function sanitizeChatSendMessageInput(message) {
	const normalized = message.normalize("NFC");
	if (normalized.includes("\0")) return {
		ok: false,
		error: "message must not contain null bytes"
	};
	return {
		ok: true,
		message: stripDisallowedChatControlChars(normalized)
	};
}
function normalizeOptionalChatSystemReceipt(value) {
	if (value == null) return { ok: true };
	if (typeof value !== "string") return {
		ok: false,
		error: "systemProvenanceReceipt must be a string"
	};
	const sanitized = sanitizeChatSendMessageInput(value);
	if (!sanitized.ok) return sanitized;
	return {
		ok: true,
		receipt: sanitized.message.trim() || void 0
	};
}
function isAcpBridgeClient(client) {
	const info = client?.connect?.client;
	return info?.id === GATEWAY_CLIENT_NAMES.CLI && info?.mode === GATEWAY_CLIENT_MODES.CLI && info?.displayName === "ACP" && info?.version === "acp";
}
function truncateChatHistoryText(text) {
	if (text.length <= CHAT_HISTORY_TEXT_MAX_CHARS) return {
		text,
		truncated: false
	};
	return {
		text: `${text.slice(0, CHAT_HISTORY_TEXT_MAX_CHARS)}\n...(truncated)...`,
		truncated: true
	};
}
function sanitizeChatHistoryContentBlock(block) {
	if (!block || typeof block !== "object") return {
		block,
		changed: false
	};
	const entry = { ...block };
	let changed = false;
	if (typeof entry.text === "string") {
		const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
		const res = truncateChatHistoryText(stripped.text);
		entry.text = res.text;
		changed ||= stripped.changed || res.truncated;
	}
	if (typeof entry.partialJson === "string") {
		const res = truncateChatHistoryText(entry.partialJson);
		entry.partialJson = res.text;
		changed ||= res.truncated;
	}
	if (typeof entry.arguments === "string") {
		const res = truncateChatHistoryText(entry.arguments);
		entry.arguments = res.text;
		changed ||= res.truncated;
	}
	if (typeof entry.thinking === "string") {
		const res = truncateChatHistoryText(entry.thinking);
		entry.thinking = res.text;
		changed ||= res.truncated;
	}
	if ("thinkingSignature" in entry) {
		delete entry.thinkingSignature;
		changed = true;
	}
	if ((typeof entry.type === "string" ? entry.type : "") === "image" && typeof entry.data === "string") {
		const bytes = Buffer.byteLength(entry.data, "utf8");
		delete entry.data;
		entry.omitted = true;
		entry.bytes = bytes;
		changed = true;
	}
	return {
		block: changed ? entry : block,
		changed
	};
}
/**
* Validate that a value is a finite number, returning undefined otherwise.
*/
function toFiniteNumber(x) {
	return typeof x === "number" && Number.isFinite(x) ? x : void 0;
}
/**
* Sanitize usage metadata to ensure only finite numeric fields are included.
* Prevents UI crashes from malformed transcript JSON.
*/
function sanitizeUsage(raw) {
	if (!raw || typeof raw !== "object") return;
	const u = raw;
	const out = {};
	for (const k of [
		"input",
		"output",
		"totalTokens",
		"inputTokens",
		"outputTokens",
		"cacheRead",
		"cacheWrite",
		"cache_read_input_tokens",
		"cache_creation_input_tokens"
	]) {
		const n = toFiniteNumber(u[k]);
		if (n !== void 0) out[k] = n;
	}
	if ("cost" in u && u.cost != null && typeof u.cost === "object") {
		const sanitizedCost = sanitizeCost(u.cost);
		if (sanitizedCost) out.cost = sanitizedCost;
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
/**
* Sanitize cost metadata to ensure only finite numeric fields are included.
* Prevents UI crashes from calling .toFixed() on non-numbers.
*/
function sanitizeCost(raw) {
	if (!raw || typeof raw !== "object") return;
	const total = toFiniteNumber(raw.total);
	return total !== void 0 ? { total } : void 0;
}
function sanitizeChatHistoryMessage(message) {
	if (!message || typeof message !== "object") return {
		message,
		changed: false
	};
	const entry = { ...message };
	let changed = false;
	if ("details" in entry) {
		delete entry.details;
		changed = true;
	}
	if (entry.role !== "assistant") {
		if ("usage" in entry) {
			delete entry.usage;
			changed = true;
		}
		if ("cost" in entry) {
			delete entry.cost;
			changed = true;
		}
	} else {
		if ("usage" in entry) {
			const sanitized = sanitizeUsage(entry.usage);
			if (sanitized) entry.usage = sanitized;
			else delete entry.usage;
			changed = true;
		}
		if ("cost" in entry) {
			const sanitized = sanitizeCost(entry.cost);
			if (sanitized) entry.cost = sanitized;
			else delete entry.cost;
			changed = true;
		}
	}
	if (typeof entry.content === "string") {
		const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
		const res = truncateChatHistoryText(stripped.text);
		entry.content = res.text;
		changed ||= stripped.changed || res.truncated;
	} else if (Array.isArray(entry.content)) {
		const updated = entry.content.map((block) => sanitizeChatHistoryContentBlock(block));
		if (updated.some((item) => item.changed)) {
			entry.content = updated.map((item) => item.block);
			changed = true;
		}
	}
	if (typeof entry.text === "string") {
		const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
		const res = truncateChatHistoryText(stripped.text);
		entry.text = res.text;
		changed ||= stripped.changed || res.truncated;
	}
	return {
		message: changed ? entry : message,
		changed
	};
}
/**
* Extract the visible text from an assistant history message for silent-token checks.
* Returns `undefined` for non-assistant messages or messages with no extractable text.
* When `entry.text` is present it takes precedence over `entry.content` to avoid
* dropping messages that carry real text alongside a stale `content: "NO_REPLY"`.
*/
function extractAssistantTextForSilentCheck(message) {
	if (!message || typeof message !== "object") return;
	const entry = message;
	if (entry.role !== "assistant") return;
	if (typeof entry.text === "string") return entry.text;
	if (typeof entry.content === "string") return entry.content;
	if (!Array.isArray(entry.content) || entry.content.length === 0) return;
	const texts = [];
	for (const block of entry.content) {
		if (!block || typeof block !== "object") return;
		const typed = block;
		if (typed.type !== "text" || typeof typed.text !== "string") return;
		texts.push(typed.text);
	}
	return texts.length > 0 ? texts.join("\n") : void 0;
}
function sanitizeChatHistoryMessages(messages) {
	if (messages.length === 0) return messages;
	let changed = false;
	const next = [];
	for (const message of messages) {
		const res = sanitizeChatHistoryMessage(message);
		changed ||= res.changed;
		const text = extractAssistantTextForSilentCheck(res.message);
		if (text !== void 0 && isSilentReplyText(text, "NO_REPLY")) {
			changed = true;
			continue;
		}
		next.push(res.message);
	}
	return changed ? next : messages;
}
function buildOversizedHistoryPlaceholder(message) {
	return {
		role: message && typeof message === "object" && typeof message.role === "string" ? message.role : "assistant",
		timestamp: message && typeof message === "object" && typeof message.timestamp === "number" ? message.timestamp : Date.now(),
		content: [{
			type: "text",
			text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER
		}],
		__openclaw: {
			truncated: true,
			reason: "oversized"
		}
	};
}
function replaceOversizedChatHistoryMessages(params) {
	const { messages, maxSingleMessageBytes } = params;
	if (messages.length === 0) return {
		messages,
		replacedCount: 0
	};
	let replacedCount = 0;
	const next = messages.map((message) => {
		if (jsonUtf8Bytes(message) <= maxSingleMessageBytes) return message;
		replacedCount += 1;
		return buildOversizedHistoryPlaceholder(message);
	});
	return {
		messages: replacedCount > 0 ? next : messages,
		replacedCount
	};
}
function enforceChatHistoryFinalBudget(params) {
	const { messages, maxBytes } = params;
	if (messages.length === 0) return {
		messages,
		placeholderCount: 0
	};
	if (jsonUtf8Bytes(messages) <= maxBytes) return {
		messages,
		placeholderCount: 0
	};
	const last = messages.at(-1);
	if (last && jsonUtf8Bytes([last]) <= maxBytes) return {
		messages: [last],
		placeholderCount: 0
	};
	const placeholder = buildOversizedHistoryPlaceholder(last);
	if (jsonUtf8Bytes([placeholder]) <= maxBytes) return {
		messages: [placeholder],
		placeholderCount: 1
	};
	return {
		messages: [],
		placeholderCount: 0
	};
}
function resolveTranscriptPath(params) {
	const { sessionId, storePath, sessionFile, agentId } = params;
	if (!storePath && !sessionFile) return null;
	try {
		const sessionsDir = storePath ? path.dirname(storePath) : void 0;
		return resolveSessionFilePath(sessionId, sessionFile ? { sessionFile } : void 0, sessionsDir || agentId ? {
			sessionsDir,
			agentId
		} : void 0);
	} catch {
		return null;
	}
}
function ensureTranscriptFile(params) {
	if (fs.existsSync(params.transcriptPath)) return { ok: true };
	try {
		fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: params.sessionId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			cwd: process.cwd()
		};
		fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, {
			encoding: "utf-8",
			mode: 384
		});
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
function transcriptHasIdempotencyKey(transcriptPath, idempotencyKey) {
	try {
		const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
		for (const line of lines) {
			if (!line.trim()) continue;
			if (JSON.parse(line)?.message?.idempotencyKey === idempotencyKey) return true;
		}
		return false;
	} catch {
		return false;
	}
}
function appendAssistantTranscriptMessage(params) {
	const transcriptPath = resolveTranscriptPath({
		sessionId: params.sessionId,
		storePath: params.storePath,
		sessionFile: params.sessionFile,
		agentId: params.agentId
	});
	if (!transcriptPath) return {
		ok: false,
		error: "transcript path not resolved"
	};
	if (!fs.existsSync(transcriptPath)) {
		if (!params.createIfMissing) return {
			ok: false,
			error: "transcript file not found"
		};
		const ensured = ensureTranscriptFile({
			transcriptPath,
			sessionId: params.sessionId
		});
		if (!ensured.ok) return {
			ok: false,
			error: ensured.error ?? "failed to create transcript file"
		};
	}
	if (params.idempotencyKey && transcriptHasIdempotencyKey(transcriptPath, params.idempotencyKey)) return { ok: true };
	return appendInjectedAssistantMessageToTranscript({
		transcriptPath,
		message: params.message,
		label: params.label,
		idempotencyKey: params.idempotencyKey,
		abortMeta: params.abortMeta
	});
}
function collectSessionAbortPartials(params) {
	const out = [];
	for (const [runId, active] of params.chatAbortControllers) {
		if (!params.runIds.has(runId)) continue;
		const text = params.chatRunBuffers.get(runId);
		if (!text || !text.trim()) continue;
		out.push({
			runId,
			sessionId: active.sessionId,
			text,
			abortOrigin: params.abortOrigin
		});
	}
	return out;
}
function persistAbortedPartials(params) {
	if (params.snapshots.length === 0) return;
	const { storePath, entry } = loadSessionEntry(params.sessionKey);
	for (const snapshot of params.snapshots) {
		const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
		const appended = appendAssistantTranscriptMessage({
			message: snapshot.text,
			sessionId,
			storePath,
			sessionFile: entry?.sessionFile,
			createIfMissing: true,
			idempotencyKey: `${snapshot.runId}:assistant`,
			abortMeta: {
				aborted: true,
				origin: snapshot.abortOrigin,
				runId: snapshot.runId
			}
		});
		if (!appended.ok) params.context.logGateway.warn(`chat.abort transcript append failed: ${appended.error ?? "unknown error"}`);
	}
}
function createChatAbortOps(context) {
	return {
		chatAbortControllers: context.chatAbortControllers,
		chatRunBuffers: context.chatRunBuffers,
		chatDeltaSentAt: context.chatDeltaSentAt,
		chatAbortedRuns: context.chatAbortedRuns,
		removeChatRun: context.removeChatRun,
		agentRunSeq: context.agentRunSeq,
		broadcast: context.broadcast,
		nodeSendToSession: context.nodeSendToSession
	};
}
function normalizeOptionalText(value) {
	return value?.trim() || void 0;
}
function resolveChatAbortRequester(client) {
	const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
	return {
		connId: normalizeOptionalText(client?.connId),
		deviceId: normalizeOptionalText(client?.connect?.device?.id),
		isAdmin: scopes.includes(ADMIN_SCOPE$3)
	};
}
function canRequesterAbortChatRun(entry, requester) {
	if (requester.isAdmin) return true;
	const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
	const ownerConnId = normalizeOptionalText(entry.ownerConnId);
	if (!ownerDeviceId && !ownerConnId) return true;
	if (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) return true;
	if (ownerConnId && requester.connId && ownerConnId === requester.connId) return true;
	return false;
}
function resolveAuthorizedRunIdsForSession(params) {
	const authorizedRunIds = [];
	let matchedSessionRuns = 0;
	for (const [runId, active] of params.chatAbortControllers) {
		if (active.sessionKey !== params.sessionKey) continue;
		matchedSessionRuns += 1;
		if (canRequesterAbortChatRun(active, params.requester)) authorizedRunIds.push(runId);
	}
	return {
		matchedSessionRuns,
		authorizedRunIds
	};
}
function abortChatRunsForSessionKeyWithPartials(params) {
	const { matchedSessionRuns, authorizedRunIds } = resolveAuthorizedRunIdsForSession({
		chatAbortControllers: params.context.chatAbortControllers,
		sessionKey: params.sessionKey,
		requester: params.requester
	});
	if (authorizedRunIds.length === 0) return {
		aborted: false,
		runIds: [],
		unauthorized: matchedSessionRuns > 0
	};
	const authorizedRunIdSet = new Set(authorizedRunIds);
	const snapshots = collectSessionAbortPartials({
		chatAbortControllers: params.context.chatAbortControllers,
		chatRunBuffers: params.context.chatRunBuffers,
		runIds: authorizedRunIdSet,
		abortOrigin: params.abortOrigin
	});
	const runIds = [];
	for (const runId of authorizedRunIds) if (abortChatRunById(params.ops, {
		runId,
		sessionKey: params.sessionKey,
		stopReason: params.stopReason
	}).aborted) runIds.push(runId);
	const res = {
		aborted: runIds.length > 0,
		runIds,
		unauthorized: false
	};
	if (res.aborted) persistAbortedPartials({
		context: params.context,
		sessionKey: params.sessionKey,
		snapshots
	});
	return res;
}
function nextChatSeq(context, runId) {
	const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
	context.agentRunSeq.set(runId, next);
	return next;
}
function broadcastChatFinal(params) {
	const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
	const strippedEnvelopeMessage = stripEnvelopeFromMessage(params.message);
	const payload = {
		runId: params.runId,
		sessionKey: params.sessionKey,
		seq,
		state: "final",
		message: stripInlineDirectiveTagsFromMessageForDisplay(strippedEnvelopeMessage)
	};
	params.context.broadcast("chat", payload);
	params.context.nodeSendToSession(params.sessionKey, "chat", payload);
	params.context.agentRunSeq.delete(params.runId);
}
function isBtwReplyPayload(payload) {
	return typeof payload?.btw?.question === "string" && payload.btw.question.trim().length > 0 && typeof payload.text === "string" && payload.text.trim().length > 0;
}
function broadcastSideResult(params) {
	const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.payload.runId);
	params.context.broadcast("chat.side_result", {
		...params.payload,
		seq
	});
	params.context.nodeSendToSession(params.payload.sessionKey, "chat.side_result", {
		...params.payload,
		seq
	});
}
function broadcastChatError(params) {
	const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
	const payload = {
		runId: params.runId,
		sessionKey: params.sessionKey,
		seq,
		state: "error",
		errorMessage: params.errorMessage
	};
	params.context.broadcast("chat", payload);
	params.context.nodeSendToSession(params.sessionKey, "chat", payload);
	params.context.agentRunSeq.delete(params.runId);
}
const chatHandlers = {
	"chat.history": async ({ params, respond, context }) => {
		if (!validateChatHistoryParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`));
			return;
		}
		const { sessionKey, limit } = params;
		const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
		const sessionId = entry?.sessionId;
		const rawMessages = sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
		const hardMax = 1e3;
		const requested = typeof limit === "number" ? limit : 200;
		const max = Math.min(hardMax, requested);
		const normalized = sanitizeChatHistoryMessages(stripEnvelopeFromMessages(rawMessages.length > max ? rawMessages.slice(-max) : rawMessages));
		const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
		const replaced = replaceOversizedChatHistoryMessages({
			messages: normalized,
			maxSingleMessageBytes: Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes)
		});
		const capped = capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
		const bounded = enforceChatHistoryFinalBudget({
			messages: capped,
			maxBytes: maxHistoryBytes
		});
		const placeholderCount = replaced.replacedCount + bounded.placeholderCount;
		if (placeholderCount > 0) {
			chatHistoryPlaceholderEmitCount += placeholderCount;
			context.logGateway.debug(`chat.history omitted oversized payloads placeholders=${placeholderCount} total=${chatHistoryPlaceholderEmitCount}`);
		}
		let thinkingLevel = entry?.thinkingLevel;
		if (!thinkingLevel) {
			const { provider, model } = resolveSessionModelRef(cfg, entry, resolveSessionAgentId({
				sessionKey,
				config: cfg
			}));
			thinkingLevel = resolveThinkingDefault({
				cfg,
				provider,
				model,
				catalog: await context.loadGatewayModelCatalog()
			});
		}
		const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
		respond(true, {
			sessionKey,
			sessionId,
			messages: bounded.messages,
			thinkingLevel,
			fastMode: entry?.fastMode,
			verboseLevel
		});
	},
	"chat.abort": ({ params, respond, context, client }) => {
		if (!validateChatAbortParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`));
			return;
		}
		const { sessionKey: rawSessionKey, runId } = params;
		const ops = createChatAbortOps(context);
		const requester = resolveChatAbortRequester(client);
		if (!runId) {
			const res = abortChatRunsForSessionKeyWithPartials({
				context,
				ops,
				sessionKey: rawSessionKey,
				abortOrigin: "rpc",
				stopReason: "rpc",
				requester
			});
			if (res.unauthorized) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
				return;
			}
			respond(true, {
				ok: true,
				aborted: res.aborted,
				runIds: res.runIds
			});
			return;
		}
		const active = context.chatAbortControllers.get(runId);
		if (!active) {
			respond(true, {
				ok: true,
				aborted: false,
				runIds: []
			});
			return;
		}
		if (active.sessionKey !== rawSessionKey) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"));
			return;
		}
		if (!canRequesterAbortChatRun(active, requester)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
			return;
		}
		const partialText = context.chatRunBuffers.get(runId);
		const res = abortChatRunById(ops, {
			runId,
			sessionKey: rawSessionKey,
			stopReason: "rpc"
		});
		if (res.aborted && partialText && partialText.trim()) persistAbortedPartials({
			context,
			sessionKey: rawSessionKey,
			snapshots: [{
				runId,
				sessionId: active.sessionId,
				text: partialText,
				abortOrigin: "rpc"
			}]
		});
		respond(true, {
			ok: true,
			aborted: res.aborted,
			runIds: res.aborted ? [runId] : []
		});
	},
	"chat.send": async ({ params, respond, context, client }) => {
		if (!validateChatSendParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`));
			return;
		}
		const p = params;
		if ((p.systemInputProvenance || p.systemProvenanceReceipt) && !isAcpBridgeClient(client)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "system provenance fields are reserved for the ACP bridge"));
			return;
		}
		const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
		if (!sanitizedMessageResult.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error));
			return;
		}
		const systemReceiptResult = normalizeOptionalChatSystemReceipt(p.systemProvenanceReceipt);
		if (!systemReceiptResult.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, systemReceiptResult.error));
			return;
		}
		const inboundMessage = sanitizedMessageResult.message;
		const systemInputProvenance = normalizeInputProvenance(p.systemInputProvenance);
		const systemProvenanceReceipt = systemReceiptResult.receipt;
		const stopCommand = isChatStopCommandText(inboundMessage);
		const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
		if (!inboundMessage.trim() && normalizedAttachments.length === 0) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"));
			return;
		}
		let parsedMessage = inboundMessage;
		let parsedImages = [];
		if (normalizedAttachments.length > 0) try {
			const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
				maxBytes: 5e6,
				log: context.logGateway
			});
			parsedMessage = parsed.message;
			parsedImages = parsed.images;
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
			return;
		}
		const rawSessionKey = p.sessionKey;
		const { cfg, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
		const timeoutMs = resolveAgentTimeoutMs({
			cfg,
			overrideMs: p.timeoutMs
		});
		const now = Date.now();
		const clientRunId = p.idempotencyKey;
		if (resolveSendPolicy({
			cfg,
			entry,
			sessionKey,
			channel: entry?.channel,
			chatType: entry?.chatType
		}) === "deny") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"));
			return;
		}
		if (stopCommand) {
			const res = abortChatRunsForSessionKeyWithPartials({
				context,
				ops: createChatAbortOps(context),
				sessionKey: rawSessionKey,
				abortOrigin: "stop-command",
				stopReason: "stop",
				requester: resolveChatAbortRequester(client)
			});
			if (res.unauthorized) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
				return;
			}
			respond(true, {
				ok: true,
				aborted: res.aborted,
				runIds: res.runIds
			});
			return;
		}
		const cached = context.dedupe.get(`chat:${clientRunId}`);
		if (cached) {
			respond(cached.ok, cached.payload, cached.error, { cached: true });
			return;
		}
		if (context.chatAbortControllers.get(clientRunId)) {
			respond(true, {
				runId: clientRunId,
				status: "in_flight"
			}, void 0, {
				cached: true,
				runId: clientRunId
			});
			return;
		}
		try {
			const abortController = new AbortController();
			context.chatAbortControllers.set(clientRunId, {
				controller: abortController,
				sessionId: entry?.sessionId ?? clientRunId,
				sessionKey: rawSessionKey,
				startedAtMs: now,
				expiresAtMs: resolveChatRunExpiresAtMs({
					now,
					timeoutMs
				}),
				ownerConnId: normalizeOptionalText(client?.connId),
				ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id)
			});
			respond(true, {
				runId: clientRunId,
				status: "started"
			}, void 0, { runId: clientRunId });
			const trimmedMessage = parsedMessage.trim();
			const commandBody = Boolean(p.thinking && trimmedMessage && !trimmedMessage.startsWith("/")) ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
			const messageForAgent = systemProvenanceReceipt ? [systemProvenanceReceipt, parsedMessage].filter(Boolean).join("\n\n") : parsedMessage;
			const clientInfo = client?.connect?.client;
			const { originatingChannel, originatingTo, accountId, messageThreadId, explicitDeliverRoute } = resolveChatSendOriginatingRoute({
				client: clientInfo,
				deliver: p.deliver,
				entry,
				hasConnectedClient: client?.connect !== void 0,
				mainKey: cfg.session?.mainKey,
				sessionKey
			});
			const ctx = {
				Body: messageForAgent,
				BodyForAgent: injectTimestamp(messageForAgent, timestampOptsFromConfig(cfg)),
				BodyForCommands: commandBody,
				RawBody: parsedMessage,
				CommandBody: commandBody,
				InputProvenance: systemInputProvenance,
				SessionKey: sessionKey,
				Provider: INTERNAL_MESSAGE_CHANNEL,
				Surface: INTERNAL_MESSAGE_CHANNEL,
				OriginatingChannel: originatingChannel,
				OriginatingTo: originatingTo,
				ExplicitDeliverRoute: explicitDeliverRoute,
				AccountId: accountId,
				MessageThreadId: messageThreadId,
				ChatType: "direct",
				CommandAuthorized: true,
				MessageSid: clientRunId,
				SenderId: clientInfo?.id,
				SenderName: clientInfo?.displayName,
				SenderUsername: clientInfo?.displayName,
				GatewayClientScopes: client?.connect?.scopes
			};
			const agentId = resolveSessionAgentId({
				sessionKey,
				config: cfg
			});
			const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
				cfg,
				agentId,
				channel: INTERNAL_MESSAGE_CHANNEL
			});
			const deliveredReplies = [];
			const dispatcher = createReplyDispatcher({
				...prefixOptions,
				onError: (err) => {
					context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
				},
				deliver: async (payload, info) => {
					if (info.kind !== "block" && info.kind !== "final") return;
					deliveredReplies.push({
						payload,
						kind: info.kind
					});
				}
			});
			let agentRunStarted = false;
			dispatchInboundMessage({
				ctx,
				cfg,
				dispatcher,
				replyOptions: {
					runId: clientRunId,
					abortSignal: abortController.signal,
					images: parsedImages.length > 0 ? parsedImages : void 0,
					onAgentRunStart: (runId) => {
						agentRunStarted = true;
						const connId = typeof client?.connId === "string" ? client.connId : void 0;
						const wantsToolEvents = hasGatewayClientCap(client?.connect?.caps, GATEWAY_CLIENT_CAPS.TOOL_EVENTS);
						if (connId && wantsToolEvents) {
							context.registerToolEventRecipient(runId, connId);
							for (const [activeRunId, active] of context.chatAbortControllers) if (activeRunId !== runId && active.sessionKey === p.sessionKey) context.registerToolEventRecipient(activeRunId, connId);
						}
					},
					onModelSelected
				}
			}).then(() => {
				if (!agentRunStarted) {
					const btwReplies = deliveredReplies.map((entry) => entry.payload).filter(isBtwReplyPayload);
					const btwText = btwReplies.map((payload) => payload.text.trim()).filter(Boolean).join("\n\n").trim();
					if (btwReplies.length > 0 && btwText) {
						broadcastSideResult({
							context,
							payload: {
								kind: "btw",
								runId: clientRunId,
								sessionKey: rawSessionKey,
								question: btwReplies[0].btw.question.trim(),
								text: btwText,
								isError: btwReplies.some((payload) => payload.isError),
								ts: Date.now()
							}
						});
						broadcastChatFinal({
							context,
							runId: clientRunId,
							sessionKey: rawSessionKey
						});
					} else {
						const combinedReply = deliveredReplies.filter((entry) => entry.kind === "final").map((entry) => entry.payload).map((part) => part.text?.trim() ?? "").filter(Boolean).join("\n\n").trim();
						let message;
						if (combinedReply) {
							const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
							const appended = appendAssistantTranscriptMessage({
								message: combinedReply,
								sessionId: latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId,
								storePath: latestStorePath,
								sessionFile: latestEntry?.sessionFile,
								agentId,
								createIfMissing: true
							});
							if (appended.ok) message = appended.message;
							else {
								context.logGateway.warn(`webchat transcript append failed: ${appended.error ?? "unknown error"}`);
								message = {
									role: "assistant",
									content: [{
										type: "text",
										text: combinedReply
									}],
									timestamp: Date.now(),
									stopReason: "stop",
									usage: {
										input: 0,
										output: 0,
										totalTokens: 0
									}
								};
							}
						}
						broadcastChatFinal({
							context,
							runId: clientRunId,
							sessionKey: rawSessionKey,
							message
						});
					}
				}
				setGatewayDedupeEntry({
					dedupe: context.dedupe,
					key: `chat:${clientRunId}`,
					entry: {
						ts: Date.now(),
						ok: true,
						payload: {
							runId: clientRunId,
							status: "ok"
						}
					}
				});
			}).catch((err) => {
				const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
				setGatewayDedupeEntry({
					dedupe: context.dedupe,
					key: `chat:${clientRunId}`,
					entry: {
						ts: Date.now(),
						ok: false,
						payload: {
							runId: clientRunId,
							status: "error",
							summary: String(err)
						},
						error
					}
				});
				broadcastChatError({
					context,
					runId: clientRunId,
					sessionKey: rawSessionKey,
					errorMessage: String(err)
				});
			}).finally(() => {
				context.chatAbortControllers.delete(clientRunId);
			});
		} catch (err) {
			const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
			const payload = {
				runId: clientRunId,
				status: "error",
				summary: String(err)
			};
			setGatewayDedupeEntry({
				dedupe: context.dedupe,
				key: `chat:${clientRunId}`,
				entry: {
					ts: Date.now(),
					ok: false,
					payload,
					error
				}
			});
			respond(false, payload, error, {
				runId: clientRunId,
				error: formatForLog(err)
			});
		}
	},
	"chat.inject": async ({ params, respond, context }) => {
		if (!validateChatInjectParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`));
			return;
		}
		const p = params;
		const rawSessionKey = p.sessionKey;
		const { cfg, storePath, entry } = loadSessionEntry(rawSessionKey);
		const sessionId = entry?.sessionId;
		if (!sessionId || !storePath) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
			return;
		}
		const appended = appendAssistantTranscriptMessage({
			message: p.message,
			label: p.label,
			sessionId,
			storePath,
			sessionFile: entry?.sessionFile,
			agentId: resolveSessionAgentId({
				sessionKey: rawSessionKey,
				config: cfg
			}),
			createIfMissing: true
		});
		if (!appended.ok || !appended.messageId || !appended.message) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `failed to write transcript: ${appended.error ?? "unknown error"}`));
			return;
		}
		const chatPayload = {
			runId: `inject-${appended.messageId}`,
			sessionKey: rawSessionKey,
			seq: 0,
			state: "final",
			message: stripInlineDirectiveTagsFromMessageForDisplay(stripEnvelopeFromMessage(appended.message))
		};
		context.broadcast("chat", chatPayload);
		context.nodeSendToSession(rawSessionKey, "chat", chatPayload);
		respond(true, {
			ok: true,
			messageId: appended.messageId
		});
	}
};
//#endregion
//#region src/config/schema.ts
function getChannelIds() {
	const { CHANNEL_IDS } = (init_registry(), __toCommonJS(registry_exports));
	return CHANNEL_IDS;
}
const FORBIDDEN_LOOKUP_SEGMENTS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
const LOOKUP_SCHEMA_STRING_KEYS = new Set([
	"$id",
	"$schema",
	"title",
	"description",
	"format",
	"pattern",
	"contentEncoding",
	"contentMediaType"
]);
const LOOKUP_SCHEMA_NUMBER_KEYS = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"minProperties",
	"maxProperties"
]);
const LOOKUP_SCHEMA_BOOLEAN_KEYS = new Set([
	"additionalProperties",
	"uniqueItems",
	"deprecated",
	"readOnly",
	"writeOnly"
]);
const MAX_LOOKUP_PATH_SEGMENTS = 32;
function cloneSchema(value) {
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value));
}
function asSchemaObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function isObjectSchema(schema) {
	const type = schema.type;
	if (type === "object") return true;
	if (Array.isArray(type) && type.includes("object")) return true;
	return Boolean(schema.properties || schema.additionalProperties);
}
function mergeObjectSchema(base, extension) {
	const mergedRequired = new Set([...base.required ?? [], ...extension.required ?? []]);
	const merged = {
		...base,
		...extension,
		properties: {
			...base.properties,
			...extension.properties
		}
	};
	if (mergedRequired.size > 0) merged.required = Array.from(mergedRequired);
	const additional = extension.additionalProperties ?? base.additionalProperties;
	if (additional !== void 0) merged.additionalProperties = additional;
	return merged;
}
function collectExtensionHintKeys(hints, plugins, channels) {
	const pluginPrefixes = plugins.map((plugin) => plugin.id.trim()).filter(Boolean).map((id) => `plugins.entries.${id}`);
	const channelPrefixes = channels.map((channel) => channel.id.trim()).filter(Boolean).map((id) => `channels.${id}`);
	const prefixes = [...pluginPrefixes, ...channelPrefixes];
	return new Set(Object.keys(hints).filter((key) => prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))));
}
function applyPluginHints(hints, plugins) {
	const next = { ...hints };
	for (const plugin of plugins) {
		const id = plugin.id.trim();
		if (!id) continue;
		const name = (plugin.name ?? id).trim() || id;
		const basePath = `plugins.entries.${id}`;
		next[basePath] = {
			...next[basePath],
			label: name,
			help: plugin.description ? `${plugin.description} (plugin: ${id})` : `Plugin entry for ${id}.`
		};
		next[`${basePath}.enabled`] = {
			...next[`${basePath}.enabled`],
			label: `Enable ${name}`
		};
		next[`${basePath}.config`] = {
			...next[`${basePath}.config`],
			label: `${name} Config`,
			help: `Plugin-defined config payload for ${id}.`
		};
		const uiHints = plugin.configUiHints ?? {};
		for (const [relPathRaw, hint] of Object.entries(uiHints)) {
			const relPath = relPathRaw.trim().replace(/^\./, "");
			if (!relPath) continue;
			const key = `${basePath}.config.${relPath}`;
			next[key] = {
				...next[key],
				...hint
			};
		}
	}
	return next;
}
function applyChannelHints(hints, channels) {
	const next = { ...hints };
	for (const channel of channels) {
		const id = channel.id.trim();
		if (!id) continue;
		const basePath = `channels.${id}`;
		const current = next[basePath] ?? {};
		const label = channel.label?.trim();
		const help = channel.description?.trim();
		next[basePath] = {
			...current,
			...label ? { label } : {},
			...help ? { help } : {}
		};
		const uiHints = channel.configUiHints ?? {};
		for (const [relPathRaw, hint] of Object.entries(uiHints)) {
			const relPath = relPathRaw.trim().replace(/^\./, "");
			if (!relPath) continue;
			const key = `${basePath}.${relPath}`;
			next[key] = {
				...next[key],
				...hint
			};
		}
	}
	return next;
}
function listHeartbeatTargetChannels(channels) {
	const seen = /* @__PURE__ */ new Set();
	const ordered = [];
	for (const id of getChannelIds()) {
		const normalized = id.trim().toLowerCase();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		ordered.push(normalized);
	}
	for (const channel of channels) {
		const normalized = channel.id.trim().toLowerCase();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		ordered.push(normalized);
	}
	return ordered;
}
function applyHeartbeatTargetHints(hints, channels) {
	const next = { ...hints };
	const channelList = listHeartbeatTargetChannels(channels);
	const help = `Delivery target ("last", "none", or a channel id).${channelList.length ? ` Known channels: ${channelList.join(", ")}.` : ""}`;
	for (const path of ["agents.defaults.heartbeat.target", "agents.list.*.heartbeat.target"]) {
		const current = next[path] ?? {};
		next[path] = {
			...current,
			help: current.help ?? help,
			placeholder: current.placeholder ?? "last"
		};
	}
	return next;
}
function applyPluginSchemas(schema, plugins) {
	const next = cloneSchema(schema);
	const entriesNode = asSchemaObject(asSchemaObject(asSchemaObject(next)?.properties?.plugins)?.properties?.entries);
	if (!entriesNode) return next;
	const entryBase = asSchemaObject(entriesNode.additionalProperties);
	const entryProperties = entriesNode.properties ?? {};
	entriesNode.properties = entryProperties;
	for (const plugin of plugins) {
		if (!plugin.configSchema) continue;
		const entryObject = asSchemaObject(entryBase ? cloneSchema(entryBase) : { type: "object" }) ?? { type: "object" };
		const baseConfigSchema = asSchemaObject(entryObject.properties?.config);
		const pluginSchema = asSchemaObject(plugin.configSchema);
		const nextConfigSchema = baseConfigSchema && pluginSchema && isObjectSchema(baseConfigSchema) && isObjectSchema(pluginSchema) ? mergeObjectSchema(baseConfigSchema, pluginSchema) : cloneSchema(plugin.configSchema);
		entryObject.properties = {
			...entryObject.properties,
			config: nextConfigSchema
		};
		entryProperties[plugin.id] = entryObject;
	}
	return next;
}
function applyChannelSchemas(schema, channels) {
	const next = cloneSchema(schema);
	const channelsNode = asSchemaObject(asSchemaObject(next)?.properties?.channels);
	if (!channelsNode) return next;
	const channelProps = channelsNode.properties ?? {};
	channelsNode.properties = channelProps;
	for (const channel of channels) {
		if (!channel.configSchema) continue;
		const existing = asSchemaObject(channelProps[channel.id]);
		const incoming = asSchemaObject(channel.configSchema);
		if (existing && incoming && isObjectSchema(existing) && isObjectSchema(incoming)) channelProps[channel.id] = mergeObjectSchema(existing, incoming);
		else channelProps[channel.id] = cloneSchema(channel.configSchema);
	}
	return next;
}
let cachedBase = null;
const mergedSchemaCache = /* @__PURE__ */ new Map();
const MERGED_SCHEMA_CACHE_MAX = 64;
function buildMergedSchemaCacheKey(params) {
	const plugins = params.plugins.map((plugin) => ({
		id: plugin.id,
		name: plugin.name,
		description: plugin.description,
		configSchema: plugin.configSchema ?? null,
		configUiHints: plugin.configUiHints ?? null
	})).toSorted((a, b) => a.id.localeCompare(b.id));
	const channels = params.channels.map((channel) => ({
		id: channel.id,
		label: channel.label,
		description: channel.description,
		configSchema: channel.configSchema ?? null,
		configUiHints: channel.configUiHints ?? null
	})).toSorted((a, b) => a.id.localeCompare(b.id));
	const hash = crypto.createHash("sha256");
	hash.update("{\"plugins\":[");
	plugins.forEach((plugin, index) => {
		if (index > 0) hash.update(",");
		hash.update(JSON.stringify(plugin));
	});
	hash.update("],\"channels\":[");
	channels.forEach((channel, index) => {
		if (index > 0) hash.update(",");
		hash.update(JSON.stringify(channel));
	});
	hash.update("]}");
	return hash.digest("hex");
}
function setMergedSchemaCache(key, value) {
	if (mergedSchemaCache.size >= MERGED_SCHEMA_CACHE_MAX) {
		const oldest = mergedSchemaCache.keys().next();
		if (!oldest.done) mergedSchemaCache.delete(oldest.value);
	}
	mergedSchemaCache.set(key, value);
}
function stripChannelSchema(schema) {
	const next = cloneSchema(schema);
	const root = asSchemaObject(next);
	if (!root || !root.properties) return next;
	delete root.properties.$schema;
	if (Array.isArray(root.required)) root.required = root.required.filter((key) => key !== "$schema");
	const channelsNode = asSchemaObject(root.properties.channels);
	if (channelsNode) {
		channelsNode.properties = {};
		channelsNode.required = [];
		channelsNode.additionalProperties = true;
	}
	return next;
}
function buildBaseConfigSchema() {
	if (cachedBase) return cachedBase;
	const schema = OpenClawSchema.toJSONSchema({
		target: "draft-07",
		unrepresentable: "any"
	});
	schema.title = "OpenClawConfig";
	const hints = applyDerivedTags(mapSensitivePaths(OpenClawSchema, "", buildBaseHints()));
	const next = {
		schema: stripChannelSchema(schema),
		uiHints: hints,
		version: VERSION,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	cachedBase = next;
	return next;
}
function buildConfigSchema(params) {
	const base = buildBaseConfigSchema();
	const plugins = params?.plugins ?? [];
	const channels = params?.channels ?? [];
	if (plugins.length === 0 && channels.length === 0) return base;
	const cacheKey = buildMergedSchemaCacheKey({
		plugins,
		channels
	});
	const cached = mergedSchemaCache.get(cacheKey);
	if (cached) return cached;
	const mergedWithoutSensitiveHints = applyHeartbeatTargetHints(applyChannelHints(applyPluginHints(base.uiHints, plugins), channels), channels);
	const mergedHints = applyDerivedTags(applySensitiveHints(mergedWithoutSensitiveHints, collectExtensionHintKeys(mergedWithoutSensitiveHints, plugins, channels)));
	const mergedSchema = applyChannelSchemas(applyPluginSchemas(base.schema, plugins), channels);
	const merged = {
		...base,
		schema: mergedSchema,
		uiHints: mergedHints
	};
	setMergedSchemaCache(cacheKey, merged);
	return merged;
}
function normalizeLookupPath(path) {
	return path.trim().replace(/\[(\*|\d*)\]/g, (_match, segment) => `.${segment || "*"}`).replace(/^\.+|\.+$/g, "").replace(/\.+/g, ".");
}
function splitLookupPath(path) {
	const normalized = normalizeLookupPath(path);
	return normalized ? normalized.split(".").filter(Boolean) : [];
}
function resolveUiHintMatch(uiHints, path) {
	const targetParts = splitLookupPath(path);
	let best = null;
	for (const [hintPath, hint] of Object.entries(uiHints)) {
		const hintParts = splitLookupPath(hintPath);
		if (hintParts.length !== targetParts.length) continue;
		let wildcardCount = 0;
		let matches = true;
		for (let index = 0; index < hintParts.length; index += 1) {
			const hintPart = hintParts[index];
			if (hintPart === targetParts[index]) continue;
			if (hintPart === "*") {
				wildcardCount += 1;
				continue;
			}
			matches = false;
			break;
		}
		if (!matches) continue;
		if (!best || wildcardCount < best.wildcardCount) best = {
			path: hintPath,
			hint,
			wildcardCount
		};
	}
	return best ? {
		path: best.path,
		hint: best.hint
	} : null;
}
function schemaHasChildren(schema) {
	if (schema.properties && Object.keys(schema.properties).length > 0) return true;
	if (schema.additionalProperties && typeof schema.additionalProperties === "object") return true;
	if (Array.isArray(schema.items)) return schema.items.some((entry) => typeof entry === "object" && entry !== null);
	return Boolean(schema.items && typeof schema.items === "object");
}
function resolveItemsSchema(schema, index) {
	if (Array.isArray(schema.items)) {
		const entry = index === void 0 ? schema.items.find((candidate) => typeof candidate === "object" && candidate !== null) : schema.items[index];
		return entry && typeof entry === "object" ? entry : null;
	}
	return schema.items && typeof schema.items === "object" ? schema.items : null;
}
function resolveLookupChildSchema(schema, segment) {
	if (FORBIDDEN_LOOKUP_SEGMENTS.has(segment)) return null;
	const properties = schema.properties;
	if (properties && Object.hasOwn(properties, segment)) return asSchemaObject(properties[segment]);
	const itemIndex = /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : void 0;
	const items = resolveItemsSchema(schema, itemIndex);
	if ((segment === "*" || itemIndex !== void 0) && items) return items;
	if (schema.additionalProperties && typeof schema.additionalProperties === "object") return schema.additionalProperties;
	return null;
}
function stripSchemaForLookup(schema) {
	const next = {};
	for (const [key, value] of Object.entries(schema)) {
		if (LOOKUP_SCHEMA_STRING_KEYS.has(key) && typeof value === "string") {
			next[key] = value;
			continue;
		}
		if (LOOKUP_SCHEMA_NUMBER_KEYS.has(key) && typeof value === "number") {
			next[key] = value;
			continue;
		}
		if (LOOKUP_SCHEMA_BOOLEAN_KEYS.has(key) && typeof value === "boolean") {
			next[key] = value;
			continue;
		}
		if (key === "type") {
			if (typeof value === "string") next[key] = value;
			else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) next[key] = [...value];
			continue;
		}
		if (key === "enum" && Array.isArray(value)) {
			const entries = value.filter((entry) => entry === null || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean");
			if (entries.length === value.length) next[key] = [...entries];
			continue;
		}
		if (key === "const" && (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")) next[key] = value;
	}
	return next;
}
function buildLookupChildren(schema, path, uiHints) {
	const children = [];
	const required = new Set(schema.required ?? []);
	const pushChild = (key, childSchema, isRequired) => {
		const childPath = path ? `${path}.${key}` : key;
		const resolvedHint = resolveUiHintMatch(uiHints, childPath);
		children.push({
			key,
			path: childPath,
			type: childSchema.type,
			required: isRequired,
			hasChildren: schemaHasChildren(childSchema),
			hint: resolvedHint?.hint,
			hintPath: resolvedHint?.path
		});
	};
	for (const [key, childSchema] of Object.entries(schema.properties ?? {})) pushChild(key, childSchema, required.has(key));
	const wildcardSchema = (schema.additionalProperties && typeof schema.additionalProperties === "object" && !Array.isArray(schema.additionalProperties) ? schema.additionalProperties : null) ?? resolveItemsSchema(schema);
	if (wildcardSchema) pushChild("*", wildcardSchema, false);
	return children;
}
function lookupConfigSchema(response, path) {
	const normalizedPath = normalizeLookupPath(path);
	if (!normalizedPath) return null;
	const parts = splitLookupPath(normalizedPath);
	if (parts.length === 0 || parts.length > MAX_LOOKUP_PATH_SEGMENTS) return null;
	let current = asSchemaObject(response.schema);
	if (!current) return null;
	for (const segment of parts) {
		const next = resolveLookupChildSchema(current, segment);
		if (!next) return null;
		current = next;
	}
	const resolvedHint = resolveUiHintMatch(response.uiHints, normalizedPath);
	return {
		path: normalizedPath,
		schema: stripSchemaForLookup(current),
		hint: resolvedHint?.hint,
		hintPath: resolvedHint?.path,
		children: buildLookupChildren(current, normalizedPath, response.uiHints)
	};
}
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
function parseRestartRequestParams(params) {
	const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey?.trim() || void 0 : void 0;
	const note = typeof params.note === "string" ? params.note?.trim() || void 0 : void 0;
	const restartDelayMsRaw = params.restartDelayMs;
	return {
		sessionKey,
		note,
		restartDelayMs: typeof restartDelayMsRaw === "number" && Number.isFinite(restartDelayMsRaw) ? Math.max(0, Math.floor(restartDelayMsRaw)) : void 0
	};
}
//#endregion
//#region src/gateway/server-methods/validation.ts
function assertValidParams(params, validate, method, respond) {
	if (validate(params)) return true;
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params: ${formatValidationErrors(validate.errors)}`));
	return false;
}
//#endregion
//#region src/gateway/server-methods/config.ts
const MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE = 3;
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
function resolveConfigRestartRequest(params) {
	const { sessionKey, note, restartDelayMs } = parseRestartRequestParams(params);
	const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
	return {
		sessionKey,
		note,
		restartDelayMs,
		deliveryContext,
		threadId
	};
}
function buildConfigRestartSentinelPayload(params) {
	const configPath = createConfigIO().configPath;
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
			root: configPath
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
function loadSchemaWithPlugins() {
	const cfg = loadConfig();
	return buildConfigSchema({
		plugins: loadOpenClawPlugins({
			config: cfg,
			cache: true,
			workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {}
			}
		}).plugins.map((plugin) => ({
			id: plugin.id,
			name: plugin.name,
			description: plugin.description,
			configUiHints: plugin.configUiHints,
			configSchema: plugin.configJsonSchema
		})),
		channels: listChannelPlugins().map((entry) => ({
			id: entry.id,
			label: entry.meta.label,
			description: entry.meta.blurb,
			configSchema: entry.configSchema?.schema,
			configUiHints: entry.configSchema?.uiHints
		}))
	});
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
		const result = lookupConfigSchema(loadSchemaWithPlugins(), path);
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
	"config.set": async ({ params, respond }) => {
		if (!assertValidParams(params, validateConfigSetParams, "config.set", respond)) return;
		const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
		if (!requireConfigBaseHash(params, snapshot, respond)) return;
		const parsed = parseValidateConfigFromRawOrRespond(params, "config.set", snapshot, respond);
		if (!parsed) return;
		await writeConfigFile(parsed.config, writeOptions);
		respond(true, {
			ok: true,
			path: createConfigIO().configPath,
			config: redactConfigObject(parsed.config, parsed.schema.uiHints)
		}, void 0);
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
		const validated = validateConfigObjectWithPlugins(applyLegacyMigrations(restoredMerge.result).next ?? restoredMerge.result);
		if (!validated.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, summarizeConfigValidationIssues(validated.issues), { details: { issues: validated.issues } }));
			return;
		}
		const changedPaths = diffConfigPaths(snapshot.config, validated.config);
		const actor = resolveControlPlaneActor(client);
		context?.logGateway?.info(`config.patch write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.patch`);
		await writeConfigFile(validated.config, writeOptions);
		const { sessionKey, note, restartDelayMs, deliveryContext, threadId } = resolveConfigRestartRequest(params);
		const payload = buildConfigRestartSentinelPayload({
			kind: "config-patch",
			mode: "config.patch",
			sessionKey,
			deliveryContext,
			threadId,
			note
		});
		const sentinelPath = await tryWriteRestartSentinelPayload(payload);
		const restart = scheduleGatewaySigusr1Restart({
			delayMs: restartDelayMs,
			reason: "config.patch",
			audit: {
				actor: actor.actor,
				deviceId: actor.deviceId,
				clientIp: actor.clientIp,
				changedPaths
			}
		});
		if (restart.coalesced) context?.logGateway?.warn(`config.patch restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`);
		respond(true, {
			ok: true,
			path: createConfigIO().configPath,
			config: redactConfigObject(validated.config, schemaPatch.uiHints),
			restart,
			sentinel: {
				path: sentinelPath,
				payload
			}
		}, void 0);
	},
	"config.apply": async ({ params, respond, client, context }) => {
		if (!assertValidParams(params, validateConfigApplyParams, "config.apply", respond)) return;
		const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
		if (!requireConfigBaseHash(params, snapshot, respond)) return;
		const parsed = parseValidateConfigFromRawOrRespond(params, "config.apply", snapshot, respond);
		if (!parsed) return;
		const changedPaths = diffConfigPaths(snapshot.config, parsed.config);
		const actor = resolveControlPlaneActor(client);
		context?.logGateway?.info(`config.apply write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.apply`);
		await writeConfigFile(parsed.config, writeOptions);
		const { sessionKey, note, restartDelayMs, deliveryContext, threadId } = resolveConfigRestartRequest(params);
		const payload = buildConfigRestartSentinelPayload({
			kind: "config-apply",
			mode: "config.apply",
			sessionKey,
			deliveryContext,
			threadId,
			note
		});
		const sentinelPath = await tryWriteRestartSentinelPayload(payload);
		const restart = scheduleGatewaySigusr1Restart({
			delayMs: restartDelayMs,
			reason: "config.apply",
			audit: {
				actor: actor.actor,
				deviceId: actor.deviceId,
				clientIp: actor.clientIp,
				changedPaths
			}
		});
		if (restart.coalesced) context?.logGateway?.warn(`config.apply restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`);
		respond(true, {
			ok: true,
			path: createConfigIO().configPath,
			config: redactConfigObject(parsed.config, parsed.schema.uiHints),
			restart,
			sentinel: {
				path: sentinelPath,
				payload
			}
		}, void 0);
	},
	"config.openFile": ({ params, respond }) => {
		if (!assertValidParams(params, validateConfigGetParams, "config.openFile", respond)) return;
		const configPath = createConfigIO().configPath;
		const platform = process.platform;
		exec(`${platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open"} ${JSON.stringify(configPath)}`, (err) => {
			if (err) {
				respond(true, {
					ok: false,
					path: configPath,
					error: err.message
				}, void 0);
				return;
			}
			respond(true, {
				ok: true,
				path: configPath
			}, void 0);
		});
	}
};
//#endregion
//#region src/gateway/server-methods/connect.ts
const connectHandlers = { connect: ({ respond }) => {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "connect is only valid as the first request"));
} };
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
	const atRaw = typeof schedule.at === "string" ? schedule.at.trim() : "";
	const atMs = atRaw ? parseAbsoluteTimeMs(atRaw) : null;
	if (atMs === null || !Number.isFinite(atMs)) return {
		ok: false,
		message: `Invalid schedule.at: expected ISO-8601 timestamp (got ${String(schedule.at)})`
	};
	const diffMs = atMs - nowMs;
	if (diffMs < -ONE_MINUTE_MS) {
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
const cronHandlers = {
	wake: ({ params, respond, context }) => {
		if (!validateWakeParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid wake params: ${formatValidationErrors(validateWakeParams.errors)}`));
			return;
		}
		const p = params;
		respond(true, context.cron.wake({
			mode: p.mode,
			text: p.text
		}), void 0);
	},
	"cron.list": async ({ params, respond, context }) => {
		if (!validateCronListParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.list params: ${formatValidationErrors(validateCronListParams.errors)}`));
			return;
		}
		const p = params;
		respond(true, await context.cron.listPage({
			includeDisabled: p.includeDisabled,
			limit: p.limit,
			offset: p.offset,
			query: p.query,
			enabled: p.enabled,
			sortBy: p.sortBy,
			sortDir: p.sortDir
		}), void 0);
	},
	"cron.status": async ({ params, respond, context }) => {
		if (!validateCronStatusParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.status params: ${formatValidationErrors(validateCronStatusParams.errors)}`));
			return;
		}
		respond(true, await context.cron.status(), void 0);
	},
	"cron.add": async ({ params, respond, context }) => {
		const normalized = normalizeCronJobCreate(params, { sessionContext: { sessionKey: typeof params?.sessionKey === "string" ? params.sessionKey : void 0 } }) ?? params;
		if (!validateCronAddParams(normalized)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`));
			return;
		}
		const jobCreate = normalized;
		const timestampValidation = validateScheduleTimestamp(jobCreate.schedule);
		if (!timestampValidation.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message));
			return;
		}
		const job = await context.cron.add(jobCreate);
		context.logGateway.info("cron: job created", {
			jobId: job.id,
			schedule: jobCreate.schedule
		});
		respond(true, job, void 0);
	},
	"cron.update": async ({ params, respond, context }) => {
		const normalizedPatch = normalizeCronJobPatch(params?.patch);
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
		if (patch.schedule) {
			const timestampValidation = validateScheduleTimestamp(patch.schedule);
			if (!timestampValidation.ok) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message));
				return;
			}
		}
		const job = await context.cron.update(jobId, patch);
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
		respond(true, await context.cron.enqueueRun(jobId, p.mode ?? "force"), void 0);
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
function redactPairedDevice(device) {
	const { tokens, approvedScopes: _approvedScopes, ...rest } = device;
	return {
		...rest,
		tokens: summarizeDeviceTokens(tokens)
	};
}
function resolveMissingRequestedScope(params) {
	for (const scope of params.requestedScopes) if (!roleScopesAllow({
		role: params.role,
		requestedScopes: [scope],
		allowedScopes: params.callerScopes
	})) return scope;
	return null;
}
function logDeviceTokenRotationDenied(params) {
	const suffix = params.scope ? ` scope=${params.scope}` : "";
	params.log.warn(`device token rotation denied device=${params.deviceId} role=${params.role} reason=${params.reason}${suffix}`);
}
const deviceHandlers = {
	"device.pair.list": async ({ params, respond }) => {
		if (!validateDevicePairListParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.pair.list params: ${formatValidationErrors(validateDevicePairListParams.errors)}`));
			return;
		}
		const list = await listDevicePairing();
		respond(true, {
			pending: list.pending,
			paired: list.paired.map((device) => redactPairedDevice(device))
		}, void 0);
	},
	"device.pair.approve": async ({ params, respond, context, client }) => {
		if (!validateDevicePairApproveParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.pair.approve params: ${formatValidationErrors(validateDevicePairApproveParams.errors)}`));
			return;
		}
		const { requestId } = params;
		const approved = await approveDevicePairing(requestId, { callerScopes: Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [] });
		if (!approved) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
			return;
		}
		if (approved.status === "forbidden") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${approved.missingScope}`));
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
	"device.pair.reject": async ({ params, respond, context }) => {
		if (!validateDevicePairRejectParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.pair.reject params: ${formatValidationErrors(validateDevicePairRejectParams.errors)}`));
			return;
		}
		const { requestId } = params;
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
	"device.pair.remove": async ({ params, respond, context }) => {
		if (!validateDevicePairRemoveParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.pair.remove params: ${formatValidationErrors(validateDevicePairRemoveParams.errors)}`));
			return;
		}
		const { deviceId } = params;
		const removed = await removePairedDevice(deviceId);
		if (!removed) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId"));
			return;
		}
		context.logGateway.info(`device pairing removed device=${removed.deviceId}`);
		respond(true, removed, void 0);
	},
	"device.token.rotate": async ({ params, respond, context, client }) => {
		if (!validateDeviceTokenRotateParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.token.rotate params: ${formatValidationErrors(validateDeviceTokenRotateParams.errors)}`));
			return;
		}
		const { deviceId, role, scopes } = params;
		const pairedDevice = await getPairedDevice(deviceId);
		if (!pairedDevice) {
			logDeviceTokenRotationDenied({
				log: context.logGateway,
				deviceId,
				role,
				reason: "unknown-device-or-role"
			});
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE));
			return;
		}
		const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
		const missingScope = resolveMissingRequestedScope({
			role,
			requestedScopes: normalizeDeviceAuthScopes(scopes ?? pairedDevice.tokens?.[role.trim()]?.scopes ?? pairedDevice.scopes),
			callerScopes
		});
		if (missingScope) {
			logDeviceTokenRotationDenied({
				log: context.logGateway,
				deviceId,
				role,
				reason: "caller-missing-scope",
				scope: missingScope
			});
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE));
			return;
		}
		const rotated = await rotateDeviceToken({
			deviceId,
			role,
			scopes
		});
		if (!rotated.ok) {
			logDeviceTokenRotationDenied({
				log: context.logGateway,
				deviceId,
				role,
				reason: rotated.reason
			});
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE));
			return;
		}
		const entry = rotated.entry;
		context.logGateway.info(`device token rotated device=${deviceId} role=${entry.role} scopes=${entry.scopes.join(",")}`);
		respond(true, {
			deviceId,
			role: entry.role,
			token: entry.token,
			scopes: entry.scopes,
			rotatedAtMs: entry.rotatedAtMs ?? entry.createdAtMs
		}, void 0);
	},
	"device.token.revoke": async ({ params, respond, context }) => {
		if (!validateDeviceTokenRevokeParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.token.revoke params: ${formatValidationErrors(validateDeviceTokenRevokeParams.errors)}`));
			return;
		}
		const { deviceId, role } = params;
		const entry = await revokeDeviceToken({
			deviceId,
			role
		});
		if (!entry) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId/role"));
			return;
		}
		context.logGateway.info(`device token revoked device=${deviceId} role=${entry.role}`);
		respond(true, {
			deviceId,
			role: entry.role,
			revokedAtMs: entry.revokedAtMs ?? Date.now()
		}, void 0);
	}
};
//#endregion
//#region src/gateway/server-methods/doctor.ts
const doctorHandlers = { "doctor.memory.status": async ({ respond }) => {
	const cfg = loadConfig();
	const agentId = resolveDefaultAgentId(cfg);
	const { manager, error } = await getMemorySearchManager({
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
		let embedding = await manager.probeEmbeddingAvailability();
		if (!embedding.ok && !embedding.error) embedding = {
			ok: false,
			error: "memory embeddings unavailable"
		};
		respond(true, {
			agentId,
			provider: status.provider,
			embedding
		}, void 0);
	} catch (err) {
		respond(true, {
			agentId,
			embedding: {
				ok: false,
				error: `gateway memory probe failed: ${formatError(err)}`
			}
		}, void 0);
	} finally {
		await manager.close?.().catch(() => {});
	}
} };
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
const ADMIN_SCOPE$2 = "operator.admin";
const healthHandlers = {
	health: async ({ respond, context, params }) => {
		const { getHealthCache, refreshHealthSnapshot, logHealth } = context;
		const wantsProbe = params?.probe === true;
		const now = Date.now();
		const cached = getHealthCache();
		if (!wantsProbe && cached && now - cached.ts < 6e4) {
			respond(true, cached, void 0, { cached: true });
			refreshHealthSnapshot({ probe: false }).catch((err) => logHealth.error(`background health refresh failed: ${formatError(err)}`));
			return;
		}
		try {
			respond(true, await refreshHealthSnapshot({ probe: wantsProbe }), void 0);
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	status: async ({ respond, client }) => {
		respond(true, await getStatusSummary({ includeSensitive: (Array.isArray(client?.connect?.scopes) ? client.connect.scopes : []).includes(ADMIN_SCOPE$2) }), void 0);
	}
};
//#endregion
//#region src/gateway/server-methods/logs.ts
init_utils();
const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_BYTES = 25e4;
const MAX_LIMIT = 5e3;
const MAX_BYTES = 1e6;
const ROLLING_LOG_RE = /^openclaw-\d{4}-\d{2}-\d{2}\.log$/;
function isRollingLogFile(file) {
	return ROLLING_LOG_RE.test(path.basename(file));
}
async function resolveLogFile(file) {
	if (await fs$1.stat(file).catch(() => null)) return file;
	if (!isRollingLogFile(file)) return file;
	const dir = path.dirname(file);
	const entries = await fs$1.readdir(dir, { withFileTypes: true }).catch(() => null);
	if (!entries) return file;
	return (await Promise.all(entries.filter((entry) => entry.isFile() && ROLLING_LOG_RE.test(entry.name)).map(async (entry) => {
		const fullPath = path.join(dir, entry.name);
		const fileStat = await fs$1.stat(fullPath).catch(() => null);
		return fileStat ? {
			path: fullPath,
			mtimeMs: fileStat.mtimeMs
		} : null;
	}))).filter((entry) => Boolean(entry)).toSorted((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? file;
}
async function readLogSlice(params) {
	const stat = await fs$1.stat(params.file).catch(() => null);
	if (!stat) return {
		cursor: 0,
		size: 0,
		lines: [],
		truncated: false,
		reset: false
	};
	const size = stat.size;
	const maxBytes = clamp(params.maxBytes, 1, MAX_BYTES);
	const limit = clamp(params.limit, 1, MAX_LIMIT);
	let cursor = typeof params.cursor === "number" && Number.isFinite(params.cursor) ? Math.max(0, Math.floor(params.cursor)) : void 0;
	let reset = false;
	let truncated = false;
	let start = 0;
	if (cursor != null) if (cursor > size) {
		reset = true;
		start = Math.max(0, size - maxBytes);
		truncated = start > 0;
	} else {
		start = cursor;
		if (size - start > maxBytes) {
			reset = true;
			truncated = true;
			start = Math.max(0, size - maxBytes);
		}
	}
	else {
		start = Math.max(0, size - maxBytes);
		truncated = start > 0;
	}
	if (size === 0 || size <= start) return {
		cursor: size,
		size,
		lines: [],
		truncated,
		reset
	};
	const handle = await fs$1.open(params.file, "r");
	try {
		let prefix = "";
		if (start > 0) {
			const prefixBuf = Buffer.alloc(1);
			const prefixRead = await handle.read(prefixBuf, 0, 1, start - 1);
			prefix = prefixBuf.toString("utf8", 0, prefixRead.bytesRead);
		}
		const length = Math.max(0, size - start);
		const buffer = Buffer.alloc(length);
		const readResult = await handle.read(buffer, 0, length, start);
		let lines = buffer.toString("utf8", 0, readResult.bytesRead).split("\n");
		if (start > 0 && prefix !== "\n") lines = lines.slice(1);
		if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
		if (lines.length > limit) lines = lines.slice(lines.length - limit);
		cursor = size;
		return {
			cursor,
			size,
			lines,
			truncated,
			reset
		};
	} finally {
		await handle.close();
	}
}
const logsHandlers = { "logs.tail": async ({ params, respond }) => {
	if (!validateLogsTailParams(params)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid logs.tail params: ${formatValidationErrors(validateLogsTailParams.errors)}`));
		return;
	}
	const p = params;
	const configuredFile = getResolvedLoggerSettings().file;
	try {
		const file = await resolveLogFile(configuredFile);
		respond(true, {
			file,
			...await readLogSlice({
				file,
				cursor: p.cursor,
				limit: p.limit ?? DEFAULT_LIMIT,
				maxBytes: p.maxBytes ?? DEFAULT_MAX_BYTES
			})
		}, void 0);
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `log read failed: ${String(err)}`));
	}
} };
//#endregion
//#region src/gateway/server-methods/models.ts
const modelsHandlers = { "models.list": async ({ params, respond, context }) => {
	if (!validateModelsListParams(params)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`));
		return;
	}
	try {
		const catalog = await context.loadGatewayModelCatalog();
		const { allowedCatalog } = buildAllowedModelSet({
			cfg: loadConfig(),
			catalog,
			defaultProvider: DEFAULT_PROVIDER
		});
		respond(true, { models: allowedCatalog.length > 0 ? allowedCatalog : catalog }, void 0);
	} catch (err) {
		respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
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
	if (state) pruneExpired(state, nowMs);
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
//#region src/gateway/canvas-capability.ts
const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
const CANVAS_CAPABILITY_QUERY_PARAM = "oc_cap";
const CANVAS_CAPABILITY_TTL_MS = 10 * 6e4;
function normalizeCapability(raw) {
	const trimmed = raw?.trim();
	return trimmed ? trimmed : void 0;
}
function mintCanvasCapabilityToken() {
	return randomBytes(18).toString("base64url");
}
function buildCanvasScopedHostUrl(baseUrl, capability) {
	const normalizedCapability = normalizeCapability(capability);
	if (!normalizedCapability) return;
	try {
		const url = new URL(baseUrl);
		url.pathname = `${url.pathname.replace(/\/+$/, "")}${`${CANVAS_CAPABILITY_PATH_PREFIX}/${encodeURIComponent(normalizedCapability)}`}`;
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return;
	}
}
function normalizeCanvasScopedUrl(rawUrl) {
	const url = new URL(rawUrl, "http://localhost");
	const prefix = `${CANVAS_CAPABILITY_PATH_PREFIX}/`;
	let scopedPath = false;
	let malformedScopedPath = false;
	let capabilityFromPath;
	let rewrittenUrl;
	if (url.pathname.startsWith(prefix)) {
		scopedPath = true;
		const remainder = url.pathname.slice(prefix.length);
		const slashIndex = remainder.indexOf("/");
		if (slashIndex <= 0) malformedScopedPath = true;
		else {
			const encodedCapability = remainder.slice(0, slashIndex);
			const canonicalPath = remainder.slice(slashIndex) || "/";
			let decoded;
			try {
				decoded = decodeURIComponent(encodedCapability);
			} catch {
				malformedScopedPath = true;
			}
			capabilityFromPath = normalizeCapability(decoded);
			if (!capabilityFromPath || !canonicalPath.startsWith("/")) malformedScopedPath = true;
			else {
				url.pathname = canonicalPath;
				if (!url.searchParams.has("oc_cap")) url.searchParams.set(CANVAS_CAPABILITY_QUERY_PARAM, capabilityFromPath);
				rewrittenUrl = `${url.pathname}${url.search}`;
			}
		}
	}
	const capability = capabilityFromPath ?? normalizeCapability(url.searchParams.get("oc_cap"));
	return {
		pathname: url.pathname,
		capability,
		rewrittenUrl,
		scopedPath,
		malformedScopedPath
	};
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
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function normalizeString(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}
function normalizeApprovalDecision(value) {
	const s = normalizeString(value);
	return s === "allow-once" || s === "allow-always" ? s : null;
}
function clientHasApprovals(client) {
	const scopes = Array.isArray(client?.connect?.scopes) ? client?.connect?.scopes : [];
	return scopes.includes("operator.admin") || scopes.includes("operator.approvals");
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
	const obj = asRecord(opts.rawParams);
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
	const runId = normalizeString(p.runId);
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
	const targetNodeId = normalizeString(opts.nodeId);
	if (!targetNodeId) return systemRunApprovalGuardError({
		code: "MISSING_NODE_ID",
		message: "node.invoke requires nodeId",
		details: { runId }
	});
	const approvalNodeId = normalizeString(snapshot.request.nodeId);
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
	} else if (snapshot.requestedByConnId && snapshot.requestedByConnId !== (opts.client?.connId ?? null)) return systemRunApprovalGuardError({
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
const NODE_WAKE_RECONNECT_WAIT_MS = 3e3;
const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12e3;
const NODE_WAKE_THROTTLE_MS = 15e3;
const NODE_WAKE_NUDGE_THROTTLE_MS = 10 * 6e4;
const NODE_PENDING_ACTION_TTL_MS = 10 * 6e4;
const NODE_PENDING_ACTION_MAX_PER_NODE = 64;
const nodeWakeById = /* @__PURE__ */ new Map();
const nodeWakeNudgeById = /* @__PURE__ */ new Map();
const pendingNodeActionsById = /* @__PURE__ */ new Map();
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
function resolveRelayNodePushConfig() {
	const relay = resolveApnsRelayConfigFromEnv(process.env, loadConfig().gateway);
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
function isNodeEntry(entry) {
	if (entry.role === "node") return true;
	if (Array.isArray(entry.roles) && entry.roles.includes("node")) return true;
	return false;
}
async function delayMs(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
function isForegroundRestrictedIosCommand(command) {
	return command === "canvas.present" || command === "canvas.navigate" || command.startsWith("canvas.") || command.startsWith("camera.") || command.startsWith("screen.") || command.startsWith("talk.");
}
function shouldQueueAsPendingForegroundAction(params) {
	const platform = (params.platform ?? "").trim().toLowerCase();
	if (!platform.startsWith("ios") && !platform.startsWith("ipados")) return false;
	if (!isForegroundRestrictedIosCommand(params.command)) return false;
	const error = params.error && typeof params.error === "object" ? params.error : null;
	const code = typeof error?.code === "string" ? error.code.trim().toUpperCase() : "";
	const message = typeof error?.message === "string" ? error.message.trim().toUpperCase() : "";
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
function resolveAllowedPendingNodeActions(params) {
	const pending = listPendingNodeActions(params.nodeId);
	if (pending.length === 0) return pending;
	const connect = params.client?.connect;
	const declaredCommands = Array.isArray(connect?.commands) ? connect.commands : [];
	const allowlist = resolveNodeCommandAllowlist(loadConfig(), {
		platform: connect?.client?.platform,
		deviceFamily: connect?.client?.deviceFamily
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
			if (!registration) return withDuration({
				available: false,
				throttled: false,
				path: "no-registration"
			});
			let wakeResult;
			if (registration.transport === "relay") {
				const relay = resolveRelayNodePushConfig();
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
			const message = err instanceof Error ? err.message : String(err);
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
async function maybeSendNodeWakeNudge(nodeId) {
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
			const relay = resolveRelayNodePushConfig();
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
			apnsReason: err instanceof Error ? err.message : String(err)
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
	"node.pair.approve": async ({ params, respond, context }) => {
		if (!validateNodePairApproveParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pair.approve",
				validator: validateNodePairApproveParams
			});
			return;
		}
		const { requestId } = params;
		await respondUnavailableOnThrow(respond, async () => {
			const approved = await approveNodePairing(requestId);
			if (!approved) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
				return;
			}
			context.broadcast("node.pair.resolved", {
				requestId,
				nodeId: approved.node.nodeId,
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
			const list = await listDevicePairing();
			const pairedById = new Map(list.paired.filter((entry) => isNodeEntry(entry)).map((entry) => [entry.deviceId, {
				nodeId: entry.deviceId,
				displayName: entry.displayName,
				platform: entry.platform,
				version: void 0,
				coreVersion: void 0,
				uiVersion: void 0,
				deviceFamily: void 0,
				modelIdentifier: void 0,
				remoteIp: entry.remoteIp,
				caps: [],
				commands: [],
				permissions: void 0
			}]));
			const connected = context.nodeRegistry.listConnected();
			const connectedById = new Map(connected.map((n) => [n.nodeId, n]));
			const nodes = [...new Set([...pairedById.keys(), ...connectedById.keys()])].map((nodeId) => {
				const paired = pairedById.get(nodeId);
				const live = connectedById.get(nodeId);
				const caps = uniqueSortedStrings([...live?.caps ?? paired?.caps ?? []]);
				const commands = uniqueSortedStrings([...live?.commands ?? paired?.commands ?? []]);
				return {
					nodeId,
					displayName: live?.displayName ?? paired?.displayName,
					platform: live?.platform ?? paired?.platform,
					version: live?.version ?? paired?.version,
					coreVersion: live?.coreVersion ?? paired?.coreVersion,
					uiVersion: live?.uiVersion ?? paired?.uiVersion,
					deviceFamily: live?.deviceFamily ?? paired?.deviceFamily,
					modelIdentifier: live?.modelIdentifier ?? paired?.modelIdentifier,
					remoteIp: live?.remoteIp ?? paired?.remoteIp,
					caps,
					commands,
					pathEnv: live?.pathEnv,
					permissions: live?.permissions ?? paired?.permissions,
					connectedAtMs: live?.connectedAtMs,
					paired: Boolean(paired),
					connected: Boolean(live)
				};
			});
			nodes.sort((a, b) => {
				if (a.connected !== b.connected) return a.connected ? -1 : 1;
				const an = (a.displayName ?? a.nodeId).toLowerCase();
				const bn = (b.displayName ?? b.nodeId).toLowerCase();
				if (an < bn) return -1;
				if (an > bn) return 1;
				return a.nodeId.localeCompare(b.nodeId);
			});
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
		const id = String(nodeId ?? "").trim();
		if (!id) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
			return;
		}
		await respondUnavailableOnThrow(respond, async () => {
			const paired = (await listDevicePairing()).paired.find((n) => n.deviceId === id && isNodeEntry(n));
			const live = context.nodeRegistry.listConnected().find((n) => n.nodeId === id);
			if (!paired && !live) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
				return;
			}
			const caps = uniqueSortedStrings([...live?.caps ?? []]);
			const commands = uniqueSortedStrings([...live?.commands ?? []]);
			respond(true, {
				ts: Date.now(),
				nodeId: id,
				displayName: live?.displayName ?? paired?.displayName,
				platform: live?.platform ?? paired?.platform,
				version: live?.version,
				coreVersion: live?.coreVersion,
				uiVersion: live?.uiVersion,
				deviceFamily: live?.deviceFamily,
				modelIdentifier: live?.modelIdentifier,
				remoteIp: live?.remoteIp ?? paired?.remoteIp,
				caps,
				commands,
				pathEnv: live?.pathEnv,
				permissions: live?.permissions,
				connectedAtMs: live?.connectedAtMs,
				paired: Boolean(paired),
				connected: Boolean(live)
			}, void 0);
		});
	},
	"node.canvas.capability.refresh": async ({ params, respond, client }) => {
		if (!validateNodeListParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.canvas.capability.refresh",
				validator: validateNodeListParams
			});
			return;
		}
		const baseCanvasHostUrl = client?.canvasHostUrl?.trim() ?? "";
		if (!baseCanvasHostUrl) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "canvas host unavailable for this node session"));
			return;
		}
		const canvasCapability = mintCanvasCapabilityToken();
		const canvasCapabilityExpiresAtMs = Date.now() + CANVAS_CAPABILITY_TTL_MS;
		const scopedCanvasHostUrl = buildCanvasScopedHostUrl(baseCanvasHostUrl, canvasCapability);
		if (!scopedCanvasHostUrl) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "failed to mint scoped canvas host URL"));
			return;
		}
		if (client) {
			client.canvasCapability = canvasCapability;
			client.canvasCapabilityExpiresAtMs = canvasCapabilityExpiresAtMs;
		}
		respond(true, {
			canvasCapability,
			canvasCapabilityExpiresAtMs,
			canvasHostUrl: scopedCanvasHostUrl
		}, void 0);
	},
	"node.pending.pull": async ({ params, respond, client }) => {
		if (!validateNodeListParams(params)) {
			respondInvalidParams({
				respond,
				method: "node.pending.pull",
				validator: validateNodeListParams
			});
			return;
		}
		const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
		const trimmedNodeId = String(nodeId ?? "").trim();
		if (!trimmedNodeId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
			return;
		}
		respond(true, {
			nodeId: trimmedNodeId,
			actions: resolveAllowedPendingNodeActions({
				nodeId: trimmedNodeId,
				client
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
		const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
		const trimmedNodeId = String(nodeId ?? "").trim();
		if (!trimmedNodeId) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
			return;
		}
		const ackIds = Array.from(new Set((params.ids ?? []).map((value) => String(value ?? "").trim()).filter(Boolean)));
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
		const nodeId = String(p.nodeId ?? "").trim();
		const command = String(p.command ?? "").trim();
		if (!nodeId || !command) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId and command required"));
			return;
		}
		if (command === "system.execApprovals.get" || command === "system.execApprovals.set") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "node.invoke does not allow system.execApprovals.*; use exec.approvals.node.*", { details: { command } }));
			return;
		}
		await respondUnavailableOnThrow(respond, async () => {
			let nodeSession = context.nodeRegistry.get(nodeId);
			if (!nodeSession) {
				const wakeReqId = req.id;
				const wakeFlowStartedAtMs = Date.now();
				context.logGateway.info(`node wake start node=${nodeId} req=${wakeReqId} command=${command}`);
				const wake = await maybeWakeNodeWithApns(nodeId);
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
					const retryWake = await maybeWakeNodeWithApns(nodeId, { force: true });
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
					const nudge = await maybeSendNodeWakeNudge(nodeId);
					context.logGateway.info(`node wake nudge node=${nodeId} req=${wakeReqId} sent=${nudge.sent} throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`);
					context.logGateway.warn(`node wake done node=${nodeId} req=${wakeReqId} connected=false reason=not_connected totalMs=${totalDurationMs}`);
					respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "node not connected", { details: { code: "NOT_CONNECTED" } }));
					return;
				}
				const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
				context.logGateway.info(`node wake done node=${nodeId} req=${wakeReqId} connected=true totalMs=${totalDurationMs}`);
			}
			const allowlist = resolveNodeCommandAllowlist(loadConfig(), nodeSession);
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
					const wake = await maybeWakeNodeWithApns(nodeId);
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
			respond(true, {
				ok: true,
				nodeId,
				command,
				payload: res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload,
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
			const { handleNodeEvent } = await import("./server-node-events-Bt30WAh5.js");
			const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id ?? "node";
			await handleNodeEvent({
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
				logGateway: { warn: context.logGateway.warn }
			}, nodeId, {
				event: p.event,
				payloadJSON
			});
			respond(true, { ok: true }, void 0);
		});
	}
};
function buildNodeCommandRejectionHint(reason, command, node) {
	const platform = node?.platform ?? "unknown";
	if (reason === "command not declared by node") return `node command not allowed: the node (platform: ${platform}) does not support "${command}"`;
	if (reason === "command not allowlisted") return `node command not allowed: "${command}" is not in the allowlist for platform "${platform}"`;
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
				const wake = await maybeWakeNodeWithApns(p.nodeId, { wakeReason: "node.pending" });
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
						wakeReason: "node.pending"
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
					const nudge = await maybeSendNodeWakeNudge(p.nodeId);
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
//#region src/gateway/server-methods/push.ts
function normalizeOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
const pushHandlers = { "push.test": async ({ params, respond }) => {
	if (!validatePushTestParams(params)) {
		respondInvalidParams({
			respond,
			method: "push.test",
			validator: validatePushTestParams
		});
		return;
	}
	const nodeId = String(params.nodeId ?? "").trim();
	if (!nodeId) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
		return;
	}
	const title = normalizeOptionalString(params.title) ?? "OpenClaw";
	const body = normalizeOptionalString(params.body) ?? `Push test for node ${nodeId}`;
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
			const relay = resolveApnsRelayConfigFromEnv(process.env, loadConfig().gateway);
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
} };
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
async function resolveRequestedChannel(params) {
	const channelInput = typeof params.requestChannel === "string" ? params.requestChannel : void 0;
	const normalizedChannel = channelInput ? normalizeChannelId(channelInput) : null;
	if (channelInput && !normalizedChannel) {
		const normalizedInput = channelInput.trim().toLowerCase();
		if (params.rejectWebchatAsInternalOnly && normalizedInput === "webchat") return { error: errorShape(ErrorCodes.INVALID_REQUEST, "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.") };
		return { error: errorShape(ErrorCodes.INVALID_REQUEST, params.unsupportedMessage(channelInput)) };
	}
	const cfg = loadConfig();
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
const sendHandlers = {
	send: async ({ params, respond, context }) => {
		const p = params;
		if (!validateSendParams(p)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`));
			return;
		}
		const request = p;
		const idem = request.idempotencyKey;
		const dedupeKey = `send:${idem}`;
		const cached = context.dedupe.get(dedupeKey);
		if (cached) {
			respond(cached.ok, cached.payload, cached.error, { cached: true });
			return;
		}
		const inflightMap = getInflightMap(context);
		const inflight = inflightMap.get(dedupeKey);
		if (inflight) {
			const result = await inflight;
			const meta = result.meta ? {
				...result.meta,
				cached: true
			} : { cached: true };
			respond(result.ok, result.payload, result.error, meta);
			return;
		}
		const to = request.to.trim();
		const message = typeof request.message === "string" ? request.message.trim() : "";
		const mediaUrl = typeof request.mediaUrl === "string" && request.mediaUrl.trim().length > 0 ? request.mediaUrl.trim() : void 0;
		const mediaUrls = Array.isArray(request.mediaUrls) ? request.mediaUrls.map((entry) => typeof entry === "string" ? entry.trim() : "").filter((entry) => entry.length > 0) : void 0;
		if (!message && !mediaUrl && (mediaUrls?.length ?? 0) === 0) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid send params: text or media is required"));
			return;
		}
		const resolvedChannel = await resolveRequestedChannel({
			requestChannel: request.channel,
			unsupportedMessage: (input) => `unsupported channel: ${input}`,
			rejectWebchatAsInternalOnly: true
		});
		if ("error" in resolvedChannel) {
			respond(false, void 0, resolvedChannel.error);
			return;
		}
		const { cfg, channel } = resolvedChannel;
		const accountId = typeof request.accountId === "string" && request.accountId.trim().length ? request.accountId.trim() : void 0;
		const threadId = typeof request.threadId === "string" && request.threadId.trim().length ? request.threadId.trim() : void 0;
		const outboundChannel = channel;
		if (!resolveOutboundChannelPlugin({
			channel,
			cfg
		})) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`));
			return;
		}
		const work = (async () => {
			try {
				const resolved = resolveOutboundTarget({
					channel: outboundChannel,
					to,
					cfg,
					accountId,
					mode: "explicit"
				});
				if (!resolved.ok) return {
					ok: false,
					error: errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)),
					meta: { channel }
				};
				const idLikeTarget = await maybeResolveIdLikeTarget({
					cfg,
					channel,
					input: resolved.to,
					accountId
				});
				const deliveryTarget = idLikeTarget?.to ?? resolved.to;
				const outboundDeps = context.deps ? createOutboundSendDeps(context.deps) : void 0;
				const mirrorPayloads = normalizeReplyPayloadsForDelivery([{
					text: message,
					mediaUrl,
					mediaUrls
				}]);
				const mirrorText = mirrorPayloads.map((payload) => payload.text).filter(Boolean).join("\n");
				const mirrorMediaUrls = mirrorPayloads.flatMap((payload) => payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []));
				const providedSessionKey = typeof request.sessionKey === "string" && request.sessionKey.trim() ? request.sessionKey.trim().toLowerCase() : void 0;
				const explicitAgentId = typeof request.agentId === "string" && request.agentId.trim() ? request.agentId.trim() : void 0;
				const sessionAgentId = providedSessionKey ? resolveSessionAgentId({
					sessionKey: providedSessionKey,
					config: cfg
				}) : void 0;
				const defaultAgentId = resolveSessionAgentId({ config: cfg });
				const effectiveAgentId = explicitAgentId ?? sessionAgentId ?? defaultAgentId;
				const derivedRoute = !providedSessionKey ? await resolveOutboundSessionRoute({
					cfg,
					channel,
					agentId: effectiveAgentId,
					accountId,
					target: deliveryTarget,
					resolvedTarget: idLikeTarget,
					threadId
				}) : null;
				if (derivedRoute) await ensureOutboundSessionEntry({
					cfg,
					agentId: effectiveAgentId,
					channel,
					accountId,
					route: derivedRoute
				});
				const outboundSession = buildOutboundSessionContext({
					cfg,
					agentId: effectiveAgentId,
					sessionKey: providedSessionKey ?? derivedRoute?.sessionKey
				});
				const result = (await deliverOutboundPayloads({
					cfg,
					channel: outboundChannel,
					to: deliveryTarget,
					accountId,
					payloads: [{
						text: message,
						mediaUrl,
						mediaUrls
					}],
					session: outboundSession,
					gifPlayback: request.gifPlayback,
					threadId: threadId ?? null,
					deps: outboundDeps,
					mirror: providedSessionKey ? {
						sessionKey: providedSessionKey,
						agentId: effectiveAgentId,
						text: mirrorText || message,
						mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : void 0,
						idempotencyKey: idem
					} : derivedRoute ? {
						sessionKey: derivedRoute.sessionKey,
						agentId: effectiveAgentId,
						text: mirrorText || message,
						mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : void 0,
						idempotencyKey: idem
					} : void 0
				})).at(-1);
				if (!result) throw new Error("No delivery result");
				const payload = {
					runId: idem,
					messageId: result.messageId,
					channel
				};
				if ("chatId" in result) payload.chatId = result.chatId;
				if ("channelId" in result) payload.channelId = result.channelId;
				if ("toJid" in result) payload.toJid = result.toJid;
				if ("conversationId" in result) payload.conversationId = result.conversationId;
				context.dedupe.set(dedupeKey, {
					ts: Date.now(),
					ok: true,
					payload
				});
				return {
					ok: true,
					payload,
					meta: { channel }
				};
			} catch (err) {
				const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
				context.dedupe.set(dedupeKey, {
					ts: Date.now(),
					ok: false,
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
		})();
		inflightMap.set(dedupeKey, work);
		try {
			const result = await work;
			respond(result.ok, result.payload, result.error, result.meta);
		} finally {
			inflightMap.delete(dedupeKey);
		}
	},
	poll: async ({ params, respond, context }) => {
		const p = params;
		if (!validatePollParams(p)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid poll params: ${formatValidationErrors(validatePollParams.errors)}`));
			return;
		}
		const request = p;
		const idem = request.idempotencyKey;
		const cached = context.dedupe.get(`poll:${idem}`);
		if (cached) {
			respond(cached.ok, cached.payload, cached.error, { cached: true });
			return;
		}
		const to = request.to.trim();
		const resolvedChannel = await resolveRequestedChannel({
			requestChannel: request.channel,
			unsupportedMessage: (input) => `unsupported poll channel: ${input}`
		});
		if ("error" in resolvedChannel) {
			respond(false, void 0, resolvedChannel.error);
			return;
		}
		const { cfg, channel } = resolvedChannel;
		if (typeof request.durationSeconds === "number" && channel !== "telegram") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "durationSeconds is only supported for Telegram polls"));
			return;
		}
		if (typeof request.isAnonymous === "boolean" && channel !== "telegram") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "isAnonymous is only supported for Telegram polls"));
			return;
		}
		const poll = {
			question: request.question,
			options: request.options,
			maxSelections: request.maxSelections,
			durationSeconds: request.durationSeconds,
			durationHours: request.durationHours
		};
		const threadId = typeof request.threadId === "string" && request.threadId.trim().length ? request.threadId.trim() : void 0;
		const accountId = typeof request.accountId === "string" && request.accountId.trim().length ? request.accountId.trim() : void 0;
		try {
			const outbound = resolveOutboundChannelPlugin({
				channel,
				cfg
			})?.outbound;
			if (!outbound?.sendPoll) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported poll channel: ${channel}`));
				return;
			}
			const resolved = resolveOutboundTarget({
				channel,
				to,
				cfg,
				accountId,
				mode: "explicit"
			});
			if (!resolved.ok) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)));
				return;
			}
			const normalized = outbound.pollMaxOptions ? normalizePollInput(poll, { maxOptions: outbound.pollMaxOptions }) : normalizePollInput(poll);
			const result = await outbound.sendPoll({
				cfg,
				to: resolved.to,
				poll: normalized,
				accountId,
				threadId,
				silent: request.silent,
				isAnonymous: request.isAnonymous
			});
			const payload = {
				runId: idem,
				messageId: result.messageId,
				channel
			};
			if (result.toJid) payload.toJid = result.toJid;
			if (result.channelId) payload.channelId = result.channelId;
			if (result.conversationId) payload.conversationId = result.conversationId;
			if (result.pollId) payload.pollId = result.pollId;
			context.dedupe.set(`poll:${idem}`, {
				ts: Date.now(),
				ok: true,
				payload
			});
			respond(true, payload, void 0, { channel });
		} catch (err) {
			const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
			context.dedupe.set(`poll:${idem}`, {
				ts: Date.now(),
				ok: false,
				error
			});
			respond(false, void 0, error, {
				channel,
				error: formatForLog(err)
			});
		}
	}
};
//#endregion
//#region src/gateway/sessions-patch.ts
init_session_key();
function invalid(message) {
	return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, message)
	};
}
function normalizeExecHost(raw) {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") return normalized;
}
function normalizeExecSecurity(raw) {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "deny" || normalized === "allowlist" || normalized === "full") return normalized;
}
function normalizeExecAsk(raw) {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "off" || normalized === "on-miss" || normalized === "always") return normalized;
}
function supportsSpawnLineage(storeKey) {
	return isSubagentSessionKey(storeKey) || isAcpSessionKey(storeKey);
}
function normalizeSubagentRole(raw) {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "orchestrator" || normalized === "leaf") return normalized;
}
function normalizeSubagentControlScope(raw) {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "children" || normalized === "none") return normalized;
}
async function applySessionsPatchToStore(params) {
	const { cfg, store, storeKey, patch } = params;
	const now = Date.now();
	const sessionAgentId = normalizeAgentId(parseAgentSessionKey(storeKey)?.agentId ?? resolveDefaultAgentId(cfg));
	const resolvedDefault = resolveDefaultModelForAgent({
		cfg,
		agentId: sessionAgentId
	});
	const subagentModelHint = isSubagentSessionKey(storeKey) ? resolveSubagentConfiguredModelSelection({
		cfg,
		agentId: sessionAgentId
	}) : void 0;
	const existing = store[storeKey];
	const next = existing ? {
		...existing,
		updatedAt: Math.max(existing.updatedAt ?? 0, now)
	} : {
		sessionId: randomUUID(),
		updatedAt: now
	};
	if ("spawnedBy" in patch) {
		const raw = patch.spawnedBy;
		if (raw === null) {
			if (existing?.spawnedBy) return invalid("spawnedBy cannot be cleared once set");
		} else if (raw !== void 0) {
			const trimmed = String(raw).trim();
			if (!trimmed) return invalid("invalid spawnedBy: empty");
			if (!supportsSpawnLineage(storeKey)) return invalid("spawnedBy is only supported for subagent:* or acp:* sessions");
			if (existing?.spawnedBy && existing.spawnedBy !== trimmed) return invalid("spawnedBy cannot be changed once set");
			next.spawnedBy = trimmed;
		}
	}
	if ("spawnedWorkspaceDir" in patch) {
		const raw = patch.spawnedWorkspaceDir;
		if (raw === null) {
			if (existing?.spawnedWorkspaceDir) return invalid("spawnedWorkspaceDir cannot be cleared once set");
		} else if (raw !== void 0) {
			if (!supportsSpawnLineage(storeKey)) return invalid("spawnedWorkspaceDir is only supported for subagent:* or acp:* sessions");
			const trimmed = String(raw).trim();
			if (!trimmed) return invalid("invalid spawnedWorkspaceDir: empty");
			if (existing?.spawnedWorkspaceDir && existing.spawnedWorkspaceDir !== trimmed) return invalid("spawnedWorkspaceDir cannot be changed once set");
			next.spawnedWorkspaceDir = trimmed;
		}
	}
	if ("spawnDepth" in patch) {
		const raw = patch.spawnDepth;
		if (raw === null) {
			if (typeof existing?.spawnDepth === "number") return invalid("spawnDepth cannot be cleared once set");
		} else if (raw !== void 0) {
			if (!supportsSpawnLineage(storeKey)) return invalid("spawnDepth is only supported for subagent:* or acp:* sessions");
			const numeric = Number(raw);
			if (!Number.isInteger(numeric) || numeric < 0) return invalid("invalid spawnDepth (use an integer >= 0)");
			const normalized = numeric;
			if (typeof existing?.spawnDepth === "number" && existing.spawnDepth !== normalized) return invalid("spawnDepth cannot be changed once set");
			next.spawnDepth = normalized;
		}
	}
	if ("subagentRole" in patch) {
		const raw = patch.subagentRole;
		if (raw === null) {
			if (existing?.subagentRole) return invalid("subagentRole cannot be cleared once set");
		} else if (raw !== void 0) {
			if (!supportsSpawnLineage(storeKey)) return invalid("subagentRole is only supported for subagent:* or acp:* sessions");
			const normalized = normalizeSubagentRole(String(raw));
			if (!normalized) return invalid("invalid subagentRole (use \"orchestrator\" or \"leaf\")");
			if (existing?.subagentRole && existing.subagentRole !== normalized) return invalid("subagentRole cannot be changed once set");
			next.subagentRole = normalized;
		}
	}
	if ("subagentControlScope" in patch) {
		const raw = patch.subagentControlScope;
		if (raw === null) {
			if (existing?.subagentControlScope) return invalid("subagentControlScope cannot be cleared once set");
		} else if (raw !== void 0) {
			if (!supportsSpawnLineage(storeKey)) return invalid("subagentControlScope is only supported for subagent:* or acp:* sessions");
			const normalized = normalizeSubagentControlScope(String(raw));
			if (!normalized) return invalid("invalid subagentControlScope (use \"children\" or \"none\")");
			if (existing?.subagentControlScope && existing.subagentControlScope !== normalized) return invalid("subagentControlScope cannot be changed once set");
			next.subagentControlScope = normalized;
		}
	}
	if ("label" in patch) {
		const raw = patch.label;
		if (raw === null) delete next.label;
		else if (raw !== void 0) {
			const parsed = parseSessionLabel(raw);
			if (!parsed.ok) return invalid(parsed.error);
			for (const [key, entry] of Object.entries(store)) {
				if (key === storeKey) continue;
				if (entry?.label === parsed.label) return invalid(`label already in use: ${parsed.label}`);
			}
			next.label = parsed.label;
		}
	}
	if ("thinkingLevel" in patch) {
		const raw = patch.thinkingLevel;
		if (raw === null) delete next.thinkingLevel;
		else if (raw !== void 0) {
			const normalized = normalizeThinkLevel(String(raw));
			if (!normalized) return invalid(`invalid thinkingLevel (use ${formatThinkingLevels(existing?.providerOverride?.trim() || resolvedDefault.provider, existing?.modelOverride?.trim() || resolvedDefault.model, "|")})`);
			next.thinkingLevel = normalized;
		}
	}
	if ("fastMode" in patch) {
		const raw = patch.fastMode;
		if (raw === null) delete next.fastMode;
		else if (raw !== void 0) {
			const normalized = normalizeFastMode(raw);
			if (normalized === void 0) return invalid("invalid fastMode (use true or false)");
			next.fastMode = normalized;
		}
	}
	if ("verboseLevel" in patch) {
		const raw = patch.verboseLevel;
		const parsed = parseVerboseOverride(raw);
		if (!parsed.ok) return invalid(parsed.error);
		applyVerboseOverride(next, parsed.value);
	}
	if ("reasoningLevel" in patch) {
		const raw = patch.reasoningLevel;
		if (raw === null) delete next.reasoningLevel;
		else if (raw !== void 0) {
			const normalized = normalizeReasoningLevel(String(raw));
			if (!normalized) return invalid("invalid reasoningLevel (use \"on\"|\"off\"|\"stream\")");
			next.reasoningLevel = normalized;
		}
	}
	if ("responseUsage" in patch) {
		const raw = patch.responseUsage;
		if (raw === null) delete next.responseUsage;
		else if (raw !== void 0) {
			const normalized = normalizeUsageDisplay(String(raw));
			if (!normalized) return invalid("invalid responseUsage (use \"off\"|\"tokens\"|\"full\")");
			if (normalized === "off") delete next.responseUsage;
			else next.responseUsage = normalized;
		}
	}
	if ("elevatedLevel" in patch) {
		const raw = patch.elevatedLevel;
		if (raw === null) delete next.elevatedLevel;
		else if (raw !== void 0) {
			const normalized = normalizeElevatedLevel(String(raw));
			if (!normalized) return invalid("invalid elevatedLevel (use \"on\"|\"off\"|\"ask\"|\"full\")");
			next.elevatedLevel = normalized;
		}
	}
	if ("execHost" in patch) {
		const raw = patch.execHost;
		if (raw === null) delete next.execHost;
		else if (raw !== void 0) {
			const normalized = normalizeExecHost(String(raw));
			if (!normalized) return invalid("invalid execHost (use \"sandbox\"|\"gateway\"|\"node\")");
			next.execHost = normalized;
		}
	}
	if ("execSecurity" in patch) {
		const raw = patch.execSecurity;
		if (raw === null) delete next.execSecurity;
		else if (raw !== void 0) {
			const normalized = normalizeExecSecurity(String(raw));
			if (!normalized) return invalid("invalid execSecurity (use \"deny\"|\"allowlist\"|\"full\")");
			next.execSecurity = normalized;
		}
	}
	if ("execAsk" in patch) {
		const raw = patch.execAsk;
		if (raw === null) delete next.execAsk;
		else if (raw !== void 0) {
			const normalized = normalizeExecAsk(String(raw));
			if (!normalized) return invalid("invalid execAsk (use \"off\"|\"on-miss\"|\"always\")");
			next.execAsk = normalized;
		}
	}
	if ("execNode" in patch) {
		const raw = patch.execNode;
		if (raw === null) delete next.execNode;
		else if (raw !== void 0) {
			const trimmed = String(raw).trim();
			if (!trimmed) return invalid("invalid execNode: empty");
			next.execNode = trimmed;
		}
	}
	if ("model" in patch) {
		const raw = patch.model;
		if (raw === null) applyModelOverrideToSessionEntry({
			entry: next,
			selection: {
				provider: resolvedDefault.provider,
				model: resolvedDefault.model,
				isDefault: true
			}
		});
		else if (raw !== void 0) {
			const trimmed = String(raw).trim();
			if (!trimmed) return invalid("invalid model: empty");
			if (!params.loadGatewayModelCatalog) return {
				ok: false,
				error: errorShape(ErrorCodes.UNAVAILABLE, "model catalog unavailable")
			};
			const resolved = resolveAllowedModelRef({
				cfg,
				catalog: await params.loadGatewayModelCatalog(),
				raw: trimmed,
				defaultProvider: resolvedDefault.provider,
				defaultModel: subagentModelHint ?? resolvedDefault.model
			});
			if ("error" in resolved) return invalid(resolved.error);
			const isDefault = resolved.ref.provider === resolvedDefault.provider && resolved.ref.model === resolvedDefault.model;
			applyModelOverrideToSessionEntry({
				entry: next,
				selection: {
					provider: resolved.ref.provider,
					model: resolved.ref.model,
					isDefault
				}
			});
		}
	}
	if (next.thinkingLevel === "xhigh") {
		if (!supportsXHighThinking(next.providerOverride ?? resolvedDefault.provider, next.modelOverride ?? resolvedDefault.model)) {
			if ("thinkingLevel" in patch) return invalid(`thinkingLevel "xhigh" is only supported for ${formatXHighModelHint()}`);
			next.thinkingLevel = "high";
		}
	}
	if ("sendPolicy" in patch) {
		const raw = patch.sendPolicy;
		if (raw === null) delete next.sendPolicy;
		else if (raw !== void 0) {
			const normalized = normalizeSendPolicy(String(raw));
			if (!normalized) return invalid("invalid sendPolicy (use \"allow\"|\"deny\")");
			next.sendPolicy = normalized;
		}
	}
	if ("groupActivation" in patch) {
		const raw = patch.groupActivation;
		if (raw === null) delete next.groupActivation;
		else if (raw !== void 0) {
			const normalized = normalizeGroupActivation(String(raw));
			if (!normalized) return invalid("invalid groupActivation (use \"mention\"|\"always\")");
			next.groupActivation = normalized;
		}
	}
	store[storeKey] = next;
	return {
		ok: true,
		entry: next
	};
}
//#endregion
//#region src/gateway/sessions-resolve.ts
async function resolveSessionKeyFromResolveParams(params) {
	const { cfg, p } = params;
	const key = typeof p.key === "string" ? p.key.trim() : "";
	const hasKey = key.length > 0;
	const sessionId = typeof p.sessionId === "string" ? p.sessionId.trim() : "";
	const hasSessionId = sessionId.length > 0;
	const selectionCount = [
		hasKey,
		hasSessionId,
		typeof p.label === "string" && p.label.trim().length > 0
	].filter(Boolean).length;
	if (selectionCount > 1) return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, "Provide either key, sessionId, or label (not multiple)")
	};
	if (selectionCount === 0) return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, "Either key, sessionId, or label is required")
	};
	if (hasKey) {
		const target = resolveGatewaySessionStoreTarget({
			cfg,
			key
		});
		const store = loadSessionStore(target.storePath);
		if (store[target.canonicalKey]) return {
			ok: true,
			key: target.canonicalKey
		};
		const legacyKey = target.storeKeys.find((candidate) => store[candidate]);
		if (!legacyKey) return {
			ok: false,
			error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${key}`)
		};
		await updateSessionStore(target.storePath, (s) => {
			const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
				cfg,
				key,
				store: s
			});
			if (!s[primaryKey] && s[legacyKey]) s[primaryKey] = s[legacyKey];
		});
		return {
			ok: true,
			key: target.canonicalKey
		};
	}
	if (hasSessionId) {
		const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
		const matches = listSessionsFromStore({
			cfg,
			storePath,
			store,
			opts: {
				includeGlobal: p.includeGlobal === true,
				includeUnknown: p.includeUnknown === true,
				spawnedBy: p.spawnedBy,
				agentId: p.agentId,
				search: sessionId,
				limit: 8
			}
		}).sessions.filter((session) => session.sessionId === sessionId || session.key === sessionId);
		if (matches.length === 0) return {
			ok: false,
			error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${sessionId}`)
		};
		if (matches.length > 1) {
			const keys = matches.map((session) => session.key).join(", ");
			return {
				ok: false,
				error: errorShape(ErrorCodes.INVALID_REQUEST, `Multiple sessions found for sessionId: ${sessionId} (${keys})`)
			};
		}
		return {
			ok: true,
			key: String(matches[0]?.key ?? "")
		};
	}
	const parsedLabel = parseSessionLabel(p.label);
	if (!parsedLabel.ok) return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, parsedLabel.error)
	};
	const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
	const list = listSessionsFromStore({
		cfg,
		storePath,
		store,
		opts: {
			includeGlobal: p.includeGlobal === true,
			includeUnknown: p.includeUnknown === true,
			label: parsedLabel.label,
			agentId: p.agentId,
			spawnedBy: p.spawnedBy,
			limit: 2
		}
	});
	if (list.sessions.length === 0) return {
		ok: false,
		error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found with label: ${parsedLabel.label}`)
	};
	if (list.sessions.length > 1) {
		const keys = list.sessions.map((s) => s.key).join(", ");
		return {
			ok: false,
			error: errorShape(ErrorCodes.INVALID_REQUEST, `Multiple sessions found with label: ${parsedLabel.label} (${keys})`)
		};
	}
	return {
		ok: true,
		key: String(list.sessions[0]?.key ?? "")
	};
}
//#endregion
//#region src/gateway/server-methods/sessions.ts
init_session_key();
function requireSessionKey(key, respond) {
	const normalized = (typeof key === "string" ? key : typeof key === "number" ? String(key) : typeof key === "bigint" ? String(key) : "").trim();
	if (!normalized) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
		return null;
	}
	return normalized;
}
function resolveGatewaySessionTargetFromKey(key) {
	const cfg = loadConfig();
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
function rejectWebchatSessionMutation(params) {
	if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) return false;
	if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) return false;
	params.respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`));
	return true;
}
const sessionsHandlers = {
	"sessions.list": ({ params, respond }) => {
		if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) return;
		const p = params;
		const cfg = loadConfig();
		const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
		respond(true, listSessionsFromStore({
			cfg,
			storePath,
			store,
			opts: p
		}), void 0);
	},
	"sessions.preview": ({ params, respond }) => {
		if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) return;
		const p = params;
		const keys = (Array.isArray(p.keys) ? p.keys : []).map((key) => String(key ?? "").trim()).filter(Boolean).slice(0, 64);
		const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
		const maxChars = typeof p.maxChars === "number" && Number.isFinite(p.maxChars) ? Math.max(20, p.maxChars) : 240;
		if (keys.length === 0) {
			respond(true, {
				ts: Date.now(),
				previews: []
			}, void 0);
			return;
		}
		const cfg = loadConfig();
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
			const entry = target.storeKeys.map((candidate) => store[candidate]).find(Boolean);
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
	"sessions.resolve": async ({ params, respond }) => {
		if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) return;
		const p = params;
		const resolved = await resolveSessionKeyFromResolveParams({
			cfg: loadConfig(),
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
		const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
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
		const agentId = normalizeAgentId(parseAgentSessionKey(target.canonicalKey ?? key)?.agentId ?? resolveDefaultAgentId(cfg));
		const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
		respond(true, {
			ok: true,
			path: storePath,
			key: target.canonicalKey,
			entry: applied.entry,
			resolved: {
				modelProvider: resolved.provider,
				model: resolved.model
			}
		}, void 0);
	},
	"sessions.reset": async ({ params, respond }) => {
		if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) return;
		const p = params;
		const key = requireSessionKey(p.key, respond);
		if (!key) return;
		const result = await performGatewaySessionReset({
			key,
			reason: p.reason === "new" ? "new" : "reset",
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
	},
	"sessions.delete": async ({ params, respond, client, isWebchatConnect }) => {
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
		const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
		const mainKey = resolveMainSessionKey(cfg);
		if (target.canonicalKey === mainKey) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`));
			return;
		}
		const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;
		const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
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
		const archived = deleted && deleteTranscript ? archiveSessionTranscriptsForSession({
			sessionId,
			storePath,
			sessionFile: entry?.sessionFile,
			agentId: target.agentId,
			reason: "deleted"
		}) : [];
		if (deleted) {
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
	},
	"sessions.get": ({ params, respond }) => {
		const p = params;
		const key = requireSessionKey(p.key ?? p.sessionKey, respond);
		if (!key) return;
		const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, Math.floor(p.limit)) : 200;
		const { target, storePath } = resolveGatewaySessionTargetFromKey(key);
		const store = loadSessionStore(storePath);
		const entry = target.storeKeys.map((k) => store[k]).find(Boolean);
		if (!entry?.sessionId) {
			respond(true, { messages: [] }, void 0);
			return;
		}
		const allMessages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
		respond(true, { messages: limit < allMessages.length ? allMessages.slice(-limit) : allMessages }, void 0);
	},
	"sessions.compact": async ({ params, respond }) => {
		if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) return;
		const p = params;
		const key = requireSessionKey(p.key, respond);
		if (!key) return;
		const maxLines = typeof p.maxLines === "number" && Number.isFinite(p.maxLines) ? Math.max(1, Math.floor(p.maxLines)) : 400;
		const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
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
		const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter((l) => l.trim().length > 0);
		if (lines.length <= maxLines) {
			respond(true, {
				ok: true,
				key: target.canonicalKey,
				compacted: false,
				kept: lines.length
			}, void 0);
			return;
		}
		const archived = archiveFileOnDisk(filePath, "bak");
		const keptLines = lines.slice(-maxLines);
		fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");
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
			kept: keptLines.length
		}, void 0);
	}
};
//#endregion
//#region src/gateway/server-methods/skills.ts
init_session_key();
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
				const trimmed = String(bin).trim();
				if (trimmed) bins.add(trimmed);
			}
		}
	}
	return [...bins].toSorted();
}
const skillsHandlers = {
	"skills.status": ({ params, respond }) => {
		if (!validateSkillsStatusParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`));
			return;
		}
		const cfg = loadConfig();
		const agentIdRaw = typeof params?.agentId === "string" ? params.agentId.trim() : "";
		const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
		if (agentIdRaw) {
			if (!listAgentIds(cfg).includes(agentId)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`));
				return;
			}
		}
		respond(true, buildWorkspaceSkillStatus(resolveAgentWorkspaceDir(cfg, agentId), {
			config: cfg,
			eligibility: { remote: getRemoteSkillEligibility() }
		}), void 0);
	},
	"skills.bins": ({ params, respond }) => {
		if (!validateSkillsBinsParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`));
			return;
		}
		const cfg = loadConfig();
		const workspaceDirs = listAgentWorkspaceDirs(cfg);
		const bins = /* @__PURE__ */ new Set();
		for (const workspaceDir of workspaceDirs) {
			const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
			for (const bin of collectSkillBins(entries)) bins.add(bin);
		}
		respond(true, { bins: [...bins].toSorted() }, void 0);
	},
	"skills.install": async ({ params, respond }) => {
		if (!validateSkillsInstallParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`));
			return;
		}
		const p = params;
		const cfg = loadConfig();
		const result = await installSkill({
			workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
			skillName: p.name,
			installId: p.installId,
			timeoutMs: p.timeoutMs,
			config: cfg
		});
		respond(result.ok, result, result.ok ? void 0 : errorShape(ErrorCodes.UNAVAILABLE, result.message));
	},
	"skills.update": async ({ params, respond }) => {
		if (!validateSkillsUpdateParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`));
			return;
		}
		const p = params;
		const cfg = loadConfig();
		const skills = cfg.skills ? { ...cfg.skills } : {};
		const entries = skills.entries ? { ...skills.entries } : {};
		const current = entries[p.skillKey] ? { ...entries[p.skillKey] } : {};
		if (typeof p.enabled === "boolean") current.enabled = p.enabled;
		if (typeof p.apiKey === "string") {
			const trimmed = normalizeSecretInput(p.apiKey);
			if (trimmed) current.apiKey = trimmed;
			else delete current.apiKey;
		}
		if (p.env && typeof p.env === "object") {
			const nextEnv = current.env ? { ...current.env } : {};
			for (const [key, value] of Object.entries(p.env)) {
				const trimmedKey = key.trim();
				if (!trimmedKey) continue;
				const trimmedVal = value.trim();
				if (!trimmedVal) delete nextEnv[trimmedKey];
				else nextEnv[trimmedKey] = trimmedVal;
			}
			current.env = nextEnv;
		}
		entries[p.skillKey] = current;
		skills.entries = entries;
		await writeConfigFile({
			...cfg,
			skills
		});
		respond(true, {
			ok: true,
			skillKey: p.skillKey,
			config: current
		}, void 0);
	}
};
//#endregion
//#region src/gateway/server/presence-events.ts
function broadcastPresenceSnapshot(params) {
	const presenceVersion = params.incrementPresenceVersion();
	params.broadcast("presence", { presence: listSystemPresence() }, {
		dropIfSlow: true,
		stateVersion: {
			presence: presenceVersion,
			health: params.getHealthVersion()
		}
	});
	return presenceVersion;
}
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
		const text = typeof params.text === "string" ? params.text.trim() : "";
		if (!text) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "text required"));
			return;
		}
		const sessionKey = resolveMainSessionKeyFromConfig();
		const deviceId = typeof params.deviceId === "string" ? params.deviceId : void 0;
		const instanceId = typeof params.instanceId === "string" ? params.instanceId : void 0;
		const host = typeof params.host === "string" ? params.host : void 0;
		const ip = typeof params.ip === "string" ? params.ip : void 0;
		const mode = typeof params.mode === "string" ? params.mode : void 0;
		const version = typeof params.version === "string" ? params.version : void 0;
		const platform = typeof params.platform === "string" ? params.platform : void 0;
		const deviceFamily = typeof params.deviceFamily === "string" ? params.deviceFamily : void 0;
		const modelIdentifier = typeof params.modelIdentifier === "string" ? params.modelIdentifier : void 0;
		const lastInputSeconds = typeof params.lastInputSeconds === "number" && Number.isFinite(params.lastInputSeconds) ? params.lastInputSeconds : void 0;
		const reason = typeof params.reason === "string" ? params.reason : void 0;
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
			const normalizedReason = (reasonValue ?? "").toLowerCase();
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
					const hostLabel = next.host?.trim() || "Unknown";
					const ipLabel = next.ip?.trim();
					parts.push(`Node: ${hostLabel}${ipLabel ? ` (${ipLabel})` : ""}`);
				}
				if (versionChanged) parts.push(`app ${next.version?.trim() || "unknown"}`);
				if (modeChanged) parts.push(`mode ${next.mode?.trim() || "unknown"}`);
				if (reasonChanged) parts.push(`reason ${reasonValue?.trim() || "event"}`);
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
//#region src/gateway/server-methods/talk.ts
const ADMIN_SCOPE$1 = "operator.admin";
const TALK_SECRETS_SCOPE = "operator.talk.secrets";
function canReadTalkSecrets(client) {
	const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
	return scopes.includes(ADMIN_SCOPE$1) || scopes.includes(TALK_SECRETS_SCOPE);
}
const talkHandlers = {
	"talk.config": async ({ params, respond, client }) => {
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
		const configPayload = {};
		const talk = buildTalkConfigResponse(includeSecrets ? snapshot.config.talk : redactConfigObject(snapshot.config.talk));
		if (talk) configPayload.talk = talk;
		const sessionMainKey = snapshot.config.session?.mainKey;
		if (typeof sessionMainKey === "string") configPayload.session = { mainKey: sessionMainKey };
		const seamColor = snapshot.config.ui?.seamColor;
		if (typeof seamColor === "string") configPayload.ui = { seamColor };
		respond(true, { config: configPayload }, void 0);
	},
	"talk.mode": ({ params, respond, context, client, isWebchatConnect }) => {
		if (client && isWebchatConnect(client.connect) && !context.hasConnectedMobileNode()) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "talk disabled: no connected iOS/Android nodes"));
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
//#region src/gateway/server-methods/tools-catalog.ts
function resolveAgentIdOrRespondError(rawAgentId, respond) {
	const cfg = loadConfig();
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
	const pluginTools = resolvePluginTools({
		context: {
			config: params.cfg,
			workspaceDir,
			agentDir,
			agentId: params.agentId
		},
		existingToolNames: params.existingToolNames,
		toolAllowlist: ["group:plugins"],
		suppressNameConflicts: true
	});
	const groups = /* @__PURE__ */ new Map();
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
		existing.tools.push({
			id: tool.name,
			label: typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : tool.name,
			description: typeof tool.description === "string" && tool.description.trim() ? tool.description.trim() : "Plugin tool",
			source: "plugin",
			pluginId,
			optional: meta?.optional,
			defaultProfiles: []
		});
		groups.set(groupId, existing);
	}
	return [...groups.values()].map((group) => ({
		...group,
		tools: group.tools.toSorted((a, b) => a.id.localeCompare(b.id))
	})).toSorted((a, b) => a.label.localeCompare(b.label));
}
const toolsCatalogHandlers = { "tools.catalog": ({ params, respond }) => {
	if (!validateToolsCatalogParams(params)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid tools.catalog params: ${formatValidationErrors(validateToolsCatalogParams.errors)}`));
		return;
	}
	const resolved = resolveAgentIdOrRespondError(params.agentId, respond);
	if (!resolved) return;
	const includePlugins = params.includePlugins !== false;
	const groups = buildCoreGroups();
	if (includePlugins) {
		const existingToolNames = new Set(groups.flatMap((group) => group.tools.map((tool) => tool.id)));
		groups.push(...buildPluginGroups({
			cfg: resolved.cfg,
			agentId: resolved.agentId,
			existingToolNames
		}));
	}
	respond(true, {
		agentId: resolved.agentId,
		profiles: PROFILE_OPTIONS.map((profile) => ({
			id: profile.id,
			label: profile.label
		})),
		groups
	}, void 0);
} };
//#endregion
//#region src/gateway/server-methods/tts.ts
const ttsHandlers = {
	"tts.status": async ({ respond }) => {
		try {
			const config = resolveTtsConfig(loadConfig());
			const prefsPath = resolveTtsPrefsPath(config);
			const provider = getTtsProvider(config, prefsPath);
			const autoMode = resolveTtsAutoMode({
				config,
				prefsPath
			});
			const fallbackProviders = resolveTtsProviderOrder(provider).slice(1).filter((candidate) => isTtsProviderConfigured(config, candidate));
			respond(true, {
				enabled: isTtsEnabled(config, prefsPath),
				auto: autoMode,
				provider,
				fallbackProvider: fallbackProviders[0] ?? null,
				fallbackProviders,
				prefsPath,
				hasOpenAIKey: Boolean(resolveTtsApiKey(config, "openai")),
				hasElevenLabsKey: Boolean(resolveTtsApiKey(config, "elevenlabs")),
				edgeEnabled: isTtsProviderConfigured(config, "edge")
			});
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"tts.enable": async ({ respond }) => {
		try {
			setTtsEnabled(resolveTtsPrefsPath(resolveTtsConfig(loadConfig())), true);
			respond(true, { enabled: true });
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"tts.disable": async ({ respond }) => {
		try {
			setTtsEnabled(resolveTtsPrefsPath(resolveTtsConfig(loadConfig())), false);
			respond(true, { enabled: false });
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"tts.convert": async ({ params, respond }) => {
		const text = typeof params.text === "string" ? params.text.trim() : "";
		if (!text) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "tts.convert requires text"));
			return;
		}
		try {
			const result = await textToSpeech({
				text,
				cfg: loadConfig(),
				channel: typeof params.channel === "string" ? params.channel.trim() : void 0
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
	"tts.setProvider": async ({ params, respond }) => {
		const provider = typeof params.provider === "string" ? params.provider.trim() : "";
		if (provider !== "openai" && provider !== "elevenlabs" && provider !== "edge") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid provider. Use openai, elevenlabs, or edge."));
			return;
		}
		try {
			setTtsProvider(resolveTtsPrefsPath(resolveTtsConfig(loadConfig())), provider);
			respond(true, { provider });
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	},
	"tts.providers": async ({ respond }) => {
		try {
			const config = resolveTtsConfig(loadConfig());
			const prefsPath = resolveTtsPrefsPath(config);
			respond(true, {
				providers: [
					{
						id: "openai",
						name: "OpenAI",
						configured: Boolean(resolveTtsApiKey(config, "openai")),
						models: [...OPENAI_TTS_MODELS],
						voices: [...OPENAI_TTS_VOICES]
					},
					{
						id: "elevenlabs",
						name: "ElevenLabs",
						configured: Boolean(resolveTtsApiKey(config, "elevenlabs")),
						models: [
							"eleven_multilingual_v2",
							"eleven_turbo_v2_5",
							"eleven_monolingual_v1"
						]
					},
					{
						id: "edge",
						name: "Edge TTS",
						configured: isTtsProviderConfigured(config, "edge"),
						models: []
					}
				],
				active: getTtsProvider(config, prefsPath)
			});
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
		}
	}
};
//#endregion
//#region src/gateway/server-methods/update.ts
const updateHandlers = { "update.run": async ({ params, respond, client, context }) => {
	if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) return;
	const actor = resolveControlPlaneActor(client);
	const { sessionKey, note, restartDelayMs } = parseRestartRequestParams(params);
	const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
	const timeoutMsRaw = params.timeoutMs;
	const timeoutMs = typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) ? Math.max(1e3, Math.floor(timeoutMsRaw)) : void 0;
	let result;
	try {
		const configChannel = normalizeUpdateChannel(loadConfig().update?.channel);
		result = await runGatewayUpdate({
			timeoutMs,
			cwd: await resolveOpenClawPackageRoot({
				moduleUrl: import.meta.url,
				argv1: process.argv[1],
				cwd: process.cwd()
			}) ?? process.cwd(),
			argv1: process.argv[1],
			channel: configChannel ?? void 0
		});
	} catch (err) {
		result = {
			status: "error",
			mode: "unknown",
			reason: String(err),
			steps: [],
			durationMs: 0
		};
	}
	const payload = {
		kind: "update",
		status: result.status,
		ts: Date.now(),
		sessionKey,
		deliveryContext,
		threadId,
		message: note ?? null,
		doctorHint: formatDoctorNonInteractiveHint(),
		stats: {
			mode: result.mode,
			root: result.root ?? void 0,
			before: result.before ?? null,
			after: result.after ?? null,
			steps: result.steps.map((step) => ({
				name: step.name,
				command: step.command,
				cwd: step.cwd,
				durationMs: step.durationMs,
				log: {
					stdoutTail: step.stdoutTail ?? null,
					stderrTail: step.stderrTail ?? null,
					exitCode: step.exitCode ?? null
				}
			})),
			reason: result.reason ?? null,
			durationMs: result.durationMs
		}
	};
	let sentinelPath = null;
	try {
		sentinelPath = await writeRestartSentinel(payload);
	} catch {
		sentinelPath = null;
	}
	const restart = result.status === "ok" ? scheduleGatewaySigusr1Restart({
		delayMs: restartDelayMs,
		reason: "update.run",
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
		ok: result.status !== "error",
		result,
		restart,
		sentinel: {
			path: sentinelPath,
			payload
		}
	}, void 0);
} };
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
init_session_key();
const COST_USAGE_CACHE_TTL_MS = 3e4;
const DAY_MS = 1440 * 60 * 1e3;
const costUsageCache = /* @__PURE__ */ new Map();
function resolveSessionUsageFileOrRespond(key, respond) {
	const config = loadConfig();
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
	const storeBySessionId = /* @__PURE__ */ new Map();
	for (const [key, entry] of Object.entries(store)) if (entry?.sessionId) storeBySessionId.set(entry.sessionId, {
		key,
		entry
	});
	return storeBySessionId;
}
async function discoverAllSessionsForUsage(params) {
	const agents = listAgentsForGateway(params.config).agents;
	return (await Promise.all(agents.map(async (agent) => {
		return (await discoverAllSessions({
			agentId: agent.id,
			startMs: params.startMs,
			endMs: params.endMs
		})).map((session) => ({
			...session,
			agentId: agent.id
		}));
	}))).flat().toSorted((a, b) => b.mtime - a.mtime);
}
async function loadCostUsageSummaryCached(params) {
	const cacheKey = `${params.startMs}-${params.endMs}`;
	const now = Date.now();
	const cached = costUsageCache.get(cacheKey);
	if (cached?.summary && cached.updatedAt && now - cached.updatedAt < COST_USAGE_CACHE_TTL_MS) return cached.summary;
	if (cached?.inFlight) {
		if (cached.summary) return cached.summary;
		return await cached.inFlight;
	}
	const entry = cached ?? {};
	const inFlight = loadCostUsageSummary({
		startMs: params.startMs,
		endMs: params.endMs,
		config: params.config
	}).then((summary) => {
		costUsageCache.set(cacheKey, {
			summary,
			updatedAt: Date.now()
		});
		return summary;
	}).catch((err) => {
		if (entry.summary) return entry.summary;
		throw err;
	}).finally(() => {
		const current = costUsageCache.get(cacheKey);
		if (current?.inFlight === inFlight) {
			current.inFlight = void 0;
			costUsageCache.set(cacheKey, current);
		}
	});
	entry.inFlight = inFlight;
	costUsageCache.set(cacheKey, entry);
	if (entry.summary) return entry.summary;
	return await inFlight;
}
const usageHandlers = {
	"usage.status": async ({ respond }) => {
		respond(true, await loadProviderUsageSummary(), void 0);
	},
	"usage.cost": async ({ respond, params }) => {
		const config = loadConfig();
		const { startMs, endMs } = parseDateRange({
			startDate: params?.startDate,
			endDate: params?.endDate,
			days: params?.days,
			mode: params?.mode,
			utcOffset: params?.utcOffset
		});
		respond(true, await loadCostUsageSummaryCached({
			startMs,
			endMs,
			config
		}), void 0);
	},
	"sessions.usage": async ({ respond, params }) => {
		if (!validateSessionsUsageParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid sessions.usage params: ${formatValidationErrors(validateSessionsUsageParams.errors)}`));
			return;
		}
		const p = params;
		const config = loadConfig();
		const { startMs, endMs } = parseDateRange({
			startDate: p.startDate,
			endDate: p.endDate,
			mode: p.mode,
			utcOffset: p.utcOffset
		});
		const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 50;
		const includeContextWeight = p.includeContextWeight ?? false;
		const specificKey = typeof p.key === "string" ? p.key.trim() : null;
		const { storePath, store } = loadCombinedSessionStoreForGateway(config);
		const now = Date.now();
		const mergedEntries = [];
		if (specificKey) {
			const parsed = parseAgentSessionKey(specificKey);
			const agentIdFromKey = parsed?.agentId;
			const keyRest = parsed?.rest ?? specificKey;
			const storeBySessionId = buildStoreBySessionId(store);
			const storeMatch = store[specificKey] ? {
				key: specificKey,
				entry: store[specificKey]
			} : null;
			const storeByIdMatch = storeBySessionId.get(keyRest) ?? null;
			const resolvedStoreKey = storeMatch?.key ?? storeByIdMatch?.key ?? specificKey;
			const storeEntry = storeMatch?.entry ?? storeByIdMatch?.entry;
			const sessionId = storeEntry?.sessionId ?? keyRest;
			let sessionFile;
			try {
				sessionFile = resolveSessionFilePath(sessionId, storeEntry, resolveSessionFilePathOptions({
					storePath: storePath !== "(multiple)" ? storePath : void 0,
					agentId: agentIdFromKey
				}));
			} catch {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session reference: ${specificKey}`));
				return;
			}
			try {
				const stats = fs.statSync(sessionFile);
				if (stats.isFile()) mergedEntries.push({
					key: resolvedStoreKey,
					sessionId,
					sessionFile,
					label: storeEntry?.label,
					updatedAt: storeEntry?.updatedAt ?? stats.mtimeMs,
					storeEntry
				});
			} catch {}
		} else {
			const discoveredSessions = await discoverAllSessionsForUsage({
				config,
				startMs,
				endMs
			});
			const storeBySessionId = buildStoreBySessionId(store);
			for (const discovered of discoveredSessions) {
				const storeMatch = storeBySessionId.get(discovered.sessionId);
				if (storeMatch) mergedEntries.push({
					key: storeMatch.key,
					sessionId: discovered.sessionId,
					sessionFile: discovered.sessionFile,
					label: storeMatch.entry.label,
					updatedAt: storeMatch.entry.updatedAt ?? discovered.mtime,
					storeEntry: storeMatch.entry
				});
				else mergedEntries.push({
					key: `agent:${discovered.agentId}:${discovered.sessionId}`,
					sessionId: discovered.sessionId,
					sessionFile: discovered.sessionFile,
					label: void 0,
					updatedAt: discovered.mtime
				});
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
		for (const merged of limitedEntries) {
			const agentId = parseAgentSessionKey(merged.key)?.agentId;
			const usage = await loadSessionCostSummary({
				sessionId: merged.sessionId,
				sessionEntry: merged.storeEntry,
				sessionFile: merged.sessionFile,
				config,
				agentId,
				startMs,
				endMs
			});
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
				const costDiff = b.totals.totalCost - a.totals.totalCost;
				if (costDiff !== 0) return costDiff;
				return b.totals.totalTokens - a.totals.totalTokens;
			}),
			byProvider: Array.from(byProviderMap.values()).toSorted((a, b) => {
				const costDiff = b.totals.totalCost - a.totals.totalCost;
				if (costDiff !== 0) return costDiff;
				return b.totals.totalTokens - a.totals.totalTokens;
			}),
			byAgent: Array.from(byAgentMap.entries()).map(([id, totals]) => ({
				agentId: id,
				totals
			})).toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
			...tail
		};
		respond(true, {
			updatedAt: now,
			startDate: formatDateStr(startMs),
			endDate: formatDateStr(endMs),
			sessions,
			totals: aggregateTotals,
			aggregates
		}, void 0);
	},
	"sessions.usage.timeseries": async ({ respond, params }) => {
		const key = typeof params?.key === "string" ? params.key.trim() : null;
		if (!key) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "key is required for timeseries"));
			return;
		}
		const resolved = resolveSessionUsageFileOrRespond(key, respond);
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
	"sessions.usage.logs": async ({ respond, params }) => {
		const key = typeof params?.key === "string" ? params.key.trim() : null;
		if (!key) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "key is required for logs"));
			return;
		}
		const limit = typeof params?.limit === "number" && Number.isFinite(params.limit) ? Math.min(params.limit, 1e3) : 200;
		const resolved = resolveSessionUsageFileOrRespond(key, respond);
		if (!resolved) return;
		const { config, entry, agentId, sessionId, sessionFile } = resolved;
		const { loadSessionLogs } = await import("./session-cost-usage-BTFrPrY0.js");
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
const resolveWebLoginProvider = () => listChannelPlugins().find((plugin) => (plugin.gatewayMethods ?? []).some((method) => WEB_LOGIN_METHODS.has(method))) ?? null;
function resolveAccountId(params) {
	return typeof params.accountId === "string" ? params.accountId : void 0;
}
function respondProviderUnavailable(respond) {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "web login provider is not available"));
}
function respondProviderUnsupported(respond, providerId) {
	respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `web login is not supported by provider ${providerId}`));
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
			await context.stopChannel(provider.id, accountId);
			if (!provider.gateway?.loginWithQrStart) {
				respondProviderUnsupported(respond, provider.id);
				return;
			}
			respond(true, await provider.gateway.loginWithQrStart({
				force: Boolean(params.force),
				timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : void 0,
				verbose: Boolean(params.verbose),
				accountId
			}), void 0);
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
				accountId
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
		if (!this.stepDeferred) return;
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
init_runtime();
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
			workspace: typeof params.workspace === "string" ? params.workspace : void 0
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
				await session.answer(String(answer.stepId ?? ""), answer.value);
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
const CONTROL_PLANE_WRITE_METHODS = new Set([
	"config.apply",
	"config.patch",
	"update.run"
]);
function authorizeGatewayMethod(method, client) {
	if (!client?.connect) return null;
	if (method === "health") return null;
	const roleRaw = client.connect.role ?? "operator";
	const role = parseGatewayRole(roleRaw);
	if (!role) return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${roleRaw}`);
	const scopes = client.connect.scopes ?? [];
	if (!isRoleAuthorizedForMethod(role, method)) return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
	if (role === "node") return null;
	if (scopes.includes("operator.admin")) return null;
	const scopeAuth = authorizeOperatorScopesForMethod(method, scopes);
	if (!scopeAuth.allowed) return errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${scopeAuth.missingScope}`);
	return null;
}
const coreGatewayHandlers = {
	...connectHandlers,
	...logsHandlers,
	...voicewakeHandlers,
	...healthHandlers,
	...channelsHandlers,
	...chatHandlers,
	...cronHandlers,
	...deviceHandlers,
	...doctorHandlers,
	...execApprovalsHandlers,
	...webHandlers,
	...modelsHandlers,
	...configHandlers,
	...wizardHandlers,
	...talkHandlers,
	...toolsCatalogHandlers,
	...ttsHandlers,
	...skillsHandlers,
	...sessionsHandlers,
	...systemHandlers,
	...updateHandlers,
	...nodeHandlers,
	...nodePendingHandlers,
	...pushHandlers,
	...sendHandlers,
	...usageHandlers,
	...agentHandlers,
	...agentsHandlers,
	...browserHandlers
};
async function handleGatewayRequest(opts) {
	const { req, respond, client, isWebchatConnect, context } = opts;
	const authError = authorizeGatewayMethod(req.method, client);
	if (authError) {
		respond(false, void 0, authError);
		return;
	}
	if (CONTROL_PLANE_WRITE_METHODS.has(req.method)) {
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
	const handler = opts.extraHandlers?.[req.method] ?? coreGatewayHandlers[req.method];
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
//#region src/gateway/server-methods/exec-approval.ts
function createExecApprovalHandlers(manager, opts) {
	return {
		"exec.approval.request": async ({ params, respond, context, client }) => {
			if (!validateExecApprovalRequestParams(params)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid exec.approval.request params: ${formatValidationErrors(validateExecApprovalRequestParams.errors)}`));
				return;
			}
			const p = params;
			const twoPhase = p.twoPhase === true;
			const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
			const explicitId = typeof p.id === "string" && p.id.trim().length > 0 ? p.id.trim() : null;
			const host = typeof p.host === "string" ? p.host.trim() : "";
			const nodeId = typeof p.nodeId === "string" ? p.nodeId.trim() : "";
			const approvalContext = resolveSystemRunApprovalRequestContext({
				host,
				command: p.command,
				commandArgv: p.commandArgv,
				systemRunPlan: p.systemRunPlan,
				cwd: p.cwd,
				agentId: p.agentId,
				sessionKey: p.sessionKey
			});
			const effectiveCommandArgv = approvalContext.commandArgv;
			const effectiveCwd = approvalContext.cwd;
			const effectiveAgentId = approvalContext.agentId;
			const effectiveSessionKey = approvalContext.sessionKey;
			const effectiveCommandText = approvalContext.commandText;
			if (host === "node" && !nodeId) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId is required for host=node"));
				return;
			}
			if (host === "node" && !approvalContext.plan) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "systemRunPlan is required for host=node"));
				return;
			}
			if (!effectiveCommandText) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "command is required"));
				return;
			}
			if (host === "node" && (!Array.isArray(effectiveCommandArgv) || effectiveCommandArgv.length === 0)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "commandArgv is required for host=node"));
				return;
			}
			const systemRunBinding = host === "node" ? buildSystemRunApprovalBinding({
				argv: effectiveCommandArgv,
				cwd: effectiveCwd,
				agentId: effectiveAgentId,
				sessionKey: effectiveSessionKey,
				env: p.env
			}) : null;
			if (explicitId && manager.getSnapshot(explicitId)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"));
				return;
			}
			const request = {
				command: sanitizeExecApprovalDisplayText(effectiveCommandText),
				commandPreview: host === "node" || !approvalContext.commandPreview ? void 0 : sanitizeExecApprovalDisplayText(approvalContext.commandPreview),
				commandArgv: host === "node" ? void 0 : effectiveCommandArgv,
				envKeys: systemRunBinding?.envKeys?.length ? systemRunBinding.envKeys : void 0,
				systemRunBinding: systemRunBinding?.binding ?? null,
				systemRunPlan: approvalContext.plan,
				cwd: effectiveCwd ?? null,
				nodeId: host === "node" ? nodeId : null,
				host: host || null,
				security: p.security ?? null,
				ask: p.ask ?? null,
				agentId: effectiveAgentId ?? null,
				resolvedPath: p.resolvedPath ?? null,
				sessionKey: effectiveSessionKey ?? null,
				turnSourceChannel: typeof p.turnSourceChannel === "string" ? p.turnSourceChannel.trim() || null : null,
				turnSourceTo: typeof p.turnSourceTo === "string" ? p.turnSourceTo.trim() || null : null,
				turnSourceAccountId: typeof p.turnSourceAccountId === "string" ? p.turnSourceAccountId.trim() || null : null,
				turnSourceThreadId: p.turnSourceThreadId ?? null
			};
			const record = manager.create(request, timeoutMs, explicitId);
			record.requestedByConnId = client?.connId ?? null;
			record.requestedByDeviceId = client?.connect?.device?.id ?? null;
			record.requestedByClientId = client?.connect?.client?.id ?? null;
			let decisionPromise;
			try {
				decisionPromise = manager.register(record, timeoutMs);
			} catch (err) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `registration failed: ${String(err)}`));
				return;
			}
			context.broadcast("exec.approval.requested", {
				id: record.id,
				request: record.request,
				createdAtMs: record.createdAtMs,
				expiresAtMs: record.expiresAtMs
			}, { dropIfSlow: true });
			const hasExecApprovalClients = context.hasExecApprovalClients?.() ?? false;
			let forwarded = false;
			if (opts?.forwarder) try {
				forwarded = await opts.forwarder.handleRequested({
					id: record.id,
					request: record.request,
					createdAtMs: record.createdAtMs,
					expiresAtMs: record.expiresAtMs
				});
			} catch (err) {
				context.logGateway?.error?.(`exec approvals: forward request failed: ${String(err)}`);
			}
			if (!hasExecApprovalClients && !forwarded) {
				manager.expire(record.id, "no-approval-route");
				respond(true, {
					id: record.id,
					decision: null,
					createdAtMs: record.createdAtMs,
					expiresAtMs: record.expiresAtMs
				}, void 0);
				return;
			}
			if (twoPhase) respond(true, {
				status: "accepted",
				id: record.id,
				createdAtMs: record.createdAtMs,
				expiresAtMs: record.expiresAtMs
			}, void 0);
			const decision = await decisionPromise;
			respond(true, {
				id: record.id,
				decision,
				createdAtMs: record.createdAtMs,
				expiresAtMs: record.expiresAtMs
			}, void 0);
		},
		"exec.approval.waitDecision": async ({ params, respond }) => {
			const p = params;
			const id = typeof p.id === "string" ? p.id.trim() : "";
			if (!id) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
				return;
			}
			const decisionPromise = manager.awaitDecision(id);
			if (!decisionPromise) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"));
				return;
			}
			const snapshot = manager.getSnapshot(id);
			respond(true, {
				id,
				decision: await decisionPromise,
				createdAtMs: snapshot?.createdAtMs,
				expiresAtMs: snapshot?.expiresAtMs
			}, void 0);
		},
		"exec.approval.resolve": async ({ params, respond, client, context }) => {
			if (!validateExecApprovalResolveParams(params)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid exec.approval.resolve params: ${formatValidationErrors(validateExecApprovalResolveParams.errors)}`));
				return;
			}
			const p = params;
			const decision = p.decision;
			if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
				return;
			}
			const resolvedId = manager.lookupPendingId(p.id);
			if (resolvedId.kind === "none") {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id"));
				return;
			}
			if (resolvedId.kind === "ambiguous") {
				const candidates = resolvedId.ids.slice(0, 3).join(", ");
				const remainder = resolvedId.ids.length > 3 ? ` (+${resolvedId.ids.length - 3} more)` : "";
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `ambiguous approval id prefix; matches: ${candidates}${remainder}. Use the full id.`));
				return;
			}
			const approvalId = resolvedId.id;
			const snapshot = manager.getSnapshot(approvalId);
			const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
			if (!manager.resolve(approvalId, decision, resolvedBy ?? null)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id"));
				return;
			}
			context.broadcast("exec.approval.resolved", {
				id: approvalId,
				decision,
				resolvedBy,
				ts: Date.now(),
				request: snapshot?.request
			}, { dropIfSlow: true });
			opts?.forwarder?.handleResolved({
				id: approvalId,
				decision,
				resolvedBy,
				ts: Date.now(),
				request: snapshot?.request
			}).catch((err) => {
				context.logGateway?.error?.(`exec approvals: forward resolve failed: ${String(err)}`);
			});
			respond(true, { ok: true }, void 0);
		}
	};
}
//#endregion
//#region src/gateway/server-methods/secrets.ts
function invalidSecretsResolveField(errors) {
	for (const issue of errors ?? []) if (issue.instancePath === "/commandName" || issue.instancePath === "" && String(issue.params?.missingProperty) === "commandName") return "commandName";
	return "targetIds";
}
function createSecretsHandlers(params) {
	return {
		"secrets.reload": async ({ respond }) => {
			try {
				respond(true, {
					ok: true,
					warningCount: (await params.reloadSecrets()).warningCount
				});
			} catch (err) {
				respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
			}
		},
		"secrets.resolve": async ({ params: requestParams, respond }) => {
			if (!validateSecretsResolveParams(requestParams)) {
				const field = invalidSecretsResolveField(validateSecretsResolveParams.errors);
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid secrets.resolve params: ${field}`));
				return;
			}
			const commandName = requestParams.commandName.trim();
			if (!commandName) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid secrets.resolve params: commandName"));
				return;
			}
			const targetIds = requestParams.targetIds.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
			for (const targetId of targetIds) if (!isKnownSecretTargetId(targetId)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid secrets.resolve params: unknown target id "${String(targetId)}"`));
				return;
			}
			try {
				const result = await params.resolveSecrets({
					commandName,
					targetIds
				});
				const payload = {
					ok: true,
					assignments: result.assignments,
					diagnostics: result.diagnostics,
					inactiveRefPaths: result.inactiveRefPaths
				};
				if (!validateSecretsResolveResult(payload)) throw new Error("secrets.resolve returned invalid payload.");
				respond(true, payload);
			} catch (err) {
				respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
			}
		}
	};
}
//#endregion
//#region src/gateway/server-mobile-nodes.ts
const isMobilePlatform = (platform) => {
	const p = typeof platform === "string" ? platform.trim().toLowerCase() : "";
	if (!p) return false;
	return p.startsWith("ios") || p.startsWith("ipados") || p.startsWith("android");
};
function hasConnectedMobileNode(registry) {
	return registry.listConnected().some((n) => isMobilePlatform(n.platform));
}
//#endregion
//#region src/gateway/server-model-catalog.ts
async function loadGatewayModelCatalog() {
	return await loadModelCatalog({ config: loadConfig() });
}
//#endregion
//#region src/gateway/server-node-subscriptions.ts
function createNodeSubscriptionManager() {
	const nodeSubscriptions = /* @__PURE__ */ new Map();
	const sessionSubscribers = /* @__PURE__ */ new Map();
	const toPayloadJSON = (payload) => payload ? JSON.stringify(payload) : null;
	const subscribe = (nodeId, sessionKey) => {
		const normalizedNodeId = nodeId.trim();
		const normalizedSessionKey = sessionKey.trim();
		if (!normalizedNodeId || !normalizedSessionKey) return;
		let nodeSet = nodeSubscriptions.get(normalizedNodeId);
		if (!nodeSet) {
			nodeSet = /* @__PURE__ */ new Set();
			nodeSubscriptions.set(normalizedNodeId, nodeSet);
		}
		if (nodeSet.has(normalizedSessionKey)) return;
		nodeSet.add(normalizedSessionKey);
		let sessionSet = sessionSubscribers.get(normalizedSessionKey);
		if (!sessionSet) {
			sessionSet = /* @__PURE__ */ new Set();
			sessionSubscribers.set(normalizedSessionKey, sessionSet);
		}
		sessionSet.add(normalizedNodeId);
	};
	const unsubscribe = (nodeId, sessionKey) => {
		const normalizedNodeId = nodeId.trim();
		const normalizedSessionKey = sessionKey.trim();
		if (!normalizedNodeId || !normalizedSessionKey) return;
		const nodeSet = nodeSubscriptions.get(normalizedNodeId);
		nodeSet?.delete(normalizedSessionKey);
		if (nodeSet?.size === 0) nodeSubscriptions.delete(normalizedNodeId);
		const sessionSet = sessionSubscribers.get(normalizedSessionKey);
		sessionSet?.delete(normalizedNodeId);
		if (sessionSet?.size === 0) sessionSubscribers.delete(normalizedSessionKey);
	};
	const unsubscribeAll = (nodeId) => {
		const normalizedNodeId = nodeId.trim();
		const nodeSet = nodeSubscriptions.get(normalizedNodeId);
		if (!nodeSet) return;
		for (const sessionKey of nodeSet) {
			const sessionSet = sessionSubscribers.get(sessionKey);
			sessionSet?.delete(normalizedNodeId);
			if (sessionSet?.size === 0) sessionSubscribers.delete(sessionKey);
		}
		nodeSubscriptions.delete(normalizedNodeId);
	};
	const sendToSession = (sessionKey, event, payload, sendEvent) => {
		const normalizedSessionKey = sessionKey.trim();
		if (!normalizedSessionKey || !sendEvent) return;
		const subs = sessionSubscribers.get(normalizedSessionKey);
		if (!subs || subs.size === 0) return;
		const payloadJSON = toPayloadJSON(payload);
		for (const nodeId of subs) sendEvent({
			nodeId,
			event,
			payloadJSON
		});
	};
	const sendToAllSubscribed = (event, payload, sendEvent) => {
		if (!sendEvent) return;
		const payloadJSON = toPayloadJSON(payload);
		for (const nodeId of nodeSubscriptions.keys()) sendEvent({
			nodeId,
			event,
			payloadJSON
		});
	};
	const sendToAllConnected = (event, payload, listConnected, sendEvent) => {
		if (!sendEvent || !listConnected) return;
		const payloadJSON = toPayloadJSON(payload);
		for (const node of listConnected()) sendEvent({
			nodeId: node.nodeId,
			event,
			payloadJSON
		});
	};
	const clear = () => {
		nodeSubscriptions.clear();
		sessionSubscribers.clear();
	};
	return {
		subscribe,
		unsubscribe,
		unsubscribeAll,
		sendToSession,
		sendToAllSubscribed,
		sendToAllConnected,
		clear
	};
}
//#endregion
//#region src/gateway/server-plugins.ts
const FALLBACK_GATEWAY_CONTEXT_STATE_KEY = Symbol.for("openclaw.fallbackGatewayContextState");
const fallbackGatewayContextState = (() => {
	const globalState = globalThis;
	const existing = globalState[FALLBACK_GATEWAY_CONTEXT_STATE_KEY];
	if (existing) return existing;
	const created = { context: void 0 };
	globalState[FALLBACK_GATEWAY_CONTEXT_STATE_KEY] = created;
	return created;
})();
function setFallbackGatewayContext(ctx) {
	fallbackGatewayContextState.context = ctx;
}
function createSyntheticOperatorClient() {
	return { connect: {
		minProtocol: 3,
		maxProtocol: 3,
		client: {
			id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
			version: "internal",
			platform: "node",
			mode: GATEWAY_CLIENT_MODES.BACKEND
		},
		role: "operator",
		scopes: [
			"operator.admin",
			"operator.approvals",
			"operator.pairing"
		]
	} };
}
async function dispatchGatewayMethod(method, params) {
	const scope = getPluginRuntimeGatewayRequestScope();
	const context = scope?.context ?? fallbackGatewayContextState.context;
	const isWebchatConnect = scope?.isWebchatConnect ?? (() => false);
	if (!context) throw new Error(`Plugin subagent dispatch requires a gateway request scope (method: ${method}). No scope set and no fallback context available.`);
	let result;
	await handleGatewayRequest({
		req: {
			type: "req",
			id: `plugin-subagent-${randomUUID()}`,
			method,
			params
		},
		client: scope?.client ?? createSyntheticOperatorClient(),
		isWebchatConnect,
		respond: (ok, payload, error) => {
			if (!result) result = {
				ok,
				payload,
				error
			};
		},
		context
	});
	if (!result) throw new Error(`Gateway method "${method}" completed without a response.`);
	if (!result.ok) throw new Error(result.error?.message ?? `Gateway method "${method}" failed.`);
	return result.payload;
}
function createGatewaySubagentRuntime() {
	const getSessionMessages = async (params) => {
		const payload = await dispatchGatewayMethod("sessions.get", {
			key: params.sessionKey,
			...params.limit != null && { limit: params.limit }
		});
		return { messages: Array.isArray(payload?.messages) ? payload.messages : [] };
	};
	return {
		async run(params) {
			const runId = (await dispatchGatewayMethod("agent", {
				sessionKey: params.sessionKey,
				message: params.message,
				deliver: params.deliver ?? false,
				...params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt },
				...params.lane && { lane: params.lane },
				...params.idempotencyKey && { idempotencyKey: params.idempotencyKey }
			}))?.runId;
			if (typeof runId !== "string" || !runId) throw new Error("Gateway agent method returned an invalid runId.");
			return { runId };
		},
		async waitForRun(params) {
			const payload = await dispatchGatewayMethod("agent.wait", {
				runId: params.runId,
				...params.timeoutMs != null && { timeoutMs: params.timeoutMs }
			});
			const status = payload?.status;
			if (status !== "ok" && status !== "error" && status !== "timeout") throw new Error(`Gateway agent.wait returned unexpected status: ${status}`);
			return {
				status,
				...typeof payload?.error === "string" && payload.error && { error: payload.error }
			};
		},
		getSessionMessages,
		async getSession(params) {
			return getSessionMessages(params);
		},
		async deleteSession(params) {
			await dispatchGatewayMethod("sessions.delete", {
				key: params.sessionKey,
				deleteTranscript: params.deleteTranscript ?? true
			});
		}
	};
}
function loadGatewayPlugins(params) {
	const pluginRegistry = loadOpenClawPlugins({
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		logger: {
			info: (msg) => params.log.info(msg),
			warn: (msg) => params.log.warn(msg),
			error: (msg) => params.log.error(msg),
			debug: (msg) => params.log.debug(msg)
		},
		coreGatewayHandlers: params.coreGatewayHandlers,
		runtimeOptions: { subagent: createGatewaySubagentRuntime() },
		preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins
	});
	const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
	const gatewayMethods = Array.from(new Set([...params.baseMethods, ...pluginMethods]));
	if ((params.logDiagnostics ?? true) && pluginRegistry.diagnostics.length > 0) for (const diag of pluginRegistry.diagnostics) {
		const details = [diag.pluginId ? `plugin=${diag.pluginId}` : null, diag.source ? `source=${diag.source}` : null].filter((entry) => Boolean(entry)).join(", ");
		const message = details ? `[plugins] ${diag.message} (${details})` : `[plugins] ${diag.message}`;
		if (diag.level === "error") params.log.error(message);
		else params.log.info(message);
	}
	return {
		pluginRegistry,
		gatewayMethods
	};
}
//#endregion
//#region src/hooks/gmail-watcher-lifecycle.ts
async function startGmailWatcherWithLogs(params) {
	if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_GMAIL_WATCHER)) {
		params.onSkipped?.();
		return;
	}
	try {
		const gmailResult = await startGmailWatcher(params.cfg);
		if (gmailResult.started) {
			params.log.info("gmail watcher started");
			return;
		}
		if (gmailResult.reason && gmailResult.reason !== "hooks not enabled" && gmailResult.reason !== "no gmail account configured") params.log.warn(`gmail watcher not started: ${gmailResult.reason}`);
	} catch (err) {
		params.log.error(`gmail watcher failed to start: ${String(err)}`);
	}
}
//#endregion
//#region src/hooks/module-loader.ts
function resolveFileModuleUrl(params) {
	const url = pathToFileURL(params.modulePath).href;
	if (!params.cacheBust) return url;
	return `${url}?t=${params.nowMs ?? Date.now()}`;
}
async function importFileModule(params) {
	return await import(resolveFileModuleUrl(params));
}
function resolveFunctionModuleExport(params) {
	const explicitExport = params.exportName?.trim();
	if (explicitExport) {
		const candidate = params.mod[explicitExport];
		return typeof candidate === "function" ? candidate : void 0;
	}
	const fallbacks = params.fallbackExportNames ?? ["default"];
	for (const exportName of fallbacks) {
		const candidate = params.mod[exportName];
		if (typeof candidate === "function") return candidate;
	}
}
//#endregion
//#region src/gateway/hooks-mapping.ts
const hookPresetMappings = { gmail: [{
	id: "gmail",
	match: { path: "gmail" },
	action: "agent",
	wakeMode: "now",
	name: "Gmail",
	sessionKey: "hook:gmail:{{messages[0].id}}",
	messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}"
}] };
const transformCache = /* @__PURE__ */ new Map();
function resolveHookMappings(hooks, opts) {
	const presets = hooks?.presets ?? [];
	const gmailAllowUnsafe = hooks?.gmail?.allowUnsafeExternalContent;
	const mappings = [];
	if (hooks?.mappings) mappings.push(...hooks.mappings);
	for (const preset of presets) {
		const presetMappings = hookPresetMappings[preset];
		if (!presetMappings) continue;
		if (preset === "gmail" && typeof gmailAllowUnsafe === "boolean") {
			mappings.push(...presetMappings.map((mapping) => ({
				...mapping,
				allowUnsafeExternalContent: gmailAllowUnsafe
			})));
			continue;
		}
		mappings.push(...presetMappings);
	}
	if (mappings.length === 0) return [];
	const configDir = path.resolve(opts?.configDir ?? path.dirname(CONFIG_PATH));
	const transformsDir = resolveOptionalContainedPath(path.join(configDir, "hooks", "transforms"), hooks?.transformsDir, "Hook transformsDir");
	return mappings.map((mapping, index) => normalizeHookMapping(mapping, index, transformsDir));
}
async function applyHookMappings(mappings, ctx) {
	if (mappings.length === 0) return null;
	for (const mapping of mappings) {
		if (!mappingMatches(mapping, ctx)) continue;
		const base = buildActionFromMapping(mapping, ctx);
		if (!base.ok) return base;
		let override = null;
		if (mapping.transform) {
			override = await (await loadTransform(mapping.transform))(ctx);
			if (override === null) return {
				ok: true,
				action: null,
				skipped: true
			};
		}
		if (!base.action) return {
			ok: true,
			action: null,
			skipped: true
		};
		const merged = mergeAction(base.action, override, mapping.action);
		if (!merged.ok) return merged;
		return merged;
	}
	return null;
}
function normalizeHookMapping(mapping, index, transformsDir) {
	const id = mapping.id?.trim() || `mapping-${index + 1}`;
	const matchPath = normalizeMatchPath(mapping.match?.path);
	const matchSource = mapping.match?.source?.trim();
	const action = mapping.action ?? "agent";
	const wakeMode = mapping.wakeMode ?? "now";
	const transform = mapping.transform ? {
		modulePath: resolveContainedPath(transformsDir, mapping.transform.module, "Hook transform"),
		exportName: mapping.transform.export?.trim() || void 0
	} : void 0;
	return {
		id,
		matchPath,
		matchSource,
		action,
		wakeMode,
		name: mapping.name,
		agentId: mapping.agentId?.trim() || void 0,
		sessionKey: mapping.sessionKey,
		messageTemplate: mapping.messageTemplate,
		textTemplate: mapping.textTemplate,
		deliver: mapping.deliver,
		allowUnsafeExternalContent: mapping.allowUnsafeExternalContent,
		channel: mapping.channel,
		to: mapping.to,
		model: mapping.model,
		thinking: mapping.thinking,
		timeoutSeconds: mapping.timeoutSeconds,
		transform
	};
}
function mappingMatches(mapping, ctx) {
	if (mapping.matchPath) {
		if (mapping.matchPath !== normalizeMatchPath(ctx.path)) return false;
	}
	if (mapping.matchSource) {
		const source = typeof ctx.payload.source === "string" ? ctx.payload.source : void 0;
		if (!source || source !== mapping.matchSource) return false;
	}
	return true;
}
function buildActionFromMapping(mapping, ctx) {
	if (mapping.action === "wake") return {
		ok: true,
		action: {
			kind: "wake",
			text: renderTemplate(mapping.textTemplate ?? "", ctx),
			mode: mapping.wakeMode ?? "now"
		}
	};
	return {
		ok: true,
		action: {
			kind: "agent",
			message: renderTemplate(mapping.messageTemplate ?? "", ctx),
			name: renderOptional(mapping.name, ctx),
			agentId: mapping.agentId,
			wakeMode: mapping.wakeMode ?? "now",
			sessionKey: renderOptional(mapping.sessionKey, ctx),
			deliver: mapping.deliver,
			allowUnsafeExternalContent: mapping.allowUnsafeExternalContent,
			channel: mapping.channel,
			to: renderOptional(mapping.to, ctx),
			model: renderOptional(mapping.model, ctx),
			thinking: renderOptional(mapping.thinking, ctx),
			timeoutSeconds: mapping.timeoutSeconds
		}
	};
}
function mergeAction(base, override, defaultAction) {
	if (!override) return validateAction(base);
	if ((override.kind ?? base.kind ?? defaultAction) === "wake") {
		const baseWake = base.kind === "wake" ? base : void 0;
		return validateAction({
			kind: "wake",
			text: typeof override.text === "string" ? override.text : baseWake?.text ?? "",
			mode: override.mode === "next-heartbeat" ? "next-heartbeat" : baseWake?.mode ?? "now"
		});
	}
	const baseAgent = base.kind === "agent" ? base : void 0;
	return validateAction({
		kind: "agent",
		message: typeof override.message === "string" ? override.message : baseAgent?.message ?? "",
		wakeMode: override.wakeMode === "next-heartbeat" ? "next-heartbeat" : baseAgent?.wakeMode ?? "now",
		name: override.name ?? baseAgent?.name,
		agentId: override.agentId ?? baseAgent?.agentId,
		sessionKey: override.sessionKey ?? baseAgent?.sessionKey,
		deliver: typeof override.deliver === "boolean" ? override.deliver : baseAgent?.deliver,
		allowUnsafeExternalContent: typeof override.allowUnsafeExternalContent === "boolean" ? override.allowUnsafeExternalContent : baseAgent?.allowUnsafeExternalContent,
		channel: override.channel ?? baseAgent?.channel,
		to: override.to ?? baseAgent?.to,
		model: override.model ?? baseAgent?.model,
		thinking: override.thinking ?? baseAgent?.thinking,
		timeoutSeconds: override.timeoutSeconds ?? baseAgent?.timeoutSeconds
	});
}
function validateAction(action) {
	if (action.kind === "wake") {
		if (!action.text?.trim()) return {
			ok: false,
			error: "hook mapping requires text"
		};
		return {
			ok: true,
			action
		};
	}
	if (!action.message?.trim()) return {
		ok: false,
		error: "hook mapping requires message"
	};
	return {
		ok: true,
		action
	};
}
async function loadTransform(transform) {
	const cacheKey = `${transform.modulePath}::${transform.exportName ?? "default"}`;
	const cached = transformCache.get(cacheKey);
	if (cached) return cached;
	const fn = resolveTransformFn(await importFileModule({ modulePath: transform.modulePath }), transform.exportName);
	transformCache.set(cacheKey, fn);
	return fn;
}
function resolveTransformFn(mod, exportName) {
	const candidate = resolveFunctionModuleExport({
		mod,
		exportName,
		fallbackExportNames: ["default", "transform"]
	});
	if (!candidate) throw new Error("hook transform module must export a function");
	return candidate;
}
function resolvePath(baseDir, target) {
	if (!target) return path.resolve(baseDir);
	return path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir, target);
}
function escapesBase(baseDir, candidate) {
	const relative = path.relative(baseDir, candidate);
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
function safeRealpathSync(candidate) {
	try {
		const nativeRealpath = fs.realpathSync.native;
		return nativeRealpath ? nativeRealpath(candidate) : fs.realpathSync(candidate);
	} catch {
		return null;
	}
}
function resolveExistingAncestor(candidate) {
	let current = path.resolve(candidate);
	while (true) {
		if (fs.existsSync(current)) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
function resolveContainedPath(baseDir, target, label) {
	const base = path.resolve(baseDir);
	const trimmed = target?.trim();
	if (!trimmed) throw new Error(`${label} module path is required`);
	const resolved = resolvePath(base, trimmed);
	if (escapesBase(base, resolved)) throw new Error(`${label} module path must be within ${base}: ${target}`);
	const baseRealpath = safeRealpathSync(base);
	const existingAncestor = resolveExistingAncestor(resolved);
	const existingAncestorRealpath = existingAncestor ? safeRealpathSync(existingAncestor) : null;
	if (baseRealpath && existingAncestorRealpath && escapesBase(baseRealpath, existingAncestorRealpath)) throw new Error(`${label} module path must be within ${base}: ${target}`);
	return resolved;
}
function resolveOptionalContainedPath(baseDir, target, label) {
	const trimmed = target?.trim();
	if (!trimmed) return path.resolve(baseDir);
	return resolveContainedPath(baseDir, trimmed, label);
}
function normalizeMatchPath(raw) {
	if (!raw) return;
	const trimmed = raw.trim();
	if (!trimmed) return;
	return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}
function renderOptional(value, ctx) {
	if (!value) return;
	const rendered = renderTemplate(value, ctx).trim();
	return rendered ? rendered : void 0;
}
function renderTemplate(template, ctx) {
	if (!template) return "";
	return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr) => {
		const value = resolveTemplateExpr(expr.trim(), ctx);
		if (value === void 0 || value === null) return "";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		return JSON.stringify(value);
	});
}
function resolveTemplateExpr(expr, ctx) {
	if (expr === "path") return ctx.path;
	if (expr === "now") return (/* @__PURE__ */ new Date()).toISOString();
	if (expr.startsWith("headers.")) return getByPath(ctx.headers, expr.slice(8));
	if (expr.startsWith("query.")) return getByPath(Object.fromEntries(ctx.url.searchParams.entries()), expr.slice(6));
	if (expr.startsWith("payload.")) return getByPath(ctx.payload, expr.slice(8));
	return getByPath(ctx.payload, expr);
}
const BLOCKED_PATH_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function getByPath(input, pathExpr) {
	if (!pathExpr) return;
	const parts = [];
	const re = /([^.[\]]+)|(\[(\d+)\])/g;
	let match = re.exec(pathExpr);
	while (match) {
		if (match[1]) parts.push(match[1]);
		else if (match[3]) parts.push(Number(match[3]));
		match = re.exec(pathExpr);
	}
	let current = input;
	for (const part of parts) {
		if (current === null || current === void 0) return;
		if (typeof part === "number") {
			if (!Array.isArray(current)) return;
			current = current[part];
			continue;
		}
		if (BLOCKED_PATH_KEYS.has(part)) return;
		if (typeof current !== "object") return;
		current = current[part];
	}
	return current;
}
//#endregion
//#region src/gateway/hooks.ts
init_session_key();
const DEFAULT_HOOKS_PATH = "/hooks";
const DEFAULT_HOOKS_MAX_BODY_BYTES = 256 * 1024;
const MAX_HOOK_IDEMPOTENCY_KEY_LENGTH = 256;
function resolveHooksConfig(cfg) {
	if (cfg.hooks?.enabled !== true) return null;
	const token = cfg.hooks?.token?.trim();
	if (!token) throw new Error("hooks.enabled requires hooks.token");
	const rawPath = cfg.hooks?.path?.trim() || DEFAULT_HOOKS_PATH;
	const withSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
	const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
	if (trimmed === "/") throw new Error("hooks.path may not be '/'");
	const maxBodyBytes = cfg.hooks?.maxBodyBytes && cfg.hooks.maxBodyBytes > 0 ? cfg.hooks.maxBodyBytes : DEFAULT_HOOKS_MAX_BODY_BYTES;
	const mappings = resolveHookMappings(cfg.hooks);
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const knownAgentIds = resolveKnownAgentIds(cfg, defaultAgentId);
	const allowedAgentIds = resolveAllowedAgentIds(cfg.hooks?.allowedAgentIds);
	const defaultSessionKey = resolveSessionKey$1(cfg.hooks?.defaultSessionKey);
	const allowedSessionKeyPrefixes = resolveAllowedSessionKeyPrefixes(cfg.hooks?.allowedSessionKeyPrefixes);
	if (defaultSessionKey && allowedSessionKeyPrefixes && !isSessionKeyAllowedByPrefix(defaultSessionKey, allowedSessionKeyPrefixes)) throw new Error("hooks.defaultSessionKey must match hooks.allowedSessionKeyPrefixes");
	if (!defaultSessionKey && allowedSessionKeyPrefixes && !isSessionKeyAllowedByPrefix("hook:example", allowedSessionKeyPrefixes)) throw new Error("hooks.allowedSessionKeyPrefixes must include 'hook:' when hooks.defaultSessionKey is unset");
	return {
		basePath: trimmed,
		token,
		maxBodyBytes,
		mappings,
		agentPolicy: {
			defaultAgentId,
			knownAgentIds,
			allowedAgentIds
		},
		sessionPolicy: {
			defaultSessionKey,
			allowRequestSessionKey: cfg.hooks?.allowRequestSessionKey === true,
			allowedSessionKeyPrefixes
		}
	};
}
function resolveKnownAgentIds(cfg, defaultAgentId) {
	const known = new Set(listAgentIds(cfg));
	known.add(defaultAgentId);
	return known;
}
function resolveSessionKey$1(raw) {
	const value = raw?.trim();
	return value ? value : void 0;
}
function normalizeSessionKeyPrefix(raw) {
	const value = raw.trim().toLowerCase();
	return value ? value : void 0;
}
function resolveAllowedSessionKeyPrefixes(raw) {
	if (!Array.isArray(raw)) return;
	const set = /* @__PURE__ */ new Set();
	for (const prefix of raw) {
		const normalized = normalizeSessionKeyPrefix(prefix);
		if (!normalized) continue;
		set.add(normalized);
	}
	return set.size > 0 ? Array.from(set) : void 0;
}
function isSessionKeyAllowedByPrefix(sessionKey, prefixes) {
	const normalized = sessionKey.trim().toLowerCase();
	if (!normalized) return false;
	return prefixes.some((prefix) => normalized.startsWith(prefix));
}
function extractHookToken(req) {
	const auth = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
	if (auth.toLowerCase().startsWith("bearer ")) {
		const token = auth.slice(7).trim();
		if (token) return token;
	}
	const headerToken = typeof req.headers["x-openclaw-token"] === "string" ? req.headers["x-openclaw-token"].trim() : "";
	if (headerToken) return headerToken;
}
async function readJsonBody(req, maxBytes) {
	const result = await readJsonBodyWithLimit(req, {
		maxBytes,
		emptyObjectOnEmpty: true
	});
	if (result.ok) return result;
	if (result.code === "PAYLOAD_TOO_LARGE") return {
		ok: false,
		error: "payload too large"
	};
	if (result.code === "REQUEST_BODY_TIMEOUT") return {
		ok: false,
		error: "request body timeout"
	};
	if (result.code === "CONNECTION_CLOSED") return {
		ok: false,
		error: requestBodyErrorToText("CONNECTION_CLOSED")
	};
	return {
		ok: false,
		error: result.error
	};
}
function normalizeHookHeaders(req) {
	const headers = {};
	for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers[key.toLowerCase()] = value;
	else if (Array.isArray(value) && value.length > 0) headers[key.toLowerCase()] = value.join(", ");
	return headers;
}
function normalizeWakePayload(payload) {
	const text = typeof payload.text === "string" ? payload.text.trim() : "";
	if (!text) return {
		ok: false,
		error: "text required"
	};
	return {
		ok: true,
		value: {
			text,
			mode: payload.mode === "next-heartbeat" ? "next-heartbeat" : "now"
		}
	};
}
const listHookChannelValues = () => ["last", ...listChannelPlugins().map((plugin) => plugin.id)];
const getHookChannelSet = () => new Set(listHookChannelValues());
const getHookChannelError = () => `channel must be ${listHookChannelValues().join("|")}`;
function resolveHookChannel(raw) {
	if (raw === void 0) return "last";
	if (typeof raw !== "string") return null;
	const normalized = normalizeMessageChannel(raw);
	if (!normalized || !getHookChannelSet().has(normalized)) return null;
	return normalized;
}
function resolveHookDeliver(raw) {
	return raw !== false;
}
function resolveOptionalHookIdempotencyKey(raw) {
	if (typeof raw !== "string") return;
	const trimmed = raw.trim();
	if (!trimmed || trimmed.length > MAX_HOOK_IDEMPOTENCY_KEY_LENGTH) return;
	return trimmed;
}
function resolveHookIdempotencyKey(params) {
	return resolveOptionalHookIdempotencyKey(params.headers?.["idempotency-key"]) || resolveOptionalHookIdempotencyKey(params.headers?.["x-openclaw-idempotency-key"]) || resolveOptionalHookIdempotencyKey(params.payload.idempotencyKey);
}
function resolveHookTargetAgentId(hooksConfig, agentId) {
	const raw = agentId?.trim();
	if (!raw) return;
	const normalized = normalizeAgentId(raw);
	if (hooksConfig.agentPolicy.knownAgentIds.has(normalized)) return normalized;
	return hooksConfig.agentPolicy.defaultAgentId;
}
function isHookAgentAllowed(hooksConfig, agentId) {
	const raw = agentId?.trim();
	if (!raw) return true;
	const allowed = hooksConfig.agentPolicy.allowedAgentIds;
	if (allowed === void 0) return true;
	const resolved = resolveHookTargetAgentId(hooksConfig, raw);
	return resolved ? allowed.has(resolved) : false;
}
const getHookAgentPolicyError = () => "agentId is not allowed by hooks.allowedAgentIds";
const getHookSessionKeyRequestPolicyError = () => "sessionKey is disabled for external /hooks/agent payloads; set hooks.allowRequestSessionKey=true to enable";
const getHookSessionKeyPrefixError = (prefixes) => `sessionKey must start with one of: ${prefixes.join(", ")}`;
function resolveHookSessionKey(params) {
	const requested = resolveSessionKey$1(params.sessionKey);
	if (requested) {
		if (params.source === "request" && !params.hooksConfig.sessionPolicy.allowRequestSessionKey) return {
			ok: false,
			error: getHookSessionKeyRequestPolicyError()
		};
		const allowedPrefixes = params.hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
		if (allowedPrefixes && !isSessionKeyAllowedByPrefix(requested, allowedPrefixes)) return {
			ok: false,
			error: getHookSessionKeyPrefixError(allowedPrefixes)
		};
		return {
			ok: true,
			value: requested
		};
	}
	const defaultSessionKey = params.hooksConfig.sessionPolicy.defaultSessionKey;
	if (defaultSessionKey) return {
		ok: true,
		value: defaultSessionKey
	};
	const generated = `hook:${(params.idFactory ?? randomUUID)()}`;
	const allowedPrefixes = params.hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
	if (allowedPrefixes && !isSessionKeyAllowedByPrefix(generated, allowedPrefixes)) return {
		ok: false,
		error: getHookSessionKeyPrefixError(allowedPrefixes)
	};
	return {
		ok: true,
		value: generated
	};
}
function normalizeHookDispatchSessionKey(params) {
	const trimmed = params.sessionKey.trim();
	if (!trimmed || !params.targetAgentId) return trimmed;
	const parsed = parseAgentSessionKey(trimmed);
	if (!parsed) return trimmed;
	const targetAgentId = normalizeAgentId(params.targetAgentId);
	if (parsed.agentId !== targetAgentId) return `agent:${parsed.agentId}:${parsed.rest}`;
	return parsed.rest;
}
function normalizeAgentPayload(payload) {
	const message = typeof payload.message === "string" ? payload.message.trim() : "";
	if (!message) return {
		ok: false,
		error: "message required"
	};
	const nameRaw = payload.name;
	const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "Hook";
	const agentIdRaw = payload.agentId;
	const agentId = typeof agentIdRaw === "string" && agentIdRaw.trim() ? agentIdRaw.trim() : void 0;
	const idempotencyKey = resolveOptionalHookIdempotencyKey(payload.idempotencyKey);
	const wakeMode = payload.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now";
	const sessionKeyRaw = payload.sessionKey;
	const sessionKey = typeof sessionKeyRaw === "string" && sessionKeyRaw.trim() ? sessionKeyRaw.trim() : void 0;
	const channel = resolveHookChannel(payload.channel);
	if (!channel) return {
		ok: false,
		error: getHookChannelError()
	};
	const toRaw = payload.to;
	const to = typeof toRaw === "string" && toRaw.trim() ? toRaw.trim() : void 0;
	const modelRaw = payload.model;
	const model = typeof modelRaw === "string" && modelRaw.trim() ? modelRaw.trim() : void 0;
	if (modelRaw !== void 0 && !model) return {
		ok: false,
		error: "model required"
	};
	const deliver = resolveHookDeliver(payload.deliver);
	const thinkingRaw = payload.thinking;
	const thinking = typeof thinkingRaw === "string" && thinkingRaw.trim() ? thinkingRaw.trim() : void 0;
	const timeoutRaw = payload.timeoutSeconds;
	return {
		ok: true,
		value: {
			message,
			name,
			agentId,
			idempotencyKey,
			wakeMode,
			sessionKey,
			deliver,
			channel,
			to,
			model,
			thinking,
			timeoutSeconds: typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : void 0
		}
	};
}
//#endregion
//#region src/gateway/server-browser.ts
async function startBrowserControlServerIfEnabled() {
	if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER)) return null;
	const override = process.env.OPENCLAW_BROWSER_CONTROL_MODULE?.trim();
	const mod = override ? await import(override) : await import("./server-Bsvyi0NB.js");
	const start = typeof mod.startBrowserControlServiceFromConfig === "function" ? mod.startBrowserControlServiceFromConfig : mod.startBrowserControlServerFromConfig;
	const stop = typeof mod.stopBrowserControlService === "function" ? mod.stopBrowserControlService : mod.stopBrowserControlServer;
	if (!start) return null;
	await start();
	return { stop: stop ?? (async () => {}) };
}
//#endregion
//#region src/canvas-host/file-resolver.ts
function normalizeUrlPath(rawPath) {
	const decoded = decodeURIComponent(rawPath || "/");
	const normalized = path.posix.normalize(decoded);
	return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
async function resolveFileWithinRoot(rootReal, urlPath) {
	const normalized = normalizeUrlPath(urlPath);
	const rel = normalized.replace(/^\/+/, "");
	if (rel.split("/").some((p) => p === "..")) return null;
	const tryOpen = async (relative) => {
		try {
			return await openFileWithinRoot({
				rootDir: rootReal,
				relativePath: relative
			});
		} catch (err) {
			if (err instanceof SafeOpenError) return null;
			throw err;
		}
	};
	if (normalized.endsWith("/")) return await tryOpen(path.posix.join(rel, "index.html"));
	const candidate = path.join(rootReal, rel);
	try {
		const st = await fs$1.lstat(candidate);
		if (st.isSymbolicLink()) return null;
		if (st.isDirectory()) return await tryOpen(path.posix.join(rel, "index.html"));
	} catch {}
	return await tryOpen(rel);
}
//#endregion
//#region src/canvas-host/a2ui.ts
const A2UI_PATH = "/__openclaw__/a2ui";
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_WS_PATH = "/__openclaw__/ws";
let cachedA2uiRootReal;
let resolvingA2uiRoot = null;
let cachedA2uiResolvedAtMs = 0;
const A2UI_ROOT_RETRY_NULL_AFTER_MS = 1e4;
async function resolveA2uiRoot() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const entryDir = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null;
	const candidates = [
		path.resolve(here, "a2ui"),
		path.resolve(here, "canvas-host/a2ui"),
		path.resolve(here, "../canvas-host/a2ui"),
		...entryDir ? [
			path.resolve(entryDir, "a2ui"),
			path.resolve(entryDir, "canvas-host/a2ui"),
			path.resolve(entryDir, "../canvas-host/a2ui")
		] : [],
		path.resolve(here, "../../src/canvas-host/a2ui"),
		path.resolve(here, "../src/canvas-host/a2ui"),
		path.resolve(process.cwd(), "src/canvas-host/a2ui"),
		path.resolve(process.cwd(), "dist/canvas-host/a2ui")
	];
	if (process.execPath) candidates.unshift(path.resolve(path.dirname(process.execPath), "a2ui"));
	for (const dir of candidates) try {
		const indexPath = path.join(dir, "index.html");
		const bundlePath = path.join(dir, "a2ui.bundle.js");
		await fs$1.stat(indexPath);
		await fs$1.stat(bundlePath);
		return dir;
	} catch {}
	return null;
}
async function resolveA2uiRootReal() {
	if (cachedA2uiRootReal !== void 0 && (cachedA2uiRootReal !== null || Date.now() - cachedA2uiResolvedAtMs < A2UI_ROOT_RETRY_NULL_AFTER_MS)) return cachedA2uiRootReal;
	if (!resolvingA2uiRoot) resolvingA2uiRoot = (async () => {
		const root = await resolveA2uiRoot();
		cachedA2uiRootReal = root ? await fs$1.realpath(root) : null;
		cachedA2uiResolvedAtMs = Date.now();
		resolvingA2uiRoot = null;
		return cachedA2uiRootReal;
	})();
	return resolvingA2uiRoot;
}
function injectCanvasLiveReload(html) {
	const snippet = `
<script>
(() => {
  // Cross-platform action bridge helper.
  // Works on:
  // - iOS: window.webkit.messageHandlers.openclawCanvasA2UIAction.postMessage(...)
  // - Android: window.openclawCanvasA2UIAction.postMessage(...)
  const handlerNames = ["openclawCanvasA2UIAction"];
  function postToNode(payload) {
    try {
      const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
      for (const name of handlerNames) {
        const iosHandler = globalThis.webkit?.messageHandlers?.[name];
        if (iosHandler && typeof iosHandler.postMessage === "function") {
          iosHandler.postMessage(raw);
          return true;
        }
        const androidHandler = globalThis[name];
        if (androidHandler && typeof androidHandler.postMessage === "function") {
          // Important: call as a method on the interface object (binding matters on Android WebView).
          androidHandler.postMessage(raw);
          return true;
        }
      }
    } catch {}
    return false;
  }
  function sendUserAction(userAction) {
    const id =
      (userAction && typeof userAction.id === "string" && userAction.id.trim()) ||
      (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
    const action = { ...userAction, id };
    return postToNode({ userAction: action });
  }
  globalThis.OpenClaw = globalThis.OpenClaw ?? {};
  globalThis.OpenClaw.postMessage = postToNode;
  globalThis.OpenClaw.sendUserAction = sendUserAction;
  globalThis.openclawPostMessage = postToNode;
  globalThis.openclawSendUserAction = sendUserAction;

  try {
    const cap = new URLSearchParams(location.search).get("oc_cap");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const capQuery = cap ? "?oc_cap=" + encodeURIComponent(cap) : "";
    const ws = new WebSocket(proto + "://" + location.host + ${JSON.stringify(CANVAS_WS_PATH)} + capQuery);
    ws.onmessage = (ev) => {
      if (String(ev.data || "") === "reload") location.reload();
    };
  } catch {}
})();
<\/script>
`.trim();
	const idx = html.toLowerCase().lastIndexOf("</body>");
	if (idx >= 0) return `${html.slice(0, idx)}\n${snippet}\n${html.slice(idx)}`;
	return `${html}\n${snippet}\n`;
}
async function handleA2uiHttpRequest(req, res) {
	const urlRaw = req.url;
	if (!urlRaw) return false;
	const url = new URL(urlRaw, "http://localhost");
	const basePath = url.pathname === "/__openclaw__/a2ui" || url.pathname.startsWith(`/__openclaw__/a2ui/`) ? A2UI_PATH : void 0;
	if (!basePath) return false;
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.statusCode = 405;
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end("Method Not Allowed");
		return true;
	}
	const a2uiRootReal = await resolveA2uiRootReal();
	if (!a2uiRootReal) {
		res.statusCode = 503;
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end("A2UI assets not found");
		return true;
	}
	const result = await resolveFileWithinRoot(a2uiRootReal, url.pathname.slice(basePath.length) || "/");
	if (!result) {
		res.statusCode = 404;
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end("not found");
		return true;
	}
	try {
		const lower = result.realPath.toLowerCase();
		const mime = lower.endsWith(".html") || lower.endsWith(".htm") ? "text/html" : await detectMime({ filePath: result.realPath }) ?? "application/octet-stream";
		res.setHeader("Cache-Control", "no-store");
		if (req.method === "HEAD") {
			res.setHeader("Content-Type", mime === "text/html" ? "text/html; charset=utf-8" : mime);
			res.end();
			return true;
		}
		if (mime === "text/html") {
			const buf = await result.handle.readFile({ encoding: "utf8" });
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(injectCanvasLiveReload(buf));
			return true;
		}
		res.setHeader("Content-Type", mime);
		res.end(await result.handle.readFile());
		return true;
	} finally {
		await result.handle.close().catch(() => {});
	}
}
//#endregion
//#region src/gateway/control-ui-csp.ts
function buildControlUiCspHeader() {
	return [
		"default-src 'self'",
		"base-uri 'none'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
		"img-src 'self' data: https:",
		"font-src 'self' https://fonts.gstatic.com",
		"connect-src 'self' ws: wss:"
	].join("; ");
}
//#endregion
//#region src/gateway/control-ui-http-utils.ts
function isReadHttpMethod(method) {
	return method === "GET" || method === "HEAD";
}
function respondPlainText(res, statusCode, body) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "text/plain; charset=utf-8");
	res.end(body);
}
function respondNotFound(res) {
	respondPlainText(res, 404, "Not Found");
}
//#endregion
//#region src/gateway/control-ui-routing.ts
const ROOT_MOUNTED_GATEWAY_PROBE_PATHS = new Set([
	"/health",
	"/healthz",
	"/ready",
	"/readyz"
]);
function classifyControlUiRequest(params) {
	const { basePath, pathname, search, method } = params;
	if (!basePath) {
		if (pathname === "/ui" || pathname.startsWith("/ui/")) return { kind: "not-found" };
		if (ROOT_MOUNTED_GATEWAY_PROBE_PATHS.has(pathname)) return { kind: "not-control-ui" };
		if (pathname === "/plugins" || pathname.startsWith("/plugins/")) return { kind: "not-control-ui" };
		if (pathname === "/api" || pathname.startsWith("/api/")) return { kind: "not-control-ui" };
		if (!isReadHttpMethod(method)) return { kind: "not-control-ui" };
		return { kind: "serve" };
	}
	if (!pathname.startsWith(`${basePath}/`) && pathname !== basePath) return { kind: "not-control-ui" };
	if (!isReadHttpMethod(method)) return { kind: "not-control-ui" };
	if (pathname === basePath) return {
		kind: "redirect",
		location: `${basePath}/${search}`
	};
	return { kind: "serve" };
}
//#endregion
//#region src/gateway/control-ui.ts
const ROOT_PREFIX = "/";
const CONTROL_UI_ASSETS_MISSING_MESSAGE = "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.";
function contentTypeForExt(ext) {
	switch (ext) {
		case ".html": return "text/html; charset=utf-8";
		case ".js": return "application/javascript; charset=utf-8";
		case ".css": return "text/css; charset=utf-8";
		case ".json":
		case ".map": return "application/json; charset=utf-8";
		case ".svg": return "image/svg+xml";
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".gif": return "image/gif";
		case ".webp": return "image/webp";
		case ".ico": return "image/x-icon";
		case ".txt": return "text/plain; charset=utf-8";
		default: return "application/octet-stream";
	}
}
/**
* Extensions recognised as static assets.  Missing files with these extensions
* return 404 instead of the SPA index.html fallback.  `.html` is intentionally
* excluded — actual HTML files on disk are served earlier, and missing `.html`
* paths should fall through to the SPA router (client-side routers may use
* `.html`-suffixed routes).
*/
const STATIC_ASSET_EXTENSIONS = new Set([
	".js",
	".css",
	".json",
	".map",
	".svg",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".txt"
]);
function applyControlUiSecurityHeaders(res) {
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Content-Security-Policy", buildControlUiCspHeader());
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
}
function sendJson$2(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	res.end(JSON.stringify(body));
}
function respondControlUiAssetsUnavailable(res, options) {
	if (options?.configuredRootPath) {
		respondPlainText(res, 503, `Control UI assets not found at ${options.configuredRootPath}. Build them with \`pnpm ui:build\` (auto-installs UI deps), or update gateway.controlUi.root.`);
		return;
	}
	respondPlainText(res, 503, CONTROL_UI_ASSETS_MISSING_MESSAGE);
}
function respondHeadForFile(req, res, filePath) {
	if (req.method !== "HEAD") return false;
	res.statusCode = 200;
	setStaticFileHeaders(res, filePath);
	res.end();
	return true;
}
function isValidAgentId(agentId) {
	return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}
function handleControlUiAvatarRequest(req, res, opts) {
	const urlRaw = req.url;
	if (!urlRaw) return false;
	if (!isReadHttpMethod(req.method)) return false;
	const url = new URL(urlRaw, "http://localhost");
	const basePath = normalizeControlUiBasePath(opts.basePath);
	const pathname = url.pathname;
	const pathWithBase = basePath ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/` : `${CONTROL_UI_AVATAR_PREFIX}/`;
	if (!pathname.startsWith(pathWithBase)) return false;
	applyControlUiSecurityHeaders(res);
	const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
	const agentId = agentIdParts[0] ?? "";
	if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
		respondNotFound(res);
		return true;
	}
	if (url.searchParams.get("meta") === "1") {
		const resolved = opts.resolveAvatar(agentId);
		sendJson$2(res, 200, { avatarUrl: resolved.kind === "local" ? buildControlUiAvatarUrl(basePath, agentId) : resolved.kind === "remote" || resolved.kind === "data" ? resolved.url : null });
		return true;
	}
	const resolved = opts.resolveAvatar(agentId);
	if (resolved.kind !== "local") {
		respondNotFound(res);
		return true;
	}
	const safeAvatar = resolveSafeAvatarFile(resolved.filePath);
	if (!safeAvatar) {
		respondNotFound(res);
		return true;
	}
	try {
		if (respondHeadForFile(req, res, safeAvatar.path)) return true;
		serveResolvedFile(res, safeAvatar.path, fs.readFileSync(safeAvatar.fd));
		return true;
	} finally {
		fs.closeSync(safeAvatar.fd);
	}
}
function setStaticFileHeaders(res, filePath) {
	const ext = path.extname(filePath).toLowerCase();
	res.setHeader("Content-Type", contentTypeForExt(ext));
	res.setHeader("Cache-Control", "no-cache");
}
function serveResolvedFile(res, filePath, body) {
	setStaticFileHeaders(res, filePath);
	res.end(body);
}
function serveResolvedIndexHtml(res, body) {
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	res.end(body);
}
function isExpectedSafePathError(error) {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}
function resolveSafeAvatarFile(filePath) {
	const opened = openVerifiedFileSync({
		filePath,
		rejectPathSymlink: true,
		maxBytes: AVATAR_MAX_BYTES
	});
	if (!opened.ok) return null;
	return {
		path: opened.path,
		fd: opened.fd
	};
}
function resolveSafeControlUiFile(rootReal, filePath, rejectHardlinks) {
	const opened = openBoundaryFileSync({
		absolutePath: filePath,
		rootPath: rootReal,
		rootRealPath: rootReal,
		boundaryLabel: "control ui root",
		skipLexicalRootCheck: true,
		rejectHardlinks
	});
	if (!opened.ok) {
		if (opened.reason === "io") throw opened.error;
		return null;
	}
	return {
		path: opened.path,
		fd: opened.fd
	};
}
function isSafeRelativePath(relPath) {
	if (!relPath) return false;
	const normalized = path.posix.normalize(relPath);
	if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return false;
	if (normalized.startsWith("../") || normalized === "..") return false;
	if (normalized.includes("\0")) return false;
	return true;
}
function handleControlUiHttpRequest(req, res, opts) {
	const urlRaw = req.url;
	if (!urlRaw) return false;
	const url = new URL(urlRaw, "http://localhost");
	const basePath = normalizeControlUiBasePath(opts?.basePath);
	const pathname = url.pathname;
	const route = classifyControlUiRequest({
		basePath,
		pathname,
		search: url.search,
		method: req.method
	});
	if (route.kind === "not-control-ui") return false;
	if (route.kind === "not-found") {
		applyControlUiSecurityHeaders(res);
		respondNotFound(res);
		return true;
	}
	if (route.kind === "redirect") {
		applyControlUiSecurityHeaders(res);
		res.statusCode = 302;
		res.setHeader("Location", route.location);
		res.end();
		return true;
	}
	applyControlUiSecurityHeaders(res);
	if (pathname === (basePath ? `${basePath}/__openclaw/control-ui-config.json` : "/__openclaw/control-ui-config.json")) {
		const config = opts?.config;
		const identity = config ? resolveAssistantIdentity({
			cfg: config,
			agentId: opts?.agentId
		}) : DEFAULT_ASSISTANT_IDENTITY;
		const avatarValue = resolveAssistantAvatarUrl({
			avatar: identity.avatar,
			agentId: identity.agentId,
			basePath
		});
		if (req.method === "HEAD") {
			res.statusCode = 200;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.setHeader("Cache-Control", "no-cache");
			res.end();
			return true;
		}
		sendJson$2(res, 200, {
			basePath,
			assistantName: identity.name,
			assistantAvatar: avatarValue ?? identity.avatar,
			assistantAgentId: identity.agentId,
			serverVersion: resolveRuntimeServiceVersion(process.env)
		});
		return true;
	}
	const rootState = opts?.root;
	if (rootState?.kind === "invalid") {
		respondControlUiAssetsUnavailable(res, { configuredRootPath: rootState.path });
		return true;
	}
	if (rootState?.kind === "missing") {
		respondControlUiAssetsUnavailable(res);
		return true;
	}
	const root = rootState?.kind === "resolved" || rootState?.kind === "bundled" ? rootState.path : resolveControlUiRootSync({
		moduleUrl: import.meta.url,
		argv1: process.argv[1],
		cwd: process.cwd()
	});
	if (!root) {
		respondControlUiAssetsUnavailable(res);
		return true;
	}
	const rootReal = (() => {
		try {
			return fs.realpathSync(root);
		} catch (error) {
			if (isExpectedSafePathError(error)) return null;
			throw error;
		}
	})();
	if (!rootReal) {
		respondControlUiAssetsUnavailable(res);
		return true;
	}
	const uiPath = basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
	const rel = (() => {
		if (uiPath === ROOT_PREFIX) return "";
		const assetsIndex = uiPath.indexOf("/assets/");
		if (assetsIndex >= 0) return uiPath.slice(assetsIndex + 1);
		return uiPath.slice(1);
	})();
	const fileRel = (rel && !rel.endsWith("/") ? rel : `${rel}index.html`) || "index.html";
	if (!isSafeRelativePath(fileRel)) {
		respondNotFound(res);
		return true;
	}
	const filePath = path.resolve(root, fileRel);
	if (!isWithinDir(root, filePath)) {
		respondNotFound(res);
		return true;
	}
	const rejectHardlinks = !(rootState?.kind === "bundled" || rootState === void 0 && isPackageProvenControlUiRootSync(root, {
		moduleUrl: import.meta.url,
		argv1: process.argv[1],
		cwd: process.cwd()
	}));
	const safeFile = resolveSafeControlUiFile(rootReal, filePath, rejectHardlinks);
	if (safeFile) try {
		if (respondHeadForFile(req, res, safeFile.path)) return true;
		if (path.basename(safeFile.path) === "index.html") {
			serveResolvedIndexHtml(res, fs.readFileSync(safeFile.fd, "utf8"));
			return true;
		}
		serveResolvedFile(res, safeFile.path, fs.readFileSync(safeFile.fd));
		return true;
	} finally {
		fs.closeSync(safeFile.fd);
	}
	if (STATIC_ASSET_EXTENSIONS.has(path.extname(fileRel).toLowerCase())) {
		respondNotFound(res);
		return true;
	}
	const safeIndex = resolveSafeControlUiFile(rootReal, path.join(root, "index.html"), rejectHardlinks);
	if (safeIndex) try {
		if (respondHeadForFile(req, res, safeIndex.path)) return true;
		serveResolvedIndexHtml(res, fs.readFileSync(safeIndex.fd, "utf8"));
		return true;
	} finally {
		fs.closeSync(safeIndex.fd);
	}
	respondNotFound(res);
	return true;
}
//#endregion
//#region src/gateway/http-common.ts
/**
* Apply baseline security headers that are safe for all response types (API JSON,
* HTML pages, static assets, SSE streams). Headers that restrict framing or set a
* Content-Security-Policy are intentionally omitted here because some handlers
* (canvas host, A2UI) serve content that may be loaded inside frames.
*/
function setDefaultSecurityHeaders(res, opts) {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	const strictTransportSecurity = opts?.strictTransportSecurity;
	if (typeof strictTransportSecurity === "string" && strictTransportSecurity.length > 0) res.setHeader("Strict-Transport-Security", strictTransportSecurity);
}
function sendJson$1(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}
function sendText(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "text/plain; charset=utf-8");
	res.end(body);
}
function sendMethodNotAllowed(res, allow = "POST") {
	res.setHeader("Allow", allow);
	sendText(res, 405, "Method Not Allowed");
}
function sendUnauthorized(res) {
	sendJson$1(res, 401, { error: {
		message: "Unauthorized",
		type: "unauthorized"
	} });
}
function sendRateLimited(res, retryAfterMs) {
	if (retryAfterMs && retryAfterMs > 0) res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1e3)));
	sendJson$1(res, 429, { error: {
		message: "Too many failed authentication attempts. Please try again later.",
		type: "rate_limited"
	} });
}
function sendGatewayAuthFailure(res, authResult) {
	if (authResult.rateLimited) {
		sendRateLimited(res, authResult.retryAfterMs);
		return;
	}
	sendUnauthorized(res);
}
function sendInvalidRequest(res, message) {
	sendJson$1(res, 400, { error: {
		message,
		type: "invalid_request_error"
	} });
}
async function readJsonBodyOrError(req, res, maxBytes) {
	const body = await readJsonBody(req, maxBytes);
	if (!body.ok) {
		if (body.error === "payload too large") {
			sendJson$1(res, 413, { error: {
				message: "Payload too large",
				type: "invalid_request_error"
			} });
			return;
		}
		if (body.error === "request body timeout") {
			sendJson$1(res, 408, { error: {
				message: "Request body timeout",
				type: "invalid_request_error"
			} });
			return;
		}
		sendInvalidRequest(res, body.error);
		return;
	}
	return body.value;
}
function writeDone(res) {
	res.write("data: [DONE]\n\n");
}
function setSseHeaders(res) {
	res.statusCode = 200;
	res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders?.();
}
//#endregion
//#region src/gateway/http-utils.ts
init_session_key();
function getHeader(req, name) {
	const raw = req.headers[name.toLowerCase()];
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw)) return raw[0];
}
function getBearerToken(req) {
	const raw = getHeader(req, "authorization")?.trim() ?? "";
	if (!raw.toLowerCase().startsWith("bearer ")) return;
	return raw.slice(7).trim() || void 0;
}
function resolveAgentIdFromHeader(req) {
	const raw = getHeader(req, "x-openclaw-agent-id")?.trim() || getHeader(req, "x-openclaw-agent")?.trim() || "";
	if (!raw) return;
	return normalizeAgentId(raw);
}
function resolveAgentIdFromModel(model) {
	const raw = model?.trim();
	if (!raw) return;
	const agentId = (raw.match(/^openclaw[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ?? raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i))?.groups?.agentId;
	if (!agentId) return;
	return normalizeAgentId(agentId);
}
function resolveAgentIdForRequest(params) {
	const fromHeader = resolveAgentIdFromHeader(params.req);
	if (fromHeader) return fromHeader;
	return resolveAgentIdFromModel(params.model) ?? "main";
}
function resolveSessionKey(params) {
	const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
	if (explicit) return explicit;
	const user = params.user?.trim();
	const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
	return buildAgentMainSessionKey({
		agentId: params.agentId,
		mainKey
	});
}
function resolveGatewayRequestContext(params) {
	const agentId = resolveAgentIdForRequest({
		req: params.req,
		model: params.model
	});
	return {
		agentId,
		sessionKey: resolveSessionKey({
			req: params.req,
			agentId,
			user: params.user,
			prefix: params.sessionPrefix
		}),
		messageChannel: params.useMessageChannelHeader ? normalizeMessageChannel(getHeader(params.req, "x-openclaw-message-channel")) ?? params.defaultMessageChannel : params.defaultMessageChannel
	};
}
//#endregion
//#region src/gateway/agent-event-assistant-text.ts
function resolveAssistantStreamDeltaText(evt) {
	const delta = evt.data.delta;
	const text = evt.data.text;
	return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}
//#endregion
//#region src/gateway/agent-prompt.ts
/**
* Coerce body to string. Handles cases where body is a content array
* (e.g. [{type:"text", text:"hello"}]) that would serialize as
* [object Object] if used directly in a template literal.
*/
function safeBody(body) {
	if (typeof body === "string") return body;
	return extractTextFromChatContent(body) ?? "";
}
function buildAgentMessageFromConversationEntries(entries) {
	if (entries.length === 0) return "";
	let currentIndex = -1;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const role = entries[i]?.role;
		if (role === "user" || role === "tool") {
			currentIndex = i;
			break;
		}
	}
	if (currentIndex < 0) currentIndex = entries.length - 1;
	const currentEntry = entries[currentIndex]?.entry;
	if (!currentEntry) return "";
	const historyEntries = entries.slice(0, currentIndex).map((e) => e.entry);
	if (historyEntries.length === 0) return safeBody(currentEntry.body);
	const formatEntry = (entry) => `${entry.sender}: ${safeBody(entry.body)}`;
	return buildHistoryContextFromEntries({
		entries: [...historyEntries, currentEntry],
		currentMessage: formatEntry(currentEntry),
		formatEntry
	});
}
//#endregion
//#region src/gateway/http-auth-helpers.ts
async function authorizeGatewayBearerRequestOrReply(params) {
	const token = getBearerToken(params.req);
	const authResult = await authorizeHttpGatewayConnect({
		auth: params.auth,
		connectAuth: token ? {
			token,
			password: token
		} : null,
		req: params.req,
		trustedProxies: params.trustedProxies,
		allowRealIpFallback: params.allowRealIpFallback,
		rateLimiter: params.rateLimiter
	});
	if (!authResult.ok) {
		sendGatewayAuthFailure(params.res, authResult);
		return false;
	}
	return true;
}
//#endregion
//#region src/gateway/http-endpoint-helpers.ts
async function handleGatewayPostJsonEndpoint(req, res, opts) {
	if (new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`).pathname !== opts.pathname) return false;
	if (req.method !== "POST") {
		sendMethodNotAllowed(res);
		return;
	}
	if (!await authorizeGatewayBearerRequestOrReply({
		req,
		res,
		auth: opts.auth,
		trustedProxies: opts.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback,
		rateLimiter: opts.rateLimiter
	})) return;
	const body = await readJsonBodyOrError(req, res, opts.maxBodyBytes);
	if (body === void 0) return;
	return { body };
}
//#endregion
//#region src/gateway/input-allowlist.ts
function normalizeInputHostnameAllowlist(values) {
	if (!values || values.length === 0) return;
	const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
	return normalized.length > 0 ? normalized : void 0;
}
//#endregion
//#region src/gateway/openai-http.ts
init_runtime();
const DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES = 20 * 1024 * 1024;
const IMAGE_ONLY_USER_MESSAGE = "User sent image(s) with no text.";
const DEFAULT_OPENAI_MAX_IMAGE_PARTS = 8;
const DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_IMAGE_LIMITS = {
	allowUrl: false,
	allowedMimes: new Set(DEFAULT_INPUT_IMAGE_MIMES),
	maxBytes: DEFAULT_INPUT_IMAGE_MAX_BYTES,
	maxRedirects: 3,
	timeoutMs: DEFAULT_INPUT_TIMEOUT_MS
};
function resolveOpenAiChatCompletionsLimits(config) {
	const imageConfig = config?.images;
	return {
		maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES,
		maxImageParts: typeof config?.maxImageParts === "number" ? Math.max(0, Math.floor(config.maxImageParts)) : DEFAULT_OPENAI_MAX_IMAGE_PARTS,
		maxTotalImageBytes: typeof config?.maxTotalImageBytes === "number" ? Math.max(1, Math.floor(config.maxTotalImageBytes)) : DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES,
		images: {
			allowUrl: imageConfig?.allowUrl ?? DEFAULT_OPENAI_IMAGE_LIMITS.allowUrl,
			urlAllowlist: normalizeInputHostnameAllowlist(imageConfig?.urlAllowlist),
			allowedMimes: normalizeMimeList(imageConfig?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
			maxBytes: imageConfig?.maxBytes ?? 10485760,
			maxRedirects: imageConfig?.maxRedirects ?? 3,
			timeoutMs: imageConfig?.timeoutMs ?? 1e4
		}
	};
}
function writeSse(res, data) {
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function buildAgentCommandInput(params) {
	return {
		message: params.prompt.message,
		extraSystemPrompt: params.prompt.extraSystemPrompt,
		images: params.prompt.images,
		sessionKey: params.sessionKey,
		runId: params.runId,
		deliver: false,
		messageChannel: params.messageChannel,
		bestEffortDeliver: false,
		senderIsOwner: true
	};
}
function writeAssistantRoleChunk(res, params) {
	writeSse(res, {
		id: params.runId,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1e3),
		model: params.model,
		choices: [{
			index: 0,
			delta: { role: "assistant" }
		}]
	});
}
function writeAssistantContentChunk(res, params) {
	writeSse(res, {
		id: params.runId,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1e3),
		model: params.model,
		choices: [{
			index: 0,
			delta: { content: params.content },
			finish_reason: params.finishReason
		}]
	});
}
function asMessages(val) {
	return Array.isArray(val) ? val : [];
}
function extractTextContent$1(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => {
		if (!part || typeof part !== "object") return "";
		const type = part.type;
		const text = part.text;
		const inputText = part.input_text;
		if (type === "text" && typeof text === "string") return text;
		if (type === "input_text" && typeof text === "string") return text;
		if (typeof inputText === "string") return inputText;
		return "";
	}).filter(Boolean).join("\n");
	return "";
}
function resolveImageUrlPart(part) {
	if (!part || typeof part !== "object") return;
	const imageUrl = part.image_url;
	if (typeof imageUrl === "string") {
		const trimmed = imageUrl.trim();
		return trimmed.length > 0 ? trimmed : void 0;
	}
	if (!imageUrl || typeof imageUrl !== "object") return;
	const rawUrl = imageUrl.url;
	if (typeof rawUrl !== "string") return;
	const trimmed = rawUrl.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function extractImageUrls(content) {
	if (!Array.isArray(content)) return [];
	const urls = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if (part.type !== "image_url") continue;
		const url = resolveImageUrlPart(part);
		if (url) urls.push(url);
	}
	return urls;
}
function parseImageUrlToSource(url) {
	const dataUriMatch = /^data:([^,]*?),(.*)$/is.exec(url);
	if (dataUriMatch) {
		const metadata = dataUriMatch[1]?.trim() ?? "";
		const data = dataUriMatch[2] ?? "";
		const metadataParts = metadata.split(";").map((part) => part.trim()).filter(Boolean);
		if (!metadataParts.some((part) => part.toLowerCase() === "base64")) throw new Error("image_url data URI must be base64 encoded");
		if (!data.trim()) throw new Error("image_url data URI is missing payload data");
		return {
			type: "base64",
			mediaType: metadataParts.find((part) => part.includes("/")),
			data
		};
	}
	return {
		type: "url",
		url
	};
}
function resolveActiveTurnContext(messagesUnknown) {
	const messages = asMessages(messagesUnknown);
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") continue;
		const role = typeof msg.role === "string" ? msg.role.trim() : "";
		const normalizedRole = role === "function" ? "tool" : role;
		if (normalizedRole !== "user" && normalizedRole !== "tool") continue;
		return {
			activeTurnIndex: i,
			activeUserMessageIndex: normalizedRole === "user" ? i : -1,
			urls: normalizedRole === "user" ? extractImageUrls(msg.content) : []
		};
	}
	return {
		activeTurnIndex: -1,
		activeUserMessageIndex: -1,
		urls: []
	};
}
async function resolveImagesForRequest(activeTurnContext, limits) {
	const urls = activeTurnContext.urls;
	if (urls.length === 0) return [];
	if (urls.length > limits.maxImageParts) throw new Error(`Too many image_url parts (${urls.length}; limit ${limits.maxImageParts})`);
	const images = [];
	let totalBytes = 0;
	for (const url of urls) {
		const source = parseImageUrlToSource(url);
		if (source.type === "base64") {
			const sourceBytes = estimateBase64DecodedBytes(source.data);
			if (totalBytes + sourceBytes > limits.maxTotalImageBytes) throw new Error(`Total image payload too large (${totalBytes + sourceBytes}; limit ${limits.maxTotalImageBytes})`);
		}
		const image = await extractImageContentFromSource(source, limits.images);
		totalBytes += estimateBase64DecodedBytes(image.data);
		if (totalBytes > limits.maxTotalImageBytes) throw new Error(`Total image payload too large (${totalBytes}; limit ${limits.maxTotalImageBytes})`);
		images.push(image);
	}
	return images;
}
function buildAgentPrompt$1(messagesUnknown, activeUserMessageIndex) {
	const messages = asMessages(messagesUnknown);
	const systemParts = [];
	const conversationEntries = [];
	for (const [i, msg] of messages.entries()) {
		if (!msg || typeof msg !== "object") continue;
		const role = typeof msg.role === "string" ? msg.role.trim() : "";
		const content = extractTextContent$1(msg.content).trim();
		const hasImage = extractImageUrls(msg.content).length > 0;
		if (!role) continue;
		if (role === "system" || role === "developer") {
			if (content) systemParts.push(content);
			continue;
		}
		const normalizedRole = role === "function" ? "tool" : role;
		if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") continue;
		const messageContent = normalizedRole === "user" && !content && hasImage && i === activeUserMessageIndex ? IMAGE_ONLY_USER_MESSAGE : content;
		if (!messageContent) continue;
		const name = typeof msg.name === "string" ? msg.name.trim() : "";
		const sender = normalizedRole === "assistant" ? "Assistant" : normalizedRole === "user" ? "User" : name ? `Tool:${name}` : "Tool";
		conversationEntries.push({
			role: normalizedRole,
			entry: {
				sender,
				body: messageContent
			}
		});
	}
	return {
		message: buildAgentMessageFromConversationEntries(conversationEntries),
		extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : void 0
	};
}
function coerceRequest(val) {
	if (!val || typeof val !== "object") return {};
	return val;
}
function resolveAgentResponseText(result) {
	const payloads = result?.payloads;
	if (!Array.isArray(payloads) || payloads.length === 0) return "No response from OpenClaw.";
	return payloads.map((p) => typeof p.text === "string" ? p.text : "").filter(Boolean).join("\n\n") || "No response from OpenClaw.";
}
async function handleOpenAiHttpRequest(req, res, opts) {
	const limits = resolveOpenAiChatCompletionsLimits(opts.config);
	const handled = await handleGatewayPostJsonEndpoint(req, res, {
		pathname: "/v1/chat/completions",
		auth: opts.auth,
		trustedProxies: opts.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback,
		rateLimiter: opts.rateLimiter,
		maxBodyBytes: opts.maxBodyBytes ?? limits.maxBodyBytes
	});
	if (handled === false) return false;
	if (!handled) return true;
	const payload = coerceRequest(handled.body);
	const stream = Boolean(payload.stream);
	const model = typeof payload.model === "string" ? payload.model : "openclaw";
	const { sessionKey, messageChannel } = resolveGatewayRequestContext({
		req,
		model,
		user: typeof payload.user === "string" ? payload.user : void 0,
		sessionPrefix: "openai",
		defaultMessageChannel: "webchat",
		useMessageChannelHeader: true
	});
	const activeTurnContext = resolveActiveTurnContext(payload.messages);
	const prompt = buildAgentPrompt$1(payload.messages, activeTurnContext.activeUserMessageIndex);
	let images = [];
	try {
		images = await resolveImagesForRequest(activeTurnContext, limits);
	} catch (err) {
		logWarn(`openai-compat: invalid image_url content: ${String(err)}`);
		sendJson$1(res, 400, { error: {
			message: "Invalid image_url content in `messages`.",
			type: "invalid_request_error"
		} });
		return true;
	}
	if (!prompt.message && images.length === 0) {
		sendJson$1(res, 400, { error: {
			message: "Missing user message in `messages`.",
			type: "invalid_request_error"
		} });
		return true;
	}
	const runId = `chatcmpl_${randomUUID()}`;
	const deps = createDefaultDeps();
	const commandInput = buildAgentCommandInput({
		prompt: {
			message: prompt.message,
			extraSystemPrompt: prompt.extraSystemPrompt,
			images: images.length > 0 ? images : void 0
		},
		sessionKey,
		runId,
		messageChannel
	});
	if (!stream) {
		try {
			const content = resolveAgentResponseText(await agentCommandFromIngress(commandInput, defaultRuntime, deps));
			sendJson$1(res, 200, {
				id: runId,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1e3),
				model,
				choices: [{
					index: 0,
					message: {
						role: "assistant",
						content
					},
					finish_reason: "stop"
				}],
				usage: {
					prompt_tokens: 0,
					completion_tokens: 0,
					total_tokens: 0
				}
			});
		} catch (err) {
			logWarn(`openai-compat: chat completion failed: ${String(err)}`);
			sendJson$1(res, 500, { error: {
				message: "internal error",
				type: "api_error"
			} });
		}
		return true;
	}
	setSseHeaders(res);
	let wroteRole = false;
	let sawAssistantDelta = false;
	let closed = false;
	const unsubscribe = onAgentEvent((evt) => {
		if (evt.runId !== runId) return;
		if (closed) return;
		if (evt.stream === "assistant") {
			const content = resolveAssistantStreamDeltaText(evt) ?? "";
			if (!content) return;
			if (!wroteRole) {
				wroteRole = true;
				writeAssistantRoleChunk(res, {
					runId,
					model
				});
			}
			sawAssistantDelta = true;
			writeAssistantContentChunk(res, {
				runId,
				model,
				content,
				finishReason: null
			});
			return;
		}
		if (evt.stream === "lifecycle") {
			const phase = evt.data?.phase;
			if (phase === "end" || phase === "error") {
				closed = true;
				unsubscribe();
				writeDone(res);
				res.end();
			}
		}
	});
	req.on("close", () => {
		closed = true;
		unsubscribe();
	});
	(async () => {
		try {
			const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);
			if (closed) return;
			if (!sawAssistantDelta) {
				if (!wroteRole) {
					wroteRole = true;
					writeAssistantRoleChunk(res, {
						runId,
						model
					});
				}
				const content = resolveAgentResponseText(result);
				sawAssistantDelta = true;
				writeAssistantContentChunk(res, {
					runId,
					model,
					content,
					finishReason: null
				});
			}
		} catch (err) {
			logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
			if (closed) return;
			writeAssistantContentChunk(res, {
				runId,
				model,
				content: "Error: internal error",
				finishReason: "stop"
			});
			emitAgentEvent({
				runId,
				stream: "lifecycle",
				data: { phase: "error" }
			});
		} finally {
			if (!closed) {
				closed = true;
				unsubscribe();
				writeDone(res);
				res.end();
			}
		}
	})();
	return true;
}
//#endregion
//#region src/gateway/open-responses.schema.ts
/**
* OpenResponses API Zod Schemas
*
* Zod schemas for the OpenResponses `/v1/responses` endpoint.
* This module is isolated from gateway imports to enable future codegen and prevent drift.
*
* @see https://www.open-responses.com/
*/
const InputTextContentPartSchema = z.object({
	type: z.literal("input_text"),
	text: z.string()
}).strict();
const OutputTextContentPartSchema = z.object({
	type: z.literal("output_text"),
	text: z.string()
}).strict();
const InputImageSourceSchema = z.discriminatedUnion("type", [z.object({
	type: z.literal("url"),
	url: z.string().url()
}), z.object({
	type: z.literal("base64"),
	media_type: z.enum([
		"image/jpeg",
		"image/png",
		"image/gif",
		"image/webp",
		"image/heic",
		"image/heif"
	]),
	data: z.string().min(1)
})]);
const InputImageContentPartSchema = z.object({
	type: z.literal("input_image"),
	source: InputImageSourceSchema
}).strict();
const InputFileSourceSchema = z.discriminatedUnion("type", [z.object({
	type: z.literal("url"),
	url: z.string().url()
}), z.object({
	type: z.literal("base64"),
	media_type: z.string().min(1),
	data: z.string().min(1),
	filename: z.string().optional()
})]);
const InputFileContentPartSchema = z.object({
	type: z.literal("input_file"),
	source: InputFileSourceSchema
}).strict();
const ContentPartSchema = z.discriminatedUnion("type", [
	InputTextContentPartSchema,
	OutputTextContentPartSchema,
	InputImageContentPartSchema,
	InputFileContentPartSchema
]);
const MessageItemRoleSchema = z.enum([
	"system",
	"developer",
	"user",
	"assistant"
]);
const MessageItemSchema = z.object({
	type: z.literal("message"),
	role: MessageItemRoleSchema,
	content: z.union([z.string(), z.array(ContentPartSchema)])
}).strict();
const FunctionCallItemSchema = z.object({
	type: z.literal("function_call"),
	id: z.string().optional(),
	call_id: z.string().optional(),
	name: z.string(),
	arguments: z.string()
}).strict();
const FunctionCallOutputItemSchema = z.object({
	type: z.literal("function_call_output"),
	call_id: z.string(),
	output: z.string()
}).strict();
const ReasoningItemSchema = z.object({
	type: z.literal("reasoning"),
	content: z.string().optional(),
	encrypted_content: z.string().optional(),
	summary: z.string().optional()
}).strict();
const ItemReferenceItemSchema = z.object({
	type: z.literal("item_reference"),
	id: z.string()
}).strict();
const ItemParamSchema = z.discriminatedUnion("type", [
	MessageItemSchema,
	FunctionCallItemSchema,
	FunctionCallOutputItemSchema,
	ReasoningItemSchema,
	ItemReferenceItemSchema
]);
const ToolDefinitionSchema = z.object({
	type: z.literal("function"),
	function: z.object({
		name: z.string().min(1, "Tool name cannot be empty"),
		description: z.string().optional(),
		parameters: z.record(z.string(), z.unknown()).optional()
	})
}).strict();
const ToolChoiceSchema = z.union([
	z.literal("auto"),
	z.literal("none"),
	z.literal("required"),
	z.object({
		type: z.literal("function"),
		function: z.object({ name: z.string() })
	})
]);
const CreateResponseBodySchema = z.object({
	model: z.string(),
	input: z.union([z.string(), z.array(ItemParamSchema)]),
	instructions: z.string().optional(),
	tools: z.array(ToolDefinitionSchema).optional(),
	tool_choice: ToolChoiceSchema.optional(),
	stream: z.boolean().optional(),
	max_output_tokens: z.number().int().positive().optional(),
	max_tool_calls: z.number().int().positive().optional(),
	user: z.string().optional(),
	temperature: z.number().optional(),
	top_p: z.number().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	store: z.boolean().optional(),
	previous_response_id: z.string().optional(),
	reasoning: z.object({
		effort: z.enum([
			"low",
			"medium",
			"high"
		]).optional(),
		summary: z.enum([
			"auto",
			"concise",
			"detailed"
		]).optional()
	}).optional(),
	truncation: z.enum(["auto", "disabled"]).optional()
}).strict();
const ResponseStatusSchema = z.enum([
	"in_progress",
	"completed",
	"failed",
	"cancelled",
	"incomplete"
]);
const OutputItemSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("message"),
		id: z.string(),
		role: z.literal("assistant"),
		content: z.array(OutputTextContentPartSchema),
		status: z.enum(["in_progress", "completed"]).optional()
	}).strict(),
	z.object({
		type: z.literal("function_call"),
		id: z.string(),
		call_id: z.string(),
		name: z.string(),
		arguments: z.string(),
		status: z.enum(["in_progress", "completed"]).optional()
	}).strict(),
	z.object({
		type: z.literal("reasoning"),
		id: z.string(),
		content: z.string().optional(),
		summary: z.string().optional()
	}).strict()
]);
const UsageSchema = z.object({
	input_tokens: z.number().int().nonnegative(),
	output_tokens: z.number().int().nonnegative(),
	total_tokens: z.number().int().nonnegative()
});
const ResponseResourceSchema = z.object({
	id: z.string(),
	object: z.literal("response"),
	created_at: z.number().int(),
	status: ResponseStatusSchema,
	model: z.string(),
	output: z.array(OutputItemSchema),
	usage: UsageSchema,
	error: z.object({
		code: z.string(),
		message: z.string()
	}).optional()
});
z.object({
	type: z.literal("response.created"),
	response: ResponseResourceSchema
});
z.object({
	type: z.literal("response.in_progress"),
	response: ResponseResourceSchema
});
z.object({
	type: z.literal("response.completed"),
	response: ResponseResourceSchema
});
z.object({
	type: z.literal("response.failed"),
	response: ResponseResourceSchema
});
z.object({
	type: z.literal("response.output_item.added"),
	output_index: z.number().int().nonnegative(),
	item: OutputItemSchema
});
z.object({
	type: z.literal("response.output_item.done"),
	output_index: z.number().int().nonnegative(),
	item: OutputItemSchema
});
z.object({
	type: z.literal("response.content_part.added"),
	item_id: z.string(),
	output_index: z.number().int().nonnegative(),
	content_index: z.number().int().nonnegative(),
	part: OutputTextContentPartSchema
});
z.object({
	type: z.literal("response.content_part.done"),
	item_id: z.string(),
	output_index: z.number().int().nonnegative(),
	content_index: z.number().int().nonnegative(),
	part: OutputTextContentPartSchema
});
z.object({
	type: z.literal("response.output_text.delta"),
	item_id: z.string(),
	output_index: z.number().int().nonnegative(),
	content_index: z.number().int().nonnegative(),
	delta: z.string()
});
z.object({
	type: z.literal("response.output_text.done"),
	item_id: z.string(),
	output_index: z.number().int().nonnegative(),
	content_index: z.number().int().nonnegative(),
	text: z.string()
});
//#endregion
//#region src/gateway/openresponses-prompt.ts
function extractTextContent(content) {
	if (typeof content === "string") return content;
	return content.map((part) => {
		if (part.type === "input_text") return part.text;
		if (part.type === "output_text") return part.text;
		return "";
	}).filter(Boolean).join("\n");
}
function buildAgentPrompt(input) {
	if (typeof input === "string") return { message: input };
	const systemParts = [];
	const conversationEntries = [];
	for (const item of input) if (item.type === "message") {
		const content = extractTextContent(item.content).trim();
		if (!content) continue;
		if (item.role === "system" || item.role === "developer") {
			systemParts.push(content);
			continue;
		}
		const normalizedRole = item.role === "assistant" ? "assistant" : "user";
		const sender = normalizedRole === "assistant" ? "Assistant" : "User";
		conversationEntries.push({
			role: normalizedRole,
			entry: {
				sender,
				body: content
			}
		});
	} else if (item.type === "function_call_output") conversationEntries.push({
		role: "tool",
		entry: {
			sender: `Tool:${item.call_id}`,
			body: item.output
		}
	});
	return {
		message: buildAgentMessageFromConversationEntries(conversationEntries),
		extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : void 0
	};
}
//#endregion
//#region src/gateway/openresponses-http.ts
/**
* OpenResponses HTTP Handler
*
* Implements the OpenResponses `/v1/responses` endpoint for OpenClaw Gateway.
*
* @see https://www.open-responses.com/
*/
init_runtime();
const DEFAULT_BODY_BYTES$1 = 20 * 1024 * 1024;
const DEFAULT_MAX_URL_PARTS = 8;
function writeSseEvent(res, event) {
	res.write(`event: ${event.type}\n`);
	res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function resolveResponsesLimits(config) {
	const files = config?.files;
	const images = config?.images;
	const fileLimits = resolveInputFileLimits(files);
	return {
		maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_BODY_BYTES$1,
		maxUrlParts: typeof config?.maxUrlParts === "number" ? Math.max(0, Math.floor(config.maxUrlParts)) : DEFAULT_MAX_URL_PARTS,
		files: {
			...fileLimits,
			urlAllowlist: normalizeInputHostnameAllowlist(files?.urlAllowlist)
		},
		images: {
			allowUrl: images?.allowUrl ?? true,
			urlAllowlist: normalizeInputHostnameAllowlist(images?.urlAllowlist),
			allowedMimes: normalizeMimeList(images?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
			maxBytes: images?.maxBytes ?? 10485760,
			maxRedirects: images?.maxRedirects ?? 3,
			timeoutMs: images?.timeoutMs ?? 1e4
		}
	};
}
function extractClientTools(body) {
	return body.tools ?? [];
}
function applyToolChoice(params) {
	const { tools, toolChoice } = params;
	if (!toolChoice) return { tools };
	if (toolChoice === "none") return { tools: [] };
	if (toolChoice === "required") {
		if (tools.length === 0) throw new Error("tool_choice=required but no tools were provided");
		return {
			tools,
			extraSystemPrompt: "You must call one of the available tools before responding."
		};
	}
	if (typeof toolChoice === "object" && toolChoice.type === "function") {
		const targetName = toolChoice.function?.name?.trim();
		if (!targetName) throw new Error("tool_choice.function.name is required");
		const matched = tools.filter((tool) => tool.function?.name === targetName);
		if (matched.length === 0) throw new Error(`tool_choice requested unknown tool: ${targetName}`);
		return {
			tools: matched,
			extraSystemPrompt: `You must call the ${targetName} tool before responding.`
		};
	}
	return { tools };
}
function createEmptyUsage() {
	return {
		input_tokens: 0,
		output_tokens: 0,
		total_tokens: 0
	};
}
function toUsage(value) {
	if (!value) return createEmptyUsage();
	const input = value.input ?? 0;
	const output = value.output ?? 0;
	const cacheRead = value.cacheRead ?? 0;
	const cacheWrite = value.cacheWrite ?? 0;
	const total = value.total ?? input + output + cacheRead + cacheWrite;
	return {
		input_tokens: Math.max(0, input),
		output_tokens: Math.max(0, output),
		total_tokens: Math.max(0, total)
	};
}
function extractUsageFromResult(result) {
	const meta = result?.meta;
	return toUsage(meta && typeof meta === "object" ? meta.agentMeta?.usage : void 0);
}
function resolveStopReasonAndPendingToolCalls(meta) {
	if (!meta || typeof meta !== "object") return {
		stopReason: void 0,
		pendingToolCalls: void 0
	};
	const record = meta;
	return {
		stopReason: record.stopReason,
		pendingToolCalls: record.pendingToolCalls
	};
}
function createResponseResource(params) {
	return {
		id: params.id,
		object: "response",
		created_at: Math.floor(Date.now() / 1e3),
		status: params.status,
		model: params.model,
		output: params.output,
		usage: params.usage ?? createEmptyUsage(),
		error: params.error
	};
}
function createAssistantOutputItem(params) {
	return {
		type: "message",
		id: params.id,
		role: "assistant",
		content: [{
			type: "output_text",
			text: params.text
		}],
		status: params.status
	};
}
async function runResponsesAgentCommand(params) {
	return agentCommandFromIngress({
		message: params.message,
		images: params.images.length > 0 ? params.images : void 0,
		clientTools: params.clientTools.length > 0 ? params.clientTools : void 0,
		extraSystemPrompt: params.extraSystemPrompt || void 0,
		streamParams: params.streamParams ?? void 0,
		sessionKey: params.sessionKey,
		runId: params.runId,
		deliver: false,
		messageChannel: params.messageChannel,
		bestEffortDeliver: false,
		senderIsOwner: true
	}, defaultRuntime, params.deps);
}
async function handleOpenResponsesHttpRequest(req, res, opts) {
	const limits = resolveResponsesLimits(opts.config);
	const maxBodyBytes = opts.maxBodyBytes ?? (opts.config?.maxBodyBytes ? limits.maxBodyBytes : Math.max(limits.maxBodyBytes, limits.files.maxBytes * 2, limits.images.maxBytes * 2));
	const handled = await handleGatewayPostJsonEndpoint(req, res, {
		pathname: "/v1/responses",
		auth: opts.auth,
		trustedProxies: opts.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback,
		rateLimiter: opts.rateLimiter,
		maxBodyBytes
	});
	if (handled === false) return false;
	if (!handled) return true;
	const parseResult = CreateResponseBodySchema.safeParse(handled.body);
	if (!parseResult.success) {
		const issue = parseResult.error.issues[0];
		sendJson$1(res, 400, { error: {
			message: issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request body",
			type: "invalid_request_error"
		} });
		return true;
	}
	const payload = parseResult.data;
	const stream = Boolean(payload.stream);
	const model = payload.model;
	const user = payload.user;
	let images = [];
	let fileContexts = [];
	let urlParts = 0;
	const markUrlPart = () => {
		urlParts += 1;
		if (urlParts > limits.maxUrlParts) throw new Error(`Too many URL-based input sources: ${urlParts} (limit: ${limits.maxUrlParts})`);
	};
	try {
		if (Array.isArray(payload.input)) {
			for (const item of payload.input) if (item.type === "message" && typeof item.content !== "string") for (const part of item.content) {
				if (part.type === "input_image") {
					const source = part.source;
					const sourceType = source.type === "base64" || source.type === "url" ? source.type : void 0;
					if (!sourceType) throw new Error("input_image must have 'source.url' or 'source.data'");
					if (sourceType === "url") markUrlPart();
					const image = await extractImageContentFromSource(sourceType === "url" ? {
						type: "url",
						url: source.url ?? "",
						mediaType: source.media_type
					} : {
						type: "base64",
						data: source.data ?? "",
						mediaType: source.media_type
					}, limits.images);
					images.push(image);
					continue;
				}
				if (part.type === "input_file") {
					const source = part.source;
					const sourceType = source.type === "base64" || source.type === "url" ? source.type : void 0;
					if (!sourceType) throw new Error("input_file must have 'source.url' or 'source.data'");
					if (sourceType === "url") markUrlPart();
					const file = await extractFileContentFromSource({
						source: sourceType === "url" ? {
							type: "url",
							url: source.url ?? "",
							mediaType: source.media_type,
							filename: source.filename
						} : {
							type: "base64",
							data: source.data ?? "",
							mediaType: source.media_type,
							filename: source.filename
						},
						limits: limits.files
					});
					if (file.text?.trim()) fileContexts.push(`<file name="${file.filename}">\n${file.text}\n</file>`);
					else if (file.images && file.images.length > 0) fileContexts.push(`<file name="${file.filename}">[PDF content rendered to images]</file>`);
					if (file.images && file.images.length > 0) images = images.concat(file.images);
				}
			}
		}
	} catch (err) {
		logWarn(`openresponses: request parsing failed: ${String(err)}`);
		sendJson$1(res, 400, { error: {
			message: "invalid request",
			type: "invalid_request_error"
		} });
		return true;
	}
	const clientTools = extractClientTools(payload);
	let toolChoicePrompt;
	let resolvedClientTools = clientTools;
	try {
		const toolChoiceResult = applyToolChoice({
			tools: clientTools,
			toolChoice: payload.tool_choice
		});
		resolvedClientTools = toolChoiceResult.tools;
		toolChoicePrompt = toolChoiceResult.extraSystemPrompt;
	} catch (err) {
		logWarn(`openresponses: tool configuration failed: ${String(err)}`);
		sendJson$1(res, 400, { error: {
			message: "invalid tool configuration",
			type: "invalid_request_error"
		} });
		return true;
	}
	const { sessionKey, messageChannel } = resolveGatewayRequestContext({
		req,
		model,
		user,
		sessionPrefix: "openresponses",
		defaultMessageChannel: "webchat",
		useMessageChannelHeader: false
	});
	const prompt = buildAgentPrompt(payload.input);
	const fileContext = fileContexts.length > 0 ? fileContexts.join("\n\n") : void 0;
	const toolChoiceContext = toolChoicePrompt?.trim();
	const extraSystemPrompt = [
		payload.instructions,
		prompt.extraSystemPrompt,
		toolChoiceContext,
		fileContext
	].filter(Boolean).join("\n\n");
	if (!prompt.message) {
		sendJson$1(res, 400, { error: {
			message: "Missing user message in `input`.",
			type: "invalid_request_error"
		} });
		return true;
	}
	const responseId = `resp_${randomUUID()}`;
	const outputItemId = `msg_${randomUUID()}`;
	const deps = createDefaultDeps();
	const streamParams = typeof payload.max_output_tokens === "number" ? { maxTokens: payload.max_output_tokens } : void 0;
	if (!stream) {
		try {
			const result = await runResponsesAgentCommand({
				message: prompt.message,
				images,
				clientTools: resolvedClientTools,
				extraSystemPrompt,
				streamParams,
				sessionKey,
				runId: responseId,
				messageChannel,
				deps
			});
			const payloads = result?.payloads;
			const usage = extractUsageFromResult(result);
			const meta = result?.meta;
			const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);
			if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
				const functionCall = pendingToolCalls[0];
				sendJson$1(res, 200, createResponseResource({
					id: responseId,
					model,
					status: "incomplete",
					output: [{
						type: "function_call",
						id: `call_${randomUUID()}`,
						call_id: functionCall.id,
						name: functionCall.name,
						arguments: functionCall.arguments
					}],
					usage
				}));
				return true;
			}
			sendJson$1(res, 200, createResponseResource({
				id: responseId,
				model,
				status: "completed",
				output: [createAssistantOutputItem({
					id: outputItemId,
					text: Array.isArray(payloads) && payloads.length > 0 ? payloads.map((p) => typeof p.text === "string" ? p.text : "").filter(Boolean).join("\n\n") : "No response from OpenClaw.",
					status: "completed"
				})],
				usage
			}));
		} catch (err) {
			logWarn(`openresponses: non-stream response failed: ${String(err)}`);
			sendJson$1(res, 500, createResponseResource({
				id: responseId,
				model,
				status: "failed",
				output: [],
				error: {
					code: "api_error",
					message: "internal error"
				}
			}));
		}
		return true;
	}
	setSseHeaders(res);
	let accumulatedText = "";
	let sawAssistantDelta = false;
	let closed = false;
	let unsubscribe = () => {};
	let finalUsage;
	let finalizeRequested = null;
	const maybeFinalize = () => {
		if (closed) return;
		if (!finalizeRequested) return;
		if (!finalUsage) return;
		const usage = finalUsage;
		closed = true;
		unsubscribe();
		writeSseEvent(res, {
			type: "response.output_text.done",
			item_id: outputItemId,
			output_index: 0,
			content_index: 0,
			text: finalizeRequested.text
		});
		writeSseEvent(res, {
			type: "response.content_part.done",
			item_id: outputItemId,
			output_index: 0,
			content_index: 0,
			part: {
				type: "output_text",
				text: finalizeRequested.text
			}
		});
		const completedItem = createAssistantOutputItem({
			id: outputItemId,
			text: finalizeRequested.text,
			status: "completed"
		});
		writeSseEvent(res, {
			type: "response.output_item.done",
			output_index: 0,
			item: completedItem
		});
		writeSseEvent(res, {
			type: "response.completed",
			response: createResponseResource({
				id: responseId,
				model,
				status: finalizeRequested.status,
				output: [completedItem],
				usage
			})
		});
		writeDone(res);
		res.end();
	};
	const requestFinalize = (status, text) => {
		if (finalizeRequested) return;
		finalizeRequested = {
			status,
			text
		};
		maybeFinalize();
	};
	const initialResponse = createResponseResource({
		id: responseId,
		model,
		status: "in_progress",
		output: []
	});
	writeSseEvent(res, {
		type: "response.created",
		response: initialResponse
	});
	writeSseEvent(res, {
		type: "response.in_progress",
		response: initialResponse
	});
	writeSseEvent(res, {
		type: "response.output_item.added",
		output_index: 0,
		item: createAssistantOutputItem({
			id: outputItemId,
			text: "",
			status: "in_progress"
		})
	});
	writeSseEvent(res, {
		type: "response.content_part.added",
		item_id: outputItemId,
		output_index: 0,
		content_index: 0,
		part: {
			type: "output_text",
			text: ""
		}
	});
	unsubscribe = onAgentEvent((evt) => {
		if (evt.runId !== responseId) return;
		if (closed) return;
		if (evt.stream === "assistant") {
			const content = resolveAssistantStreamDeltaText(evt);
			if (!content) return;
			sawAssistantDelta = true;
			accumulatedText += content;
			writeSseEvent(res, {
				type: "response.output_text.delta",
				item_id: outputItemId,
				output_index: 0,
				content_index: 0,
				delta: content
			});
			return;
		}
		if (evt.stream === "lifecycle") {
			const phase = evt.data?.phase;
			if (phase === "end" || phase === "error") requestFinalize(phase === "error" ? "failed" : "completed", accumulatedText || "No response from OpenClaw.");
		}
	});
	req.on("close", () => {
		closed = true;
		unsubscribe();
	});
	(async () => {
		try {
			const result = await runResponsesAgentCommand({
				message: prompt.message,
				images,
				clientTools: resolvedClientTools,
				extraSystemPrompt,
				streamParams,
				sessionKey,
				runId: responseId,
				messageChannel,
				deps
			});
			finalUsage = extractUsageFromResult(result);
			maybeFinalize();
			if (closed) return;
			if (!sawAssistantDelta) {
				const resultAny = result;
				const payloads = resultAny.payloads;
				const meta = resultAny.meta;
				const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);
				if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
					const functionCall = pendingToolCalls[0];
					const usage = finalUsage ?? createEmptyUsage();
					writeSseEvent(res, {
						type: "response.output_text.done",
						item_id: outputItemId,
						output_index: 0,
						content_index: 0,
						text: ""
					});
					writeSseEvent(res, {
						type: "response.content_part.done",
						item_id: outputItemId,
						output_index: 0,
						content_index: 0,
						part: {
							type: "output_text",
							text: ""
						}
					});
					const completedItem = createAssistantOutputItem({
						id: outputItemId,
						text: "",
						status: "completed"
					});
					writeSseEvent(res, {
						type: "response.output_item.done",
						output_index: 0,
						item: completedItem
					});
					const functionCallItem = {
						type: "function_call",
						id: `call_${randomUUID()}`,
						call_id: functionCall.id,
						name: functionCall.name,
						arguments: functionCall.arguments
					};
					writeSseEvent(res, {
						type: "response.output_item.added",
						output_index: 1,
						item: functionCallItem
					});
					writeSseEvent(res, {
						type: "response.output_item.done",
						output_index: 1,
						item: {
							...functionCallItem,
							status: "completed"
						}
					});
					const incompleteResponse = createResponseResource({
						id: responseId,
						model,
						status: "incomplete",
						output: [completedItem, functionCallItem],
						usage
					});
					closed = true;
					unsubscribe();
					writeSseEvent(res, {
						type: "response.completed",
						response: incompleteResponse
					});
					writeDone(res);
					res.end();
					return;
				}
				const content = Array.isArray(payloads) && payloads.length > 0 ? payloads.map((p) => typeof p.text === "string" ? p.text : "").filter(Boolean).join("\n\n") : "No response from OpenClaw.";
				accumulatedText = content;
				sawAssistantDelta = true;
				writeSseEvent(res, {
					type: "response.output_text.delta",
					item_id: outputItemId,
					output_index: 0,
					content_index: 0,
					delta: content
				});
			}
		} catch (err) {
			logWarn(`openresponses: streaming response failed: ${String(err)}`);
			if (closed) return;
			finalUsage = finalUsage ?? createEmptyUsage();
			writeSseEvent(res, {
				type: "response.failed",
				response: createResponseResource({
					id: responseId,
					model,
					status: "failed",
					output: [],
					error: {
						code: "api_error",
						message: "internal error"
					},
					usage: finalUsage
				})
			});
			emitAgentEvent({
				runId: responseId,
				stream: "lifecycle",
				data: { phase: "error" }
			});
		} finally {
			if (!closed) emitAgentEvent({
				runId: responseId,
				stream: "lifecycle",
				data: { phase: "end" }
			});
		}
	})();
	return true;
}
//#endregion
//#region src/gateway/server/http-auth.ts
function isCanvasPath(pathname) {
	return pathname === "/__openclaw__/a2ui" || pathname.startsWith(`/__openclaw__/a2ui/`) || pathname === "/__openclaw__/canvas" || pathname.startsWith(`/__openclaw__/canvas/`) || pathname === "/__openclaw__/ws";
}
function isNodeWsClient(client) {
	if (client.connect.role === "node") return true;
	return normalizeGatewayClientMode(client.connect.client.mode) === GATEWAY_CLIENT_MODES.NODE;
}
function hasAuthorizedNodeWsClientForCanvasCapability(clients, capability) {
	const nowMs = Date.now();
	for (const client of clients) {
		if (!isNodeWsClient(client)) continue;
		if (!client.canvasCapability || !client.canvasCapabilityExpiresAtMs) continue;
		if (client.canvasCapabilityExpiresAtMs <= nowMs) continue;
		if (safeEqualSecret(client.canvasCapability, capability)) {
			client.canvasCapabilityExpiresAtMs = nowMs + CANVAS_CAPABILITY_TTL_MS;
			return true;
		}
	}
	return false;
}
async function authorizeCanvasRequest(params) {
	const { req, auth, trustedProxies, allowRealIpFallback, clients, canvasCapability, malformedScopedPath, rateLimiter } = params;
	if (malformedScopedPath) return {
		ok: false,
		reason: "unauthorized"
	};
	if (isLocalDirectRequest(req, trustedProxies, allowRealIpFallback)) return { ok: true };
	let lastAuthFailure = null;
	const token = getBearerToken(req);
	if (token) {
		const authResult = await authorizeHttpGatewayConnect({
			auth: {
				...auth,
				allowTailscale: false
			},
			connectAuth: {
				token,
				password: token
			},
			req,
			trustedProxies,
			allowRealIpFallback,
			rateLimiter
		});
		if (authResult.ok) return authResult;
		lastAuthFailure = authResult;
	}
	if (canvasCapability && hasAuthorizedNodeWsClientForCanvasCapability(clients, canvasCapability)) return { ok: true };
	return lastAuthFailure ?? {
		ok: false,
		reason: "unauthorized"
	};
}
async function enforcePluginRouteGatewayAuth(params) {
	return await authorizeGatewayBearerRequestOrReply(params);
}
//#endregion
//#region src/gateway/server/plugins-http/path-context.ts
init_security_path();
function normalizeProtectedPrefix(prefix) {
	const collapsed = prefix.toLowerCase().replace(/\/{2,}/g, "/");
	if (collapsed.length <= 1) return collapsed || "/";
	return collapsed.replace(/\/+$/, "");
}
function prefixMatchPath(pathname, prefix) {
	return pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}%`);
}
const NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES = PROTECTED_PLUGIN_ROUTE_PREFIXES.map(normalizeProtectedPrefix);
function isProtectedPluginRoutePathFromContext(context) {
	if (context.candidates.some((candidate) => NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES.some((prefix) => prefixMatchPath(candidate, prefix)))) return true;
	if (!context.malformedEncoding) return false;
	return NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES.some((prefix) => prefixMatchPath(context.rawNormalizedPath, prefix));
}
function resolvePluginRoutePathContext(pathname) {
	const canonical = canonicalizePathForSecurity(pathname);
	return {
		pathname,
		canonicalPath: canonical.canonicalPath,
		candidates: canonical.candidates,
		malformedEncoding: canonical.malformedEncoding,
		decodePassLimitReached: canonical.decodePassLimitReached,
		rawNormalizedPath: canonical.rawNormalizedPath
	};
}
//#endregion
//#region src/gateway/server/plugins-http/route-match.ts
init_security_path();
function doesPluginRouteMatchPath(route, context) {
	const routeCanonicalPath = canonicalizePathVariant(route.path);
	if (route.match === "prefix") return context.candidates.some((candidate) => prefixMatchPath(candidate, routeCanonicalPath));
	return context.candidates.some((candidate) => candidate === routeCanonicalPath);
}
function findMatchingPluginHttpRoutes(registry, context) {
	const routes = registry.httpRoutes ?? [];
	if (routes.length === 0) return [];
	const exactMatches = [];
	const prefixMatches = [];
	for (const route of routes) {
		if (!doesPluginRouteMatchPath(route, context)) continue;
		if (route.match === "prefix") prefixMatches.push(route);
		else exactMatches.push(route);
	}
	exactMatches.sort((a, b) => b.path.length - a.path.length);
	prefixMatches.sort((a, b) => b.path.length - a.path.length);
	return [...exactMatches, ...prefixMatches];
}
//#endregion
//#region src/gateway/server/plugins-http/route-auth.ts
function matchedPluginRoutesRequireGatewayAuth(routes) {
	return routes.some((route) => route.auth === "gateway");
}
function shouldEnforceGatewayAuthForPluginPath(registry, pathnameOrContext) {
	const pathContext = typeof pathnameOrContext === "string" ? resolvePluginRoutePathContext(pathnameOrContext) : pathnameOrContext;
	if (pathContext.malformedEncoding || pathContext.decodePassLimitReached) return true;
	if (isProtectedPluginRoutePathFromContext(pathContext)) return true;
	return matchedPluginRoutesRequireGatewayAuth(findMatchingPluginHttpRoutes(registry, pathContext));
}
//#endregion
//#region src/gateway/server/plugins-http.ts
init_runtime$1();
function createPluginRouteRuntimeClient(params) {
	const scopes = params.requiresGatewayAuth && params.gatewayAuthSatisfied !== false ? [
		ADMIN_SCOPE$3,
		APPROVALS_SCOPE$1,
		PAIRING_SCOPE$1
	] : [WRITE_SCOPE];
	return { connect: {
		minProtocol: 3,
		maxProtocol: 3,
		client: {
			id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
			version: "internal",
			platform: "node",
			mode: GATEWAY_CLIENT_MODES.BACKEND
		},
		role: "operator",
		scopes
	} };
}
function createGatewayPluginRequestHandler(params) {
	const { log } = params;
	return async (req, res, providedPathContext, dispatchContext) => {
		const registry = resolveActivePluginHttpRouteRegistry(params.registry);
		if ((registry.httpRoutes ?? []).length === 0) return false;
		const pathContext = providedPathContext ?? resolvePluginRoutePathContext(new URL(req.url ?? "/", "http://localhost").pathname);
		const matchedRoutes = findMatchingPluginHttpRoutes(registry, pathContext);
		if (matchedRoutes.length === 0) return false;
		const requiresGatewayAuth = matchedPluginRoutesRequireGatewayAuth(matchedRoutes);
		if (requiresGatewayAuth && dispatchContext?.gatewayAuthSatisfied === false) {
			log.warn(`plugin http route blocked without gateway auth (${pathContext.canonicalPath})`);
			return false;
		}
		return await withPluginRuntimeGatewayRequestScope({
			client: createPluginRouteRuntimeClient({
				requiresGatewayAuth,
				gatewayAuthSatisfied: dispatchContext?.gatewayAuthSatisfied
			}),
			isWebchatConnect: () => false
		}, async () => {
			for (const route of matchedRoutes) try {
				if (await route.handler(req, res) !== false) return true;
			} catch (err) {
				log.warn(`plugin http route failed (${route.pluginId ?? "unknown"}): ${String(err)}`);
				if (!res.headersSent) {
					res.statusCode = 500;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end("Internal Server Error");
				}
				return true;
			}
			return false;
		});
	};
}
//#endregion
//#region src/gateway/tools-invoke-http.ts
init_session_key();
const DEFAULT_BODY_BYTES = 2 * 1024 * 1024;
const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);
function resolveSessionKeyFromBody(body) {
	if (typeof body.sessionKey === "string" && body.sessionKey.trim()) return body.sessionKey.trim();
}
function resolveMemoryToolDisableReasons(cfg) {
	if (!process.env.VITEST) return [];
	const reasons = [];
	const plugins = cfg.plugins;
	const slotRaw = plugins?.slots?.memory;
	const slotDisabled = slotRaw === null || typeof slotRaw === "string" && slotRaw.trim().toLowerCase() === "none";
	const pluginsDisabled = plugins?.enabled === false;
	const defaultDisabled = isTestDefaultMemorySlotDisabled(cfg);
	if (pluginsDisabled) reasons.push("plugins.enabled=false");
	if (slotDisabled) reasons.push(slotRaw === null ? "plugins.slots.memory=null" : "plugins.slots.memory=\"none\"");
	if (!pluginsDisabled && !slotDisabled && defaultDisabled) reasons.push("memory plugin disabled by test default");
	return reasons;
}
function mergeActionIntoArgsIfSupported(params) {
	const { toolSchema, action, args } = params;
	if (!action) return args;
	if (args.action !== void 0) return args;
	const schemaObj = toolSchema;
	if (!Boolean(schemaObj && typeof schemaObj === "object" && schemaObj.properties && "action" in schemaObj.properties)) return args;
	return {
		...args,
		action
	};
}
function getErrorMessage(err) {
	if (err instanceof Error) return err.message || String(err);
	if (typeof err === "string") return err;
	return String(err);
}
function resolveToolInputErrorStatus(err) {
	if (err instanceof ToolInputError) {
		const status = err.status;
		return typeof status === "number" ? status : 400;
	}
	if (typeof err !== "object" || err === null || !("name" in err)) return null;
	const name = err.name;
	if (name !== "ToolInputError" && name !== "ToolAuthorizationError") return null;
	const status = err.status;
	if (typeof status === "number") return status;
	return name === "ToolAuthorizationError" ? 403 : 400;
}
async function handleToolsInvokeHttpRequest(req, res, opts) {
	if (new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname !== "/tools/invoke") return false;
	if (req.method !== "POST") {
		sendMethodNotAllowed(res, "POST");
		return true;
	}
	const cfg = loadConfig();
	const token = getBearerToken(req);
	const authResult = await authorizeHttpGatewayConnect({
		auth: opts.auth,
		connectAuth: token ? {
			token,
			password: token
		} : null,
		req,
		trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
		rateLimiter: opts.rateLimiter
	});
	if (!authResult.ok) {
		sendGatewayAuthFailure(res, authResult);
		return true;
	}
	const bodyUnknown = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? DEFAULT_BODY_BYTES);
	if (bodyUnknown === void 0) return true;
	const body = bodyUnknown ?? {};
	const toolName = typeof body.tool === "string" ? body.tool.trim() : "";
	if (!toolName) {
		sendInvalidRequest(res, "tools.invoke requires body.tool");
		return true;
	}
	if (process.env.VITEST && MEMORY_TOOL_NAMES.has(toolName)) {
		const reasons = resolveMemoryToolDisableReasons(cfg);
		if (reasons.length > 0) {
			sendJson$1(res, 400, {
				ok: false,
				error: {
					type: "invalid_request",
					message: `memory tools are disabled in tests${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}. Enable by setting plugins.slots.memory="memory-core" (and ensure plugins.enabled is not false).`
				}
			});
			return true;
		}
	}
	const action = typeof body.action === "string" ? body.action.trim() : void 0;
	const argsRaw = body.args;
	const args = argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw) ? argsRaw : {};
	const rawSessionKey = resolveSessionKeyFromBody(body);
	const sessionKey = !rawSessionKey || rawSessionKey === "main" ? resolveMainSessionKey(cfg) : rawSessionKey;
	const messageChannel = normalizeMessageChannel(getHeader(req, "x-openclaw-message-channel") ?? "");
	const accountId = getHeader(req, "x-openclaw-account-id")?.trim() || void 0;
	const agentTo = getHeader(req, "x-openclaw-message-to")?.trim() || void 0;
	const agentThreadId = getHeader(req, "x-openclaw-thread-id")?.trim() || void 0;
	const { agentId, globalPolicy, globalProviderPolicy, agentPolicy, agentProviderPolicy, profile, providerProfile, profileAlsoAllow, providerProfileAlsoAllow } = resolveEffectiveToolPolicy({
		config: cfg,
		sessionKey
	});
	const profilePolicy = resolveToolProfilePolicy(profile);
	const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
	const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
	const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(providerProfilePolicy, providerProfileAlsoAllow);
	const groupPolicy = resolveGroupToolPolicy({
		config: cfg,
		sessionKey,
		messageProvider: messageChannel ?? void 0,
		accountId: accountId ?? null
	});
	const subagentPolicy = isSubagentSessionKey(sessionKey) ? resolveSubagentToolPolicy(cfg) : void 0;
	const subagentFiltered = applyToolPolicyPipeline({
		tools: createOpenClawTools({
			agentSessionKey: sessionKey,
			agentChannel: messageChannel ?? void 0,
			agentAccountId: accountId,
			agentTo,
			agentThreadId,
			allowMediaInvokeCommands: true,
			config: cfg,
			pluginToolAllowlist: collectExplicitAllowlist([
				profilePolicy,
				providerProfilePolicy,
				globalPolicy,
				globalProviderPolicy,
				agentPolicy,
				agentProviderPolicy,
				groupPolicy,
				subagentPolicy
			])
		}),
		toolMeta: (tool) => getPluginToolMeta(tool),
		warn: logWarn,
		steps: [...buildDefaultToolPolicyPipelineSteps({
			profilePolicy: profilePolicyWithAlsoAllow,
			profile,
			providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
			providerProfile,
			globalPolicy,
			globalProviderPolicy,
			agentPolicy,
			agentProviderPolicy,
			groupPolicy,
			agentId
		}), {
			policy: subagentPolicy,
			label: "subagent tools.allow"
		}]
	});
	const gatewayToolsCfg = cfg.gateway?.tools;
	const gatewayDenyNames = DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) => !gatewayToolsCfg?.allow?.includes(name)).concat(Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : []);
	const gatewayDenySet = new Set(gatewayDenyNames);
	const tool = subagentFiltered.filter((t) => !gatewayDenySet.has(t.name)).find((t) => t.name === toolName);
	if (!tool) {
		sendJson$1(res, 404, {
			ok: false,
			error: {
				type: "not_found",
				message: `Tool not available: ${toolName}`
			}
		});
		return true;
	}
	try {
		const toolCallId = `http-${Date.now()}`;
		const hookResult = await runBeforeToolCallHook({
			toolName,
			params: mergeActionIntoArgsIfSupported({
				toolSchema: tool.parameters,
				action,
				args
			}),
			toolCallId,
			ctx: {
				agentId,
				sessionKey,
				loopDetection: resolveToolLoopDetectionConfig({
					cfg,
					agentId
				})
			}
		});
		if (hookResult.blocked) {
			sendJson$1(res, 403, {
				ok: false,
				error: {
					type: "tool_call_blocked",
					message: hookResult.reason
				}
			});
			return true;
		}
		sendJson$1(res, 200, {
			ok: true,
			result: await tool.execute?.(toolCallId, hookResult.params)
		});
	} catch (err) {
		const inputStatus = resolveToolInputErrorStatus(err);
		if (inputStatus !== null) {
			sendJson$1(res, inputStatus, {
				ok: false,
				error: {
					type: "tool_error",
					message: getErrorMessage(err) || "invalid tool arguments"
				}
			});
			return true;
		}
		logWarn(`tools-invoke: tool execution failed: ${String(err)}`);
		sendJson$1(res, 500, {
			ok: false,
			error: {
				type: "tool_error",
				message: "tool execution failed"
			}
		});
	}
	return true;
}
//#endregion
//#region src/gateway/server-http.ts
const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 6e4;
function sendJson(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}
const GATEWAY_PROBE_STATUS_BY_PATH = new Map([
	["/health", "live"],
	["/healthz", "live"],
	["/ready", "ready"],
	["/readyz", "ready"]
]);
const MATTERMOST_SLASH_CALLBACK_PATH = "/api/channels/mattermost/command";
function resolveMattermostSlashCallbackPaths(configSnapshot) {
	const callbackPaths = new Set([MATTERMOST_SLASH_CALLBACK_PATH]);
	const isMattermostCommandCallbackPath = (path) => path === MATTERMOST_SLASH_CALLBACK_PATH || path.startsWith("/api/channels/mattermost/");
	const normalizeCallbackPath = (value) => {
		const trimmed = typeof value === "string" ? value.trim() : "";
		if (!trimmed) return MATTERMOST_SLASH_CALLBACK_PATH;
		return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	};
	const tryAddCallbackUrlPath = (rawUrl) => {
		if (typeof rawUrl !== "string") return;
		const trimmed = rawUrl.trim();
		if (!trimmed) return;
		try {
			const pathname = new URL(trimmed).pathname;
			if (pathname && isMattermostCommandCallbackPath(pathname)) callbackPaths.add(pathname);
		} catch {}
	};
	const mmRaw = configSnapshot.channels?.mattermost;
	const addMmCommands = (raw) => {
		if (raw == null || typeof raw !== "object") return;
		const commands = raw;
		const callbackPath = normalizeCallbackPath(commands.callbackPath);
		if (isMattermostCommandCallbackPath(callbackPath)) callbackPaths.add(callbackPath);
		tryAddCallbackUrlPath(commands.callbackUrl);
	};
	addMmCommands(mmRaw?.commands);
	const accountsRaw = mmRaw?.accounts ?? {};
	for (const accountId of Object.keys(accountsRaw)) {
		const accountCfg = accountsRaw[accountId];
		addMmCommands(accountCfg?.commands);
	}
	return callbackPaths;
}
function shouldEnforceDefaultPluginGatewayAuth(pathContext) {
	return pathContext.malformedEncoding || pathContext.decodePassLimitReached || isProtectedPluginRoutePathFromContext(pathContext);
}
async function canRevealReadinessDetails(params) {
	if (isLocalDirectRequest(params.req, params.trustedProxies, params.allowRealIpFallback)) return true;
	if (params.resolvedAuth.mode === "none") return false;
	const bearerToken = getBearerToken(params.req);
	return (await authorizeHttpGatewayConnect({
		auth: params.resolvedAuth,
		connectAuth: bearerToken ? {
			token: bearerToken,
			password: bearerToken
		} : null,
		req: params.req,
		trustedProxies: params.trustedProxies,
		allowRealIpFallback: params.allowRealIpFallback
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
async function runGatewayHttpRequestStages(stages) {
	for (const stage of stages) if (await stage.run()) return true;
	return false;
}
function buildPluginRequestStages(params) {
	if (!params.handlePluginRequest) return [];
	let pluginGatewayAuthSatisfied = false;
	return [{
		name: "plugin-auth",
		run: async () => {
			if (params.mattermostSlashCallbackPaths.has(params.requestPath)) return false;
			const pathContext = params.pluginPathContext ?? resolvePluginRoutePathContext(params.requestPath);
			if (!(params.shouldEnforcePluginGatewayAuth ?? shouldEnforceDefaultPluginGatewayAuth)(pathContext)) return false;
			if (!await enforcePluginRouteGatewayAuth({
				req: params.req,
				res: params.res,
				auth: params.resolvedAuth,
				trustedProxies: params.trustedProxies,
				allowRealIpFallback: params.allowRealIpFallback,
				rateLimiter: params.rateLimiter
			})) return true;
			pluginGatewayAuthSatisfied = true;
			return false;
		}
	}, {
		name: "plugin-http",
		run: () => {
			const pathContext = params.pluginPathContext ?? resolvePluginRoutePathContext(params.requestPath);
			return params.handlePluginRequest?.(params.req, params.res, pathContext, { gatewayAuthSatisfied: pluginGatewayAuthSatisfied }) ?? false;
		}
	}];
}
function createHooksRequestHandler(opts) {
	const { getHooksConfig, logHooks, dispatchAgentHook, dispatchWakeHook, getClientIpConfig } = opts;
	const hookReplayCache = /* @__PURE__ */ new Map();
	const hookAuthLimiter = createAuthRateLimiter({
		maxAttempts: HOOK_AUTH_FAILURE_LIMIT,
		windowMs: HOOK_AUTH_FAILURE_WINDOW_MS,
		lockoutMs: HOOK_AUTH_FAILURE_WINDOW_MS,
		exemptLoopback: false,
		pruneIntervalMs: 0
	});
	const resolveHookClientKey = (req) => {
		const clientIpConfig = getClientIpConfig?.();
		return normalizeRateLimitClientIp(resolveRequestClientIp(req, clientIpConfig?.trustedProxies, clientIpConfig?.allowRealIpFallback === true) ?? req.socket?.remoteAddress);
	};
	const pruneHookReplayCache = (now) => {
		const cutoff = now - DEDUPE_TTL_MS;
		for (const [key, entry] of hookReplayCache) if (entry.ts < cutoff) hookReplayCache.delete(key);
		while (hookReplayCache.size > DEDUPE_MAX) {
			const oldestKey = hookReplayCache.keys().next().value;
			if (!oldestKey) break;
			hookReplayCache.delete(oldestKey);
		}
	};
	const buildHookReplayCacheKey = (params) => {
		const idem = params.idempotencyKey?.trim();
		if (!idem) return;
		const tokenFingerprint = createHash("sha256").update(params.token ?? "", "utf8").digest("hex");
		const idempotencyFingerprint = createHash("sha256").update(idem, "utf8").digest("hex");
		return `${tokenFingerprint}:${createHash("sha256").update(JSON.stringify({
			pathKey: params.pathKey,
			dispatchScope: params.dispatchScope
		}), "utf8").digest("hex")}:${idempotencyFingerprint}`;
	};
	const resolveCachedHookRunId = (key, now) => {
		if (!key) return;
		pruneHookReplayCache(now);
		const cached = hookReplayCache.get(key);
		if (!cached) return;
		hookReplayCache.delete(key);
		hookReplayCache.set(key, cached);
		return cached.runId;
	};
	const rememberHookRunId = (key, runId, now) => {
		if (!key) return;
		hookReplayCache.delete(key);
		hookReplayCache.set(key, {
			ts: now,
			runId
		});
		pruneHookReplayCache(now);
	};
	return async (req, res) => {
		const hooksConfig = getHooksConfig();
		if (!hooksConfig) return false;
		const url = new URL(req.url ?? "/", "http://localhost");
		const basePath = hooksConfig.basePath;
		if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return false;
		if (url.searchParams.has("token")) {
			res.statusCode = 400;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Hook token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed).");
			return true;
		}
		if (req.method !== "POST") {
			res.statusCode = 405;
			res.setHeader("Allow", "POST");
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Method Not Allowed");
			return true;
		}
		const token = extractHookToken(req);
		const clientKey = resolveHookClientKey(req);
		if (!safeEqualSecret(token, hooksConfig.token)) {
			const throttle = hookAuthLimiter.check(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
			if (!throttle.allowed) {
				const retryAfter = throttle.retryAfterMs > 0 ? Math.ceil(throttle.retryAfterMs / 1e3) : 1;
				res.statusCode = 429;
				res.setHeader("Retry-After", String(retryAfter));
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end("Too Many Requests");
				logHooks.warn(`hook auth throttled for ${clientKey}; retry-after=${retryAfter}s`);
				return true;
			}
			hookAuthLimiter.recordFailure(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
			res.statusCode = 401;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Unauthorized");
			return true;
		}
		hookAuthLimiter.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
		const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
		if (!subPath) {
			res.statusCode = 404;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Not Found");
			return true;
		}
		const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
		if (!body.ok) {
			sendJson(res, body.error === "payload too large" ? 413 : body.error === "request body timeout" ? 408 : 400, {
				ok: false,
				error: body.error
			});
			return true;
		}
		const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
		const headers = normalizeHookHeaders(req);
		const idempotencyKey = resolveHookIdempotencyKey({
			payload,
			headers
		});
		const now = Date.now();
		if (subPath === "wake") {
			const normalized = normalizeWakePayload(payload);
			if (!normalized.ok) {
				sendJson(res, 400, {
					ok: false,
					error: normalized.error
				});
				return true;
			}
			dispatchWakeHook(normalized.value);
			sendJson(res, 200, {
				ok: true,
				mode: normalized.value.mode
			});
			return true;
		}
		if (subPath === "agent") {
			const normalized = normalizeAgentPayload(payload);
			if (!normalized.ok) {
				sendJson(res, 400, {
					ok: false,
					error: normalized.error
				});
				return true;
			}
			if (!isHookAgentAllowed(hooksConfig, normalized.value.agentId)) {
				sendJson(res, 400, {
					ok: false,
					error: getHookAgentPolicyError()
				});
				return true;
			}
			const sessionKey = resolveHookSessionKey({
				hooksConfig,
				source: "request",
				sessionKey: normalized.value.sessionKey
			});
			if (!sessionKey.ok) {
				sendJson(res, 400, {
					ok: false,
					error: sessionKey.error
				});
				return true;
			}
			const targetAgentId = resolveHookTargetAgentId(hooksConfig, normalized.value.agentId);
			const replayKey = buildHookReplayCacheKey({
				pathKey: "agent",
				token,
				idempotencyKey,
				dispatchScope: {
					agentId: targetAgentId ?? null,
					sessionKey: normalized.value.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
					message: normalized.value.message,
					name: normalized.value.name,
					wakeMode: normalized.value.wakeMode,
					deliver: normalized.value.deliver,
					channel: normalized.value.channel,
					to: normalized.value.to ?? null,
					model: normalized.value.model ?? null,
					thinking: normalized.value.thinking ?? null,
					timeoutSeconds: normalized.value.timeoutSeconds ?? null
				}
			});
			const cachedRunId = resolveCachedHookRunId(replayKey, now);
			if (cachedRunId) {
				sendJson(res, 200, {
					ok: true,
					runId: cachedRunId
				});
				return true;
			}
			const normalizedDispatchSessionKey = normalizeHookDispatchSessionKey({
				sessionKey: sessionKey.value,
				targetAgentId
			});
			const runId = dispatchAgentHook({
				...normalized.value,
				idempotencyKey,
				sessionKey: normalizedDispatchSessionKey,
				agentId: targetAgentId
			});
			rememberHookRunId(replayKey, runId, now);
			sendJson(res, 200, {
				ok: true,
				runId
			});
			return true;
		}
		if (hooksConfig.mappings.length > 0) try {
			const mapped = await applyHookMappings(hooksConfig.mappings, {
				payload,
				headers,
				url,
				path: subPath
			});
			if (mapped) {
				if (!mapped.ok) {
					sendJson(res, 400, {
						ok: false,
						error: mapped.error
					});
					return true;
				}
				if (mapped.action === null) {
					res.statusCode = 204;
					res.end();
					return true;
				}
				if (mapped.action.kind === "wake") {
					dispatchWakeHook({
						text: mapped.action.text,
						mode: mapped.action.mode
					});
					sendJson(res, 200, {
						ok: true,
						mode: mapped.action.mode
					});
					return true;
				}
				const channel = resolveHookChannel(mapped.action.channel);
				if (!channel) {
					sendJson(res, 400, {
						ok: false,
						error: getHookChannelError()
					});
					return true;
				}
				if (!isHookAgentAllowed(hooksConfig, mapped.action.agentId)) {
					sendJson(res, 400, {
						ok: false,
						error: getHookAgentPolicyError()
					});
					return true;
				}
				const sessionKey = resolveHookSessionKey({
					hooksConfig,
					source: "mapping",
					sessionKey: mapped.action.sessionKey
				});
				if (!sessionKey.ok) {
					sendJson(res, 400, {
						ok: false,
						error: sessionKey.error
					});
					return true;
				}
				const targetAgentId = resolveHookTargetAgentId(hooksConfig, mapped.action.agentId);
				const normalizedDispatchSessionKey = normalizeHookDispatchSessionKey({
					sessionKey: sessionKey.value,
					targetAgentId
				});
				const replayKey = buildHookReplayCacheKey({
					pathKey: subPath || "mapping",
					token,
					idempotencyKey,
					dispatchScope: {
						agentId: targetAgentId ?? null,
						sessionKey: mapped.action.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
						message: mapped.action.message,
						name: mapped.action.name ?? "Hook",
						wakeMode: mapped.action.wakeMode,
						deliver: resolveHookDeliver(mapped.action.deliver),
						channel,
						to: mapped.action.to ?? null,
						model: mapped.action.model ?? null,
						thinking: mapped.action.thinking ?? null,
						timeoutSeconds: mapped.action.timeoutSeconds ?? null
					}
				});
				const cachedRunId = resolveCachedHookRunId(replayKey, now);
				if (cachedRunId) {
					sendJson(res, 200, {
						ok: true,
						runId: cachedRunId
					});
					return true;
				}
				const runId = dispatchAgentHook({
					message: mapped.action.message,
					name: mapped.action.name ?? "Hook",
					idempotencyKey,
					agentId: targetAgentId,
					wakeMode: mapped.action.wakeMode,
					sessionKey: normalizedDispatchSessionKey,
					deliver: resolveHookDeliver(mapped.action.deliver),
					channel,
					to: mapped.action.to,
					model: mapped.action.model,
					thinking: mapped.action.thinking,
					timeoutSeconds: mapped.action.timeoutSeconds,
					allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent
				});
				rememberHookRunId(replayKey, runId, now);
				sendJson(res, 200, {
					ok: true,
					runId
				});
				return true;
			}
		} catch (err) {
			logHooks.warn(`hook mapping failed: ${String(err)}`);
			sendJson(res, 500, {
				ok: false,
				error: "hook mapping failed"
			});
			return true;
		}
		res.statusCode = 404;
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end("Not Found");
		return true;
	};
}
function createGatewayHttpServer(opts) {
	const { canvasHost, clients, controlUiEnabled, controlUiBasePath, controlUiRoot, openAiChatCompletionsEnabled, openAiChatCompletionsConfig, openResponsesEnabled, openResponsesConfig, strictTransportSecurityHeader, handleHooksRequest, handlePluginRequest, shouldEnforcePluginGatewayAuth, resolvedAuth, rateLimiter, getReadiness } = opts;
	const httpServer = opts.tlsOptions ? createServer$2(opts.tlsOptions, (req, res) => {
		handleRequest(req, res);
	}) : createServer$1((req, res) => {
		handleRequest(req, res);
	});
	async function handleRequest(req, res) {
		setDefaultSecurityHeaders(res, { strictTransportSecurity: strictTransportSecurityHeader });
		if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") return;
		try {
			const configSnapshot = loadConfig();
			const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
			const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
			const scopedCanvas = normalizeCanvasScopedUrl(req.url ?? "/");
			if (scopedCanvas.malformedScopedPath) {
				sendGatewayAuthFailure(res, {
					ok: false,
					reason: "unauthorized"
				});
				return;
			}
			if (scopedCanvas.rewrittenUrl) req.url = scopedCanvas.rewrittenUrl;
			const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
			const mattermostSlashCallbackPaths = resolveMattermostSlashCallbackPaths(configSnapshot);
			const pluginPathContext = handlePluginRequest ? resolvePluginRoutePathContext(requestPath) : null;
			const requestStages = [
				{
					name: "hooks",
					run: () => handleHooksRequest(req, res)
				},
				{
					name: "tools-invoke",
					run: () => handleToolsInvokeHttpRequest(req, res, {
						auth: resolvedAuth,
						trustedProxies,
						allowRealIpFallback,
						rateLimiter
					})
				},
				{
					name: "slack",
					run: () => handleSlackHttpRequest(req, res)
				}
			];
			if (openResponsesEnabled) requestStages.push({
				name: "openresponses",
				run: () => handleOpenResponsesHttpRequest(req, res, {
					auth: resolvedAuth,
					config: openResponsesConfig,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter
				})
			});
			if (openAiChatCompletionsEnabled) requestStages.push({
				name: "openai",
				run: () => handleOpenAiHttpRequest(req, res, {
					auth: resolvedAuth,
					config: openAiChatCompletionsConfig,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter
				})
			});
			if (canvasHost) {
				requestStages.push({
					name: "canvas-auth",
					run: async () => {
						if (!isCanvasPath(requestPath)) return false;
						const ok = await authorizeCanvasRequest({
							req,
							auth: resolvedAuth,
							trustedProxies,
							allowRealIpFallback,
							clients,
							canvasCapability: scopedCanvas.capability,
							malformedScopedPath: scopedCanvas.malformedScopedPath,
							rateLimiter
						});
						if (!ok.ok) {
							sendGatewayAuthFailure(res, ok);
							return true;
						}
						return false;
					}
				});
				requestStages.push({
					name: "a2ui",
					run: () => handleA2uiHttpRequest(req, res)
				});
				requestStages.push({
					name: "canvas-http",
					run: () => canvasHost.handleHttpRequest(req, res)
				});
			}
			requestStages.push(...buildPluginRequestStages({
				req,
				res,
				requestPath,
				mattermostSlashCallbackPaths,
				pluginPathContext,
				handlePluginRequest,
				shouldEnforcePluginGatewayAuth,
				resolvedAuth,
				trustedProxies,
				allowRealIpFallback,
				rateLimiter
			}));
			if (controlUiEnabled) {
				requestStages.push({
					name: "control-ui-avatar",
					run: () => handleControlUiAvatarRequest(req, res, {
						basePath: controlUiBasePath,
						resolveAvatar: (agentId) => resolveAgentAvatar(configSnapshot, agentId)
					})
				});
				requestStages.push({
					name: "control-ui-http",
					run: () => handleControlUiHttpRequest(req, res, {
						basePath: controlUiBasePath,
						config: configSnapshot,
						root: controlUiRoot
					})
				});
			}
			requestStages.push({
				name: "gateway-probes",
				run: () => handleGatewayProbeRequest(req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback, getReadiness)
			});
			if (await runGatewayHttpRequestStages(requestStages)) return;
			res.statusCode = 404;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Not Found");
		} catch {
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Internal Server Error");
		}
	}
	return httpServer;
}
function attachGatewayUpgradeHandler(opts) {
	const { httpServer, wss, canvasHost, clients, resolvedAuth, rateLimiter } = opts;
	httpServer.on("upgrade", (req, socket, head) => {
		(async () => {
			const scopedCanvas = normalizeCanvasScopedUrl(req.url ?? "/");
			if (scopedCanvas.malformedScopedPath) {
				writeUpgradeAuthFailure(socket, {
					ok: false,
					reason: "unauthorized"
				});
				socket.destroy();
				return;
			}
			if (scopedCanvas.rewrittenUrl) req.url = scopedCanvas.rewrittenUrl;
			if (canvasHost) {
				if (new URL(req.url ?? "/", "http://localhost").pathname === "/__openclaw__/ws") {
					const configSnapshot = loadConfig();
					const ok = await authorizeCanvasRequest({
						req,
						auth: resolvedAuth,
						trustedProxies: configSnapshot.gateway?.trustedProxies ?? [],
						allowRealIpFallback: configSnapshot.gateway?.allowRealIpFallback === true,
						clients,
						canvasCapability: scopedCanvas.capability,
						malformedScopedPath: scopedCanvas.malformedScopedPath,
						rateLimiter
					});
					if (!ok.ok) {
						writeUpgradeAuthFailure(socket, ok);
						socket.destroy();
						return;
					}
				}
				if (canvasHost.handleUpgrade(req, socket, head)) return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				wss.emit("connection", ws, req);
			});
		})().catch(() => {
			socket.destroy();
		});
	});
}
//#endregion
//#region src/gateway/server/hooks.ts
function resolveHookClientIpConfig(cfg) {
	return {
		trustedProxies: cfg.gateway?.trustedProxies,
		allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true
	};
}
function createGatewayHooksRequestHandler(params) {
	const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;
	const dispatchWakeHook = (value) => {
		const sessionKey = resolveMainSessionKeyFromConfig();
		enqueueSystemEvent(value.text, { sessionKey });
		if (value.mode === "now") requestHeartbeatNow({ reason: "hook:wake" });
	};
	const dispatchAgentHook = (value) => {
		const sessionKey = normalizeHookDispatchSessionKey({
			sessionKey: value.sessionKey,
			targetAgentId: value.agentId
		});
		const mainSessionKey = resolveMainSessionKeyFromConfig();
		const jobId = randomUUID();
		const now = Date.now();
		const job = {
			id: jobId,
			agentId: value.agentId,
			name: value.name,
			enabled: true,
			createdAtMs: now,
			updatedAtMs: now,
			schedule: {
				kind: "at",
				at: new Date(now).toISOString()
			},
			sessionTarget: "isolated",
			wakeMode: value.wakeMode,
			payload: {
				kind: "agentTurn",
				message: value.message,
				model: value.model,
				thinking: value.thinking,
				timeoutSeconds: value.timeoutSeconds,
				deliver: value.deliver,
				channel: value.channel,
				to: value.to,
				allowUnsafeExternalContent: value.allowUnsafeExternalContent
			},
			state: { nextRunAtMs: now }
		};
		const runId = randomUUID();
		(async () => {
			try {
				const result = await runCronIsolatedAgentTurn({
					cfg: loadConfig(),
					deps,
					job,
					message: value.message,
					sessionKey,
					lane: "cron",
					deliveryContract: "shared"
				});
				const summary = result.summary?.trim() || result.error?.trim() || result.status;
				const prefix = result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;
				if (!result.delivered) {
					enqueueSystemEvent(`${prefix}: ${summary}`.trim(), { sessionKey: mainSessionKey });
					if (value.wakeMode === "now") requestHeartbeatNow({ reason: `hook:${jobId}` });
				}
			} catch (err) {
				logHooks.warn(`hook agent failed: ${String(err)}`);
				enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, { sessionKey: mainSessionKey });
				if (value.wakeMode === "now") requestHeartbeatNow({ reason: `hook:${jobId}:error` });
			}
		})();
		return runId;
	};
	return createHooksRequestHandler({
		getHooksConfig,
		bindHost,
		port,
		logHooks,
		getClientIpConfig,
		dispatchAgentHook,
		dispatchWakeHook
	});
}
//#endregion
//#region src/gateway/server-reload-handlers.ts
function createGatewayReloadHandlers(params) {
	const applyHotReload = async (plan, nextConfig) => {
		setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
		const state = params.getState();
		const nextState = { ...state };
		if (plan.reloadHooks) try {
			nextState.hooksConfig = resolveHooksConfig(nextConfig);
		} catch (err) {
			params.logHooks.warn(`hooks config reload failed: ${String(err)}`);
		}
		nextState.hookClientIpConfig = resolveHookClientIpConfig(nextConfig);
		if (plan.restartHeartbeat) nextState.heartbeatRunner.updateConfig(nextConfig);
		resetDirectoryCache();
		if (plan.restartCron) {
			state.cronState.cron.stop();
			nextState.cronState = buildGatewayCronService({
				cfg: nextConfig,
				deps: params.deps,
				broadcast: params.broadcast
			});
			nextState.cronState.cron.start().catch((err) => params.logCron.error(`failed to start: ${String(err)}`));
		}
		if (plan.restartBrowserControl) {
			if (state.browserControl) await state.browserControl.stop().catch(() => {});
			try {
				nextState.browserControl = await startBrowserControlServerIfEnabled();
			} catch (err) {
				params.logBrowser.error(`server failed to start: ${String(err)}`);
			}
		}
		if (plan.restartHealthMonitor) {
			state.channelHealthMonitor?.stop();
			const minutes = nextConfig.gateway?.channelHealthCheckMinutes;
			const staleMinutes = nextConfig.gateway?.channelStaleEventThresholdMinutes;
			nextState.channelHealthMonitor = minutes === 0 ? null : params.createHealthMonitor({
				checkIntervalMs: (minutes ?? 5) * 6e4,
				...staleMinutes != null && { staleEventThresholdMs: staleMinutes * 6e4 },
				...nextConfig.gateway?.channelMaxRestartsPerHour != null && { maxRestartsPerHour: nextConfig.gateway.channelMaxRestartsPerHour }
			});
		}
		if (plan.restartGmailWatcher) {
			await stopGmailWatcher().catch(() => {});
			await startGmailWatcherWithLogs({
				cfg: nextConfig,
				log: params.logHooks,
				onSkipped: () => params.logHooks.info("skipping gmail watcher restart (OPENCLAW_SKIP_GMAIL_WATCHER=1)")
			});
		}
		if (plan.restartChannels.size > 0) if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) || isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)) params.logChannels.info("skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)");
		else {
			const restartChannel = async (name) => {
				params.logChannels.info(`restarting ${name} channel`);
				await params.stopChannel(name);
				await params.startChannel(name);
			};
			for (const channel of plan.restartChannels) await restartChannel(channel);
		}
		setCommandLaneConcurrency(CommandLane.Cron, nextConfig.cron?.maxConcurrentRuns ?? 1);
		setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(nextConfig));
		setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(nextConfig));
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
			return;
		}
		const getActiveCounts = () => {
			const queueSize = getTotalQueueSize();
			const pendingReplies = getTotalPendingReplies();
			const embeddedRuns = getActiveEmbeddedRunCount();
			return {
				queueSize,
				pendingReplies,
				embeddedRuns,
				totalActive: queueSize + pendingReplies + embeddedRuns
			};
		};
		const formatActiveDetails = (counts) => {
			const details = [];
			if (counts.queueSize > 0) details.push(`${counts.queueSize} operation(s)`);
			if (counts.pendingReplies > 0) details.push(`${counts.pendingReplies} reply(ies)`);
			if (counts.embeddedRuns > 0) details.push(`${counts.embeddedRuns} embedded run(s)`);
			return details;
		};
		const active = getActiveCounts();
		if (active.totalActive > 0) {
			if (restartPending) {
				params.logReload.info(`config change requires gateway restart (${reasons}) — already waiting for operations to complete`);
				return;
			}
			restartPending = true;
			const initialDetails = formatActiveDetails(active);
			params.logReload.warn(`config change requires gateway restart (${reasons}) — deferring until ${initialDetails.join(", ")} complete`);
			deferGatewayRestartUntilIdle({
				getPendingCount: () => getActiveCounts().totalActive,
				maxWaitMs: nextConfig.gateway?.reload?.deferralTimeoutMs,
				hooks: {
					onReady: () => {
						restartPending = false;
						params.logReload.info("all operations and replies completed; restarting gateway now");
					},
					onTimeout: (_pending, elapsedMs) => {
						const remaining = formatActiveDetails(getActiveCounts());
						restartPending = false;
						params.logReload.warn(`restart timeout after ${elapsedMs}ms with ${remaining.join(", ")} still active; restarting anyway`);
					},
					onCheckError: (err) => {
						restartPending = false;
						params.logReload.warn(`restart deferral check failed (${String(err)}); restarting gateway now`);
					}
				}
			});
		} else {
			params.logReload.warn(`config change requires gateway restart (${reasons})`);
			if (!emitGatewayRestart()) params.logReload.info("gateway restart already scheduled; skipping duplicate signal");
		}
	};
	return {
		applyHotReload,
		requestGatewayRestart
	};
}
//#endregion
//#region src/gateway/server-runtime-config.ts
async function resolveGatewayRuntimeConfig(params) {
	const bindMode = params.bind ?? params.cfg.gateway?.bind ?? "loopback";
	const customBindHost = params.cfg.gateway?.customBindHost;
	const bindHost = params.host ?? await resolveGatewayBindHost(bindMode, customBindHost);
	if (bindMode === "loopback" && !isLoopbackHost(bindHost)) throw new Error(`gateway bind=loopback resolved to non-loopback host ${bindHost}; refusing fallback to a network bind`);
	if (bindMode === "custom") {
		const configuredCustomBindHost = customBindHost?.trim();
		if (!configuredCustomBindHost) throw new Error("gateway.bind=custom requires gateway.customBindHost");
		if (!isValidIPv4(configuredCustomBindHost)) throw new Error(`gateway.bind=custom requires a valid IPv4 customBindHost (got ${configuredCustomBindHost})`);
		if (bindHost !== configuredCustomBindHost) throw new Error(`gateway bind=custom requested ${configuredCustomBindHost} but resolved ${bindHost}; refusing fallback`);
	}
	const controlUiEnabled = params.controlUiEnabled ?? params.cfg.gateway?.controlUi?.enabled ?? true;
	const openAiChatCompletionsConfig = params.cfg.gateway?.http?.endpoints?.chatCompletions;
	const openAiChatCompletionsEnabled = params.openAiChatCompletionsEnabled ?? openAiChatCompletionsConfig?.enabled ?? false;
	const openResponsesConfig = params.cfg.gateway?.http?.endpoints?.responses;
	const openResponsesEnabled = params.openResponsesEnabled ?? openResponsesConfig?.enabled ?? false;
	const strictTransportSecurityConfig = params.cfg.gateway?.http?.securityHeaders?.strictTransportSecurity;
	const strictTransportSecurityHeader = strictTransportSecurityConfig === false ? void 0 : typeof strictTransportSecurityConfig === "string" && strictTransportSecurityConfig.trim().length > 0 ? strictTransportSecurityConfig.trim() : void 0;
	const controlUiBasePath = normalizeControlUiBasePath(params.cfg.gateway?.controlUi?.basePath);
	const controlUiRootRaw = params.cfg.gateway?.controlUi?.root;
	const controlUiRoot = typeof controlUiRootRaw === "string" && controlUiRootRaw.trim().length > 0 ? controlUiRootRaw.trim() : void 0;
	const tailscaleConfig = mergeGatewayTailscaleConfig(params.cfg.gateway?.tailscale ?? {}, params.tailscale ?? {});
	const tailscaleMode = tailscaleConfig.mode ?? "off";
	const resolvedAuth = resolveGatewayAuth({
		authConfig: params.cfg.gateway?.auth,
		authOverride: params.auth,
		env: process.env,
		tailscaleMode
	});
	const authMode = resolvedAuth.mode;
	const hasToken = typeof resolvedAuth.token === "string" && resolvedAuth.token.trim().length > 0;
	const hasPassword = typeof resolvedAuth.password === "string" && resolvedAuth.password.trim().length > 0;
	const hasSharedSecret = authMode === "token" && hasToken || authMode === "password" && hasPassword;
	const hooksConfig = resolveHooksConfig(params.cfg);
	const canvasHostEnabled = process.env.OPENCLAW_SKIP_CANVAS_HOST !== "1" && params.cfg.canvasHost?.enabled !== false;
	const trustedProxies = params.cfg.gateway?.trustedProxies ?? [];
	const controlUiAllowedOrigins = (params.cfg.gateway?.controlUi?.allowedOrigins ?? []).map((value) => value.trim()).filter(Boolean);
	const dangerouslyAllowHostHeaderOriginFallback = params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
	assertGatewayAuthConfigured(resolvedAuth, params.cfg.gateway?.auth);
	if (tailscaleMode === "funnel" && authMode !== "password") throw new Error("tailscale funnel requires gateway auth mode=password (set gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD)");
	if (tailscaleMode !== "off" && !isLoopbackHost(bindHost)) throw new Error("tailscale serve/funnel requires gateway bind=loopback (127.0.0.1)");
	if (!isLoopbackHost(bindHost) && !hasSharedSecret && authMode !== "trusted-proxy") throw new Error(`refusing to bind gateway to ${bindHost}:${params.port} without auth (set gateway.auth.token/password, or set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD)`);
	if (controlUiEnabled && !isLoopbackHost(bindHost) && controlUiAllowedOrigins.length === 0 && !dangerouslyAllowHostHeaderOriginFallback) throw new Error("non-loopback Control UI requires gateway.controlUi.allowedOrigins (set explicit origins), or set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true to use Host-header origin fallback mode");
	if (authMode === "trusted-proxy") {
		if (trustedProxies.length === 0) throw new Error("gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured with at least one proxy IP");
		if (isLoopbackHost(bindHost)) {
			if (!(isTrustedProxyAddress("127.0.0.1", trustedProxies) || isTrustedProxyAddress("::1", trustedProxies))) throw new Error("gateway auth mode=trusted-proxy with bind=loopback requires gateway.trustedProxies to include 127.0.0.1, ::1, or a loopback CIDR");
		}
	}
	return {
		bindHost,
		controlUiEnabled,
		openAiChatCompletionsEnabled,
		openAiChatCompletionsConfig: openAiChatCompletionsConfig ? {
			...openAiChatCompletionsConfig,
			enabled: openAiChatCompletionsEnabled
		} : void 0,
		openResponsesEnabled,
		openResponsesConfig: openResponsesConfig ? {
			...openResponsesConfig,
			enabled: openResponsesEnabled
		} : void 0,
		strictTransportSecurityHeader,
		controlUiBasePath,
		controlUiRoot,
		resolvedAuth,
		authMode,
		tailscaleConfig,
		tailscaleMode,
		hooksConfig,
		canvasHostEnabled
	};
}
//#endregion
//#region src/canvas-host/server.ts
init_paths();
init_utils();
function defaultIndexHTML() {
	return `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenClaw Canvas</title>
<style>
  html, body { height: 100%; margin: 0; background: #000; color: #fff; font: 16px/1.4 -apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
  .wrap { min-height: 100%; display: grid; place-items: center; padding: 24px; }
  .card { width: min(720px, 100%); background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); border-radius: 16px; padding: 18px 18px 14px; }
  .title { display: flex; align-items: baseline; gap: 10px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: 0.2px; }
  .sub { opacity: 0.75; font-size: 13px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  button { appearance: none; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.10); color: #fff; padding: 10px 12px; border-radius: 12px; font-weight: 600; cursor: pointer; }
  button:active { transform: translateY(1px); }
  .ok { color: #24e08a; }
  .bad { color: #ff5c5c; }
  .log { margin-top: 14px; opacity: 0.85; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; white-space: pre-wrap; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08); padding: 10px; border-radius: 12px; }
</style>
<div class="wrap">
  <div class="card">
    <div class="title">
      <h1>OpenClaw Canvas</h1>
      <div class="sub">Interactive test page (auto-reload enabled)</div>
    </div>

    <div class="row">
      <button id="btn-hello">Hello</button>
      <button id="btn-time">Time</button>
      <button id="btn-photo">Photo</button>
      <button id="btn-dalek">Dalek</button>
    </div>

    <div id="status" class="sub" style="margin-top: 10px;"></div>
    <div id="log" class="log">Ready.</div>
  </div>
</div>
<script>
(() => {
  const logEl = document.getElementById("log");
  const statusEl = document.getElementById("status");
  const log = (msg) => { logEl.textContent = String(msg); };

  const hasIOS = () =>
    !!(
      window.webkit &&
      window.webkit.messageHandlers &&
      window.webkit.messageHandlers.openclawCanvasA2UIAction
    );
  const hasAndroid = () =>
    !!(
      (window.openclawCanvasA2UIAction &&
        typeof window.openclawCanvasA2UIAction.postMessage === "function")
    );
  const hasHelper = () => typeof window.openclawSendUserAction === "function";
  statusEl.innerHTML =
    "Bridge: " +
    (hasHelper() ? "<span class='ok'>ready</span>" : "<span class='bad'>missing</span>") +
    " · iOS=" + (hasIOS() ? "yes" : "no") +
    " · Android=" + (hasAndroid() ? "yes" : "no");

  const onStatus = (ev) => {
    const d = ev && ev.detail || {};
    log("Action status: id=" + (d.id || "?") + " ok=" + String(!!d.ok) + (d.error ? (" error=" + d.error) : ""));
  };
  window.addEventListener("openclaw:a2ui-action-status", onStatus);

  function send(name, sourceComponentId) {
    if (!hasHelper()) {
      log("No action bridge found. Ensure you're viewing this on an iOS/Android OpenClaw node canvas.");
      return;
    }
    const sendUserAction =
      typeof window.openclawSendUserAction === "function"
        ? window.openclawSendUserAction
        : undefined;
    const ok = sendUserAction({
      name,
      surfaceId: "main",
      sourceComponentId,
      context: { t: Date.now() },
    });
    log(ok ? ("Sent action: " + name) : ("Failed to send action: " + name));
  }

  document.getElementById("btn-hello").onclick = () => send("hello", "demo.hello");
  document.getElementById("btn-time").onclick = () => send("time", "demo.time");
  document.getElementById("btn-photo").onclick = () => send("photo", "demo.photo");
  document.getElementById("btn-dalek").onclick = () => send("dalek", "demo.dalek");
})();
<\/script>
`;
}
function isDisabledByEnv() {
	if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CANVAS_HOST)) return true;
	if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CANVAS_HOST)) return true;
	if (process.env.VITEST) return true;
	return false;
}
function normalizeBasePath(rawPath) {
	const normalized = normalizeUrlPath((rawPath ?? "/__openclaw__/canvas").trim() || "/__openclaw__/canvas");
	if (normalized === "/") return "/";
	return normalized.replace(/\/+$/, "");
}
async function prepareCanvasRoot(rootDir) {
	await ensureDir(rootDir);
	const rootReal = await fs$1.realpath(rootDir);
	try {
		const indexPath = path.join(rootReal, "index.html");
		await fs$1.stat(indexPath);
	} catch {
		try {
			await fs$1.writeFile(path.join(rootReal, "index.html"), defaultIndexHTML(), "utf8");
		} catch {}
	}
	return rootReal;
}
function resolveDefaultCanvasRoot() {
	const candidates = [path.join(resolveStateDir(), "canvas")];
	return candidates.find((dir) => {
		try {
			return fsSync.statSync(dir).isDirectory();
		} catch {
			return false;
		}
	}) ?? candidates[0];
}
async function createCanvasHostHandler(opts) {
	const basePath = normalizeBasePath(opts.basePath);
	if (isDisabledByEnv() && opts.allowInTests !== true) return {
		rootDir: "",
		basePath,
		handleHttpRequest: async () => false,
		handleUpgrade: () => false,
		close: async () => {}
	};
	const rootDir = resolveUserPath(opts.rootDir ?? resolveDefaultCanvasRoot());
	const rootReal = await prepareCanvasRoot(rootDir);
	const liveReload = opts.liveReload !== false;
	const testMode = opts.allowInTests === true;
	const reloadDebounceMs = testMode ? 12 : 75;
	const writeStabilityThresholdMs = testMode ? 12 : 75;
	const writePollIntervalMs = testMode ? 5 : 10;
	const wss = liveReload ? new WebSocketServer({ noServer: true }) : null;
	const sockets = /* @__PURE__ */ new Set();
	if (wss) wss.on("connection", (ws) => {
		sockets.add(ws);
		ws.on("close", () => sockets.delete(ws));
	});
	let debounce = null;
	const broadcastReload = () => {
		if (!liveReload) return;
		for (const ws of sockets) try {
			ws.send("reload");
		} catch {}
	};
	const scheduleReload = () => {
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => {
			debounce = null;
			broadcastReload();
		}, reloadDebounceMs);
		debounce.unref?.();
	};
	let watcherClosed = false;
	const watcher = liveReload ? chokidar.watch(rootReal, {
		ignoreInitial: true,
		awaitWriteFinish: {
			stabilityThreshold: writeStabilityThresholdMs,
			pollInterval: writePollIntervalMs
		},
		usePolling: testMode,
		ignored: [/(^|[\\/])\../, /(^|[\\/])node_modules([\\/]|$)/]
	}) : null;
	watcher?.on("all", () => scheduleReload());
	watcher?.on("error", (err) => {
		if (watcherClosed) return;
		watcherClosed = true;
		opts.runtime.error(`canvasHost watcher error: ${String(err)} (live reload disabled; consider canvasHost.liveReload=false or a smaller canvasHost.root)`);
		watcher.close().catch(() => {});
	});
	const handleUpgrade = (req, socket, head) => {
		if (!wss) return false;
		if (new URL(req.url ?? "/", "http://localhost").pathname !== "/__openclaw__/ws") return false;
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
		});
		return true;
	};
	const handleHttpRequest = async (req, res) => {
		const urlRaw = req.url;
		if (!urlRaw) return false;
		try {
			const url = new URL(urlRaw, "http://localhost");
			if (url.pathname === "/__openclaw__/ws") {
				res.statusCode = liveReload ? 426 : 404;
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end(liveReload ? "upgrade required" : "not found");
				return true;
			}
			let urlPath = url.pathname;
			if (basePath !== "/") {
				if (urlPath !== basePath && !urlPath.startsWith(`${basePath}/`)) return false;
				urlPath = urlPath === basePath ? "/" : urlPath.slice(basePath.length) || "/";
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.statusCode = 405;
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end("Method Not Allowed");
				return true;
			}
			const opened = await resolveFileWithinRoot(rootReal, urlPath);
			if (!opened) {
				if (urlPath === "/" || urlPath.endsWith("/")) {
					res.statusCode = 404;
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.end(`<!doctype html><meta charset="utf-8" /><title>OpenClaw Canvas</title><pre>Missing file.\nCreate ${rootDir}/index.html</pre>`);
					return true;
				}
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end("not found");
				return true;
			}
			const { handle, realPath } = opened;
			let data;
			try {
				data = await handle.readFile();
			} finally {
				await handle.close().catch(() => {});
			}
			const lower = realPath.toLowerCase();
			const mime = lower.endsWith(".html") || lower.endsWith(".htm") ? "text/html" : await detectMime({ filePath: realPath }) ?? "application/octet-stream";
			res.setHeader("Cache-Control", "no-store");
			if (mime === "text/html") {
				const html = data.toString("utf8");
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(liveReload ? injectCanvasLiveReload(html) : html);
				return true;
			}
			res.setHeader("Content-Type", mime);
			res.end(data);
			return true;
		} catch (err) {
			opts.runtime.error(`canvasHost request failed: ${String(err)}`);
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("error");
			return true;
		}
	};
	return {
		rootDir,
		basePath,
		handleHttpRequest,
		handleUpgrade,
		close: async () => {
			if (debounce) clearTimeout(debounce);
			watcherClosed = true;
			await watcher?.close().catch(() => {});
			if (wss) await new Promise((resolve) => wss.close(() => resolve()));
		}
	};
}
//#endregion
//#region src/gateway/server-broadcast.ts
const ADMIN_SCOPE = "operator.admin";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";
const EVENT_SCOPE_GUARDS = {
	"exec.approval.requested": [APPROVALS_SCOPE],
	"exec.approval.resolved": [APPROVALS_SCOPE],
	"device.pair.requested": [PAIRING_SCOPE],
	"device.pair.resolved": [PAIRING_SCOPE],
	"node.pair.requested": [PAIRING_SCOPE],
	"node.pair.resolved": [PAIRING_SCOPE]
};
function hasEventScope(client, event) {
	const required = EVENT_SCOPE_GUARDS[event];
	if (!required) return true;
	if ((client.connect.role ?? "operator") !== "operator") return false;
	const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
	if (scopes.includes(ADMIN_SCOPE)) return true;
	return required.some((scope) => scopes.includes(scope));
}
function createGatewayBroadcaster(params) {
	let seq = 0;
	const broadcastInternal = (event, payload, opts, targetConnIds) => {
		if (params.clients.size === 0) return;
		const eventSeq = Boolean(targetConnIds) ? void 0 : ++seq;
		const frame = JSON.stringify({
			type: "event",
			event,
			payload,
			seq: eventSeq,
			stateVersion: opts?.stateVersion
		});
		if (shouldLogWs()) {
			const logMeta = {
				event,
				seq: eventSeq ?? "targeted",
				clients: params.clients.size,
				targets: targetConnIds ? targetConnIds.size : void 0,
				dropIfSlow: opts?.dropIfSlow,
				presenceVersion: opts?.stateVersion?.presence,
				healthVersion: opts?.stateVersion?.health
			};
			if (event === "agent") Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
			logWs("out", "event", logMeta);
		}
		for (const c of params.clients) {
			if (targetConnIds && !targetConnIds.has(c.connId)) continue;
			if (!hasEventScope(c, event)) continue;
			const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
			if (slow && opts?.dropIfSlow) continue;
			if (slow) {
				try {
					c.socket.close(1008, "slow consumer");
				} catch {}
				continue;
			}
			try {
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
//#region src/infra/gateway-lock.ts
init_paths();
const DEFAULT_TIMEOUT_MS = 5e3;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_MS = 3e4;
const DEFAULT_PORT_PROBE_TIMEOUT_MS = 1e3;
var GatewayLockError = class extends Error {
	constructor(message, cause) {
		super(message);
		this.cause = cause;
		this.name = "GatewayLockError";
	}
};
function readLinuxCmdline(pid) {
	try {
		return parseProcCmdline(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
	} catch {
		return null;
	}
}
function readLinuxStartTime(pid) {
	try {
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
		const closeParen = raw.lastIndexOf(")");
		if (closeParen < 0) return null;
		const fields = raw.slice(closeParen + 1).trim().split(/\s+/);
		const startTime = Number.parseInt(fields[19] ?? "", 10);
		return Number.isFinite(startTime) ? startTime : null;
	} catch {
		return null;
	}
}
async function checkPortFree(port, host = "127.0.0.1") {
	return await new Promise((resolve) => {
		const socket = net.createConnection({
			port,
			host
		});
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.removeAllListeners();
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => {
			finish(true);
		}, DEFAULT_PORT_PROBE_TIMEOUT_MS);
		socket.once("connect", () => {
			finish(false);
		});
		socket.once("error", () => {
			finish(true);
		});
	});
}
async function resolveGatewayOwnerStatus(pid, payload, platform, port) {
	if (port != null) {
		if (await checkPortFree(port)) return "dead";
	}
	if (!isPidAlive(pid)) return "dead";
	if (platform !== "linux") return "alive";
	const payloadStartTime = payload?.startTime;
	if (Number.isFinite(payloadStartTime)) {
		const currentStartTime = readLinuxStartTime(pid);
		if (currentStartTime == null) return "unknown";
		return currentStartTime === payloadStartTime ? "alive" : "dead";
	}
	const args = readLinuxCmdline(pid);
	if (!args) return "unknown";
	return isGatewayArgv(args) ? "alive" : "dead";
}
async function readLockPayload(lockPath) {
	try {
		const raw = await fs$1.readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.pid !== "number") return null;
		if (typeof parsed.createdAt !== "string") return null;
		if (typeof parsed.configPath !== "string") return null;
		const startTime = typeof parsed.startTime === "number" ? parsed.startTime : void 0;
		return {
			pid: parsed.pid,
			createdAt: parsed.createdAt,
			configPath: parsed.configPath,
			startTime
		};
	} catch {
		return null;
	}
}
function resolveGatewayLockPath(env) {
	const configPath = resolveConfigPath(env, resolveStateDir(env));
	const hash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
	const lockDir = resolveGatewayLockDir();
	return {
		lockPath: path.join(lockDir, `gateway.${hash}.lock`),
		configPath
	};
}
async function acquireGatewayLock(opts = {}) {
	const env = opts.env ?? process.env;
	const allowInTests = opts.allowInTests === true;
	if (env.OPENCLAW_ALLOW_MULTI_GATEWAY === "1" || !allowInTests && (env.VITEST || env.NODE_ENV === "test")) return null;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
	const platform = opts.platform ?? process.platform;
	const port = opts.port;
	const { lockPath, configPath } = resolveGatewayLockPath(env);
	await fs$1.mkdir(path.dirname(lockPath), { recursive: true });
	const startedAt = Date.now();
	let lastPayload = null;
	while (Date.now() - startedAt < timeoutMs) try {
		const handle = await fs$1.open(lockPath, "wx");
		const startTime = platform === "linux" ? readLinuxStartTime(process.pid) : null;
		const payload = {
			pid: process.pid,
			createdAt: (/* @__PURE__ */ new Date()).toISOString(),
			configPath
		};
		if (typeof startTime === "number" && Number.isFinite(startTime)) payload.startTime = startTime;
		await handle.writeFile(JSON.stringify(payload), "utf8");
		return {
			lockPath,
			configPath,
			release: async () => {
				await handle.close().catch(() => void 0);
				await fs$1.rm(lockPath, { force: true });
			}
		};
	} catch (err) {
		if (err.code !== "EEXIST") throw new GatewayLockError(`failed to acquire gateway lock at ${lockPath}`, err);
		lastPayload = await readLockPayload(lockPath);
		const ownerPid = lastPayload?.pid;
		const ownerStatus = ownerPid ? await resolveGatewayOwnerStatus(ownerPid, lastPayload, platform, port) : "unknown";
		if (ownerStatus === "dead" && ownerPid) {
			await fs$1.rm(lockPath, { force: true });
			continue;
		}
		if (ownerStatus !== "alive") {
			let stale = false;
			if (lastPayload?.createdAt) {
				const createdAt = Date.parse(lastPayload.createdAt);
				stale = Number.isFinite(createdAt) ? Date.now() - createdAt > staleMs : false;
			}
			if (!stale) try {
				const st = await fs$1.stat(lockPath);
				stale = Date.now() - st.mtimeMs > staleMs;
			} catch {
				stale = false;
			}
			if (stale) {
				await fs$1.rm(lockPath, { force: true });
				continue;
			}
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
	throw new GatewayLockError(`gateway already running${lastPayload?.pid ? ` (pid ${lastPayload.pid})` : ""}; lock timeout after ${timeoutMs}ms`);
}
//#endregion
//#region src/gateway/server/http-listen.ts
init_utils();
const EADDRINUSE_MAX_RETRIES = 4;
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
//#region src/gateway/server-runtime-state.ts
init_runtime$1();
async function createGatewayRuntimeState(params) {
	pinActivePluginHttpRouteRegistry(params.pluginRegistry);
	try {
		let canvasHost = null;
		if (params.canvasHostEnabled) try {
			const handler = await createCanvasHostHandler({
				runtime: params.canvasRuntime,
				rootDir: params.cfg.canvasHost?.root,
				basePath: CANVAS_HOST_PATH,
				allowInTests: params.allowCanvasHostInTests,
				liveReload: params.cfg.canvasHost?.liveReload
			});
			if (handler.rootDir) {
				canvasHost = handler;
				params.logCanvas.info(`canvas host mounted at http://${params.bindHost}:${params.port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`);
			}
		} catch (err) {
			params.logCanvas.warn(`canvas host failed to start: ${String(err)}`);
		}
		const clients = /* @__PURE__ */ new Set();
		const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });
		const handleHooksRequest = createGatewayHooksRequestHandler({
			deps: params.deps,
			getHooksConfig: params.hooksConfig,
			getClientIpConfig: params.getHookClientIpConfig,
			bindHost: params.bindHost,
			port: params.port,
			logHooks: params.logHooks
		});
		const handlePluginRequest = createGatewayPluginRequestHandler({
			registry: params.pluginRegistry,
			log: params.logPlugins
		});
		const shouldEnforcePluginGatewayAuth = (pathContext) => {
			return shouldEnforceGatewayAuthForPluginPath(resolveActivePluginHttpRouteRegistry(params.pluginRegistry), pathContext);
		};
		const bindHosts = await resolveGatewayListenHosts(params.bindHost);
		if (!isLoopbackHost(params.bindHost)) params.log.warn("⚠️  Gateway is binding to a non-loopback address. Ensure authentication is configured before exposing to public networks.");
		if (params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) params.log.warn("⚠️  gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true is enabled. Host-header origin fallback weakens origin checks and should only be used as break-glass.");
		const httpServers = [];
		const httpBindHosts = [];
		for (const host of bindHosts) {
			const httpServer = createGatewayHttpServer({
				canvasHost,
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
				resolvedAuth: params.resolvedAuth,
				rateLimiter: params.rateLimiter,
				getReadiness: params.getReadiness,
				tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : void 0
			});
			try {
				await listenGatewayHttpServer({
					httpServer,
					bindHost: host,
					port: params.port
				});
				httpServers.push(httpServer);
				httpBindHosts.push(host);
			} catch (err) {
				if (host === bindHosts[0]) throw err;
				params.log.warn(`gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`);
			}
		}
		const httpServer = httpServers[0];
		if (!httpServer) throw new Error("Gateway HTTP server failed to start");
		const wss = new WebSocketServer({
			noServer: true,
			maxPayload: MAX_PREAUTH_PAYLOAD_BYTES
		});
		for (const server of httpServers) attachGatewayUpgradeHandler({
			httpServer: server,
			wss,
			canvasHost,
			clients,
			resolvedAuth: params.resolvedAuth,
			rateLimiter: params.rateLimiter
		});
		const agentRunSeq = /* @__PURE__ */ new Map();
		const dedupe = /* @__PURE__ */ new Map();
		const chatRunState = createChatRunState();
		const chatRunRegistry = chatRunState.registry;
		const chatRunBuffers = chatRunState.buffers;
		const chatDeltaSentAt = chatRunState.deltaSentAt;
		const addChatRun = chatRunRegistry.add;
		const removeChatRun = chatRunRegistry.remove;
		const chatAbortControllers = /* @__PURE__ */ new Map();
		const toolEventRecipients = createToolEventRecipientRegistry();
		return {
			canvasHost,
			releasePluginRouteRegistry: () => releasePinnedPluginHttpRouteRegistry(params.pluginRegistry),
			httpServer,
			httpServers,
			httpBindHosts,
			wss,
			clients,
			broadcast,
			broadcastToConnIds,
			agentRunSeq,
			dedupe,
			chatRunState,
			chatRunBuffers,
			chatDeltaSentAt,
			addChatRun,
			removeChatRun,
			chatAbortControllers,
			toolEventRecipients
		};
	} catch (err) {
		releasePinnedPluginHttpRouteRegistry(params.pluginRegistry);
		throw err;
	}
}
//#endregion
//#region src/gateway/server-session-key.ts
init_session_key();
const RUN_LOOKUP_CACHE_LIMIT = 256;
const RUN_LOOKUP_MISS_TTL_MS = 1e3;
const resolvedSessionKeyByRunId = /* @__PURE__ */ new Map();
function setResolvedSessionKeyCache(runId, sessionKey) {
	if (!runId) return;
	if (!resolvedSessionKeyByRunId.has(runId) && resolvedSessionKeyByRunId.size >= RUN_LOOKUP_CACHE_LIMIT) {
		const oldest = resolvedSessionKeyByRunId.keys().next().value;
		if (oldest) resolvedSessionKeyByRunId.delete(oldest);
	}
	resolvedSessionKeyByRunId.set(runId, {
		sessionKey,
		expiresAt: sessionKey === null ? Date.now() + RUN_LOOKUP_MISS_TTL_MS : null
	});
}
function resolveSessionKeyForRun(runId) {
	const cached = getAgentRunContext(runId)?.sessionKey;
	if (cached) return cached;
	const cachedLookup = resolvedSessionKeyByRunId.get(runId);
	if (cachedLookup !== void 0) {
		if (cachedLookup.sessionKey !== null) return cachedLookup.sessionKey;
		if ((cachedLookup.expiresAt ?? 0) > Date.now()) return;
		resolvedSessionKeyByRunId.delete(runId);
	}
	const { store } = loadCombinedSessionStoreForGateway(loadConfig());
	const storeKey = resolvePreferredSessionKeyForSessionIdMatches(Object.entries(store).filter((entry) => entry[1]?.sessionId === runId), runId);
	if (storeKey) {
		const sessionKey = toAgentRequestSessionKey(storeKey) ?? storeKey;
		registerAgentRunContext(runId, { sessionKey });
		setResolvedSessionKeyCache(runId, sessionKey);
		return sessionKey;
	}
	setResolvedSessionKeyCache(runId, null);
}
//#endregion
//#region src/gateway/server-startup-log.ts
function logGatewayStartup(params) {
	const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
		cfg: params.cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const modelRef = `${agentProvider}/${agentModel}`;
	params.log.info(`agent model: ${modelRef}`, { consoleMessage: `agent model: ${chalk.whiteBright(modelRef)}` });
	const scheme = params.tlsEnabled ? "wss" : "ws";
	const formatHost = (host) => host.includes(":") ? `[${host}]` : host;
	const listenEndpoints = (params.bindHosts && params.bindHosts.length > 0 ? params.bindHosts : [params.bindHost]).map((host) => `${scheme}://${formatHost(host)}:${params.port}`);
	params.log.info(`listening on ${listenEndpoints.join(", ")} (PID ${process.pid})`);
	params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
	if (params.isNixMode) params.log.info("gateway: running in Nix mode (config managed externally)");
	const enabledDangerousFlags = collectEnabledInsecureOrDangerousFlags(params.cfg);
	if (enabledDangerousFlags.length > 0) {
		const warning = `security warning: dangerous config flags enabled: ${enabledDangerousFlags.join(", ")}. Run \`openclaw security audit\`.`;
		params.log.warn(warning);
	}
}
//#endregion
//#region src/hooks/import-url.ts
/**
* Build an import URL for a hook handler module.
*
* Bundled hooks (shipped in dist/) are immutable between installs, so they
* can be imported without a cache-busting suffix — letting V8 reuse its
* module cache across gateway restarts.
*
* Workspace, managed, and plugin hooks may be edited by the user between
* restarts. For those we append `?t=<mtime>&s=<size>` so the module key
* reflects on-disk changes while staying stable for unchanged files.
*/
/**
* Sources whose handler files never change between `npm install` runs.
* Imports from these sources skip cache busting entirely.
*/
const IMMUTABLE_SOURCES = new Set(["openclaw-bundled"]);
function buildImportUrl(handlerPath, source) {
	const base = pathToFileURL(handlerPath).href;
	if (IMMUTABLE_SOURCES.has(source)) return base;
	try {
		const { mtimeMs, size } = fs.statSync(handlerPath);
		return `${base}?t=${mtimeMs}&s=${size}`;
	} catch {
		return `${base}?t=${Date.now()}`;
	}
}
//#endregion
//#region src/hooks/loader.ts
/**
* Dynamic loader for hook handlers
*
* Loads hook handlers from external modules based on configuration
* and from directory-based discovery (bundled, managed, workspace)
*/
init_subsystem();
init_internal_hooks();
const log$2 = createSubsystemLogger("hooks:loader");
function safeLogValue(value) {
	return sanitizeForLog(value);
}
function maybeWarnTrustedHookSource(source) {
	if (source === "openclaw-workspace") {
		log$2.warn("Loading workspace hook code into the gateway process. Workspace hooks are trusted local code.");
		return;
	}
	if (source === "openclaw-managed") log$2.warn("Loading managed hook code into the gateway process. Managed hooks are trusted local code.");
}
/**
* Load and register all hook handlers
*
* Loads hooks from both:
* 1. Directory-based discovery (bundled, managed, workspace)
* 2. Legacy config handlers (backwards compatibility)
*
* @param cfg - OpenClaw configuration
* @param workspaceDir - Workspace directory for hook discovery
* @returns Number of handlers successfully loaded
*
* @example
* ```ts
* const config = await loadConfig();
* const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
* const count = await loadInternalHooks(config, workspaceDir);
* console.log(`Loaded ${count} hook handlers`);
* ```
*/
async function loadInternalHooks(cfg, workspaceDir, opts) {
	if (!cfg.hooks?.internal?.enabled) return 0;
	let loadedCount = 0;
	try {
		const eligible = loadWorkspaceHookEntries(workspaceDir, {
			config: cfg,
			managedHooksDir: opts?.managedHooksDir,
			bundledHooksDir: opts?.bundledHooksDir
		}).filter((entry) => shouldIncludeHook({
			entry,
			config: cfg
		}));
		for (const entry of eligible) {
			if (resolveHookConfig(cfg, entry.hook.name)?.enabled === false) continue;
			try {
				const hookBaseDir = resolveExistingRealpath(entry.hook.baseDir);
				if (!hookBaseDir) {
					log$2.error(`Hook '${safeLogValue(entry.hook.name)}' base directory is no longer readable: ${safeLogValue(entry.hook.baseDir)}`);
					continue;
				}
				const opened = await openBoundaryFile({
					absolutePath: entry.hook.handlerPath,
					rootPath: hookBaseDir,
					boundaryLabel: "hook directory"
				});
				if (!opened.ok) {
					log$2.error(`Hook '${safeLogValue(entry.hook.name)}' handler path fails boundary checks: ${safeLogValue(entry.hook.handlerPath)}`);
					continue;
				}
				const safeHandlerPath = opened.path;
				fs.closeSync(opened.fd);
				maybeWarnTrustedHookSource(entry.hook.source);
				const mod = await import(buildImportUrl(safeHandlerPath, entry.hook.source));
				const exportName = entry.metadata?.export ?? "default";
				const handler = resolveFunctionModuleExport({
					mod,
					exportName
				});
				if (!handler) {
					log$2.error(`Handler '${safeLogValue(exportName)}' from ${safeLogValue(entry.hook.name)} is not a function`);
					continue;
				}
				const events = entry.metadata?.events ?? [];
				if (events.length === 0) {
					log$2.warn(`Hook '${safeLogValue(entry.hook.name)}' has no events defined in metadata`);
					continue;
				}
				for (const event of events) registerInternalHook(event, handler);
				log$2.info(`Registered hook: ${safeLogValue(entry.hook.name)} -> ${events.map((event) => safeLogValue(event)).join(", ")}${exportName !== "default" ? ` (export: ${safeLogValue(exportName)})` : ""}`);
				loadedCount++;
			} catch (err) {
				log$2.error(`Failed to load hook ${safeLogValue(entry.hook.name)}: ${safeLogValue(err instanceof Error ? err.message : String(err))}`);
			}
		}
	} catch (err) {
		log$2.error(`Failed to load directory-based hooks: ${safeLogValue(err instanceof Error ? err.message : String(err))}`);
	}
	const handlers = cfg.hooks.internal.handlers ?? [];
	for (const handlerConfig of handlers) try {
		const rawModule = handlerConfig.module.trim();
		if (!rawModule) {
			log$2.error("Handler module path is empty");
			continue;
		}
		if (path.isAbsolute(rawModule)) {
			log$2.error(`Handler module path must be workspace-relative (got absolute path): ${safeLogValue(rawModule)}`);
			continue;
		}
		const baseDir = path.resolve(workspaceDir);
		const modulePath = path.resolve(baseDir, rawModule);
		const baseDirReal = resolveExistingRealpath(baseDir);
		if (!baseDirReal) {
			log$2.error(`Workspace directory is no longer readable while loading hooks: ${safeLogValue(baseDir)}`);
			continue;
		}
		const modulePathSafe = resolveExistingRealpath(modulePath);
		if (!modulePathSafe) {
			log$2.error(`Handler module path could not be resolved with realpath: ${safeLogValue(rawModule)}`);
			continue;
		}
		const rel = path.relative(baseDirReal, modulePathSafe);
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
			log$2.error(`Handler module path must stay within workspaceDir: ${safeLogValue(rawModule)}`);
			continue;
		}
		const opened = await openBoundaryFile({
			absolutePath: modulePathSafe,
			rootPath: baseDirReal,
			boundaryLabel: "workspace directory"
		});
		if (!opened.ok) {
			log$2.error(`Handler module path fails boundary checks under workspaceDir: ${safeLogValue(rawModule)}`);
			continue;
		}
		const safeModulePath = opened.path;
		fs.closeSync(opened.fd);
		log$2.warn(`Loading legacy internal hook module from workspace path ${safeLogValue(rawModule)}. Legacy hook modules are trusted local code.`);
		const mod = await import(buildImportUrl(safeModulePath, "openclaw-workspace"));
		const exportName = handlerConfig.export ?? "default";
		const handler = resolveFunctionModuleExport({
			mod,
			exportName
		});
		if (!handler) {
			log$2.error(`Handler '${safeLogValue(exportName)}' from ${safeLogValue(modulePath)} is not a function`);
			continue;
		}
		registerInternalHook(handlerConfig.event, handler);
		log$2.info(`Registered hook (legacy): ${safeLogValue(handlerConfig.event)} -> ${safeLogValue(modulePath)}${exportName !== "default" ? `#${safeLogValue(exportName)}` : ""}`);
		loadedCount++;
	} catch (err) {
		log$2.error(`Failed to load hook handler from ${safeLogValue(handlerConfig.module)}: ${safeLogValue(err instanceof Error ? err.message : String(err))}`);
	}
	return loadedCount;
}
function resolveExistingRealpath(value) {
	try {
		return fs.realpathSync(value);
	} catch {
		return null;
	}
}
//#endregion
//#region src/plugins/services.ts
init_paths();
init_subsystem();
const log$1 = createSubsystemLogger("plugins");
function createPluginLogger() {
	return {
		info: (msg) => log$1.info(msg),
		warn: (msg) => log$1.warn(msg),
		error: (msg) => log$1.error(msg),
		debug: (msg) => log$1.debug(msg)
	};
}
function createServiceContext(params) {
	return {
		config: params.config,
		workspaceDir: params.workspaceDir,
		stateDir: STATE_DIR,
		logger: createPluginLogger()
	};
}
async function startPluginServices(params) {
	const running = [];
	const serviceContext = createServiceContext({
		config: params.config,
		workspaceDir: params.workspaceDir
	});
	for (const entry of params.registry.services) {
		const service = entry.service;
		try {
			await service.start(serviceContext);
			running.push({
				id: service.id,
				stop: service.stop ? () => service.stop?.(serviceContext) : void 0
			});
		} catch (err) {
			const error = err;
			const stack = error?.stack?.trim();
			log$1.error(`plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}${stack ? `\n${stack}` : ""}`);
		}
	}
	return { stop: async () => {
		for (const entry of running.toReversed()) {
			if (!entry.stop) continue;
			try {
				await entry.stop();
			} catch (err) {
				log$1.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
			}
		}
	} };
}
//#endregion
//#region src/gateway/server-restart-sentinel.ts
async function scheduleRestartSentinelWake(_params) {
	const sentinel = await consumeRestartSentinel();
	if (!sentinel) return;
	const payload = sentinel.payload;
	const sessionKey = payload.sessionKey?.trim();
	const message = formatRestartSentinelMessage(payload);
	const summary = summarizeRestartSentinel(payload);
	if (!sessionKey) {
		enqueueSystemEvent(message, { sessionKey: resolveMainSessionKeyFromConfig() });
		return;
	}
	const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);
	const { cfg, entry } = loadSessionEntry(sessionKey);
	const parsedTarget = resolveAnnounceTargetFromKey(baseSessionKey ?? sessionKey);
	const sentinelContext = payload.deliveryContext;
	let sessionDeliveryContext = deliveryContextFromSession(entry);
	if (!sessionDeliveryContext && baseSessionKey && baseSessionKey !== sessionKey) {
		const { entry: baseEntry } = loadSessionEntry(baseSessionKey);
		sessionDeliveryContext = deliveryContextFromSession(baseEntry);
	}
	const origin = mergeDeliveryContext(sentinelContext, mergeDeliveryContext(sessionDeliveryContext, parsedTarget ?? void 0));
	const channelRaw = origin?.channel;
	const channel = channelRaw ? normalizeChannelId(channelRaw) : null;
	const to = origin?.to;
	if (!channel || !to) {
		enqueueSystemEvent(message, { sessionKey });
		return;
	}
	const resolved = resolveOutboundTarget({
		channel,
		to,
		cfg,
		accountId: origin?.accountId,
		mode: "implicit"
	});
	if (!resolved.ok) {
		enqueueSystemEvent(message, { sessionKey });
		return;
	}
	const threadId = payload.threadId ?? parsedTarget?.threadId ?? sessionThreadId ?? (origin?.threadId != null ? String(origin.threadId) : void 0);
	const isSlack = channel === "slack";
	const replyToId = isSlack && threadId != null && threadId !== "" ? String(threadId) : void 0;
	const resolvedThreadId = isSlack ? void 0 : threadId;
	const outboundSession = buildOutboundSessionContext({
		cfg,
		sessionKey
	});
	try {
		await deliverOutboundPayloads({
			cfg,
			channel,
			to: resolved.to,
			accountId: origin?.accountId,
			replyToId,
			threadId: resolvedThreadId,
			payloads: [{ text: message }],
			session: outboundSession,
			bestEffort: true
		});
	} catch (err) {
		enqueueSystemEvent(`${summary}\n${String(err)}`, { sessionKey });
	}
}
function shouldWakeFromRestartSentinel() {
	return !process.env.VITEST && true;
}
//#endregion
//#region src/gateway/server-startup-memory.ts
async function startGatewayMemoryBackend(params) {
	const agentIds = listAgentIds(params.cfg);
	for (const agentId of agentIds) {
		if (!resolveMemorySearchConfig(params.cfg, agentId)) continue;
		const resolved = resolveMemoryBackendConfig({
			cfg: params.cfg,
			agentId
		});
		if (resolved.backend !== "qmd" || !resolved.qmd) continue;
		const { manager, error } = await getMemorySearchManager({
			cfg: params.cfg,
			agentId
		});
		if (!manager) {
			params.log.warn(`qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`);
			continue;
		}
		params.log.info?.(`qmd memory startup initialization armed for agent "${agentId}"`);
	}
}
//#endregion
//#region src/gateway/server-startup.ts
init_paths();
init_internal_hooks();
const SESSION_LOCK_STALE_MS = 1800 * 1e3;
async function startGatewaySidecars(params) {
	try {
		const sessionDirs = await resolveAgentSessionDirs(resolveStateDir(process.env));
		for (const sessionsDir of sessionDirs) await cleanStaleLockFiles({
			sessionsDir,
			staleMs: SESSION_LOCK_STALE_MS,
			removeStale: true,
			log: { warn: (message) => params.log.warn(message) }
		});
	} catch (err) {
		params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
	}
	let browserControl = null;
	try {
		browserControl = await startBrowserControlServerIfEnabled();
	} catch (err) {
		params.logBrowser.error(`server failed to start: ${String(err)}`);
	}
	await startGmailWatcherWithLogs({
		cfg: params.cfg,
		log: params.logHooks
	});
	if (params.cfg.hooks?.gmail?.model) {
		const hooksModelRef = resolveHooksGmailModel({
			cfg: params.cfg,
			defaultProvider: DEFAULT_PROVIDER
		});
		if (hooksModelRef) {
			const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
				cfg: params.cfg,
				defaultProvider: DEFAULT_PROVIDER,
				defaultModel: DEFAULT_MODEL
			});
			const catalog = await loadModelCatalog({ config: params.cfg });
			const status = getModelRefStatus({
				cfg: params.cfg,
				catalog,
				ref: hooksModelRef,
				defaultProvider,
				defaultModel
			});
			if (!status.allowed) params.logHooks.warn(`hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`);
			if (!status.inCatalog) params.logHooks.warn(`hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`);
		}
	}
	try {
		clearInternalHooks();
		const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
		if (loadedCount > 0) params.logHooks.info(`loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`);
	} catch (err) {
		params.logHooks.error(`failed to load hooks: ${String(err)}`);
	}
	if (!(isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) || isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS))) try {
		await params.startChannels();
	} catch (err) {
		params.logChannels.error(`channel startup failed: ${String(err)}`);
	}
	else params.logChannels.info("skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)");
	if (params.cfg.hooks?.internal?.enabled) setTimeout(() => {
		triggerInternalHook(createInternalHookEvent("gateway", "startup", "gateway:startup", {
			cfg: params.cfg,
			deps: params.deps,
			workspaceDir: params.defaultWorkspaceDir
		}));
	}, 250);
	let pluginServices = null;
	try {
		pluginServices = await startPluginServices({
			registry: params.pluginRegistry,
			config: params.cfg,
			workspaceDir: params.defaultWorkspaceDir
		});
	} catch (err) {
		params.log.warn(`plugin services failed to start: ${String(err)}`);
	}
	if (params.cfg.acp?.enabled) getAcpSessionManager().reconcilePendingSessionIdentities({ cfg: params.cfg }).then((result) => {
		if (result.checked === 0) return;
		params.log.warn(`acp startup identity reconcile (renderer=v1): checked=${result.checked} resolved=${result.resolved} failed=${result.failed}`);
	}).catch((err) => {
		params.log.warn(`acp startup identity reconcile failed: ${String(err)}`);
	});
	startGatewayMemoryBackend({
		cfg: params.cfg,
		log: params.log
	}).catch((err) => {
		params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
	});
	if (shouldWakeFromRestartSentinel()) setTimeout(() => {
		scheduleRestartSentinelWake({ deps: params.deps });
	}, 750);
	return {
		browserControl,
		pluginServices
	};
}
//#endregion
//#region src/gateway/server-tailscale.ts
async function startGatewayTailscaleExposure(params) {
	if (params.tailscaleMode === "off") return null;
	try {
		if (params.tailscaleMode === "serve") await enableTailscaleServe(params.port);
		else await enableTailscaleFunnel(params.port);
		const host = await getTailnetHostname().catch(() => null);
		if (host) {
			const uiPath = params.controlUiBasePath ? `${params.controlUiBasePath}/` : "/";
			params.logTailscale.info(`${params.tailscaleMode} enabled: https://${host}${uiPath} (WS via wss://${host})`);
		} else params.logTailscale.info(`${params.tailscaleMode} enabled`);
	} catch (err) {
		params.logTailscale.warn(`${params.tailscaleMode} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!params.resetOnExit) return null;
	return async () => {
		try {
			if (params.tailscaleMode === "serve") await disableTailscaleServe();
			else await disableTailscaleFunnel();
		} catch (err) {
			params.logTailscale.warn(`${params.tailscaleMode} cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
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
//#region src/infra/canvas-host-url.ts
const normalizeHost = (value, rejectLoopback) => {
	if (!value) return "";
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (rejectLoopback && isLoopbackHost(trimmed)) return "";
	return trimmed;
};
const parseHostHeader = (value) => {
	if (!value) return { host: "" };
	try {
		const parsed = new URL(`http://${String(value).trim()}`);
		const portRaw = parsed.port.trim();
		const port = portRaw ? Number.parseInt(portRaw, 10) : void 0;
		return {
			host: parsed.hostname,
			port: Number.isFinite(port) ? port : void 0
		};
	} catch {
		return { host: "" };
	}
};
const parseForwardedProto = (value) => {
	if (Array.isArray(value)) return value[0];
	return value;
};
function resolveCanvasHostUrl(params) {
	const port = params.canvasPort;
	if (!port) return;
	const scheme = params.scheme ?? (parseForwardedProto(params.forwardedProto)?.trim() === "https" ? "https" : "http");
	const override = normalizeHost(params.hostOverride, true);
	const parsedRequestHost = parseHostHeader(params.requestHost);
	const requestHost = normalizeHost(parsedRequestHost.host, !!override);
	const localAddress = normalizeHost(params.localAddress, Boolean(override || requestHost));
	const host = override || requestHost || localAddress;
	if (!host) return;
	let exposedPort = port;
	if (!override && requestHost && port === 18789) {
		if (parsedRequestHost.port && parsedRequestHost.port > 0) exposedPort = parsedRequestHost.port;
		else if (scheme === "https") exposedPort = 443;
		else if (scheme === "http") exposedPort = 80;
	}
	return `${scheme}://${host.includes(":") ? `[${host}]` : host}:${exposedPort}`;
}
//#endregion
//#region src/gateway/origin-check.ts
function parseOrigin(originRaw) {
	const trimmed = (originRaw ?? "").trim();
	if (!trimmed || trimmed === "null") return null;
	try {
		const url = new URL(trimmed);
		return {
			origin: url.origin.toLowerCase(),
			host: url.host.toLowerCase(),
			hostname: url.hostname.toLowerCase()
		};
	} catch {
		return null;
	}
}
function checkBrowserOrigin(params) {
	const parsedOrigin = parseOrigin(params.origin);
	if (!parsedOrigin) return {
		ok: false,
		reason: "origin missing or invalid"
	};
	const allowlist = new Set((params.allowedOrigins ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
	if (allowlist.has("*") || allowlist.has(parsedOrigin.origin)) return {
		ok: true,
		matchedBy: "allowlist"
	};
	const requestHost = normalizeHostHeader(params.requestHost);
	if (params.allowHostHeaderOriginFallback === true && requestHost && parsedOrigin.host === requestHost) return {
		ok: true,
		matchedBy: "host-header-fallback"
	};
	if (params.isLocalClient && isLoopbackHost(parsedOrigin.hostname)) return {
		ok: true,
		matchedBy: "local-loopback"
	};
	return {
		ok: false,
		reason: "origin not allowed"
	};
}
//#endregion
//#region src/gateway/server/ws-connection/auth-context.ts
function trimToUndefined(value) {
	if (!value) return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function resolveSharedConnectAuth(connectAuth) {
	const token = trimToUndefined(connectAuth?.token);
	const password = trimToUndefined(connectAuth?.password);
	if (!token && !password) return;
	return {
		token,
		password
	};
}
function resolveDeviceTokenCandidate(connectAuth) {
	const explicitDeviceToken = trimToUndefined(connectAuth?.deviceToken);
	if (explicitDeviceToken) return {
		token: explicitDeviceToken,
		source: "explicit-device-token"
	};
	const fallbackToken = trimToUndefined(connectAuth?.token);
	if (!fallbackToken) return {};
	return {
		token: fallbackToken,
		source: "shared-token-fallback"
	};
}
function resolveBootstrapTokenCandidate(connectAuth) {
	return trimToUndefined(connectAuth?.bootstrapToken);
}
async function resolveConnectAuthState(params) {
	const sharedConnectAuth = resolveSharedConnectAuth(params.connectAuth);
	const sharedAuthProvided = Boolean(sharedConnectAuth);
	const bootstrapTokenCandidate = params.hasDeviceIdentity ? resolveBootstrapTokenCandidate(params.connectAuth) : void 0;
	const { token: deviceTokenCandidate, source: deviceTokenCandidateSource } = params.hasDeviceIdentity ? resolveDeviceTokenCandidate(params.connectAuth) : {};
	const hasDeviceTokenCandidate = Boolean(deviceTokenCandidate);
	let authResult = await authorizeWsControlUiGatewayConnect({
		auth: params.resolvedAuth,
		connectAuth: sharedConnectAuth,
		req: params.req,
		trustedProxies: params.trustedProxies,
		allowRealIpFallback: params.allowRealIpFallback,
		rateLimiter: hasDeviceTokenCandidate ? void 0 : params.rateLimiter,
		clientIp: params.clientIp,
		rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET
	});
	if (hasDeviceTokenCandidate && authResult.ok && params.rateLimiter && (authResult.method === "token" || authResult.method === "password")) {
		const sharedRateCheck = params.rateLimiter.check(params.clientIp, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
		if (!sharedRateCheck.allowed) authResult = {
			ok: false,
			reason: "rate_limited",
			rateLimited: true,
			retryAfterMs: sharedRateCheck.retryAfterMs
		};
		else params.rateLimiter.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
	}
	const sharedAuthResult = sharedConnectAuth && await authorizeHttpGatewayConnect({
		auth: {
			...params.resolvedAuth,
			allowTailscale: false
		},
		connectAuth: sharedConnectAuth,
		req: params.req,
		trustedProxies: params.trustedProxies,
		allowRealIpFallback: params.allowRealIpFallback,
		rateLimitScope: "shared-secret"
	});
	const sharedAuthOk = sharedAuthResult?.ok === true && (sharedAuthResult.method === "token" || sharedAuthResult.method === "password") || authResult.ok && authResult.method === "trusted-proxy";
	return {
		authResult,
		authOk: authResult.ok,
		authMethod: authResult.method ?? (params.resolvedAuth.mode === "password" ? "password" : "token"),
		sharedAuthOk,
		sharedAuthProvided,
		bootstrapTokenCandidate,
		deviceTokenCandidate,
		deviceTokenCandidateSource
	};
}
async function resolveConnectAuthDecision(params) {
	let authResult = params.state.authResult;
	let authOk = params.state.authOk;
	let authMethod = params.state.authMethod;
	const bootstrapTokenCandidate = params.state.bootstrapTokenCandidate;
	if (params.hasDeviceIdentity && params.deviceId && params.publicKey && !authOk && bootstrapTokenCandidate) {
		const tokenCheck = await params.verifyBootstrapToken({
			deviceId: params.deviceId,
			publicKey: params.publicKey,
			token: bootstrapTokenCandidate,
			role: params.role,
			scopes: params.scopes
		});
		if (tokenCheck.ok) {
			authOk = true;
			authMethod = "bootstrap-token";
		} else authResult = {
			ok: false,
			reason: tokenCheck.reason ?? "bootstrap_token_invalid"
		};
	}
	const deviceTokenCandidate = params.state.deviceTokenCandidate;
	if (!params.hasDeviceIdentity || !params.deviceId || authOk || !deviceTokenCandidate) return {
		authResult,
		authOk,
		authMethod
	};
	if (params.rateLimiter) {
		const deviceRateCheck = params.rateLimiter.check(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
		if (!deviceRateCheck.allowed) authResult = {
			ok: false,
			reason: "rate_limited",
			rateLimited: true,
			retryAfterMs: deviceRateCheck.retryAfterMs
		};
	}
	if (!authResult.rateLimited) if ((await params.verifyDeviceToken({
		deviceId: params.deviceId,
		token: deviceTokenCandidate,
		role: params.role,
		scopes: params.scopes
	})).ok) {
		authOk = true;
		authMethod = "device-token";
		params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
	} else {
		authResult = {
			ok: false,
			reason: params.state.deviceTokenCandidateSource === "explicit-device-token" ? "device_token_mismatch" : authResult.reason ?? "device_token_mismatch"
		};
		params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
	}
	return {
		authResult,
		authOk,
		authMethod
	};
}
//#endregion
//#region src/gateway/server/ws-connection/auth-messages.ts
function formatGatewayAuthFailureMessage(params) {
	const { authMode, authProvided, reason, client } = params;
	const isCli = isGatewayCliClient(client);
	const isControlUi = client?.id === GATEWAY_CLIENT_IDS.CONTROL_UI;
	const isWebchat = isWebchatClient(client);
	const tokenHint = isCli ? "set gateway.remote.token to match gateway.auth.token" : isControlUi || isWebchat ? "open the dashboard URL and paste the token in Control UI settings" : "provide gateway auth token";
	const passwordHint = isCli ? "set gateway.remote.password to match gateway.auth.password" : isControlUi || isWebchat ? "enter the password in Control UI settings" : "provide gateway auth password";
	switch (reason) {
		case "token_missing": return `unauthorized: gateway token missing (${tokenHint})`;
		case "token_mismatch": return `unauthorized: gateway token mismatch (${tokenHint})`;
		case "token_missing_config": return "unauthorized: gateway token not configured on gateway (set gateway.auth.token)";
		case "password_missing": return `unauthorized: gateway password missing (${passwordHint})`;
		case "password_mismatch": return `unauthorized: gateway password mismatch (${passwordHint})`;
		case "password_missing_config": return "unauthorized: gateway password not configured on gateway (set gateway.auth.password)";
		case "bootstrap_token_invalid": return "unauthorized: bootstrap token invalid or expired (scan a fresh setup code)";
		case "tailscale_user_missing": return "unauthorized: tailscale identity missing (use Tailscale Serve auth or gateway token/password)";
		case "tailscale_proxy_missing": return "unauthorized: tailscale proxy headers missing (use Tailscale Serve or gateway token/password)";
		case "tailscale_whois_failed": return "unauthorized: tailscale identity check failed (use Tailscale Serve auth or gateway token/password)";
		case "tailscale_user_mismatch": return "unauthorized: tailscale identity mismatch (use Tailscale Serve auth or gateway token/password)";
		case "rate_limited": return "unauthorized: too many failed authentication attempts (retry later)";
		case "device_token_mismatch": return "unauthorized: device token mismatch (rotate/reissue device token)";
		default: break;
	}
	if (authMode === "token" && authProvided === "none") return `unauthorized: gateway token missing (${tokenHint})`;
	if (authMode === "token" && authProvided === "device-token") return "unauthorized: device token rejected (pair/repair this device, or provide gateway token)";
	if (authProvided === "bootstrap-token") return "unauthorized: bootstrap token invalid or expired (scan a fresh setup code)";
	if (authMode === "password" && authProvided === "none") return `unauthorized: gateway password missing (${passwordHint})`;
	return "unauthorized";
}
//#endregion
//#region src/gateway/server/ws-connection/connect-policy.ts
function resolveControlUiAuthPolicy(params) {
	const allowInsecureAuthConfigured = params.isControlUi && params.controlUiConfig?.allowInsecureAuth === true;
	const dangerouslyDisableDeviceAuth = params.isControlUi && params.controlUiConfig?.dangerouslyDisableDeviceAuth === true;
	return {
		isControlUi: params.isControlUi,
		allowInsecureAuthConfigured,
		dangerouslyDisableDeviceAuth,
		allowBypass: dangerouslyDisableDeviceAuth,
		device: dangerouslyDisableDeviceAuth ? null : params.deviceRaw
	};
}
function shouldSkipControlUiPairing(policy, role, trustedProxyAuthOk = false, authMode) {
	if (trustedProxyAuthOk) return true;
	if (policy.isControlUi && role === "operator" && authMode === "none") return true;
	return role === "operator" && policy.allowBypass;
}
function isTrustedProxyControlUiOperatorAuth(params) {
	return params.isControlUi && params.role === "operator" && params.authMode === "trusted-proxy" && params.authOk && params.authMethod === "trusted-proxy";
}
function evaluateMissingDeviceIdentity(params) {
	if (params.hasDeviceIdentity) return { kind: "allow" };
	if (params.isControlUi && params.trustedProxyAuthOk) return { kind: "allow" };
	if (params.isControlUi && params.controlUiAuthPolicy.allowBypass && params.role === "operator") return { kind: "allow" };
	if (params.isControlUi && !params.controlUiAuthPolicy.allowBypass) {
		if (!params.controlUiAuthPolicy.allowInsecureAuthConfigured || !params.isLocalClient) return { kind: "reject-control-ui-insecure-auth" };
	}
	if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) return { kind: "allow" };
	if (!params.authOk && params.hasSharedAuth) return { kind: "reject-unauthorized" };
	return { kind: "reject-device-required" };
}
//#endregion
//#region src/gateway/server/ws-connection/handshake-auth-helpers.ts
const BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP = "198.18.0.1";
function resolveHandshakeBrowserSecurityContext(params) {
	const hasBrowserOriginHeader = Boolean(params.requestOrigin && params.requestOrigin.trim() !== "");
	return {
		hasBrowserOriginHeader,
		enforceOriginCheckForAnyClient: hasBrowserOriginHeader,
		rateLimitClientIp: hasBrowserOriginHeader && isLoopbackAddress(params.clientIp) ? BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP : params.clientIp,
		authRateLimiter: hasBrowserOriginHeader && params.browserRateLimiter ? params.browserRateLimiter : params.rateLimiter
	};
}
function shouldAllowSilentLocalPairing(params) {
	return params.isLocalClient && (!params.hasBrowserOriginHeader || params.isControlUi || params.isWebchat) && (params.reason === "not-paired" || params.reason === "scope-upgrade");
}
function shouldSkipBackendSelfPairing(params) {
	if (!(params.connectParams.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT && params.connectParams.client.mode === GATEWAY_CLIENT_MODES.BACKEND)) return false;
	const usesSharedSecretAuth = params.authMethod === "token" || params.authMethod === "password";
	const usesDeviceTokenAuth = params.authMethod === "device-token";
	return params.isLocalClient && !params.hasBrowserOriginHeader && (params.sharedAuthOk && usesSharedSecretAuth || usesDeviceTokenAuth);
}
function resolveSignatureToken(connectParams) {
	return connectParams.auth?.token ?? connectParams.auth?.deviceToken ?? connectParams.auth?.bootstrapToken ?? null;
}
function buildUnauthorizedHandshakeContext(params) {
	return {
		authProvided: params.authProvided,
		canRetryWithDeviceToken: params.canRetryWithDeviceToken,
		recommendedNextStep: params.recommendedNextStep
	};
}
function resolveDeviceSignaturePayloadVersion(params) {
	const signatureToken = resolveSignatureToken(params.connectParams);
	const basePayload = {
		deviceId: params.device.id,
		clientId: params.connectParams.client.id,
		clientMode: params.connectParams.client.mode,
		role: params.role,
		scopes: params.scopes,
		signedAtMs: params.signedAtMs,
		token: signatureToken,
		nonce: params.nonce
	};
	const payloadV3 = buildDeviceAuthPayloadV3({
		...basePayload,
		platform: params.connectParams.client.platform,
		deviceFamily: params.connectParams.client.deviceFamily
	});
	if (verifyDeviceSignature(params.device.publicKey, payloadV3, params.device.signature)) return "v3";
	const payloadV2 = buildDeviceAuthPayload(basePayload);
	if (verifyDeviceSignature(params.device.publicKey, payloadV2, params.device.signature)) return "v2";
	return null;
}
function resolveAuthProvidedKind(connectAuth) {
	return connectAuth?.password ? "password" : connectAuth?.token ? "token" : connectAuth?.bootstrapToken ? "bootstrap-token" : connectAuth?.deviceToken ? "device-token" : "none";
}
function resolveUnauthorizedHandshakeContext(params) {
	const authProvided = resolveAuthProvidedKind(params.connectAuth);
	const canRetryWithDeviceToken = params.failedAuth.reason === "token_mismatch" && params.hasDeviceIdentity && authProvided === "token" && !params.connectAuth?.deviceToken;
	if (canRetryWithDeviceToken) return buildUnauthorizedHandshakeContext({
		authProvided,
		canRetryWithDeviceToken,
		recommendedNextStep: "retry_with_device_token"
	});
	switch (params.failedAuth.reason) {
		case "token_missing":
		case "token_missing_config":
		case "password_missing":
		case "password_missing_config": return buildUnauthorizedHandshakeContext({
			authProvided,
			canRetryWithDeviceToken,
			recommendedNextStep: "update_auth_configuration"
		});
		case "token_mismatch":
		case "password_mismatch":
		case "device_token_mismatch": return buildUnauthorizedHandshakeContext({
			authProvided,
			canRetryWithDeviceToken,
			recommendedNextStep: "update_auth_credentials"
		});
		case "rate_limited": return buildUnauthorizedHandshakeContext({
			authProvided,
			canRetryWithDeviceToken,
			recommendedNextStep: "wait_then_retry"
		});
		default: return buildUnauthorizedHandshakeContext({
			authProvided,
			canRetryWithDeviceToken,
			recommendedNextStep: "review_auth_configuration"
		});
	}
}
//#endregion
//#region src/gateway/server/ws-connection/unauthorized-flood-guard.ts
const DEFAULT_CLOSE_AFTER = 10;
const DEFAULT_LOG_EVERY = 100;
var UnauthorizedFloodGuard = class {
	constructor(options) {
		this.count = 0;
		this.suppressedSinceLastLog = 0;
		this.closeAfter = Math.max(1, Math.floor(options?.closeAfter ?? DEFAULT_CLOSE_AFTER));
		this.logEvery = Math.max(1, Math.floor(options?.logEvery ?? DEFAULT_LOG_EVERY));
	}
	registerUnauthorized() {
		this.count += 1;
		const shouldClose = this.count > this.closeAfter;
		if (!(this.count === 1 || this.count % this.logEvery === 0 || shouldClose)) {
			this.suppressedSinceLastLog += 1;
			return {
				shouldClose,
				shouldLog: false,
				count: this.count,
				suppressedSinceLastLog: 0
			};
		}
		const suppressedSinceLastLog = this.suppressedSinceLastLog;
		this.suppressedSinceLastLog = 0;
		return {
			shouldClose,
			shouldLog: true,
			count: this.count,
			suppressedSinceLastLog
		};
	}
	reset() {
		this.count = 0;
		this.suppressedSinceLastLog = 0;
	}
};
function isUnauthorizedRoleError(error) {
	if (!error) return false;
	return error.code === ErrorCodes.INVALID_REQUEST && typeof error.message === "string" && error.message.startsWith("unauthorized role:");
}
//#endregion
//#region src/gateway/server/ws-connection/message-handler.ts
const DEVICE_SIGNATURE_SKEW_MS = 120 * 1e3;
function resolvePinnedClientMetadata(params) {
	const claimedPlatform = normalizeDeviceMetadataForAuth(params.claimedPlatform);
	const claimedDeviceFamily = normalizeDeviceMetadataForAuth(params.claimedDeviceFamily);
	const pairedPlatform = normalizeDeviceMetadataForAuth(params.pairedPlatform);
	const pairedDeviceFamily = normalizeDeviceMetadataForAuth(params.pairedDeviceFamily);
	const hasPinnedPlatform = pairedPlatform !== "";
	const hasPinnedDeviceFamily = pairedDeviceFamily !== "";
	return {
		platformMismatch: hasPinnedPlatform && claimedPlatform !== pairedPlatform,
		deviceFamilyMismatch: hasPinnedDeviceFamily && claimedDeviceFamily !== pairedDeviceFamily,
		pinnedPlatform: hasPinnedPlatform ? params.pairedPlatform : void 0,
		pinnedDeviceFamily: hasPinnedDeviceFamily ? params.pairedDeviceFamily : void 0
	};
}
function attachGatewayWsMessageHandler(params) {
	const { socket, upgradeReq, connId, remoteAddr, forwardedFor, realIp, requestHost, requestOrigin, requestUserAgent, canvasHostUrl, connectNonce, resolvedAuth, rateLimiter, browserRateLimiter, gatewayMethods, events, extraHandlers, buildRequestContext, send, close, isClosed, clearHandshakeTimer, getClient, setClient, setHandshakeState, setCloseCause, setLastFrameMeta, originCheckMetrics, logGateway, logHealth, logWsControl } = params;
	const configSnapshot = loadConfig();
	const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
	const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
	const clientIp = resolveClientIp({
		remoteAddr,
		forwardedFor,
		realIp,
		trustedProxies,
		allowRealIpFallback
	});
	const hasProxyHeaders = Boolean(forwardedFor || realIp);
	const remoteIsTrustedProxy = isTrustedProxyAddress(remoteAddr, trustedProxies);
	const hasUntrustedProxyHeaders = hasProxyHeaders && !remoteIsTrustedProxy;
	const hostIsLocalish = isLocalishHost(requestHost);
	const isLocalClient = isLocalDirectRequest(upgradeReq, trustedProxies, allowRealIpFallback);
	const reportedClientIp = isLocalClient || hasUntrustedProxyHeaders ? void 0 : clientIp && !isLoopbackAddress(clientIp) ? clientIp : void 0;
	if (hasUntrustedProxyHeaders) logWsControl.warn("Proxy headers detected from untrusted address. Connection will not be treated as local. Configure gateway.trustedProxies to restore local client detection behind your proxy.");
	if (!hostIsLocalish && isLoopbackAddress(remoteAddr) && !hasProxyHeaders) logWsControl.warn("Loopback connection with non-local Host header. Treating it as remote. If you're behind a reverse proxy, set gateway.trustedProxies and forward X-Forwarded-For/X-Real-IP.");
	const isWebchatConnect = (p) => isWebchatClient(p?.client);
	const unauthorizedFloodGuard = new UnauthorizedFloodGuard();
	const { hasBrowserOriginHeader, enforceOriginCheckForAnyClient, rateLimitClientIp: browserRateLimitClientIp, authRateLimiter } = resolveHandshakeBrowserSecurityContext({
		requestOrigin,
		clientIp,
		rateLimiter,
		browserRateLimiter
	});
	socket.on("message", async (data) => {
		if (isClosed()) return;
		const preauthPayloadBytes = !getClient() ? getRawDataByteLength(data) : void 0;
		if (preauthPayloadBytes !== void 0 && preauthPayloadBytes > 65536) {
			setHandshakeState("failed");
			setCloseCause("preauth-payload-too-large", {
				payloadBytes: preauthPayloadBytes,
				limitBytes: MAX_PREAUTH_PAYLOAD_BYTES
			});
			close(1009, "preauth payload too large");
			return;
		}
		const text = rawDataToString(data);
		try {
			const parsed = JSON.parse(text);
			const frameType = parsed && typeof parsed === "object" && "type" in parsed ? typeof parsed.type === "string" ? String(parsed.type) : void 0 : void 0;
			const frameMethod = parsed && typeof parsed === "object" && "method" in parsed ? typeof parsed.method === "string" ? String(parsed.method) : void 0 : void 0;
			const frameId = parsed && typeof parsed === "object" && "id" in parsed ? typeof parsed.id === "string" ? String(parsed.id) : void 0 : void 0;
			if (frameType || frameMethod || frameId) setLastFrameMeta({
				type: frameType,
				method: frameMethod,
				id: frameId
			});
			const client = getClient();
			if (!client) {
				const isRequestFrame = validateRequestFrame(parsed);
				if (!isRequestFrame || parsed.method !== "connect" || !validateConnectParams(parsed.params)) {
					const handshakeError = isRequestFrame ? parsed.method === "connect" ? `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}` : "invalid handshake: first request must be connect" : "invalid request frame";
					setHandshakeState("failed");
					setCloseCause("invalid-handshake", {
						frameType,
						frameMethod,
						frameId,
						handshakeError
					});
					if (isRequestFrame) send({
						type: "res",
						id: parsed.id,
						ok: false,
						error: errorShape(ErrorCodes.INVALID_REQUEST, handshakeError)
					});
					else logWsControl.warn(`invalid handshake conn=${connId} remote=${remoteAddr ?? "?"} fwd=${forwardedFor ?? "n/a"} origin=${requestOrigin ?? "n/a"} host=${requestHost ?? "n/a"} ua=${requestUserAgent ?? "n/a"}`);
					const closeReason = truncateCloseReason(handshakeError || "invalid handshake");
					if (isRequestFrame) queueMicrotask(() => close(1008, closeReason));
					else close(1008, closeReason);
					return;
				}
				const frame = parsed;
				const connectParams = frame.params;
				const clientLabel = connectParams.client.displayName ?? connectParams.client.id;
				const clientMeta = {
					client: connectParams.client.id,
					clientDisplayName: connectParams.client.displayName,
					mode: connectParams.client.mode,
					version: connectParams.client.version
				};
				const markHandshakeFailure = (cause, meta) => {
					setHandshakeState("failed");
					setCloseCause(cause, {
						...meta,
						...clientMeta
					});
				};
				const sendHandshakeErrorResponse = (code, message, options) => {
					send({
						type: "res",
						id: frame.id,
						ok: false,
						error: errorShape(code, message, options)
					});
				};
				const { minProtocol, maxProtocol } = connectParams;
				if (maxProtocol < 3 || minProtocol > 3) {
					markHandshakeFailure("protocol-mismatch", {
						minProtocol,
						maxProtocol,
						expectedProtocol: 3
					});
					logWsControl.warn(`protocol mismatch conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`);
					sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "protocol mismatch", { details: { expectedProtocol: 3 } });
					close(1002, "protocol mismatch");
					return;
				}
				const roleRaw = connectParams.role ?? "operator";
				const role = parseGatewayRole(roleRaw);
				if (!role) {
					markHandshakeFailure("invalid-role", { role: roleRaw });
					sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "invalid role");
					close(1008, "invalid role");
					return;
				}
				let scopes = Array.isArray(connectParams.scopes) ? connectParams.scopes : [];
				connectParams.role = role;
				connectParams.scopes = scopes;
				const isControlUi = connectParams.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI;
				const isWebchat = isWebchatConnect(connectParams);
				if (enforceOriginCheckForAnyClient || isControlUi || isWebchat) {
					const hostHeaderOriginFallbackEnabled = configSnapshot.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
					const originCheck = checkBrowserOrigin({
						requestHost,
						origin: requestOrigin,
						allowedOrigins: configSnapshot.gateway?.controlUi?.allowedOrigins,
						allowHostHeaderOriginFallback: hostHeaderOriginFallbackEnabled,
						isLocalClient
					});
					if (!originCheck.ok) {
						const errorMessage = "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)";
						markHandshakeFailure("origin-mismatch", {
							origin: requestOrigin ?? "n/a",
							host: requestHost ?? "n/a",
							reason: originCheck.reason
						});
						sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, errorMessage, { details: {
							code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
							reason: originCheck.reason
						} });
						close(1008, truncateCloseReason(errorMessage));
						return;
					}
					if (originCheck.matchedBy === "host-header-fallback") {
						originCheckMetrics.hostHeaderFallbackAccepted += 1;
						logWsControl.warn(`security warning: websocket origin accepted via Host-header fallback conn=${connId} count=${originCheckMetrics.hostHeaderFallbackAccepted} host=${requestHost ?? "n/a"} origin=${requestOrigin ?? "n/a"}`);
						if (hostHeaderOriginFallbackEnabled) logGateway.warn("security metric: gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback accepted a websocket connect request");
					}
				}
				const deviceRaw = connectParams.device;
				let devicePublicKey = null;
				let deviceAuthPayloadVersion = null;
				const hasTokenAuth = Boolean(connectParams.auth?.token);
				const hasPasswordAuth = Boolean(connectParams.auth?.password);
				const hasSharedAuth = hasTokenAuth || hasPasswordAuth;
				const controlUiAuthPolicy = resolveControlUiAuthPolicy({
					isControlUi,
					controlUiConfig: configSnapshot.gateway?.controlUi,
					deviceRaw
				});
				const device = controlUiAuthPolicy.device;
				let { authResult, authOk, authMethod, sharedAuthOk, bootstrapTokenCandidate, deviceTokenCandidate, deviceTokenCandidateSource } = await resolveConnectAuthState({
					resolvedAuth,
					connectAuth: connectParams.auth,
					hasDeviceIdentity: Boolean(device),
					req: upgradeReq,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter: authRateLimiter,
					clientIp: browserRateLimitClientIp
				});
				const rejectUnauthorized = (failedAuth) => {
					const { authProvided, canRetryWithDeviceToken, recommendedNextStep } = resolveUnauthorizedHandshakeContext({
						connectAuth: connectParams.auth,
						failedAuth,
						hasDeviceIdentity: Boolean(device)
					});
					markHandshakeFailure("unauthorized", {
						authMode: resolvedAuth.mode,
						authProvided,
						authReason: failedAuth.reason,
						allowTailscale: resolvedAuth.allowTailscale
					});
					logWsControl.warn(`unauthorized conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version} reason=${failedAuth.reason ?? "unknown"}`);
					const authMessage = formatGatewayAuthFailureMessage({
						authMode: resolvedAuth.mode,
						authProvided,
						reason: failedAuth.reason,
						client: connectParams.client
					});
					sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, authMessage, { details: {
						code: resolveAuthConnectErrorDetailCode(failedAuth.reason),
						authReason: failedAuth.reason,
						canRetryWithDeviceToken,
						recommendedNextStep
					} });
					close(1008, truncateCloseReason(authMessage));
				};
				const clearUnboundScopes = () => {
					if (scopes.length > 0) {
						scopes = [];
						connectParams.scopes = scopes;
					}
				};
				const handleMissingDeviceIdentity = () => {
					const trustedProxyAuthOk = isTrustedProxyControlUiOperatorAuth({
						isControlUi,
						role,
						authMode: resolvedAuth.mode,
						authOk,
						authMethod
					});
					const decision = evaluateMissingDeviceIdentity({
						hasDeviceIdentity: Boolean(device),
						role,
						isControlUi,
						controlUiAuthPolicy,
						trustedProxyAuthOk,
						sharedAuthOk,
						authOk,
						hasSharedAuth,
						isLocalClient
					});
					if (!device && (!isControlUi || decision.kind !== "allow")) clearUnboundScopes();
					if (decision.kind === "allow") return true;
					if (decision.kind === "reject-control-ui-insecure-auth") {
						const errorMessage = "control ui requires device identity (use HTTPS or localhost secure context)";
						markHandshakeFailure("control-ui-insecure-auth", { insecureAuthConfigured: controlUiAuthPolicy.allowInsecureAuthConfigured });
						sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, errorMessage, { details: { code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED } });
						close(1008, errorMessage);
						return false;
					}
					if (decision.kind === "reject-unauthorized") {
						rejectUnauthorized(authResult);
						return false;
					}
					markHandshakeFailure("device-required");
					sendHandshakeErrorResponse(ErrorCodes.NOT_PAIRED, "device identity required", { details: { code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED } });
					close(1008, "device identity required");
					return false;
				};
				if (!handleMissingDeviceIdentity()) return;
				if (device) {
					const rejectDeviceAuthInvalid = (reason, message) => {
						setHandshakeState("failed");
						setCloseCause("device-auth-invalid", {
							reason,
							client: connectParams.client.id,
							deviceId: device.id
						});
						send({
							type: "res",
							id: frame.id,
							ok: false,
							error: errorShape(ErrorCodes.INVALID_REQUEST, message, { details: {
								code: resolveDeviceAuthConnectErrorDetailCode(reason),
								reason
							} })
						});
						close(1008, message);
					};
					const derivedId = deriveDeviceIdFromPublicKey(device.publicKey);
					if (!derivedId || derivedId !== device.id) {
						rejectDeviceAuthInvalid("device-id-mismatch", "device identity mismatch");
						return;
					}
					const signedAt = device.signedAt;
					if (typeof signedAt !== "number" || Math.abs(Date.now() - signedAt) > DEVICE_SIGNATURE_SKEW_MS) {
						rejectDeviceAuthInvalid("device-signature-stale", "device signature expired");
						return;
					}
					const providedNonce = typeof device.nonce === "string" ? device.nonce.trim() : "";
					if (!providedNonce) {
						rejectDeviceAuthInvalid("device-nonce-missing", "device nonce required");
						return;
					}
					if (providedNonce !== connectNonce) {
						rejectDeviceAuthInvalid("device-nonce-mismatch", "device nonce mismatch");
						return;
					}
					const rejectDeviceSignatureInvalid = () => rejectDeviceAuthInvalid("device-signature", "device signature invalid");
					const payloadVersion = resolveDeviceSignaturePayloadVersion({
						device,
						connectParams,
						role,
						scopes,
						signedAtMs: signedAt,
						nonce: providedNonce
					});
					if (!payloadVersion) {
						rejectDeviceSignatureInvalid();
						return;
					}
					deviceAuthPayloadVersion = payloadVersion;
					devicePublicKey = normalizeDevicePublicKeyBase64Url(device.publicKey);
					if (!devicePublicKey) {
						rejectDeviceAuthInvalid("device-public-key", "device public key invalid");
						return;
					}
				}
				({authResult, authOk, authMethod} = await resolveConnectAuthDecision({
					state: {
						authResult,
						authOk,
						authMethod,
						sharedAuthOk,
						sharedAuthProvided: hasSharedAuth,
						bootstrapTokenCandidate,
						deviceTokenCandidate,
						deviceTokenCandidateSource
					},
					hasDeviceIdentity: Boolean(device),
					deviceId: device?.id,
					publicKey: device?.publicKey,
					role,
					scopes,
					rateLimiter: authRateLimiter,
					clientIp: browserRateLimitClientIp,
					verifyBootstrapToken: async ({ deviceId, publicKey, token, role, scopes }) => await verifyDeviceBootstrapToken({
						deviceId,
						publicKey,
						token,
						role,
						scopes
					}),
					verifyDeviceToken
				}));
				if (!authOk) {
					rejectUnauthorized(authResult);
					return;
				}
				const trustedProxyAuthOk = isTrustedProxyControlUiOperatorAuth({
					isControlUi,
					role,
					authMode: resolvedAuth.mode,
					authOk,
					authMethod
				});
				const skipPairing = shouldSkipBackendSelfPairing({
					connectParams,
					isLocalClient,
					hasBrowserOriginHeader,
					sharedAuthOk,
					authMethod
				}) || shouldSkipControlUiPairing(controlUiAuthPolicy, role, trustedProxyAuthOk, resolvedAuth.mode);
				if (device && devicePublicKey && !skipPairing) {
					const formatAuditList = (items) => {
						if (!items || items.length === 0) return "<none>";
						const out = /* @__PURE__ */ new Set();
						for (const item of items) {
							const trimmed = item.trim();
							if (trimmed) out.add(trimmed);
						}
						if (out.size === 0) return "<none>";
						return [...out].toSorted().join(",");
					};
					const logUpgradeAudit = (reason, currentRoles, currentScopes) => {
						logGateway.warn(`security audit: device access upgrade requested reason=${reason} device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} roleFrom=${formatAuditList(currentRoles)} roleTo=${role} scopesFrom=${formatAuditList(currentScopes)} scopesTo=${formatAuditList(scopes)} client=${connectParams.client.id} conn=${connId}`);
					};
					const clientPairingMetadata = {
						displayName: connectParams.client.displayName,
						platform: connectParams.client.platform,
						deviceFamily: connectParams.client.deviceFamily,
						clientId: connectParams.client.id,
						clientMode: connectParams.client.mode,
						role,
						scopes,
						remoteIp: reportedClientIp
					};
					const clientAccessMetadata = {
						displayName: connectParams.client.displayName,
						clientId: connectParams.client.id,
						clientMode: connectParams.client.mode,
						role,
						scopes,
						remoteIp: reportedClientIp
					};
					const requirePairing = async (reason) => {
						const allowSilentLocalPairing = shouldAllowSilentLocalPairing({
							isLocalClient,
							hasBrowserOriginHeader,
							isControlUi,
							isWebchat,
							reason
						});
						const pairing = await requestDevicePairing({
							deviceId: device.id,
							publicKey: devicePublicKey,
							...clientPairingMetadata,
							silent: allowSilentLocalPairing
						});
						const context = buildRequestContext();
						if (pairing.request.silent === true) {
							const approved = await approveDevicePairing(pairing.request.requestId);
							if (approved) {
								logGateway.info(`device pairing auto-approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`);
								context.broadcast("device.pair.resolved", {
									requestId: pairing.request.requestId,
									deviceId: approved.device.deviceId,
									decision: "approved",
									ts: Date.now()
								}, { dropIfSlow: true });
							}
						} else if (pairing.created) context.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
						if (pairing.request.silent !== true) {
							setHandshakeState("failed");
							setCloseCause("pairing-required", {
								deviceId: device.id,
								requestId: pairing.request.requestId,
								reason
							});
							send({
								type: "res",
								id: frame.id,
								ok: false,
								error: errorShape(ErrorCodes.NOT_PAIRED, "pairing required", { details: {
									code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
									requestId: pairing.request.requestId,
									reason
								} })
							});
							close(1008, "pairing required");
							return false;
						}
						return true;
					};
					const paired = await getPairedDevice(device.id);
					if (!(paired?.publicKey === devicePublicKey)) {
						if (!await requirePairing("not-paired")) return;
					} else {
						const claimedPlatform = connectParams.client.platform;
						const pairedPlatform = paired.platform;
						const claimedDeviceFamily = connectParams.client.deviceFamily;
						const pairedDeviceFamily = paired.deviceFamily;
						const metadataPinning = resolvePinnedClientMetadata({
							claimedPlatform,
							claimedDeviceFamily,
							pairedPlatform,
							pairedDeviceFamily
						});
						const { platformMismatch, deviceFamilyMismatch } = metadataPinning;
						if (platformMismatch || deviceFamilyMismatch) {
							logGateway.warn(`security audit: device metadata upgrade requested reason=metadata-upgrade device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} payload=${deviceAuthPayloadVersion ?? "unknown"} claimedPlatform=${claimedPlatform ?? "<none>"} pinnedPlatform=${pairedPlatform ?? "<none>"} claimedDeviceFamily=${claimedDeviceFamily ?? "<none>"} pinnedDeviceFamily=${pairedDeviceFamily ?? "<none>"} client=${connectParams.client.id} conn=${connId}`);
							if (!await requirePairing("metadata-upgrade")) return;
						} else {
							if (metadataPinning.pinnedPlatform) connectParams.client.platform = metadataPinning.pinnedPlatform;
							if (metadataPinning.pinnedDeviceFamily) connectParams.client.deviceFamily = metadataPinning.pinnedDeviceFamily;
						}
						const pairedRoles = Array.isArray(paired.roles) ? paired.roles : paired.role ? [paired.role] : [];
						const pairedScopes = Array.isArray(paired.scopes) ? paired.scopes : Array.isArray(paired.approvedScopes) ? paired.approvedScopes : [];
						const allowedRoles = new Set(pairedRoles);
						if (allowedRoles.size === 0) {
							logUpgradeAudit("role-upgrade", pairedRoles, pairedScopes);
							if (!await requirePairing("role-upgrade")) return;
						} else if (!allowedRoles.has(role)) {
							logUpgradeAudit("role-upgrade", pairedRoles, pairedScopes);
							if (!await requirePairing("role-upgrade")) return;
						}
						if (scopes.length > 0) {
							if (pairedScopes.length === 0) {
								logUpgradeAudit("scope-upgrade", pairedRoles, pairedScopes);
								if (!await requirePairing("scope-upgrade")) return;
							} else if (!roleScopesAllow({
								role,
								requestedScopes: scopes,
								allowedScopes: pairedScopes
							})) {
								logUpgradeAudit("scope-upgrade", pairedRoles, pairedScopes);
								if (!await requirePairing("scope-upgrade")) return;
							}
						}
						await updatePairedDeviceMetadata(device.id, clientAccessMetadata);
					}
				}
				const deviceToken = device ? await ensureDeviceToken({
					deviceId: device.id,
					role,
					scopes
				}) : null;
				if (role === "node") {
					const allowlist = resolveNodeCommandAllowlist(loadConfig(), {
						platform: connectParams.client.platform,
						deviceFamily: connectParams.client.deviceFamily
					});
					connectParams.commands = (Array.isArray(connectParams.commands) ? connectParams.commands : []).map((cmd) => cmd.trim()).filter((cmd) => cmd.length > 0 && allowlist.has(cmd));
				}
				const shouldTrackPresence = !isGatewayCliClient(connectParams.client);
				const clientId = connectParams.client.id;
				const instanceId = connectParams.client.instanceId;
				const presenceKey = shouldTrackPresence ? device?.id ?? instanceId ?? connId : void 0;
				logWs("in", "connect", {
					connId,
					client: connectParams.client.id,
					clientDisplayName: connectParams.client.displayName,
					version: connectParams.client.version,
					mode: connectParams.client.mode,
					clientId,
					platform: connectParams.client.platform,
					auth: authMethod
				});
				if (isWebchatConnect(connectParams)) logWsControl.info(`webchat connected conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`);
				if (presenceKey) {
					upsertPresence(presenceKey, {
						host: connectParams.client.displayName ?? connectParams.client.id ?? os.hostname(),
						ip: isLocalClient ? void 0 : reportedClientIp,
						version: connectParams.client.version,
						platform: connectParams.client.platform,
						deviceFamily: connectParams.client.deviceFamily,
						modelIdentifier: connectParams.client.modelIdentifier,
						mode: connectParams.client.mode,
						deviceId: device?.id,
						roles: [role],
						scopes,
						instanceId: device?.id ?? instanceId,
						reason: "connect"
					});
					incrementPresenceVersion();
				}
				const snapshot = buildGatewaySnapshot();
				const cachedHealth = getHealthCache();
				if (cachedHealth) {
					snapshot.health = cachedHealth;
					snapshot.stateVersion.health = getHealthVersion();
				}
				const canvasCapability = role === "node" && canvasHostUrl ? mintCanvasCapabilityToken() : void 0;
				const canvasCapabilityExpiresAtMs = canvasCapability ? Date.now() + CANVAS_CAPABILITY_TTL_MS : void 0;
				const scopedCanvasHostUrl = canvasHostUrl && canvasCapability ? buildCanvasScopedHostUrl(canvasHostUrl, canvasCapability) ?? canvasHostUrl : canvasHostUrl;
				const helloOk = {
					type: "hello-ok",
					protocol: 3,
					server: {
						version: resolveRuntimeServiceVersion(process.env),
						connId
					},
					features: {
						methods: gatewayMethods,
						events
					},
					snapshot,
					canvasHostUrl: scopedCanvasHostUrl,
					auth: deviceToken ? {
						deviceToken: deviceToken.token,
						role: deviceToken.role,
						scopes: deviceToken.scopes,
						issuedAtMs: deviceToken.rotatedAtMs ?? deviceToken.createdAtMs
					} : void 0,
					policy: {
						maxPayload: MAX_PAYLOAD_BYTES,
						maxBufferedBytes: MAX_BUFFERED_BYTES,
						tickIntervalMs: TICK_INTERVAL_MS
					}
				};
				clearHandshakeTimer();
				const nextClient = {
					socket,
					connect: connectParams,
					connId,
					presenceKey,
					clientIp: reportedClientIp,
					canvasHostUrl,
					canvasCapability,
					canvasCapabilityExpiresAtMs
				};
				setSocketMaxPayload(socket, MAX_PAYLOAD_BYTES);
				setClient(nextClient);
				setHandshakeState("connected");
				if (role === "node") {
					const context = buildRequestContext();
					const nodeSession = context.nodeRegistry.register(nextClient, { remoteIp: reportedClientIp });
					const instanceIdRaw = connectParams.client.instanceId;
					const instanceId = typeof instanceIdRaw === "string" ? instanceIdRaw.trim() : "";
					const nodeIdsForPairing = new Set([nodeSession.nodeId]);
					if (instanceId) nodeIdsForPairing.add(instanceId);
					for (const nodeId of nodeIdsForPairing) updatePairedNodeMetadata(nodeId, { lastConnectedAtMs: nodeSession.connectedAtMs }).catch((err) => logGateway.warn(`failed to record last connect for ${nodeId}: ${formatForLog(err)}`));
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
						cfg: loadConfig()
					}).catch((err) => logGateway.warn(`remote bin probe failed for ${nodeSession.nodeId}: ${formatForLog(err)}`));
					loadVoiceWakeConfig().then((cfg) => {
						context.nodeRegistry.sendEvent(nodeSession.nodeId, "voicewake.changed", { triggers: cfg.triggers });
					}).catch((err) => logGateway.warn(`voicewake snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`));
				}
				logWs("out", "hello-ok", {
					connId,
					methods: gatewayMethods.length,
					events: events.length,
					presence: snapshot.presence.length,
					stateVersion: snapshot.stateVersion.presence
				});
				send({
					type: "res",
					id: frame.id,
					ok: true,
					payload: helloOk
				});
				refreshGatewayHealthSnapshot({ probe: true }).catch((err) => logHealth.error(`post-connect health refresh failed: ${formatError(err)}`));
				return;
			}
			if (!validateRequestFrame(parsed)) {
				send({
					type: "res",
					id: parsed?.id ?? "invalid",
					ok: false,
					error: errorShape(ErrorCodes.INVALID_REQUEST, `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`)
				});
				return;
			}
			const req = parsed;
			logWs("in", "req", {
				connId,
				id: req.id,
				method: req.method
			});
			const respond = (ok, payload, error, meta) => {
				send({
					type: "res",
					id: req.id,
					ok,
					payload,
					error
				});
				const unauthorizedRoleError = isUnauthorizedRoleError(error);
				let logMeta = meta;
				if (unauthorizedRoleError) {
					const unauthorizedDecision = unauthorizedFloodGuard.registerUnauthorized();
					if (unauthorizedDecision.suppressedSinceLastLog > 0) logMeta = {
						...logMeta,
						suppressedUnauthorizedResponses: unauthorizedDecision.suppressedSinceLastLog
					};
					if (!unauthorizedDecision.shouldLog) return;
					if (unauthorizedDecision.shouldClose) {
						setCloseCause("repeated-unauthorized-requests", {
							unauthorizedCount: unauthorizedDecision.count,
							method: req.method
						});
						queueMicrotask(() => close(1008, "repeated unauthorized calls"));
					}
					logMeta = {
						...logMeta,
						unauthorizedCount: unauthorizedDecision.count
					};
				} else unauthorizedFloodGuard.reset();
				logWs("out", "res", {
					connId,
					id: req.id,
					ok,
					method: req.method,
					errorCode: error?.code,
					errorMessage: error?.message,
					...logMeta
				});
			};
			(async () => {
				await handleGatewayRequest({
					req,
					respond,
					client,
					isWebchatConnect,
					extraHandlers,
					context: buildRequestContext()
				});
			})().catch((err) => {
				logGateway.error(`request handler failed: ${formatForLog(err)}`);
				respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
			});
		} catch (err) {
			logGateway.error(`parse/handle error: ${String(err)}`);
			logWs("out", "parse-error", {
				connId,
				error: formatForLog(err)
			});
			if (!getClient()) close();
		}
	});
}
function getRawDataByteLength(data) {
	if (Buffer.isBuffer(data)) return data.byteLength;
	if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
	if (data instanceof ArrayBuffer) return data.byteLength;
	return Buffer.byteLength(String(data));
}
function setSocketMaxPayload(socket, maxPayload) {
	const receiver = socket._receiver;
	if (receiver) receiver._maxPayload = maxPayload;
}
//#endregion
//#region src/gateway/server/ws-connection.ts
init_utils();
const LOG_HEADER_MAX_LEN = 300;
const LOG_HEADER_FORMAT_REGEX = /\p{Cf}/gu;
function replaceControlChars(value) {
	let cleaned = "";
	for (const char of value) {
		const codePoint = char.codePointAt(0);
		if (codePoint !== void 0 && (codePoint <= 31 || codePoint >= 127 && codePoint <= 159)) {
			cleaned += " ";
			continue;
		}
		cleaned += char;
	}
	return cleaned;
}
const sanitizeLogValue = (value) => {
	if (!value) return;
	const cleaned = replaceControlChars(value).replace(LOG_HEADER_FORMAT_REGEX, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return;
	if (cleaned.length <= LOG_HEADER_MAX_LEN) return cleaned;
	return truncateUtf16Safe(cleaned, LOG_HEADER_MAX_LEN);
};
function attachGatewayWsConnectionHandler(params) {
	const { wss, clients, port, gatewayHost, canvasHostEnabled, canvasHostServerPort, resolvedAuth, rateLimiter, browserRateLimiter, gatewayMethods, events, logGateway, logHealth, logWsControl, extraHandlers, broadcast, buildRequestContext } = params;
	const originCheckMetrics = { hostHeaderFallbackAccepted: 0 };
	wss.on("connection", (socket, upgradeReq) => {
		let client = null;
		let closed = false;
		const openedAt = Date.now();
		const connId = randomUUID();
		const remoteAddr = socket._socket?.remoteAddress;
		const headerValue = (value) => Array.isArray(value) ? value[0] : value;
		const requestHost = headerValue(upgradeReq.headers.host);
		const requestOrigin = headerValue(upgradeReq.headers.origin);
		const requestUserAgent = headerValue(upgradeReq.headers["user-agent"]);
		const forwardedFor = headerValue(upgradeReq.headers["x-forwarded-for"]);
		const realIp = headerValue(upgradeReq.headers["x-real-ip"]);
		const canvasHostUrl = resolveCanvasHostUrl({
			canvasPort: canvasHostServerPort ?? (canvasHostEnabled ? port : void 0),
			hostOverride: canvasHostServerPort ? gatewayHost && gatewayHost !== "0.0.0.0" && gatewayHost !== "::" ? gatewayHost : void 0 : void 0,
			requestHost: upgradeReq.headers.host,
			forwardedProto: upgradeReq.headers["x-forwarded-proto"],
			localAddress: upgradeReq.socket?.localAddress
		});
		logWs("in", "open", {
			connId,
			remoteAddr
		});
		let handshakeState = "pending";
		let closeCause;
		let closeMeta = {};
		let lastFrameType;
		let lastFrameMethod;
		let lastFrameId;
		const setCloseCause = (cause, meta) => {
			if (!closeCause) closeCause = cause;
			if (meta && Object.keys(meta).length > 0) closeMeta = {
				...closeMeta,
				...meta
			};
		};
		const setLastFrameMeta = (meta) => {
			if (meta.type || meta.method || meta.id) {
				lastFrameType = meta.type ?? lastFrameType;
				lastFrameMethod = meta.method ?? lastFrameMethod;
				lastFrameId = meta.id ?? lastFrameId;
			}
		};
		const send = (obj) => {
			try {
				socket.send(JSON.stringify(obj));
			} catch {}
		};
		const connectNonce = randomUUID();
		send({
			type: "event",
			event: "connect.challenge",
			payload: {
				nonce: connectNonce,
				ts: Date.now()
			}
		});
		const close = (code = 1e3, reason) => {
			if (closed) return;
			closed = true;
			clearTimeout(handshakeTimer);
			if (client) clients.delete(client);
			try {
				socket.close(code, reason);
			} catch {}
		};
		socket.once("error", (err) => {
			logWsControl.warn(`error conn=${connId} remote=${remoteAddr ?? "?"}: ${formatError(err)}`);
			close();
		});
		const isNoisySwiftPmHelperClose = (userAgent, remote) => Boolean(userAgent?.toLowerCase().includes("swiftpm-testing-helper") && isLoopbackAddress(remote));
		socket.once("close", (code, reason) => {
			const durationMs = Date.now() - openedAt;
			const logForwardedFor = sanitizeLogValue(forwardedFor);
			const logOrigin = sanitizeLogValue(requestOrigin);
			const logHost = sanitizeLogValue(requestHost);
			const logUserAgent = sanitizeLogValue(requestUserAgent);
			const logReason = sanitizeLogValue(reason?.toString());
			const closeContext = {
				cause: closeCause,
				handshake: handshakeState,
				durationMs,
				lastFrameType,
				lastFrameMethod,
				lastFrameId,
				host: logHost,
				origin: logOrigin,
				userAgent: logUserAgent,
				forwardedFor: logForwardedFor,
				...closeMeta
			};
			if (!client) (isNoisySwiftPmHelperClose(requestUserAgent, remoteAddr) ? logWsControl.debug : logWsControl.warn)(`closed before connect conn=${connId} remote=${remoteAddr ?? "?"} fwd=${logForwardedFor || "n/a"} origin=${logOrigin || "n/a"} host=${logHost || "n/a"} ua=${logUserAgent || "n/a"} code=${code ?? "n/a"} reason=${logReason || "n/a"}`, closeContext);
			if (client && isWebchatClient(client.connect.client)) logWsControl.info(`webchat disconnected code=${code} reason=${logReason || "n/a"} conn=${connId}`);
			if (client?.presenceKey) {
				upsertPresence(client.presenceKey, { reason: "disconnect" });
				broadcastPresenceSnapshot({
					broadcast,
					incrementPresenceVersion,
					getHealthVersion
				});
			}
			if (client?.connect?.role === "node") {
				const context = buildRequestContext();
				const nodeId = context.nodeRegistry.unregister(connId);
				if (nodeId) {
					removeRemoteNodeInfo(nodeId);
					context.nodeUnsubscribeAll(nodeId);
				}
			}
			logWs("out", "close", {
				connId,
				code,
				reason: logReason,
				durationMs,
				cause: closeCause,
				handshake: handshakeState,
				lastFrameType,
				lastFrameMethod,
				lastFrameId
			});
			close();
		});
		const handshakeTimeoutMs = getHandshakeTimeoutMs();
		const handshakeTimer = setTimeout(() => {
			if (!client) {
				handshakeState = "failed";
				setCloseCause("handshake-timeout", { handshakeMs: Date.now() - openedAt });
				logWsControl.warn(`handshake timeout conn=${connId} remote=${remoteAddr ?? "?"}`);
				close();
			}
		}, handshakeTimeoutMs);
		attachGatewayWsMessageHandler({
			socket,
			upgradeReq,
			connId,
			remoteAddr,
			forwardedFor,
			realIp,
			requestHost,
			requestOrigin,
			requestUserAgent,
			canvasHostUrl,
			connectNonce,
			resolvedAuth,
			rateLimiter,
			browserRateLimiter,
			gatewayMethods,
			events,
			extraHandlers,
			buildRequestContext,
			send,
			close,
			isClosed: () => closed,
			clearHandshakeTimer: () => clearTimeout(handshakeTimer),
			getClient: () => client,
			setClient: (next) => {
				client = next;
				clients.add(next);
			},
			setHandshakeState: (next) => {
				handshakeState = next;
			},
			setCloseCause,
			setLastFrameMeta,
			originCheckMetrics,
			logGateway,
			logHealth,
			logWsControl
		});
	});
}
//#endregion
//#region src/gateway/server-ws-runtime.ts
function attachGatewayWsHandlers(params) {
	attachGatewayWsConnectionHandler({
		wss: params.wss,
		clients: params.clients,
		port: params.port,
		gatewayHost: params.gatewayHost,
		canvasHostEnabled: params.canvasHostEnabled,
		canvasHostServerPort: params.canvasHostServerPort,
		resolvedAuth: params.resolvedAuth,
		rateLimiter: params.rateLimiter,
		browserRateLimiter: params.browserRateLimiter,
		gatewayMethods: params.gatewayMethods,
		events: params.events,
		logGateway: params.logGateway,
		logHealth: params.logHealth,
		logWsControl: params.logWsControl,
		extraHandlers: params.extraHandlers,
		broadcast: params.broadcast,
		buildRequestContext: () => params.context
	});
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
		if (cachedState && now - cachedAt < cacheTtlMs) return {
			...cachedState,
			uptimeMs
		};
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
		return {
			...cachedState,
			uptimeMs
		};
	};
}
//#endregion
//#region src/gateway/server/tls.ts
async function loadGatewayTlsRuntime(cfg, log) {
	return await loadGatewayTlsRuntime$1(cfg, log);
}
//#endregion
//#region src/gateway/startup-control-ui-origins.ts
async function maybeSeedControlUiAllowedOriginsAtStartup(params) {
	const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(params.config);
	if (!seeded.seededOrigins || !seeded.bind) return params.config;
	try {
		await params.writeConfig(seeded.config);
		params.log.info(buildSeededOriginsInfoLog(seeded.seededOrigins, seeded.bind));
	} catch (err) {
		params.log.warn(`gateway: failed to persist gateway.controlUi.allowedOrigins seed: ${String(err)}. The gateway will start with the in-memory value but config was not saved.`);
	}
	return seeded.config;
}
function buildSeededOriginsInfoLog(origins, bind) {
	return `gateway: seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} for bind=${bind} (required since v2026.2.26; see issue #29385). Add other origins to gateway.controlUi.allowedOrigins if needed.`;
}
//#endregion
//#region src/gateway/server.impl.ts
init_subsystem();
ensureOpenClawCliOnPath();
const MAX_MEDIA_TTL_HOURS = 168;
function resolveMediaCleanupTtlMs(ttlHoursRaw) {
	const ttlMs = Math.min(Math.max(ttlHoursRaw, 1), MAX_MEDIA_TTL_HOURS) * 60 * 6e4;
	if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(ttlMs)) throw new Error(`Invalid media.ttlHours: ${String(ttlHoursRaw)}`);
	return ttlMs;
}
const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");
const logBrowser = log.child("browser");
let cachedChannelRuntime = null;
function getChannelRuntime() {
	cachedChannelRuntime ??= createPluginRuntime().channel;
	return cachedChannelRuntime;
}
const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const logSecrets = log.child("secrets");
const gatewayRuntime = runtimeForLogger(log);
const canvasRuntime = runtimeForLogger(logCanvas);
function createGatewayAuthRateLimiters(rateLimitConfig) {
	return {
		rateLimiter: rateLimitConfig ? createAuthRateLimiter(rateLimitConfig) : void 0,
		browserRateLimiter: createAuthRateLimiter({
			...rateLimitConfig,
			exemptLoopback: false
		})
	};
}
function logGatewayAuthSurfaceDiagnostics(prepared) {
	const states = evaluateGatewayAuthSurfaceStates({
		config: prepared.sourceConfig,
		defaults: prepared.sourceConfig.secrets?.defaults,
		env: process.env
	});
	const inactiveWarnings = /* @__PURE__ */ new Map();
	for (const warning of prepared.warnings) {
		if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") continue;
		inactiveWarnings.set(warning.path, warning.message);
	}
	for (const path of GATEWAY_AUTH_SURFACE_PATHS) {
		const state = states[path];
		if (!state.hasSecretRef) continue;
		const stateLabel = state.active ? "active" : "inactive";
		const details = (!state.active && inactiveWarnings.get(path) ? inactiveWarnings.get(path) : void 0) ?? state.reason;
		logSecrets.info(`[SECRETS_GATEWAY_AUTH_SURFACE] ${path} is ${stateLabel}. ${details}`);
	}
}
function applyGatewayAuthOverridesForStartupPreflight(config, overrides) {
	if (!overrides.auth && !overrides.tailscale) return config;
	return {
		...config,
		gateway: {
			...config.gateway,
			auth: mergeGatewayAuthConfig(config.gateway?.auth, overrides.auth),
			tailscale: mergeGatewayTailscaleConfig(config.gateway?.tailscale, overrides.tailscale)
		}
	};
}
function assertValidGatewayStartupConfigSnapshot(snapshot, options = {}) {
	if (snapshot.valid) return;
	const issues = snapshot.issues.length > 0 ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n") : "Unknown validation issue.";
	const doctorHint = options.includeDoctorHint ? `\nRun "${formatCliCommand("openclaw doctor")}" to repair, then retry.` : "";
	throw new Error(`Invalid config at ${snapshot.path}.\n${issues}${doctorHint}`);
}
async function prepareGatewayStartupConfig(params) {
	assertValidGatewayStartupConfigSnapshot(params.configSnapshot);
	const startupPreflightConfig = applyGatewayAuthOverridesForStartupPreflight(params.runtimeConfig, {
		auth: params.authOverride,
		tailscale: params.tailscaleOverride
	});
	await params.activateRuntimeSecrets(startupPreflightConfig, {
		reason: "startup",
		activate: false
	});
	const authBootstrap = await ensureGatewayStartupAuth({
		cfg: params.runtimeConfig,
		env: process.env,
		authOverride: params.authOverride,
		tailscaleOverride: params.tailscaleOverride,
		persist: true
	});
	const runtimeStartupConfig = applyGatewayAuthOverridesForStartupPreflight(authBootstrap.cfg, {
		auth: params.authOverride,
		tailscale: params.tailscaleOverride
	});
	const activatedConfig = (await params.activateRuntimeSecrets(runtimeStartupConfig, {
		reason: "startup",
		activate: true
	})).config;
	return {
		...authBootstrap,
		cfg: activatedConfig
	};
}
async function startGatewayServer(port = 18789, opts = {}) {
	const minimalTestGateway = process.env.VITEST === "1" && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";
	process.env.OPENCLAW_GATEWAY_PORT = String(port);
	logAcceptedEnvOption({
		key: "OPENCLAW_RAW_STREAM",
		description: "raw stream logging enabled"
	});
	logAcceptedEnvOption({
		key: "OPENCLAW_RAW_STREAM_PATH",
		description: "raw stream log path override"
	});
	let configSnapshot = await readConfigFileSnapshot();
	if (configSnapshot.legacyIssues.length > 0) {
		if (isNixMode) throw new Error("Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.");
		const { config: migrated, changes } = migrateLegacyConfig(configSnapshot.parsed);
		if (!migrated) log.warn("gateway: legacy config entries detected but no auto-migration changes were produced; continuing with validation.");
		else {
			await writeConfigFile(migrated);
			if (changes.length > 0) log.info(`gateway: migrated legacy config entries:\n${changes.map((entry) => `- ${entry}`).join("\n")}`);
		}
	}
	configSnapshot = await readConfigFileSnapshot();
	if (configSnapshot.exists) assertValidGatewayStartupConfigSnapshot(configSnapshot, { includeDoctorHint: true });
	const autoEnable = applyPluginAutoEnable({
		config: configSnapshot.config,
		env: process.env
	});
	if (autoEnable.changes.length > 0) try {
		await writeConfigFile(autoEnable.config);
		configSnapshot = await readConfigFileSnapshot();
		assertValidGatewayStartupConfigSnapshot(configSnapshot);
		log.info(`gateway: auto-enabled plugins:\n${autoEnable.changes.map((entry) => `- ${entry}`).join("\n")}`);
	} catch (err) {
		log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
	}
	let secretsDegraded = false;
	const emitSecretsStateEvent = (code, message, cfg) => {
		enqueueSystemEvent(`[${code}] ${message}`, {
			sessionKey: resolveMainSessionKey(cfg),
			contextKey: code
		});
	};
	let secretsActivationTail = Promise.resolve();
	const runWithSecretsActivationLock = async (operation) => {
		const run = secretsActivationTail.then(operation, operation);
		secretsActivationTail = run.then(() => void 0, () => void 0);
		return await run;
	};
	const activateRuntimeSecrets = async (config, params) => await runWithSecretsActivationLock(async () => {
		try {
			const prepared = await prepareSecretsRuntimeSnapshot({ config });
			if (params.activate) {
				activateSecretsRuntimeSnapshot(prepared);
				logGatewayAuthSurfaceDiagnostics(prepared);
			}
			for (const warning of prepared.warnings) logSecrets.warn(`[${warning.code}] ${warning.message}`);
			if (secretsDegraded) {
				const recoveredMessage = "Secret resolution recovered; runtime remained on last-known-good during the outage.";
				logSecrets.info(`[SECRETS_RELOADER_RECOVERED] ${recoveredMessage}`);
				emitSecretsStateEvent("SECRETS_RELOADER_RECOVERED", recoveredMessage, prepared.config);
			}
			secretsDegraded = false;
			return prepared;
		} catch (err) {
			const details = String(err);
			if (!secretsDegraded) {
				logSecrets.error(`[SECRETS_RELOADER_DEGRADED] ${details}`);
				if (params.reason !== "startup") emitSecretsStateEvent("SECRETS_RELOADER_DEGRADED", `Secret resolution failed; runtime remains on last-known-good snapshot. ${details}`, config);
			} else logSecrets.warn(`[SECRETS_RELOADER_DEGRADED] ${details}`);
			secretsDegraded = true;
			if (params.reason === "startup") throw new Error(`Startup failed: required secrets are unavailable. ${details}`, { cause: err });
			throw err;
		}
	});
	let cfgAtStart;
	const startupRuntimeConfig = applyConfigOverrides(configSnapshot.config);
	const authBootstrap = await prepareGatewayStartupConfig({
		configSnapshot,
		runtimeConfig: startupRuntimeConfig,
		authOverride: opts.auth,
		tailscaleOverride: opts.tailscale,
		activateRuntimeSecrets
	});
	cfgAtStart = authBootstrap.cfg;
	if (authBootstrap.generatedToken) if (authBootstrap.persistedGeneratedToken) log.info("Gateway auth token was missing. Generated a new token and saved it to config (gateway.auth.token).");
	else log.warn("Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token. Persist one with `openclaw config set gateway.auth.mode token` and `openclaw config set gateway.auth.token <token>`.");
	const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
	if (diagnosticsEnabled) startDiagnosticHeartbeat();
	setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(cfgAtStart) });
	setPreRestartDeferralCheck(() => getTotalQueueSize() + getTotalPendingReplies() + getActiveEmbeddedRunCount());
	cfgAtStart = await maybeSeedControlUiAllowedOriginsAtStartup({
		config: cfgAtStart,
		writeConfig: writeConfigFile,
		log
	});
	initSubagentRegistry();
	const defaultAgentId = resolveDefaultAgentId(cfgAtStart);
	const defaultWorkspaceDir = resolveAgentWorkspaceDir(cfgAtStart, defaultAgentId);
	const deferredConfiguredChannelPluginIds = minimalTestGateway ? [] : resolveConfiguredDeferredChannelPluginIds({
		config: cfgAtStart,
		workspaceDir: defaultWorkspaceDir,
		env: process.env
	});
	const baseMethods = listGatewayMethods();
	let pluginRegistry = createEmptyPluginRegistry();
	let baseGatewayMethods = baseMethods;
	if (!minimalTestGateway) ({pluginRegistry, gatewayMethods: baseGatewayMethods} = loadGatewayPlugins({
		cfg: cfgAtStart,
		workspaceDir: defaultWorkspaceDir,
		log,
		coreGatewayHandlers,
		baseMethods,
		preferSetupRuntimeForChannelPlugins: deferredConfiguredChannelPluginIds.length > 0
	}));
	const channelLogs = Object.fromEntries(listChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]));
	const channelRuntimeEnvs = Object.fromEntries(Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]));
	const channelMethods = listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []);
	const gatewayMethods = Array.from(new Set([...baseGatewayMethods, ...channelMethods]));
	let pluginServices = null;
	const runtimeConfig = await resolveGatewayRuntimeConfig({
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
	const { bindHost, controlUiEnabled, openAiChatCompletionsEnabled, openAiChatCompletionsConfig, openResponsesEnabled, openResponsesConfig, strictTransportSecurityHeader, controlUiBasePath, controlUiRoot: controlUiRootOverride, resolvedAuth, tailscaleConfig, tailscaleMode } = runtimeConfig;
	let hooksConfig = runtimeConfig.hooksConfig;
	let hookClientIpConfig = resolveHookClientIpConfig(cfgAtStart);
	const canvasHostEnabled = runtimeConfig.canvasHostEnabled;
	const rateLimitConfig = cfgAtStart.gateway?.auth?.rateLimit;
	const { rateLimiter: authRateLimiter, browserRateLimiter: browserAuthRateLimiter } = createGatewayAuthRateLimiters(rateLimitConfig);
	let controlUiRootState;
	if (controlUiRootOverride) {
		const resolvedOverride = resolveControlUiRootOverrideSync(controlUiRootOverride);
		const resolvedOverridePath = path.resolve(controlUiRootOverride);
		controlUiRootState = resolvedOverride ? {
			kind: "resolved",
			path: resolvedOverride
		} : {
			kind: "invalid",
			path: resolvedOverridePath
		};
		if (!resolvedOverride) log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
	} else if (controlUiEnabled) {
		let resolvedRoot = resolveControlUiRootSync({
			moduleUrl: import.meta.url,
			argv1: process.argv[1],
			cwd: process.cwd()
		});
		if (!resolvedRoot) {
			const ensureResult = await ensureControlUiAssetsBuilt(gatewayRuntime);
			if (!ensureResult.ok && ensureResult.message) log.warn(`gateway: ${ensureResult.message}`);
			resolvedRoot = resolveControlUiRootSync({
				moduleUrl: import.meta.url,
				argv1: process.argv[1],
				cwd: process.cwd()
			});
		}
		controlUiRootState = resolvedRoot ? {
			kind: isPackageProvenControlUiRootSync(resolvedRoot, {
				moduleUrl: import.meta.url,
				argv1: process.argv[1],
				cwd: process.cwd()
			}) ? "bundled" : "resolved",
			path: resolvedRoot
		} : { kind: "missing" };
	}
	const wizardRunner = opts.wizardRunner ?? runSetupWizard;
	const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();
	const deps = createDefaultDeps();
	let canvasHostServer = null;
	const gatewayTls = await loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls"));
	if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
	const serverStartedAt = Date.now();
	const channelManager = createChannelManager({
		loadConfig,
		channelLogs,
		channelRuntimeEnvs,
		resolveChannelRuntime: getChannelRuntime
	});
	const getReadiness = createReadinessChecker({
		channelManager,
		startedAt: serverStartedAt
	});
	const { canvasHost, releasePluginRouteRegistry, httpServer, httpServers, httpBindHosts, wss, clients, broadcast, broadcastToConnIds, agentRunSeq, dedupe, chatRunState, chatRunBuffers, chatDeltaSentAt, addChatRun, removeChatRun, chatAbortControllers, toolEventRecipients } = await createGatewayRuntimeState({
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
		hooksConfig: () => hooksConfig,
		getHookClientIpConfig: () => hookClientIpConfig,
		pluginRegistry,
		deps,
		canvasRuntime,
		canvasHostEnabled,
		allowCanvasHostInTests: opts.allowCanvasHostInTests,
		logCanvas,
		log,
		logHooks,
		logPlugins,
		getReadiness
	});
	let bonjourStop = null;
	const nodeRegistry = new NodeRegistry();
	const nodePresenceTimers = /* @__PURE__ */ new Map();
	const nodeSubscriptions = createNodeSubscriptionManager();
	const nodeSendEvent = (opts) => {
		const payload = safeParseJson(opts.payloadJSON ?? null);
		nodeRegistry.sendEvent(opts.nodeId, opts.event, payload);
	};
	const nodeSendToSession = (sessionKey, event, payload) => nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
	const nodeSendToAllSubscribed = (event, payload) => nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
	const nodeSubscribe = nodeSubscriptions.subscribe;
	const nodeUnsubscribe = nodeSubscriptions.unsubscribe;
	const nodeUnsubscribeAll = nodeSubscriptions.unsubscribeAll;
	const broadcastVoiceWakeChanged = (triggers) => {
		broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
	};
	const hasMobileNodeConnected = () => hasConnectedMobileNode(nodeRegistry);
	applyGatewayLaneConcurrency(cfgAtStart);
	let cronState = buildGatewayCronService({
		cfg: cfgAtStart,
		deps,
		broadcast
	});
	let { cron, storePath: cronStorePath } = cronState;
	const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } = channelManager;
	if (!minimalTestGateway) bonjourStop = (await startGatewayDiscovery({
		machineDisplayName: await getMachineDisplayName(),
		port,
		gatewayTls: gatewayTls.enabled ? {
			enabled: true,
			fingerprintSha256: gatewayTls.fingerprintSha256
		} : void 0,
		wideAreaDiscoveryEnabled: cfgAtStart.discovery?.wideArea?.enabled === true,
		wideAreaDiscoveryDomain: cfgAtStart.discovery?.wideArea?.domain,
		tailscaleMode,
		mdnsMode: cfgAtStart.discovery?.mdns?.mode,
		logDiscovery
	})).bonjourStop;
	if (!minimalTestGateway) {
		setSkillsRemoteRegistry(nodeRegistry);
		primeRemoteSkillsCache();
	}
	let skillsRefreshTimer = null;
	const skillsRefreshDelayMs = 3e4;
	const skillsChangeUnsub = minimalTestGateway ? () => {} : registerSkillsChangeListener((event) => {
		if (event.reason === "remote-node") return;
		if (skillsRefreshTimer) clearTimeout(skillsRefreshTimer);
		skillsRefreshTimer = setTimeout(() => {
			skillsRefreshTimer = null;
			refreshRemoteBinsForConnectedNodes(loadConfig());
		}, skillsRefreshDelayMs);
	});
	const noopInterval = () => setInterval(() => {}, 1 << 30);
	let tickInterval = noopInterval();
	let healthInterval = noopInterval();
	let dedupeCleanup = noopInterval();
	let mediaCleanup = null;
	if (!minimalTestGateway) ({tickInterval, healthInterval, dedupeCleanup, mediaCleanup} = startGatewayMaintenanceTimers({
		broadcast,
		nodeSendToAllSubscribed,
		getPresenceVersion,
		getHealthVersion,
		refreshGatewayHealthSnapshot,
		logHealth,
		dedupe,
		chatAbortControllers,
		chatRunState,
		chatRunBuffers,
		chatDeltaSentAt,
		removeChatRun,
		agentRunSeq,
		nodeSendToSession,
		...typeof cfgAtStart.media?.ttlHours === "number" ? { mediaCleanupTtlMs: resolveMediaCleanupTtlMs(cfgAtStart.media.ttlHours) } : {}
	}));
	const agentUnsub = minimalTestGateway ? null : onAgentEvent(createAgentEventHandler({
		broadcast,
		broadcastToConnIds,
		nodeSendToSession,
		agentRunSeq,
		chatRunState,
		resolveSessionKeyForRun,
		clearAgentRunContext,
		toolEventRecipients
	}));
	const heartbeatUnsub = minimalTestGateway ? null : onHeartbeatEvent((evt) => {
		broadcast("heartbeat", evt, { dropIfSlow: true });
	});
	let heartbeatRunner = minimalTestGateway ? {
		stop: () => {},
		updateConfig: () => {}
	} : startHeartbeatRunner({ cfg: cfgAtStart });
	const healthCheckMinutes = cfgAtStart.gateway?.channelHealthCheckMinutes;
	const healthCheckDisabled = healthCheckMinutes === 0;
	const staleEventThresholdMinutes = cfgAtStart.gateway?.channelStaleEventThresholdMinutes;
	const maxRestartsPerHour = cfgAtStart.gateway?.channelMaxRestartsPerHour;
	let channelHealthMonitor = healthCheckDisabled ? null : startChannelHealthMonitor({
		channelManager,
		checkIntervalMs: (healthCheckMinutes ?? 5) * 6e4,
		...staleEventThresholdMinutes != null && { staleEventThresholdMs: staleEventThresholdMinutes * 6e4 },
		...maxRestartsPerHour != null && { maxRestartsPerHour }
	});
	if (!minimalTestGateway) cron.start().catch((err) => logCron.error(`failed to start: ${String(err)}`));
	if (!minimalTestGateway) (async () => {
		const { recoverPendingDeliveries } = await import("./delivery-queue-CbEhu86R.js");
		const { deliverOutboundPayloads } = await import("./deliver-Duo84_V8.js");
		await recoverPendingDeliveries({
			deliver: deliverOutboundPayloads,
			log: log.child("delivery-recovery"),
			cfg: cfgAtStart
		});
	})().catch((err) => log.error(`Delivery recovery failed: ${String(err)}`));
	const execApprovalManager = new ExecApprovalManager();
	const execApprovalHandlers = createExecApprovalHandlers(execApprovalManager, { forwarder: createExecApprovalForwarder() });
	const secretsHandlers = createSecretsHandlers({
		reloadSecrets: async () => {
			const active = getActiveSecretsRuntimeSnapshot();
			if (!active) throw new Error("Secrets runtime snapshot is not active.");
			return { warningCount: (await activateRuntimeSecrets(active.sourceConfig, {
				reason: "reload",
				activate: true
			})).warnings.length };
		},
		resolveSecrets: async ({ commandName, targetIds }) => {
			const { assignments, diagnostics, inactiveRefPaths } = resolveCommandSecretsFromActiveRuntimeSnapshot({
				commandName,
				targetIds: new Set(targetIds)
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
	});
	const canvasHostServerPort = canvasHostServer?.port;
	const gatewayRequestContext = {
		deps,
		cron,
		cronStorePath,
		execApprovalManager,
		loadGatewayModelCatalog,
		getHealthCache,
		refreshHealthSnapshot: refreshGatewayHealthSnapshot,
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
		hasConnectedMobileNode: hasMobileNodeConnected,
		hasExecApprovalClients: () => {
			for (const gatewayClient of clients) {
				const scopes = Array.isArray(gatewayClient.connect.scopes) ? gatewayClient.connect.scopes : [];
				if (scopes.includes("operator.admin") || scopes.includes("operator.approvals")) return true;
			}
			return false;
		},
		nodeRegistry,
		agentRunSeq,
		chatAbortControllers,
		chatAbortedRuns: chatRunState.abortedRuns,
		chatRunBuffers: chatRunState.buffers,
		chatDeltaSentAt: chatRunState.deltaSentAt,
		addChatRun,
		removeChatRun,
		registerToolEventRecipient: toolEventRecipients.add,
		dedupe,
		wizardSessions,
		findRunningWizard,
		purgeWizardSession,
		getRuntimeSnapshot,
		startChannel,
		stopChannel,
		markChannelLoggedOut,
		wizardRunner,
		broadcastVoiceWakeChanged
	};
	setFallbackGatewayContext(gatewayRequestContext);
	attachGatewayWsHandlers({
		wss,
		clients,
		port,
		gatewayHost: bindHost ?? void 0,
		canvasHostEnabled: Boolean(canvasHost),
		canvasHostServerPort,
		resolvedAuth,
		rateLimiter: authRateLimiter,
		browserRateLimiter: browserAuthRateLimiter,
		gatewayMethods,
		events: GATEWAY_EVENTS,
		logGateway: log,
		logHealth,
		logWsControl,
		extraHandlers: {
			...pluginRegistry.gatewayHandlers,
			...execApprovalHandlers,
			...secretsHandlers
		},
		broadcast,
		context: gatewayRequestContext
	});
	logGatewayStartup({
		cfg: cfgAtStart,
		bindHost,
		bindHosts: httpBindHosts,
		port,
		tlsEnabled: gatewayTls.enabled,
		log,
		isNixMode
	});
	const stopGatewayUpdateCheck = minimalTestGateway ? () => {} : scheduleGatewayUpdateCheck({
		cfg: cfgAtStart,
		log,
		isNixMode,
		onUpdateAvailableChange: (updateAvailable) => {
			broadcast(GATEWAY_EVENT_UPDATE_AVAILABLE, { updateAvailable }, { dropIfSlow: true });
		}
	});
	const tailscaleCleanup = minimalTestGateway ? null : await startGatewayTailscaleExposure({
		tailscaleMode,
		resetOnExit: tailscaleConfig.resetOnExit,
		port,
		controlUiBasePath,
		logTailscale
	});
	let browserControl = null;
	if (!minimalTestGateway) {
		if (deferredConfiguredChannelPluginIds.length > 0) ({pluginRegistry} = loadGatewayPlugins({
			cfg: cfgAtStart,
			workspaceDir: defaultWorkspaceDir,
			log,
			coreGatewayHandlers,
			baseMethods,
			logDiagnostics: false
		}));
		({browserControl, pluginServices} = await startGatewaySidecars({
			cfg: cfgAtStart,
			pluginRegistry,
			defaultWorkspaceDir,
			deps,
			startChannels,
			log,
			logHooks,
			logChannels,
			logBrowser
		}));
	}
	if (!minimalTestGateway) {
		const hookRunner = getGlobalHookRunner();
		if (hookRunner?.hasHooks("gateway_start")) hookRunner.runGatewayStart({ port }, { port }).catch((err) => {
			log.warn(`gateway_start hook failed: ${String(err)}`);
		});
	}
	const configReloader = minimalTestGateway ? { stop: async () => {} } : (() => {
		const { applyHotReload, requestGatewayRestart } = createGatewayReloadHandlers({
			deps,
			broadcast,
			getState: () => ({
				hooksConfig,
				hookClientIpConfig,
				heartbeatRunner,
				cronState,
				browserControl,
				channelHealthMonitor
			}),
			setState: (nextState) => {
				hooksConfig = nextState.hooksConfig;
				hookClientIpConfig = nextState.hookClientIpConfig;
				heartbeatRunner = nextState.heartbeatRunner;
				cronState = nextState.cronState;
				cron = cronState.cron;
				cronStorePath = cronState.storePath;
				browserControl = nextState.browserControl;
				channelHealthMonitor = nextState.channelHealthMonitor;
			},
			startChannel,
			stopChannel,
			logHooks,
			logBrowser,
			logChannels,
			logCron,
			logReload,
			createHealthMonitor: (opts) => startChannelHealthMonitor({
				channelManager,
				checkIntervalMs: opts.checkIntervalMs,
				...opts.staleEventThresholdMs != null && { staleEventThresholdMs: opts.staleEventThresholdMs },
				...opts.maxRestartsPerHour != null && { maxRestartsPerHour: opts.maxRestartsPerHour }
			})
		});
		return startGatewayConfigReloader({
			initialConfig: cfgAtStart,
			readSnapshot: readConfigFileSnapshot,
			onHotReload: async (plan, nextConfig) => {
				const previousSnapshot = getActiveSecretsRuntimeSnapshot();
				const prepared = await activateRuntimeSecrets(nextConfig, {
					reason: "reload",
					activate: true
				});
				try {
					await applyHotReload(plan, prepared.config);
				} catch (err) {
					if (previousSnapshot) activateSecretsRuntimeSnapshot(previousSnapshot);
					else clearSecretsRuntimeSnapshot();
					throw err;
				}
			},
			onRestart: async (plan, nextConfig) => {
				await activateRuntimeSecrets(nextConfig, {
					reason: "restart-check",
					activate: false
				});
				requestGatewayRestart(plan, nextConfig);
			},
			log: {
				info: (msg) => logReload.info(msg),
				warn: (msg) => logReload.warn(msg),
				error: (msg) => logReload.error(msg)
			},
			watchPath: configSnapshot.path
		});
	})();
	const close = createGatewayCloseHandler({
		bonjourStop,
		tailscaleCleanup,
		canvasHost,
		canvasHostServer,
		releasePluginRouteRegistry,
		stopChannel,
		pluginServices,
		cron,
		heartbeatRunner,
		updateCheckStop: stopGatewayUpdateCheck,
		nodePresenceTimers,
		broadcast,
		tickInterval,
		healthInterval,
		dedupeCleanup,
		mediaCleanup,
		agentUnsub,
		heartbeatUnsub,
		chatRunState,
		clients,
		configReloader,
		browserControl,
		wss,
		httpServer,
		httpServers
	});
	return { close: async (opts) => {
		await runGlobalGatewayStopSafely({
			event: { reason: opts?.reason ?? "gateway stopping" },
			ctx: { port },
			onError: (err) => log.warn(`gateway_stop hook failed: ${String(err)}`)
		});
		if (diagnosticsEnabled) stopDiagnosticHeartbeat();
		if (skillsRefreshTimer) {
			clearTimeout(skillsRefreshTimer);
			skillsRefreshTimer = null;
		}
		skillsChangeUnsub();
		authRateLimiter?.dispose();
		browserAuthRateLimiter.dispose();
		channelHealthMonitor?.stop();
		clearSecretsRuntimeSnapshot();
		await close(opts);
	} };
}
//#endregion
//#region src/cli/gateway-cli/dev.ts
init_runtime();
init_utils();
const DEV_IDENTITY_NAME = "C3-PO";
const DEV_IDENTITY_THEME = "protocol droid";
const DEV_IDENTITY_EMOJI = "🤖";
const DEV_AGENT_WORKSPACE_SUFFIX = "dev";
async function loadDevTemplate(name, fallback) {
	try {
		const templateDir = await resolveWorkspaceTemplateDir();
		const raw = await fs.promises.readFile(path.join(templateDir, name), "utf-8");
		if (!raw.startsWith("---")) return raw;
		const endIndex = raw.indexOf("\n---", 3);
		if (endIndex === -1) return raw;
		return raw.slice(endIndex + 4).replace(/^\s+/, "");
	} catch {
		return fallback;
	}
}
const resolveDevWorkspaceDir = (env = process.env) => {
	const baseDir = resolveDefaultAgentWorkspaceDir(env, os.homedir);
	if (env.OPENCLAW_PROFILE?.trim().toLowerCase() === "dev") return baseDir;
	return `${baseDir}-${DEV_AGENT_WORKSPACE_SUFFIX}`;
};
async function writeFileIfMissing(filePath, content) {
	try {
		await fs.promises.writeFile(filePath, content, {
			encoding: "utf-8",
			flag: "wx"
		});
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
	}
}
async function ensureDevWorkspace(dir) {
	const resolvedDir = resolveUserPath(dir);
	await fs.promises.mkdir(resolvedDir, { recursive: true });
	const [agents, soul, tools, identity, user] = await Promise.all([
		loadDevTemplate("AGENTS.dev.md", `# AGENTS.md - OpenClaw Dev Workspace\n\nDefault dev workspace for openclaw gateway --dev.\n`),
		loadDevTemplate("SOUL.dev.md", `# SOUL.md - Dev Persona\n\nProtocol droid for debugging and operations.\n`),
		loadDevTemplate("TOOLS.dev.md", `# TOOLS.md - User Tool Notes (editable)\n\nAdd your local tool notes here.\n`),
		loadDevTemplate("IDENTITY.dev.md", `# IDENTITY.md - Agent Identity\n\n- Name: ${DEV_IDENTITY_NAME}\n- Creature: protocol droid\n- Vibe: ${DEV_IDENTITY_THEME}\n- Emoji: ${DEV_IDENTITY_EMOJI}\n`),
		loadDevTemplate("USER.dev.md", `# USER.md - User Profile\n\n- Name:\n- Preferred address:\n- Notes:\n`)
	]);
	await writeFileIfMissing(path.join(resolvedDir, "AGENTS.md"), agents);
	await writeFileIfMissing(path.join(resolvedDir, "SOUL.md"), soul);
	await writeFileIfMissing(path.join(resolvedDir, "TOOLS.md"), tools);
	await writeFileIfMissing(path.join(resolvedDir, "IDENTITY.md"), identity);
	await writeFileIfMissing(path.join(resolvedDir, "USER.md"), user);
}
async function ensureDevGatewayConfig(opts) {
	const workspace = resolveDevWorkspaceDir();
	if (opts.reset) await handleReset("full", workspace, defaultRuntime);
	const configPath = createConfigIO().configPath;
	const configExists = fs.existsSync(configPath);
	if (!opts.reset && configExists) return;
	await writeConfigFile({
		gateway: {
			mode: "local",
			bind: "loopback"
		},
		agents: {
			defaults: {
				workspace,
				skipBootstrap: true
			},
			list: [{
				id: "dev",
				default: true,
				workspace,
				identity: {
					name: DEV_IDENTITY_NAME,
					theme: DEV_IDENTITY_THEME,
					emoji: DEV_IDENTITY_EMOJI
				}
			}]
		}
	});
	await ensureDevWorkspace(workspace);
	defaultRuntime.log(`Dev config ready: ${shortenHomePath(configPath)}`);
	defaultRuntime.log(`Dev workspace ready: ${shortenHomePath(resolveUserPath(workspace))}`);
}
//#endregion
//#region src/infra/supervisor-markers.ts
const SUPERVISOR_HINTS = {
	launchd: [
		"LAUNCH_JOB_LABEL",
		"LAUNCH_JOB_NAME",
		"XPC_SERVICE_NAME",
		"OPENCLAW_LAUNCHD_LABEL"
	],
	systemd: [
		"OPENCLAW_SYSTEMD_UNIT",
		"INVOCATION_ID",
		"SYSTEMD_EXEC_PID",
		"JOURNAL_STREAM"
	],
	schtasks: ["OPENCLAW_WINDOWS_TASK_NAME"]
};
[
	...SUPERVISOR_HINTS.launchd,
	...SUPERVISOR_HINTS.systemd,
	...SUPERVISOR_HINTS.schtasks
];
function hasAnyHint(env, keys) {
	return keys.some((key) => {
		const value = env[key];
		return typeof value === "string" && value.trim().length > 0;
	});
}
function detectRespawnSupervisor(env = process.env, platform = process.platform) {
	if (platform === "darwin") return hasAnyHint(env, SUPERVISOR_HINTS.launchd) ? "launchd" : null;
	if (platform === "linux") return hasAnyHint(env, SUPERVISOR_HINTS.systemd) ? "systemd" : null;
	if (platform === "win32") {
		if (hasAnyHint(env, SUPERVISOR_HINTS.schtasks)) return "schtasks";
		const marker = env.OPENCLAW_SERVICE_MARKER?.trim();
		const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
		return marker && serviceKind === "gateway" ? "schtasks" : null;
	}
	return null;
}
//#endregion
//#region src/infra/process-respawn.ts
function isTruthy(value) {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
/**
* Attempt to restart this process with a fresh PID.
* - supervised environments (launchd/systemd/schtasks): caller should exit and let supervisor restart
* - OPENCLAW_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
* - otherwise: spawn detached child with current argv/execArgv, then caller exits
*/
function restartGatewayProcessWithFreshPid() {
	if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) return { mode: "disabled" };
	const supervisor = detectRespawnSupervisor(process.env);
	if (supervisor) {
		if (supervisor === "launchd") {
			const handoff = scheduleDetachedLaunchdRestartHandoff({
				env: process.env,
				mode: "start-after-exit",
				waitForPid: process.pid
			});
			if (!handoff.ok) return {
				mode: "supervised",
				detail: `launchd exit fallback (${handoff.detail ?? "restart handoff failed"})`
			};
			return {
				mode: "supervised",
				detail: `launchd restart handoff pid ${handoff.pid ?? "unknown"}`
			};
		}
		if (supervisor === "schtasks") {
			const restart = triggerOpenClawRestart();
			if (!restart.ok) return {
				mode: "failed",
				detail: restart.detail ?? `${restart.method} restart failed`
			};
		}
		return { mode: "supervised" };
	}
	if (process.platform === "win32") return {
		mode: "disabled",
		detail: "win32: detached respawn unsupported without Scheduled Task markers"
	};
	try {
		const args = [...process.execArgv, ...process.argv.slice(1)];
		const child = spawn(process.execPath, args, {
			env: process.env,
			detached: true,
			stdio: "inherit"
		});
		child.unref();
		return {
			mode: "spawned",
			pid: child.pid ?? void 0
		};
	} catch (err) {
		return {
			mode: "failed",
			detail: err instanceof Error ? err.message : String(err)
		};
	}
}
//#endregion
//#region src/process/restart-recovery.ts
/**
* Returns an iteration hook for in-process restart loops.
* The first call is considered initial startup and does nothing.
* Each subsequent call represents a restart iteration and invokes `onRestart`.
*/
function createRestartIterationHook(onRestart) {
	let isFirstIteration = true;
	return () => {
		if (isFirstIteration) {
			isFirstIteration = false;
			return false;
		}
		onRestart();
		return true;
	};
}
//#endregion
//#region src/cli/gateway-cli/run-loop.ts
init_subsystem();
const gatewayLog$1 = createSubsystemLogger("gateway");
async function runGatewayLoop(params) {
	let lock = await acquireGatewayLock({ port: params.lockPort });
	let server = null;
	let shuttingDown = false;
	let restartResolver = null;
	const cleanupSignals = () => {
		process.removeListener("SIGTERM", onSigterm);
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGUSR1", onSigusr1);
	};
	const exitProcess = (code) => {
		cleanupSignals();
		params.runtime.exit(code);
	};
	const releaseLockIfHeld = async () => {
		if (!lock) return false;
		await lock.release();
		lock = null;
		return true;
	};
	const reacquireLockForInProcessRestart = async () => {
		try {
			lock = await acquireGatewayLock({ port: params.lockPort });
			return true;
		} catch (err) {
			gatewayLog$1.error(`failed to reacquire gateway lock for in-process restart: ${String(err)}`);
			exitProcess(1);
			return false;
		}
	};
	const handleRestartAfterServerClose = async () => {
		const hadLock = await releaseLockIfHeld();
		const respawn = restartGatewayProcessWithFreshPid();
		if (respawn.mode === "spawned" || respawn.mode === "supervised") {
			const modeLabel = respawn.mode === "spawned" ? `spawned pid ${respawn.pid ?? "unknown"}` : "supervisor restart";
			gatewayLog$1.info(`restart mode: full process restart (${modeLabel})`);
			exitProcess(0);
			return;
		}
		if (respawn.mode === "failed") gatewayLog$1.warn(`full process restart failed (${respawn.detail ?? "unknown error"}); falling back to in-process restart`);
		else gatewayLog$1.info(`restart mode: in-process restart (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`);
		if (hadLock && !await reacquireLockForInProcessRestart()) return;
		shuttingDown = false;
		restartResolver?.();
	};
	const handleStopAfterServerClose = async () => {
		await releaseLockIfHeld();
		exitProcess(0);
	};
	const DRAIN_TIMEOUT_MS = 9e4;
	const SHUTDOWN_TIMEOUT_MS = 5e3;
	const request = (action, signal) => {
		if (shuttingDown) {
			gatewayLog$1.info(`received ${signal} during shutdown; ignoring`);
			return;
		}
		shuttingDown = true;
		const isRestart = action === "restart";
		gatewayLog$1.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);
		const forceExitMs = isRestart ? DRAIN_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS : SHUTDOWN_TIMEOUT_MS;
		const forceExitTimer = setTimeout(() => {
			gatewayLog$1.error("shutdown timed out; exiting without full cleanup");
			exitProcess(isRestart ? 1 : 0);
		}, forceExitMs);
		(async () => {
			try {
				if (isRestart) {
					markGatewayDraining();
					const activeTasks = getActiveTaskCount();
					const activeRuns = getActiveEmbeddedRunCount();
					if (activeRuns > 0) abortEmbeddedPiRun(void 0, { mode: "compacting" });
					if (activeTasks > 0 || activeRuns > 0) {
						gatewayLog$1.info(`draining ${activeTasks} active task(s) and ${activeRuns} active embedded run(s) before restart (timeout ${DRAIN_TIMEOUT_MS}ms)`);
						const [tasksDrain, runsDrain] = await Promise.all([activeTasks > 0 ? waitForActiveTasks(DRAIN_TIMEOUT_MS) : Promise.resolve({ drained: true }), activeRuns > 0 ? waitForActiveEmbeddedRuns(DRAIN_TIMEOUT_MS) : Promise.resolve({ drained: true })]);
						if (tasksDrain.drained && runsDrain.drained) gatewayLog$1.info("all active work drained");
						else {
							gatewayLog$1.warn("drain timeout reached; proceeding with restart");
							abortEmbeddedPiRun(void 0, { mode: "all" });
						}
					}
				}
				await server?.close({
					reason: isRestart ? "gateway restarting" : "gateway stopping",
					restartExpectedMs: isRestart ? 1500 : null
				});
			} catch (err) {
				gatewayLog$1.error(`shutdown error: ${String(err)}`);
			} finally {
				clearTimeout(forceExitTimer);
				server = null;
				if (isRestart) await handleRestartAfterServerClose();
				else await handleStopAfterServerClose();
			}
		})();
	};
	const onSigterm = () => {
		gatewayLog$1.info("signal SIGTERM received");
		request("stop", "SIGTERM");
	};
	const onSigint = () => {
		gatewayLog$1.info("signal SIGINT received");
		request("stop", "SIGINT");
	};
	const onSigusr1 = () => {
		gatewayLog$1.info("signal SIGUSR1 received");
		if (!consumeGatewaySigusr1RestartAuthorization()) {
			if (!isGatewaySigusr1RestartExternallyAllowed()) {
				gatewayLog$1.warn("SIGUSR1 restart ignored (not authorized; commands.restart=false or use gateway tool).");
				return;
			}
			if (shuttingDown) {
				gatewayLog$1.info("received SIGUSR1 during shutdown; ignoring");
				return;
			}
			scheduleGatewaySigusr1Restart({
				delayMs: 0,
				reason: "SIGUSR1"
			});
			return;
		}
		markGatewaySigusr1RestartHandled();
		request("restart", "SIGUSR1");
	};
	process.on("SIGTERM", onSigterm);
	process.on("SIGINT", onSigint);
	process.on("SIGUSR1", onSigusr1);
	try {
		const onIteration = createRestartIterationHook(() => {
			resetAllLanes();
		});
		let isFirstStart = true;
		while (true) {
			onIteration();
			try {
				server = await params.start();
				isFirstStart = false;
			} catch (err) {
				if (isFirstStart) throw err;
				server = null;
				await releaseLockIfHeld();
				const errMsg = err instanceof Error ? err.message : String(err);
				const errStack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
				gatewayLog$1.error(`gateway startup failed: ${errMsg}. Process will stay alive; fix the issue and restart.${errStack}`);
			}
			await new Promise((resolve) => {
				restartResolver = resolve;
			});
		}
	} finally {
		await releaseLockIfHeld();
		cleanupSignals();
	}
}
//#endregion
//#region src/cli/gateway-cli/run.ts
init_types_secrets();
init_globals();
init_subsystem();
init_runtime();
const gatewayLog = createSubsystemLogger("gateway");
const GATEWAY_RUN_VALUE_KEYS = [
	"port",
	"bind",
	"token",
	"auth",
	"password",
	"passwordFile",
	"tailscale",
	"wsLog",
	"rawStreamPath"
];
const GATEWAY_RUN_BOOLEAN_KEYS = [
	"tailscaleResetOnExit",
	"allowUnconfigured",
	"dev",
	"reset",
	"force",
	"verbose",
	"claudeCliLogs",
	"compact",
	"rawStream"
];
const GATEWAY_AUTH_MODES = [
	"none",
	"token",
	"password",
	"trusted-proxy"
];
const GATEWAY_TAILSCALE_MODES = [
	"off",
	"serve",
	"funnel"
];
function warnInlinePasswordFlag() {
	defaultRuntime.error("Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.");
}
function resolveGatewayPasswordOption(opts) {
	const direct = toOptionString(opts.password);
	const file = toOptionString(opts.passwordFile);
	if (direct && file) throw new Error("Use either --password or --password-file.");
	if (file) return readSecretFromFile(file, "Gateway password");
	return direct;
}
function parseEnumOption(raw, allowed) {
	if (!raw) return null;
	return allowed.includes(raw) ? raw : null;
}
function formatModeChoices(modes) {
	return modes.map((mode) => `"${mode}"`).join("|");
}
function formatModeErrorList(modes) {
	const quoted = modes.map((mode) => `"${mode}"`);
	if (quoted.length === 0) return "";
	if (quoted.length === 1) return quoted[0];
	if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
	return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}
function resolveGatewayRunOptions(opts, command) {
	const resolved = { ...opts };
	for (const key of GATEWAY_RUN_VALUE_KEYS) {
		const inherited = inheritOptionFromParent(command, key);
		if (key === "wsLog") {
			resolved[key] = inherited ?? resolved[key];
			continue;
		}
		resolved[key] = resolved[key] ?? inherited;
	}
	for (const key of GATEWAY_RUN_BOOLEAN_KEYS) {
		const inherited = inheritOptionFromParent(command, key);
		resolved[key] = Boolean(resolved[key] || inherited);
	}
	return resolved;
}
async function runGatewayCommand$1(opts) {
	const isDevProfile = process.env.OPENCLAW_PROFILE?.trim().toLowerCase() === "dev";
	const devMode = Boolean(opts.dev) || isDevProfile;
	if (opts.reset && !devMode) {
		defaultRuntime.error("Use --reset with --dev.");
		defaultRuntime.exit(1);
		return;
	}
	setConsoleTimestampPrefix(true);
	setVerbose(Boolean(opts.verbose));
	if (opts.claudeCliLogs) {
		setConsoleSubsystemFilter(["agent/claude-cli"]);
		process.env.OPENCLAW_CLAUDE_CLI_LOG_OUTPUT = "1";
	}
	const wsLogRaw = opts.compact ? "compact" : opts.wsLog;
	const wsLogStyle = wsLogRaw === "compact" ? "compact" : wsLogRaw === "full" ? "full" : "auto";
	if (wsLogRaw !== void 0 && wsLogRaw !== "auto" && wsLogRaw !== "compact" && wsLogRaw !== "full") {
		defaultRuntime.error("Invalid --ws-log (use \"auto\", \"full\", \"compact\")");
		defaultRuntime.exit(1);
	}
	setGatewayWsLogStyle(wsLogStyle);
	if (opts.rawStream) process.env.OPENCLAW_RAW_STREAM = "1";
	const rawStreamPath = toOptionString(opts.rawStreamPath);
	if (rawStreamPath) process.env.OPENCLAW_RAW_STREAM_PATH = rawStreamPath;
	if (devMode) await ensureDevGatewayConfig({ reset: Boolean(opts.reset) });
	const cfg = loadConfig();
	const portOverride = parsePort(opts.port);
	if (opts.port !== void 0 && portOverride === null) {
		defaultRuntime.error("Invalid port");
		defaultRuntime.exit(1);
	}
	const port = portOverride ?? resolveGatewayPort(cfg);
	if (!Number.isFinite(port) || port <= 0) {
		defaultRuntime.error("Invalid port");
		defaultRuntime.exit(1);
	}
	const bindRaw = toOptionString(opts.bind) ?? cfg.gateway?.bind ?? "loopback";
	const bind = bindRaw === "loopback" || bindRaw === "lan" || bindRaw === "auto" || bindRaw === "custom" || bindRaw === "tailnet" ? bindRaw : null;
	if (!bind) {
		defaultRuntime.error("Invalid --bind (use \"loopback\", \"lan\", \"tailnet\", \"auto\", or \"custom\")");
		defaultRuntime.exit(1);
		return;
	}
	if (process.env.OPENCLAW_SERVICE_MARKER?.trim()) {
		const stale = cleanStaleGatewayProcessesSync(port);
		if (stale.length > 0) gatewayLog.info(`service-mode: cleared ${stale.length} stale gateway pid(s) before bind on port ${port}`);
	}
	if (opts.force) try {
		const { killed, waitedMs, escalatedToSigkill } = await forceFreePortAndWait(port, {
			timeoutMs: 2e3,
			intervalMs: 100,
			sigtermTimeoutMs: 700
		});
		if (killed.length === 0) gatewayLog.info(`force: no listeners on port ${port}`);
		else {
			for (const proc of killed) gatewayLog.info(`force: killed pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""} on port ${port}`);
			if (escalatedToSigkill) gatewayLog.info(`force: escalated to SIGKILL while freeing port ${port}`);
			if (waitedMs > 0) gatewayLog.info(`force: waited ${waitedMs}ms for port ${port} to free`);
		}
		const bindWaitMs = await waitForPortBindable(port, {
			timeoutMs: 3e3,
			intervalMs: 150,
			host: bind === "loopback" ? "127.0.0.1" : bind === "lan" ? "0.0.0.0" : bind === "custom" ? toOptionString(cfg.gateway?.customBindHost) : void 0
		});
		if (bindWaitMs > 0) gatewayLog.info(`force: waited ${bindWaitMs}ms for port ${port} to become bindable`);
	} catch (err) {
		defaultRuntime.error(`Force: ${String(err)}`);
		defaultRuntime.exit(1);
		return;
	}
	if (opts.token) {
		const token = toOptionString(opts.token);
		if (token) process.env.OPENCLAW_GATEWAY_TOKEN = token;
	}
	const authModeRaw = toOptionString(opts.auth);
	const authMode = parseEnumOption(authModeRaw, GATEWAY_AUTH_MODES);
	if (authModeRaw && !authMode) {
		defaultRuntime.error(`Invalid --auth (use ${formatModeErrorList(GATEWAY_AUTH_MODES)})`);
		defaultRuntime.exit(1);
		return;
	}
	const tailscaleRaw = toOptionString(opts.tailscale);
	const tailscaleMode = parseEnumOption(tailscaleRaw, GATEWAY_TAILSCALE_MODES);
	if (tailscaleRaw && !tailscaleMode) {
		defaultRuntime.error(`Invalid --tailscale (use ${formatModeErrorList(GATEWAY_TAILSCALE_MODES)})`);
		defaultRuntime.exit(1);
		return;
	}
	let passwordRaw;
	try {
		passwordRaw = resolveGatewayPasswordOption(opts);
	} catch (err) {
		defaultRuntime.error(err instanceof Error ? err.message : String(err));
		defaultRuntime.exit(1);
		return;
	}
	if (toOptionString(opts.password)) warnInlinePasswordFlag();
	const tokenRaw = toOptionString(opts.token);
	const snapshot = await readConfigFileSnapshot().catch(() => null);
	const configExists = snapshot?.exists ?? fs.existsSync(CONFIG_PATH);
	const configAuditPath = path.join(resolveStateDir(process.env), "logs", "config-audit.jsonl");
	const mode = cfg.gateway?.mode;
	if (!opts.allowUnconfigured && mode !== "local") {
		if (!configExists) defaultRuntime.error(`Missing config. Run \`${formatCliCommand("openclaw setup")}\` or set gateway.mode=local (or pass --allow-unconfigured).`);
		else {
			defaultRuntime.error(`Gateway start blocked: set gateway.mode=local (current: ${mode ?? "unset"}) or pass --allow-unconfigured.`);
			defaultRuntime.error(`Config write audit: ${configAuditPath}`);
		}
		defaultRuntime.exit(1);
		return;
	}
	const miskeys = extractGatewayMiskeys(snapshot?.parsed);
	const authOverride = authMode || passwordRaw || tokenRaw || authModeRaw ? {
		...authMode ? { mode: authMode } : {},
		...tokenRaw ? { token: tokenRaw } : {},
		...passwordRaw ? { password: passwordRaw } : {}
	} : void 0;
	const resolvedAuth = resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		authOverride,
		env: process.env,
		tailscaleMode: tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off"
	});
	const resolvedAuthMode = resolvedAuth.mode;
	const tokenValue = resolvedAuth.token;
	const passwordValue = resolvedAuth.password;
	const hasToken = typeof tokenValue === "string" && tokenValue.trim().length > 0;
	const hasPassword = typeof passwordValue === "string" && passwordValue.trim().length > 0;
	const tokenConfigured = hasToken || hasConfiguredSecretInput(authOverride?.token ?? cfg.gateway?.auth?.token, cfg.secrets?.defaults);
	const passwordConfigured = hasPassword || hasConfiguredSecretInput(authOverride?.password ?? cfg.gateway?.auth?.password, cfg.secrets?.defaults);
	const hasSharedSecret = resolvedAuthMode === "token" && tokenConfigured || resolvedAuthMode === "password" && passwordConfigured;
	const canBootstrapToken = resolvedAuthMode === "token" && !tokenConfigured;
	const authHints = [];
	if (miskeys.hasGatewayToken) authHints.push("Found \"gateway.token\" in config. Use \"gateway.auth.token\" instead.");
	if (miskeys.hasRemoteToken) authHints.push("\"gateway.remote.token\" is for remote CLI calls; it does not enable local gateway auth.");
	if (resolvedAuthMode === "password" && !passwordConfigured) {
		defaultRuntime.error([
			"Gateway auth is set to password, but no password is configured.",
			"Set gateway.auth.password (or OPENCLAW_GATEWAY_PASSWORD), or pass --password.",
			...authHints
		].filter(Boolean).join("\n"));
		defaultRuntime.exit(1);
		return;
	}
	if (resolvedAuthMode === "none") gatewayLog.warn("Gateway auth mode=none explicitly configured; all gateway connections are unauthenticated.");
	if (bind !== "loopback" && !hasSharedSecret && !canBootstrapToken && resolvedAuthMode !== "trusted-proxy") {
		defaultRuntime.error([
			`Refusing to bind gateway to ${bind} without auth.`,
			"Set gateway.auth.token/password (or OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD) or pass --token/--password.",
			...authHints
		].filter(Boolean).join("\n"));
		defaultRuntime.exit(1);
		return;
	}
	const tailscaleOverride = tailscaleMode || opts.tailscaleResetOnExit ? {
		...tailscaleMode ? { mode: tailscaleMode } : {},
		...opts.tailscaleResetOnExit ? { resetOnExit: true } : {}
	} : void 0;
	try {
		await runGatewayLoop({
			runtime: defaultRuntime,
			lockPort: port,
			start: async () => await startGatewayServer(port, {
				bind,
				auth: authOverride,
				tailscale: tailscaleOverride
			})
		});
	} catch (err) {
		if (err instanceof GatewayLockError || err && typeof err === "object" && err.name === "GatewayLockError") {
			const errMessage = describeUnknownError(err);
			defaultRuntime.error(`Gateway failed to start: ${errMessage}\nIf the gateway is supervised, stop it with: ${formatCliCommand("openclaw gateway stop")}`);
			try {
				const diagnostics = await inspectPortUsage(port);
				if (diagnostics.status === "busy") for (const line of formatPortDiagnostics(diagnostics)) defaultRuntime.error(line);
			} catch {}
			await maybeExplainGatewayServiceStop();
			defaultRuntime.exit(1);
			return;
		}
		defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
		defaultRuntime.exit(1);
	}
}
function addGatewayRunCommand(cmd) {
	return cmd.option("--port <port>", "Port for the gateway WebSocket").option("--bind <mode>", "Bind mode (\"loopback\"|\"lan\"|\"tailnet\"|\"auto\"|\"custom\"). Defaults to config gateway.bind (or loopback).").option("--token <token>", "Shared token required in connect.params.auth.token (default: OPENCLAW_GATEWAY_TOKEN env if set)").option("--auth <mode>", `Gateway auth mode (${formatModeChoices(GATEWAY_AUTH_MODES)})`).option("--password <password>", "Password for auth mode=password").option("--password-file <path>", "Read gateway password from file").option("--tailscale <mode>", `Tailscale exposure mode (${formatModeChoices(GATEWAY_TAILSCALE_MODES)})`).option("--tailscale-reset-on-exit", "Reset Tailscale serve/funnel configuration on shutdown", false).option("--allow-unconfigured", "Allow gateway start without gateway.mode=local in config", false).option("--dev", "Create a dev config + workspace if missing (no BOOTSTRAP.md)", false).option("--reset", "Reset dev config + credentials + sessions + workspace (requires --dev)", false).option("--force", "Kill any existing listener on the target port before starting", false).option("--verbose", "Verbose logging to stdout/stderr", false).option("--claude-cli-logs", "Only show claude-cli logs in the console (includes stdout/stderr)", false).option("--ws-log <style>", "WebSocket log style (\"auto\"|\"full\"|\"compact\")", "auto").option("--compact", "Alias for \"--ws-log compact\"", false).option("--raw-stream", "Log raw model stream events to jsonl", false).option("--raw-stream-path <path>", "Raw stream jsonl path").action(async (opts, command) => {
		await runGatewayCommand$1(resolveGatewayRunOptions(opts, command));
	});
}
//#endregion
//#region src/cli/gateway-cli/register.ts
init_runtime();
init_theme();
function runGatewayCommand(action, label) {
	return runCommandWithRuntime(defaultRuntime, action, (err) => {
		const message = String(err);
		defaultRuntime.error(label ? `${label}: ${message}` : message);
		defaultRuntime.exit(1);
	});
}
function parseDaysOption(raw, fallback = 30) {
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(1, Math.floor(raw));
	if (typeof raw === "string" && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed)) return Math.max(1, Math.floor(parsed));
	}
	return fallback;
}
function resolveGatewayRpcOptions(opts, command) {
	const parentToken = inheritOptionFromParent(command, "token");
	const parentPassword = inheritOptionFromParent(command, "password");
	return {
		...opts,
		token: opts.token ?? parentToken,
		password: opts.password ?? parentPassword
	};
}
function renderCostUsageSummary(summary, days, rich) {
	const totalCost = formatUsd(summary.totals.totalCost) ?? "$0.00";
	const totalTokens = formatTokenCount(summary.totals.totalTokens) ?? "0";
	const lines = [colorize(rich, theme.heading, `Usage cost (${days} days)`), `${colorize(rich, theme.muted, "Total:")} ${totalCost} · ${totalTokens} tokens`];
	if (summary.totals.missingCostEntries > 0) lines.push(`${colorize(rich, theme.muted, "Missing entries:")} ${summary.totals.missingCostEntries}`);
	const latest = summary.daily.at(-1);
	if (latest) {
		const latestCost = formatUsd(latest.totalCost) ?? "$0.00";
		const latestTokens = formatTokenCount(latest.totalTokens) ?? "0";
		lines.push(`${colorize(rich, theme.muted, "Latest day:")} ${latest.date} · ${latestCost} · ${latestTokens} tokens`);
	}
	return lines;
}
function registerGatewayCli(program) {
	const gateway = addGatewayRunCommand(program.command("gateway").description("Run, inspect, and query the WebSocket Gateway").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw gateway run", "Run the gateway in the foreground."],
		["openclaw gateway status", "Show service status and probe reachability."],
		["openclaw gateway discover", "Find local and wide-area gateway beacons."],
		["openclaw gateway call health", "Call a gateway RPC method directly."]
	])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`));
	addGatewayRunCommand(gateway.command("run").description("Run the WebSocket Gateway (foreground)"));
	addGatewayServiceCommands(gateway, { statusDescription: "Show gateway service status + probe the Gateway" });
	gatewayCallOpts(gateway.command("call").description("Call a Gateway method").argument("<method>", "Method name (health/status/system-presence/cron.*)").option("--params <json>", "JSON object string for params", "{}").action(async (method, opts, command) => {
		await runGatewayCommand(async () => {
			const rpcOpts = resolveGatewayRpcOptions(opts, command);
			const config = await readBestEffortConfig();
			const params = JSON.parse(String(opts.params ?? "{}"));
			const result = await callGatewayCli(method, {
				...rpcOpts,
				config
			}, params);
			if (rpcOpts.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			const rich = isRich();
			defaultRuntime.log(`${colorize(rich, theme.heading, "Gateway call")}: ${colorize(rich, theme.muted, String(method))}`);
			defaultRuntime.log(JSON.stringify(result, null, 2));
		}, "Gateway call failed");
	}));
	gatewayCallOpts(gateway.command("usage-cost").description("Fetch usage cost summary from session logs").option("--days <days>", "Number of days to include", "30").action(async (opts, command) => {
		await runGatewayCommand(async () => {
			const rpcOpts = resolveGatewayRpcOptions(opts, command);
			const days = parseDaysOption(opts.days);
			const config = await readBestEffortConfig();
			const result = await callGatewayCli("usage.cost", {
				...rpcOpts,
				config
			}, { days });
			if (rpcOpts.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			const rich = isRich();
			const summary = result;
			for (const line of renderCostUsageSummary(summary, days, rich)) defaultRuntime.log(line);
		}, "Gateway usage cost failed");
	}));
	gatewayCallOpts(gateway.command("health").description("Fetch Gateway health").action(async (opts, command) => {
		await runGatewayCommand(async () => {
			const rpcOpts = resolveGatewayRpcOptions(opts, command);
			const config = await readBestEffortConfig();
			const result = await callGatewayCli("health", {
				...rpcOpts,
				config
			});
			if (rpcOpts.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			const rich = isRich();
			const obj = result && typeof result === "object" ? result : {};
			const durationMs = typeof obj.durationMs === "number" ? obj.durationMs : null;
			defaultRuntime.log(colorize(rich, theme.heading, "Gateway Health"));
			defaultRuntime.log(`${colorize(rich, theme.success, "OK")}${durationMs != null ? ` (${durationMs}ms)` : ""}`);
			if (obj.channels && typeof obj.channels === "object") for (const line of formatHealthChannelLines(obj)) defaultRuntime.log(styleHealthChannelLine(line, rich));
		});
	}));
	gateway.command("probe").description("Show gateway reachability + discovery + health + status summary (local + remote)").option("--url <url>", "Explicit Gateway WebSocket URL (still probes localhost)").option("--ssh <target>", "SSH target for remote gateway tunnel (user@host or user@host:port)").option("--ssh-identity <path>", "SSH identity file path").option("--ssh-auto", "Try to derive an SSH target from Bonjour discovery", false).option("--token <token>", "Gateway token (applies to all probes)").option("--password <password>", "Gateway password (applies to all probes)").option("--timeout <ms>", "Overall probe budget in ms", "3000").option("--json", "Output JSON", false).action(async (opts, command) => {
		await runGatewayCommand(async () => {
			await gatewayStatusCommand(resolveGatewayRpcOptions(opts, command), defaultRuntime);
		});
	});
	gateway.command("discover").description("Discover gateways via Bonjour (local + wide-area if configured)").option("--timeout <ms>", "Per-command timeout in ms", "2000").option("--json", "Output JSON", false).action(async (opts) => {
		await runGatewayCommand(async () => {
			const wideAreaDomain = resolveWideAreaDiscoveryDomain({ configDomain: (await readBestEffortConfig()).discovery?.wideArea?.domain });
			const timeoutMs = parseDiscoverTimeoutMs(opts.timeout, 2e3);
			const domains = ["local.", ...wideAreaDomain ? [wideAreaDomain] : []];
			const deduped = dedupeBeacons(await withProgress({
				label: "Scanning for gateways…",
				indeterminate: true,
				enabled: opts.json !== true,
				delayMs: 0
			}, async () => await discoverGatewayBeacons({
				timeoutMs,
				wideAreaDomain
			}))).toSorted((a, b) => String(a.displayName || a.instanceName).localeCompare(String(b.displayName || b.instanceName)));
			if (opts.json) {
				const enriched = deduped.map((b) => {
					const host = pickBeaconHost(b);
					const port = pickGatewayPort(b);
					return {
						...b,
						wsUrl: host ? `ws://${host}:${port}` : null
					};
				});
				defaultRuntime.log(JSON.stringify({
					timeoutMs,
					domains,
					count: enriched.length,
					beacons: enriched
				}, null, 2));
				return;
			}
			const rich = isRich();
			defaultRuntime.log(colorize(rich, theme.heading, "Gateway Discovery"));
			defaultRuntime.log(colorize(rich, theme.muted, `Found ${deduped.length} gateway(s) · domains: ${domains.join(", ")}`));
			if (deduped.length === 0) return;
			for (const beacon of deduped) for (const line of renderBeaconLines(beacon, rich)) defaultRuntime.log(line);
		}, "gateway discover failed");
	});
}
//#endregion
export { registerGatewayCli };
