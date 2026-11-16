import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintSecretSentinel, resolveSecretSentinel } from "../secrets/sentinel.js";

const loadConfigWithSource = vi.fn();
const defaultCredentials = vi.fn();

vi.mock("@anthropic-ai/sdk/core/credentials", () => ({ loadConfigWithSource }));
vi.mock("@anthropic-ai/sdk/lib/credentials/credential-chain", () => ({ defaultCredentials }));

const {
  isAnthropicWorkloadIdentityToken,
  refreshAnthropicWorkloadIdentityApiKey,
  resolveAnthropicWorkloadIdentityToken,
} = await import("./anthropic-workload-identity.js");
const { resetAnthropicWorkloadIdentityForTest } =
  await import("./anthropic-workload-identity.test-support.js");

const federationConfig = {
  fromFile: false,
  config: {
    authentication: { type: "oidc_federation", federation_rule_id: "fdrl_test" },
    organization_id: "org-test",
  },
};

function mockExchange(...tokens: Array<{ token: string; expiresInSeconds: number }>) {
  const provider = vi.fn();
  for (const { token, expiresInSeconds } of tokens) {
    provider.mockImplementationOnce(async () => ({
      token,
      expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
    }));
  }
  loadConfigWithSource.mockResolvedValue(federationConfig);
  defaultCredentials.mockResolvedValue({ provider, extraHeaders: {} });
  return provider;
}

beforeEach(() => {
  resetAnthropicWorkloadIdentityForTest();
  loadConfigWithSource.mockReset();
  defaultCredentials.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveAnthropicWorkloadIdentityToken", () => {
  it("stays inert when workload identity is not configured", async () => {
    loadConfigWithSource.mockResolvedValue(null);

    await expect(resolveAnthropicWorkloadIdentityToken({ env: {} })).resolves.toBeUndefined();
    expect(defaultCredentials).not.toHaveBeenCalled();
  });

  it("rejects a partial environment configuration with the missing settings", async () => {
    loadConfigWithSource.mockResolvedValue(null);

    const resolved = resolveAnthropicWorkloadIdentityToken({
      env: { ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test" },
    });

    await expect(resolved).rejects.toMatchObject({ name: "AnthropicWorkloadIdentityConfigError" });
    await expect(resolved).rejects.toThrow(
      /ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_IDENTITY_TOKEN_FILE \(or ANTHROPIC_IDENTITY_TOKEN\) are missing/,
    );
  });

  it("ignores interactive user_oauth profiles", async () => {
    loadConfigWithSource.mockResolvedValue({
      fromFile: true,
      config: { authentication: { type: "user_oauth" } },
    });

    await expect(resolveAnthropicWorkloadIdentityToken({ env: {} })).resolves.toBeUndefined();
    expect(defaultCredentials).not.toHaveBeenCalled();
  });

  it("exchanges once and reuses the token while it is fresh", async () => {
    const provider = mockExchange({ token: "sk-ant-oat01-first", expiresInSeconds: 600 });

    await expect(resolveAnthropicWorkloadIdentityToken({ env: {} })).resolves.toBe(
      "sk-ant-oat01-first",
    );
    await expect(resolveAnthropicWorkloadIdentityToken({ env: {} })).resolves.toBe(
      "sk-ant-oat01-first",
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect(isAnthropicWorkloadIdentityToken("sk-ant-oat01-first")).toBe(true);
    expect(isAnthropicWorkloadIdentityToken("sk-ant-oat01-subscription")).toBe(false);
  });

  it("refreshes a token that is about to expire", async () => {
    const provider = mockExchange(
      { token: "sk-ant-oat01-first", expiresInSeconds: 60 },
      { token: "sk-ant-oat01-second", expiresInSeconds: 600 },
    );

    await resolveAnthropicWorkloadIdentityToken({ env: {} });
    await expect(resolveAnthropicWorkloadIdentityToken({ env: {} })).resolves.toBe(
      "sk-ant-oat01-second",
    );
    expect(provider).toHaveBeenCalledTimes(2);
  });
});

describe("refreshAnthropicWorkloadIdentityApiKey", () => {
  it("swaps an expiring workload identity token for a current one", async () => {
    mockExchange(
      { token: "sk-ant-oat01-first", expiresInSeconds: 60 },
      { token: "sk-ant-oat01-second", expiresInSeconds: 600 },
    );
    const first = await resolveAnthropicWorkloadIdentityToken({ env: {} });

    await expect(refreshAnthropicWorkloadIdentityApiKey(first ?? "")).resolves.toBe(
      "sk-ant-oat01-second",
    );
  });

  it("keeps sentinel-wrapped tokens wrapped", async () => {
    mockExchange(
      { token: "sk-ant-oat01-first", expiresInSeconds: 60 },
      { token: "sk-ant-oat01-second", expiresInSeconds: 600 },
    );
    const first = await resolveAnthropicWorkloadIdentityToken({ env: {} });
    const sentinel = mintSecretSentinel(first ?? "", { label: "model-auth:anthropic" });

    const refreshed = await refreshAnthropicWorkloadIdentityApiKey(sentinel);

    expect(refreshed).not.toContain("sk-ant-oat01-second");
    expect(resolveSecretSentinel(refreshed) ?? refreshed).toBe("sk-ant-oat01-second");
  });

  it("leaves other credentials untouched", async () => {
    await expect(refreshAnthropicWorkloadIdentityApiKey("sk-ant-api03-key")).resolves.toBe(
      "sk-ant-api03-key",
    );
    expect(loadConfigWithSource).not.toHaveBeenCalled();
  });
});
