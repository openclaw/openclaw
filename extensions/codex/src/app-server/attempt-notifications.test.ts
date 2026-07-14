// Attempt-notification tests cover Codex app-server envelope parsing and diagnostics.
import { describe, expect, it } from "vitest";
import { describeNotificationActivity } from "./attempt-notifications.js";

describe("describeNotificationActivity", () => {
  it("does not split surrogate pairs in assistant text previews", () => {
    const details = describeNotificationActivity({
      method: "rawResponseItem/completed",
      params: {
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `${"x".repeat(236)}🚀tail` }],
        },
      },
    });

    expect(details?.lastAssistantTextPreview).toBe(`${"x".repeat(236)}...`);
  });
});
