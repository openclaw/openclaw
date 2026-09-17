// LIVE Linux (bubblewrap) enforcement tests for the SRT sandbox backend (S5).
//
// The macOS Seatbelt matrix (backend.test.ts, darwin-gated) proves the same
// guarantees under Seatbelt; this file re-runs the identical policy matrix under
// bwrap on a real Linux host (design v8 §5: "All on macOS and Linux"). The
// backend delegates every wrap to SandboxManager.wrapWithSandboxArgv, which on
// Linux emits a `bwrap` invocation — so what is asserted here is kernel-level
// mount-namespace / network-namespace enforcement, not JS-level checks.
//
//   AC-L2  filesystem: writes inside allowWrite succeed; writes/deletes outside
//          are denied BY THE KERNEL (the path is read-only bound or absent).
//   AC-L3  network: deny-all leaves only loopback in the sandbox netns; an
//          outbound connect fails. P0 limitation stated in the outcome comment.
//   argv   buildExecSpec emits a bwrap-wrapped argv (kernel wrapper in the argv).
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { createSrtSandboxBackendFactory, SRT_SANDBOX_BACKEND_ID } from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";

const isLinux = process.platform === "linux";

function makeParams(overrides: {
  workspaceDir: string;
  agentWorkspaceDir: string;
  workspaceAccess: "none" | "ro" | "rw";
}): CreateSandboxBackendParams {
  const cfg = {
    mode: "all",
    backend: SRT_SANDBOX_BACKEND_ID,
    scope: "session",
    workspaceAccess: overrides.workspaceAccess,
    workspaceRoot: overrides.workspaceDir,
    dockerTmpfsSource: "default",
    docker: { workdir: overrides.workspaceDir, env: {} },
    ssh: {},
    browser: {},
    tools: {},
    prune: {},
  } as unknown as CreateSandboxBackendParams["cfg"];
  return {
    sessionKey: "test-session",
    scopeKey: "test-scope-linux",
    workspaceDir: overrides.workspaceDir,
    agentWorkspaceDir: overrides.agentWorkspaceDir,
    cfg,
  };
}

describe.skipIf(!isLinux)("srt sandbox Linux bwrap filesystem matrix (AC-L2)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("confines writes to the specified directory while the rest stays read-only", async () => {
    const rwZone = mkdtempSync(path.join(tmpdir(), "srt-lx-rw-"));
    const roZone = mkdtempSync(path.join(tmpdir(), "srt-lx-ro-"));
    const agentDir = mkdtempSync(path.join(tmpdir(), "srt-lx-agent-"));
    cleanups.push(() => {
      rmSync(rwZone, { recursive: true, force: true });
      rmSync(roZone, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    });
    writeFileSync(path.join(rwZone, "seed.txt"), "seed-rw");
    writeFileSync(path.join(roZone, "seed.txt"), "seed-ro");

    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig(undefined),
    });
    const handle = await factory(
      makeParams({ workspaceDir: rwZone, agentWorkspaceDir: agentDir, workspaceAccess: "rw" }),
    );
    const run = (script: string) => handle.runShellCommand({ script, allowFailure: true });

    // A: write inside the writable zone → succeeds
    const a = await run(`printf written > ${rwZone}/w.txt`);
    expect(a.code).toBe(0);
    expect(readFileSync(path.join(rwZone, "w.txt"), "utf8")).toBe("written");

    // B: read inside the writable zone → succeeds
    const b = await run(`cat ${rwZone}/seed.txt`);
    expect(b.code).toBe(0);
    expect(b.stdout.toString("utf8").trim()).toBe("seed-rw");

    // C: read the read-only zone → allowed (reads are open)
    const c = await run(`cat ${roZone}/seed.txt`);
    expect(c.code).toBe(0);
    expect(c.stdout.toString("utf8").trim()).toBe("seed-ro");

    // D: write into the read-only zone → blocked by the kernel, file not created
    const d = await run(`printf nope > ${roZone}/blocked.txt`);
    expect(d.code).not.toBe(0);
    expect(existsSync(path.join(roZone, "blocked.txt"))).toBe(false);

    // E: read a system file → allowed
    const e = await run(`head -c 1 /etc/hostname`);
    expect(e.code).toBe(0);

    // F: write into a system directory → blocked by the kernel
    const f = await run(`printf nope > /etc/srt-sandbox-should-not-exist`);
    expect(f.code).not.toBe(0);
    expect(existsSync("/etc/srt-sandbox-should-not-exist")).toBe(false);

    // G: overwrite an existing read-only-zone file → blocked, content unchanged
    const g = await run(`printf overwritten > ${roZone}/seed.txt`);
    expect(g.code).not.toBe(0);
    expect(readFileSync(path.join(roZone, "seed.txt"), "utf8")).toBe("seed-ro");

    // H: delete a read-only-zone file → blocked, file remains
    const h = await run(`rm -f ${roZone}/seed.txt`);
    expect(h.code).not.toBe(0);
    expect(existsSync(path.join(roZone, "seed.txt"))).toBe(true);
  });

  it("blocks a symlink escape out of the writable zone at the kernel level", async () => {
    const rwZone = mkdtempSync(path.join(tmpdir(), "srt-lx-sym-rw-"));
    const roZone = mkdtempSync(path.join(tmpdir(), "srt-lx-sym-ro-"));
    const agentDir = mkdtempSync(path.join(tmpdir(), "srt-lx-sym-agent-"));
    cleanups.push(() => {
      rmSync(rwZone, { recursive: true, force: true });
      rmSync(roZone, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    });
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig(undefined),
    });
    const handle = await factory(
      makeParams({ workspaceDir: rwZone, agentWorkspaceDir: agentDir, workspaceAccess: "rw" }),
    );
    // A symlink inside the writable zone that points OUT of it must not become a
    // write channel: the target is read-only bound, so the write fails closed.
    const escape = await handle.runShellCommand({
      script: `ln -s ${roZone} ${rwZone}/escape && printf pwn > ${rwZone}/escape/pwn.txt`,
      allowFailure: true,
    });
    expect(escape.code).not.toBe(0);
    expect(existsSync(path.join(roZone, "pwn.txt"))).toBe(false);
  });
});

