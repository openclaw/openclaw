import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileManagerRuntimeSessionIdentifiers } from "./manager.identity-reconcile.js";
import type { SessionAcpMeta } from "./manager.types.js";

const handle: AcpRuntimeHandle = {
  sessionKey: "agent:claude:acp:child",
  agentId: "claude",
  backend: "acpx",
  runtimeSessionName: "runtime-child",
};

const meta: SessionAcpMeta = {
  backend: "acpx",
  agent: "claude",
  runtimeSessionName: "runtime-child",
  mode: "oneshot",
  state: "running",
  lastActivityAt: 1,
};

describe("manager identity reconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds a runtime status refresh", async () => {
    vi.useFakeTimers();
    let statusSignal: AbortSignal | undefined;
    const runtime = {
      getStatus: vi.fn(
        async (input: { signal?: AbortSignal }) =>
          await new Promise<never>(() => {
            statusSignal = input.signal;
          }),
      ),
    } as unknown as AcpRuntime;
    const writeSessionMeta = vi.fn();

    const reconciliation = reconcileManagerRuntimeSessionIdentifiers({
      cfg: {},
      sessionKey: handle.sessionKey,
      agentId: "claude",
      runtime,
      handle,
      meta,
      failOnStatusError: false,
      statusTimeoutMs: 1_000,
      setCachedHandle: vi.fn(),
      writeSessionMeta,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(statusSignal?.aborted).toBe(false);
    expect(writeSessionMeta).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(await reconciliation).toMatchObject({ handle, meta });
    expect(statusSignal?.aborted).toBe(true);
    expect(writeSessionMeta).not.toHaveBeenCalled();
  });

  it("carries the owner and fences a one-shot identity write after actor rotation", async () => {
    let current = true;
    const isCurrentActor = () => current;
    const writeSessionMeta = vi.fn<
      Parameters<typeof reconcileManagerRuntimeSessionIdentifiers>[0]["writeSessionMeta"]
    >(async (input) => {
      expect(input.agentId).toBe("claude");
      expect(input.isCurrentActor).toBe(isCurrentActor);
      current = false;
      expect(input.mutate(meta, { sessionId: "child", updatedAt: 1 })).toBeUndefined();
      return null;
    });
    const setCachedHandle = vi.fn();
    const runtime = {
      ensureSession: vi.fn(),
      async *runTurn() {},
      cancel: vi.fn(),
      close: vi.fn(),
    } satisfies AcpRuntime;

    await expect(
      reconcileManagerRuntimeSessionIdentifiers({
        cfg: {},
        sessionKey: handle.sessionKey,
        agentId: "claude",
        runtime,
        handle,
        meta,
        runtimeStatus: { backendSessionId: "completed-session" },
        failOnStatusError: false,
        isCurrentActor,
        setCachedHandle,
        writeSessionMeta,
      }),
    ).rejects.toMatchObject({ detailCode: "SESSION_ACTOR_SUPERSEDED" });
    expect(writeSessionMeta).toHaveBeenCalledOnce();
    expect(setCachedHandle).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: handle.sessionKey, agentId: "claude" }),
      expect.objectContaining({ agentId: "claude", backendSessionId: "completed-session" }),
    );
  });
});
