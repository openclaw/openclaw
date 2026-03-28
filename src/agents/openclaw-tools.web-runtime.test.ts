import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeWebFirecrawlMetadata } from "../secrets/runtime-web-tools.types.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";

const mockedModuleIds = [
  "../plugins/tools.js",
  "../gateway/call.js",
  "./tools/agents-list-tool.js",
  "./tools/canvas-tool.js",
  "./tools/cron-tool.js",
  "./tools/gateway-tool.js",
  "./tools/image-generate-tool.js",
  "./tools/image-tool.js",
  "./tools/message-tool.js",
  "./tools/nodes-tool.js",
  "./tools/pdf-tool.js",
  "./tools/session-status-tool.js",
  "./tools/sessions-history-tool.js",
  "./tools/sessions-list-tool.js",
  "./tools/sessions-send-tool.js",
  "./tools/sessions-spawn-tool.js",
  "./tools/sessions-yield-tool.js",
  "./tools/subagents-tool.js",
  "./tools/tts-tool.js",
] as const;

vi.mock("../plugins/tools.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/tools.js")>("../plugins/tools.js");
  return {
    ...actual,
    copyPluginToolMeta: () => undefined,
  };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

function createStubTool(name: string) {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ output: name })),
  };
}

function mockToolFactory(name: string) {
  return () => createStubTool(name);
}

