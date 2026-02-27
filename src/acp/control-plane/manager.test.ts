import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AcpSessionRuntimeOptions, SessionAcpMeta } from "../../config/sessions/types.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import type { AcpRuntime, AcpRuntimeCapabilities } from "../runtime/types.js";

const hoisted = vi.hoisted(() => {
  const listAcpSessionEntriesMock = vi.fn();
  const readAcpSessionEntryMock = vi.fn();
  const upsertAcpSessionMetaMock = vi.fn();
  const requireAcpRuntimeBackendMock = vi.fn();
  return {
    listAcpSessionEntriesMock,
    readAcpSessionEntryMock,
    upsertAcpSessionMetaMock,
    requireAcpRuntimeBackendMock,
  };
});

vi.mock("../runtime/session-meta.js", () => ({
  listAcpSessionEntries: (params: unknown) => hoisted.listAcpSessionEntriesMock(params),
  readAcpSessionEntry: (params: unknown) => hoisted.readAcpSessionEntryMock(params),
  upsertAcpSessionMeta: (params: unknown) => hoisted.upsertAcpSessionMetaMock(params),
}));

vi.mock("../runtime/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/registry.js")>();
  return {
    ...actual,
    requireAcpRuntimeBackend: (backendId?: string) =>
      hoisted.requireAcpRuntimeBackendMock(backendId),
  };
});

const { AcpSessionManager } = await import("./manager.js");

const baseCfg = {
  acp: {
    enabled: true,
    backend: "acpx",
    dispatch: { enabled: true },
  },
} as const;

function createRuntime(): {
  runtime: AcpRuntime;
  ensureSession: ReturnType<typeof vi.fn>;
  runTurn: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getCapabilities: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  setConfigOption: ReturnType<typeof vi.fn>;
} {
  const ensureSession = vi.fn(
    async (input: { sessionKey: string; agent: string; mode: "persistent" | "oneshot" }) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
    }),
  );
  const runTurn = vi.fn(async function* () {
    yield { type: "done" as const };
  });
  const cancel = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const getCapabilities = vi.fn(
    async (): Promise<AcpRuntimeCapabilities> => ({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
    }),
  );
  const getStatus = vi.fn(async () => ({
    summary: "status=alive",
    details: { status: "alive" },
  }));
  const setMode = vi.fn(async () => {});
  const setConfigOption = vi.fn(async () => {});
  return {
    runtime: {
      ensureSession,
      runTurn,
      getCapabilities,
      getStatus,
      setMode,
      setConfigOption,
      cancel,
      close,
    },
    ensureSession,
    runTurn,
    cancel,
    close,
    getCapabilities,
    getStatus,
    setMode,
    setConfigOption,
  };
}

function readySessionMeta() {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  };
}

