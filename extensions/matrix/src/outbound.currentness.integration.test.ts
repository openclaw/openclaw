import type http from "node:http";
import { MatrixClient as MatrixJsClient, MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "./channel.js";
import { MatrixClient } from "./matrix/sdk.js";
import { sendMessageMatrix } from "./matrix/send.js";
import type { MatrixSendOpts } from "./matrix/send/types.js";
import { getMatrixRuntime, setMatrixRuntime } from "./runtime.js";
import { installMatrixTestRuntime } from "./test-runtime.js";

type Registration = "outbound" | "message";
type SendOutcome<T> = { value: T | undefined; error: unknown };
type FixtureRequest = {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  path: string;
};
type FixtureHandlers = {
  request?: (request: FixtureRequest) => boolean | Promise<boolean>;
  timeline?: (request: FixtureRequest & { index: number }) => void | Promise<void>;
};

const ROOM_ID = "!room:example.org";
const MEDIA_ROOT = "/matrix-currentness";
const MEDIA_BYTES = Buffer.from("Matrix fixture attachment");

function guardedCaller(caller: AbortController) {
  return {
    signal: caller.signal,
    assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
    onPlatformSendDispatch: async () => caller.signal.throwIfAborted(),
  };
}

function expectAccepted(result: SendOutcome<unknown>, id: string) {
  expect(result.error).toBeUndefined();
  expect(result.value).toMatchObject({ messageId: id, receipt: { platformMessageIds: [id] } });
}
function expectCanceled(result: SendOutcome<unknown>, reason: Error) {
  expect(result.error).toMatchObject({ message: expect.stringContaining(reason.message) });
}
function createPause() {
  const entered = createDeferred<void>();
  const resumed = createDeferred<void>();
  return {
    entered: entered.promise,
    open: () => resumed.resolve(),
    wait: async () => {
      entered.resolve();
      await resumed.promise;
    },
  };
}
afterEach(() => vi.restoreAllMocks());

function queueForRoom(client: MatrixJsClient, roomId: string) {
  const event = new MatrixEvent({
    room_id: roomId,
    type: "m.room.message",
    content: { msgtype: "m.text", body: "fixture" },
  });
  return () =>
    client
      .getScheduler()
      ?.getQueueForEvent(event)
      ?.map((queued) => queued.getRoomId());
}

function observedSdkClient(sdkSend: { mock: { contexts: unknown[] } }) {
  const client = sdkSend.mock.contexts[0];
  if (!(client instanceof MatrixJsClient)) {
    throw new Error("real Matrix SDK sender was not observed");
  }
  return client;
}

function registeredSenders(registration: Registration) {
  const outbound = matrixPlugin.outbound;
  const message = matrixPlugin.message?.send;
  const sendText = registration === "outbound" ? outbound?.sendText : message?.text;
  const sendMedia = registration === "outbound" ? outbound?.sendMedia : message?.media;
  const sendPayload = registration === "outbound" ? outbound?.sendPayload : message?.payload;
  if (!sendText || !sendMedia || !sendPayload) {
    throw new Error(`missing Matrix ${registration} sender`);
  }
  return { sendText, sendMedia, sendPayload };
}

async function settle<T extends Promise<unknown>>(result: T): Promise<SendOutcome<Awaited<T>>> {
  try {
    return { value: await result, error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
}

async function waitForBoundary<T>(
  boundary: Promise<void>,
  result: Promise<SendOutcome<T>>,
  label: string,
): Promise<void> {
  await Promise.race([
    boundary,
    result.then(({ error }) => {
      throw toErrorObject(error, `send settled before ${label}`);
    }),
  ]);
}

function respondJson(response: http.ServerResponse, body: unknown, status = 200): void {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

async function readRequestJson(request: http.IncomingMessage): Promise<unknown> {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    if (typeof chunk !== "string") {
      throw new Error("expected a UTF-8 fixture request");
    }
    body += chunk;
  }
  const parsed: unknown = JSON.parse(body);
  return parsed;
}

type MatrixFixture = {
  senders: ReturnType<typeof registeredSenders>;
  context: Pick<ChannelOutboundContext, "cfg" | "to" | "deps" | "mediaLocalRoots">;
  pendingText: (
    text: string,
    options?: Partial<
      Pick<
        ChannelOutboundContext,
        "to" | "signal" | "assertDirectAdapterHandoff" | "onPlatformSendDispatch"
      >
    > & { onDeliveryResult?: () => void },
  ) => Promise<SendOutcome<unknown>>;
  handlers: FixtureHandlers;
  uploads: string[];
  timeline: string[];
  pending: typeof settle;
  pause: () => ReturnType<typeof createPause>;
};

async function withMatrixFixture(
  registration: Registration,
  run: (fixture: MatrixFixture) => Promise<void>,
): Promise<void> {
  const runtime = createPluginRuntimeMock();
  installMatrixTestRuntime({ channel: runtime.channel });
  setMatrixRuntime({ ...getMatrixRuntime(), media: runtime.media });
  const handlers: FixtureHandlers = {};
  const uploads: string[] = [];
  const timeline: string[] = [];
  const requestErrors: unknown[] = [];
  const pauses: ReturnType<typeof createPause>[] = [];
  const sends: Promise<unknown>[] = [];
  const pending: typeof settle = (send) => {
    const result = settle(send);
    sends.push(result);
    return result;
  };
  const handler: Parameters<typeof withServer>[0] = (request, response) => {
    void (async () => {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      response.setHeader("content-type", "application/json");
      const incoming = { request, response, path };
      if (await handlers.request?.(incoming)) {
        return;
      }
      if (path.includes("/state/m.room.encryption")) {
        respondJson(response, { errcode: "M_NOT_FOUND", error: "unencrypted room" }, 404);
      } else if (request.method === "POST" && path.endsWith("/upload")) {
        uploads.push(path);
        request.resume();
        respondJson(response, { content_uri: "mxc://example.org/fixture" });
      } else if (request.method === "PUT" && path.includes("/send/m.room.message/")) {
        timeline.push(path);
        request.resume();
        if (handlers.timeline) {
          await handlers.timeline({ ...incoming, index: timeline.length });
        } else {
          respondJson(response, { event_id: "$accepted" });
        }
      } else {
        throw new Error(`unexpected Matrix fixture request: ${request.method} ${path}`);
      }
    })().catch((error: unknown) => {
      requestErrors.push(error);
      if (!response.writableEnded) {
        respondJson(
          response,
          { errcode: "M_UNRECOGNIZED", error: "unexpected fixture request" },
          400,
        );
      }
    });
  };
  await withServer(handler, async (url) => {
    const resolvedClient = new MatrixClient(url, "fixture-token", {
      userId: "@bot:example.org",
      deviceId: "fixture",
      encryption: false,
      autoBootstrapCrypto: false,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    const senders = registeredSenders(registration);
    const context = {
      cfg: {},
      to: ROOM_ID,
      mediaLocalRoots: [MEDIA_ROOT],
      deps: {
        matrix: (to: string, text: string | undefined, options: MatrixSendOpts) =>
          sendMessageMatrix(to, text, { ...options, client: resolvedClient }),
      },
    };
    try {
      await run({
        senders,
        context,
        pendingText: (text, options) => pending(senders.sendText({ ...context, text, ...options })),
        handlers,
        uploads,
        timeline,
        pending,
        pause: () => {
          const blocked = createPause();
          pauses.push(blocked);
          return blocked;
        },
      });
      expect(requestErrors).toEqual([]);
    } finally {
      for (const blocked of pauses) {
        blocked.open();
      }
      await Promise.all(sends);
      await resolvedClient.stopWithoutPersist();
    }
  });
}

describe("registered Matrix sender currentness", () => {
  // The message adapter delegates to outbound; only receipt projection needs both surfaces.
  const registration = "message";
  it(`${registration} stops canceled media preparation before uploading`, async () => {
    await withMatrixFixture(
      registration,
      async ({ senders, context, uploads, timeline, pending, pause }) => {
        const media = pause();
        const caller = new AbortController();
        const cancellation = new Error("Matrix caller canceled during media preparation");
        const result = pending(
          senders.sendMedia({
            ...context,
            text: "attachment",
            mediaUrl: `${MEDIA_ROOT}/fixture.txt`,
            mediaReadFile: async () => {
              await media.wait();
              return MEDIA_BYTES;
            },
            signal: caller.signal,
            onPlatformSendDispatch: async () => {},
          }),
        );
        await waitForBoundary(media.entered, result, "media preparation");
        caller.abort(cancellation);
        media.open();
        expectCanceled(await result, cancellation);
        expect(uploads).toHaveLength(0);
        expect(timeline).toHaveLength(0);
      },
    );
  });

  it(`${registration} rechecks caller retirement after awaited dispatch bookkeeping`, async () => {
    await withMatrixFixture(registration, async ({ pendingText, timeline, pause }) => {
      let current = true;
      const retirement = new Error("Matrix caller retired during dispatch bookkeeping");
      const dispatch = pause();
      const result = pendingText("must remain unsent", {
        assertDirectAdapterHandoff: () => {
          if (!current) {
            throw retirement;
          }
        },
        onPlatformSendDispatch: dispatch.wait,
      });
      await waitForBoundary(dispatch.entered, result, "dispatch bookkeeping");
      current = false;
      dispatch.open();
      expectCanceled(await result, retirement);
      expect(timeline).toEqual([]);
    });
  });

  it.each([
    ["outbound", false],
    ["message", false],
    ["outbound", true],
    ["message", true],
  ] as const)("%s preserves accepted receipts with remaining media=%s", async (surface, media) => {
    await withMatrixFixture(surface, async ({ senders, context, handlers, uploads, timeline }) => {
      const caller = new AbortController();
      const cancellation = new Error("Matrix caller canceled after request acceptance");
      const id = media ? "$first-attachment" : "$accepted";
      const text = media ? "first attachment caption" : "accepted final body";
      const firstPath = `${MEDIA_ROOT}/first.txt`;
      const reads: string[] = [];
      const delivered: unknown[] = [];
      handlers.timeline = ({ response }) => {
        caller.abort(cancellation);
        respondJson(response, { event_id: id });
      };
      const options = {
        ...context,
        text,
        ...guardedCaller(caller),
        onDeliveryResult: (value: unknown) => {
          delivered.push(value);
        },
      };
      const result = await settle(
        media
          ? senders.sendPayload({
              ...options,
              payload: { text, mediaUrls: [firstPath, `${MEDIA_ROOT}/second.txt`] },
              mediaReadFile: async (path) => {
                reads.push(path);
                return MEDIA_BYTES;
              },
            })
          : senders.sendText(options),
      );
      const accepted = {
        messageId: id,
        receipt: {
          ...(!media ? { primaryPlatformMessageId: id } : {}),
          platformMessageIds: [id],
          parts: [{ platformMessageId: id, kind: media ? "media" : "text" }],
        },
      };
      if (media) {
        expect(result.value).toBeUndefined();
        expectCanceled(result, cancellation);
        expect(reads).toEqual([firstPath]);
        expect(uploads).toHaveLength(1);
      } else {
        expect(result.error).toBeUndefined();
        expect(result.value).toMatchObject(accepted);
        if (surface === "outbound") {
          expect(result.value).toMatchObject({ content: text });
        }
      }
      expect(delivered).toMatchObject([accepted]);
      if (surface === "outbound") {
        expect(delivered).toMatchObject([{ content: text }]);
      }
      expect(timeline).toHaveLength(1);
    });
  });

  it(`${registration} retries a canceled DM mapping repair on the same client`, async () => {
    await withMatrixFixture(
      registration,
      async ({ senders, context, pendingText, handlers, timeline, pause }) => {
        const peer = "@peer:example.org";
        const roomId = "!dm:example.org";
        const accountDataPath = "/_matrix/client/v3/user/@bot:example.org/account_data/m.direct";
        const unrelated = { "@other:example.org": ["!other:example.org"] };
        const expectedMapping = { ...unrelated, [peer]: [roomId] };
        let directMapping: Record<string, string[]> = { ...unrelated };
        let accountReads = 0;
        const mappingWrites: unknown[] = [];
        const mappingRead = pause();
        const roomPath = `/_matrix/client/v3/rooms/${roomId}`;
        const roomReads: Record<string, unknown> = {
          "/_matrix/client/v3/joined_rooms": { joined_rooms: [roomId] },
          [`${roomPath}/joined_members`]: { joined: { "@bot:example.org": {}, [peer]: {} } },
          [`${roomPath}/state/m.room.member/@bot:example.org`]: {
            membership: "join",
            is_direct: true,
          },
        };
        handlers.request = async ({ request, response, path }) => {
          if (path === accountDataPath) {
            if (request.method === "GET") {
              accountReads += 1;
              if (accountReads === 2) {
                await mappingRead.wait();
              }
              respondJson(response, directMapping);
              return true;
            }
            if (request.method === "PUT") {
              const body = await readRequestJson(request);
              mappingWrites.push(body);
              expect(body).toEqual(expectedMapping);
              directMapping = expectedMapping;
              respondJson(response, {});
              return true;
            }
          }
          if (request.method === "GET" && Object.hasOwn(roomReads, path)) {
            respondJson(response, roomReads[path]);
            return true;
          }
          return false;
        };
        const caller = new AbortController();
        const cancellation = new Error("Matrix caller canceled during the DM mapping reread");
        const canceled = pendingText("canceled DM", {
          to: `user:${peer}`,
          ...guardedCaller(caller),
        });
        await waitForBoundary(mappingRead.entered, canceled, "the DM mapping reread");
        caller.abort(cancellation);
        mappingRead.open();
        expectCanceled(await canceled, cancellation);
        expect(mappingWrites).toEqual([]);
        expect(directMapping).toEqual(unrelated);
        expect(timeline).toEqual([]);

        const freshCaller = new AbortController();
        const sent = await senders.sendText({
          ...context,
          to: `user:${peer}`,
          text: "valid DM after canceled repair",
          ...guardedCaller(freshCaller),
        });
        expect(sent).toMatchObject({
          messageId: "$accepted",
          target: { kind: "room", id: roomId },
        });
        expect(mappingWrites).toEqual([expectedMapping]);
        expect(directMapping).toEqual(expectedMapping);
        expect(timeline).toHaveLength(1);
      },
    );
  });

  it.each([false, true])("preserves a queued send with legacy follower=%s", async (legacy) => {
    await withMatrixFixture(registration, async ({ pendingText, handlers, timeline, pause }) => {
      const firstRoom = legacy ? "!aware:example.org" : ROOM_ID;
      const secondRoom = legacy ? "!legacy:example.org" : ROOM_ID;
      const firstId = legacy ? "$aware-accepted" : "$first-accepted";
      const secondId = legacy ? "$legacy-accepted" : "$second-accepted";
      const firstCaller = new AbortController();
      const secondCaller = new AbortController();
      const firstResponse = pause();
      handlers.timeline = async ({ response, path, index }) => {
        if (index === 1 && path.includes(`/rooms/${firstRoom}/`)) {
          await firstResponse.wait();
          respondJson(response, { event_id: firstId });
        } else if (path.includes(`/rooms/${secondRoom}/`)) {
          respondJson(response, { event_id: secondId });
        } else {
          throw new Error(`unexpected queued room: ${path}`);
        }
      };
      const sendSpy = legacy
        ? vi.spyOn(MatrixJsClient.prototype, "sendMessage")
        : vi.spyOn(MatrixClient.prototype, "sendMessage");
      const first = pendingText("first sender", {
        to: firstRoom,
        ...guardedCaller(firstCaller),
        onPlatformSendDispatch: async () => {},
      });
      await waitForBoundary(firstResponse.entered, first, "the first timeline request");
      const second = pendingText("second sender", {
        to: secondRoom,
        ...(legacy
          ? {}
          : { ...guardedCaller(secondCaller), onPlatformSendDispatch: async () => {} }),
      });
      if (legacy) {
        await expect
          .poll(queueForRoom(observedSdkClient(sendSpy), secondRoom))
          .toEqual([firstRoom, secondRoom]);
      } else {
        // Both admissions must precede retiring the first caller while its request holds the queue.
        await expect.poll(() => sendSpy.mock.calls.length).toBe(2);
      }
      expect(timeline).toHaveLength(1);
      firstCaller.abort(new Error("first Matrix caller retired after request acceptance"));
      firstResponse.open();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expectAccepted(firstResult, firstId);
      expectAccepted(secondResult, secondId);
      expect(timeline).toHaveLength(2);
      expect(timeline[0]).toContain(`/rooms/${firstRoom}/`);
      expect(timeline[1]).toContain(`/rooms/${secondRoom}/`);
    });
  });

  it.each([false, true])(
    `${registration} preserves global FIFO after a rate-limited caller with canceled=%s`,
    async (canceled) => {
      await withMatrixFixture(registration, async ({ pendingText, handlers, timeline, pause }) => {
        const firstRoom = "!first:example.org";
        const secondRoom = "!second:example.org";
        const thirdRoom = "!third:example.org";
        const firstCaller = new AbortController();
        const secondCaller = new AbortController();
        const thirdCaller = new AbortController();
        const cancellation = new Error("first Matrix caller canceled before its SDK retry");
        const firstResponse = pause();
        const secondResponse = pause();
        let firstRoomAttempts = 0;
        const requestOrder: string[] = [];
        const survivorResults: string[] = [];
        handlers.timeline = async ({ response, path }) => {
          const room = [firstRoom, secondRoom, thirdRoom].find((id) =>
            path.includes(`/rooms/${id}/`),
          );
          if (!room) {
            throw new Error(`unexpected survivor room: ${path}`);
          }
          requestOrder.push(room);
          if (room === firstRoom) {
            firstRoomAttempts += 1;
            if (firstRoomAttempts === 1) {
              await firstResponse.wait();
              respondJson(
                response,
                {
                  errcode: "M_LIMIT_EXCEEDED",
                  error: "fixture rate limit",
                  retry_after_ms: 1,
                },
                429,
              );
              return;
            }
          } else if (room === secondRoom) {
            await secondResponse.wait();
          }
          respondJson(response, {
            event_id:
              room === firstRoom
                ? "$first-retried"
                : room === secondRoom
                  ? "$second-accepted"
                  : "$third-accepted",
          });
        };
        const sdkSend = vi.spyOn(MatrixJsClient.prototype, "sendMessage");
        const first = pendingText("first sender awaiting retry", {
          to: firstRoom,
          signal: firstCaller.signal,
          onPlatformSendDispatch: async () => {},
        });
        await waitForBoundary(firstResponse.entered, first, "the first timeline request");
        const second = pendingText("current sender in another room", {
          to: secondRoom,
          signal: secondCaller.signal,
          onPlatformSendDispatch: async () => {},
          onDeliveryResult: () => {
            survivorResults.push(secondRoom);
          },
        });
        const queuedRooms = queueForRoom(observedSdkClient(sdkSend), secondRoom);
        // Admit B before starting C so asynchronous preparation cannot change their queue order.
        await expect.poll(() => queuedRooms()?.includes(secondRoom) ?? false).toBe(true);
        const third = pendingText("next current sender in a third room", {
          to: thirdRoom,
          signal: thirdCaller.signal,
          onPlatformSendDispatch: async () => {},
          onDeliveryResult: () => {
            survivorResults.push(thirdRoom);
          },
        });
        await expect.poll(queuedRooms).toEqual([firstRoom, secondRoom, thirdRoom]);
        expect(requestOrder).toEqual([firstRoom]);
        expect(survivorResults).toEqual([]);
        expect(timeline).toHaveLength(1);
        if (canceled) {
          firstCaller.abort(cancellation);
        }
        firstResponse.open();
        const firstResult = await first;
        if (canceled) {
          expectCanceled(firstResult, cancellation);
        } else {
          expectAccepted(firstResult, "$first-retried");
        }
        await waitForBoundary(secondResponse.entered, second, "the first survivor request");
        // B holds the same global queue after A settles; C must still wait for B's response.
        await expect.poll(queuedRooms).toEqual([secondRoom, thirdRoom]);
        expect(requestOrder).toEqual(
          canceled ? [firstRoom, secondRoom] : [firstRoom, firstRoom, secondRoom],
        );
        expect(survivorResults).toEqual([]);
        secondResponse.open();
        const [secondResult, thirdResult] = await Promise.all([second, third]);
        expectAccepted(secondResult, "$second-accepted");
        expectAccepted(thirdResult, "$third-accepted");
        expect(firstRoomAttempts).toBe(canceled ? 1 : 2);
        expect(requestOrder).toEqual(
          canceled
            ? [firstRoom, secondRoom, thirdRoom]
            : [firstRoom, firstRoom, secondRoom, thirdRoom],
        );
        expect(survivorResults).toEqual([secondRoom, thirdRoom]);
        expect(timeline).toHaveLength(canceled ? 3 : 4);
      });
    },
  );
});
