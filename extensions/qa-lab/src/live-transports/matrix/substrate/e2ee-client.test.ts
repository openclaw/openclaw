import { access, stat } from "node:fs/promises";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
  drain: vi.fn(),
  persist: vi.fn(),
  discard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/qa-runner-runtime")>()),
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
      drainPendingDecryptions = runtimeFixture.drain;
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
  const createClient = (timeoutMs = 100) =>
    createMatrixQaE2eeScenarioClient({
      accessToken: "fixture-token",
      actorId: "driver",
      baseUrl: "https://matrix.test",
      observedEvents: [],
      outputDir,
      scenarioId: "matrix-e2ee-basic-reply",
      timeoutMs,
      userId: "@driver:matrix.test",
    });
  beforeEach(async () => {
    vi.useFakeTimers();
    runtimeFixture.ready.mockReset().mockResolvedValue(() => undefined);
    runtimeFixture.encrypt.mockReset().mockResolvedValue({ buffer: image.buffer, file: {} });
    runtimeFixture.upload.mockReset().mockResolvedValue("mxc://matrix.test/image");
    runtimeFixture.send.mockReset().mockResolvedValue("$sent");
    runtimeFixture.detach.mockReset();
    runtimeFixture.abort.mockReset();
    runtimeFixture.drain.mockReset().mockResolvedValue(undefined);
    runtimeFixture.persist.mockReset().mockResolvedValue(undefined);
    runtimeFixture.discard.mockReset().mockResolvedValue(undefined);
    outputDir = tempDirs.make("matrix-qa-send-");
    client = await createClient();
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

  it("shares one stop promise across concurrent and repeated shutdown requests", async () => {
    const first = client.stop();
    const second = client.stop();
    await Promise.all([first, second]);
    const third = client.stop();

    expect(second).toBe(first);
    expect(third).toBe(first);
    await expect(
      client.sendTextMessage({ roomId: image.roomId, body: "must not send" }),
    ).rejects.toThrow("shutdown has started");
    expect(runtimeFixture.send).not.toHaveBeenCalled();
    expect(runtimeFixture.detach.mock.calls.map(([event]) => event)).toEqual([
      "room.message",
      "verification.summary",
    ]);
    expect(runtimeFixture.drain).toHaveBeenCalledOnce();
    expect(runtimeFixture.persist).toHaveBeenCalledOnce();
    expect(runtimeFixture.discard).not.toHaveBeenCalled();
  });

  it("gives an admitted send a bounded grace period before draining and persisting", async () => {
    const calls: string[] = [];
    const finish = createDeferred<string>();
    runtimeFixture.send.mockImplementation(() => {
      calls.push("operation");
      return finish.promise;
    });
    runtimeFixture.detach.mockImplementation(() => calls.push("detach"));
    runtimeFixture.drain.mockImplementation(async () => {
      calls.push("drain");
    });
    runtimeFixture.persist.mockImplementation(async () => {
      calls.push("stop-and-persist");
    });
    const operation = client.sendTextMessage({ roomId: image.roomId, body: "text" });
    await vi.advanceTimersByTimeAsync(0);
    const stop = client.stop();
    try {
      expect(calls).toEqual(["operation", "detach", "detach"]);
    } finally {
      finish.resolve("$sent");
    }
    await expect(operation).resolves.toBe("$sent");
    await stop;
    expect(calls).toEqual(["operation", "detach", "detach", "drain", "stop-and-persist"]);
    expect(runtimeFixture.abort).not.toHaveBeenCalled();
    expect(runtimeFixture.discard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards without persisting when pending decryptions exceed the shutdown deadline", async () => {
    runtimeFixture.drain.mockReturnValue(createDeferred<void>().promise);
    const rejection = expect(client.stop()).rejects.toThrow(
      "shutdown failed while draining pending Matrix decryptions",
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(runtimeFixture.detach).toHaveBeenCalledTimes(2);
    expect(runtimeFixture.drain).toHaveBeenCalledOnce();
    expect(runtimeFixture.discard).toHaveBeenCalledOnce();
    expect(runtimeFixture.persist).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a late send rejection before shutdown discards state", async () => {
    await client.stop();
    client = await createClient(2_000);
    runtimeFixture.detach.mockClear();
    runtimeFixture.drain.mockClear();
    runtimeFixture.persist.mockClear();
    const finish = createDeferred<string>();
    runtimeFixture.send.mockReturnValue(finish.promise);
    const operation = client.sendTextMessage({ roomId: image.roomId, body: "text" });
    const operationRejection = expect(operation).rejects.toThrow("late send failure");
    await vi.advanceTimersByTimeAsync(0);
    const stopRejection = expect(client.stop()).rejects.toThrow(
      "shutdown failed while waiting for active Matrix SDK operations",
    );
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runtimeFixture.detach).toHaveBeenCalledTimes(2);
      expect(runtimeFixture.abort).toHaveBeenCalledOnce();
      expect(runtimeFixture.drain).not.toHaveBeenCalled();
      expect(runtimeFixture.discard).not.toHaveBeenCalled();
    } finally {
      finish.reject(new Error("late send failure"));
    }
    await operationRejection;
    await stopRejection;
    expect(runtimeFixture.send).toHaveBeenCalledOnce();
    expect(runtimeFixture.discard).toHaveBeenCalledOnce();
    expect(runtimeFixture.persist).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
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
