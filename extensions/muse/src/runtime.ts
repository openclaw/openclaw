import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MspError,
  Session,
  readSessionDurability,
  spawnMspConnection,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import musePackage from "../package.json" with { type: "json" };

export type MuseOpenSession = {
  sessionId?: string;
  workspace: string;
  modelId: string;
  approvalMode: "allowAll" | "promptUnmatched" | "denyUnmatched";
  /** Reports a refused resume that was replaced by a new Muse session. */
  onResumeRefused?: (message: string) => void;
};
const RESUME_RETRY_KINDS: Record<string, true> = {
  sessionInUse: true,
  overloaded: true,
  backpressured: true,
  interrupted: true,
};
export type MuseRuntime = {
  host: SpawnedMspConnection;
  credentialIdentity: string;
  sessions: Map<string, Session>;
  /** MSP usage notices are consumer-folded, not routed to turn handles. */
  usageObservers: Map<string, (params: unknown) => void>;
  dead: boolean;
  closing: boolean;
  users: number;
  timer?: ReturnType<typeof setTimeout>;
  close: () => Promise<void>;
};
type MuseLease = { runtime: MuseRuntime; release: () => void };
// A large local store on a busy host can take well over 30s to answer initialize.
export const MUSE_STARTUP_TIMEOUT_MS = 120_000;

function credentialFingerprint(apiKey?: string): string {
  return apiKey ? createHash("sha256").update(apiKey).digest("hex") : "cli-login";
}

export async function openMuseSession(runtime: MuseRuntime, options: MuseOpenSession) {
  if (options.sessionId) {
    const existing = runtime.sessions.get(options.sessionId);
    if (existing) {
      return existing;
    }
  }
  const { connection } = runtime.host;
  const start = () =>
    connection.command("session/start", {
      workspaceRoot: options.workspace,
      modelId: options.modelId,
      providerId: "meta",
      approvalMode: options.approvalMode,
    });
  let result: Record<string, unknown>;
  if (!options.sessionId) {
    result = await start();
  } else {
    try {
      result = await connection.command("session/resume", {
        sessionId: options.sessionId,
        excludeItems: true,
      });
    } catch (error) {
      // A server-authored refusal means Muse ran nothing, so a new root session
      // is safe (the OpenClaw transcript keeps the conversation). Transport
      // failures stay ambiguous, and an in-use or overloaded session may still
      // be live elsewhere, so those fail the turn instead.
      if (!(error instanceof MspError) || RESUME_RETRY_KINDS[error.kind]) {
        throw error instanceof MspError
          ? new Error(`Muse refused to resume session (${error.kind}): ${error.message}`, {
              cause: error,
            })
          : error;
      }
      options.onResumeRefused?.(`Muse could not resume session (${error.kind}): ${error.message}`);
      result = await start();
    }
  }
  if (!isRecord(result.session) || typeof result.session.sessionId !== "string") {
    throw new Error("Muse returned an invalid session identity.");
  }
  const session = new Session({
    sessionId: result.session.sessionId,
    connection,
    durability: readSessionDurability(runtime.host.initializeResult),
  });
  runtime.sessions.set(session.sessionId, session);
  return session;
}

export class MusePool {
  private readonly entries = new Map<
    string,
    {
      credentialIdentity: string;
      pending: Promise<MuseRuntime>;
      startup: AbortController | undefined;
      waiters: number;
    }
  >();
  private disposed = false;
  constructor(
    private readonly binaryPath = "muse",
    private readonly noSessionLog = false,
  ) {}