vi.mock("./tools/agents-list-tool.js", () => ({
  createAgentsListTool: mockToolFactory("agents_list_stub"),
}));
vi.mock("./tools/canvas-tool.js", () => ({
  createCanvasTool: mockToolFactory("canvas_stub"),
}));
vi.mock("./tools/cron-tool.js", () => ({
  createCronTool: mockToolFactory("cron_stub"),
}));
vi.mock("./tools/gateway-tool.js", () => ({
  createGatewayTool: mockToolFactory("gateway_stub"),
}));
vi.mock("./tools/image-generate-tool.js", () => ({
  createImageGenerateTool: mockToolFactory("image_generate_stub"),
}));
vi.mock("./tools/image-tool.js", () => ({
  createImageTool: mockToolFactory("image_stub"),
}));
vi.mock("./tools/message-tool.js", () => ({
  createMessageTool: mockToolFactory("message_stub"),
}));
vi.mock("./tools/nodes-tool.js", () => ({
  createNodesTool: mockToolFactory("nodes_stub"),
}));
vi.mock("./tools/pdf-tool.js", () => ({
  createPdfTool: mockToolFactory("pdf_stub"),
}));
vi.mock("./tools/session-status-tool.js", () => ({
  createSessionStatusTool: mockToolFactory("session_status_stub"),
}));
vi.mock("./tools/sessions-history-tool.js", () => ({
  createSessionsHistoryTool: mockToolFactory("sessions_history_stub"),
}));
vi.mock("./tools/sessions-list-tool.js", () => ({
  createSessionsListTool: mockToolFactory("sessions_list_stub"),
}));
vi.mock("./tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: mockToolFactory("sessions_send_stub"),
}));
vi.mock("./tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: mockToolFactory("sessions_spawn_stub"),
}));
vi.mock("./tools/sessions-yield-tool.js", () => ({
  createSessionsYieldTool: mockToolFactory("sessions_yield_stub"),
}));
vi.mock("./tools/subagents-tool.js", () => ({
  createSubagentsTool: mockToolFactory("subagents_stub"),
}));
vi.mock("./tools/tts-tool.js", () => ({
  createTtsTool: mockToolFactory("tts_stub"),
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

let secretsRuntime: typeof import("../secrets/runtime.js");
let createWebSearchTool: typeof import("./tools/web-tools.js").createWebSearchTool;
let createWebFetchTool: typeof import("./tools/web-tools.js").createWebFetchTool;

function requireWebSearchTool(config: OpenClawConfig, runtimeWebSearch?: RuntimeWebSearchMetadata) {
  const tool = createWebSearchTool({
    config,
    sandboxed: true,
    runtimeWebSearch,
  });
  expect(tool).toBeDefined();
  if (!tool) {
    throw new Error("missing web_search tool");
  }
  return tool;
}

function requireWebFetchTool(
  config: OpenClawConfig,
  runtimeFirecrawl?: RuntimeWebFirecrawlMetadata,
) {
  const tool = createWebFetchTool({
    config,
    sandboxed: true,
    runtimeFirecrawl,
  });
  expect(tool).toBeDefined();
  if (!tool) {
    throw new Error("missing web_fetch tool");
  }
  return tool;
}

function makeHeaders(map: Record<string, string>): { get: (key: string) => string | null } {
  return {
    get: (key) => map[key.toLowerCase()] ?? null,
  };
}

async function prepareAndActivate(params: { config: OpenClawConfig; env?: NodeJS.ProcessEnv }) {
  const snapshot = await secretsRuntime.prepareSecretsRuntimeSnapshot({
    config: params.config,
    env: params.env,
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => ({ version: 1, profiles: {} }),
  });
  secretsRuntime.activateSecretsRuntimeSnapshot(snapshot);
  return snapshot;
}

describe("openclaw tools runtime web metadata wiring", () => {
  const priorFetch = global.fetch;

  beforeEach(async () => {
    vi.resetModules();
    secretsRuntime = await import("../secrets/runtime.js");
    ({ createWebFetchTool, createWebSearchTool } = await import("./tools/web-tools.js"));
  });

  afterEach(() => {
    global.fetch = priorFetch;
    secretsRuntime.clearSecretsRuntimeSnapshot();
  });

  afterAll(() => {
    for (const id of mockedModuleIds) {
      vi.doUnmock(id);
    }
  });

  it("uses runtime-selected provider when higher-precedence provider ref is unresolved", async () => {
    const snapshot = await prepareAndActivate({
      config: asConfig({
        tools: {
          web: {
            search: {
              apiKey: { source: "env", provider: "default", id: "MISSING_BRAVE_KEY_REF" },
              gemini: {
                apiKey: { source: "env", provider: "default", id: "GEMINI_WEB_KEY_REF" },
              },
            },
          },
        },
      }),
      env: {
        GEMINI_WEB_KEY_REF: "gemini-runtime-key",
      },
    });

    expect(snapshot.webTools.search.selectedProvider).toBe("gemini");

    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: { parts: [{ text: "runtime gemini ok" }] },
                groundingMetadata: { groundingChunks: [] },
              },
            ],
          }),
      } as Response),
    );
    global.fetch = withFetchPreconnect(mockFetch);

    const webSearch = requireWebSearchTool(snapshot.config, snapshot.webTools.search);
    const result = await webSearch.execute("call-runtime-search", { query: "runtime search" });

    expect(mockFetch).toHaveBeenCalled();
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("generativelanguage.googleapis.com");
    expect((result.details as { provider?: string }).provider).toBe("gemini");
  });

  it("skips Firecrawl key resolution when runtime marks Firecrawl inactive", async () => {
    const snapshot = await prepareAndActivate({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              firecrawl: {
                enabled: false,
                apiKey: { source: "env", provider: "default", id: "MISSING_FIRECRAWL_KEY_REF" },
              },
            },
          },
        },
      }),
    });

    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: makeHeaders({ "content-type": "text/html; charset=utf-8" }),
        text: () =>
          Promise.resolve(
            "<html><body><article><h1>Runtime Off</h1><p>Use direct fetch.</p></article></body></html>",
          ),
      } as Response),
    );
    global.fetch = withFetchPreconnect(mockFetch);

    const webFetch = requireWebFetchTool(snapshot.config, snapshot.webTools.fetch.firecrawl);
    await webFetch.execute("call-runtime-fetch", { url: "https://example.com/runtime-off" });

    expect(mockFetch).toHaveBeenCalled();
    expect(mockFetch.mock.calls[0]?.[0]).toBe("https://example.com/runtime-off");
    expect(String(mockFetch.mock.calls[0]?.[0])).not.toContain("api.firecrawl.dev");
  });
});
