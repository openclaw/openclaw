import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import { afterAll, describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  readSessionTranscriptWatermark,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { UserMessage } from "../../../llm/types.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import { useSessionStoreTempDirs } from "../../../test-utils/session-state-cleanup.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import { Agent, type AgentEvent, type AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { jsonResult } from "../../tools/common.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import { useContextEngineAttemptHarness } from "./attempt-context-engine.test-support.js";
import { stripSessionsYieldArtifacts } from "./attempt-sessions-yield.js";
import {
  createDefaultEmbeddedSession,
  type EmbeddedAttemptSession,
  getHoisted,
} from "./attempt-spawn-workspace.test-support.js";

const interruptType = "openclaw.sessions_yield_interrupt";
const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-sessions-yield-");
const user = {
  role: "user",
  content: [{ type: "text", text: "continue" }],
  timestamp: 1,
} satisfies UserMessage;

function interrupt(): AgentMessage {
  return {
    role: "custom",
    customType: interruptType,
    content: "[sessions_yield interrupt]",
    display: false,
    details: { source: "sessions_yield" },
    timestamp: 3,
  };
}

async function seed(
  sessionManager: SessionManager,
  assistantCount: number,
  includeInterrupt = true,
) {
  const toolResult: AgentMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "sessions_spawn",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: 1,
  };
  const assistants = Array.from({ length: assistantCount }, (_, index) =>
    makeAgentAssistantMessage({
      content: [{ type: "text", text: `assistant ${index}` }],
      stopReason: index === assistantCount - 1 ? "aborted" : "stop",
      timestamp: index + 2,
    }),
  );
  for (const entry of [toolResult, ...assistants]) {
    await sessionManager.appendMessageAsync(entry);
  }
  if (includeInterrupt) {
    await sessionManager.appendCustomMessageEntryAsync(
      interruptType,
      "[sessions_yield interrupt]",
      false,
    );
  }
  return { toolResult, assistants };
}

function buildSession(messages: AgentMessage[], sessionManager: SessionManager) {
  return { messages, agent: { state: { messages: [...messages] } }, sessionManager };
}

async function persistentSession(label: string) {
  const dir = tempDirs.make();
  const scope = {
    agentId: "main",
    sessionId: `sessions-yield-${label}`,
    sessionKey: `agent:main:sessions-yield-${label}`,
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  return { dir, scope, sessionManager: await SessionManager.openAsync(scope, dir) };
}

describe("stripSessionsYieldArtifacts", () => {
  it("leaves a continuable suffix unchanged", async () => {
    const session = buildSession([user], SessionManager.inMemory());
    await stripSessionsYieldArtifacts(session);
    expect(session.agent.state.messages).toEqual([user]);
  });

  it.each([false, true])(
    "caps persisted assistant removal independently of persisted interrupt=%s",
    async (includeInterrupt) => {
      const sessionManager = SessionManager.inMemory();
      const { toolResult, assistants } = await seed(sessionManager, 4, includeInterrupt);
      const session = buildSession(
        [toolResult, ...assistants.slice(-2), ...(includeInterrupt ? [] : [interrupt()])],
        sessionManager,
      );
      await stripSessionsYieldArtifacts(session);
      expect(session.agent.state.messages).toEqual([toolResult]);
      const branch = sessionManager.getBranch();
      expect(
        branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
      ).toHaveLength(2);
      expect(
        branch.some(
          (entry) => entry.type === "custom_message" && entry.customType === interruptType,
        ),
      ).toBe(false);
    },
  );

  it("keeps live and durable histories unchanged when concurrent persistence wins", async () => {
    const { dir, scope, sessionManager } = await persistentSession("concurrent");
    const { toolResult, assistants } = await seed(sessionManager, 1);
    const marker = interrupt();
    const session = buildSession([toolResult, ...assistants, marker], sessionManager);
    await appendTranscriptMessage(scope, { cwd: dir, eventId: "concurrent", message: user });
    await expect(stripSessionsYieldArtifacts(session)).rejects.toThrow(
      "SQLite transcript changed while preparing suffix removal",
    );
    expect(session.agent.state.messages).toEqual([toolResult, ...assistants, marker]);
    expect(
      (await SessionManager.openAsync(scope, dir)).buildSessionContext().messages,
    ).toMatchObject([
      toolResult,
      ...assistants,
      { role: "custom", customType: interruptType },
      user,
    ]);
  });

  it("keeps SQLite history and trailing metadata available after multi-turn yield cleanup", async () => {
    const { dir, scope, sessionManager } = await persistentSession("sqlite");
    const { toolResult, assistants } = await seed(sessionManager, 3);
    await sessionManager.appendCustomEntryAsync("plugin-state", { enabled: true });
    const generationBefore = readSessionTranscriptWatermark(scope).generation;
    const session = buildSession([toolResult, ...assistants, interrupt()], sessionManager);
    await stripSessionsYieldArtifacts(session);
    expect(session.agent.state.messages).toEqual([toolResult]);
    expect(readSessionTranscriptWatermark(scope).generation).not.toBe(generationBefore);
    const reopened = await SessionManager.openAsync(scope, dir);
    expect(reopened.buildSessionContext().messages).toEqual([toolResult]);
    expect(reopened.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom",
          customType: "plugin-state",
          data: { enabled: true },
        }),
      ]),
    );
    expect(await loadTranscriptEvents(scope)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "custom_message", customType: interruptType }),
      ]),
    );
  });
});

