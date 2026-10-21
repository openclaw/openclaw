import { expect, it } from "vitest";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import {
  assertMatrixQaToolProgressMentionsInert,
  buildMatrixQaToolProgressFinalTimeoutMessage,
  buildMatrixQaToolProgressTimeoutMessage,
  findMatrixQaUnexpectedWorkingEvents,
} from "./scenario-runtime-tool-progress-diagnostics.js";

const UNPAIRED_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function buildBoundaryEvent(overrides: Partial<MatrixQaObservedEvent> = {}) {
  return {
    body: `${"a".repeat(236)}😀tail`,
    eventId: "$preview",
    kind: "notice",
    roomId: "!room:matrix-qa.test",
    sender: "@sut:matrix-qa.test",
    type: "m.room.message",
    ...overrides,
  } satisfies MatrixQaObservedEvent;
}

const timeoutContext = {
  cause: new Error("wait timed out"),
  previewEventId: "$preview",
  roomId: "!room:matrix-qa.test",
  startIndex: 0,
  sutUserId: "@sut:matrix-qa.test",
};

it.each([
  [undefined, ["$unrelated", "$preview", "$replacement"]],
  ["$preview", ["$unrelated"]],
])(
  "detects progress outside the allowed events with preview %s",
  (previewEventId, unexpectedEventIds) => {
    expect(
      findMatrixQaUnexpectedWorkingEvents({
        ...timeoutContext,
        events: ["$unrelated", "$preview", "$replacement", "$final"].map((eventId) =>
          buildBoundaryEvent({
            body: eventId === "$final" ? "Working complete" : "Working",
            eventId,
            replacesEventId: eventId === "$replacement" ? "$preview" : undefined,
          }),
        ),
        finalEventId: "$final",
        previewEventId,
      }).map((event) => event.eventId),
    ).toEqual(unexpectedEventIds);
  },
);

it.each([
  [
    "Working\n\n`🛠️ Run Matrix progress QA command`",
    "<p>Working</p><p><code>🛠️ Run Matrix progress QA command</code></p>",
    false,
  ],
  ["Working @room", "<p>Working @room</p>", true],
])("validates inert mentions in %s", (body, formattedBody, rejects) => {
  const assertion = expect(() =>
    assertMatrixQaToolProgressMentionsInert(
      buildBoundaryEvent({ body, formattedBody, mentions: { room: false, userIds: [] } }),
    ),
  );
  if (rejects) {
    assertion.toThrow("did not preserve mention-looking text inside code");
  } else {
    assertion.not.toThrow();
  }
});

it.each([
  [buildMatrixQaToolProgressTimeoutMessage, buildBoundaryEvent()],
  [
    buildMatrixQaToolProgressFinalTimeoutMessage,
    buildBoundaryEvent({ eventId: "$replacement", replacesEventId: "$preview" }),
  ],
])("preserves Unicode in %s", (buildMessage, event) => {
  const message = buildMessage({
    ...timeoutContext,
    events: [event],
    expectedPreviewKind: "notice",
    token: "x",
  });
  expect(message).toContain(`${"a".repeat(236)}...`);
  expect(message).not.toMatch(UNPAIRED_SURROGATE_PATTERN);
  expect(Buffer.from(message, "utf8").toString("utf8")).not.toContain("�");
});
