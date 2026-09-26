import { describe, expect, it } from "vitest";
import { extractJsonMessage, formatChromeMcpToolErrorMessage } from "./chrome-mcp-result.js";

describe("Chrome MCP result formats", () => {
  it.each([
    ["text", "fenced", 123],
    ["text", "fenced", "literal ``` inside text"],
    ["structured", "fenced", { text: '```json\n{"ok":true}\n```' }],
    ["text", "crlf", ["first", "```", "last"]],
    ["structured", "fenced", ""],
    ["text", "fenced", undefined],
    ["structured", "fenced", undefined],
    ["text", "raw", "```json\nnot a wrapper\n```"],
    ["text", "trailing-fence", "preserved ``` text"],
    ["structured", "fenced", "Example:\n```js\nconst value = 1;\n```"],
  ] as const)("preserves %s %s JSON result %j", (surface, format, value) => {
    const json = value === undefined ? "undefined" : JSON.stringify(value);
    const message =
      format === "raw"
        ? json
        : [
            "Script ran on page and returned:",
            "```json",
            json,
            "```",
            ...(format === "trailing-fence" ? ["Diagnostic:", "```txt", "extra", "```"] : []),
          ].join(format === "crlf" ? "\r\n" : "\n");
    const result = extractJsonMessage({
      ...(surface === "structured" ? { structuredContent: { message } } : {}),
      content: [{ type: "text", text: message }],
    });

    expect(result).toEqual(value);
  });

  it("suggests cdpUrl when auto-connect cannot read DevToolsActivePort", () => {
    expect(
      formatChromeMcpToolErrorMessage({
        profileName: "chrome-live",
        options: { command: "npx", args: [], userDataDir: "/tmp/chrome-profile" },
        toolName: "list_pages",
        message:
          "Could not connect to Chrome in /tmp/chrome-profile. Cause: ENOENT: no such file or directory, open '/tmp/chrome-profile/DevToolsActivePort'",
      }),
    ).toMatch(/set browser\.profiles\.chrome-live\.cdpUrl/);
  });
});
