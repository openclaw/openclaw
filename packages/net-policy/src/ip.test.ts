import { describe, expect, it } from "vitest";
import { blockedIpv6MulticastLiterals } from "./ip-test-fixtures.js";
import {
  extractEmbeddedIpv4FromIpv6,
  isBlockedSpecialUseIpv4Address,
  isBlockedSpecialUseIpv6Address,
  isCanonicalDottedDecimalIPv4,
  isCarrierGradeNatIpv4Address,
  isCloudMetadataIpAddress,
  isIpInCidr,
  isIpv4Address,
  isIpv6Address,
  isLegacyIpv4Literal,
  isLinkLocalIpAddress,
  isLoopbackIpAddress,
  isPrivateOrLoopbackIpAddress,
  isRfc8215LocalUseNat64Ipv6Address,
  isRfc1918Ipv4Address,
  isUnspecifiedIpAddress,
  normalizeIpAddress,
  parseCanonicalIpAddress,
  parseLooseIpAddress,
} from "./ip.js";

function ipv6(literal: string) {
  const parsed = parseCanonicalIpAddress(literal);
  if (!parsed || !isIpv6Address(parsed)) {
    throw new Error(`expected IPv6 fixture: ${literal}`);
  }
  return parsed;
}

describe("shared ip helpers", () => {
  it("distinguishes canonical dotted IPv4 from legacy forms", () => {
    expect(isCanonicalDottedDecimalIPv4("127.0.0.1")).toBe(true);
    expect(isCanonicalDottedDecimalIPv4("0177.0.0.1")).toBe(false);
    expect(isLegacyIpv4Literal("0177.0.0.1")).toBe(true);
    expect(isLegacyIpv4Literal("127.1")).toBe(true);
    expect(isLegacyIpv4Literal("example.com")).toBe(false);
  });

  it.each([
    ["10.43.0.59", "10.42.0.0/24", false],
    ["2001:db8::1234", "2001:db8::/32", true],
    ["2001:db9::1234", "2001:db8::/32", false],
    ["::ffff:127.0.0.1", "127.0.0.1", true],
    ["127.0.0.1", "::ffff:127.0.0.2", false],
    ["127.0.0.1", "127.1/8", true],
    ["127.0.0.1", "127.1", false],
    ["10.42.0.59", " 10.42.0.0/24 ", true],
    ["10.42.0.59", "10.42.0.0/33", false],
    ["2001:db8::1", "2001:db8::/129", false],
    ["10.42.0.59", "", false],
    ["junk", "10.42.0.0/24", false],
    ["10.42.0.59", "2001:db8::/32", false],
    ["fe80::1%eth0", "fe80::1%eth1", false],
    ["fe80::1%eth0", "fe80::1%eth0", true],
    ["fe80::1%eth0", "fe80::1%eth1/128", true],
    ["::ffff:127.0.0.1", "::ffff:127.0.0.1/128", true],
    ["10.1.2.3", "::ffff:10.0.0.0/104", true],
    ["::ffff:10.1.2.3", "::ffff:10.0.0.0/104", true],
    ["11.1.2.3", "::ffff:10.0.0.0/104", false],
    ["10.0.0.1", "::ffff:10.0.0.0/128", false],
    ["203.0.113.9", "::ffff:0:0/96", true],
    ["203.0.113.9", "::ffff:10.0.0.0/64", true],
    ["2001:db8::1", "::ffff:0:0/96", false],
  ])("matches %s against %s: %s", (ip, range, expected) => {
    expect(isIpInCidr(ip, range)).toBe(expected);
  });

  it("extracts embedded IPv4 for transition prefixes", () => {
    const cases = [
      ["::ffff:127.0.0.1", "127.0.0.1"],
      ["::127.0.0.1", "127.0.0.1"],
      ["64:ff9b::8.8.8.8", "8.8.8.8"],
      ["2002:0808:0808::", "8.8.8.8"],
      ["2001::f7f7:f7f7", "8.8.8.8"],
      ["2001:4860:1::5efe:7f00:1", "127.0.0.1"],
    ] as const;
    for (const [ipv6Literal, expectedIpv4] of cases) {
      expect(extractEmbeddedIpv4FromIpv6(ipv6(ipv6Literal))?.toString(), ipv6Literal).toBe(
        expectedIpv4,
      );
    }
  });

  it("does not guess embedded IPv4 for local-use NAT64 literals", () => {
    const cases = [
      "64:ff9b:1:a00:0:100::",
      "64:ff9b:1:a9fe:a9:fe00:808:808",
      "64:ff9b:1:7f00:0:100:808:808",
      "64:ff9b:1:808:808:808:a9fe:a9fe",
      "64:ff9b:1::8.8.8.8",
    ] as const;
    for (const ipv6Literal of cases) {
      expect(extractEmbeddedIpv4FromIpv6(ipv6(ipv6Literal)), ipv6Literal).toBeUndefined();
    }
  });

  it("detects RFC8215 local-use NAT64 literals", () => {
    expect(isRfc8215LocalUseNat64Ipv6Address("64:ff9b:1::8.8.8.8")).toBe(true);
    expect(isRfc8215LocalUseNat64Ipv6Address("[64:ff9b:1:808:808:808:a9fe:a9fe]")).toBe(true);
    expect(isRfc8215LocalUseNat64Ipv6Address("64:ff9b::8.8.8.8")).toBe(false);
    expect(isRfc8215LocalUseNat64Ipv6Address("model.lan")).toBe(false);
  });

  it("treats blocked IPv6 classes as private/internal", () => {
    expect(isPrivateOrLoopbackIpAddress("fec0::1")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("2001:db8::1")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("2001:2::1")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("100::1")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("2001:20::1")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("64:ff9b:1:7f00:0:100:808:808")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("64:ff9b:1:a9fe:a9:fe00:808:808")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("64:ff9b:1:808:808:808:808:808")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("64:ff9b:1:808:808:808:a9fe:a9fe")).toBe(true);
    for (const literal of blockedIpv6MulticastLiterals) {
      expect(isPrivateOrLoopbackIpAddress(literal)).toBe(true);
    }
    expect(isPrivateOrLoopbackIpAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("normalizes canonical IP strings and loopback detection", () => {
    expect(normalizeIpAddress("[::FFFF:127.0.0.1]")).toBe("127.0.0.1");
    expect(normalizeIpAddress("  [2001:DB8::1]  ")).toBe("2001:db8::1");
    expect(isLoopbackIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackIpAddress("198.18.0.1")).toBe(false);
  });

  it("detects link-local addresses without treating normal private ranges as link-local", () => {
    expect(isLinkLocalIpAddress("169.254.169.254")).toBe(true);
    expect(isLinkLocalIpAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isLinkLocalIpAddress("2852039166")).toBe(true);
    expect(isLinkLocalIpAddress("0xa9fea9fe")).toBe(true);
    expect(isLinkLocalIpAddress("0xa9.0xfe.0xa9.0xfe")).toBe(true);
    expect(isLinkLocalIpAddress("64:ff9b::169.254.169.254")).toBe(true);
    expect(isLinkLocalIpAddress("2002:a9fe:a9fe::")).toBe(true);
    expect(isLinkLocalIpAddress("fe80::1%lo0")).toBe(true);
    expect(isLinkLocalIpAddress("[fe80::1]")).toBe(true);
    expect(isLinkLocalIpAddress("10.0.0.5")).toBe(false);
    expect(isLinkLocalIpAddress("127.0.0.1")).toBe(false);
    expect(isLinkLocalIpAddress("fd00::1")).toBe(false);
  });

  it.each([
    ["[::ffff:0.0.0.0]", "[::ffff:0:0]"],
    ["[64:ff9b::0.0.0.0]", "[64:ff9b::]"],
  ])("detects unspecified addresses before and after URL canonicalization", (raw, canonical) => {
    expect(new URL(`http://${raw}`).hostname).toBe(canonical);
    expect(isUnspecifiedIpAddress(raw)).toBe(true);
    expect(isUnspecifiedIpAddress(canonical)).toBe(true);
  });

  it("does not classify private or loopback addresses as unspecified", () => {
    expect(isUnspecifiedIpAddress("10.0.0.8")).toBe(false);
    expect(isUnspecifiedIpAddress("[fd00::8]")).toBe(false);
    expect(isUnspecifiedIpAddress("[::1]")).toBe(false);
  });

  it("detects known non-link-local cloud metadata IPs", () => {
    expect(isCloudMetadataIpAddress("100.100.100.200")).toBe(true);
    expect(isCloudMetadataIpAddress("::ffff:100.100.100.200")).toBe(true);
    expect(isCloudMetadataIpAddress("64:ff9b::100.100.100.200")).toBe(true);
    expect(isCloudMetadataIpAddress("2002:6464:64c8::")).toBe(true);
    expect(isCloudMetadataIpAddress("1684301000")).toBe(true);
    expect(isCloudMetadataIpAddress("fd00:ec2::254")).toBe(true);
    expect(isCloudMetadataIpAddress("[fd00:ec2::254]")).toBe(true);
    expect(isCloudMetadataIpAddress("100.100.100.201")).toBe(false);
    expect(isCloudMetadataIpAddress("169.254.169.254")).toBe(false);
    expect(isCloudMetadataIpAddress("fd00::1")).toBe(false);
  });

  it("parses loose legacy IPv4 literals that canonical parsing rejects", () => {
    expect(parseCanonicalIpAddress("0177.0.0.1")).toBeUndefined();
    expect(parseLooseIpAddress("0177.0.0.1")?.toString()).toBe("127.0.0.1");
    expect(parseLooseIpAddress("[::1]")?.toString()).toBe("::1");
  });

  it("classifies RFC1918 and carrier-grade-nat IPv4 ranges", () => {
    expect(isRfc1918Ipv4Address("10.42.0.59")).toBe(true);
    expect(isRfc1918Ipv4Address("100.64.0.1")).toBe(false);
    expect(isCarrierGradeNatIpv4Address("100.64.0.1")).toBe(true);
    expect(isCarrierGradeNatIpv4Address("10.42.0.59")).toBe(false);
  });

  it("blocks special-use IPv4 ranges while allowing optional RFC2544 benchmark addresses", () => {
    const loopback = parseCanonicalIpAddress("127.0.0.1");
    const benchmark = parseCanonicalIpAddress("198.18.0.1");

    expect(loopback?.kind()).toBe("ipv4");
    expect(benchmark?.kind()).toBe("ipv4");
    if (!loopback || !isIpv4Address(loopback) || !benchmark || !isIpv4Address(benchmark)) {
      throw new Error("expected ipv4 fixtures");
    }

    expect(isBlockedSpecialUseIpv4Address(loopback)).toBe(true);
    expect(isBlockedSpecialUseIpv4Address(benchmark)).toBe(true);
    expect(isBlockedSpecialUseIpv4Address(benchmark, { allowRfc2544BenchmarkRange: true })).toBe(
      false,
    );
  });

  it("blocks IPv6 unique-local addresses by default and exempts them on opt-in (#74351)", () => {
    const ula = ipv6("fc00::1");
    const metadata = ipv6("fd00:ec2::254");

    expect(isBlockedSpecialUseIpv6Address(ula)).toBe(true);
    expect(isBlockedSpecialUseIpv6Address(ula, { allowUniqueLocalRange: false })).toBe(true);

    expect(isBlockedSpecialUseIpv6Address(ula, { allowUniqueLocalRange: true })).toBe(false);
    expect(isBlockedSpecialUseIpv6Address(metadata, { allowUniqueLocalRange: true })).toBe(true);
  });

  it("opt-in unique-local exemption does NOT bleed into other special-use IPv6 ranges (#74351)", () => {
    const loopback = ipv6("::1");
    const multicast = ipv6("ff02::1");
    const siteLocal = ipv6("fec0::1");
    const localUseNat64 = ipv6("64:ff9b:1:808:808:808:a9fe:a9fe");

    for (const options of [{}, { allowUniqueLocalRange: true }] as const) {
      expect(isBlockedSpecialUseIpv6Address(loopback, options)).toBe(true);
      expect(isBlockedSpecialUseIpv6Address(multicast, options)).toBe(true);
      expect(isBlockedSpecialUseIpv6Address(siteLocal, options)).toBe(true);
      expect(isBlockedSpecialUseIpv6Address(localUseNat64, options)).toBe(true);
    }
  });
});
