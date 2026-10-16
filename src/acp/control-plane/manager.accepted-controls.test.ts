import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { buildConfiguredAcpSessionKey } from "../persistent-bindings.types.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  expectCalledWith,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockMutableSession,
  managerFixture,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

installAcpSessionManagerTestLifecycle();

function setup(meta: SessionAcpMeta | undefined, sessionKey: string) {
  const f = managerFixture(sessionKey);
  const state: { currentMeta: SessionAcpMeta | undefined } = { currentMeta: meta };
  mockMutableSession(sessionKey, state);
  return {
    ...f,
    ...f.runtimeState,
    state,
    readMeta: () => expectDefined(state.currentMeta, "session metadata"),
  };
}

async function runTurn(
  manager: AcpSessionManager,
  requestId: string,
  sessionKey = "agent:codex:acp:accepted-controls",
  text = "continue",
) {
  await manager.runTurn({
    cfg: baseCfg,
    sessionKey,
    text,
    mode: "prompt",
    requestId,
    provenance: "system",
  });
}

describe("AcpSessionManager accepted controls", () => {
  const sessionKey = "agent:codex:acp:accepted-controls";
  const target = { cfg: baseCfg, sessionKey };
  const model = "openai/gpt-5.6-luna";

  function acceptedOptions(
    thinking?: string,
    choices = thinking ? [thinking] : [],
    grouped = false,
  ) {
    const options = choices.map((value) => ({ value, name: value }));
    return {
      configOptions: [
        { id: "model", category: "model", currentValue: "gpt-5.6-luna" },
        ...(thinking
          ? [
              {
                id: "reasoning_effort",
                category: "thought_level",
                currentValue: thinking,
                options: grouped ? [{ group: "effort", name: "Effort", options }] : options,
              },
            ]
          : []),
        { id: "approval_policy", currentValue: "default" },
      ],
    };
  }

  function setupSession(thinking?: string, initialModel = model) {
    const state = setup(
      readySessionMeta({
        runtimeOptions: { model: initialModel, ...(thinking ? { thinking } : {}) },
      }),
      sessionKey,
    );
    state.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
      configOptionKeys: ["model", "reasoning_effort"],
    });
    return state;
  }

  it("persists clamped thinking after an explicit model change", async () => {
    const state = setupSession("high", "openai/gpt-5.6-sol");
    state.setConfigOption.mockResolvedValue(acceptedOptions("medium", ["low", "medium", "high"]));
    const result = await state.manager.setSessionConfigOption({
      ...target,
      key: "model",
      value: model,
    });
    const expectedOptions = { model, thinking: "medium" };
    expect(result).toEqual(expectedOptions);
    expect(state.readMeta().runtimeOptions).toEqual(expectedOptions);
    await runTurn(state.manager, "after-selection");
    expect(state.setConfigOption).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "reasoning_effort", value: "high" }),
    );
  });

  it("removes unsupported thinking before automatic effort replay", async () => {
    const state = setupSession("high");
    state.setConfigOption.mockResolvedValue(acceptedOptions());
    const expectedOptions = { model };
    state.runTurn.mockImplementation(async function* () {
      expect(state.readMeta().runtimeOptions).toEqual(expectedOptions);
      yield { type: "done" };
    });
    await runTurn(state.manager, "first");
    expect(state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
      ["model", model],
    ]);
    const controlCalls = state.setConfigOption.mock.calls.length;
    await runTurn(state.manager, "cached");
    expect(state.setConfigOption).toHaveBeenCalledTimes(controlCalls);
    await runTurn(new AcpSessionManager(), "reopened");
    expect(state.ensureSession.mock.lastCall?.[0]).toMatchObject(expectedOptions);
    expect(state.ensureSession.mock.lastCall?.[0].thinking).toBeUndefined();
  });

  it("applies updated pending thinking instead of accepting the old model effort", async () => {
    const state = setupSession("low");
    let backendThinking = "low";
    state.setConfigOption.mockImplementation(async ({ key, value }) => {
      if (key === "reasoning_effort") {
        backendThinking = value;
      }
      return acceptedOptions(backendThinking, ["low", "medium", "high"], true);
    });
    await runTurn(state.manager, "initial-low");
    await state.manager.updateSessionRuntimeOptions({
      ...target,
      patch: { thinking: "high" },
    });
    state.setConfigOption.mockClear();
    await runTurn(state.manager, "pending-high");
    expect(backendThinking).toBe("high");
    expect(state.readMeta().runtimeOptions).toEqual({ model, thinking: "high" });
    expect(state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
      ["model", model],
      ["reasoning_effort", "high"],
    ]);
    await runTurn(state.manager, "cached-high");
    expect(state.setConfigOption).toHaveBeenCalledTimes(2);
    backendThinking = "low";
    await runTurn(new AcpSessionManager(), "reopened-high");
    expect(backendThinking).toBe("high");
  });

  it("keeps accepted thinking when a later automatic control fails", async () => {
    const state = setupSession("high");
    await state.manager.updateSessionRuntimeOptions({
      ...target,
      patch: { permissionProfile: "strict" },
    });
    state.getCapabilities.mockResolvedValue({ controls: ["session/set_config_option"] });
    state.setConfigOption.mockImplementation(async ({ key }) => {
      if (key === "approval_policy") {
        throw new Error("control transport disconnected");
      }
      return acceptedOptions("medium");
    });
    await expect(runTurn(state.manager, "partial-controls")).rejects.toThrow(
      "control transport disconnected",
    );
    expect(state.readMeta().runtimeOptions).toEqual({
      model,
      thinking: "medium",
      permissionProfile: "strict",
    });
    expect(state.runTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout", "timeout", "ACP_BACKEND_UNSUPPORTED_CONTROL", true],
    ["effort", "reasoning_effort", "ACP_BACKEND_UNAVAILABLE", false],
  ] as const)(
    "preserves %s rejection policy after model acknowledgement",
    async (key, wireKey, code, continues) => {
      const state = setupSession();
      const value = key === "timeout" ? "30" : "high";
      await state.manager.updateSessionRuntimeOptions({
        ...target,
        patch: { backendExtras: { [key]: value } },
      });
      state.getCapabilities.mockResolvedValue({
        controls: ["session/set_config_option"],
        configOptionKeys: ["model", wireKey],
      });
      state.setConfigOption.mockImplementation(async ({ key: controlKey }) => {
        if (controlKey === wireKey) {
          throw new AcpRuntimeError(code, "Backend control rejected");
        }
        return acceptedOptions();
      });
      const turn = runTurn(state.manager, "removed-backend-extra");
      if (continues) {
        await expect(turn).resolves.toBeUndefined();
        expect(state.runTurn).toHaveBeenCalledOnce();
      } else {
        await expect(turn).rejects.toMatchObject({ code });
        expect(state.runTurn).not.toHaveBeenCalled();
      }
      expect(state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
        ["model", model],
        [wireKey, value],
      ]);
    },
  );
});

