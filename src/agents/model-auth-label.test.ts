// Verifies safe, user-facing auth labels without exposing credential values.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { resolveModelAuthLabelAsync } from "./model-auth-label.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStoreAsync: vi.fn(),
  externalCliDiscoveryForProviderAuth: vi.fn(() => undefined),
  ensureAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveAuthProfileDisplayLabel: vi.fn(),
  resolveProviderEntryApiKeyProfileReference: vi.fn<() => unknown>(() => ({ kind: "none" })),
  resolveUsableCustomProviderApiKey: vi.fn<() => { apiKey: string; source: string } | null>(
    () => null,
  ),
  resolveEnvApiKey: vi.fn<() => { apiKey: string; source: string } | null>(() => null),
  readCodexCliCredentialsCached: vi.fn<(options?: unknown) => unknown>(() => null),
}));

vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStoreAsync: mocks.ensureAuthProfileStoreAsync,
  externalCliDiscoveryForProviderAuth: mocks.externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStoreWithoutExternalProfilesAsync:
    mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
}));

vi.mock("./model-auth.js", () => ({
  resolveProviderEntryApiKeyProfileReference: mocks.resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey: mocks.resolveUsableCustomProviderApiKey,
  resolveEnvApiKey: mocks.resolveEnvApiKey,
}));

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: mocks.readCodexCliCredentialsCached,
}));

