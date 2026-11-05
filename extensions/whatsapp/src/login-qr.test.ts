import { setImmediate as waitForNextTask, setTimeout as waitMs } from "node:timers/promises";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveWebListener } from "./active-listener.js";
import { startWebLoginWithQr, waitForWebLogin } from "./login-qr.js";
import { renderQrPngDataUrl } from "./qr-image.js";
import {
  createWaSocket,
  logoutWeb,
  readWebAuthExistsForDecision,
  readWebSelfId,
  WHATSAPP_AUTH_UNSTABLE_CODE,
  waitForWaConnection,
} from "./session.js";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  const formatError = vi.fn((err: unknown) => `formatted:${String(err)}`);
  return {
    ...actual,
    createWaSocket: vi.fn(),
    waitForWaConnection: vi.fn(),
    formatError,
    readWebAuthExistsForDecision: vi.fn(async () => ({
      outcome: "stable" as const,
      exists: false,
    })),
    readWebSelfId: vi.fn(() => ({ e164: null, jid: null, lid: null })),
    logoutWeb: vi.fn(async () => true),
  };
});

vi.mock("./active-listener.js", () => ({
  getActiveWebListener: vi.fn(() => null),
}));

vi.mock("./qr-image.js", () => ({
  renderQrPngDataUrl: vi.fn(async (input: string) => `data:image/png;base64,encoded:${input}`),
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const getActiveWebListenerMock = vi.mocked(getActiveWebListener);
const readWebAuthExistsForDecisionMock = vi.mocked(readWebAuthExistsForDecision);
const readWebSelfIdMock = vi.mocked(readWebSelfId);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const logoutWebMock = vi.mocked(logoutWeb);
const renderQrPngDataUrlMock = vi.mocked(renderQrPngDataUrl);
const linkedResult = { connected: true, message: "✅ Linked! WhatsApp is ready." };
const noActiveResult = { connected: false, message: "No active WhatsApp login in progress." };
const refreshedQrMessage = "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.";
const cleanupFailureMessage =
  "WhatsApp login failed: existing auth could not be cleared. Remove or fix the configured WhatsApp auth directory, then retry login.";

function revocableAuthority() {
  let active = true;
  return {
    revoke: () => {
      active = false;
    },
    check: vi.fn(async () => {
      if (!active) {
        throw new Error("plugin tool host authority is no longer active");
      }
    }),
  };
}

const encodedQr = (qr: string) => `data:image/png;base64,encoded:${qr}`;

function qrSocket(qr?: string, next?: { qr: string; delayMs: number }): typeof createWaSocket {
  return async (_printQr, _verbose, opts) => {
    const sock = { ws: { close: vi.fn() } };
    if (qr) {
      setImmediate(() => opts?.onQr?.(qr));
    }
    if (next) {
      setTimeout(() => opts?.onQr?.(next.qr), next.delayMs);
    }
    return sock as never;
  };
}

function queueQrSocket(qr?: string, next?: { qr: string; delayMs: number }) {
  createWaSocketMock.mockImplementationOnce(qrSocket(qr, next));
}

function startQr(accountId?: string, options: Parameters<typeof startWebLoginWithQr>[0] = {}) {
  return startWebLoginWithQr({ timeoutMs: 5000, accountId, ...options });
}

function waitForQr(qrDataUrl: string | undefined, accountId?: string, timeoutMs = 5000) {
  return waitForWebLogin({ timeoutMs, currentQrDataUrl: qrDataUrl, accountId });
}

function expectScanQrResult(result: unknown, qr = "qr-data") {
  expect(result).toEqual({
    qrDataUrl: encodedQr(qr),
    message: "Scan this QR in WhatsApp → Linked Devices.",
  });
}

async function scanQr(accountId?: string, options?: Parameters<typeof startQr>[1]) {
  const result = await startQr(accountId, options);
  expectScanQrResult(result);
  return result;
}

function scanPendingQr(accountId: string, options?: Parameters<typeof startQr>[1]) {
  waitForWaConnectionMock.mockImplementation(waitForever);
  return scanQr(accountId, options);
}

function expectQrRefreshResult(result: unknown, qr: string) {
  expect(result).toEqual({
    connected: false,
    message: refreshedQrMessage,
    qrDataUrl: encodedQr(qr),
  });
}

function expectLoginFailure(result: Promise<unknown>, message: string, waiting = false) {
  return expect(result).resolves.toEqual(waiting ? { connected: false, message } : { message });
}

function authExists(...values: boolean[]) {
  for (const exists of values) {
    readWebAuthExistsForDecisionMock.mockResolvedValueOnce({ outcome: "stable", exists });
  }
  return readWebAuthExistsForDecisionMock;
}

const waitForever = () => new Promise<never>(() => {});

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForQrRenderCallCount(count: number) {
  const deadline = Date.now() + 1000;
  while (renderQrPngDataUrlMock.mock.calls.length < count && Date.now() < deadline) {
    await waitMs(0);
    await flushTasks();
  }
}

describe("login-qr", () => {
  let accountId: string;
  let nextAccountId = 0;

  beforeEach(() => {
    accountId = `login-qr-${nextAccountId++}`;
    vi.clearAllMocks();
    createWaSocketMock.mockReset().mockImplementation(qrSocket("qr-data"));
    waitForWaConnectionMock.mockReset();
    readWebAuthExistsForDecisionMock.mockReset().mockResolvedValue({
      outcome: "stable",
      exists: false,
    });
    getActiveWebListenerMock.mockReset().mockReturnValue(null);
    readWebSelfIdMock.mockReset().mockReturnValue({ e164: null, jid: null, lid: null });
    logoutWebMock.mockReset().mockResolvedValue(true);
    renderQrPngDataUrlMock
      .mockReset()
      .mockImplementation(async (input) => `data:image/png;base64,encoded:${input}`);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [408, false],
    [401, false],
    [401, true],
  ] as const)("replaces a status %s connection after QR issued: %s", async (statusCode, issued) => {
    const beforeCredentialPersistence = vi.fn(async () => {});
    queueQrSocket(issued ? "qr-data" : undefined);
    queueQrSocket("replacement-qr");
    waitForWaConnectionMock
      .mockRejectedValueOnce({ output: { statusCode } })
      .mockImplementation(waitForever);
    if (!issued && statusCode === 401) {
      authExists(true);
    }
    const start = await startQr(accountId, { beforeCredentialPersistence });
    if (issued) {
      expectScanQrResult(start);
      expectQrRefreshResult(await waitForQr(start.qrDataUrl, accountId), "replacement-qr");
    } else {
      expectScanQrResult(start, "replacement-qr");
    }
    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    if (statusCode === 401) {
      expect(logoutWebMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          authDir: expect.stringContaining(accountId),
          isLegacyAuthDir: false,
          runtime: expect.anything(),
          beforeCredentialPersistence: expect.any(Function),
        }),
      );
    }
  });

  it("reports the QR deadline without an unhandled rejection during socket startup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const socketReleased = Promise.withResolvers<void>();
    const socketStarting = Promise.withResolvers<void>();
    const close = vi.fn();
    createWaSocketMock.mockImplementationOnce(async () => {
      socketStarting.resolve();
      await socketReleased.promise;
      return { ws: { close } } as never;
    });
    waitForWaConnectionMock.mockImplementation(waitForever);
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    const resultPromise = startQr("qr-timeout-during-socket-startup");
    try {
      await socketStarting.promise;
      await vi.advanceTimersByTimeAsync(5000);
      await waitForNextTask();
      socketReleased.resolve();

      await expectLoginFailure(
        resultPromise,
        "Failed to get QR: Error: Timed out waiting for WhatsApp QR",
      );
      expect(close).toHaveBeenCalledOnce();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      socketReleased.resolve();
      await resultPromise;
    }
  });

  it("clears saved auth for an explicit fresh QR relink", async () => {
    const beforeCredentialPersistence = vi.fn(async () => {});
    getActiveWebListenerMock.mockReturnValue({} as never);
    authExists(true);

    await scanPendingQr(accountId, { force: true, beforeCredentialPersistence });
    expect(logoutWebMock).toHaveBeenCalledWith({
      authDir: expect.stringContaining(accountId),
      isLegacyAuthDir: false,
      runtime: expect.anything(),
      beforeCredentialPersistence: expect.any(Function),
    });
    expect(createWaSocketMock).toHaveBeenCalledWith(
      false,
      false,
      expect.objectContaining({ beforeCredentialPersistence: expect.any(Function) }),
    );
  });

  it("transfers credential writes to the exact active login instance", async () => {
    const authority = revocableAuthority();
    let accountCurrent = true;
    const assertCredentialPersistenceCurrent = () => {
      if (!accountCurrent) {
        throw new Error("account changed");
      }
    };
    const beforeCredentialPersistence = authority.check;
    await scanPendingQr(accountId, {
      beforeCredentialPersistence,
      assertCredentialPersistenceCurrent,
    });
    const operationGuard = createWaSocketMock.mock.calls[0]?.[2]?.beforeCredentialPersistence;
    expect(operationGuard).toEqual(expect.any(Function));
    expect(operationGuard).not.toBe(beforeCredentialPersistence);

    authority.revoke();
    await expect(operationGuard?.()).resolves.toBeUndefined();

    accountCurrent = false;
    await expect(operationGuard?.()).rejects.toThrow("account changed");
    accountCurrent = true;

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3 * 60_000 + 1);
    await expectLoginFailure(
      waitForWebLogin({ timeoutMs: 1000, accountId }),
      "The login QR expired. Ask me to generate a new one.",
      true,
    );
    await expect(operationGuard?.()).rejects.toThrow("WhatsApp login is no longer active");
  });

  it.each(["unguarded", "stale", "current"])(
    "handles a %s cached QR account binding",
    async (binding) => {
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("account changed");
        }
      };
      waitForWaConnectionMock.mockImplementation(waitForever);
      const first = await startWebLoginWithQr({
        accountId,
        ...(binding === "unguarded" ? {} : { assertCredentialPersistenceCurrent: assertCurrent }),
      });
      expectScanQrResult(first);
      current = binding === "current";
      const next = await startWebLoginWithQr({
        accountId,
        assertCredentialPersistenceCurrent: () => {},
      });
      expect(next.qrDataUrl).toBe(first.qrDataUrl);
      expect(createWaSocketMock).toHaveBeenCalledTimes(binding === "current" ? 1 : 2);
    },
  );

  it("revalidates authority after auth inspection and before forced credential cleanup", async () => {
    const authState = Promise.withResolvers<{ outcome: "stable"; exists: true }>();
    const authority = revocableAuthority();
    const beforeCredentialPersistence = authority.check;
    readWebAuthExistsForDecisionMock.mockReturnValueOnce(authState.promise);
    logoutWebMock.mockImplementationOnce(async (options) => {
      await options.beforeCredentialPersistence?.();
      return true;
    });

    const resultPromise = startQr(accountId, { force: true, beforeCredentialPersistence });
    await vi.waitFor(() => expect(readWebAuthExistsForDecisionMock).toHaveBeenCalledOnce());
    authority.revoke();
    authState.resolve({ outcome: "stable", exists: true });

    await expectLoginFailure(
      resultPromise,
      "WhatsApp login failed: formatted:Error: plugin tool host authority is no longer active",
    );
    expect(beforeCredentialPersistence).toHaveBeenCalledOnce();
    expect(createWaSocketMock).not.toHaveBeenCalled();
  });

  it("rejects ownership transfer when bootstrap authority closes during socket creation", async () => {
    const socketReleased = Promise.withResolvers<void>();
    const socketStarting = Promise.withResolvers<void>();
    createWaSocketMock.mockImplementationOnce(async (_printQr, _verbose, options) => {
      await options?.beforeCredentialPersistence?.();
      socketStarting.resolve();
      await socketReleased.promise;
      return { ws: { close: vi.fn() } } as never;
    });
    const authority = revocableAuthority();
    const beforeCredentialPersistence = authority.check;

    const resultPromise = startQr("revoked-before-transfer", { beforeCredentialPersistence });
    await socketStarting.promise;
    authority.revoke();
    socketReleased.resolve();

    await expectLoginFailure(
      resultPromise,
      "Failed to start WhatsApp login: Error: plugin tool host authority is no longer active",
    );
    expect(beforeCredentialPersistence).toHaveBeenCalledTimes(2);
    await expect(
      waitForWebLogin({ timeoutMs: 1000, accountId: "revoked-before-transfer" }),
    ).resolves.toEqual(noActiveResult);
  });

  it.each([
    [false, false],
    [true, false],
    [true, new Error("cleanup failed")],
  ] as const)("reports cleanup failure after QR issued: %s (%s)", async (issued, cleanup) => {
    if (!issued) {
      queueQrSocket();
    }
    waitForWaConnectionMock.mockRejectedValueOnce({ output: { statusCode: 401 } });
    authExists(!issued, true);
    if (cleanup instanceof Error) {
      logoutWebMock.mockRejectedValueOnce(cleanup);
    } else {
      logoutWebMock.mockResolvedValueOnce(cleanup);
    }
    const start = issued ? await scanQr(accountId) : await startQr(accountId);
    await expectLoginFailure(
      issued ? waitForQr(start.qrDataUrl, accountId) : Promise.resolve(start),
      cleanup instanceof Error ? "WhatsApp login failed: cleanup failed" : cleanupFailureMessage,
      issued,
    );
    expect(createWaSocketMock).toHaveBeenCalledOnce();
  });

  it("uses the linked shortcut after successful QR relink starts a listener", async () => {
    const login = Promise.withResolvers<void>();
    waitForWaConnectionMock.mockReturnValueOnce(login.promise);
    authExists(false, true, true);
    readWebSelfIdMock.mockReturnValue({ e164: "+15551234567", jid: null, lid: null });

    const start = await scanQr(accountId);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const waiting = waitForQr(start.qrDataUrl, accountId);
    await waitForNextTask();
    expect(vi.getTimerCount()).toBe(1);
    login.resolve();
    await expect(waiting).resolves.toEqual(linkedResult);
    expect(vi.getTimerCount()).toBe(0);

    logoutWebMock.mockClear();
    getActiveWebListenerMock.mockReturnValue({} as never);
    await expect(startQr(accountId)).resolves.toEqual({
      message: "WhatsApp is already linked (+15551234567). Say “relink” if you want a fresh QR.",
    });
    expect(createWaSocketMock).toHaveBeenCalledOnce();
    expect(logoutWebMock).not.toHaveBeenCalled();
  });

  it("caps oversized wait timeouts to a timer-safe delay", async () => {
    const start = await scanPendingQr(accountId);

    vi.useFakeTimers();
    const resultPromise = waitForQr(start.qrDataUrl, accountId, Number.MAX_SAFE_INTEGER);

    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    await expect(resultPromise).resolves.toEqual({
      connected: false,
      message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
    });
  });

  it("keeps the QR wait deadline monotonic when the wall clock is rewound", async () => {
    await scanPendingQr(accountId);
    const onQr = createWaSocketMock.mock.calls[0]?.[2]?.onQr;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });

    const settled = vi.fn();
    const waiting = waitForWebLogin({ timeoutMs: 2000, accountId }).then(settled);
    await flushTasks();

    vi.setSystemTime(Date.now() - 60_000);
    onQr?.("qr-data-2");

    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toHaveBeenCalledWith({
        connected: false,
        message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
      });
    } finally {
      await vi.advanceTimersByTimeAsync(60_000);
      await waiting;
    }
  });

  it("returns an unstable-auth result when creds flush does not settle", async () => {
    readWebAuthExistsForDecisionMock.mockResolvedValueOnce({ outcome: "unstable" });

    await expect(startQr()).resolves.toEqual({
      code: WHATSAPP_AUTH_UNSTABLE_CODE,
      message: "WhatsApp auth state is still stabilizing. Retry login in a moment.",
    });
    expect(createWaSocketMock).not.toHaveBeenCalled();
  });

  it("reports a recovered linked session when saved auth has no active listener", async () => {
    queueQrSocket();
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    readWebSelfIdMock.mockReturnValueOnce({ e164: "+5511977000000", jid: null, lid: null });
    readWebAuthExistsForDecisionMock.mockResolvedValue({ outcome: "stable", exists: true });

    const result = await startQr();

    expect(result).toEqual({
      connected: true,
      message: "WhatsApp recovered the existing linked session (+5511977000000).",
    });
    expect(createWaSocketMock).toHaveBeenCalledOnce();
    await expect(waitForWebLogin({ timeoutMs: 1000 })).resolves.toEqual(noActiveResult);
  });

  it("does not short-circuit on an existing QR when the waiter has no current QR image", async () => {
    waitForWaConnectionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(undefined), 20);
        }),
    );
    authExists(false).mockResolvedValue({ outcome: "stable", exists: true });

    await scanQr(accountId);
    await expect(waitForWebLogin({ timeoutMs: 5000, accountId })).resolves.toEqual(linkedResult);
  });

  it("returns a terminal login result before a stale QR refresh", async () => {
    const login = Promise.withResolvers<void>();
    queueQrSocket("qr-data", { qr: "qr-data-2", delayMs: 20 });
    waitForWaConnectionMock.mockReturnValueOnce(login.promise);
    authExists(false).mockResolvedValue({ outcome: "stable", exists: true });

    const start = await scanQr(accountId);

    await waitForQrRenderCallCount(2);
    login.resolve();
    await vi.waitFor(() => expect(readWebAuthExistsForDecisionMock).toHaveBeenCalledTimes(2));
    await waitForNextTask();

    await expect(waitForQr(start.qrDataUrl, accountId)).resolves.toEqual(linkedResult);
  });

  it.each(["connected", "failed"] as const)(
    "starts a fresh login after the previous login %s before wait consumes it",
    async (outcome) => {
      const firstConnection = Promise.withResolvers<void>();
      const replacementConnection = Promise.withResolvers<void>();
      const persistedAuthCheck = Promise.withResolvers<void>();
      queueQrSocket("first-qr");
      waitForWaConnectionMock
        .mockReturnValueOnce(firstConnection.promise)
        .mockReturnValueOnce(replacementConnection.promise);
      authExists(false);
      if (outcome === "connected") {
        readWebAuthExistsForDecisionMock.mockImplementationOnce(async () => {
          persistedAuthCheck.resolve();
          return { outcome: "stable", exists: true };
        });
      }

      const first = await startQr(accountId);
      expectScanQrResult(first, "first-qr");

      if (outcome === "connected") {
        firstConnection.resolve();
        await persistedAuthCheck.promise;
      } else {
        firstConnection.reject(new Error("WhatsApp connection failed"));
      }
      await flushTasks();
      await waitForNextTask();

      readWebAuthExistsForDecisionMock.mockResolvedValue({ outcome: "stable", exists: true });
      queueQrSocket("replacement-qr");
      const replacement = await startQr(accountId);

      expectScanQrResult(replacement, "replacement-qr");
      expect(createWaSocketMock).toHaveBeenCalledTimes(2);

      const waitForReplacement = waitForQr(replacement.qrDataUrl, accountId);
      replacementConnection.resolve();
      await expect(waitForReplacement).resolves.toEqual(linkedResult);
    },
  );

  it("returns a terminal result when an older replaced waiter resolves without state", async () => {
    const firstConnection = Promise.withResolvers<void>();
    waitForWaConnectionMock
      .mockReturnValueOnce(firstConnection.promise)
      .mockImplementation(waitForever);

    const start = await scanQr(accountId);

    const waiter = waitForQr(start.qrDataUrl, accountId, 1000);
    await flushTasks();

    const now = Date.now();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now + 3 * 60_000 + 1000);
    try {
      await scanQr(accountId);

      firstConnection.resolve();

      await expect(waiter).resolves.toEqual({
        connected: false,
        message: "Login ended without a connection.",
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it.each([false, true])(
    "reuses the current QR during a pending render (rotates again: %s)",
    async (rotateAgain) => {
      const start = await scanPendingQr(accountId);
      const onQr = createWaSocketMock.mock.calls[0]?.[2]?.onQr;
      const olderRender = Promise.withResolvers<string>();
      renderQrPngDataUrlMock.mockImplementationOnce(() => olderRender.promise);
      if (rotateAgain) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const waiting = rotateAgain ? waitForQr(start.qrDataUrl, accountId, 1000) : undefined;
      onQr?.("qr-data-2");
      if (rotateAgain) {
        onQr?.("qr-data-3");
        await vi.advanceTimersByTimeAsync(1000);
        expectQrRefreshResult(await waiting, "qr-data-3");
        olderRender.resolve(encodedQr("qr-data-2"));
      }
      await flushTasks();
      expect(await startQr(accountId)).toEqual({
        qrDataUrl: encodedQr(rotateAgain ? "qr-data-3" : "qr-data"),
        message: "QR already active. Scan it in WhatsApp → Linked Devices.",
      });
      expect(createWaSocketMock).toHaveBeenCalledOnce();
      expect(renderQrPngDataUrlMock.mock.calls.map(([qr]) => qr)).toEqual(
        rotateAgain ? ["qr-data", "qr-data-2", "qr-data-3"] : ["qr-data", "qr-data-2"],
      );
    },
  );

  it("deduplicates initial QR rendering while the start path awaits the same image", async () => {
    const render = Promise.withResolvers<string>();
    renderQrPngDataUrlMock.mockReturnValueOnce(render.promise);
    waitForWaConnectionMock.mockImplementation(waitForever);

    const resultPromise = startQr(accountId);
    await waitForQrRenderCallCount(1);

    expect(renderQrPngDataUrlMock).toHaveBeenCalledTimes(1);

    render.resolve(encodedQr("qr-data"));
    expectScanQrResult(await resultPromise);
    expect(renderQrPngDataUrlMock).toHaveBeenCalledTimes(1);
  });

  it("returns the same rotated QR to concurrent waiters that share the same current image", async () => {
    queueQrSocket("qr-data", { qr: "qr-data-2", delayMs: 100 });
    const start = await scanPendingQr(accountId);

    const waiterA = waitForQr(start.qrDataUrl, accountId);
    const waiterB = waitForQr(start.qrDataUrl, accountId);

    await flushTasks();
    await waitMs(140);
    await flushTasks();

    expectQrRefreshResult(await waiterA, "qr-data-2");
    expectQrRefreshResult(await waiterB, "qr-data-2");
  });
});
