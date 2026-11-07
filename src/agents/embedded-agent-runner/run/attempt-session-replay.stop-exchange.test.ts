// Repro: a /stop command exchange mirrored after a queued follow-up's persisted
// user turn, and before that turn's replay admission, makes the follow-up fail
// without a model call. Compare the Workshop notice case, which replays once.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { recordDeliveredCommandExchange } from "../../../config/sessions/command-transcript.js";
import { loadTranscriptEventsSync } from "../../../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../../../config/sessions/transcript.runtime.js";
import { PLUGIN_NOTICE_KIND } from "../../../shared/transcript-only-openclaw-assistant.js";
import {
  createAssistant,
  createAssistantResultStream,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { sessionManagerPrepareCurrentTurnReplay } from "../../sessions/session-manager-current-turn.js";
import { withInterruptedTurn, withReplaySession } from "./attempt-session-replay.test-support.js";

registerAgentSessionLoopTestLifecycle();

type Fixture = Parameters<Parameters<typeof withInterruptedTurn>[1]>[0];

const appendStopExchange = (fixture: Fixture) =>
  vi.fn(async () => {
    const { target } = fixture;
    const recorded = await recordDeliveredCommandExchange({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      expectedSessionId: target.sessionId,
      storePath: target.storePath,
      config: {},
      commandText: "/stop",
      replyText: "Agent was aborted.",
      commandId: JSON.stringify(["telegram", "ratbot", "chat", "4052"]),
      replyId: "fast_abort",
    });
    expect(recorded.ok).toBe(true);
  });

const appendWorkshopNotice = (fixture: Fixture) =>
  vi.fn(async () => {
    const { attempt, target } = fixture;
    const appended = await appendAssistantMessageToSessionTranscript({
      ...target,
      expectedSessionId: target.sessionId,
      idempotencyKey: `skill-workshop-notice:${attempt.runId}`,
      text: "One skill changed after review",
      deliveryMirror: {
        kind: PLUGIN_NOTICE_KIND,
        pluginId: "skill-workshop",
        type: "skills-changed",
        data: { agentId: target.agentId, runId: "background-review" },
      },
    });
    expect(appended.ok).toBe(true);
  });

async function runAcross(
  makeAppend: (fixture: Fixture) => ReturnType<typeof vi.fn>,
  selectedOwner: boolean,
) {
  const outcome: {
    modelCalls?: number;
    thrown?: string;
    lastError?: unknown;
    lastText?: string;
    keyedUsers?: number;
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
                // The writer lands after selection, before anchor validation.
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
          const last = session.messages.at(-1);
          outcome.lastError = last ? Reflect.get(last, "errorMessage") : undefined;
          outcome.lastText = session.getLastAssistantText();
          const events = loadTranscriptEventsSync(fixture.target);
          const keyed = (key: (k: string) => boolean) =>
            events.filter(
              (entry) =>
                isRecord(entry) &&
                isRecord(entry.message) &&
                typeof entry.message.idempotencyKey === "string" &&
                key(entry.message.idempotencyKey),
            ).length;
          outcome.keyedUsers = keyed((k) => k === `${fixture.attempt.runId}:user`);
          outcome.commandInputs = keyed((k) => k.startsWith("command-input:"));
        },
        selectedOwner ? { afterReplayPreparation: append } : {},
      );
    },
    { selectedOwner },
  );
  return outcome;
}

const appendNothing = () => vi.fn(async () => {});

describe("queued follow-up replay admission vs. a /stop command exchange", () => {
  it.each([false, true])(
    "control: with no interposed write the follow-up is answered (selected reader: %s)",
    async (selectedOwner) => {
      const outcome = await runAcross(appendNothing, selectedOwner);
      console.log("no-writer outcome", JSON.stringify(outcome));
      expect(outcome.modelCalls).toBe(1);
      expect(outcome.lastText).toBe("FOLLOWUP_ANSWERED");
      expect(outcome.keyedUsers).toBe(1);
    },
  );

  it.each([false, true])(
    "control: a Workshop notice is replayed across once (selected reader: %s)",
    async (selectedOwner) => {
      const outcome = await runAcross(appendWorkshopNotice, selectedOwner);
      console.log("workshop-notice outcome", JSON.stringify(outcome));
      expect(outcome.modelCalls).toBe(1);
      expect(outcome.lastText).toBe("FOLLOWUP_ANSWERED");
      expect(outcome.keyedUsers).toBe(1);
    },
  );

  it.each([false, true])(
    "replays the queued follow-up across an interposed /stop exchange (selected reader: %s)",
    async (selectedOwner) => {
      const outcome = await runAcross(appendStopExchange, selectedOwner);
      // The follow-up user turn is persisted exactly once and the /stop rows follow it.
      expect(outcome.keyedUsers).toBe(1);
      expect(outcome.commandInputs).toBe(1);
      // The command exchange is a transcript mirror, so it must not consume the follow-up's turn.
      expect(outcome.thrown ?? outcome.lastError).toBeUndefined();
      expect(outcome.modelCalls).toBe(1);
      expect(outcome.lastText).toBe("FOLLOWUP_ANSWERED");
    },
  );
});
