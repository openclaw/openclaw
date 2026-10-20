import { describe, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import {
  baseCfg,
  installAcpSessionManagerTestLifecycle,
  managerFixture,
  mockMutableSession,
  readySessionMeta,
} from "./manager.test-helpers.js";

type ModelPolicy = GatewayOperatorRoleDefinition["modelPolicy"];

describe("ACP operator model ceiling", () => {
  installAcpSessionManagerTestLifecycle();
  const sessionKey = "agent:fixture:acp:role-policy";
  const cfg = {
    ...baseCfg,
    agents: { defaults: { model: "fixture/allowed" } },
  };

  async function run(
    model: string | undefined,
    beforePrompt?: (changePolicy: (policy: ModelPolicy) => void) => void,
    appliedModel?: string,
    initialPolicy: ModelPolicy = {},
  ) {
    const { runtimeState, run: runTurn } = managerFixture(sessionKey, readySessionMeta(), cfg);
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
    mockMutableSession(sessionKey, {
      currentMeta: readySessionMeta({ agent: "fixture", runtimeOptions: model ? { model } : {} }),
    });
    const preparePolicy = (policy: ModelPolicy) =>
      prepareOperatorModelPolicy({ cfg, policy, manifestPlugins: [] });
    let modelPolicy = preparePolicy(initialPolicy);
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
      const outcome = await runTurn({
        admittedRunContext,
        provenance: "human",
        text: "fixture request",
        requestId: "fixture-role-run",
        onBeforePrompt: () =>
          beforePrompt?.((policy) => {
            modelPolicy = preparePolicy(policy);
            for (const listener of policyListeners) {
              listener();
            }
          }),
      }).catch((error: unknown) => error);
      return { outcome, runtimeState };
    } finally {
      admission.close();
    }
  }

  it.each<[name: string, args: Parameters<typeof run>, beforeBackend: boolean]>([
    ["unqualified selection", [undefined], true],
    [
      "native model alias with an exact exclusion",
      [
        "google/gemini-3-pro",
        undefined,
        undefined,
        { allow: ["google/*"], deny: ["google/gemini-3-pro"] },
      ],
      true,
    ],
    [
      "backend substitution of an excluded model",
      ["fixture/allowed", undefined, "fixture/denied"],
      false,
    ],
    [
      "applied model revoked after admission while the requested model stays allowed",
      [
        "fixture/allowed",
        (changePolicy) => changePolicy({ allow: ["fixture/allowed"] }),
        "fixture/applied",
        { allow: ["fixture/allowed", "fixture/applied"] },
      ],
      false,
    ],
  ])("rejects %s without prompting", async (_name, args, beforeBackend) => {
    const { outcome, runtimeState } = await run(...args);
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toContain("operator role cannot use this model");
    if (beforeBackend) {
      expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    }
    expect(runtimeState.runTurn).not.toHaveBeenCalled();
  });

  it("executes a qualified allowed model and keeps the existing pre-prompt guard", async () => {
    const before = vi.fn();
    const { outcome, runtimeState } = await run("fixture/allowed", before);
    expect(outcome).toBeUndefined();
    expect(before).toHaveBeenCalledOnce();
    expect(runtimeState.runTurn).toHaveBeenCalledOnce();
  });
});
