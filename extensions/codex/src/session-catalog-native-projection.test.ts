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

  it.each([
    ["native service", "openclaw"],
    ["untrimmed identity", " openclaw "],
    ["short emoji", "openclaw 🙂 integration"],
    ["complete pair at 500 code units", `${"s".repeat(498)}🙂`],
  ])("preserves the exact originator for %s", (_label, originator) => {
    const row = projectCodexCatalogNativeThread({ id: "t1", originator }, sanitizeTerminalText);
    expect(row.originator).toBe(originator);
  });

  it("omits an oversized source outside the native enum", () => {
    const row = projectCodexCatalogNativeThread(
      { id: "t1", source: `${"s".repeat(499)}🙂tail` },
      sanitizeTerminalText,
    );
    expect(row.source).toBeUndefined();
  });

  it.each(["cli", "vscode", "exec", "appServer", "unknown"])(
    "preserves the native source %s",
    (source) => {
      const row = projectCodexCatalogNativeThread({ id: "t1", source }, sanitizeTerminalText);
      expect(row.source).toBe(source);
    },
  );

  it.each([
    ["complete pair at the bound", `${"s".repeat(498)}🙂`, true],
    ["overflowing pair", `${"s".repeat(499)}🙂`, false],
  ])("admits a custom source only within its bound: %s", (_label, custom, admitted) => {
    const row = projectCodexCatalogNativeThread(
      { id: "t1", source: { custom } },
      sanitizeTerminalText,
    );
    expect(row.source).toEqual(admitted ? { custom } : undefined);
  });
});
