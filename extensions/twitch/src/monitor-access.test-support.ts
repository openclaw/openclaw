import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, vi } from "vitest";
import { monitorTwitchProvider } from "./monitor.js";
import { setTwitchRuntime } from "./runtime.js";
import type { TwitchClientManager } from "./twitch-client.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

const mocks = vi.hoisted(() => ({
  createIngress: vi.fn<typeof import("./twitch-ingress.js").createTwitchIngress>(),
  manager: vi.fn(),
}));
// mock-isolation: Exercise the real monitor without Twitch sockets or a second durable drain.
vi.mock("./client-manager-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client-manager-registry.js")>()),
  getOrCreateClientManager: mocks.manager,
}));
vi.mock("./twitch-ingress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./twitch-ingress.js")>()),
  createTwitchIngress: mocks.createIngress,
}));
afterAll(() => {
  vi.doUnmock("./client-manager-registry.js");
  vi.doUnmock("./twitch-ingress.js");
  vi.resetModules();
});

function fixture() {
  return {
    core: createPluginRuntimeMock(),
    send: vi
      .fn<TwitchClientManager["sendMessage"]>()
      .mockResolvedValue({ ok: true, messageId: "message-id" }),
    error: vi.fn(),
    unregister: vi.fn(),
    ingressStop: vi.fn(),
  };
}
type Params = Pick<
  Parameters<typeof monitorTwitchProvider>[0],
  "account" | "accountId" | "config" | "statusSink"
>;
export async function withTwitchMonitor<T>(
  params: Params,
  run: (
    f: ReturnType<typeof fixture> & { dispatch: (message: TwitchChatMessage) => Promise<void> },
  ) => Promise<T>,
) {
  const f = fixture();
  setTwitchRuntime(f.core);
  let handler: ((message: TwitchChatMessage) => void) | undefined;
  const pending: Promise<void>[] = [];
  mocks.manager.mockReturnValue({
    getClient: async () => ({}),
    sendMessage: f.send,
    onMessage: (callback: typeof handler) => {
      handler = callback;
      return f.unregister;
    },
  });
  mocks.createIngress.mockImplementation((options) => ({
    accept: async (message) => {
      const delivery = options.deliver(message, {
        admission: "exclusive",
        abortSignal: new AbortController().signal,
        onAdopted: async () => {},
        onDeferred: () => {},
        onAbandoned: async () => {},
      });
      pending.push(delivery);
      await delivery;
      return undefined;
    },
    start: () => {},
    stop: f.ingressStop.mockImplementation(async () => {
      await Promise.allSettled(pending);
    }),
  }));
  const monitor = await monitorTwitchProvider({
    ...params,
    channelRuntime: f.core.channel,
    runtime: { error: f.error },
    abortSignal: new AbortController().signal,
  });
  try {
    return await run({
      ...f,
      dispatch: async (message) => {
        if (!handler) {
          throw new Error("Expected Twitch message handler");
        }
        handler(message);
        await Promise.all(pending);
      },
    });
  } finally {
    await monitor.stop();
  }
}

export async function checkTwitchMessageThroughMonitor(params: {
  account: TwitchAccountConfig;
  accountId: string;
  message: TwitchChatMessage;
}) {
  return withTwitchMonitor({ ...params, config: {} }, async ({ core, dispatch }) => {
    await dispatch(params.message);
    return { allowed: vi.mocked(core.channel.inbound.run).mock.calls.length > 0 };
  });
}
