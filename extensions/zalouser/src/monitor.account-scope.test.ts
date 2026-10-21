import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { sendMessageZalouserMock } from "./monitor.send.test-mocks.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { startZaloListenerMock } from "./zalo-js.test-mocks.js";
import {
  createRawZalouserMessageFromNormalized,
  observeZalouserIngressVerdict,
  withZalouserIngressTestQueue,
} from "./ingress.test-support.js";
import { monitorZalouserProvider } from "./monitor.js";
import { setZalouserRuntime } from "./runtime.js";
import {
  createDefaultResolvedZalouserAccount,
  createZalouserDmMessage,
  createZalouserRuntimeEnv,
} from "./test-helpers.js";

type ZaloJsModule = typeof import("./zalo-js.js");
type ListenerParams = Parameters<ZaloJsModule["startZaloListener"]>[0];

type MonitorOptions = Parameters<typeof monitorZalouserProvider>[0];
async function withMonitor(
  options: Partial<Pick<MonitorOptions, "account" | "config" | "statusSink">>,
  fn: (queue: NonNullable<MonitorOptions["ingressQueue"]>) => Promise<void>,
) {
  await withZalouserIngressTestQueue(async (ingressQueue) => {
    const abortController = new AbortController();
    const run = monitorZalouserProvider({
      account: createDefaultResolvedZalouserAccount({ name: undefined }),
      config: {},
      ...options,
      ingressQueue,
      abortSignal: abortController.signal,
      runtime: createZalouserRuntimeEnv(),
    });
    try {
      await fn(ingressQueue);
    } finally {
      abortController.abort();
      await run;
    }
  });
}

describe("zalouser monitor pairing account scoping", () => {
  it("scopes DM pairing-store reads and pairing requests to accountId", async () => {
    const readAllowFromStore = vi.fn(
      async (
        channelOrParams:
          | string
          | {
              channel?: string;
              accountId?: string;
            },
        _env?: NodeJS.ProcessEnv,
        accountId?: string,
      ) => {
        const scopedAccountId =
          typeof channelOrParams === "object" && channelOrParams !== null
            ? channelOrParams.accountId
            : accountId;
        return scopedAccountId === "beta" ? [] : ["attacker"];
      },
    );
    const upsertPairingRequest = vi.fn(
      async (_params: { channel: string; id: string; accountId?: string }) => ({
        code: "PAIRME88",
        created: true,
      }),
    );

    setZalouserRuntime({
      logging: { shouldLogVerbose: () => false },
      channel: {
        inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress },
        pairing: {
          readAllowFromStore,
          upsertPairingRequest,
          buildPairingReply: vi.fn(() => "pairing reply"),
        },
        commands: {
          shouldComputeCommandAuthorized: vi.fn(() => false),
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          isControlCommandMessage: vi.fn(() => false),
        },
      },
    } as unknown as PluginRuntime);

    const account = createDefaultResolvedZalouserAccount({
      accountId: "beta",
      profile: "beta",
      name: undefined,
      config: { dmPolicy: "pairing", allowFrom: [] },
    });

    const config: OpenClawConfig = {
      channels: {
        zalouser: {
          accounts: {
            alpha: { dmPolicy: "pairing", allowFrom: [] },
            beta: { dmPolicy: "pairing", allowFrom: [] },
          },
        },
      },
    };

    const message = createZalouserDmMessage({
      threadId: "chat-1",
      senderId: "attacker",
      senderName: "Attacker",
      msgId: "msg-1",
    });

    let resolveListener: ((params: ListenerParams) => void) | undefined;
    const listenerReady = new Promise<ListenerParams>((resolve) => {
      resolveListener = resolve;
    });
    startZaloListenerMock.mockImplementationOnce(async (listenerParams) => {
      resolveListener?.(listenerParams);
      return { stop: vi.fn() };
    });
    await withMonitor({ account, config }, async (ingressQueue) => {
      const listenerParams = await listenerReady;
      const terminal = observeZalouserIngressVerdict(ingressQueue, "msg-1", "completed");
      await listenerParams.onMessage(createRawZalouserMessageFromNormalized(message));
      await terminal;
    });

    expect(readAllowFromStore).toHaveBeenCalledOnce();
    expect(readAllowFromStore.mock.calls[0]?.[0]).toMatchObject({
      channel: "zalouser",
      accountId: "beta",
    });

    expect(upsertPairingRequest).toHaveBeenCalledOnce();
    expect(upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "zalouser",
        id: "attacker",
        accountId: "beta",
      }),
    );
    expect(sendMessageZalouserMock).toHaveBeenCalled();
  });
});

describe("zalouser monitor lifecycle", () => {
  it("publishes ready after the listener starts", async () => {
    setZalouserRuntime({
      logging: { shouldLogVerbose: () => false },
    } as unknown as PluginRuntime);
    startZaloListenerMock.mockResolvedValueOnce({ stop: vi.fn() });
    const statusSink = vi.fn();

    await withMonitor({ statusSink }, async () => {
      await vi.waitFor(() => {
        expect(statusSink).toHaveBeenCalledWith({
          running: true,
          connected: true,
          lifecycle: "ready",
          lastConnectedAt: expect.any(Number),
          lastError: null,
          terminalDisconnect: undefined,
        });
      });
    });
  });
});
