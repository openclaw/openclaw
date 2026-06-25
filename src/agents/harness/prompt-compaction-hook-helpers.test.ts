import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import {
  forgetHarnessPromptBuildDrainCacheForRun,
  resolveAgentHarnessBeforePromptBuildResult,
} from "./prompt-compaction-hook-helpers.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("resolveAgentHarnessBeforePromptBuildResult", () => {
  it("retains an empty prompt range without hooks", async () => {
    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "",
      developerInstructions: "base instructions",
      messages: [],
      ctx: {},
    });

    expect(result).toEqual({
      prompt: "",
      developerInstructions: "base instructions",
      promptInputRange: { start: 0, end: 0 },
    });
  });

  it("uses precomputed agent-start context without a global hook runner", async () => {
    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: {
        agentId: "agent-1",
        sessionKey: "session-1",
        workspaceDir: "/workspace",
      },
      beforeAgentStartResult: {
        prependContext: "cached context",
        systemPrompt: "cached instructions",
      },
    });

    expect(result).toEqual({
      prompt: "cached context\n\nhello",
      developerInstructions: "cached instructions",
      promptInputRange: { start: 16, end: 21 },
    });
  });

  it("keeps an empty input range between prepended and appended context", async () => {
    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "",
      developerInstructions: "base instructions",
      messages: [],
      ctx: {},
      beforeAgentStartResult: {
        appendContext: "appended context",
        prependContext: "prepended context",
      },
    });

    expect(result).toEqual({
      prompt: "prepended context\n\nappended context",
      developerInstructions: "base instructions",
      promptInputRange: { start: 17, end: 17 },
    });
  });

  it("runs heartbeat_prompt_contribution on a heartbeat turn and prepends its contribution", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "heartbeat_prompt_contribution",
          handler: () => ({ prependContext: "Run the base-heartbeat skill." }),
        },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "Read HEARTBEAT.md.",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "heartbeat", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(result.prompt).toBe("Run the base-heartbeat skill.\n\nRead HEARTBEAT.md.");
    // The heartbeat contribution affects only the prompt, not developer instructions.
    expect(result.developerInstructions).toBe("base instructions");
  });

  it("runs heartbeat contributions before other prompt-build hooks", async () => {
    const calls: string[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "heartbeat_prompt_contribution",
          handler: () => {
            calls.push("heartbeat");
            return { prependContext: "heartbeat context" };
          },
        },
        {
          hookName: "before_prompt_build",
          handler: () => {
            calls.push("before_prompt_build");
            return { prependContext: "prompt context" };
          },
        },
        {
          hookName: "before_agent_start",
          handler: () => {
            calls.push("before_agent_start");
            return { prependContext: "agent-start context" };
          },
        },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "heartbeat", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(calls).toEqual(["heartbeat", "before_prompt_build", "before_agent_start"]);
    expect(result.prompt).toBe(
      "heartbeat context\n\nprompt context\n\nagent-start context\n\nhello",
    );
  });

  it("skips heartbeat_prompt_contribution off a heartbeat turn", async () => {
    const handler = vi.fn(() => ({ prependContext: "should not appear" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "heartbeat_prompt_contribution", handler }]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "user", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.prompt).toBe("hello");
  });

  it("runs agent_turn_prepare hook and prepends its contribution", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "agent_turn_prepare",
          handler: () => ({ prependContext: "prepare context" }),
        },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "test",
      developerInstructions: "base",
      messages: [],
      ctx: { agentId: "a", sessionKey: "s" },
    });

    expect(result.prompt).toBe("prepare context\n\ntest");
  });

  it("runs agent_turn_prepare before heartbeat contributions in hook ordering", async () => {
    const calls: string[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "agent_turn_prepare",
          handler: () => {
            calls.push("agent_turn_prepare");
            return { prependContext: "prepare" };
          },
        },
        {
          hookName: "heartbeat_prompt_contribution",
          handler: () => {
            calls.push("heartbeat");
            return { prependContext: "heartbeat" };
          },
        },
      ]),
    );

    await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "test",
      developerInstructions: "base",
      messages: [],
      ctx: { trigger: "heartbeat", agentId: "a", sessionKey: "s" },
    });

    expect(calls).toEqual(["agent_turn_prepare", "heartbeat"]);
  });

  it("skips agent_turn_prepare when no hooks are registered", async () => {
    const handler = vi.fn(() => ({ prependContext: "should not appear" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_prompt_build", handler }]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "test",
      developerInstructions: "base",
      messages: [],
      ctx: { agentId: "a", sessionKey: "s" },
    });

    expect(result.prompt).toBe("should not appear\n\ntest");
  });
});

describe("forgetHarnessPromptBuildDrainCacheForRun", () => {
  it("is a no-op when runId is undefined", () => {
    expect(() => forgetHarnessPromptBuildDrainCacheForRun(undefined)).not.toThrow();
  });

  it("is a no-op when runId is an empty string", () => {
    expect(() => forgetHarnessPromptBuildDrainCacheForRun("")).not.toThrow();
  });
});
