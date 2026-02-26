import { describe, expect, test, vi } from "vitest";

const createFeishuClientMock = vi.fn((creds: any) => ({ __appId: creds?.appId }));

vi.mock("./client.js", () => {
  return {
    createFeishuClient: (creds: any) => createFeishuClientMock(creds),
  };
});

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerFeishuDocTools } from "./docx.js";

// Patch the specific API calls we need so tool execution doesn't hit network.
vi.mock("@larksuiteoapi/node-sdk", () => {
  return {
    default: {},
  };
});

function fakeApi(cfg: any) {
  const tools: Array<{ name: string; execute: (id: string, params: any) => any }> = [];
  const api: Partial<OpenClawPluginApi> = {
    config: cfg,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    registerTool: (tool: any) => {
      tools.push({ name: tool.name, execute: tool.execute });
      return undefined as any;
    },
  };
  return { api: api as OpenClawPluginApi, tools };
}

describe("feishu_doc account selection", () => {
  test("uses accountId param to pick correct account when multiple accounts configured", async () => {
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
    };

    const { api, tools } = fakeApi(cfg);
    registerFeishuDocTools(api);

    const tool = tools.find((t) => t.name === "feishu_doc");
    expect(tool).toBeTruthy();

    // Trigger a lightweight action (list_blocks) that will immediately attempt client creation.
    // It will still fail later due to missing SDK mocks, but we only care which account's creds were used.
    await tool!.execute("call-a", { action: "list_blocks", doc_token: "d", accountId: "a" });
    await tool!.execute("call-b", { action: "list_blocks", doc_token: "d", accountId: "b" });

    expect(createFeishuClientMock).toHaveBeenCalledTimes(2);
    expect(createFeishuClientMock.mock.calls[0]?.[0]?.appId).toBe("app-a");
    expect(createFeishuClientMock.mock.calls[1]?.[0]?.appId).toBe("app-b");
  });

  test("single-account setup still registers tool and uses that account", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            default: { appId: "app-d", appSecret: "sec-d", tools: { doc: true } },
          },
        },
      },
    };

    const { api, tools } = fakeApi(cfg);
    registerFeishuDocTools(api);

    const tool = tools.find((t) => t.name === "feishu_doc");
    expect(tool).toBeTruthy();

    await tool!.execute("call-d", { action: "list_blocks", doc_token: "d" });
    expect(createFeishuClientMock).toHaveBeenCalled();
    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-d");
  });
});
