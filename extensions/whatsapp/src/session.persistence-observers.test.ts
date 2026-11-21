import fs from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSessionTest,
  createTempAuthDir,
  emitCredsUpdate,
  mockFsOpenForCredsWrites,
  readLastSocketOptions,
  resetSessionTestMocks,
} from "./session-test-helpers.js";
import { baileys, getLastSocket } from "./test-helpers.js";

const useMultiFileAuthStateMock = vi.mocked(baileys.useMultiFileAuthState);
let session!: typeof import("./session.js");

describe("web session persistence observers", () => {
  beforeAll(async () => {
    session = await import("./session.js");
  });

  beforeEach(() => {
    resetSessionTestMocks();
  });

  afterEach(async () => {
    await cleanupSessionTest(session.waitForCredsSaveQueue);
  });

  it.each(["ordinary", "guarded", "error-observed", "task-observed"] as const)(
    "handles credential save failures on a %s socket",
    async (mode) => {
      const authDir = createTempAuthDir("openclaw-wa-observed-creds");
      const persistenceError = new Error("simulated credential save failure");
      const onCredentialPersistenceError = vi.fn();
      const openMock = mockFsOpenForCredsWrites();
      const renameSpy = vi.spyOn(fs, "rename").mockRejectedValue(persistenceError);

      try {
        await session.createWaSocket(false, false, {
          authDir,
          ...(mode === "guarded" ? { beforeCredentialPersistence: async () => {} } : {}),
          ...(mode === "error-observed" ? { onCredentialPersistenceError } : {}),
          ...(mode === "task-observed" ? { onCredentialPersistenceTask: vi.fn() } : {}),
        });
        await emitCredsUpdate(session.waitForCredsSaveQueue, authDir);

        if (mode === "error-observed") {
          expect(onCredentialPersistenceError).toHaveBeenCalledWith(persistenceError);
        }
        expect(getLastSocket().ws.close).toHaveBeenCalledTimes(mode === "ordinary" ? 0 : 1);
      } finally {
        openMock.restore();
        renameSpy.mockRestore();
      }
    },
  );

  it("observes signal persistence without a persistence authority hook", async () => {
    const authDir = createTempAuthDir("openclaw-wa-observed-keys");
    const persistenceError = new Error("simulated signal key failure");
    const onCredentialPersistenceError = vi.fn();
    const onCredentialPersistenceTask = vi.fn();
    useMultiFileAuthStateMock.mockResolvedValueOnce({
      state: {
        creds: {} as never,
        keys: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {
            throw persistenceError;
          }),
        },
      } as never,
      saveCreds: vi.fn(),
    });

    await session.createWaSocket(false, false, {
      authDir,
      onCredentialPersistenceError,
      onCredentialPersistenceTask,
    });
    const socketOptions = readLastSocketOptions() as ReturnType<typeof readLastSocketOptions> & {
      auth: { keys: { set: (data: unknown) => Promise<void> } };
      makeSignalRepository?: unknown;
    };

    await expect(socketOptions.auth.keys.set({ "pre-key": { test: {} } })).rejects.toBe(
      persistenceError,
    );
    expect(onCredentialPersistenceError).toHaveBeenCalledWith(persistenceError);
    expect(onCredentialPersistenceTask).toHaveBeenCalledTimes(1);
    expect(socketOptions.makeSignalRepository).toBeTypeOf("function");
    expect(getLastSocket().ws.close).toHaveBeenCalledTimes(1);
  });
});
