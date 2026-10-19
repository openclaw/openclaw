import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  disposeAcpSessionManagerInstance,
  expectCalledWith,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockMutableSession,
  managerFixture,
  readySessionMeta,
  resolvedIdentity,
  runtimeTurn,
  type OpenClawConfig,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";
import type { AcpRunTurnInput, WriteManagerSessionMeta } from "./manager.types.js";

const runtimeHandle = (sessionKey: string, runtimeSessionName: string, backend = "acpx") => ({
  sessionKey,
  runtimeSessionName,
  backend,
});
const backendFailure = () => ({
  status: "failed" as const,
  error: { code: "ACP_TURN_FAILED", message: "backend unavailable" },
});

describe("AcpSessionManager runtime handles", () => {
  installAcpSessionManagerTestLifecycle();

  function fixture(overrides: Partial<SessionAcpMeta> = {}, cfg: OpenClawConfig = baseCfg) {
    const persisted = { currentMeta: readySessionMeta(overrides) };
    const sessionKey = `agent:${persisted.currentMeta.agent}:acp:runtime-handles`;
    const {
      runtimeState: state,
      manager,
      target,
      run: runTurn,
    } = managerFixture(sessionKey, persisted.currentMeta, cfg);
    mockMutableSession(sessionKey, persisted);
    const input = {
      ...target,
      provenance: "system" as const,
      mode: "prompt" as const,
      text: "work",
    };
    const run = (requestId = "turn", config = cfg) =>
      runTurn({ text: "work", cfg: config, requestId });
    return { state, persisted, manager, target, input, run };
  }

  it("reuses idle handles across policy edits but replaces a changed backend owner", async () => {
    const f = fixture();
    const allowlistCfg = {
      ...baseCfg,
      tools: { exec: { mode: "allowlist", safeBins: ["git"] } },
    } satisfies OpenClawConfig;
    const denyCfg = {
      ...baseCfg,
      tools: { exec: { mode: "deny", safeBins: ["node"] } },
    } satisfies OpenClawConfig;
    await f.run("first", allowlistCfg);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    try {
      await f.run("second", denyCfg);
    } finally {
      clock.mockRestore();
    }
    expect(f.state.ensureSession).toHaveBeenCalledOnce();
    expect(f.state.runTurn).toHaveBeenCalledTimes(2);
    expect(f.state.close).not.toHaveBeenCalled();
    expect(f.manager.getObservabilitySnapshot().runtimeCache).toEqual({
      activeSessions: 1,
      idleTtlMs: 0,
      evictedTotal: 0,
    });
    const successor = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: successor.runtime,
    });
    await f.run("third", denyCfg);
    expect(successor.ensureSession).toHaveBeenCalledOnce();
    expect(successor.runTurn).toHaveBeenCalledOnce();
    expectCalledWith(f.state.close, { reason: "runtime-handle-replaced" });
  });

  it("disposes every retained handle and cancels the active turn before its close", async () => {
    const f = fixture();
    const idleSessionKey = "agent:claude:acp:idle";
    const persisted = new Map<string, SessionAcpMeta>();
    hoisted.readAcpSessionEntryMock.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) => ({
        sessionKey,
        storeSessionKey: sessionKey,
        acp: persisted.get(sessionKey) ?? readySessionMeta(),
      }),
    );
    hoisted.upsertAcpSessionMetaMock.mockImplementation(
      async (input: Parameters<WriteManagerSessionMeta>[0]) => {
        const current = persisted.get(input.sessionKey) ?? readySessionMeta();
        const entry = { sessionId: input.sessionKey, updatedAt: 1, acp: current };
        const next = input.mutate(current, entry);
        if (next) {
          persisted.set(input.sessionKey, next);
        }
        return { ...entry, acp: next ?? current };
      },
    );
    const entered = createDeferred();
    const release = createDeferred();
    const lifecycle: string[] = [];
    f.state.runTurn.mockImplementation(async function* ({ handle }) {
      if (handle.sessionKey === f.target.sessionKey) {
        entered.resolve();
        await release.promise;
      }
      yield { type: "done" };
    });
    f.state.cancel.mockImplementation(async ({ handle }) => {
      lifecycle.push(`cancel:${handle.sessionKey}`);
      release.resolve();
    });
    f.state.close.mockImplementation(async ({ handle }) => {
      lifecycle.push(`close:${handle.sessionKey}`);
    });
    await f.manager.runTurn({ ...f.input, sessionKey: idleSessionKey, requestId: "idle" });
    const active = f.run("active");
    const settled = Promise.allSettled([active]);
    try {
      await entered.promise;
      await disposeAcpSessionManagerInstance(f.manager, "gateway-shutdown");
      await settled;
    } finally {
      release.resolve();
      await settled;
    }
    expect(f.state.close).toHaveBeenCalledTimes(2);
    expect(new Set(f.state.close.mock.calls.map(([input]) => input.handle.sessionKey))).toEqual(
      new Set([idleSessionKey, f.target.sessionKey]),
    );
    expect(lifecycle.filter((event) => event.endsWith(f.target.sessionKey))).toEqual([
      `cancel:${f.target.sessionKey}`,
      `close:${f.target.sessionKey}`,
    ]);
    expect(f.manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
  });

  it("closes a dead cached runtime before ensuring its replacement", async () => {
    const f = fixture();
    const lifecycle: string[] = [];
    f.state.ensureSession
      .mockImplementationOnce(async ({ sessionKey }) => {
        lifecycle.push("ensure:old");
        return runtimeHandle(sessionKey, "runtime-old");
      })
      .mockImplementationOnce(async ({ sessionKey }) => {
        lifecycle.push("ensure:new");
        return runtimeHandle(sessionKey, "runtime-new");
      });
    f.state.close.mockImplementation(async ({ handle }) => {
      lifecycle.push(`close:${handle.runtimeSessionName}`);
    });
    f.state.getStatus
      .mockResolvedValueOnce({ summary: "status=alive", details: { status: "alive" } })
      .mockResolvedValueOnce({ summary: "status=dead", details: { status: "dead" } })
      .mockResolvedValueOnce({ summary: "status=alive", details: { status: "alive" } });
    await f.run("first");
    await f.run("second");
    expect(f.state.ensureSession).toHaveBeenCalledTimes(2);
    expect(f.state.getStatus).toHaveBeenCalledTimes(3);
    expect(f.state.runTurn).toHaveBeenCalledTimes(2);
    expect(f.state.close).toHaveBeenCalledOnce();
    expect(f.state.close).toHaveBeenCalledWith({
      handle: expect.objectContaining({ runtimeSessionName: "runtime-old" }),
      reason: "runtime-handle-replaced",
    });
    expect(lifecycle).toEqual(["ensure:old", "close:runtime-old", "ensure:new"]);
  });

  it("re-ensures cached handles when persisted session identity changes", async () => {
    const identity = (generation: number) =>
      resolvedIdentity({
        acpxRecordId: "record-1",
        acpxSessionId: `acpx-session-${generation}`,
        agentSessionId: `agent-session-${generation}`,
      });
    const f = fixture({ runtimeSessionName: "runtime-1", identity: identity(1) });
    for (const generation of [1, 2]) {
      f.state.ensureSession.mockResolvedValueOnce({
        ...runtimeHandle(f.target.sessionKey, `runtime-${generation}`),
        acpxRecordId: "record-1",
        backendSessionId: `acpx-session-${generation}`,
        agentSessionId: `agent-session-${generation}`,
      });
    }
    await f.run("first");
    f.persisted.currentMeta = readySessionMeta({
      runtimeSessionName: "runtime-2",
      identity: identity(2),
    });
    await f.run("second");
    expect(f.state.ensureSession).toHaveBeenCalledTimes(2);
    expect(f.state.runTurn).toHaveBeenCalledTimes(2);
  });

  it("restores persisted identity, cwd and thinking into a new runtime after restart", async () => {
    const f = fixture({
      cwd: "/workspace/stale",
      runtimeOptions: { cwd: "/workspace/project", thinking: "high" },
      identity: resolvedIdentity({ acpxSessionId: "acpx-sid-1" }),
    });
    await f.run();
    expectCalledWith(f.state.ensureSession, {
      sessionKey: f.target.sessionKey,
      agent: "codex",
      resumeSessionId: "acpx-sid-1",
      cwd: "/workspace/project",
      thinking: "high",
    });
    expect(f.state.prepareFreshSession).not.toHaveBeenCalled();
    expect(f.persisted.currentMeta.identity?.acpxSessionId).toBe("acpx-sid-1");
    await expect(f.manager.getSessionStatus(f.target)).resolves.toMatchObject({
      identity: { acpxSessionId: "acpx-sid-1" },
    });
  });

  it("does not resurrect source identity when the destination returns no identifiers", async () => {
    const cfg = {
      acp: { ...baseCfg.acp, backend: "destination-backend" },
    } satisfies OpenClawConfig;
    const f = fixture(
      {
        backend: "source-backend",
        runtimeSessionName: "source-runtime",
        identity: resolvedIdentity({
          acpxRecordId: "source-record",
          acpxSessionId: "source-session",
          agentSessionId: "source-agent-session",
        }),
      },
      cfg,
    );
    f.state.ensureSession.mockImplementation(async ({ sessionKey }) =>
      runtimeHandle(sessionKey, "destination-runtime", "destination-backend"),
    );
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "destination-backend",
      runtime: f.state.runtime,
    });
    await f.run();
    expect(f.state.prepareFreshSession).not.toHaveBeenCalled();
    expect(f.state.ensureSession.mock.calls[0]?.[0].resumeSessionId).toBeUndefined();
    expect(f.state.runTurn.mock.calls[0]?.[0].handle).not.toHaveProperty("agentSessionId");
    expect(f.persisted.currentMeta).toMatchObject({
      backend: "destination-backend",
      runtimeSessionName: "destination-runtime",
    });
    expect(f.persisted.currentMeta.identity).toBeUndefined();
  });

  it.each([
    { agent: "codex", model: "openai/gpt-5.4", supportsModel: true },
    { agent: "opencode", model: "inherited/default", supportsModel: false },
  ])(
    "preserves legacy $agent model state across status and turn restart",
    async ({ agent, model, supportsModel }) => {
      const f = fixture({ agent });
      f.state.ensureSession.mockImplementation(async (input) => {
        if (!supportsModel && input.modelExplicit) {
          throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Backend has no model capability");
        }
        return {
          ...runtimeHandle(input.sessionKey, "legacy-runtime"),
          backendSessionId: "legacy-session",
        };
      });
      if (!supportsModel) {
        f.state.setConfigOption.mockRejectedValue(
          new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "Model replay is unsupported"),
        );
      }
      await f.manager.initializeSession({
        ...f.target,
        agent,
        mode: "persistent",
        runtimeOptions: { model },
        modelExplicit: supportsModel,
      });
      expect(f.persisted.currentMeta.runtimeOptions?.model).toBe(model);
      for (const [index, manager] of [f.manager, new AcpSessionManager()].entries()) {
        await expect(manager.getSessionStatus(f.target)).resolves.toMatchObject({
          runtimeOptions: { model },
        });
        const turn = manager.runTurn({ ...f.input, requestId: `model-replay-${index}` });
        if (supportsModel) {
          await turn;
        } else {
          await expect(turn).rejects.toMatchObject({ code: "ACP_BACKEND_UNSUPPORTED_CONTROL" });
        }
      }
      expect(f.state.runTurn).toHaveBeenCalledTimes(supportsModel ? 2 : 0);
      expect(f.state.setConfigOption).toHaveBeenCalledTimes(2);
      expect(f.state.setConfigOption.mock.calls[1]?.[0]).toMatchObject({
        key: "model",
        value: model,
      });
      expect(f.persisted.currentMeta.runtimeOptions?.model).toBe(model);
    },
  );

  it("prefers the agent resume id then retries fresh without resurrecting stale identifiers", async () => {
    const f = fixture({
      identity: resolvedIdentity({
        acpxSessionId: "acpx-sid-stale",
        agentSessionId: "agent-sid-stale",
      }),
    });
    f.state.ensureSession.mockImplementation(async (input) => {
      if (input.resumeSessionId) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "failed to resume persisted ACP session",
        );
      }
      return {
        ...runtimeHandle(input.sessionKey, "fresh-runtime"),
        backendSessionId: "acpx-sid-fresh",
      };
    });
    f.state.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-sid-fresh",
      details: { status: "alive" },
    });
    await f.run();
    expect(f.state.ensureSession).toHaveBeenCalledTimes(2);
    expect(f.state.ensureSession.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: f.target.sessionKey,
      agent: "codex",
      resumeSessionId: "agent-sid-stale",
    });
    expect(f.state.ensureSession.mock.calls[1]?.[0].resumeSessionId).toBeUndefined();
    expect(f.state.runTurn.mock.calls[0]?.[0].handle.backendSessionId).toBe("acpx-sid-fresh");
    expect(f.state.runTurn.mock.calls[0]?.[0].handle.agentSessionId).toBeUndefined();
    expect(f.persisted.currentMeta.identity?.acpxSessionId).toBe("acpx-sid-fresh");
    expect(f.persisted.currentMeta.identity?.agentSessionId).toBeUndefined();
  });
});

