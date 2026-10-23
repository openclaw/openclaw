import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../app-server/client.js";
import { createClientHarness } from "../app-server/test-support.js";

const callCount = vi.hoisted(() => ({ count: 0 }));

// mock-isolation: advance fake timers so the polling loop makes monotonic-clock progress
vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  sleep: (ms: number) => vi.advanceTimersByTimeAsync(ms),
}));
// mock-isolation: retain real request owner; replace only the shared-client acquisition boundary
vi.mock("../app-server/shared-client.js", () => ({
  getLeasedSharedCodexAppServerClient: vi.fn(
    async () =>
      createClientHarness({
        onWrite(line, send) {
          const msg = JSON.parse(line);
          if (msg.method === "plugin/list") {
            callCount.count += 1;
            const marketplace =
              callCount.count === 1
                ? { name: "custom", path: "/c", plugins: [] }
                : { name: "openai-curated", path: "/curated", plugins: [] };
            send({ id: msg.id, result: { marketplaces: [marketplace] } });
          }
        },
      }).client,
  ),
  releaseLeasedSharedCodexAppServerClient: vi.fn(() => true),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(() => true),
  isCodexAppServerStartSelectionChangedError: vi.fn(() => false),
  createIsolatedCodexAppServerClient: vi.fn(),
  clearSharedCodexAppServerClientIfCurrentAndWait: vi.fn(() => Promise.resolve()),
}));
// mock-isolation: bypass activation and credential stores, not the request owner.
vi.mock("../app-server/plugin-activation.js", () => ({
  ensureCodexPluginActivation: async (p: {
    request: (m: string, r?: unknown) => Promise<unknown>;
  }) => {
    await p.request("plugin/list", undefined);
    return {
      identity: { pluginName: "t", marketplaceName: "openai-curated" },
      ok: true,
      reason: "already_active",
      installAttempted: false,
      diagnostics: [],
    };
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

let workspace: Awaited<ReturnType<typeof tempWorkspace>>;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await workspace?.cleanup();
});

it("keeps request allowances within the 30s discovery budget after a 120s rewind", async () => {
  vi.stubEnv("OPENCLAW_CODEX_MIGRATION_PLUGIN_LIST_TIMEOUT_MS", "30000");
  workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "oc-codex-dl-",
  });
  callCount.count = 0;
  vi.useFakeTimers();
  vi.setSystemTime(0);

  const requestSpy = vi.spyOn(CodexAppServerClient.prototype, "request");
  const fakeSetTimeout = globalThis.setTimeout;
  let rewound = false;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    cb: (...a: unknown[]) => void,
    t?: number,
    ...a: unknown[]
  ) => {
    if (!rewound && typeof t === "number" && t > 0) {
      rewound = true;
      vi.setSystemTime(-120_000);
    }
    return fakeSetTimeout(() => cb(...a), t);
  }) as typeof setTimeout);

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
      config: {
        agents: { defaults: { workspace: "/d/w" } },
        plugins: { entries: { codex: { enabled: true, config: {} } } },
      },
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
