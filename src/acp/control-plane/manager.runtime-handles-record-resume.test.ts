import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { reconcileManagerRuntimeSessionIdentifiers } from "./manager.identity-reconcile.js";
import { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import { ensureManagerRuntimeHandle } from "./manager.runtime-handle-ensure.js";
import { runManagerGetSessionStatus } from "./manager.status.js";
import type {
  EnsureManagerRuntimeHandle,
  SessionAcpMeta,
  WriteManagerSessionMeta,
} from "./manager.types.js";

const target = { sessionKey: "agent:claude:acp:record-resume", agentId: "claude" };

function createRecordResumeFixture(params?: {
  handle?: Partial<AcpRuntimeHandle>;
  resumeReady?: boolean;
}) {
  let meta: SessionAcpMeta = {
    backend: "acpx",
    agent: "claude",
    runtimeSessionName: "completed-runtime",
    mode: "oneshot",
    state: "idle",
    lastActivityAt: 1,
    identity: {
      state: "resolved",
      source: "status",
      acpxRecordId: `${target.sessionKey}:oneshot:original-record`,
      acpxSessionId: "completed-session",
      agentSessionId: "old-agent-session",
      sessionResumeSupported: true,
      sessionResumeReady: params?.resumeReady ?? true,
      lastUpdatedAt: 1,
    },
  };
  const handle: AcpRuntimeHandle = {
    ...target,
    backend: "acpx",
    runtimeSessionName: "resumed-runtime",
    acpxRecordId: target.sessionKey,
    backendSessionId: "completed-session",
    ...params?.handle,
  };
  const runtime = {
    ensureSession: vi.fn<AcpRuntime["ensureSession"]>(async () => ({ ...handle })),
    getStatus: vi.fn<NonNullable<AcpRuntime["getStatus"]>>(async ({ handle: statusHandle }) => ({
      backendSessionId: statusHandle.backendSessionId,
      agentSessionId: statusHandle.agentSessionId,
    })),
    async *runTurn() {},
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } satisfies AcpRuntime;
  const cache = new ManagerRuntimeHandleCache();
  const entry = { sessionId: "core-session", updatedAt: 1 };
  const writeSessionMeta: WriteManagerSessionMeta = async (input) => {
    const next = input.mutate(meta, entry);
    if (next) {
      meta = next;
    }
    return entry;
  };
  const ensure: EnsureManagerRuntimeHandle = (input) =>
    ensureManagerRuntimeHandle({
      ...input,
      deps: { requireRuntimeBackend: () => ({ id: "acpx", runtime }) },
      runtimeHandles: cache,
      writeSessionMeta,
    });
  return {
    runtime,
    cache,
    meta: () => meta,
    ensure: () => ensure({ cfg: {}, ...target, meta }),
    status: () =>
      runManagerGetSessionStatus({
        cfg: {},
        ...target,
        throwIfAborted: () => {},
        resolveSession: () => ({ kind: "ready", ...target, meta, entry }),
        ensureRuntimeHandle: ensure,
        reconcileRuntimeSessionIdentifiers: (input) =>
          reconcileManagerRuntimeSessionIdentifiers({
            ...input,
            writeSessionMeta,
            setCachedHandle: (cacheTarget, cachedHandle) => {
              const cached = cache.get(cacheTarget);
              if (cached) {
                cached.handle = cachedHandle;
              }
            },
          }),
      }),
  };
}

describe("one-shot resume across physical record replacement", () => {
  it("keeps confirmed resume readiness after status and resumes again after cache loss", async () => {
    const fixture = createRecordResumeFixture();

    const status = await fixture.status();
    expect(status.identity).toMatchObject({
      acpxRecordId: target.sessionKey,
      acpxSessionId: "completed-session",
      sessionResumeSupported: true,
      sessionResumeReady: true,
    });
    expect(status.identity?.agentSessionId).toBeUndefined();
    expect(fixture.meta().identity).toEqual(status.identity);

    await fixture.cache.close({ ...target, reason: "cache-loss" });
    const resumed = await fixture.ensure();
    expect(fixture.runtime.ensureSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: "oneshot", resumeSessionId: "completed-session" }),
    );
    expect(resumed.meta.identity?.sessionResumeReady).toBe(true);
    expect(resumed.handle.agentSessionId).toBeUndefined();
    expect(resumed.handle.acpxRecordId).toBe(target.sessionKey);
  });

  it.each([
    { name: "different session", handle: { backendSessionId: "different-session" } },
    { name: "different backend", handle: { backend: "other-backend" } },
    {
      name: "agent ID without protocol ID confirmation",
      handle: { backendSessionId: undefined, agentSessionId: "completed-session" },
    },
  ])("does not inherit resume flags for $name", async ({ name: _name, ...params }) => {
    const fixture = createRecordResumeFixture(params);

    const result = await fixture.ensure();

    expect(result.meta.identity?.sessionResumeReady).toBeUndefined();
    expect(result.meta.identity?.sessionResumeSupported).toBeUndefined();
    expect(result.meta.identity?.agentSessionId).not.toBe("old-agent-session");
    expect(result.meta.identity?.acpxRecordId).toBe(target.sessionKey);
    expect(fixture.meta().identity).toEqual(result.meta.identity);
  });

  it("does not confirm readiness without an explicit resume request", async () => {
    const fixture = createRecordResumeFixture({ resumeReady: false });

    const result = await fixture.ensure();

    expect(fixture.runtime.ensureSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ resumeSessionId: expect.any(String) }),
    );
    expect(result.meta.identity?.sessionResumeReady).toBeUndefined();
    expect(result.meta.identity?.agentSessionId).toBeUndefined();
  });

  it("keeps newly reported capability and agent ID authoritative", async () => {
    const fixture = createRecordResumeFixture({
      handle: { sessionResumeSupported: false, agentSessionId: "new-agent-session" },
    });

    const result = await fixture.ensure();

    expect(result.meta.identity).toMatchObject({
      acpxRecordId: target.sessionKey,
      acpxSessionId: "completed-session",
      agentSessionId: "new-agent-session",
      sessionResumeSupported: false,
      sessionResumeReady: true,
    });
  });
});
