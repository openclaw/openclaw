import { randomUUID } from "node:crypto";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonEmptyStringPreservingWhitespace as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { SdkRunReplay } from "./run-event-replay.js";
import { iterateSdkRunEvents } from "./run-event-stream.js";
import { readSdkRunTimestamp, resolveSdkRunWaitStatus } from "./run-terminal.js";
import {
  GatewayClientTransport,
  isConnectableTransport,
  observeGatewayReconnects,
  RUN_SUBMISSION_METHODS,
} from "./transport.js";
import type {
  AgentsCreateParams,
  AgentsDeleteParams,
  AgentsUpdateParams,
  AgentRunParams,
  ApprovalDecisionParams,
  ArtifactQuery,
  ArtifactsDownloadResult,
  ArtifactsGetResult,
  ArtifactsListResult,
  EnvironmentCreateParams,
  EnvironmentSummary,
  EnvironmentsListResult,
  GatewayEvent,
  GatewayRequestOptions,
  OpenClawEvent,
  OpenClawTransport,
  RunCreateParams,
  RunResult,
  SessionCreateParams,
  SessionSendParams,
  SessionTarget,
  ToolsEffectiveParams,
  ToolInvokeParams,
  ToolInvokeResult,
} from "./types.js";

export type OpenClawOptions = {
  gateway?: "auto" | (string & {});
  url?: string;
  token?: string;
  password?: string;
  requestTimeoutMs?: number;
  transport?: OpenClawTransport;
};

function resolveGatewayUrl(options: OpenClawOptions): string | undefined {
  if (options.url) {
    return options.url;
  }
  if (options.gateway && options.gateway !== "auto") {
    return options.gateway;
  }
  return undefined;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("timeoutMs must be a finite non-negative number");
  }
  return Math.floor(timeoutMs);
}

function splitModelRef(model: string | undefined): { provider?: string; model?: string } {
  if (!model) {
    return {};
  }
  const index = model.indexOf("/");
  if (index <= 0 || index === model.length - 1) {
    return { model };
  }
  return {
    provider: model.slice(0, index),
    model: model.slice(index + 1),
  };
}

function assertNoUnsupportedRunOptions(params: AgentRunParams): void {
  const unsupported = [
    params.workspace ? "workspace" : undefined,
    params.runtime ? "runtime" : undefined,
    params.environment ? "environment" : undefined,
    params.approvals ? "approvals" : undefined,
  ].filter((value): value is string => Boolean(value));
  if (unsupported.length === 0) {
    return;
  }
  throw new Error(
    `OpenClaw Gateway does not support per-run SDK option${
      unsupported.length === 1 ? "" : "s"
    } yet: ${unsupported.join(", ")}`,
  );
}

function buildAgentParams(
  params: AgentRunParams,
  timeoutMs: number | undefined,
): Record<string, unknown> {
  assertNoUnsupportedRunOptions(params);
  const modelRef = splitModelRef(params.model);
  return {
    message: params.input,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(modelRef.provider ? { provider: modelRef.provider } : {}),
    ...(modelRef.model ? { model: modelRef.model } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.thinking ? { thinking: params.thinking } : {}),
    ...(typeof params.deliver === "boolean" ? { deliver: params.deliver } : {}),
    ...(params.attachments ? { attachments: params.attachments } : {}),
    ...(timeoutMs !== undefined
      ? { timeout: timeoutMs === 0 ? 0 : Math.ceil(timeoutMs / 1000) }
      : {}),
    ...(params.label ? { label: params.label } : {}),
    idempotencyKey: params.idempotencyKey ?? randomUUID(),
  };
}

