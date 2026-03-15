import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
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
  defaultAccount?: string;
  autoBindAgentAccount?: boolean;
  bindings?: Array<{ agentId: string; match: { channel: string; accountId?: string } }>;
}): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        defaultAccount: params.defaultAccount,
        autoBindAgentAccount: params.autoBindAgentAccount,
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
    bindings: params.bindings,
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

  describe("agent binding (via agentId + bindings)", () => {
    test("wiki tool routes to agent binding account when binding exists", async () => {
      const { api, resolveTool } = createToolFactoryHarness(
        createConfig({
          toolsA: { wiki: true },
          toolsB: { wiki: true },
          autoBindAgentAccount: true,
          bindings: [
            {
              agentId: "agent-work",
              match: { channel: "feishu", accountId: "b" },
            },
          ],
        }),
      );
      registerFeishuWikiTools(api);

      const tool = resolveTool("feishu_wiki", { agentId: "agent-work" });
      await tool.execute("call", { action: "search" });

      expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
    });

    test("drive tool uses defaultAccount when agent has no binding", async () => {
      const { api, resolveTool } = createToolFactoryHarness(
        createConfig({
          toolsA: { drive: true },
          toolsB: { drive: true },
          defaultAccount: "a",
          autoBindAgentAccount: true,
          bindings: [
            {
              agentId: "agent-work",
              match: { channel: "feishu", accountId: "b" },
            },
          ],
        }),
      );
      registerFeishuDriveTools(api);

      const tool = resolveTool("feishu_drive", { agentId: "agent-other" }); // No binding for this agent
      await tool.execute("call", { action: "unknown_action" });

      expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-a");
    });

    test("perm tool ignores binding when autoBindAgentAccount is false", async () => {
      const { api, resolveTool } = createToolFactoryHarness(
        createConfig({
          toolsA: { perm: true },
          toolsB: { perm: true },
          defaultAccount: "a",
          autoBindAgentAccount: false,
          bindings: [
            {
              agentId: "agent-work",
              match: { channel: "feishu", accountId: "b" },
            },
          ],
        }),
      );
      registerFeishuPermTools(api);

      const tool = resolveTool("feishu_perm", { agentId: "agent-work" });
      await tool.execute("call", { action: "unknown_action" });

      // Should use defaultAccount since autoBindAgentAccount is false
      expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-a");
    });

    test("bitable tool respects explicit accountId override over binding", async () => {
      const { api, resolveTool } = createToolFactoryHarness(
        createConfig({
          autoBindAgentAccount: true,
          bindings: [
            {
              agentId: "agent-work",
              match: { channel: "feishu", accountId: "b" },
            },
          ],
        }),
      );
      registerFeishuBitableTools(api);

      const tool = resolveTool("feishu_bitable_get_meta", { agentId: "agent-work" });
      // First call uses binding
      await tool.execute("call-binding", { url: "invalid-url" });
      // Second call overrides with explicit accountId
      await tool.execute("call-override", { url: "invalid-url", accountId: "a" });

      expect(createFeishuClientMock.mock.calls[0]?.[0]?.appId).toBe("app-b");
      expect(createFeishuClientMock.mock.calls[1]?.[0]?.appId).toBe("app-a");
    });

    test("wiki tool prefers binding over defaultAccount", async () => {
      const { api, resolveTool } = createToolFactoryHarness(
        createConfig({
          toolsA: { wiki: true },
          toolsB: { wiki: true },
          defaultAccount: "a",
          autoBindAgentAccount: true,
          bindings: [
            {
              agentId: "agent-work",
              match: { channel: "feishu", accountId: "b" },
            },
          ],
        }),
      );
      registerFeishuWikiTools(api);

      const tool = resolveTool("feishu_wiki", { agentId: "agent-work" });
      await tool.execute("call", { action: "search" });

      expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
    });
  });
});
