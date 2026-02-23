import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { SandboxBwrapConfig } from "./types.bwrap.js";
import type { SandboxWorkspaceAccess } from "./types.js";

/** Host paths mounted read-only to form the base userland inside the namespace. */
const DEFAULT_ROOT_BINDS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

export const DEFAULT_BWRAP_WORKDIR = "/workspace";

let bwrapChecked = false;
let bwrapAvailable = false;

export async function ensureBwrapAvailable(): Promise<void> {
  if (bwrapChecked) {
    if (!bwrapAvailable) {
      throw new Error("bubblewrap (bwrap) binary not found on PATH.");
    }
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn("bwrap", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.on("error", () => {
      bwrapChecked = true;
      bwrapAvailable = false;
      reject(new Error("bubblewrap (bwrap) binary not found on PATH."));
    });
    child.on("close", (code) => {
      bwrapChecked = true;
      bwrapAvailable = code === 0;
      if (!bwrapAvailable) {
        reject(new Error(`bwrap --version exited with code ${code}: ${stdout.trim()}`));
      } else {
        resolve();
      }
    });
  });
}

/** Reset the cached availability check (for tests). */
export function resetBwrapAvailabilityCache(): void {
  bwrapChecked = false;
  bwrapAvailable = false;
}

export type BwrapExecParams = {
  cfg: SandboxBwrapConfig;
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  tty?: boolean;
};

/**
 * Build a complete bwrap argv (excluding the "bwrap" binary itself) that
 * isolates `command` inside a mount/pid/net namespace.
 *
 * The workspace directory is bind-mounted at `cfg.workdir` (default
 * `/workspace`). Everything else is read-only or tmpfs.
 */
export function buildBwrapArgs(params: BwrapExecParams): string[] {
  const { cfg, workspaceDir, workspaceAccess, command } = params;
  const args: string[] = [];

  const rootBinds = cfg.rootBinds ?? DEFAULT_ROOT_BINDS;
  const rootBindFlag = cfg.readOnlyRoot ? "--ro-bind" : "--bind";
  for (const hostPath of rootBinds) {
    if (existsSafe(hostPath)) {
      args.push(rootBindFlag, hostPath, hostPath);
    }
  }

  if (workspaceAccess === "rw") {
    args.push("--bind", workspaceDir, cfg.workdir);
  } else if (workspaceAccess === "ro") {
    args.push("--ro-bind", workspaceDir, cfg.workdir);
  }

  for (const entry of cfg.tmpfs) {
    args.push("--tmpfs", entry);
  }

  if (cfg.mountProc) {
    args.push("--proc", "/proc");
  } else {
    // ro-bind /proc
    args.push("--ro-bind", "/proc", "/proc");
  }

  args.push("--dev", "/dev");

  if (cfg.unshareNet) {
    args.push("--unshare-net");
  }
  if (cfg.unsharePid) {
    args.push("--unshare-pid");
  }
  if (cfg.unshareIpc) {
    args.push("--unshare-ipc");
  }
  if (cfg.unshareCgroup) {
    args.push("--unshare-cgroup");
  }

  if (cfg.newSession) {
    args.push("--new-session");
  }
  if (cfg.dieWithParent) {
    args.push("--die-with-parent");
  }

  for (const spec of cfg.extraBinds ?? []) {
    const parsed = parseBwrapBind(spec);
    if (parsed) {
      args.push(parsed.writable ? "--bind" : "--ro-bind", parsed.host, parsed.container);
    }
  }

  // Clear the environment first, then set explicit vars.
  args.push("--clearenv");
  const env = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: cfg.workdir,
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    ...cfg.env,
    ...params.env,
  };
  for (const [key, value] of Object.entries(env)) {
    args.push("--setenv", key, value);
  }

  const workdir = params.workdir ?? cfg.workdir;

  // workspaceAccess === "none" → no workspace mount, but ensure workdir exists
  // so --chdir does not fail.
  if (workspaceAccess === "none") {
    args.push("--tmpfs", workdir);
  }

  args.push("--chdir", workdir);
  args.push("--", "sh", "-c", command);

  return args;
}

