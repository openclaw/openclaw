/** Accepted backend controls, not stale requests, own subsequent session replay. */
import { describe, expect, it, vi } from "vitest";
import { buildConfiguredAcpSessionKey } from "../persistent-bindings.types.js";
import { createAcceptedFixture } from "./manager.ownership.test-support.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectCalledWith,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  managerFixture,
  mockMutableSession,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager accepted controls", () => {
  installAcpSessionManagerTestLifecycle();

  const sessionKey = "agent:codex:acp:accepted-controls";
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
    const state = createAcceptedFixture({
      sessionKey,
      meta: {
        runtimeOptions: { model: initialModel, ...(thinking ? { thinking } : {}) },
      },
    });
    state.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
      configOptionKeys: ["model", "reasoning_effort"],
    });
    return { ...state, readMeta: () => state.persisted.currentMeta };
  }

  async function runTurn(manager: AcpSessionManager, requestId: string) {
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "continue",
      mode: "prompt",
      requestId,
      provenance: "system",
    });
  }

  it("persists clamped thinking after an explicit model change", async () => {
    const state = setupSession("high", "openai/gpt-5.6-sol");
    state.setConfigOption.mockResolvedValue(acceptedOptions("medium", ["low", "medium", "high"]));
    const result = await state.setOption("model", model);
    const expectedOptions = { model, thinking: "medium" };
    expect(result).toEqual(expectedOptions);
    expect(state.readMeta().runtimeOptions).toEqual(expectedOptions);
    await runTurn(state.manager, "after-selection");
    expect(
      state.setConfigOption.mock.calls.some(
        ([input]) => input.key === "reasoning_effort" && input.value === "high",
      ),
    ).toBe(false);
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
      ...state.target,
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
      ...state.target,
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
    {
      key: "timeout",
      wireKey: "timeout",
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
      continues: true,
    },
    {
      key: "effort",
      wireKey: "reasoning_effort",
      code: "ACP_BACKEND_UNAVAILABLE",
      continues: false,
    },
  ] as const)(
    "preserves $key rejection policy ($code) after model acknowledgement",
    async ({ key, wireKey, code, continues }) => {
      const state = setupSession();
      const value = key === "timeout" ? "30" : "high";
      await state.manager.updateSessionRuntimeOptions({
        ...state.target,
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

describe("AcpSessionManager configured bindings", () => {
  installAcpSessionManagerTestLifecycle();

  it("keeps startup omission but rejects live binding changes before overwriting accepted thinking", async () => {
    const managerModule = await import("./manager.js");
    const { ensureConfiguredAcpBindingSession } =
      await import("../persistent-bindings.lifecycle.js");
    const runtimeState = createRuntime();
    runtimeState.setConfigOption.mockImplementation(async ({ key, value }) => {
      if (value === "off") {
        throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "Live off is unsupported");
      }
      return {
        configOptions: [{ id: "thinking", currentValue: key === "model" ? "medium" : value }],
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const spec = {
      channel: "discord" as const,
      accountId: "default",
      conversationId: "configured-thinking",
      agentId: "codex",
      mode: "persistent" as const,
      thinking: "off",
    };
    const sessionKey = buildConfiguredAcpSessionKey(spec);
    const state: { currentMeta: SessionAcpMeta | undefined } = { currentMeta: undefined };
    mockMutableSession(sessionKey, state);
    hoisted.readAcpSessionEntryMock.mockImplementation(() =>
      state.currentMeta
        ? { sessionKey, storeSessionKey: sessionKey, acp: state.currentMeta }
        : null,
    );
    const manager = new AcpSessionManager();
    const getManager = vi.spyOn(managerModule, "getAcpSessionManager").mockReturnValue(manager);
    const ensure = (thinking?: string) =>
      ensureConfiguredAcpBindingSession({ cfg: baseCfg, spec: { ...spec, thinking } });
    const runTurn = (requestId: string) =>
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: requestId,
        mode: "prompt",
        requestId,
      });
    try {
      expect(await ensure("off")).toEqual({ ok: true, sessionKey });
      await runTurn("first");
      await runTurn("second");
      expect(state.currentMeta?.runtimeOptions?.thinking).toBe("off");

      expect(await ensure("high")).toEqual({ ok: true, sessionKey });
      await runTurn("third");
      const acceptedMeta = state.currentMeta;
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await ensure("off")).toEqual({
          ok: false,
          sessionKey,
          error: "Live off is unsupported",
        });
        expect(state.currentMeta).toEqual(acceptedMeta);
      }
      expect(await ensure()).toEqual({ ok: true, sessionKey });
      await runTurn("fourth");
      expect(state.currentMeta?.runtimeOptions?.thinking).toBe("high");
      expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
      expect(runtimeState.close).not.toHaveBeenCalled();
      expect(runtimeState.runTurn).toHaveBeenCalledTimes(4);
      runtimeState.setConfigOption.mockClear();
      expect(
        await ensureConfiguredAcpBindingSession({
          cfg: baseCfg,
          spec: { ...spec, model: "openai/gpt-5.6-luna", thinking: "high" },
        }),
      ).toEqual({ ok: true, sessionKey });
      expect(
        runtimeState.setConfigOption.mock.calls.map(([input]) => [input.key, input.value]),
      ).toEqual([
        ["model", "openai/gpt-5.6-luna"],
        ["thinking", "high"],
      ]);
      expect(state.currentMeta?.runtimeOptions).toEqual({
        model: "openai/gpt-5.6-luna",
        thinking: "high",
      });
    } finally {
      getManager.mockRestore();
    }
  });
});

describe("AcpSessionManager runtime config validation", () => {
  installAcpSessionManagerTestLifecycle();
  const target = { cfg: baseCfg, sessionKey: "agent:codex:acp:config" };
  const turn = {
    ...target,
    text: "work",
    mode: "prompt" as const,
    provenance: "system" as const,
    requestId: "run",
  };
  function setup(meta: SessionAcpMeta | undefined) {
    const state = { currentMeta: meta };
    const sessionKey = `agent:${meta?.agent ?? "codex"}:acp:config`;
    const fixture = managerFixture(sessionKey);
    mockMutableSession(sessionKey, state);
    return { ...fixture, state };
  }

  it("rejects invalid options before backend controls run", async () => {
    const { manager, runtimeState } = setup(readySessionMeta());
    await expect(
      manager.setSessionConfigOption({ ...target, key: "timeout", value: "not-a-number" }),
    ).rejects.toMatchObject({ code: "ACP_INVALID_RUNTIME_OPTION" });
    expect(runtimeState.setConfigOption).not.toHaveBeenCalled();
    await expect(
      manager.updateSessionRuntimeOptions({ ...target, patch: { cwd: "relative/path" } }),
    ).rejects.toMatchObject({ code: "ACP_INVALID_RUNTIME_OPTION" });
  });

  it.each([
    {
      label: "dropped inherited model",
      options: { model: "google/gemini-3.1-flash-lite", thinking: "low" },
      appliedModel: { kind: "dropped" as const },
      expected: { thinking: "low" },
      controls: [["thinking", "low"]],
    },
    {
      label: "accepted model",
      options: { model: "openai/gpt-5.5" },
      appliedModel: { kind: "applied" as const, model: "openai/gpt-5.5" },
      expected: { model: "openai/gpt-5.5" },
      controls: [["model", "openai/gpt-5.5"]],
    },
  ])(
    "persists and replays only backend-accepted options: $label",
    async ({ options, appliedModel, expected, controls }) => {
      const { manager, runtimeState, state } = setup(undefined);
      runtimeState.ensureSession.mockImplementation(async ({ sessionKey }) => ({
        sessionKey,
        backend: "acpx",
        runtimeSessionName: "runtime",
        appliedModel,
      }));
      await manager.initializeSession({
        ...target,
        agent: "codex",
        mode: "persistent",
        runtimeOptions: options,
      });
      expect(runtimeState.ensureSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: options.model }),
      );
      expect(state.currentMeta?.runtimeOptions).toEqual(expected);
      await manager.runTurn(turn);
      for (const [key, value] of controls) {
        expectCalledWith(runtimeState.setConfigOption, { key, value });
      }
      if (appliedModel.kind === "dropped") {
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
    await manager.runTurn({ ...turn, sessionKey: "agent:claude:acp:config" });
    expect(runtimeState.runTurn).toHaveBeenCalledOnce();
    expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ key: "effort", value: "off" }),
    );
  });
});

