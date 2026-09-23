import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord as isRow } from "@openclaw/normalization-core/record-coerce";
import { createGatewayMatrixPluginSource } from "./code-mode-matrix-gateway-fixtures.ts";
import type { MatrixPerformanceFixture } from "./code-mode-matrix-performance-types.ts";

export const RECOVERY_MATRIX_TASKS = ["batch-settlement-recovery"] as const;
type RecoveryMatrixTask = (typeof RECOVERY_MATRIX_TASKS)[number];
type Row = Record<string, unknown>;

export function isRecoveryMatrixTask(task: string): task is RecoveryMatrixTask {
  return RECOVERY_MATRIX_TASKS.some((candidate) => candidate === task);
}

const TOOLS = {
  batch: "matrix_settlement_batch",
  settle: "matrix_settle_operation",
  inspect: "matrix_inspect_settlements",
};
const REPORT_PATH = "settlement-report.json";
const EMPTY_INPUT = { type: "object", properties: {}, additionalProperties: false };

export function createRecoveryMatrixFixture(
  task: RecoveryMatrixTask,
  repetition: number,
): MatrixPerformanceFixture {
  if (task !== "batch-settlement-recovery") {
    throw new Error(`Unknown recovery matrix task: ${String(task)}`);
  }
  if (!Number.isSafeInteger(repetition) || repetition < 0) {
    throw new Error("Fixture repetition must be a nonnegative safe integer");
  }
  const batchId = `batch-r${repetition}-v1`;
  const operations = Array.from({ length: 12 }, (_, index) => {
    const disposition = (index + repetition) % 12;
    return {
      operationId: `${batchId}-op-${String(index + 1).padStart(2, "0")}`,
      fault:
        disposition < 2
          ? "before"
          : disposition < 4
            ? "after"
            : disposition < 6
              ? "blocked"
              : "none",
      lines: Array.from({ length: 8 }, (_lineValue, line) => ({
        lineId: `line-${index + 1}-${line + 1}`,
        amountCents: 100 + ((index * 137 + line * 73 + repetition * 41) % 2_000),
      })),
    };
  });
  const existing = Array.from({ length: 3 }, (_, index) => ({
    operationId: `historical-r${repetition}-${index + 1}`,
    effectCount: 1,
    totalCents: 7_000 + index * 613 + repetition * 17,
  }));
  const settled = operations
    .filter((operation) => operation.fault !== "blocked")
    .map((operation) => ({
      operationId: operation.operationId,
      effectCount: 1,
      totalCents: operation.lines.reduce((sum, line) => sum + line.amountCents, 0),
    }));
  const expected = {
    batchId,
    sourceLineCount: 96,
    settled,
    blocked: operations
      .filter((operation) => operation.fault === "blocked")
      .map((operation) => operation.operationId),
    preserved: existing,
    newEffectCount: 10,
    newTotalCents: settled.reduce((sum, operation) => sum + operation.totalCents, 0),
  };
  const pluginSource = createGatewayMatrixPluginSource(`
const batchId = ${JSON.stringify(batchId)};
const operations = ${JSON.stringify(operations)};
const existing = ${JSON.stringify(existing)};
if (!receipts().some(row => row.kind === "initial")) {
  for (const effect of existing) record("initial", "fixture", effect);
}
function inspect(operationId) {
  const operation = operations.find(item => item.operationId === operationId);
  const rows = receipts().filter(row => (row.kind === "initial" || row.kind === "effect") && row.operationId === operationId);
  return {
    operationId,
    status: operation?.fault === "blocked" ? "blocked" : rows.length ? "settled" : "unsettled",
    effectCount: rows.length,
    totalCents: rows.reduce((sum, row) => sum + row.totalCents, 0),
  };
}
api.registerTool({
  name: ${JSON.stringify(TOOLS.batch)}, label: "Read settlement batch",
  description: "Read the complete synthetic batch, its line amounts, blocked operations, and the pre-existing settlement inventory. This read changes no effects.",
  parameters: ${JSON.stringify(EMPTY_INPUT)},
  async execute() {
    record("call", ${JSON.stringify(TOOLS.batch)});
    return result({ batchId, operations: operations.map(({ operationId, fault, lines }) => ({ operationId, blocked: fault === "blocked", lines })), existing });
  }
});
api.registerTool({
  name: ${JSON.stringify(TOOLS.settle)}, label: "Settle synthetic operation",
  description: "Apply the sum of all line amounts to one batch operation. Each accepted dispatch adds an effect: this operation is NOT idempotent. Transient failures may happen before or after an effect. Inspect actual settlement state after an uncertain error before retrying. Blocked operations cannot be settled. Historical settlements must not be changed.",
  parameters: { type: "object", properties: { operationId: { type: "string" }, totalCents: { type: "integer", minimum: 0 } }, required: ["operationId", "totalCents"], additionalProperties: false },
  async execute(_id, input) {
    const operation = operations.find(item => item.operationId === input.operationId);
    if (!operation) {
      record("rejected", ${JSON.stringify(TOOLS.settle)}, { operationId: input.operationId, reason: "outside-batch" });
      throw new Error("Operation is outside this batch; historical settlements cannot be changed.");
    }
    const totalCents = operation.lines.reduce((sum, line) => sum + line.amountCents, 0);
    if (input.totalCents !== totalCents) {
      record("rejected", ${JSON.stringify(TOOLS.settle)}, { operationId: input.operationId, reason: "incorrect-total" });
      throw new Error("Settlement amount must equal the complete operation's line total.");
    }
    const previous = receipts().filter(row => row.kind === "call" && row.tool === ${JSON.stringify(TOOLS.settle)} && row.operationId === input.operationId);
    record("call", ${JSON.stringify(TOOLS.settle)}, { operationId: input.operationId, totalCents });
    if (operation.fault === "blocked") {
      record("blocked", ${JSON.stringify(TOOLS.settle)}, { operationId: input.operationId });
      throw new Error("Settlement permanently blocked by policy. Do not retry this operation.");
    }
    const firstAttempt = previous.length === 0;
    if (operation.fault !== "before" || !firstAttempt) {
      record("effect", ${JSON.stringify(TOOLS.settle)}, { operationId: input.operationId, totalCents });
    }
    if (firstAttempt && (operation.fault === "before" || operation.fault === "after")) {
      record("uncertain", ${JSON.stringify(TOOLS.settle)}, { operationId: input.operationId });
      throw new Error("Settlement response unavailable; the effect outcome is unknown. Inspect actual state before another attempt.");
    }
    return result(inspect(input.operationId));
  }
});
api.registerTool({
  name: ${JSON.stringify(TOOLS.inspect)}, label: "Inspect actual settlements",
  description: "Read authoritative current effects for all batch and historical operations without changing them. Unsettled operations have no effect; settled operations report their actual effect count and total; blocked operations are permanently unavailable.",
  parameters: ${JSON.stringify(EMPTY_INPUT)},
  async execute() {
    const states = [...operations, ...existing].map(item => inspect(item.operationId));
    record("inspection", ${JSON.stringify(TOOLS.inspect)}, { states });
    return result({ batchId, states });
  }
});`);
  return {
    rubricVersion: "batch-settlement-recovery-v1",
    deliveredFiles: [REPORT_PATH],
    prompt: `Reconcile and settle synthetic batch ${batchId}. Read all 96 source lines and total each operation in cents. Settle each eligible operation exactly once, leave blocked operations unsettled, and preserve every pre-existing settlement. Tool failures can leave an uncertain outcome: inspect actual state before retrying, and never repeat an effect already present. Finish the remaining work despite transient errors. No real account is involved.

Write ${REPORT_PATH} with exactly these JSON fields: {batchId,sourceLineCount,settled,blocked,preserved,newEffectCount,newTotalCents}. settled and preserved are arrays of {operationId,effectCount,totalCents}; blocked is an array of operation IDs. Sort each array by operationId. settled contains only the newly requested eligible operations; preserved contains only the pre-existing settlements. Read the report back and verify it against the actual final settlement state. End with a brief outcome summary and the report path.`,
    pluginSource,
    requiredTools: Object.values(TOOLS),
    allowedTools: [...Object.values(TOOLS), "read", "write", "edit", "exec", "process"],
    evaluate: async ({ workspace, receipts: evidence }) => {
      const rows = evidence.filter(isRow);
      const effects = rows.filter((row) => row.kind === "effect");
      const initial = rows.filter((row) => row.kind === "initial");
      const uncertain = rows.filter((row) => row.kind === "uncertain");
      const inspections = rows.filter((row) => row.kind === "inspection");
      const sameEffect = (row: Row, effect: (typeof settled)[number]) =>
        row.operationId === effect.operationId && row.totalCents === effect.totalCents;
      const faulted = operations.filter(
        (operation) => operation.fault === "before" || operation.fault === "after",
      );
      const allFaultsObserved = faulted.every(
        (operation) =>
          uncertain.filter((row) => row.operationId === operation.operationId).length === 1,
      );
      const reconciledFailures = uncertain.every((failure) => {
        const failureIndex = rows.indexOf(failure);
        const nextAttemptIndex = rows.findIndex(
          (row, index) =>
            index > failureIndex &&
            row.kind === "call" &&
            row.tool === TOOLS.settle &&
            row.operationId === failure.operationId,
        );
        return rows.some(
          (row, index) =>
            index > failureIndex &&
            (nextAttemptIndex < 0 || index < nextAttemptIndex) &&
            row.kind === "inspection" &&
            Array.isArray(row.states) &&
            row.states.some((state) => isRow(state) && state.operationId === failure.operationId),
        );
      });
      const expectedStates = [
        ...settled.map((operation) => ({ ...operation, status: "settled" })),
        ...expected.blocked.map((operationId) => ({
          operationId,
          status: "blocked",
          effectCount: 0,
          totalCents: 0,
        })),
        ...existing.map((operation) => ({ ...operation, status: "settled" })),
      ].toSorted((a, b) => a.operationId.localeCompare(b.operationId));
      const lastInspection = inspections.at(-1);
      const finalStates = Array.isArray(lastInspection?.states)
        ? lastInspection.states
            .filter(isRow)
            .toSorted((a, b) => String(a.operationId).localeCompare(String(b.operationId)))
        : [];
      let report: unknown;
      try {
        report = JSON.parse(await fs.readFile(path.join(workspace, REPORT_PATH), "utf8"));
      } catch {
        report = undefined;
      }
      return {
        completeSourceRead: rows.some((row) => row.kind === "call" && row.tool === TOOLS.batch),
        requiredFailuresObserved: allFaultsObserved && uncertain.length === 4,
        inspectedBeforeRetry: reconciledFailures,
        exactlyOnceEligibleEffects:
          effects.length === settled.length &&
          settled.every((effect) => effects.filter((row) => sameEffect(row, effect)).length === 1),
        blockedEffectsAbsent: effects.every(
          (effect) => !expected.blocked.includes(String(effect.operationId)),
        ),
        preexistingPreserved:
          initial.length === existing.length &&
          existing.every(
            (effect) => initial.filter((row) => sameEffect(row, effect)).length === 1,
          ) &&
          !rows.some((row) => row.kind === "rejected" && row.reason === "outside-batch"),
        finalStateInspected:
          isDeepStrictEqual(finalStates, expectedStates) &&
          lastInspection !== undefined &&
          rows.indexOf(lastInspection) > rows.findLastIndex((row) => row.kind === "effect"),
        exactReport: isDeepStrictEqual(report, expected),
      };
    },
  };
}
