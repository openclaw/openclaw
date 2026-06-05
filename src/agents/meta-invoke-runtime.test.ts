import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Model } from "../llm/types.js";
import type { MetaRunStore } from "../skills/meta/store.js";
import type { MetaPlan } from "../skills/meta/types.js";
import type { SkillSnapshot } from "../skills/types.js";
import { markCodeModeControlTool } from "./code-mode-control-tools.js";
import {
  createAgentMetaInvokePlanRunner,
  filterMetaInvokeTargetTools,
  type MetaInvokeLlmCompletionOptions,
  type MetaInvokeToolExecutor,
  type MetaInvokeToolExecutorRef,
  type MetaInvokeToolRef,
} from "./meta-invoke-runtime.js";
import type { AnyAgentTool } from "./tools/common.js";
import { textResult } from "./tools/common.js";

function tool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute,
  };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function erroredAssistantMessage(errorMessage: string): AssistantMessage {
  return {
    ...assistantMessage(""),
    content: [],
    stopReason: "error",
    errorMessage,
  };
}

function createLlmCompletion(overrides?: Partial<MetaInvokeLlmCompletionOptions>) {
  const model = {
    provider: "openai",
    id: "gpt-5.5",
    name: "gpt-5.5",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  } satisfies Model<"openai-responses">;
  const prepareSimpleCompletionModelForAgent = vi.fn(async () => ({
    selection: {
      provider: "openai",
      modelId: "gpt-5.5",
      agentDir: "/tmp/openclaw-agent",
    },
    model,
    auth: {
      apiKey: "sk-test",
      source: "test",
      mode: "api-key" as const,
    },
  })) as unknown as NonNullable<
    MetaInvokeLlmCompletionOptions["prepareSimpleCompletionModelForAgent"]
  >;
  const completeWithPreparedSimpleCompletionModel = vi.fn(async () =>
    assistantMessage("drafted text"),
  ) as unknown as NonNullable<
    MetaInvokeLlmCompletionOptions["completeWithPreparedSimpleCompletionModel"]
  >;

  return {
    config: {},
    agentId: "main",
    prepareSimpleCompletionModelForAgent,
    completeWithPreparedSimpleCompletionModel,
    ...overrides,
  } satisfies MetaInvokeLlmCompletionOptions;
}

type MetaRunStoreMock = {
  [K in keyof MetaRunStore]: ReturnType<typeof vi.fn<MetaRunStore[K]>>;
};

function createStoreMock(): MetaRunStoreMock {
  return {
    recordRunStarted: vi.fn(),
    recordRunCompleted: vi.fn(),
    recordStepFinished: vi.fn(),
    recordPause: vi.fn(),
    recordEvidence: vi.fn(),
    markPauseResumed: vi.fn(),
    readRun: vi.fn<MetaRunStore["readRun"]>(() => null),
    listSteps: vi.fn<MetaRunStore["listSteps"]>(() => []),
    readPendingPauseForSession: vi.fn<MetaRunStore["readPendingPauseForSession"]>(() => null),
    listEvidence: vi.fn<MetaRunStore["listEvidence"]>(() => []),
    listEvidenceByGate: vi.fn<MetaRunStore["listEvidenceByGate"]>(() => []),
  };
}

