import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  readSessionTranscriptWatermark,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { UserMessage } from "../../../llm/types.js";
import type { ReplyOperation } from "../../../sessions/session-controller.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../../sessions/session-controller.message-injection.js";
import { findSessionControllerOperationByRunId } from "../../../sessions/session-controller.queries.js";
import {
  submitSessionControllerSteer,
  type SessionControllerSteerResult,
} from "../../../sessions/session-controller.steer.js";
import { useSessionStoreTempDirs } from "../../../test-utils/session-state-cleanup.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import { createRequesterYieldCallback } from "../../openclaw-tools.requester-yield.js";
import { Agent, type AgentEvent, type AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { jsonResult } from "../../tools/common.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import {
  attemptToolCall,
  createAgentBackedAttemptSession,
  streamAttemptAssistant,
} from "./attempt-agent.test-support.js";
import { useContextEngineAttemptHarness } from "./attempt-context-engine.test-support.js";
import { stripSessionsYieldArtifacts } from "./attempt-sessions-yield.js";

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

async function seed(sessionManager: SessionManager, count: number, includeInterrupt = true) {
  const toolResult = makeTextToolResult("call-1", "sessions_spawn", "result", false, 1);
  const assistants = Array.from({ length: count }, (_, index) =>
    makeAgentAssistantMessage({
      content: [{ type: "text", text: `assistant ${index}` }],
      stopReason: index === count - 1 ? "aborted" : "stop",
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
    expect(reopened.getEntries()).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "plugin-state",
        data: { enabled: true },
      }),
    );
    expect(await loadTranscriptEvents(scope)).not.toContainEqual(
      expect.objectContaining({ type: "custom_message", customType: interruptType }),
    );
  });
});

describe("runEmbeddedAttempt sessions_yield", () => {
  const sessionKey = "agent:main:sessions-yield-steer";
  const { hoisted, runAttempt } = useContextEngineAttemptHarness(sessionKey);

  it("records the yield and keeps a steer that captured the ending turn queued", async () => {
    const runId = "sessions-yield-steer-run";
    const sessionSteer = vi.fn(async () => {});
    let operation: ReplyOperation | undefined;
    let input: SessionControllerInput | undefined;
    let duringYield: { phase?: string; result?: unknown } | undefined;
    let steerOutcome: Promise<SessionControllerSteerResult> | undefined;
    let yieldOutcome: Promise<unknown> | undefined;
    await runAttempt({
      attemptOverrides: { disableTools: false, runId },
      sessionPrompt: async (session) => {
        session.steer = sessionSteer;
        operation = findSessionControllerOperationByRunId(runId);
        // The steer captures the running turn before the yield and reaches it after.
        const target = expectDefined(
          captureCurrentReplyMessageInjectionTarget(sessionKey),
          "running turn injection target",
        );
        const steer = reserveSessionControllerSource(sessionKey, { policy: { mode: "steer" } });
        input = steer;
        const onYield = expectDefined(
          hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0]?.onYield,
          "attempt onYield",
        );
        const yieldTool = createSessionsYieldTool({
          sessionId: "embedded-session",
          claimYield: () => true,
          onYield: (...args) => {
            const ended = onYield(...args);
            // The steer reaches the turn between the yield and the operation's settlement.
            duringYield = { phase: operation?.phase, result: operation?.result };
            steerOutcome = submitSessionControllerSteer({
              input: steer,
              target,
              text: "late steer",
              options: { steeringMode: "all" },
            });
            return ended;
          },
        });
        yieldOutcome = yieldTool.execute("yield", {});
        await yieldOutcome;
      },
    });

    await expect(yieldOutcome).resolves.toMatchObject({ details: { status: "yielded" } });
    expect(duringYield).toEqual({ phase: "running", result: null });
    await expect(steerOutcome).resolves.toMatchObject({
      status: "rejected",
      reason: "injection_unavailable",
    });
    expect(sessionSteer).not.toHaveBeenCalled();
    expect(operation?.result).toEqual({ kind: "completed" });
    // The rejected steer keeps its mailbox place for the followup after the turn ends.
    const queued = expectDefined(input, "steer input");
    expect(queued.phase).toBe("preparing");
    expect(queued.mailbox.entries).toContain(queued);
    retireSessionControllerInput(queued);
  });
});

describe("automation yield", () => {
  const sessionKey = "agent:main:cron:yield-job:run:turn";
  const { hoisted, runAttempt } = useContextEngineAttemptHarness(sessionKey);

  it("ends the automation turn successfully without another model request", async () => {
    const outcomes: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
    let requests = 0;
    hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => [
      createSessionsYieldTool({
        sessionId: "embedded-session",
        claimYield: createRequesterYieldCallback({
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
        }),
        onYield: options?.onYield,
      }),
    ]);
    const result = await runAttempt({
      attemptOverrides: {
        disableTools: false,
        config: { tools: { codeMode: false, toolSearch: false } },
        sessionManager: SessionManager.inMemory(),
      },
      createSession: () =>
        createAgentBackedAttemptSession((model, tools) => {
          const agent = new Agent({
            initialState: { model, tools },
            streamFn: () => {
              requests++;
              return streamAttemptAssistant(
                model,
                requests === 1
                  ? attemptToolCall("yield-call", "sessions_yield")
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
        }),
    });
    expect(outcomes).toMatchObject([
      {
        toolName: "sessions_yield",
        isError: false,
        result: { details: { status: "yielded", note: expect.stringContaining("scheduler") } },
      },
    ]);
    expect(requests).toBe(1);
    expect(result.yieldDetected).toBe(true);
  });
});

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
