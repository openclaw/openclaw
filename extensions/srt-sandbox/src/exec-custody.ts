import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { SandboxBackendExecSpec } from "openclaw/plugin-sdk/sandbox";
import { resolvePreferredOpenClawTmpDir, tempWorkspaceSync } from "openclaw/plugin-sdk/temp-path";

const SOCKET_ENV = "SRT_CUSTODY_SOCKET";
const TOKEN_ENV = "SRT_CUSTODY_TOKEN";
const ARGV_ENV = "SRT_CUSTODY_ARGV";

function assertSafeHostStartupEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (
      env[key] &&
      /^(?:BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|LD_.*|DYLD_.*|BASH_FUNC_.*)$/i.test(
        key,
      )
    ) {
      throw new Error(
        `srt-sandbox: unsafe host startup environment variable ${key} is unsupported.`,
      );
    }
  }
}

// This group leader and its fd watcher run outside the sandbox. Only the
// launched command receives the admitted sandbox argv and guest environment.
const GROUP_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { createReadStream, writeSync } = require("node:fs");
const argv = JSON.parse(Buffer.from(process.env.SRT_CUSTODY_ARGV, "base64").toString("utf8"));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("SRT_CUSTODY_")) delete env[key];
let settled = false;
function sweep(code) {
  if (settled) return;
  settled = true;
  try { writeSync(4, String(code) + "\n"); } catch {}
  // The leader is still alive here; its process-group ID cannot be reused.
  process.kill(-process.pid, "SIGKILL");
}
const owner = createReadStream(null, { fd: 3, autoClose: true });
owner.on("end", () => sweep(1));
owner.on("error", () => sweep(1));
owner.resume();
// The sole write end of this watchdog pipe lives in this leader. If the
// leader is killed, its surviving watcher still anchors and sweeps the group.
const watcher = spawn("/bin/bash", ["--noprofile", "--norc", "-p", "-c", 'while IFS= read -r _ <&3; do :; done; kill -KILL -- "-' + process.pid + '"'], { env: {}, stdio: ["ignore", "ignore", "ignore", "pipe"] });
watcher.on("error", () => sweep(127));
watcher.on("exit", () => sweep(1));
watcher.once("spawn", () => {
  if (settled) return;
  const child = spawn(argv[0], argv.slice(1), { env, shell: false, stdio: "inherit" });
  child.on("error", (error) => { console.error(error.message); sweep(127); });
  child.on("exit", (code, signal) => sweep(code ?? (signal ? 128 + (require("node:os").constants.signals[signal] ?? 1) : 1)));
});
`;

const LAUNCHER_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { createConnection } = require("node:net");
const socket = createConnection(process.env.SRT_CUSTODY_SOCKET);
let child;
let receipt = "";
let wantedCode;
let started = false;
let messages = "";
function terminate(code) {
  wantedCode ??= code;
  if (!child) process.exit(wantedCode);
  else child.stdio[3].destroy();
}
socket.on("error", () => terminate(1));
socket.on("end", () => terminate(1));
socket.on("close", () => terminate(1));
socket.once("connect", () => socket.write(process.env.SRT_CUSTODY_TOKEN + "\n"));
socket.on("data", (chunk) => {
  messages += chunk.toString();
  if (!started && messages.startsWith("ready\n")) {
    started = true;
    child = spawn(process.execPath, ["-e", Buffer.from(process.env.SRT_CUSTODY_GROUP, "base64").toString("utf8")], { env: process.env, detached: true, stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"] });
    child.stdio[4].on("data", (chunk) => { receipt += chunk.toString(); });
    child.on("error", (error) => { console.error(error.message); socket.destroy(); process.exit(127); });
    child.on("close", () => {
      const reported = /^\d+\n$/.test(receipt) ? Number(receipt.trim()) : 1;
      const code = wantedCode ?? (reported >= 0 && reported <= 255 ? reported : 1);
      socket.end("settled\n", () => process.exit(code));
      socket.on("error", () => process.exit(code));
    });
  }
  if (messages.includes("cancel\n")) terminate(1);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => terminate(128 + require("node:os").constants.signals[signal]));
`;

type Lease = {
  socketPath: string;
  nonce: string;
  server: Server;
  sockets: Set<Socket>;
  cancelled: boolean;
  claimed: boolean;
  cleanup?: () => void;
  workspace: ReturnType<typeof tempWorkspaceSync>;
};

export class ExecCustody {
  private readonly leases = new Set<Lease>();
  private disposed = false;

