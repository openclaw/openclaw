import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "./model-types.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("./provider-request-config.js", () => ({
  buildProviderRequestDispatcherPolicy: vi.fn(() => ({ mode: "direct" })),
  getModelProviderRequestTransport: vi.fn(() => undefined),
  mergeModelProviderRequestOverrides: vi.fn((current, overrides) => ({ ...current, ...overrides })),
  resolveProviderRequestPolicyConfig: vi.fn(() => ({ allowPrivateNetwork: false })),
}));

describe("buildGuardedModelFetch", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset().mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    delete process.env.OPENCLAW_DEBUG_PROXY_URL;
  });

  it("pushes provider capture metadata into the shared guarded fetch seam", async () => {
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"hello"}',
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/responses",
        capture: {
          meta: {
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.4",
          },
        },
      }),
    );
  });
});
