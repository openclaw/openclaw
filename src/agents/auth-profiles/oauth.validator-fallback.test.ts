/**
 * Tests credential validation across legacy OAuth profile fallback.
 */
import { describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import "./oauth-external-auth-passthrough.test-support.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  removeOAuthTestTempRoot,
} from "./oauth-test-utils.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";

const refreshProviderOAuthCredentialWithPluginMock = vi.hoisted(() =>
  vi.fn(async (_credential: OAuthCredential): Promise<OAuthCredential | undefined> => undefined),
);

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  buildProviderAuthDoctorHintWithPlugin: async () => undefined,
  formatProviderAuthProfileApiKeyWithPlugin: async (params: { context?: OAuthCredential }) =>
    params.context?.access,
  resolveProviderOAuthCredentialWithPlugin: async (params: { credential: OAuthCredential }) => {
    const credential = await refreshProviderOAuthCredentialWithPluginMock(params.credential);
    return credential
      ? { status: "available" as const, credential, apiKey: credential.access }
      : { status: "unhandled" as const };
  },
  resolveProviderOAuthRefreshCapabilityWithPlugin: async () => ({
    status: "available" as const,
  }),
}));

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

describe("resolveApiKeyForProfile fallback credential validation", () => {
  it.each([
    { name: "returns an accepted fallback", reject: false },
    { name: "rejects an invalid fallback", reject: true },
  ])("$name", async ({ reject }) => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      refreshProviderOAuthCredentialWithPluginMock.mockReset();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-validator-fallback-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      const legacyProfileId = "openai:default";
      const fallbackProfileId = "openai:alternate";
      const fallbackCredential = createCredential({
        access: "fallback-access",
        refresh: "fallback-refresh",
        expires: Date.now() + 600_000,
        accountId: "fallback-account",
      });
      const legacyCredential = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
        accountId: "legacy-account",
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [legacyProfileId]: legacyCredential,
            [fallbackProfileId]: fallbackCredential,
          },
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );
      refreshProviderOAuthCredentialWithPluginMock.mockRejectedValueOnce(
        new Error("primary refresh failed"),
      );
      const validateOAuthCredential = vi.fn((credential: OAuthCredential) => {
        if (reject && credential.accountId === fallbackCredential.accountId) {
          throw new Error(`rejected ${credential.accountId}`);
        }
      });
      const { resolveApiKeyForProfile } = await import("./oauth.js");

      const resolution = resolveApiKeyForProfile({
        cfg: {
          auth: {
            profiles: {
              [legacyProfileId]: { provider: "openai", mode: "oauth" },
              [fallbackProfileId]: { provider: "openai", mode: "oauth" },
            },
          },
        },
        store: ensureAuthProfileStoreWithoutExternalProfiles(mainAgentDir),
        profileId: legacyProfileId,
        agentDir: mainAgentDir,
        validateOAuthCredential,
      });

      if (reject) {
        await expect(resolution).rejects.toThrow(
          "OAuth token refresh failed for openai: primary refresh failed",
        );
      } else {
        const result = await resolution;
        expect(result).toMatchObject({
          apiKey: "fallback-access",
          provider: "openai",
        });
        expect(result?.profileId).toBe(fallbackProfileId);
      }
      expect(validateOAuthCredential).toHaveBeenCalledTimes(2);
      expect(validateOAuthCredential).toHaveBeenNthCalledWith(1, legacyCredential);
      expect(validateOAuthCredential).toHaveBeenNthCalledWith(2, fallbackCredential);
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(mainAgentDir).profiles[fallbackProfileId],
      ).toEqual(fallbackCredential);
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });
});
