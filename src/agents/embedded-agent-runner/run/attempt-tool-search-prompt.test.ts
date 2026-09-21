import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildBootstrapBudgetState } from "../../bootstrap-budget.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../harness/tool-surface-bridge.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createToolSearchTools } from "../../tool-search.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const { createFixture, mocks } = await vi.hoisted(
  async () => await import("./attempt-prompt-phase.test-support.js"),
);
vi.mock("../../../plugins/providers.runtime-core.js", () => ({
  createProviderRegistryResolver: () => ({
    isPluginProvidersLoadInFlight: () => {
      throw new Error("Unexpected provider discovery");
    },
    resolvePluginProvidersCore: () => {
      throw new Error("Unexpected provider discovery");
    },
  }),
}));
// The phase harness stubs observability; this test retains the real policy owner.
const { createPromptBuildToolPolicy } = await vi.importActual<
  typeof import("./attempt-prompt-support.js")
>("./attempt-prompt-support.js");

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
});

describe("embedded Tool Search prompt parity", () => {
  it.each(
    (["tools", "code", "directory"] as const).flatMap((mode) =>
      [undefined, ["fixture_allowed"], []].map((toolsAllow) => ({ mode, toolsAllow })),
    ),
  )(
    "submits only the current $mode catalog after hook allowlist $toolsAllow",
    async ({ mode, toolsAllow }) => {
      const fixture = createFixture({ pendingImageCount: 0 });
      const config = {
        agents: { defaults: { experimental: { localModelLean: false } } },
        tools: { codeMode: false, toolSearch: { enabled: true, mode } },
      };
      const runtime = createAgentHarnessToolSurfaceRuntimeCore({
        config,
        modelToolsEnabled: true,
        executeTool: async () => ({ content: [], details: {} }),
      });
      try {
        const sourceTools = ["fixture_allowed", "fixture_denied"].map(createStubTool);
        const surface = runtime.compactTools([
          ...createToolSearchTools({
            config: runtime.config,
            catalogRef: runtime.toolSearchCatalogRef,
          }),
          ...sourceTools,
        ]);
        const capabilityToolNames = new Set(sourceTools.map((tool) => tool.name));
        const attempt = {
          ...fixture.input.attempt,
          config,
          prompt: "Use the allowed capability.",
          promptMode: "full",
          sessionKey: "agent:main:prompt-parity",
          workspaceDir: "/workspace",
          model: makeProviderModelFixture({
            provider: "openai",
            id: "test-model",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          }),
        } as EmbeddedRunAttemptParams;
        const prepared = await prepareEmbeddedAttemptSystemPrompt({
          activeContextEngine: undefined,
          attempt,
          bootstrap: {
            ...buildBootstrapBudgetState({ files: [] }),
            bootstrapMode: "full",
            contextFiles: [],
            bootstrapInjectionStats: [],
            shouldRecordCompletedBootstrapTurn: false,
            workspaceNotes: [],
          },
          setup: createAttemptSetupFixture({
            effectiveCwd: "/workspace",
            effectiveWorkspace: "/workspace",
            getProviderRuntimeHandle: () => ({
              provider: attempt.provider,
              modelId: attempt.modelId,
              prepared: true,
            }),
          }),
          capabilityToolNames,
          effectiveTools: surface.tools,
          isRawModelRun: false,
          modelToolsEnabled: true,
          skillsPrompt: "",
          toolSearchDirectoryEnabled: true,
          toolSearchRuntimeConfig: runtime.config,
          toolSearchCatalogRef: runtime.toolSearchCatalogRef,
        });
        const { sessionRuntime } = fixture.input.prepared;
        sessionRuntime.state.systemPromptText = prepared.systemPromptText;
        sessionRuntime.agentSession.setActiveSessionSystemPrompt = (prompt) => {
          sessionRuntime.state.systemPromptText = prompt;
          return prompt;
        };
        fixture.input.attempt = attempt;
        fixture.input.prepared.systemPrompt = prepared;
        fixture.input.prepared.toolCatalog.toolSearchRunPlan.capabilityToolNames =
          capabilityToolNames;
        let activeToolNames = surface.tools.map((tool) => tool.name);
        fixture.input.prepared.promptToolPolicy = createPromptBuildToolPolicy({
          session: {
            getActiveToolNames: () => activeToolNames,
            setActiveToolsByName: (names) => {
              activeToolNames = names;
            },
          },
          effectiveTools: surface.tools,
          uncompactedEffectiveTools: sourceTools,
          tools: sourceTools,
          catalogRef: runtime.toolSearchCatalogRef,
          codeModeControlsEnabled: false,
          onApplied: (policy) => {
            capabilityToolNames.clear();
            for (const tool of policy.tools) {
              capabilityToolNames.add(tool.name);
            }
          },
        });
        type AssemblyInput = Parameters<
          typeof import("./attempt-prompt-build.js").prepareEmbeddedAttemptPromptAssembly
        >[0];
        mocks.preparePromptAssembly.mockImplementation(async (input: AssemblyInput) => {
          const callableToolNames = input.applyPromptBuildToolsAllow(toolsAllow);
          expect(callableToolNames.includes("fixture_allowed")).toBe(toolsAllow?.length !== 0);
          expect(callableToolNames.includes("fixture_denied")).toBe(toolsAllow === undefined);
          if (input.prepareSystemPrompt) {
            input.setActiveSessionSystemPrompt(
              await input.prepareSystemPrompt(sessionRuntime.state.systemPromptText),
            );
          }
          return { hookCtx: {}, transcriptLeafId: null };
        });
        let submittedPrompt = "";
        mocks.submitPrompt.mockImplementation(async () => {
          submittedPrompt = sessionRuntime.state.systemPromptText;
        });
        await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);
        expect(fixture.readState().promptError).toBeNull();
        expect(submittedPrompt).not.toBe("");
        if (toolsAllow === undefined) {
          expect(submittedPrompt).toBe(prepared.systemPromptText);
          expect(submittedPrompt).toContain("fixture_denied");
        } else {
          expect(runtime.toolSearchCatalogRef?.current?.entries.map((entry) => entry.name)).toEqual(
            toolsAllow,
          );
          expect(submittedPrompt).not.toContain("fixture_denied");
          expect(submittedPrompt).not.toContain("## Permission change");
        }
        expect(submittedPrompt.includes("fixture_allowed")).toBe(toolsAllow?.length !== 0);
        if (toolsAllow?.length === 0) {
          expect(submittedPrompt).not.toContain("Call tool_call");
          expect(submittedPrompt).not.toContain("openclaw.tools.call");
          expect(submittedPrompt).not.toContain("Call a unique deferred tool name directly");
        }
      } finally {
        runtime.cleanup();
      }
    },
  );
});
