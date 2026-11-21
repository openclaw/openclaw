// Whatsapp tests cover group session contract plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveLegacyGroupSessionKey } from "./group-session-contract.js";

describe("whatsapp group session contract", () => {
  it("returns the canonical group JID", () => {
    expect(resolveLegacyGroupSessionKey({ From: " 120363000000000000@G.US " })).toEqual({
      key: "whatsapp:group:120363000000000000@g.us",
      channel: "whatsapp",
      id: "120363000000000000@g.us",
      chatType: "group",
    });
  });

  it.each(["120363000000000000:2@g.us", "120363000000000000@g.us@evil.example"])(
    "rejects malformed group JID %s",
    (from) => {
      expect(resolveLegacyGroupSessionKey({ From: from })).toBeNull();
    },
  );
});
