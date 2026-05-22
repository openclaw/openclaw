import { i as OpenClawConfig } from "../../types.openclaw-BdSNxnBz.js";
import { S as normalizeSecretInputString, l as SecretInput, v as hasConfiguredSecretInput, x as normalizeResolvedSecretInputString } from "../../types.secrets-w53yq22b.js";
import { S as MarkdownTableMode, _ as GroupPolicy } from "../../types.base-DugutrX1.js";
import { C as readStringParam, h as jsonResult } from "../../common-PkdSYxsi.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-BWIRLVzl.js";
import { n as RuntimeEnv } from "../../runtime-DwtdMXkL.js";
import { i as WizardPrompter } from "../../prompts-DFjWh2n9.js";
import { F as ChannelStatusIssue, n as BaseTokenResolution, r as ChannelAccountSnapshot, t as BaseProbeResult, y as ChannelMessageActionAdapter } from "../../types.core-BDQOD1ST.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DsDxEZmY.js";
import { n as ChannelPlugin, t as ChannelMessageActionName } from "../../types.public-D-nwYThg.js";
import { n as PluginRuntime } from "../../types-Czv_rpgT.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-BxidFswl.js";
import { r as createDedupeCache } from "../../dedupe-DzHzPV6G.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DvPswMZV.js";
import { n as applySetupAccountConfigPatch, s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DfRmBmkW.js";
import { n as formatPairingApproveHint } from "../../helpers-B34oaxp4.js";
import { i as resolveClientIp } from "../../net-j2T8CcSq.js";
import { r as waitForAbortSignal } from "../../unhandled-rejections-bRQR9694.js";
import { n as registerPluginHttpRoute } from "../../http-registry-Dervu3hV.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-Z6wyRouH.js";
import { a as applyBasicWebhookRequestGuards, h as WEBHOOK_RATE_LIMIT_DEFAULTS, l as readJsonWebhookBodyOrReject, p as WEBHOOK_ANOMALY_COUNTER_DEFAULTS, v as createFixedWindowRateLimiter, y as createWebhookAnomalyTracker } from "../../webhook-request-guards-CuatdQ0f.js";
import { a as registerWebhookTarget, d as resolveWebhookTargetWithAuthOrRejectSync, n as RegisterWebhookTargetOptions, o as registerWebhookTargetWithPluginRoute, p as withResolvedWebhookRequestPipeline, t as RegisterWebhookPluginRouteOptions } from "../../webhook-targets-D-asuK_S.js";
import { n as resolveWebhookPath } from "../../webhook-path-COHHjsdz.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-D2cbzMRA.js";
import { o as buildTokenChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CFXzNVGU.js";
import { r as buildSecretInputSchema } from "../../secret-input-DgtP1Ntf.js";
import { a as isNormalizedSenderAllowed, n as formatAllowFromLowercase } from "../../allow-from-CRClGQtp.js";
import { i as logTypingFailure } from "../../logging-eU3MPr_B.js";
import { r as createChannelPairingController } from "../../channel-pairing-DtYU0Asj.js";
import { t as chunkTextForOutbound } from "../../text-chunking-B-_JQAyH.js";
import { O as mergeAllowFromEntries, W as promptSingleChannelSecretInput, Y as runSingleChannelSecretStep, at as setTopLevelChannelDmPolicyWithAllowFrom, d as addWildcardAllowFrom, f as buildSingleChannelSecretPromptState } from "../../setup-wizard-binary-DzN1QaUr.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "../../inbound-envelope-BmNdKKf9.js";

//#region extensions/zalo/src/runtime.d.ts
declare const setZaloRuntime: (next: PluginRuntime) => void, getZaloRuntime: () => PluginRuntime;
//#endregion
export { type BaseProbeResult, type BaseTokenResolution, type ChannelAccountSnapshot, type ChannelMessageActionAdapter, type ChannelMessageActionName, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupPolicy, type MarkdownTableMode, type OpenClawConfig, type OutboundReplyPayload, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type RegisterWebhookPluginRouteOptions, type RegisterWebhookTargetOptions, type ReplyPayload, type RuntimeEnv, type SecretInput, WEBHOOK_ANOMALY_COUNTER_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS, type WizardPrompter, addWildcardAllowFrom, applyAccountNameToChannelSection, applyBasicWebhookRequestGuards, applySetupAccountConfigPatch, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, buildSecretInputSchema, buildSingleChannelSecretPromptState, buildTokenChannelStatusSummary, chunkTextForOutbound, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createDedupeCache, createFixedWindowRateLimiter, createWebhookAnomalyTracker, deliverTextOrMediaReply, formatAllowFromLowercase, formatPairingApproveHint, hasConfiguredSecretInput, isNormalizedSenderAllowed, isNumericTargetId, jsonResult, logTypingFailure, mergeAllowFromEntries, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeResolvedSecretInputString, normalizeSecretInputString, promptSingleChannelSecretInput, readJsonWebhookBodyOrReject, readStringParam, registerPluginHttpRoute, registerWebhookTarget, registerWebhookTargetWithPluginRoute, resolveClientIp, resolveDefaultGroupPolicy, resolveInboundRouteEnvelopeBuilderWithRuntime, resolveOpenProviderRuntimeGroupPolicy, resolveWebhookPath, resolveWebhookTargetWithAuthOrRejectSync, runSingleChannelSecretStep, sendPayloadWithChunkedTextAndMedia, setTopLevelChannelDmPolicyWithAllowFrom, setZaloRuntime, waitForAbortSignal, warnMissingProviderGroupPolicyFallbackOnce, withResolvedWebhookRequestPipeline };