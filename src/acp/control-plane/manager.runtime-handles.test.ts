import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  disposeAcpSessionManagerInstance,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installMutableAcpSessionMetaUpsert,
  readySessionMeta,
  type OpenClawConfig,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager runtime handles", () => {
  installAcpSessionManagerTestLifecycle();

  function fixture(overrides: Partial<SessionAcpMeta> = {}, cfg: OpenClawConfig = baseCfg) {
    const state = createRuntime();
    const persisted = { currentMeta: readySessionMeta(overrides) };
    const sessionKey = `agent:${persisted.currentMeta.agent}:acp:runtime-handles`;
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: state.runtime });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: persisted.currentMeta,
    }));
    installMutableAcpSessionMetaUpsert(persisted);
    const manager = new AcpSessionManager();
    const target = { cfg, sessionKey };
    const input = {
      ...target,
      provenance: "system" as const,
      mode: "prompt" as const,
      text: "work",
    };
    const run = (requestId = "turn", config = cfg) =>
      manager.runTurn({ ...input, cfg: config, requestId });
    return { state, persisted, manager, target, input, run };
  }

  function sourceMeta(): Partial<SessionAcpMeta> {
    return {
      backend: "source-backend",
      runtimeSessionName: "source-runtime",
      identity: {
        state: "resolved",
        source: "status",
        acpxRecordId: "source-record",
        acpxSessionId: "source-session",
        agentSessionId: "source-agent-session",
        lastUpdatedAt: 1,
      },
    };
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
    expect(f.state.close).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "runtime-handle-replaced" }),
    );
  });

  it("disposes every retained handle and cancels the active turn before its close", async () => {
    const f = fixture();
    const idleSessionKey = "agent:claude:acp:idle";
    hoisted.readAcpSessionEntryMock.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) => ({
        sessionKey,
        storeSessionKey: sessionKey,
        acp: readySessionMeta(),
      }),
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
        return { sessionKey, backend: "acpx", runtimeSessionName: "runtime-old" };
      })
      .mockImplementationOnce(async ({ sessionKey }) => {
        lifecycle.push("ensure:new");
        return { sessionKey, backend: "acpx", runtimeSessionName: "runtime-new" };
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
    const identity = (generation: number): SessionAcpMeta["identity"] => ({
      state: "resolved",
      acpxRecordId: "record-1",
      acpxSessionId: `acpx-session-${generation}`,
      agentSessionId: `agent-session-${generation}`,
      source: "status",
      lastUpdatedAt: 1,
    });
    const f = fixture({ runtimeSessionName: "runtime-1", identity: identity(1) });
    for (const generation of [1, 2]) {
      f.state.ensureSession.mockResolvedValueOnce({
        sessionKey: f.target.sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime-${generation}`,
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
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-1",
        lastUpdatedAt: 1,
      },
    });
    await f.run();
    expect(f.state.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: f.target.sessionKey,
        agent: "codex",
        resumeSessionId: "acpx-sid-1",
        cwd: "/workspace/project",
        thinking: "high",
      }),
    );
    expect(f.state.prepareFreshSession).not.toHaveBeenCalled();
    expect(f.persisted.currentMeta.identity?.acpxSessionId).toBe("acpx-sid-1");
    await expect(f.manager.getSessionStatus(f.target)).resolves.toMatchObject({
      identity: { acpxSessionId: "acpx-sid-1" },
    });
  });

  it("recovers a destination-owned named session during failover without carrying source identity", async () => {
    const cfg = {
      acp: { ...baseCfg.acp, backend: "source-backend", fallbacks: ["destination-backend"] },
    } satisfies OpenClawConfig;
    const f = fixture(sourceMeta(), cfg);
    f.state.ensureSession.mockImplementation(async ({ sessionKey }) => ({
      sessionKey,
      backend: "destination-backend",
      runtimeSessionName: "destination-runtime",
      acpxRecordId: "destination-record",
      backendSessionId: "destination-session",
    }));
    hoisted.requireAcpRuntimeBackendMock.mockImplementation((backendId?: string) => {
      if (backendId === "source-backend") {
        throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "primary backend unavailable");
      }
      if (backendId === "destination-backend") {
        return { id: backendId, runtime: f.state.runtime };
      }
      throw new Error(`unexpected backend ${backendId}`);
    });
    await f.run();
    expect(f.state.prepareFreshSession).not.toHaveBeenCalled();
    expect(f.state.ensureSession.mock.calls[0]?.[0].resumeSessionId).toBeUndefined();
    expect(f.state.runTurn.mock.calls[0]?.[0].handle).toMatchObject({
      acpxRecordId: "destination-record",
      backendSessionId: "destination-session",
    });
    expect(f.state.runTurn.mock.calls[0]?.[0].handle).not.toHaveProperty("agentSessionId");
    expect(f.persisted.currentMeta).toMatchObject({
      backend: "destination-backend",
      runtimeSessionName: "destination-runtime",
      identity: { acpxRecordId: "destination-record", acpxSessionId: "destination-session" },
    });
    expect(f.persisted.currentMeta.identity).not.toHaveProperty("agentSessionId");
  });

  it("does not resurrect source identity when the destination returns no identifiers", async () => {
    const cfg = {
      acp: { ...baseCfg.acp, backend: "destination-backend" },
    } satisfies OpenClawConfig;
    const f = fixture(sourceMeta(), cfg);
    f.state.ensureSession.mockImplementation(async ({ sessionKey }) => ({
      sessionKey,
      backend: "destination-backend",
      runtimeSessionName: "destination-runtime",
    }));
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

  it("preserves the source owner and identity when destination initialization fails", async () => {
    const cfg = {
      acp: { ...baseCfg.acp, backend: "destination-backend" },
    } satisfies OpenClawConfig;
    const f = fixture(sourceMeta(), cfg);
    const sourceIdentity = f.persisted.currentMeta.identity;
    const source = {
      backend: "source-backend",
      runtimeSessionName: "source-runtime",
      identity: sourceIdentity,
    };
    f.state.ensureSession.mockImplementation(async () => {
      expect(f.persisted.currentMeta).toMatchObject(source);
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "destination unavailable");
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "destination-backend",
      runtime: f.state.runtime,
    });
    await expect(f.run()).rejects.toMatchObject({ code: "ACP_SESSION_INIT_FAILED" });
    expect(f.state.prepareFreshSession).not.toHaveBeenCalled();
    expect(f.state.ensureSession.mock.calls[0]?.[0].resumeSessionId).toBeUndefined();
    expect(f.persisted.currentMeta).toMatchObject(source);
    expect(f.persisted.currentMeta.identity).toEqual(sourceIdentity);
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
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: "legacy-runtime",
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
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-stale",
        agentSessionId: "agent-sid-stale",
        lastUpdatedAt: 1,
      },
    });
    f.state.ensureSession.mockImplementation(async (input) => {
      if (input.resumeSessionId) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "failed to resume persisted ACP session",
        );
      }
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: "fresh-runtime",
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
    expect(f.state.runTurn.mock.calls[0]?.[0].handle).toMatchObject({
      backendSessionId: "acpx-sid-fresh",
    });
    expect(f.state.runTurn.mock.calls[0]?.[0].handle.agentSessionId).toBeUndefined();
    expect(f.persisted.currentMeta.identity?.acpxSessionId).toBe("acpx-sid-fresh");
    expect(f.persisted.currentMeta.identity?.agentSessionId).toBeUndefined();
  });
});
