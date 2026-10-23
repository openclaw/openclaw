import type { ServerResponse } from "node:http";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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

function loopbackConfig(baseUrl: string, botToken = "loopback-fixture"): OpenClawConfig {
  const mattermost = { baseUrl, botToken, network: { dangerouslyAllowPrivateNetwork: true } };
  return { channels: { mattermost } };
}

async function sendPrepared(cfg: OpenClawConfig, params: Record<string, unknown>) {
  const context = { cfg, to: `channel:${CHANNEL_ID}`, accountId: "default" };
  const text = typeof params.message === "string" ? params.message : "";
  const payload = await mattermostPlugin.actions!.prepareSendPayload!({
    ctx: {
      channel: "mattermost",
      action: "send",
      params: { to: context.to, ...params },
      ...context,
    },
    to: context.to,
    payload: { text },
  });
  expect(payload).not.toBeNull();
  return mattermostPlugin.outbound!.sendPayload!({ ...context, text, payload: payload! });
}

type Request = { path: string; body: string; authorization?: string };
type Reply = (request: Request, response: ServerResponse) => void;
function replyJson(response: ServerResponse, body: unknown, code = 201) {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
const defaultReply: Reply = ({ path }, response) =>
  replyJson(
    response,
    path === "/api/v4/files"
      ? { file_infos: [{ id: "file-loopback" }] }
      : { id: "post-loopback", channel_id: CHANNEL_ID },
  );

function expectPost(requests: Request[], message: string) {
  expect(requests.map(({ path, body }) => [path, body])).toEqual([
    ["/api/v4/posts", JSON.stringify({ channel_id: CHANNEL_ID, message })],
  ]);
}

async function withMattermostServer(
  run: (cfg: OpenClawConfig, requests: Request[]) => Promise<void>,
  reply: Reply = defaultReply,
  token?: string,
) {
  const requests: Request[] = [];
  await withServer(
    (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const entry = {
          path: request.url ?? "",
          body,
          authorization: request.headers.authorization,
        };
        requests.push(entry);
        reply(entry, response);
      });
    },
    async (baseUrl) => {
      setMattermostRuntime(createPluginRuntimeMock());
      await run(loopbackConfig(baseUrl, token), requests);
    },
  );
}

describe("Mattermost send action loopback", () => {
  it("reuses the inbound provider channel when delivering a direct reply", async () => {
    await withMattermostServer(async (cfg, requests) => {
      const core = createPluginRuntimeMock();
      setMattermostRuntime(core);
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
      expectPost(requests, "prepared direct reply");
    });
  });

  it("sends text with blank attachment placeholders and rejects nonblank payloads", async () => {
    await withMattermostServer(async (cfg, requests) => {
      const result = await sendPrepared(cfg, {
        message: "loopback proof",
        buffer: "",
        base64: "  ",
      });
      expect(result).toMatchObject({
        channel: "mattermost",
        messageId: "post-loopback",
        target: { kind: "channel", id: CHANNEL_ID },
      });
      expectPost(requests, "loopback proof");
      await expect(
        sendPrepared(cfg, {
          message: "must not send",
          base64: "cmVwb3J0",
        }),
      ).rejects.toThrow("buffer/base64 payloads are not supported");
      expect(requests).toHaveLength(1);
    });
  });

  it.each([
    { label: "native", buffer: Buffer.from("report") },
    { label: "serialized", buffer: { type: "Buffer", data: [114, 101, 112, 111, 114, 116] } },
  ])("rejects $label binary attachments before posting surrounding text", async ({ buffer }) => {
    await withMattermostServer(async (cfg, requests) => {
      for (const field of ["buffer", "base64"]) {
        for (const params of [{ [field]: buffer }, { attachments: [{ [field]: buffer }] }]) {
          await expect(
            sendPrepared(cfg, { message: "must not lose this attachment", ...params }),
          ).rejects.toThrow("buffer/base64 payloads are not supported");
        }
      }
      expect(requests).toEqual([]);
    });
  });

  it("infers a MIME extension for unnamed uploads", async () => {
    await withMattermostServer(async (cfg, requests) => {
      loadOutboundMediaFromUrl.mockReset();
      loadOutboundMediaFromUrl.mockResolvedValueOnce({
        buffer: Buffer.from("!unnamed-image?").subarray(1, -1),
        contentType: "image/png",
        kind: "image",
      });
      await sendPrepared(cfg, {
        message: "loopback media proof",
        mediaUrl: "https://media.example.test/unnamed",
      });
      const uploads = requests.filter(({ path }) => path === "/api/v4/files");
      expect(uploads).toHaveLength(1);
      expect(uploads[0]?.body).toContain('filename="upload.png"');
      expect(uploads[0]?.body).toContain("Content-Type: image/png");
      expect(uploads[0]?.body).toContain("\r\n\r\nunnamed-image\r\n");
    });
  });
});

