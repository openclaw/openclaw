import { describe, expect, it } from "vitest";
import { buildBwrapArgs, buildBwrapFsBridgeArgs, resolveBwrapConfig } from "./bwrap.js";
import type { SandboxBwrapConfig } from "./types.bwrap.js";

function createDefaultBwrapConfig(overrides?: Partial<SandboxBwrapConfig>): SandboxBwrapConfig {
  return {
    workdir: "/workspace",
    readOnlyRoot: true,
    tmpfs: ["/tmp", "/var/tmp", "/run"],
    unshareNet: true,
    unsharePid: true,
    unshareIpc: true,
    unshareCgroup: false,
    newSession: true,
    dieWithParent: true,
    mountProc: true,
    ...overrides,
  };
}

describe("buildBwrapArgs", () => {
  it("builds basic namespace isolation args", () => {
    const cfg = createDefaultBwrapConfig();
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/home/user/project",
      workspaceAccess: "rw",
      command: "echo hello",
    });

    // Should contain namespace flags
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--unshare-ipc");
    expect(args).not.toContain("--unshare-cgroup");

    // Should contain security flags
    expect(args).toContain("--new-session");
    expect(args).toContain("--die-with-parent");

    // Should mount workspace rw
    const bindIdx = args.indexOf("--bind");
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(args[bindIdx + 1]).toBe("/home/user/project");
    expect(args[bindIdx + 2]).toBe("/workspace");

    // Should contain proc and dev
    expect(args).toContain("--proc");
    expect(args).toContain("--dev");

    // Should end with command
    const dashDashIdx = args.indexOf("--");
    expect(dashDashIdx).toBeGreaterThan(0);
    expect(args[dashDashIdx + 1]).toBe("sh");
    expect(args[dashDashIdx + 2]).toBe("-c");
    expect(args[dashDashIdx + 3]).toBe("echo hello");
  });

  it("mounts workspace read-only when workspaceAccess is ro", () => {
    const cfg = createDefaultBwrapConfig();
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/home/user/project",
      workspaceAccess: "ro",
      command: "ls",
    });

    const roBindIdx = args.findIndex(
      (a, i) => a === "--ro-bind" && args[i + 1] === "/home/user/project",
    );
    expect(roBindIdx).toBeGreaterThanOrEqual(0);
    expect(args[roBindIdx + 2]).toBe("/workspace");
  });

  it("uses --bind for rootBinds when readOnlyRoot is false", () => {
    const cfg = createDefaultBwrapConfig({ readOnlyRoot: false });
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "ls",
    });

    // Root bind paths that exist should use --bind, not --ro-bind
    const rootPaths = ["/usr", "/bin", "/lib", "/etc"].filter((p) => args.includes(p));
    for (const rp of rootPaths) {
      // Pattern: --bind <hostPath> <hostPath>
      const idx = args.findIndex(
        (a, i) => a === "--bind" && args[i + 1] === rp && args[i + 2] === rp,
      );
      expect(idx, `expected --bind ${rp} ${rp}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses --ro-bind for rootBinds when readOnlyRoot is true (default)", () => {
    const cfg = createDefaultBwrapConfig({ readOnlyRoot: true });
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "ls",
    });

    const rootPaths = ["/usr", "/bin", "/lib", "/etc"].filter((p) => args.includes(p));
    for (const rp of rootPaths) {
      const idx = args.findIndex(
        (a, i) => a === "--ro-bind" && args[i + 1] === rp && args[i + 2] === rp,
      );
      expect(idx, `expected --ro-bind ${rp} ${rp}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not mount workspace when workspaceAccess is none", () => {
    const cfg = createDefaultBwrapConfig();
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/home/user/project",
      workspaceAccess: "none",
      command: "ls",
    });

    // Should not have /home/user/project bound
    expect(args.filter((a) => a === "/home/user/project")).toHaveLength(0);
  });

  it("creates tmpfs at workdir when workspaceAccess is none", () => {
    const cfg = createDefaultBwrapConfig();
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/home/user/project",
      workspaceAccess: "none",
      command: "pwd",
    });

    // A tmpfs at /workspace should ensure --chdir works
    const tmpfsIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === "--tmpfs" && args[i + 1] === "/workspace") {
        acc.push(i);
      }
      return acc;
    }, []);
    expect(tmpfsIndices.length).toBeGreaterThanOrEqual(1);

    // --chdir should still point to the workdir
    const chdirIdx = args.indexOf("--chdir");
    expect(args[chdirIdx + 1]).toBe("/workspace");
  });

  it("creates tmpfs mounts from config", () => {
    const cfg = createDefaultBwrapConfig({ tmpfs: ["/tmp", "/run"] });
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "ls",
    });

    const tmpfsIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === "--tmpfs") {
        acc.push(i);
      }
      return acc;
    }, []);
    expect(tmpfsIndices.length).toBe(2);
    expect(args[tmpfsIndices[0] + 1]).toBe("/tmp");
    expect(args[tmpfsIndices[1] + 1]).toBe("/run");
  });

  it("sets environment with --clearenv and --setenv", () => {
    const cfg = createDefaultBwrapConfig({ env: { MY_VAR: "hello" } });
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "env",
    });

    expect(args).toContain("--clearenv");

    // Should set default vars
    const setenvIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === "--setenv") {
        acc.push(i);
      }
      return acc;
    }, []);
    const envPairs = setenvIndices.map((i) => [args[i + 1], args[i + 2]]);
    expect(envPairs).toContainEqual(["HOME", "/workspace"]);
    expect(envPairs).toContainEqual(["MY_VAR", "hello"]);
    expect(envPairs).toContainEqual(["LANG", "C.UTF-8"]);
  });

  it("merges per-invocation env over config env", () => {
    const cfg = createDefaultBwrapConfig({ env: { A: "from-config" } });
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "env",
      env: { A: "from-invocation", B: "extra" },
    });

    const setenvIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === "--setenv") {
        acc.push(i);
      }
      return acc;
    }, []);
    const envPairs = setenvIndices.map((i) => [args[i + 1], args[i + 2]]);
    // Per-invocation env should win
    expect(envPairs).toContainEqual(["A", "from-invocation"]);
    expect(envPairs).toContainEqual(["B", "extra"]);
    expect(envPairs.filter(([k]) => k === "A")).toHaveLength(1);
  });

  it("sets workdir via --chdir", () => {
    const cfg = createDefaultBwrapConfig();
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "pwd",
      workdir: "/workspace/subdir",
    });

    const chdirIdx = args.indexOf("--chdir");
    expect(chdirIdx).toBeGreaterThanOrEqual(0);
    expect(args[chdirIdx + 1]).toBe("/workspace/subdir");
  });

  it("defaults --chdir to cfg.workdir when no workdir given", () => {
    const cfg = createDefaultBwrapConfig({ workdir: "/myworkspace" });
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "pwd",
    });

    const chdirIdx = args.indexOf("--chdir");
    expect(args[chdirIdx + 1]).toBe("/myworkspace");
  });

  it("handles extraBinds with rw and ro modes", () => {
    const cfg = createDefaultBwrapConfig({
      extraBinds: ["/data:/container-data:rw", "/secrets:/container-secrets"],
    });
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "ls",
    });

    // /data should be --bind (writable)
    const bindDataIdx = args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/data");
    expect(bindDataIdx).toBeGreaterThanOrEqual(0);
    expect(args[bindDataIdx + 2]).toBe("/container-data");

    // /secrets should be --ro-bind (read-only, no :rw suffix)
    const roBindSecretsIdx = args.findIndex(
      (a, i) => a === "--ro-bind" && args[i + 1] === "/secrets",
    );
    expect(roBindSecretsIdx).toBeGreaterThanOrEqual(0);
    expect(args[roBindSecretsIdx + 2]).toBe("/container-secrets");
  });

  it("skips network unsharing when unshareNet is false", () => {
    const cfg = createDefaultBwrapConfig({ unshareNet: false });
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "curl example.com",
    });

    expect(args).not.toContain("--unshare-net");
  });

  it("enables cgroup unsharing when configured", () => {
    const cfg = createDefaultBwrapConfig({ unshareCgroup: true });
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "ls",
    });

    expect(args).toContain("--unshare-cgroup");
  });

  it("mounts /proc by default", () => {
    const cfg = createDefaultBwrapConfig();
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "ls",
    });

    expect(args).toContain("--proc");
  });

  it("skips /proc mount when mountProc is false", () => {
    const cfg = createDefaultBwrapConfig({ mountProc: false });
    const args = buildBwrapArgs({
      cfg,
      workspaceDir: "/w",
      workspaceAccess: "rw",
      command: "ls",
    });

    expect(args).not.toContain("--proc");
    // /dev should still be mounted
    expect(args).toContain("--dev");
  });
});

