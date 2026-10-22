import type { IncomingMessage } from "node:http";
import { VERSION } from "openclaw/plugin-sdk/cli-runtime";
import { resetPluginRuntimeStateForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { a2aChannelPlugin } from "./channel.js";
import { createA2aGatewayFixture } from "./gateway.test-support.js";
import type { dispatchA2aInbound } from "./inbound.js";
import { createStreamingResponse, type StreamingResponse } from "./streaming.test-support.js";
import type { A2aTaskStore } from "./task-store.js";

const { createdStores, dispatchers } = vi.hoisted(() => ({
  createdStores: [] as A2aTaskStore[],
  dispatchers: new WeakMap<
    A2aTaskStore,
    (message: Parameters<typeof dispatchA2aInbound>[0]) => Promise<void>
  >(),
}));
vi.mock("./task-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./task-store.js")>();
  return {
    ...actual,
    A2aTaskStore: class extends actual.A2aTaskStore {
      constructor() {
        super();
        createdStores.push(this);
      }
    },
  };
});
vi.mock("./inbound.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound.js")>()),
  dispatchA2aInbound: async (message: Parameters<typeof dispatchA2aInbound>[0]) =>
    dispatchers.get(message.store)?.(message),
}));

const activeAccounts: Array<{ controller: AbortController; lifecycle: Promise<unknown> }> = [];

