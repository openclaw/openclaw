// OC Path tests cover emit plugin behavior.
import { describe, expect, it } from "vitest";
import { renderJsonl } from "../../jsonl/emit.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../../sentinel.js";

describe("renderJsonl", () => {
  it("renders nested values compactly and preserves entry order", () => {
    const { ast } = parseJsonl(
      '{ "2": 2, "1": 1, "2": 3, "values": [{}, [], {"scalars": [true, false, null, -1.5, "text"]}] }\n[ {}, [] ]\n',
    );
    const out = renderJsonl(ast);
    expect(out).toBe(
      '{"2":2,"1":1,"2":3,"values":[{},[],{"scalars":[true,false,null,-1.5,"text"]}]}\n[{},[]]',
    );
  });

  it("preserves blank and malformed lines verbatim in render mode", () => {
    const { ast } = parseJsonl('{"a":1}\n\nbroken\n{"b":2}\n');
    const out = renderJsonl(ast);
    expect(out.split("\n")).toEqual(['{"a":1}', "", "broken", '{"b":2}']);
  });

  it("reports the line and nested path when a value-leaf is the sentinel", () => {
    const { ast } = parseJsonl(`{"ok":true}\n{"outer":[{"token":"${REDACTED_SENTINEL}"}]}\n`);
    expect(() => renderJsonl(ast, "events")).toThrow(
      expect.objectContaining({
        code: "OC_EMIT_SENTINEL",
        path: "oc://events/L2/outer/0/token",
      }),
    );
  });

  it("throws when a value-leaf EMBEDS the sentinel (prefix/suffix wrap)", () => {
    // Regression: prior to this fix, render mode used exact-match
    // (`value.value === SENTINEL`), so `prefix__OPENCLAW_REDACTED__suffix`
    // slipped through. The contains-check is the right invariant.
    const ast = parseJsonl('{"a":"ok"}\n').ast;
    const tampered = {
      ...ast,
      lines: [
        {
          kind: "value" as const,
          line: 1,
          raw: '{"a":"ok"}',
          value: {
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
          },
        },
      ],
    };
    expect(() => renderJsonl(tampered)).toThrow(OcEmitSentinelError);
  });
});
