// Whatsapp tests cover Gateway restarts after credential persistence fails to drain.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { resolveWhatsAppAuthDir } from "./accounts.js";
import {
  createScriptedWebListenerFactory,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  startWebAutoReplyMonitor,
} from "./auto-reply.test-harness.js";
import { enqueueCredsSave } from "./creds-persistence.js";

installWebAutoReplyTestHomeHooks();

describe("web auto-reply credential recovery (#166544)", () => {
  installWebAutoReplyUnitTestHooks();

  let monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;
  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
  });

  it(
    "reconnects a restarted account once the stuck credential write finishes",
    { timeout: 30_000 },
    async () => {
      vi.useFakeTimers();
      const authDir = resolveWhatsAppAuthDir({ cfg: {}, accountId: "default" }).authDir;
      const sleep = vi.fn(async () => {});

      const first = createScriptedWebListenerFactory();
      const firstMonitor = startWebAutoReplyMonitor({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory: first.listenerFactory,
        sleep,
      });
      await vi.waitFor(() => expect(first.getListenerCount()).toBe(1));

      // A credential write that outlives the 15s shutdown drain, as in the issue.
      const storedCreds = createDeferred<void>();
      enqueueCredsSave(
        authDir,
        () => storedCreds.promise,
        () => {},
      );

      // Health restart: the monitor aborts, shutdown cannot drain, ownership stays held.
      let firstError: unknown;
      firstMonitor.run.catch((error: unknown) => {
        firstError = error;
      });
      firstMonitor.controller.abort();
      // Shutdown reaches the 15s drain wait after real file I/O; step fake time until it fires.
      await vi.waitFor(
        async () => {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(firstError).toBeDefined();
        },
        { timeout: 20_000, interval: 5 },
      );
      expect(String(firstError)).toMatch(/did not drain/);

      // The replacement start queues behind the retained owner instead of looping on it.
      const second = createScriptedWebListenerFactory();
      const secondMonitor = startWebAutoReplyMonitor({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory: second.listenerFactory,
        sleep,
      });
      let secondError: Error | undefined;
      secondMonitor.run.catch((error: unknown) => {
        secondError =
          error instanceof Error ? error : new Error("monitor failed", { cause: error });
      });
      storedCreds.resolve();

      // The owner wait is 150s per incumbent; surface its busy error if the retry never frees it.
      await vi.waitFor(
        async () => {
          await vi.advanceTimersByTimeAsync(5_000);
          if (secondError) {
            throw secondError;
          }
          expect(second.getListenerCount()).toBe(1);
        },
        { timeout: 20_000, interval: 5 },
      );
      secondMonitor.controller.abort();
      await secondMonitor.run;
    },
  );
});
