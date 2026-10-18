import { createConnection } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { getActivePluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
} from "./monitor.webhook.test-helpers.js";

const host = vi.hoisted(() => ({
  listener: undefined as { port: number; host?: string } | undefined,
}));
vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>()),
  getWebhookLegacyListener: () => host.listener,
}));

const running: Array<{ abort: AbortController; monitor: Promise<void> }> = [];
const payload = { schema: "2.0", event: {} };
let gatewayPort: number;
beforeEach(async () => {
  host.listener = undefined;
  gatewayPort = await getGatewayPort();
});
afterEach(async () => {
  for (const entry of running) {
    entry.abort.abort();
  }
  await Promise.allSettled(running.splice(0).map((entry) => entry.monitor));
  await cleanupFeishuMonitorStateForTests();
});
afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
  vi.resetModules();
});

type MonitorParams = Parameters<typeof monitorWebhook>[0];
function start(
  accountId: string,
  options: Partial<Pick<MonitorParams, "account" | "eventDispatcher" | "statusSink">> & {
    path?: string;
    abort?: AbortController;
    invoke?: MonitorParams["invokeWebhookEvent"];
    startMonitor?: typeof monitorWebhook;
  } = {},
) {
  const account =
    options.account ??
    createFeishuWebhookTestAccount(accountId, options.path ?? `/hook-${accountId}`);
  const abort = options.abort ?? new AbortController();
  const ready = createDeferred<void>();
  const runtime = createRuntimeSpies();
  const invoked = vi.fn(
    options.invoke ?? (async () => ({ kind: "non-durable" as const, value: { accountId } })),
  );
  const monitor = (options.startMonitor ?? monitorWebhook)({
    account,
    accountId,
    gatewayPort,
    abortSignal: abort.signal,
    runtime,
    eventDispatcher:
      options.eventDispatcher ?? new Lark.EventDispatcher({ encryptKey: account.encryptKey }),
    ...(!options.eventDispatcher ? { invokeWebhookEvent: invoked } : {}),
    statusSink: (patch) => {
      options.statusSink?.(patch);
      if (patch.lifecycle === "ready") {
        ready.resolve();
      }
    },
  });
  running.push({ abort, monitor });
  return {
    account,
    abort,
    monitor,
    runtime,
    invoked,
    url: `http://127.0.0.1:${gatewayPort}${account.config.webhookPath}`,
    ready: abort.signal.aborted
      ? monitor
      : Promise.race([
          ready.promise,
          monitor.then(() => {
            throw new Error("Monitor stopped before becoming ready");
          }),
        ]),
  };
}

