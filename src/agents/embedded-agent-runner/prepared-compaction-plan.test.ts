import { expect, it, vi } from "vitest";
import { MAX_SUMMARY_INPUT_CHARS } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import * as requestBudget from "../sessions/compaction/request-budget.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import { prepareCompactionPlan } from "./prepared-compaction-plan.js";

const options = {
  work: {
    itemId: "compaction",
    mode: "manual" as const,
    summaryOutputPolicy: "none" as const,
    settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
  },
  qualityGuardEnabled: true,
};

it("keeps long row-number selections separate from bounded textual facts", () => {
  const entries: SessionEntry[] = Array.from({ length: 20_000 }, (_, index) => ({
    type: "message",
    id: "entry-" + index,
    parentId: index ? "entry-" + (index - 1) : null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "Request " + index, timestamp: index },
  }));
  const sequences = new Map(entries.map((entry, index) => [entry.id, 1_000_000_000 + index]));
  const result = prepareCompactionPlan(entries, sequences, options);
  if (result.status !== "prepared") {
    throw new Error(
      "Long native rows lost their private preparation eligibility: " + result.reason,
    );
  }
  expect(result.plan.selections.history).toEqual(
    Array.from({ length: 19_999 }, (_, index) => 1_000_000_000 + index),
  );
  expect(result.plan.retained).toEqual([entries.at(-1)]);
  expect(JSON.stringify(result.plan).length).toBeGreaterThan(MAX_SUMMARY_INPUT_CHARS);
  expect(result.plan.floor.userLines.join("").length).toBeLessThan(8000);
});

it("records equal projected wrappers from their distinct source rows", () => {
  const entries: SessionEntry[] = [
    {
      type: "custom_message",
      id: "custom",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "fixture",
      content: "Visible custom input",
      display: true,
    },
    {
      type: "custom_message",
      id: "custom-twin",
      parentId: "custom",
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "fixture",
      content: "Visible custom input",
      display: true,
    },
    {
      type: "message",
      id: "request",
      parentId: "custom-twin",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Current request", timestamp: 1 },
    },
  ];
  const result = prepareCompactionPlan(
    entries,
    new Map(entries.map((entry, index) => [entry.id, 40 + index])),
    options,
  );
  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") {
    throw new Error("Custom message lost its recorded projection source");
  }
  expect(result.plan.selections.history).toEqual([40, 41]);
});

it.each([false, true])(
  "only calculates the consumed replay fallback (foreground budget=%s)",
  (budgeted) => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "past",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Earlier request", timestamp: 1 },
      },
      {
        type: "message",
        id: "retained",
        parentId: "past",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Current request", timestamp: 2 },
      },
    ];
    const replay = vi.spyOn(requestBudget, "replayTokenBudget");
    try {
      const result = prepareCompactionPlan(
        entries,
        new Map(entries.map((entry, index) => [entry.id, index])),
        {
          ...options,
          work: {
            ...options.work,
            ...(budgeted
              ? {
                  contextWindow: 32_000,
                  requestBudget: requestBudget.createCompactionRequestBudget({
                    contextWindow: 32_000,
                    reserveTokens: 1000,
                    systemPrompt: "",
                    tools: [],
                  }),
                }
              : {}),
          },
        },
      );
      if (result.status !== "prepared") {
        throw new Error(
          "Replay budget fixture lost its real compaction preparation: " + result.reason,
        );
      }
      expect(result.plan.preparation.summaryTokenBudget !== undefined).toBe(budgeted);
      expect(replay).toHaveBeenCalledTimes(budgeted ? 0 : 1);
      if (budgeted) {
        expect(result.plan.summaryReplayTokenBudget).toBeUndefined();
      }
    } finally {
      replay.mockRestore();
    }
  },
);
