import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveAgentHarnessAuthOwnership } from "./auth-ownership.js";
import type { AgentHarness } from "./types.js";

// Selection remains real; synthetic providers need no bundled provider artifact discovery.
vi.mock("../../plugins/providers.js", () => ({
  resolveProviderRefOwnership: () => ({ status: "unowned" }),
}));
vi.mock("../../plugins/provider-model-routes.js", () => ({
  resolveProviderModelCatalogId: () => null,
  resolveProviderModelPolicySurface: () => null,
  resolveProviderModelRoutes: () => null,
}));

function withHostHarness(run: (config: OpenClawConfig) => void) {
  const registry = createEmptyPluginRegistry();
  const harness: AgentHarness = {
    id: "remote-runtime",
    label: "Remote runtime",
    supports: ({ provider }) => (provider === "acme" ? { supported: true } : { supported: false }),
    resolveAuthOwnership: ({ provider }) => (provider === "acme" ? "host" : undefined),
    runAttempt: async () => {
      throw new Error("Ownership lookup must not execute a turn");
    },
  };
  registry.agentHarnesses.push({ pluginId: "remote-runtime", source: "test", harness });
  const config: OpenClawConfig = {
    models: {
      providers: {
        acme: {
          baseUrl: "https://api.example.test/v1",
          agentRuntime: { id: "remote-runtime" },
          models: [],
        },
      },
    },
  };
  withPluginRuntimeRegistryScope(registry, () => run(config));
}

describe("resolveAgentHarnessAuthOwnership", () => {
  it("uses host ownership for the configured runtime without restricting unrelated providers", () => {
    withHostHarness((config) => {
      expect(
        resolveAgentHarnessAuthOwnership({ config, provider: "acme", modelId: "test-model" }),
      ).toBe("host");
      expect(
        resolveAgentHarnessAuthOwnership({
          config,
          provider: "other",
          runtimeId: "remote-runtime",
        }),
      ).toBeUndefined();
    });
  });

  it("honors the actual fallback runtime instead of another installed host-auth harness", () => {
    withHostHarness((config) => {
      expect(
        resolveAgentHarnessAuthOwnership({ config, provider: "acme", runtimeId: "openclaw" }),
      ).toBeUndefined();
    });
  });

  it("keeps an explicitly configured built-in route on ordinary provider authentication", () => {
    withHostHarness((config) => {
      config.models!.providers!.acme!.agentRuntime = { id: "openclaw" };
      expect(resolveAgentHarnessAuthOwnership({ config, provider: "acme" })).toBeUndefined();
    });
  });
});
