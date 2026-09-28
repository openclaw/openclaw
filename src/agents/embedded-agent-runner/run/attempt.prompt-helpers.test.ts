import { beforeEach, describe, expect, it, vi } from "vitest";

const hostHookStateMocks = vi.hoisted(() => ({
  drainPluginNextTurnInjectionContext: vi.fn(),
}));

vi.mock("../../../plugins/host-hook-state.js", () => hostHookStateMocks);

import {
  forgetPromptBuildDrainCacheForRun,
  mergeOrphanedTrailingUserPrompt,
  resolvePromptBuildHookResult,
} from "./attempt-prompt-helpers.js";
import { resolvePromptSubmissionSkipReason } from "./attempt-prompt-submit.js";

it("keeps structured media and JSON summaries on UTF-16 boundaries", () => {
  const result = mergeOrphanedTrailingUserPrompt({
    prompt: "Continue.",
    trigger: "user",
    leafMessage: {
      content: [
        { type: "image_url", image_url: { url: `${"u".repeat(299)}😀tail` } },
        { type: "custom", value: `${"v".repeat(299)}😀tail` },
        { [`${"k".repeat(997)}😀tail`]: 1 },
      ],
    },
  });
  expect(result.merged).toBe(true);
  expect(result.prompt.isWellFormed()).toBe(true);
  expect(result.prompt).not.toContain("\\ud83d");
  expect(result.prompt).toContain("[image_url]");
  expect(result.prompt).toContain("chars)");
});

describe("resolvePromptSubmissionSkipReason", () => {
  const skip = (messages: unknown[] = [], prompt = "   ", imageCount = 0) =>
    resolvePromptSubmissionSkipReason({ prompt, messages, imageCount });

  it("treats runtime messages and empty conversation placeholders as empty history", () => {
    expect(
      skip([
        { role: "system", content: "runtime-only policy" },
        { role: "toolResult", content: "old tool output", toolCallId: "call-1" },
        { role: "user", content: "   " },
        { role: "assistant", content: [] },
      ]),
    ).toBe("empty_prompt_history_images");
  });

  it("skips a blank current prompt even with visible replay history", () => {
    expect(skip([{ role: "user", content: "previous turn", timestamp: 1 }])).toBe(
      "blank_user_prompt",
    );
  });

  it("admits current text or images without replay history", () => {
    expect(skip([], "hello")).toBeNull();
    expect(skip([], "   ", 1)).toBeNull();
  });
});

describe("resolvePromptBuildHookResult drain cache", () => {
  beforeEach(() => {
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockReset();
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValue({
      queuedInjections: [],
    });
  });

  function build(runId?: string) {
    return resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx: { runId, sessionKey: "global", agentId: "qa" },
    });
  }

  it("preserves an explicit empty per-turn tool allowlist", async () => {
    const runBeforePromptBuild = vi.fn(async () => ({ toolsAllow: [] }));
    const result = await resolvePromptBuildHookResult({
      config: {},
      prompt: "answer without tools",
      messages: [],
      hookCtx: { sessionKey: "agent:main:main" },
      hookRunner: {
        hasHooks: (hookName) => hookName === "before_prompt_build",
        runBeforePromptBuild,
      },
    });
    expect(result.toolsAllow).toEqual([]);
    expect(runBeforePromptBuild).toHaveBeenCalledOnce();
  });

  it("reuses drained injections across retries and releases them when the run ends", async () => {
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValue({
      queuedInjections: [
        {
          id: "inj-1",
          pluginId: "demo",
          text: "first attempt context",
          placement: "prepend_context",
          createdAt: 1,
        },
      ],
      prependContext: "first attempt context",
    });
    const runId = "run-cache-test";
    expect((await build(runId)).prependContext).toBe("first attempt context");
    expect((await build(runId)).prependContext).toBe("first attempt context");
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(1);
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledWith({
      cfg: {},
      sessionKey: "global",
      agentId: "qa",
    });
    forgetPromptBuildDrainCacheForRun(runId);
    await build(runId);
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(2);
    forgetPromptBuildDrainCacheForRun(runId);
  });

  it("drains every call without a run identity", async () => {
    await build();
    await build();
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(2);
  });
});
