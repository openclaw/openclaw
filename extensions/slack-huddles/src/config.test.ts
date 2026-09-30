import { expect, it } from "vitest";
import { slackHuddlesPlugin } from "../index.js";

it("defaults to agent mode and automatic Chrome joining without selecting a node", () => {
  const config = slackHuddlesPlugin.config.resolveConfig({});
  expect(config.defaultMode).toBe("agent");
  expect(config.chrome).toMatchObject({
    autoJoin: true,
    reuseExistingTab: true,
    audioBackend: "auto",
    audioFormat: "pcm16-24khz",
  });
  expect(config.chromeNode.node).toBeUndefined();
  expect(config.realtime.instructions).toContain("Slack huddle");
});
