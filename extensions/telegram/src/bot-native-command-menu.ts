import { createHash } from "node:crypto";
import type { Bot } from "grammy";
import type { LanguageCode } from "grammy/types";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  asOptionalObjectRecord,
  normalizeOptionalString,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateCodePoints } from "openclaw/plugin-sdk/text-utility-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  enqueueTelegramMenuSync,
  getProcessKnownTelegramMenuLocales,
  normalizeTelegramMenuLanguageCode,
  persistTelegramMenuLocaleLedger,
  readTelegramMenuLocaleLedger,
  resolveTelegramMenuRemoteOwner,
} from "./bot-native-command-menu-state.js";
import { normalizeTelegramCommandName, TELEGRAM_COMMAND_NAME_PATTERN } from "./command-config.js";

const TELEGRAM_MAX_COMMANDS = 100;
const TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET = 5700;
const TELEGRAM_COMMAND_RETRY_RATIO = 0.8;
const TELEGRAM_MAX_COMMAND_DESCRIPTION_LENGTH = 256;
const TELEGRAM_MENU_RESULT_CACHE_MAX = 128;

export type TelegramMenuCommand = {
  command: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  isAlias?: boolean;
  isSkill?: boolean;
};

type TelegramPluginCommandSpec = {
  name: unknown;
  description: unknown;
  descriptionLocalizations?: Record<string, string>;
};

type TelegramSelectedPluginMenuCommand<TSpec extends TelegramPluginCommandSpec> =
  TelegramMenuCommand & { spec: TSpec };

const TELEGRAM_COMMAND_MENU_SCOPES = [undefined, "all_group_chats"] as const;

// Successful command hashes stay process-local so restarts always republish.
const syncedCommandHashes = new Map<string, string>();
const cappedTelegramMenuCache = new Map<
  string,
  ReturnType<typeof buildUncachedCappedTelegramMenuCommands>
>();

function countTelegramCommandText(value: string): number {
  return Array.from(value).length;
}

function truncateTelegramCommandText(value: string, maxLength: number): string {
  const prefix = truncateCodePoints(value, maxLength);
  if (prefix === value) {
    return prefix;
  }
  return maxLength > 1 ? `${truncateCodePoints(prefix, maxLength - 1)}…` : prefix;
}

function fitTelegramCommandsWithinTextBudget(commands: TelegramMenuCommand[]): {
  commands: TelegramMenuCommand[];
  descriptionTrimmed: boolean;
  textBudgetDropCount: number;
} {
  let commandCount = 0;
  let commandNameChars = 0;
  for (const { command } of commands) {
    const nameChars = countTelegramCommandText(command);
    if (commandNameChars + nameChars + commandCount + 1 > TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET) {
      break;
    }
    commandNameChars += nameChars;
    commandCount += 1;
  }
  const descriptionCap = Math.min(
    TELEGRAM_MAX_COMMAND_DESCRIPTION_LENGTH,
    Math.floor((TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET - commandNameChars) / commandCount),
  );
  let descriptionTrimmed = false;
  const fittedCommands = commands.slice(0, commandCount).map((command) => {
    const description = truncateTelegramCommandText(command.description, descriptionCap);
    if (description !== command.description) {
      descriptionTrimmed = true;
      return Object.assign({}, command, { description });
    }
    return command;
  });
  return {
    commands: fittedCommands,
    descriptionTrimmed,
    textBudgetDropCount: commands.length - fittedCommands.length,
  };
}

function isBotCommandsTooMuchError(err: unknown): boolean {
  const pattern = /\bBOT_COMMANDS_TOO_MUCH\b/i;
  if (typeof err === "string") {
    return pattern.test(err);
  }
  const record = asOptionalObjectRecord(err);
  return (["description", "message"] as const).some((key) => {
    const text = record && key in record ? readStringField(record, key) : undefined;
    return text !== undefined && pattern.test(text);
  });
}

