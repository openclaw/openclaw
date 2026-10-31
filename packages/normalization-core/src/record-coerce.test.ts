import { describe, expect, it } from "vitest";
import {
  asNonArrayRecord,
  asNullableRecord,
  asOptionalRecord,
  ensureRecord,
  filterStringRecord,
  isStringArray,
  isStringRecord,
  omitUndefinedFields,
} from "./record-coerce.js";

describe("record-coerce", () => {
  const sparse: string[] = [];
  sparse.length = 2;
  it.each([
    [[], true],
    [["", "  ", " padded ", "same", "same"], true],
    [sparse, true],
    [["ok", 1], false],
    [["ok", undefined], false],
    [null, false],
    [{ 0: "ok", length: 1 }, false],
    ["ok", false],
  ])("accepts only all-string arrays without normalizing entries %#", (value, expected) => {
    expect(isStringArray(value)).toBe(expected);
  });

  it("retains existing records without assigning to their parent", () => {
    const record = { value: 1 };
    expect(ensureRecord(Object.freeze({ nested: record }), "nested")).toBe(record);
    const instance = new Date(0);
    expect(ensureRecord({ nested: instance }, "nested")).toBe(instance);
    expect(ensureRecord({}, "__proto__")).toBe(Object.prototype);
  });

  it.each([undefined, null, [], 1, "value"])("replaces non-record values: %j", (value) => {
    const root = { nested: value };
    const record = ensureRecord(root, "nested");
    expect(record).toEqual({});
    expect(root.nested).toBe(record);
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(ensureRecord({}, "nested")).not.toBe(record);
  });

  it("removes only undefined projection fields in place without traversing nested records", () => {
    const nested = { untouched: undefined };
    const fields = { missing: undefined, empty: "", zero: 0, disabled: false, nil: null, nested };
    expect(omitUndefinedFields(fields)).toBe(fields);
    expect(fields).toStrictEqual({
      empty: "",
      zero: 0,
      disabled: false,
      nil: null,
      nested: { untouched: undefined },
    });
    expect(fields.nested).toBe(nested);
  });

  it("preserves accepted record identity and returns fresh ordinary fallbacks", () => {
    const firstFallback = asNonArrayRecord(null);
    const secondFallback = asNonArrayRecord([]);
    for (const value of [Object.create(null), new Date(), Object.create({ marker: true })]) {
      expect(asNonArrayRecord(value)).toBe(value);
    }
    expect(firstFallback).toEqual({});
    expect(Object.getPrototypeOf(firstFallback)).toBe(Object.prototype);
    expect(secondFallback).toEqual({});
    expect(secondFallback).not.toBe(firstFallback);
  });

  it("preserves the canonical proxy trap behavior", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => asNonArrayRecord(proxy)).toThrow(TypeError);
    expect(() => isStringRecord(proxy)).toThrow(TypeError);
  });

  it.each([
    [{ first: "one", second: "two" }, true, true],
    [Object.assign(Object.create(null), { first: "one" }), true, true],
    [new Date(), true, true],
    [{ first: "one", second: 2 }, true, false],
    [["one"], false, false],
    [null, false, false],
  ])("coerces records and validates their string values %#", (value, record, strings) => {
    expect(asOptionalRecord(value)).toBe(record ? value : undefined);
    expect(asNullableRecord(value)).toBe(record ? value : null);
    expect(isStringRecord(value)).toBe(strings);
  });

  const inheritedAndHidden = Object.create({ inherited: "skip" }) as Record<string, unknown>;
  Object.defineProperty(inheritedAndHidden, "hidden", { value: "skip", enumerable: false });
  Object.assign(inheritedAndHidden, {
    blank: "",
    ignored: 1,
    whitespace: "  ",
    first: "same",
    second: "same",
  });

  it.each([
    [null, undefined],
    [["value"], undefined],
    [{ count: 1, enabled: true }, undefined],
    [inheritedAndHidden, { blank: "", whitespace: "  ", first: "same", second: "same" }],
  ])("filters string-valued record entries from %j", (value, expected) => {
    const result = filterStringRecord(value);
    expect(result).toEqual(expected);
    expect(result ? Object.keys(result) : undefined).toEqual(
      expected ? Object.keys(expected) : undefined,
    );
  });
});
