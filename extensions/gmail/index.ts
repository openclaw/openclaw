import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";

export default definePluginEntry({
  id: "gmail",
  name: "Gmail Pub/Sub",
  description: "Run and renew a Gog Gmail Pub/Sub watcher.",
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    let stop: (() => Promise<void>) | undefined;
    api.registerService({
      id: "gmail-watch",
      apiVersion: 2,
      reload: {
        configPrefixes: [
          "hooks.enabled",
          "hooks.gmail",
          "hooks.path",
          "hooks.token",
          "gateway.port",
        ],
      },
      start(context) {
        if (
          context.scheduler.signal.aborted ||
          !context.config.hooks?.enabled ||
          !context.config.hooks.gmail?.account ||
          isTruthyEnvValue(process.env.OPENCLAW_SKIP_GMAIL_WATCHER)
        ) {
          return;
        }
        // The Google watch registration is network I/O. Let the service start
        // without blocking Gateway readiness, and join this work on stop.
        context.scheduler.schedule({
          id: "start",
          delayMs: 0,
          async run() {
            const { startGmailWatcher, stopGmailWatcher } = await import("./src/gmail-watcher.js");
            if (context.scheduler.signal.aborted) {
              return;
            }
            stop = stopGmailWatcher;
            try {
              const result = await startGmailWatcher(context.config, {
                signal: context.scheduler.signal,
                scheduler: context.scheduler,
              });
              if (!result.started && !context.scheduler.signal.aborted) {
                context.logger.warn("Gmail watcher not started: " + result.reason);
              }
            } catch (error) {
              context.serviceHealth?.reportFailure(error);
              context.logger.error("Gmail watcher failed to start: " + String(error));
            }
          },
        });
      },
      async stop() {
        const cleanup = stop;
        stop = undefined;
        await cleanup?.();
      },
    });
  },
});
