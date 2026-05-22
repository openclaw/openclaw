import { i as OpenClawConfig } from "../../types.openclaw-BorXMoYB.js";
import { S as MarkdownTableMode } from "../../types.base-DS--yneR.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-BpgZArJS.js";
import { r as AnyAgentTool } from "../../common-BDN0bXby.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Dh6XMgGH.js";
import { D as OpenClawPluginToolContext } from "../../types-core-DM6WiBWx.js";
import { n as RuntimeEnv } from "../../runtime-Bxifh4bY.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-Dsbrk0cK.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-BWXOYgR6.js";
import { n as ChannelPlugin } from "../../types.public-BOiayIk5.js";
import { n as PluginRuntime } from "../../types-Cr6dS3nU.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-D6dFDlTf.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-DRugyKbO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-lIvqvlbL.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-DEsLV64h.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DnyqEQ6H.js";
import { r as createChannelPairingController } from "../../channel-pairing-BoP05prW.js";
import { t as chunkTextForOutbound } from "../../text-chunking-B2vtBPHV.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-DRV57vdI.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BQMFOBke.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-Bp109xuN.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-Cyh-mzVO.js";
import { t as zalouserPlugin } from "../../channel-DWdYv0lv.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-BvVJRa-x.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-DQZiNofE.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-CitNG_A5.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };