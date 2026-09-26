// Regression proof for the Computer Use operation-deadline clock domain.
// inspectCodexComputerUse seeds its operation deadline from the clock and hands
// remainingTimeoutMs() to the leased Codex app-server client, which measures its
// own timeouts with performance.now(). A wall-clock rewind (NTP / sleep resume)
// between seed and a later read would inflate the budget on a Date.now() seed;
// the monotonic seed does not. This drives the real CodexAppServerClient (real
// requestWithOverloadRetry / transport write path via createClientHarness)
// through the production setup owner and asserts the request timeoutMs stays
// bounded, and a stalled request settles by deadline timeout, when only the
// wall clock rewinds.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComputerUseRequest } from "./computer-use.test-support.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import { resolveCodexNativeConfigFenceKey } from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

const sharedClientMocks = vi.hoisted(() => ({
  assertCodexAppServerClientStartSelectionCurrent: vi.fn(),
  getLeasedSharedCodexAppServerClient: vi.fn(),
  readCodexAppServerClientDesktopGeneration: vi.fn(),
  readCodexAppServerClientProcessIdentity: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  waitForCodexAppServerClientDesktopGenerationDrain: vi.fn(),
}));

const managedProvisioningMocks = vi.hoisted(() => ({
  ensureCodexComputerUseSharedPluginCache: vi.fn(async () => ({
    status: "independent" as const,
    changed: false,
    message: "independent",
    removedStaleVersions: [],
    warnings: [],
  })),
  ensureCodexManagedBundledMarketplace: vi.fn(),
  ensureCodexComputerUseServiceApp: vi.fn(),
  resolveCodexManagedBundledMarketplaceSource: vi.fn(
    async (params: { candidates?: readonly unknown[] }) => params.candidates?.[0],
  ),
  resolveCodexComputerUseServiceAppSourcePath: vi.fn(
    async (params: { sourceAppCandidates?: readonly string[] }) => params.sourceAppCandidates?.[0],
  ),
}));

vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  ...sharedClientMocks,
}));

vi.mock("./computer-use-marketplace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./computer-use-marketplace.js")>()),
  ensureCodexManagedBundledMarketplace:
    managedProvisioningMocks.ensureCodexManagedBundledMarketplace,
  resolveCodexManagedBundledMarketplaceSource:
    managedProvisioningMocks.resolveCodexManagedBundledMarketplaceSource,
}));

vi.mock("./computer-use-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./computer-use-service.js")>()),
  ensureCodexComputerUseServiceApp: managedProvisioningMocks.ensureCodexComputerUseServiceApp,
  resolveCodexComputerUseServiceAppSourcePath:
    managedProvisioningMocks.resolveCodexComputerUseServiceAppSourcePath,
}));

vi.mock("./computer-use-cache.js", () => ({
  ensureCodexComputerUseSharedPluginCache:
    managedProvisioningMocks.ensureCodexComputerUseSharedPluginCache,
}));

vi.mock("./desktop-app-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./desktop-app-paths.js")>();
  return {
    ...actual,
    resolveMacOSDesktopCodexAppPathCandidates: (platform?: NodeJS.Platform) =>
      actual.resolveMacOSDesktopCodexAppPathCandidates(platform ?? "darwin"),
    resolveMacOSDesktopCodexBundledMarketplaceCandidates: (platform?: NodeJS.Platform) =>
      actual.resolveMacOSDesktopCodexBundledMarketplaceCandidates(platform ?? "darwin"),
  };
});

import { installCodexComputerUse } from "./computer-use.js";

