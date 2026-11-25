import { beforeEach, expect, it, vi } from "vitest";
import { runIsolatedAgentRuntimeCompletion } from "../plugins/runtime/runtime-llm-isolated.js";
import { createTestOperatorAuthority } from "./admitted-run-context.test-support.js";
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

const { attachProviderAuthAuthority } = await import("../plugins/provider-auth-authority.js");
const { readRunOperatorAuthority } = await import("./admitted-run-context.js");
const { prepareOperatorModelPolicy } = await import("./operator-model-policy.js");
const { withGatewayToolCallerIdentity } = await import("./tools/gateway-caller-context.js");

const config = {
  agents: { entries: { main: {} }, defaults: { model: "test-provider/allowed" } },
};
type ModelPolicy = NonNullable<Parameters<typeof prepareOperatorModelPolicy>[0]["policy"]>;
function operator(initial?: Partial<ModelPolicy>) {
  const policy = prepareOperatorModelPolicy({
    cfg: config,
    policy: { sourceAgent: "main", ...initial },
    manifestPlugins: [],
  });
  const authority = createTestOperatorAuthority({
    profileId: "isolated-reader",
    scopes: ["operator.write"],
    modelPolicy: policy,
  });
  return {
    authority,
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

it.each(["before-dispatch", "during-native-preparation"] as const)(
  "keeps host credential revocation observable to V2 harnesses %s",
  async (stage) => {
    let current = stage !== "before-dispatch";
    const revoked = new Error("Selected credential authority retired");
    mocks.prepareSimpleCompletionModel.mockResolvedValueOnce({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      auth: attachProviderAuthAuthority(
        { apiKey: "synthetic-key", mode: "api-key", source: "fixture" },
        () => {
          if (!current) {
            throw revoked;
          }
        },
      ),
    });
    const dispatch = vi.fn(async (params: { assertCurrent?: () => void }) => {
      current = false;
      params.assertCurrent?.();
      throw new Error("Revoked credential reached inference");
    });
    registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
    await expect(runIsolatedCompletion(isolatedRequest())).rejects.toBe(revoked);
    expect(dispatch).toHaveBeenCalledTimes(stage === "before-dispatch" ? 0 : 1);
  },
);
