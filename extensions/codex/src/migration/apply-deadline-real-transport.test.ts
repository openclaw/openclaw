import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../app-server/client.js";
import { createRequestClientHarness } from "../app-server/test-support.js";

const callCount = vi.hoisted(() => ({ count: 0 }));

// mock-isolation: advance fake timers so the polling loop makes monotonic-clock progress
vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  sleep: (ms: number) => vi.advanceTimersByTimeAsync(ms),
}));
// mock-isolation: retain real request owner; replace only the shared-client acquisition boundary
vi.mock("../app-server/shared-client.js", () => ({
  getLeasedSharedCodexAppServerClient: async () =>
    createRequestClientHarness((method, id, _params, send) => {
      if (method === "plugin/list") {
        const name = ++callCount.count === 1 ? "custom" : "openai-curated";
        send({ id, result: { marketplaces: [{ name, path: "/fixture", plugins: [] }] } });
      }
    }).client,
  releaseLeasedSharedCodexAppServerClient: vi.fn(() => true),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(() => true),
  isCodexAppServerStartSelectionChangedError: vi.fn(() => false),
  createIsolatedCodexAppServerClient: vi.fn(),
  clearSharedCodexAppServerClientIfCurrentAndWait: vi.fn(() => Promise.resolve()),
}));
// mock-isolation: bypass activation and credential stores, not the request owner.
vi.mock("../app-server/plugin-activation.js", () => ({
  ensureCodexPluginActivation: async (p: { request: (m: string) => Promise<unknown> }) => {
    await p.request("plugin/list");
    return { ok: true, reason: "already_active", installAttempted: false, diagnostics: [] };
  },
}));
// mock-isolation: avoid database and credential-store dependencies in cache-key construction
vi.mock("../app-server/plugin-app-cache-key.js", () => ({
  buildCodexPluginAppCacheKey: vi.fn(async () => "k"),
}));
// mock-isolation: avoid database and credential-store dependencies in auth account resolution
vi.mock("../app-server/auth-bridge.js", () => ({
  resolveCodexAppServerAuthAccountCacheKey: vi.fn(async () => undefined),
}));
// mock-isolation: avoid credential-store dependencies in fallback API-key fingerprinting
vi.mock("../app-server/auth-cache-key.js", () => ({
  resolveCodexAppServerFallbackApiKeyCacheKey: vi.fn(() => undefined),
}));
// mock-isolation: avoid credential-store dependencies in auth profile resolution
vi.mock("../app-server/auth-profile.js", () => ({
  resolveCodexAppServerAuthProfileIdForAgent: vi.fn(() => undefined),
}));

import type { MigrationPlan, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { applyCodexMigrationPlan } from "./apply.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("keeps request allowances within the 30s discovery budget after a 120s rewind", async () => {
  vi.stubEnv("OPENCLAW_CODEX_MIGRATION_PLUGIN_LIST_TIMEOUT_MS", "30000");
  await using workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "oc-codex-dl-",
  });
  callCount.count = 0;
  vi.useFakeTimers({ now: 0 });

  const requestSpy = vi.spyOn(CodexAppServerClient.prototype, "request");
  const fakeSetTimeout = globalThis.setTimeout;
  let rewound = false;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((cb, t, ...a) => {
    if (!rewound && typeof t === "number" && t > 0) {
      rewound = true;
      vi.setSystemTime(-120_000);
    }
    return fakeSetTimeout(() => cb(...a), t);
  });

  const result = await applyCodexMigrationPlan({
    plan: {
      source: "/s/.codex",
      items: [
        {
          id: "p:t",
          kind: "plugin",
          action: "install",
          status: "planned",
          details: { configKey: "t", marketplaceName: "openai-curated", pluginName: "t" },
        },
      ],
    } as unknown as MigrationPlan,
    ctx: {
      config: { agents: { defaults: { workspace: "/d/w" } } },
      stateDir: workspace.dir,
    } as unknown as MigrationProviderContext,
  });

  expect(result.items).toMatchObject([{ status: "migrated", reason: "already active" }]);
  expect(rewound).toBe(true);
  const discoveryRequests = requestSpy.mock.calls.filter(([method]) => method === "plugin/list");
  expect(discoveryRequests.length).toBeGreaterThanOrEqual(2);
  for (const call of discoveryRequests) {
    const options = call[2];
    expect(options?.timeoutMs).toBeGreaterThan(0);
    expect(options?.timeoutMs).toBeLessThanOrEqual(30_000);
  }
}, 15_000);
