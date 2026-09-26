import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import { isMatrixQaMessageLikeKind } from "./scenario-runtime-shared.js";

export function findMatrixQaUnexpectedWorkingEvents(params: {
  events: MatrixQaObservedEvent[];
  finalEventId?: string;
  previewEventId?: string;
  startIndex: number;
  sutUserId: string;
}) {
  return params.events.slice(params.startIndex).filter((event) => {
    if (event.sender !== params.sutUserId || event.type !== "m.room.message") {
      return false;
    }
    if (!/\bWorking\b/i.test(event.body ?? "")) {
      return false;
    }
    if (event.eventId === params.previewEventId || event.eventId === params.finalEventId) {
      return false;
    }
    return event.replacesEventId !== params.previewEventId;
  });
}

export function assertMatrixQaToolProgressMentionsInert(event: MatrixQaObservedEvent) {
  const mentions = event.mentions;
  if (mentions?.room || (mentions?.userIds?.length ?? 0) > 0) {
    throw new Error(
      `Matrix tool-progress preview emitted active mentions: ${JSON.stringify(mentions)}`,
    );
  }
  if (/matrix\.to/i.test(event.formattedBody ?? "")) {
    throw new Error(
      `Matrix tool-progress preview linked Matrix mentions: ${event.formattedBody ?? "<none>"}`,
    );
  }
  const mentionTextPattern = /@room|@alice:matrix-qa\.test|!room:matrix-qa\.test/i;
  if (
    !mentionTextPattern.test(event.body ?? "") &&
    !mentionTextPattern.test(event.formattedBody ?? "")
  ) {
    return;
  }
  if (
    !/<code>[^<]*(?:@room|@alice:matrix-qa\.test|!room:matrix-qa\.test)/i.test(
      event.formattedBody ?? "",
    )
  ) {
    throw new Error(
      `Matrix tool-progress preview did not preserve mention-looking text inside code: ${event.formattedBody ?? "<none>"}`,
    );
  }
}

export function hasMatrixQaToolProgressPreviewLine(body: string | undefined) {
  return Boolean(
    body?.split(/\r?\n/).some((line) => /^\s*(?:[-*•]\s+`?[^`\s][^`]*`?|`[^`]+`)\s*$/u.test(line)),
  );
}

function truncateMatrixQaToolProgressBody(body: string | undefined) {
  if (!body) {
    return "<none>";
  }
  return body.length <= 240 ? body : `${truncateUtf16Safe(body, 237)}...`;
}

function describeMatrixQaToolProgressCandidate(event: MatrixQaObservedEvent) {
  const relation = event.relatesTo?.relType
    ? `${event.relatesTo.relType}:${event.relatesTo.eventId ?? "<none>"}`
    : "<none>";
  return [
    `${event.eventId} kind=${event.kind}`,
    `replaces=${event.replacesEventId ?? "<none>"}`,
    `relation=${relation}`,
    `body=${JSON.stringify(truncateMatrixQaToolProgressBody(event.body))}`,
  ].join(" ");
}

type MatrixQaToolProgressTimeoutContext = {
  cause: unknown;
  events: MatrixQaObservedEvent[];
  previewEventId: string;
  roomId: string;
  startIndex: number;
  sutUserId: string;
};

function findToolProgressCandidates(
  params: MatrixQaToolProgressTimeoutContext,
  predicate: (event: MatrixQaObservedEvent) => boolean,
) {
  return params.events
    .slice(params.startIndex)
    .filter(
      (event) =>
        event.roomId === params.roomId &&
        event.sender === params.sutUserId &&
        event.type === "m.room.message" &&
        predicate(event),
    )
    .slice(-8);
}

export function buildMatrixQaToolProgressTimeoutMessage(
  params: MatrixQaToolProgressTimeoutContext & {
    expectedPreviewKind: MatrixQaObservedEvent["kind"];
  },
) {
  const candidates = findToolProgressCandidates(
    params,
    (event) =>
      event.kind === params.expectedPreviewKind &&
      (event.eventId === params.previewEventId ||
        event.replacesEventId === params.previewEventId ||
        event.body !== undefined),
  );
  const messageCandidates =
    candidates.length === 0
      ? findToolProgressCandidates(params, (event) => isMatrixQaMessageLikeKind(event.kind))
      : [];
  const candidateDetails =
    candidates.length === 0
      ? ["observed preview candidates: <none>"]
      : ["observed preview candidates:", ...candidates.map(describeMatrixQaToolProgressCandidate)];
  const messageCandidateDetails =
    messageCandidates.length === 0
      ? []
      : [
          "observed message candidates:",
          ...messageCandidates.map(describeMatrixQaToolProgressCandidate),
        ];
  return [
    params.cause instanceof Error
      ? params.cause.message
      : `Matrix tool progress wait failed: ${String(params.cause)}`,
    `preview event: ${params.previewEventId}`,
    ...candidateDetails,
    ...messageCandidateDetails,
  ].join("\n");
}

export function buildMatrixQaToolProgressFinalTimeoutMessage(
  params: MatrixQaToolProgressTimeoutContext & { token: string },
) {
  const candidates = findToolProgressCandidates(
    params,
    (event) =>
      isMatrixQaMessageLikeKind(event.kind) && event.replacesEventId === params.previewEventId,
  );
  const candidateDetails =
    candidates.length === 0
      ? ["observed final candidates: <none>"]
      : ["observed final candidates:", ...candidates.map(describeMatrixQaToolProgressCandidate)];
  return [
    params.cause instanceof Error
      ? params.cause.message
      : `Matrix tool progress final wait failed: ${String(params.cause)}`,
    `preview event: ${params.previewEventId}`,
    `expected token: ${params.token}`,
    ...candidateDetails,
  ].join("\n");
}
