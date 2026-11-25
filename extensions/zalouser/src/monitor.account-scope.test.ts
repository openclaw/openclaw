import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { expect, it, vi } from "vitest";
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

type ListenerParams = Parameters<typeof import("./zalo-js.js").startZaloListener>[0];

it("publishes ready and scopes DM pairing-store reads and requests to accountId", async () => {
  const readAllowFromStore = vi.fn(async ({ accountId }: { accountId?: string }) =>
    accountId === "beta" ? [] : ["attacker"],
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

  const config = {
    channels: { zalouser: { accounts: { alpha: account.config, beta: account.config } } },
  };
  const msgId = "msg-1";
  const message = createZalouserDmMessage({ senderId: "attacker", msgId });
  const statusSink = vi.fn();
  const listener = Promise.withResolvers<ListenerParams>();
  startZaloListenerMock.mockImplementationOnce(async (listenerParams) => {
    listener.resolve(listenerParams);
    return { stop: vi.fn() };
  });
  await withZalouserIngressTestQueue(async (ingressQueue) => {
    const abortController = new AbortController();
    const run = monitorZalouserProvider({
      account,
      config,
      statusSink,
      ingressQueue,
      abortSignal: abortController.signal,
      runtime: createZalouserRuntimeEnv(),
    });
    try {
      const listenerParams = await listener.promise;
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
      const terminal = observeZalouserIngressVerdict(ingressQueue, msgId, "completed");
      await listenerParams.onMessage(createRawZalouserMessageFromNormalized(message));
      await terminal;
    } finally {
      abortController.abort();
      await run;
    }
  });

  expect(readAllowFromStore).toHaveBeenCalledExactlyOnceWith({
    channel: "zalouser",
    accountId: "beta",
  });
  expect(upsertPairingRequest).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ channel: "zalouser", id: "attacker", accountId: "beta" }),
  );
  expect(sendMessageZalouserMock).toHaveBeenCalled();
});
