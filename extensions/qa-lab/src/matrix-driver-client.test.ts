import { describe, expect, it } from "vitest";
import {
  __testing,
  createMatrixQaClient,
  provisionMatrixQaRoom,
  type MatrixQaObservedEvent,
} from "./matrix-driver-client.js";

describe("matrix driver client", () => {
  it("builds Matrix HTML mentions for QA driver messages", () => {
    expect(
      __testing.buildMatrixQaMessageContent({
        body: "@sut:matrix-qa.test reply with exactly: TOKEN",
        mentionUserIds: ["@sut:matrix-qa.test"],
      }),
    ).toEqual({
      body: "@sut:matrix-qa.test reply with exactly: TOKEN",
      msgtype: "m.text",
      format: "org.matrix.custom.html",
      formatted_body:
        '<a href="https://matrix.to/#/%40sut%3Amatrix-qa.test">@sut:matrix-qa.test</a> reply with exactly: TOKEN',
      "m.mentions": {
        user_ids: ["@sut:matrix-qa.test"],
      },
    });
  });

  it("omits Matrix HTML markup when the body has no visible mention token", () => {
    expect(
      __testing.buildMatrixQaMessageContent({
        body: "reply with exactly: TOKEN",
        mentionUserIds: ["@sut:matrix-qa.test"],
      }),
    ).toEqual({
      body: "reply with exactly: TOKEN",
      msgtype: "m.text",
      "m.mentions": {
        user_ids: ["@sut:matrix-qa.test"],
      },
    });
  });

  it("normalizes message events with thread metadata", () => {
    expect(
      __testing.normalizeMatrixQaObservedEvent("!room:matrix-qa.test", {
        event_id: "$event",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        origin_server_ts: 1_700_000_000_000,
        content: {
          body: "hello",
          msgtype: "m.text",
          "m.mentions": {
            user_ids: ["@sut:matrix-qa.test"],
          },
          "m.relates_to": {
            rel_type: "m.thread",
            event_id: "$root",
            is_falling_back: true,
            "m.in_reply_to": {
              event_id: "$driver",
            },
          },
        },
      }),
    ).toEqual({
      roomId: "!room:matrix-qa.test",
      eventId: "$event",
      sender: "@sut:matrix-qa.test",
      type: "m.room.message",
      originServerTs: 1_700_000_000_000,
      body: "hello",
      msgtype: "m.text",
      relatesTo: {
        relType: "m.thread",
        eventId: "$root",
        inReplyToId: "$driver",
        isFallingBack: true,
      },
      mentions: {
        userIds: ["@sut:matrix-qa.test"],
      },
    });
  });

  it("advances Matrix registration through token then dummy auth stages", () => {
    const firstStage = __testing.resolveNextRegistrationAuth({
      registrationToken: "reg-token",
      response: {
        session: "uiaa-session",
        flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
      },
    });

    expect(firstStage).toEqual({
      session: "uiaa-session",
      type: "m.login.registration_token",
      token: "reg-token",
    });

    expect(
      __testing.resolveNextRegistrationAuth({
        registrationToken: "reg-token",
        response: {
          session: "uiaa-session",
          completed: ["m.login.registration_token"],
          flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
        },
      }),
    ).toEqual({
      session: "uiaa-session",
      type: "m.login.dummy",
    });
  });

  it("returns a typed no-match result while preserving the latest sync token", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          next_batch: "next-batch-2",
          rooms: {
            join: {
              "!room:matrix-qa.test": {
                timeline: {
                  events: [
                    {
                      event_id: "$driver",
                      sender: "@driver:matrix-qa.test",
                      type: "m.room.message",
                      content: { body: "hello", msgtype: "m.text" },
                    },
                  ],
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const client = createMatrixQaClient({
      accessToken: "token",
      baseUrl: "http://127.0.0.1:28008/",
      fetchImpl,
    });
    const observedEvents: MatrixQaObservedEvent[] = [];

    const result = await client.waitForOptionalRoomEvent({
      observedEvents,
      predicate: (event) => event.sender === "@sut:matrix-qa.test",
      roomId: "!room:matrix-qa.test",
      since: "start-batch",
      timeoutMs: 1,
    });

    expect(result).toEqual({
      matched: false,
      since: "next-batch-2",
    });
    expect(observedEvents).toEqual([
      expect.objectContaining({
        body: "hello",
        eventId: "$driver",
        roomId: "!room:matrix-qa.test",
        sender: "@driver:matrix-qa.test",
        type: "m.room.message",
      }),
    ]);
  });

  it("provisions a three-member room so Matrix QA runs in a group context", async () => {
    const createRoomBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (url.endsWith("/_matrix/client/v3/register")) {
        const username = typeof body.username === "string" ? body.username : "";
        const auth = typeof body.auth === "object" && body.auth ? body.auth : undefined;
        if (!auth) {
          return new Response(
            JSON.stringify({
              session: `session-${username}`,
              flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        if ((auth as { type?: string }).type === "m.login.registration_token") {
          return new Response(
            JSON.stringify({
              session: `session-${username}`,
              completed: ["m.login.registration_token"],
              flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            access_token: `token-${username}`,
            device_id: `device-${username}`,
            user_id: `@${username}:matrix-qa.test`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/_matrix/client/v3/createRoom")) {
        createRoomBodies.push(body);
        return new Response(JSON.stringify({ room_id: "!room:matrix-qa.test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/_matrix/client/v3/join/")) {
        return new Response(JSON.stringify({ room_id: "!room:matrix-qa.test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const result = await provisionMatrixQaRoom({
      baseUrl: "http://127.0.0.1:28008/",
      driverLocalpart: "qa-driver",
      observerLocalpart: "qa-observer",
      registrationToken: "reg-token",
      roomName: "OpenClaw Matrix QA",
      sutLocalpart: "qa-sut",
      fetchImpl,
    });

    expect(result.roomId).toBe("!room:matrix-qa.test");
    expect(result.observer.userId).toBe("@qa-observer:matrix-qa.test");
    expect(createRoomBodies).toEqual([
      expect.objectContaining({
        invite: ["@qa-sut:matrix-qa.test", "@qa-observer:matrix-qa.test"],
        is_direct: false,
        preset: "private_chat",
      }),
    ]);
  });
});