it("keeps startup omission but rejects live binding changes before overwriting accepted thinking", async () => {
  const managerModule = await import("./manager.js");
  const { ensureConfiguredAcpBindingSession } = await import("../persistent-bindings.lifecycle.js");
  const spec = {
    channel: "discord" as const,
    accountId: "default",
    conversationId: "configured-thinking",
    agentId: "codex",
    mode: "persistent" as const,
    thinking: "off",
  };
  const sessionKey = buildConfiguredAcpSessionKey(spec);
  const { runtimeState, manager, readMeta } = setup<SessionAcpMeta | undefined>(
    undefined,
    sessionKey,
  );
  hoisted.readAcpSessionEntryMock.mockImplementation(() =>
    readMeta() ? { sessionKey, storeSessionKey: sessionKey, acp: readMeta() } : null,
  );
  runtimeState.setConfigOption.mockImplementation(async ({ key, value }) => {
    if (value === "off") {
      throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "Live off is unsupported");
    }
    return {
      configOptions: [{ id: "thinking", currentValue: key === "model" ? "medium" : value }],
    };
  });
  const getManager = vi.spyOn(managerModule, "getAcpSessionManager").mockReturnValue(manager);
  const ensure = (thinking?: string, model?: string) =>
    ensureConfiguredAcpBindingSession({ cfg: baseCfg, spec: { ...spec, thinking, model } });
  const run = (requestId: string) => runTurn(manager, requestId, sessionKey, requestId);
  try {
    expect(await ensure("off")).toEqual({ ok: true, sessionKey });
    await run("first");
    await run("second");
    expect(readMeta()?.runtimeOptions?.thinking).toBe("off");

    expect(await ensure("high")).toEqual({ ok: true, sessionKey });
    await run("third");
    const acceptedMeta = readMeta();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await ensure("off")).toEqual({
        ok: false,
        sessionKey,
        error: "Live off is unsupported",
      });
      expect(readMeta()).toEqual(acceptedMeta);
    }
    expect(await ensure()).toEqual({ ok: true, sessionKey });
    await run("fourth");
    expect(readMeta()?.runtimeOptions?.thinking).toBe("high");
    expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
    expect(runtimeState.close).not.toHaveBeenCalled();
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(4);
    runtimeState.setConfigOption.mockClear();
    expect(await ensure("high", "openai/gpt-5.6-luna")).toEqual({ ok: true, sessionKey });
    expect(
      runtimeState.setConfigOption.mock.calls.map(([input]) => [input.key, input.value]),
    ).toEqual([
      ["model", "openai/gpt-5.6-luna"],
      ["thinking", "high"],
    ]);
    expect(readMeta()?.runtimeOptions).toEqual({
      model: "openai/gpt-5.6-luna",
      thinking: "high",
    });
  } finally {
    getManager.mockRestore();
  }
});
describe("AcpSessionManager runtime config validation", () => {
  const target = { cfg: baseCfg, sessionKey: "agent:codex:acp:config" };
  it("rejects invalid options before backend controls run", async () => {
    const { manager, runtimeState } = setup(readySessionMeta(), target.sessionKey);
    await expect(
      manager.setSessionConfigOption({ ...target, key: "timeout", value: "not-a-number" }),
    ).rejects.toMatchObject({ code: "ACP_INVALID_RUNTIME_OPTION" });
    expect(runtimeState.setConfigOption).not.toHaveBeenCalled();
    await expect(
      manager.updateSessionRuntimeOptions({ ...target, patch: { cwd: "relative/path" } }),
    ).rejects.toMatchObject({ code: "ACP_INVALID_RUNTIME_OPTION" });
  });

  it.each([
    ["dropped inherited model", "google/gemini-3.1-flash-lite", true],
    ["accepted model", "openai/gpt-5.5", false],
  ] as const)(
    "persists and replays only backend-accepted options: %s",
    async (_label, model, dropped) => {
      const expected = dropped ? { thinking: "low" } : { model };
      const { manager, runtimeState, state } = setup(undefined, target.sessionKey);
      runtimeState.ensureSession.mockImplementation(async ({ sessionKey }) => ({
        sessionKey,
        backend: "acpx",
        runtimeSessionName: "runtime",
        appliedModel: dropped ? { kind: "dropped" } : { kind: "applied", model },
      }));
      await manager.initializeSession({
        ...target,
        agent: "codex",
        mode: "persistent",
        runtimeOptions: { model, ...(dropped ? { thinking: "low" } : {}) },
      });
      expectCalledWith(runtimeState.ensureSession, { model });
      expect(state.currentMeta?.runtimeOptions).toEqual(expected);
      await runTurn(manager, "run", target.sessionKey, "work");
      for (const [key, value] of Object.entries(expected)) {
        expectCalledWith(runtimeState.setConfigOption, { key, value });
      }
      if (dropped) {
        expect(runtimeState.setConfigOption).not.toHaveBeenCalledWith(
          expect.objectContaining({ key: "model" }),
        );
      }
      expect(runtimeState.runTurn).toHaveBeenCalledOnce();
    },
  );

  it("continues after an optional thinking rejection", async () => {
    const { manager, runtimeState } = setup(
      readySessionMeta({ agent: "claude", runtimeOptions: { thinking: "off" } }),
      "agent:claude:acp:config",
    );
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
      configOptionKeys: ["mode", "model", "effort"],
    });
    runtimeState.setConfigOption.mockImplementation(async ({ key }) => {
      if (key === "effort") {
        throw Object.assign(new Error("Internal error"), {
          name: "RequestError",
          code: -32603,
          data: { details: "Invalid value for config option effort: off" },
        });
      }
    });
    await runTurn(manager, "run", "agent:claude:acp:config", "work");
    expect(runtimeState.runTurn).toHaveBeenCalledOnce();
    expectCalledWith(runtimeState.setConfigOption, { key: "effort", value: "off" });
  });
});

