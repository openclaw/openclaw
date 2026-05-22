import { a as normalizeTelegramCommandName, i as normalizeTelegramCommandDescription, o as resolveTelegramCustomCommands, t as TELEGRAM_COMMAND_NAME_PATTERN } from "../../command-config-B1CmnYTq.js";
import { o as parseTelegramTopicConversation } from "../../runtime-api-CbatG2hv.js";
import { r as resetTelegramThreadBindingsForTests, t as createTelegramThreadBindingManager } from "../../thread-bindings-DF4x8vTj.js";
import { f as mergeTelegramAccountConfig } from "../../accounts-CJRQ7Bsp.js";
import { i as buildTelegramModelsProviderChannelData, n as TelegramInteractiveHandlerRegistration, r as buildCommandsPaginationKeyboard, t as TelegramInteractiveHandlerContext } from "../../interactive-dispatch-By3Y9oBZ.js";
import { n as listTelegramDirectoryPeersFromConfig, t as listTelegramDirectoryGroupsFromConfig } from "../../directory-config-ByKmjJN2.js";
import { t as collectTelegramSecurityAuditFindings } from "../../security-audit-C3fKK4GF.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-BpWdqLCQ.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-D_R-ccnn.js";

//#region extensions/telegram/src/setup-contract.d.ts
declare const singleAccountKeysToMove: string[];
//#endregion
export { TELEGRAM_COMMAND_NAME_PATTERN, type TelegramInteractiveHandlerContext, type TelegramInteractiveHandlerRegistration, buildCommandsPaginationKeyboard, buildTelegramModelsProviderChannelData, collectRuntimeConfigAssignments, collectTelegramSecurityAuditFindings, createTelegramThreadBindingManager, legacyConfigRules, listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig, mergeTelegramAccountConfig, normalizeCompatibilityConfig, normalizeTelegramCommandDescription, normalizeTelegramCommandName, parseTelegramTopicConversation, resetTelegramThreadBindingsForTests, resolveTelegramCustomCommands, secretTargetRegistryEntries, singleAccountKeysToMove };