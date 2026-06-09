import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeAcpSessionRuntime } from "./acp-runtime-close.js";

const { cancelSession, closeSession } = vi.hoisted(() => ({
  cancelSession: vi.fn(async () => {}),
  closeSession: vi.fn(async () => ({ runtimeClosed: true, metaCleared: true })),
}));

vi.mock("./manager.js", () => ({
  getAcpSessionManager: () => ({ cancelSession, closeSession }),
}));

const cfg = {} as OpenClawConfig;
const acpEntry = { acp: { backend: "acpx", agent: "codex", state: "running" } } as never;

beforeEach(() => {
  cancelSession.mockReset();
  cancelSession.mockResolvedValue(undefined);
  closeSession.mockReset();
  closeSession.mockResolvedValue({ runtimeClosed: true, metaCleared: true });
});

describe("closeAcpSessionRuntime", () => {
  it("no-ops when the entry has no ACP metadata", async () => {
    const outcome = await closeAcpSessionRuntime({
      cfg,
      sessionKey: "agent:main:plain",
      entry: { acp: undefined } as never,
      reason: "subagent-kill",
    });
    expect(outcome.attempted).toBe(false);
    expect(cancelSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("cancels then closes with terminal discard + clearMeta defaults", async () => {
    const outcome = await closeAcpSessionRuntime({
      cfg,
      sessionKey: "agent:codex:acp:x",
      entry: acpEntry,
      reason: "subagent-kill",
    });

    expect(cancelSession).toHaveBeenCalledWith({
      cfg,
      sessionKey: "agent:codex:acp:x",
      reason: "subagent-kill",
    });
    expect(closeSession).toHaveBeenCalledWith({
      cfg,
      sessionKey: "agent:codex:acp:x",
      reason: "subagent-kill",
      discardPersistentState: true,
      clearMeta: true,
      requireAcpSession: false,
      allowBackendUnavailable: true,
    });
    expect(outcome).toMatchObject({ attempted: true, runtimeClosed: true, metaCleared: true });
    expect(outcome.errors).toHaveLength(0);
  });

  it("still closes when cancel fails, capturing the error", async () => {
    const boom = new Error("cancel boom");
    cancelSession.mockRejectedValueOnce(boom);

    const outcome = await closeAcpSessionRuntime({
      cfg,
      sessionKey: "agent:codex:acp:y",
      entry: acpEntry,
      reason: "subagent-kill",
    });

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(outcome.attempted).toBe(true);
    expect(outcome.runtimeClosed).toBe(true);
    expect(outcome.errors).toContain(boom);
  });

  it("records a timeout without throwing when close hangs", async () => {
    closeSession.mockImplementationOnce(() => new Promise(() => {}));

    const outcome = await closeAcpSessionRuntime({
      cfg,
      sessionKey: "agent:codex:acp:z",
      entry: acpEntry,
      reason: "subagent-kill",
      timeoutMs: 5,
    });

    expect(outcome.attempted).toBe(true);
    expect(outcome.closeTimedOut).toBe(true);
    expect(outcome.runtimeClosed).toBe(false);
  });
});
