import { createHash } from "node:crypto";
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
} from "openclaw/plugin-sdk/acp";
import { AcpRuntimeError } from "openclaw/plugin-sdk/acp";
import type { ResolvedAcpRemotePluginConfig } from "./config.js";

export const ACP_REMOTE_BACKEND_ID = "acp-remote";

const ACP_REMOTE_CLIENT_INFO = {
  name: "openclaw",
  version: "acp-remote",
};
const ACP_REMOTE_HANDLE_PREFIX = "acp-remote:v1:";
const ACP_REMOTE_CAPABILITIES: AcpRuntimeCapabilities = {
  controls: ["session/set_config_option", "session/set_mode", "session/status"],
};

type JsonRpcId = string | number;
type JsonRpcNotification = {
  jsonrpc?: string;
  method: string;
  params?: unknown;
};
type JsonRpcSuccess = {
  jsonrpc?: string;
  id: JsonRpcId;
  result: unknown;
};
type JsonRpcFailure = {
  jsonrpc?: string;
  id: JsonRpcId | null;
  error: {
    code?: string | number;
    message?: string;
    data?: unknown;
  };
};
type JsonRpcMessage = JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

type AcpRemoteHandleState = {
  sessionId: string;
  sessionKey: string;
  clientId: string;
  cwd?: string;
  mode: AcpRuntimeEnsureInput["mode"];
};

type AcpRemoteSessionState = {
  clientId: string;
  cwd?: string;
  mode: AcpRuntimeEnsureInput["mode"];
  currentModeId?: string;
  configOptions: Record<string, string>;
};

type AcpRemoteInitializeState = {
  protocolVersion: number;
  loadSession: boolean;
};

class RemoteRpcError extends Error {
  readonly code?: string | number;
  readonly data?: unknown;

  constructor(message: string, options?: { code?: string | number; data?: unknown }) {
    super(message);
    this.name = "RemoteRpcError";
    this.code = options?.code;
    this.data = options?.data;
  }
}

class RemoteHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RemoteHttpError";
    this.status = status;
  }
}

class MissingTerminalResponseError extends Error {
  constructor(method: string) {
    super(`ACP remote ${method} ended without a terminal response.`);
    this.name = "MissingTerminalResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function encodeAcpRemoteHandleState(state: AcpRemoteHandleState): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${ACP_REMOTE_HANDLE_PREFIX}${payload}`;
}

export function decodeAcpRemoteHandleState(
  runtimeSessionName: string,
): AcpRemoteHandleState | null {
  const trimmed = runtimeSessionName.trim();
  if (!trimmed.startsWith(ACP_REMOTE_HANDLE_PREFIX)) {
    return null;
  }
  const encoded = trimmed.slice(ACP_REMOTE_HANDLE_PREFIX.length);
  if (!encoded) {
    return null;
  }
  try {
    const raw = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const sessionId = normalizeText(parsed.sessionId);
    const sessionKey = normalizeText(parsed.sessionKey);
    const clientId = normalizeText(parsed.clientId);
    const cwd = normalizeText(parsed.cwd);
    const mode = parsed.mode;
    if (!sessionId || !sessionKey || !clientId) {
      return null;
    }
    if (mode !== "persistent" && mode !== "oneshot") {
      return null;
    }
    return {
      sessionId,
      sessionKey,
      clientId,
      cwd,
      mode,
    };
  } catch {
    return null;
  }
}

function toMessageText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStableClientId(sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
  return `openclaw:${digest}`;
}

function buildSessionInitParams(params: {
  sessionId?: string;
  cwd?: string;
  clientId: string;
  sessionKey: string;
}): Record<string, unknown> {
  return {
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    mcpServers: [],
    _meta: {
      openclawClientId: params.clientId,
      openclawSessionId: params.sessionKey,
      openclawSessionKey: params.sessionKey,
    },
  };
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || /aborted/i.test(error.message);
}

function buildTimeoutSignal(base: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (base && typeof AbortSignal.any === "function") {
      return AbortSignal.any([base, timeoutSignal]);
    }
    return base ?? timeoutSignal;
  }
  return base ?? new AbortController().signal;
}

