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

  it("does not throw when token profile only has tokenRef", () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "github-copilot:default": {
          type: "token",
          provider: "github-copilot",
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

    expect(label).toContain("token ref(env:GITHUB_TOKEN)");
  });

  it("masks short api-key profile values", () => {
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

    expect(label).toContain("api-key");
    expect(label).toContain("...");
    expect(label).not.toContain(shortSecret);
  });
});
