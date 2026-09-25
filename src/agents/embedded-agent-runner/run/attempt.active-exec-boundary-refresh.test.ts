// Pipeline-level regression: mid-turn background exec visibility at the LLM boundary.
//
// Pinned defect (temporal, not scope): the runtime-facts carrier is built ONCE
// per attempt at prompt assembly (prepareEmbeddedAttemptPromptContext →
// buildRuntimeFactsContext). While the "Active exec sessions:" fragment is
// accurate at assembly time, a background exec started MID-TURN registers only
// after assembly, and every subsequent LLM boundary re-projects the SAME stale
// fragment (attempt-llm-boundary projectRuntimeContextMessages). The model
// therefore sees "Active exec sessions:\nnone" on every step of the very turn
// that started the process.
//
// This test drives the REAL pipeline: runEmbeddedAttempt assembles the attempt
// with no process running, the model's tool loop starts a REAL background exec
// through the real exec tool, and the NEXT LLM boundary (post-registration)
// must list that process instead of replaying the stale pre-registration
// fragment. After the process is stopped, the FOLLOWING boundary must drop it.
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSession } from "../../bash-process-registry.js";
import { createExecTool } from "../../bash-tools.exec-run.js";
import { createProcessTool } from "../../bash-tools.process.js";
import { Agent, type AgentMessage, type AgentTool } from "../../runtime/index.js";
import { agentSessionQueuePromptContext } from "../../sessions/agent-session-prompting.js";
import { convertToLlm as convertAgentMessagesToLlm } from "../../sessions/messages.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  createDefaultEmbeddedSession,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

const SESSION_KEY = "agent:main:main";
const BACKGROUND_SCRIPT = "setTimeout(() => process.exit(0), 30000)";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 8_192,
};

function streamAssistant(content: AssistantMessage["content"]) {
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsageFixture(),
    stopReason: content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end();
  });
  return stream;
}

/** Extracts all text content from one boundary's messages. */
function messageTexts(messages: Context["messages"]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          texts.push((part as { text: string }).text);
        }
      }
    }
  }
  return texts;
}

/** Extracts the projected "Active exec sessions:" section from one boundary. */
function findActiveExecSection(messages: Context["messages"]): string | undefined {
  for (const text of messageTexts(messages)) {
    const index = text.indexOf("Active exec sessions:");
    if (index >= 0) {
      return text.slice(index, index + 500);
    }
  }
  return undefined;
}

