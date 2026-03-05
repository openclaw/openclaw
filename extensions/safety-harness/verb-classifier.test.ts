import { describe, it, expect } from "vitest";
import { classifyVerb, type VerbCategory } from "./verb-classifier.js";

describe("classifyVerb", () => {
  it.each([
    ["email.get", "read"],
    ["email.list", "read"],
    ["email.search", "read"],
    ["calendar.fetch", "read"],
    ["contacts.query", "read"],
  ])("classifies %s as %s", (toolName, expected) => {
    expect(classifyVerb(toolName)).toBe(expected);
  });

  it.each([
    ["email.send", "write"],
    ["calendar.create", "write"],
    ["contacts.update", "write"],
    ["email.add", "write"],
    ["calendar.set", "write"],
  ])("classifies %s as %s", (toolName, expected) => {
    expect(classifyVerb(toolName)).toBe(expected);
  });

  it.each([
    ["email.delete", "delete"],
    ["contacts.remove", "delete"],
    ["calendar.cancel", "delete"],
    ["email.unsubscribe", "delete"],
    ["contacts.revoke", "delete"],
  ])("classifies %s as %s", (toolName, expected) => {
    expect(classifyVerb(toolName)).toBe(expected);
  });

  it.each([
    ["email.forward", "export"],
    ["contacts.share", "export"],
    ["calendar.transfer", "export"],
    ["contacts.export", "export"],
    ["email.copy-to", "export"],
  ])("classifies %s as %s", (toolName, expected) => {
    expect(classifyVerb(toolName)).toBe(expected);
  });

  it("returns 'unknown' for unrecognized verbs", () => {
    expect(classifyVerb("some.weirdaction")).toBe("unknown");
  });

  it("handles tool names without a dot separator", () => {
    expect(classifyVerb("deleteFile")).toBe("delete");
  });

  it("handles case-insensitive matching", () => {
    expect(classifyVerb("email.DELETE")).toBe("delete");
    expect(classifyVerb("Email.Send")).toBe("write");
  });
});