function requireArtifactQueryScope(api: string, params: ArtifactQuery): ArtifactQuery {
  const record = asRecord(params);
  if (
    ![record.sessionKey, record.runId].some(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  ) {
    throw new Error(`${api} requires sessionKey or runId`);
  }
  return params;
}

function requireToolsEffectiveSessionKey(params: ToolsEffectiveParams): ToolsEffectiveParams {
  const record = asRecord(params);
  if (typeof record.sessionKey !== "string" || record.sessionKey.trim().length === 0) {
    throw new Error("oc.tools.effective requires sessionKey");
  }
  return params;
}

export class OpenClaw {
  readonly agents: AgentsNamespace;
  readonly sessions: SessionsNamespace;
  readonly runs: RunsNamespace;
  readonly models: ModelsNamespace;
  readonly tools: ToolsNamespace;
  readonly artifacts: ArtifactsNamespace;
  readonly approvals: ApprovalsNamespace;
  readonly environments: EnvironmentsNamespace;

  private readonly transport: OpenClawTransport;
  private readonly replay = new SdkRunReplay();
  private readonly stopReconnectObserver: () => void;
  private connected = false;
  private closed = false;
  private eventPumpPromise: Promise<void> | null = null;
  private eventPumpReady: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: OpenClawOptions = {}) {
    this.transport =
      options.transport ??
      new GatewayClientTransport({
        url: resolveGatewayUrl(options),
        token: options.token,
        password: options.password,
        requestTimeoutMs: options.requestTimeoutMs,
      });
    this.stopReconnectObserver = observeGatewayReconnects(this.transport, (context) => {
      void this.replay.recover(context);
    });
    this.agents = new AgentsNamespace(this);
    this.sessions = new SessionsNamespace(this);
    this.runs = new RunsNamespace(this);
    this.models = new ModelsNamespace(this);
    this.tools = new ToolsNamespace(this);
    this.artifacts = new ArtifactsNamespace(this);
    this.approvals = new ApprovalsNamespace(this);
    this.environments = new EnvironmentsNamespace(this);
  }

  async connect(): Promise<void> {
    this.assertOpen();
    if (this.connected) {
      await this.startEventPump();
      this.assertOpen();
      return;
    }
    if (isConnectableTransport(this.transport)) {
      await this.transport.connect();
    }
    this.assertOpen();
    this.connected = true;
    await this.startEventPump();
    this.assertOpen();
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopReconnectObserver();
    this.replay.endStream();
    this.closePromise = (async () => {
      try {
        await this.transport.close?.();
        await this.eventPumpPromise?.catch(() => {});
      } finally {
        this.replay.close();
        this.eventPumpPromise = null;
        this.eventPumpReady = null;
        this.connected = false;
      }
    })();
    try {
      await this.closePromise;
    } finally {
      this.closePromise = null;
    }
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    await this.connect();
    this.assertOpen();
    const result = await this.transport.request<T>(method, params, options);
    if (RUN_SUBMISSION_METHODS.has(method)) {
      this.replay.noteRunAcceptance(params, result);
    }
    if (method === "sessions.messages.unsubscribe") {
      await this.replay.retireUnsubscribedSession(params, result);
    }
    return result;
  }

  runEvents(
    runId: string,
    filter?: (event: OpenClawEvent) => boolean,
  ): AsyncIterable<OpenClawEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        const controller = new AbortController();
        const iterator = this.iterateRunEvents(runId, filter, controller.signal);
        return {
          next: () => iterator.next(),
          return: async () => {
            controller.abort();
            return await iterator.return(undefined);
          },
        };
      },
    };
  }

  /** Received wire events, without the cumulative chat projection used by runEvents(). */
  rawEvents(filter?: (event: GatewayEvent) => boolean): AsyncIterable<GatewayEvent> {
    this.assertOpen();
    return this.transport.events(filter);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("OpenClaw SDK client is closed");
    }
  }

  async *events(filter?: (event: OpenClawEvent) => boolean): AsyncIterable<OpenClawEvent> {
    await this.connect();
    this.assertOpen();
    for await (const event of this.replay.events.stream(filter)) {
      yield event;
    }
  }

  private async *iterateRunEvents(
    runId: string,
    filter?: (event: OpenClawEvent) => boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<OpenClawEvent> {
    await this.connect();
    this.assertOpen();
    if (signal?.aborted) {
      return;
    }
    const release = this.replay.observeRun(runId);
    try {
      yield* iterateSdkRunEvents(
        runId,
        this.replay.snapshot(runId),
        this.replay.events,
        filter,
        signal,
      );
    } finally {
      release();
    }
  }

  private startEventPump(): Promise<void> {
    if (this.eventPumpReady) {
      return this.eventPumpReady;
    }
    let markReady = () => {};
    this.eventPumpReady = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    this.eventPumpPromise = (async () => {
      let iterator: AsyncIterator<GatewayEvent> | undefined;
      let pumpError: unknown;
      let hasPumpError = false;
      try {
        iterator = this.transport.events()[Symbol.asyncIterator]();
        while (true) {
          const next = iterator.next();
          await Promise.resolve();
          markReady();
          const result = await next;
          if (result.done) {
            break;
          }
          this.replay.publish(result.value);
        }
      } catch (error) {
        pumpError = error;
        hasPumpError = true;
      } finally {
        markReady();
        try {
          await iterator?.return?.();
        } catch (error) {
          if (!hasPumpError) {
            pumpError = error;
            hasPumpError = true;
          }
        }
        this.replay.endStream();
      }
      if (hasPumpError) {
        this.replay.events.close(pumpError);
        return;
      }
      this.replay.events.close();
    })().catch((error: unknown) => {
      markReady();
      this.replay.events.close(error);
    });
    return this.eventPumpReady;
  }
}

