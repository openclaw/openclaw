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
    expect(extractBalancedJsonPrefix(raw, strictRecovery)).toEqual(fragmentsAt(raw, [first])[0]);
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
      expect(extractBalancedJsonPrefix(discovery, options)).toEqual(fragmentsAt(source, [json])[0]);
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
          expect(extractBalancedJsonPrefix(view, options)).toEqual(fragmentsAt(source, [child])[0]);
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
          expect(extractBalancedJsonPrefix(view, options)).toBeNull();
        }
      }
    },
  );

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
        expect(extractBalancedJsonPrefix(discovery, options)).toEqual(
          fragmentsAt(source, [child])[0],
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
    expect(() => extractBalancedJsonPrefix("{}", options)).toThrow(RangeError);
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
        units += String(text).length;
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
      expect(extractBalancedJsonPrefix(raw, { recoverAtLineStart: true })?.json).toBe(json);
      expect(
        extractBalancedJsonPrefix(`${prefix}\n{"incomplete":`, { recoverAtLineStart: true }),
      ).toBeNull();
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
      expect(extractBalancedJsonPrefix(raw, { recoverAtLineStart: true })?.json).toBe(first);
      expect(extractBalancedJsonFragments(raw)).toEqual([]);
      const valid = '[\n "quoted \\"value\\"",\n {"nested": [1, 2]}\n]';
      expect(extractBalancedJsonPrefix(valid, { recoverAtLineStart: true })?.json).toBe(valid);
    },
  );

  it("keeps leading and inter-record prose quotes owned during recovery", () => {
    const first = '{"actual":1}';
    const second = '{"next":2}';
    const raw = `banner "example [0]"\n${first}\n"escaped \\"quote\\" and {fake}" ${second}`;
    for (const options of [{ recoverAtLineStart: true }, strictRecovery]) {
      expect(extractBalancedJsonPrefix(raw, options)).toEqual(fragmentsAt(raw, [first])[0]);
      expect(extractBalancedJsonFragments(raw, options)).toEqual(fragmentsAt(raw, [first, second]));
    }
    expect(extractBalancedJsonPrefix(raw)?.json).toBe("[0]");
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
      expect(extractBalancedJsonPrefix(prefix + json, { recoverAtLineStart: true })?.json).toBe(
        json,
      );
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
      Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
        for (const item of items) {
          if (item !== null && typeof item === "object") objectEntries++;
        }
        return Reflect.apply(push, this, items);
      };
      let completed: ReturnType<typeof extractBalancedJsonPrefix>;
      let unfinished: ReturnType<typeof extractBalancedJsonPrefix>;
      try {
        completed = extractBalancedJsonPrefix(complete, { skipQuotedOpeners });
        unfinished = extractBalancedJsonPrefix(incomplete, { skipQuotedOpeners });
      } finally {
        Array.prototype.push = push;
      }
      expect(completed).toEqual({ json: complete, startIndex: 0, endIndex: complete.length - 1 });
      expect(unfinished).toBeNull();
      expect(objectEntries).toBe(0);
    },
  );
});
