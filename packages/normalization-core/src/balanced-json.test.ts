import { describe, expect, it, vi } from "vitest";
import { extractBalancedJsonFragments, extractBalancedJsonPrefix } from "./balanced-json.js";

describe("balanced JSON extraction", () => {
  const strictRecovery = { strictJson: true, recoverAtLineStart: true } as const;
  const fragmentsAt = (raw: string, records: string[]) =>
    records.map((json) => ({
      json,
      startIndex: raw.indexOf(json),
      endIndex: raw.indexOf(json) + json.length - 1,
    }));

  it("retains native JSON syntax across 72 direct-child substitution cases", () => {
    const children = ["{}", "[]", '{"x":1}', "[true,null]", '{"x":"q\\\\\\"tail"}', '[{"x":[0]}]'];
    for (const child of children) {
      expect(() => JSON.parse(child)).not.toThrow();
    }
    const templates = [
      '{"child":CHILD}',
      "[CHILD]",
      '{"before":1,"child":CHILD,"after":false}',
      "[\r\nCHILD\r\n]",
      '{"child":{"nested":CHILD}}',
      "[CHILD,CHILD]",
      '{"child" CHILD}',
      "[CHILD 0]",
      "[0 CHILD]",
      "{CHILD}",
      "[CHILDCHILD]",
      "[CHILD,]",
    ];
    const cases = templates.flatMap((template) =>
      children.map((child) => template.replaceAll("CHILD", child)),
    );
    expect(cases).toHaveLength(72);
    for (const raw of cases) {
      let valid = false;
      try {
        JSON.parse(raw);
        valid = true;
      } catch {
        // The full original parse is the independent syntax oracle.
      }
      expect(extractBalancedJsonFragments(raw, { strictJson: true }), raw).toEqual(
        valid ? fragmentsAt(raw, [raw]) : [],
      );
    }
  });

  it("recovers pretty children of a balanced invalid warning without changing defaults", () => {
    const first = '{\r\n "text": "q\\"tail",\r\n "count": 7\r\n}';
    const second = "[\r\n false,\r\n null\r\n]";
    const wrapper = `{\r\nwarning\r\n${first}\r\n${second}\r\n}`;
    const next = '{"next":1}';
    const raw = `🦊 ${wrapper}\r\n${next}`;
    expect(extractBalancedJsonFragments(raw, strictRecovery)).toEqual(
      fragmentsAt(raw, [first, second, next]),
    );
    expect(extractBalancedJsonFragments(raw, { recoverAtLineStart: true })).toEqual(
      fragmentsAt(raw, [wrapper, next]),
    );
    expect(extractBalancedJsonFragments(raw, { strictJson: true })).toEqual(
      fragmentsAt(raw, [next]),
    );
  });

  it("gives valid parents precedence and respects quoted lines and filtered container kinds", () => {
    const child = '{"ok":[1,{"nested":true}]}';
    const raw = `[\r\n "note {} and [0]",\r\n ${child}\r\n]`;
    expect(extractBalancedJsonFragments(raw, strictRecovery)).toEqual(fragmentsAt(raw, [raw]));
    expect(extractBalancedJsonFragments(raw, { ...strictRecovery, openers: ["{"] })).toEqual(
      fragmentsAt(raw, [child]),
    );
    expect(
      extractBalancedJsonFragments(`[${child}]`, { strictJson: true, openers: ["{"] }),
    ).toEqual(fragmentsAt(`[${child}]`, [child]));
    expect(extractBalancedJsonFragments(`"note {} and [0]"\r\n${child}`, strictRecovery)).toEqual(
      fragmentsAt(`"note {} and [0]"\r\n${child}`, [child]),
    );
  });

  it.each(["{\nwarning\n", "[\nwarning\n", '{\n"unterminated\n'])(
    "retains children of incomplete or mismatched wrappers: %j",
    (prefix) => {
      const child = '{\n "ok": true\n}';
      for (const suffix of ["", "\n]", "\n}", "\n]\n}"]) {
        const raw = prefix + child + suffix;
        expect(extractBalancedJsonFragments(raw, strictRecovery)).toEqual(
          fragmentsAt(raw, [child]),
        );
      }
    },
  );

  it("binds admission and child string ownership to original text, not its discovery view", () => {
    const child = '{"ok":true}';
    const original = `{\u001b[31m\n${child}\n}`;
    const discovery = original.replace("\u001b[31m", "     ");
    expect(
      extractBalancedJsonFragments(discovery, {
        ...strictRecovery,
        strictJson: { source: original },
      }),
    ).toEqual(fragmentsAt(original, [child]));
    const invalid = '{"msg":"{"key":1}"}';
    const apparentChild = invalid.indexOf('{"key"');
    const masked =
      invalid.slice(0, apparentChild).replaceAll('"', " ") + invalid.slice(apparentChild);
    expect(
      extractBalancedJsonFragments(masked, { ...strictRecovery, strictJson: { source: invalid } }),
    ).toEqual([]);
    const quoted = '"note {} and [0]"';
    const valid = `[\n${quoted},\n${child}\n]`;
    const hiddenString = valid.replace(quoted, " ".repeat(quoted.length));
    expect(
      extractBalancedJsonFragments(hiddenString, {
        ...strictRecovery,
        strictJson: { source: valid },
      }),
    ).toEqual(fragmentsAt(valid, [valid]));
    expect(
      extractBalancedJsonFragments(quoted.replaceAll('"', " "), {
        ...strictRecovery,
        strictJson: { source: quoted },
      }),
    ).toEqual([]);
    expect(() => extractBalancedJsonFragments("{}", { strictJson: { source: "{ }" } })).toThrow(
      RangeError,
    );
  });

  it.each(['\u001b]0;"window title\u0007', '\u001b[1"q'])(
    "treats declared external framing as opaque without changing source coordinates (%j)",
    (prefix) => {
      const json = '{"publicShare":{"id":"opaque"},"count":7}';
      const source = `${prefix}${json}\r\n`;
      const discovery = " ".repeat(prefix.length) + json + "\r\n";
      const options = {
        ...strictRecovery,
        strictJson: {
          source,
          opaqueSpans: [{ startIndex: 0, endIndex: prefix.length - 1 }],
        },
      };
      expect(extractBalancedJsonFragments(discovery, options)).toEqual(fragmentsAt(source, [json]));
      expect(
        extractBalancedJsonFragments(discovery, {
          ...strictRecovery,
          strictJson: { source },
        }),
      ).toEqual([]);
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "uses original line boundaries and indentation outside declared framing (%j)",
    (newline) => {
      const child = '{"ok":true}';
      for (const warning of ["warning: [", 'warning: [ "unfinished']) {
        const prefix = `${warning}${newline}\t  `;
        const source = prefix + child;
        const options = { ...strictRecovery, strictJson: { source } };
        const discovery = prefix.replace(/[\r\n]/g, " ").replace("\t  ", "xxx") + child;
        for (const view of [source, discovery]) {
          expect(extractBalancedJsonFragments(view, options)).toEqual(fragmentsAt(source, [child]));
        }
        expect(extractBalancedJsonFragments(discovery.replace('{"ok"', ' "ok"'), options)).toEqual(
          [],
        );
      }
      for (const inline of [`warning: [${newline}prose ${child}`, `warning: [prose ${child}`]) {
        const options = { ...strictRecovery, strictJson: { source: inline } };
        for (const view of [
          inline,
          inline.replace("prose", "     "),
          inline.replace("prose", "\n    "),
        ]) {
          expect(extractBalancedJsonFragments(view, options)).toEqual([]);
        }
      }
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "retains original wrapper ownership after a stray closer or hidden opener (%j)",
    (newline) => {
      const inline = '{"inline":true}';
      const next = '{"next":true}';
      for (const warning of [`warning: [expected } near ${inline}]`, `warning: [prose ${inline}`]) {
        const source = `${warning}${newline}${next}`;
        for (const view of [source, source.replace("[", " ")]) {
          const options = { ...strictRecovery, strictJson: { source } };
          expect(extractBalancedJsonFragments(view, options)).toEqual(fragmentsAt(source, [next]));
          expect(extractBalancedJsonFragments(view, { ...options, openers: ["{"] })).toEqual(
            fragmentsAt(source, [inline, next]),
          );
        }
      }
    },
  );

  it("keeps eligible descendants when a valid selected ancestor is not emitted", () => {
    const child = '{"ok":true}';
    const source = `warning: [\ndetails: [\n${child}\n]`;
    for (const options of [{ recoverAtLineStart: true }, strictRecovery]) {
      expect(extractBalancedJsonFragments(source, options)).toEqual(fragmentsAt(source, [child]));
    }
    const parent = `[\n${child}\n]`;
    expect(extractBalancedJsonFragments(parent, strictRecovery)).toEqual(
      fragmentsAt(parent, [parent]),
    );
  });

  it("retains deep wrapper ownership across repeated unmatched closers", () => {
    const inline = '{"inline":true}';
    const next = '{"next":true}';
    const depth = 4096;
    const source = "[".repeat(depth) + "}".repeat(depth) + inline + "\n" + next + "]".repeat(depth);
    expect(extractBalancedJsonFragments(source, strictRecovery)).toEqual(
      fragmentsAt(source, [next]),
    );
  });

  it.each(["\n", "\r\n", "\r"])(
    "applies accepted framing to recovery eligibility in masked and unmasked views (%j)",
    (newline) => {
      const prefix = `warning: [${newline}`;
      const framing = "\u001b[31m";
      const child = '{"ok":true}';
      const source = prefix + framing + child;
      const options = {
        ...strictRecovery,
        strictJson: {
          source,
          opaqueSpans: [
            {
              startIndex: prefix.length,
              endIndex: prefix.length + framing.length - 1,
            },
          ],
        },
      };
      for (const discovery of [
        source,
        source.replace(framing, " ".repeat(framing.length)),
        source
          .replace(newline, " ".repeat(newline.length))
          .replace(framing, " ".repeat(framing.length)),
      ]) {
        expect(extractBalancedJsonFragments(discovery, options)).toEqual(
          fragmentsAt(source, [child]),
        );
      }
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "retains opaque line boundaries but never admits a parent from masked text (%j)",
    (newline) => {
      const framing = `framing "[]${newline}`;
      const child = '{"ok":true}';
      const source = `[${framing}${child}${newline}]`;
      const discovery = source.replace(framing, framing.replace(/[^\r\n]/g, " "));
      expect(() => JSON.parse(discovery)).not.toThrow();
      expect(
        extractBalancedJsonFragments(discovery, {
          ...strictRecovery,
          strictJson: {
            source,
            opaqueSpans: [{ startIndex: 1, endIndex: framing.length }],
          },
        }),
      ).toEqual(fragmentsAt(source, [child]));
    },
  );

  it.each(["\u009b", "\u009d"])(
    "ignores a span entering inside an original string (%j)",
    (control) => {
      const child = '{"actual":true}';
      const quoted = String.raw`"note ${control} and \"quoted\" [0]"`;
      const source = `${quoted}\r\n${child}\u0007`;
      const span = { startIndex: source.indexOf(control), endIndex: source.length - 1 };
      for (const discovery of [
        source,
        source.slice(0, span.startIndex) + " ".repeat(source.length - span.startIndex),
      ]) {
        expect(
          extractBalancedJsonFragments(discovery, {
            ...strictRecovery,
            strictJson: { source, opaqueSpans: [span] },
          }),
        ).toEqual(fragmentsAt(source, [child]));
      }
      const parent = `[\r\n${quoted},\r\n${child}\r\n]`;
      expect(
        extractBalancedJsonFragments(parent, {
          ...strictRecovery,
          strictJson: {
            source: parent,
            opaqueSpans: [{ startIndex: parent.indexOf(control), endIndex: parent.length - 1 }],
          },
        }),
      ).toEqual(fragmentsAt(parent, [parent]));
    },
  );

  it.each(["{}", "[0]", "{bad}", String.raw`{say \"hi\"}`])(
    "preserves original string bytes when opaque spans expose an apparent child (%s)",
    (child) => {
      const source = `["prefix ${child} suffix"]`;
      const start = source.indexOf(child);
      const opaqueSpans = [
        { startIndex: 1, endIndex: start - 1 },
        { startIndex: start + child.length, endIndex: source.length - 2 },
      ];
      const discovery =
        "[" +
        " ".repeat(start - 1) +
        child +
        " ".repeat(source.length - start - child.length - 1) +
        "]";
      expect(() => JSON.parse(source)).not.toThrow();
      for (const recoverAtLineStart of [false, true]) {
        for (const view of [source, discovery]) {
          const options = { recoverAtLineStart, strictJson: { source, opaqueSpans } };
          expect(extractBalancedJsonFragments(view, options)).toEqual(
            fragmentsAt(source, [source]),
          );
          expect(extractBalancedJsonFragments(view, { ...options, openers: ["{"] })).toEqual(
            fragmentsAt(source, child === "{}" ? [child] : []),
          );
        }
      }
    },
  );

  it.each(['{"ok":true}', '{"nested":[{"value":1}]}'])(
    "does not substitute string-interior children exposed by opaque quotes (%s)",
    (child) => {
      const source = `["prefix ${child} suffix"]`;
      const start = source.indexOf(child);
      const options = {
        ...strictRecovery,
        strictJson: {
          source,
          opaqueSpans: [
            { startIndex: 1, endIndex: start - 1 },
            { startIndex: start + child.length, endIndex: source.length - 2 },
          ],
        },
      };
      expect(() => JSON.parse(source)).toThrow();
      const discovery =
        "[" +
        " ".repeat(start - 1) +
        child +
        " ".repeat(source.length - start - child.length - 1) +
        "]";
      for (const view of [source, discovery]) {
        expect(extractBalancedJsonFragments(view, options)).toEqual([]);
        expect(extractBalancedJsonFragments(view, { ...options, openers: ["{"] })).toEqual(
          fragmentsAt(source, [child]),
        );
      }
      const prefix = String.raw`["prefix \"{noise}",`;
      const valid = prefix + child + ',"suffix"]';
      expect(
        extractBalancedJsonFragments(valid, {
          ...strictRecovery,
          strictJson: {
            source: valid,
            opaqueSpans: [{ startIndex: 1, endIndex: prefix.length - 2 }],
          },
        }),
      ).toEqual(fragmentsAt(valid, [valid]));
    },
  );

  it.each([
    [{ startIndex: -1, endIndex: 0 }],
    [{ startIndex: 0.5, endIndex: 1 }],
    [{ startIndex: 0, endIndex: Number.NaN }],
    [{ startIndex: 0, endIndex: Number.POSITIVE_INFINITY }],
    [{ startIndex: 1, endIndex: 0 }],
    [{ startIndex: 0, endIndex: 2 }],
    [
      { startIndex: 1, endIndex: 1 },
      { startIndex: 0, endIndex: 0 },
    ],
    [
      { startIndex: 0, endIndex: 1 },
      { startIndex: 1, endIndex: 1 },
    ],
    [
      { startIndex: 0, endIndex: 0 },
      { startIndex: 0, endIndex: 0 },
    ],
  ])("rejects invalid opaque span geometry instead of repairing it: %j", (...opaqueSpans) => {
    const options = { strictJson: { source: "{}", opaqueSpans } };
    expect(() => extractBalancedJsonFragments("{}", options)).toThrow(RangeError);
  });

  it("retains original numeric lexemes, duplicate keys, and escaped strings in admitted records", () => {
    const json = '{"value":9007199254740993,"value":-0,"exponent":1e3,"text":"\\u0000 \\ud800"}';
    expect(extractBalancedJsonFragments(json, strictRecovery)).toEqual(fragmentsAt(json, [json]));
  });

  it("bounds total native admission work for deeply nested valid and invalid containers", () => {
    const parse = JSON.parse;
    for (const invalid of [false, true]) {
      const depth = 4096;
      const leaf = '{"leaf":true}';
      const prefix = '{\n"child":\n';
      const suffix = invalid ? ',\n"bad":undefined\n}' : "\n}";
      const raw = prefix.repeat(depth) + leaf + suffix.repeat(depth);
      let units = 0;
      let calls = 0;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        units += text.length;
        calls += 1;
        return parse(text, reviver);
      });
      let result: ReturnType<typeof extractBalancedJsonFragments>;
      try {
        result = extractBalancedJsonFragments(raw, strictRecovery);
      } finally {
        spy.mockRestore();
      }
      expect(result).toEqual(fragmentsAt(raw, [invalid ? leaf : raw]));
      expect(calls).toBeLessThanOrEqual(depth + 1);
      expect(units).toBeLessThanOrEqual(raw.length + 2 * depth);
      for (const fragment of result) {
        expect(() => parse(fragment.json)).not.toThrow();
      }
    }
  });

  it.each(["warning: [", "warning: {", "[", "\t{", "\u001b[31mwarning\u001b[0m ["])(
    "recovers an explicit record after an unmatched warning opener: %s",
    (prefix) => {
      const json = '{\n  "password": "q\\"tail",\n  "nested": [\n    {"ok": true}\n  ]\n}';
      const raw = `${prefix}\n${json}\n{"next":1}`;
      expect(extractBalancedJsonFragments(raw, { recoverAtLineStart: true })).toEqual(
        [json, '{"next":1}'].map((text) => ({
          json: text,
          startIndex: raw.indexOf(text),
          endIndex: raw.indexOf(text) + text.length - 1,
        })),
      );
      expect(extractBalancedJsonPrefix(raw)).toBeNull();
      expect(
        extractBalancedJsonFragments(`${prefix}\n{"incomplete":`, { recoverAtLineStart: true }),
      ).toEqual([]);
    },
  );

  it("recovers later records after multiple unfinished line-start warnings", () => {
    const first = '{\r\n  "nested": [\r\n    {"ok":true}\r\n  ]\r\n}';
    const second = '{"next":2}';
    const raw = `${"[\r\n".repeat(2048)}${first}\r\n${"{\r\n".repeat(2048)}${second}`;
    expect(extractBalancedJsonFragments(raw, { recoverAtLineStart: true })).toEqual(
      [first, second].map((json) => ({
        json,
        startIndex: raw.indexOf(json),
        endIndex: raw.indexOf(json) + json.length - 1,
      })),
    );
  });

  it.each(["\n", "\r\n", "\r"])(
    "resets impossible quoted-string state only for opt-in recovery (%j)",
    (newline) => {
      const first = '{\n "publicShare": {"id": "opaque"},\n "count": 7\n}';
      const second = '{"next":true}';
      const warning = 'warning: [ "unterminated';
      const raw = `${warning}${newline}${first}${newline}]${newline}${second}`;
      expect(extractBalancedJsonFragments(raw, { recoverAtLineStart: true })).toEqual(
        [first, second].map((json) => ({
          json,
          startIndex: raw.indexOf(json),
          endIndex: raw.indexOf(json) + json.length - 1,
        })),
      );
      expect(extractBalancedJsonFragments(raw)).toEqual([]);
      const valid = '[\n "quoted \\"value\\"",\n {"nested": [1, 2]}\n]';
      expect(extractBalancedJsonFragments(valid, { recoverAtLineStart: true })[0]?.json).toBe(
        valid,
      );
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "retires newline-damaged quotes with their wrappers before adjacent records (%j)",
    (newline) => {
      const kept = '{"kept":0}';
      const records = ['{"first":1}', '{"second":[2]}'];
      for (const [opener, closer] of [
        ["[", "]"],
        ['{"text":', "}"],
      ]) {
        for (const text of ["line two", String.raw`line \"two\"`]) {
          const wrapper = `${opener}"line one${newline}${text}"${closer}`;
          for (const prefix of [
            wrapper,
            `warning: [${newline}${wrapper}${newline}]`,
            `[${newline}${kept},${newline}${wrapper}${newline}]`,
          ]) {
            const raw = `${prefix}${newline}${records.join(" ")}`;
            const expected = prefix.includes(kept) ? [kept, ...records] : records;
            for (const options of [{ recoverAtLineStart: true }, strictRecovery]) {
              for (const openers of [undefined, ["{"] as const]) {
                expect(extractBalancedJsonFragments(raw, { ...options, openers }), raw).toEqual(
                  fragmentsAt(raw, expected),
                );
              }
            }
            const discovery = raw.replace(/[\r\n]/g, " ");
            expect(
              extractBalancedJsonFragments(discovery, {
                ...strictRecovery,
                strictJson: { source: raw },
              }),
            ).toEqual(fragmentsAt(raw, expected));
          }
        }
      }
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "releases unfinished damaged quotes only at explicit original boundaries (%j)",
    (newline) => {
      const child = `{${newline} "nested": [1, 2]${newline}}`;
      const records = ['{"first":1}', '{"second":2}'];
      for (const [opener, closer] of [
        ["[", "]"],
        ['{"text":', "}"],
      ]) {
        for (const recovered of ["", `${child}${newline}`]) {
          const raw = `${opener}"unfinished${newline}${recovered}${closer}${newline}${records.join(" ")}`;
          const expected = recovered ? [child, ...records] : records;
          for (const options of [{ recoverAtLineStart: true }, strictRecovery]) {
            expect(extractBalancedJsonFragments(raw, options), raw).toEqual(
              fragmentsAt(raw, expected),
            );
          }
        }
      }
      const raw = `["line one${newline}} still quoted \\"quote\\" \u009dtext"]${newline}${records.join(" ")}`;
      const startIndex = raw.indexOf("\u009d");
      for (const discovery of [
        raw,
        raw.slice(0, startIndex) + " ".repeat(raw.length - startIndex),
      ]) {
        expect(
          extractBalancedJsonFragments(discovery, {
            ...strictRecovery,
            strictJson: {
              source: raw,
              opaqueSpans: [{ startIndex, endIndex: raw.length - 1 }],
            },
          }),
        ).toEqual(fragmentsAt(raw, records));
      }
    },
  );

  it("keeps an unfinished recovery child's quote until an explicit owner boundary", () => {
    const raw = '["details\n{unfinished\nlast line"]\n{"first":1} {"second":2}';
    // The apparent parent terminator is still inside the unfinished child's
    // quote. Recovery does not guess parent priority from malformed prose.
    for (const options of [
      { recoverAtLineStart: true },
      strictRecovery,
      { ...strictRecovery, strictJson: { source: raw } },
    ]) {
      expect(extractBalancedJsonFragments(raw, options)).toEqual(fragmentsAt(raw, ['{"first":1}']));
    }
  });

  it("does not rescan damaged quote suffixes or copy discarded wrappers", () => {
    const records = ['{"first":1}', '{"second":2}'];
    for (const depth of [256, 1024]) {
      const raw = '["line one\nline two"]\n'.repeat(depth) + records.join(" ");
      const pop = Array.prototype.pop;
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below supplies the original receiver.
      const slice = String.prototype.slice;
      let pops = 0;
      let copiedUnits = 0;
      let result: ReturnType<typeof extractBalancedJsonFragments>;
      // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
      Array.prototype.pop = function (this: unknown[]) {
        pops++;
        return Reflect.apply(pop, this, []);
      };
      // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
      String.prototype.slice = function (this: string, start, end) {
        const value = Reflect.apply(slice, this, [start, end]);
        if (this === raw) {
          copiedUnits += value.length;
        }
        return value;
      };
      try {
        result = extractBalancedJsonFragments(raw, { recoverAtLineStart: true });
      } finally {
        // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
        Array.prototype.pop = pop;
        // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
        String.prototype.slice = slice;
      }
      expect(result).toEqual(fragmentsAt(raw, records));
      expect(pops).toBe(depth + records.length);
      expect(copiedUnits).toBe(records.join("").length);
    }
  });

  it.each(["\n", "\r\n", "\r"])(
    "resumes the owning damaged quote after recovered children (%j)",
    (newline) => {
      const records = ['{"first":1}', '{"second":2}'];
      const cases = [
        { children: ['{"inside":0}'], objects: ['{"inside":0}'] },
        { children: ['{"inside":[{"nested":0}]}'], objects: ['{"inside":[{"nested":0}]}'] },
        { children: ["[0]"], objects: [] },
        { children: ['{"inside":0}', '{"again":1}'], objects: ['{"inside":0}', '{"again":1}'] },
      ];
      for (const [opener, closer] of [
        ['{"text":', "}"],
        ["[", "]"],
      ]) {
        for (const { children, objects } of cases) {
          for (const tail of ["line three", String.raw`line \"three\"`]) {
            const wrapper = `${opener}"line one${newline}${children.join(newline)}${newline}${tail}"${closer}`;
            const raw = `${wrapper}${newline}${records.join(" ")}`;
            for (const options of [{ recoverAtLineStart: true }, strictRecovery]) {
              for (const openers of [undefined, ["{"] as const]) {
                expect(extractBalancedJsonFragments(raw, { ...options, openers }), raw).toEqual(
                  fragmentsAt(raw, [...(openers ? objects : children), ...records]),
                );
              }
            }
            const discovery = raw.replace(/[\r\n]/g, " ");
            expect(
              extractBalancedJsonFragments(discovery, {
                ...strictRecovery,
                strictJson: { source: raw },
              }),
            ).toEqual(fragmentsAt(raw, [...children, ...records]));
          }
        }
      }
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "retires only popped quote owners and resumes surviving owners (%j)",
    (newline) => {
      const child = '{"inside":0}';
      const records = ['{"first":1}', '{"second":2}'];
      const cases = [
        `["outer${newline}{"text":"inner${newline}${child}${newline}inner end"}${newline}outer end"]`,
        `["outer${newline}{"text":"inner${newline}${child}${newline}]`,
        `{"text":"outer${newline}[unfinished${newline}${child}${newline}}`,
        `["outer${newline}${child}${newline}} stray closer${newline}outer end"]`,
      ];
      for (const wrapper of cases) {
        const raw = `${wrapper}${newline}${records.join(" ")}`;
        for (const options of [{ recoverAtLineStart: true }, strictRecovery]) {
          expect(extractBalancedJsonFragments(raw, options), raw).toEqual(
            fragmentsAt(raw, [child, ...records]),
          );
        }
      }
      const invalid = "{invalid:0}";
      const raw = `["outer${newline}${invalid}${newline}outer end"]${newline}${records.join(" ")}`;
      expect(extractBalancedJsonFragments(raw, { recoverAtLineStart: true })).toEqual(
        fragmentsAt(raw, [invalid, ...records]),
      );
      expect(extractBalancedJsonFragments(raw, strictRecovery)).toEqual(fragmentsAt(raw, records));
      const hidden = `["outer${newline}${child}${newline}outer end"]${newline}${records.join(" ")}`;
      const discovery = hidden.replace(child, " ".repeat(child.length));
      expect(
        extractBalancedJsonFragments(discovery, {
          ...strictRecovery,
          strictJson: { source: hidden },
        }),
      ).toEqual(fragmentsAt(hidden, records));
      const opaque = `["outer${newline}${child}${newline}\u009dtitle end"]${newline}${records.join(" ")}\u0007`;
      const startIndex = opaque.indexOf("\u009d");
      for (const view of [
        opaque,
        opaque.slice(0, startIndex) + " ".repeat(opaque.length - startIndex),
      ]) {
        expect(
          extractBalancedJsonFragments(view, {
            ...strictRecovery,
            strictJson: {
              source: opaque,
              opaqueSpans: [{ startIndex, endIndex: opaque.length - 1 }],
            },
          }),
        ).toEqual(fragmentsAt(opaque, [child, ...records]));
      }
    },
  );

  it("restores suspended quotes from the surviving frame without scanning ancestry", () => {
    const leaf = '{"inside":0}';
    const records = ['{"first":1}', '{"second":2}'];
    for (const depth of [256, 1024]) {
      const raw = '["outer\n'.repeat(depth) + leaf + '\ntail"]'.repeat(depth) + records.join(" ");
      const at = Array.prototype.at;
      const pop = Array.prototype.pop;
      let lookups = 0;
      let pops = 0;
      let result: ReturnType<typeof extractBalancedJsonFragments>;
      // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
      Array.prototype.at = function (this: unknown[], index) {
        lookups++;
        return Reflect.apply(at, this, [index]);
      };
      // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
      Array.prototype.pop = function (this: unknown[]) {
        pops++;
        return Reflect.apply(pop, this, []);
      };
      try {
        result = extractBalancedJsonFragments(raw, { recoverAtLineStart: true });
      } finally {
        // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
        Array.prototype.at = at;
        // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
        Array.prototype.pop = pop;
      }
      expect(result).toEqual(fragmentsAt(raw, [leaf, ...records]));
      expect(pops).toBe(depth + records.length + 1);
      expect(lookups).toBeLessThanOrEqual(raw.length * 2);
    }
  });

  it("keeps leading and inter-record prose quotes owned during recovery", () => {
    const first = '{"actual":1}';
    const second = '{"next":2}';
    const raw = `banner "example [0]"\n${first}\n"escaped \\"quote\\" and {fake}" ${second}`;
    for (const options of [{ recoverAtLineStart: true }, strictRecovery]) {
      expect(extractBalancedJsonFragments(raw, options)).toEqual(fragmentsAt(raw, [first, second]));
    }
    expect(extractBalancedJsonPrefix(raw)?.json).toBe("[0]");
  });

  it.each(["\n", "\r\n", "\r"])(
    "keeps multiline prose quotes distinct from container-owned invalid strings (%j)",
    (newline) => {
      const actual = '{"actual":1}';
      for (const closed of [false, true]) {
        const source = `banner "example begins${newline}still inside [0] end${closed ? '"' : ""}${newline}${actual}`;
        for (const options of [{ recoverAtLineStart: true }, strictRecovery]) {
          expect(extractBalancedJsonFragments(source, options)).toEqual(
            fragmentsAt(source, closed ? [actual] : []),
          );
        }
      }
      // Original arrays own quotes even when only object output is requested,
      // including after an earlier fragment has already been returned.
      const first = '{"first":1}';
      const source = `[${first}, "unfinished${newline}${actual}`;
      for (const options of [{ recoverAtLineStart: true }, strictRecovery]) {
        expect(extractBalancedJsonFragments(source, { ...options, openers: ["{"] })).toEqual(
          fragmentsAt(source, [first, actual]),
        );
      }
      const prose = `[banner "one${newline}\u009dtitle end"${newline}${actual}\u0007`;
      const start = prose.indexOf("\u009d");
      const options = {
        ...strictRecovery,
        strictJson: {
          source: prose,
          opaqueSpans: [
            { startIndex: 0, endIndex: 0 },
            { startIndex: start, endIndex: prose.length - 1 },
          ],
        },
      };
      for (const view of [prose, " " + prose.slice(1, start) + " ".repeat(prose.length - start)]) {
        expect(extractBalancedJsonFragments(view, options)).toEqual(fragmentsAt(prose, [actual]));
      }
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "retires closed ancestors and their dangling children before later prose quotes (%j)",
    (newline) => {
      const actual = '{"actual":1}';
      const cases = [
        { prefix: "warning: [expected {]", openers: ["{", "["] as const, emitted: [] },
        { prefix: "warning: {expected [}", openers: ["{", "["] as const, emitted: [] },
        { prefix: '{"items":[}', openers: ["{"] as const, emitted: ['{"items":[}'] },
        { prefix: '[{"items":]', openers: ["["] as const, emitted: ['[{"items":]'] },
      ];
      for (const { prefix, openers, emitted } of cases) {
        const next = openers.some((opener) => opener === "{") ? actual : "[3]";
        for (const closed of [false, true]) {
          const raw = `${prefix}${newline}banner "example${newline}[1,2]${newline}{}${newline}end${closed ? '"' : ""}${newline}${next}`;
          expect(
            extractBalancedJsonFragments(raw, { recoverAtLineStart: true, openers }),
            raw,
          ).toEqual(fragmentsAt(raw, closed ? [...emitted, next] : emitted));
          expect(extractBalancedJsonFragments(raw, { ...strictRecovery, openers }), raw).toEqual(
            fragmentsAt(raw, closed ? [next] : []),
          );
        }
      }
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "preserves outer ownership across a completed filtered fragment and stray closers (%j)",
    (newline) => {
      const first = '{"items":[}';
      const actual = '{"actual":1}';
      const raw = `warning: [${newline}${first}${newline}}${newline}"unfinished${newline}${actual}`;
      expect(
        extractBalancedJsonFragments(raw, { recoverAtLineStart: true, openers: ["{"] }),
      ).toEqual(fragmentsAt(raw, [first, actual]));
      expect(extractBalancedJsonFragments(raw, { ...strictRecovery, openers: ["{"] })).toEqual(
        fragmentsAt(raw, [actual]),
      );
    },
  );

  it("retires deeply nested dangling owners once without reviving them on stray closers", () => {
    const depth = 4096;
    const actual = '{"actual":1}';
    const raw = `[${"{".repeat(depth)}]${"}".repeat(depth)}\n"example\n[1,2]\nend"\n${actual}`;
    for (const options of [{ recoverAtLineStart: true }, strictRecovery]) {
      expect(extractBalancedJsonFragments(raw, options)).toEqual(fragmentsAt(raw, [actual]));
    }
  });

  it.each(["\n", "\r\n", "\r"])(
    "retires candidate selection with its owner and keeps suffix admission stable (%j)",
    (newline) => {
      const kept = '{"kept":1}';
      const cases = [
        { prefix: "warning: [expected {]", openers: ["{", "["] as const, emitted: [] },
        { prefix: "warning: {expected [}", openers: ["{", "["] as const, emitted: [] },
        {
          prefix: `warning: [${newline}${kept}${newline}{]`,
          openers: ["{", "["] as const,
          emitted: [kept],
        },
        { prefix: '{"items":[}', openers: ["{"] as const, emitted: ['{"items":[}'] },
        { prefix: '[{"items":]', openers: ["["] as const, emitted: ['[{"items":]'] },
      ];
      for (const { prefix, openers, emitted } of cases) {
        const records = openers.some((opener) => opener === "{")
          ? ['{"first":1}', '{"second":2}']
          : ["[1]", "[2]"];
        for (const stray of ["", "}", "]", "}]", "]}", "}]".repeat(128)]) {
          for (const separator of [newline, " result: "]) {
            const raw = `${prefix}${stray}${separator}${records.join(" ")}`;
            expect(
              extractBalancedJsonFragments(raw, { recoverAtLineStart: true, openers }),
              raw,
            ).toEqual(fragmentsAt(raw, [...emitted, ...records]));
          }
        }
      }
    },
  );

  it("preserves completed children until an eligible, undamaged parent replaces them", () => {
    const child = '{"kept":1}';
    const next = '{"next":2}';
    const cases = [
      { prefix: "[warning\n", suffix: "\n]", emitted: [`[warning\n${child}\n]`] },
      { prefix: "[warning\n", suffix: "\n{]", emitted: [child] },
      { prefix: "[warning\n", suffix: '\n"unfinished\n]', emitted: [child] },
      { prefix: "[warning\ndetails: [\n", suffix: "\n]", emitted: [child] },
      { prefix: "[warning\n", suffix: "", emitted: [child] },
    ];
    for (const { prefix, suffix, emitted } of cases) {
      const raw = `${prefix}${child}${suffix}\n${next}`;
      expect(extractBalancedJsonFragments(raw, { recoverAtLineStart: true }), raw).toEqual(
        fragmentsAt(raw, [...emitted, next]),
      );
    }
  });

  it("copies only finally selected spans and retires each original owner at most once", () => {
    const depth = 2048;
    const nested = "[\n".repeat(depth) + '{"leaf":true}' + "\n]".repeat(depth);
    for (const damaged of [false, true]) {
      const raw = damaged ? `[warning\n${nested}\n{]${"}]".repeat(depth)}` : nested;
      const pop = Array.prototype.pop;
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below supplies the original receiver.
      const slice = String.prototype.slice;
      let pops = 0;
      let sourceCopies = 0;
      let copiedUnits = 0;
      let result: ReturnType<typeof extractBalancedJsonFragments>;
      // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
      Array.prototype.pop = function (this: unknown[]) {
        pops++;
        return Reflect.apply(pop, this, []);
      };
      // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
      String.prototype.slice = function (this: string, start, end) {
        const value = Reflect.apply(slice, this, [start, end]);
        if (this === raw) {
          sourceCopies++;
          copiedUnits += value.length;
        }
        return value;
      };
      try {
        result = extractBalancedJsonFragments(raw, { recoverAtLineStart: true });
      } finally {
        // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
        Array.prototype.pop = pop;
        // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
        String.prototype.slice = slice;
      }
      expect(result).toEqual(fragmentsAt(raw, [nested]));
      expect(pops).toBeLessThanOrEqual(depth + 3);
      expect(sourceCopies).toBe(1);
      expect(copiedUnits).toBe(nested.length);
    }
  });

  it.each(["\n", "\r\n", "\r"])(
    "uses the same recovery boundary for completed records and invalid strings (%j)",
    (newline) => {
      const child = '{"ok":true}';
      const next = '{"next":2}';
      const raw = `warning: [${newline}${child}${newline}${next}`;
      for (const options of [{ recoverAtLineStart: true }, strictRecovery]) {
        expect(extractBalancedJsonFragments(raw, options)).toEqual(fragmentsAt(raw, [child, next]));
        const parent = `[${newline}${child}${newline}]`;
        expect(extractBalancedJsonFragments(parent, options)).toEqual(
          fragmentsAt(parent, [parent]),
        );
      }
      expect(extractBalancedJsonFragments(raw)).toEqual([]);
    },
  );

  it.each(["", "warning: "])(
    "keeps a valid multiline root with nested line-start containers after %j",
    (prefix) => {
      const json = '[\n{\n"ok": true\n}\n]';
      expect(
        extractBalancedJsonFragments(prefix + json, { recoverAtLineStart: true })[0]?.json,
      ).toBe(json);
    },
  );

  it.each([
    ['prefix "notjson{here}" middle {"a":[1,{"b":"c"}]} suffix', '{"a":[1,{"b":"c"}]}'],
    ['prefix "array[here]" then [1,{"b":"c"}]', '[1,{"b":"c"}]'],
    ['banner "use { to begin JSON" actual {"ok":true}', '{"ok":true}'],
    [String.raw`banner "example {\"error\":true}" actual {"ok":true}`, '{"ok":true}'],
  ])("skips quoted prose when requested: %s", (raw, json) => {
    const startIndex = raw.indexOf(json);

    expect(extractBalancedJsonPrefix(raw, { skipQuotedOpeners: true })).toEqual({
      json,
      startIndex,
      endIndex: startIndex + json.length - 1,
    });
  });

  it.each([
    'banner "unterminated prose {"ok":true}',
    '"first {not}" then "unterminated no JSON',
    'banner "{example}"',
  ])("does not invent recovery across ambiguous prose quotes: %s", (raw) => {
    expect(extractBalancedJsonPrefix(raw, { skipQuotedOpeners: true })).toBeNull();
  });

  it("retains object-only selection and offsets across quoted spans", () => {
    const raw = '"{fake}" [0] {"first":1} "use { here" {"second":2}';

    expect(extractBalancedJsonFragments(raw, { openers: ["{"], skipQuotedOpeners: true })).toEqual(
      ['{"first":1}', '{"second":2}'].map((json) => ({
        json,
        startIndex: raw.indexOf(json),
        endIndex: raw.indexOf(json) + json.length - 1,
      })),
    );
  });

  it.each([
    ['prefix "notjson[1]" middle {"a":1}', "[1]"],
    ['prefix {"token": } suffix', '{"token": }'],
    ['banner "unterminated prose {"ok":true}', '{"ok":true}'],
  ])("preserves delimiter-first extraction by default: %s", (raw, json) => {
    const expected = {
      json,
      startIndex: raw.indexOf(json),
      endIndex: raw.indexOf(json) + json.length - 1,
    };

    expect(extractBalancedJsonPrefix(raw)).toEqual(expected);
    expect(extractBalancedJsonPrefix(raw, { skipQuotedOpeners: false })).toEqual(expected);
  });

  it.each([false, true])(
    "avoids per-opener object entries without recovery (skipQuotedOpeners=%s)",
    (skipQuotedOpeners) => {
      const incomplete = "[".repeat(512);
      const complete = incomplete + "0" + "]".repeat(512);
      const push = Array.prototype.push;
      let objectEntries = 0;
      // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
      Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
        for (const item of items) {
          if (item !== null && typeof item === "object") {
            objectEntries++;
          }
        }
        return Reflect.apply(push, this, items);
      };
      let completed: ReturnType<typeof extractBalancedJsonPrefix>;
      let unfinished: ReturnType<typeof extractBalancedJsonPrefix>;
      try {
        completed = extractBalancedJsonPrefix(complete, { skipQuotedOpeners });
        unfinished = extractBalancedJsonPrefix(incomplete, { skipQuotedOpeners });
      } finally {
        // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
        Array.prototype.push = push;
      }
      expect(completed).toEqual({ json: complete, startIndex: 0, endIndex: complete.length - 1 });
      expect(unfinished).toBeNull();
      expect(objectEntries).toBe(0);
    },
  );
});
