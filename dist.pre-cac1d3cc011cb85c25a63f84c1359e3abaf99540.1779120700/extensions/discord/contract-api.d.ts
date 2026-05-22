import { r as createThreadBindingManager, t as __testing } from "../../thread-bindings.manager-DAyjK_qN.js";
import { n as listDiscordDirectoryPeersFromConfig, t as listDiscordDirectoryGroupsFromConfig } from "../../directory-config-komCVBXA.js";
import { n as DiscordInteractiveHandlerRegistration, t as DiscordInteractiveHandlerContext } from "../../interactive-dispatch-BQTpYZYh.js";
import { t as collectDiscordSecurityAuditFindings } from "../../security-audit-Cd3g-SOy.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-nRXWLeE8.js";
import { n as secretTargetRegistryEntries, t as collectRuntimeConfigAssignments } from "../../secret-config-contract-qAlGj4hm.js";
import { n as unsupportedSecretRefSurfacePatterns, t as collectUnsupportedSecretRefConfigCandidates } from "../../security-contract-DpUePFll.js";

//#region extensions/discord/src/session-contract.d.ts
declare function deriveLegacySessionChatType(sessionKey: string): "channel" | undefined;
//#endregion
export { type DiscordInteractiveHandlerContext, type DiscordInteractiveHandlerRegistration, collectDiscordSecurityAuditFindings, collectRuntimeConfigAssignments, collectUnsupportedSecretRefConfigCandidates, createThreadBindingManager, deriveLegacySessionChatType, __testing as discordThreadBindingTesting, legacyConfigRules, listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig, normalizeCompatibilityConfig, secretTargetRegistryEntries, unsupportedSecretRefSurfacePatterns };