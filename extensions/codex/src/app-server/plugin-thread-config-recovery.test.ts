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
import { CodexAppServerRpcError } from "./rpc-error.js";

function pluginStartupFixture(options: {
  failures: number;
  denied?: boolean;
  error?: Error;
  beforeFailure?: () => void;
  signal?: AbortSignal;
}) {
  let failuresRemaining = options.failures;
  const apps = [appInfo("slack-app", true), appInfo("healthy-app", true)];
  const detailTimeouts: (number | undefined)[] = [];
  const request = vi.fn(
    async (method: string, params?: unknown, requestOptions?: { timeoutMs?: number }) => {
      if (method === "plugin/installed") {
        return pluginInstalled(
          ["slack", "healthy"].map((name) =>
            pluginSummary(name, {
              installed: true,
              enabled: true,
              remotePluginId: `plugin_${name}`,
            }),
          ),
          { path: null },
        );
      }
      if (method === "plugin/read") {
        const { pluginName: remotePluginId, remoteMarketplaceName } = params as {
          pluginName: string;
          remoteMarketplaceName: string;
        };
        expect(remoteMarketplaceName).toBe(CODEX_PLUGINS_MARKETPLACE_NAME);
        const pluginName = remotePluginId.replace(/^plugin_/u, "");
        if (pluginName === "slack") {
          detailTimeouts.push(requestOptions?.timeoutMs);
          if (failuresRemaining-- > 0) {
            options.beforeFailure?.();
            throw (
              options.error ??
              new Error("synthetic temporary plugin detail failure private-error-marker")
            );
          }
        }
        return pluginDetail(pluginName, [appSummary(`${pluginName}-app`)], {
          marketplacePath: null,
        });
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
    },
  );
  const appCache = new CodexAppInventoryCache();
  const appCacheKey = "plugin-recovery-regression";
  const provider = createCodexPluginThreadConfigStartupProvider({
    diagnosticContext: { runId: "plugin-recovery-run", sessionId: "plugin-recovery-session" },
    inputFingerprint: undefined,
    enabledPluginConfigKeys: undefined,
    policy: undefined,
    requestTimeoutMs: 240_000,
    signal: options.signal ?? new AbortController().signal,
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
    detailTimeouts,
    warmApps: () =>
      appCache.refreshNow({
        key: appCacheKey,
        request: async (method, params) => codexAppInventoryResponse(method, apps, params),
      }),
    detailCalls: (pluginName: string) =>
      request.mock.calls.filter(
        ([method, params]) =>
          method === "plugin/read" &&
          (params as { pluginName?: string }).pluginName === `plugin_${pluginName}`,
      ).length,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function remotePluginStatusError(status: number): CodexAppServerRpcError {
  return new CodexAppServerRpcError(
    {
      code: -32603,
      message: `read remote plugin details: remote plugin catalog request to https://example.test/plugins/slack failed with status ${status}: synthetic failure`,
    },
    "plugin/read",
  );
}

describe("Codex plugin omission recovery", () => {
  it.each([408, 500, 502, 503, 504])(
    "recovers a warm-cache HTTP%s detail failure within the current startup",
    async (status) => {
      const fixture = pluginStartupFixture({ failures: 1, error: remotePluginStatusError(status) });
      await fixture.warmApps();
      const result = await fixture.provider.build();
      expect(result.policyContext.apps["slack-app"]).toBeDefined();
      expect(result.policyContext.apps["healthy-app"]).toBeDefined();
      expect(result.diagnostics).toEqual([]);
      expect(fixture.detailCalls("slack")).toBe(2);
      expect(fixture.detailCalls("healthy")).toBe(1);
    },
  );

  it.each([true, false])(
    "bounds persistent transient failures with warm cache=%s",
    async (warm) => {
      const fixture = pluginStartupFixture({ failures: 99, error: remotePluginStatusError(503) });
      if (warm) {
        await fixture.warmApps();
      }
      const result = await fixture.provider.build();
      expect(result.policyContext.apps["slack-app"]).toBeUndefined();
      expect(result.policyContext.apps["healthy-app"]).toBeDefined();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "plugin_detail_unavailable" }),
      );
      expect(fixture.detailCalls("slack")).toBe(2);
      expect(fixture.detailCalls("healthy")).toBe(1);
    },
  );

  it.each([401, 403, 404, 429, 501])(
    "does not retry HTTP%s without a transient recovery contract",
    async (status) => {
      const fixture = pluginStartupFixture({ failures: 1, error: remotePluginStatusError(status) });
      await fixture.warmApps();
      const result = await fixture.provider.build();
      expect(result.policyContext.apps["slack-app"]).toBeUndefined();
      expect(fixture.detailCalls("slack")).toBe(1);
    },
  );

  it("keeps the retry inside the remaining startup deadline", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const fixture = pluginStartupFixture({
      failures: 1,
      error: remotePluginStatusError(503),
      beforeFailure: () => {
        vi.advanceTimersByTime(10_000);
      },
    });
    await fixture.warmApps();
    const result = await fixture.provider.build();
    expect(result.policyContext.apps["slack-app"]).toBeDefined();
    expect(fixture.detailTimeouts).toEqual([60_000, 50_000]);
  });

  it("does not issue a recovery request after startup cancellation", async () => {
    const abort = new AbortController();
    const fixture = pluginStartupFixture({
      failures: 1,
      error: remotePluginStatusError(503),
      signal: abort.signal,
      beforeFailure: () => {
        abort.abort(new Error("startup cancelled"));
      },
    });
    await fixture.warmApps();
    await expect(fixture.provider.build()).rejects.toThrow("startup cancelled");
    expect(fixture.detailCalls("slack")).toBe(1);
  });

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
    const fixture = pluginStartupFixture({
      failures: 1,
      denied: true,
      error: remotePluginStatusError(503),
    });
    await fixture.warmApps();
    const result = await fixture.provider.build();
    expect(result.policyContext.pluginAppIds.slack).toEqual(["slack-app"]);
    expect(result.policyContext.apps["slack-app"]).toBeUndefined();
    expect(result.policyContext.apps["healthy-app"]).toBeDefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "app_not_ready" }));
  });
});