describe("Feishu webhook route configuration", () => {
  it.each(["finish", "timeout"] as const)(
    "drains an authenticated response during account shutdown until %s",
    async (ending) => {
      const account = createFeishuWebhookTestAccount(
        "shutdown-response",
        "/hook-shutdown-response",
      );
      if (ending === "finish") {
        account.config.legacyWebhook = { port: 3000, host: "127.0.0.1" };
        host.listener = account.config.legacyWebhook;
      }
      const invoked = createDeferred<void>();
      const releaseDispatch = createDeferred<void>();
      const entry = start("shutdown-response", {
        account,
        invoke: async () => {
          invoked.resolve();
          await releaseDispatch.promise;
          return { kind: "non-durable", value: { accepted: true } };
        },
      });
      await entry.ready;
      const startPeer = (accountId: string, encryptKey: string, startMonitor = monitorWebhook) =>
        start(accountId, { account: { ...entry.account, accountId, encryptKey }, startMonitor })
          .ready;
      let stopped = false;
      void entry.monitor.then(() => {
        stopped = true;
      });
      const request = postSignedPayload(entry.url, payload).then(
        async (response) => ({ status: response.status, body: await response.text() }),
        (error: unknown) => ({ error }),
      );
      try {
        await invoked.promise;
        expect(
          getActivePluginRegistry()?.httpRoutes.find(
            (route) => route.path === account.config.webhookPath,
          )?.legacyListeners ?? [],
        ).toEqual(ending === "finish" ? [account.config.legacyWebhook] : []);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        entry.abort.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        if (ending === "finish") {
          await startPeer("shutdown-sibling", "sibling_key");
          const retry = await postSignedPayload(entry.url, payload);
          expect(retry.status).toBe(503);
          expect(retry.headers.get("retry-after")).toBe("1");
          expect(await retry.text()).toBe("plugin route is restarting; retry");
          const duplicateTransport = await importFreshModule<
            typeof import("./monitor.transport.js")
          >(import.meta.url, "./monitor.transport.js?scope=feishu-webhook-successor");
          await startPeer(
            entry.account.accountId,
            "encrypt_key",
            duplicateTransport.monitorWebhook,
          );
          const replacement = await postSignedPayload(entry.url, payload);
          expect(replacement.status).toBe(200);
          await expect(replacement.json()).resolves.toEqual({ accountId: entry.account.accountId });
          releaseDispatch.resolve();
          await expect(request).resolves.toEqual({ status: 200, body: '{"accepted":true}' });
        } else {
          await vi.advanceTimersByTimeAsync(4_999);
          expect(stopped).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          await expect(request).resolves.toEqual({ error: expect.any(Error) });
        }
        await entry.monitor;
        expect(stopped).toBe(true);
      } finally {
        vi.useRealTimers();
        releaseDispatch.resolve();
        entry.abort.abort();
        await request;
        await entry.monitor;
      }
    },
  );

  it.each([
    { name: "normal stop after identity recovery", replacement: undefined },
    { name: "successor publishing the same identity", replacement: "ou_recovered" },
  ])("preserves identity ownership during $name", async ({ replacement }) => {
    const accountId = "identity-handoff";
    const invoked = createDeferred<void>();
    const releaseDispatch = createDeferred<void>();
    setFeishuBotIdentityState(accountId, "ou_initial");
    const entry = start(accountId, {
      invoke: async () => {
        invoked.resolve();
        await releaseDispatch.promise;
        return { kind: "non-durable", value: {} };
      },
    });
    await entry.ready;
    const request = postSignedPayload(entry.url, payload);
    try {
      await invoked.promise;
      setFeishuBotIdentityState(accountId, "ou_recovered");
      entry.abort.abort();
      expect(botOpenIds.get(accountId)).toBe("ou_recovered");
      if (replacement) {
        setFeishuBotIdentityState(accountId, replacement);
      }
      releaseDispatch.resolve();
      const response = await request;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({});
      await entry.monitor;
      expect(botOpenIds.get(accountId)).toBe(replacement);
    } finally {
      releaseDispatch.resolve();
      entry.abort.abort();
      await request;
      await entry.monitor;
    }
  });

  it.each([
    { path: "/health", reason: "is reserved for Gateway checks" },
    { path: "/%61pi/channels/feishu?tenant=test", reason: "requires Gateway authentication" },
  ])(
    "keeps an explicit legacy listener for restricted path $path and rejects an omitted listener",
    async ({ path, reason }) => {
      const account = createFeishuWebhookTestAccount("reserved-path", path);
      const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
      const invoke = vi.spyOn(eventDispatcher, "invoke").mockResolvedValue({ accepted: true });
      const denied = start(account.accountId, {
        account,
        eventDispatcher,
      });
      await expect(denied.ready).rejects.toThrow(`webhookPath ${JSON.stringify(path)} ${reason}`);
      host.listener = { port: 3000, host: "127.0.0.1" };
      const entry = start(account.accountId, {
        account: {
          ...account,
          config: FeishuConfigSchema.parse({ ...account.config, legacyWebhook: { port: 3000 } }),
        },
        eventDispatcher,
      });
      await entry.ready;
      const response = await postSignedPayload(entry.url, payload);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ accepted: true });
      expect(invoke).toHaveBeenCalledOnce();
      expect(entry.runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("before removing the legacyWebhook pin"),
      );
    },
  );

  it.each([
    { label: "an omitted listener", root: undefined, accountSetting: undefined },
    { label: "an inherited listener override", root: { port: 3100 }, accountSetting: false },
  ] as const)("keeps Gateway delivery with $label", async ({ root, accountSetting }) => {
    const fixture = createFeishuWebhookTestAccount(
      "legacy-bind-address",
      "/hook-legacy-bind-address",
    );
    const account = resolveFeishuRuntimeAccount({
      accountId: fixture.accountId,
      cfg: {
        channels: {
          feishu: FeishuConfigSchema.parse({
            ...fixture.config,
            appId: "cli_test",
            appSecret: "secret_test",
            legacyWebhook: root,
            accounts: { [fixture.accountId]: { legacyWebhook: accountSetting } },
          }),
        },
      },
    });
    const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
    const invoke = vi.spyOn(eventDispatcher, "invoke").mockResolvedValue({ accepted: true });
    const entry = start(account.accountId, { account, eventDispatcher });
    await entry.ready;
    expect(
      getActivePluginRegistry()?.httpRoutes.find(
        (route) => route.path === account.config.webhookPath,
      )?.legacyListeners ?? [],
    ).toEqual([]);
    host.listener = { port: 3000, host: "127.0.0.1" };
    let response = await postSignedPayload(entry.url, payload);
    expect(response.status).toBe(404);
    expect(invoke).not.toHaveBeenCalled();
    host.listener = undefined;
    response = await postSignedPayload(entry.url, payload);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("does not publish healthy activity when the client aborts a held signed dispatch", async () => {
    const path = "/hook-e2e-aborted-signed-dispatch";
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
    const entry = start("aborted-signed-dispatch", { path, eventDispatcher, statusSink });
    await entry.ready;
    const socket = createConnection({ host: "127.0.0.1", port: gatewayPort });
    try {
      statusSink.mockClear();
      const responseClosed = new Promise<void>((resolve) => {
        getGatewayServer().once("request", (_req, res) => res.once("close", resolve));
      });
      const rawBody = JSON.stringify({
        ...payload,
        header: { event_type: "test.aborted_dispatch" },
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
      expect(handler).toHaveBeenCalledOnce();
      expect(statusSink).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      dispatchGate.resolve();
      entry.abort.abort();
      await entry.monitor;
    }
  });
});
