import { i as OpenClawConfig } from "../../types.openclaw-DPnlcagS.js";
import { S as MarkdownTableMode } from "../../types.base-CQ4VM2EL.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-VTp_8rx9.js";
import { r as AnyAgentTool } from "../../common-BLkNF-zo.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CHNX91pr.js";
import { D as OpenClawPluginToolContext } from "../../types-core-BCt6C0U-.js";
import { n as RuntimeEnv } from "../../runtime-BvGYzQ2u.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-remGx4m5.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DmUUsX03.js";
import { n as ChannelPlugin } from "../../types.public-BlA4mimK.js";
import { n as PluginRuntime } from "../../types-CvAaVTok.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-C_gAmsRj.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-D5Xi2EwO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BZ1GGqdH.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-BIHcj6Gw.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-CNTJMskH.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CgfdTume.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-C0D9s3Q-.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-CHsuUwe8.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-C9U087Lp.js";
import { r as createChannelPairingController } from "../../channel-pairing-DHrwWyRA.js";
import { t as chunkTextForOutbound } from "../../text-chunking-DRPNmnpl.js";
import { t as zalouserPlugin } from "../../channel-B1ASni08.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-B8ZNujA7.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-kp199SAQ.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-HgwiFXgm.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };