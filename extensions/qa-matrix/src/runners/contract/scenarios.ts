// Qa Matrix plugin module implements scenarios behavior.
import {
<<<<<<< HEAD
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_MEDIA_ROOM_KEY,
=======
  MATRIX_QA_BOT_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_E2EE_ROOM_KEY,
  MATRIX_QA_MEDIA_ROOM_KEY,
  MATRIX_QA_PROFILE_NAMES,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  MATRIX_QA_SCENARIOS,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixQaE2eeScenarioRoomKey,
  buildMatrixQaTopologyForScenarios,
  findMatrixQaScenarios,
  resolveMatrixQaScenarioRoomId,
  matrixQaProfileTesting,
} from "./scenario-catalog.js";
import {
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
<<<<<<< HEAD
  runMatrixQaCanary,
  runMatrixQaScenario,
=======
  readMatrixQaSyncCursor,
  runMatrixQaCanary,
  runMatrixQaScenario,
  writeMatrixQaSyncCursor,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  type MatrixQaScenarioContext,
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

export type { MatrixQaScenarioContext };

export const testing = {
<<<<<<< HEAD
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_MEDIA_ROOM_KEY,
=======
  MATRIX_QA_BOT_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_E2EE_ROOM_KEY,
  MATRIX_QA_MEDIA_ROOM_KEY,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  MATRIX_QA_PROFILE_NAMES,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  MATRIX_QA_SECONDARY_ROOM_KEY,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixQaE2eeScenarioRoomKey,
  buildMatrixQaTopologyForScenarios,
  buildMatrixReplyDetails,
  buildMatrixReplyArtifact,
  buildMentionPrompt,
  findMatrixQaScenarios,
  getMatrixQaProfileScenarioIds: matrixQaProfileTesting.getMatrixQaProfileScenarioIds,
  normalizeMatrixQaProfile: matrixQaProfileTesting.normalizeMatrixQaProfile,
<<<<<<< HEAD
  resolveMatrixQaScenarioRoomId,
=======
  readMatrixQaSyncCursor,
  resolveMatrixQaScenarioRoomId,
  writeMatrixQaSyncCursor,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
};
export { testing as __testing };
