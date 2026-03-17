import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rmMock = vi.spyOn(fs, "rm");

function resolveTestAuthDir() {
  return path.join(os.tmpdir(), "wa-creds");
}

const authDir = resolveTestAuthDir();

const mocks = vi.hoisted(() => {
  const sockA = { ws: { close: vi.fn() } };
  const sockB = { ws: { close: vi.fn() } };
  let call = 0;
  return {
    loadConfig: vi.fn(
      () =>
        ({
          channels: {
            whatsapp: {
              accounts: {
                default: { enabled: true, authDir: resolveTestAuthDir() },
              },
            },
          },
        }) as never,
    ),
    createWaSocket: vi.fn(async () => (call++ === 0 ? sockA : sockB)),
    waitForWaConnection: vi.fn(),
    formatError: vi.fn((err: unknown) => `formatted:${String(err)}`),
    getStatusCode: vi.fn(
      (err: unknown) =>
        (err as { output?: { statusCode?: number } })?.output?.statusCode ??
        (err as { status?: number })?.status ??
        (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode,
    ),
    waitForCredsSaveQueueWithTimeout: vi.fn(async () => {}),
    logoutWeb: vi.fn(async (params: { authDir?: string }) => {
      await fs.rm(params.authDir ?? authDir, {
        recursive: true,
        force: true,
      });
      return true;
    }),
    resetSocketFactory() {
      call = 0;
      sockA.ws.close.mockClear();
      sockB.ws.close.mockClear();
    },
  };
});

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    defaultRuntime: {},
    danger: (msg: string) => msg,
    info: (msg: string) => msg,
    success: (msg: string) => msg,
  };
});

vi.mock("openclaw/plugin-sdk/text-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-runtime")>();
  return {
    ...actual,
    logInfo: vi.fn(),
  };
});

vi.mock("./session.js", () => ({
  createWaSocket: mocks.createWaSocket,
  waitForWaConnection: mocks.waitForWaConnection,
  formatError: mocks.formatError,
  getStatusCode: mocks.getStatusCode,
  waitForCredsSaveQueueWithTimeout: mocks.waitForCredsSaveQueueWithTimeout,
  WA_WEB_AUTH_DIR: authDir,
  logoutWeb: mocks.logoutWeb,
}));

let loginWeb: typeof import("./login.js").loginWeb;

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("loginWeb coverage", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();
    rmMock.mockClear();
    mocks.resetSocketFactory();
    ({ loginWeb } = await import("./login.js"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts once when WhatsApp requests code 515", async () => {
    let releaseCredsFlush: (() => void) | undefined;
    const credsFlushGate = new Promise<void>((resolve) => {
      releaseCredsFlush = resolve;
    });
    mocks.waitForWaConnection
      .mockRejectedValueOnce({ error: { output: { statusCode: 515 } } })
      .mockResolvedValueOnce(undefined);
    mocks.waitForCredsSaveQueueWithTimeout.mockReturnValueOnce(credsFlushGate);

    const runtime = { log: vi.fn(), error: vi.fn() } as never;
    const pendingLogin = loginWeb(false, mocks.waitForWaConnection as never, runtime);
    await flushTasks();

    expect(mocks.createWaSocket).toHaveBeenCalledTimes(1);
    expect(mocks.waitForCredsSaveQueueWithTimeout).toHaveBeenCalledOnce();
    expect(mocks.waitForCredsSaveQueueWithTimeout).toHaveBeenCalledWith(authDir);

    releaseCredsFlush?.();
    await pendingLogin;

    expect(mocks.createWaSocket).toHaveBeenCalledTimes(2);
    const firstSock = await mocks.createWaSocket.mock.results[0]?.value;
    expect(firstSock.ws.close).toHaveBeenCalled();
    vi.runAllTimers();
    const secondSock = await mocks.createWaSocket.mock.results[1]?.value;
    expect(secondSock.ws.close).toHaveBeenCalled();
  });

  it("clears creds and throws when logged out", async () => {
    mocks.waitForWaConnection.mockRejectedValueOnce({
      output: { statusCode: DisconnectReason.loggedOut },
    });

    await expect(loginWeb(false, mocks.waitForWaConnection as never)).rejects.toThrow(
      /cache cleared/i,
    );
    expect(rmMock).toHaveBeenCalledWith(authDir, {
      recursive: true,
      force: true,
    });
  });

  it("formats and rethrows generic errors", async () => {
    mocks.waitForWaConnection.mockRejectedValueOnce(new Error("boom"));
    await expect(loginWeb(false, mocks.waitForWaConnection as never)).rejects.toThrow(
      "formatted:Error: boom",
    );
    expect(mocks.formatError).toHaveBeenCalled();
  });
});
