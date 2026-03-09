import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentCommandFromIngress: vi.fn(),
}));

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromIngress: mocks.agentCommandFromIngress,
}));

import { runAgent } from "./service.js";

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers explicit identity runId over opts.runId", async () => {
    mocks.agentCommandFromIngress.mockResolvedValue({
      payloads: [{ text: "ok", mediaUrl: null }],
      meta: { durationMs: 1 },
    });

    const result = await runAgent({
      source: "gateway",
      identity: { runId: "explicit-run", sessionKey: "agent:main:main" },
      opts: {
        message: "hi",
        runId: "opts-run",
        sessionKey: "agent:main:main",
        senderIsOwner: false,
      },
    });

    expect(mocks.agentCommandFromIngress).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "explicit-run",
        sessionKey: "agent:main:main",
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(result.identity.runId).toBe("explicit-run");
    expect(result.backend).toBe("legacy");
  });

  it("falls back to opts.runId before generating a new runId", async () => {
    mocks.agentCommandFromIngress.mockResolvedValue({
      payloads: [],
      meta: { durationMs: 2 },
    });

    const withOptsRunId = await runAgent({
      source: "agent-command",
      opts: {
        message: "hi",
        runId: "opts-run",
        senderIsOwner: true,
      },
    });
    expect(withOptsRunId.identity.runId).toBe("opts-run");

    const generated = await runAgent({
      source: "agent-command",
      opts: {
        message: "hi",
        senderIsOwner: true,
      },
    });
    expect(generated.identity.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("returns the legacy result with resolved identity metadata", async () => {
    mocks.agentCommandFromIngress.mockResolvedValue({
      payloads: [{ text: "done", mediaUrl: null }],
      meta: { durationMs: 3, stopReason: "completed" },
    });

    const result = await runAgent({
      source: "gateway",
      identity: { runId: "run-123", sessionKey: "agent:main:main", idempotencyKey: "idem-123" },
      opts: {
        message: "hi",
        senderIsOwner: false,
      },
    });

    expect(result).toEqual({
      payloads: [{ text: "done", mediaUrl: null }],
      meta: { durationMs: 3, stopReason: "completed" },
      identity: {
        runId: "run-123",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-123",
      },
      backend: "legacy",
    });
  });
});
