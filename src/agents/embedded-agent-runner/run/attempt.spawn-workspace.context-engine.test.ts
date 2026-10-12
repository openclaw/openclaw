import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  createSessionEntryWithTranscript,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { sumToolResultTextChars } from "../tool-result-context-guard.test-support.js";
import {
  completedStream,
  contextEngineInfo,
  createTestContextEngine,
  expectFields,
  findRecord,
  mockParams,
  requireRecord,
  requireRecords,
  runtimeContextMessage,
  useContextEngineAttemptHarness,
  type ContextEngineAttemptOptions as AttemptOptions,
  type MockCallSource,
} from "./attempt-context-engine.test-support.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import {
  createDefaultEmbeddedSession,
  createContextEngineBootstrapAndAssemble,
} from "./attempt-spawn-workspace.test-support.js";

function useHooks(hooks: Parameters<typeof createHookRunnerWithRegistry>[0]) {
  hoisted.getGlobalHookRunnerMock.mockReturnValue(createHookRunnerWithRegistry(hooks).runner);
}
const embeddedSessionId = "embedded-session";
const doneMessage = { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage;

const sessionKey = "agent:main:guildchat:channel:test-ctx-engine";
const { hoisted, runAttempt, tempPaths } = useContextEngineAttemptHarness(sessionKey);

function capturePrompt(
  transform: boolean | "preprocessed" = false,
  assistant: unknown = doneMessage,
) {
  const seen: {
    prompt?: string;
    messages?: unknown[];
    modelMessages?: unknown[];
    systemPrompt?: string;
  } = {};
  const sessionPrompt: NonNullable<AttemptOptions["sessionPrompt"]> = async (session, prompt) => {
    seen.prompt = prompt;
    seen.messages = [...session.messages];
    seen.systemPrompt = session.agent.state.systemPrompt;
    if (transform) {
      const transformContext = (
        session.agent as {
          transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
        }
      ).transformContext;
      const messages = await transformContext?.([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: transform === "preprocessed" ? `session preprocessed\n\n${prompt}` : prompt,
            },
          ],
          timestamp: 1,
        },
      ]);
      seen.modelMessages = messages && normalizeMessagesForLlmBoundary(messages);
    }
    session.messages = [...session.messages, assistant];
  };
  return { seen, sessionPrompt };
}

function installPromptHook(prependContext: string, appendContext: string) {
  useHooks([
    {
      hookName: "before_prompt_build",
      handler: vi.fn(async () => ({ prependContext, appendContext })),
    },
  ]);
}

function signedAssistant(
  thinking: string,
  thinkingSignature: string,
  text: string,
  timestamp: number,
) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking, thinkingSignature },
      { type: "text", text },
    ],
    stopReason: "stop",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    timestamp,
  } as AgentMessage;
}

type TrajectoryEvent = { type?: string; data?: Record<string, unknown> };
async function readTrajectoryEvents(paths: string[]): Promise<TrajectoryEvent[]> {
  const workspaceDir = paths[0];
  if (!workspaceDir) {
    throw new Error("missing trajectory workspace path");
  }
  return hoisted.trajectoryEvents.filter((event) => event.workspaceDir === workspaceDir);
}

