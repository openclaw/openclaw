/**
 * Live integration tests for the telegram-userbot channel.
 *
 * These tests require a real Telegram account with valid credentials
 * and are skipped by default in CI.
 *
 * Run manually with:
 *   LIVE=1 pnpm test extensions/telegram-userbot/src/live.test.ts
 *
 * Or:
 *   CLAWDBOT_LIVE_TEST=1 pnpm test extensions/telegram-userbot/src/live.test.ts
 *
 * Required environment:
 *   LIVE=1 or CLAWDBOT_LIVE_TEST=1
 *   TELEGRAM_API_ID=<your api id>
 *   TELEGRAM_API_HASH=<your api hash>
 *   TELEGRAM_SESSION=<base64 session string>
 *   TELEGRAM_LIVE_PEER=<chat id or @username to test against>
 */

import { describe, it } from "vitest";

const isLive = process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1";

describe.skipIf(!isLive)("telegram-userbot live tests", () => {
  it("connects with real session", async () => {
    // TODO: load real session from SessionStore, connect, verify getMe()
    // const client = new UserbotClient({ apiId, apiHash, session });
    // await client.connect();
    // const me = await client.getMe();
    // expect(me.id).toBeTruthy();
    // await client.disconnect();
  });

  it("sends a real text message", async () => {
    // TODO: send message to test chat, verify messageId is returned
    // const result = await client.sendMessage(PEER, "live test message");
    // expect(result.messageId).toBeGreaterThan(0);
  });

  it("receives a real inbound message", async () => {
    // TODO: register inbound handler, send message to self, wait for inbound event
    // const cleanup = registerInboundHandlers(client, { selfUserId, onMessage });
    // await client.sendMessage(PEER, "echo test");
    // // wait for onMessage callback
    // cleanup();
  });

  it("deletes a real message", async () => {
    // TODO: send message then delete it, verify no error
    // const sent = await client.sendMessage(PEER, "to delete");
    // await client.deleteMessages(PEER, [sent.messageId], true);
  });
});
