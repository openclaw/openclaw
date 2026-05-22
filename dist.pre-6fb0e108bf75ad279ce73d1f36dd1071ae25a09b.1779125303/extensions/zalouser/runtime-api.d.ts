import { i as OpenClawConfig } from "../../types.openclaw-DBDmmaVM.js";
import { S as MarkdownTableMode } from "../../types.base-CzXKYjot.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-9EnNA1hP.js";
import { r as AnyAgentTool } from "../../common-DiB-YMdz.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Iwx-m7pc.js";
import { D as OpenClawPluginToolContext } from "../../types-core-DNRcqjn0.js";
import { n as RuntimeEnv } from "../../runtime-B4p2dmOC.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-DA-emjB6.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-CNTUnQyV.js";
import { n as ChannelPlugin } from "../../types.public-Cx-Og-oG.js";
import { n as PluginRuntime } from "../../types-BkonLdRT.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-Dc9uVKJp.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-DDZdT6ub.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BsLYUSD_.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-Cl_J34bY.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-DRSvuIYX.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-DeCAMmmi.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CTxy4utA.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-Dwtl_6Y4.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-C0lJ05sX.js";
import { r as createChannelPairingController } from "../../channel-pairing-BWpp3F-L.js";
import { t as chunkTextForOutbound } from "../../text-chunking-CwtMbR6o.js";
import { t as zalouserPlugin } from "../../channel-Txn3CeXn.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-BcMdFE1H.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-VLo3qOYb.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-wEHiOGoG.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };