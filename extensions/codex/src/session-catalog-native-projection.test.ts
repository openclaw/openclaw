import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
import { projectCodexCatalogNativeThread } from "./session-catalog-native-projection.js";

describe("projectCodexCatalogNativeThread string bounds", () => {
  it("drops a surrogate pair split by the originator bound", () => {
    const row = projectCodexCatalogNativeThread(
      { id: "t1", originator: `${"s".repeat(499)}🙂` },
      sanitizeTerminalText,
    );
    expect(row.originator).toBe("s".repeat(499));
  });

  it("admits a custom source with a complete surrogate pair at its bound", () => {
    const custom = `${"s".repeat(498)}🙂`;
    const row = projectCodexCatalogNativeThread(
      { id: "t1", source: { custom } },
      sanitizeTerminalText,
    );
    expect(row.source).toEqual({ custom });
  });
});
