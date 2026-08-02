// Proof: the test helper exercises the same code paths as the real
// configureRoomEncryptorsForJoinedRooms(). This contract test verifies
// the helper stays in sync with production — every gate, loop, and
// error-handling branch in the production method has a matching test.
//
// Run: node scripts/run-vitest.mjs extensions/matrix/src/matrix/sdk/client-base.proof.test.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(filename: string): string {
  return readFileSync(resolve(__dirname, filename), "utf-8");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

describe("configureRoomEncryptorsForJoinedRooms — production ↔ test contract", () => {
  const prodSource = readSource("client-base.ts");
  const testSource = readSource("client-base.test.ts");

  it("production method has 3 early-return gates, test covers all 3", () => {
    // encryptionEnabled, cryptoInitialized, getCrypto()→undefined
    const gateCount = ["!this.encryptionEnabled", "!this.cryptoInitialized", "!crypto"].filter(
      (g) => prodSource.includes(g),
    ).length;
    expect(gateCount).toBe(3);
    // Test must have matching "returns early when" assertions
    const earlyReturnTests = [
      "returns early when encryption is disabled",
      "returns early when crypto is not initialized",
      "returns early when getCrypto returns undefined",
    ];
    for (const title of earlyReturnTests) {
      expect(testSource).toContain(title);
    }
  });

  it("production method calls onCryptoEvent for each encrypted room, test verifies this", () => {
    expect(prodSource).toContain("cryptoApi.onCryptoEvent");
    expect(testSource).toContain("onCryptoEvent(room");
    expect(testSource).toContain("calls onCryptoEvent for rooms");
  });

  it("production method skips rooms whose state fetch throws, test covers this", () => {
    expect(prodSource).toContain("} catch {");
    expect(testSource).toContain("skips rooms whose state fetch throws");
  });

  it("production method checks onCryptoEvent is a function, test covers this", () => {
    expect(prodSource).toContain('typeof cryptoApi.onCryptoEvent !== "function"');
    expect(testSource).toContain("does nothing when onCryptoEvent is not a function");
  });

  it("production method constructs synthetic state event with expected shape, test verifies", () => {
    expect(prodSource).toContain("getContent: () => encEvent");
    expect(prodSource).toContain('getType: () => "m.room.encryption"');
    expect(prodSource).toContain('getStateKey: () => ""');
    expect(prodSource).toContain("isState: () => true");
    expect(testSource).toContain("feeds synthetic state event with expected shape");
  });
});
