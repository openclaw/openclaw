import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  isolatedRequest,
  registerIsolatedHarness,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";

const { createAdmittedRunOperatorAuthority, readRunOperatorAuthority } =
  await import("./admitted-run-context.js");
const { prepareOperatorModelPolicy } = await import("./operator-model-policy.js");
const { withGatewayToolCallerIdentity } = await import("./tools/gateway-caller-context.js");
const { AsyncWorkScope } = await import("../shared/async-work-scope.js");
const { createDeferredCore } = await import("../shared/deferred.js");

const config = {
  agents: { entries: { main: {} }, defaults: { model: "test-provider/allowed" } },
};
function operator() {
  return createAdmittedRunOperatorAuthority({
    profileId: "isolated-reader",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    modelPolicy: prepareOperatorModelPolicy({
      cfg: config,
      policy: { sourceAgent: "main" },
      manifestPlugins: [],
    }),
  });
}
function request() {
  return {
    ...isolatedRequest(),
    config,
    provider: "test-provider",
    model: "allowed",
    agentHarnessRuntimeOverride: "test-harness",
  };
}

beforeEach(() => {
  resetIsolatedCompletionTestState();
  mocks.prepareSimpleCompletionModel.mockImplementation(async (params) => {
    const resolved = await params.modelResolver(
      params.provider,
      params.modelId,
      params.agentDir,
      params.cfg,
    );
    return {
      model: resolved.model,
      auth: { apiKey: "synthetic-test-key", source: "fixture", mode: "api-key" },
    };
  });
  mocks.resolveModelAsync.mockResolvedValue({
    logicalRef: { provider: "test-provider", model: "blocked" },
    model: { provider: "test-provider", id: "blocked", api: "openai-completions" },
  });
});

describe("isolated completion requester model policy", () => {
  it("cancels a removed model while another model and the original source remain active", async () => {
    const preparePolicy = (allow: string[]) =>
      prepareOperatorModelPolicy({
        cfg: config,
        policy: { sourceAgent: "main", allow },
        manifestPlugins: [],
      });
    let policy = preparePolicy(["test-provider/model-a", "test-provider/model-b"]);
    const observers = new Set<() => void>();
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "isolated-reader",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      get modelPolicy() {
        return policy;
      },
      onModelPolicyChanged: (listener) => {
        observers.add(listener);
        return () => {
          observers.delete(listener);
        };
      },
    });
    mocks.resolveModelAsync.mockImplementation(async (provider, model) => ({
      logicalRef: { provider, model },
      model: { provider, id: model, api: "openai-completions" },
    }));
    const started = createDeferredCore();
    const finishA = createDeferredCore();
    const finishB = createDeferredCore();
    const signals = new Map<string, AbortSignal>();
    registerIsolatedHarness({
      id: "test-harness",
      runIsolatedCompletionV2: async (params) => {
        if (!params.abortSignal) {
          throw new Error("isolated model has no cancellation signal");
        }
        signals.set(params.modelId, params.abortSignal);
        if (signals.size === 2) {
          started.resolve();
        }
        await (params.modelId === "model-a" ? finishA.promise : finishB.promise);
        return {
          assistant: {
            ...isolatedAssistant([{ type: "text", text: "Allowed answer." }]),
            provider: "test-provider",
            model: params.modelId,
          },
        };
      },
    });
    const work = new AsyncWorkScope();
    const first = work.track(() =>
      runIsolatedCompletion({ ...request(), model: "model-a", operatorAuthority: authority }),
    );
    const second = work.track(() =>
      runIsolatedCompletion({ ...request(), model: "model-b", operatorAuthority: authority }),
    );
    try {
      await Promise.race([
        started.promise,
        Promise.all([first, second]).then(() => {
          throw new Error("isolated completions settled before policy changed");
        }),
      ]);
      policy = preparePolicy(["test-provider/model-b"]);
      for (const listener of observers) {
        listener();
      }
      expect(signals.get("model-a")?.aborted).toBe(true);
      expect(signals.get("model-b")?.aborted).toBe(false);
      expect(() => authority.assertCurrent()).not.toThrow();
      finishA.resolve();
      await expect(first).rejects.toThrow("cannot use this model");
      finishB.resolve();
      await expect(second).resolves.toMatchObject({ text: "Allowed answer." });
    } finally {
      finishA.resolve();
      finishB.resolve();
      await Promise.allSettled([first, second]);
      await work.drain();
    }
    expect(observers.size).toBe(0);
  });
  it.each(["host", "harness"] as const)(
    "rejects a denied model resolved during %s preparation",
    async (owner) => {
      const dispatch = vi.fn();
      registerIsolatedHarness({
        id: "test-harness",
        ...(owner === "harness" ? { authBootstrap: "harness" as const } : {}),
        runIsolatedCompletionV2: dispatch,
      });
      await expect(
        runIsolatedCompletion({ ...request(), operatorAuthority: operator() }),
      ).rejects.toThrow("cannot use this model");
      expect(dispatch).not.toHaveBeenCalled();
      expect(mocks.runCliAgent).not.toHaveBeenCalled();
    },
  );

  it("keeps automatic metadata independent of an ambient operator restriction", async () => {
    const dispatch = vi.fn(async () => ({
      assistant: {
        ...isolatedAssistant([{ type: "text", text: "Session title" }]),
        provider: "test-provider",
        model: "blocked",
      },
    }));
    registerIsolatedHarness({ id: "test-harness", runIsolatedCompletionV2: dispatch });
    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:reader",
          operatorAuthority: operator(),
        },
        () => runIsolatedCompletion(request()),
      ),
    ).resolves.toMatchObject({ text: "Session title" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("carries the canonical requester model and original authority into CLI admission", async () => {
    const authority = operator();
    mocks.resolveCliRuntimeCanonicalProvider.mockReturnValue("test-provider");
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    mocks.runCliAgent.mockImplementation(async (params) => {
      expect(readRunOperatorAuthority({ preparedRunAdmission: params.preparedRunAdmission })).toBe(
        authority,
      );
      return { payloads: [{ text: "CLI answer." }] };
    });
    await expect(
      runIsolatedCompletion({
        ...request(),
        provider: "test-cli",
        agentHarnessRuntimeOverride: "test-cli",
        operatorAuthority: authority,
      }),
    ).resolves.toMatchObject({ text: "CLI answer." });
    expect(mocks.runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "test-cli",
        modelProvider: "test-provider",
        requesterModel: { provider: "test-provider", model: "allowed" },
      }),
    );
  });
});
