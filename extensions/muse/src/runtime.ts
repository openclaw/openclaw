import { createHash } from "node:crypto";
import {
  MspError,
  Session,
  readSessionDurability,
  spawnMspConnection,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
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
  sessions: Map<string, Session>;
  dead: boolean;
  closing: boolean;
  users: number;
  timer?: ReturnType<typeof setTimeout>;
  close: () => Promise<void>;
};
type MuseLease = { runtime: MuseRuntime; release: () => void };

export function museEnvironment(apiKey?: string): NodeJS.ProcessEnv {
  // Without an OpenClaw-selected key, Muse applies its own documented order:
  // META_API_KEY, then a stored key, then a browser sign-in.
  return {
    ...process.env,
    MUSE_NO_AUTO_UPDATE: "1",
    ...(apiKey ? { META_API_KEY: apiKey } : {}),
  };
}

export function credentialFingerprint(apiKey?: string): string {
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
  private readonly entries = new Map<string, Promise<MuseRuntime>>();
  private disposed = false;
  constructor(private readonly binaryPath = "muse") {}

  async acquire(
    workspace: string,
    apiKey: string | undefined,
    readOnly: boolean,
  ): Promise<MuseLease> {
    if (this.disposed) {
      throw new Error("Muse runtime has been disposed");
    }
    const key = JSON.stringify([workspace, credentialFingerprint(apiKey), readOnly]);
    let pending = this.entries.get(key);
    if (!pending) {
      pending = this.spawn(workspace, apiKey, readOnly);
      this.entries.set(key, pending);
      void pending.catch(() => {
        if (this.entries.get(key) === pending) {
          this.entries.delete(key);
        }
      });
    }
    const runtime = await pending;
    if (this.disposed) {
      await runtime.close();
      throw new Error("Muse runtime was disposed during startup");
    }
    if (runtime.dead) {
      this.entries.delete(key);
      return this.acquire(workspace, apiKey, readOnly);
    }
    clearTimeout(runtime.timer);
    runtime.users++;
    return {
      runtime,
      release: () => {
        runtime.users--;
        if (runtime.users === 0) {
          runtime.timer = setTimeout(() => {
            if (this.entries.get(key) === pending) {
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
    workspace: string,
    apiKey: string | undefined,
    readOnly: boolean,
  ): Promise<MuseRuntime> {
    const handshake = spawnMspConnection({
      command: this.binaryPath,
      args: ["serve", ...(readOnly ? ["--disable-shell", "--disable-write"] : [])],
      cwd: workspace,
      env: museEnvironment(apiKey),
      shutdownTimeoutMs: 1000,
    });
    const startup = setTimeout(() => {
      void handshake.close();
    }, 30_000);
    startup.unref();
    try {
      const host = await handshake.initialize({
        clientInfo: { name: "openclaw", version: musePackage.version },
      });
      const runtime: MuseRuntime = {
        host,
        sessions: new Map(),
        users: 0,
        dead: false,
        closing: false,
        close: async () => {
          runtime.closing = true;
          await host.close();
        },
      };
      host.connection.onNotification((event) => {
        const sessionId = event.params?.sessionId;
        if (typeof sessionId === "string") {
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
      throw new Error(
        `Cannot start Muse Code (${this.binaryPath}). Install Muse and run muse to sign in. ${String(error)} ${handshake.child.stderrTail.join("\n")}`,
        { cause: error },
      );
    } finally {
      clearTimeout(startup);
    }
  }

  async dispose() {
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        const runtime = await entry.catch(() => undefined);
        if (runtime) {
          clearTimeout(runtime.timer);
          await runtime.close();
        }
      }),
    );
  }
}
