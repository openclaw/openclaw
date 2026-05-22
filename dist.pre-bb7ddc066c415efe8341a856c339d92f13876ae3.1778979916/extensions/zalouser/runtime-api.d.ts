import { i as OpenClawConfig } from "../../types.openclaw-BuKAF4PW.js";
import { S as MarkdownTableMode } from "../../types.base-BgiAX4pP.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-CG-d4nA1.js";
import { r as AnyAgentTool } from "../../common-DUJz-9i6.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-C01XwMRy.js";
import { C as OpenClawPluginToolContext } from "../../types-core-xB6vnoi2.js";
import { n as RuntimeEnv } from "../../runtime-Bnks6ho9.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-TY_PD3kg.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DyspiWjJ.js";
import { n as ChannelPlugin } from "../../types.public-CzfdpDjZ.js";
import { n as PluginRuntime } from "../../types-6l5HWcJc.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-BlH28Cyt.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-DT4x3IJB.js";
import { r as buildChannelConfigSchema } from "../../config-schema-B_2f5acI.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-CY_jyjOi.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-CS2dAVNb.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-DlGgJwJW.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DuoyWjvX.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-BGvZlyA7.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-Cv6ePquB.js";
import { r as createChannelPairingController } from "../../channel-pairing-DYU6jRwZ.js";
import { t as chunkTextForOutbound } from "../../text-chunking-DWkW5QQN.js";
import { t as zalouserPlugin } from "../../channel-CPuF9Hdp.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-D9Hkcg8M.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-BdUcyVBu.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-BRj3W_Wu.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };