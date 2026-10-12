import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveImapConfig } from "./src/config.js";
import { createImapState } from "./src/state.js";
import { ImapAccountWatcher } from "./src/watcher.js";

const imapConfigSchema = { parse: resolveImapConfig };

export default definePluginEntry({
  id: "imap",
  name: "IMAP email trigger",
  description: "Dispatch authenticated incoming IMAP email to isolated agent sessions.",
  configSchema: imapConfigSchema,
  register(api: OpenClawPluginApi) {
    if (api.registrationMode !== "full") {
      return;
    }
    let watchers: ImapAccountWatcher[] = [];
    api.registerService({
      id: "imap-watch",
      apiVersion: 2,
      async start(context: OpenClawPluginServiceContextV2) {
        const previous = watchers;
        watchers = [];
        await Promise.all(previous.map((watcher) => watcher.stop()));
        if (context.scheduler.signal.aborted) {
          return;
        }
        const config = imapConfigSchema.parse(api.pluginConfig, (accountId) => {
          context.logger.warn(
            `imap: account=${accountId} unavailable; resolve its IMAP password and reload configuration`,
          );
        });
        const accounts = Object.entries(config.accounts);
        if (!accounts.length) {
          context.logger.warn(
            "imap: no accounts configured; add plugins.entries.imap.config.accounts",
          );
          return;
        }
        const state = createImapState(api.runtime);
        watchers = accounts.map(
          ([accountId, account]) =>
            new ImapAccountWatcher({ accountId, account, runtime: api.runtime, state, context }),
        );
        for (const watcher of watchers) {
          watcher.start();
        }
      },
      async stop() {
        const active = watchers;
        watchers = [];
        await Promise.all(active.map((watcher) => watcher.stop()));
      },
    });
  },
});
