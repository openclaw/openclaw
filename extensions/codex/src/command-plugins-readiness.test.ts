import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "./app-server/app-inventory-cache.js";
import type { CodexAppsInstalledParams } from "./app-server/protocol-control-plane.js";
import type { v2 } from "./app-server/protocol.js";
import { CodexAppServerRpcError } from "./app-server/rpc-error.js";
import { createCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import { handleCodexSubcommand } from "./command-handlers.js";
import { createCodexCommandHost } from "./command-host.test-support.js";
import type { CodexPluginsManagementIO } from "./command-plugin-config.js";
import { handleCodexPluginsSubcommand } from "./command-plugins-management.js";
import { fakeCtx } from "./command-plugins-management.test-support.js";
import type { CodexPluginCommandContext } from "./command-plugins-runtime.js";
import * as commandRuntime from "./command-plugins-runtime.js";

const appUrl = "https://chatgpt.com/apps/app-0";
const privateError = "private upstream response";

const ctx: PluginCommandContext = {
  ...fakeCtx,
  commandBody: "/codex plugins status notes@company-tools",
};

const readOnlyCalls: Array<() => unknown> = [];

afterEach(() => {
  try {
    for (const call of readOnlyCalls.splice(0)) {
      expect(call).not.toHaveBeenCalled();
    }
  } finally {
    defaultCodexAppInventoryCache.clear();
    vi.restoreAllMocks();
  }
});

function hostCommand(input: Partial<PluginCommandContext>) {
  return handleCodexSubcommand(
    { ...ctx, ...input },
    { deps: createCodexCommandHost({ bindingStore: createCodexTestBindingStore() }) },
  );
}

async function refreshHostedApps(context: CodexPluginCommandContext) {
  vi.spyOn(commandRuntime, "withCodexPluginCommandContext").mockImplementation(
    async (_params, run) => await run(context),
  );
  return hostCommand({ args: "plugins refresh", commandBody: "/codex plugins refresh" });
}

function fixture(
  options: {
    threadId?: string | null;
    appCount?: number;
    otherApp?: boolean;
    disabled?: boolean;
    runtime?: v2.InstalledApp[];
    failMethod?: string;
    unsupported?: boolean;
    refreshError?: Error;
    refreshedRuntime?: v2.InstalledApp[];
    accountType?: "chatgpt" | "apiKey";
    appsFeature?: boolean;
    detailPolicy?: Partial<v2.PluginSummary>;
    catalog?: { marketplace: string; kind: string };
  } = {},
) {
  const pluginName = "notes";
  const current = {
    enabled: true,
    plugins: {
      notes: {
        marketplaceName: options.catalog?.marketplace ?? "company-tools",
        pluginName: options.catalog ? `${pluginName}@${options.catalog.marketplace}` : pluginName,
        enabled: !options.disabled,
      },
    },
  };
  const summary: v2.PluginSummary = {
    id: `${pluginName}@${options.catalog?.marketplace ?? "company-tools"}`,
    name: "Notes",
    installed: true,
    enabled: true,
    availability: "AVAILABLE",
    installPolicy: "AVAILABLE",
    ...(options.catalog ? { remotePluginId: "plugins~Plugin_test_notes" } : {}),
  };
  const apps: v2.AppSummary[] = Array.from({ length: options.appCount ?? 1 }, (_, index) => ({
    id: `app-${index}`,
    name: `App ${index}`,
    description: null,
    category: null,
    installUrl: `https://chatgpt.com/apps/app-${index}`,
  }));
  const inventoryApps = options.otherApp
    ? [...apps, { ...apps[0]!, id: "other-app", name: "Other plugin app" }]
    : apps;
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === options.failMethod) {
      if (options.unsupported) {
        throw new CodexAppServerRpcError({ code: -32601, message: privateError }, method);
      }
      throw new Error(privateError);
    }
    switch (method) {
      case "account/read":
        return {
          account: {
            type: options.accountType ?? "chatgpt",
            email: "operator@example.test",
            planType: "team",
          },
        };
      case "experimentalFeature/list":
        return { data: [{ name: "apps", enabled: options.appsFeature ?? true }], nextCursor: null };
      case "plugin/installed":
        return {
          marketplaces: options.catalog
            ? []
            : [{ name: "company-tools", path: "/test/catalog", plugins: [summary] }],
          marketplaceLoadErrors: [],
        };
      case "plugin/list": {
        const requested = params as v2.PluginListParams;
        const includesCatalog =
          options.catalog?.kind === "curated"
            ? !requested.marketplaceKinds
            : requested.marketplaceKinds?.some((kind) => kind === options.catalog?.kind);
        return {
          marketplaces: includesCatalog
            ? [{ name: options.catalog?.marketplace, plugins: [summary] }]
            : [],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        };
      }
      case "plugin/read":
        return {
          plugin: { summary: { ...summary, ...options.detailPolicy }, apps, mcpServers: [] },
        };
      case "app/installed":
        if ((params as CodexAppsInstalledParams).forceRefresh && options.refreshError) {
          throw options.refreshError;
        }
        return {
          apps:
            ((params as CodexAppsInstalledParams).forceRefresh
              ? options.refreshedRuntime
              : undefined) ??
            options.runtime ??
            inventoryApps.map((app) => ({
              id: app.id,
              runtimeName: app.name,
              enabled: true,
              callable: true,
            })),
        };
      case "app/read":
        return {
          apps: inventoryApps.filter((app) =>
            (params as { appIds: string[] }).appIds.includes(app.id),
          ),
          missingAppIds: [],
        };
      default:
        throw new Error(`Unexpected method: ${method}`);
    }
  });
  const io: CodexPluginsManagementIO = {
    readConfig: vi.fn(async () => structuredClone(current)),
    mutate: vi.fn(),
  };
  const context: CodexPluginCommandContext = {
    request: async <T>(method: string, params?: unknown): Promise<T> =>
      (await request(method, params)) as T,
    workspaceDir: "/workspace/agent-a",
    agentId: "agent-a",
    profileId: "openai:work",
    ...(options.threadId !== null ? { threadId: options.threadId ?? "thread-a" } : {}),
    appCacheKey: "agent-a-only",
    current,
    validateCurrent: vi.fn(async () => {}),
  };
  const runtime = {
    workspaceDir: vi.fn(async () => context.workspaceDir),
    list: vi.fn(),
    install: vi.fn(),
    refresh: vi.fn(),
    withContext: async <T>(run: (value: CodexPluginCommandContext) => Promise<T>): Promise<T> =>
      run(context),
  };
  readOnlyCalls.push(io.mutate, runtime.install);
  return {
    io,
    context,
    current,
    runtime,
    request,
    status: (
      args = [`${pluginName}@${options.catalog?.marketplace ?? "company-tools"}`],
      input = ctx,
    ) => handleCodexPluginsSubcommand(input, ["status", ...args], io, runtime),
  };
}

