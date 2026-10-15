import { expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import type { SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";
import {
  hasMessagingToolDeliveryToSource,
  resolveRequesterRecoveryDelivery,
} from "../subagents/announce/subagent-announce-completion-delivery.js";
import { makePendingFinalDelivery } from "./main-session-restart-recovery-fixture.test-support.js";
import {
  makeAssistantTextMessage,
  makeMessageDeliveryTranscript,
  makeUserMessage,
} from "./main-session-restart-recovery-transcript.test-support.js";

type CheckpointFixture = {
  sessionsDir: string;
  storePath: string;
  sessionKey: string;
  readEntry: () => SessionEntry | undefined;
};

export function registerCheckpointReceiptTests({
  makeMainSessionFixture,
  makeDeliveredReceiptFixture,
  writeTranscript,
  expectRecovery,
  loadTestTranscript,
  discordDeliveryContext,
}: {
  makeMainSessionFixture: (overrides?: SessionEntryFixture) => Promise<CheckpointFixture>;
  makeDeliveredReceiptFixture: (
    toolCallId?: string,
    sourceRunId?: string,
    overrides?: SessionEntryFixture,
  ) => Promise<CheckpointFixture>;
  writeTranscript: (
    sessionsDir: string,
    sessionId: string,
    messages: readonly unknown[],
  ) => Promise<void>;
  expectRecovery: (expected: {
    started: number;
    settled: number;
    failed: number;
    skipped: number;
  }) => Promise<void>;
  loadTestTranscript: (
    sessionKey: string,
    storePath: string,
  ) => Promise<Array<{ message?: Record<string, unknown> }>>;
  discordDeliveryContext: { channel: string; to: string };
}) {
  it.each([
    { states: ["delivered"] as const, status: "sent", resultCount: 1 },
    { states: ["suppressed"] as const, status: "suppressed", resultCount: 0 },
    { states: ["delivered", "suppressed"] as const, status: "sent", resultCount: 1 },
  ])(
    "retains completion evidence for settled queue receipts: $states",
    async ({ states, status, resultCount }) => {
      const sourceRunId = "announce:checkpoint-queue";
      const { readEntry } = await makeMainSessionFixture({
        restartRecoveryDeliveryRunId: "recovery-queue",
        restartRecoveryDeliverySourceRunId: sourceRunId,
        pendingFinalDelivery: makePendingFinalDelivery("finished result", {
          deliveries: states.map((state, index) => ({ id: `settled-${index}`, state })),
        }),
      });

      await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

      expect(callGateway).not.toHaveBeenCalled();
      expect(resolveRequesterRecoveryDelivery(readEntry(), sourceRunId)).toMatchObject({
        kind: "result",
        result: {
          captured: true,
          deliveryStatus: { status, resultCount },
        },
      });
      expect(readEntry()?.pendingFinalDelivery).toBeUndefined();
    },
  );

  it.each([undefined, 0, "topic-7"])(
    "reconciles a receipt delivered during a restart-recovery continuation (thread=%s)",
    async (threadId) => {
      const route = {
        ...discordDeliveryContext,
        ...(threadId !== undefined ? { threadId: String(threadId) } : {}),
      };
      const { sessionsDir, storePath, sessionKey, readEntry } = await makeDeliveredReceiptFixture(
        "message-call-recovered",
        "discord-message-1",
        {
          restartRecoveryDeliveryContext: { ...discordDeliveryContext, threadId },
        },
      );
      await writeTranscript(
        sessionsDir,
        "main-session",
        makeMessageDeliveryTranscript({
          toolCallId: "message-call-recovered",
          beforeCall: [
            makeAssistantTextMessage("starting"),
            makeUserMessage("[System] continue after restart", {
              idempotencyKey: "recovery-1:user",
            }),
          ],
        }),
      );

      await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

      expect(callGateway).not.toHaveBeenCalled();
      expect(readEntry()).toMatchObject({
        status: "done",
        abortedLastRun: false,
        restartRecoveryTerminalRunIds: ["discord-message-1"],
      });
      const completion = resolveRequesterRecoveryDelivery(readEntry(), "discord-message-1");
      expect(completion?.kind).toBe("result");
      if (completion?.kind !== "result") {
        throw new Error("Confirmed recovery delivery did not retain its completion receipt");
      }
      expect(
        hasMessagingToolDeliveryToSource(completion.result, route, {
          requireFinalReply: true,
        }),
      ).toBe(true);
      expect(
        hasMessagingToolDeliveryToSource(
          completion.result,
          { channel: "discord", to: "discord:dm:other" },
          { requireFinalReply: true },
        ),
      ).toBe(false);
      const transcript = await loadTestTranscript(sessionKey, storePath);
      expect(
        transcript
          .map((event) => event.message)
          .some(
            (message) =>
              message?.idempotencyKey ===
              "restart-recovery:message-tool-result:discord-message-1:message-call-recovered",
          ),
      ).toBe(true);
    },
  );
}
