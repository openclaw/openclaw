// OC Path tests cover jsonl resolver edges plugin behavior.
import { describe, expect, it } from "vitest";
import type { JsoncValue } from "../../jsonc/ast.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { resolveJsonlOcPath } from "../../jsonl/resolve.js";
import { parseOcPath } from "../../oc-path.js";

function rs(raw: string, ocPath: string) {
  return resolveJsonlOcPath(parseJsonl(raw), parseOcPath(ocPath));
}

function expectNumberValue(node: JsoncValue, value: number) {
  expect(node.kind).toBe("number");
  if (node.kind === "number") {
    expect(node.value).toBe(value);
  }
}

describe("jsonl resolver edges", () => {
  it("$last skips trailing malformed lines", () => {
    const m = rs('{"a":1}\nbroken\n', "oc://log/$last/a");
    expect(m?.kind).toBe("object-entry");
  });

  it("$last on empty file returns null", () => {
    expect(rs("", "oc://log/$last/x")).toBeNull();
  });

  it("descent into a malformed line returns null", () => {
    expect(rs('{"a":1}\nbroken\n{"b":2}\n', "oc://log/L2/anything")).toBeNull();
  });

  it("missing field on a value line returns null", () => {
    expect(rs('{"a":1}\n', "oc://log/L1/missing")).toBeNull();
  });

  it("line numbers preserved across blank/malformed entries", () => {
    const m = rs('{"a":1}\n\nbroken\n{"a":4}\n', "oc://log/L4/a");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expectNumberValue(m.node.value, 4);
    }
  });
});
