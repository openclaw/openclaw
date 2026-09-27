import { once } from "node:events";
import { createServer, request } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getServerPort, webhookUrl } from "./test-support/webhook-gateway.js";
import { postWebhookHeadersOnly, postWebhookJson } from "./test-support/webhook-http.js";
import { startTelegramWebhook } from "./webhook.js";

const mocks = vi.hoisted(() => ({
  gatewayOwnsListeners: false,
  init: vi.fn(),
  setWebhook: vi.fn(),
  stopBot: vi.fn(),
  closeTransport: vi.fn(),
  admit: vi.fn<(account: string, value: unknown) => Promise<void>>(),
  stopIngress: vi.fn(),
  settleIngress: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>();
  return {
    ...actual,
    get getWebhookLegacyListener() {
      return mocks.gatewayOwnsListeners ? actual.getWebhookLegacyListener : undefined;
    },
  };
});
vi.mock("./bot.js", () => ({
  createTelegramBot: () => ({
    init: mocks.init,
    botInfo: { id: 123, is_bot: true, first_name: "Fixture" },
    api: { setWebhook: mocks.setWebhook },
    stop: mocks.stopBot,
  }),
}));
vi.mock("./fetch.js", () => ({
  resolveTelegramTransport: () => ({ fetch: globalThis.fetch, close: mocks.closeTransport }),
}));
vi.mock("./telegram-ingress-drain-factory.js", () => ({
  createTelegramTransportIngressMonitor: ({ accountId }: { accountId: string }) => ({
    start: () => {},
    admit: (value: unknown) => mocks.admit(accountId, value),
    stop: mocks.stopIngress,
    waitForDeferredClaims: mocks.settleIngress,
  }),
}));

let registry = createEmptyPluginRegistry();
const running: Array<Awaited<ReturnType<typeof startTelegramWebhook>>> = [];

beforeEach(() => {
  registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  mocks.gatewayOwnsListeners = false;
  mocks.init.mockReset().mockResolvedValue(undefined);
  mocks.setWebhook.mockReset().mockResolvedValue(true);
  mocks.stopBot.mockReset();
  mocks.closeTransport.mockReset().mockResolvedValue(undefined);
  mocks.admit.mockReset().mockResolvedValue(undefined);
  mocks.stopIngress.mockReset().mockResolvedValue(undefined);
  mocks.settleIngress.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((webhook) => webhook.stop()));
});

