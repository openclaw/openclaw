import { describe, expect, it } from "vitest";
import { prepareZalouserReplyTables, sanitizeZalouserReplyPayload } from "./reply-text.js";

describe("Zalouser reply text lifecycle", () => {
  it("prepares configured tables before durable delivery can bypass the custom monitor", () => {
    expect(prepareZalouserReplyTables({ text: "| A |\n| --- |\n| x |" }, "bullets")).toEqual({
      text: "• A: x",
    });
  });

  it("sanitizes hook-rewritten payloads at the custom delivery boundary", () => {
    expect(
      sanitizeZalouserReplyPayload({
        text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
      }),
    ).toEqual({ text: "Done." });
  });
});
