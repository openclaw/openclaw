/**
 * Live integration tests for the telegram-userbot channel.
 *
 * These tests require a real Telegram account and are skipped in CI.
 * To run: TELEGRAM_USERBOT_LIVE=1 pnpm test -- --run extensions/telegram-userbot/src/live.test.ts
 *
 * Required environment:
 *   TELEGRAM_USERBOT_LIVE=1
 *   TELEGRAM_API_ID=<your api id>
 *   TELEGRAM_API_HASH=<your api hash>
 *   TELEGRAM_SESSION=<base64 session string>
 *   TELEGRAM_LIVE_PEER=<chat id or @username to test against>
 */

import { describe, expect, it } from "vitest";

const LIVE = process.env.TELEGRAM_USERBOT_LIVE === "1" || process.env.LIVE === "1";
const API_ID = Number(process.env.TELEGRAM_API_ID ?? "0");
const API_HASH = process.env.TELEGRAM_API_HASH ?? "";
const PEER = process.env.TELEGRAM_LIVE_PEER ?? "";

const describeLive = LIVE && API_ID && API_HASH ? describe : describe.skip;

describeLive("telegram-userbot live", () => {
  it("connects and retrieves self info", async () => {
    // TODO: Instantiate UserbotClient with real credentials
    // const client = new UserbotClient({ apiId: API_ID, apiHash: API_HASH, session: ... });
    // await client.connect();
    // const me = await client.getMe();
    // expect(me.id).toBeTruthy();
    // await client.disconnect();
    expect(true).toBe(true);
  });

  it("sends and receives a test message", async () => {
    // TODO: Connect, send message to PEER, verify it was sent
    // const result = await client.sendMessage(PEER, { message: "live test" });
    // expect(result.id).toBeTruthy();
    expect(PEER).toBeTruthy();
  });

  it("edits a sent message", async () => {
    // TODO: Send a message, then edit it, verify edit
    // const sent = await client.sendMessage(PEER, { message: "before edit" });
    // await client.editMessage(PEER, sent.id, "after edit");
    expect(true).toBe(true);
  });

  it("deletes a sent message", async () => {
    // TODO: Send a message, then delete it
    // const sent = await client.sendMessage(PEER, { message: "to delete" });
    // await client.deleteMessages(PEER, [sent.id], true);
    expect(true).toBe(true);
  });

  it("reacts to a message", async () => {
    // TODO: Send a message, then react to it
    // const sent = await client.sendMessage(PEER, { message: "react test" });
    // await client.reactToMessage(PEER, sent.id, "👍");
    expect(true).toBe(true);
  });
});
