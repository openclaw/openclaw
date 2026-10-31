import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { createRuntimeConfigFixture as fixture } from "./manager.ownership.test-support.js";
import {
  AcpRuntimeError,
  expectCalledWith,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  resolvedIdentity,
  runtimeHandle,
  type AcpRuntime,
} from "./manager.test-helpers.js";

describe("AcpSessionManager runtime config", () => {
  installAcpSessionManagerTestLifecycle();

  it("persists selected controls and replays their advertised aliases before the next prompt", async () => {
    const f = fixture({ runtimeOptions: { timeoutSeconds: 120 } });
    f.getCapabilities.mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
      configOptionKeys: ["model", "effort", "permission_mode", "timeout_seconds"],
    });
    await expect(
      f.manager.setSessionRuntimeMode({ ...f.target, runtimeMode: "plan" }),
    ).resolves.toMatchObject({ runtimeMode: "plan" });
    expectCalledWith(f.setMode, { mode: "plan" });
    const controls = { model: "openai/gpt-5.4", effort: "high", permission_mode: "strict" };
    for (const [key, value] of Object.entries(controls)) {
      await f.setOption(key, value);
    }
    expect(f.persisted.currentMeta.runtimeOptions).toEqual({
      runtimeMode: "plan",
      model: "openai/gpt-5.4",
      thinking: "high",
      permissionProfile: "strict",
      timeoutSeconds: 120,
    });
    f.setConfigOption.mockClear();
    await f.run();
    expect(f.setMode).toHaveBeenCalledTimes(2);
    expect(f.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
      ...Object.entries(controls),
      ["timeout_seconds", "120"],
    ]);
    expect(f.setConfigOption.mock.invocationCallOrder.at(-1)).toBeLessThan(
      expectDefined(f.runTurn.mock.invocationCallOrder[0], "runtime prompt call"),
    );
  });

  it("reopens oneshot sessions without resuming stale identity and closes with the final status identity", async () => {
    const f = fixture({
      mode: "oneshot",
      identity: resolvedIdentity({ acpxSessionId: "stale-session" }),
    });
    f.ensureSession.mockResolvedValue(
      runtimeHandle(f.target.sessionKey, "runtime-oneshot", {
        backendSessionId: "ensured-session",
      }),
    );
    const finalIds = { backendSessionId: "final-session", agentSessionId: "final-agent" };
    f.getStatus.mockResolvedValue(finalIds);
    await f.run();
    expect(f.ensureSession.mock.calls[0]?.[0].resumeSessionId).toBeUndefined();
    expect(f.close).toHaveBeenCalledWith({
      handle: expect.objectContaining(finalIds),
      reason: "oneshot-complete",
    });
    expect(f.persisted.currentMeta.identity).toMatchObject({
      state: "resolved",
      acpxSessionId: "final-session",
      agentSessionId: "final-agent",
      source: "status",
    });
  });

  it("continues after an optional timeout control rejection", async () => {
    const f = fixture({ agent: "opencode", runtimeOptions: { timeoutSeconds: 120 } });
    f.setConfigOption.mockImplementation(async (input) => {
      if (input.key === "timeout") {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          'Agent rejected session/set_config_option for "timeout": ACP -32602 Invalid params',
        );
      }
    });
    await f.run();
    expect(f.runTurn).toHaveBeenCalledOnce();
    expectCalledWith(f.setConfigOption, { key: "timeout", value: "120" });
  });

  it("closes the retained cwd handle before the next turn", async () => {
    const f = fixture();
    const cwd = "/workspace/next";
    const lifecycle: string[] = [];
    f.ensureSession.mockImplementation(async (input) => {
      lifecycle.push(`ensure:${input.cwd ?? "default"}`);
      return runtimeHandle(input.sessionKey, `runtime:${input.cwd ?? "default"}`, {
        cwd: input.cwd,
      });
    });
    f.close.mockImplementation(async ({ handle }) => {
      lifecycle.push(`close:${handle.cwd ?? "default"}`);
    });
    await f.run("first");
    await expect(
      f.manager.updateSessionRuntimeOptions({ ...f.target, patch: { cwd } }),
    ).resolves.toEqual({ cwd });
    expect([f.persisted.currentMeta.cwd, f.persisted.currentMeta.runtimeOptions]).toEqual([
      cwd,
      { cwd },
    ]);
    await f.run("second");
    expect(lifecycle).toEqual(["ensure:default", "close:default", "ensure:/workspace/next"]);
  });

  it.each(["missing setter", "unadvertised thinking"])("rejects %s", async (reason) => {
    const f = fixture({ agent: "opencode" });
    if (reason === "missing setter") {
      const { ensureSession, runTurn, cancel, close } = f;
      const getCapabilities = async () => ({ controls: [] });
      const runtime: AcpRuntime = { ensureSession, runTurn, cancel, close, getCapabilities };
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime });
    } else {
      f.getCapabilities.mockResolvedValue({
        controls: ["session/set_config_option"],
        configOptionKeys: ["mode", "model"],
      });
    }
    const key = reason === "missing setter" ? "model" : "thinking";
    await expect(f.setOption(key, "high")).rejects.toMatchObject({
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
    });
    expect(f.setConfigOption).not.toHaveBeenCalled();
  });

  describe("models-only sessions", () => {
    const modelsOnly = {
      controls: [
        "session/set_mode",
        "session/set_model",
        "session/set_config_option",
        "session/status",
      ],
    } satisfies Awaited<ReturnType<NonNullable<AcpRuntime["getCapabilities"]>>>;
    const methodNotFound = () =>
      new AcpRuntimeError(
        "ACP_TURN_FAILED",
        'Failed session/set_config_option for "model": ACP -32601 Method not found',
      );
    const modelsOnlyFixture = (runtimeOptions?: { model?: string; timeoutSeconds?: number }) => {
      const f = fixture({ agent: "auggie", ...(runtimeOptions ? { runtimeOptions } : {}) });
      f.getCapabilities.mockResolvedValue(modelsOnly);
      f.setConfigOption.mockImplementation(async (input) => {
        if (input.key === "model") {
          throw methodNotFound();
        }
      });
      return f;
    };

    it("routes /acp model through session/set_model", async () => {
      const f = modelsOnlyFixture();
      await expect(f.setOption("model", "legacy-model-a")).resolves.toEqual({
        model: "legacy-model-a",
      });
      expectCalledWith(f.setModel, { model: "legacy-model-a" });
      expect(f.setConfigOption).not.toHaveBeenCalled();
      expect(f.persisted.currentMeta.runtimeOptions).toEqual({ model: "legacy-model-a" });
    });

    it("replays a retained model through session/set_model and leaves other controls on config options", async () => {
      const f = modelsOnlyFixture({ model: "legacy-model-a", timeoutSeconds: 120 });
      await f.run();
      expectCalledWith(f.setModel, { model: "legacy-model-a" });
      expect(f.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
        ["timeout", "120"],
      ]);
      expect(f.setModel.mock.invocationCallOrder[0]).toBeLessThan(
        expectDefined(f.runTurn.mock.invocationCallOrder[0], "runtime prompt call"),
      );
    });

    it("keeps an advertised model config option ahead of session/set_model", async () => {
      const f = fixture({ runtimeOptions: { model: "openai/gpt-5.4" } });
      f.getCapabilities.mockResolvedValue({ ...modelsOnly, configOptionKeys: ["model"] });
      await f.setOption("model", "openai/gpt-5.5");
      await f.run();
      expect(f.setModel).not.toHaveBeenCalled();
      expect(f.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
        ["model", "openai/gpt-5.5"],
        ["model", "openai/gpt-5.5"],
      ]);
    });

    it("does not retry a rejected set_model write through set_config_option", async () => {
      const rejected = () =>
        new AcpRuntimeError(
          "ACP_TURN_FAILED",
          'Failed session/set_model for model "unknown": ACP -32602 Invalid params',
        );
      const command = modelsOnlyFixture();
      command.setModel.mockRejectedValue(rejected());
      await expect(command.setOption("model", "unknown")).rejects.toMatchObject({
        code: "ACP_TURN_FAILED",
      });
      expect(command.persisted.currentMeta.runtimeOptions).toBeUndefined();

      const replay = modelsOnlyFixture({ model: "unknown" });
      replay.setModel.mockRejectedValue(rejected());
      await expect(replay.run()).rejects.toThrow(/session\/set_model/);
      for (const f of [command, replay]) {
        expect(f.setConfigOption).not.toHaveBeenCalled();
      }
      expect(replay.runTurn).not.toHaveBeenCalled();
    });
  });

  it("maps thinking through status config options when capabilities omit keys", async () => {
    const f = fixture({ agent: "claude" });
    f.getStatus.mockResolvedValue({ details: { configOptions: [{ id: "effort" }] } });
    await expect(f.setOption("thinking", "high")).resolves.toEqual({ thinking: "high" });
    expectCalledWith(f.setConfigOption, { key: "effort", value: "high" });
  });
});
