import { expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  capturePendingFinalRecoverySource,
  matchesPendingFinalRecoverySource,
} from "./pending-final-recovery-source.js";

const original: SessionEntry = {
  sessionId: "A",
  lifecycleRevision: "generation",
  updatedAt: 1,
  restartRecoveryDeliveryRunId: "announce:source",
  restartRecoveryDeliverySourceRunId: "announce:source",
  restartRecoveryDeliveryContext: { channel: "discord", to: "original-room" },
  restartRecoveryHarnessCompletion: {
    taskId: "task",
    taskRunId: "task-run",
    taskStatus: "succeeded",
    sourceRunId: "announce:source",
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    sessionId: "A",
    lifecycleRevision: "generation",
  },
};
const transitions = [
  {
    previous: { sessionId: "A", lifecycleRevision: "generation" },
    current: { sessionId: "B", lifecycleRevision: "generation" },
  },
  {
    previous: { sessionId: "B", lifecycleRevision: "generation" },
    current: { sessionId: "C", lifecycleRevision: "generation" },
  },
];
const current: SessionEntry = {
  ...original,
  sessionId: "C",
  restartRecoveryHarnessCompletion: {
    ...original.restartRecoveryHarnessCompletion!,
    sessionId: "C",
  },
};

it("retains frozen source/task/route custody through two exact host transitions", () => {
  const admitted = capturePendingFinalRecoverySource(original)!;
  expect(matchesPendingFinalRecoverySource(current, admitted, transitions)).toBe(true);
  expect(admitted.sessionId).toBe("A");
  expect(admitted.restartRecoveryHarnessCompletion).toEqual(
    original.restartRecoveryHarnessCompletion,
  );
  expect(Object.isFrozen(admitted.restartRecoveryHarnessCompletion)).toBe(true);
});
it.each(["no-chain", "gap", "lifecycle", "task", "route", "source"] as const)(
  "rejects %s instead of rebasing admitted custody",
  (variant) => {
    const admitted = capturePendingFinalRecoverySource(original)!;
    const observed = structuredClone(current);
    let chain = transitions;
    if (variant === "no-chain") {
      chain = [];
    }
    if (variant === "gap") {
      chain = transitions.slice(1);
    }
    if (variant === "lifecycle") {
      observed.lifecycleRevision = "unrelated";
    }
    if (variant === "task") {
      observed.restartRecoveryHarnessCompletion!.taskId = "other-task";
    }
    if (variant === "route") {
      observed.restartRecoveryDeliveryContext!.to = "other-room";
    }
    if (variant === "source") {
      observed.restartRecoveryDeliverySourceRunId = "other-source";
    }
    expect(matchesPendingFinalRecoverySource(observed, admitted, chain)).toBe(false);
  },
);
