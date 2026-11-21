import fsSync from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSessionTest,
  createTempAuthDir,
  emitCredsUpdate,
  firstMockCall,
  resetSessionTestMocks,
} from "./session-test-helpers.js";
import { baileys, getLastSocket } from "./test-helpers.js";

const useMultiFileAuthStateMock = vi.mocked(baileys.useMultiFileAuthState);
let session!: typeof import("./session.js");

function readGuardedKeys(): { set: (data: unknown) => Promise<void> } {
  const [socketOptions] = firstMockCall(
    baileys.makeWASocket as ReturnType<typeof vi.fn>,
    "Baileys socket creation",
  );
  return (socketOptions as { auth: { keys: { set: (data: unknown) => Promise<void> } } }).auth.keys;
}

describe("web session persistence guards", () => {
  beforeAll(async () => {
    session = await import("./session.js");
  });

  beforeEach(() => {
    resetSessionTestMocks();
  });

  afterEach(async () => {
    await cleanupSessionTest(session.waitForCredsSaveQueue);
  });

  it("revalidates setup ownership immediately before a delayed creds.update write", async () => {
    const authDir = createTempAuthDir("openclaw-wa-guarded-creds");
    const guardError = new Error("verified inference route changed");
    let routeOwner = "original";
    const beforeCredentialPersistence = vi.fn(async () => {
      if (routeOwner !== "original") {
        throw guardError;
      }
    });
    const onCredentialPersistenceError = vi.fn();

    await session.createWaSocket(false, false, {
      authDir,
      beforeCredentialPersistence,
      onCredentialPersistenceError,
    });
    expect(beforeCredentialPersistence).toHaveBeenCalledTimes(1);

    routeOwner = "replacement";
    const sock = getLastSocket();
    sock.ev.emit("creds.update", {});
    await session.waitForCredsSaveQueue(authDir);

    expect(beforeCredentialPersistence).toHaveBeenCalledTimes(2);
    expect(onCredentialPersistenceError).toHaveBeenCalledWith(guardError);
    expect(fsSync.existsSync(path.join(authDir, "creds.json"))).toBe(false);
    expect(sock.ws.close).toHaveBeenCalledTimes(1);
  });

  it("aborts and skips delayed creds.update persistence when setup ownership changes", async () => {
    const authDir = createTempAuthDir("openclaw-wa-guard-only-creds");
    const guardError = new Error("verified inference route changed");
    let routeOwner = "original";
    const beforeCredentialPersistence = vi.fn(async () => {
      if (routeOwner !== "original") {
        throw guardError;
      }
    });

    await session.createWaSocket(false, false, { authDir, beforeCredentialPersistence });
    routeOwner = "replacement";
    const sock = getLastSocket();

    await emitCredsUpdate(session.waitForCredsSaveQueue, authDir);

    expect(beforeCredentialPersistence).toHaveBeenCalledTimes(2);
    expect(fsSync.existsSync(path.join(authDir, "creds.json"))).toBe(false);
    expect(sock.ws.close).toHaveBeenCalledTimes(1);
  });

  it("revalidates setup ownership before Baileys persists signal keys", async () => {
    const authDir = createTempAuthDir("openclaw-wa-guarded-keys");
    const guardError = new Error("verified inference route changed");
    let routeOwner = "original";
    const beforeCredentialPersistence = vi.fn(async () => {
      if (routeOwner !== "original") {
        throw guardError;
      }
    });
    const onCredentialPersistenceError = vi.fn();
    const onCredentialPersistenceTask = vi.fn();

    await session.createWaSocket(false, false, {
      authDir,
      beforeCredentialPersistence,
      onCredentialPersistenceError,
      onCredentialPersistenceTask,
    });
    routeOwner = "replacement";
    const guardedKeys = readGuardedKeys();

    await expect(guardedKeys.set({ "pre-key": { test: {} } })).rejects.toBe(guardError);
    expect(beforeCredentialPersistence).toHaveBeenCalledTimes(2);
    expect(onCredentialPersistenceError).toHaveBeenCalledWith(guardError);
    expect(onCredentialPersistenceTask).toHaveBeenCalledTimes(1);
    expect(getLastSocket().ws.close).toHaveBeenCalledTimes(1);
  });

  it("aborts and skips signal-key persistence when setup ownership changes", async () => {
    const authDir = createTempAuthDir("openclaw-wa-guard-only-keys");
    const guardError = new Error("verified inference route changed");
    let routeOwner = "original";
    const beforeCredentialPersistence = vi.fn(async () => {
      if (routeOwner !== "original") {
        throw guardError;
      }
    });
    const persistKeys = vi.fn(async () => {});
    useMultiFileAuthStateMock.mockResolvedValueOnce({
      state: {
        creds: {} as never,
        keys: {
          get: vi.fn(async () => ({})),
          set: persistKeys,
        },
      } as never,
      saveCreds: vi.fn(),
    });

    await session.createWaSocket(false, false, { authDir, beforeCredentialPersistence });
    routeOwner = "replacement";

    await expect(readGuardedKeys().set({ "pre-key": { test: {} } })).rejects.toBe(guardError);
    expect(beforeCredentialPersistence).toHaveBeenCalledTimes(2);
    expect(persistKeys).not.toHaveBeenCalled();
    expect(getLastSocket().ws.close).toHaveBeenCalledTimes(1);
  });
});
