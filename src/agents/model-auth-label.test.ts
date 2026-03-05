import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const resolveAuthProfileOrderMock = vi.hoisted(() => vi.fn());
const resolveAuthProfileDisplayLabelMock = vi.hoisted(() => vi.fn());

vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStore: (...args: unknown[]) => ensureAuthProfileStoreMock(...args),
  resolveAuthProfileOrder: (...args: unknown[]) => resolveAuthProfileOrderMock(...args),
  resolveAuthProfileDisplayLabel: (...args: unknown[]) =>
    resolveAuthProfileDisplayLabelMock(...args),
}));

vi.mock("./model-auth.js", () => ({
  getCustomProviderApiKey: () => undefined,
  resolveEnvApiKey: () => null,
}));

const { resolveModelAuthLabel } = await import("./model-auth-label.js");

describe("resolveModelAuthLabel", () => {
  beforeEach(() => {
    ensureAuthProfileStoreMock.mockReset();
    resolveAuthProfileOrderMock.mockReset();
    resolveAuthProfileDisplayLabelMock.mockReset();
  });

  it("does not include token value in label for token profiles", () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "github-copilot:default": {
          type: "token",
          provider: "github-copilot",
          token: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
    const shortSecret = "abc123";
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
