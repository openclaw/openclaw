import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import { cleanupDiscordProviderStartup } from "./provider.cleanup.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

describe("cleanupDiscordProviderStartup", () => {
  it.each([false, true])(
    "joins listener work when message-handler cleanup fails=%s",
    async (fails) => {
      const ready = createDeferred<void>();
      const entered = createDeferred<void>();
      const failure = new Error("message-handler cleanup failed");
      let settled = false;
      const cleanup = cleanupDiscordProviderStartup({
        stopMonitorListeners: () => {
          entered.resolve();
          return ready.promise;
        },
        deactivateMessageHandler: async () => {
          if (fails) {
            throw failure;
          }
        },
        lifecycleStarted: true,
        threadBindings: createNoopThreadBindingManager(),
        runtime: createRuntimeSpies(),
        gatewaySupervisor: { dispose: vi.fn() },
      }).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await entered.promise;
        await Promise.resolve();
        expect(settled).toBe(false);
      } finally {
        ready.resolve();
        await cleanup;
      }
      expect(await cleanup).toBe(fails ? failure : undefined);
    },
  );
});
