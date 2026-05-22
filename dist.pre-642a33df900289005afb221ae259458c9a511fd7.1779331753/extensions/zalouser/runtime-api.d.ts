import { i as OpenClawConfig } from "../../types.openclaw-GamulG8g.js";
import { S as MarkdownTableMode } from "../../types.base-DS--yneR.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-BpgZArJS.js";
import { r as AnyAgentTool } from "../../common-D4gcZLB7.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Dh6XMgGH.js";
import { D as OpenClawPluginToolContext } from "../../types-core-Ct8aDHbu.js";
import { n as RuntimeEnv } from "../../runtime-Bxifh4bY.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-C6a4QJNn.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-BIYe4NOR.js";
import { n as ChannelPlugin } from "../../types.public-0ZbPwK4W.js";
import { n as PluginRuntime } from "../../types-AFN3jLI5.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-D6dFDlTf.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-BJoQPo87.js";
import { r as buildChannelConfigSchema } from "../../config-schema-Dx48Ud8L.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-DRV57vdI.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-Cw3wCrH6.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BQMFOBke.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-Cvm3ksrt.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-Be_v5DK2.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-Cyh-mzVO.js";
import { r as createChannelPairingController } from "../../channel-pairing-rjGrKJsd.js";
import { t as chunkTextForOutbound } from "../../text-chunking-B2vtBPHV.js";
import { t as zalouserPlugin } from "../../channel-Dlq8ZEtg.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-hmsBLVrk.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-BQ5NgbVy.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-Df8pMp6g.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };