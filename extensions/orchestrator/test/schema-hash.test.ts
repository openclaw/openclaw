import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SCHEMA_HASH, normalizeSchemaSource } from "../src/types/schema.contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, "..", "src", "types", "schema.ts");

function computeHash(): string {
  const src = readFileSync(SCHEMA_PATH, "utf8");
  return createHash("sha256").update(normalizeSchemaSource(src)).digest("hex");
}

describe("schema hash contract", () => {
  test("pinned SCHEMA_HASH matches the canonical schema source", () => {
    const actual = computeHash();
    expect(actual).toBe(SCHEMA_HASH);
  });

  test("normalizer strips both line and block comments", () => {
    const stripped = normalizeSchemaSource(
      "export type X = 'a' | 'b'; // tail line comment\n/* leading block */ export type Y = number;",
    );
    expect(stripped).toBe("export type X = 'a' | 'b'; export type Y = number;");
  });

  test("normalizer collapses repeated whitespace to single spaces", () => {
    expect(normalizeSchemaSource("a   b\n\nc\t  d")).toBe("a b c d");
  });
});
