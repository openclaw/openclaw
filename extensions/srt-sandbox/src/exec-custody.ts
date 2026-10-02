import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxBackendExecSpec } from "openclaw/plugin-sdk/sandbox";

const PID_FILE_ENV = "SRT_CUSTODY_PID_FILE";
const ARGV_ENV = "SRT_CUSTODY_ARGV";
const CANCEL_FILE_ENV = "SRT_CUSTODY_CANCEL_FILE";

const LAUNCHER_SOURCE = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const argv = JSON.parse(Buffer.from(process.env.SRT_CUSTODY_ARGV, "base64").toString("utf8"));
if (existsSync(process.env.SRT_CUSTODY_CANCEL_FILE)) process.exit(1);
const child = spawn(argv[0], argv.slice(1), { cwd: process.cwd(), env: process.env, detached: process.platform !== "win32", shell: false, stdio: "inherit" });
writeFileSync(process.env.SRT_CUSTODY_PID_FILE, String(child.pid), { mode: 0o600 });
function terminate() {
  if (!child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
}
if (existsSync(process.env.SRT_CUSTODY_CANCEL_FILE)) { terminate(); process.exit(1); }
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { terminate(); process.exit(128); });
child.on("error", (error) => { console.error(error.message); terminate(); process.exit(1); });
child.on("exit", (code, signal) => { terminate(); process.exit(code ?? (signal ? 128 : 1)); });
`;

type Lease = {
  dir: string;
  pidFile: string;
  cancelFile: string;
  cleanup?: () => void;
  terminate(): Promise<void>;
};

function terminatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group is already gone.
  }
}

export class ExecCustody {
  private readonly leases = new Set<Lease>();
  private disposed = false;

  assertCurrent(): void {
    if (this.disposed) {
      throw new Error("srt-sandbox scope has been torn down; prepared command is stale.");
    }
  }

  prepare(env: Record<string, string>) {
    this.assertCurrent();
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-srt-exec-"));
    const pidFile = path.join(dir, "pid");
    const cancelFile = path.join(dir, "cancelled");
    const lease: Lease = {
      dir,
      pidFile,
      cancelFile,
      terminate: async () => {
        writeFileSync(cancelFile, "cancelled", { flag: "a", mode: 0o600 });
        try {
          terminatePid(Number.parseInt(readFileSync(pidFile, "utf8"), 10));
        } catch {
          // Cancellation before native spawn has no child to terminate.
        }
      },
    };
    this.leases.add(lease);
    return {
      env: { ...env, [PID_FILE_ENV]: pidFile },
      terminate: () => lease.terminate(),
      interrupt: async () => false,
    };
  }

  ensurePreparedEnv(env: Record<string, string>): Record<string, string> {
    return env[PID_FILE_ENV] ? env : this.prepare(env).env;
  }

  wrap(
    spec: SandboxBackendExecSpec,
    env: Record<string, string>,
    cleanup?: () => void,
  ): SandboxBackendExecSpec {
    this.assertCurrent();
    const pidFile = env[PID_FILE_ENV];
    const lease = [...this.leases].find((candidate) => candidate.pidFile === pidFile);
    if (!pidFile || !lease) {
      throw new Error("srt-sandbox exec cleanup custody is stale.");
    }
    lease.cleanup = cleanup;
    return {
      argv: [process.execPath, "-e", LAUNCHER_SOURCE],
      env: {
        ...spec.env,
        [PID_FILE_ENV]: pidFile,
        [CANCEL_FILE_ENV]: lease.cancelFile,
        [ARGV_ENV]: Buffer.from(JSON.stringify(spec.argv), "utf8").toString("base64"),
      },
      cwd: spec.cwd,
      stdinMode: spec.stdinMode,
      assertCurrent: () => this.assertCurrent(),
      finalizeToken: lease,
    };
  }

  async finalize(token: unknown): Promise<void> {
    const lease = [...this.leases].find((candidate) => candidate === token);
    if (!lease || !this.leases.delete(lease)) {
      return;
    }
    lease.cleanup?.();
    rmSync(lease.dir, { recursive: true, force: true });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const lease of this.leases) {
      void lease.terminate();
      lease.cleanup?.();
    }
  }
}
