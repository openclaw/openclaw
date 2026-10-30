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
    expect(resolved.ulimits).toEqual({ nofile: { soft: 10, hard: 20 }, nproc: 256 });
  });

  it("resolves docker binds and shared-scope override behavior", () => {
    // Shared scope intentionally ignores agent-specific Docker overrides.
    const globalBind = "/var/run/docker.sock:/var/run/docker.sock";
    const agentBind = "/home/user/source:/source:rw";
    for (const [scope, globalBinds, agentBinds, expected] of [
      ["agent", [globalBind], [agentBind], [globalBind, agentBind]],
      ["agent", undefined, undefined, undefined],
      ["shared", [globalBind], [agentBind], [globalBind]],
    ] as const) {
      expect(
        resolve(
          { scope, docker: { binds: globalBinds && [...globalBinds] } },
          { docker: { binds: agentBinds && [...agentBinds] } },
        ).docker.binds,
      ).toEqual(expected);
    }
    expect(
      resolve({ scope: "shared", docker: { image: "global" } }, { docker: { image: "agent" } })
        .docker.image,
    ).toBe("global");
  });

  it("applies per-agent browser and prune overrides (ignored under shared scope)", () => {
    const browser = { enabled: false, headless: false, noVncEnabled: true };
    const agentBrowser = { enabled: true, headless: true, noVncEnabled: false };
    const prune = { idleHours: 24, maxAgeDays: 7 };
    const agentPrune = { idleHours: 0, maxAgeDays: 1 };
    for (const scope of ["agent", "shared"] as const) {
      const resolved = resolve(
        { scope, browser, prune },
        { browser: agentBrowser, prune: agentPrune },
      );
      expect(resolved.browser).toMatchObject(scope === "agent" ? agentBrowser : browser);
      expect(resolved.prune).toEqual(scope === "agent" ? agentPrune : prune);
    }
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
    expect(ssh).toMatchObject({
      target: "agent@example.com:2222",
      command: "ssh",
      identityFile: "~/.ssh/global",
      certificateFile: "~/.ssh/agent-cert.pub",
      strictHostKeyChecking: false,
    });

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
