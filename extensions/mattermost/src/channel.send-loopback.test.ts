import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
// Mattermost tests cover the action-to-REST send path over loopback.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { mattermostPlugin } from "./channel.js";
import { deliverMattermostReplyPayload } from "./mattermost/reply-delivery.js";
import { sendMessageMattermost } from "./mattermost/send.js";
import { setMattermostRuntime } from "./runtime.js";

const CHANNEL_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const loadOutboundMediaFromUrl = vi.hoisted(() => vi.fn());

type MattermostMessageSender = NonNullable<NonNullable<typeof mattermostPlugin.message>["send"]>;
type MattermostSendContext = Parameters<NonNullable<MattermostMessageSender["text"]>>[0];

vi.mock("./mattermost/runtime-api.js", async () => ({
  ...(await vi.importActual<typeof import("./mattermost/runtime-api.js")>(
    "./mattermost/runtime-api.js",
  )),
  loadOutboundMediaFromUrl,
}));

async function sendPreparedMattermostLoopback(params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
}) {
  const to = typeof params.actionParams.to === "string" ? params.actionParams.to.trim() : "";
  const text = typeof params.actionParams.message === "string" ? params.actionParams.message : "";
  const prepareSendPayload = mattermostPlugin.actions?.prepareSendPayload;
  const sendPayload = mattermostPlugin.outbound?.sendPayload;
  if (!to || !prepareSendPayload || !sendPayload) {
    throw new Error("Mattermost prepared outbound send surface missing");
  }
  const payload = await prepareSendPayload({
    ctx: {
      channel: "mattermost",
      action: "send",
      params: params.actionParams,
      cfg: params.cfg,
      accountId: "default",
    },
    to,
    payload: { text },
  });
  if (!payload) {
    throw new Error("Mattermost send preparation declined");
  }
  return await sendPayload({
    cfg: params.cfg,
    to,
    text,
    payload,
    accountId: "default",
  });
}

