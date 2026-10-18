// QA Lab projects canonical runtime-pair results into suite scenario results.
import {
  isRuntimeParityResultPass,
  runtimeParityCellStatus,
  type RuntimeParityCell,
  type RuntimeParityResult,
} from "./runtime-parity.js";
import type { QaSuiteScenarioResult } from "./suite-types.js";

function formatRuntimeParityCellDetails(cell: RuntimeParityCell) {
  const errors = [cell.transportErrorClass, cell.runtimeErrorClass].filter(Boolean).join(", ");
  const sentinels = cell.sentinelFindings?.map((finding) => finding.kind).join(", ");
  return [
    `runtime=${cell.runtime}`,
    `wallMs=${cell.wallClockMs}`,
    ...(cell.bootstrapWallClockMs === undefined
      ? []
      : [`bootstrapMs=${cell.bootstrapWallClockMs}`]),
    `toolCalls=${cell.toolCalls.length}`,
    `finalChars=${cell.finalText.length}`,
    `tokens=${cell.usage.totalTokens}`,
    ...(errors ? [`errors=${errors}`] : []),
    ...(sentinels ? [`sentinels=${sentinels}`] : []),
  ].join(" ");
}

function runtimeParityScenarioResultStatus(result: RuntimeParityResult) {
  if (isRuntimeParityResultPass(result)) {
    return "pass";
  }
  const statuses = new Set(
    [result.cells.openclaw, result.cells.codex].map(runtimeParityCellStatus),
  );
  return !statuses.has("fail") && statuses.has("skip") ? "skip" : "fail";
}

export function buildRuntimeParityScenarioResult(params: {
  scenarioName: string;
  result: RuntimeParityResult;
}): QaSuiteScenarioResult {
  const driftStepStatus = runtimeParityScenarioResultStatus(params.result);
  return {
    name: params.scenarioName,
    status: driftStepStatus,
    details: params.result.driftDetails ?? `runtime drift classified as ${params.result.drift}`,
    steps: [
      ...[params.result.cells.openclaw, params.result.cells.codex].map((cell) => ({
        name: cell.runtime,
        status: runtimeParityCellStatus(cell),
        details: [cell.details, formatRuntimeParityCellDetails(cell)].filter(Boolean).join("\n"),
      })),
      {
        name: "runtime drift",
        status: driftStepStatus,
        details: params.result.driftDetails ?? params.result.drift,
      },
    ],
    runtimeParity: params.result,
  };
}
