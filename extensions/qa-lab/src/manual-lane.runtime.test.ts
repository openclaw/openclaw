import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  cleanupTransportAfterGatewayStop,
  cleanupTransportBeforeGatewayStop,
  createQaTransportAdapter,
  startQaGatewayChild,
  gatewayStop,
  startQaLabServer,
  startQaProviderServer,
} = vi.hoisted(() => ({
  cleanupTransportAfterGatewayStop: vi.fn(),
  cleanupTransportBeforeGatewayStop: vi.fn(),
  createQaTransportAdapter: vi.fn(),
  startQaLabServer: vi.fn(),
  startQaGatewayChild: vi.fn(),
  gatewayStop: vi.fn(),
  startQaProviderServer: vi.fn(),
}));

// mock-isolation: Lifecycle ordering uses owned fake servers, not live HTTP listeners.
vi.mock("./lab-server.js", () => ({ startQaLabServer }));

// mock-isolation: The lane must not launch a real Gateway child during orchestration assertions.
vi.mock("./gateway-child.js", () => ({
  createQaGatewayChild: () => ({
    start: startQaGatewayChild,
    stop: gatewayStop,
  }),
}));

// mock-isolation: Provider startup and failure are controlled by the lifecycle fixture.
vi.mock("./providers/server-runtime.js", () => ({ startQaProviderServer }));

// mock-isolation: Synthetic transport cleanup is observed without loading live adapters.
vi.mock("./qa-transport-registry.js", () => ({ createQaTransportAdapter }));

import { runQaManualLane } from "./manual-lane.runtime.js";

function runLane(overrides: Partial<Parameters<typeof runQaManualLane>[0]> = {}) {
  return runQaManualLane({
    repoRoot: "/tmp/openclaw-repo",
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna-alt",
    message: "check the kickoff file",
    replySettleMs: 0,
    ...overrides,
  });
}

