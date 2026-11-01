import { describe, expect, it } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import type { CodexPluginDestructivePolicy } from "./config-contracts.shared.js";
import {
  appInfo,
  appSummary,
  codexPluginConfig,
  curatedPlugin,
  pluginDetail,
  pluginInstalled,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import {
  buildCodexPluginThreadConfig,
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  refreshCodexPluginAppApprovalPolicy,
  mergeCodexThreadConfigs,
} from "./plugin-thread-config.js";
import type { CodexAppServerRequestParams, JsonObject, v2 } from "./protocol.js";
import { intersectCodexPluginThreadConfigWithScheduledAuthority } from "./scheduled-app-authority.js";
import { readCurrentToolPolicy } from "./scheduled-app-tool-policy.js";
import { readPluginAppPolicyContext } from "./session-binding-record.js";

type Tool = NonNullable<v2.AppInfo["toolSummaries"]>[number];
const tool = (name: string, isReadOnly: boolean, extra: Partial<Tool> = {}): Tool => ({
  name,
  title: null,
  description: "",
  isReadOnly,
  isEnabled: true,
  disabledReason: null,
  ...extra,
});
function runtimeTool(action: string, readOnly: boolean, title: string) {
  return {
    title,
    annotations: { readOnlyHint: readOnly },
    _meta: {
      connector_id: "sample-app",
      _codex_apps: { resource_uri: `/sample-app/link/${action}` },
    },
  };
}
const expectApp = (patch: JsonObject | undefined, expected: JsonObject) =>
  expect(patch?.apps).toMatchObject({ "sample-app": expected });
const readOnlyTools = (enabled: string[], disabled: string[]): JsonObject => ({
  default_tools_enabled: false,
  tools: Object.fromEntries([
    ...enabled.map((name) => [name, { enabled: true }]),
    ...disabled.map((name) => [name, { enabled: false }]),
  ]),
});

function fixture(
  readOnly: boolean | undefined,
  destructive: CodexPluginDestructivePolicy = true,
  sharedReadOnly?: boolean,
) {
  const owners: Array<[string, boolean | undefined, CodexPluginDestructivePolicy]> = [
    ["sample", readOnly, destructive],
  ];
  if (sharedReadOnly !== undefined) {
    owners.push(["shared", sharedReadOnly, true]);
  }
  let tools: Tool[] | undefined = [
    tool("browse", true),
    tool("manage", false),
    tool("admin_disabled", true, { isEnabled: false }),
    tool("native_disabled", true),
    tool("read_alias", true, { title: "shared" }),
    tool("write_alias", false, { title: "shared" }),
  ];
  let runtime: Record<string, ReturnType<typeof runtimeTool>> | Error | undefined;
  const nativeConfig = {
    apps: {
      "sample-app": {
        tools: {
          manage: { enabled: true },
          stale: { enabled: true },
          native_disabled: { enabled: false },
        },
      },
    },
  };
  const request = async (method: string, params?: unknown) => {
    if (method === "mcpServerStatus/list") {
      if (runtime instanceof Error) {
        throw runtime;
      }
      return {
        data: [
          {
            name: "codex_apps",
            tools:
              runtime ??
              Object.fromEntries(
                (tools ?? []).map((t) => [
                  t.name,
                  runtimeTool(t.name, t.isReadOnly, t.title ?? t.name),
                ]),
              ),
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "config/read") {
      return { config: nativeConfig, layers: [] };
    }
    if (method === "plugin/installed" || method === "plugin/list") {
      return pluginInstalled(
        owners.map(([name]) => pluginSummary(name, { installed: true, enabled: true })),
      );
    }
    if (method === "plugin/read") {
      const { pluginName } = params as CodexAppServerRequestParams<"plugin/read">;
      return pluginDetail(pluginName, [appSummary("sample-app")]);
    }
    if (method === "app/read" || method === "app/installed") {
      return codexAppInventoryResponse(
        method,
        [{ ...appInfo("sample-app", true), toolSummaries: tools }],
        params as CodexAppServerRequestParams<typeof method>,
      );
    }
    throw new Error(`Unexpected request ${method}`);
  };
  return {
    request,
    nativeConfig,
    setNativeTools(value: Record<string, { enabled?: boolean; approval_mode?: string }>) {
      Object.assign(nativeConfig.apps["sample-app"].tools, value);
    },
    setRuntime(value: Record<string, ReturnType<typeof runtimeTool>> | Error) {
      runtime = value;
    },
    setTools(value: Tool[] | undefined) {
      tools = value;
    },
    build: () =>
      buildCodexPluginThreadConfig({
        pluginConfig: codexPluginConfig({
          plugins: Object.fromEntries(
            owners.map(([name, read_only, allow_destructive_actions]) => [
              name,
              curatedPlugin(name, { read_only, allow_destructive_actions }),
            ]),
          ),
        }),
        request,
        appCache: new CodexAppInventoryCache(),
        appCacheKey: "read-only",
      }),
  };
}

describe("plugin read_only policy", () => {
  it("grants only the exact hosted MCP action, even with name collisions and a misleading title", async () => {
    const f = fixture(true);
    f.setTools([tool("search", true), tool("trash", false)]);
    f.setNativeTools({ search: { approval_mode: "prompt" } });
    f.setRuntime({
      "documents_01234567.search": runtimeTool("search", true, "search"),
      // Codex falls back to title when the raw name has no entry.
      "documents.trash": runtimeTool("trash", false, "documents_01234567.search"),
      "documents.new_tool": runtimeTool("new_tool", true, "search"),
    });
    const { configPatch } = await f.build();
    const effective = mergeCodexThreadConfigs(f.nativeConfig, configPatch);
    for (const [name, title, enabled] of [
      ["documents_01234567.search", "search", true],
      ["documents.trash", "documents_01234567.search", false],
      ["documents.new_tool", "search", false],
    ] as const) {
      expect(readCurrentToolPolicy(effective!, "sample-app", name, { title })).toMatchObject({
        enabled,
        ...(enabled ? { approvalMode: "prompt" } : {}),
      });
    }
    expectApp(configPatch, { tools: { search: { enabled: false } } });
  });

  it.each([
    [{ Browse: { approval_mode: "prompt" } }, "prompt", true],
    [{ Browse: { approval_mode: "writes" } }, "writes", true],
    [
      { Browse: { approval_mode: "prompt" }, browse: { approval_mode: "approve" } },
      "approve",
      true,
    ],
    [{ Browse: { approval_mode: "prompt" }, browse: { enabled: true } }, "auto", true],
    [{ Browse: { enabled: false }, browse: { enabled: true } }, "auto", true],
    [{ Browse: { enabled: true }, browse: { enabled: false } }, "auto", false],
    [{ Browse: { enabled: false }, browse: { approval_mode: "approve" } }, "approve", true],
    [{ Browse: { enabled: false } }, "auto", false],
  ] as const)(
    "preserves native whole-entry tool policy across binding replay (%j)",
    async (native, expected, enabled) => {
      const f = fixture(true, "auto");
      f.setTools([tool("browse", true, { title: "Browse" })]);
      f.setNativeTools(native);
      const result = await f.build();
      // Exercise serialized binding storage, not only an in-memory clone.
      const serialized = JSON.stringify(result.policyContext);
      const restored = readPluginAppPolicyContext(JSON.parse(serialized));
      for (const patch of [
        result.configPatch,
        buildCodexPluginAppsConfigPatchFromPolicyContext(restored!),
      ]) {
        const effective = mergeCodexThreadConfigs(f.nativeConfig, patch);
        expect(
          readCurrentToolPolicy(effective!, "sample-app", "browse", { title: "Browse" }),
        ).toEqual({ enabled, approvalMode: expected });
      }
    },
  );

  it.each([
    [true, false],
    [false, true],
  ] as const)(
    "retains a shared app's read-only cap regardless of owner order (%s, %s)",
    async (first, second) => {
      const result = await fixture(first, false, second).build();
      expect(result.diagnostics).toEqual([]);
      expectApp(result.configPatch, {
        destructive_enabled: true,
        ...readOnlyTools(["browse"], ["manage"]),
      });
    },
  );

  it("keeps read grants without destructive hints and stale-key denials in scheduled authority", async () => {
    const config = await fixture(true, false).build();
    const intersected = intersectCodexPluginThreadConfigWithScheduledAuthority(
      config,
      {
        version: 1,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: {
          version: 1,
          auth: { profileId: "openai:work", accountId: "acct-1" },
          apps: [
            {
              id: "sample-app",
              allowDestructiveActions: true,
              allowOpenWorld: true,
              destructiveApprovalMode: "allow",
              tools: { browse: "auto", manage: "approve" },
            },
          ],
        },
      },
      {
        config: {
          apps: {
            "sample-app": { tools: { manage: { enabled: true }, stale: { enabled: true } } },
          },
        },
        toolsByApp: new Map([
          [
            "sample-app",
            new Map([
              ["browse", {}],
              ["manage", {}],
            ]),
          ],
        ]),
      },
    );
    expectApp(intersected.configPatch, readOnlyTools(["browse"], ["manage", "stale"]));
  });

  it.each([false, true, "auto", "ask"] as const)(
    "caps tools independently of destructive policy %s and survives binding replay",
    async (destructive) => {
      const result = await fixture(true, destructive).build();
      expect(result.diagnostics).toEqual([]);
      const expected = {
        enabled: true,
        destructive_enabled: destructive !== false,
        ...readOnlyTools(
          ["browse"],
          ["manage", "stale", "admin_disabled", "native_disabled", "write_alias"],
        ),
      };
      expectApp(result.configPatch, expected);
      expectApp(buildCodexPluginAppsConfigPatchFromPolicyContext(result.policyContext), expected);
    },
  );

  it("revokes saved read grants when runtime tool discovery fails on replay", async () => {
    const f = fixture(true);
    const initial = await f.build();
    f.setRuntime(new Error("hosted MCP inventory unavailable"));
    const replay = await refreshCodexPluginAppApprovalPolicy({
      policyContext: initial.policyContext,
      request: f.request,
    });
    expect(replay.diagnostics).toContainEqual(expect.objectContaining({ code: "app_not_ready" }));
    expectApp(replay.configPatch, readOnlyTools([], ["browse", "manage", "stale"]));
  });

  it.each([undefined, false])(
    "preserves existing destructive policy when read_only is %s",
    async (readOnly) => {
      const result = await fixture(readOnly, false).build();
      expectApp(result.configPatch, {
        enabled: true,
        destructive_enabled: false,
        open_world_enabled: true,
      });
      expect(result.configPatch?.apps).not.toHaveProperty("sample-app.default_tools_enabled");
      expect(result.policyContext.apps["sample-app"]).not.toHaveProperty("readOnlyTools");
    },
  );

  it("refreshes classifications and fails closed when current metadata is missing", async () => {
    const f = fixture(true);
    const initial = await f.build();
    f.setTools([tool("browse", false), tool("new_read", true)]);
    const updated = await refreshCodexPluginAppApprovalPolicy({
      policyContext: initial.policyContext,
      request: f.request,
    });
    expectApp(updated.configPatch, readOnlyTools(["new_read"], ["browse", "stale"]));
    f.setTools(undefined);
    const missing = await refreshCodexPluginAppApprovalPolicy({
      policyContext: updated.policyContext,
      request: f.request,
    });
    expectApp(missing.configPatch, readOnlyTools([], ["browse", "new_read", "manage", "stale"]));
    expect(missing.policyContext.apps["sample-app"]).toBeDefined();
    expect(
      Object.values(missing.policyContext.apps["sample-app"]?.readOnlyTools ?? {}),
    ).not.toContainEqual(expect.objectContaining({ enabled: true }));
  });
});
