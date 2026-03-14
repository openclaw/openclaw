import { describe, expect, it } from "vitest";
import { parseCliJson } from "./cli-runner/helpers.js";

describe("parseCliJson", () => {
  it("keeps all assistant text blocks from message.content even when message.text is present", () => {
    const payload = {
      message: {
        text: "Done! Saved the fix.",
        content: [
          { type: "text", text: "Let me investigate the logs...\n" },
          {
            type: "tool_use",
            id: "call-1",
            name: "bash",
            input: { command: "tail -n 200 app.log" },
          },
          { type: "text", text: "Found the issue! Here's what happened...\n" },
          { type: "tool_use", id: "call-2", name: "edit", input: { path: "src/app.ts" } },
          { type: "text", text: "Done! Saved the fix." },
        ],
      },
    };

    const parsed = parseCliJson(JSON.stringify(payload), { command: "claude" });

    expect(parsed).not.toBeNull();
    expect(parsed?.text).toContain("Let me investigate the logs...");
    expect(parsed?.text).toContain("Found the issue! Here's what happened...");
    expect(parsed?.text).toContain("Done! Saved the fix.");
  });

  it("falls back to message.text when no structured content blocks exist", () => {
    const payload = {
      message: {
        text: "Single-block response",
      },
    };

    const parsed = parseCliJson(JSON.stringify(payload), { command: "claude" });
    expect(parsed?.text).toBe("Single-block response");
  });
});
