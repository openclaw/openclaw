import {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-contract.js";
import {
  assertThreadReplyArtifact,
  buildMatrixReplyDetails,
  resolveMatrixQaActorSyncParams,
  runConfigurableTopLevelScenario,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runDmThreadReplyOverrideScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_DRIVER_DM_ROOM_KEY);
  const result = await runConfigurableTopLevelScenario({
    ...resolveMatrixQaActorSyncParams(context, "driver"),
    replyPredicate: (event, params) =>
      event.relatesTo?.relType === "m.thread" && event.relatesTo?.eventId === params.driverEventId,
    roomId,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_DM_THREAD",
    withMention: false,
  });
  assertThreadReplyArtifact(result.reply, {
    expectedRootEventId: result.driverEventId,
    label: "DM thread override reply",
  });
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      roomKey: MATRIX_QA_DRIVER_DM_ROOM_KEY,
      token: result.token,
      triggerBody: result.body,
    },
    details: [
      `room key: ${MATRIX_QA_DRIVER_DM_ROOM_KEY}`,
      `room id: ${roomId}`,
      `driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
