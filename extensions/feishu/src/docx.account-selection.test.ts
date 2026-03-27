import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { __testing as feishuDocTesting, registerFeishuDocTools } from "./docx.js";
import { resolveFeishuToolAccount } from "./tool-account.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuToolClientMock = vi.fn((creds: { appId?: string } | undefined) => ({
  __appId: creds?.appId,
  docx: {
    documentBlock: {
      list: vi.fn(async () => ({ code: 0, data: { items: [] } })),
    },
  },
}));

// Patch SDK import so tool execution can run without network concerns.
vi.mock("@larksuiteoapi/node-sdk", () => {
  return {
    default: {},
  };
});

describe("feishu_doc account selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feishuDocTesting.setDepsForTest({
      createFeishuToolClient: ({ api, executeParams, defaultAccountId }) =>
        createFeishuToolClientMock(
          resolveFeishuToolAccount({ api, executeParams, defaultAccountId }),
        ) as never,
    });
  });

  afterEach(() => {
    feishuDocTesting.setDepsForTest(null);
  });

  function createDocEnabledConfig(): OpenClawPluginApi["config"] {
    return {
      channels: {
        feishu: {
          enabled: true,
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

    const docToolA = resolveTool("feishu_doc", { agentAccountId: "a" });
    const docToolB = resolveTool("feishu_doc", { agentAccountId: "b" });

    await docToolA.execute("call-a", { action: "list_blocks", doc_token: "d" });
    await docToolB.execute("call-b", { action: "list_blocks", doc_token: "d" });

    expect(createFeishuToolClientMock).toHaveBeenCalledTimes(2);
    expect(createFeishuToolClientMock.mock.calls[0]?.[0]?.appId).toBe("app-a");
    expect(createFeishuToolClientMock.mock.calls[1]?.[0]?.appId).toBe("app-b");
  });

  test("explicit accountId param overrides agentAccountId context", async () => {
    const cfg = createDocEnabledConfig();

    const { api, resolveTool } = createToolFactoryHarness(cfg);
    registerFeishuDocTools(api);

    const docTool = resolveTool("feishu_doc", { agentAccountId: "b" });
    await docTool.execute("call-override", {
      action: "list_blocks",
      doc_token: "d",
      accountId: "a",
    });

    expect(createFeishuToolClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-a");
  });
});
