import {
  isStringOption,
  normalizeStringifiedEntries,
  readStringAlias,
  readStringOption,
  readTrimmedStringAlias,
} from "@openclaw/normalization-core/string-coerce";
// Normalization Core tests cover string coerce behavior.
import { describe, expect, it } from "vitest";

describe("normalization-core/string-coerce", () => {
  it("normalizes primitive stringified entries", () => {
    expect(normalizeStringifiedEntries([" a ", 42, true, 0n, "", "  ", null, {}])).toEqual([
      "a",
      "42",
      "true",
      "0",
    ]);
    expect(normalizeStringifiedEntries(undefined)).toEqual([]);
  });

  it("reads caller-owned string options from arrays and sets", () => {
    const modes = ["off", "auto"] as const;
    const states = new Set(["ready", "done"] as const);

    expect(readStringOption("auto", modes)).toBe("auto");
    expect(readStringOption(" AUTO ", modes)).toBeUndefined();
    expect(readStringOption("done", states)).toBe("done");
    expect(readStringOption(1, modes)).toBeUndefined();
    expect(isStringOption("off", modes)).toBe(true);
    expect(isStringOption("on", modes)).toBe(false);
  });

  it("reads aliases with explicit raw and trimmed contracts", () => {
    const record = {
      empty: "",
      spaced: "  value  ",
      fallback: "fallback",
      invalid: 1,
    };

    expect(readStringAlias(record, ["invalid", "empty", "fallback"])).toBe("");
    expect(readStringAlias(record, ["spaced"])).toBe("  value  ");
    expect(readTrimmedStringAlias(record, ["invalid", "empty", "spaced", "fallback"])).toBe(
      "value",
    );
    expect(readTrimmedStringAlias(record, ["invalid", "empty"])).toBeUndefined();
  });
});
