import { randomUUID } from "node:crypto";
import { createMatrixQaClient } from "../../substrate/client.js";
import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import { type MatrixQaProvisionedTopology } from "../../substrate/topology.js";
import {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
  type MatrixQaScenarioDefinition,
} from "./scenario-catalog.js";
import type {
  MatrixQaCanaryArtifact,
  MatrixQaReplyArtifact,
  MatrixQaScenarioExecution,
} from "./scenario-types.js";

type MatrixQaActorId = "driver" | "observer";

export type MatrixQaSyncState = Partial<Record<MatrixQaActorId, string>>;

export type MatrixQaScenarioContext = {
  baseUrl: string;
  canary?: MatrixQaCanaryArtifact;
  driverAccessToken: string;
  driverUserId: string;
  observedEvents: MatrixQaObservedEvent[];
  observerAccessToken: string;
  observerUserId: string;
  restartGateway?: () => Promise<void>;
  roomId: string;
  interruptTransport?: () => Promise<void>;
  sutAccessToken: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
  topology: MatrixQaProvisionedTopology;
};

const NO_REPLY_WINDOW_MS = 8_000;

export function buildMentionPrompt(sutUserId: string, token: string) {
  return `${sutUserId} reply with only this exact marker: ${token}`;
}

function buildExactMarkerPrompt(token: string) {
  return `reply with only this exact marker: ${token}`;
}

export function buildMatrixReplyArtifact(
  event: MatrixQaObservedEvent,
  token?: string,
): MatrixQaReplyArtifact {
  const replyBody = event.body?.trim();
  return {
    bodyPreview: replyBody?.slice(0, 200),
    eventId: event.eventId,
    mentions: event.mentions,
    relatesTo: event.relatesTo,
    sender: event.sender,
    ...(token ? { tokenMatched: replyBody === token } : {}),
  };
}

function buildMatrixNoticeArtifact(event: MatrixQaObservedEvent) {
  return {
    bodyPreview: event.body?.trim().slice(0, 200),
    eventId: event.eventId,
    sender: event.sender,
  };
}

export function buildMatrixReplyDetails(label: string, artifact: MatrixQaReplyArtifact) {
  return [
    `${label} event: ${artifact.eventId}`,
    `${label} token matched: ${
      artifact.tokenMatched === undefined ? "n/a" : artifact.tokenMatched ? "yes" : "no"
    }`,
    `${label} rel_type: ${artifact.relatesTo?.relType ?? "<none>"}`,
    `${label} in_reply_to: ${artifact.relatesTo?.inReplyToId ?? "<none>"}`,
    `${label} is_falling_back: ${artifact.relatesTo?.isFallingBack === true ? "true" : "false"}`,
  ];
}

function assertTopLevelReplyArtifact(label: string, artifact: MatrixQaReplyArtifact) {
  if (!artifact.tokenMatched) {
    throw new Error(`${label} did not contain the expected token`);
  }
  if (artifact.relatesTo !== undefined) {
    throw new Error(`${label} unexpectedly included relation metadata`);
  }
}

function assertThreadReplyArtifact(
  artifact: MatrixQaReplyArtifact,
  params: {
    expectedRootEventId: string;
    label: string;
  },
) {
  if (!artifact.tokenMatched) {
    throw new Error(`${params.label} did not contain the expected token`);
  }
  if (artifact.relatesTo?.relType !== "m.thread") {
    throw new Error(`${params.label} did not use m.thread`);
  }
  if (artifact.relatesTo.eventId !== params.expectedRootEventId) {
    throw new Error(
      `${params.label} targeted ${artifact.relatesTo.eventId ?? "<none>"} instead of ${params.expectedRootEventId}`,
    );
  }
  if (artifact.relatesTo.isFallingBack !== true) {
    throw new Error(`${params.label} did not set is_falling_back`);
  }
  if (!artifact.relatesTo.inReplyToId) {
    throw new Error(`${params.label} did not set m.in_reply_to`);
  }
}

export function readMatrixQaSyncCursor(syncState: MatrixQaSyncState, actorId: MatrixQaActorId) {
  return syncState[actorId];
}

