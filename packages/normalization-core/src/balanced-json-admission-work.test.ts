import { describe, expect, it, vi } from "vitest";
import { extractBalancedJsonFragments } from "./balanced-json.js";

describe("balanced JSON extraction", () => {
  const strictRecovery = { strictJson: true, recoverAtLineStart: true } as const;

  it("bounds aggregate original-source admission when framing exposes nested string interiors", () => {
    for (const depth of [256, 1024, 4096]) {
      for (const ending of ['"]'.repeat(depth), '"]'.repeat(depth - 1), "}".repeat(depth)]) {
        const source = '[{},"'.repeat(depth) + ending;
        const discovery = source.replaceAll('"', " ");
        const opaqueSpans = Array.from(source.matchAll(/"/g), ({ index }) => ({
          startIndex: index,
          endIndex: index,
        }));
        const openers = Array.from(source.matchAll(/[{\[]/g)).length;
        const parse = JSON.parse;
        const slice = String.prototype.slice;
        const push = Array.prototype.push;
        let parsedUnits = 0;
        let copiedUnits = 0;
        let calls = 0;
        let nodeEdges = 0;
        const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
          parsedUnits += String(text).length;
          calls++;
          return parse(text, reviver);
        });
        String.prototype.slice = function (this: string, start, end) {
          const result = Reflect.apply(slice, this, [start, end]);
          copiedUnits += result.length;
          return result;
        };
        Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
          for (const item of items) {
            if (item && typeof item === "object" && "children" in item && "start" in item) {
              nodeEdges++;
            }
          }
          return Reflect.apply(push, this, items);
        };
        let result: ReturnType<typeof extractBalancedJsonFragments>;
        try {
          result = extractBalancedJsonFragments(discovery, {
            ...strictRecovery,
            strictJson: { source, opaqueSpans },
          });
        } finally {
          String.prototype.slice = slice;
          Array.prototype.push = push;
          spy.mockRestore();
        }
        expect(result).toEqual([]);
        expect(calls).toBeLessThanOrEqual(openers);
        expect(parsedUnits).toBeLessThanOrEqual(2 * source.length + 2 * openers);
        expect(copiedUnits).toBeLessThanOrEqual(2 * source.length);
        // Admission forests, discovery ownership and final selection each visit
        // a container a bounded number of times, including rejected ancestors.
        expect(nodeEdges).toBeLessThanOrEqual(6 * openers);
      }
    }
  });
});
