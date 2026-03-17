import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createWaSocketMock = vi.fn(
  async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
    const sock = { ws: { close: vi.fn() } };
    if (opts?.onQr) {
      setImmediate(() => opts.onQr?.("qr-data"));
    }
    return sock;
  },
);
const waitForWaConnectionMock = vi.fn();
const formatErrorMock = vi.fn((err: unknown) => `formatted:${String(err)}`);
const getStatusCodeMock = vi.fn(
  (err: unknown) =>
    (err as { output?: { statusCode?: number } })?.output?.statusCode ??
    (err as { status?: number })?.status ??
    (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode,
);
const webAuthExistsMock = vi.fn(async () => false);
const readWebSelfIdMock = vi.fn(() => ({ e164: null, jid: null }));
const logoutWebMock = vi.fn(async () => true);
const waitForCredsSaveQueueWithTimeoutMock = vi.fn(async () => {});
async function loadSubject() {
  vi.doMock("./session.js", () => ({
    createWaSocket: createWaSocketMock,
    waitForWaConnection: waitForWaConnectionMock,
    formatError: formatErrorMock,
    getStatusCode: getStatusCodeMock,
    webAuthExists: webAuthExistsMock,
    readWebSelfId: readWebSelfIdMock,
    logoutWeb: logoutWebMock,
    waitForCredsSaveQueueWithTimeout: waitForCredsSaveQueueWithTimeoutMock,
  }));

  return import("./login-qr.js");
}

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("login-qr", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock("./session.js");
  });

  it("restarts login once on status 515 and completes", async () => {
    const { startWebLoginWithQr, waitForWebLogin } = await loadSubject();
    let releaseCredsFlush: (() => void) | undefined;
    const credsFlushGate = new Promise<void>((resolve) => {
      releaseCredsFlush = resolve;
    });
    waitForWaConnectionMock
      // Baileys v7 wraps the error: { error: BoomError(515) }
      .mockRejectedValueOnce({ error: { output: { statusCode: 515 } } })
      .mockResolvedValueOnce(undefined);
    waitForCredsSaveQueueWithTimeoutMock.mockReturnValueOnce(credsFlushGate);

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    const resultPromise = waitForWebLogin({ timeoutMs: 5000 });
    await flushTasks();
    await flushTasks();

    expect(createWaSocketMock).toHaveBeenCalledTimes(1);
    expect(waitForCredsSaveQueueWithTimeoutMock).toHaveBeenCalledOnce();
    expect(waitForCredsSaveQueueWithTimeoutMock).toHaveBeenCalledWith(expect.any(String));

    releaseCredsFlush?.();
    const result = await resultPromise;

    expect(result.connected).toBe(true);
    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    expect(logoutWebMock).not.toHaveBeenCalled();
  });

  it("refreshes the active QR when WhatsApp rotates refs", async () => {
    const { startWebLoginWithQr } = await loadSubject();
    let emitQr: ((qr: string) => void) | undefined;
    createWaSocketMock.mockImplementationOnce(
      async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
        emitQr = opts?.onQr;
        const sock = { ws: { close: vi.fn() } };
        setImmediate(() => emitQr?.("qr-1"));
        return sock as never;
      },
    );
    waitForWaConnectionMock.mockReturnValue(new Promise<void>(() => {}));

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    emitQr?.("qr-2");
    await flushTasks();
    await flushTasks();

    const refreshed = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(refreshed.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(refreshed.qrDataUrl).not.toBe(start.qrDataUrl);
  });

  it("preserves an early QR emitted before the active login is registered", async () => {
    const { startWebLoginWithQr } = await loadSubject();
    createWaSocketMock.mockImplementationOnce(
      async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
        opts?.onQr?.("qr-early");
        return { ws: { close: vi.fn() } } as never;
      },
    );
    waitForWaConnectionMock.mockReturnValue(new Promise<void>(() => {}));

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });

    expect(start.message).toContain("Scan this QR");
    expect(start.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
