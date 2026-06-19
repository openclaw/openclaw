// Whatsapp tests cover quoted message plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildOutboundQuotedMeta,
  cacheInboundMessageMeta,
  lookupInboundMessageMeta,
  lookupInboundMessageMetaForTarget,
} from "./quoted-message.js";

describe("quoted message metadata cache", () => {
  it("scopes cached metadata by account id", () => {
    cacheInboundMessageMeta("account-a", "1555@s.whatsapp.net", "msg-1", {
      participant: "111@s.whatsapp.net",
      body: "hello from a",
      fromMe: true,
    });
    cacheInboundMessageMeta("account-b", "1555@s.whatsapp.net", "msg-1", {
      participant: "222@s.whatsapp.net",
      body: "hello from b",
      fromMe: false,
    });

    expect(lookupInboundMessageMeta("account-a", "1555@s.whatsapp.net", "msg-1")).toEqual({
      participant: "111@s.whatsapp.net",
      body: "hello from a",
      fromMe: true,
    });
    expect(lookupInboundMessageMeta("account-b", "1555@s.whatsapp.net", "msg-1")).toEqual({
      participant: "222@s.whatsapp.net",
      body: "hello from b",
      fromMe: false,
    });
  });

  it("can recover the original remoteJid for a matching direct-chat target", () => {
    cacheInboundMessageMeta("account-c", "277038292303944@lid", "msg-2", {
      participant: "5511976136970@s.whatsapp.net",
      body: "hello from lid chat",
      fromMe: true,
    });

    expect(
      lookupInboundMessageMetaForTarget("account-c", "5511976136970@s.whatsapp.net", "msg-2"),
    ).toEqual({
      remoteJid: "277038292303944@lid",
      participant: "5511976136970@s.whatsapp.net",
      body: "hello from lid chat",
      fromMe: true,
    });
    expect(
      lookupInboundMessageMetaForTarget("account-c", "99999999999@s.whatsapp.net", "msg-2"),
    ).toBeUndefined();
    expect(
      lookupInboundMessageMetaForTarget("missing", "5511976136970@s.whatsapp.net", "msg-2"),
    ).toBeUndefined();
  });

  it("can recover a direct-chat remoteJid when only sender E164 was cached", () => {
    cacheInboundMessageMeta("account-e", "277038292303944@lid", "msg-4", {
      participantE164: "+5511976136970",
      body: "hello from e164 participant",
    });

    expect(
      lookupInboundMessageMetaForTarget("account-e", "5511976136970@s.whatsapp.net", "msg-4"),
    ).toEqual({
      remoteJid: "277038292303944@lid",
      participant: undefined,
      participantE164: "+5511976136970",
      body: "hello from e164 participant",
      fromMe: undefined,
    });
  });

  it("marks the bot's own outbound group message with fromMe and the bot's participant JID (#91445)", () => {
    const meta = buildOutboundQuotedMeta({
      remoteJid: "120363400000000000@g.us",
      self: { jid: "15551112222@s.whatsapp.net", lid: "99999@lid" },
      body: "  bot reply text  ",
    });
    expect(meta).toEqual({
      fromMe: true,
      participant: "15551112222@s.whatsapp.net",
      body: "bot reply text",
    });

    // A later swipe-reply to that message must resolve the quote key with the
    // bot's own identity, not the cache-miss fallback (fromMe:false + replier).
    cacheInboundMessageMeta("account-self", "120363400000000000@g.us", "bot-msg-1", meta);
    expect(
      lookupInboundMessageMeta("account-self", "120363400000000000@g.us", "bot-msg-1"),
    ).toEqual({
      participant: "15551112222@s.whatsapp.net",
      participantE164: undefined,
      body: "bot reply text",
      fromMe: true,
    });
  });

  it("omits the participant for the bot's own outbound direct-chat message (#91445)", () => {
    const meta = buildOutboundQuotedMeta({
      remoteJid: "15559998888@s.whatsapp.net",
      self: { jid: "15551112222@s.whatsapp.net" },
      body: "direct reply",
    });
    expect(meta).toEqual({ fromMe: true, body: "direct reply" });
    expect(meta.participant).toBeUndefined();
  });

  it("falls back to the bot's lid when no self jid is known, and drops empty body", () => {
    const meta = buildOutboundQuotedMeta({
      remoteJid: "120363400000000000@g.us",
      self: { jid: null, lid: "77777@lid" },
      body: "   ",
    });
    expect(meta).toEqual({ fromMe: true, participant: "77777@lid" });
    expect(meta.body).toBeUndefined();
  });

  it("does not recover metadata from another chat when the target conversation differs", () => {
    cacheInboundMessageMeta("account-d", "120363400000000000@g.us", "msg-3", {
      participant: "111@s.whatsapp.net",
      body: "group secret",
    });

    expect(
      lookupInboundMessageMetaForTarget("account-d", "222@s.whatsapp.net", "msg-3"),
    ).toBeUndefined();
  });
});
