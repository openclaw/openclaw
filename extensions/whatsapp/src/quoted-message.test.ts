// Whatsapp tests cover quoted message plugin behavior.
import { generateWAMessageFromContent } from "baileys";
import { describe, expect, it } from "vitest";
import {
  buildQuotedMessageOptions,
  cacheInboundMessageMeta,
  lookupInboundMessageMeta,
  lookupInboundMessageMetaForTarget,
} from "./quoted-message.js";

const lookupForTarget = (accountId: string, targetJid: string, messageId: string) =>
  lookupInboundMessageMetaForTarget(accountId, targetJid, messageId);

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

    expect(lookupForTarget("account-c", "5511976136970@s.whatsapp.net", "msg-2")).toEqual({
      remoteJid: "277038292303944@lid",
      participant: "5511976136970@s.whatsapp.net",
      body: "hello from lid chat",
      fromMe: true,
    });
    expect(lookupForTarget("account-c", "99999999999@s.whatsapp.net", "msg-2")).toBeUndefined();
    expect(lookupForTarget("missing", "5511976136970@s.whatsapp.net", "msg-2")).toBeUndefined();
  });

  it("can recover a direct-chat remoteJid when only its E164 was cached", () => {
    cacheInboundMessageMeta("account-e", "277038292303944@lid", "msg-4", {
      remoteE164: "+5511976136970",
      body: "hello from e164 participant",
    });

    expect(lookupForTarget("account-e", "5511976136970@s.whatsapp.net", "msg-4")).toEqual({
      remoteJid: "277038292303944@lid",
      participant: undefined,
      body: "hello from e164 participant",
      fromMe: undefined,
    });
  });

  it("canonicalizes device-qualified and c.us cache identities", () => {
    cacheInboundMessageMeta("account-canonical", "15551230000:2@c.us", "msg-canonical", {
      participant: "15557654321:3@hosted",
      body: "canonical",
    });

    expect(
      lookupForTarget("account-canonical", "15551230000@s.whatsapp.net", "msg-canonical"),
    ).toEqual({
      remoteJid: "15551230000@s.whatsapp.net",
      participant: "15557654321@hosted",
      body: "canonical",
      fromMe: undefined,
    });
  });

  it("does not match same-digit PN and LID conversations without a mapping", () => {
    cacheInboundMessageMeta("account-unmapped", "812345678901234@lid", "msg-unmapped", {
      body: "unmapped lid",
    });

    expect(
      lookupForTarget("account-unmapped", "812345678901234@s.whatsapp.net", "msg-unmapped"),
    ).toBeUndefined();
  });

  it("matches hosted and standard forms of the same direct identity", () => {
    cacheInboundMessageMeta("account-hosted", "277038292303944@lid", "msg-hosted", {
      body: "same lid actor",
    });

    expect(lookupForTarget("account-hosted", "277038292303944@hosted.lid", "msg-hosted")).toEqual({
      remoteJid: "277038292303944@lid",
      participant: undefined,
      body: "same lid actor",
      fromMe: undefined,
    });
  });

  it("uses the prepared direct-chat identity for hosted PN/LID quote equivalence", () => {
    cacheInboundMessageMeta(
      "account-hosted-map",
      "277038292303944:2@hosted.lid",
      "msg-hosted-map",
      { remoteE164: "+15551230000", body: "mapped hosted lid" },
    );

    expect(lookupForTarget("account-hosted-map", "15551230000:4@hosted", "msg-hosted-map")).toEqual(
      {
        remoteJid: "277038292303944@hosted.lid",
        participant: undefined,
        body: "mapped hosted lid",
        fromMe: undefined,
      },
    );
  });

  it("rejects ambiguous prepared identity matches", () => {
    cacheInboundMessageMeta("account-ambiguous", "111111111111111@lid", "msg-ambiguous", {
      remoteE164: "+15551230000",
      body: "first",
    });
    cacheInboundMessageMeta("account-ambiguous", "222222222222222@lid", "msg-ambiguous", {
      remoteE164: "+15551230000",
      body: "second",
    });

    expect(
      lookupForTarget("account-ambiguous", "15551230000@s.whatsapp.net", "msg-ambiguous"),
    ).toBeUndefined();
  });

  it("lets Baileys encode the self participant for a cached outbound quote (#91445)", () => {
    const remoteJid = "120363400000000000@g.us";
    const userJid = "15551112222@s.whatsapp.net";
    cacheInboundMessageMeta("account-self", remoteJid, "bot-msg-1", {
      fromMe: true,
      body: "bot reply text",
    });
    const cached = lookupInboundMessageMeta("account-self", remoteJid, "bot-msg-1");
    const quoteOptions = buildQuotedMessageOptions({
      messageId: "bot-msg-1",
      remoteJid,
      fromMe: cached?.fromMe,
      participant: cached?.participant,
      messageText: cached?.body,
    });
    if (!quoteOptions) {
      throw new Error("expected quote options");
    }

    const encoded = generateWAMessageFromContent(
      remoteJid,
      { extendedTextMessage: { text: "user reply" } },
      { ...quoteOptions, userJid },
    );

    expect(quoteOptions.quoted?.key.participant).toBeUndefined();
    expect(encoded.message?.extendedTextMessage?.contextInfo).toMatchObject({
      participant: userJid,
      stanzaId: "bot-msg-1",
      quotedMessage: { conversation: "bot reply text" },
    });
  });

  it("does not recover metadata from another chat when the target conversation differs", () => {
    cacheInboundMessageMeta("account-d", "120363400000000000@g.us", "msg-3", {
      participant: "111@s.whatsapp.net",
      body: "group secret",
    });

    expect(lookupForTarget("account-d", "222@s.whatsapp.net", "msg-3")).toBeUndefined();
  });
});