describe("buildBwrapFsBridgeArgs", () => {
  it("produces args ending with script and positional args", () => {
    const cfg = createDefaultBwrapConfig();
    const args = buildBwrapFsBridgeArgs({
      cfg,
      workspaceDir: "/home/user/project",
      workspaceAccess: "rw",
      script: 'set -eu; cat -- "$1"',
      scriptArgs: ["/workspace/file.txt"],
    });

    // Should end with: "--", "sh", "-c", <script>, "bwrap-fs", <path>
    const dashDashIdx = args.indexOf("--");
    expect(args[dashDashIdx + 1]).toBe("sh");
    expect(args[dashDashIdx + 2]).toBe("-c");
    expect(args[dashDashIdx + 3]).toBe('set -eu; cat -- "$1"');
    expect(args[dashDashIdx + 4]).toBe("bwrap-fs");
    expect(args[dashDashIdx + 5]).toBe("/workspace/file.txt");
  });

  it("works without scriptArgs", () => {
    const cfg = createDefaultBwrapConfig();
    const args = buildBwrapFsBridgeArgs({
      cfg,
      workspaceDir: "/home/user/project",
      workspaceAccess: "rw",
      script: "set -eu; ls /workspace",
    });

    // Should end with: "--", "sh", "-c", <script>
    const dashDashIdx = args.indexOf("--");
    expect(args.slice(dashDashIdx)).toEqual(["--", "sh", "-c", "set -eu; ls /workspace"]);
  });
});

