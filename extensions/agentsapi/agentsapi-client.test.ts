import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentsApiClient,
  type AgentsApiArtifact,
  type AgentsApiInputFile,
} from "./agentsapi-client.js";
import { createTurn } from "./agentsapi.test-support.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  fetchWithSsrFGuardMock.mockReset();
});

const signal = new AbortController().signal;

describe("Agents API self-hosted session connection", () => {
  it("retains self-hosted metadata while waiting for the matching external executor", async () => {
    const environment = {
      type: "self_hosted",
      id: "environment-fixture",
      workspace_directory: "/fixture/workspace",
      remote_url: "wss://executor.invalid/session-fixture",
    };
    fetchWithSsrFGuardMock.mockImplementation(async () => ({
      response: Response.json({
        id: "session-fixture",
        status: "requires_action",
        error: null,
        environment,
        required_actions: [
          { type: "environment_connection", environment_id: "environment-fixture" },
          {
            type: "function_call",
            turn_id: "turn-fixture",
            call_id: "call-fixture",
            name: "fixture_tool",
            arguments: {},
          },
        ],
      }),
      finalUrl: "https://api.openai.com/v1/agents/sessions/session-fixture",
      release: async () => {},
    }));
    const client = new AgentsApiClient("fixture-not-a-real-api-key", vi.fn());
    expect((await client.session("session-fixture", signal)).environment).toEqual(environment);
    expect(await client.pendingFunctionCalls("session-fixture", signal)).toEqual([
      {
        type: "function_call",
        turn_id: "turn-fixture",
        call_id: "call-fixture",
        name: "fixture_tool",
        arguments: {},
      },
    ]);
  });

  it.each([
    { type: "openai_hosted", requestedId: "environment-fixture" },
    { type: "self_hosted", requestedId: "foreign-environment" },
  ])(
    "rejects unsupported connection actions for $type/$requestedId",
    async ({ type, requestedId }) => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: Response.json({
          id: "session-fixture",
          status: "requires_action",
          error: null,
          environment: {
            type,
            id: "environment-fixture",
            workspace_directory: "/fixture/workspace",
            remote_url: "wss://executor.invalid/session-fixture",
          },
          required_actions: [{ type: "environment_connection", environment_id: requestedId }],
        }),
        finalUrl: "https://api.openai.com/v1/agents/sessions/session-fixture",
        release: async () => {},
      });
      const client = new AgentsApiClient("fixture-not-a-real-api-key", vi.fn());
      await expect(client.pendingFunctionCalls("session-fixture", signal)).rejects.toThrow(
        "cannot reconnect an environment_connection",
      );
    },
  );
});

describe("Agents API session creation", () => {
  it("keeps Gateway functions and MCP tools when native search is disabled", async () => {
    queueResponse(Response.json({ id: "session-fixture" }));
    const client = new AgentsApiClient("fixture-not-a-real-api-key", vi.fn());
    const gatewayFunction = {
      type: "function" as const,
      name: "message",
      description: "Send a fixture message",
      parameters: {},
    };
    const mcpTool = {
      type: "mcp" as const,
      server_label: "fixture",
      transport: { type: "http" as const, server_url: "https://mcp.example.test" },
    };

    await client.create(signal, "Fixture instructions", "fixture-model", {
      nativeTools: [],
      functions: [gatewayFunction],
      mcpTools: [mcpTool],
    });

    const body: unknown = await requestAt(0).json();
    expect(body).toHaveProperty("agent.tools", [mcpTool, gatewayFunction]);
  });

  it("sends the selected model and OpenClaw attribution to the backend", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.9.1");
    vi.stubEnv(
      "OPENAI_CUSTOM_HEADERS",
      "User-Agent: fixture-client/1.0\nX-Attribution-Fixture: preserved",
    );
    const model = "future-model";
    queueResponse(Response.json({ id: "session-fixture" }));
    const client = new AgentsApiClient("fixture-not-a-real-api-key", vi.fn());

    await expect(client.create(signal, "Fixture instructions", model)).resolves.toBe(
      "session-fixture",
    );

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    const request = requestAt(0);
    const body: unknown = await request.json();
    expect(request.method).toBe("POST");
    expect(request.headers.get("user-agent")).toBe("openclaw/2026.9.1");
    expect(request.headers.get("originator")).toBe("openclaw");
    expect(request.headers.get("version")).toBe("2026.9.1");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-not-a-real-api-key");
    expect(request.headers.get("x-stainless-lang")).toBe("js");
    expect(request.headers.get("x-attribution-fixture")).toBe("preserved");
    expect(body).toMatchObject({
      agent: { model },
    });
  });
});

