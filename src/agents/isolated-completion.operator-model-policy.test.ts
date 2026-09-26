import { beforeEach, describe, expect, it, vi } from "vitest";
import { runIsolatedAgentRuntimeCompletion } from "../plugins/runtime/runtime-llm-isolated.js";
import type { CliOutput } from "./cli-output-contracts.js";
import { runCliAgent as runRealCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  isolatedRequest,
  registerIsolatedHarness,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";

const cli = vi.hoisted(() => ({
  prepare: vi.fn<(params: RunCliAgentParams) => Promise<PreparedCliRunContext>>(),
  execute: vi.fn<(context: PreparedCliRunContext) => Promise<CliOutput>>(),
}));
vi.mock("./cli-runner/prepare.runtime.js", () => ({ prepareCliRunContext: cli.prepare }));
vi.mock("./cli-runner/execute.runtime.js", () => ({ executePreparedCliRun: cli.execute }));

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

function runCompletion(
  caller: "core" | "plugin",
  authority: ReturnType<typeof operator>,
  model = "allowed",
) {
  return caller === "core"
    ? runIsolatedCompletion({ ...request(), model, operatorAuthority: authority })
    : runIsolatedAgentRuntimeCompletion({
        request: {
          messages: [{ role: "user", content: "Answer the synthetic question." }],
          execution: { mode: "isolated-agent-runtime" },
        },
        cfg: config,
        agentId: "main",
        provider: "test-provider",
        model,
        operatorAuthority: authority,
      });
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
  it.each(["core", "plugin"] as const)(
    "cancels a removed model for %s while another model and the source remain active",
    async (caller) => {
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
      const first = work.track(() => runCompletion(caller, authority, "model-a"));
      const second = work.track(() => runCompletion(caller, authority, "model-b"));
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
        await expect(first).rejects.toMatchObject({
          message: expect.stringContaining("cannot use this model"),
          ...(caller === "plugin"
            ? { name: "LlmCompleteError", code: "LLM_COMPLETION_NOT_AUTHORIZED" }
            : {}),
        });
        finishB.resolve();
        await expect(second).resolves.toMatchObject({ text: "Allowed answer." });
      } finally {
        finishA.resolve();
        finishB.resolve();
        await Promise.allSettled([first, second]);
        await work.drain();
      }
      expect(observers.size).toBe(0);
    },
  );
  it.each([
    { owner: "host", caller: "core" },
    { owner: "harness", caller: "core" },
    { owner: "host", caller: "plugin" },
    { owner: "harness", caller: "plugin" },
  ] as const)(
    "rejects a denied model resolved during $owner preparation for $caller",
    async ({ owner, caller }) => {
      const dispatch = vi.fn();
      registerIsolatedHarness({
        id: "test-harness",
        ...(owner === "harness" ? { authBootstrap: "harness" as const } : {}),
        runIsolatedCompletionV2: dispatch,
      });
      await expect(runCompletion(caller, operator())).rejects.toMatchObject({
        message: expect.stringContaining("cannot use this model"),
        ...(caller === "plugin"
          ? { name: "LlmCompleteError", code: "LLM_COMPLETION_NOT_AUTHORIZED" }
          : {}),
      });
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

  it("preserves a retired CLI model denial after the model policy is restored", async () => {
    const preparePolicy = (deny: string[]) =>
      prepareOperatorModelPolicy({
        cfg: config,
        policy: { sourceAgent: "main", deny },
        manifestPlugins: [],
      });
    let policy = preparePolicy([]);
    const listeners = new Set<() => void>();
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "isolated-reader",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      get modelPolicy() {
        return policy;
      },
      onModelPolicyChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const context = buildPreparedCliRunContext({
      provider: "google-gemini-cli",
      model: "transport-alias",
      backend: { sessionMode: "none" },
      config,
    });
    const cleanup = vi.fn(async () => {});
    cli.prepare.mockImplementation(async (params) => {
      const admittedRunContext =
        params.admittedRunContext ?? (await params.preparedRunAdmission?.admit("embedded"));
      if (!admittedRunContext) {
        throw new Error("CLI completion requires its admitted run");
      }
      return {
        ...context,
        params: { ...params, admittedRunContext },
        preparedBackend: { ...context.preparedBackend, cleanup },
      };
    });
    const started = createDeferredCore<AbortSignal | undefined>();
    const finish = createDeferredCore();
    cli.execute.mockImplementation(async (prepared) => {
      started.resolve(prepared.params.abortSignal);
      await finish.promise;
      return { text: "retired model output" };
    });
    mocks.resolveCliRuntimeCanonicalProvider.mockReturnValue("test-provider");
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    mocks.runCliAgent.mockImplementation(runRealCliAgent);
    const pending = runIsolatedAgentRuntimeCompletion({
      request: {
        messages: [{ role: "user", content: "Answer the synthetic question." }],
        execution: { mode: "isolated-agent-runtime" },
      },
      cfg: config,
      agentId: "main",
      provider: "test-cli",
      model: "allowed",
      operatorAuthority: authority,
    });
    const outcome = pending.catch((error: unknown) => error);
    try {
      const signal = await Promise.race([
        started.promise,
        pending.then(() => {
          throw new Error("CLI settled before dispatch");
        }),
      ]);
      policy = preparePolicy(["test-provider/allowed"]);
      for (const listener of listeners) {
        listener();
      }
      expect(signal?.aborted).toBe(true);
      policy = preparePolicy([]);
      for (const listener of listeners) {
        listener();
      }
      expect(() => authority.assertCurrent()).not.toThrow();
      if (!policy) {
        throw new Error("Restored CLI model policy was not prepared");
      }
      expect(policy.allows({ provider: "test-provider", model: "allowed" })).toBe(true);
      finish.resolve();
      expect(await outcome).toMatchObject({
        name: "LlmCompleteError",
        code: "LLM_COMPLETION_NOT_AUTHORIZED",
        message: expect.stringContaining("cannot use this model"),
      });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(0);
    } finally {
      finish.resolve();
      await outcome;
    }
  });
});
