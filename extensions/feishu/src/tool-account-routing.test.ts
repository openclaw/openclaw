import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { registerFeishuBitableTools } from "./bitable.js";
import { registerFeishuChatTools } from "./chat.js";
import { registerFeishuDocTools } from "./docx.js";
import { registerFeishuDriveTools } from "./drive.js";
import { registerFeishuPermTools } from "./perm.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";
import type { FeishuAccountConfig, FeishuToolsConfig } from "./types.js";
import { registerFeishuWikiTools } from "./wiki.js";

const createFeishuClientMock = vi.fn((account: { appId?: string } | undefined) => ({
  __appId: account?.appId,
  wiki: {
    spaceNode: {
      list: vi.fn(async () => ({ code: 0, data: { items: [] } })),
    },
  },
  drive: {
    permissionMember: {
      list: vi.fn(async () => ({
        code: 0,
        data: {
          items: [
            {
              member_type: "userid",
              member_id: "member-1",
              perm: "view",
              name: "Member One",
            },
          ],
        },
      })),
    },
  },
}));

vi.mock("./client.js", () => ({
  createFeishuClient: (account: { appId?: string } | undefined) => createFeishuClientMock(account),
}));

function makeAccount(appId: string, tools?: FeishuToolsConfig): FeishuAccountConfig {
  return { appId, appSecret: `sec-${appId}`, tools };
}

