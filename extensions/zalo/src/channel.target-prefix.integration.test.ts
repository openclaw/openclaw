import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zaloPlugin } from "./channel.js";

const cfg = { channels: { zalo: { accounts: { default: { botToken: "test-bot-token" } } } } };

describe("configured Zalo outbound target delivery", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { target: "zalo:group:group-123", peer: "group-123", kind: "text", peerKind: "group" },
    { target: "zl:user:direct-456", peer: "direct-456", kind: "text", peerKind: "direct" },
    { target: "group:group-789", peer: "group-789", kind: "media", peerKind: "group" },
    { target: "zalo:dm:direct-987", peer: "direct-987", kind: "media", peerKind: "direct" },
  ] as const)(
    "sends $kind to the same bare peer selected by the session route ($target)",
    async ({ target, peer, kind, peerKind }) => {
      const requests: { body: Record<string, unknown>; method: string }[] = [];
      await withServer(
        (request, response) => {
          void (async () => {
            const method = request.url?.match(/\/bot[^/]+\/([^/?]+)/u)?.[1] ?? "unknown";
            let raw = "";
            for await (const chunk of request) {
              raw += String(chunk);
            }
            const body = JSON.parse(raw) as Record<string, unknown>;
            requests.push({ body, method });
            const chatId = typeof body.chat_id === "string" ? body.chat_id : "";
            const isBareChatId = Boolean(chatId) && !/^(?:zalo|zl|group|user|dm):/iu.test(chatId);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify(
                isBareChatId
                  ? { ok: true, result: { message_id: `${method}-delivered` } }
                  : {
                      ok: false,
                      error_code: 400,
                      description: "chat_id must be a bare Zalo conversation ID",
                    },
              ),
            );
          })().catch((error: unknown) => {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false, description: String(error) }));
          });
        },
        async (baseUrl) => {
          vi.stubEnv("ZALO_API_URL", baseUrl);
          const route = await zaloPlugin.messaging?.resolveOutboundSessionRoute?.({
            cfg,
            agentId: "main",
            accountId: "default",
            target,
          });
          expect(route?.recipientSessionExact).toBe(true);
          expect(route?.peer).toEqual({ id: peer, kind: peerKind });
          const mediaUrl = "https://93.184.216.34/proof.png";
          const method = kind === "text" ? "sendMessage" : "sendPhoto";
          const { sendText, sendMedia } = zaloPlugin.outbound ?? {};
          if (!sendText || !sendMedia) {
            throw new Error(`expected configured Zalo outbound ${kind} adapter`);
          }
          const result =
            kind === "text"
              ? await sendText({ cfg, to: target, text: "proof" })
              : await sendMedia({ cfg, to: target, text: "proof", mediaUrl });
          expect(result.messageId).toBe(`${method}-delivered`);
          expect(requests).toEqual([
            {
              method,
              body:
                kind === "text"
                  ? { chat_id: peer, text: "proof" }
                  : { chat_id: peer, photo: mediaUrl, caption: "proof" },
            },
          ]);
        },
      );
    },
  );
});
