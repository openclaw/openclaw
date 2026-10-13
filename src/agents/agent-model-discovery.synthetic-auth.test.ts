/** Tests synthetic auth fallback during agent model discovery. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveAgentDiscoveryAuthFacts } from "./agent-auth-discovery.js";

const resolveRuntimeSyntheticAuthProviderRefs = vi.hoisted(() => vi.fn(() => ["claude-cli"]));

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

// mock-isolation: Synthetic auth owns its catalog fixture and does not inspect host metadata.
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshotAsync: async () => createPluginMetadataSnapshotFixture(),
}));

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs,
}));

// mock-isolation: Synthetic auth callbacks use fixture credentials instead of installed provider runtimes.
vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderResolvedTransportWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin,
  prepareProviderSyntheticAuthWithPlugin: async (params: { provider: string }) =>
    resolveProviderSyntheticAuthWithPlugin(params),
}));

// mock-isolation: Synthetic credential discovery uses an empty profile store, never host credentials.
vi.mock("./auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStoreAsync: async () => ({ version: 1, profiles: {} }),
  ensureAuthProfileStoreWithoutExternalProfilesAsync: async () => ({ version: 1, profiles: {} }),
}));

vi.mock("./agent-auth-discovery-core.js", () => ({
  addEnvBackedAgentCredentials: (credentials: Record<string, unknown>) => ({ ...credentials }),
}));

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-synthetic-auth-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

describe("agent model discovery synthetic auth", () => {
  beforeEach(() => {
    resolveRuntimeSyntheticAuthProviderRefs.mockClear();
    resolveProviderSyntheticAuthWithPlugin.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mirrors plugin-owned synthetic cli auth into credential discovery", async () => {
    await withAgentDir(async (agentDir) => {
      const { credentials } = await resolveAgentDiscoveryAuthFacts(agentDir, { readOnly: true });

      expect(resolveRuntimeSyntheticAuthProviderRefs).toHaveBeenCalledTimes(1);
      expect(resolveRuntimeSyntheticAuthProviderRefs).toHaveBeenCalledWith(
        expect.objectContaining({ index: expect.objectContaining({ plugins: [] }) }),
      );
      expect(resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledTimes(1);
      expect(resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "claude-cli",
          config: undefined,
          workspaceDir: undefined,
          env: undefined,
          context: {
            config: undefined,
            provider: "claude-cli",
            providerConfig: undefined,
          },
        }),
      );
      expect(credentials["claude-cli"]).toEqual({
        type: "api_key",
        key: "claude-cli-access-token",
      });
    });
  });
});
