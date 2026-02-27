import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, test, vi } from "vitest";
import { registerFeishuDocTools } from "./docx.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

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

    const { api, resolveTool } = createToolFactoryHarness(cfg);
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

    const { api, resolveTool } = createToolFactoryHarness(cfg);
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
