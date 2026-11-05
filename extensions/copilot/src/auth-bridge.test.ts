import { homedir as osHomedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCopilotAuth, tokenFingerprint } from "./auth-bridge.js";

const FAKE_HOME = "/fake-home";
const tokenEnvs = ["OPENCLAW_GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
type Input = Parameters<typeof resolveCopilotAuth>[0];
function resolveAuth(input: Input = {}) {
  return resolveCopilotAuth({ agentId: "agent-1", ...input });
}
function stubTokens(names = tokenEnvs) {
  for (const name of names) {
    vi.stubEnv(name, name);
  }
}
function expectLoggedIn(input: Input = {}) {
  const result = resolveAuth(input);
  expect(result.authMode).toBe("useLoggedInUser");
  expect([result.gitHubToken, result.authProfileId, result.authProfileVersion]).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
}
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: vi.fn(),
}));
beforeEach(() => {
  for (const name of [...tokenEnvs, "OPENCLAW_HOME"]) {
    vi.stubEnv(name, undefined);
  }
  vi.mocked(osHomedir).mockReset().mockReturnValue(FAKE_HOME);
});
afterEach(() => vi.unstubAllEnvs());

describe("resolveCopilotAuth", () => {
  it.each([
    [undefined, "copilot"],
    ["   ", "copilot"],
    ["Agent-1", "agent-1"],
    ["my_agent_42", "my_agent_42"],
    ["../etc/passwd", "copilot"],
    ["a/b", "copilot"],
    ["a\\b", "copilot"],
    ["a\u0000b", "copilot"],
    ["-foo", "copilot"],
    ["_bar", "copilot"],
    ["a".repeat(64), "a".repeat(64)],
    ["a".repeat(65), "copilot"],
  ])("sanitizes agent id %j", (agentId, expected) => {
    expect(resolveAuth({ agentId }).agentId).toBe(expected);
  });

  it("returns a stable sha256-prefixed 12-hex fingerprint", () => {
    expect(tokenFingerprint("hello")).toBe("sha256:2cf24dba5fb0");
  });

  it.each([
    [{ copilotHome: "/explicit/home" }, "/explicit/home"],
    [{ agentDir: "/agent/dir" }, "/agent/dir/copilot"],
    [{}, join(FAKE_HOME, ".openclaw", "agents", "agent-1", "copilot")],
    [{ agentId: undefined }, join(FAKE_HOME, ".openclaw", "agents", "copilot", "copilot")],
  ])("resolves copilotHome from %j", (input, expected) => {
    expect(resolveAuth(input).copilotHome).toBe(resolve(expected));
  });

  it("respects OPENCLAW_HOME env var as the home root", () => {
    vi.stubEnv("OPENCLAW_HOME", "/custom/openclaw");
    expect(resolveAuth().copilotHome).toBe(
      resolve("/custom/openclaw/.openclaw/agents/agent-1/copilot"),
    );
  });

  it("isolates per-agent copilotHome between agents", () => {
    const homes = ["agent-a", "agent-b"].map((agentId) => resolveAuth({ agentId }).copilotHome);
    expect(homes[0]).not.toBe(homes[1]);
    expect(homes).toEqual(
      ["agent-a", "agent-b"].map((id) =>
        resolve(join(FAKE_HOME, ".openclaw", "agents", id, "copilot")),
      ),
    );
  });

  it("explicit logged-in-user auth ignores explicit, contract and environment tokens", () => {
    stubTokens();
    expectLoggedIn({
      auth: { useLoggedInUser: true, gitHubToken: "ignored" },
      resolvedApiKey: "ignored",
      authProfileId: "p",
    });
  });

  it("accepts legacy top-level profileVersion + authProfileId fallbacks", () => {
    expect(
      resolveAuth({
        auth: { gitHubToken: "tok" },
        authProfileId: "legacy-p",
        profileVersion: "legacy-v1",
      }),
    ).toMatchObject({
      authMode: "gitHubToken",
      authProfileId: "legacy-p",
      authProfileVersion: "legacy-v1",
    });
  });

  it("requires both profileId and profileVersion for explicit tokens", () => {
    for (const auth of [
      { gitHubToken: "tok" },
      { gitHubToken: "tok", profileId: "p" },
      { gitHubToken: "tok", profileVersion: "v" },
    ]) {
      expect(() => resolveAuth({ auth })).toThrow(
        "[copilot-attempt] gitHubToken auth requires profileId+profileVersion (pool keying safety; per Q5/Q1 decisions)",
      );
    }
  });

  it("defaults to logged-in-user auth without an auth signal", () => {
    expectLoggedIn();
  });

  it.each([
    ["github-copilot:main", "github-copilot:main"],
    [undefined, "pi:resolved"],
  ])("fingerprints contract-resolved tokens with profile %j", (authProfileId, expected) => {
    stubTokens();
    expect(resolveAuth({ resolvedApiKey: "contract-token-xyz", authProfileId })).toMatchObject({
      authMode: "gitHubToken",
      gitHubToken: "contract-token-xyz",
      authProfileId: expected,
      authProfileVersion: tokenFingerprint("contract-token-xyz"),
    });
  });

  it("explicit auth wins over contract and environment tokens", () => {
    stubTokens();
    expect(
      resolveAuth({
        auth: { gitHubToken: "explicit", profileId: "p", profileVersion: "v1" },
        resolvedApiKey: "ignored",
        authProfileId: "ignored",
      }),
    ).toMatchObject({
      authMode: "gitHubToken",
      gitHubToken: "explicit",
      authProfileId: "p",
      authProfileVersion: "v1",
    });
  });

  it.each(tokenEnvs)("selects %s before lower-priority environment tokens", (name) => {
    stubTokens(tokenEnvs.slice(tokenEnvs.indexOf(name)));
    expect(resolveAuth({ authProfileId: "ignored" })).toMatchObject({
      authMode: "gitHubToken",
      gitHubToken: name,
      authProfileId: `env:${name}`,
      authProfileVersion: tokenFingerprint(name),
    });
  });

  it("token rotation in env changes the pool fingerprint", () => {
    vi.stubEnv("GITHUB_TOKEN", "v1");
    const first = resolveAuth();
    vi.stubEnv("GITHUB_TOKEN", "v2");
    expect(first.authProfileVersion).not.toBe(resolveAuth().authProfileVersion);
  });

  it("ignores empty-string env tokens", () => {
    for (const name of tokenEnvs) {
      vi.stubEnv(name, "");
    }
    expectLoggedIn();
  });
});
