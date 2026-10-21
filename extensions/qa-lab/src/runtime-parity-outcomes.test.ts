import { describe, expect, it } from "vitest";
import type { RuntimeId } from "./runtime-id.js";
import {
  captureRuntimeParityCell,
  isRuntimeParityResultPass,
  runRuntimeParityScenario,
  type RuntimeParityCell,
  type RuntimeParityScenarioExecution,
} from "./runtime-parity.js";

function makeRuntimeParityCell(runtime: RuntimeId): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"message":{"role":"assistant","content":"done"}}\n',
    toolCalls: [],
    finalText: "done",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    wallClockMs: 10,
    bootStateLines: [],
  };
}

type CellOutcome = Partial<Pick<RuntimeParityScenarioExecution, "status" | "details">> &
  Pick<RuntimeParityCell, "runtimeErrorClass">;

function runPair(codex: CellOutcome = {}, openclaw: CellOutcome = {}) {
  return runRuntimeParityScenario({
    scenarioId: "outcome-fixture",
    runCell: async (runtime) => {
      const { runtimeErrorClass, ...result } = runtime === "codex" ? codex : openclaw;
      return {
        status: "pass",
        ...result,
        cell: {
          ...makeRuntimeParityCell(runtime),
          ...(runtimeErrorClass ? { runtimeErrorClass } : {}),
        },
      };
    },
  });
}

describe("runtime parity outcomes", () => {
  it("keeps a skip diagnostic out of runtime error classification", async () => {
    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: { tempRoot: `/tmp/openclaw-qa-runtime-parity-missing-${process.pid}` },
      scenarioResult: {
        status: "skip",
        details: "expected-unavailable tool: this fixture is report-only",
      },
      wallClockMs: 10,
    });

    expect(cell.runtimeErrorClass).toBeUndefined();
  });

  it("does not claim both canonical runtime-pair cells failed for a one-sided failure", async () => {
    const result = await runPair({ runtimeErrorClass: "scenario-failure" });

    expect(result).toMatchObject({
      drift: "failure-mode",
      driftDetails: "at least one runtime failed",
    });
  });

  it("preserves skipped cell outcomes instead of promoting matching empty evidence", async () => {
    const skipped = { status: "skip", details: "implementation unavailable" } as const;
    const result = await runPair(skipped, skipped);

    expect(result).toMatchObject({
      cells: {
        openclaw: { status: "skip", details: "implementation unavailable" },
        codex: { status: "skip", details: "implementation unavailable" },
      },
      drift: "failure-mode",
      driftDetails: "both canonical runtime-pair cells skipped",
    });
    expect(isRuntimeParityResultPass(result)).toBe(false);
  });

  it("keeps one explicitly known harness gap advisory when its paired runtime passes", async () => {
    const result = await runPair({
      status: "skip",
      details: "known-harness-gap exec: Codex owns command execution natively\ntracking: #80319",
    });

    expect(result).toMatchObject({
      cells: { openclaw: { status: "pass" }, codex: { status: "skip" } },
      drift: "structural",
      driftDetails: "known harness gap in codex runtime; paired runtime passed",
    });
    expect(isRuntimeParityResultPass(result)).toBe(true);
  });

  it("keeps unannotated, doubly skipped, and failed known-gap cells blocking", async () => {
    const expectBlocked = async (codex: CellOutcome, openclaw: CellOutcome = {}) => {
      const result = await runPair(codex, openclaw);
      expect(result.drift).toBe("failure-mode");
      expect(isRuntimeParityResultPass(result)).toBe(false);
    };
    await expectBlocked({ status: "skip", details: "implementation unavailable" });
    const knownGap = { status: "skip", details: "known-harness-gap exec: tracked" } as const;
    await expectBlocked(knownGap, { status: "skip" });
    await expectBlocked({ ...knownGap, runtimeErrorClass: "auth" });
  });

  it("requires every canonical runtime-pair cell status to pass", async () => {
    const result = await runPair();

    expect(isRuntimeParityResultPass(result)).toBe(true);

    expect(
      isRuntimeParityResultPass({
        ...result,
        cells: { ...result.cells, codex: { ...result.cells.codex, status: "skip" } },
      }),
    ).toBe(false);

    expect(
      isRuntimeParityResultPass({
        ...result,
        cells: { openclaw: result.cells.openclaw } as typeof result.cells,
      }),
    ).toBe(false);
  });
});
