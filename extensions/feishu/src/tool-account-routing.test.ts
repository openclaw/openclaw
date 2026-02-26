import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerFeishuBitableTools } from "./bitable.js";
import { registerFeishuDriveTools } from "./drive.js";
import { registerFeishuPermTools } from "./perm.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";
import { registerFeishuWikiTools } from "./wiki.js";

const createFeishuClientMock = vi.fn((account: { appId?: string } | undefined) => ({
  __appId: account?.appId,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: (account: { appId?: string } | undefined) => createFeishuClientMock(account),
}));

function createConfig(params: {
  toolsA?: {
    wiki?: boolean;
    drive?: boolean;
    perm?: boolean;
  };
  toolsB?: {
    wiki?: boolean;
    drive?: boolean;
    perm?: boolean;
  };
}): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
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
});
