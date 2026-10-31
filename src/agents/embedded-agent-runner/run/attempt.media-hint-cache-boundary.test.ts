// #85203: exercise production assembly so live media facts cannot rewrite history's prefix.
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  splitSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import * as mediaTaskStatus from "../../media-generation-task-status.js";
import { forgetPromptBuildDrainCacheForRun } from "../../plugin-turn-context.js";
import { testModel } from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import {
  prepareEmbeddedAttemptPromptAssembly,
  prepareEmbeddedAttemptPromptContext,
} from "./attempt-prompt-build.js";

vi.mock("../../../plugins/host-hook-state.js", () => ({
  drainPluginNextTurnInjectionContext: vi.fn(async () => ({ queuedInjections: [] })),
}));

const HOOK = "Static plugin guidance";
const BASE = `Stable workspace prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic channel guidance`;
const OVERRIDE = "Custom hook system prompt without a cache boundary";

it("#85203 keeps static hooks and model identity stable with a marker-free hook override", async () => {
  onTestFinished(() => {
    vi.restoreAllMocks();
    clearRuntimeConfigSnapshot();
  });
  vi.spyOn(mediaTaskStatus, "buildMediaTaskRuntimeContext").mockResolvedValue(undefined);
  const config = {};
  setRuntimeConfigSnapshot(config);
  const runId = "media-cache-override";
  const admission = prepareSystemAgentRunAdmission(config, runId, "main", "media-cache-test");
  onTestFinished(() => {
    admission.close();
    forgetPromptBuildDrainCacheForRun(runId);
  });
  const attempt: Parameters<typeof prepareEmbeddedAttemptPromptAssembly>[0]["attempt"] = {
    admittedRunContext: await admission.admit("embedded"),
    config,
    model: testModel,
    provider: testModel.provider,
    prompt: "How is the image progressing?",
    runId,
    sessionId: runId,
    sessionKey: `agent:main:${runId}`,
    trigger: "user",
    workspaceDir: "/tmp/media-cache-test",
  };
  const hookRunner = createHookRunner({
    hooks: [],
    plugins: [],
    typedHooks: [
      {
        pluginId: "cache-test",
        hookName: "before_prompt_build",
        source: "test",
        handler: async () => ({ systemPrompt: OVERRIDE, prependSystemContext: HOOK }),
      },
    ],
  });
  const common = { attempt, isRawModelRun: false, sessionAgentId: "main" };
  async function prepareTurn(progress?: string) {
    vi.mocked(mediaTaskStatus.buildMediaTaskRuntimeContext).mockResolvedValue(
      progress
        ? `## Media Generation Tasks\n- tool=image_generate; task=task-1; status=running; progress_json="${progress}"`
        : "## Media Generation Tasks\n- tool=image_generate; none",
    );
    let systemPromptText = BASE;
    const prompt = await prepareEmbeddedAttemptPromptAssembly({
      ...common,
      activeSession: { messages: [] },
      sessionManager: { getLeafId: () => null },
      hookRunner,
      hookAgentId: "main",
      diagnosticTrace: { traceId: "11111111111111111111111111111111" },
      runtimeModel: testModel.id,
      systemPromptText,
      hasBaselineTools: () => true,
      applyPromptBuildToolsAllow: () => ["image_generate"],
      setActiveSessionSystemPrompt: (next) => {
        systemPromptText = next;
      },
    });
    return prepareEmbeddedAttemptPromptContext({
      ...common,
      capabilityToolNames: new Set(["image_generate"]),
      messages: [],
      prompt,
      replaceSessionMessages: () => {},
      includeBoundaryTimestamp: false,
      systemPromptText,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
    });
  }
  const rendering = await prepareTurn("Rendering image");
  const encoding = await prepareTurn("Encoding image");
  const idle = await prepareTurn();

  expect(encoding.systemPromptForHook).toBe(rendering.systemPromptForHook);
  expect(idle.systemPromptForHook).toBe(rendering.systemPromptForHook);
  expect(
    [rendering, encoding, idle].map((turn) => turn.runtimeContextMessageForCurrentTurn?.content),
  ).toEqual([
    expect.stringContaining('progress_json="Rendering image"'),
    expect.stringContaining('progress_json="Encoding image"'),
    expect.stringContaining("tool=image_generate; none"),
  ]);
  expect(rendering.systemPromptForHook).not.toContain("task=task-1");

  const split = splitSystemPromptCacheBoundary(idle.systemPromptForHook);
  expect(split).toBeDefined();
  expect(split?.stablePrefix).toContain(HOOK);
  expect(split?.stablePrefix).toContain(OVERRIDE);
  expect(split?.stablePrefix).not.toContain("Current model identity:");
  expect(split?.dynamicSuffix).toContain("Current model identity:");
});
