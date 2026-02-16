import { describe, it, expect } from "vitest";
import { _checkBotMentioned as checkBotMentioned } from "./bot.js";

describe("checkBotMentioned", () => {
  // Case 1: Missing robotName should return false
  it("returns false when robotName is undefined", () => {
    const bodyItems = [{ type: "AT", name: "TestBot" }];
    expect(checkBotMentioned(bodyItems, undefined)).toBe(false);
  });

  it("returns false when robotName is empty string", () => {
    const bodyItems = [{ type: "AT", name: "TestBot" }];
    expect(checkBotMentioned(bodyItems, "")).toBe(false);
  });

  // Case 2: Empty body array should return false
  it("returns false when body array is empty", () => {
    expect(checkBotMentioned([], "TestBot")).toBe(false);
  });

  // Case 3: Case-insensitive matching
  it("matches robotName case-insensitively (lowercase input)", () => {
    const bodyItems = [{ type: "AT", name: "testbot" }];
    expect(checkBotMentioned(bodyItems, "TestBot")).toBe(true);
  });

  it("matches robotName case-insensitively (uppercase input)", () => {
    const bodyItems = [{ type: "AT", name: "TESTBOT" }];
    expect(checkBotMentioned(bodyItems, "TestBot")).toBe(true);
  });

  it("matches robotName case-insensitively (mixed case)", () => {
    const bodyItems = [{ type: "AT", name: "TeStBoT" }];
    expect(checkBotMentioned(bodyItems, "testbot")).toBe(true);
  });

  // Case 4: Exact match
  it("returns true for exact name match", () => {
    const bodyItems = [{ type: "AT", name: "MyBot" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(true);
  });

  // Case 5: No match
  it("returns false when AT name does not match robotName", () => {
    const bodyItems = [{ type: "AT", name: "OtherBot" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  // Case 6: Multiple items in body
  it("returns true when one of multiple items matches", () => {
    const bodyItems = [
      { type: "TEXT", content: "Hello" },
      { type: "AT", name: "OtherUser" },
      { type: "AT", name: "MyBot" },
      { type: "TEXT", content: "world" },
    ];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(true);
  });

  it("returns false when no AT items match in multiple items", () => {
    const bodyItems = [
      { type: "TEXT", content: "Hello" },
      { type: "AT", name: "OtherUser" },
      { type: "LINK", label: "example.com" },
    ];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  // Case 7: AT item without name field
  it("returns false when AT item has no name", () => {
    const bodyItems = [{ type: "AT", robotid: 123 }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  it("returns false when AT item has empty name", () => {
    const bodyItems = [{ type: "AT", name: "" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  // Case 8: Non-AT types should be ignored
  it("ignores TEXT type items", () => {
    const bodyItems = [{ type: "TEXT", content: "MyBot" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  it("ignores LINK type items", () => {
    const bodyItems = [{ type: "LINK", label: "MyBot" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  // Case 9: Partial match should not count
  it("returns false for partial name match", () => {
    const bodyItems = [{ type: "AT", name: "MyBotHelper" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  it("returns false when robotName is substring of AT name", () => {
    const bodyItems = [{ type: "AT", name: "Bot" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });
});
