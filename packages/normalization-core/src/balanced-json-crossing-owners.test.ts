import { describe, expect, it } from "vitest";
import { measureJsonWork } from "./balanced-json-work.test-support.js";
import { extractBalancedJsonFragments } from "./balanced-json.js";

describe("crossing JSON owners", () => {
  it("preserves crossing owner quotes until their own original endpoint", () => {
    for (const tail of ["tail", String.raw`escaped \" quote`, String.raw`escaped \\ slash`]) {
      const second = `{":1}${tail}":true}`;
      const source = `["{",${second}]`;
      const endIndex = source.length - 2;
      const outsideQuote = source.lastIndexOf('"') + 1;
      const records = [
        { json: '{",{":1}', startIndex: 2, endIndex: 9 },
        { json: second, startIndex: 5, endIndex },
      ];
      for (const record of records) {
        expect(() => JSON.parse(record.json)).not.toThrow();
      }
      for (const raw of [source, source.replaceAll('"', " ")]) {
        for (const recoverAtLineStart of [false, true]) {
          const options = { openers: ["{"] as const, recoverAtLineStart };
          for (const startIndex of [10, outsideQuote]) {
            const opaqueSpans = [
              { startIndex: 1, endIndex: 1 },
              { startIndex: 3, endIndex: 3 },
              { startIndex, endIndex },
            ];
            expect(
              extractBalancedJsonFragments(raw, {
                ...options,
                strictJson: { source, opaqueSpans },
              }),
            ).toEqual(startIndex === 10 ? records : [records[0]]);
          }
          expect(extractBalancedJsonFragments(raw, { ...options, strictJson: { source } })).toEqual(
            [records[1]],
          );
          expect(
            extractBalancedJsonFragments(raw, { recoverAtLineStart, strictJson: { source } }),
          ).toEqual([{ json: source, startIndex: 0, endIndex: source.length - 1 }]);
        }
      }
      expect(extractBalancedJsonFragments(source)).toEqual([
        { json: source, startIndex: 0, endIndex: source.length - 1 },
      ]);
    }
  });

  it("bounds retirement while entire crossing owner chains remain live", () => {
    for (const depth of [32, 128, 512]) {
      for (const malformed of [0, depth]) {
        const opens = "[".repeat(depth);
        const closes = "]".repeat(depth);
        const dangling = "{".repeat(malformed);
        const body = `${opens}"${dangling}${opens}"${closes}tail"${closes}`;
        const source = body + "\n[0]";
        const first = opens + JSON.stringify(dangling + opens) + closes;
        const second = opens + JSON.stringify(closes + "tail") + closes;
        expect(() => JSON.parse(first)).not.toThrow();
        expect(() => JSON.parse(second)).not.toThrow();
        for (const raw of [source, source.replaceAll('"', " ")]) {
          for (const recoverAtLineStart of [false, true]) {
            for (const insideQuote of [false, true]) {
              const { result, visits, parsedUnits, copiedUnits } = measureJsonWork(() =>
                extractBalancedJsonFragments(raw, {
                  openers: ["["],
                  recoverAtLineStart,
                  strictJson: {
                    source,
                    opaqueSpans: [
                      { startIndex: depth, endIndex: depth },
                      {
                        startIndex: 3 * depth + malformed + (insideQuote ? 2 : 7),
                        endIndex: body.length - 1,
                      },
                    ],
                  },
                }),
              );
              expect(result).toEqual([
                { json: first, startIndex: 0, endIndex: 3 * depth + malformed + 1 },
                ...(insideQuote
                  ? [{ json: second, startIndex: depth + malformed + 1, endIndex: body.length - 1 }]
                  : []),
                { json: "[0]", startIndex: body.length + 1, endIndex: body.length + 3 },
              ]);
              expect(visits).toBeLessThanOrEqual(32 * source.length);
              expect(parsedUnits).toBeLessThanOrEqual(
                2 * source.length + 2 * (2 * depth + malformed + 1),
              );
              expect(copiedUnits).toBeLessThanOrEqual(3 * source.length);
            }
          }
        }
      }
    }
  });
});
