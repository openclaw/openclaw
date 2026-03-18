import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerFeishuBitableTools } from "./bitable.js";
import { registerFeishuChatTools } from "./chat.js";
import { registerFeishuDriveTools } from "./drive.js";
import { registerFeishuPermTools } from "./perm.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";
import { registerFeishuWikiTools } from "./wiki.js";

const chatGetMock = vi.fn();
const createFeishuClientMock = vi.fn((account: { appId?: string } | undefined) => ({
  __appId: account?.appId,
  im: {
    chat: { get: chatGetMock },
  },
}));

vi.mock("./client.js", () => ({
  createFeishuClient: (account: { appId?: string } | undefined) => createFeishuClientMock(account),
}));

function createConfig(params: {
  toolsA?: {
    chat?: boolean;
    wiki?: boolean;
    drive?: boolean;
    perm?: boolean;
  };
  toolsB?: {
    chat?: boolean;
    wiki?: boolean;
    drive?: boolean;
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
            appSecret: "sec-a", // pragma: allowlist secret
            tools: params.toolsA,
          },
          b: {
            appId: "app-b",
            appSecret: "sec-b", // pragma: allowlist secret
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

  test("chat tool registers when first account disables it and routes to agentAccountId", async () => {
    chatGetMock.mockResolvedValue({ code: 0, data: { name: "chat", user_count: 1 } });
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { chat: false },
        toolsB: { chat: true },
      }),
    );
    registerFeishuChatTools(api);

    const tool = resolveTool("feishu_chat", { agentAccountId: "b" });
    await tool.execute("call", { action: "info", chat_id: "oc_b" });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
  });

  test("chat tool prefers configured defaultAccount over inherited default account context", async () => {
    chatGetMock.mockResolvedValue({ code: 0, data: { name: "chat", user_count: 1 } });
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        defaultAccount: "b",
        toolsA: { chat: true },
        toolsB: { chat: true },
      }),
    );
    registerFeishuChatTools(api);

    const tool = resolveTool("feishu_chat", { agentAccountId: "a" });
    await tool.execute("call", { action: "info", chat_id: "oc_b" });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
  });

  test("chat tool blocks execution when the routed account disables chat", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { chat: true },
        toolsB: { chat: false },
      }),
    );
    registerFeishuChatTools(api);

    const tool = resolveTool("feishu_chat", { agentAccountId: "b" });
    const result = await tool.execute("call", { action: "info", chat_id: "oc_b" });

    expect(result).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          error: 'Feishu chat is disabled for account "b".',
        }),
      }),
    );
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });

  test("chat tool checks the same routed account precedence as execution", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        defaultAccount: "b",
        toolsA: { chat: true },
        toolsB: { chat: false },
      }),
    );
    registerFeishuChatTools(api);

    const tool = resolveTool("feishu_chat", { agentAccountId: "a" });
    const result = await tool.execute("call", { action: "info", chat_id: "oc_b" });

    expect(result).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          error: 'Feishu chat is disabled for account "b".',
        }),
      }),
    );
    expect(createFeishuClientMock).not.toHaveBeenCalled();
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
});
