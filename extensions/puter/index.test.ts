import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { createTestWizardPrompter } from "../../test/helpers/plugins/setup-wizard.js";
import puterPlugin from "./index.js";

const { getPuterAuthTokenMock } = vi.hoisted(() => ({
  getPuterAuthTokenMock: vi.fn(),
}));

vi.mock("./auth.runtime.js", () => ({
  getPuterAuthToken: getPuterAuthTokenMock,
}));

function createProviderAuthContext(
  config: ProviderAuthContext["config"] = {},
): ProviderAuthContext {
  return {
    config,
    opts: {},
    env: {},
    agentDir: "/tmp/openclaw/agents/main",
    workspaceDir: "/tmp/openclaw/workspace",
    prompter: createTestWizardPrompter(),
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    allowSecretRefPrompt: false,
    isRemote: false,
    openUrl: vi.fn(),
    oauth: {
      createVpsAwareHandlers: vi.fn(),
    },
  };
}

describe("puter provider plugin", () => {
  beforeEach(() => {
    getPuterAuthTokenMock.mockReset();
  });

  it("registers Puter with browser and auth-token setup choices", async () => {
    const provider = await registerSingleProviderPlugin(puterPlugin);

    expect(provider.id).toBe("puter");
    expect(provider.label).toBe("Puter");
    expect(provider.docsPath).toBe("/providers/puter");
    expect(provider.envVars).toEqual(["PUTER_AUTH_TOKEN"]);
    expect(provider.auth).toHaveLength(2);

    const browserChoice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "puter-browser",
    });
    expect(browserChoice?.provider.id).toBe("puter");
    expect(browserChoice?.method.id).toBe("browser");

    const tokenChoice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "puter-auth-token",
    });
    expect(tokenChoice?.provider.id).toBe("puter");
    expect(tokenChoice?.method.id).toBe("auth-token");
  });

  it("builds the Puter Gemini catalog when a token is available", async () => {
    const provider = await registerSingleProviderPlugin(puterPlugin);
    const catalog = await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: (id: string) =>
        id === "puter" ? { apiKey: "puter-token" } : { apiKey: undefined },
      resolveProviderAuth: () => ({
        apiKey: "puter-token",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe("https://api.puter.com/puterai/openai/v1/");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
    ]);
  });

  it("normalizes Puter Gemini preview aliases to the bundled catalog ids", async () => {
    const provider = await registerSingleProviderPlugin(puterPlugin);

    expect(
      provider.normalizeModelId?.({
        provider: "puter",
        modelId: "gemini-3.1-pro",
      } as never),
    ).toBe("gemini-3.1-pro-preview");
    expect(
      provider.normalizeModelId?.({
        provider: "puter",
        modelId: "gemini-3.1-flash-preview",
      } as never),
    ).toBe("gemini-3-flash-preview");
  });

  it("stores the browser-auth token as a Puter auth profile", async () => {
    getPuterAuthTokenMock.mockResolvedValueOnce("puter-browser-token");
    const provider = await registerSingleProviderPlugin(puterPlugin);
    const browserMethod = provider.auth?.find((entry) => entry.id === "browser");
    if (!browserMethod) {
      throw new Error("expected browser auth method");
    }

    const result = await browserMethod.run(createProviderAuthContext());

    expect(result.defaultModel).toBe("puter/gemini-3.1-pro-preview");
    expect(result.profiles).toEqual([
      {
        profileId: "puter:default",
        credential: {
          type: "api_key",
          provider: "puter",
          key: "puter-browser-token",
        },
      },
    ]);
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          model: {
            primary: "puter/gemini-3.1-pro-preview",
          },
        },
      },
    });
  });
});
