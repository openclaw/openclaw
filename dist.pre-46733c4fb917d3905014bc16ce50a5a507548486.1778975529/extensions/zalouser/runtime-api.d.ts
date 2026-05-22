import { i as OpenClawConfig } from "../../types.openclaw-C5VNg6h3.js";
import { S as MarkdownTableMode } from "../../types.base-18TT18fa.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-CZigsz6m.js";
import { r as AnyAgentTool } from "../../common-DUJz-9i6.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-C01XwMRy.js";
import { C as OpenClawPluginToolContext } from "../../types-core-ru000wBe.js";
import { n as RuntimeEnv } from "../../runtime-Bnks6ho9.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-BHltg72J.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-BEgT3HkY.js";
import { n as ChannelPlugin } from "../../types.public-DObS_ia-.js";
import { n as PluginRuntime } from "../../types-DP05JWdB.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-BlH28Cyt.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-DcvGCfC_.js";
import { r as buildChannelConfigSchema } from "../../config-schema-B_2f5acI.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-CY_jyjOi.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-K6-TYXIy.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BSvk_9Fa.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DWBtXDYs.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-BGvZlyA7.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-Cv6ePquB.js";
import { r as createChannelPairingController } from "../../channel-pairing-D1TQvmJu.js";
import { t as chunkTextForOutbound } from "../../text-chunking-DWkW5QQN.js";
import { t as zalouserPlugin } from "../../channel-BfQ825iz.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-CkF9CEVk.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-CSgd9SwA.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-Cg6Uw1GW.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };