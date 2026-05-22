import { i as OpenClawConfig } from "../../types.openclaw-DZQrhn8E.js";
import { S as MarkdownTableMode } from "../../types.base-0oN-mnFt.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-DLW0nzGW.js";
import { r as AnyAgentTool } from "../../common-CCrWEB5U.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Ds9BBXA3.js";
import { D as OpenClawPluginToolContext } from "../../types-core-Crp55Z_y.js";
import { n as RuntimeEnv } from "../../runtime-BGFXd35m.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-DiLRQ15F.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-BXM1DJCi.js";
import { n as ChannelPlugin } from "../../types.public-BGobpRnR.js";
import { n as PluginRuntime } from "../../types-DIe2gsAQ.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-D66j7qXL.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-STPhpcZ3.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DrNcI0sQ.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-RiMFGYbh.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-CwDNdfN9.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-w96f2wiG.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-sKHu-JZm.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-DjkcXuzT.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-SDNGw7qS.js";
import { r as createChannelPairingController } from "../../channel-pairing-BIzOnDWB.js";
import { t as chunkTextForOutbound } from "../../text-chunking-BLJe1VMb.js";
import { t as zalouserPlugin } from "../../channel-BPXKbdz-.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-CfPN2SbY.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-BALb_koW.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-CwFGi6bW.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };