import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import {
  appInfo,
  appSummary,
  pluginDetail,
  pluginInstalled,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { createCodexPluginThreadConfigStartupProvider } from "./plugin-thread-config-deadline.js";
import type { CodexAppServerRequestParams } from "./protocol.js";

function pluginStartupFixture(options: { failures: number; denied?: boolean }) {
  let failuresRemaining = options.failures;
  const apps = [appInfo("slack-app", true), appInfo("healthy-app", true)];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "plugin/installed") {
      return pluginInstalled(
        ["slack", "healthy"].map((name) => pluginSummary(name, { installed: true, enabled: true })),
      );
    }
    if (method === "plugin/read") {
      const { pluginName } = params as { pluginName: string };
      if (pluginName === "slack" && failuresRemaining-- > 0) {
        throw new Error("synthetic temporary plugin detail failure private-error-marker");
      }
      return pluginDetail(pluginName, [appSummary(`${pluginName}-app`)]);
    }
    if (method === "app/installed" || method === "app/read") {
      return codexAppInventoryResponse(
        method,
        apps,
        params as CodexAppServerRequestParams<typeof method>,
      );
    }
    if (method === "config/read") {
      const config = options.denied ? { apps: { "slack-app": { enabled: false } } } : {};
      return { config, layers: [{ name: { type: "user" }, config }] };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const appCache = new CodexAppInventoryCache();
  const appCacheKey = "plugin-recovery-regression";
  const provider = createCodexPluginThreadConfigStartupProvider({
    diagnosticContext: { runId: "plugin-recovery-run", sessionId: "plugin-recovery-session" },
    inputFingerprint: undefined,
    enabledPluginConfigKeys: undefined,
    policy: undefined,
    requestTimeoutMs: 240_000,
    signal: new AbortController().signal,
    pluginConfig: {
      codexPlugins: {
        enabled: true,
        plugins: Object.fromEntries(
          ["slack", "healthy"].map((name) => [
            name,
            { pluginName: name, marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME },
          ]),
        ),
      },
    },
    appCache,
    appCacheKey,
    metadataCache: new CodexPluginMetadataCache(),
    client: { request },
  });
  return {
    provider,
    request,
    warmApps: () =>
      appCache.refreshNow({
        key: appCacheKey,
        request: async (method, params) => codexAppInventoryResponse(method, apps, params),
      }),
    detailCalls: (pluginName: string) =>
      request.mock.calls.filter(
        ([method, params]) =>
          method === "plugin/read" && (params as { pluginName?: string }).pluginName === pluginName,
      ).length,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Codex plugin omission recovery", () => {
  it("records a warm-cache omission and recovers on the next startup", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    const fixture = pluginStartupFixture({ failures: 1 });
    await fixture.warmApps();

    const first = await fixture.provider.build();
    expect(first.policyContext.pluginAppIds).toEqual({ healthy: ["healthy-app"] });
    expect(first.policyContext.apps["healthy-app"]).toBeDefined();
    expect(first.diagnostics).toContainEqual(
      expect.objectContaining({ code: "plugin_detail_unavailable" }),
    );
    expect(fixture.detailCalls("slack")).toBe(1);

    const next = await fixture.provider.build();
    expect(next.policyContext.pluginAppIds.slack).toEqual(["slack-app"]);
    expect(next.policyContext.apps["slack-app"]).toBeDefined();
    expect(next.diagnostics).toEqual([]);
    expect(fixture.detailCalls("slack")).toBe(2);
    expect(fixture.detailCalls("healthy")).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "codex plugin thread config degraded",
      expect.objectContaining({
        runId: "plugin-recovery-run",
        sessionId: "plugin-recovery-session",
        diagnostics: [
          expect.objectContaining({ code: "plugin_detail_unavailable", plugin: "slack" }),
        ],
        admittedAppCount: 1,
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-error-marker");
  });

  it("uses existing cold-cache refresh recovery without rereading healthy manifests", async () => {
    const fixture = pluginStartupFixture({ failures: 1 });
    const result = await fixture.provider.build();
    expect(result.policyContext.apps["slack-app"]).toBeDefined();
    expect(result.policyContext.apps["healthy-app"]).toBeDefined();
    expect(result.diagnostics).toEqual([]);
    expect(fixture.detailCalls("slack")).toBe(2);
    expect(fixture.detailCalls("healthy")).toBe(1);
  });

  it("keeps an explicit app denial after metadata recovers", async () => {
    const fixture = pluginStartupFixture({ failures: 1, denied: true });
    await fixture.warmApps();
    await fixture.provider.build();
    const result = await fixture.provider.build();
    expect(result.policyContext.pluginAppIds.slack).toEqual(["slack-app"]);
    expect(result.policyContext.apps["slack-app"]).toBeUndefined();
    expect(result.policyContext.apps["healthy-app"]).toBeDefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "app_not_ready" }));
  });
});
