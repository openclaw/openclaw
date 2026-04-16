import { z } from "zod";

export const A2A_BROKER_ADAPTER_PLUGIN_ID = "a2a-broker-adapter";

const DEFAULT_USER_AGENT = "openclaw-a2a-standalone-broker/0.1";

const UnknownRecordSchema = z.record(z.string(), z.unknown());
const A2ABrokerPartyKindSchema = z.enum(["session", "node", "user", "service"]);
const A2ABrokerPartyRoleSchema = z.enum([
  "hub",
  "live-trader",
  "researcher",
  "analyst",
  "operator",
]);
const A2ABrokerTaskIntentSchema = z.enum([
  "chat",
  "analyze",
  "backfill",
  "propose_patch",
  "propose_params",
  "validate_change",
  "apply_local_change",
  "promote_to_live",
  "rollback_live",
]);
const A2ABrokerTaskStatusSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

const A2ABrokerPartyRefSchema = z
  .object({
    id: z.string().min(1),
    kind: A2ABrokerPartyKindSchema.optional(),
    role: A2ABrokerPartyRoleSchema.optional(),
  })
  .strict();

const A2ABrokerViaSchema = z
  .object({
    transport: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerWorkspaceRefSchema = z
  .object({
    nodeId: z.string().min(1),
    workspaceId: z.string().min(1),
    pathHint: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    strategyId: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskPolicyContextSchema = z
  .object({
    requiresApproval: z.boolean().optional(),
    liveImpact: z.boolean().optional(),
    targetEnvironment: z.enum(["research", "staging", "live"]).optional(),
  })
  .strict();

const A2ABrokerTaskValidationPayloadSchema = z
  .object({
    nodeId: z.string().min(1).optional(),
    kind: z.enum(["backfill", "paper", "replay", "smoke"]),
    verdict: z.enum(["pass", "fail", "warn"]),
    metrics: UnknownRecordSchema.optional(),
    artifactIds: z.array(z.string().min(1)).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskApplyPayloadSchema = z
  .object({
    workspace: A2ABrokerWorkspaceRefSchema.optional(),
    artifactIds: z.array(z.string().min(1)).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskResultSchema = z
  .object({
    summary: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
    artifactIds: z.array(z.string().min(1)).optional(),
    output: UnknownRecordSchema.optional(),
    validation: A2ABrokerTaskValidationPayloadSchema.optional(),
    apply: A2ABrokerTaskApplyPayloadSchema.optional(),
  })
  .strict();

const A2ABrokerTaskErrorSchema = z
  .object({
    code: z.string().min(1).optional(),
    message: z.string().min(1),
    details: UnknownRecordSchema.optional(),
  })
  .strict();

const A2ABrokerTaskCancelRequestSchema = z
  .object({
    actor: A2ABrokerPartyRefSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();

const A2ABrokerTaskCreateRequestSchema = z
  .object({
    id: z.string().min(1).optional(),
    exchangeId: z.string().min(1).optional(),
    intent: A2ABrokerTaskIntentSchema,
    requester: A2ABrokerPartyRefSchema,
    target: A2ABrokerPartyRefSchema,
    workspace: A2ABrokerWorkspaceRefSchema.optional(),
    message: z.string().min(1).optional(),
    proposalId: z.string().min(1).optional(),
    artifactIds: z.array(z.string().min(1)).optional(),
    assignedWorkerId: z.string().min(1).optional(),
    via: A2ABrokerViaSchema.optional(),
    policyContext: A2ABrokerTaskPolicyContextSchema.optional(),
    payload: UnknownRecordSchema.optional(),
  })
  .strict();

const A2ABrokerTaskRecordSchema = A2ABrokerTaskCreateRequestSchema.extend({
  id: z.string().min(1),
  status: A2ABrokerTaskStatusSchema,
  targetNodeId: z.string().min(1),
  payload: UnknownRecordSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  claimedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
  claimedBy: z.string().min(1).optional(),
  result: A2ABrokerTaskResultSchema.optional(),
  error: A2ABrokerTaskErrorSchema.optional(),
});

const A2ABrokerHealthSchema = z
  .object({
    ok: z.boolean(),
    service: z.string().min(1),
    publicBaseUrl: z.string().min(1),
  })
  .passthrough();

const OpenClawA2ABrokerTaskBridgeRequestSchema = z
  .object({
    taskId: z.string().min(1).optional(),
    waitRunId: z.string().min(1).optional(),
    correlationId: z.string().min(1).optional(),
    parentRunId: z.string().min(1).optional(),
    requesterNodeId: z.string().min(1).optional(),
    requesterSessionKey: z.string().min(1).optional(),
    requesterChannel: z.string().min(1).optional(),
    targetNodeId: z.string().min(1).optional(),
    targetSessionKey: z.string().min(1),
    targetDisplayKey: z.string().min(1),
    originalMessage: z.string().min(1),
    roundOneReply: z.string().min(1).optional(),
    announceTimeoutMs: z.number().int().nonnegative(),
    maxPingPongTurns: z.number().int().nonnegative(),
    cancelTarget: z
      .object({
        kind: z.literal("session_run"),
        sessionKey: z.string().min(1),
        runId: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict();

export type A2ABrokerPartyKind = z.infer<typeof A2ABrokerPartyKindSchema>;
export type A2ABrokerPartyRole = z.infer<typeof A2ABrokerPartyRoleSchema>;
export type A2ABrokerTaskIntent = z.infer<typeof A2ABrokerTaskIntentSchema>;
export type A2ABrokerTaskStatus = z.infer<typeof A2ABrokerTaskStatusSchema>;
export type A2ABrokerPartyRef = z.infer<typeof A2ABrokerPartyRefSchema>;
export type A2ABrokerTaskCancelRequest = z.infer<typeof A2ABrokerTaskCancelRequestSchema>;
export type A2ABrokerTaskCreateRequest = z.infer<typeof A2ABrokerTaskCreateRequestSchema>;
export type A2ABrokerTaskRecord = z.infer<typeof A2ABrokerTaskRecordSchema>;
export type A2ABrokerHealth = z.infer<typeof A2ABrokerHealthSchema>;
export type OpenClawA2ABrokerTaskBridgeRequest = z.infer<
  typeof OpenClawA2ABrokerTaskBridgeRequestSchema
>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type A2ABrokerClientOptions = {
  baseUrl: string;
  edgeSecret?: string;
  requester?: A2ABrokerPartyRef;
  fetchImpl?: FetchLike;
  userAgent?: string;
};

export class A2ABrokerClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "A2ABrokerClientError";
  }
}

export class A2ABrokerMalformedResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(message);
    this.name = "A2ABrokerMalformedResponseError";
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRequiredTaskId(taskId: string): string {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) {
    throw new Error("taskId is required");
  }
  return normalizedTaskId;
}

function buildEndpointUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//, ""), `${baseUrl}/`).toString();
}

async function readBrokerText(response: Response): Promise<string | undefined> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  return text;
}

async function readBrokerJson(response: Response): Promise<unknown> {
  const text = await readBrokerText(response);
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new A2ABrokerMalformedResponseError(
      `Broker returned malformed JSON (${response.status})`,
      response.status,
      text,
    );
  }
}

function buildClientError(response: Response, body: unknown): A2ABrokerClientError {
  if (body && typeof body === "object" && "error" in body) {
    const bodyRecord = body as Record<string, unknown>;
    const error = bodyRecord.error;
    if (error && typeof error === "object") {
      const errorRecord = error as Record<string, unknown>;
      const code =
        typeof errorRecord.code === "string" && errorRecord.code.trim()
          ? errorRecord.code.trim()
          : undefined;
      const message =
        typeof errorRecord.message === "string" && errorRecord.message.trim()
          ? errorRecord.message.trim()
          : `Broker request failed with ${response.status}`;
      return new A2ABrokerClientError(message, response.status, code, body);
    }
  }
  if (typeof body === "string" && body.trim()) {
    return new A2ABrokerClientError(body.trim(), response.status, undefined, body);
  }
  return new A2ABrokerClientError(
    `Broker request failed with ${response.status}`,
    response.status,
    undefined,
    body,
  );
}

async function parseBrokerJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body = await readBrokerJson(response);
  if (!response.ok) {
    throw buildClientError(response, body);
  }
  return schema.parse(body);
}

function buildRequestHeaders(params: {
  requester?: A2ABrokerPartyRef;
  edgeSecret?: string;
  userAgent: string;
  contentType?: string;
}): Headers {
  const headers = new Headers({
    accept: "application/json",
    "user-agent": params.userAgent,
  });
  if (params.contentType) {
    headers.set("content-type", params.contentType);
  }
  if (params.edgeSecret) {
    headers.set("x-a2a-edge-secret", params.edgeSecret);
  }
  if (params.requester) {
    headers.set("x-a2a-requester-id", params.requester.id);
    if (params.requester.kind) {
      headers.set("x-a2a-requester-kind", params.requester.kind);
    }
    if (params.requester.role) {
      headers.set("x-a2a-requester-role", params.requester.role);
    }
  }
  return headers;
}

export function normalizeA2ABrokerBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("A2A broker baseUrl is required");
  }
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("A2A broker baseUrl must use http or https");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname || "/";
  const href = url.toString();
  return href.endsWith("/") ? href.slice(0, -1) : href;
}

export function buildBrokerCreateTaskRequestFromOpenClaw(
  input: OpenClawA2ABrokerTaskBridgeRequest,
): A2ABrokerTaskCreateRequest {
  const request = OpenClawA2ABrokerTaskBridgeRequestSchema.parse(input);
  const requesterNodeId = normalizeOptionalString(request.requesterNodeId);
  const requesterSessionKey = normalizeOptionalString(request.requesterSessionKey);
  const requesterChannel = normalizeOptionalString(request.requesterChannel);
  const targetNodeId = normalizeOptionalString(request.targetNodeId);
  const correlationId = normalizeOptionalString(request.correlationId);
  const parentRunId = normalizeOptionalString(request.parentRunId);
  const requesterId = requesterNodeId ?? requesterSessionKey ?? "openclaw";
  const targetId = targetNodeId ?? request.targetSessionKey;
  const taskId =
    normalizeOptionalString(request.taskId) ?? normalizeOptionalString(request.waitRunId);

  return {
    ...(taskId ? { id: taskId } : {}),
    intent: "chat",
    requester: {
      id: requesterId,
      kind: requesterNodeId ? "node" : requesterSessionKey ? "session" : "service",
      role: "hub",
    },
    target: {
      id: targetId,
      kind: targetNodeId ? "node" : "session",
    },
    ...(targetNodeId ? { assignedWorkerId: targetNodeId } : {}),
    message: request.originalMessage,
    via: {
      transport: "openclaw",
      ...(requesterChannel ? { channel: requesterChannel } : {}),
      ...(requesterSessionKey ? { sessionId: requesterSessionKey } : {}),
      ...((correlationId ?? request.waitRunId)
        ? { traceId: correlationId ?? request.waitRunId }
        : {}),
    },
    payload: {
      ...(taskId ? { taskId } : {}),
      targetSessionKey: request.targetSessionKey,
      targetDisplayKey: request.targetDisplayKey,
      announceTimeoutMs: request.announceTimeoutMs,
      maxPingPongTurns: request.maxPingPongTurns,
      ...(requesterSessionKey ? { requesterSessionKey } : {}),
      ...(requesterChannel ? { requesterChannel } : {}),
      ...(request.roundOneReply ? { roundOneReply: request.roundOneReply } : {}),
      ...(request.waitRunId ? { waitRunId: request.waitRunId } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(parentRunId ? { parentRunId } : {}),
      ...(request.cancelTarget ? { cancelTarget: request.cancelTarget } : {}),
    },
  };
}

export function createA2ABrokerClient(options: A2ABrokerClientOptions) {
  const baseUrl = normalizeA2ABrokerBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const edgeSecret = normalizeOptionalString(options.edgeSecret);
  const userAgent = normalizeOptionalString(options.userAgent) ?? DEFAULT_USER_AGENT;

  return {
    async health(): Promise<A2ABrokerHealth> {
      const response = await fetchImpl(buildEndpointUrl(baseUrl, "health"), {
        method: "GET",
        headers: buildRequestHeaders({
          userAgent,
        }),
      });
      return await parseBrokerJson(response, A2ABrokerHealthSchema);
    },

    async createTask(
      request: A2ABrokerTaskCreateRequest,
      overrides?: { requester?: A2ABrokerPartyRef },
    ): Promise<A2ABrokerTaskRecord> {
      const parsedRequest = A2ABrokerTaskCreateRequestSchema.parse(request);
      const requester = overrides?.requester ?? parsedRequest.requester ?? options.requester;
      const response = await fetchImpl(buildEndpointUrl(baseUrl, "tasks"), {
        method: "POST",
        headers: buildRequestHeaders({
          requester,
          edgeSecret,
          userAgent,
          contentType: "application/json",
        }),
        body: JSON.stringify(parsedRequest),
      });
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },

    async getTask(taskId: string): Promise<A2ABrokerTaskRecord> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `tasks/${encodeURIComponent(normalizedTaskId)}`),
        {
          method: "GET",
          headers: buildRequestHeaders({
            requester: options.requester,
            edgeSecret,
            userAgent,
          }),
        },
      );
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },

    async cancelTask(
      taskId: string,
      request?: Partial<A2ABrokerTaskCancelRequest>,
      overrides?: { requester?: A2ABrokerPartyRef },
    ): Promise<A2ABrokerTaskRecord> {
      const normalizedTaskId = normalizeRequiredTaskId(taskId);
      const requester = overrides?.requester ?? request?.actor ?? options.requester;
      const actor = request?.actor ?? requester;
      if (!actor) {
        throw new Error("actor or configured requester is required to cancel a broker task");
      }
      const parsedRequest = A2ABrokerTaskCancelRequestSchema.parse({
        actor,
        ...(normalizeOptionalString(request?.reason)
          ? { reason: normalizeOptionalString(request?.reason) }
          : {}),
      });
      const response = await fetchImpl(
        buildEndpointUrl(baseUrl, `tasks/${encodeURIComponent(normalizedTaskId)}/cancel`),
        {
          method: "POST",
          headers: buildRequestHeaders({
            requester,
            edgeSecret,
            userAgent,
            contentType: "application/json",
          }),
          body: JSON.stringify(parsedRequest),
        },
      );
      return await parseBrokerJson(response, A2ABrokerTaskRecordSchema);
    },
  };
}
