// Telegram plugin module implements bot behavior.
import { getSessionEntry, listSessionEntries } from "openclaw/plugin-sdk/session-store-runtime";
import {
  createTelegramBotCore,
  getTelegramSequentialKey,
  setTelegramBotRuntimeForTest,
} from "./bot-core.js";
import { defaultTelegramBotDeps, type TelegramBotDeps } from "./bot-deps.js";
import type { TelegramBotOptions } from "./bot.types.js";

export type { TelegramBotOptions } from "./bot.types.js";

export { getTelegramSequentialKey, setTelegramBotRuntimeForTest };

export function createTelegramBot(
  opts: TelegramBotOptions,
): ReturnType<typeof createTelegramBotCore> {
  return createTelegramBotCore({
    ...opts,
    telegramDeps: withTelegramSessionAccessorDeps(opts.telegramDeps ?? defaultTelegramBotDeps),
  });
}

function withTelegramSessionAccessorDeps(deps: TelegramBotDeps): TelegramBotDeps {
  if (!deps.loadSessionStore) {
    return {
      ...deps,
      getSessionEntry: deps.getSessionEntry ?? getSessionEntry,
      listSessionEntries: deps.listSessionEntries ?? listSessionEntries,
    };
  }

  const listInjectedEntries = (
    scope: Parameters<NonNullable<TelegramBotDeps["listSessionEntries"]>>[0] = {},
  ) => {
    const storePath =
      scope.storePath ?? deps.resolveStorePath(undefined, { agentId: scope.agentId });
    return Object.entries(deps.loadSessionStore?.(storePath) ?? {}).map(([sessionKey, entry]) => ({
      sessionKey,
      entry,
    }));
  };

  return {
    ...deps,
    // Existing Telegram tests and custom deps inject loadSessionStore; expose
    // the same data through the accessor seam consumed by migrated handlers.
    getSessionEntry:
      deps.getSessionEntry ??
      ((scope) =>
        listInjectedEntries(scope).find(({ sessionKey }) => sessionKey === scope.sessionKey)
          ?.entry),
    listSessionEntries: deps.listSessionEntries ?? listInjectedEntries,
  };
}