export function buildPluginTelegramMenuCommands<TSpec extends TelegramPluginCommandSpec>(params: {
  specs: readonly TSpec[];
  existingCommands: Set<string>;
}): {
  commands: TelegramMenuCommand[];
  selectedCommands: TelegramSelectedPluginMenuCommand<TSpec>[];
  issues: string[];
} {
  const { specs, existingCommands } = params;
  const selectedCommands: TelegramSelectedPluginMenuCommand<TSpec>[] = [];
  const issues: string[] = [];
  const pluginCommandNames = new Set<string>();

  // Settle normalized collision ownership before display priority so discovery order cannot win.
  const sortedSpecs = specs
    .map((spec) => {
      const rawName = typeof spec.name === "string" ? spec.name : "";
      return {
        spec,
        rawName,
        normalized: normalizeTelegramCommandName(rawName),
      };
    })
    .toSorted((a, b) => {
      if (a.normalized !== b.normalized) {
        return a.normalized < b.normalized ? -1 : 1;
      }
      const aExact = a.rawName.trim().toLowerCase() === a.normalized;
      const bExact = b.rawName.trim().toLowerCase() === b.normalized;
      if (aExact !== bExact) {
        return aExact ? -1 : 1;
      }
      // Plugin registration rejects duplicate exact invocation keys, so equal raw names
      // cannot represent distinct production owners; transformed collisions settle above.
      return a.rawName < b.rawName ? -1 : a.rawName > b.rawName ? 1 : 0;
    });

  for (const { spec, rawName, normalized } of sortedSpecs) {
    if (!normalized || !TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      const invalidName = rawName.trim() ? rawName : "<unknown>";
      issues.push(
        `Plugin command "/${invalidName}" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).`,
      );
      continue;
    }
    const description = normalizeOptionalString(spec.description) ?? "";
    if (!description) {
      issues.push(`Plugin command "/${normalized}" is missing a description.`);
      continue;
    }
    if (existingCommands.has(normalized)) {
      if (pluginCommandNames.has(normalized)) {
        issues.push(`Plugin command "/${normalized}" is duplicated.`);
      } else {
        issues.push(`Plugin command "/${normalized}" conflicts with an existing Telegram command.`);
      }
      continue;
    }
    pluginCommandNames.add(normalized);
    existingCommands.add(normalized);
    const menuCommand: TelegramSelectedPluginMenuCommand<TSpec> = {
      command: normalized,
      description,
      spec,
    };
    if (spec.descriptionLocalizations) {
      menuCommand.descriptionLocalizations = spec.descriptionLocalizations;
    }
    selectedCommands.push(menuCommand);
  }

  const commands = selectedCommands.map(({ spec: _spec, ...command }) => command);
  return { commands, selectedCommands, issues };
}

export function buildCappedTelegramMenuCommands(
  allCommands: TelegramMenuCommand[],
): ReturnType<typeof buildUncachedCappedTelegramMenuCommands> {
  const cacheKey = hashCommandList(allCommands, true);
  const cached = cappedTelegramMenuCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const result = buildUncachedCappedTelegramMenuCommands(allCommands);
  cappedTelegramMenuCache.set(cacheKey, result);
  pruneMapToMaxSize(cappedTelegramMenuCache, TELEGRAM_MENU_RESULT_CACHE_MAX);
  return result;
}

function buildDirectSkillFallbackCommands(commands: TelegramMenuCommand[]): TelegramMenuCommand[] {
  const fallback = commands.find((command) => command.command === "skill" && !command.isSkill);
  const remaining = commands.filter((command) => !command.isSkill && command !== fallback);
  return fallback ? [fallback, ...remaining] : remaining;
}

