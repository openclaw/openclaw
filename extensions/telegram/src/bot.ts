// Telegram plugin module implements bot behavior.
<<<<<<< HEAD
=======
import { getSessionEntry, listSessionEntries } from "openclaw/plugin-sdk/session-store-runtime";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import {
  createTelegramBotCore,
  getTelegramSequentialKey,
  setTelegramBotRuntimeForTest,
} from "./bot-core.js";
<<<<<<< HEAD
import { defaultTelegramBotDeps } from "./bot-deps.js";
=======
import { defaultTelegramBotDeps, type TelegramBotDeps } from "./bot-deps.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { TelegramBotOptions } from "./bot.types.js";

export type { TelegramBotOptions } from "./bot.types.js";

export { getTelegramSequentialKey, setTelegramBotRuntimeForTest };

export function createTelegramBot(
  opts: TelegramBotOptions,
): ReturnType<typeof createTelegramBotCore> {
  return createTelegramBotCore({
    ...opts,
<<<<<<< HEAD
    telegramDeps: opts.telegramDeps ?? defaultTelegramBotDeps,
  });
}
=======
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
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