  async acquire(
    workspace: string | undefined,
    apiKey: string | undefined,
    readOnly: boolean,
    signal?: AbortSignal,
  ): Promise<MuseLease> {
    signal?.throwIfAborted();
    if (this.disposed) {
      throw new Error("Muse runtime has been disposed");
    }
    const inherited = { ...process.env };
    const managedHome = path.join(resolveStateDir(inherited), "muse");
    const authPath = path.join(managedHome, "muse", "auth.json");
    let credentialSource: string;
    try {
      const stat = await fs.stat(authPath);
      credentialSource = JSON.stringify([
        "managed",
        authPath,
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeMs,
        stat.ctimeMs,
      ]);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        credentialSource = "native";
      } else {
        throw error;
      }
    }
    // An existing managed store remains authoritative even if its contents are unusable.
    const env: NodeJS.ProcessEnv = {
      ...inherited,
      MUSE_NO_AUTO_UPDATE: "1",
      ...(credentialSource !== "native"
        ? { TBH_CREDENTIAL_BACKEND: "file", XDG_CONFIG_HOME: managedHome }
        : {}),
      ...(apiKey ? { META_API_KEY: apiKey } : {}),
    };
    if (this.disposed) {
      throw new Error("Muse runtime was disposed during environment preparation");
    }
    signal?.throwIfAborted();
    const apiKeyIdentity = credentialFingerprint(apiKey);
    const key = JSON.stringify([workspace, apiKeyIdentity, readOnly]);
    const credentialIdentity = JSON.stringify([
      apiKey ? apiKeyIdentity : credentialFingerprint(env.META_API_KEY),
      credentialSource,
    ]);
    let entry = this.entries.get(key);
    if (!entry || entry.credentialIdentity !== credentialIdentity) {
      const previous = entry;
      const startup = new AbortController();
      const pending = (async () => {
        if (previous) {
          const runtime = await previous.pending.catch(() => undefined);
          await runtime?.close();
        }
        return this.spawn(workspace, env, readOnly, credentialIdentity, startup.signal);
      })();
      entry = { credentialIdentity, pending, startup, waiters: 0 };
      this.entries.set(key, entry);
      const startingEntry = entry;
      void pending.then(
        () => {
          startingEntry.startup = undefined;
        },
        () => {
          if (this.entries.get(key) === startingEntry) {
            this.entries.delete(key);
          }
        },
      );
    }
    entry.waiters++;
    let runtime: MuseRuntime;
    try {
      runtime = await racePromiseWithAbortSignal(
        entry.pending,
        signal,
        (aborted) => aborted.reason,
      );
      signal?.throwIfAborted();
    } finally {
      entry.waiters--;
      // A caller owns its wait, not the other callers sharing this startup.
      if (signal?.aborted && entry.waiters === 0) {
        if (entry.startup) {
          if (this.entries.get(key) === entry) {
            this.entries.delete(key);
          }
          entry.startup.abort(signal.reason);
        }
        const unused = await entry.pending.catch(() => undefined);
        if (unused && entry.waiters === 0 && unused.users === 0) {
          await unused.close();
        }
      }
    }
    if (this.disposed) {
      await runtime.close();
      throw new Error("Muse runtime was disposed during startup");
    }
    if (this.entries.get(key) !== entry || runtime.dead || runtime.closing) {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
      return this.acquire(workspace, apiKey, readOnly, signal);
    }
    clearTimeout(runtime.timer);
    runtime.users++;
    return {
      runtime,
      release: () => {
        runtime.users--;
        if (runtime.users === 0 && !runtime.closing) {
          runtime.timer = setTimeout(() => {
            if (this.entries.get(key) === entry) {
              this.entries.delete(key);
            }
            void runtime.close();
          }, 300_000);
          runtime.timer.unref();
        }
      },
    };
  }

  private async spawn(
    workspace: string | undefined,
    env: NodeJS.ProcessEnv,
    readOnly: boolean,
    credentialIdentity: string,
    signal: AbortSignal,
  ): Promise<MuseRuntime> {
    if (this.disposed) {
      throw new Error("Muse runtime was disposed during environment preparation");
    }
    signal.throwIfAborted();
    const handshake = spawnMspConnection({
      command: this.binaryPath,
      args: [
        "serve",
        ...(this.noSessionLog ? ["--no-session-log"] : []),
        ...(readOnly ? ["--disable-shell", "--disable-write"] : []),
      ],
      cwd: workspace,
      env,
      shutdownTimeoutMs: 1000,
    });
    const startedAt = Date.now();
    let startupTimedOut = false;
    const startup = setTimeout(() => {
      startupTimedOut = true;
      void handshake.close();
    }, MUSE_STARTUP_TIMEOUT_MS);
    startup.unref();
    const abort = () => {
      void handshake.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const host = await handshake.initialize({
        clientInfo: { name: "openclaw", version: musePackage.version },
        // OpenClaw never presents or answers userInput/request, and MSP treats an
        // absent flag as capable, so a Muse question would block the turn until timeout.
        capabilities: { userInputDialogs: false },
      });
      signal.throwIfAborted();
      const runtime: MuseRuntime = {
        host,
        credentialIdentity,
        sessions: new Map(),
        usageObservers: new Map(),
        users: 0,
        dead: false,
        closing: false,
        close: async () => {
          runtime.closing = true;
          clearTimeout(runtime.timer);
          await host.close();
        },
      };
      host.connection.onNotification((event) => {
        const sessionId = event.params?.sessionId;
        if (typeof sessionId === "string") {
          if (event.method === "session/tokenUsage") {
            runtime.usageObservers.get(sessionId)?.(event.params);
          }
          runtime.sessions.get(sessionId)?.apply(event);
        }
      });
      host.connection.onProtocolError(() => {
        void runtime.close();
      });
      void host.child.exit.then((exit) => {
        runtime.dead = true;
        for (const session of runtime.sessions.values()) {
          session.hostExited(exit);
        }
      });
      void host.connection.closed.then(() => {
        runtime.dead = true;
        for (const session of runtime.sessions.values()) {
          session.hostExited({ kind: "transportEof" });
        }
      });
      return runtime;
    } catch (error) {
      await handshake.close();
      // A caller that gave up (for example a catalog deadline) owns the reason, not install state.
      if (signal.aborted && !startupTimedOut) {
        signal.throwIfAborted();
      }
      const stderr = handshake.child.stderrTail.join("\n");
      throw new Error(
        startupTimedOut
          ? `Muse Code (${this.binaryPath}) did not finish starting within ${MUSE_STARTUP_TIMEOUT_MS / 1000}s (waited ${Math.round((Date.now() - startedAt) / 1000)}s). Muse is slow to start on a busy host or with a large local store; retry when the host is less loaded. ${stderr}`
          : `Cannot start Muse Code (${this.binaryPath}). Install Muse and run muse to sign in. ${String(error)} ${stderr}`,
        { cause: error },
      );
    } finally {
      clearTimeout(startup);
      signal.removeEventListener("abort", abort);
    }
  }

  async dispose() {
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        const runtime = await entry.pending.catch(() => undefined);
        if (runtime) {
          await runtime.close();
        }
      }),
    );
  }
}