function buildUncachedCappedTelegramMenuCommands(allCommands: TelegramMenuCommand[]): {
  commandsToRegister: TelegramMenuCommand[];
  totalCommands: number;
  maxCommands: number;
  overflowCount: number;
  maxTotalChars: number;
  descriptionTrimmed: boolean;
  textBudgetDropCount: number;
  skillCommandsOmitted: boolean;
} {
  const maxCommands = TELEGRAM_MAX_COMMANDS;
  const maxTotalChars = TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET;
  const fitCommands = (commands: TelegramMenuCommand[]) => {
    const cappedCommands = commands.slice(0, maxCommands);
    const needsFitting =
      cappedCommands.some(
        (command) =>
          countTelegramCommandText(command.description) > TELEGRAM_MAX_COMMAND_DESCRIPTION_LENGTH,
      ) ||
      cappedCommands.reduce(
        (total, { command, description }) =>
          total + countTelegramCommandText(command) + countTelegramCommandText(description),
        0,
      ) > maxTotalChars;
    return needsFitting
      ? fitTelegramCommandsWithinTextBudget(cappedCommands)
      : { commands: cappedCommands, descriptionTrimmed: false, textBudgetDropCount: 0 };
  };
  let effectiveCommands = allCommands;
  let fitted = fitCommands(allCommands);
  // Direct skill menu entries are all-or-none; fallback keeps canonical /skill visible first.
  const skillCommandCount = allCommands.filter((command) => command.isSkill).length;
  const skillCommandsOmitted =
    skillCommandCount > 0 &&
    fitted.commands.filter((command) => command.isSkill).length < skillCommandCount;
  if (skillCommandsOmitted) {
    effectiveCommands = buildDirectSkillFallbackCommands(allCommands);
    fitted = fitCommands(effectiveCommands);
  }
  const totalCommands = effectiveCommands.length;
  return {
    commandsToRegister: fitted.commands,
    totalCommands,
    maxCommands,
    overflowCount: Math.max(0, totalCommands - maxCommands),
    maxTotalChars,
    descriptionTrimmed: fitted.descriptionTrimmed,
    textBudgetDropCount: fitted.textBudgetDropCount,
    skillCommandsOmitted,
  };
}

function hashCommandList(commands: TelegramMenuCommand[], capped = false): string {
  const digest = createHash("sha256");
  const addField = (value: string) => {
    digest.update(String(value.length));
    digest.update(":");
    digest.update(value);
  };
  const header = capped
    ? [TELEGRAM_MAX_COMMANDS, TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET]
    : [commands.length];
  for (const value of header) {
    addField(String(value));
  }
  for (const command of commands) {
    addField(command.command);
    addField(command.description);
    // Capped-menu caches also distinguish flags that affect which commands survive.
    if (capped) {
      addField(command.isAlias ? "1" : "0");
      addField(command.isSkill ? "1" : "0");
    }
    const localizations = buildEffectiveTelegramCommandLocalizations(
      command.descriptionLocalizations,
    );
    addField(String(localizations.length));
    for (const [locale, description] of localizations) {
      addField(locale);
      addField(description);
    }
  }
  return digest.digest("hex").slice(0, 16);
}

function reduceTelegramMenuCommands(
  commands: TelegramMenuCommand[],
  maxCommands: number,
): TelegramMenuCommand[] {
  const reduced = commands.slice(0, maxCommands);
  const skillCommandCount = commands.filter((command) => command.isSkill).length;
  const reducedSkillCommandCount = reduced.filter((command) => command.isSkill).length;
  return reducedSkillCommandCount < skillCommandCount
    ? buildDirectSkillFallbackCommands(commands).slice(0, maxCommands)
    : reduced;
}

function buildEffectiveTelegramCommandLocalizations(
  localizations: Record<string, string> | undefined,
  unsupportedLanguageCodes?: Set<string>,
): Array<[LanguageCode, string]> {
  const effective = new Map<LanguageCode, string>();
  for (const [rawLanguageCode, rawDescription] of Object.entries(localizations ?? {})) {
    const languageCode = normalizeTelegramMenuLanguageCode(rawLanguageCode);
    const description = normalizeOptionalString(rawDescription);
    if (!description) {
      continue;
    }
    if (!languageCode) {
      unsupportedLanguageCodes?.add(rawLanguageCode);
    } else if (!effective.has(languageCode)) {
      effective.set(languageCode, description);
    }
  }
  return [...effective.entries()].toSorted(([a], [b]) => a.localeCompare(b));
}

