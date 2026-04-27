import fs from "node:fs";
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
import { pathIsInside, realpathIfExists } from "./path-utils.js";

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
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const MAX_COVEN_PROMPT_BYTES = 500_000;
const MIN_POLL_INTERVAL_MS = 25;
const MAX_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_EVENTS_PER_POLL = 500;
const MAX_EVENT_PAYLOAD_BYTES = 64_000;
const MAX_TRACKED_EVENT_IDS = 10_000;
const MAX_RUNTIME_SESSION_NAME_BYTES = 2_048;
const MAX_RUNTIME_AGENT_CHARS = 128;
const MAX_RUNTIME_MODE_CHARS = 32;
const MAX_STATUS_FIELD_CHARS = 256;
const MAX_SESSION_ID_CHARS = 128;
const SAFE_SESSION_ID_REGEX = /^[A-Za-z0-9._:-]+$/;

type CovenRuntimeSessionState = {
  agent: string;
  mode: string;
  sessionMode?: string;
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
  const prefix = "coven:";
  const safeState: CovenRuntimeSessionState = {
    agent: normalizeAgentId(state.agent).slice(0, MAX_RUNTIME_AGENT_CHARS) || "codex",
    mode: (state.mode.trim() || "prompt").slice(0, MAX_RUNTIME_MODE_CHARS),
    ...(state.sessionMode
      ? { sessionMode: state.sessionMode.trim().slice(0, MAX_RUNTIME_MODE_CHARS) }
      : {}),
  };
  const encoded = Buffer.from(JSON.stringify(safeState), "utf8").toString("base64url");
  const value = `${prefix}${encoded}`;
  if (Buffer.byteLength(value, "utf8") > prefix.length + MAX_RUNTIME_SESSION_NAME_BYTES) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "Coven runtime session metadata is too large.",
    );
  }
  return value;
}

function decodeRuntimeSessionName(value: string): CovenRuntimeSessionState | null {
  const prefix = "coven:";
  if (!value.startsWith(prefix) || value.length > prefix.length + MAX_RUNTIME_SESSION_NAME_BYTES) {
    return null;
  }
  const encoded = value.slice(prefix.length);
  if (!encoded) {
    return null;
  }
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.byteLength > MAX_RUNTIME_SESSION_NAME_BYTES) {
      return null;
    }
    const jsonText = decoded.toString("utf8");
    if (Buffer.byteLength(jsonText, "utf8") > MAX_RUNTIME_SESSION_NAME_BYTES) {
      return null;
    }
    const parsed = JSON.parse(jsonText) as Partial<CovenRuntimeSessionState>;
    const agent = normalizeAgentId(typeof parsed.agent === "string" ? parsed.agent : undefined);
    return {
      agent,
      mode: typeof parsed.mode === "string" ? parsed.mode : "prompt",
      ...(typeof parsed.sessionMode === "string" ? { sessionMode: parsed.sessionMode } : {}),
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
  const compact = sanitizeStatusText(prompt);
  return compact.slice(0, 80) || "OpenClaw task";
}

