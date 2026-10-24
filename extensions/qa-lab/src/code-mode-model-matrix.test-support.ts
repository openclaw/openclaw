import {
  parseCodeModeMatrixOptions,
  type CodeModeMatrixCellResult,
  type CodeModeMatrixOptions,
  type MatrixCell,
  type runCodeModeModelMatrix,
} from "../../../scripts/code-mode-model-matrix.ts";

export function matrixOptions(
  repoRoot: string,
  overrides: Partial<CodeModeMatrixOptions> = {},
): CodeModeMatrixOptions {
  return {
    ...parseCodeModeMatrixOptions(["--model", "fixture/model"], repoRoot),
    tasks: ["read"],
    modes: ["code"],
    repetitions: 1,
    thinking: "off",
    timeoutSeconds: 10,
    ...overrides,
  };
}

export function matrixDependencies(
  overrides: NonNullable<Parameters<typeof runCodeModeModelMatrix>[1]> = {},
) {
  return {
    readSourceIdentity: async () => ({
      gitSha: "synthetic-source",
      sourceDirty: false,
      sourcePatchSha256: null,
    }),
    readBuildSha256: async () => "synthetic-build",
    buildCliArtifacts: async () => {},
    ...overrides,
  };
}

export function matrixResult(
  cell: MatrixCell,
  overrides: Partial<CodeModeMatrixCellResult> = {},
): CodeModeMatrixCellResult {
  return {
    ...cell,
    buildSha256: "synthetic-build",
    gitSha: "synthetic-source",
    sourceDirty: false,
    sourcePatchSha256: null,
    codeModeEngaged: cell.mode === "code",
    elapsedMs: 1,
    expected: "ok",
    final: "ok",
    failureCategory: null,
    observedModel: cell.model.split("/")[1]!,
    observedProvider: cell.model.split("/")[0]!,
    passed: true,
    status: "ok",
    oracle: { answer: true, effect: true, engagement: true, identity: true, toolExecution: true },
    timestamp: "2026-09-21T12:00:00.000Z",
    ...overrides,
  };
}
