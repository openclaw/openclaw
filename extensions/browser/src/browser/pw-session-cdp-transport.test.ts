import { EventEmitter } from "node:events";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { isWSL2Sync } from "openclaw/plugin-sdk/runtime-env";
import { chromium, type ConnectOverCDPTransport } from "playwright-core";
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

it("gives Windows Chrome a Windows download path from WSL2", async () => {
  const localPath = "/tmp/playwright-artifacts-test";
  const windowsPath = String.raw`\\wsl.localhost\Ubuntu\tmp\playwright-artifacts-test`;
  vi.mocked(isWSL2Sync).mockReturnValue(true);
  vi.mocked(runExec).mockResolvedValue({ stdout: `${windowsPath}\n`, stderr: "" });
  const socket = new EventEmitter();
  const send = vi.fn((raw: string) => {
    const { id, method } = JSON.parse(raw);
    const result = method === "Browser.getVersion" ? { userAgent: "(Windows NT 10.0)" } : {};
    socket.emit("message", JSON.stringify({ id, result }));
  });
  vi.mocked(openCdpWebSocket).mockImplementationOnce(() => {
    queueMicrotask(() => socket.emit("open"));
    return Object.assign(socket, { send, close: vi.fn() }) as never;
  });
  const params = { behavior: "allowAndName", downloadPath: localPath, eventsEnabled: true };
  connectOverCdpSpy.mockImplementationOnce((async (transport: ConnectOverCDPTransport) => {
    for (const [id, method] of [
      [1, "Browser.getVersion"],
      [2, "Browser.setDownloadBehavior"],
    ] as const) {
      const { promise, resolve } = Promise.withResolvers<void>();
      Object.assign(transport, { onmessage: () => resolve() });
      transport.send({ id, method, params });
      await promise;
    }
    return {};
  }) as never);

  await connectOverCdpTransport("ws://127.0.0.1:18799", { timeout: 1000, headers: {} });
  expect(JSON.parse(send.mock.lastCall![0]).params.downloadPath).toBe(windowsPath);
  expect(params.downloadPath).toBe(localPath);
});
