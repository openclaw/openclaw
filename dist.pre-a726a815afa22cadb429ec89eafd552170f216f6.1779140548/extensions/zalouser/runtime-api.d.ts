import { i as OpenClawConfig } from "../../types.openclaw-CQzDxdpQ.js";
import { S as MarkdownTableMode } from "../../types.base-BSU34aN9.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-CxacbZLS.js";
import { r as AnyAgentTool } from "../../common-DQVa3xpB.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-jXSHRHDW.js";
import { D as OpenClawPluginToolContext } from "../../types-core-BZYGpYcV.js";
import { n as RuntimeEnv } from "../../runtime-dOUD4nei.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-DrB_kWzl.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DUBNZ2s7.js";
import { n as ChannelPlugin } from "../../types.public-C5MFEvPW.js";
import { n as PluginRuntime } from "../../types-CXGnubLv.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-BIgfK4F8.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-BUCmnyv5.js";
import { r as buildChannelConfigSchema } from "../../config-schema-D14tWtON.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-BPEDDfyf.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-CU6NXSx8.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-VYDXV5_b.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DgSZFPBU.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-CZMYEMFE.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-CcYUHm39.js";
import { r as createChannelPairingController } from "../../channel-pairing-CDDwGgW9.js";
import { t as chunkTextForOutbound } from "../../text-chunking-CL4-YftM.js";
import { t as zalouserPlugin } from "../../channel-DGLICxAA.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-CxDHYmfg.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-0QM8zL_r.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-Biwn-usx.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };