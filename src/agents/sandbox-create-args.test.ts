import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./sandbox/constants.js";
import { buildSandboxCreateArgs } from "./sandbox/docker.js";
import type { SandboxDockerConfig } from "./sandbox/types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

  function expectFlags(args: string[], flags: Record<string, string[]>): void {
    for (const [flag, values] of Object.entries(flags)) {
      expect(valuesForFlag(args, flag)).toEqual(expect.arrayContaining(values));
    }
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
    expectFlags(args, {
      "--name": ["openclaw-sbx-test"],
      "--label": [
        "openclaw.sandbox=1",
        "openclaw.sessionKey=main",
        "openclaw.createdAtMs=1700000000000",
        `openclaw.createArgsEpoch=${SANDBOX_DOCKER_CREATE_ARGS_EPOCH}`,
        "openclaw.sandboxBrowser=1",
      ],
      "--tmpfs": ["/tmp"],
      "--network": ["none"],
      "--user": ["1000:1000"],
      "--cap-drop": ["ALL"],
      "--security-opt": [
        "no-new-privileges",
        "seccomp=/tmp/seccomp.json",
        "apparmor=openclaw-sandbox",
      ],
      "--dns": ["1.1.1.1"],
      "--add-host": ["internal.service:10.0.0.5"],
      "--pids-limit": ["256"],
      "--memory": ["512m"],
      "--memory-swap": ["1024"],
      "--cpus": ["1.5"],
      "--ulimit": ["nofile=1024:2048", "nproc=128", "core=0"],
    });
    expect(args).toContain("--read-only");
    expect(args).not.toContain("--env");
    expect(env).toEqual({ LANG: "C.UTF-8", OPENCLAW_CLI: "1" });
  });

  it("emits Docker GPU passthrough as a separate argument", () => {
    const { argv: args } = build(createSandboxConfig({ gpus: "device=GPU-123" }));

    expectFlags(args, { "--gpus": ["device=GPU-123"] });
  });

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
  it.each(bindOverrides)("blocks binds without $key", ({ bind, roots, error }) => {
    expect(() => build(createSandboxConfig({}, [bind]), roots && [...roots])).toThrow(error);
  });
  it.each(bindOverrides)("allows binds with $key", ({ key, bind, roots }) => {
    const cfg = createSandboxConfig({ [key]: true }, [bind]);
    expect(() => build(cfg, roots && [...roots])).not.toThrow();
  });

  describe("allowedBindSources", () => {
    const ownRoots = ["/tmp/workspace", "/tmp/agent"];
    function buildWithOwnRoots(name: string, cfg: SandboxDockerConfig) {
      return buildSandboxCreateArgs({
        name,
        cfg,
        scopeKey: "main",
        bindSourceRoots: ownRoots,
      });
    }

    it("admits a bind under a configured root with no dangerous override", () => {
      const cfg = createSandboxConfig({ allowedBindSources: ["/srv/shared"] }, [
        "/srv/shared/team:/team:rw",
      ]);
      expect(cfg.dangerouslyAllowExternalBindSources).toBeUndefined();
      expect(() => buildWithOwnRoots("openclaw-sbx-allowlisted", cfg)).not.toThrow();
    });

    it("keeps every non-allowlisted source blocked while an allowlist is in force", () => {
      const cfg = createSandboxConfig({ allowedBindSources: ["/srv/shared"] }, [
        "/opt/external:/data:rw",
      ]);
      expect(() => buildWithOwnRoots("openclaw-sbx-allowlist-other", cfg)).toThrow(
        /outside allowed roots.*allowedBindSources/,
      );
    });

    it("leaves the gate off when the caller supplies no roots at all", () => {
      const cfg = createSandboxConfig({ allowedBindSources: ["/srv/shared"] }, [
        "/opt/external:/data:rw",
      ]);
      expect(() =>
        buildSandboxCreateArgs({
          name: "openclaw-sbx-gate-off",
          cfg,
          scopeKey: "main",
        }),
      ).not.toThrow();
    });

    it("rejects a configured filesystem root at the runtime boundary", () => {
      const cfg = createSandboxConfig({ allowedBindSources: ["/srv/.."] }, [
        "/srv/shared/team:/team:rw",
      ]);
      expect(() => buildWithOwnRoots("openclaw-sbx-root-allowlist", cfg)).toThrow(
        /names a filesystem root/,
      );
    });

    it.skipIf(process.platform === "win32")(
      "rejects a configured root whose canonical path is the filesystem root",
      () => {
        const rootAlias = path.join(tempDirs.make("bind-root-alias-"), "root");
        fs.symlinkSync("/", rootAlias, "dir");
        const cfg = createSandboxConfig({ allowedBindSources: [rootAlias] }, [
          "/srv/shared/team:/team:rw",
        ]);
        expect(() => buildWithOwnRoots("openclaw-sbx-root-alias", cfg)).toThrow(
          /resolves to filesystem root/,
        );
      },
    );
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