describe("runEmbeddedAttempt active-exec boundary visibility", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it("lists a mid-turn background exec at the next LLM boundary and drops it after exit", async () => {
    let startedSessionId: string | undefined;
    const realExecTool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: true,
      backgroundMs: 0,
      timeoutSec: 60,
      scopeKey: SESSION_KEY,
      sessionKey: SESSION_KEY,
    });
    const realProcessTool = createProcessTool({ scopeKey: SESSION_KEY });
    // Capture the registered session id without altering the real tool result.
    // vi.fn (beyond call recording) also keeps this file out of the content-based
    // unit-fast partition: otherwise-clean pipeline tests importing the stateful
    // spawn-workspace helper are routed to the fast lane and lose their project.
    const execExecute = vi.fn(async (toolCallId: string, args: unknown) => {
      const result = await (
        realExecTool as unknown as {
          execute: (
            id: string,
            args: unknown,
          ) => Promise<{ content: unknown[]; details?: unknown }>;
        }
      ).execute(toolCallId, args);
      const details = result.details as { sessionId?: string } | undefined;
      if (details?.sessionId) {
        startedSessionId = details.sessionId;
      }
      return result;
    });
    const execTool: AgentTool = {
      ...realExecTool,
      execute: execExecute as unknown as AgentTool["execute"],
    };

    hoisted.createOpenClawCodingToolsMock.mockImplementation(() => [execTool, realProcessTool]);

    const providerContexts: Context[] = [];
    const createSession = () => {
      const session = createDefaultEmbeddedSession();
      const options = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as {
        customTools: AgentTool[];
      };
      const allTools = options.customTools;
      const agent = new Agent({
        initialState: { model, tools: allTools },
        // Production-shaped boundary hooks: the embedded runner installs its
        // transform chain on a real Agent's transformContext/convertToLlm, so
        // the session must expose both for the runtime-context carrier
        // projection to run before each model step.
        transformContext: async (messages) => messages,
        convertToLlm: (messages) => convertAgentMessagesToLlm(messages),
        streamFn: (_activeModel, context) => {
          providerContexts.push(context);
          const turn = providerContexts.length;
          if (turn === 1) {
            // Assembled with no process running; the model starts one mid-turn.
            return streamAssistant([
              {
                type: "toolCall",
                id: "exec-start",
                name: "exec",
                arguments: {
                  command: `${process.execPath} -e ${JSON.stringify(BACKGROUND_SCRIPT)}`,
                  background: true,
                },
              },
            ]);
          }
          if (turn === 2) {
            // The process is verifiably registered now; request termination.
            return streamAssistant([
              {
                type: "toolCall",
                id: "process-kill",
                name: "process",
                arguments: { action: "kill", sessionId: startedSessionId },
              },
            ]);
          }
          if (turn === 3) {
            // Termination is asynchronous. Poll through the real process tool
            // (bounded wait) until the registry observes the actual exit, so
            // the next model boundary projects only after settlement.
            return streamAssistant([
              {
                type: "toolCall",
                id: "process-poll",
                name: "process",
                arguments: {
                  action: "poll",
                  sessionId: startedSessionId,
                  timeout: 10_000,
                },
              },
            ]);
          }
          return streamAssistant([{ type: "text", text: "boundaries verified" }]);
        },
      });
      session.agent = agent as typeof session.agent;
      Object.defineProperty(session, "messages", {
        get: () => agent.state.messages,
        set: (messages) => {
          agent.state.messages = messages;
        },
      });
      session.setActiveToolsByName = (toolNames) => {
        agent.state.tools = allTools.filter((tool) => toolNames.includes(tool.name));
      };
      session.getActiveToolNames = () => agent.state.tools.map((tool) => tool.name);
      // Production carrier-queue seam (agent-session-prompting.ts): submit queues
      // the runtime-context carrier via this symbol; the real session prepends it
      // to the prompt input consumed by the agent loop, then consumes the queue.
      let pendingNextTurnMessages: AgentMessage[] = [];
      (session as unknown as Record<symbol, (message: AgentMessage) => () => void>)[
        agentSessionQueuePromptContext
      ] = (message) => {
        pendingNextTurnMessages.unshift(message);
        return () => {
          pendingNextTurnMessages = pendingNextTurnMessages.filter(
            (pending) => pending !== message,
          );
        };
      };
      session.prompt = async (prompt, promptOptions) => {
        promptOptions?.preflightResult?.(true);
        const userMessage = {
          role: "user",
          content: [{ type: "text", text: String(prompt) }],
          timestamp: Date.now(),
        } as AgentMessage;
        const messages = [userMessage, ...pendingNextTurnMessages];
        pendingNextTurnMessages = [];
        await agent.prompt(messages);
      };
      return session;
    };

    try {
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        createSession,
        sessionKey: SESSION_KEY,
        tempPaths,
        attemptOverrides: {
          sessionManager: SessionManager.inMemory(),
          disableMessageTool: false,
          disableTools: false,
          toolsAllow: ["exec", "process"],
          model,
        },
      });

      expect(startedSessionId, "exec tool must have registered a background session").toBeDefined();
      expect(providerContexts.length, "expected four model steps").toBeGreaterThanOrEqual(4);

      // Boundary 1 (assembly time): no process was running, "none" is accurate.
      const sectionAtAssembly = findActiveExecSection(providerContexts[0]!.messages);
      expect(
        sectionAtAssembly,
        "runtime facts carrier must project the active-exec section",
      ).toBeDefined();
      expect(sectionAtAssembly).toContain("Active exec sessions:");
      expect(sectionAtAssembly).toContain("none");

      // Boundary 2 (next step after the exec tool returned "still running"):
      // the process is registered; the projection must list it instead of
      // replaying the stale pre-registration fragment. THIS is the pinned defect.
      const sectionMidRun = findActiveExecSection(providerContexts[1]!.messages);
      expect(
        sectionMidRun,
        "post-exec boundary must project the active-exec section",
      ).toBeDefined();
      expect(
        sectionMidRun,
        "next LLM boundary must list the mid-turn background exec instead of stale 'none'",
      ).toContain(startedSessionId!);

      // Termination was requested through the real process tool (async ack).
      const killTexts = messageTexts(providerContexts[2]!.messages);
      expect(
        killTexts.some((text) =>
          text.includes(`Termination requested for session ${startedSessionId}`),
        ),
        "termination must be requested through the real process tool",
      ).toBe(true);

      // Registry settlement is confirmed by the real poll path: the bounded
      // poll waits inside the tool until the registry observes the actual
      // exit, and its result reports the finished session.
      const settlementTexts = messageTexts(providerContexts[3]!.messages);
      expect(
        settlementTexts.some(
          (text) =>
            text.includes("Process stopped by request") || text.includes("Process exited with"),
        ),
        "poll must confirm the registry observed the actual exit",
      ).toBe(true);

      // Boundary after settlement: the finished process must no longer be listed.
      const sectionAfterStop = findActiveExecSection(providerContexts[3]!.messages);
      expect(
        sectionAfterStop,
        "post-settlement boundary must project the active-exec section",
      ).toBeDefined();
      expect(sectionAfterStop, "settled process must no longer be listed").not.toContain(
        startedSessionId!,
      );
    } finally {
      if (startedSessionId) {
        await realProcessTool
          .execute("cleanup-kill", { action: "kill", sessionId: startedSessionId } as never)
          .catch(() => undefined);
        deleteSession(startedSessionId);
      }
    }
  });
});
