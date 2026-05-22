import { i as OpenClawConfig } from "../../types.openclaw-BlE9q7jU.js";
import { S as MarkdownTableMode } from "../../types.base-DkCfHNRn.js";
import { a as GroupToolPolicyConfig } from "../../types.tools-rF2K5Ucb.js";
import { r as AnyAgentTool } from "../../common-K3KGpeVn.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CHNX91pr.js";
import { C as OpenClawPluginToolContext } from "../../types-core-C4sdPbS4.js";
import { n as RuntimeEnv } from "../../runtime-B7xbUSXv.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-BoZgMdCh.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DdR61wWB.js";
import { n as ChannelPlugin } from "../../types.public-Bp4rl8_W.js";
import { n as PluginRuntime } from "../../types-6GKVZ6OQ.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-BcSZwXKC.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-DNQK_vYV.js";
import { r as buildChannelConfigSchema } from "../../config-schema-z_IyuJQR.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-RiMFGYbh.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-Cd8RuskB.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-Ya8W-NBn.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DI7-87gZ.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-bPcJbot3.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-3EKQVeRQ.js";
import { r as createChannelPairingController } from "../../channel-pairing-Br2SBmy5.js";
import { t as chunkTextForOutbound } from "../../text-chunking-Xn1GuzXu.js";
import { t as zalouserPlugin } from "../../channel-B8AKbh_v.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-bLZBxjak.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-Dn4FscEM.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-DAL-O2iu.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };