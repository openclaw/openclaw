import http from "node:http";
import { MatrixClient as MatrixJsClient, MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
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

function registeredSenders(registration: Registration) {
  const sendText =
    registration === "outbound"
      ? matrixPlugin.outbound?.sendText
      : matrixPlugin.message?.send?.text;
  const sendMedia =
    registration === "outbound"
      ? matrixPlugin.outbound?.sendMedia
      : matrixPlugin.message?.send?.media;
  const sendPayload =
    registration === "outbound"
      ? matrixPlugin.outbound?.sendPayload
      : matrixPlugin.message?.send?.payload;
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
  handlers: FixtureHandlers;
  uploads: string[];
  timeline: string[];
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
  const server = http.createServer((request, response) => {
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
  });
  let client: MatrixClient | undefined;
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    const resolvedClient = new MatrixClient(`http://127.0.0.1:${address.port}`, "fixture-token", {
      userId: "@bot:example.org",
      deviceId: "fixture",
      encryption: false,
      autoBootstrapCrypto: false,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    client = resolvedClient;
    await run({
      senders: registeredSenders(registration),
      context: {
        cfg: {},
        to: ROOM_ID,
        mediaLocalRoots: [MEDIA_ROOT],
        deps: {
          matrix: (to: string, text: string | undefined, options: MatrixSendOpts) =>
            sendMessageMatrix(to, text, { ...options, client: resolvedClient }),
        },
      },
      handlers,
      uploads,
      timeline,
    });
    expect(requestErrors).toEqual([]);
  } finally {
    try {
      await client?.stopWithoutPersist();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  }
}

describe("registered Matrix sender currentness", () => {
  for (const registration of ["outbound", "message"] as const) {
    it.each([false, true])(
      `${registration} media preparation with canceled=%s`,
      async (canceled) => {
        await withMatrixFixture(registration, async ({ senders, context, uploads, timeline }) => {
          const mediaStarted = createDeferred<void>();
          const media = createDeferred<Buffer>();
          const caller = new AbortController();
          const cancellation = new Error("Matrix caller canceled during media preparation");
          const result = settle(
            senders.sendMedia({
              ...context,
              text: "attachment",
              mediaUrl: `${MEDIA_ROOT}/fixture.txt`,
              mediaReadFile: async () => {
                mediaStarted.resolve();
                return await media.promise;
              },
              signal: caller.signal,
              onPlatformSendDispatch: async () => {},
            }),
          );
          try {
            await waitForBoundary(mediaStarted.promise, result, "media preparation");
            if (canceled) {
              caller.abort(cancellation);
            }
            media.resolve(MEDIA_BYTES);
            const settled = await result;
            if (canceled) {
              expect(settled.error).toMatchObject({
                message: expect.stringContaining(cancellation.message),
              });
            } else {
              expect(settled.error).toBeUndefined();
              expect(settled.value).toMatchObject({ messageId: "$accepted" });
            }
            expect(uploads).toHaveLength(canceled ? 0 : 1);
            expect(timeline).toHaveLength(canceled ? 0 : 1);
          } finally {
            media.resolve(MEDIA_BYTES);
            await result;
          }
        });
      },
    );

    it(`${registration} rechecks caller retirement after awaited dispatch bookkeeping`, async () => {
      await withMatrixFixture(registration, async ({ senders, context, timeline }) => {
        let current = true;
        const retirement = new Error("Matrix caller retired during dispatch bookkeeping");
        const dispatchEntered = createDeferred<void>();
        const resumeDispatch = createDeferred<void>();
        const result = settle(
          senders.sendText({
            ...context,
            text: "must remain unsent",
            assertDirectAdapterHandoff: () => {
              if (!current) {
                throw retirement;
              }
            },
            onPlatformSendDispatch: async () => {
              dispatchEntered.resolve();
              await resumeDispatch.promise;
            },
          }),
        );
        try {
          await waitForBoundary(dispatchEntered.promise, result, "dispatch bookkeeping");
          current = false;
          resumeDispatch.resolve();
          expect((await result).error).toMatchObject({
            message: expect.stringContaining(retirement.message),
          });
          expect(timeline).toEqual([]);
        } finally {
          resumeDispatch.resolve();
          await result;
        }
      });
    });

    it(`${registration} preserves an accepted final receipt after caller cancellation`, async () => {
      await withMatrixFixture(registration, async ({ senders, context, handlers, timeline }) => {
        const caller = new AbortController();
        const cancellation = new Error("Matrix caller canceled after request acceptance");
        handlers.timeline = ({ response }) => {
          caller.abort(cancellation);
          respondJson(response, { event_id: "$accepted" });
        };
        const delivered: unknown[] = [];
        const result = await senders.sendText({
          ...context,
          text: "accepted final body",
          signal: caller.signal,
          assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
          onPlatformSendDispatch: async () => caller.signal.throwIfAborted(),
          onDeliveryResult: (value: unknown) => {
            delivered.push(value);
          },
        });
        const accepted = {
          messageId: "$accepted",
          receipt: {
            primaryPlatformMessageId: "$accepted",
            platformMessageIds: ["$accepted"],
            parts: [{ platformMessageId: "$accepted", kind: "text" }],
          },
        };
        expect(result).toMatchObject(accepted);
        expect(delivered).toMatchObject([accepted]);
        if (registration === "outbound") {
          expect(result).toMatchObject({ content: "accepted final body" });
          expect(delivered).toMatchObject([{ content: "accepted final body" }]);
        }
        expect(timeline).toHaveLength(1);
      });
    });

    it(`${registration} preserves the first attachment result and rejects the remaining payload`, async () => {
      await withMatrixFixture(
        registration,
        async ({ senders, context, handlers, uploads, timeline }) => {
          const caller = new AbortController();
          const cancellation = new Error("Matrix caller canceled after the first attachment");
          const firstPath = `${MEDIA_ROOT}/first.txt`;
          const secondPath = `${MEDIA_ROOT}/second.txt`;
          const reads: string[] = [];
          const delivered: unknown[] = [];
          handlers.timeline = ({ response }) => {
            caller.abort(cancellation);
            respondJson(response, { event_id: "$first-attachment" });
          };
          const result = await settle(
            senders.sendPayload({
              ...context,
              text: "first attachment caption",
              payload: {
                text: "first attachment caption",
                mediaUrls: [firstPath, secondPath],
              },
              mediaReadFile: async (path) => {
                reads.push(path);
                return MEDIA_BYTES;
              },
              signal: caller.signal,
              assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
              onPlatformSendDispatch: async () => caller.signal.throwIfAborted(),
              onDeliveryResult: (value: unknown) => {
                delivered.push(value);
              },
            }),
          );
          expect(result.value).toBeUndefined();
          expect(result.error).toMatchObject({
            message: expect.stringContaining(cancellation.message),
          });
          expect(reads).toEqual([firstPath]);
          expect(uploads).toHaveLength(1);
          expect(timeline).toHaveLength(1);
          expect(delivered).toMatchObject([
            {
              messageId: "$first-attachment",
              receipt: {
                platformMessageIds: ["$first-attachment"],
                parts: [{ platformMessageId: "$first-attachment", kind: "media" }],
              },
            },
          ]);
          if (registration === "outbound") {
            expect(delivered).toMatchObject([{ content: "first attachment caption" }]);
          }
        },
      );
    });

    it(`${registration} retries a canceled DM mapping repair on the same client`, async () => {
      await withMatrixFixture(registration, async ({ senders, context, handlers, timeline }) => {
        const peer = "@peer:example.org";
        const roomId = "!dm:example.org";
        const accountDataPath = "/_matrix/client/v3/user/@bot:example.org/account_data/m.direct";
        const unrelated = { "@other:example.org": ["!other:example.org"] };
        const expectedMapping = { ...unrelated, [peer]: [roomId] };
        let directMapping: Record<string, string[]> = { ...unrelated };
        let accountReads = 0;
        const mappingWrites: unknown[] = [];
        const mappingReadEntered = createDeferred<void>();
        const resumeMappingRead = createDeferred<void>();
        handlers.request = async ({ request, response, path }) => {
          if (path === accountDataPath) {
            if (request.method === "GET") {
              accountReads += 1;
              if (accountReads === 2) {
                mappingReadEntered.resolve();
                await resumeMappingRead.promise;
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
          if (request.method === "GET" && path === "/_matrix/client/v3/joined_rooms") {
            respondJson(response, { joined_rooms: [roomId] });
            return true;
          }
          if (
            request.method === "GET" &&
            path === `/_matrix/client/v3/rooms/${roomId}/joined_members`
          ) {
            respondJson(response, { joined: { "@bot:example.org": {}, [peer]: {} } });
            return true;
          }
          if (
            request.method === "GET" &&
            path === `/_matrix/client/v3/rooms/${roomId}/state/m.room.member/@bot:example.org`
          ) {
            respondJson(response, { membership: "join", is_direct: true });
            return true;
          }
          return false;
        };
        const caller = new AbortController();
        const cancellation = new Error("Matrix caller canceled during the DM mapping reread");
        const canceled = settle(
          senders.sendText({
            ...context,
            to: `user:${peer}`,
            text: "canceled DM",
            signal: caller.signal,
            assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
            onPlatformSendDispatch: async () => caller.signal.throwIfAborted(),
          }),
        );
        try {
          await waitForBoundary(mappingReadEntered.promise, canceled, "the DM mapping reread");
          caller.abort(cancellation);
          resumeMappingRead.resolve();
          expect((await canceled).error).toMatchObject({
            message: expect.stringContaining(cancellation.message),
          });
          expect(mappingWrites).toEqual([]);
          expect(directMapping).toEqual(unrelated);
          expect(timeline).toEqual([]);

          const freshCaller = new AbortController();
          const sent = await senders.sendText({
            ...context,
            to: `user:${peer}`,
            text: "valid DM after canceled repair",
            signal: freshCaller.signal,
            assertDirectAdapterHandoff: () => freshCaller.signal.throwIfAborted(),
            onPlatformSendDispatch: async () => freshCaller.signal.throwIfAborted(),
          });
          expect(sent).toMatchObject({
            messageId: "$accepted",
            target: { kind: "room", id: roomId },
          });
          expect(mappingWrites).toEqual([expectedMapping]);
          expect(directMapping).toEqual(expectedMapping);
          expect(timeline).toHaveLength(1);
        } finally {
          resumeMappingRead.resolve();
          await canceled;
        }
      });
    });

    it(`${registration} preserves a queued same-room send after the accepted caller retires`, async () => {
      await withMatrixFixture(registration, async ({ senders, context, handlers, timeline }) => {
        const firstCaller = new AbortController();
        const secondCaller = new AbortController();
        const firstRequestEntered = createDeferred<void>();
        const resumeFirstResponse = createDeferred<void>();
        handlers.timeline = async ({ response, index }) => {
          if (index === 1) {
            firstRequestEntered.resolve();
            await resumeFirstResponse.promise;
            respondJson(response, { event_id: "$first-accepted" });
          } else {
            respondJson(response, { event_id: "$second-accepted" });
          }
        };
        const pluginSend = vi.spyOn(MatrixClient.prototype, "sendMessage");
        const first = settle(
          senders.sendText({
            ...context,
            text: "first sender",
            signal: firstCaller.signal,
            assertDirectAdapterHandoff: () => firstCaller.signal.throwIfAborted(),
            onPlatformSendDispatch: async () => {},
          }),
        );
        let second: Promise<SendOutcome<unknown>> | undefined;
        try {
          await waitForBoundary(firstRequestEntered.promise, first, "the first timeline request");
          second = settle(
            senders.sendText({
              ...context,
              text: "second sender",
              signal: secondCaller.signal,
              assertDirectAdapterHandoff: () => secondCaller.signal.throwIfAborted(),
              onPlatformSendDispatch: async () => {},
            }),
          );
          // The forwarding spy observes both admissions while the first request holds the room queue.
          await expect.poll(() => pluginSend.mock.calls.length).toBe(2);
          expect(timeline).toHaveLength(1);
          firstCaller.abort(new Error("first Matrix caller retired after request acceptance"));
          resumeFirstResponse.resolve();
          const [firstResult, secondResult] = await Promise.all([first, second]);
          expect(firstResult.error).toBeUndefined();
          expect(firstResult.value).toMatchObject({
            messageId: "$first-accepted",
            receipt: { platformMessageIds: ["$first-accepted"] },
          });
          expect(secondResult.error).toBeUndefined();
          expect(secondResult.value).toMatchObject({
            messageId: "$second-accepted",
            receipt: { platformMessageIds: ["$second-accepted"] },
          });
          expect(timeline).toHaveLength(2);
          expect(timeline.every((path) => path.includes(`/rooms/${ROOM_ID}/`))).toBe(true);
        } finally {
          resumeFirstResponse.resolve();
          await Promise.all([first, second]);
          pluginSend.mockRestore();
        }
      });
    });

    it(`${registration} preserves a callback-free legacy send after an aware caller retires`, async () => {
      await withMatrixFixture(registration, async ({ senders, context, handlers, timeline }) => {
        const awareRoom = "!aware:example.org";
        const legacyRoom = "!legacy:example.org";
        const awareCaller = new AbortController();
        const awareRequestEntered = createDeferred<void>();
        const resumeAwareResponse = createDeferred<void>();
        handlers.timeline = async ({ response, path }) => {
          if (path.includes(`/rooms/${awareRoom}/`)) {
            awareRequestEntered.resolve();
            await resumeAwareResponse.promise;
            respondJson(response, { event_id: "$aware-accepted" });
            return;
          }
          if (path.includes(`/rooms/${legacyRoom}/`)) {
            respondJson(response, { event_id: "$legacy-accepted" });
            return;
          }
          throw new Error(`unexpected mixed-caller room: ${path}`);
        };
        const sdkSend = vi.spyOn(MatrixJsClient.prototype, "sendMessage");
        const aware = settle(
          senders.sendText({
            ...context,
            to: awareRoom,
            text: "sender with currentness inputs",
            signal: awareCaller.signal,
            assertDirectAdapterHandoff: () => awareCaller.signal.throwIfAborted(),
            onPlatformSendDispatch: async () => {},
          }),
        );
        let legacy: Promise<SendOutcome<unknown>> | undefined;
        try {
          await waitForBoundary(awareRequestEntered.promise, aware, "the aware sender's request");
          legacy = settle(
            senders.sendText({
              ...context,
              to: legacyRoom,
              text: "legacy sender without currentness callbacks",
            }),
          );
          const sdkClient = sdkSend.mock.contexts[0];
          if (!(sdkClient instanceof MatrixJsClient)) {
            throw new Error("real Matrix SDK sender was not observed");
          }
          const legacyEvent = new MatrixEvent({
            room_id: legacyRoom,
            type: "m.room.message",
            content: { msgtype: "m.text", body: "fixture" },
          });
          await expect
            .poll(() =>
              sdkClient
                .getScheduler()
                ?.getQueueForEvent(legacyEvent)
                ?.map((event) => event.getRoomId()),
            )
            .toEqual([awareRoom, legacyRoom]);
          expect(timeline).toHaveLength(1);
          awareCaller.abort(new Error("aware Matrix caller retired after request acceptance"));
          resumeAwareResponse.resolve();
          const [awareResult, legacyResult] = await Promise.all([aware, legacy]);
          expect(awareResult.error).toBeUndefined();
          expect(awareResult.value).toMatchObject({
            messageId: "$aware-accepted",
            receipt: { platformMessageIds: ["$aware-accepted"] },
          });
          expect(legacyResult.error).toBeUndefined();
          expect(legacyResult.value).toMatchObject({
            messageId: "$legacy-accepted",
            receipt: { platformMessageIds: ["$legacy-accepted"] },
          });
          expect(timeline).toHaveLength(2);
          expect(timeline[0]).toContain(`/rooms/${awareRoom}/`);
          expect(timeline[1]).toContain(`/rooms/${legacyRoom}/`);
        } finally {
          resumeAwareResponse.resolve();
          await Promise.all([aware, legacy]);
          sdkSend.mockRestore();
        }
      });
    });

    it.each([false, true])(
      `${registration} preserves global FIFO after a rate-limited caller with canceled=%s`,
      async (canceled) => {
        await withMatrixFixture(registration, async ({ senders, context, handlers, timeline }) => {
          const firstRoom = "!first:example.org";
          const secondRoom = "!second:example.org";
          const thirdRoom = "!third:example.org";
          const firstCaller = new AbortController();
          const secondCaller = new AbortController();
          const thirdCaller = new AbortController();
          const cancellation = new Error("first Matrix caller canceled before its SDK retry");
          const firstRequestEntered = createDeferred<void>();
          const resumeRateLimitResponse = createDeferred<void>();
          const secondRequestEntered = createDeferred<void>();
          const resumeSecondResponse = createDeferred<void>();
          let firstRoomAttempts = 0;
          const requestOrder: string[] = [];
          const survivorResults: string[] = [];
          handlers.timeline = async ({ response, path }) => {
            if (path.includes(`/rooms/${firstRoom}/`)) {
              requestOrder.push(firstRoom);
              firstRoomAttempts += 1;
              if (firstRoomAttempts === 1) {
                firstRequestEntered.resolve();
                await resumeRateLimitResponse.promise;
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
              respondJson(response, { event_id: "$first-retried" });
              return;
            }
            if (path.includes(`/rooms/${secondRoom}/`)) {
              requestOrder.push(secondRoom);
              secondRequestEntered.resolve();
              await resumeSecondResponse.promise;
              respondJson(response, { event_id: "$second-accepted" });
              return;
            }
            if (path.includes(`/rooms/${thirdRoom}/`)) {
              requestOrder.push(thirdRoom);
              respondJson(response, { event_id: "$third-accepted" });
              return;
            }
            throw new Error(`unexpected survivor room: ${path}`);
          };
          const sdkSend = vi.spyOn(MatrixJsClient.prototype, "sendMessage");
          const first = settle(
            senders.sendText({
              ...context,
              to: firstRoom,
              text: "first sender awaiting retry",
              signal: firstCaller.signal,
              onPlatformSendDispatch: async () => {},
            }),
          );
          let second: Promise<SendOutcome<unknown>> | undefined;
          let third: Promise<SendOutcome<unknown>> | undefined;
          try {
            await waitForBoundary(firstRequestEntered.promise, first, "the first timeline request");
            second = settle(
              senders.sendText({
                ...context,
                to: secondRoom,
                text: "current sender in another room",
                signal: secondCaller.signal,
                onPlatformSendDispatch: async () => {},
                onDeliveryResult: () => {
                  survivorResults.push(secondRoom);
                },
              }),
            );
            const sdkClient = sdkSend.mock.contexts[0];
            if (!(sdkClient instanceof MatrixJsClient)) {
              throw new Error("real Matrix SDK sender was not observed");
            }
            const secondRoomEvent = new MatrixEvent({
              room_id: secondRoom,
              type: "m.room.message",
              content: { msgtype: "m.text", body: "fixture" },
            });
            // Admit B before starting C so asynchronous preparation cannot change their queue order.
            await expect
              .poll(
                () =>
                  sdkClient
                    .getScheduler()
                    ?.getQueueForEvent(secondRoomEvent)
                    ?.some((event) => event.getRoomId() === secondRoom) ?? false,
              )
              .toBe(true);
            third = settle(
              senders.sendText({
                ...context,
                to: thirdRoom,
                text: "next current sender in a third room",
                signal: thirdCaller.signal,
                onPlatformSendDispatch: async () => {},
                onDeliveryResult: () => {
                  survivorResults.push(thirdRoom);
                },
              }),
            );
            const queuedRooms = () =>
              sdkClient
                .getScheduler()
                ?.getQueueForEvent(secondRoomEvent)
                ?.map((event) => event.getRoomId());
            await expect.poll(queuedRooms).toEqual([firstRoom, secondRoom, thirdRoom]);
            expect(requestOrder).toEqual([firstRoom]);
            expect(survivorResults).toEqual([]);
            expect(timeline).toHaveLength(1);
            if (canceled) {
              firstCaller.abort(cancellation);
            }
            resumeRateLimitResponse.resolve();
            const firstResult = await first;
            if (canceled) {
              expect(firstResult.error).toMatchObject({
                message: expect.stringContaining(cancellation.message),
              });
            } else {
              expect(firstResult.error).toBeUndefined();
              expect(firstResult.value).toMatchObject({
                messageId: "$first-retried",
                receipt: { platformMessageIds: ["$first-retried"] },
              });
            }
            await waitForBoundary(
              secondRequestEntered.promise,
              second,
              "the first survivor request",
            );
            // B holds the same global queue after A settles; C must still wait for B's response.
            await expect.poll(queuedRooms).toEqual([secondRoom, thirdRoom]);
            expect(requestOrder).toEqual(
              canceled ? [firstRoom, secondRoom] : [firstRoom, firstRoom, secondRoom],
            );
            expect(survivorResults).toEqual([]);
            resumeSecondResponse.resolve();
            const [secondResult, thirdResult] = await Promise.all([second, third]);
            expect(secondResult.error).toBeUndefined();
            expect(secondResult.value).toMatchObject({
              messageId: "$second-accepted",
              receipt: { platformMessageIds: ["$second-accepted"] },
            });
            expect(thirdResult.error).toBeUndefined();
            expect(thirdResult.value).toMatchObject({
              messageId: "$third-accepted",
              receipt: { platformMessageIds: ["$third-accepted"] },
            });
            expect(firstRoomAttempts).toBe(canceled ? 1 : 2);
            expect(requestOrder).toEqual(
              canceled
                ? [firstRoom, secondRoom, thirdRoom]
                : [firstRoom, firstRoom, secondRoom, thirdRoom],
            );
            expect(survivorResults).toEqual([secondRoom, thirdRoom]);
            expect(timeline).toHaveLength(canceled ? 3 : 4);
          } finally {
            resumeRateLimitResponse.resolve();
            resumeSecondResponse.resolve();
            await Promise.all([first, second, third]);
            sdkSend.mockRestore();
          }
        });
      },
    );
  }
});
