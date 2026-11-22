import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { toToolDefinitions } from "../../agent-tool-definition-adapter.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../harness/tool-surface-bridge.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createToolSearchTools } from "../../tool-search.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import { createEmptyPromptBootstrap } from "./attempt-system-prompt.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const { createFixture, createPromptAssemblyResult, mocks } = await vi.hoisted(
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

beforeEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()));

async function promptFixture(
  codeMode = false,
  mode: "tools" | "directory" = "tools",
  skillsDeferred = false,
) {
  const config = {
    agents: { defaults: { experimental: { localModelLean: false } } },
    tools: { codeMode, ...(!codeMode && { toolSearch: { enabled: true, mode } }) },
  };
  const fixture = createFixture({ pendingImageCount: 0 });
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({
    config,
    modelToolsEnabled: true,
    executeTool: async () => ({ content: [], details: {} }),
  });
  const admission = prepareSystemAgentRunAdmission(
    config,
    fixture.input.attempt.runId,
    "main",
    codeMode ? "session-create-prompt-test" : "tool-search-prompt-test",
  );
  onTestFinished(() => {
    admission.close();
    runtime.cleanup();
  });
  const sourceTools = [
    ...(codeMode ? ["sessions_create"] : ["fixture_allowed", "fixture_denied"]),
    ...(skillsDeferred ? ["skills_search", "skills_read"] : []),
  ].map(createStubTool);
  const surface = runtime.compactTools([
    ...(!codeMode
      ? createToolSearchTools({ config: runtime.config, catalogRef: runtime.toolSearchCatalogRef })
      : []),
    ...sourceTools,
  ]);
  const capabilityToolNames = new Set(sourceTools.map((tool) => tool.name));
  const attempt = {
    ...fixture.input.attempt,
    admittedRunContext: await admission.admit("embedded"),
    config,
    prompt: codeMode ? "spin up a new task" : "Use the allowed capability.",
    sessionKey: codeMode ? "agent:main:dashboard:task" : "agent:main:prompt-parity",
    promptMode: "full",
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
    bootstrap: createEmptyPromptBootstrap(),
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
    codeModeActive: codeMode,
    toolSearchDirectoryEnabled: !codeMode,
    deferredToolsDirectlyCallable: !codeMode && mode === "directory",
    toolSearchRuntimeConfig: runtime.config,
    toolSearchCatalogRef: runtime.toolSearchCatalogRef,
  });
  return { fixture, runtime, surface, sourceTools, capabilityToolNames, attempt, prepared };
}

it("keeps explicit task creation discoverable in Code Mode and removes revoked capability guidance", async () => {
  const { runtime, surface, capabilityToolNames, prepared } = await promptFixture(true);
  expect(surface.tools.map((tool) => tool.name)).not.toContain("sessions_create");
  expect(prepared.systemPromptText).toContain('"spin up a new task"');
  expect(prepared.systemPromptText).toContain("`sessions_create`");
  expect(prepared.systemPromptText).toContain("no completion event or yield expectation");
  expect(prepared.systemPromptText).not.toContain("## Delegation");

  const restricted = runtime.compactTools([createStubTool("sessions")]);
  capabilityToolNames.clear();
  capabilityToolNames.add("sessions");
  if (!prepared.prepareToolPrompt) {
    throw new Error("Expected tool-capability prompt refresh");
  }
  const refreshPrompt = await prepared.prepareToolPrompt(restricted.tools);
  expect(refreshPrompt(prepared.systemPromptText)).not.toContain("`sessions_create`");
});

it.each(["tools", "directory"] as const)(
  "guides deferred skill access through the callable %s surface",
  async (mode) => {
    const { surface, prepared } = await promptFixture(false, mode, true);
    expect(surface.tools.map((tool) => tool.name)).not.toContain("skills_read");
    if (mode === "tools") {
      expect(prepared.systemPromptText).toContain(
        'call `dispatch_action` with `{"id":"skills_read","args":{"name":"<name>"}}`',
      );
      expect(prepared.systemPromptText).toContain(
        'by calling `dispatch_action` with `{"id":"skills_search","args":{"query":"<query>"}}`',
      );
      expect(prepared.systemPromptText).not.toContain("use `skills_read` with its exact name");
    } else {
      expect(prepared.systemPromptText).toContain("use `skills_read` with its exact name");
    }
  },
);

it.each([
  { mode: "tools" as const, toolsAllow: undefined },
  ...(["tools", "directory"] as const).flatMap((mode) =>
    [["fixture_allowed"], []].map((toolsAllow) => ({ mode, toolsAllow })),
  ),
])(
  "submits only the current $mode catalog after hook allowlist $toolsAllow",
  async ({ mode, toolsAllow }) => {
    const { fixture, runtime, surface, sourceTools, capabilityToolNames, attempt, prepared } =
      await promptFixture(false, mode);
    const { sessionRuntime } = fixture.input.prepared;
    sessionRuntime.state.systemPromptText = prepared.systemPromptText;
    sessionRuntime.agentSession.setActiveSessionSystemPrompt = (prompt) =>
      (sessionRuntime.state.systemPromptText = prompt);
    fixture.input.attempt = attempt;
    fixture.input.prepared.systemPrompt = prepared;
    fixture.input.prepared.toolCatalog.toolSearchRunPlan.capabilityToolNames = capabilityToolNames;
    let activeToolNames = surface.tools.map((tool) => tool.name);
    const definitions = toToolDefinitions(surface.tools);
    fixture.input.prepared.promptToolPolicy = createPromptBuildToolPolicy({
      session: {
        getActiveToolNames: () => activeToolNames,
        getToolDefinition: (name) => definitions.find((tool) => tool.name === name),
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
    mocks.preparePromptAssembly.mockImplementation(async (input) => {
      const callableToolNames = input.applyPromptBuildToolsAllow(toolsAllow);
      expect(callableToolNames.includes("fixture_allowed")).toBe(toolsAllow?.length !== 0);
      expect(callableToolNames.includes("fixture_denied")).toBe(toolsAllow === undefined);
      if (input.prepareSystemPrompt) {
        input.setActiveSessionSystemPrompt(
          await input.prepareSystemPrompt(sessionRuntime.state.systemPromptText),
        );
      }
      return createPromptAssemblyResult(input);
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
      expect(submittedPrompt).not.toContain("Call dispatch_action");
      expect(submittedPrompt).not.toContain("openclaw.tools.call");
      expect(submittedPrompt).not.toContain("Call a unique deferred tool name directly");
    }
  },
);
