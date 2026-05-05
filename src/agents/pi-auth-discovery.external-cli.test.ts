import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const storeMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
  loadAuthProfileStoreForRuntime: vi.fn(() => ({ version: 1, profiles: {} })),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(() => ({ version: 1, profiles: {} })),
}));

const credentialMocks = vi.hoisted(() => ({
  resolvePiCredentialMapFromStore: vi.fn(() => ({})),
}));

const discoveryCoreMocks = vi.hoisted(() => ({
  addEnvBackedPiCredentials: vi.fn((credentials: unknown) => credentials),
  scrubLegacyStaticAuthJsonEntriesForDiscovery: vi.fn(),
}));

vi.mock("./auth-profiles/store.js", () => storeMocks);

vi.mock("./pi-auth-credentials.js", () => credentialMocks);

vi.mock("./pi-auth-discovery-core.js", () => discoveryCoreMocks);

vi.mock("./synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: () => [],
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: vi.fn(),
}));

import { externalCliDiscoveryForProviders } from "./auth-profiles/external-cli-discovery.js";
import { resolvePiCredentialsForDiscovery } from "./pi-auth-discovery.js";

describe("resolvePiCredentialsForDiscovery external CLI scoping", () => {
  it("threads scoped external CLI discovery into writable auth store loading", () => {
    const cfg = {} as OpenClawConfig;
    const externalCli = externalCliDiscoveryForProviders({
      cfg,
      providers: ["fireworks"],
    });

    resolvePiCredentialsForDiscovery("/tmp/openclaw-agent", {
      config: cfg,
      env: {},
      externalCli,
    });

    expect(storeMocks.ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw-agent", {
      allowKeychainPrompt: false,
      config: cfg,
      externalCli,
    });
    expect(storeMocks.loadAuthProfileStoreForRuntime).not.toHaveBeenCalled();
  });

  it("preserves scoped external CLI discovery for read-only auth store loading", () => {
    const cfg = {} as OpenClawConfig;
    const externalCli = externalCliDiscoveryForProviders({
      cfg,
      providers: ["fireworks"],
    });

    resolvePiCredentialsForDiscovery("/tmp/openclaw-agent", {
      config: cfg,
      env: {},
      externalCli,
      readOnly: true,
    });

    expect(storeMocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith("/tmp/openclaw-agent", {
      allowKeychainPrompt: false,
      config: cfg,
      externalCli,
      readOnly: true,
    });
  });
});
