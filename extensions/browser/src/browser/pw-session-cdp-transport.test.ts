import { EventEmitter } from "node:events";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { isWSL2Sync } from "openclaw/plugin-sdk/runtime-env";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCdpWebSocket } from "./cdp.helpers.js";
import { connectOverCdpTransport } from "./pw-session-cdp-transport.js";

vi.mock("openclaw/plugin-sdk/process-runtime", { spy: true });
vi.mock("openclaw/plugin-sdk/runtime-env", { spy: true });
vi.mock("./cdp.helpers.js", { spy: true });

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");

afterEach(() => {
  connectOverCdpSpy.mockReset();
  vi.mocked(openCdpWebSocket).mockReset();
  vi.mocked(runExec).mockReset();
  vi.mocked(isWSL2Sync).mockReset();
});

function mockPageInitializationFailure(
  wire: import("playwright-core").ConnectOverCDPTransport,
  sessionId: string,
  targetId: string,
  transition?: () => void,
) {
  connectOverCdpSpy.mockImplementationOnce((async (value: unknown) => {
    const transport = value as import("playwright-core").ConnectOverCDPTransport;
    wire.onmessage?.({
      method: "Target.attachedToTarget",
      params: {
        sessionId,
        targetInfo: { targetId, type: "page", browserContextId: "default-context" },
      },
    });
    transport.send({ id: 7, method: "Runtime.enable", sessionId });
    transition?.();
    const error = new Error("Timeout 1000ms exceeded");
    error.name = "TimeoutError";
    throw error;
  }) as never);
}

describe("Playwright CDP initialization diagnostics", () => {
  it("identifies the page target whose initialization blocks a cold connection", async () => {
    const closeWire = vi.fn();
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: vi.fn(),
      close: closeWire,
    };
    mockPageInitializationFailure(wire, "stalled-session", "STALLED-PAGE");

    const connection = connectOverCdpTransport("http://127.0.0.1:18799", {
      timeout: 1000,
      headers: {},
      preparedTransport: wire,
    });
    await expect(connection).rejects.toThrow(
      'page target "STALLED-PAGE" did not respond during initialization',
    );
    await expect(connection).rejects.toThrow(
      "Close the target in the browser or provider dashboard",
    );
    expect(closeWire).toHaveBeenCalledOnce();
  });

  it("forgets unanswered commands when their page session detaches", async () => {
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: vi.fn(),
      close: vi.fn(),
    };
    mockPageInitializationFailure(wire, "detached-session", "DETACHED-PAGE", () => {
      wire.onmessage?.({
        method: "Target.detachedFromTarget",
        params: { sessionId: "detached-session" },
      });
    });

    await expect(
      connectOverCdpTransport("http://127.0.0.1:18799", {
        timeout: 1000,
        headers: {},
        preparedTransport: wire,
      }),
    ).rejects.toThrow("Timeout 1000ms exceeded");
  });

  it("does not blame a target whose initialization command completed", async () => {
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: vi.fn(),
      close: vi.fn(),
    };
    mockPageInitializationFailure(wire, "healthy-session", "HEALTHY-PAGE", () => {
      wire.onmessage?.({ id: 7, result: {} });
    });

    await expect(
      connectOverCdpTransport("http://127.0.0.1:18799", {
        timeout: 1000,
        headers: {},
        preparedTransport: wire,
      }),
    ).rejects.toThrow("Timeout 1000ms exceeded");
  });
});

describe("Playwright CDP download paths", () => {
  it.each([
    { wsl: true, userAgent: "Mozilla/5.0 (Windows NT 10.0)", translate: true },
    { wsl: true, userAgent: "Mozilla/5.0 (X11; Linux x86_64)", translate: false },
    { wsl: false, userAgent: "Mozilla/5.0 (Windows NT 10.0)", translate: false },
    {
      wsl: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0)",
      host: "chrome.example",
      translate: false,
    },
    {
      wsl: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0)",
      translate: false,
      unavailable: true,
    },
  ])(
    "keeps Playwright's directory local (case %#)",
    async ({ wsl, userAgent, translate, host = "127.0.0.1", unavailable = false }) => {
      const localPath = "/tmp/playwright-artifacts-test";
      const windowsPath = String.raw`\\wsl.localhost\Ubuntu\tmp\playwright-artifacts-test`;
      vi.mocked(isWSL2Sync).mockReturnValue(wsl);
      if (unavailable) {
        vi.mocked(runExec).mockRejectedValue(new Error("wslpath unavailable"));
      } else {
        vi.mocked(runExec).mockResolvedValue({ stdout: windowsPath + "\n", stderr: "" });
      }

      const socket = new EventEmitter();
      const send = vi.fn((raw: string) => {
        const command = JSON.parse(raw);
        const result = command.method === "Browser.getVersion" ? { userAgent } : {};
        socket.emit("message", JSON.stringify({ id: command.id, result }));
      });
      vi.mocked(openCdpWebSocket).mockImplementationOnce(() => {
        queueMicrotask(() => socket.emit("open"));
        return Object.assign(socket, { send, close: vi.fn() }) as unknown as ReturnType<
          typeof openCdpWebSocket
        >;
      });
      const downloadCommand = {
        id: 2,
        method: "Browser.setDownloadBehavior",
        params: { behavior: "allowAndName", downloadPath: localPath, eventsEnabled: true },
      };
      const browser = {} as import("playwright-core").Browser;
      connectOverCdpSpy.mockImplementationOnce(async (value: unknown) => {
        const transport = value as import("playwright-core").ConnectOverCDPTransport;
        const reply = () =>
          new Promise<void>((resolve) => {
            Object.assign(transport, { onmessage: () => resolve() });
          });
        const version = reply();
        transport.send({ id: 1, method: "Browser.getVersion" });
        await version;
        const downloads = reply();
        transport.send(downloadCommand);
        await downloads;
        return browser;
      });

      await expect(
        connectOverCdpTransport(`ws://${host}:18799`, { timeout: 1000, headers: {} }),
      ).resolves.toBe(browser);
      expect(send).toHaveBeenLastCalledWith(
        JSON.stringify({
          ...downloadCommand,
          params: { ...downloadCommand.params, downloadPath: translate ? windowsPath : localPath },
        }),
      );
      expect(downloadCommand.params.downloadPath).toBe(localPath);
      if (translate || unavailable) {
        expect(runExec).toHaveBeenCalledExactlyOnceWith("wslpath", ["-w", localPath], 1000);
      } else {
        expect(runExec).not.toHaveBeenCalled();
      }
    },
  );
});
