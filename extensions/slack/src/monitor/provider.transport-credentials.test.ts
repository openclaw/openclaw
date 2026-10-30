import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import {
  createSlackHttpTestDispatcher,
  installSlackHttpTestRegistry,
} from "../http/route.test-helpers.js";
import { setSlackRuntime } from "../runtime.js";
import { monitorSlackProvider } from "./provider.js";

const inactiveSecret = { source: "env", provider: "default", id: "SLACK_UNUSED_SECRET" } as const;
const signingSecret = "loopback-signing-secret";

async function withMonitor(config: OpenClawConfig, use: () => Promise<void>, accountId?: string) {
  const connected = createDeferred<void>();
  const controller = new AbortController();
  const run = monitorSlackProvider({
    scheduler: createTestPluginServiceScheduler(),
    config,
    accountId,
    abortSignal: controller.signal,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    setStatus: (next) => {
      if (next.connected === true) {
        connected.resolve();
      }
    },
  });
  try {
    await Promise.race([connected.promise, run]);
    await use();
  } finally {
    controller.abort();
    await run;
  }
}

async function startSlackLoopback() {
  const registry = installSlackHttpTestRegistry();
  const handleSlackHttpRequest = createSlackHttpTestDispatcher(registry);
  const requests: string[] = [];
  const connections: Array<{ url?: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    void handleSlackHttpRequest(request, response).then((handled) => {
      if (handled) {
        return;
      }
      request.resume();
      requests.push(request.url ?? "");
      const payload =
        request.url === "/api/auth.test"
          ? {
              ok: true,
              user_id: "UBOT",
              bot_id: "BBOT",
              app_id: "ATEST",
              team_id: "TTEST",
              is_enterprise_install: false,
            }
          : request.url === "/api/apps.connections.open"
            ? { ok: true, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket` }
            : { ok: false, error: "unexpected_test_request" };
      response
        .writeHead(request.url?.startsWith("/api/") ? 200 : 404, {
          "content-type": "application/json",
        })
        .end(JSON.stringify(payload));
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    connections.push({ url: request.url, authorization: request.headers.authorization });
    socket.send(JSON.stringify({ type: "hello" }));
  });
  const port = await listenOnLoopback(server);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    connections,
    registry,
    close: async () => {
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await promisify(sockets.close.bind(sockets))();
      server.closeAllConnections();
      await promisify(server.close.bind(server))();
    },
  };
}

describe("Slack transport credential activation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["socket", "relay", "http"] as const)(
    "starts real %s transport with only its active credentials resolved",
    async (mode) => {
      const loopback = await startSlackLoopback();
      vi.stubEnv("SLACK_API_URL", `${loopback.url}/api/`);
      vi.stubEnv("SLACK_UNUSED_SECRET", "");
      try {
        await withStateDirEnv("slack-transport-credentials-", async ({ stateDir }) => {
          setSlackRuntime({
            state: {
              resolveStateDir: () => stateDir,
              openChannelIngressQueue: (options) =>
                createChannelIngressQueueForTests({ ...options, channelId: "slack", stateDir }),
            },
          } as PluginRuntime);
          const slack = {
            mode,
            botToken: "xoxb-loopback",
            appToken: mode === "socket" ? "xapp-1-ATEST-loopback" : inactiveSecret,
            signingSecret: mode === "http" ? signingSecret : inactiveSecret,
            accounts: {
              default: {},
              duplicate: { signingSecret: "duplicate-signing-secret" },
            },
            relay: {
              url: `${loopback.url}/relay`,
              authToken: mode === "relay" ? "loopback-relay-token" : inactiveSecret,
              gatewayId: "loopback",
            },
          };
          const config = { channels: { slack } } satisfies OpenClawConfig;
          await withMonitor(config, async () => {
            expect(loopback.registry.httpRoutes).toHaveLength(mode === "http" ? 1 : 0);
            expect(loopback.requests).toContain("/api/auth.test");
            if (mode === "socket") {
              expect(loopback.requests).toContain("/api/apps.connections.open");
              expect(loopback.connections).toContainEqual({
                url: expect.stringMatching(/^\/socket(?:\?|$)/u),
                authorization: undefined,
              });
            } else if (mode === "relay") {
              expect(loopback.connections).toContainEqual({
                url: "/relay?gateway_id=loopback",
                authorization: "Bearer loopback-relay-token",
              });
            } else {
              expect(loopback.registry.httpRoutes[0]).toMatchObject({
                path: "/slack/events",
                auth: "plugin",
                pluginId: "slack",
                source: "slack-webhook",
              });
              const body = JSON.stringify({ type: "url_verification", challenge: "connected" });
              const timestamp = String(Math.floor(Date.now() / 1_000));
              const sign = (secret: string) =>
                `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
              const signature = sign(signingSecret);
              const postChallenge = (signatureValue: string, path = "/slack/events") =>
                fetch(`${loopback.url}${path}`, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-slack-request-timestamp": timestamp,
                    "x-slack-signature": signatureValue,
                  },
                  body,
                });
              const valid = await postChallenge(signature);
              expect(valid.status).toBe(200);
              expect(await valid.text()).toContain("connected");
              expect((await postChallenge("v0=invalid")).status).toBe(401);
              expect((await postChallenge(signature, "/slack/%65vents")).status).toBe(404);
              await withMonitor(
                config,
                async () => {
                  expect((await postChallenge(signature)).status).toBe(200);
                  expect((await postChallenge(sign("duplicate-signing-secret"))).status).toBe(401);
                },
                "duplicate",
              );
              expect((await postChallenge(signature)).status).toBe(200);
            }
          });
          expect(loopback.registry.httpRoutes).toHaveLength(0);
        });
      } finally {
        await loopback.close();
      }
    },
  );
});