afterEach(async () => {
  for (const { controller, lifecycle } of activeAccounts.splice(0)) {
    controller.abort();
    await lifecycle;
  }
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

async function startHarness(options?: {
  a2aConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
  onDispatch?: (message: Parameters<typeof dispatchA2aInbound>[0]) => Promise<void>;
}) {
  const { controller, ctx, registry } = createA2aGatewayFixture({
    version: VERSION,
    cfg: (options?.config ?? {}) as never,
    config: {
      peers: { alpha: { token: "alpha-secret" }, beta: { token: "beta-secret" } },
      ...options?.a2aConfig,
    } as never,
  });
  const lifecycle = Promise.resolve(a2aChannelPlugin.gateway!.startAccount!(ctx));
  activeAccounts.push({ controller, lifecycle });
  const taskStore = createdStores.pop();
  const route = registry.httpRoutes.find((entry) => entry.path === "/a2a/v1");
  const cardRoute = registry.httpRoutes.find(
    (entry) => entry.path === "/.well-known/agent-card.json",
  );
  if (!taskStore || !route || !cardRoute) {
    throw new Error("A2A account did not register its routes");
  }
  const dispatched: Array<Parameters<typeof dispatchA2aInbound>[0]> = [];
  dispatchers.set(
    taskStore,
    options?.onDispatch ??
      (async (message) => {
        dispatched.push(message);
        taskStore.complete(message.taskId, `echo: ${message.text}`);
      }),
  );

  const request = (params: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
  }) => {
    const req = createMockIncomingRequest(
      params.body === undefined ? [] : [JSON.stringify(params.body)],
    );
    req.method = params.method;
    req.url = params.path;
    req.headers = {
      host: "gateway.example.test",
      ...(params.body === undefined ? {} : { "content-type": "application/json" }),
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      ...params.headers,
    };
    return req;
  };

  const run = async (params: Parameters<typeof request>[0]) => {
    const response = createStreamingResponse();
    await (route.handler as (req: IncomingMessage, res: StreamingResponse) => Promise<boolean>)(
      request(params),
      response,
    );
    return {
      status: response.status(),
      body: response.body(),
      json: async () => JSON.parse(response.body()),
      header: (name: string) => response.header(name),
    };
  };
  const getCard = async (headers?: Record<string, string>) => {
    const response = createStreamingResponse();
    await (cardRoute.handler as (req: IncomingMessage, res: StreamingResponse) => Promise<boolean>)(
      request({ method: "GET", path: "/.well-known/agent-card.json", headers }),
      response,
    );
    return { status: response.status(), json: async () => JSON.parse(response.body()) };
  };

  const post = (body: unknown, token?: string | null, headers?: Record<string, string>) =>
    run({ method: "POST", path: "/a2a/v1", body, token: token ?? "alpha-secret", headers });

  return { taskStore, post, run, getCard, dispatched };
}

function rpc(method: string, params?: unknown, id: string | number = "req") {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

describe("A2A ListTasks", () => {
  it("pages through a peer's own tasks only", async () => {
    const { taskStore, post } = await startHarness();
    for (const owner of ["alpha", "alpha", "beta"]) {
      const task = taskStore.create("ctx-list", owner);
      taskStore.complete(task.id, "done");
    }

    const first = await post(rpc("ListTasks", { pageSize: 1 }));
    await expect(first.json()).resolves.toMatchObject({
      result: { pageSize: 1, totalSize: 2, nextPageToken: expect.any(String) },
    });
    const firstBody = (await first.json()) as { result: { nextPageToken: string } };
    const second = await post(
      rpc("ListTasks", { pageSize: 1, pageToken: firstBody.result.nextPageToken }),
    );
    await expect(second.json()).resolves.toMatchObject({
      result: { pageSize: 1, totalSize: 2, nextPageToken: "" },
    });
  });

  it("filters by context and status and strips artifacts unless asked", async () => {
    const { taskStore, post } = await startHarness();
    const done = taskStore.create("ctx-a", "alpha");
    taskStore.complete(done.id, "answer");
    const running = taskStore.create("ctx-b", "alpha");
    taskStore.start(running.id);

    const completedOnly = await post(rpc("ListTasks", { status: "TASK_STATE_COMPLETED" }));
    await expect(completedOnly.json()).resolves.toMatchObject({
      result: { tasks: [{ id: done.id }], totalSize: 1 },
    });

    const byContext = await post(rpc("ListTasks", { contextId: "ctx-b" }));
    await expect(byContext.json()).resolves.toMatchObject({
      result: { tasks: [{ id: running.id }], totalSize: 1 },
    });

    // Artifacts are opt-in on ListTasks (spec §3.1.4).
    const withoutArtifacts = (await (await post(rpc("ListTasks", {}))).json()) as {
      result: { tasks: Array<{ artifacts: unknown[] }> };
    };
    expect(withoutArtifacts.result.tasks.every((task) => task.artifacts.length === 0)).toBe(true);
    const withArtifacts = (await (
      await post(rpc("ListTasks", { includeArtifacts: true }))
    ).json()) as { result: { tasks: Array<{ artifacts: unknown[] }> } };
    expect(withArtifacts.result.tasks.some((task) => task.artifacts.length > 0)).toBe(true);
  });

  it("honors historyLength on GetTask", async () => {
    const { taskStore, post } = await startHarness();
    const task = taskStore.create("ctx-history", "alpha");
    taskStore.appendHistory(task.id, {
      messageId: "m1",
      role: "ROLE_USER",
      parts: [{ text: "first" }],
    });
    taskStore.appendHistory(task.id, {
      messageId: "m2",
      role: "ROLE_USER",
      parts: [{ text: "second" }],
    });

    const trimmed = (await (
      await post(rpc("GetTask", { id: task.id, historyLength: 1 }))
    ).json()) as {
      result: { history: Array<{ messageId: string }> };
    };
    expect(trimmed.result.history.map((entry) => entry.messageId)).toEqual(["m2"]);
    const zero = (await (await post(rpc("GetTask", { id: task.id, historyLength: 0 }))).json()) as {
      result: { history: unknown[] };
    };
    expect(zero.result.history).toEqual([]);
  });
});

describe("A2A task continuation", () => {
  it("resumes an input-required task with a follow-up message", async () => {
    const { taskStore, post, dispatched } = await startHarness();
    const task = taskStore.create("ctx-input", "alpha");
    taskStore.start(task.id);
    taskStore.requireInput(task.id, "which region?");
    expect(taskStore.get(task.id)?.status.state).toBe("TASK_STATE_INPUT_REQUIRED");

    const response = await post(
      rpc("SendMessage", {
        message: {
          taskId: task.id,
          contextId: "ctx-input",
          role: "ROLE_USER",
          parts: [{ text: "use eu-west" }],
        },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      result: { task: { id: task.id, status: { state: "TASK_STATE_COMPLETED" } } },
    });
    // The follow-up ran on the same task, so it must have been dispatched once.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.text).toBe("use eu-west");
  });

  it("rejects a follow-up to a task that already reached a terminal state", async () => {
    const { taskStore, post } = await startHarness();
    const task = taskStore.create("ctx-terminal", "alpha");
    taskStore.complete(task.id, "done");

    const response = await post(
      rpc("SendMessage", {
        message: { taskId: task.id, role: "ROLE_USER", parts: [{ text: "more" }] },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32004 } });
  });
});

describe("A2A extended agent card", () => {
  it("publishes operator-authored descriptions only to authenticated peers", async () => {
    const { post, getCard } = await startHarness({
      config: {
        agents: { entries: { writer: { name: "Writing assistant" } } },
      },
      a2aConfig: {
        capabilities: { extendedAgentCard: true },
        extendedSkillDescriptions: { writer: "Writes docs" },
      },
    });

    const publicCard = (await (await getCard()).json()) as {
      skills: Array<{ name: string; description: string }>;
      capabilities: Record<string, unknown>;
    };
    expect(publicCard.skills[0]?.description).toBe("OpenClaw agent writer.");
    // The public card withholds both the description and the display name.
    expect(publicCard.skills[0]?.name).toBe("writer");
    expect(publicCard.capabilities.extendedAgentCard).toBe(true);

    const extended = (await (await post(rpc("GetExtendedAgentCard"))).json()) as {
      result: { skills: Array<{ name: string; description: string }> };
    };
    expect(extended.result.skills[0]?.description).toBe("Writes docs");
    expect(extended.result.skills[0]?.name).toBe("Writing assistant");
  });

  it("requires authentication at the extended card HTTP path", async () => {
    const { run } = await startHarness({
      a2aConfig: { capabilities: { extendedAgentCard: true } },
    });
    const anonymous = await run({
      method: "GET",
      path: "/a2a/v1/extendedAgentCard",
      token: null,
    });
    expect(anonymous.status).toBe(401);
  });

  it("reports an undeclared extended-card capability as UnsupportedOperation", async () => {
    // §3.3.4: extendedAgentCard absent means the operation itself is
    // unsupported (-32004), which is distinct from declaring support without
    // authoring card content (-32007).
    const { post } = await startHarness();
    const response = await post(rpc("GetExtendedAgentCard"));
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32004,
        data: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "UNSUPPORTED_OPERATION",
            domain: "a2a-protocol.org",
          },
        ],
      },
    });
  });

  it("reports a declared but unconfigured extended card distinctly", async () => {
    const { post } = await startHarness({
      a2aConfig: { capabilities: { extendedAgentCard: true } },
    });
    const response = await post(rpc("GetExtendedAgentCard"));
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32007,
        data: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "EXTENDED_AGENT_CARD_NOT_CONFIGURED",
            domain: "a2a-protocol.org",
          },
        ],
      },
    });
  });
});

