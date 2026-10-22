// Verifies safe, user-facing auth labels without exposing credential values.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
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

// mock-isolation: Label privacy cases use synthetic credentials without loading host auth profiles.
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

function profileLabel(profileId: string, profile: unknown) {
  mocks.ensureAuthProfileStoreAsync.mockReturnValue(
    createAuthProfileStoreFixture({ [profileId]: profile }),
  );
  mocks.resolveAuthProfileOrder.mockReturnValue([profileId]);
  mocks.resolveAuthProfileDisplayLabel.mockReturnValue(profileId);
}

function labelFor(
  provider: string,
  options: Parameters<typeof resolveModelAuthLabelAsync>[0] = {},
) {
  return resolveModelAuthLabelAsync({ cfg: {}, provider, ...options });
}

describe("resolveModelAuthLabelAsync", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.ensureAuthProfileStoreAsync.mockReturnValue(createAuthProfileStoreFixture({}));
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.resolveProviderEntryApiKeyProfileReference.mockReturnValue({ kind: "none" });
    mocks.resolveUsableCustomProviderApiKey.mockReturnValue(null);
    mocks.resolveEnvApiKey.mockReturnValue(null);
    mocks.readCodexCliCredentialsCached.mockReturnValue(null);
  });

  it("does not include token value in label for token profiles", async () => {
    profileLabel("github-copilot:default", {
      type: "token",
      provider: "github-copilot",
      token: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", // pragma: allowlist secret
      tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
    });
    const label = await labelFor("github-copilot", {
      sessionEntry: { authProfileOverride: "github-copilot:default" },
    });
    expect(label).toBe("token (github-copilot:default)");
    expect(label).not.toContain("ghp_");
    expect(label).not.toContain("ref(");
  });

  it("does not include api-key value in label for api-key profiles", async () => {
    const shortSecret = "abc123"; // pragma: allowlist secret
    profileLabel("openai:default", createApiKeyCredential("openai", shortSecret));
    const label = await labelFor("openai", {
      sessionEntry: { authProfileOverride: "openai:default" },
    });
    expect(label).toBe("api-key (openai:default)");
    expect(label).not.toContain(shortSecret);
    expect(label).not.toContain("...");
  });

  it.each(["codex", "openai"])(
    "labels %s Codex CLI auth without leaking credentials",
    async (provider) => {
      const codexHome = provider === "openai" ? "/tmp/openclaw-agent/codex-home" : undefined;
      mocks.readCodexCliCredentialsCached.mockReturnValue(createOAuthRefreshCredential());
      if (codexHome) {
        mocks.resolveEnvApiKey.mockReturnValue({
          apiKey: "env-key-placeholder",
          source: "env: OPENAI_API_KEY",
        });
      }
      expect(await labelFor(provider, { codexCliCredentialsHome: codexHome })).toBe(
        "oauth (codex-cli)",
      );
      expect(mocks.readCodexCliCredentialsCached).toHaveBeenCalledWith({
        ...(codexHome ? { codexHome } : {}),
        ttlMs: 5_000,
        allowKeychainPrompt: false,
      });
      if (codexHome) {
        expect(mocks.resolveEnvApiKey).not.toHaveBeenCalled();
      }
    },
  );

  it("shows native Claude CLI auth without reading credential storage", async () => {
    expect(await labelFor("claude-cli")).toBe("native (claude-cli)");
  });

  it("can skip external auth profile overlays for status labels", async () => {
    mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync.mockReturnValue(
      createAuthProfileStoreFixture({
        "anthropic:oauth": { type: "oauth", provider: "anthropic" },
      }),
    );
    mocks.resolveAuthProfileOrder.mockReturnValue(["anthropic:oauth"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("anthropic:oauth");

    expect(await labelFor("anthropic", { includeExternalProfiles: false })).toBe(
      "oauth (anthropic:oauth)",
    );
    expect(mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync).toHaveBeenCalledOnce();
    expect(mocks.ensureAuthProfileStoreAsync).not.toHaveBeenCalled();
  });

  it("resolves env labels with config and workspace scope", async () => {
    mocks.resolveEnvApiKey.mockReturnValue({
      apiKey: "workspace-cloud-local-credentials",
      source: "workspace cloud credentials",
    });

    const cfg = { plugins: { allow: ["workspace-cloud"] } };
    expect(
      await labelFor("workspace-cloud", {
        cfg,
        workspaceDir: "/tmp/workspace",
      }),
    ).toBe("api-key (workspace cloud credentials)");
    expect(mocks.resolveEnvApiKey).toHaveBeenCalledWith("workspace-cloud", process.env, {
      config: cfg,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("shows per-entry apiKey profile-reference labels before literal models.json fallback", async () => {
    const store = createAuthProfileStoreFixture({
      "openrouter:key-b": createApiKeyCredential("openrouter", "sk-or-actual-key-b"),
    });
    mocks.ensureAuthProfileStoreAsync.mockReturnValue(store);
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

    expect(await labelFor("openrouter-minimax")).toBe("api-key (openrouter:key-b)");
    expect(mocks.resolveUsableCustomProviderApiKey).not.toHaveBeenCalled();
  });

  it("does not report incompatible per-entry profile references as literal models.json keys", async () => {
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

    expect(await labelFor("openrouter-minimax")).toBe("unknown");
    expect(mocks.resolveUsableCustomProviderApiKey).not.toHaveBeenCalled();
  });
});
