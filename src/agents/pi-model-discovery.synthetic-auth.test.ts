import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "./auth-profiles.js";

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());

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

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderResolvedModelCompatWithPlugins: () => undefined,
  applyProviderResolvedTransportWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin,
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

vi.mock("./auth-profiles/store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-profiles/store.js")>(
    "./auth-profiles/store.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: ensureAuthProfileStoreMock,
  };
});

let discoverAuthStorage: typeof import("./pi-model-discovery.js").discoverAuthStorage;

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-synthetic-auth-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

describe("pi model discovery synthetic auth", () => {
  beforeAll(async () => {
    ({ discoverAuthStorage } = await import("./pi-model-discovery.js"));
  });

  beforeEach(() => {
    resolveRuntimeSyntheticAuthProviderRefs.mockClear();
    resolveProviderSyntheticAuthWithPlugin.mockClear();
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreMock.mockImplementation((agentDir?: string) => ({
      version: 1,
      profiles: {},
      __agentDir: agentDir,
    }));
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

      const authStorage = discoverAuthStorage(agentDir);

      expect(ensureAuthProfileStoreMock).toHaveBeenCalledWith(agentDir, {
        allowKeychainPrompt: false,
        commandName: undefined,
        effectiveToolPolicy: undefined,
      });

      expect(resolveRuntimeSyntheticAuthProviderRefs).toHaveBeenCalled();
      expect(resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledWith({
        provider: "claude-cli",
        commandName: undefined,
        effectiveToolPolicy: undefined,
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

  it("threads commandName/effectiveToolPolicy through discoverAuthStorage into ensureAuthProfileStore and synthetic auth resolution", async () => {
    await withAgentDir(async (agentDir) => {
      discoverAuthStorage(agentDir, {
        commandName: "agent-exec",
        effectiveToolPolicy: "coordination_only",
      });

      expect(ensureAuthProfileStoreMock).toHaveBeenCalledWith(agentDir, {
        allowKeychainPrompt: false,
        commandName: "agent-exec",
        effectiveToolPolicy: "coordination_only",
      });
      expect(resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledWith({
        provider: "claude-cli",
        commandName: "agent-exec",
        effectiveToolPolicy: "coordination_only",
        context: {
          config: undefined,
          provider: "claude-cli",
          providerConfig: undefined,
        },
      });
    });
  });
});
