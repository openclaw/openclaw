import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeTaskFlow } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  createTaskFlowWebhookRequestHandler,
  type TaskFlowWebhookTarget,
  type WebhookTarget,
} from "./http.js";

const hoisted = vi.hoisted(() => {
  const resolveConfiguredSecretInputStringMock = vi.fn();
  return {
    resolveConfiguredSecretInputStringMock,
  };
});

vi.mock("../runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-api.js")>();
  hoisted.resolveConfiguredSecretInputStringMock.mockImplementation(
    actual.resolveConfiguredSecretInputString,
  );
  return {
    ...actual,
    resolveConfiguredSecretInputString: hoisted.resolveConfiguredSecretInputStringMock,
  };
});

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
  socket: { remoteAddress: string };
};

let nextSessionId = 0;

function createJsonRequest(params: {
  path: string;
  secret?: string;
  body: unknown;
  headers?: Record<string, string>;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = "POST";
  req.url = params.path;
  req.headers = {
    "content-type": "application/json",
    ...(params.secret ? { "x-openclaw-webhook-secret": params.secret } : {}),
    ...(params.headers ?? {}),
  };
  req.socket = { remoteAddress: "127.0.0.1" } as MockIncomingMessage["socket"];
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];

  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(params.body), "utf8"));
    req.emit("end");
  });

  return req;
}

function createRawJsonRequest(params: {
  path: string;
  rawBody: string;
  headers?: Record<string, string>;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = "POST";
  req.url = params.path;
  req.headers = {
    "content-type": "application/json",
    ...(params.headers ?? {}),
  };
  req.socket = { remoteAddress: "127.0.0.1" } as MockIncomingMessage["socket"];
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];

  setImmediate(() => {
    req.emit("data", Buffer.from(params.rawBody, "utf8"));
    req.emit("end");
  });

  return req;
}

function createHandler(): {
  handler: ReturnType<typeof createTaskFlowWebhookRequestHandler>;
  target: TaskFlowWebhookTarget;
  secret: string;
} {
  const runtime = createRuntimeTaskFlow();
  nextSessionId += 1;
  const secret = "shared-secret";
  const target: TaskFlowWebhookTarget = {
    routeId: "zapier",
    path: "/plugins/webhooks/zapier",
    secretInput: secret,
    secretConfigPath: "plugins.entries.webhooks.routes.zapier.secret",
    defaultControllerId: "webhooks/zapier",
    taskFlow: runtime.bindSession({
      sessionKey: `agent:main:webhook-test-${String(nextSessionId)}`,
    }),
  };
  const targetsByPath = new Map<string, TaskFlowWebhookTarget[]>([[target.path, [target]]]);
  return {
    handler: createTaskFlowWebhookRequestHandler({
      cfg: {} as OpenClawConfig,
      targetsByPath,
    }),
    target,
    secret,
  };
}

function createHandlerWithTarget(
  target: WebhookTarget,
  cfg: OpenClawConfig = {} as OpenClawConfig,
  overrides: Partial<Parameters<typeof createTaskFlowWebhookRequestHandler>[0]> = {},
): ReturnType<typeof createTaskFlowWebhookRequestHandler> {
  const targetsByPath = new Map<string, WebhookTarget[]>([[target.path, [target]]]);
  return createTaskFlowWebhookRequestHandler({
    cfg,
    targetsByPath,
    ...overrides,
  });
}

async function dispatchJsonRequest(params: {
  handler: ReturnType<typeof createTaskFlowWebhookRequestHandler>;
  path: string;
  secret?: string;
  body: unknown;
  headers?: Record<string, string>;
}) {
  const req = createJsonRequest({
    path: params.path,
    secret: params.secret,
    body: params.body,
    headers: params.headers,
  });
  const res = createMockServerResponse();
  await params.handler(req, res);
  return res;
}

