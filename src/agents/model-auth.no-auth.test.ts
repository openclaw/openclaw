import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  createApiKeyCredential as keyCredential,
  createAuthProfileStoreFixture as authStore,
} from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "./model-auth-markers.js";
import { getApiKeyForModelCore as resolveModelAuth } from "./model-auth-model.js";
import { resolveApiKeyForProviderCore as resolveAuth } from "./model-auth-provider.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

beforeEach(clearRuntimeConfigSnapshot);
afterEach(clearRuntimeConfigSnapshot);

function configForProvider(overrides: Partial<ModelProviderConfig> = {}) {
  return { models: { providers: { "custom-studio": { ...provider, ...overrides } } } };
}

const model = makeProviderModelFixture<"openai-completions">({
  id: "llama3",
  provider: "custom-studio",
  api: "openai-completions",
  baseUrl: "https://studio.example.ts.net/v1",
});
const provider = {
  baseUrl: model.baseUrl,
  api: model.api,
  auth: "none" as const,
  models: [model],
};

describe("explicit provider no-auth", () => {
  it.each(["empty", "inline", "stored", "pinned", "source-ref", "runtime-ref"])(
    "keeps explicit no-auth terminal with %s credentials",
    async (credential) => {
      const sourceConfig = configForProvider({
        ...(credential === "inline" ? { apiKey: "synthetic-inline-key" } : {}),
        ...(credential.endsWith("-ref")
          ? { apiKey: { source: "file" as const, id: "/custom/key", provider: "vault" } }
          : {}),
      });
      const runtimeConfig = configForProvider({
        ...sourceConfig.models.providers["custom-studio"],
        apiKey: "synthetic-resolved-key",
      });
      if (credential.endsWith("-ref")) {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
      }
      const auth = await resolveAuth({
        provider: "custom-studio",
        cfg: credential === "runtime-ref" ? runtimeConfig : sourceConfig,
        store: authStore<AuthProfileStore["profiles"]>(
          credential === "stored" || credential === "pinned"
            ? { "custom-studio:manual": keyCredential("custom-studio", "synthetic-stored-key") }
            : {},
        ),
        ...(credential === "pinned"
          ? { profileId: "custom-studio:manual", lockedProfile: true }
          : {}),
      });
      expect(auth).toMatchObject({
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        source: "models.providers.custom-studio (synthetic local key)",
        mode: "api-key",
      });
    },
  );

  it.each(["openai-completions", "openai-responses", undefined] as const)(
    "uses the selected model adapter for explicit no-auth with provider API %s",
    async (providerApi) => {
      const cfg = configForProvider({ api: providerApi, apiKey: "synthetic-inline-key" });
      const request = { cfg, store: authStore({}) };
      await expect(
        resolveModelAuth({ ...request, model: { ...model, api: "openai-completions" } }),
      ).resolves.toMatchObject({ apiKey: CUSTOM_LOCAL_AUTH_MARKER });
      await expect(
        resolveModelAuth({ ...request, model: { ...model, api: "openai-responses" } }),
      ).rejects.toThrow('auth: "none" requires the openai-completions adapter');
    },
  );
});
