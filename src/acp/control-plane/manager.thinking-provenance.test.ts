/** Inherited thinking stays optional; only an explicit selection fails when unsupported. */
import type { AcpRuntimeCapabilities } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import {
  AcpRuntimeError,
  AcpSessionManager,
  type AcpRuntime,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installMutableAcpSessionMetaUpsert,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

const sessionKey = "agent:codex:acp:thinking-provenance";
const model = "openai/gpt-5.6-luna";

const modelsOnly: AcpRuntimeCapabilities = { controls: ["session/set_model", "session/status"] };
const effortConfig: AcpRuntimeCapabilities = {
  controls: ["session/set_config_option", "session/status"],
  configOptionKeys: ["model", "effort"],
};

function requestError(details: string) {
  return Object.assign(new Error("Internal error"), {
    name: "RequestError",
    code: -32603,
    data: { details },
  });
}

function fixture(currentMeta?: SessionAcpMeta, capabilities = modelsOnly) {
  const runtime = createRuntime();
  const setModel = vi.fn<NonNullable<AcpRuntime["setModel"]>>(async () => {});
  runtime.runtime.setModel = setModel;
  runtime.getCapabilities.mockResolvedValue(capabilities);
  const state: { currentMeta: SessionAcpMeta | undefined } = { currentMeta };
  installMutableAcpSessionMetaUpsert(state);
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
  hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
    sessionKey,
    storeSessionKey: sessionKey,
    acp: state.currentMeta,
    entry: { sessionId: "thinking-provenance", updatedAt: 1, acp: state.currentMeta },
  }));
  const manager = new AcpSessionManager();
  const initialize = (thinkingExplicit: boolean) =>
    manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agentId: "codex",
      agent: "auggie",
      mode: "persistent",
      runtimeOptions: { model, thinking: "high" },
      modelExplicit: true,
      thinkingExplicit,
    });
  const run = (requestId: string, target = manager) =>
    target.runTurn({
      cfg: baseCfg,
      sessionKey,
      provenance: "system",
      mode: "prompt",
      text: "work",
      requestId,
    });
  return { ...runtime, setModel, state, manager, initialize, run };
}

