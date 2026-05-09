import { whatsappCommandPolicy as whatsappCommandPolicyImpl } from "./src/command-policy.js";
import { resolveGroupSessionKey as resolveGroupSessionKeyImpl } from "./src/group-session-contract.js";
import { __testing as whatsappAccessControlTestingImpl } from "./src/inbound/access-control.js";
import {
  isWhatsAppGroupJid as isWhatsAppGroupJidImpl,
  normalizeWhatsAppTarget as normalizeWhatsAppTargetImpl,
} from "./src/normalize-target.js";
export {
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./src/directory-config.js";
import { resolveWhatsAppRuntimeGroupPolicy as resolveWhatsAppRuntimeGroupPolicyImpl } from "./src/runtime-group-policy.js";
export {
  collectUnsupportedSecretRefConfigCandidates,
  unsupportedSecretRefSurfacePatterns,
} from "./src/security-contract.js";

export const isWhatsAppGroupJid = isWhatsAppGroupJidImpl;
export const normalizeWhatsAppTarget = normalizeWhatsAppTargetImpl;
export const resolveGroupSessionKey = resolveGroupSessionKeyImpl;
export const resolveWhatsAppRuntimeGroupPolicy = resolveWhatsAppRuntimeGroupPolicyImpl;
export const whatsappAccessControlTesting = whatsappAccessControlTestingImpl;
export const whatsappCommandPolicy = whatsappCommandPolicyImpl;
