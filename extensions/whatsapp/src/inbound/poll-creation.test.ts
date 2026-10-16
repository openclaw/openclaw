import { describe, expect, it } from "vitest";
import { findWhatsAppPollCreation } from "./poll-creation.js";

const poll = { name: "Lunch?", options: [{ optionName: "Pizza" }, { optionName: "Sushi" }] };

// Section and wrapper coverage lives in poll-creation-record.test.ts; this pins layer order only.
describe("findWhatsAppPollCreation", () => {
  it("unwraps a V4 future-proof poll and keeps both context layers, poll layer first", () => {
    const inner = { messageSecret: new Uint8Array(32).fill(4) };
    const outer = { messageSecret: new Uint8Array(32).fill(3) };
    const match = findWhatsAppPollCreation({
      messageContextInfo: outer,
      pollCreationMessageV4: {
        message: { pollCreationMessageV3: poll, messageContextInfo: inner },
      },
    });
    expect(match?.version).toBe("v4");
    expect(match?.poll).toEqual(poll);
    expect(match?.contextInfoLayers).toEqual([inner, outer]);
  });
});
