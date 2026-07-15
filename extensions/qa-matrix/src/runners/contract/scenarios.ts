// Qa Matrix plugin module implements scenarios behavior.
import {
  MATRIX_QA_SCENARIOS,
  buildMatrixQaTopologyForScenarios,
  findMatrixQaScenarios,
} from "./scenario-catalog.js";
import {
  buildMatrixReplyDetails,
  runMatrixQaCanary,
  runMatrixQaScenario,
} from "./scenario-runtime.js";
import type { MatrixQaCanaryArtifact, MatrixQaScenarioArtifacts } from "./scenario-types.js";

export {
  MATRIX_QA_SCENARIOS,
  buildMatrixReplyDetails,
  buildMatrixQaTopologyForScenarios,
  findMatrixQaScenarios,
  runMatrixQaCanary,
  runMatrixQaScenario,
};
export type { MatrixQaCanaryArtifact, MatrixQaScenarioArtifacts };
