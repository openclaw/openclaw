import { describe, expect, it } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import type { CodexPluginDestructivePolicy } from "./config-contracts.shared.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import {
  appInfo,
  appSummary,
  pluginDetail,
  pluginInstalled,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import {
  buildCodexPluginThreadConfig,
  buildCodexPluginThreadConfigInputFingerprint,
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  refreshCodexPluginAppApprovalPolicy,
  mergeCodexThreadConfigs,
} from "./plugin-thread-config.js";
import type { CodexAppServerRequestParams, v2 } from "./protocol.js";
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

function fixture(
  readOnly: boolean | undefined,
  destructive: CodexPluginDestructivePolicy = true,
  sharedReadOnly?: boolean,
) {
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
          sample_manage: { enabled: true },
          stale: { enabled: true },
          shared: { enabled: true },
          sample_native_disabled: { enabled: false },
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
                  `sample_${t.name}`.toLowerCase(),
                  runtimeTool(t.name, t.isReadOnly, t.title ?? `sample_${t.name}`),
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
      return pluginInstalled([
        pluginSummary("sample", { installed: true, enabled: true }),
        ...(sharedReadOnly === undefined
          ? []
          : [pluginSummary("shared", { installed: true, enabled: true })]),
      ]);
    }
    if (method === "plugin/read") {
      const { pluginName } = params as CodexAppServerRequestParams<"plugin/read">;
      return pluginDetail(pluginName, [appSummary("sample-app")]);
    }
    if (method === "app/read" || method === "app/installed") {
      return codexAppInventoryResponse(
        method,
        [{ ...appInfo("sample-app", true), name: "sample", toolSummaries: tools }],
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
        pluginConfig: {
          codexPlugins: {
            enabled: true,
            plugins: {
              sample: {
                marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                pluginName: "sample",
                read_only: readOnly,
                allow_destructive_actions: destructive,
              },
              ...(sharedReadOnly === undefined
                ? {}
                : {
                    shared: {
                      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                      pluginName: "shared",
                      read_only: sharedReadOnly,
                      allow_destructive_actions: true,
                    },
                  }),
            },
          },
        },
        request,
        appCache: new CodexAppInventoryCache(),
        appCacheKey: "read-only",
      }),
  };
}