describe("Codex plugin status command", () => {
  it("requires a valid page for a qualified plugin identity", async () => {
    const test = fixture();
    const result = await test.status(["notes@company-tools", "0"]);
    expect(result.text).toContain("Usage: /codex plugins status <name>@<marketplace> [page]");
    expect(result.text).toContain("/codex plugins list");
    expect(result.presentation).toBeUndefined();
    expect(test.io.readConfig).not.toHaveBeenCalled();
    expect(test.request).not.toHaveBeenCalled();
  });

  it.each([
    [{ accountType: "apiKey" }, ["ChatGPT sign-in"], [appUrl]],
    [{ appsFeature: false }, ["disabled in this Codex runtime"], [appUrl]],
    [
      { detailPolicy: { availability: "DISABLED_BY_ADMIN", installPolicy: "NOT_AVAILABLE" } },
      ["marketplace"],
      [appUrl],
    ],
    [
      { disabled: true },
      [
        "OpenClaw app access: disabled",
        "/codex plugins enable notes@company-tools",
        "enabled: true; callable: true",
        appUrl,
      ],
      [],
    ],
    [
      { appCount: 0 },
      ["No hosted apps declared"],
      ["Connection:", "in your browser", "https://chatgpt.com"],
    ],
    [
      { failMethod: "app/installed", unsupported: true },
      ["does not support the required status method", "supported Codex version"],
      [privateError],
    ],
    [
      { threadId: null },
      ["Runtime scope: account (no bound Codex thread)", "Bundle: installed"],
      [privateError],
    ],
    [
      { failMethod: "app/installed" },
      ["runtime flags unavailable", "Bundle: installed"],
      ["enabled: false", "callable: false", privateError],
    ],
  ] satisfies Array<[Parameters<typeof fixture>[0], string[], string[]]>)(
    "renders status for %j without granting app access",
    async (options, included, excluded) => {
      const { text } = await fixture(options).status();
      for (const value of included) {
        expect(text).toContain(value);
      }
      for (const value of excluded) {
        expect(text).not.toContain(value);
      }
    },
  );

  it("discovers a configured supplemental marketplace through its catalog kind", async () => {
    const catalog = { marketplace: "workspace-directory", kind: "workspace-directory" };
    const test = fixture({ catalog });
    const result = await test.status();
    expect(result.text).toContain("enabled: true; callable: true");
    expect(test.request).toHaveBeenCalledWith("plugin/read", {
      remoteMarketplaceName: catalog.marketplace,
      pluginName: "plugins~Plugin_test_notes",
    });
  });

  it("paginates every owned app through the real command without exposing unrelated inventory", async () => {
    const test = fixture({
      appCount: 7,
      runtime: [
        { id: "another-agent-app", runtimeName: "Private app", enabled: true, callable: true },
      ],
    });
    const first = await test.status();
    const next = await test.status(["notes@company-tools", "2"]);
    expect(first.text).toContain("page 1/2");
    expect(first.text).not.toContain("Open App 5 in ChatGPT");
    expect(first.presentation?.blocks).toContainEqual({
      type: "buttons",
      buttons: [
        {
          label: "More apps",
          action: { type: "command", command: "/codex plugins status notes@company-tools 2" },
        },
      ],
    });
    expect(next.text).toContain("Open App 6 in ChatGPT");
    expect(next.text).not.toContain("Private app");
    expect(first.text).not.toContain("another-agent-app");
  });

  it("resolves generated continuation commands for notes in openai-curated-remote", async () => {
    const test = fixture({
      appCount: 7,
      catalog: { marketplace: "openai-curated-remote", kind: "curated" },
    });
    test.current.plugins.notes.marketplaceName = "openai-curated";
    const first = await test.status();
    const continuation = first.presentation?.blocks
      .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
      .find((button) => button.label === "More apps");
    if (continuation?.action?.type !== "command") {
      throw new Error("Expected the first status page to provide a More apps command");
    }
    const next = await test.status(continuation.action.command.split(" ").slice(3));
    expect(next.text).toContain("Apps (page 2/2)");
    expect(next.text).toContain("Open App 6 in ChatGPT");
  });

  it("checks owner authority before reading profile-scoped inventory", async () => {
    const test = fixture();
    const result = await test.status(undefined, { ...ctx, senderIsOwner: false });
    expect(result.text).toContain("Only an owner or operator.admin");
    expect(test.io.readConfig).not.toHaveBeenCalled();
    expect(test.request).not.toHaveBeenCalled();
  });
});