function streamAttemptAssistant(model: Model, content: AssistantMessage["content"]) {
  const reason = content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop";
  const message = makeAgentAssistantMessage({
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsageFixture(),
    timestamp: Date.now(),
    content,
    stopReason: reason,
  });
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "done", reason, message });
    stream.end();
  });
  return stream;
}

function attemptToolCall(id: string, name: string) {
  return [{ type: "toolCall" as const, id, name, arguments: {} }];
}

function createAgentBackedAttemptSession(
  createAgent: (model: Model, tools: Agent["state"]["tools"]) => Agent,
): EmbeddedAttemptSession {
  const prepared = getHoisted().createAgentSessionMock.mock.calls.at(-1)?.[0];
  if (!prepared?.model || !prepared.customTools) {
    throw new Error("The embedded runner did not prepare its session tools");
  }
  const agent = createAgent(
    prepared.model,
    prepared.customTools.map((tool) => wrapToolDefinition(tool)),
  );
  const session: EmbeddedAttemptSession = createDefaultEmbeddedSession();
  const tools = agent.state.tools;
  session.agent = agent;
  Object.defineProperty(session, "messages", {
    get: () => agent.state.messages,
    set: (messages) => {
      agent.state.messages = messages;
    },
  });
  session.setActiveToolsByName = (names) => {
    agent.state.tools = tools.filter((tool) => names.includes(tool.name));
  };
  session.getActiveToolNames = () => agent.state.tools.map((tool) => tool.name);
  session.prompt = async (prompt, options) => {
    options?.preflightResult?.(true);
    await agent.prompt(prompt);
  };
  return session;
}

describe("embedded yield tool batch", () => {
  const { hoisted, runAttempt } = useContextEngineAttemptHarness("agent:main:yield-batch");

  it.each([false, true])("settles yielded siblings with external stop=%s", async (stop) => {
    const externalAbort = new AbortController();
    const stopError = new Error("operator stopped the turn");
    const yielded = createDeferred();
    const sideEffects: string[] = [];
    const outcomes: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
    let requests = 0;
    hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => {
      const params = expectDefined(options, "tool options");
      const sibling = (name: string) => ({
        ...createStubTool(name),
        execute: async (_id: string, _args: unknown, signal?: AbortSignal) => {
          await yielded.promise;
          signal?.throwIfAborted();
          sideEffects.push(name);
          return jsonResult({ exitCode: 0, sibling: name });
        },
      });
      return [
        sibling("before"),
        createSessionsYieldTool({
          sessionId: "embedded-session",
          claimYield: () => true,
          onYield: async (...args) => {
            await params.onYield?.(...args);
            if (stop) {
              externalAbort.abort(stopError);
            }
            yielded.resolve();
          },
        }),
        sibling("after"),
      ].map((tool) => wrapToolWithAbortSignal(tool, params.abortSignal));
    });

    const attemptResult = await runAttempt({
      attemptOverrides: {
        disableTools: false,
        abortSignal: externalAbort.signal,
        config: { tools: { codeMode: false, toolSearch: false } },
        sessionManager: SessionManager.inMemory(),
      },
      createSession: () => {
        let agent: Agent;
        const session = createAgentBackedAttemptSession((model, tools) => {
          agent = new Agent({
            initialState: { model, tools },
            streamFn: () => {
              requests++;
              return streamAttemptAssistant(
                model,
                requests === 1
                  ? [
                      ...attemptToolCall("before-call", "before"),
                      ...attemptToolCall("yield-call", "sessions_yield"),
                      ...attemptToolCall("after-call", "after"),
                    ]
                  : [{ type: "text", text: "Unexpected continuation" }],
              );
            },
          });
          agent.subscribe((event) => {
            if (event.type === "tool_execution_end") {
              outcomes.push(event);
            }
          });
          return agent;
        });
        session.abort = async (reason?: unknown) => {
          agent.abort(reason);
          await agent.waitForIdle();
        };
        return session;
      },
    }).catch((error: unknown) => {
      if (!stop) {
        throw error;
      }
      expect(error).toBe(stopError);
      return undefined;
    });

    expect(requests).toBe(1);
    expect(sideEffects).toEqual(stop ? [] : ["before", "after"]);
    expect(outcomes).toHaveLength(3);
    const outcomesByCallId = Object.fromEntries(
      outcomes.map((outcome) => [outcome.toolCallId, outcome]),
    );
    if (stop) {
      expect(outcomesByCallId).toMatchObject({
        "before-call": { toolName: "before", isError: true },
        "after-call": { toolName: "after", isError: true },
      });
      return;
    }
    expect(outcomesByCallId).toMatchObject({
      "before-call": {
        toolName: "before",
        isError: false,
        result: { details: { exitCode: 0, sibling: "before" } },
      },
      "yield-call": {
        toolName: "sessions_yield",
        isError: false,
        result: { details: { status: "yielded" } },
      },
      "after-call": {
        toolName: "after",
        isError: false,
        result: { details: { exitCode: 0, sibling: "after" } },
      },
    });
    expect(
      expectDefined(attemptResult, "yielded attempt").messagesSnapshot.filter(
        (message) => message.role === "toolResult",
      ),
    ).toHaveLength(3);
  });
});
