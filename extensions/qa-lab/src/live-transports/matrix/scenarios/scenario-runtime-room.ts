import { randomUUID } from "node:crypto";
import {
  MATRIX_QA_BLOCK_ROOM_KEY,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-contract.js";
import {
  buildMatrixQaReactionArtifacts,
  buildMatrixQaReactionDetailLines,
  observeReactionScenario,
} from "./scenario-runtime-reaction.js";
import {
  assertThreadReplyArtifact,
  advanceMatrixQaActorCursor,
  buildMatrixQaToken,
  buildMatrixBlockStreamingPrompt,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  createMatrixQaScenarioClient,
  isMatrixQaMessageLikeKind,
  primeMatrixQaDriverScenarioClient,
  resolveMatrixQaActorSyncParams,
  resolveMatrixQaNoReplyWindowMs,
  runAssertedDriverTopLevelScenario,
  runNoReplyExpectedScenario,
  runTopologyScopedTopLevelScenario,
  waitForMembershipEvent,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import { buildMatrixQaThreadDetailLines, runThreadScenario } from "./scenario-runtime-thread.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export {
  runMatrixQaCanary,
  runThreadNestedReplyShapeScenario,
  runThreadRootPreservationScenario,
} from "./scenario-runtime-thread.js";
export {
  runPartialStreamingPreviewScenario,
  runQuietStreamingPreviewScenario,
  runStreamingReplacementRetentionScenario,
} from "./scenario-runtime-streaming-preview.js";

export {
  runToolProgressCommandPreviewScenario,
  runToolProgressErrorScenario,
  runToolProgressMentionSafetyScenario,
  runToolProgressPreviewOptOutScenario,
  runToolProgressPreviewScenario,
} from "./scenario-runtime-tool-progress.js";
export async function runBlockStreamingScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_BLOCK_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const firstText = buildMatrixQaToken("MATRIX_QA_BLOCK_ONE");
  const secondText = buildMatrixQaToken("MATRIX_QA_BLOCK_TWO");
  const triggerBody = buildMatrixBlockStreamingPrompt(context.sutUserId, firstText, secondText);
  const driverEventId = await client.sendTextMessage({
    body: triggerBody,
    mentionUserIds: [context.sutUserId],
    roomId,
  });
  const firstBlock = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === roomId &&
      event.sender === context.sutUserId &&
      isMatrixQaMessageLikeKind(event.kind) &&
      (event.body ?? "").includes(firstText) &&
      !(event.body ?? "").includes(secondText),
    roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  const secondBlock = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === roomId &&
      event.sender === context.sutUserId &&
      isMatrixQaMessageLikeKind(event.kind) &&
      (event.body ?? "").includes(secondText),
    roomId,
    since: firstBlock.since,
    timeoutMs: context.timeoutMs,
  });
  if (firstBlock.event.eventId === secondBlock.event.eventId) {
    throw new Error(
      "Matrix block streaming scenario reused one event instead of preserving blocks",
    );
  }
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: secondBlock.since,
    startSince,
  });
  return {
    artifacts: {
      blockEventIds: [firstBlock.event.eventId, secondBlock.event.eventId],
      driverEventId,
      reply: buildMatrixReplyArtifact(secondBlock.event, secondText),
      roomId,
      token: secondText,
      triggerBody,
    },
    details: [
      `room id: ${roomId}`,
      `driver event: ${driverEventId}`,
      `block one event: ${firstBlock.event.eventId}`,
      `block two event: ${secondBlock.event.eventId}`,
      `block one kind: ${firstBlock.event.kind}`,
      `block two kind: ${secondBlock.event.kind}`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runRoomAutoJoinInviteScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const dynamicRoomId = await client.createPrivateRoom({
    inviteUserIds: [context.observerUserId, context.sutUserId],
    name: `Matrix QA AutoJoin ${randomUUID().slice(0, 8)}`,
  });
  const joinResult = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === dynamicRoomId &&
      event.type === "m.room.member" &&
      event.stateKey === context.sutUserId &&
      event.membership === "join",
    roomId: dynamicRoomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  const joinEvent = joinResult.event;
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: joinResult.since,
    startSince,
  });

  const result = await runAssertedDriverTopLevelScenario({
    context,
    label: "auto-join room reply",
    roomId: dynamicRoomId,
    tokenPrefix: "MATRIX_QA_AUTOJOIN",
  });

  return {
    artifacts: {
      driverEventId: result.driverEventId,
      joinedRoomId: dynamicRoomId,
      membershipJoinEventId: joinEvent.eventId,
      reply: result.reply,
      token: result.token,
      triggerBody: result.body,
    },
    details: [
      `joined room id: ${dynamicRoomId}`,
      `join event: ${joinEvent.eventId}`,
      `driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runMembershipLossScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_MEMBERSHIP_ROOM_KEY);
  const { client: driverClient } = await primeMatrixQaDriverScenarioClient(context);
  const sutClient = createMatrixQaScenarioClient({
    accessToken: context.sutAccessToken,
    baseUrl: context.baseUrl,
  });
  let membershipRestored = false;

  try {
    await driverClient.kickUserFromRoom({
      reason: "matrix qa membership loss",
      roomId,
      userId: context.sutUserId,
    });
    const leaveEvent = await waitForMembershipEvent({
      ...resolveMatrixQaActorSyncParams(context, "driver"),
      membership: "leave",
      roomId,
      stateKey: context.sutUserId,
      timeoutMs: context.timeoutMs,
    });

    const noReplyToken = buildMatrixQaToken("MATRIX_QA_MEMBERSHIP_LOSS");
    await runNoReplyExpectedScenario({
      ...resolveMatrixQaActorSyncParams(context, "driver"),
      actorUserId: context.driverUserId,
      body: buildMentionPrompt(context.sutUserId, noReplyToken),
      mentionUserIds: [context.sutUserId],
      roomId,
      sutUserId: context.sutUserId,
      timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
      token: noReplyToken,
    });

    await driverClient.inviteUserToRoom({
      roomId,
      userId: context.sutUserId,
    });
    await waitForMembershipEvent({
      ...resolveMatrixQaActorSyncParams(context, "driver"),
      membership: "invite",
      roomId,
      stateKey: context.sutUserId,
      timeoutMs: context.timeoutMs,
    });
    await sutClient.joinRoom(roomId);
    const joinEvent = await waitForMembershipEvent({
      ...resolveMatrixQaActorSyncParams(context, "driver"),
      membership: "join",
      roomId,
      stateKey: context.sutUserId,
      timeoutMs: context.timeoutMs,
    });
    membershipRestored = true;
    const recovered = await runTopologyScopedTopLevelScenario({
      accessToken: context.driverAccessToken,
      actorId: "driver",
      actorUserId: context.driverUserId,
      context,
      roomKey: MATRIX_QA_MEMBERSHIP_ROOM_KEY,
      tokenPrefix: "MATRIX_QA_MEMBERSHIP_RETURN",
    });

    return {
      artifacts: {
        ...recovered.artifacts,
        membershipJoinEventId: joinEvent.eventId,
        membershipLeaveEventId: leaveEvent.eventId,
        recoveredDriverEventId: recovered.artifacts?.driverEventId,
        recoveredReply: recovered.artifacts?.reply,
      },
      details: [
        `room key: ${MATRIX_QA_MEMBERSHIP_ROOM_KEY}`,
        `room id: ${roomId}`,
        `leave event: ${leaveEvent.eventId}`,
        `join event: ${joinEvent.eventId}`,
        recovered.details,
      ].join("\n"),
    } satisfies MatrixQaScenarioExecution;
  } catch (error) {
    // A lost kick response can still mean the kick applied.
    if (!membershipRestored) {
      try {
        try {
          await sutClient.joinRoom(roomId);
        } catch {
          // A kicked member needs an invite; an already joined member succeeds above.
          await driverClient.inviteUserToRoom({ roomId, userId: context.sutUserId });
          await sutClient.joinRoom(roomId);
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Matrix membership-loss scenario and membership restoration both failed",
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}

export async function runReactionThreadedScenario(context: MatrixQaScenarioContext) {
  const thread = await runThreadScenario(context, "MATRIX_QA_REACTION_THREAD");
  assertThreadReplyArtifact(thread.reply, {
    expectedRootEventId: thread.rootEventId,
    label: "threaded reaction reply",
  });
  const reaction = await observeReactionScenario({
    actorId: "driver",
    actorUserId: context.driverUserId,
    accessToken: context.driverAccessToken,
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    reactionTargetEventId: thread.reply.eventId,
    roomId: context.roomId,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: reaction.actorId,
    syncState: context.syncState,
    nextSince: reaction.since,
    startSince: reaction.startSince,
  });
  return {
    artifacts: {
      driverEventId: thread.driverEventId,
      ...buildMatrixQaReactionArtifacts(reaction),
      reply: thread.reply,
      rootEventId: thread.rootEventId,
      token: thread.token,
    },
    details: [
      ...buildMatrixQaThreadDetailLines({
        result: thread,
        extraLines: [`thread reply event: ${thread.reply.eventId}`],
        replyLabel: "thread reply",
      }),
      ...buildMatrixQaReactionDetailLines(buildMatrixQaReactionArtifacts(reaction)),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
