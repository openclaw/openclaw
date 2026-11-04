import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../../infra/env.js";
import { findSessionControllerEntries } from "../../../sessions/session-controller.state.js";
import { isLiveTestEnabled } from "../../live-test-helpers.js";
import {
  listSubagentRunsForRequester,
  testing,
} from "../registry/subagent-registry.test-helpers.js";
import {
  gateTask,
  runWithLiveSubagentGateway,
  until,
} from "./subagent-challenges.live.test-support.js";

const enabled = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_SUBAGENT_STRESS);
const describeLive = enabled ? describe : describe.skip;

function terminalTexts(messages: Record<string, unknown>[]): string[] {
  return messages.flatMap((message) => {
    if (
      message.role !== "assistant" ||
      message.phase === "commentary" ||
      !Array.isArray(message.content)
    ) {
      return [];
    }
    const content = message.content.map(asOptionalRecord);
    if (content.some((part) => part?.type === "toolCall")) {
      return [];
    }
    return [
      content
        .flatMap((part) =>
          part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
        )
        .join("\n"),
    ];
  });
}

describeLive("completed child custody after parent watchdog failure", () => {
  it(
    "surfaces a terminal outcome without repeating the child or parent operation",
    async () => {
      await runWithLiveSubagentGateway(
        {},
        async ({ gateway, gates, start, record, waitForDescendantSettlement }) => {
          const id = randomUUID().replaceAll("-", "");
          const parentKey = `agent:main:live-parent-stall:${id}`;
          const result = `CHILD_RESULT_${id}: the requested operation finished successfully.`;
          const childGate = gates.create();
          const parentGate = gates.create();
          await start(
            parentKey,
            [
              "Use sessions_spawn exactly once with these arguments:",
              JSON.stringify({
                task: gateTask(childGate.url),
                mode: "run",
                cleanup: "keep",
                context: "isolated",
              }),
              "After acceptance call sessions_yield. Do not do the child work yourself.",
              "When the child completes, perform the following one parent operation before replying. Do not send a visible reply before it finishes:",
              gateTask(parentGate.url, 1800),
            ].join("\n"),
          );
          await until("one child operation reaches its external gate", () =>
            childGate.snapshot().requests === 1 ? true : undefined,
          );
          childGate.release(result);
          await until("completed child starts one parent operation", () =>
            parentGate.snapshot().requests === 1 ? true : undefined,
          );
          const operation = await until(
            "parent owns an active continuation",
            () => findSessionControllerEntries(parentKey).find((entry) => entry.active)?.active,
          );
          // Advance only the production watchdog assessment clock, not global time or
          // session authority. The real watchdog owns the abort and its settlement.
          const snapshot = operation.watchdog.snapshot();
          const initialDecision = operation.watchdog.decide();
          const assessmentAt =
            expectDefined(initialDecision.deadlineAtMs, "active watchdog deadline") + 1;
          const candidate = operation.watchdog.decide(assessmentAt);
          record("parent-watchdog-assessment", { snapshot, initialDecision, candidate });
          expect(candidate).toMatchObject({ action: "stop", reason: "semantic_stall" });
          const assessment = operation.watchdog.tick(assessmentAt).then(
            (decision) => ({ ok: true as const, decision }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          try {
            await until(
              "watchdog aborts the parent continuation",
              () => (operation.abortSignal.aborted ? true : undefined),
              30_000,
            );
          } finally {
            parentGate.release("PARENT_OPERATION_RELEASED");
          }
          const assessed = await assessment;
          if (!assessed.ok) {
            throw assessed.error;
          }
          const { decision } = assessed;
          // Cancellation can return while owned cleanup is still settling. The
          // operation result, not the initial tick receipt, proves terminal failure.
          if (decision.action === "blocked") {
            expect(decision.reason).toBe("cleanup_pending");
          } else {
            expect(decision).toMatchObject({ action: "stop", reason: "semantic_stall" });
          }
          const terminalResult = await until(
            "watchdog parent reaches terminal failure",
            () => operation.result,
            30_000,
          );
          expect(terminalResult).toMatchObject({ kind: "failed", code: "run_stalled" });
          record("parent-watchdog-aborted", {
            decision,
            result: operation.result,
            childGate: childGate.snapshot(),
            parentGate: parentGate.snapshot(),
          });
          const visibleReplies = async () => {
            const response = asOptionalRecord(
              await gateway.request("chat.history", { sessionKey: parentKey, limit: 200 }),
            );
            const messages = Array.isArray(response?.messages)
              ? response.messages.flatMap((value) => {
                  const message = asOptionalRecord(value);
                  return message ? [message] : [];
                })
              : [];
            return terminalTexts(messages).filter((text) => text.includes(result));
          };
          const visible = await until(
            "terminal child outcome reaches the human-facing chat",
            async () => {
              const replies = await visibleReplies();
              return replies.length ? replies : undefined;
            },
          );
          expect(visible).toHaveLength(1);
          await waitForDescendantSettlement(parentKey);
          await testing.sweepOnceForTests();
          await testing.sweepOnceForTests();
          expect(await visibleReplies()).toEqual(visible);
          const children = listSubagentRunsForRequester(parentKey);
          expect(children).toHaveLength(1);
          expect(children[0]?.execution).toMatchObject({
            status: "terminal",
            outcome: { status: "ok" },
          });
          expect(childGate.snapshot()).toEqual({ requests: 1, waiting: 0, released: true });
          expect(parentGate.snapshot()).toEqual({ requests: 1, waiting: 0, released: true });
          record("parent-watchdog-recovered", {
            visible,
            childRunId: children[0]?.runId,
            childGate: childGate.snapshot(),
            parentGate: parentGate.snapshot(),
          });
        },
      );
    },
    15 * 60_000,
  );
});
