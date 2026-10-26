import { createConnection } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
  createHeldWebhookDispatch,
  expectWebhookJson,
  getGatewayPort,
  waitForWebhookResponseClose,
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
    invoke?: MonitorParams["invokeWebhookEvent"];
    startMonitor?: typeof monitorWebhook;
  } = {},
) {
  const account = options.account ?? createFeishuWebhookTestAccount(accountId, options.path);
  const abort = new AbortController();
  const ready = createDeferred<void>();
  const monitor = (options.startMonitor ?? monitorWebhook)({
    account,
    accountId,
    gatewayPort,
    abortSignal: abort.signal,
    runtime: createRuntimeSpies(),
    eventDispatcher:
      options.eventDispatcher ?? new Lark.EventDispatcher({ encryptKey: account.encryptKey }),
    ...(!options.eventDispatcher
      ? {
          invokeWebhookEvent:
            options.invoke ??
            (async () => ({ kind: "non-durable" as const, value: { accountId } })),
        }
      : {}),
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
    url: `http://127.0.0.1:${gatewayPort}${account.config.webhookPath}`,
    ready: Promise.race([
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
      const account = createFeishuWebhookTestAccount("shutdown-response");
      if (ending === "finish") {
        account.config.legacyWebhook = { port: 3000, host: "127.0.0.1" };
        host.listener = account.config.legacyWebhook;
      }
      const dispatch = createHeldWebhookDispatch({
        kind: "non-durable" as const,
        value: { accepted: true },
      });
      const entry = start("shutdown-response", { account, invoke: dispatch.handler });
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
        await dispatch.started;
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
          await expectWebhookJson(replacement, { accountId: entry.account.accountId });
          dispatch.release();
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
        dispatch.release();
        entry.abort.abort();
        await request;
        await entry.monitor;
      }
    },
  );

  it("clears recovered identity after normal shutdown finishes draining", async () => {
    const accountId = "identity-handoff";
    const dispatch = createHeldWebhookDispatch({ kind: "non-durable" as const, value: {} });
    setFeishuBotIdentityState(accountId, "ou_initial");
    const entry = start(accountId, { invoke: dispatch.handler });
    await entry.ready;
    const request = postSignedPayload(entry.url, payload);
    try {
      await dispatch.started;
      setFeishuBotIdentityState(accountId, "ou_recovered");
      entry.abort.abort();
      expect(botOpenIds.get(accountId)).toBe("ou_recovered");
      dispatch.release();
      await expectWebhookJson(await request, {});
      await entry.monitor;
      expect(botOpenIds.has(accountId)).toBe(false);
    } finally {
      dispatch.release();
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
      vi.spyOn(eventDispatcher, "invoke").mockResolvedValue({ accepted: true });
      const denied = start(account.accountId, { account, eventDispatcher });
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
      await expectWebhookJson(await postSignedPayload(entry.url, payload), { accepted: true });
    },
  );

  it.each([
    { label: "an omitted listener", root: undefined, accountSetting: undefined },
    { label: "an inherited listener override", root: { port: 3100 }, accountSetting: false },
  ] as const)("keeps Gateway delivery with $label", async ({ root, accountSetting }) => {
    const fixture = createFeishuWebhookTestAccount("legacy-bind-address");
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
    host.listener = { port: 3000, host: "127.0.0.1" };
    let response = await postSignedPayload(entry.url, payload);
    expect(response.status).toBe(404);
    expect(invoke).not.toHaveBeenCalled();
    host.listener = undefined;
    response = await postSignedPayload(entry.url, payload);
    await expectWebhookJson(response, { accepted: true });
  });

  it("does not publish healthy activity when the client aborts a held signed dispatch", async () => {
    const path = "/hook-e2e-aborted-signed-dispatch";
    const dispatch = createHeldWebhookDispatch({ accepted: true });
    const handler = dispatch.handler;
    const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
    eventDispatcher.register({ "test.aborted_dispatch": handler });
    const statusSink = vi.fn();
    const entry = start("aborted-signed-dispatch", { path, eventDispatcher, statusSink });
    await entry.ready;
    const socket = createConnection({ host: "127.0.0.1", port: gatewayPort });
    try {
      statusSink.mockClear();
      const responseClosed = waitForWebhookResponseClose();
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
      await dispatch.started;
      const clientClosed = new Promise<void>((resolve) => {
        socket.once("close", resolve);
      });
      socket.destroy();
      await clientClosed;
      await responseClosed;
      expect(statusSink).not.toHaveBeenCalled();
      dispatch.release();
      await expect(handler.mock.results[0]?.value).resolves.toEqual({ accepted: true });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(statusSink).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      dispatch.release();
      entry.abort.abort();
      await entry.monitor;
    }
  });
});
