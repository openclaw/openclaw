import { expectDefined } from "@openclaw/normalization-core";
import { ensureAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  ProviderAuthResult,
  ProviderCatalogResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, vi } from "vitest";
import plugin from "./index.js";

type RegisteredProvider = Parameters<OpenClawPluginApi["registerProvider"]>[0];
type GithubCopilotTestProvider = RegisteredProvider & {
  auth: Array<{
    id: string;
    run: (ctx: unknown) => Promise<ProviderAuthResult | null>;
    runNonInteractive: (ctx: unknown) => Promise<OpenClawConfig | null>;
  }>;
  catalog: {
    run: (ctx: unknown) => Promise<ProviderCatalogResult>;
  };
  prepareDynamicModel: NonNullable<RegisteredProvider["prepareDynamicModel"]>;
  resolveDynamicModel: NonNullable<RegisteredProvider["resolveDynamicModel"]>;
  preferRuntimeResolvedModel: NonNullable<RegisteredProvider["preferRuntimeResolvedModel"]>;
  prepareRuntimeAuth: NonNullable<RegisteredProvider["prepareRuntimeAuth"]>;
  resolveThinkingProfile: NonNullable<RegisteredProvider["resolveThinkingProfile"]>;
};

export function requireAuthMethod<T>(methods: readonly T[], index: number): T {
  return expectDefined(methods[index], `GitHub Copilot auth method ${index}`);
}

export function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn<OpenClawPluginApi["registerProvider"]>();
  plugin.register(
    createTestPluginApi({
      id: "github-copilot",
      pluginConfig,
      registerProvider: registerProviderMock,
    }),
  );
  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return expectDefined(
    registerProviderMock.mock.calls[0]?.[0],
    "provider registration",
  ) as GithubCopilotTestProvider;
}

export function interactiveContext(agentDir: string) {
  return {
    config: {},
    existingProfiles: Object.entries(ensureAuthProfileStore(agentDir).profiles).map(
      ([profileId, credential]) => ({ profileId, credential }),
    ),
    env: {},
    agentDir,
    workspaceDir: "/tmp/workspace",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    opts: {},
    allowSecretRefPrompt: false,
    isRemote: false,
    oauth: { createVpsAwareHandlers: vi.fn() },
  };
}