export class Agent {
  constructor(
    private readonly client: OpenClaw,
    readonly id: string,
  ) {}

  async run(input: string | Omit<AgentRunParams, "agentId">): Promise<Run> {
    const params: AgentRunParams =
      typeof input === "string" ? { input, agentId: this.id } : { ...input, agentId: this.id };
    return await this.client.runs.create(params);
  }

  async identity(params?: { sessionKey?: string }): Promise<unknown> {
    return await this.client.request("agent.identity.get", {
      agentId: this.id,
      ...(params?.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  }
}

export class Run {
  constructor(
    private readonly client: OpenClaw,
    readonly id: string,
    readonly sessionKey?: string,
  ) {}

  /** Replay this run's retained in-memory tail, then stream live events. */
  events(filter?: (event: OpenClawEvent) => boolean): AsyncIterable<OpenClawEvent> {
    return this.client.runEvents(this.id, filter);
  }

  async wait(options?: { timeoutMs?: number }): Promise<RunResult> {
    const timeoutMs = normalizeTimeoutMs(options?.timeoutMs);
    const raw = await this.client.request(
      "agent.wait",
      {
        runId: this.id,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      { timeoutMs: null },
    );
    const record = asRecord(raw);
    const status = resolveSdkRunWaitStatus(raw);
    const errorMessage = readNonEmptyString(record.error);
    return {
      runId: this.id,
      status,
      sessionKey: readNonEmptyString(record.sessionKey) ?? this.sessionKey,
      sessionId: readNonEmptyString(record.sessionId),
      startedAt: readSdkRunTimestamp(record.startedAt),
      endedAt: readSdkRunTimestamp(record.endedAt),
      ...(errorMessage ? { error: { message: errorMessage } } : {}),
      raw,
    };
  }

  async cancel(): Promise<unknown> {
    return await this.client.request("sessions.abort", {
      runId: this.id,
      ...(this.sessionKey ? { key: this.sessionKey } : {}),
    });
  }
}

export class Session {
  constructor(
    private readonly client: OpenClaw,
    readonly key: string,
    readonly info?: unknown,
  ) {}

  async send(input: string | Omit<SessionSendParams, "key">): Promise<Run> {
    const params: SessionSendParams =
      typeof input === "string" ? { key: this.key, message: input } : { ...input, key: this.key };
    const timeoutMs = normalizeTimeoutMs(params.timeoutMs);
    if (timeoutMs !== undefined) {
      params.timeoutMs = timeoutMs;
    }
    const raw = await this.client.request("sessions.send", params, {
      expectFinal: true,
      ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs === 0 ? null : timeoutMs } : {}),
    });
    const record = asRecord(raw);
    const runId = readNonEmptyString(record.runId);
    if (!runId) {
      throw new Error("sessions.send did not return a runId");
    }
    return new Run(this.client, runId, this.key);
  }

  async abort(runId?: string): Promise<unknown> {
    return await this.client.request("sessions.abort", {
      key: this.key,
      ...(runId ? { runId } : {}),
    });
  }

  async patch(params: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("sessions.patch", { ...params, key: this.key });
  }

  async compact(params?: { maxLines?: number }): Promise<unknown> {
    return await this.client.request(
      "sessions.compact",
      { key: this.key, ...params },
      // The server owns the configurable terminal compaction deadline.
      { timeoutMs: null },
    );
  }
}

export class AgentsNamespace {
  constructor(private readonly client: OpenClaw) {}

  async list(params?: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("agents.list", params === undefined ? {} : params);
  }

  async get(id: string): Promise<Agent> {
    return new Agent(this.client, id);
  }

  async create(params: AgentsCreateParams): Promise<unknown> {
    return await this.client.request("agents.create", params);
  }

  async update(params: AgentsUpdateParams): Promise<unknown> {
    return await this.client.request("agents.update", params);
  }

  async delete(params: AgentsDeleteParams): Promise<unknown> {
    return await this.client.request("agents.delete", params);
  }
}

export class SessionsNamespace {
  constructor(private readonly client: OpenClaw) {}

  async list(params?: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("sessions.list", params === undefined ? {} : params);
  }

  async create(params: SessionCreateParams = {}): Promise<Session> {
    const raw = await this.client.request("sessions.create", params);
    const record = asRecord(raw);
    const key =
      readNonEmptyString(record.key) ?? readNonEmptyString(record.sessionKey) ?? params.key;
    if (!key) {
      throw new Error("sessions.create did not return a session key");
    }
    return new Session(this.client, key, raw);
  }

  async get(target: SessionTarget | string): Promise<Session> {
    const key = typeof target === "string" ? target : target.key;
    return new Session(this.client, key);
  }

  async resolve(params: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("sessions.resolve", params);
  }

  async send(input: SessionSendParams): Promise<Run> {
    return await new Session(this.client, input.key).send(input);
  }
}

export class RunsNamespace {
  constructor(private readonly client: OpenClaw) {}

  async create(params: RunCreateParams): Promise<Run> {
    const timeoutMs = normalizeTimeoutMs(params.timeoutMs);
    const raw = await this.client.request("agent", buildAgentParams(params, timeoutMs), {
      expectFinal: false,
      ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs === 0 ? null : timeoutMs } : {}),
    });
    const record = asRecord(raw);
    const runId = readNonEmptyString(record.runId);
    if (!runId) {
      throw new Error("agent did not return a runId");
    }
    return new Run(this.client, runId, readNonEmptyString(record.sessionKey) ?? params.sessionKey);
  }