function buildLocalizedCommandVariants(commands: TelegramMenuCommand[]): {
  variants: Array<{ languageCode: LanguageCode; commands: TelegramMenuCommand[] }>;
  unsupportedLanguageCodes: string[];
} {
  const locales = new Set<LanguageCode>();
  const unsupportedLanguageCodes = new Set<string>();
  const commandsWithLocalizations = commands.map((command) => {
    const localizations = new Map(
      buildEffectiveTelegramCommandLocalizations(
        command.descriptionLocalizations,
        unsupportedLanguageCodes,
      ),
    );
    for (const languageCode of localizations.keys()) {
      locales.add(languageCode);
    }
    return { command, localizations };
  });
  const variants = [...locales].toSorted().map((languageCode) => {
    const localizedCommands = commandsWithLocalizations.map(({ command, localizations }) =>
      Object.assign({}, command, {
        description: localizations.get(languageCode) ?? command.description,
      }),
    );
    return {
      languageCode,
      commands: buildCappedTelegramMenuCommands(localizedCommands).commandsToRegister,
    };
  });
  return {
    variants,
    unsupportedLanguageCodes: [...unsupportedLanguageCodes].toSorted(),
  };
}

async function applyTelegramMenuCommandsForScopes(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  commands?: TelegramMenuCommand[];
  languageCode?: LanguageCode;
  shouldLog?: (err: unknown) => boolean;
}): Promise<boolean> {
  const { bot, runtime, languageCode, shouldLog } = params;
  const commands = params.commands?.map(({ command, description }) => ({ command, description }));
  const operation = commands ? "setMyCommands" : "deleteMyCommands";
  let allCleared = true;
  for (const scope of TELEGRAM_COMMAND_MENU_SCOPES) {
    const options =
      scope || languageCode
        ? {
            ...(scope ? { scope: { type: scope } } : {}),
            ...(languageCode ? { language_code: languageCode } : {}),
          }
        : undefined;
    const scopedOperation = scope ? `${operation}(${scope})` : operation;
    const task = withTelegramApiErrorLogging({
      operation: languageCode ? `${scopedOperation}(${languageCode})` : scopedOperation,
      runtime,
      shouldLog,
      fn: () => {
        if (commands) {
          return options
            ? bot.api.setMyCommands(commands, options)
            : bot.api.setMyCommands(commands);
        }
        return options ? bot.api.deleteMyCommands(options) : bot.api.deleteMyCommands();
      },
    });
    if (commands) {
      await task;
    } else {
      // Cleanup attempts every scope; publication stops on the first failure.
      const cleared = await task.then(() => true).catch(() => false);
      allCleared &&= cleared;
    }
  }
  return allCleared;
}

