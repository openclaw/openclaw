import assert from "node:assert/strict";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { mockMatrixQaHttp } from "../substrate/http.test-support.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import { runPublicMessageActionsScenario } from "./scenario-runtime-message-actions.js";
import { matrixSyncResponse } from "./scenario-runtime.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("proves creator actions remotely with pin denied=%s", async (denyPin) => {
  const events: (Record<string, unknown> & { event_id: string })[] = [];
  const actions: string[] = [];
  let body = "";
  const context = createMatrixQaE2eeTestContext({
    sutAccountId: "sut",
    gatewayCall: async (_method, envelope) => {
      const action = String(envelope?.action);
      actions.push(action);
      const params = envelope?.params;
      assert(isRecord(params));
      if (action === "read") {
        return {
          ok: true,
          roomId: context.roomId,
          messages: [
            {
              id: "$send",
              eventId: "$send",
              body,
              content: body,
              sender: context.sutUserId,
              authorTag: context.sutUserId,
            },
          ],
        };
      }
      if (action === "pin" && denyPin) {
        return { ok: false, error: "M_FORBIDDEN" };
      }
      const content =
        action === "send"
          ? { body: String(params.message), msgtype: "m.text" }
          : action === "edit"
            ? {
                "m.relates_to": { rel_type: "m.replace", event_id: "$send" },
                "m.new_content": { body: String(params.message), msgtype: "m.text" },
              }
            : action === "react"
              ? { "m.relates_to": { rel_type: "m.annotation", event_id: "$send", key: "👍" } }
              : { pinned: ["$send"] };
      if (action === "send") {
        body = String(params.message);
      }
      events.push({
        event_id: "$" + action,
        sender: context.sutUserId,
        type:
          action === "react"
            ? "m.reaction"
            : action === "pin"
              ? "m.room.pinned_events"
              : "m.room.message",
        ...(action === "pin" ? { state_key: "" } : {}),
        content,
      });
      return action === "send"
        ? {
            channel: "matrix",
            deliveryStatus: "sent",
            result: { messageId: "$send", target: { kind: "room", id: context.roomId } },
          }
        : action === "edit"
          ? { ok: true, result: { eventId: "$edit" } }
          : action === "react"
            ? { ok: true, added: "👍" }
            : { ok: true, pinned: ["$send"] };
    },
  });
  context.topology.rooms.push({
    key: "public-actions",
    kind: "group",
    name: "actions",
    roomId: context.roomId,
    memberRoles: ["sut"],
    memberUserIds: [context.sutUserId],
    encrypted: false,
    requireMention: false,
  });
  mockMatrixQaHttp(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const path = decodeURIComponent(url.pathname);
    if (path.endsWith("/sync")) {
      return matrixSyncResponse(context.roomId, events);
    }
    if (path.endsWith("/state/m.room.power_levels")) {
      // Room v12 creators are privileged without an entry in power-level users.
      return Response.json({ users: {}, users_default: 0, state_default: 50 });
    }
    if (path.endsWith("/state/m.room.pinned_events")) {
      return Response.json({ pinned: ["$send"] });
    }
    const event = events.find((entry) => path.endsWith("/event/" + entry.event_id));
    expect(event).toBeDefined();
    return Response.json(event);
  });
  if (denyPin) {
    await expect(runPublicMessageActionsScenario(context)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Matrix pin must succeed"),
      }),
    });
  } else {
    await expect(runPublicMessageActionsScenario(context)).resolves.toMatchObject({
      details: expect.stringContaining("pin=$pin->$send"),
    });
  }
  expect(actions).toEqual(["send", "read", "edit", "react", "pin"]);
});
