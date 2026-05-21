import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
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
    const goodSignature = createHmac("sha256", "signing-secret")
      .update(rawBody)
      .digest("hex");

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
        jobId: "job-1",
      },
    });
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
