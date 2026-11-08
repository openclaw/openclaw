import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { withReplyDispatcher } from "../../../auto-reply/dispatch-dispatcher.js";
import { dispatchReplyFromConfig } from "../../../auto-reply/reply/dispatch-from-config.js";
import { createReplyDispatcher } from "../../../auto-reply/reply/reply-dispatcher.js";
import { loadTranscriptEventsSync } from "../../../config/sessions/session-accessor.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import {
  createAssistant,
  createAssistantResultStream,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { sessionManagerPrepareCurrentTurnReplay } from "../../sessions/session-manager-current-turn.js";
import { withInterruptedTurn, withReplaySession } from "./attempt-session-replay.test-support.js";

registerAgentSessionLoopTestLifecycle();

it.each([false, true])(
  "replays a turn admitted after a /stop whose reply is delivered late (selected reader: %s)",
  async (selectedOwner) => {
    const delivering = createDeferred();
    const releaseDelivery = createDeferred();
    let stop: Promise<unknown> | undefined;
    // The Stop reply's delivery, and so its command exchange, completes inside the replay window.
    const deliverStop = vi.fn(async () => {
      releaseDelivery.resolve();
      await stop;
    });
    await withInterruptedTurn(
      false,
      async (fixture) => {
        const { attempt, target } = fixture;
        await withReplaySession(
          fixture,
          false,
          async (session, submit, manager) => {
            if (!selectedOwner) {
              const select = manager[sessionManagerPrepareCurrentTurnReplay].bind(manager);
              vi.spyOn(manager, sessionManagerPrepareCurrentTurnReplay).mockImplementationOnce(
                async (...args) => {
                  const selected = await select(...args);
                  await deliverStop();
                  return selected;
                },
              );
            }
            streamMocks.streamSimple.mockImplementation((model) =>
              createAssistantResultStream(createAssistant(model, "FOLLOWUP_ANSWERED")),
            );
            await submit();
            expect(deliverStop).toHaveBeenCalledOnce();
            expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
            expect(session.getLastAssistantText()).toBe("FOLLOWUP_ANSWERED");
            const rows = loadTranscriptEventsSync(target).flatMap((entry) => {
              const key =
                isRecord(entry) && isRecord(entry.message) && entry.message.idempotencyKey;
              return typeof key === "string" && /^command-|:user$/.test(key)
                ? [key === `${attempt.runId}:user` ? "user" : key.split(":")[0]]
                : [];
            });
            expect(rows).toEqual(["command-input", "command-reply", "user"]);
          },
          selectedOwner ? { afterReplayPreparation: deliverStop } : {},
        );
      },
      {
        selectedOwner,
        admitUserTurn: async (target, persist) => {
          const dispatcher = createReplyDispatcher({
            deliver: async () => {
              delivering.resolve();
              await releaseDelivery.promise;
              return { visibleReplySent: true };
            },
          });
          stop = withReplyDispatcher({
            dispatcher,
            run: () =>
              dispatchReplyFromConfig({
                cfg: { session: { store: target.storePath } },
                dispatcher,
                ctx: {
                  Body: "/stop",
                  RawBody: "/stop",
                  CommandBody: "/stop",
                  CommandAuthorized: true,
                  Provider: "telegram",
                  Surface: "telegram",
                  ChatType: "direct",
                  From: "telegram:1001",
                  To: "telegram:2002",
                  SessionKey: target.sessionKey,
                  MessageSid: `stop-${String(selectedOwner)}`,
                },
              }),
          });
          await delivering.promise;
          // The next accepted input persists its user row once the session admits its turn.
          let started = false;
          const turn = withSessionTurn(target, async () => {
            started = true;
            return await persist();
          });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          if (!started) {
            releaseDelivery.resolve();
          }
          return await turn;
        },
      },
    );
  },
);
