import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";
import { createGesahniBuilderClient } from "./src/client.js";
import { resolveGesahniBuilderConfig } from "./src/config.js";
import { GESAHNI_BUILDER_TOOL_NAMES, createGesahniBuilderTools } from "./src/tools.js";

type RegisteredTool = ReturnType<typeof createGesahniBuilderTools>[number];
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

describe("gesahni-builder plugin", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("exports only the intended builder tool names", () => {
    const tools = createGesahniBuilderTools(
      createApi({
        pluginConfig: {
          baseUrl: "https://gesahni.example",
          readBridgeToken: "read-token",
          writeBridgeToken: "write-token",
        },
      }),
    );

    expect(tools.map((tool) => tool.name)).toEqual([...GESAHNI_BUILDER_TOOL_NAMES]);
    expect(tools.map((tool) => tool.name)).not.toContain("request_preview_deploy");
    expect(tools.map((tool) => tool.name)).not.toContain("approve_approval");
    expect(tools.map((tool) => tool.name)).not.toContain("gesahni_market_summary_get");
  });

  it("registers exactly the intended builder tools", () => {
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

    expect(registerTool).toHaveBeenCalledTimes(GESAHNI_BUILDER_TOOL_NAMES.length);
    expect(registerTool.mock.calls.map((call) => call[0]?.name)).toEqual([
      ...GESAHNI_BUILDER_TOOL_NAMES,
    ]);
    expect(registerTool.mock.calls.every((call) => call[1]?.optional === true)).toBe(true);
  });

  it("publishes locked-down builder tool schemas", () => {
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

  it("resolves config from plugin config first and env fallback second", () => {
    process.env.GESAHNI_BASE_URL = "https://env.example";
    process.env.GESAHNI_READ_BRIDGE_TOKEN = "env-read";
    process.env.GESAHNI_WRITE_BRIDGE_TOKEN = "env-write";

    expect(
      resolveGesahniBuilderConfig(
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

    expect(resolveGesahniBuilderConfig(createApi({ pluginConfig: {} }))).toEqual({
      baseUrl: "https://env.example",
      readBridgeToken: "env-read",
      writeBridgeToken: "env-write",
    });
  });

  it("preserves host.docker.internal for Docker bridge access", () => {
    expect(
      resolveGesahniBuilderConfig(
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

  it("maps builder tools to the expected bridge routes, methods, tokens, and headers", async () => {
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
        task_id: "t-sitemap",
        artifact: {
          artifact_type: "sitemap",
          content_json: {
            pages: [
              {
                slug: "home",
                title: "Home",
                purpose: "Introduce the business",
                sections: ["hero", "services", "contact"],
              },
            ],
            primary_navigation: ["Home", "Services", "About", "Contact"],
            footer_navigation: ["Privacy", "Contact"],
            notes: ["Use the provided HVAC brief only."],
          },
        },
        idempotency_key: "idem-artifact",
      });
      await tools.attach_task_outputs.execute("call-7", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t-sitemap",
        outputs: {
          outputs: [{ output_type: "artifact", artifact_id: "a1" }],
        },
        idempotency_key: "idem-outputs",
      });
      await tools.update_task_status.execute("call-8", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t-sitemap",
        status: { status: "completed" },
        idempotency_key: "idem-status",
      });
      await tools.append_project_event.execute("call-9", {
        user_id: "tg:1",
        project_id: "p1",
        run_id: "r1",
        event: {
          event_type: "sitemap_created",
          task_id: "t-sitemap",
          artifact_id: "a1",
          stage: "sitemap",
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
        "POST /v1/bridge/projects/p1/tasks/t-sitemap/outputs",
        "PATCH /v1/bridge/projects/p1/tasks/t-sitemap/status",
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
      artifact_type: "sitemap",
      summary: "sitemap for p1",
      task_id: "t-sitemap",
      schema_version: "v1",
      preview_json: {
        schema_version: "v1",
        project_id: "p1",
        task_id: "t-sitemap",
        pages: [
          {
            slug: "home",
            title: "Home",
            purpose: "Introduce the business",
            sections: ["hero", "services", "contact"],
          },
        ],
        primary_navigation: ["Home", "Services", "About", "Contact"],
        footer_navigation: ["Privacy", "Contact"],
        notes: ["Use the provided HVAC brief only."],
      },
    });
    expect(JSON.parse(requests[6]?.body ?? "{}")).toEqual({
      output_artifact_ids: ["a1"],
    });
    expect(JSON.parse(requests[7]?.body ?? "{}")).toEqual({
      status: "completed",
    });
    expect(JSON.parse(requests[8]?.body ?? "{}")).toEqual({
      event: "sitemap_created",
      source: "gesahni-builder",
      task_id: "t-sitemap",
      payload: {
        artifact_id: "a1",
        stage: "sitemap",
      },
    });
  });

  it("routes append_project_event to project-scoped events when run_id is absent", async () => {
    const requests = await collectRequests(async (tools) => {
      await tools.append_project_event.execute("call-1", {
        user_id: "tg:1",
        project_id: "p1",
        event: {
          event_type: "code_draft_created",
          task_id: "t-build",
          artifact_id: "a-build",
          stage: "build",
        },
        idempotency_key: "idem-event-no-run",
      });
    });

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /v1/bridge/projects/p1/events"],
    );
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      event: "code_draft_created",
      source: "gesahni-builder",
      task_id: "t-build",
      payload: {
        artifact_id: "a-build",
        stage: "build",
      },
    });
  });

  it("enforces sitemap, copy_draft, and code_draft contracts locally", async () => {
    const fetchImpl = vi.fn();
    const tools = toolMap(fetchImpl as typeof fetch);

    await expect(
      tools.create_artifact.execute("call-1", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t1",
        artifact: {
          artifact_type: "research_summary",
          content_json: {},
        },
      }),
    ).rejects.toThrow("artifact.artifact_type must be sitemap, copy_draft, or code_draft");

    await expect(
      tools.create_artifact.execute("call-2", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t1",
        artifact: {
          artifact_type: "sitemap",
          content_json: {
            primary_navigation: ["Home"],
            footer_navigation: ["Contact"],
          },
        },
      }),
    ).rejects.toThrow("artifact.content_json.pages required");

    await expect(
      tools.create_artifact.execute("call-3", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t1",
        artifact: {
          artifact_type: "copy_draft",
          content_json: {
            pages: {},
            tone: "clear and trustworthy",
          },
        },
      }),
    ).rejects.toThrow("artifact.content_json.pages required");

    await expect(
      tools.create_artifact.execute("call-4", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t1",
        artifact: {
          artifact_type: "code_draft",
          content_json: {
            files: {
              "app/page.tsx": "export default function Page(){return null}",
            },
            framework: "nextjs",
          },
        },
      }),
    ).rejects.toThrow("artifact.content_json.files.app/services/page.tsx required");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails locally for missing required fields and skips HTTP", async () => {
    const fetchImpl = vi.fn();
    const tools = toolMap(fetchImpl as typeof fetch);

    await expect(
      tools.create_artifact.execute("call-1", {
        user_id: "tg:1",
        task_id: "t1",
        artifact: { artifact_type: "sitemap", content_json: {} },
      }),
    ).rejects.toThrow("project_id required");

    await expect(
      tools.attach_task_outputs.execute("call-2", {
        user_id: "tg:1",
        project_id: "p1",
        task_id: "t1",
      }),
    ).rejects.toThrow("outputs required");

    await expect(
      tools.update_task_status.execute("call-3", {
        user_id: "tg:1",
        project_id: "p1",
        status: { status: "completed" },
      }),
    ).rejects.toThrow("task_id required");

    await expect(
      tools.append_project_event.execute("call-4", {
        user_id: "tg:1",
        project_id: "p1",
      }),
    ).rejects.toThrow("event required");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("client preserves plain-text bridge errors without flattening them", async () => {
    const client = createGesahniBuilderClient({
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
        body: { artifact_type: "sitemap" },
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
    id: "gesahni-builder",
    name: "Gesahni Builder",
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
  const tools = createGesahniBuilderTools(
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
    (typeof GESAHNI_BUILDER_TOOL_NAMES)[number],
    RegisteredTool
  >;
}

async function collectRequests(
  run: (
    tools: Record<(typeof GESAHNI_BUILDER_TOOL_NAMES)[number], RegisteredTool>,
  ) => Promise<void>,
) {
  const requests: RequestLog[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(
      [...new Headers(init?.headers).entries()].map(([key, value]) => [key.toLowerCase(), value]),
    );
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? String(init.body) : undefined,
    });

    return new Response(JSON.stringify({ ok: true, artifact_id: "a1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await run(toolMap(fetchImpl as typeof fetch));
  return requests;
}
