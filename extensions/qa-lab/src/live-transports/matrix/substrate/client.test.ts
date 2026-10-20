import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMatrixQaMessageContent,
  resolveNextRegistrationAuth,
} from "./client-message-content.js";
import { createMatrixQaClient, provisionMatrixQaRoom } from "./client.js";
import { mockMatrixQaHttp } from "./http.test-support.js";

function resolveRequestUrl(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function parseJsonRequestBody(init?: RequestInit) {
  return (typeof init?.body === "string" ? JSON.parse(init.body) : {}) as Record<string, unknown>;
}

function makeClient(fetchImpl: typeof fetch) {
  mockMatrixQaHttp(fetchImpl);
  return createMatrixQaClient({
    accessToken: "token",
    baseUrl: "http://127.0.0.1:28008/",
  });
}

const roomId = "!room:matrix-qa.test";
const roomEndpoint = "http://127.0.0.1:28008/_matrix/client/v3/rooms/!room%3Amatrix-qa.test";
function captureRequests(respond: (count: number) => object = () => ({})) {
  const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
  const client = makeClient(async (input, init) => {
    requests.push({ body: parseJsonRequestBody(init), url: resolveRequestUrl(input) });
    return Response.json(respond(requests.length));
  });
  return { client, requests };
}

function provisioningFetch(
  register: (body: Record<string, unknown>) => Response,
  roomIds = [roomId],
  joinRoomId = roomId,
) {
  const createRoomBodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = resolveRequestUrl(input);
    const body = parseJsonRequestBody(init);
    if (url.endsWith("/_matrix/client/v3/login")) {
      const userId = (body.identifier as { user: string }).user;
      return Response.json({
        access_token: `observation-token-${userId}`,
        device_id: `observation-device-${userId}`,
        user_id: userId,
      });
    }
    if (url.endsWith("/_matrix/client/v3/register")) {
      return register(body);
    }
    if (url.endsWith("/_matrix/client/v3/createRoom")) {
      createRoomBodies.push(body);
      return Response.json({ room_id: roomIds.shift() });
    }
    if (url.includes("/_matrix/client/v3/join/")) {
      return Response.json({ room_id: joinRoomId });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, createRoomBodies };
}

const image = {
  body: "@sut:matrix-qa.test Image understanding check",
  buffer: Buffer.from("png-bytes"),
  contentType: "image/png",
  fileName: "image.png",
  kind: "image" as const,
  mentionUserIds: ["@sut:matrix-qa.test"],
  roomId,
};
const privateRoom = {
  creation_content: { "m.federate": false },
  initial_state: [
    {
      type: "m.room.history_visibility",
      state_key: "",
      content: { history_visibility: "joined" },
    },
  ],
  preset: "private_chat",
};
const provisionParams = {
  baseUrl: "http://127.0.0.1:28008/",
  driverLocalpart: "qa-driver",
  observerLocalpart: "qa-observer",
  registrationToken: "reg-token",
  sutLocalpart: "qa-sut",
};
const groupUserIds = [
  "@qa-driver:matrix-qa.test",
  "@qa-observer:matrix-qa.test",
  "@qa-sut:matrix-qa.test",
];
const groupSpec = {
  key: "main",
  kind: "group" as const,
  members: ["driver", "observer", "sut"] as const,
  name: "OpenClaw Matrix QA",
  requireMention: true,
};
function expectedGroup(overrides: { key?: string; name?: string; roomId?: string } = {}) {
  return {
    encrypted: false,
    key: "main",
    kind: "group",
    memberRoles: ["driver", "observer", "sut"],
    memberUserIds: groupUserIds,
    name: "OpenClaw Matrix QA",
    requireMention: true,
    roomId,
    ...overrides,
  };
}
function expectedCreation(name: string, isDirect = false) {
  return {
    ...privateRoom,
    invite: isDirect ? [groupUserIds[2]] : groupUserIds.slice(1),
    is_direct: isDirect,
    name,
  };
}

describe("matrix driver client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits Matrix HTML markup when the body has no visible mention token", () => {
    expect(
      buildMatrixQaMessageContent({
        body: "reply with exactly: TOKEN",
        mentionUserIds: ["@sut:matrix-qa.test"],
      }),
    ).toEqual({
      body: "reply with exactly: TOKEN",
      msgtype: "m.text",
      "m.mentions": { user_ids: ["@sut:matrix-qa.test"] },
    });
  });

  it("rejects Matrix UIAA flows that require unsupported stages", () => {
    expect(() =>
      resolveNextRegistrationAuth({
        registrationToken: "reg-token",
        response: {
          session: "uiaa-session",
          flows: [{ stages: ["m.login.registration_token", "m.login.recaptcha", "m.login.dummy"] }],
        },
      }),
    ).toThrow("Matrix registration requires unsupported auth stages:");
  });

  it("issues Matrix room membership control requests for QA topology changes", async () => {
    const { client, requests } = captureRequests();
    const member = { roomId, userId: "@observer:matrix-qa.test" };
    await client.inviteUserToRoom(member);
    await client.kickUserFromRoom({ ...member, reason: "topology reset" });
    await client.leaveRoom(roomId);

    expect(requests).toEqual([
      { url: `${roomEndpoint}/invite`, body: { user_id: member.userId } },
      {
        url: `${roomEndpoint}/kick`,
        body: { reason: "topology reset", user_id: member.userId },
      },
      { url: `${roomEndpoint}/leave`, body: {} },
    ]);
  });

  it("sends Matrix reactions through the protocol send endpoint", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(resolveRequestUrl(input)).toContain(`${roomEndpoint}/send/m.reaction/`);
      expect(parseJsonRequestBody(init)).toEqual({
        "m.relates_to": { rel_type: "m.annotation", event_id: "$msg-1", key: "👍" },
      });
      return Response.json({ event_id: "$reaction-1" });
    };

    const client = makeClient(fetchImpl);

    await expect(
      client.sendReaction({ emoji: " 👍 ", messageId: " $msg-1 ", roomId }),
    ).resolves.toBe("$reaction-1");
  });

  it("sends Matrix replacements and redactions through protocol endpoints", async () => {
    const { client, requests } = captureRequests((count) => ({
      event_id: count === 1 ? "$replacement-1" : "$redaction-1",
    }));

    await expect(
      client.sendReplacementMessage({
        body: "@sut:matrix-qa.test updated prompt",
        mentionUserIds: ["@sut:matrix-qa.test"],
        roomId,
        targetEventId: " $msg-1 ",
      }),
    ).resolves.toBe("$replacement-1");
    await expect(
      client.redactEvent({ eventId: "$reaction-1", reason: "qa cleanup", roomId }),
    ).resolves.toBe("$redaction-1");

    expect(requests[0]).toEqual({
      url: expect.stringContaining(`${roomEndpoint}/send/m.room.message/`),
      body: {
        body: "* @sut:matrix-qa.test updated prompt",
        msgtype: "m.text",
        "m.new_content": {
          body: "@sut:matrix-qa.test updated prompt",
          msgtype: "m.text",
          format: "org.matrix.custom.html",
          formatted_body:
            '<a href="https://matrix.to/#/%40sut%3Amatrix-qa.test">@sut:matrix-qa.test</a> updated prompt',
          "m.mentions": { user_ids: ["@sut:matrix-qa.test"] },
        },
        "m.relates_to": { rel_type: "m.replace", event_id: "$msg-1" },
      },
    });
    expect(requests[1]).toEqual({
      url: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:28008\/_matrix\/client\/v3\/rooms\/!room%3Amatrix-qa\.test\/redact\/%24reaction-1\/[0-9a-f-]{36}$/,
      ),
      body: { reason: "qa cleanup" },
    });
  });

  it("uploads Matrix media before sending the room event", async () => {
    const requests: Array<{ body: RequestInit["body"]; url: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ body: init?.body, url: resolveRequestUrl(input) });
      if (requests.length === 1) {
        return Response.json({ content_uri: "mxc://matrix-qa.test/image" });
      }
      return Response.json({ event_id: "$media-1" });
    };

    const client = makeClient(fetchImpl);

    await expect(client.sendMediaMessage(image)).resolves.toBe("$media-1");

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      "http://127.0.0.1:28008/_matrix/media/v3/upload?filename=image.png",
    );
    expect(requests[0]?.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(requests[0]?.body as Uint8Array)).toEqual(Array.from(image.buffer));
    expect(requests[1]?.url).toContain(`${roomEndpoint}/send/m.room.message/`);
    const messageBody =
      typeof requests[1]?.body === "string" ? JSON.parse(requests[1].body) : requests[1]?.body;
    expect(messageBody).toMatchObject({
      body: image.body,
      msgtype: "m.image",
      filename: image.fileName,
      url: "mxc://matrix-qa.test/image",
      info: { mimetype: "image/png", size: "png-bytes".length },
      "m.mentions": { user_ids: ["@sut:matrix-qa.test"] },
    });
  });

  it("fails closed when the media upload response streams an over-cap body", async () => {
    const chunkSize = 1024 * 1024;
    const chunkCount = 32; // 32 MiB total, past the 16 MiB cap
    let reads = 0;
    let canceled = false;
    const encoder = new TextEncoder();
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            reads += 1;
            controller.enqueue(encoder.encode("a".repeat(chunkSize)));
            if (reads >= chunkCount) {
              controller.close();
            }
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const client = makeClient(fetchImpl);

    await expect(client.sendMediaMessage({ ...image, fileName: "huge.png" })).rejects.toThrow(
      /Matrix homeserver response exceeds 16777216 bytes/,
    );

    expect(canceled).toBe(true);
    expect(reads).toBeLessThan(chunkCount);
  });

  it("still tolerates malformed in-bounds media upload JSON", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("{ not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const client = makeClient(fetchImpl);

    await expect(client.sendMediaMessage({ ...image, fileName: "bad.png" })).rejects.toThrow(
      "Matrix media upload did not return content_uri.",
    );
  });

  it("adds Matrix room encryption state when provisioning encrypted QA rooms", async () => {
    const createRoomBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      createRoomBodies.push(parseJsonRequestBody(init));
      expect(resolveRequestUrl(input)).toBe("http://127.0.0.1:28008/_matrix/client/v3/createRoom");
      return Response.json({ room_id: "!encrypted:matrix-qa.test" });
    };

    const client = makeClient(fetchImpl);

    await expect(
      client.createPrivateRoom({
        encrypted: true,
        inviteUserIds: ["@sut:matrix-qa.test"],
        name: "Encrypted QA Room",
      }),
    ).resolves.toBe("!encrypted:matrix-qa.test");

    expect(createRoomBodies).toStrictEqual([
      {
        ...privateRoom,
        initial_state: [
          ...privateRoom.initial_state,
          {
            type: "m.room.encryption",
            state_key: "",
            content: { algorithm: "m.megolm.v1.aes-sha2" },
          },
        ],
        invite: ["@sut:matrix-qa.test"],
        is_direct: false,
        name: "Encrypted QA Room",
      },
    ]);
  });

  it("provisions a three-member room so Matrix QA runs in a group context", async () => {
    const tokenAuthedUsers = new Set<string>();
    const { fetchImpl, createRoomBodies } = provisioningFetch((body) => {
      const username = typeof body.username === "string" ? body.username : "";
      const auth = typeof body.auth === "object" && body.auth ? body.auth : undefined;
      const challenge = {
        session: `session-${username}`,
        flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
      };
      if (!auth) {
        return Response.json(challenge, { status: 401 });
      }
      if ((auth as { type?: string }).type === "m.login.registration_token") {
        expect(auth).toEqual({
          session: challenge.session,
          type: "m.login.registration_token",
          token: "reg-token",
        });
        tokenAuthedUsers.add(username);
        return Response.json(
          { ...challenge, completed: ["m.login.registration_token"] },
          { status: 401 },
        );
      }
      expect(tokenAuthedUsers.has(username)).toBe(true);
      expect(auth).toEqual({ session: challenge.session, type: "m.login.dummy" });
      return Response.json({
        access_token: `token-${username}`,
        device_id: `device-${username}`,
        user_id: `@${username}:matrix-qa.test`,
      });
    });

    mockMatrixQaHttp(fetchImpl);

    const result = await provisionMatrixQaRoom({
      ...provisionParams,
      roomName: groupSpec.name,
      topology: {
        defaultRoomKey: "main",
        rooms: [{ ...groupSpec, members: [...groupSpec.members], encrypted: false }],
      },
    });

    expect(result).toMatchObject({ roomId, observer: { userId: "@qa-observer:matrix-qa.test" } });
    expect(result.topology).toEqual({
      defaultRoomId: roomId,
      defaultRoomKey: "main",
      rooms: [expectedGroup()],
    });
    expect(createRoomBodies).toEqual([expectedCreation(groupSpec.name)]);
  });

  it("provisions direct-message topology rooms with Matrix direct-room flags", async () => {
    let registerCount = 0;
    const { fetchImpl, createRoomBodies } = provisioningFetch(
      () => {
        registerCount += 1;
        const role = ["driver", "sut", "observer"][registerCount - 1];
        return Response.json({
          access_token: `token-${role}`,
          user_id: `@qa-${role}:matrix-qa.test`,
        });
      },
      ["!group:matrix-qa.test", "!dm:matrix-qa.test"],
      "!joined:matrix-qa.test",
    );

    mockMatrixQaHttp(fetchImpl);

    const result = await provisionMatrixQaRoom({
      ...provisionParams,
      roomName: "unused",
      topology: {
        defaultRoomKey: "group",
        rooms: [
          {
            ...groupSpec,
            key: "group",
            members: [...groupSpec.members],
            name: "Matrix Group",
          },
          {
            key: "sut-dm",
            kind: "dm",
            members: ["driver", "sut"],
            name: "Matrix Driver/SUT DM",
          },
        ],
      },
    });

    expect(result.topology.rooms).toEqual([
      expectedGroup({ key: "group", name: "Matrix Group", roomId: "!group:matrix-qa.test" }),
      {
        encrypted: false,
        key: "sut-dm",
        kind: "dm",
        memberRoles: ["driver", "sut"],
        memberUserIds: ["@qa-driver:matrix-qa.test", "@qa-sut:matrix-qa.test"],
        name: "Matrix Driver/SUT DM",
        requireMention: false,
        roomId: "!dm:matrix-qa.test",
      },
    ]);
    expect(createRoomBodies).toEqual([
      expectedCreation("Matrix Group"),
      expectedCreation("Matrix Driver/SUT DM", true),
    ]);
  });
});
