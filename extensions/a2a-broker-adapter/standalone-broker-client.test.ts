import { afterEach, describe, expect, it, vi } from "vitest";
import {
  A2ABrokerMalformedResponseError,
  buildBrokerCreateTaskRequestFromOpenClaw,
  createA2ABrokerClient,
  type A2ABrokerTaskRecord,
} from "./standalone-broker-client.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createTaskRecord(taskId: string): A2ABrokerTaskRecord {
  return {
    id: taskId,
    intent: "chat",
    requester: {
      id: "hub-a",
      kind: "service",
      role: "hub",
    },
    target: {
      id: "worker-a",
      kind: "node",
    },
    targetNodeId: "worker-a",
    status: "queued",
    message: "Investigate the latest failure",
    payload: {
      targetSessionKey: "agent:worker:main",
    },
    createdAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:00.000Z",
  };
}

describe("plugin-local buildBrokerCreateTaskRequestFromOpenClaw", () => {
  it("maps the current OpenClaw delegation request onto the broker /tasks contract", () => {
    expect(
      buildBrokerCreateTaskRequestFromOpenClaw({
        taskId: "task-a2a-1",
        waitRunId: "run-a2a-1",
        correlationId: "corr-a2a-1",
        parentRunId: "parent-a2a-1",
        requesterSessionKey: "agent:main:discord:group:req",
        requesterChannel: "discord",
        targetNodeId: "worker-a",
        targetSessionKey: "agent:worker:main",
        targetDisplayKey: "agent:worker:main",
        originalMessage: "Investigate the latest failure",
        roundOneReply: "Initial worker reply",
        announceTimeoutMs: 15_000,
        maxPingPongTurns: 2,
        cancelTarget: {
          kind: "session_run",
          sessionKey: "agent:worker:main",
          runId: "remote-run-1",
        },
      }),
    ).toEqual({
      id: "task-a2a-1",
      intent: "chat",
      requester: {
        id: "agent:main:discord:group:req",
        kind: "session",
        role: "hub",
      },
      target: {
        id: "worker-a",
        kind: "node",
      },
      assignedWorkerId: "worker-a",
      message: "Investigate the latest failure",
      via: {
        transport: "openclaw",
        channel: "discord",
        sessionId: "agent:main:discord:group:req",
        traceId: "corr-a2a-1",
      },
      payload: {
        taskId: "task-a2a-1",
        targetSessionKey: "agent:worker:main",
        targetDisplayKey: "agent:worker:main",
        announceTimeoutMs: 15_000,
        maxPingPongTurns: 2,
        requesterSessionKey: "agent:main:discord:group:req",
        requesterChannel: "discord",
        roundOneReply: "Initial worker reply",
        waitRunId: "run-a2a-1",
        correlationId: "corr-a2a-1",
        parentRunId: "parent-a2a-1",
        cancelTarget: {
          kind: "session_run",
          sessionKey: "agent:worker:main",
          runId: "remote-run-1",
        },
      },
    });
  });
});

describe("plugin-local createA2ABrokerClient", () => {
  it("posts broker task requests with requester and edge-secret headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(createTaskRecord("task-1")), {
        status: 201,
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    const client = createA2ABrokerClient({
      baseUrl: " https://broker.example.com/adapter/ ",
      edgeSecret: "edge-secret",
      requester: {
        id: "hub-a",
        kind: "service",
        role: "hub",
      },
      fetchImpl,
    });

    const record = await client.createTask({
      intent: "chat",
      requester: {
        id: "hub-a",
        kind: "service",
        role: "hub",
      },
      target: {
        id: "worker-a",
        kind: "node",
      },
      message: "Investigate the latest failure",
      payload: {
        targetSessionKey: "agent:worker:main",
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://broker.example.com/adapter/tasks",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-a2a-edge-secret")).toBe("edge-secret");
    expect(headers.get("x-a2a-requester-id")).toBe("hub-a");
    expect(headers.get("x-a2a-requester-kind")).toBe("service");
    expect(headers.get("x-a2a-requester-role")).toBe("hub");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      intent: "chat",
      target: {
        id: "worker-a",
      },
      payload: {
        targetSessionKey: "agent:worker:main",
      },
    });
    expect(record.id).toBe("task-1");
  });

  it("cancels broker tasks with the configured requester actor", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...createTaskRecord("task-cancel-1"),
          status: "canceled",
          completedAt: "2026-04-14T00:05:00.000Z",
          updatedAt: "2026-04-14T00:05:00.000Z",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );
    const client = createA2ABrokerClient({
      baseUrl: "https://broker.example.com",
      requester: {
        id: "hub-a",
        kind: "service",
        role: "hub",
      },
      fetchImpl,
    });

    const record = await client.cancelTask("task-cancel-1", {
      reason: "No longer needed",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://broker.example.com/tasks/task-cancel-1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("x-a2a-requester-id")).toBe("hub-a");
    expect(JSON.parse(String(init?.body))).toEqual({
      actor: {
        id: "hub-a",
        kind: "service",
        role: "hub",
      },
      reason: "No longer needed",
    });
    expect(record.status).toBe("canceled");
  });

  it("throws a malformed-response error when an ok response body is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    const client = createA2ABrokerClient({
      baseUrl: "https://broker.example.com",
      fetchImpl,
    });

    await expect(client.health()).rejects.toBeInstanceOf(A2ABrokerMalformedResponseError);
  });

  it("throws a malformed-response error even when an error response body is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("gateway exploded", {
        status: 502,
        headers: {
          "content-type": "text/plain",
        },
      }),
    );
    const client = createA2ABrokerClient({
      baseUrl: "https://broker.example.com",
      fetchImpl,
    });

    await expect(client.getTask("task-1")).rejects.toBeInstanceOf(A2ABrokerMalformedResponseError);
  });
});
