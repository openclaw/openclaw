import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnoseChromeCdp } from "./chrome.diagnostics.js";
import * as chrome from "./chrome.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

type ProbePhase = "http" | "handshake" | "command";

async function startCdpFixture(
  options: {
    hold?: ProbePhase;
    holdCommand?: boolean;
    advertisedUrl?: string;
  } = {},
) {
  const reached = {
    http: createDeferred<void>(),
    handshake: createDeferred<void>(),
    command: createDeferred<void>(),
  };
  const disconnected = {
    http: createDeferred<void>(),
    handshake: createDeferred<void>(),
    command: createDeferred<void>(),
  };
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  let releaseUpgrade = () => {};
  let releaseCommand = () => {};
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    request.socket.once("close", () => disconnected.http.resolve());
    reached.http.resolve();
    if (options.hold === "http") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"Browser":');
      return;
    }
    const port = (server.address() as AddressInfo).port;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        webSocketDebuggerUrl:
          options.advertisedUrl ?? `ws://127.0.0.1:${port}/devtools/browser/test`,
      }),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("end", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    socket.once("close", () => disconnected.handshake.resolve());
    releaseUpgrade = () =>
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.once("close", () => disconnected.command.resolve());
        ws.on("message", (raw) => {
          const message = JSON.parse(rawDataToString(raw)) as { id: number; method: string };
          expect(message.method).toBe("Browser.getVersion");
          releaseCommand = () =>
            ws.send(
              JSON.stringify({
                id: message.id,
                result: { product: "Chrome/Fixture" },
              }),
            );
          reached.command.resolve();
          if (options.hold !== "command" && !options.holdCommand) {
            releaseCommand();
          }
        });
      });
    reached.handshake.resolve();
    if (options.hold !== "handshake") {
      releaseUpgrade();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    reached,
    requests,
    disconnected,
    releaseUpgrade: () => releaseUpgrade(),
    releaseCommand: () => releaseCommand(),
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all([
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
      ]);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Chrome CDP diagnostic transport", () => {
  it("gives the health command its full timeout after a delayed handshake", async () => {
    const fixture = await startCdpFixture({ hold: "handshake", holdCommand: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const probing = diagnoseChromeCdp(fixture.url, 1_000, 1_000);
      await fixture.reached.handshake.promise;
      await vi.advanceTimersByTimeAsync(600);
      fixture.releaseUpgrade();
      await fixture.reached.command.promise;
      await vi.advanceTimersByTimeAsync(600);
      fixture.releaseCommand();

      await expect(probing).resolves.toMatchObject({ ok: true });
    } finally {
      await fixture.close();
    }
  });

  it.each<ProbePhase>(["http", "handshake", "command"])(
    "cancels an in-flight %s probe without fallback or leftover sockets",
    async (phase) => {
      const fixture = await startCdpFixture({ hold: phase });
      const controller = new AbortController();
      const reason = new Error("diagnostic request cancelled");
      const watchdog = new AbortController();
      try {
        const probing = diagnoseChromeCdp(
          fixture.url,
          60_000,
          60_000,
          undefined,
          controller.signal,
        ).then(
          (result) => result,
          (error: unknown) => error,
        );
        await fixture.reached[phase].promise;
        controller.abort(reason);

        // A separate watchdog bounds a broken cancellation path; it never advances
        // the much longer transport deadline or changes the diagnostic behavior.
        await expect(
          Promise.race([
            probing,
            delay(2_000, "probe did not cancel", { signal: watchdog.signal }),
          ]),
        ).resolves.toBe(reason);
        await fixture.disconnected[phase].promise;
        expect(fixture.requests).toEqual(["/json/version"]);
      } finally {
        watchdog.abort();
        await fixture.close();
      }
    },
  );

  it("reports malformed advertised WebSocket URLs as a failed diagnostic", async () => {
    const fixture = await startCdpFixture({ advertisedUrl: "not-a-url" });
    try {
      await expect(diagnoseChromeCdp(fixture.url)).resolves.toMatchObject({
        ok: false,
        code: "websocket_handshake_failed",
      });
    } finally {
      await fixture.close();
    }
  });

  it("cancels discovery through the default-profile context", async () => {
    const fixture = await startCdpFixture({ hold: "http" });
    const controller = new AbortController();
    const watchdog = new AbortController();
    const reason = new Error("default profile probe cancelled");
    const state = makeBrowserServerState({
      profile: makeBrowserProfile({
        cdpUrl: fixture.url,
        cdpPort: Number(new URL(fixture.url).port),
      }),
    });
    const context = createBrowserRouteContext({ getState: () => state });
    try {
      const probing = context
        .isHttpReachable(60_000, controller.signal)
        .catch((error: unknown) => error);
      await fixture.reached.http.promise;
      controller.abort(reason);
      await expect(
        Promise.race([probing, delay(2_000, "probe did not cancel", { signal: watchdog.signal })]),
      ).resolves.toBe(reason);
      await fixture.disconnected.http.promise;
      expect(fixture.requests).toEqual(["/json/version"]);
    } finally {
      watchdog.abort();
      await fixture.close();
    }
  });

  it("stops a profile while its readiness command is pending", async () => {
    const fixture = await startCdpFixture({ hold: "command" });
    const watchdog = new AbortController();
    vi.spyOn(chrome, "stopOwnedOpenClawChrome").mockResolvedValue({ status: "not-running" });
    const state = makeBrowserServerState({
      profile: makeBrowserProfile({
        cdpUrl: fixture.url,
        cdpPort: Number(new URL(fixture.url).port),
      }),
    });
    const profile = createBrowserRouteContext({ getState: () => state }).forProfile();
    let stopping: Promise<unknown> | undefined;
    try {
      const probing = profile.isReachable(60_000).catch((error: unknown) => error);
      await fixture.reached.command.promise;
      stopping = profile.stopRunningBrowser();
      await expect(
        Promise.race([probing, delay(2_000, "probe did not cancel", { signal: watchdog.signal })]),
      ).resolves.toMatchObject({ message: expect.stringContaining("lifecycle changed") });
      await expect(stopping).resolves.toEqual({ stopped: true });
      await fixture.disconnected.command.promise;
    } finally {
      watchdog.abort();
      await fixture.close();
      await stopping;
    }
  });
});
