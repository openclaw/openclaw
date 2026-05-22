import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSensitiveHostDenyMutations, resolveHostToolPath } from "./host-mutation-policy.js";

describe("host mutation policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds exact and recursive deny entries for host credential paths", () => {
    const osHome = path.resolve("/tmp/openclaw-os-home");
    const userProfileHome = path.resolve("/tmp/openclaw-userprofile-home");
    const openclawHome = path.resolve("/tmp/openclaw-effective-home");
    const stateDir = path.resolve("/tmp/openclaw-state");
    const oauthDir = path.resolve("/tmp/openclaw-oauth");
    const agentDir = path.resolve("/tmp/openclaw-agent");
    const configuredAgentDir = path.resolve("/tmp/openclaw-configured-agent");

    const policy = buildSensitiveHostDenyMutations(
      {
        HOME: osHome,
        USERPROFILE: userProfileHome,
        OPENCLAW_HOME: openclawHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_OAUTH_DIR: oauthDir,
        OPENCLAW_AGENT_DIR: agentDir,
      } as NodeJS.ProcessEnv,
      { agentDirs: [configuredAgentDir] },
    );

    expect(policy.paths).toContain(path.join(osHome, ".ssh", "authorized_keys"));
    expect(policy.paths).toContain(path.join(userProfileHome, ".netrc"));
    expect(policy.paths).toContain(path.join(openclawHome, ".netrc"));
    expect(policy.paths).toContain(path.join(stateDir, ".env"));
    expect(policy.paths).toContain(path.join(agentDir, "auth-profiles.json"));
    expect(policy.paths).toContain(path.join(agentDir, "agent", "auth-profiles.json"));
    expect(policy.paths).toContain(path.join(configuredAgentDir, "auth-profiles.json"));
    expect(policy.paths).toContain(path.join(configuredAgentDir, "agent", "auth-profiles.json"));
    expect(policy.prefixes).toContain(path.join(osHome, ".ssh"));
    expect(policy.prefixes).toContain(path.join(userProfileHome, ".aws"));
    expect(policy.prefixes).toContain(path.join(openclawHome, ".aws"));
    expect(policy.prefixes).toContain(path.join(stateDir, "credentials"));
    expect(policy.prefixes).toContain(path.join(stateDir, "agents"));
    expect(policy.prefixes).toContain(oauthDir);
    expect(policy.paths).toEqual([...(policy.paths ?? [])].toSorted());
    expect(policy.prefixes).toEqual([...(policy.prefixes ?? [])].toSorted());
  });

  it("expands model tool tildes against the operating-system home", () => {
    const osHome = path.resolve("/tmp/openclaw-os-home");
    const openclawHome = path.resolve("/tmp/openclaw-effective-home");
    vi.stubEnv("HOME", osHome);
    vi.stubEnv("USERPROFILE", osHome);
    vi.stubEnv("OPENCLAW_HOME", openclawHome);

    expect(resolveHostToolPath("~/scratch.txt")).toBe(path.join(osHome, "scratch.txt"));
  });
});
