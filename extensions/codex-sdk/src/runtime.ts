import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpRuntimeError } from "openclaw/plugin-sdk/acpx";
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
} from "openclaw/plugin-sdk/acpx";
import {
  CODEX_SDK_BACKEND_ID,
  CODEX_SDK_INSTALL_COMMAND,
  isCodexAgentAllowed,
  resolveCodexRouteForAgent,
  resolveCodexRouteForId,
  type ResolvedCodexRouteConfig,
  type ResolvedCodexSdkPluginConfig,
} from "./config.js";
import {
  buildCodexThreadOptions,
  createCodexClientOptions,
  describeBackchannel,
  extensionForMediaType,
  loadCodexSdk,
  normalizeAgent,
  type CodexClient,
  type CodexSdkModule,
  type CodexThread,
} from "./runtime-client.js";
import {
  CONTROL_KEYS,
  composeRouteText,
  isAbortError,
  mapCodexThreadEvent,
  parseConfigOptionPatch,
  type CodexInput,
  type CodexThreadEvent,
  type CodexThreadOptions,
} from "./runtime-events.js";
import type { CodexNativeStateStore } from "./state.js";

type AcpRuntimeTurnAttachment = NonNullable<AcpRuntimeTurnInput["attachments"]>[number];

type CodexSdkRuntimeOptions = {
  config: ResolvedCodexSdkPluginConfig;
  loadSdk?: () => Promise<CodexSdkModule>;
  logger?: PluginLogger;
  stateStore?: CodexNativeStateStore;
  stateDir?: string;
  gatewayUrl?: string;
};

type CodexSessionState = {
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeEnsureInput["mode"];
  cwd?: string;
  thread: CodexThread;
  threadId?: string;
  options: CodexThreadOptions;
  route: ResolvedCodexRouteConfig;
  runtimeMode?: string;
};

export class CodexSdkRuntime implements AcpRuntime {
  private readonly config: ResolvedCodexSdkPluginConfig;
  private readonly loadSdk: () => Promise<CodexSdkModule>;
  private readonly logger?: PluginLogger;
  private readonly stateStore?: CodexNativeStateStore;
  private readonly stateDir?: string;
  private readonly gatewayUrl?: string;
  private client: CodexClient | null = null;
  private health: { ok: boolean; message: string } = {
    ok: false,
    message: "Codex SDK runtime has not been probed yet.",
  };
  private readonly sessions = new Map<string, CodexSessionState>();
  private readonly activeTurns = new Map<string, AbortController>();

  constructor(options: CodexSdkRuntimeOptions) {
    this.config = options.config;
    this.loadSdk = options.loadSdk ?? loadCodexSdk;
    this.logger = options.logger;
    this.stateStore = options.stateStore;
    this.stateDir = options.stateDir;
    this.gatewayUrl = options.gatewayUrl;
  }

