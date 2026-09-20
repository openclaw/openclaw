import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Client as TeamsHttpClient } from "@microsoft/teams.common";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { msteamsPlugin } from "./channel.js";
import { sendMSTeamsMessages } from "./messenger.js";
import { createMSTeamsReplayContext } from "./replay-context.js";
import { loadMSTeamsSdkWithAuth } from "./sdk.js";
import { sendPollMSTeams } from "./send.js";

const { resolveMSTeamsSendContext } = vi.hoisted(() => ({
  resolveMSTeamsSendContext: vi.fn(),
}));

// Isolate the stored destination and credentials; keep registration, send preparation,
// retries, Teams App/API/Common, and the Axios HTTP adapter on their real paths.
vi.mock("./send-context.js", () => ({ resolveMSTeamsSendContext }));

const conversationId = "19:handoff@thread.v2";
const serviceUrl = "https://smba.trafficmanager.net/amer";
const cfg = { channels: { msteams: { enabled: true } } } as OpenClawConfig;

type ConnectorRequest = { method: string; path: string; activity: Record<string, unknown> };

async function withInlineImage(
  run: (media: { mediaUrl: string; mediaLocalRoots: string[] }) => Promise<void>,
) {
  await withTempDir("msteams-handoff-", async (dir) => {
    const mediaUrl = join(dir, "image.png");
    await writeFile(mediaUrl, createSolidPngBuffer(2, 2, { r: 10, g: 20, b: 30 }));
    await run({ mediaUrl, mediaLocalRoots: [dir] });
  });
}