function createConfig(params: {
  topTools?: FeishuToolsConfig;
  toolsA?: FeishuToolsConfig;
  toolsB?: FeishuToolsConfig;
  defaultAccount?: string;
  accounts?: Record<string, FeishuAccountConfig>;
}): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        defaultAccount: params.defaultAccount,
        tools: params.topTools,
        accounts: params.accounts ?? {
          a: makeAccount("app-a", params.toolsA),
          b: makeAccount("app-b", params.toolsB),
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

function createPunctuationConfig(params: {
  topTools?: FeishuToolsConfig;
  toolsSales: FeishuToolsConfig;
  salesEnabled?: boolean;
}): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        appId: "app-root",
        appSecret: "sec-root", // pragma: allowlist secret
        tools: params.topTools,
        accounts: {
          "sales.eu": {
            enabled: params.salesEnabled ?? true,
            appId: "app-sales",
            appSecret: "sec-sales", // pragma: allowlist secret
            tools: params.toolsSales,
          },
          sibling: {
            appId: "app-sibling",
            appSecret: "sec-sibling", // pragma: allowlist secret
            tools: { perm: true },
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

function resolveAccountTool(
  family: "wiki" | "drive" | "perm" | "bitable",
  config: Parameters<typeof createConfig>[0],
  agentAccountId?: string,
) {
  const { api, resolveTool } = createToolFactoryHarness(createConfig(config));
  const register = {
    wiki: registerFeishuWikiTools,
    drive: registerFeishuDriveTools,
    perm: registerFeishuPermTools,
    bitable: registerFeishuBitableTools,
  }[family];
  register(api);
  return resolveTool(family === "bitable" ? "feishu_bitable_get_meta" : `feishu_${family}`, {
    agentAccountId,
  });
}

function clientAppIdAt(index = -1): string | undefined {
  return createFeishuClientMock.mock.calls.at(index)?.[0]?.appId;
}

describe("feishu tool account routing", () => {
  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each([
    ["doc", "feishu_doc"],
    ["scopes", "feishu_app_scopes"],
    ["chat", "feishu_chat"],
    ["wiki", "feishu_wiki"],
    ["drive", "feishu_drive"],
    ["perm", "feishu_perm"],
    ["bitable", "feishu_bitable_get_meta"],
  ] as const)("uses current factory config for %s availability", (family, name) => {
    const disabled = createConfig({ topTools: { [family]: false } });
    const enabled = createConfig({ topTools: { [family]: true } });
    const { api, resolveTool } = createToolFactoryHarness(disabled);
    for (const register of [
      registerFeishuDocTools,
      registerFeishuChatTools,
      registerFeishuWikiTools,
      registerFeishuDriveTools,
      registerFeishuPermTools,
      registerFeishuBitableTools,
    ]) {
      register(api);
    }

    expect(() => resolveTool(name)).toThrow("Tool not registered");
    expect(resolveTool(name, { config: disabled, runtimeConfig: enabled }).name).toBe(name);
    expect(() => resolveTool(name, { config: enabled, runtimeConfig: disabled })).toThrow(
      "Tool not registered",
    );
    expect(resolveTool(name, { config: enabled }).name).toBe(name);
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });

  test("uses the factory config for account selection without changing older tools", async () => {
    const original = createConfig({ defaultAccount: "a" });
    const current = createConfig({ defaultAccount: "b" });
    const { api, resolveTool } = createToolFactoryHarness(original);
    registerFeishuWikiTools(api);
    const previousTool = resolveTool("feishu_wiki");
    const currentTool = resolveTool("feishu_wiki", { config: original, runtimeConfig: current });

    await currentTool.execute("current", { action: "search" });
    await previousTool.execute("previous", { action: "search" });

    expect([clientAppIdAt(0), clientAppIdAt(1)]).toEqual(["app-b", "app-a"]);
  });

  test.each([
    ["missing channel", {}],
    ["unconfigured account", { channels: { feishu: { accounts: { a: { enabled: true } } } } }],
    [
      "disabled channel",
      { channels: { feishu: { ...createConfig({}).channels?.feishu, enabled: false } } },
    ],
    [
      "disabled accounts",
      {
        channels: {
          feishu: {
            accounts: {
              a: { enabled: false, appId: "app-a", appSecret: "sec-a" }, // pragma: allowlist secret
            },
          },
        },
      },
    ],
  ])("does not expose workplace tools for %s", (_label, config) => {
    const { api, resolveTool } = createToolFactoryHarness(config);
    for (const register of [
      registerFeishuDocTools,
      registerFeishuChatTools,
      registerFeishuWikiTools,
      registerFeishuDriveTools,
      registerFeishuPermTools,
      registerFeishuBitableTools,
    ]) {
      register(api);
    }
    for (const name of [
      "feishu_doc",
      "feishu_app_scopes",
      "feishu_chat",
      "feishu_wiki",
      "feishu_drive",
      "feishu_perm",
      "feishu_bitable_get_meta",
    ]) {
      expect(() => resolveTool(name)).toThrow("Tool not registered");
    }
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });

  test("wiki tool rejects a mixed-case contextual account before sibling fallback", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        accounts: {
          Ops: makeAccount("app-ops", { wiki: false }),
          admin: makeAccount("app-admin", { wiki: true }),
        },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "ops" });
    const result = await tool.execute("call", { action: "search" });

    expect(result.details.error).toBe('Feishu Wiki tools are disabled for account "ops"');
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });

  test("wiki tool routes a mixed-case enabled contextual account without sibling fallback", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        accounts: {
          Ops: makeAccount("app-ops", { wiki: true }),
          admin: makeAccount("app-admin", { wiki: true }),
        },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "ops" });
    await tool.execute("call", { action: "search" });

    expect(clientAppIdAt()).toBe("app-ops");
  });

  test("wiki tool implicit fallback selects an account with wiki enabled", async () => {
    const tool = resolveAccountTool("wiki", {
      toolsA: { drive: true, wiki: false },
      toolsB: { wiki: true },
    });
    await tool.execute("call", { action: "search" });

    expect(clientAppIdAt()).toBe("app-b");
  });

  test("wiki tool prefers the active contextual account over configured defaultAccount", async () => {
    const tool = resolveAccountTool(
      "wiki",
      {
        defaultAccount: "b",
        toolsA: { wiki: true },
        toolsB: { wiki: true },
      },
      "a",
    );
    await tool.execute("call", { action: "search" });

    expect(clientAppIdAt()).toBe("app-a");
  });

  test("wiki tool rejects number-typed space IDs before Lark receives precision-corrupted values", async () => {
    const tool = resolveAccountTool("wiki", { toolsA: { wiki: true } }, "a");
    const result = await tool.execute("call", { action: "nodes", space_id: 7616123456789015000 });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toContain("space_id must be a string");
    expect(result.details.error).toContain("precision loss");
  });

  test("wiki tool forwards quoted numeric-looking space IDs unchanged", async () => {
    const tool = resolveAccountTool("wiki", { toolsA: { wiki: true } }, "a");
    await tool.execute("call", { action: "nodes", space_id: "7616123456789014828" });

    const client = createFeishuClientMock.mock.results[0]?.value;
    expect(client.wiki.spaceNode.list).toHaveBeenCalledWith({
      path: { space_id: "7616123456789014828" },
      params: { page_size: 50, page_token: undefined, parent_node_token: undefined },
    });
  });

  test("drive tool registers when first account disables it and routes to agentAccountId", async () => {
    const config = { toolsA: { drive: false }, toolsB: { drive: true } };
    const tool = resolveAccountTool("drive", config, "b");
    await tool.execute("call", { action: "unknown_action" });

    expect(clientAppIdAt()).toBe("app-b");
  });

  test("drive tool rejects a disabled contextual account when another account enables it", async () => {
    const tool = resolveAccountTool(
      "drive",
      {
        toolsA: { drive: false },
        toolsB: { drive: true },
      },
      "a",
    );
    const result = await tool.execute("call", { action: "unknown_action" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Drive tools are disabled for account "a"');
  });

  test("perm tool registers when only second account enables it and routes to agentAccountId", async () => {
    const config = { toolsA: { perm: false }, toolsB: { perm: true } };
    const tool = resolveAccountTool("perm", config, "b");
    await tool.execute("call", { action: "unknown_action" });

    expect(clientAppIdAt()).toBe("app-b");
  });

  test("perm tool rejects a disabled contextual account when another account enables it", async () => {
    const tool = resolveAccountTool(
      "perm",
      {
        toolsA: { perm: false },
        toolsB: { perm: true },
      },
      "a",
    );
    const result = await tool.execute("call", { action: "unknown_action" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Perm tools are disabled for account "a"');
  });

  test("perm tool rejects a punctuation-key contextual account before sibling fallback", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createPunctuationConfig({ topTools: { perm: true }, toolsSales: { perm: false } }),
    );
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm", { agentAccountId: "sales-eu" });
    const result = await tool.execute("call", { action: "list", token: "tok", type: "file" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Perm tools are disabled for account "sales-eu"');
  });

  test("perm tool routes a punctuation-key contextual account with its own credentials", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createPunctuationConfig({ topTools: { perm: true }, toolsSales: { perm: true } }),
    );
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm", { agentAccountId: "sales-eu" });
    const result = await tool.execute("call", { action: "list", token: "tok", type: "file" });

    expect(clientAppIdAt(0)).toBe("app-sales");
    expect(clientAppIdAt(0)).not.toBe("app-root");
    expect(result.details).toEqual({
      members: [
        {
          member_type: "userid",
          member_id: "member-1",
          perm: "view",
          name: "Member One",
        },
      ],
    });
  });

  test("perm tool rejects an explicit alias for a punctuation-key disabled family", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createPunctuationConfig({ topTools: { perm: true }, toolsSales: { perm: false } }),
    );
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm", { agentAccountId: "sibling" });
    const result = await tool.execute("call", {
      action: "list",
      token: "tok",
      type: "file",
      accountId: "sales.eu",
    });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Perm tools are disabled for account "sales-eu"');
  });

  test("perm tool rejects an explicit alias for a disabled punctuation-key account", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createPunctuationConfig({
        topTools: { perm: true },
        toolsSales: { perm: true },
        salesEnabled: false,
      }),
    );
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm", { agentAccountId: "sibling" });
    const result = await tool.execute("call", {
      action: "list",
      token: "tok",
      type: "file",
      accountId: "sales.eu",
    });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu account "sales.eu" is disabled');
  });

  test("bitable tool rejects a disabled contextual account when another account enables it", async () => {
    const tool = resolveAccountTool(
      "bitable",
      {
        toolsA: { bitable: false },
        toolsB: { bitable: true },
      },
      "a",
    );
    const result = await tool.execute("call", { url: "invalid-url" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Bitable tools are disabled for account "a"');
  });

  test("bitable tool routes to agentAccountId and allows explicit accountId override", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig({}));
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "b" });
    await tool.execute("call-ctx", { url: "invalid-url" });
    await tool.execute("call-override", { url: "invalid-url", accountId: "a" });

    expect([clientAppIdAt(0), clientAppIdAt(1)]).toEqual(["app-b", "app-a"]);
  });

  test("top-level bitable disable wins over account-level bitable enable", async () => {
    expect(() =>
      resolveAccountTool("bitable", {
        topTools: { bitable: false },
        toolsA: { bitable: true },
        toolsB: { bitable: true },
      }),
    ).toThrow("Tool not registered");
  });

  test("bitable tools are not registered when account bitable configs disable them", async () => {
    expect(() =>
      resolveAccountTool("bitable", {
        toolsA: { bitable: false },
        toolsB: { bitable: false },
      }),
    ).toThrow("Tool not registered");
  });

  test("falls back to the configured Feishu default selection when agentAccountId is not a real account", async () => {
    const tool = resolveAccountTool(
      "wiki",
      { toolsA: { wiki: true }, toolsB: { wiki: true } },
      "agent-spawner",
    );
    await tool.execute("call", { action: "search" });

    expect(clientAppIdAt()).toBe("app-a");
  });

  test("wiki tool rejects an explicit disabled account override", async () => {
    const tool = resolveAccountTool(
      "wiki",
      { toolsA: { wiki: false }, toolsB: { wiki: true } },
      "b",
    );
    const result = await tool.execute("call", { action: "search", accountId: "a" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Wiki tools are disabled for account "a"');
  });

  test("does not silently fall back when the contextual account is real but uses non-env SecretRefs", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        accounts: {
          a: makeAccount("app-a", { wiki: true }),
          b: {
            ...makeAccount("app-b", { wiki: true }),
            appSecret: { source: "file", provider: "default", id: "feishu/b-secret" },
          },
        },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "b" });
    const result = await tool.execute("call", { action: "search" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(typeof result.details.error === "string" ? result.details.error : "").toContain(
      "Resolve this command against an active gateway runtime snapshot before reading it.",
    );
  });
});
