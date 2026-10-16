import { describe, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import {
  AcpSessionManager,
  type AcpRuntime,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
  type SessionAcpMeta,
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
    nativeModelId?: string,
  ) {
    const runtimeState = createRuntime();
    const setModel = vi.fn<NonNullable<AcpRuntime["setModel"]>>(async () => ({
      currentModelId: nativeModelId,
    }));
    if (nativeModelId) {
      runtimeState.runtime.setModel = setModel;
      runtimeState.getCapabilities.mockResolvedValue({
        controls: ["session/set_model", "session/status"],
      });
    }
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
      return { outcome, runtimeState, setModel };
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
      "native set_model substitution of an excluded model",
      ["fixture/allowed", undefined, undefined, {}, "fixture/denied"],
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

  it("binds an acknowledged native set_model id to the allowed qualified ref", async () => {
    const { outcome, runtimeState, setModel } = await run(
      "fixture/allowed",
      undefined,
      undefined,
      {},
      "allowed",
    );
    expect(outcome).toBeUndefined();
    expect(setModel.mock.calls.map(([input]) => input.model)).toEqual(["fixture/allowed"]);
    expect(runtimeState.setConfigOption).not.toHaveBeenCalled();
    expect(runtimeState.runTurn).toHaveBeenCalledOnce();
  });

  it.each([
    { when: "before the next turn", ensuredModel: undefined, revokeDuringTurn: false },
    {
      when: "during a cached turn after a stale ensure fact",
      ensuredModel: "fixture/allowed",
      revokeDuringTurn: true,
    },
  ])("rejects a cached snapshot-accepted model revoked $when", async (variant) => {
    const runtimeState = createRuntime();
    const { ensuredModel } = variant;
    if (ensuredModel) {
      runtimeState.ensureSession.mockImplementation(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        appliedModel: { kind: "applied", model: ensuredModel },
      }));
    }
    let meta = readySessionMeta({
      agent: "fixture",
      runtimeOptions: { model: "fixture/allowed" },
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
        return { sessionId: "role-policy", updatedAt: Date.now(), acp: meta };
      },
    );
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
      configOptionKeys: ["model"],
    });
    runtimeState.setConfigOption.mockResolvedValue({
      configOptions: [{ id: "model", category: "model", currentValue: "fixture/applied" }],
    });
    let modelPolicy = prepareOperatorModelPolicy({
      cfg,
      policy: { allow: ["fixture/allowed", "fixture/applied"] },
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
    const revokeApplied = () => {
      modelPolicy = prepareOperatorModelPolicy({
        cfg,
        policy: { allow: ["fixture/allowed"] },
        manifestPlugins: [],
      });
      for (const listener of policyListeners) {
        listener();
      }
    };
    const manager = new AcpSessionManager();
    const runAdmitted = async (requestId: string, onBeforePrompt?: () => void) => {
      const admission = prepareSystemAgentRunAdmission(
        cfg,
        requestId,
        "fixture",
        "test",
        undefined,
        authority,
      );
      try {
        return await manager
          .runTurn({
            cfg,
            admittedRunContext: await admission.admit("acp"),
            provenance: "human",
            sessionKey,
            text: "fixture request",
            mode: "prompt",
            requestId,
            ...(onBeforePrompt ? { onBeforePrompt } : {}),
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
      } finally {
        admission.close();
      }
    };

    await expect(runAdmitted("fixture-role-first")).resolves.toBeUndefined();
    expect(runtimeState.setConfigOption).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: "model", value: "fixture/allowed" }),
    );
    expect(runtimeState.runTurn).toHaveBeenCalledOnce();
    expect(meta.runtimeOptions?.model).toBe("fixture/applied");

    if (!variant.revokeDuringTurn) {
      revokeApplied();
    }
    const outcome = await runAdmitted(
      "fixture-role-second",
      variant.revokeDuringTurn ? revokeApplied : undefined,
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toContain("operator role cannot use this model");
    expect(runtimeState.runTurn).toHaveBeenCalledOnce();
    expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
  });
});
