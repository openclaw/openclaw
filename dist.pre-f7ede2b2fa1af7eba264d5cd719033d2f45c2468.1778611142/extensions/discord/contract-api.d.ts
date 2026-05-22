import { r as createThreadBindingManager, t as __testing } from "../../thread-bindings.manager-TMmqUJPi.js";
import { n as listDiscordDirectoryPeersFromConfig, t as listDiscordDirectoryGroupsFromConfig } from "../../directory-config-BdEaygvd.js";
import { n as DiscordInteractiveHandlerRegistration, t as DiscordInteractiveHandlerContext } from "../../interactive-dispatch-DqMu1xff.js";
import { t as collectDiscordSecurityAuditFindings } from "../../security-audit-C7EodjLb.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-zIIuuHe8.js";
import { n as secretTargetRegistryEntries, t as collectRuntimeConfigAssignments } from "../../secret-config-contract-BFLFSMPY.js";
import { n as unsupportedSecretRefSurfacePatterns, t as collectUnsupportedSecretRefConfigCandidates } from "../../security-contract-cjeE-m31.js";

//#region extensions/discord/src/session-contract.d.ts
declare function deriveLegacySessionChatType(sessionKey: string): "channel" | undefined;
//#endregion
export { type DiscordInteractiveHandlerContext, type DiscordInteractiveHandlerRegistration, collectDiscordSecurityAuditFindings, collectRuntimeConfigAssignments, collectUnsupportedSecretRefConfigCandidates, createThreadBindingManager, deriveLegacySessionChatType, __testing as discordThreadBindingTesting, legacyConfigRules, listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig, normalizeCompatibilityConfig, secretTargetRegistryEntries, unsupportedSecretRefSurfacePatterns };