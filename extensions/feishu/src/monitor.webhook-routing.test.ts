import { createConnection } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { getActivePluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { FeishuConfigSchema } from "./config-schema.js";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { botOpenIds, setFeishuBotIdentityState } from "./monitor.state.js";
import { monitorWebhook } from "./monitor.transport.js";
import {
  createFeishuWebhookTestAccount,
  getGatewayPort,
  getGatewayServer,
  signFeishuPayload,
  postSignedPayload,
  waitForWebhookRoute,
} from "./monitor.webhook.test-helpers.js";

const legacyListener = vi.hoisted(() => ({
  value: undefined as { port: number; host?: string } | undefined,
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>()),
  getWebhookLegacyListener: () => legacyListener.value,
}));

afterEach(async () => {
  legacyListener.value = undefined;
  await cleanupFeishuMonitorStateForTests();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
  vi.resetModules();
});

describe("Feishu webhook route configuration", () => {
  it("clears stopped account identity when startup is already aborted", async () => {
    await getGatewayPort();
    const account = createFeishuWebhookTestAccount("already-stopped", "/hook-already-stopped");
    const abort = new AbortController();
    abort.abort();
    setFeishuBotIdentityState(account.accountId, "ou_stopped");
    await monitorWebhook({
      account,
      accountId: account.accountId,
      abortSignal: abort.signal,
      eventDispatcher: new Lark.EventDispatcher({ encryptKey: "encrypt_key" }),
      runtime: createRuntimeSpies(),
    });
    expect(botOpenIds.has(account.accountId)).toBe(false);
    expect(
      getActivePluginRegistry()?.httpRoutes.some((route) => route.path === "/hook-already-stopped"),
    ).toBe(false);
  });

  it.each(["finish", "timeout"] as const)(
    "drains an authenticated response during account shutdown until %s",
    async (ending) => {
      const port = await getGatewayPort();
      const account = createFeishuWebhookTestAccount(
        "shutdown-response",
        "/hook-shutdown-response",
      );
      const abort = new AbortController();
      const invoked = createDeferred<void>();
      const releaseDispatch = createDeferred<void>();
      const peers: { abort: AbortController; monitor: Promise<void> }[] = [];
      const startPeer = (accountId: string, encryptKey: string, startMonitor = monitorWebhook) => {
        const peerAbort = new AbortController();
        peers.push({
          abort: peerAbort,
          monitor: startMonitor({
            account: { ...account, accountId, encryptKey },
            accountId,
            abortSignal: peerAbort.signal,
            eventDispatcher: new Lark.EventDispatcher({ encryptKey }),
            invokeWebhookEvent: async () => ({ kind: "non-durable", value: { accountId } }),
            runtime: createRuntimeSpies(),
          }),
        });
      };
      const monitor = monitorWebhook({
        account,
        accountId: account.accountId,
        abortSignal: abort.signal,
        eventDispatcher: new Lark.EventDispatcher({ encryptKey: "encrypt_key" }),
        invokeWebhookEvent: async () => {
          invoked.resolve();
          await releaseDispatch.promise;
          return { kind: "non-durable", value: { accepted: true } };
        },
        runtime: createRuntimeSpies(),
      });
      let stopped = false;
      void monitor.then(() => {
        stopped = true;
      });
      const request = postSignedPayload(`http://127.0.0.1:${port}/hook-shutdown-response`, {
        schema: "2.0",
        event: {},
      }).then(
        async (response) => ({ status: response.status, body: await response.text() }),
        (error: unknown) => ({ error }),
      );
      try {
        await invoked.promise;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        abort.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        if (ending === "finish") {
          startPeer("shutdown-sibling", "sibling_key");
          const retry = await postSignedPayload(`http://127.0.0.1:${port}/hook-shutdown-response`, {
            schema: "2.0",
            event: {},
          });
          expect(retry.status).toBe(503);
          expect(retry.headers.get("retry-after")).toBe("1");
          expect(await retry.text()).toBe("plugin route is restarting; retry");
          const duplicateTransport = await importFreshModule<
            typeof import("./monitor.transport.js")
          >(import.meta.url, "./monitor.transport.js?scope=feishu-webhook-successor");
          startPeer(account.accountId, "encrypt_key", duplicateTransport.monitorWebhook);
          const replacement = await postSignedPayload(
            `http://127.0.0.1:${port}/hook-shutdown-response`,
            { schema: "2.0", event: {} },
          );
          expect(replacement.status).toBe(200);
          await expect(replacement.json()).resolves.toEqual({ accountId: account.accountId });
          releaseDispatch.resolve();
          await expect(request).resolves.toEqual({ status: 200, body: '{"accepted":true}' });
        } else {
          await vi.advanceTimersByTimeAsync(4_999);
          expect(stopped).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          await expect(request).resolves.toEqual({ error: expect.any(Error) });
        }
        await monitor;
        expect(stopped).toBe(true);
      } finally {
        vi.useRealTimers();
        releaseDispatch.resolve();
        abort.abort();
        for (const peer of peers) {
          peer.abort.abort();
        }
        await request;
        await monitor;
        await Promise.all(peers.map((peer) => peer.monitor));
      }
    },
  );

  it.each([
    { name: "normal stop after identity recovery", replacement: undefined },
    {
      name: "successor publishing the same identity",
      replacement: "ou_recovered",
    },
  ])("preserves identity ownership during $name", async ({ replacement }) => {
    const port = await getGatewayPort();
    const accountId = "identity-handoff";
    const account = createFeishuWebhookTestAccount(accountId, "/hook-identity-handoff");
    const abort = new AbortController();
    const invoked = createDeferred<void>();
    const releaseDispatch = createDeferred<void>();
    setFeishuBotIdentityState(accountId, "ou_initial");
    const monitor = monitorWebhook({
      account,
      accountId,
      abortSignal: abort.signal,
      eventDispatcher: new Lark.EventDispatcher({ encryptKey: "encrypt_key" }),
      invokeWebhookEvent: async () => {
        invoked.resolve();
        await releaseDispatch.promise;
        return { kind: "non-durable", value: {} };
      },
      runtime: createRuntimeSpies(),
    });
    const request = postSignedPayload(`http://127.0.0.1:${port}/hook-identity-handoff`, {
      schema: "2.0",
      event: {},
    });
    try {
      await invoked.promise;
      setFeishuBotIdentityState(accountId, "ou_recovered");
      abort.abort();
      expect(botOpenIds.get(accountId)).toBe("ou_recovered");
      if (replacement) {
        setFeishuBotIdentityState(accountId, replacement);
      }
      releaseDispatch.resolve();
      const response = await request;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({});
      await monitor;
      expect(botOpenIds.get(accountId)).toBe(replacement);
    } finally {
      releaseDispatch.resolve();
      abort.abort();
      await request;
      await monitor;
    }
  });

  it.each([
    { path: "/health", reason: "is reserved for Gateway probes" },
    { path: "/%61pi/channels/feishu?tenant=test", reason: "requires Gateway authentication" },
  ])(
    "keeps the default legacy listener for restricted path $path until explicitly disabled",
    async ({ path, reason }) => {
      const port = await getGatewayPort();
      const abortController = new AbortController();
      const invoke = vi.fn(async () => ({ accepted: true }));
      const account = createFeishuWebhookTestAccount("reserved-path", path);
      const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
      vi.spyOn(eventDispatcher, "invoke").mockImplementation(invoke);
      const params = {
        account: {
          ...account,
          config: FeishuConfigSchema.parse({ ...account.config, legacyWebhook: false }),
        },
        accountId: account.accountId,
        abortSignal: abortController.signal,
        eventDispatcher,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      };
      await expect(monitorWebhook(params)).rejects.toThrow(
        `webhookPath ${JSON.stringify(path)} ${reason}`,
      );
      legacyListener.value = { port: 3000, host: "127.0.0.1" };
      const monitor = monitorWebhook({
        ...params,
        account,
      });
      try {
        const response = await postSignedPayload(`http://127.0.0.1:${port}${path}`, {
          schema: "2.0",
          event: {},
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ accepted: true });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(params.runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("before setting legacyWebhook:false"),
        );
      } finally {
        legacyListener.value = undefined;
        abortController.abort();
        await monitor;
      }
    },
  );

  it("disables an inherited legacy listener without disabling Gateway delivery", async () => {
    const path = "/hook-legacy-bind-address";
    const port = await getGatewayPort();
    const fixture = createFeishuWebhookTestAccount("legacy-bind-address", path);
    const account = resolveFeishuRuntimeAccount({
      accountId: fixture.accountId,
      cfg: {
        channels: {
          feishu: FeishuConfigSchema.parse({
            ...fixture.config,
            appId: "cli_test",
            appSecret: "secret_test",
            legacyWebhook: { port: 3100 },
            accounts: {
              [fixture.accountId]: { legacyWebhook: false },
            },
          }),
        },
      },
    });
    const abort = new AbortController();
    const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
    const invoke = vi.spyOn(eventDispatcher, "invoke").mockResolvedValue({ accepted: true });
    const monitor = monitorWebhook({
      account,
      accountId: account.accountId,
      abortSignal: abort.signal,
      eventDispatcher,
      runtime: createRuntimeSpies(),
    });
    const url = `http://127.0.0.1:${port}${path}`;
    try {
      await waitForWebhookRoute(url);
      expect(
        getActivePluginRegistry()?.httpRoutes.find((route) => route.path === path)
          ?.legacyListeners ?? [],
      ).toEqual([]);
      legacyListener.value = { port: 3000, host: "127.0.0.1" };
      let response = await postSignedPayload(url, { schema: "2.0", event: {} });
      expect(response.status).toBe(404);
      expect(invoke).not.toHaveBeenCalled();
      legacyListener.value = undefined;
      response = await postSignedPayload(url, { schema: "2.0", event: {} });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ accepted: true });
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      legacyListener.value = undefined;
      abort.abort();
      await monitor;
    }
  });
  it("does not publish healthy activity when the client aborts a held signed dispatch", async () => {
    const accountId = "aborted-signed-dispatch";
    const path = "/hook-e2e-aborted-signed-dispatch";
    const port = await getGatewayPort();
    const dispatchGate = createDeferred<void>();
    const dispatchStarted = createDeferred<void>();
    const handler = vi.fn(async () => {
      dispatchStarted.resolve();
      await dispatchGate.promise;
      return { accepted: true };
    });
    const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
    eventDispatcher.register({ "test.aborted_dispatch": handler });
    const statusSink = vi.fn();
    const abortController = new AbortController();
    const monitorPromise = monitorWebhook({
      account: createFeishuWebhookTestAccount(accountId, path),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher,
      statusSink,
    });
    const socket = createConnection({ host: "127.0.0.1", port });
    try {
      await waitForWebhookRoute(`http://127.0.0.1:${port}${path}`);
      statusSink.mockClear();
      const server = getGatewayServer();
      const responseClosed = new Promise<void>((resolve) => {
        server.once("request", (_req, res) => res.once("close", resolve));
      });
      const rawBody = JSON.stringify({
        schema: "2.0",
        header: { event_type: "test.aborted_dispatch" },
        event: {},
      });
      const headers = Object.entries(signFeishuPayload({ encryptKey: "encrypt_key", rawBody }))
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: localhost\r\n${headers}\r\nContent-Length: ${Buffer.byteLength(rawBody)}\r\n\r\n${rawBody}`,
      );
      await dispatchStarted.promise;
      const clientClosed = new Promise<void>((resolve) => {
        socket.once("close", resolve);
      });
      socket.destroy();
      await clientClosed;
      await responseClosed;
      expect(statusSink).not.toHaveBeenCalled();
      dispatchGate.resolve();
      await expect(handler.mock.results[0]?.value).resolves.toEqual({ accepted: true });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(statusSink).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      dispatchGate.resolve();
      abortController.abort();
      await monitorPromise;
    }
  });
});
