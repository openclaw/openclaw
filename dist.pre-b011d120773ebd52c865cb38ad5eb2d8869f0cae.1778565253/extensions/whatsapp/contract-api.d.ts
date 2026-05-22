import { m as ChannelCommandAdapter } from "../../types.adapters-BGkc2cju.js";
import { n as listWhatsAppDirectoryPeersFromConfig, t as listWhatsAppDirectoryGroupsFromConfig } from "../../directory-config-DRJ1X-Vq.js";
import { o as normalizeWhatsAppTarget$1, t as isWhatsAppGroupJid$1 } from "../../normalize-target-D4tYJF7K.js";
import { t as resolveWhatsAppInboundPolicy } from "../../inbound-policy-ndSqC6So.js";
import { t as resolveWhatsAppRuntimeGroupPolicy$1 } from "../../runtime-group-policy-DjATAOHZ.js";
import { n as isLegacyGroupSessionKey$1, t as canonicalizeLegacySessionKey$1 } from "../../session-contract-B25HXXaF.js";
import { n as unsupportedSecretRefSurfacePatterns, t as collectUnsupportedSecretRefConfigCandidates } from "../../security-contract-C5_QqxLy.js";

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