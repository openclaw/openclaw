import { i as OpenClawConfig } from "../../types.openclaw-DNoZmPZ8.js";
import { S as MarkdownTableMode } from "../../types.base-CxMBQUJ_.js";
import { a as GroupToolPolicyConfig } from "../../types.tools-tU9HoLwi.js";
import { r as AnyAgentTool } from "../../common-Dhvpr_ee.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CA4LSr_f.js";
import { C as OpenClawPluginToolContext } from "../../types-core-BQms3m8n.js";
import { n as RuntimeEnv } from "../../runtime-dC5rwQf_.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-yC1NCFUF.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-ClVTZTBq.js";
import { n as ChannelPlugin } from "../../types.public-hz1J9-y_.js";
import { n as PluginRuntime } from "../../types-DLVUU0yv.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-BXZqVFu4.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-CUNHHLhz.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BrlMkD9Y.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-iwed9Pcj.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-BCKoYhym.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-B83KFe4R.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-BEGpXRZl.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-DBL0Jr_z.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-xvWjc4PS.js";
import { r as createChannelPairingController } from "../../channel-pairing-Dk2Pbfpq.js";
import { t as chunkTextForOutbound } from "../../text-chunking-CaskiTEM.js";
import { t as zalouserPlugin } from "../../channel-BpN0IsCc.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-CfLDvJnr.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-BjZtf37U.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-DzMG2sac.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };