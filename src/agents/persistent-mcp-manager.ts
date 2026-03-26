import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OpenClawConfig } from "../config/config.js";
import { getProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import {
  describeStdioMcpServerLaunchConfig,
  resolveStdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";

const SIGTERM_WAIT_MS = 800;
const SIGKILL_WAIT_MS = 500;

type PersistentMcpServerState = "initializing" | "ready" | "failed" | "disposed";

type PersistentMcpPidLock = {
  pid: number;
  createdAt: string;
  starttime?: number;
  serverName: string;
};

type PersistentMcpServerHandle = {
  serverName: string;
  client: Client;
  transport: StdioClientTransport;
  pid: number | null;
  detachStderr?: () => void;
  state: PersistentMcpServerState;
  lockPath: string;
  /** In-flight _startServer promise, set while state === "initializing". */
  startPromise: Promise<void> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachStderrLogging(
  serverName: string,
  transport: StdioClientTransport,
  log: { warn: (msg: string) => void },
): (() => void) | undefined {
  const stderr = transport.stderr;
  if (!stderr || typeof (stderr as NodeJS.ReadableStream).on !== "function") {
    return undefined;
  }
  const onData = (chunk: Buffer | string) => {
    const message = String(chunk).trim();
    if (!message) return;
    for (const line of message.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        log.warn(`persistent-mcp:${serverName}: ${trimmed}`);
      }
    }
  };
  (stderr as NodeJS.ReadableStream).on("data", onData);
  return () => {
    if (typeof (stderr as NodeJS.ReadableStream).off === "function") {
      (stderr as NodeJS.ReadableStream).off("data", onData);
    }
  };
}

async function killStaleProcess(pid: number, starttime: number | undefined): Promise<void> {
  if (!isPidAlive(pid)) return;

  // PID recycle guard: if starttime is available and doesn't match, it's a different process.
  if (starttime !== undefined) {
    const currentStarttime = getProcessStartTime(pid);
    if (currentStarttime !== null && currentStarttime !== starttime) {
      // Different process has taken this PID — don't kill it.
      return;
    }
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await sleep(SIGTERM_WAIT_MS);
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await sleep(SIGKILL_WAIT_MS);
  }
}

async function readLockFile(lockPath: string): Promise<PersistentMcpPidLock | null> {
  try {
    const content = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.pid === "number" &&
      typeof parsed.serverName === "string"
    ) {
      return parsed as PersistentMcpPidLock;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeLockFile(lockPath: string, lock: PersistentMcpPidLock): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2), "utf8");
}

async function deleteLockFile(lockPath: string): Promise<void> {
  await fs.unlink(lockPath).catch(() => {});
}

export class PersistentMcpManager {
  private readonly cfg: OpenClawConfig | undefined;
  private readonly log: { warn: (msg: string) => void };
  private readonly stateDir: string;
  private readonly handles = new Map<string, PersistentMcpServerHandle>();
  private state: "initializing" | "ready" | "failed" | "disposed" = "failed";
  private initPromise: Promise<void> | null = null;

  constructor(params: {
    cfg?: OpenClawConfig;
    log: { warn: (msg: string) => void };
    stateDir: string;
  }) {
    this.cfg = params.cfg;
    this.log = params.log;
    this.stateDir = params.stateDir;
  }

  /**
   * Returns the names of all servers that have been configured as persistent.
   */
  getPersistentServerNames(): Set<string> {
    const names = new Set<string>();
    const servers = this.cfg?.mcp?.servers;
    if (!servers) return names;
    for (const [name, srv] of Object.entries(servers)) {
      if (isRecord(srv) && srv.persistent === true) {
        names.add(name);
      }
    }
    return names;
  }

  /**
   * Ensure all persistent MCP servers are connected. Idempotent.
   * - If currently initializing: waits for the in-progress init.
   * - If ready: returns immediately.
   * - If failed or never started: triggers a fresh init attempt.
   * - If disposed: returns without re-initializing.
   */
  async ensureReady(): Promise<void> {
    if (this.state === "disposed") return;
    if (this.state === "ready") return;

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.state = "initializing";
    this.initPromise = this._doInit().then(
      () => {
        this.initPromise = null;
        this.state = "ready";
      },
      (err) => {
        this.initPromise = null;
        this.state = "failed";
        this.log.warn(`persistent-mcp: initialization failed: ${String(err)}`);
      },
    );
    await this.initPromise;
  }

  private async _doInit(): Promise<void> {
    const servers = this.cfg?.mcp?.servers;
    if (!servers) return;

    for (const [serverName, rawServer] of Object.entries(servers)) {
      if (!isRecord(rawServer) || rawServer.persistent !== true) continue;

      const existing = this.handles.get(serverName);
      if (existing && existing.state === "ready") continue;

      await this._startServer(serverName, rawServer);
    }
  }

  private _startServer(serverName: string, rawServer: unknown): Promise<void> {
    // If a start is already in progress for this server, return the existing promise
    // so concurrent callers await the same operation instead of double-spawning.
    const existing = this.handles.get(serverName);
    if (existing?.startPromise) {
      return existing.startPromise;
    }

    const promise = this._doStartServer(serverName, rawServer);

    // Store the promise on the handle as soon as it's created (handle is set inside _doStartServer
    // synchronously before the first await, so we patch it right after).
    // We use a wrapper that clears startPromise on settle.
    const wrapped = promise.finally(() => {
      const h = this.handles.get(serverName);
      if (h) h.startPromise = null;
    });

    // Patch the handle if it was already created synchronously inside _doStartServer.
    const h = this.handles.get(serverName);
    if (h) h.startPromise = wrapped;

    return wrapped;
  }

  private async _doStartServer(serverName: string, rawServer: unknown): Promise<void> {
    const launch = resolveStdioMcpServerLaunchConfig(rawServer);
    if (!launch.ok) {
      this.log.warn(`persistent-mcp: skipped server "${serverName}" because ${launch.reason}.`);
      return;
    }
    const launchConfig = launch.config;
    const lockPath = path.join(this.stateDir, "mcp", `${serverName}.lock`);

    // Clean up any stale process from a previous run.
    const existingLock = await readLockFile(lockPath);
    if (existingLock && existingLock.pid > 0) {
      await killStaleProcess(existingLock.pid, existingLock.starttime);
      await deleteLockFile(lockPath);
    }

    const transport = new StdioClientTransport({
      command: launchConfig.command,
      args: launchConfig.args,
      env: launchConfig.env,
      cwd: launchConfig.cwd,
      stderr: "pipe",
    });

    const client = new Client({ name: "openclaw-persistent-mcp", version: "0.0.0" }, {});

    const handle: PersistentMcpServerHandle = {
      serverName,
      client,
      transport,
      pid: null,
      state: "initializing",
      lockPath,
      startPromise: null, // will be patched by _startServer wrapper
      detachStderr: attachStderrLogging(serverName, transport, this.log),
    };
    this.handles.set(serverName, handle);

    // Register disconnect/error handlers BEFORE connect() so the SDK chains them
    // correctly (SDK saves the pre-existing callbacks and calls them first).
    transport.onclose = () => {
      if (handle.state === "ready") {
        handle.state = "failed";
        this.log.warn(
          `persistent-mcp: server "${serverName}" disconnected; will reconnect on next use`,
        );
        void deleteLockFile(lockPath);
      }
    };
    transport.onerror = (err) => {
      if (handle.state === "ready") {
        handle.state = "failed";
        this.log.warn(
          `persistent-mcp: server "${serverName}" error: ${String(err)}; will reconnect on next use`,
        );
        void deleteLockFile(lockPath);
      }
    };

    try {
      await client.connect(transport);

      const pid = transport.pid ?? null;
      handle.pid = pid;
      handle.state = "ready";

      if (pid !== null && pid > 0) {
        const starttime = getProcessStartTime(pid) ?? undefined;
        await writeLockFile(lockPath, {
          pid,
          createdAt: new Date().toISOString(),
          starttime,
          serverName,
        });
      }

      this.log.warn(
        `persistent-mcp: started "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}) pid=${pid ?? "unknown"}`,
      );
    } catch (err) {
      handle.state = "failed";
      handle.detachStderr?.();
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      this.handles.delete(serverName);
      this.log.warn(
        `persistent-mcp: failed to start "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}): ${String(err)}`,
      );
    }
  }

  /**
   * Return a ready client for the given server name, or null if unavailable.
   * If the handle exists but is failed, triggers a lazy reconnect.
   */
  async getReadyClient(serverName: string): Promise<Client | null> {
    if (this.state === "disposed") return null;

    const handle = this.handles.get(serverName);

    if (handle?.state === "ready") return handle.client;

    // A concurrent caller is already starting this server — await it.
    if (handle?.startPromise) {
      await handle.startPromise.catch(() => {});
      const refreshed = this.handles.get(serverName);
      if (refreshed?.state === "ready") return refreshed.client;
      return null;
    }

    // Lazy reconnect: handle is missing (first spawn failed and was cleaned up)
    // or exists but is in a failed state.
    if (!handle || handle.state === "failed") {
      const rawServer = this.cfg?.mcp?.servers?.[serverName];
      if (rawServer) {
        await this._startServer(serverName, rawServer);
        const refreshed = this.handles.get(serverName);
        if (refreshed?.state === "ready") return refreshed.client;
      }
    }

    return null;
  }

  async dispose(): Promise<void> {
    if (this.state === "disposed") return;
    this.state = "disposed";

    // Wait for any in-progress init to settle before disposing.
    if (this.initPromise) {
      await this.initPromise.catch(() => {});
    }

    await Promise.allSettled(
      Array.from(this.handles.values()).map(async (handle) => {
        handle.detachStderr?.();
        await handle.client.close().catch(() => {});
        await handle.transport.close().catch(() => {});
        await deleteLockFile(handle.lockPath);
      }),
    );
    this.handles.clear();
  }
}
