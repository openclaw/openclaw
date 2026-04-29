import { randomUUID } from "node:crypto";
import { normalizeGatewayEvent } from "./normalize.js";
import { GatewayClientTransport, isConnectableTransport } from "./transport.js";
import type {
  AgentRunParams,
  GatewayEvent,
  GatewayRequestOptions,
  OpenClawEvent,
  OpenClawTransport,
  RunCreateParams,
  RunResult,
  RunTimestamp,
  SessionCreateParams,
  SessionSendParams,
  SessionTarget,
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

function runStatusFromWaitPayload(payload: unknown): RunResult["status"] {
  const record =
    typeof payload === "object" && payload !== null ? (payload as { status?: unknown }) : {};
  const status = typeof record.status === "string" ? record.status : undefined;
  if (status === "ok" || status === "completed" || status === "succeeded") {
    return "completed";
  }
  if (status === "timeout" || status === "timed_out") {
    return "timed_out";
  }
  if (status === "cancelled" || status === "canceled") {
    return "cancelled";
  }
  if (status === "accepted") {
    return "accepted";
  }
  return "failed";
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalTimestamp(value: unknown): RunTimestamp | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function timeoutSecondsFromMs(timeoutMs: number | undefined): number | undefined {
  const normalized = normalizeTimeoutMs(timeoutMs);
  if (normalized === undefined) {
    return undefined;
  }
  return normalized === 0 ? 0 : Math.ceil(normalized / 1000);
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

function buildAgentParams(params: AgentRunParams): Record<string, unknown> {
  assertNoUnsupportedRunOptions(params);
  const modelRef = splitModelRef(params.model);
  const timeoutSeconds = timeoutSecondsFromMs(params.timeoutMs);
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
    ...(timeoutSeconds !== undefined ? { timeout: timeoutSeconds } : {}),
    ...(params.label ? { label: params.label } : {}),
    idempotencyKey: params.idempotencyKey ?? randomUUID(),
  };
}

function unsupportedGatewayApi(api: string): never {
  throw new Error(`${api} is not supported by the current OpenClaw Gateway yet`);
}

export class OpenClaw {
  readonly agents: AgentsNamespace;
  readonly sessions: SessionsNamespace;
  readonly runs: RunsNamespace;
  readonly tasks: TasksNamespace;
  readonly models: ModelsNamespace;
  readonly tools: ToolsNamespace;
  readonly artifacts: ArtifactsNamespace;
  readonly approvals: ApprovalsNamespace;
  readonly environments: EnvironmentsNamespace;

  private readonly transport: OpenClawTransport;
  private connected = false;

  constructor(options: OpenClawOptions = {}) {
    this.transport =
      options.transport ??
      new GatewayClientTransport({
        url: resolveGatewayUrl(options),
        token: options.token,
        password: options.password,
        requestTimeoutMs: options.requestTimeoutMs,
      });
    this.agents = new AgentsNamespace(this);
    this.sessions = new SessionsNamespace(this);
    this.runs = new RunsNamespace(this);
    this.tasks = new TasksNamespace(this);
    this.models = new ModelsNamespace(this);
    this.tools = new ToolsNamespace(this);
    this.artifacts = new ArtifactsNamespace(this);
    this.approvals = new ApprovalsNamespace(this);
    this.environments = new EnvironmentsNamespace(this);
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (isConnectableTransport(this.transport)) {
      await this.transport.connect();
    }
    this.connected = true;
  }

  async close(): Promise<void> {
    await this.transport.close?.();
    this.connected = false;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    await this.connect();
    return await this.transport.request<T>(method, params, options);
  }

  events(filter?: (event: OpenClawEvent) => boolean): AsyncIterable<OpenClawEvent> {
    const source = this.transport.events();
    async function* iterate(): AsyncIterable<OpenClawEvent> {
      for await (const event of source) {
        const normalized = normalizeGatewayEvent(event);
        if (!filter || filter(normalized)) {
          yield normalized;
        }
      }
    }
    return iterate();
  }

  rawEvents(filter?: (event: GatewayEvent) => boolean): AsyncIterable<GatewayEvent> {
    return this.transport.events(filter);
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

  events(filter?: (event: OpenClawEvent) => boolean): AsyncIterable<OpenClawEvent> {
    return this.client.events((event) => {
      if (event.runId !== this.id) {
        return false;
      }
      return filter ? filter(event) : true;
    });
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
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const status = runStatusFromWaitPayload(raw);
    const error = readOptionalString(record.error)
      ? { message: readOptionalString(record.error) ?? "run failed" }
      : undefined;
    return {
      runId: this.id,
      status,
      sessionKey: readOptionalString(record.sessionKey) ?? this.sessionKey,
      sessionId: readOptionalString(record.sessionId),
      startedAt: readOptionalTimestamp(record.startedAt),
      endedAt: readOptionalTimestamp(record.endedAt),
      ...(error ? { error } : {}),
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
    const raw = await this.client.request("sessions.send", params, { expectFinal: true });
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const runId = readOptionalString(record.runId);
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
    return await this.client.request("sessions.compact", { key: this.key, ...params });
  }
}

export class AgentsNamespace {
  constructor(private readonly client: OpenClaw) {}

  async list(params?: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("agents.list", params);
  }

  async get(id: string): Promise<Agent> {
    return new Agent(this.client, id);
  }

  async create(params: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("agents.create", params);
  }

  async update(params: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("agents.update", params);
  }

  async delete(params: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("agents.delete", params);
  }
}

export class SessionsNamespace {
  constructor(private readonly client: OpenClaw) {}

  async list(params?: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("sessions.list", params);
  }

  async create(params: SessionCreateParams = {}): Promise<Session> {
    const raw = await this.client.request("sessions.create", params);
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const key =
      readOptionalString(record.key) ?? readOptionalString(record.sessionKey) ?? params.key;
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
    const raw = await this.client.request("agent", buildAgentParams(params), {
      expectFinal: false,
      timeoutMs: params.timeoutMs,
    });
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const runId = readOptionalString(record.runId);
    if (!runId) {
      throw new Error("agent did not return a runId");
    }
    return new Run(this.client, runId, readOptionalString(record.sessionKey) ?? params.sessionKey);
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

export class TasksNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "tasks");
  }

  async list(params?: unknown): Promise<unknown> {
    void params;
    return unsupportedGatewayApi("oc.tasks.list");
  }

  async get(taskId: string): Promise<unknown> {
    void taskId;
    return unsupportedGatewayApi("oc.tasks.get");
  }

  async cancel(taskId: string): Promise<unknown> {
    void taskId;
    return unsupportedGatewayApi("oc.tasks.cancel");
  }
}

export class ModelsNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "models");
  }

  async list(params?: unknown): Promise<unknown> {
    return await this.call("list", params);
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
    return await this.call("catalog", params);
  }

  async effective(params?: unknown): Promise<unknown> {
    return await this.call("effective", params);
  }

  async invoke(name: string, params?: unknown): Promise<unknown> {
    void name;
    void params;
    return unsupportedGatewayApi("oc.tools.invoke");
  }
}

