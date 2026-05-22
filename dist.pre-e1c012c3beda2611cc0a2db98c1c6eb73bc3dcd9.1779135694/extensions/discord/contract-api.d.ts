import { i as testing, n as createThreadBindingManager } from "../../thread-bindings.manager-DrzJjLmc.js";
import { n as listDiscordDirectoryPeersFromConfig, t as listDiscordDirectoryGroupsFromConfig } from "../../directory-config-BAp5r2Cu.js";
import { n as DiscordInteractiveHandlerRegistration, t as DiscordInteractiveHandlerContext } from "../../interactive-dispatch-CFsXV3aU.js";
import { t as collectDiscordSecurityAuditFindings } from "../../security-audit-B7VVva47.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-Ct8dJ4be.js";
import { n as secretTargetRegistryEntries, t as collectRuntimeConfigAssignments } from "../../secret-config-contract-BvWK6sVJ.js";
import { n as unsupportedSecretRefSurfacePatterns, t as collectUnsupportedSecretRefConfigCandidates } from "../../security-contract-JOQtfoFR.js";

//#region extensions/discord/src/session-contract.d.ts
declare function deriveLegacySessionChatType(sessionKey: string): "channel" | undefined;
//#endregion
export { type DiscordInteractiveHandlerContext, type DiscordInteractiveHandlerRegistration, collectDiscordSecurityAuditFindings, collectRuntimeConfigAssignments, collectUnsupportedSecretRefConfigCandidates, createThreadBindingManager, deriveLegacySessionChatType, testing as discordThreadBindingTesting, legacyConfigRules, listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig, normalizeCompatibilityConfig, secretTargetRegistryEntries, unsupportedSecretRefSurfacePatterns };