it("keeps overrides and the retained handle available when reset close fails", async () => {
  const sessionKey = "agent:codex:acp:reset-options";
  const runtimeOptions = { cwd: "/workspace/removed", thinking: "high" };
  const { runtimeState, manager, target, state } = setup(
    readySessionMeta({ cwd: runtimeOptions.cwd, runtimeOptions }),
    sessionKey,
  );
  await manager.getSessionStatus(target);
  runtimeState.getStatus.mockRejectedValue(new Error("backend status unavailable"));
  runtimeState.ensureSession.mockRejectedValue(new Error("backend cannot be started"));
  runtimeState.close.mockRejectedValueOnce(new Error("backend close failed"));

  await expect(manager.resetSessionRuntimeOptions(target)).rejects.toMatchObject({
    code: "ACP_TURN_FAILED",
    message: "backend close failed",
  });

  expect(state.currentMeta.runtimeOptions).toEqual({ cwd: "/workspace/removed", thinking: "high" });
  expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(1);
  await expect(manager.resetSessionRuntimeOptions(target)).resolves.toEqual({});
  expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
  expect(runtimeState.close).toHaveBeenCalledTimes(2);
  expectCalledWith(runtimeState.close, { reason: "reset-runtime-options" });
  expect(state.currentMeta.runtimeOptions).toBeUndefined();
  expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
});
