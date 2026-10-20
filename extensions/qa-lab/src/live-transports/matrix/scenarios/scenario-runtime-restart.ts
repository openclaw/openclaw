import {
  MATRIX_QA_HOMESERVER_ROOM_KEY,
  MATRIX_QA_RESTART_ROOM_KEY,
  MATRIX_QA_STALE_SYNC_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-contract.js";
import {
  buildMatrixReplyDetails,
  buildMatrixQaToken,
  buildMentionPrompt,
  buildMatrixReplyArtifact,
  isMatrixQaExactMarkerReply,
  assertTopLevelReplyArtifact,
  primeMatrixQaDriverScenarioClient,
  resolveMatrixQaNoReplyWindowMs,
  runAssertedDriverTopLevelScenario,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import {
  rewriteMatrixSyncStoreCursor,
  waitForMatrixIngressCompletion,
  waitForMatrixSyncStoreWithCursor,
} from "./scenario-runtime-state-files.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runHomeserverRestartResumeScenario(context: MatrixQaScenarioContext) {
  if (!context.interruptTransport) {
    throw new Error("Matrix homeserver restart scenario requires a transport interruption hook");
  }
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_HOMESERVER_ROOM_KEY);
  await context.interruptTransport();
  const resumed = await runAssertedDriverTopLevelScenario({
    context,
    label: "post-homeserver-restart reply",
    roomId,
    tokenPrefix: "MATRIX_QA_HOMESERVER",
  });
  return {
    details: [
      `room id: ${roomId}`,
      "transport interruption: homeserver-restart",
      `driver event: ${resumed.driverEventId}`,
      ...buildMatrixReplyDetails("reply", resumed.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runInitialCatchupThenIncrementalScenario(context: MatrixQaScenarioContext) {
  if (!context.restartGatewayWithQueuedMessage) {
    throw new Error(
      "Matrix initial catchup scenario requires a queued-message gateway restart callback",
    );
  }
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_RESTART_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const catchupToken = buildMatrixQaToken("MATRIX_QA_CATCHUP");
  const catchupBody = buildMentionPrompt(context.sutUserId, catchupToken);
  let catchupDriverEventId = "";

  await context.restartGatewayWithQueuedMessage(async () => {
    catchupDriverEventId = await client.sendTextMessage({
      body: catchupBody,
      mentionUserIds: [context.sutUserId],
      roomId,
    });
  });

  const catchupMatched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId,
        sutUserId: context.sutUserId,
        token: catchupToken,
      }) && event.relatesTo === undefined,
    roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  const catchupReply = buildMatrixReplyArtifact(catchupMatched.event, catchupToken);
  assertTopLevelReplyArtifact("catchup reply", catchupReply);

  const incremental = await runAssertedDriverTopLevelScenario({
    context,
    label: "incremental reply after catchup",
    roomId,
    tokenPrefix: "MATRIX_QA_INCREMENTAL",
  });

  return {
    details: [
      `room id: ${roomId}`,
      "restart signal: SIGUSR2",
      `catchup driver event: ${catchupDriverEventId}`,
      ...buildMatrixReplyDetails("catchup reply", catchupReply),
      `incremental driver event: ${incremental.driverEventId}`,
      ...buildMatrixReplyDetails("incremental reply", incremental.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runStaleSyncReplayDedupeScenario(context: MatrixQaScenarioContext) {
  if (!context.restartGatewayAfterStateMutation) {
    throw new Error(
      "Matrix stale sync replay dedupe scenario requires a persisted-state restart callback",
    );
  }
  if (!context.gatewayStateDir) {
    throw new Error("Matrix stale sync replay dedupe scenario requires a gateway state directory");
  }
  const stateDir = context.gatewayStateDir;
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_STALE_SYNC_ROOM_KEY);
  const syncStore = await waitForMatrixSyncStoreWithCursor({
    context,
    stateDir,
    timeoutMs: Math.min(5_000, context.timeoutMs),
  });
  const staleCursor = syncStore.cursor;

  const {
    client,
    driverEventId: replayDriverEventId,
    reply: firstReply,
    since: firstMatchedSince,
    startSince,
    token: replayToken,
  } = await runAssertedDriverTopLevelScenario({
    context,
    label: "first stale-sync replay-dedupe reply",
    roomId,
    tokenPrefix: "MATRIX_QA_STALE_SYNC_DEDUPE",
  });

  await waitForMatrixIngressCompletion({
    accountId: context.sutAccountId,
    eventId: replayDriverEventId,
    stateDir,
    timeoutMs: Math.min(5_000, context.timeoutMs),
  });

  await context.restartGatewayAfterStateMutation(async () => {
    await rewriteMatrixSyncStoreCursor({
      cursor: staleCursor,
      pathname: syncStore.pathname,
      stateKey: syncStore.stateKey,
    });
  });

  const duplicate = await client.waitForOptionalRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.eventId !== firstReply.eventId &&
      isMatrixQaExactMarkerReply(event, {
        roomId,
        sutUserId: context.sutUserId,
        token: replayToken,
      }),
    roomId,
    since: firstMatchedSince ?? startSince,
    timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
  });
  if (duplicate.matched) {
    throw new Error(
      [
        "Matrix stale sync cursor replayed an already handled event",
        `original driver event: ${replayDriverEventId}`,
        `stale sync cursor: ${staleCursor}`,
        ...buildMatrixReplyDetails("first reply", firstReply),
        ...buildMatrixReplyDetails(
          "duplicate reply",
          buildMatrixReplyArtifact(duplicate.event, replayToken),
        ),
      ].join("\n"),
    );
  }

  const postRestart = await runAssertedDriverTopLevelScenario({
    context,
    label: "fresh post-stale-sync-restart reply",
    roomId,
    tokenPrefix: "MATRIX_QA_STALE_SYNC_DEDUPE_FRESH",
  });

  return {
    details: [
      `room id: ${roomId}`,
      "restart signal: hard-restart",
      `stale sync cursor: ${staleCursor}`,
      `first driver event: ${replayDriverEventId}`,
      ...buildMatrixReplyDetails("first reply", firstReply),
      `duplicate replay window: ${resolveMatrixQaNoReplyWindowMs(context.timeoutMs)}ms`,
      `fresh post-restart driver event: ${postRestart.driverEventId}`,
      ...buildMatrixReplyDetails("fresh reply", postRestart.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
