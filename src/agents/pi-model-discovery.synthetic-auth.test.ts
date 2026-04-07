import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "./auth-profiles.js";

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(() => ({
    plugins: [
      {
        id: "anthropic",
        origin: "bundled",
        providers: ["anthropic"],
        cliBackends: ["claude-cli"],
      },
    ],
    diagnostics: [],
  })),
);

const resolveProviderSyntheticAuthWithPlugin = vi.hoisted(() =>
  vi.fn((params: { provider: string }) =>
    params.provider === "claude-cli"
      ? {
          apiKey: "claude-cli-access-token",
          source: "Claude CLI native auth",
          mode: "oauth" as const,
        }
      : undefined,
  ),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderResolvedModelCompatWithPlugins: () => undefined,
  applyProviderResolvedTransportWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin,
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-synthetic-auth-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

describe("pi model discovery synthetic auth", () => {
  beforeEach(() => {
    vi.resetModules();
    loadPluginManifestRegistry.mockClear();
    resolveProviderSyntheticAuthWithPlugin.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mirrors plugin-owned synthetic cli auth into pi auth storage", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {},
        },
        agentDir,
      );

      const { discoverAuthStorage } = await import("./pi-model-discovery.js");
      const authStorage = discoverAuthStorage(agentDir);

      expect(loadPluginManifestRegistry).toHaveBeenCalled();
      expect(resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledWith({
        provider: "claude-cli",
        context: {
          config: undefined,
          provider: "claude-cli",
          providerConfig: undefined,
        },
      });
      expect(authStorage.hasAuth("claude-cli")).toBe(true);
      await expect(authStorage.getApiKey("claude-cli")).resolves.toBe("claude-cli-access-token");
    });
  });
});
