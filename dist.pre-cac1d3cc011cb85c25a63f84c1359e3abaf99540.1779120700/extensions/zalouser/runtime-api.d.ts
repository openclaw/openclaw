import { i as OpenClawConfig } from "../../types.openclaw-C58U02FA.js";
import { S as MarkdownTableMode } from "../../types.base-Ckc5Vavh.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-BazVM-7U.js";
import { r as AnyAgentTool } from "../../common-hSeaGqMJ.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-1Yw8kMCr.js";
import { D as OpenClawPluginToolContext } from "../../types-core-DDZhpNYe.js";
import { n as RuntimeEnv } from "../../runtime-lEKWbTQa.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-zIW2Gjsy.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DWEJrbEL.js";
import { n as ChannelPlugin } from "../../types.public-JfHpZqwR.js";
import { n as PluginRuntime } from "../../types-taiLI91p.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-DPoY_Hhn.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-Bl9MA3k5.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BU12utEU.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-0iuFQpfZ.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-YvwQXk43.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-C1eIb4OD.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CBg1LFP_.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-_CC3fSwg.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-DGSUN7qr.js";
import { r as createChannelPairingController } from "../../channel-pairing-V1gTvRfa.js";
import { t as chunkTextForOutbound } from "../../text-chunking-C44sdYxM.js";
import { t as zalouserPlugin } from "../../channel-C6-avvMm.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-BnH6_l8L.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-BWOBbrcj.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-Bh5pQp1y.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };