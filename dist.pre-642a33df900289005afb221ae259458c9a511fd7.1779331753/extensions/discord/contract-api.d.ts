import { i as testing, n as createThreadBindingManager } from "../../thread-bindings.manager-B3PbD25l.js";
import { n as listDiscordDirectoryPeersFromConfig, t as listDiscordDirectoryGroupsFromConfig } from "../../directory-config-Bkv_pq_a.js";
import { n as DiscordInteractiveHandlerRegistration, t as DiscordInteractiveHandlerContext } from "../../interactive-dispatch-B3Cn1sRu.js";
import { t as collectDiscordSecurityAuditFindings } from "../../security-audit-CF8YB8ma.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-CWhiBnY6.js";
import { n as secretTargetRegistryEntries, t as collectRuntimeConfigAssignments } from "../../secret-config-contract-BF7u-lzp.js";
import { n as unsupportedSecretRefSurfacePatterns, t as collectUnsupportedSecretRefConfigCandidates } from "../../security-contract-JNbAKz8Y.js";

//#region extensions/discord/src/session-contract.d.ts
declare function deriveLegacySessionChatType(sessionKey: string): "channel" | undefined;
//#endregion
export { type DiscordInteractiveHandlerContext, type DiscordInteractiveHandlerRegistration, collectDiscordSecurityAuditFindings, collectRuntimeConfigAssignments, collectUnsupportedSecretRefConfigCandidates, createThreadBindingManager, deriveLegacySessionChatType, testing as discordThreadBindingTesting, legacyConfigRules, listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig, normalizeCompatibilityConfig, secretTargetRegistryEntries, unsupportedSecretRefSurfacePatterns };