import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { canonicalizeBase64, estimateBase64DecodedBytes, isValidBase64 } from "./base64.js";
import { measureBase64Memory } from "./base64.memory.test-support.js";

describe("base64 helpers", () => {
  it("canonicalizeBase64 handles attachment-sized payloads without heap blow-up", async ({
    signal,
  }) => {
    // Per-character concatenation previously used >500 MiB for this 16 MiB payload.
    const memory = await measureBase64Memory("canonical", signal);
    expect(memory.vmDelta).toBeLessThan(100 * 1024 * 1024);
  });

  it("canonicalizeBase64 handles one whitespace per character without heap blow-up", async ({
    signal,
  }) => {
    // Keep the same coarse memory budget when every data character is its own
    // whitespace-delimited run (2.7 M runs here).
    const memory = await measureBase64Memory("shredded", signal);
    expect(memory.vmDelta).toBeLessThan(64 * 1024 * 1024);
  });

  it.skipIf(!process.versions.bun)(
    "memory guards exclude predecessor allocations",
    async ({ signal }) => {
      const result = await runNodeScript(
        [fileURLToPath(new URL("./base64.memory-ownership.test-support.mjs", import.meta.url))],
        process.env,
        15_000,
        { signal, maxBuffer: 4096, executable: process.execPath },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    },
  );

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  it("base64 helpers accept the full standard alphabet", () => {
    expect(canonicalizeBase64(alphabet)).toBe(alphabet);
    expect(isValidBase64(alphabet)).toBe(true);
  });

  it.each([":", "@", "[", "`", "{", "-", "_", "é", "\ud800"])(
    "base64 helpers reject non-alphabet glyph %j",
    (glyph) => {
      expect(canonicalizeBase64("AA" + glyph + "A")).toBeUndefined();
      expect(isValidBase64("AA" + glyph + "A")).toBe(false);
    },
  );

  it.each([
    ["Q", "AQ==", "AAQ="],
    ["E", undefined, "AAE="],
    ["B", undefined, undefined],
    ["g", "Ag==", "AAg="],
    ["c", undefined, "AAc="],
    ["0", undefined, "AA0="],
    ["+", undefined, undefined],
    ["/", undefined, undefined],
  ] as const)("validates padded and unpadded terminal bits for %s", (glyph, byte, pair) => {
    expect(canonicalizeBase64(`A${glyph}==`)).toBe(byte);
    expect(canonicalizeBase64(`A${glyph}`)).toBe(byte);
    expect(canonicalizeBase64(`AA${glyph}=`)).toBe(pair);
    expect(canonicalizeBase64(`AA${glyph}`)).toBe(pair);
  });

  it.each([
    [" SGV s bG8= \n", "SGVsbG8="],
    ["S", undefined],
    ['SGVsbG8=" onerror="alert(1)', undefined],
    ["QQ==QQ==", undefined],
    ["====", undefined],
    ["data:image/png;base64,QUJD", undefined],
    [" \r\n\t", undefined],
  ] as const)("canonicalizes %j", (input, expected) => {
    expect(canonicalizeBase64(input)).toBe(expected);
  });

  it.each([
    ["SGV s bG8= \n", 5],
    ["AA==", 1],
    ["AAA=", 2],
    ["", 0],
  ] as const)("estimates decoded bytes for %j", (input, expected) => {
    expect(estimateBase64DecodedBytes(input)).toBe(expected);
  });
});

it.each<[string, boolean]>([
  ["", false],
  ["QQ==", true],
  ["QUI=", true],
  ["QUJD", true],
  ["ZE==", true], // Attachment validation historically accepts nonzero pad bits.
  ["QQ", false],
  ["QQ==\n", false],
  ["Q Q=", false],
  ["QQ$=", false],
  ["QQ-_", false],
  ["QQ=Q", false],
  ["Q===", false],
  ["====", false],
  ["QQ==QQ==", false],
])("validates attachment base64 %j without normalization", (value, accepted) => {
  expect(isValidBase64(value)).toBe(accepted);
});
