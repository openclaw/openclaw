import { randomUUID } from "node:crypto";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import {
  assertThreadReplyArtifact,
  assertTopLevelReplyArtifact,
  advanceMatrixQaActorCursor,
  buildMatrixQaToken,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  isMatrixQaExactMarkerReply,
  primeMatrixQaDriverScenarioClient,
  runConfigurableTopLevelScenario,
  type MatrixQaScenarioContext,
  type MatrixQaSyncState,
} from "./scenario-runtime-shared.js";
import type { MatrixQaCanaryArtifact, MatrixQaScenarioExecution } from "./scenario-types.js";

type MatrixQaThreadScenarioResult = Awaited<ReturnType<typeof runThreadScenario>>;

function buildMatrixQaThreadArtifacts(result: MatrixQaThreadScenarioResult) {
  return {
    driverEventId: result.driverEventId,
    reply: result.reply,
    rootEventId: result.rootEventId,
    token: result.token,
  };
}

export function buildMatrixQaThreadDetailLines(params: {
  result: MatrixQaThreadScenarioResult;
  extraLines?: string[];
  replyLabel?: string;
}) {
  return [
    `thread root event: ${params.result.rootEventId}`,
    `nested trigger event: ${params.result.nestedDriverEventId}`,
    `mention trigger event: ${params.result.driverEventId}`,
    ...(params.extraLines ?? []),
    ...buildMatrixReplyDetails(params.replyLabel ?? "reply", params.result.reply),
  ];
}

export async function runThreadScenario(params: MatrixQaScenarioContext, tokenPrefix: string) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(params);
  const rootBody = `thread root ${randomUUID().slice(0, 8)}`;
  const rootEventId = await client.sendTextMessage({
    body: rootBody,
    roomId: params.roomId,
  });
  const nestedDriverEventId = await client.sendTextMessage({
    body: `thread nested ${randomUUID().slice(0, 8)}`,
    replyToEventId: rootEventId,
    roomId: params.roomId,
    threadRootEventId: rootEventId,
  });
  const token = buildMatrixQaToken(tokenPrefix);
  const driverEventId = await client.sendTextMessage({
    body: buildMentionPrompt(params.sutUserId, token),
    mentionUserIds: [params.sutUserId],
    replyToEventId: nestedDriverEventId,
    roomId: params.roomId,
    threadRootEventId: rootEventId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId: params.roomId,
        sutUserId: params.sutUserId,
        token,
      }) &&
      event.relatesTo?.relType === "m.thread" &&
      event.relatesTo.eventId === rootEventId,
    roomId: params.roomId,
    since: startSince,
    timeoutMs: params.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: params.syncState,
    nextSince: matched.since,
    startSince,
  });
  return {
    driverEventId,
    nestedDriverEventId,
    reply: buildMatrixReplyArtifact(matched.event, token),
    rootEventId,
    token,
  };
}

export async function runMatrixQaCanary(params: {
  baseUrl: string;
  driverAccessToken: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  syncState: MatrixQaSyncState;
  syncStreams?: MatrixQaScenarioContext["syncStreams"];
  sutUserId: string;
  timeoutMs: number;
}): Promise<{
  body: string;
  driverEventId: string;
  reply: MatrixQaCanaryArtifact["reply"];
  token: string;
}> {
  const canary = await runConfigurableTopLevelScenario({
    accessToken: params.driverAccessToken,
    actorId: "driver",
    baseUrl: params.baseUrl,
    observedEvents: params.observedEvents,
    roomId: params.roomId,
    syncState: params.syncState,
    syncStreams: params.syncStreams,
    sutUserId: params.sutUserId,
    timeoutMs: params.timeoutMs,
    tokenPrefix: "MATRIX_QA_CANARY",
  });
  assertTopLevelReplyArtifact("canary reply", canary.reply);
  return {
    body: canary.body,
    driverEventId: canary.driverEventId,
    reply: canary.reply,
    token: canary.token,
  };
}

export async function runThreadRootPreservationScenario(context: MatrixQaScenarioContext) {
  const result = await runThreadScenario(context, "MATRIX_QA_THREAD_ROOT");
  assertThreadReplyArtifact(result.reply, {
    expectedRootEventId: result.rootEventId,
    label: "thread root preservation reply",
  });
  return {
    artifacts: buildMatrixQaThreadArtifacts(result),
    details: buildMatrixQaThreadDetailLines({
      result,
      extraLines: [
        `reply thread root: ${result.reply.relatesTo?.eventId ?? "<none>"}`,
        `reply in_reply_to: ${result.reply.relatesTo?.inReplyToId ?? "<none>"}`,
      ],
    }).join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runThreadNestedReplyShapeScenario(context: MatrixQaScenarioContext) {
  if (!context.gatewayCall) {
    throw new Error("Matrix nested reply proof requires the Gateway send method");
  }
  const result = await runThreadScenario(context, "MATRIX_QA_THREAD_NESTED");
  assertThreadReplyArtifact(result.reply, {
    expectedRootEventId: result.rootEventId,
    label: "thread nested reply",
  });
  const selectedReplyId = result.nestedDriverEventId;
  if (result.reply.relatesTo?.inReplyToId !== result.rootEventId) {
    throw new Error(
      `thread nested reply in_reply_to targeted ${result.reply.relatesTo?.inReplyToId ?? "<none>"} instead of ${result.rootEventId}`,
    );
  }
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const explicitToken = buildMatrixQaToken("MATRIX_QA_EXPLICIT_THREAD_REPLY");
  await context.gatewayCall("send", {
    channel: "matrix",
    accountId: context.sutAccountId,
    to: context.roomId,
    message: explicitToken,
    threadId: result.rootEventId,
    replyToId: selectedReplyId,
    idempotencyKey: randomUUID(),
  });
  const explicit = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId: context.roomId,
        sutUserId: context.sutUserId,
        token: explicitToken,
      }),
    roomId: context.roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  const explicitRelation = explicit.event.relatesTo;
  if (
    explicitRelation?.relType !== "m.thread" ||
    explicitRelation.eventId !== result.rootEventId ||
    explicitRelation.inReplyToId !== selectedReplyId ||
    explicitRelation.isFallingBack === true
  ) {
    throw new Error("Matrix explicit reply lost its selected target or became a thread fallback");
  }
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: explicit.since,
    startSince,
  });
  const explicitReply = buildMatrixReplyArtifact(explicit.event, explicitToken);
  return {
    artifacts: { ...buildMatrixQaThreadArtifacts(result), secondReply: explicitReply },
    details: buildMatrixQaThreadDetailLines({
      result,
      extraLines: [
        `reply in_reply_to: ${result.reply.relatesTo?.inReplyToId ?? "<none>"}`,
        `expected fallback root: ${result.rootEventId}`,
        ...buildMatrixReplyDetails("explicit reply", explicitReply),
      ],
    }).join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
