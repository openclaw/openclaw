import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";
import { createGesahniReviewerClient } from "./src/client.js";
import { resolveGesahniReviewerConfig } from "./src/config.js";
import { GESAHNI_REVIEWER_TOOL_NAMES, createGesahniReviewerTools } from "./src/tools.js";

type RegisteredTool = ReturnType<typeof createGesahniReviewerTools>[number];
type RequestLog = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

const CREATE_ARTIFACT_KEYS = [
  "user_id",
  "project_id",
  "task_id",
  "artifact",
  "idempotency_key",
] as const;
const ATTACH_TASK_OUTPUTS_KEYS = [
  "user_id",
  "project_id",
  "task_id",
  "outputs",
  "idempotency_key",
] as const;
const UPDATE_TASK_STATUS_KEYS = [
  "user_id",
  "project_id",
  "task_id",
  "status",
  "idempotency_key",
] as const;
const APPEND_PROJECT_EVENT_KEYS = [
  "user_id",
  "project_id",
  "event",
  "run_id",
  "idempotency_key",
] as const;

function buildReviewArtifact(projectId = "p1", taskId = "t-review") {
  return {
    artifact_type: "review_notes",
    summary: "Review found one blocking readiness issue.",
    content_json: {
      schema_version: "v1",
      project_id: projectId,
      task_id: taskId,
      build_artifact_id: "build-1",
      summary: "Review found one blocking readiness issue.",
      findings: [
        {
          severity: "blocking",
          area: "readiness",
          note: "Build artifact is still in draft state.",
        },
      ],
      strengths: ["Clear page structure"],
      issues: ["Preview is blocked by invalid_build_artifact"],
      revision_requests: ["Promote the build artifact out of draft before preview"],
      approval_recommendation: "blocked",
      recommended_next_step: "blocked",
    },
  };
}

