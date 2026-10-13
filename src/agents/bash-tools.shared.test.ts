import { afterEach, expect, it, vi } from "vitest";
import { chunkString, deriveSessionName, readEnvInt } from "./bash-tools.shared.js";

afterEach(() => vi.unstubAllEnvs());

it("uses the legacy integer only when the preferred environment value is absent", () => {
  vi.stubEnv("PI_BASH_YIELD_MS", "250");
  expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBe(250);
  vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "500");
  expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBe(500);
});

it("keeps quoted command labels grouped with literal single-quoted backslashes", () => {
  expect(deriveSessionName('tar "a\\b c"')).toBe("tar a\\b c");
  expect(deriveSessionName("cmd 'a b\\' next")).toBe("cmd a b\\");
});

it("bounds name derivation on unterminated quoted backslash runs", () => {
  for (const quote of [`"`, "'"]) {
    const malicious = `node ${quote}${"\\".repeat(50_000)}`;
    const start = process.hrtime.bigint();
    const label = deriveSessionName(malicious);
    expect(typeof label).toBe("string");
    expect(Number(process.hrtime.bigint() - start) / 1e6).toBeLessThan(100);
  }
});

it("keeps surrogate pairs together at chunk boundaries", () => {
  expect(chunkString("a".repeat(8_191) + "🚀b", 8_192)).toEqual(["a".repeat(8_191), "🚀b"]);
});

it("emits an indivisible code point even when the chunk limit is one UTF-16 unit", () => {
  expect(chunkString("😀a", 1)).toEqual(["😀", "a"]);
});
