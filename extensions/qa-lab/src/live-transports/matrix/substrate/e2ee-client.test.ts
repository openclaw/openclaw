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

type Operation = Exclude<keyof typeof runtimeFixture, "logging" | "ready" | "unexpectedOperation">;
function expectCalls(counts: Partial<Record<Operation, number>>) {
  for (const [operation, count] of Object.entries(counts)) {
    expect(runtimeFixture[operation as Operation]).toHaveBeenCalledTimes(count);
  }
}
const shutdownFailure = "shutdown failed while waiting for active Matrix SDK operations";
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
  const encryptedMedia = () => ({ buffer: image.buffer, file: {} });
  const sendText = (body = "text") => client.sendTextMessage({ roomId: image.roomId, body });
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
    runtimeFixture.encrypt.mockReset().mockResolvedValue(encryptedMedia());
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
          : client[kind === "notice" ? "sendNoticeMessage" : "sendTextMessage"]({
              roomId: image.roomId,
              body: kind,
            });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expectCalls({ encrypt: 0, upload: 0, send: 0 });
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
      expectCalls({ persist: 0, discard: 0, abort: 1 });
      expect(stopped).toBe(false);
      encryption.resolve(encryptedMedia());
      await settled;
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimeFixture.discard).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
    } finally {
      encryption.resolve(encryptedMedia());
      discarded.resolve();
      await settled;
      await stopSettled;
    }
    await expect(stop).rejects.toThrow(shutdownFailure);
    expectCalls({ discard: 1, persist: 0, upload: 0, send: 0 });
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
      runtimeFixture[stage === "encryption" ? "encrypt" : "upload"].mockImplementation(async () => {
        await finish.promise;
        return stage === "encryption" ? encryptedMedia() : "mxc://matrix.test/image";
      });
      const operation = client.sendImageMessage(image);
      const settled = Promise.allSettled([operation]);
      await vi.advanceTimersByTimeAsync(0);
      current = false;
      finish.resolve();
      await settled;
      expectCalls({ send: 0, upload: stage === "upload" ? 1 : 0 });
      await expect(operation).rejects.toThrow("room changed");
    },
  );

  it("times out a dispatched send without claiming it was unsent or retrying", async () => {
    const send = createDeferred<string>();
    runtimeFixture.send.mockReturnValue(send.promise);
    const operation = sendText();
    const settled = Promise.allSettled([operation]);
    try {
      await vi.advanceTimersByTimeAsync(100);
      await settled;
      await expect(operation).rejects.not.toBeInstanceOf(PlatformMessageNotDispatchedError);
      await expect(operation).rejects.toThrow("Matrix E2EE text send timed out after 100ms");
      expectCalls({ detach: 2, abort: 0, persist: 0, discard: 0 });
      await vi.advanceTimersByTimeAsync(100);
      expectCalls({ abort: 1, discard: 0 });
    } finally {
      send.resolve("$possibly-sent");
      await settled;
    }
    await expect(client.stop()).rejects.toThrow(shutdownFailure);
    expectCalls({ discard: 1, persist: 0, send: 1 });
  });
  it("provides normal diagnostics without enabling secret-bearing SDK debug output", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const levels = ["info", "warn", "error"] as const;
    const spies = levels.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    expect(runtimeFixture.logging).toBeDefined();
    const logger = runtimeFixture.logging!.getChildLogger({ module: "matrix:crypto" });
    logger.debug?.('shared_secret: "fixture-only-qr-secret"');
    for (const [index, level] of levels.entries()) {
      logger[level](`verification ${level}`);
      expect(spies[index]).toHaveBeenCalledExactlyOnceWith(`verification ${level}`);
    }
    expect(debug).not.toHaveBeenCalled();
  });

  it("shares shutdown while giving admitted sends a grace period before draining and persisting", async () => {
    const calls: string[] = [];
    const finish = createDeferred<string>();
    runtimeFixture.send.mockImplementation(() => {
      calls.push("operation");
      return finish.promise;
    });
    runtimeFixture.detach.mockImplementation((event) => calls.push(`detach:${event}`));
    runtimeFixture.drain.mockImplementation(async () => {
      calls.push("drain");
    });
    runtimeFixture.persist.mockImplementation(async () => {
      calls.push("stop-and-persist");
    });
    const operation = sendText();
    await vi.advanceTimersByTimeAsync(0);
    const stop = client.stop();
    try {
      expect(client.stop()).toBe(stop);
      expect(calls).toEqual(["operation", "detach:room.message", "detach:verification.summary"]);
    } finally {
      finish.resolve("$sent");
    }
    await expect(operation).resolves.toBe("$sent");
    await stop;
    expect(client.stop()).toBe(stop);
    await expect(sendText("must not send")).rejects.toThrow("shutdown has started");
    expect(calls).toEqual([
      "operation",
      "detach:room.message",
      "detach:verification.summary",
      "drain",
      "stop-and-persist",
    ]);
    expectCalls({ send: 1, drain: 1, persist: 1, abort: 0, discard: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards without persisting when pending decryptions exceed the shutdown deadline", async () => {
    runtimeFixture.drain.mockReturnValue(createDeferred<void>().promise);
    const rejection = expect(client.stop()).rejects.toThrow(
      "shutdown failed while draining pending Matrix decryptions",
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expectCalls({ detach: 2, drain: 1, discard: 1, persist: 0 });
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
    const operation = sendText();
    const operationRejection = expect(operation).rejects.toThrow("late send failure");
    await vi.advanceTimersByTimeAsync(0);
    const stopRejection = expect(client.stop()).rejects.toThrow(shutdownFailure);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expectCalls({ detach: 2, abort: 1, drain: 0, discard: 0 });
    } finally {
      finish.reject(new Error("late send failure"));
    }
    await operationRejection;
    await stopRejection;
    expectCalls({ send: 1, discard: 1, persist: 0 });
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
  it("deduplicates late decryption and rehydrates replacements of the threaded target", () => {
    const observed: MatrixQaObservedEvent[] = [];
    const recorder = createMatrixQaE2eeObservedEventRecorder({
      append: (event) => observed.push(event),
    });
    const previous: MatrixQaObservedEvent = {
      eventId: "$preview",
      kind: "message",
      roomId: "!room:matrix-qa.test",
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
    };
    const replacement = {
      ...previous,
      eventId: "$final",
      body: "final",
      msgtype: "m.text",
      replacesEventId: "$preview",
    };
    const decrypted = {
      ...previous,
      body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
      msgtype: "m.text",
      relatesTo: {
        eventId: "$root",
        inReplyToId: "$driver",
        isFallingBack: true,
        relType: "m.thread",
      },
    };
    recorder.record(replacement);
    recorder.record(previous);
    recorder.record(decrypted);
    recorder.record(decrypted);
    expect(observed).toEqual([
      replacement,
      previous,
      decrypted,
      { ...replacement, relatesTo: decrypted.relatesTo },
    ]);
  });
});
