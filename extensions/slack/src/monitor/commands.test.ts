import { expect, it } from "vitest";
import { stripSlackMentionsForCommandDetection } from "./commands.js";

it("keeps the line breaks and indentation of a slash command body", () => {
  expect(
    stripSlackMentionsForCommandDetection("<@B1> /btw why does this fail?\n  at first (a.ts:1)"),
  ).toBe("/btw why does this fail?\n  at first (a.ts:1)");
});