describe("Codex Computer Use operation deadline clock domain", () => {
  afterEach(() => {
    vi.useRealTimers();
    sharedClientMocks.assertCodexAppServerClientStartSelectionCurrent.mockReset();
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.readCodexAppServerClientDesktopGeneration.mockReset();
    sharedClientMocks.readCodexAppServerClientProcessIdentity.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain.mockReset();
    managedProvisioningMocks.ensureCodexManagedBundledMarketplace.mockReset();
    managedProvisioningMocks.ensureCodexComputerUseServiceApp.mockReset();
    managedProvisioningMocks.ensureCodexComputerUseSharedPluginCache.mockReset();
    managedProvisioningMocks.resolveCodexManagedBundledMarketplaceSource.mockReset();
    managedProvisioningMocks.resolveCodexComputerUseServiceAppSourcePath.mockReset();
  });

  // Fake timers control setTimeout, Date.now(), and performance.now() together,
  // so the budget read is deterministic and never depends on scheduler/GC
  // latency. The wall clock alone rewinds (NTP / sleep resume) — the defect
  // trigger — while the monotonic clock advances only via vi.advanceTimersByTime.
  const operationTimeoutMs = 1_000;
  const wallSeed = 10_000;

  // Rewind the wall clock 120s after the seed read so a wall-clock deadline
  // would compute remaining = wallSeed + budget - (wallSeed - 120000) = 121000.
  const installDateNowRewind = () => {
    let dateCalls = 0;
    return vi.spyOn(Date, "now").mockImplementation(() => {
      dateCalls += 1;
      return dateCalls === 1 ? wallSeed : wallSeed - 120_000;
    });
  };

  const createDeadlineHarness = () => {
    const harness = createClientHarness();
    harness.client.setThreadSessionRequestGuard((options) =>
      acquireCodexNativeConfigFence(
        resolveCodexNativeConfigFenceKey({
          startOptions: resolveCodexAppServerRuntimeOptions({
            pluginConfig: {},
            managedCommandOrder: "desktop-first",
          }).start,
          agentDir: "/tmp/openclaw-computer-use-deadline-real-client-agent",
        }) as string,
        options,
      ),
    );
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(harness.client);
    return harness;
  };

  // Advance fake timers in 1ms steps until the harness records a frame write,
  // staying below operationTimeoutMs so the deadline does not expire first.
  const waitForFirstWrite = async (harness: ReturnType<typeof createClientHarness>) => {
    let advanced = 0;
    while (harness.writes.length === 0 && advanced < operationTimeoutMs) {
      await vi.advanceTimersByTimeAsync(1);
      advanced += 1;
    }
    expect(harness.writes.length).toBeGreaterThan(0);
  };

  // Drain the background install promise so no pending fake timer leaks into the
  // next test: close the client, advance past any remaining deadline, and await.
  const drainInstall = async (
    harness: ReturnType<typeof createClientHarness>,
    install: Promise<unknown>,
  ) => {
    const drained = install.catch(() => undefined);
    harness.client.close();
    // Advance past any remaining deadline so pending requests settle.
    for (let step = 0; step < operationTimeoutMs + 10; step += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    await drained;
  };

  it("keeps the leased request timeout bounded when only the wall clock rewinds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(wallSeed);
    const dateSpy = installDateNowRewind();

    const harness = createDeadlineHarness();
    // Passthrough spy: records the timeoutMs the setup owner hands to the real
    // client, then forwards unchanged so the real transport write path runs.
    const requestSpy = vi.spyOn(harness.client, "request");
    const fixture = createComputerUseRequest({ installed: false });

    const install = installCodexComputerUse({
      pluginConfig: {},
      agentDir: "/tmp/openclaw-computer-use-deadline-real-client-agent",
      timeoutMs: operationTimeoutMs,
    });

    try {
      // The install path acquires the native-config fence (no client request)
      // then issues experimentalFeature/enablement/set as its first client
      // request; advance fake timers until its frame is written.
      await waitForFirstWrite(harness);
      const firstFrame = JSON.parse(harness.writes[0] ?? "{}") as {
        id: number;
        method: string;
        params?: unknown;
      };
      expect(firstFrame.method).toBe("experimentalFeature/enablement/set");

      const firstCall = requestSpy.mock.calls.at(0);
      expect(firstCall?.[0]).toBe("experimentalFeature/enablement/set");
      const firstTimeoutMs = firstCall?.[2]?.timeoutMs;
      // Budget must never exceed operationTimeoutMs regardless of wall-clock
      // movement. Before the fix the rewound wall clock yielded ~121000ms here.
      // Under fake timers the monotonic clock has not advanced past the seed,
      // so remainingTimeoutMs() is exactly operationTimeoutMs — deterministic.
      expect(firstTimeoutMs).toBeLessThanOrEqual(operationTimeoutMs);
      expect(firstTimeoutMs).toBeGreaterThan(0);

      // Answer the first frame so the real client settles it before teardown.
      const firstResult = await fixture(firstFrame.method, firstFrame.params);
      harness.send({ id: firstFrame.id, result: firstResult ?? null });
    } finally {
      await drainInstall(harness, install);
      requestSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it("settles a stalled request by deadline timeout within the operation budget", async () => {
    // A stalled app-server request (no fixture response) must be settled by the
    // real client's deadline-driven timeout, not by manual client closure. The
    // monotonic clock advances only via fake timers, so the budget is exactly
    // operationTimeoutMs; a wall-clock rewind must not inflate it.
    vi.useFakeTimers();
    vi.setSystemTime(wallSeed);
    const dateSpy = installDateNowRewind();

    const harness = createDeadlineHarness();

    // Block the first request: never send a fixture response, so the real
    // client must settle it via its own deadline timeout.
    const install = installCodexComputerUse({
      pluginConfig: {},
      agentDir: "/tmp/openclaw-computer-use-deadline-real-client-agent",
      timeoutMs: operationTimeoutMs,
    });

    const settled = install.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    try {
      // Wait for the stalled frame to be written, then advance the monotonic
      // clock past the budget. Under the fix the client's deadline (seeded from
      // performance.now()) expires and the stalled request settles immediately.
      await waitForFirstWrite(harness);
      // Advance just past operationTimeoutMs. Before the fix the rewound wall
      // clock inflated the budget to ~121000ms, so advancing 1000ms does not
      // settle the stalled request.
      await vi.advanceTimersByTimeAsync(operationTimeoutMs);

      const error = await settled;
      // The real client settles the stalled request by a local deadline timeout.
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message.toLowerCase()).toContain("timed out");
    } finally {
      await drainInstall(harness, install);
      dateSpy.mockRestore();
    }
  });
});