describe("Mattermost sender authority over HTTP", () => {
  it.each([
    { mode: "text" as const, revoke: false, uploadFails: false },
    { mode: "text" as const, revoke: true, uploadFails: false },
    { mode: "payload" as const, revoke: true, uploadFails: false },
    ...[false, true].map((revoke) => ({ mode: "media" as const, revoke, uploadFails: true })),
  ])(
    "keeps preferred $mode delivery current after preparation (revoke=$revoke, uploadFails=$uploadFails)",
    async ({ mode, revoke, uploadFails }) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const heldPath = mode === "text" ? "/api/v4/users/username/alice" : "/api/v4/files";
      const sequence: string[] = [];
      const token = `synthetic-authority-${mode}-${revoke}`;
      const retirement = new Error("Mattermost sender is no longer current");
      let current = true;
      const responses: Record<string, unknown> = {
        "/api/v4/users/username/alice": { id: "bbbbbbbbbbbbbbbbbbbbbbbbbb" },
        "/api/v4/users/me": { id: "cccccccccccccccccccccccccc" },
        "/api/v4/channels/direct": { id: CHANNEL_ID },
        "/api/v4/files": uploadFails
          ? { message: "Temporary upload failure" }
          : { file_infos: [{ id: "file-authority" }] },
      };
      const reply: Reply = ({ path }, response) => {
        sequence.push(path);
        const respond = () =>
          replyJson(
            response,
            responses[path] ?? { id: "post-authority", channel_id: CHANNEL_ID },
            uploadFails && path === "/api/v4/files" ? 503 : 200,
          );
        if (path === heldPath) {
          entered.resolve();
          void release.promise.then(respond);
        } else {
          respond();
        }
      };
      await withMattermostServer(
        async (cfg, requests) => {
          loadOutboundMediaFromUrl.mockReset();
          loadOutboundMediaFromUrl.mockResolvedValue({
            buffer: Buffer.from("authority attachment"),
            contentType: "text/plain",
            fileName: "report.txt",
          });
          const send = mattermostPlugin.message!.send!;
          const onDeliveryResult = vi.fn(async () => {
            sequence.push("result");
          });
          const onPlatformSendDispatch = vi.fn(async () => {
            sequence.push("dispatch");
          });
          const ctx: MattermostSendContext = {
            cfg,
            to: mode === "text" ? "@alice" : `channel:${CHANNEL_ID}`,
            text: "authority proof",
            threadId: "thread-root",
            ...(mode === "text" ? {} : { replyToId: "explicit-root" }),
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
              ? send.text!(ctx)
              : mode === "media"
                ? send.media!({ ...ctx, mediaUrl })
                : send.payload!({
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
              expect(
                requests
                  .filter(({ path }) => path === "/api/v4/posts")
                  .map(({ body }) => JSON.parse(body) as unknown),
              ).toMatchObject([
                {
                  message: uploadFails ? `${ctx.text}\n${mediaUrl}` : ctx.text,
                  root_id: mode === "text" ? "thread-root" : "explicit-root",
                },
              ]);
            }
            expect(requests.every(({ authorization }) => authorization === `Bearer ${token}`)).toBe(
              true,
            );
          } finally {
            release.resolve();
          }
        },
        reply,
        token,
      );
    },
  );
});
