import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMatrixQaMessageContent,
  resolveNextRegistrationAuth,
} from "./client-message-content.js";
import { createMatrixQaClient, provisionMatrixQaRoom } from "./client.js";
import { mockMatrixQaHttp } from "./http.test-support.js";
import { requestMatrixJson } from "./request.js";

const baseUrl = "http://127.0.0.1:28008/";
const roomId = "!room:matrix-qa.test";
const sut = "@sut:matrix-qa.test";
const roomEndpoint = baseUrl + "_matrix/client/v3/rooms/!room%3Amatrix-qa.test";
const clientParams = { accessToken: "token", baseUrl };
const image = {
  body: sut + " Image understanding check",
  buffer: Buffer.from("png-bytes"),
  contentType: "image/png",
  fileName: "image.png",
  kind: "image" as const,
  mentionUserIds: [sut],
  roomId,
};
const privateRoom = {
  creation_content: { "m.federate": false },
  preset: "private_chat",
  initial_state: [
    { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "joined" } },
  ],
};
const encryptionState = {
  type: "m.room.encryption",
  state_key: "",
  content: { algorithm: "m.megolm.v1.aes-sha2" },
};
function url(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}
function json(init?: RequestInit): Record<string, unknown> {
  return typeof init?.body === "string" ? JSON.parse(init.body) : {};
}
function makeClient(fetchImpl: typeof fetch) {
  mockMatrixQaHttp(fetchImpl);
  return createMatrixQaClient(clientParams);
}
function capture(responses: object[] = []) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const client = makeClient(async (input, init) => {
    requests.push({
      url: url(input),
      body: typeof init?.body === "string" ? json(init) : (init?.body ?? {}),
    });
    return Response.json(responses.shift() ?? {});
  });
  return { client, requests };
}
const request = (timeoutMs?: number) =>
  requestMatrixJson({
    baseUrl: "https://matrix.example.test",
    endpoint: "/_matrix/client/v3/account/whoami",
    method: "GET",
    timeoutMs,
  });
afterEach(() => vi.restoreAllMocks());

