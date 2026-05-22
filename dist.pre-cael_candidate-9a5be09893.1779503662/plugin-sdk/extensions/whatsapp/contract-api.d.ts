import { resolveLegacyGroupSessionKey as resolveLegacyGroupSessionKeyImpl } from "./src/group-session-contract.js";
import { isWhatsAppGroupJid as isWhatsAppGroupJidImpl, normalizeWhatsAppTarget as normalizeWhatsAppTargetImpl } from "./src/normalize-target.js";
export { listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig, } from "./src/directory-config.js";
import { resolveWhatsAppRuntimeGroupPolicy as resolveWhatsAppRuntimeGroupPolicyImpl } from "./src/runtime-group-policy.js";
import { canonicalizeLegacySessionKey as canonicalizeLegacySessionKeyImpl, isLegacyGroupSessionKey as isLegacyGroupSessionKeyImpl } from "./src/session-contract.js";
export { collectUnsupportedSecretRefConfigCandidates, unsupportedSecretRefSurfacePatterns, } from "./src/security-contract.js";
export declare const canonicalizeLegacySessionKey: typeof canonicalizeLegacySessionKeyImpl;
export declare const isLegacyGroupSessionKey: typeof isLegacyGroupSessionKeyImpl;
export declare const isWhatsAppGroupJid: typeof isWhatsAppGroupJidImpl;
export declare const normalizeWhatsAppTarget: typeof normalizeWhatsAppTargetImpl;
export declare const resolveLegacyGroupSessionKey: typeof resolveLegacyGroupSessionKeyImpl;
export declare const resolveWhatsAppRuntimeGroupPolicy: typeof resolveWhatsAppRuntimeGroupPolicyImpl;
export declare const whatsappAccessControlTesting: {
    resolveWhatsAppInboundPolicy: typeof import("./src/inbound-policy.ts").resolveWhatsAppInboundPolicy;
};
export declare const whatsappCommandPolicy: import("openclaw/plugin-sdk/channel-runtime").ChannelCommandAdapter;
