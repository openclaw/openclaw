import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../../infra/env.js";
import { isLiveTestEnabled } from "../../live-test-helpers.js";
import { listSubagentRunsForRequester } from "../registry/subagent-registry-read.js";
import {
  finalReplies,
  history,
  runWithLiveSubagentGateway,
  successfulYields,
  until,
} from "./subagent-challenges.live.test-support.js";

const enabled = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_SUBAGENT_STRESS);
const describeLive = enabled ? describe : describe.skip;

describeLive("subagent message pause live", () => {
  it(
    "wakes the yielded requester with the child acknowledgment and later delivers completion",
    async () => {
      await runWithLiveSubagentGateway({}, async ({ gateway, gates, start, record }) => {
        const id = randomUUID();
        const parentKey = `agent:main:live-pause-requester:${id}`;
        const pauseMarker = `PAUSE-MARKER-${randomUUID()}`;
        const pauseReceived = `PAUSE_RECEIVED_${id}`;
        const childResult = `CHILD_COMPLETE_${randomUUID()}`;
        const completionReceived = `COMPLETION_RECEIVED_${id}`;
        const gate = gates.create();
        const script = `const response = await fetch(${JSON.stringify(gate.url)}); if (!response.ok) throw new Error(String(response.status)); console.log(await response.text());`;
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const command = [process.execPath, "--input-type=module", "-e", script]
          .map(quote)
          .join(" ");
        await start(
          parentKey,
          [
            `Call sessions_spawn exactly once with ${JSON.stringify({
              taskName: "pause_for_continuation",
              label: "Pause for continuation",
              runtime: "subagent",
              context: "isolated",
              cleanup: "keep",
              runTimeoutSeconds: 0,
              task: [
                `Run this exact command once with exec, allowing up to 300 seconds: ${command}`,
                "If it backgrounds, use process to collect its completed output before continuing. Do not retry it or call unrelated tools.",
                'After the command succeeds, call sessions_yield exactly once with waitFor:"message" and acknowledgment equal to the exact command stdout, without its trailing newline.',
                "Do not return a final result before yielding. Wait for an incoming continuation, then follow that continuation and return its requested result normally without yielding again.",
              ].join("\n"),
            })}.`,
            "After acceptance call sessions_yield immediately. Do not run the worker's command yourself or send any continuation.",
            `When the child reports it is paused, return a normal final reply with ${pauseReceived} on the first line and its exact acknowledgment on the next line. Do not call tools on that turn.`,
            `When the child's actual completion arrives later, return a normal final reply with ${completionReceived} on the first line and the child's exact result on the next line.`,
          ].join("\n"),
        );
        await until("parent yielded while child waits at the external gate", async () =>
          gate.snapshot().waiting === 1 && successfulYields(await history(parentKey)) === 1
            ? true
            : undefined,
        );
        // Only the child learns this marker, after the requester has yielded.
        gate.release(pauseMarker);
        const paused = await until("child paused awaiting a continuation", () =>
          listSubagentRunsForRequester(parentKey).find(
            (run) => run.pauseReason === "sessions_yield",
          ),
        );
        const pauseReply = await until(
          "requester receives the child's pause acknowledgment",
          async () => finalReplies(await history(parentKey), pauseReceived)[0],
          180_000,
        );
        expect(pauseReply).toBe(`${pauseReceived}\n${pauseMarker}`);
        expect(paused.execution.outcome).toBeUndefined();
        expect(paused.completion?.resultText).toBeUndefined();
        expect(listSubagentRunsForRequester(parentKey)).toEqual([
          expect.objectContaining({ runId: paused.runId, pauseReason: "sessions_yield" }),
        ]);
        expect(finalReplies(await history(paused.childSessionKey), "")).toEqual([]);
        record("pause-woke-requester", {
          parentKey,
          childSessionKey: paused.childSessionKey,
          runId: paused.runId,
          pauseMarker,
          pauseReply,
        });

        const resumed = await gateway.request<{ runId: string }>("sessions.send", {
          key: paused.childSessionKey,
          message: `Continue the original task. Do not call tools or yield again. Return your normal final reply exactly ${childResult}.`,
          idempotencyKey: randomUUID(),
        });
        const completionReply = await until(
          "requester receives the resumed child's actual completion",
          async () => finalReplies(await history(parentKey), completionReceived)[0],
          180_000,
        );
        expect(completionReply).toBe(`${completionReceived}\n${childResult}`);
        const completed = await until("child completion delivery committed", () =>
          listSubagentRunsForRequester(parentKey).find(
            (run) => run.runId === resumed.runId && run.delivery?.status === "delivered",
          ),
        );
        expect(completed).toMatchObject({
          taskRunId: paused.taskRunId ?? paused.runId,
          childSessionKey: paused.childSessionKey,
          requesterSessionKey: parentKey,
          execution: { status: "terminal", outcome: { status: "ok" } },
          completion: { resultText: childResult },
        });
        expect(completed.pauseReason).toBeUndefined();
        expect(resumed.runId).not.toBe(paused.runId);
        expect(finalReplies(await history(paused.childSessionKey), childResult)).toEqual([
          childResult,
        ]);
        expect(finalReplies(await history(parentKey), "")).toEqual([
          `${pauseReceived}\n${pauseMarker}`,
          `${completionReceived}\n${childResult}`,
        ]);
        record("resumed-child-completed", {
          originalRunId: paused.runId,
          resumedRunId: resumed.runId,
          childSessionKey: paused.childSessionKey,
          completionReply,
          deliveryStatus: completed.delivery?.status,
        });
      });
    },
    10 * 60_000,
  );
});
