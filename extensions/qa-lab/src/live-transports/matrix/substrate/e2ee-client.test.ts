import { access, stat } from "node:fs/promises";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMatrixQaE2eeClientLifecycle,
  createMatrixQaE2eeObservedEventRecorder,
  prepareMatrixQaE2eeStorage,
} from "./e2ee-client-internals.js";
import { createMatrixQaE2eeScenarioClient } from "./e2ee-client.js";
import type { MatrixQaObservedEvent } from "./events.js";

const runtimeFixture = vi.hoisted(() => ({
  logging: undefined as PluginRuntime["logging"] | undefined,
  unexpectedOperation: async () => {
    throw new Error("Logging fixture does not perform Matrix client operations");
  },
  ready: vi.fn<() => Promise<() => void>>(),
  encrypt: vi.fn(),
  upload: vi.fn(),
  send: vi.fn(),
  detach: vi.fn(),
  abort: vi.fn(),
  persist: vi.fn(),
  discard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", () => ({
  loadQaRunnerBundledPluginTestApi: async () => ({
    setMatrixRuntime: (runtime: Pick<PluginRuntime, "logging">) => {
      runtimeFixture.logging = runtime.logging;
    },
    SqliteBackedMatrixSyncStore: { create: async () => ({}) },
    MatrixClient: class {
      bootstrapOwnDeviceVerification = runtimeFixture.unexpectedOperation;
      deleteOwnDevices = runtimeFixture.unexpectedOperation;
      getDeviceVerificationStatus = runtimeFixture.unexpectedOperation;
      listOwnDevices = runtimeFixture.unexpectedOperation;
      resetRoomKeyBackup = runtimeFixture.unexpectedOperation;
      restoreRoomKeyBackup = runtimeFixture.unexpectedOperation;
      verifyWithRecoveryKey = runtimeFixture.unexpectedOperation;
      async withLiveEncryptedRoom<T>(
        _roomId: string,
        run: (assertCurrent: () => void) => Promise<T>,
        opts: { assertCurrent?: () => void } = {},
      ): Promise<T> {
        const assertReady = await runtimeFixture.ready();
        const assertCurrent = () => {
          opts.assertCurrent?.();
          assertReady();
        };
        assertCurrent();
        return await run(assertCurrent);
      }
      abortPendingRequests = runtimeFixture.abort;
      crypto = { encryptMedia: runtimeFixture.encrypt };
      uploadContent = runtimeFixture.upload;
      sendMessage = runtimeFixture.send;
      on() {}
      off = runtimeFixture.detach;
      async start() {}
      async drainPendingDecryptions() {}
      stopAndPersist = runtimeFixture.persist;
      stopWithoutPersist = runtimeFixture.discard;
    },
  }),
}));