describe("Mattermost send action loopback", () => {
  it("reuses the inbound provider channel when delivering a direct reply", async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];

    await withServer(
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const path = request.url ?? "";
          requests.push({ path, ...(body ? { body: JSON.parse(body) as unknown } : {}) });
          response.writeHead(201, { "content-type": "application/json" });
          if (path === "/api/v4/users/me") {
            response.end(JSON.stringify({ id: "cccccccccccccccccccccccccc" }));
            return;
          }
          if (path === "/api/v4/channels/direct") {
            response.end(JSON.stringify({ id: CHANNEL_ID }));
            return;
          }
          response.end(
            JSON.stringify({
              id: "post-loopback",
              channel_id: CHANNEL_ID,
              message: "prepared direct reply",
            }),
          );
        });
      },
      async (baseUrl) => {
        const core = createPluginRuntimeMock();
        setMattermostRuntime(core);
        const cfg = {
          channels: {
            mattermost: {
              botToken: "prepared-inbound-loopback",
              baseUrl,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        } as OpenClawConfig;

        const result = await deliverMattermostReplyPayload({
          core,
          cfg,
          payload: { text: "prepared direct reply" },
          channelId: CHANNEL_ID,
          accountId: "default",
          textLimit: 4000,
          tableMode: "off",
          sendMessage: sendMessageMattermost,
        });

        expect(result).toMatchObject({
          outcome: "text",
          messageIds: ["post-loopback"],
          visibleReplySent: true,
        });
        expect(requests).toEqual([
          {
            path: "/api/v4/posts",
            body: { channel_id: CHANNEL_ID, message: "prepared direct reply" },
          },
        ]);
      },
    );
  });

  it("sends text with blank attachment placeholders and rejects nonblank payloads", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];

    await withServer(
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          requests.push({
            path: request.url ?? "",
            body: JSON.parse(body) as unknown,
          });
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "post-loopback", channel_id: CHANNEL_ID }));
        });
      },
      async (baseUrl) => {
        setMattermostRuntime(createPluginRuntimeMock());
        const cfg = {
          channels: {
            mattermost: {
              botToken: ["loopback", "fixture"].join("-"),
              baseUrl,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        } as OpenClawConfig;
        const result = await sendPreparedMattermostLoopback({
          cfg,
          actionParams: {
            to: `channel:${CHANNEL_ID}`,
            message: "loopback proof",
            buffer: "",
            base64: "  ",
          },
        });

        expect(result).toMatchObject({
          channel: "mattermost",
          messageId: "post-loopback",
          target: { kind: "channel", id: CHANNEL_ID },
        });
        expect(requests).toEqual([
          {
            path: "/api/v4/posts",
            body: { channel_id: CHANNEL_ID, message: "loopback proof" },
          },
        ]);

        await expect(
          sendPreparedMattermostLoopback({
            cfg,
            actionParams: {
              to: `channel:${CHANNEL_ID}`,
              message: "must not send",
              base64: "cmVwb3J0",
            },
          }),
        ).rejects.toThrow("buffer/base64 payloads are not supported");
        expect(requests).toHaveLength(1);
      },
    );
  });

  it("infers a MIME extension for unnamed uploads", async () => {
    const uploads: string[] = [];

    await withServer(
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          if (request.url === "/api/v4/files") {
            uploads.push(body);
            response.writeHead(201, { "content-type": "application/json" });
            response.end(JSON.stringify({ file_infos: [{ id: `file-${uploads.length}` }] }));
            return;
          }
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "post-loopback", channel_id: CHANNEL_ID }));
        });
      },
      async (baseUrl) => {
        setMattermostRuntime(createPluginRuntimeMock());
        loadOutboundMediaFromUrl.mockReset();
        loadOutboundMediaFromUrl.mockResolvedValueOnce({
          buffer: Buffer.from("!unnamed-image?").subarray(1, -1),
          contentType: "image/png",
          kind: "image",
        });
        const cfg = {
          channels: {
            mattermost: {
              botToken: "loopback-fixture",
              baseUrl,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        } as OpenClawConfig;
        await sendPreparedMattermostLoopback({
          cfg,
          actionParams: {
            to: `channel:${CHANNEL_ID}`,
            message: "loopback media proof",
            mediaUrl: "https://media.example.test/unnamed",
          },
        });
      },
    );

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain('filename="upload.png"');
    expect(uploads[0]).toContain("Content-Type: image/png");
    expect(uploads[0]).toContain("\r\n\r\nunnamed-image\r\n");
  });
});