describe("gesahni-reviewer plugin", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("exports only the intended reviewer tool names", () => {
    const tools = createGesahniReviewerTools(
      createApi({
        pluginConfig: {
          baseUrl: "https://gesahni.example",
          readBridgeToken: "read-token",
          writeBridgeToken: "write-token",
        },
      }),
    );

    expect(tools.map((tool) => tool.name)).toEqual([...GESAHNI_REVIEWER_TOOL_NAMES]);
  });

  it("registers exactly the intended reviewer tools", () => {
    const registerTool = vi.fn();
    register(
      createApi({
        pluginConfig: {
          baseUrl: "https://gesahni.example",
          readBridgeToken: "read-token",
          writeBridgeToken: "write-token",
        },
        registerTool,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(GESAHNI_REVIEWER_TOOL_NAMES.length);
    expect(registerTool.mock.calls.map((call) => call[0]?.name)).toEqual([
      ...GESAHNI_REVIEWER_TOOL_NAMES,
    ]);
    expect(registerTool.mock.calls.every((call) => call[1]?.optional === true)).toBe(true);
  });

  it("publishes locked-down reviewer tool schemas", () => {
    const tools = toolMap(vi.fn());

    expect(Object.keys(tools.create_artifact.parameters.properties ?? {})).toEqual([
      ...CREATE_ARTIFACT_KEYS,
    ]);
    expect(tools.create_artifact.parameters.required).toEqual([
      "user_id",
      "project_id",
      "task_id",
      "artifact",
    ]);

    expect(Object.keys(tools.attach_task_outputs.parameters.properties ?? {})).toEqual([
      ...ATTACH_TASK_OUTPUTS_KEYS,
    ]);
    expect(tools.attach_task_outputs.parameters.required).toEqual([
      "user_id",
      "project_id",
      "task_id",
      "outputs",
    ]);

    expect(Object.keys(tools.update_task_status.parameters.properties ?? {})).toEqual([
      ...UPDATE_TASK_STATUS_KEYS,
    ]);
    expect(tools.update_task_status.parameters.required).toEqual([
      "user_id",
      "project_id",
      "task_id",
      "status",
    ]);

    expect(Object.keys(tools.append_project_event.parameters.properties ?? {})).toEqual([
      ...APPEND_PROJECT_EVENT_KEYS,
    ]);
    expect(tools.append_project_event.parameters.required).toEqual([
      "user_id",
      "project_id",
      "event",
    ]);
  });

  it("keeps the reviewer tool surface stable", () => {
    const tools = toolMap(vi.fn());
    expect(Object.keys(tools)).toEqual([...GESAHNI_REVIEWER_TOOL_NAMES]);
  });

  it("resolves config from plugin config first and env fallback second", () => {
    process.env.GESAHNI_BASE_URL = "https://env.example";
    process.env.GESAHNI_READ_BRIDGE_TOKEN = "env-read";
    process.env.GESAHNI_WRITE_BRIDGE_TOKEN = "env-write";

    expect(
      resolveGesahniReviewerConfig(
        createApi({
          pluginConfig: {
            baseUrl: "https://plugin.example/",
            readBridgeToken: "plugin-read",
            writeBridgeToken: "plugin-write",
          },
        }),
      ),
    ).toEqual({
      baseUrl: "https://plugin.example",
      readBridgeToken: "plugin-read",
      writeBridgeToken: "plugin-write",
    });

    expect(resolveGesahniReviewerConfig(createApi({ pluginConfig: {} }))).toEqual({
      baseUrl: "https://env.example",
      readBridgeToken: "env-read",
      writeBridgeToken: "env-write",
    });
  });

  it("preserves host.docker.internal for Docker bridge access", () => {
    expect(
      resolveGesahniReviewerConfig(
        createApi({
          pluginConfig: {
            baseUrl: "http://host.docker.internal:8000/",
            readBridgeToken: "plugin-read",
            writeBridgeToken: "plugin-write",
          },
        }),
      ),
    ).toEqual({
      baseUrl: "http://host.docker.internal:8000",
      readBridgeToken: "plugin-read",
      writeBridgeToken: "plugin-write",
    });
  });

  it("maps every tool to the expected bridge route, method, token, and headers", async () => {
    const requests = await collectRequests(async (tools) => {
      await tools.get_project_snapshot.execute("call-1", { user_id: "tg:1", project_id: "p1" });
      await tools.get_intake_snapshot.execute("call-2", { user_id: "tg:1", project_id: "p1" });
      await tools.get_website_workflow_snapshot.execute("call-3", {
        user_id: "tg:1",
        project_id: "p1",
      });
      await tools.get_project_operator_summary.execute("call-4", {
        user_id: "tg:1",
        project_id: "p1",
      });
      await tools.get_preview_deploy_snapshot.execute("call-5", {
        user_id: "tg:1",
        project_id: "p1",
      });
      await tools.create_artifact.execute("call-6", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t-review",
        artifact: buildReviewArtifact(),
        idempotency_key: "idem-artifact",
      });
      await tools.attach_task_outputs.execute("call-7", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t-review",
        outputs: {
          outputs: [{ output_type: "artifact", artifact_id: "a1" }],
        },
        idempotency_key: "idem-outputs",
      });
      await tools.update_task_status.execute("call-8", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t-review",
        status: { status: "completed" },
        idempotency_key: "idem-status",
      });
      await tools.append_project_event.execute("call-9", {
        user_id: "tg:1",
        project_id: "p1",
        run_id: "r1",
        event: {
          event_type: "review_notes_created",
          task_id: "t-review",
          artifact_id: "a1",
          build_artifact_id: "build-1",
          recommended_next_step: "blocked",
        },
        idempotency_key: "idem-event",
      });
    });

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "GET /v1/bridge/projects/p1",
        "GET /v1/bridge/projects/p1/intake/snapshot",
        "GET /v1/bridge/projects/p1/website/workflow/snapshot",
        "GET /v1/bridge/projects/p1/operator/summary",
        "GET /v1/bridge/projects/p1/preview-deploy/snapshot",
        "POST /v1/bridge/projects/p1/artifacts",
        "POST /v1/bridge/projects/p1/tasks/t-review/outputs",
        "PATCH /v1/bridge/projects/p1/tasks/t-review/status",
        "POST /v1/bridge/projects/p1/runs/r1/events",
      ],
    );

    const readRequests = requests.slice(0, 5);
    const writeRequests = requests.slice(5);
    expect(
      readRequests.every((request) => request.headers.authorization === "Bearer read-token"),
    ).toBe(true);
    expect(
      writeRequests.every((request) => request.headers.authorization === "Bearer write-token"),
    ).toBe(true);
    expect(requests.every((request) => request.headers["x-user-id"] === "tg:1")).toBe(true);
    expect(requests[5]?.headers["idempotency-key"]).toBe("idem-artifact");
    expect(requests[8]?.headers["idempotency-key"]).toBe("idem-event");
    expect(JSON.parse(requests[5]?.body ?? "{}")).toEqual({
      artifact_type: "review_notes",
      summary: "Review found one blocking readiness issue.",
      task_id: "t-review",
      schema_version: "v1",
      preview_json: {
        schema_version: "v1",
        project_id: "p1",
        task_id: "t-review",
        build_artifact_id: "build-1",
        summary: "Review found one blocking readiness issue.",
        findings: [
          {
            severity: "blocking",
            area: "readiness",
            note: "Build artifact is still in draft state.",
          },
        ],
        strengths: ["Clear page structure"],
        issues: ["Preview is blocked by invalid_build_artifact"],
        revision_requests: ["Promote the build artifact out of draft before preview"],
        approval_recommendation: "blocked",
        recommended_next_step: "blocked",
      },
    });
    expect(JSON.parse(requests[6]?.body ?? "{}")).toEqual({
      output_artifact_ids: ["a1"],
    });
    expect(JSON.parse(requests[7]?.body ?? "{}")).toEqual({ status: "completed" });
    expect(JSON.parse(requests[8]?.body ?? "{}")).toEqual({
      event: "review_notes_created",
      source: "gesahni-reviewer",
      task_id: "t-review",
      payload: {
        artifact_id: "a1",
        build_artifact_id: "build-1",
        recommended_next_step: "blocked",
      },
    });
  });

  it("normalizes Telegram-style user ids before HTTP", async () => {
    const requests = await collectRequests(async (tools) => {
      await tools.get_project_snapshot.execute("call-1", {
        user_id: "telegram:7975901790",
        project_id: "p1",
      });
      await tools.get_project_snapshot.execute("call-2", {
        user_id: "7975901790",
        project_id: "p1",
      });
    });

    expect(requests[0]?.headers["x-user-id"]).toBe("tg:7975901790");
    expect(requests[1]?.headers["x-user-id"]).toBe("tg:7975901790");
  });

  it("routes append_project_event to project-scoped events when run_id is absent", async () => {
    const requests = await collectRequests(async (tools) => {
      await tools.append_project_event.execute("call-1", {
        user_id: "tg:1",
        project_id: "p1",
        event: {
          event_type: "review_notes_created",
          task_id: "t-review",
          artifact_id: "a1",
        },
        idempotency_key: "idem-event-no-run",
      });
    });

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /v1/bridge/projects/p1/events"],
    );
    expect(requests[0]?.headers.authorization).toBe("Bearer write-token");
    expect(requests[0]?.headers["x-user-id"]).toBe("tg:1");
    expect(requests[0]?.headers["idempotency-key"]).toBe("idem-event-no-run");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      event: "review_notes_created",
      source: "gesahni-reviewer",
      task_id: "t-review",
      payload: { artifact_id: "a1" },
    });
  });

  it("forces create_artifact to review_notes only", async () => {
    const fetchImpl = vi.fn();
    const tools = toolMap(fetchImpl as typeof fetch);

    await expect(
      tools.create_artifact.execute("call-1", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t-review",
        artifact: {
          artifact_type: "code_draft",
          content_json: {},
        },
      }),
    ).rejects.toThrow("artifact.artifact_type must be review_notes");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails locally for missing reviewer ids and malformed review_notes contract", async () => {
    const fetchImpl = vi.fn();
    const tools = toolMap(fetchImpl as typeof fetch);

    await expect(
      tools.create_artifact.execute("call-1", {
        user_id: "tg:1",
        task_id: "t-review",
        artifact: buildReviewArtifact(),
      }),
    ).rejects.toThrow("project_id required");

    await expect(
      tools.create_artifact.execute("call-2", {
        user_id: "tg:1",
        project_id: "p1",
        artifact: buildReviewArtifact(),
      }),
    ).rejects.toThrow("task_id required");

    await expect(
      tools.create_artifact.execute("call-3", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t-review",
        artifact: {
          artifact_type: "review_notes",
          summary: "summary",
          content_json: {
            findings: [],
            strengths: [],
            issues: [],
            revision_requests: [],
            approval_recommendation: "blocked",
            recommended_next_step: "blocked",
          },
        },
      }),
    ).rejects.toThrow("artifact.content_json.build_artifact_id required");

    await expect(
      tools.create_artifact.execute("call-4", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t-review",
        artifact: {
          artifact_type: "review_notes",
          summary: "summary",
          content_json: {
            build_artifact_id: "build-1",
            findings: [{ severity: "severe", area: "readiness", note: "bad" }],
            strengths: [],
            issues: [],
            revision_requests: [],
            approval_recommendation: "blocked",
            recommended_next_step: "blocked",
          },
        },
      }),
    ).rejects.toThrow("artifact.content_json.findings[0].severity invalid");

    await expect(
      tools.create_artifact.execute("call-5", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t-review",
        artifact: {
          artifact_type: "review_notes",
          summary: "summary",
          content_json: {
            build_artifact_id: "build-1",
            findings: [{ severity: "blocking", area: "readiness", note: "bad" }],
            strengths: [],
            issues: [],
            revision_requests: [],
            approval_recommendation: "approve_now",
            recommended_next_step: "blocked",
          },
        },
      }),
    ).rejects.toThrow("artifact.content_json.approval_recommendation invalid");

    await expect(
      tools.attach_task_outputs.execute("call-6", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t-review",
      }),
    ).rejects.toThrow("outputs required");

    await expect(
      tools.update_task_status.execute("call-7", {
        user_id: "tg:1",
        project_id: "p1",
        status: { status: "completed" },
      }),
    ).rejects.toThrow("task_id required");

    await expect(
      tools.append_project_event.execute("call-8", {
        user_id: "tg:1",
        project_id: "p1",
      }),
    ).rejects.toThrow("event required");

    await expect(
      tools.append_project_event.execute("call-9", {
        user_id: "tg:1",
        project_id: "p1",
        event: {
          event_type: "review_notes_created",
          created_at: "2026-03-15T15:08:40.123456+00:00",
        },
      }),
    ).rejects.toThrow("event.task_id required");

    await expect(
      tools.append_project_event.execute("call-10", {
        user_id: "tg:1",
        project_id: "p1",
        event: {
          event_type: "review_notes_created",
          task_id: "t-review",
          created_at: "2026-03-15T15:08:40.123456+00:00",
        },
      }),
    ).rejects.toThrow("event.created_at not allowed");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("client preserves plain-text bridge errors without flattening them", async () => {
    const client = createGesahniReviewerClient({
      config: {
        baseUrl: "https://gesahni.example",
        readBridgeToken: "read-token",
        writeBridgeToken: "write-token",
      },
      fetchImpl: vi.fn(async () => new Response("temporarily unavailable", { status: 503 })),
    });

    await expect(
      client.request({
        path: "/v1/bridge/projects/p1/artifacts",
        method: "POST",
        auth: "write",
        userId: "tg:1",
        body: { artifact_type: "review_notes" },
      }),
    ).resolves.toEqual({
      ok: false,
      status: 503,
      statusText: "",
      body: "temporarily unavailable",
    });
  });
});