export class ArtifactsNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "artifacts");
  }

  async list(params?: unknown): Promise<unknown> {
    void params;
    return unsupportedGatewayApi("oc.artifacts.list");
  }

  async get(id: string): Promise<unknown> {
    void id;
    return unsupportedGatewayApi("oc.artifacts.get");
  }

  async download(id: string): Promise<unknown> {
    void id;
    return unsupportedGatewayApi("oc.artifacts.download");
  }
}

export class ApprovalsNamespace {
  constructor(private readonly client: OpenClaw) {}

  async list(params?: unknown): Promise<unknown> {
    return await this.client.request("exec.approval.list", params);
  }

  async respond(approvalId: string, decision: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("exec.approval.resolve", { approvalId, ...decision });
  }
}

export class EnvironmentsNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "environments");
  }

  async list(params?: unknown): Promise<unknown> {
    void params;
    return unsupportedGatewayApi("oc.environments.list");
  }

  async create(params?: unknown): Promise<unknown> {
    void params;
    return unsupportedGatewayApi("oc.environments.create");
  }

  async status(environmentId: string): Promise<unknown> {
    void environmentId;
    return unsupportedGatewayApi("oc.environments.status");
  }

  async delete(environmentId: string): Promise<unknown> {
    void environmentId;
    return unsupportedGatewayApi("oc.environments.delete");
  }
}