describe("AcpSessionManager thinking provenance", () => {
  installAcpSessionManagerTestLifecycle();

  it("prompts through native set_model when inherited thinking is unsupported", async () => {
    const f = fixture();
    await f.initialize(false);
    expect(f.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({ model, thinking: "high", thinkingExplicit: false }),
    );
    expect(f.state.currentMeta?.runtimeOptions).toMatchObject({ model, thinking: "high" });

    await f.run("inherited-thinking");

    expect(f.setModel.mock.calls.map(([input]) => input.model)).toEqual([model]);
    expect(f.setConfigOption).not.toHaveBeenCalled();
    expect(f.runTurn).toHaveBeenCalledOnce();
    expect(f.ensureSession).toHaveBeenCalledOnce();
    expect(f.state.currentMeta).toMatchObject({
      state: "idle",
      thinkingExplicit: false,
      runtimeOptions: { model },
    });
  });

  it("rejects explicit unsupported thinking before the native prompt", async () => {
    const f = fixture();
    await f.initialize(true);
    expect(f.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({ model, thinking: "high", thinkingExplicit: true }),
    );
    expect(f.state.currentMeta?.runtimeOptions).toMatchObject({ model, thinking: "high" });

    await expect(f.run("explicit-thinking")).rejects.toMatchObject({
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
    });

    expect(f.runTurn).not.toHaveBeenCalled();
    expect(f.setModel.mock.calls.map(([input]) => input.model)).toEqual([model]);
    expect(f.setConfigOption).not.toHaveBeenCalled();
    expect(f.ensureSession).toHaveBeenCalledOnce();
    expect(f.state.currentMeta?.runtimeOptions).toMatchObject({ model, thinking: "high" });
  });

  it("keeps best-effort replay for legacy thinking without recorded provenance", async () => {
    const f = fixture(
      readySessionMeta({ agent: "auggie", runtimeOptions: { model, thinking: "high" } }),
    );

    await f.run("legacy-thinking");
    await f.run("legacy-thinking-again");

    expect(f.setModel.mock.calls[0]?.[0].model).toBe(model);
    expect(f.setConfigOption).not.toHaveBeenCalled();
    expect(f.runTurn).toHaveBeenCalledTimes(2);
    expect(f.state.currentMeta?.runtimeOptions).toMatchObject({ model, thinking: "high" });
    expect(f.state.currentMeta).not.toMatchObject({ thinkingExplicit: true });
  });

  it("forwards inherited provenance when a new manager reopens the native session", async () => {
    const f = fixture();
    await f.initialize(false);
    await f.run("before-reopen");

    await f.run("after-reopen", new AcpSessionManager());

    expect(f.ensureSession).toHaveBeenCalledTimes(2);
    expect(f.ensureSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionKey,
        agentId: "codex",
        agent: "auggie",
        model,
        thinking: "high",
        thinkingExplicit: false,
      }),
    );
    expect(f.runTurn).toHaveBeenCalledTimes(2);
    expect(f.state.currentMeta).toMatchObject({ agent: "auggie", thinkingExplicit: false });
  });

  it("marks a same-value thinking update explicit and clears it on reset", async () => {
    const f = fixture();
    await f.initialize(false);
    await f.run("inherited-thinking");
    expect(f.runTurn).toHaveBeenCalledOnce();

    await f.manager.updateSessionRuntimeOptions({
      cfg: baseCfg,
      sessionKey,
      patch: { thinking: "high" },
    });
    expect(f.state.currentMeta).toMatchObject({
      thinkingExplicit: true,
      runtimeOptions: { model, thinking: "high" },
    });

    await expect(f.run("explicit-thinking")).rejects.toMatchObject({
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
    });
    expect(f.runTurn).toHaveBeenCalledOnce();
    expect(f.setConfigOption).not.toHaveBeenCalled();

    await f.manager.resetSessionRuntimeOptions({ cfg: baseCfg, sessionKey });
    expect(f.state.currentMeta?.runtimeOptions).toBeUndefined();
    expect(f.state.currentMeta?.thinkingExplicit).toBeUndefined();
  });

  it.each([
    { thinkingExplicit: false, prompts: 1 },
    { thinkingExplicit: true, prompts: 0 },
  ])(
    "applies the explicitness gate to a wrapped thinking config rejection: explicit=$thinkingExplicit",
    async ({ thinkingExplicit, prompts }) => {
      const f = fixture(undefined, effortConfig);
      f.setConfigOption.mockImplementation(async ({ key, value }) => {
        if (key === "effort") {
          throw requestError(`Invalid value for config option effort: ${value}`);
        }
      });
      await f.initialize(thinkingExplicit);

      const turn = f.run(`wrapped-${thinkingExplicit}`);
      if (thinkingExplicit) {
        await expect(turn).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
      } else {
        await turn;
      }

      expect(f.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
        ["model", model],
        ["effort", "high"],
      ]);
      expect(f.setModel).not.toHaveBeenCalled();
      expect(f.runTurn).toHaveBeenCalledTimes(prompts);
      expect(f.state.currentMeta?.runtimeOptions).toMatchObject({ model, thinking: "high" });
    },
  );

  it.each([
    {
      label: "model rejection",
      reject: (key: string) =>
        key === "model" ? requestError(`Invalid value for config option model: ${model}`) : null,
      expected: { code: "ACP_TURN_FAILED" },
    },
    {
      label: "owner repair",
      reject: (key: string) =>
        key === "effort"
          ? new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "owner migration required", {
              detailCode: "SESSION_OWNER_MIGRATION_REQUIRED",
            })
          : null,
      expected: { detailCode: "SESSION_OWNER_MIGRATION_REQUIRED" },
    },
    {
      label: "unrelated thinking failure",
      reject: (key: string) =>
        key === "effort" ? requestError("unsupported transport protocol") : null,
      expected: { code: "ACP_TURN_FAILED" },
    },
  ])("never tolerates a $label for inherited thinking", async ({ reject, expected }) => {
    const f = fixture(undefined, effortConfig);
    f.setConfigOption.mockImplementation(async ({ key }) => {
      const error = reject(key);
      if (error) {
        throw error;
      }
    });
    await f.initialize(false);

    await expect(f.run("not-tolerated")).rejects.toMatchObject(expected);

    expect(f.runTurn).not.toHaveBeenCalled();
    expect(f.setModel).not.toHaveBeenCalled();
  });
});
