import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
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
import { resetFeishuProxyAgentForTest } from "./client.js";
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

function preferredTextSend() {
  const send = feishuPlugin.message?.send?.text;
  if (!send) {
    throw new Error("Expected the registered Feishu text sender");
  }
  return send;
}

type SendContext = Pick<
  Parameters<ReturnType<typeof preferredTextSend>>[0],
  "cfg" | "to" | "text" | "signal" | "assertDirectAdapterHandoff" | "onPlatformSendDispatch"
>;

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
  const send = feishuPlugin.message?.send?.media;
  if (!send) {
    throw new Error("Expected the registered Feishu media sender");
  }
  return send({ ...ctx, mediaUrl: "https://media.example/note.txt" });
}

const sendRoutes = [
  { name: "preferred text", send: (ctx: SendContext) => preferredTextSend()(ctx) },
  {
    name: "native card text",
    send: (ctx: SendContext) => preferredTextSend()({ ...ctx, text: CARD }),
  },
  {
    name: "payload card",
    send: (ctx: SendContext) => {
      const send = feishuPlugin.outbound?.sendPayload;
      if (!send) {
        throw new Error("Expected the registered Feishu payload sender");
      }
      return send({ ...ctx, payload: { text: CARD } });
    },
  },
  ...(["send", "thread-reply"] as const).flatMap((action) =>
    [false, true].map((card) => ({
      name: `generic ${action}${card ? " card" : " text"}`,
      send: (ctx: SendContext) => {
        const handle = feishuPlugin.actions?.handleAction;
        if (!handle) {
          throw new Error("Expected the registered Feishu action handler");
        }
        return handle({
          channel: "feishu",
          action,
          cfg: ctx.cfg,
          params: {
            to: ctx.to,
            text: card ? CARD : ctx.text,
            ...(action === "thread-reply" ? { messageId: "om_parent" } : {}),
          },
          assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
          onPlatformSendDispatch: ctx.onPlatformSendDispatch,
        });
      },
    })),
  ),
];

function errorCauses(error: unknown) {
  return collectErrorGraphCandidates(error, (current) => [current.cause]);
}

