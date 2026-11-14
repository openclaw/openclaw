// OC Path tests cover emit plugin behavior.
import { describe, expect, it } from "vitest";
import { appendJsonlOcPath, setJsonlOcPath } from "../../jsonl/edit.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { parseOcPath } from "../../oc-path.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../../sentinel.js";

describe("JSONL edit emission", () => {
  it("renders nested values compactly and preserves entry order", () => {
    const ast = parseJsonl(
      '{ "2": 2, "1": 1, "2": 3, "values": [{}, [], {"scalars": [true, false, null, -1.5, "text"]}] }\n[ {}, [] ]\n',
    );
    let appended = parseJsonl("");
    for (const line of ast.lines) {
      if (line.kind === "value") {
        appended = appendJsonlOcPath(appended, line.value);
      }
    }
    expect(appended.raw).toBe(
      '{"2":2,"1":1,"2":3,"values":[{},[],{"scalars":[true,false,null,-1.5,"text"]}]}\n[{},[]]',
    );
  });

  it("preserves blank and malformed lines verbatim when appending", () => {
    const ast = parseJsonl('{"a":1}\n\nbroken\n{"b":2}\n');
    const appended = appendJsonlOcPath(ast, { kind: "number", value: 3 });
    expect(appended.raw.split("\n")).toEqual(['{"a":1}', "", "broken", '{"b":2}', "3", ""]);
  });

  it("reports the line and nested path when a value-leaf is the sentinel", () => {
    const ast = parseJsonl(`{"ok":true}\n{"outer":[{"token":"${REDACTED_SENTINEL}"}]}\n`);
    const line = ast.lines[1];
    expect(line?.kind).toBe("value");
    if (line?.kind !== "value") {
      return;
    }
    expect(() => setJsonlOcPath(ast, parseOcPath("oc://events/L2"), line.value)).toThrow(
      `emit refused to write "${REDACTED_SENTINEL}" sentinel literal at oc://events/L2/outer/0/token`,
    );
  });

  it("throws when a value-leaf EMBEDS the sentinel (prefix/suffix wrap)", () => {
    // Regression: prior to this fix, render mode used exact-match
    // (`value.value === SENTINEL`), so `prefix__OPENCLAW_REDACTED__suffix`
    // slipped through. The contains-check is the right invariant.
    const ast = parseJsonl('{"a":"ok"}\n');
    const value = {
      kind: "object" as const,
      entries: [
        {
          key: "a",
          line: 1,
          value: {
            kind: "string" as const,
            value: `wrap-${REDACTED_SENTINEL}-end`,
          },
        },
      ],
    };
    expect(() => appendJsonlOcPath(ast, value)).toThrow(OcEmitSentinelError);
  });
});
