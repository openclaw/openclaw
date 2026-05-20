import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";
import { createGesahniOperatorClient } from "./src/client.js";
import { resolveGesahniOperatorConfig } from "./src/config.js";
import { GESAHNI_OPERATOR_TOOL_NAMES, createGesahniOperatorTools } from "./src/tools.js";

type RegisteredTool = ReturnType<typeof createGesahniOperatorTools>[number];
type ToolName = (typeof GESAHNI_OPERATOR_TOOL_NAMES)[number];

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

describe("gesahni-operator plugin", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("exports only the intended operator tool names", () => {
    const tools = createGesahniOperatorTools(
      createApi({
        pluginConfig: {
          baseUrl: "https://gesahni.example",
          readBridgeToken: "read-token",
          writeBridgeToken: "write-token",
        },
      }),
    );

    expect(tools.map((tool) => tool.name)).toEqual([...GESAHNI_OPERATOR_TOOL_NAMES]);
  });

  it("registers exactly the intended operator tools", () => {
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

    expect(registerTool).toHaveBeenCalledTimes(GESAHNI_OPERATOR_TOOL_NAMES.length);
    expect(registerTool.mock.calls.map((call) => call[0]?.name)).toEqual([
      ...GESAHNI_OPERATOR_TOOL_NAMES,
    ]);
    expect(registerTool.mock.calls.every((call) => call[1]?.optional === true)).toBe(true);
  });

  it("publishes the locked create, context, and intake contracts", () => {
    const tools = toolMap(vi.fn());
    const createProject = tools.create_project.parameters as ToolParameters;
    const attachProjectContext = tools.attach_project_context.parameters as ToolParameters;
    const updateIntake = tools.update_intake_from_context.parameters as ToolParameters;

    expect(createProject.required).toEqual([
      "user_id",
      "title",
      "client_name",
      "project_type",
      "goal",
    ]);
    expect(Object.keys(createProject.properties)).toEqual([
      "user_id",
      "title",
      "client_name",
      "project_type",
      "goal",
      "idempotency_key",
    ]);
    expect(createProject.properties.user_id).toMatchObject({
      description: expect.stringContaining("tg:<chat_id>"),
    });
    expect(createProject.properties.goal).toMatchObject({
      description: expect.stringContaining("Do not place full brief context here"),
    });
    expect(createProject.properties).not.toHaveProperty("project");
    expect(createProject.properties).not.toHaveProperty("project_id");
    expect(createProject.properties).not.toHaveProperty("business_summary");
    expect(createProject.properties).not.toHaveProperty("site_scope");
    expect(createProject.properties).not.toHaveProperty("current_website");
    expect(createProject.properties).not.toHaveProperty("references");
    expect(createProject.properties).not.toHaveProperty("preferred_tone");
    expect(createProject.properties).not.toHaveProperty("required_pages");
    expect(createProject.properties).not.toHaveProperty("colors_branding");
    expect(createProject.properties).not.toHaveProperty("stack_preferences");
    expect(createProject.properties).not.toHaveProperty("deploy_preference");
    expect(createProject.properties).not.toHaveProperty("assets");

    expect(attachProjectContext.required).toEqual([
      "user_id",
      "project_id",
      "context_type",
      "source",
      "content_json",
    ]);
    expect(Object.keys(attachProjectContext.properties)).toEqual([
      "user_id",
      "project_id",
      "context_type",
      "source",
      "content_json",
      "content_text",
      "version",
      "idempotency_key",
    ]);
    expect(attachProjectContext.properties.content_json).toMatchObject({
      description: expect.stringContaining("content_json"),
    });
    expect(attachProjectContext.properties).not.toHaveProperty("context");
    expect(attachProjectContext.properties).not.toHaveProperty("business_summary");
    expect(attachProjectContext.properties).not.toHaveProperty("site_scope");
    expect(attachProjectContext.properties).not.toHaveProperty("current_website");
    expect(attachProjectContext.properties).not.toHaveProperty("references");
    expect(attachProjectContext.properties).not.toHaveProperty("preferred_tone");
    expect(attachProjectContext.properties).not.toHaveProperty("required_pages");
    expect(attachProjectContext.properties).not.toHaveProperty("colors_branding");
    expect(attachProjectContext.properties).not.toHaveProperty("stack_preferences");
    expect(attachProjectContext.properties).not.toHaveProperty("deploy_preference");
    expect(attachProjectContext.properties).not.toHaveProperty("assets");

    expect(updateIntake.required).toEqual(["user_id", "project_id", "payload"]);
    expect(updateIntake.properties.payload).toMatchObject({
      description: expect.stringContaining("Use {} when no extra flags are needed"),
    });
  });

  it("keeps all other tool names and write surfaces stable", () => {
    const tools = toolMap(vi.fn());

    expect(Object.keys(tools)).toEqual([...GESAHNI_OPERATOR_TOOL_NAMES]);
    expect(Object.keys(tools)).not.toContain("create_project_context");
    expect(Object.keys(tools)).not.toContain("derive_project_intake");
    expect(tools.update_intake_from_context).toBeDefined();
  });

  it("maps each website workflow stage to the correct specialist delegation lane", async () => {
    const tools = toolMap(vi.fn());
    const orchestrationTool = tools.get_website_orchestration_plan;
    const expectations = [
      ["research", "gesahni-researcher", "research_summary"],
      ["sitemap", "gesahni-builder", "sitemap"],
      ["copy", "gesahni-builder", "copy_draft"],
      ["build", "gesahni-builder", "code_draft"],
      ["review", "gesahni-reviewer", "review_notes"],
    ] as const;

    for (const [stage, agentId, artifactType] of expectations) {
      const result = await orchestrationTool.execute(`call-${stage}`, {
        project_id: "p1",
        workflow_snapshot: {
          workflow: {
            workflow_initialized: true,
            current_stage: stage,
            next_stage: stage,
            blockers: [],
            stages: [{ stage, status: "ready" }],
          },
        },
        preview_snapshot: {
          state: "unavailable",
          latest_result: null,
        },
      });

      expect(result).toMatchObject({
        details: {
          project_id: "p1",
          current_stage: stage,
          next_stage: stage,
          preview_state: "unavailable",
          preview_latest_result: null,
          plan: {
            action: "delegate_specialist",
            delegate_agent_id: agentId,
            delegate_stage: stage,
            expected_artifact_type: artifactType,
          },
        },
      });
    }
  });

  it("blocks operator from auto-invoking specialist writes, approvals, or deploys in the orchestration plan", async () => {
    const tools = toolMap(vi.fn());
    const result = await tools.get_website_orchestration_plan.execute("call-1", {
      project_id: "p1",
      workflow_snapshot: {
        workflow: {
          workflow_initialized: true,
          current_stage: "research",
          next_stage: "research",
          blockers: [],
          stages: [{ stage: "research", status: "ready" }],
        },
      },
    });

    expect(result).toMatchObject({
      details: {
        operator_allowed_tools: expect.arrayContaining([
          "create_project",
          "attach_project_context",
          "update_intake_from_context",
          "get_intake_snapshot",
          "initialize_website_workflow",
          "get_website_workflow_snapshot",
          "get_website_orchestration_plan",
          "get_project_operator_summary",
          "get_preview_deploy_snapshot",
          "sessions_send",
        ]),
        preferred_delegation_tool: "sessions_send",
        operator_must_not_auto_invoke: expect.arrayContaining([
          "create_artifact",
          "attach_task_outputs",
          "update_task_status",
          "append_project_event",
          "request_preview_deploy",
          "approve_approval",
          "reject_approval",
          "cancel_approval",
        ]),
        final_result_fields: expect.arrayContaining([
          "project_id",
          "research_task_id",
          "sitemap_task_id",
          "copy_task_id",
          "build_task_id",
          "review_task_id",
          "research_artifact_id",
          "sitemap_artifact_id",
          "copy_artifact_id",
          "code_artifact_id",
          "review_artifact_id",
          "current_stage",
          "next_stage",
          "blockers",
          "preview_state",
          "preview_latest_result",
          "final_status",
        ]),
      },
    });
  });

  it("keeps a blocked current stage honest instead of delegating speculatively", async () => {
    const tools = toolMap(vi.fn());
    const result = await tools.get_website_orchestration_plan.execute("call-1", {
      project_id: "p1",
      workflow_snapshot: {
        workflow: {
          workflow_initialized: true,
          current_stage: "review",
          next_stage: "review",
          blockers: [{ code: "review_blocker" }],
          stages: [{ stage: "review", status: "blocked" }],
        },
      },
      preview_snapshot: {
        state: "unavailable",
        latest_result: null,
      },
    });

    expect(result).toMatchObject({
      details: {
        current_stage: "review",
        blockers: [{ code: "review_blocker" }],
        plan: {
          action: "stop_blocked",
          delegate_agent_id: null,
          delegate_stage: "review",
          expected_artifact_type: "review_notes",
        },
      },
    });
  });

  it("resolves config from plugin config first and env fallback second", () => {
    process.env.GESAHNI_BASE_URL = "https://env.example";
    process.env.GESAHNI_READ_BRIDGE_TOKEN = "env-read";
    process.env.GESAHNI_WRITE_BRIDGE_TOKEN = "env-write";

    expect(
      resolveGesahniOperatorConfig(
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

    expect(resolveGesahniOperatorConfig(createApi({ pluginConfig: {} }))).toEqual({
      baseUrl: "https://env.example",
      readBridgeToken: "env-read",
      writeBridgeToken: "env-write",
    });
  });

  it("preserves host.docker.internal for Docker bridge access", () => {
    expect(
      resolveGesahniOperatorConfig(
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

  it("maps every tool to the expected bridge route, auth, headers, and bodies", async () => {
    const requests: RequestRecord[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const url = requestUrl(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ ok: true, url }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const tools = toolMap(fetchImpl);

    await tools.list_projects.execute("call-1", { user_id: "tg:1" });
    await tools.get_project_snapshot.execute("call-2", { user_id: "tg:1", project_id: "p1" });
    await tools.get_intake_snapshot.execute("call-3", { user_id: "tg:1", project_id: "p1" });
    await tools.get_website_workflow_snapshot.execute("call-4", {
      user_id: "tg:1",
      project_id: "p1",
    });
    await tools.get_project_operator_summary.execute("call-5", {
      user_id: "tg:1",
      project_id: "p1",
    });
    await tools.get_run_report.execute("call-6", {
      user_id: "tg:1",
      project_id: "p1",
      run_id: "r1",
    });
    await tools.get_rerun_presentation.execute("call-7", { user_id: "tg:1", project_id: "p1" });
    await tools.get_preview_deploy_snapshot.execute("call-8", {
      user_id: "tg:1",
      project_id: "p1",
    });
    await tools.create_project.execute("call-9", {
      user_id: "tg:1",
      title: "Project One",
      client_name: "Acme Client",
      project_type: "website",
      goal: "Launch a trustworthy local services website",
      idempotency_key: "idem-create",
    });
    await tools.attach_project_context.execute("call-10", {
      user_id: "tg:1",
      project_id: "p1",
      context_type: "website_brief",
      source: "operator_chat",
      content_json: { business_summary: "Launch a trustworthy local services website" },
      content_text: "Launch a trustworthy local services website",
      version: 1,
      idempotency_key: "idem-context",
    });
    await tools.update_intake_from_context.execute("call-11", {
      user_id: "tg:1",
      project_id: "p1",
      payload: {},
      idempotency_key: "idem-intake",
    });
    await tools.initialize_website_workflow.execute("call-12", {
      user_id: "tg:1",
      project_id: "p1",
      workflow: { mode: "fresh" },
      idempotency_key: "idem-workflow",
    });
    await tools.request_preview_deploy.execute("call-13", {
      user_id: "tg:1",
      project_id: "p1",
      request: { target: "preview" },
      idempotency_key: "idem-preview",
    });
    await tools.approve_approval.execute("call-14", {
      user_id: "tg:1",
      project_id: "p1",
      approval_id: "a1",
      idempotency_key: "idem-approve",
    });
    await tools.reject_approval.execute("call-15", {
      user_id: "tg:1",
      project_id: "p1",
      approval_id: "a1",
      idempotency_key: "idem-reject",
    });
    await tools.cancel_approval.execute("call-16", {
      user_id: "tg:1",
      project_id: "p1",
      approval_id: "a1",
      idempotency_key: "idem-cancel",
    });

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "GET /v1/bridge/projects",
        "GET /v1/bridge/projects/p1",
        "GET /v1/bridge/projects/p1/intake/snapshot",
        "GET /v1/bridge/projects/p1/website/workflow/snapshot",
        "GET /v1/bridge/projects/p1/operator/summary",
        "GET /v1/bridge/projects/p1/runs/r1/report",
        "GET /v1/bridge/projects/p1/rerun-presentation",
        "GET /v1/bridge/projects/p1/preview-deploy/snapshot",
        "POST /v1/bridge/projects",
        "POST /v1/bridge/projects/p1/context",
        "POST /v1/bridge/projects/p1/intake/update-from-context",
        "POST /v1/bridge/projects/p1/website/workflow/initialize",
        "POST /v1/bridge/projects/p1/preview-deploy/request",
        "POST /v1/bridge/projects/p1/approvals/a1/approve",
        "POST /v1/bridge/projects/p1/approvals/a1/reject",
        "POST /v1/bridge/projects/p1/approvals/a1/cancel",
      ],
    );

    const readRequests = requests.slice(0, 8);
    const writeRequests = requests.slice(8);
    expect(
      readRequests.every((request) => request.headers.authorization === "Bearer read-token"),
    ).toBe(true);
    expect(
      writeRequests.every((request) => request.headers.authorization === "Bearer write-token"),
    ).toBe(true);
    expect(requests.every((request) => request.headers["x-user-id"] === "tg:1")).toBe(true);
    expect(requests[8]?.headers["idempotency-key"]).toBe("idem-create");
    expect(requests[9]?.headers["idempotency-key"]).toBe("idem-context");
    expect(requests[12]?.headers["idempotency-key"]).toBe("idem-preview");
    expect(requests[13]?.headers["idempotency-key"]).toBe("idem-approve");
    expect(requests[8]?.body).toBe(
      JSON.stringify({
        title: "Project One",
        client_name: "Acme Client",
        project_type: "website",
        goal: "Launch a trustworthy local services website",
      }),
    );
    expect(requests[9]?.body).toBe(
      JSON.stringify({
        context_type: "website_brief",
        source: "operator_chat",
        content_json: { business_summary: "Launch a trustworthy local services website" },
        content_text: "Launch a trustworthy local services website",
        version: 1,
      }),
    );
    expect(requests[10]?.body).toBe(JSON.stringify({ payload: {} }));
    expect(requests[11]?.body).toBe(JSON.stringify({ mode: "fresh" }));
    expect(requests[12]?.body).toBe(JSON.stringify({ target: "preview" }));
    expect(requests[13]?.body).toBeUndefined();
  });

  it("returns structured JSON responses intact", async () => {
    const tool = createGesahniOperatorTools(
      createApi({
        pluginConfig: {
          baseUrl: "https://gesahni.example",
          readBridgeToken: "read-token",
          writeBridgeToken: "write-token",
        },
      }),
      {
        fetchImpl: vi.fn(
          async () =>
            new Response(JSON.stringify({ project_id: "p1", nested: { status: "ready" } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      },
    ).find((candidate) => candidate.name === "get_project_snapshot") as RegisteredTool;

    const result = await tool.execute("call-1", { user_id: "tg:1", project_id: "p1" });
    expect(result).toMatchObject({
      details: { project_id: "p1", nested: { status: "ready" } },
      content: [
        {
          type: "text",
          text: JSON.stringify({ project_id: "p1", nested: { status: "ready" } }, null, 2),
        },
      ],
    });
  });

  it("preserves structured bridge errors, including preview no-provider failures", async () => {
    const tool = createGesahniOperatorTools(
      createApi({
        pluginConfig: {
          baseUrl: "https://gesahni.example",
          readBridgeToken: "read-token",
          writeBridgeToken: "write-token",
        },
      }),
      {
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                code: "no_preview_provider",
                message: "No preview provider configured",
                retryable: false,
              }),
              {
                status: 409,
                statusText: "Conflict",
                headers: { "content-type": "application/json" },
              },
            ),
        ),
      },
    ).find((candidate) => candidate.name === "request_preview_deploy") as RegisteredTool;

    const result = await tool.execute("call-1", {
      user_id: "tg:1",
      project_id: "p1",
      request: { target: "preview" },
    });

    expect(result).toMatchObject({
      details: {
        ok: false,
        status: 409,
        statusText: "Conflict",
        error: {
          code: "no_preview_provider",
          message: "No preview provider configured",
          retryable: false,
        },
      },
    });
  });

  it("fails locally for missing create_project base fields and skips HTTP", async () => {
    const fetchImpl = vi.fn();
    const tools = toolMap(fetchImpl as typeof fetch);

    await expect(
      tools.create_project.execute("call-1", {
        user_id: "tg:1",
        client_name: "Acme Client",
        project_type: "website",
        goal: "Launch a trustworthy local services website",
      }),
    ).rejects.toThrow("title required");
    await expect(
      tools.create_project.execute("call-2", {
        user_id: "tg:1",
        title: "Project One",
        project_type: "website",
        goal: "Launch a trustworthy local services website",
      }),
    ).rejects.toThrow("client_name required");
    await expect(
      tools.create_project.execute("call-3", {
        user_id: "tg:1",
        title: "Project One",
        client_name: "Acme Client",
        goal: "Launch a trustworthy local services website",
      }),
    ).rejects.toThrow("project_type required");
    await expect(
      tools.create_project.execute("call-4", {
        user_id: "tg:1",
        title: "Project One",
        client_name: "Acme Client",
        project_type: "website",
      }),
    ).rejects.toThrow("goal required");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects old create_project shapes locally and skips HTTP", async () => {
    const fetchImpl = vi.fn();
    const tools = toolMap(fetchImpl as typeof fetch);

    await expect(
      tools.create_project.execute("call-1", {
        ...baseCreateProjectArgs(),
        project_id: "p1",
      }),
    ).rejects.toThrow("project_id not allowed");
    await expect(
      tools.create_project.execute("call-2", {
        user_id: "tg:1",
        project: { title: "Project One" },
      }),
    ).rejects.toThrow("project not allowed");
    await expect(
      tools.create_project.execute("call-3", {
        ...baseCreateProjectArgs(),
        business_summary: "Do not allow intake-only fields here",
      }),
    ).rejects.toThrow("business_summary not allowed");
    await expect(
      tools.create_project.execute("call-4", {
        ...baseCreateProjectArgs(),
        site_scope: "multi-page",
      }),
    ).rejects.toThrow("site_scope not allowed");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails locally for missing attach_project_context wrapped fields and skips HTTP", async () => {
    const fetchImpl = vi.fn();
    const tools = toolMap(fetchImpl as typeof fetch);

    await expect(
      tools.attach_project_context.execute("call-1", {
        user_id: "tg:1",
        context_type: "website_brief",
        source: "operator_chat",
        content_json: {},
      }),
    ).rejects.toThrow("project_id required");
    await expect(
      tools.attach_project_context.execute("call-2", {
        user_id: "tg:1",
        project_id: "p1",
        source: "operator_chat",
        content_json: {},
      }),
    ).rejects.toThrow("context_type required");
    await expect(
      tools.attach_project_context.execute("call-3", {
        user_id: "tg:1",
        project_id: "p1",
        context_type: "website_brief",
        content_json: {},
      }),
    ).rejects.toThrow("source required");
    await expect(
      tools.attach_project_context.execute("call-4", {
        user_id: "tg:1",
        project_id: "p1",
        context_type: "website_brief",
        source: "operator_chat",
      }),
    ).rejects.toThrow("content_json required");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects raw attach_project_context misuse locally and skips HTTP", async () => {
    const fetchImpl = vi.fn();
    const tools = toolMap(fetchImpl as typeof fetch);

    await expect(
      tools.attach_project_context.execute("call-1", {
        user_id: "tg:1",
        project_id: "p1",
        context: { source: "brief" },
      }),
    ).rejects.toThrow("context not allowed");
    await expect(
      tools.attach_project_context.execute("call-2", {
        user_id: "tg:1",
        project_id: "p1",
        business_summary: "wrong shape",
      }),
    ).rejects.toThrow("business_summary not allowed");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("wraps update_intake_from_context in the live bridge payload body", async () => {
    const requests: Array<{ body?: string }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const tools = toolMap(fetchImpl);

    await tools.update_intake_from_context.execute("call-1", {
      user_id: "tg:1",
      project_id: "p1",
      payload: {},
    });
    await expect(
      tools.update_intake_from_context.execute("call-2", { user_id: "tg:1", payload: {} }),
    ).rejects.toThrow("project_id required");
    await expect(
      tools.update_intake_from_context.execute("call-3", { project_id: "p1", payload: {} }),
    ).rejects.toThrow("user_id required");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requests[0]?.body).toBe(JSON.stringify({ payload: {} }));
  });

  it("sends create_project with the exact bridge-native body only", async () => {
    const requests: RequestRecord[] = [];
    const tools = toolMap(recordingFetch(requests));

    await tools.create_project.execute("call-1", {
      user_id: "tg:1",
      title: "Smoke & Spark HVAC",
      client_name: "Smoke & Spark HVAC",
      project_type: "website",
      goal: "Generate a trustworthy local services website",
      idempotency_key: "idem-create",
    });

    expect(requests).toHaveLength(1);
    expect(`${requests[0]?.method} ${new URL(requests[0]?.url ?? "").pathname}`).toBe(
      "POST /v1/bridge/projects",
    );
    expect(requests[0]?.headers.authorization).toBe("Bearer write-token");
    expect(requests[0]?.headers["x-user-id"]).toBe("tg:1");
    expect(requests[0]?.headers["idempotency-key"]).toBe("idem-create");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      title: "Smoke & Spark HVAC",
      client_name: "Smoke & Spark HVAC",
      project_type: "website",
      goal: "Generate a trustworthy local services website",
    });
    expect(JSON.parse(requests[0]?.body ?? "{}")).not.toHaveProperty("user_id");
    expect(JSON.parse(requests[0]?.body ?? "{}")).not.toHaveProperty("idempotency_key");
    expect(JSON.parse(requests[0]?.body ?? "{}")).not.toHaveProperty("project_id");
    expect(JSON.parse(requests[0]?.body ?? "{}")).not.toHaveProperty("business_summary");
    expect(JSON.parse(requests[0]?.body ?? "{}")).not.toHaveProperty("site_scope");
    expect(JSON.parse(requests[0]?.body ?? "{}")).not.toHaveProperty("content_json");
  });

  it("sends attach_project_context with the exact wrapped body and optional fields only when present", async () => {
    const requiredOnlyRequests: RequestRecord[] = [];
    const optionalRequests: RequestRecord[] = [];
    const requiredOnlyTools = toolMap(recordingFetch(requiredOnlyRequests));
    const optionalTools = toolMap(recordingFetch(optionalRequests));

    await requiredOnlyTools.attach_project_context.execute("call-1", {
      user_id: "tg:1",
      project_id: "p1",
      context_type: "website_brief",
      source: "operator_chat",
      content_json: { business_summary: "required only" },
      idempotency_key: "idem-context-required",
    });
    await optionalTools.attach_project_context.execute("call-2", {
      user_id: "tg:1",
      project_id: "p1",
      context_type: "website_brief",
      source: "operator_chat",
      content_json: { business_summary: "with optional fields" },
      content_text: "with optional fields",
      version: 1,
      idempotency_key: "idem-context-optional",
    });

    expect(
      `${requiredOnlyRequests[0]?.method} ${new URL(requiredOnlyRequests[0]?.url ?? "").pathname}`,
    ).toBe("POST /v1/bridge/projects/p1/context");
    expect(requiredOnlyRequests[0]?.headers.authorization).toBe("Bearer write-token");
    expect(requiredOnlyRequests[0]?.headers["x-user-id"]).toBe("tg:1");
    expect(requiredOnlyRequests[0]?.headers["idempotency-key"]).toBe("idem-context-required");
    expect(JSON.parse(requiredOnlyRequests[0]?.body ?? "{}")).toEqual({
      context_type: "website_brief",
      source: "operator_chat",
      content_json: { business_summary: "required only" },
    });

    expect(optionalRequests[0]?.headers["idempotency-key"]).toBe("idem-context-optional");
    expect(JSON.parse(optionalRequests[0]?.body ?? "{}")).toEqual({
      context_type: "website_brief",
      source: "operator_chat",
      content_json: { business_summary: "with optional fields" },
      content_text: "with optional fields",
      version: 1,
    });
    expect(JSON.parse(optionalRequests[0]?.body ?? "{}")).not.toHaveProperty("user_id");
    expect(JSON.parse(optionalRequests[0]?.body ?? "{}")).not.toHaveProperty("idempotency_key");
    expect(JSON.parse(optionalRequests[0]?.body ?? "{}")).not.toHaveProperty("business_summary");
  });

  it("allows optional request and workflow bodies while still enforcing required route fields", async () => {
    const requests: Array<{ headers: Record<string, string>; body?: string }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        headers: Object.fromEntries(headers.entries()),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const tools = toolMap(fetchImpl);

    await tools.initialize_website_workflow.execute("call-1", {
      user_id: "tg:1",
      project_id: "p1",
    });
    await tools.request_preview_deploy.execute("call-2", {
      user_id: "tg:1",
      project_id: "p1",
      idempotency_key: "idem-preview",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requests[0]?.headers.authorization).toBe("Bearer write-token");
    expect(requests[0]?.headers["x-user-id"]).toBe("tg:1");
    expect(requests[0]?.body).toBeUndefined();
    expect(requests[1]?.headers.authorization).toBe("Bearer write-token");
    expect(requests[1]?.headers["x-user-id"]).toBe("tg:1");
    expect(requests[1]?.headers["idempotency-key"]).toBe("idem-preview");
    expect(requests[1]?.body).toBeUndefined();
  });

  it("normalizes Telegram-style user ids before HTTP", async () => {
    const requests: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const tools = toolMap(fetchImpl);

    await tools.create_project.execute("call-1", {
      user_id: "telegram:7975901790",
      title: "Smoke & Spark HVAC",
      client_name: "Smoke & Spark HVAC",
      project_type: "website",
      goal: "Launch the website",
    });
    await tools.create_project.execute("call-2", {
      user_id: "7975901790",
      title: "Smoke & Spark HVAC",
      client_name: "Smoke & Spark HVAC",
      project_type: "website",
      goal: "Launch the website",
    });

    expect(requests[0]?.headers["x-user-id"]).toBe("tg:7975901790");
    expect(requests[1]?.headers["x-user-id"]).toBe("tg:7975901790");
  });

  it("keeps approval tools as ordinary thin bridge POST wrappers", async () => {
    const requests: string[] = [];
    const tools = toolMap(
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(requestUrl(input));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await tools.approve_approval.execute("call-1", {
      user_id: "tg:1",
      project_id: "p1",
      approval_id: "a1",
    });
    await tools.reject_approval.execute("call-2", {
      user_id: "tg:1",
      project_id: "p1",
      approval_id: "a1",
    });
    await tools.cancel_approval.execute("call-3", {
      user_id: "tg:1",
      project_id: "p1",
      approval_id: "a1",
    });

    expect(requests.map((url) => new URL(url).pathname)).toEqual([
      "/v1/bridge/projects/p1/approvals/a1/approve",
      "/v1/bridge/projects/p1/approvals/a1/reject",
      "/v1/bridge/projects/p1/approvals/a1/cancel",
    ]);
  });

  it("never calls non-bridge routes", async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(JSON.stringify({ ok: true, url: requestUrl(input) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const tools = toolMap(fetchImpl);

    await tools.list_projects.execute("call-1", { user_id: "tg:1" });
    await tools.create_project.execute("call-2", baseCreateProjectArgs());

    expect(fetchImpl.mock.calls.every((call) => requestUrl(call[0]).includes("/v1/bridge/"))).toBe(
      true,
    );
    expect(fetchImpl.mock.calls.some((call) => requestUrl(call[0]).includes("/v1/projects"))).toBe(
      false,
    );
  });

  it("client preserves plain-text bridge errors without flattening them", async () => {
    const client = createGesahniOperatorClient({
      config: {
        baseUrl: "https://gesahni.example",
        readBridgeToken: "read-token",
        writeBridgeToken: "write-token",
      },
      fetchImpl: vi.fn(async () => new Response("temporarily unavailable", { status: 503 })),
    });

    await expect(
      client.request({
        path: "/v1/bridge/projects",
        method: "GET",
        auth: "read",
        userId: "tg:1",
      }),
    ).resolves.toEqual({
      ok: false,
      status: 503,
      statusText: "",
      body: "temporarily unavailable",
    });
  });

  it("live operator runtime exposes delegation tools without specialist write surfaces", () => {
    const config = {
      agents: {
        list: [
          {
            id: "gesahni-operator",
            subagents: {
              allowAgents: ["gesahni-researcher", "gesahni-builder", "gesahni-reviewer"],
            },
            tools: {
              alsoAllow: ["get_website_orchestration_plan", "sessions_send"],
              deny: ["sessions_spawn"],
            },
          },
        ],
      },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: {
          allow: [
            "main",
            "gesahni",
            "gesahni-operator",
            "gesahni-researcher",
            "gesahni-builder",
            "gesahni-reviewer",
          ],
        },
      },
    } satisfies {
      agents: {
        list: Array<{
          id: string;
          subagents?: { allowAgents?: string[] };
          tools?: { alsoAllow?: string[]; deny?: string[] };
        }>;
      };
      tools?: {
        sessions?: { visibility?: string };
        agentToAgent?: { allow?: string[] };
      };
    };
    const operator = config.agents.list.find((candidate) => candidate.id === "gesahni-operator");
    expect(operator?.tools?.alsoAllow).toEqual(
      expect.arrayContaining(["get_website_orchestration_plan", "sessions_send"]),
    );
    expect(operator?.tools?.deny).toEqual(expect.arrayContaining(["sessions_spawn"]));
    expect(operator?.subagents?.allowAgents).toEqual([
      "gesahni-researcher",
      "gesahni-builder",
      "gesahni-reviewer",
    ]);
    expect(config.tools?.sessions?.visibility).toBe("all");
    expect(config.tools?.agentToAgent?.allow).toEqual([
      "main",
      "gesahni",
      "gesahni-operator",
      "gesahni-researcher",
      "gesahni-builder",
      "gesahni-reviewer",
    ]);
    expect(operator?.tools?.alsoAllow).not.toEqual(
      expect.arrayContaining([
        "create_artifact",
        "attach_task_outputs",
        "update_task_status",
        "append_project_event",
      ]),
    );
  });

  it("documents single-entry live website orchestration for the operator role", () => {
    const orchestrationDoc = readFileSync(
      new URL("../../agents/gesahni-operator/ORCHESTRATION.md", import.meta.url),
      "utf8",
    );

    expect(orchestrationDoc).toContain("get_website_orchestration_plan");
    expect(orchestrationDoc).toContain("sessions_send");
    expect(orchestrationDoc).toContain("sessions_spawn");
    expect(orchestrationDoc).toContain("agent:gesahni-researcher:main");
    expect(orchestrationDoc).toContain("agent:gesahni-builder:main");
    expect(orchestrationDoc).toContain("agent:gesahni-reviewer:main");
    expect(orchestrationDoc).toContain("gesahni-researcher");
    expect(orchestrationDoc).toContain("gesahni-builder");
    expect(orchestrationDoc).toContain("gesahni-reviewer");
    expect(orchestrationDoc).toContain("research_summary");
    expect(orchestrationDoc).toContain("sitemap");
    expect(orchestrationDoc).toContain("copy_draft");
    expect(orchestrationDoc).toContain("code_draft");
    expect(orchestrationDoc).toContain("review_notes");
    expect(orchestrationDoc).toContain("preview_state");
    expect(orchestrationDoc).toContain("preview_latest_result");
    expect(orchestrationDoc).toContain("Do not call specialist write tools directly");
  });
});

type ToolParameters = {
  properties: Record<string, unknown>;
  required?: string[];
};

type RequestRecord = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

function baseCreateProjectArgs(): Record<string, unknown> {
  return {
    user_id: "tg:1",
    title: "Project One",
    client_name: "Acme Client",
    project_type: "website",
    goal: "Launch a trustworthy local services website",
  };
}

function recordingFetch(requests: RequestRecord[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: requestUrl(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function createApi(params?: {
  pluginConfig?: Record<string, unknown>;
  registerTool?: OpenClawPluginApi["registerTool"];
}): OpenClawPluginApi {
  return {
    id: "gesahni-operator",
    name: "Gesahni Operator",
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
  } as unknown as OpenClawPluginApi;
}

function toolMap(fetchImpl: typeof fetch) {
  const tools = createGesahniOperatorTools(
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
    ToolName,
    RegisteredTool
  >;
}
