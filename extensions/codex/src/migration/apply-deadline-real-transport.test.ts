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
const armedDelays = vi.hoisted(() => ({ delays: [] as number[] }));

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
  let originalDateNow: typeof Date.now;

  beforeEach(async () => {
    sleepMock.mockClear();
    activationMock.mockClear();
    callCount.count = 0;
    armedDelays.delays.length = 0;
    workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "oc-codex-dl-",
    });
    originalDateNow = Date.now;
  });

  afterEach(async () => {
    Date.now = originalDateNow;
    vi.useRealTimers();
    await workspace?.cleanup();
  });

  it("keeps request allowances bounded when the wall clock rewinds 120s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const fakeSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: (...a: unknown[]) => void,
      t?: number,
      ...a: unknown[]
    ) => {
      if (typeof t === "number" && t > 0) {
        armedDelays.delays.push(t);
      }
      // Rewind wall clock by 120s after the first armed timer.
      if (armedDelays.delays.length === 1) {
        Date.now = (() => -120_000) as typeof Date.now;
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

    await applyCodexMigrationPlan({ ctx, plan });

    expect(armedDelays.delays.length).toBeGreaterThanOrEqual(2);
    for (const d of armedDelays.delays) {
      expect(d).toBeLessThanOrEqual(60_000);
    }
    console.log(
      "PROOF_TRACE " +
        JSON.stringify(
          armedDelays.delays.map((d, i) => ({
            requestIndex: i + 1,
            armedTimeoutMs: Math.round(d),
            bounded: d <= 60_000,
          })),
        ),
    );
  }, 15_000);
});
