import { describe, expect, it } from "vitest";
import { formatConfigJson5 } from "./json5-format.ts";

describe("formatConfigJson5", () => {
  it("formats sparse config and computes size metadata", () => {
    const preview = formatConfigJson5({ gateway: { port: 18789 } });
    expect(preview.text).toContain("gateway");
    expect(preview.text).toContain("18789");
    expect(preview.lineCount).toBeGreaterThan(0);
    expect(preview.byteCount).toBeGreaterThan(0);
  });
});
