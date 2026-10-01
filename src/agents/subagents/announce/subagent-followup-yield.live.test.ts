import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { isSilentReplyText } from "../../../auto-reply/tokens.js";
import { isTruthyEnvValue } from "../../../infra/env.js";
import { extractFirstTextBlock } from "../../../shared/chat-message-content.js";
import { isLiveTestEnabled } from "../../live-test-helpers.js";
import {
  countPendingDescendantRuns,
  listSubagentRunsForRequester,
} from "../registry/subagent-registry-read.js";
import {
  finalReplies,
  gateTask,
  history,
  runWithLiveSubagentGateway,
  successfulYields,
  until,
} from "./subagent-challenges.live.test-support.js";

const enabled = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_SUBAGENT_E2E);
const describeLive = enabled ? describe : describe.skip;

describeLive("watched child follow-up yield", () => {
  it(
    "yields for a queued follow-up after the child's original completion was delivered",
    async () => {
      await runWithLiveSubagentGateway(
        { additionalTools: ["sessions_send"] },
        async ({ gateway, gates, start, waitForFinal, record }) => {
          const id = randomUUID();
          const parentKey = `agent:main:live-followup-yield:${id}`;
          const initialMarker = `INITIAL_RECEIVED_${id}`;
          const initialResult = `INITIAL_RESULT_${randomUUID()}`;
          const followupMarker = `FOLLOWUP_RECEIVED_${id}`;
          const followupResult = `FOLLOWUP_RESULT_${randomUUID()}`;
          const initialGate = gates.create();
          const busyGate = gates.create();
          const followupGate = gates.create();

          await start(
            parentKey,
            [
              `Call sessions_spawn exactly once with ${JSON.stringify({
                taskName: "followup_worker",
                task: gateTask(initialGate.url),
                cleanup: "keep",
                context: "isolated",
              })}.`,
              "After acceptance call sessions_yield. Do not inspect files, execute commands, or fetch the result yourself.",
              `When the child completes, reply with ${initialMarker} on the first line and its exact result on the second line.`,
            ].join("\n"),
          );
          await until("original child held while parent yields", async () =>
            initialGate.snapshot().waiting === 1 && successfulYields(await history(parentKey)) === 1
              ? true
              : undefined,
          );
          initialGate.release(initialResult);
          await waitForFinal(parentKey, initialMarker, `${initialMarker}\n${initialResult}`);
          // The visible parent reply precedes the committed consumption of its completion wake.
          const child = await until("original completion wake committed", () =>
            listSubagentRunsForRequester(parentKey).find(
              (run) =>
                run.taskName === "followup_worker" &&
                run.delivery?.status === "delivered" &&
                run.requesterSettleWake === undefined,
            ),
          );
          expect(child).toMatchObject({
            taskName: "followup_worker",
            execution: { status: "terminal", outcome: { status: "ok" } },
            delivery: { status: "delivered" },
          });
          expect(child.requesterTurnRunId).toBeUndefined();
          expect(child.cleanupCompletedAt).toEqual(expect.any(Number));
          const childSessionKey = child.childSessionKey;
          record("original-completion-consumed", {
            parentKey,
            childSessionKey,
            runId: child.runId,
            delivery: child.delivery,
            cleanupCompletedAt: child.cleanupCompletedAt,
            wakeConsumed: child.requesterSettleWake === undefined,
          });

          await gateway.request("agent", {
            sessionKey: childSessionKey,
            message: gateTask(busyGate.url),
            idempotencyKey: randomUUID(),
            deliver: false,
            timeout: 300,
          });
          await until("existing child busy on a separate turn", () =>
            busyGate.snapshot().waiting === 1 ? true : undefined,
          );

          const beforeFollowup = (await history(parentKey)).length;
          await start(
            parentKey,
            [
              `Call sessions_send exactly once with ${JSON.stringify({
                sessionKey: childSessionKey,
                mode: "followup",
                watch: true,
                timeoutSeconds: 0,
                message: gateTask(followupGate.url),
              })}.`,
              "Immediately after acceptance call sessions_yield with no arguments. Do not spawn another worker, inspect files, execute commands, or fetch results yourself.",
              "Wait for the watched follow-up result. The child's previous background job is separate work and is not the requested result.",
              `When the follow-up completes, reply with ${followupMarker} on the first line and its exact result on the second line.`,
            ].join("\n"),
          );
          const yielded = await until(
            "requester attempts to yield for the queued follow-up",
            async () =>
              (await history(parentKey))
                .slice(beforeFollowup)
                .find(
                  (message) =>
                    message.role === "toolResult" && message.toolName === "sessions_yield",
                ),
          );
          const followupMessages = (await history(parentKey)).slice(beforeFollowup);
          const sent = followupMessages.find(
            (message) => message.role === "toolResult" && message.toolName === "sessions_send",
          );
          const sendReceipt = asOptionalRecord(
            sent?.details ?? JSON.parse(extractFirstTextBlock(sent) ?? "null"),
          );
          expect(sendReceipt).toMatchObject({
            runId: expect.any(String),
            status: "accepted",
            targetDisposition: "queued",
            watched: true,
            delivery: { status: "pending", mode: "announce" },
          });
          expect(
            yielded.details ?? JSON.parse(extractFirstTextBlock(yielded) ?? "null"),
          ).toMatchObject({
            status: "yielded",
          });
          expect(busyGate.snapshot().waiting).toBe(1);
          expect(followupGate.snapshot().requests).toBe(0);
          expect(finalReplies(followupMessages, followupMarker)).toEqual([]);
          record("queued-followup-claimed", { parentKey, childSessionKey });

          busyGate.release(`BACKGROUND_RESULT_${randomUUID()}`);
          await until("queued follow-up executes after the active child finishes", () =>
            followupGate.snapshot().waiting === 1 ? true : undefined,
          );
          followupGate.release(followupResult);
          const reply = await until(
            "follow-up result wakes its yielded requester",
            async () =>
              finalReplies((await history(parentKey)).slice(beforeFollowup), followupMarker)[0],
          );
          expect(reply).toBe(`${followupMarker}\n${followupResult}`);
          await until("follow-up completion wake committed", async () => {
            const completed = listSubagentRunsForRequester(parentKey).find(
              (run) => run.runId === sendReceipt?.runId,
            );
            return completed?.delivery?.status === "delivered" &&
              completed.requesterSettleWake === undefined &&
              (await countPendingDescendantRuns(parentKey, () => {})) === 0
              ? true
              : undefined;
          });
          const completedMessages = (await history(parentKey)).slice(beforeFollowup);
          const completionInputs = completedMessages.filter((message) => {
            const provenance = asOptionalRecord(message.provenance);
            return (
              message.role === "user" &&
              provenance?.kind === "inter_session" &&
              provenance.sourceTool === "subagent_settle" &&
              provenance.sourceSessionKey === childSessionKey
            );
          });
          expect(
            completionInputs,
            "the watched child produces exactly one completion wake",
          ).toHaveLength(1);
          expect(extractFirstTextBlock(completionInputs[0])).toContain(followupResult);
          // Session-state watches may produce an intentionally silent turn before completion.
          expect(
            finalReplies(completedMessages, "").filter((text) => !isSilentReplyText(text)),
          ).toEqual([`${followupMarker}\n${followupResult}`]);
          expect(successfulYields(completedMessages)).toBe(1);
          expect(
            completedMessages.some(
              (message) =>
                message.role === "toolResult" &&
                ["read", "exec", "process"].includes(String(message.toolName)),
            ),
            "the parent receives the child result through completion delivery",
          ).toBe(false);
          record("watched-followup-delivered-once", { parentKey, childSessionKey, reply });
        },
      );
    },
    15 * 60_000,
  );
});
