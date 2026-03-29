import { describe, expect, it } from "vitest";
import { parseInteractiveCardPayload } from "./interactive-card.js";

describe("parseInteractiveCardPayload", () => {
  it("falls back to raw_card_content when card is a non-JSON string", () => {
    const payload = JSON.stringify({
      card: "[Interactive Card]",
      raw_card_content: {
        header: { title: { content: "Weekly Report" } },
        body: {
          elements: [{ tag: "div", text: { content: "Finished A" } }],
        },
      },
    });

    const parsed = parseInteractiveCardPayload(payload);
    expect(parsed.text).toBe("Weekly Report\nFinished A");
    expect(parsed.rawCardJson).toBe(
      JSON.stringify({
        header: { title: { content: "Weekly Report" } },
        body: {
          elements: [{ tag: "div", text: { content: "Finished A" } }],
        },
      }),
    );
  });

  it("ignores malformed i18n_elements.zh_cn object values without throwing", () => {
    const payload = JSON.stringify({
      header: { title: { content: "Title" } },
      i18n_elements: {
        zh_cn: { invalid: true },
      },
      body: {
        elements: [{ tag: "markdown", content: "Body" }],
      },
    });

    const parsed = parseInteractiveCardPayload(payload);
    expect(parsed.text).toBe("Title\nBody");
  });

  it("caps recursive parsing depth to avoid stack overflow on deeply nested cards", () => {
    let nested: Record<string, unknown> = { tag: "div", text: { content: "leaf" } };
    for (let i = 0; i < 100; i++) {
      nested = { tag: "div", elements: [nested] };
    }
    const payload = JSON.stringify({ body: { elements: [nested] } });

    const parsed = parseInteractiveCardPayload(payload);
    expect(parsed.text).toBe("[Interactive Card]");
  });
});

