import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { monitorNextcloudTalkProvider } from "./monitor-runtime.js";
import { setNextcloudTalkRuntime } from "./runtime.js";

function createMonitorFixture() {
  setNextcloudTalkRuntime(createPluginRuntimeMock() as unknown as PluginRuntime);
  const abortController = new AbortController();
  const statusSink = vi.fn();
  const spool = {
    receive: vi.fn(async () => "accepted" as const),
    ready: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
  };
  const server = {
    server: {} as never,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  return {
    abortController,
    spool,
    server,
    options: {
      config: {
        channels: {
          "nextcloud-talk": {
            baseUrl: "https://cloud.example.com",
            botSecret: "test-bot-secret",
          },
        },
      },
      runtime: createRuntimeSpies(),
      abortSignal: abortController.signal,
      statusSink,
      createSpool: () => spool,
      createServer: () => server,
    },
  };
}

describe("Nextcloud Talk monitor abort", () => {
  it("stops both the webhook listener and durable spool after startup", async () => {
    const { abortController, spool, server, options } = createMonitorFixture();
    const createSpool = vi.fn(options.createSpool);
    const createServer = vi.fn(options.createServer);
    const monitor = await monitorNextcloudTalkProvider({
      ...options,
      config: {
        ...options.config,
        gateway: { trustedProxies: ["127.0.0.1"], allowRealIpFallback: true },
      },
      createSpool,
      createServer,
    });

    expect(createSpool).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedProxies: ["127.0.0.1"],
        allowRealIpFallback: true,
      }),
    );
    expect(options.statusSink).toHaveBeenCalledExactlyOnceWith({
      running: true,
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: expect.any(Number),
      lastError: null,
      terminalDisconnect: undefined,
    });
    abortController.abort();
    await vi.waitFor(() => expect(spool.stop).toHaveBeenCalledOnce());
    await monitor.stop();

    expect(server.stop).toHaveBeenCalledOnce();
    expect(spool.stop).toHaveBeenCalledOnce();
  });

  it("does not publish ready when startup is aborted after the listener opens", async () => {
    const { abortController, spool, server, options } = createMonitorFixture();
    server.start.mockImplementation(async () => abortController.abort());
    await monitorNextcloudTalkProvider(options);

    expect(options.statusSink).not.toHaveBeenCalled();
    expect(server.stop).toHaveBeenCalledOnce();
    expect(spool.stop).toHaveBeenCalledOnce();
  });
});
