import { expect, it, onTestFinished, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../harness/tool-surface-bridge.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import { createEmptyPromptBootstrap } from "./attempt-system-prompt.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const { createFixture } = await vi.hoisted(
  async () => await import("./attempt-prompt-phase.test-support.js"),
);

async function preparePrompt(workerPlacement: boolean) {
  const config = { agents: { defaults: { experimental: { localModelLean: false } } } };
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
    "worker-placement-prompt-test",
  );
  onTestFinished(() => {
    admission.close();
    runtime.cleanup();
  });
  const sourceTools = [createStubTool("sessions_spawn")];
  const attempt = {
    ...fixture.input.attempt,
    admittedRunContext: await admission.admit("embedded"),
    config,
    prompt: "Start a child session.",
    sessionKey: "agent:main:worker-placement",
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
    remoteWorkspace: workerPlacement,
    workerPlacement,
    capabilityToolNames: new Set(sourceTools.map((tool) => tool.name)),
    effectiveTools: runtime.compactTools(sourceTools).tools,
    isRawModelRun: false,
    modelToolsEnabled: true,
    skillsPrompt: "",
    codeModeActive: false,
    toolSearchDirectoryEnabled: false,
    toolSearchRuntimeConfig: runtime.config,
  });
  return prepared.systemPromptText;
}

it("keeps the sessions_spawn delegation trigger for local and worker placements", async () => {
  // Placement-specific brief fields live in the spawn tool descriptions.
  for (const prompt of [await preparePrompt(false), await preparePrompt(true)]) {
    expect(prompt).toContain("delegate bounded independent work via `sessions_spawn`");
  }
});
