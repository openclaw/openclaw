import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
  getOAuthApiKey: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: mocks.ensureGlobalUndiciEnvProxyDispatcher,
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: mocks.getOAuthApiKey,
}));

import { getOAuthApiKey } from "./openai-codex-provider.runtime.js";

describe("openai-codex-provider.runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bootstraps the env proxy dispatcher before refreshing oauth credentials", async () => {
    const refreshed = {
      newCredentials: {
        access: "next-access",
        refresh: "next-refresh",
        expires: Date.now() + 60_000,
      },
    };
    mocks.getOAuthApiKey.mockResolvedValue(refreshed);

    await expect(
      getOAuthApiKey("openai-codex", {
        "openai-codex": {
          provider: "openai-codex",
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now(),
        },
      }),
    ).resolves.toBe(refreshed);

    expect(mocks.ensureGlobalUndiciEnvProxyDispatcher).toHaveBeenCalledOnce();
    expect(mocks.getOAuthApiKey).toHaveBeenCalledOnce();
    expect(mocks.ensureGlobalUndiciEnvProxyDispatcher.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getOAuthApiKey.mock.invocationCallOrder[0],
    );
  });
});
