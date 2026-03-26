import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";

const mocks = vi.hoisted(() => ({
  getOAuthProviders: vi.fn(() => [{ id: "anthropic" }]),
  getOAuthApiKey: vi.fn(),
  readClaudeCliCredentialsCached: vi.fn(),
  writeClaudeCliCredentials: vi.fn(() => true),
  withFileLock: vi.fn(async (_path: string, _options: unknown, callback: () => unknown) => {
    return await callback();
  }),
  ensureAuthStoreFile: vi.fn(),
  resolveAuthStorePath: vi.fn(() => "/tmp/auth-profiles.json"),
  ensureAuthProfileStore: vi.fn(),
  saveAuthProfileStore: vi.fn(),
  suggestOAuthProfileIdForLegacyDefault: vi.fn(() => null),
  formatAuthDoctorHint: vi.fn(() => ""),
  refreshQwenPortalCredentials: vi.fn(),
  refreshChutesTokens: vi.fn(),
  loadProviderRuntime: {
    refreshProviderOAuthCredentialWithPlugin: vi.fn(async () => null),
    formatProviderAuthProfileApiKeyWithPlugin: vi.fn(() => undefined),
  },
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthProviders: mocks.getOAuthProviders,
  getOAuthApiKey: mocks.getOAuthApiKey,
}));

vi.mock("../cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: mocks.readClaudeCliCredentialsCached,
  writeClaudeCliCredentials: mocks.writeClaudeCliCredentials,
}));

vi.mock("../../infra/file-lock.js", () => ({
  withFileLock: mocks.withFileLock,
}));

vi.mock("./paths.js", () => ({
  ensureAuthStoreFile: mocks.ensureAuthStoreFile,
  resolveAuthStorePath: mocks.resolveAuthStorePath,
}));

vi.mock("./store.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  saveAuthProfileStore: mocks.saveAuthProfileStore,
}));

vi.mock("./repair.js", () => ({
  suggestOAuthProfileIdForLegacyDefault: mocks.suggestOAuthProfileIdForLegacyDefault,
}));

vi.mock("./doctor.js", () => ({
  formatAuthDoctorHint: mocks.formatAuthDoctorHint,
}));

vi.mock("../../providers/qwen-portal-oauth.js", () => ({
  refreshQwenPortalCredentials: mocks.refreshQwenPortalCredentials,
}));

vi.mock("../chutes-oauth.js", () => ({
  refreshChutesTokens: mocks.refreshChutesTokens,
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => mocks.loadProviderRuntime);

import { resolveApiKeyForProfile } from "./oauth.js";

function makeExpiredAnthropicStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "oauth",
        provider: "anthropic",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
      },
    },
  };
}

describe("resolveApiKeyForProfile Anthropic recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOAuthProviders.mockReturnValue([{ id: "anthropic" }]);
    mocks.readClaudeCliCredentialsCached.mockReturnValue(null);
    mocks.writeClaudeCliCredentials.mockReturnValue(true);
    mocks.getOAuthApiKey.mockResolvedValue(null);
    mocks.loadProviderRuntime.refreshProviderOAuthCredentialWithPlugin.mockResolvedValue(null);
    mocks.loadProviderRuntime.formatProviderAuthProfileApiKeyWithPlugin.mockReturnValue(undefined);
  });

  it("prefers fresher Claude CLI OAuth credentials before refreshing", async () => {
    const store = makeExpiredAnthropicStore();
    const cliExpires = Date.now() + 60 * 60 * 1000;
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    mocks.readClaudeCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "cli-access",
      refresh: "cli-refresh",
      expires: cliExpires,
    });

    const result = await resolveApiKeyForProfile({
      store,
      profileId: "anthropic:default",
    });

    expect(result).toEqual({
      apiKey: "cli-access",
      provider: "anthropic",
      email: undefined,
    });
    expect(mocks.getOAuthApiKey).not.toHaveBeenCalled();
    expect(store.profiles["anthropic:default"]).toMatchObject({
      access: "cli-access",
      refresh: "cli-refresh",
      expires: cliExpires,
    });
    expect(mocks.saveAuthProfileStore).toHaveBeenCalledOnce();
    expect(mocks.writeClaudeCliCredentials).not.toHaveBeenCalled();
  });

  it("writes refreshed Anthropic OAuth credentials back to Claude CLI", async () => {
    const store = makeExpiredAnthropicStore();
    const refreshedExpires = Date.now() + 2 * 60 * 60 * 1000;
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    mocks.getOAuthApiKey.mockResolvedValue({
      apiKey: "fresh-access",
      newCredentials: {
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: refreshedExpires,
      },
    });

    const result = await resolveApiKeyForProfile({
      store,
      profileId: "anthropic:default",
    });

    expect(result).toEqual({
      apiKey: "fresh-access",
      provider: "anthropic",
      email: undefined,
    });
    expect(store.profiles["anthropic:default"]).toMatchObject({
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: refreshedExpires,
    });
    expect(mocks.writeClaudeCliCredentials).toHaveBeenCalledWith({
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: refreshedExpires,
    });
  });
});
