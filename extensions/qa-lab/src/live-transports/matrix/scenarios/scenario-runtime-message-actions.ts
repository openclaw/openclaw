import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import { requestMatrixJson } from "../substrate/request.js";
import { createMatrixQaRoomObserver } from "../substrate/sync.js";
import { findMatrixQaProvisionedRoom } from "../substrate/topology.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

function record(value: unknown, label: string): Record<string, unknown> {
  assert(isRecord(value), `${label} must be an object`);
  return value;
}

function acceptedEventId(value: unknown, label: string): string {
  assert(typeof value === "string" && value.startsWith("$"), `${label} needs an event id`);
  return value;
}

export async function runPublicMessageActionsScenario(context: MatrixQaScenarioContext) {
  const gatewayCall = context.gatewayCall;
  assert(gatewayCall, "Matrix public actions require the child Gateway RPC client");
  assert(context.sutAccountId, "Matrix public actions require an explicit SUT account");
  const room = findMatrixQaProvisionedRoom(context.topology, "public-actions");
  assert.equal(room.memberRoles[0], "sut", "the SUT must create the action room");
  assert.equal(room.encrypted, false, "the action proof uses an unencrypted synthetic room");
  const roomPath = `/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}`;
  const completed: string[] = [];
  const marker = `MATRIX_PUBLIC_ACTIONS_${randomUUID()}`;
  const editedMarker = `${marker}_EDITED`;
  const emoji = "👍";
  const deadline = performance.now() + context.timeoutMs;
  const remaining = () => {
    const milliseconds = Math.ceil(deadline - performance.now());
    assert(milliseconds > 0, "Matrix action scenario exhausted its existing time budget");
    return milliseconds;
  };
  const observer = createMatrixQaRoomObserver({
    accessToken: context.observerAccessToken,
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
  });
  const read = async (suffix: string) => {
    remaining();
    const result = record(
      (
        await requestMatrixJson<unknown>({
          accessToken: context.observerAccessToken,
          baseUrl: context.baseUrl,
          endpoint: `${roomPath}/${suffix}`,
          fetchImpl: fetch,
          method: "GET",
        })
      ).body,
      "Matrix observer response",
    );
    remaining();
    return result;
  };
  const action = async (
    name: "send" | "read" | "edit" | "react" | "pin",
    params: Record<string, unknown>,
  ) => {
    remaining();
    const result = record(
      await gatewayCall("message.action", {
        channel: "matrix",
        accountId: context.sutAccountId,
        action: name,
        params,
        idempotencyKey: randomUUID(),
      }),
      `Matrix ${name} result`,
    );
    remaining();
    assert.equal(result.ok, true, `Matrix ${name} must succeed`);
    return result;
  };
  const observe = async (predicate: (event: MatrixQaObservedEvent) => boolean) =>
    (
      await observer.waitForRoomEvent({
        roomId: room.roomId,
        timeoutMs: remaining(),
        predicate: (event) =>
          event.roomId === room.roomId && event.sender === context.sutUserId && predicate(event),
      })
    ).event;
  const eventContent = async (eventId: string, type: string) => {
    const event = await read(`event/${encodeURIComponent(eventId)}`);
    assert.equal(event.event_id, eventId, "observer must fetch the accepted event");
    assert.equal(event.sender, context.sutUserId, "accepted event must belong to SUT");
    assert.equal(event.type, type, "accepted event must have the expected Matrix type");
    return record(event.content, "Matrix event content");
  };

  try {
    // The topology gives SUT room ownership; inspect actual permissions rather than granting more.
    const power = await read("state/m.room.power_levels");
    const users = record(power.users, "Matrix power-level users");
    const events = isRecord(power.events) ? power.events : {};
    const sutPower = users[context.sutUserId] ?? power.users_default ?? 0;
    const pinPower = events["m.room.pinned_events"] ?? power.state_default ?? 50;
    assert(
      typeof sutPower === "number" && typeof pinPower === "number" && sutPower >= pinPower,
      "SUT must already have permission to set the room's pinned events",
    );
    assert(await observer.prime(), "Matrix observer needs a pre-action sync cursor");

    const sent = await action("send", { to: room.roomId, message: marker });
    const sendResult = record(sent.result, "Matrix send payload");
    const messageId = acceptedEventId(sendResult.messageId, "Matrix send");
    completed.push(`send accepted=${messageId}`);
    assert.equal(sendResult.roomId, room.roomId, "send result must identify the requested room");
    await observe((event) => event.eventId === messageId && event.type === "m.room.message");
    const original = await eventContent(messageId, "m.room.message");
    assert.equal(original.body, marker);
    assert.equal(original.msgtype, "m.text");
    completed.push(`send observed=${messageId}`);

    const history = await action("read", { roomId: room.roomId, limit: 5 });
    assert.equal(history.roomId, room.roomId);
    assert(Array.isArray(history.messages) && history.messages.length <= 5);
    const message = record(
      history.messages.find((entry) => isRecord(entry) && entry.eventId === messageId),
      "Matrix read result for the accepted message",
    );
    assert.equal(message.id, messageId);
    assert.equal(message.body, original.body);
    assert.equal(message.content, original.body);
    assert.equal(message.sender, context.sutUserId);
    assert.equal(message.authorTag, context.sutUserId);
    completed.push(`read=${messageId}`);

    const edited = await action("edit", {
      roomId: room.roomId,
      messageId,
      message: editedMarker,
    });
    const editId = acceptedEventId(record(edited.result, "Matrix edit payload").eventId, "edit");
    completed.push(`edit accepted=${editId}->${messageId}`);
    assert.notEqual(editId, messageId, "an edit must be a separate accepted event");
    await observe((event) => event.eventId === editId && event.replacesEventId === messageId);
    const edit = await eventContent(editId, "m.room.message");
    assert.deepEqual(edit["m.relates_to"], { rel_type: "m.replace", event_id: messageId });
    assert.equal(record(edit["m.new_content"], "Matrix replacement content").body, editedMarker);
    completed.push(`edit=${editId}->${messageId}`);

    const reacted = await action("react", { roomId: room.roomId, messageId, emoji });
    assert.equal(reacted.added, emoji);
    const reaction = await observe(
      (event) =>
        event.type === "m.reaction" &&
        event.reaction?.eventId === messageId &&
        event.reaction.key === emoji,
    );
    const reactionId = acceptedEventId(reaction.eventId, "Matrix reaction observation");
    const reactionContent = await eventContent(reactionId, "m.reaction");
    assert.deepEqual(reactionContent["m.relates_to"], {
      rel_type: "m.annotation",
      event_id: messageId,
      key: emoji,
    });
    completed.push(`react=${reactionId}->${messageId}`);

    const pinned = await action("pin", { roomId: room.roomId, messageId });
    assert.deepEqual(pinned.pinned, [messageId]);
    const pin = await observe(
      (event) => event.type === "m.room.pinned_events" && event.stateKey === "",
    );
    const pinId = acceptedEventId(pin.eventId, "Matrix pin observation");
    assert.deepEqual((await eventContent(pinId, "m.room.pinned_events")).pinned, [messageId]);
    assert.deepEqual((await read("state/m.room.pinned_events")).pinned, [messageId]);
    completed.push(`pin=${pinId}->${messageId}`);

    return {
      artifacts: {
        accountId: context.sutAccountId,
        roomKey: room.key,
        roomId: room.roomId,
        rootEventId: messageId,
        editEventId: editId,
        reactionEventId: reactionId,
        reactionTargetEventId: messageId,
        reactionEmoji: emoji,
        token: marker,
        editedToken: editedMarker,
      },
      details: [
        "Five public Gateway message.action operations independently observed on Matrix.",
        `SUT room power=${sutPower}; pin requirement=${pinPower}`,
        ...completed,
      ].join("\n"),
    } satisfies MatrixQaScenarioExecution;
  } catch (error) {
    throw new Error(`Matrix public actions failed; completed: ${completed.join(", ") || "none"}`, {
      cause: error,
    });
  }
}
