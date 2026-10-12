import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearGitHubCredentialVerificationCache } from "./github-oauth-client.js";

const processMocks = vi.hoisted(() => ({ runCommandBuffered: vi.fn() }));
const oauthMocks = vi.hoisted(() => ({ inspect: vi.fn() }));

vi.mock("../process/exec.js", () => ({ runCommandBuffered: processMocks.runCommandBuffered }));
vi.mock("./github-oauth-records.js", () => ({ inspectGitHubOAuthRecord: oauthMocks.inspect }));

import { INVALID_GITHUB_PROFILE_SELECTION_MESSAGE } from "./github-invalid-selection.js";
import {
  prepareGitHubPublicationIdentity,
  prepareGitHubReadIdentity,
  prepareGitHubToolEnvironment,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
} from "./github-tool-identity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const legacyProfileId = `ghp_${"Z".repeat(36)}`;

function commandResult(stdout = "") {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

async function writeProfile(profileDir: string, token: string) {
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(profileDir, "hosts.yml"), `github.com:\n  oauth_token: ${token}\n`, {
    mode: 0o600,
  });
}

describe("invalid GitHub profile selection", () => {
  beforeEach(() => {
    clearGitHubCredentialVerificationCache();
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    oauthMocks.inspect.mockReset().mockReturnValue({ state: "missing" });
    processMocks.runCommandBuffered.mockReset().mockImplementation(async (argv: string[]) => {
      if (argv[0] === "git") {
        return commandResult();
      }
      throw new Error(`unexpected credential subprocess: ${argv.join(" ")}`);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("invalid GitHub selection must not verify another account");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps an invalid agent profile unavailable when a shared profile is valid", async () => {
    const root = tempDirs.make("openclaw-github-invalid-agent-");
    const env = { OPENCLAW_STATE_DIR: root, GH_TOKEN: "native-should-not-be-used" };
    const systemProfileId = "ghp_11111111111111111111111111111111";
    const systemProfileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId: systemProfileId,
      env,
    });
    await writeProfile(systemProfileDir, "shared-should-not-be-used");
    const config = {
      tools: { github: { profileId: systemProfileId, kind: "oauth" as const } },
      agents: {
        entries: {
          main: {
            tools: { github: { profileId: legacyProfileId, kind: "oauth" as const } },
          },
        },
      },
    };

    const prepared = prepareGitHubToolEnvironment({ config, agentId: "main", env });
    expect(prepared).toMatchObject({
      invalidGitHubSelection: true,
      managedLocalIdentity: true,
      localIdentityEnv: {},
    });
    expect(JSON.stringify(prepared)).not.toContain(systemProfileDir);
    expect(JSON.stringify(prepared)).not.toContain("shared-should-not-be-used");

    const status = await resolveGitHubToolIdentityStatus({
      config,
      agentId: "main",
      selectedScope: "agent",
      env,
    });
    expect(status.effective).toMatchObject({
      source: "agent-override",
      credentialKind: "managed-oauth",
      credentialState: "configured_unavailable",
      account: null,
      evidence: "none",
    });
    expect(status.selected.identity).toMatchObject({
      source: "agent-override",
      credentialState: "configured_unavailable",
      account: null,
    });

    await expect(
      prepareGitHubPublicationIdentity({ config, agentId: "main", env }),
    ).rejects.toThrow(INVALID_GITHUB_PROFILE_SELECTION_MESSAGE);
    await expect(
      prepareGitHubReadIdentity({
        config,
        agentId: "main",
        env,
        allowAnonymous: true,
        getCurrentConfig: () => config,
        assertActive: () => {},
        refresh: async () => {},
      }),
    ).rejects.toThrow(INVALID_GITHUB_PROFILE_SELECTION_MESSAGE);
    expect(fetch).not.toHaveBeenCalled();
    expect(processMocks.runCommandBuffered.mock.calls.some(([argv]) => argv[0] === "gh")).toBe(
      false,
    );
    expect(JSON.stringify(processMocks.runCommandBuffered.mock.calls)).not.toContain(
      "shared-should-not-be-used",
    );
    expect(JSON.stringify(processMocks.runCommandBuffered.mock.calls)).not.toContain(
      "native-should-not-be-used",
    );
  });

  it("keeps an invalid shared profile from becoming native authentication", async () => {
    const env = { GH_TOKEN: "native-should-not-be-used", GITHUB_TOKEN: "native-fallback" };
    const config = { tools: { github: { profileId: legacyProfileId, kind: "oauth" as const } } };

    const status = await resolveGitHubToolIdentityStatus({
      config,
      agentId: "main",
      selectedScope: "system",
      env,
    });
    expect(status.effective).toMatchObject({
      source: "system-configured",
      credentialKind: "managed-oauth",
      credentialState: "configured_unavailable",
      account: null,
      evidence: "none",
    });
    expect(status.selected).toMatchObject({
      scope: "system",
      configured: true,
      identity: {
        source: "system-configured",
        credentialState: "configured_unavailable",
        account: null,
      },
    });

    await expect(
      prepareGitHubPublicationIdentity({ config, agentId: "main", env }),
    ).rejects.toThrow(INVALID_GITHUB_PROFILE_SELECTION_MESSAGE);
    await expect(
      prepareGitHubReadIdentity({
        config,
        agentId: "main",
        env,
        allowAnonymous: true,
        getCurrentConfig: () => config,
        assertActive: () => {},
        refresh: async () => {},
      }),
    ).rejects.toThrow(INVALID_GITHUB_PROFILE_SELECTION_MESSAGE);
    expect(fetch).not.toHaveBeenCalled();
    expect(processMocks.runCommandBuffered.mock.calls.some(([argv]) => argv[0] === "gh")).toBe(
      false,
    );
  });
});
