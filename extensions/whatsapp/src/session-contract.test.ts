// Whatsapp tests cover session contract plugin behavior.
import { describe, expect, it } from "vitest";
import {
  canonicalizeLegacySessionKey,
  deriveLegacySessionChatType,
  isLegacyGroupSessionKey,
} from "./session-contract.js";

describe("whatsapp legacy session contract", () => {
  it("canonicalizes legacy WhatsApp group keys to channel-qualified agent keys", () => {
    expect(canonicalizeLegacySessionKey({ key: "group:123@g.us", agentId: "main" })).toBe(
      "agent:main:whatsapp:group:123@g.us",
    );
    expect(canonicalizeLegacySessionKey({ key: "123@g.us", agentId: "main" })).toBe(
      "agent:main:whatsapp:group:123@g.us",
    );
    expect(canonicalizeLegacySessionKey({ key: "whatsapp:123@g.us", agentId: "main" })).toBe(
      "agent:main:whatsapp:group:123@g.us",
    );
    expect(canonicalizeLegacySessionKey({ key: " GROUP:123@G.US ", agentId: "MAIN" })).toBe(
      "agent:main:whatsapp:group:123@g.us",
    );
  });

  it("does not claim generic non-WhatsApp group keys", () => {
    expect(isLegacyGroupSessionKey("group:abc")).toBe(false);
    expect(deriveLegacySessionChatType("group:abc")).toBeUndefined();
    expect(canonicalizeLegacySessionKey({ key: "group:abc", agentId: "main" })).toBeNull();
  });

  it.each(["group:123:2@g.us", "whatsapp:123@g.us@evil.example"])(
    "rejects malformed legacy group key %s",
    (key) => {
      expect(isLegacyGroupSessionKey(key)).toBe(false);
      expect(deriveLegacySessionChatType(key)).toBeUndefined();
      expect(canonicalizeLegacySessionKey({ key, agentId: "main" })).toBeNull();
    },
  );

  it("derives chat type for legacy WhatsApp group keys", () => {
    expect(deriveLegacySessionChatType("123@g.us")).toBe("group");
    expect(deriveLegacySessionChatType("whatsapp:123@g.us")).toBe("group");
  });
});
