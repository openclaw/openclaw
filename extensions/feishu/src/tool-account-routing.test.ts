import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerFeishuBitableTools } from "./bitable.js";
import { registerFeishuChatTools } from "./chat.js";
import { registerFeishuDriveTools } from "./drive.js";
import { registerFeishuPermTools } from "./perm.js";
import { registerFeishuSheetsTools } from "./sheets.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";
import { registerFeishuWikiTools } from "./wiki.js";

const createFeishuClientMock = vi.fn((account: { appId?: string } | undefined) => ({
  __appId: account?.appId,
  im: {
    chat: { get: vi.fn(async () => ({ code: 0, data: {} })) },
    chatMembers: { get: vi.fn(async () => ({ code: 0, data: { items: [] } })) },
  },
  request: vi.fn(async ({ url }: { url: string }) => {
    if (url.includes("/values/")) {
      return { code: 0, data: { value_range: { range: "A1:B2", values: [] } } };
    }
    return {
      code: 0,
      data: {
        title: "Sheet",
        row_count: 1200,
        column_count: 26,
      },
    };
  }),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: (account: { appId?: string } | undefined) => createFeishuClientMock(account),
}));

function createConfig(params: {
  toolsA?: {
    chat?: boolean;
    wiki?: boolean;
    drive?: boolean;
    sheets?: boolean;
    perm?: boolean;
  };
  toolsB?: {
    chat?: boolean;
    wiki?: boolean;
    drive?: boolean;
    sheets?: boolean;
    perm?: boolean;
  };
  defaultAccount?: string;
}): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        defaultAccount: params.defaultAccount,
        accounts: {
          a: {
            appId: "app-a",
            appSecret: "sec-a",
            tools: params.toolsA,
          },
          b: {
            appId: "app-b",
            appSecret: "sec-b",
            tools: params.toolsB,
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

describe("feishu tool account routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("wiki tool registers when first account disables it and routes to agentAccountId", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { wiki: false },
        toolsB: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "b" });
    await tool.execute("call", { action: "search" });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
  });

  test("wiki tool prefers configured defaultAccount over inherited default account context", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        defaultAccount: "b",
        toolsA: { wiki: true },
        toolsB: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "a" });
    await tool.execute("call", { action: "search" });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
  });

  test("drive tool registers when first account disables it and routes to agentAccountId", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { drive: false },
        toolsB: { drive: true },
      }),
    );
    registerFeishuDriveTools(api);

    const tool = resolveTool("feishu_drive", { agentAccountId: "b" });
    await tool.execute("call", { action: "unknown_action" });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
  });

  test("perm tool registers when only second account enables it and routes to agentAccountId", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { perm: false },
        toolsB: { perm: true },
      }),
    );
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm", { agentAccountId: "b" });
    await tool.execute("call", { action: "unknown_action" });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
  });

  test("bitable tool routes to agentAccountId and allows explicit accountId override", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig({}));
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "b" });
    await tool.execute("call-ctx", { url: "invalid-url" });
    await tool.execute("call-override", { url: "invalid-url", accountId: "a" });

    expect(createFeishuClientMock.mock.calls[0]?.[0]?.appId).toBe("app-b");
    expect(createFeishuClientMock.mock.calls[1]?.[0]?.appId).toBe("app-a");
  });

  test("sheets tool routes to agentAccountId and allows explicit accountId override", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig({}));
    registerFeishuSheetsTools(api);

    const tool = resolveTool("feishu_sheets_read_range", { agentAccountId: "b" });
    await tool.execute("call-ctx", {
      spreadsheet_token: "ssp",
      sheet_id: "sh1",
      range: "BAD",
    });
    await tool.execute("call-override", {
      spreadsheet_token: "ssp",
      sheet_id: "sh1",
      range: "BAD",
      accountId: "a",
    });

    expect(createFeishuClientMock.mock.calls[0]?.[0]?.appId).toBe("app-b");
    expect(createFeishuClientMock.mock.calls[1]?.[0]?.appId).toBe("app-a");
  });

  test("chat tool routes to agentAccountId and allows explicit accountId override", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig({}));
    registerFeishuChatTools(api);

    const tool = resolveTool("feishu_chat", { agentAccountId: "b" });
    await tool.execute("call-ctx", {
      action: "info",
      chat_id: "oc-chat",
    });
    await tool.execute("call-override", {
      action: "info",
      chat_id: "oc-chat",
      accountId: "a",
    });

    expect(createFeishuClientMock.mock.calls[0]?.[0]?.appId).toBe("app-b");
    expect(createFeishuClientMock.mock.calls[1]?.[0]?.appId).toBe("app-a");
  });
});
