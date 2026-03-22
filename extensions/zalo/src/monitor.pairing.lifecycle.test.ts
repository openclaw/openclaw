import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../../test/helpers/extensions/plugin-runtime-mock.js";
import {
  createLifecycleAccount,
  createLifecycleConfig,
  createTextUpdate,
  getZaloRuntimeMock,
  postWebhookUpdate,
  resetLifecycleTestState,
  sendMessageMock,
  settleAsyncWork,
  startWebhookLifecycleMonitor,
} from "../../../test/helpers/extensions/zalo-lifecycle.js";
import { withServer } from "../../../test/helpers/http-test-server.js";
import type { PluginRuntime } from "../runtime-api.js";

describe("Zalo pairing lifecycle", () => {
  const readAllowFromStoreMock = vi.fn(async () => [] as string[]);
  const upsertPairingRequestMock = vi.fn(async () => ({ code: "PAIRCODE", created: true }));
  beforeEach(() => {
    resetLifecycleTestState();

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
    resetLifecycleTestState();
  });

  it("emits one pairing reply across duplicate webhook replay and scopes reads and writes to accountId", async () => {
    const { abort, route, run } = await startWebhookLifecycleMonitor({
      account: createLifecycleAccount({
        accountId: "acct-zalo-pairing",
        dmPolicy: "pairing",
        allowFrom: [],
      }),
      config: createLifecycleConfig({
        accountId: "acct-zalo-pairing",
        dmPolicy: "pairing",
        allowFrom: [],
      }),
    });

    await withServer(
      (req, res) => route.handler(req, res),
      async (baseUrl) => {
        const payload = createTextUpdate({
          messageId: `zalo-pairing-${Date.now()}`,
          userId: "user-unauthorized",
          userName: "Unauthorized User",
          chatId: "dm-pairing-1",
        });
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

    const { abort, route, run, runtime } = await startWebhookLifecycleMonitor({
      account: createLifecycleAccount({
        accountId: "acct-zalo-pairing",
        dmPolicy: "pairing",
        allowFrom: [],
      }),
      config: createLifecycleConfig({
        accountId: "acct-zalo-pairing",
        dmPolicy: "pairing",
        allowFrom: [],
      }),
    });

    await withServer(
      (req, res) => route.handler(req, res),
      async (baseUrl) => {
        const payload = createTextUpdate({
          messageId: `zalo-pairing-retry-${Date.now()}`,
          userId: "user-unauthorized",
          userName: "Unauthorized User",
          chatId: "dm-pairing-1",
        });
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
