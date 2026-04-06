import type {
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
  PluginLogger,
} from "../runtime-api.js";
import { AcpRuntimeError } from "../runtime-api.js";
import type { ResolvedAcpxPluginConfig } from "./config.js";
import type { RuntimeHealthReport } from "./health/probe.js";
import type { SessionRuntimeManager } from "./session/manager.js";

export const ACPX_BACKEND_ID = "acpx";

const ACPX_RUNTIME_HANDLE_PREFIX = "acpx:v2:";
const ACPX_CAPABILITIES: AcpRuntimeCapabilities = {
  controls: ["session/set_mode", "session/set_config_option", "session/status"],
};

type AcpxHandleState = {
  name: string;
  agent: string;
  cwd: string;
  mode: "persistent" | "oneshot";
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function writeHandleState(handle: AcpRuntimeHandle, state: AcpxHandleState): void {
  handle.runtimeSessionName = encodeAcpxRuntimeHandleState(state);
  handle.cwd = state.cwd;
  handle.acpxRecordId = state.acpxRecordId;
  handle.backendSessionId = state.backendSessionId;
  handle.agentSessionId = state.agentSessionId;
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
  try {
    const raw = Buffer.from(trimmed.slice(ACPX_RUNTIME_HANDLE_PREFIX.length), "base64url").toString(
      "utf8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const name = asOptionalString(parsed.name);
    const agent = asOptionalString(parsed.agent);
    const cwd = asOptionalString(parsed.cwd);
    const mode = asOptionalString(parsed.mode);
    if (!name || !agent || !cwd || (mode !== "persistent" && mode !== "oneshot")) {
      return null;
    }
    return {
      name,
      agent,
      cwd,
      mode,
      acpxRecordId: asOptionalString(parsed.acpxRecordId),
      backendSessionId: asOptionalString(parsed.backendSessionId),
      agentSessionId: asOptionalString(parsed.agentSessionId),
    };
  } catch {
    return null;
  }
}

export class AcpxRuntime implements AcpRuntime {
  private healthy = false;
  private manager: SessionRuntimeManager | null = null;
  private managerPromise: Promise<SessionRuntimeManager> | null = null;

  constructor(
    private readonly config: ResolvedAcpxPluginConfig,
    private readonly opts?: {
      logger?: PluginLogger;
      managerFactory?: (config: ResolvedAcpxPluginConfig) => SessionRuntimeManager;
    },
  ) {}

  isHealthy(): boolean {
    return this.healthy;
  }

  async probeAvailability(): Promise<void> {
    const report = await this.runProbe();
    this.healthy = report.ok;
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    const report = await this.runProbe();
    this.healthy = report.ok;
    return {
      ok: report.ok,
      message: report.message,
      details: report.details,
    };
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const sessionName = input.sessionKey.trim();
    if (!sessionName) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const agent = input.agent.trim();
    if (!agent) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP agent id is required.");
    }

    const manager = await this.getManager();
    const record = await manager.ensureSession({
      sessionKey: sessionName,
      agent,
      cwd: input.cwd ?? this.config.cwd,
      resumeSessionId: input.resumeSessionId,
    });

    const handle: AcpRuntimeHandle = {
      sessionKey: input.sessionKey,
      backend: ACPX_BACKEND_ID,
      runtimeSessionName: "",
      cwd: record.cwd,
      acpxRecordId: record.acpxRecordId,
      backendSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
    };
    writeHandleState(handle, {
      name: sessionName,
      agent,
      cwd: record.cwd,
      mode: input.mode,
      acpxRecordId: record.acpxRecordId,
      backendSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
    });
    return handle;
  }

  async *runTurn(
    input: AcpRuntimeTurnInput,
  ): AsyncIterable<import("../runtime-api.js").AcpRuntimeEvent> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    yield* manager.runTurn({
      handle: {
        ...input.handle,
        acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
      },
      text: input.text,
      attachments: input.attachments,
      requestId: input.requestId,
      signal: input.signal,
    });
  }

  getCapabilities(): AcpRuntimeCapabilities {
    return ACPX_CAPABILITIES;
  }

  async getStatus(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    return await manager.getStatus({
      ...input.handle,
      acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
    });
  }

  async setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    await manager.setMode(
      {
        ...input.handle,
        acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
      },
      input.mode,
    );
  }

  async setConfigOption(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    await manager.setConfigOption(
      {
        ...input.handle,
        acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
      },
      input.key,
      input.value,
    );
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    await manager.cancel({
      ...input.handle,
      acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
    });
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const manager = await this.getManager();
    await manager.close({
      ...input.handle,
      acpxRecordId: state.acpxRecordId ?? input.handle.acpxRecordId ?? input.handle.sessionKey,
    });
  }

  private async getManager(): Promise<SessionRuntimeManager> {
    if (this.manager) {
      return this.manager;
    }
    if (!this.managerPromise) {
      this.managerPromise = (async () => {
        const manager =
          this.opts?.managerFactory?.(this.config) ??
          new (await import("./session/manager.js")).SessionRuntimeManager(this.config);
        this.manager = manager;
        return manager;
      })();
    }
    return await this.managerPromise;
  }

  private async runProbe(): Promise<RuntimeHealthReport> {
    return await (await import("./health/probe.js")).probeEmbeddedRuntime(this.config);
  }

  private resolveHandleState(handle: AcpRuntimeHandle): AcpxHandleState {
    const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
    if (decoded) {
      return {
        ...decoded,
        acpxRecordId: decoded.acpxRecordId ?? handle.acpxRecordId,
        backendSessionId: decoded.backendSessionId ?? handle.backendSessionId,
        agentSessionId: decoded.agentSessionId ?? handle.agentSessionId,
      };
    }

    const runtimeSessionName = handle.runtimeSessionName.trim();
    if (!runtimeSessionName) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "Invalid embedded ACP runtime handle: runtimeSessionName is missing.",
      );
    }

    return {
      name: runtimeSessionName,
      agent: "codex",
      cwd: handle.cwd ?? this.config.cwd,
      mode: "persistent",
      acpxRecordId: handle.acpxRecordId,
      backendSessionId: handle.backendSessionId,
      agentSessionId: handle.agentSessionId,
    };
  }
}
