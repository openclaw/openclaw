import { describe, expect, it } from "vitest";
import { resolveProviderDiscoveryFilterForTest } from "./models-config.providers.implicit.js";

describe("resolveProviderDiscoveryFilterForTest", () => {
  it("scopes discovery to explicit providers when no live filter is set", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        explicitProviders: {
          "openai-codex": {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
        env: {
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["openai"]);
  });

  it("keeps broad discovery when an explicit provider has no owning plugin", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        explicitProviders: {
          "custom-openai": {
            api: "openai-responses",
            baseUrl: "https://example.invalid/v1",
            models: [],
          },
        },
        env: {
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toBeUndefined();
  });

  it("maps live provider backend ids to owning plugin ids", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: {
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "claude-cli",
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["anthropic"]);
  });

  it("honors gateway live provider filters too", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: {
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_GATEWAY_PROVIDERS: "claude-cli",
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["anthropic"]);
  });

  it("keeps broad discovery when live providers is set to all", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        explicitProviders: {
          "openai-codex": {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
        env: {
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "all",
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toBeUndefined();
  });

  it("keeps explicit plugin-id filters when no owning provider plugin exists", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: {
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "openrouter",
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["openrouter"]);
  });
});
