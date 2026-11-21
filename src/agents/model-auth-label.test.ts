import { beforeEach, expect, it, vi } from "vitest";
import { createOAuthRefreshCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import { resolveModelAuthLabelAsync } from "./model-auth-label.js";

const m = vi.hoisted(() => ({
  store: vi.fn(),
  localStore: vi.fn(),
  order: vi.fn(),
  display: vi.fn(),
  reference: vi.fn<() => unknown>(),
  custom: vi.fn<() => { apiKey: string; source: string } | null>(),
  env: vi.fn<() => { apiKey: string; source: string } | null>(),
  cli: vi.fn<(options?: unknown) => unknown>(),
}));
// mock-isolation: Synthetic credentials keep label tests out of host credential storage.
vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStoreAsync: m.store,
  ensureAuthProfileStoreWithoutExternalProfilesAsync: m.localStore,
  externalCliDiscoveryForProviderAuth: () => undefined,
  resolveAuthProfileOrder: m.order,
  resolveAuthProfileDisplayLabel: m.display,
}));
// mock-isolation: Label projection consumes controlled credential-source facts.
vi.mock("./model-auth.js", () => ({
  resolveProviderEntryApiKeyProfileReference: m.reference,
  resolveUsableCustomProviderApiKey: m.custom,
  resolveEnvApiKey: m.env,
}));
// mock-isolation: CLI credentials come from the fixture, never the host Keychain.
vi.mock("./cli-credentials.js", () => ({ readCodexCliCredentialsCached: m.cli }));

beforeEach(() => {
  Object.values(m).forEach((mock) => mock.mockReset());
  m.store.mockReturnValue({ version: 1, profiles: {} });
  m.order.mockReturnValue([]);
  m.reference.mockReturnValue({ kind: "none" });
  m.custom.mockReturnValue(null);
  m.env.mockReturnValue(null);
  m.cli.mockReturnValue(null);
});
function label(provider: string, options: Parameters<typeof resolveModelAuthLabelAsync>[0] = {}) {
  return resolveModelAuthLabelAsync({ cfg: {}, provider, ...options });
}

it.each([
  ["github-copilot", "token", "token", true],
  ["openai", "api_key", "api-key", true],
  ["anthropic", "oauth", "oauth", false],
] as const)(
  "labels %s %s credentials as %s (external=%s)",
  async (provider, type, mode, external) => {
    const profileId = `${provider}:default`;
    const store = {
      version: 1,
      profiles: {
        [profileId]: {
          type,
          provider,
          ...(type === "token"
            ? {
                token: "synthetic-token",
                tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
              }
            : type === "api_key"
              ? { key: "abc123" }
              : {}),
        },
      },
    };
    (external ? m.store : m.localStore).mockReturnValue(store);
    m.order.mockReturnValue([profileId]);
    m.display.mockReturnValue(profileId);
    expect(
      await label(provider, {
        sessionEntry: external ? { authProfileOverride: profileId } : undefined,
        includeExternalProfiles: external,
      }),
    ).toBe(`${mode} (${profileId})`);
    if (!external) {
      expect(m.localStore).toHaveBeenCalledOnce();
      expect(m.store).not.toHaveBeenCalled();
    }
  },
);

it.each(["codex", "openai"])("labels %s CLI auth before environment auth", async (provider) => {
  const codexHome = provider === "openai" ? "/tmp/openclaw-agent/codex-home" : undefined;
  m.cli.mockReturnValue(createOAuthRefreshCredential());
  if (codexHome) {
    m.env.mockReturnValue({ apiKey: "env-key-placeholder", source: "env: OPENAI_API_KEY" });
  }
  expect(await label(provider, { codexCliCredentialsHome: codexHome })).toBe("oauth (codex-cli)");
  expect(m.cli).toHaveBeenCalledWith({
    ...(codexHome ? { codexHome } : {}),
    ttlMs: 5_000,
    allowKeychainPrompt: false,
  });
  if (codexHome) {
    expect(m.env).not.toHaveBeenCalled();
  }
});

it("shows native Claude CLI auth", async () => {
  expect(await label("claude-cli")).toBe("native (claude-cli)");
});

it("resolves env labels with config and workspace scope", async () => {
  m.env.mockReturnValue({
    apiKey: "workspace-cloud-local-credentials",
    source: "workspace cloud credentials",
  });
  const cfg = { plugins: { allow: ["workspace-cloud"] } };
  expect(await label("workspace-cloud", { cfg, workspaceDir: "/tmp/workspace" })).toBe(
    "api-key (workspace cloud credentials)",
  );
  expect(m.env).toHaveBeenCalledWith("workspace-cloud", process.env, {
    config: cfg,
    workspaceDir: "/tmp/workspace",
  });
});

it.each([
  [
    { kind: "profile", profileId: "openrouter:key-b", mode: "api-key" },
    "api-key (openrouter:key-b)",
  ],
  [{ kind: "profile-incompatible", profileId: "google:oauth-a" }, "unknown"],
] as const)(
  "labels per-entry references before literal fallback: %j",
  async (reference, expected) => {
    m.display.mockReturnValue("openrouter:key-b");
    m.reference.mockReturnValue(reference);
    m.custom.mockReturnValue({ apiKey: reference.profileId, source: "models.json" });
    expect(await label("openrouter-minimax")).toBe(expected);
    expect(m.custom).not.toHaveBeenCalled();
  },
);
