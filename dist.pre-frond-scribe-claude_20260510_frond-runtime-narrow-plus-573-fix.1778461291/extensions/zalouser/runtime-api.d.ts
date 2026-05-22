import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { S as MarkdownTableMode } from "../../types.base-CN1BlTRP.js";
import { En as GroupToolPolicyConfig } from "../../types.channels-Df4-Bt6H.js";
import { r as AnyAgentTool } from "../../common-B0aZxYiS.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Ds9BBXA3.js";
import { C as OpenClawPluginToolContext } from "../../types-core-_mEOJ_c3.js";
import { n as RuntimeEnv } from "../../runtime-lEKWbTQa.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-CQScvK0N.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DxNjvRBt.js";
import { n as ChannelPlugin } from "../../types.public-BMrZTIWg.js";
import { n as PluginRuntime } from "../../types-DVhGJHIy.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-qfLnkrwU.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-BPInIQpI.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DyWSTJ5E.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-wpn9U_na.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-Bmqcn98O.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-STYjuANm.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-BunjMIEf.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-B88OPMOG.js";
import { d as resolveSenderScopedGroupPolicy, s as evaluateGroupRouteAccessForPolicy } from "../../group-access-DK5RmZHa.js";
import { g as mergeAllowlist, n as formatAllowFromLowercase, v as summarizeMapping } from "../../allow-from-B_I_2bpd.js";
import { c as resolveSenderCommandAuthorization } from "../../command-auth-DwsZutp0.js";
import { r as createChannelPairingController } from "../../channel-pairing-B8mQlhPz.js";
import { t as chunkTextForOutbound } from "../../text-chunking-BkFkH-DO.js";
import { t as zalouserPlugin } from "../../channel-CmFmYLUX.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-BgVToNzl.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-tfRw5XsF.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-CgRNRyNj.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, evaluateGroupRouteAccessForPolicy, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, resolveSenderCommandAuthorization, resolveSenderScopedGroupPolicy, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };