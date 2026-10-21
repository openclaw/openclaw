import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime-api.js";
import { setMatrixRuntime } from "../../runtime.js";
import { MatrixClient } from "../sdk.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { createRetirementTaskRunner, useRetirementServer } from "./retirement.test-support.js";

class DrainHoldClient extends MatrixClient {
  holdNextDrain(): { entered: Promise<void>; release: () => void } {
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    const store = this.recoveryKeyStore;
    const original = store.drainPendingPersistence.bind(store);
    store.drainPendingPersistence = async () => {
      store.drainPendingPersistence = original;
      entered.resolve();
      await released.promise;
      await original();
    };
    return { entered: entered.promise, release: () => released.resolve() };
  }
}

describe("Matrix auto-join retirement", () => {
  const { seen, start } = useRetirementServer({
    room_id: "!room:example.org",
    displayname: "active",
  });

  it("does not post a join that is waiting on recovery-key persistence when the monitor retires", async () => {
    setMatrixRuntime({
      logging: {
        shouldLogVerbose: () => false,
        getChildLogger: () => ({ warn: () => {} }),
      },
    } as never);
    const { client: matrixClient } = await start(DrainHoldClient);
    const hold = matrixClient.holdNextDrain();
    const owner = createRetirementTaskRunner();
    const sibling = createRetirementTaskRunner();
    registerMatrixAutoJoin({
      client: matrixClient,
      accountConfig: { autoJoin: "always" },
      runtime: { log: () => {}, error: () => {} } as RuntimeEnv,
      runDetachedTask: owner.runDetachedTask,
    });
    (
      matrixClient as unknown as {
        emitter: { emit: (event: string, roomId: string, raw: unknown) => void };
      }
    ).emitter.emit("room.invite", "!room:example.org", {});
    await hold.entered;
    vi.useFakeTimers();
    const idle = owner.waitForIdle();
    await vi.advanceTimersByTimeAsync(30_000);
    await idle;
    vi.useRealTimers();
    hold.release();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    await sibling.runDetachedTask("profile", async () => {
      await matrixClient.getUserProfile("@active:example.org");
    });
    expect(seen.some((line) => line.includes("/profile/"))).toBe(true);
    expect(seen.some((line) => line.includes("/join/"))).toBe(false);
    owner.close();
    sibling.close();
  });
});
