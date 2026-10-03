import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { canonicalizeBase64, estimateBase64DecodedBytes, isValidBase64 } from "./base64.js";
import { measureBase64Memory } from "./base64.memory.test-support.js";

it("bounds base64 memory use for contiguous and whitespace-separated payloads", async ({
  signal,
}) => {
  for (const [kind, mib] of [
    ["canonical", 100],
    ["shredded", 64],
  ] as const) {
    const memory = await measureBase64Memory(kind, signal);
    expect(memory.vmDelta, kind).toBeLessThan(mib * 1024 * 1024);
  }
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

it("validates canonical and attachment base64 dialects", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const cases: [string, string | undefined, boolean][] = [
    [alphabet, alphabet, true],
    [" SGV s bG8= \n", "SGVsbG8=", false],
    ["QQ==", "QQ==", true],
    ["QUI=", "QUI=", true],
    ["QUJD", "QUJD", true],
    ["ZE==", undefined, true], // Attachments permit nonzero pad bits.
    ["QQ", "QQ==", false],
    ["QQ==\n", "QQ==", false],
    ["Q Q=", undefined, false],
    ["QQ$=", undefined, false],
    ["QQ-_", undefined, false],
    ["QQ=Q", undefined, false],
    ["Q===", undefined, false],
    ["====", undefined, false],
    ["QQ==QQ==", undefined, false],
    ["", undefined, false],
    ["S", undefined, false],
    ['SGVsbG8=" onerror="alert(1)', undefined, false],
    ["data:image/png;base64,QUJD", undefined, false],
    [" \r\n\t", undefined, false],
  ];
  for (const [input, canonical, accepted] of cases) {
    expect(canonicalizeBase64(input), input).toBe(canonical);
    expect(isValidBase64(input), input).toBe(accepted);
  }
});

it("validates padded and unpadded terminal bits", () => {
  for (const [glyph, byte, pair] of [
    ["Q", "AQ==", "AAQ="],
    ["E", undefined, "AAE="],
    ["B", undefined, undefined],
  ] as const) {
    expect(canonicalizeBase64(`A${glyph}==`)).toBe(byte);
    expect(canonicalizeBase64(`A${glyph}`)).toBe(byte);
    expect(canonicalizeBase64(`AA${glyph}=`)).toBe(pair);
    expect(canonicalizeBase64(`AA${glyph}`)).toBe(pair);
  }
});

it.each([
  ["SGV s bG8= \n", 5],
  ["", 0],
] as const)("estimates decoded bytes for %j", (input, expected) => {
  expect(estimateBase64DecodedBytes(input)).toBe(expected);
});
