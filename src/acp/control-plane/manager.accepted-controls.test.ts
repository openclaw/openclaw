/** Accepted backend controls, not stale requests, own subsequent session replay. */
import type { AcpRuntimeCapabilities } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { buildConfiguredAcpSessionKey } from "../persistent-bindings.types.js";
import { applyManagerRuntimeControls } from "./manager.runtime-controls.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  type AcpRuntime,
  baseCfg,
  createRuntime,
  expectMockCallFields,
  expectNoMockCallFields,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installMutableAcpSessionMetaUpsert,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager accepted controls", () => {
  installAcpSessionManagerTestLifecycle();

  const sessionKey = "agent:codex:acp:accepted-controls";
  const model = "openai/gpt-5.6-luna";
  /** Native model selection plus a separately advertised thinking config key. */
  const nativeModelConfigThinking = {
    controls: ["session/set_config_option", "session/set_model", "session/status"],
    configOptionKeys: ["reasoning_effort"],
  } satisfies AcpRuntimeCapabilities;

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

  function setupSession(thinking?: string, initialModel = model, thinkingExplicit?: boolean) {
    const runtimeState = createRuntime();
    let meta = readySessionMeta({
      runtimeOptions: { model: initialModel, ...(thinking ? { thinking } : {}) },
      ...(thinkingExplicit !== undefined ? { thinkingExplicit } : {}),
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
      cfg: baseCfg,
      sessionKey,
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

  async function applyControls(
    state: ReturnType<typeof setupSession>,
    onModelSelected = vi.fn(),
    onOptionsChanged = vi.fn(async () => {}),
  ) {
    await applyManagerRuntimeControls({
      sessionKey,
      runtime: state.runtime,
      handle: { sessionKey, backend: "acpx", runtimeSessionName: "runtime-1" },
      meta: state.readMeta(),
      getCachedRuntimeState: () => null,
      onOptionsChanged,
      onModelSelected,
    });
    return { onModelSelected, onOptionsChanged };
  }

  it("routes replay and explicit model commands through session/set_model only for model", async () => {
    const state = setupSession();
    const setModel = vi.fn<NonNullable<AcpRuntime["setModel"]>>(async () => {});
    state.runtime.setModel = setModel;
    state.getCapabilities.mockResolvedValue({ controls: ["session/set_model", "session/status"] });
    await runTurn(state.manager, "models-only-replay");
    expect(setModel.mock.calls.map(([input]) => input.model)).toEqual([model]);
    expect(state.setConfigOption).not.toHaveBeenCalled();
    expect(state.runTurn).toHaveBeenCalledOnce();

    const next = "openai/gpt-5.6-sol";
    await expect(
      state.manager.setSessionConfigOption({ cfg: baseCfg, sessionKey, key: "model", value: next }),
    ).resolves.toEqual({ model: next });
    expect(setModel.mock.lastCall?.[0].model).toBe(next);
    await expect(
      state.manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "thinking",
        value: "low",
      }),
    ).rejects.toMatchObject({ code: "ACP_BACKEND_UNSUPPORTED_CONTROL" });
    expect(setModel).toHaveBeenCalledTimes(2);
    expect(state.setConfigOption).not.toHaveBeenCalled();
  });

  it("does not override reported controls with setter presence", async () => {
    const state = setupSession();
    const setModel = vi.fn<NonNullable<AcpRuntime["setModel"]>>(async () => {});
    state.runtime.setModel = setModel;
    state.getCapabilities.mockResolvedValue({ controls: ["session/status"] });
    await expect(
      state.manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "model",
        value: model,
      }),
    ).rejects.toMatchObject({ code: "ACP_BACKEND_UNSUPPORTED_CONTROL" });
    expect(state.setConfigOption).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
  });

  it("infers set_model from the setter only without capability discovery", async () => {
    const state = setupSession();
    const setModel = vi.fn<NonNullable<AcpRuntime["setModel"]>>(async () => {});
    state.runtime.setModel = setModel;
    delete state.runtime.getCapabilities;
    delete state.runtime.setConfigOption;
    await expect(
      state.manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "model",
        value: model,
      }),
    ).resolves.toEqual({ model });
    expect(setModel.mock.calls.map(([input]) => input.model)).toEqual([model]);
  });

  it.each([
    {
      name: "a rejected config model write through set_model",
      capabilities: {
        controls: ["session/set_config_option", "session/set_model", "session/status"],
        configOptionKeys: ["model"],
      },
      rejectConfig: true,
    },
    {
      name: "a rejected set_model write through set_config_option",
      capabilities: { controls: ["session/set_model", "session/status"] },
      rejectConfig: false,
    },
  ] satisfies Array<{ name: string; capabilities: AcpRuntimeCapabilities; rejectConfig: boolean }>)(
    "does not retry $name",
    async ({ capabilities, rejectConfig }) => {
      const state = setupSession();
      const rejection = new AcpRuntimeError("ACP_TURN_FAILED", "Backend rejected the model");
      const setModel = vi.fn<NonNullable<AcpRuntime["setModel"]>>(async () => {
        throw rejection;
      });
      state.runtime.setModel = setModel;
      state.getCapabilities.mockResolvedValue(capabilities);
      state.setConfigOption.mockRejectedValue(rejection);
      await expect(
        state.manager.setSessionConfigOption({
          cfg: baseCfg,
          sessionKey,
          key: "model",
          value: model,
        }),
      ).rejects.toMatchObject({ message: "Backend rejected the model" });
      expect(state.setConfigOption).toHaveBeenCalledTimes(rejectConfig ? 1 : 0);
      expect(setModel).toHaveBeenCalledTimes(rejectConfig ? 0 : 1);
      expect(state.readMeta().runtimeOptions).toEqual({ model });
    },
  );

  it("reconciles the accepted set_model snapshot for an arbitrary model config id", async () => {
    const state = setupSession("high");
    const accepted = {
      configOptions: [
        { id: "model_selector", category: "model", currentValue: "canonical-model" },
        {
          id: "effort",
          category: "thought_level",
          currentValue: "low",
          options: [{ value: "low" }, { value: "medium" }],
        },
      ],
    };
    const setModel = vi.fn<NonNullable<AcpRuntime["setModel"]>>(async () => accepted);
    state.runtime.setModel = setModel;
    state.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/set_model", "session/status"],
      configOptionKeys: ["model_selector", "effort"],
    });
    state.setConfigOption.mockResolvedValue(accepted);
    await runTurn(state.manager, "model-selector");
    expect(setModel.mock.calls.map(([input]) => input.model)).toEqual([model]);
    expect(state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
      ["effort", "low"],
    ]);
    expect(state.readMeta().runtimeOptions).toEqual({ model: "canonical-model", thinking: "low" });
    await runTurn(state.manager, "model-selector-cached");
    expect(setModel).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "removes selected thinking absent", thinking: "high" },
    { name: "adopts no backend default thinking", thinking: undefined },
  ])("set_model complete snapshot $name", async ({ thinking }) => {
    const state = setupSession(thinking);
    const configOptions = [
      { id: "model_selector", category: "model", currentValue: "gpt-5.6-luna" },
      ...(thinking ? [] : [{ id: "effort", category: "thought_level", currentValue: "medium" }]),
    ];
    state.runtime.setModel = vi.fn(async () => ({ configOptions }));
    state.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/set_model", "session/status"],
      configOptionKeys: ["model_selector", "effort"],
    });
    await runTurn(state.manager, "set-model-snapshot");
    expect(state.readMeta().runtimeOptions).toEqual({ model });
    expect(state.setConfigOption).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "keeps the qualified ref for an acknowledged native id",
      acknowledge: (requested: string) => ({ currentModelId: requested.replace("openai/", "") }),
      persisted: (requested: string) => requested,
    },
    {
      name: "persists an unmatched bare model as bare",
      acknowledge: () => ({ currentModelId: "gpt-5.6-mini" }),
      persisted: () => "gpt-5.6-mini",
    },
    {
      name: "persists an accepted qualified substitution",
      acknowledge: () => ({ currentModelId: "openai/gpt-5.6-mini" }),
      persisted: () => "openai/gpt-5.6-mini",
    },
    {
      name: "keeps a void request unverified",
      acknowledge: () => undefined,
      persisted: (requested: string) => requested,
    },
  ])(
    "replay and explicit set_model $name with selected thinking",
    async ({ acknowledge, persisted }) => {
      const state = setupSession("high");
      const setModel = vi.fn<NonNullable<AcpRuntime["setModel"]>>(async ({ model: requested }) =>
        acknowledge(requested),
      );
      state.runtime.setModel = setModel;
      state.getCapabilities.mockResolvedValue(nativeModelConfigThinking);
      await runTurn(state.manager, "alias-replay");
      expect(state.readMeta().runtimeOptions).toEqual({
        model: persisted(model),
        thinking: "high",
      });
      await runTurn(state.manager, "alias-replay-cached");
      expect(setModel).toHaveBeenCalledOnce();

      const next = "openai/gpt-5.6-sol";
      const expected = { model: persisted(next), thinking: "high" };
      await expect(
        state.manager.setSessionConfigOption({
          cfg: baseCfg,
          sessionKey,
          key: "model",
          value: next,
        }),
      ).resolves.toEqual(expected);
      expect(setModel.mock.lastCall?.[0].model).toBe(next);
      expect(state.readMeta().runtimeOptions).toEqual(expected);
      const configWrites = state.setConfigOption.mock.calls.map(([input]) => input);
      expect(configWrites[0]).toMatchObject({ key: "reasoning_effort", value: "high" });
      expect(configWrites.map((input) => input.key)).not.toContain("model");
    },
  );

  it.each([
    {
      name: "an acknowledged native id as the accepted qualified ref",
      returned: { currentModelId: "gpt-5.6-luna" },
      selection: { evidence: "accepted", model },
      persisted: undefined,
    },
    {
      name: "an unmatched bare model as accepted",
      returned: { currentModelId: "gpt-5.6-mini" },
      selection: { evidence: "accepted", model: "gpt-5.6-mini" },
      persisted: { model: "gpt-5.6-mini", thinking: "high" },
    },
    {
      name: "a void setter as requested",
      returned: undefined,
      selection: { evidence: "requested", model },
      persisted: undefined,
    },
  ])(
    "reports $name without clearing selected thinking",
    async ({ returned, selection, persisted }) => {
      const state = setupSession("high");
      state.runtime.setModel = vi.fn(async () => returned);
      state.getCapabilities.mockResolvedValue(nativeModelConfigThinking);
      const { onModelSelected, onOptionsChanged } = await applyControls(state);
      expect(onModelSelected).toHaveBeenCalledExactlyOnceWith(selection);
      expect(onOptionsChanged.mock.calls).toEqual(persisted ? [[persisted]] : []);
      expect(state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
        ["reasoning_effort", "high"],
      ]);
    },
  );

  it.each([
    {
      name: "upgrades a void ACK to the known native id once",
      returned: undefined,
      reported: "gpt-5.6-luna",
      selections: [
        { evidence: "requested", model },
        { evidence: "accepted", model },
      ],
      persisted: undefined,
    },
    {
      name: "skips identical accepted evidence",
      returned: { currentModelId: "gpt-5.6-luna" },
      reported: "gpt-5.6-luna",
      selections: [{ evidence: "accepted", model }],
      persisted: undefined,
    },
    {
      name: "rebinds a changed bare model without qualifying it",
      returned: { currentModelId: "gpt-5.6-luna" },
      reported: "gpt-5.6-mini",
      selections: [
        { evidence: "accepted", model },
        { evidence: "accepted", model: "gpt-5.6-mini" },
      ],
      persisted: { model: "gpt-5.6-mini", thinking: "high" },
    },
    {
      name: "persists a qualified substitution",
      returned: { currentModelId: "gpt-5.6-luna" },
      reported: "openai/gpt-5.6-mini",
      selections: [
        { evidence: "accepted", model },
        { evidence: "accepted", model: "openai/gpt-5.6-mini" },
      ],
      persisted: { model: "openai/gpt-5.6-mini", thinking: "high" },
    },
    {
      name: "keeps the binding for a snapshot without a model option",
      returned: undefined,
      reported: undefined,
      selections: [{ evidence: "requested", model }],
      persisted: undefined,
    },
  ])(
    "thinking snapshot model evidence $name",
    async ({ returned, reported, selections, persisted }) => {
      const state = setupSession("high");
      state.runtime.setModel = vi.fn(async () => returned);
      state.getCapabilities.mockResolvedValue(nativeModelConfigThinking);
      state.setConfigOption.mockResolvedValue({
        configOptions: [
          ...(reported ? [{ id: "model", category: "model", currentValue: reported }] : []),
          { id: "reasoning_effort", category: "thought_level", currentValue: "high" },
        ],
      });
      const { onModelSelected, onOptionsChanged } = await applyControls(state);
      expect(onModelSelected.mock.calls).toEqual(selections.map((selection) => [selection]));
      expect(onOptionsChanged.mock.calls).toEqual(persisted ? [[persisted]] : []);
    },
  );

  it.each([
    {
      name: "the native id as the qualified request",
      currentValue: "gpt-5.6-luna",
      selection: { evidence: "accepted", model },
      persisted: undefined,
    },
    {
      name: "a differing bare id as bare",
      currentValue: "gpt-5.6-mini",
      selection: { evidence: "accepted", model: "gpt-5.6-mini" },
      persisted: { model: "gpt-5.6-mini", thinking: "high" },
    },
  ])(
    "reports a config snapshot with $name and keeps accepted thinking",
    async ({ currentValue, selection, persisted }) => {
      const state = setupSession("high");
      state.setConfigOption.mockResolvedValue({
        configOptions: [
          { id: "model", category: "model", currentValue },
          {
            id: "reasoning_effort",
            category: "thought_level",
            currentValue: "high",
            options: [{ value: "medium" }, { value: "high" }],
          },
        ],
      });
      const { onModelSelected, onOptionsChanged } = await applyControls(state);
      expect(onModelSelected).toHaveBeenCalledExactlyOnceWith(selection);
      expect(state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
        ["model", model],
        ["reasoning_effort", "high"],
      ]);
      expect(onOptionsChanged.mock.calls).toEqual(persisted ? [[persisted]] : []);
    },
  );

  it.each([
    {
      name: "models-only discovery",
      configure: (state: ReturnType<typeof setupSession>) => {
        state.runtime.setModel = vi.fn<NonNullable<AcpRuntime["setModel"]>>(async () => {});
        state.getCapabilities.mockResolvedValue({
          controls: ["session/set_model", "session/status"],
        });
      },
    },
    {
      name: "a rejected thinking config write",
      configure: (state: ReturnType<typeof setupSession>) => {
        state.setConfigOption.mockImplementation(async ({ key }) => {
          if (key === "reasoning_effort") {
            throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "Effort is unsupported");
          }
          return acceptedOptions("low", ["low", "high"]);
        });
      },
    },
  ])("surfaces explicit thinking unsupported by $name before prompting", async ({ configure }) => {
    const state = setupSession("high", model, true);
    configure(state);
    for (const requestId of ["unsupported-thinking", "unsupported-thinking-retry"]) {
      await expect(runTurn(state.manager, requestId)).rejects.toMatchObject({
        code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
      });
    }
    expect(state.runTurn).not.toHaveBeenCalled();
    expect(state.readMeta().runtimeOptions).toEqual({ model, thinking: "high" });
  });

  it.each([
    { name: "the native id as the qualified ref", reported: "gpt-5.6-luna", persisted: model },
    {
      name: "a qualified substitution",
      reported: "openai/gpt-5.6-mini",
      persisted: "openai/gpt-5.6-mini",
    },
    { name: "an unmatched bare id as bare", reported: "gpt-5.6-mini", persisted: "gpt-5.6-mini" },
  ])(
    "persists the accepted value of an explicit thinking selection with $name",
    async ({ reported, persisted }) => {
      const state = setupSession();
      const accepted = acceptedOptions("medium", ["low", "medium", "high"]);
      state.setConfigOption.mockResolvedValue({
        configOptions: accepted.configOptions.map((option) =>
          option.id === "model" ? Object.assign({}, option, { currentValue: reported }) : option,
        ),
      });
      const expected = { model: persisted, thinking: "medium" };
      await expect(
        state.manager.setSessionConfigOption({
          cfg: baseCfg,
          sessionKey,
          key: "thinking",
          value: "high",
        }),
      ).resolves.toEqual(expected);
      expect(state.readMeta().runtimeOptions).toEqual(expected);
    },
  );
});

