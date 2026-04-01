import { createInterface } from "node:readline";
import type {
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeErrorCode,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
  PluginLogger,
} from "../runtime-api.js";
import { AcpRuntimeError } from "../runtime-api.js";
import { toAcpMcpServers, type ResolvedAcpxPluginConfig } from "./config.js";
import { checkAcpxVersion, type AcpxVersionCheckResult } from "./ensure.js";
import { parseControlJsonError } from "./runtime-internals/control-errors.js";
import {
  parseJsonLines,
  parsePromptEventLine,
  toAcpxErrorEvent,
} from "./runtime-internals/events.js";
import {
  buildMcpProxyAgentCommand,
  resolveAcpxAgentCommand,
} from "./runtime-internals/mcp-agent-command.js";
import {
  resolveSpawnFailure,
  type SpawnCommandCache,
  type SpawnCommandOptions,
  type SpawnResolutionEvent,
  spawnAndCollect,
  spawnWithResolvedCommand,
  waitForExit,
} from "./runtime-internals/process.js";
import {
  asOptionalString,
  asTrimmedString,
  buildPermissionArgs,
  deriveAgentFromSessionKey,
  isRecord,
  type AcpxHandleState,
  type AcpxJsonObject,
} from "./runtime-internals/shared.js";

export const ACPX_BACKEND_ID = "acpx";

const ACPX_RUNTIME_HANDLE_PREFIX = "acpx:v1:";
const DEFAULT_AGENT_FALLBACK = "codex";
const ACPX_EXIT_CODE_PERMISSION_DENIED = 5;
const ACPX_CAPABILITIES: AcpRuntimeCapabilities = {
  controls: ["session/set_mode", "session/set_config_option", "session/status"],
};

type AcpxHealthCheckResult =
  | {
      ok: true;
      versionCheck: Extract<AcpxVersionCheckResult, { ok: true }>;
    }
  | {
      ok: false;
      failure:
        | {
            kind: "version-check";
            versionCheck: Extract<AcpxVersionCheckResult, { ok: false }>;
          }
        | {
            kind: "help-check";
            result: Awaited<ReturnType<typeof spawnAndCollect>>;
          }
        | {
            kind: "exception";
            error: unknown;
          };
    };

type EnsureFailureRecoveryResult = {
  events: AcpxJsonObject[];
  skipPostEnsureReplacement: boolean;
};

function formatPermissionModeGuidance(): string {
  return "Configure plugins.entries.acpx.config.permissionMode to one of: approve-reads, approve-all, deny-all.";
}

function formatAcpxExitMessage(params: {
  stderr: string;
  exitCode: number | null | undefined;
  signal?: NodeJS.Signals | null;
}): string {
  const stderr = params.stderr.trim();
  if (params.exitCode === ACPX_EXIT_CODE_PERMISSION_DENIED) {
    return [
      stderr || "Permission denied by ACP runtime (acpx).",
      "ACPX blocked a write/exec permission request in a non-interactive session.",
      formatPermissionModeGuidance(),
    ].join(" ");
  }
  if (stderr) {
    return stderr;
  }
  if (params.signal) {
    return `acpx exited with signal ${params.signal}`;
  }
  return `acpx exited with code ${params.exitCode ?? "unknown"}`;
}

function didAcpxProcessExitWithFailure(params: {
  exitCode: number | null | undefined;
  signal?: NodeJS.Signals | null;
}): boolean {
  return params.exitCode !== null && params.exitCode !== undefined
    ? params.exitCode !== 0
    : params.signal !== null && params.signal !== undefined;
}

function summarizeLogText(text: string, maxChars = 240): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function shouldRetainNamedSessionForDeadStatus(detail: AcpxJsonObject | undefined): boolean {
  const status = asTrimmedString(detail?.status)?.toLowerCase();
  if (status !== "dead") {
    return false;
  }
  const summary = asTrimmedString(detail?.summary)?.toLowerCase();
  return summary?.includes("queue owner unavailable") ?? false;
}

function resolveResumeSessionIdFromDetail(detail: AcpxJsonObject | undefined): string | undefined {
  return asOptionalString(detail?.acpxSessionId) ?? asOptionalString(detail?.agentSessionId);
}

