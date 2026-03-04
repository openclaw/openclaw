import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonConfigStore } from "../../src/core/config-store.js";

describe("JsonConfigStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `config-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("should return defaults when file does not exist", () => {
    const store = new JsonConfigStore(join(dir, "cfg.json"), { a: 1, b: "hello" });
    expect(store.get()).toEqual({ a: 1, b: "hello" });
  });

  it("should load existing values from disk", () => {
    const filePath = join(dir, "cfg.json");
    writeFileSync(filePath, JSON.stringify({ a: 42, b: "world" }), "utf-8");

    const store = new JsonConfigStore(filePath, { a: 1, b: "hello" });
    expect(store.get()).toEqual({ a: 42, b: "world" });
  });

  it("should merge update and persist", () => {
    const filePath = join(dir, "cfg.json");
    const store = new JsonConfigStore(filePath, { x: 10, y: 20 });

    store.update({ x: 99 });
    expect(store.get()).toEqual({ x: 99, y: 20 });

    // Re-open from disk
    const store2 = new JsonConfigStore(filePath, { x: 10, y: 20 });
    expect(store2.get()).toEqual({ x: 99, y: 20 });
  });

  it("should fall back to defaults on corrupt JSON", () => {
    const filePath = join(dir, "cfg.json");
    writeFileSync(filePath, "NOT VALID JSON {{{", "utf-8");

    const store = new JsonConfigStore(filePath, { key: "default" });
    expect(store.get()).toEqual({ key: "default" });
  });

  it("should return a copy, not the internal reference", () => {
    const store = new JsonConfigStore(join(dir, "cfg.json"), { val: 5 });
    const copy = store.get();
    copy.val = 999;
    expect(store.get().val).toBe(5);
  });

  it("should merge defaults with saved data (new keys on upgrade)", () => {
    const filePath = join(dir, "cfg.json");
    writeFileSync(filePath, JSON.stringify({ a: 42 }), "utf-8");

    const store = new JsonConfigStore(filePath, { a: 1, b: "new_default" });
    expect(store.get()).toEqual({ a: 42, b: "new_default" });
  });
});
