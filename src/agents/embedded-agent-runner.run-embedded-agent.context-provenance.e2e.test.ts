// Exercises run-level context-window provenance through the real run preparation
// and terminal metadata, with model resolution and the model attempt stubbed.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import {
  buildEmbeddedRunnerAssistant,
  cleanupEmbeddedAgentRunnerTestWorkspace,
  createEmbeddedAgentRunnerOpenAiConfig,
  createEmbeddedAgentRunnerTestWorkspace,
  createResolvedEmbeddedRunnerModel,
  type EmbeddedAgentRunnerTestWorkspace,
  immediateEnqueue,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

type ModelResolution = ReturnType<typeof createResolvedEmbeddedRunnerModel>;
type RunEmbeddedAgent = typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;

const runAttempt = vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
const resolveModel = vi.fn<(provider: string, modelId: string) => Promise<ModelResolution>>();
let runEmbeddedAgent: (
  params: Omit<Parameters<RunEmbeddedAgent>[0], "admittedRunContext">,
) => ReturnType<RunEmbeddedAgent>;
let workspace: EmbeddedAgentRunnerTestWorkspace | undefined;
let runCounter = 0;

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full" });
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: (params) => runAttempt(params) });
  // mock-isolation: Avoid materializing provider credentials for prepared-model fixtures.
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  }));
  // mock-isolation: Supply prepared models while keeping the real run lifecycle.
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: (provider: string, modelId: string) => resolveModel(provider, modelId),
  }));
  runEmbeddedAgent = wrapRunWithTestPreparedAdmission(
    (await import("./embedded-agent-runner/run.js")).runEmbeddedAgent,
  );
  workspace = await createEmbeddedAgentRunnerTestWorkspace("openclaw-context-provenance-");
});

afterAll(async () => {
  await cleanupEmbeddedAgentRunnerTestWorkspace(workspace);
  workspace = undefined;
});

beforeEach(() => {
  resolveModel.mockReset();
  runAttempt.mockReset();
  runAttempt.mockResolvedValueOnce(
    makeEmbeddedRunnerAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildEmbeddedRunnerAssistant({
        provider: "openai",
        model: "wide-model",
        content: [{ type: "text", text: "ok" }],
      }),
    }),
  );
});

const selectableWindows = {
  contextWindows: [
    { id: "200k", label: "200K", contextWindow: 200_000 },
    { id: "1m", label: "1M", contextWindow: 1_000_000 },
  ],
  contextWindowDefault: "1m",
};

describe("embedded run context provenance", () => {
  it.each([
    {
      name: "the provider's unknown-model estimate",
      model: {
        contextWindow: DEFAULT_CONTEXT_TOKENS,
        contextWindowSource: "synthetic" as const,
      },
      contextTokens: DEFAULT_CONTEXT_TOKENS,
      source: "synthetic",
    },
    {
      name: "the resolved model window",
      model: { contextWindow: 1_000_000 },
      contextTokens: 1_000_000,
      source: "resolved-v1",
    },
    {
      name: "an unknown model window",
      model: { contextWindow: 0 },
      contextTokens: DEFAULT_CONTEXT_TOKENS,
      source: "resolved",
    },
    {
      // Authored windows are removable config; a trusted copy would outlive them.
      name: "an authored config window",
      model: { contextWindow: 1_000_000 },
      authoredModelIds: ["wide-model"],
      contextTokens: 16_000,
      source: "resolved",
    },
    {
      // The cold reader's producer tuple does not carry the window selection.
      name: "a session-selected window",
      model: { contextWindow: 1_000_000, ...selectableWindows },
      selectedContextWindow: "200k",
      contextTokens: 200_000,
      source: "resolved",
    },
    {
      name: "a selected window equal to the synthetic estimate",
      model: {
        contextWindow: 200_000,
        contextWindowSource: "synthetic" as const,
        ...selectableWindows,
      },
      selectedContextWindow: "200k",
      contextTokens: 200_000,
      source: "resolved",
    },
    {
      name: "the default of selectable windows",
      model: { contextWindow: 1_000_000, ...selectableWindows },
      contextTokens: 1_000_000,
      source: "resolved",
    },
  ])("marks context provenance for $name", async (testCase) => {
    if (!workspace) {
      throw new Error("workspace not prepared");
    }
    resolveModel.mockImplementation(async (provider, modelId) => {
      const resolved = createResolvedEmbeddedRunnerModel(provider, modelId);
      return { ...resolved, model: { ...resolved.model, ...testCase.model } };
    });
    const runId = `context-provenance-${++runCounter}`;

    const result = await runEmbeddedAgent({
      agentId: "main",
      sessionId: runId,
      sessionFile: `in-memory:${runId}`,
      workspaceDir: workspace.workspaceDir,
      agentDir: workspace.agentDir,
      config: createEmbeddedAgentRunnerOpenAiConfig(testCase.authoredModelIds ?? []),
      prompt: "hello",
      provider: "openai",
      model: "wide-model",
      timeoutMs: 5_000,
      runId,
      enqueue: immediateEnqueue,
      ...(testCase.selectedContextWindow ? { contextWindow: testCase.selectedContextWindow } : {}),
    });

    expect(result.meta.agentMeta).toMatchObject({
      contextTokens: testCase.contextTokens,
      contextTokensSource: testCase.source,
    });
  });
});