describe("runQaManualLane", () => {
  const gatewayCall = vi.fn();
  const mockStop = vi.fn();
  const labStop = vi.fn();
  let outboundReply: string | null;

  function expectCleanup(afterStop = true, providerStarted = true) {
    for (const stop of [gatewayStop, cleanupTransportBeforeGatewayStop, labStop]) {
      expect(stop).toHaveBeenCalledOnce();
    }
    expect(cleanupTransportAfterGatewayStop).toHaveBeenCalledTimes(afterStop ? 1 : 0);
    expect(mockStop).toHaveBeenCalledTimes(providerStarted ? 1 : 0);
  }

  beforeEach(() => {
    outboundReply = "Protocol note: mock reply.";
    vi.resetAllMocks();
    gatewayStop.mockResolvedValue({ process: "confirmed-stopped", errors: [] });
    cleanupTransportAfterGatewayStop.mockResolvedValue(undefined);
    cleanupTransportBeforeGatewayStop.mockResolvedValue(undefined);

    createQaTransportAdapter.mockResolvedValue({
      adapter: {
        buildAgentDelivery: () => ({ channel: "qa-channel", to: "dm:qa-operator" }),
      },
      cleanupBeforeGatewayStop: cleanupTransportBeforeGatewayStop,
      cleanupAfterGatewayStop: cleanupTransportAfterGatewayStop,
    });

    startQaLabServer.mockResolvedValue({
      listenUrl: "http://127.0.0.1:43124",
      baseUrl: "http://127.0.0.1:58000",
      state: {
        getSnapshot: () => ({
          messages:
            outboundReply === null
              ? []
              : [
                  {
                    direction: "outbound",
                    conversation: { id: "qa-operator" },
                    text: outboundReply,
                  },
                ],
        }),
      },
      stop: labStop,
    });

    startQaGatewayChild.mockResolvedValue({
      call: gatewayCall
        .mockResolvedValueOnce({ runId: "run-1" })
        .mockResolvedValueOnce({ status: "ok" }),
      stop: gatewayStop,
    });

    startQaProviderServer.mockImplementation(async (providerMode: string) =>
      providerMode === "mock-openai"
        ? {
            baseUrl: "http://127.0.0.1:44080",
            stop: mockStop,
          }
        : null,
    );
  });

  it.each([
    ["mock-openai", "mock-openai/gpt-5.5", "mock-openai/gpt-5.5-alt", "http://127.0.0.1:44080/v1"],
    ["live-frontier", "openai/gpt-5.6-luna", "openai/gpt-5.6-luna", undefined],
  ] as const)(
    "starts %s with the correct provider bootstrap",
    async (providerMode, primaryModel, alternateModel, providerBaseUrl) => {
      const result = await runLane({
        providerMode,
        primaryModel,
        alternateModel,
        timeoutMs: 5_000,
      });
      expect(startQaProviderServer).toHaveBeenCalledWith(providerMode, {
        modelRefs: [primaryModel, alternateModel],
      });
      const [gatewayOptions] = startQaGatewayChild.mock.calls[0] ?? [];
      expect(gatewayOptions).toMatchObject({
        repoRoot: "/tmp/openclaw-repo",
        providerMode,
        providerBaseUrl,
      });
      expect(startQaLabServer).toHaveBeenCalledWith({
        repoRoot: "/tmp/openclaw-repo",
        embeddedGateway: "disabled",
      });
      expect(result.reply).toBe("Protocol note: mock reply.");
      expectCleanup(true, providerMode === "mock-openai");
      expect(cleanupTransportBeforeGatewayStop.mock.invocationCallOrder[0]).toBeLessThan(
        gatewayStop.mock.invocationCallOrder[0] ?? 0,
      );
      expect(gatewayStop.mock.invocationCallOrder[0]).toBeLessThan(
        cleanupTransportAfterGatewayStop.mock.invocationCallOrder[0] ?? 0,
      );
    },
  );

  it.each([
    {
      label: "failed run despite a stale reply",
      waited: { status: "error", error: "authentication failed" },
      reply: "stale assistant reply",
      error: "authentication failed",
    },
    {
      label: "timed-out run without an outbound reply",
      waited: { status: "timeout", error: "provider stalled" },
      reply: null,
      error: "manual lane did not produce a successful reply",
    },
  ])("rejects a $label after resource cleanup", async ({ waited, reply, error }) => {
    outboundReply = reply;
    gatewayCall.mockReset().mockResolvedValueOnce({ runId: "run-1" }).mockResolvedValueOnce(waited);

    await expect(runLane()).rejects.toThrow(error);

    expectCleanup();
  });

  it.each([
    { process: "never-spawned", diagnostic: false },
    { process: "confirmed-stopped", diagnostic: true },
    { process: "unconfirmed", diagnostic: true },
  ] as const)(
    "retains startup failure and gates after-stop cleanup for $process",
    async ({ process, diagnostic }) => {
      const startupError = new Error("gateway startup failed");
      const cleanupError = new Error("gateway cleanup diagnostic");
      startQaGatewayChild.mockRejectedValueOnce(startupError);
      gatewayStop.mockResolvedValue({ process, errors: diagnostic ? [cleanupError] : [] });
      const failure = await runLane().catch((error: unknown) => error);
      expect(failure).toMatchObject({ cause: startupError });
      if (diagnostic) {
        expect(failure).toMatchObject({
          errors: [startupError, expect.objectContaining({ errors: [cleanupError] })],
        });
      }
      expect(cleanupTransportAfterGatewayStop).toHaveBeenCalledTimes(
        process === "unconfirmed" ? 0 : 1,
      );
      expect(mockStop).toHaveBeenCalledOnce();
      expect(labStop).toHaveBeenCalledOnce();
    },
  );

  it("continues provider and lab teardown when gateway stop fails", async () => {
    gatewayStop.mockResolvedValueOnce({
      process: "unconfirmed",
      errors: [new Error("gateway stop failed")],
    });

    await expect(runLane({ timeoutMs: 5_000 })).rejects.toThrow("gateway stop failed");
    expectCleanup(false);
  });

  it("caps the gateway client timeout for oversized manual waits", async () => {
    const result = await runLane({ timeoutMs: 9e15 });

    expect(result.waited).toEqual({ status: "ok" });
    expect(gatewayCall).toHaveBeenLastCalledWith(
      "agent.wait",
      { runId: "run-1", timeoutMs: 9e15 },
      { timeoutMs: MAX_TIMER_TIMEOUT_MS },
    );
  });
});
