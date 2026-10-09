import { beforeEach, describe, expect, it, vi } from "vitest";

const hostHookStateMocks = vi.hoisted(() => ({
  drainPluginNextTurnInjectionContext: vi.fn(),
}));

vi.mock("../../../plugins/host-hook-state.js", () => hostHookStateMocks);

import { createHookRunner } from "../../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-fixtures.js";
import {
  forgetPromptBuildDrainCacheForRun,
  mergeOrphanedTrailingUserPrompt,
  resolvePromptBuildHookResult,
} from "./attempt-prompt-helpers.js";
import { resolvePromptSubmissionSkipReason } from "./attempt-prompt-submit.js";

it("keeps structured media and JSON summaries on UTF-16 boundaries", () => {
  const result = mergeOrphanedTrailingUserPrompt({
    prompt: "Continue.",
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
});

// The embedded runner appends `appendContext` to the prompt verbatim
// (attempt-prompt-assembly.ts), so these assertions are assertions about the
// model-visible prompt for the embedded consumer.
describe("resolvePromptBuildHookResult drop marker", () => {
  const MARKER_OPEN = '<dropped_plugin_context hook="before_prompt_build">';
  const secret = "AUTH_TOKEN=sk-live-9f3c https://internal.example/v1/queue";

  function primeDrain() {
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockReset();
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValue({
      queuedInjections: [],
    });
  }

  it("marks a failed handler with a reason code and no error text", async () => {
    primeDrain();
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          pluginId: "leaky-plugin",
          handler: () => {
            throw new Error(`bd ready failed: ${secret}`);
          },
        },
        {
          hookName: "before_prompt_build",
          pluginId: "healthy-plugin",
          handler: () => ({ prependContext: "healthy" }),
        },
      ]),
    );

    const result = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx: { runId: "drop-marker-handler", sessionKey: "agent:main:main" },
      hookRunner: runner as never,
    });

    expect(result.prependContext).toBe("healthy");
    expect(result.appendContext).toContain(MARKER_OPEN);
    expect(result.appendContext).toContain("leaky-plugin (handler-failed)");
    expect(result.appendContext).not.toContain("sk-live-9f3c");
    expect(result.appendContext).not.toContain("internal.example");
    expect(result.appendContext).not.toContain("bd ready failed");
    forgetPromptBuildDrainCacheForRun("drop-marker-handler");
  });

  it("bounds the marker when many handlers fail", async () => {
    primeDrain();
    const runner = createHookRunner(
      createMockPluginRegistry(
        Array.from({ length: 30 }, (_unused, index) => ({
          hookName: "before_prompt_build",
          pluginId: `bulk-plugin-${index}`,
          handler: () => {
            throw new Error(`handler ${index} exploded`);
          },
        })),
      ),
    );

    const result = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx: { runId: "drop-marker-cap", sessionKey: "agent:main:main" },
      hookRunner: runner as never,
    });

    const marker = result.appendContext ?? "";
    expect(marker.match(/\(handler-failed\)/gu)).toHaveLength(5);
    expect(marker).toContain("+25 more");
    expect(new TextEncoder().encode(marker).length).toBeLessThanOrEqual(640);
    expect(marker).not.toContain("exploded");
    forgetPromptBuildDrainCacheForRun("drop-marker-cap");
  });

  it("marks a rejected dispatch without echoing the rejection", async () => {
    primeDrain();
    const result = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx: { runId: "drop-marker-dispatch", sessionKey: "agent:main:main" },
      hookRunner: {
        hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
        runBeforePromptBuild: vi.fn(async () => {
          throw new Error(`registry exploded: ${secret}`);
        }),
      },
    });

    expect(result.appendContext).toContain(MARKER_OPEN);
    expect(result.appendContext).toContain("unknown plugin (dispatch-failed)");
    expect(result.appendContext).not.toContain("registry exploded");
    expect(result.appendContext).not.toContain("sk-live-9f3c");
    forgetPromptBuildDrainCacheForRun("drop-marker-dispatch");
  });
});
