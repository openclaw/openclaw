import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerTestModules } from "./connection-controller.test-helpers.js";
import {
  createListenerStub,
  createSocketWithTransportEmitter,
  createTestController,
  getConnectionControllerMocks,
  loadConnectionControllerTestModules,
  resetConnectionControllerTestMocks,
} from "./connection-controller.test-helpers.js";

const { runtimeContextMocks } = getConnectionControllerMocks();

let modules!: ControllerTestModules;
let controller!: InstanceType<ControllerTestModules["controller"]["WhatsAppConnectionController"]>;

describe("WhatsApp connection runtime context", () => {
  beforeAll(async () => {
    modules = await loadConnectionControllerTestModules();
  });

  beforeEach(() => {
    resetConnectionControllerTestMocks(modules);
    controller = createTestController(modules.controller.WhatsAppConnectionController);
  });

  afterEach(async () => {
    await controller.shutdown();
  });

  it("keeps the ready controller published while a different-auth replacement connects", async () => {
    const disposeRuntimeContext = vi.fn();
    runtimeContextMocks.register.mockReturnValueOnce({ dispose: disposeRuntimeContext });
    const liveController = createTestController(modules.controller.WhatsAppConnectionController);
    const liveListener = createListenerStub("live");
    modules.createWaSocketMock.mockResolvedValueOnce(createSocketWithTransportEmitter() as never);
    modules.waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    await liveController.openConnection({
      connectionId: "live-conn",
      createListener: async () => liveListener,
    });

    const replacement = createTestController(modules.controller.WhatsAppConnectionController, {
      authDir: "/tmp/wa-auth-2",
    });

    try {
      modules.createWaSocketMock.mockResolvedValueOnce(createSocketWithTransportEmitter() as never);
      modules.waitForWaConnectionMock.mockRejectedValueOnce(new Error("replacement failed"));

      await expect(
        replacement.openConnection({
          connectionId: "replacement-conn",
          createListener: async () => liveListener,
        }),
      ).rejects.toThrow("replacement failed");

      expect(runtimeContextMocks.register).toHaveBeenCalledTimes(3);
      expect(runtimeContextMocks.register).toHaveBeenLastCalledWith({
        channelRuntime: runtimeContextMocks.channelRuntime,
        channelId: "whatsapp",
        accountId: "work",
        capability: "connection-owner-pending",
        context: true,
        abortSignal: undefined,
      });
      const activeControllerRegistrations = runtimeContextMocks.register.mock.calls.filter(
        ([registration]) => registration.capability === "connection-controller",
      );
      expect(activeControllerRegistrations).toHaveLength(1);
      expect(activeControllerRegistrations[0]?.[0].context).toBe(liveController);
    } finally {
      await replacement.shutdown();
      await liveController.shutdown();
    }
    expect(disposeRuntimeContext).toHaveBeenCalledOnce();
  });
});
