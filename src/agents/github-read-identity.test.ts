import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  assertPreparedSessionSourceCurrent,
  prepareSessionSourceAuthority,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";

type PreparedRead = {
  token: string;
  selection: {
    source: "system-detected" | "system-configured" | "agent-override";
    profileId?: string;
    accountId: number;
  };
  cacheScope: string;
  assertSelected: () => void;
  revalidate: () => Promise<void>;
};
type ReadOptions = {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  getCurrentConfig: () => OpenClawConfig;
  assertActive: () => void;
  refresh: () => Promise<void>;
};
const { prepareGitHubReadIdentity, resolveManagedGitHubProfileDir } =
  await loadBundledPluginFacade<{
    prepareGitHubReadIdentity(input: ReadOptions): Promise<PreparedRead>;
    resolveManagedGitHubProfileDir(input: {
      agentId: string;
      scope: "system";
      profileId: string;
      env?: NodeJS.ProcessEnv;
    }): string;
  }>({ pluginId: "github-repositories", artifactBasename: "tool-identity-api.js" });
const { prepareGitHubReaderIdentity } = await loadBundledPluginFacade<{
  prepareGitHubReaderIdentity(
    context: GatewayRequestContext,
    agentId: string,
    assertActive: () => void,
  ): Promise<{ assertSelected: () => void }>;
}>({ pluginId: "github-repositories", artifactBasename: "reader-identity-api.js" });
const { clearNativeGitHubTokenCache } = await loadBundledPluginFacade<{
  clearNativeGitHubTokenCache(): void;
}>({ pluginId: "github-repositories", artifactBasename: "read-identity-api.js" });
const { clearGitHubCredentialVerificationCache } = await loadBundledPluginFacade<{
  clearGitHubCredentialVerificationCache(): void;
}>({ pluginId: "github-repositories", artifactBasename: "runtime-api.ts" });
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandBuffered: run,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  run.mockReset();
  vi.stubEnv("GH_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
  clearNativeGitHubTokenCache();
  clearGitHubCredentialVerificationCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const isNative = new Headers(init?.headers).get("Authorization")?.includes("native");
    return Response.json({
      id: isNative ? 101 : 202,
      login: isNative ? "native-user" : "managed-user",
      avatar_url: null,
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
});
const read = ({ config = {}, ...options }: Partial<ReadOptions> = {}) =>
  prepareGitHubReadIdentity({
    config,
    agentId: "main",
    env: {},
    getCurrentConfig: () => config,
    assertActive: () => {},
    refresh: async () => {},
    ...options,
  });
it("binds system read authority to its selected profile and verified account", async () => {
  const stateDir = tempDirs.make("openclaw-github-read-selection-");
  const env = {
    get OPENCLAW_STATE_DIR() {
      return stateDir;
    },
  };
  const profileId = `ghp_${"3".repeat(32)}`;
  const replacementProfileId = `ghp_${"4".repeat(32)}`;
  const configured = (selectedId: string, enabled = true): OpenClawConfig => ({
    tools: {},
    plugins: {
      entries: {
        "github-repositories": {
          enabled,
          config: {
            system: { profileId: selectedId },
          },
        },
      },
    },
  });
  let config = configured(profileId);
  const profileDir = resolveManagedGitHubProfileDir({
    agentId: "main",
    scope: "system",
    profileId,
    env,
  });
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const hosts = path.join(profileDir, "hosts.yml");
  await fs.writeFile(hosts, "github.com:\n  oauth_token: read-system-before\n", {
    mode: 0o600,
  });
  const prepare = () => read({ env, config, getCurrentConfig: () => config });
  const identity = await prepare();
  expect(identity.selection).toEqual({ source: "system-configured", profileId, accountId: 202 });
  await fs.writeFile(hosts, "github.com:\n  oauth_token: read-system-rotated\n");
  await expect(identity.revalidate()).rejects.toThrow("identity changed");
  const rotated = await prepare();
  expect(rotated.selection).toEqual(identity.selection);
  expect(rotated.cacheScope).not.toBe(identity.cacheScope);
  const stateDirReads = vi.spyOn(env, "OPENCLAW_STATE_DIR", "get");
  for (let index = 0; index < 10; index++) {
    rotated.assertSelected();
  }
  expect(stateDirReads).not.toHaveBeenCalled();
  const prepared = await prepareSessionSourceAuthority(rotated.assertSelected);
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const reader = await prepareGitHubReaderIdentity(
    { getRuntimeConfig: () => config } as GatewayRequestContext,
    "main",
    () => {},
  );
  config = configured(profileId, false);
  expect(() => reader.assertSelected()).toThrow("identity changed");
  config = configured(replacementProfileId);
  expect(() => rotated.assertSelected()).toThrow("identity changed");
  // Writer preparation must retain the selection check, not classify it as an external callback.
  expect(() => assertPreparedSessionSourceCurrent(prepared)).toThrow("identity changed");
  expect(run).not.toHaveBeenCalled();
});