describe.skipIf(!isLinux)("srt sandbox Linux network deny-all (AC-L3)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("isolates the sandbox into a private (loopback-only routable) network namespace", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "srt-lx-net-"));
    const agentDir = mkdtempSync(path.join(tmpdir(), "srt-lx-net-agent-"));
    cleanups.push(() => {
      rmSync(ws, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    });
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig(undefined),
    });
    const handle = await factory(
      makeParams({ workspaceDir: ws, agentWorkspaceDir: agentDir, workspaceAccess: "rw" }),
    );

    // The deny-all posture maps to bwrap --unshare-net: a fresh network
    // namespace. /proc/net/dev reflects that namespace (unlike /sys/class/net,
    // which mirrors the read-only-bound host sysfs). Loopback is present; the
    // host's routable NICs (eth*) are NOT — the sandbox sees a distinct netns.
    const ifaces = await handle.runShellCommand({
      script: `awk -F: 'NR>2 {gsub(/ /,"",$1); print $1}' /proc/net/dev | sort | tr '\\n' ' '`,
      allowFailure: true,
    });
    expect(ifaces.code).toBe(0);
    const names = ifaces.stdout.toString("utf8").trim();
    expect(names.split(/\s+/)).toContain("lo");
    expect(names).not.toMatch(/\beth\d/);

    // The decisive check: no route leaves the namespace — an outbound TCP
    // connect fails with the kernel's ENETUNREACH ("Network is unreachable").
    const connect = await handle.runShellCommand({
      script: `if timeout 3 bash -c 'exec 3<>/dev/tcp/8.8.8.8/53' 2>/dev/null; then echo CONNECTED; else echo BLOCKED; fi`,
      allowFailure: true,
    });
    expect(connect.code).toBe(0);
    expect(connect.stdout.toString("utf8")).toContain("BLOCKED");
  });
});

describe.skipIf(!isLinux)("srt sandbox Linux buildExecSpec (bwrap wrapper in argv)", () => {
  it("wraps the command with bwrap so kernel enforcement is in the spawned argv", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "srt-lx-exec-"));
    const agentDir = mkdtempSync(path.join(tmpdir(), "srt-lx-exec-agent-"));
    mkdirSync(ws, { recursive: true });
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig(undefined),
    });
    const handle = await factory(
      makeParams({ workspaceDir: ws, agentWorkspaceDir: agentDir, workspaceAccess: "rw" }),
    );
    const spec = await handle.buildExecSpec({
      command: "true",
      env: { PATH: process.env.PATH ?? "" },
      usePty: false,
    });
    expect(spec.argv.length).toBeGreaterThanOrEqual(3);
    expect(spec.argv.join(" ")).toContain("bwrap");
    expect(spec.stdinMode).toBe("pipe-open");
    expect(spec.cwd).toBe(ws);
  });
});
