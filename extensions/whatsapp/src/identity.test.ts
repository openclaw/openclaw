// Whatsapp tests cover comparable identity JID semantics.
import { describe, expect, it } from "vitest";
import {
  identitiesOverlap,
  prepareWhatsAppDirectInboundActor,
  resolveComparableIdentity,
} from "./identity.js";

describe("resolveComparableIdentity", () => {
  it("canonicalizes PN and LID identities through the shared JID contract", () => {
    expect(resolveComparableIdentity({ jid: "15551230000:2@c.us" })).toMatchObject({
      jid: "15551230000@s.whatsapp.net",
      lid: null,
      e164: "+15551230000",
    });
    expect(resolveComparableIdentity({ jid: "277038292303944:3@hosted.lid" })).toMatchObject({
      jid: null,
      lid: "277038292303944@hosted.lid",
      e164: null,
    });
  });

  it("does not overlap same-digit PN and LID identities without a mapping", () => {
    expect(
      identitiesOverlap({ jid: "812345678901234@s.whatsapp.net" }, { jid: "812345678901234@lid" }),
    ).toBe(false);
  });

  it("overlaps hosted and standard forms of the same identity class", () => {
    expect(
      identitiesOverlap({ jid: "15551230000@hosted" }, { jid: "15551230000@s.whatsapp.net" }),
    ).toBe(true);
    expect(
      identitiesOverlap({ lid: "277038292303944@hosted.lid" }, { lid: "277038292303944@lid" }),
    ).toBe(true);
  });

  it("rejects malformed direct identities instead of partially normalizing them", () => {
    expect(resolveComparableIdentity({ jid: "15551230000:bad@s.whatsapp.net" })).toMatchObject({
      jid: null,
      lid: null,
      e164: null,
    });
  });
});

describe("prepareWhatsAppDirectInboundActor", () => {
  const self = {
    jid: "15550000000@s.whatsapp.net",
    lid: "800000000000000@lid",
    e164: "+15550000000",
  };

  it("treats alternate JIDs as forms of the sender for incoming messages", () => {
    expect(
      prepareWhatsAppDirectInboundActor({
        remoteJid: "812345678901234:2@lid",
        remoteJidAlt: "15551234567:3@s.whatsapp.net",
        fromMe: false,
        self,
      }),
    ).toEqual({
      transportJid: "812345678901234:2@lid",
      e164: "+15551234567",
      comparableJids: ["812345678901234@lid", "15551234567@s.whatsapp.net"],
    });
  });

  it("keeps an outgoing peer recipient separate from the sender alternate", () => {
    expect(
      prepareWhatsAppDirectInboundActor({
        remoteJid: "812345678901234:2@lid",
        remoteJidAlt: "15550000000:3@s.whatsapp.net",
        fromMe: true,
        self,
      }),
    ).toEqual({
      transportJid: "812345678901234:2@lid",
      e164: null,
      comparableJids: ["812345678901234@lid"],
    });
  });

  it("recognizes a self-chat from the recipient identity without using the sender alternate", () => {
    expect(
      prepareWhatsAppDirectInboundActor({
        remoteJid: "800000000000000:2@lid",
        remoteJidAlt: "15550000000:3@s.whatsapp.net",
        fromMe: true,
        self,
      }),
    ).toEqual({
      transportJid: "800000000000000:2@lid",
      e164: "+15550000000",
      comparableJids: ["800000000000000@lid", "15550000000@s.whatsapp.net"],
    });
  });

  it("recognizes hosted and standard LID forms as the same self-chat actor", () => {
    expect(
      prepareWhatsAppDirectInboundActor({
        remoteJid: "800000000000000:2@hosted.lid",
        remoteJidAlt: "15550000000:3@s.whatsapp.net",
        fromMe: true,
        self,
      }),
    ).toEqual({
      transportJid: "800000000000000:2@hosted.lid",
      e164: "+15550000000",
      comparableJids: [
        "800000000000000@hosted.lid",
        "15550000000@s.whatsapp.net",
        "800000000000000@lid",
      ],
    });
  });
});
