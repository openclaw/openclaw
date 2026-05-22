import { i as OpenClawConfig } from "../../types.openclaw-D8bJSZjd.js";
import { S as MarkdownTableMode } from "../../types.base-YD5s4YZy.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-Db_X5R8E.js";
import { r as AnyAgentTool } from "../../common-CrJv12Zi.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-BP6vIgTy.js";
import { C as OpenClawPluginToolContext } from "../../types-core-kDJIQe10.js";
import { n as RuntimeEnv } from "../../runtime-gBwJlInh.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-DWkvQuBM.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-ZE8HOBLD.js";
import { n as ChannelPlugin } from "../../types.public-i4hJTC6b.js";
import { n as PluginRuntime } from "../../types-_VshWtBa.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-Y-5fsO7u.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-DC_WzaQp.js";
import { r as buildChannelConfigSchema } from "../../config-schema-D2DpU2CE.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-DEKoQRl9.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-DhzMnh67.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-HCcU4MwG.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-BpP4DJGm.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-BYID9gFg.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-Bv5msS2x.js";
import { r as createChannelPairingController } from "../../channel-pairing-BvrLN7YX.js";
import { t as chunkTextForOutbound } from "../../text-chunking-fw_p0nFX.js";
import { t as zalouserPlugin } from "../../channel-DrMCfGeM.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-cmHf_7jI.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-_Vk4BLRy.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-CekapxiY.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };