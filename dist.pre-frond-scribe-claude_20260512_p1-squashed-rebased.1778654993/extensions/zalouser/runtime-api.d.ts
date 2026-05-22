import { i as OpenClawConfig } from "../../types.openclaw-BdSNxnBz.js";
import { S as MarkdownTableMode } from "../../types.base-DugutrX1.js";
import { a as GroupToolPolicyConfig } from "../../types.tools-CYAgVUUp.js";
import { r as AnyAgentTool } from "../../common-PkdSYxsi.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-BWIRLVzl.js";
import { C as OpenClawPluginToolContext } from "../../types-core-Bn6U9u2F.js";
import { n as RuntimeEnv } from "../../runtime-DwtdMXkL.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot, t as BaseProbeResult, u as ChannelDirectoryEntry, y as ChannelMessageActionAdapter } from "../../types.core-BDQOD1ST.js";
import { c as deliverTextOrMediaReply, p as isNumericTargetId, r as ReplyPayload, t as OutboundReplyPayload, v as resolveSendableOutboundReplyParts, w as sendPayloadWithChunkedTextAndMedia } from "../../reply-payload-DsDxEZmY.js";
import { n as ChannelPlugin } from "../../types.public-D-nwYThg.js";
import { n as PluginRuntime } from "../../types-Czv_rpgT.js";
import { p as resolveInboundMentionDecision } from "../../mention-gating-Dic5PYOZ.js";
import { i as createChannelReplyPipeline } from "../../reply-pipeline-BxidFswl.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DvPswMZV.js";
import { r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-DeZSoNCW.js";
import { n as isDangerousNameMatchingEnabled } from "../../dangerous-name-matching-B4avXJmy.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-Z6wyRouH.js";
import { t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CFXzNVGU.js";
import { n as loadOutboundMediaFromUrl } from "../../outbound-media-Do8cZHwk.js";
import { f as mergeAllowlist, m as summarizeMapping, n as formatAllowFromLowercase } from "../../allow-from-CRClGQtp.js";
import { r as createChannelPairingController } from "../../channel-pairing-DtYU0Asj.js";
import { t as chunkTextForOutbound } from "../../text-chunking-B-_JQAyH.js";
import { t as zalouserPlugin } from "../../channel-C2oztloV.js";
import { t as zalouserSetupPlugin } from "../../channel.setup-C-BNhT_m.js";
import { i as createZalouserTool, n as createZalouserSetupWizardProxy, r as zalouserSetupAdapter, t as zalouserSetupWizard } from "../../api-B-ofdkn8.js";
import { n as isZalouserMutableGroupEntry, t as collectZalouserSecurityAuditFindings } from "../../security-audit-DWxLSiMd.js";

//#region extensions/zalouser/src/runtime.d.ts
declare const setZalouserRuntime: (next: PluginRuntime) => void, getZalouserRuntime: () => PluginRuntime;
//#endregion
export { type AnyAgentTool, type BaseProbeResult, type ChannelAccountSnapshot, type ChannelDirectoryEntry, type ChannelGroupContext, type ChannelMessageActionAdapter, type ChannelPlugin, type ChannelStatusIssue, DEFAULT_ACCOUNT_ID, type GroupToolPolicyConfig, type MarkdownTableMode, type OpenClawConfig, type OpenClawPluginToolContext, type OutboundReplyPayload, type PluginRuntime, type ReplyPayload, type RuntimeEnv, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, chunkTextForOutbound, collectZalouserSecurityAuditFindings, createChannelReplyPipeline as createChannelMessageReplyPipeline, createChannelPairingController, createZalouserSetupWizardProxy, createZalouserTool, deliverTextOrMediaReply, formatAllowFromLowercase, isDangerousNameMatchingEnabled, isNumericTargetId, isZalouserMutableGroupEntry, loadOutboundMediaFromUrl, mergeAllowlist, normalizeAccountId, resolveDefaultGroupPolicy, resolveInboundMentionDecision, resolveOpenProviderRuntimeGroupPolicy, resolvePreferredOpenClawTmpDir, resolveSendableOutboundReplyParts, sendPayloadWithChunkedTextAndMedia, setZalouserRuntime, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserPlugin, zalouserSetupAdapter, zalouserSetupPlugin, zalouserSetupWizard };