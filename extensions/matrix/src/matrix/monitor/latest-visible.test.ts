import { describe, expect, it } from "vitest";
import {
  createMatrixLatestVisibleTracker,
  evaluateMatrixFreshnessObservation,
  resolveMatrixDraftFreshnessScope,
  resolveMatrixFreshnessProtectedEventIds,
} from "./latest-visible.js";
import {
  EventType,
  RelationType,
  type MatrixRawEvent,
  type RoomMessageEventContent,
} from "./types.js";

function createEvent(params: {
  eventId: string;
  sender?: string;
  type?: string;
  relatesTo?: RoomMessageEventContent["m.relates_to"];
  finalizedPreview?: boolean;
  redacted?: boolean;
}): MatrixRawEvent {
  const content: RoomMessageEventContent = {
    msgtype: "m.text",
    body: params.eventId,
    ...(params.relatesTo ? { "m.relates_to": params.relatesTo } : {}),
    ...(params.finalizedPreview ? { "com.openclaw.finalized_preview": true } : {}),
  };
  return {
    event_id: params.eventId,
    sender: params.sender ?? "@user:example.org",
    type: params.type ?? EventType.RoomMessage,
    origin_server_ts: 1,
    content,
    ...(params.redacted ? { unsigned: { redacted_because: { event_id: "$redaction" } } } : {}),
  };
}

describe("resolveMatrixFreshnessProtectedEventIds", () => {
  it("includes thread roots and reply targets for future latest-visible checks", () => {
    expect(
      Array.from(
        resolveMatrixFreshnessProtectedEventIds({
          threadId: "$threadA",
          replyToEventId: "$replyTarget",
          extraEventIds: ["$extra"],
        }),
      ).toSorted(),
    ).toEqual(["$extra", "$replyTarget", "$threadA"]);
  });
});

describe("createMatrixLatestVisibleTracker", () => {
  it("returns only events appended after a prepared trigger snapshot", () => {
    const tracker = createMatrixLatestVisibleTracker();
    tracker.recordPending("!room:example.org", createEvent({ eventId: "$before" }));

    const triggerSnapshot = tracker.prepareTrigger(
      "forge",
      "!room:example.org",
      createEvent({ eventId: "$trigger" }),
    );
    tracker.recordPending("!room:example.org", createEvent({ eventId: "$after" }));

    expect(
      tracker
        .getEventsAfterSnapshot("!room:example.org", triggerSnapshot)
        .map((event) => event.event_id),
    ).toEqual(["$after"]);
  });
});

describe("evaluateMatrixFreshnessObservation", () => {
  it("invalidates root-room drafts for new root-room visible messages", () => {
    expect(
      evaluateMatrixFreshnessObservation({
        draftScope: resolveMatrixDraftFreshnessScope({}),
        event: createEvent({ eventId: "$root" }),
      }),
    ).toMatchObject({ action: "invalidate", reason: "room-visible-message" });
  });

  it("ignores unrelated thread activity for root-room drafts", () => {
    expect(
      evaluateMatrixFreshnessObservation({
        draftScope: resolveMatrixDraftFreshnessScope({}),
        event: createEvent({
          eventId: "$thread-reply",
          relatesTo: { rel_type: RelationType.Thread, event_id: "$threadA" },
        }),
      }),
    ).toMatchObject({ action: "ignore", reason: "different-thread" });
  });

  it("invalidates thread drafts for new visible events in the same thread", () => {
    expect(
      evaluateMatrixFreshnessObservation({
        draftScope: resolveMatrixDraftFreshnessScope({ threadId: "$threadA" }),
        event: createEvent({
          eventId: "$thread-reply",
          relatesTo: { rel_type: RelationType.Thread, event_id: "$threadA" },
        }),
      }),
    ).toMatchObject({ action: "invalidate", reason: "same-thread-visible-message" });
  });

  it("ignores other-thread activity for thread drafts", () => {
    expect(
      evaluateMatrixFreshnessObservation({
        draftScope: resolveMatrixDraftFreshnessScope({ threadId: "$threadA" }),
        event: createEvent({
          eventId: "$thread-b-reply",
          relatesTo: { rel_type: RelationType.Thread, event_id: "$threadB" },
        }),
      }),
    ).toMatchObject({ action: "ignore", reason: "different-thread" });
  });

  it("ignores unrelated root-room chatter for thread drafts", () => {
    expect(
      evaluateMatrixFreshnessObservation({
        draftScope: resolveMatrixDraftFreshnessScope({ threadId: "$threadA" }),
        event: createEvent({ eventId: "$root" }),
      }),
    ).toMatchObject({ action: "ignore", reason: "thread-irrelevant-root-message" });
  });

  it("rechecks when a protected reply target is redacted", () => {
    expect(
      evaluateMatrixFreshnessObservation({
        draftScope: resolveMatrixDraftFreshnessScope({}),
        protectedEventIds: ["$replyTarget"],
        event: createEvent({ eventId: "$replyTarget", redacted: true }),
      }),
    ).toMatchObject({ action: "recheck", reason: "protected-target-redaction" });
  });

  it("ignores self-authored draft preview churn by event id and finalize marker", () => {
    expect(
      evaluateMatrixFreshnessObservation({
        draftScope: resolveMatrixDraftFreshnessScope({}),
        selfUserId: "@bot:example.org",
        ignoredEventIds: ["$draft1"],
        event: createEvent({ eventId: "$draft1", sender: "@bot:example.org" }),
      }),
    ).toMatchObject({ action: "ignore", reason: "ignored-event" });

    expect(
      evaluateMatrixFreshnessObservation({
        draftScope: resolveMatrixDraftFreshnessScope({}),
        selfUserId: "@bot:example.org",
        event: createEvent({
          eventId: "$draft1-edit",
          sender: "@bot:example.org",
          finalizedPreview: true,
          relatesTo: { rel_type: RelationType.Replace, event_id: "$draft1" },
        }),
      }),
    ).toMatchObject({ action: "ignore", reason: "ignored-event" });
  });

  it("ignores reactions and other transport noise", () => {
    expect(
      evaluateMatrixFreshnessObservation({
        draftScope: resolveMatrixDraftFreshnessScope({}),
        event: createEvent({ eventId: "$reaction", type: EventType.Reaction }),
      }),
    ).toMatchObject({ action: "ignore", reason: "reaction-noise" });

    expect(
      evaluateMatrixFreshnessObservation({
        draftScope: resolveMatrixDraftFreshnessScope({}),
        event: createEvent({ eventId: "$member", type: "m.room.member" }),
      }),
    ).toMatchObject({ action: "ignore", reason: "transport-noise" });
  });
});