function failoverFixture(primaryUnavailableError?: Error) {
  const sessionKey = "agent:codex:acp:failover";
  const cfg = { acp: { ...baseCfg.acp, backend: "primary", fallbacks: ["fallback"] } };
  const persisted = {
    currentMeta: readySessionMeta({ backend: "primary", runtimeSessionName: "primary-runtime" }),
  };
  const { runtimeState: primary, run } = managerFixture(sessionKey, persisted.currentMeta, cfg);
  const fallback = createRuntime();
  mockMutableSession(sessionKey, persisted);
  const entry = () => ({ acp: persisted.currentMeta, sessionId: "failover", updatedAt: 1 });
  hoisted.upsertAcpSessionMetaMock.mockImplementation(
    async (input: Parameters<WriteManagerSessionMeta>[0]) => {
      persisted.currentMeta = input.mutate(persisted.currentMeta, entry()) ?? persisted.currentMeta;
      return entry();
    },
  );
  for (const [backend, runtime] of [
    ["primary", primary],
    ["fallback", fallback],
  ] as const) {
    runtime.ensureSession.mockImplementation(async () =>
      runtimeHandle(sessionKey, `${backend}-runtime`, backend),
    );
  }
  hoisted.requireAcpRuntimeBackendMock.mockImplementation((backend?: string) => {
    if (backend === "primary" && primaryUnavailableError) {
      throw primaryUnavailableError;
    }
    if (backend !== "primary" && backend !== "fallback") {
      throw new Error(`Unexpected backend ${backend}`);
    }
    return { id: backend, runtime: backend === "primary" ? primary.runtime : fallback.runtime };
  });
  return {
    primary,
    fallback,
    turn(requestId: string, observers: Pick<AcpRunTurnInput, "onEvent" | "onLifecycle"> = {}) {
      return run({ text: requestId, requestId, ...observers });
    },
  };
}

