// Verifies sandbox config merge precedence across global, agent, and shared scopes.
import { describe, expect, it } from "vitest";
import type { AgentSandboxConfig } from "../config/types.agents-shared.js";
import { resolveSandboxConfigForAgent, resolveSandboxScope } from "./sandbox/config.js";

function resolve(defaults: AgentSandboxConfig, agent: AgentSandboxConfig = {}) {
  return resolveSandboxConfigForAgent(
    { agents: { defaults: { sandbox: defaults }, entries: { test: { sandbox: agent } } } },
    "test",
  );
}

describe("sandbox config merges", () => {
  it("resolves sandbox scope deterministically", () => {
    expect(resolveSandboxScope({})).toBe("agent");
    expect(resolveSandboxScope({ scope: "session" })).toBe("session");
    expect(resolveSandboxScope({ scope: "shared" })).toBe("shared");
    expect(resolveSandboxScope({ scope: "agent" })).toBe("agent");
  });

  it("merges sandbox docker env and ulimits (agent wins)", () => {
    const resolved = resolve(
      {
        scope: "agent",
        docker: {
          env: { LANG: "C.UTF-8", FOO: "1" },
          ulimits: { nofile: { soft: 10, hard: 20 } },
        },
      },
      { docker: { env: { FOO: "2", BAR: "3" }, ulimits: { nproc: 256 } } },
    ).docker;

    expect(resolved.env).toEqual({ LANG: "C.UTF-8", FOO: "2", BAR: "3" });
    expect(resolved.ulimits).toEqual({
      nofile: { soft: 10, hard: 20 },
      nproc: 256,
    });
  });

  it("resolves docker binds and shared-scope override behavior", () => {
    // Shared scope intentionally ignores agent-specific Docker overrides.
    for (const scenario of [
      {
        name: "merges sandbox docker binds (global + agent combined)",
        defaults: {
          scope: "agent" as const,
          docker: {
            binds: ["/var/run/docker.sock:/var/run/docker.sock"],
          },
        },
        agent: {
          docker: {
            binds: ["/home/user/source:/source:rw"],
          },
        },
        assert: (resolved: ReturnType<typeof resolveSandboxConfigForAgent>["docker"]) => {
          expect(resolved.binds).toEqual([
            "/var/run/docker.sock:/var/run/docker.sock",
            "/home/user/source:/source:rw",
          ]);
        },
      },
      {
        name: "returns undefined binds when neither global nor agent has binds",
        defaults: {
          scope: "agent" as const,
          docker: {},
        },
        agent: { docker: {} },
        assert: (resolved: ReturnType<typeof resolveSandboxConfigForAgent>["docker"]) => {
          expect(resolved.binds).toBeUndefined();
        },
      },
      {
        name: "ignores agent binds under shared scope",
        defaults: {
          scope: "shared" as const,
          docker: {
            binds: ["/var/run/docker.sock:/var/run/docker.sock"],
          },
        },
        agent: {
          docker: {
            binds: ["/home/user/source:/source:rw"],
          },
        },
        assert: (resolved: ReturnType<typeof resolveSandboxConfigForAgent>["docker"]) => {
          expect(resolved.binds).toEqual(["/var/run/docker.sock:/var/run/docker.sock"]);
        },
      },
      {
        name: "ignores agent docker overrides under shared scope",
        defaults: {
          scope: "shared" as const,
          docker: { image: "global" },
        },
        agent: { docker: { image: "agent" } },
        assert: (resolved: ReturnType<typeof resolveSandboxConfigForAgent>["docker"]) => {
          expect(resolved.image).toBe("global");
        },
      },
    ]) {
      const resolved = resolve(scenario.defaults, scenario.agent).docker;
      scenario.assert(resolved);
    }
  });

  it("applies per-agent browser and prune overrides (ignored under shared scope)", () => {
    const browser = resolve(
      { scope: "agent", browser: { enabled: false, headless: false, noVncEnabled: true } },
      { browser: { enabled: true, headless: true, noVncEnabled: false } },
    ).browser;
    expect(browser.enabled).toBe(true);
    expect(browser.headless).toBe(true);
    expect(browser.noVncEnabled).toBe(false);

    const prune = resolve(
      { scope: "agent", prune: { idleHours: 24, maxAgeDays: 7 } },
      { prune: { idleHours: 0, maxAgeDays: 1 } },
    ).prune;
    expect(prune).toEqual({ idleHours: 0, maxAgeDays: 1 });

    const browserShared = resolve(
      { scope: "shared", browser: { enabled: false } },
      { browser: { enabled: true } },
    ).browser;
    expect(browserShared.enabled).toBe(false);

    const pruneShared = resolve(
      { scope: "shared", prune: { idleHours: 24, maxAgeDays: 7 } },
      { prune: { idleHours: 0, maxAgeDays: 1 } },
    ).prune;
    expect(pruneShared).toEqual({ idleHours: 24, maxAgeDays: 7 });
  });

  it("merges sandbox ssh settings and ignores agent overrides under shared scope", () => {
    const ssh = resolve(
      {
        scope: "agent",
        ssh: {
          target: "global@example.com:22",
          command: "ssh",
          identityFile: "~/.ssh/global",
          strictHostKeyChecking: true,
        },
      },
      {
        ssh: {
          target: "agent@example.com:2222",
          certificateFile: "~/.ssh/agent-cert.pub",
          strictHostKeyChecking: false,
        },
      },
    ).ssh;
    expect(ssh.target).toBe("agent@example.com:2222");
    expect(ssh.command).toBe("ssh");
    expect(ssh.identityFile).toBe("~/.ssh/global");
    expect(ssh.certificateFile).toBe("~/.ssh/agent-cert.pub");
    expect(ssh.strictHostKeyChecking).toBe(false);

    const sshShared = resolve(
      { scope: "shared", ssh: { target: "global@example.com:22" } },
      { ssh: { target: "agent@example.com:2222" } },
    ).ssh;
    expect(sshShared.target).toBe("global@example.com:22");
  });

  it("defaults sandbox backend to docker", () => {
    expect(resolveSandboxConfigForAgent().backend).toBe("docker");
  });
});
