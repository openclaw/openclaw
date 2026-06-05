import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { MetaSkillCatalog } from "../../../skills/meta/catalog.js";
import type { MetaRunStore } from "../../../skills/meta/store.js";
import type { MetaPlan } from "../../../skills/meta/types.js";
import type { AgentToolResult } from "../../runtime/index.js";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  buildSoftMetaTriggerHint,
  dispatchDeterministicMetaTrigger,
} from "./meta-trigger-dispatch.js";

function plan(name: string, trigger: string): MetaPlan {
  return {
    name,
    description: `${name} description`,
    triggers: [{ pattern: trigger }],
    steps: [
      {
        id: "collect",
        kind: "user_input",
        dependsOn: [],
        onFailure: { kind: "fail" },
      },
    ],
    finalTextMode: { kind: "auto" },
  };
}

function metaInvokeTool(): AnyAgentTool {
  return {
    label: "Meta Invoke",
    name: "meta_invoke",
    description: "Run meta skill",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
  };
}

function textResult(text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: {},
  };
}

type MetaRunStoreMock = {
  [K in keyof MetaRunStore]: ReturnType<typeof vi.fn<MetaRunStore[K]>>;
};

function storeWithPendingPause(params: {
  skillName: string;
  schemaJson?: Record<string, unknown>;
}): MetaRunStoreMock {
  return {
    recordRunStarted: vi.fn(),
    recordRunCompleted: vi.fn(),
    recordStepFinished: vi.fn(),
    recordPause: vi.fn(),
    recordEvidence: vi.fn(),
    markPauseResumed: vi.fn(),
    readPendingPauseForSession: vi.fn<MetaRunStore["readPendingPauseForSession"]>(() => ({
      pauseId: "pause-1",
      runId: "run-paused",
      stepId: "ask",
      schemaJson: params.schemaJson ?? { type: "object", required: ["topic"] },
      prefillJson: null,
      confirmedFieldsJson: null,
      channelBindingJson: null,
      sessionKey: "session-1",
      status: "pending" as const,
      expiresAtMs: 2_000,
      createdAtMs: 1_000,
      resumedAtMs: null,
    })),
    readRun: vi.fn<MetaRunStore["readRun"]>(() => ({
      runId: "run-paused",
      skillName: params.skillName,
      skillKey: null,
      agentId: "main",
      sessionKey: "session-1",
      agentRunId: null,
      channelTargetJson: null,
      workspaceContextJson: null,
      status: "paused" as const,
      triggerJson: null,
      inputJson: {},
      originalInputSummary: null,
      finalMode: null,
      finalText: "paused",
      createdAtMs: 1_000,
      updatedAtMs: 1_100,
      completedAtMs: 1_100,
    })),
    listSteps: vi.fn<MetaRunStore["listSteps"]>(() => []),
    listEvidence: vi.fn<MetaRunStore["listEvidence"]>(() => []),
    listEvidenceByGate: vi.fn<MetaRunStore["listEvidenceByGate"]>(() => []),
  };
}

