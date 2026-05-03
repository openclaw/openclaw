import { describe, expect, it } from "vitest";
import {
  matchWhatsAppAcpConversation,
  normalizeWhatsAppAcpConversationId,
  resolveWhatsAppConversationIdFromTarget,
} from "./conversation-id.js";

// Issue #75211. Before this module landed the WhatsApp channel plugin
// did not implement `compileConfiguredBinding` / `matchInboundConversation`,
// so the gateway's binding registry's `resolveConfiguredBindingProvider`
// returned null for WhatsApp and every inbound message fell through to
// the default agent regardless of `bindings[]` config. These tests cover
// the helper contract the channel plugin now wires into its `bindings`
// block, mirroring the iMessage and BlueBubbles patterns.
describe("normalizeWhatsAppAcpConversationId", () => {
  it("returns canonical E.164 for a bare phone number", () => {
    expect(normalizeWhatsAppAcpConversationId("+15551234567")).toEqual({
      conversationId: "+15551234567",
    });
  });

  it("returns canonical E.164 for a phone number missing the leading +", () => {
    expect(normalizeWhatsAppAcpConversationId("15551234567")).toEqual({
      conversationId: "+15551234567",
    });
  });

  it("collapses formatting characters into the same canonical id", () => {
    expect(normalizeWhatsAppAcpConversationId("+1 (555) 123-4567")).toEqual({
      conversationId: "+15551234567",
    });
  });

  it("strips a leading `whatsapp:` prefix before normalizing", () => {
    expect(normalizeWhatsAppAcpConversationId("whatsapp:+15551234567")).toEqual({
      conversationId: "+15551234567",
    });
  });

  it("normalizes an `s.whatsapp.net` user JID into the underlying E.164", () => {
    expect(normalizeWhatsAppAcpConversationId("15551234567@s.whatsapp.net")).toEqual({
      conversationId: "+15551234567",
    });
  });

  it("normalizes a legacy `c.us` user JID into the underlying E.164", () => {
    expect(normalizeWhatsAppAcpConversationId("15551234567@c.us")).toEqual({
      conversationId: "+15551234567",
    });
  });

  it("normalizes a `lid` (linked-device identity) JID into the underlying digits", () => {
    expect(normalizeWhatsAppAcpConversationId("15551234567@lid")).toEqual({
      conversationId: "+15551234567",
    });
  });

  it("preserves the canonical `<id>@g.us` form for a group JID", () => {
    expect(normalizeWhatsAppAcpConversationId("120363012345678901@g.us")).toEqual({
      conversationId: "120363012345678901@g.us",
    });
  });

  it("strips a `whatsapp:` prefix in front of a group JID", () => {
    expect(normalizeWhatsAppAcpConversationId("whatsapp:120363012345678901@g.us")).toEqual({
      conversationId: "120363012345678901@g.us",
    });
  });

  it("preserves the canonical `<id>@newsletter` form for a newsletter JID", () => {
    expect(normalizeWhatsAppAcpConversationId("120363098765432109@newsletter")).toEqual({
      conversationId: "120363098765432109@newsletter",
    });
  });

  it("returns null for an empty string", () => {
    expect(normalizeWhatsAppAcpConversationId("")).toBeNull();
  });

  it("returns null for whitespace only", () => {
    expect(normalizeWhatsAppAcpConversationId("   ")).toBeNull();
  });

  it("returns null for an unknown JID host (not whatsapp/group/newsletter/lid)", () => {
    expect(normalizeWhatsAppAcpConversationId("alice@example.com")).toBeNull();
  });

  it("returns null when another provider's prefix is used", () => {
    expect(normalizeWhatsAppAcpConversationId("telegram:+15551234567")).toBeNull();
  });
});

describe("matchWhatsAppAcpConversation", () => {
  it("returns matchPriority=2 when the binding and inbound resolve to the same canonical id", () => {
    expect(
      matchWhatsAppAcpConversation({
        bindingConversationId: "+15551234567",
        conversationId: "15551234567@s.whatsapp.net",
      }),
    ).toEqual({ conversationId: "+15551234567", matchPriority: 2 });
  });

  it("matches a formatted authored phone against an inbound JID", () => {
    expect(
      matchWhatsAppAcpConversation({
        bindingConversationId: "+1 (555) 123-4567",
        conversationId: "15551234567@s.whatsapp.net",
      }),
    ).toEqual({ conversationId: "+15551234567", matchPriority: 2 });
  });

  it("matches a group JID against itself regardless of `whatsapp:` prefix", () => {
    expect(
      matchWhatsAppAcpConversation({
        bindingConversationId: "whatsapp:120363012345678901@g.us",
        conversationId: "120363012345678901@g.us",
      }),
    ).toEqual({ conversationId: "120363012345678901@g.us", matchPriority: 2 });
  });

  it("returns null when the two conversations resolve to different canonical ids", () => {
    expect(
      matchWhatsAppAcpConversation({
        bindingConversationId: "+15551234567",
        conversationId: "15559999999@s.whatsapp.net",
      }),
    ).toBeNull();
  });

  it("returns null when a direct binding is compared against a group inbound", () => {
    expect(
      matchWhatsAppAcpConversation({
        bindingConversationId: "+15551234567",
        conversationId: "120363012345678901@g.us",
      }),
    ).toBeNull();
  });

  it("returns null when either side fails to normalize", () => {
    expect(
      matchWhatsAppAcpConversation({
        bindingConversationId: "alice@example.com",
        conversationId: "+15551234567",
      }),
    ).toBeNull();
    expect(
      matchWhatsAppAcpConversation({
        bindingConversationId: "+15551234567",
        conversationId: "",
      }),
    ).toBeNull();
  });
});

describe("resolveWhatsAppConversationIdFromTarget", () => {
  it("returns the canonical id for a phone target", () => {
    expect(resolveWhatsAppConversationIdFromTarget("+15551234567")).toBe("+15551234567");
  });

  it("returns the canonical id for a `whatsapp:`-prefixed target", () => {
    expect(resolveWhatsAppConversationIdFromTarget("whatsapp:+15551234567")).toBe("+15551234567");
  });

  it("returns the canonical id for a group JID target", () => {
    expect(resolveWhatsAppConversationIdFromTarget("120363012345678901@g.us")).toBe(
      "120363012345678901@g.us",
    );
  });

  it("returns undefined for a target that does not look like WhatsApp", () => {
    expect(resolveWhatsAppConversationIdFromTarget("alice@example.com")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(resolveWhatsAppConversationIdFromTarget("")).toBeUndefined();
  });
});
