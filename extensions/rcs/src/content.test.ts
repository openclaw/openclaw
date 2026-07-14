import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
// Rcs tests cover MessagePresentation -> Twilio Content API translation.
import { describe, expect, it } from "vitest";
import { presentationToTwilioContent } from "./content.js";

function present(presentation: MessagePresentation) {
  return presentationToTwilioContent({ presentation });
}

function expectCardActions(spec: ReturnType<typeof present>): unknown[] {
  if (!spec) {
    throw new Error("Expected a Twilio card content spec.");
  }
  const card = spec.request.types["twilio/card"] as { actions: unknown[] };
  return card.actions;
}

function expectCard(spec: ReturnType<typeof present>): Record<string, unknown> {
  if (!spec) {
    throw new Error("Expected a Twilio card content spec.");
  }
  return spec.request.types["twilio/card"] as Record<string, unknown>;
}

describe("presentationToTwilioContent", () => {
  it("returns null for plain text with no rich affordance", () => {
    expect(present({ blocks: [{ type: "text", text: "hello" }] })).toBeNull();
    expect(present({ blocks: [] })).toBeNull();
  });

  it("drops URL buttons whose scheme is not http(s)", () => {
    expect(
      present({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Call", action: { type: "url", url: "tel:+15551234567" } }],
          },
        ],
      }),
    ).toBeNull();
  });

  it("builds a twilio/card template from callback buttons", () => {
    const spec = present({
      blocks: [
        { type: "text", text: "Pick one" },
        {
          type: "buttons",
          buttons: [
            { label: "Yes", action: { type: "callback", value: "yes" } },
            { label: "No", action: { type: "callback", value: "no" } },
          ],
        },
      ],
    });
    expect(spec?.contentType).toBe("card");
    expect(spec?.request.friendly_name).toBe("openclaw_rcs_dynamic");
    expect(spec?.request.language).toBe("en");
    expect(spec?.request.types).toEqual({
      "twilio/card": {
        title: "Pick one",
        body: "Pick one",
        actions: [
          { type: "QUICK_REPLY", id: "yes", title: "Yes" },
          { type: "QUICK_REPLY", id: "no", title: "No" },
        ],
      },
    });
    expect(spec?.variables).toEqual({});
  });

  it("maps command buttons and select options to suggested replies", () => {
    const spec = present({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Refresh", action: { type: "command", command: "/refresh" } }],
        },
        {
          type: "select",
          placeholder: "Env",
          options: [
            { label: "Canary", value: "env:canary" },
            { label: "Prod", action: { type: "callback", value: "env:prod" } },
          ],
        },
      ],
    });
    expect(spec?.contentType).toBe("card");
    expect(expectCardActions(spec)).toEqual([
      { type: "QUICK_REPLY", id: "/refresh", title: "Refresh" },
      { type: "QUICK_REPLY", id: "env:canary", title: "Canary" },
      { type: "QUICK_REPLY", id: "env:prod", title: "Prod" },
    ]);
  });

  it("builds a twilio/card template from url and web-app buttons", () => {
    const spec = present({
      blocks: [
        { type: "text", text: "See more" },
        {
          type: "buttons",
          buttons: [
            { label: "Visit", action: { type: "url", url: "https://example.com/a" } },
            { label: "App", action: { type: "web-app", url: "https://example.com/app" } },
          ],
        },
      ],
    });
    expect(spec?.contentType).toBe("card");
    expect(spec?.request.types).toEqual({
      "twilio/card": {
        title: "See more",
        body: "See more",
        actions: [
          { type: "URL", title: "Visit", url: "https://example.com/a" },
          { type: "URL", title: "App", url: "https://example.com/app" },
        ],
      },
    });
  });

  it("builds a twilio/card template when url and suggested-reply actions mix", () => {
    const spec = present({
      title: "Order update",
      blocks: [
        { type: "text", text: "Your order shipped." },
        {
          type: "buttons",
          buttons: [
            { label: "Track", action: { type: "url", url: "https://track.example" } },
            { label: "Reorder", action: { type: "callback", value: "reorder" } },
          ],
        },
      ],
    });
    expect(spec?.contentType).toBe("card");
    expect(spec?.request.types).toEqual({
      "twilio/card": {
        title: "Order update",
        body: "Your order shipped.",
        actions: [
          { type: "URL", title: "Track", url: "https://track.example" },
          { type: "QUICK_REPLY", id: "reorder", title: "Reorder" },
        ],
      },
    });
  });

  it("builds a twilio/card with media when media accompanies actions", () => {
    const spec = presentationToTwilioContent({
      presentation: {
        title: "Promo",
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Shop", action: { type: "url", url: "https://shop.example" } }],
          },
        ],
      },
      mediaUrls: ["https://cdn.example/promo.png"],
    });
    expect(spec?.contentType).toBe("card");
    const card = spec?.request.types["twilio/card"] as { media: string[]; actions: unknown[] };
    expect(card.media).toEqual(["https://cdn.example/promo.png"]);
    expect(card.actions).toEqual([{ type: "URL", title: "Shop", url: "https://shop.example" }]);
  });

  it("builds a twilio/media template for media without actions", () => {
    const spec = presentationToTwilioContent({
      presentation: { blocks: [{ type: "text", text: "Here you go" }] },
      mediaUrls: ["https://cdn.example/a.png", "ftp://ignored/b.png"],
    });
    expect(spec?.contentType).toBe("media");
    expect(spec?.request.types).toEqual({
      "twilio/media": { body: "Here you go", media: ["https://cdn.example/a.png"] },
    });
  });

  it("carries a durable approval decision as an opaque suggested-reply payload", () => {
    const spec = present({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Approve",
              action: {
                type: "approval",
                approvalId: "ap_1",
                approvalKind: "exec",
                decision: "allow-once",
              },
            },
          ],
        },
      ],
    });
    expect(spec?.contentType).toBe("card");
    expect(expectCardActions(spec)).toEqual([
      { type: "QUICK_REPLY", id: "approval:exec:ap_1:allow-once", title: "Approve" },
    ]);
  });

  it("clamps overlong suggestion labels to the RCS limit", () => {
    const spec = present({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "This label is definitely longer than twenty characters",
              action: { type: "callback", value: "x" },
            },
          ],
        },
      ],
    });
    const actions = expectCardActions(spec) as { title: string }[];
    expect(actions[0]?.title.length).toBe(20);
  });

  it("clamps card body text to Twilio's RCS limit", () => {
    const longBody = "x".repeat(1601);
    const spec = present({
      title: "Long",
      blocks: [
        { type: "text", text: longBody },
        {
          type: "buttons",
          buttons: [{ label: "Ok", action: { type: "callback", value: "ok" } }],
        },
      ],
    });
    expect((expectCard(spec).body as string).length).toBe(1600);
  });

  it("falls back to the payload text when no text block is present", () => {
    const spec = presentationToTwilioContent({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Go", action: { type: "callback", value: "go" } }],
          },
        ],
      },
      fallbackText: "Fallback body",
    });
    expect(expectCard(spec).title).toBe("Fallback body");
  });
});