function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return typeof (message as JsonRpcNotification).method === "string";
}

function isJsonRpcFailure(message: JsonRpcMessage): message is JsonRpcFailure {
  return isRecord(message) && "error" in message;
}

function isJsonRpcSuccess(message: JsonRpcMessage): message is JsonRpcSuccess {
  return isRecord(message) && "result" in message && "id" in message;
}

function idsEqual(left: unknown, right: JsonRpcId): boolean {
  return left === right;
}

function extractChunkText(content: unknown): string | undefined {
  if (!isRecord(content)) {
    return undefined;
  }
  if (content.type === "text") {
    return normalizeText(content.text);
  }
  return undefined;
}

function readCurrentModeId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return normalizeText(value.currentModeId);
}

function readSessionCwd(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return normalizeText(value.cwd);
}

function readConfigOptionValues(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) {
    return {};
  }
  const entries: Array<[string, string]> = [];
  for (const option of value) {
    if (!isRecord(option)) {
      continue;
    }
    const id = normalizeText(option.id);
    const currentValue = isRecord(option)
      ? normalizeText((option as { currentValue?: unknown }).currentValue)
      : undefined;
    if (id && currentValue) {
      entries.push([id, currentValue]);
    }
  }
  return Object.fromEntries(entries);
}

function normalizeStopReason(value: unknown): string | undefined {
  return normalizeText(value);
}

function normalizeContentType(value: string | null): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function parseJsonRpcPayload(value: unknown, method: string): JsonRpcMessage[] {
  if (Array.isArray(value)) {
    if (!value.every(isRecord)) {
      throw new Error(`ACP remote ${method} returned a non-object JSON-RPC payload.`);
    }
    return value as JsonRpcMessage[];
  }
  if (!isRecord(value)) {
    throw new Error(`ACP remote ${method} returned a non-object JSON-RPC payload.`);
  }
  return [value as JsonRpcMessage];
}

function serializeNotification(message: JsonRpcNotification): string {
  return JSON.stringify(message);
}

export class AcpRemoteRuntime implements AcpRuntime {
  private healthy = false;
  private readonly logger?: PluginLogger;
  private initializeState: AcpRemoteInitializeState | null = null;
  private readonly sessionStateBySessionId = new Map<string, AcpRemoteSessionState>();

