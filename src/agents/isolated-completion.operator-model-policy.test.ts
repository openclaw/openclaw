import { beforeEach, expect, it, vi } from "vitest";
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
type ModelPolicy = NonNullable<Parameters<typeof prepareOperatorModelPolicy>[0]["policy"]>;
function operator(initial?: Partial<ModelPolicy>) {
  const prepare = (overrides: Partial<ModelPolicy>) =>
    prepareOperatorModelPolicy({
      cfg: config,
      policy: { sourceAgent: "main", ...overrides },
      manifestPlugins: [],
    });
  let policy = prepare(initial ?? {});
  const listeners = new Set<() => void>();
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "isolated-reader",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    get modelPolicy() {
      return policy;
    },
    onModelPolicyChanged: initial
      ? (listener) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        }
      : undefined,
  });
  return {
    authority,
    listeners,
    setPolicy(this: void, overrides: Partial<ModelPolicy>) {
      policy = prepare(overrides);
      listeners.forEach((listener) => listener());
      return policy;
    },
  };
}
const denied = {
  message: expect.stringContaining("cannot use this model"),
  name: "LlmCompleteError",
  code: "LLM_COMPLETION_NOT_AUTHORIZED",
};
function answer(text: string, model: string) {
  return {
    assistant: {
      ...isolatedAssistant([{ type: "text", text }]),
      provider: "test-provider",
      model,
    },
  };
}
function waitForStart<T>(started: Promise<T>, ...runs: Promise<unknown>[]) {
  return Promise.race([
    started,
    Promise.all(runs).then(() => {
      throw new Error("Completion settled before dispatch");
    }),
  ]);
}

function runPluginCompletion(
  authority: ReturnType<typeof operator>["authority"],
  model = "allowed",
  provider = "test-provider",
) {
  return runIsolatedAgentRuntimeCompletion({
    request: {
      messages: [{ role: "user", content: "Answer the synthetic question." }],
      execution: { mode: "isolated-agent-runtime" },
    },
    cfg: config,
    agentId: "main",
    provider,
    model,
    operatorAuthority: authority,
  });
}

beforeEach(() => {
  resetIsolatedCompletionTestState();
  mocks.prepareSimpleCompletionModel.mockImplementation(
    async ({ modelResolver, provider, modelId, agentDir, cfg }) => ({
      model: (await modelResolver(provider, modelId, agentDir, cfg)).model,
      auth: { apiKey: "synthetic-test-key", source: "fixture", mode: "api-key" },
    }),
  );
  mocks.resolveModelAsync.mockResolvedValue({
    logicalRef: { provider: "test-provider", model: "blocked" },
    model: { provider: "test-provider", id: "blocked", api: "openai-completions" },
  });
});

it("keeps revocation latched after restoration without cancelling the source or sibling", async () => {
  const { authority, listeners, setPolicy } = operator({
    allow: ["test-provider/model-a", "test-provider/model-b"],
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
      return answer("Allowed answer.", params.modelId);
    },
  });
  const work = new AsyncWorkScope();
  const first = work.track(() => runPluginCompletion(authority, "model-a"));
  const second = work.track(() => runPluginCompletion(authority, "model-b"));
  try {
    await waitForStart(started.promise, first, second);
    setPolicy({ allow: ["test-provider/model-b"] });
    expect([signals.get("model-a")?.aborted, signals.get("model-b")?.aborted]).toEqual([
      true,
      false,
    ]);
    const restored = setPolicy({ allow: ["test-provider/model-a", "test-provider/model-b"] });
    expect(restored?.allows({ provider: "test-provider", model: "model-a" })).toBe(true);
    expect(() => authority.assertCurrent()).not.toThrow();
    finishA.resolve();
    await expect(first).rejects.toMatchObject(denied);
    finishB.resolve();
    await expect(second).resolves.toMatchObject({ text: "Allowed answer." });
  } finally {
    finishA.resolve();
    finishB.resolve();
    await Promise.allSettled([first, second]);
    await work.drain();
  }
  expect(listeners.size).toBe(0);
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
    await expect(runPluginCompletion(operator().authority)).rejects.toMatchObject(denied);
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.runCliAgent).not.toHaveBeenCalled();
  },
);

it("keeps automatic metadata independent of an ambient operator restriction", async () => {
  const dispatch = vi.fn(async () => answer("Session title", "blocked"));
  registerIsolatedHarness({ id: "test-harness", runIsolatedCompletionV2: dispatch });
  await expect(
    withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:reader",
        operatorAuthority: operator().authority,
      },
      () =>
        runIsolatedCompletion({
          ...isolatedRequest(),
          config,
          provider: "test-provider",
          model: "allowed",
          agentHarnessRuntimeOverride: "test-harness",
        }),
    ),
  ).resolves.toMatchObject({ text: "Session title" });
});

it("passes the operator and canonical model to the CLI execution owner", async () => {
  const { authority } = operator({ deny: [] });
  cli.prepare.mockImplementation(async (params) => {
    expect(readRunOperatorAuthority({ preparedRunAdmission: params.preparedRunAdmission })).toBe(
      authority,
    );
    expect(params).toMatchObject({
      provider: "test-cli",
      modelProvider: "test-provider",
      requesterModel: { provider: "test-provider", model: "allowed" },
    });
    const admittedRunContext =
      params.admittedRunContext ?? (await params.preparedRunAdmission?.admit("embedded"));
    if (!admittedRunContext) {
      throw new Error("CLI completion requires its admitted run");
    }
    const context = buildPreparedCliRunContext({
      provider: "google-gemini-cli",
      model: "transport-alias",
      config,
      backend: { sessionMode: "none" },
    });
    return { ...context, params: { ...params, admittedRunContext } };
  });
  cli.execute.mockResolvedValue({ text: "CLI answer" });
  mocks.resolveCliRuntimeCanonicalProvider.mockReturnValue("test-provider");
  mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
  mocks.runCliAgent.mockImplementation(runRealCliAgent);
  await expect(runPluginCompletion(authority, "allowed", "test-cli")).resolves.toMatchObject({
    text: "CLI answer",
  });
});