describe("plugin read_only policy", () => {
  it("invalidates a retained config when the read-only restriction moves between plugins", () => {
    const fingerprint = (restricted: string) =>
      buildCodexPluginThreadConfigInputFingerprint({
        pluginConfig: {
          codexPlugins: {
            enabled: true,
            plugins: Object.fromEntries(
              ["sample", "shared"].map((name) => [
                name,
                {
                  pluginName: name,
                  marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                  read_only: name === restricted,
                },
              ]),
            ),
          },
        },
      });
    expect(fingerprint("sample")).not.toBe(fingerprint("shared"));
  });

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
    expect(configPatch?.apps).toMatchObject({
      "sample-app": { tools: { search: { enabled: false } } },
    });
  });
  it("does not grant an unknown callable resource through a read summary's bare name", async () => {
    const f = fixture(true);
    f.setTools([tool("sample_manage", true)]);
    f.setNativeTools({ sample_manage: { enabled: true } });
    const result = await f.build();
    const effective = mergeCodexThreadConfigs(f.nativeConfig, result.configPatch);
    expect(
      readCurrentToolPolicy(effective!, "sample-app", "sample_sample_manage", {
        title: "sample_sample_manage",
      }).enabled,
    ).toBe(true);
    expect(
      readCurrentToolPolicy(effective!, "sample-app", "sample_manage", { title: "sample_manage" })
        .enabled,
    ).toBe(false);
  });
  it.each([
    [{ sample_Browse: { approval_mode: "prompt" } }, "prompt", true],
    [{ sample_Browse: { approval_mode: "writes" } }, "writes", true],
    [
      { sample_Browse: { approval_mode: "prompt" }, sample_browse: { approval_mode: "approve" } },
      "approve",
      true,
    ],
    [
      { sample_Browse: { approval_mode: "prompt" }, sample_browse: { enabled: true } },
      "auto",
      true,
    ],
    [{ sample_Browse: { enabled: false }, sample_browse: { enabled: true } }, "auto", true],
    [{ sample_Browse: { enabled: true }, sample_browse: { enabled: false } }, "auto", false],
    [
      { sample_Browse: { enabled: false }, sample_browse: { approval_mode: "approve" } },
      "approve",
      true,
    ],
    [{ sample_Browse: { enabled: false } }, "auto", false],
  ] as const)(
    "preserves native whole-entry tool policy across binding replay (%j)",
    async (native, expected, enabled) => {
      const f = fixture(true, "auto");
      f.setTools([tool("Browse", true)]);
      f.setNativeTools(native);
      const result = await f.build();
      // Exercise serialized binding storage, not only an in-memory clone.
      const serialized = JSON.stringify(result.policyContext);
      const restored = readPluginAppPolicyContext(JSON.parse(serialized));
      expect(restored).toBeDefined();
      for (const patch of [
        result.configPatch,
        buildCodexPluginAppsConfigPatchFromPolicyContext(restored!),
      ]) {
        const effective = mergeCodexThreadConfigs(f.nativeConfig, patch);
        expect(effective).toBeDefined();
        expect(
          readCurrentToolPolicy(effective!, "sample-app", "sample_browse", {
            title: "sample_Browse",
          }),
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
      expect(result.configPatch?.apps).toMatchObject({
        "sample-app": {
          destructive_enabled: true,
          default_tools_enabled: false,
          tools: { sample_browse: { enabled: true }, sample_manage: { enabled: false } },
        },
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
              tools: { sample_browse: "auto", sample_manage: "approve" },
            },
          ],
        },
      },
      {
        config: {
          apps: {
            "sample-app": { tools: { sample_manage: { enabled: true }, stale: { enabled: true } } },
          },
        },
        toolsByApp: new Map([
          [
            "sample-app",
            new Map([
              ["sample_browse", {}],
              ["sample_manage", {}],
            ]),
          ],
        ]),
      },
    );
    expect(intersected.configPatch).toMatchObject({
      apps: {
        "sample-app": {
          default_tools_enabled: false,
          tools: {
            sample_browse: { enabled: true },
            sample_manage: { enabled: false },
            stale: { enabled: false },
          },
        },
      },
    });
  });

  it.each([false, true, "auto", "ask"] as const)(
    "caps tools independently of destructive policy %s and survives binding replay",
    async (destructive) => {
      const result = await fixture(true, destructive).build();
      expect(result.diagnostics).toEqual([]);
      const expected = {
        enabled: true,
        destructive_enabled: destructive !== false,
        default_tools_enabled: false,
        tools: {
          sample_browse: { enabled: true },
          sample_manage: { enabled: false },
          stale: { enabled: false },
          sample_admin_disabled: { enabled: false },
          sample_native_disabled: { enabled: false },
          shared: { enabled: false },
        },
      };
      expect(result.configPatch?.apps).toMatchObject({ "sample-app": expected });
      expect(
        buildCodexPluginAppsConfigPatchFromPolicyContext(result.policyContext).apps,
      ).toMatchObject({ "sample-app": expected });
    },
  );

  it.each([undefined, false])(
    "preserves existing destructive policy when read_only is %s",
    async (readOnly) => {
      const result = await fixture(readOnly, false).build();
      expect(result.configPatch?.apps).toMatchObject({
        "sample-app": {
          enabled: true,
          destructive_enabled: false,
          open_world_enabled: true,
        },
      });
      expect(result.configPatch?.apps).not.toHaveProperty("sample-app.default_tools_enabled");
      expect(result.policyContext.apps["sample-app"]).not.toHaveProperty("readOnlyTools");
    },
  );

  it("revokes previous grants when hosted tool inventory is unavailable", async () => {
    const f = fixture(true);
    const initial = await f.build();
    f.setRuntime(new Error("hosted MCP inventory unavailable"));
    const replay = await refreshCodexPluginAppApprovalPolicy({
      policyContext: initial.policyContext,
      request: f.request,
    });
    expect(replay.configPatch.apps).toMatchObject({
      "sample-app": {
        default_tools_enabled: false,
        tools: {
          sample_browse: { enabled: false },
          sample_manage: { enabled: false },
          stale: { enabled: false },
        },
      },
    });
  });

  it("refreshes classifications and fails closed when current metadata is missing", async () => {
    const f = fixture(true);
    const initial = await f.build();
    f.setTools([tool("browse", false), tool("new_read", true)]);
    const updated = await refreshCodexPluginAppApprovalPolicy({
      policyContext: initial.policyContext,
      request: f.request,
    });
    expect(updated.configPatch.apps).toMatchObject({
      "sample-app": {
        default_tools_enabled: false,
        tools: {
          sample_browse: { enabled: false },
          sample_new_read: { enabled: true },
          stale: { enabled: false },
        },
      },
    });
    f.setTools(undefined);
    const missing = await refreshCodexPluginAppApprovalPolicy({
      policyContext: updated.policyContext,
      request: f.request,
    });
    expect(missing.configPatch.apps).toMatchObject({
      "sample-app": {
        default_tools_enabled: false,
        tools: {
          sample_browse: { enabled: false },
          sample_new_read: { enabled: false },
          sample_manage: { enabled: false },
          stale: { enabled: false },
        },
      },
    });
    expect(missing.policyContext.apps["sample-app"]).toBeDefined();
    expect(
      Object.values(missing.policyContext.apps["sample-app"]?.readOnlyTools ?? {}).some(
        (entry) => entry.enabled,
      ),
    ).toBe(false);
  });
});
