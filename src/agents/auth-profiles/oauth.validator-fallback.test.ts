import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../plugin-sdk/file-lock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { createOAuthRefreshCredential as createCredential } from "./credential-fixtures.test-support.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles as loadStore,
  saveAuthProfileStore,
} from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";

const refreshCredential = vi.hoisted(() =>
  vi.fn(async (_credential: OAuthCredential): Promise<OAuthCredential | undefined> => undefined),
);

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

// mock-isolation: OAuth store fixtures do not discover installed provider hints.
vi.mock("./doctor.js", () => ({ formatAuthDoctorHint: async () => "" }));

// mock-isolation: The fixture controls refresh outcomes without loading installed provider plugins.
vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: async (params: { context?: OAuthCredential }) =>
    params.context?.access,
  resolveProviderOAuthCredentialWithPlugin: async (params: { credential: OAuthCredential }) => {
    const credential = await refreshCredential(params.credential);
    return credential
      ? { status: "available" as const, credential, apiKey: credential.access }
      : { status: "unhandled" as const };
  },
  resolveProviderOAuthRefreshCapabilityWithPlugin: async () => ({ status: "available" as const }),
}));

const accountCredential = (label: string, expires: number) =>
  createCredential({
    access: `${label}-access`,
    refresh: `${label}-refresh`,
    expires,
    accountId: `${label}-account`,
  });

function reset() {
  resetFileLockStateForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  refreshCredential.mockReset();
}
beforeEach(reset);
afterEach(reset);

it.each([false, true])("validates fallback credentials (reject=%s)", (reject) =>
  withOpenClawTestState({ layout: "state-only", agentEnv: "main" }, async (state) => {
    const mainAgentDir = state.agentDir();
    const primaryId = "openai:default";
    const fallbackId = "openai:alternate";
    const fallback = accountCredential("fallback", Date.now() + 600_000);
    const primary = accountCredential("expired", Date.now() - 60_000);
    const store = { version: 1, profiles: { [primaryId]: primary, [fallbackId]: fallback } };
    saveAuthProfileStore(store, mainAgentDir, { filterExternalAuthProfiles: false });
    refreshCredential.mockRejectedValueOnce(new Error("primary refresh failed"));
    const validateOAuthCredential = vi.fn((credential: OAuthCredential) => {
      if (reject && credential.accountId === fallback.accountId) {
        throw new Error(`rejected ${credential.accountId}`);
      }
    });
    const { resolveApiKeyForProfile } = await import("./oauth.js");
    const profile = { provider: "openai", mode: "oauth" } as const;
    const profiles = { [primaryId]: profile, [fallbackId]: profile };

    const resolution = resolveApiKeyForProfile({
      cfg: { auth: { profiles } },
      store: loadStore(mainAgentDir),
      profileId: primaryId,
      agentDir: mainAgentDir,
      validateOAuthCredential,
    });

    if (reject) {
      await expect(resolution).rejects.toThrow(
        "OAuth token refresh failed for openai: primary refresh failed",
      );
    } else {
      expect(await resolution).toMatchObject({
        apiKey: "fallback-access",
        provider: "openai",
        profileId: fallbackId,
      });
    }
    expect(validateOAuthCredential).toHaveBeenNthCalledWith(1, primary);
    expect(validateOAuthCredential).toHaveBeenLastCalledWith(fallback);
    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(loadStore(mainAgentDir).profiles[fallbackId]).toEqual(fallback);
  }),
);
