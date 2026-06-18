// Feishu client module import behavior tests.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@larksuiteoapi/node-sdk");
  vi.doUnmock("@openclaw/proxyline");
  vi.resetModules();
});

describe("Feishu client module", () => {
  it("loads when the SDK has no default HTTP instance", async () => {
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      AppType: { SelfBuild: "self" },
      Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
      LoggerLevel: { info: "info" },
      Client: vi.fn(),
      WSClient: vi.fn(),
      EventDispatcher: vi.fn(),
      defaultHttpInstance: undefined,
    }));
    vi.doMock("@openclaw/proxyline", () => ({
      createAmbientNodeProxyAgent: vi.fn(),
      hasAmbientNodeProxyConfigured: vi.fn(() => false),
    }));

    await expect(import("./client.js")).resolves.toMatchObject({
      createFeishuClient: expect.any(Function),
    });
  });
});
