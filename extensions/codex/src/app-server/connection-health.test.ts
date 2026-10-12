import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createCodexAppServerConnectionHealthService } from "./connection-health.js";
import { createClientHarness } from "./test-support.js";

const sharedClientMocks = vi.hoisted(() => ({
  getLeasedSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./shared-client.js", () => sharedClientMocks);

let runningService:
  | { service: OpenClawPluginService; ctx: OpenClawPluginServiceContext }
  | undefined;

describe("Codex remote WebSocket connection health", () => {
  beforeAll(async () => {
    // Complete lazy-module fixture preparation before measuring connection and retry behavior.
    await Promise.all([import("./config-runtime.js"), import("./client.js")]);
  });

  afterEach(async () => {
    try {
      if (runningService) {
        await runningService.service.stop?.(runningService.ctx);
      }
    } finally {
      runningService = undefined;
      sharedClientMocks.getLeasedSharedCodexAppServerClient.mockReset();
      sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
      vi.useRealTimers();
    }
  });

  it("retries a transient remote connection failure without starting a model", async () => {
    const client = createClient();
    sharedClientMocks.getLeasedSharedCodexAppServerClient
      .mockRejectedValueOnce(new Error("Opening handshake has timed out"))
      .mockResolvedValueOnce(client.client);
    const { ctx, service } = createService();

    await startService(service, ctx);

    await vi.waitFor(
      () => {
        expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
        expect(client.addCloseHandler).toHaveBeenCalledOnce();
      },
      { timeout: 3_000 },
    );
    expect(client.request).not.toHaveBeenCalled();

    await service.stop?.(ctx);

    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
  });

  it("reconnects when a leased client closed before the health observer subscribed", async () => {
    vi.useFakeTimers();
    const first = createClientHarness();
    first.client.close();
    const next = createClient();
    sharedClientMocks.getLeasedSharedCodexAppServerClient
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(next.client);
    const { ctx, service } = createService();

    await startService(service, ctx);
    await vi.advanceTimersByTimeAsync(1_250);

    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
      first.client,
    );
    expect(next.addCloseHandler).toHaveBeenCalledOnce();
    expect(first.writes).toEqual([]);
    expect(next.request).not.toHaveBeenCalled();
  });

  it("does not retry an HTTP 403 authentication failure", async () => {
    const statusCode = 403;
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockRejectedValueOnce(
      new Error(`Unexpected server response: ${statusCode}`),
    );
    const { ctx, service } = createService();

    await startService(service, ctx);

    await vi.waitFor(() => {
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining(`Unexpected server response: ${statusCode}`),
      );
    });
    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();

    await service.stop?.(ctx);

    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("does not retry an invalid remote app-server configuration", async () => {
    const { ctx, service } = createService({ appServer: { transport: "websocket" } });

    await startService(service, ctx);

    await vi.waitFor(() => {
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("configuration is invalid"),
      );
    });
    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).not.toHaveBeenCalled();

    await service.stop?.(ctx);
  });
});

function startService(service: OpenClawPluginService, ctx: OpenClawPluginServiceContext) {
  runningService = { service, ctx };
  return service.start(ctx);
}

function createClient() {
  const handlers = new Set<(client: CodexAppServerClient) => void>();
  const request = vi.fn();
  const addCloseHandler = vi.fn((handler: (client: CodexAppServerClient) => void) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  });
  const client = {
    addCloseHandler,
    request,
    getCloseError: () => undefined,
  } as unknown as CodexAppServerClient;

  return {
    client,
    request,
    addCloseHandler,
  };
}

function createService(
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
  return {
    ctx,
    service: createCodexAppServerConnectionHealthService({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => ctx.config,
    }),
  };
}