function createApi(params?: {
  pluginConfig?: Record<string, unknown>;
  registerTool?: (tool: RegisteredTool, options?: { optional?: boolean }) => void;
}): OpenClawPluginApi {
  return {
    id: "gesahni-reviewer",
    name: "Gesahni Reviewer",
    source: "test",
    config: {},
    pluginConfig: params?.pluginConfig ?? {},
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: { info() {}, warn() {}, error() {} },
    registerTool: params?.registerTool ?? (() => {}),
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    registerContextEngine() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
  };
}

function toolMap(fetchImpl: typeof fetch) {
  const tools = createGesahniReviewerTools(
    createApi({
      pluginConfig: {
        baseUrl: "https://gesahni.example",
        readBridgeToken: "read-token",
        writeBridgeToken: "write-token",
      },
    }),
    { fetchImpl },
  );

  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<
    (typeof GESAHNI_REVIEWER_TOOL_NAMES)[number],
    RegisteredTool
  >;
}

async function collectRequests(
  run: (
    tools: Record<(typeof GESAHNI_REVIEWER_TOOL_NAMES)[number], RegisteredTool>,
  ) => Promise<void>,
): Promise<RequestLog[]> {
  const requests: RequestLog[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify({ ok: true, url: String(input) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await run(toolMap(fetchImpl));
  return requests;
}
