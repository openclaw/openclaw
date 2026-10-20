import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { loginWeb } from "./login.js";
import { renderQrTerminal } from "./qr-terminal.js";
import { createWaSocket, formatError, waitForWaConnection } from "./session.js";

const rmMock = vi.spyOn(fs, "rm");
const testState = vi.hoisted(() => ({
  authDir: `${(process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")}/openclaw-wa-creds-${process.pid}-${Math.random().toString(16).slice(2)}`,
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    captureRuntimeConfigAsyncReader: () => async () => ({
      channels: {
        whatsapp: {
          accounts: {
            default: { enabled: true, authDir: testState.authDir },
          },
        },
      },
    }),
  };
});

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  const sockA = { ws: { close: vi.fn() } };
  const sockB = { ws: { close: vi.fn() } };
  const createWaSocketLocal = vi.fn(async () =>
    createWaSocketLocal.mock.calls.length <= 1 ? sockA : sockB,
  );
  const waitForWaConnectionLocal = vi.fn();
  const formatErrorLocal = vi.fn((err: unknown) => `formatted:${String(err)}`);
  const getStatusCode = vi.fn(
    (err: unknown) =>
      (err as { output?: { statusCode?: number } })?.output?.statusCode ??
      (err as { status?: number })?.status ??
      (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode,
  );
  return {
    ...actual,
    createWaSocket: createWaSocketLocal,
    waitForWaConnection: waitForWaConnectionLocal,
    formatError: formatErrorLocal,
    getStatusCode,
    readWebAuthExistsForDecision: vi.fn(async () => ({
      outcome: "stable" as const,
      exists: true,
    })),
    logoutWeb: vi.fn(async (params: { authDir?: string }) => {
      await fs.rm(params.authDir ?? testState.authDir, {
        recursive: true,
        force: true,
      });
      return true;
    }),
  };
});

vi.mock("./qr-terminal.js", () => ({
  renderQrTerminal: vi.fn(async (qr: string) => `terminal:${qr}\n`),
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const formatErrorMock = vi.mocked(formatError);
const renderQrTerminalMock = vi.mocked(renderQrTerminal);

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function runtimeMessageCalls(fn: ReturnType<typeof createRuntimeSpies>["log"]) {
  return fn.mock.calls.map(([message]) => sanitizeTerminalText(String(message)));
}

describe("loginWeb coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    waitForWaConnectionMock.mockReset().mockResolvedValue(undefined);
    formatErrorMock.mockReset().mockImplementation((err: unknown) => `formatted:${String(err)}`);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });
  afterAll(() => {
    rmSync(testState.authDir, { recursive: true, force: true });
  });

  it("routes QR output through runtime for initial and restart sockets", async () => {
    waitForWaConnectionMock
      .mockRejectedValueOnce({ error: { output: { statusCode: 515 } } })
      .mockResolvedValueOnce(undefined);

    const runtime = createRuntimeSpies();
    await loginWeb(false, waitForWaConnectionMock as never, runtime);

    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    expect(createWaSocketMock.mock.calls[0]?.[0]).toBe(false);
    const initialOpts = createWaSocketMock.mock.calls[0]?.[2];
    const restartOpts = createWaSocketMock.mock.calls[1]?.[2];
    expect(initialOpts?.onQr).toBe(restartOpts?.onQr);

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    try {
      initialOpts?.onQr?.("initial-qr");
      await flushTasks();
      restartOpts?.onQr?.("restart-qr");
      await flushTasks();
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }

    expect(runtime.log).toHaveBeenCalledWith(
      "Open the WhatsApp app, go to Linked Devices, then scan this QR:\nterminal:initial-qr",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "\x1b[2J\x1b[HOpen the WhatsApp app, go to Linked Devices, then scan this QR:\nterminal:restart-qr",
    );
    expect(renderQrTerminalMock).toHaveBeenCalledWith("initial-qr", { small: true });
    expect(renderQrTerminalMock).toHaveBeenCalledWith("restart-qr", { small: true });
    const firstSock = await createWaSocketMock.mock.results[0]?.value;
    expect(firstSock.ws.close).toHaveBeenCalled();
    vi.runAllTimers();
    const secondSock = await createWaSocketMock.mock.results[1]?.value;
    expect(secondSock.ws.close).toHaveBeenCalled();
  });

  it("clears stale creds and continues login when logged out", async () => {
    waitForWaConnectionMock
      .mockRejectedValueOnce({
        output: { statusCode: 401 },
      })
      .mockResolvedValueOnce(undefined);

    const runtime = createRuntimeSpies();
    await loginWeb(false, waitForWaConnectionMock as never, runtime);

    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtimeMessageCalls(runtime.log)).toContain(
      "✅ Linked after restart; web session ready.",
    );
    expect(rmMock).toHaveBeenCalledWith(path.resolve(testState.authDir), {
      recursive: true,
      force: true,
    });
  });

  it("formats and rethrows generic errors", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce(new Error("boom"));
    const runtime = createRuntimeSpies();
    await expect(loginWeb(false, waitForWaConnectionMock as never, runtime)).rejects.toThrow(
      "formatted:Error: boom",
    );
    expect(runtimeMessageCalls(runtime.error)).toEqual([
      "WhatsApp Web connection ended before fully opening. formatted:Error: boom",
    ]);
    expect(formatErrorMock).toHaveBeenCalled();
  });
});
