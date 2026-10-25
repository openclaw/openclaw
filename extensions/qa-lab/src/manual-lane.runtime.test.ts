import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  afterStop: vi.fn(),
  beforeStop: vi.fn(),
  createTransport: vi.fn(),
  startLab: vi.fn(),
  startGateway: vi.fn(),
  stopGateway: vi.fn(),
  startProvider: vi.fn(),
}));

// mock-isolation: Fake lifecycle resources avoid listeners, Gateway children, and settle timers.
vi.mock("./lab-server.js", () => ({ startQaLabServer: mocks.startLab }));
vi.mock("./gateway-child.js", () => ({
  createQaGatewayChild: () => ({
    start: mocks.startGateway,
    stop: mocks.stopGateway,
  }),
}));
vi.mock("./providers/server-runtime.js", () => ({ startQaProviderServer: mocks.startProvider }));
vi.mock("./qa-transport-registry.js", () => ({ createQaTransportAdapter: mocks.createTransport }));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: async () => {},
}));

import { createQaBusState } from "./bus-state.js";
import { runQaManualLane } from "./manual-lane.runtime.js";

function runLane(overrides: Partial<Parameters<typeof runQaManualLane>[0]> = {}) {
  return runQaManualLane({
    repoRoot: "/tmp/openclaw-repo",
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna-alt",
    message: "check the kickoff file",
    ...overrides,
  });
}

describe("runQaManualLane", () => {
  const gatewayCall = vi.fn();
  const mockStop = vi.fn();
  const labStop = vi.fn();
  const state = createQaBusState();
  function setReply(text: string | null) {
    state.reset();
    if (text !== null) {
      state.addOutboundMessage({ to: "dm:qa-operator", text });
    }
  }

  function expectCleanup(afterStop = true, providerStarted = true) {
    for (const stop of [mocks.stopGateway, mocks.beforeStop, labStop]) {
      expect(stop).toHaveBeenCalledOnce();
    }
    expect(mocks.afterStop).toHaveBeenCalledTimes(afterStop ? 1 : 0);
    expect(mockStop).toHaveBeenCalledTimes(providerStarted ? 1 : 0);
  }

  beforeEach(() => {
    setReply("Protocol note: mock reply.");
    vi.resetAllMocks();
    mocks.stopGateway.mockResolvedValue({ process: "confirmed-stopped", errors: [] });
    mocks.afterStop.mockResolvedValue(undefined);
    mocks.beforeStop.mockResolvedValue(undefined);

    mocks.createTransport.mockResolvedValue({
      adapter: {
        buildAgentDelivery: () => ({ channel: "qa-channel", to: "dm:qa-operator" }),
      },
      cleanupBeforeGatewayStop: mocks.beforeStop,
      cleanupAfterGatewayStop: mocks.afterStop,
    });

    mocks.startLab.mockResolvedValue({
      listenUrl: "http://127.0.0.1:43124",
      baseUrl: "http://127.0.0.1:58000",
      state,
      stop: labStop,
    });

    mocks.startGateway.mockResolvedValue({
      call: gatewayCall
        .mockResolvedValueOnce({ runId: "run-1" })
        .mockResolvedValueOnce({ status: "ok" }),
    });

    mocks.startProvider.mockImplementation(async (providerMode: string) =>
      providerMode === "mock-openai" ? { baseUrl: "http://127.0.0.1:44080", stop: mockStop } : null,
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
      const [gatewayOptions] = mocks.startGateway.mock.calls[0] ?? [];
      expect(gatewayOptions).toMatchObject({
        providerMode,
        providerBaseUrl,
      });
      expect(result.reply).toBe("Protocol note: mock reply.");
      expectCleanup(true, providerMode === "mock-openai");
      expect(mocks.beforeStop.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.stopGateway.mock.invocationCallOrder[0] ?? 0,
      );
      expect(mocks.stopGateway.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.afterStop.mock.invocationCallOrder[0] ?? 0,
      );
    },
  );

  it.each([
    [
      "failed run despite a stale reply",
      { status: "error", error: "authentication failed" },
      "stale assistant reply",
      "authentication failed",
    ],
    [
      "timed-out run without an outbound reply",
      { status: "timeout", error: "provider stalled" },
      null,
      "manual lane did not produce a successful reply",
    ],
  ] as const)("rejects a %s after resource cleanup", async (_label, waited, reply, error) => {
    setReply(reply);
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
      mocks.startGateway.mockRejectedValueOnce(startupError);
      mocks.stopGateway.mockResolvedValue({ process, errors: diagnostic ? [cleanupError] : [] });
      const failure = await runLane().catch((error: unknown) => error);
      expect(failure).toMatchObject({ cause: startupError });
      if (diagnostic) {
        expect(failure).toMatchObject({
          errors: [startupError, expect.objectContaining({ errors: [cleanupError] })],
        });
      }
      expect(mocks.afterStop).toHaveBeenCalledTimes(process === "unconfirmed" ? 0 : 1);
      expect(mockStop).toHaveBeenCalledOnce();
      expect(labStop).toHaveBeenCalledOnce();
    },
  );

  it("continues provider and lab teardown when gateway stop fails", async () => {
    mocks.stopGateway.mockResolvedValueOnce({
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
