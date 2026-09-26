// OC Path tests cover jsonl resolver edges plugin behavior.
import { describe, expect, it } from "vitest";
import type { JsoncValue } from "../../jsonc/ast.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { resolveJsonlOcPath } from "../../jsonl/resolve.js";
import { parseOcPath } from "../../oc-path.js";

function rs(raw: string, ocPath: string) {
  return resolveJsonlOcPath(parseJsonl(raw).ast, parseOcPath(ocPath));
}

function expectNumberValue(node: JsoncValue, value: number) {
  expect(node.kind).toBe("number");
  if (node.kind === "number") {
    expect(node.value).toBe(value);
  }
}

function expectStringValue(node: JsoncValue, value: string) {
  expect(node.kind).toBe("string");
  if (node.kind === "string") {
    expect(node.value).toBe(value);
  }
}

describe("jsonl resolver edges", () => {
  it("$last skips trailing blank lines", () => {
    const m = rs('{"a":1}\n\n\n', "oc://log/$last/a");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expectNumberValue(m.node.value, 1);
    }
  });

  it("$last skips trailing malformed lines", () => {
    const m = rs('{"a":1}\nbroken\n', "oc://log/$last/a");
    expect(m?.kind).toBe("object-entry");
  });

  it("$last on empty file returns null", () => {
    expect(rs("", "oc://log/$last/x")).toBeNull();
  });

  it("$last on all-blank file returns null", () => {
    expect(rs("\n\n\n", "oc://log/$last/x")).toBeNull();
  });

  it("$last on all-malformed file returns null", () => {
    expect(rs("a\nb\nc\n", "oc://log/$last/x")).toBeNull();
  });

  it("descent into a malformed line returns null", () => {
    expect(rs('{"a":1}\nbroken\n{"b":2}\n', "oc://log/L2/anything")).toBeNull();
  });

  it("missing field on a value line returns null", () => {
    expect(rs('{"a":1}\n', "oc://log/L1/missing")).toBeNull();
  });

  it("array index inside a line resolves", () => {
    const m = rs('{"items":["a","b","c"]}\n', "oc://log/L1/items.2");
    expect(m?.kind).toBe("value");
    if (m?.kind === "value") {
      expectStringValue(m.node, "c");
    }
  });

  it("line numbers preserved across blank/malformed entries", () => {
    const m = rs('{"a":1}\n\nbroken\n{"a":4}\n', "oc://log/L4/a");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expectNumberValue(m.node.value, 4);
    }
  });
});
