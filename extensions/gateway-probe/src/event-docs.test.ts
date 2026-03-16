import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROBE_EVENT_TYPES } from "./types.js";

const DOC_FILES = [
  path.resolve(import.meta.dirname, "..", "README.md"),
  path.resolve(import.meta.dirname, "..", "EVENT_CATALOG.md"),
];

describe("gateway-probe docs", () => {
  it("documents every supported event type", () => {
    const expected = Object.values(PROBE_EVENT_TYPES) as string[];
    const expectedSet = new Set(expected);

    for (const docFile of DOC_FILES) {
      const content = fs.readFileSync(docFile, "utf8");
      const documented = Array.from(
        new Set(
          Array.from(content.matchAll(/`([a-z0-9_.]+)`/g))
            .map((match) => match[1])
            .filter(
              (value): value is string => typeof value === "string" && expectedSet.has(value),
            ),
        ),
      ).sort();

      expect(documented, path.basename(docFile)).toEqual([...expected].sort());
    }
  });
});
