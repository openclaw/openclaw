import { s as normalizeWhatsAppTarget$1, t as isWhatsAppGroupJid$1 } from "../../normalize-target-DeYXtNkU.js";
import { t as whatsappCommandPolicy$1 } from "../../command-policy-wYHwB3yd.js";
import { t as resolveLegacyGroupSessionKey$1 } from "../../group-session-contract-BWPVJOAl.js";
import { n as unsupportedSecretRefSurfacePatterns, t as collectUnsupportedSecretRefConfigCandidates } from "../../security-contract-uX4pcc8J.js";
import { r as isLegacyGroupSessionKey$1, t as canonicalizeLegacySessionKey$1 } from "../../session-contract-BDDBcQnX.js";
import { n as listWhatsAppDirectoryPeersFromConfig, t as listWhatsAppDirectoryGroupsFromConfig } from "../../directory-config-C5CTTVcF.js";
import { t as resolveWhatsAppRuntimeGroupPolicy$1 } from "../../runtime-group-policy-CeSdo9hO.js";
import { t as __testing } from "../../access-control-DyUbXbT7.js";
//#region extensions/whatsapp/contract-api.ts
const canonicalizeLegacySessionKey = canonicalizeLegacySessionKey$1;
const isLegacyGroupSessionKey = isLegacyGroupSessionKey$1;
const isWhatsAppGroupJid = isWhatsAppGroupJid$1;
const normalizeWhatsAppTarget = normalizeWhatsAppTarget$1;
const resolveLegacyGroupSessionKey = resolveLegacyGroupSessionKey$1;
const resolveWhatsAppRuntimeGroupPolicy = resolveWhatsAppRuntimeGroupPolicy$1;
const whatsappAccessControlTesting = __testing;
const whatsappCommandPolicy = whatsappCommandPolicy$1;
//#endregion
export { canonicalizeLegacySessionKey, collectUnsupportedSecretRefConfigCandidates, isLegacyGroupSessionKey, isWhatsAppGroupJid, listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig, normalizeWhatsAppTarget, resolveLegacyGroupSessionKey, resolveWhatsAppRuntimeGroupPolicy, unsupportedSecretRefSurfacePatterns, whatsappAccessControlTesting, whatsappCommandPolicy };
