import { randomUUID } from "node:crypto";
import {
  collectLiveTransportStandardScenarioCoverage,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
} from "../../shared/live-transport-scenarios.js";
import { createMatrixQaClient } from "../../substrate/client.js";
import { type MatrixQaConfigOverrides } from "../../substrate/config.js";
import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import {
  buildDefaultMatrixQaTopologySpec,
  findMatrixQaProvisionedRoom,
  mergeMatrixQaTopologySpecs,
  type MatrixQaProvisionedTopology,
  type MatrixQaTopologySpec,
} from "../../substrate/topology.js";

export type MatrixQaScenarioId =
  | "matrix-thread-follow-up"
  | "matrix-thread-isolation"
  | "matrix-top-level-reply-shape"
  | "matrix-dm-reply-shape"
  | "matrix-secondary-room-reply"
  | "matrix-secondary-room-open-trigger"
  | "matrix-reaction-notification"
  | "matrix-restart-resume"
  | "matrix-room-membership-loss"
  | "matrix-homeserver-restart-resume"
  | "matrix-mention-gating"
  | "matrix-allowlist-block";

export type MatrixQaScenarioDefinition = LiveTransportScenarioDefinition<MatrixQaScenarioId> & {
  configOverrides?: MatrixQaConfigOverrides;
  topology?: MatrixQaTopologySpec;
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
  transportInterruption?: string;
};

export type MatrixQaScenarioExecution = {
  artifacts?: MatrixQaScenarioArtifacts;
  details: string;
};

type MatrixQaActorId = "driver" | "observer";

type MatrixQaSyncState = Partial<Record<MatrixQaActorId, string>>;

type MatrixQaScenarioContext = {
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
const MATRIX_QA_DRIVER_DM_ROOM_KEY = "driver-dm";
const MATRIX_QA_MEMBERSHIP_ROOM_KEY = "membership";
const MATRIX_QA_SECONDARY_ROOM_KEY = "secondary";

export const MATRIX_QA_SCENARIOS: MatrixQaScenarioDefinition[] = [
  {
    id: "matrix-thread-follow-up",
    standardId: "thread-follow-up",
    timeoutMs: 60_000,
    title: "Matrix thread follow-up reply",
  },
  {
    id: "matrix-thread-isolation",
    standardId: "thread-isolation",
    timeoutMs: 75_000,
    title: "Matrix top-level reply stays out of prior thread",
  },
  {
    id: "matrix-top-level-reply-shape",
    standardId: "top-level-reply-shape",
    timeoutMs: 45_000,
    title: "Matrix top-level reply keeps replyToMode off",
  },
  {
    id: "matrix-dm-reply-shape",
    timeoutMs: 45_000,
    title: "Matrix DM reply stays top-level without a mention",
    topology: {
      defaultRoomKey: "main",
      rooms: [
        {
          key: MATRIX_QA_DRIVER_DM_ROOM_KEY,
          kind: "dm",
          members: ["driver", "sut"],
          name: "Matrix QA Driver/SUT DM",
        },
      ],
    },
  },
  {
    id: "matrix-secondary-room-reply",
    timeoutMs: 45_000,
    title: "Matrix secondary room reply stays scoped to that room",
    topology: {
      defaultRoomKey: "main",
      rooms: [
        {
          key: MATRIX_QA_SECONDARY_ROOM_KEY,
          kind: "group",
          members: ["driver", "observer", "sut"],
          name: "Matrix QA Secondary Room",
          requireMention: true,
        },
      ],
    },
  },
  {
    id: "matrix-secondary-room-open-trigger",
    timeoutMs: 45_000,
    title: "Matrix secondary room can opt out of mention gating",
    topology: {
      defaultRoomKey: "main",
      rooms: [
        {
          key: MATRIX_QA_SECONDARY_ROOM_KEY,
          kind: "group",
          members: ["driver", "observer", "sut"],
          name: "Matrix QA Secondary Room",
          requireMention: true,
        },
      ],
    },
    configOverrides: {
      groupsByKey: {
        [MATRIX_QA_SECONDARY_ROOM_KEY]: {
          requireMention: false,
        },
      },
    },
  },
  {
    id: "matrix-reaction-notification",
    standardId: "reaction-observation",
    timeoutMs: 45_000,
    title: "Matrix reactions on bot replies are observed",
  },
  {
    id: "matrix-restart-resume",
    standardId: "restart-resume",
    timeoutMs: 60_000,
    title: "Matrix lane resumes cleanly after gateway restart",
  },
  {
    id: "matrix-room-membership-loss",
    timeoutMs: 75_000,
    title: "Matrix room membership loss recovers after re-invite",
    topology: {
      defaultRoomKey: "main",
      rooms: [
        {
          key: MATRIX_QA_MEMBERSHIP_ROOM_KEY,
          kind: "group",
          members: ["driver", "observer", "sut"],
          name: "Matrix QA Membership Room",
          requireMention: true,
        },
      ],
    },
  },
  {
    id: "matrix-homeserver-restart-resume",
    timeoutMs: 75_000,
    title: "Matrix lane resumes after homeserver restart",
  },
  {
    id: "matrix-mention-gating",
    standardId: "mention-gating",
    timeoutMs: NO_REPLY_WINDOW_MS,
    title: "Matrix room message without mention does not trigger",
  },
  {
    id: "matrix-allowlist-block",
    standardId: "allowlist-block",
    timeoutMs: NO_REPLY_WINDOW_MS,
    title: "Matrix allowlist blocks non-driver replies",
  },
];

export const MATRIX_QA_STANDARD_SCENARIO_IDS = collectLiveTransportStandardScenarioCoverage({
  alwaysOnStandardScenarioIds: ["canary"],
  scenarios: MATRIX_QA_SCENARIOS,
});

export function findMatrixQaScenarios(ids?: string[]) {
  return selectLiveTransportScenarios({
    ids,
    laneLabel: "Matrix",
    scenarios: MATRIX_QA_SCENARIOS,
  });
}

export function buildMatrixQaTopologyForScenarios(params: {
  defaultRoomName: string;
  scenarios: MatrixQaScenarioDefinition[];
}): MatrixQaTopologySpec {
  return mergeMatrixQaTopologySpecs([
    buildDefaultMatrixQaTopologySpec({
      defaultRoomName: params.defaultRoomName,
    }),
    ...params.scenarios.flatMap((scenario) => (scenario.topology ? [scenario.topology] : [])),
  ]);
}

export function resolveMatrixQaScenarioRoomId(
  context: Pick<MatrixQaScenarioContext, "roomId" | "topology">,
  roomKey?: string,
) {
  if (!roomKey) {
    return context.roomId;
  }
  return findMatrixQaProvisionedRoom(context.topology, roomKey).roomId;
}

export function buildMentionPrompt(sutUserId: string, token: string) {
  return `${sutUserId} reply with only this exact marker: ${token}`;
}

function buildExactMarkerPrompt(token: string) {
  return `reply with only this exact marker: ${token}`;
}

function buildMatrixReplyArtifact(
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

function readMatrixQaSyncCursor(syncState: MatrixQaSyncState, actorId: MatrixQaActorId) {
  return syncState[actorId];
}

function writeMatrixQaSyncCursor(
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
      event.relatesTo === undefined,
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
    since: matched.since,
    token,
  };
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
    since: matched.since,
    token,
  };
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

export const __testing = {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
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
