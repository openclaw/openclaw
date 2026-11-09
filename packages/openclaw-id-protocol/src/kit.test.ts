import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "./bytes.js";
import { decodeKit, encodeKit, generateKitSecret } from "./kit.js";

describe("recovery kit encoding", () => {
  it("round-trips S and tolerates case, spacing and O/I/L typos", async () => {
    const secret = generateKitSecret();
    const text = await encodeKit(secret);
    expect(text).toMatch(/^OCK1(-[0-9A-HJKMNP-TV-Z]{1,5}){7}$/);
    expect(bytesToHex(await decodeKit(text.toLowerCase().replaceAll("-", " ")))).toBe(
      bytesToHex(secret),
    );
    const zeros = await encodeKit(new Uint8Array(16));
    expect(bytesToHex(await decodeKit(zeros.replaceAll("0", "O")))).toBe("00".repeat(16));
  });

  it("rejects a mistyped kit through the checksum", async () => {
    const text = await encodeKit(hexToBytes("000102030405060708090a0b0c0d0e0f"));
    const last = text.at(-3) === "0" ? "1" : "0";
    const typo = `${text.slice(0, -3)}${last}${text.slice(-2)}`;
    await expect(decodeKit(typo)).rejects.toThrow(/checksum/);
  });
});
