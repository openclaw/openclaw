import { a as normalizeTelegramCommandName, i as normalizeTelegramCommandDescription, o as resolveTelegramCustomCommands, t as TELEGRAM_COMMAND_NAME_PATTERN } from "../../command-config-B5uSKuEF.js";
import { o as parseTelegramTopicConversation } from "../../runtime-api-DQZanni9.js";
import { r as resetTelegramThreadBindingsForTests, t as createTelegramThreadBindingManager } from "../../thread-bindings-_TjnGr1k.js";
import { f as mergeTelegramAccountConfig } from "../../accounts-D4kQK2Wz.js";
import { i as buildTelegramModelsProviderChannelData, n as TelegramInteractiveHandlerRegistration, r as buildCommandsPaginationKeyboard, t as TelegramInteractiveHandlerContext } from "../../interactive-dispatch-Bk81ioRA.js";
import { n as listTelegramDirectoryPeersFromConfig, t as listTelegramDirectoryGroupsFromConfig } from "../../directory-config-CxQNGBS0.js";
import { t as collectTelegramSecurityAuditFindings } from "../../security-audit-BWfrfQvx.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-CYpG4azz.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-B8rORNMx.js";

//#region extensions/telegram/src/setup-contract.d.ts
declare const singleAccountKeysToMove: string[];
//#endregion
export { TELEGRAM_COMMAND_NAME_PATTERN, type TelegramInteractiveHandlerContext, type TelegramInteractiveHandlerRegistration, buildCommandsPaginationKeyboard, buildTelegramModelsProviderChannelData, collectRuntimeConfigAssignments, collectTelegramSecurityAuditFindings, createTelegramThreadBindingManager, legacyConfigRules, listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig, mergeTelegramAccountConfig, normalizeCompatibilityConfig, normalizeTelegramCommandDescription, normalizeTelegramCommandName, parseTelegramTopicConversation, resetTelegramThreadBindingsForTests, resolveTelegramCustomCommands, secretTargetRegistryEntries, singleAccountKeysToMove };