describe("A2A content-type validation", () => {
  it("rejects a file part whose media type is not accepted", async () => {
    // CORE-SEND-003: the media-type problem is distinct from a missing text
    // part, and must carry the ErrorInfo detail so peers can branch on it.
    const { post } = await startHarness();
    const response = await post(
      rpc("SendMessage", {
        message: {
          role: "ROLE_USER",
          parts: [{ raw: "dGNr", mediaType: "application/x-unsupported-tck-type" }],
        },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32005,
        data: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "CONTENT_TYPE_NOT_SUPPORTED",
            domain: "a2a-protocol.org",
            metadata: { mediaType: "application/x-unsupported-tck-type" },
          },
        ],
      },
    });
  });

  it("admits file parts whose media type the operator widened", async () => {
    const { post, dispatched } = await startHarness({
      a2aConfig: { inputModes: ["text/plain", "application/pdf"] },
    });
    const response = await post(
      rpc("SendMessage", {
        message: {
          role: "ROLE_USER",
          parts: [
            { text: "summarize this" },
            { raw: "JVBERi0", mediaType: "application/pdf", filename: "doc.pdf" },
          ],
        },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      result: { task: { id: expect.any(String) } },
    });
    expect(dispatched[0]?.text).toContain("[file: doc.pdf]");
  });
});

