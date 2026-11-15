import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as builtinOAuth from "../../llm/oauth.js";
import * as providerRuntime from "../../plugins/provider-runtime.runtime.js";
import type { OAuthCredential, OAuthCredentials } from "./types.js";

type ProviderContext = { cfg?: OpenClawConfig };

export type NativeOAuthProviderFixture = {
  buildApiKey?: (
    provider: string,
    credential: OAuthCredential,
    context: ProviderContext,
  ) => Promise<string>;
  refreshCredential?: (
    credential: OAuthCredential,
    context: ProviderContext,
  ) => Promise<OAuthCredentials | null>;
  canRefreshCredential?: (context: ProviderContext) => Promise<boolean>;
};

/** Configure external provider I/O once; managers still own independent real queues. */
export function mockOAuthProviderOperations(options: NativeOAuthProviderFixture = {}) {
  const format = providerRuntime.formatProviderAuthProfileApiKeyWithPlugin;
  vi.spyOn(providerRuntime, "formatProviderAuthProfileApiKeyWithPlugin").mockImplementation(
    async (params) => {
      const credential = params.context;
      if (credential.type !== "oauth") {
        return await format(params);
      }
      return options.buildApiKey
        ? await options.buildApiKey(params.provider, credential, { cfg: params.config })
        : credential.access;
    },
  );
  vi.spyOn(providerRuntime, "resolveProviderOAuthRefreshCapabilityWithPlugin").mockImplementation(
    async ({ config }) =>
      !options.canRefreshCredential || (await options.canRefreshCredential({ cfg: config }))
        ? { status: "available" }
        : { status: "unhandled" },
  );
  vi.spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin").mockImplementation(
    async ({ credential, config }) => {
      const refreshed = await options.refreshCredential?.(credential, { cfg: config });
      if (!refreshed) {
        return { status: "unhandled" };
      }
      const result = { ...credential, ...refreshed, type: "oauth" } satisfies OAuthCredential;
      return { status: "available", credential: result, apiKey: result.access };
    },
  );
  // A null synthetic plugin result must not reach a live built-in refresh.
  vi.spyOn(builtinOAuth, "getOAuthApiKey").mockResolvedValue(null);
}
