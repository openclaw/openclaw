import { i as OpenClawConfig } from "../../types.openclaw-Bpxi7OSY.js";
import { S as normalizeSecretInputString, l as SecretInput, v as hasConfiguredSecretInput, x as normalizeResolvedSecretInputString } from "../../types.secrets-CysBXmFu.js";
import { S as MarkdownTableMode, _ as GroupPolicy } from "../../types.base-B1xU9TH3.js";
import { C as readStringParam, h as jsonResult } from "../../common-BHDf_7WT.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CocONTDn.js";
import { n as RuntimeEnv } from "../../runtime-BGU8SNjK.js";
import { i as WizardPrompter } from "../../prompts-YWa-tusP.js";
import { F as ChannelStatusIssue, n as BaseTokenResolution, r as ChannelAccountSnapshot, t as BaseProbeResult, y as ChannelMessageActionAdapter } from "../../types.core-1gJzFdXJ.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-FWjCVbzM.js";
import { n as ChannelPlugin, t as ChannelMessageActionName } from "../../types.public-oY5Zsold.js";
import { n as PluginRuntime } from "../../types-Dsa-0Faj.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-CjNZ1gpq.js";
import { r as createDedupeCache } from "../../dedupe-CqDSG9Rn.js";
import { r as buildChannelConfigSchema } from "../../config-schema-Cu4qnl0J.js";
import { n as applySetupAccountConfigPatch, s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DKGLffWD.js";
import { n as formatPairingApproveHint } from "../../helpers-fkMMKEjW.js";
import { i as resolveClientIp } from "../../net-B_HbCZS3.js";
import { r as waitForAbortSignal } from "../../unhandled-rejections-C083QB_E.js";
import { n as registerPluginHttpRoute } from "../../http-registry-OhZBfDoA.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CtQ47EKo.js";
import { a as applyBasicWebhookRequestGuards, h as WEBHOOK_RATE_LIMIT_DEFAULTS, l as readJsonWebhookBodyOrReject, p as WEBHOOK_ANOMALY_COUNTER_DEFAULTS, v as createFixedWindowRateLimiter, y as createWebhookAnomalyTracker } from "../../webhook-request-guards-DylImiro.js";
import { a as registerWebhookTarget, d as resolveWebhookTargetWithAuthOrRejectSync, n as RegisterWebhookTargetOptions, o as registerWebhookTargetWithPluginRoute, p as withResolvedWebhookRequestPipeline, t as RegisterWebhookPluginRouteOptions } from "../../webhook-targets-B-RCeMAw.js";
import { n as resolveWebhookPath } from "../../webhook-path-D2qAZ3ta.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BCnDfHsA.js";
import { o as buildTokenChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-B_3UIY7e.js";
import { r as buildSecretInputSchema } from "../../secret-input-BPfTK0-T.js";
import { a as isNormalizedSenderAllowed, n as formatAllowFromLowercase } from "../../allow-from-ZFkDGyah.js";
import { i as logTypingFailure } from "../../logging-DwGhH3aZ.js";
import { r as createChannelPairingController } from "../../channel-pairing-fIlJcWsI.js";
import { t as chunkTextForOutbound } from "../../text-chunking-D_wnKW5L.js";
import { O as mergeAllowFromEntries, W as promptSingleChannelSecretInput, Y as runSingleChannelSecretStep, at as setTopLevelChannelDmPolicyWithAllowFrom, d as addWildcardAllowFrom, f as buildSingleChannelSecretPromptState } from "../../setup-wizard-binary-BT6M6x_O.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "../../inbound-envelope-B_8mQ2X2.js";

//#region extensions/zalo/src/runtime.d.ts
declare const setZaloRuntime: (next: PluginRuntime) => void, getZaloRuntime: () => PluginRuntime;
//#endregion
export { type BaseProbeResult, type BaseTokenResolution, type ChannelAccountSnapshot, type ChannelMessageActionAdapter, type ChannelMessageActionName, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupPolicy, type MarkdownTableMode, type OpenClawConfig, type OutboundReplyPayload, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type RegisterWebhookPluginRouteOptions, type RegisterWebhookTargetOptions, type ReplyPayload, type RuntimeEnv, type SecretInput, WEBHOOK_ANOMALY_COUNTER_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS, type WizardPrompter, addWildcardAllowFrom, applyAccountNameToChannelSection, applyBasicWebhookRequestGuards, applySetupAccountConfigPatch, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, buildSecretInputSchema, buildSingleChannelSecretPromptState, buildTokenChannelStatusSummary, chunkTextForOutbound, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createDedupeCache, createFixedWindowRateLimiter, createWebhookAnomalyTracker, deliverTextOrMediaReply, formatAllowFromLowercase, formatPairingApproveHint, hasConfiguredSecretInput, isNormalizedSenderAllowed, isNumericTargetId, jsonResult, logTypingFailure, mergeAllowFromEntries, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeResolvedSecretInputString, normalizeSecretInputString, promptSingleChannelSecretInput, readJsonWebhookBodyOrReject, readStringParam, registerPluginHttpRoute, registerWebhookTarget, registerWebhookTargetWithPluginRoute, resolveClientIp, resolveDefaultGroupPolicy, resolveInboundRouteEnvelopeBuilderWithRuntime, resolveOpenProviderRuntimeGroupPolicy, resolveWebhookPath, resolveWebhookTargetWithAuthOrRejectSync, runSingleChannelSecretStep, sendPayloadWithChunkedTextAndMedia, setTopLevelChannelDmPolicyWithAllowFrom, setZaloRuntime, waitForAbortSignal, warnMissingProviderGroupPolicyFallbackOnce, withResolvedWebhookRequestPipeline };