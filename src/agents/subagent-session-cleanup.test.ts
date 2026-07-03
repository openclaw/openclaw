import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { callGateway as defaultCallGateway, CallGatewayOptions } from "../gateway/call.js";
import {
  deleteSubagentSessionForCleanup,
  resetSubagentSessionCleanupForTests,
} from "./subagent-session-cleanup.js";

const hasLiveOrRecentlyDispatchedContinuationWorkMock = vi.hoisted(() => vi.fn(() => false));
const hasRecoverablePendingDelegateMock = vi.hoisted(() => vi.fn(() => false));
const countActiveDescendantRunsMock = vi.hoisted(() => vi.fn(() => 0));

vi.mock("../auto-reply/continuation/work-store.js", () => ({
  hasLiveOrRecentlyDispatchedContinuationWork: hasLiveOrRecentlyDispatchedContinuationWorkMock,
}));

vi.mock("../auto-reply/continuation/delegate-store.js", () => ({
  hasRecoverablePendingDelegate: hasRecoverablePendingDelegateMock,
}));

vi.mock("./subagent-registry-runtime.js", () => ({
  countActiveDescendantRuns: countActiveDescendantRunsMock,
}));

describe("deleteSubagentSessionForCleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSubagentSessionCleanupForTests();
    hasLiveOrRecentlyDispatchedContinuationWorkMock.mockReset().mockReturnValue(false);
    hasRecoverablePendingDelegateMock.mockReset().mockReturnValue(false);
    countActiveDescendantRunsMock.mockReset().mockReturnValue(0);
  });

  afterEach(() => {
    resetSubagentSessionCleanupForTests();
    vi.useRealTimers();
  });

  it("defers deletion while accepted descendant delegate runs still depend on the child session", async () => {
    const callGateway = vi.fn(async function mockCallGateway<T = Record<string, unknown>>(
      _opts: CallGatewayOptions,
    ): Promise<T> {
      return { ok: true } as T;
    }) as typeof defaultCallGateway;
    countActiveDescendantRunsMock.mockReturnValueOnce(1).mockReturnValueOnce(0);

    await deleteSubagentSessionForCleanup({
      callGateway,
      childSessionKey: "agent:main:subagent:child",
    });
    expect(callGateway).not.toHaveBeenCalled();
    expect(countActiveDescendantRunsMock).toHaveBeenCalledWith("agent:main:subagent:child");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:child",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });
});
