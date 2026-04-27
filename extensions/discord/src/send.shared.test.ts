import { describe, expect, it } from "vitest";
import { buildDiscordTextChunks, sanitizeDiscordDeliveryText } from "./send.shared.js";

describe("sanitizeDiscordDeliveryText", () => {
  it("strips memory citation blocks and internal announcement scaffolding", () => {
    const input = [
      "Discord announcement to send:",
      "Done.",
      "<oai-mem-citation>",
      "<citation_entries>",
      "memory/foo.md:1-2|note=[internal]",
      "</citation_entries>",
      "</oai-mem-citation>",
    ].join("\n");

    expect(sanitizeDiscordDeliveryText(input)).toBe("Done.");
  });

  it("rewrites cron failures into impact-first copy", () => {
    expect(
      sanitizeDiscordDeliveryText('Cron job "Weekly Audit" failed: cron: job execution timed out'),
    ).toBe(
      [
        "Weekly Audit missed",
        "",
        "Impact",
        "- This scheduled job did not complete.",
        "",
        "What happened",
        "- The job ran too long and timed out before it finished.",
        "",
        "Next",
        "- I kept the raw failure details in logs; inspect or rerun the job when you are ready.",
      ].join("\n"),
    );
  });
});

describe("buildDiscordTextChunks", () => {
  it("coalesces title-only first chunks with the first useful section", () => {
    expect(
      buildDiscordTextChunks("Morning Briefing\n\nOverview\n- One", {
        maxLinesPerMessage: 1,
        chunkMode: "newline",
      }),
    ).toEqual(["Morning Briefing\n\nOverview", "- One"]);
  });

  it("returns no chunks when sanitization removes all text", () => {
    expect(buildDiscordTextChunks("<oai-mem-citation>\nsecret\n</oai-mem-citation>")).toEqual([]);
  });
});
