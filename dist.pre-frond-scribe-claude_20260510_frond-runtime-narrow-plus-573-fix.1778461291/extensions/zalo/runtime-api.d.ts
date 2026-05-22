import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { S as normalizeSecretInputString, l as SecretInput, v as hasConfiguredSecretInput, x as normalizeResolvedSecretInputString } from "../../types.secrets-dfIfyLgO.js";
import { S as MarkdownTableMode, _ as GroupPolicy } from "../../types.base-CN1BlTRP.js";
import { C as readStringParam, h as jsonResult } from "../../common-B0aZxYiS.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Ds9BBXA3.js";
import { n as RuntimeEnv } from "../../runtime-lEKWbTQa.js";
import { i as WizardPrompter } from "../../prompts-Bbfv2jGT.js";
import { F as ChannelStatusIssue, n as BaseTokenResolution, r as ChannelAccountSnapshot, t as BaseProbeResult, y as ChannelMessageActionAdapter } from "../../types.core-CQScvK0N.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DxNjvRBt.js";
import { n as ChannelPlugin, t as ChannelMessageActionName } from "../../types.public-BMrZTIWg.js";
import { n as PluginRuntime } from "../../types-DVhGJHIy.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-BPInIQpI.js";
import { r as createDedupeCache } from "../../dedupe-s3MqgVdx.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DyWSTJ5E.js";
import { n as applySetupAccountConfigPatch, s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-ukpCWXr-.js";
import { n as formatPairingApproveHint } from "../../helpers-Dha4-Jey.js";
import { i as resolveClientIp } from "../../net-CT49oHyF.js";
import { r as waitForAbortSignal } from "../../unhandled-rejections-BT8gg1zw.js";
import { n as registerPluginHttpRoute } from "../../http-registry-B0pBrN3T.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-STYjuANm.js";
import { a as applyBasicWebhookRequestGuards, h as WEBHOOK_RATE_LIMIT_DEFAULTS, l as readJsonWebhookBodyOrReject, p as WEBHOOK_ANOMALY_COUNTER_DEFAULTS, v as createFixedWindowRateLimiter, y as createWebhookAnomalyTracker } from "../../webhook-request-guards-CmSPTWXD.js";
import { a as registerWebhookTarget, d as resolveWebhookTargetWithAuthOrRejectSync, n as RegisterWebhookTargetOptions, o as registerWebhookTargetWithPluginRoute, p as withResolvedWebhookRequestPipeline, t as RegisterWebhookPluginRouteOptions } from "../../webhook-targets-FhJBmufJ.js";
import { n as resolveWebhookPath } from "../../webhook-path-ilUGnvtv.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CVVv_KUh.js";
import { o as buildTokenChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-BunjMIEf.js";
import { r as buildSecretInputSchema } from "../../secret-input-oxz7VeMC.js";
import { a as SenderGroupAccessDecision, l as evaluateSenderGroupAccess } from "../../group-access-DK5RmZHa.js";
import { a as isNormalizedSenderAllowed, n as formatAllowFromLowercase } from "../../allow-from-B_I_2bpd.js";
import { i as logTypingFailure } from "../../logging-Crq85TwR.js";
import { l as resolveSenderCommandAuthorizationWithRuntime, s as resolveDirectDmAuthorizationOutcome } from "../../command-auth-DwsZutp0.js";
import { r as createChannelPairingController } from "../../channel-pairing-B8mQlhPz.js";
import { t as chunkTextForOutbound } from "../../text-chunking-BkFkH-DO.js";
import { O as mergeAllowFromEntries, W as promptSingleChannelSecretInput, Y as runSingleChannelSecretStep, at as setTopLevelChannelDmPolicyWithAllowFrom, d as addWildcardAllowFrom, f as buildSingleChannelSecretPromptState } from "../../setup-wizard-binary-DbbJ3twS.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "../../inbound-envelope-DiWrzF-q.js";

//#region extensions/zalo/src/runtime.d.ts
declare const setZaloRuntime: (next: PluginRuntime) => void, getZaloRuntime: () => PluginRuntime;
//#endregion
export { type BaseProbeResult, type BaseTokenResolution, type ChannelAccountSnapshot, type ChannelMessageActionAdapter, type ChannelMessageActionName, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupPolicy, type MarkdownTableMode, type OpenClawConfig, type OutboundReplyPayload, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type RegisterWebhookPluginRouteOptions, type RegisterWebhookTargetOptions, type ReplyPayload, type RuntimeEnv, type SecretInput, type SenderGroupAccessDecision, WEBHOOK_ANOMALY_COUNTER_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS, type WizardPrompter, addWildcardAllowFrom, applyAccountNameToChannelSection, applyBasicWebhookRequestGuards, applySetupAccountConfigPatch, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, buildSecretInputSchema, buildSingleChannelSecretPromptState, buildTokenChannelStatusSummary, chunkTextForOutbound, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createDedupeCache, createFixedWindowRateLimiter, createWebhookAnomalyTracker, deliverTextOrMediaReply, evaluateSenderGroupAccess, formatAllowFromLowercase, formatPairingApproveHint, hasConfiguredSecretInput, isNormalizedSenderAllowed, isNumericTargetId, jsonResult, logTypingFailure, mergeAllowFromEntries, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeResolvedSecretInputString, normalizeSecretInputString, promptSingleChannelSecretInput, readJsonWebhookBodyOrReject, readStringParam, registerPluginHttpRoute, registerWebhookTarget, registerWebhookTargetWithPluginRoute, resolveClientIp, resolveDefaultGroupPolicy, resolveDirectDmAuthorizationOutcome, resolveInboundRouteEnvelopeBuilderWithRuntime, resolveOpenProviderRuntimeGroupPolicy, resolveSenderCommandAuthorizationWithRuntime, resolveWebhookPath, resolveWebhookTargetWithAuthOrRejectSync, runSingleChannelSecretStep, sendPayloadWithChunkedTextAndMedia, setTopLevelChannelDmPolicyWithAllowFrom, setZaloRuntime, waitForAbortSignal, warnMissingProviderGroupPolicyFallbackOnce, withResolvedWebhookRequestPipeline };