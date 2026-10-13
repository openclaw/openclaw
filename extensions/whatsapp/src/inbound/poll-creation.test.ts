import type { proto } from "baileys";
import { describe, expect, it } from "vitest";
import { findWhatsAppPollCreation } from "./poll-creation.js";

const poll = { name: "Lunch?", options: [{ optionName: "Pizza" }, { optionName: "Sushi" }] };
const secret = new Uint8Array(32).fill(3);

describe("findWhatsAppPollCreation", () => {
  it.each([
    ["pollCreationMessage", "v1"],
    ["pollCreationMessageV2", "v2"],
    ["pollCreationMessageV3", "v3"],
    ["pollCreationMessageV5", "v5"],
  ] as const)("finds %s", (section, version) => {
    const message = { [section]: poll, messageContextInfo: { messageSecret: secret } };
    expect(findWhatsAppPollCreation(message as proto.IMessage)).toEqual({
      poll,
      version,
      contextInfoLayers: [{ messageSecret: secret }],
    });
  });

  it("unwraps a V4 future-proof poll and keeps both context layers, poll layer first", () => {
    const inner = { messageSecret: new Uint8Array(32).fill(4) };
    const outer = { messageSecret: secret };
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

  it("unwraps an ephemeral poll", () => {
    const match = findWhatsAppPollCreation({
      ephemeralMessage: {
        message: { pollCreationMessage: poll, messageContextInfo: { messageSecret: secret } },
      },
    });
    expect(match?.version).toBe("v1");
    expect(match?.contextInfoLayers).toEqual([{ messageSecret: secret }]);
  });

  it("returns undefined for messages without a poll", () => {
    expect(findWhatsAppPollCreation({ conversation: "hello" })).toBeUndefined();
    expect(findWhatsAppPollCreation(undefined)).toBeUndefined();
    expect(
      findWhatsAppPollCreation({
        pollUpdateMessage: { pollCreationMessageKey: { id: "POLL1" } },
      }),
    ).toBeUndefined();
  });
});
