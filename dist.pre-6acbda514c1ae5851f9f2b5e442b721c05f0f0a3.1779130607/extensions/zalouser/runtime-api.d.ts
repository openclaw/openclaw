import { i as OpenClawConfig } from "../../types.openclaw-BYfkTL_f.js";
import { S as MarkdownTableMode } from "../../types.base-0oN-mnFt.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-DLW0nzGW.js";
import { r as AnyAgentTool } from "../../common-CCrWEB5U.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Ds9BBXA3.js";
import { D as OpenClawPluginToolContext } from "../../types-core-CmalkDje.js";
import { n as RuntimeEnv } from "../../runtime-BGFXd35m.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-DMG-czl3.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DpKGqclz.js";
import { n as ChannelPlugin } from "../../types.public-CwqPONY3.js";
import { n as PluginRuntime } from "../../types-PzLD5nJ3.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-D66j7qXL.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-DfNGR-8N.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DrNcI0sQ.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-BWUdONWI.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-BUVDVcUB.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CTAOWeji.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DaMnlIWq.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-Cg8-FWXn.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-BJ9EzT9j.js";
import { r as createChannelPairingController } from "../../channel-pairing-Dxfyty5G.js";
import { t as chunkTextForOutbound } from "../../text-chunking-C44sdYxM.js";
import { t as zalouserPlugin } from "../../channel-5mHLcC42.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-CvPnJaY9.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-BbCnyT09.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-Bt0mcCFw.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };