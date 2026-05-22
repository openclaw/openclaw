import { m as ChannelCommandAdapter } from "../../types.adapters-mQGWB7d9.js";
import { n as listWhatsAppDirectoryPeersFromConfig, t as listWhatsAppDirectoryGroupsFromConfig } from "../../directory-config-UMSb_vrj.js";
import { o as normalizeWhatsAppTarget$1, t as isWhatsAppGroupJid$1 } from "../../normalize-target-txuBpkNy.js";
import { t as resolveWhatsAppInboundPolicy } from "../../inbound-policy-Dum29WHM.js";
import { t as resolveWhatsAppRuntimeGroupPolicy$1 } from "../../runtime-group-policy-DFxYqZed.js";
import { n as isLegacyGroupSessionKey$1, t as canonicalizeLegacySessionKey$1 } from "../../session-contract-D3LSV2E3.js";
import { n as unsupportedSecretRefSurfacePatterns, t as collectUnsupportedSecretRefConfigCandidates } from "../../security-contract-CITHVBXc.js";

//#region extensions/whatsapp/src/group-session-contract.d.ts
declare function resolveLegacyGroupSessionKey$1(ctx: {
  From?: string;
}): {
  key: string;
  channel: string;
  id: string;
  chatType: "group";
} | null;
//#endregion
//#region extensions/whatsapp/contract-api.d.ts
declare const canonicalizeLegacySessionKey: typeof canonicalizeLegacySessionKey$1;
declare const isLegacyGroupSessionKey: typeof isLegacyGroupSessionKey$1;
declare const isWhatsAppGroupJid: typeof isWhatsAppGroupJid$1;
declare const normalizeWhatsAppTarget: typeof normalizeWhatsAppTarget$1;
declare const resolveLegacyGroupSessionKey: typeof resolveLegacyGroupSessionKey$1;
declare const resolveWhatsAppRuntimeGroupPolicy: typeof resolveWhatsAppRuntimeGroupPolicy$1;
declare const whatsappAccessControlTesting: {
  resolveWhatsAppInboundPolicy: typeof resolveWhatsAppInboundPolicy;
};
declare const whatsappCommandPolicy: ChannelCommandAdapter;
//#endregion
export { canonicalizeLegacySessionKey, collectUnsupportedSecretRefConfigCandidates, isLegacyGroupSessionKey, isWhatsAppGroupJid, listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig, normalizeWhatsAppTarget, resolveLegacyGroupSessionKey, resolveWhatsAppRuntimeGroupPolicy, unsupportedSecretRefSurfacePatterns, whatsappAccessControlTesting, whatsappCommandPolicy };