describe("Agents API event submission retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("retries a tool result with the same payload and key, then gives a new submission its own key", async () => {
    queueResponse(serverError(500));
    queueResponse(serverError(503));
    queueResponse(new Response(null, { status: 202 }));
    const client = createClient();
    const submit = () =>
      client.toolResult(
        "session-fixture",
        {
          type: "function_call",
          turn_id: "turn-fixture",
          call_id: "call-fixture",
          name: "lookup",
          arguments: {},
        },
        { success: true, output: "Saved result" },
        signal,
      );
    const result = expect(submit()).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await result;

    const attempts = requests();
    expect(attempts).toHaveLength(3);
    const key = attempts[0]!.headers.get("Idempotency-Key");
    expect(key).toEqual(expect.any(String));
    expect(key).not.toBe("");
    expect(attempts.map((request) => request.headers.get("Idempotency-Key"))).toEqual([
      key,
      key,
      key,
    ]);
    const bodies = await Promise.all(attempts.map((request) => request.text()));
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);

    queueResponse(new Response(null, { status: 202 }));
    await submit();
    expect(requests().at(-1)!.headers.get("Idempotency-Key")).not.toBe(key);
  });

  it("stops after three server failures and preserves the last API error", async () => {
    for (const status of [500, 502, 504]) {
      queueResponse(serverError(status));
    }
    const result = expect(
      createClient().message("session-fixture", "Hello", signal),
    ).rejects.toMatchObject({ status: 504, message: expect.stringContaining("Failure 504") });
    await vi.runAllTimersAsync();
    await result;
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
  });

  it("returns HTTP 429 without retrying the submission", async () => {
    queueResponse(serverError(429));
    await expect(createClient().message("session-fixture", "Hello", signal)).rejects.toMatchObject({
      status: 429,
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it("honors the server's explicit instruction not to retry", async () => {
    queueResponse(serverError(500, { "x-should-retry": "false" }));
    await expect(createClient().message("session-fixture", "Hello", signal)).rejects.toMatchObject({
      status: 500,
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "revoked ownership"])(
    "does not resend after %s during backoff",
    async (interruption) => {
      queueResponse(serverError(500));
      const controller = new AbortController();
      let current = true;
      const client = createClient(() => {
        if (!current) {
          throw new Error("Session ownership revoked");
        }
      });
      const result = expect(
        client.message("session-fixture", "Hello", controller.signal),
      ).rejects.toThrow(interruption === "abort" ? "aborted" : "Session ownership revoked");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
      if (interruption === "abort") {
        controller.abort();
      } else {
        current = false;
      }
      await vi.runAllTimersAsync();
      await result;
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    },
  );
});

const dormantUploadMessage =
  "the hosted environment is dormant; submit new input to start a fresh sandbox";

describe("Agents API file upload transport", () => {
  it.each([
    {
      name: "another disconnected environment",
      patch: { id: "environment-other", status: "disconnected" },
    },
    { name: "a pending environment", patch: { status: "pending" } },
  ])("refuses an upload to $name", async ({ patch }) => {
    queueUploadContext(patch);

    await expect(createClient().uploadFile("session-fixture", inputFile, signal)).rejects.toThrow(
      "requires the session's connected hosted environment",
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect([requestAt(0).method, requestAt(1).method]).toEqual(["GET", "GET"]);
  });

  it("reports unavailable when a connected environment becomes dormant before upload", async () => {
    queueUploadContext();
    queueResponse(
      Response.json(
        { error: { type: "conflict_error", message: dormantUploadMessage } },
        { status: 409 },
      ),
    );

    await expect(createClient().uploadFile("session-fixture", inputFile, signal)).resolves.toEqual({
      status: "unavailable",
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
    expect(requestAt(2).method).toBe("POST");
    expect(new URL(requestAt(2).url).pathname).toBe(
      "/v1/agents/environments/environment-fixture/files",
    );
  });

  it.each([
    { name: "different conflict", status: 409, type: "conflict_error", message: "Upload is busy" },
    {
      name: "wrong error type",
      status: 409,
      type: "invalid_request_error",
      message: dormantUploadMessage,
    },
    {
      name: "permission failure",
      status: 403,
      type: "conflict_error",
      message: dormantUploadMessage,
    },
    { name: "server failure", status: 500, type: "conflict_error", message: dormantUploadMessage },
    {
      name: "malformed error",
      status: 409,
      type: "conflict_error",
      message: [dormantUploadMessage],
    },
  ])("preserves an upload $name", async ({ status, type, message }) => {
    queueUploadContext();
    queueResponse(Response.json({ error: { type, message } }, { status }));

    await expect(
      createClient().uploadFile("session-fixture", inputFile, signal),
    ).rejects.toMatchObject({ status, type, error: { type, message } });
  });

  it("preserves the dormant conflict when it comes from session lookup", async () => {
    queueResponse(
      Response.json(
        { error: { type: "conflict_error", message: dormantUploadMessage } },
        { status: 409 },
      ),
    );

    await expect(
      createClient().uploadFile("session-fixture", inputFile, signal),
    ).rejects.toMatchObject({ status: 409, type: "conflict_error" });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a transport failure instead of accepting its dormant error wording", async () => {
    queueUploadContext();
    const failure = new Error(dormantUploadMessage);
    fetchWithSsrFGuardMock.mockRejectedValueOnce(failure);

    await expect(
      createClient().uploadFile("session-fixture", inputFile, signal),
    ).rejects.toMatchObject({ cause: failure });
  });

  it.each(["abort", "authority revocation"])(
    "rejects a dormant upload result after %s during response consumption",
    async (interruption) => {
      queueUploadContext();
      const controller = new AbortController();
      const interrupted = new Error("File upload authority ended");
      let current = true;
      const release = queueResponse(
        Response.json(
          { error: { type: "conflict_error", message: dormantUploadMessage } },
          { status: 409 },
        ),
      );
      release.mockImplementation(async () => {
        if (interruption === "abort") {
          controller.abort(interrupted);
        } else {
          current = false;
        }
      });
      const client = createClient(() => {
        if (!current) {
          throw interrupted;
        }
      });

      await expect(
        client.uploadFile("session-fixture", inputFile, controller.signal),
      ).rejects.toThrow(interrupted.message);
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { name: "environment", patch: { environment_id: "environment-other" } },
    { name: "path", patch: { path: "/workspace/inputs/other.bin" } },
    { name: "decoded byte count", patch: { size_bytes: 5 } },
  ])("rejects an upload receipt with a different $name", async ({ patch }) => {
    queueUploadContext();
    queueResponse(Response.json({ ...uploadReceipt, ...patch }));

    await expect(createClient().uploadFile("session-fixture", inputFile, signal)).rejects.toThrow(
      "did not match the requested environment, path, or size",
    );
  });
});

describe("Agents API immutable artifact metadata", () => {
  it("paginates using the complete page while returning only the requested turn's artifacts", async () => {
    const first = artifact({ id: "artifact-first" });
    const previousTurn = artifact({ id: "artifact-previous", turn_id: "turn-previous" });
    const last = artifact({ id: "artifact-last" });
    queueResponse(Response.json({ data: [first, previousTurn], has_more: true }));
    queueResponse(Response.json({ data: [last], has_more: false }));

    await expect(
      createClient().artifacts("session-fixture", "turn-fixture", signal),
    ).resolves.toEqual([first, last]);

    const initial = new URL(requestAt(0).url);
    expect(initial.pathname).toBe("/v1/agents/sessions/session-fixture/artifacts");
    expect(Object.fromEntries(initial.searchParams)).toEqual({ order: "asc", limit: "100" });
    expect(new URL(requestAt(1).url).searchParams.get("after")).toBe("artifact-previous");
  });

  it("rejects a foreign session artifact even when it belongs to a different turn", async () => {
    queueResponse(
      Response.json({
        data: [artifact({ session_id: "session-other", turn_id: "turn-previous" })],
        has_more: false,
      }),
    );

    await expect(
      createClient().artifacts("session-fixture", "turn-fixture", signal),
    ).rejects.toThrow("artifact outside the requested session");
  });

  it.each(["empty", "repeated"])("stops a %s continuation page", async (kind) => {
    if (kind === "repeated") {
      queueResponse(Response.json({ data: [artifact()], has_more: true }));
    }
    queueResponse(Response.json({ data: kind === "empty" ? [] : [artifact()], has_more: true }));

    await expect(
      createClient().artifacts("session-fixture", "turn-fixture", signal),
    ).rejects.toThrow("no valid continuation cursor");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(kind === "empty" ? 1 : 2);
  });

  it.each([
    { name: "different turn", patch: { id: "turn-other" } },
    { name: "different session", patch: { session_id: "session-other" } },
    { name: "subagent turn", patch: { subagent_id: "subagent-fixture" } },
  ])("rejects a $name before accepting its output metadata", async ({ patch }) => {
    const savedTurn = createTurn(patch);
    queueResponse(Response.json(savedTurn));
    const result = createClient().turn("session-fixture", "turn-fixture", signal);

    await expect(result).rejects.toThrow("turn outside the requested root session");
  });
});

describe("Agents API immutable artifact download", () => {
  it.each([
    { name: "truncated", bytes: [0, 255], message: "did not match its immutable size" },
    { name: "oversized", bytes: [0, 255, 128, 65, 9], message: "exceeded its immutable size" },
  ])("rejects $name content and releases the response", async ({ bytes, message }) => {
    const release = queueResponse(new Response(Uint8Array.from(bytes)));

    await expect(
      createClient().artifactContent("session-fixture", artifact(), 4, signal),
    ).rejects.toThrow(message);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "foreign session", metadata: { session_id: "session-other" }, limit: 4 },
    { name: "oversized metadata", metadata: { size_bytes: 5 }, limit: 4 },
    { name: "invalid byte budget", metadata: {}, limit: -1 },
  ])("rejects $name before opening a download", async ({ metadata, limit }) => {
    await expect(
      createClient().artifactContent("session-fixture", artifact(metadata), limit, signal),
    ).rejects.toThrow("exceeds its session or byte bounds");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each(["abort", "authority revocation"])(
    "cancels an unfinished content body after %s and releases its request",
    async (interruption) => {
      const controller = new AbortController();
      const contentRequested = deferred<void>();
      const cancel = vi.fn();
      let content!: ReadableStreamDefaultController<Uint8Array>;
      let current = true;
      const revoked = new Error("Native session authority revoked");
      const aborted = new Error("File download interrupted");
      let reads = 0;
      const release = queueResponse(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              start(streamController) {
                content = streamController;
              },
              pull(streamController) {
                if (reads++ === 0) {
                  streamController.enqueue(Uint8Array.from([0]));
                } else {
                  contentRequested.resolve();
                }
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
        ),
      );
      const client = createClient(() => {
        if (!current) {
          throw revoked;
        }
      });
      const result = client.artifactContent("session-fixture", artifact(), 4, controller.signal);
      const rejection = expect(result).rejects.toThrow(
        interruption === "abort" ? aborted.message : revoked.message,
      );
      await contentRequested.promise;
      if (interruption === "abort") {
        controller.abort(aborted);
      } else {
        current = false;
      }
      content.enqueue(Uint8Array.from([255]));

      await rejection;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    },
  );
});

const inputFile: AgentsApiInputFile = {
  type: "inline",
  path: "/workspace/inputs/fixture.bin",
  data: "AP+AQQ==",
};

const uploadReceipt = {
  environment_id: "environment-fixture",
  object: "agent.environment.file",
  path: "/workspace/inputs/fixture.bin",
  size_bytes: 4,
};

function createClient(assertCurrent: () => void = () => {}) {
  return new AgentsApiClient("fixture-not-a-real-api-key", assertCurrent);
}

function queueResponse(response: Response) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockImplementationOnce(async (request) => {
    request.beforeRequest?.();
    return { response, finalUrl: request.url, release };
  });
  return release;
}

function queueUploadContext(environment: { id?: string; status?: string } = {}) {
  queueResponse(
    Response.json({
      id: "session-fixture",
      environment: { type: "openai_hosted", id: "environment-fixture" },
    }),
  );
  queueResponse(
    Response.json({
      id: "environment-fixture",
      type: "openai_hosted",
      status: "connected",
      ...environment,
    }),
  );
}

function requestAt(index: number) {
  const call = fetchWithSsrFGuardMock.mock.calls[index]?.[0];
  if (!call) {
    throw new Error(`Expected guarded request ${index}`);
  }
  return new Request(call.url, call.init);
}

function artifact(overrides: Partial<AgentsApiArtifact> = {}): AgentsApiArtifact {
  return {
    id: "artifact-fixture",
    object: "agent.session.artifact",
    session_id: "session-fixture",
    environment_id: "environment-fixture",
    turn_id: "turn-fixture",
    path: "/workspace/outputs/fixture.bin",
    size_bytes: 4,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function serverError(status: number, headers?: HeadersInit) {
  return Response.json({ error: { message: `Failure ${status}` } }, { status, headers });
}

function requests() {
  return fetchWithSsrFGuardMock.mock.calls.map(
    ([request]) => new Request(request.url, request.init),
  );
}
