import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
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
  function createDocEnabledConfig(defaultAccount?: string): OpenClawPluginApi["config"] {
    return {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount,
          accounts: {
            a: { appId: "app-a", appSecret: "sec-a", tools: { doc: true } }, // pragma: allowlist secret
            b: { appId: "app-b", appSecret: "sec-b", tools: { doc: true } }, // pragma: allowlist secret
          },
        },
      },
    } as OpenClawPluginApi["config"];
  }

  test("uses agentAccountId context when params omit accountId", async () => {
    const cfg = createDocEnabledConfig();

    const { api, resolveTool } = createToolFactoryHarness(cfg);
    registerFeishuDocTools(api);

    const docToolA = resolveTool("feishu_doc", { agentAccountId: "a", messageChannel: "feishu" });
    const docToolB = resolveTool("feishu_doc", { agentAccountId: "b", messageChannel: "feishu" });

    await docToolA.execute("call-a", { action: "list_blocks", doc_token: "d" });
    await docToolB.execute("call-b", { action: "list_blocks", doc_token: "d" });

    expect(createFeishuClientMock).toHaveBeenCalledTimes(2);
    expect(createFeishuClientMock.mock.calls[0]?.[0]?.appId).toBe("app-a");
    expect(createFeishuClientMock.mock.calls[1]?.[0]?.appId).toBe("app-b");
  });

  test("non-feishu channel falls back to configured defaultAccount", async () => {
    const cfg = createDocEnabledConfig("b");

    const { api, resolveTool } = createToolFactoryHarness(cfg);
    registerFeishuDocTools(api);

    const docTool = resolveTool("feishu_doc", { agentAccountId: "a", messageChannel: "slack" });
    await docTool.execute("call-non-feishu", { action: "list_blocks", doc_token: "d" });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
  });

  test("explicit accountId param overrides agentAccountId context", async () => {
    const cfg = createDocEnabledConfig();

    const { api, resolveTool } = createToolFactoryHarness(cfg);
    registerFeishuDocTools(api);

    const docTool = resolveTool("feishu_doc", { agentAccountId: "b", messageChannel: "feishu" });
    await docTool.execute("call-override", {
      action: "list_blocks",
      doc_token: "d",
      accountId: "a",
    });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-a");
  });
});
