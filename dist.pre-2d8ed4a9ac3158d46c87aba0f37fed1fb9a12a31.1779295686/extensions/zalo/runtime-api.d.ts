import { i as OpenClawConfig } from "../../types.openclaw-DPnlcagS.js";
import { S as normalizeSecretInputString, l as SecretInput, v as hasConfiguredSecretInput, x as normalizeResolvedSecretInputString } from "../../types.secrets-CW3w8nVu.js";
import { S as MarkdownTableMode, _ as GroupPolicy } from "../../types.base-CQ4VM2EL.js";
import { C as readStringParam, h as jsonResult } from "../../common-BLkNF-zo.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CHNX91pr.js";
import { n as RuntimeEnv } from "../../runtime-BvGYzQ2u.js";
import { i as WizardPrompter } from "../../prompts-RT9LHx1Q.js";
import { F as ChannelStatusIssue, n as BaseTokenResolution, r as ChannelAccountSnapshot, t as BaseProbeResult, y as ChannelMessageActionAdapter } from "../../types.core-remGx4m5.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DmUUsX03.js";
import { n as ChannelPlugin, t as ChannelMessageActionName } from "../../types.public-BlA4mimK.js";
import { n as PluginRuntime } from "../../types-CvAaVTok.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-D5Xi2EwO.js";
import { r as createDedupeCache } from "../../dedupe-CM03D0WY.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BZ1GGqdH.js";
import { n as applySetupAccountConfigPatch, s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DgCYXJ_C.js";
import { n as formatPairingApproveHint } from "../../helpers-DhtzxdgZ.js";
import { i as resolveClientIp } from "../../net-CB33evAn.js";
import { r as waitForAbortSignal } from "../../unhandled-rejections-U9T3rA0C.js";
import { n as registerPluginHttpRoute } from "../../http-registry-3Sdy92Hx.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CgfdTume.js";
import { a as applyBasicWebhookRequestGuards, h as WEBHOOK_RATE_LIMIT_DEFAULTS, l as readJsonWebhookBodyOrReject, p as WEBHOOK_ANOMALY_COUNTER_DEFAULTS, v as createFixedWindowRateLimiter, y as createWebhookAnomalyTracker } from "../../webhook-request-guards-DGEqtp0p.js";
import { a as registerWebhookTarget, d as resolveWebhookTargetWithAuthOrRejectSync, n as RegisterWebhookTargetOptions, o as registerWebhookTargetWithPluginRoute, p as withResolvedWebhookRequestPipeline, t as RegisterWebhookPluginRouteOptions } from "../../webhook-targets-vDiCF5CM.js";
import { n as resolveWebhookPath } from "../../webhook-path-BF_Ni5yZ.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CT5xAlrM.js";
import { o as buildTokenChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-C0D9s3Q-.js";
import { r as buildSecretInputSchema } from "../../secret-input-D4HXtGHm.js";
import { a as isNormalizedSenderAllowed, n as formatAllowFromLowercase } from "../../allow-from-C9U087Lp.js";
import { i as logTypingFailure } from "../../logging-PBdzu46r.js";
import { r as createChannelPairingController } from "../../channel-pairing-DHrwWyRA.js";
import { t as chunkTextForOutbound } from "../../text-chunking-DRPNmnpl.js";
import { O as mergeAllowFromEntries, W as promptSingleChannelSecretInput, Y as runSingleChannelSecretStep, at as setTopLevelChannelDmPolicyWithAllowFrom, d as addWildcardAllowFrom, f as buildSingleChannelSecretPromptState } from "../../setup-wizard-binary-X9ay5N-s.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "../../inbound-envelope-W2GkcRM5.js";

//#region extensions/zalo/src/runtime.d.ts
declare const setZaloRuntime: (next: PluginRuntime) => void, getZaloRuntime: () => PluginRuntime;
//#endregion
export { type BaseProbeResult, type BaseTokenResolution, type ChannelAccountSnapshot, type ChannelMessageActionAdapter, type ChannelMessageActionName, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupPolicy, type MarkdownTableMode, type OpenClawConfig, type OutboundReplyPayload, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type RegisterWebhookPluginRouteOptions, type RegisterWebhookTargetOptions, type ReplyPayload, type RuntimeEnv, type SecretInput, WEBHOOK_ANOMALY_COUNTER_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS, type WizardPrompter, addWildcardAllowFrom, applyAccountNameToChannelSection, applyBasicWebhookRequestGuards, applySetupAccountConfigPatch, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, buildSecretInputSchema, buildSingleChannelSecretPromptState, buildTokenChannelStatusSummary, chunkTextForOutbound, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createDedupeCache, createFixedWindowRateLimiter, createWebhookAnomalyTracker, deliverTextOrMediaReply, formatAllowFromLowercase, formatPairingApproveHint, hasConfiguredSecretInput, isNormalizedSenderAllowed, isNumericTargetId, jsonResult, logTypingFailure, mergeAllowFromEntries, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeResolvedSecretInputString, normalizeSecretInputString, promptSingleChannelSecretInput, readJsonWebhookBodyOrReject, readStringParam, registerPluginHttpRoute, registerWebhookTarget, registerWebhookTargetWithPluginRoute, resolveClientIp, resolveDefaultGroupPolicy, resolveInboundRouteEnvelopeBuilderWithRuntime, resolveOpenProviderRuntimeGroupPolicy, resolveWebhookPath, resolveWebhookTargetWithAuthOrRejectSync, runSingleChannelSecretStep, sendPayloadWithChunkedTextAndMedia, setTopLevelChannelDmPolicyWithAllowFrom, setZaloRuntime, waitForAbortSignal, warnMissingProviderGroupPolicyFallbackOnce, withResolvedWebhookRequestPipeline };