import path from "node:path";
import {
  AcpRuntimeError,
  getAcpRuntimeBackend,
  type AcpRuntime,
  type AcpRuntimeDoctorReport,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeStatus,
  type AcpRuntimeTurnInput,
} from "openclaw/plugin-sdk/acp-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import {
  createCovenClient,
  type CovenClient,
  type CovenEventRecord,
  type CovenSessionRecord,
} from "./client.js";
import type { ResolvedCovenPluginConfig } from "./config.js";

export const COVEN_BACKEND_ID = "coven";

const DEFAULT_HARNESSES: Record<string, string> = {
  codex: "codex",
  "openai-codex": "codex",
  "codex-cli": "codex",
  claude: "claude",
  "claude-cli": "claude",
  gemini: "gemini",
  "google-gemini-cli": "gemini",
  opencode: "opencode",
};

type CovenRuntimeSessionState = {
  agent: string;
  mode: "prompt" | "steer" | string;
  sessionMode?: string;
  cwd?: string;
};

type CovenAcpRuntimeParams = {
  config: ResolvedCovenPluginConfig;
  logger?: PluginLogger;
  client?: CovenClient;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function normalizeAgentId(value: string | undefined): string {
  return value?.trim().toLowerCase() || "codex";
}

function encodeRuntimeSessionName(state: CovenRuntimeSessionState): string {
  return `coven:${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}

function decodeRuntimeSessionName(value: string): CovenRuntimeSessionState | null {
  const encoded = value.startsWith("coven:") ? value.slice("coven:".length) : "";
  if (!encoded) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<CovenRuntimeSessionState>;
    const agent = normalizeAgentId(typeof parsed.agent === "string" ? parsed.agent : undefined);
    return {
      agent,
      mode: typeof parsed.mode === "string" ? parsed.mode : "prompt",
      ...(typeof parsed.sessionMode === "string" ? { sessionMode: parsed.sessionMode } : {}),
      ...(typeof parsed.cwd === "string" && parsed.cwd.trim() ? { cwd: parsed.cwd.trim() } : {}),
    };
  } catch {
    return null;
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("sleep aborted"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new Error("sleep aborted"));
      },
      { once: true },
    );
  });
}

function titleFromPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.slice(0, 80) || "OpenClaw task";
}

function parsePayload(event: CovenEventRecord): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.payloadJson) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function eventToRuntimeEvents(event: CovenEventRecord): AcpRuntimeEvent[] {
  const payload = parsePayload(event);
  if (event.kind === "output") {
    const text = typeof payload.data === "string" ? payload.data : "";
    return text ? [{ type: "text_delta", text, stream: "output", tag: "agent_message_chunk" }] : [];
  }
  if (event.kind === "exit") {
    const status = typeof payload.status === "string" ? payload.status : "completed";
    const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
    return [
      {
        type: "status",
        text: `coven session ${status}${exitCode == null ? "" : ` exitCode=${exitCode}`}`,
        tag: "session_info_update",
      },
      { type: "done", stopReason: status },
    ];
  }
  if (event.kind === "kill") {
    return [
      { type: "status", text: "coven session killed", tag: "session_info_update" },
      { type: "done", stopReason: "killed" },
    ];
  }
  return [];
}

function sessionIsTerminal(session: CovenSessionRecord): boolean {
  return session.status !== "running" && session.status !== "created";
}

function terminalStatusEvent(session: CovenSessionRecord): AcpRuntimeEvent {
  return {
    type: "status",
    text: `coven session ${session.status}${session.exitCode == null ? "" : ` exitCode=${session.exitCode}`}`,
    tag: "session_info_update",
  };
}

export class CovenAcpRuntime implements AcpRuntime {
  private readonly config: ResolvedCovenPluginConfig;
  private readonly client: CovenClient;
  private readonly logger?: PluginLogger;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly activeSessionIdsBySessionKey = new Map<string, string>();

  constructor(params: CovenAcpRuntimeParams) {
    this.config = params.config;
    this.logger = params.logger;
    this.client = params.client ?? createCovenClient(params.config.socketPath);
    this.sleep = params.sleep ?? defaultSleep;
  }

  async ensureSession(
    input: Parameters<AcpRuntime["ensureSession"]>[0],
  ): Promise<AcpRuntimeHandle> {
    if (!(await this.isCovenAvailable())) {
      return await this.ensureFallbackSession(input);
    }
    const agent = normalizeAgentId(input.agent);
    return {
      sessionKey: input.sessionKey,
      backend: COVEN_BACKEND_ID,
      runtimeSessionName: encodeRuntimeSessionName({
        agent,
        mode: "prompt",
        sessionMode: input.mode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    if (input.handle.backend !== COVEN_BACKEND_ID) {
      yield* this.runFallbackTurn(input, input.handle);
      return;
    }
    const state = decodeRuntimeSessionName(input.handle.runtimeSessionName);
    if (!state) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "Coven runtime session metadata is missing.",
      );
    }

    let session: CovenSessionRecord;
    try {
      session = await this.client.launchSession(
        {
          projectRoot: state.cwd ?? input.handle.cwd ?? process.cwd(),
          cwd: state.cwd ?? input.handle.cwd ?? process.cwd(),
          harness: this.resolveHarness(state.agent),
          prompt: input.text,
          title: titleFromPrompt(input.text),
        },
        input.signal,
      );
    } catch (error) {
      this.logger?.warn(
        `coven launch failed; falling back to ${this.config.fallbackBackend}: ${String(error)}`,
      );
      yield* this.runFallbackFromCovenHandle(input, state);
      return;
    }

    input.handle.backendSessionId = session.id;
    input.handle.agentSessionId = session.id;
    this.activeSessionIdsBySessionKey.set(input.handle.sessionKey, session.id);
    yield {
      type: "status",
      text: `coven session ${session.id} started (${session.harness})`,
      tag: "session_info_update",
    };

    const seenEventIds = new Set<string>();
    while (true) {
      if (input.signal?.aborted) {
        await this.killActiveSession(session.id, input.signal).catch(() => undefined);
        throw input.signal.reason ?? new Error("Coven turn aborted");
      }

      const events = await this.client.listEvents(session.id, input.signal);
      for (const event of events) {
        if (seenEventIds.has(event.id)) {
          continue;
        }
        seenEventIds.add(event.id);
        for (const runtimeEvent of eventToRuntimeEvents(event)) {
          yield runtimeEvent;
          if (runtimeEvent.type === "done") {
            this.activeSessionIdsBySessionKey.delete(input.handle.sessionKey);
            return;
          }
        }
      }

      const latest = await this.client.getSession(session.id, input.signal);
      if (sessionIsTerminal(latest)) {
        yield terminalStatusEvent(latest);
        yield { type: "done", stopReason: latest.status };
        this.activeSessionIdsBySessionKey.delete(input.handle.sessionKey);
        return;
      }

      await this.sleep(this.config.pollIntervalMs, input.signal);
    }
  }

  getCapabilities() {
    return { controls: ["session/status" as const] };
  }

  async getStatus(
    input: Parameters<NonNullable<AcpRuntime["getStatus"]>>[0],
  ): Promise<AcpRuntimeStatus> {
    if (input.handle.backend !== COVEN_BACKEND_ID) {
      const fallback = this.requireFallbackRuntime(input.handle.backend);
      return fallback.getStatus
        ? await fallback.getStatus(input)
        : { summary: `fallback backend ${input.handle.backend} active` };
    }
    const sessionId =
      input.handle.backendSessionId ??
      this.activeSessionIdsBySessionKey.get(input.handle.sessionKey);
    if (!sessionId) {
      return { summary: "coven runtime ready" };
    }
    const session = await this.client.getSession(sessionId, input.signal);
    return {
      summary: `${session.status} ${session.harness} ${session.title}`,
      backendSessionId: session.id,
      agentSessionId: session.id,
      details: {
        projectRoot: session.projectRoot,
        harness: session.harness,
        status: session.status,
        exitCode: session.exitCode,
      },
    };
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    try {
      const health = await this.client.health();
      return health.ok
        ? { ok: true, message: "Coven daemon is reachable." }
        : { ok: false, code: "COVEN_UNHEALTHY", message: "Coven daemon did not report healthy." };
    } catch (error) {
      return {
        ok: false,
        code: "COVEN_UNAVAILABLE",
        message: "Coven daemon is not reachable; direct ACP fallback remains available.",
        details: [String(error)],
      };
    }
  }

  async cancel(input: Parameters<AcpRuntime["cancel"]>[0]): Promise<void> {
    if (input.handle.backend !== COVEN_BACKEND_ID) {
      await this.requireFallbackRuntime(input.handle.backend).cancel(input);
      return;
    }
    const sessionId =
      input.handle.backendSessionId ??
      this.activeSessionIdsBySessionKey.get(input.handle.sessionKey);
    if (sessionId) {
      await this.killActiveSession(sessionId);
    }
  }

  async close(input: Parameters<AcpRuntime["close"]>[0]): Promise<void> {
    if (input.handle.backend !== COVEN_BACKEND_ID) {
      await this.requireFallbackRuntime(input.handle.backend).close(input);
      return;
    }
    const sessionId =
      input.handle.backendSessionId ??
      this.activeSessionIdsBySessionKey.get(input.handle.sessionKey);
    if (sessionId && input.reason !== "oneshot-complete") {
      await this.killActiveSession(sessionId).catch(() => undefined);
    }
    this.activeSessionIdsBySessionKey.delete(input.handle.sessionKey);
  }

  async prepareFreshSession(input: { sessionKey: string }): Promise<void> {
    this.activeSessionIdsBySessionKey.delete(input.sessionKey);
    const fallback = this.getFallbackRuntime();
    await fallback?.prepareFreshSession?.(input);
  }

  private async isCovenAvailable(): Promise<boolean> {
    try {
      const health = await this.client.health();
      return health.ok === true;
    } catch {
      return false;
    }
  }

  private resolveHarness(agent: string): string {
    const normalized = normalizeAgentId(agent);
    return this.config.harnesses[normalized] ?? DEFAULT_HARNESSES[normalized] ?? normalized;
  }

  private getFallbackRuntime(backendId = this.config.fallbackBackend): AcpRuntime | null {
    const normalized = backendId.trim().toLowerCase();
    if (!normalized || normalized === COVEN_BACKEND_ID) {
      return null;
    }
    return getAcpRuntimeBackend(normalized)?.runtime ?? null;
  }

  private requireFallbackRuntime(backendId = this.config.fallbackBackend): AcpRuntime {
    const runtime = this.getFallbackRuntime(backendId);
    if (!runtime) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        `Coven fallback ACP backend "${backendId}" is not registered.`,
      );
    }
    return runtime;
  }

  private async ensureFallbackSession(
    input: Parameters<AcpRuntime["ensureSession"]>[0],
  ): Promise<AcpRuntimeHandle> {
    return await this.requireFallbackRuntime().ensureSession(input);
  }

  private async *runFallbackTurn(
    input: AcpRuntimeTurnInput,
    handle: AcpRuntimeHandle,
  ): AsyncIterable<AcpRuntimeEvent> {
    yield* this.requireFallbackRuntime(handle.backend).runTurn({ ...input, handle });
  }

  private async *runFallbackFromCovenHandle(
    input: AcpRuntimeTurnInput,
    state: CovenRuntimeSessionState,
  ): AsyncIterable<AcpRuntimeEvent> {
    const fallback = this.requireFallbackRuntime();
    const cwd = state.cwd ?? input.handle.cwd;
    const handle = await fallback.ensureSession({
      sessionKey: input.handle.sessionKey,
      agent: state.agent,
      mode: state.sessionMode === "persistent" ? "persistent" : "oneshot",
      ...(cwd ? { cwd: path.resolve(cwd) } : {}),
    });
    Object.assign(input.handle, handle);
    yield* fallback.runTurn({ ...input, handle });
  }

  private async killActiveSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.client.killSession(sessionId, signal);
  }
}

export const __testing = {
  decodeRuntimeSessionName,
  encodeRuntimeSessionName,
  eventToRuntimeEvents,
};
