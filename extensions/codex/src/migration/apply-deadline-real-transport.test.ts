// Real-transport regression: requestTargetCodexAppServerJson deadline must stay bounded
// under wall-clock rewind. Retains the real request owner; replaces only the
// transport boundary. Date.now is skewed −120s after the first request.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../app-server/client.js";

const sleepMock = vi.hoisted(() => vi.fn((ms: number) => vi.advanceTimersByTimeAsync(ms)));
const activationMock = vi.hoisted(() =>
  vi.fn(async (p: { request: (m: string, r?: unknown) => Promise<unknown> }) => {
    await p.request("plugin/list", undefined);
    return {
      identity: { pluginName: "t", marketplaceName: "openai-curated" },
      ok: true,
      reason: "already_active",
      installAttempted: false,
      diagnostics: [],
    };
  }),
);
const callCount = vi.hoisted(() => ({ count: 0 }));

// mock-isolation: advance fake timers so the polling loop makes monotonic-clock progress
vi.mock("openclaw/plugin-sdk/runtime-env", () => ({ sleep: sleepMock }));
// mock-isolation: retain real request owner; replace only the shared-client acquisition boundary
vi.mock("../app-server/shared-client.js", () => ({
  getLeasedSharedCodexAppServerClient: vi.fn(() => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = new EventEmitter();
    const send = (v: unknown) => stdout.write(JSON.stringify(v) + "\n");
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        const msg = JSON.parse(chunk.toString());
        if (msg.method === "plugin/list") {
          callCount.count += 1;
          const result =
            callCount.count === 1
              ? {
                  marketplaces: [{ name: "custom", path: "/c", plugins: [] }],
                }
              : {
                  marketplaces: [{ name: "openai-curated", path: "/curated", plugins: [] }],
                };
          send({ id: msg.id, result });
        }
        cb();
      },
    });
    const transport = Object.assign(proc, {
      stdin,
      stdout,
      stderr,
      exitCode: null as number | null,
      kill: () => {},
    });
    stdin.on("close", () => {
      transport.exitCode = 0;
      proc.emit("exit", 0, null);
    });
    return Promise.resolve(CodexAppServerClient.fromTransportForTests(transport));
  }),
  releaseLeasedSharedCodexAppServerClient: vi.fn(() => true),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(() => true),
  isCodexAppServerStartSelectionChangedError: vi.fn(() => false),
  createIsolatedCodexAppServerClient: vi.fn(),
  clearSharedCodexAppServerClientIfCurrentAndWait: vi.fn(() => Promise.resolve()),
}));
// mock-isolation: call the request callback directly without the full activation pipeline
vi.mock("../app-server/plugin-activation.js", () => ({
  ensureCodexPluginActivation: activationMock,
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

import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { applyCodexMigrationPlan } from "./apply.js";

describe("Codex migration discovery deadline with real request owner", () => {
  let workspace: Awaited<ReturnType<typeof tempWorkspace>>;

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_CODEX_MIGRATION_PLUGIN_LIST_TIMEOUT_MS", "30000");
    sleepMock.mockClear();
    activationMock.mockClear();
    callCount.count = 0;
    workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "oc-codex-dl-",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await workspace?.cleanup();
  });

  it("keeps request allowances within the 30s discovery budget after a 120s rewind", async () => {
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

    const item = {
      id: "p:t",
      kind: "plugin",
      action: "install",
      status: "planned",
      source: "/s/.codex",
      destination: "/d/agent",
      details: { configKey: "t", marketplaceName: "openai-curated", pluginName: "t" },
    } as unknown as MigrationItem;
    const plan = {
      source: "/s/.codex",
      items: [item],
      metadata: { codexHome: "/s/.codex" },
    } as unknown as MigrationPlan;
    const ctx = {
      config: {
        agents: { defaults: { workspace: "/d/w" } },
        plugins: { entries: { codex: { enabled: true, config: {} } } },
      },
      source: "/s/.codex",
      stateDir: workspace.dir,
      reportDir: undefined,
    } as unknown as MigrationProviderContext;

    const result = await applyCodexMigrationPlan({ ctx, plan });

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
});
