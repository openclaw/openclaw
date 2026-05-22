import { i as OpenClawConfig } from "../../types.openclaw-Bpxi7OSY.js";
import { S as MarkdownTableMode } from "../../types.base-B1xU9TH3.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-BbKI6Ria.js";
import { r as AnyAgentTool } from "../../common-BHDf_7WT.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CocONTDn.js";
import { D as OpenClawPluginToolContext } from "../../types-core-BIykoS6Q.js";
import { n as RuntimeEnv } from "../../runtime-BGU8SNjK.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-1gJzFdXJ.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-FWjCVbzM.js";
import { n as ChannelPlugin } from "../../types.public-oY5Zsold.js";
import { n as PluginRuntime } from "../../types-Dsa-0Faj.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-DXV9rMJC.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-CjNZ1gpq.js";
import { r as buildChannelConfigSchema } from "../../config-schema-Cu4qnl0J.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-DhukDENO.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-DTkELUiI.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CtQ47EKo.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-B_3UIY7e.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-CTGLJY14.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-ZFkDGyah.js";
import { r as createChannelPairingController } from "../../channel-pairing-fIlJcWsI.js";
import { t as chunkTextForOutbound } from "../../text-chunking-D_wnKW5L.js";
import { t as zalouserPlugin } from "../../channel-Cx1kZnPw.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-BWjKtypk.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-B0cksP6t.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-c-kNELMY.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };