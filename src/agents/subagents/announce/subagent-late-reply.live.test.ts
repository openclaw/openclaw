import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../../infra/env.js";
import { isLiveTestEnabled } from "../../live-test-helpers.js";
import { listSubagentRunsForRequester } from "../registry/subagent-registry.test-helpers.js";
import {
  finalReplies,
  gateTask,
  history,
  runWithLiveSubagentGateway,
  until,
} from "./subagent-challenges.live.test-support.js";

const enabled = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_SUBAGENT_STRESS);
const describeLive = enabled ? describe : describe.skip;

describeLive("OpenAI requested child completion", () => {
  it(
    "delivers a requested late child result once with a visible parent answer",
    async () => {
      await runWithLiveSubagentGateway(
        { additionalTools: ["sessions_send"] },
        async ({ gateway, gates, start, record, waitForFinal }) => {
          const id = randomUUID().replaceAll("-", "");
          const parentKey = `agent:main:live-late-result:${id}`;
          const readyMarker = `READY_${id}`;
          const waitingMarker = `WAITING_${id}`;
          const parentMarker = `RESULT_${id}`;
          const lateResult = `CHILD_RESULT_${randomUUID()}`;
          await start(
            parentKey,
            [
              `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "kept_result_worker", visible: true, task: `Reply exactly ${readyMarker}. Do not call tools.`, cleanup: "keep", context: "isolated" })}.`,
              "This visible kept child is intentional. After acceptance call sessions_yield; do not call other tools or send messages.",
              `When the child completes, reply exactly ${readyMarker}.`,
            ].join("\n"),
          );
          await waitForFinal(parentKey, readyMarker, readyMarker);
          const children = listSubagentRunsForRequester(parentKey);
          expect(children).toHaveLength(1);
          const child = children[0]!;
          const gate = gates.create();
          const followup = await start(
            parentKey,
            [
              "This is a new request using the existing child, not a request to create another task.",
              `Call sessions_send exactly once with ${JSON.stringify({ sessionKey: child.childSessionKey, message: gateTask(gate.url), timeoutSeconds: 0 })}.`,
              `After the send is accepted, finish this turn with exactly ${waitingMarker}. Do not call sessions_yield, spawn, read, exec, or poll the child yourself.`,
              `When the actual late child result arrives, your required user-facing final is ${parentMarker} on the first line and the exact child result on the second line. Do not send a message or acknowledgement back to the child.`,
            ].join("\n"),
          );
          await until("late child request reaches the closed external gate", () =>
            gate.snapshot().waiting === 1 ? true : undefined,
          );
          const parentTurn = await until(
            "parent waiting turn finishes before the child result",
            async () => {
              const outcome = await gateway.request<{ status: string }>("agent.wait", {
                runId: followup.runId,
                timeoutMs: 1000,
              });
              return outcome.status === "ok" || outcome.status === "error" ? outcome : undefined;
            },
          );
          expect(parentTurn.status).toBe("ok");
          const before = await history(parentKey);
          expect(finalReplies(before, waitingMarker)).toEqual([waitingMarker]);
          expect(finalReplies(before, parentMarker)).toEqual([]);
          const sends = before.filter(
            (message) => message.role === "toolResult" && message.toolName === "sessions_send",
          );
          expect(sends).toHaveLength(1);
          expect(sends[0]?.details).toMatchObject({
            status: "accepted",
            targetDisposition: "queued",
            delivery: { status: "pending" },
          });
          expect(gate.snapshot()).toEqual({ requests: 1, waiting: 1, released: false });
          record("late-child-held", {
            parentKey,
            childKey: child.childSessionKey,
            gate: gate.snapshot(),
          });
          gate.release(lateResult);
          const expected = `${parentMarker}\n${lateResult}`;
          const rawFinal = await until(
            "parent consumes the requested late result",
            async () => finalReplies(await history(parentKey), parentMarker)[0],
          );
          const rawMessages = await history(parentKey);
          const projected = await gateway.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: parentKey,
            limit: 80,
          });
          const visibleMessages = projected.messages.flatMap((value) => {
            const message = asOptionalRecord(value);
            return message ? [message] : [];
          });
          record("late-child-parent-answer", {
            parentKey,
            childKey: child.childSessionKey,
            rawFinal,
            visibleFinals: finalReplies(visibleMessages, parentMarker),
          });
          expect(rawFinal).toBe(expected);
          expect(
            finalReplies(visibleMessages, parentMarker),
            "the requested answer reaches the human-facing chat",
          ).toEqual([expected]);
          const completions = rawMessages.slice(before.length).filter((message) => {
            const provenance = asOptionalRecord(message.provenance);
            return (
              message.role === "user" &&
              provenance?.sourceSessionKey === child.childSessionKey &&
              provenance.sourceTool === "subagent_announce"
            );
          });
          expect(
            completions,
            "the requested late result is delivered once as a completion",
          ).toHaveLength(1);
          expect(JSON.stringify(completions[0]?.content)).toContain(lateResult);
          expect(
            visibleMessages.filter(
              (message) =>
                message.role === "user" && JSON.stringify(message.content).includes(lateResult),
            ),
            "raw completion input remains internal",
          ).toEqual([]);
          expect(
            finalReplies(await history(child.childSessionKey), ""),
            "the child receives no automatic reply dance",
          ).toEqual([readyMarker, lateResult]);
          expect(listSubagentRunsForRequester(parentKey)).toHaveLength(1);
          expect(gate.snapshot()).toEqual({ requests: 1, waiting: 0, released: true });
        },
      );
    },
    15 * 60_000,
  );
});