describe("AcpSessionManager backend failover", () => {
  installAcpSessionManagerTestLifecycle();

  it("reports both unavailable backends", async () => {
    const f = failoverFixture(
      new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "primary backend unavailable"),
    );
    f.fallback.ensureSession.mockRejectedValue(
      new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "fallback backend unavailable"),
    );
    const turn = f.turn("unavailable");
    await expect(turn).rejects.toMatchObject({
      code: "ACP_BACKEND_UNAVAILABLE",
      message: expect.stringMatching(/All ACP backends failed \(2\)/),
    });
    expect(f.fallback.runTurn).not.toHaveBeenCalled();
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("primary");
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("fallback");
  });

  it.each(["submitted", "output"] as const)("does not fail over after %s", async (phase) => {
    const f = failoverFixture();
    const events: unknown[] = [];
    const startTurn = vi.fn<NonNullable<typeof f.primary.runtime.startTurn>>((input) =>
      runtimeTurn(input.requestId, {
        promptStarted: Promise.resolve(),
        result: Promise.resolve(backendFailure()),
      }),
    );
    if (phase === "submitted") {
      f.primary.runtime.startTurn = startTurn;
    } else {
      f.primary.runTurn.mockImplementation(async function* () {
        yield { type: "text_delta", text: "partial" };
        throw new AcpRuntimeError("ACP_TURN_FAILED", "backend unavailable");
      });
    }
    await expect(
      f.turn(phase, {
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject(backendFailure().error);
    if (phase === "submitted") {
      expect(startTurn).toHaveBeenCalledOnce();
    } else {
      expect(events).toEqual([expect.objectContaining({ type: "text_delta", text: "partial" })]);
    }
    expect(f.fallback.runTurn).not.toHaveBeenCalled();
  });

  it("fails over only after rejected prompt readiness reaches canonical terminal cleanup", async () => {
    const f = failoverFixture();
    const transitions: string[] = [];
    const promptStarted = Promise.reject(new Error("backend unavailable"));
    promptStarted.catch(() => {});
    f.primary.runtime.startTurn = vi.fn((input) =>
      runtimeTurn(input.requestId, {
        promptStarted,
        result: Promise.resolve().then(() => {
          transitions.push("primary-cleaned-up");
          return backendFailure();
        }),
      }),
    );
    f.fallback.runTurn.mockImplementation(async function* () {
      transitions.push("fallback-started");
      yield { type: "done" };
    });
    const lifecycleEvents: string[] = [];
    await f.turn("unsubmitted", {
      onLifecycle: (event) => {
        lifecycleEvents.push(event.type);
      },
    });
    expect(transitions).toEqual(["primary-cleaned-up", "fallback-started"]);
    expect(lifecycleEvents).toEqual(["prompt_submitted"]);
    expect(f.fallback.runTurn).toHaveBeenCalledOnce();
  });
});
