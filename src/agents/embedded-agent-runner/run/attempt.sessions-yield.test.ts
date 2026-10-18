import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  readSessionTranscriptWatermark,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { UserMessage } from "../../../llm/types.js";
import {
  captureCurrentReplyMessageInjectionTarget,
  findSessionControllerOperationByRunId,
  submitSessionControllerSteer,
  type ReplyOperation,
  type SessionControllerSteerResult,
} from "../../../sessions/session-controller.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { useSessionStoreTempDirs } from "../../../test-utils/session-state-cleanup.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import { stripSessionsYieldArtifacts } from "./attempt-sessions-yield.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
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

describe("runEmbeddedAttempt sessions_yield", () => {
  const hoisted = getHoisted();
  const harnessPaths: string[] = [];
  beforeAll(preloadRunEmbeddedAttemptForTests);
  beforeEach(() => resetEmbeddedAttemptHarness());
  afterEach(async () => {
    await cleanupTempPaths(harnessPaths.splice(0));
  });

  it("records the yield and keeps a steer that captured the ending turn queued", async () => {
    const sessionKey = "agent:main:sessions-yield-steer";
    const runId = "sessions-yield-steer-run";
    const sessionSteer = vi.fn(async () => {});
    const yieldInterrupt = vi.fn();
    let operation: ReplyOperation | undefined;
    let input: SessionControllerInput | undefined;
    let duringYield: { phase?: string; result?: unknown } | undefined;
    let steerOutcome: Promise<SessionControllerSteerResult> | undefined;
    let yieldOutcome: Promise<unknown> | undefined;
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths: harnessPaths,
      attemptOverrides: { disableTools: false, runId },
      sessionPrompt: async (session) => {
        session.steer = sessionSteer;
        // The runtime queues its own interrupt through the agent when the turn yields.
        Object.assign(session.agent, { steer: yieldInterrupt });
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
        // The aborted prompt can return before this tool result; the test awaits it below.
        yieldOutcome = yieldTool.execute("yield", {});
        await yieldOutcome;
      },
    });

    // The tool finishes on its own result after yield() closed the turn's tool authority.
    await expect(yieldOutcome).resolves.toMatchObject({ details: { status: "yielded" } });
    expect(duringYield).toEqual({ phase: "running", result: null });
    await expect(steerOutcome).resolves.toMatchObject({
      status: "rejected",
      reason: "not_running",
    });
    expect(yieldInterrupt).toHaveBeenCalledOnce();
    expect(sessionSteer).not.toHaveBeenCalled();
    expect(operation?.result).toEqual({ kind: "completed" });
    // The rejected steer keeps its mailbox place for the followup after the turn ends.
    const queued = expectDefined(input, "steer input");
    expect(queued.phase).toBe("preparing");
    expect(queued.mailbox.entries).toContain(queued);
    retireSessionControllerInput(queued);
  });
});