describe("dispatchDeterministicMetaTrigger", () => {
  it("builds soft trigger hints without shadowing unique deterministic triggers", () => {
    const createSkill = plan("meta-skill-creator", "create a skill");
    const slashSkill = plan("slash-skill", "/skill");
    const duplicate = plan("other-creator", "create a skill");
    const tools = [metaInvokeTool()];

    expect(
      buildSoftMetaTriggerHint({
        catalog: { plans: [slashSkill], diagnostics: [] },
        inputText: "/skill turn this into a reusable workflow",
        tools,
      }),
    ).toBeUndefined();

    const softHint = buildSoftMetaTriggerHint({
      catalog: { plans: [createSkill], diagnostics: [] },
      inputText: "please create a skill from this",
      tools,
    });
    expect(softHint).toContain("Meta skill trigger hint:");
    expect(softHint).toContain("meta-skill-creator");
    expect(softHint).toContain("match=soft");
    expect(softHint).toContain("call `meta_invoke`");

    const ambiguousHint = buildSoftMetaTriggerHint({
      catalog: { plans: [createSkill, duplicate], diagnostics: [] },
      inputText: "create a skill",
      tools,
    });
    expect(ambiguousHint).toContain("meta-skill-creator");
    expect(ambiguousHint).toContain("other-creator");
    expect(ambiguousHint).toContain("match=deterministic");

    expect(
      buildSoftMetaTriggerHint({
        catalog: { plans: [createSkill], diagnostics: [] },
        inputText: "please create a skill from this",
        tools: [],
      }),
    ).toBeUndefined();
  });

  it("runs a unique deterministic trigger through the authorized meta_invoke tool", async () => {
    const createSkill = plan("meta-skill-creator", "/skill");
    const executeMetaInvokeTool = vi.fn(async () => textResult("Meta created a proposal."));

    const result = await dispatchDeterministicMetaTrigger({
      catalog: {
        plans: [createSkill],
        diagnostics: [],
      } satisfies MetaSkillCatalog,
      inputText: "/skill turn this into a reusable workflow",
      tools: [metaInvokeTool()],
      toolCallId: "meta-trigger-run-1",
      assistant: {
        api: "chat",
        provider: "openai",
        model: "gpt-test",
      },
      nowMs: () => 123,
      executeMetaInvokeTool,
    });

    expect(executeMetaInvokeTool).toHaveBeenCalledWith({
      tool: expect.objectContaining({ name: "meta_invoke" }),
      toolCallId: "meta-trigger-run-1",
      args: {
        skill_name: "meta-skill-creator",
        input: {
          request: "/skill turn this into a reusable workflow",
        },
      },
    });
    expect(result).toMatchObject({
      match: {
        kind: "deterministic",
        trigger: "/skill",
        plan: createSkill,
      },
      finalText: "Meta created a proposal.",
      assistant: {
        role: "assistant",
        content: [{ type: "text", text: "Meta created a proposal." }],
        api: "chat",
        provider: "openai",
        model: "gpt-test",
        stopReason: "stop",
        timestamp: 123,
      },
    });
    expect(result?.assistant.usage.totalTokens).toBe(0);
  });

  it("resumes pending meta pauses before matching a new deterministic trigger", async () => {
    const pausedSkill = plan("clarify", "/clarify");
    const newTriggerSkill = plan("meta-skill-creator", "/skill");
    const store = storeWithPendingPause({
      skillName: "clarify",
      schemaJson: {
        type: "object",
        additionalProperties: false,
        required: ["topic"],
        properties: {
          topic: { type: "string" },
        },
      },
    });
    const executeMetaInvokeTool = vi.fn(async () => textResult("Resumed paused meta run."));

    const result = await dispatchDeterministicMetaTrigger({
      catalog: {
        plans: [pausedSkill, newTriggerSkill],
        diagnostics: [],
      } satisfies MetaSkillCatalog,
      inputText: "/skill SQLite migrations",
      tools: [metaInvokeTool()],
      toolCallId: "meta-trigger-run-pause",
      assistant: {
        api: "chat",
        provider: "openai",
        model: "gpt-test",
      },
      pendingPause: {
        store,
        sessionKey: "session-1",
      },
      nowMs: () => 1_500,
      executeMetaInvokeTool,
    });

    expect(store.readPendingPauseForSession).toHaveBeenCalledWith("session-1", 1_500);
    expect(executeMetaInvokeTool).toHaveBeenCalledWith({
      tool: expect.objectContaining({ name: "meta_invoke" }),
      toolCallId: "meta-trigger-run-pause",
      args: {
        skill_name: "clarify",
        input: {
          topic: "/skill SQLite migrations",
        },
      },
    });
    expect(result).toMatchObject({
      resumedPause: {
        pauseId: "pause-1",
        runId: "run-paused",
        skillName: "clarify",
      },
      finalText: "Resumed paused meta run.",
      assistant: {
        content: [{ type: "text", text: "Resumed paused meta run." }],
        timestamp: 1_500,
      },
    });
    expect(result?.match).toBeUndefined();
  });

  it("does not run soft, ambiguous, or unavailable meta_invoke matches", async () => {
    const createSkill = plan("meta-skill-creator", "create a skill");
    const duplicate = plan("other-creator", "create a skill");
    const executeMetaInvokeTool = vi.fn(async () => textResult("should not run"));

    await expect(
      dispatchDeterministicMetaTrigger({
        catalog: { plans: [createSkill], diagnostics: [] },
        inputText: "please create a skill from this",
        tools: [metaInvokeTool()],
        toolCallId: "meta-trigger-run-2",
        assistant: { api: "chat", provider: "openai", model: "gpt-test" },
        executeMetaInvokeTool,
      }),
    ).resolves.toBeUndefined();

    await expect(
      dispatchDeterministicMetaTrigger({
        catalog: { plans: [createSkill, duplicate], diagnostics: [] },
        inputText: "create a skill",
        tools: [metaInvokeTool()],
        toolCallId: "meta-trigger-run-3",
        assistant: { api: "chat", provider: "openai", model: "gpt-test" },
        executeMetaInvokeTool,
      }),
    ).resolves.toBeUndefined();

    await expect(
      dispatchDeterministicMetaTrigger({
        catalog: { plans: [createSkill], diagnostics: [] },
        inputText: "create a skill",
        tools: [],
        toolCallId: "meta-trigger-run-4",
        assistant: { api: "chat", provider: "openai", model: "gpt-test" },
        executeMetaInvokeTool,
      }),
    ).resolves.toBeUndefined();

    expect(executeMetaInvokeTool).not.toHaveBeenCalled();
  });
});
