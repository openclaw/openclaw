import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

// Phase 9 P2 Discord Surface Overhaul: integration test verifying that when
// the ACP parent-stream relay suppresses an emission via planDelivery, a
// `delivery_outcome` system event is enqueued back to the ORIGINATING child
// session with messageClass=internal_narration.

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const planDeliveryMock = vi.fn();
const sendMessageMock = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

vi.mock("../infra/outbound/surface-policy.js", () => ({
  planDelivery: (args: unknown) => planDeliveryMock(args),
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
    }),
  );
});

let emitAgentEvent: typeof import("../infra/agent-events.js").emitAgentEvent;
let startAcpSpawnParentStreamRelay: typeof import("./acp-spawn-parent-stream.js").startAcpSpawnParentStreamRelay;

describe("acp-spawn-parent-stream delivery_outcome integration", () => {
  beforeAll(async () => {
    ({ emitAgentEvent } = await import("../infra/agent-events.js"));
    ({ startAcpSpawnParentStreamRelay } = await import("./acp-spawn-parent-stream.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    requestHeartbeatNowMock.mockReset();
    planDeliveryMock.mockReset();
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a delivery_outcome internal_narration event back to the child session on suppression", () => {
    // Force planDelivery to suppress every emission so the relay records the
    // outcome and enqueues a delivery_outcome event on the child session.
    planDeliveryMock.mockReturnValue({
      outcome: "suppress",
      reason: "class_suppressed_for_surface",
    });

    const handle = startAcpSpawnParentStreamRelay({
      runId: "run-1",
      parentSessionKey: "agent:main:parent",
      childSessionKey: "agent:main:child",
      agentId: "worker",
      emitStartNotice: false,
      deliveryContext: {
        channel: "discord",
        to: "channel:1",
        accountId: "default",
        threadId: "thread-1",
      },
    });

    // Simulate an assistant delta from the child — this path normally ships as
    // `progress` but the mocked planDelivery suppresses it.
    emitAgentEvent({
      runId: "run-1",
      stream: "assistant",
      data: { delta: "working on it...\n\n" },
    });

    // Find the delivery_outcome event enqueued on the child session.
    const childCalls = enqueueSystemEventMock.mock.calls.filter((call) => {
      const opts = call[1] as { sessionKey?: string; messageClass?: string } | undefined;
      return opts?.sessionKey === "agent:main:child";
    });
    expect(childCalls.length).toBeGreaterThanOrEqual(1);
    const [text, opts] = childCalls[0] ?? [];
    expect(String(text)).toContain("[delivery_outcome]");
    expect((opts as { messageClass?: string })?.messageClass).toBe("internal_narration");
    handle.dispose();
  });
});
