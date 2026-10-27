import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createPluginRuntimeMock,
  createTestRegistry,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import {
  collectErrorGraphCandidates,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feishuPlugin } from "./channel.js";
import {
  AUTH_PATH,
  COMMENT_PATH,
  FILE_PATH,
  MESSAGE_PATH,
  TARGET,
  readFeishuQueueState,
  withFeishuTransport,
} from "./outbound.send-authority.test-fixtures.js";
import { setFeishuRuntime } from "./runtime.js";

const { resolveProxy } = vi.hoisted(() => ({
  resolveProxy: vi.fn<() => Promise<undefined>>(),
}));

vi.mock("openclaw/plugin-sdk/extension-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/extension-shared")>()),
  resolveAmbientNodeProxyAgent: resolveProxy,
}));

const COMMENT_TARGET = "comment:docx:doc_fixture:comment_fixture";
const CARD = JSON.stringify({
  schema: "2.0",
  body: { elements: [{ tag: "markdown", content: "A card reply." }] },
});

function mockAttachmentLoading(onLoad?: () => void) {
  setFeishuRuntime(
    createPluginRuntimeMock({
      media: {
        loadWebMedia: async () => {
          onLoad?.();
          return {
            buffer: Buffer.from("attachment"),
            fileName: "note.txt",
            contentType: "text/plain",
            kind: undefined,
          };
        },
      },
    }),
  );
}

function required<T>(sender: T | undefined): T {
  if (!sender) {
    throw new Error("Expected a registered Feishu sender");
  }
  return sender;
}

const preferredTextSend = () => required(feishuPlugin.message?.send?.text);

type SendContext = Pick<
  Parameters<ReturnType<typeof preferredTextSend>>[0],
  "cfg" | "to" | "text" | "signal" | "assertDirectAdapterHandoff" | "onPlatformSendDispatch"
>;

type TransportFixture = Parameters<Parameters<typeof withFeishuTransport>[0]>[0];
function sendText(
  fixture: TransportFixture,
  options: Partial<Parameters<ReturnType<typeof preferredTextSend>>[0]> = {},
) {
  return preferredTextSend()({ cfg: fixture.cfg, to: TARGET, text: "A reply.", ...options });
}

function requestPaths(fixture: TransportFixture) {
  return fixture.requests.map((request) => request.path);
}

function messageRequests(fixture: TransportFixture) {
  return fixture.requests.filter((request) => request.path.startsWith(MESSAGE_PATH));
}

const caught = (cause: unknown) => cause;

function createSender() {
  let current = true;
  return {
    assertDirectAdapterHandoff: () => {
      if (!current) {
        throw new Error("Sender retired");
      }
    },
    onPlatformSendDispatch: vi.fn(async () => {}),
    retire: () => {
      current = false;
    },
  };
}

async function sendMedia(ctx: SendContext) {
  return required(feishuPlugin.message?.send?.media)({
    ...ctx,
    mediaUrl: "https://media.example/note.txt",
  });
}

const sendRoutes = ["native card", "payload card", "send", "thread-reply"] as const;
async function sendRoute(route: (typeof sendRoutes)[number], ctx: SendContext) {
  if (route === "native card") {
    return preferredTextSend()({ ...ctx, text: CARD });
  }
  if (route === "payload card") {
    return required(feishuPlugin.outbound?.sendPayload)({ ...ctx, payload: { text: CARD } });
  }
  return required(feishuPlugin.actions?.handleAction)({
    channel: "feishu",
    action: route,
    cfg: ctx.cfg,
    params: {
      to: ctx.to,
      text: route === "thread-reply" ? CARD : ctx.text,
      ...(route === "thread-reply" ? { messageId: "om_parent" } : {}),
    },
    assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
  });
}

function errorCauses(error: unknown) {
  return collectErrorGraphCandidates(error, (current) => [current.cause]);
}

function expectDispatchError(error: unknown, retryable = false) {
  expect(errorCauses(error)).toContainEqual(
    expect.objectContaining({ code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED", retryable }),
  );
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  resolveProxy.mockResolvedValue(undefined);
});

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  resolveProxy.mockReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/extension-shared");
  vi.resetModules();
});

