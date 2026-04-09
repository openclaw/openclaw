import { describe, expect, it, vi } from "vitest";
import { planOpenClawModelsJson } from "./models-config.plan.js";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";

vi.mock("./models-config.providers.js", () => ({
  applyNativeStreamingUsageCompat: (providers: unknown) => providers,
  enforceSourceManagedProviderSecrets: ({ providers }: { providers: unknown }) => providers,
  normalizeProviders: ({ providers }: { providers: unknown }) => providers,
  resolveImplicitProviders: async ({
    explicitProviders,
  }: {
    explicitProviders?: Record<string, unknown>;
  }) => explicitProviders ?? {},
}));

describe("models-config", () => {
  it("uses the first github-copilot profile when env tokens are missing", () => {
    const auth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      version: 1,
      profiles: {
        "github-copilot:alpha": {
          type: "token",
          provider: "github-copilot",
          token: "alpha-token",
        },
        "github-copilot:beta": {
          type: "token",
          provider: "github-copilot",
          token: "beta-token",
        },
      },
    });

    expect(auth("github-copilot")).toEqual({
      apiKey: "alpha-token",
      discoveryApiKey: "alpha-token",
      mode: "token",
      source: "profile",
      profileId: "github-copilot:alpha",
    });
  });

  it("does not override explicit github-copilot provider config", async () => {
    const plan = await planOpenClawModelsJson({
      cfg: {
        models: {
          providers: {
            "github-copilot": {
              baseUrl: "https://copilot.local",
              api: "openai-responses",
              models: [],
            },
          },
        },
      },
      agentDir: "/tmp/openclaw-agent",
      env: {} as NodeJS.ProcessEnv,
      existingRaw: "",
      existingParsed: null,
    });

    expect(plan.action).toBe("write");
    expect(
      plan.action === "write"
        ? (
            JSON.parse(plan.contents) as {
              providers?: Record<string, { baseUrl?: string }>;
            }
          ).providers?.["github-copilot"]?.baseUrl
        : undefined,
    ).toBe("https://copilot.local");
  });

  it("uses tokenRef env var when github-copilot profile omits plaintext token", () => {
    const auth = createProviderAuthResolver(
      {
        COPILOT_REF_TOKEN: "token-from-ref-env",
      } as NodeJS.ProcessEnv,
      {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            tokenRef: { source: "env", provider: "default", id: "COPILOT_REF_TOKEN" },
          },
        },
      },
    );

    expect(auth("github-copilot")).toEqual({
      apiKey: "COPILOT_REF_TOKEN",
      discoveryApiKey: "token-from-ref-env",
      mode: "token",
      source: "profile",
      profileId: "github-copilot:default",
    });
  });
});
