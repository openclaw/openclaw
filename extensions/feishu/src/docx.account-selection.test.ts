import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { registerFeishuDocTools } from "./docx.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.fn((creds: { appId?: string } | undefined) => ({
  __appId: creds?.appId,
}));

// mock-isolation: Account selection inspects client identity without creating an SDK transport.
vi.mock("./client.js", () => ({
  createFeishuClient: (creds: { appId?: string } | undefined) => createFeishuClientMock(creds),
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({ default: {} }));

describe("feishu_doc account selection", () => {
  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setup(mixed = false) {
    const account = (id: string, enabled: boolean) => ({
      appId: `app-${id}`,
      appSecret: `sec-${id}`, // pragma: allowlist secret
      tools: mixed ? { doc: enabled, scopes: enabled } : { doc: enabled },
    });
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            a: account("a", !mixed),
            b: account("b", true),
          },
        },
      },
    } as OpenClawPluginApi["config"];
    const { api, resolveTool } = createToolFactoryHarness(cfg);
    registerFeishuDocTools(api);
    return resolveTool;
  }

  test("uses agentAccountId context when params omit accountId", async () => {
    const resolveTool = setup();
    const docToolA = resolveTool("feishu_doc", { agentAccountId: "a" });
    const docToolB = resolveTool("feishu_doc", { agentAccountId: "b" });

    await docToolA.execute("call-a", { action: "list_blocks", doc_token: "d" });
    await docToolB.execute("call-b", { action: "list_blocks", doc_token: "d" });

    expect(createFeishuClientMock.mock.calls.map(([account]) => account?.appId)).toEqual([
      "app-a",
      "app-b",
    ]);
  });

  test("explicit accountId param overrides agentAccountId context", async () => {
    const resolveTool = setup();
    const docTool = resolveTool("feishu_doc", { agentAccountId: "b" });
    await docTool.execute("call-override", {
      action: "list_blocks",
      doc_token: "d",
      accountId: "a",
    });

    expect(createFeishuClientMock.mock.lastCall?.[0]?.appId).toBe("app-a");
  });

  test.each([
    { source: "context", agentAccountId: "a", params: {} },
    { source: "override", agentAccountId: "b", params: { accountId: "a" } },
  ])(
    "rejects a disabled $source account when another account enables docs",
    async ({ agentAccountId, params }) => {
      const resolveTool = setup(true);
      const docTool = resolveTool("feishu_doc", { agentAccountId });
      const result = await docTool.execute("call-disabled", {
        action: "list_blocks",
        doc_token: "d",
        ...params,
      });

      expect(createFeishuClientMock).not.toHaveBeenCalled();
      expect(result.details.error).toBe('Feishu Doc tools are disabled for account "a"');
    },
  );

  test("rejects a disabled contextual account when another account enables app scopes", async () => {
    const resolveTool = setup(true);
    const scopesTool = resolveTool("feishu_app_scopes", { agentAccountId: "a" });
    const result = await scopesTool.execute("call-disabled", {});

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu App Scopes tools are disabled for account "a"');
  });
});
