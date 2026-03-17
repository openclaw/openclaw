import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../../src/config/paths.js";
import {
  normalizeTelegramCommandName,
  TELEGRAM_COMMAND_NAME_PATTERN
} from "../../../src/config/telegram-custom-commands.js";
import { logVerbose } from "../../../src/globals.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
const TELEGRAM_MAX_COMMANDS = 100;
const TELEGRAM_COMMAND_RETRY_RATIO = 0.8;
function isBotCommandsTooMuchError(err) {
  if (!err) {
    return false;
  }
  const pattern = /\bBOT_COMMANDS_TOO_MUCH\b/i;
  if (typeof err === "string") {
    return pattern.test(err);
  }
  if (err instanceof Error) {
    if (pattern.test(err.message)) {
      return true;
    }
  }
  if (typeof err === "object") {
    const maybe = err;
    if (typeof maybe.description === "string" && pattern.test(maybe.description)) {
      return true;
    }
    if (typeof maybe.message === "string" && pattern.test(maybe.message)) {
      return true;
    }
  }
  return false;
}
function formatTelegramCommandRetrySuccessLog(params) {
  const omittedCount = Math.max(0, params.initialCount - params.acceptedCount);
  return `Telegram accepted ${params.acceptedCount} commands after BOT_COMMANDS_TOO_MUCH (started with ${params.initialCount}; omitted ${omittedCount}). Reduce plugin/skill/custom commands to expose more menu entries.`;
}
function buildPluginTelegramMenuCommands(params) {
  const { specs, existingCommands } = params;
  const commands = [];
  const issues = [];
  const pluginCommandNames = /* @__PURE__ */ new Set();
  for (const spec of specs) {
    const rawName = typeof spec.name === "string" ? spec.name : "";
    const normalized = normalizeTelegramCommandName(rawName);
    if (!normalized || !TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      const invalidName = rawName.trim() ? rawName : "<unknown>";
      issues.push(
        `Plugin command "/${invalidName}" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).`
      );
      continue;
    }
    const description = typeof spec.description === "string" ? spec.description.trim() : "";
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
    commands.push({ command: normalized, description });
  }
  return { commands, issues };
}
function buildCappedTelegramMenuCommands(params) {
  const { allCommands } = params;
  const maxCommands = params.maxCommands ?? TELEGRAM_MAX_COMMANDS;
  const totalCommands = allCommands.length;
  const overflowCount = Math.max(0, totalCommands - maxCommands);
  const commandsToRegister = allCommands.slice(0, maxCommands);
  return { commandsToRegister, totalCommands, maxCommands, overflowCount };
}
function hashCommandList(commands) {
  const sorted = [...commands].toSorted((a, b) => a.command.localeCompare(b.command));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}
function hashBotIdentity(botIdentity) {
  const normalized = botIdentity?.trim();
  if (!normalized) {
    return "no-bot";
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
function resolveCommandHashPath(accountId, botIdentity) {
  const stateDir = resolveStateDir(process.env, os.homedir);
  const normalizedAccount = accountId?.trim().replace(/[^a-z0-9._-]+/gi, "_") || "default";
  const botHash = hashBotIdentity(botIdentity);
  return path.join(stateDir, "telegram", `command-hash-${normalizedAccount}-${botHash}.txt`);
}
async function readCachedCommandHash(accountId, botIdentity) {
  try {
    return (await fs.readFile(resolveCommandHashPath(accountId, botIdentity), "utf-8")).trim();
  } catch {
    return null;
  }
}
async function writeCachedCommandHash(accountId, botIdentity, hash) {
  const filePath = resolveCommandHashPath(accountId, botIdentity);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, hash, "utf-8");
  } catch {
  }
}
function syncTelegramMenuCommands(params) {
  const { bot, runtime, commandsToRegister, accountId, botIdentity } = params;
  const sync = async () => {
    const currentHash = hashCommandList(commandsToRegister);
    const cachedHash = await readCachedCommandHash(accountId, botIdentity);
    if (cachedHash === currentHash) {
      logVerbose("telegram: command menu unchanged; skipping sync");
      return;
    }
    let deleteSucceeded = true;
    if (typeof bot.api.deleteMyCommands === "function") {
      deleteSucceeded = await withTelegramApiErrorLogging({
        operation: "deleteMyCommands",
        runtime,
        fn: () => bot.api.deleteMyCommands()
      }).then(() => true).catch(() => false);
    }
    if (commandsToRegister.length === 0) {
      if (!deleteSucceeded) {
        runtime.log?.("telegram: deleteMyCommands failed; skipping empty-menu hash cache write");
        return;
      }
      await writeCachedCommandHash(accountId, botIdentity, currentHash);
      return;
    }
    let retryCommands = commandsToRegister;
    const initialCommandCount = commandsToRegister.length;
    while (retryCommands.length > 0) {
      try {
        await withTelegramApiErrorLogging({
          operation: "setMyCommands",
          runtime,
          shouldLog: (err) => !isBotCommandsTooMuchError(err),
          fn: () => bot.api.setMyCommands(retryCommands)
        });
        if (retryCommands.length < initialCommandCount) {
          runtime.log?.(
            formatTelegramCommandRetrySuccessLog({
              initialCount: initialCommandCount,
              acceptedCount: retryCommands.length
            })
          );
        }
        await writeCachedCommandHash(accountId, botIdentity, currentHash);
        return;
      } catch (err) {
        if (!isBotCommandsTooMuchError(err)) {
          throw err;
        }
        const nextCount = Math.floor(retryCommands.length * TELEGRAM_COMMAND_RETRY_RATIO);
        const reducedCount = nextCount < retryCommands.length ? nextCount : retryCommands.length - 1;
        if (reducedCount <= 0) {
          runtime.error?.(
            "Telegram rejected native command registration (BOT_COMMANDS_TOO_MUCH); leaving menu empty. Reduce commands or disable channels.telegram.commands.native."
          );
          return;
        }
        runtime.log?.(
          `Telegram rejected ${retryCommands.length} commands (BOT_COMMANDS_TOO_MUCH); retrying with ${reducedCount}.`
        );
        retryCommands = retryCommands.slice(0, reducedCount);
      }
    }
  };
  void sync().catch((err) => {
    runtime.error?.(`Telegram command sync failed: ${String(err)}`);
  });
}
export {
  TELEGRAM_MAX_COMMANDS,
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  hashCommandList,
  syncTelegramMenuCommands
};