function expectRetired(error: unknown) {
  expect(errorCauses(error)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
        retryable: false,
      }),
    ]),
  );
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  resolveProxy.mockResolvedValue(undefined);
  resetFeishuProxyAgentForTest();
});

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  resetFeishuProxyAgentForTest();
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
    "stops $name when the sender retires during token preparation",
    async ({ send }) => {
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
        const result = fixture.track(
          send({
            ...sender,
            cfg: fixture.cfg,
            to: TARGET,
            text: "A retired sender must not deliver this message.",
          }).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          ),
        );
        await started.promise;
        sender.retire();
        release.resolve();
        expect(await result).toHaveProperty("error");
        expect(fixture.requests.map((request) => request.path)).toEqual([AUTH_PATH]);
        expect(sender.onPlatformSendDispatch).not.toHaveBeenCalled();
      });
    },
  );

  it("returns the accepted receipt for an active sender", async () => {
    await withFeishuTransport(async ({ cfg, requests }) => {
      const result = await preferredTextSend()({ cfg, to: TARGET, text: "Delivered normally." });
      expect(requests.map((request) => request.path)).toEqual([AUTH_PATH, MESSAGE_PATH]);
      expect(result.receipt?.platformMessageIds).toEqual(["om_accepted"]);
    });
  });

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
          preferredTextSend()({
            cfg: fixture.cfg,
            to: TARGET,
            text: "Cancelled before transport.",
            signal: abort.signal,
            ...(waitAt === "dispatch refresh" ? { onPlatformSendDispatch: wait } : {}),
          }).catch((cause: unknown) => cause),
        );
        await started.promise;
        abort.abort();
        release.resolve();
        expectRetired(await result);
        expect(fixture.requests.map((request) => request.path)).toEqual(
          waitAt === "proxy preparation" ? [] : [AUTH_PATH],
        );
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
      const context = { cfg: fixture.cfg, to: TARGET, text: "Independent send." };
      const first = fixture.track(
        preferredTextSend()({ ...context, ...retired }).catch((cause: unknown) => cause),
      );
      await started.promise;
      const second = fixture.track(preferredTextSend()({ ...context, ...active }));
      retired.retire();
      release.resolve();
      expectRetired(await first);
      expect((await second).receipt?.platformMessageIds).toEqual(["om_accepted"]);
      expect(fixture.requests.filter((request) => request.path === MESSAGE_PATH)).toHaveLength(1);
      expect(retired.onPlatformSendDispatch).not.toHaveBeenCalled();
      expect(active.onPlatformSendDispatch).toHaveBeenCalledOnce();
    });
  });

  it("stops a later chunk while preserving the already accepted receipt", async () => {
    await withFeishuTransport(async ({ cfg, requests }) => {
      const sender = createSender();
      const error = await preferredTextSend()({
        ...sender,
        cfg,
        to: TARGET,
        text: "A long reply. ".repeat(500),
        onDeliveryResult: () => sender.retire(),
      }).catch((cause: unknown) => cause);
      expect(isChannelPartialDeliveryError(error)).toBe(true);
      if (!isChannelPartialDeliveryError(error)) {
        throw new Error("Expected partial delivery after the first chunk");
      }
      expect(error.deliveryResult.receipt?.platformMessageIds).toEqual(["om_accepted"]);
      expect(requests.filter((request) => request.path === MESSAGE_PATH)).toHaveLength(1);
      expect(sender.onPlatformSendDispatch).toHaveBeenCalledOnce();
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
        const error = await preferredTextSend()({
          ...sender,
          cfg: fixture.cfg,
          to: TARGET,
          text: "Do not retry a retired sender.",
          ...(failure === "withdrawn reply" ? { replyToId: "om_withdrawn" } : {}),
        }).catch((cause: unknown) => cause);
        expectRetired(error);
        expect(
          fixture.requests.filter((request) => request.path.startsWith(MESSAGE_PATH)),
        ).toHaveLength(1);
        expect(sender.onPlatformSendDispatch).toHaveBeenCalledOnce();
      });
    },
  );

  it("retains a message accepted while its sender retires", async () => {
    await withFeishuTransport(async (fixture) => {
      const sender = createSender();
      fixture.respond(async (request) => {
        if (request.path === MESSAGE_PATH) {
          sender.retire();
        }
        return false;
      });
      const result = await preferredTextSend()({
        ...sender,
        cfg: fixture.cfg,
        to: TARGET,
        text: "Keep this accepted result.",
      });
      expect(result.receipt?.platformMessageIds).toEqual(["om_accepted"]);
      expect(sender.onPlatformSendDispatch).toHaveBeenCalledOnce();
    });
  });

  it.each([
    { name: "token", path: AUTH_PATH, visible: false, marker: true },
    { name: "message", path: MESSAGE_PATH, visible: true, marker: true },
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
        const error = await preferredTextSend()({
          ...sender,
          cfg: fixture.cfg,
          to: TARGET,
          text: "A redirected send.",
          ...(marker ? {} : { onPlatformSendDispatch: undefined }),
        }).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(Error);
        expect(fixture.requests.map((request) => request.path)).toEqual(
          visible ? [AUTH_PATH, MESSAGE_PATH] : [AUTH_PATH],
        );
        if (visible) {
          expect(errorCauses(error)).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED" }),
            ]),
          );
        } else {
          expectRetired(error);
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
        const error = await preferredTextSend()({
          cfg: fixture.cfg,
          to: TARGET,
          text: "No request before refresh succeeds.",
          onPlatformSendDispatch: async () => {
            throw retryable
              ? new Error("Temporary persistence failure")
              : new PlatformMessageNotDispatchedError("Permanent dispatch rejection", {
                  cause: undefined,
                  retryable: false,
                });
          },
        }).catch((cause: unknown) => cause);
        expect(errorCauses(error)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
              retryable,
            }),
          ]),
        );
        expect(fixture.requests.map((request) => request.path)).toEqual([AUTH_PATH]);
      });
    },
  );

  it.each(["media loading", "upload response"] as const)(
    "stops media delivery after retirement during %s without marking preparation as a message",
    async (waitAt) => {
      await withFeishuTransport(async (fixture) => {
        const sender = createSender();
        setFeishuRuntime(
          createPluginRuntimeMock({
            media: {
              loadWebMedia: async () => {
                if (waitAt === "media loading") {
                  sender.retire();
                }
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
        fixture.respond(async (request) => {
          if (request.path === FILE_PATH) {
            sender.retire();
          }
          return false;
        });
        const error = await sendMedia({ ...sender, cfg: fixture.cfg, to: TARGET, text: "" }).catch(
          (cause: unknown) => cause,
        );
        expectRetired(error);
        expect(fixture.requests.map((request) => request.path)).toEqual(
          waitAt === "media loading" ? [] : [AUTH_PATH, FILE_PATH],
        );
        expect(sender.onPlatformSendDispatch).not.toHaveBeenCalled();
      });
    },
  );

  it("marks an active attachment only after uploading and preserves its accepted receipt", async () => {
    await withFeishuTransport(async (fixture) => {
      setFeishuRuntime(
        createPluginRuntimeMock({
          media: {
            loadWebMedia: async () => ({
              buffer: Buffer.from("attachment"),
              fileName: "note.txt",
              contentType: "text/plain",
              kind: undefined,
            }),
          },
        }),
      );
      const marker = vi.fn(async () => {
        expect(fixture.requests.map((request) => request.path)).toEqual([AUTH_PATH, FILE_PATH]);
      });
      const result = await sendMedia({
        cfg: fixture.cfg,
        to: TARGET,
        text: "",
        onPlatformSendDispatch: marker,
      });
      expect(result.receipt?.platformMessageIds).toEqual(["om_accepted"]);
      expect(marker).toHaveBeenCalledOnce();
      expect(fixture.requests.map((request) => request.path)).toEqual([
        AUTH_PATH,
        FILE_PATH,
        MESSAGE_PATH,
      ]);
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
      const error = await preferredTextSend()({
        ...sender,
        cfg: fixture.cfg,
        to: COMMENT_TARGET,
        text: "A document reply.",
      }).catch((cause: unknown) => cause);
      expectRetired(error);
      expect(fixture.requests.map((request) => request.path)).toEqual([
        AUTH_PATH,
        `${COMMENT_PATH}/batch_query`,
      ]);
      expect(sender.onPlatformSendDispatch).not.toHaveBeenCalled();
    });
  });

  it.each(["reply", "whole", "fallback"] as const)(
    "marks a document-comment %s after preparation and keeps accepted results",
    async (mode) => {
      await withFeishuTransport(async (fixture) => {
        const sender = createSender();
        const replyPath = `${COMMENT_PATH}/comment_fixture/replies`;
        const createPath = "/open-apis/drive/v1/files/doc_fixture/new_comments";
        const dispatchRequests: string[][] = [];
        sender.onPlatformSendDispatch.mockImplementation(async () => {
          dispatchRequests.push(fixture.requests.map((request) => request.path));
        });
        fixture.respond(async (request, response) => {
          if (mode === "whole" && request.path === `${COMMENT_PATH}/batch_query`) {
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                code: 0,
                data: { items: [{ comment_id: "comment_fixture", is_whole: true }] },
              }),
            );
            return true;
          }
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
        const result = await preferredTextSend()({
          ...sender,
          cfg: fixture.cfg,
          to: COMMENT_TARGET,
          text: "An accepted document reply.",
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
    { scenario: "token", result: "failed", queued: "failed", messages: 0 },
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
            setFeishuRuntime(
              createPluginRuntimeMock({
                media: {
                  loadWebMedia: async () => ({
                    buffer: Buffer.from("attachment"),
                    fileName: "note.txt",
                    contentType: "text/plain",
                    kind: undefined,
                  }),
                },
              }),
            );
          }
          fixture.respond(async (request, response) => {
            if (
              (scenario === "token" && request.path === AUTH_PATH) ||
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
          const visibleRequests = () =>
            fixture.requests.filter((request) => request.path.startsWith(MESSAGE_PATH));
          const beforeRecovery = visibleRequests();
          expect(beforeRecovery).toHaveLength(messages);
          await drainPendingDeliveries({
            drainKey: "feishu:default",
            logLabel: "Feishu sender retirement recovery",
            cfg: fixture.cfg,
            stateDir,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            selectEntry: (entry) => ({ match: entry.channel === "feishu", bypassBackoff: true }),
          });
          expect(visibleRequests()).toEqual(beforeRecovery);
          expect(readFeishuQueueState(stateDir, deliveryIntentId)?.status).toBe(
            queued === "completed" ? "completed" : "failed",
          );
        });
      });
    },
  );
});
