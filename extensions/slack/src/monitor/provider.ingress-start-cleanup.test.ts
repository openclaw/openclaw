import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSlackHttpTestDispatcher,
  installSlackHttpTestRegistry,
} from "../http/route.test-helpers.js";
import { getSlackTestState, resetSlackTestState } from "../monitor.test-helpers.js";

const ingressStartMock = vi.hoisted(() => vi.fn());
const ingressStopMock = vi.hoisted(() => vi.fn());

vi.mock("./ingress.js", () => ({
  createSlackDurableIngress: () => ({
    wrapReceiver: (receiver: unknown) => receiver,
    acceptRelayEvent: vi.fn(),
    attachRelayDispatch: vi.fn(),
    start: ingressStartMock,
    stop: ingressStopMock,
    waitForIdle: vi.fn(),
  }),
}));

const { monitorSlackProvider } = await import("./provider.js");

beforeEach(async () => {
  await resetSlackTestState();
  ingressStartMock.mockReset();
  ingressStopMock.mockReset().mockResolvedValue(undefined);
});

afterAll(() => {
  vi.doUnmock("./ingress.js");
  vi.resetModules();
});

describe("Slack ingress startup cleanup", () => {
  it("rejects an oversized body before Bolt's void listener reads asynchronously", async () => {
    const registry = installSlackHttpTestRegistry();
    const handleSlackHttpRequest = createSlackHttpTestDispatcher(registry);
    expect(registry.httpRoutes).toHaveLength(0);
    const state = getSlackTestState();
    state.httpRequestListenerMock.mockImplementation((reqValue, resValue) => {
      const req = reqValue as IncomingMessage;
      const res = resValue as ServerResponse;
      // Bolt buffers the full body before signature verification.
      void text(req).then(() => {
        if (!res.headersSent) {
          res.statusCode = 401;
          res.end();
        }
      });
    });
    state.config.channels = { slack: { mode: "http", signingSecret: "test-signing-secret" } };
    const controller = new AbortController();
    const run = monitorSlackProvider({
      scheduler: createTestPluginServiceScheduler(),
      botToken: "bot-token",
      abortSignal: controller.signal,
      config: state.config,
    });
    let clientRequest: ReturnType<typeof request> | undefined;

    try {
      await vi.waitFor(() => expect(ingressStartMock).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(registry.httpRoutes).toHaveLength(1));
      expect(registry.httpRoutes[0]).toMatchObject({
        path: "/slack/events",
        auth: "plugin",
        pluginId: "slack",
        source: "slack-webhook",
      });
      const accepted = createDeferred<void>();
      await withServer(
        (req, res) => {
          accepted.resolve();
          void handleSlackHttpRequest(req, res);
        },
        async (baseUrl) => {
          clientRequest = request(`${baseUrl}/slack/events`, {
            method: "POST",
            headers: { "transfer-encoding": "chunked" },
          });
          clientRequest.on("error", () => {});
          const response = new Promise<IncomingMessage>((resolve, reject) => {
            clientRequest!.once("response", resolve).once("error", reject);
          });
          clientRequest.flushHeaders();

          await accepted.promise;
          await setImmediate();
          clientRequest.write(Buffer.alloc(768 * 1024, 0x61));
          clientRequest.end(Buffer.alloc(768 * 1024, 0x62));

          const received = await response;
          expect({ statusCode: received.statusCode, body: await text(received) }).toEqual({
            statusCode: 413,
            body: "Payload too large",
          });
        },
      );
    } finally {
      clientRequest?.destroy();
      controller.abort();
      await run;
      expect(registry.httpRoutes).toHaveLength(0);
    }
  });

  it("stops ingress and the Bolt transport when ingress start throws", async () => {
    const startError = new Error("durable ingress unavailable");
    ingressStartMock.mockImplementation(() => {
      throw startError;
    });

    await expect(
      monitorSlackProvider({
        scheduler: createTestPluginServiceScheduler(),
        botToken: "bot-token",
        appToken: "app-token",
        config: getSlackTestState().config,
      }),
    ).rejects.toBe(startError);

    expect(ingressStopMock).toHaveBeenCalledTimes(1);
    expect(getSlackTestState().appStartMock).not.toHaveBeenCalled();
    expect(getSlackTestState().appStopMock).toHaveBeenCalledTimes(1);
  });
});