describe("createAgentMetaInvokePlanRunner", () => {
  it("stores only visible text and safe metadata from generic tool_call results", async () => {
    const execute = vi.fn(async () => {
      throw new Error("direct execute should not run");
    });
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("read", execute)],
    };
    const executeTool = vi.fn(async () =>
      textResult("read contents", {
        status: "ok",
        token: "sk-private-token",
        nested: { secret: "hidden diagnostic" },
      }),
    );
    const toolExecutorRef: MetaInvokeToolExecutorRef = {
      current: executeTool,
    };
    const plan = {
      name: "read_note",
      description: "Read a note",
      triggers: [],
      steps: [
        {
          id: "read",
          kind: "tool_call",
          dependsOn: [],
          toolName: "read",
          args: {
            path: "{{input.path}}",
          },
          onFailure: { kind: "fail" },
        },
        {
          id: "echo",
          kind: "tool_call",
          dependsOn: ["read"],
          toolName: "read",
          args: {
            token: "{{read.result.details.token}}",
            status: "{{read.result.details.status}}",
            text: "{{read.text}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "raw" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({ toolsRef, toolExecutorRef })({
      plan,
      parentToolCallId: "meta-call-1",
      input: {
        path: "notes.txt",
      },
    });
    const readOutput = result.outputs.read;

    expect(execute).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledWith({
      tool: toolsRef.current[0],
      toolName: "read",
      toolCallId: "meta-meta-call-1-1-read",
      parentToolCallId: "meta-call-1",
      input: { path: "notes.txt" },
      signal: undefined,
      onUpdate: undefined,
    });
    expect(executeTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: {
          token: "",
          status: "",
          text: "read contents",
        },
      }),
    );
    expect(readOutput).toEqual({
      text: "read contents",
      result: {
        text: "read contents",
      },
      toolName: "read",
    });
    expect(result.finalText).not.toContain("sk-private-token");
    expect(result.finalText).not.toContain("hidden diagnostic");
    expect(JSON.stringify(result.outputs)).not.toContain("sk-private-token");
    expect(JSON.stringify(result.outputs)).not.toContain("hidden diagnostic");
  });

  it("fails tool_call steps when the lifecycle executor is unavailable", async () => {
    const execute = vi.fn(async () => textResult("read contents", {}));
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("read", execute)],
    };
    const plan = {
      name: "read_note",
      description: "Read a note",
      triggers: [],
      steps: [
        {
          id: "read",
          kind: "tool_call",
          dependsOn: [],
          toolName: "read",
          args: {
            path: "{{input.path}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "read" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({ toolsRef })({
      plan,
      parentToolCallId: "meta-call-1",
      input: {
        path: "notes.txt",
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("tool_call executor unavailable for this run");
  });

  it("fails tool_call steps when the target tool is unavailable", async () => {
    const toolsRef: MetaInvokeToolRef = { current: [] };
    const plan = {
      name: "missing_tool",
      description: "Missing tool",
      triggers: [],
      steps: [
        {
          id: "read",
          kind: "tool_call",
          dependsOn: [],
          toolName: "read",
          args: {
            path: "{{input.path}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "auto" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({ toolsRef })({
      plan,
      input: {
        path: "notes.txt",
      },
    });

    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("tool_call target tool not available: read");
  });

  it("fails tool_call steps when the final target tool ref excludes the target", async () => {
    const execute = vi.fn(async () => textResult("secret", { status: "ok" }));
    const toolsRef: MetaInvokeToolRef = { current: [] };
    const plan = {
      name: "read_note",
      description: "Read a note",
      triggers: [],
      steps: [
        {
          id: "read",
          kind: "tool_call",
          dependsOn: [],
          toolName: "read",
          args: {
            path: "{{input.path}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "read" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef,
      toolExecutorRef: { current: execute },
    })({
      plan,
      input: {
        path: "notes.txt",
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("tool_call target tool not available: read");
  });

  it("allows plugin-group targets that are present in the final target tool ref", async () => {
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("plugin_memory", vi.fn())],
    };
    const executeTool = vi.fn(async () => textResult("plugin output", { status: "ok" }));
    const plan = {
      name: "plugin_plan",
      description: "Run plugin tool",
      triggers: [],
      steps: [
        {
          id: "plugin",
          kind: "tool_call",
          dependsOn: [],
          toolName: "plugin_memory",
          args: {
            query: "{{input.query}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "plugin" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef,
      toolExecutorRef: { current: executeTool },
    })({
      plan,
      parentToolCallId: "meta-call-plugin",
      input: {
        query: "notes",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(executeTool).toHaveBeenCalledWith({
      tool: toolsRef.current[0],
      toolName: "plugin_memory",
      toolCallId: "meta-meta-call-plugin-1-plugin",
      parentToolCallId: "meta-call-plugin",
      input: { query: "notes" },
      signal: undefined,
      onUpdate: undefined,
    });
  });

  it("generates unique child tool call ids for repeated meta invocations", async () => {
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("read", vi.fn())],
    };
    const executeTool = vi.fn<MetaInvokeToolExecutor>(async () =>
      textResult("read contents", { status: "ok" }),
    );
    const runner = createAgentMetaInvokePlanRunner({
      toolsRef,
      toolExecutorRef: { current: executeTool },
    });
    const plan = {
      name: "read_note",
      description: "Read a note",
      triggers: [],
      steps: [
        {
          id: "read",
          kind: "tool_call",
          dependsOn: [],
          toolName: "read",
          args: {
            path: "{{input.path}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "read" },
    } satisfies MetaPlan;

    await runner({
      plan,
      parentToolCallId: "meta-call-1",
      input: {
        path: "one.txt",
      },
    });
    await runner({
      plan,
      parentToolCallId: "meta-call-2",
      input: {
        path: "two.txt",
      },
    });

    expect(executeTool.mock.calls.map(([params]) => params.toolCallId)).toEqual([
      "meta-meta-call-1-1-read",
      "meta-meta-call-2-2-read",
    ]);
  });

  it("runs llm_chat steps through the agent simple completion runtime", async () => {
    const llmCompletion = createLlmCompletion();
    const plan = {
      name: "draft_reply",
      description: "Draft a reply",
      triggers: [],
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft a reply to {{input.topic}}.",
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "draft" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef: { current: [] },
      llmCompletion,
    })({
      plan,
      input: { topic: "SQLite" },
    });

    expect(llmCompletion.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith({
      cfg: llmCompletion.config,
      agentId: "main",
      modelRef: undefined,
      preferredProfile: undefined,
    });
    expect(llmCompletion.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: llmCompletion.config,
        context: {
          messages: [
            {
              role: "user",
              content: "Draft a reply to SQLite.",
              timestamp: expect.any(Number),
            },
          ],
        },
        options: {
          signal: undefined,
        },
      }),
    );
    expect(result).toMatchObject({
      status: "succeeded",
      finalText: "drafted text",
      outputs: {
        draft: {
          text: "drafted text",
          provider: "openai",
          model: "gpt-5.5",
          stopReason: "stop",
        },
      },
    });
  });

  it("surfaces provider errors from llm_chat steps", async () => {
    const llmCompletion = createLlmCompletion({
      completeWithPreparedSimpleCompletionModel: vi.fn(async () =>
        erroredAssistantMessage("OpenRouter API error (402): Insufficient credits"),
      ),
    });
    const plan = {
      name: "draft_reply",
      description: "Draft a reply",
      triggers: [],
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft a reply.",
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "draft" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef: { current: [] },
      llmCompletion,
    })({
      plan,
      input: {},
    });

    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("OpenRouter API error (402): Insufficient credits");
    expect(result.finalText).not.toContain("LLM meta step returned no text output");
  });

  it("classifies llm_classify responses against declared choices", async () => {
    const llmCompletion = createLlmCompletion({
      completeWithPreparedSimpleCompletionModel: vi.fn(async () => assistantMessage("High")),
    });
    const plan = {
      name: "classify_risk",
      description: "Classify risk",
      triggers: [],
      steps: [
        {
          id: "risk",
          kind: "llm_classify",
          dependsOn: [],
          prompt: "Classify this change.",
          choices: ["low", "medium", "high"],
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "risk" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef: { current: [] },
      llmCompletion,
    })({
      plan,
      input: {},
    });

    expect(result).toMatchObject({
      status: "succeeded",
      outputs: {
        risk: {
          text: "High",
          choice: "high",
        },
      },
    });
  });

  it("runs skill_exec steps through loaded skill instructions and the agent model runtime", async () => {
    const llmCompletion = createLlmCompletion({
      completeWithPreparedSimpleCompletionModel: vi.fn(async () =>
        assistantMessage("checked with skill instructions"),
      ),
    });
    const skillsSnapshot = {
      prompt: "",
      skills: [{ name: "review-helper" }],
      resolvedSkills: [
        {
          name: "review-helper",
          description: "Review code changes",
          filePath: "/workspace/skills/review-helper/SKILL.md",
          baseDir: "/workspace/skills/review-helper",
          sourceInfo: {
            path: "/workspace/skills/review-helper/SKILL.md",
            source: "workspace",
            scope: "project",
            origin: "top-level",
            baseDir: "/workspace/skills/review-helper",
          },
          disableModelInvocation: false,
          source: "# Review Helper\n\nCheck changed behavior and tests.",
        },
      ],
    } satisfies SkillSnapshot;
    const plan = {
      name: "run_review_skill",
      description: "Run a review skill",
      triggers: [],
      steps: [
        {
          id: "review",
          kind: "skill_exec",
          dependsOn: [],
          skillName: "review-helper",
          prompt: "Review {{input.file}}",
          args: { file: "{{input.file}}" },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "review" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef: { current: [] },
      llmCompletion,
      skillsSnapshot,
    })({
      plan,
      input: { file: "src/example.ts" },
    });

    expect(llmCompletion.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          messages: [
            expect.objectContaining({
              role: "user",
              content: expect.stringContaining('Execute the OpenClaw skill "review-helper".'),
            }),
          ],
        },
      }),
    );
    const prompt = vi.mocked(llmCompletion.completeWithPreparedSimpleCompletionModel).mock
      .calls[0]?.[0].context.messages[0]?.content;
    expect(prompt).toContain("Check changed behavior and tests.");
    expect(prompt).toContain("Review src/example.ts");
    expect(prompt).toContain('"file": "src/example.ts"');
    expect(result).toMatchObject({
      status: "succeeded",
      finalText: "checked with skill instructions",
      outputs: {
        review: {
          text: "checked with skill instructions",
          skillName: "review-helper",
          skillFilePath: "/workspace/skills/review-helper/SKILL.md",
        },
      },
    });
  });

  it("fails skill_exec when the target skill is unavailable", async () => {
    const plan = {
      name: "missing_skill",
      description: "Missing skill",
      triggers: [],
      steps: [
        {
          id: "missing",
          kind: "skill_exec",
          dependsOn: [],
          skillName: "missing-helper",
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "missing" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef: { current: [] },
      llmCompletion: createLlmCompletion(),
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "other-helper" }],
        resolvedSkills: [
          {
            name: "other-helper",
            description: "Other helper",
            filePath: "/workspace/skills/other-helper/SKILL.md",
            baseDir: "/workspace/skills/other-helper",
            sourceInfo: {
              path: "/workspace/skills/other-helper/SKILL.md",
              source: "workspace",
              scope: "project",
              origin: "top-level",
              baseDir: "/workspace/skills/other-helper",
            },
            disableModelInvocation: false,
            source: "# Other Helper\n",
          },
        ],
      },
    })({
      plan,
      input: {},
    });

    expect(result).toMatchObject({
      status: "failed",
      finalText:
        'Meta step "missing" failed: skill_exec target skill not available: missing-helper',
    });
  });

  it("runs agent steps through the injected nested agent runner", async () => {
    const runAgentStep = vi.fn(async () => "nested reply");
    const plan = {
      name: "ask_agent",
      description: "Ask another agent",
      triggers: [],
      steps: [
        {
          id: "ask",
          kind: "agent",
          dependsOn: [],
          prompt: "Summarize {{input.topic}}",
          args: {
            sessionKey: "agent:reviewer:main",
            timeoutMs: 12_000,
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "ask" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef: { current: [] },
      agentStep: {
        sourceSessionKey: "agent:main:main",
        sourceChannel: "internal",
        runAgentStep,
      },
    })({
      plan,
      input: { topic: "meta skills" },
    });

    expect(runAgentStep).toHaveBeenCalledWith({
      sessionKey: "agent:reviewer:main",
      message: "Summarize meta skills",
      extraSystemPrompt: "",
      timeoutMs: 12_000,
      channel: undefined,
      lane: undefined,
      transcriptMessage: undefined,
      sourceSessionKey: "agent:main:main",
      sourceChannel: "internal",
      sourceTool: "meta_invoke",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      finalText: "nested reply",
      outputs: {
        ask: {
          text: "nested reply",
          sessionKey: "agent:reviewer:main",
        },
      },
    });
  });

  it("persists default user_input meta runs through the meta run store", async () => {
    const store = createStoreMock();
    const plan = {
      name: "clarify",
      description: "Collect missing details",
      triggers: [],
      steps: [
        {
          id: "ask",
          kind: "user_input",
          dependsOn: [],
          schema: { type: "object", required: ["topic"] },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "ask" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef: { current: [] },
      persistence: {
        store,
        agentId: "agent-main",
        sessionKey: "session-1",
        agentRunId: "agent-run-1",
        channelTargetJson: { provider: "telegram", to: "chat-1" },
        workspaceContextJson: { workspaceDir: "/workspace/openclaw" },
        triggerJson: { trigger: "manual" },
        channelBindingJson: { provider: "telegram", to: "chat-1" },
      },
    })({
      plan,
      input: {},
    });

    expect(result.status).toBe("paused");
    expect(store.recordRunStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        skillName: "clarify",
        agentId: "agent-main",
        sessionKey: "session-1",
        agentRunId: "agent-run-1",
        channelTargetJson: { provider: "telegram", to: "chat-1" },
        workspaceContextJson: { workspaceDir: "/workspace/openclaw" },
        triggerJson: { trigger: "manual" },
      }),
    );
    const runId = store.recordRunStarted.mock.calls[0]?.[0].runId;
    expect(store.recordStepFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        stepId: "ask",
        kind: "user_input",
        status: "paused",
      }),
    );
    expect(store.recordPause).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        pauseId: expect.stringMatching(/^pause-/),
        stepId: "ask",
        schemaJson: { type: "object", required: ["topic"] },
        sessionKey: "session-1",
        channelBindingJson: { provider: "telegram", to: "chat-1" },
      }),
    );
    expect(store.recordRunCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        status: "paused",
        finalText: expect.stringContaining("paused"),
      }),
    );
  });

  it("records Skill Workshop scan gate evidence for persisted tool_call proposals", async () => {
    const store = createStoreMock();
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("skill_workshop", vi.fn())],
    };
    const executeTool = vi.fn<MetaInvokeToolExecutor>(async () =>
      textResult("Created skill proposal proposal-1.", {
        id: "proposal-1",
        status: "pending",
        kind: "create",
        skillName: "demo skill",
        skillKey: "demo-skill",
        scanState: "clean",
        token: "sk-workshop-private",
      }),
    );
    const plan = {
      name: "meta-skill-creator",
      description: "Create a skill proposal",
      triggers: [],
      steps: [
        {
          id: "proposal",
          kind: "tool_call",
          dependsOn: [],
          toolName: "skill_workshop",
          args: {
            action: "create",
            name: "{{input.name}}",
            description: "{{input.description}}",
            proposal_content: "{{input.content}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "proposal" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef,
      toolExecutorRef: { current: executeTool },
      persistence: {
        store,
        agentId: "agent-main",
        sessionKey: "session-creator",
      },
    })({
      plan,
      input: {
        name: "demo skill",
        description: "Demo",
        content: "# Demo\n",
      },
    });

    const runId = store.recordRunStarted.mock.calls[0]?.[0].runId;
    expect(result).toMatchObject({
      status: "succeeded",
      finalText: "Created skill proposal proposal-1.",
      outputs: {
        proposal: {
          result: {
            details: {
              id: "proposal-1",
              status: "pending",
              kind: "create",
              skillName: "demo skill",
              skillKey: "demo-skill",
              scanState: "clean",
            },
          },
        },
      },
    });
    expect(JSON.stringify(result.outputs)).not.toContain("sk-workshop-private");
    expect(store.recordEvidence).toHaveBeenCalledWith({
      evidenceId: expect.stringMatching(/^gate-/),
      runId,
      proposalId: "proposal-1",
      gateName: "skill_workshop_scan",
      result: "passed",
      evidenceJson: {
        result: "passed",
        summary: "Skill Workshop proposal scan is clean.",
        proposalId: "proposal-1",
        scanState: "clean",
        status: "pending",
        kind: "create",
        skillName: "demo skill",
        skillKey: "demo-skill",
      },
      createdAtMs: expect.any(Number),
    });
  });

  it("records creator prepare gate evidence with the created proposal id", async () => {
    const store = createStoreMock();
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("meta_skill_creator_prepare", vi.fn()), tool("skill_workshop", vi.fn())],
    };
    const executeTool = vi.fn<MetaInvokeToolExecutor>(async ({ toolName }) => {
      if (toolName === "meta_skill_creator_prepare") {
        return textResult("Prepared skill proposal for demo-skill.", {
          gatesOk: true,
          gates: [
            {
              name: "creator_runtime_e2e",
              result: "passed",
              riskLevel: "low",
              summary: "representative invocation executed through meta runtime",
              evidenceJson: {
                runtimeStatus: "succeeded",
              },
              artifactRefsJson: {
                invocation: "meta://runtime-e2e/demo-skill",
              },
            },
          ],
          workshopAction: "create",
          name: "demo skill",
          description: "Demo skill",
          proposalContent: "# Demo Skill\n",
          token: "sk-prepare-private",
        });
      }
      return textResult("Created skill proposal proposal-1.", {
        id: "proposal-1",
        status: "pending",
        kind: "create",
        skillName: "demo skill",
        skillKey: "demo-skill",
        scanState: "clean",
        token: "sk-workshop-private",
      });
    });
    const plan = {
      name: "meta-skill-creator",
      description: "Create a skill proposal",
      triggers: [],
      steps: [
        {
          id: "prepare",
          kind: "tool_call",
          dependsOn: [],
          toolName: "meta_skill_creator_prepare",
          args: {
            name: "{{input.name}}",
            description: "{{input.description}}",
            workflow: "{{input.workflow}}",
          },
          onFailure: { kind: "fail" },
        },
        {
          id: "proposal",
          kind: "tool_call",
          dependsOn: ["prepare"],
          toolName: "skill_workshop",
          args: {
            action: "{{prepare.result.details.workshopAction}}",
            name: "{{prepare.result.details.name}}",
            description: "{{prepare.result.details.description}}",
            proposal_content: "{{prepare.result.details.proposalContent}}",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "proposal" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef,
      toolExecutorRef: { current: executeTool },
      persistence: {
        store,
        agentId: "agent-main",
        sessionKey: "session-creator",
      },
    })({
      plan,
      input: {
        name: "demo skill",
        description: "Demo skill",
        workflow: "Collect the workflow and prepare a pending proposal.",
      },
    });

    const runId = store.recordRunStarted.mock.calls[0]?.[0].runId;
    expect(result.status).toBe("succeeded");
    expect(executeTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: {
          action: "create",
          name: "demo skill",
          description: "Demo skill",
          proposal_content: "# Demo Skill\n",
        },
      }),
    );
    expect(result.outputs.prepare).toMatchObject({
      result: {
        details: {
          gatesOk: true,
          workshopAction: "create",
          name: "demo skill",
          description: "Demo skill",
          proposalContent: "# Demo Skill\n",
        },
      },
    });
    expect(JSON.stringify(result.outputs)).not.toContain("sk-prepare-private");
    expect(JSON.stringify(result.outputs)).not.toContain("sk-workshop-private");
    expect(store.recordEvidence).toHaveBeenCalledWith({
      evidenceId: expect.stringMatching(/^gate-/),
      runId,
      proposalId: "proposal-1",
      gateName: "creator_runtime_e2e",
      result: "passed",
      riskLevel: "low",
      evidenceJson: {
        result: "passed",
        summary: "representative invocation executed through meta runtime",
        runtimeStatus: "succeeded",
      },
      artifactRefsJson: {
        invocation: "meta://runtime-e2e/demo-skill",
      },
      createdAtMs: expect.any(Number),
    });
    expect(store.recordEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        proposalId: "proposal-1",
        gateName: "skill_workshop_scan",
        result: "passed",
      }),
    );
  });

  it("resumes matching pending persisted pauses instead of starting a new meta run", async () => {
    const store = createStoreMock();
    store.readPendingPauseForSession.mockReturnValue({
      pauseId: "pause-1",
      runId: "run-paused",
      stepId: "ask",
      schemaJson: { type: "object", required: ["topic"] },
      prefillJson: null,
      confirmedFieldsJson: null,
      channelBindingJson: null,
      sessionKey: "session-1",
      status: "pending",
      expiresAtMs: Date.now() + 10_000,
      createdAtMs: 1_000,
      resumedAtMs: null,
    });
    store.readRun.mockReturnValue({
      runId: "run-paused",
      skillName: "clarify",
      skillKey: null,
      agentId: "agent-main",
      sessionKey: "session-1",
      agentRunId: null,
      channelTargetJson: null,
      workspaceContextJson: null,
      status: "paused",
      triggerJson: null,
      inputJson: {},
      originalInputSummary: null,
      finalMode: null,
      finalText: "paused",
      createdAtMs: 1_000,
      updatedAtMs: 1_100,
      completedAtMs: 1_100,
    });
    const llmCompletion = createLlmCompletion({
      completeWithPreparedSimpleCompletionModel: vi.fn(async () =>
        assistantMessage("Drafted SQLite"),
      ),
    });
    const plan = {
      name: "clarify",
      description: "Collect and draft",
      triggers: [],
      steps: [
        {
          id: "ask",
          kind: "user_input",
          dependsOn: [],
          schema: { type: "object", required: ["topic"] },
          onFailure: { kind: "fail" },
        },
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: ["ask"],
          prompt: "Draft {{ask.topic}}",
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "draft" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef: { current: [] },
      llmCompletion,
      persistence: {
        store,
        agentId: "agent-main",
        sessionKey: "session-1",
      },
    })({
      plan,
      input: { topic: "SQLite" },
    });

    expect(store.recordRunStarted).not.toHaveBeenCalled();
    expect(store.markPauseResumed).toHaveBeenCalledWith(
      expect.objectContaining({
        pauseId: "pause-1",
        confirmedFieldsJson: { topic: "SQLite" },
      }),
    );
    expect(store.recordStepFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-paused",
        stepId: "ask",
        status: "succeeded",
        outputJson: { topic: "SQLite" },
      }),
    );
    expect(store.recordRunCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-paused",
        status: "succeeded",
        finalText: "Drafted SQLite",
      }),
    );
    expect(result).toMatchObject({
      status: "succeeded",
      finalText: "Drafted SQLite",
      outputs: {
        ask: { topic: "SQLite" },
        draft: { text: "Drafted SQLite" },
      },
    });
  });

  it("blocks recursive meta_invoke tool calls", async () => {
    const execute = vi.fn();
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("meta_invoke", execute)],
    };
    const plan = {
      name: "recursive",
      description: "Recursive",
      triggers: [],
      steps: [
        {
          id: "again",
          kind: "tool_call",
          dependsOn: [],
          toolName: "meta_invoke",
          args: {},
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "auto" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({ toolsRef })({
      plan,
      input: {},
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("tool_call steps cannot invoke meta_invoke");
  });

  it("blocks tool search wrapper targets that can indirectly invoke meta_invoke", async () => {
    const execute = vi.fn();
    const toolsRef: MetaInvokeToolRef = {
      current: [tool("tool_call", execute)],
    };
    const plan = {
      name: "indirect_recursive",
      description: "Indirect recursive",
      triggers: [],
      steps: [
        {
          id: "again",
          kind: "tool_call",
          dependsOn: [],
          toolName: "tool_call",
          args: {
            tool: "meta_invoke",
          },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "auto" },
    } satisfies MetaPlan;

    const result = await createAgentMetaInvokePlanRunner({
      toolsRef,
      toolExecutorRef: { current: execute },
    })({
      plan,
      input: {},
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("tool_call steps cannot invoke tool_call");
  });

  it("filters meta targets to the final safe direct tool surface", () => {
    const readTool = tool("read", vi.fn());
    const toolCall = tool("tool_call", vi.fn());
    const codeModeExec = markCodeModeControlTool(tool("exec", vi.fn()));

    expect(filterMetaInvokeTargetTools([readTool, toolCall, codeModeExec])).toEqual([readTool]);
  });
});