export function writeMatrixQaSyncCursor(
  syncState: MatrixQaSyncState,
  actorId: MatrixQaActorId,
  since?: string,
) {
  if (since) {
    syncState[actorId] = since;
  }
}

async function primeMatrixQaActorCursor(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  baseUrl: string;
  syncState: MatrixQaSyncState;
}) {
  const client = createMatrixQaClient({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
  });
  const existingSince = readMatrixQaSyncCursor(params.syncState, params.actorId);
  if (existingSince) {
    return { client, startSince: existingSince };
  }
  const startSince = await client.primeRoom();
  if (!startSince) {
    throw new Error(`Matrix ${params.actorId} /sync prime did not return a next_batch cursor`);
  }
  return { client, startSince };
}

function advanceMatrixQaActorCursor(params: {
  actorId: MatrixQaActorId;
  syncState: MatrixQaSyncState;
  nextSince?: string;
  startSince: string;
}) {
  writeMatrixQaSyncCursor(params.syncState, params.actorId, params.nextSince ?? params.startSince);
}

function createMatrixQaScenarioClient(params: { accessToken: string; baseUrl: string }) {
  return createMatrixQaClient({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
  });
}

async function runConfigurableTopLevelScenario(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  baseUrl: string;
  observedEvents: MatrixQaObservedEvent[];
  replyPredicate?: (
    event: MatrixQaObservedEvent,
    params: { driverEventId: string; token: string },
  ) => boolean;
  roomId: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
  tokenPrefix: string;
  withMention?: boolean;
}) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.baseUrl,
    syncState: params.syncState,
  });
  const token = `${params.tokenPrefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
  const body =
    params.withMention === false
      ? buildExactMarkerPrompt(token)
      : buildMentionPrompt(params.sutUserId, token);
  const driverEventId = await client.sendTextMessage({
    body,
    ...(params.withMention === false ? {} : { mentionUserIds: [params.sutUserId] }),
    roomId: params.roomId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.sender === params.sutUserId &&
      event.type === "m.room.message" &&
      (event.body ?? "").includes(token) &&
      (params.replyPredicate?.(event, { driverEventId, token }) ?? event.relatesTo === undefined),
    roomId: params.roomId,
    since: startSince,
    timeoutMs: params.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: params.actorId,
    syncState: params.syncState,
    nextSince: matched.since,
    startSince,
  });
  return {
    body,
    driverEventId,
    reply: buildMatrixReplyArtifact(matched.event, token),
    token,
  };
}

async function runTopLevelMentionScenario(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  baseUrl: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
  tokenPrefix: string;
  withMention?: boolean;
}) {
  return await runConfigurableTopLevelScenario(params);
}

async function waitForMembershipEvent(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  baseUrl: string;
  membership: "invite" | "join" | "leave";
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  stateKey: string;
  syncState: MatrixQaSyncState;
  timeoutMs: number;
}) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.baseUrl,
    syncState: params.syncState,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.type === "m.room.member" &&
      event.stateKey === params.stateKey &&
      event.membership === params.membership,
    roomId: params.roomId,
    since: startSince,
    timeoutMs: params.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: params.actorId,
    syncState: params.syncState,
    nextSince: matched.since,
    startSince,
  });
  return matched.event;
}

async function runTopologyScopedTopLevelScenario(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  actorUserId: string;
  context: MatrixQaScenarioContext;
  roomKey: string;
  tokenPrefix: string;
  withMention?: boolean;
}) {
  const roomId = resolveMatrixQaScenarioRoomId(params.context, params.roomKey);
  const result = await runTopLevelMentionScenario({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.context.baseUrl,
    observedEvents: params.context.observedEvents,
    roomId,
    syncState: params.context.syncState,
    sutUserId: params.context.sutUserId,
    timeoutMs: params.context.timeoutMs,
    tokenPrefix: params.tokenPrefix,
    withMention: params.withMention,
  });
  assertTopLevelReplyArtifact(`reply in ${params.roomKey}`, result.reply);
  return {
    artifacts: {
      actorUserId: params.actorUserId,
      driverEventId: result.driverEventId,
      reply: result.reply,
      roomKey: params.roomKey,
      token: result.token,
      triggerBody: result.body,
    },
    details: [
      `room key: ${params.roomKey}`,
      `room id: ${roomId}`,
      `driver event: ${result.driverEventId}`,
      `trigger sender: ${params.actorUserId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

async function runThreadScenario(params: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: params.driverAccessToken,
    actorId: "driver",
    baseUrl: params.baseUrl,
    syncState: params.syncState,
  });
  const rootBody = `thread root ${randomUUID().slice(0, 8)}`;
  const rootEventId = await client.sendTextMessage({
    body: rootBody,
    roomId: params.roomId,
  });
  const token = `MATRIX_QA_THREAD_${randomUUID().slice(0, 8).toUpperCase()}`;
  const driverEventId = await client.sendTextMessage({
    body: buildMentionPrompt(params.sutUserId, token),
    mentionUserIds: [params.sutUserId],
    replyToEventId: rootEventId,
    roomId: params.roomId,
    threadRootEventId: rootEventId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.sender === params.sutUserId &&
      event.type === "m.room.message" &&
      (event.body ?? "").includes(token) &&
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
    reply: buildMatrixReplyArtifact(matched.event, token),
    rootEventId,
    token,
  };
}