describe("matrix qa e2ee client", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let client: Awaited<ReturnType<typeof createMatrixQaE2eeScenarioClient>>;
  let outputDir: string;
  const image = {
    roomId: "!room:matrix.test",
    body: "image",
    buffer: Buffer.from("image fixture"),
    contentType: "image/png",
    fileName: "fixture.png",
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    runtimeFixture.ready.mockReset().mockResolvedValue(() => undefined);
    runtimeFixture.encrypt.mockReset().mockResolvedValue({ buffer: image.buffer, file: {} });
    runtimeFixture.upload.mockReset().mockResolvedValue("mxc://matrix.test/image");
    runtimeFixture.send.mockReset().mockResolvedValue("$sent");
    runtimeFixture.detach.mockReset();
    runtimeFixture.abort.mockReset();
    runtimeFixture.persist.mockReset().mockResolvedValue(undefined);
    runtimeFixture.discard.mockReset().mockResolvedValue(undefined);
    outputDir = tempDirs.make("matrix-qa-send-");
    client = await createMatrixQaE2eeScenarioClient({
      accessToken: "fixture-token",
      actorId: "driver",
      baseUrl: "https://matrix.test",
      observedEvents: [],
      outputDir,
      scenarioId: "matrix-e2ee-basic-reply",
      timeoutMs: 100,
      userId: "@driver:matrix.test",
    });
  });
  afterEach(async () => {
    await client.stop().catch(() => undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["text", "notice", "image"] as const)(
    "admits %s only after live encrypted room readiness",
    async (kind) => {
      const ready = createDeferred<() => void>();
      runtimeFixture.ready.mockReturnValue(ready.promise);
      const operation =
        kind === "image"
          ? client.sendImageMessage(image)
          : kind === "notice"
            ? client.sendNoticeMessage({ roomId: image.roomId, body: "notice" })
            : client.sendTextMessage({ roomId: image.roomId, body: "text" });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(runtimeFixture.encrypt).not.toHaveBeenCalled();
        expect(runtimeFixture.upload).not.toHaveBeenCalled();
        expect(runtimeFixture.send).not.toHaveBeenCalled();
      } finally {
        ready.resolve(() => undefined);
        await operation;
      }
      expect(runtimeFixture.send).toHaveBeenCalledOnce();
    },
  );

  it("rejects an image after stop before encryption or upload", async () => {
    await client.stop();
    await expect(client.sendImageMessage(image)).rejects.toThrow("shutdown has started");
    expect(runtimeFixture.encrypt).not.toHaveBeenCalled();
    expect(runtimeFixture.upload).not.toHaveBeenCalled();
  });

  it("joins late encryption after the grace deadline before discard and fences its upload", async () => {
    const encryption = createDeferred<{ buffer: Buffer; file: object }>();
    const discarded = createDeferred<void>();
    runtimeFixture.encrypt.mockReturnValue(encryption.promise);
    runtimeFixture.discard.mockReturnValue(discarded.promise);
    const operation = client.sendImageMessage(image);
    const settled = Promise.allSettled([operation]);
    await vi.advanceTimersByTimeAsync(0);
    const stop = client.stop();
    const stopSettled = Promise.allSettled([stop]);
    let stopped = false;
    void stopSettled.then(() => {
      stopped = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(101);
      expect(runtimeFixture.persist).not.toHaveBeenCalled();
      expect(runtimeFixture.discard).not.toHaveBeenCalled();
      expect(runtimeFixture.abort).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
      encryption.resolve({ buffer: image.buffer, file: {} });
      await settled;
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimeFixture.discard).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
    } finally {
      encryption.resolve({ buffer: image.buffer, file: {} });
      discarded.resolve();
      await settled;
      await stopSettled;
    }
    await expect(stop).rejects.toThrow(
      "shutdown failed while waiting for active Matrix SDK operations",
    );
    expect(runtimeFixture.discard).toHaveBeenCalledOnce();
    expect(runtimeFixture.persist).not.toHaveBeenCalled();
    expect(runtimeFixture.upload).not.toHaveBeenCalled();
    expect(runtimeFixture.send).not.toHaveBeenCalled();
  });

  it.each(["encryption", "upload"])(
    "fences a room invalidated while media %s was pending",
    async (stage) => {
      const finish = createDeferred<void>();
      let current = true;
      runtimeFixture.ready.mockResolvedValue(() => {
        if (!current) {
          throw new Error("room changed");
        }
      });
      if (stage === "encryption") {
        runtimeFixture.encrypt.mockImplementation(async () => {
          await finish.promise;
          return { buffer: image.buffer, file: {} };
        });
      } else {
        runtimeFixture.upload.mockImplementation(async () => {
          await finish.promise;
          return "mxc://matrix.test/image";
        });
      }
      const operation = client.sendImageMessage(image);
      const settled = Promise.allSettled([operation]);
      await vi.advanceTimersByTimeAsync(0);
      current = false;
      finish.resolve();
      await settled;
      expect(runtimeFixture.send).not.toHaveBeenCalled();
      expect(runtimeFixture.upload).toHaveBeenCalledTimes(stage === "upload" ? 1 : 0);
      await expect(operation).rejects.toThrow("room changed");
    },
  );

  it("times out a dispatched send without claiming it was unsent or retrying", async () => {
    const send = createDeferred<string>();
    runtimeFixture.send.mockReturnValue(send.promise);
    const operation = client.sendTextMessage({ roomId: image.roomId, body: "text" });
    const settled = Promise.allSettled([operation]);
    try {
      await vi.advanceTimersByTimeAsync(100);
      const [result] = await settled;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
      }
      await expect(operation).rejects.toThrow("Matrix E2EE text send timed out after 100ms");
      expect(runtimeFixture.detach).toHaveBeenCalledTimes(2);
      expect(runtimeFixture.abort).not.toHaveBeenCalled();
      expect(runtimeFixture.persist).not.toHaveBeenCalled();
      expect(runtimeFixture.discard).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(runtimeFixture.abort).toHaveBeenCalledOnce();
      expect(runtimeFixture.discard).not.toHaveBeenCalled();
    } finally {
      send.resolve("$possibly-sent");
      await settled;
    }
    await expect(client.stop()).rejects.toThrow(
      "shutdown failed while waiting for active Matrix SDK operations",
    );
    expect(runtimeFixture.discard).toHaveBeenCalledOnce();
    expect(runtimeFixture.persist).not.toHaveBeenCalled();
    expect(runtimeFixture.send).toHaveBeenCalledOnce();
  });
  it("provides normal diagnostics without enabling secret-bearing SDK debug output", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runtimeFixture.logging).toBeDefined();
    const logger = runtimeFixture.logging!.getChildLogger({ module: "matrix:crypto" });
    logger.debug?.('shared_secret: "fixture-only-qr-secret"');
    logger.info("verification started");
    logger.warn("verification warning");
    logger.error("verification failure");
    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledExactlyOnceWith("verification started");
    expect(warn).toHaveBeenCalledExactlyOnceWith("verification warning");
    expect(error).toHaveBeenCalledExactlyOnceWith("verification failure");
  });

  it("uses plugin state without creating a legacy IndexedDB snapshot", async () => {
    const storage = await prepareMatrixQaE2eeStorage({
      actorId: "driver",
      outputDir,
      scenarioId: "matrix-e2ee-basic-reply",
    });
    expect((await stat(storage.accountDir)).mode & 0o777).toBe(0o700);
    await expect(access(storage.idbSnapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("matrix qa e2ee lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function createLifecycleFixture(options?: {
    drain?: () => Promise<void>;
    shutdownTimeoutMs?: number;
  }) {
    const calls: string[] = [];
    const lifecycle = createMatrixQaE2eeClientLifecycle({
      abortPendingRequests: vi.fn(() => calls.push("abort")),
      detachListeners: vi.fn(() => calls.push("detach")),
      drainPendingDecryptions: vi.fn(async () => {
        calls.push("drain");
        await options?.drain?.();
      }),
      shutdownTimeoutMs: options?.shutdownTimeoutMs ?? 500,
      stopAndPersist: vi.fn(async () => {
        calls.push("stop-and-persist");
      }),
      stopWithoutPersist: vi.fn(async () => {
        calls.push("stop-and-discard");
      }),
    });
    return { calls, lifecycle };
  }

  it("shares one stop promise across concurrent and repeated shutdown requests", async () => {
    const { calls, lifecycle } = createLifecycleFixture();

    const first = lifecycle.stop();
    const second = lifecycle.stop();
    await Promise.all([first, second]);
    const third = lifecycle.stop();
    const run = vi.fn(async () => "sent");

    expect(second).toBe(first);
    expect(third).toBe(first);
    await expect(
      lifecycle.runOperation({
        label: "Matrix E2EE text send",
        run,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("shutdown has started");
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual(["detach", "drain", "stop-and-persist"]);
  });

  it("gives an active operation a bounded grace period before draining and stopping", async () => {
    const { calls, lifecycle } = createLifecycleFixture();
    const finish = createDeferred<string>();
    const operation = lifecycle.runOperation({
      label: "Matrix E2EE text send",
      run: () => {
        calls.push("operation");
        return finish.promise;
      },
      timeoutMs: 1_000,
    });
    const stop = lifecycle.stop();
    expect(calls).toEqual(["operation", "detach"]);
    finish.resolve("sent");
    await operation;
    await stop;
    expect(calls).toEqual(["operation", "detach", "drain", "stop-and-persist"]);
  });

  it("discards without persisting when pending decryptions exceed the shutdown deadline", async () => {
    const { calls, lifecycle } = createLifecycleFixture({
      drain: () => createDeferred<void>().promise,
      shutdownTimeoutMs: 100,
    });
    const rejection = expect(lifecycle.stop()).rejects.toThrow(
      "shutdown failed while draining pending Matrix decryptions",
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(calls).toEqual(["detach", "drain", "stop-and-discard"]);
  });

  it("observes a late rejection before shutdown discards state", async () => {
    const { calls, lifecycle } = createLifecycleFixture({ shutdownTimeoutMs: 50 });
    const finish = createDeferred<string>();
    const operation = lifecycle.runOperation({
      label: "Matrix E2EE text send",
      run: () => finish.promise,
      timeoutMs: 1_000,
    });
    const operationRejection = expect(operation).rejects.toThrow("late send failure");
    const stopRejection = expect(lifecycle.stop()).rejects.toThrow(
      "shutdown failed while waiting for active Matrix SDK operations",
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toEqual(["detach", "abort"]);
    finish.reject(new Error("late send failure"));
    await operationRejection;
    await stopRejection;
    expect(calls).toEqual(["detach", "abort", "stop-and-discard"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("matrix qa e2ee event recording", () => {
  it("records late-decrypted payload updates for an existing event id", () => {
    const previous = {
      eventId: "$reply",
      kind: "message" as const,
      roomId: "!room:matrix-qa.test",
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
    };
    const observed: MatrixQaObservedEvent[] = [];
    const recorder = createMatrixQaE2eeObservedEventRecorder({
      append: (event) => observed.push(event),
    });
    const decrypted = {
      ...previous,
      body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
      msgtype: "m.text",
    };

    recorder.record(previous);
    recorder.record(decrypted);
    recorder.record(decrypted);

    expect(observed).toEqual([previous, decrypted]);
  });

  it("rehydrates a replacement when its threaded target decrypts later", () => {
    const observed: MatrixQaObservedEvent[] = [];
    const recorder = createMatrixQaE2eeObservedEventRecorder({
      append: (event) => observed.push(event),
    });
    const replacement = {
      eventId: "$final",
      kind: "message" as const,
      roomId: "!room:matrix-qa.test",
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
      body: "final",
      msgtype: "m.text",
      replacesEventId: "$preview",
    };
    const relation = {
      eventId: "$root",
      inReplyToId: "$driver",
      isFallingBack: true,
      relType: "m.thread",
    };

    recorder.record(replacement);
    recorder.record({
      eventId: "$preview",
      kind: "notice",
      roomId: "!room:matrix-qa.test",
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
      body: "preview",
      msgtype: "m.notice",
      relatesTo: relation,
    });

    expect(observed).toEqual([
      replacement,
      expect.objectContaining({ eventId: "$preview", relatesTo: relation }),
      { ...replacement, relatesTo: relation },
    ]);
  });
});
