import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCodexAppServerConnectionHealthService } from "./connection-health.js";
import { createClientHarness } from "./test-support.js";

const lease = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }));
// mock-isolation: The fixture owns client leases; never acquire the process-shared client.
vi.mock("./shared-client.js", () => ({
  getLeasedSharedCodexAppServerClient: lease.acquire,
  releaseLeasedSharedCodexAppServerClient: lease.release,
}));

let stopService: (() => void | Promise<void>) | undefined;
const clients: ReturnType<typeof createClientHarness>["client"][] = [];

describe("Codex remote WebSocket connection health", () => {
  beforeAll(async () => {
    // Complete lazy-module fixture preparation before measuring connection and retry behavior.
    await Promise.all([import("./config-runtime.js"), import("./client.js")]);
  });

  afterEach(async () => {
    try {
      await stopService?.();
    } finally {
      for (const client of clients.splice(0)) {
        client.close();
      }
      stopService = undefined;
      lease.acquire.mockReset();
      lease.release.mockReset();
      vi.useRealTimers();
    }
  });

  it("retries a transient remote connection failure without starting a model", async () => {
    const client = createClient();
    lease.acquire
      .mockRejectedValueOnce(new Error("Opening handshake has timed out"))
      .mockResolvedValueOnce(client.client);
    await createService();

    await vi.waitFor(
      () => {
        expect(lease.acquire).toHaveBeenCalledTimes(2);
        expect(client.addCloseHandler).toHaveBeenCalledOnce();
      },
      { timeout: 3_000 },
    );
    expect(client.request).not.toHaveBeenCalled();

    await stopService?.();

    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("reconnects when a leased client closed before the health observer subscribed", async () => {
    vi.useFakeTimers();
    const first = createClientHarness();
    first.client.close();
    const next = createClient();
    lease.acquire.mockResolvedValueOnce(first.client).mockResolvedValueOnce(next.client);
    await createService();
    await vi.advanceTimersByTimeAsync(1_250);

    expect(lease.acquire).toHaveBeenCalledTimes(2);
    expect(lease.release).toHaveBeenCalledWith(first.client);
    expect(next.addCloseHandler).toHaveBeenCalledOnce();
    expect(first.writes).toEqual([]);
    expect(next.request).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "HTTP 403", error: "Unexpected server response: 403", calls: 1 },
    { reason: "invalid configuration", error: undefined, calls: 0 },
  ])("does not retry $reason", async ({ error, calls }) => {
    if (error) {
      lease.acquire.mockRejectedValueOnce(new Error(error));
    }
    const ctx = await createService(error ? undefined : { appServer: { transport: "websocket" } });
    await vi.waitFor(() => {
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining(error ?? "configuration is invalid"),
      );
    });
    expect(lease.acquire).toHaveBeenCalledTimes(calls);
    await stopService?.();
    expect(lease.release).not.toHaveBeenCalled();
  });
});

function createClient() {
  const { client } = createClientHarness();
  clients.push(client);
  return {
    client,
    request: vi.spyOn(client, "request"),
    addCloseHandler: vi.spyOn(client, "addCloseHandler"),
  };
}

async function createService(
  pluginConfig: unknown = {
    appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
  },
) {
  const ctx: OpenClawPluginServiceContext = {
    config: {},
    stateDir: "/tmp/openclaw-codex-connection-health-test",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
  const service = createCodexAppServerConnectionHealthService({
    getPluginConfig: () => pluginConfig,
    getRuntimeConfig: () => ctx.config,
  });
  stopService = () => service.stop?.(ctx);
  await service.start(ctx);
  return ctx;
}
