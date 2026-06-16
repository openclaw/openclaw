// Feishu tests cover wiki plugin pagination behavior.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginRuntime } from "../runtime-api.js";

const createFeishuToolClientMock = vi.hoisted(() => vi.fn());
const resolveAnyEnabledFeishuToolsConfigMock = vi.hoisted(() => vi.fn());

vi.mock("./tool-account.js", () => ({
  createFeishuToolClient: createFeishuToolClientMock,
  resolveAnyEnabledFeishuToolsConfig: resolveAnyEnabledFeishuToolsConfigMock,
}));

let registerFeishuWikiTools: typeof import("./wiki.js").registerFeishuWikiTools;

type FeishuWikiTool = {
  name?: string;
  execute: (callId: string, input: Record<string, unknown>) => Promise<{ details?: unknown }>;
};

type FeishuWikiToolFactory = (context: { agentAccountId?: string }) => FeishuWikiTool;

function createFeishuToolRuntime(): PluginRuntime {
  return {} as PluginRuntime;
}

function createWikiToolApi(registerTool: OpenClawPluginApi["registerTool"]): OpenClawPluginApi {
  return createTestPluginApi({
    id: "feishu-test",
    name: "Feishu Test",
    source: "local",
    config: {
      channels: {
        feishu: {
          enabled: true,
          appId: "app_id",
          appSecret: "app_secret", // pragma: allowlist secret
          tools: { wiki: true },
        },
      },
    },
    runtime: createFeishuToolRuntime(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool,
  });
}

function buildWikiTool(): { tool: FeishuWikiTool } {
  const registerTool = vi.fn();
  registerFeishuWikiTools(createWikiToolApi(registerTool));
  expect(registerTool).toHaveBeenCalledTimes(1);
  const factory = registerTool.mock.calls[0]?.[0] as FeishuWikiToolFactory;
  const tool = factory({ agentAccountId: undefined });
  return { tool };
}

function makeNodes(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    node_token: `${prefix}_${i}`,
    obj_token: `obj_${prefix}_${i}`,
    obj_type: "docx",
    title: `${prefix} ${i}`,
    has_child: false,
  }));
}

describe("registerFeishuWikiTools pagination", () => {
  beforeAll(async () => {
    ({ registerFeishuWikiTools } = await import("./wiki.js"));
  });

  afterAll(() => {
    vi.doUnmock("./tool-account.js");
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveAnyEnabledFeishuToolsConfigMock.mockReturnValue({ wiki: true });
  });

  it("nodes: follows page_token across pages and aggregates all nodes (#37626)", async () => {
    const spaceNodeList = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: { items: makeNodes("a", 20), has_more: true, page_token: "page-2" },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { items: makeNodes("b", 20), has_more: false, page_token: "" },
      });
    createFeishuToolClientMock.mockReturnValue({ wiki: { spaceNode: { list: spaceNodeList } } });

    const { tool } = buildWikiTool();
    const result = await tool.execute("call-1", { action: "nodes", space_id: "space_1" });

    const details = result.details as { nodes?: unknown[] };
    expect(details.nodes).toHaveLength(40);
    expect(spaceNodeList).toHaveBeenCalledTimes(2);
    // First page sends no continuation; second forwards the prior page_token.
    expect(spaceNodeList.mock.calls[0]?.[0]?.params?.page_token).toBeUndefined();
    expect(spaceNodeList.mock.calls[1]?.[0]?.params?.page_token).toBe("page-2");
    // parent_node_token is forwarded on every page.
    expect(spaceNodeList.mock.calls[0]?.[0]?.path?.space_id).toBe("space_1");
  });

  it("nodes: single page returns without an extra request", async () => {
    const spaceNodeList = vi.fn().mockResolvedValue({
      code: 0,
      data: { items: makeNodes("a", 5), has_more: false, page_token: "" },
    });
    createFeishuToolClientMock.mockReturnValue({ wiki: { spaceNode: { list: spaceNodeList } } });

    const { tool } = buildWikiTool();
    const result = await tool.execute("call-1", { action: "nodes", space_id: "space_1" });

    expect((result.details as { nodes?: unknown[] }).nodes).toHaveLength(5);
    expect(spaceNodeList).toHaveBeenCalledTimes(1);
  });

  it("nodes: caps page count when has_more never clears", async () => {
    const spaceNodeList = vi.fn().mockResolvedValue({
      code: 0,
      data: { items: makeNodes("a", 1), has_more: true, page_token: "loop" },
    });
    createFeishuToolClientMock.mockReturnValue({ wiki: { spaceNode: { list: spaceNodeList } } });

    const { tool } = buildWikiTool();
    const result = await tool.execute("call-1", { action: "nodes", space_id: "space_1" });

    // 100-page safety cap: stop instead of spinning forever.
    expect(spaceNodeList).toHaveBeenCalledTimes(100);
    expect((result.details as { nodes?: unknown[] }).nodes).toHaveLength(100);
  });

  it("nodes: stops safely when has_more is true but page_token is missing", async () => {
    const spaceNodeList = vi.fn().mockResolvedValue({
      code: 0,
      data: { items: makeNodes("a", 3), has_more: true },
    });
    createFeishuToolClientMock.mockReturnValue({ wiki: { spaceNode: { list: spaceNodeList } } });

    const { tool } = buildWikiTool();
    const result = await tool.execute("call-1", { action: "nodes", space_id: "space_1" });

    expect(spaceNodeList).toHaveBeenCalledTimes(1);
    expect((result.details as { nodes?: unknown[] }).nodes).toHaveLength(3);
  });

  it("spaces: follows page_token across pages (sibling endpoint)", async () => {
    const spaceList = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ space_id: "s1", name: "S1" }],
          has_more: true,
          page_token: "page-2",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [{ space_id: "s2", name: "S2" }], has_more: false },
      });
    createFeishuToolClientMock.mockReturnValue({ wiki: { space: { list: spaceList } } });

    const { tool } = buildWikiTool();
    const result = await tool.execute("call-1", { action: "spaces" });

    expect((result.details as { spaces?: unknown[] }).spaces).toHaveLength(2);
    expect(spaceList).toHaveBeenCalledTimes(2);
    expect(spaceList.mock.calls[1]?.[0]?.params?.page_token).toBe("page-2");
  });
});
