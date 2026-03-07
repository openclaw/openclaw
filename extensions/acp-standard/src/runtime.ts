import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
  PluginLogger,
} from "openclaw/plugin-sdk";
import { AcpRuntimeError } from "openclaw/plugin-sdk";
import type { ResolvedStandardAcpConfig } from "./config.js";

export const STANDARD_ACP_BACKEND_ID = "acp-standard";

/** Timeout for control-plane requests (initialize, session/new, etc.). */
const CONTROL_TIMEOUT_MS = 30_000;

/** Methods that are expected to return quickly. */
const CONTROL_METHODS = new Set([
  "initialize",
  "session/new",
  "session/cancel",
  "session/set_mode",
]);

type AgentProcess = {
  child: ChildProcess;
  stdin: Writable;
  sessionId: string | null;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  notifications: ((event: AcpRuntimeEvent) => void) | null;
};

const CAPABILITIES: AcpRuntimeCapabilities = {
  controls: ["session/set_mode"],
};

export class StandardAcpRuntime implements AcpRuntime {
  private healthy = false;
  private agents = new Map<string, AgentProcess>();
  private initializing = new Map<string, Promise<AcpRuntimeHandle>>();

  constructor(
    private readonly config: ResolvedStandardAcpConfig,
    private readonly logger?: PluginLogger,
  ) {}

  isHealthy(): boolean {
    return this.healthy;
  }

