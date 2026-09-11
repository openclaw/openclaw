// Feishu tests cover tool account routing plugin behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";
import type { FeishuToolsConfig } from "./types.js";

const createFeishuClientMock = vi.fn((account: { appId?: string } | undefined) => ({
  __appId: account?.appId,
  wiki: {
    spaceNode: {
      list: vi.fn(async () => ({
        code: 0,
        data: { items: [] },
      })),
    },
  },
}));

vi.mock("./client.js", () => ({
  createFeishuClient: (account: { appId?: string } | undefined) => createFeishuClientMock(account),
}));

let registerFeishuBitableTools: typeof import("./bitable.js").registerFeishuBitableTools;
let registerFeishuChatTools: typeof import("./chat.js").registerFeishuChatTools;
let registerFeishuDocTools: typeof import("./docx.js").registerFeishuDocTools;
let registerFeishuDriveTools: typeof import("./drive.js").registerFeishuDriveTools;
let registerFeishuPermTools: typeof import("./perm.js").registerFeishuPermTools;
let registerFeishuWikiTools: typeof import("./wiki.js").registerFeishuWikiTools;

function createConfig(params: {
  topTools?: FeishuToolsConfig;
  toolsA?: FeishuToolsConfig;
  toolsB?: FeishuToolsConfig;
  defaultAccount?: string;
  enabledA?: boolean;
}): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        defaultAccount: params.defaultAccount,
        tools: params.topTools,
        accounts: {
          a: {
            enabled: params.enabledA,
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

function clientAppIdAt(index: number): string | undefined {
  const calls = createFeishuClientMock.mock.calls;
  const resolvedIndex = index < 0 ? calls.length + index : index;
  return calls[resolvedIndex]?.[0]?.appId;
}

function lastClientAppId(): string | undefined {
  return clientAppIdAt(-1);
}

describe("feishu tool account routing", () => {
  beforeAll(async () => {
    ({ registerFeishuBitableTools, registerFeishuDriveTools, registerFeishuPermTools } =
      await import("./bitable.js").then(
        async ({ registerFeishuBitableTools: registerFeishuBitableToolsLocal }) => ({
          registerFeishuBitableTools: registerFeishuBitableToolsLocal,
          ...(await import("./drive.js")),
          ...(await import("./perm.js")),
          ...(await import("./wiki.js")),
        }),
      ));
    ({ registerFeishuWikiTools } = await import("./wiki.js"));
    ({ registerFeishuChatTools } = await import("./chat.js"));
    ({ registerFeishuDocTools } = await import("./docx.js"));
  });

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

    expect(clientAppIdAt(0)).toBe("app-b");
    expect(clientAppIdAt(1)).toBe("app-a");
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

    expect(lastClientAppId()).toBe("app-b");
  });

  test("wiki tool implicit fallback selects an account with wiki enabled", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { drive: true, wiki: false },
        toolsB: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki");
    await tool.execute("call", { action: "search" });

    expect(lastClientAppId()).toBe("app-b");
  });

  test("wiki tool prefers the active contextual account over configured defaultAccount", async () => {
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

    expect(lastClientAppId()).toBe("app-a");
  });

  test("wiki tool skips a disabled configured defaultAccount", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        defaultAccount: "a",
        enabledA: false,
        toolsA: { wiki: true },
        toolsB: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki");
    await tool.execute("call", { action: "search" });

    expect(lastClientAppId()).toBe("app-b");
  });

  test("wiki tool rejects number-typed space IDs before Lark receives precision-corrupted values", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "nodes",
      space_id: 7616123456789015000,
    });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toContain("space_id must be a string");
    expect(result.details.error).toContain("precision loss");
  });

  test("wiki tool forwards quoted numeric-looking space IDs unchanged", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "a" });
    await tool.execute("call", {
      action: "nodes",
      space_id: "7616123456789014828",
    });

    const client = createFeishuClientMock.mock.results[0]?.value;
    expect(client.wiki.spaceNode.list).toHaveBeenCalledWith({
      path: { space_id: "7616123456789014828" },
      params: { page_size: 50, page_token: undefined, parent_node_token: undefined },
    });
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

    expect(lastClientAppId()).toBe("app-b");
  });

  test("drive tool rejects a disabled contextual account when another account enables it", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { drive: false },
        toolsB: { drive: true },
      }),
    );
    registerFeishuDriveTools(api);

    const tool = resolveTool("feishu_drive", { agentAccountId: "a" });
    const result = await tool.execute("call", { action: "unknown_action" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Drive tools are disabled for account "a"');
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

    expect(lastClientAppId()).toBe("app-b");
  });

  test("perm tool rejects a disabled contextual account when another account enables it", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { perm: false },
        toolsB: { perm: true },
      }),
    );
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm", { agentAccountId: "a" });
    const result = await tool.execute("call", { action: "unknown_action" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Perm tools are disabled for account "a"');
  });

  test("perm tool rejects an explicit disabled account override", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { perm: false },
        toolsB: { perm: true },
      }),
    );
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm", { agentAccountId: "b" });
    const result = await tool.execute("call", { action: "unknown_action", accountId: "a" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Perm tools are disabled for account "a"');
  });

  test("bitable tool registers when only second account enables it and routes to agentAccountId", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { bitable: false },
        toolsB: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "b" });
    await tool.execute("call", { url: "invalid-url" });

    expect(createFeishuClientMock.mock.calls.at(-1)?.[0]?.appId).toBe("app-b");
  });

  test("bitable tool skips a disabled configured defaultAccount", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        defaultAccount: "a",
        enabledA: false,
        toolsA: { bitable: true },
        toolsB: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta");
    await tool.execute("call", { url: "invalid-url" });

    expect(lastClientAppId()).toBe("app-b");
  });

  test("bitable tool rejects a disabled contextual account when another account enables it", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { bitable: false },
        toolsB: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "a" });
    const result = await tool.execute("call", { url: "invalid-url" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Bitable tools are disabled for account "a"');
  });

  test("bitable tool rejects an explicit disabled account override", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { bitable: false },
        toolsB: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "b" });
    const result = await tool.execute("call", { url: "invalid-url", accountId: "a" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Bitable tools are disabled for account "a"');
  });

  test("bitable tool routes to agentAccountId and allows explicit accountId override", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig({}));
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_get_meta", { agentAccountId: "b" });
    await tool.execute("call-ctx", { url: "invalid-url" });
    await tool.execute("call-override", { url: "invalid-url", accountId: "a" });

    expect(clientAppIdAt(0)).toBe("app-b");
    expect(clientAppIdAt(1)).toBe("app-a");
  });

  test("bitable tools are not registered when top-level bitable config disables them", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        topTools: { bitable: false },
      }),
    );
    registerFeishuBitableTools(api);

    expect(() => resolveTool("feishu_bitable_get_meta")).toThrow("Tool not registered");
  });

  test("top-level bitable disable wins over account-level bitable enable", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        topTools: { bitable: false },
        toolsA: { bitable: true },
        toolsB: { bitable: true },
      }),
    );
    registerFeishuBitableTools(api);

    expect(() => resolveTool("feishu_bitable_get_meta")).toThrow("Tool not registered");
  });

  test("bitable tools are not registered when account bitable configs disable them", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { bitable: false },
        toolsB: { bitable: false },
      }),
    );
    registerFeishuBitableTools(api);

    expect(() => resolveTool("feishu_bitable_get_meta")).toThrow("Tool not registered");
  });

  test("falls back to the configured Feishu default selection when agentAccountId is not a real account", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { wiki: true },
        toolsB: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "agent-spawner" });
    await tool.execute("call", { action: "search" });

    expect(lastClientAppId()).toBe("app-a");
  });

  test("wiki tool rejects an explicit disabled account override", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({
        toolsA: { wiki: false },
        toolsB: { wiki: true },
      }),
    );
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "b" });
    const result = await tool.execute("call", { action: "search", accountId: "a" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Wiki tools are disabled for account "a"');
  });

  test("does not silently fall back when the contextual account is real but uses non-env SecretRefs", async () => {
    const { api, resolveTool } = createToolFactoryHarness({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            a: {
              appId: "app-a",
              appSecret: "sec-a", // pragma: allowlist secret
              tools: { wiki: true },
            },
            b: {
              appId: "app-b",
              appSecret: { source: "file", provider: "default", id: "feishu/b-secret" },
              tools: { wiki: true },
            } as never,
          },
        },
      },
    } as OpenClawPluginApi["config"]);
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki", { agentAccountId: "b" });
    const result = await tool.execute("call", { action: "search" });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(typeof result.details.error === "string" ? result.details.error : "").toContain(
      "Resolve this command against an active gateway runtime snapshot before reading it.",
    );
  });
});
