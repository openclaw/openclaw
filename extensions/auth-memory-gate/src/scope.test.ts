import { describe, test, expect } from "vitest";
import {
  deriveChannel,
  derivePeerId,
  resolveScope,
  formatScopeBlock,
  formatGatedMessage,
  formatHardGateSystemPrompt,
  formatHardGateReplyAppend,
} from "./scope.js";

describe("deriveChannel", () => {
  test("extracts channel from standard session key", () => {
    expect(deriveChannel("agent:main:telegram:user123")).toBe("telegram");
  });

  test("extracts channel from direct session key", () => {
    expect(deriveChannel("agent:main:direct:peer1")).toBe("direct");
  });

  test("returns unknown for non-standard format", () => {
    expect(deriveChannel("unknown-format")).toBe("unknown");
  });

  test("returns unknown for short key", () => {
    expect(deriveChannel("agent:main")).toBe("unknown");
  });
});

describe("derivePeerId", () => {
  test("extracts peerId from channel session key", () => {
    expect(derivePeerId("agent:main:telegram:user123")).toBe("user123");
  });

  test("extracts peerId from direct marker format", () => {
    expect(derivePeerId("agent:main:direct:peer1")).toBe("peer1");
  });

  test("extracts peerId from channel+direct format", () => {
    expect(derivePeerId("agent:main:telegram:direct:peer1")).toBe("peer1");
  });

  test("returns main for shared session", () => {
    expect(derivePeerId("agent:main:main")).toBe("main");
  });

  test("returns full key for non-agent format", () => {
    expect(derivePeerId("some-other-key")).toBe("some-other-key");
  });

  test("handles compound peer IDs with colons", () => {
    expect(derivePeerId("agent:main:whatsapp:+1:234:5678")).toBe("+1:234:5678");
  });
});

describe("resolveScope", () => {
  test("uses external_id as scopeKey for verified user", () => {
    const identity = {
      id: "uuid-123",
      external_id: "ext-abc",
      first_name: "Jane",
      last_name: "Doe",
      channel: "telegram",
      channel_peer_id: "tg-user",
      verified: true,
    };
    const result = resolveScope(identity, "telegram", "tg-user");
    expect(result.scopeKey).toBe("ext-abc");
    expect(result.userId).toBe("uuid-123");
    expect(result.externalId).toBe("ext-abc");
    expect(result.verified).toBe(true);
  });

  test("falls back to user id as scopeKey for unverified user", () => {
    const identity = {
      id: "uuid-456",
      external_id: null,
      first_name: "John",
      last_name: null,
      channel: "whatsapp",
      channel_peer_id: "+1234567890",
      verified: false,
    };
    const result = resolveScope(identity, "whatsapp", "+1234567890");
    expect(result.scopeKey).toBe("uuid-456");
    expect(result.externalId).toBeNull();
    expect(result.verified).toBe(false);
  });
});

describe("formatScopeBlock", () => {
  const verifiedScope = {
    userId: "uuid-123",
    externalId: "ext-abc" as string | null,
    scopeKey: "ext-abc",
    verified: true,
    channel: "telegram",
    peerId: "tg-user",
  };

  const unverifiedScope = {
    userId: "uuid-456",
    externalId: null as string | null,
    scopeKey: "uuid-456",
    verified: false,
    channel: "whatsapp",
    peerId: "+1234567890",
  };

  test("outputs scope block for verified user", () => {
    const result = formatScopeBlock(verifiedScope, {});
    expect(result).toContain("[MEMORY_SCOPE]");
    expect(result).toContain("scope_key: ext-abc");
    expect(result).toContain("user_id: uuid-123");
    expect(result).toContain("external_id: ext-abc");
    expect(result).toContain("verified: true");
    expect(result).toContain("gated: false");
    expect(result).toContain("[/MEMORY_SCOPE]");
  });

  test("outputs scope block for unverified user when requireVerified is false", () => {
    const result = formatScopeBlock(unverifiedScope, { requireVerified: false });
    expect(result).toContain("[MEMORY_SCOPE]");
    expect(result).toContain("scope_key: uuid-456");
    expect(result).toContain("external_id: none");
    expect(result).toContain("verified: false");
    expect(result).toContain("gated: false");
  });

  test("outputs gate message for unverified user when requireVerified is true", () => {
    const result = formatScopeBlock(unverifiedScope, { requireVerified: true });
    expect(result).toContain("[MEMORY_SCOPE]");
    expect(result).toContain("gated: true");
    expect(result).toContain("/verify <token>");
    expect(result).not.toContain("scope_key:");
  });

  test("does not gate verified user even when requireVerified is true", () => {
    const result = formatScopeBlock(verifiedScope, { requireVerified: true });
    expect(result).toContain("gated: false");
    expect(result).toContain("scope_key: ext-abc");
  });
});

describe("formatGatedMessage", () => {
  test("shows default gate message", () => {
    const result = formatGatedMessage({});
    expect(result).toContain("[MEMORY_SCOPE]");
    expect(result).toContain("gated: true");
    expect(result).toContain("Memory retrieval is not available until identity is verified.");
    expect(result).toContain("/verify <token>");
  });

  test("uses custom gate message when provided", () => {
    const result = formatGatedMessage({ gateMessage: "Please log in at example.com first." });
    expect(result).toContain("[MEMORY_SCOPE]");
    expect(result).toContain("gated: true");
    expect(result).toContain("Please log in at example.com first.");
    expect(result).not.toContain("Memory retrieval is not available");
  });

  test("trims whitespace from custom message", () => {
    const result = formatGatedMessage({ gateMessage: "  Custom message  " });
    expect(result).toContain("Custom message");
  });
});

describe("formatHardGateSystemPrompt", () => {
  test("includes IDENTITY_GATE block with channel and peerId", () => {
    const result = formatHardGateSystemPrompt("telegram", "tg-user-123");
    expect(result).toContain("[IDENTITY_GATE]");
    expect(result).toContain("status: LOCKED");
    expect(result).toContain("channel: telegram");
    expect(result).toContain("channel_peer_id: tg-user-123");
    expect(result).toContain("[/IDENTITY_GATE]");
  });

  test("instructs agent to only discuss verification", () => {
    const result = formatHardGateSystemPrompt("whatsapp", "+1234567890");
    expect(result).toContain("MUST NOT proceed");
    expect(result).toContain("/verify <token>");
    expect(result).toContain("/register <first_name> <last_name>");
  });

  test("forbids answering unrelated questions", () => {
    const result = formatHardGateSystemPrompt("slack", "U12345");
    expect(result).toContain("Do NOT answer any other questions");
    expect(result).toContain("Politely redirect");
  });
});

describe("formatHardGateReplyAppend", () => {
  test("includes verification CTA with both commands", () => {
    const result = formatHardGateReplyAppend();
    expect(result).toContain("/verify <token>");
    expect(result).toContain("/register <first_name> <last_name>");
  });

  test("starts with separator", () => {
    const result = formatHardGateReplyAppend();
    expect(result).toContain("---");
  });
});