function parsePayload(event: CovenEventRecord): Record<string, unknown> {
  if (Buffer.byteLength(event.payloadJson, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    return {};
  }
  try {
    const parsed = JSON.parse(event.payloadJson) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const c0Start = String.fromCharCode(0x00);
const c0Backspace = String.fromCharCode(0x08);
const c0VerticalTab = String.fromCharCode(0x0b);
const c0UnitSeparator = String.fromCharCode(0x1f);
const del = String.fromCharCode(0x7f);
const c1Start = String.fromCharCode(0x80);
const c1End = String.fromCharCode(0x9f);
const BIDI_CONTROL_REGEX = /\p{Bidi_Control}/gu;
const ANSI_ESCAPE_REGEX = new RegExp(
  `${ESC}(?:\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)|P[\\s\\S]*?${ESC}\\\\|\\[[\\x20-\\x3f]*[\\x40-\\x7e]|[\\x20-\\x2f]*[\\x30-\\x7e])`,
  "g",
);
const TEXT_CONTROL_REGEX = new RegExp(
  `[${c0Start}-${c0Backspace}${c0VerticalTab}-${c0UnitSeparator}${del}${c1Start}-${c1End}]`,
  "g",
);

function sanitizeTerminalText(input: string): string {
  return input
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(TEXT_CONTROL_REGEX, "")
    .replace(BIDI_CONTROL_REGEX, "");
}

function sanitizeStatusText(input: string): string {
  return sanitizeTerminalText(input).replace(/\s+/g, " ").trim();
}

function sanitizeStatusField(input: string, fallback = "unknown"): string {
  return sanitizeStatusText(input).slice(0, MAX_STATUS_FIELD_CHARS) || fallback;
}

function requireSafeSessionId(input: string): string {
  const value = input.trim();
  if (!value || value.length > MAX_SESSION_ID_CHARS || !SAFE_SESSION_ID_REGEX.test(value)) {
    throw new Error("Coven session id is invalid");
  }
  return value;
}

function boundedCovenPrompt(input: string): string {
  if (Buffer.byteLength(input, "utf8") > MAX_COVEN_PROMPT_BYTES) {
    throw new Error("Coven prompt exceeded size limit");
  }
  return input;
}

function normalizePollIntervalMs(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, value));
}

function normalizeStopReason(value: unknown): string {
  const normalized =
    typeof value === "string" ? sanitizeStatusText(value).toLowerCase() : "completed";
  if (normalized === "completed" || normalized === "complete" || normalized === "success") {
    return "completed";
  }
  if (normalized === "killed" || normalized === "cancelled" || normalized === "canceled") {
    return "cancelled";
  }
  if (normalized === "failed" || normalized === "failure" || normalized === "error") {
    return "error";
  }
  return "completed";
}

function eventToRuntimeEvents(event: CovenEventRecord): AcpRuntimeEvent[] {
  const payload = parsePayload(event);
  if (event.kind === "output") {
    const text = typeof payload.data === "string" ? sanitizeTerminalText(payload.data) : "";
    return text ? [{ type: "text_delta", text, stream: "output", tag: "agent_message_chunk" }] : [];
  }
  if (event.kind === "exit") {
    const status = sanitizeStatusField(
      typeof payload.status === "string" ? payload.status : "completed",
      "completed",
    );
    const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
    return [
      {
        type: "status",
        text: `coven session ${status}${exitCode == null ? "" : ` exitCode=${exitCode}`}`,
        tag: "session_info_update",
      },
      { type: "done", stopReason: normalizeStopReason(status) },
    ];
  }
  if (event.kind === "kill") {
    return [
      { type: "status", text: "coven session killed", tag: "session_info_update" },
      { type: "done", stopReason: "cancelled" },
    ];
  }
  return [];
}

function sessionIsTerminal(session: CovenSessionRecord): boolean {
  return session.status !== "running" && session.status !== "created";
}

function terminalStatusEvent(session: CovenSessionRecord): AcpRuntimeEvent {
  const status = sanitizeStatusField(session.status, "completed");
  const exitCode = typeof session.exitCode === "number" ? session.exitCode : null;
  return {
    type: "status",
    text: `coven session ${status}${exitCode == null ? "" : ` exitCode=${exitCode}`}`,
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
    this.config = {
      ...params.config,
      pollIntervalMs: normalizePollIntervalMs(params.config.pollIntervalMs),
    };
    this.logger = params.logger;
    this.client =
      params.client ??
      createCovenClient(params.config.socketPath, { socketRoot: params.config.covenHome });
    this.sleep = params.sleep ?? defaultSleep;
  }

  async ensureSession(
    input: Parameters<AcpRuntime["ensureSession"]>[0],
  ): Promise<AcpRuntimeHandle> {
    if (!(await this.isCovenAvailable())) {
      if (!this.config.allowFallback) {
        throw new AcpRuntimeError(
          "ACP_BACKEND_UNAVAILABLE",
          "Coven is unavailable and fallback is disabled.",
        );
      }
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

    const cwd = this.resolveWorkspaceCwd(input.handle.cwd);
    let session: CovenSessionRecord;
    let sessionId: string;
    try {
      const prompt = boundedCovenPrompt(input.text);
      session = await this.client.launchSession(
        {
          projectRoot: this.config.workspaceDir,
          cwd,
          harness: this.resolveHarness(state.agent),
          prompt,
          title: titleFromPrompt(prompt),
        },
        input.signal,
      );
      sessionId = requireSafeSessionId(session.id);
    } catch (error) {
      if (!this.config.allowFallback) {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          `Coven launch failed and fallback is disabled: ${String(error)}`,
          { cause: error },
        );
      }
      this.logger?.warn(
        `coven launch failed; falling back to ${this.config.fallbackBackend}: ${String(error)}`,
      );
      yield* this.runFallbackFromCovenHandle(input, state);
      return;
    }

    input.handle.backendSessionId = sessionId;
    input.handle.agentSessionId = sessionId;
    this.activeSessionIdsBySessionKey.set(input.handle.sessionKey, sessionId);
    yield {
      type: "status",
      text: `coven session ${sessionId} started (${sanitizeStatusField(session.harness)})`,
      tag: "session_info_update",
    };

    const seenEventIds = new Set<string>();
    const seenEventQueue: string[] = [];
    let lastSeenEventId: string | undefined;
    while (true) {
      if (input.signal?.aborted) {
        await this.killActiveSession(sessionId).catch(() => undefined);
        throw input.signal.reason ?? new Error("Coven turn aborted");
      }

      try {
        const events = await this.client.listEvents(
          sessionId,
          lastSeenEventId ? { afterEventId: lastSeenEventId } : undefined,
          input.signal,
        );
        if (events.length > MAX_EVENTS_PER_POLL) {
          throw new Error("Coven daemon returned too many events");
        }
        for (const event of events) {
          if (seenEventIds.has(event.id)) {
            continue;
          }
          seenEventIds.add(event.id);
          seenEventQueue.push(event.id);
          while (seenEventQueue.length > MAX_TRACKED_EVENT_IDS) {
            const removed = seenEventQueue.shift();
            if (removed) {
              seenEventIds.delete(removed);
            }
          }
          lastSeenEventId = event.id;
          for (const runtimeEvent of eventToRuntimeEvents(event)) {
            yield runtimeEvent;
            if (runtimeEvent.type === "done") {
              this.activeSessionIdsBySessionKey.delete(input.handle.sessionKey);
              return;
            }
          }
        }

        const latest = await this.client.getSession(sessionId, input.signal);
        if (sessionIsTerminal(latest)) {
          yield terminalStatusEvent(latest);
          yield { type: "done", stopReason: normalizeStopReason(latest.status) };
          this.activeSessionIdsBySessionKey.delete(input.handle.sessionKey);
          return;
        }
      } catch (error) {
        if (input.signal?.aborted) {
          await this.killActiveSession(sessionId).catch(() => undefined);
          throw input.signal.reason ?? error;
        }
        this.logger?.warn(`coven polling failed: ${String(error)}`);
        await this.killActiveSession(sessionId).catch(() => undefined);
        this.activeSessionIdsBySessionKey.delete(input.handle.sessionKey);
        yield { type: "status", text: "coven session polling failed", tag: "session_info_update" };
        yield { type: "done", stopReason: "error" };
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
    const sessionId = this.getTrackedSessionId(input.handle);
    if (!sessionId) {
      return { summary: "coven runtime ready" };
    }
    const session = await this.client.getSession(sessionId, input.signal);
    const status = sanitizeStatusField(session.status, "completed");
    const harness = sanitizeStatusField(session.harness);
    const title = sanitizeStatusField(session.title, "untitled");
    return {
      summary: `${status} ${harness} ${title}`,
      backendSessionId: sessionId,
      agentSessionId: sessionId,
      details: {
        projectRoot: sanitizeStatusField(session.projectRoot),
        harness,
        status,
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
    const sessionId = this.getTrackedSessionId(input.handle);
    if (sessionId) {
      await this.killActiveSession(sessionId);
    }
  }

  async close(input: Parameters<AcpRuntime["close"]>[0]): Promise<void> {
    if (input.handle.backend !== COVEN_BACKEND_ID) {
      await this.requireFallbackRuntime(input.handle.backend).close(input);
      return;
    }
    const sessionId = this.getTrackedSessionId(input.handle);
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
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Coven health check timed out")),
      HEALTH_CHECK_TIMEOUT_MS,
    );
    try {
      const health = await this.client.health(controller.signal);
      return health.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
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
    const handle = await fallback.ensureSession({
      sessionKey: input.handle.sessionKey,
      agent: state.agent,
      mode: state.sessionMode === "persistent" ? "persistent" : "oneshot",
      cwd: this.resolveWorkspaceCwd(input.handle.cwd),
    });
    Object.assign(input.handle, handle);
    yield* fallback.runTurn({ ...input, handle });
  }

  private resolveWorkspaceCwd(candidate: string | undefined): string {
    const cwd = path.resolve(candidate ?? this.config.workspaceDir);
    const workspaceReal = realpathIfExists(this.config.workspaceDir);
    const cwdReal = realpathIfExists(cwd);
    if (!workspaceReal || !cwdReal || !pathIsInside(workspaceReal, cwdReal)) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Coven cwd is outside workspace.");
    }
    try {
      if (!fs.statSync(cwdReal).isDirectory()) {
        throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Coven cwd must be a directory.");
      }
    } catch (error) {
      if (error instanceof AcpRuntimeError) {
        throw error;
      }
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Coven cwd must be a directory.");
    }
    return cwdReal;
  }

  private getTrackedSessionId(handle: AcpRuntimeHandle): string | undefined {
    const tracked = this.activeSessionIdsBySessionKey.get(handle.sessionKey);
    if (!tracked) {
      return undefined;
    }
    if (handle.backendSessionId && handle.backendSessionId !== tracked) {
      throw new AcpRuntimeError(
        "ACP_INVALID_RUNTIME_OPTION",
        "Coven session handle does not match this runtime session.",
      );
    }
    return tracked;
  }

  private async killActiveSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.client.killSession(sessionId, signal);
  }
}

export const __testing = {
  decodeRuntimeSessionName,
  encodeRuntimeSessionName,
  eventToRuntimeEvents,
  normalizeStopReason,
  sanitizeStatusField,
  sanitizeTerminalText,
  titleFromPrompt,
};
