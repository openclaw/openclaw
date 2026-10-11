import { describe, expect, it } from "vitest";
import {
  AcpRuntimeError,
  AcpSessionManager,
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

  it.each([
    { details: "Invalid value for config option effort: off", rejectedOption: true },
    { details: "unsupported transport protocol", rejectedOption: false },
  ])(
    "distinguishes optional thinking rejection from runtime failure: $details",
    async ({ details, rejectedOption }) => {
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
            data: { details },
          });
        }
      });
      const result = manager.runTurn({ ...turn, sessionKey: "agent:claude:acp:config" });
      if (rejectedOption) {
        await result;
        expect(runtimeState.runTurn).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
        expect(runtimeState.runTurn).not.toHaveBeenCalled();
      }
      expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
        expect.objectContaining({ key: "effort", value: "off" }),
      );
    },
  );

  it.each([
    { label: "explicit command", tolerateRejectedThinking: false },
    { label: "automatic reconciliation", tolerateRejectedThinking: true },
  ])(
    "keeps the accepted thinking level when the adapter rejects an inherited one: $label",
    async ({ tolerateRejectedThinking }) => {
      const sessionKey = "agent:claude:acp:config";
      const { manager, runtimeState, state } = setup(
        readySessionMeta({ agent: "claude", runtimeOptions: { thinking: "high" } }),
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
            data: { details: "Invalid value for config option effort: adaptive" },
          });
        }
      });

      const applied = manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "thinking",
        value: "adaptive",
        ...(tolerateRejectedThinking ? { tolerateRejectedThinking: true } : {}),
      });
      if (tolerateRejectedThinking) {
        await expect(applied).resolves.toEqual({ thinking: "high" });
      } else {
        await expect(applied).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
      }
      expect(runtimeState.setConfigOption).toHaveBeenCalledWith(
        expect.objectContaining({ key: "effort", value: "adaptive" }),
      );
      expect(state.currentMeta?.runtimeOptions).toEqual({ thinking: "high" });
    },
  );

  it("still surfaces a thinking control the adapter cannot take at all", async () => {
    const sessionKey = "agent:claude:acp:config";
    const { manager, runtimeState, state } = setup(
      readySessionMeta({ agent: "claude", runtimeOptions: { thinking: "high" } }),
    );
    runtimeState.setConfigOption.mockImplementation(async () => {
      throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "Live off is unsupported");
    });

    // Tolerance covers a level the adapter cannot name, not a control it has lost.
    await expect(
      manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "thinking",
        value: "off",
        tolerateRejectedThinking: true,
      }),
    ).rejects.toMatchObject({ code: "ACP_BACKEND_UNSUPPORTED_CONTROL" });
    expect(state.currentMeta?.runtimeOptions).toEqual({ thinking: "high" });
  });
});
