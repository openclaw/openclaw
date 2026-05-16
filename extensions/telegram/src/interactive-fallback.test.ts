import { describe, expect, it } from "vitest";
import { resolveTelegramInteractiveTextFallback } from "./interactive-fallback.js";

describe("resolveTelegramInteractiveTextFallback presentation fallback (#82404)", () => {
  it("uses presentation text blocks when interactive lacks text", () => {
    const text = resolveTelegramInteractiveTextFallback({
      text: undefined,
      interactive: undefined,
      presentation: {
        title: "Daily Digest",
        blocks: [{ type: "text", text: "Three new tickets need review." }],
      },
    });
    expect(text?.trim()).toBeTruthy();
    expect(text).toContain("Three new tickets");
  });

  it("uses presentation button labels when only buttons are present", () => {
    const text = resolveTelegramInteractiveTextFallback({
      text: undefined,
      interactive: undefined,
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { value: "approve", label: "Approve" },
              { value: "reject", label: "Reject" },
            ],
          },
        ],
      },
    });
    expect(text?.trim()).toBeTruthy();
    expect(text).toContain("Approve");
    expect(text).toContain("Reject");
  });

  it("prefers top-level text when both text and presentation are present", () => {
    const text = resolveTelegramInteractiveTextFallback({
      text: "Top level wins",
      interactive: undefined,
      presentation: {
        blocks: [{ type: "text", text: "Should be ignored" }],
      },
    });
    expect(text).toBe("Top level wins");
  });

  it("returns undefined when there is genuinely no content anywhere", () => {
    const text = resolveTelegramInteractiveTextFallback({
      text: undefined,
      interactive: undefined,
      presentation: undefined,
    });
    expect(text).toBeUndefined();
  });
});