function parseJsonBody(res: { body?: string | Buffer | null }) {
  return JSON.parse(String(res.body ?? ""));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("createTaskFlowWebhookRequestHandler", () => {
  it("rejects requests with the wrong secret", async () => {
    const { handler, target } = createHandler();
    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret: "wrong-secret",
      body: {
        action: "list_flows",
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
    expect(target.taskFlow.list()).toStrictEqual([]);
    expect(hoisted.resolveConfiguredSecretInputStringMock).not.toHaveBeenCalled();
  });

  it("answers route verification challenges after route-specific auth", async () => {
    const scheduleSessionTurn = vi.fn();
    const target: WebhookTarget = {
      routeId: "meego",
      path: "/plugins/webhooks/meego-requirement-created",
      dispatchMode: "agent",
      sessionKey: "agent:requirement-triager:main",
      auth: {
        mode: "header",
        header: "x-meego-webhook-token",
        secret: "shared-secret",
      },
      event: {
        payloadPath: "type",
      },
      verification: {
        event: "url_verification",
        challengePath: "challenge",
        responsePath: "challenge",
      },
      agent: {
        deliveryMode: "none",
        delayMs: 1,
      },
    };
    const handler = createHandlerWithTarget(target, {} as OpenClawConfig, {
      scheduleSessionTurn,
    });

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        "x-meego-webhook-token": "shared-secret",
      },
      body: {
        type: "url_verification",
        challenge: "verify-me",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res)).toEqual({ challenge: "verify-me" });
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("does not answer verification challenges without matching auth", async () => {
    const scheduleSessionTurn = vi.fn();
    const target: WebhookTarget = {
      routeId: "meego",
      path: "/plugins/webhooks/meego-requirement-created",
      dispatchMode: "agent",
      sessionKey: "agent:requirement-triager:main",
      auth: {
        mode: "header",
        header: "x-meego-webhook-token",
        secret: "shared-secret",
      },
      event: {
        payloadPath: "type",
      },
      verification: {
        event: "url_verification",
        challengePath: "challenge",
        responsePath: "challenge",
      },
      agent: {
        deliveryMode: "none",
        delayMs: 1,
      },
    };
    const handler = createHandlerWithTarget(target, {} as OpenClawConfig, {
      scheduleSessionTurn,
    });

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        "x-meego-webhook-token": "wrong-secret",
      },
      body: {
        type: "url_verification",
        challenge: "verify-me",
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("re-resolves SecretRef-backed secrets across requests", async () => {
    const runtime = createRuntimeTaskFlow();
    const target: TaskFlowWebhookTarget = {
      routeId: "cached",
      path: "/plugins/webhooks/cached",
      secretInput: {
        source: "env",
        provider: "default",
        id: "OPENCLAW_WEBHOOK_SECRET",
      },
      secretConfigPath: "plugins.entries.webhooks.routes.cached.secret",
      defaultControllerId: "webhooks/cached",
      taskFlow: runtime.bindSession({
        sessionKey: "agent:main:webhook-cached",
      }),
    };
    hoisted.resolveConfiguredSecretInputStringMock
      .mockResolvedValueOnce({ value: "shared-secret" })
      .mockResolvedValueOnce({ value: "rotated-secret" })
      .mockResolvedValueOnce({ value: "rotated-secret" });
    const handler = createHandlerWithTarget(target);

    const first = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret: "shared-secret",
      body: {
        action: "list_flows",
      },
    });
    const second = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret: "shared-secret",
      body: {
        action: "list_flows",
      },
    });
    const third = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret: "rotated-secret",
      body: {
        action: "list_flows",
      },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    expect(second.body).toBe("unauthorized");
    expect(third.statusCode).toBe(200);
    expect(hoisted.resolveConfiguredSecretInputStringMock).toHaveBeenCalledTimes(3);
  });

  it("creates flows through the bound session and scrubs owner metadata from responses", async () => {
    const { handler, target, secret } = createHandler();
    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "create_flow",
        goal: "Review inbound queue",
      },
    });

    expect(res.statusCode).toBe(200);
    const parsed = parseJsonBody(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.flow.syncMode).toBe("managed");
    expect(parsed.result.flow.controllerId).toBe("webhooks/zapier");
    expect(parsed.result.flow.goal).toBe("Review inbound queue");
    expect(parsed.result.flow.ownerKey).toBeUndefined();
    expect(parsed.result.flow.requesterOrigin).toBeUndefined();
    expect(target.taskFlow.get(parsed.result.flow.flowId)?.flowId).toBe(parsed.result.flow.flowId);
  });

  it("runs child tasks and scrubs task ownership fields from responses", async () => {
    const { handler, target, secret } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Triage inbox",
    });
    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:main:subagent:child",
        task: "Inspect the next message batch",
        status: "running",
        startedAt: 10,
        lastEventAt: 10,
      },
    });

    expect(res.statusCode).toBe(200);
    const parsed = parseJsonBody(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.created).toBe(true);
    expect(parsed.result.task.parentFlowId).toBe(flow.flowId);
    expect(parsed.result.task.childSessionKey).toBe("agent:main:subagent:child");
    expect(parsed.result.task.runtime).toBe("acp");
    expect(parsed.result.task.ownerKey).toBeUndefined();
    expect(parsed.result.task.requesterSessionKey).toBeUndefined();
  });

  it("returns 404 for missing flow mutations", async () => {
    const { handler, target, secret } = createHandler();
    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "set_waiting",
        flowId: "flow-missing",
        expectedRevision: 0,
      },
    });

    expect(res.statusCode).toBe(404);
    const parsed = parseJsonBody(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("not_found");
    expect(parsed.error).toBe("TaskFlow not found.");
    expect(parsed.result.applied).toBe(false);
    expect(parsed.result.code).toBe("not_found");
  });

  it("returns 409 for revision conflicts", async () => {
    const { handler, target, secret } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Review inbox",
    });
    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "set_waiting",
        flowId: flow.flowId,
        expectedRevision: flow.revision + 1,
      },
    });

    expect(res.statusCode).toBe(409);
    const parsed = parseJsonBody(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("revision_conflict");
    expect(parsed.result.applied).toBe(false);
    expect(parsed.result.code).toBe("revision_conflict");
    expect(parsed.result.current.flowId).toBe(flow.flowId);
    expect(parsed.result.current.revision).toBe(flow.revision);
  });

  it("rejects internal runtimes and running-only metadata from external callers", async () => {
    const { handler, target, secret } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Review inbox",
    });

    const runtimeRes = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "cli",
        task: "Inspect queue",
      },
    });
    expect(runtimeRes.statusCode).toBe(400);
    const runtimeParsed = parseJsonBody(runtimeRes);
    expect(runtimeParsed.ok).toBe(false);
    expect(runtimeParsed.code).toBe("invalid_request");

    const queuedMetadataRes = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "acp",
        task: "Inspect queue",
        startedAt: 10,
      },
    });
    expect(queuedMetadataRes.statusCode).toBe(400);
    const queuedMetadataParsed = parseJsonBody(queuedMetadataRes);
    expect(queuedMetadataParsed.ok).toBe(false);
    expect(queuedMetadataParsed.code).toBe("invalid_request");
    expect(queuedMetadataParsed.error).toBe(
      "status: status must be running when startedAt, lastEventAt, or progressSummary is provided",
    );
  });

  it("reuses the same task record when retried with the same runId", async () => {
    const { handler, target, secret } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Triage inbox",
    });

    const first = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:main:subagent:child",
        runId: "retry-me",
        task: "Inspect the next message batch",
      },
    });
    const second = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:main:subagent:child",
        runId: "retry-me",
        task: "Inspect the next message batch",
      },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstParsed = parseJsonBody(first);
    const secondParsed = parseJsonBody(second);
    expect(firstParsed.result.task.taskId).toBe(secondParsed.result.task.taskId);
    expect(target.taskFlow.getTaskSummary(flow.flowId)?.total).toBe(1);
  });

  it("returns 409 when cancellation targets a terminal flow", async () => {
    const { handler, target, secret } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Review inbox",
    });
    const finished = target.taskFlow.finish({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
    });
    expect(finished.applied).toBe(true);

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "cancel_flow",
        flowId: flow.flowId,
      },
    });

    expect(res.statusCode).toBe(409);
    const parsed = parseJsonBody(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("terminal");
    expect(parsed.error).toBe("Flow is already succeeded.");
    expect(parsed.result.found).toBe(true);
    expect(parsed.result.cancelled).toBe(false);
    expect(parsed.result.reason).toBe("Flow is already succeeded.");
  });

  it("acknowledges generic routes authenticated by a configured header", async () => {
    const target: WebhookTarget = {
      routeId: "alerts",
      path: "/plugins/webhooks/alerts",
      dispatchMode: "ack",
      auth: {
        mode: "header",
        header: "x-alert-token",
        secret: "shared-secret",
      },
      event: {
        header: "x-alert-event",
        payloadPath: "event.type",
      },
      events: ["incident.created"],
    };
    const handler = createHandlerWithTarget(target);

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        "x-alert-token": "shared-secret",
        "x-alert-event": "incident.created",
      },
      body: {
        event: {
          type: "incident.created",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      ok: true,
      routeId: "alerts",
      result: {
        action: "ack",
        eventType: "incident.created",
      },
    });
  });

  it("acknowledges and skips events outside a route allowlist", async () => {
    const target: WebhookTarget = {
      routeId: "alerts",
      path: "/plugins/webhooks/alerts",
      dispatchMode: "ack",
      auth: {
        mode: "bearer",
        prefix: "Bearer",
        secret: "shared-secret",
      },
      event: {
        payloadPath: "event.type",
      },
      events: ["incident.created"],
    };
    const handler = createHandlerWithTarget(target);

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
      },
      body: {
        event: {
          type: "incident.closed",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      ok: true,
      routeId: "alerts",
      skipped: true,
      reason: "event_not_allowed",
      eventType: "incident.closed",
    });
  });

  it("validates hmac-sha256 auth against the raw JSON body", async () => {
    const target: WebhookTarget = {
      routeId: "github",
      path: "/plugins/webhooks/github",
      dispatchMode: "ack",
      auth: {
        mode: "hmac-sha256",
        header: "x-hub-signature-256",
        prefix: "sha256=",
        secret: "signing-secret",
      },
      event: {
        header: "x-github-event",
      },
    };
    const handler = createHandlerWithTarget(target);
    const rawBody = JSON.stringify({
      delivery: {
        id: "evt-1",
      },
    });
    const goodSignature = createHmac("sha256", "signing-secret").update(rawBody).digest("hex");

    const acceptedReq = createRawJsonRequest({
      path: target.path,
      rawBody,
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${goodSignature}`,
      },
    });
    const acceptedRes = createMockServerResponse();
    await handler(acceptedReq, acceptedRes);

    expect(acceptedRes.statusCode).toBe(200);
    expect(parseJsonBody(acceptedRes)).toEqual({
      ok: true,
      routeId: "github",
      result: {
        action: "ack",
        eventType: "issues",
      },
    });

    const rejectedReq = createRawJsonRequest({
      path: target.path,
      rawBody,
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": "sha256=bad",
      },
    });
    const rejectedRes = createMockServerResponse();
    await handler(rejectedReq, rejectedRes);

    expect(rejectedRes.statusCode).toBe(401);
    expect(rejectedRes.body).toBe("unauthorized");
  });

  it("deduplicates ack routes with configured idempotency keys", async () => {
    const target: WebhookTarget = {
      routeId: "alerts",
      path: "/plugins/webhooks/alerts",
      dispatchMode: "ack",
      auth: {
        mode: "bearer",
        prefix: "Bearer",
        secret: "shared-secret",
      },
      event: {
        payloadPath: "event.type",
      },
      idempotency: {
        payloadPath: "delivery.id",
        ttlMs: 60_000,
      },
    };
    const handler = createHandlerWithTarget(target);

    const first = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
      },
      body: {
        delivery: {
          id: "evt-1",
        },
        event: {
          type: "incident.created",
        },
      },
    });
    const second = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
      },
      body: {
        delivery: {
          id: "evt-1",
        },
        event: {
          type: "incident.created",
        },
      },
    });

    expect(first.statusCode).toBe(200);
    expect(parseJsonBody(first)).toEqual({
      ok: true,
      routeId: "alerts",
      result: {
        action: "ack",
        eventType: "incident.created",
        idempotencyKey: "evt-1",
      },
    });
    expect(second.statusCode).toBe(200);
    expect(parseJsonBody(second)).toEqual({
      ok: true,
      routeId: "alerts",
      duplicate: true,
      idempotencyKey: "evt-1",
    });
  });

  it("resolves event and idempotency payload paths through arrays", async () => {
    const target: WebhookTarget = {
      routeId: "batched",
      path: "/plugins/webhooks/batched",
      dispatchMode: "ack",
      auth: {
        mode: "bearer",
        prefix: "Bearer",
        secret: "shared-secret",
      },
      event: {
        payloadPath: "events.0.type",
      },
      idempotency: {
        payloadPath: "events.0.id",
        ttlMs: 60_000,
      },
    };
    const handler = createHandlerWithTarget(target);

    const first = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
      },
      body: {
        events: [{ id: "evt-array-1", type: "record.updated" }],
      },
    });
    const second = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
      },
      body: {
        events: [{ id: "evt-array-1", type: "record.updated" }],
      },
    });

    expect(first.statusCode).toBe(200);
    expect(parseJsonBody(first)).toEqual({
      ok: true,
      routeId: "batched",
      result: {
        action: "ack",
        eventType: "record.updated",
        idempotencyKey: "evt-array-1",
      },
    });
    expect(second.statusCode).toBe(200);
    expect(parseJsonBody(second)).toEqual({
      ok: true,
      routeId: "batched",
      duplicate: true,
      idempotencyKey: "evt-array-1",
    });
  });

  it("schedules an agent turn from a templated webhook payload", async () => {
    const scheduleSessionTurn = vi.fn(async (params) => ({
      id: "job-1",
      pluginId: "webhooks",
      sessionKey: params.sessionKey,
      kind: "session-turn",
    }));
    const target: WebhookTarget = {
      routeId: "incidents",
      path: "/plugins/webhooks/incidents",
      dispatchMode: "agent",
      auth: {
        mode: "bearer",
        prefix: "Bearer",
        secret: "shared-secret",
      },
      event: {},
      idempotency: {
        payloadPath: "delivery.id",
        ttlMs: 60_000,
      },
      prompt:
        "Investigate incident {incident.id}: {incident.title}\nRaw: {__raw__}\nMissing: {{json incident.missing}}",
      skills: ["incident-response"],
      sessionKey: "agent:main:main",
      agent: {
        deliveryMode: "none",
        delayMs: 1,
        nameTemplate: "incident-{incident.id}",
        tagTemplate: "incident:{incident.id}",
      },
    };
    const handler = createHandlerWithTarget(target, {} as OpenClawConfig, {
      scheduleSessionTurn,
    });

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
        "x-github-event": "incident.created",
      },
      body: {
        delivery: { id: "evt-agent-1" },
        incident: {
          id: "INC-123",
          title: "database latency",
        },
      },
    });

    expect(res.statusCode).toBe(202);
    expect(parseJsonBody(res)).toEqual({
      ok: true,
      routeId: "incidents",
      result: {
        action: "agent_dispatch",
        sessionKey: "agent:main:main",
        accepted: true,
        jobId: "job-1",
      },
    });
    await vi.waitFor(() => expect(scheduleSessionTurn).toHaveBeenCalledTimes(1));
    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    expect(scheduleSessionTurn).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      message: expect.stringContaining("Investigate incident INC-123: database latency"),
      deliveryMode: "none",
      delayMs: 1,
      deleteAfterRun: true,
      name: "incident-INC-123",
      tag: "incident-INC-123",
    });
    expect(scheduleSessionTurn.mock.calls[0]?.[0].message).toContain(
      "Use these OpenClaw skills when useful: incident-response",
    );
    expect(scheduleSessionTurn.mock.calls[0]?.[0].message).toContain("\nMissing:\n");
    expect(scheduleSessionTurn.mock.calls[0]?.[0].message).not.toContain("Missing: null");
  });

  it("logs deliver-only routes without requiring a TaskFlow session", async () => {
    const info = vi.fn();
    const target: WebhookTarget = {
      routeId: "audit",
      path: "/plugins/webhooks/audit",
      dispatchMode: "deliver",
      auth: {
        mode: "header",
        header: "x-audit-token",
        secret: "shared-secret",
      },
      event: {},
      prompt: "Audit event {event.action} for {actor.email}",
      delivery: {
        mode: "log",
      },
    };
    const handler = createHandlerWithTarget(target, {} as OpenClawConfig, {
      logger: { info },
    });

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        "x-audit-token": "shared-secret",
      },
      body: {
        event: { action: "user.created" },
        actor: { email: "operator@example.com" },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      ok: true,
      routeId: "audit",
      result: {
        action: "deliver",
        mode: "log",
        eventType: "user.created",
      },
    });
    expect(info).toHaveBeenCalledWith("[webhooks] delivery event", {
      routeId: "audit",
      eventType: "user.created",
      idempotencyKey: undefined,
      text: "Audit event user.created for operator@example.com",
    });
  });

  it("sends direct channel delivery with rendered target fields", async () => {
    const resolveTarget = vi.fn(() => ({ ok: true as const, to: "chat-42" }));
    const sendText = vi.fn(async () => ({
      channel: "telegram" as const,
      messageId: "msg-1",
    }));
    const loadChannelOutboundAdapter = vi.fn(async () => ({
      deliveryMode: "direct" as const,
      resolveTarget,
      sendText,
    }));
    const target: WebhookTarget = {
      routeId: "alerts",
      path: "/plugins/webhooks/alerts",
      dispatchMode: "deliver",
      auth: {
        mode: "bearer",
        prefix: "Bearer",
        secret: "shared-secret",
      },
      event: {},
      prompt: "Alert {alert.id}: {alert.summary}",
      delivery: {
        mode: "channel",
        channel: "telegram",
        to: "{alert.chat_id}",
        threadId: "{alert.topic_id}",
        textTemplate: "Escalate {alert.id}: {alert.summary}",
        silent: true,
      },
    };
    const cfg = { channels: { telegram: {} } } as unknown as OpenClawConfig;
    const handler = createHandlerWithTarget(target, cfg, { loadChannelOutboundAdapter });

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
        "x-event-type": "alert.opened",
      },
      body: {
        alert: {
          id: "AL-1",
          summary: "API errors",
          chat_id: "chat-42",
          topic_id: "thread-9",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      ok: true,
      routeId: "alerts",
      result: {
        action: "deliver",
        mode: "channel",
        channel: "telegram",
        messageId: "msg-1",
        eventType: "alert.opened",
      },
    });
    expect(loadChannelOutboundAdapter).toHaveBeenCalledWith("telegram");
    expect(resolveTarget).toHaveBeenCalledWith({
      cfg,
      to: "chat-42",
      mode: "explicit",
    });
    expect(sendText).toHaveBeenCalledWith({
      cfg,
      to: "chat-42",
      text: "Escalate AL-1: API errors",
      threadId: "thread-9",
      silent: true,
    });
  });

  it("sends completion delivery to exec commands through stdin", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openclaw-webhook-exec-"));
    try {
      const scriptPath = join(tempDir, "capture.mjs");
      const outputPath = join(tempDir, "out.json");
      await writeFile(
        scriptPath,
        `import { writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), input }));
});
`,
        "utf8",
      );
      const target: WebhookTarget = {
        routeId: "exec",
        path: "/plugins/webhooks/exec",
        dispatchMode: "deliver",
        auth: {
          mode: "header",
          header: "x-hook-token",
          secret: "shared-secret",
        },
        delivery: {
          mode: "exec",
          command: process.execPath,
          args: [scriptPath, outputPath, "{MergeRequest.Number}"],
          textTemplate: "Review {MergeRequest.Number}",
        },
      };
      const handler = createHandlerWithTarget(target);

      const res = await dispatchJsonRequest({
        handler,
        path: target.path,
        headers: { "x-hook-token": "shared-secret" },
        body: {
          MergeRequest: { Number: 9 },
        },
      });

      expect(res.statusCode).toBe(200);
      const output = JSON.parse(await readFile(outputPath, "utf8"));
      expect(output).toEqual({ args: ["9"], input: "Review 9" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lets channel delivery resolve a default target when to is omitted", async () => {
    const resolveTarget = vi.fn(() => ({ ok: true as const, to: "home-chat" }));
    const sendText = vi.fn(async () => ({
      channel: "telegram" as const,
      messageId: "msg-home",
    }));
    const loadChannelOutboundAdapter = vi.fn(async () => ({
      deliveryMode: "direct" as const,
      resolveTarget,
      sendText,
    }));
    const target: WebhookTarget = {
      routeId: "alerts",
      path: "/plugins/webhooks/alerts",
      dispatchMode: "deliver",
      auth: {
        mode: "bearer",
        prefix: "Bearer",
        secret: "shared-secret",
      },
      event: {},
      prompt: "Alert {alert.id}: {alert.summary}",
      delivery: {
        mode: "channel",
        channel: "telegram",
      },
    };
    const cfg = { channels: { telegram: {} } } as unknown as OpenClawConfig;
    const handler = createHandlerWithTarget(target, cfg, { loadChannelOutboundAdapter });

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
      },
      body: {
        alert: {
          id: "AL-2",
          summary: "home channel",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res).result.messageId).toBe("msg-home");
    expect(resolveTarget).toHaveBeenCalledWith({
      cfg,
      mode: "explicit",
    });
    expect(sendText).toHaveBeenCalledWith({
      cfg,
      to: "home-chat",
      text: "Alert AL-2: home channel",
    });
  });

  it("creates a managed TaskFlow and child task from arbitrary webhook JSON", async () => {
    const runtime = createRuntimeTaskFlow();
    const target: TaskFlowWebhookTarget = {
      routeId: "jira",
      path: "/plugins/webhooks/jira",
      dispatchMode: "taskflow",
      auth: {
        mode: "bearer",
        prefix: "Bearer",
        secret: "shared-secret",
      },
      secretInput: "shared-secret",
      secretConfigPath: "plugins.entries.webhooks.routes.jira.auth.secret",
      defaultControllerId: "webhooks/jira",
      event: {},
      idempotency: {
        payloadPath: "webhook.id",
        ttlMs: 60_000,
      },
      prompt: "Investigate {issue.key}: {issue.summary}",
      skills: ["jira-triage"],
      taskflow: {
        goalTemplate: "Ticket {issue.key}",
        currentStep: "queued from Jira",
        status: "queued",
        notifyPolicy: "state_changes",
        runTask: {
          enabled: true,
          runtime: "acp",
          taskTemplate: "Start triage for {issue.key}: {issue.summary}",
          runIdTemplate: "{webhook.id}",
          labelTemplate: "{issue.key}",
          status: "queued",
        },
      },
      taskFlow: runtime.bindSession({
        sessionKey: "agent:main:webhook-taskflow",
      }),
    };
    const handler = createHandlerWithTarget(target);

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
      },
      body: {
        webhook: { id: "evt-taskflow-1" },
        issue: {
          key: "ENG-123",
          summary: "deployment failed",
        },
      },
    });

    expect(res.statusCode).toBe(202);
    const parsed = parseJsonBody(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.action).toBe("taskflow_dispatch");
    expect(parsed.result.flow.goal).toBe(
      "Ticket ENG-123\n\nUse these OpenClaw skills when useful: jira-triage",
    );
    expect(parsed.result.flow.currentStep).toBe("queued from Jira");
    expect(parsed.result.flow.status).toBe("queued");
    expect(parsed.result.flow.notifyPolicy).toBe("state_changes");
    expect(parsed.result.flow.stateJson).toEqual({
      source: "webhooks",
      routeId: "jira",
      idempotencyKey: "evt-taskflow-1",
      payload: {
        webhook: { id: "evt-taskflow-1" },
        issue: {
          key: "ENG-123",
          summary: "deployment failed",
        },
      },
    });
    expect(parsed.result.task.task).toBe(
      "Start triage for ENG-123: deployment failed\n\nUse these OpenClaw skills when useful: jira-triage",
    );
    expect(parsed.result.task.runId).toBe("evt-taskflow-1");
    expect(parsed.result.task.label).toBe("ENG-123");
  });

  it("accepts enterprise app webhook payloads through configured agent routes", async () => {
    type EnterpriseWebhookCase = {
      routeId: string;
      event: string;
      idempotencyKey: string;
      auth:
        | { mode: "bearer" }
        | { mode: "header"; header: string }
        | { mode: "hmac-sha256"; header: string; prefix?: string };
      eventConfig?: WebhookTarget["event"];
      idempotency?: WebhookTarget["idempotency"];
      prompt: string;
      body: Record<string, unknown>;
      expectPrompt: string;
    };

    const cases: EnterpriseWebhookCase[] = [
      {
        routeId: "github_pr_review",
        event: "pull_request_review",
        idempotencyKey: "gh-delivery-1",
        auth: { mode: "hmac-sha256", header: "x-hub-signature-256", prefix: "sha256=" },
        eventConfig: { header: "x-github-event" },
        idempotency: { header: "x-github-delivery", ttlMs: 60_000 },
        prompt: "Review GitHub PR #{pull_request.number}: {pull_request.title}",
        body: { action: "submitted", pull_request: { number: 42, title: "Webhook docs" } },
        expectPrompt: "Review GitHub PR #42: Webhook docs",
      },
      {
        routeId: "gitlab_merge_request",
        event: "Merge Request Hook",
        idempotencyKey: "gl-uuid-1",
        auth: { mode: "header", header: "x-gitlab-token" },
        eventConfig: { header: "x-gitlab-event" },
        idempotency: { header: "x-gitlab-event-uuid", ttlMs: 60_000 },
        prompt: "Review GitLab MR !{object_attributes.iid}: {object_attributes.title}",
        body: { object_attributes: { iid: 7, title: "Add webhook integration" } },
        expectPrompt: "Review GitLab MR !7: Add webhook integration",
      },
      {
        routeId: "jira_issue",
        event: "jira:issue_updated",
        idempotencyKey: "jira-event-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "webhookEvent" },
        idempotency: { payloadPath: "webhookEventId", ttlMs: 60_000 },
        prompt: "Triage Jira {issue.key}: {issue.fields.summary}",
        body: {
          webhookEvent: "jira:issue_updated",
          webhookEventId: "jira-event-1",
          issue: { key: "ENG-9", fields: { summary: "Deploy failed" } },
        },
        expectPrompt: "Triage Jira ENG-9: Deploy failed",
      },
      {
        routeId: "pagerduty_incident",
        event: "incident.triggered",
        idempotencyKey: "pd-event-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "event.event_type" },
        idempotency: { payloadPath: "event.id", ttlMs: 60_000 },
        prompt: "Handle PagerDuty {event.data.id}: {event.data.title}",
        body: {
          event: {
            id: "pd-event-1",
            event_type: "incident.triggered",
            data: { id: "P123", title: "API latency" },
          },
        },
        expectPrompt: "Handle PagerDuty P123: API latency",
      },
      {
        routeId: "sentry_issue",
        event: "issue",
        idempotencyKey: "sentry-event-1",
        auth: { mode: "header", header: "x-openclaw-sentry-token" },
        eventConfig: { header: "x-sentry-hook-resource" },
        idempotency: { payloadPath: "id", ttlMs: 60_000 },
        prompt: "Investigate Sentry {project_slug}: {event.title}",
        body: {
          id: "sentry-event-1",
          project_slug: "api",
          event: { title: "TypeError in checkout" },
        },
        expectPrompt: "Investigate Sentry api: TypeError in checkout",
      },
      {
        routeId: "datadog_monitor",
        event: "query_alert",
        idempotencyKey: "dd-alert-1",
        auth: { mode: "header", header: "x-openclaw-datadog-token" },
        eventConfig: { payloadPath: "alert_type" },
        idempotency: { payloadPath: "id", ttlMs: 60_000 },
        prompt: "Analyze Datadog monitor {id}: {title}",
        body: { id: "dd-alert-1", alert_type: "query_alert", title: "CPU high" },
        expectPrompt: "Analyze Datadog monitor dd-alert-1: CPU high",
      },
      {
        routeId: "stripe_event",
        event: "invoice.payment_failed",
        idempotencyKey: "evt_stripe_1",
        auth: { mode: "header", header: "x-openclaw-stripe-token" },
        eventConfig: { payloadPath: "type" },
        idempotency: { payloadPath: "id", ttlMs: 60_000 },
        prompt: "Follow up Stripe {type} for {data.object.customer}",
        body: {
          id: "evt_stripe_1",
          type: "invoice.payment_failed",
          data: { object: { customer: "cus_123" } },
        },
        expectPrompt: "Follow up Stripe invoice.payment_failed for cus_123",
      },
      {
        routeId: "shopify_order",
        event: "orders/create",
        idempotencyKey: "shopify-order-1",
        auth: { mode: "header", header: "x-openclaw-shopify-token" },
        eventConfig: { header: "x-shopify-topic" },
        idempotency: { header: "x-shopify-webhook-id", ttlMs: 60_000 },
        prompt: "Review Shopify order {id} for {customer.email}",
        body: { id: 1001, customer: { email: "buyer@example.com" } },
        expectPrompt: "Review Shopify order 1001 for buyer@example.com",
      },
      {
        routeId: "hubspot_deal",
        event: "deal.propertyChange",
        idempotencyKey: "hubspot-event-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "subscriptionType" },
        idempotency: { payloadPath: "eventId", ttlMs: 60_000 },
        prompt: "Update HubSpot deal {objectId}: {propertyName}",
        body: {
          eventId: "hubspot-event-1",
          subscriptionType: "deal.propertyChange",
          objectId: "deal-9",
          propertyName: "dealstage",
        },
        expectPrompt: "Update HubSpot deal deal-9: dealstage",
      },
      {
        routeId: "salesforce_change",
        event: "CaseChangeEvent",
        idempotencyKey: "sf-commit-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "ChangeEventHeader.entityName" },
        idempotency: { payloadPath: "ChangeEventHeader.commitNumber", ttlMs: 60_000 },
        prompt: "Review Salesforce {ChangeEventHeader.entityName} {CaseNumber}: {Subject}",
        body: {
          ChangeEventHeader: { entityName: "CaseChangeEvent", commitNumber: "sf-commit-1" },
          CaseNumber: "00042",
          Subject: "Renewal risk",
        },
        expectPrompt: "Review Salesforce CaseChangeEvent 00042: Renewal risk",
      },
      {
        routeId: "servicenow_incident",
        event: "incident.updated",
        idempotencyKey: "snow-event-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "event.name" },
        idempotency: { payloadPath: "sys_id", ttlMs: 60_000 },
        prompt: "Act on ServiceNow {number}: {short_description}",
        body: {
          sys_id: "snow-event-1",
          event: { name: "incident.updated" },
          number: "INC001",
          short_description: "VPN outage",
        },
        expectPrompt: "Act on ServiceNow INC001: VPN outage",
      },
      {
        routeId: "zendesk_ticket",
        event: "ticket.updated",
        idempotencyKey: "zd-ticket-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "type" },
        idempotency: { payloadPath: "id", ttlMs: 60_000 },
        prompt: "Summarize Zendesk ticket {ticket.id}: {ticket.subject}",
        body: {
          id: "zd-ticket-1",
          type: "ticket.updated",
          ticket: { id: 88, subject: "Refund request" },
        },
        expectPrompt: "Summarize Zendesk ticket 88: Refund request",
      },
      {
        routeId: "slack_workflow",
        event: "workflow_step",
        idempotencyKey: "slack-event-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "type" },
        idempotency: { payloadPath: "event_id", ttlMs: 60_000 },
        prompt: "Process Slack workflow {workflow.name} from {user.id}",
        body: {
          event_id: "slack-event-1",
          type: "workflow_step",
          workflow: { name: "Approve deploy" },
          user: { id: "U123" },
        },
        expectPrompt: "Process Slack workflow Approve deploy from U123",
      },
      {
        routeId: "teams_power_automate",
        event: "approval.requested",
        idempotencyKey: "teams-trigger-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "eventType" },
        idempotency: { payloadPath: "triggerId", ttlMs: 60_000 },
        prompt: "Handle Teams approval {approval.id}: {approval.title}",
        body: {
          triggerId: "teams-trigger-1",
          eventType: "approval.requested",
          approval: { id: "APR-1", title: "Vendor spend" },
        },
        expectPrompt: "Handle Teams approval APR-1: Vendor spend",
      },
      {
        routeId: "notion_page",
        event: "page.updated",
        idempotencyKey: "notion-event-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "type" },
        idempotency: { payloadPath: "id", ttlMs: 60_000 },
        prompt: "Review Notion page {entity.id}: {entity.title}",
        body: {
          id: "notion-event-1",
          type: "page.updated",
          entity: { id: "page-1", title: "Launch plan" },
        },
        expectPrompt: "Review Notion page page-1: Launch plan",
      },
      {
        routeId: "airtable_record",
        event: "record.created",
        idempotencyKey: "airtable-webhook-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "action" },
        idempotency: { payloadPath: "webhook.id", ttlMs: 60_000 },
        prompt: "Inspect Airtable {base.id}/{table.id}: {record.id}",
        body: {
          action: "record.created",
          webhook: { id: "airtable-webhook-1" },
          base: { id: "app123" },
          table: { id: "tbl123" },
          record: { id: "rec123" },
        },
        expectPrompt: "Inspect Airtable app123/tbl123: rec123",
      },
      {
        routeId: "google_forms",
        event: "form.submit",
        idempotencyKey: "forms-response-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "eventType" },
        idempotency: { payloadPath: "responseId", ttlMs: 60_000 },
        prompt: "Process Google Forms {formId}: {answers.summary}",
        body: {
          eventType: "form.submit",
          responseId: "forms-response-1",
          formId: "form-9",
          answers: { summary: "Access request" },
        },
        expectPrompt: "Process Google Forms form-9: Access request",
      },
      {
        routeId: "jenkins_build",
        event: "build.completed",
        idempotencyKey: "jenkins-build-1",
        auth: { mode: "header", header: "x-jenkins-token" },
        eventConfig: { payloadPath: "event" },
        idempotency: { payloadPath: "build.id", ttlMs: 60_000 },
        prompt: "Investigate Jenkins {job.name} build {build.number}: {build.status}",
        body: {
          event: "build.completed",
          job: { name: "deploy-prod" },
          build: { id: "jenkins-build-1", number: 321, status: "FAILURE" },
        },
        expectPrompt: "Investigate Jenkins deploy-prod build 321: FAILURE",
      },
      {
        routeId: "argocd_app",
        event: "app.sync.failed",
        idempotencyKey: "argo-app-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "event" },
        idempotency: { payloadPath: "app.metadata.uid", ttlMs: 60_000 },
        prompt: "Repair Argo CD {app.metadata.name}: {app.status.sync.status}",
        body: {
          event: "app.sync.failed",
          app: {
            metadata: { uid: "argo-app-1", name: "payments" },
            status: { sync: { status: "OutOfSync" } },
          },
        },
        expectPrompt: "Repair Argo CD payments: OutOfSync",
      },
      {
        routeId: "alertmanager",
        event: "firing",
        idempotencyKey: "alert-group-1",
        auth: { mode: "bearer" },
        eventConfig: { payloadPath: "status" },
        idempotency: { payloadPath: "groupKey", ttlMs: 60_000 },
        prompt: "Correlate Alertmanager {commonLabels.alertname}: {status}",
        body: {
          status: "firing",
          groupKey: "alert-group-1",
          commonLabels: { alertname: "HighErrorRate" },
        },
        expectPrompt: "Correlate Alertmanager HighErrorRate: firing",
      },
    ];

    expect(cases).toHaveLength(20);

    for (const app of cases) {
      const scheduleSessionTurn = vi.fn(async (params) => ({
        id: `job-${app.routeId}`,
        pluginId: "webhooks",
        sessionKey: params.sessionKey,
        kind: "session-turn",
      }));
      const target: WebhookTarget = {
        routeId: app.routeId,
        path: `/plugins/webhooks/${app.routeId}`,
        dispatchMode: "agent",
        auth:
          app.auth.mode === "bearer"
            ? { mode: "bearer", prefix: "Bearer", secret: "shared-secret" }
            : app.auth.mode === "header"
              ? { mode: "header", header: app.auth.header, secret: "shared-secret" }
              : {
                  mode: "hmac-sha256",
                  header: app.auth.header,
                  prefix: app.auth.prefix,
                  secret: "shared-secret",
                },
        event: app.eventConfig ?? {},
        events: [app.event],
        idempotency: app.idempotency,
        prompt: app.prompt,
        skills: ["enterprise-webhook-triage"],
        sessionKey: "agent:main:main",
        agent: {
          deliveryMode: "none",
          delayMs: 1,
          nameTemplate: `${app.routeId}-{eventType}`,
          tagTemplate: `${app.routeId}-{idempotencyKey}`,
        },
      };
      const handler = createHandlerWithTarget(target, {} as OpenClawConfig, {
        scheduleSessionTurn,
      });

      const headers: Record<string, string> = {};
      if (app.eventConfig?.header) {
        headers[app.eventConfig.header] = app.event;
      }
      if (app.idempotency?.header) {
        headers[app.idempotency.header] = app.idempotencyKey;
      }

      let res;
      if (app.auth.mode === "hmac-sha256") {
        const rawBody = JSON.stringify(app.body);
        const signature = createHmac("sha256", "shared-secret").update(rawBody).digest("hex");
        const req = createRawJsonRequest({
          path: target.path,
          rawBody,
          headers: {
            ...headers,
            [app.auth.header]: `${app.auth.prefix ?? ""}${signature}`,
          },
        });
        res = createMockServerResponse();
        await handler(req, res);
      } else {
        res = await dispatchJsonRequest({
          handler,
          path: target.path,
          headers: {
            ...headers,
            ...(app.auth.mode === "bearer"
              ? { authorization: "Bearer shared-secret" }
              : { [app.auth.header]: "shared-secret" }),
          },
          body: app.body,
        });
      }

      expect(res.statusCode, app.routeId).toBe(202);
      expect(parseJsonBody(res), app.routeId).toEqual({
        ok: true,
        routeId: app.routeId,
        result: {
          action: "agent_dispatch",
          sessionKey: "agent:main:main",
          accepted: true,
          jobId: `job-${app.routeId}`,
        },
      });
      await vi.waitFor(() => expect(scheduleSessionTurn, app.routeId).toHaveBeenCalledTimes(1));
      expect(scheduleSessionTurn, app.routeId).toHaveBeenCalledTimes(1);
      expect(scheduleSessionTurn.mock.calls[0]?.[0], app.routeId).toMatchObject({
        sessionKey: "agent:main:main",
        deliveryMode: "none",
        delayMs: 1,
        deleteAfterRun: true,
        name: `${app.routeId}-${app.event}`,
        tag: `${app.routeId}-${app.idempotencyKey}`,
      });
      expect(scheduleSessionTurn.mock.calls[0]?.[0].message, app.routeId).toContain(
        app.expectPrompt,
      );
      expect(scheduleSessionTurn.mock.calls[0]?.[0].message, app.routeId).toContain(
        "Use these OpenClaw skills when useful: enterprise-webhook-triage",
      );
    }
  });

  it("rejects enterprise HMAC requests before dispatching", async () => {
    const scheduleSessionTurn = vi.fn(async (params) => ({
      id: "job-github",
      pluginId: "webhooks",
      sessionKey: params.sessionKey,
      kind: "session-turn",
    }));
    const target: WebhookTarget = {
      routeId: "github_pr_review",
      path: "/plugins/webhooks/github-pr-review",
      dispatchMode: "agent",
      auth: {
        mode: "hmac-sha256",
        header: "x-hub-signature-256",
        prefix: "sha256=",
        secret: "shared-secret",
      },
      event: { header: "x-github-event" },
      events: ["pull_request_review"],
      idempotency: { header: "x-github-delivery", ttlMs: 60_000 },
      prompt: "Review GitHub PR #{pull_request.number}",
      sessionKey: "agent:main:main",
      agent: { deliveryMode: "none", delayMs: 1 },
    };
    const handler = createHandlerWithTarget(target, {} as OpenClawConfig, {
      scheduleSessionTurn,
    });
    const req = createRawJsonRequest({
      path: target.path,
      rawBody: JSON.stringify({ pull_request: { number: 42 } }),
      headers: {
        "x-github-event": "pull_request_review",
        "x-github-delivery": "gh-delivery-bad",
        "x-hub-signature-256": "sha256=bad",
      },
    });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("skips enterprise events outside the configured allowlist", async () => {
    const scheduleSessionTurn = vi.fn(async (params) => ({
      id: "job-jira",
      pluginId: "webhooks",
      sessionKey: params.sessionKey,
      kind: "session-turn",
    }));
    const target: WebhookTarget = {
      routeId: "jira_issue",
      path: "/plugins/webhooks/jira-issue",
      dispatchMode: "agent",
      auth: { mode: "bearer", prefix: "Bearer", secret: "shared-secret" },
      event: { payloadPath: "webhookEvent" },
      events: ["jira:issue_created", "jira:issue_updated"],
      idempotency: { payloadPath: "webhookEventId", ttlMs: 60_000 },
      prompt: "Triage Jira {issue.key}",
      sessionKey: "agent:main:main",
      agent: { deliveryMode: "none", delayMs: 1 },
    };
    const handler = createHandlerWithTarget(target, {} as OpenClawConfig, {
      scheduleSessionTurn,
    });

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: { authorization: "Bearer shared-secret" },
      body: {
        webhookEvent: "jira:issue_deleted",
        webhookEventId: "jira-event-skipped",
        issue: { key: "ENG-9" },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      ok: true,
      routeId: "jira_issue",
      skipped: true,
      reason: "event_not_allowed",
      eventType: "jira:issue_deleted",
    });
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("deduplicates replayed enterprise deliveries before scheduling again", async () => {
    const scheduleSessionTurn = vi.fn(async (params) => ({
      id: "job-shopify",
      pluginId: "webhooks",
      sessionKey: params.sessionKey,
      kind: "session-turn",
    }));
    const target: WebhookTarget = {
      routeId: "shopify_order",
      path: "/plugins/webhooks/shopify-order",
      dispatchMode: "agent",
      auth: {
        mode: "header",
        header: "x-openclaw-shopify-token",
        secret: "shared-secret",
      },
      event: { header: "x-shopify-topic" },
      events: ["orders/create"],
      idempotency: { header: "x-shopify-webhook-id", ttlMs: 60_000 },
      prompt: "Review Shopify order {id}",
      sessionKey: "agent:main:main",
      agent: { deliveryMode: "none", delayMs: 1 },
    };
    const handler = createHandlerWithTarget(target, {} as OpenClawConfig, {
      scheduleSessionTurn,
    });
    const request = {
      handler,
      path: target.path,
      headers: {
        "x-openclaw-shopify-token": "shared-secret",
        "x-shopify-topic": "orders/create",
        "x-shopify-webhook-id": "shopify-replay-1",
      },
      body: { id: 1001 },
    };

    const first = await dispatchJsonRequest(request);
    const second = await dispatchJsonRequest(request);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(parseJsonBody(second)).toEqual({
      ok: true,
      routeId: "shopify_order",
      duplicate: true,
      idempotencyKey: "shopify-replay-1",
    });
    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps missing enterprise template fields inspectable while preserving raw payload", async () => {
    const scheduleSessionTurn = vi.fn(async (params) => ({
      id: "job-sentry",
      pluginId: "webhooks",
      sessionKey: params.sessionKey,
      kind: "session-turn",
    }));
    const target: WebhookTarget = {
      routeId: "sentry_issue",
      path: "/plugins/webhooks/sentry-issue",
      dispatchMode: "agent",
      auth: {
        mode: "header",
        header: "x-openclaw-sentry-token",
        secret: "shared-secret",
      },
      event: { header: "x-sentry-hook-resource" },
      events: ["issue"],
      idempotency: { payloadPath: "id", ttlMs: 60_000 },
      prompt: "Investigate Sentry {project_slug}: {event.title}\nRaw:\n{__raw__}",
      sessionKey: "agent:main:main",
      agent: { deliveryMode: "none", delayMs: 1 },
    };
    const handler = createHandlerWithTarget(target, {} as OpenClawConfig, {
      scheduleSessionTurn,
    });

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        "x-openclaw-sentry-token": "shared-secret",
        "x-sentry-hook-resource": "issue",
      },
      body: {
        id: "sentry-missing-title",
        project_slug: "api",
        event: {},
      },
    });

    expect(res.statusCode).toBe(202);
    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    const message = scheduleSessionTurn.mock.calls[0]?.[0].message ?? "";
    expect(message).toContain("Investigate Sentry api: {event.title}");
    expect(message).toContain('"id": "sentry-missing-title"');
    expect(message).toContain('"project_slug": "api"');
  });

  it("isolates enterprise routes sharing a path by route-specific auth", async () => {
    const scheduleSessionTurn = vi.fn(async (params) => ({
      id: `job-${params.name}`,
      pluginId: "webhooks",
      sessionKey: params.sessionKey,
      kind: "session-turn",
    }));
    const gitlab: WebhookTarget = {
      routeId: "gitlab_merge_request",
      path: "/plugins/webhooks/source-control",
      dispatchMode: "agent",
      auth: { mode: "header", header: "x-gitlab-token", secret: "gitlab-secret" },
      event: { header: "x-gitlab-event" },
      events: ["Merge Request Hook"],
      prompt: "Review GitLab MR !{object_attributes.iid}",
      sessionKey: "agent:main:main",
      agent: { deliveryMode: "none", delayMs: 1, nameTemplate: "gitlab-{eventType}" },
    };
    const github: WebhookTarget = {
      routeId: "github_pr_review",
      path: "/plugins/webhooks/source-control",
      dispatchMode: "agent",
      auth: { mode: "bearer", prefix: "Bearer", secret: "github-secret" },
      event: { header: "x-github-event" },
      events: ["pull_request"],
      prompt: "Review GitHub PR #{pull_request.number}",
      sessionKey: "agent:main:main",
      agent: { deliveryMode: "none", delayMs: 1, nameTemplate: "github-{eventType}" },
    };
    const handler = createTaskFlowWebhookRequestHandler({
      cfg: {} as OpenClawConfig,
      targetsByPath: new Map([[gitlab.path, [gitlab, github]]]),
      scheduleSessionTurn,
    });

    const res = await dispatchJsonRequest({
      handler,
      path: gitlab.path,
      headers: {
        authorization: "Bearer github-secret",
        "x-github-event": "pull_request",
      },
      body: {
        pull_request: { number: 42 },
      },
    });

    expect(res.statusCode).toBe(202);
    expect(parseJsonBody(res).routeId).toBe("github_pr_review");
    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    expect(scheduleSessionTurn.mock.calls[0]?.[0].name).toBe("github-pull_request");
    expect(scheduleSessionTurn.mock.calls[0]?.[0].message).toContain("Review GitHub PR #42");
    expect(scheduleSessionTurn.mock.calls[0]?.[0].message).not.toContain("GitLab");
  });

  it("uses the durable idempotency store before dispatching side effects", async () => {
    const registerIfAbsent = vi.fn(async () => false);
    const scheduleSessionTurn = vi.fn(async (params) => ({
      id: "job-duplicate",
      pluginId: "webhooks",
      sessionKey: params.sessionKey,
      kind: "session-turn",
    }));
    const target: WebhookTarget = {
      routeId: "incidents",
      path: "/plugins/webhooks/incidents",
      dispatchMode: "agent",
      auth: {
        mode: "bearer",
        prefix: "Bearer",
        secret: "shared-secret",
      },
      event: {},
      idempotency: {
        payloadPath: "delivery.id",
        ttlMs: 60_000,
      },
      sessionKey: "agent:main:main",
      agent: {
        deliveryMode: "announce",
        delayMs: 1,
      },
    };
    const handler = createHandlerWithTarget(target, {} as OpenClawConfig, {
      idempotencyStore: { registerIfAbsent },
      scheduleSessionTurn,
    });

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
      },
      body: {
        delivery: { id: "evt-duplicate" },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      ok: true,
      routeId: "incidents",
      duplicate: true,
      idempotencyKey: "evt-duplicate",
    });
    expect(registerIfAbsent).toHaveBeenCalledWith(
      "incidents:evt-duplicate",
      {
        routeId: "incidents",
        idempotencyKey: "evt-duplicate",
        firstSeenAt: expect.any(Number),
      },
      { ttlMs: 60_000 },
    );
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("falls back to in-memory idempotency when the persistent store errors", async () => {
    let fail = true;
    const registerIfAbsent = vi.fn(async () => {
      if (fail) {
        fail = false;
        throw new Error("store unavailable");
      }
      return true;
    });
    const scheduleSessionTurn = vi.fn(async (params) => ({
      id: "job-live",
      pluginId: "webhooks",
      sessionKey: params.sessionKey,
      kind: "session-turn",
    }));
    const target: WebhookTarget = {
      routeId: "incidents",
      path: "/plugins/webhooks/incidents",
      dispatchMode: "agent",
      auth: {
        mode: "bearer",
        prefix: "Bearer",
        secret: "shared-secret",
      },
      event: {},
      idempotency: {
        payloadPath: "delivery.id",
        ttlMs: 60_000,
      },
      sessionKey: "agent:main:main",
      agent: {
        deliveryMode: "announce",
        delayMs: 1,
      },
    };
    const handler = createHandlerWithTarget(target, {} as OpenClawConfig, {
      idempotencyStore: { registerIfAbsent },
      scheduleSessionTurn,
    });
    const body = { delivery: { id: "evt-fallback-1" } };

    const first = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
      },
      body,
    });
    const second = await dispatchJsonRequest({
      handler,
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
      },
      body,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(parseJsonBody(second)).toEqual({
      ok: true,
      routeId: "incidents",
      duplicate: true,
      idempotencyKey: "evt-fallback-1",
    });
    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    expect(registerIfAbsent).toHaveBeenCalledTimes(1);
  });
});
