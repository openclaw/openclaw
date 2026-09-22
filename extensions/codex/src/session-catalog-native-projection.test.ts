import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
import { projectCodexCatalogNativeThread } from "./session-catalog-native-projection.js";

const LONE_SURROGATE = /[\uD800-\uDFFF]/;

/** The catalog rows cross worker and gateway WebSocket transports as UTF-8 JSON. */
function survivesUtf8Transport(value: string): boolean {
  return new TextDecoder().decode(new TextEncoder().encode(value)) === value;
}

describe("projectCodexCatalogNativeThread string bounds", () => {
  it("drops a surrogate pair split by the originator bound instead of emitting a lone surrogate", () => {
    const row = projectCodexCatalogNativeThread(
      { id: "t1", originator: `${"s".repeat(499)}🙂` },
      sanitizeTerminalText,
    );
    expect(row.originator).toBe("s".repeat(499));
    expect(row.originator).not.toMatch(LONE_SURROGATE);
    expect(row.originator && survivesUtf8Transport(row.originator)).toBe(true);
  });

  it("preserves exact originator identity when no truncation is needed", () => {
    const originator = "openclaw 🙂 integration";
    const row = projectCodexCatalogNativeThread({ id: "t1", originator }, sanitizeTerminalText);
    expect(row.originator).toBe(originator);
  });

  it("keeps an originator of exactly 500 code units with a complete trailing pair", () => {
    const originator = `${"s".repeat(498)}🙂`;
    expect(originator).toHaveLength(500);
    const row = projectCodexCatalogNativeThread({ id: "t1", originator }, sanitizeTerminalText);
    expect(row.originator).toBe(originator);
  });

  it("bounds a long source string without admitting a corrupted value", () => {
    const row = projectCodexCatalogNativeThread(
      { id: "t1", source: `${"s".repeat(499)}🙂tail` },
      sanitizeTerminalText,
    );
    expect(row.source).toBeUndefined();
  });

  it("preserves a whitelisted short source exactly", () => {
    const row = projectCodexCatalogNativeThread(
      { id: "t1", source: "appServer" },
      sanitizeTerminalText,
    );
    expect(row.source).toBe("appServer");
  });
});