  async probeAvailability(): Promise<void> {
    try {
      await this.getClient();
      this.health = { ok: true, message: "Codex SDK runtime is available." };
    } catch (error) {
      this.health = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  isHealthy(): boolean {
    return this.health.ok;
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const agent = normalizeAgent(input.agent);
    if (!isCodexAgentAllowed(agent, this.config)) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `Codex SDK backend only accepts configured agents: ${this.config.allowedAgents.join(", ")}`,
      );
    }
    const client = await this.getClient();
    const cwd = input.cwd ?? this.config.cwd;
    const route = resolveCodexRouteForAgent(agent, this.config);
    const options = this.buildThreadOptions(cwd, route);
    const existing = this.sessions.get(input.sessionKey);
    if (
      existing &&
      existing.agent === agent &&
      existing.mode === input.mode &&
      (existing.cwd ?? "") === (cwd ?? "") &&
      existing.route.id === route.id
    ) {
      return this.handleForState(existing);
    }

    const thread = input.resumeSessionId
      ? client.resumeThread(input.resumeSessionId, options)
      : client.startThread(options);
    const state: CodexSessionState = {
      sessionKey: input.sessionKey,
      agent,
      mode: input.mode,
      ...(cwd ? { cwd } : {}),
      thread,
      ...(input.resumeSessionId ? { threadId: input.resumeSessionId } : {}),
      options,
      route,
    };
    this.sessions.set(input.sessionKey, state);
    await this.recordSessionState(state, input.resumeSessionId ? "resumed" : "started");
    return this.handleForState(state);
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const state = this.requireState(input.handle);
    const controller = new AbortController();
    const abortFromInput = () => controller.abort();
    if (input.signal?.aborted) {
      controller.abort();
    } else {
      input.signal?.addEventListener("abort", abortFromInput, { once: true });
    }
    this.activeTurns.set(input.handle.sessionKey, controller);

    let tempDir: string | undefined;
    let sawDone = false;
    try {
      const normalized = await this.buildInput(state, input.text, input.attachments);
      tempDir = normalized.tempDir;
      const { events } = await state.thread.runStreamed(normalized.input, {
        signal: controller.signal,
      });
      for await (const event of events) {
        const mappedEvents = this.mapEvent(state, event);
        await this.recordSdkEvent(state, event, mappedEvents);
        for (const mapped of mappedEvents) {
          if (mapped.type === "done") {
            sawDone = true;
          }
          yield mapped;
        }
      }
      if (!sawDone) {
        yield { type: "done", stopReason: "end_turn" };
      }
    } catch (error) {
      if (isAbortError(error)) {
        await this.recordRuntimeError(state, "Codex SDK turn was cancelled.");
        yield {
          type: "error",
          message: "Codex SDK turn was cancelled.",
          code: "ACP_TURN_FAILED",
          retryable: true,
        };
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.recordRuntimeError(state, message);
      throw new AcpRuntimeError("ACP_TURN_FAILED", message, { cause: error });
    } finally {
      input.signal?.removeEventListener("abort", abortFromInput);
      if (this.activeTurns.get(input.handle.sessionKey) === controller) {
        this.activeTurns.delete(input.handle.sessionKey);
      }
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  getCapabilities(): AcpRuntimeCapabilities {
    return {
      controls: ["session/status", "session/set_config_option"],
      configOptionKeys: [...CONTROL_KEYS],
    };
  }

  async getStatus(input: { handle: AcpRuntimeHandle }): Promise<AcpRuntimeStatus> {
    const state = this.requireState(input.handle);
    return {
      summary: `Codex SDK ${state.threadId ? "thread active" : "thread pending"}`,
      backendSessionId: state.threadId,
      agentSessionId: state.threadId,
      details: {
        agent: state.agent,
        cwd: state.cwd,
        route: state.route.label,
        routeId: state.route.id,
        model: state.options.model,
        sandboxMode: state.options.sandboxMode,
        approvalPolicy: state.options.approvalPolicy,
        webSearchMode: state.options.webSearchMode,
        runtimeMode: state.runtimeMode,
        healthy: this.health.ok,
        backchannel: describeBackchannel(this.config, this.stateDir, this.gatewayUrl),
      },
    };
  }

  async setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void> {
    const state = this.requireState(input.handle);
    state.runtimeMode = input.mode;
  }

  async setConfigOption(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void> {
    const state = this.requireState(input.handle);
    const key = input.key.trim();
    if (!CONTROL_KEYS.includes(key as (typeof CONTROL_KEYS)[number])) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNSUPPORTED_CONTROL",
        `Codex SDK backend does not accept config key "${key}".`,
      );
    }
    if (key === "route") {
      state.route = resolveCodexRouteForId(input.value, this.config);
      state.options = buildCodexThreadOptions(this.config, state.cwd, state.route);
    } else {
      state.options = {
        ...state.options,
        ...parseConfigOptionPatch(key, input.value),
      };
    }
    const client = await this.getClient();
    state.thread = state.threadId
      ? client.resumeThread(state.threadId, state.options)
      : client.startThread(state.options);
    await this.recordSessionState(state, "configured");
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    try {
      await this.probeAvailability();
      return {
        ok: true,
        message: "Codex SDK runtime is available.",
        details: [
          `backend=${CODEX_SDK_BACKEND_ID}`,
          `routes=${Object.keys(this.config.routes).length}`,
          `sandboxMode=${this.config.sandboxMode}`,
          `allowedAgents=${this.config.allowedAgents.join(",")}`,
          `backchannel=${this.config.backchannel.enabled ? "enabled" : "disabled"}`,
          `backchannelServer=${this.config.backchannel.name}`,
        ],
      };
    } catch (error) {
      return {
        ok: false,
        code: "CODEX_SDK_UNAVAILABLE",
        message: "Codex SDK runtime is not available.",
        installCommand: CODEX_SDK_INSTALL_COMMAND,
        details: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  async cancel(input: { handle: AcpRuntimeHandle }): Promise<void> {
    this.activeTurns.get(input.handle.sessionKey)?.abort();
  }

  async close(input: { handle: AcpRuntimeHandle }): Promise<void> {
    const state = this.requireState(input.handle);
    this.activeTurns.get(input.handle.sessionKey)?.abort();
    this.activeTurns.delete(input.handle.sessionKey);
    await this.recordSessionState(state, "configured", "closed");
    this.sessions.delete(input.handle.sessionKey);
  }

  private async getClient(): Promise<CodexClient> {
    if (this.client) {
      return this.client;
    }
    const sdk = await this.loadSdk();
    this.client = new sdk.Codex(
      createCodexClientOptions(this.config, this.stateDir, this.gatewayUrl),
    );
    return this.client;
  }

  private buildThreadOptions(
    cwd: string | undefined,
    route: ResolvedCodexRouteConfig,
  ): CodexThreadOptions {
    return buildCodexThreadOptions(this.config, cwd, route);
  }

  private async buildInput(
    state: CodexSessionState,
    text: string,
    attachments?: AcpRuntimeTurnAttachment[],
  ): Promise<{ input: CodexInput; tempDir?: string }> {
    const effectiveText = composeRouteText({
      route: state.route,
      text,
      backchannelEnabled: this.config.backchannel.enabled,
    });
    const imageAttachments = (attachments ?? []).filter((entry) =>
      entry.mediaType.startsWith("image/"),
    );
    if (imageAttachments.length === 0) {
      return { input: effectiveText };
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-sdk-images-"));
    const input: CodexInput = [];
    if (effectiveText.trim()) {
      input.push({ type: "text", text: effectiveText });
    }
    for (let index = 0; index < imageAttachments.length; index += 1) {
      const attachment = imageAttachments[index];
      const extension = extensionForMediaType(attachment.mediaType);
      const filePath = path.join(tempDir, `image-${index + 1}${extension}`);
      await fs.writeFile(filePath, Buffer.from(attachment.data, "base64"));
      input.push({ type: "local_image", path: filePath });
    }
    return { input, tempDir };
  }

  private mapEvent(state: CodexSessionState, event: CodexThreadEvent): AcpRuntimeEvent[] {
    const mapped = mapCodexThreadEvent(event);
    if (mapped.threadId) {
      state.threadId = mapped.threadId;
    }
    if (mapped.ignoredType) {
      this.logger?.debug?.(`codex-sdk runtime ignored event type: ${mapped.ignoredType}`);
    }
    return mapped.events;
  }

  private handleForState(state: CodexSessionState): AcpRuntimeHandle {
    return {
      sessionKey: state.sessionKey,
      backend: CODEX_SDK_BACKEND_ID,
      runtimeSessionName: state.sessionKey,
      ...(state.cwd ? { cwd: state.cwd } : {}),
      ...(state.threadId
        ? { backendSessionId: state.threadId, agentSessionId: state.threadId }
        : {}),
    };
  }

  private requireState(handle: AcpRuntimeHandle): CodexSessionState {
    const state = this.sessions.get(handle.sessionKey);
    if (!state) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `Codex SDK session is not active: ${handle.sessionKey}`,
      );
    }
    return state;
  }

  private async recordSessionState(
    state: CodexSessionState,
    lifecycle: "started" | "resumed" | "configured",
    status: "active" | "closed" = "active",
  ): Promise<void> {
    await this.stateStore
      ?.upsertSession({
        sessionKey: state.sessionKey,
        backend: CODEX_SDK_BACKEND_ID,
        agent: state.agent,
        routeId: state.route.id,
        routeLabel: state.route.label,
        model: state.options.model,
        modelReasoningEffort: state.options.modelReasoningEffort,
        cwd: state.cwd,
        threadId: state.threadId,
        lifecycle,
        status,
      })
      .catch((error) => {
        this.logger?.warn?.(`codex-sdk state write failed: ${String(error)}`);
      });
  }

  private async recordSdkEvent(
    state: CodexSessionState,
    event: CodexThreadEvent,
    mappedEvents: AcpRuntimeEvent[],
  ): Promise<void> {
    await this.stateStore
      ?.recordEvent({
        sessionKey: state.sessionKey,
        backend: CODEX_SDK_BACKEND_ID,
        routeId: state.route.id,
        routeLabel: state.route.label,
        threadId: state.threadId,
        sdkEventType: event.type,
        mappedEvents,
      })
      .catch((error) => {
        this.logger?.warn?.(`codex-sdk event write failed: ${String(error)}`);
      });
    if (event.type === "thread.started") {
      await this.recordSessionState(state, "started");
    }
  }

  private async recordRuntimeError(state: CodexSessionState, message: string): Promise<void> {
    await this.stateStore
      ?.recordEvent({
        sessionKey: state.sessionKey,
        backend: CODEX_SDK_BACKEND_ID,
        routeId: state.route.id,
        routeLabel: state.route.label,
        threadId: state.threadId,
        sdkEventType: "error",
        mappedEvents: [{ type: "error", message, code: "ACP_TURN_FAILED", retryable: true }],
      })
      .catch((error) => {
        this.logger?.warn?.(`codex-sdk error write failed: ${String(error)}`);
      });
  }
}
