import { a as normalizeTelegramCommandName, i as normalizeTelegramCommandDescription, o as resolveTelegramCustomCommands, t as TELEGRAM_COMMAND_NAME_PATTERN } from "../../command-config-DxymjVNM.js";
import { o as parseTelegramTopicConversation } from "../../runtime-api-Zxj3dKD1.js";
import { r as resetTelegramThreadBindingsForTests, t as createTelegramThreadBindingManager } from "../../thread-bindings-GG1iDAoq.js";
import { f as mergeTelegramAccountConfig } from "../../accounts-BXd9oFDv.js";
import { i as buildTelegramModelsProviderChannelData, n as TelegramInteractiveHandlerRegistration, r as buildCommandsPaginationKeyboard, t as TelegramInteractiveHandlerContext } from "../../interactive-dispatch-BcAjPbeo.js";
import { n as listTelegramDirectoryPeersFromConfig, t as listTelegramDirectoryGroupsFromConfig } from "../../directory-config-A7wtB2j4.js";
import { t as collectTelegramSecurityAuditFindings } from "../../security-audit-nVSuJbd0.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-UMzI9Jb1.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-C9XS15N9.js";

//#region extensions/telegram/src/setup-contract.d.ts
declare const singleAccountKeysToMove: string[];
//#endregion
export { TELEGRAM_COMMAND_NAME_PATTERN, type TelegramInteractiveHandlerContext, type TelegramInteractiveHandlerRegistration, buildCommandsPaginationKeyboard, buildTelegramModelsProviderChannelData, collectRuntimeConfigAssignments, collectTelegramSecurityAuditFindings, createTelegramThreadBindingManager, legacyConfigRules, listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig, mergeTelegramAccountConfig, normalizeCompatibilityConfig, normalizeTelegramCommandDescription, normalizeTelegramCommandName, parseTelegramTopicConversation, resetTelegramThreadBindingsForTests, resolveTelegramCustomCommands, secretTargetRegistryEntries, singleAccountKeysToMove };