describe("runEmbeddedAttempt context engine sessionKey forwarding", () => {
  it("forwards the normalized message channel to the embedded subscription", async () => {
    await runAttempt({
      attemptOverrides: {
        messageChannel: "TELEGRAM",
      },
    });

    const subscriptionParams = requireRecord(
      hoisted.subscribeEmbeddedAgentSessionMock.mock.calls[0]?.[0],
      "subscription params",
    );
    expect(subscriptionParams.messageChannel).toBe("telegram");
  });

  it("keeps client tool names out of context engine capability guidance", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();

    await runAttempt({
      contextEngine,
      attemptOverrides: {
        disableTools: false,
        config: {
          tools: {
            toolSearch: { enabled: true, mode: "directory" },
          },
        } as OpenClawConfig,
        clientTools: [
          {
            type: "function",
            function: {
              name: "memory_search",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    });

    const assembleParams = mockParams(contextEngine.assemble as MockCallSource);
    const availableTools = assembleParams.availableTools;
    expect(availableTools).toBeInstanceOf(Set);
    expect((availableTools as Set<string>).has("memory_search")).toBe(false);
  });

  it("uses SQLite transcript messages for bootstrap without treating the marker as a file", async () => {
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ctx-engine-sqlite-"));
    tempPaths.push(storeDir);
    const storePath = path.join(storeDir, "sessions.json");
    const created = await createSessionEntryWithTranscript(
      {
        agentId: "main",
        sessionKey,
        storePath,
      },
      () => ({
        ok: true,
        entry: {
          sessionId: embeddedSessionId,
          updatedAt: Date.now(),
        },
      }),
    );
    if (!created.ok) {
      throw new Error(`failed to create SQLite session entry: ${created.error}`);
    }
    await appendTranscriptMessage(
      {
        agentId: "main",
        sessionId: embeddedSessionId,
        sessionKey,
        storePath,
      },
      {
        message: { role: "user", content: "persisted SQLite prompt" },
        now: Date.now(),
      },
    );
    const bootstrap = vi.fn(async () => ({ bootstrapped: true }));
    const assemble = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({
      messages,
      estimatedTokens: 1,
    }));

    await runAttempt({
      contextEngine: createTestContextEngine({ bootstrap, assemble }),
      attemptOverrides: {
        sessionFile: created.sessionFile,
        sessionTarget: {
          agentId: "main",
          sessionId: embeddedSessionId,
          sessionKey,
          storePath,
        },
      },
    });

    expect(bootstrap).toHaveBeenCalled();
  });

  it("enforces code-mode payload surface from active-agent config during an embedded attempt", async () => {
    const observedOptions: Array<Record<string, unknown>> = [];
    const payloads: Array<Record<string, unknown>> = [];

    await runAttempt({
      sessionKey: "agent:ops:guildchat:channel:test-code-mode",
      attemptOverrides: {
        agentId: "ops",
        disableTools: false,
        config: {
          tools: {
            codeMode: { enabled: false },
          },
          agents: {
            entries: { ops: { tools: { codeMode: true } } },
          },
        } as OpenClawConfig,
        model: {
          api: "openai-chatgpt-responses",
          provider: "gateway",
          id: "gpt-5.5",
          contextWindow: 8192,
          input: ["text"],
        } as never,
      },
      createSession: () => {
        const session = createDefaultEmbeddedSession();
        session.agent.streamFn = async (_model, _context, options) => {
          observedOptions.push(options as Record<string, unknown>);
          const payload: Record<string, unknown> = {
            tools: [
              { type: "function", name: "exec" },
              { type: "function", name: "wait" },
              { type: "function", name: "read" },
            ],
          };
          (
            options as
              | {
                  onPayload?: (payload: Record<string, unknown>, model: typeof _model) => void;
                }
              | undefined
          )?.onPayload?.(payload, _model);
          payloads.push(structuredClone(payload));
          return completedStream({ role: "assistant", content: "done" });
        };
        session.prompt = async () => {
          await session.agent.streamFn?.(
            {} as never,
            {
              messages: [],
              tools: [
                { name: "exec", description: "", parameters: {} },
                { name: "wait", description: "", parameters: {} },
              ],
            } as never,
            {},
          );
          session.messages = [...session.messages, doneMessage];
        };
        return session;
      },
    });

    expect(observedOptions.at(-1)?.openclawCodeModeToolSurface).toBe(true);
    expect(payloads.at(-1)?.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
    ]);
  });

  it.each([false, true])("keeps lean replies direct (private: %s)", async (privateReply) => {
    hoisted.createOpenClawCodingToolsMock.mockReturnValueOnce([
      {
        name: "message",
        label: "Message",
        description: "Send a visible reply.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "sent" }),
      },
      {
        name: "browser",
        label: "Browser",
        description: "Open a browser session.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "opened" }),
      },
    ]);

    await runAttempt({
      attemptOverrides: {
        disableTools: false,
        sourceReplyDeliveryMode: "message_tool_only",
        toolsAllow: privateReply ? ["message"] : undefined,
        config: {
          agents: {
            defaults: {
              experimental: {
                localModelLean: true,
              },
            },
          },
        } as OpenClawConfig,
      },
    });

    expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledTimes(1);
    const options = mockParams(hoisted.createOpenClawCodingToolsMock);
    expect(options.includeToolSearchControls).toBe(!privateReply);
    const sessionOptions = mockParams(hoisted.createAgentSessionMock);
    const customTools = requireRecords(sessionOptions.customTools, "customTools");
    expect(customTools.map((tool) => tool.name)).toEqual(
      privateReply ? ["message"] : ["tool_search", "tool_describe", "dispatch_action", "message"],
    );
  });

  it("quarantines unsupported tool schemas before creating the model session", async () => {
    hoisted.createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "healthy_lookup",
        label: "Healthy Lookup",
        description: "Look up safe data.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "ok" }),
      },
      {
        name: "fuzzplugin_move_angles",
        label: "Fuzzplugin Move Angles",
        description: "Move robot joints.",
        parameters: {
          type: "object",
          properties: {
            target: { $dynamicRef: "#target" },
          },
        },
        execute: async () => ({ text: "bad" }),
      },
    ]);

    const activeToolNames: string[][] = [];
    await runAttempt({
      attemptOverrides: {
        disableTools: false,
        config: {
          tools: {
            codeMode: { enabled: false },
            toolSearch: false,
          },
        } as OpenClawConfig,
      },
      createSession: () => {
        const session = createDefaultEmbeddedSession();
        const setActiveToolsByName = session.setActiveToolsByName;
        session.setActiveToolsByName = (toolNames) => {
          setActiveToolsByName(toolNames);
          activeToolNames.push([...toolNames]);
        };
        return session;
      },
    });

    const sessionOptions = mockParams(hoisted.createAgentSessionMock);
    const customTools = requireRecords(sessionOptions.customTools, "customTools");
    expect(customTools.map((tool) => tool.name)).toEqual(["healthy_lookup"]);
    expect(activeToolNames).toEqual([["healthy_lookup"]]);
  });

  it("keeps newly generated thinking after repairing rejected Anthropic replay", async () => {
    const { SessionManager: ActualSessionManager } =
      await vi.importActual<typeof import("../../sessions/index.js")>("../../sessions/index.js");
    const staleAssistant = signedAssistant(
      "historical stale thinking",
      "stale-signature",
      "historical answer",
      2,
    );
    const sessionMessages = [
      { role: "user", content: "historical question", timestamp: 1 } as AgentMessage,
      staleAssistant,
    ];
    const sessionManager = ActualSessionManager.inMemory();
    const appendSessionMessage = (message: AgentMessage) =>
      sessionManager.appendMessage(message as Parameters<typeof sessionManager.appendMessage>[0]);
    for (const message of sessionMessages) {
      appendSessionMessage(message);
    }
    const retryAssistant = signedAssistant(
      "fresh valid retry thinking",
      "fresh-valid-signature",
      "retry answer",
      4,
    );
    const providerContexts: AgentMessage[][] = [];
    const afterTurn = vi.fn(async (_params: { messages: AgentMessage[] }) => {});

    hoisted.sessionManagerOpenMock.mockReturnValue(sessionManager);

    await runAttempt({
      contextEngine: {
        ...createContextEngineBootstrapAndAssemble(),
        afterTurn,
      },

      sessionMessages,
      attemptOverrides: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        model: {
          api: "anthropic-messages",
          provider: "anthropic",
          id: "claude-sonnet-4-6",
          contextWindow: 128_000,
          input: ["text"],
        } as never,
        runtimePlan: {
          prompt: {
            resolveSystemPromptContribution: () => undefined,
          },
          transcript: {
            resolvePolicy: () => ({
              sanitizeMode: "full",
              sanitizeToolCallIds: true,
              preserveNativeAnthropicToolUseIds: false,
              repairToolUseResultPairing: true,
              preserveSignatures: true,
              dropThinkingBlocks: false,
              dropReasoningFromHistory: false,
              applyGoogleTurnOrdering: false,
              validateGeminiTurns: false,
              validateAnthropicTurns: false,
              allowSyntheticToolResults: false,
            }),
          },
          transport: {
            extraParams: {},
            resolveExtraParams: () => ({}),
          },
          tools: {
            normalize: (tools: unknown[]) => tools,
            logDiagnostics: () => {},
          },
          auth: {
            providerForAuth: "anthropic",
            authProfileProviderForAuth: "",
            forwardedAuthProfileId: undefined,
          },
          delivery: {
            isSilentPayload: () => false,
            resolveFollowupRoute: () => undefined,
          },
          outcome: {
            classifyRunResult: () => undefined,
          },
          observability: {
            resolvedRef: "anthropic/claude-sonnet-4-6",
            provider: "anthropic",
            modelId: "claude-sonnet-4-6",
            modelApi: "anthropic-messages",
          },
        } as never,
      },
      createSession: () => {
        const session = createDefaultEmbeddedSession({ initialMessages: sessionMessages });
        let streamCalls = 0;
        session.agent.streamFn = async (_model, context) => {
          streamCalls += 1;
          providerContexts.push([
            ...((context as { messages?: AgentMessage[] } | undefined)?.messages ?? []),
          ]);
          if (streamCalls === 1) {
            throw new Error("invalid signature in thinking block");
          }
          return completedStream(retryAssistant);
        };
        session.prompt = async (prompt, options) => {
          options?.preflightResult?.(true);
          const userMessage = {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: 3,
          } as AgentMessage;
          session.messages = [...session.messages, userMessage];
          appendSessionMessage(userMessage);
          const stream = await session.agent.streamFn?.(
            {} as never,
            { messages: session.messages } as never,
            {},
          );
          const assistantMessage = await (
            stream as { result: () => Promise<AgentMessage> }
          ).result();
          session.messages = [...session.messages, assistantMessage];
          appendSessionMessage(assistantMessage);
        };
        return session;
      },
    });

    const firstProviderContext = providerContexts[0] ?? [];
    const retryProviderContext = providerContexts[1] ?? [];
    expect(JSON.stringify(firstProviderContext)).toContain("stale-signature");
    expect(JSON.stringify(retryProviderContext)).not.toContain("stale-signature");

    const finalMessages = sessionManager.buildSessionContext().messages;
    expect(JSON.stringify(finalMessages[1])).not.toContain("historical stale thinking");
    expect(JSON.stringify(finalMessages.at(-1))).toContain("fresh valid retry thinking");
    expect(JSON.stringify(finalMessages.at(-1))).toContain("fresh-valid-signature");
    expect(afterTurn.mock.calls.flatMap(([params]) => params.messages)).toContainEqual(
      retryAssistant,
    );
  });

  it("keeps bootstrap truncation warnings out of WebChat runtime context", async () => {
    const { seen, sessionPrompt } = capturePrompt();
    hoisted.resolveBootstrapContextForRunMock.mockResolvedValueOnce({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/openclaw-warning-workspace/AGENTS.md",
          content: "A".repeat(200),
          missing: false,
        },
      ],
      contextFiles: [
        { path: "/tmp/openclaw-warning-workspace/AGENTS.md", content: "A".repeat(20) },
      ],
    });

    await runAttempt({
      attemptOverrides: {
        config: {
          agents: {
            defaults: {
              bootstrapMaxChars: 50,
              bootstrapTotalMaxChars: 50,
            },
          },
        } as OpenClawConfig,
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
      },
      sessionPrompt,
    });

    expect(seen.prompt).toBe("visible ask");
    expect(JSON.stringify(seen.messages)).not.toContain("[Bootstrap truncation warning]");
    expect(JSON.stringify(seen.messages)).not.toContain("bootstrapMaxChars");
  });

  it("includes hook-adjusted bootstrap files preloaded before routing", async () => {
    const workspaceDir = "/tmp/openclaw-hook-workspace";
    hoisted.resolveBootstrapFilesForRunMock.mockResolvedValueOnce([
      {
        name: "BOOTSTRAP.md",
        path: `${workspaceDir}/BOOTSTRAP.md`,
        content: "Ask who I am before continuing.",
        missing: false,
      },
    ]);

    await runAttempt({
      attemptOverrides: {
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
        trigger: "user",
        workspaceDir,
      },
    });

    expect(hoisted.resolveBootstrapFilesForRunMock).toHaveBeenCalledOnce();
    expect(hoisted.resolveBootstrapContextForRunMock).not.toHaveBeenCalled();
    const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as {
      bootstrapMode?: string;
      contextFiles?: Array<{ path: string; content: string }>;
    };

    expect(promptInput.bootstrapMode).toBe("full");
    expect(promptInput.contextFiles).toEqual([
      {
        path: `${workspaceDir}/BOOTSTRAP.md`,
        content: "Ask who I am before continuing.",
      },
    ]);
  });

  it("skips bootstrap preload on completed continuation-skip turns", async () => {
    hoisted.resolveContextInjectionModeMock.mockReturnValue("continuation-skip");
    hoisted.hasCompletedBootstrapTurnMock.mockResolvedValue(true);
    hoisted.isWorkspaceBootstrapPendingMock.mockResolvedValue(false);

    await runAttempt({
      attemptOverrides: {
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
        trigger: "user",
      },
    });

    expect(hoisted.hasCompletedBootstrapTurnMock).toHaveBeenCalledOnce();
    expect(hoisted.isWorkspaceBootstrapPendingMock).toHaveBeenCalledOnce();
    expect(hoisted.resolveBootstrapFilesForRunMock).not.toHaveBeenCalled();
    expect(hoisted.resolveBootstrapContextForRunMock).not.toHaveBeenCalled();
  });

  it("keeps inbound context separate on runtime-only turns", async () => {
    hoisted.sessionManager.getHeader.mockReturnValue({ version: 4 });
    installPromptHook("dynamic hook context", "dynamic hook tail");
    const { seen, sessionPrompt } = capturePrompt(true);

    const result = await runAttempt({
      trajectory: true,
      attemptOverrides: {
        prompt: "secret runtime context",
        runtimeContextFragments: [{ kind: "runtime-instruction", text: "secret runtime context" }],
        transcriptPrompt: "",
        currentInboundContext: {
          text: [
            "Reply target of current user message:",
            "```json",
            JSON.stringify(
              {
                sender_label: "Mike",
                body: "WT daily plan - Sat May 2\nSee ./quoted-secret.png and [media attached: media://inbound/quoted.png]",
              },
              null,
              2,
            ),
            "```",
          ].join("\n"),
        },
      },
      sessionPrompt,
    });

    expect(seen.prompt).toBe("Continue the OpenClaw runtime event.");
    expect(result.finalPromptText).toBe(seen.prompt);
    const runtimeContext = runtimeContextMessage(seen.messages);
    const inboundContext = runtimeContext.content;
    expect(inboundContext).toContain("Reply target of current user message:");
    expect(inboundContext).toContain('"sender_label": "Mike"');
    expect(inboundContext).toContain("WT daily plan - Sat May 2");
    expect(inboundContext).toContain("./quoted-secret.png");
    expect(inboundContext).toContain("media://inbound/quoted.png");
    expect(runtimeContext.content).toContain("secret runtime context");
    expect(hoisted.detectAndLoadPromptImagesMock).toHaveBeenCalledTimes(1);
    expect(mockParams(hoisted.detectAndLoadPromptImagesMock).prompt).toBe(
      "Continue the OpenClaw runtime event.",
    );
    const trajectoryEvents = await readTrajectoryEvents(tempPaths);
    const promptSubmitted = trajectoryEvents.find((event) => event.type === "prompt.submitted");
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    for (const text of ["dynamic hook context", "dynamic hook tail"]) {
      expect(JSON.stringify(seen.modelMessages)).toContain(text);
      expect(contextCompiled?.data?.prompt).toContain(text);
      expect(contextCompiled?.data?.systemPrompt).not.toContain(text);
    }
    expect(contextCompiled?.data?.systemPrompt).not.toContain("secret runtime context");
    expect(JSON.stringify(seen.modelMessages)).toContain("secret runtime context");
    expect(promptSubmitted?.data?.prompt).not.toContain("WT daily plan - Sat May 2");
    expect(promptSubmitted?.data?.prompt).toContain("secret runtime context");
    expect(
      requireRecords(result.messagesSnapshot, "messages snapshot").some(
        (message) =>
          message.role === "user" && String(message.content).includes("secret runtime context"),
      ),
    ).toBe(false);
  });

  it.each([true, "preprocessed"] as const)(
    "keeps hook prompt context visible while hiding inter-session provenance (%s)",
    async (transform) => {
      hoisted.sessionManager.getHeader.mockReturnValue({ version: 4 });
      const recalledMemoryContext = [
        "<relevant-memories>",
        "1. [fact] stale [media attached: /tmp/some.png] and /tmp/other.png",
        "</relevant-memories>",
      ].join("\n");
      installPromptHook(recalledMemoryContext, "dynamic hook tail");
      const { seen, sessionPrompt } = capturePrompt(transform);

      const result = await runAttempt({
        attemptOverrides: {
          prompt: "visible ask",
          runtimeContextFragments: [
            { kind: "runtime-instruction", text: "secret runtime context" },
          ],
          transcriptPrompt: "visible ask",
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:discord:source",
            sourceTool: "sessions_send",
          },
        },
        sessionPrompt,
      });

      expect(seen.prompt).toBe("visible ask");
      expect(result.finalPromptText).toBe("visible ask");
      expect(JSON.stringify(seen.modelMessages)).toContain("<relevant-memories>");
      expect(JSON.stringify(seen.modelMessages)).toContain("/tmp/some.png");
      expect(JSON.stringify(seen.modelMessages)).toContain("/tmp/other.png");
      expect(JSON.stringify(seen.modelMessages)).toContain("dynamic hook tail");
      expect(JSON.stringify(seen.modelMessages)).toContain(
        JSON.stringify(recalledMemoryContext).slice(1, -1),
      );
      if (transform === "preprocessed") {
        expect(JSON.stringify(seen.modelMessages)).toContain("session preprocessed");
      }
      expect(JSON.stringify(seen.modelMessages)).not.toContain("[Inter-session message]");
      expect(JSON.stringify(seen.modelMessages)).not.toContain("secret runtime context");
      const runtimeContext = runtimeContextMessage(seen.messages);
      expect(seen.systemPrompt).not.toContain("[Inter-session message]");
      expect(runtimeContext.content).toContain("[Inter-session message]");
      expect(runtimeContext.content).toContain("isUser=false");
      expect(runtimeContext.content).not.toContain("visible ask");
      expect(runtimeContext.content).toContain("secret runtime context");
      expect(runtimeContext.content).not.toContain(recalledMemoryContext);
      expect(runtimeContext.content).not.toContain("dynamic hook tail");
      expect(JSON.stringify(result.messagesSnapshot)).not.toContain(recalledMemoryContext);
      expect(JSON.stringify(result.messagesSnapshot)).not.toContain("dynamic hook tail");
      expect(hoisted.detectAndLoadPromptImagesMock).toHaveBeenCalledTimes(1);
      expect(mockParams(hoisted.detectAndLoadPromptImagesMock).prompt).toBe("visible ask");
    },
  );

  it("keeps runtime-only context hidden when orphan repair merges an empty transcript", async () => {
    hoisted.sessionManager.getHeader.mockReturnValue({ version: 4 });
    const { seen, sessionPrompt } = capturePrompt();
    hoisted.sessionManager.getLeafEntry.mockReturnValueOnce({
      id: "orphan-leaf",
      parentId: "parent-leaf",
      type: "message",
      message: { role: "user", content: "orphaned ask", timestamp: 1 },
    });

    const result = await runAttempt({
      trajectory: true,
      attemptOverrides: {
        prompt: "internal heartbeat event",
        runtimeContextFragments: [
          { kind: "runtime-instruction", text: "internal heartbeat event" },
        ],
        transcriptPrompt: "",
      },
      sessionPrompt,
    });

    expect(seen.prompt).toContain("orphaned ask");
    expect(seen.prompt).not.toContain("internal heartbeat event");
    expect(result.finalPromptText).toBe(seen.prompt);
    const trajectoryEvents = await readTrajectoryEvents(tempPaths);
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    const runtimeContext = runtimeContextMessage(seen.messages);
    expect(runtimeContext.content).toContain("internal heartbeat event");
    expect(contextCompiled?.data?.systemPrompt).not.toContain("internal heartbeat event");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("internal heartbeat event");
    expect(hoisted.sessionManager.branchAsync).toHaveBeenCalledWith("parent-leaf");
  });

  it("skips blank visible prompts with replay history before provider submission", async () => {
    const sessionPrompt = vi.fn(async () => {
      throw new Error("blank prompt should not be submitted");
    });

    const result = await runAttempt({
      trajectory: true,
      attemptOverrides: {
        prompt: "  \n\t  ",
      },
      sessionPrompt,
    });

    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(result.finalPromptText).toBeUndefined();
    expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeNull();
    expect(result.messagesSnapshot).toHaveLength(1);
    expectFields(requireRecord(result.messagesSnapshot[0], "messages snapshot seed"), {
      role: "user",
      content: "seed",
    });
    const trajectoryEvents = await readTrajectoryEvents(tempPaths);
    expect(trajectoryEvents.some((event) => event.type === "prompt.submitted")).toBe(false);
    const skipped = findRecord(
      trajectoryEvents as Array<Record<string, unknown>>,
      (event) => event.type === "prompt.skipped",
      "prompt skipped event",
    );
    expect(requireRecord(skipped.data, "prompt skipped data").reason).toBe("blank_user_prompt");
  });

  it("releases the initial session lock before before_agent_run block finalizers", async () => {
    const sessionPrompt = vi.fn(async () => {
      throw new Error("blocked prompt should not be submitted");
    });
    const runBeforeAgentRun = vi.fn(async () => ({
      outcome: "block" as const,
      reason: "Blocked by test policy.",
    }));
    useHooks([
      { hookName: "before_agent_run", pluginId: "test-policy", handler: runBeforeAgentRun },
    ]);

    const result = await runAttempt({
      sessionPrompt,
    });

    expect(runBeforeAgentRun).toHaveBeenCalledTimes(1);
    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(result.finalPromptText).toBeUndefined();
    expect(projectAgentRunAttemptTerminal(result.terminal).promptErrorSource).toBe(
      "hook:before_agent_run",
    );
  });

  it("preserves pipeline history when owning context engine assembly mutates then returns malformed context", async () => {
    let sawPrompt = false;
    let preassemblyMessages: AgentMessage[] = [];
    let providerMessages: AgentMessage[] = [];
    const hugeHistory = "large raw history ".repeat(2_000);

    const result = await runAttempt({
      contextEngine: createTestContextEngine({
        info: { ...contextEngineInfo, ownsCompaction: true },
        assemble: async ({ messages }) => {
          preassemblyMessages = messages.slice();
          messages.reverse();
          messages.pop();
          return { estimatedTokens: 0 } as never;
        },
      }),

      sessionMessages: [{ role: "user", content: hugeHistory, timestamp: 1 }] as AgentMessage[],
      attemptOverrides: {
        contextTokenBudget: 500,
      },
      sessionPrompt: async (session) => {
        sawPrompt = true;
        providerMessages = session.messages.slice() as AgentMessage[];
        session.messages = [...session.messages, doneMessage];
      },
    });

    expect(sawPrompt).toBe(true);
    expect(providerMessages).toEqual([
      ...preassemblyMessages,
      expect.objectContaining({
        role: "custom",
        customType: "openclaw.runtime-context",
        display: false,
        content: expect.stringMatching(
          /^## Temporal Context\nCurrent date: \d{4}-\d{2}-\d{2}\nTime zone: [^\n]+$/,
        ),
      }),
    ]);
    for (const [index, message] of preassemblyMessages.entries()) {
      expect(providerMessages[index]).toBe(message);
    }
    expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeNull();
    expect(projectAgentRunAttemptTerminal(result.terminal).promptErrorSource).toBeNull();
    expect(result.preflightRecovery).toBeUndefined();
    expect(hoisted.preemptiveCompactionCalls).toHaveLength(1);
    expect(hoisted.preemptiveCompactionCalls.at(-1)?.unwindowedMessages).toBeUndefined();
  });

  it("snapshots pre-assembly messages before assemble even when the engine windows in place", async () => {
    const hugeHistory = "large raw history ".repeat(2_000);
    const preassemblyMarker = { role: "user", content: hugeHistory, timestamp: 1 } as AgentMessage;

    const result = await runAttempt({
      contextEngine: createTestContextEngine({
        info: { ...contextEngineInfo, ownsCompaction: true },
        assemble: async ({ messages }: { messages: AgentMessage[] }) => {
          messages.length = 0;
          messages.push({ role: "user", content: "windowed", timestamp: 2 } as AgentMessage);
          return {
            messages: [
              { role: "user", content: "small assembled context", timestamp: 1 },
            ] as AgentMessage[],
            estimatedTokens: 8,
            promptAuthority: "preassembly_may_overflow",
          };
        },
      }),

      sessionMessages: [preassemblyMarker],
      attemptOverrides: {
        contextTokenBudget: 500,
      },
    });

    expect(result.messagesSnapshot).toContainEqual(doneMessage);
    expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeNull();
    expect(projectAgentRunAttemptTerminal(result.terminal).promptErrorSource).toBeNull();
    expect(result.preflightRecovery).toBeUndefined();
    expect(result.contextBudgetStatus?.overflowTokens).toBeGreaterThan(0);
    expect(hoisted.preemptiveCompactionCalls).toHaveLength(1);
    const lastCall = hoisted.preemptiveCompactionCalls.at(-1);
    expect(lastCall).toHaveProperty("unwindowedMessages");
    const unwindowed = (lastCall as { unwindowedMessages?: AgentMessage[] }).unwindowedMessages;
    expect(unwindowed).toHaveLength(1);
    const [unwindowedMessage] = unwindowed ?? [];
    expect(unwindowedMessage).toMatchObject({ role: "user", timestamp: 1 });
    const unwindowedContent = (unwindowedMessage as { content?: unknown } | undefined)?.content;
    expect(unwindowedContent).toEqual(
      expect.stringMatching(/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]]+\] /),
    );
    expect(unwindowedContent).toContain(hugeHistory);
    expect(unwindowedContent).not.toContain("windowed");
  });

  it("keeps gateway model runs independent from agent context and session history", async () => {
    const bootstrap = vi.fn(async () => ({ bootstrapped: true }));
    const assemble = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({
      messages: [
        ...messages,
        { role: "custom", customType: "test-context", content: "should not be sent" },
      ] as AgentMessage[],
      estimatedTokens: 1,
    }));
    const afterTurn = vi.fn(async () => {});
    const runBeforePromptBuild = vi.fn(async () => ({ prependContext: "hook context" }));
    const runLlmInput = vi.fn(async () => {});
    useHooks([
      { hookName: "before_prompt_build", handler: runBeforePromptBuild },
      { hookName: "llm_input", handler: runLlmInput },
    ]);
    const { seen, sessionPrompt } = capturePrompt(false, {
      role: "assistant",
      content: "pong",
      timestamp: 3,
    });

    const result = await runAttempt({
      contextEngine: createTestContextEngine({
        bootstrap,
        assemble,
        afterTurn,
      }),

      sessionMessages: [
        { role: "user", content: "old session question", timestamp: 1 },
        { role: "assistant", content: "old session answer", timestamp: 2 },
      ] as AgentMessage[],
      attemptOverrides: {
        promptMode: "none",
        disableTools: true,
        clientTools: [
          {
            type: "function",
            function: {
              name: "unsafe_client_tool",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
      },
      sessionPrompt,
    });

    expect(seen.prompt).toBe("hello");
    expect(seen.messages).toStrictEqual([]);
    expect(seen.systemPrompt ?? "").toBe("");
    expect(result.finalPromptText).toBe("hello");
    expect(result.systemPromptReport?.systemPrompt ?? "").toBe("");
    expect(result.messagesSnapshot).toHaveLength(1);
    const sessionOptions = mockParams(hoisted.createAgentSessionMock);
    expect(sessionOptions.customTools).toStrictEqual([]);
    expectFields(requireRecord(result.messagesSnapshot[0], "gateway model snapshot"), {
      role: "assistant",
      content: "pong",
    });
    expect(hoisted.resolveBootstrapContextForRunMock).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
    expect(afterTurn).not.toHaveBeenCalled();
    expect(runBeforePromptBuild).not.toHaveBeenCalled();
    expect(runLlmInput).not.toHaveBeenCalled();
  });

  it("flushes the embedded session transcript before afterTurn", async () => {
    const events: string[] = [];
    const afterTurn = vi.fn(async () => {
      events.push("afterTurn");
    });
    hoisted.sessionManager.flushPendingPersistence.mockImplementation(() => {
      events.push("flush");
    });

    await runAttempt({
      contextEngine: createTestContextEngine({ afterTurn }),

      attemptOverrides: {
        currentInboundEventKind: "room_event",
        currentInboundContext: { text: "[OpenClaw room event]" },
        suppressNextUserMessagePersistence: true,
        transcriptPrompt: "",
      },
    });

    const afterTurnIndex = events.indexOf("afterTurn");
    expect(afterTurn).toHaveBeenCalledTimes(1);
    expect(afterTurnIndex).not.toBe(-1);
    expect(events.slice(0, afterTurnIndex)).toContain("flush");
  });

  it("preserves source delivery reported by bridged tool lifecycle events", async () => {
    const baseSubscribe = hoisted.subscribeEmbeddedAgentSessionMock.getMockImplementation();
    if (!baseSubscribe) {
      throw new Error("missing embedded subscription mock");
    }
    hoisted.subscribeEmbeddedAgentSessionMock.mockImplementation((params) => {
      const subscription = baseSubscribe(params);
      params.onDeliveredMessageToolOnlySourceReply?.();
      return subscription;
    });

    const result = await runAttempt({
      attemptOverrides: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
  });
});

describe("runEmbeddedAttempt tool-result guard budget wiring", () => {
  it.each([false, true])(
    "submits a persisted current turn once with context exclusion %s",
    async (excludeFromContext) => {
      const admittedMessage = {
        role: "user" as const,
        content: "durable current turn",
        idempotencyKey: "restart-safe-run:user",
        ...(excludeFromContext ? { excludeFromContext: true as const } : {}),
        timestamp: 1,
        __openclaw: { senderId: "alice-id", senderName: "Alice" },
      };
      const recorder = createUserTurnTranscriptRecorder({
        message: admittedMessage,
        target: () => undefined,
      });
      recorder.markRuntimePersisted(admittedMessage);
      if (excludeFromContext) {
        hoisted.sessionManager.getLeafEntry.mockReturnValueOnce({
          id: "speech",
          parentId: "previous-assistant",
          type: "message",
          message: { role: "user", content: "spoken predecessor", timestamp: 0 },
        });
      }
      let submittedMessages: AgentMessage[] = [];
      const initialMessages = excludeFromContext ? [] : [admittedMessage];

      const result = await runAttempt({
        sessionMessages: initialMessages,
        attemptOverrides: {
          prompt: admittedMessage.content,
          transcriptPrompt: admittedMessage.content,
          suppressNextUserMessagePersistence: true,
          userTurnTranscriptRecorder: recorder,
        },
        createSession: () => {
          const session = createDefaultEmbeddedSession({ initialMessages });
          session.agent.convertToLlm = vi.fn(async (messages) => messages as never);
          const baseStreamFn = session.agent.streamFn;
          session.agent.streamFn = async (...args) => {
            const context = args[1] as { messages?: AgentMessage[] } | undefined;
            submittedMessages =
              ((await session.agent.convertToLlm?.(context?.messages ?? [])) as AgentMessage[]) ??
              [];
            return await baseStreamFn?.(...args);
          };
          session.prompt = async (prompt, options) => {
            session.messages = [
              ...session.messages,
              {
                role: "user",
                content: prompt,
                idempotencyKey: admittedMessage.idempotencyKey,
                timestamp: admittedMessage.timestamp,
              },
            ];
            options?.preflightResult?.(true);
            await session.agent.streamFn?.(
              {} as never,
              { messages: session.messages } as never,
              {} as never,
            );
            session.messages = [...session.messages, doneMessage];
          };
          return session;
        },
      });

      expect(result.finalPromptText).toBe(admittedMessage.content);
      expect(result.messagesSnapshot).toContainEqual(doneMessage);
      expect(submittedMessages.filter((message) => message.role === "user")).toEqual([
        expect.objectContaining({
          content: expect.stringContaining('"name":"Alice"'),
          role: "user",
        }),
      ]);
    },
  );

  it("preserves the cacheable prefix while bounding current prompt results", async () => {
    const toolText = "process output ".repeat(70);
    const sessionMessages: AgentMessage[] = [{ role: "user", content: "seed", timestamp: 1 }];
    for (let index = 0; index < 8; index += 1) {
      const toolCallId = `call_${index}`;
      sessionMessages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "process", input: {} }],
        timestamp: 2 + index * 2,
      } as unknown as AgentMessage);
      sessionMessages.push({
        role: "toolResult",
        toolCallId,
        toolName: "process",
        content: [{ type: "text", text: `${index}: ${toolText}` }],
        isError: false,
        timestamp: 3 + index * 2,
      } as AgentMessage);
    }
    let submittedMessages: AgentMessage[] = [];
    let promptHandlerMessages: AgentMessage[] = [];
    let afterTurnMessages: AgentMessage[] = [];
    const afterTurn = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => {
      afterTurnMessages = messages;
    });

    await runAttempt({
      contextEngine: {
        ...createContextEngineBootstrapAndAssemble(),
        afterTurn,
      },

      sessionMessages,
      attemptOverrides: { contextTokenBudget: 128_000 },
      createSession: () => {
        const session = createDefaultEmbeddedSession({ initialMessages: sessionMessages });
        session.agent.streamFn = async (_model, context) => {
          const providerMessages = (context as { messages?: AgentMessage[] } | undefined)?.messages;
          submittedMessages = providerMessages ?? [];
          return completedStream(doneMessage);
        };
        session.prompt = async (_prompt, options) => {
          for (let index = 0; index < 8; index += 1) {
            session.messages.push({
              role: "toolResult",
              toolCallId: `current_call_${index}`,
              toolName: "process",
              content: [
                { type: "text", text: `current ${index}: ${"current output ".repeat(3_000)}` },
              ],
              isError: false,
              timestamp: 100 + index,
            } as AgentMessage);
          }
          promptHandlerMessages = session.messages.map((message) => message as AgentMessage);
          options?.preflightResult?.(true);
          await session.agent.streamFn?.({} as never, { messages: session.messages } as never, {});
          session.messages = [...session.messages, doneMessage];
        };
        return session;
      },
    });

    expect(sumToolResultTextChars(sessionMessages)).toBeGreaterThan(4_000);
    expect(sumToolResultTextChars(promptHandlerMessages)).toBeGreaterThan(4_000);
    const submittedCurrentPromptMessages = submittedMessages.slice(sessionMessages.length);
    expect(
      submittedMessages
        .filter((message) => message.role === "toolResult")
        .every((message) => sumToolResultTextChars([message]) <= 32_000),
    ).toBe(true);
    expect(JSON.stringify(submittedCurrentPromptMessages)).toContain("truncated");
    expect(afterTurn).toHaveBeenCalledTimes(1);
    expect(sumToolResultTextChars(afterTurnMessages)).toBeGreaterThan(4_000);
    expect(JSON.stringify(afterTurnMessages)).not.toContain("truncated");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
