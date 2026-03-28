import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStore: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveAuthProfileDisplayLabel: vi.fn(),
}));

vi.mock("./model-auth.js", () => ({
  resolveUsableCustomProviderApiKey: vi.fn(() => null),
  resolveEnvApiKey: vi.fn(() => null),
}));

type AuthProfilesModule = typeof import("./auth-profiles.js");
type ModelAuthModule = typeof import("./model-auth.js");
type ModelAuthLabelModule = typeof import("./model-auth-label.js");

let ensureAuthProfileStoreMock: ReturnType<
  typeof vi.mocked<AuthProfilesModule["ensureAuthProfileStore"]>
>;
let resolveAuthProfileOrderMock: ReturnType<
  typeof vi.mocked<AuthProfilesModule["resolveAuthProfileOrder"]>
>;
let resolveAuthProfileDisplayLabelMock: ReturnType<
  typeof vi.mocked<AuthProfilesModule["resolveAuthProfileDisplayLabel"]>
>;
let resolveUsableCustomProviderApiKeyMock: ReturnType<
  typeof vi.mocked<ModelAuthModule["resolveUsableCustomProviderApiKey"]>
>;
let resolveEnvApiKeyMock: ReturnType<typeof vi.mocked<ModelAuthModule["resolveEnvApiKey"]>>;
let resolveModelAuthLabel: ModelAuthLabelModule["resolveModelAuthLabel"];

async function loadModelAuthLabelModule() {
  vi.resetModules();
  const authProfilesModule = await import("./auth-profiles.js");
  const modelAuthModule = await import("./model-auth.js");
  const modelAuthLabelModule = await import("./model-auth-label.js");
  ensureAuthProfileStoreMock = vi.mocked(authProfilesModule.ensureAuthProfileStore);
  resolveAuthProfileOrderMock = vi.mocked(authProfilesModule.resolveAuthProfileOrder);
  resolveAuthProfileDisplayLabelMock = vi.mocked(authProfilesModule.resolveAuthProfileDisplayLabel);
  resolveUsableCustomProviderApiKeyMock = vi.mocked(
    modelAuthModule.resolveUsableCustomProviderApiKey,
  );
  resolveEnvApiKeyMock = vi.mocked(modelAuthModule.resolveEnvApiKey);
  resolveModelAuthLabel = modelAuthLabelModule.resolveModelAuthLabel;
}

describe("resolveModelAuthLabel", () => {
  beforeEach(async () => {
    await loadModelAuthLabelModule();
    ensureAuthProfileStoreMock.mockReset();
    resolveAuthProfileOrderMock.mockReset();
    resolveAuthProfileDisplayLabelMock.mockReset();
    resolveUsableCustomProviderApiKeyMock.mockReset();
    resolveUsableCustomProviderApiKeyMock.mockReturnValue(null);
    resolveEnvApiKeyMock.mockReset();
    resolveEnvApiKeyMock.mockReturnValue(null);
  });

  it("does not include token value in label for token profiles", () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "github-copilot:default": {
          type: "token",
          provider: "github-copilot",
          token: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", // pragma: allowlist secret
          tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
        },
      },
    } as never);
    resolveAuthProfileOrderMock.mockReturnValue(["github-copilot:default"]);
    resolveAuthProfileDisplayLabelMock.mockReturnValue("github-copilot:default");

    const label = resolveModelAuthLabel({
      provider: "github-copilot",
      cfg: {},
      sessionEntry: { authProfileOverride: "github-copilot:default" } as never,
    });

    expect(label).toBe("token (github-copilot:default)");
    expect(label).not.toContain("ghp_");
    expect(label).not.toContain("ref(");
  });

  it("does not include api-key value in label for api-key profiles", () => {
    const shortSecret = "abc123"; // pragma: allowlist secret
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: shortSecret,
        },
      },
    } as never);
    resolveAuthProfileOrderMock.mockReturnValue(["openai:default"]);
    resolveAuthProfileDisplayLabelMock.mockReturnValue("openai:default");

    const label = resolveModelAuthLabel({
      provider: "openai",
      cfg: {},
      sessionEntry: { authProfileOverride: "openai:default" } as never,
    });

    expect(label).toBe("api-key (openai:default)");
    expect(label).not.toContain(shortSecret);
    expect(label).not.toContain("...");
  });

  it("shows oauth type with profile label", () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:oauth": {
          type: "oauth",
          provider: "anthropic",
        },
      },
    } as never);
    resolveAuthProfileOrderMock.mockReturnValue(["anthropic:oauth"]);
    resolveAuthProfileDisplayLabelMock.mockReturnValue("anthropic:oauth");

    const label = resolveModelAuthLabel({
      provider: "anthropic",
      cfg: {},
      sessionEntry: { authProfileOverride: "anthropic:oauth" } as never,
    });

    expect(label).toBe("oauth (anthropic:oauth)");
  });
});
