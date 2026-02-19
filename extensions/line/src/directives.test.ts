import { describe, it, expect } from "vitest";
import { parseLineDirectives } from "./directives.js";

describe("parseLineDirectives", () => {
  describe("quick_replies", () => {
    it("parses simple quick replies", () => {
      const result = parseLineDirectives("Choose an option: [[quick_replies: Yes, No, Maybe]]");
      expect(result.lineData.quickReplies).toEqual(["Yes", "No", "Maybe"]);
      expect(result.text).toBe("Choose an option:");
    });

    it("handles whitespace in options", () => {
      const result = parseLineDirectives(
        "[[quick_replies:   Option A  ,  Option B  ,  Option C  ]]",
      );
      expect(result.lineData.quickReplies).toEqual(["Option A", "Option B", "Option C"]);
    });

    it("handles multiline text", () => {
      const result = parseLineDirectives("Here's your message.\n\n[[quick_replies: OK, Cancel]]");
      expect(result.lineData.quickReplies).toEqual(["OK", "Cancel"]);
      expect(result.text).toBe("Here's your message.");
    });

    it("is case-insensitive", () => {
      const result = parseLineDirectives("[[QUICK_REPLIES: A, B]]");
      expect(result.lineData.quickReplies).toEqual(["A", "B"]);
    });
  });

  describe("location", () => {
    it("parses location with all fields", () => {
      const result = parseLineDirectives(
        "[[location: Tokyo Tower | 4-2-8 Shibakoen, Tokyo | 35.6586 | 139.7454]]",
      );
      expect(result.lineData.location).toEqual({
        title: "Tokyo Tower",
        address: "4-2-8 Shibakoen, Tokyo",
        latitude: 35.6586,
        longitude: 139.7454,
      });
      expect(result.text).toBe("");
    });

    it("handles negative coordinates", () => {
      const result = parseLineDirectives(
        "[[location: Sydney | NSW, Australia | -33.8688 | 151.2093]]",
      );
      expect(result.lineData.location?.latitude).toBe(-33.8688);
      expect(result.lineData.location?.longitude).toBe(151.2093);
    });

    it("handles no match for malformed location", () => {
      const result = parseLineDirectives("[[location: Title | Address | invalid | coords]]");
      // Should not match due to invalid lat/long (not numbers)
      expect(result.lineData.location).toBeUndefined();
    });
  });

  describe("confirm", () => {
    it("parses confirm dialog", () => {
      const result = parseLineDirectives("[[confirm: Are you sure? | Yes, do it | No, cancel]]");
      expect(result.lineData.templateMessage).toEqual({
        type: "confirm",
        text: "Are you sure?",
        confirmLabel: "Yes, do it",
        confirmData: "yes",
        cancelLabel: "No, cancel",
        cancelData: "no",
        altText: "Are you sure?",
      });
    });

    it("handles question mark and special chars", () => {
      const result = parseLineDirectives("[[confirm: Delete this file? 🗑️ | Delete | Keep]]");
      expect(result.lineData.templateMessage?.text).toBe("Delete this file? 🗑️");
    });
  });

  describe("buttons", () => {
    it("parses buttons with postback actions", () => {
      const result = parseLineDirectives(
        "[[buttons: Menu | Choose an action | Start:start, Stop:stop, Reset:reset]]",
      );
      expect(result.lineData.templateMessage).toEqual({
        type: "buttons",
        title: "Menu",
        text: "Choose an action",
        actions: [
          { type: "postback", label: "Start", data: "start" },
          { type: "postback", label: "Stop", data: "stop" },
          { type: "postback", label: "Reset", data: "reset" },
        ],
        altText: "Menu",
      });
    });

    it("parses buttons with URI actions", () => {
      const result = parseLineDirectives(
        "[[buttons: Links | Click to visit | Website:https://example.com, Docs:https://docs.example.com]]",
      );
      expect(result.lineData.templateMessage?.actions).toEqual([
        { type: "uri", label: "Website", uri: "https://example.com" },
        { type: "uri", label: "Docs", uri: "https://docs.example.com" },
      ]);
    });

    it("handles mixed postback and URI actions", () => {
      const result = parseLineDirectives(
        "[[buttons: Actions | What to do? | Open:https://url.com, Refresh:refresh]]",
      );
      expect(result.lineData.templateMessage?.actions).toEqual([
        { type: "uri", label: "Open", uri: "https://url.com" },
        { type: "postback", label: "Refresh", data: "refresh" },
      ]);
    });
  });

  describe("combined directives", () => {
    it("handles text without directives", () => {
      const result = parseLineDirectives("Just a plain message.");
      expect(result.text).toBe("Just a plain message.");
      expect(result.lineData).toEqual({});
    });

    it("handles empty string", () => {
      const result = parseLineDirectives("");
      expect(result.text).toBe("");
      expect(result.lineData).toEqual({});
    });

    it("extracts only one directive type (first match wins for templateMessage)", () => {
      // Both confirm and buttons set templateMessage, so last one wins
      const result = parseLineDirectives(
        "[[confirm: Sure? | Yes | No]] [[buttons: Menu | Text | A:1, B:2]]",
      );
      // buttons comes after confirm, so buttons wins for templateMessage
      expect(result.lineData.templateMessage?.type).toBe("buttons");
      // But quickReplies would still be there if included
    });

    it("handles quick_replies with location (both can coexist)", () => {
      const result = parseLineDirectives(
        "Meet me here: [[location: Cafe | 123 St | 35.0 | 139.0]] [[quick_replies: OK, See you]]",
      );
      expect(result.lineData.quickReplies).toEqual(["OK", "See you"]);
      expect(result.lineData.location).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("handles multiple spaces and newlines", () => {
      const result = parseLineDirectives("  Hello!   \n\n  [[quick_replies: A, B]]  \n  ");
      expect(result.lineData.quickReplies).toEqual(["A", "B"]);
      expect(result.text).toBe("Hello!");
    });

    it("does not parse malformed directive", () => {
      const result = parseLineDirectives("[[quick_replies missing colon]]");
      expect(result.lineData.quickReplies).toBeUndefined();
      expect(result.text).toContain("[[quick_replies missing colon]]");
    });

    it("does not parse unclosed directive", () => {
      const result = parseLineDirectives("[[quick_replies: A, B");
      expect(result.lineData.quickReplies).toBeUndefined();
    });
  });
});
