// A queued follow-up is already persisted when a fast command mirror lands.
// /stop and /status must not steal replay admission. A later ordinary command
// or user message still does.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { recordDeliveredCommandExchange } from "../../../config/sessions/command-transcript.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
} from "../../../config/sessions/session-accessor.js";
import {
  createAssistant,
  createAssistantResultStream,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { sessionManagerPrepareCurrentTurnReplay } from "../../sessions/session-manager-current-turn.js";
import { withInterruptedTurn, withReplaySession } from "./attempt-session-replay.test-support.js";

registerAgentSessionLoopTestLifecycle();

type ReplayFixture = Parameters<Parameters<typeof withInterruptedTurn>[1]>[0];

const FOLLOW_UP = "Finish this exact turn";

function appendCommand(fixture: ReplayFixture, commandText: string, contextFree = false) {
  return vi.fn(async () => {
    const { target } = fixture;
    const recorded = await recordDeliveredCommandExchange({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      expectedSessionId: target.sessionId,
      storePath: target.storePath,
      config: {},
      commandText,
      replyText: contextFree ? "Status: ready." : `Reply for ${commandText}`,
      commandId: JSON.stringify(["telegram", "main", "chat", commandText]),
      replyId: "fast-command",
      ...(contextFree ? { contextFreeCommand: true as const } : {}),
    });
    expect(recorded.ok).toBe(true);
  });
}

function appendNewerUser(fixture: ReplayFixture) {
  return vi.fn(async () => {
    const { target } = fixture;
    await appendTranscriptMessage(
      {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        sessionId: target.sessionId,
        storePath: target.storePath,
      },
      {
        message: {
          role: "user",
          content: "A newer question",
          timestamp: Date.now(),
          idempotencyKey: "newer-user",
        },
      },
    );
  });
}

function userTexts(messages: readonly { role?: unknown; content?: unknown }[]): string[] {
  return messages.flatMap((message) =>
    message.role === "user" ? [JSON.stringify(message.content)] : [],
  );
}

async function runInterposed(
  makeAppend: (fixture: ReplayFixture) => ReturnType<typeof appendCommand>,
  selectedOwner: boolean,
  answered: boolean,
  absentPromptText?: string,
) {
  const outcome: {
    thrown?: string;
    modelCalls?: number;
    lastText?: string;
    promptUsers?: string[];
    commandInputs?: number;
  } = {};
  await withInterruptedTurn(
    false,
    async (fixture) => {
      const append = makeAppend(fixture);
      await withReplaySession(
        fixture,
        false,
        async (session, submit, manager) => {
          if (!selectedOwner) {
            const select = manager[sessionManagerPrepareCurrentTurnReplay].bind(manager);
            vi.spyOn(manager, sessionManagerPrepareCurrentTurnReplay).mockImplementationOnce(
              async (...args) => {
                const selected = await select(...args);
                await append();
                return selected;
              },
            );
          }
          streamMocks.streamSimple.mockImplementation((model) =>
            createAssistantResultStream(createAssistant(model, "FOLLOWUP_ANSWERED")),
          );
          try {
            await submit();
          } catch (error) {
            outcome.thrown = error instanceof Error ? error.message : String(error);
          }
          expect(append).toHaveBeenCalledOnce();
          outcome.modelCalls = streamMocks.streamSimple.mock.calls.length;
          outcome.lastText = session.getLastAssistantText();
          const prompt = streamMocks.streamSimple.mock.calls[0]?.[1];
          outcome.promptUsers = prompt ? userTexts(prompt.messages) : [];
          outcome.commandInputs = loadTranscriptEventsSync(fixture.target).filter(
            (entry) =>
              isRecord(entry) &&
              isRecord(entry.message) &&
              typeof entry.message.idempotencyKey === "string" &&
              entry.message.idempotencyKey.startsWith("command-input:"),
          ).length;
        },
        selectedOwner ? { afterReplayPreparation: append } : {},
      );
    },
    { selectedOwner },
  );
  if (answered) {
    expect(outcome.thrown).toBeUndefined();
    expect(outcome.modelCalls).toBe(1);
    expect(outcome.lastText).toBe("FOLLOWUP_ANSWERED");
    expect(outcome.commandInputs).toBe(1);
    expect(outcome.promptUsers?.filter((text) => text.includes(FOLLOW_UP))).toHaveLength(1);
    if (absentPromptText) {
      expect(outcome.promptUsers?.some((text) => text.includes(absentPromptText))).toBe(false);
    }
    return;
  }
  expect(outcome.modelCalls).toBe(0);
  expect(outcome.thrown ?? "").toMatch(/Persisted user turn changed before replay admission/);
}

describe("queued follow-up replay across a delayed command exchange", () => {
  it.each([false, true])(
    "answers the persisted follow-up once when /stop lands before admission (selected reader: %s)",
    async (selectedOwner) => {
      await runInterposed(
        (fixture) => appendCommand(fixture, "/stop"),
        selectedOwner,
        true,
        "/stop",
      );
    },
  );

  it.each([false, true])(
    "answers the persisted follow-up once when /status lands before admission (selected reader: %s)",
    async (selectedOwner) => {
      await runInterposed(
        (fixture) => appendCommand(fixture, "/status", true),
        selectedOwner,
        true,
        "/status",
      );
    },
  );

  it.each([false, true])(
    "still rejects admission when a context-bearing /model exchange supersedes the follow-up (selected reader: %s)",
    async (selectedOwner) => {
      await runInterposed(
        (fixture) => appendCommand(fixture, "/model openai/gpt-5.4"),
        selectedOwner,
        false,
      );
    },
  );

  it.each([false, true])(
    "still rejects admission when a newer user message supersedes the follow-up (selected reader: %s)",
    async (selectedOwner) => {
      await runInterposed(appendNewerUser, selectedOwner, false);
    },
  );
});
