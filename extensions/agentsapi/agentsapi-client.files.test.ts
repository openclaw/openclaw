import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentsApiClient,
  type AgentsApiArtifact,
  type AgentsApiInputFile,
} from "./agentsapi-client.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

describe("Agents API file upload transport", () => {
  it("includes inline binary files in the hosted session creation request", async () => {
    queueResponse(Response.json({ id: "session-fixture" }));
    const client = createClient();

    await expect(
      client.create(new AbortController().signal, "Fixture instructions", "fixture-model", {
        files: [inputFile],
      }),
    ).resolves.toBe("session-fixture");

    const request = requestAt(0);
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/v1/agents/sessions");
    expect(await request.json()).toMatchObject({
      environment: {
        type: "openai_hosted",
        files: [{ type: "inline", path: "/workspace/inputs/fixture.bin", data: "AP+AQQ==" }],
      },
    });
  });

  it("uploads through the reused session's connected environment and verifies its receipt", async () => {
    queueUploadContext();
    queueResponse(Response.json(uploadReceipt));

    await expect(
      createClient().uploadFile("session-fixture", inputFile, new AbortController().signal),
    ).resolves.toBeUndefined();

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
    expect([requestAt(0), requestAt(1)].map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/agents/sessions/session-fixture",
      "/v1/agents/environments/environment-fixture",
    ]);
    const upload = requestAt(2);
    expect(upload.method).toBe("POST");
    expect(new URL(upload.url).pathname).toBe("/v1/agents/environments/environment-fixture/files");
    expect(upload.headers.get("Idempotency-Key")).toEqual(expect.any(String));
    expect(await upload.json()).toEqual({
      type: "inline",
      path: "/workspace/inputs/fixture.bin",
      data: "AP+AQQ==",
    });
  });

  it.each([
    { name: "another environment", patch: { id: "environment-other" } },
    { name: "a disconnected environment", patch: { status: "disconnected" } },
  ])("refuses an upload to $name", async ({ patch }) => {
    queueUploadContext(patch);

    await expect(
      createClient().uploadFile("session-fixture", inputFile, new AbortController().signal),
    ).rejects.toThrow("requires the session's connected hosted environment");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect([requestAt(0).method, requestAt(1).method]).toEqual(["GET", "GET"]);
  });

  it.each([
    { name: "environment", patch: { environment_id: "environment-other" } },
    { name: "path", patch: { path: "/workspace/inputs/other.bin" } },
    { name: "decoded byte count", patch: { size_bytes: 5 } },
  ])("rejects an upload receipt with a different $name", async ({ patch }) => {
    queueUploadContext();
    queueResponse(Response.json({ ...uploadReceipt, ...patch }));

    await expect(
      createClient().uploadFile("session-fixture", inputFile, new AbortController().signal),
    ).rejects.toThrow("did not match the requested environment, path, or size");
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
      createClient().artifacts("session-fixture", "turn-fixture", new AbortController().signal),
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
      createClient().artifacts("session-fixture", "turn-fixture", new AbortController().signal),
    ).rejects.toThrow("artifact outside the requested session");
  });

  it.each(["empty", "repeated"])("stops a %s continuation page", async (kind) => {
    if (kind === "repeated") {
      queueResponse(Response.json({ data: [artifact()], has_more: true }));
    }
    queueResponse(Response.json({ data: kind === "empty" ? [] : [artifact()], has_more: true }));

    await expect(
      createClient().artifacts("session-fixture", "turn-fixture", new AbortController().signal),
    ).rejects.toThrow("no valid continuation cursor");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(kind === "empty" ? 1 : 2);
  });

  it.each([
    { name: "requested root turn", patch: {}, accepted: true },
    { name: "different turn", patch: { id: "turn-other" }, accepted: false },
    { name: "different session", patch: { session_id: "session-other" }, accepted: false },
    { name: "subagent turn", patch: { subagent_id: "subagent-fixture" }, accepted: false },
  ])("checks a $name before accepting its output metadata", async ({ patch, accepted }) => {
    const savedTurn = turn(patch);
    queueResponse(Response.json(savedTurn));
    const result = createClient().turn(
      "session-fixture",
      "turn-fixture",
      new AbortController().signal,
    );

    if (accepted) {
      await expect(result).resolves.toEqual(savedTurn);
      expect(new URL(requestAt(0).url).pathname).toBe(
        "/v1/agents/sessions/session-fixture/turns/turn-fixture",
      );
    } else {
      await expect(result).rejects.toThrow("turn outside the requested root session");
    }
  });
});

describe("Agents API immutable artifact download", () => {
  it("returns binary chunks at the byte limit and releases the guarded response", async () => {
    const release = queueResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([0, 255]));
            controller.enqueue(Uint8Array.from([128, 65]));
            controller.close();
          },
        }),
      ),
    );

    await expect(
      createClient().artifactContent(
        "session-fixture",
        artifact(),
        4,
        new AbortController().signal,
      ),
    ).resolves.toEqual(Buffer.from([0, 255, 128, 65]));
    const request = requestAt(0);
    expect(request.headers.get("Accept")).toBe("application/octet-stream");
    expect(new URL(request.url).pathname).toBe(
      "/v1/agents/sessions/session-fixture/artifacts/artifact-fixture/content",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "truncated", bytes: [0, 255], message: "did not match its immutable size" },
    { name: "oversized", bytes: [0, 255, 128, 65, 9], message: "exceeded its immutable size" },
  ])("rejects $name content and releases the response", async ({ bytes, message }) => {
    const release = queueResponse(new Response(Uint8Array.from(bytes)));

    await expect(
      createClient().artifactContent(
        "session-fixture",
        artifact(),
        4,
        new AbortController().signal,
      ),
    ).rejects.toThrow(message);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "foreign session", metadata: { session_id: "session-other" }, limit: 4 },
    { name: "oversized metadata", metadata: { size_bytes: 5 }, limit: 4 },
    { name: "invalid byte budget", metadata: {}, limit: -1 },
  ])("rejects $name before opening a download", async ({ metadata, limit }) => {
    await expect(
      createClient().artifactContent(
        "session-fixture",
        artifact(metadata),
        limit,
        new AbortController().signal,
      ),
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

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-fixture",
    object: "agent.session.turn",
    session_id: "session-fixture",
    agent_id: "agent-fixture",
    subagent_id: null,
    created_at: 1,
    started_at: 1,
    completed_at: 2,
    status: "completed",
    error: null,
    usage: null,
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
