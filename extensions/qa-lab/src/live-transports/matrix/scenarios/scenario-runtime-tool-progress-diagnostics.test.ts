import { describe, expect, it } from "vitest";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import {
  assertMatrixQaToolProgressMentionsInert,
  buildMatrixQaToolProgressFinalTimeoutMessage,
  buildMatrixQaToolProgressTimeoutMessage,
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

function expectValidUtf16(message: string) {
  expect(message).toContain(`${"a".repeat(236)}...`);
  expect(message).not.toMatch(UNPAIRED_SURROGATE_PATTERN);
  expect(Buffer.from(message, "utf8").toString("utf8")).not.toContain("�");
}

describe("Matrix tool-progress timeout diagnostics", () => {
  it("accepts progress that omits mention-looking command text", () => {
    expect(() =>
      assertMatrixQaToolProgressMentionsInert(
        buildBoundaryEvent({
          body: "Working\n\n`🛠️ Run Matrix progress QA command`",
          formattedBody: "<p>Working</p><p><code>🛠️ Run Matrix progress QA command</code></p>",
          mentions: { room: false, userIds: [] },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects visible mention-looking command text outside code", () => {
    expect(() =>
      assertMatrixQaToolProgressMentionsInert(
        buildBoundaryEvent({
          body: "Working @room",
          formattedBody: "<p>Working @room</p>",
          mentions: { room: false, userIds: [] },
        }),
      ),
    ).toThrow("did not preserve mention-looking text inside code");
  });

  it("preserves complete Unicode code points in preview candidates", () => {
    const message = buildMatrixQaToolProgressTimeoutMessage({
      cause: new Error("preview wait timed out"),
      events: [buildBoundaryEvent()],
      expectedPreviewKind: "notice",
      previewEventId: "$preview",
      roomId: "!room:matrix-qa.test",
      startIndex: 0,
      sutUserId: "@sut:matrix-qa.test",
    });

    expectValidUtf16(message);
  });

  it("preserves complete Unicode code points in final candidates", () => {
    const message = buildMatrixQaToolProgressFinalTimeoutMessage({
      cause: new Error("final wait timed out"),
      events: [
        buildBoundaryEvent({
          eventId: "$replacement",
          replacesEventId: "$preview",
        }),
      ],
      previewEventId: "$preview",
      roomId: "!room:matrix-qa.test",
      startIndex: 0,
      sutUserId: "@sut:matrix-qa.test",
      token: "x",
    });

    expectValidUtf16(message);
  });
});
