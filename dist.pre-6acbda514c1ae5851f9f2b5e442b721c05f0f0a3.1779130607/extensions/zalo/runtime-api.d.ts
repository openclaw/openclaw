import { i as OpenClawConfig } from "../../types.openclaw-BYfkTL_f.js";
import { S as normalizeSecretInputString, l as SecretInput, v as hasConfiguredSecretInput, x as normalizeResolvedSecretInputString } from "../../types.secrets-B8pKm5jY.js";
import { S as MarkdownTableMode, _ as GroupPolicy } from "../../types.base-0oN-mnFt.js";
import { C as readStringParam, h as jsonResult } from "../../common-CCrWEB5U.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Ds9BBXA3.js";
import { n as RuntimeEnv } from "../../runtime-BGFXd35m.js";
import { i as WizardPrompter } from "../../prompts-W8K_XJ_v.js";
import { F as ChannelStatusIssue, n as BaseTokenResolution, r as ChannelAccountSnapshot, t as BaseProbeResult, y as ChannelMessageActionAdapter } from "../../types.core-DMG-czl3.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DpKGqclz.js";
import { n as ChannelPlugin, t as ChannelMessageActionName } from "../../types.public-CwqPONY3.js";
import { n as PluginRuntime } from "../../types-PzLD5nJ3.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-DfNGR-8N.js";
import { r as createDedupeCache } from "../../dedupe-DsSKRf_Q.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DrNcI0sQ.js";
import { n as applySetupAccountConfigPatch, s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-CmWj157a.js";
import { n as formatPairingApproveHint } from "../../helpers-C08KhCf8.js";
import { i as resolveClientIp } from "../../net-BG23ML9B.js";
import { r as waitForAbortSignal } from "../../unhandled-rejections-B6hqV815.js";
import { n as registerPluginHttpRoute } from "../../http-registry-CTUmXA39.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CTAOWeji.js";
import { a as applyBasicWebhookRequestGuards, h as WEBHOOK_RATE_LIMIT_DEFAULTS, l as readJsonWebhookBodyOrReject, p as WEBHOOK_ANOMALY_COUNTER_DEFAULTS, v as createFixedWindowRateLimiter, y as createWebhookAnomalyTracker } from "../../webhook-request-guards-CXHV0tFO.js";
import { a as registerWebhookTarget, d as resolveWebhookTargetWithAuthOrRejectSync, n as RegisterWebhookTargetOptions, o as registerWebhookTargetWithPluginRoute, p as withResolvedWebhookRequestPipeline, t as RegisterWebhookPluginRouteOptions } from "../../webhook-targets-BzeqhU1L.js";
import { n as resolveWebhookPath } from "../../webhook-path-C0u-awmU.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CmF-3zPi.js";
import { o as buildTokenChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DaMnlIWq.js";
import { r as buildSecretInputSchema } from "../../secret-input-D3WF-DxV.js";
import { a as isNormalizedSenderAllowed, n as formatAllowFromLowercase } from "../../allow-from-BJ9EzT9j.js";
import { i as logTypingFailure } from "../../logging-D6QlAVWk.js";
import { r as createChannelPairingController } from "../../channel-pairing-Dxfyty5G.js";
import { t as chunkTextForOutbound } from "../../text-chunking-C44sdYxM.js";
import { O as mergeAllowFromEntries, W as promptSingleChannelSecretInput, Y as runSingleChannelSecretStep, at as setTopLevelChannelDmPolicyWithAllowFrom, d as addWildcardAllowFrom, f as buildSingleChannelSecretPromptState } from "../../setup-wizard-binary-B3fnFGwp.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "../../inbound-envelope-C2oHEvLE.js";

//#region extensions/zalo/src/runtime.d.ts
declare const setZaloRuntime: (next: PluginRuntime) => void, getZaloRuntime: () => PluginRuntime;
//#endregion
export { type BaseProbeResult, type BaseTokenResolution, type ChannelAccountSnapshot, type ChannelMessageActionAdapter, type ChannelMessageActionName, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupPolicy, type MarkdownTableMode, type OpenClawConfig, type OutboundReplyPayload, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type RegisterWebhookPluginRouteOptions, type RegisterWebhookTargetOptions, type ReplyPayload, type RuntimeEnv, type SecretInput, WEBHOOK_ANOMALY_COUNTER_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS, type WizardPrompter, addWildcardAllowFrom, applyAccountNameToChannelSection, applyBasicWebhookRequestGuards, applySetupAccountConfigPatch, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, buildSecretInputSchema, buildSingleChannelSecretPromptState, buildTokenChannelStatusSummary, chunkTextForOutbound, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createDedupeCache, createFixedWindowRateLimiter, createWebhookAnomalyTracker, deliverTextOrMediaReply, formatAllowFromLowercase, formatPairingApproveHint, hasConfiguredSecretInput, isNormalizedSenderAllowed, isNumericTargetId, jsonResult, logTypingFailure, mergeAllowFromEntries, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeResolvedSecretInputString, normalizeSecretInputString, promptSingleChannelSecretInput, readJsonWebhookBodyOrReject, readStringParam, registerPluginHttpRoute, registerWebhookTarget, registerWebhookTargetWithPluginRoute, resolveClientIp, resolveDefaultGroupPolicy, resolveInboundRouteEnvelopeBuilderWithRuntime, resolveOpenProviderRuntimeGroupPolicy, resolveWebhookPath, resolveWebhookTargetWithAuthOrRejectSync, runSingleChannelSecretStep, sendPayloadWithChunkedTextAndMedia, setTopLevelChannelDmPolicyWithAllowFrom, setZaloRuntime, waitForAbortSignal, warnMissingProviderGroupPolicyFallbackOnce, withResolvedWebhookRequestPipeline };