describe("A2A agent card caching", () => {
  it("serves the card with validators and honors If-None-Match", async () => {
    const { run } = await startHarness();
    const first = await run({
      method: "GET",
      path: "/.well-known/agent-card.json",
      token: null,
    });
    expect(first.status).toBe(200);
    // CARD-CACHE-001/002/003: max-age, ETag and Last-Modified.
    expect(first.header("cache-control")).toContain("max-age=");
    expect(first.header("etag")).toMatch(/^"[\w-]+"$/);
    expect(first.header("last-modified")).toBeDefined();

    const etag = first.header("etag")!;
    const revalidated = await run({
      method: "GET",
      path: "/.well-known/agent-card.json",
      token: null,
      headers: { "if-none-match": etag },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.body).toBe("");
    expect(revalidated.header("etag")).toBe(etag);
  });
});

describe("A2A 0.3 method aliases", () => {
  it("resolves every dotted-era alias to its canonical method", async () => {
    const { post, taskStore } = await startHarness();
    const task = taskStore.create("ctx-alias", "alpha");
    taskStore.complete(task.id, "done");

    // The v1.0 canonical names are CamelCase; these dotted names are the 0.3
    // wire surface, which real clients still send. `tasks/list` and
    // `tasks/subscribe` were the two gaps found by the TCK run.
    const listed = await post(rpc("tasks/list", { pageSize: 5 }));
    await expect(listed.json()).resolves.toMatchObject({ result: { totalSize: 1 } });

    const got = await post(rpc("tasks/get", { id: task.id }));
    await expect(got.json()).resolves.toMatchObject({ result: { id: task.id } });

    // A single (non-batch) streaming request falls back to a JSON-RPC error
    // when the first frame fails. Subscribing to the completed task is refused
    // with UnsupportedOperation — any code other than -32601 proves the alias
    // resolved and reached the SubscribeToTask logic itself.
    for (const alias of ["tasks/resubscribe", "tasks/subscribe"]) {
      const response = await post(rpc(alias, { id: task.id }));
      await expect(response.json()).resolves.toMatchObject({ error: { code: -32004 } });
    }
  });

  it("treats a trailing slash on the JSON-RPC path as the same endpoint", async () => {
    // httpx normalizes base_url to a trailing slash, so `/a2a/v1/` is what a
    // standard client actually sends.
    const { run } = await startHarness();
    const response = await run({
      method: "POST",
      path: "/a2a/v1/",
      body: rpc("ListTasks", { pageSize: 1 }),
      token: "alpha-secret",
    });
    await expect(response.json()).resolves.toMatchObject({ result: { totalSize: 0 } });
  });
});

describe("A2A service parameters", () => {
  it("rejects an unsupported A2A-Version", async () => {
    const { post } = await startHarness();
    const response = await post(rpc("GetTask", { id: "anything" }), "alpha-secret", {
      "a2a-version": "0.3",
    });
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32009 } });
  });

  it("accepts A2A 1.0 and 1.0.x version headers", async () => {
    const { taskStore, post } = await startHarness();
    const task = taskStore.create("ctx-version", "alpha");
    for (const version of ["1.0", "1.0.1"]) {
      const response = await post(rpc("GetTask", { id: task.id }), "alpha-secret", {
        "a2a-version": version,
      });
      await expect(response.json()).resolves.toMatchObject({ result: { id: task.id } });
    }
  });

  it("rejects a non-JSON content type", async () => {
    const { run } = await startHarness();
    const response = await run({
      method: "POST",
      path: "/a2a/v1",
      body: rpc("GetTask", { id: "x" }),
      token: "alpha-secret",
      headers: { "content-type": "text/plain" },
    });
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32005 } });
  });
});

describe("A2A required extensions", () => {
  const requiredConfig = {
    extensions: [
      { uri: "https://example.test/ext/citations/v1", required: true },
      { uri: "https://example.test/ext/optional/v1", required: false },
    ],
  };

  it("refuses a request that omits an extension the card marks required", async () => {
    const { post } = await startHarness({ a2aConfig: requiredConfig });

    // §4.6 / §3.3.2: the agent MUST refuse rather than silently answering a
    // different question than the peer asked.
    const response = await post(
      rpc("SendMessage", {
        message: { role: "ROLE_USER", parts: [{ text: "hello" }] },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32008,
        data: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "EXTENSION_SUPPORT_REQUIRED",
            domain: "a2a-protocol.org",
            metadata: { extensions: "https://example.test/ext/citations/v1" },
          },
        ],
      },
    });
  });

  it("admits the same request once the required extension is declared", async () => {
    const { post } = await startHarness({ a2aConfig: requiredConfig });
    const response = await post(
      rpc("SendMessage", {
        message: { role: "ROLE_USER", parts: [{ text: "hello" }] },
      }),
      "alpha-secret",
      { "a2a-extensions": "https://example.test/ext/citations/v1" },
    );
    await expect(response.json()).resolves.toMatchObject({
      result: { task: { id: expect.any(String) } },
    });
  });

  it("does not require an extension the card marks optional", async () => {
    const { post } = await startHarness({
      a2aConfig: { extensions: [{ uri: "https://example.test/ext/optional/v1" }] },
    });
    const response = await post(rpc("ListTasks", { pageSize: 1 }));
    await expect(response.json()).resolves.toMatchObject({ result: { totalSize: 0 } });
  });
});

