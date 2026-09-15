// Whatsapp tests cover canonical JID parsing and classification.
import { describe, expect, it } from "vitest";
import {
  areSameWhatsAppJid,
  canonicalizeWhatsAppDirectJids,
  classifyWhatsAppJid,
  encodeWhatsAppJid,
} from "./whatsapp-jid.js";

describe("classifyWhatsAppJid", () => {
  it.each([
    ["15551230000@s.whatsapp.net", "pn", "s.whatsapp.net", "15551230000@s.whatsapp.net"],
    ["15551230000:0@s.whatsapp.net", "pn", "s.whatsapp.net", "15551230000@s.whatsapp.net"],
    ["15551230000_0:1@s.whatsapp.net", "pn", "s.whatsapp.net", "15551230000@s.whatsapp.net"],
    ["277038292303944_1:2@s.whatsapp.net", "lid", "lid", "277038292303944@lid"],
    ["15551230000_128:1@s.whatsapp.net", "pn", "hosted", "15551230000@hosted"],
    ["277038292303944_129:3@s.whatsapp.net", "lid", "hosted.lid", "277038292303944@hosted.lid"],
    ["15551230000@c.us", "pn", "s.whatsapp.net", "15551230000@s.whatsapp.net"],
    ["15551230000:7@c.us", "pn", "s.whatsapp.net", "15551230000@s.whatsapp.net"],
    ["15551230000_128:1@c.us", "pn", "hosted", "15551230000@hosted"],
    ["15551230000@hosted", "pn", "hosted", "15551230000@hosted"],
    ["15551230000:9@hosted", "pn", "hosted", "15551230000@hosted"],
    ["15551230000:255@hosted", "pn", "hosted", "15551230000@hosted"],
    ["15551230000:99@hosted", "pn", "hosted", "15551230000@hosted"],
    ["15551230000_128:1@hosted", "pn", "hosted", "15551230000@hosted"],
    ["277038292303944@lid", "lid", "lid", "277038292303944@lid"],
    ["277038292303944:2@lid", "lid", "lid", "277038292303944@lid"],
    ["277038292303944_1:2@lid", "lid", "lid", "277038292303944@lid"],
    ["277038292303944@hosted.lid", "lid", "hosted.lid", "277038292303944@hosted.lid"],
    ["277038292303944:3@hosted.lid", "lid", "hosted.lid", "277038292303944@hosted.lid"],
    ["277038292303944:99@hosted.lid", "lid", "hosted.lid", "277038292303944@hosted.lid"],
    ["277038292303944_129:3@hosted.lid", "lid", "hosted.lid", "277038292303944@hosted.lid"],
    ["120363401234567890-123@g.us", "group", "g.us", "120363401234567890-123@g.us"],
    ["120363401234567890@newsletter", "newsletter", "newsletter", "120363401234567890@newsletter"],
  ] as const)("classifies and canonicalizes %s", (input, kind, server, jid) => {
    expect(classifyWhatsAppJid(input)).toEqual({
      kind,
      server,
      user: jid.slice(0, jid.indexOf("@")),
      jid,
    });
  });

  it("preserves case-insensitive server compatibility", () => {
    expect(classifyWhatsAppJid("15551230000:4@HOSTED")).toEqual({
      kind: "pn",
      server: "hosted",
      user: "15551230000",
      jid: "15551230000@hosted",
    });
  });

  it.each([
    "",
    "15551230000",
    "@s.whatsapp.net",
    "15551230000@",
    "15551230000@unknown",
    "15551230000@foo@s.whatsapp.net",
    "abc@s.whatsapp.net",
    "15551230000:abc@s.whatsapp.net",
    "15551230000:-1@s.whatsapp.net",
    "15551230000:1:2@s.whatsapp.net",
    "15551230000_bad:1@s.whatsapp.net",
    "15551230000_128:bad@s.whatsapp.net",
    "15551230000_128:1:2@s.whatsapp.net",
    "15551230000_2:1@s.whatsapp.net",
    "15551230000_129:1@hosted",
    "15551230000_128:1@lid",
    "15551230000:99@s.whatsapp.net",
    "277038292303944:99@lid",
    "15551230000:256@hosted",
    "15551230000_256:1@s.whatsapp.net",
    "15551230000 :1@s.whatsapp.net",
    "120363401234567890:1@g.us",
    "120363401234567890--123@g.us",
    "abc@g.us",
    "120363401234567890:1@newsletter",
    "status@broadcast",
    "123@broadcast",
  ])("rejects unsupported or malformed JID %j", (input) => {
    expect(classifyWhatsAppJid(input)).toEqual({ kind: "unsupported" });
  });
});

describe("encodeWhatsAppJid", () => {
  it("encodes only valid canonical JIDs", () => {
    expect(encodeWhatsAppJid("15551230000", "s.whatsapp.net")).toBe("15551230000@s.whatsapp.net");
    expect(encodeWhatsAppJid("277038292303944", "hosted.lid")).toBe("277038292303944@hosted.lid");
    expect(() => encodeWhatsAppJid("not-a-phone", "hosted")).toThrow(
      "Invalid WhatsApp hosted JID user",
    );
  });
});

describe("canonicalizeWhatsAppDirectJids", () => {
  it("filters unsupported values and preserves canonical first-seen order", () => {
    expect(
      canonicalizeWhatsAppDirectJids([
        "15551230000:2@c.us",
        "277038292303944_129:3@s.whatsapp.net",
        "bad",
        "15551230000@s.whatsapp.net",
        "120363401234567890-123@g.us",
      ]),
    ).toEqual(["15551230000@s.whatsapp.net", "277038292303944@hosted.lid"]);
  });
});

describe("areSameWhatsAppJid", () => {
  it("compares decoded users within the same identity class", () => {
    expect(areSameWhatsAppJid("15551230000:2@c.us", "15551230000@s.whatsapp.net")).toBe(true);
    expect(areSameWhatsAppJid("277038292303944:2@lid", "277038292303944@lid")).toBe(true);
    expect(areSameWhatsAppJid("15551230000@hosted", "15551230000@s.whatsapp.net")).toBe(true);
    expect(areSameWhatsAppJid("277038292303944@hosted.lid", "277038292303944@lid")).toBe(true);
    expect(areSameWhatsAppJid("123@s.whatsapp.net", "123@lid")).toBe(false);
    expect(areSameWhatsAppJid("123@g.us", "123@newsletter")).toBe(false);
    expect(areSameWhatsAppJid("bad", "bad")).toBe(false);
  });
});
