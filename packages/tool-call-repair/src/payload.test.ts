// Tool Call Repair tests cover payload parsing behavior.
import { describe, expect, it } from "vitest";
import { parseStandalonePlainTextToolCallBlocks } from "./payload.js";

describe("parseStandalonePlainTextToolCallBlocks", () => {
  const multiByteValue = "\u4f60\ud83d\ude42";

  it("enforces JSON maxPayloadBytes as UTF-8 bytes", () => {
    const payload = JSON.stringify({ text: multiByteValue });
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(payload.length);

    expect(
      parseStandalonePlainTextToolCallBlocks(`[search]\n${payload}[/search]`, {
        maxPayloadBytes: payload.length,
      }),
    ).toBeNull();

    expect(
      parseStandalonePlainTextToolCallBlocks(`[search]\n${payload}[/search]`, {
        maxPayloadBytes: Buffer.byteLength(payload, "utf8"),
      })?.[0]?.arguments,
    ).toEqual({ text: multiByteValue });
  });

  it("enforces XML-ish maxPayloadBytes as UTF-8 bytes", () => {
    const parameter = `<parameter=query>${multiByteValue}</parameter>`;
    const text = `<function=search>${parameter}</function>`;
    expect(Buffer.byteLength(parameter, "utf8")).toBeGreaterThan(parameter.length);

    expect(
      parseStandalonePlainTextToolCallBlocks(text, {
        maxPayloadBytes: parameter.length,
      }),
    ).toBeNull();

    expect(
      parseStandalonePlainTextToolCallBlocks(text, {
        maxPayloadBytes: Buffer.byteLength(parameter, "utf8"),
      })?.[0]?.arguments,
    ).toEqual({ query: multiByteValue });
  });
});
