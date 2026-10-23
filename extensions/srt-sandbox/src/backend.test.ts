// Tests for the SRT sandbox backend (S1).
//
// Three concerns:
//  1. Registration self-verify — the backend registers via
//     registerSandboxBackend() and resolves through getSandboxBackendFactory().
//  2. macOS Seatbelt minimal path — reproduces the eight-case permission matrix
//     (specified directory writable, everything else read-only). Gated to
//     darwin; on other platforms the backend fails closed by design.
//  3. Deferred exec specs — the spec returned by buildExecSpec is launched the
//     way the core exec runtime launches it, and its effects are checked on
//     disk (darwin and Linux hosts with the sandbox toolchain).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getSandboxBackendFactory,
  registerSandboxBackend,
  type CreateSandboxBackendParams,
  type SandboxBackendHandle,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSrtSandboxBackendFactory,
  createSrtSandboxBackendManager,
  resolveSrtSandboxWorkdir,
  shutdownSrtSandboxRuntime,
  SRT_SANDBOX_BACKEND_ID,
} from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";
import { isSrtSandboxAvailable } from "./sandbox-availability.test-helpers.js";

const isDarwin = process.platform === "darwin";
const isLive = (isDarwin || process.platform === "linux") && (await isSrtSandboxAvailable());

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
    scopeKey: "test-scope",
    workspaceDir: overrides.workspaceDir,
    agentWorkspaceDir: overrides.agentWorkspaceDir,
    cfg,
  };
}

/** Launch a deferred exec spec as the core exec runtime does, then finalize it. */
async function launchExecSpec(
  handle: SandboxBackendHandle,
  command: string,
): Promise<{ code: number | null }> {
  const cleanup = handle.prepareProcessCleanup!({ PATH: process.env.PATH ?? "" });
  const spec = await handle.buildExecSpec({ command, env: cleanup.env, usePty: false });
  expect(() => spec.assertCurrent?.()).not.toThrow();
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
    env: spec.env,
    cwd: spec.cwd,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end();
  const [code] = (await once(child, "exit")) as [number | null];
  await handle.finalizeExec?.({
    status: code === 0 ? "completed" : "failed",
    exitCode: code,
    timedOut: false,
    token: spec.finalizeToken,
  });
  return { code };
}

describe("srt sandbox backend registration", () => {
  const disposers: Array<() => void> = [];
  afterEach(async () => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
    await shutdownSrtSandboxRuntime();
  });

  it("registers and resolves via getSandboxBackendFactory", () => {
    const pluginConfig = resolveSrtPluginConfig(undefined);
    const restore = registerSandboxBackend(SRT_SANDBOX_BACKEND_ID, {
      factory: createSrtSandboxBackendFactory({ pluginConfig }),
      manager: createSrtSandboxBackendManager(),
      resolveWorkdir: resolveSrtSandboxWorkdir,
    });
    disposers.push(restore);
    const factory = getSandboxBackendFactory(SRT_SANDBOX_BACKEND_ID);
    expect(factory).toBeTypeOf("function");
  });
});

describe.skipIf(!isDarwin)("srt sandbox macOS Seatbelt minimal path (8/8)", () => {
  afterEach(shutdownSrtSandboxRuntime);

  it("confines writes to the specified directory while the rest stays read-only", async () => {
    const rwZone = mkdtempSync(path.join(tmpdir(), "srt-rw-"));
    const roZone = mkdtempSync(path.join(tmpdir(), "srt-ro-"));
    const agentDir = mkdtempSync(path.join(tmpdir(), "srt-agent-"));
    writeFileSync(path.join(rwZone, "seed.txt"), "seed-rw");
    writeFileSync(path.join(roZone, "seed.txt"), "seed-ro");

    const pluginConfig = resolveSrtPluginConfig(undefined);
    const factory = createSrtSandboxBackendFactory({ pluginConfig });
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

    // D: write into the read-only zone → blocked, file not created
    const d = await run(`printf nope > ${roZone}/blocked.txt`);
    expect(d.code).not.toBe(0);
    expect(existsSync(path.join(roZone, "blocked.txt"))).toBe(false);

    // E: read a system file → allowed
    const e = await run(`head -c 1 /etc/hosts`);
    expect(e.code).toBe(0);

    // F: write into a system directory → blocked
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
});

describe.skipIf(!isLive)("srt sandbox deferred exec spec enforcement", () => {
  afterEach(shutdownSrtSandboxRuntime);

  it("launches a built exec spec inside the scope's write boundary", async () => {
    const rwZone = mkdtempSync(path.join(tmpdir(), "srt-rw-exec-"));
    const roZone = mkdtempSync(path.join(tmpdir(), "srt-ro-exec-"));
    const agentDir = mkdtempSync(path.join(tmpdir(), "srt-agent-exec-"));
    writeFileSync(path.join(roZone, "seed.txt"), "seed-ro");
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig(undefined),
    });
    const handle = await factory(
      makeParams({ workspaceDir: rwZone, agentWorkspaceDir: agentDir, workspaceAccess: "rw" }),
    );

    const allowed = await launchExecSpec(handle, `printf allowed > '${rwZone}/w.txt'`);
    expect(allowed.code).toBe(0);
    expect(readFileSync(path.join(rwZone, "w.txt"), "utf8")).toBe("allowed");

    const overwrite = await launchExecSpec(handle, `printf denied > '${roZone}/seed.txt'`);
    expect(overwrite.code).not.toBe(0);
    expect(readFileSync(path.join(roZone, "seed.txt"), "utf8")).toBe("seed-ro");

    const create = await launchExecSpec(handle, `printf denied > '${roZone}/created.txt'`);
    expect(create.code).not.toBe(0);
    expect(existsSync(path.join(roZone, "created.txt"))).toBe(false);
  });
});