function extractStatesFromUpserts(): SessionAcpMeta["state"][] {
  const states: SessionAcpMeta["state"][] = [];
  for (const [firstArg] of hoisted.upsertAcpSessionMetaMock.mock.calls) {
    const payload = firstArg as {
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const current = readySessionMeta();
    const next = payload.mutate(current, { acp: current });
    if (next?.state) {
      states.push(next.state);
    }
  }
  return states;
}

function extractRuntimeOptionsFromUpserts(): Array<AcpSessionRuntimeOptions | undefined> {
  const options: Array<AcpSessionRuntimeOptions | undefined> = [];
  for (const [firstArg] of hoisted.upsertAcpSessionMetaMock.mock.calls) {
    const payload = firstArg as {
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const current = readySessionMeta();
    const next = payload.mutate(current, { acp: current });
    if (next) {
      options.push(next.runtimeOptions);
    }
  }
  return options;
}

describe("AcpSessionManager", () => {
  beforeEach(() => {
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.readAcpSessionEntryMock.mockReset();
    hoisted.upsertAcpSessionMetaMock.mockReset().mockResolvedValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockReset();
  });

  it("marks ACP-shaped sessions without metadata as stale", () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue(null);
    const manager = new AcpSessionManager();

    const resolved = manager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
    });

    expect(resolved.kind).toBe("stale");
    if (resolved.kind !== "stale") {
      return;
    }
    expect(resolved.error.code).toBe("ACP_SESSION_INIT_FAILED");
    expect(resolved.error.message).toContain("ACP metadata is missing");
  });

  it("serializes concurrent turns for the same ACP session", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    let inFlight = 0;
    let maxInFlight = 0;
    runtimeState.runTurn.mockImplementation(async function* (_input: { requestId: string }) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield { type: "done" };
      } finally {
        inFlight -= 1;
      }
    });

    const manager = new AcpSessionManager();
    const first = manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    const second = manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });
    await Promise.all([first, second]);

    expect(maxInFlight).toBe(1);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("runs turns for different ACP sessions in parallel", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
      };
    });

    let inFlight = 0;
    let maxInFlight = 0;
    runtimeState.runTurn.mockImplementation(async function* () {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        yield { type: "done" as const };
      } finally {
        inFlight -= 1;
      }
    });

    const manager = new AcpSessionManager();
    await Promise.all([
      manager.runTurn({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-a",
        text: "first",
        mode: "prompt",
        requestId: "r1",
      }),
      manager.runTurn({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-b",
        text: "second",
        mode: "prompt",
        requestId: "r2",
      }),
    ]);

    expect(maxInFlight).toBe(2);
  });

  it("reuses runtime session handles for repeat turns in the same manager process", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("rehydrates runtime handles after a manager restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const managerA = new AcpSessionManager();
    await managerA.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "before restart",
      mode: "prompt",
      requestId: "r1",
    });
    const managerB = new AcpSessionManager();
    await managerB.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "after restart",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
  });

  it("enforces acp.maxConcurrentSessions when opening new runtime handles", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
      };
    });
    const limitedCfg = {
      acp: {
        ...baseCfg.acp,
        maxConcurrentSessions: 1,
      },
    } as OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: limitedCfg,
      sessionKey: "agent:codex:acp:session-a",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });

    await expect(
      manager.runTurn({
        cfg: limitedCfg,
        sessionKey: "agent:codex:acp:session-b",
        text: "second",
        mode: "prompt",
        requestId: "r2",
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("max concurrent sessions"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("enforces acp.maxConcurrentSessions during initializeSession", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-a",
      storeSessionKey: "agent:codex:acp:session-a",
      acp: readySessionMeta(),
    });
    const limitedCfg = {
      acp: {
        ...baseCfg.acp,
        maxConcurrentSessions: 1,
      },
    } as OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: limitedCfg,
      sessionKey: "agent:codex:acp:session-a",
      agent: "codex",
      mode: "persistent",
    });

    await expect(
      manager.initializeSession({
        cfg: limitedCfg,
        sessionKey: "agent:codex:acp:session-b",
        agent: "codex",
        mode: "persistent",
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("max concurrent sessions"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("drops cached runtime handles when close tolerates backend-unavailable errors", async () => {
    const runtimeState = createRuntime();
    runtimeState.close.mockRejectedValueOnce(
      new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "runtime temporarily unavailable"),
    );
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
      };
    });
    const limitedCfg = {
      acp: {
        ...baseCfg.acp,
        maxConcurrentSessions: 1,
      },
    } as OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: limitedCfg,
      sessionKey: "agent:codex:acp:session-a",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });

    const closeResult = await manager.closeSession({
      cfg: limitedCfg,
      sessionKey: "agent:codex:acp:session-a",
      reason: "manual-close",
      allowBackendUnavailable: true,
    });
    expect(closeResult.runtimeClosed).toBe(false);
    expect(closeResult.runtimeNotice).toContain("temporarily unavailable");

    await expect(
      manager.runTurn({
        cfg: limitedCfg,
        sessionKey: "agent:codex:acp:session-b",
        text: "second",
        mode: "prompt",
        requestId: "r2",
      }),
    ).resolves.toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
  });

  it("evicts idle cached runtimes before enforcing max concurrent limits", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-23T00:00:00.000Z"));
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
        return {
          sessionKey,
          storeSessionKey: sessionKey,
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `runtime:${sessionKey}`,
          },
        };
      });
      const cfg = {
        acp: {
          ...baseCfg.acp,
          maxConcurrentSessions: 1,
          runtime: {
            ttlMinutes: 0.01,
          },
        },
      } as OpenClawConfig;

      const manager = new AcpSessionManager();
      await manager.runTurn({
        cfg,
        sessionKey: "agent:codex:acp:session-a",
        text: "first",
        mode: "prompt",
        requestId: "r1",
      });

      vi.advanceTimersByTime(2_000);
      await manager.runTurn({
        cfg,
        sessionKey: "agent:codex:acp:session-b",
        text: "second",
        mode: "prompt",
        requestId: "r2",
      });

      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
      expect(runtimeState.close).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "idle-evicted",
          handle: expect.objectContaining({
            sessionKey: "agent:codex:acp:session-a",
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks ACP turn latency and error-code observability", async () => {
    const runtimeState = createRuntime();
    runtimeState.runTurn.mockImplementation(async function* (input: { requestId: string }) {
      if (input.requestId === "fail") {
        throw new Error("runtime exploded");
      }
      yield { type: "done" as const };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "ok",
      mode: "prompt",
      requestId: "ok",
    });
    await expect(
      manager.runTurn({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "boom",
        mode: "prompt",
        requestId: "fail",
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
    });

    const snapshot = manager.getObservabilitySnapshot(baseCfg);
    expect(snapshot.turns.completed).toBe(1);
    expect(snapshot.turns.failed).toBe(1);
    expect(snapshot.turns.active).toBe(0);
    expect(snapshot.turns.queueDepth).toBe(0);
    expect(snapshot.errorsByCode.ACP_TURN_FAILED).toBe(1);
  });

  it("rolls back ensured runtime sessions when metadata persistence fails", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));

    const manager = new AcpSessionManager();
    await expect(
      manager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        agent: "codex",
        mode: "persistent",
      }),
    ).rejects.toThrow("disk full");
    expect(runtimeState.close).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "init-meta-failed",
        handle: expect.objectContaining({
          sessionKey: "agent:codex:acp:session-1",
        }),
      }),
    );
  });

  it("preempts an active turn on cancel and returns to idle state", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    let enteredRun = false;
    runtimeState.runTurn.mockImplementation(async function* (input: { signal?: AbortSignal }) {
      enteredRun = true;
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) {
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done" as const, stopReason: "cancel" };
    });

    const manager = new AcpSessionManager();
    const runPromise = manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "long task",
      mode: "prompt",
      requestId: "run-1",
    });
    await vi.waitFor(() => {
      expect(enteredRun).toBe(true);
    });

    await manager.cancelSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      reason: "manual-cancel",
    });
    await runPromise;

    expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
    expect(runtimeState.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual-cancel",
      }),
    );
    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("idle");
    expect(states).not.toContain("error");
  });

  it("cleans actor-tail bookkeeping after session turns complete", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
      };
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      yield { type: "done" as const };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-a",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-b",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    const internals = manager as unknown as {
      actorTailBySession: Map<string, Promise<void>>;
    };
    expect(internals.actorTailBySession.size).toBe(0);
  });

  it("surfaces backend failures raised after a done event", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      yield { type: "done" as const };
      throw new Error("acpx exited with code 1");
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "do work",
        mode: "prompt",
        requestId: "run-1",
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "acpx exited with code 1",
    });

    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("error");
    expect(states.at(-1)).toBe("error");
  });

  it("persists runtime mode changes through setSessionRuntimeMode", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    const options = await manager.setSessionRuntimeMode({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      runtimeMode: "plan",
    });

    expect(runtimeState.setMode).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
      }),
    );
    expect(options.runtimeMode).toBe("plan");
    expect(extractRuntimeOptionsFromUpserts().some((entry) => entry?.runtimeMode === "plan")).toBe(
      true,
    );
  });

  it("reapplies persisted controls on next turn after runtime option updates", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeOptions: {
        runtimeMode: "plan",
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey =
        (paramsUnknown as { sessionKey?: string }).sessionKey ?? "agent:codex:acp:session-1";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      key: "model",
      value: "openai-codex/gpt-5.3-codex",
    });
    expect(runtimeState.setMode).not.toHaveBeenCalled();

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expect(runtimeState.setMode).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
      }),
    );
  });

  it("reconciles persisted ACP session identifiers from runtime status after a turn", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-1",
      backendSessionId: "acpx-stale",
      agentSessionId: "agent-stale",
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-fresh",
      agentSessionId: "agent-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-stale",
        agentSessionId: "agent-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey =
        (paramsUnknown as { sessionKey?: string }).sessionKey ?? "agent:codex:acp:session-1";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-fresh");
    expect(currentMeta.identity?.agentSessionId).toBe("agent-fresh");
  });

  it("reconciles pending ACP identities during startup scan", async () => {
    const runtimeState = createRuntime();
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      acpxRecordId: "acpx-record-1",
      backendSessionId: "acpx-session-1",
      agentSessionId: "agent-session-1",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    const sessionKey = "agent:codex:acp:session-1";
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey,
        storeSessionKey: sessionKey,
        entry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          acp: currentMeta,
        },
        acp: currentMeta,
      },
    ]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 1, resolved: 1, failed: 0 });
    expect(currentMeta.identity?.state).toBe("resolved");
    expect(currentMeta.identity?.acpxRecordId).toBe("acpx-record-1");
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-session-1");
    expect(currentMeta.identity?.agentSessionId).toBe("agent-session-1");
  });

  it("skips startup identity reconciliation for already resolved sessions", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:session-1";
    const resolvedMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-1",
        agentSessionId: "agent-sid-1",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey,
        storeSessionKey: sessionKey,
        entry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          acp: resolvedMeta,
        },
        acp: resolvedMeta,
      },
    ]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, resolved: 0, failed: 0 });
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
  });

  it("preserves existing ACP session identifiers when ensure returns none", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-2",
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: {
        ...readySessionMeta(),
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-stable",
          agentSessionId: "agent-stable",
          lastUpdatedAt: Date.now(),
        },
      },
    });

    const manager = new AcpSessionManager();
    const status = await manager.getSessionStatus({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
    });

    expect(status.identity?.acpxSessionId).toBe("acpx-stable");
    expect(status.identity?.agentSessionId).toBe("agent-stable");
  });

  it("applies persisted runtime options before running turns", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: {
        ...readySessionMeta(),
        runtimeOptions: {
          runtimeMode: "plan",
          model: "openai-codex/gpt-5.3-codex",
          permissionProfile: "strict",
          timeoutSeconds: 120,
        },
      },
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expect(runtimeState.setMode).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
      }),
    );
    expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "model",
        value: "openai-codex/gpt-5.3-codex",
      }),
    );
    expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "approval_policy",
        value: "strict",
      }),
    );
    expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "timeout",
        value: "120",
      }),
    );
  });

  it("returns unsupported-control error when backend does not support set_config_option", async () => {
    const runtimeState = createRuntime();
    const unsupportedRuntime: AcpRuntime = {
      ensureSession: runtimeState.ensureSession as AcpRuntime["ensureSession"],
      runTurn: runtimeState.runTurn as AcpRuntime["runTurn"],
      getCapabilities: vi.fn(async () => ({ controls: [] })),
      cancel: runtimeState.cancel as AcpRuntime["cancel"],
      close: runtimeState.close as AcpRuntime["close"],
    };
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: unsupportedRuntime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        key: "model",
        value: "gpt-5.3-codex",
      }),
    ).rejects.toMatchObject({
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
    });
  });

  it("rejects invalid runtime option values before backend controls run", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        key: "timeout",
        value: "not-a-number",
      }),
    ).rejects.toMatchObject({
      code: "ACP_INVALID_RUNTIME_OPTION",
    });
    expect(runtimeState.setConfigOption).not.toHaveBeenCalled();

    await expect(
      manager.updateSessionRuntimeOptions({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        patch: { cwd: "relative/path" },
      }),
    ).rejects.toMatchObject({
      code: "ACP_INVALID_RUNTIME_OPTION",
    });
  });

  it("can close and clear metadata when backend is unavailable", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      reason: "manual-close",
      allowBackendUnavailable: true,
      clearMeta: true,
    });

    expect(result.runtimeClosed).toBe(false);
    expect(result.runtimeNotice).toContain("not configured");
    expect(result.metaCleared).toBe(true);
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalled();
  });

  it("surfaces metadata clear errors during closeSession", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk locked"));

    const manager = new AcpSessionManager();
    await expect(
      manager.closeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        reason: "manual-close",
        allowBackendUnavailable: true,
        clearMeta: true,
      }),
    ).rejects.toThrow("disk locked");
  });
});
