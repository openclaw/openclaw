import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import {
  runAgentHarnessAfterCompactionHook,
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
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "heartbeat", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(calls).toEqual(["heartbeat", "before_prompt_build"]);
    expect(result.prompt).toBe("heartbeat context\n\nprompt context\n\nhello");
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

  it("skips heartbeat_prompt_contribution for commitment-only heartbeat lifecycle turns", async () => {
    const heartbeatHandler = vi.fn(() => ({ prependContext: "global heartbeat context" }));
    const promptHandler = vi.fn(() => ({ prependContext: "turn policy" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "heartbeat_prompt_contribution", handler: heartbeatHandler },
        { hookName: "before_prompt_build", handler: promptHandler },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "due commitment",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "heartbeat", agentId: "agent-1", sessionKey: "session-1" },
      bootstrapContextRunKind: "commitment-only",
    });

    expect(heartbeatHandler).not.toHaveBeenCalled();
    expect(promptHandler).toHaveBeenCalledTimes(1);
    expect(result.prompt).toBe("turn policy\n\ndue commitment");
  });
});

describe("runAgentHarnessAfterCompactionHook", () => {
  it("does not expose resetSession for model-locked harness compactions", async () => {
    const deferResetSession = vi.fn();
    const afterCompaction = vi.fn((_event, ctx) => {
      expect(ctx.api).toBeUndefined();
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_compaction", handler: afterCompaction }]),
    );

    await runAgentHarnessAfterCompactionHook({
      sessionFile: "/tmp/session.jsonl",
      compactedCount: 1,
      ctx: {
        agentId: "agent-1",
        sessionKey: "session-1",
        modelSelectionLocked: true,
        deferEmbeddedHookSessionReset: deferResetSession,
      },
    });

    expect(afterCompaction).toHaveBeenCalledTimes(1);
    expect(deferResetSession).not.toHaveBeenCalled();
  });

  it("binds resetSession to the canonical reset key instead of the hook session key", async () => {
    const deferResetSession = vi.fn();
    const afterCompaction = vi.fn(async (_event, ctx) => {
      expect(ctx.sessionKey).toBe("agent:agent-1:sandbox:policy");
      await expect(ctx.api?.resetSession("new")).resolves.toMatchObject({
        ok: true,
        key: "agent:agent-1:discord:channel:123",
        deferred: true,
      });
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_compaction", handler: afterCompaction }]),
    );

    await runAgentHarnessAfterCompactionHook({
      sessionFile: "/tmp/session.jsonl",
      compactedCount: 1,
      ctx: {
        agentId: "agent-1",
        sessionKey: "agent:agent-1:sandbox:policy",
        resetSessionKey: "agent:agent-1:discord:channel:123",
        deferEmbeddedHookSessionReset: deferResetSession,
      },
    });

    expect(afterCompaction).toHaveBeenCalledTimes(1);
    expect(deferResetSession).toHaveBeenCalledWith({
      key: "agent:agent-1:discord:channel:123",
      agentId: "agent-1",
      reason: "new",
      commandSource: "embedded-agent:hook",
    });
  });

  it("does not expose resetSession without a caller-owned lifecycle queue", async () => {
    const afterCompaction = vi.fn((_event, ctx) => {
      expect(ctx.sessionKey).toBe("agent:agent-1:sandbox:policy");
      expect(ctx.api).toBeUndefined();
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_compaction", handler: afterCompaction }]),
    );

    await runAgentHarnessAfterCompactionHook({
      sessionFile: "/tmp/session.jsonl",
      compactedCount: 1,
      ctx: {
        agentId: "agent-1",
        sessionKey: "agent:agent-1:sandbox:policy",
        resetSessionKey: "agent:agent-1:discord:channel:123",
      },
    });

    expect(afterCompaction).toHaveBeenCalledTimes(1);
  });
});
