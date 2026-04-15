import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  MATRIX_QA_SCENARIOS,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixQaTopologyForScenarios,
  findMatrixQaScenarios,
  resolveMatrixQaScenarioRoomId,
  type MatrixQaScenarioDefinition,
  type MatrixQaScenarioId,
} from "./scenario-catalog.js";
import {
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  readMatrixQaSyncCursor,
  runMatrixQaCanary,
  runMatrixQaScenario,
  writeMatrixQaSyncCursor,
  type MatrixQaScenarioContext,
  type MatrixQaSyncState,
} from "./scenario-runtime.js";

export type { MatrixQaScenarioDefinition, MatrixQaScenarioId };
export {
  MATRIX_QA_SCENARIOS,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMatrixQaTopologyForScenarios,
  buildMentionPrompt,
  findMatrixQaScenarios,
  resolveMatrixQaScenarioRoomId,
  runMatrixQaCanary,
  runMatrixQaScenario,
};

export type MatrixQaReplyArtifact = {
  bodyPreview?: string;
  eventId: string;
  mentions?: MatrixQaObservedEvent["mentions"];
  relatesTo?: MatrixQaObservedEvent["relatesTo"];
  sender?: string;
  tokenMatched?: boolean;
};

export type MatrixQaCanaryArtifact = {
  driverEventId: string;
  reply: MatrixQaReplyArtifact;
  token: string;
};

export type MatrixQaScenarioArtifacts = {
  actorUserId?: string;
  driverEventId?: string;
  expectedNoReplyWindowMs?: number;
  reactionEmoji?: string;
  reactionEventId?: string;
  reactionTargetEventId?: string;
  reply?: MatrixQaReplyArtifact;
  recoveredDriverEventId?: string;
  recoveredReply?: MatrixQaReplyArtifact;
  roomKey?: string;
  restartSignal?: string;
  rootEventId?: string;
  threadDriverEventId?: string;
  threadReply?: MatrixQaReplyArtifact;
  threadRootEventId?: string;
  threadToken?: string;
  token?: string;
  topLevelDriverEventId?: string;
  topLevelReply?: MatrixQaReplyArtifact;
  topLevelToken?: string;
  triggerBody?: string;
  membershipJoinEventId?: string;
  membershipLeaveEventId?: string;
  noticeBodyPreview?: string;
  noticeEventId?: string;
  transportInterruption?: string;
  joinedRoomId?: string;
};

export type MatrixQaScenarioExecution = {
  artifacts?: MatrixQaScenarioArtifacts;
  details: string;
};

export type { MatrixQaScenarioContext, MatrixQaSyncState };

export const __testing = {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixQaTopologyForScenarios,
  buildMatrixReplyDetails,
  buildMatrixReplyArtifact,
  buildMentionPrompt,
  findMatrixQaScenarios,
  readMatrixQaSyncCursor,
  resolveMatrixQaScenarioRoomId,
  writeMatrixQaSyncCursor,
};