export function syncTelegramMenuCommands(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  commandsToRegister: TelegramMenuCommand[];
  accountId?: string;
  botId?: number;
  botToken?: string;
}): void {
  const { bot, runtime, commandsToRegister } = params;
  const owner = resolveTelegramMenuRemoteOwner(params);
  const sync = async () => {
    // Skip sync if the command list hasn't changed since the last successful
    // sync. This prevents hitting Telegram's 429 rate limit when the gateway
    // is restarted several times in quick succession.
    // See: openclaw/openclaw#32017
    const currentHash = hashCommandList(commandsToRegister);
    const cachedHash = syncedCommandHashes.get(owner.hashKey);
    if (cachedHash === currentHash) {
      logVerbose("telegram: command menu unchanged; skipping sync");
      return;
    }

    const processLocales = getProcessKnownTelegramMenuLocales(owner.queueKey);
    const ledgerRead = owner.botId
      ? await readTelegramMenuLocaleLedger({ botId: owner.botId, runtime })
      : null;
    if (owner.botId && !ledgerRead) {
      return;
    }
    const trackedLocales = new Set<LanguageCode>([
      ...processLocales,
      ...(ledgerRead?.value?.languageCodes ?? []),
    ]);

    // Keep every exact scope/language clear ahead of publication.
    const neutralCleared = await applyTelegramMenuCommandsForScopes({ bot, runtime });
    const unclearedLocales = new Set<LanguageCode>();
    for (const languageCode of [...trackedLocales].toSorted()) {
      const cleared = await applyTelegramMenuCommandsForScopes({
        bot,
        runtime,
        languageCode,
      });
      if (!cleared) {
        unclearedLocales.add(languageCode);
      }
    }
    processLocales.clear();
    for (const languageCode of unclearedLocales) {
      processLocales.add(languageCode);
    }

    const persistLocales = async (desiredLocales: LanguageCode[]): Promise<boolean> => {
      const knownLocales = [...new Set([...unclearedLocales, ...desiredLocales])].toSorted();
      processLocales.clear();
      for (const languageCode of knownLocales) {
        processLocales.add(languageCode);
      }
      if (!owner.botId || !ledgerRead) {
        return true;
      }
      try {
        await persistTelegramMenuLocaleLedger({
          botId: owner.botId,
          read: ledgerRead,
          languageCodes: knownLocales,
        });
        return true;
      } catch (error) {
        runtime.error?.(
          `Telegram command menu locale ledger write failed for bot ${owner.botId}: ${String(error)}`,
        );
        return false;
      }
    };

    const recordSuccess = (ledgerComplete: boolean) => {
      if (neutralCleared && unclearedLocales.size === 0 && ledgerComplete) {
        syncedCommandHashes.set(owner.hashKey, currentHash);
      } else {
        runtime.log?.(
          "telegram: command menu cleanup incomplete; skipping success hash cache write",
        );
      }
    };

    if (commandsToRegister.length === 0) {
      recordSuccess(await persistLocales([]));
      return;
    }

    let retryCommands = commandsToRegister;
    const initialCommandCount = commandsToRegister.length;
    while (true) {
      try {
        await applyTelegramMenuCommandsForScopes({
          bot,
          runtime,
          commands: retryCommands,
          shouldLog: (err) => !isBotCommandsTooMuchError(err),
        });
        if (retryCommands.length < initialCommandCount) {
          runtime.log?.(
            `Telegram accepted ${retryCommands.length} commands after BOT_COMMANDS_TOO_MUCH ` +
              `(started with ${initialCommandCount}; omitted ${initialCommandCount - retryCommands.length}). ` +
              "Reduce plugin/skill/custom commands to expose more menu entries.",
          );
        }
        break;
      } catch (err) {
        if (!isBotCommandsTooMuchError(err)) {
          throw err;
        }
        const reducedCount = Math.floor(retryCommands.length * TELEGRAM_COMMAND_RETRY_RATIO);
        const nextCommands = reduceTelegramMenuCommands(commandsToRegister, reducedCount);
        if (reducedCount <= 0 || nextCommands.length === 0) {
          runtime.error?.(
            "Telegram rejected native command registration (BOT_COMMANDS_TOO_MUCH); leaving menu empty. Reduce commands or disable channels.telegram.commands.native.",
          );
          return;
        }
        runtime.log?.(
          `Telegram rejected ${retryCommands.length} commands (BOT_COMMANDS_TOO_MUCH); retrying with ${nextCommands.length}.`,
        );
        retryCommands = nextCommands;
      }
    }

    const { variants, unsupportedLanguageCodes } = buildLocalizedCommandVariants(retryCommands);
    if (unsupportedLanguageCodes.length > 0) {
      runtime.log?.(
        `Telegram command menu ignored unsupported description localization codes: ${unsupportedLanguageCodes.join(", ")}.`,
      );
    }

    const ledgerComplete = await persistLocales(variants.map((variant) => variant.languageCode));
    if (!ledgerComplete) {
      runtime.log?.(
        "telegram: localized command menu skipped because locale intent was not durably recorded",
      );
      return;
    }

    for (const variant of variants) {
      await applyTelegramMenuCommandsForScopes({
        bot,
        runtime,
        commands: variant.commands,
        languageCode: variant.languageCode,
      });
    }
    recordSuccess(ledgerComplete);
  };

  enqueueTelegramMenuSync({
    ownerKey: owner.queueKey,
    sync,
    onError: (error) => {
      runtime.error?.(`Telegram command sync failed: ${String(error)}`);
    },
  });
}
