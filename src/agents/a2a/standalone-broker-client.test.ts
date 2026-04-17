import {
  A2ABrokerClientError,
  A2ABrokerMalformedResponseError,
  buildBrokerCreateTaskRequestFromOpenClaw,
  createA2ABrokerClient,
  parseA2ABrokerTaskSseFrames,
  type A2ABrokerSseChunk,
  type A2ABrokerTaskRecord,
  type A2ABrokerTaskSseEvent,
} from "openclaw/plugin-sdk/a2a-broker-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("buildBrokerCreateTaskRequestFromOpenClaw", () => {
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

describe("createA2ABrokerClient", () => {
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

function buildBrokerProjection(
  taskId: string,
  internalStatus: A2ABrokerTaskRecord["status"],
  overrides: Partial<{
    state: string;
    timestamp: string;
    summary: string;
  }> = {},
) {
  const stateMap: Record<A2ABrokerTaskRecord["status"], string> = {
    queued: "submitted",
    claimed: "working",
    running: "working",
    succeeded: "completed",
    failed: "failed",
    canceled: "canceled",
  };
  return {
    id: taskId,
    kind: "task" as const,
    status: {
      state: overrides.state ?? stateMap[internalStatus],
      timestamp: overrides.timestamp ?? "2026-04-15T00:00:00.000Z",
      ...(overrides.summary
        ? {
            message: {
              role: "agent" as const,
              parts: [{ text: overrides.summary }],
            },
          }
        : {}),
    },
    metadata: {
      internalStatus,
      intent: "chat",
      requester: { id: "hub-a", kind: "service", role: "hub" },
      target: { id: "worker-a", kind: "node" },
      targetNodeId: "worker-a",
      assignedWorkerId: "worker-a",
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: overrides.timestamp ?? "2026-04-15T00:00:00.000Z",
    },
    artifacts: [],
  };
}

function buildSseFramesPayload(
  events: Array<{
    name: "task-snapshot" | "task-status-update";
    id?: string;
    data: unknown;
  }>,
): string {
  return events
    .map((event) => {
      const lines: string[] = [];
      if (event.id) {
        lines.push(`id: ${event.id}`);
      }
      lines.push(`event: ${event.name}`);
      lines.push(`data: ${JSON.stringify(event.data)}`);
      return `${lines.join("\n")}\n\n`;
    })
    .join("");
}

function buildResponseWithStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function* iterChunks(chunks: A2ABrokerSseChunk[]): AsyncIterable<A2ABrokerSseChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("parseA2ABrokerTaskSseFrames", () => {
  it("parses event frames split across chunk boundaries and skips heartbeat comments", async () => {
    const payload = `id: 2026-04-15T00:00:00.000Z\nevent: task-snapshot\ndata: {"task":"a"}\n\n: heartbeat 2026-04-15T00:00:01.000Z\n\nevent: task-status-update\ndata: {"task":"b"}\n\n`;
    // Split mid-frame to exercise buffering.
    const splitAt = payload.indexOf("data:") + 8;
    const chunks = [payload.slice(0, splitAt), payload.slice(splitAt)];

    const frames: Array<{ id?: string; event?: string; data: string }> = [];
    for await (const frame of parseA2ABrokerTaskSseFrames(iterChunks(chunks))) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      {
        id: "2026-04-15T00:00:00.000Z",
        event: "task-snapshot",
        data: '{"task":"a"}',
      },
      {
        event: "task-status-update",
        data: '{"task":"b"}',
      },
    ]);
  });

  it("joins multi-line data fields with newlines", async () => {
    const payload = `event: task-snapshot\ndata: line one\ndata: line two\n\n`;
    const frames: Array<{ event?: string; data: string }> = [];
    for await (const frame of parseA2ABrokerTaskSseFrames(iterChunks([payload]))) {
      frames.push(frame);
    }
    expect(frames).toEqual([
      {
        event: "task-snapshot",
        data: "line one\nline two",
      },
    ]);
  });
});

