// QA Lab projects canonical runtime-pair results into suite scenario results.
import {
  isRuntimeParityResultPass,
  runtimeParityCellStatus,
  type RuntimeId,
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

function formatRuntimeParityScenarioCellDetails(cell: RuntimeParityResult["cells"][RuntimeId]) {
  return [cell.details, formatRuntimeParityCellDetails(cell)].filter(Boolean).join("\n");
}

function runtimeParityScenarioResultStatus(result: RuntimeParityResult) {
  const cellStatuses = new Set([
    runtimeParityCellStatus(result.cells.openclaw),
    runtimeParityCellStatus(result.cells.codex),
  ]);
  if (isRuntimeParityResultPass(result)) {
    return "pass";
  }
  if (cellStatuses.has("fail")) {
    return "fail";
  }
  if (cellStatuses.has("skip")) {
    return "skip";
  }
  return "fail";
}

export function buildRuntimeParityScenarioResult(params: {
  scenarioName: string;
  result: RuntimeParityResult;
}): QaSuiteScenarioResult {
  const driftStepStatus = runtimeParityScenarioResultStatus(params.result);
  const openclawCell = params.result.cells.openclaw;
  const codexCell = params.result.cells.codex;
  return {
    name: params.scenarioName,
    status: driftStepStatus,
    details: params.result.driftDetails ?? `runtime drift classified as ${params.result.drift}`,
    steps: [
      {
        name: openclawCell.runtime,
        status: runtimeParityCellStatus(openclawCell),
        details: formatRuntimeParityScenarioCellDetails(openclawCell),
      },
      {
        name: codexCell.runtime,
        status: runtimeParityCellStatus(codexCell),
        details: formatRuntimeParityScenarioCellDetails(codexCell),
      },
      {
        name: "runtime drift",
        status: driftStepStatus,
        details: params.result.driftDetails ?? params.result.drift,
      },
    ],
    runtimeParity: params.result,
  };
}