describe("Feishu delivery authority through the registered adapter and Lark transport", () => {
  it.each(sendRoutes)(
    "stops %s when the sender retires during token preparation",
    async (route) => {
      await withFeishuTransport(async (fixture) => {
        const started = fixture.gate();
        const release = fixture.gate();
        const sender = createSender();
        fixture.respond(async (request) => {
          if (request.path === AUTH_PATH) {
            started.resolve();
            await release.promise;
          }
          return false;
        });
        const rejected = expect(
          fixture.track(
            sendRoute(route, {
              ...sender,
              cfg: fixture.cfg,
              to: TARGET,
              text: "A retired sender must not deliver this message.",
            }),
          ),
        ).rejects.toBeInstanceOf(Error);
        await started.promise;
        sender.retire();
        release.resolve();
        await rejected;
        expect(requestPaths(fixture)).toEqual([AUTH_PATH]);
        expect(sender.onPlatformSendDispatch).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["proxy preparation", "Axios interceptor", "dispatch refresh"] as const)(
    "checks cancellation after awaited %s",
    async (waitAt) => {
      await withFeishuTransport(async (fixture) => {
        const started = fixture.gate();
        const release = fixture.gate();
        const abort = new AbortController();
        const wait = async () => {
          started.resolve();
          await release.promise;
        };
        if (waitAt === "proxy preparation") {
          resolveProxy.mockImplementationOnce(async () => {
            await wait();
            return undefined;
          });
        } else if (waitAt === "Axios interceptor") {
          fixture.intercept(MESSAGE_PATH, wait);
        }
        const result = fixture.track(
          sendText(fixture, {
            signal: abort.signal,
            ...(waitAt === "dispatch refresh" ? { onPlatformSendDispatch: wait } : {}),
          }).catch(caught),
        );
        await started.promise;
        abort.abort();
        release.resolve();
        expectDispatchError(await result);
        expect(requestPaths(fixture)).toEqual(waitAt === "proxy preparation" ? [] : [AUTH_PATH]);
      });
    },
  );

  it("keeps an active sender independent while sharing a cached client and pending proxy", async () => {
    await withFeishuTransport(async (fixture) => {
      const started = fixture.gate();
      const release = fixture.gate();
      resolveProxy.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return undefined;
      });
      const retired = createSender();
      const active = createSender();
      const first = fixture.track(sendText(fixture, retired).catch(caught));
      await started.promise;
      const second = fixture.track(sendText(fixture, active));
      retired.retire();
      release.resolve();
      expectDispatchError(await first);
      expect((await second).receipt?.platformMessageIds).toEqual(["om_accepted"]);
      expect(fixture.requests.filter((request) => request.path === MESSAGE_PATH)).toHaveLength(1);
      expect(retired.onPlatformSendDispatch).not.toHaveBeenCalled();
      expect(active.onPlatformSendDispatch).toHaveBeenCalledOnce();
    });
  });

  it.each(["rate limit", "withdrawn reply"] as const)(
    "stops the next request after a %s response retires the sender",
    async (failure) => {
      await withFeishuTransport(async (fixture) => {
        const sender = createSender();
        fixture.respond(async (request, response) => {
          if (request.path.startsWith(MESSAGE_PATH)) {
            sender.retire();
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ code: failure === "rate limit" ? 230020 : 230011 }));
            return true;
          }
          return false;
        });
        const error = await sendText(fixture, {
          ...sender,
          ...(failure === "withdrawn reply" ? { replyToId: "om_withdrawn" } : {}),
        }).catch(caught);
        expectDispatchError(error);
        expect(messageRequests(fixture)).toHaveLength(1);
        expect(sender.onPlatformSendDispatch).toHaveBeenCalledOnce();
      });
    },
  );

  it.each([
    { name: "token", path: AUTH_PATH, visible: false, marker: true },
    {
      name: "message without a dispatch callback",
      path: MESSAGE_PATH,
      visible: true,
      marker: false,
    },
  ])(
    "stops a $name redirect without misclassifying earlier I/O or logging request data",
    async ({ path: redirectPath, visible, marker }) => {
      await withFeishuTransport(async (fixture) => {
        const logs = (["log", "warn", "error"] as const).map((level) =>
          vi.spyOn(console, level).mockImplementation(() => {}),
        );
        const sender = createSender();
        fixture.respond(async (request, response) => {
          if (request.path === redirectPath) {
            sender.retire();
            response.writeHead(307, { location: `${redirectPath}/redirected` }).end();
            return true;
          }
          return false;
        });
        const error = await sendText(fixture, {
          ...sender,
          ...(marker ? {} : { onPlatformSendDispatch: undefined }),
        }).catch(caught);
        expect(error).toBeInstanceOf(Error);
        expect(requestPaths(fixture)).toEqual(visible ? [AUTH_PATH, MESSAGE_PATH] : [AUTH_PATH]);
        if (visible) {
          expect(errorCauses(error)).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED" }),
            ]),
          );
        } else {
          expectDispatchError(error);
        }
        expect(inspect(error, { depth: 12 })).not.toContain("loopback-placeholder");
        expect(
          inspect(
            logs.flatMap((log) => log.mock.calls),
            { depth: 12 },
          ),
        ).not.toContain("loopback-placeholder");
      });
    },
  );

  it.each([true, false])(
    "preserves retryable=%s when dispatch refresh fails before transport",
    async (retryable) => {
      await withFeishuTransport(async (fixture) => {
        const error = await sendText(fixture, {
          onPlatformSendDispatch: async () => {
            throw retryable
              ? new Error("Temporary persistence failure")
              : new PlatformMessageNotDispatchedError("Permanent dispatch rejection", {
                  cause: undefined,
                  retryable: false,
                });
          },
        }).catch(caught);
        expectDispatchError(error, retryable);
        expect(requestPaths(fixture)).toEqual([AUTH_PATH]);
      });
    },
  );

  it("stops media delivery after retirement during loading without marking a message", async () => {
    await withFeishuTransport(async (fixture) => {
      const sender = createSender();
      mockAttachmentLoading(sender.retire);
      const error = await sendMedia({ ...sender, cfg: fixture.cfg, to: TARGET, text: "" }).catch(
        caught,
      );
      expectDispatchError(error);
      expect(fixture.requests).toEqual([]);
      expect(sender.onPlatformSendDispatch).not.toHaveBeenCalled();
    });
  });

  it("marks an active attachment only after uploading and preserves its accepted receipt", async () => {
    await withFeishuTransport(async (fixture) => {
      mockAttachmentLoading();
      const marker = vi.fn(async () => {
        expect(requestPaths(fixture)).toEqual([AUTH_PATH, FILE_PATH]);
      });
      const result = await sendMedia({
        cfg: fixture.cfg,
        to: TARGET,
        text: "",
        onPlatformSendDispatch: marker,
      });
      expect(result.receipt?.platformMessageIds).toEqual(["om_accepted"]);
      expect(marker).toHaveBeenCalledOnce();
      expect(requestPaths(fixture)).toEqual([AUTH_PATH, FILE_PATH, MESSAGE_PATH]);
    });
  });

  it("stops a document-comment reply after its metadata lookup retires the sender", async () => {
    await withFeishuTransport(async (fixture) => {
      const sender = createSender();
      fixture.respond(async (request) => {
        if (request.path === `${COMMENT_PATH}/batch_query`) {
          sender.retire();
        }
        return false;
      });
      const error = await sendText(fixture, {
        ...sender,
        to: COMMENT_TARGET,
      }).catch(caught);
      expectDispatchError(error);
      expect(requestPaths(fixture)).toEqual([AUTH_PATH, `${COMMENT_PATH}/batch_query`]);
      expect(sender.onPlatformSendDispatch).not.toHaveBeenCalled();
    });
  });

  it.each(["reply", "fallback"] as const)(
    "marks a document-comment %s after preparation and keeps accepted results",
    async (mode) => {
      await withFeishuTransport(async (fixture) => {
        const sender = createSender();
        const replyPath = `${COMMENT_PATH}/comment_fixture/replies`;
        const createPath = "/open-apis/drive/v1/files/doc_fixture/new_comments";
        const dispatchRequests: string[][] = [];
        sender.onPlatformSendDispatch.mockImplementation(async () => {
          dispatchRequests.push(requestPaths(fixture));
        });
        fixture.respond(async (request, response) => {
          if (mode === "fallback" && request.path === replyPath) {
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify({ code: 1069302 }));
            return true;
          }
          if (request.path === (mode === "reply" ? replyPath : createPath)) {
            sender.retire();
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                code: 0,
                data:
                  mode === "reply"
                    ? { reply_id: "reply_accepted" }
                    : { comment_id: "comment_accepted" },
              }),
            );
            return true;
          }
          return false;
        });
        const result = await sendText(fixture, {
          ...sender,
          to: COMMENT_TARGET,
        });
        expect(result.receipt?.platformMessageIds).toEqual([
          mode === "reply" ? "reply_accepted" : "comment_accepted",
        ]);
        expect(dispatchRequests).toEqual([
          [AUTH_PATH, `${COMMENT_PATH}/batch_query`],
          ...(mode === "fallback" ? [[AUTH_PATH, `${COMMENT_PATH}/batch_query`, replyPath]] : []),
        ]);
      });
    },
  );

  it.each([
    { scenario: "upload", result: "failed", queued: "failed", messages: 0 },
    { scenario: "accepted", result: "sent", queued: "completed", messages: 1 },
    { scenario: "partial", result: "partial_failed", queued: "pending", messages: 1 },
    { scenario: "redirect", result: "failed", queued: "pending", messages: 1 },
  ] as const)(
    "settles durable $scenario delivery and prevents recovery replay",
    async ({ scenario, result: expectedResult, queued, messages }) => {
      await withStateDirEnv("openclaw-feishu-authority-", async ({ stateDir }) => {
        await withFeishuTransport(async (fixture) => {
          const sender = createSender();
          const deliveryIntentId = `feishu-authority-${scenario}`;
          setActivePluginRegistry(
            createTestRegistry([{ pluginId: "feishu", plugin: feishuPlugin, source: "test" }]),
          );
          resetGlobalHookRunner();
          const notePath = path.join(stateDir, "note.txt");
          if (scenario === "upload") {
            await writeFile(notePath, "attachment");
            mockAttachmentLoading();
          }
          fixture.respond(async (request, response) => {
            if (
              (scenario === "upload" && request.path === FILE_PATH) ||
              (scenario === "accepted" && request.path === MESSAGE_PATH)
            ) {
              sender.retire();
            }
            if (scenario === "redirect" && request.path === MESSAGE_PATH) {
              sender.retire();
              response.writeHead(307, { location: `${MESSAGE_PATH}/redirected` }).end();
              return true;
            }
            return false;
          });
          const result = await sendDurableMessageBatch({
            cfg: fixture.cfg,
            channel: "feishu",
            to: TARGET,
            accountId: "default",
            durability: "required",
            deliveryIntentId,
            completionRetention: {
              idPrefix: "feishu-authority-",
              maxAgeMs: 60_000,
              maxEntries: 10,
            },
            maxRetries: 2,
            assertDirectAdapterHandoff: sender.assertDirectAdapterHandoff,
            ...(scenario === "partial" ? { onDeliveryResult: () => sender.retire() } : {}),
            mediaAccess: {
              localRoots: [stateDir],
              workspaceDir: stateDir,
              readFile: (filePath) => readFile(filePath),
            },
            // Core sees fewer than 4k characters; Feishu's post soft breaks grow
            // this payload past its limit and exercise the adapter's own fanout.
            payloads: [
              scenario === "upload"
                ? { mediaUrl: notePath }
                : { text: scenario === "partial" ? "line\n".repeat(700) : "A durable reply." },
            ],
          });
          expect(result.status).toBe(expectedResult);
          expect(requestPaths(fixture)).toEqual([
            AUTH_PATH,
            ...(scenario === "upload" ? [FILE_PATH] : messages ? [MESSAGE_PATH] : []),
          ]);
          if (result.status === "sent" || result.status === "partial_failed") {
            expect(result.receipt.platformMessageIds).toEqual(["om_accepted"]);
          }
          if (scenario === "partial") {
            expect(result).toHaveProperty("sentBeforeError", true);
          }
          expect(readFeishuQueueState(stateDir, deliveryIntentId)).toMatchObject({
            status: queued,
            ...(queued === "pending" ? { recovery_state: "unknown_after_send" } : {}),
          });
          const beforeRecovery = messageRequests(fixture);
          expect(beforeRecovery).toHaveLength(messages);
          await drainPendingDeliveries({
            drainKey: "feishu:default",
            logLabel: "Feishu sender retirement recovery",
            cfg: fixture.cfg,
            stateDir,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            selectEntry: (entry) => ({ match: entry.channel === "feishu", bypassBackoff: true }),
          });
          expect(messageRequests(fixture)).toEqual(beforeRecovery);
          expect(readFeishuQueueState(stateDir, deliveryIntentId)?.status).toBe(
            queued === "completed" ? "completed" : "failed",
          );
        });
      });
    },
  );
});
