import { describe, expect, test } from "vitest";
import { parseShieldPolicy } from "./shield-policy.js";

describe("parseShieldPolicy", () => {
  test("parses valid frontmatter with deny list", () => {
    const content = [
      "---",
      "tools:",
      "  deny:",
      "    - exec",
      "    - browser",
      "---",
      "",
      "# Security Policy",
    ].join("\n");
    const result = parseShieldPolicy(content);
    expect(result).toEqual({ deny: ["exec", "browser"] });
  });

  test("returns undefined for empty content", () => {
    expect(parseShieldPolicy("")).toBeUndefined();
    expect(parseShieldPolicy(undefined)).toBeUndefined();
  });

  test("returns undefined for whitespace-only content", () => {
    expect(parseShieldPolicy("   \n\n  ")).toBeUndefined();
  });

  test("returns undefined for content without frontmatter", () => {
    expect(parseShieldPolicy("# Just a heading\nSome text.")).toBeUndefined();
  });

  test("returns undefined for frontmatter without tools.deny", () => {
    const content = ["---", "title: My Shield", "---", "", "# Policy"].join("\n");
    expect(parseShieldPolicy(content)).toBeUndefined();
  });

  test("returns undefined for empty deny list (deny: [])", () => {
    const content = ["---", "tools:", "  deny: []", "---", "", "# Policy"].join("\n");
    expect(parseShieldPolicy(content)).toBeUndefined();
  });

  test("parses multiple deny entries", () => {
    const content = [
      "---",
      "tools:",
      "  deny:",
      "    - exec",
      "    - browser",
      "    - web_fetch",
      "    - write",
      "---",
    ].join("\n");
    const result = parseShieldPolicy(content);
    expect(result).toEqual({ deny: ["exec", "browser", "web_fetch", "write"] });
  });

  test("handles whitespace around deny entries", () => {
    const content = ["---", "tools:", "  deny:", "    -   exec  ", "    -  browser ", "---"].join(
      "\n",
    );
    const result = parseShieldPolicy(content);
    expect(result).toEqual({ deny: ["exec", "browser"] });
  });

  test("stops parsing deny list at non-list-item line", () => {
    const content = [
      "---",
      "tools:",
      "  deny:",
      "    - exec",
      "  allow:",
      "    - read",
      "---",
    ].join("\n");
    const result = parseShieldPolicy(content);
    expect(result).toEqual({ deny: ["exec"] });
  });

  test("single deny entry", () => {
    const content = ["---", "tools:", "  deny:", "    - exec", "---"].join("\n");
    const result = parseShieldPolicy(content);
    expect(result).toEqual({ deny: ["exec"] });
  });
});
