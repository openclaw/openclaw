// Browser regression test: tab-discovery poll honors AbortSignal.
import { afterEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import { OPEN_TAB_DISCOVERY_POLL_MS } from "./server-context.constants.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import type { ProfileRuntimeState } from "./server-context.types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeProfileRuntime(): ProfileRuntimeState {
  return {
    profile: {
      name: "openclaw",
      cdpPort: 18800,
      cdpUrl: "http://127.0.0.1:18800",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      color: "#FF4500",
      driver: "openclaw",
      headless: true,
      headlessSource: "config",
      attachOnly: false,
    },
    running: { pid: 1234, proc: { on: vi.fn() } },
    lastTargetId: null,
  } as unknown as ProfileRuntimeState;
}

describe("browser tab discovery poll abort", () => {
  it("rejects promptly when AbortSignal fires during the discovery poll delay", async () => {
    vi.useRealTimers();

    const runtime = makeProfileRuntime();

    // Return a local-managed tab with no wsUrl. supportsPerTabWs is true, so
    // candidates becomes empty and ensureTabAvailable enters the poll loop at
    // server-context.selection.ts:149-167 instead of resolving immediately.
    const tabWithoutWsUrl = {
      targetId: "PAGE",
      title: "page",
      url: "http://127.0.0.1:3001",
      type: "page" as const,
    };
    const listTabs = vi.fn(async () => [tabWithoutWsUrl]);

    const ops = createProfileSelectionOps({
      profile: runtime.profile,
      runtime,
      getCdpControlPolicy: () => undefined,
      ensureBrowserAvailable: async () => {},
      listTabs,
      openTab: async () => tabWithoutWsUrl,
    });

    const controller = new AbortController();
    const ensurePromise = ops.ensureTabAvailable(undefined, { signal: controller.signal });

    // Let the first two reads and the start of the poll loop run.
    await sleep(OPEN_TAB_DISCOVERY_POLL_MS / 4);

    const abortAt = performance.now();
    controller.abort();

    await expect(ensurePromise).rejects.toThrow(/aborted/i);
    const elapsedMs = performance.now() - abortAt;

    // Without the fix the poll would wait the full OPEN_TAB_DISCOVERY_POLL_MS
    // before the next loop iteration checks the signal. With the fix the abort
    // listener interrupts the sleep immediately.
    expect(elapsedMs).toBeLessThan(OPEN_TAB_DISCOVERY_POLL_MS / 2);
  });
});
