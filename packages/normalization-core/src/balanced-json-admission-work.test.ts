import { describe, expect, it, vi } from "vitest";
import { extractBalancedJsonFragments } from "./balanced-json.js";

describe("balanced JSON extraction", () => {
  const strictRecovery = { strictJson: true, recoverAtLineStart: true } as const;

  it("retires indexed owners only at visible original endpoints across artificial descendants", () => {
    for (const source of [
      '["]"]',
      '[" ] ",{}]',
      '{"x":"}","ok":true}',
      '[{"x":"]","ok":true}]',
      '["[",{}]',
      '["{",{}]',
      '{"x":"[","child":{"ok":true}}',
    ]) {
      const opaqueSpans = Array.from(source.matchAll(/"/g), ({ index }) => ({
        startIndex: index,
        endIndex: index,
      }));
      for (const raw of [source, source.replaceAll('"', " ")]) {
        for (const recoverAtLineStart of [false, true]) {
          expect(
            extractBalancedJsonFragments(raw, {
              recoverAtLineStart,
              strictJson: { source, opaqueSpans },
            }),
          ).toEqual([{ json: source, startIndex: 0, endIndex: source.length - 1 }]);
        }
      }
    }
    const source = '["text"]';
    expect(
      extractBalancedJsonFragments(source, {
        ...strictRecovery,
        strictJson: { source, opaqueSpans: [{ startIndex: 1, endIndex: 1 }] },
      }),
    ).toEqual([{ json: source, startIndex: 0, endIndex: source.length - 1 }]);
    // This span starts at the original closing quote, so string ownership
    // ignores the whole span even though it extends across the endpoint.
    expect(
      extractBalancedJsonFragments('["]"]', {
        ...strictRecovery,
        strictJson: {
          source: '["]"]',
          opaqueSpans: [
            { startIndex: 1, endIndex: 1 },
            { startIndex: 3, endIndex: 4 },
          ],
        },
      }),
    ).toEqual([{ json: '["]"]', startIndex: 0, endIndex: 4 }]);
  });

  it("keeps crossing indexed candidates independent of filtered discovery ancestors", () => {
    const parent = '["[",{"]":1}]';
    const child = '{"]":1}';
    const suffix = '{"after":true}';
    for (const separator of ["", "\n", "\r\n", "\r"]) {
      const source = parent + separator + suffix;
      const opaqueSpans = [
        { startIndex: 1, endIndex: 1 },
        { startIndex: 3, endIndex: 3 },
      ];
      for (const raw of [source, source.replaceAll('"', " ")]) {
        for (const recoverAtLineStart of [false, true]) {
          const options = { recoverAtLineStart, strictJson: { source, opaqueSpans } };
          const fragment = (json: string) => ({
            json,
            startIndex: source.indexOf(json),
            endIndex: source.indexOf(json) + json.length - 1,
          });
          expect(extractBalancedJsonFragments(raw, { ...options, openers: ["{"] })).toEqual([
            fragment(child),
            fragment(suffix),
          ]);
          expect(extractBalancedJsonFragments(raw, options)).toEqual([
            fragment(parent),
            fragment(suffix),
          ]);
        }
      }
    }
  });

  it("uses original string ownership for opaque entry after hidden opening quotes", () => {
    for (const text of ["text", "]", 'escaped \" quote']) {
      const parent = `[${JSON.stringify(text)}]`;
      const suffix = '{"after":true}';
      const source = parent + "] " + suffix;
      const endpoint = parent.length - 1;
      const opaqueSpans = [
        { startIndex: 1, endIndex: 1 },
        { startIndex: endpoint, endIndex: endpoint },
      ];
      for (const raw of [source, source.replaceAll('"', " ")]) {
        for (const recoverAtLineStart of [false, true]) {
          expect(
            extractBalancedJsonFragments(raw, {
              recoverAtLineStart,
              strictJson: { source, opaqueSpans },
            }),
          ).toEqual([
            {
              json: suffix,
              startIndex: parent.length + 2,
              endIndex: source.length - 1,
            },
          ]);
        }
      }
    }
  });

  it("releases expired indexed protection after a hidden endpoint without admitting its owner", () => {
    for (const prefix of ["{}}", "[]]"]) {
      for (const separator of ["", "\n", "\r\n", "\r"]) {
        const first = '{"first":1}';
        const second = '{"second":2}';
        const source = `${prefix}${separator}${first} ${second}`;
        const expected = [first, second].map((json) => ({
          json,
          startIndex: source.indexOf(json),
          endIndex: source.indexOf(json) + json.length - 1,
        }));
        for (const raw of [source, `${source[0]} ${source.slice(2)}`]) {
          for (const recoverAtLineStart of [false, true]) {
            expect(
              extractBalancedJsonFragments(raw, {
                recoverAtLineStart,
                strictJson: {
                  source,
                  opaqueSpans: [{ startIndex: 1, endIndex: 1 }],
                },
              }),
            ).toEqual(expected);
          }
        }
      }
    }
  });

  it("separates original lexical owners from crossing emission candidates", () => {
    const cases = [
      { source: '["{",{}]', quotes: [1, 3], intervals: [[5, 6]] },
      {
        source: '["{",{":1}":true}]',
        quotes: [1, 3],
        intervals: [
          [2, 9],
          [5, 16],
        ],
      },
      {
        source: '["{",{":0}":1}]',
        quotes: [1],
        intervals: [
          [2, 9],
          [5, 13],
        ],
      },
      { source: '["[","]{}"]', quotes: [1], intervals: [] },
    ];
    for (const { source, quotes, intervals } of cases) {
      const opaqueSpans = quotes.map((index) => ({ startIndex: index, endIndex: index }));
      for (const raw of [source, source.replaceAll('"', " ")]) {
        for (const recoverAtLineStart of [false, true]) {
          expect(
            extractBalancedJsonFragments(raw, {
              openers: ["{"],
              recoverAtLineStart,
              strictJson: { source, opaqueSpans },
            }),
          ).toEqual(
            intervals.map(([startIndex, endIndex]) => ({
              json: source.slice(startIndex!, endIndex! + 1),
              startIndex,
              endIndex,
            })),
          );
        }
      }
    }
  });

  it("retains original string entry ownership for malformed and hidden containers", () => {
    const suffix = '{"after":true}';
    for (const newline of ["\n", "\r\n", "\r"]) {
      for (const prefix of ['["text",]', `["line one${newline}line two"]`]) {
        const source = prefix + newline + suffix;
        const opaqueSpans = [
          { startIndex: 1, endIndex: 1 },
          { startIndex: 3, endIndex: source.length - 1 },
        ];
        for (const raw of [source, source.replaceAll('"', " ")]) {
          for (const recoverAtLineStart of [false, true]) {
            expect(
              extractBalancedJsonFragments(raw, {
                recoverAtLineStart,
                strictJson: { source, opaqueSpans },
              }),
            ).toEqual([
              {
                json: suffix,
                startIndex: prefix.length + newline.length,
                endIndex: source.length - 1,
              },
            ]);
          }
        }
      }
    }
    const source = '["text"]{}';
    for (const recoverAtLineStart of [false, true]) {
      expect(
        extractBalancedJsonFragments(source, {
          recoverAtLineStart,
          strictJson: {
            source,
            opaqueSpans: [
              { startIndex: 0, endIndex: 1 },
              { startIndex: 2, endIndex: source.length - 1 },
            ],
          },
        }),
      ).toEqual([{ json: "{}", startIndex: 8, endIndex: 9 }]);
    }
  });

  it("retires hidden endpoints before adjacent records or multiline prose quotes", () => {
    const suffix = '{"after":true}';
    for (const parent of ["[]", "{}"]) {
      for (const separator of [" ", "\n", "\r\n", "\r"]) {
        for (const prose of ["", '\"line one\n[0] line two\" ']) {
          const source = parent + separator + prose + suffix;
          for (const recoverAtLineStart of [false, true]) {
            expect(
              extractBalancedJsonFragments(source, {
                recoverAtLineStart,
                strictJson: { source, opaqueSpans: [{ startIndex: 1, endIndex: 1 }] },
              }),
            ).toEqual([
              {
                json: suffix,
                startIndex: source.length - suffix.length,
                endIndex: source.length - 1,
              },
            ]);
          }
        }
      }
    }
  });

  it("bounds indexed retirement work when artificial descendants cross the original endpoint", () => {
    for (const depth of [256, 1024, 4096]) {
      const parent = `[${JSON.stringify("[".repeat(depth))},{}]`;
      const suffix = '{"after":true}';
      const source = parent + " " + suffix;
      const stringEnd = parent.lastIndexOf('"');
      const push = Array.prototype.push;
      const pop = Array.prototype.pop;
      const parse = JSON.parse;
      const slice = String.prototype.slice;
      let pushes = 0;
      let pops = 0;
      let parsedUnits = 0;
      let copiedUnits = 0;
      Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
        pushes += items.length;
        return Reflect.apply(push, this, items);
      };
      Array.prototype.pop = function (this: unknown[]) {
        pops++;
        return Reflect.apply(pop, this, []);
      };
      JSON.parse = (text, reviver) => {
        parsedUnits += String(text).length;
        return parse(text, reviver);
      };
      String.prototype.slice = function (this: string, start, end) {
        const result = Reflect.apply(slice, this, [start, end]);
        copiedUnits += result.length;
        return result;
      };
      let result: ReturnType<typeof extractBalancedJsonFragments>;
      try {
        result = extractBalancedJsonFragments(source, {
          ...strictRecovery,
          strictJson: {
            source,
            opaqueSpans: [
              { startIndex: 1, endIndex: 1 },
              { startIndex: stringEnd, endIndex: stringEnd },
            ],
          },
        });
      } finally {
        Array.prototype.push = push;
        Array.prototype.pop = pop;
        JSON.parse = parse;
        String.prototype.slice = slice;
      }
      expect(result).toEqual([
        { json: parent, startIndex: 0, endIndex: parent.length - 1 },
        { json: suffix, startIndex: parent.length + 1, endIndex: source.length - 1 },
      ]);
      expect(parsedUnits).toBeLessThanOrEqual(2 * source.length + 2 * (depth + 3));
      expect(copiedUnits).toBeLessThanOrEqual(3 * source.length);
      expect(pushes).toBeLessThanOrEqual(10 * source.length);
      expect(pops).toBeLessThanOrEqual(4 * source.length);
    }
  });

  it("admits exact valid original parents despite closers exposed by opaque quotes", () => {
    for (const text of ["}", "prefix } suffix"]) {
      for (const newline of ["\n", "\r\n", "\r"]) {
        const child = '{"ok":true}';
        const source = `[${JSON.stringify(text)},${newline}${child}${newline}]`;
        const opaqueSpans = [
          { startIndex: 1, endIndex: 1 },
          { startIndex: text.length + 2, endIndex: text.length + 2 },
        ];
        expect(() => JSON.parse(source)).not.toThrow();
        const childFragment = {
          json: child,
          startIndex: source.indexOf(child),
          endIndex: source.indexOf(child) + child.length - 1,
        };
        for (const discovery of [source, source.replaceAll('"', " ")]) {
          for (const recoverAtLineStart of [false, true]) {
            const options = { recoverAtLineStart, strictJson: { source, opaqueSpans } };
            expect(extractBalancedJsonFragments(discovery, options)).toEqual([
              { json: source, startIndex: 0, endIndex: source.length - 1 },
            ]);
            expect(extractBalancedJsonFragments(discovery, { ...options, openers: ["{"] })).toEqual(
              [childFragment],
            );
          }
        }
        const invalid = source.replace(",", " INVALID,");
        expect(() => JSON.parse(invalid)).toThrow();
        expect(
          extractBalancedJsonFragments(invalid, {
            ...strictRecovery,
            strictJson: { source: invalid, opaqueSpans },
          }),
        ).toEqual([
          {
            json: child,
            startIndex: invalid.indexOf(child),
            endIndex: invalid.indexOf(child) + child.length - 1,
          },
        ]);
      }
    }
  });

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