describe("Mattermost sender authority over HTTP", () => {
  it.each([
    ...(["text", "media", "payload"] as const).flatMap((mode) =>
      [false, true].map((revoke) => ({ mode, revoke, uploadFails: false })),
    ),
    ...[false, true].map((revoke) => ({ mode: "media" as const, revoke, uploadFails: true })),
  ])(
    "keeps preferred $mode delivery current after preparation (revoke=$revoke, uploadFails=$uploadFails)",
    async ({ mode, revoke, uploadFails }) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const heldPath = mode === "text" ? "/api/v4/users/username/alice" : "/api/v4/files";
      const requests: Array<{ path: string; authorization?: string }> = [];
      const postBodies: unknown[] = [];
      const sequence: string[] = [];
      const token = `synthetic-authority-${mode}-${revoke}`;
      const retirement = new Error("Mattermost sender is no longer current");
      let current = true;

      await withServer(
        (request, response) => {
          let postBody = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            if (request.url === "/api/v4/posts") {
              postBody += chunk;
            }
          });
          request.on("end", () => {
            const requestPath = request.url ?? "";
            requests.push({ path: requestPath, authorization: request.headers.authorization });
            if (requestPath === "/api/v4/posts") {
              postBodies.push(JSON.parse(postBody) as unknown);
            }
            sequence.push(requestPath);
            const respond = () => {
              response.writeHead(uploadFails && requestPath === "/api/v4/files" ? 503 : 200, {
                "content-type": "application/json",
              });
              if (requestPath === "/api/v4/users/username/alice") {
                response.end(JSON.stringify({ id: "bbbbbbbbbbbbbbbbbbbbbbbbbb" }));
              } else if (requestPath === "/api/v4/users/me") {
                response.end(JSON.stringify({ id: "cccccccccccccccccccccccccc" }));
              } else if (requestPath === "/api/v4/channels/direct") {
                response.end(JSON.stringify({ id: CHANNEL_ID }));
              } else if (requestPath === "/api/v4/files") {
                response.end(
                  JSON.stringify(
                    uploadFails
                      ? { message: "Temporary upload failure" }
                      : { file_infos: [{ id: "file-authority" }] },
                  ),
                );
              } else {
                response.end(JSON.stringify({ id: "post-authority", channel_id: CHANNEL_ID }));
              }
            };
            if (requestPath === heldPath) {
              entered.resolve();
              void release.promise.then(respond);
            } else {
              respond();
            }
          });
        },
        async (baseUrl) => {
          setMattermostRuntime(createPluginRuntimeMock());
          loadOutboundMediaFromUrl.mockReset();
          loadOutboundMediaFromUrl.mockResolvedValue({
            buffer: Buffer.from("authority attachment"),
            contentType: "text/plain",
            fileName: "report.txt",
          });
          const send = mattermostPlugin.message?.send;
          if (!send?.text || !send.media || !send.payload) {
            throw new Error("Mattermost preferred send registration missing");
          }
          const onDeliveryResult = vi.fn<NonNullable<MattermostSendContext["onDeliveryResult"]>>(
            async () => {
              sequence.push("result");
            },
          );
          const onPlatformSendDispatch = vi.fn(async () => {
            sequence.push("dispatch");
          });
          const ctx: MattermostSendContext = {
            cfg: {
              channels: {
                mattermost: {
                  baseUrl,
                  botToken: token,
                  network: { dangerouslyAllowPrivateNetwork: true },
                },
              },
            },
            to: mode === "text" ? "@alice" : `channel:${CHANNEL_ID}`,
            text: "authority proof",
            accountId: "default",
            assertDirectAdapterHandoff: () => {
              if (!current) {
                throw retirement;
              }
            },
            onPlatformSendDispatch,
            onDeliveryResult,
          };
          const mediaUrl = "https://media.example.test/report.txt";
          const pending =
            mode === "text"
              ? send.text(ctx)
              : mode === "media"
                ? send.media({ ...ctx, mediaUrl })
                : send.payload({
                    ...ctx,
                    payload: {
                      text: ctx.text,
                      mediaUrl,
                      channelData: { mattermost: { attachmentText: "attachment context" } },
                    },
                  });
          const settled = pending.then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );
          try {
            await Promise.race([
              entered.promise,
              settled.then(() => {
                throw new Error(`Send settled before reaching ${heldPath}`);
              }),
            ]);
            current = !revoke;
            release.resolve();
            const outcome = await settled;
            if (revoke) {
              expect(requests.map(({ path }) => path)).toEqual([heldPath]);
              expect(outcome.error).toBeInstanceOf(PlatformMessageNotDispatchedError);
              expect(outcome.error).toMatchObject({ retryable: false, cause: retirement });
              expect(onPlatformSendDispatch).not.toHaveBeenCalled();
              expect(onDeliveryResult).not.toHaveBeenCalled();
            } else {
              expect(outcome.error).toBeUndefined();
              expect(outcome.value?.receipt.platformMessageIds).toEqual(["post-authority"]);
              expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
              expect(onDeliveryResult).toHaveBeenCalledOnce();
              expect(sequence.slice(-3)).toEqual(["dispatch", "/api/v4/posts", "result"]);
              expect(postBodies).toMatchObject([
                { message: uploadFails ? `${ctx.text}\n${mediaUrl}` : ctx.text },
              ]);
            }
            expect(requests.every(({ authorization }) => authorization === `Bearer ${token}`)).toBe(
              true,
            );
          } finally {
            release.resolve();
          }
        },
      );
    },
  );
});
