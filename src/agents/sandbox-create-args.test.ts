import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./sandbox/constants.js";
import { buildSandboxCreateArgs } from "./sandbox/docker.js";
import type { SandboxDockerConfig } from "./sandbox/types.js";

describe("buildSandboxCreateArgs", () => {
  afterEach(() => vi.restoreAllMocks());

  function createSandboxConfig(
    overrides: Partial<SandboxDockerConfig> = {},
    binds?: string[],
  ): SandboxDockerConfig {
    return {
      image: "openclaw-sandbox:trixie-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      ...(binds ? { binds } : {}),
      ...overrides,
    };
  }

  function build(cfg: SandboxDockerConfig, bindSourceRoots?: string[]) {
    return buildSandboxCreateArgs({
      name: "openclaw-sbx-test",
      cfg,
      scopeKey: "main",
      bindSourceRoots,
    });
  }

  function valuesForFlag(args: string[], flag: string): string[] {
    return args.flatMap((arg, index) => {
      const value = args[index + 1];
      return arg === flag && value ? [value] : [];
    });
  }

  function expectFlagValues(args: string[], flag: string, expectedValues: string[]): void {
    expect(valuesForFlag(args, flag)).toEqual(expect.arrayContaining(expectedValues));
  }

  it("includes hardening and resource flags", () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    const cfg = createSandboxConfig({
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      user: "1000:1000",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
      pidsLimit: 256,
      memory: "512m",
      memorySwap: 1024,
      cpus: 1.5,
      ulimits: {
        nofile: { soft: 1024, hard: 2048 },
        nproc: 128,
        core: "0",
      },
      seccompProfile: "/tmp/seccomp.json",
      apparmorProfile: "openclaw-sandbox",
      dns: ["1.1.1.1"],
      extraHosts: ["internal.service:10.0.0.5"],
    });

    const { argv: args, env } = buildSandboxCreateArgs({
      name: "openclaw-sbx-test",
      cfg,
      scopeKey: "main",
      labels: { "openclaw.sandboxBrowser": "1" },
    });

    expect(args[0]).toBe("create");
    expectFlagValues(args, "--name", ["openclaw-sbx-test"]);
    expectFlagValues(args, "--label", [
      "openclaw.sandbox=1",
      "openclaw.sessionKey=main",
      "openclaw.createdAtMs=1700000000000",
      `openclaw.createArgsEpoch=${SANDBOX_DOCKER_CREATE_ARGS_EPOCH}`,
      "openclaw.sandboxBrowser=1",
    ]);
    expect(args).toContain("--read-only");
    expectFlagValues(args, "--tmpfs", ["/tmp"]);
    expectFlagValues(args, "--network", ["none"]);
    expectFlagValues(args, "--user", ["1000:1000"]);
    expectFlagValues(args, "--cap-drop", ["ALL"]);
    expectFlagValues(args, "--security-opt", [
      "no-new-privileges",
      "seccomp=/tmp/seccomp.json",
      "apparmor=openclaw-sandbox",
    ]);
    expectFlagValues(args, "--dns", ["1.1.1.1"]);
    expectFlagValues(args, "--add-host", ["internal.service:10.0.0.5"]);
    expectFlagValues(args, "--pids-limit", ["256"]);
    expectFlagValues(args, "--memory", ["512m"]);
    expectFlagValues(args, "--memory-swap", ["1024"]);
    expectFlagValues(args, "--cpus", ["1.5"]);
    expect(args).not.toContain("--env");
    expect(env).toEqual({ LANG: "C.UTF-8", OPENCLAW_CLI: "1" });
    expectFlagValues(args, "--ulimit", ["nofile=1024:2048", "nproc=128", "core=0"]);
  });

  it("emits Docker GPU passthrough as a separate argument", () => {
    const { argv: args } = build(createSandboxConfig({ gpus: "device=GPU-123" }));

    expectFlagValues(args, "--gpus", ["device=GPU-123"]);
  });

  it.each<[string, SandboxDockerConfig, RegExp]>([
    [
      "Docker socket bind",
      createSandboxConfig({}, ["/var/run/docker.sock:/var/run/docker.sock"]),
      /blocked path/,
    ],
    ["Docker socket ancestor bind", createSandboxConfig({}, ["/var:/var"]), /covers blocked path/],
    ["host networking", createSandboxConfig({ network: "host" }), /network mode "host" is blocked/],
    [
      "container namespace",
      createSandboxConfig({ network: "container:peer" }),
      /network mode "container:peer" is blocked by default/,
    ],
    [
      "seccomp unconfined",
      createSandboxConfig({ seccompProfile: "unconfined" }),
      /seccomp profile "unconfined" is blocked/,
    ],
    [
      "apparmor unconfined",
      createSandboxConfig({ apparmorProfile: "unconfined" }),
      /apparmor profile "unconfined" is blocked/,
    ],
  ])("throws on %s", (_name, cfg, expected) => {
    expect(() => build(cfg)).toThrow(expected);
  });

  it("blocks bind sources outside runtime allowlist roots", () => {
    const cfg = createSandboxConfig({}, ["/opt/external:/data:rw"]);
    expect(() => build(cfg, ["/tmp/workspace", "/tmp/agent"])).toThrow(/outside allowed roots/);
  });

  it("allows bind sources outside runtime allowlist with explicit dangerous config", () => {
    const cfg = createSandboxConfig({ dangerouslyAllowExternalBindSources: true }, [
      "/opt/external:/data:rw",
    ]);
    expect(() => build(cfg, ["/tmp/workspace", "/tmp/agent"])).not.toThrow();
  });

  it("blocks reserved /workspace target bind mounts by default", () => {
    const cfg = createSandboxConfig({}, ["/tmp/override:/workspace:rw"]);
    expect(() => build(cfg)).toThrow(/reserved container path/);
  });

  it("allows reserved /workspace target bind mounts with explicit dangerous config", () => {
    const cfg = createSandboxConfig({ dangerouslyAllowReservedContainerTargets: true }, [
      "/tmp/override:/workspace:rw",
    ]);
    expect(() => build(cfg)).not.toThrow();
  });

  it("allows container namespace join with explicit dangerous override", () => {
    const cfg = createSandboxConfig({
      network: "container:peer",
      dangerouslyAllowContainerNamespaceJoin: true,
    });
    const { argv: args } = build(cfg);
    expectFlagValues(args, "--network", ["container:peer"]);
  });
});