  private get spawnEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.config.env };
  }

  async probeAvailability(): Promise<void> {
    try {
      const child = spawn(this.config.command, ["--help"], {
        cwd: this.config.cwd,
        stdio: "ignore",
        env: this.spawnEnv,
      });
      const code = await new Promise<number>((resolve) => {
        child.on("close", (c) => resolve(c ?? 1));
        child.on("error", () => resolve(1));
      });
      this.healthy = code === 0;
    } catch {
      this.healthy = false;
    }
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const key = input.sessionKey;

    // Return in-flight initialization to prevent concurrent spawns for the same key.
    const inflight = this.initializing.get(key);
    if (inflight) return inflight;

    if (this.agents.has(key)) {
      const agent = this.agents.get(key)!;
      return {
        sessionKey: key,
        backend: STANDARD_ACP_BACKEND_ID,
        runtimeSessionName: agent.sessionId ?? key,
        cwd: input.cwd ?? this.config.cwd,
      };
    }

    const promise = this.initAgent(key, input);
    this.initializing.set(key, promise);
    try {
      return await promise;
    } finally {
      this.initializing.delete(key);
    }
  }

  private async initAgent(key: string, input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const agent = this.spawnAgent(key);
    this.agents.set(key, agent);

    try {
      await this.sendRequest(agent, "initialize", {
        protocolVersion: "0.1",
        clientInfo: { name: "openclaw", version: "1.0.0" },
      });

      const sessionResult = (await this.sendRequest(agent, "session/new", {
        cwd: input.cwd ?? this.config.cwd,
        mcpServers: [],
      })) as Record<string, unknown>;
      agent.sessionId = (sessionResult?.sessionId as string) ?? key;
    } catch (err) {
      agent.child.kill("SIGTERM");
      this.agents.delete(key);
      throw err;
    }

    return {
      sessionKey: key,
      backend: STANDARD_ACP_BACKEND_ID,
      runtimeSessionName: agent.sessionId ?? key,
      cwd: input.cwd ?? this.config.cwd,
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    // Short-circuit if the signal is already aborted.
    if (input.signal?.aborted) {
      yield { type: "done", stopReason: "cancelled" };
      return;
    }

    const agent = this.agents.get(input.handle.sessionKey);
    if (!agent) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "No agent process for session.");
    }

    const events: AcpRuntimeEvent[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;

    agent.notifications = (event) => {
      events.push(event);
      resolveWait?.();
    };

    // Push error event on unexpected process exit so the loop never hangs.
    const onClose = () => {
      if (!done) {
        events.push({ type: "error", message: "agent process exited unexpectedly" });
        resolveWait?.();
      }
    };
    agent.child.on("close", onClose);

    const onAbort = () => {
      void this.cancel({ handle: input.handle });
      // Force-terminate the turn so the iterator always unwinds.
      if (!done) {
        events.push({ type: "done", stopReason: "cancelled" });
        resolveWait?.();
      }
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const promptPromise = this.sendRequest(agent, "session/prompt", {
      sessionId: agent.sessionId,
      prompt: [{ type: "text", text: input.text }],
    });

    // When the prompt response arrives, treat it as turn completion
    // (agents may resolve the prompt without sending a TurnEnd notification).
    promptPromise
      .then((result) => {
        if (!done) {
          const res = result as Record<string, unknown> | undefined;
          const stopReason = (res?.stopReason as string) ?? "end_turn";
          events.push({ type: "done", stopReason });
          resolveWait?.();
        }
      })
      .catch((err) => {
        if (!done) {
          events.push({ type: "error", message: String(err) });
          resolveWait?.();
        }
      });

    try {
      while (!done) {
        if (events.length > 0) {
          const event = events.shift()!;
          yield event;
          if (event.type === "done" || event.type === "error") {
            done = true;
          }
        } else {
          await new Promise<void>((r) => {
            resolveWait = r;
          });
        }
      }
    } finally {
      agent.notifications = null;
      agent.child.removeListener("close", onClose);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  getCapabilities(): AcpRuntimeCapabilities {
    return CAPABILITIES;
  }

  async getStatus(input: { handle: AcpRuntimeHandle }): Promise<AcpRuntimeStatus> {
    const agent = this.agents.get(input.handle.sessionKey);
    return {
      summary: agent ? `running, sessionId=${agent.sessionId}` : "no process",
    };
  }

  async setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void> {
    const agent = this.agents.get(input.handle.sessionKey);
    if (!agent) return;
    await this.sendRequest(agent, "session/set_mode", {
      sessionId: agent.sessionId,
      modeId: input.mode,
    });
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    try {
      await this.probeAvailability();
      return this.healthy
        ? { ok: true, message: `${this.config.command} available` }
        : {
            ok: false,
            code: "ACP_BACKEND_UNAVAILABLE",
            message: `${this.config.command} not responding`,
          };
    } catch (err) {
      return { ok: false, code: "ACP_BACKEND_UNAVAILABLE", message: String(err) };
    }
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const agent = this.agents.get(input.handle.sessionKey);
    if (!agent) return;
    await this.sendRequest(agent, "session/cancel", {
      sessionId: agent.sessionId,
    }).catch(() => {});
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const agent = this.agents.get(input.handle.sessionKey);
    if (!agent) return;
    agent.child.kill("SIGTERM");
    this.agents.delete(input.handle.sessionKey);
  }

  /** Kill all spawned agent processes. Called during service shutdown. */
  closeAll(): void {
    for (const [key, agent] of this.agents) {
      agent.child.kill("SIGTERM");
      this.agents.delete(key);
    }
  }

  // --- JSON-RPC 2.0 transport ---

  private spawnAgent(key: string): AgentProcess {
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.spawnEnv,
    });

    // stdio: ["pipe","pipe","pipe"] guarantees these are non-null.
    const stdin = child.stdin!;
    const stdout = child.stdout!;
    const stderr = child.stderr!;

    const agent: AgentProcess = {
      child,
      stdin,
      sessionId: null,
      nextId: 1,
      pending: new Map(),
      notifications: null,
    };

    // Handle spawn failures (e.g. ENOENT) without crashing the host process.
    child.on("error", (err) => {
      this.logger?.warn?.(`[acp-standard:${key}] spawn error: ${err.message}`);
      for (const p of agent.pending.values()) {
        p.reject(err);
      }
      agent.pending.clear();
      if (this.agents.get(key) === agent) this.agents.delete(key);
    });

    const rl = createInterface({ input: stdout });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;

        if ("id" in msg && msg.id != null) {
          const id = msg.id as number;
          const p = agent.pending.get(id);
          if (p) {
            agent.pending.delete(id);
            if ("error" in msg) {
              p.reject(new Error(JSON.stringify(msg.error)));
            } else {
              p.resolve(msg.result);
            }
          }
          return;
        }

        if ("method" in msg && msg.method === "session/update") {
          const params = msg.params as Record<string, unknown> | undefined;
          if (!params) return;
          const event = this.mapNotificationToEvent(params);
          if (event) agent.notifications?.(event);
        }
      } catch {
        // ignore malformed lines
      }
    });

    stderr.on("data", (chunk: Buffer) => {
      this.logger?.warn?.(`[acp-standard:${key}] stderr: ${String(chunk).trim()}`);
    });

    child.on("close", () => {
      for (const p of agent.pending.values()) {
        p.reject(new Error("agent process exited"));
      }
      agent.pending.clear();
      if (this.agents.get(key) === agent) this.agents.delete(key);
    });

    return agent;
  }

  private sendRequest(agent: AgentProcess, method: string, params: unknown): Promise<unknown> {
    const id = agent.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const timeoutMs = CONTROL_METHODS.has(method) ? CONTROL_TIMEOUT_MS : undefined;

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (timeoutMs) {
        timer = setTimeout(() => {
          agent.pending.delete(id);
          reject(new Error(`JSON-RPC request timed out: ${method}`));
        }, timeoutMs);
      }

      agent.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });

      agent.stdin.write(msg + "\n", (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          agent.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private mapNotificationToEvent(params: Record<string, unknown>): AcpRuntimeEvent | null {
    // ACP session/update envelope: { update: { sessionUpdate: "...", ... } }
    const update = params.update as Record<string, unknown> | undefined;
    if (!update) return null;
    const kind = update.sessionUpdate as string | undefined;

    switch (kind) {
      case "agent_message_chunk": {
        const content = update.content as Record<string, unknown> | undefined;
        return {
          type: "text_delta",
          text: (content?.text as string) ?? "",
          stream: "output",
        };
      }
      case "tool_call":
        return { type: "tool_call", text: (update.title as string) ?? "tool" };
      case "tool_call_update":
        return {
          type: "status",
          text: `tool ${(update.toolCallId as string) ?? ""}: ${(update.status as string) ?? ""}`,
        };
      default:
        return null;
    }
  }
}
