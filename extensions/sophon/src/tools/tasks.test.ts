import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";

const { getSupabaseMock } = vi.hoisted(() => ({
  getSupabaseMock: vi.fn(),
}));

vi.mock("../lib/supabase.js", () => ({
  getSupabase: getSupabaseMock,
}));

import { registerTaskTools } from "./tasks.js";

function createApi() {
  const tools: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }> = [];

  const api = {
    id: "sophon",
    name: "sophon",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: { version: "test" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool(tool: (typeof tools)[number]) {
      tools.push(tool);
    },
  } as unknown as OpenClawPluginApi;

  return { api, tools };
}

describe("sophon task tools", () => {
  beforeEach(() => {
    getSupabaseMock.mockReset();
  });

  it("list tool applies filters and returns rows", async () => {
    const { api, tools } = createApi();
    registerTaskTools(api);

    const resultPayload = { data: [{ id: "task-1" }], error: null };
    const query: {
      select: ReturnType<typeof vi.fn>;
      is: ReturnType<typeof vi.fn>;
      order: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
      lte: ReturnType<typeof vi.fn>;
      gte: ReturnType<typeof vi.fn>;
      then: (onfulfilled: (value: typeof resultPayload) => unknown) => unknown;
    } = {
      select: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      then(onfulfilled) {
        return Promise.resolve(onfulfilled(resultPayload));
      },
    };
    const from = vi.fn().mockReturnValue(query);
    getSupabaseMock.mockResolvedValue({ from });

    const tool = tools.find((entry) => entry.name === "sophon_list_tasks");
    if (!tool) throw new Error("sophon_list_tasks not registered");

    const result = await tool.execute("call", {
      status: "backlog",
      priority: "p2",
      limit: 5,
    });

    expect(from).toHaveBeenCalledWith("tasks");
    expect(query.eq).toHaveBeenCalledWith("status_label", "backlog");
    expect(query.eq).toHaveBeenCalledWith("priority_level", "p2");
    expect(query.limit).toHaveBeenCalledWith(5);
    expect((result as { details: unknown }).details).toEqual([{ id: "task-1" }]);
  });

  it("create tool sets sensible defaults", async () => {
    const { api, tools } = createApi();
    registerTaskTools(api);

    const single = vi.fn().mockResolvedValue({ data: { id: "task-2" }, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert });
    getSupabaseMock.mockResolvedValue({ from });

    const tool = tools.find((entry) => entry.name === "sophon_create_task");
    if (!tool) throw new Error("sophon_create_task not registered");

    const result = await tool.execute("call", {
      title: "Ship plugin",
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Ship plugin",
        status_label: "backlog",
        priority_level: "p3",
        top_level_category: "Uncategorized",
      }),
    );
    expect((result as { details: unknown }).details).toEqual({ id: "task-2" });
  });
});
