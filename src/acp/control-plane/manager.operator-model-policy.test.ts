import { describe, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("ACP operator model ceiling", () => {
  installAcpSessionManagerTestLifecycle();
  const sessionKey = "agent:fixture:acp:role-policy";
  const cfg = {
    ...baseCfg,
    agents: { defaults: { model: "fixture/allowed" } },
  };

  async function run(
    model: string | undefined,
    beforePrompt?: (
      changePolicy: (policy: GatewayOperatorRoleDefinition["modelPolicy"]) => void,
    ) => void,
    appliedModel?: string,
    initialPolicy: GatewayOperatorRoleDefinition["modelPolicy"] = {},
  ) {
    const runtimeState = createRuntime();
    if (appliedModel) {
      runtimeState.ensureSession.mockResolvedValue({
        sessionKey,
        backend: "acpx",
        runtimeSessionName: "fixture-runtime",
        appliedModel: { kind: "applied", model: appliedModel },
      });
      runtimeState.setConfigOption.mockResolvedValue({
        configOptions: [{ id: "model", currentValue: appliedModel }],
      });
    }
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta({ agent: "fixture", runtimeOptions: model ? { model } : {} }),
    });
    let modelPolicy = prepareOperatorModelPolicy({
      cfg,
      policy: initialPolicy,
      manifestPlugins: [],
    });
    const policyListeners = new Set<() => void>();
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "fixture-person",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      get modelPolicy() {
        return modelPolicy;
      },
      onModelPolicyChanged: (listener) => {
        policyListeners.add(listener);
        return () => policyListeners.delete(listener);
      },
    });
    const admission = prepareSystemAgentRunAdmission(
      cfg,
      "fixture-role-run",
      "fixture",
      "test",
      undefined,
      authority,
    );
    try {
      const admittedRunContext = await admission.admit("acp");
      const outcome = await new AcpSessionManager()
        .runTurn({
          cfg,
          admittedRunContext,
          provenance: "human",
          sessionKey,
          text: "fixture request",
          mode: "prompt",
          requestId: "fixture-role-run",
          onBeforePrompt: () =>
            beforePrompt?.((policy) => {
              modelPolicy = prepareOperatorModelPolicy({ cfg, policy, manifestPlugins: [] });
              for (const listener of policyListeners) {
                listener();
              }
            }),
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      return { outcome, runtimeState };
    } finally {
      admission.close();
    }
  }

  it.each(["fixture/denied", "bare-native-model", undefined])(
    "rejects an excluded or unqualified selection before backend preparation: %s",
    async (model) => {
      const { outcome, runtimeState } = await run(model);
      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome)).toContain("operator role cannot use this model");
      expect(runtimeState.ensureSession).not.toHaveBeenCalled();
      expect(runtimeState.runTurn).not.toHaveBeenCalled();
    },
  );

  it("executes a qualified allowed model and keeps the existing pre-prompt guard", async () => {
    const before = vi.fn();
    const { outcome, runtimeState } = await run("fixture/allowed", before);
    expect(outcome).toBeUndefined();
    expect(before).toHaveBeenCalledOnce();
    expect(runtimeState.runTurn).toHaveBeenCalledOnce();
  });

  it("does not prompt a backend that substitutes an excluded model", async () => {
    const { outcome, runtimeState } = await run("fixture/allowed", undefined, "fixture/denied");
    expect(String(outcome)).toContain("operator role cannot use this model");
    expect(runtimeState.runTurn).not.toHaveBeenCalled();
  });

  it("rechecks the applied model after admission even when the requested model remains allowed", async () => {
    const { outcome, runtimeState } = await run(
      "fixture/allowed",
      (changePolicy) => changePolicy({ allow: ["fixture/allowed"] }),
      "fixture/applied",
      { allow: ["fixture/allowed", "fixture/applied"] },
    );
    expect(String(outcome)).toContain("operator role cannot use this model");
    expect(runtimeState.runTurn).not.toHaveBeenCalled();
  });

  it("normalizes native model aliases before checking an exact exclusion", async () => {
    const { outcome, runtimeState } = await run("google/gemini-3-pro", undefined, undefined, {
      allow: ["google/*"],
      deny: ["google/gemini-3-pro"],
    });
    expect(String(outcome)).toContain("operator role cannot use this model");
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.runTurn).not.toHaveBeenCalled();
  });
});
