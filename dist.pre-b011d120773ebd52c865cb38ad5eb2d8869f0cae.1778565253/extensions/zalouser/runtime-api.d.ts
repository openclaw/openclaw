import { i as OpenClawConfig } from "../../types.openclaw-BdZr8Ncl.js";
import { S as MarkdownTableMode } from "../../types.base-BUAA7yMj.js";
import { a as GroupToolPolicyConfig } from "../../types.tools-yFjNLaDS.js";
import { r as AnyAgentTool } from "../../common-CgYoda5e.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-FZhPryJd.js";
import { C as OpenClawPluginToolContext } from "../../types-core-0qSk-WYG.js";
import { n as RuntimeEnv } from "../../runtime-DRy59NVK.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-D5GEzFhB.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-B-IPpMUf.js";
import { n as ChannelPlugin } from "../../types.public-CH2hYFDc.js";
import { n as PluginRuntime } from "../../types-4PahHl43.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-Dia_iy5a.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-BQ__n_5t.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DoRYUMiG.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-Btyca4JX.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-AHXMHbfb.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-B3gNb0Lm.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DfxJPCFm.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-dPIMGupf.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-D0zZkv2C.js";
import { r as createChannelPairingController } from "../../channel-pairing-DroWhDc_.js";
import { t as chunkTextForOutbound } from "../../text-chunking-Dg-3jS4Q.js";
import { t as zalouserPlugin } from "../../channel-PWF2m1tg.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-BOvSs-hH.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-BfvZ69NW.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-pDT-f8ao.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };