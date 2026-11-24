import { describe, expect, it } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { createTestOperatorAuthority } from "../../agents/admitted-run-context.test-support.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockMutableSession,
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
    mockMutableSession(sessionKey, {
      currentMeta: readySessionMeta({ agent: "fixture", runtimeOptions: model ? { model } : {} }),
    });
    const modelPolicy = prepareOperatorModelPolicy({
      cfg,
      policy: initialPolicy,
      manifestPlugins: [],
    });
    const authority = createTestOperatorAuthority({
      profileId: "fixture-person",
      scopes: ["operator.write"],
      modelPolicy,
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

  it.each<[name: string, args: Parameters<typeof run>, beforeBackend: boolean]>([
    ["unqualified selection", [undefined], true],
    [
      "native model alias with an exact exclusion",
      ["google/gemini-3-pro", undefined, { allow: ["google/*"], deny: ["google/gemini-3-pro"] }],
      true,
    ],
    ["backend substitution of an excluded model", ["fixture/allowed", "fixture/denied"], false],
  ])("rejects %s without prompting", async (_name, args, beforeBackend) => {
    const { outcome, runtimeState } = await run(...args);
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toContain("operator role cannot use this model");
    if (beforeBackend) {
      expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    }
    expect(runtimeState.runTurn).not.toHaveBeenCalled();
  });
});
