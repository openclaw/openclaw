import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, test, vi } from "vitest";
import { registerFeishuDocTools } from "./docx.js";

const createFeishuClientMock = vi.fn((creds: { appId?: string } | undefined) => ({
  __appId: creds?.appId,
}));

vi.mock("./client.js", () => {
  return {
    createFeishuClient: (creds: { appId?: string } | undefined) => createFeishuClientMock(creds),
  };
});

// Patch SDK import so tool execution can run without network concerns.
vi.mock("@larksuiteoapi/node-sdk", () => {
  return {
    default: {},
  };
});

type ToolLike = {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
};

type ToolContextLike = {
  agentAccountId?: string;
};

type ToolFactoryLike = (ctx: ToolContextLike) => ToolLike | ToolLike[] | null | undefined;

function createApi(cfg: OpenClawPluginApi["config"]) {
  const registered: Array<{
    tool: ToolLike | ToolFactoryLike;
    opts?: { name?: string };
  }> = [];

  const api: Partial<OpenClawPluginApi> = {
    config: cfg,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    registerTool: (tool, opts) => {
      registered.push({ tool, opts });
    },
  };

  const resolveTool = (name: string, ctx: ToolContextLike): ToolLike => {
    const entry = registered.find((item) => item.opts?.name === name);
    if (!entry) {
      throw new Error(`Tool not registered: ${name}`);
    }
    if (typeof entry.tool === "function") {
      const built = entry.tool(ctx);
      if (!built || Array.isArray(built)) {
        throw new Error(`Unexpected tool factory output for ${name}`);
      }
      return built as ToolLike;
    }
    return entry.tool as ToolLike;
  };

  return { api: api as OpenClawPluginApi, resolveTool };
}

describe("feishu_doc account selection", () => {
  test("uses agentAccountId context when params omit accountId", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            a: { appId: "app-a", appSecret: "sec-a", tools: { doc: true } },
            b: { appId: "app-b", appSecret: "sec-b", tools: { doc: true } },
          },
        },
      },
    } as OpenClawPluginApi["config"];

    const { api, resolveTool } = createApi(cfg);
    registerFeishuDocTools(api);

    const docToolA = resolveTool("feishu_doc", { agentAccountId: "a" });
    const docToolB = resolveTool("feishu_doc", { agentAccountId: "b" });

    await docToolA.execute("call-a", { action: "list_blocks", doc_token: "d" });
    await docToolB.execute("call-b", { action: "list_blocks", doc_token: "d" });

    expect(createFeishuClientMock).toHaveBeenCalledTimes(2);
    expect(createFeishuClientMock.mock.calls[0]?.[0]?.appId).toBe("app-a");
    expect(createFeishuClientMock.mock.calls[1]?.[0]?.appId).toBe("app-b");
  });

  test("explicit accountId param overrides agentAccountId context", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            a: { appId: "app-a", appSecret: "sec-a", tools: { doc: true } },
            b: { appId: "app-b", appSecret: "sec-b", tools: { doc: true } },
          },
        },
      },
    } as OpenClawPluginApi["config"];

    const { api, resolveTool } = createApi(cfg);
    registerFeishuDocTools(api);

    const docTool = resolveTool("feishu_doc", { agentAccountId: "b" });
    await docTool.execute("call-override", {
      action: "list_blocks",
      doc_token: "d",
      accountId: "a",
    });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-a");
  });
});
