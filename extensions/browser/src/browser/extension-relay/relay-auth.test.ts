// Extension relay token derivation.
import { describe, expect, it } from "vitest";
import {
  deriveExtensionRelayToken,
  extensionRelayTokenMatches,
  resolveExtensionRelayToken,
} from "./relay-auth.js";

describe("extension relay auth", () => {
  it("derives a stable token from gateway auth material", () => {
    const a = deriveExtensionRelayToken("secret-token");
    const b = deriveExtensionRelayToken("secret-token");
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // sha256 hex
    expect(a).not.toBe("secret-token");
  });

  it("produces distinct tokens for distinct material", () => {
    expect(deriveExtensionRelayToken("one")).not.toBe(deriveExtensionRelayToken("two"));
  });

  it("matches tokens in constant time and rejects mismatches", () => {
    const token = deriveExtensionRelayToken("material");
    expect(extensionRelayTokenMatches(token, token)).toBe(true);
    expect(extensionRelayTokenMatches(token, `${token}x`)).toBe(false);
    expect(extensionRelayTokenMatches(token, "short")).toBe(false);
  });

  it("resolves from token auth config and returns null without material", () => {
    const withToken = resolveExtensionRelayToken(
      { gateway: { auth: { mode: "token", token: "gw-token" } } },
      {},
    );
    expect(withToken).toBe(deriveExtensionRelayToken("gw-token"));

    const withoutAuth = resolveExtensionRelayToken({ gateway: { auth: { mode: "none" } } }, {});
    expect(withoutAuth).toBeNull();
  });
});
