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
): ReturnType<typeof createTaskFlowWebhookRequestHandler> {
  const targetsByPath = new Map<string, WebhookTarget[]>([[target.path, [target]]]);
  return createTaskFlowWebhookRequestHandler({
    cfg,
    targetsByPath,
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
});
