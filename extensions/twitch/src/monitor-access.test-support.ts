import { expectDefined } from "@openclaw/normalization-core";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { vi } from "vitest";
import { monitorTwitchProvider } from "./monitor.js";
import { setTwitchRuntime } from "./runtime.js";
import type { TwitchClientManager as Manager } from "./twitch-client.js";
import type { TwitchChatMessage } from "./types.js";

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
function fixture() {
  const pending: Promise<void>[] = [];
  const f = {
    core: createPluginRuntimeMock(),
    send: vi.fn<Manager["sendMessage"]>().mockResolvedValue({ ok: true, messageId: "message-id" }),
    error: vi.fn(),
    unregister: vi.fn(),
    ingressStop: vi.fn(async () => {
      await Promise.allSettled(pending);
    }),
  };
  let handler: ((message: TwitchChatMessage) => void) | undefined;
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
    stop: f.ingressStop,
  }));
  return {
    ...f,
    dispatch: async (message: TwitchChatMessage) => {
      expectDefined(handler, "Expected Twitch message handler")(message);
      await Promise.all(pending);
    },
  };
}
type Params = Pick<
  Parameters<typeof monitorTwitchProvider>[0],
  "account" | "accountId" | "config" | "statusSink"
>;
export async function withTwitchMonitor<T>(
  params: Params,
  run: (f: ReturnType<typeof fixture>) => Promise<T>,
) {
  const f = fixture();
  setTwitchRuntime(f.core);
  const monitor = await monitorTwitchProvider({
    ...params,
    channelRuntime: f.core.channel,
    runtime: { error: f.error },
    abortSignal: new AbortController().signal,
  });
  try {
    return await run(f);
  } finally {
    await monitor.stop();
  }
}

export const checkTwitchMessageThroughMonitor = (
  params: Pick<Params, "account" | "accountId"> & { message: TwitchChatMessage },
) =>
  withTwitchMonitor({ ...params, config: {} }, async ({ core, dispatch }) => {
    await dispatch(params.message);
    return { allowed: vi.mocked(core.channel.inbound.run).mock.calls.length > 0 };
  });