async function createConnectorFixture() {
  const requests: ConnectorRequest[] = [];
  let respond = (response: ServerResponse) => {
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `accepted-${requests.length}` }));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        activity: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      respond(response);
    })().catch((error: unknown) => response.destroy(error as Error));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { app } = await loadMSTeamsSdkWithAuth({
    type: "secret",
    appId: "fixture-app",
    appPassword: "fixture-secret",
    tenantId: "fixture-tenant",
  });
  const token = vi.spyOn(app.tokenManager, "getBotToken").mockResolvedValue("fixture-token");
  const http = (app.api as unknown as { http: TeamsHttpClient }).http;
  http.use({
    request: ({ config }) => {
      const destination = new URL(config.url!);
      config.url = `${origin}${destination.pathname}${destination.search}`;
      config.proxy = false;
      return config;
    },
  });
  const context = {
    app,
    appId: "fixture-app",
    conversationId,
    ref: {
      serviceUrl,
      agent: { id: "fixture-app", role: "bot" },
      user: { id: "fixture-user" },
      conversation: { id: conversationId, conversationType: "groupChat" },
      channelId: "msteams",
    },
    conversationType: "groupChat",
    replyStyle: "top-level",
    sdkCloudOptions: { cloud: "Public" },
    tokenProvider: { getAccessToken: async () => "fixture-graph-token" },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  resolveMSTeamsSendContext.mockResolvedValue(context);
  return {
    app,
    http,
    token,
    requests,
    context,
    setResponder(next: typeof respond) {
      respond = next;
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

afterEach(() => {
  resolveMSTeamsSendContext.mockReset();
  vi.restoreAllMocks();
});

describe("registered Teams delivery handoff", () => {
  it.each([true, false])(
    "preserves handoff through replay contexts with active authority=%s",
    async (keepActive) => {
      const fixture = await createConnectorFixture();
      const tokenStarted = createDeferred<void>();
      const releaseToken = createDeferred<void>();
      let active = true;
      fixture.token.mockImplementation(async () => {
        tokenStarted.resolve();
        await releaseToken.promise;
        return "fixture-token";
      });
      const context = createMSTeamsReplayContext(
        {
          type: "message",
          id: "inbound-root",
          channelId: "msteams",
          serviceUrl,
          from: { id: "fixture-user" },
          recipient: { id: "fixture-app" },
          conversation: { id: conversationId, conversationType: "groupChat" },
        },
        fixture.app,
        { cloud: "Public" },
      );
      try {
        const onPlatformSendDispatch = vi.fn(async () => {});
        const completion = sendMSTeamsMessages({
          replyStyle: "thread",
          app: fixture.app,
          appId: "fixture-app",
          conversationRef: fixture.context.ref,
          context,
          messages: [{ text: "queued reply" }],
          assertDirectAdapterHandoff: () => {
            if (!active) {
              throw new Error("delivery authority closed");
            }
          },
          onPlatformSendDispatch,
        }).then(
          (ids) => ({ ids }),
          (error: unknown) => ({ error }),
        );
        await tokenStarted.promise;
        active = keepActive;
        releaseToken.resolve();
        const outcome = await completion;
        if (keepActive) {
          expect(outcome).toEqual({ ids: ["accepted-1"] });
          expect(fixture.requests[0]?.activity.text).toContain('messageId="inbound-root"');
        } else {
          expect(outcome).toMatchObject({ error: { retryable: false } });
        }
        expect(fixture.requests).toHaveLength(keepActive ? 1 : 0);
        expect(onPlatformSendDispatch).toHaveBeenCalledTimes(keepActive ? 1 : 0);
      } finally {
        releaseToken.resolve();
        await fixture.close();
      }
    },
  );
  it("sends text through the real SDK and returns its accepted receipt", async () => {
    const fixture = await createConnectorFixture();
    try {
      const onPlatformSendDispatch = vi.fn(async () => {});
      const onDeliveryResult = vi.fn();
      const result = await msteamsPlugin.message!.send!.text!({
        cfg,
        to: `conversation:${conversationId}`,
        text: "ordinary delivery",
        onPlatformSendDispatch,
        onDeliveryResult,
      });
      expect(fixture.requests).toEqual([
        {
          method: "POST",
          path: `/amer/v3/conversations/${conversationId}/activities`,
          activity: expect.objectContaining({ type: "message", text: "ordinary delivery" }),
        },
      ]);
      expect(result.receipt.parts).toEqual([
        expect.objectContaining({ platformMessageId: "accepted-1", kind: "text" }),
      ]);
      expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
      expect(onDeliveryResult).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
  });

  it.each(["text", "poll"] as const)(
    "does not submit a %s Connector request when authority closes during SDK token acquisition",
    async (kind) => {
      const fixture = await createConnectorFixture();
      const tokenStarted = createDeferred<void>();
      const releaseToken = createDeferred<void>();
      let active = true;
      fixture.token.mockImplementation(async () => {
        tokenStarted.resolve();
        await releaseToken.promise;
        return "fixture-token";
      });
      try {
        const handoff = {
          assertDirectAdapterHandoff: () => {
            if (!active) {
              throw new Error("delivery authority closed");
            }
          },
        };
        const completion = (
          kind === "poll"
            ? sendPollMSTeams({
                cfg,
                to: `conversation:${conversationId}`,
                question: "Ship?",
                options: ["Yes", "No"],
                ...handoff,
              })
            : msteamsPlugin.message!.send!.text!({
                cfg,
                to: `conversation:${conversationId}`,
                text: "retired delivery",
                ...handoff,
              })
        ).then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        );
        await tokenStarted.promise;
        active = false;
        releaseToken.resolve();
        const settled = await completion;
        expect(fixture.requests).toEqual([]);
        expect(settled.error).toEqual(
          expect.objectContaining({ message: expect.stringContaining("authority closed") }),
        );
      } finally {
        releaseToken.resolve();
        await fixture.close();
      }
    },
  );

  it.each(["text", "poll"] as const)(
    "checks %s authority again after dispatch recording waits",
    async (kind) => {
      const fixture = await createConnectorFixture();
      const dispatchStarted = createDeferred<void>();
      const releaseDispatch = createDeferred<void>();
      let active = true;
      try {
        const handoff = {
          assertDirectAdapterHandoff: () => {
            if (!active) {
              throw new Error("delivery authority closed");
            }
          },
          onPlatformSendDispatch: async () => {
            dispatchStarted.resolve();
            await releaseDispatch.promise;
          },
        };
        const completion = (
          kind === "poll"
            ? sendPollMSTeams({
                cfg,
                to: `conversation:${conversationId}`,
                question: "Ship?",
                options: ["Yes", "No"],
                ...handoff,
              })
            : msteamsPlugin.message!.send!.text!({
                cfg,
                to: `conversation:${conversationId}`,
                text: "retired during dispatch recording",
                ...handoff,
              })
        ).catch((error: unknown) => error);
        await dispatchStarted.promise;
        active = false;
        releaseDispatch.resolve();
        expect(await completion).toMatchObject({ retryable: false });
        expect(fixture.requests).toEqual([]);
      } finally {
        releaseDispatch.resolve();
        await fixture.close();
      }
    },
  );

  it("checks at JSON transport submission after earlier SDK interceptors finish", async () => {
    const fixture = await createConnectorFixture();
    let active = true;
    fixture.http.use({
      request: ({ config }) => {
        const transforms = config.transformRequest;
        config.transformRequest = [
          ...(Array.isArray(transforms) ? transforms : transforms ? [transforms] : []),
          (data: unknown) => {
            active = false;
            return data;
          },
        ];
        return config;
      },
    });
    try {
      await expect(
        msteamsPlugin.message!.send!.text!({
          cfg,
          to: `conversation:${conversationId}`,
          text: "retired during serialization",
          assertDirectAdapterHandoff: () => {
            if (!active) {
              throw new Error("delivery authority closed");
            }
          },
        }),
      ).rejects.toMatchObject({ retryable: false });
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps an accepted receipt when authority closes while the response is pending", async () => {
    const fixture = await createConnectorFixture();
    const accepted = createDeferred<ServerResponse>();
    let active = true;
    fixture.setResponder((response) => accepted.resolve(response));
    try {
      const onDeliveryResult = vi.fn();
      const completion = msteamsPlugin.message!.send!.text!({
        cfg,
        to: `conversation:${conversationId}`,
        text: "already submitted",
        assertDirectAdapterHandoff: () => {
          if (!active) {
            throw new Error("delivery authority closed");
          }
        },
        onDeliveryResult,
      });
      const response = await accepted.promise;
      active = false;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "accepted-before-close" }));
      expect(await completion).toMatchObject({
        receipt: { platformMessageIds: ["accepted-before-close"] },
      });
      expect(onDeliveryResult).toHaveBeenCalledOnce();
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("retains the accepted poll ID when authority closes while the response is pending", async () => {
    const fixture = await createConnectorFixture();
    const submitted = createDeferred<ServerResponse>();
    let active = true;
    fixture.setResponder((response) => submitted.resolve(response));
    try {
      const completion = sendPollMSTeams({
        cfg,
        to: `conversation:${conversationId}`,
        question: "Ship?",
        options: ["Yes", "No"],
        assertDirectAdapterHandoff: () => {
          if (!active) {
            throw new Error("delivery authority closed");
          }
        },
      });
      const response = await submitted.promise;
      active = false;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "accepted-poll-before-close" }));
      await expect(completion).resolves.toMatchObject({
        messageId: "accepted-poll-before-close",
        conversationId,
        pollId: expect.any(String),
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("isolates concurrent operations sharing the SDK HTTP client", async () => {
    const fixture = await createConnectorFixture();
    const firstToken = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    let firstActive = true;
    fixture.token.mockImplementationOnce(async () => {
      firstToken.resolve();
      await releaseFirst.promise;
      return "fixture-token";
    });
    try {
      const firstDispatch = vi.fn(async () => {});
      const first = msteamsPlugin.message!.send!.text!({
        cfg,
        to: `conversation:${conversationId}`,
        text: "first retired",
        assertDirectAdapterHandoff: () => {
          if (!firstActive) {
            throw new Error("first authority closed");
          }
        },
        onPlatformSendDispatch: firstDispatch,
      }).catch((error: unknown) => error);
      await firstToken.promise;
      const secondDispatch = vi.fn(async () => {});
      await msteamsPlugin.message!.send!.text!({
        cfg,
        to: `conversation:${conversationId}`,
        text: "second active",
        assertDirectAdapterHandoff: () => {},
        onPlatformSendDispatch: secondDispatch,
      });
      firstActive = false;
      releaseFirst.resolve();
      expect(await first).toMatchObject({ retryable: false });
      await msteamsPlugin.message!.send!.text!({
        cfg,
        to: `conversation:${conversationId}`,
        text: "unguarded independent send",
      });
      expect(fixture.requests.map((request) => request.activity.text)).toEqual([
        "second active",
        "unguarded independent send",
      ]);
      expect(firstDispatch).not.toHaveBeenCalled();
      expect(secondDispatch).toHaveBeenCalledOnce();
    } finally {
      releaseFirst.resolve();
      await fixture.close();
    }
  });

  it.each([true, false])(
    "rechecks a rate-limit retry with active authority=%s",
    async (activeAfterDelay) => {
      const fixture = await createConnectorFixture();
      let active = true;
      fixture.setResponder((response) => {
        if (fixture.requests.length === 1) {
          response.writeHead(429, { "content-type": "application/json", "retry-after": "0.01" });
          response.end(JSON.stringify({ error: "throttled" }));
        } else {
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "accepted-retry" }));
        }
      });
      fixture.context.log.debug.mockImplementation((message: unknown) => {
        if (message === "retrying send") {
          active = activeAfterDelay;
        }
      });
      try {
        const onPlatformSendDispatch = vi.fn(async () => {});
        const completion = msteamsPlugin.message!.send!.text!({
          cfg,
          to: `conversation:${conversationId}`,
          text: "throttled delivery",
          assertDirectAdapterHandoff: () => {
            if (!active) {
              throw new Error("delivery authority closed");
            }
          },
          onPlatformSendDispatch,
        });
        if (activeAfterDelay) {
          await expect(completion).resolves.toMatchObject({ messageId: "accepted-retry" });
        } else {
          await expect(completion).rejects.toMatchObject({ retryable: false });
        }
        expect(fixture.requests).toHaveLength(activeAfterDelay ? 2 : 1);
        expect(onPlatformSendDispatch).toHaveBeenCalledTimes(activeAfterDelay ? 2 : 1);
      } finally {
        await fixture.close();
      }
    },
  );

  it.each([true, false])(
    "retains accepted media parts with continued authority=%s",
    async (keepActive) => {
      const fixture = await createConnectorFixture();
      let active = true;
      try {
        await withInlineImage(async (media) => {
          const progress: string[] = [];
          const onPlatformSendDispatch = vi.fn(async () => {});
          const completion = msteamsPlugin.message!.send!.media!({
            cfg,
            to: `conversation:${conversationId}`,
            text: "accepted caption",
            ...media,
            assertDirectAdapterHandoff: () => {
              if (!active) {
                throw new Error("delivery authority closed");
              }
            },
            onPlatformSendDispatch,
            onDeliveryResult: (result) => {
              progress.push(...result.receipt.platformMessageIds);
              active = keepActive;
            },
          });
          if (keepActive) {
            await expect(completion).resolves.toMatchObject({
              receipt: { platformMessageIds: ["accepted-1", "accepted-2"] },
            });
            expect(progress).toEqual(["accepted-1", "accepted-2"]);
          } else {
            await expect(completion).rejects.toMatchObject({
              code: "CHANNEL_PARTIAL_DELIVERY",
              deliveryResult: {
                visibleReplySent: true,
                receipt: {
                  platformMessageIds: ["accepted-1"],
                  parts: [expect.objectContaining({ kind: "text" })],
                },
              },
            });
            expect(progress).toEqual(["accepted-1"]);
          }
          expect(fixture.requests).toHaveLength(keepActive ? 2 : 1);
          expect(onPlatformSendDispatch).toHaveBeenCalledTimes(keepActive ? 2 : 1);
        });
      } finally {
        await fixture.close();
      }
    },
  );

  it("retains an accepted image response after authority closes", async () => {
    const fixture = await createConnectorFixture();
    const submitted = createDeferred<ServerResponse>();
    let active = true;
    fixture.setResponder((response) => submitted.resolve(response));
    try {
      await withInlineImage(async (media) => {
        const completion = msteamsPlugin.message!.send!.media!({
          cfg,
          to: `conversation:${conversationId}`,
          text: "",
          ...media,
          assertDirectAdapterHandoff: () => {
            if (!active) {
              throw new Error("delivery authority closed");
            }
          },
        });
        const response = await submitted.promise;
        active = false;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "accepted-image" }));
        await expect(completion).resolves.toMatchObject({
          receipt: {
            parts: [
              expect.objectContaining({ platformMessageId: "accepted-image", kind: "media" }),
            ],
          },
        });
        expect(fixture.requests).toHaveLength(1);
      });
    } finally {
      await fixture.close();
    }
  });

  it.each(["send", "upload-file"] as const)(
    "keeps the %s action fenced through the SDK token wait",
    async (action) => {
      const fixture = await createConnectorFixture();
      const tokenStarted = createDeferred<void>();
      const releaseToken = createDeferred<void>();
      let active = true;
      fixture.token.mockImplementation(async () => {
        tokenStarted.resolve();
        await releaseToken.promise;
        return "fixture-token";
      });
      try {
        await withInlineImage(async (media) => {
          const onPlatformSendDispatch = vi.fn(async () => {});
          const completion = msteamsPlugin.actions!.handleAction!({
            channel: "msteams",
            action,
            cfg,
            params: {
              target: `conversation:${conversationId}`,
              ...(action === "send"
                ? { presentation: { blocks: [{ type: "text", text: "card content" }] } }
                : { path: media.mediaUrl }),
            },
            mediaLocalRoots: media.mediaLocalRoots,
            assertDirectAdapterHandoff: () => {
              if (!active) {
                throw new Error("delivery authority closed");
              }
            },
            onPlatformSendDispatch,
          }).catch((error: unknown) => error);
          await tokenStarted.promise;
          active = false;
          releaseToken.resolve();
          expect(await completion).toMatchObject({ retryable: false });
          expect(fixture.requests).toEqual([]);
          expect(onPlatformSendDispatch).not.toHaveBeenCalled();
        });
      } finally {
        releaseToken.resolve();
        await fixture.close();
      }
    },
  );
});
