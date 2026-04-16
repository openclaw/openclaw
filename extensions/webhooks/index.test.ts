import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi } from "./api.js";

const mocks = vi.hoisted(() => ({
  resolveWebhooksPluginConfigSync: vi.fn<
    typeof import("./src/config.js").resolveWebhooksPluginConfigSync
  >(() => []),
  resolveWebhooksPluginConfig: vi.fn<typeof import("./src/config.js").resolveWebhooksPluginConfig>(
    async () => [],
  ),
}));

vi.mock("./src/config.js", () => ({
  resolveWebhooksPluginConfigSync: mocks.resolveWebhooksPluginConfigSync,
  resolveWebhooksPluginConfig: mocks.resolveWebhooksPluginConfig,
}));

import plugin from "./index.js";

function createApi(params?: {
  registerHttpRoute?: OpenClawPluginApi["registerHttpRoute"];
  logger?: OpenClawPluginApi["logger"];
}): OpenClawPluginApi {
  const logger =
    params?.logger ??
    ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as OpenClawPluginApi["logger"]);

  return createTestPluginApi({
    id: "webhooks",
    name: "Webhooks",
    version: "0",
    source: "test",
    pluginConfig: {},
    runtime: {
      taskFlow: {
        bindSession: vi.fn(({ sessionKey }: { sessionKey: string }) => ({ sessionKey })),
      },
    } as unknown as OpenClawPluginApi["runtime"],
    registerHttpRoute: params?.registerHttpRoute,
    logger,
  });
}

describe("webhooks plugin registration", () => {
  beforeEach(() => {
    mocks.resolveWebhooksPluginConfigSync.mockReset();
    mocks.resolveWebhooksPluginConfig.mockReset();
    mocks.resolveWebhooksPluginConfigSync.mockReturnValue([]);
    mocks.resolveWebhooksPluginConfig.mockResolvedValue([]);
  });

  it("registers inline-secret routes synchronously", () => {
    const registerHttpRoute = vi.fn();
    mocks.resolveWebhooksPluginConfigSync.mockReturnValue([
      {
        routeId: "visionclaw",
        path: "/plugins/webhooks/visionclaw",
        sessionKey: "agent:main:main",
        secret: "shared-secret",
        controllerId: "webhooks/visionclaw",
      },
    ]);

    const result = plugin.register(createApi({ registerHttpRoute }));

    expect(result).toBeUndefined();
    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(mocks.resolveWebhooksPluginConfig).not.toHaveBeenCalled();
  });

  it("falls back to async route resolution when sync resolution is unavailable", async () => {
    const registerHttpRoute = vi.fn();
    mocks.resolveWebhooksPluginConfigSync.mockReturnValue(null);
    mocks.resolveWebhooksPluginConfig.mockResolvedValue([
      {
        routeId: "visionclaw",
        path: "/plugins/webhooks/visionclaw",
        sessionKey: "agent:main:main",
        secret: "shared-secret",
        controllerId: "webhooks/visionclaw",
      },
    ]);

    const result = plugin.register(createApi({ registerHttpRoute }));

    expect(result).toBeUndefined();
    expect(registerHttpRoute).not.toHaveBeenCalled();

    await Promise.resolve();
    await Promise.resolve();

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
  });

  it("warns when async route resolution fails", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mocks.resolveWebhooksPluginConfigSync.mockReturnValue(null);
    mocks.resolveWebhooksPluginConfig.mockRejectedValue(new Error("boom"));

    const result = plugin.register(createApi({ logger }));

    expect(result).toBeUndefined();

    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith("[webhooks] failed to resolve webhook routes: boom");
  });
});