async function reservePort(port = 0) {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    port: getServerPort(server),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
async function freePort() {
  const reserved = await reservePort();
  await reserved.close();
  return reserved.port;
}
async function start(
  port: number,
  overrides: Partial<Parameters<typeof startTelegramWebhook>[0]> = {},
) {
  const webhook = await startTelegramWebhook({
    token: "fixture-token",
    accountId: "primary",
    path: "/hook",
    secret: "fixture-secret",
    publicUrl: "https://example.test/hook",
    legacyWebhook: { port, host: "127.0.0.1" },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    ...overrides,
  });
  running.push(webhook);
  return webhook;
}

it("serves exact health and webhook paths and waits for admission before acknowledging", async () => {
  const port = await freePort();
  await start(port);
  for (const method of ["GET", "HEAD", "POST"]) {
    const health = await fetch(webhookUrl(port, "/healthz"), { method });
    expect(health.status).toBe(200);
    expect(await health.text()).toBe(method === "HEAD" ? "" : "ok");
  }
  for (const path of ["/healthz?x=1", "/healthz/", "/hook?x=1", "/HOOK"]) {
    const missing = await fetch(webhookUrl(port, path));
    expect(missing.status).toBe(404);
    await missing.text();
  }
  const unauthorized = await postWebhookHeadersOnly({ port, path: "/hook", declaredLength: 100 });
  expect(unauthorized).toEqual({ statusCode: 401, body: "unauthorized" });
  expect(mocks.admit).not.toHaveBeenCalled();

  const admitted = createDeferred<void>();
  const entered = createDeferred<void>();
  mocks.admit.mockImplementationOnce(async () => {
    entered.resolve();
    await admitted.promise;
  });
  let responded = false;
  const response = postWebhookJson({
    url: webhookUrl(port, "/hook"),
    payload: '{"update_id":1}',
    secret: "fixture-secret",
  }).then((value) => {
    responded = true;
    return value;
  });
  try {
    await entered.promise;
    expect(responded).toBe(false);
  } finally {
    admitted.resolve();
  }
  const accepted = await response;
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
  await accepted.text();
  mocks.admit.mockRejectedValueOnce(new Error("storage failed"));
  const rejected = await postWebhookJson({
    url: webhookUrl(port, "/hook"),
    payload: '{"update_id":2}',
    secret: "fixture-secret",
  });
  expect(rejected.status).toBe(500);
  expect(rejected.headers.has("x-openclaw-delivery-accepted")).toBe(false);
  await rejected.text();
});

it("keeps account-local delivery on separate ports and rejects shared-port ownership", async () => {
  const firstPort = await freePort();
  await start(firstPort, { accountId: "first" });
  const secondPort = await freePort();
  await start(secondPort, { accountId: "second" });
  for (const [port, account] of [
    [firstPort, "first"],
    [secondPort, "second"],
  ] as const) {
    const accepted = await postWebhookJson({
      url: webhookUrl(port, "/hook"),
      payload: '{"update_id":3}',
      secret: "fixture-secret",
    });
    expect(accepted.status).toBe(200);
    await accepted.text();
    expect(mocks.admit).toHaveBeenLastCalledWith(account, { update_id: 3 });
  }
  await expect(start(firstPort, { accountId: "third" })).rejects.toMatchObject({
    code: "EADDRINUSE",
  });
  expect(mocks.setWebhook).toHaveBeenCalledTimes(2);
  expect(mocks.closeTransport).toHaveBeenCalledTimes(1);
});

it.each(["stop", "abort"] as const)(
  "releases the listener and owned resources once on %s",
  async (ending) => {
    const port = await freePort();
    const abort = new AbortController();
    const webhook = await start(port, { abortSignal: abort.signal });
    if (ending === "abort") {
      abort.abort();
    }
    await Promise.all([webhook.stop(), webhook.stop()]);
    expect(mocks.stopBot).toHaveBeenCalledOnce();
    expect(mocks.closeTransport).toHaveBeenCalledOnce();
    expect(mocks.stopIngress).toHaveBeenCalledOnce();
    expect(registry.httpRoutes).toHaveLength(0);
    const rebound = await reservePort(port);
    await rebound.close();
  },
);

it("settles owned resources before joining an unfinished request on shutdown", async () => {
  const port = await freePort();
  const webhook = await start(port);
  const body = '{"update_id":4}';
  const response = createDeferred<
    { statusCode: number | undefined; accepted: string | string[] | undefined } | Error
  >();
  const req = request(webhookUrl(port, "/hook"), {
    agent: false,
    method: "POST",
    headers: {
      Expect: "100-continue",
      "Content-Length": Buffer.byteLength(body),
      "x-telegram-bot-api-secret-token": "fixture-secret",
    },
  });
  req.on("error", response.resolve);
  req.on("response", (res) => {
    res.resume();
    res.on("end", () => {
      response.resolve({
        statusCode: res.statusCode,
        accepted: res.headers["x-openclaw-delivery-accepted"],
      });
    });
  });
  const requestClosed = new Promise<void>((resolve) => {
    req.once("close", resolve);
  });
  const continued = once(req, "continue");
  let stopping: Promise<void> | undefined;
  let stopped = false;
  try {
    req.flushHeaders();
    await continued;
    stopping = webhook.stop().then(() => {
      stopped = true;
    });
    await vi.waitFor(() => {
      expect(mocks.stopBot).toHaveBeenCalledOnce();
      expect(mocks.closeTransport).toHaveBeenCalledOnce();
      expect(mocks.stopIngress).toHaveBeenCalledOnce();
      expect(mocks.settleIngress).toHaveBeenCalledOnce();
    });
    expect(stopped).toBe(false);
    req.end(body);
    expect(await response.promise).toEqual({ statusCode: 500, accepted: undefined });
    expect(mocks.admit).not.toHaveBeenCalled();
    await stopping;
    const rebound = await reservePort(port);
    await rebound.close();
  } finally {
    req.destroy();
    await requestClosed;
    await stopping;
  }
});

it("closes the listener when registration fails and skips it when startup is already aborted", async () => {
  const port = await freePort();
  mocks.setWebhook.mockRejectedValueOnce(new Error("invalid webhook"));
  await expect(start(port)).rejects.toThrow("invalid webhook");
  expect(mocks.closeTransport).toHaveBeenCalledOnce();
  const rebound = await reservePort(port);
  await rebound.close();
  const abort = new AbortController();
  abort.abort();
  const stopped = await start(port, { abortSignal: abort.signal });
  await stopped.stop();
  expect(mocks.setWebhook).toHaveBeenCalledTimes(1);
  const unbound = await reservePort(port);
  await unbound.close();
});

it.each(["capable-host", "disabled"] as const)(
  "does not create an account socket for %s",
  async (mode) => {
    mocks.gatewayOwnsListeners = mode === "capable-host";
    const port = await freePort();
    await start(port, mode === "disabled" ? { legacyWebhook: false } : {});
    const unbound = await reservePort(port);
    await unbound.close();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.legacyListeners).toEqual(
      mode === "capable-host"
        ? [{ port, host: "127.0.0.1", health: { path: "/healthz" } }]
        : undefined,
    );
  },
);