describe("AcpSessionManager configured bindings", () => {
  installAcpSessionManagerTestLifecycle();

  it("tolerates initial inherited thinking rejection but keeps live reconfiguration strict", async () => {
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
    let currentMeta: SessionAcpMeta | undefined;
    hoisted.readAcpSessionEntryMock.mockImplementation(() =>
      currentMeta ? { sessionKey, storeSessionKey: sessionKey, acp: currentMeta } : null,
    );
    hoisted.upsertAcpSessionMetaMock.mockImplementation(
      ({
        mutate,
      }: {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta },
        ) => SessionAcpMeta | null | undefined;
      }) => {
        currentMeta = mutate(currentMeta, { acp: currentMeta }) ?? currentMeta;
        return { sessionId: "configured-session", updatedAt: Date.now(), acp: currentMeta };
      },
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
      for (const requestId of ["first", "second"]) {
        await runTurn(requestId);
      }
      expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
      expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
      expect(runtimeState.close).not.toHaveBeenCalled();
      expect(currentMeta?.thinkingExplicit).toBeUndefined();
      expect(currentMeta?.runtimeOptions?.thinking).toBe("off");

      expect(await ensure("high")).toEqual({ ok: true, sessionKey });
      await runTurn("third");
      const acceptedMeta = currentMeta;
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await ensure("off")).toEqual({
          ok: false,
          sessionKey,
          error: "Live off is unsupported",
        });
        expect(currentMeta).toEqual(acceptedMeta);
      }
      expect(await ensure()).toEqual({ ok: true, sessionKey });
      await runTurn("fourth");
      expect(currentMeta?.runtimeOptions?.thinking).toBe("high");
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
      expect(currentMeta?.runtimeOptions).toEqual({
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
    const runtimeState = createRuntime();
    const state = { currentMeta: meta };
    const sessionKey = `agent:${meta?.agent ?? "codex"}:acp:config`;
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: state.currentMeta,
    }));
    installMutableAcpSessionMetaUpsert(state);
    return { runtimeState, state, manager: new AcpSessionManager() };
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
        expectMockCallFields(runtimeState.setConfigOption, { key, value });
      }
      if (appliedModel.kind === "dropped") {
        expectNoMockCallFields(runtimeState.setConfigOption, { key: "model" });
      }
      expect(runtimeState.runTurn).toHaveBeenCalledOnce();
    },
  );

  function setupEffortRejection(thinkingExplicit: boolean | undefined, details: string) {
    const fixture = setup(
      readySessionMeta({
        agent: "claude",
        runtimeOptions: { thinking: "off" },
        ...(thinkingExplicit === undefined ? {} : { thinkingExplicit }),
      }),
    );
    fixture.runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
      configOptionKeys: ["mode", "model", "effort"],
    });
    fixture.runtimeState.setConfigOption.mockImplementation(async ({ key }) => {
      if (key === "effort") {
        throw Object.assign(new Error("Internal error"), {
          name: "RequestError",
          code: -32603,
          data: { details },
        });
      }
    });
    return fixture;
  }

  it("fails before prompting when persisted explicit thinking is rejected", async () => {
    const { manager, runtimeState } = setupEffortRejection(
      true,
      "Invalid value for config option effort: off",
    );
    await expect(
      manager.runTurn({ ...turn, sessionKey: "agent:claude:acp:config" }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: expect.stringContaining("Invalid value for config option effort: off"),
    });
    expect(runtimeState.runTurn).not.toHaveBeenCalled();
    expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ key: "effort", value: "off" }),
    );
  });

  it.each([{ thinkingExplicit: true }, { thinkingExplicit: undefined }])(
    "fails selected thinking transport rejection before prompting: explicit=$thinkingExplicit",
    async ({ thinkingExplicit }) => {
      const { manager, runtimeState } = setupEffortRejection(
        thinkingExplicit,
        "unsupported transport protocol",
      );
      await expect(
        manager.runTurn({ ...turn, sessionKey: "agent:claude:acp:config" }),
      ).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
      expect(runtimeState.runTurn).not.toHaveBeenCalled();
      expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
        expect.objectContaining({ key: "effort", value: "off" }),
      );
    },
  );

  it("continues past a legacy thinking config-option rejection without recorded provenance", async () => {
    const { manager, runtimeState, state } = setupEffortRejection(
      undefined,
      "Invalid value for config option effort: off",
    );
    await manager.runTurn({ ...turn, sessionKey: "agent:claude:acp:config" });
    expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ key: "effort", value: "off" }),
    );
    expect(runtimeState.runTurn).toHaveBeenCalledOnce();
    expect(state.currentMeta?.runtimeOptions).toEqual({ thinking: "off" });
    expect(state.currentMeta?.thinkingExplicit).toBeUndefined();
  });
});

