import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import { cleanupDiscordProviderStartup } from "./provider.cleanup.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

describe("cleanupDiscordProviderStartup", () => {
  it("joins listener and binding work when message-handler cleanup fails", async () => {
    const ready = createDeferred<void>();
    const entered = createDeferred<void>();
    const bindingReady = createDeferred<void>();
    const bindingEntered = createDeferred<void>();
    const manager = createNoopThreadBindingManager();
    const failure = new Error("message-handler cleanup failed");
    let settled = false;
    const cleanup = cleanupDiscordProviderStartup({
      stopMonitorListeners: () => {
        entered.resolve();
        return ready.promise;
      },
      deactivateMessageHandler: async () => {
        throw failure;
      },
      lifecycleStarted: false,
      threadBindings: {
        ...manager,
        stop: async () => {
          bindingEntered.resolve();
          await bindingReady.promise;
          await manager.stop();
        },
      },
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
      ready.resolve();
      expect(
        await Promise.race([
          bindingEntered.promise.then(() => "binding-stop"),
          cleanup.then(() => "completed"),
        ]),
      ).toBe("binding-stop");
      expect(settled).toBe(false);
    } finally {
      ready.resolve();
      bindingReady.resolve();
      await cleanup;
      await manager.stop();
    }
    expect(await cleanup).toBe(failure);
  });
});