  async get(runId: string): Promise<Run> {
    return new Run(this.client, runId);
  }

  events(runId: string): AsyncIterable<OpenClawEvent> {
    return new Run(this.client, runId).events();
  }

  async wait(runId: string, options?: { timeoutMs?: number }): Promise<RunResult> {
    return await new Run(this.client, runId).wait(options);
  }

  async cancel(runId: string, sessionKey?: string): Promise<unknown> {
    return await new Run(this.client, runId, sessionKey).cancel();
  }
}

class RpcNamespace {
  constructor(
    protected readonly client: OpenClaw,
    private readonly prefix: string,
  ) {}

  protected async call<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    return await this.client.request<T>(`${this.prefix}.${method}`, params, options);
  }
}

export class ModelsNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "models");
  }

  async list(params?: unknown): Promise<unknown> {
    return await this.call("list", params === undefined ? {} : params);
  }

  async status(params?: unknown): Promise<unknown> {
    return await this.call("authStatus", params);
  }
}

export class ToolsNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "tools");
  }

  async list(params?: unknown): Promise<unknown> {
    return await this.call("catalog", params === undefined ? {} : params);
  }

  async effective(params: ToolsEffectiveParams): Promise<unknown> {
    return await this.call("effective", requireToolsEffectiveSessionKey(params));
  }

  async invoke(name: string, params?: ToolInvokeParams): Promise<ToolInvokeResult> {
    return await this.call("invoke", {
      name,
      conversationReadOrigin: "direct-operator",
      ...(params?.args ? { args: params.args } : {}),
      ...(params?.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params?.agentId ? { agentId: params.agentId } : {}),
      ...(typeof params?.confirm === "boolean" ? { confirm: params.confirm } : {}),
      ...(params?.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    });
  }
}

export class ArtifactsNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "artifacts");
  }

  async list(params: ArtifactQuery): Promise<ArtifactsListResult> {
    return await this.call("list", requireArtifactQueryScope("oc.artifacts.list", params));
  }

  async get(id: string, params: ArtifactQuery): Promise<ArtifactsGetResult> {
    return await this.call("get", {
      ...requireArtifactQueryScope("oc.artifacts.get", params),
      artifactId: id,
    });
  }

  async download(id: string, params: ArtifactQuery): Promise<ArtifactsDownloadResult> {
    return await this.call("download", {
      ...requireArtifactQueryScope("oc.artifacts.download", params),
      artifactId: id,
    });
  }
}

export class ApprovalsNamespace {
  constructor(private readonly client: OpenClaw) {}

  async list(params?: unknown): Promise<unknown> {
    return await this.client.request("exec.approval.list", params === undefined ? {} : params);
  }

  async respond(approvalId: string, params: ApprovalDecisionParams): Promise<unknown> {
    return await this.client.request("exec.approval.resolve", {
      id: approvalId,
      decision: params.decision,
    });
  }
}

export class EnvironmentsNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "environments");
  }

  async list(params?: unknown): Promise<EnvironmentsListResult> {
    return await this.call("list", params === undefined ? {} : params);
  }

  async create(params: EnvironmentCreateParams): Promise<EnvironmentSummary> {
    return await this.call("create", params);
  }

  async status(environmentId: string): Promise<EnvironmentSummary> {
    return await this.call("status", { environmentId });
  }

  async destroy(environmentId: string): Promise<EnvironmentSummary> {
    return await this.call("destroy", { environmentId });
  }

  async delete(environmentId: string): Promise<unknown> {
    void environmentId;
    throw new Error("oc.environments.delete is not supported by the current OpenClaw Gateway yet");
  }
}
