import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { createPluginRuntimeMock } from "../../../test/helpers/extensions/plugin-runtime-mock.js";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import type { ResolvedZaloAccount } from "./accounts.js";
import { clearZaloWebhookSecurityStateForTest, monitorZaloProvider } from "./monitor.js";

const setWebhookMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, result: { url: "" } })));
const deleteWebhookMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, result: { url: "" } })));
const getWebhookInfoMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, result: { url: "" } })));
const getUpdatesMock = vi.hoisted(() => vi.fn(() => new Promise(() => {})));
const sendChatActionMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const sendMessageMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, result: { message_id: "pairing-zalo-1" } })),
);
const sendPhotoMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const getZaloRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    deleteWebhook: deleteWebhookMock,
    getUpdates: getUpdatesMock,
    getWebhookInfo: getWebhookInfoMock,
    sendChatAction: sendChatActionMock,
    sendMessage: sendMessageMock,
    sendPhoto: sendPhotoMock,
    setWebhook: setWebhookMock,
  };
});

vi.mock("./runtime.js", () => ({
  getZaloRuntime: getZaloRuntimeMock,
}));

async function withServer(handler: RequestListener, fn: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function createLifecycleConfig(): OpenClawConfig {
  return {
    channels: {
      zalo: {
        enabled: true,
        accounts: {
          "acct-zalo-pairing": {
            enabled: true,
            webhookUrl: "https://example.com/hooks/zalo",
            webhookSecret: "supersecret", // pragma: allowlist secret
            dmPolicy: "pairing",
            allowFrom: [],
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createLifecycleAccount(): ResolvedZaloAccount {
  return {
    accountId: "acct-zalo-pairing",
    enabled: true,
    token: "zalo-token",
    tokenSource: "config",
    config: {
      webhookUrl: "https://example.com/hooks/zalo",
      webhookSecret: "supersecret", // pragma: allowlist secret
      dmPolicy: "pairing",
      allowFrom: [],
    },
  } as ResolvedZaloAccount;
}

function createRuntimeEnv() {
  return {
    log: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  };
}

function createTextUpdate(messageId: string) {
  return {
    event_name: "message.text.received",
    message: {
      from: { id: "user-unauthorized", name: "Unauthorized User" },
      chat: { id: "dm-pairing-1", chat_type: "PRIVATE" as const },
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      text: "hello from zalo",
    },
  };
}

async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function postWebhookUpdate(params: {
  baseUrl: string;
  path: string;
  secret: string;
  payload: Record<string, unknown>;
}) {
  return await fetch(`${params.baseUrl}${params.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bot-api-secret-token": params.secret,
    },
    body: JSON.stringify(params.payload),
  });
}

describe("Zalo pairing lifecycle", () => {
  const readAllowFromStoreMock = vi.fn(async () => [] as string[]);
  const upsertPairingRequestMock = vi.fn(async () => ({ code: "PAIRCODE", created: true }));
  beforeEach(() => {
    vi.clearAllMocks();
    clearZaloWebhookSecurityStateForTest();

    getZaloRuntimeMock.mockReturnValue(
      createPluginRuntimeMock({
        channel: {
          pairing: {
            readAllowFromStore:
              readAllowFromStoreMock as unknown as PluginRuntime["channel"]["pairing"]["readAllowFromStore"],
            upsertPairingRequest:
              upsertPairingRequestMock as unknown as PluginRuntime["channel"]["pairing"]["upsertPairingRequest"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
        },
      }),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("emits one pairing reply across duplicate webhook replay and scopes reads and writes to accountId", async () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    const abort = new AbortController();
    const runtime = createRuntimeEnv();
    const run = monitorZaloProvider({
      token: "zalo-token",
      account: createLifecycleAccount(),
      config: createLifecycleConfig(),
      runtime,
      abortSignal: abort.signal,
      useWebhook: true,
      webhookUrl: "https://example.com/hooks/zalo",
      webhookSecret: "supersecret",
    });

    await vi.waitFor(() => {
      expect(setWebhookMock).toHaveBeenCalledTimes(1);
      expect(registry.httpRoutes).toHaveLength(1);
    });
    const route = registry.httpRoutes[0];
    if (!route) {
      throw new Error("missing plugin HTTP route");
    }

    await withServer(
      (req, res) => route.handler(req, res),
      async (baseUrl) => {
        const payload = createTextUpdate(`zalo-pairing-${Date.now()}`);
        const first = await postWebhookUpdate({
          baseUrl,
          path: "/hooks/zalo",
          secret: "supersecret",
          payload,
        });
        const second = await postWebhookUpdate({
          baseUrl,
          path: "/hooks/zalo",
          secret: "supersecret",
          payload,
        });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        await settleAsyncWork();
      },
    );

    expect(readAllowFromStoreMock).toHaveBeenCalledTimes(1);
    expect(readAllowFromStoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "zalo",
        accountId: "acct-zalo-pairing",
      }),
    );
    expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
    expect(upsertPairingRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "zalo",
        accountId: "acct-zalo-pairing",
        id: "user-unauthorized",
      }),
    );
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      "zalo-token",
      expect.objectContaining({
        chat_id: "dm-pairing-1",
        text: expect.stringContaining("PAIRCODE"),
      }),
      undefined,
    );

    abort.abort();
    await run;
  });

  it("does not emit a second pairing reply when replay arrives after the first send fails", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("pairing send failed"));

    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    const abort = new AbortController();
    const runtime = createRuntimeEnv();
    const run = monitorZaloProvider({
      token: "zalo-token",
      account: createLifecycleAccount(),
      config: createLifecycleConfig(),
      runtime,
      abortSignal: abort.signal,
      useWebhook: true,
      webhookUrl: "https://example.com/hooks/zalo",
      webhookSecret: "supersecret",
    });

    await vi.waitFor(() => {
      expect(setWebhookMock).toHaveBeenCalledTimes(1);
      expect(registry.httpRoutes).toHaveLength(1);
    });
    const route = registry.httpRoutes[0];
    if (!route) {
      throw new Error("missing plugin HTTP route");
    }

    await withServer(
      (req, res) => route.handler(req, res),
      async (baseUrl) => {
        const payload = createTextUpdate(`zalo-pairing-retry-${Date.now()}`);
        const first = await postWebhookUpdate({
          baseUrl,
          path: "/hooks/zalo",
          secret: "supersecret",
          payload,
        });
        await settleAsyncWork();
        const replay = await postWebhookUpdate({
          baseUrl,
          path: "/hooks/zalo",
          secret: "supersecret",
          payload,
        });

        expect(first.status).toBe(200);
        expect(replay.status).toBe(200);
        await settleAsyncWork();
      },
    );

    expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(runtime.error).not.toHaveBeenCalled();

    abort.abort();
    await run;
  });
});
