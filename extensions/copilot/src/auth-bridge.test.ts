// Copilot tests cover auth bridge plugin behavior.
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCopilotAuth, tokenFingerprint } from "./auth-bridge.js";

const FAKE_HOME = "/fake-home";
const fakeHomeDir = () => FAKE_HOME;
const COPILOT_DEFAULT_AGENT_ID = "copilot";
const COPILOT_TOKEN_PROFILE_ERROR =
  "[copilot-attempt] gitHubToken auth requires profileId+profileVersion (pool keying safety; per Q5/Q1 decisions)";

function resolveAuth(input: Parameters<typeof resolveCopilotAuth>[0] = {}) {
  return resolveCopilotAuth({ agentId: "agent-1", env: {}, homeDir: fakeHomeDir, ...input });
}

function resolveAgentId(agentId: string | undefined): string {
  return resolveAuth({ agentId }).agentId;
}

describe("sanitizeAgentId", () => {
  it("returns default for null/undefined/empty", () => {
    expect(resolveAgentId(undefined)).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("")).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("   ")).toBe(COPILOT_DEFAULT_AGENT_ID);
  });

  it("rejects path-traversal segments and falls back to default", () => {
    expect(resolveAgentId("../etc/passwd")).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("../..")).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("a/b")).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("a\\b")).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("a\u0000b")).toBe(COPILOT_DEFAULT_AGENT_ID);
  });
});

describe("resolveCopilotAuth - copilotHome resolution", () => {
  it("uses explicit copilotHome when provided", () => {
    const result = resolveAuth({
      copilotHome: "/explicit/home",
    });
    expect(result.copilotHome).toBe(resolve("/explicit/home"));
  });

  it("falls back to <agentDir>/copilot when copilotHome is absent", () => {
    const result = resolveAuth({
      agentDir: "/agent/dir",
    });
    expect(result.copilotHome).toBe(resolve(join("/agent/dir", "copilot")));
  });

  it("respects OPENCLAW_HOME env var as the home root", () => {
    const result = resolveAuth({
      env: { OPENCLAW_HOME: "/custom/openclaw" },
    });
    expect(result.copilotHome).toBe(
      resolve(join("/custom/openclaw", ".openclaw", "agents", "agent-1", "copilot")),
    );
  });

  it("isolates per-agent copilotHome between agents", () => {
    const a = resolveAuth({
      agentId: "agent-a",
    });
    const b = resolveAuth({
      agentId: "agent-b",
    });
    expect(a.copilotHome).not.toBe(b.copilotHome);
    expect(a.copilotHome.endsWith(join("agent-a", "copilot"))).toBe(true);
    expect(b.copilotHome.endsWith(join("agent-b", "copilot"))).toBe(true);
  });
});

describe("resolveCopilotAuth - auth mode resolution", () => {
  it("accepts legacy top-level profileVersion + authProfileId fallbacks", () => {
    const result = resolveAuth({
      auth: { gitHubToken: "tok" },
      authProfileId: "legacy-p",
      profileVersion: "legacy-v1",
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.authProfileId).toBe("legacy-p");
    expect(result.authProfileVersion).toBe("legacy-v1");
  });

  it("throws when explicit gitHubToken is given without both profileId + profileVersion", () => {
    expect(() =>
      resolveAuth({
        auth: { gitHubToken: "tok" },
      }),
    ).toThrow(COPILOT_TOKEN_PROFILE_ERROR);

    expect(() =>
      resolveAuth({
        auth: { gitHubToken: "tok", profileId: "p" },
      }),
    ).toThrow(COPILOT_TOKEN_PROFILE_ERROR);

    expect(() =>
      resolveAuth({
        auth: { gitHubToken: "tok", profileVersion: "v" },
      }),
    ).toThrow(COPILOT_TOKEN_PROFILE_ERROR);
  });
});

describe("resolveCopilotAuth - contract-resolved auth (resolvedApiKey + authProfileId)", () => {
  it("synthesises authProfileId when contract-resolved token has no profile id", () => {
    const result = resolveAuth({
      resolvedApiKey: "contract-token-xyz",
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.gitHubToken).toBe("contract-token-xyz");
    expect(result.authProfileId).toBe("pi:resolved");
    expect(result.authProfileVersion).toBe(tokenFingerprint("contract-token-xyz"));
  });

  it("auth.useLoggedInUser=true takes precedence over contract resolvedApiKey", () => {
    const result = resolveAuth({
      auth: { useLoggedInUser: true },
      resolvedApiKey: "should-be-ignored",
      authProfileId: "p",
    });
    expect(result.authMode).toBe("useLoggedInUser");
    expect(result.gitHubToken).toBeUndefined();
  });
});

describe("resolveCopilotAuth - env var fallbacks", () => {
  it("OPENCLAW_GITHUB_TOKEN takes precedence over COPILOT_GITHUB_TOKEN, GH_TOKEN and GITHUB_TOKEN", () => {
    const result = resolveAuth({
      env: {
        OPENCLAW_GITHUB_TOKEN: "openclaw-tok",
        COPILOT_GITHUB_TOKEN: "copilot-tok",
        GH_TOKEN: "gh-tok",
        GITHUB_TOKEN: "github-tok",
      },
    });
    expect(result.gitHubToken).toBe("openclaw-tok");
    expect(result.authProfileId).toBe("env:OPENCLAW_GITHUB_TOKEN");
    expect(result.authProfileVersion).toBe(tokenFingerprint("openclaw-tok"));
  });

  it("token rotation in env changes the pool fingerprint (cache-busting)", () => {
    const a = resolveAuth({
      env: { GITHUB_TOKEN: "v1" },
    });
    const b = resolveAuth({
      env: { GITHUB_TOKEN: "v2" },
    });
    expect(a.authProfileVersion).not.toBe(b.authProfileVersion);
  });
});

describe("resolveCopilotAuth - defaults wiring", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", undefined);
    vi.stubEnv("OPENCLAW_GITHUB_TOKEN", undefined);
    vi.stubEnv("COPILOT_GITHUB_TOKEN", undefined);
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("OPENCLAW_HOME", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses os.homedir() when homeDir is not injected", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
    });
    // We don't know the actual home, just that the resolver did not throw and
    // produced an absolute path containing the per-agent suffix.
    expect(result.copilotHome.endsWith(join(".openclaw", "agents", "agent-1", "copilot"))).toBe(
      true,
    );
  });

  it("falls back to process.cwd() if homeDir throws", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: {},
      homeDir: () => {
        throw new Error("no home");
      },
    });
    // Should not throw; should produce a path under cwd.
    expect(result.copilotHome.includes(join(".openclaw", "agents", "agent-1", "copilot"))).toBe(
      true,
    );
  });
});
