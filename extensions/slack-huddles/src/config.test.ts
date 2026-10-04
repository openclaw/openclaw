import { expect, it } from "vitest";
import { slackHuddlesPlugin } from "../index.js";

it("uses Slack huddle instructions by default", () => {
  expect(slackHuddlesPlugin.config.resolveConfig({}).realtime.instructions).toContain(
    "Slack huddle",
  );
});
