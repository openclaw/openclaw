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
} from "openclaw/plugin-sdk/acpx";
import { AcpRuntimeError } from "openclaw/plugin-sdk/acpx";
import { toAcpMcpServers, type ResolvedAcpxPluginConfig } from "./config.js";
import { checkAcpxVersion } from "./ensure.js";
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

function formatPermissionModeGuidance(): string {
  return "Configure plugins.entries.acpx.config.permissionMode to one of: approve-reads, approve-all, deny-all.";
}

function formatAcpxExitMessage(params: {
  stderr: string;
  exitCode: number | null | undefined;
}): string {
  const stderr = params.stderr.trim();
  if (params.exitCode === ACPX_EXIT_CODE_PERMISSION_DENIED) {
    return [
      stderr || "Permission denied by ACP runtime (acpx).",
      "ACPX blocked a write/exec permission request in a non-interactive session.",
      formatPermissionModeGuidance(),
    ].join(" ");
  }
  return stderr || `acpx exited with code ${params.exitCode ?? "unknown"}`;
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

  async probeAvailability(): Promise<void> {
    const versionCheck = await checkAcpxVersion({
      command: this.config.command,
      cwd: this.config.cwd,
      expectedVersion: this.config.expectedVersion,
      spawnOptions: this.spawnCommandOptions,
    });
    if (!versionCheck.ok) {
      this.healthy = false;
      return;
    }

    try {
      const result = await spawnAndCollect(
        {
          command: this.config.command,
          args: ["--help"],
          cwd: this.config.cwd,
          stripProviderAuthEnvVars: this.config.allowPluginLocalInstall,
        },
        this.spawnCommandOptions,
      );
      this.healthy = result.error == null && (result.code ?? 0) === 0;
    } catch {
      this.healthy = false;
    }
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
    const ensureSubcommand = resumeSessionId
      ? ["sessions", "new", "--name", sessionName, "--resume-session", resumeSessionId]
      : ["sessions", "ensure", "--name", sessionName];
    const ensureCommand = await this.buildVerbArgs({
      agent,
      cwd,
      command: ensureSubcommand,
    });

    let events = await this.runControlCommand({
      args: ensureCommand,
      cwd,
      fallbackCode: "ACP_SESSION_INIT_FAILED",
    });
    let ensuredEvent = events.find(
      (event) =>
        asOptionalString(event.agentSessionId) ||
        asOptionalString(event.acpxSessionId) ||
        asOptionalString(event.acpxRecordId),
    );

    if (!ensuredEvent && !resumeSessionId) {
      const newCommand = await this.buildVerbArgs({
        agent,
        cwd,
        command: ["sessions", "new", "--name", sessionName],
      });
      events = await this.runControlCommand({
        args: newCommand,
        cwd,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
      });
      ensuredEvent = events.find(
        (event) =>
          asOptionalString(event.agentSessionId) ||
          asOptionalString(event.acpxSessionId) ||
          asOptionalString(event.acpxRecordId),
      );
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
        stripProviderAuthEnvVars: this.config.allowPluginLocalInstall,
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

      if ((exit.code ?? 0) !== 0 && !sawError) {
        yield {
          type: "error",
          message: formatAcpxExitMessage({
            stderr,
            exitCode: exit.code,
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
    const versionCheck = await checkAcpxVersion({
      command: this.config.command,
      cwd: this.config.cwd,
      expectedVersion: this.config.expectedVersion,
      spawnOptions: this.spawnCommandOptions,
    });
    if (!versionCheck.ok) {
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

    try {
      const result = await spawnAndCollect(
        {
          command: this.config.command,
          args: ["--help"],
          cwd: this.config.cwd,
        },
        this.spawnCommandOptions,
      );
      if (result.error) {
        const spawnFailure = resolveSpawnFailure(result.error, this.config.cwd);
        if (spawnFailure === "missing-command") {
          this.healthy = false;
          return {
            ok: false,
            code: "ACP_BACKEND_UNAVAILABLE",
            message: `acpx command not found: ${this.config.command}`,
            installCommand: this.config.installCommand,
          };
        }
        if (spawnFailure === "missing-cwd") {
          this.healthy = false;
          return {
            ok: false,
            code: "ACP_BACKEND_UNAVAILABLE",
            message: `ACP runtime working directory does not exist: ${this.config.cwd}`,
          };
        }
        this.healthy = false;
        return {
          ok: false,
          code: "ACP_BACKEND_UNAVAILABLE",
          message: result.error.message,
          details: [String(result.error)],
        };
      }
      if ((result.code ?? 0) !== 0) {
        this.healthy = false;
        return {
          ok: false,
          code: "ACP_BACKEND_UNAVAILABLE",
          message: result.stderr.trim() || `acpx exited with code ${result.code ?? "unknown"}`,
        };
      }
      this.healthy = true;
      return {
        ok: true,
        message: `acpx command available (${this.config.command}, version ${versionCheck.version}${this.config.expectedVersion ? `, expected ${this.config.expectedVersion}` : ""})`,
      };
    } catch (error) {
      this.healthy = false;
      return {
        ok: false,
        code: "ACP_BACKEND_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      };
    }
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
      spawnOptions: this.spawnCommandOptions,
    });
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
        stripProviderAuthEnvVars: this.config.allowPluginLocalInstall,
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
    const errorEvent = events.map((event) => toAcpxErrorEvent(event)).find(Boolean) ?? null;
    if (errorEvent) {
      if (params.ignoreNoSession && errorEvent.code === "NO_SESSION") {
        return events;
      }
      throw new AcpRuntimeError(
        params.fallbackCode,
        errorEvent.code ? `${errorEvent.code}: ${errorEvent.message}` : errorEvent.message,
      );
    }

    if ((result.code ?? 0) !== 0) {
      throw new AcpRuntimeError(
        params.fallbackCode,
        formatAcpxExitMessage({
          stderr: result.stderr,
          exitCode: result.code,
        }),
      );
    }
    return events;
  }
}
