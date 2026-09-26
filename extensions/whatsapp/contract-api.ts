import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { whatsappCommandPolicy as whatsappCommandPolicyImpl } from "./src/command-policy.js";
import { resolveLegacyGroupSessionKey as resolveLegacyGroupSessionKeyImpl } from "./src/group-session-contract.js";
import {
  isWhatsAppGroupJid as isWhatsAppGroupJidImpl,
  normalizeWhatsAppTarget as normalizeWhatsAppTargetImpl,
} from "./src/normalize-target.js";
import {
  canonicalizeLegacySessionKey as canonicalizeLegacySessionKeyImpl,
  isLegacyGroupSessionKey as isLegacyGroupSessionKeyImpl,
} from "./src/session-contract.js";

export const canonicalizeLegacySessionKey = canonicalizeLegacySessionKeyImpl;
export const isLegacyGroupSessionKey = isLegacyGroupSessionKeyImpl;
export const isWhatsAppGroupJid = isWhatsAppGroupJidImpl;
export const normalizeWhatsAppTarget = normalizeWhatsAppTargetImpl;
export const resolveLegacyGroupSessionKey = resolveLegacyGroupSessionKeyImpl;
export const resolveWhatsAppRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;
export const whatsappCommandPolicy = whatsappCommandPolicyImpl;