describe("Codex hosted app refresh", () => {
  it.each([
    { args: "plugins refresh notes", owner: true, expected: "Usage: /codex plugins refresh" },
    { args: "plugins refresh", owner: false, expected: "Only an owner or operator.admin" },
  ])(
    "rejects $args for owner=$owner before opening a runtime",
    async ({ args, owner, expected }) => {
      const acquire = vi.spyOn(commandRuntime, "withCodexPluginCommandContext");
      const result = await hostCommand({ args, senderIsOwner: owner });
      expect(result.text).toContain(expected);
      expect(acquire).not.toHaveBeenCalled();
    },
  );

  it("refreshes all apps before a separate status read inspects only the selected plugin", async () => {
    const test = fixture({
      otherApp: true,
      runtime: [{ id: "app-0", runtimeName: "App 0", enabled: false, callable: false }],
      refreshedRuntime: [
        { id: "app-0", runtimeName: "App 0", enabled: true, callable: true },
        { id: "other-app", runtimeName: "Other plugin app", enabled: true, callable: true },
      ],
    });
    const refresh = await refreshHostedApps(test.context);
    const result = await test.status();

    expect(test.request).toHaveBeenCalledWith("app/read", {
      appIds: ["app-0", "other-app"],
      includeTools: true,
    });
    expect(
      defaultCodexAppInventoryCache
        .read({
          key: test.context.appCacheKey,
          request: test.context.request,
          suppressRefresh: true,
        })
        .snapshot?.apps.map((app) => app.id),
    ).toEqual(["app-0", "other-app"]);
    expect(result.text).toContain("Plugin: notes＠company-tools");
    expect(result.text).not.toContain("Other plugin app");
    expect(result.text).toContain("enabled: false; callable: false");
    expect(result.text).not.toContain("callable: true");
    expect(test.request.mock.calls.filter(([method]) => method === "app/installed")).toEqual([
      ["app/installed", { forceRefresh: true }],
      ["app/installed", { threadId: "thread-a", forceRefresh: false }],
    ]);
    expect(refresh.text).toContain("current Codex account/runtime");
    expect(refresh.text).not.toContain("Plugin: notes");
  });

  it("does not refresh when hosted app support is unknown", async () => {
    const test = fixture({ failMethod: "experimentalFeature/list" });
    const result = await refreshHostedApps(test.context);
    expect(result.text).toContain("Hosted app support is unknown");
    expect(result.text).not.toContain("request completed");
    expect(test.request).not.toHaveBeenCalledWith("app/installed", { forceRefresh: true });
  });

  it.each([
    {
      error: new Error(privateError),
      expected: "Hosted app tools could not be refreshed",
    },
    {
      error: new CodexAppServerRpcError({ code: -32601, message: privateError }, "app/installed"),
      expected: "does not support the required app inventory methods",
    },
    {
      error: Object.assign(new Error(privateError), {
        code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
        reason: "aborted",
        mayHaveWritten: true,
      }),
      expected: "The hosted app refresh was cancelled",
    },
  ])(
    "reports $expected without claiming success or exposing provider data",
    async ({ error, expected }) => {
      const test = fixture({ refreshError: error });
      const result = await refreshHostedApps(test.context);
      expect(result.text).toContain(expected);
      expect(result.text).toContain("/codex plugins refresh");
      expect(result.text).toContain("Previous inventory was not confirmed");
      expect(result.text).not.toContain("request completed");
      expect(result.text).not.toContain(privateError);
    },
  );

  it("rejects unknown plugin commands without opening a runtime", async () => {
    const test = fixture();
    const acquire = vi.spyOn(test.runtime, "withContext");
    const result = await handleCodexPluginsSubcommand(
      ctx,
      ["unknown-action", "notes"],
      test.io,
      test.runtime,
    );
    expect(result.text).toContain("Unknown /codex plugins subcommand");
    expect(acquire).not.toHaveBeenCalled();
    expect(test.request).not.toHaveBeenCalled();
  });
});
