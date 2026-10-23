import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, vi } from "vitest";
import { monitorTwitchProvider } from "./monitor.js";
import { setTwitchRuntime } from "./runtime.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

const createIngress = vi.hoisted(() =>
  vi.fn<typeof import("./twitch-ingress.js").createTwitchIngress>(),
);

// mock-isolation: admission fixtures use the real monitor and policy without a Twitch socket or drain.
vi.mock("./client-manager-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client-manager-registry.js")>()),
  getOrCreateClientManager: () => ({
    getClient: async () => ({}),
    onMessage: () => () => {},
  }),
}));
vi.mock("./twitch-ingress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./twitch-ingress.js")>()),
  createTwitchIngress: createIngress,
}));

afterAll(() => {
  vi.doUnmock("./client-manager-registry.js");
  vi.doUnmock("./twitch-ingress.js");
  vi.resetModules();
});

export async function checkTwitchMessageThroughMonitor(params: {
  account: TwitchAccountConfig;
  accountId: string;
  message: TwitchChatMessage;
}) {
  const core = createPluginRuntimeMock();
  setTwitchRuntime(core);
  createIngress.mockReturnValue({ accept: async () => {}, start: () => {}, stop: async () => {} });
  const monitor = await monitorTwitchProvider({
    account: params.account,
    accountId: params.accountId,
    config: {},
    channelRuntime: core.channel,
    runtime: { log: vi.fn(), error: vi.fn() },
    abortSignal: new AbortController().signal,
  });
  try {
    const deliver = createIngress.mock.lastCall?.[0].deliver;
    if (!deliver) {
      throw new Error("Expected Twitch monitor delivery");
    }
    await deliver(params.message, {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: async () => {},
      onDeferred: () => {},
      onAbandoned: async () => {},
    });
    return { allowed: vi.mocked(core.channel.inbound.run).mock.calls.length > 0 };
  } finally {
    await monitor.stop();
  }
}