describe("A2A HTTP+JSON/REST binding", () => {
  it("serves tasks and push configuration over REST when enabled", async () => {
    const { taskStore, run } = await startHarness({
      a2aConfig: { rest: { enabled: true }, capabilities: { pushNotifications: true } },
    });
    const task = taskStore.create("ctx-rest", "alpha");
    taskStore.start(task.id);

    const fetched = await run({
      method: "GET",
      path: "/a2a/v1/rest/tasks/" + task.id,
      token: "alpha-secret",
    });
    await expect(fetched.json()).resolves.toMatchObject({ id: task.id });

    const listed = await run({
      method: "GET",
      path: "/a2a/v1/rest/tasks?pageSize=5",
      token: "alpha-secret",
    });
    await expect(listed.json()).resolves.toMatchObject({ totalSize: 1, pageSize: 1 });

    const created = await run({
      method: "POST",
      path: `/a2a/v1/rest/tasks/${task.id}/pushNotificationConfigs`,
      // §CreateTaskPushNotificationConfig binds taskId to the path; a compliant
      // body carries only the config fields. A stale taskId in the body must
      // not win over the path (gRPC transcoding removes path fields from it).
      body: { taskId: "wrong-task-from-body", url: "https://peer.example.test/webhook" },
      token: "alpha-secret",
    });
    await expect(created.json()).resolves.toMatchObject({
      taskId: task.id,
      id: expect.any(String),
      url: "https://peer.example.test/webhook",
    });

    // An unmatched route is a plain 404, not an A2A error type, so it carries no
    // ErrorInfo (§11.6 requires the reason only for A2A-specific errors).
    const unknown = await run({
      method: "GET",
      path: "/a2a/v1/rest/not-a-route",
      token: "alpha-secret",
    });
    await expect(unknown.json()).resolves.toMatchObject({
      error: { code: 404, status: "NOT_FOUND", details: [] },
    });

    // Genuine A2A errors do carry the ErrorInfo reason, which is what lets a peer
    // tell a missing task apart from any other 404.
    const missing = await run({
      method: "GET",
      path: "/a2a/v1/rest/tasks/does-not-exist",
      token: "alpha-secret",
    });
    await expect(missing.json()).resolves.toMatchObject({
      error: {
        code: 404,
        status: "NOT_FOUND",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "TASK_NOT_FOUND",
            domain: "a2a-protocol.org",
          },
        ],
      },
    });
  });

  it("maps A2A errors to their v1.0.0 HTTP statuses", async () => {
    const { taskStore, run } = await startHarness({
      a2aConfig: { rest: { enabled: true } },
    });
    const task = taskStore.create("ctx-rest-status", "alpha");
    taskStore.complete(task.id, "done");

    // §5.4 gives cancelable-state violations their own status: the request
    // conflicts with the task's terminal state.
    const canceled = await run({
      method: "POST",
      path: `/a2a/v1/rest/tasks/${task.id}:cancel`,
      body: {},
      token: "alpha-secret",
    });
    expect(canceled.status).toBe(409);
    await expect(canceled.json()).resolves.toMatchObject({
      error: { code: 409, status: "FAILED_PRECONDITION" },
    });

    // An unsupported media type is 415, not a generic 400.
    const media = await run({
      method: "POST",
      path: "/a2a/v1/rest/message:send",
      body: {
        message: {
          role: "ROLE_USER",
          parts: [{ raw: "dGNr", mediaType: "application/x-unsupported" }],
        },
      },
      token: "alpha-secret",
    });
    expect(media.status).toBe(415);
    await expect(media.json()).resolves.toMatchObject({
      error: { code: 415, status: "INVALID_ARGUMENT" },
    });
  });

  it("stays unregistered when the REST binding is disabled", async () => {
    const { run } = await startHarness();
    const response = await run({
      method: "GET",
      path: "/a2a/v1/rest/tasks",
      token: "alpha-secret",
    });
    expect(response.status).toBe(404);
  });
});
