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
import musePackage from "../package.json" with { type: "json" };

export type MuseOpenSession = {
  sessionId?: string;
  workspace: string;
  modelId: string;
  approvalMode: "allowAll" | "promptUnmatched" | "denyUnmatched";
  /** Reports a refused resume that was replaced by a new Muse session. */
  onResumeRefused?: (message: string) => void;
  onSession?: (session: Session) => void;
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
  detachedSessions: Set<Session>;
  dead: boolean;
  closing: boolean;
  users: number;
  timer?: ReturnType<typeof setTimeout>;
  close: () => Promise<void>;
};
type MuseLease = { runtime: MuseRuntime; release: () => void };

function credentialFingerprint(apiKey?: string): string {
  return apiKey ? createHash("sha256").update(apiKey).digest("hex") : "cli-login";
}

export async function openMuseSession(runtime: MuseRuntime, options: MuseOpenSession) {
  if (options.sessionId) {
    const existing = runtime.sessions.get(options.sessionId);
    if (existing) {
      options.onSession?.(existing);
      return existing;
    }
  }
  const { connection } = runtime.host;
  const prepareSession = (sessionId: string) => {
    const session = new Session({
      sessionId,
      connection,
      durability: readSessionDurability(runtime.host.initializeResult),
    });
    options.onSession?.(session);
    runtime.sessions.set(sessionId, session);
    return session;
  };
  const start = () =>
    connection.command("session/start", {
      workspaceRoot: options.workspace,
      modelId: options.modelId,
      providerId: "meta",
      approvalMode: options.approvalMode,
    });
  let result: Record<string, unknown>;
  let resumedSession: Session | undefined;
  if (!options.sessionId) {
    result = await start();
  } else {
    // Pending approvals can follow the resume response in the same transport
    // drain. Route them to the configured exact-ID session before sending.
    resumedSession = prepareSession(options.sessionId);
    try {
      result = await connection.command("session/resume", {
        sessionId: options.sessionId,
        excludeItems: true,
      });
    } catch (error) {
      runtime.sessions.delete(options.sessionId);
      resumedSession = undefined;
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
    if (resumedSession) {
      runtime.sessions.delete(resumedSession.sessionId);
    }
    throw new Error("Muse returned an invalid session identity.");
  }
  if (resumedSession) {
    if (resumedSession.sessionId === result.session.sessionId) {
      return resumedSession;
    }
    runtime.sessions.delete(resumedSession.sessionId);
  }
  return prepareSession(result.session.sessionId);
}

// Approval handler failures permanently latch their SDK stage. A later owner
// resumes the same native session with a fresh router, while this retired fold
// still observes settlement without retaining caller projections or authority.
export function retainMuseSession(
  runtime: MuseRuntime,
  session: Session,
  settled: Promise<unknown>,
  release: () => void,
  approvalFailed: boolean,
) {
  const retire = () => {
    if (runtime.sessions.get(session.sessionId) === session) {
      runtime.sessions.delete(session.sessionId);
    }
  };
  runtime.detachedSessions.add(session);
  session.onApproval(async () => {
    retire();
    throw new Error("Muse observation is no longer active.");
  });
  session.onApprovalError(retire);
  if (approvalFailed) {
    retire();
  }
  const finish = () => {
    runtime.detachedSessions.delete(session);
    release();
  };
  void Promise.race([settled, runtime.host.child.exit, runtime.host.connection.closed]).then(
    finish,
    finish,
  );
}

export class MusePool {
  private readonly entries = new Map<
    string,
    { credentialIdentity: string; pending: Promise<MuseRuntime>; startup: AbortController }
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
      entry = { credentialIdentity, pending, startup };
      this.entries.set(key, entry);
      void pending.catch(() => {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
      });
    }
    const abort = () => entry.startup.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let runtime: MuseRuntime;
    try {
      runtime = await entry.pending;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    if (signal?.aborted) {
      await runtime.close();
      signal.throwIfAborted();
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
    const startup = setTimeout(() => {
      void handshake.close();
    }, 30_000);
    startup.unref();
    const abort = () => {
      void handshake.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const host = await handshake.initialize({
        clientInfo: { name: "openclaw", version: musePackage.version },
      });
      signal.throwIfAborted();
      const runtime: MuseRuntime = {
        host,
        credentialIdentity,
        sessions: new Map(),
        detachedSessions: new Set(),
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
          const current = runtime.sessions.get(sessionId);
          current?.apply(event);
          for (const detached of runtime.detachedSessions) {
            if (detached !== current && detached.sessionId === sessionId) {
              detached.apply(event);
            }
          }
        }
      });
      host.connection.onProtocolError(() => {
        void runtime.close();
      });
      void host.child.exit.then((exit) => {
        runtime.dead = true;
        for (const session of new Set([
          ...runtime.sessions.values(),
          ...runtime.detachedSessions,
        ])) {
          session.hostExited(exit);
        }
      });
      void host.connection.closed.then(() => {
        runtime.dead = true;
        for (const session of new Set([
          ...runtime.sessions.values(),
          ...runtime.detachedSessions,
        ])) {
          session.hostExited({ kind: "transportEof" });
        }
      });
      return runtime;
    } catch (error) {
      await handshake.close();
      throw new Error(
        `Cannot start Muse Code (${this.binaryPath}). Install Muse and run muse to sign in. ${String(error)} ${handshake.child.stderrTail.join("\n")}`,
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