  async run(
    spec: SandboxBackendExecSpec,
    options: {
      stdin?: Buffer | string;
      timeoutMs: number;
      signal?: AbortSignal;
      cleanup?: () => void;
    },
  ): Promise<{ stdout: Buffer; stderr: Buffer; code: number; timedOut: boolean }> {
    options.signal?.throwIfAborted();
    const env = Object.fromEntries(
      Object.entries(spec.env ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const prepared = this.prepare(env);
    const wrapped = this.wrap(spec, prepared.env, options.cleanup);
    const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
      env: wrapped.env,
      cwd: wrapped.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    let timedOut = false;
    const abort = () => {
      void prepared.terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    try {
      const code = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (exitCode) => resolve(exitCode ?? 1));
        child.stdin.end(options.stdin);
      });
      options.signal?.throwIfAborted();
      return {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        code: timedOut ? 124 : code,
        timedOut,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      await this.finalize(wrapped.finalizeToken);
    }
  }

  assertCurrent(): void {
    if (this.disposed) {
      throw new Error("srt-sandbox scope has been torn down; prepared command is stale.");
    }
  }

  prepare(env: Record<string, string>) {
    this.assertCurrent();
    assertSafeHostStartupEnvironment(env);
    if (process.platform === "win32") {
      throw new Error("srt-sandbox: Windows execution is unavailable.");
    }
    // macOS Unix-domain socket paths have a small limit. Retain the SDK's
    // temp-directory identity and cleanup owner even when a short root is needed.
    const rootDir = resolvePreferredOpenClawTmpDir();
    const workspace = tempWorkspaceSync({ rootDir, prefix: "srt-exec-" });
    const lease: Lease = {
      socketPath: workspace.path("s"),
      nonce: randomBytes(32).toString("hex"),
      server: createServer(),
      sockets: new Set(),
      cancelled: false,
      claimed: false,
      workspace,
    };
    lease.server.on("connection", (socket) => {
      socket.unref();
      let handshake = "";
      socket.on("error", () => {});
      socket.on("close", () => lease.sockets.delete(socket));
      socket.on("data", (data) => {
        if (lease.sockets.has(socket)) {
          return;
        }
        handshake += data.toString();
        if (handshake.length > 128 || lease.cancelled || lease.claimed) {
          socket.destroy();
          return;
        }
        if (!handshake.includes("\n")) {
          return;
        }
        if (handshake !== `${lease.nonce}\n`) {
          socket.destroy();
          return;
        }
        lease.claimed = true;
        lease.sockets.add(socket);
        socket.write("ready\n");
      });
    });
    lease.server.on("error", () => {
      this.cancel(lease);
    });
    lease.server.listen(lease.socketPath);
    lease.server.unref();
    this.leases.add(lease);
    return {
      env: { ...env, [SOCKET_ENV]: lease.socketPath, [TOKEN_ENV]: lease.nonce },
      terminate: async () => this.cancel(lease),
      interrupt: async () => false,
    };
  }

  private cancel(lease: Lease): void {
    lease.cancelled = true;
    for (const socket of lease.sockets) {
      socket.write("cancel\n");
    }
  }

  ensurePreparedEnv(env: Record<string, string>): Record<string, string> {
    return env[SOCKET_ENV] ? env : this.prepare(env).env;
  }

  wrap(
    spec: SandboxBackendExecSpec,
    env: Record<string, string>,
    cleanup?: () => void,
  ): SandboxBackendExecSpec {
    this.assertCurrent();
    assertSafeHostStartupEnvironment(spec.env ?? {});
    const lease = [...this.leases].find(
      (candidate) => candidate.socketPath === env[SOCKET_ENV] && candidate.nonce === env[TOKEN_ENV],
    );
    if (!lease) {
      throw new Error("srt-sandbox exec cleanup custody is stale.");
    }
    lease.cleanup = cleanup;
    return {
      argv: [process.execPath, "-e", LAUNCHER_SOURCE],
      env: {
        ...spec.env,
        [SOCKET_ENV]: lease.socketPath,
        [TOKEN_ENV]: lease.nonce,
        [ARGV_ENV]: Buffer.from(JSON.stringify(spec.argv)).toString("base64"),
        SRT_CUSTODY_GROUP: Buffer.from(GROUP_SOURCE).toString("base64"),
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
    this.cancel(lease);
    for (const socket of lease.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      lease.server.close(() => resolve());
    });
    lease.cleanup?.();
    lease.workspace.cleanup();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const lease of this.leases) {
      this.cancel(lease);
      // Closing the owner channel is also authoritative cancellation on host death.
      for (const socket of lease.sockets) {
        socket.destroy();
      }
      lease.server.close(() => lease.workspace.cleanup());
      lease.cleanup?.();
    }
  }
}
