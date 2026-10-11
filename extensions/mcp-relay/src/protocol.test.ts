import { describe, expect, it } from "vitest";
import {
  codeHash,
  identityFromPrivateKey,
  normalizePairingCode,
  truncateText,
} from "./protocol.js";

// Frozen cross-repository vectors, with the RFC 8410 PKCS#8 prefix around the seed.
const PRIVATE_KEY = Buffer.from(
  "302e020100300506032b657004220420" +
    "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  "hex",
).toString("base64url");

describe("MCP relay frozen protocol vectors", () => {
  it("derives the raw public key, Gateway ID, and domain-bound Ed25519 signature", () => {
    const identity = identityFromPrivateKey(PRIVATE_KEY);
    expect(identity.publicKey).toBe("ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ");
    expect(identity.gatewayId).toBe("gw_ZbYGc9btiEvwHCwiLYKtoH");
    expect(
      identity.signChallenge("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc", "mcp.openclaw.ai"),
    ).toBe(
      "wZaNEXDNbmhncHDPb_N5xVWk2IJD78-z-jg0_zvwiSspB7jo63XSwGuj7cHFx2evxQ8kII2r6dRIFeNlcqISAQ",
    );
  });

  it.each([
    ["ABCDE-FGHJK", "ABCDEFGHJK"],
    ["abcde-fghjk ", "ABCDEFGHJK"],
    ["OIL00-11111", "0110011111"],
  ])("normalizes %j to the shared Crockford code %s", (input, expected) => {
    expect(normalizePairingCode(input)).toBe(expected);
  });

  it("hashes normalized pairing codes with the pairing domain separator", () => {
    expect(codeHash("ABCDE-FGHJK")).toBe("wO-MJVJ_Q4yi9dCUnbnvhGFaPWsCBKvgRKT4XHP083U");
    expect(codeHash("abcde-fghjk ")).toBe("wO-MJVJ_Q4yi9dCUnbnvhGFaPWsCBKvgRKT4XHP083U");
  });

  it("keeps complete surrogate pairs within the 16,000-character text budget", () => {
    const splitBoundary = `${"a".repeat(15_998)}😀extra`;
    expect(truncateText(splitBoundary)).toBe(`${"a".repeat(15_998)}…`);
    const fittingPair = `${"a".repeat(15_997)}😀extra`;
    expect(truncateText(fittingPair)).toBe(`${"a".repeat(15_997)}😀…`);
    const exactBudget = `${"a".repeat(15_998)}😀`;
    expect(truncateText(exactBudget)).toBe(exactBudget);
  });
});
