import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createMatrixMonitorStatusController } from "./status.js";
import { createMatrixMonitorSyncLifecycle } from "./sync-lifecycle.js";

function createClientEmitter() {
  return new EventEmitter() as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    off: (event: string, listener: (...args: unknown[]) => void) => unknown;
    emit: (event: string, ...args: unknown[]) => boolean;
  };
}

describe("createMatrixMonitorSyncLifecycle", () => {
  it("rejects the channel wait on unexpected sync errors", async () => {
    const client = createClientEmitter();
    const setStatus = vi.fn();
    const lifecycle = createMatrixMonitorSyncLifecycle({
      client: client as never,
      statusController: createMatrixMonitorStatusController({
        accountId: "default",
        statusSink: setStatus,
      }),
    });

    const waitPromise = lifecycle.waitForFatalStop();
    client.emit("sync.unexpected_error", new Error("sync exploded"));

    await expect(waitPromise).rejects.toThrow("sync exploded");
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        healthState: "error",
        lastError: "sync exploded",
      }),
    );
  });

  it("ignores STOPPED emitted during intentional shutdown", async () => {
    const client = createClientEmitter();
    const setStatus = vi.fn();
    let stopping = false;
    const lifecycle = createMatrixMonitorSyncLifecycle({
      client: client as never,
      statusController: createMatrixMonitorStatusController({
        accountId: "default",
        statusSink: setStatus,
      }),
      isStopping: () => stopping,
    });

    const waitPromise = lifecycle.waitForFatalStop();
    stopping = true;
    client.emit("sync.state", "STOPPED", "SYNCING", undefined);
    lifecycle.dispose();

    await expect(waitPromise).resolves.toBeUndefined();
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        healthState: "stopped",
      }),
    );
  });

  it("ignores unexpected sync errors emitted during intentional shutdown", async () => {
    const client = createClientEmitter();
    const setStatus = vi.fn();
    let stopping = false;
    const lifecycle = createMatrixMonitorSyncLifecycle({
      client: client as never,
      statusController: createMatrixMonitorStatusController({
        accountId: "default",
        statusSink: setStatus,
      }),
      isStopping: () => stopping,
    });

    const waitPromise = lifecycle.waitForFatalStop();
    stopping = true;
    client.emit("sync.unexpected_error", new Error("shutdown noise"));
    lifecycle.dispose();

    await expect(waitPromise).resolves.toBeUndefined();
    expect(setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        healthState: "error",
      }),
    );
  });

  it("rejects a second concurrent fatal-stop waiter", async () => {
    const client = createClientEmitter();
    const lifecycle = createMatrixMonitorSyncLifecycle({
      client: client as never,
      statusController: createMatrixMonitorStatusController({
        accountId: "default",
      }),
    });

    const firstWait = lifecycle.waitForFatalStop();

    await expect(lifecycle.waitForFatalStop()).rejects.toThrow(
      "Matrix fatal-stop wait already in progress",
    );

    lifecycle.dispose();
    await expect(firstWait).resolves.toBeUndefined();
  });
});
