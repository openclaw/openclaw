import { beforeEach, describe, expect, it, vi } from "vitest";
import CLEAN_COUSIN_TICKET_JSON from "../../../examples/route-law-bundle/clean/cousin-ticket.json" with { type: "json" };
import CLEAN_ROUTE_DECISION_JSON from "../../../examples/route-law-bundle/clean/route-decision.json" with { type: "json" };
import BAD_ROUTE_DECISION_JSON from "../../../examples/route-law-bundle/known-bad-direct-cross-president/route-decision.json" with { type: "json" };
import type { OpenClawConfig } from "../../config/config.js";
import type {
  AcpSessionRuntimeOptions,
  SessionAcpMeta,
  SessionEntry,
} from "../../config/sessions/types.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import type { AcpSessionStoreEntry } from "../runtime/session-meta.js";
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

  it("canonicalizes the main alias before ACP rehydrate after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
      if (sessionKey !== "agent:main:main") {
        return null;
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          ...readySessionMeta(),
          agent: "main",
          runtimeSessionName: sessionKey,
        },
      };
    });

    const manager = new AcpSessionManager();
    const cfg = {
      ...baseCfg,
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;

    await manager.runTurn({
      cfg,
      sessionKey: "main",
      text: "after restart",
      mode: "prompt",
      requestId: "r-main",
    });

    expect(hoisted.readAcpSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        sessionKey: "agent:main:main",
      }),
    );
    expect(runtimeState.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "main",
        sessionKey: "agent:main:main",
      }),
    );
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

  it("gates initializeSession on frozen M12 route law and persists the minimal route envelope", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const persistedMeta: SessionAcpMeta[] = [];
    const sessionEntries = new Map<string, AcpSessionStoreEntry>();
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
      return sessionKey ? (sessionEntries.get(sessionKey) ?? null) : null;
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: SessionEntry | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const currentEntry = sessionEntries.get(params.sessionKey);
      const next = params.mutate(currentEntry?.acp, currentEntry?.entry);
      if (!next) {
        sessionEntries.delete(params.sessionKey);
        return null;
      }
      persistedMeta.push(next);
      const persistedEntry: SessionEntry = {
        ...currentEntry?.entry,
        sessionId: currentEntry?.entry?.sessionId ?? `session-${sessionEntries.size + 1}`,
        updatedAt: Date.now(),
        acp: next,
      };
      sessionEntries.set(params.sessionKey, {
        cfg: baseCfg,
        storePath: "memory://manager.test.ts",
        sessionKey: params.sessionKey,
        storeSessionKey: params.sessionKey,
        entry: persistedEntry,
        acp: next,
      });
      return persistedEntry;
    });

    const expectedRouteLaw = {
      decisionId: CLEAN_ROUTE_DECISION_JSON.decisionId,
      classification: CLEAN_ROUTE_DECISION_JSON.route.classification,
      verdict: CLEAN_ROUTE_DECISION_JSON.decision.verdict,
      rejectReasons: CLEAN_ROUTE_DECISION_JSON.decision.rejectReasons,
      traceNamespace: CLEAN_ROUTE_DECISION_JSON.trace.traceNamespace,
      receiptNamespace: CLEAN_ROUTE_DECISION_JSON.trace.receiptNamespace,
      routeLawNamespace: CLEAN_ROUTE_DECISION_JSON.trace.routeLawNamespace,
      approvalNamespace: CLEAN_ROUTE_DECISION_JSON.trace.approvalNamespace,
      correlationId: CLEAN_ROUTE_DECISION_JSON.trace.correlationId,
      ticketId: CLEAN_ROUTE_DECISION_JSON.cousinTicket.ticketId,
      ticketDigest: CLEAN_ROUTE_DECISION_JSON.cousinTicket.ticketDigest,
    };

    const manager = new AcpSessionManager();
    const initialized = await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      agent: "codex",
      mode: "persistent",
      routeLawBundle: {
        routeDecision: CLEAN_ROUTE_DECISION_JSON,
        cousinTicket: CLEAN_COUSIN_TICKET_JSON,
      },
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(initialized.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(persistedMeta).toHaveLength(1);
    expect(persistedMeta[0]?.routeLaw).toEqual(expectedRouteLaw);

    await manager.setSessionRuntimeMode({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      runtimeMode: "plan",
    });

    const resolved = manager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(resolved.kind).toBe("ready");
    if (resolved.kind !== "ready") {
      return;
    }
    expect(runtimeState.setMode).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
      }),
    );
    expect(resolved.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(resolved.meta.runtimeOptions?.runtimeMode).toBe("plan");
    expect(persistedMeta).toHaveLength(2);
    expect(persistedMeta[1]?.routeLaw).toEqual(expectedRouteLaw);

    runtimeState.getStatus.mockResolvedValueOnce({
      summary: "status=alive",
      acpxRecordId: "acpx-record-route-law",
      backendSessionId: "acpx-session-route-law",
      agentSessionId: "agent-session-route-law",
      details: { status: "alive" },
    });
    hoisted.listAcpSessionEntriesMock.mockImplementation(async () => [...sessionEntries.values()]);

    const reconcileResult = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });
    expect(reconcileResult).toEqual({ checked: 1, resolved: 1, failed: 0 });

    const reconciled = manager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(reconciled.kind).toBe("ready");
    if (reconciled.kind !== "ready") {
      return;
    }
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
    expect(reconciled.meta.identity).toMatchObject({
      state: "resolved",
      source: "status",
      acpxRecordId: "acpx-record-route-law",
      acpxSessionId: "acpx-session-route-law",
      agentSessionId: "agent-session-route-law",
    });
    expect(reconciled.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(persistedMeta).toHaveLength(3);
    expect(persistedMeta[2]?.routeLaw).toEqual(expectedRouteLaw);

    const configOptions = await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      key: "model",
      value: "openai-codex/gpt-5.3-codex",
    });
    expect(configOptions).toMatchObject({
      runtimeMode: "plan",
      model: "openai-codex/gpt-5.3-codex",
    });

    const configPersisted = manager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(configPersisted.kind).toBe("ready");
    if (configPersisted.kind !== "ready") {
      return;
    }
    expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "model",
        value: "openai-codex/gpt-5.3-codex",
      }),
    );
    expect(configPersisted.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(configPersisted.meta.runtimeOptions).toMatchObject({
      runtimeMode: "plan",
      model: "openai-codex/gpt-5.3-codex",
    });
    expect(persistedMeta).toHaveLength(4);
    expect(persistedMeta[3]?.routeLaw).toEqual(expectedRouteLaw);

    const updatedRuntimeOptions = await manager.updateSessionRuntimeOptions({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      patch: {
        timeoutSeconds: 45,
      },
    });
    expect(updatedRuntimeOptions).toMatchObject({
      runtimeMode: "plan",
      model: "openai-codex/gpt-5.3-codex",
      timeoutSeconds: 45,
    });

    const optionsUpdated = manager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(optionsUpdated.kind).toBe("ready");
    if (optionsUpdated.kind !== "ready") {
      return;
    }
    expect(optionsUpdated.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(optionsUpdated.meta.runtimeOptions).toMatchObject({
      runtimeMode: "plan",
      model: "openai-codex/gpt-5.3-codex",
      timeoutSeconds: 45,
    });
    expect(runtimeState.close).not.toHaveBeenCalled();
    expect(persistedMeta).toHaveLength(5);
    expect(persistedMeta[4]?.routeLaw).toEqual(expectedRouteLaw);

    runtimeState.ensureSession.mockResolvedValueOnce({
      sessionKey: "agent:codex:acp:route-law-allow",
      backend: "acpx",
      runtimeSessionName: "runtime-route-law-rehydrated",
      backendSessionId: "acpx-session-route-law",
      agentSessionId: "agent-session-route-law",
    });
    runtimeState.getStatus.mockResolvedValueOnce({
      summary: "status=alive",
      acpxRecordId: "acpx-record-route-law",
      backendSessionId: "acpx-session-route-law",
      agentSessionId: "agent-session-route-law",
      details: { status: "alive" },
    });

    const restartedManager = new AcpSessionManager();
    const refreshedStatus = await restartedManager.getSessionStatus({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(refreshedStatus.identity).toMatchObject({
      acpxRecordId: "acpx-record-route-law",
      acpxSessionId: "acpx-session-route-law",
      agentSessionId: "agent-session-route-law",
    });
    expect(refreshedStatus.runtimeOptions).toMatchObject({
      runtimeMode: "plan",
      model: "openai-codex/gpt-5.3-codex",
      timeoutSeconds: 45,
    });

    const rehydrated = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(rehydrated.kind).toBe("ready");
    if (rehydrated.kind !== "ready") {
      return;
    }
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(2);
    expect(rehydrated.meta.runtimeSessionName).toBe("runtime-route-law-rehydrated");
    expect(rehydrated.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(rehydrated.meta.runtimeOptions).toMatchObject({
      runtimeMode: "plan",
      model: "openai-codex/gpt-5.3-codex",
      timeoutSeconds: 45,
    });
    expect(persistedMeta).toHaveLength(6);
    expect(persistedMeta[5]?.routeLaw).toEqual(expectedRouteLaw);

    const postRehydrateReconcile = await restartedManager.reconcilePendingSessionIdentities({
      cfg: baseCfg,
    });
    expect(postRehydrateReconcile).toEqual({ checked: 0, resolved: 0, failed: 0 });

    const afterRehydrateReconcile = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterRehydrateReconcile.kind).toBe("ready");
    if (afterRehydrateReconcile.kind !== "ready") {
      return;
    }
    expect(afterRehydrateReconcile.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRehydrateReconcile.meta.runtimeOptions).toMatchObject({
      runtimeMode: "plan",
      model: "openai-codex/gpt-5.3-codex",
      timeoutSeconds: 45,
    });
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(2);
    expect(persistedMeta).toHaveLength(6);
    expect(persistedMeta[persistedMeta.length - 1]?.routeLaw).toEqual(expectedRouteLaw);

    const closeResult = await restartedManager.closeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      reason: "manual-close",
    });
    expect(closeResult).toEqual({
      runtimeClosed: true,
      runtimeNotice: undefined,
      metaCleared: false,
    });

    const afterClose = new AcpSessionManager().resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterClose.kind).toBe("ready");
    if (afterClose.kind !== "ready") {
      return;
    }
    expect(runtimeState.close).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual-close",
      }),
    );
    expect(afterClose.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(persistedMeta).toHaveLength(6);

    runtimeState.ensureSession.mockResolvedValueOnce({
      sessionKey: "agent:codex:acp:route-law-allow",
      backend: "acpx",
      runtimeSessionName: "runtime-route-law-rehydrated",
      backendSessionId: "acpx-session-route-law",
      agentSessionId: "agent-session-route-law",
    });
    let enteredCancelTurn = false;
    runtimeState.runTurn.mockImplementationOnce(async function* (input: { signal?: AbortSignal }) {
      enteredCancelTurn = true;
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) {
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done" as const, stopReason: "cancel" };
    });

    const cancelManager = new AcpSessionManager();
    const cancelRunPromise = cancelManager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      text: "cancel route-law active turn",
      mode: "prompt",
      requestId: "cancel-route-law-turn",
    });
    await vi.waitFor(() => {
      expect(enteredCancelTurn).toBe(true);
    });
    await cancelManager.cancelSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      reason: "manual-cancel",
    });
    await cancelRunPromise;

    const afterCancel = new AcpSessionManager().resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterCancel.kind).toBe("ready");
    if (afterCancel.kind !== "ready") {
      return;
    }
    expect(runtimeState.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual-cancel",
      }),
    );
    expect(afterCancel.meta.state).toBe("idle");
    expect(afterCancel.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(persistedMeta).toHaveLength(8);
    expect(persistedMeta[persistedMeta.length - 1]?.routeLaw).toEqual(expectedRouteLaw);

    let enteredCancelErrorTurn = false;
    runtimeState.runTurn.mockImplementationOnce(async function* (input: { signal?: AbortSignal }) {
      enteredCancelErrorTurn = true;
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) {
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield undefined as never;
      throw new Error("cancel-path stream failure");
    });

    const cancelErrorRunPromise = cancelManager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      text: "cancel route-law active turn error path",
      mode: "prompt",
      requestId: "cancel-route-law-turn-error",
    });
    await vi.waitFor(() => {
      expect(enteredCancelErrorTurn).toBe(true);
    });
    await cancelManager.cancelSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      reason: "manual-cancel-error",
    });
    await expect(cancelErrorRunPromise).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
    });

    const afterCancelError = new AcpSessionManager().resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterCancelError.kind).toBe("ready");
    if (afterCancelError.kind !== "ready") {
      return;
    }
    expect(runtimeState.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual-cancel-error",
      }),
    );
    expect(afterCancelError.meta.state).toBe("error");
    expect(afterCancelError.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(persistedMeta).toHaveLength(10);
    expect(persistedMeta[persistedMeta.length - 1]?.routeLaw).toEqual(expectedRouteLaw);

    runtimeState.ensureSession.mockResolvedValueOnce({
      sessionKey: "agent:codex:acp:route-law-allow",
      backend: "acpx",
      runtimeSessionName: "runtime-route-law-rehydrated",
      backendSessionId: "acpx-session-route-law",
      agentSessionId: "agent-session-route-law",
    });
    runtimeState.cancel.mockRejectedValueOnce(new Error("cancel-path non-active failure"));

    const nonActiveCancelManager = new AcpSessionManager();
    await expect(
      nonActiveCancelManager.cancelSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        reason: "manual-cancel-non-active-error",
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "cancel-path non-active failure",
    });

    const afterNonActiveCancelError = new AcpSessionManager().resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterNonActiveCancelError.kind).toBe("ready");
    if (afterNonActiveCancelError.kind !== "ready") {
      return;
    }
    expect(runtimeState.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual-cancel-non-active-error",
      }),
    );
    expect(afterNonActiveCancelError.meta.state).toBe("error");
    expect(afterNonActiveCancelError.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(persistedMeta).toHaveLength(11);
    expect(persistedMeta[persistedMeta.length - 1]?.routeLaw).toEqual(expectedRouteLaw);

    await nonActiveCancelManager.cancelSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      reason: "manual-cancel-non-active-idle",
    });

    const afterNonActiveCancelIdle = new AcpSessionManager().resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterNonActiveCancelIdle.kind).toBe("ready");
    if (afterNonActiveCancelIdle.kind !== "ready") {
      return;
    }
    expect(runtimeState.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual-cancel-non-active-idle",
      }),
    );
    expect(afterNonActiveCancelIdle.meta.state).toBe("idle");
    expect(afterNonActiveCancelIdle.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(persistedMeta).toHaveLength(12);
    expect(persistedMeta[persistedMeta.length - 1]?.routeLaw).toEqual(expectedRouteLaw);

    const resetOptions = await nonActiveCancelManager.resetSessionRuntimeOptions({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(resetOptions).toEqual({});

    const afterResetRuntimeOptions = new AcpSessionManager().resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterResetRuntimeOptions.kind).toBe("ready");
    if (afterResetRuntimeOptions.kind !== "ready") {
      return;
    }
    expect(runtimeState.close).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "reset-runtime-options",
      }),
    );
    expect(afterResetRuntimeOptions.meta.runtimeOptions).toBeUndefined();
    expect(afterResetRuntimeOptions.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(persistedMeta).toHaveLength(13);
    expect(persistedMeta[persistedMeta.length - 1]?.routeLaw).toEqual(expectedRouteLaw);

    const clearMetaCloseResult = await restartedManager.closeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      reason: "manual-close-clear",
      clearMeta: true,
    });
    expect(clearMetaCloseResult).toEqual({
      runtimeClosed: true,
      runtimeNotice: undefined,
      metaCleared: true,
    });
    expect(runtimeState.close).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual-close-clear",
      }),
    );
    expect(sessionEntries.has("agent:codex:acp:route-law-allow")).toBe(false);

    const afterClearMetaClose = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterClearMetaClose.kind).toBe("stale");
    if (afterClearMetaClose.kind !== "stale") {
      return;
    }
    expect(afterClearMetaClose.error.code).toBe("ACP_SESSION_INIT_FAILED");
    expect(afterClearMetaClose.error.message).toContain("ACP metadata is missing");

    const upsertCallsBeforeIdempotentClear = hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeIdempotentClear = persistedMeta.length;
    const secondClearResult = await restartedManager.closeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      reason: "manual-close-clear-idempotent",
      clearMeta: true,
      requireAcpSession: false,
    });
    expect(secondClearResult).toEqual({
      runtimeClosed: false,
      metaCleared: false,
    });
    expect(hoisted.upsertAcpSessionMetaMock.mock.calls.length).toBe(
      upsertCallsBeforeIdempotentClear,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeIdempotentClear);

    const afterIdempotentClear = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterIdempotentClear.kind).toBe("stale");
    if (afterIdempotentClear.kind !== "stale") {
      return;
    }
    expect(afterIdempotentClear.error.code).toBe("ACP_SESSION_INIT_FAILED");
    expect(afterIdempotentClear.error.message).toContain("ACP metadata is missing");
    expect(sessionEntries.has("agent:codex:acp:route-law-allow")).toBe(false);

    const upsertCallsBeforeReinitialize = hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeReinitialize = persistedMeta.length;
    const reinitializedAfterClear = await restartedManager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      agent: "codex",
      mode: "persistent",
      routeLawBundle: {
        routeDecision: CLEAN_ROUTE_DECISION_JSON,
        cousinTicket: CLEAN_COUSIN_TICKET_JSON,
      },
    });
    expect(reinitializedAfterClear.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(reinitializedAfterClear.meta.runtimeOptions).toBeUndefined();
    expect(reinitializedAfterClear.meta.state).toBe("idle");
    expect(reinitializedAfterClear.meta.lastError).toBeUndefined();
    expect(hoisted.upsertAcpSessionMetaMock.mock.calls.length).toBe(
      upsertCallsBeforeReinitialize + 1,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeReinitialize + 1);

    const afterReinitialize = new AcpSessionManager().resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterReinitialize.kind).toBe("ready");
    if (afterReinitialize.kind !== "ready") {
      return;
    }
    expect(afterReinitialize.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterReinitialize.meta.runtimeOptions).toBeUndefined();
    expect(afterReinitialize.meta.state).toBe("idle");
    expect(sessionEntries.has("agent:codex:acp:route-law-allow")).toBe(true);

    const ensureCallsBeforePostClearReject = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforePostClearReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforePostClearReject = hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforePostClearReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: BAD_ROUTE_DECISION_JSON,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining(BAD_ROUTE_DECISION_JSON.decision.rejectReasons.join(", ")),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(ensureCallsBeforePostClearReject);
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforePostClearReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforePostClearReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforePostClearReject);

    const afterPostClearReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterPostClearReject.kind).toBe("ready");
    if (afterPostClearReject.kind !== "ready") {
      return;
    }
    expect(afterPostClearReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterPostClearReject.meta.runtimeOptions).toBeUndefined();
    expect(afterPostClearReject.meta.state).toBe("idle");
    expect(afterPostClearReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeKnownBadRehydrate = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeKnownBadRehydrate =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeKnownBadRehydrate = hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeKnownBadRehydrate = persistedMeta.length;
    const rehydratedAfterKnownBadRejectManager = new AcpSessionManager();
    const statusAfterKnownBadRehydrate =
      await rehydratedAfterKnownBadRejectManager.getSessionStatus({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(statusAfterKnownBadRehydrate.state).toBe("idle");
    expect(statusAfterKnownBadRehydrate.runtimeOptions).toEqual({});
    expect(statusAfterKnownBadRehydrate.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeKnownBadRehydrate + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeKnownBadRehydrate + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeKnownBadRehydrate,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeKnownBadRehydrate);

    const afterKnownBadRehydrate = rehydratedAfterKnownBadRejectManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterKnownBadRehydrate.kind).toBe("ready");
    if (afterKnownBadRehydrate.kind !== "ready") {
      return;
    }
    expect(afterKnownBadRehydrate.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterKnownBadRehydrate.meta.runtimeOptions).toBeUndefined();
    expect(afterKnownBadRehydrate.meta.state).toBe("idle");
    expect(afterKnownBadRehydrate.meta.lastError).toBeUndefined();

    const ensureCallsBeforeKnownBadRecovery = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeKnownBadRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeKnownBadRecovery = hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeKnownBadRecovery = persistedMeta.length;
    const recoveredAfterKnownBadReject =
      await rehydratedAfterKnownBadRejectManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      });
    expect(recoveredAfterKnownBadReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(recoveredAfterKnownBadReject.meta.runtimeOptions).toBeUndefined();
    expect(recoveredAfterKnownBadReject.meta.state).toBe("idle");
    expect(recoveredAfterKnownBadReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(ensureCallsBeforeKnownBadRecovery + 1);
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeKnownBadRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeKnownBadRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeKnownBadRecovery + 1);

    const afterKnownBadRecovery = rehydratedAfterKnownBadRejectManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterKnownBadRecovery.kind).toBe("ready");
    if (afterKnownBadRecovery.kind !== "ready") {
      return;
    }
    expect(afterKnownBadRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterKnownBadRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterKnownBadRecovery.meta.state).toBe("idle");
    expect(afterKnownBadRecovery.meta.lastError).toBeUndefined();

    const schemaInvalidRouteDecision = structuredClone(CLEAN_ROUTE_DECISION_JSON) as Record<
      string,
      unknown
    >;
    delete schemaInvalidRouteDecision.decisionId;
    const ensureCallsBeforeSchemaInvalidReject = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeSchemaInvalidReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeSchemaInvalidReject = hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeSchemaInvalidReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: schemaInvalidRouteDecision,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("frozen M12 schema validation"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(ensureCallsBeforeSchemaInvalidReject);
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeSchemaInvalidReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeSchemaInvalidReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeSchemaInvalidReject);

    const afterSchemaInvalidReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterSchemaInvalidReject.kind).toBe("ready");
    if (afterSchemaInvalidReject.kind !== "ready") {
      return;
    }
    expect(afterSchemaInvalidReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterSchemaInvalidReject.meta.runtimeOptions).toBeUndefined();
    expect(afterSchemaInvalidReject.meta.state).toBe("idle");

    expect(CLEAN_ROUTE_DECISION_JSON.decision.verdict).toBe("allow");
    expect(CLEAN_ROUTE_DECISION_JSON.decision.cousinTicketRequired).toBe(true);
    const schemaInvalidCousinTicket = structuredClone(CLEAN_COUSIN_TICKET_JSON) as Record<
      string,
      unknown
    >;
    delete schemaInvalidCousinTicket.ticketId;
    const ensureCallsBeforeSchemaInvalidTicketReject = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeSchemaInvalidTicketReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeSchemaInvalidTicketReject =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeSchemaInvalidTicketReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: schemaInvalidCousinTicket,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("ACP cousin ticket failed frozen M12 schema validation"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeSchemaInvalidTicketReject,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeSchemaInvalidTicketReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeSchemaInvalidTicketReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeSchemaInvalidTicketReject);

    const afterSchemaInvalidTicketReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterSchemaInvalidTicketReject.kind).toBe("ready");
    if (afterSchemaInvalidTicketReject.kind !== "ready") {
      return;
    }
    expect(afterSchemaInvalidTicketReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterSchemaInvalidTicketReject.meta.runtimeOptions).toBeUndefined();
    expect(afterSchemaInvalidTicketReject.meta.state).toBe("idle");
    expect(afterSchemaInvalidTicketReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeSchemaInvalidTicketRehydrate =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeSchemaInvalidTicketRehydrate =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeSchemaInvalidTicketRehydrate =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeSchemaInvalidTicketRehydrate = persistedMeta.length;
    const rehydratedAfterSchemaInvalidTicketRejectManager = new AcpSessionManager();
    const statusAfterSchemaInvalidTicketRehydrate =
      await rehydratedAfterSchemaInvalidTicketRejectManager.getSessionStatus({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(statusAfterSchemaInvalidTicketRehydrate.state).toBe("idle");
    expect(statusAfterSchemaInvalidTicketRehydrate.runtimeOptions).toEqual({});
    expect(statusAfterSchemaInvalidTicketRehydrate.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeSchemaInvalidTicketRehydrate + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeSchemaInvalidTicketRehydrate + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeSchemaInvalidTicketRehydrate,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeSchemaInvalidTicketRehydrate);

    const afterSchemaInvalidTicketRehydrate =
      rehydratedAfterSchemaInvalidTicketRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterSchemaInvalidTicketRehydrate.kind).toBe("ready");
    if (afterSchemaInvalidTicketRehydrate.kind !== "ready") {
      return;
    }
    expect(afterSchemaInvalidTicketRehydrate.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterSchemaInvalidTicketRehydrate.meta.runtimeOptions).toBeUndefined();
    expect(afterSchemaInvalidTicketRehydrate.meta.state).toBe("idle");
    expect(afterSchemaInvalidTicketRehydrate.meta.lastError).toBeUndefined();

    const ensureCallsBeforeSchemaInvalidTicketRecovery =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeSchemaInvalidTicketRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeSchemaInvalidTicketRecovery =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeSchemaInvalidTicketRecovery = persistedMeta.length;
    const recoveredAfterSchemaInvalidTicketReject =
      await rehydratedAfterSchemaInvalidTicketRejectManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      });
    expect(recoveredAfterSchemaInvalidTicketReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(recoveredAfterSchemaInvalidTicketReject.meta.runtimeOptions).toBeUndefined();
    expect(recoveredAfterSchemaInvalidTicketReject.meta.state).toBe("idle");
    expect(recoveredAfterSchemaInvalidTicketReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeSchemaInvalidTicketRecovery + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeSchemaInvalidTicketRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeSchemaInvalidTicketRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeSchemaInvalidTicketRecovery + 1);

    const afterSchemaInvalidTicketRecovery =
      rehydratedAfterSchemaInvalidTicketRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterSchemaInvalidTicketRecovery.kind).toBe("ready");
    if (afterSchemaInvalidTicketRecovery.kind !== "ready") {
      return;
    }
    expect(afterSchemaInvalidTicketRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterSchemaInvalidTicketRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterSchemaInvalidTicketRecovery.meta.state).toBe("idle");
    expect(afterSchemaInvalidTicketRecovery.meta.lastError).toBeUndefined();

    const ensureCallsBeforeMissingTicketReject = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeMissingTicketReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeMissingTicketReject = hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeMissingTicketReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("reject-missing-cousin-ticket"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(ensureCallsBeforeMissingTicketReject);
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeMissingTicketReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeMissingTicketReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeMissingTicketReject);

    const afterMissingTicketReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterMissingTicketReject.kind).toBe("ready");
    if (afterMissingTicketReject.kind !== "ready") {
      return;
    }
    expect(afterMissingTicketReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterMissingTicketReject.meta.runtimeOptions).toBeUndefined();
    expect(afterMissingTicketReject.meta.state).toBe("idle");
    expect(afterMissingTicketReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeMissingTicketRehydrate = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeMissingTicketRehydrate =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeMissingTicketRehydrate =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeMissingTicketRehydrate = persistedMeta.length;
    const rehydratedAfterMissingTicketRejectManager = new AcpSessionManager();
    const statusAfterMissingTicketRehydrate =
      await rehydratedAfterMissingTicketRejectManager.getSessionStatus({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(statusAfterMissingTicketRehydrate.state).toBe("idle");
    expect(statusAfterMissingTicketRehydrate.runtimeOptions).toEqual({});
    expect(statusAfterMissingTicketRehydrate.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeMissingTicketRehydrate + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeMissingTicketRehydrate + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeMissingTicketRehydrate,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeMissingTicketRehydrate);

    const afterMissingTicketRehydrate = rehydratedAfterMissingTicketRejectManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterMissingTicketRehydrate.kind).toBe("ready");
    if (afterMissingTicketRehydrate.kind !== "ready") {
      return;
    }
    expect(afterMissingTicketRehydrate.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterMissingTicketRehydrate.meta.runtimeOptions).toBeUndefined();
    expect(afterMissingTicketRehydrate.meta.state).toBe("idle");
    expect(afterMissingTicketRehydrate.meta.lastError).toBeUndefined();

    const ensureCallsBeforeMissingTicketRecovery = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeMissingTicketRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeMissingTicketRecovery =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeMissingTicketRecovery = persistedMeta.length;
    const recoveredAfterMissingTicketReject =
      await rehydratedAfterMissingTicketRejectManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      });
    expect(recoveredAfterMissingTicketReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(recoveredAfterMissingTicketReject.meta.runtimeOptions).toBeUndefined();
    expect(recoveredAfterMissingTicketReject.meta.state).toBe("idle");
    expect(recoveredAfterMissingTicketReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeMissingTicketRecovery + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeMissingTicketRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeMissingTicketRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeMissingTicketRecovery + 1);

    const afterMissingTicketRecovery = rehydratedAfterMissingTicketRejectManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterMissingTicketRecovery.kind).toBe("ready");
    if (afterMissingTicketRecovery.kind !== "ready") {
      return;
    }
    expect(afterMissingTicketRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterMissingTicketRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterMissingTicketRecovery.meta.state).toBe("idle");
    expect(afterMissingTicketRecovery.meta.lastError).toBeUndefined();

    const bindingMismatchedCousinTicket = structuredClone(CLEAN_COUSIN_TICKET_JSON) as Record<
      string,
      unknown
    >;
    bindingMismatchedCousinTicket.decisionId = "route-decision.engineering-to-ops.mismatch";
    const ensureCallsBeforeBindingMismatchReject = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeBindingMismatchReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeBindingMismatchReject =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeBindingMismatchReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: bindingMismatchedCousinTicket,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("reject-cousin-ticket-binding-mismatch"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeBindingMismatchReject,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeBindingMismatchReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeBindingMismatchReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeBindingMismatchReject);

    const afterBindingMismatchReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterBindingMismatchReject.kind).toBe("ready");
    if (afterBindingMismatchReject.kind !== "ready") {
      return;
    }
    expect(afterBindingMismatchReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterBindingMismatchReject.meta.runtimeOptions).toBeUndefined();
    expect(afterBindingMismatchReject.meta.state).toBe("idle");
    expect(afterBindingMismatchReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeBindingMismatchRehydrate = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeBindingMismatchRehydrate =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeBindingMismatchRehydrate =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeBindingMismatchRehydrate = persistedMeta.length;
    const rehydratedAfterBindingMismatchRejectManager = new AcpSessionManager();
    const statusAfterBindingMismatchRehydrate =
      await rehydratedAfterBindingMismatchRejectManager.getSessionStatus({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(statusAfterBindingMismatchRehydrate.state).toBe("idle");
    expect(statusAfterBindingMismatchRehydrate.runtimeOptions).toEqual({});
    expect(statusAfterBindingMismatchRehydrate.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeBindingMismatchRehydrate + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeBindingMismatchRehydrate + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeBindingMismatchRehydrate,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeBindingMismatchRehydrate);

    const afterBindingMismatchRehydrate =
      rehydratedAfterBindingMismatchRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterBindingMismatchRehydrate.kind).toBe("ready");
    if (afterBindingMismatchRehydrate.kind !== "ready") {
      return;
    }
    expect(afterBindingMismatchRehydrate.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterBindingMismatchRehydrate.meta.runtimeOptions).toBeUndefined();
    expect(afterBindingMismatchRehydrate.meta.state).toBe("idle");
    expect(afterBindingMismatchRehydrate.meta.lastError).toBeUndefined();

    const ensureCallsBeforeBindingMismatchRecovery = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeBindingMismatchRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeBindingMismatchRecovery =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeBindingMismatchRecovery = persistedMeta.length;
    const recoveredAfterBindingMismatchReject =
      await rehydratedAfterBindingMismatchRejectManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      });
    expect(recoveredAfterBindingMismatchReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(recoveredAfterBindingMismatchReject.meta.runtimeOptions).toBeUndefined();
    expect(recoveredAfterBindingMismatchReject.meta.state).toBe("idle");
    expect(recoveredAfterBindingMismatchReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeBindingMismatchRecovery + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeBindingMismatchRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeBindingMismatchRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeBindingMismatchRecovery + 1);

    const afterBindingMismatchRecovery = rehydratedAfterBindingMismatchRejectManager.resolveSession(
      {
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      },
    );
    expect(afterBindingMismatchRecovery.kind).toBe("ready");
    if (afterBindingMismatchRecovery.kind !== "ready") {
      return;
    }
    expect(afterBindingMismatchRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterBindingMismatchRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterBindingMismatchRecovery.meta.state).toBe("idle");
    expect(afterBindingMismatchRecovery.meta.lastError).toBeUndefined();

    const ensureCallsBeforeBindingMismatchImmediateReject =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeBindingMismatchImmediateReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeBindingMismatchImmediateReject =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeBindingMismatchImmediateReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: bindingMismatchedCousinTicket,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("reject-cousin-ticket-binding-mismatch"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeBindingMismatchImmediateReject,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeBindingMismatchImmediateReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeBindingMismatchImmediateReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeBindingMismatchImmediateReject);

    const afterBindingMismatchImmediateReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterBindingMismatchImmediateReject.kind).toBe("ready");
    if (afterBindingMismatchImmediateReject.kind !== "ready") {
      return;
    }
    expect(afterBindingMismatchImmediateReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterBindingMismatchImmediateReject.meta.runtimeOptions).toBeUndefined();
    expect(afterBindingMismatchImmediateReject.meta.state).toBe("idle");
    expect(afterBindingMismatchImmediateReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeBindingMismatchImmediateRecovery =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeBindingMismatchImmediateRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeBindingMismatchImmediateRecovery =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeBindingMismatchImmediateRecovery = persistedMeta.length;
    const recoveredAfterBindingMismatchImmediateReject = await restartedManager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
      agent: "codex",
      mode: "persistent",
      routeLawBundle: {
        routeDecision: CLEAN_ROUTE_DECISION_JSON,
        cousinTicket: CLEAN_COUSIN_TICKET_JSON,
      },
    });
    expect(recoveredAfterBindingMismatchImmediateReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(recoveredAfterBindingMismatchImmediateReject.meta.runtimeOptions).toBeUndefined();
    expect(recoveredAfterBindingMismatchImmediateReject.meta.state).toBe("idle");
    expect(recoveredAfterBindingMismatchImmediateReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeBindingMismatchImmediateRecovery + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeBindingMismatchImmediateRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeBindingMismatchImmediateRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeBindingMismatchImmediateRecovery + 1);

    const afterBindingMismatchImmediateRecovery = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterBindingMismatchImmediateRecovery.kind).toBe("ready");
    if (afterBindingMismatchImmediateRecovery.kind !== "ready") {
      return;
    }
    expect(afterBindingMismatchImmediateRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterBindingMismatchImmediateRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterBindingMismatchImmediateRecovery.meta.state).toBe("idle");
    expect(afterBindingMismatchImmediateRecovery.meta.lastError).toBeUndefined();

    const digestMismatchedCousinTicket = structuredClone(CLEAN_COUSIN_TICKET_JSON) as Record<
      string,
      unknown
    >;
    digestMismatchedCousinTicket.receipts = {
      ...(digestMismatchedCousinTicket.receipts as Record<string, unknown>),
      ticketDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const ensureCallsBeforeDigestMismatchReject = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeDigestMismatchReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeDigestMismatchReject =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeDigestMismatchReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: digestMismatchedCousinTicket,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("reject-cousin-ticket-binding-mismatch"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(ensureCallsBeforeDigestMismatchReject);
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeDigestMismatchReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeDigestMismatchReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeDigestMismatchReject);

    const afterDigestMismatchReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterDigestMismatchReject.kind).toBe("ready");
    if (afterDigestMismatchReject.kind !== "ready") {
      return;
    }
    expect(afterDigestMismatchReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterDigestMismatchReject.meta.runtimeOptions).toBeUndefined();
    expect(afterDigestMismatchReject.meta.state).toBe("idle");
    expect(afterDigestMismatchReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeDigestMismatchRehydrate = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeDigestMismatchRehydrate =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeDigestMismatchRehydrate =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeDigestMismatchRehydrate = persistedMeta.length;
    const rehydratedAfterDigestMismatchRejectManager = new AcpSessionManager();
    const statusAfterDigestMismatchRehydrate =
      await rehydratedAfterDigestMismatchRejectManager.getSessionStatus({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(statusAfterDigestMismatchRehydrate.state).toBe("idle");
    expect(statusAfterDigestMismatchRehydrate.runtimeOptions).toEqual({});
    expect(statusAfterDigestMismatchRehydrate.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeDigestMismatchRehydrate + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeDigestMismatchRehydrate + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeDigestMismatchRehydrate,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeDigestMismatchRehydrate);

    const afterDigestMismatchRehydrate = rehydratedAfterDigestMismatchRejectManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterDigestMismatchRehydrate.kind).toBe("ready");
    if (afterDigestMismatchRehydrate.kind !== "ready") {
      return;
    }
    expect(afterDigestMismatchRehydrate.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterDigestMismatchRehydrate.meta.runtimeOptions).toBeUndefined();
    expect(afterDigestMismatchRehydrate.meta.state).toBe("idle");
    expect(afterDigestMismatchRehydrate.meta.lastError).toBeUndefined();

    const ensureCallsBeforeDigestMismatchRecovery = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeDigestMismatchRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeDigestMismatchRecovery =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeDigestMismatchRecovery = persistedMeta.length;
    const recoveredAfterDigestMismatchReject =
      await rehydratedAfterDigestMismatchRejectManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      });
    expect(recoveredAfterDigestMismatchReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(recoveredAfterDigestMismatchReject.meta.runtimeOptions).toBeUndefined();
    expect(recoveredAfterDigestMismatchReject.meta.state).toBe("idle");
    expect(recoveredAfterDigestMismatchReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeDigestMismatchRecovery + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeDigestMismatchRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeDigestMismatchRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeDigestMismatchRecovery + 1);

    const afterDigestMismatchRecovery = rehydratedAfterDigestMismatchRejectManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterDigestMismatchRecovery.kind).toBe("ready");
    if (afterDigestMismatchRecovery.kind !== "ready") {
      return;
    }
    expect(afterDigestMismatchRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterDigestMismatchRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterDigestMismatchRecovery.meta.state).toBe("idle");
    expect(afterDigestMismatchRecovery.meta.lastError).toBeUndefined();

    const ticketIdMismatchedCousinTicket = structuredClone(CLEAN_COUSIN_TICKET_JSON) as Record<
      string,
      unknown
    >;
    ticketIdMismatchedCousinTicket.ticketId = "cousin-ticket.engineering-to-ops.mismatch";
    const ensureCallsBeforeTicketIdMismatchReject = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeTicketIdMismatchReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeTicketIdMismatchReject =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeTicketIdMismatchReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: ticketIdMismatchedCousinTicket,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("reject-cousin-ticket-binding-mismatch"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeTicketIdMismatchReject,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeTicketIdMismatchReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeTicketIdMismatchReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeTicketIdMismatchReject);

    const afterTicketIdMismatchReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterTicketIdMismatchReject.kind).toBe("ready");
    if (afterTicketIdMismatchReject.kind !== "ready") {
      return;
    }
    expect(afterTicketIdMismatchReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterTicketIdMismatchReject.meta.runtimeOptions).toBeUndefined();
    expect(afterTicketIdMismatchReject.meta.state).toBe("idle");
    expect(afterTicketIdMismatchReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeTicketIdMismatchRehydrate = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeTicketIdMismatchRehydrate =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeTicketIdMismatchRehydrate =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeTicketIdMismatchRehydrate = persistedMeta.length;
    const rehydratedAfterTicketIdMismatchRejectManager = new AcpSessionManager();
    const statusAfterTicketIdMismatchRehydrate =
      await rehydratedAfterTicketIdMismatchRejectManager.getSessionStatus({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(statusAfterTicketIdMismatchRehydrate.state).toBe("idle");
    expect(statusAfterTicketIdMismatchRehydrate.runtimeOptions).toEqual({});
    expect(statusAfterTicketIdMismatchRehydrate.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeTicketIdMismatchRehydrate + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeTicketIdMismatchRehydrate + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeTicketIdMismatchRehydrate,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeTicketIdMismatchRehydrate);

    const afterTicketIdMismatchRehydrate =
      rehydratedAfterTicketIdMismatchRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterTicketIdMismatchRehydrate.kind).toBe("ready");
    if (afterTicketIdMismatchRehydrate.kind !== "ready") {
      return;
    }
    expect(afterTicketIdMismatchRehydrate.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterTicketIdMismatchRehydrate.meta.runtimeOptions).toBeUndefined();
    expect(afterTicketIdMismatchRehydrate.meta.state).toBe("idle");
    expect(afterTicketIdMismatchRehydrate.meta.lastError).toBeUndefined();

    const ensureCallsBeforeTicketIdMismatchRecovery = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeTicketIdMismatchRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeTicketIdMismatchRecovery =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeTicketIdMismatchRecovery = persistedMeta.length;
    const recoveredAfterTicketIdMismatchReject =
      await rehydratedAfterTicketIdMismatchRejectManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      });
    expect(recoveredAfterTicketIdMismatchReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(recoveredAfterTicketIdMismatchReject.meta.runtimeOptions).toBeUndefined();
    expect(recoveredAfterTicketIdMismatchReject.meta.state).toBe("idle");
    expect(recoveredAfterTicketIdMismatchReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeTicketIdMismatchRecovery + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeTicketIdMismatchRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeTicketIdMismatchRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeTicketIdMismatchRecovery + 1);

    const afterTicketIdMismatchRecovery =
      rehydratedAfterTicketIdMismatchRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterTicketIdMismatchRecovery.kind).toBe("ready");
    if (afterTicketIdMismatchRecovery.kind !== "ready") {
      return;
    }
    expect(afterTicketIdMismatchRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterTicketIdMismatchRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterTicketIdMismatchRecovery.meta.state).toBe("idle");
    expect(afterTicketIdMismatchRecovery.meta.lastError).toBeUndefined();

    const routeDecisionWithTicketIdMismatch = structuredClone(CLEAN_ROUTE_DECISION_JSON) as Record<
      string,
      unknown
    >;
    routeDecisionWithTicketIdMismatch.cousinTicket = {
      ...(routeDecisionWithTicketIdMismatch.cousinTicket as Record<string, unknown>),
      ticketId: "cousin-ticket.engineering-to-ops.route-decision-mismatch",
    };
    const ensureCallsBeforeRouteDecisionTicketIdMismatchReject =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionTicketIdMismatchReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionTicketIdMismatchReject =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionTicketIdMismatchReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: routeDecisionWithTicketIdMismatch,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("reject-cousin-ticket-binding-mismatch"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionTicketIdMismatchReject,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionTicketIdMismatchReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionTicketIdMismatchReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeRouteDecisionTicketIdMismatchReject);

    const afterRouteDecisionTicketIdMismatchReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterRouteDecisionTicketIdMismatchReject.kind).toBe("ready");
    if (afterRouteDecisionTicketIdMismatchReject.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionTicketIdMismatchReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionTicketIdMismatchReject.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionTicketIdMismatchReject.meta.state).toBe("idle");
    expect(afterRouteDecisionTicketIdMismatchReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeRouteDecisionTicketIdMismatchRehydrate =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionTicketIdMismatchRehydrate =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionTicketIdMismatchRehydrate =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionTicketIdMismatchRehydrate = persistedMeta.length;
    const rehydratedAfterRouteDecisionTicketIdMismatchRejectManager = new AcpSessionManager();
    const statusAfterRouteDecisionTicketIdMismatchRehydrate =
      await rehydratedAfterRouteDecisionTicketIdMismatchRejectManager.getSessionStatus({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(statusAfterRouteDecisionTicketIdMismatchRehydrate.state).toBe("idle");
    expect(statusAfterRouteDecisionTicketIdMismatchRehydrate.runtimeOptions).toEqual({});
    expect(statusAfterRouteDecisionTicketIdMismatchRehydrate.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionTicketIdMismatchRehydrate + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionTicketIdMismatchRehydrate + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionTicketIdMismatchRehydrate,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeRouteDecisionTicketIdMismatchRehydrate);

    const afterRouteDecisionTicketIdMismatchRehydrate =
      rehydratedAfterRouteDecisionTicketIdMismatchRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterRouteDecisionTicketIdMismatchRehydrate.kind).toBe("ready");
    if (afterRouteDecisionTicketIdMismatchRehydrate.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionTicketIdMismatchRehydrate.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionTicketIdMismatchRehydrate.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionTicketIdMismatchRehydrate.meta.state).toBe("idle");
    expect(afterRouteDecisionTicketIdMismatchRehydrate.meta.lastError).toBeUndefined();

    const ensureCallsBeforeRouteDecisionTicketIdMismatchRecovery =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionTicketIdMismatchRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionTicketIdMismatchRecovery =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionTicketIdMismatchRecovery = persistedMeta.length;
    const recoveredAfterRouteDecisionTicketIdMismatchReject =
      await rehydratedAfterRouteDecisionTicketIdMismatchRejectManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      });
    expect(recoveredAfterRouteDecisionTicketIdMismatchReject.meta.routeLaw).toEqual(
      expectedRouteLaw,
    );
    expect(recoveredAfterRouteDecisionTicketIdMismatchReject.meta.runtimeOptions).toBeUndefined();
    expect(recoveredAfterRouteDecisionTicketIdMismatchReject.meta.state).toBe("idle");
    expect(recoveredAfterRouteDecisionTicketIdMismatchReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionTicketIdMismatchRecovery + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionTicketIdMismatchRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionTicketIdMismatchRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(
      persistedMetaBeforeRouteDecisionTicketIdMismatchRecovery + 1,
    );

    const afterRouteDecisionTicketIdMismatchRecovery =
      rehydratedAfterRouteDecisionTicketIdMismatchRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterRouteDecisionTicketIdMismatchRecovery.kind).toBe("ready");
    if (afterRouteDecisionTicketIdMismatchRecovery.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionTicketIdMismatchRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionTicketIdMismatchRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionTicketIdMismatchRecovery.meta.state).toBe("idle");
    expect(afterRouteDecisionTicketIdMismatchRecovery.meta.lastError).toBeUndefined();

    const routeDecisionWithTicketDigestMismatch = structuredClone(
      CLEAN_ROUTE_DECISION_JSON,
    ) as Record<string, unknown>;
    routeDecisionWithTicketDigestMismatch.cousinTicket = {
      ...(routeDecisionWithTicketDigestMismatch.cousinTicket as Record<string, unknown>),
      ticketDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const ensureCallsBeforeRouteDecisionTicketDigestMismatchReject =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionTicketDigestMismatchReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionTicketDigestMismatchReject =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionTicketDigestMismatchReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: routeDecisionWithTicketDigestMismatch,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("reject-cousin-ticket-binding-mismatch"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionTicketDigestMismatchReject,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionTicketDigestMismatchReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionTicketDigestMismatchReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeRouteDecisionTicketDigestMismatchReject);

    const afterRouteDecisionTicketDigestMismatchReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterRouteDecisionTicketDigestMismatchReject.kind).toBe("ready");
    if (afterRouteDecisionTicketDigestMismatchReject.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionTicketDigestMismatchReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionTicketDigestMismatchReject.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionTicketDigestMismatchReject.meta.state).toBe("idle");
    expect(afterRouteDecisionTicketDigestMismatchReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeRouteDecisionTicketDigestMismatchRehydrate =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionTicketDigestMismatchRehydrate =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionTicketDigestMismatchRehydrate =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionTicketDigestMismatchRehydrate = persistedMeta.length;
    const rehydratedAfterRouteDecisionTicketDigestMismatchRejectManager = new AcpSessionManager();
    const statusAfterRouteDecisionTicketDigestMismatchRehydrate =
      await rehydratedAfterRouteDecisionTicketDigestMismatchRejectManager.getSessionStatus({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(statusAfterRouteDecisionTicketDigestMismatchRehydrate.state).toBe("idle");
    expect(statusAfterRouteDecisionTicketDigestMismatchRehydrate.runtimeOptions).toEqual({});
    expect(statusAfterRouteDecisionTicketDigestMismatchRehydrate.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionTicketDigestMismatchRehydrate + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionTicketDigestMismatchRehydrate + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionTicketDigestMismatchRehydrate,
    );
    expect(persistedMeta).toHaveLength(
      persistedMetaBeforeRouteDecisionTicketDigestMismatchRehydrate,
    );

    const afterRouteDecisionTicketDigestMismatchRehydrate =
      rehydratedAfterRouteDecisionTicketDigestMismatchRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterRouteDecisionTicketDigestMismatchRehydrate.kind).toBe("ready");
    if (afterRouteDecisionTicketDigestMismatchRehydrate.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionTicketDigestMismatchRehydrate.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionTicketDigestMismatchRehydrate.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionTicketDigestMismatchRehydrate.meta.state).toBe("idle");
    expect(afterRouteDecisionTicketDigestMismatchRehydrate.meta.lastError).toBeUndefined();

    const ensureCallsBeforeRouteDecisionTicketDigestMismatchRecovery =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionTicketDigestMismatchRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionTicketDigestMismatchRecovery =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionTicketDigestMismatchRecovery = persistedMeta.length;
    const recoveredAfterRouteDecisionTicketDigestMismatchReject =
      await rehydratedAfterRouteDecisionTicketDigestMismatchRejectManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      });
    expect(recoveredAfterRouteDecisionTicketDigestMismatchReject.meta.routeLaw).toEqual(
      expectedRouteLaw,
    );
    expect(
      recoveredAfterRouteDecisionTicketDigestMismatchReject.meta.runtimeOptions,
    ).toBeUndefined();
    expect(recoveredAfterRouteDecisionTicketDigestMismatchReject.meta.state).toBe("idle");
    expect(recoveredAfterRouteDecisionTicketDigestMismatchReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionTicketDigestMismatchRecovery + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionTicketDigestMismatchRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionTicketDigestMismatchRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(
      persistedMetaBeforeRouteDecisionTicketDigestMismatchRecovery + 1,
    );

    const afterRouteDecisionTicketDigestMismatchRecovery =
      rehydratedAfterRouteDecisionTicketDigestMismatchRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterRouteDecisionTicketDigestMismatchRecovery.kind).toBe("ready");
    if (afterRouteDecisionTicketDigestMismatchRecovery.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionTicketDigestMismatchRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionTicketDigestMismatchRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionTicketDigestMismatchRecovery.meta.state).toBe("idle");
    expect(afterRouteDecisionTicketDigestMismatchRecovery.meta.lastError).toBeUndefined();

    const routeDecisionWithDecisionIdMismatch = structuredClone(
      CLEAN_ROUTE_DECISION_JSON,
    ) as Record<string, unknown>;
    routeDecisionWithDecisionIdMismatch.cousinTicket = {
      ...(routeDecisionWithDecisionIdMismatch.cousinTicket as Record<string, unknown>),
      decisionId: "route-decision.engineering-to-ops.route-decision-mismatch",
    };
    const ensureCallsBeforeRouteDecisionDecisionIdMismatchReject =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionDecisionIdMismatchReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionDecisionIdMismatchReject =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionDecisionIdMismatchReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: routeDecisionWithDecisionIdMismatch,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("frozen M12 schema validation"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionDecisionIdMismatchReject,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionDecisionIdMismatchReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionDecisionIdMismatchReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeRouteDecisionDecisionIdMismatchReject);

    const afterRouteDecisionDecisionIdMismatchReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterRouteDecisionDecisionIdMismatchReject.kind).toBe("ready");
    if (afterRouteDecisionDecisionIdMismatchReject.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionDecisionIdMismatchReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionDecisionIdMismatchReject.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionDecisionIdMismatchReject.meta.state).toBe("idle");
    expect(afterRouteDecisionDecisionIdMismatchReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeRouteDecisionDecisionIdMismatchRehydrate =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionDecisionIdMismatchRehydrate =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionDecisionIdMismatchRehydrate =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionDecisionIdMismatchRehydrate = persistedMeta.length;
    const rehydratedAfterRouteDecisionDecisionIdMismatchRejectManager = new AcpSessionManager();
    const statusAfterRouteDecisionDecisionIdMismatchRehydrate =
      await rehydratedAfterRouteDecisionDecisionIdMismatchRejectManager.getSessionStatus({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(statusAfterRouteDecisionDecisionIdMismatchRehydrate.state).toBe("idle");
    expect(statusAfterRouteDecisionDecisionIdMismatchRehydrate.runtimeOptions).toEqual({});
    expect(statusAfterRouteDecisionDecisionIdMismatchRehydrate.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionDecisionIdMismatchRehydrate + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionDecisionIdMismatchRehydrate + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionDecisionIdMismatchRehydrate,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeRouteDecisionDecisionIdMismatchRehydrate);

    const afterRouteDecisionDecisionIdMismatchRehydrate =
      rehydratedAfterRouteDecisionDecisionIdMismatchRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterRouteDecisionDecisionIdMismatchRehydrate.kind).toBe("ready");
    if (afterRouteDecisionDecisionIdMismatchRehydrate.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionDecisionIdMismatchRehydrate.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionDecisionIdMismatchRehydrate.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionDecisionIdMismatchRehydrate.meta.state).toBe("idle");
    expect(afterRouteDecisionDecisionIdMismatchRehydrate.meta.lastError).toBeUndefined();

    const ensureCallsBeforeRouteDecisionDecisionIdMismatchRecovery =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionDecisionIdMismatchRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionDecisionIdMismatchRecovery =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionDecisionIdMismatchRecovery = persistedMeta.length;
    const recoveredAfterRouteDecisionDecisionIdMismatchReject =
      await rehydratedAfterRouteDecisionDecisionIdMismatchRejectManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      });
    expect(recoveredAfterRouteDecisionDecisionIdMismatchReject.meta.routeLaw).toEqual(
      expectedRouteLaw,
    );
    expect(recoveredAfterRouteDecisionDecisionIdMismatchReject.meta.runtimeOptions).toBeUndefined();
    expect(recoveredAfterRouteDecisionDecisionIdMismatchReject.meta.state).toBe("idle");
    expect(recoveredAfterRouteDecisionDecisionIdMismatchReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionDecisionIdMismatchRecovery + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionDecisionIdMismatchRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionDecisionIdMismatchRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(
      persistedMetaBeforeRouteDecisionDecisionIdMismatchRecovery + 1,
    );

    const afterRouteDecisionDecisionIdMismatchRecovery =
      rehydratedAfterRouteDecisionDecisionIdMismatchRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterRouteDecisionDecisionIdMismatchRecovery.kind).toBe("ready");
    if (afterRouteDecisionDecisionIdMismatchRecovery.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionDecisionIdMismatchRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionDecisionIdMismatchRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionDecisionIdMismatchRecovery.meta.state).toBe("idle");
    expect(afterRouteDecisionDecisionIdMismatchRecovery.meta.lastError).toBeUndefined();

    const routeDecisionWithSchemaInvalidCousinTicketBinding = structuredClone(
      CLEAN_ROUTE_DECISION_JSON,
    ) as Record<string, unknown>;
    routeDecisionWithSchemaInvalidCousinTicketBinding.cousinTicket = {
      ...(routeDecisionWithSchemaInvalidCousinTicketBinding.cousinTicket as Record<
        string,
        unknown
      >),
      invalidBindingField: "schema-invalid",
    };
    const ensureCallsBeforeRouteDecisionSchemaInvalidBindingReject =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionSchemaInvalidBindingReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionSchemaInvalidBindingReject =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionSchemaInvalidBindingReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: routeDecisionWithSchemaInvalidCousinTicketBinding,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("frozen M12 schema validation"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionSchemaInvalidBindingReject,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionSchemaInvalidBindingReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionSchemaInvalidBindingReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeRouteDecisionSchemaInvalidBindingReject);

    const afterRouteDecisionSchemaInvalidBindingReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterRouteDecisionSchemaInvalidBindingReject.kind).toBe("ready");
    if (afterRouteDecisionSchemaInvalidBindingReject.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionSchemaInvalidBindingReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionSchemaInvalidBindingReject.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionSchemaInvalidBindingReject.meta.state).toBe("idle");
    expect(afterRouteDecisionSchemaInvalidBindingReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeRouteDecisionSchemaInvalidBindingRehydrate =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionSchemaInvalidBindingRehydrate =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionSchemaInvalidBindingRehydrate =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionSchemaInvalidBindingRehydrate = persistedMeta.length;
    const rehydratedAfterRouteDecisionSchemaInvalidBindingRejectManager = new AcpSessionManager();
    const statusAfterRouteDecisionSchemaInvalidBindingRehydrate =
      await rehydratedAfterRouteDecisionSchemaInvalidBindingRejectManager.getSessionStatus({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(statusAfterRouteDecisionSchemaInvalidBindingRehydrate.state).toBe("idle");
    expect(statusAfterRouteDecisionSchemaInvalidBindingRehydrate.runtimeOptions).toEqual({});
    expect(statusAfterRouteDecisionSchemaInvalidBindingRehydrate.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionSchemaInvalidBindingRehydrate + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionSchemaInvalidBindingRehydrate + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionSchemaInvalidBindingRehydrate,
    );
    expect(persistedMeta).toHaveLength(
      persistedMetaBeforeRouteDecisionSchemaInvalidBindingRehydrate,
    );

    const afterRouteDecisionSchemaInvalidBindingRehydrate =
      rehydratedAfterRouteDecisionSchemaInvalidBindingRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterRouteDecisionSchemaInvalidBindingRehydrate.kind).toBe("ready");
    if (afterRouteDecisionSchemaInvalidBindingRehydrate.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionSchemaInvalidBindingRehydrate.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionSchemaInvalidBindingRehydrate.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionSchemaInvalidBindingRehydrate.meta.state).toBe("idle");
    expect(afterRouteDecisionSchemaInvalidBindingRehydrate.meta.lastError).toBeUndefined();

    const ensureCallsBeforeRouteDecisionSchemaInvalidBindingRecovery =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeRouteDecisionSchemaInvalidBindingRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeRouteDecisionSchemaInvalidBindingRecovery =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeRouteDecisionSchemaInvalidBindingRecovery = persistedMeta.length;
    const recoveredAfterRouteDecisionSchemaInvalidBindingReject =
      await rehydratedAfterRouteDecisionSchemaInvalidBindingRejectManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      });
    expect(recoveredAfterRouteDecisionSchemaInvalidBindingReject.meta.routeLaw).toEqual(
      expectedRouteLaw,
    );
    expect(
      recoveredAfterRouteDecisionSchemaInvalidBindingReject.meta.runtimeOptions,
    ).toBeUndefined();
    expect(recoveredAfterRouteDecisionSchemaInvalidBindingReject.meta.state).toBe("idle");
    expect(recoveredAfterRouteDecisionSchemaInvalidBindingReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeRouteDecisionSchemaInvalidBindingRecovery + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeRouteDecisionSchemaInvalidBindingRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeRouteDecisionSchemaInvalidBindingRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(
      persistedMetaBeforeRouteDecisionSchemaInvalidBindingRecovery + 1,
    );

    const afterRouteDecisionSchemaInvalidBindingRecovery =
      rehydratedAfterRouteDecisionSchemaInvalidBindingRejectManager.resolveSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(afterRouteDecisionSchemaInvalidBindingRecovery.kind).toBe("ready");
    if (afterRouteDecisionSchemaInvalidBindingRecovery.kind !== "ready") {
      return;
    }
    expect(afterRouteDecisionSchemaInvalidBindingRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterRouteDecisionSchemaInvalidBindingRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterRouteDecisionSchemaInvalidBindingRecovery.meta.state).toBe("idle");
    expect(afterRouteDecisionSchemaInvalidBindingRecovery.meta.lastError).toBeUndefined();

    const ensureCallsBeforeSchemaInvalidRehydrateReject =
      runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeSchemaInvalidRehydrateReject =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeSchemaInvalidRehydrateReject =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeSchemaInvalidRehydrateReject = persistedMeta.length;
    await expect(
      restartedManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: schemaInvalidRouteDecision,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("frozen M12 schema validation"),
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeSchemaInvalidRehydrateReject,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeSchemaInvalidRehydrateReject,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeSchemaInvalidRehydrateReject,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeSchemaInvalidRehydrateReject);

    const afterSchemaInvalidRehydrateReject = restartedManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterSchemaInvalidRehydrateReject.kind).toBe("ready");
    if (afterSchemaInvalidRehydrateReject.kind !== "ready") {
      return;
    }
    expect(afterSchemaInvalidRehydrateReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterSchemaInvalidRehydrateReject.meta.runtimeOptions).toBeUndefined();
    expect(afterSchemaInvalidRehydrateReject.meta.state).toBe("idle");
    expect(afterSchemaInvalidRehydrateReject.meta.lastError).toBeUndefined();

    const ensureCallsBeforeSchemaInvalidRehydrate = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeSchemaInvalidRehydrate =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeSchemaInvalidRehydrate =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeSchemaInvalidRehydrate = persistedMeta.length;
    const rehydratedAfterSchemaInvalidRejectManager = new AcpSessionManager();
    const statusAfterSchemaInvalidRehydrate =
      await rehydratedAfterSchemaInvalidRejectManager.getSessionStatus({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
      });
    expect(statusAfterSchemaInvalidRehydrate.state).toBe("idle");
    expect(statusAfterSchemaInvalidRehydrate.runtimeOptions).toEqual({});
    expect(statusAfterSchemaInvalidRehydrate.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeSchemaInvalidRehydrate + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeSchemaInvalidRehydrate + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeSchemaInvalidRehydrate,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeSchemaInvalidRehydrate);

    const afterSchemaInvalidRehydrate = rehydratedAfterSchemaInvalidRejectManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterSchemaInvalidRehydrate.kind).toBe("ready");
    if (afterSchemaInvalidRehydrate.kind !== "ready") {
      return;
    }
    expect(afterSchemaInvalidRehydrate.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterSchemaInvalidRehydrate.meta.runtimeOptions).toBeUndefined();
    expect(afterSchemaInvalidRehydrate.meta.state).toBe("idle");
    expect(afterSchemaInvalidRehydrate.meta.lastError).toBeUndefined();

    const ensureCallsBeforeSchemaInvalidRecovery = runtimeState.ensureSession.mock.calls.length;
    const backendCallsBeforeSchemaInvalidRecovery =
      hoisted.requireAcpRuntimeBackendMock.mock.calls.length;
    const upsertCallsBeforeSchemaInvalidRecovery =
      hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    const persistedMetaBeforeSchemaInvalidRecovery = persistedMeta.length;
    const recoveredAfterSchemaInvalidReject =
      await rehydratedAfterSchemaInvalidRejectManager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:route-law-allow",
        agent: "codex",
        mode: "persistent",
        routeLawBundle: {
          routeDecision: CLEAN_ROUTE_DECISION_JSON,
          cousinTicket: CLEAN_COUSIN_TICKET_JSON,
        },
      });
    expect(recoveredAfterSchemaInvalidReject.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(recoveredAfterSchemaInvalidReject.meta.runtimeOptions).toBeUndefined();
    expect(recoveredAfterSchemaInvalidReject.meta.state).toBe("idle");
    expect(recoveredAfterSchemaInvalidReject.meta.lastError).toBeUndefined();
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(
      ensureCallsBeforeSchemaInvalidRecovery + 1,
    );
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(
      backendCallsBeforeSchemaInvalidRecovery + 1,
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(
      upsertCallsBeforeSchemaInvalidRecovery + 1,
    );
    expect(persistedMeta).toHaveLength(persistedMetaBeforeSchemaInvalidRecovery + 1);

    const afterSchemaInvalidRecovery = rehydratedAfterSchemaInvalidRejectManager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:route-law-allow",
    });
    expect(afterSchemaInvalidRecovery.kind).toBe("ready");
    if (afterSchemaInvalidRecovery.kind !== "ready") {
      return;
    }
    expect(afterSchemaInvalidRecovery.meta.routeLaw).toEqual(expectedRouteLaw);
    expect(afterSchemaInvalidRecovery.meta.runtimeOptions).toBeUndefined();
    expect(afterSchemaInvalidRecovery.meta.state).toBe("idle");
    expect(afterSchemaInvalidRecovery.meta.lastError).toBeUndefined();

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(29);
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledTimes(29);
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(28);
    expect(persistedMeta).toHaveLength(27);
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

  it("continues startup reconcile after ensureSession failure and keeps metadata isolated", async () => {
    const runtimeState = createRuntime();
    const pendingFailKey = "agent:codex:acp:pending-ensure-fail";
    const pendingResolveKey = "agent:codex:acp:pending-ensure-resolve";
    const resolvedSkipKey = "agent:codex:acp:resolved-skip";
    runtimeState.ensureSession.mockImplementation(
      async (input: { sessionKey: string; agent: string; mode: "persistent" | "oneshot" }) => {
        if (input.sessionKey === pendingFailKey) {
          throw new Error("ensure failed for pending entry");
        }
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        };
      },
    );
    runtimeState.getStatus.mockImplementation(async (paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { handle?: { sessionKey?: string } }).handle?.sessionKey;
      if (sessionKey === pendingResolveKey) {
        return {
          summary: "status=alive",
          backendSessionId: "acpx-fresh-resolve",
          agentSessionId: "agent-fresh-resolve",
          details: { status: "alive" },
        };
      }
      return {
        summary: "status=alive",
        details: { status: "alive" },
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const currentBySession: Record<string, SessionAcpMeta> = {
      [pendingFailKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${pendingFailKey}:persistent:runtime`,
        identity: {
          state: "pending",
          source: "ensure",
          acpxSessionId: "acpx-stale-fail",
          lastUpdatedAt: Date.now(),
        },
      },
      [pendingResolveKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${pendingResolveKey}:persistent:runtime`,
        identity: {
          state: "pending",
          source: "ensure",
          acpxSessionId: "acpx-stale-resolve",
          lastUpdatedAt: Date.now(),
        },
      },
      [resolvedSkipKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${resolvedSkipKey}:persistent:runtime`,
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-resolved-stable",
          agentSessionId: "agent-resolved-stable",
          lastUpdatedAt: Date.now(),
        },
      },
    };

    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingFailKey,
        storeSessionKey: pendingFailKey,
        entry: {
          sessionId: "session-pending-fail",
          updatedAt: Date.now(),
          acp: currentBySession[pendingFailKey],
        },
        acp: currentBySession[pendingFailKey],
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingResolveKey,
        storeSessionKey: pendingResolveKey,
        entry: {
          sessionId: "session-pending-resolve",
          updatedAt: Date.now(),
          acp: currentBySession[pendingResolveKey],
        },
        acp: currentBySession[pendingResolveKey],
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: resolvedSkipKey,
        storeSessionKey: resolvedSkipKey,
        entry: {
          sessionId: "session-resolved-skip",
          updatedAt: Date.now(),
          acp: currentBySession[resolvedSkipKey],
        },
        acp: currentBySession[resolvedSkipKey],
      },
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      const current = currentBySession[sessionKey];
      if (!current) {
        return null;
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: current,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const current = currentBySession[params.sessionKey];
      const next = params.mutate(current, current ? { acp: current } : undefined);
      if (next) {
        currentBySession[params.sessionKey] = next;
      }
      return {
        sessionId: `session-${params.sessionKey}`,
        updatedAt: Date.now(),
        acp: currentBySession[params.sessionKey],
      };
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 2, resolved: 1, failed: 1 });
    const ensuredKeys = runtimeState.ensureSession.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(ensuredKeys).toEqual([pendingFailKey, pendingResolveKey]);
    const statusKeys = runtimeState.getStatus.mock.calls.map(
      ([firstArg]) => (firstArg as { handle?: { sessionKey?: string } }).handle?.sessionKey,
    );
    expect(statusKeys).toEqual([pendingResolveKey]);
    const upsertedSessions = hoisted.upsertAcpSessionMetaMock.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(upsertedSessions).toEqual([pendingResolveKey]);

    expect(currentBySession[pendingFailKey].identity?.state).toBe("pending");
    expect(currentBySession[pendingFailKey].identity?.acpxSessionId).toBe("acpx-stale-fail");
    expect(currentBySession[pendingFailKey].state).toBe("idle");
    expect(currentBySession[pendingFailKey].lastError).toBeUndefined();

    expect(currentBySession[pendingResolveKey].identity?.state).toBe("resolved");
    expect(currentBySession[pendingResolveKey].identity?.acpxSessionId).toBe("acpx-fresh-resolve");
    expect(currentBySession[pendingResolveKey].identity?.agentSessionId).toBe(
      "agent-fresh-resolve",
    );
    expect(currentBySession[pendingResolveKey].state).toBe("idle");
    expect(currentBySession[pendingResolveKey].lastError).toBeUndefined();

    expect(currentBySession[resolvedSkipKey].identity?.state).toBe("resolved");
    expect(currentBySession[resolvedSkipKey].identity?.acpxSessionId).toBe("acpx-resolved-stable");
    expect(currentBySession[resolvedSkipKey].identity?.agentSessionId).toBe(
      "agent-resolved-stable",
    );
  });

  it("accounts for multiple ensureSession startup failures while resolving surviving pending entries", async () => {
    const runtimeState = createRuntime();
    const pendingFailOneKey = "agent:codex:acp:pending-ensure-fail-one";
    const pendingResolveKey = "agent:codex:acp:pending-ensure-resolve";
    const pendingFailTwoKey = "agent:codex:acp:pending-ensure-fail-two";
    runtimeState.ensureSession.mockImplementation(
      async (input: { sessionKey: string; agent: string; mode: "persistent" | "oneshot" }) => {
        if (input.sessionKey === pendingFailOneKey || input.sessionKey === pendingFailTwoKey) {
          throw new Error(`ensure failed for ${input.sessionKey}`);
        }
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        };
      },
    );
    runtimeState.getStatus.mockImplementation(async (paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { handle?: { sessionKey?: string } }).handle?.sessionKey;
      if (sessionKey === pendingResolveKey) {
        return {
          summary: "status=alive",
          backendSessionId: "acpx-fresh-only",
          agentSessionId: "agent-fresh-only",
          details: { status: "alive" },
        };
      }
      return {
        summary: "status=alive",
        details: { status: "alive" },
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const currentBySession: Record<string, SessionAcpMeta> = {
      [pendingFailOneKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${pendingFailOneKey}:persistent:runtime`,
        identity: {
          state: "pending",
          source: "ensure",
          acpxSessionId: "acpx-stale-fail-one",
          lastUpdatedAt: Date.now(),
        },
      },
      [pendingResolveKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${pendingResolveKey}:persistent:runtime`,
        identity: {
          state: "pending",
          source: "ensure",
          acpxSessionId: "acpx-stale-resolve",
          lastUpdatedAt: Date.now(),
        },
      },
      [pendingFailTwoKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${pendingFailTwoKey}:persistent:runtime`,
        identity: {
          state: "pending",
          source: "ensure",
          acpxSessionId: "acpx-stale-fail-two",
          lastUpdatedAt: Date.now(),
        },
      },
    };

    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingFailOneKey,
        storeSessionKey: pendingFailOneKey,
        entry: {
          sessionId: "session-pending-fail-one",
          updatedAt: Date.now(),
          acp: currentBySession[pendingFailOneKey],
        },
        acp: currentBySession[pendingFailOneKey],
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingResolveKey,
        storeSessionKey: pendingResolveKey,
        entry: {
          sessionId: "session-pending-resolve",
          updatedAt: Date.now(),
          acp: currentBySession[pendingResolveKey],
        },
        acp: currentBySession[pendingResolveKey],
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingFailTwoKey,
        storeSessionKey: pendingFailTwoKey,
        entry: {
          sessionId: "session-pending-fail-two",
          updatedAt: Date.now(),
          acp: currentBySession[pendingFailTwoKey],
        },
        acp: currentBySession[pendingFailTwoKey],
      },
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      const current = currentBySession[sessionKey];
      if (!current) {
        return null;
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: current,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const current = currentBySession[params.sessionKey];
      const next = params.mutate(current, current ? { acp: current } : undefined);
      if (next) {
        currentBySession[params.sessionKey] = next;
      }
      return {
        sessionId: `session-${params.sessionKey}`,
        updatedAt: Date.now(),
        acp: currentBySession[params.sessionKey],
      };
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 3, resolved: 1, failed: 2 });
    const ensuredKeys = runtimeState.ensureSession.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(ensuredKeys).toEqual([pendingFailOneKey, pendingResolveKey, pendingFailTwoKey]);
    const statusKeys = runtimeState.getStatus.mock.calls.map(
      ([firstArg]) => (firstArg as { handle?: { sessionKey?: string } }).handle?.sessionKey,
    );
    expect(statusKeys).toEqual([pendingResolveKey]);
    const upsertedSessions = hoisted.upsertAcpSessionMetaMock.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(upsertedSessions).toEqual([pendingResolveKey]);

    expect(currentBySession[pendingFailOneKey].identity?.state).toBe("pending");
    expect(currentBySession[pendingFailOneKey].identity?.acpxSessionId).toBe("acpx-stale-fail-one");
    expect(currentBySession[pendingFailOneKey].state).toBe("idle");
    expect(currentBySession[pendingFailOneKey].lastError).toBeUndefined();

    expect(currentBySession[pendingFailTwoKey].identity?.state).toBe("pending");
    expect(currentBySession[pendingFailTwoKey].identity?.acpxSessionId).toBe("acpx-stale-fail-two");
    expect(currentBySession[pendingFailTwoKey].state).toBe("idle");
    expect(currentBySession[pendingFailTwoKey].lastError).toBeUndefined();

    expect(currentBySession[pendingResolveKey].identity?.state).toBe("resolved");
    expect(currentBySession[pendingResolveKey].identity?.acpxSessionId).toBe("acpx-fresh-only");
    expect(currentBySession[pendingResolveKey].identity?.agentSessionId).toBe("agent-fresh-only");
    expect(currentBySession[pendingResolveKey].state).toBe("idle");
    expect(currentBySession[pendingResolveKey].lastError).toBeUndefined();
  });

  it("reports startup discovery failure as a top-level reconcile failure without entry processing", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.listAcpSessionEntriesMock.mockRejectedValueOnce(new Error("startup list unavailable"));

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, resolved: 0, failed: 1 });
    expect(hoisted.listAcpSessionEntriesMock).toHaveBeenCalledTimes(1);
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
  });

  it("treats empty startup discovery as a clean no-op distinct from discovery failure", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.listAcpSessionEntriesMock.mockResolvedValueOnce([]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, resolved: 0, failed: 0 });
    expect(hoisted.listAcpSessionEntriesMock).toHaveBeenCalledTimes(1);
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
  });

  it("recovers cleanly on the next startup reconcile after a discovery failure", async () => {
    const runtimeState = createRuntime();
    const pendingKey = "agent:codex:acp:pending-after-list-failure";
    const resolvedSkipKey = "agent:codex:acp:resolved-after-list-failure";
    runtimeState.getStatus.mockImplementation(async (paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { handle?: { sessionKey?: string } }).handle?.sessionKey;
      if (sessionKey === pendingKey) {
        return {
          summary: "status=alive",
          backendSessionId: "acpx-pending-recovered",
          agentSessionId: "agent-pending-recovered",
          details: { status: "alive" },
        };
      }
      return {
        summary: "status=alive",
        details: { status: "alive" },
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const currentBySession: Record<string, SessionAcpMeta> = {
      [pendingKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${pendingKey}:persistent:runtime`,
        identity: {
          state: "pending",
          source: "ensure",
          acpxSessionId: "acpx-stale-after-list-failure",
          lastUpdatedAt: Date.now(),
        },
      },
      [resolvedSkipKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${resolvedSkipKey}:persistent:runtime`,
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-resolved-stable",
          agentSessionId: "agent-resolved-stable",
          lastUpdatedAt: Date.now(),
        },
      },
    };
    hoisted.listAcpSessionEntriesMock
      .mockRejectedValueOnce(new Error("startup list unavailable"))
      .mockResolvedValueOnce([
        {
          cfg: baseCfg,
          storePath: "/tmp/sessions-acp.json",
          sessionKey: pendingKey,
          storeSessionKey: pendingKey,
          entry: {
            sessionId: "session-pending-after-list-failure",
            updatedAt: Date.now(),
            acp: currentBySession[pendingKey],
          },
          acp: currentBySession[pendingKey],
        },
        {
          cfg: baseCfg,
          storePath: "/tmp/sessions-acp.json",
          sessionKey: resolvedSkipKey,
          storeSessionKey: resolvedSkipKey,
          entry: {
            sessionId: "session-resolved-after-list-failure",
            updatedAt: Date.now(),
            acp: currentBySession[resolvedSkipKey],
          },
          acp: currentBySession[resolvedSkipKey],
        },
      ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      const current = currentBySession[sessionKey];
      if (!current) {
        return null;
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: current,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const current = currentBySession[params.sessionKey];
      const next = params.mutate(current, current ? { acp: current } : undefined);
      if (next) {
        currentBySession[params.sessionKey] = next;
      }
      return {
        sessionId: `session-${params.sessionKey}`,
        updatedAt: Date.now(),
        acp: currentBySession[params.sessionKey],
      };
    });

    const manager = new AcpSessionManager();
    const first = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });
    expect(first).toEqual({ checked: 0, resolved: 0, failed: 1 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();

    const second = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });
    expect(second).toEqual({ checked: 1, resolved: 1, failed: 0 });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(1);

    expect(currentBySession[pendingKey].identity?.state).toBe("resolved");
    expect(currentBySession[pendingKey].identity?.acpxSessionId).toBe("acpx-pending-recovered");
    expect(currentBySession[pendingKey].identity?.agentSessionId).toBe("agent-pending-recovered");
    expect(currentBySession[pendingKey].state).toBe("idle");
    expect(currentBySession[pendingKey].lastError).toBeUndefined();

    expect(currentBySession[resolvedSkipKey].identity?.state).toBe("resolved");
    expect(currentBySession[resolvedSkipKey].identity?.acpxSessionId).toBe("acpx-resolved-stable");
    expect(currentBySession[resolvedSkipKey].identity?.agentSessionId).toBe(
      "agent-resolved-stable",
    );
    expect(currentBySession[resolvedSkipKey].state).toBe("idle");
    expect(currentBySession[resolvedSkipKey].lastError).toBeUndefined();
  });

  it("skips startup discovery entries when acp metadata is missing", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: "agent:codex:acp:missing-acp",
        storeSessionKey: "agent:codex:acp:missing-acp",
        entry: {
          sessionId: "session-missing-acp",
          updatedAt: Date.now(),
        },
      } as unknown as AcpSessionStoreEntry,
    ]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, resolved: 0, failed: 0 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
  });

  it("skips startup discovery entries when sessionKey is missing", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        storeSessionKey: "agent:codex:acp:missing-session-key",
        entry: {
          sessionId: "session-missing-session-key",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta(),
            identity: {
              state: "pending",
              source: "ensure",
              acpxSessionId: "acpx-stale-missing-session-key",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta(),
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-stale-missing-session-key",
            lastUpdatedAt: Date.now(),
          },
        },
      } as unknown as AcpSessionStoreEntry,
    ]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, resolved: 0, failed: 0 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
  });

  it("counts malformed discovery entries as skips, not failures", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: "agent:codex:acp:missing-acp",
        storeSessionKey: "agent:codex:acp:missing-acp",
        entry: {
          sessionId: "session-missing-acp",
          updatedAt: Date.now(),
        },
      } as unknown as AcpSessionStoreEntry,
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        storeSessionKey: "agent:codex:acp:missing-session-key",
        entry: {
          sessionId: "session-missing-session-key",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta(),
            identity: {
              state: "pending",
              source: "ensure",
              acpxSessionId: "acpx-stale-missing-session-key",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta(),
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-stale-missing-session-key",
            lastUpdatedAt: Date.now(),
          },
        },
      } as unknown as AcpSessionStoreEntry,
    ]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, resolved: 0, failed: 0 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
  });

  it("isolates malformed startup discovery entries while reconciling valid entries in the same batch", async () => {
    const runtimeState = createRuntime();
    const pendingKey = "agent:codex:acp:pending-mixed-batch";
    const resolvedSkipKey = "agent:codex:acp:resolved-mixed-batch";
    runtimeState.getStatus.mockImplementation(async (paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { handle?: { sessionKey?: string } }).handle?.sessionKey;
      if (sessionKey === pendingKey) {
        return {
          summary: "status=alive",
          backendSessionId: "acpx-fresh-mixed",
          agentSessionId: "agent-fresh-mixed",
          details: { status: "alive" },
        };
      }
      return {
        summary: "status=alive",
        details: { status: "alive" },
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const currentBySession: Record<string, SessionAcpMeta> = {
      [pendingKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${pendingKey}:persistent:runtime`,
        identity: {
          state: "pending",
          source: "ensure",
          acpxSessionId: "acpx-stale-mixed",
          lastUpdatedAt: Date.now(),
        },
      },
      [resolvedSkipKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${resolvedSkipKey}:persistent:runtime`,
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-resolved-stable-mixed",
          agentSessionId: "agent-resolved-stable-mixed",
          lastUpdatedAt: Date.now(),
        },
      },
    };

    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: "agent:codex:acp:missing-acp",
        storeSessionKey: "agent:codex:acp:missing-acp",
        entry: {
          sessionId: "session-missing-acp",
          updatedAt: Date.now(),
        },
      } as unknown as AcpSessionStoreEntry,
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        storeSessionKey: "agent:codex:acp:missing-session-key",
        entry: {
          sessionId: "session-missing-session-key",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta(),
            identity: {
              state: "pending",
              source: "ensure",
              acpxSessionId: "acpx-stale-missing-session-key",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta(),
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-stale-missing-session-key",
            lastUpdatedAt: Date.now(),
          },
        },
      } as unknown as AcpSessionStoreEntry,
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingKey,
        storeSessionKey: pendingKey,
        entry: {
          sessionId: "session-pending-mixed",
          updatedAt: Date.now(),
          acp: currentBySession[pendingKey],
        },
        acp: currentBySession[pendingKey],
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: resolvedSkipKey,
        storeSessionKey: resolvedSkipKey,
        entry: {
          sessionId: "session-resolved-mixed",
          updatedAt: Date.now(),
          acp: currentBySession[resolvedSkipKey],
        },
        acp: currentBySession[resolvedSkipKey],
      },
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      const current = currentBySession[sessionKey];
      if (!current) {
        return null;
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: current,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const current = currentBySession[params.sessionKey];
      const next = params.mutate(current, current ? { acp: current } : undefined);
      if (next) {
        currentBySession[params.sessionKey] = next;
      }
      return {
        sessionId: `session-${params.sessionKey}`,
        updatedAt: Date.now(),
        acp: currentBySession[params.sessionKey],
      };
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 1, resolved: 1, failed: 0 });
    const ensuredKeys = runtimeState.ensureSession.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(ensuredKeys).toEqual([pendingKey]);
    const statusKeys = runtimeState.getStatus.mock.calls.map(
      ([firstArg]) => (firstArg as { handle?: { sessionKey?: string } }).handle?.sessionKey,
    );
    expect(statusKeys).toEqual([pendingKey]);
    const upsertedSessions = hoisted.upsertAcpSessionMetaMock.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(upsertedSessions).toEqual([pendingKey]);

    expect(currentBySession[pendingKey].identity?.state).toBe("resolved");
    expect(currentBySession[pendingKey].identity?.acpxSessionId).toBe("acpx-fresh-mixed");
    expect(currentBySession[pendingKey].identity?.agentSessionId).toBe("agent-fresh-mixed");
    expect(currentBySession[pendingKey].state).toBe("idle");
    expect(currentBySession[pendingKey].lastError).toBeUndefined();

    expect(currentBySession[resolvedSkipKey].identity?.state).toBe("resolved");
    expect(currentBySession[resolvedSkipKey].identity?.acpxSessionId).toBe(
      "acpx-resolved-stable-mixed",
    );
    expect(currentBySession[resolvedSkipKey].identity?.agentSessionId).toBe(
      "agent-resolved-stable-mixed",
    );
    expect(currentBySession[resolvedSkipKey].state).toBe("idle");
    expect(currentBySession[resolvedSkipKey].lastError).toBeUndefined();
  });

  it("skips pending discovery entries when readSessionEntry returns null at reconcile time", async () => {
    const runtimeState = createRuntime();
    const pendingKey = "agent:codex:acp:pending-read-null";
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingKey,
        storeSessionKey: pendingKey,
        entry: {
          sessionId: "session-pending-read-null",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `${pendingKey}:persistent:runtime`,
            identity: {
              state: "pending",
              source: "ensure",
              acpxSessionId: "acpx-stale-read-null",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `${pendingKey}:persistent:runtime`,
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-stale-read-null",
            lastUpdatedAt: Date.now(),
          },
        },
      } as AcpSessionStoreEntry,
    ]);
    hoisted.readAcpSessionEntryMock.mockReturnValue(null);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 1, resolved: 0, failed: 0 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
  });

  it("skips pending discovery entries when readSessionEntry returns an entry without acp metadata", async () => {
    const runtimeState = createRuntime();
    const pendingKey = "agent:codex:acp:pending-read-empty-acp";
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingKey,
        storeSessionKey: pendingKey,
        entry: {
          sessionId: "session-pending-read-empty-acp",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `${pendingKey}:persistent:runtime`,
            identity: {
              state: "pending",
              source: "ensure",
              acpxSessionId: "acpx-stale-read-empty-acp",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `${pendingKey}:persistent:runtime`,
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-stale-read-empty-acp",
            lastUpdatedAt: Date.now(),
          },
        },
      } as AcpSessionStoreEntry,
    ]);
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: pendingKey,
      storeSessionKey: pendingKey,
      entry: {
        sessionId: "session-pending-read-empty-acp",
        updatedAt: Date.now(),
      },
      acp: undefined,
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 1, resolved: 0, failed: 0 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
  });

  it("isolates stale-read and malformed discovery entries while reconciling valid entries in a mixed batch", async () => {
    const runtimeState = createRuntime();
    const pendingReadNullKey = "agent:codex:acp:pending-read-null-mixed";
    const validPendingKey = "agent:codex:acp:pending-valid-mixed";
    const validResolvedKey = "agent:codex:acp:resolved-valid-mixed";
    runtimeState.getStatus.mockImplementation(async (paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { handle?: { sessionKey?: string } }).handle?.sessionKey;
      if (sessionKey === validPendingKey) {
        return {
          summary: "status=alive",
          backendSessionId: "acpx-valid-pending-fresh",
          agentSessionId: "agent-valid-pending-fresh",
          details: { status: "alive" },
        };
      }
      return {
        summary: "status=alive",
        details: { status: "alive" },
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const currentBySession: Record<string, SessionAcpMeta> = {
      [validPendingKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${validPendingKey}:persistent:runtime`,
        identity: {
          state: "pending",
          source: "ensure",
          acpxSessionId: "acpx-valid-pending-stale",
          lastUpdatedAt: Date.now(),
        },
      },
      [validResolvedKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${validResolvedKey}:persistent:runtime`,
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-valid-resolved-stable",
          agentSessionId: "agent-valid-resolved-stable",
          lastUpdatedAt: Date.now(),
        },
      },
    };

    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingReadNullKey,
        storeSessionKey: pendingReadNullKey,
        entry: {
          sessionId: "session-pending-read-null-mixed",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `${pendingReadNullKey}:persistent:runtime`,
            identity: {
              state: "pending",
              source: "ensure",
              acpxSessionId: "acpx-read-null-stale",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `${pendingReadNullKey}:persistent:runtime`,
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-read-null-stale",
            lastUpdatedAt: Date.now(),
          },
        },
      } as AcpSessionStoreEntry,
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        storeSessionKey: "agent:codex:acp:missing-session-key-mixed",
        entry: {
          sessionId: "session-missing-session-key-mixed",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta(),
            identity: {
              state: "pending",
              source: "ensure",
              acpxSessionId: "acpx-missing-session-key-mixed",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta(),
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-missing-session-key-mixed",
            lastUpdatedAt: Date.now(),
          },
        },
      } as unknown as AcpSessionStoreEntry,
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: validPendingKey,
        storeSessionKey: validPendingKey,
        entry: {
          sessionId: "session-valid-pending-mixed",
          updatedAt: Date.now(),
          acp: currentBySession[validPendingKey],
        },
        acp: currentBySession[validPendingKey],
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: validResolvedKey,
        storeSessionKey: validResolvedKey,
        entry: {
          sessionId: "session-valid-resolved-mixed",
          updatedAt: Date.now(),
          acp: currentBySession[validResolvedKey],
        },
        acp: currentBySession[validResolvedKey],
      },
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey === pendingReadNullKey) {
        return null;
      }
      const current = currentBySession[sessionKey];
      if (!current) {
        return null;
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: current,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const current = currentBySession[params.sessionKey];
      const next = params.mutate(current, current ? { acp: current } : undefined);
      if (next) {
        currentBySession[params.sessionKey] = next;
      }
      return {
        sessionId: `session-${params.sessionKey}`,
        updatedAt: Date.now(),
        acp: currentBySession[params.sessionKey],
      };
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 2, resolved: 1, failed: 0 });
    const ensuredKeys = runtimeState.ensureSession.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(ensuredKeys).toEqual([validPendingKey]);
    const statusKeys = runtimeState.getStatus.mock.calls.map(
      ([firstArg]) => (firstArg as { handle?: { sessionKey?: string } }).handle?.sessionKey,
    );
    expect(statusKeys).toEqual([validPendingKey]);
    const upsertedSessions = hoisted.upsertAcpSessionMetaMock.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(upsertedSessions).toEqual([validPendingKey]);

    expect(currentBySession[validPendingKey].identity?.state).toBe("resolved");
    expect(currentBySession[validPendingKey].identity?.acpxSessionId).toBe(
      "acpx-valid-pending-fresh",
    );
    expect(currentBySession[validPendingKey].identity?.agentSessionId).toBe(
      "agent-valid-pending-fresh",
    );
    expect(currentBySession[validPendingKey].state).toBe("idle");
    expect(currentBySession[validPendingKey].lastError).toBeUndefined();

    expect(currentBySession[validResolvedKey].identity?.state).toBe("resolved");
    expect(currentBySession[validResolvedKey].identity?.acpxSessionId).toBe(
      "acpx-valid-resolved-stable",
    );
    expect(currentBySession[validResolvedKey].identity?.agentSessionId).toBe(
      "agent-valid-resolved-stable",
    );
    expect(currentBySession[validResolvedKey].state).toBe("idle");
    expect(currentBySession[validResolvedKey].lastError).toBeUndefined();
  });

  it("recovers on the next run after a stale-read skip entry becomes readable", async () => {
    const runtimeState = createRuntime();
    const pendingReadNullKey = "agent:codex:acp:pending-read-null-recover";
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-read-recover-fresh",
      agentSessionId: "agent-read-recover-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: `${pendingReadNullKey}:persistent:runtime`,
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-read-recover-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingReadNullKey,
        storeSessionKey: pendingReadNullKey,
        entry: {
          sessionId: "session-pending-read-null-recover",
          updatedAt: Date.now(),
          acp: currentMeta,
        },
        acp: currentMeta,
      },
    ] as AcpSessionStoreEntry[]);
    let returnReadableEntry = false;
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey !== pendingReadNullKey || !returnReadableEntry) {
        return null;
      }
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
        sessionId: "session-pending-read-null-recover",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    const first = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });
    expect(first).toEqual({ checked: 1, resolved: 0, failed: 0 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();

    returnReadableEntry = true;
    const second = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });
    expect(second).toEqual({ checked: 1, resolved: 1, failed: 0 });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(1);
    expect(currentMeta.identity?.state).toBe("resolved");
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-read-recover-fresh");
    expect(currentMeta.identity?.agentSessionId).toBe("agent-read-recover-fresh");
    expect(currentMeta.state).toBe("idle");
    expect(currentMeta.lastError).toBeUndefined();
  });

  it("keeps stale-read skips distinct from activation failures in batch accounting", async () => {
    const runtimeState = createRuntime();
    const pendingReadNullKey = "agent:codex:acp:pending-read-null-accounting";
    const pendingEnsureFailKey = "agent:codex:acp:pending-ensure-fail-accounting";
    runtimeState.ensureSession.mockImplementation(
      async (input: { sessionKey: string; agent: string; mode: "persistent" | "oneshot" }) => {
        if (input.sessionKey === pendingEnsureFailKey) {
          throw new Error("ensure failed for accounting lane");
        }
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        };
      },
    );
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const pendingReadNullMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: `${pendingReadNullKey}:persistent:runtime`,
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-read-null-accounting-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    const pendingEnsureFailMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: `${pendingEnsureFailKey}:persistent:runtime`,
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-ensure-fail-accounting-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingReadNullKey,
        storeSessionKey: pendingReadNullKey,
        entry: {
          sessionId: "session-pending-read-null-accounting",
          updatedAt: Date.now(),
          acp: pendingReadNullMeta,
        },
        acp: pendingReadNullMeta,
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingEnsureFailKey,
        storeSessionKey: pendingEnsureFailKey,
        entry: {
          sessionId: "session-pending-ensure-fail-accounting",
          updatedAt: Date.now(),
          acp: pendingEnsureFailMeta,
        },
        acp: pendingEnsureFailMeta,
      },
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey === pendingReadNullKey) {
        return null;
      }
      if (sessionKey === pendingEnsureFailKey) {
        return {
          sessionKey,
          storeSessionKey: sessionKey,
          acp: pendingEnsureFailMeta,
        };
      }
      return null;
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 2, resolved: 0, failed: 1 });
    const ensuredKeys = runtimeState.ensureSession.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(ensuredKeys).toEqual([pendingEnsureFailKey]);
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
  });

  it("continues mixed startup reconcile when one entry read throws and isolates unaffected entries", async () => {
    const runtimeState = createRuntime();
    const readThrowKey = "agent:codex:acp:pending-read-throw";
    const validPendingKey = "agent:codex:acp:pending-valid-after-read-throw";
    const resolvedSkipKey = "agent:codex:acp:resolved-skip-after-read-throw";
    runtimeState.getStatus.mockImplementation(async (paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { handle?: { sessionKey?: string } }).handle?.sessionKey;
      if (sessionKey === validPendingKey) {
        return {
          summary: "status=alive",
          backendSessionId: "acpx-valid-after-read-throw-fresh",
          agentSessionId: "agent-valid-after-read-throw-fresh",
          details: { status: "alive" },
        };
      }
      return {
        summary: "status=alive",
        details: { status: "alive" },
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const currentBySession: Record<string, SessionAcpMeta> = {
      [validPendingKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${validPendingKey}:persistent:runtime`,
        identity: {
          state: "pending",
          source: "ensure",
          acpxSessionId: "acpx-valid-after-read-throw-stale",
          lastUpdatedAt: Date.now(),
        },
      },
      [resolvedSkipKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${resolvedSkipKey}:persistent:runtime`,
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-resolved-after-read-throw-stable",
          agentSessionId: "agent-resolved-after-read-throw-stable",
          lastUpdatedAt: Date.now(),
        },
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: readThrowKey,
        storeSessionKey: readThrowKey,
        entry: {
          sessionId: "session-pending-read-throw",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `${readThrowKey}:persistent:runtime`,
            identity: {
              state: "pending",
              source: "ensure",
              acpxSessionId: "acpx-read-throw-stale",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `${readThrowKey}:persistent:runtime`,
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-read-throw-stale",
            lastUpdatedAt: Date.now(),
          },
        },
      } as AcpSessionStoreEntry,
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: validPendingKey,
        storeSessionKey: validPendingKey,
        entry: {
          sessionId: "session-valid-pending-after-read-throw",
          updatedAt: Date.now(),
          acp: currentBySession[validPendingKey],
        },
        acp: currentBySession[validPendingKey],
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: resolvedSkipKey,
        storeSessionKey: resolvedSkipKey,
        entry: {
          sessionId: "session-resolved-skip-after-read-throw",
          updatedAt: Date.now(),
          acp: currentBySession[resolvedSkipKey],
        },
        acp: currentBySession[resolvedSkipKey],
      },
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey === readThrowKey) {
        throw new Error("read exploded for pending entry");
      }
      const current = currentBySession[sessionKey];
      if (!current) {
        return null;
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: current,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const current = currentBySession[params.sessionKey];
      const next = params.mutate(current, current ? { acp: current } : undefined);
      if (next) {
        currentBySession[params.sessionKey] = next;
      }
      return {
        sessionId: `session-${params.sessionKey}`,
        updatedAt: Date.now(),
        acp: currentBySession[params.sessionKey],
      };
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 2, resolved: 1, failed: 1 });
    const ensuredKeys = runtimeState.ensureSession.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(ensuredKeys).toEqual([validPendingKey]);
    const statusKeys = runtimeState.getStatus.mock.calls.map(
      ([firstArg]) => (firstArg as { handle?: { sessionKey?: string } }).handle?.sessionKey,
    );
    expect(statusKeys).toEqual([validPendingKey]);
    const upsertedSessions = hoisted.upsertAcpSessionMetaMock.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(upsertedSessions).toEqual([validPendingKey]);

    expect(currentBySession[validPendingKey].identity?.state).toBe("resolved");
    expect(currentBySession[validPendingKey].identity?.acpxSessionId).toBe(
      "acpx-valid-after-read-throw-fresh",
    );
    expect(currentBySession[validPendingKey].identity?.agentSessionId).toBe(
      "agent-valid-after-read-throw-fresh",
    );
    expect(currentBySession[validPendingKey].state).toBe("idle");
    expect(currentBySession[validPendingKey].lastError).toBeUndefined();

    expect(currentBySession[resolvedSkipKey].identity?.state).toBe("resolved");
    expect(currentBySession[resolvedSkipKey].identity?.acpxSessionId).toBe(
      "acpx-resolved-after-read-throw-stable",
    );
    expect(currentBySession[resolvedSkipKey].identity?.agentSessionId).toBe(
      "agent-resolved-after-read-throw-stable",
    );
    expect(currentBySession[resolvedSkipKey].state).toBe("idle");
    expect(currentBySession[resolvedSkipKey].lastError).toBeUndefined();
  });

  it("keeps read-throw failures distinct from stale-read skips in startup accounting", async () => {
    const runtimeState = createRuntime();
    const readThrowKey = "agent:codex:acp:pending-read-throw-accounting";
    const readNullKey = "agent:codex:acp:pending-read-null-accounting-boundary";
    const validPendingKey = "agent:codex:acp:pending-valid-accounting-boundary";
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-valid-boundary-fresh",
      agentSessionId: "agent-valid-boundary-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const validPendingMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: `${validPendingKey}:persistent:runtime`,
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-valid-boundary-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: readThrowKey,
        storeSessionKey: readThrowKey,
        entry: {
          sessionId: "session-pending-read-throw-accounting",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `${readThrowKey}:persistent:runtime`,
            identity: {
              state: "pending",
              source: "ensure",
              acpxSessionId: "acpx-read-throw-boundary-stale",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `${readThrowKey}:persistent:runtime`,
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-read-throw-boundary-stale",
            lastUpdatedAt: Date.now(),
          },
        },
      } as AcpSessionStoreEntry,
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: readNullKey,
        storeSessionKey: readNullKey,
        entry: {
          sessionId: "session-pending-read-null-accounting-boundary",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `${readNullKey}:persistent:runtime`,
            identity: {
              state: "pending",
              source: "ensure",
              acpxSessionId: "acpx-read-null-boundary-stale",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `${readNullKey}:persistent:runtime`,
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-read-null-boundary-stale",
            lastUpdatedAt: Date.now(),
          },
        },
      } as AcpSessionStoreEntry,
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: validPendingKey,
        storeSessionKey: validPendingKey,
        entry: {
          sessionId: "session-pending-valid-accounting-boundary",
          updatedAt: Date.now(),
          acp: validPendingMeta,
        },
        acp: validPendingMeta,
      },
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey === readThrowKey) {
        throw new Error("read throw accounting boundary");
      }
      if (sessionKey === readNullKey) {
        return null;
      }
      if (sessionKey === validPendingKey) {
        return {
          sessionKey,
          storeSessionKey: sessionKey,
          acp: validPendingMeta,
        };
      }
      return null;
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(validPendingMeta, { acp: validPendingMeta });
      if (next) {
        Object.assign(validPendingMeta, next);
      }
      return {
        sessionId: "session-pending-valid-accounting-boundary",
        updatedAt: Date.now(),
        acp: validPendingMeta,
      };
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 3, resolved: 1, failed: 1 });
    const ensuredKeys = runtimeState.ensureSession.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(ensuredKeys).toEqual([validPendingKey]);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
  });

  it("does not mark startup reconcile entries resolved when identity persistence write degrades", async () => {
    const runtimeState = createRuntime();
    const pendingKey = "agent:codex:acp:pending-write-degraded";
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-write-degraded-fresh",
      agentSessionId: "agent-write-degraded-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: `${pendingKey}:persistent:runtime`,
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-write-degraded-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingKey,
        storeSessionKey: pendingKey,
        entry: {
          sessionId: "session-pending-write-degraded",
          updatedAt: Date.now(),
          acp: currentMeta,
        },
        acp: currentMeta,
      },
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey !== pendingKey) {
        return null;
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk write degraded"));

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 1, resolved: 0, failed: 0 });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(1);
    expect(currentMeta.identity?.state).toBe("pending");
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-write-degraded-stale");
    expect(currentMeta.identity?.agentSessionId).toBeUndefined();
    expect(currentMeta.lastError).toBeUndefined();
  });

  it("recovers on next startup reconcile after identity write degradation is corrected", async () => {
    const runtimeState = createRuntime();
    const pendingKey = "agent:codex:acp:pending-write-degraded-recovery";
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-write-recovery-fresh",
      agentSessionId: "agent-write-recovery-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: `${pendingKey}:persistent:runtime`,
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-write-recovery-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingKey,
        storeSessionKey: pendingKey,
        entry: {
          sessionId: "session-pending-write-degraded-recovery",
          updatedAt: Date.now(),
          acp: currentMeta,
        },
        acp: currentMeta,
      },
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey !== pendingKey) {
        return null;
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: currentMeta,
      };
    });
    let failWriteOnce = true;
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      if (failWriteOnce) {
        failWriteOnce = false;
        throw new Error("disk write degraded");
      }
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
        sessionId: "session-pending-write-degraded-recovery",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    const first = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });
    expect(first).toEqual({ checked: 1, resolved: 0, failed: 0 });
    expect(currentMeta.identity?.state).toBe("pending");

    const second = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });
    expect(second).toEqual({ checked: 1, resolved: 1, failed: 0 });
    expect(currentMeta.identity?.state).toBe("resolved");
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-write-recovery-fresh");
    expect(currentMeta.identity?.agentSessionId).toBe("agent-write-recovery-fresh");
    expect(currentMeta.lastError).toBeUndefined();
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

  it("surfaces ACP_TURN_FAILED and preserves metadata when getSessionStatus status read throws", async () => {
    const runtimeState = createRuntime();
    runtimeState.getStatus.mockRejectedValueOnce(new Error("status read exploded"));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:session-status-throw";
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: `${sessionKey}:persistent:runtime`,
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      if (key !== sessionKey) {
        return null;
      }
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
    await expect(
      manager.getSessionStatus({
        cfg: baseCfg,
        sessionKey,
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "status read exploded",
    });

    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
    expect(currentMeta.state).toBe("idle");
    expect(currentMeta.lastError).toBeUndefined();

    const afterFailure = manager.resolveSession({
      cfg: baseCfg,
      sessionKey,
    });
    expect(afterFailure.kind).toBe("ready");
    if (afterFailure.kind !== "ready") {
      return;
    }
    expect(afterFailure.meta.state).toBe("idle");
    expect(afterFailure.meta.lastError).toBeUndefined();
  });

  it("tolerates startup status-read failures and keeps reconciling pending identities", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const pendingThrowKey = "agent:codex:acp:pending-status-throw";
    const pendingResolveKey = "agent:codex:acp:pending-status-resolve";
    const resolvedSkipKey = "agent:codex:acp:resolved-status-skip";
    const currentBySession: Record<string, SessionAcpMeta> = {
      [pendingThrowKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${pendingThrowKey}:persistent:runtime`,
        identity: {
          state: "pending",
          source: "ensure",
          acpxSessionId: "acpx-stale-throw",
          lastUpdatedAt: Date.now(),
        },
      },
      [pendingResolveKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${pendingResolveKey}:persistent:runtime`,
        identity: {
          state: "pending",
          source: "ensure",
          acpxSessionId: "acpx-stale-resolve",
          lastUpdatedAt: Date.now(),
        },
      },
      [resolvedSkipKey]: {
        ...readySessionMeta(),
        runtimeSessionName: `${resolvedSkipKey}:persistent:runtime`,
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-resolved-stable",
          agentSessionId: "agent-resolved-stable",
          lastUpdatedAt: Date.now(),
        },
      },
    };

    runtimeState.getStatus.mockImplementation(async (paramsUnknown: unknown) => {
      const sessionKey =
        (
          paramsUnknown as {
            handle?: { sessionKey?: string };
          }
        ).handle?.sessionKey ?? "";
      if (sessionKey === pendingThrowKey) {
        throw new Error("status failed for pending throw");
      }
      if (sessionKey === pendingResolveKey) {
        return {
          summary: "status=alive",
          backendSessionId: "acpx-fresh-resolve",
          agentSessionId: "agent-fresh-resolve",
          details: { status: "alive" },
        };
      }
      return {
        summary: "status=alive",
        details: { status: "alive" },
      };
    });

    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingThrowKey,
        storeSessionKey: pendingThrowKey,
        entry: {
          sessionId: "session-pending-throw",
          updatedAt: Date.now(),
          acp: currentBySession[pendingThrowKey],
        },
        acp: currentBySession[pendingThrowKey],
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: pendingResolveKey,
        storeSessionKey: pendingResolveKey,
        entry: {
          sessionId: "session-pending-resolve",
          updatedAt: Date.now(),
          acp: currentBySession[pendingResolveKey],
        },
        acp: currentBySession[pendingResolveKey],
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: resolvedSkipKey,
        storeSessionKey: resolvedSkipKey,
        entry: {
          sessionId: "session-resolved-skip",
          updatedAt: Date.now(),
          acp: currentBySession[resolvedSkipKey],
        },
        acp: currentBySession[resolvedSkipKey],
      },
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      const current = currentBySession[sessionKey];
      if (!current) {
        return null;
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: current,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const current = currentBySession[params.sessionKey];
      const next = params.mutate(current, current ? { acp: current } : undefined);
      if (next) {
        currentBySession[params.sessionKey] = next;
      }
      return {
        sessionId: `session-${params.sessionKey}`,
        updatedAt: Date.now(),
        acp: currentBySession[params.sessionKey],
      };
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 2, resolved: 1, failed: 0 });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(2);

    const upsertedSessions = hoisted.upsertAcpSessionMetaMock.mock.calls.map(
      ([firstArg]) => (firstArg as { sessionKey: string }).sessionKey,
    );
    expect(upsertedSessions).toEqual([pendingResolveKey]);

    expect(currentBySession[pendingThrowKey].identity?.state).toBe("pending");
    expect(currentBySession[pendingThrowKey].identity?.acpxSessionId).toBe("acpx-stale-throw");
    expect(currentBySession[pendingThrowKey].state).toBe("idle");
    expect(currentBySession[pendingThrowKey].lastError).toBeUndefined();

    expect(currentBySession[pendingResolveKey].identity?.state).toBe("resolved");
    expect(currentBySession[pendingResolveKey].identity?.acpxSessionId).toBe("acpx-fresh-resolve");
    expect(currentBySession[pendingResolveKey].identity?.agentSessionId).toBe(
      "agent-fresh-resolve",
    );
    expect(currentBySession[pendingResolveKey].state).toBe("idle");
    expect(currentBySession[pendingResolveKey].lastError).toBeUndefined();

    expect(currentBySession[resolvedSkipKey].identity?.state).toBe("resolved");
    expect(currentBySession[resolvedSkipKey].identity?.acpxSessionId).toBe("acpx-resolved-stable");
    expect(currentBySession[resolvedSkipKey].identity?.agentSessionId).toBe(
      "agent-resolved-stable",
    );
  });

  it("deduplicates duplicate startup discovery rows by session key and avoids double processing", async () => {
    const runtimeState = createRuntime();
    const duplicateKey = "agent:codex:acp:duplicate-discovery-pending";
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-duplicate-fresh",
      agentSessionId: "agent-duplicate-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: `${duplicateKey}:persistent:runtime`,
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-duplicate-stale-first",
        lastUpdatedAt: Date.now(),
      },
    };

    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: duplicateKey,
        storeSessionKey: duplicateKey,
        entry: {
          sessionId: "session-duplicate-row-first",
          updatedAt: Date.now(),
          acp: currentMeta,
        },
        acp: currentMeta,
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: duplicateKey,
        storeSessionKey: duplicateKey,
        entry: {
          sessionId: "session-duplicate-row-second",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `${duplicateKey}:persistent:runtime`,
            identity: {
              state: "pending",
              source: "ensure",
              acpxSessionId: "acpx-duplicate-stale-second",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `${duplicateKey}:persistent:runtime`,
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-duplicate-stale-second",
            lastUpdatedAt: Date.now(),
          },
        },
      } as AcpSessionStoreEntry,
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey !== duplicateKey) {
        return null;
      }
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
        sessionId: "session-duplicate-row-first",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 1, resolved: 1, failed: 0 });
    expect(hoisted.readAcpSessionEntryMock).toHaveBeenCalledTimes(1);
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(1);
    expect(currentMeta.identity?.state).toBe("resolved");
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-duplicate-fresh");
    expect(currentMeta.identity?.agentSessionId).toBe("agent-duplicate-fresh");
    expect(currentMeta.lastError).toBeUndefined();
  });

  it("uses first-row precedence for duplicate discovery rows when the first row becomes unreadable", async () => {
    const runtimeState = createRuntime();
    const duplicateKey = "agent:codex:acp:duplicate-discovery-first-stale";
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: `${duplicateKey}:persistent:runtime`,
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-duplicate-first-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: duplicateKey,
        storeSessionKey: duplicateKey,
        entry: {
          sessionId: "session-duplicate-first-stale",
          updatedAt: Date.now(),
          acp: currentMeta,
        },
        acp: currentMeta,
      },
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: duplicateKey,
        storeSessionKey: duplicateKey,
        entry: {
          sessionId: "session-duplicate-second-valid",
          updatedAt: Date.now(),
          acp: currentMeta,
        },
        acp: currentMeta,
      },
    ] as AcpSessionStoreEntry[]);
    hoisted.readAcpSessionEntryMock.mockReturnValueOnce(null).mockReturnValueOnce({
      sessionKey: duplicateKey,
      storeSessionKey: duplicateKey,
      acp: currentMeta,
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 1, resolved: 0, failed: 0 });
    expect(hoisted.readAcpSessionEntryMock).toHaveBeenCalledTimes(1);
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
    expect(currentMeta.identity?.state).toBe("pending");
    expect(currentMeta.lastError).toBeUndefined();
  });

  it("recovers on next startup reconcile after duplicate first-row stale read is corrected", async () => {
    const runtimeState = createRuntime();
    const duplicateKey = "agent:codex:acp:duplicate-discovery-first-stale-recovery";
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-duplicate-recovery-fresh",
      agentSessionId: "agent-duplicate-recovery-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: `${duplicateKey}:persistent:runtime`,
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-duplicate-recovery-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    let firstRun = true;
    hoisted.listAcpSessionEntriesMock.mockImplementation(async () => {
      if (firstRun) {
        return [
          {
            cfg: baseCfg,
            storePath: "/tmp/sessions-acp.json",
            sessionKey: duplicateKey,
            storeSessionKey: duplicateKey,
            entry: {
              sessionId: "session-duplicate-recovery-first-stale",
              updatedAt: Date.now(),
              acp: currentMeta,
            },
            acp: currentMeta,
          },
          {
            cfg: baseCfg,
            storePath: "/tmp/sessions-acp.json",
            sessionKey: duplicateKey,
            storeSessionKey: duplicateKey,
            entry: {
              sessionId: "session-duplicate-recovery-second-valid",
              updatedAt: Date.now(),
              acp: currentMeta,
            },
            acp: currentMeta,
          },
        ] as AcpSessionStoreEntry[];
      }
      return [
        {
          cfg: baseCfg,
          storePath: "/tmp/sessions-acp.json",
          sessionKey: duplicateKey,
          storeSessionKey: duplicateKey,
          entry: {
            sessionId: "session-duplicate-recovery-single-valid",
            updatedAt: Date.now(),
            acp: currentMeta,
          },
          acp: currentMeta,
        },
      ] as AcpSessionStoreEntry[];
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey !== duplicateKey) {
        return null;
      }
      if (firstRun) {
        return null;
      }
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
        sessionId: "session-duplicate-recovery-single-valid",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    const first = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(first).toEqual({ checked: 1, resolved: 0, failed: 0 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();

    firstRun = false;
    const second = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(second).toEqual({ checked: 1, resolved: 1, failed: 0 });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(1);
    expect(currentMeta.identity?.state).toBe("resolved");
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-duplicate-recovery-fresh");
    expect(currentMeta.identity?.agentSessionId).toBe("agent-duplicate-recovery-fresh");
    expect(currentMeta.lastError).toBeUndefined();
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