  constructor(
    private readonly config: ResolvedAcpRemotePluginConfig,
    options?: {
      logger?: PluginLogger;
    },
  ) {
    this.logger = options?.logger;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async probeAvailability(): Promise<void> {
    try {
      await this.initializeRemote({ force: true });
      this.healthy = true;
    } catch {
      this.healthy = false;
    }
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    try {
      const state = await this.initializeRemote({ force: true });
      return {
        ok: state.loadSession,
        message: `ACP remote gateway ready at ${this.config.url}`,
        details: [`protocolVersion=${state.protocolVersion}`, "transport=streamable-http"],
      };
    } catch (error) {
      return {
        ok: false,
        code: "ACP_BACKEND_UNAVAILABLE",
        message: `ACP remote gateway probe failed: ${toMessageText(error)}`,
        installCommand: "Ensure the acp-gateway service is reachable and protocol-compatible.",
      };
    }
  }

  async getCapabilities(): Promise<AcpRuntimeCapabilities> {
    await this.initializeRemote();
    return ACP_REMOTE_CAPABILITIES;
  }

  async getStatus(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus> {
    await this.initializeRemote();
    const state = this.resolveHandleState(input.handle);
    const sessionState = this.sessionStateBySessionId.get(state.sessionId);
    const currentModeId = sessionState?.currentModeId;
    const configOptions = sessionState?.configOptions ?? {};
    const cwd = sessionState?.cwd ?? state.cwd;
    return {
      summary: currentModeId
        ? `remote ACP session ready (${currentModeId})`
        : "remote ACP session ready",
      backendSessionId: state.sessionId,
      details: {
        url: this.config.url,
        clientId: sessionState?.clientId ?? state.clientId,
        ...(cwd ? { cwd } : {}),
        ...(currentModeId ? { currentModeId } : {}),
        ...(Object.keys(configOptions).length > 0 ? { configOptions } : {}),
      },
    };
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    await this.initializeRemote();
    const sessionKey = normalizeText(input.sessionKey);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const sessionId = sessionKey;
    const existing = this.sessionStateBySessionId.get(sessionId);
    const clientId = existing?.clientId ?? buildStableClientId(sessionKey);
    const explicitCwd = normalizeText(input.cwd);
    let effectiveCwd = existing?.cwd;

    try {
      const result = await this.request<Record<string, unknown> | null>({
        method: "session/load",
        id: `load:${sessionId}`,
        params: buildSessionInitParams({
          sessionId,
          cwd: explicitCwd,
          clientId,
          sessionKey,
        }),
      });
      const loadedCwd = readSessionCwd(result) ?? existing?.cwd ?? explicitCwd;
      this.upsertSessionState(sessionId, {
        clientId,
        cwd: loadedCwd,
        mode: input.mode,
      });
      this.applyRemoteSessionMetadata(sessionId, result);
      effectiveCwd = this.sessionStateBySessionId.get(sessionId)?.cwd ?? loadedCwd;
    } catch (error) {
      if (!this.isMissingSessionError(error)) {
        throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", toMessageText(error), {
          cause: error,
        });
      }
      const createCwd = explicitCwd ?? this.config.defaultCwd;
      const result = await this.request<Record<string, unknown>>({
        method: "session/new",
        id: `new:${sessionId}`,
        params: buildSessionInitParams({
          cwd: createCwd,
          clientId,
          sessionKey,
        }),
      });
      const returnedSessionId = normalizeText(result.sessionId);
      if (!returnedSessionId) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "ACP remote session/new did not return a sessionId.",
        );
      }
      if (returnedSessionId !== sessionId) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `ACP remote session/new returned sessionId "${returnedSessionId}" but OpenClaw requires stable sessionId "${sessionId}".`,
        );
      }
      const createdCwd = readSessionCwd(result) ?? createCwd;
      this.upsertSessionState(sessionId, {
        clientId,
        cwd: createdCwd,
        mode: input.mode,
      });
      this.applyRemoteSessionMetadata(sessionId, result);
      effectiveCwd = this.sessionStateBySessionId.get(sessionId)?.cwd ?? createdCwd;
    }

    if (!effectiveCwd) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "ACP remote session did not resolve an effective working directory.",
      );
    }

    return {
      sessionKey,
      backend: ACP_REMOTE_BACKEND_ID,
      runtimeSessionName: encodeAcpRemoteHandleState({
        sessionId,
        sessionKey,
        clientId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        mode: input.mode,
      }),
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      backendSessionId: sessionId,
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    await this.initializeRemote();
    const state = this.resolveHandleState(input.handle);
    this.upsertSessionState(state.sessionId, {
      clientId: state.clientId,
      cwd: state.cwd,
      mode: state.mode,
    });

    const cancelOnAbort = async () => {
      await this.cancel({
        handle: input.handle,
        reason: "abort-signal",
      }).catch((error) => {
        this.logger?.warn?.(`acp-remote abort-cancel failed: ${toMessageText(error)}`);
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

    const seenNotifications: string[] = [];
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let replayCursor = 0;
        let dedupingReplay = attempt > 1;
        try {
          for await (const message of this.streamRpc({
            method: "session/prompt",
            id: input.requestId,
            params: {
              sessionId: state.sessionId,
              prompt: [{ type: "text", text: input.text }],
              _meta: this.buildMeta({
                openclawClientId: state.clientId,
                openclawRequestId: input.requestId,
              }),
            },
            signal: input.signal,
          })) {
            if (isJsonRpcNotification(message)) {
              if (dedupingReplay) {
                const serialized = serializeNotification(message);
                if (
                  replayCursor < seenNotifications.length &&
                  seenNotifications[replayCursor] === serialized
                ) {
                  replayCursor += 1;
                  continue;
                }
                dedupingReplay = false;
                seenNotifications.push(serialized);
              } else {
                seenNotifications.push(serializeNotification(message));
              }
              for (const event of this.translateNotification(message, state.sessionId)) {
                yield event;
              }
              continue;
            }
            if (!idsEqual((message as JsonRpcSuccess | JsonRpcFailure).id, input.requestId)) {
              continue;
            }
            if (isJsonRpcFailure(message)) {
              yield {
                type: "error",
                message:
                  normalizeText(message.error.message) ?? "ACP remote prompt request failed.",
                code:
                  typeof message.error.code === "number" || typeof message.error.code === "string"
                    ? String(message.error.code)
                    : undefined,
              };
              return;
            }
            if (isJsonRpcSuccess(message)) {
              const result = isRecord(message.result) ? message.result : {};
              const stopReason = normalizeStopReason(result.stopReason);
              if (!stopReason) {
                yield {
                  type: "error",
                  message: "ACP remote prompt response did not include stopReason.",
                };
                return;
              }
              yield {
                type: "done",
                stopReason,
              };
              return;
            }
          }
          throw new MissingTerminalResponseError("session/prompt");
        } catch (error) {
          if (input.signal?.aborted || isAbortLikeError(error)) {
            return;
          }
          const retryable = attempt < 2 && this.isRetryablePromptError(error);
          if (retryable) {
            this.logger?.warn?.(
              `acp-remote prompt transport dropped; retrying request ${input.requestId}`,
            );
            if (this.config.retryDelayMs > 0) {
              await sleep(this.config.retryDelayMs);
            }
            continue;
          }
          yield {
            type: "error",
            message: toMessageText(error),
          };
          return;
        }
      }
    } finally {
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  async setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void> {
    await this.initializeRemote();
    const state = this.resolveHandleState(input.handle);
    await this.request({
      method: "session/set_mode",
      id: `set-mode:${state.sessionId}:${input.mode}`,
      params: {
        sessionId: state.sessionId,
        modeId: input.mode,
        _meta: this.buildMeta({
          openclawClientId: state.clientId,
        }),
      },
    });
    const current = this.sessionStateBySessionId.get(state.sessionId);
    if (current) {
      current.currentModeId = input.mode;
    }
  }

  async setConfigOption(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void> {
    await this.initializeRemote();
    const state = this.resolveHandleState(input.handle);
    const result = await this.request<Record<string, unknown> | null>({
      method: "session/set_config_option",
      id: `set-config:${state.sessionId}:${input.key}`,
      params: {
        sessionId: state.sessionId,
        configId: input.key,
        value: input.value,
        _meta: this.buildMeta({
          openclawClientId: state.clientId,
        }),
      },
    });
    const current = this.sessionStateBySessionId.get(state.sessionId);
    if (current) {
      current.configOptions[input.key] = input.value;
    }
    this.applyRemoteSessionMetadata(state.sessionId, result);
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    await this.notify({
      method: "session/cancel",
      params: {
        sessionId: state.sessionId,
        _meta: this.buildMeta({
          openclawClientId: state.clientId,
          ...(normalizeText(input.reason) ? { reason: normalizeText(input.reason) } : {}),
        }),
      },
    }).catch((error) => {
      this.logger?.warn?.(`acp-remote cancel failed: ${toMessageText(error)}`);
    });
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    await this.request({
      method: "session/close",
      id: `close:${state.sessionId}`,
      params: {
        sessionId: state.sessionId,
        _meta: this.buildMeta({
          openclawClientId: state.clientId,
          reason: input.reason,
        }),
      },
    }).catch((error) => {
      this.logger?.warn?.(`acp-remote close failed: ${toMessageText(error)}`);
    });
    this.sessionStateBySessionId.delete(state.sessionId);
  }

  private buildMeta(extra: Record<string, unknown>): Record<string, unknown> {
    return { ...extra };
  }

  private async initializeRemote(
    params: { force?: boolean } = {},
  ): Promise<AcpRemoteInitializeState> {
    if (!params.force && this.initializeState) {
      return this.initializeState;
    }
    const result = await this.request<Record<string, unknown>>({
      method: "initialize",
      id: `initialize:${this.config.protocolVersion}`,
      params: {
        protocolVersion: this.config.protocolVersion,
        clientCapabilities: {
          fs: {
            readTextFile: false,
            writeTextFile: false,
          },
          terminal: false,
        },
        clientInfo: ACP_REMOTE_CLIENT_INFO,
      },
    });

    const protocolVersion = normalizeNumber(result.protocolVersion);
    if (protocolVersion !== this.config.protocolVersion) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        `ACP remote protocol mismatch: expected ${this.config.protocolVersion}, got ${protocolVersion ?? "unknown"}.`,
      );
    }

    const loadSession = Boolean(
      isRecord(result.agentCapabilities) && result.agentCapabilities.loadSession === true,
    );
    if (!loadSession) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        "ACP remote gateway must advertise loadSession support.",
      );
    }

    const state = {
      protocolVersion,
      loadSession,
    };
    this.initializeState = state;
    return state;
  }

  private resolveHandleState(handle: AcpRuntimeHandle): AcpRemoteHandleState {
    const decoded = decodeAcpRemoteHandleState(handle.runtimeSessionName);
    if (!decoded) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "Invalid acp-remote runtime handle state.",
      );
    }
    return decoded;
  }

  private upsertSessionState(
    sessionId: string,
    patch: Pick<AcpRemoteSessionState, "clientId" | "mode"> & { cwd?: string },
  ): void {
    const current = this.sessionStateBySessionId.get(sessionId);
    this.sessionStateBySessionId.set(sessionId, {
      clientId: patch.clientId,
      cwd: patch.cwd ?? current?.cwd,
      mode: patch.mode,
      currentModeId: current?.currentModeId,
      configOptions: { ...(current?.configOptions ?? {}) },
    });
  }

  private applyRemoteSessionMetadata(sessionId: string, value: unknown): void {
    const state = this.sessionStateBySessionId.get(sessionId);
    if (!state || !isRecord(value)) {
      return;
    }
    const resolvedCwd = normalizeText(value.cwd);
    if (resolvedCwd) {
      state.cwd = resolvedCwd;
    }
    const currentModeId =
      readCurrentModeId(value.modes) ?? readCurrentModeId(value.currentMode) ?? state.currentModeId;
    if (currentModeId) {
      state.currentModeId = currentModeId;
    }
    state.configOptions = {
      ...state.configOptions,
      ...readConfigOptionValues(value.configOptions),
    };
  }

  private translateNotification(
    message: JsonRpcNotification,
    sessionId: string,
  ): AcpRuntimeEvent[] {
    if (message.method !== "session/update" || !isRecord(message.params)) {
      return [];
    }
    if (normalizeText(message.params.sessionId) !== sessionId) {
      return [];
    }
    const update = isRecord(message.params.update) ? message.params.update : null;
    if (!update) {
      return [];
    }
    const tag = normalizeText(update.sessionUpdate);
    if (!tag) {
      return [];
    }

    if (tag === "agent_message_chunk" || tag === "agent_thought_chunk") {
      const text = extractChunkText(update.content);
      if (!text) {
        return [];
      }
      return [
        {
          type: "text_delta",
          text,
          stream: tag === "agent_thought_chunk" ? "thought" : "output",
          tag,
        },
      ];
    }

    if (tag === "tool_call" || tag === "tool_call_update") {
      const title = normalizeText(update.title) ?? normalizeText(update.toolCallId) ?? "tool";
      const status = normalizeText(update.status);
      const text = status ? `${title} (${status})` : title;
      return [
        {
          type: "tool_call",
          text,
          tag,
          toolCallId: normalizeText(update.toolCallId),
          status,
          title,
        },
      ];
    }

    if (tag === "current_mode_update") {
      const currentModeId = normalizeText(update.currentModeId);
      const state = this.sessionStateBySessionId.get(sessionId);
      if (state && currentModeId) {
        state.currentModeId = currentModeId;
      }
      return currentModeId
        ? [
            {
              type: "status",
              text: currentModeId,
              tag,
            },
          ]
        : [];
    }

    if (tag === "config_option_update") {
      const state = this.sessionStateBySessionId.get(sessionId);
      if (state) {
        state.configOptions = {
          ...state.configOptions,
          ...readConfigOptionValues(update.configOptions),
        };
      }
    }

    return [];
  }

  private isMissingSessionError(error: unknown): boolean {
    if (!(error instanceof RemoteRpcError)) {
      return false;
    }
    if (error.code === 404 || error.code === -32004 || error.code === "session_not_found") {
      return true;
    }
    const reason =
      isRecord(error.data) && typeof error.data.reason === "string" ? error.data.reason : undefined;
    if (reason === "session_not_found") {
      return true;
    }
    return /session.*not found|unknown session|missing session|does not exist/i.test(error.message);
  }

  private isRetryablePromptError(error: unknown): boolean {
    if (error instanceof RemoteRpcError) {
      return false;
    }
    if (error instanceof RemoteHttpError) {
      return error.status >= 500;
    }
    return error instanceof MissingTerminalResponseError || error instanceof Error;
  }

  private async *streamRpc(params: {
    method: string;
    id: JsonRpcId;
    params: Record<string, unknown>;
    signal?: AbortSignal;
  }): AsyncIterable<JsonRpcMessage> {
    const signal = buildTimeoutSignal(params.signal, this.config.timeoutMs);
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: params.id,
        method: params.method,
        params: params.params,
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new RemoteHttpError(
        response.status,
        `ACP remote ${params.method} failed with HTTP ${response.status}${text ? `: ${text.trim()}` : ""}`,
      );
    }
    if (!response.body) {
      throw new MissingTerminalResponseError(params.method);
    }

    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (contentType === "text/event-stream") {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const emitEvent = async function* (rawEvent: string): AsyncIterable<JsonRpcMessage> {
        const dataLines: string[] = [];
        for (const rawLine of rawEvent.split("\n")) {
          const line = rawLine.trimEnd();
          if (!line || line.startsWith(":")) {
            continue;
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length === 0) {
          return;
        }
        const payload = JSON.parse(dataLines.join("\n")) as unknown;
        for (const message of parseJsonRpcPayload(payload, params.method)) {
          yield message;
        }
      };

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
        while (true) {
          const eventEnd = buffer.indexOf("\n\n");
          if (eventEnd === -1) {
            break;
          }
          const rawEvent = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          yield* emitEvent(rawEvent);
        }
      }

      const tail = `${buffer}${decoder.decode()}`.replaceAll("\r\n", "\n").trim();
      if (tail) {
        yield* emitEvent(tail);
      }
      return;
    }

    const text = await response.text();
    if (!text.trim()) {
      return;
    }
    const payload = JSON.parse(text) as unknown;
    for (const message of parseJsonRpcPayload(payload, params.method)) {
      yield message;
    }
  }

  private async request<T>(params: {
    method: string;
    id: JsonRpcId;
    params: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<T> {
    for await (const message of this.streamRpc(params)) {
      if (isJsonRpcNotification(message)) {
        continue;
      }
      if (!idsEqual((message as JsonRpcSuccess | JsonRpcFailure).id, params.id)) {
        continue;
      }
      if (isJsonRpcFailure(message)) {
        throw new RemoteRpcError(
          normalizeText(message.error.message) ?? `ACP remote ${params.method} failed.`,
          {
            code: message.error.code,
            data: message.error.data,
          },
        );
      }
      if (isJsonRpcSuccess(message)) {
        return message.result as T;
      }
    }
    throw new MissingTerminalResponseError(params.method);
  }

  private async notify(params: {
    method: string;
    params: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<void> {
    const signal = buildTimeoutSignal(params.signal, this.config.timeoutMs);
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: params.method,
        params: params.params,
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new RemoteHttpError(
        response.status,
        `ACP remote ${params.method} failed with HTTP ${response.status}${text ? `: ${text.trim()}` : ""}`,
      );
    }
    if (response.status === 202 || response.status === 204) {
      return;
    }
    await response.text().catch(() => "");
  }
}
