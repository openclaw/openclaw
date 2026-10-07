// Slack tests cover provider ingress startup cleanup behavior.
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSlackHttpRequest } from "../http/registry.js";
import { getSlackClient, getSlackTestState, resetSlackTestState } from "../monitor.test-helpers.js";

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
  resetGlobalHookRunner();
  await resetSlackTestState();
  ingressStartMock.mockReset();
  ingressStopMock.mockReset().mockResolvedValue(undefined);
});

afterAll(() => {
  vi.doUnmock("./ingress.js");
  vi.resetModules();
});

describe("Slack ingress startup cleanup", () => {
  it("rechecks a consumer removed during awaited startup authentication before receipt", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { pluginId: "synthetic-consumer", hookName: "channel_tokens_revoked", handler: vi.fn() },
      ]),
    );
    getSlackClient().auth.test.mockImplementationOnce(async () => {
      resetGlobalHookRunner();
      return {
        user_id: "bot-user",
        bot_id: "bot-id",
        app_id: "A_TEST",
        team_id: "T_TEST",
        is_enterprise_install: false,
      };
    });
    await expect(
      monitorSlackProvider({
        scheduler: createTestPluginServiceScheduler(),
        botToken: "synthetic-bot-token",
        appToken: "synthetic-app-token",
        config: {
          channels: { slack: { requiredTokenRevocationConsumers: ["synthetic-consumer"] } },
        },
      }),
    ).rejects.toThrow("required consumer is unavailable");
    expect(getSlackTestState().createSlackStartupAuthClientMock).toHaveBeenCalledTimes(1);
    expect(ingressStartMock).not.toHaveBeenCalled();
    expect(ingressStopMock).toHaveBeenCalledTimes(1);
    expect(getSlackTestState().appStartMock).not.toHaveBeenCalled();
    expect(getSlackTestState().appStopMock).toHaveBeenCalledTimes(1);
  });

  it.each(["socket", "http"] as const)(
    "refuses native %s startup before receipt when a required consumer is unavailable",
    async (mode) => {
      await expect(
        monitorSlackProvider({
          scheduler: createTestPluginServiceScheduler(),
          config: {
            channels: {
              slack: {
                mode,
                requiredTokenRevocationConsumers: ["synthetic-consumer"],
              },
            },
          },
        }),
      ).rejects.toThrow("required consumer is unavailable");
      expect(ingressStartMock).not.toHaveBeenCalled();
      expect(getSlackTestState().appConstructorArgs).toBeUndefined();
      expect(getSlackTestState().appStartMock).not.toHaveBeenCalled();
      expect(getSlackTestState().createSlackStartupAuthClientMock).not.toHaveBeenCalled();
    },
  );

  it("refuses required-consumer relay mode before connecting its unsupported source", async () => {
    await expect(
      monitorSlackProvider({
        scheduler: createTestPluginServiceScheduler(),
        config: {
          channels: {
            slack: { mode: "relay", requiredTokenRevocationConsumers: ["synthetic-consumer"] },
          },
        },
      }),
    ).rejects.toThrow("need native socket or HTTP delivery");
    expect(ingressStartMock).not.toHaveBeenCalled();
    expect(getSlackTestState().appConstructorArgs).toBeUndefined();
  });

  it("rejects an oversized body before Bolt's void listener reads asynchronously", async () => {
    const state = getSlackTestState();
    state.httpRequestListenerMock.mockImplementation((reqValue, resValue) => {
      const req = reqValue as IncomingMessage;
      const res = resValue as ServerResponse;
      void (async () => {
        for await (const chunk of req) {
          // Bolt buffers the full body before signature verification.
          void chunk;
        }
        if (!res.headersSent) {
          res.statusCode = 401;
          res.end();
        }
      })();
    });
    state.config = {
      ...state.config,
      channels: {
        slack: {
          mode: "http",
          signingSecret: "test-signing-secret",
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
        },
      },
    };
    const controller = new AbortController();
    const run = monitorSlackProvider({
      scheduler: createTestPluginServiceScheduler(),
      botToken: "bot-token",
      abortSignal: controller.signal,
      config: state.config,
    });
    let server: Server | undefined;
    let clientRequest: ReturnType<typeof request> | undefined;

    try {
      await vi.waitFor(() => expect(ingressStartMock).toHaveBeenCalledTimes(1));
      let acceptRequest: (() => void) | undefined;
      const accepted = new Promise<void>((resolve) => {
        acceptRequest = resolve;
      });
      server = createServer((req, res) => {
        acceptRequest?.();
        void handleSlackHttpRequest(req, res);
      });
      await new Promise<void>((resolve) => {
        server!.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not expose a TCP port");
      }
      clientRequest = request({
        host: "127.0.0.1",
        port: address.port,
        path: "/slack/events",
        method: "POST",
        headers: { "transfer-encoding": "chunked" },
      });
      clientRequest.on("error", () => {});
      const response = new Promise<{ statusCode: number | undefined; body: string }>(
        (resolve, reject) => {
          clientRequest!.once("response", (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.once("end", () => resolve({ statusCode: res.statusCode, body }));
          });
          clientRequest!.once("error", reject);
        },
      );
      clientRequest.flushHeaders();

      await accepted;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      clientRequest.write(Buffer.alloc(768 * 1024, 0x61));
      clientRequest.end(Buffer.alloc(768 * 1024, 0x62));

      await expect(response).resolves.toEqual({
        statusCode: 413,
        body: "Payload too large",
      });
    } finally {
      clientRequest?.destroy();
      server?.closeAllConnections();
      await new Promise<void>((resolve) => {
        if (server) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      });
      controller.abort();
      await run;
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