describe("AcpSessionManager resetSessionRuntimeOptions", () => {
  installAcpSessionManagerTestLifecycle();

  function setupReset() {
    const runtimeState = createRuntime();
    const sessionKey = "agent:codex:acp:reset-options";
    let meta = readySessionMeta({
      cwd: "/workspace/removed",
      runtimeOptions: { cwd: "/workspace/removed", thinking: "high" },
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
        return { sessionId: "reset-options", updatedAt: Date.now(), acp: meta };
      },
    );
    return {
      runtimeState,
      manager: new AcpSessionManager(),
      target: { cfg: baseCfg, sessionKey },
      get meta() {
        return meta;
      },
    };
  }

  it("keeps overrides and the retained handle available when reset close fails", async () => {
    const fixture = setupReset();
    await fixture.manager.getSessionStatus(fixture.target);
    fixture.runtimeState.getStatus.mockRejectedValue(new Error("backend status unavailable"));
    fixture.runtimeState.ensureSession.mockRejectedValue(new Error("backend cannot be started"));
    fixture.runtimeState.close.mockRejectedValueOnce(new Error("backend close failed"));

    await expect(fixture.manager.resetSessionRuntimeOptions(fixture.target)).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "backend close failed",
    });

    expect(fixture.meta.runtimeOptions).toEqual({ cwd: "/workspace/removed", thinking: "high" });
    expect(fixture.manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(1);
    await expect(fixture.manager.resetSessionRuntimeOptions(fixture.target)).resolves.toEqual({});
    expect(fixture.runtimeState.ensureSession).toHaveBeenCalledOnce();
    expect(fixture.runtimeState.close).toHaveBeenCalledTimes(2);
    expectMockCallFields(fixture.runtimeState.close, { reason: "reset-runtime-options" });
    expect(fixture.meta.runtimeOptions).toBeUndefined();
    expect(fixture.manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
  });
});
