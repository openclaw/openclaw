import { resetLogger, setLoggerOverride, success } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreCredsFromBackupIfNeeded } from "./auth-store.js";
import { loginWeb } from "./login.js";
import { createWaSocket, type waitForWaConnection } from "./session.js";

const waiter = vi.fn<typeof waitForWaConnection>();
vi.mock(import("./session.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  createWaSocket: vi.fn().mockResolvedValue({ ws: { close: vi.fn() } }),
  waitForWaConnection: vi.fn().mockResolvedValue(undefined),
  readWebAuthExistsForDecision: vi.fn(async () => ({
    outcome: "stable" as const,
    exists: true,
  })),
}));

vi.mock(import("./auth-store.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  restoreCredsFromBackupIfNeeded: vi.fn(async () => false),
}));

async function startGuardedLogin() {
  const pending = loginWeb(false, waiter, undefined, undefined, {
    beforeCredentialPersistence: async () => {},
  });
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
  expect(createWaSocket).toHaveBeenCalled();
  return { pending, options: vi.mocked(createWaSocket).mock.calls.at(-1)?.[2] };
}

describe("web login", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    waiter.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLogger();
    setLoggerOverride(null);
  });

  it("loginWeb waits for connection and closes", async () => {
    const close = vi.spyOn((await createWaSocket(false, false)).ws, "close");
    await loginWeb(false, waiter);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("prints a backup recovery success message when creds are restored from backup", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(restoreCredsFromBackupIfNeeded).mockResolvedValueOnce(true);

    await loginWeb(false, waiter);

    expect(consoleLog).toHaveBeenCalledWith(
      success("✅ Recovered from creds.json.bak; web session ready."),
    );
    consoleLog.mockRestore();
  });

  it("rejects a delayed credential write failure even when old auth is still readable", async () => {
    const persistenceError = new Error("credential write failed");
    waiter.mockImplementationOnce(() => new Promise<void>(() => {}));
    const { pending, options } = await startGuardedLogin();
    options?.onCredentialPersistenceError?.(persistenceError);
    await expect(pending).rejects.toBe(persistenceError);
  });

  it("waits for Baileys post-open key persistence before reporting login success", async () => {
    const keyRead = Promise.withResolvers<void>();
    const keyWrite = Promise.withResolvers<void>();
    const { pending, options } = await startGuardedLogin();
    options?.onCredentialPersistenceTask?.(keyRead.promise);
    void keyRead.promise.then(() => options?.onCredentialPersistenceTask?.(keyWrite.promise));
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    keyRead.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    keyWrite.resolve();
    await expect(pending).resolves.toBeUndefined();
  });
});