async function runRoomThreadReplyOverrideScenario(context: MatrixQaScenarioContext) {
  const result = await runConfigurableTopLevelScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    replyPredicate: (event, params) =>
      event.relatesTo?.relType === "m.thread" && event.relatesTo?.eventId === params.driverEventId,
    roomId: context.roomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_ROOM_THREAD",
  });
  assertThreadReplyArtifact(result.reply, {
    expectedRootEventId: result.driverEventId,
    label: "room thread override reply",
  });
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      token: result.token,
      triggerBody: result.body,
    },
    details: [
      `driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

async function runDmThreadReplyOverrideScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_DRIVER_DM_ROOM_KEY);
  const result = await runConfigurableTopLevelScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    replyPredicate: (event, params) =>
      event.relatesTo?.relType === "m.thread" && event.relatesTo?.eventId === params.driverEventId,
    roomId,
    syncState: context.syncState,
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

async function runDmSharedSessionFlow(params: {
  context: MatrixQaScenarioContext;
  expectNotice: boolean;
}) {
  const firstRoomId = resolveMatrixQaScenarioRoomId(params.context, MATRIX_QA_DRIVER_DM_ROOM_KEY);
  const secondRoomId = resolveMatrixQaScenarioRoomId(
    params.context,
    MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  );

  const firstResult = await runConfigurableTopLevelScenario({
    accessToken: params.context.driverAccessToken,
    actorId: "driver",
    baseUrl: params.context.baseUrl,
    observedEvents: params.context.observedEvents,
    roomId: firstRoomId,
    syncState: params.context.syncState,
    sutUserId: params.context.sutUserId,
    timeoutMs: params.context.timeoutMs,
    tokenPrefix: "MATRIX_QA_DM_PRIMARY",
    withMention: false,
  });
  assertTopLevelReplyArtifact("primary DM reply", firstResult.reply);

  const replyClient = createMatrixQaScenarioClient({
    accessToken: params.context.driverAccessToken,
    baseUrl: params.context.baseUrl,
  });
  const noticeClient = createMatrixQaScenarioClient({
    accessToken: params.context.driverAccessToken,
    baseUrl: params.context.baseUrl,
  });
  const [replySince, noticeSince] = await Promise.all([
    replyClient.primeRoom(),
    noticeClient.primeRoom(),
  ]);
  if (!replySince || !noticeSince) {
    throw new Error("Matrix DM session scenario could not prime room cursors");
  }

  const secondToken = `MATRIX_QA_DM_SECONDARY_${randomUUID().slice(0, 8).toUpperCase()}`;
  const secondBody = buildExactMarkerPrompt(secondToken);
  const secondDriverEventId = await replyClient.sendTextMessage({
    body: secondBody,
    roomId: secondRoomId,
  });

  const [replyResult, noticeResult] = await Promise.all([
    replyClient.waitForRoomEvent({
      observedEvents: params.context.observedEvents,
      predicate: (event) =>
        event.roomId === secondRoomId &&
        event.sender === params.context.sutUserId &&
        event.type === "m.room.message" &&
        event.kind === "message" &&
        (event.body ?? "").includes(secondToken),
      roomId: secondRoomId,
      since: replySince,
      timeoutMs: params.context.timeoutMs,
    }),
    noticeClient.waitForOptionalRoomEvent({
      observedEvents: params.context.observedEvents,
      predicate: (event) =>
        event.roomId === secondRoomId &&
        event.sender === params.context.sutUserId &&
        event.kind === "notice" &&
        typeof event.body === "string" &&
        event.body.includes("channels.matrix.dm.sessionScope"),
      roomId: secondRoomId,
      since: noticeSince,
      timeoutMs: Math.min(NO_REPLY_WINDOW_MS, params.context.timeoutMs),
    }),
  ]);

  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: params.context.syncState,
    nextSince: replyResult.since,
    startSince: replySince,
  });

  const secondReply = buildMatrixReplyArtifact(replyResult.event, secondToken);
  assertTopLevelReplyArtifact("secondary DM reply", secondReply);
  const noticeArtifact = noticeResult.matched
    ? buildMatrixNoticeArtifact(noticeResult.event)
    : undefined;

  if (params.expectNotice && !noticeArtifact) {
    throw new Error(
      "Matrix shared DM session scenario did not emit the expected cross-room notice",
    );
  }
  if (!params.expectNotice && noticeArtifact) {
    throw new Error(
      "Matrix per-room DM session scenario unexpectedly emitted a shared-session notice",
    );
  }

  return {
    noticeArtifact,
    secondBody,
    secondDriverEventId,
    secondReply,
    secondRoomId,
    secondToken,
  };
}

async function runDmSharedSessionNoticeScenario(context: MatrixQaScenarioContext) {
  const result = await runDmSharedSessionFlow({
    context,
    expectNotice: true,
  });
  return {
    artifacts: {
      driverEventId: result.secondDriverEventId,
      noticeBodyPreview: result.noticeArtifact?.bodyPreview,
      noticeEventId: result.noticeArtifact?.eventId,
      reply: result.secondReply,
      roomKey: MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
      token: result.secondToken,
      triggerBody: result.secondBody,
    },
    details: [
      `primary room id: ${resolveMatrixQaScenarioRoomId(context, MATRIX_QA_DRIVER_DM_ROOM_KEY)}`,
      `secondary room id: ${result.secondRoomId}`,
      `secondary driver event: ${result.secondDriverEventId}`,
      `notice event: ${result.noticeArtifact?.eventId ?? "<none>"}`,
      `notice preview: ${result.noticeArtifact?.bodyPreview ?? "<none>"}`,
      ...buildMatrixReplyDetails("secondary reply", result.secondReply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

async function runDmPerRoomSessionOverrideScenario(context: MatrixQaScenarioContext) {
  const result = await runDmSharedSessionFlow({
    context,
    expectNotice: false,
  });
  return {
    artifacts: {
      driverEventId: result.secondDriverEventId,
      reply: result.secondReply,
      roomKey: MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
      token: result.secondToken,
      triggerBody: result.secondBody,
    },
    details: [
      `primary room id: ${resolveMatrixQaScenarioRoomId(context, MATRIX_QA_DRIVER_DM_ROOM_KEY)}`,
      `secondary room id: ${result.secondRoomId}`,
      `secondary driver event: ${result.secondDriverEventId}`,
      "shared-session notice: suppressed",
      ...buildMatrixReplyDetails("secondary reply", result.secondReply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

async function runRoomAutoJoinInviteScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    syncState: context.syncState,
  });
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

  const result = await runTopLevelMentionScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    roomId: dynamicRoomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_AUTOJOIN",
  });
  assertTopLevelReplyArtifact("auto-join room reply", result.reply);

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

async function runNoReplyExpectedScenario(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  actorUserId: string;
  baseUrl: string;
  body: string;
  mentionUserIds?: string[];
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
  token: string;
}) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.baseUrl,
    syncState: params.syncState,
  });
  const driverEventId = await client.sendTextMessage({
    body: params.body,
    ...(params.mentionUserIds ? { mentionUserIds: params.mentionUserIds } : {}),
    roomId: params.roomId,
  });
  const result = await client.waitForOptionalRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.sender === params.sutUserId &&
      event.type === "m.room.message",
    roomId: params.roomId,
    since: startSince,
    timeoutMs: params.timeoutMs,
  });
  if (result.matched) {
    const unexpectedReply = buildMatrixReplyArtifact(result.event, params.token);
    throw new Error(
      [
        `unexpected SUT reply from ${params.sutUserId}`,
        `trigger sender: ${params.actorUserId}`,
        ...buildMatrixReplyDetails("unexpected reply", unexpectedReply),
      ].join("\n"),
    );
  }
  advanceMatrixQaActorCursor({
    actorId: params.actorId,
    syncState: params.syncState,
    nextSince: result.since,
    startSince,
  });
  return {
    artifacts: {
      actorUserId: params.actorUserId,
      driverEventId,
      expectedNoReplyWindowMs: params.timeoutMs,
      token: params.token,
      triggerBody: params.body,
    },
    details: [
      `trigger event: ${driverEventId}`,
      `trigger sender: ${params.actorUserId}`,
      `waited ${params.timeoutMs}ms with no SUT reply`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

async function runMembershipLossScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_MEMBERSHIP_ROOM_KEY);
  const driverClient = createMatrixQaScenarioClient({
    accessToken: context.driverAccessToken,
    baseUrl: context.baseUrl,
  });
  const sutClient = createMatrixQaScenarioClient({
    accessToken: context.sutAccessToken,
    baseUrl: context.baseUrl,
  });

  await driverClient.kickUserFromRoom({
    reason: "matrix qa membership loss",
    roomId,
    userId: context.sutUserId,
  });
  const leaveEvent = await waitForMembershipEvent({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    membership: "leave",
    observedEvents: context.observedEvents,
    roomId,
    stateKey: context.sutUserId,
    syncState: context.syncState,
    timeoutMs: context.timeoutMs,
  });

  const noReplyToken = `MATRIX_QA_MEMBERSHIP_LOSS_${randomUUID().slice(0, 8).toUpperCase()}`;
  await runNoReplyExpectedScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    actorUserId: context.driverUserId,
    baseUrl: context.baseUrl,
    body: buildMentionPrompt(context.sutUserId, noReplyToken),
    mentionUserIds: [context.sutUserId],
    observedEvents: context.observedEvents,
    roomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: Math.min(NO_REPLY_WINDOW_MS, context.timeoutMs),
    token: noReplyToken,
  });

  await driverClient.inviteUserToRoom({
    roomId,
    userId: context.sutUserId,
  });
  await waitForMembershipEvent({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    membership: "invite",
    observedEvents: context.observedEvents,
    roomId,
    stateKey: context.sutUserId,
    syncState: context.syncState,
    timeoutMs: context.timeoutMs,
  });
  await sutClient.joinRoom(roomId);
  const joinEvent = await waitForMembershipEvent({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    membership: "join",
    observedEvents: context.observedEvents,
    roomId,
    stateKey: context.sutUserId,
    syncState: context.syncState,
    timeoutMs: context.timeoutMs,
  });

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
}

async function runReactionNotificationScenario(context: MatrixQaScenarioContext) {
  const reactionTargetEventId = context.canary?.reply.eventId?.trim();
  if (!reactionTargetEventId) {
    throw new Error("Matrix reaction scenario requires a canary reply event id");
  }
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    syncState: context.syncState,
  });
  const reactionEmoji = "👍";
  const reactionEventId = await client.sendReaction({
    emoji: reactionEmoji,
    messageId: reactionTargetEventId,
    roomId: context.roomId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === context.roomId &&
      event.sender === context.driverUserId &&
      event.type === "m.reaction" &&
      event.eventId === reactionEventId &&
      event.reaction?.eventId === reactionTargetEventId &&
      event.reaction?.key === reactionEmoji,
    roomId: context.roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: matched.since,
    startSince,
  });
  return {
    artifacts: {
      reactionEmoji,
      reactionEventId,
      reactionTargetEventId,
    },
    details: [
      `reaction event: ${reactionEventId}`,
      `reaction target: ${reactionTargetEventId}`,
      `reaction emoji: ${reactionEmoji}`,
      `observed reaction key: ${matched.event.reaction?.key ?? "<none>"}`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

async function runHomeserverRestartResumeScenario(context: MatrixQaScenarioContext) {
  if (!context.interruptTransport) {
    throw new Error("Matrix homeserver restart scenario requires a transport interruption hook");
  }
  await context.interruptTransport();
  const resumed = await runTopLevelMentionScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    roomId: context.roomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_HOMESERVER",
  });
  assertTopLevelReplyArtifact("post-homeserver-restart reply", resumed.reply);
  return {
    artifacts: {
      driverEventId: resumed.driverEventId,
      reply: resumed.reply,
      token: resumed.token,
      transportInterruption: "homeserver-restart",
    },
    details: [
      "transport interruption: homeserver-restart",
      `driver event: ${resumed.driverEventId}`,
      ...buildMatrixReplyDetails("reply", resumed.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

async function runRestartResumeScenario(context: MatrixQaScenarioContext) {
  if (!context.restartGateway) {
    throw new Error("Matrix restart scenario requires a gateway restart callback");
  }
  await context.restartGateway();
  const result = await runTopLevelMentionScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    roomId: context.roomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_RESTART",
  });
  assertTopLevelReplyArtifact("post-restart reply", result.reply);
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      restartSignal: "SIGUSR1",
      token: result.token,
    },
    details: [
      "restart signal: SIGUSR1",
      `post-restart driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runMatrixQaCanary(params: {
  baseUrl: string;
  driverAccessToken: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
}) {
  const canary = await runTopLevelMentionScenario({
    accessToken: params.driverAccessToken,
    actorId: "driver",
    baseUrl: params.baseUrl,
    observedEvents: params.observedEvents,
    roomId: params.roomId,
    syncState: params.syncState,
    sutUserId: params.sutUserId,
    timeoutMs: params.timeoutMs,
    tokenPrefix: "MATRIX_QA_CANARY",
  });
  assertTopLevelReplyArtifact("canary reply", canary.reply);
  return canary;
}

export async function runMatrixQaScenario(
  scenario: MatrixQaScenarioDefinition,
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  switch (scenario.id) {
    case "matrix-thread-follow-up": {
      const result = await runThreadScenario(context);
      assertThreadReplyArtifact(result.reply, {
        expectedRootEventId: result.rootEventId,
        label: "thread reply",
      });
      return {
        artifacts: {
          driverEventId: result.driverEventId,
          reply: result.reply,
          rootEventId: result.rootEventId,
          token: result.token,
        },
        details: [
          `root event: ${result.rootEventId}`,
          `driver thread event: ${result.driverEventId}`,
          ...buildMatrixReplyDetails("reply", result.reply),
        ].join("\n"),
      };
    }
    case "matrix-thread-isolation": {
      const threadPhase = await runThreadScenario(context);
      assertThreadReplyArtifact(threadPhase.reply, {
        expectedRootEventId: threadPhase.rootEventId,
        label: "thread isolation reply",
      });
      const topLevelPhase = await runTopLevelMentionScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        baseUrl: context.baseUrl,
        observedEvents: context.observedEvents,
        roomId: context.roomId,
        syncState: context.syncState,
        sutUserId: context.sutUserId,
        timeoutMs: context.timeoutMs,
        tokenPrefix: "MATRIX_QA_TOPLEVEL",
      });
      assertTopLevelReplyArtifact("top-level follow-up reply", topLevelPhase.reply);
      return {
        artifacts: {
          threadDriverEventId: threadPhase.driverEventId,
          threadReply: threadPhase.reply,
          threadRootEventId: threadPhase.rootEventId,
          threadToken: threadPhase.token,
          topLevelDriverEventId: topLevelPhase.driverEventId,
          topLevelReply: topLevelPhase.reply,
          topLevelToken: topLevelPhase.token,
        },
        details: [
          `thread root event: ${threadPhase.rootEventId}`,
          `thread driver event: ${threadPhase.driverEventId}`,
          ...buildMatrixReplyDetails("thread reply", threadPhase.reply),
          `top-level driver event: ${topLevelPhase.driverEventId}`,
          ...buildMatrixReplyDetails("top-level reply", topLevelPhase.reply),
        ].join("\n"),
      };
    }
    case "matrix-top-level-reply-shape": {
      const result = await runTopLevelMentionScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        baseUrl: context.baseUrl,
        observedEvents: context.observedEvents,
        roomId: context.roomId,
        syncState: context.syncState,
        sutUserId: context.sutUserId,
        timeoutMs: context.timeoutMs,
        tokenPrefix: "MATRIX_QA_TOPLEVEL",
      });
      assertTopLevelReplyArtifact("top-level reply", result.reply);
      return {
        artifacts: {
          driverEventId: result.driverEventId,
          reply: result.reply,
          token: result.token,
        },
        details: [
          `driver event: ${result.driverEventId}`,
          ...buildMatrixReplyDetails("reply", result.reply),
        ].join("\n"),
      };
    }
    case "matrix-room-thread-reply-override":
      return await runRoomThreadReplyOverrideScenario(context);
    case "matrix-dm-reply-shape":
      return await runTopologyScopedTopLevelScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        actorUserId: context.driverUserId,
        context,
        roomKey: MATRIX_QA_DRIVER_DM_ROOM_KEY,
        tokenPrefix: "MATRIX_QA_DM",
        withMention: false,
      });
    case "matrix-dm-shared-session-notice":
      return await runDmSharedSessionNoticeScenario(context);
    case "matrix-dm-thread-reply-override":
      return await runDmThreadReplyOverrideScenario(context);
    case "matrix-dm-per-room-session-override":
      return await runDmPerRoomSessionOverrideScenario(context);
    case "matrix-room-autojoin-invite":
      return await runRoomAutoJoinInviteScenario(context);
    case "matrix-secondary-room-reply":
      return await runTopologyScopedTopLevelScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        actorUserId: context.driverUserId,
        context,
        roomKey: MATRIX_QA_SECONDARY_ROOM_KEY,
        tokenPrefix: "MATRIX_QA_SECONDARY",
      });
    case "matrix-secondary-room-open-trigger":
      return await runTopologyScopedTopLevelScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        actorUserId: context.driverUserId,
        context,
        roomKey: MATRIX_QA_SECONDARY_ROOM_KEY,
        tokenPrefix: "MATRIX_QA_SECONDARY_OPEN",
        withMention: false,
      });
    case "matrix-reaction-notification":
      return await runReactionNotificationScenario(context);
    case "matrix-restart-resume":
      return await runRestartResumeScenario(context);
    case "matrix-room-membership-loss":
      return await runMembershipLossScenario(context);
    case "matrix-homeserver-restart-resume":
      return await runHomeserverRestartResumeScenario(context);
    case "matrix-mention-gating": {
      const token = `MATRIX_QA_NOMENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return await runNoReplyExpectedScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        actorUserId: context.driverUserId,
        baseUrl: context.baseUrl,
        body: buildExactMarkerPrompt(token),
        observedEvents: context.observedEvents,
        roomId: context.roomId,
        syncState: context.syncState,
        sutUserId: context.sutUserId,
        timeoutMs: context.timeoutMs,
        token,
      });
    }
    case "matrix-allowlist-block": {
      const token = `MATRIX_QA_ALLOWLIST_${randomUUID().slice(0, 8).toUpperCase()}`;
      return await runNoReplyExpectedScenario({
        accessToken: context.observerAccessToken,
        actorId: "observer",
        actorUserId: context.observerUserId,
        baseUrl: context.baseUrl,
        body: buildMentionPrompt(context.sutUserId, token),
        mentionUserIds: [context.sutUserId],
        observedEvents: context.observedEvents,
        roomId: context.roomId,
        syncState: context.syncState,
        sutUserId: context.sutUserId,
        timeoutMs: context.timeoutMs,
        token,
      });
    }
    default: {
      const exhaustiveScenarioId: never = scenario.id;
      return exhaustiveScenarioId;
    }
  }
}