describe("resolveModelAuthLabelAsync", () => {
  beforeEach(() => {
    mocks.ensureAuthProfileStoreAsync.mockReset();
    mocks.externalCliDiscoveryForProviderAuth.mockReset();
    mocks.externalCliDiscoveryForProviderAuth.mockReturnValue(undefined);
    mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync.mockReset();
    mocks.resolveAuthProfileOrder.mockReset();
    mocks.resolveAuthProfileDisplayLabel.mockReset();
    mocks.resolveProviderEntryApiKeyProfileReference.mockReset();
    mocks.resolveProviderEntryApiKeyProfileReference.mockReturnValue({ kind: "none" });
    mocks.resolveUsableCustomProviderApiKey.mockReset();
    mocks.resolveUsableCustomProviderApiKey.mockReturnValue(null);
    mocks.resolveEnvApiKey.mockReset();
    mocks.resolveEnvApiKey.mockReturnValue(null);
    mocks.readCodexCliCredentialsCached.mockReset();
    mocks.readCodexCliCredentialsCached.mockReturnValue(null);
  });

  it("does not include token value in label for token profiles", async () => {
    // Labels may be shown in status output, so token-backed profiles identify
    // the auth mode/profile only and never echo token material or refs.
    mocks.ensureAuthProfileStoreAsync.mockReturnValue({
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
    mocks.resolveAuthProfileOrder.mockReturnValue(["github-copilot:default"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("github-copilot:default");

    const label = await resolveModelAuthLabelAsync({
      provider: "github-copilot",
      cfg: {},
      sessionEntry: { authProfileOverride: "github-copilot:default" } as never,
    });

    expect(label).toBe("token (github-copilot:default)");
    expect(label).not.toContain("ghp_");
    expect(label).not.toContain("ref(");
  });

  it("does not include api-key value in label for api-key profiles", async () => {
    const shortSecret = "abc123"; // pragma: allowlist secret
    mocks.ensureAuthProfileStoreAsync.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: shortSecret,
        },
      },
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue(["openai:default"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("openai:default");

    const label = await resolveModelAuthLabelAsync({
      provider: "openai",
      cfg: {},
      sessionEntry: { authProfileOverride: "openai:default" } as never,
    });

    expect(label).toBe("api-key (openai:default)");
    expect(label).not.toContain(shortSecret);
    expect(label).not.toContain("...");
  });

  it("shows codex cli auth for codex provider without auth profiles", async () => {
    mocks.ensureAuthProfileStoreAsync.mockReturnValue(createAuthProfileStoreFixture({}) as never);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.readCodexCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "token",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    });

    const label = await resolveModelAuthLabelAsync({
      provider: "codex",
      cfg: {},
    });

    expect(label).toBe("oauth (codex-cli)");
    expect(mocks.readCodexCliCredentialsCached).toHaveBeenCalledWith({
      ttlMs: 5_000,
      allowKeychainPrompt: false,
    });
  });

  it("uses Codex CLI auth for Codex-backed OpenAI before env fallback", async () => {
    mocks.ensureAuthProfileStoreAsync.mockReturnValue(createAuthProfileStoreFixture({}) as never);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.readCodexCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "token",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    });
    mocks.resolveEnvApiKey.mockReturnValue({
      apiKey: "env-key-placeholder",
      source: "env: OPENAI_API_KEY",
    });

    const label = await resolveModelAuthLabelAsync({
      provider: "openai",
      cfg: {},
      codexCliCredentialsHome: "/tmp/openclaw-agent/codex-home",
    });

    expect(label).toBe("oauth (codex-cli)");
    expect(mocks.readCodexCliCredentialsCached).toHaveBeenCalledWith({
      codexHome: "/tmp/openclaw-agent/codex-home",
      ttlMs: 5_000,
      allowKeychainPrompt: false,
    });
    expect(mocks.resolveEnvApiKey).not.toHaveBeenCalled();
  });

  it("shows native Claude CLI auth without reading credential storage", async () => {
    mocks.ensureAuthProfileStoreAsync.mockReturnValue(createAuthProfileStoreFixture({}) as never);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    const label = await resolveModelAuthLabelAsync({
      provider: "claude-cli",
      cfg: {},
    });

    expect(label).toBe("native (claude-cli)");
  });

  it("can skip external auth profile overlays for status labels", async () => {
    mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:oauth": {
          type: "oauth",
          provider: "anthropic",
        },
      },
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue(["anthropic:oauth"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("anthropic:oauth");

    const label = await resolveModelAuthLabelAsync({
      provider: "anthropic",
      cfg: {},
      includeExternalProfiles: false,
    });

    expect(label).toBe("oauth (anthropic:oauth)");
    expect(mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync).toHaveBeenCalledOnce();
    expect(mocks.ensureAuthProfileStoreAsync).not.toHaveBeenCalled();
  });

  it("resolves env labels with config and workspace scope", async () => {
    mocks.ensureAuthProfileStoreAsync.mockReturnValue(createAuthProfileStoreFixture({}) as never);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.resolveEnvApiKey.mockReturnValue({
      apiKey: "workspace-cloud-local-credentials",
      source: "workspace cloud credentials",
    });

    const cfg = { plugins: { allow: ["workspace-cloud"] } };
    const label = await resolveModelAuthLabelAsync({
      provider: "workspace-cloud",
      cfg,
      workspaceDir: "/tmp/workspace",
    });

    expect(label).toBe("api-key (workspace cloud credentials)");
    expect(mocks.resolveEnvApiKey).toHaveBeenCalledWith("workspace-cloud", process.env, {
      config: cfg,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("shows per-entry apiKey profile-reference labels before literal models.json fallback", async () => {
    const store = createAuthProfileStoreFixture({
      "openrouter:key-b": createApiKeyCredential("openrouter", "sk-or-actual-key-b"),
    });
    mocks.ensureAuthProfileStoreAsync.mockReturnValue(store as never);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("openrouter:key-b");
    mocks.resolveProviderEntryApiKeyProfileReference.mockReturnValue({
      kind: "profile",
      profileId: "openrouter:key-b",
      credential: store.profiles["openrouter:key-b"],
      mode: "api-key",
    });
    mocks.resolveUsableCustomProviderApiKey.mockReturnValue({
      apiKey: "openrouter:key-b",
      source: "models.json",
    });

    const label = await resolveModelAuthLabelAsync({
      provider: "openrouter-minimax",
      cfg: {},
    });

    expect(label).toBe("api-key (openrouter:key-b)");
    expect(mocks.resolveUsableCustomProviderApiKey).not.toHaveBeenCalled();
  });

  it("does not report incompatible per-entry profile references as literal models.json keys", async () => {
    mocks.ensureAuthProfileStoreAsync.mockReturnValue(createAuthProfileStoreFixture({}) as never);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.resolveProviderEntryApiKeyProfileReference.mockReturnValue({
      kind: "profile-incompatible",
      profileId: "google:oauth-a",
      credentialProvider: "google",
      credentialType: "oauth",
      reason: "credential-class",
    });
    mocks.resolveUsableCustomProviderApiKey.mockReturnValue({
      apiKey: "google:oauth-a",
      source: "models.json",
    });

    const label = await resolveModelAuthLabelAsync({
      provider: "openrouter-minimax",
      cfg: {},
    });

    expect(label).toBe("unknown");
    expect(mocks.resolveUsableCustomProviderApiKey).not.toHaveBeenCalled();
  });
});
