import { describe, it, expect } from "vitest";
import { TaintRegistry } from "./taint-registry.js";

describe("TaintRegistry", () => {
  it("marks a value as tainted", () => {
    const registry = new TaintRegistry();
    const data = { value: "test" };

    registry.taint(data, "test-source");

    expect(registry.isTainted(data)).toBe(true);
  });

  it("isTainted returns true for tainted data", () => {
    const registry = new TaintRegistry();
    const data = { value: "test" };

    registry.taint(data, "user-input");

    expect(registry.isTainted(data)).toBe(true);
    expect(registry.isTainted({ other: "data" })).toBe(false);
  });

  it("hasTaintedValue finds tainted nested objects", () => {
    const registry = new TaintRegistry();
    const taintedObj = { secret: "key" };
    const container = {
      name: "test",
      nested: taintedObj,
    };

    registry.taint(taintedObj, "external-source");

    expect(registry.hasTaintedValue(container)).toBe(true);
  });

  it("hasTaintedValue finds tainted array items", () => {
    const registry = new TaintRegistry();
    const taintedItem = { id: 123 };
    const array = [{ name: "safe" }, taintedItem, { name: "also-safe" }];

    registry.taint(taintedItem, "api-response");

    expect(registry.hasTaintedValue(array)).toBe(true);
  });
});