function formatAcpxControlErrorMessage(params: {
  code?: string;
  message: string;
  stderr: string;
}): string {
  const baseMessage = params.code ? `${params.code}: ${params.message}` : params.message;
  const stderrSummary = summarizeLogText(params.stderr);
  if (!stderrSummary) {
    return baseMessage;
  }
  if (
    /^(?:internal error|acpx reported an error)$/i.test(params.message) &&
    !baseMessage.includes(stderrSummary)
  ) {
    return `${baseMessage} | ${stderrSummary}`;
  }
  return baseMessage;
}

function findSessionIdentifierEvent(events: AcpxJsonObject[]): AcpxJsonObject | undefined {
  return events.find(
    (event) =>
      asOptionalString(event.agentSessionId) ||
      asOptionalString(event.acpxSessionId) ||
      asOptionalString(event.acpxRecordId),
  );
}

export function encodeAcpxRuntimeHandleState(state: AcpxHandleState): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${ACPX_RUNTIME_HANDLE_PREFIX}${payload}`;
}

export function decodeAcpxRuntimeHandleState(runtimeSessionName: string): AcpxHandleState | null {
  const trimmed = runtimeSessionName.trim();
  if (!trimmed.startsWith(ACPX_RUNTIME_HANDLE_PREFIX)) {
    return null;
  }
  const encoded = trimmed.slice(ACPX_RUNTIME_HANDLE_PREFIX.length);
  if (!encoded) {
    return null;
  }
  try {
    const raw = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const name = asTrimmedString(parsed.name);
    const agent = asTrimmedString(parsed.agent);
    const cwd = asTrimmedString(parsed.cwd);
    const mode = asTrimmedString(parsed.mode);
    const acpxRecordId = asOptionalString(parsed.acpxRecordId);
    const backendSessionId = asOptionalString(parsed.backendSessionId);
    const agentSessionId = asOptionalString(parsed.agentSessionId);
    if (!name || !agent || !cwd) {
      return null;
    }
    if (mode !== "persistent" && mode !== "oneshot") {
      return null;
    }
    return {
      name,
      agent,
      cwd,
      mode,
      ...(acpxRecordId ? { acpxRecordId } : {}),
      ...(backendSessionId ? { backendSessionId } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
    };
  } catch {
    return null;
  }
}

export class AcpxRuntime implements AcpRuntime {
  private healthy = false;
  private readonly logger?: PluginLogger;
  private readonly queueOwnerTtlSeconds: number;
  private readonly spawnCommandCache: SpawnCommandCache = {};
  private readonly mcpProxyAgentCommandCache = new Map<string, string>();
  private readonly spawnCommandOptions: SpawnCommandOptions;
  private readonly loggedSpawnResolutions = new Set<string>();

  constructor(
    private readonly config: ResolvedAcpxPluginConfig,
    opts?: {
      logger?: PluginLogger;
      queueOwnerTtlSeconds?: number;
    },
  ) {
    this.logger = opts?.logger;
    const requestedQueueOwnerTtlSeconds = opts?.queueOwnerTtlSeconds;
    this.queueOwnerTtlSeconds =
      typeof requestedQueueOwnerTtlSeconds === "number" &&
      Number.isFinite(requestedQueueOwnerTtlSeconds) &&
      requestedQueueOwnerTtlSeconds >= 0
        ? requestedQueueOwnerTtlSeconds
        : this.config.queueOwnerTtlSeconds;
    this.spawnCommandOptions = {
      strictWindowsCmdWrapper: this.config.strictWindowsCmdWrapper,
      cache: this.spawnCommandCache,
      onResolved: (event) => {
        this.logSpawnResolution(event);
      },
    };
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  private logSpawnResolution(event: SpawnResolutionEvent): void {
    const key = `${event.command}::${event.strictWindowsCmdWrapper ? "strict" : "compat"}::${event.resolution}`;
    if (event.cacheHit || this.loggedSpawnResolutions.has(key)) {
      return;
    }
    this.loggedSpawnResolutions.add(key);
    this.logger?.debug?.(
      `acpx spawn resolver: command=${event.command} mode=${event.strictWindowsCmdWrapper ? "strict" : "compat"} resolution=${event.resolution}`,
    );
  }

  private async checkVersion(): Promise<AcpxVersionCheckResult> {
    return await checkAcpxVersion({
      command: this.config.command,
      cwd: this.config.cwd,
      expectedVersion: this.config.expectedVersion,
      stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars,
      spawnOptions: this.spawnCommandOptions,
    });
  }

  private async runHelpCheck(): Promise<Awaited<ReturnType<typeof spawnAndCollect>>> {
    return await spawnAndCollect(
      {
        command: this.config.command,
        args: ["--help"],
        cwd: this.config.cwd,
        stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars,
      },
      this.spawnCommandOptions,
    );
  }

  private async checkHealth(): Promise<AcpxHealthCheckResult> {
    const versionCheck = await this.checkVersion();
    if (!versionCheck.ok) {
      return {
        ok: false,
        failure: {
          kind: "version-check",
          versionCheck,
        },
      };
    }

    try {
      const result = await this.runHelpCheck();
      if (
        result.error != null ||
        didAcpxProcessExitWithFailure({
          exitCode: result.code,
          signal: result.signal,
        })
      ) {
        return {
          ok: false,
          failure: {
            kind: "help-check",
            result,
          },
        };
      }
      return {
        ok: true,
        versionCheck,
      };
    } catch (error) {
      return {
        ok: false,
        failure: {
          kind: "exception",
          error,
        },
      };
    }
  }

  async probeAvailability(): Promise<void> {
    const result = await this.checkHealth();
    this.healthy = result.ok;
  }

  private async createNamedSession(params: {
    agent: string;
    cwd: string;
    sessionName: string;
    resumeSessionId?: string;
  }): Promise<AcpxJsonObject[]> {
    const command = params.resumeSessionId
      ? [
          "sessions",
          "new",
          "--name",
          params.sessionName,
          "--resume-session",
          params.resumeSessionId,
        ]
      : ["sessions", "new", "--name", params.sessionName];
    return await this.runControlCommand({
      args: await this.buildVerbArgs({
        agent: params.agent,
        cwd: params.cwd,
        command,
      }),
      cwd: params.cwd,
      fallbackCode: "ACP_SESSION_INIT_FAILED",
    });
  }

  private async replaceDeadNamedSession(params: {
    detail: AcpxJsonObject | undefined;
    sessionName: string;
    agent: string;
    cwd: string;
    logContext: string;
  }): Promise<AcpxJsonObject[]> {
    const resumeSessionId = resolveResumeSessionIdFromDetail(params.detail);
    this.logger?.warn?.(
      resumeSessionId
        ? `acpx ensureSession repairing dead named session by resuming backend session: session=${params.sessionName} cwd=${params.cwd} resumeSessionId=${resumeSessionId} ${params.logContext}`
        : `acpx ensureSession repairing dead named session with fresh session owner: session=${params.sessionName} cwd=${params.cwd} ${params.logContext}`,
    );
    return await this.createNamedSession({
      agent: params.agent,
      cwd: params.cwd,
      sessionName: params.sessionName,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
  }

  private async shouldReplaceEnsuredSession(params: {
    sessionName: string;
    agent: string;
    cwd: string;
  }): Promise<{ replace: boolean; replacementEvents?: AcpxJsonObject[] }> {
    const args = await this.buildVerbArgs({
      agent: params.agent,
      cwd: params.cwd,
      command: ["status", "--session", params.sessionName],
    });
    let events: AcpxJsonObject[];
    try {
      events = await this.runControlCommand({
        args,
        cwd: params.cwd,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        ignoreNoSession: true,
      });
    } catch (error) {
      this.logger?.warn?.(
        `acpx ensureSession status probe failed: session=${params.sessionName} cwd=${params.cwd} error=${summarizeLogText(error instanceof Error ? error.message : String(error)) || "<empty>"}`,
      );
      return { replace: false };
    }

    const noSession = events.some((event) => toAcpxErrorEvent(event)?.code === "NO_SESSION");
    if (noSession) {
      this.logger?.warn?.(
        `acpx ensureSession replacing missing named session: session=${params.sessionName} cwd=${params.cwd}`,
      );
      return { replace: true };
    }

    const detail = events.find((event) => !toAcpxErrorEvent(event));
    const status = asTrimmedString(detail?.status)?.toLowerCase();
    if (status === "dead") {
      const summary = summarizeLogText(asOptionalString(detail?.summary) ?? "");
      if (shouldRetainNamedSessionForDeadStatus(detail)) {
        return {
          replace: true,
          replacementEvents: await this.replaceDeadNamedSession({
            detail,
            sessionName: params.sessionName,
            agent: params.agent,
            cwd: params.cwd,
            logContext: `status=${status} summary=${summary || "<empty>"}`,
          }),
        };
      }
      this.logger?.warn?.(
        `acpx ensureSession replacing dead named session: session=${params.sessionName} cwd=${params.cwd} status=${status} summary=${summary || "<empty>"}`,
      );
      return { replace: true };
    }

    return { replace: false };
  }

  private async recoverEnsureFailure(params: {
    sessionName: string;
    agent: string;
    cwd: string;
    error: unknown;
  }): Promise<EnsureFailureRecoveryResult | null> {
    const errorMessage = summarizeLogText(
      params.error instanceof Error ? params.error.message : String(params.error),
    );
    this.logger?.warn?.(
      `acpx ensureSession probing named session after ensure failure: session=${params.sessionName} cwd=${params.cwd} error=${errorMessage || "<empty>"}`,
    );
    const args = await this.buildVerbArgs({
      agent: params.agent,
      cwd: params.cwd,
      command: ["status", "--session", params.sessionName],
    });
    let events: AcpxJsonObject[];
    try {
      events = await this.runControlCommand({
        args,
        cwd: params.cwd,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        ignoreNoSession: true,
      });
    } catch (statusError) {
      this.logger?.warn?.(
        `acpx ensureSession status fallback failed: session=${params.sessionName} cwd=${params.cwd} error=${summarizeLogText(statusError instanceof Error ? statusError.message : String(statusError)) || "<empty>"}`,
      );
      return null;
    }

    const noSession = events.some((event) => toAcpxErrorEvent(event)?.code === "NO_SESSION");
    if (noSession) {
      this.logger?.warn?.(
        `acpx ensureSession creating named session after ensure failure and missing status: session=${params.sessionName} cwd=${params.cwd}`,
      );
      return {
        events: await this.createNamedSession({
          agent: params.agent,
          cwd: params.cwd,
          sessionName: params.sessionName,
        }),
        skipPostEnsureReplacement: true,
      };
    }

    const detail = events.find((event) => !toAcpxErrorEvent(event));
    const status = asTrimmedString(detail?.status)?.toLowerCase();
    if (status === "dead") {
      const summary = summarizeLogText(asOptionalString(detail?.summary) ?? "");
      if (shouldRetainNamedSessionForDeadStatus(detail)) {
        return {
          events: await this.replaceDeadNamedSession({
            detail,
            sessionName: params.sessionName,
            agent: params.agent,
            cwd: params.cwd,
            logContext: `status=${status} summary=${summary || "<empty>"}`,
          }),
          skipPostEnsureReplacement: true,
        };
      }
      this.logger?.warn?.(
        `acpx ensureSession replacing dead named session after ensure failure: session=${params.sessionName} cwd=${params.cwd}`,
      );
      return {
        events: await this.createNamedSession({
          agent: params.agent,
          cwd: params.cwd,
          sessionName: params.sessionName,
        }),
        skipPostEnsureReplacement: true,
      };
    }

    if (status === "alive" || findSessionIdentifierEvent(events)) {
      this.logger?.warn?.(
        `acpx ensureSession reusing live named session after ensure failure: session=${params.sessionName} cwd=${params.cwd} status=${status || "unknown"}`,
      );
      return {
        events,
        skipPostEnsureReplacement: false,
      };
    }

    return null;
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const sessionName = asTrimmedString(input.sessionKey);
    if (!sessionName) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const agent = asTrimmedString(input.agent);
    if (!agent) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP agent id is required.");
    }
    const cwd = asTrimmedString(input.cwd) || this.config.cwd;
    const mode = input.mode;
    const resumeSessionId = asTrimmedString(input.resumeSessionId);
    let events: AcpxJsonObject[];
    let skipPostEnsureReplacement = false;
    if (resumeSessionId) {
      events = await this.createNamedSession({
        agent,
        cwd,
        sessionName,
        resumeSessionId,
      });
    } else {
      try {
        events = await this.runControlCommand({
          args: await this.buildVerbArgs({
            agent,
            cwd,
            command: ["sessions", "ensure", "--name", sessionName],
          }),
          cwd,
          fallbackCode: "ACP_SESSION_INIT_FAILED",
        });
      } catch (error) {
        const recovered = await this.recoverEnsureFailure({
          sessionName,
          agent,
          cwd,
          error,
        });
        if (!recovered) {
          throw error;
        }
        events = recovered.events;
        skipPostEnsureReplacement = recovered.skipPostEnsureReplacement;
      }
    }
    if (events.length === 0) {
      this.logger?.warn?.(
        `acpx ensureSession returned no events after sessions ensure: session=${sessionName} agent=${agent} cwd=${cwd}`,
      );
    }
    let ensuredEvent = findSessionIdentifierEvent(events);

    if (ensuredEvent && !resumeSessionId && !skipPostEnsureReplacement) {
      const replacement = await this.shouldReplaceEnsuredSession({
        sessionName,
        agent,
        cwd,
      });
      if (replacement.replace) {
        events =
          replacement.replacementEvents ??
          (await this.createNamedSession({
            agent,
            cwd,
            sessionName,
          }));
        if (events.length === 0) {
          this.logger?.warn?.(
            `acpx ensureSession returned no events after replacing dead session: session=${sessionName} agent=${agent} cwd=${cwd}`,
          );
        }
        ensuredEvent = findSessionIdentifierEvent(events);
      }
    }

    if (!ensuredEvent && !resumeSessionId) {
      events = await this.createNamedSession({
        agent,
        cwd,
        sessionName,
      });
      if (events.length === 0) {
        this.logger?.warn?.(
          `acpx ensureSession returned no events after sessions new: session=${sessionName} agent=${agent} cwd=${cwd}`,
        );
      }
      ensuredEvent = findSessionIdentifierEvent(events);
    }
    if (!ensuredEvent) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        resumeSessionId
          ? `ACP session init failed: 'sessions new --resume-session' returned no session identifiers for ${sessionName}.`
          : `ACP session init failed: neither 'sessions ensure' nor 'sessions new' returned valid session identifiers for ${sessionName}.`,
      );
    }

    const acpxRecordId = ensuredEvent ? asOptionalString(ensuredEvent.acpxRecordId) : undefined;
    const agentSessionId = ensuredEvent ? asOptionalString(ensuredEvent.agentSessionId) : undefined;
    const backendSessionId = ensuredEvent
      ? asOptionalString(ensuredEvent.acpxSessionId)
      : undefined;

    return {
      sessionKey: input.sessionKey,
      backend: ACPX_BACKEND_ID,
      runtimeSessionName: encodeAcpxRuntimeHandleState({
        name: sessionName,
        agent,
        cwd,
        mode,
        ...(acpxRecordId ? { acpxRecordId } : {}),
        ...(backendSessionId ? { backendSessionId } : {}),
        ...(agentSessionId ? { agentSessionId } : {}),
      }),
      cwd,
      ...(acpxRecordId ? { acpxRecordId } : {}),
      ...(backendSessionId ? { backendSessionId } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const state = this.resolveHandleState(input.handle);
    const args = await this.buildPromptArgs({
      agent: state.agent,
      sessionName: state.name,
      cwd: state.cwd,
    });

    const cancelOnAbort = async () => {
      await this.cancel({
        handle: input.handle,
        reason: "abort-signal",
      }).catch((err) => {
        this.logger?.warn?.(`acpx runtime abort-cancel failed: ${String(err)}`);
      });
    };
    const onAbort = () => {
      void cancelOnAbort();
    };

    if (input.signal?.aborted) {
      await cancelOnAbort();
      return;
    }
    if (input.signal) {
      input.signal.addEventListener("abort", onAbort, { once: true });
    }
    const child = spawnWithResolvedCommand(
      {
        command: this.config.command,
        args,
        cwd: state.cwd,
        stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars,
      },
      this.spawnCommandOptions,
    );
    child.stdin.on("error", () => {
      // Ignore EPIPE when the child exits before stdin flush completes.
    });

    if (input.attachments && input.attachments.length > 0) {
      const blocks: unknown[] = [];
      if (input.text) {
        blocks.push({ type: "text", text: input.text });
      }
      for (const attachment of input.attachments) {
        if (attachment.mediaType.startsWith("image/")) {
          blocks.push({ type: "image", mimeType: attachment.mediaType, data: attachment.data });
        }
      }
      child.stdin.end(blocks.length > 0 ? JSON.stringify(blocks) : input.text);
    } else {
      child.stdin.end(input.text);
    }

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    let sawDone = false;
    let sawError = false;
    const lines = createInterface({ input: child.stdout });
    try {
      for await (const line of lines) {
        const parsed = parsePromptEventLine(line);
        if (!parsed) {
          continue;
        }
        if (parsed.type === "done") {
          if (sawDone) {
            continue;
          }
          sawDone = true;
        }
        if (parsed.type === "error") {
          sawError = true;
        }
        yield parsed;
      }

      const exit = await waitForExit(child);
      if (exit.error) {
        const spawnFailure = resolveSpawnFailure(exit.error, state.cwd);
        if (spawnFailure === "missing-command") {
          this.healthy = false;
          throw new AcpRuntimeError(
            "ACP_BACKEND_UNAVAILABLE",
            `acpx command not found: ${this.config.command}`,
            { cause: exit.error },
          );
        }
        if (spawnFailure === "missing-cwd") {
          throw new AcpRuntimeError(
            "ACP_TURN_FAILED",
            `ACP runtime working directory does not exist: ${state.cwd}`,
            { cause: exit.error },
          );
        }
        throw new AcpRuntimeError("ACP_TURN_FAILED", exit.error.message, { cause: exit.error });
      }

      const exitedWithFailure = didAcpxProcessExitWithFailure({
        exitCode: exit.code,
        signal: exit.signal,
      });
      if (exitedWithFailure && !sawError) {
        yield {
          type: "error",
          message: formatAcpxExitMessage({
            stderr,
            exitCode: exit.code,
            signal: exit.signal,
          }),
        };
        return;
      }

      if (!sawDone && !sawError) {
        yield { type: "done" };
      }
    } finally {
      lines.close();
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  getCapabilities(): AcpRuntimeCapabilities {
    return ACPX_CAPABILITIES;
  }

  async getStatus(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus> {
    const state = this.resolveHandleState(input.handle);
    const args = await this.buildVerbArgs({
      agent: state.agent,
      cwd: state.cwd,
      command: ["status", "--session", state.name],
    });
    const events = await this.runControlCommand({
      args,
      cwd: state.cwd,
      fallbackCode: "ACP_TURN_FAILED",
      ignoreNoSession: true,
      signal: input.signal,
    });
    const detail = events.find((event) => !toAcpxErrorEvent(event)) ?? events[0];
    if (!detail) {
      return {
        summary: "acpx status unavailable",
      };
    }
    const status = asTrimmedString(detail.status) || "unknown";
    const acpxRecordId = asOptionalString(detail.acpxRecordId);
    const acpxSessionId = asOptionalString(detail.acpxSessionId);
    const agentSessionId = asOptionalString(detail.agentSessionId);
    const pid = typeof detail.pid === "number" && Number.isFinite(detail.pid) ? detail.pid : null;
    const summary = [
      `status=${status}`,
      acpxRecordId ? `acpxRecordId=${acpxRecordId}` : null,
      acpxSessionId ? `acpxSessionId=${acpxSessionId}` : null,
      pid != null ? `pid=${pid}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return {
      summary,
      ...(acpxRecordId ? { acpxRecordId } : {}),
      ...(acpxSessionId ? { backendSessionId: acpxSessionId } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
      details: detail,
    };
  }

  async setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const mode = asTrimmedString(input.mode);
    if (!mode) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP runtime mode is required.");
    }
    const args = await this.buildVerbArgs({
      agent: state.agent,
      cwd: state.cwd,
      command: ["set-mode", mode, "--session", state.name],
    });
    await this.runControlCommand({
      args,
      cwd: state.cwd,
      fallbackCode: "ACP_TURN_FAILED",
    });
  }

  async setConfigOption(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const key = asTrimmedString(input.key);
    const value = asTrimmedString(input.value);
    if (!key || !value) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP config option key/value are required.");
    }
    const args = await this.buildVerbArgs({
      agent: state.agent,
      cwd: state.cwd,
      command: ["set", key, value, "--session", state.name],
    });
    await this.runControlCommand({
      args,
      cwd: state.cwd,
      fallbackCode: "ACP_TURN_FAILED",
    });
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    const result = await this.checkHealth();
    if (!result.ok && result.failure.kind === "version-check") {
      const { versionCheck } = result.failure;
      this.healthy = false;
      const details = [
        versionCheck.expectedVersion ? `expected=${versionCheck.expectedVersion}` : null,
        versionCheck.installedVersion ? `installed=${versionCheck.installedVersion}` : null,
      ].filter((detail): detail is string => Boolean(detail));
      return {
        ok: false,
        code: "ACP_BACKEND_UNAVAILABLE",
        message: versionCheck.message,
        installCommand: versionCheck.installCommand,
        details,
      };
    }

    if (!result.ok && result.failure.kind === "help-check") {
      const { result: helpResult } = result.failure;
      this.healthy = false;
      if (helpResult.error) {
        const spawnFailure = resolveSpawnFailure(helpResult.error, this.config.cwd);
        if (spawnFailure === "missing-command") {
          return {
            ok: false,
            code: "ACP_BACKEND_UNAVAILABLE",
            message: `acpx command not found: ${this.config.command}`,
            installCommand: this.config.installCommand,
          };
        }
        if (spawnFailure === "missing-cwd") {
          return {
            ok: false,
            code: "ACP_BACKEND_UNAVAILABLE",
            message: `ACP runtime working directory does not exist: ${this.config.cwd}`,
          };
        }
        return {
          ok: false,
          code: "ACP_BACKEND_UNAVAILABLE",
          message: helpResult.error.message,
          details: [String(helpResult.error)],
        };
      }
      return {
        ok: false,
        code: "ACP_BACKEND_UNAVAILABLE",
        message:
          helpResult.stderr.trim() || `acpx exited with code ${helpResult.code ?? "unknown"}`,
      };
    }

    if (!result.ok) {
      this.healthy = false;
      const failure = result.failure;
      return {
        ok: false,
        code: "ACP_BACKEND_UNAVAILABLE",
        message:
          failure.kind === "exception"
            ? failure.error instanceof Error
              ? failure.error.message
              : String(failure.error)
            : "acpx backend unavailable",
      };
    }

    this.healthy = true;
    return {
      ok: true,
      message: `acpx command available (${this.config.command}, version ${result.versionCheck.version}${this.config.expectedVersion ? `, expected ${this.config.expectedVersion}` : ""})`,
    };
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const args = await this.buildVerbArgs({
      agent: state.agent,
      cwd: state.cwd,
      command: ["cancel", "--session", state.name],
    });
    await this.runControlCommand({
      args,
      cwd: state.cwd,
      fallbackCode: "ACP_TURN_FAILED",
      ignoreNoSession: true,
    });
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const args = await this.buildVerbArgs({
      agent: state.agent,
      cwd: state.cwd,
      command: ["sessions", "close", state.name],
    });
    await this.runControlCommand({
      args,
      cwd: state.cwd,
      fallbackCode: "ACP_TURN_FAILED",
      ignoreNoSession: true,
    });
  }

  private resolveHandleState(handle: AcpRuntimeHandle): AcpxHandleState {
    const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
    if (decoded) {
      return decoded;
    }

    const legacyName = asTrimmedString(handle.runtimeSessionName);
    if (!legacyName) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "Invalid acpx runtime handle: runtimeSessionName is missing.",
      );
    }

    return {
      name: legacyName,
      agent: deriveAgentFromSessionKey(handle.sessionKey, DEFAULT_AGENT_FALLBACK),
      cwd: this.config.cwd,
      mode: "persistent",
    };
  }

  private async buildPromptArgs(params: {
    agent: string;
    sessionName: string;
    cwd: string;
  }): Promise<string[]> {
    const prefix = [
      "--format",
      "json",
      "--json-strict",
      "--cwd",
      params.cwd,
      ...buildPermissionArgs(this.config.permissionMode),
      "--non-interactive-permissions",
      this.config.nonInteractivePermissions,
    ];
    if (this.config.timeoutSeconds) {
      prefix.push("--timeout", String(this.config.timeoutSeconds));
    }
    prefix.push("--ttl", String(this.queueOwnerTtlSeconds));
    return await this.buildVerbArgs({
      agent: params.agent,
      cwd: params.cwd,
      command: ["prompt", "--session", params.sessionName, "--file", "-"],
      prefix,
    });
  }

  private async buildVerbArgs(params: {
    agent: string;
    cwd: string;
    command: string[];
    prefix?: string[];
  }): Promise<string[]> {
    const prefix = params.prefix ?? ["--format", "json", "--json-strict", "--cwd", params.cwd];
    const agentCommand = await this.resolveRawAgentCommand({
      agent: params.agent,
      cwd: params.cwd,
    });
    if (!agentCommand) {
      return [...prefix, params.agent, ...params.command];
    }
    return [...prefix, "--agent", agentCommand, ...params.command];
  }

  private async resolveRawAgentCommand(params: {
    agent: string;
    cwd: string;
  }): Promise<string | null> {
    if (Object.keys(this.config.mcpServers).length === 0) {
      return null;
    }
    const cacheKey = `${params.cwd}::${params.agent}`;
    const cached = this.mcpProxyAgentCommandCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const targetCommand = await resolveAcpxAgentCommand({
      acpxCommand: this.config.command,
      cwd: params.cwd,
      agent: params.agent,
      stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars,
      spawnOptions: this.spawnCommandOptions,
    });
    if (!targetCommand) {
      return null;
    }
    const resolved = buildMcpProxyAgentCommand({
      targetCommand,
      mcpServers: toAcpMcpServers(this.config.mcpServers),
    });
    this.mcpProxyAgentCommandCache.set(cacheKey, resolved);
    return resolved;
  }

  private async runControlCommand(params: {
    args: string[];
    cwd: string;
    fallbackCode: AcpRuntimeErrorCode;
    ignoreNoSession?: boolean;
    signal?: AbortSignal;
  }): Promise<AcpxJsonObject[]> {
    const result = await spawnAndCollect(
      {
        command: this.config.command,
        args: params.args,
        cwd: params.cwd,
        stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars,
      },
      this.spawnCommandOptions,
      {
        signal: params.signal,
      },
    );

    if (result.error) {
      const spawnFailure = resolveSpawnFailure(result.error, params.cwd);
      if (spawnFailure === "missing-command") {
        this.healthy = false;
        throw new AcpRuntimeError(
          "ACP_BACKEND_UNAVAILABLE",
          `acpx command not found: ${this.config.command}`,
          { cause: result.error },
        );
      }
      if (spawnFailure === "missing-cwd") {
        throw new AcpRuntimeError(
          params.fallbackCode,
          `ACP runtime working directory does not exist: ${params.cwd}`,
          { cause: result.error },
        );
      }
      throw new AcpRuntimeError(params.fallbackCode, result.error.message, { cause: result.error });
    }

    const events = parseJsonLines(result.stdout);
    const errorEvent =
      events
        .map((event) => toAcpxErrorEvent(event) ?? parseControlJsonError(event))
        .find(Boolean) ?? null;
    if (errorEvent) {
      if (params.ignoreNoSession && errorEvent.code === "NO_SESSION") {
        return events;
      }
      throw new AcpRuntimeError(
        params.fallbackCode,
        formatAcpxControlErrorMessage({
          code: errorEvent.code,
          message: errorEvent.message,
          stderr: result.stderr,
        }),
      );
    }

    if (
      didAcpxProcessExitWithFailure({
        exitCode: result.code,
        signal: result.signal,
      })
    ) {
      throw new AcpRuntimeError(
        params.fallbackCode,
        formatAcpxExitMessage({
          stderr: result.stderr,
          exitCode: result.code,
          signal: result.signal,
        }),
      );
    }
    return events;
  }
}
