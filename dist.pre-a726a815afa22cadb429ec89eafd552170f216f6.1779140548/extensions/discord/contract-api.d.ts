import { i as testing, n as createThreadBindingManager } from "../../thread-bindings.manager-DZtGJf3L.js";
import { n as listDiscordDirectoryPeersFromConfig, t as listDiscordDirectoryGroupsFromConfig } from "../../directory-config-TQye_zvY.js";
import { n as DiscordInteractiveHandlerRegistration, t as DiscordInteractiveHandlerContext } from "../../interactive-dispatch-CbgaPtlE.js";
import { t as collectDiscordSecurityAuditFindings } from "../../security-audit-D9Wiv68e.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-k9WT5GtF.js";
import { n as secretTargetRegistryEntries, t as collectRuntimeConfigAssignments } from "../../secret-config-contract-BI3XqJkZ.js";
import { n as unsupportedSecretRefSurfacePatterns, t as collectUnsupportedSecretRefConfigCandidates } from "../../security-contract-CyXxiAGC.js";

//#region extensions/discord/src/session-contract.d.ts
declare function deriveLegacySessionChatType(sessionKey: string): "channel" | undefined;
//#endregion
export { type DiscordInteractiveHandlerContext, type DiscordInteractiveHandlerRegistration, collectDiscordSecurityAuditFindings, collectRuntimeConfigAssignments, collectUnsupportedSecretRefConfigCandidates, createThreadBindingManager, deriveLegacySessionChatType, testing as discordThreadBindingTesting, legacyConfigRules, listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig, normalizeCompatibilityConfig, secretTargetRegistryEntries, unsupportedSecretRefSurfacePatterns };