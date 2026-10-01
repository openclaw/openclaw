/** Accepted backend controls, not stale requests, own subsequent session replay. */
import { describe, expect, it } from "vitest";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

const sessionKey = "agent:codex:acp:accepted-controls";
const model = "openai/gpt-5.6-luna";

function acceptedOptions(thinking?: string, choices = thinking ? [thinking] : [], grouped = false) {
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
  const runtimeState = createRuntime();
  let meta = readySessionMeta({
    runtimeOptions: { model: initialModel, ...(thinking ? { thinking } : {}) },
  });
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
    id: "acpx",
    runtime: runtimeState.runtime,
  });
  hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
    sessionKey,
    storeSessionKey: sessionKey,
    acp: meta,
  }));
  hoisted.upsertAcpSessionMetaMock.mockImplementation(
    async (params: {
      mutate: (
        current: SessionAcpMeta,
        entry: { acp: SessionAcpMeta },
      ) => SessionAcpMeta | null | undefined;
    }) => {
      meta = params.mutate(meta, { acp: meta }) ?? meta;
      return { sessionId: "accepted-controls", updatedAt: Date.now(), acp: meta };
    },
  );
  runtimeState.getCapabilities.mockResolvedValue({
    controls: ["session/set_config_option", "session/status"],
    configOptionKeys: ["model", "reasoning_effort"],
  });
  return { ...runtimeState, readMeta: () => meta, manager: new AcpSessionManager() };
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

describe("AcpSessionManager accepted controls", () => {
  installAcpSessionManagerTestLifecycle();

  it("persists clamped thinking after an explicit model change", async () => {
    const state = setupSession("high", "openai/gpt-5.6-sol");
    state.setConfigOption.mockResolvedValue(acceptedOptions("medium", ["low", "medium", "high"]));
    const result = await state.manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey,
      key: "model",
      value: model,
    });
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

  it("persists the accepted value of an explicit thinking selection", async () => {
    const state = setupSession();
    state.setConfigOption.mockResolvedValue(acceptedOptions("medium", ["low", "medium", "high"]));
    await expect(
      state.manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "thinking",
        value: "high",
      }),
    ).resolves.toEqual({ model, thinking: "medium" });
    expect(state.readMeta().runtimeOptions).toEqual({ model, thinking: "medium" });
  });

  it.each(["medium", undefined])(
    "reconciles automatic model acknowledgement before effort replay: %s",
    async (accepted) => {
      const state = setupSession("high");
      state.setConfigOption.mockResolvedValue(acceptedOptions(accepted));
      const expectedOptions = { model, ...(accepted ? { thinking: accepted } : {}) };
      state.runTurn.mockImplementation(async function* () {
        expect(state.readMeta().runtimeOptions).toEqual(expectedOptions);
        yield { type: "done" };
      });
      await runTurn(state.manager, "first");
      expect(state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
        ["model", model],
        ...(accepted ? [["reasoning_effort", accepted]] : []),
      ]);
      const controlCalls = state.setConfigOption.mock.calls.length;
      await runTurn(state.manager, "cached");
      expect(state.setConfigOption).toHaveBeenCalledTimes(controlCalls);
      await runTurn(new AcpSessionManager(), "reopened");
      expect(state.ensureSession.mock.lastCall?.[0]).toMatchObject(expectedOptions);
      expect(state.ensureSession.mock.lastCall?.[0].thinking).toBe(accepted);
    },
  );

  it.each(["fresh", "updated"])(
    "applies valid pending thinking with a %s handle instead of accepting the old model effort",
    async (lifecycle) => {
      const state = setupSession(lifecycle === "fresh" ? "high" : "low");
      let backendThinking = "low";
      state.setConfigOption.mockImplementation(async ({ key, value }) => {
        if (key === "reasoning_effort") {
          backendThinking = value;
        }
        return acceptedOptions(backendThinking, ["low", "medium", "high"], lifecycle === "updated");
      });
      if (lifecycle === "updated") {
        await runTurn(state.manager, "initial-low");
        await state.manager.updateSessionRuntimeOptions({
          cfg: baseCfg,
          sessionKey,
          patch: { thinking: "high" },
        });
        state.setConfigOption.mockClear();
      }
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
    },
  );

  it("keeps accepted thinking when a later automatic control fails", async () => {
    const state = setupSession("high");
    await state.manager.updateSessionRuntimeOptions({
      cfg: baseCfg,
      sessionKey,
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
      key: "effort",
      wireKey: "reasoning_effort",
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
      continues: true,
    },
    {
      key: "timeout",
      wireKey: "timeout",
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
      continues: true,
    },
    {
      key: "custom_control",
      wireKey: "custom_control",
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
      continues: false,
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
        cfg: baseCfg,
        sessionKey,
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
