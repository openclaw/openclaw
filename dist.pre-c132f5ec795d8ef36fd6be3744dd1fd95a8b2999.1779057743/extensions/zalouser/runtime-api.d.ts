import { i as OpenClawConfig } from "../../types.openclaw-BMMD0Ykw.js";
import { S as MarkdownTableMode } from "../../types.base-CLStZQus.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-DLEW2k4L.js";
import { r as AnyAgentTool } from "../../common-MKouOaZh.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-B20n5Nn2.js";
import { C as OpenClawPluginToolContext } from "../../types-core-DeSCCKji.js";
import { n as RuntimeEnv } from "../../runtime-Dnacw8wE.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-CgjRAtD6.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-Dx5_3_RD.js";
import { n as ChannelPlugin } from "../../types.public-ElAweHV2.js";
import { n as PluginRuntime } from "../../types-1xy7Ddy0.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-DcpcJNSi.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-FWD3RwUr.js";
import { r as buildChannelConfigSchema } from "../../config-schema-3flc7X46.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-DI5Ds8uv.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-Db8zqv7z.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CDhokHqN.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-YBK4DQ3X.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-DKpaq4uy.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-kgqdU7P_.js";
import { r as createChannelPairingController } from "../../channel-pairing-BpJl3rJ5.js";
import { t as chunkTextForOutbound } from "../../text-chunking-BpWi-CpA.js";
import { t as zalouserPlugin } from "../../channel-Blwb5mRb.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-VYlncjQF.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-DcScdk09.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-Ruojjt7y.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };