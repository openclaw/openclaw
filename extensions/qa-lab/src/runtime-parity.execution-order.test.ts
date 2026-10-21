import { describe, expect, it, vi } from "vitest";
import type { RuntimeId } from "./runtime-id.js";
import {
  isRuntimeParityResultPass,
  runRuntimeParityScenario,
  type RuntimeParityCell,
} from "./runtime-parity.js";

function makeCell(runtime: RuntimeId): RuntimeParityCell {
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

describe("runtime parity execution order", () => {
  it.each([
    [undefined, false],
    [["codex", "openclaw"], false],
    [["codex", "openclaw"], true],
  ] satisfies Array<[[RuntimeId, RuntimeId] | undefined, boolean]>)(
    "runs pair %j (Codex failure: %s) with canonical result cells",
    async (runtimePair, failCodex) => {
      const runCell = vi.fn(async (runtime: RuntimeId) => ({
        status: failCodex && runtime === "codex" ? ("fail" as const) : ("pass" as const),
        ...(failCodex && runtime === "codex" ? { details: "Codex scenario failed" } : {}),
        cell: makeCell(runtime),
      }));
      const result = await runRuntimeParityScenario({
        scenarioId: "runtime-execution-order",
        ...(runtimePair ? { runtimePair } : {}),
        runCell,
      });
      expect(runCell.mock.calls.map(([runtime]) => runtime)).toEqual(
        runtimePair ?? ["openclaw", "codex"],
      );
      expect(Object.keys(result.cells)).toEqual(["openclaw", "codex"]);
      expect(result).toMatchObject({
        cells: {
          openclaw: { runtime: "openclaw", status: "pass" },
          codex: { runtime: "codex", status: failCodex ? "fail" : "pass" },
        },
        drift: failCodex ? "failure-mode" : "none",
      });
      if (failCodex) {
        expect(result.cells.codex.details).toBe("Codex scenario failed");
        expect(result.driftDetails).toBe("runtime-pair cell status differs (pass vs fail)");
        expect(isRuntimeParityResultPass(result)).toBe(false);
      }
    },
  );

  it("rejects duplicate runtimes before executing a parity cell", async () => {
    const runCell = vi.fn(async (runtime: RuntimeId) => ({
      status: "pass" as const,
      cell: makeCell(runtime),
    }));
    await expect(
      runRuntimeParityScenario({
        scenarioId: "duplicate-runtime-pair",
        runtimePair: ["openclaw", "openclaw"],
        runCell,
      }),
    ).rejects.toThrow(/different|distinct|duplicate/i);
    expect(runCell).not.toHaveBeenCalled();
  });
});
