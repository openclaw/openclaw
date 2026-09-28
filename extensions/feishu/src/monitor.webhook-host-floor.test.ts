import { once } from "node:events";
import { createServer } from "node:http";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { getActivePluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { monitorWebhook } from "./monitor.transport.js";
import {
  createFeishuWebhookTestAccount,
  getGatewayPort,
  postSignedPayload,
} from "./monitor.webhook.test-helpers.js";

const host = vi.hoisted(() => ({ ownsLegacyListeners: false }));
vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>();
  return {
    ...actual,
    get getWebhookLegacyListener() {
      return host.ownsLegacyListeners ? actual.getWebhookLegacyListener : undefined;
    },
  };
});

const running: Array<{ abort: AbortController; monitor: Promise<void> }> = [];
const portClaims: Array<Awaited<ReturnType<typeof acquireTestPortBlock>>> = [];
beforeEach(() => {
  host.ownsLegacyListeners = false;
});
afterEach(async () => {
  for (const entry of running) {
    entry.abort.abort();
  }
  await Promise.allSettled(running.splice(0).map((entry) => entry.monitor));
  await using claims = new AsyncDisposableStack();
  for (const claim of portClaims.splice(0)) {
    claims.defer(() => claim.release());
  }
  await cleanupFeishuMonitorStateForTests();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
  vi.resetModules();
});

async function reservePort(port: number) {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a loopback port");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function claimPort() {
  const claim = await acquireTestPortBlock({ offsets: [0] });
  portClaims.push(claim);
  return claim.port;
}

async function start(
  port: number,
  options: {
    accountId?: string;
    disabled?: boolean;
    abort?: AbortController;
    invoke?: () => Promise<{ kind: "non-durable"; value: unknown }>;
  } = {},
) {
  const gatewayPort = await getGatewayPort();
  const accountId = options.accountId ?? "floor";
  const account = createFeishuWebhookTestAccount(accountId, `/hook-${accountId}`);
  account.config.legacyWebhook = options.disabled ? false : { port, host: "127.0.0.1" };
  const abort = options.abort ?? new AbortController();
  const ready = createDeferred<void>();
  const invoked = vi.fn(
    options.invoke ??
      (async (): Promise<{ kind: "non-durable"; value: unknown }> => ({
        kind: "non-durable",
        value: { accountId },
      })),
  );
  const monitor = monitorWebhook({
    account,
    accountId,
    gatewayPort,
    abortSignal: abort.signal,
    eventDispatcher: new Lark.EventDispatcher({ encryptKey: "encrypt_key" }),
    invokeWebhookEvent: invoked,
    runtime: createRuntimeSpies(),
    statusSink: (patch) => {
      if (patch.lifecycle === "ready") {
        ready.resolve();
      }
    },
  });
  running.push({ abort, monitor });
  if (abort.signal.aborted) {
    await monitor;
  } else {
    await Promise.race([
      ready.promise,
      monitor.then(() => {
        throw new Error("Monitor stopped before becoming ready");
      }),
    ]);
  }
  return { abort, monitor, invoked, gatewayPort, path: `/hook-${accountId}` };
}

it("serves the shipped account endpoint with the existing signature and path checks", async () => {
  const port = await claimPort();
  const entry = await start(port);
  const url = `http://127.0.0.1:${port}${entry.path}`;
  const wrongPath = await postSignedPayload(`${url}/other`, { schema: "2.0", event: {} });
  expect(wrongPath.status).toBe(404);
  await wrongPath.text();
  const unsigned = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ schema: "2.0", event: {} }),
  });
  expect(unsigned.status).toBe(401);
  await unsigned.text();
  expect(entry.invoked).not.toHaveBeenCalled();
  const accepted = await postSignedPayload(url, { schema: "2.0", event: {} });
  expect(accepted.status).toBe(200);
  await expect(accepted.json()).resolves.toEqual({ accountId: "floor" });
  expect(entry.invoked).toHaveBeenCalledOnce();
  expect(getActivePluginRegistry()?.httpRoutes[0]?.legacyListeners).toBeUndefined();
});

it("stops listener admission before draining an authenticated response and permits rebinding", async () => {
  const port = await claimPort();
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const entry = await start(port, {
    invoke: async () => {
      entered.resolve();
      await release.promise;
      return { kind: "non-durable", value: { completed: true } };
    },
  });
  const url = `http://127.0.0.1:${port}${entry.path}`;
  const response = postSignedPayload(url, { schema: "2.0", event: {} });
  let stopped = false;
  void entry.monitor.then(() => {
    stopped = true;
  });
  try {
    await entered.promise;
    entry.abort.abort();
    await expect(fetch(url, { headers: { connection: "close" } })).rejects.toMatchObject({
      cause: { code: "ECONNREFUSED" },
    });
    expect(stopped).toBe(false);
    release.resolve();
    const accepted = await response;
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ completed: true });
    await entry.monitor;
    const rebound = await reservePort(port);
    await rebound.close();
  } finally {
    release.resolve();
    entry.abort.abort();
    await response.catch(() => {});
    await entry.monitor;
  }
});

it("keeps the shipped per-account bind refusal without disturbing the live account", async () => {
  const port = await claimPort();
  const first = await start(port, { accountId: "first" });
  await expect(start(port, { accountId: "second" })).rejects.toMatchObject({ code: "EADDRINUSE" });
  const response = await postSignedPayload(`http://127.0.0.1:${port}${first.path}`, {
    schema: "2.0",
    event: {},
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ accountId: "first" });
  expect(getActivePluginRegistry()?.httpRoutes.some((route) => route.path === "/hook-second")).toBe(
    false,
  );
});

it.each(["capable-host", "disabled", "already-aborted"] as const)(
  "does not own a listener for %s",
  async (mode) => {
    const port = await claimPort();
    host.ownsLegacyListeners = mode === "capable-host";
    const abort = new AbortController();
    if (mode === "already-aborted") {
      abort.abort();
    }
    await start(port, { disabled: mode === "disabled", abort });
    const unbound = await reservePort(port);
    await unbound.close();
    const routes = getActivePluginRegistry()?.httpRoutes ?? [];
    expect(routes).toHaveLength(mode === "already-aborted" ? 0 : 1);
    expect(routes[0]?.legacyListeners).toEqual(
      mode === "capable-host" ? [{ port, host: "127.0.0.1" }] : undefined,
    );
  },
);
