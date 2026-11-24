import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const m = vi.hoisted(() => ({
  store: vi.fn(() => ({ version: 1, profiles: {} })),
  localStore: vi.fn(() => ({ version: 1, profiles: {} })),
  credentials: vi.fn(() => ({})),
  lookup: vi.fn<typeof import("./model-auth-env-vars.js").resolveProviderEnvAuthLookupMaps>(),
  env: vi.fn<typeof import("./model-auth-env.js").resolveEnvApiKey>(),
  refs: vi.fn(() => []),
  synthetic: vi.fn(),
  prepare: vi.fn(),
}));
// mock-isolation: Discovery uses synthetic stores without opening host credentials.
vi.mock("./auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStoreAsync: m.store,
  ensureAuthProfileStoreWithoutExternalProfilesAsync: m.localStore,
}));
// mock-isolation: Resolve only the synthetic credential map supplied by this fixture.
vi.mock("./agent-auth-credentials.js", () => ({
  resolveAgentCredentialMapFromStore: m.credentials,
}));
vi.mock("./model-auth-env-vars.js", async (original) => ({
  ...(await original<typeof import("./model-auth-env-vars.js")>()),
  resolveProviderEnvAuthLookupMaps: m.lookup,
}));
vi.mock("./model-auth-env.js", async (original) => ({
  ...(await original<typeof import("./model-auth-env.js")>()),
  resolveEnvApiKey: m.env,
}));
// mock-isolation: Keep discovery scoped to the fixture's synthetic provider roster.
vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: m.refs,
}));
// mock-isolation: Plugin credential preparation must not load real provider runtimes.
vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: m.synthetic,
  prepareProviderSyntheticAuthWithPlugin: m.prepare,
}));
import {
  resolveAgentDiscoveryAuthFacts,
  resolveAmbientAgentCredentialsForDiscovery,
  prepareAmbientAgentCredentialsForDiscovery,
} from "./agent-auth-discovery.js";
import { externalCliDiscoveryForProviders } from "./auth-profiles/external-cli-discovery.js";

const emptyLookup = {
  aliasMap: {},
  envCandidateMap: {},
  authEvidenceMap: {},
  setupProviderFallbackRefs: [],
};
const discover = (options: Parameters<typeof resolveAgentDiscoveryAuthFacts>[1]) =>
  resolveAgentDiscoveryAuthFacts("/tmp/openclaw-agent", { env: {}, ...options });
beforeEach(() => {
  vi.clearAllMocks();
  m.credentials.mockReturnValue({});
  m.lookup.mockReturnValue(emptyLookup);
  m.env.mockReset();
});

it("scopes external CLI discovery without prompting for credentials", async () => {
  const cfg: OpenClawConfig = {};
  const externalCli = externalCliDiscoveryForProviders({ cfg, providers: ["fireworks"] });
  await discover({ config: cfg, externalCli });
  expect(m.store).toHaveBeenCalledWith("/tmp/openclaw-agent", {
    allowKeychainPrompt: false,
    config: cfg,
    externalCli,
  });
});

it("merges prepared ambient credentials without repeating discovery", async () => {
  const agentKey = { type: "api_key", key: "agent-key" } as const;
  const syntheticKey = { type: "api_key", key: "synthetic-key" } as const;
  m.credentials.mockReturnValue({ fireworks: agentKey });
  const { credentials } = await discover({
    ambientCredentials: {
      fireworks: { type: "api_key", key: "ambient-key" },
      "claude-cli": syntheticKey,
    },
    readOnly: true,
  });
  expect(credentials).toEqual({ fireworks: agentKey, "claude-cli": syntheticKey });
  for (const mock of [m.lookup, m.refs, m.synthetic]) {
    expect(mock).not.toHaveBeenCalled();
  }
});

it("skips external overlays and scopes synthetic auth discovery", async () => {
  m.synthetic.mockReturnValue({ apiKey: "synthetic-key" });
  const { credentials } = await discover({
    skipExternalAuthProfiles: true,
    syntheticAuthProviderRefs: ["fireworks"],
  });
  expect(m.localStore).toHaveBeenCalledWith("/tmp/openclaw-agent", { allowKeychainPrompt: false });
  expect(m.store).not.toHaveBeenCalled();
  expect(m.refs).not.toHaveBeenCalled();
  expect(credentials).toEqual({ fireworks: { type: "api_key", key: "synthetic-key" } });
  expect(m.synthetic.mock.calls.map(([params]) => params.provider)).toEqual(["fireworks"]);
});

it.each(["read", "prepare"])("keeps native auth separate from aliases during %s", async (mode) => {
  m.lookup.mockReturnValueOnce({
    ...emptyLookup,
    envCandidateMap: { "claude-cli": ["ANTHROPIC_API_KEY"] },
  });
  m.env.mockReturnValueOnce({ apiKey: "provider-key", source: "env: ANTHROPIC_API_KEY" });
  const resolveSyntheticAuth = vi.fn((_provider: string) => undefined);
  const options = {
    env: { ANTHROPIC_API_KEY: "provider-key" },
    syntheticAuthProviderRefs: ["claude-cli"],
    authoritativeSyntheticAuthProviderRefs: ["claude-cli"],
    resolveSyntheticAuth,
  };
  const credentials =
    mode === "read"
      ? resolveAmbientAgentCredentialsForDiscovery(options)
      : await prepareAmbientAgentCredentialsForDiscovery({
          ...options,
          resolveSyntheticAuth: async (provider) => resolveSyntheticAuth(provider),
        });
  expect(credentials).toEqual({});
  expect(resolveSyntheticAuth).toHaveBeenCalledWith("claude-cli");
});

it.each(["oauth", "token"] as const)("rejects API keys under %s pins", async (auth) => {
  m.synthetic.mockReturnValue({ apiKey: "synthetic-key" });
  const config: OpenClawConfig = {
    models: {
      providers: { fireworks: { auth, baseUrl: "https://example.invalid", models: [] } },
    },
  };
  const { credentials } = await discover({ config, syntheticAuthProviderRefs: ["fireworks"] });
  expect(credentials.fireworks).toBeUndefined();
  expect(m.synthetic).not.toHaveBeenCalled();
});
