// Tests for the SRT sandbox backend (S1).
//
// Two concerns:
//  1. Registration self-verify — the backend registers via
//     registerSandboxBackend() and resolves through getSandboxBackendFactory().
//  2. macOS Seatbelt minimal path — reproduces the XIN-1912 8/8 matrix
//     (specified directory writable, everything else read-only). Gated to
//     darwin; on other platforms the backend fails closed by design.
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getSandboxBackendFactory,
  registerSandboxBackend,
  type CreateSandboxBackendParams,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSrtSandboxBackendFactory,
  createSrtSandboxBackendManager,
  resolveSrtSandboxWorkdir,
  SRT_SANDBOX_BACKEND_ID,
} from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";

const isDarwin = process.platform === "darwin";

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

describe("srt sandbox backend registration", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
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

  it("resolveWorkdir returns the scope workspace without starting the backend", () => {
    const params = makeParams({
      workspaceDir: "/tmp/srt-ws",
      agentWorkspaceDir: "/tmp/srt-agent",
      workspaceAccess: "rw",
    });
    expect(resolveSrtSandboxWorkdir(params)).toBe("/tmp/srt-ws");
  });
});

describe.skipIf(!isDarwin)("srt sandbox macOS Seatbelt minimal path (8/8)", () => {
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

  it("buildExecSpec produces a sandbox-wrapped argv that enforces the write boundary", async () => {
    const rwZone = mkdtempSync(path.join(tmpdir(), "srt-rw-exec-"));
    const agentDir = mkdtempSync(path.join(tmpdir(), "srt-agent-exec-"));
    mkdirSync(rwZone, { recursive: true });
    const pluginConfig = resolveSrtPluginConfig(undefined);
    const factory = createSrtSandboxBackendFactory({ pluginConfig });
    const handle = await factory(
      makeParams({ workspaceDir: rwZone, agentWorkspaceDir: agentDir, workspaceAccess: "rw" }),
    );
    const spec = await handle.buildExecSpec({
      command: "true",
      env: { PATH: process.env.PATH ?? "" },
      usePty: false,
    });
    // macOS wraps as [<shell>, -c, <sandbox-exec ...>]; the wrapper binary is
    // Seatbelt's sandbox-exec, proving kernel enforcement is in the argv.
    expect(spec.argv.length).toBeGreaterThanOrEqual(3);
    expect(spec.argv.join(" ")).toContain("sandbox-exec");
    expect(spec.stdinMode).toBe("pipe-open");
    expect(spec.cwd).toBe(rwZone);
  });
});
