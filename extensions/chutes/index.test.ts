import { describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/extensions/plugin-registration.js";

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  buildOauthProviderAuthResult: vi.fn(),
  createProviderApiKeyAuthMethod: vi.fn((params: { methodId: string; label: string }) => ({
    id: params.methodId,
    label: params.label,
    kind: "api-key",
  })),
  loginChutes: vi.fn(),
  resolveOAuthApiKeyMarker: vi.fn((providerId: string) => `oauth:${providerId}`),
}));

vi.mock("./onboard.js", () => ({
  CHUTES_DEFAULT_MODEL_REF: "chutes/test-model",
  applyChutesApiKeyConfig: vi.fn((cfg: unknown) => cfg),
  applyChutesProviderConfig: vi.fn((cfg: unknown) => cfg),
}));

vi.mock("./provider-catalog.js", () => ({
  buildChutesProvider: vi.fn(async () => ({
    api: "openai-completions",
    baseUrl: "https://chutes.test",
    models: [],
  })),
}));

describe("chutes provider plugin", () => {
  it("registers OAuth and API key auth flows under one provider", async () => {
    const { default: chutesPlugin } = await import("./index.js");
    const provider = registerSingleProviderPlugin(chutesPlugin);

    expect(provider.id).toBe("chutes");
    expect(provider.auth.map((method) => method.id)).toEqual(["oauth", "api-key"]);
    expect(provider.catalog?.run).toEqual(expect.any(Function));
  });
});