describe("AcpSessionManager resetSessionRuntimeOptions", () => {
  installAcpSessionManagerTestLifecycle();

  it("keeps overrides and the retained handle available when reset close fails", async () => {
    const fixture = createAcceptedFixture({
      sessionKey: "agent:codex:acp:reset-options",
      meta: {
        cwd: "/workspace/removed",
        runtimeOptions: { cwd: "/workspace/removed", thinking: "high" },
      },
    });
    await fixture.manager.getSessionStatus(fixture.target);
    fixture.getStatus.mockRejectedValue(new Error("backend status unavailable"));
    fixture.ensureSession.mockRejectedValue(new Error("backend cannot be started"));
    fixture.close.mockRejectedValueOnce(new Error("backend close failed"));

    await expect(fixture.manager.resetSessionRuntimeOptions(fixture.target)).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "backend close failed",
    });

    expect(fixture.persisted.currentMeta.runtimeOptions).toEqual({
      cwd: "/workspace/removed",
      thinking: "high",
    });
    expect(fixture.manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(1);
    await expect(fixture.manager.resetSessionRuntimeOptions(fixture.target)).resolves.toEqual({});
    expect(fixture.ensureSession).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledTimes(2);
    expectCalledWith(fixture.close, { reason: "reset-runtime-options" });
    expect(fixture.persisted.currentMeta.runtimeOptions).toBeUndefined();
    expect(fixture.manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
  });
});
