import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
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

const { connectionOwnerMocks } = getConnectionControllerMocks();

let modules!: ControllerTestModules;
let controller!: InstanceType<ControllerTestModules["controller"]["WhatsAppConnectionController"]>;

describe("WhatsApp last-route write settlement", () => {
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

  function queueConnectedSocket(sock = createSocketWithTransportEmitter()) {
    modules.createWaSocketMock.mockResolvedValueOnce(sock as never);
    modules.waitForWaConnectionMock.mockResolvedValueOnce(undefined);
  }

  function open(connectionId: string) {
    return controller.openConnection({
      connectionId,
      createListener: async () => createListenerStub() as never,
    });
  }

  it.each(["reconnect", "shutdown"] as const)(
    "bounds %s teardown while a last-route write is stuck",
    async (operation) => {
      vi.useFakeTimers();
      const warn = vi.fn();
      const logger = vi.spyOn(runtimeEnv, "getChildLogger").mockReturnValue({ warn } as never);
      const write = Promise.withResolvers<void>();
      const firstSock = createSocketWithTransportEmitter();
      queueConnectedSocket(firstSock);
      const connection = await open("first");
      connection.backgroundTasks.add(write.promise);
      const replacement = createSocketWithTransportEmitter();
      if (operation === "reconnect") {
        queueConnectedSocket(replacement);
      }
      let finished = false;
      const teardown = (
        operation === "reconnect" ? open("replacement") : controller.shutdown()
      ).then(() => {
        finished = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(14_999);
        expect(finished).toBe(false);
        expect(firstSock.end).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(finished).toBe(true);
        expect(firstSock.end).toHaveBeenCalledOnce();
        expect(controller.getCurrentSock()).toBe(operation === "reconnect" ? replacement : null);
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        write.resolve();
        await teardown;
        logger.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("waits for a slow last-route write during shutdown", async () => {
    vi.useFakeTimers();
    const sock = createSocketWithTransportEmitter();
    queueConnectedSocket(sock);
    const connection = await open("slow-write");
    const write = Promise.withResolvers<void>();
    connection.backgroundTasks.add(write.promise);
    const shutdown = controller.shutdown();
    try {
      await vi.advanceTimersByTimeAsync(200);
      expect(sock.end).not.toHaveBeenCalled();
      write.resolve();
      await shutdown;
      expect(sock.end).toHaveBeenCalledOnce();
      expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
    } finally {
      write.resolve();
      await shutdown;
      vi.useRealTimers();
    }
  });
});
