import http from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime-api.js";
import { setMatrixRuntime } from "../../runtime.js";
import { MatrixClient } from "../sdk.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { createMatrixMonitorTaskRunner } from "./task-runner.js";

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
    return {
      entered: entered.promise,
      release: () => {
        released.resolve();
      },
    };
  }
}

describe("Matrix auto-join retirement", () => {
  let server: http.Server | undefined;
  let client: DrainHoldClient | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await client?.stopWithoutPersist().catch(() => {});
    client = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("does not post a join that is waiting on recovery-key persistence when the monitor retires", async () => {
    const seen: string[] = [];
    server = http.createServer((request, response) => {
      seen.push(`${request.method ?? "GET"} ${decodeURIComponent(request.url ?? "/")}`);
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ room_id: "!room:example.org", displayname: "active" }));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("proof server did not bind");
    }
    setMatrixRuntime({
      logging: {
        shouldLogVerbose: () => false,
        getChildLogger: () => ({ warn: () => {} }),
      },
    } as never);
    client = new DrainHoldClient(`http://127.0.0.1:${address.port}`, "fixture-token", {
      userId: "@bot:example.org",
      deviceId: "fixture",
      encryption: false,
      autoBootstrapCrypto: false,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    const matrixClient = client;
    const hold = matrixClient.holdNextDrain();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const owner = createMatrixMonitorTaskRunner({ logger, logVerboseMessage: vi.fn() });
    const sibling = createMatrixMonitorTaskRunner({ logger, logVerboseMessage: vi.fn() });
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