describe("matrix driver client", () => {
  it("omits Matrix HTML markup when the body has no visible mention token", () => {
    expect(
      buildMatrixQaMessageContent({ body: "reply with exactly: TOKEN", mentionUserIds: [sut] }),
    ).toEqual({
      body: "reply with exactly: TOKEN",
      msgtype: "m.text",
      "m.mentions": { user_ids: [sut] },
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
    const { client, requests } = capture();
    const userId = "@observer:matrix-qa.test";
    await client.inviteUserToRoom({ roomId, userId });
    await client.kickUserFromRoom({ roomId, userId, reason: "topology reset" });
    await client.leaveRoom(roomId);
    expect(requests).toEqual([
      { url: roomEndpoint + "/invite", body: { user_id: userId } },
      { url: roomEndpoint + "/kick", body: { reason: "topology reset", user_id: userId } },
      { url: roomEndpoint + "/leave", body: {} },
    ]);
  });

  it.each([
    {
      name: "reaction",
      run: (client: ReturnType<typeof makeClient>) =>
        client.sendReaction({ emoji: " 👍 ", messageId: " $msg-1 ", roomId }),
      endpoint: expect.stringContaining(roomEndpoint + "/send/m.reaction/"),
      body: { "m.relates_to": { rel_type: "m.annotation", event_id: "$msg-1", key: "👍" } },
    },
    {
      name: "replacement",
      run: (client: ReturnType<typeof makeClient>) =>
        client.sendReplacementMessage({
          body: sut + " updated prompt",
          mentionUserIds: [sut],
          roomId,
          targetEventId: " $msg-1 ",
        }),
      endpoint: expect.stringContaining(roomEndpoint + "/send/m.room.message/"),
      body: {
        body: "* " + sut + " updated prompt",
        msgtype: "m.text",
        "m.new_content": {
          body: sut + " updated prompt",
          msgtype: "m.text",
          format: "org.matrix.custom.html",
          formatted_body:
            '<a href="https://matrix.to/#/%40sut%3Amatrix-qa.test">@sut:matrix-qa.test</a> updated prompt',
          "m.mentions": { user_ids: [sut] },
        },
        "m.relates_to": { rel_type: "m.replace", event_id: "$msg-1" },
      },
    },
    {
      name: "redaction",
      run: (client: ReturnType<typeof makeClient>) =>
        client.redactEvent({ eventId: "$reaction-1", reason: "qa cleanup", roomId }),
      endpoint: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:28008\/_matrix\/client\/v3\/rooms\/!room%3Amatrix-qa\.test\/redact\/%24reaction-1\/[0-9a-f-]{36}$/,
      ),
      body: { reason: "qa cleanup" },
    },
  ])("sends $name through its protocol endpoint", async ({ name, run, endpoint, body }) => {
    const eventId = "$" + name + "-1";
    const { client, requests } = capture([{ event_id: eventId }]);
    await expect(run(client)).resolves.toBe(eventId);
    expect(requests).toEqual([{ url: endpoint, body }]);
  });

  it("uploads Matrix media before sending the room event", async () => {
    const { client, requests } = capture([
      { content_uri: "mxc://matrix-qa.test/image" },
      { event_id: "$media-1" },
    ]);
    await expect(client.sendMediaMessage(image)).resolves.toBe("$media-1");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(baseUrl + "_matrix/media/v3/upload?filename=image.png");
    expect(requests[0]?.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(requests[0]?.body as Uint8Array)).toEqual(Array.from(image.buffer));
    expect(requests[1]?.url).toContain(roomEndpoint + "/send/m.room.message/");
    expect(requests[1]?.body).toMatchObject({
      body: image.body,
      msgtype: "m.image",
      filename: image.fileName,
      url: "mxc://matrix-qa.test/image",
      info: { mimetype: "image/png", size: "png-bytes".length },
      "m.mentions": { user_ids: [sut] },
    });
  });
  it.each([
    ["media upload", 200],
    ["JSON request", 200],
    ["JSON request", 500],
  ] as const)("cancels an over-cap %s response before handling HTTP %s", async (entry, status) => {
    let reads = 0;
    let canceled = false;
    const http = mockMatrixQaHttp(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              reads += 1;
              controller.enqueue(new TextEncoder().encode("a".repeat(1024 * 1024)));
              if (reads >= 32) {
                controller.close();
              }
            },
            cancel() {
              canceled = true;
            },
          }),
          { status, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(
      entry === "media upload"
        ? createMatrixQaClient(clientParams).sendMediaMessage({ ...image, fileName: "huge.png" })
        : request(),
    ).rejects.toThrow(/Matrix homeserver response exceeds 16777216 bytes/);
    expect(canceled).toBe(true);
    expect(reads).toBeLessThan(32);
    expect(http.release).toHaveBeenCalledOnce();
  });
  it.each(["media upload", "JSON request"])(
    "handles malformed in-bounds %s JSON",
    async (entry) => {
      const client = makeClient(
        async () => new Response("{ not json", { headers: { "content-type": "application/json" } }),
      );
      if (entry === "media upload") {
        await expect(client.sendMediaMessage({ ...image, fileName: "bad.png" })).rejects.toThrow(
          "Matrix media upload did not return content_uri.",
        );
      } else {
        await expect(request()).resolves.toEqual({ status: 200, body: {} });
      }
    },
  );
  it("caps oversized request timeouts before creating the abort signal", async () => {
    const signal = AbortSignal.abort();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const http = mockMatrixQaHttp(fetch);
    await request(MAX_TIMER_TIMEOUT_MS + 1_000_000);
    expect(timeout).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetch).toHaveBeenCalledWith(
      "https://matrix.example.test/_matrix/client/v3/account/whoami",
      expect.objectContaining({ signal }),
    );
    expect(http.release).toHaveBeenCalledOnce();
  });
  it("reads a large in-bounds JSON body unchanged", async () => {
    const body = { data: "x".repeat(8 * 1024 * 1024) };
    mockMatrixQaHttp(async () => Response.json(body));
    await expect(request()).resolves.toEqual({ status: 200, body });
  });

  it("provisions encrypted group and plain direct rooms through token and dummy authentication", async () => {
    const created: Record<string, unknown>[] = [];
    const roomIds = ["!group:matrix-qa.test", "!dm:matrix-qa.test"];
    const tokenAuthed = new Set<string>();
    makeClient(async (input, init) => {
      const path = url(input);
      const body = json(init);
      if (path.endsWith("/login")) {
        const userId = (body.identifier as { user: string }).user;
        return Response.json({
          access_token: "observation-token-" + userId,
          device_id: "observation-device-" + userId,
          user_id: userId,
        });
      }
      if (path.endsWith("/createRoom")) {
        created.push(body);
        return Response.json({ room_id: roomIds.shift() });
      }
      if (path.includes("/join/")) {
        return Response.json({ room_id: "!joined:matrix-qa.test" });
      }
      if (!path.endsWith("/register")) {
        throw new Error("unexpected fetch " + path);
      }
      const username = typeof body.username === "string" ? body.username : "";
      const account = {
        access_token: "token-" + username,
        user_id: "@" + username + ":matrix-qa.test",
      };
      if (username === "qa-observer") {
        return Response.json(account);
      }
      const auth = typeof body.auth === "object" && body.auth ? body.auth : undefined;
      const challenge = {
        session: "session-" + username,
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
        tokenAuthed.add(username);
        return Response.json(
          { ...challenge, completed: ["m.login.registration_token"] },
          { status: 401 },
        );
      }
      expect(tokenAuthed.has(username)).toBe(true);
      expect(auth).toEqual({ session: challenge.session, type: "m.login.dummy" });
      return Response.json({ ...account, device_id: "device-" + username });
    });
    const members = ["driver", "observer", "sut"] as const;
    const users = [
      "@qa-driver:matrix-qa.test",
      "@qa-observer:matrix-qa.test",
      "@qa-sut:matrix-qa.test",
    ];
    const result = await provisionMatrixQaRoom({
      baseUrl,
      driverLocalpart: "qa-driver",
      observerLocalpart: "qa-observer",
      sutLocalpart: "qa-sut",
      registrationToken: "reg-token",
      roomName: "unused",
      topology: {
        defaultRoomKey: "group",
        rooms: [
          {
            key: "group",
            kind: "group",
            members: [...members],
            name: "Group",
            encrypted: true,
            requireMention: true,
          },
          { key: "sut-dm", kind: "dm", members: ["driver", "sut"], name: "DM" },
        ],
      },
    });
    expect(result).toMatchObject({
      roomId: "!group:matrix-qa.test",
      observer: { userId: users[1] },
    });
    expect(result.topology).toEqual({
      defaultRoomId: "!group:matrix-qa.test",
      defaultRoomKey: "group",
      rooms: [
        {
          encrypted: true,
          key: "group",
          kind: "group",
          memberRoles: [...members],
          memberUserIds: users,
          name: "Group",
          requireMention: true,
          roomId: "!group:matrix-qa.test",
        },
        {
          encrypted: false,
          key: "sut-dm",
          kind: "dm",
          memberRoles: ["driver", "sut"],
          memberUserIds: [users[0], users[2]],
          name: "DM",
          requireMention: false,
          roomId: "!dm:matrix-qa.test",
        },
      ],
    });
    expect(created).toEqual([
      {
        ...privateRoom,
        initial_state: [...privateRoom.initial_state, encryptionState],
        invite: users.slice(1),
        is_direct: false,
        name: "Group",
      },
      { ...privateRoom, invite: [users[2]], is_direct: true, name: "DM" },
    ]);
  });
});
