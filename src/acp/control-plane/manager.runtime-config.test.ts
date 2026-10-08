import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
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
  type AcpRuntime,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager runtime config", () => {
  installAcpSessionManagerTestLifecycle();

  function fixture(overrides: Partial<SessionAcpMeta> = {}) {
    const state = createRuntime();
    const persisted = { currentMeta: readySessionMeta(overrides) };
    const sessionKey = `agent:${persisted.currentMeta.agent}:acp:runtime-config`;
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: state.runtime });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: persisted.currentMeta,
    }));
    installMutableAcpSessionMetaUpsert(persisted);
    const manager = new AcpSessionManager();
    const target = { cfg: baseCfg, sessionKey };
    const run = (requestId = "turn") =>
      manager.runTurn({ ...target, provenance: "system", mode: "prompt", text: "work", requestId });
    return { state, persisted, manager, target, run };
  }

  it("persists selected controls and replays their advertised aliases before the next prompt", async () => {
    const f = fixture({ runtimeOptions: { timeoutSeconds: 120 } });
    f.state.getCapabilities.mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
      configOptionKeys: ["model", "effort", "permission_mode", "timeout_seconds"],
    });
    await expect(
      f.manager.setSessionRuntimeMode({ ...f.target, runtimeMode: "plan" }),
    ).resolves.toMatchObject({ runtimeMode: "plan" });
    expect(f.state.setMode).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan" }));
    for (const [key, value] of [
      ["model", "openai/gpt-5.4"],
      ["effort", "high"],
      ["permission_mode", "strict"],
    ] as const) {
      await f.manager.setSessionConfigOption({ ...f.target, key, value });
    }
    expect(f.persisted.currentMeta.runtimeOptions).toEqual({
      runtimeMode: "plan",
      model: "openai/gpt-5.4",
      thinking: "high",
      permissionProfile: "strict",
      timeoutSeconds: 120,
    });
    expect(f.state.setMode).toHaveBeenCalledOnce();
    f.state.setConfigOption.mockClear();
    await f.run();
    expect(f.state.setMode).toHaveBeenCalledTimes(2);
    expect(f.state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
      ["model", "openai/gpt-5.4"],
      ["effort", "high"],
      ["permission_mode", "strict"],
      ["timeout_seconds", "120"],
    ]);
    expect(f.state.setConfigOption.mock.invocationCallOrder.at(-1)).toBeLessThan(
      expectDefined(f.state.runTurn.mock.invocationCallOrder[0], "runtime prompt call"),
    );
  });

  it("reopens oneshot sessions without resuming stale identity and closes with the final status identity", async () => {
    const f = fixture({
      mode: "oneshot",
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "stale-session",
        lastUpdatedAt: 1,
      },
    });
    f.state.ensureSession.mockResolvedValue({
      sessionKey: f.target.sessionKey,
      backend: "acpx",
      runtimeSessionName: "runtime-oneshot",
      backendSessionId: "ensured-session",
    });
    f.state.getStatus.mockResolvedValue({
      summary: "status=done",
      backendSessionId: "final-session",
      agentSessionId: "final-agent",
      details: { status: "done" },
    });
    await f.run();
    expect(f.state.ensureSession).toHaveBeenCalledOnce();
    expect(f.state.ensureSession.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: f.target.sessionKey,
      agent: "codex",
      mode: "oneshot",
    });
    expect(f.state.ensureSession.mock.calls[0]?.[0].resumeSessionId).toBeUndefined();
    expect(f.state.getStatus).toHaveBeenCalledOnce();
    expect(f.state.close).toHaveBeenCalledWith({
      handle: expect.objectContaining({
        backendSessionId: "final-session",
        agentSessionId: "final-agent",
      }),
      reason: "oneshot-complete",
    });
    expect(f.persisted.currentMeta.identity).toMatchObject({
      state: "resolved",
      acpxSessionId: "final-session",
      agentSessionId: "final-agent",
      source: "status",
    });
  });

  it("persists prompt-learned agent identity when runtime status omits it", async () => {
    const f = fixture({
      agent: "gemini",
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-stale",
        lastUpdatedAt: 1,
      },
    });
    f.state.ensureSession.mockResolvedValue({
      sessionKey: f.target.sessionKey,
      backend: "acpx",
      runtimeSessionName: "runtime-3",
      backendSessionId: "acpx-stale",
    });
    f.state.runTurn.mockImplementation(async function* ({ handle }) {
      handle.agentSessionId = "gemini-session-1";
      yield { type: "done" };
    });
    await f.run();
    expect(f.persisted.currentMeta.identity).toMatchObject({
      state: "resolved",
      agentSessionId: "gemini-session-1",
      acpxSessionId: "acpx-stale",
    });
  });

  it.each([
    {
      key: "timeout",
      options: { timeoutSeconds: 120 },
      code: "ACP_TURN_FAILED",
      message: 'Agent rejected session/set_config_option for "timeout": ACP -32602 Invalid params',
      continues: true,
    },
    {
      key: "timeout",
      options: { timeoutSeconds: 120 },
      code: "ACP_BACKEND_UNAVAILABLE",
      message: "ACP backend unavailable",
      continues: false,
    },
    {
      key: "model",
      options: { model: "opencode/gpt-5.4" },
      code: "ACP_TURN_FAILED",
      message: 'Agent rejected session/set_config_option for "model": ACP -32602 Invalid params',
      continues: false,
    },
  ] as const)(
    "handles $key control failure: $message",
    async ({ key, options, code, message, continues }) => {
      const f = fixture({ agent: "opencode", runtimeOptions: options });
      f.state.setConfigOption.mockImplementation(async (input) => {
        if (input.key === key) {
          throw new AcpRuntimeError(code, message);
        }
      });
      const turn = f.run();
      if (continues) {
        await turn;
        expect(f.state.runTurn).toHaveBeenCalledOnce();
      } else {
        await expect(turn).rejects.toMatchObject({ code });
        expect(f.state.runTurn).not.toHaveBeenCalled();
      }
      expect(f.state.setConfigOption).toHaveBeenCalledWith(
        expect.objectContaining({ key, value: key === "timeout" ? "120" : "opencode/gpt-5.4" }),
      );
    },
  );

  it.each(["next turn", "shutdown"])(
    "closes the retained cwd handle before %s",
    async (operation) => {
      const f = fixture();
      const lifecycle: string[] = [];
      f.state.ensureSession.mockImplementation(async (input) => {
        lifecycle.push(`ensure:${input.cwd ?? "default"}`);
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: `runtime:${input.cwd ?? "default"}`,
          cwd: input.cwd,
        };
      });
      f.state.close.mockImplementation(async ({ handle }) => {
        lifecycle.push(`close:${handle.cwd ?? "default"}`);
      });
      await f.run("first");
      await expect(
        f.manager.updateSessionRuntimeOptions({ ...f.target, patch: { cwd: "/workspace/next" } }),
      ).resolves.toEqual({ cwd: "/workspace/next" });
      expect(f.persisted.currentMeta.runtimeOptions).toEqual({ cwd: "/workspace/next" });
      expect(f.persisted.currentMeta.cwd).toBe("/workspace/next");
      if (operation === "shutdown") {
        await disposeAcpSessionManagerInstance(f.manager, "gateway-shutdown");
        expect(lifecycle).toEqual(["ensure:default", "close:default"]);
      } else {
        await f.run("second");
        expect(f.state.ensureSession).toHaveBeenCalledTimes(2);
        expect(f.state.ensureSession.mock.calls[1]?.[0]).toMatchObject({
          sessionKey: f.target.sessionKey,
          cwd: "/workspace/next",
        });
        expect(lifecycle).toEqual(["ensure:default", "close:default", "ensure:/workspace/next"]);
      }
    },
  );

  it("rejects config controls when the backend has no setter", async () => {
    const f = fixture();
    const runtime: AcpRuntime = {
      ensureSession: f.state.ensureSession,
      runTurn: f.state.runTurn,
      cancel: f.state.cancel,
      close: f.state.close,
      getCapabilities: vi.fn(async () => ({ controls: [] })),
    };
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime });
    await expect(
      f.manager.setSessionConfigOption({ ...f.target, key: "model", value: "gpt-5.4" }),
    ).rejects.toMatchObject({ code: "ACP_BACKEND_UNSUPPORTED_CONTROL" });
  });

  it("omits automatic thinking when the backend advertises no thinking control", async () => {
    const f = fixture({ agent: "opencode", runtimeOptions: { thinking: "high" } });
    f.state.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option"],
      configOptionKeys: ["mode", "model"],
    });
    await f.run();
    expect(f.state.setConfigOption).not.toHaveBeenCalled();
    expect(f.state.runTurn).toHaveBeenCalledOnce();
  });

  it("rejects explicit thinking when the backend advertises no thinking control", async () => {
    const f = fixture({ agent: "opencode" });
    f.state.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option"],
      configOptionKeys: ["mode", "model"],
    });
    await expect(
      f.manager.setSessionConfigOption({ ...f.target, key: "thinking", value: "high" }),
    ).rejects.toMatchObject({ code: "ACP_BACKEND_UNSUPPORTED_CONTROL" });
    expect(f.state.setConfigOption).not.toHaveBeenCalled();
  });

  it("maps thinking through status config options when capabilities omit keys", async () => {
    const f = fixture({ agent: "claude" });
    f.state.getStatus.mockResolvedValue({
      summary: "status=alive",
      details: { configOptions: [{ id: "mode" }, { id: "model" }, { id: "effort" }] },
    });
    await expect(
      f.manager.setSessionConfigOption({ ...f.target, key: "thinking", value: "high" }),
    ).resolves.toEqual({ thinking: "high" });
    expect(f.state.getStatus).toHaveBeenCalled();
    expect(f.state.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ key: "effort", value: "high" }),
    );
  });
});
