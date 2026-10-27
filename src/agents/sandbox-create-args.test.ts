import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveSandboxBrowserDockerCreateConfig,
  resolveSandboxConfigForAgent,
} from "./sandbox/config.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./sandbox/constants.js";
import { buildSandboxCreateArgs } from "./sandbox/container-allocation.js";
import { collectDockerFlagValues as valuesForFlag } from "./sandbox/test-args.js";
import type { SandboxDockerConfig } from "./sandbox/types.js";

describe("buildSandboxCreateArgs", () => {
  afterEach(() => vi.restoreAllMocks());

  function createSandboxConfig(overrides: Partial<SandboxDockerConfig> = {}): SandboxDockerConfig {
    return {
      image: "openclaw-sandbox:trixie-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      ...overrides,
    };
  }

  function build(
    cfg: SandboxDockerConfig,
    bindSourceRoots?: string[],
    labels?: Record<string, string>,
  ) {
    return buildSandboxCreateArgs({
      name: "openclaw-sbx-test",
      cfg,
      scopeKey: "main",
      bindSourceRoots,
      labels,
    });
  }

  function expectFlags(args: string[], flags: Record<string, string[]>): void {
    for (const [flag, values] of Object.entries(flags)) {
      expect(valuesForFlag(args, flag)).toEqual(expect.arrayContaining(values));
    }
  }

  it.each([
    [undefined, undefined, "agent", "1024"],
    [256, undefined, "agent", "256"],
    [256, 512, "agent", "512"],
    [256, 512, "shared", "256"],
  ] as const)(
    "applies the resolved PID budget to tool and browser containers (%s, %s, %s)",
    (globalLimit, agentLimit, scope, expected) => {
      const config = resolveSandboxConfigForAgent(
        {
          agents: {
            defaults: { sandbox: { scope, docker: { pidsLimit: globalLimit } } },
            entries: { test: { sandbox: { docker: { pidsLimit: agentLimit } } } },
          },
        },
        "test",
      );
      for (const docker of [config.docker, resolveSandboxBrowserDockerCreateConfig(config)]) {
        expect(valuesForFlag(build(docker).argv, "--pids-limit")).toEqual([expected]);
      }
    },
  );

  it("includes hardening and resource flags", () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    const cfg = createSandboxConfig({
      readOnlyRoot: true,
      env: { LANG: "C.UTF-8" },
    });

    const { argv: args, env } = build(cfg, undefined, { "openclaw.sandboxBrowser": "1" });

    expect(args[0]).toBe("create");
    expectFlags(args, {
      "--name": ["openclaw-sbx-test"],
      "--label": [
        "openclaw.sandbox=1",
        "openclaw.sessionKey=main",
        "openclaw.createdAtMs=1700000000000",
        `openclaw.createArgsEpoch=${SANDBOX_DOCKER_CREATE_ARGS_EPOCH}`,
        "openclaw.sandboxBrowser=1",
      ],
      "--network": ["none"],
      "--security-opt": ["no-new-privileges"],
    });
    expect(args).toContain("--read-only");
    expect(args).not.toContain("--env");
    expect(env).toEqual({ LANG: "C.UTF-8", OPENCLAW_CLI: "1" });
  });

  it.each([
    [{ tmpfs: ["/tmp"] }, "--tmpfs", ["/tmp"]],
    [{ user: "1000:1000" }, "--user", ["1000:1000"]],
    [{ capDrop: ["ALL"] }, "--cap-drop", ["ALL"]],
    [{ memory: "512m" }, "--memory", ["512m"]],
    [{ memorySwap: 1024 }, "--memory-swap", ["1024"]],
    [{ cpus: 1.5 }, "--cpus", ["1.5"]],
    [{ gpus: "device=GPU-123" }, "--gpus", ["device=GPU-123"]],
    [{ seccompProfile: "/tmp/seccomp.json" }, "--security-opt", ["seccomp=/tmp/seccomp.json"]],
    [{ apparmorProfile: "openclaw-sandbox" }, "--security-opt", ["apparmor=openclaw-sandbox"]],
    [{ dns: ["1.1.1.1"] }, "--dns", ["1.1.1.1"]],
    [{ extraHosts: ["internal.service:10.0.0.5"] }, "--add-host", ["internal.service:10.0.0.5"]],
    [
      { ulimits: { nofile: { soft: 1024, hard: 2048 }, nproc: 128, core: "0" } },
      "--ulimit",
      ["nofile=1024:2048", "nproc=128", "core=0"],
    ],
  ] satisfies [Partial<SandboxDockerConfig>, string, string[]][])(
    "emits %j as %s",
    (config, flag, values) => {
      expectFlags(build(createSandboxConfig(config)).argv, { [flag]: values });
    },
  );

  const bindOverrides = [
    {
      key: "dangerouslyAllowExternalBindSources",
      bind: "/opt/external:/data:rw",
      roots: ["/tmp/workspace", "/tmp/agent"],
      error: /outside allowed roots/,
    },
    {
      key: "dangerouslyAllowReservedContainerTargets",
      bind: "/tmp/override:/workspace:rw",
      roots: undefined,
      error: /reserved container path/,
    },
  ] as const;
  it.each(bindOverrides)("requires $key for the bind override", ({ key, bind, roots, error }) => {
    expect(() => build(createSandboxConfig({ binds: [bind] }), roots && [...roots])).toThrow(error);
    const cfg = createSandboxConfig({ [key]: true, binds: [bind] });
    expect(() => build(cfg, roots && [...roots])).not.toThrow();
  });

  it("allows container namespace join with explicit dangerous override", () => {
    const cfg = createSandboxConfig({
      network: "container:peer",
      dangerouslyAllowContainerNamespaceJoin: true,
    });
    const { argv: args } = build(cfg);
    expectFlags(args, { "--network": ["container:peer"] });
  });
});