/**
 * Build bwrap args specifically for a filesystem bridge operation (cat, stat, etc).
 * These are short-lived, non-interactive, and always run with the workspace mounted.
 */
export function buildBwrapFsBridgeArgs(params: {
  cfg: SandboxBwrapConfig;
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  script: string;
  scriptArgs?: string[];
}): string[] {
  const args = buildBwrapArgs({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    workspaceAccess: params.workspaceAccess,
    command: params.script,
  });

  // bwrap doesn't have the docker pattern of `sh -c 'script' scriptName arg1 arg2`.
  // Instead, the script itself must reference positional args.
  // We embed the args into the script via `sh -c 'script' _ arg1 arg2`.
  // Rewrite the last entry (which is the command) to include positional args.
  if (params.scriptArgs?.length) {
    // The args end with: "--", "sh", "-c", <script>
    // We need to append: "bwrap-fs", ...scriptArgs
    args.push("bwrap-fs", ...params.scriptArgs);
  }

  return args;
}

export type BwrapExecResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

export function execBwrapRaw(
  args: string[],
  opts?: {
    input?: Buffer | string;
    allowFailure?: boolean;
    signal?: AbortSignal;
  },
): Promise<BwrapExecResult> {
  return new Promise<BwrapExecResult>((resolve, reject) => {
    const child = spawn("bwrap", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;

    const signal = opts?.signal;
    const handleAbort = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort);
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", (error) => {
      signal?.removeEventListener("abort", handleAbort);
      reject(error);
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", handleAbort);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (aborted || signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !opts?.allowFailure) {
        const message = stderr.length > 0 ? stderr.toString("utf8").trim() : "";
        const error = Object.assign(new Error(message || `bwrap failed with code ${exitCode}`), {
          code: exitCode,
          stdout,
          stderr,
        });
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });

    const stdin = child.stdin;
    if (stdin) {
      if (opts?.input !== undefined) {
        stdin.end(opts.input);
      } else {
        stdin.end();
      }
    }
  });
}

function existsSafe(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function parseBwrapBind(
  spec: string,
): { host: string; container: string; writable: boolean } | null {
  const trimmed = spec.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(":");
  if (parts.length < 2) {
    return null;
  }

  const host = parts[0].trim();
  const container = parts[1].trim();
  const options = (parts[2] ?? "").trim().toLowerCase();
  if (!host || !container) {
    return null;
  }

  return {
    host,
    container,
    writable: options === "rw",
  };
}

export function resolveBwrapConfig(params: {
  globalBwrap?: Partial<SandboxBwrapConfig>;
  agentBwrap?: Partial<SandboxBwrapConfig>;
}): SandboxBwrapConfig {
  const g = params.globalBwrap;
  const a = params.agentBwrap;
  const env = a?.env
    ? { ...(g?.env ?? { LANG: "C.UTF-8" }), ...a.env }
    : (g?.env ?? { LANG: "C.UTF-8" });
  const extraBinds = [...(g?.extraBinds ?? []), ...(a?.extraBinds ?? [])];

  return {
    workdir: a?.workdir ?? g?.workdir ?? DEFAULT_BWRAP_WORKDIR,
    readOnlyRoot: a?.readOnlyRoot ?? g?.readOnlyRoot ?? true,
    tmpfs: a?.tmpfs ?? g?.tmpfs ?? ["/tmp", "/var/tmp", "/run"],
    unshareNet: a?.unshareNet ?? g?.unshareNet ?? true,
    unsharePid: a?.unsharePid ?? g?.unsharePid ?? true,
    unshareIpc: a?.unshareIpc ?? g?.unshareIpc ?? true,
    unshareCgroup: a?.unshareCgroup ?? g?.unshareCgroup ?? false,
    newSession: a?.newSession ?? g?.newSession ?? true,
    dieWithParent: a?.dieWithParent ?? g?.dieWithParent ?? true,
    mountProc: a?.mountProc ?? g?.mountProc ?? true,
    rootBinds: a?.rootBinds ?? g?.rootBinds,
    extraBinds: extraBinds.length ? extraBinds : undefined,
    env,
  };
}
