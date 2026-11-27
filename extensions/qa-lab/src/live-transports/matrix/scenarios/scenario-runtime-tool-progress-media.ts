import { writeFile } from "node:fs/promises";
import path from "node:path";
import { QaSuiteScenarioSkipError } from "../../../errors.js";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import { createMatrixQaSplitColorImagePng } from "./scenario-media-fixtures.js";
import { createCurrentScenarioEventPredicate } from "./scenario-runtime-event-scope.js";
import {
  buildMatrixQaToken,
  buildMatrixToolProgressCommandPrompt,
  primeMatrixQaDriverScenarioClient,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

const MATRIX_QA_PROGRESS_MEDIA_FILENAME = "qa-progress-media.png";

function describeSutEvents(events: readonly MatrixQaObservedEvent[]) {
  return events
    .map(
      (event) =>
        `${event.eventId} ${event.msgtype ?? event.type}${event.replacesEventId ? ` replaces ${event.replacesEventId}` : ""}: ${JSON.stringify(event.body ?? "")}`,
    )
    .join("; ");
}

export async function runToolProgressMediaCaptionScenario(context: MatrixQaScenarioContext) {
  if (!context.gatewayWorkspaceDir) {
    throw new QaSuiteScenarioSkipError("Matrix progress media caption needs the gateway workspace");
  }
  const caption = buildMatrixQaToken("MATRIX_QA_PROGRESS_MEDIA");
  await writeFile(
    path.join(context.gatewayWorkspaceDir, MATRIX_QA_PROGRESS_MEDIA_FILENAME),
    createMatrixQaSplitColorImagePng(),
  );
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const isCurrentScenarioEvent = createCurrentScenarioEventPredicate(
    context.observedEvents,
    context.observedEvents.length,
  );
  const driverEventId = await client.sendTextMessage({
    // The command's sleep outlasts the progress draft's start delay, so the draft exists
    // before the final reply arrives.
    body: buildMatrixToolProgressCommandPrompt(
      context.sutUserId,
      `${caption}\nMEDIA:./${MATRIX_QA_PROGRESS_MEDIA_FILENAME}`,
    ),
    mentionUserIds: [context.sutUserId],
    roomId: context.roomId,
  });
  const isSutEvent = (event: MatrixQaObservedEvent) =>
    isCurrentScenarioEvent(event) &&
    event.roomId === context.roomId &&
    event.sender === context.sutUserId &&
    event.type === "m.room.message";
  const image = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      isSutEvent(event) && event.replacesEventId === undefined && event.msgtype === "m.image",
    roomId: context.roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  // The observer can record one event more than once; keep the first sighting.
  const seenEventIds = new Set<string>();
  const sutEvents = context.observedEvents.filter((event) => {
    if (!isSutEvent(event) || seenEventIds.has(event.eventId)) {
      return false;
    }
    seenEventIds.add(event.eventId);
    return true;
  });
  if (!sutEvents.some((event) => event.kind === "notice")) {
    throw new Error(
      `Matrix progress media scenario saw no progress draft before the reply; SUT events: ${describeSutEvents(sutEvents)}`,
    );
  }
  if (!image.event.body?.includes(caption)) {
    throw new Error(
      `Matrix progress media reply did not caption the image with ${caption}; SUT events: ${describeSutEvents(sutEvents)}`,
    );
  }
  const strayText = sutEvents.filter(
    (event) => event.eventId !== image.event.eventId && event.body?.includes(caption),
  );
  if (strayText.length > 0) {
    throw new Error(
      `Matrix progress media reply also sent its text outside the image: ${describeSutEvents(strayText)}`,
    );
  }
  return {
    details: [
      `driver event: ${driverEventId}`,
      `image event: ${image.event.eventId}`,
      `image msgtype: ${image.event.msgtype ?? "<none>"}`,
      `image caption: ${image.event.body ?? "<none>"}`,
      `SUT events: ${describeSutEvents(sutEvents)}`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
