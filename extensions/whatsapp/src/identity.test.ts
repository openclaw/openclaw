// Whatsapp tests cover comparable identity JID semantics.
import { describe, expect, it } from "vitest";
import { identitiesOverlap, resolveComparableIdentity } from "./identity.js";

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