describe("createA2ABrokerClient.streamTaskEvents", () => {
  it("yields parsed snapshot and status-update events and stops on the final flag", async () => {
    const sseBody = buildSseFramesPayload([
      {
        name: "task-snapshot",
        id: "2026-04-15T00:00:00.000Z",
        data: {
          task: buildBrokerProjection("task-stream-1", "queued"),
          reason: "snapshot",
          final: false,
        },
      },
      {
        name: "task-status-update",
        id: "2026-04-15T00:00:05.000Z",
        data: {
          task: buildBrokerProjection("task-stream-1", "running", {
            timestamp: "2026-04-15T00:00:05.000Z",
          }),
          reason: "started",
          final: false,
        },
      },
      {
        name: "task-status-update",
        id: "2026-04-15T00:00:10.000Z",
        data: {
          task: buildBrokerProjection("task-stream-1", "succeeded", {
            timestamp: "2026-04-15T00:00:10.000Z",
            summary: "all done",
          }),
          reason: "succeeded",
          final: true,
        },
      },
    ]);

    // Split the body across chunk boundaries to exercise the parser.
    const split = Math.floor(sseBody.length / 2);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(buildResponseWithStream([sseBody.slice(0, split), sseBody.slice(split)]));

    const client = createA2ABrokerClient({
      baseUrl: "https://broker.example.com",
      requester: { id: "hub-a", kind: "service", role: "hub" },
      fetchImpl,
    });

    const events: A2ABrokerTaskSseEvent[] = [];
    for await (const event of client.streamTaskEvents("task-stream-1")) {
      events.push(event);
    }

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://broker.example.com/a2a/tasks/task-stream-1/events",
      expect.objectContaining({ method: "GET" }),
    );
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("x-a2a-requester-id")).toBe("hub-a");

    expect(events).toHaveLength(3);
    expect(events[0]?.name).toBe("task-snapshot");
    expect(events[0]?.data.reason).toBe("snapshot");
    expect(events[1]?.data.reason).toBe("started");
    expect(events[2]?.data.final).toBe(true);
    expect(events[2]?.data.task.metadata.internalStatus).toBe("succeeded");
  });

  it("ends cleanly when the broker closes the stream without a final event", async () => {
    const sseBody = buildSseFramesPayload([
      {
        name: "task-snapshot",
        id: "2026-04-15T00:00:00.000Z",
        data: {
          task: buildBrokerProjection("task-stream-end-1", "running"),
          reason: "snapshot",
          final: false,
        },
      },
    ]);
    const fetchImpl = vi.fn().mockResolvedValue(buildResponseWithStream([sseBody]));
    const client = createA2ABrokerClient({
      baseUrl: "https://broker.example.com",
      fetchImpl,
    });

    const stream = client.streamTaskEvents("task-stream-end-1");
    const first = await stream.next();
    const second = await stream.next();

    expect(first.value?.name).toBe("task-snapshot");
    expect(first.done).toBe(false);
    expect(second).toEqual({ done: true, value: undefined });
  });

  it("ends cleanly when aborting after the response body starts streaming", async () => {
    const encoder = new TextEncoder();
    const sseBody = buildSseFramesPayload([
      {
        name: "task-snapshot",
        id: "2026-04-15T00:00:00.000Z",
        data: {
          task: buildBrokerProjection("task-stream-abort-1", "running"),
          reason: "snapshot",
          final: false,
        },
      },
    ]);
    let cancelCount = 0;
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sseBody));
          },
          cancel() {
            cancelCount += 1;
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    );
    const client = createA2ABrokerClient({
      baseUrl: "https://broker.example.com",
      fetchImpl,
    });
    const controller = new AbortController();
    const stream = client.streamTaskEvents("task-stream-abort-1", { signal: controller.signal });

    const first = await stream.next();
    const second = stream.next();
    controller.abort();

    await expect(second).resolves.toEqual({ done: true, value: undefined });
    expect(first.value?.name).toBe("task-snapshot");
    expect(cancelCount).toBe(1);
  });

  it("throws a broker client error on a non-2xx SSE response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "not_found", message: "missing" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createA2ABrokerClient({
      baseUrl: "https://broker.example.com",
      fetchImpl,
    });

    const stream = client.streamTaskEvents("task-missing");
    await expect(stream.next()).rejects.toBeInstanceOf(A2ABrokerClientError);
  });

  it("throws a malformed-response error when an SSE frame contains invalid JSON", async () => {
    const sseBody = `event: task-snapshot\ndata: {not-json}\n\n`;
    const fetchImpl = vi.fn().mockResolvedValue(buildResponseWithStream([sseBody]));
    const client = createA2ABrokerClient({
      baseUrl: "https://broker.example.com",
      fetchImpl,
    });

    const stream = client.streamTaskEvents("task-bad");
    await expect(stream.next()).rejects.toBeInstanceOf(A2ABrokerMalformedResponseError);
  });

  it("forwards the abort signal to fetch", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url, init: RequestInit | undefined) => {
      // Simulate fetch rejecting when the signal aborts.
      const signal = init?.signal;
      if (signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const abortError = new Error("aborted");
              abortError.name = "AbortError";
              reject(abortError);
            },
            { once: true },
          );
        });
      }
      return Promise.resolve(buildResponseWithStream([]));
    });
    const client = createA2ABrokerClient({
      baseUrl: "https://broker.example.com",
      fetchImpl,
    });
    const controller = new AbortController();
    const stream = client.streamTaskEvents("task-abort", { signal: controller.signal });
    const next = stream.next();
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    // Confirm the signal was actually wired through to fetch.
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