describe("resolveBwrapConfig", () => {
  it("returns sensible defaults with no input", () => {
    const cfg = resolveBwrapConfig({});
    expect(cfg.workdir).toBe("/workspace");
    expect(cfg.readOnlyRoot).toBe(true);
    expect(cfg.unshareNet).toBe(true);
    expect(cfg.unsharePid).toBe(true);
    expect(cfg.unshareIpc).toBe(true);
    expect(cfg.unshareCgroup).toBe(false);
    expect(cfg.newSession).toBe(true);
    expect(cfg.dieWithParent).toBe(true);
    expect(cfg.mountProc).toBe(true);
    expect(cfg.tmpfs).toEqual(["/tmp", "/var/tmp", "/run"]);
    expect(cfg.env).toEqual({ LANG: "C.UTF-8" });
  });

  it("merges agent over global config", () => {
    const cfg = resolveBwrapConfig({
      globalBwrap: {
        workdir: "/global-workspace",
        unshareNet: false,
        env: { A: "global" },
        extraBinds: ["/shared:/shared"],
      },
      agentBwrap: {
        workdir: "/agent-workspace",
        env: { B: "agent" },
        extraBinds: ["/agent-data:/data"],
      },
    });

    // Agent overrides global for scalar fields
    expect(cfg.workdir).toBe("/agent-workspace");
    // Agent env merges with global env
    expect(cfg.env).toEqual({ A: "global", B: "agent" });
    // Extra binds are concatenated
    expect(cfg.extraBinds).toEqual(["/shared:/shared", "/agent-data:/data"]);
    // Unset agent fields fall back to global
    expect(cfg.unshareNet).toBe(false);
  });

  it("agent scalar fields take precedence over global", () => {
    const cfg = resolveBwrapConfig({
      globalBwrap: { unsharePid: true, newSession: true },
      agentBwrap: { unsharePid: false, newSession: false },
    });

    expect(cfg.unsharePid).toBe(false);
    expect(cfg.newSession).toBe(false);
  });
});
