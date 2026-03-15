import { describe, expect, it } from "vitest";
import {
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "./inbound.js";

describe("msteams inbound", () => {
  describe("stripMSTeamsMentionTags", () => {
    it("removes <at>...</at> tags and trims", () => {
      expect(stripMSTeamsMentionTags("<at>Bot</at> hi")).toBe("hi");
      expect(stripMSTeamsMentionTags("hi <at>Bot</at>")).toBe("hi");
    });

    it("removes <at ...> tags with attributes", () => {
      expect(stripMSTeamsMentionTags('<at id="1">Bot</at> hi')).toBe("hi");
      expect(stripMSTeamsMentionTags('hi <at itemid="2">Bot</at>')).toBe("hi");
    });
  });

  describe("normalizeMSTeamsConversationId", () => {
    it("strips the ;messageid suffix", () => {
      expect(normalizeMSTeamsConversationId("19:abc@thread.tacv2;messageid=deadbeef")).toBe(
        "19:abc@thread.tacv2",
      );
    });
  });

  describe("parseMSTeamsActivityTimestamp", () => {
    it("returns undefined for empty/invalid values", () => {
      expect(parseMSTeamsActivityTimestamp(undefined)).toBeUndefined();
      expect(parseMSTeamsActivityTimestamp("not-a-date")).toBeUndefined();
    });

    it("parses string timestamps", () => {
      const ts = parseMSTeamsActivityTimestamp("2024-01-01T00:00:00.000Z");
      expect(ts?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    });

    it("passes through Date instances", () => {
      const d = new Date("2024-01-01T00:00:00.000Z");
      expect(parseMSTeamsActivityTimestamp(d)).toBe(d);
    });
  });

  describe("wasMSTeamsBotMentioned", () => {
    it("returns true when a mention entity matches recipient.id", () => {
      expect(
        wasMSTeamsBotMentioned({
          recipient: { id: "bot" },
          entities: [{ type: "mention", mentioned: { id: "bot" } }],
        }),
      ).toBe(true);
    });

    it("returns false when there is no matching mention", () => {
      expect(
        wasMSTeamsBotMentioned({
          recipient: { id: "bot" },
          entities: [{ type: "mention", mentioned: { id: "other" } }],
        }),
      ).toBe(false);
    });
  });
});
