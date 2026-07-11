// Signal monitor drains accepted debounce work before daemon stop on abort.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  config,
  createMockSignalDaemonHandle,
  createSignalToolResultConfig,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

const { monitorSignalProvider } = await import("./monitor.js");

const { streamMock, spawnSignalDaemonMock, replyMock, waitForTransportReadyMock } =
  getSignalToolResultTestMocks();

const SIGNAL_BASE_URL = "http://127.0.0.1:8080";

function createMonitorRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never,
  };
}

describe("monitorSignalProvider debounce drain", () => {
  it("drains accepted debounced inbound before stopping the Signal daemon", async () => {
    const runtime = createMonitorRuntime();
    const order: string[] = [];
    const abortController = new AbortController();

    setSignalToolResultTestConfig(
      createSignalToolResultConfig({
        // Keep dm open so the synthetic receive event is accepted.
        dmPolicy: "open",
        allowFrom: ["*"],
      }),
    );
    // Long debounce so the timer alone cannot flush before teardown.
    (config as { messages?: Record<string, unknown> }).messages = {
      ...(config.messages as Record<string, unknown> | undefined),
      responsePrefix: "PFX",
      inbound: { debounceMs: 60_000 },
    };

    const stop = vi.fn(() => {
      order.push("daemon-stop");
    });
    spawnSignalDaemonMock.mockReturnValue(
      createMockSignalDaemonHandle({
        stop: stop as unknown as ReturnType<typeof vi.fn>,
      }),
    );
    waitForTransportReadyMock.mockResolvedValue(undefined);

    replyMock.mockImplementation(async () => {
      order.push("dispatch");
      return { text: "ok" };
    });

    streamMock.mockImplementation(
      async (params: {
        onEvent: (event: { event: string; data: string }) => void;
        abortSignal?: AbortSignal;
      }) => {
        params.onEvent({
          event: "receive",
          data: JSON.stringify({
            envelope: {
              sourceNumber: "+15550001111",
              sourceName: "Alice",
              timestamp: 1_700_000_000_000,
              dataMessage: {
                message: "accepted before monitor abort",
                attachments: [],
              },
            },
          }),
        });
        // Let the tracked handleEvent task finish enqueue (timer scheduled).
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(order).not.toContain("dispatch");
        abortController.abort(new Error("monitor stopped"));
        if (params.abortSignal?.aborted) {
          return;
        }
        await new Promise<void>((resolve) => {
          params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );

    await monitorSignalProvider({
      config: config as OpenClawConfig,
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime,
      waitForTransportReady: waitForTransportReadyMock as never,
    });

    expect(order).toEqual(["dispatch", "daemon-stop"]);
    expect(stop).toHaveBeenCalled();
  });
});
