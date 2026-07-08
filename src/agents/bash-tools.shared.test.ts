/**
 * Shared bash-tool helper tests.
 * Covers strict env parsing and compact session labels.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkString, deriveSessionName, readEnvInt } from "./bash-tools.shared.js";

describe("readEnvInt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads deprecated PI env integer aliases behind OPENCLAW env names", () => {
    vi.stubEnv("PI_BASH_YIELD_MS", "250");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBe(250);

    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "500");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBe(500);
  });

  it("ignores partial environment integers", () => {
    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "250ms");
    vi.stubEnv("PI_BASH_YIELD_MS", "500");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();
  });

  it("reads only strict signed decimal environment integers", () => {
    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "+250");
    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBe(250);

    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "0x10");
    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();

    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "1e2");
    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();
  });

  it("ignores unsafe environment integers", () => {
    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "9007199254740993");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();
  });
});

describe("deriveSessionName", () => {
  it("labels well-formed quoted commands", () => {
    expect(deriveSessionName('node "my server.js" --port 8080')).toBe("node my server.js");
    expect(deriveSessionName("git commit -m 'fix bug'")).toBe("git commit");
  });

  it("keeps grouping backslash-bearing quoted spans into one token", () => {
    expect(deriveSessionName('tar "a\\b c"')).toBe("tar a\\b c");
  });

  it("treats backslash as literal inside single-quoted spans", () => {
    expect(deriveSessionName("cmd 'a b\\' next")).toBe("cmd a b\\");
  });

  it("returns a label without catastrophic backtracking on unterminated quoted backslash runs", () => {
    for (const quote of [`"`, `'`]) {
      const malicious = `node ${quote}${"\\".repeat(50000)}`;
      const start = process.hrtime.bigint();
      const label = deriveSessionName(malicious);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      expect(typeof label).toBe("string");
      expect(elapsedMs).toBeLessThan(100);
    }
  });
});

describe("chunkString", () => {
  it("preserves surrogate pairs at chunk boundaries", () => {
    // 8191 'a' + emoji + "b" = 8194 code units. With chunk limit 8192,
    // raw slice(0, 8192) would cut between the emoji's high surrogate at
    // index 8191 and low surrogate at index 8192 → lone surrogate in chunk 1.
    // sliceUtf16Safe backs out the boundary → both surrogates stay together.
    const input = "a".repeat(8191) + "🚀b";
    const chunks = chunkString(input, 8192);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      const rt = new TextDecoder().decode(new TextEncoder().encode(chunk));
      expect(rt).not.toContain("�");
    }
    // The emoji must not be lost across chunks.
    const rejoined = chunks.join("");
    expect(rejoined).toBe(input);
  });

  it("returns single chunk for input smaller than limit", () => {
    const chunks = chunkString("hello", 8192);
    expect(chunks).toEqual(["hello"]);
  });

  it("splits cleanly when chunk boundary aligns with surrogate pair", () => {
    // 2 'a' + emoji + 2 'b' = 6 code units. chunk limit 2 splits at
    // index 2 (inside the emoji). sliceUtf16Safe backs out to index 2
    // at chunk end and advances to index 3 at chunk start → both halves
    // preserved, data not lost.
    const input = "aa🚀bb";
    const chunks = chunkString(input, 2);
    const rejoined = chunks.join("");
    expect(rejoined).toBe(input);
    for (const chunk of chunks) {
      const rt = new TextDecoder().decode(new TextEncoder().encode(chunk));
      expect(rt).not.toContain("�");
    }
  });
});
